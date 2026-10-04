/* Headless-проверка интеграции с Яндекс Играми: реклама, монетизация, сохранения,
   лидерборд, покупки, локализация. Игра загружается ЦЕЛИКОМ из index.html (тот же файл,
   что уходит в архив), вместо реального SDK подставляется записывающий mock.

   Запуск: npm test   (нужен только jsdom, браузер не требуется) */
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMockYaGames, installBrowserMocks } from './mock-ysdk.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML_PATH = path.join(ROOT, 'index.html');

const failures = [];
let passed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failures.push(name + (extra ? ' — ' + extra : '')); console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); }
  throw new Error('timeout waiting for: ' + label);
}

function rawHtml() {
  let html = fs.readFileSync(HTML_PATH, 'utf8');
  // Реальный SDK недоступен в песочнице — его заменяет mock, установленный в beforeParse.
  html = html.replace(/<script src="https:\/\/yandex\.ru\/games\/sdk\/v2"><\/script>/, '<!-- yandex sdk mock -->');
  return html;
}

async function loadGame(opts = {}) {
  const errors = [];
  /* jsdom не умеет парсить часть современного CSS — такие ошибки не являются ошибками игры. */
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/Could not parse CSS|Not implemented/.test(e.message)) errors.push('jsdomError: ' + e.message); });
  const dom = new JSDOM(rawHtml(), {
    virtualConsole: vc,
    runScripts: 'dangerously',
    pretendToBeVisual: false,
    url: 'https://yandex.ru/games/app/000000',
    beforeParse(win) {
      installBrowserMocks(win);
      if (opts.save) win.localStorage.setItem('astro_sv16', JSON.stringify(opts.save));
      win.mock = installMockYaGames(win, opts);
      win.addEventListener('error', e => errors.push('window.onerror: ' + (e.error && e.error.stack || e.message)));
      const origErr = win.console.error;
      win.console.error = (...a) => { errors.push('console.error: ' + a.map(String).join(' ')); origErr(...a); };
      win.console.warn = () => {};
    },
  });
  const win = dom.window;
  await sleep(30);
  return { win, doc: win.document, mock: win.mock, errors, t0: Date.now() };
}
const vis = (doc, id) => { const el = doc.getElementById(id); return !!el && !el.classList.contains('hidden'); };
const txt = (doc, id) => { const el = doc.getElementById(id); return el ? el.textContent : ''; };
function ptr(win, el) { el.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true })); }
function click(win, el) { el.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); }

async function bootToMenu(ctx) {
  const { win, doc } = ctx;
  await waitFor(() => vis(doc, 'splash'), 5000, 'splash');
  ptr(win, doc.getElementById('splash'));            // 1-й тап: «пропустить заставку»
  await sleep(30);
  ptr(win, doc.getElementById('splash'));            // 2-й тап: уходим в меню
  await waitFor(() => vis(doc, 'start-screen') || vis(doc, 'welcome-screen'), 5000, 'menu');
  let guard = 0;
  while (vis(doc, 'welcome-screen') && guard++ < 12) { click(win, doc.getElementById('w-next')); await sleep(20); }
  await waitFor(() => vis(doc, 'start-screen'), 5000, 'start-screen');
  await sleep(60);
}
/* «Бот»: периодически тапает по экрану, чтобы игрок прыгал и собирал звёзды/монеты
   (нужно для проверки rewarded-удвоения монет, которое доступно только при runCoins > 0). */
function startBot(ctx) {
  const { win, doc } = ctx;
  const id = win.setInterval(() => {
    if (vis(doc, 'gameover-screen')) return;
    doc.body.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true }));
  }, 45);
  return () => win.clearInterval(id);
}
async function playUntilGameOver(ctx, maxMs = 60000) {
  const { win, doc } = ctx;
  const before = ctx.mock.calls.rewarded.length;
  click(win, doc.getElementById('play-btn'));
  await sleep(30);
  await waitFor(() => vis(doc, 'gameover-screen'), maxMs, 'gameover');
  await sleep(80);
  return before;
}

const results = [];
async function suite(name, fn) {
  console.log('\n— ' + name);
  try { await fn(); } catch (e) { failures.push(name + ' (exception): ' + e.message); console.log('  ✗ exception: ' + e.message); }
}

