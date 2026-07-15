// js/poseExtractor.js — お題画像から参照骨格を抽出し、7点で採点するモジュール

// 12点のランドマーク: 手首(0) + 各指の先端・中間関節(PIP) + 中指付け根(9)
// 先端だけでなく中間関節を加えることで「指の曲げ伸ばし」も評価できる
const KEY_INDICES = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 9];

/**
 * 21点ランドマークから KEY_INDICES の12点を抽出し、24次元の正規化ベクトルを返す
 */
function extractKeyVec(landmarks) {
  const wrist = landmarks[0];
  const shifted = KEY_INDICES.map(i => ({
    x: landmarks[i].x - wrist.x,
    y: landmarks[i].y - wrist.y,
  }));

  let maxDist = 0;
  for (const p of shifted) {
    const d = Math.sqrt(p.x * p.x + p.y * p.y);
    if (d > maxDist) maxDist = d;
  }
  if (maxDist === 0) return new Array(14).fill(0);

  const vec = [];
  for (const p of shifted) {
    vec.push(p.x / maxDist);
    vec.push(p.y / maxDist);
  }
  return vec;
}

/**
 * 画像URLにMediaPipe Handsを適用し、7点参照ベクトルを返す。
 * 検出失敗時は null を返す。
 */
async function extractFromImage(imageSrc) {
  if (typeof Hands === 'undefined') return null;

  return new Promise((resolve) => {
    const hands = new Hands({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
    });

    hands.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.3,
      minTrackingConfidence: 0.3,
    });

    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    hands.onResults((results) => {
      if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        const landmarks = results.multiHandLandmarks[0];
        const vec          = extractKeyVec(landmarks);
        const rawKeyPoints = KEY_INDICES.map(i => ({ x: landmarks[i].x, y: landmarks[i].y }));
        console.log('[poseExtractor] 検出成功:', imageSrc);
        done({ vec, rawKeyPoints });
      } else {
        console.warn('[poseExtractor] 手が検出されませんでした:', imageSrc);
        done(null);
      }
    });

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = async () => {
      const canvas = document.createElement('canvas');
      canvas.width  = img.naturalWidth  || img.width;
      canvas.height = img.naturalHeight || img.height;
      canvas.getContext('2d').drawImage(img, 0, 0);
      try {
        await hands.initialize();
        await hands.send({ image: canvas });
      } catch (e) {
        console.warn('[poseExtractor] 処理エラー:', e);
        done(null);
      }
    };
    img.onerror = () => {
      console.warn('[poseExtractor] 画像読み込み失敗:', imageSrc);
      done(null);
    };
    img.src = imageSrc;

    setTimeout(() => done(null), 15000);
  });
}

/**
 * プレイヤーのランドマーク（21点）と参照ベクトル（14次元）を比較し 0〜100 のスコアを返す。
 *
 * 旧: ((sim+1)/2)*100 → sim=0.7でも85点と甘すぎた
 * 新: コサイン類似度（2乗）＋指先平均距離 を組み合わせて厳格化
 *   - sim=1.0, dist=0   → 100点（完璧）
 *   - sim=0.95, dist=0.1 → 約85点（良好）
 *   - sim=0.85, dist=0.2 → 約66点（まあまあ）
 *   - sim=0.70, dist=0.35 → 約40点（不正解寄り）
 */
function calcScore7(landmarks, refVec) {
  if (!refVec) return 0;
  const playerVec = extractKeyVec(landmarks);

  // コサイン類似度
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < playerVec.length; i++) {
    dot   += playerVec[i] * refVec[i];
    normA += playerVec[i] * playerVec[i];
    normB += refVec[i]    * refVec[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  const sim   = denom === 0 ? 0 : dot / denom;

  // 手首（index 0,1）は正規化で常に(0,0)のため除外し、指先6点の平均L2距離を計算
  let totalDist = 0;
  const nFingers = KEY_INDICES.length - 1; // 手首を除く6点
  for (let i = 2; i < playerVec.length; i += 2) {
    const dx = playerVec[i]   - refVec[i];
    const dy = playerVec[i+1] - refVec[i+1];
    totalDist += Math.sqrt(dx * dx + dy * dy);
  }
  const avgDist = totalDist / nFingers;

  // コサイン類似度スコア: 2乗で差を拡大 (sim=0.9→0.81, sim=0.7→0.49)
  const simScore  = Math.max(0, sim) ** 2;

  // 距離スコア: 正規化空間で avgDist >= 0.5 なら 0点
  const distScore = Math.max(0, 1 - avgDist / 0.5);

  return Math.round((simScore * 0.5 + distScore * 0.5) * 100);
}

/**
 * KEY_INDICES の12点それぞれについて、お手本ベクトルとの近さを 0〜100 で返す。
 * calcScore7 の距離スコアと同じスケール（距離0→100点、距離0.5以上→0点）を使う。
 * リアルタイムの部位別一致度表示（お題キャンバスのドット色分け）に使用する。
 */
function calcPointScores(landmarks, refVec) {
  if (!refVec) return null;
  const playerVec = extractKeyVec(landmarks);
  const scores = [];
  for (let i = 0; i < KEY_INDICES.length; i++) {
    const dx = playerVec[i * 2]     - refVec[i * 2];
    const dy = playerVec[i * 2 + 1] - refVec[i * 2 + 1];
    const dist = Math.sqrt(dx * dx + dy * dy);
    scores.push(Math.max(0, 1 - dist / 0.5) * 100);
  }
  return scores;
}

/**
 * 通常向き・ミラー反転の両方で calcPointScores を計算し、
 * 全体スコア（calcScore7）が高い方の部位別スコアを返す。
 */
function calcPointScoresBest(landmarks, refVec) {
  if (!refVec) return null;
  const flipped = refVec.map((v, i) => (i % 2 === 0 ? -v : v));
  const useFlip = calcScore7(landmarks, flipped) > calcScore7(landmarks, refVec);
  return calcPointScores(landmarks, useFlip ? flipped : refVec);
}

window.PoseExtractorModule = {
  KEY_INDICES, extractFromImage, extractKeyVec, calcScore7,
  calcPointScores, calcPointScoresBest,
};
