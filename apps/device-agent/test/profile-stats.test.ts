import { parseCount, parseProfileDump } from '../src/profile-stats';

const ok = (c: boolean, m: string) => console.log(c ? 'PASS' : 'FAIL', m);
const W = 1080, H = 2400;
const node = (b: [number, number, number, number], extra = '', inner = '') =>
  `<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.zhiliaoapp.musically" content-desc="" clickable="false" ${extra} bounds="[${b[0]},${b[1]}][${b[2]},${b[3]}]">${inner}</node>`;
const txt = (t: string, b: [number, number, number, number]) =>
  `<node index="0" text="${t}" resource-id="x" class="android.widget.TextView" package="p" content-desc="" clickable="false" bounds="[${b[0]},${b[1]}][${b[2]},${b[3]}]" />`;
const tile = (col: number, row: number, views: string, pinned = false) => {
  const x = col * 360, y = 1000 + row * 400;
  return node([x, y, x + 360, y + 400], 'clickable="true"',
    (pinned ? txt('Закреплено', [x + 10, y + 10, x + 150, y + 50]) : '') + txt(views, [x + 40, y + 340, x + 200, y + 390]));
};

// TikTok: header (Подписки / Подписчики / Лайки), pinned first tile, 8 more tiles, bottom nav.
const tiktok = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">` + node([0, 0, W, H], '',
  txt('@shop_nahodki', [300, 300, 780, 360]) +
  txt('125', [150, 620, 300, 680]) + txt('Подписки', [130, 690, 320, 740]) +
  txt('12,3 тыс.', [450, 620, 630, 680]) + txt('Подписчики', [430, 690, 650, 740]) +
  txt('98,4 тыс.', [780, 620, 960, 680]) + txt('Лайки', [800, 690, 940, 740]) +
  tile(0, 0, '1,2 млн', true) + tile(1, 0, '3 456') + tile(2, 0, '812') +
  tile(0, 1, '12.5K') + tile(1, 1, '0') + tile(2, 1, '27') + tile(0, 2, '1,234') +
  txt('99+', [100, 2300, 200, 2350]) + txt('5', [500, 2300, 540, 2350])) + `</hierarchy>`;

const t = parseProfileDump(tiktok, W, H);
ok(t.onProfile, 'tiktok: profile detected');
ok(t.followers === 12300, `tiktok followers 12,3 тыс. → ${t.followers}`);
ok(t.tiles.length === 7, `tiktok tiles 7 → ${t.tiles.length}`);
ok(t.tiles[0].pinned && t.tiles[0].views === 1_200_000, `pinned first tile 1,2 млн → ${JSON.stringify(t.tiles[0])}`);
ok(JSON.stringify(t.tiles.map((x) => x.views)) === JSON.stringify([1200000, 3456, 812, 12500, 0, 27, 1234]), `order/values ${t.tiles.map((x) => x.views)}`);
ok(t.tiles.slice(1).every((x) => !x.pinned), 'only first pinned');

// Instagram: single node "1 234 подписчика" style in content-desc, reels tiles with ▶ counts.
const ig = `<hierarchy>` + node([0, 0, W, H], '',
  `<node text="" content-desc="5 678 подписчиков" clickable="true" bounds="[400,500][700,640]" />` +
  `<node text="" content-desc="Reels" clickable="true" bounds="[360,950][720,1050]" />` +
  tile(0, 0, '10,1 тыс.') + tile(1, 0, '977') + tile(2, 0, '4.2M')) + `</hierarchy>`;
const g = parseProfileDump(ig, W, H);
ok(g.followers === 5678, `ig followers in content-desc → ${g.followers}`);
ok(JSON.stringify(g.tiles.map((x) => x.views)) === JSON.stringify([10100, 977, 4200000]), `ig tiles ${g.tiles.map((x) => x.views)}`);

// Not a profile (feed) → onProfile false.
const feed = `<hierarchy>` + node([0, 0, W, H], '', txt('1,2K', [900, 1200, 1000, 1250])) + `</hierarchy>`;
ok(!parseProfileDump(feed, W, H).onProfile, 'feed is not a profile');

// Count formats.
const cases: [string, number | null][] = [['1,234', 1234], ['1 234', 1234], ['12.3K', 12300], ['12,3 тыс.', 12300], ['1,2 млн', 1200000], ['4.2M', 4200000], ['812', 812], ['abc', null], ['1.234.567', 1234567]];
for (const [s, v] of cases) ok(parseCount(s) === v, `parseCount(${s}) = ${parseCount(s)}`);
