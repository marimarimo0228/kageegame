// js/zoo.js — 個人動物園のポイント・動物・エリア解放状態を管理するモジュール

const ZOO_STORAGE_KEY  = 'kagee_zoo_personal';
const ZOO_DATA_VERSION = 1; // 変更時: 旧 localStorage データを自動破棄

let _areasCache = null; // areas.json の読み込み結果（セッション内で使い回す）

function _emptyZoo() {
  return {
    _version:       ZOO_DATA_VERSION,
    points:         0,
    unlockedAreas:  ['entrance'],
    animals:        [],
    areaBestScores: {}, // { [areaId]: エリアの最高平均スコア(0〜100) }
  };
}

/**
 * localStorage から個人動物園データを読み込む。
 * データなし・パース失敗・バージョン不一致の場合は初期状態を返す。
 * @returns {{ points: number, unlockedAreas: string[], animals: object[] }}
 */
function loadZoo() {
  try {
    const raw = localStorage.getItem(ZOO_STORAGE_KEY);
    if (!raw) return _emptyZoo();
    const data = JSON.parse(raw);
    if (data._version !== ZOO_DATA_VERSION) return _emptyZoo();
    return {
      _version:       ZOO_DATA_VERSION,
      points:         typeof data.points === 'number' ? data.points : 0,
      unlockedAreas:  Array.isArray(data.unlockedAreas) ? data.unlockedAreas : ['entrance'],
      animals:        Array.isArray(data.animals) ? data.animals : [],
      areaBestScores: (data.areaBestScores && typeof data.areaBestScores === 'object')
        ? data.areaBestScores : {},
    };
  } catch (err) {
    console.error('[zoo] データの読み込みに失敗しました:', err);
    return _emptyZoo();
  }
}

function _saveZoo(zoo) {
  try {
    localStorage.setItem(ZOO_STORAGE_KEY, JSON.stringify(zoo));
  } catch (err) {
    if (err.name === 'QuotaExceededError') {
      console.warn('[zoo] localStorage の容量が上限に達しました。保存をスキップします。');
    } else {
      console.error('[zoo] 保存中にエラーが発生しました:', err);
    }
  }
}

// エリアの最終スコア(平均, 0〜100) → 獲得星数(0〜3)。
// 閾値は結果画面(game.js showResult)の星判定と一致させること。
function scoreToStars(score) {
  if (score >= 80) return 3;
  if (score >= 50) return 2;
  if (score >= 20) return 1;
  return 0;
}

/**
 * エリアの最終スコア（平均スコア）を記録する。
 * 既存のベストより高い場合のみ更新し、常に高い方の星が表示されるようにする。
 * @param {string} areaId
 * @param {number} score  そのプレイの平均スコア(0〜100)
 * @returns {{ bestScore: number, stars: number, improved: boolean }}
 */
function recordAreaBestScore(areaId, score) {
  if (!areaId || typeof score !== 'number') {
    return { bestScore: 0, stars: 0, improved: false };
  }
  const zoo  = loadZoo();
  const prev = zoo.areaBestScores[areaId] ?? 0;
  const improved = score > prev;
  if (improved) {
    zoo.areaBestScores[areaId] = score;
    _saveZoo(zoo);
  }
  const bestScore = Math.max(prev, score);
  return { bestScore, stars: scoreToStars(bestScore), improved };
}

// スコア(0〜100) → ポイント倍率。50点未満は加算なし（0倍）。
function _scoreMultiplier(score) {
  if (score >= 90) return 3;
  if (score >= 70) return 2;
  if (score >= 50) return 1;
  return 0;
}

// スコア(0〜100) → 動物のサイズ判定。ポイント倍率と同じ閾値を使う。
function _scoreSize(score) {
  if (score >= 90) return 'large';
  if (score >= 70) return 'medium';
  if (score >= 50) return 'small';
  return null;
}

/** areas.json を読み込む（初回のみ fetch、以降はキャッシュを再利用）。 */
async function _loadAreasRaw() {
  if (_areasCache) return _areasCache;
  try {
    const res = await fetch('areas.json');
    _areasCache = await res.json();
  } catch (err) {
    console.error('[zoo] areas.json の読み込みに失敗しました:', err);
    _areasCache = [];
  }
  return _areasCache;
}

/** 現在の合計星数（全エリアのベストスコアを星換算した総和）を返す。 */
function _totalStars(zoo, areas) {
  return areas.reduce(
    (sum, area) => sum + scoreToStars(zoo.areaBestScores[area.id] ?? 0),
    0,
  );
}

/**
 * 現在の合計星数で新たに解放されるエリアを unlockedAreas に追加する。
 * 解放条件は areas.json の requiredStars（各ステージで稼いだ星の合計）。
 * @returns {Promise<string[]>} 新規解放されたエリアID配列（なければ空配列）
 */
async function checkUnlocks() {
  const zoo   = loadZoo();
  const areas = await _loadAreasRaw();
  const totalStars = _totalStars(zoo, areas);
  const newlyUnlocked = [];

  for (const area of areas) {
    if (zoo.unlockedAreas.includes(area.id)) continue;
    if (totalStars >= (area.requiredStars ?? 0)) {
      zoo.unlockedAreas.push(area.id);
      newlyUnlocked.push(area.id);
    }
  }

  if (newlyUnlocked.length > 0) _saveZoo(zoo);
  return newlyUnlocked;
}

/**
 * プレイ結果からポイントを計算して加算し、動物を1匹追加する。
 * 50点未満はポイント・動物ともに加算されない。
 * ※ エリア解放は星ベース（recordAreaBestScore → checkUnlocks）で別途行う。
 * @param {number} score  0〜100
 * @param {string} pose   "dog" | "bird" | "crab"
 * @returns {Promise<{ pointsGained: number, newAnimal: object|null }>}
 */
async function addResult(score, pose) {
  const multiplier = _scoreMultiplier(score);
  const size       = _scoreSize(score);

  if (multiplier === 0 || !size) {
    return { pointsGained: 0, newAnimal: null };
  }

  const pointsGained = score * multiplier;
  const zoo = loadZoo();
  zoo.points += pointsGained;

  const newAnimal = {
    species:   pose,
    size,
    score,
    timestamp: Date.now(),
  };
  zoo.animals.push(newAnimal);
  _saveZoo(zoo);

  return { pointsGained, newAnimal };
}

/**
 * areas.json を読み込み、各エリアに解放済みかどうかのフラグを付けて返す。
 * @returns {Promise<Array<object & { unlocked: boolean }>>}
 */
async function getAreas() {
  const zoo   = loadZoo();
  const areas = await _loadAreasRaw();
  return areas.map((area) => {
    const bestScore = zoo.areaBestScores[area.id] ?? 0;
    return {
      ...area,
      unlocked:  zoo.unlockedAreas.includes(area.id),
      bestScore,
      stars:     scoreToStars(bestScore),
    };
  });
}

/** 個人動物園をリセットする（次のプレイヤー用・TGS運用で使用）。 */
function resetZoo() {
  localStorage.removeItem(ZOO_STORAGE_KEY);
}

// グローバルスコープへ公開（ES Module 非対応環境向け）
window.ZooModule = {
  loadZoo, addResult, checkUnlocks, getAreas, resetZoo,
  recordAreaBestScore, scoreToStars,
};
