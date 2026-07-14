// js/effects.js — スコア80点以上時のポーズ別エフェクト
// 外部ライブラリ不使用。Canvas 2D API + Web Audio API のみ。

let audioCtx   = null;
let lastTier   = 0;
let spawnTimer = 0;

// 犬の鳴き声サイクル管理（残りフレーム数。0以下で次の「ワンワン」を発火）
let dogBarkTimer = 0;
const DOG_BARK_INTERVAL = 90; // 約1.5秒ごとに鳴き声＋表示を同期発火

// 鳥エフェクト用の羽画像
const featherImg = new Image();
featherImg.src = 'assets/hane.png';

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
  1: { maxDog: 2, maxBird: 4,  maxCrab: 6,  spawnEvery: 8 },
  2: { maxDog: 3, maxBird: 8,  maxCrab: 12, spawnEvery: 5 },
  3: { maxDog: 4, maxBird: 13, maxCrab: 20, spawnEvery: 3 },
};

// ─── 初期化 ──────────────────────────────────────────────────

function initEffects(_canvas) {
  dogTexts     = [];
  birdFeathers = [];
  crabBubbles  = [];
  lastTier     = 0;
  spawnTimer   = 0;
  dogBarkTimer = 0;
}

// ─── 音声生成 ─────────────────────────────────────────────────

function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
}

// tier (1〜3) が高いほどピッチが上がり「決まった」感が強まる
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

// 犬は合成音（機械音）を使わず、鳴き声ファイル（great-dog.mp3）のみで鳴らす
function playEffectSound(pose, tier = 1) {
  try {
    if      (pose === 'bird') playBirdSound(tier);
    else if (pose === 'crab') playCrabSound(tier);
  } catch (_) {}
}

// ─── 音声ファイル再生（80点超え専用の差し替えサウンド）───────────────

const _effectsAudioFileCache = {};
function playEffectsSoundFile(path, volume = 1) {
  try {
    let audio = _effectsAudioFileCache[path];
    if (!audio) {
      audio = new Audio(path);
      _effectsAudioFileCache[path] = audio;
    }
    audio.currentTime = 0;
    audio.volume = volume;
    audio.play().catch(() => {});
  } catch (_) {}
}

