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
let _gameAborted = false;

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
 * 一致度スコア(0〜100)を赤(不一致)→黄→緑(一致)のグラデーション色に変換する。
 */
function scoreToPointColor(score) {
  const s = Math.max(0, Math.min(100, score));
  let r, g;
  if (s < 50) { r = 255; g = Math.round(255 * (s / 50)); }
  else        { r = Math.round(255 * (1 - (s - 50) / 50)); g = 255; }
  return `rgb(${r}, ${g}, 70)`;
}

/**
 * 読み込み済みのお題画像 + 参照骨格ポイントを canvas に描画する。
 * pointScores を渡すと、各ポイントの色をお手本との一致度に応じて変化させる
 * （毎フレーム呼び出してリアルタイムフィードバックとして使う想定）。
 */
function drawQuestionDots(canvas, img, rawKeyPoints, pointScores) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.drawImage(img, 0, 0, w, h);
  if (!rawKeyPoints || rawKeyPoints.length === 0) return;

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
    ctx.fillStyle = pointScores ? scoreToPointColor(pointScores[i]) : style.color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.lineWidth   = base * 0.003;
    ctx.stroke();
  });
}

/**
 * お題画像を読み込み、canvas に描画する。読み込んだ Image を resolve する
 * （毎フレームの再描画で使い回すため）。
 */
function drawQuestionCanvas(canvas, imageSrc, rawKeyPoints) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      drawQuestionDots(canvas, img, rawKeyPoints, null);
      resolve(img);
    };
    img.onerror = () => resolve(null);
    img.src = imageSrc;
  });
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
  
  // すべての画面でキャンバスとキャラ画像を非表示（チュートリアルが個別に表示制御）
  const canvasArt = document.getElementById('canvas-art');
  const titleCharacter = document.querySelector('.title-character');
  if (canvasArt) canvasArt.style.display = 'none';
  if (titleCharacter) titleCharacter.style.display = 'none';
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

// ─── 音声ファイル再生（カウントダウン・最終スコア等の差し替え用）───────