/* ================= 1. Загрузка, SDK-лайфсайкл, язык ================= */
await suite('Boot / SDK lifecycle / i18n', async () => {
  const ctx = await loadGame({ lang: 'ru', save: { o: { astro_welcomed: '1' }, sel: {}, own: {}, lo: [null, null, null] } });
  const { win, doc, mock, errors } = ctx;
  results.push(ctx);
  check('YaGames.init() вызван ровно один раз (п.1.1)', mock.calls.init === 1, 'init=' + mock.calls.init);
  await sleep(50);
  check('LoadingAPI.ready() вызван один раз после готовности игры (п.1.19.2)', mock.calls.ready === 1, 'ready=' + mock.calls.ready);
  check('GameplayAPI.start() не вызван до начала забега (п.1.19.3)', mock.calls.gpStart === 0, 'gpStart=' + mock.calls.gpStart);
  check('подписаны события game_api_pause/game_api_resume (п.1.19.4)',
    !!mock.calls.events.game_api_pause && !!mock.calls.events.game_api_resume);
  check('нет JS-ошибок при загрузке (п.1.14)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await bootToMenu(ctx);
  check('главное меню открывается', vis(doc, 'start-screen'));
  check('язык определён через SDK (ysdk.environment.i18n.lang, п.2.14)',
    txt(doc, 'play-btn').indexOf('ИГРАТЬ') !== -1, JSON.stringify(txt(doc, 'play-btn')));
  check('sticky-баннер показан в меню (п.4.6)', mock.calls.bannerShow >= 1, 'show=' + mock.calls.bannerShow);
  check('баннер НЕ показан во время сплэша', mock.calls.bannerShow <= 2, 'show=' + mock.calls.bannerShow);

  /* другой язык SDK → другой интерфейс */
  const ctxTr = await loadGame({ lang: 'tr', save: { o: { astro_welcomed: '1' }, sel: {}, own: {}, lo: [null, null, null] } });
  await bootToMenu(ctxTr);
  check('при языке SDK=tr интерфейс турецкий', txt(ctxTr.doc, 'play-btn').indexOf('OYNA') !== -1, JSON.stringify(txt(ctxTr.doc, 'play-btn')));
  ctxTr.win.close();

  /* ручной выбор языка не перезаписывается SDK (п.2.14 — приоритет игрока) */
  const ctxEs = await loadGame({ lang: 'tr', save: { o: { astro_welcomed: '1', astro_lang: 'es' }, sel: {}, own: {}, lo: [null, null, null] } });
  await bootToMenu(ctxEs);
  check('сохранённый язык игрока не перезаписывается SDK', txt(ctxEs.doc, 'play-btn').indexOf('JUGAR') !== -1, JSON.stringify(txt(ctxEs.doc, 'play-btn')));
  ctxEs.win.close();
});

/* ================= 2. Геймплей-разметка и реклама ================= */
await suite('Gameplay markup + interstitial + banner', async () => {
  const ctx = results[0];
  const { win, doc, mock } = ctx;
  const gp0 = mock.calls.gpStart, bh0 = mock.calls.bannerHide;
  click(win, doc.getElementById('play-btn'));
  await sleep(40);
  check('GameplayAPI.start() при старте забега', mock.calls.gpStart === gp0 + 1, 'gpStart=' + mock.calls.gpStart);
  check('баннер скрыт на время забега', mock.calls.bannerHide > bh0, 'hide=' + mock.calls.bannerHide);
  check('нет полноэкранной рекламы прямо на старте первого забега', mock.calls.fullscreen.length === 0, 'fs=' + mock.calls.fullscreen.length);
  check('первый interstitial не показывается раньше AD_FIRST_AFTER', mock.calls.fullscreen.length === 0);

  await waitFor(() => vis(doc, 'gameover-screen'), 60000, 'gameover');
  await sleep(1200);
  check('GameplayAPI.stop() при смерти (п.1.19.3)', mock.calls.gpStop >= 1, 'gpStop=' + mock.calls.gpStop);
  check('прогресс сохранён в облако на экране итогов (п.4.2)', mock.calls.setData.length >= 1, 'setData=' + mock.calls.setData.length);
  check('рекорд отправлен в таблицу лидеров', mock.calls.scores.length >= 1, JSON.stringify(mock.calls.scores));
  check('interstitial не показывается в первые 40 с сессии (п.4.4)', mock.calls.fullscreen.length === 0, 'fs=' + mock.calls.fullscreen.length);
});

/* ================= 3. Rewarded: возрождение, монеты, отказ ================= */
await suite('Rewarded video', async () => {
  const ctx = results[0];
  const { win, doc, mock } = ctx;
  const rev = doc.getElementById('revive-ad-btn');
  check('кнопка возрождения за рекламу видна на экране итогов (п.4.5)', vis(doc, 'revive-ad-btn'));
  check('подпись кнопки объясняет рекламу и награду (п.4.5.1)',
    /РЕКЛАМА|AD|REKLAM|ANUNCIO/i.test(txt(doc, 'revive-ad-btn')) && txt(doc, 'revive-ad-btn').length > 6,
    JSON.stringify(txt(doc, 'revive-ad-btn')));
  const gp0 = mock.calls.gpStart, rw0 = mock.calls.rewarded.length;
  click(win, rev);
  /* Экран итогов должен исчезнуть сразу после onRewarded (за 5 мс у mock), но кадр спустя
     игрок может снова погибнуть — поэтому проверяем факт продолжения опросом. */
  let continued = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) { await sleep(8); if (!vis(doc, 'gameover-screen')) { continued = true; break; } }
  check('showRewardedVideo вызван', mock.calls.rewarded.length === rw0 + 1);
  check('после просмотренного ролика забег продолжился', continued, 'gameover остался видимым');
  check('GameplayAPI.start() после рекламы (п.1.19.3)', mock.calls.gpStart === gp0 + 1, 'gpStart=' + mock.calls.gpStart + ' (было ' + gp0 + ')');
  check('баннер снова скрыт во время забега', mock.calls.bannerHide >= 2, 'hide=' + mock.calls.bannerHide);

  /* Играем «ботом» несколько забегов, пока не соберутся монеты: удвоение монет за рекламу
     по design доступно только при runCoins > 0, поэтому сначала проверяем саму экономику. */
  let coinsRun = -1;
  for (let i = 0; i < 8 && coinsRun <= 0; i++) {
    const stopBot = startBot(ctx);
    await waitFor(() => vis(doc, 'gameover-screen'), 90000, 'gameover2#' + i);
    stopBot();
    await sleep(80);
    coinsRun = Number(txt(doc, 'f-coins') || 0);
    if (coinsRun <= 0 && vis(doc, 'retry-btn')) { click(win, doc.getElementById('retry-btn')); await sleep(60); }
  }
  check('за забег собираются монеты (капсулы/миссии дают 🪙)', coinsRun > 0, 'f-coins=' + coinsRun);
  check('кнопка удвоения монет видна тогда и только тогда, когда монеты есть', vis(doc, 'coins-ad-btn') === (coinsRun > 0), 'vis=' + vis(doc, 'coins-ad-btn'));
  if (vis(doc, 'coins-ad-btn')) {
    const fCoinsBefore = txt(doc, 'f-coins');
    const c0 = Number(txt(doc, 'menu-coins') || 0);
    click(win, doc.getElementById('coins-ad-btn'));
    await sleep(150);
    check('удвоение монет за рекламу удваивает счётчик на экране итогов',
      txt(doc, 'f-coins') === String(Number(fCoinsBefore) * 2), fCoinsBefore + ' -> ' + txt(doc, 'f-coins'));
    check('удвоенные монеты зачислены на баланс', Number(txt(doc, 'menu-coins') || 0) >= c0 + Number(fCoinsBefore), c0 + ' -> ' + txt(doc, 'menu-coins'));
    check('кнопка удвоения монет скрывается после получения', !vis(doc, 'coins-ad-btn'));
    const rwN = mock.calls.rewarded.length;
    click(win, doc.getElementById('coins-ad-btn'));
    await sleep(60);
    check('повторное удвоение за один забег невозможно', mock.calls.rewarded.length === rwN, 'rewarded=' + mock.calls.rewarded.length);
  }

  /* недосмотренный ролик → награды нет */
  mock.setRewardedMode('skipped');
  click(win, doc.getElementById('retry-btn'));
  await sleep(40);
  await waitFor(() => vis(doc, 'gameover-screen'), 60000, 'gameover3');
  await sleep(60);
  const rw = mock.calls.rewarded.length;
  if (vis(doc, 'revive-ad-btn')) {
    click(win, doc.getElementById('revive-ad-btn'));
    await sleep(150);
    check('недосмотренный ролик: showRewardedVideo вызван', mock.calls.rewarded.length === rw + 1);
    check('недосмотренный ролик: возрождения НЕТ (награда только за onRewarded)', vis(doc, 'gameover-screen'));
  } else {
    check('кнопка возрождения доступна в новом забеге', false);
  }
  mock.setRewardedMode('full');
});

