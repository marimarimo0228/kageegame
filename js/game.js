// js/game.js — ゲーム進行管理メインファイル

// ゲーム定数
const QUESTION_COUNT    = 3;
const QUESTION_DURATION = 12_000; // ms
const INTERVAL_DURATION = 2_000;  // ms
const FLASH_DURATION    = 1_000;  // ms
const NEW_BEST_DURATION = 1_000;  // ms
const ART_HOLD_DURATION = 3_000;  // ms

// ゲーム状態
let allPoses           = [];   // poses.json 全体
let referenceVecs      = {};   // { pose名: { vec, rawKeyPoints } | null } — 採点に使うアクティブな参照
let mediapipeVecs      = {};   // MediaPipe 抽出結果のみ保持（手動上書き不可）
let mirroredRefVecs    = {};   // { pose名: number[] | null } — 左右反転採点ベクトル
let _extractionPromise = null; // 抽出の重複実行を防ぐシングルトンPromise
let questionOrder      = [];   // 今回の問題順（allPoses のインデックス列）
let scores             = [];   // 各問題のベストスコア
let sessionSnapshots   = [];   // 今回のセッションで保存した snapshot
let currentDetectionCb = null;

let audioCtx = null;

// ─── お題キャンバス描画 ───────────────────────────────────────

// KEY_INDICES の配列順に対応する表示スタイル（色・半径）
// KEY_INDICES = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 9]
const POINT_STYLES = [
  null,                          // 0: 手首（非表示）
  { color: '#FF9F43', r: 0.014 }, // 1: 親指IP
  { color: '#FF9F43', r: 0.020 }, // 2: 親指先端
  { color: '#FFC300', r: 0.014 }, // 3: 人差指PIP
  { color: '#FFC300', r: 0.020 }, // 4: 人差指先端
  { color: '#5DCAA5', r: 0.014 }, // 5: 中指PIP
  { color: '#5DCAA5', r: 0.020 }, // 6: 中指先端
  { color: '#3498DB', r: 0.014 }, // 7: 薬指PIP
  { color: '#3498DB', r: 0.020 }, // 8: 薬指先端
  { color: '#E879F9', r: 0.014 }, // 9: 小指PIP
  { color: '#E879F9', r: 0.020 }, // 10: 小指先端
  { color: '#FFFFFF', r: 0.016 }, // 11: 手のひら（中指MCP）
];

// rawKeyPoints 配列インデックス間の接続定義
const KEY_CONNECTIONS = [
  [0, 11], [11, 3], [11, 5], [11, 7], [11, 9], // 手首〜手のひら〜各指
  [3, 4], [5, 6], [7, 8], [9, 10],              // PIP → 先端（4本指）
  [0, 1], [1, 2],                               // 親指
];

/**
 * お題画像を canvas に描画し、参照骨格ポイントをオーバーレイ表示する。
 */
function drawQuestionCanvas(canvas, imageSrc, rawKeyPoints) {
  const ctx = canvas.getContext('2d');
  const img = new Image();
  img.onload = () => {
    canvas.width  = img.naturalWidth;
    canvas.height = img.naturalHeight;
    ctx.drawImage(img, 0, 0);
    if (!rawKeyPoints || rawKeyPoints.length === 0) return;

    const w = canvas.width;
    const h = canvas.height;
    const base = Math.min(w, h); // ドットサイズの基準

    // 接続線
    ctx.lineWidth   = base * 0.006;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    for (const [a, b] of KEY_CONNECTIONS) {
      const pa = rawKeyPoints[a];
      const pb = rawKeyPoints[b];
      ctx.beginPath();
      ctx.moveTo(pa.x * w, pa.y * h);
      ctx.lineTo(pb.x * w, pb.y * h);
      ctx.stroke();
    }

    // 採点ポイントのドット
    rawKeyPoints.forEach((pt, i) => {
      const style = POINT_STYLES[i];
      if (!style) return;
      const x = pt.x * w;
      const y = pt.y * h;
      const r = style.r * base;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = style.color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.lineWidth   = base * 0.003;
      ctx.stroke();
    });
  };
  img.src = imageSrc;
}

// ─── ユーティリティ ───────────────────────────────────────────

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function showScreen(id) {
  document.querySelectorAll('[id^="screen-"]').forEach((el) => {
    el.style.display = 'none';
  });
  const target = document.getElementById(id);
  if (target) target.style.display = 'flex';
}

