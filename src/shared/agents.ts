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

export function agentApprovalContent(args: unknown) {
  const input = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const value = (key: string) => (typeof input[key] === 'string' ? input[key] : undefined);
  const fields = (
    [
      ['Name', value('name')],
      ["What it's for", value('description')],
    ] as const
  ).flatMap(([label, text]) => (text === undefined ? [] : [{ label, value: text || '(empty)' }]));
  const instructions = value('instructions');
  return { fields, ...(instructions === undefined ? {} : { body: instructions || '(none)' }) };
}
