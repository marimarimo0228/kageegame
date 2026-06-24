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

// ── シルエット照合スコア ───────────────────────────────────────────

const ASPECT_RATIO_LIMITS = {
  bird: { min: 0.8, max: 1.4 },
  crab: { min: 1.0, max: 1.8 },
  dog:  { min: 0.6, max: 1.2 },
};

let silhouetteTemplates = null;
let _lastPredictions    = [];

// 正規化ベクトルのx成分を反転（左右ミラー）
// vec = [x0,y0, x1,y1, ...] → [-x0,y0, -x1,y1, ...]
function _flipVec(vec) {
  return vec.map((v, i) => i % 2 === 0 ? -v : v);
}

// 骨格ベクトルをミラー込みで比較し最高スコアを返す（1手用）
function _calcSkelWithMirror1(lm, vec) {
  const { calcScore7 } = window.PoseExtractorModule;
  return Math.max(calcScore7(lm, vec), calcScore7(lm, _flipVec(vec)));
}

// 骨格ベクトルをミラー込みで比較し最高スコアを返す（2手用）
// 手の組み合わせ(2通り) × ミラー(2通り) = 4通りの最大値
function _calcSkelWithMirror2(lm0, lm1, vec0, vec1) {
  const { calcScore7 } = window.PoseExtractorModule;
  const f0 = _flipVec(vec0), f1 = _flipVec(vec1);
  const sA  = (calcScore7(lm0, vec0) + calcScore7(lm1, vec1)) / 2;
  const sB  = (calcScore7(lm0, vec1) + calcScore7(lm1, vec0)) / 2;
  const sAf = (calcScore7(lm0, f0)   + calcScore7(lm1, f1))   / 2;
  const sBf = (calcScore7(lm0, f1)   + calcScore7(lm1, f0))   / 2;
  return Math.max(sA, sB, sAf, sBf);
}

async function _loadAndBinarize(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width  = 128;
      canvas.height = 128;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, 128, 128);
      const { data } = ctx.getImageData(0, 0, 128, 128);
      const pixels = new Uint8Array(128 * 128);
      for (let i = 0; i < pixels.length; i++) {
        const gray = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000;
        pixels[i] = gray >= 128 ? 1 : 0;
      }
      resolve(pixels);
    };
    img.onerror = () => reject(new Error(`load failed: ${src}`));
    img.src = src;
  });
}

async function loadSilhouetteTemplates() {
  const entries = [
    { name: 'bird', fileA: 'assets/silhouettes/bird.jpg',  fileB: 'assets/silhouettes/bird-a.png' },
    { name: 'crab', fileA: 'assets/silhouettes/crab.jpg',  fileB: 'assets/silhouettes/crab-a.png' },
    { name: 'dog',  fileA: 'assets/silhouettes/dog.jpg',   fileB: 'assets/silhouettes/dog-a.png'  },
  ];
  const result = {};
  await Promise.all(
    entries.map(async ({ name, fileA, fileB }) => {
      try {
        const [a, b] = await Promise.all([_loadAndBinarize(fileA), _loadAndBinarize(fileB)]);
        result[name] = { a, b };
      } catch (err) {
        console.warn(`[classifier] シルエットテンプレート読み込み失敗 (${name}):`, err);
        result[name] = { a: null, b: null };
      }
    })
  );
  silhouetteTemplates = result;
  console.log('[classifier] シルエットテンプレート読み込み完了:', Object.keys(result));
  return result;
}

