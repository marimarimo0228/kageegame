// js/ranking.js — スコアランキング管理モジュール（localStorage）

const RANKING_STORAGE_KEY = 'kagee_ranking';
const MAX_ENTRIES = 1000;

// ─── 内部ヘルパー ─────────────────────────────────────────────

/** localStorage から全エントリを読み込む。異常時は空配列を返す */
function loadEntries() {
  try {
    const raw = localStorage.getItem(RANKING_STORAGE_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('[ranking] データの読み込みに失敗しました:', err);
    return [];
  }
}

/** エントリ配列を localStorage に書き込む */
function saveEntries(entries) {
  try {
    localStorage.setItem(RANKING_STORAGE_KEY, JSON.stringify(entries));
  } catch (err) {
    if (err.name === 'QuotaExceededError') {
      console.warn('[ranking] localStorage の容量が上限に達しました。保存をスキップします。');
    } else {
      console.error('[ranking] 保存中にエラーが発生しました:', err);
    }
  }
}

/** スコア降順のソート関数 */
function byScoreDesc(a, b) {
  return b.score - a.score;
}

// ─── エクスポート関数 ─────────────────────────────────────────

/**
 * スコアを保存する。1000件を超えた場合は古いものを削除する。
 * @param {number} score
 */
function addScore(score) {
  const entries = loadEntries();
  entries.push({ score, timestamp: new Date().toISOString() });

  // 件数上限: タイムスタンプ昇順（古い順）で並べて末尾を切り捨て
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    entries.splice(0, entries.length - MAX_ENTRIES);
  }

  saveEntries(entries);
}

/**
 * 全スコアをスコア降順で返す。
 * @returns {{ score: number, timestamp: string }[]}
 */
function getRanking() {
  return loadEntries().sort(byScoreDesc);
}

/**
 * 引数のスコアが全体の何位かを返す（同点は上位扱い）。
 * @param {number} score
 * @returns {{ rank: number, total: number }}
 */
function getMyRank(score) {
  const entries = loadEntries();
  const total = entries.length;
  // 自分より高いスコアの件数 + 1 が順位（同点は上位扱いのため >= ではなく >）
  const rank = entries.filter((e) => e.score > score).length + 1;
  return { rank, total };
}

/**
 * スコア上位 n 件を返す（タイトル画面のハイスコア表示用）。
 * @param {number} n
 * @returns {{ score: number, timestamp: string }[]}
 */
function getTopN(n) {
  return loadEntries().sort(byScoreDesc).slice(0, n);
}

// グローバルスコープへ公開（ES Module 非対応環境向け）
window.RankingModule = { addScore, getRanking, getMyRank, getTopN };
