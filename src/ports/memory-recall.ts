import type { MemoryNote } from '../shared/memory.ts';

export interface MemoryBrief {
  mode: 'personalize' | 'recall' | 'aggregate';
  facts: Array<MemoryNote & { scope?: 'agent' | 'shared' }>;
  messages: Array<{
    id: string;
    role: string;
    text: string;
    at: string;
    shortened: boolean;
  }>;
  searches: Array<{
    query: string;
    totalMatches: number;
    complete: boolean;
    nextCursor: string | null;
  }>;
  truncated?: boolean;
}
