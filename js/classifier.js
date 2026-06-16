// js/classifier.js — バウンディングボックス＋シルエット照合によるポーズ分類

const SILHOUETTE_SIZE = 128;

/**
 * MediaPipe landmarks から手のバウンディングボックスを計算する。
 * 2手分の配列が渡された場合は両方を囲む1つの矩形を返す。
 * @param {Array<Array<{x:number,y:number,z:number}>>} landmarks - 1手または2手分
 * @param {number} videoW
 * @param {number} videoH
 * @param {number} [padding=30]
 * @returns {{x:number, y:number, w:number, h:number}}
 */
function getBoundingBox(landmarks, videoW, videoH, padding = 30) {
  const allPoints = landmarks.flat();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const pt of allPoints) {
    const px = pt.x * videoW;
    const py = pt.y * videoH;
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
  }

  const x  = Math.max(0,      Math.floor(minX - padding));
  const y  = Math.max(0,      Math.floor(minY - padding));
  const x2 = Math.min(videoW, Math.ceil(maxX  + padding));
  const y2 = Math.min(videoH, Math.ceil(maxY  + padding));

  return { x, y, w: Math.max(1, x2 - x), h: Math.max(1, y2 - y) };
}

/**
 * videoCanvas の bbox 範囲を切り抜き、グレースケール→2値化した OffscreenCanvas を返す。
 * 閾値 128: 明るい部分を手とみなして白にする。
 * @param {HTMLCanvasElement} videoCanvas
 * @param {{x:number,y:number,w:number,h:number}} bbox
 * @returns {OffscreenCanvas}
 */
function extractSilhouette(videoCanvas, bbox) {
  const { x, y, w, h } = bbox;
  const offscreen = new OffscreenCanvas(w, h);
  const ctx = offscreen.getContext('2d');

  ctx.drawImage(videoCanvas, x, y, w, h, 0, 0, w, h);

  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    const val  = gray >= 128 ? 255 : 0;
    data[i] = data[i + 1] = data[i + 2] = val;
    data[i + 3] = 255;
  }

  ctx.putImageData(imageData, 0, 0);
  return offscreen;
}

/**
 * シルエット Canvas とテンプレート画像を 128×128 にリサイズして重ね合わせ、
 * 白ピクセルが一致している割合を 0〜100 で返す。
 * @param {OffscreenCanvas} silhouetteCanvas
 * @param {HTMLImageElement} templateImg
 * @returns {number} 0〜100
 */
function calcScoreFromSilhouette(silhouetteCanvas, templateImg) {
  const size = SILHOUETTE_SIZE;

  const silCanvas = new OffscreenCanvas(size, size);
  const silCtx    = silCanvas.getContext('2d');
  silCtx.drawImage(silhouetteCanvas, 0, 0, size, size);
  const silData = silCtx.getImageData(0, 0, size, size).data;

  const tplCanvas = new OffscreenCanvas(size, size);
  const tplCtx    = tplCanvas.getContext('2d');
  tplCtx.drawImage(templateImg, 0, 0, size, size);
  const tplData = tplCtx.getImageData(0, 0, size, size).data;

  let matchCount = 0;
  let totalWhite = 0;

  for (let i = 0; i < silData.length; i += 4) {
    const silWhite = silData[i] === 255;
    const tplWhite = tplData[i] >= 128;
    if (tplWhite) totalWhite++;
    if (silWhite && tplWhite) matchCount++;
  }

  if (totalWhite === 0) return 0;
  return Math.round((matchCount / totalWhite) * 100);
}

/**
 * 検出 bbox にポーズごとの最小サイズ制約を適用する。
 * 重心を維持したまま minWidthRatio × videoW / minHeightRatio × videoH を下限とする。
 * @param {{x:number,y:number,w:number,h:number}} bbox
 * @param {number} videoW
 * @param {number} videoH
 * @param {{minWidthRatio?:number, minHeightRatio?:number}|null} constraints
 * @returns {{x:number,y:number,w:number,h:number}}
 */
function applyBboxConstraints(bbox, videoW, videoH, constraints) {
  if (!constraints) return bbox;

  let { x, y, w, h } = bbox;

  const minW = Math.round((constraints.minWidthRatio  ?? 0) * videoW);
  const minH = Math.round((constraints.minHeightRatio ?? 0) * videoH);

  if (w < minW) {
    const cx = x + w / 2;
    x = Math.max(0, Math.round(cx - minW / 2));
    w = Math.min(videoW - x, minW);
  }

  if (h < minH) {
    const cy = y + h / 2;
    y = Math.max(0, Math.round(cy - minH / 2));
    h = Math.min(videoH - y, minH);
  }

  return { x, y, w, h };
}

/**
 * 全お題に対してシルエット照合を実行し、最も高いスコアのポーズ名とスコアを返す。
 * landmarks が null または空の場合は { pose: '', score: 0 } を返す。
 * @param {HTMLCanvasElement} videoCanvas
 * @param {Array<Array<{x:number,y:number,z:number}>>} landmarks - 1手または2手分
 * @param {Array<{name:string, label:string, img:HTMLImageElement}>} allTemplates
 * @param {{minWidthRatio?:number, minHeightRatio?:number}|null} [bboxConstraints]
 * @returns {{pose:string, score:number}}
 */
function getBestPoseScore(videoCanvas, landmarks, allTemplates, bboxConstraints = null) {
  if (!landmarks || landmarks.length === 0) return { pose: '', score: 0 };

  const rawBbox    = getBoundingBox(landmarks, videoCanvas.width, videoCanvas.height);
  const bbox       = applyBboxConstraints(rawBbox, videoCanvas.width, videoCanvas.height, bboxConstraints);
  const silhouette = extractSilhouette(videoCanvas, bbox);

  let bestPose  = '';
  let bestScore = 0;

  for (const template of allTemplates) {
    if (!template.img) continue;
    const score = calcScoreFromSilhouette(silhouette, template.img);
    if (score > bestScore) {
      bestScore = score;
      bestPose  = template.name;
    }
  }

  return { pose: bestPose, score: bestScore };
}

window.ClassifierModule = {
  getBoundingBox,
  applyBboxConstraints,
  extractSilhouette,
  calcScoreFromSilhouette,
  getBestPoseScore,
};
