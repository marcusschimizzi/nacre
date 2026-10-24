import { createHash } from 'node:crypto';
import { timeZoneOrNull } from '../../shared/events.js';
import { canonicalJson } from '../canonical-json.js';
import { ASSERTION_TYPES, type ExtractInput } from '../extractor.js';

/**
 * Prompt `extract-claims` v1: spec §6.3, with the §5.3 output schema. A TypeScript module, not a
 * text file, because the image ships only `dist` and `migrations`.
 *
 * v1 is FROZEN: a test pins PROMPT_HASH, and every extraction run records it. A changed prompt is a
 * new `extract-claims.v2.ts` with its own version, never an edit here.
 */

export const PROMPT_ID = 'extract-claims';
export const PROMPT_VERSION = 1;

/** The SYSTEM block of spec §6.3, verbatim (a test compares it with docs/slice-1-spec.md). */
export const SYSTEM_PROMPT = [
  'You extract durable memories from one TARGET message in a conversation between a user and an AI agent.',
  'Return JSON matching the schema. Return {"claims": []} when nothing qualifies; that is the common case.',
  '',
  'Qualifies (durable and useful in a future conversation):',
  '- facts about the user or about people and things in their life or work; preferences; decisions;',
  '  plans with a time; standing instructions for agents ("always run tests before committing").',
  'Does not qualify:',
  '- the task being requested right now; chit-chat; questions; content of code, files or documents that',
  '  live elsewhere (they are their own source of truth); anything that appears only in CONTEXT;',
  "  the assistant's suggestions.",
  '',
  'Rules:',
  '1. Atomic: one fact per claim. Split "X and Y".',
  '2. subject: write "user" for the person typing. Resolve pronouns using CONTEXT. Qualify kinship',
  `   ("the user's sister", not "sister"). Never use a pronoun as a subject.`,
  '3. attribute: a short, plain snake_case name for the question being answered',
  '   ("preferred_package_manager", "employer", "contact_for_data_contract").',
  '4. value_kind: "entity" if the value is a person, place, organization, project, tool or other thing',
  '   that could have its own facts; "literal" for dates, numbers, strings and descriptions.',
  '5. assertion_type: stated | preference | instruction | plan | decision | hypothesis | quoted_third_party.',
  '   Hypotheticals ("if I moved…") are hypothesis. Something another person said is quoted_third_party.',
  '6. quote: copy the shortest contiguous span of the TARGET message that states the fact, character for',
  '   character. No ellipses, no paraphrase, no fixing typos. If you cannot quote it, omit the claim.',
  '7. Time: never compute dates. Copy any time expression verbatim into time_phrase',
  '   ("next month", "since 2024", "on Friday").',
  '8. confidence: how sure you are that the user means this as true and lasting, with a one-sentence reason.',
].join('\n');

/** Filled in one pass (`renderUserMessage`), so a body containing `{{TARGET}}` stays as typed. */
export const USER_TEMPLATE = [
  'OBSERVED_AT: {{OBSERVED_AT}}',
  'CONTEXT (do not extract from this; use only to resolve references):',
  '{{CONTEXT}}',
  '{{TARGET_HEADER}}',
  '<<<',
  '{{TARGET}}',
  '>>>',
].join('\n');

/**
 * The `remember` header must not say "assistant", or rule "the assistant's suggestions" would
 * swallow an agent's explicit save (task 10 stores those with role 'assistant').
 */
export const TARGET_HEADERS = {
  message: 'TARGET (role=user):',
  remember: 'TARGET (explicit remember request; the user asked for this to be saved):',
} as const;

const claimSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'text',
    'subject',
    'attribute',
    'value',
    'value_kind',
    'assertion_type',
    'quote',
    'time_phrase',
    'confidence',
    'confidence_reason',
  ],
  properties: {
    text: { type: 'string' },
    subject: { type: 'string' },
    attribute: { type: 'string' },
    value: { type: 'string' },
    value_kind: { type: 'string', enum: ['entity', 'literal'] },
    assertion_type: { type: 'string', enum: [...ASSERTION_TYPES] },
    quote: { type: 'string' },
    time_phrase: { type: ['string', 'null'] },
    // No minimum/maximum: the adapter checks [0, 1] after the call.
    confidence: { type: 'number' },
    confidence_reason: { type: 'string' },
  },
} as const;

/** Spec §5.3 in OpenAI's strict form: every property required, no extra properties anywhere. */
export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['claims'],
  properties: { claims: { type: 'array', items: claimSchema } },
} as const;

/** The template, not the inputs (the `extraction_runs.prompt_hash` column comment). */
export const PROMPT_HASH = createHash('sha256')
  .update(
    [
      SYSTEM_PROMPT,
      USER_TEMPLATE,
      canonicalJson(TARGET_HEADERS),
      canonicalJson(OUTPUT_SCHEMA),
    ].join('\n---\n'),
  )
  .digest('hex');

/** `YYYY-MM-DDTHH:mm:ss±hh:mm (<zone>)` in the event's zone, or in UTC when it has none. */
export function renderObservedAt(at: Date, tz: string | null): string {
  const zone = timeZoneOrNull(tz) ?? 'UTC';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  // 'GMT-05:00', or plain 'GMT' at offset zero.
  const offset = (parts.timeZoneName ?? 'GMT').replace('GMT', '') || '+00:00';
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset} (${zone})`;
}

export function renderUserMessage(input: ExtractInput): string {
  const context = input.context.length
    ? input.context.map((c) => `[${c.role}] ${c.text}`).join('\n')
    : '(none)';
  const values: Record<string, string> = {
    OBSERVED_AT: renderObservedAt(input.observedAt, input.observedTz),
    CONTEXT: context,
    TARGET_HEADER: TARGET_HEADERS[input.target.kind],
    TARGET: input.target.text,
  };
  // One pass over the template: replaced text is never scanned again.
  return USER_TEMPLATE.replace(
    /\{\{([A-Z_]+)\}\}/g,
    (match, name: string) => values[name] ?? match,
  );
}
