import { ensureArticleInCaption, withArticle } from '../src/lib/article';

let failed = 0;
const eq = (got: string | undefined, want: string | undefined, m: string) => {
  const ok = got === want;
  if (!ok) failed++;
  console.log(ok ? 'PASS' : 'FAIL', m, ok ? '' : `\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
};

// The farm case: the voiceover/caption says "tap the hashtag and copy the article", but no article.
const farm = 'Создайте волшебные волны с этой плойкой!\nНажимай на хештег и копируй артикул для вб\n\n#волны #укладка #красота #стиль #советы';
eq(ensureArticleInCaption(farm, '123456789'), `${farm}\n\nАртикул: #123456789`, 'missing article → "Артикул: #N" appended');
eq(ensureArticleInCaption(`${farm}\n\nАртикул: #123456789`, '123456789'), `${farm}\n\nАртикул: #123456789`, 'idempotent');
eq(ensureArticleInCaption('Плойка\nАртикул: 123456789\n\n#волны #укладка', '123456789'),
  'Плойка\nАртикул: 123456789\n\n#волны #укладка #123456789', 'plain article present → hashtag added to the hashtag line');
eq(ensureArticleInCaption('Плойка, артикул 123456789', '123456789'), 'Плойка, артикул 123456789\n#123456789', 'plain article, no hashtag line → own line');
eq(ensureArticleInCaption('Плойка #1234567890', '123456789'), 'Плойка #1234567890\n#123456789', 'a longer number is not mistaken for the article tag');
eq(ensureArticleInCaption('Плойка', '#123456789'), 'Плойка\n\nАртикул: #123456789', 'leading # in the setting is ignored');
eq(ensureArticleInCaption('Плойка', null), 'Плойка', 'no article → unchanged');
eq(ensureArticleInCaption('', '42'), 'Артикул: #42', 'empty caption');

eq(withArticle('Плойка: локоны за 5 минут', '123'), 'Плойка: локоны за 5 минут\nАртикул товара: 123 (он стоит в описании поста хэштегом #123; в озвучке цифры не произносить)', 'script facts carry the article');
eq(withArticle(undefined, null), undefined, 'no facts, no article');

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exitCode = failed ? 1 : 0;
