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
let allTemplates       = [];   // { name, label, img } の配列（プリロード済み画像）
let referenceVecs      = {};   // { pose名: { vec, rawKeyPoints } | null }（骨格オーバーレイ用）
let _extractionPromise = null; // 抽出の重複実行を防ぐシングルトンPromise
let questionOrder      = [];   // 今回の問題順（allPoses のインデックス列）
let scores             = [];   // 各問題のベストスコア
let sessionSnapshots   = [];   // 今回のセッションで保存した snapshot
let currentDetectionCb = null;

let _beepCtx = null;  // countdown / timer ビープ用（effects.js の audioCtx と名前衝突を避けるため改名）

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
    if (!_beepCtx) {
      _beepCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    const osc  = _beepCtx.createOscillator();
    const gain = _beepCtx.createGain();
    osc.connect(gain);
    gain.connect(_beepCtx.destination);
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.25, _beepCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, _beepCtx.currentTime + duration);
    osc.start(_beepCtx.currentTime);
    osc.stop(_beepCtx.currentTime + duration);
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

// ─── テンプレート画像のプリロード ─────────────────────────────

async function loadTemplateImages() {
  allTemplates = await Promise.all(
    allPoses.map((pose) => new Promise((resolve) => {
      const img = new Image();
      img.onload  = () => resolve({ name: pose.name, label: pose.label ?? pose.name, img });
      img.onerror = () => resolve({ name: pose.name, label: pose.label ?? pose.name, img: null });
      img.src = `assets/silhouettes/${pose.answerImage ?? pose.image}`;
    }))
  );
}

// ─── お題画像から参照骨格を抽出（骨格オーバーレイ用・バックグラウンド）─

