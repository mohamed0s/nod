import type { ConnectedApp } from '../ports/integrations.ts';
import type { AgentChoices } from '../shared/agents.ts';
import type { AgentScope } from './agents.ts';
import { isLocalFilesAction } from './local-files.ts';

type App = Pick<ConnectedApp, 'slug' | 'name' | 'connectionId' | 'accountName' | 'accountEmail'>;

function permits(
  allowed: string[],
  app: { slug?: string; service?: string; connectionId?: string },
) {
  const slug = app.slug ?? app.service;
  return (
    (slug !== undefined && allowed.includes(slug)) ||
    (app.connectionId !== undefined && allowed.includes(app.connectionId))
  );
}

function serviceOf(apps: App[], action: string) {
  return apps
    .map(({ slug }) => slug)
    .sort((left, right) => right.length - left.length)
    .find((slug) => action.startsWith(`${slug.toUpperCase()}_`));
}

export function createAgentTools(options: {
  scope: (turnId: string) => Promise<AgentScope | undefined>;
  apps: () => Promise<App[]>;
  catalog: Array<{ name: string; description: string }>;
  learned: () => Promise<Array<{ name: string; description: string }> | undefined>;
}) {
  async function limited(turnId: string, kind: 'apps' | 'skills') {
    const agent = await options.scope(turnId);
    return agent?.[kind].length ? agent : undefined;
  }

  async function choices(): Promise<AgentChoices> {
    const apps = new Map<string, AgentChoices['apps'][number]>();
    for (const app of await options.apps()) {
      const entry = apps.get(app.slug) ?? { slug: app.slug, name: app.name, accounts: [] };
      if (app.connectionId)
        entry.accounts.push({
          id: app.connectionId,
          label: app.accountName || app.accountEmail || app.name,
        });
      apps.set(app.slug, entry);
    }
    const skill = (learned: boolean) => (item: { name: string; description: string }) => ({
      name: item.name,
      description: item.description,
      learned,
    });
    return {
      apps: [...apps.values()],
      skills: [
        ...options.catalog.map(skill(false)),
        ...((await options.learned()) ?? []).map(skill(true)),
      ],
    };
  }

  async function assertApp(turnId: string, action: string, args: Record<string, unknown>) {
    if (isLocalFilesAction(action)) return;
    const agent = await limited(turnId, 'apps');
    if (!agent) return;
    const connected = await options.apps();
    const connectionId = typeof args.connectionId === 'string' ? args.connectionId : undefined;
    const account = connectionId
      ? connected.find((app) => app.connectionId === connectionId)
      : undefined;
    const service = action.startsWith('CONNECTED_') ? account?.slug : serviceOf(connected, action);
    if (service && agent.apps.includes(service)) return;
    if (service && account?.slug === service && agent.apps.includes(account.connectionId!)) return;
    const accounts = connected.filter(
      (app) => app.slug === service && app.connectionId && agent.apps.includes(app.connectionId),
    );
    throw Object.assign(
      new Error(
        accounts.length
          ? `The owner limited the agent ${JSON.stringify(agent.name)} to some ${service} accounts. Call this action with connectionId ${accounts.map((app) => app.connectionId).join(' or ')}. Nothing was sent.`
          : `The owner limited the agent ${JSON.stringify(agent.name)} to these apps: ${agent.apps.join(', ')}. ${service ?? action} is not one of them, so nothing was sent. The owner can change the agent's apps.`,
      ),
      { statusCode: 403 },
    );
  }

  async function search<T>(turnId: string, result: T): Promise<T> {
    const agent = await limited(turnId, 'apps');
    if (!agent || !result || typeof result !== 'object') return result;
    const connected = await options.apps();
    const found = result as {
      tools?: Record<string, unknown>;
      suggestions?: Array<{ primaryToolSlugs: string[] }>;
      accounts?: Array<{ connectionId?: string; service: string }>;
      discovered?: Array<{ connectionId?: string; service?: string }>;
    };
    const discovered = (found.discovered ?? []).filter((account) => permits(agent.apps, account));
    const allowed = (name: string) => {
      if (name.startsWith('CONNECTED_')) return discovered.length > 0;
      const service = serviceOf(connected, name);
      return connected.some((app) => app.slug === service && permits(agent.apps, app));
    };
    const tools = Object.fromEntries(
      Object.entries(found.tools ?? {}).filter(([name]) => allowed(name)),
    );
    return {
      ...found,
      tools,
      ...(found.suggestions
        ? {
            suggestions: found.suggestions.filter((suggestion) =>
              suggestion.primaryToolSlugs.every((name) => Object.hasOwn(tools, name)),
            ),
          }
        : {}),
      ...(found.accounts
        ? { accounts: found.accounts.filter((account) => permits(agent.apps, account)) }
        : {}),
      ...(found.discovered ? { discovered } : {}),
    } as T;
  }

  async function listed<T>(turnId: string | undefined, action: string, result: T): Promise<T> {
    if (action !== 'list' || !turnId || !Array.isArray(result)) return result;
    const agent = await limited(turnId, 'apps');
    if (!agent) return result;
    return result.filter((item: { slug?: string; connectionId?: string; savedLogin?: unknown }) =>
      item?.savedLogin || item?.slug === undefined ? true : permits(agent.apps, item),
    ) as T;
  }

  async function assertSkill(turnId: string, name: string) {
    const agent = await limited(turnId, 'skills');
    if (agent && !agent.skills.includes(name))
      throw new Error(
        `The owner limited the agent ${JSON.stringify(agent.name)} to these skills: ${agent.skills.join(', ')}. ${name} is not one of them.`,
      );
  }

  return { choices, assertApp, search, listed, assertSkill };
}