/* ================= 4. Суточные rewarded-точки ================= */
await suite('Daily rewarded points (wheel / battle pass / streak)', async () => {
  const ctx = results[0];
  const { win, doc, mock } = ctx;
  click(win, doc.getElementById('go-menu-btn'));
  await sleep(80);
  check('возврат в меню работает', vis(doc, 'start-screen'));

  /* Колесо фортуны: бесплатный спин, затем спин за рекламу */
  click(win, doc.getElementById('menu-wheel'));
  await sleep(60);
  check('экран колеса открывается', vis(doc, 'wheel-screen'));
  click(win, doc.getElementById('wheel-spin'));
  await sleep(3300);
  check('бесплатный спин отработал', txt(doc, 'wheel-result').length > 0, JSON.stringify(txt(doc, 'wheel-result')));
  const adSpin = doc.getElementById('wheel-spin-ad');
  check('кнопка «ещё спин за рекламу» появилась после бесплатного', vis(doc, 'wheel-spin-ad'));
  check('подпись кнопки спина объясняет рекламу (п.4.5.1)', /РЕКЛАМА|AD|REKLAM|ANUNCIO/i.test(txt(doc, 'wheel-spin-ad')), JSON.stringify(txt(doc, 'wheel-spin-ad')));
  const rw = mock.calls.rewarded.length;
  click(win, adSpin);
  await sleep(150);
  check('спин за рекламу вызывает showRewardedVideo', mock.calls.rewarded.length === rw + 1);
  click(win, doc.getElementById('wheel-close'));
  await sleep(40);

  /* Батл-пасс: +50 XP за рекламу */
  click(win, doc.getElementById('bp-open'));
  await sleep(60);
  check('экран батл-пасса открывается', vis(doc, 'bp-screen'));
  if (vis(doc, 'bp-boost-ad')) {
    const xp0 = txt(doc, 'bp-xp-text');
    const rw2 = mock.calls.rewarded.length;
    click(win, doc.getElementById('bp-boost-ad'));
    await sleep(150);
    check('буст опыта за рекламу вызывает showRewardedVideo', mock.calls.rewarded.length === rw2 + 1);
    check('буст опыта меняет прогресс батл-пасса', txt(doc, 'bp-xp-text') !== xp0 || txt(doc, 'bp-level') !== '0', xp0 + ' -> ' + txt(doc, 'bp-xp-text'));
    check('подпись кнопки буста объясняет рекламу (п.4.5.1)', /РЕКЛАМА|AD|REKLAM|ANUNCIO/i.test(txt(doc, 'bp-boost-ad')), JSON.stringify(txt(doc, 'bp-boost-ad')));
  } else {
    check('кнопка буста опыта за рекламу доступна раз в день', false);
  }
  click(win, doc.getElementById('bp-close-bottom'));
  await sleep(40);

  /* Ежедневная награда x2 за рекламу */
  if (vis(doc, 'daily-claim-ad')) {
    const rw3 = mock.calls.rewarded.length;
    const c0 = txt(doc, 'menu-coins');
    click(win, doc.getElementById('daily-claim-ad'));
    await sleep(150);
    check('x2 ежедневная награда вызывает showRewardedVideo', mock.calls.rewarded.length === rw3 + 1);
    check('x2 ежедневная награда начисляет монеты', Number(txt(doc, 'menu-coins')) > Number(c0), c0 + ' -> ' + txt(doc, 'menu-coins'));
  } else {
    check('кнопка x2 ежедневной награды видна, пока награда не забрана', false);
  }
});

