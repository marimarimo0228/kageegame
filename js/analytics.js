// js/analytics.js — Google Analytics (GA4) への計測イベント送信を管理するモジュール
//
// 使い方: GA_MEASUREMENT_ID に GA4 の測定ID（G-XXXXXXXXXX 形式）を設定すると有効になる。
// 測定IDが未設定（プレースホルダーのまま）の間は一切通信せず、安全に無効化された状態で動く。
// 測定IDは https://analytics.google.com でプロパティを作成すると発行される。

const GA_MEASUREMENT_ID = 'G-308S662P03';

let _gaReady = false;

/** 測定IDがプレースホルダーから書き換えられているかどうか。 */
function _isConfigured() {
  return /^G-[A-Z0-9]+$/.test(GA_MEASUREMENT_ID) && GA_MEASUREMENT_ID !== 'G-XXXXXXXXXX';
}

/** gtag.js を動的に読み込み GA4 を初期化する。測定ID未設定なら何もしない。 */
function init() {
  if (!_isConfigured()) {
    console.info('[analytics] GA_MEASUREMENT_ID が未設定のため計測は無効です（js/analytics.js を編集してください）。');
    return;
  }

  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', GA_MEASUREMENT_ID);

  const script = document.createElement('script');
  script.async = true;
  script.src   = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
  document.head.appendChild(script);

  _gaReady = true;
}

/**
 * カスタムイベントを送信する。GA4未設定時は何もしない（呼び出し側は常に安全に呼べる）。
 * @param {string} name     GA4のイベント名（例: 'stage_start'）
 * @param {object} [params] イベントパラメータ
 */
function trackEvent(name, params = {}) {
  if (!_gaReady || typeof window.gtag !== 'function') return;
  window.gtag('event', name, params);
}

init();

// グローバルスコープへ公開（ES Module 非対応環境向け）
window.AnalyticsModule = { trackEvent };
