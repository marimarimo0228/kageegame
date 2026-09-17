// ─── BGM再生モジュール ─────────────────────────────────────
// 画面（タイトル/チュートリアル/ステージ選択/各動物エリア）ごとにループBGMを
// クロスフェードで切り替える。ブラウザの自動再生制限で最初の再生が
// ブロックされた場合は、最初のユーザー操作時に自動でリトライする。

const BGM_FILES = {
  title:    'assets/bgm/title.mp3',
  tutorial: 'assets/bgm/tutorial.mp3',
  zoomap:   'assets/bgm/zoomap.mp3',
  dog:      'assets/bgm/dog.mp3',
  bird:     'assets/bgm/bird.mp3',
  crab:     'assets/bgm/crab.mp3',
  swan:     'assets/bgm/swan.mp3',
  owl:      'assets/bgm/owl.mp3',
  turtle:   'assets/bgm/turtle.mp3',
  frog:     'assets/bgm/frog.mp3',
  cat:      'assets/bgm/cat.mp3',
  fox:      'assets/bgm/fox.mp3',
  rabbit:   'assets/bgm/rabbit.mp3',
};

const BGM_VOLUME    = 0.4;
const FADE_IN_MS     = 700;
const FADE_OUT_MS    = 500;

let currentAudio = null;
let currentKey   = null;
let pendingKey   = null; // 自動再生がブロックされた際、初回操作時にリトライする対象

function _fade(audio, from, to, durationMs, onDone) {
  const startTime = performance.now();
  audio.volume = from;
  function step(now) {
    const t = Math.min(1, (now - startTime) / durationMs);
    audio.volume = from + (to - from) * t;
    if (t < 1) {
      requestAnimationFrame(step);
    } else if (onDone) {
      onDone();
    }
  }
  requestAnimationFrame(step);
}

/** 指定キーのBGMへクロスフェードで切り替える。同じ曲が再生中なら何もしない。 */
function play(key) {
  const src = BGM_FILES[key];
  if (!src) return;
  if (key === currentKey && currentAudio && !currentAudio.paused) return;

  const prevAudio = currentAudio;
  const nextAudio = new Audio(src);
  nextAudio.loop   = true;
  nextAudio.volume = 0;

  currentAudio = nextAudio;
  currentKey   = key;
  pendingKey   = null;

  const playPromise = nextAudio.play();
  if (playPromise) {
    playPromise
      .then(() => _fade(nextAudio, 0, BGM_VOLUME, FADE_IN_MS))
      .catch(() => {
        // 自動再生ブロック時は初回のユーザー操作で再試行する
        pendingKey = key;
      });
  }

  if (prevAudio) {
    _fade(prevAudio, prevAudio.volume, 0, FADE_OUT_MS, () => {
      prevAudio.pause();
    });
  }
}

function stop() {
  if (currentAudio) {
    currentAudio.pause();
  }
  currentAudio = null;
  currentKey   = null;
  pendingKey   = null;
}

// ブラウザの自動再生制限により初回の play() が失敗した場合、
// 最初のユーザー操作（クリック/タップ/キー入力）を検知して再生を再試行する。
function _retryOnFirstInteraction() {
  const handler = () => {
    if (pendingKey && currentKey === pendingKey && currentAudio) {
      currentAudio.play()
        .then(() => _fade(currentAudio, 0, BGM_VOLUME, FADE_IN_MS))
        .catch(() => {});
    }
    pendingKey = null;
  };
  ['pointerdown', 'keydown'].forEach((evt) => {
    document.addEventListener(evt, handler);
  });
}
_retryOnFirstInteraction();

window.BgmModule = { play, stop };