async function extractAllReferenceVecs() {
  const { extractFromImage } = window.PoseExtractorModule;
  for (const pose of allPoses) {
    if (pose.name in referenceVecs) continue;
    referenceVecs[pose.name] = await extractFromImage(
      `assets/silhouettes/${pose.image}`
    );
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
  // モデル読み込みはバックグラウンドで開始（完了を待たずページ初期化を続行）
  if (window.ClassifierModule) {
    window.ClassifierModule.loadModel().catch(() => {});
  }
  const _overlayCanvas = document.getElementById('canvas-overlay');
  if (_overlayCanvas && window.EffectsModule) {
    window.EffectsModule.initEffects(_overlayCanvas);
  }
  ensureReferenceVecs(); // await しない（バックグラウンドで先行開始・骨格オーバーレイ用）
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

// ─── 確率バー更新 ─────────────────────────────────────────────

function updateProbabilityBars(preds) {
  for (const { className, probability } of preds) {
    const pct  = Math.round(probability * 100);
    const fill = document.getElementById(`prob-${className}`);
    const val  = document.getElementById(`prob-val-${className}`);
    if (fill) fill.style.width = `${pct}%`;
    if (val)  val.textContent  = `${pct}%`;
  }
}

// ─── 1問の進行 ────────────────────────────────────────────────

async function runQuestion(qIdx, isTutorial = false) {
  showScreen('screen-play');

  const poseData = allPoses[questionOrder[qIdx]];
  const refData  = poseData ? (referenceVecs[poseData.name] ?? null) : null;

  let bestScore         = 0;
  let bestLandmarks     = null;
  let lastLandmarks     = null;
  let lastTMScore       = 0;
  let questionActive    = true;
  let scoringInProgress = false;
  let newBestTimer      = null;
  let newBestActive     = false;

  const qNumEl    = document.getElementById('question-number');
  const qCanvas   = document.getElementById('canvas-question');
  if (qNumEl) qNumEl.textContent = isTutorial ? 'チュートリアル' : `${qIdx + 1} / ${QUESTION_COUNT}`;
  if (qCanvas && poseData) {
    drawQuestionCanvas(
      qCanvas,
      `assets/silhouettes/${poseData.answerImage ?? poseData.image}`,
      refData?.rawKeyPoints ?? null
    );
  }

  const timerBar      = document.getElementById('timer-bar');
  const scoreDisplay  = document.getElementById('score-display');
  const cameraCanvas  = document.getElementById('canvas-camera');
  const overlayCanvas = document.getElementById('canvas-overlay');

  // showScreen() で play 画面が表示された後に canvas 解像度を設定する。
  // 初期化時は screen-play が display:none のため clientWidth=0 になっており、
  // そのまま描画しても何も映らないため毎問ここで更新する。
  if (cameraCanvas) {
    const p = cameraCanvas.parentElement;
    if (p && p.clientWidth > 0) {
      cameraCanvas.width  = p.clientWidth;
      cameraCanvas.height = p.clientHeight;
    } else if (!cameraCanvas.width) {
      cameraCanvas.width  = 640;
      cameraCanvas.height = 480;
    }
  }
  if (overlayCanvas && cameraCanvas) {
    overlayCanvas.width  = cameraCanvas.width;
    overlayCanvas.height = cameraCanvas.height;
  }

  const cameraCtx  = cameraCanvas  ? cameraCanvas.getContext('2d')  : null;
  const overlayCtx = overlayCanvas ? overlayCanvas.getContext('2d') : null;

  if (timerBar) {
    timerBar.style.width           = '100%';
    timerBar.style.backgroundColor = '';
  }

  const { drawLandmarks, drawVideoFrame } = window.CameraModule;

  // ランドマークはスナップショット取得用に保持するだけ（採点は TM が担当）
  currentDetectionCb = (allLandmarks) => {
    lastLandmarks = allLandmarks;
    if (cameraCtx && cameraCanvas) {
      drawVideoFrame(cameraCtx);
    }
    if (allLandmarks && cameraCtx) {
      for (let i = 0; i < allLandmarks.length; i++) {
        drawLandmarks(allLandmarks[i], cameraCtx, i);
      }
    }
  };

  // チュートリアル中のインゲームヒント
  const tutHintTimers = [];
  if (isTutorial && window.TutorialModule) {
    const { showPlayHint } = window.TutorialModule;
    tutHintTimers.push(setTimeout(() => showPlayHint('← 左のシルエットがお題です！', 3500), 600));
    tutHintTimers.push(setTimeout(() => showPlayHint('カメラの前で同じポーズを作ってみよう！', 3500), 4800));
    tutHintTimers.push(setTimeout(() => showPlayHint('スコアが上がるようにポーズを調整しよう！', 3000), 9000));
  }

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

      // Teachable Machine スコア更新（ノンブロッキング）
      // cameraCanvas はプレイ中に描画済みなので video-preview より信頼性が高い
      if (!scoringInProgress && poseData && cameraCanvas && cameraCanvas.width > 0) {
        scoringInProgress = true;
        window.ClassifierModule.getPredictions(cameraCanvas)
          .then((preds) => {
            scoringInProgress = false;
            if (!questionActive) return;

            updateProbabilityBars(preds);

            const match = preds.find(p => p.className === poseData.name);
            const score = match ? Math.round(match.probability * 100) : 0;
            lastTMScore = score;

            if (scoreDisplay) {
              scoreDisplay.textContent = String(score);
              scoreDisplay.style.color = score >= 80 ? '#EF9F27' : '';
            }

            if (score > bestScore) {
              bestScore = score;
              if (lastLandmarks && lastLandmarks[0]) {
                bestLandmarks = lastLandmarks[0].map(lm => [lm.x, lm.y]);
              }
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
          })
          .catch(() => { scoringInProgress = false; });
      }

      // エフェクト更新（60fps でスムーズに描画）
      if (window.EffectsModule && overlayCtx && overlayCanvas) {
        window.EffectsModule.updateEffect(
          poseData ? poseData.name : '',
          lastTMScore,
          lastLandmarks ? lastLandmarks[0] : null,
          overlayCtx,
          overlayCanvas.width,
          overlayCanvas.height
        );
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
  questionActive = false;
  if (window.EffectsModule && overlayCtx && overlayCanvas) {
    window.EffectsModule.clearEffects(overlayCtx, overlayCanvas.width, overlayCanvas.height);
  }
  tutHintTimers.forEach(clearTimeout);
  if (window.TutorialModule) window.TutorialModule.hidePlayHint();
  if (newBestTimer) clearTimeout(newBestTimer);
  setNewBestVisible(false);

  await flashBestScore(bestScore);

  if (!isTutorial) {
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
}

// ─── エクスポート関数 ─────────────────────────────────────────

async function startTutorial() {
  if (allPoses.length === 0) await loadPoses();

  // チュートリアルは固定で最初のポーズを1問だけ使用
  questionOrder = [0];

  ensureReferenceVecs();
  await runCountdown();

  const { startDetection } = window.CameraModule;
  startDetection((landmarks) => {
    if (currentDetectionCb) currentDetectionCb(landmarks);
  });

  await runQuestion(0, true);
}

async function startGame() {
  console.log('[game] startGame() 開始');
  // モデル未読込でもゲームは即座に開始する（スコアは後から更新される）
  if (window.ClassifierModule && !window.ClassifierModule.isModelLoaded()) {
    console.warn('[game] モデル未読込のためバックグラウンドでリトライ中...');
    window.ClassifierModule.loadModel().catch(() => {});  // ノンブロッキング
  }

  // 初回プレイはチュートリアルを先に実行する
  if (window.TutorialModule && window.TutorialModule.isFirstPlay()) {
    window.TutorialModule.markTutorialDone();
    await window.TutorialModule.runTutorial();
    showScreen('screen-title');
    return;
  }

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

window.GameModule = { initGame, startGame, startTutorial, showResult, showArtCanvas };
