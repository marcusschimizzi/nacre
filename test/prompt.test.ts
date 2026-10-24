import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ExtractInput } from '../src/worker/extractor.js';
import {
  OUTPUT_SCHEMA,
  PROMPT_HASH,
  PROMPT_ID,
  PROMPT_VERSION,
  renderObservedAt,
  renderUserMessage,
  SYSTEM_PROMPT,
  TARGET_HEADERS,
  USER_TEMPLATE,
} from '../src/worker/prompts/extract-claims.v1.js';

/** The fenced §6.3 block of the spec, between its SYSTEM and USER headings and after USER. */
function specPromptBlock(): { system: string; user: string } {
  const spec = readFileSync('docs/slice-1-spec.md', 'utf8');
  const start = spec.indexOf('### 6.3 Prompt outline');
  const fence = spec.indexOf('```\nSYSTEM\n', start);
  const end = spec.indexOf('\n```', fence + 4);
  const block = spec.slice(fence + 4, end);
  const [system = '', user = ''] = block.slice('SYSTEM\n'.length).split('\n\nUSER\n');
  return { system, user };
}

const SPEC_INPUT: ExtractInput = {
  observedAt: new Date('2026-10-21T19:05:09Z'),
  observedTz: 'America/Chicago',
  context: [
    { role: 'user', text: '…' },
    { role: 'assistant', text: '…' },
  ],
  target: {
    kind: 'message',
    role: 'user',
    text: 'For the record, my preferred package manager is pnpm. Can you update the README?',
  },
};

describe('prompt extract-claims v1', () => {
  it('is frozen: the hash of the template is pinned', () => {
    expect(PROMPT_ID).toBe('extract-claims');
    expect(PROMPT_VERSION).toBe(1);
    expect(PROMPT_HASH).toBe('37afe24939a93eb23a6b5d8059e8b534b8f4a143d084504d783a500d80f09f80');
  });

  it("SYSTEM_PROMPT is the spec's SYSTEM block, verbatim", () => {
    const { system } = specPromptBlock();
    expect(system.startsWith('You extract durable memories')).toBe(true);
    expect(SYSTEM_PROMPT).toBe(system);
    expect(SYSTEM_PROMPT.endsWith('\n')).toBe(false);
  });

  it("renders the spec's USER example byte for byte", () => {
    expect(renderUserMessage(SPEC_INPUT)).toBe(specPromptBlock().user);
  });

  it('fills the template in one pass: placeholders and delimiters in the body stay as typed', () => {
    const text = 'see {{TARGET}} and {{CONTEXT}} then >>> and <<< and $& $1 $$';
    const out = renderUserMessage({ ...SPEC_INPUT, target: { ...SPEC_INPUT.target, text } });
    expect(out).toContain(`<<<\n${text}\n>>>`);
    expect(out.split('{{TARGET}}')).toHaveLength(2);
  });

  it('uses the remember header, which never says "assistant"', () => {
    const out = renderUserMessage({
      ...SPEC_INPUT,
      target: { kind: 'remember', role: 'assistant', text: 'Remember that I use pnpm.' },
    });
    expect(out).toContain(`\n${TARGET_HEADERS.remember}\n<<<\n`);
    expect(TARGET_HEADERS.remember).not.toMatch(/assistant/i);
    expect(TARGET_HEADERS.message).toBe('TARGET (role=user):');
  });

  it('renders no context as (none), and keeps newlines in context text', () => {
    expect(renderUserMessage({ ...SPEC_INPUT, context: [] })).toContain(
      'use only to resolve references):\n(none)\nTARGET',
    );
    expect(
      renderUserMessage({ ...SPEC_INPUT, context: [{ role: 'user', text: 'a\nb' }] }),
    ).toContain('):\n[user] a\nb\nTARGET');
  });

  it.each([
    ['2026-10-21T19:05:09Z', 'America/Chicago', '2026-10-21T14:05:09-05:00 (America/Chicago)'],
    ['2026-12-01T19:05:09Z', 'America/Chicago', '2026-12-01T13:05:09-06:00 (America/Chicago)'],
    ['2026-10-21T19:05:09Z', null, '2026-10-21T19:05:09+00:00 (UTC)'],
    ['2026-10-21T19:05:09Z', 'Not/AZone', '2026-10-21T19:05:09+00:00 (UTC)'],
    ['2026-10-21T19:05:09Z', 'Asia/Kolkata', '2026-10-22T00:35:09+05:30 (Asia/Kolkata)'],
    ['2026-10-21T05:00:00Z', 'America/Chicago', '2026-10-21T00:00:00-05:00 (America/Chicago)'],
  ])('OBSERVED_AT %s in %s renders %s', (at, tz, expected) => {
    expect(renderObservedAt(new Date(at), tz)).toBe(expected);
  });

  it('USER_TEMPLATE is exactly the brief’s', () => {
    expect(USER_TEMPLATE).toBe(
      'OBSERVED_AT: {{OBSERVED_AT}}\nCONTEXT (do not extract from this; use only to resolve references):\n{{CONTEXT}}\n{{TARGET_HEADER}}\n<<<\n{{TARGET}}\n>>>',
    );
  });

  it('the output schema is valid for strict mode: every object closed, every property required', () => {
    const problems: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (Array.isArray(node)) {
        node.forEach((n, i) => {
          walk(n, `${path}[${i}]`);
        });
        return;
      }
      if (node === null || typeof node !== 'object') return;
      const o = node as Record<string, unknown>;
      if (o.type === 'object') {
        if (o.additionalProperties !== false) problems.push(`${path}: additionalProperties`);
        const props = Object.keys((o.properties as Record<string, unknown>) ?? {}).sort();
        const required = [...((o.required as string[]) ?? [])].sort();
        if (props.join() !== required.join()) problems.push(`${path}: required`);
      }
      for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
    };
    walk(OUTPUT_SCHEMA, '$');
    expect(problems).toEqual([]);
    const claim = OUTPUT_SCHEMA.properties.claims.items;
    expect(claim.properties.time_phrase).toEqual({ type: ['string', 'null'] });
    expect(claim.properties.assertion_type.enum).toEqual([
      'stated',
      'preference',
      'instruction',
      'plan',
      'decision',
      'hypothesis',
      'quoted_third_party',
    ]);
    expect(JSON.stringify(OUTPUT_SCHEMA)).not.toMatch(/minimum|maximum/);
  });
});
