/**
 * Product article (WB/Ozon) in autopilot scripts and post descriptions.
 *
 * The voiceover says "the article is in the description / tap the hashtag" — so the
 * description must ALWAYS carry it, not only when the LLM remembers to.
 */

/** Product facts for the scriptwriter, with the article as an explicit fact. */
export function withArticle(info: string | undefined, article: string | null | undefined): string | undefined {
  const a = article?.trim();
  if (!a) return info;
  const fact = `Артикул товара: ${a} (он стоит в описании поста хэштегом #${a}; в озвучке цифры не произносить)`;
  return info?.trim() ? `${info.trim()}\n${fact}` : fact;
}

/**
 * Make sure the post description contains the article as a hashtag:
 *   - "#123456" already there → unchanged;
 *   - the number is there as plain text ("Артикул: 123456") → "#123456" is added to the
 *     trailing hashtag line (or as its own line);
 *   - not there at all → "Артикул: #123456" is appended.
 */
export function ensureArticleInCaption(caption: string, article: string | null | undefined): string {
  const a = article?.trim().replace(/^#+/, '');
  if (!a) return caption;
  const tag = `#${a}`;
  const text = caption.trimEnd();
  if (new RegExp(`(^|\\s)${escapeRe(tag)}(?![\\p{L}\\d_])`, 'u').test(text)) return text;
  if (!text.includes(a)) return text ? `${text}\n\nАртикул: ${tag}` : `Артикул: ${tag}`;

  const lines = text.split('\n');
  const last = lines[lines.length - 1].trim();
  if (last && last.split(/\s+/).every((w) => w.startsWith('#'))) {
    lines[lines.length - 1] = `${lines[lines.length - 1].trimEnd()} ${tag}`;
    return lines.join('\n');
  }
  return `${text}\n${tag}`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
