// js/snapshot.js — ベストショット永続保存モジュール（localStorage）

const SNAPSHOT_STORAGE_KEY = 'kagee_snapshots';

/**
 * スナップショットを localStorage に追記する。
 * @param {{
 *   id: number,
 *   pose: string,
 *   score: number,
 *   landmarks: number[][],
 *   timestamp: string
 * }} snapshot
 */
function saveSnapshot(snapshot) {
  const all = loadAllSnapshots();
  all.push(snapshot);
  try {
    localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(all));
  } catch (err) {
    if (err.name === 'QuotaExceededError') {
      console.warn('[snapshot] localStorage の容量が上限に達しました。保存をスキップします。');
    } else {
      console.error('[snapshot] 保存中にエラーが発生しました:', err);
    }
  }
}

/**
 * localStorage から全スナップショットを読み込んで返す。
 * データがない、またはパースエラーの場合は空配列を返す。
 * @returns {Array}
 */
function loadAllSnapshots() {
  try {
    const raw = localStorage.getItem(SNAPSHOT_STORAGE_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('[snapshot] データの読み込みに失敗しました:', err);
    return [];
  }
}

/**
 * localStorage のスナップショットデータを全削除する。
 */
function clearSnapshots() {
  localStorage.removeItem(SNAPSHOT_STORAGE_KEY);
}

// グローバルスコープへ公開（ES Module 非対応環境向け）
window.SnapshotModule = { saveSnapshot, loadAllSnapshots, clearSnapshots };
