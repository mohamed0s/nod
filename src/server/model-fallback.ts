import type { ModelReview } from '../ports/decisions.ts';
import { ModelUnavailableError } from '../ports/models.ts';

export type ModelReviewers = () => Promise<ModelReview[] | undefined>;

export async function pinnedReview<T>(
  reviewers: ModelReviewers | undefined,
  review: ModelReview,
  run: (review: ModelReview, last: boolean) => Promise<T>,
): Promise<T> {
  const listed = (await reviewers?.()) ?? [];
  const chain = listed.length ? listed : [review];
  for (const [index, reviewer] of chain.entries()) {
    const last = index === chain.length - 1;
    try {
      return await run(reviewer, last);
    } catch (error) {
      if (last || !(error instanceof ModelUnavailableError)) throw error;
    }
  }
  throw new Error('No model is available.');
}

export function keepUnavailable(last: boolean, error: unknown) {
  if (!last && error instanceof ModelUnavailableError) throw error;
}
