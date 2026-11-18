/* =============================================================================
 * i18n.js — 《提灯者》界面文案（中文 / English）
 * -----------------------------------------------------------------------------
 * 所有玩家可见的文字都在这里，游戏逻辑不读写语言。
 * 用法：
 *   I18n.t('fragments', 2)        // 取一条文案（可带参数）
 *   I18n.setLang('en')            // 切换语言，自动更新页面与游戏覆盖层
 *   I18n.onChange(fn)             // 语言变化时通知游戏层重绘动态面板
 * 静态文本在 HTML 上标 data-i18n / data-i18n-html / data-i18n-aria。
 * 语言偏好存 localStorage（file:// 下不可用时自动降级，不影响游戏）。
 * ========================================================================== */

(function (global) {
  'use strict';

  const DICT = {
    zh: {
      htmlLang: 'zh-CN',
      title: '提灯者 · The Lantern Bearer',
      brandMain: '提灯者',
      brandSub: 'THE LANTERN BEARER',
      stage: n => `Stage ${n}`,
      fragments: n => `碎片 ${n}/3`,
      levelTime: t => `本关 ${t}`,
      totalTime: t => `总计 ${t}`,

      startTitle: '提灯者',
      startSub: 'THE LANTERN BEARER',
      startBody: '移动鼠标，本体会拖着自己缓慢追上光晕。<br>只有光能照出墙，也只有光能冻结暗影。<br>找齐三枚碎片，走进右下角的大门。',
      startBtn: '开始探索',
      startTip: '零点击操作 · 仅靠移动鼠标',
      foot: '鼠标移动 = 视线　·　R = 重试当前关',
      canvasLabel: '提灯者游戏画面',

      loseResult: '光灭了',
      loseDetail: t => `本关用时 ${t}`,
      retryWaiting: '1.5 秒后可重试',
      retryReady: '重开本关（R）',
      loseTip: '重开当前关 · 已拾取的碎片会重置',

      winLast: '你走出了黑暗',
      winNormal: '大门已开启',
      winDetail: (a, b) => `本关 ${a}　·　累计 ${b}`,
      winTipLast: '三关完成',
      winTipNext: name => `下一关：${name}`,
      btnRetry: '再来一遍',
      btnRestart: '从头开始',
      btnNext: '下一关',
    },

    en: {
      htmlLang: 'en',
      title: 'The Lantern Bearer · 提灯者',
      brandMain: 'THE LANTERN BEARER',
      brandSub: 'A TALE OF LIGHT AND SHADOW',
      stage: n => `Stage ${n}`,
      fragments: n => `Fragments ${n}/3`,
      levelTime: t => `Level ${t}`,
      totalTime: t => `Total ${t}`,

      startTitle: 'The Lantern Bearer',
      startSub: 'A TALE OF LIGHT AND SHADOW',
      startBody: 'Move the mouse — the old man follows the light at his own pace.<br>Only light reveals the walls, and only light can freeze the dark.<br>Gather three fragments, then step through the gate in the lower right.',
      startBtn: 'Start Exploring',
      startTip: 'No clicks — just move your mouse',
      foot: 'Mouse = your gaze　·　R = retry current level',
      canvasLabel: 'The Lantern Bearer game screen',

      loseResult: 'The light went out',
      loseDetail: t => `Level time ${t}`,
      retryWaiting: 'Retry in 1.5s',
      retryReady: 'Retry level (R)',
      loseTip: 'Restart this level · collected fragments will reset',

      winLast: 'You walked out of the dark',
      winNormal: 'The gate is open',
      winDetail: (a, b) => `Level ${a}　·　Total ${b}`,
      winTipLast: 'All three stages complete',
      winTipNext: name => `Next: ${name}`,
      btnRetry: 'Try again',
      btnRestart: 'From the start',
      btnNext: 'Next stage',
    },
  };

  let lang = 'zh';
  try {
    const saved = global.localStorage && global.localStorage.getItem('lantern-lang');
    if (saved === 'en' || saved === 'zh') lang = saved;
  } catch (e) { /* file:// 隐私模式下不可用，忽略 */ }

  const listeners = [];

  function t(key) {
    const entry = DICT[lang][key];
    if (typeof entry === 'function') return entry.apply(null, Array.prototype.slice.call(arguments, 1));
    return entry === undefined ? key : entry;
  }

  // 只更新静态标记过的元素；动态覆盖层由 game.js 的 onChange 回调重绘。
  function apply(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return;
    doc.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    doc.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
    doc.querySelectorAll('[data-i18n-aria]').forEach(el => {
      el.setAttribute('aria-label', t(el.dataset.i18nAria));
    });
    doc.querySelectorAll('[data-lang]').forEach(btn => {
      if (btn.classList && typeof btn.classList.toggle === 'function') {
        btn.classList.toggle('active', btn.dataset.lang === lang);
      }
    });
    if (doc.documentElement) doc.documentElement.lang = DICT[lang].htmlLang;
    if ('title' in doc) doc.title = t('title');
  }

  function setLang(next) {
    if (!DICT[next] || next === lang) return;
    lang = next;
    try {
      if (global.localStorage) global.localStorage.setItem('lantern-lang', lang);
    } catch (e) { /* 同上 */ }
    apply(global.document);
    listeners.forEach(fn => { try { fn(lang); } catch (e) { console.error(e); } });
  }

  // 页面上的 [data-lang] 按钮：点一下就切，无需额外配置。
  function bindButtons(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return;
    doc.querySelectorAll('[data-lang]').forEach(btn => {
      btn.addEventListener('click', () => setLang(btn.dataset.lang));
    });
  }

  global.I18n = {
    t,
    getLang: () => lang,
    setLang,
    apply,
    onChange: fn => listeners.push(fn),
  };

  if (typeof document !== 'undefined') {
    bindButtons(document);
    apply(document);
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