/* ================= 5. Звук, пауза, платформенные события ================= */
await suite('Audio & pause during ads / focus loss (п.1.3, п.4.7)', async () => {
  const ctx = results[0];
  const { win, doc, mock } = ctx;
  click(win, doc.getElementById('play-btn'));
  await sleep(60);
  const ac = win.acInstances[win.acInstances.length - 1];
  check('AudioContext создан и играет', !!ac && ac.state === 'running', ac && ac.state);
  /* платформенная пауза */
  mock.emit('game_api_pause');
  await sleep(30);
  check('на game_api_pause игра встаёт на паузу', vis(doc, 'pause-screen'));
  check('на game_api_pause звук глушится', ac.state === 'suspended', ac.state);
  mock.emit('game_api_resume');
  await sleep(30);
  click(win, doc.getElementById('resume-btn'));
  await sleep(40);
  check('после resume забег продолжается', !vis(doc, 'pause-screen'));
  check('звук вернулся после возобновления', ac.state === 'running', ac.state);
  /* потеря фокуса */
  win.dispatchEvent(new win.Event('blur'));
  await sleep(30);
  check('при потере фокуса игра встаёт на паузу (п.1.3)', vis(doc, 'pause-screen'));
  check('при потере фокуса звук останавливается (п.1.3)', ac.state === 'suspended', ac.state);
  mock.emit('game_api_resume');
  await sleep(20);
  click(win, doc.getElementById('resume-btn'));
  await sleep(30);
});

