import { setTimeout as sleep } from 'node:timers/promises';
import {
  InMemoryCredentialStore,
  getSupportedThinkingLevels,
  isContextOverflow,
  isRetryableAssistantError,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
} from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createPiModelRuntime } from './models.ts';
import { ModelUnavailableError, type ModelAccess } from '../../ports/models.ts';
import { lightestEffort } from '../../shared/models.ts';
import { fallbackWait, modelUnavailable } from '../../shared/model-fallback.ts';
import type { MemoryCurator } from '../../ports/memory-curator.ts';
import { agentModels, memoryModels } from '../../shared/model-defaults.ts';
import { piUsageMetrics } from './usage.ts';
import { piModelTrace } from './traces.ts';
import type { ModelTraces } from '../../ports/traces.ts';

const untraced = new Set([
  'access',
  'attention',
  'reflect',
  'remember',
  'recall',
  'review',
  'style',
  'skill',
  'classify',
  'check',
]);

const checks = new Set(['review', 'access', 'classify', 'attention', 'check']);

const longCache = 55 * 60_000;
const recentInstructions = new Map<string, number>();

function keepInstructions(key: string) {
  const now = Date.now();
  const last = recentInstructions.get(key);
  recentInstructions.set(key, now);
  if (recentInstructions.size > 200)
    for (const [entry, at] of recentInstructions)
      if (now - at >= longCache) recentInstructions.delete(entry);
  return last !== undefined && now - last < longCache;
}

function uncachedInput(payload: unknown) {
  const request = payload as {
    messages?: Array<{ content?: unknown }>;
  } | null;
  if (!Array.isArray(request?.messages)) return undefined;
  return {
    ...request,
    messages: request.messages.map((message) =>
      Array.isArray(message.content)
        ? {
            ...message,
            content: message.content.map((block: Record<string, unknown>) => {
              const { cache_control: _, ...rest } = block;
              return rest;
            }),
          }
        : message,
    ),
  };
}

function json(text: string) {
  const parse = (body: string) => {
    const start = body.indexOf('{');
    try {
      return start < 0 ? null : JSON.parse(body.slice(start, body.lastIndexOf('}') + 1));
    } catch {
      return null;
    }
  };
  return parse(text) ?? parse(/```(?:json)?\s*([\s\S]*)```/.exec(text)?.[1] ?? '');
}

function failure(
  task: string,
  reply: AssistantMessage,
  model: Model<Api>,
  tried: string[],
  unavailable: boolean,
) {
  const label =
    task === 'vision'
      ? 'The image model is unavailable.'
      : task === 'classify' || task === 'attention'
        ? 'The classification model is unavailable.'
        : task === 'review' || task === 'access'
          ? 'The action review model is unavailable.'
          : task === 'check'
            ? 'The selected model is unavailable.'
            : 'The memory model is unavailable.';
  const detail =
    reply.stopReason === 'error' && reply.errorMessage
      ? ` The provider said: ${reply.errorMessage.trim().slice(0, 300)}`
      : reply.stopReason === 'length'
        ? ' The reply stopped at the token limit.'
        : '';
  const status = [...(reply.errorMessage ?? '').matchAll(/\(HTTP (\d{3})\)/g)].at(-1)?.[1];
  const current = `${model.provider}/${model.id}`;
  const message = `${label} Task: ${task}. Model: ${[...tried, current].join('; then ')}.${detail}`;
  if (unavailable)
    return new ModelUnavailableError(
      message,
      [...tried, `${current} (${reply.errorMessage?.trim().slice(0, 150)})`],
      status ? Number(status) : undefined,
    );
  return Object.assign(new Error(message), status ? { providerStatus: Number(status) } : {});
}

