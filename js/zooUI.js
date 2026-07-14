// js/zooUI.js — 個人動物園マップ画面（#screen-zoo-map）の描画
// areas.json の x, y はマップ画像（assets/background/map.jpg）に対する百分率（0〜100）。

// エリアに入れる動物種のアイコン（絵文字で代用）
const ZOO_POSE_ICON = { dog: '🐕', bird: '🕊️', crab: '🦀' };

function _areaIcons(area) {
  return (area.poses ?? []).map((p) => ZOO_POSE_ICON[p] ?? '').join(' ');
}

/**
 * 1エリア分のボックス要素を組み立てる。
 * @param {object} area          getAreas() の1エリア分（unlocked フラグ込み）
 * @param {number} currentPoints 現在の合計ポイント（不足分の表示に使用）
 * @param {{ forceLocked?: boolean }} [opts]
 *        forceLocked: データ上は解放済みでも見た目だけロック状態で描画する
 *        （マップ帰還後の「解放演出」の起点にするため）。
 */
function _buildAreaBox(area, currentPoints, opts = {}) {
  const forceLocked = opts.forceLocked === true;
  const showLocked  = forceLocked || !area.unlocked;

  const box = document.createElement('div');
  box.className = 'zoo-area-box' + (showLocked ? ' locked' : '');
  box.dataset.areaId = area.id;
  box.style.left = `${area.x}%`;
  box.style.top  = `${area.y}%`;
  const poses = area.poses ?? [];
  box.dataset.pose = poses.length === 1 ? poses[0] : 'mixed';

  const label = document.createElement('div');
  label.className   = 'zoo-area-label';
  label.textContent = area.label;
  box.appendChild(label);

  if (!showLocked) {
    const icons = document.createElement('div');
    icons.className   = 'zoo-area-icons';
    icons.textContent = _areaIcons(area);
    box.appendChild(icons);

    // タップ時: リング拡散＋バウンドの演出を見せてから遷移する
    box.addEventListener('click', () => {
      if (box.classList.contains('zoo-area-tapped')) return;
      box.classList.add('zoo-area-tapped');
      setTimeout(() => {
        box.classList.remove('zoo-area-tapped');
        ZooUIModule.onAreaSelected(area.id);
      }, 420);
    });
  } else {
    const lockIcon = document.createElement('div');
    lockIcon.className   = 'zoo-area-lock-icon';
    lockIcon.textContent = '🔒';
    box.appendChild(lockIcon);

    // forceLocked（解放演出の起点）は既に条件達成済みなので不足ポイントは出さない
    if (!forceLocked) {
      const remain = Math.max(0, (area.requiredPoints ?? 0) - currentPoints);
      const condition = document.createElement('div');
      condition.className   = 'zoo-area-condition';
      condition.textContent = `あと${remain}pt`;
      box.appendChild(condition);
    }
  }

  return box;
}

/**
 * #screen-zoo-map の中身（#zoo-map-ground の敷地＋各エリア）を描画する。
 * @param {{ points: number, unlockedAreas: string[], animals: object[] }} zooData  loadZoo() の戻り値
 * @param {Array<object>} areas  getAreas() の戻り値（x, y 座標・unlocked フラグ込み）
 */
function renderZooMap(zooData, areas, pendingUnlocks = []) {
  const ptsEl = document.getElementById('zoo-points-display');
  if (ptsEl) ptsEl.textContent = `${zooData.points} pt`;

  // ホットスポットはマップ画像要素（#zoo-map-image）に重ねる。
  // ポイント表示など画像内の他要素を消さないよう、エリアボックスだけ差し替える。
  const ground = document.getElementById('zoo-map-image')
              || document.getElementById('zoo-map-ground');
  if (!ground) return;

  ground.querySelectorAll('.zoo-area-box').forEach((el) => el.remove());
  for (const area of areas) {
    const forceLocked = pendingUnlocks.includes(area.id);
    ground.appendChild(_buildAreaBox(area, zooData.points, { forceLocked }));
  }
}

/**
 * マップ帰還後の「ステージ解放演出」。
 * 対象エリアのホットスポット（renderZooMap で forceLocked 描画済み）を
 * 画面中央へズーム → 錠前が外れて色づく → 元の位置へ戻す、を1件ぶん再生する。
 * 呼び出し後、game.js 側で通常状態に再描画され、クリック可能になる。
 * @param {object} area  getAreas() の1エリア分
 * @returns {Promise<void>}
 */
function revealUnlock(area) {
  return new Promise((resolve) => {
    const screen = document.getElementById('screen-zoo-map');
    const box = screen && screen.querySelector(`.zoo-area-box[data-area-id="${area.id}"]`);
    if (!box) { resolve(); return; }

    // 背景を暗くするベール（マップ画面内に重ねる）
    const overlay = document.createElement('div');
    overlay.className = 'zoo-unlock-overlay';
    const caption = document.createElement('div');
    caption.className   = 'zoo-unlock-caption';
    caption.textContent = '🎉 あたらしいステージ解放！';
    overlay.appendChild(caption);
    screen.appendChild(overlay);
    void overlay.offsetWidth; // 強制リフローしてから可視化（transition を確実に発火）
    overlay.classList.add('visible');

    // 現在位置から画面中央までの移動量を算出してズームさせる
    const rect = box.getBoundingClientRect();
    const dx = window.innerWidth  / 2 - (rect.left + rect.width  / 2);
    const dy = window.innerHeight / 2 - (rect.top  + rect.height / 2);
    box.style.setProperty('--ux', `${dx}px`);
    box.style.setProperty('--uy', `${dy}px`);
    box.classList.add('zoo-unlock-zoom');

    // ① ズーム完了後: 錠前が外れて色づく
    setTimeout(() => {
      box.classList.remove('locked');
      box.classList.add('unlocked-reveal');

      const lock = box.querySelector('.zoo-area-lock-icon');
      if (lock) {
        lock.classList.add('lock-break');
        setTimeout(() => lock.remove(), 500);
      }
      // 動物アイコンを差し込む（解放後の見た目）
      if (!box.querySelector('.zoo-area-icons')) {
        const icons = document.createElement('div');
        icons.className   = 'zoo-area-icons';
        icons.textContent = _areaIcons(area);
        box.appendChild(icons);
      }
    }, 640);

    // ② 元の位置へ戻す
    setTimeout(() => {
      box.classList.remove('zoo-unlock-zoom');
      box.classList.add('zoo-unlock-returning');
      overlay.classList.remove('visible');
    }, 640 + 1400);

    // ③ 後始末
    setTimeout(() => {
      box.classList.remove('zoo-unlock-returning', 'unlocked-reveal');
      overlay.remove();
      resolve();
    }, 640 + 1400 + 560);
  });
}

// onAreaSelected はコールバック的な関数。呼び出し元（game.js）が上書きして使う。
// _buildAreaBox 内のクリックハンドラは ZooUIModule.onAreaSelected を都度参照するため、
// 後から window.ZooUIModule.onAreaSelected = fn と上書きしても正しく反映される。
const ZooUIModule = {
  renderZooMap,
  onAreaSelected: () => {},
  revealUnlock,
};

// グローバルスコープへ公開（ES Module 非対応環境向け）
window.ZooUIModule = ZooUIModule;