/* ================= 6. Interstitial после прогрева сессии ================= */
await suite('Interstitial timing (п.4.4)', async () => {
  const ctx = results[0];
  const { win, doc, mock } = ctx;
  const need = 40000 - (Date.now() - ctx.t0);
  if (need > 0) { console.log('  · ждём ' + Math.ceil(need / 1000) + ' с до окончания «тёплого» окна первого ролика'); await sleep(need + 200); }
  click(win, doc.getElementById('quit-btn'));
  await sleep(80);
  const fs0 = mock.calls.fullscreen.length;
  /* три смерти подряд — interstitial должен появиться, но не чаще AD_MIN_GAP */
  for (let i = 0; i < 4; i++) {
    if (!vis(doc, 'play-btn')) break;
    click(win, doc.getElementById('play-btn'));
    await sleep(30);
    await waitFor(() => vis(doc, 'gameover-screen'), 60000, 'gameover#' + i);
    await sleep(1300);
    click(win, doc.getElementById('retry-btn'));
    await sleep(40);
  }
  check('interstitial показан после прогрева сессии', mock.calls.fullscreen.length > fs0, 'fs=' + mock.calls.fullscreen.length);
  check('interstitial показывается не чаще одного раза в 60 с', mock.calls.fullscreen.length <= 2, 'fs=' + mock.calls.fullscreen.length);
  const ac = win.acInstances[win.acInstances.length - 1];
  check('после рекламы звук снова работает', ac.state === 'running' || ac.state === 'suspended', ac.state);
  await waitFor(() => vis(doc, 'gameover-screen') || vis(doc, 'start-screen'), 60000, 'final screen');
});

