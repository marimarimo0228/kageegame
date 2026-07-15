const TutorialCharacter = {
  // チュートリアルキャラクター画像。assets/ に追加したJPEGを使います。
  imageUrl: 'assets/tutorial-character(挨拶).png',
  name:     'チュートリアルキャラ',

  show(customImageUrl) {
    const slot = document.getElementById('tutorial-character-slot');
    if (!slot) return;
    // カスタム画像URLが指定されていればそれを使用、なければデフォルト
    const imageUrl = customImageUrl || this.imageUrl;
    if (imageUrl) {
      let img = slot.querySelector('.tut-char-img');
      if (!img) {
        img = document.createElement('img');
        img.className = 'tut-char-img';
        img.alt = this.name;
        slot.appendChild(img);
      }
      img.src = imageUrl;
      img.style.display = 'block';
      img.style.width = '220px';
      img.style.maxWidth = '220px';
      img.style.height = 'auto';
      img.style.maxHeight = '420px';
      img.style.objectFit = 'contain';
      img.style.objectPosition = 'center bottom';
      img.style.background = 'transparent';
      slot.style.display = 'flex';
    }
  },

  hide() {
    const slot = document.getElementById('tutorial-character-slot');
    if (slot) slot.style.display = 'none';
  },
};

// ─── ステップオーバーレイ ─────────────────────────────────

function showTutorialOverlay(title, message, buttonLabel = '次へ', imageUrl) {
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
    // 指定されたURLでキャラクター表示（デフォルトはTutorialCharacter.imageUrl）
    TutorialCharacter.show(imageUrl);

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

// ─── チュートリアル本体 ──────────────────────────────────

async function runTutorial() {
  // ステップ1: ウェルカム（デフォルト画像）
  await showTutorialOverlay(
    '影絵採点ゲームへようこそ！',
    'このゲームでは、手でポーズを作って\nお題のシルエットに合わせて採点します。\n\nまずは1問だけ練習してみましょう！',
    '次へ'
    // imageUrl はデフォルト（TutorialCharacter.imageUrl）を使用
  );

  // ステップ2: あそびかた説明（異なる画像URL）
  await showTutorialOverlay(
    'あそびかた',
    '① 左にお題のシルエットが表示されます\n\n② カメラの前で同じポーズを作ってください\n\n③ スコアが上がるようにポーズを調整しよう！\n\n④ 時間内にできるだけ高いスコアを目指そう！',
    'やってみる！',
    'assets/tutorial-character(説明).png'  // ← ここを変更してステップ2の画像を指定
  );

  // チュートリアル1問プレイ（GameModuleに処理を委譲）
  await window.GameModule.startTutorial();

  // ステップ3: チュートリアル完了（別画像URL）
  await showTutorialOverlay(
    'チュートリアル完了！',
    'よくできました！\nルールはわかりましたか？\n\nそれでは本番ゲームを始めましょう！',
    '本番ゲームへ！',
    'assets/tutorial-character(完了).png'  // ← ここを変更してステップ3の画像を指定
  );
}

window.TutorialModule = {
  runTutorial,
  showPlayHint,
  hidePlayHint,
  TutorialCharacter,
};
