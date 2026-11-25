import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { RuntimeContext } from '../ports/agent.ts';
import type { PrivateObjectStore } from '../ports/object-storage.ts';
import type { MemoryUpdate } from '../shared/memory.ts';
import { memoryFileName, memoryMarkdown } from '../shared/memory-export.ts';
import type { AgentScope } from './agents.ts';
import type { CaptureAnalytics, MemoryChange } from './analytics.ts';
import type { ApprovalDescription, ApprovalPresentation } from './approvals.ts';
import { messageChatSql, turnChat } from './chat-scope.ts';
import { createMemoryService, type MemoryService } from './memory.ts';
import { applyOps, type Rejection } from './memory-ops.ts';
import {
  areaEntries,
  fits,
  freeSlug,
  indexLayout,
  locate,
  path,
  same,
  type Tree,
} from './memory-tree.ts';

export interface RoutedDocument {
  name: string;
  memory: MemoryService;
  readsShared: boolean;
}

export interface ReflectedDocument {
  memory: MemoryService;
  filter: string;
  params: unknown[];
  agent: RoutedDocument;
}

type Document = { memory: MemoryService; tree: Tree };
type Scope = 'agent' | 'shared';

const scopeInput = z.enum(['agent', 'shared']).optional();
const agentNote = z.object({ about: z.literal('agent') });
const inChats = (agents: string) =>
  `EXISTS (SELECT 1 FROM agent_chats c JOIN agents a ON a.id=c.agent_id AND a.owner_id=c.owner_id
    WHERE c.owner_id=m.owner_id AND c.chat_id=${messageChatSql('m')} AND ${agents})`;
export const sharedReflection = `AND NOT ${inChats("a.memory_mode<>'shared'")}`;
const agentFilter = `AND ${inChats('a.id=$4')}`;

function failure(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode });
}

