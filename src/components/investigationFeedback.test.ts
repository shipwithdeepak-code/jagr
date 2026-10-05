import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { InvestigationFeedback } from '@/product/investigationFeedback';
import { InvestigationFeedbackForm } from './investigationFeedback';

it('presents structured, optional feedback as an assessment, not proof of cause', () => {
  const html = renderToStaticMarkup(createElement(InvestigationFeedbackForm, { workspaceId: 'ws', investigationId: 'inv' }));
  for (const label of ['Very useful', 'Somewhat useful', 'Not useful', 'Wrong conclusion', 'Missing evidence', 'Too noisy', 'Too slow', 'Unclear next step', 'What was missing?', 'Save feedback']) expect(html).toContain(label);
  expect(html).toContain('not proof of cause');
  expect(html).toContain('maxLength="500"');
});
it('does not offer to persist local/demo feedback in a customer workspace', () => {
  const html = renderToStaticMarkup(createElement(InvestigationFeedbackForm, { investigationId: 'demo' }));
  expect(html).not.toContain('Save feedback');
  expect(html).toContain('signed-in server workspace');
});
it('rejects unknown ratings, reasons, duplicate reasons, oversized notes and actor spoofing', () => {
  const input = { usefulness: 'very_useful', reasons: ['missing_evidence'], missing: 'A release link' };
  expect(InvestigationFeedback.safeParse(input).success).toBe(true);
  for (const patch of [{ usefulness: 'confirmed' }, { reasons: ['resolved'] }, { reasons: ['too_slow', 'too_slow'] }, { missing: 'x'.repeat(501) }, { actor: 'owner' }]) expect(InvestigationFeedback.safeParse({ ...input, ...patch }).success).toBe(false);
});