function playBeep(freq = 880, duration = 0.12) {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    const osc  = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + duration);
  } catch (_) {}
}

function sampleIndices(total, count) {
  const arr = Array.from({ length: total }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, count);
}

// ─── localStorage 手動保存の読み込み ──────────────────────

function loadManualRefsFromStorage() {
  try {
    return JSON.parse(localStorage.getItem(window.KAGEE_MANUAL_REFS_KEY) || '{}');
  } catch { return {}; }
}

// ─── poses.json 読み込み ──────────────────────────────────────

async function loadPoses() {
  try {
    const res = await fetch('poses/poses.json');
    allPoses = await res.json();
  } catch (err) {
    console.error('[game] poses.json の読み込みに失敗しました:', err);
    allPoses = [];
  }
}

// ─── お題画像から参照骨格を抽出（シングルトン・バックグラウンド対応）─

// x成分（偶数インデックス）を反転して左右ミラーベクトルを生成する
function computeMirrorVec(vec) {
  return vec.map((v, i) => i % 2 === 0 ? -v : v);
}

async function extractAllReferenceVecs() {
  const { extractFromImage, computeVecFromKeyPoints } = window.PoseExtractorModule;
  const manualRefs = loadManualRefsFromStorage();

  for (const pose of allPoses) {
    if (pose.name in referenceVecs) continue;

    // 手動保存があれば優先して使用（MediaPipe をスキップ）
    if (manualRefs[pose.name]) {
      referenceVecs[pose.name] = manualRefs[pose.name];
    } else {
      // MediaPipe で抽出し、両方のキャッシュに保存
      const result = await extractFromImage(`assets/silhouettes/${pose.image}`);
      mediapipeVecs[pose.name] = result;

      if (result) {
        referenceVecs[pose.name] = { handCount: 1, ...result };
      } else if (pose.keyPoints && pose.keyPoints.length === 12) {
        // MediaPipe 検出失敗時は poses.json の定義済み座標をフォールバックとして使用
        const vec = computeVecFromKeyPoints(pose.keyPoints);
        referenceVecs[pose.name] = { handCount: 1, vec, rawKeyPoints: pose.keyPoints };
        console.warn(`[game] ${pose.name}: MediaPipe 検出失敗 → poses.json の keyPoints を使用`);
      } else {
        referenceVecs[pose.name] = null;
      }
    }

    // 正解ベクトルが確定したら左右反転バージョンも生成
    const refVecData = referenceVecs[pose.name];
    if (refVecData?.vec) {
      mirroredRefVecs[pose.name] = {
        vec:  computeMirrorVec(refVecData.vec),
        vec2: refVecData.vec2 ? computeMirrorVec(refVecData.vec2) : null,
      };
    } else {
      mirroredRefVecs[pose.name] = null;
    }
  }
}

/** 重複実行を防ぎながら抽出を開始 / 待機する */
function ensureReferenceVecs() {
  if (!_extractionPromise) {
    _extractionPromise = extractAllReferenceVecs();
  }
  return _extractionPromise;
}

/**
 * ページ初期化時に呼び出す。poses.json を読み込み、参照骨格の抽出をバックグラウンドで開始。
 */
async function initGame() {
  await loadPoses();
  ensureReferenceVecs(); // await しない（バックグラウンドで先行開始）
}

// ─── カウントダウン ───────────────────────────────────────────

async function runCountdown() {
  showScreen('screen-countdown');
  const el = document.getElementById('countdown-number');
  for (let i = 3; i >= 1; i--) {
    if (el) el.textContent = String(i);
    playBeep(440, 0.15);
    await wait(1000);
  }
  if (el) el.textContent = 'GO!';
  playBeep(880, 0.25);
  await wait(600);
}

// ─── 演出ヘルパー ─────────────────────────────────────────────

function setNewBestVisible(visible) {
  const el = document.getElementById('new-best-label');
  if (el) el.style.display = visible ? 'block' : 'none';
}

async function flashBestScore(score) {
  const el = document.getElementById('flash-score');
  if (!el) { await wait(FLASH_DURATION); return; }
  el.textContent  = String(score);
  el.style.color   = score >= 80 ? '#EF9F27' : '#FFFFFF';
  el.style.display = 'flex';
  await wait(FLASH_DURATION);
  el.style.display = 'none';
}

// ─── 1問の進行 ────────────────────────────────────────────────

