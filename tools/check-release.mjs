/* Статический релиз-гейт для Яндекс Игр.
   Проверяет index.html на соответствие требованиям платформы (technical / UX / ad),
   полноту локализации и корректность подписей rewarded-кнопок.
   Запуск: npm run check */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(ROOT, 'index.html');
const src = fs.readFileSync(HTML, 'utf8');
const problems = [];
const notes = [];
let passed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { problems.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function has(re) { return re.test(src); }

console.log('\n== АРХИВ И ФАЙЛЫ (п.1.21, п.1.22) ==');
const files = fs.readdirSync(ROOT, { withFileTypes: true }).filter(e => !['.git', 'node_modules', 'dist', '.arena'].includes(e.name)).map(e => e.name);
const badNames = files.filter(n => /[^A-Za-z0-9._-]/.test(n));
check('имена файлов без пробелов и кириллицы', badNames.length === 0, badNames.join(', '));
check('index.html лежит в корне архива', fs.existsSync(HTML));
const size = fs.statSync(HTML).size;
check('размер игры < 100 МБ (реально ' + (size / 1024).toFixed(0) + ' КБ)', size < 100 * 1024 * 1024);

console.log('\n== SDK И ЖИЗНЕННЫЙ ЦИКЛ (п.1.1, п.1.19) ==');
check('подключён официальный SDK', /<script src="https:\/\/yandex\.ru\/games\/sdk\/v2"><\/script>/.test(src));
check('инициализация через YaGames.init()', /YaGames\.init\(\)/.test(src));
check('Game Ready: LoadingAPI.ready()', /LoadingAPI\.ready\(\)/.test(src));
check('GameplayAPI.start() / stop()', /GameplayAPI\.start\(\)/.test(src) && /GameplayAPI\.stop\(\)/.test(src));
check('события game_api_pause / game_api_resume (п.1.19.4)', /game_api_pause/.test(src) && /game_api_resume/.test(src));
check('язык берётся из ysdk.environment.i18n.lang (п.2.14)', /environment\.i18n\.lang|environment&&s\.environment\.i18n/.test(src));

console.log('\n== РЕКЛАМА (п.1.12, п.4.1–4.7) ==');
check('interstitial через SDK (п.4.1)', /adv\.showFullscreenAdv/.test(src));
check('rewarded через SDK (п.4.1)', /adv\.showRewardedVideo/.test(src));
check('только sticky-баннер платформы (п.4.6)', /adv\.showBannerAdv/.test(src) && /adv\.hideBannerAdv/.test(src));
check('нет setInterval-показа рекламы (пример недопустимого вызова из доков)', !/setInterval\([^)]*showFullscreenAdv/.test(src));
check('звук глушится на время рекламы (п.4.7)', /function adMute\(\)\{[^}]*suspend\(\)/.test(src));
check('звук останавливается при потере фокуса (п.1.3)', /addEventListener\('blur'/.test(src) && /visibilitychange/.test(src));
check('прогресс сохраняется перед рекламой (п.4.2)', /hideAdBanner\(\);saveNow\(\);gpStop\(\);adMute\(\)/.test(src));
check('у interstitial есть троттлинг', /AD_MIN_GAP/.test(src) && /AD_FIRST_AFTER/.test(src));
check('rewarded-награда выдаётся только по onRewarded', /onRewarded:function\(\)\{rewarded=true;\}/.test(src));
check('нет сторонних рекламных SDK', !/(googlesyndication|adsbygoogle|applovin|unityads|ironsource|adcolony)/i.test(src));

console.log('\n== СОХРАНЕНИЯ И ДАННЫЕ (п.1.9, п.1.11) ==');
check('прогресс пишется в localStorage сразу после действия', /function commit\(d\)\{try\{localStorage\.setItem/.test(src));
check('облачные сохранения через Player.setData/getData', /setData\(\{astro_cloud/.test(src) && /getData\(\['astro_cloud'\]/.test(src));
check('сохранение при уходе со страницы', /pagehide/.test(src));

console.log('\n== ПОКУПКИ (п.1.4, п.1.13) ==');
check('покупки только через SDK (getPayments/purchase/consumePurchase)', /getPayments/.test(src) && /\.purchase\(\{id:id\}\)/.test(src) && /consumePurchase/.test(src));
check('витрина показывается только при наличии товаров в каталоге', /iapProduct/.test(src) && /getProducts\(\)/.test(src));
check('нет внешних платёжных систем', !/(paypal|stripe\.com|checkout\.js)/i.test(src));

console.log('\n== ИНТЕРФЕЙС И КОНТЕНТ (п.1.6, п.1.10) ==');
check('контекстное меню отключено (п.1.6.1.8/1.6.2.7)', /contextmenu',e=>e\.preventDefault\(\)/.test(src));
check('нет выделения текста долгим тапом', /user-select:none/.test(src));
check('нет ссылок на внешние ресурсы (п.8.4.2)', !/<a\s[^>]*href="https?:/i.test(src) && !/window\.open\(/.test(src));
check('нет navigator.share со ссылкой наружу', !/navigator\.share\(\{[^}]*url:/i.test(src));
check('заголовок вкладки = название игры', /<title>ASTRO HOP<\/title>/.test(src) && /cabinet-label">ASTRO HOP</.test(src));
check('в названии нет слов «бесплатно/лучшая/top» (п.8.2.2)', !/бесплатн|лучшая игра|\btop game\b|best game/i.test(src.match(/<title>[^<]*<\/title>/)[0]));

/* ---------- Локализация ---------- */
console.log('\n== ЛОКАЛИЗАЦИЯ (п.2.14, п.8.2.3) ==');
/* Словари собираются честным разбором исходника: литерал I18N и все Object.assign(I18N.xx,{...}). */
function sliceObject(text, fromIdx) {
  let i = text.indexOf('{', fromIdx), depth = 0, inStr = null;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (inStr) { if (c === '\\') { j++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(i, j + 1); }
  }
  return '';
}
const LANGS = ['en', 'ru', 'tr', 'es'];
const dict = { en: {}, ru: {}, tr: {}, es: {} };
const lit = txt => new Function('return ' + txt)();
{
  const i18nAt = src.indexOf('const I18N={');
  const base = lit(sliceObject(src, i18nAt));
  LANGS.forEach(l => Object.assign(dict[l], base[l] || {}));
  const reA = /Object\.assign\(I18N\.(en|ru|tr|es),/g;
  let m;
  while ((m = reA.exec(src))) Object.assign(dict[m[1]], lit(sliceObject(src, m.index + m[0].length - 1)));
}
const used = new Set();
for (const m of src.matchAll(/\btf?\(\s*'([A-Za-z0-9_]+)'\s*[,)]/g)) used.add(m[1]);
for (const m of src.matchAll(/data-i18n="([A-Za-z0-9_]+)"/g)) used.add(m[1]);
const missing = {};
LANGS.forEach(l => missing[l] = [...used].filter(k => !(k in dict[l])));
check('все используемые ключи переведены на 4 языка',
  LANGS.every(l => missing[l].length === 0),
  LANGS.map(l => l + ' → ' + missing[l].join(', ')).filter(x => !x.endsWith('→ ')).join(' | '));
const allKeys = new Set(LANGS.flatMap(l => Object.keys(dict[l])));
const partial = [...allKeys].filter(k => LANGS.some(l => !(k in dict[l])));
check('нет ключей, которые есть не во всех языках', partial.length === 0, partial.slice(0, 20).join(', '));
const emptyVals = LANGS.flatMap(l => Object.keys(dict[l]).filter(k => !String(dict[l][k]).trim()).map(k => l + ':' + k));
check('нет пустых переводов', emptyVals.length === 0, emptyVals.slice(0, 10).join(', '));
console.log('  · ключей в словарях: ' + LANGS.map(l => l + '=' + Object.keys(dict[l]).length).join(' ') + ', используется: ' + used.size);

/* ---------- Подписи rewarded-кнопок (п.4.5.1) ---------- */
console.log('\n== ПОДПИСИ REWARDED-КНОПОК (п.4.5.1) ==');
const AD_KEYS = ['reviveAd', 'reviveAdBoss', 'coinsAd', 'wheelAdSpin', 'bpBoostAd', 'streakFreezeBtn', 'rerollBtn'];
const AD_MARK = { en: /AD|WATCH/i, ru: /РЕКЛАМ/i, tr: /REKLAM/i, es: /ANUNCIO/i };
AD_KEYS.forEach(k => {
  const bad = LANGS.filter(l => { const v = dict[l][k]; return !v || !AD_MARK[l].test(v) || v.indexOf('🎬') === -1; });
  check('«' + k + '» объясняет просмотр ролика на всех языках', bad.length === 0,
    bad.map(l => l + '=' + JSON.stringify(dict[l][k])).join(', '));
});

console.log('\n== КАРТОЧКА ИГРЫ: ИКОНКА (п.8.3) ==');
{
  const ip = path.join(ROOT, 'assets', 'yandex', 'icon-512.png');
  if (!fs.existsSync(ip)) { check('иконка 512×512 для консоли создана (npm run assets)', false, 'нет assets/yandex/icon-512.png'); }
  else {
    const b = fs.readFileSync(ip);
    let pos = 8, w = 0, h = 0, ct = 0;
    while (pos < b.length) { const len = b.readUInt32BE(pos), t = b.toString('ascii', pos + 4, pos + 8);
      if (t === 'IHDR') { w = b.readUInt32BE(pos + 8); h = b.readUInt32BE(pos + 12); ct = b[pos + 8 + 9]; }
      pos += 12 + len; }
    check('иконка 512×512 для консоли создана', w === 512 && h === 512, w + 'x' + h);
    check('иконка без альфы (нет скруглений/прозрачных углов, п.8.3.3)', ct === 2, 'colortype=' + ct);
  }
}

console.log('\n== ПРОИЗВОДИТЕЛЬНОСТЬ (п.1.15 — нет фризов) ==');
{
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('нет mix-blend-mode поверх canvas (причина лагов)', !/mix-blend-mode\s*:/.test(noComments));
  check('нет backdrop-filter (дорогой композитинг в меню/оверлеях)', !/backdrop-filter\s*:/.test(noComments));
  check('есть снижение масштаба рендера в PERFORMANCE', /function setRenderScale\(\)/.test(src) && /RS=perfMode\?1:DPR/.test(src));
  check('есть класс lowfx, отключающий декоративные слои', /body\.lowfx \.scanlines/.test(src) && /function applyFxClass\(\)/.test(src));
  check('нет живого ctx.shadowBlur в основном рендере', !/shadowBlur=approaching/.test(src) && !/shadowBlur=18/.test(src));
  check('авто-включение PERFORMANCE на слабых устройствах', /navigator\.deviceMemory/.test(src));
  check('градиенты неба/земли кэшируются (не каждый кадр)', /_skyKey!==_skyKey|skyKey!==_skyKey/.test(src) && /hgKey!==_hgKey/.test(src));
  check('FPS-метр: тумблер в настройках + обработчик', /id="fps-toggle"/.test(src) && /\$\('fps-toggle'\)\.onclick/.test(src));
  check('FPS-метр: HUD-элемент + ключ локали fpsMeter', /id="fps-hud"/.test(src) && /data-i18n="fpsMeter"/.test(src));
  check('вступительный экран: слои глубины (туманность/планета/2 слоя звёзд)', /class="s-nebula"/.test(src) && /class="s-planet"/.test(src) && /class="s-stars2"/.test(src));
  { const nc = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    check('вступительный экран: без backdrop-filter/mix-blend-mode', !/backdrop-filter\s*:/.test(nc) && !/mix-blend-mode\s*:/.test(nc)); }
}

console.log('\n== ЧИСТОТА КОДА (рекомендация 6.4) ==');
check('нет debugger', !/\bdebugger\b/.test(src));
const logs = (src.match(/console\.log\(/g) || []).length;
check('нет console.log в проде', logs === 0, 'найдено: ' + logs);
check('нет незакрытых TODO/FIXME в пользовательских строках', !/TODO:|FIXME:/i.test(src));

console.log('\n==============================');
console.log('PASS: ' + passed + '  FAIL: ' + problems.length);
if (problems.length) { console.log('\nНужно исправить:'); problems.forEach(p => console.log(' - ' + p)); }
process.exit(problems.length ? 1 : 0);
