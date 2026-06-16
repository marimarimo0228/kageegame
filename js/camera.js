// js/camera.js — カメラ映像取得 + MediaPipe Hands 手骨格検出モジュール

// MediaPipe Hands の関節接続定義（21点）
const CONNECTIONS = [
  [0, 1],  [1, 2],  [2, 3],  [3, 4],   // 親指
  [0, 5],  [5, 6],  [6, 7],  [7, 8],   // 人差し指
  [5, 9],  [9, 10], [10, 11],[11, 12], // 中指
  [9, 13], [13, 14],[14, 15],[15, 16], // 薬指
  [13, 17],[17, 18],[18, 19],[19, 20], // 小指
  [0, 17],                              // 手のひら（手首〜小指付け根）
];

let _hands = null;   // MediaPipe Hands インスタンス
let _video = null;   // <video> 要素
let _canvas = null;  // <canvas> 要素
let _camera = null;  // MediaPipe Camera インスタンス

/**
 * カメラ映像を videoEl に表示し、MediaPipe Hands を初期化する。
 * @param {HTMLVideoElement} videoEl
 * @param {HTMLCanvasElement} canvasEl
 */
async function initCamera(videoEl, canvasEl) {
  _video = videoEl;
  _canvas = canvasEl;

  // getUserMedia でカメラストリームを取得
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: 640, height: 480 },
      audio: false,
    });
  } catch (err) {
    console.error('[camera] カメラへのアクセスに失敗しました:', err);
    return;
  }

  _video.srcObject = stream;
  await new Promise((resolve) => {
    _video.onloadedmetadata = () => {
      _video.play();
      resolve();
    };
  });

  // MediaPipe Hands が CDN から読み込まれているか確認
  if (typeof Hands === 'undefined') {
    console.error('[camera] MediaPipe Hands が読み込まれていません。<script> タグを確認してください。');
    return;
  }

  _hands = new Hands({
    locateFile: (file) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
  });

  _hands.setOptions({
    maxNumHands: 2,             // 両手を同時に検出
    modelComplexity: 1,
    minDetectionConfidence: 0.5, // 0.7 → 0.5：部分的に隠れた手も初回検出しやすくする
    minTrackingConfidence: 0.3,  // 0.5 → 0.3：遮蔽されてもトラッキングを維持する
  });

  // setOptions() を確実に適用するため明示的に初期化する。
  // initialize() を省略すると最初の send() 時まで設定が反映されず、
  // maxNumHands が内部デフォルト（1）のまま動作するケースがある。
  await _hands.initialize();
}

/**
 * フレームごとに手を検出し、結果を onResult コールバックへ渡す。
 * @param {(allLandmarks: Array<Array<{x:number,y:number,z:number}>>|null) => void} onResult
 *   allLandmarks: 検出された全手のランドマーク配列（1〜2件）。未検出時は null。
 *   両手検出時は [手0のlandmarks, 手1のlandmarks] の形で渡す。
 */
function startDetection(onResult) {
  if (!_hands || !_video) {
    console.error('[camera] initCamera() を先に呼び出してください。');
    return;
  }

  _hands.onResults((results) => {
    if (
      results.multiHandLandmarks &&
      results.multiHandLandmarks.length > 0
    ) {
      // 1本でも2本でも全手分の配列をそのまま渡す
      // （maxNumHands: 2 により最大2件返る）
      onResult(results.multiHandLandmarks);
    } else {
      onResult(null);
    }
  });

  // MediaPipe の Camera ユーティリティが利用可能な場合はそちらを使用
  if (typeof Camera !== 'undefined') {
    _camera = new Camera(_video, {
      onFrame: async () => {
        await _hands.send({ image: _video });
      },
      width: 640,
      height: 480,
    });
    _camera.start();
  } else {
    // フォールバック: requestAnimationFrame でフレームを送信
    const sendFrame = async () => {
      if (_video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        await _hands.send({ image: _video });
      }
      requestAnimationFrame(sendFrame);
    };
    requestAnimationFrame(sendFrame);
  }
}

/**
 * 21点のランドマークを Canvas に描画する。
 * @param {Array<{x:number,y:number,z:number}>} landmarks
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} [handIndex=0] 手のインデックス（0: 緑、1: 青）
 *   両手検出時に左右を色分けして視認しやすくする。
 */
function drawLandmarks(landmarks, ctx, handIndex = 0) {
  if (!landmarks || landmarks.length === 0) return;

  const w = ctx.canvas.width;
  const h = ctx.canvas.height;

  // 手のインデックスで色を分ける
  // 0本目（または1本のみ）: 緑　1本目（両手時の2本目）: 青
  const lineColor = handIndex === 0
    ? 'rgba(0, 200, 100, 0.6)'   // 緑（半透明）
    : 'rgba(0, 140, 255, 0.6)';  // 青（半透明）
  const dotColor  = handIndex === 0
    ? 'rgba(0, 230, 80, 0.9)'    // 緑（不透明）
    : 'rgba(0, 180, 255, 0.9)';  // 青（不透明）

  // 接続線
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  for (const [a, b] of CONNECTIONS) {
    const p1 = landmarks[a];
    const p2 = landmarks[b];
    ctx.beginPath();
    ctx.moveTo(p1.x * w, p1.y * h);
    ctx.lineTo(p2.x * w, p2.y * h);
    ctx.stroke();
  }

  // 関節点（塗り円）
  ctx.fillStyle = dotColor;
  for (const lm of landmarks) {
    ctx.beginPath();
    ctx.arc(lm.x * w, lm.y * h, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * 現在のカメラ映像フレームを canvas に描画する（骨格オーバーレイ用）。
 * CSS の scaleX(-1) でミラー反転しているので、ここでは反転しない。
 */
function drawVideoFrame(ctx) {
  if (!_video || _video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  ctx.drawImage(_video, 0, 0, ctx.canvas.width, ctx.canvas.height);
}

// グローバルスコープへ公開（ES Module 非対応環境向け）
window.CameraModule = { initCamera, startDetection, drawLandmarks, drawVideoFrame };
