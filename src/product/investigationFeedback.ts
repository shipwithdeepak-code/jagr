import { z } from 'zod';

/** A human assessment of usefulness, never evidence of causality or resolution. */
export const FEEDBACK_REASONS = ['wrong_conclusion', 'missing_evidence', 'too_noisy', 'too_slow', 'unclear_next_step'] as const;
export const InvestigationFeedback = z.object({
  usefulness: z.enum(['very_useful', 'somewhat_useful', 'not_useful']),
  reasons: z.array(z.enum(FEEDBACK_REASONS)).max(5).refine((values) => new Set(values).size === values.length),
  missing: z.string().trim().max(500).optional(),
}).strict();
export type InvestigationFeedbackInput = z.infer<typeof InvestigationFeedback>;
