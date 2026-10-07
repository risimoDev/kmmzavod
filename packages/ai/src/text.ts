/**
 * Text helpers for voiceover scripts (Russian-first).
 *
 * Scripts carry Fish Audio emotion tags in square brackets — `[excited] Смотрите!`.
 * Tags steer the voice and are never spoken or shown in subtitles.
 */

/** Emotion tags the studio offers; anything else in [brackets] is stripped so
 *  the TTS never reads stray markup aloud. */
export const EMOTION_TAGS = [
  'excited', 'confident', 'whispering', 'laughing', 'surprised',
  'gasp', 'urgent', 'curious', 'calm', 'sigh',
] as const;
export type EmotionTag = (typeof EMOTION_TAGS)[number];

const TAG_RE = /\[\s*([a-zA-Z_\s-]+?)\s*\]/g;

export function stripEmotionTags(text: string): string {
  return text.replace(TAG_RE, ' ').replace(/\s+/g, ' ').trim();
}

/** Spoken words (tags and punctuation excluded). */
export function countWords(text: string): number {
  const clean = stripEmotionTags(text).replace(/[^\p{L}\p{N}\s-]/gu, ' ').trim();
  return clean ? clean.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0;
}

/**
 * Make a script safe for TTS: drop emoji/markdown/links, normalise tags to
 * `[tag]`, remove unknown tags, collapse whitespace.
 */
export function sanitizeForVoiceover(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\u{1F300}-\u{1FAFF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/[*#_~`{}<>|]/g, ' ')
    .replace(/[«»"“”]/g, '')
    .replace(TAG_RE, (_m, raw: string) => {
      const tag = raw.toLowerCase().replace(/[\s-]+/g, '_');
      return (EMOTION_TAGS as readonly string[]).includes(tag) ? ` [${tag}] ` : ' ';
    })
    .replace(/\s+([,.!?…:;])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split into sentences, keeping tags attached to the sentence they precede. */
export function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?…]+[.!?…]+["»]?|\S[^.!?…]*$/g) ?? [text];
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** First spoken sentence without tags — the hook. */
export function firstSentence(text: string): string {
  return stripEmotionTags(splitSentences(text)[0] ?? text).slice(0, 160);
}

/**
 * Shorten to ≤ maxWords by dropping sentences from the MIDDLE: the hook (first
 * sentence) and the call to action (last sentence) always survive.
 */
export function trimMiddle(text: string, maxWords: number): string {
  const sentences = splitSentences(text);
  if (countWords(text) <= maxWords || sentences.length <= 2) return text;
  const head = sentences[0];
  const tail = sentences[sentences.length - 1];
  const middle = sentences.slice(1, -1);
  let budget = maxWords - countWords(head) - countWords(tail);
  const kept: string[] = [];
  for (const s of middle) {
    const w = countWords(s);
    if (w > budget) continue; // skip a long one, a shorter later one may fit
    kept.push(s);
    budget -= w;
  }
  return [head, ...kept, tail].join(' ');
}

/** Normalised form for comparing hooks (case/punctuation-insensitive). */
export function normalizeForCompare(text: string): string {
  return stripEmotionTags(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

/** Jaccard similarity of word sets — cheap "is this hook a repeat?" check. */
export function similarity(a: string, b: string): number {
  const A = new Set(normalizeForCompare(a).split(' ').filter((w) => w.length > 2));
  const B = new Set(normalizeForCompare(b).split(' ').filter((w) => w.length > 2));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Robustly pull a JSON object out of a model reply (fences, prose, <think>). */
export function extractJson(raw: string): any {
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  return JSON.parse(s);
}
