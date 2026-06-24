const TUTORIAL_DONE_KEY = 'kagee_tutorial_done';

const TutorialCharacter = {
  // チュートリアルキャラクター画像。assets/ に追加したJPEGを使います。
  imageUrl: 'assets/tutorial-character.png',
  name:     'チュートリアルキャラ',

  show() {
    const slot = document.getElementById('tutorial-character-slot');
    if (!slot) return;
    if (this.imageUrl) {
      let img = slot.querySelector('.tut-char-img');
      if (!img) {
        img = document.createElement('img');
        img.className = 'tut-char-img';
        img.alt = this.name;
        slot.appendChild(img);
      }
      img.src = this.imageUrl;
      slot.style.display = 'flex';
    }
  },

  hide() {
    const slot = document.getElementById('tutorial-character-slot');
    if (slot) slot.style.display = 'none';
  },
};

let _tutorialFallbackDone = false;

// ─── ステップオーバーレイ ─────────────────────────────────

function showTutorialOverlay(title, message, buttonLabel = '次へ') {
  return new Promise((resolve) => {
    const overlay = document.getElementById('tutorial-overlay');
    const titleEl = document.getElementById('tutorial-title');
    const msgEl   = document.getElementById('tutorial-message');
    const btnEl   = document.getElementById('tutorial-next-btn');
    const canvasArt = document.getElementById('canvas-art');
    const titleCharacter = document.querySelector('.title-character');

    if (!overlay) { resolve(); return; }

    if (titleEl) titleEl.textContent = title;
    if (msgEl)   msgEl.textContent   = message;
    if (btnEl)   btnEl.textContent   = buttonLabel;

    overlay.style.display = 'flex';
    // チュートリアル中はシルエットキャンバスとキャラ画像を表示
    if (canvasArt) canvasArt.style.display = '';
    if (titleCharacter) titleCharacter.style.display = '';
    TutorialCharacter.show();

    const advance = () => {
      overlay.style.display = 'none';
      // チュートリアル終了時はシルエットキャンバスとキャラ画像を非表示
      if (canvasArt) canvasArt.style.display = 'none';
      if (titleCharacter) titleCharacter.style.display = 'none';
      TutorialCharacter.hide();
      if (btnEl) btnEl.onclick = null;
      resolve();
    };

    if (btnEl) btnEl.onclick = advance;
  });
}

// ─── インゲームヒント（プレイ中に自動消える吹き出し）──────

function showPlayHint(message, durationMs = 3000) {
  const hint = document.getElementById('tutorial-play-hint');
  if (!hint) return;

  // 前のヒントが残っていたらキャンセル
  if (hint._hideTimer) clearTimeout(hint._hideTimer);
  if (hint._resolveTimer) clearTimeout(hint._resolveTimer);
  hint.classList.remove('visible');

  hint.textContent = message;

  // 次フレームで visible を付けてトランジションを発火
  requestAnimationFrame(() => {
    hint.classList.add('visible');
    hint._hideTimer = setTimeout(() => {
      hint.classList.remove('visible');
    }, durationMs);
  });
}

function hidePlayHint() {
  const hint = document.getElementById('tutorial-play-hint');
  if (!hint) return;
  if (hint._hideTimer) clearTimeout(hint._hideTimer);
  hint.classList.remove('visible');
}

// ─── 初回チェック ─────────────────────────────────────────

function isFirstPlay() {
  try {
    return !localStorage.getItem(TUTORIAL_DONE_KEY);
  }
  catch {
    // localStorage が使えない場合は初回プレイとみなす
    return !_tutorialFallbackDone;
  }
}

function markTutorialDone() {
  try { localStorage.setItem(TUTORIAL_DONE_KEY, '1'); }
  catch { _tutorialFallbackDone = true; }
}

function resetTutorial() {
  try { localStorage.removeItem(TUTORIAL_DONE_KEY); }
  catch { _tutorialFallbackDone = false; }
}

// ─── チュートリアル本体 ──────────────────────────────────

async function runTutorial() {
  // ステップ1: ウェルカム
  await showTutorialOverlay(
    '影絵採点ゲームへようこそ！',
    'このゲームでは、手でポーズを作って\nお題のシルエットに合わせて採点します。\n\nまずは1問だけ練習してみましょう！',
    '次へ'
  );

  // ステップ2: あそびかた説明
  await showTutorialOverlay(
    'あそびかた',
    '① 左にお題のシルエットが表示されます\n\n② カメラの前で同じポーズを作ってください\n\n③ スコアが上がるようにポーズを調整しよう！\n\n④ 時間内にできるだけ高いスコアを目指そう！',
    'やってみる！'
  );

  // チュートリアル1問プレイ（GameModuleに処理を委譲）
  await window.GameModule.startTutorial();

  // ステップ3: チュートリアル完了
  await showTutorialOverlay(
    'チュートリアル完了！',
    'よくできました！\nルールはわかりましたか？\n\nそれでは本番ゲームを始めましょう！',
    '本番ゲームへ！'
  );
}

window.TutorialModule = {
  isFirstPlay,
  markTutorialDone,
  resetTutorial,
  runTutorial,
  showPlayHint,
  hidePlayHint,
  TutorialCharacter,
};