export function routeMemory(shared: Document, own: Document, agent: RoutedDocument) {
  const now = () => new Date().toISOString();
  const split = (ops: unknown[]) => {
    const routed = { shared: [] as unknown[], own: [] as unknown[] };
    for (const op of ops) routed[agentNote.safeParse(op).success ? 'own' : 'shared'].push(op);
    return routed;
  };
  return {
    sensitive: shared.tree.sensitive,
    instructions: ` This chat belongs to the owner's agent ${JSON.stringify(agent.name)}, which keeps its own memory. Give every op "about": "owner" when its note is about the user: who they are, their preferences, their life or facts about them; or "about": "agent" when it is a detail of this agent's own work, such as its tasks, projects, sources or progress. When unsure, use "owner". memory is the shared index, for "owner" notes, and agentMemory is this agent's index, for "agent" notes; an archive or replaces path names an entry of the index its about selects.`,
    input: {
      memory: JSON.stringify(indexLayout(shared.tree, { tentative: true })),
      agentMemory: JSON.stringify(indexLayout(own.tree, { tentative: true })),
    },
    async save(
      ops: unknown[],
      messages: Array<{ id: string; text: string }>,
      refuse: (rejected: Rejection[]) => never,
    ) {
      const routed = split(ops);
      const at = now();
      const planned = [
        { document: shared, ops: routed.shared, scope: 'shared' as const, name: 'shared memory' },
        {
          document: own,
          ops: routed.own,
          scope: 'agent' as const,
          name: `the memory of the agent ${JSON.stringify(agent.name)}`,
        },
      ].filter(({ ops }) => ops.length);
      const rejected: Rejection[] = [];
      for (const { document, ops, name } of planned) {
        if (!document.tree.enabled) throw new Error(`Nothing was saved: ${name} is turned off.`);
        rejected.push(
          ...applyOps(structuredClone(document.tree), ops, messages, at, 'stated').rejected,
        );
      }
      if (rejected.length) refuse(rejected);
      const applied: Array<ReturnType<typeof applyOps>['applied'][number] & { memory: Scope }> = [];
      for (const [index, { document, ops, scope, name }] of planned.entries())
        try {
          applied.push(
            ...(await document.memory.edit((fresh) => {
              if (fresh.generation !== document.tree.generation)
                throw new Error(
                  'Memory changed while this note was being prepared. Save it again.',
                );
              const result = applyOps(fresh, ops, messages, at, 'stated');
              if (result.rejected.length) refuse(result.rejected);
              return result.applied.map((change) => ({ ...change, memory: scope }));
            })),
          );
        } catch (error) {
          if (!index) throw error;
          throw new Error(
            `Part of this was saved, to ${planned[0]!.name}, but saving to ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      return applied;
    },
    async share(ops: unknown[], messages: Array<{ id: string; text: string }>) {
      const routed = split(ops);
      const applied = routed.shared.length
        ? await shared.memory
            .edit((fresh) => applyOps(fresh, routed.shared, messages, now()).applied)
            .catch((error: unknown) => {
              if (error instanceof Error && error.message === 'Memory is turned off.') return [];
              throw error;
            })
        : [];
      return { own: routed.own, applied };
    },
  };
}

export function createAgentMemory(options: {
  pool: Pick<Pool, 'query'>;
  ownerId: string;
  store: PrivateObjectStore;
  shared: MemoryService;
  scope: (turnId: string) => Promise<AgentScope | undefined>;
  analytics?: CaptureAnalytics;
  refresh?: () => void;
}) {
  const { pool, ownerId, shared } = options;
  const services = new Map<string, MemoryService>();
  const key = (agentId: string) => `memory/agents/${z.uuid().parse(agentId)}.md`;

  function service(agentId: string) {
    const document = key(agentId);
    let memory = services.get(document);
    if (!memory) {
      memory = createMemoryService({
        pool,
        ownerId,
        store: options.store,
        analytics: options.analytics,
        key: document,
      });
      services.set(document, memory);
    }
    return memory;
  }

  async function documents(turnId: string) {
    const agent = await options.scope(turnId);
    if (!agent || agent.memoryMode === 'shared') return { readsShared: true } as const;
    return {
      agent,
      own: service(agent.id),
      readsShared: agent.memoryMode === 'own_and_shared',
    };
  }

  async function readable(
    turnId: string,
  ): Promise<Array<{ scope?: Scope; memory: MemoryService }>> {
    const scoped = await documents(turnId);
    return scoped.own
      ? [
          { scope: 'agent', memory: scoped.own },
          ...(scoped.readsShared ? [{ scope: 'shared' as const, memory: shared }] : []),
        ]
      : [{ memory: shared }];
  }

  async function context(turnId: string): Promise<Pick<RuntimeContext, 'memory' | 'agentMemory'>> {
    const scoped = await documents(turnId);
    if (!scoped.own) return { memory: await shared.context() };
    return {
      memory: scoped.readsShared ? await shared.context() : '',
      agentMemory: { index: await scoped.own.context(), readsShared: scoped.readsShared },
    };
  }

  async function learner(turnId: string): Promise<RoutedDocument | undefined> {
    const scoped = await documents(turnId);
    return scoped.own
      ? { name: scoped.agent.name, memory: scoped.own, readsShared: scoped.readsShared }
      : undefined;
  }

  async function read(turnId: string, action: string, raw: Record<string, unknown>) {
    const { scope: requested, ...args } = raw;
    const scope = scopeInput.parse(requested);
    const candidates = (await readable(turnId)).filter(
      (document) => !scope || (document.scope ?? 'shared') === scope,
    );
    if (!candidates.length)
      throw new Error(
        scope === 'agent'
          ? 'This chat has no memory of its own. It reads shared memory, without a scope.'
          : 'This agent reads only its own memory.',
      );
    if (action === 'memory_find')
      return (
        await Promise.all(
          candidates.map(async (document) =>
            (await document.memory.find(args)).map((note) =>
              document.scope ? { ...note, scope: document.scope } : note,
            ),
          ),
        )
      ).flat();
    for (const [index, document] of candidates.entries())
      try {
        const result = await document.memory.read(args);
        return document.scope ? { ...result, scope: document.scope } : result;
      } catch (error) {
        if (index === candidates.length - 1 || !/not found/.test(String(error))) throw error;
      }
  }

  async function target(turnId: string, action: string, raw: Record<string, unknown>) {
    const { scope: requested, agent: _agent, ...args } = raw;
    const scope = scopeInput.parse(requested);
    const scoped = await documents(turnId);
    if (!scoped.own) {
      if (scope === 'agent')
        throw new Error('This chat has no memory of its own. It uses shared memory.');
      return args;
    }
    if (scope !== 'shared') return { ...args, agent: scoped.agent.id };
    if (action === 'memory_control')
      throw new Error(
        "In an agent's chat, memory_control changes only this agent's memory. The owner changes shared memory from Main or Settings → Memory.",
      );
    if (!scoped.readsShared) throw new Error('This agent reads only its own memory.');
    return args;
  }

  async function nameOf(agentId: string) {
    return (
      await pool.query<{ name: string }>('SELECT name FROM agents WHERE id=$1 AND owner_id=$2', [
        agentId,
        ownerId,
      ])
    ).rows[0]?.name;
  }

  async function describe(
    proposal: ApprovalDescription,
    signal: AbortSignal | undefined,
    base: (proposal: ApprovalDescription, signal?: AbortSignal) => Promise<ApprovalPresentation>,
  ) {
    if (proposal.action !== 'NOD_memory_forget' && proposal.action !== 'NOD_memory_control')
      return base(proposal, signal);
    const { agent, ...args } = proposal.args;
    const name = typeof agent === 'string' ? await nameOf(agent) : undefined;
    if (typeof agent === 'string' && name === undefined) throw failure('Agent not found.', 404);
    const document =
      name !== undefined
        ? `the own memory of the agent ${JSON.stringify(name)}`
        : (await documents(proposal.turn.turnId)).own
          ? 'the shared memory'
          : undefined;
    if (!document) return base(proposal, signal);
    const presentation = await base(
      { ...proposal, args, details: { ...proposal.details, memory: document } },
      signal,
    );
    return { ...presentation, question: `${presentation.question}\n\nThis changes ${document}.` };
  }

  async function reflected(): Promise<ReflectedDocument[]> {
    const { rows } = await pool.query<{ id: string; name: string; memory_mode: string }>(
      "SELECT id,name,memory_mode FROM agents WHERE owner_id=$1 AND memory_mode<>'shared' ORDER BY id",
      [ownerId],
    );
    return rows.map((row) => ({
      memory: service(row.id),
      filter: agentFilter,
      params: [row.id],
      agent: {
        name: row.name,
        memory: service(row.id),
        readsShared: row.memory_mode === 'own_and_shared',
      },
    }));
  }

  async function historyChat(turnId: string | undefined) {
    const chat = await turnChat(pool, ownerId, turnId);
    if (!chat || !turnId) return chat;
    const scoped = await documents(turnId);
    if (!scoped.own || scoped.readsShared) return chat;
    const { rows } = await pool.query<{ chat_id: string }>(
      'SELECT chat_id FROM agent_chats WHERE owner_id=$1 AND agent_id=$2',
      [ownerId, scoped.agent.id],
    );
    return {
      ...chat,
      within: [...new Set([...(chat.id ? [chat.id] : []), ...rows.map(({ chat_id }) => chat_id)])],
    };
  }

  async function remove(agentId: string) {
    await options.store.remove(key(agentId));
    services.delete(key(agentId));
  }

  async function share(own: MemoryService, target: string) {
    const entry = locate(await own.load(), path.parse(target));
    if (!entry) throw failure('This note is no longer in memory.', 404);
    if (!(await shared.enabled()))
      throw failure(
        'Shared memory is turned off, so the note was not moved. Turn on Save new notes in shared memory first.',
        409,
      );
    await shared.edit((tree) => {
      if (areaEntries(tree, entry.area).some((item) => same(item.text, entry.text))) return;
      const before = tree.entries;
      tree.entries = [
        ...tree.entries,
        {
          ...entry,
          slug: freeSlug(tree, entry.area, entry.slug),
          updated: new Date().toISOString(),
        },
      ];
      if (!fits(tree)) {
        tree.entries = before;
        throw failure('Shared memory is full.', 409);
      }
    });
    await own.forget(target);
  }

  function registerRoutes(app: FastifyInstance) {
    const base = '/api/memory/agents/:agent';
    type Params = { agent: string; area?: string; slug?: string };
    const documentOf = async (params: unknown) => {
      const { agent } = params as Params;
      const id = z.uuid().parse(agent);
      if ((await nameOf(id)) === undefined) throw failure('Agent not found.', 404);
      return service(id);
    };
    const notePath = (params: unknown) => {
      const { area, slug } = params as Params;
      return `${area}/${slug}`;
    };
    const changed = async (
      memory: MemoryService,
      change: Promise<unknown>,
      operation?: MemoryChange['operation'],
    ): Promise<MemoryUpdate> => {
      const result = await change;
      if (operation && result !== false)
        options.analytics?.({
          event: 'memory_changed',
          properties: { kind: 'note', operation, actor: 'owner' },
        });
      options.refresh?.();
      return { ...(await memory.view()), ...(typeof result === 'string' ? { path: result } : {}) };
    };
    const route = (
      method: 'patch' | 'post' | 'delete',
      url: string,
      run: (memory: MemoryService, body: unknown, params: unknown) => Promise<unknown>,
      operation?: MemoryChange['operation'],
    ) =>
      app[method](`${base}${url}`, async (request) => {
        const memory = await documentOf(request.params);
        return changed(memory, run(memory, request.body, request.params), operation);
      });
    app.get('/api/memory/agents', async () => {
      const { rows } = await pool.query<{ id: string; name: string; own: boolean }>(
        "SELECT id,name,memory_mode<>'shared' AS own FROM agents WHERE owner_id=$1 ORDER BY lower(name),id",
        [ownerId],
      );
      const kept = await Promise.all(
        rows.map(async ({ id, name, own }) => {
          const tree = own ? undefined : await service(id).load();
          return own || tree?.entries.length || tree?.archive.length ? [{ id, name }] : [];
        }),
      );
      return kept.flat();
    });
    app.get(base, async (request) => (await documentOf(request.params)).view());
    app.get(`${base}/export`, async (request, reply) => {
      const memory = await documentOf(request.params);
      const now = new Date();
      return reply
        .header('Content-Type', 'text/markdown; charset=utf-8')
        .header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header(
          'Content-Disposition',
          `attachment; filename="${memoryFileName(now).replace('nod-memory', 'nod-agent-memory')}"`,
        )
        .send(memoryMarkdown(await memory.view(), now));
    });
    route('patch', '', (memory, body) => {
      if (Object(body).sensitive !== undefined)
        throw failure(
          'Include sensitive details is one setting for shared and agent memory. Change it in shared memory.',
          400,
        );
      return memory.settings(body);
    });
    route('post', '/notes', (memory, body) => memory.add(body), 'save');
    app.post(`${base}/import`, async (request): Promise<MemoryUpdate> => {
      const memory = await documentOf(request.params);
      const { saved, ...imported } = await memory.importNotes(request.body);
      return { ...(await changed(memory, Promise.resolve(saved), 'save')), imported };
    });
    route(
      'patch',
      '/notes/:area/:slug',
      (memory, body, params) => memory.change(notePath(params), body),
      'save',
    );
    route(
      'delete',
      '/notes/:area/:slug',
      (memory, _body, params) => memory.forget(notePath(params)),
      'forget',
    );
    route(
      'post',
      '/notes/:area/:slug/archive',
      (memory, _body, params) => memory.archiveNote(notePath(params)),
      'archive',
    );
    route('post', '/notes/:area/:slug/share', (memory, _body, params) =>
      share(memory, notePath(params)),
    );
    route('post', '/archive/restore', (memory, body) => memory.restore(body), 'save');
    route('post', '/archive/forget', (memory, body) => memory.forgetArchived(body), 'forget');
  }

  return {
    service,
    readable,
    context,
    learner,
    read,
    target,
    describe,
    reflected,
    historyChat,
    remove,
    registerRoutes,
  };
}
