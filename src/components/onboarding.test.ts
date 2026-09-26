import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { FirstRunWelcome } from './onboarding';

describe('first-run Welcome presentation', () => {
  it('uses semantic, truthful conceptual copy and accessible actions', () => {
    const welcome = createElement(FirstRunWelcome, { onContinue: vi.fn(), onSkip: vi.fn() });
    const html = renderToStaticMarkup(createElement(MemoryRouter, undefined, welcome));
    expect(html).toContain('<h2');
    expect(html).toContain('Jagr watches your product while you’re away.');
    expect(html).toContain('Conceptual example');
    expect(html).toContain('not live data');
    expect(html).toContain('Jagr investigates before interrupting.');
    const progression = ['Connected', 'Watching', 'Change detected', 'Investigating evidence', 'Decision', 'Brief'];
    expect(progression.map((label) => html.indexOf(label))).toEqual([...progression.map((label) => html.indexOf(label))].sort((a, b) => a - b));
    expect(html).toContain('Analytics');
    expect(html).toContain('Jira');
    expect(html).toContain('Feedback');
    expect(html).toContain('Not corroborated across sources.');
    expect(html).toContain('No interruption needed');
    expect(html).toContain('Recorded in your morning brief');
    expect(html).toContain('Set up my first watch');
    expect(html).toContain('href="/demo"');
    expect(html).toContain('Skip for now');
  });
});
