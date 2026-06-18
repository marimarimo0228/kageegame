// js/effects.js — スコア80点以上時のポーズ別エフェクト
// 外部ライブラリ不使用。Canvas 2D API + Web Audio API のみ。

let audioCtx   = null;
let wasAbove80 = false;
let spawnTimer = 0;

// パーティクル配列
let dogTexts     = [];
let birdFeathers = [];
let crabBubbles  = [];

// ─── 初期化 ──────────────────────────────────────────────────

function initEffects(_canvas) {
  dogTexts     = [];
  birdFeathers = [];
  crabBubbles  = [];
  wasAbove80   = false;
  spawnTimer   = 0;
}

// ─── 音声生成 ─────────────────────────────────────────────────

function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
}

function playDogSound() {
  ensureAudio();
  // 440Hz → 880Hz に素早く上昇するビープ × 2（ワンワン）
  for (let i = 0; i < 2; i++) {
    const t    = audioCtx.currentTime + i * 0.22;
    const osc  = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.setValueAtTime(440, t);
    osc.frequency.exponentialRampToValueAtTime(880, t + 0.10);
    gain.gain.setValueAtTime(0.30, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    osc.start(t);
    osc.stop(t + 0.14);
  }
}

function playBirdSound() {
  ensureAudio();
  // 200Hz の短いバースト × 3（パタパタ）
  for (let i = 0; i < 3; i++) {
    const t    = audioCtx.currentTime + i * 0.09;
    const osc  = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.value = 200;
    gain.gain.setValueAtTime(0.28, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    osc.start(t);
    osc.stop(t + 0.06);
  }
}

function playCrabSound() {
  ensureAudio();
  // 80Hz のサwtooth でブクブク感を0.5秒
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.type          = 'sawtooth';
  osc.frequency.value = 80;
  gain.gain.setValueAtTime(0.22, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5);
  osc.start(audioCtx.currentTime);
  osc.stop(audioCtx.currentTime + 0.5);
}

function playEffectSound(pose) {
  try {
    if      (pose === 'dog')  playDogSound();
    else if (pose === 'bird') playBirdSound();
    else if (pose === 'crab') playCrabSound();
  } catch (_) {}
}

// ─── パーティクル生成 ─────────────────────────────────────────

function spawnDogText(lm, canvasW, canvasH) {
  if (dogTexts.length >= 3) return;
  dogTexts.push({
    x:       lm.x * canvasW,
    y:       lm.y * canvasH,
    vy:      -1.3,
    alpha:   1.0,
    life:    0,
    maxLife: 72,
  });
}

function spawnBirdFeather(lm, canvasW, canvasH) {
  if (birdFeathers.length >= 20) return;
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

function spawnCrabBubble(lm, canvasW, canvasH) {
  if (crabBubbles.length >= 15) return;
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
  if (score >= 80) {
    // 80点を超えた瞬間のみ音を鳴らす
    if (!wasAbove80) {
      playEffectSound(pose);
      wasAbove80 = true;
    }

    // パーティクルをスポーン（間引きタイマーで制御）
    spawnTimer++;
    if (landmarks) {
      if (pose === 'dog' && (dogTexts.length === 0 || spawnTimer % 35 === 0)) {
        // 薬指MCP(13) と 小指MCP(17) の中間から出す
        const mid = {
          x: (landmarks[13].x + landmarks[17].x) / 2,
          y: (landmarks[13].y + landmarks[17].y) / 2,
        };
        spawnDogText(mid, canvasW, canvasH);
      }
      if (pose === 'bird' && spawnTimer % 4 === 0) {  // 6→4: やや多めに生成
        spawnBirdFeather(landmarks[9], canvasW, canvasH);
      }
      if (pose === 'crab' && spawnTimer % 4 === 0) {
        spawnCrabBubble(landmarks[0], canvasW, canvasH);
      }
    }
  } else {
    // 80点を下回ったら即クリア（次回80点超えで音が再び鳴る）
    if (wasAbove80) clearParticles();
    wasAbove80 = false;
  }

  // 毎フレーム: 更新 → クリア → 描画
  updateParticles();
  ctx.clearRect(0, 0, canvasW, canvasH);

  if      (pose === 'dog')  drawDogTexts(ctx);
  else if (pose === 'bird') drawBirdFeathers(ctx);
  else if (pose === 'crab') drawCrabBubbles(ctx);
}

/**
 * 問題終了時にパーティクルと描画をリセットする。
 */
function clearEffects(ctx, canvasW, canvasH) {
  clearParticles();
  wasAbove80 = false;
  if (ctx) ctx.clearRect(0, 0, canvasW, canvasH);
}

window.EffectsModule = { initEffects, updateEffect, clearEffects };