async function runQuestion(qIdx) {
  showScreen('screen-play');

  const poseData  = allPoses[questionOrder[qIdx]];
  const refData   = poseData ? (referenceVecs[poseData.name]  ?? null) : null;
  const refVec    = refData?.vec  ?? null;
  const refVec2   = refData?.vec2 ?? null;
  const handCount = refData?.handCount ?? 1;
  const mirData   = poseData ? (mirroredRefVecs[poseData.name] ?? null) : null;
  const mirVec    = mirData?.vec  ?? null;
  const mirVec2   = mirData?.vec2 ?? null;

  let bestScore     = 0;
  let bestLandmarks = null;
  let newBestTimer  = null;
  let newBestActive = false;

  const qNumEl    = document.getElementById('question-number');
  const qCanvas   = document.getElementById('canvas-question');
  if (qNumEl) qNumEl.textContent = `${qIdx + 1} / ${QUESTION_COUNT}`;
  if (qCanvas && poseData) {
    drawQuestionCanvas(
      qCanvas,
      `assets/silhouettes/${poseData.image}`,
      null  // ゲームプレイ中は骨格点を表示しない
    );
  }

  const timerBar     = document.getElementById('timer-bar');
  const scoreDisplay = document.getElementById('score-display');
  const cameraCanvas = document.getElementById('canvas-camera');
  const cameraCtx    = cameraCanvas ? cameraCanvas.getContext('2d') : null;

  if (timerBar) {
    timerBar.style.width           = '100%';
    timerBar.style.backgroundColor = '';
  }

  const { drawLandmarks, drawVideoFrame } = window.CameraModule;
  const { calcScore7 }                   = window.PoseExtractorModule;

  currentDetectionCb = (allLandmarks) => {
    if (cameraCtx && cameraCanvas) {
      // ビデオ映像を描画してから骨格を重ねる
      drawVideoFrame(cameraCtx);
    }
    if (allLandmarks && cameraCtx) {
      for (let i = 0; i < allLandmarks.length; i++) {
        drawLandmarks(allLandmarks[i], cameraCtx, i);
      }
    }

    if (!allLandmarks || !poseData) {
      if (scoreDisplay) { scoreDisplay.textContent = '---'; scoreDisplay.style.color = ''; }
      return;
    }

    // 採点
    let bestHandScore = 0;
    let bestHandLm    = null;

    if (handCount === 2 && allLandmarks.length >= 2) {
      // 2手採点：手A・手Bの最良割り当て（正方向/反転）で平均スコアを算出
      const a  = allLandmarks[0];
      const b  = allLandmarks[1];
      const r2 = refVec2 ?? refVec;
      const m2 = mirVec2 ?? mirVec;

      const tryAssign = (r1, r2ref) => {
        if (!r1 || !r2ref) return 0;
        const ab = (calcScore7(a, r1) + calcScore7(b, r2ref)) / 2;
        const ba = (calcScore7(a, r2ref) + calcScore7(b, r1)) / 2;
        return Math.round(Math.max(ab, ba));
      };

      let best = tryAssign(refVec, r2);
      if (mirVec) best = Math.max(best, tryAssign(mirVec, m2));
      bestHandScore = best;
      bestHandLm    = allLandmarks[0];
    } else {
      // 1手採点（正方向・反転の最高値）
      for (const lm of allLandmarks) {
        const s1 = calcScore7(lm, refVec);
        const s2 = mirVec ? calcScore7(lm, mirVec) : 0;
        const s  = Math.max(s1, s2);
        if (s > bestHandScore) { bestHandScore = s; bestHandLm = lm; }
      }
    }

    if (scoreDisplay) {
      scoreDisplay.textContent = String(bestHandScore);
      scoreDisplay.style.color = bestHandScore >= 80 ? '#EF9F27' : '';
    }

    if (bestHandScore > bestScore) {
      bestScore     = bestHandScore;
      bestLandmarks = bestHandLm.map((lm) => [lm.x, lm.y]);

      if (!newBestActive) {
        newBestActive = true;
        setNewBestVisible(true);
      }
      if (newBestTimer) clearTimeout(newBestTimer);
      newBestTimer = setTimeout(() => {
        setNewBestVisible(false);
        newBestActive = false;
      }, NEW_BEST_DURATION);
    }
  };

  const startTime = performance.now();
  let lastBeepSec = -1;

  await new Promise((resolve) => {
    function tick() {
      const elapsed   = performance.now() - startTime;
      const remaining = Math.max(0, QUESTION_DURATION - elapsed);
      const ratio     = remaining / QUESTION_DURATION;

      if (timerBar) {
        timerBar.style.width = `${ratio * 100}%`;
        if (remaining <= 3000) {
          timerBar.style.backgroundColor = '#E24B4A';
          const beepSec = Math.ceil(remaining / 1000);
          if (beepSec !== lastBeepSec && beepSec >= 1 && beepSec <= 3) {
            lastBeepSec = beepSec;
            playBeep(660, 0.14);
          }
        }
      }

      if (elapsed >= QUESTION_DURATION) {
        resolve();
      } else {
        requestAnimationFrame(tick);
      }
    }
    requestAnimationFrame(tick);
  });

  currentDetectionCb = null;
  if (newBestTimer) clearTimeout(newBestTimer);
  setNewBestVisible(false);

  await flashBestScore(bestScore);

  const { saveSnapshot } = window.SnapshotModule;
  if (bestLandmarks) {
    const snap = {
      id:        Date.now(),
      pose:      poseData.name,
      score:     bestScore,
      landmarks: bestLandmarks,
      timestamp: new Date().toISOString(),
    };
    saveSnapshot(snap);
    sessionSnapshots.push(snap);
  }

  scores.push(bestScore);

  if (qIdx < QUESTION_COUNT - 1) {
    await wait(INTERVAL_DURATION);
  }
}

