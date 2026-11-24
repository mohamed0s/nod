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
