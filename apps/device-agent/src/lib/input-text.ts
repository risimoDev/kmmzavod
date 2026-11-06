import { shQuote } from './persistent-shell';

/**
 * Shell command typing printable-ASCII `text` with `input text`. Spaces are sent as `%s` (what
 * `input text` expects) and the result is single-quoted, so `#`, `{}`, `[]`, `$()`, backticks and
 * quotes reach `input` verbatim instead of being interpreted by sh.
 *
 * `input text` also turns a literal "%s" into a space, so a "%" directly followed by "s" is typed
 * by a separate `input text` call (the "%" ends one call, the "s" starts the next).
 */
export function buildInputTextCommand(text: string): string {
  const parts = text.split(/(?<=%)(?=s)/).filter((p) => p.length > 0);
  if (parts.length === 0) return 'true';
  return parts.map((p) => `input text ${shQuote(p.replace(/ /g, '%s'))}`).join('; ');
}
