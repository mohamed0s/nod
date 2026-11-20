import type { ModelReview } from '../ports/decisions.ts';
import { ModelUnavailableError } from '../ports/models.ts';

export type ModelReviewers = () => Promise<ModelReview[] | undefined>;

export async function pinnedReview<T>(
  reviewers: ModelReviewers | undefined,
  review: ModelReview,
  run: (review: ModelReview, last: boolean, signal?: AbortSignal) => Promise<T>,
  budget?: { ms: number; signal?: AbortSignal },
): Promise<T> {
  const listed = (await reviewers?.()) ?? [];
  const chain = listed.length ? listed : [review];
  const limit =
    budget && chain.length > 1
      ? AbortSignal.any([AbortSignal.timeout(budget.ms), ...(budget.signal ? [budget.signal] : [])])
      : budget?.signal;
  for (const [index, reviewer] of chain.entries()) {
    const last = index === chain.length - 1;
    try {
      return await run(reviewer, last, limit);
    } catch (error) {
      if (last || !(error instanceof ModelUnavailableError)) throw error;
    }
  }
  throw new Error('No model is available.');
}

export function keepUnavailable(last: boolean, error: unknown) {
  if (!last && error instanceof ModelUnavailableError) throw error;
}
