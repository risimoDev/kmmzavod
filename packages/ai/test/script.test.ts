import { LlmChain, writeScript, countWords, trimMiddle, sanitizeForVoiceover, observePace, paceFor, templateScript, LlmUnavailableError } from '../src/index';

const calls: { url: string; body: any }[] = [];
function fakeFetch(handler: (body: any, url: string) => { status: number; json?: any }) {
  return async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const r = handler(body, url);
    return new Response(JSON.stringify(r.json ?? { error: 'x' }), { status: r.status });
  };
}
const words = (n: number, w = 'слово') => Array.from({ length: n }, () => w).join(' ');
const reply = (o: any) => ({ status: 200, json: { model: 'test-model', choices: [{ message: { content: '```json\n' + JSON.stringify(o) + '\n```' } }] } });
const ok = (c: boolean, m: string) => console.log(c ? 'PASS' : 'FAIL', m);

(async () => {
  // 1. OpenRouter down → GPTunnel answers; too long first → corrective call.
  calls.length = 0;
  let n = 0;
  const llm = new LlmChain([
    { name: 'openrouter', baseUrl: 'https://or', apiKey: 'k', models: ['a', 'b'] },
    { name: 'gptunnel', baseUrl: 'https://gt', apiKey: 'g', models: ['gpt-4o-mini'], authScheme: 'raw', jsonMode: true },
  ], fakeFetch((body, url) => {
    if (url.startsWith('https://or')) return { status: 502 };
    n++;
    if (n === 1) return reply({ hook: 'Хук один', title: 't', script: `[excited] Начало. ${words(120)}. [whispering] Артикул в описании.`, captions: [{ caption: 'Подпись А', hashtags: ['обзор'] }] });
    if (n === 2) return reply({ hook: 'Хук один', title: 't', script: `[excited] Начало. ${words(66)}. [whispering] Артикул в описании.`, captions: [] });
    return reply({ captions: [{ caption: 'Подпись Б', hashtags: ['#x'] }, { caption: 'Подпись В', hashtags: ['#y'] }] });
  }));
  const r = await writeScript(llm, { product: 'Пылесос X', style: 'review', seconds: 30, wps: 2.3, narrator: 'male', captionsCount: 3 });
  ok(r.provider === 'gptunnel', `fallback to gptunnel (got ${r.provider})`);
  ok(r.words >= 62 && r.words <= 75, `length corrected to ${r.words} (target ${r.targetWords})`);
  ok(r.captions.length === 3 && new Set(r.captions.map((c) => c.caption)).size === 3, `3 distinct captions: ${r.captions.map((c) => c.caption).join(' | ')}`);
  ok(r.captions[0].hashtags[0] === '#обзор', 'hashtags normalised with #');
  const sys = calls.find((c) => c.url.startsWith('https://gt'))!.body.messages[0].content as string;
  ok(sys.includes('мужчина'), 'male narrator rule in prompt');
  ok(!/плойк|локон/i.test(sys), 'prompt has no hair-styler leftovers');
  ok(calls.find((c) => c.url.startsWith('https://or'))!.body.models.length === 2, 'openrouter gets model list');
  ok(calls.find((c) => c.url.startsWith('https://gt'))!.body.response_format?.type === 'json_object', 'gptunnel json mode');

  // 2. Repeated hook → re-roll.
  calls.length = 0; n = 0;
  const llm2 = new LlmChain([{ name: 'openrouter', baseUrl: 'https://or', apiKey: 'k', models: ['a'] }], fakeFetch(() => {
    n++;
    const hook = n === 1 ? 'Вы точно делаете уборку неправильно' : 'Этот пылесос сам находит пыль';
    return reply({ hook, title: 't', script: `${hook}. ${words(64)}. Ссылка в описании.`, captions: [{ caption: 'c', hashtags: [] }] });
  }));
  const r2 = await writeScript(llm2, { product: 'Пылесос', style: 'hype', seconds: 30, wps: 2.3, avoidHooks: ['вы делаете уборку неправильно!'] });
  ok(r2.hook.startsWith('Этот пылесос'), `hook re-rolled → "${r2.hook}"`);
  ok(r2.notes.some((x) => x.includes('Хук')), 'note about hook regen');

  // 3. No providers: error vs template.
  const none = new LlmChain([{ name: 'openrouter', baseUrl: 'x', apiKey: '', models: ['a'] }]);
  let threw = false;
  try { await writeScript(none, { product: 'Наушники', style: 'blogger', seconds: 20 }); } catch (e) { threw = e instanceof LlmUnavailableError; }
  ok(threw, 'no provider + no template → LlmUnavailableError');
  const t = await writeScript(none, { product: 'Наушники', productInfo: 'Шумоподавление до 40 дБ. Работают 30 часов', style: 'blogger', seconds: 20, narrator: 'unknown', allowTemplate: true });
  ok(t.provider === 'template' && /Шумоподавление/.test(t.script) && !/локон|плойк|проверил|проверила/i.test(t.script), `template is product-agnostic: "${t.script}"`);
  const tf = templateScript({ product: 'Наушники', style: 'blogger', seconds: 20, narrator: 'female' }, { target: 40, wps: 2, notes: [] });
  ok(/проверила/.test(tf.script) && /оставила/.test(tf.script), 'template female grammar');

  // 4. Helpers.
  const long = 'Хук здесь. ' + Array.from({ length: 10 }, (_, i) => `Предложение номер ${i} с текстом.`).join(' ') + ' Артикул в описании.';
  const tm = trimMiddle(long, 20);
  ok(tm.startsWith('Хук здесь.') && tm.endsWith('Артикул в описании.') && countWords(tm) <= 20, `trimMiddle keeps hook+CTA (${countWords(tm)} words)`);
  ok(sanitizeForVoiceover('[Excited] Привет 🔥 [robot] **мир** https://x.y') === '[excited] Привет мир', `sanitize: "${sanitizeForVoiceover('[Excited] Привет 🔥 [robot] **мир** https://x.y')}"`);
  let tbl = observePace({}, 'v1', 1, 60, 30);
  tbl = observePace(tbl, 'v1', 1, 60, 20);
  ok(Math.abs(paceFor(tbl, 'v1', 1) - (2 * 0.7 + 3 * 0.3)) < 0.01, `pace EMA ${paceFor(tbl, 'v1', 1)}`);
  ok(Math.abs(paceFor(tbl, 'v1', 1.2) - paceFor(tbl, 'v1', 1) * 1.2) < 0.01, 'pace scales with speed');
})();
