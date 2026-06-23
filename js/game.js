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
let _detectionStarted  = false; // startDetection の二重起動を防ぐフラグ
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
  const custom = _loadCustomRefs();
  for (const pose of allPoses) {
    if (pose.name in referenceVecs) continue;
    if (custom[pose.name]) {
      // localStorage に保存されたカスタム骨格を優先使用
      referenceVecs[pose.name] = custom[pose.name];
      console.log(`[calib] カスタム骨格を使用: ${pose.name}`);
    } else {
      referenceVecs[pose.name] = await extractFromImage(
        `assets/silhouettes/${pose.image}`
      );
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
  // モデル読み込みはバックグラウンドで開始（完了を待たずページ初期化を続行）
  if (window.ClassifierModule) {
    window.ClassifierModule.loadModel().catch(() => {});
    window.ClassifierModule.loadSilhouetteTemplates().catch(() => {});
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

      // 最終スコア更新（TM・骨格・シルエットの平均、手未検出時は 0、ノンブロッキング）
      if (!scoringInProgress && poseData && cameraCanvas && cameraCanvas.width > 0) {
        scoringInProgress = true;
        window.ClassifierModule.getFinalScore(
          cameraCanvas, lastLandmarks, poseData.name, refData
        )
          .then((score) => {
            scoringInProgress = false;
            if (!questionActive) return;

            updateProbabilityBars(window.ClassifierModule.getLastPredictions());

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
  _ensureDetection();
  await runCountdown();
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
  _ensureDetection();
  await runCountdown();

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

// ─── カメラ検出の一元管理 ─────────────────────────────────────

function _ensureDetection() {
  if (_detectionStarted) return;
  _detectionStarted = true;
  window.CameraModule.startDetection((landmarks) => {
    if (currentDetectionCb) currentDetectionCb(landmarks);
  });
}

// ─── 骨格調整（キャリブレーション）─────────────────────────────

const CALIB_STORAGE_KEY   = 'kagee_custom_refs';
const CALIB_DEFAULT_KEY   = 'kagee_default_refs';

// ── キャリブレーション専用ポイントスタイル ─────────────────────
// 手0: 暖色系（オレンジ統一）  ※質問キャンバスの POINT_STYLES とは別
const CALIB_STYLES_H0 = [
  { color: '#FF6B00', r: 0.022 }, // wrist     - 濃オレンジ（根本点）
  { color: '#FFAD5C', r: 0.014 }, // thumbIP   - 薄オレンジ
  { color: '#FF8C00', r: 0.020 }, // thumbTip  - オレンジ
  { color: '#FFAD5C', r: 0.014 }, // indexPIP
  { color: '#FF8C00', r: 0.020 }, // indexTip
  { color: '#FFAD5C', r: 0.014 }, // midPIP
  { color: '#FF8C00', r: 0.020 }, // midTip
  { color: '#FFAD5C', r: 0.014 }, // ringPIP
  { color: '#FF8C00', r: 0.020 }, // ringTip
  { color: '#FFAD5C', r: 0.014 }, // pinkyPIP
  { color: '#FF8C00', r: 0.020 }, // pinkyTip
  { color: '#FFE4B0', r: 0.016 }, // midMCP    - 薄アンバー
];

// 手1: 寒色系（シアン統一）
const CALIB_STYLES_H1 = [
  { color: '#0090CC', r: 0.022 }, // wrist     - 濃シアン（根本点）
  { color: '#5CD8FF', r: 0.014 }, // thumbIP   - 薄シアン
  { color: '#00ADDE', r: 0.020 }, // thumbTip  - シアン
  { color: '#5CD8FF', r: 0.014 }, // indexPIP
  { color: '#00ADDE', r: 0.020 }, // indexTip
  { color: '#5CD8FF', r: 0.014 }, // midPIP
  { color: '#00ADDE', r: 0.020 }, // midTip
  { color: '#5CD8FF', r: 0.014 }, // ringPIP
  { color: '#00ADDE', r: 0.020 }, // ringTip
  { color: '#5CD8FF', r: 0.014 }, // pinkyPIP
  { color: '#00ADDE', r: 0.020 }, // pinkyTip
  { color: '#B0EEFF', r: 0.016 }, // midMCP    - 薄スカイブルー
];

// クリック時に表示する関節名ラベル（KEY_INDICES の配列順に対応）
const POINT_LABELS = [
  '手首',
  '親指 関節',   '親指 先端',
  '人差指 関節', '人差指 先端',
  '中指 関節',   '中指 先端',
  '薬指 関節',   '薬指 先端',
  '小指 関節',   '小指 先端',
  '手のひら',
];

let _calibPose        = 'dog';
let _calibHands       = 1;    // 1 or 2
let _calibLandmarks   = null;
let _calibStatusTimer = null;
let _calibEditPoints  = [];   // 手0: 12点 {x,y} 正規化 [0,1]
let _calibEditPoints2 = [];   // 手1: 12点 {x,y} 正規化 [0,1]（2手モード時）
let _calibDragHand    = -1;   // ドラッグ中の手インデックス（0/1/-1）
let _calibDragIdx     = -1;   // ドラッグ中の点インデックス（-1: なし）
let _calibLabelHand   = -1;   // ラベル表示中の手インデックス
let _calibLabelIdx    = -1;   // ラベル表示中の点インデックス
let _calibEditImg     = null; // シルエット背景画像

function _loadCustomRefs() {
  try {
    const raw = localStorage.getItem(CALIB_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) { return {}; }
}

function _saveCustomRef(poseName, refData) {
  const refs = _loadCustomRefs();
  refs[poseName] = refData;
  localStorage.setItem(CALIB_STORAGE_KEY, JSON.stringify(refs));
}

function _loadDefaultRefs() {
  try {
    const raw = localStorage.getItem(CALIB_DEFAULT_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) { return {}; }
}

function _saveDefaultRef(poseName, data) {
  const refs = _loadDefaultRefs();
  refs[poseName] = data;
  localStorage.setItem(CALIB_DEFAULT_KEY, JSON.stringify(refs));
}

function _deleteCustomRef(poseName) {
  const refs = _loadCustomRefs();
  delete refs[poseName];
  localStorage.setItem(CALIB_STORAGE_KEY, JSON.stringify(refs));
}

function _calibSetStatus(msg, isError = false) {
  const el = document.getElementById('calib-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? 'var(--accent-red)' : 'var(--accent-green)';
  if (_calibStatusTimer) clearTimeout(_calibStatusTimer);
  _calibStatusTimer = setTimeout(() => { el.textContent = ''; }, 2500);
}

// 正規化ベクトルのx成分を反転（左右ミラー）
function _flipVec(vec) {
  return vec.map((v, i) => i % 2 === 0 ? -v : v);
}

// rawKeyPoints（12点）から正規化ベクトルを計算（poseExtractor の extractKeyVec と等価）
function _computeVecFromPoints(points) {
  const wrist   = points[0];
  const shifted = points.map(pt => ({ x: pt.x - wrist.x, y: pt.y - wrist.y }));
  let maxDist = 0;
  for (const p of shifted) {
    const d = Math.sqrt(p.x * p.x + p.y * p.y);
    if (d > maxDist) maxDist = d;
  }
  if (maxDist === 0) return new Array(24).fill(0);
  const vec = [];
  for (const p of shifted) { vec.push(p.x / maxDist, p.y / maxDist); }
  return vec;
}

function _defaultHandPoints() {
  return [
    { x: 0.50, y: 0.83 },
    { x: 0.37, y: 0.67 },
    { x: 0.28, y: 0.56 },
    { x: 0.44, y: 0.46 },
    { x: 0.43, y: 0.30 },
    { x: 0.50, y: 0.43 },
    { x: 0.50, y: 0.26 },
    { x: 0.57, y: 0.45 },
    { x: 0.57, y: 0.30 },
    { x: 0.63, y: 0.50 },
    { x: 0.65, y: 0.37 },
    { x: 0.50, y: 0.61 },
  ];
}

// 手数トグルUIを現在の _calibHands に合わせて更新
function _calibUpdateHandToggle() {
  document.querySelectorAll('.calib-hand-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.hands) === _calibHands);
  });
}

// referenceVecs から編集点を初期化（未登録時はデフォルト配置）
function _calibInitPoints(poseName) {
  const refData = referenceVecs[poseName];
  _calibHands = (refData && refData.hands === 2) ? 2 : 1;

  // 手0
  if (refData && refData.rawKeyPoints && refData.rawKeyPoints.length === 12) {
    _calibEditPoints = refData.rawKeyPoints.map(p => ({ x: p.x, y: p.y }));
  } else {
    _calibEditPoints = _defaultHandPoints();
  }

  // 手1（2手モード時）
  if (_calibHands === 2) {
    if (refData && refData.rawKeyPoints2 && refData.rawKeyPoints2.length === 12) {
      _calibEditPoints2 = refData.rawKeyPoints2.map(p => ({ x: p.x, y: p.y }));
    } else {
      _calibEditPoints2 = _calibEditPoints.map(p => ({
        x: Math.max(0, p.x - 0.25),
        y: p.y,
      }));
    }
  } else {
    _calibEditPoints2 = [];
  }

  _calibUpdateHandToggle();
}

// 1手の骨格をエディタキャンバスに描画（hand0: CALIB_STYLES_H0、hand1: CALIB_STYLES_H1）
function _calibDrawHand(ctx, w, h, base, points, styles, handIdx) {
  if (!points || points.length === 0) return;

  ctx.lineWidth   = Math.max(1, base * 0.006);
  ctx.strokeStyle = handIdx === 0 ? 'rgba(255,160,0,0.55)' : 'rgba(0,173,222,0.55)';
  for (const [a, b] of KEY_CONNECTIONS) {
    const pa = points[a];
    const pb = points[b];
    if (!pa || !pb) continue;
    ctx.beginPath();
    ctx.moveTo(pa.x * w, pa.y * h);
    ctx.lineTo(pb.x * w, pb.y * h);
    ctx.stroke();
  }

  points.forEach((pt, i) => {
    const style = styles[i];
    if (!style) return;
    const x = pt.x * w;
    const y = pt.y * h;
    const r = style.r * base;

    if (handIdx === _calibDragHand && i === _calibDragIdx) {
      ctx.beginPath();
      ctx.arc(x, y, r * 2.2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = style.color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth   = Math.max(1, base * 0.003);
    ctx.stroke();
  });
}

// エディタキャンバスを再描画
function _calibDrawEditor() {
  const canvas = document.getElementById('calib-canvas-edit');
  if (!canvas) return;
  const ctx  = canvas.getContext('2d');
  const w    = canvas.width;
  const h    = canvas.height;
  const base = Math.min(w, h);

  ctx.clearRect(0, 0, w, h);

  if (_calibEditImg && _calibEditImg.complete && _calibEditImg.naturalWidth > 0) {
    ctx.drawImage(_calibEditImg, 0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, w, h);
  }

  _calibDrawHand(ctx, w, h, base, _calibEditPoints,  CALIB_STYLES_H0, 0);
  if (_calibHands === 2) {
    _calibDrawHand(ctx, w, h, base, _calibEditPoints2, CALIB_STYLES_H1, 1);
  }

  // クリック選択中の点にラベルバブルを表示
  if (_calibLabelHand >= 0 && _calibLabelIdx >= 0 && POINT_LABELS[_calibLabelIdx]) {
    const pts = _calibLabelHand === 0 ? _calibEditPoints : _calibEditPoints2;
    const pt  = pts[_calibLabelIdx];
    if (pt) {
      const joint  = POINT_LABELS[_calibLabelIdx];
      const prefix = _calibHands === 2 ? (_calibLabelHand === 0 ? '右手 ' : '左手 ') : '';
      const text   = prefix + joint;
      const bgColor = _calibLabelHand === 0 ? 'rgba(200, 95, 0, 0.92)' : 'rgba(0, 110, 160, 0.92)';
      const fz     = Math.max(12, Math.round(base * 0.044));
      const padX = 10, padY = 5;
      ctx.font = `bold ${fz}px system-ui, sans-serif`;
      const tw = ctx.measureText(text).width;
      const bw = tw + padX * 2;
      const bh = fz + padY * 2;
      const px = pt.x * w;
      const py = pt.y * h;
      let bx = px - bw / 2;
      let by = py - bh - base * 0.055;
      bx = Math.max(2, Math.min(w - bw - 2, bx));
      if (by < 2) by = py + base * 0.04;
      ctx.fillStyle = bgColor;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 5);
      else ctx.rect(bx, by, bw, bh);
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, bx + bw / 2, by + bh / 2);
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'alphabetic';
    }
  }
}

// クリック座標に最も近い点を返す（どの手かも含む）
function _calibGetPointAt(cx, cy) {
  const canvas = document.getElementById('calib-canvas-edit');
  if (!canvas) return { hand: -1, idx: -1 };
  const w   = canvas.width;
  const h   = canvas.height;
  const HIT = Math.min(w, h) * 0.06;
  let bestHand = -1, bestIdx = -1, minDist = Infinity;

  const check = (points, styles, handIdx) => {
    points.forEach((pt, i) => {
      if (!styles[i]) return;
      const dx = cx - pt.x * w;
      const dy = cy - pt.y * h;
      const d  = Math.sqrt(dx * dx + dy * dy);
      if (d < HIT && d < minDist) { minDist = d; bestHand = handIdx; bestIdx = i; }
    });
  };

  check(_calibEditPoints, CALIB_STYLES_H0, 0);
  if (_calibHands === 2) check(_calibEditPoints2, CALIB_STYLES_H1, 1);
  return { hand: bestHand, idx: bestIdx };
}

// イベント座標をキャンバス内ピクセル座標に変換
function _calibCanvasPos(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  const src  = e.touches ? e.touches[0] : e;
  return {
    x: (src.clientX - rect.left) * (canvas.width  / rect.width),
    y: (src.clientY - rect.top)  * (canvas.height / rect.height),
  };
}

// クリックでラベルを表示するイベントをバインド（DOM 要素に1回のみ）
function _calibBindLabelEvents() {
  const canvas = document.getElementById('calib-canvas-edit');
  if (!canvas || canvas._calibLabelBound) return;
  canvas._calibLabelBound = true;
  canvas.addEventListener('click', (e) => {
    const { x, y } = _calibCanvasPos(e, canvas);
    const { hand, idx } = _calibGetPointAt(x, y);
    _calibLabelHand = hand;
    _calibLabelIdx  = idx;
    _calibDrawEditor();
  });
}

// ドラッグイベントをバインド（DOM 要素に1回のみ）
function _calibBindEditorEvents() {
  const canvas = document.getElementById('calib-canvas-edit');
  if (!canvas || canvas._calibBound) return;
  canvas._calibBound = true;

  const onStart = (e) => {
    e.preventDefault();
    const { x, y } = _calibCanvasPos(e, canvas);
    const { hand, idx } = _calibGetPointAt(x, y);
    _calibDragHand = hand;
    _calibDragIdx  = idx;
    canvas.style.cursor = idx >= 0 ? 'grabbing' : 'grab';
    _calibDrawEditor();
  };
  const onMove = (e) => {
    e.preventDefault();
    if (_calibDragIdx < 0 || _calibDragHand < 0) return;
    const { x, y } = _calibCanvasPos(e, canvas);
    const newPt = {
      x: Math.max(0, Math.min(1, x / canvas.width)),
      y: Math.max(0, Math.min(1, y / canvas.height)),
    };
    if (_calibDragHand === 0) _calibEditPoints[_calibDragIdx]  = newPt;
    else                      _calibEditPoints2[_calibDragIdx] = newPt;
    _calibDrawEditor();
  };
  const onEnd = (e) => {
    e.preventDefault();
    _calibDragHand = -1;
    _calibDragIdx  = -1;
    canvas.style.cursor = 'grab';
    _calibDrawEditor();
  };

  canvas.addEventListener('mousedown',  onStart, { passive: false });
  canvas.addEventListener('mousemove',  onMove,  { passive: false });
  canvas.addEventListener('mouseup',    onEnd,   { passive: false });
  canvas.addEventListener('mouseleave', onEnd,   { passive: false });
  canvas.addEventListener('touchstart', onStart, { passive: false });
  canvas.addEventListener('touchmove',  onMove,  { passive: false });
  canvas.addEventListener('touchend',   onEnd,   { passive: false });
}

function calibSelectPose(poseName) {
  _calibPose = poseName;
  document.querySelectorAll('.calib-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.pose === poseName);
  });
  _calibInitPoints(poseName);

  const poseData = allPoses.find(p => p.name === poseName);
  if (poseData) {
    const src = `assets/silhouettes/${poseData.answerImage ?? poseData.image}`;
    _calibEditImg = new Image();
    _calibEditImg.onload = () => _calibDrawEditor();
    _calibEditImg.src = src;
  }

  _calibLabelHand = -1;
  _calibLabelIdx  = -1;
  const el = document.getElementById('calib-status');
  if (el) el.textContent = '';
}

// 手数トグル（1手 / 2手）
function calibSetHands(n) {
  _calibHands     = n;
  _calibLabelHand = -1;
  _calibLabelIdx  = -1;
  _calibUpdateHandToggle();
  if (n === 2 && _calibEditPoints2.length === 0) {
    _calibEditPoints2 = _calibEditPoints.map(p => ({
      x: Math.max(0, p.x - 0.25),
      y: p.y,
    }));
  }
  _calibDrawEditor();
}

// 編集中の点位置をそのまま登録
function calibRegister() {
  if (_calibEditPoints.length !== 12) {
    _calibSetStatus('点が設定されていません', true);
    return;
  }
  const refData = {
    vec:          _computeVecFromPoints(_calibEditPoints),
    rawKeyPoints: _calibEditPoints.map(p => ({ x: p.x, y: p.y })),
    hands:        _calibHands,
  };
  if (_calibHands === 2 && _calibEditPoints2.length === 12) {
    refData.vec2          = _computeVecFromPoints(_calibEditPoints2);
    refData.rawKeyPoints2 = _calibEditPoints2.map(p => ({ x: p.x, y: p.y }));
  }
  referenceVecs[_calibPose] = refData;
  _saveCustomRef(_calibPose, refData);
  _calibSetStatus('登録しました！');
}

// 現在の編集点をこのポーズのデフォルトとして保存
function calibSaveDefault() {
  if (_calibEditPoints.length !== 12) {
    _calibSetStatus('点が設定されていません', true);
    return;
  }
  const defaultData = {
    rawKeyPoints: _calibEditPoints.map(p => ({ x: p.x, y: p.y })),
    hands: _calibHands,
  };
  if (_calibHands === 2 && _calibEditPoints2.length === 12) {
    defaultData.rawKeyPoints2 = _calibEditPoints2.map(p => ({ x: p.x, y: p.y }));
  }
  _saveDefaultRef(_calibPose, defaultData);
  _calibSetStatus('デフォルトとして保存しました！');
}

function calibReset() {
  const defaults = _loadDefaultRefs();
  const defaultData = defaults[_calibPose];

  if (defaultData) {
    // ユーザーが登録したデフォルトに戻す
    _calibHands = (defaultData.hands === 2) ? 2 : 1;
    if (defaultData.rawKeyPoints && defaultData.rawKeyPoints.length === 12) {
      _calibEditPoints = defaultData.rawKeyPoints.map(p => ({ x: p.x, y: p.y }));
    }
    if (_calibHands === 2 && defaultData.rawKeyPoints2 && defaultData.rawKeyPoints2.length === 12) {
      _calibEditPoints2 = defaultData.rawKeyPoints2.map(p => ({ x: p.x, y: p.y }));
    } else {
      _calibEditPoints2 = [];
    }
    _calibLabelHand = -1;
    _calibLabelIdx  = -1;
    _calibUpdateHandToggle();
    _calibDrawEditor();
    _calibSetStatus('デフォルトに戻しました');
  } else {
    // デフォルト未登録: 元画像から骨格を再抽出
    _deleteCustomRef(_calibPose);
    const poseData = allPoses.find(p => p.name === _calibPose);
    if (!poseData) return;
    const { extractFromImage } = window.PoseExtractorModule;
    extractFromImage(`assets/silhouettes/${poseData.image}`)
      .then(data => {
        if (data) {
          referenceVecs[_calibPose] = data;
          _calibInitPoints(_calibPose);
          _calibDrawEditor();
          _calibSetStatus('リセットしました');
        } else {
          _calibSetStatus('リセット失敗（骨格抽出できず）', true);
        }
      });
  }
}

// 登録済み骨格に対してカメラ手のリアルタイムスコアを計算（通常+ミラー反転の高い方）
function _calibComputeLiveScore(allLandmarks) {
  const refData = referenceVecs[_calibPose];
  if (!refData || !allLandmarks || allLandmarks.length === 0) return 0;
  const { calcScore7 } = window.PoseExtractorModule;

  if (refData.hands === 2 && refData.vec && refData.vec2) {
    if (allLandmarks.length >= 2) {
      // 両手検出: 組み合わせ(2通り) × ミラー(2通り) = 4通りの最大値
      const f0 = _flipVec(refData.vec), f1 = _flipVec(refData.vec2);
      const sA  = (calcScore7(allLandmarks[0], refData.vec)  + calcScore7(allLandmarks[1], refData.vec2)) / 2;
      const sB  = (calcScore7(allLandmarks[0], refData.vec2) + calcScore7(allLandmarks[1], refData.vec))  / 2;
      const sAf = (calcScore7(allLandmarks[0], f0) + calcScore7(allLandmarks[1], f1)) / 2;
      const sBf = (calcScore7(allLandmarks[0], f1) + calcScore7(allLandmarks[1], f0)) / 2;
      return Math.round(Math.max(sA, sB, sAf, sBf));
    }
    if (!allLandmarks[0]) return 0;
    // 片手のみ検出: 2つの正解それぞれにミラー込みで照合し高い方を採用
    const s0 = Math.max(calcScore7(allLandmarks[0], refData.vec),  calcScore7(allLandmarks[0], _flipVec(refData.vec)));
    const s1 = Math.max(calcScore7(allLandmarks[0], refData.vec2), calcScore7(allLandmarks[0], _flipVec(refData.vec2)));
    return Math.round(Math.max(s0, s1));
  }

  if (!allLandmarks[0] || !refData.vec) return 0;
  // 1手登録: 通常+ミラーの高い方
  return Math.round(Math.max(
    calcScore7(allLandmarks[0], refData.vec),
    calcScore7(allLandmarks[0], _flipVec(refData.vec))
  ));
}

function showCalibrateScreen() {
  showScreen('screen-calibrate');
  _ensureDetection();

  const editCanvas = document.getElementById('calib-canvas-edit');
  const camCanvas  = document.getElementById('calib-canvas-camera');
  const ovCanvas   = document.getElementById('calib-canvas-overlay');

  if (editCanvas) {
    const p = editCanvas.parentElement;
    editCanvas.width  = (p && p.clientWidth  > 0) ? p.clientWidth  : 480;
    editCanvas.height = (p && p.clientHeight > 0) ? p.clientHeight : 480;
    _calibBindEditorEvents();
    _calibBindLabelEvents();
  }
  if (camCanvas) {
    const p = camCanvas.parentElement;
    camCanvas.width  = (p && p.clientWidth  > 0) ? p.clientWidth  : 480;
    camCanvas.height = (p && p.clientHeight > 0) ? p.clientHeight : 480;
  }
  if (ovCanvas && camCanvas) {
    ovCanvas.width  = camCanvas.width;
    ovCanvas.height = camCanvas.height;
  }

  calibSelectPose(_calibPose);

  const camCtx  = camCanvas?.getContext('2d');
  const ovCtx   = ovCanvas?.getContext('2d');
  const scoreEl = document.getElementById('calib-score');
  const { drawVideoFrame, drawLandmarks } = window.CameraModule;

  currentDetectionCb = (allLandmarks) => {
    _calibLandmarks = allLandmarks;
    if (camCtx && camCanvas) drawVideoFrame(camCtx);
    if (ovCtx && ovCanvas) {
      ovCtx.clearRect(0, 0, ovCanvas.width, ovCanvas.height);
      if (allLandmarks) {
        for (let i = 0; i < allLandmarks.length; i++) {
          drawLandmarks(allLandmarks[i], ovCtx, i);
        }
      }
    }
    // 登録済み骨格に対するリアルタイムスコア表示
    if (scoreEl) {
      const hasHand = allLandmarks && allLandmarks.length > 0;
      if (!hasHand) {
        scoreEl.textContent = '---';
        scoreEl.style.color = 'var(--text)';
      } else {
        const s = _calibComputeLiveScore(allLandmarks);
        scoreEl.textContent = String(s);
        scoreEl.style.color = s >= 80 ? 'var(--accent-yellow)' : 'var(--text)';
      }
    }
  };
}

function exitCalibrateScreen() {
  currentDetectionCb = null;
  _calibLandmarks    = null;
  _calibEditImg      = null;
  _calibEditPoints2  = [];
  showScreen('screen-title');
}

window.GameModule = {
  initGame, startGame, startTutorial, showResult, showArtCanvas,
  showCalibrateScreen, exitCalibrateScreen,
  calibSelectPose, calibSetHands, calibRegister, calibSaveDefault, calibReset,
};