const _audioFileCache = {};
function playSoundFile(path, volume = 1) {
  try {
    let audio = _audioFileCache[path];
    if (!audio) {
      audio = new Audio(path);
      _audioFileCache[path] = audio;
    }
    audio.currentTime = 0;
    audio.volume = volume;
    audio.play().catch(() => {});
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

// ─── ポーズごとのハードコードデフォルト骨格（全環境共通）─────────────

const POSE_DEFAULT_REFS = {
  // チョキ（人差指・中指を立てたVサイン）— 1手ポーズ
  choki: {
    hands: 1,
    vec: [0,0,-0.4741759287328186,-0.3755367068466872,-0.37272433467835514,-0.17936081521035804,-0.11468441067026307,-0.6641955188258573,-0.10806800236236327,-0.9304342289037324,-0.3308204153949897,-0.6501829551375481,-0.46976498986088544,-0.8827915123634812,-0.4455048260652529,-0.49043972909082273,-0.3175875987791902,-0.3306965030440977,0.04631485815529857,-0.28025127376618447,-0.0683695525149645,-0.24101609543891866,-0.16982114656942815,-0.3951542960103202],
    rawKeyPoints: [
      {x:0.7018763029881862, y:0.7627904409735636},
      {x:0.4030576789437109, y:0.526132788785253},
      {x:0.46699096594857537, y:0.6497599205254153},
      {x:0.6296038915913829, y:0.3442242949390143},
      {x:0.6337734537873523, y:0.1764446161487941},
      {x:0.49339819318971506, y:0.35305480434902586},
      {x:0.4058373870743572, y:0.20646834814283346},
      {x:0.4211257817929117, y:0.4537226116231581},
      {x:0.5017373175816539, y:0.5543904188972901},
      {x:0.7310632383599721, y:0.5861802527733319},
      {x:0.6587908269631688, y:0.6109056791213643},
      {x:0.5948575399583043, y:0.5137700756112368},
    ],
  },
  dog: {
    hands: 1,
    vec: [0,0,-0.11244041172131175,-0.5084581982320397,-0.10035004486955788,-0.676169541104388,-0.5247219213661222,-0.41395418756587526,-0.7205858643645365,-0.5097892406357886,-0.6577159567354159,-0.37402291545341143,-0.8910600369742674,-0.4538854596783391,-0.715749717623835,-0.2515670143085221,-0.8838058168632151,-0.3287674737259524,-0.6057273792728739,-0.031945017689970996,-0.8209359092340945,0.021296678459980893,-0.2684061441089381,-0.18900802133232877],
    rawKeyPoints: [
      {x:0.707307542008597,  y:0.7058965878841654},
      {x:0.6346228995701446, y:0.3772149175875884},
      {x:0.6424384525205158, y:0.26880159178295826},
      {x:0.36811254396248533,y:0.4383049662552768},
      {x:0.24150058616647127,y:0.3763544943669167},
      {x:0.2821414615084017, y:0.46411766287542683},
      {x:0.13130128956623682,y:0.4124922696351268},
      {x:0.24462680734661973,y:0.5432765991772204},
      {x:0.13599062133645953,y:0.49337205237826354},
      {x:0.315748339194998,  y:0.6852464305880455},
      {x:0.17663149667838998,y:0.7196633594149122},
      {x:0.5338022665103556, y:0.5837164905487887},
    ],
  },
  bird: {
    hands: 2,
    vec: [0,0,-0.18680509137511722,-0.3691096979390101,-0.22054704125046978,-0.5362707525122652,0.15412785681008845,-0.6350628894611419,0.35539922925128176,-0.8374169782518275,0.281124115685839,-0.6220190953016084,0.46819837267483555,-0.8836233834754691,0.3805278341053199,-0.5482159680077507,0.5286857400713417,-0.8019095003620881,0.44804878338045045,-0.4266507678813402,0.543761744998364,-0.6348089368295541,0.08293748768660407,-0.38301101585379166],
    rawKeyPoints: [
      {x:0.6290510892868042, y:0.5935904383659363},
      {x:0.5252051582649473, y:0.3884004194563201},
      {x:0.5064478311840562, y:0.29547471162378},
      {x:0.7147315740585327, y:0.24055564403533936},
      {x:0.8266193866729736, y:0.12806594371795654},
      {x:0.7853294610977173, y:0.24780675768852234},
      {x:0.8893250226974487, y:0.10237956047058105},
      {x:0.8405885100364685, y:0.2888343036174774},
      {x:0.922950267791748,  y:0.14780473709106445},
      {x:0.8781237602233887, y:0.3564130365848541},
      {x:0.9313310980796814, y:0.24069681763648987},
      {x:0.6751564741134644, y:0.3806726038455963},
    ],
    vec2: [0,0,0.09045279947323676,-0.36453586189948134,0.24551474142735694,-0.5263542201085194,-0.2632822556095998,-0.6099307347879126,-0.5637147681457075,-0.769970869280368,-0.421574654687764,-0.5636969181567589,-0.6767807674872535,-0.7361846186652939,-0.39411576913338864,-0.4623381663115373,-0.667089396115121,-0.6366040905366552,-0.4167289690016978,-0.29874158438591647,-0.5782518252039062,-0.4409994817125432,-0.06945482816694962,-0.3414189535839045],
    rawKeyPoints2: [
      {x:0.429073856975381,  y:0.5785539512247587},
      {x:0.4728409534974599, y:0.40216719098706677},
      {x:0.5478702618210238, y:0.323868677905945},
      {x:0.3016803438843298, y:0.28342878653437664},
      {x:0.15631105900742476,y:0.20599069667392647},
      {x:0.2250879249706917, y:0.30579979027183996},
      {x:0.10160218835482611,y:0.22233873786668817},
      {x:0.23837436498632275,y:0.35484391385012504},
      {x:0.10629152012504883,y:0.27052243822430155},
      {x:0.22743259085580303,y:0.4340028501519185},
      {x:0.14927706135209065,y:0.3651689924981851},
      {x:0.39546697928878466,y:0.41335269285579845},
    ],
  },
  crab: {
    hands: 2,
    vec: [0,0,-0.011940654372547798,-0.5903709066075574,-0.1953015162522438,-0.9367417074588122,-0.4624619988979962,-0.6942884071822224,-0.6555065433928486,-0.745800612151514,-0.5440186702981314,-0.5620043776334325,-0.7366482424725111,-0.6762761025366492,-0.5805260117240159,-0.4141845334732486,-0.770360876044887,-0.5486448834117165,-0.5855937944683459,-0.20495552567770872,-0.7742844316452582,-0.27224445899055444,-0.3515025437940968,-0.42987450392377163],
    rawKeyPoints: [
      {x:0.6339194178581238, y:0.8490874767303467},
      {x:0.6260522603988647, y:0.46011877059936523},
      {x:0.5052440762519836, y:0.23191070556640625},
      {x:0.3292241096496582, y:0.3916522264480591},
      {x:0.2020357847213745, y:0.35771316289901733},
      {x:0.2754901051521301, y:0.47880819439888},
      {x:0.14857518672943115,y:0.40351971983909607},
      {x:0.25143706798553467,y:0.576200008392334},
      {x:0.12636345624923706,y:0.4876101613044739},
      {x:0.24809813499450684,y:0.7140515446662903},
      {x:0.12377840280532837,y:0.6697179079055786},
      {x:0.40233027935028076,y:0.5658625960350037},
    ],
    vec2: [0,0,-0.02302690118337219,-0.5977008673836128,0.06195185406525064,-0.9164846556664222,0.4091403695559259,-0.6862978119176465,0.6879237128495538,-0.7232413794328821,0.5265907595546303,-0.5598371385001091,0.824734057243649,-0.5655207642716839,0.5730546501035683,-0.3580684236092068,0.8298967117490866,-0.39074927179576147,0.5433693866973023,-0.06678260281600278,0.8015021119691798,-0.04262719328681039,0.33557254285344074,-0.40495833622469823],
    rawKeyPoints2: [
      {x:0.38999609222352477,y:0.8220537226748407},
      {x:0.37605226039886475,y:0.46011877059936523},
      {x:0.42751074638530673,y:0.2670807453416149},
      {x:0.637749120750293,  y:0.4064693070904251},
      {x:0.8065650644783118, y:0.38409830335296175},
      {x:0.7088706525986713, y:0.48304697373020355},
      {x:0.889409925752247,  y:0.47960528084751686},
      {x:0.7370066432200078, y:0.6052270710655804},
      {x:0.8925361469323955, y:0.585437336990132},
      {x:0.7190308714341539, y:0.7816138313032723},
      {x:0.8753419304415786, y:0.7962410260546906},
      {x:0.5932004689331769, y:0.5768331047834153},
    ],
  },
};

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
    } else if (POSE_DEFAULT_REFS[pose.name]) {
      // ハードコードデフォルトを使用（全環境共通）
      referenceVecs[pose.name] = POSE_DEFAULT_REFS[pose.name];
      console.log(`[calib] ハードコードデフォルトを使用: ${pose.name}`);
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
  // シルエットキャンバスとキャラ画像を初期非表示（チュートリアル中のみ表示）
  const canvasArt = document.getElementById('canvas-art');
  if (canvasArt) canvasArt.style.display = 'none';
  const titleCharacter = document.querySelector('.title-character');
  if (titleCharacter) titleCharacter.style.display = 'none';
  
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
    playSoundFile('assets/sounds/countdown.mp3');
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

// class を再トリガーするための共通ヘルパー（同じ class を連続適用してもアニメーションが再生されるようにする）
function _retriggerClass(el, className) {
  if (!el) return;
  el.classList.remove(className);
  void el.offsetWidth; // reflow を強制してアニメーションをリセット
  el.classList.add(className);
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
  let lastPointScores   = null; // 部位別一致度（お題キャンバスのドット色分け用）
  let questionActive    = true;
  let scoringInProgress = false;
  let newBestTimer      = null;
  let newBestActive     = false;
  let questionImg       = null; // 読み込み済みお題画像（毎フレーム再描画で使い回す）

  const qNumEl    = document.getElementById('question-number');
  const qCanvas   = document.getElementById('canvas-question');
  if (qNumEl) qNumEl.textContent = isTutorial ? 'チュートリアル' : `${qIdx + 1} / ${QUESTION_COUNT}`;
  if (qCanvas && poseData) {
    drawQuestionCanvas(
      qCanvas,
      `assets/silhouettes/${poseData.answerImage ?? poseData.image}`,
      refData?.rawKeyPoints ?? null
    ).then((img) => { questionImg = img; });
  }

  const timerBar      = document.getElementById('timer-bar');
  const timerVignette = document.getElementById('timer-vignette');
  const scoreDisplay  = document.getElementById('score-display');
  const cameraCanvas  = document.getElementById('canvas-camera');
  const overlayCanvas = document.getElementById('canvas-overlay');

  if (timerVignette) timerVignette.classList.remove('active');

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
            // 残り秒数が少ないほど高い音で緊張感を演出（3秒:660Hz → 1秒:820Hz）
            playBeep(660 + (3 - beepSec) * 80, 0.14);
          }
          if (timerVignette) timerVignette.classList.add('active');
        } else if (timerVignette) {
          timerVignette.classList.remove('active');
        }
      }

      // お題キャンバスを毎フレーム再描画（部位別一致度の色分けをリアルタイム反映）
      if (qCanvas && questionImg) {
        drawQuestionDots(qCanvas, questionImg, refData?.rawKeyPoints ?? null, lastPointScores);
      }

      // 最終スコア更新（手未検出時は 0、ノンブロッキング）
      // チュートリアルは骨格60%＋シルエット40%のみ（TM不使用）
      if (!scoringInProgress && poseData && cameraCanvas && cameraCanvas.width > 0) {
        scoringInProgress = true;
        window.ClassifierModule.getFinalScore(
          cameraCanvas, lastLandmarks, poseData.name, refData, !isTutorial
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

            // 部位別一致度を更新（お題キャンバスのドット色分け用）
            if (refData?.vec && lastLandmarks?.[0] && window.PoseExtractorModule) {
              lastPointScores = window.PoseExtractorModule.calcPointScoresBest(lastLandmarks[0], refData.vec);
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
          lastLandmarks || null,
          overlayCtx,
          overlayCanvas.width,
          overlayCanvas.height
        );
      }

      if (elapsed >= QUESTION_DURATION || _gameAborted) {
        resolve();
      } else {
        requestAnimationFrame(tick);
      }
    }
    requestAnimationFrame(tick);
  });

  currentDetectionCb = null;
  questionActive = false;
  if (timerVignette) timerVignette.classList.remove('active');
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