function getBoundingBox(landmarks, videoW, videoH, currentPose, padding = 40) {
  if (!landmarks || landmarks.length === 0) {
    return { x: 0, y: 0, w: videoW, h: videoH };
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const handLandmarks of landmarks) {
    if (!handLandmarks) continue;
    for (const lm of handLandmarks) {
      const px = lm.x * videoW;
      const py = lm.y * videoH;
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
  }

  minX -= padding;
  minY -= padding;
  maxX += padding;
  maxY += padding;

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  let w = maxX - minX;
  let h = maxY - minY;

  // 縦横比制限を適用（中心固定で幅または高さを拡張）
  const limits = ASPECT_RATIO_LIMITS[currentPose];
  if (limits && w > 0 && h > 0) {
    const ratio = w / h;
    if (ratio < limits.min) {
      w = h * limits.min;
    } else if (ratio > limits.max) {
      h = w / limits.max;
    }
  }

  let x = cx - w / 2;
  let y = cy - h / 2;

  x = Math.max(0, x);
  y = Math.max(0, y);
  if (x + w > videoW) w = videoW - x;
  if (y + h > videoH) h = videoH - y;

  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

function extractAndBinarize(videoCanvas, bbox) {
  const { x, y, w, h } = bbox;
  const tmp = document.createElement('canvas');
  tmp.width  = 128;
  tmp.height = 128;
  const ctx = tmp.getContext('2d');
  ctx.drawImage(videoCanvas, x, y, w, h, 0, 0, 128, 128);
  const { data } = ctx.getImageData(0, 0, 128, 128);
  const pixels = new Uint8Array(128 * 128);
  for (let i = 0; i < pixels.length; i++) {
    const gray = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000;
    pixels[i] = gray >= 128 ? 1 : 0;
  }
  return pixels;
}

function _pixelMatchRate(pixels, templatePixels) {
  if (!pixels || !templatePixels) return 0;
  let match = 0;
  for (let i = 0; i < pixels.length; i++) {
    if (pixels[i] === templatePixels[i]) match++;
  }
  return (match / pixels.length) * 100;
}

function calcSilhouetteScore(binarizedPixels, templatePixelsA, templatePixelsB) {
  const scoreA = _pixelMatchRate(binarizedPixels, templatePixelsA);
  const scoreB = _pixelMatchRate(binarizedPixels, templatePixelsB);
  return Math.max(scoreA, scoreB);
}

/**
 * 3つの判定スコア（TM・骨格・シルエット）の加重平均を最終スコアとして返す。
 * 手が検出されていない場合（landmarks が null または空）は強制的に 0 を返す。
 * @param {HTMLCanvasElement} videoCanvas
 * @param {Array<Array<{x:number,y:number,z:number}>>|null} landmarks
 * @param {string} currentPose
 * @param {{vec:number[], rawKeyPoints:object[], hands?:number, vec2?:number[], rawKeyPoints2?:object[]}|null} [refData=null]
 * @returns {Promise<number>} 0〜100（四捨五入済み）
 */
async function getFinalScore(videoCanvas, landmarks, currentPose, refData = null) {
  // 手未検出は強制 0 点
  if (!landmarks || landmarks.length === 0) {
    _lastPredictions = [];
    console.log(`[classifier] getFinalScore | pose=${currentPose} | 手未検出 → 0点`);
    return 0;
  }

  // a. Teachable Machine スコア
  const preds = await getPredictions(videoCanvas);
  _lastPredictions = preds;
  const tmMatch = preds.find(p => p.className === currentPose);
  const teachableMachineScore = tmMatch ? Math.round(tmMatch.probability * 100) : 0;

  // b. 骨格検出スコア（1手/2手・通常+ミラー反転の高い方を採用）
  let skeletonScore = 0;
  if (refData && landmarks) {
    if (refData.hands === 2 && refData.vec && refData.vec2) {
      if (landmarks.length >= 2) {
        // 両手検出: 組み合わせ(2通り) × ミラー(2通り) = 4通りの最大値
        skeletonScore = Math.round(
          _calcSkelWithMirror2(landmarks[0], landmarks[1], refData.vec, refData.vec2)
        );
      } else if (landmarks[0]) {
        // 片手のみ検出: 2つの正解それぞれにミラー込みで照合し高い方を採用
        const s0 = _calcSkelWithMirror1(landmarks[0], refData.vec);
        const s1 = _calcSkelWithMirror1(landmarks[0], refData.vec2);
        skeletonScore = Math.round(Math.max(s0, s1));
      }
    } else if (refData.vec && landmarks[0]) {
      // 1手登録: 通常+ミラーの高い方
      skeletonScore = Math.round(_calcSkelWithMirror1(landmarks[0], refData.vec));
    }
  }

  // c. シルエット照合スコア
  let silhouetteScore = 0;
  let usedTemplate = '-';
  if (silhouetteTemplates && silhouetteTemplates[currentPose]) {
    const bbox = getBoundingBox(landmarks, videoCanvas.width, videoCanvas.height, currentPose);
    if (bbox.w > 0 && bbox.h > 0) {
      const binarized = extractAndBinarize(videoCanvas, bbox);
      const { a: tplA, b: tplB } = silhouetteTemplates[currentPose];
      const scoreA = _pixelMatchRate(binarized, tplA);
      const scoreB = _pixelMatchRate(binarized, tplB);
      silhouetteScore = Math.max(scoreA, scoreB);
      usedTemplate = scoreA >= scoreB ? 'a' : 'b';
    }
  }

  const finalScore = Math.round(
    teachableMachineScore * 0.5 + skeletonScore * 0.3 + silhouetteScore * 0.2
  );

  console.log(
    `[classifier] getFinalScore | pose=${currentPose}` +
    ` | TM=${teachableMachineScore} skeleton=${skeletonScore}(+mirror)` +
    ` silhouette=${Math.round(silhouetteScore)}(tpl:${usedTemplate})` +
    ` | final=${finalScore}`
  );

  return finalScore;
}

function getLastPredictions() {
  return _lastPredictions;
}

window.ClassifierModule = {
  loadModel, isModelLoaded, calcScore, getPredictions,
  loadSilhouetteTemplates, getBoundingBox, extractAndBinarize,
  calcSilhouetteScore, getFinalScore, getLastPredictions,
};
