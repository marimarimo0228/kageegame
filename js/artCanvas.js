// js/artCanvas.js — 手シルエット描画モジュール（Canvas 2D API のみ）

const POSE_STYLES = {
  fox:    { colors: ['#E8593C', '#F2A623'] }, // 夕焼け
  rabbit: { colors: ['#534AB7', '#AFA9EC'] }, // 夜空
  bird:   { colors: ['#1D9E75', '#9FE1CB'] }, // 海
  dog:    { colors: ['#185FA5', '#85B7EB'] }, // 空
  crab:   { colors: ['#D85A30', '#F5C4B3'] }, // 珊瑚
};

// 凸包に使う外周ランドマークのインデックス
const OUTLINE_INDICES = [0, 1, 4, 5, 8, 9, 12, 13, 16, 17, 20];

// ベクトル O→A から O→B への外積（スクリーン座標: y下向き）
// 正値 = 時計回り（右折）、負値 = 反時計回り（左折）
function cross(O, A, B) {
  return (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x);
}

/**
 * Graham Scan による凸包計算。
 * スクリーン座標（y下向き）で動作し、時計回り順の頂点列を返す。
 * @param {{ x: number, y: number }[]} points
 * @returns {{ x: number, y: number }[]}
 */
function grahamScan(points) {
  const n = points.length;
  if (n < 3) return [...points];

  // ピボット: 最下端（y最大）、同yならx最小
  let pivotIdx = 0;
  for (let i = 1; i < n; i++) {
    if (
      points[i].y > points[pivotIdx].y ||
      (points[i].y === points[pivotIdx].y && points[i].x < points[pivotIdx].x)
    ) {
      pivotIdx = i;
    }
  }

  const pivot = points[pivotIdx];
  const rest = points.filter((_, i) => i !== pivotIdx);

  // ピボットから各点への極角でソート（右→上→左の昇順）
  // pivot.y - p.y を dy として使うことでスクリーンのy反転を吸収する
  rest.sort((a, b) => {
    const angA = Math.atan2(pivot.y - a.y, a.x - pivot.x);
    const angB = Math.atan2(pivot.y - b.y, b.x - pivot.x);
    if (Math.abs(angA - angB) > 1e-10) return angA - angB;
    // 同角度なら近い点を先に
    const dA = (a.x - pivot.x) ** 2 + (a.y - pivot.y) ** 2;
    const dB = (b.x - pivot.x) ** 2 + (b.y - pivot.y) ** 2;
    return dA - dB;
  });

  const hull = [pivot, rest[0]];
  for (let i = 1; i < rest.length; i++) {
    // cross >= 0 は時計回り（右折）なので凸包の外 → ポップ
    while (
      hull.length >= 2 &&
      cross(hull[hull.length - 2], hull[hull.length - 1], rest[i]) >= 0
    ) {
      hull.pop();
    }
    hull.push(rest[i]);
  }

  return hull;
}

/**
 * snapshot の手形シルエットをグラデーションで描画し、重心にスコアを表示する。
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ landmarks: number[][], pose: string, score: number }} snapshot
 * @param {number} canvasW
 * @param {number} canvasH
 */
function drawArtShadow(ctx, snapshot, canvasW, canvasH) {
  const { landmarks, pose, score } = snapshot;

  // 外周点をピクセル座標に変換
  const outlinePoints = OUTLINE_INDICES.map((i) => ({
    x: landmarks[i][0] * canvasW,
    y: landmarks[i][1] * canvasH,
  }));

  const hull = grahamScan(outlinePoints);
  if (hull.length < 3) return;

  // 凸包パスを clip に設定
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(hull[0].x, hull[0].y);
  for (let i = 1; i < hull.length; i++) {
    ctx.lineTo(hull[i].x, hull[i].y);
  }
  ctx.closePath();
  ctx.clip();

  // 重心（頂点平均）
  const cx = hull.reduce((s, p) => s + p.x, 0) / hull.length;
  const cy = hull.reduce((s, p) => s + p.y, 0) / hull.length;

  // 重心から最も遠い頂点までの距離 → グラデーション半径
  const radius = hull.reduce((max, p) => {
    const d = Math.hypot(p.x - cx, p.y - cy);
    return d > max ? d : max;
  }, 0);

  // 放射グラデーション（内側: 明るい色 → 外側: 濃い色）
  const style = POSE_STYLES[pose] ?? POSE_STYLES.fox;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 1.2);
  grad.addColorStop(0, style.colors[1]);
  grad.addColorStop(1, style.colors[0]);

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvasW, canvasH);

  // スコアテキスト（重心に白文字）
  const fontSize = Math.max(12, Math.round(radius * 0.45));
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(score), cx, cy);

  ctx.restore();
}

/**
 * canvas をクリアして全スナップショットを再描画する。
 * @param {HTMLCanvasElement} canvas
 * @param {Array} snapshots
 */
function drawAllSnapshots(canvas, snapshots) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const snapshot of snapshots) {
    drawArtShadow(ctx, snapshot, canvas.width, canvas.height);
  }
}

/**
 * 新しいスナップショットを透明→不透明にフェードインしながら描画する。
 * @param {HTMLCanvasElement} canvas
 * @param {object} snapshot
 * @param {number} [duration=800] ミリ秒
 * @returns {Promise<void>}
 */
function fadeInSnapshot(canvas, snapshot, duration = 800) {
  return new Promise((resolve) => {
    const ctx = canvas.getContext('2d');
    const startTime = performance.now();

    const frame = (now) => {
      const elapsed = now - startTime;
      const alpha = Math.min(elapsed / duration, 1);

      ctx.save();
      ctx.globalAlpha = alpha;
      drawArtShadow(ctx, snapshot, canvas.width, canvas.height);
      ctx.restore();

      if (elapsed < duration) {
        requestAnimationFrame(frame);
      } else {
        resolve();
      }
    };

    requestAnimationFrame(frame);
  });
}

// グローバルスコープへ公開（ES Module 非対応環境向け）
window.ArtCanvasModule = { drawArtShadow, drawAllSnapshots, fadeInSnapshot };