function goToTitle() {
  _gameAborted = true;
  showScreen('screen-title');
}

async function startTutorial() {
  _gameAborted = false;
  if (allPoses.length === 0) await loadPoses();

  // チュートリアルはチョキを固定使用（見つからない場合は先頭ポーズ）
  const chokiIdx = allPoses.findIndex(p => p.name === 'choki');
  questionOrder = [chokiIdx >= 0 ? chokiIdx : 0];

  ensureReferenceVecs();
  _ensureDetection();
  await runCountdown();
  await runQuestion(0, true);
}

async function startGame() {
  _gameAborted = false;
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

  const playableIdx = allPoses.map((p, i) => i).filter(i => !allPoses[i].tutorialOnly);
  questionOrder = sampleIndices(playableIdx.length, QUESTION_COUNT).map(i => playableIdx[i]);

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
  playSoundFile('assets/sounds/final-score.mp3');

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

  const starEls = [
    document.getElementById('star-1'),
    document.getElementById('star-2'),
    document.getElementById('star-3'),
  ];
  const litCount = avg >= 80 ? 3 : avg >= 50 ? 2 : avg >= 20 ? 1 : 0;
  starEls.forEach((el, i) => {
    if (!el) return;
    el.classList.remove('lit');
    setTimeout(() => { if (i < litCount) el.classList.add('lit'); }, 300 + i * 200);
  });

  // 全問80点以上ならパーフェクトコンボ演出（紙吹雪 + バナー + ファンファーレ）
  const banner   = document.getElementById('perfect-combo-banner');
  const fxCanvas = document.getElementById('canvas-combo-fx');
  const isPerfect = scores.length === QUESTION_COUNT && scores.every((s) => s >= 80);
  if (isPerfect && banner && fxCanvas && window.EffectsModule) {
    banner.style.display = 'flex';
    _retriggerClass(banner, 'combo-pop');
    window.EffectsModule.playPerfectCombo(fxCanvas).then(() => {
      banner.style.display = 'none';
    });
  } else if (banner) {
    banner.style.display = 'none';
  }
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
const CALIB_DATA_VERSION  = 2; // 変更時: 旧 localStorage データを自動破棄

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
    if (!raw) return {};
    const data = JSON.parse(raw);
    // バージョン不一致（旧形式 or 2手対応前）は無効とみなし破棄
    if (data._version !== CALIB_DATA_VERSION) {
      localStorage.removeItem(CALIB_STORAGE_KEY);
      return {};
    }
    return data;
  } catch (_) { return {}; }
}

