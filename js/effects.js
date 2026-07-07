// js/effects.js — スコア80点以上時のポーズ別エフェクト
// 外部ライブラリ不使用。Canvas 2D API + Web Audio API のみ。

let audioCtx   = null;
let lastTier   = 0;
let spawnTimer = 0;
let flashAlpha = 0; // スコア段位が上がった瞬間の画面フラッシュ（0〜1）

// パーティクル配列
let dogTexts     = [];
let birdFeathers = [];
let crabBubbles  = [];

// ─── スコア段位（1: 60点〜 / 2: 80点〜 / 3: 95点〜）─────────────

function getScoreTier(score) {
  if (score >= 95) return 3;
  if (score >= 80) return 2;
  if (score >= 60) return 1;
  return 0;
}

// 段位ごとのパーティクル上限・生成間隔（フレーム数）
const TIER_PARAM = {
  1: { maxDog: 2, maxBird: 8,  maxCrab: 6,  spawnEvery: 8 },
  2: { maxDog: 3, maxBird: 16, maxCrab: 12, spawnEvery: 5 },
  3: { maxDog: 4, maxBird: 26, maxCrab: 20, spawnEvery: 3 },
};

// ─── 初期化 ──────────────────────────────────────────────────

function initEffects(_canvas) {
  dogTexts     = [];
  birdFeathers = [];
  crabBubbles  = [];
  lastTier     = 0;
  spawnTimer   = 0;
  flashAlpha   = 0;
}

// ─── 音声生成 ─────────────────────────────────────────────────

function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
}

