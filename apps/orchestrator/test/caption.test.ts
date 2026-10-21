import { normalizeCaption } from '../src/lib/caption';

let failed = 0;
const eq = (got: string, want: string, m: string) => {
  const ok = got === want;
  if (!ok) failed++;
  console.log(ok ? 'PASS' : 'FAIL', m, ok ? '' : `\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
};

// Exactly what the farm phone showed (2026-10-21, 17:28).
eq(normalizeCaption('Создайте идеальные волны за минуты!\n\n#волны ##красота #волосы\n#стиль #прибордляволос\n\n#волны ##красота #волосы\n#стиль #прибордляволос'),
  'Создайте идеальные волны за минуты!\n\n#волны #красота #волосы\n#стиль #прибордляволос', 'farm caption: ## and the repeated hashtag block');
eq(normalizeCaption('Текст #Волны и #волны\n\n#ВОЛНЫ #укладка'), 'Текст #Волны и\n\n#укладка', 'duplicate tags dropped case-insensitively');
eq(normalizeCaption('Линия 1\n\n\n\nЛиния 2\n\nЛиния 1'), 'Линия 1\n\nЛиния 2', 'blank runs collapsed, repeated paragraph dropped');
eq(normalizeCaption('Скидка 50% — цена #1 в категории!'), 'Скидка 50% — цена #1 в категории!', 'plain text untouched');
eq(normalizeCaption('Плойка\n\n#волны #123456789\n\nАртикул: #123456789'), 'Плойка\n\n#волны #123456789\n\nАртикул: #123456789', 'a tag after "Артикул:" is never stripped');

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exitCode = failed ? 1 : 0;