function _saveCustomRef(poseName, refData) {
  const refs = _loadCustomRefs();
  refs[poseName]  = refData;
  refs._version   = CALIB_DATA_VERSION;
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

// referenceVecs から編集点を初期化（未登録時はハードコードデフォルトを使用）
function _calibInitPoints(poseName) {
  const refData = referenceVecs[poseName];
  const fallback = POSE_DEFAULT_REFS[poseName];
  const src = (refData && refData.rawKeyPoints) ? refData : (fallback ?? null);
  _calibHands = (src && src.hands === 2) ? 2 : 1;

  // 手0
  if (src && src.rawKeyPoints && src.rawKeyPoints.length === 12) {
    _calibEditPoints = src.rawKeyPoints.map(p => ({ x: p.x, y: p.y }));
  } else {
    _calibEditPoints = _defaultHandPoints();
  }

  // 手1（2手モード時）
  if (_calibHands === 2) {
    if (src && src.rawKeyPoints2 && src.rawKeyPoints2.length === 12) {
      _calibEditPoints2 = src.rawKeyPoints2.map(p => ({ x: p.x, y: p.y }));
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
    // デフォルト未登録: ハードコードデフォルトにフォールバック
    const hardcoded = POSE_DEFAULT_REFS[_calibPose];
    if (hardcoded) {
      _calibHands = (hardcoded.hands === 2) ? 2 : 1;
      _calibEditPoints = hardcoded.rawKeyPoints.map(p => ({ x: p.x, y: p.y }));
      if (_calibHands === 2 && hardcoded.rawKeyPoints2) {
        _calibEditPoints2 = hardcoded.rawKeyPoints2.map(p => ({ x: p.x, y: p.y }));
      } else {
        _calibEditPoints2 = [];
      }
      _calibLabelHand = -1;
      _calibLabelIdx  = -1;
      _calibUpdateHandToggle();
      _calibDrawEditor();
      _calibSetStatus('デフォルトに戻しました');
    } else {
      _calibSetStatus('デフォルトが見つかりません', true);
    }
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
  showCalibrateScreen, exitCalibrateScreen, goToTitle,
  calibSelectPose, calibSetHands, calibRegister, calibSaveDefault, calibReset,
};
