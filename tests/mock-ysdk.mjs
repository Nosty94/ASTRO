/* Mock Yandex Games SDK для headless-проверки интеграции (tests/*.test.mjs).
   Записывает все обращения игры к платформе, чтобы можно было проверить, что реклама
   и монетизация вызываются правильно и в правильные моменты. */
export function installMockYaGames(win, opts = {}) {
  const calls = {
    init: 0, ready: 0, gpStart: 0, gpStop: 0,
    fullscreen: [], rewarded: [], bannerShow: 0, bannerHide: 0,
    scores: [], setData: [], getData: 0, getPlayer: 0,
    purchase: [], consume: [], auth: 0, canReview: 0, requestReview: 0,
    events: {},
  };
  const store = {};
  let authed = !!opts.authorized;
  let rewardedMode = opts.rewardedMode || 'full';   // full | skipped | error
  let fullscreenMode = opts.fullscreenMode || 'ok'; // ok | error | offline | never

  const player = {
    setData(d) { calls.setData.push(d); Object.assign(store, d); return Promise.resolve(); },
    getData(keys) { calls.getData++; const out = {}; (keys || []).forEach(k => { if (store[k] !== undefined) out[k] = store[k]; }); return Promise.resolve(out); },
    isAuthorized() { return authed; },
    getName() { return 'Tester'; },
    getUniqueID() { return 'player-1'; },
    getPhoto() { return ''; },
    setStats() { return Promise.resolve(); },
    getStats() { return Promise.resolve({}); },
  };
  const lb = {
    setLeaderboardScore(n, s) { calls.scores.push({ name: n, score: s }); return Promise.resolve(); },
    getLeaderboardPlayerEntry() { return Promise.resolve({ rank: 42, score: 1234 }); },
    getLeaderboardEntries(n, o) {
      return Promise.resolve({
        ranges: [{ items: [
          { rank: 1, score: 9999, player: { publicName: 'Nova' } },
          { rank: 2, score: 5000, player: { publicName: 'Zed' } },
        ] }],
        userRank: 42,
      });
    },
  };
  const catalogProducts = (opts.products || []).map(p => Object.assign({ priceLabel: p.price + ' Y', currencyID: 'YAN' }, p));
  const catalog = {
    getProducts() { return catalogProducts; },
    getCurrencies() { return { currencyID: 'YAN' }; },
  };
  const payments = {
    getCatalog() { return Promise.resolve(catalog); },
    getPurchases() { return Promise.resolve(opts.pendingPurchases || []); },
    purchase(d) { calls.purchase.push(d); return Promise.resolve({ productID: d.id, purchaseToken: 'tok_' + d.id }); },
    consumePurchase(tok) { calls.consume.push(tok); return Promise.resolve(); },
  };
  const ysdk = {
    adv: {
      showFullscreenAdv(o) {
        calls.fullscreen.push(o);
        const cb = (o && o.callbacks) || {};
        if (fullscreenMode === 'error') { cb.onError && cb.onError({ code: 'NO_AD' }); return; }
        if (fullscreenMode === 'offline') { cb.onOffline && cb.onOffline(); return; }
        cb.onOpen && cb.onOpen();
        win.setTimeout(() => cb.onClose && cb.onClose(true), 5);
      },
      showRewardedVideo(o) {
        calls.rewarded.push(o);
        const cb = (o && o.callbacks) || {};
        if (rewardedMode === 'error') { cb.onError && cb.onError({ code: 'NO_AD' }); return; }
        cb.onOpen && cb.onOpen();
        win.setTimeout(() => {
          if (rewardedMode === 'full') cb.onRewarded && cb.onRewarded();
          cb.onClose && cb.onClose(true);
        }, 5);
      },
      showBannerAdv() { calls.bannerShow++; },
      hideBannerAdv() { calls.bannerHide++; },
    },
    features: {
      LoadingAPI: { ready() { calls.ready++; } },
      GameplayAPI: { start() { calls.gpStart++; }, stop() { calls.gpStop++; } },
    },
    environment: { i18n: { lang: opts.lang || 'ru', tld: 'ru' }, app: { id: 'test' }, browser: { lang: opts.lang || 'ru' } },
    getLeaderboards() { return Promise.resolve(lb); },
    getPlayer() { calls.getPlayer++; return Promise.resolve(player); },
    getPayments() { return opts.noPayments ? Promise.reject(new Error('no payments')) : Promise.resolve(payments); },
    auth: { openAuthDialog() { calls.auth++; authed = true; return Promise.resolve(); } },
    feedback: {
      canReview() { calls.canReview++; return Promise.resolve({ value: true, reason: '' }); },
      requestReview() { calls.requestReview++; return Promise.resolve({ feedbackSent: true }); },
    },
    on(ev, fn) { (calls.events[ev] = calls.events[ev] || []).push(fn); },
    off() {},
    getServerTime() { return Promise.resolve(Date.now()); },
    shortcut: { canShowPrompt() { return Promise.resolve({ canShow: false }); }, showPrompt() { return Promise.resolve({ outcome: 'rejected' }); } },
  };
  win.YaGames = { init() { calls.init++; return Promise.resolve(ysdk); } };
  return {
    calls, ysdk, store,
    setRewardedMode: m => { rewardedMode = m; },
    setFullscreenMode: m => { fullscreenMode = m; },
    isAuthorized: () => authed,
    emit(ev, arg) { (calls.events[ev] || []).forEach(f => f(arg)); },
  };
}

/* Минимальные заглушки браузерных API, которых нет в jsdom, но которые использует игра. */
export function installBrowserMocks(win) {
  const grad = () => ({ addColorStop() {} });
  const ctxStub = new Proxy({}, {
    get(_t, k) {
      if (k === 'canvas') return { width: 360, height: 640 };
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createConicGradient') return grad;
      if (k === 'createPattern') return () => null;
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (k === 'createImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (typeof k === 'string' && k.startsWith('_')) return undefined;
      return () => {};
    },
    set() { return true; },
  });
  win.HTMLCanvasElement.prototype.getContext = function () { return ctxStub; };
  class FakeAudioContext {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; this.sampleRate = 44100; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createOscillator() { return { type: 'sine', frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {}, start() {}, stop() {} }; }
    createGain() { return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    createBiquadFilter() { return { frequency: { value: 0 }, connect() {}, disconnect() {} }; }
  }
  win.AudioContext = FakeAudioContext;
  win.webkitAudioContext = FakeAudioContext;
  win.acInstances = [];
  const RealAC = win.AudioContext;
  win.AudioContext = class extends RealAC { constructor() { super(); win.acInstances.push(this); } };
  if (!win.matchMedia) win.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  /* Ускоренная прокачка кадров: игра считает dt по timestamp из requestAnimationFrame,
     поэтому подменяем его на синтетический и крутим кадры через setTimeout(0). */
  let vt = 0;
  win.__frames = 0;
  win.requestAnimationFrame = cb => win.setTimeout(() => { vt += 100; win.__frames++; try { cb(vt); } catch (e) { win.__rafError = e; } }, 0);
  win.cancelAnimationFrame = id => win.clearTimeout(id);
}
