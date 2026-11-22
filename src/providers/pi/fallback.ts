import { setTimeout as sleep } from 'node:timers/promises';
import {
  clampThinkingLevel,
  createAssistantMessageEventStream,
  isContextOverflow,
  isRetryableAssistantError,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { estimateTokens } from '@earendil-works/pi-coding-agent';
import { ModelUnavailableError, type ModelAccess } from '../../ports/models.ts';
import {
  fallbackWait,
  modelUnavailable,
  timedOut,
  type ModelUnavailable,
} from '../../shared/model-fallback.ts';
import { localModelSilenceMs, type createPiModelRuntime } from './models.ts';
import { readsNativeAudio } from './audio.ts';

type Connection = Awaited<ReturnType<typeof createPiModelRuntime>>;
type Stream = Connection['runtime']['streamSimple'];

export function modelKey(access: ModelAccess) {
  return `${access.connectionId ?? access.provider}/${access.method}/${access.definition.choice.id}`;
}

function failedRequest(model: Model<Api>, error: unknown, aborted: boolean): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: aborted ? 'aborted' : 'error',
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

function fits(model: Model<Api>, context: Context) {
  const images = context.messages.some(
    (message) =>
      Array.isArray(message.content) && message.content.some((part) => part.type === 'image'),
  );
  if (images && !model.input.includes('image')) return false;
  const tokens =
    context.messages.reduce((total, message) => total + estimateTokens(message as never), 0) +
    (context.systemPrompt?.length ?? 0) / 4;
  return !model.contextWindow || tokens < model.contextWindow * 0.9;
}

export function createTurnFallback(options: {
  primary: { access: ModelAccess; connection: Connection; stream: Stream };
  backups: ModelAccess[];
  start: number;
  automatic: boolean;
  connect(access: ModelAccess): Promise<Connection>;
  floor(): number;
  switched(at: number): void;
  served(at: number, reason: ModelUnavailable): void;
}) {
  const candidates: Array<{ access: ModelAccess; connection?: Promise<Connection> }> = [
    { access: options.primary.access, connection: Promise.resolve(options.primary.connection) },
    ...options.backups.map((access) => ({ access })),
  ];
  const ready = new Map<number, Connection>([[0, options.primary.connection]]);
  const window = options.primary.connection.model.contextWindow;
  const tried: Array<{ label: string; reason: string }> = [];
  let at = Math.min(options.start, candidates.length - 1);
  let failures = 0;
  const handled = new WeakSet<AssistantMessage>();
  const unsent = new WeakSet<AssistantMessage>();
  let wait = 0;
  let exhausted = false;
  let failed = at;
  let reason: ModelUnavailable | undefined = at > 0 ? 'quota' : undefined;
  let announced = false;

  const unavailable = (message: AssistantMessage) =>
    message.stopReason === 'error' && !isContextOverflow(message, window)
      ? modelUnavailable(message.errorMessage, isRetryableAssistantError(message))
      : undefined;

  function move(next: number) {
    at = next;
    failures = 0;
    wait = 0;
    options.switched(at);
  }

  function settle(index: number, message: AssistantMessage) {
    if (message.stopReason === 'aborted') return;
    if (message.stopReason !== 'error') {
      failures = wait = 0;
      tried.length = 0;
      if (index > 0 && !announced) {
        announced = true;
        options.served(index, reason ?? 'busy');
      }
      return;
    }
    const entry = {
      label: `${message.provider} / ${message.model}`,
      reason: message.errorMessage?.trim() || 'The provider gave no reason.',
    };
    if (tried.at(-1)?.label === entry.label) tried[tried.length - 1] = entry;
    else tried.push(entry);
    failed = index;
    const kind = unavailable(message);
    if (!kind || index !== at) return;
    reason ??= kind;
    failures++;
    if (kind === 'busy' && failures < 2 && !timedOut(message.errorMessage)) {
      wait = fallbackWait(ready.get(index)?.retryAfter(message), 15_000, 4000);
      return;
    }
    if (at + 1 < candidates.length) move(at + 1);
    else exhausted = true;
  }

  async function open(
    target: Model<Api>,
    context: Context,
    streamOptions: SimpleStreamOptions | undefined,
    use: (index: number, model: Model<Api>) => void,
  ) {
    if (options.floor() > at) move(Math.min(options.floor(), candidates.length - 1));
    for (;;) {
      const index = at;
      if (index === 0) {
        use(0, target);
        return options.primary.stream(target, context, streamOptions);
      }
      const candidate = candidates[index]!;
      try {
        candidate.connection ??= options.connect(candidate.access);
        const connection = await candidate.connection;
        ready.set(index, connection);
        use(index, connection.model);
        if (!fits(connection.model, context))
          throw new ModelUnavailableError(
            `${candidate.access.definition.choice.name} can't take this conversation, so Nod didn't try it.`,
            [candidate.access.definition.choice.id],
          );
        if (options.automatic) await candidate.access.prepareRequest?.(connection.model.id, true);
        const { apiKey: _, headers: __, env: ___, ...rest } = streamOptions ?? {};
        const level = clampThinkingLevel(connection.model, candidate.access.effort);
        return connection.runtime.streamSimple(connection.model, context, {
          ...rest,
          ...(connection.model.api === target.api
            ? {}
            : { onPayload: undefined, cacheRetention: undefined }),
          reasoning: level === 'off' ? undefined : level,
          timeoutMs: candidate.access.provider === 'compatible' ? localModelSilenceMs : 300_000,
        } as SimpleStreamOptions);
      } catch (error) {
        streamOptions?.signal?.throwIfAborted();
        tried.push({
          label: `${candidate.access.provider} / ${candidate.access.definition.choice.id}`,
          reason: error instanceof Error ? error.message : String(error),
        });
        if (index + 1 >= candidates.length || !(error instanceof ModelUnavailableError)) {
          exhausted = true;
          throw error;
        }
        move(index + 1);
      }
    }
  }

  return {
    stream(target: Model<Api>, context: Context, streamOptions?: SimpleStreamOptions) {
      if (
        (streamOptions?.maxTokens === 1 && streamOptions.maxRetries === 0) ||
        target.api === 'pi-virtual' ||
        readsNativeAudio(target)
      )
        return options.primary.stream(target, context, streamOptions);
      const out = createAssistantMessageEventStream();
      let index = at;
      let model = target;
      let settled = false;
      const finish = (message: AssistantMessage) => {
        handled.add(message);
        if (settled) return;
        settled = true;
        settle(index, message);
      };
      void (async () => {
        let result: AssistantMessage;
        let sent = false;
        try {
          if (wait) {
            const delay = wait;
            wait = 0;
            await sleep(delay, undefined, { signal: streamOptions?.signal });
          }
          const upstream = await open(target, context, streamOptions, (next, chosen) => {
            index = next;
            model = chosen;
          });
          sent = true;
          for await (const event of upstream) {
            if (event.type === 'done') finish(event.message);
            if (event.type === 'error') finish(event.error);
            out.push(event);
          }
          result = await upstream.result();
          finish(result);
        } catch (error) {
          result = failedRequest(model, error, Boolean(streamOptions?.signal?.aborted));
          if (!sent) unsent.add(result);
          finish(result);
          out.push({
            type: 'error',
            reason: result.stopReason as 'error' | 'aborted',
            error: result,
          });
        }
        out.end(result);
      })();
      return out;
    },
    sent: (message: AssistantMessage) => !unsent.has(message),
    retries(message: AssistantMessage) {
      return handled.has(message) && unavailable(message) ? !exhausted : undefined;
    },
    describe(message: AssistantMessage) {
      if (message.stopReason !== 'error' || new Set(tried.map(({ label }) => label)).size < 2)
        return undefined;
      return tried.map(({ label, reason }) => `${label}: ${reason}`).join('; then ');
    },
    method(provider: string, model: string) {
      const index = [at, ...candidates.keys()].find((index) => {
        const { access } = candidates[index]!;
        return (
          access.provider === provider &&
          [access.definition.choice.id, access.textModel?.definition.choice.id].includes(model)
        );
      });
      return candidates[index ?? at]!.access.method;
    },
    model(provider: string, id: string) {
      for (const index of new Set([at, ...ready.keys()])) {
        const served = ready.get(index)?.model;
        if (served?.provider === provider && served.id === id) return served;
      }
      for (const connection of ready.values()) {
        const listed = connection.runtime.getModel(provider, id);
        if (listed) return listed;
      }
      return undefined;
    },
    failed: () => candidates[failed]!.access.definition.choice.name,
    switched: () => at > 0,
    size: candidates.length,
  };
}
