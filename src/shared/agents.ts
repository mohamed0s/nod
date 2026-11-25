import type { ModelSelection } from './models';

export const agentLimits = {
  name: 60,
  description: 200,
  instructions: 4000,
  apps: 50,
  skills: 50,
} as const;

export type AgentMemoryMode = 'shared' | 'own' | 'own_and_shared';

export const agentMemoryModes: Array<{ id: AgentMemoryMode; label: string; hint: string }> = [
  { id: 'shared', label: 'Shared', hint: 'Reads and learns into your shared memory, like Main.' },
  {
    id: 'own',
    label: 'Own',
    hint: 'Reads only its own notes. Facts about you still go to shared memory.',
  },
  {
    id: 'own_and_shared',
    label: 'Own + read shared',
    hint: 'Learns into its own notes and also reads shared memory. Facts about you go to shared memory.',
  },
];

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  memoryMode: AgentMemoryMode;
  apps: string[];
  skills: string[];
  revision: number;
  chatId: string | null;
  model: ModelSelection | null;
}

export interface AgentChoices {
  apps: Array<{ slug: string; name: string; accounts: Array<{ id: string; label: string }> }>;
  skills: Array<{ name: string; description: string; learned: boolean }>;
}

export interface AgentSchedules {
  agents: Array<{ id: string; name: string }>;
  links: Array<{ scheduleId: string; agentId: string; useAgentModel: boolean; title: string }>;
}

export function agentAllowlist(values: string[] | undefined, everything: string) {
  return values?.length ? values.join(', ') : everything;
}

export function agentApprovalContent(action: string, args: unknown) {
  const input = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const value = (key: string) => (typeof input[key] === 'string' ? input[key] : undefined);
  const list = (key: string) =>
    Array.isArray(input[key])
      ? (input[key] as unknown[]).filter((item): item is string => typeof item === 'string')
      : undefined;
  if (action === 'NOD_agent_schedule')
    return {
      fields: [
        { label: 'Schedule', value: value('schedule') ?? '' },
        { label: 'Runs as', value: value('agent') ?? 'No agent' },
        { label: "Uses the agent's model", value: input.useAgentModel === true ? 'Yes' : 'No' },
      ],
    };
  const apps = list('apps');
  const skills = list('skills');
  const fields = [
    ...(
      [
        ['Name', value('name')],
        ["What it's for", value('description')],
      ] as const
    ).flatMap(([label, text]) => (text === undefined ? [] : [{ label, value: text || '(empty)' }])),
    ...(apps ? [{ label: 'Apps', value: agentAllowlist(apps, 'All connected apps') }] : []),
    ...(skills ? [{ label: 'Skills', value: agentAllowlist(skills, 'All skills') }] : []),
  ];
  const instructions = value('instructions');
  return { fields, ...(instructions === undefined ? {} : { body: instructions || '(none)' }) };
}