// ─── エクスポート関数 ─────────────────────────────────────────

async function startGame() {
  scores           = [];
  sessionSnapshots = [];

  if (allPoses.length === 0) await loadPoses();

  questionOrder = sampleIndices(allPoses.length, QUESTION_COUNT);

  // 骨格抽出はバックグラウンドで実行（完了を待たずゲーム進行）
  ensureReferenceVecs();
  await runCountdown();

  const { startDetection } = window.CameraModule;
  startDetection((landmarks) => {
    if (currentDetectionCb) currentDetectionCb(landmarks);
  });

  for (let i = 0; i < QUESTION_COUNT; i++) {
    await runQuestion(i);
  }

  showResult();
}

function showResult() {
  showScreen('screen-result');

  const avg = scores.length > 0
    ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length)
    : 0;

  const totalEl = document.getElementById('result-total');
  if (totalEl) totalEl.textContent = String(avg);

  const scoresEl = document.getElementById('result-scores');
  if (scoresEl) {
    scoresEl.innerHTML = scores
      .map((s, i) => {
        const pd    = allPoses[questionOrder[i]];
        const label = pd ? (pd.label ?? pd.name) : `問題${i + 1}`;
        return `<li>${label}: ${s}点</li>`;
      })
      .join('');
  }

  const { addScore, getRanking } = window.RankingModule;
  addScore(avg);
  const ranking = getRanking();
  const rank    = ranking.indexOf(avg) + 1;

  const rankEl = document.getElementById('result-rank');
  if (rankEl) rankEl.textContent = `${rank}位 / ${ranking.length}人中`;
}

async function showArtCanvas() {
  showScreen('screen-art');

  const canvas = document.getElementById('canvas-art');
  if (!canvas) return;

  const { drawAllSnapshots, fadeInSnapshot } = window.ArtCanvasModule;
  const { loadAllSnapshots }                 = window.SnapshotModule;

  const sessionIds = new Set(sessionSnapshots.map((s) => s.id));
  const past       = loadAllSnapshots().filter((s) => !sessionIds.has(s.id));
  drawAllSnapshots(canvas, past);

  for (const snap of sessionSnapshots) {
    await fadeInSnapshot(canvas, snap, 800);
  }

  await wait(ART_HOLD_DURATION);
  showScreen('screen-title');
}

window.GameModule = {
  initGame,
  startGame,
  showResult,
  showArtCanvas,
  showScreen,
  getAllPoses:       ()         => allPoses,
  getReferenceVec:  (name)     => referenceVecs[name]  ?? null,
  getMediapipeVec:  (name)     => mediapipeVecs[name]  ?? null,
  setReferenceVec:  (name, d)  => {
    referenceVecs[name] = d;
    if (d?.vec) {
      mirroredRefVecs[name] = {
        vec:  computeMirrorVec(d.vec),
        vec2: d.vec2 ? computeMirrorVec(d.vec2) : null,
      };
    } else {
      mirroredRefVecs[name] = null;
    }
  },
};
