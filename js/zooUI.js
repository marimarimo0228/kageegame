// js/zooUI.js — 個人動物園マップ画面（#screen-zoo-map）の描画
// areas.json の x, y は 1000×700px を想定した敷地マップ上の px 値をそのまま使う。

// エリアに入れる動物種のアイコン（絵文字で代用）
const ZOO_POSE_ICON = { dog: '🐕', bird: '🕊️', crab: '🦀' };

function _areaIcons(area) {
  return (area.poses ?? []).map((p) => ZOO_POSE_ICON[p] ?? '').join(' ');
}

/**
 * 1エリア分のボックス要素を組み立てる。
 * @param {object} area          getAreas() の1エリア分（unlocked フラグ込み）
 * @param {number} currentPoints 現在の合計ポイント（不足分の表示に使用）
 */
function _buildAreaBox(area, currentPoints) {
  const box = document.createElement('div');
  box.className = 'zoo-area-box' + (area.unlocked ? '' : ' locked');
  box.style.left = `${area.x}px`;
  box.style.top  = `${area.y}px`;

  const label = document.createElement('div');
  label.className   = 'zoo-area-label';
  label.textContent = area.label;
  box.appendChild(label);

  if (area.unlocked) {
    const icons = document.createElement('div');
    icons.className   = 'zoo-area-icons';
    icons.textContent = _areaIcons(area);
    box.appendChild(icons);

    box.addEventListener('click', () => ZooUIModule.onAreaSelected(area.id));
  } else {
    const lockIcon = document.createElement('div');
    lockIcon.className   = 'zoo-area-lock-icon';
    lockIcon.textContent = '🔒';
    box.appendChild(lockIcon);

    const remain = Math.max(0, (area.requiredPoints ?? 0) - currentPoints);
    const condition = document.createElement('div');
    condition.className   = 'zoo-area-condition';
    condition.textContent = `あと${remain}pt`;
    box.appendChild(condition);
  }

  return box;
}

/**
 * #screen-zoo-map の中身（#zoo-map-ground の敷地＋各エリア）を描画する。
 * @param {{ points: number, unlockedAreas: string[], animals: object[] }} zooData  loadZoo() の戻り値
 * @param {Array<object>} areas  getAreas() の戻り値（x, y 座標・unlocked フラグ込み）
 */
function renderZooMap(zooData, areas) {
  const ptsEl = document.getElementById('zoo-points-display');
  if (ptsEl) ptsEl.textContent = `${zooData.points} pt`;

  const ground = document.getElementById('zoo-map-ground');
  if (!ground) return;

  ground.innerHTML = '';
  for (const area of areas) {
    ground.appendChild(_buildAreaBox(area, zooData.points));
  }
}

/**
 * 新規エリア解放時、画面中央に通知モーダルを一時的に表示する。
 * @param {string} areaLabel
 * @returns {Promise<void>}
 */
function showUnlockAnimation(areaLabel) {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className   = 'zoo-unlock-modal';
    modal.textContent = `🎉 新しい飼育場所『${areaLabel}』が解放されました！`;
    document.body.appendChild(modal);

    requestAnimationFrame(() => modal.classList.add('visible'));

    setTimeout(() => {
      modal.classList.remove('visible');
      setTimeout(() => {
        modal.remove();
        resolve();
      }, 300); // フェードアウトの猶予
    }, 2400);
  });
}

// onAreaSelected はコールバック的な関数。呼び出し元（game.js）が上書きして使う。
// _buildAreaBox 内のクリックハンドラは ZooUIModule.onAreaSelected を都度参照するため、
// 後から window.ZooUIModule.onAreaSelected = fn と上書きしても正しく反映される。
const ZooUIModule = {
  renderZooMap,
  onAreaSelected: () => {},
  showUnlockAnimation,
};

// グローバルスコープへ公開（ES Module 非対応環境向け）
window.ZooUIModule = ZooUIModule;