// pose (dog|bird|crab) が80点を超えた瞬間に鳴らす専用サウンド
function playGreatSound(pose) {
  playEffectsSoundFile(`assets/sounds/great-${pose}.mp3`);
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

// visualDir: 1 = 画面上で右向き, -1 = 画面上で左向き
// 描画側は座標系がミラーされている（drawDogTexts 参照）ため、
// 画面上で右に動かすには raw 座標の x を減らす（負の vx）必要がある。
function spawnDogText(lm, canvasW, canvasH, maxCount = 3, visualDir = 1) {
  if (dogTexts.length >= maxCount) return;
  // 口(中央付近)から画面の縁近くまでを 0.8秒(≒48フレーム@60fps)で移動する速度
  // （鳴き声「ワンワン」のおおよその長さに合わせて表示する）
  const speed = (canvasW * 0.42) / 48;
  dogTexts.push({
    x:       lm.x * canvasW,
    y:       lm.y * canvasH,
    vx:      -visualDir * speed,
    vy:      -1.3,
    alpha:   1.0,
    life:    0,
    maxLife: 48,
  });
}

function spawnBirdFeather(lm, canvasW, canvasH, maxCount = 20) {
  if (birdFeathers.length >= maxCount) return;
  const side = Math.random() < 0.5 ? -1 : 1;   // 左右どちらかにランダムに散る
  birdFeathers.push({
    x:       lm.x * canvasW + (Math.random() - 0.5) * 50,
    y:       lm.y * canvasH + (Math.random() - 0.5) * 30,
    vx:      side * (2 + Math.random() * 3),    // 横方向にふわっと散る
    vy:      -(1 + Math.random() * 1),          // 散った一瞬だけ軽く上に跳ねる
    angle:   (Math.random() - 0.5) * 0.6,       // 基本の傾き（画像なので緩やかに）
    swayAmp: 1.2 + Math.random() * 1.2,         // 左右揺れの振れ幅
    phase:   Math.random() * Math.PI * 2,
    size:    120 + Math.random() * 72,          // 描画サイズ(px)（視認性重視で大きめ）
    flip:    Math.random() < 0.5 ? -1 : 1,      // 左右反転をランダムに
    life:    0,
    maxLife: 150 + Math.random() * 50,          // ゆっくり落ちるぶん寿命も長く
  });
}

function spawnCrabBubble(lm, canvasW, canvasH, maxCount = 15) {
  if (crabBubbles.length >= maxCount) return;
  crabBubbles.push({
    x:       lm.x * canvasW + (Math.random() - 0.5) * 64,
    y:       lm.y * canvasH,
    vy:      -(1.2 + Math.random() * 2.7),   // 動きを大きく（旧の約3倍）
    r:       8 + Math.random() * 16,         // サイズ約4倍（旧: 2〜6 → 8〜24）
    life:    0,
    maxLife: 100 + Math.random() * 40,
  });
}

// ─── パーティクル更新 ─────────────────────────────────────────

function updateParticles() {
  dogTexts = dogTexts.filter((p) => {
    p.x    += p.vx;
    p.y    += p.vy;
    p.life += 1;
    p.alpha = Math.max(0, 1 - p.life / p.maxLife);
    return p.life < p.maxLife;
  });

  birdFeathers = birdFeathers.filter((p) => {
    p.phase += 0.07;
    p.vx    *= 0.96;                            // 空気抵抗で横速度を徐々に減衰
    p.vy    += 0.06;                            // 弱い重力でゆっくり落下に転じる
    if (p.vy > 1.1) p.vy = 1.1;                 // 終端速度を抑えてひらひら感を出す
    p.x     += p.vx + Math.sin(p.phase) * p.swayAmp; // 左右にゆらゆら揺れながら落ちる
    p.y     += p.vy;
    p.life  += 1;
    return p.life < p.maxLife;
  });

  crabBubbles = crabBubbles.filter((p) => {
    p.x   += Math.sin(p.life * 0.08) * 1.2;  // 蛇行を大きく
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
  dogBarkTimer = 0;  // 次回突入時にすぐ鳴き声＋表示が出る
}

// ─── 描画 ────────────────────────────────────────────────────

function drawDogTexts(ctx) {
  ctx.save();
  // CSS の scaleX(-1) を打ち消して文字を正立させる
  ctx.scale(-1, 1);
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.font         = 'bold 44px system-ui, sans-serif';
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
  if (!featherImg.complete || featherImg.naturalWidth === 0) return; // 画像読み込み前は描かない
  ctx.save();
  // CSS の scaleX(-1) を打ち消して画像を正しい向きで描く
  ctx.scale(-1, 1);
  for (const p of birdFeathers) {
    const ratio = p.life / p.maxLife;
    // 後半は不透明度を下げながら消えていく
    ctx.globalAlpha = ratio < 0.55 ? 1 : Math.max(0, 1 - (ratio - 0.55) / 0.45);
    ctx.save();
    ctx.translate(-p.x, p.y);  // x を反転
    ctx.rotate(p.angle + Math.sin(p.phase) * 0.45); // 揺れに合わせて傾きも往復
    ctx.scale(p.flip, 1);
    ctx.drawImage(featherImg, -p.size / 2, -p.size / 2, p.size, p.size);
    ctx.restore();
  }
  ctx.restore();
}

function drawCrabBubbles(ctx) {
  ctx.save();
  for (const p of crabBubbles) {
    const ratio = p.life / p.maxLife;
    ctx.globalAlpha  = (1 - ratio) * 0.95;
    ctx.strokeStyle  = 'rgba(255,255,255,0.95)';
    ctx.fillStyle    = 'rgba(255,255,255,0.35)';
    ctx.lineWidth    = 2;
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
 * @param {Array<object>|null} landmarksAll  検出された手ごとの21点配列（[hand0, hand1]）
 * @param {CanvasRenderingContext2D} ctx  オーバーレイCanvas の 2D コンテキスト
 * @param {number} canvasW
 * @param {number} canvasH
 */
function updateEffect(pose, score, landmarksAll, ctx, canvasW, canvasH) {
  const tier  = getScoreTier(score);
  const hand0 = landmarksAll && landmarksAll[0] ? landmarksAll[0] : null;
  const hand1 = landmarksAll && landmarksAll[1] ? landmarksAll[1] : null;

  if (tier > 0) {
    // 段位が上がった瞬間だけ音を鳴らす（犬は鳴き声サイクル側で鳴らすので除外）
    if (tier > lastTier && pose !== 'dog') {
      playEffectSound(pose, tier);
      // 80点（tier2）に初めて到達した瞬間は専用サウンドも重ねる
      if (tier >= 2 && lastTier < 2) {
        playGreatSound(pose);
      }
    }

    const p = TIER_PARAM[tier];
    // パーティクルをスポーン（段位が高いほど頻度・上限が増える）
    spawnTimer++;
    if (hand0) {
      if (pose === 'dog') {
        // 鳴き声（great-dog.mp3）と「ワンワン」表示を同じタイミングで発火させる
        dogBarkTimer--;
        if (dogBarkTimer <= 0) {
          // 薬指MCP(13) と 小指MCP(17) の中間から出す
          const mid = {
            x: (hand0[13].x + hand0[17].x) / 2,
            y: (hand0[13].y + hand0[17].y) / 2,
          };
          // 手首(0)より鼻先(mid)が raw 座標で小さい x にある場合、画面上では右向き
          const visualDir = mid.x < hand0[0].x ? 1 : -1;
          playGreatSound('dog');
          spawnDogText(mid, canvasW, canvasH, p.maxDog, visualDir);
          dogBarkTimer = DOG_BARK_INTERVAL;
        }
      }
      if (pose === 'bird' && spawnTimer % p.spawnEvery === 0) {
        // 羽の外側から出すため、両手の小指(先端)から発生させる
        spawnBirdFeather(hand0[20], canvasW, canvasH, p.maxBird);
        if (hand1) spawnBirdFeather(hand1[20], canvasW, canvasH, p.maxBird);
      }
      if (pose === 'crab' && spawnTimer % p.spawnEvery === 0) {
        // カニの中央上部（人差し指の付け根 = MCP）から出す
        spawnCrabBubble(hand0[5], canvasW, canvasH, p.maxCrab);
      }
    }
  } else {
    // 段位から外れても既存のパーティクルは消さず、寿命まで表示し続ける。
    // タイマーだけリセットし、次回突入時に犬の鳴き声がすぐ出るようにする。
    if (lastTier > 0) {
      spawnTimer   = 0;
      dogBarkTimer = 0;
    }
  }
  lastTier = tier;

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
  lastTier = 0;
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