// tier (1〜3) が高いほどピッチが上がり「決まった」感が強まる
function playDogSound(tier = 1) {
  ensureAudio();
  const pitchUp = 1 + (tier - 1) * 0.18;
  // 440Hz → 880Hz に素早く上昇するビープ × 2（ワンワン）
  for (let i = 0; i < 2; i++) {
    const t    = audioCtx.currentTime + i * 0.22;
    const osc  = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.setValueAtTime(440 * pitchUp, t);
    osc.frequency.exponentialRampToValueAtTime(880 * pitchUp, t + 0.10);
    gain.gain.setValueAtTime(0.30, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    osc.start(t);
    osc.stop(t + 0.14);
  }
}

function playBirdSound(tier = 1) {
  ensureAudio();
  const pitchUp = 1 + (tier - 1) * 0.18;
  // 200Hz の短いバースト × 3（パタパタ）
  for (let i = 0; i < 3; i++) {
    const t    = audioCtx.currentTime + i * 0.09;
    const osc  = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.value = 200 * pitchUp;
    gain.gain.setValueAtTime(0.28, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    osc.start(t);
    osc.stop(t + 0.06);
  }
}

function playCrabSound(tier = 1) {
  ensureAudio();
  const pitchUp = 1 + (tier - 1) * 0.18;
  // 80Hz のサwtooth でブクブク感を0.5秒
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.type          = 'sawtooth';
  osc.frequency.value = 80 * pitchUp;
  gain.gain.setValueAtTime(0.22, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5);
  osc.start(audioCtx.currentTime);
  osc.stop(audioCtx.currentTime + 0.5);
}

function playEffectSound(pose, tier = 1) {
  try {
    if      (pose === 'dog')  playDogSound(tier);
    else if (pose === 'bird') playBirdSound(tier);
    else if (pose === 'crab') playCrabSound(tier);
  } catch (_) {}
}

// パーフェクトコンボ達成時のファンファーレ（上昇アルペジオ）
function playPerfectComboSound() {
  try {
    ensureAudio();
    const notes = [523.25, 659.25, 783.99, 1046.50]; // C5-E5-G5-C6
    notes.forEach((freq, i) => {
      const t    = audioCtx.currentTime + i * 0.12;
      const osc  = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.type = 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.30, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      osc.start(t);
      osc.stop(t + 0.35);
    });
  } catch (_) {}
}

// ─── パーティクル生成 ─────────────────────────────────────────

function spawnDogText(lm, canvasW, canvasH, maxCount = 3) {
  if (dogTexts.length >= maxCount) return;
  dogTexts.push({
    x:       lm.x * canvasW,
    y:       lm.y * canvasH,
    vy:      -1.3,
    alpha:   1.0,
    life:    0,
    maxLife: 72,
  });
}

function spawnBirdFeather(lm, canvasW, canvasH, maxCount = 20) {
  if (birdFeathers.length >= maxCount) return;
  const side = Math.random() < 0.5 ? -1 : 1;   // 左右どちらかにランダムに散る
  birdFeathers.push({
    x:       lm.x * canvasW + (Math.random() - 0.5) * 50,
    y:       lm.y * canvasH + (Math.random() - 0.5) * 30,
    vx:      side * (3 + Math.random() * 5),    // 横方向に強く飛び散る
    vy:      (Math.random() - 0.5) * 1.5,       // 縦方向は弱め
    angle:   Math.random() * Math.PI * 2,
    angVel:  (Math.random() - 0.5) * 0.22,
    phase:   Math.random() * Math.PI * 2,
    life:    0,
    maxLife: 90,
  });
}

function spawnCrabBubble(lm, canvasW, canvasH, maxCount = 15) {
  if (crabBubbles.length >= maxCount) return;
  crabBubbles.push({
    x:       lm.x * canvasW + (Math.random() - 0.5) * 32,
    y:       lm.y * canvasH,
    vy:      -(0.4 + Math.random() * 0.9),
    r:       2 + Math.random() * 4,
    life:    0,
    maxLife: 100 + Math.random() * 40,
  });
}

// ─── パーティクル更新 ─────────────────────────────────────────

function updateParticles() {
  dogTexts = dogTexts.filter((p) => {
    p.y    += p.vy;
    p.life += 1;
    p.alpha = Math.max(0, 1 - p.life / p.maxLife);
    return p.life < p.maxLife;
  });

  birdFeathers = birdFeathers.filter((p) => {
    p.phase += 0.15;
    p.vx    *= 0.96;                            // 空気抵抗で横速度を徐々に減衰
    p.x     += p.vx;
    p.y     += p.vy + Math.sin(p.phase) * 0.4; // ひらひら縦揺れ
    p.angle += p.angVel;
    p.life  += 1;
    return p.life < p.maxLife;
  });

  crabBubbles = crabBubbles.filter((p) => {
    p.x   += Math.sin(p.life * 0.10) * 0.4;  // 小さな蛇行
    p.y   += p.vy;
    p.life += 1;
    return p.life < p.maxLife;
  });
}

function clearParticles() {
  dogTexts     = [];
  birdFeathers = [];
  crabBubbles  = [];
  spawnTimer   = 0;
}

// ─── 画面フラッシュ（段位アップ時の"決まった"演出）────────────────

function triggerFlash() {
  flashAlpha = 1;
}

function drawFlash(ctx, canvasW, canvasH) {
  if (flashAlpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = flashAlpha * 0.55;
  ctx.fillStyle   = '#FFFFFF';
  ctx.fillRect(0, 0, canvasW, canvasH);
  ctx.restore();
  flashAlpha = Math.max(0, flashAlpha - 0.09);
}

// ─── 描画 ────────────────────────────────────────────────────

function drawDogTexts(ctx) {
  ctx.save();
  // CSS の scaleX(-1) を打ち消して文字を正立させる
  ctx.scale(-1, 1);
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.font         = 'bold 28px system-ui, sans-serif';
  ctx.lineJoin     = 'round';
  for (const p of dogTexts) {
    ctx.globalAlpha  = p.alpha;
    ctx.lineWidth    = 5;
    ctx.strokeStyle  = 'rgba(0,0,0,0.85)';
    ctx.strokeText('ワンワン', -p.x, p.y);  // x を反転
    ctx.fillStyle    = '#FFFFFF';
    ctx.fillText('ワンワン', -p.x, p.y);
  }
  ctx.restore();
}

function drawBirdFeathers(ctx) {
  ctx.save();
  for (const p of birdFeathers) {
    const alpha = 1 - p.life / p.maxLife;
    ctx.globalAlpha = alpha;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);
    // ひらひら感を演出（最小幅 0.3 を確保して消えすぎを防ぐ）
    ctx.scale(Math.abs(Math.sin(p.phase)) + 0.3, 1);
    ctx.beginPath();
    ctx.ellipse(0, 0, 20, 9, 0, 0, Math.PI * 2);  // 大きな羽（旧: 8×4）
    ctx.fillStyle    = '#FFFFFF';
    ctx.fill();
    ctx.strokeStyle  = 'rgba(180, 210, 255, 0.55)';
    ctx.lineWidth    = 1.5;
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

function drawCrabBubbles(ctx) {
  ctx.save();
  for (const p of crabBubbles) {
    const ratio = p.life / p.maxLife;
    ctx.globalAlpha  = (1 - ratio) * 0.65;
    ctx.strokeStyle  = 'rgba(255,255,255,0.85)';
    ctx.fillStyle    = 'rgba(255,255,255,0.15)';
    ctx.lineWidth    = 1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

// ─── メイン API ──────────────────────────────────────────────

/**
 * 毎フレーム呼び出す。スコアに応じてエフェクトを更新・描画する。
 * @param {string} pose        現在のお題ポーズ名 ("dog"|"bird"|"crab")
 * @param {number} score       現在のスコア (0〜100)
 * @param {object|null} landmarks  MediaPipe の21点配列 (landmarks[0〜20])
 * @param {CanvasRenderingContext2D} ctx  オーバーレイCanvas の 2D コンテキスト
 * @param {number} canvasW
 * @param {number} canvasH
 */
function updateEffect(pose, score, landmarks, ctx, canvasW, canvasH) {
  const tier = getScoreTier(score);

  if (tier > 0) {
    // 段位が上がった瞬間だけ音を鳴らす（2段目以上は画面フラッシュも）
    if (tier > lastTier) {
      playEffectSound(pose, tier);
      if (tier >= 2) triggerFlash();
    }

    const p = TIER_PARAM[tier];
    // パーティクルをスポーン（段位が高いほど頻度・上限が増える）
    spawnTimer++;
    if (landmarks) {
      if (pose === 'dog' && (dogTexts.length === 0 || spawnTimer % Math.max(10, 35 - tier * 8) === 0)) {
        // 薬指MCP(13) と 小指MCP(17) の中間から出す
        const mid = {
          x: (landmarks[13].x + landmarks[17].x) / 2,
          y: (landmarks[13].y + landmarks[17].y) / 2,
        };
        spawnDogText(mid, canvasW, canvasH, p.maxDog);
      }
      if (pose === 'bird' && spawnTimer % p.spawnEvery === 0) {
        spawnBirdFeather(landmarks[9], canvasW, canvasH, p.maxBird);
      }
      if (pose === 'crab' && spawnTimer % p.spawnEvery === 0) {
        spawnCrabBubble(landmarks[0], canvasW, canvasH, p.maxCrab);
      }
    }
  } else {
    // 段位から外れたら即クリア（次回突入時に音が再び鳴る）
    if (lastTier > 0) clearParticles();
  }
  lastTier = tier;

  // 毎フレーム: 更新 → クリア → 描画
  updateParticles();
  ctx.clearRect(0, 0, canvasW, canvasH);

  if      (pose === 'dog')  drawDogTexts(ctx);
  else if (pose === 'bird') drawBirdFeathers(ctx);
  else if (pose === 'crab') drawCrabBubbles(ctx);

  drawFlash(ctx, canvasW, canvasH);
}

/**
 * 問題終了時にパーティクルと描画をリセットする。
 */
function clearEffects(ctx, canvasW, canvasH) {
  clearParticles();
  lastTier   = 0;
  flashAlpha = 0;
  if (ctx) ctx.clearRect(0, 0, canvasW, canvasH);
}

// ─── パーフェクトコンボ演出（結果画面）──────────────────────────

/**
 * 全問80点以上だった際に結果画面で再生する紙吹雪演出。
 * @param {HTMLCanvasElement} canvas  結果画面いっぱいに広がるエフェクト用キャンバス
 * @param {number} [duration=2200] ミリ秒
 * @returns {Promise<void>}
 */
function playPerfectCombo(canvas, duration = 2200) {
  return new Promise((resolve) => {
    if (!canvas) { resolve(); return; }
    const ctx = canvas.getContext('2d');
    const w   = canvas.width;
    const h   = canvas.height;

    playPerfectComboSound();

    const colors = ['#E8472A', '#E8A020', '#5DCAA5', '#3498DB', '#E879F9'];
    const confetti = Array.from({ length: 90 }, () => ({
      x:      Math.random() * w,
      y:      -20 - Math.random() * h * 0.5,
      vx:     (Math.random() - 0.5) * 2.2,
      vy:     2 + Math.random() * 3,
      size:   4 + Math.random() * 6,
      angle:  Math.random() * Math.PI * 2,
      angVel: (Math.random() - 0.5) * 0.3,
      color:  colors[Math.floor(Math.random() * colors.length)],
    }));

    const startTime = performance.now();

    const frame = (now) => {
      const elapsed = now - startTime;
      ctx.clearRect(0, 0, w, h);

      for (const p of confetti) {
        p.x     += p.vx;
        p.y     += p.vy;
        p.angle += p.angVel;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      }

      if (elapsed < duration) {
        requestAnimationFrame(frame);
      } else {
        ctx.clearRect(0, 0, w, h);
        resolve();
      }
    };
    requestAnimationFrame(frame);
  });
}

window.EffectsModule = { initEffects, updateEffect, clearEffects, playPerfectCombo };
