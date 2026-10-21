/**
 * Final clean-up of a post description before it is published.
 *
 * Captions are assembled from several sources (LLM caption with its own hashtags, the
 * autopilot template, generated hashtags, the product article), which produced posts like
 * "#волны ##красота …" with the whole hashtag line repeated twice.
 *   - "##tag" → "#tag";
 *   - a hashtag that already appeared earlier is dropped (case-insensitive);
 *   - a paragraph identical to an earlier one is dropped; blank paragraphs go away.
 * Plain text is never reworded.
 */
export function normalizeCaption(raw: string): string {
  const seenTags = new Set<string>();
  const seenParas = new Set<string>();
  const paras: string[] = [];

  const text = raw.replace(/\r/g, '').replace(/#{2,}(?=[\p{L}\d_])/gu, '#');
  for (const para of text.split(/\n[ \t]*\n+/)) {
    const lines = para.split('\n').map((line) => {
      const tokens = line.split(/(\s+)/);
      return tokens
        .filter((tok, i) => {
          const m = /^#([\p{L}\d_]+)/u.exec(tok);
          if (!m) return true;
          const key = m[1].toLowerCase();
          // A tag that is the value of a label ("Артикул: #123") is content, not a list item.
          const afterLabel = /:\s*$/.test(tokens.slice(0, i).join(''));
          if (seenTags.has(key) && !afterLabel) return false;
          seenTags.add(key);
          return true;
        })
        .join('')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
    }).filter(Boolean);
    const p = lines.join('\n');
    if (!p) continue;
    const key = p.toLowerCase();
    if (seenParas.has(key)) continue;
    seenParas.add(key);
    paras.push(p);
  }
  return paras.join('\n\n');
}
