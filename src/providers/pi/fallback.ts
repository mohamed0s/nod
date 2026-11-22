import {
  clampThinkingLevel,
  createAssistantMessageEventStream,
  isContextOverflow,
  isRetryableAssistantError,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { estimateTokens } from '@earendil-works/pi-coding-agent';
import { ModelPausedError, type ModelAccess } from '../../ports/models.ts';
import type { createPiModelRuntime } from './models.ts';
import { hasNativeAudio, readsNativeAudio } from './audio.ts';

type Connection = Awaited<ReturnType<typeof createPiModelRuntime>>;
type Stream = Connection['runtime']['streamSimple'];

class SkippedModelError extends Error {}

export function modelKey(access: ModelAccess) {
  return `${access.connectionId ?? access.provider}/${access.method}/${access.definition.choice.id}`;
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

export function createTurnFallback(options: {
  primary: { access: ModelAccess; connection: Connection; stream: Stream };
  backups: ModelAccess[];
  start: number;
  automatic: boolean;
  connect(access: ModelAccess): Promise<Connection>;
  retrying(): boolean;
  floor(): number;
  switched(at: number): void;
  served(at: number, from: number): void;
  failed(message: AssistantMessage): void;
}) {
  const candidates: Array<{ access: ModelAccess; connection?: Promise<Connection> }> = [
    { access: options.primary.access, connection: Promise.resolve(options.primary.connection) },
    ...options.backups.map((access) => ({ access })),
  ];
  const ready = new Map<number, Connection>([[0, options.primary.connection]]);
  const served = new WeakMap<object, Model<Api>>();
  const tried: string[] = [];
  let at = Math.min(options.start, candidates.length - 1);
  let from = 0;
  let announced = 0;

  function move(next: number) {
    at = next;
    options.switched(at);
  }

  async function open(
    index: number,
    target: Model<Api>,
    context: Context,
    streamOptions: SimpleStreamOptions | undefined,
  ) {
    if (index === 0)
      return { model: target, upstream: options.primary.stream(target, context, streamOptions) };
    const candidate = candidates[index]!;
    candidate.connection ??= options.connect(candidate.access);
    const connection = await candidate.connection;
    ready.set(index, connection);
    if (!fits(connection.model, context))
      throw new SkippedModelError(
        `${candidate.access.definition.choice.name} can't take this conversation, so Nod didn't try it.`,
      );
    if (options.automatic) await candidate.access.prepareRequest?.(connection.model.id, true);
    const { apiKey: _, headers: __, env: ___, ...rest } = streamOptions ?? {};
    const level = clampThinkingLevel(connection.model, candidate.access.effort);
    return {
      model: connection.model,
      upstream: connection.runtime.streamSimple(connection.model, context, {
        ...rest,
        ...(connection.model.api === target.api
          ? {}
          : { onPayload: undefined, cacheRetention: undefined }),
        reasoning: level === 'off' ? undefined : level,
      } as SimpleStreamOptions),
    };
  }

  const givesUp = (message: AssistantMessage, model: Model<Api>) =>
    message.stopReason === 'error' &&
    !isContextOverflow(message, model.contextWindow ?? 0) &&
    isRetryableAssistantError(message) &&
    !options.retrying();

  return {
    stream(target: Model<Api>, context: Context, streamOptions?: SimpleStreamOptions) {
      if (
        (streamOptions?.maxTokens === 1 && streamOptions.maxRetries === 0) ||
        target.api === 'pi-virtual' ||
        (readsNativeAudio(target) && hasNativeAudio(context))
      )
        return options.primary.stream(target, context, streamOptions);
      const out = createAssistantMessageEventStream();
      const stopped = () => Boolean(streamOptions?.signal?.aborted);
      void (async () => {
        if (options.floor() > at) move(Math.min(options.floor(), candidates.length - 1));
        for (;;) {
          const index = at;
          const last = index + 1 >= candidates.length;
          let model = target;
          let reason: string;
          try {
            const opened = await open(index, target, context, streamOptions);
            model = opened.model;
            const held: AssistantMessageEvent[] = [];
            let sent = false;
            let failure: AssistantMessage | undefined;
            for await (const event of opened.upstream) {
              if (!sent && event.type === 'start') {
                held.push(event);
                continue;
              }
              if (
                !sent &&
                !last &&
                event.type === 'error' &&
                !stopped() &&
                givesUp(event.error, model)
              ) {
                failure = event.error;
                break;
              }
              if (!sent && event.type !== 'error' && index > 0 && index !== announced) {
                announced = index;
                options.served(index, from);
              }
              if (event.type === 'done') served.set(event.message, model);
              if (event.type === 'error') served.set(event.error, model);
              if (!sent) for (const item of held.splice(0)) out.push(item);
              sent = true;
              out.push(event);
            }
            if (!failure) {
              const result = await opened.upstream.result();
              served.set(result, model);
              if (result.stopReason !== 'error' && result.stopReason !== 'aborted')
                tried.length = 0;
              out.end(result);
              return;
            }
            served.set(failure, model);
            options.failed(failure);
            from = index;
            reason = failure.errorMessage?.trim() || 'The provider gave no reason.';
          } catch (error) {
            if (
              stopped() ||
              last ||
              !(error instanceof ModelPausedError || error instanceof SkippedModelError)
            ) {
              const result = failedRequest(model, error, stopped());
              out.push({
                type: 'error',
                reason: result.stopReason === 'aborted' ? 'aborted' : 'error',
                error: result,
              });
              out.end(result);
              return;
            }
            reason = error.message;
          }
          const { access } = candidates[index]!;
          tried.push(`${access.provider} / ${access.definition.choice.id}: ${reason}`);
          move(index + 1);
        }
      })();
      return out;
    },
    describe(message: AssistantMessage) {
      if (message.stopReason !== 'error' || !tried.length) return undefined;
      return [
        ...tried,
        `${message.provider} / ${message.model}: ${message.errorMessage?.trim() || 'The provider gave no reason.'}`,
      ].join('; then ');
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
    model(usage: { provider: string; model: string }) {
      const exact = served.get(usage);
      if (exact) return exact;
      for (const connection of [ready.get(at), ...ready.values()]) {
        const found =
          connection?.model.provider === usage.provider && connection.model.id === usage.model
            ? connection.model
            : connection?.runtime.getModel(usage.provider, usage.model);
        if (found) return found;
      }
      return undefined;
    },
    current: () => candidates[at]!.access.definition.choice.name,
    switched: () => at > 0,
  };
}
