import type { ModelReview } from '../ports/decisions.ts';
import { ModelUnavailableError } from '../ports/models.ts';

export type ModelReviewers = () => Promise<ModelReview[] | undefined>;

const modelLimitMs = 45_000;

export async function pinnedReview<T>(
  reviewers: ModelReviewers | undefined,
  review: ModelReview,
  run: (review: ModelReview, last: boolean, signal?: AbortSignal) => Promise<T>,
  budget: { ms?: number; modelMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const listed = (await reviewers?.()) ?? [];
  const chain = listed.length ? listed : [review];
  const total =
    budget.ms !== undefined && chain.length > 1 ? AbortSignal.timeout(budget.ms) : undefined;
  const started = performance.now();
  for (const [index, reviewer] of chain.entries()) {
    const last = index === chain.length - 1;
    const remaining =
      budget.ms === undefined ? undefined : budget.ms - (performance.now() - started);
    const ms =
      total && remaining !== undefined
        ? Math.min(
            budget.modelMs ?? modelLimitMs,
            Math.floor(Math.max(0, remaining) / (chain.length - index)),
          )
        : budget.modelMs;
    const deadline = ms === undefined ? undefined : AbortSignal.timeout(ms);
    const signals = [budget.signal, total, deadline].filter((item) => item !== undefined);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const expired = () =>
      !last && Boolean(deadline?.aborted) && !total?.aborted && !budget.signal?.aborted;
    try {
      const result = await run(reviewer, last, signal);
      if (!expired()) return result;
    } catch (error) {
      if (!expired() && (last || !(error instanceof ModelUnavailableError))) throw error;
    }
  }
  throw new Error('No model is available.');
}

export function keepUnavailable(last: boolean, error: unknown) {
  if (!last && error instanceof ModelUnavailableError) throw error;
}
