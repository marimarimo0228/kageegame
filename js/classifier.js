// js/classifier.js — Teachable Machine 3クラス分類
// クラス: dog | bird | crab
// モデルファイル: models/model.json, models/metadata.json

// ── ラベルマッピング ───────────────────────────────────────────
// metadata.json の labels 配列の順番と異なる場合はここを修正する。
// 例: 学習時に bird → crab → dog の順で作った場合
//   'Class 1': 'bird', 'Class 2': 'crab', 'Class 3': 'dog'
//
// metadata.json を直接書き換えた場合（現在の設定）はこのマップは使われない。
// モデルが返すクラス名が既に dog/bird/crab であれば LABEL_MAP は不要。 
const LABEL_MAP = {
  'Class 1': 'dog',
  'Class 2': 'bird',
  'Class 3': 'crab',
};

let model    = null;
let _loading = false;   // 二重ロード防止フラグ

/**
 * Teachable Machine モデルを読み込む。
 * 二重呼び出し・無限ハング防止のため排他制御 + 30秒タイムアウト付き。
 */
async function loadModel() {
  if (model !== null) return;   // 読み込み済み
  if (_loading)       return;   // 読み込み中
  _loading = true;

  if (typeof tmImage === 'undefined') {
    console.error('[classifier] Teachable Machine ライブラリが読み込まれていません。CDN の読み込みを確認してください。');
    _loading = false;
    return;
  }
  console.log('[classifier] モデル読み込み開始...');
  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('30秒タイムアウト')), 30_000)
    );
    model = await Promise.race([
      tmImage.load('models/model.json', 'models/metadata.json'),
      timeout,
    ]);
    const labels = model.getClassLabels ? model.getClassLabels() : '(取得不可)';
    console.log('[classifier] モデル読み込み完了 / クラスラベル:', labels);
  } catch (err) {
    console.error(
      '[classifier] モデルの読み込みに失敗しました。\n' +
      '  → file:// で開いている場合は HTTP サーバー経由で起動してください。\n' +
      '    例: npx http-server .\n' +
      '  エラー詳細:', err
    );
    model = null;
  } finally {
    _loading = false;
  }
}

/** モデルが正常に読み込まれているか返す */
function isModelLoaded() {
  return model !== null;
}

/**
 * 全クラスの予測確率を返す。確率バー表示などに使用する。
 * @param {HTMLVideoElement} videoEl
 * @returns {Promise<[{className: string, probability: number}]>}
 */
async function getPredictions(imageEl) {
  if (!model) {
    console.warn('[classifier] モデル未読込のためスキップ。loadModel() が成功しているか確認してください。');
    return [];
  }
  if (!imageEl) return [];
  try {
    const raw = await model.predict(imageEl);
    // metadata.json に正しいラベルが入っていれば変換は素通りする
    return raw.map(p => ({
      className:   LABEL_MAP[p.className] ?? p.className,
      probability: p.probability,
    }));
  } catch (err) {
    console.error('[classifier] predict() 失敗:', err);
    return [];
  }
}

/**
 * currentPose クラスの確率を 0〜100 に変換して返す。
 * @param {HTMLVideoElement} videoEl
 * @param {string} currentPose  "dog" | "bird" | "crab"
 * @returns {Promise<number>}
 */
async function calcScore(videoEl, currentPose) {
  const preds = await getPredictions(videoEl);
  const match = preds.find(p => p.className === currentPose);
  return match ? Math.round(match.probability * 100) : 0;
}

window.ClassifierModule = { loadModel, isModelLoaded, calcScore, getPredictions };
//mame