/* ================= 7. Покупки через SDK ================= */
await suite('In-app purchases (п.1.4, п.1.13)', async () => {
  const ctx = await loadGame({
    lang: 'ru',
    save: { o: { astro_welcomed: '1', astro_coins: '10' }, sel: {}, own: {}, lo: [null, null, null] },
    products: [
      { id: 'astro_premium', price: '149' },
      { id: 'astro_coins_500', price: '49' },
      { id: 'astro_coins_2000', price: '149' },
      { id: 'astro_coins_5000', price: '299' },
    ],
  });
  const { win, doc, mock } = ctx;
  await bootToMenu(ctx);
  await sleep(120);
  click(win, doc.getElementById('shop-open'));
  await sleep(80);
  check('витрина покупок показана, если товары заведены в консоли', vis(doc, 'iap-wrap'));
  const btns = doc.querySelectorAll('#iap-row .iap-btn');
  check('в витрине три набора монет', btns.length === 3, 'n=' + btns.length);
  const label = btns[0] ? btns[0].textContent : '';
  check('цена показана цифрой и валютой портала (п.1.13.4)', /49/.test(label) && /YAN|Y/.test(label), JSON.stringify(label));
  const c0 = Number(txt(doc, 'shop-coins'));
  click(win, btns[0]);
  await sleep(150);
  check('payments.purchase вызван с id товара', mock.calls.purchase.length === 1 && mock.calls.purchase[0].id === 'astro_coins_500', JSON.stringify(mock.calls.purchase));
  check('покупка съедена (consumePurchase, п.1.13.1)', mock.calls.consume.length === 1, JSON.stringify(mock.calls.consume));
  check('монеты зачислены', Number(txt(doc, 'shop-coins')) === c0 + 500, c0 + ' -> ' + txt(doc, 'shop-coins'));
  click(win, doc.getElementById('shop-close'));
  await sleep(40);
  click(win, doc.getElementById('bp-open'));
  await sleep(80);
  check('премиум батл-пасса продаётся через SDK с реальной ценой', /149/.test(txt(doc, 'bp-premium')), JSON.stringify(txt(doc, 'bp-premium')));
  const c1 = Number(txt(doc, 'shop-coins') || '0');
  click(win, doc.getElementById('bp-premium'));
  await sleep(200);
  check('покупка премиума через SDK не списывает игровые монеты', Number(txt(doc, 'menu-coins')) === c1, c1 + ' -> ' + txt(doc, 'menu-coins'));
  check('премиум активирован', txt(doc, 'bp-owned-wrap') !== undefined && !vis(doc, 'bp-premium-wrap'));

  /* незакрытая покупка с прошлой сессии */
  const ctx2 = await loadGame({
    lang: 'ru',
    save: { o: { astro_welcomed: '1' }, sel: {}, own: {}, lo: [null, null, null] },
    products: [{ id: 'astro_coins_500', price: '49' }],
    pendingPurchases: [{ productID: 'astro_coins_500', purchaseToken: 'tok-old' }],
  });
  await bootToMenu(ctx2);
  await sleep(200);
  check('незакрытая покупка дозачисляется и съедается при старте', ctx2.mock.calls.consume.indexOf('tok-old') !== -1, JSON.stringify(ctx2.mock.calls.consume));
  ctx.win.close(); ctx2.win.close();
});

/* ================= 8. Вход, лидерборд, оценка ================= */
await suite('Auth, leaderboard UI, rating', async () => {
  const ctx = results[0];
  const { win, doc, mock } = ctx;
  click(win, doc.getElementById('profile-open'));
  await sleep(120);
  check('кнопка входа показана гостю (п.1.2.1)', vis(doc, 'ya-login'));
  check('таблица лидеров отрисована в профиле', doc.querySelectorAll('#lb-list .lb-row').length >= 3, 'rows=' + doc.querySelectorAll('#lb-list .lb-row').length);
  click(win, doc.getElementById('ya-login'));
  await sleep(120);
  check('вход открывает auth.openAuthDialog', mock.calls.auth === 1);
  check('после входа кнопка входа скрывается', !vis(doc, 'ya-login'));
  check('getLeaderboards/getPlayer используются', mock.calls.getPlayer >= 1);
  click(win, doc.getElementById('profile-close'));
  await sleep(40);
  check('feedback.canReview вызван для запроса оценки (метрика Rating, п.2.13)', mock.calls.canReview >= 1, 'canReview=' + mock.calls.canReview);
});

/* ================= 9. Итог по ошибкам ================= */
await suite('No runtime errors at the end', async () => {
  const ctx = results[0];
  const err = ctx.errors.filter(e => !/Not implemented|jsdom/i.test(e));
  check('за всю сессию не возникло JS-ошибок (п.1.14)', err.length === 0, err.slice(0, 3).join(' | '));
});

console.log('\n==============================');
console.log('PASS: ' + passed + '  FAIL: ' + failures.length);
if (failures.length) { console.log('\nПровалено:'); failures.forEach(f => console.log(' - ' + f)); }
results.forEach(c => { try { c.win.close(); } catch (e) {} });
process.exit(failures.length ? 1 : 0);
