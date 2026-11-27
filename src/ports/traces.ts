export interface ModelTrace {
  id: string;
  name: string;
  provider: string;
  startedAt: string;
  endedAt: string;
  messages: unknown[];
  tools: string[];
  output: unknown;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number | null;
  };
  error?: string;
  metadata: Record<string, string | number>;
}

export interface ModelCallTrace {
  id: string;
  source: string;
  task?: string;
  turnId?: string;
  runId?: string;
  parentRunId?: string;
  provider: string;
  model: string;
  startedAt: string;
  endedAt: string;
  systemPrompt: string;
  tools: Array<{ name: string; description: string; parameters: unknown }>;
  messages: unknown[];
  output: unknown;
  usage: ModelTrace['usage'];
  stopReason: string;
  requestKind?: string;
  error?: string;
}

export interface ModelTraces {
  active(): boolean;
  record(trace: ModelTrace): void;
  capturing?(): boolean;
  capture?(build: () => ModelCallTrace, turnId?: string): void;
}

export type ModelTraceDelivery = (trace: ModelTrace, signal: AbortSignal) => Promise<void>;
