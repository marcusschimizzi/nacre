/** The event fields the skip rules read. */
export interface SkipInput {
  kind: string;
  role: string | null;
  sensitivity: string;
}

const MARKER = /\[REDACTED:[a-z_]+\]/g;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * Whether an event must not be mined (spec §6.1), and why; null when it may be. First match wins:
 * sensitivity, kind, assistant role (except `remember`, which is mined whatever its role), then a
 * body with nothing in it but redaction markers, punctuation and whitespace.
 */
export function skipReason(event: SkipInput, body: string): string | null {
  // Private and restricted content never goes to a hosted model (design.md §9.8).
  if (event.sensitivity !== 'normal') return `sensitivity:${event.sensitivity}`;
  if (event.kind !== 'message' && event.kind !== 'remember') return `kind:${event.kind}`;
  // Assistant turns are stored and used as context, never mined: the model's own guesses must not
  // become facts (design.md §4.8).
  if (event.role === 'assistant' && event.kind !== 'remember') return 'role:assistant';
  if (!LETTER_OR_DIGIT.test(body.replace(MARKER, ''))) return 'empty';
  return null;
}
