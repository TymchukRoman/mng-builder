import type { JSX } from 'react';
import type { ReviewResult } from '@manga/shared';
import { CircleCheck, TriangleAlert } from '../ui/icons';
import { reviewSummary } from './inspectorModel';

export function ReviewBadge({ review }: { review: ReviewResult }): JSX.Element {
  const text = reviewSummary(review);
  return (
    <span className={`review-badge review-badge--${review.pass ? 'pass' : 'fail'}`} role="img" aria-label={text} data-tip={text}>
      {review.pass ? <CircleCheck size={14} aria-hidden /> : <TriangleAlert size={14} aria-hidden />}
    </span>
  );
}
