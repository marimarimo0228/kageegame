// js/classifier.js — ポーズ類似度分類モジュール（外部ライブラリなし）

/**
 * MediaPipe の 21点ランドマークを正規化し、42次元の特徴ベクトルを返す。
 * - 手首(0番)を原点に平行移動
 * - 全点の手首からの距離の最大値でスケーリング（スケール不変）
 * - x, y のみ使用（z は無視）
 * @param {Array<{x:number,y:number,z:number}>} landmarks
 * @returns {number[]} 42次元ベクトル [x0, y0, x1, y1, ..., x20, y20]
 */
function normalize(landmarks) {
  const wrist = landmarks[0];

  const shifted = landmarks.map((lm) => ({
    x: lm.x - wrist.x,
    y: lm.y - wrist.y,
  }));

  let maxDist = 0;
  for (const p of shifted) {
    const d = Math.sqrt(p.x * p.x + p.y * p.y);
    if (d > maxDist) maxDist = d;
  }

  // 全点が重なっている異常フレームはゼロベクトルで返す
  if (maxDist === 0) return new Array(42).fill(0);

  const vec = [];
  for (const p of shifted) {
    vec.push(p.x / maxDist);
    vec.push(p.y / maxDist);
  }
  return vec;
}

/**
 * 2つのベクトルのコサイン類似度を返す。
 * ゼロベクトルが含まれる場合は 0 を返す。
 * @param {number[]} vecA
 * @param {number[]} vecB
 * @returns {number} -1〜1
 */
function cosineSimilarity(vecA, vecB) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * ランドマークと1ポーズ分のデータを比較し、スコアを返す。
 * 全サンプルとのコサイン類似度の最大値を 0〜100 に変換。
 * @param {Array<{x:number,y:number,z:number}>} landmarks
 * @param {{ name: string, samples: number[][] }} poseData
 * @returns {number} 0〜100
 */
function calcScore(landmarks, poseData) {
  const vec = normalize(landmarks);
  let maxSim = -1;
  for (const sample of poseData.samples) {
    const sim = cosineSimilarity(vec, sample);
    if (sim > maxSim) maxSim = sim;
  }
  // コサイン類似度 (-1〜1) を 0〜100 にマッピング
  return Math.round(((maxSim + 1) / 2) * 100);
}

/**
 * 全ポーズを比較し、最も高いスコアのポーズ名とスコアを返す。
 * @param {Array<{x:number,y:number,z:number}>} landmarks
 * @param {Array<{ name: string, samples: number[][] }>} allPoses
 * @returns {{ pose: string, score: number }}
 */
function getBestPoseScore(landmarks, allPoses) {
  let bestPose = '';
  let bestScore = -1;
  for (const poseData of allPoses) {
    const score = calcScore(landmarks, poseData);
    if (score > bestScore) {
      bestScore = score;
      bestPose = poseData.name;
    }
  }
  return { pose: bestPose, score: bestScore };
}

// グローバルスコープへ公開（ES Module 非対応環境向け）
window.ClassifierModule = { normalize, cosineSimilarity, calcScore, getBestPoseScore };
