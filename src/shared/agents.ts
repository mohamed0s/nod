import type { ModelSelection } from './models';

export const agentLimits = { name: 60, description: 200, instructions: 4000 } as const;

export type AgentMemoryMode = 'shared' | 'own' | 'own_and_shared';

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  memoryMode: AgentMemoryMode;
  revision: number;
  chatId: string | null;
  model: ModelSelection | null;
}

export interface AgentSchedules {
  agents: Array<{ id: string; name: string }>;
  links: Array<{ scheduleId: string; agentId: string; useAgentModel: boolean; title: string }>;
}

export function agentApprovalContent(action: string, args: unknown) {
  const input = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const value = (key: string) => (typeof input[key] === 'string' ? input[key] : undefined);
  if (action === 'NOD_agent_schedule')
    return {
      fields: [
        { label: 'Schedule', value: value('schedule') ?? '' },
        { label: 'Runs as', value: value('agent') ?? 'No agent' },
        { label: "Uses the agent's model", value: input.useAgentModel === true ? 'Yes' : 'No' },
      ],
    };
  const fields = (
    [
      ['Name', value('name')],
      ["What it's for", value('description')],
    ] as const
  ).flatMap(([label, text]) => (text === undefined ? [] : [{ label, value: text || '(empty)' }]));
  const instructions = value('instructions');
  return { fields, ...(instructions === undefined ? {} : { body: instructions || '(none)' }) };
}