export function createPiMemoryCurator(options: {
  provider: string;
  resolve?: () => Promise<ModelAccess | ModelAccess[] | undefined>;
  configured?: () => boolean;
  model?: string;
  lightest?: boolean;
  apiKey?: string;
  runtime?: ModelRuntime;
  traces?: ModelTraces;
}): MemoryCurator {
  let loaded: ReturnType<typeof load> | undefined;
  async function load(access: ModelAccess | undefined, automatic: boolean) {
    if (access) {
      await access.prepareRequest?.(
        access.textModel?.definition.choice.id ?? access.definition.choice.id,
        automatic,
      );
      return {
        ...(await createPiModelRuntime(access, { automatic })),
        effort: access.effort,
        subscription: access.method === 'subscription',
      };
    }
    const runtime =
      options.runtime ??
      (await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
      }));
    await runtime.setRuntimeApiKey(options.provider, options.apiKey!);
    const model = (
      options.model
        ? [options.model]
        : [
            memoryModels[options.provider as keyof typeof memoryModels],
            agentModels[options.provider as keyof typeof agentModels],
          ]
    ).flatMap((id) => (id ? (runtime.getModel(options.provider, id) ?? []) : []))[0];
    if (!model) throw new Error('The memory model is not present in the installed Pi catalog.');
    return {
      runtime,
      model,
      effort: options.lightest ? lightestEffort(getSupportedThinkingLevels(model)) : undefined,
      subscription: false,
      requestFacts: undefined,
      retryAfter: undefined,
    };
  }
  async function candidates() {
    if (!options.resolve) return [undefined];
    const resolved = await options.resolve();
    const list = resolved === undefined ? [] : [resolved].flat();
    if (!list.length) throw new Error('The selected model is unavailable.');
    return list;
  }
  const curator: MemoryCurator = {
    get id() {
      return options.provider;
    },
    get configured() {
      return options.configured?.() ?? Boolean(options.apiKey);
    },
    async curate(
      { task, instructions, input, images, automatic = true, fallback },
      signal,
      report,
    ) {
      signal?.throwIfAborted();
      const bounded = task === 'classify' || task === 'attention' || task === 'check';
      const listed = await candidates();
      const chain = fallback === false ? listed.slice(0, 1) : listed;
      const tried: string[] = [];
      for (const [index, access] of chain.entries()) {
        const last = index === chain.length - 1;
        let connection: Awaited<ReturnType<typeof load>>;
        try {
          if (options.resolve) connection = await load(access, automatic);
          else {
            loaded ??= load(undefined, automatic).catch((error) => {
              loaded = undefined;
              throw error;
            });
            connection = await loaded;
          }
        } catch (error) {
          if (last || !access || signal?.aborted || !(error instanceof ModelUnavailableError))
            throw error;
          tried.push(
            `${access.provider}/${access.definition.choice.id} (${error.message.slice(0, 150)})`,
          );
          continue;
        }
        const { runtime, model, effort, subscription, requestFacts } = connection;
        const sessionId = ['opencode', 'opencode-go'].includes(model.provider)
          ? crypto.randomUUID()
          : undefined;
        let attempt = 0;
        const complete = async () => {
          attempt++;
          const context: Context = {
            systemPrompt: instructions,
            messages: [
              {
                role: 'user',
                content:
                  task === 'vision'
                    ? [{ type: 'text', text: JSON.stringify(input) }, ...(images ?? [])]
                    : JSON.stringify(input),
                timestamp: Date.now(),
              },
            ],
          };
          const startedAt = new Date().toISOString();
          const started = performance.now();
          let reply: AssistantMessage | undefined;
          try {
            reply = await runtime.completeSimple(model, context, {
              ...(model.api === 'anthropic-messages'
                ? {
                    onPayload: uncachedInput,
                    ...(keepInstructions(`${model.provider}:${model.id}:${instructions}`)
                      ? { cacheRetention: 'long' as const }
                      : {}),
                  }
                : {}),
              signal: AbortSignal.any([
                AbortSignal.timeout(bounded ? 10_000 : 45_000),
                ...(signal ? [signal] : []),
              ]),
              maxTokens: bounded ? 512 : 8192,
              ...(sessionId ? { sessionId } : {}),
              ...(bounded ? { maxRetries: 0, timeoutMs: 10_000 } : {}),
              reasoning: effort === 'off' ? undefined : effort,
            });
          } finally {
            const metrics = piUsageMetrics(reply?.usage);
            report?.({
              id: crypto.randomUUID(),
              attempt,
              provider: reply?.provider ?? model.provider,
              model: reply?.model ?? model.id,
              durationMs: performance.now() - started,
              ...metrics,
              status:
                reply?.stopReason === 'aborted' || (!reply && signal?.aborted)
                  ? 'cancelled'
                  : !reply || reply.stopReason === 'error'
                    ? 'failed'
                    : 'succeeded',
              costUsd: subscription ? null : (metrics.costUsd ?? null),
              ...(subscription ? { estimateUsd: metrics.costUsd ?? null } : {}),
              pricing: subscription ? 'unavailable' : (metrics.pricing ?? 'unavailable'),
            });
          }
          const target = runtime.getModel(reply.provider, reply.model) ?? model;
          if (!untraced.has(task) && options.traces?.active())
            options.traces.record(
              piModelTrace(
                {
                  model: target,
                  context,
                  message: reply,
                  startedAt,
                  request: requestFacts?.(reply),
                },
                { source: 'curator', task },
              ),
            );
          return reply;
        };
        const unavailable = (reply: AssistantMessage) =>
          reply.stopReason === 'error' &&
          !signal?.aborted &&
          !isContextOverflow(reply, model.contextWindow)
            ? modelUnavailable(reply.errorMessage, isRetryableAssistantError(reply))
            : undefined;
        let reply = await complete();
        if (
          fallback !== false &&
          unavailable(reply) === 'busy' &&
          (await sleep(
            fallbackWait(connection.retryAfter?.(reply), checks.has(task) ? 3000 : 15_000, 250),
            true,
            { signal },
          ).catch(() => false))
        )
          reply = await complete();
        if (
          reply.stopReason !== 'error' &&
          reply.stopReason !== 'aborted' &&
          reply.stopReason !== 'length'
        )
          return json(
            reply.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(''),
          );
        const kind = unavailable(reply);
        if (kind && !last) {
          tried.push(`${model.provider}/${model.id} (${reply.errorMessage?.trim().slice(0, 150)})`);
          continue;
        }
        throw failure(task, reply, model, tried, Boolean(kind));
      }
      throw new Error('The selected model is unavailable.');
    },
    async pinned() {
      if (!options.resolve) return [curator];
      return (await candidates()).map((access) =>
        createPiMemoryCurator({ ...options, resolve: async () => access, configured: () => true }),
      );
    },
  };
  return curator;
}
