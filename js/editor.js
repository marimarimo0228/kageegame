// js/editor.js — 参照骨格エディタ

// ─── 定数 ────────────────────────────────────────────────

const EDITOR_KEY_CONNECTIONS = [
  [0, 11], [11, 3], [11, 5], [11, 7], [11, 9],
  [3, 4],  [5, 6],  [7, 8],  [9, 10],
  [0, 1],  [1, 2],
];

const EDITOR_POINT_STYLES = [
  { color: '#AAAAAA', r: 0.016 },
  { color: '#FF9F43', r: 0.014 },
  { color: '#FF9F43', r: 0.020 },
  { color: '#FFC300', r: 0.014 },
  { color: '#FFC300', r: 0.020 },
  { color: '#5DCAA5', r: 0.014 },
  { color: '#5DCAA5', r: 0.020 },
  { color: '#3498DB', r: 0.014 },
  { color: '#3498DB', r: 0.020 },
  { color: '#E879F9', r: 0.014 },
  { color: '#E879F9', r: 0.020 },
  { color: '#FFFFFF', r: 0.016 },
];

// 手2は青系の配色
const EDITOR_POINT_STYLES2 = [
  { color: '#888888', r: 0.016 },
  { color: '#4A9EFF', r: 0.014 },
  { color: '#4A9EFF', r: 0.020 },
  { color: '#00CFFF', r: 0.014 },
  { color: '#00CFFF', r: 0.020 },
  { color: '#00E5CC', r: 0.014 },
  { color: '#00E5CC', r: 0.020 },
  { color: '#7B68EE', r: 0.014 },
  { color: '#7B68EE', r: 0.020 },
  { color: '#C084FC', r: 0.014 },
  { color: '#C084FC', r: 0.020 },
  { color: '#E0E0FF', r: 0.016 },
];

const EDITOR_POINT_LABELS = [
  '手首 (lm0)',      '親指MCP (lm2)',  '親指先端 (lm4)',
  '人差指PIP (lm6)', '人差指先端 (lm8)',
  '中指PIP (lm10)',  '中指先端 (lm12)',
  '薬指PIP (lm14)',  '薬指先端 (lm16)',
  '小指PIP (lm18)',  '小指先端 (lm20)',
  '中指MCP (lm9)',
];

const DEFAULT_KEY_POINTS = [
  { x: 0.50, y: 0.85 }, { x: 0.33, y: 0.72 }, { x: 0.17, y: 0.60 },
  { x: 0.41, y: 0.60 }, { x: 0.40, y: 0.40 }, { x: 0.50, y: 0.57 },
  { x: 0.50, y: 0.35 }, { x: 0.59, y: 0.60 }, { x: 0.60, y: 0.40 },
  { x: 0.68, y: 0.64 }, { x: 0.69, y: 0.47 }, { x: 0.50, y: 0.68 },
];

// 手2のデフォルト：手1を少し右にシフト
const DEFAULT_KEY_POINTS2 = DEFAULT_KEY_POINTS.map(p => ({
  x: Math.min(1, p.x + 0.10),
  y: p.y,
}));

// ⚠️ ストレージキーは js/constants.js の window.KAGEE_MANUAL_REFS_KEY で一元管理されています
const EDITOR_STORAGE_KEY = window.KAGEE_MANUAL_REFS_KEY;

// ─── エディタ状態 ─────────────────────────────────────────
let _poses        = [];
let _curIdx       = 0;
let _keyPoints    = [];   // 手1のキーポイント
let _keyPoints2   = [];   // 手2のキーポイント
let _handCount    = 1;    // 登録する手の本数（1 or 2）
let _curHand      = 0;    // 現在編集中の手（0=手1, 1=手2）
let _dragIdx      = -1;
let _editorCanvas = null;
let _ctx          = null;
let _image        = null;
let _initialized  = false;

// ─── localStorage ─────────────────────────────────────────

function _loadStorage() {
  try { return JSON.parse(localStorage.getItem(EDITOR_STORAGE_KEY) || '{}'); }
  catch { return {}; }
}

function _saveDataToStorage(poseName, data) {
  const all = _loadStorage();
  all[poseName] = data;
  localStorage.setItem(EDITOR_STORAGE_KEY, JSON.stringify(all));
  window.GameModule.setReferenceVec(poseName, { ...data });
}

function _removeFromStorage(poseName) {
  const all = _loadStorage();
  delete all[poseName];
  localStorage.setItem(EDITOR_STORAGE_KEY, JSON.stringify(all));
}

// ─── 公開 API ─────────────────────────────────────────────

const FALLBACK_POSES = [
  { name: 'dog',  label: 'イヌ',  image: 'dog.jpg'  },
  { name: 'bird', label: 'ハト',  image: 'bird.jpg' },
  { name: 'crab', label: 'カニ',  image: 'crab.jpg' },
];

function openEditor() {
  _poses = window.GameModule.getAllPoses();
  if (_poses.length === 0) _poses = FALLBACK_POSES;

  if (!_initialized) {
    _editorCanvas = document.getElementById('editor-canvas');
    _ctx          = _editorCanvas.getContext('2d');
    _setupEvents();
    _initialized = true;
  }

  window.GameModule.showScreen('screen-editor');

  _renderTabs();
  _selectPose(0);
}

function closeEditor() {
  window.GameModule.showScreen('screen-title');
}

// ─── ポーズ選択 ──────────────────────────────────────────

function _renderTabs() {
  const tabsEl = document.getElementById('editor-tabs');
  tabsEl.innerHTML = '';
  const storage = _loadStorage();

  _poses.forEach((pose, i) => {
    const btn = document.createElement('button');
    btn.className = 'editor-tab' + (i === _curIdx ? ' active' : '');
    if (storage[pose.name]) btn.classList.add('saved');
    btn.textContent = pose.label || pose.name;
    btn.onclick = () => _selectPose(i);
    tabsEl.appendChild(btn);
  });
}

function _selectPose(idx) {
  _curIdx = idx;
  const pose = _poses[idx];

  document.querySelectorAll('.editor-tab').forEach((b, i) =>
    b.classList.toggle('active', i === idx)
  );

  const nameEl  = document.getElementById('editor-pose-name');
  const badgeEl = document.getElementById('editor-saved-badge');
  const storage = _loadStorage();

  if (nameEl)  nameEl.textContent  = pose.label || pose.name;
  if (badgeEl) badgeEl.style.display = storage[pose.name] ? 'inline' : 'none';

  const manual = storage[pose.name];
  if (manual && manual.rawKeyPoints && manual.rawKeyPoints.length === 12) {
    _handCount  = manual.handCount || 1;
    _keyPoints  = manual.rawKeyPoints.map(p => ({ ...p }));
    _keyPoints2 = (manual.rawKeyPoints2 && manual.rawKeyPoints2.length === 12)
      ? manual.rawKeyPoints2.map(p => ({ ...p }))
      : DEFAULT_KEY_POINTS2.map(p => ({ ...p }));
  } else {
    _handCount = 1;
    const mpData = window.GameModule.getMediapipeVec(pose.name);
    if (mpData && mpData.rawKeyPoints && mpData.rawKeyPoints.length === 12) {
      _keyPoints = mpData.rawKeyPoints.map(p => ({ ...p }));
    } else {
      _keyPoints = DEFAULT_KEY_POINTS.map(p => ({ ...p }));
    }
    _keyPoints2 = DEFAULT_KEY_POINTS2.map(p => ({ ...p }));
  }

  _curHand = 0;
  _dragIdx = -1;
  _updateHandCountUI();
  _loadImage(`assets/silhouettes/${pose.image}`);
}

// ─── 手の本数 UI ──────────────────────────────────────────

function _updateHandCountUI() {
  document.querySelectorAll('.editor-hand-count-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.count) === _handCount);
  });

  const handTabs = document.getElementById('editor-hand-tabs');
  if (handTabs) handTabs.style.display = _handCount === 2 ? 'flex' : 'none';

  document.querySelectorAll('.editor-hand-tab').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.hand) === _curHand);
  });
}

function _setHandCount(n) {
  _handCount = n;
  if (n === 1) _curHand = 0;
  _dragIdx = -1;
  _updateHandCountUI();
  _redraw();
}

function _selectHand(n) {
  _curHand = n;
  _dragIdx = -1;
  _updateHandCountUI();
  _redraw();
}

// ─── 画像読み込み・キャンバスリサイズ ────────────────────

function _loadImage(src) {
  _image = new Image();
  _image.onload = () => { _resizeCanvas(); _redraw(); };
  _image.src = src;
}

function _resizeCanvas() {
  if (!_image) return;
  const wrap = document.getElementById('editor-canvas-wrap');
  const rect  = wrap.getBoundingClientRect();
  const availW = rect.width  - 24;
  const availH = rect.height - 16;

  const imgW  = _image.naturalWidth;
  const imgH  = _image.naturalHeight;
  const scale = Math.min(availW / imgW, availH / imgH, 1);

  _editorCanvas.width         = imgW;
  _editorCanvas.height        = imgH;
  _editorCanvas.style.width   = Math.floor(imgW * scale) + 'px';
  _editorCanvas.style.height  = Math.floor(imgH * scale) + 'px';
}

// ─── 描画 ─────────────────────────────────────────────────

function _drawHandSkeleton(keyPoints, styles, lineColor, alpha, activeDragIdx) {
  const w    = _editorCanvas.width;
  const h    = _editorCanvas.height;
  const base = Math.min(w, h);

  _ctx.globalAlpha = alpha;

  _ctx.lineWidth   = base * 0.006;
  _ctx.strokeStyle = lineColor;
  for (const [a, b] of EDITOR_KEY_CONNECTIONS) {
    const pa = keyPoints[a];
    const pb = keyPoints[b];
    _ctx.beginPath();
    _ctx.moveTo(pa.x * w, pa.y * h);
    _ctx.lineTo(pb.x * w, pb.y * h);
    _ctx.stroke();
  }

  keyPoints.forEach((pt, i) => {
    const s = styles[i];
    const x = pt.x * w;
    const y = pt.y * h;
    const r = s.r * base;

    if (i === activeDragIdx) {
      _ctx.beginPath();
      _ctx.arc(x, y, r + base * 0.022, 0, Math.PI * 2);
      _ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
      _ctx.fill();
    }

    _ctx.beginPath();
    _ctx.arc(x, y, r, 0, Math.PI * 2);
    _ctx.fillStyle = s.color;
    _ctx.fill();
    _ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    _ctx.lineWidth   = base * 0.003;
    _ctx.stroke();
  });

  _ctx.globalAlpha = 1.0;
}

function _redraw() {
  if (!_ctx || !_image) return;

  _ctx.clearRect(0, 0, _editorCanvas.width, _editorCanvas.height);
  _ctx.drawImage(_image, 0, 0, _editorCanvas.width, _editorCanvas.height);

  if (_handCount === 2) {
    if (_curHand === 0) {
      // 手2を先に薄く、手1をアクティブに描画
      _drawHandSkeleton(_keyPoints2, EDITOR_POINT_STYLES2, 'rgba(100,180,255,0.35)', 0.45, -1);
      _drawHandSkeleton(_keyPoints,  EDITOR_POINT_STYLES,  'rgba(255,255,255,0.45)', 1.00, _dragIdx);
    } else {
      // 手1を先に薄く、手2をアクティブに描画
      _drawHandSkeleton(_keyPoints,  EDITOR_POINT_STYLES,  'rgba(255,255,255,0.35)', 0.45, -1);
      _drawHandSkeleton(_keyPoints2, EDITOR_POINT_STYLES2, 'rgba(100,180,255,0.45)', 1.00, _dragIdx);
    }
  } else {
    _drawHandSkeleton(_keyPoints, EDITOR_POINT_STYLES, 'rgba(255,255,255,0.45)', 1.00, _dragIdx);
  }

  const infoEl = document.getElementById('editor-point-info');
  if (infoEl) {
    const handLabel = _handCount === 2 ? `手${_curHand + 1} ` : '';
    infoEl.textContent = _dragIdx >= 0
      ? `${handLabel}移動中: ${EDITOR_POINT_LABELS[_dragIdx]}`
      : 'ドラッグして骨格点を移動できます';
  }
}

// ─── ポインタ操作 ─────────────────────────────────────────

function _getCanvasXY(e) {
  const rect   = _editorCanvas.getBoundingClientRect();
  const src    = e.touches ? e.touches[0] : e;
  const scaleX = _editorCanvas.width  / rect.width;
  const scaleY = _editorCanvas.height / rect.height;
  return {
    x: (src.clientX - rect.left) * scaleX,
    y: (src.clientY - rect.top)  * scaleY,
  };
}

function _findNearest(cx, cy) {
  const w    = _editorCanvas.width;
  const h    = _editorCanvas.height;
  const base = Math.min(w, h);
  const HIT  = base * 0.072;
  const pts  = _curHand === 0 ? _keyPoints : _keyPoints2;
  let nearest = -1, minD = Infinity;
  pts.forEach((pt, i) => {
    const d = Math.hypot(cx - pt.x * w, cy - pt.y * h);
    if (d < HIT && d < minD) { minD = d; nearest = i; }
  });
  return nearest;
}

function _onDown(e) {
  const { x, y } = _getCanvasXY(e);
  _dragIdx = _findNearest(x, y);
  _redraw();
}

function _onMove(e) {
  if (_dragIdx < 0) return;
  e.preventDefault();
  const { x, y } = _getCanvasXY(e);
  const pts = _curHand === 0 ? _keyPoints : _keyPoints2;
  pts[_dragIdx] = {
    x: Math.max(0, Math.min(1, x / _editorCanvas.width)),
    y: Math.max(0, Math.min(1, y / _editorCanvas.height)),
  };
  _redraw();
}

function _onUp() { _dragIdx = -1; _redraw(); }

// ─── イベント登録 ─────────────────────────────────────────

function _setupEvents() {
  _editorCanvas.addEventListener('mousedown',  _onDown);
  _editorCanvas.addEventListener('mousemove',  _onMove);
  _editorCanvas.addEventListener('mouseup',    _onUp);
  _editorCanvas.addEventListener('mouseleave', _onUp);

  _editorCanvas.addEventListener('touchstart', (e) => { e.preventDefault(); _onDown(e); }, { passive: false });
  _editorCanvas.addEventListener('touchmove',  (e) => { e.preventDefault(); _onMove(e); }, { passive: false });
  _editorCanvas.addEventListener('touchend',   (e) => { e.preventDefault(); _onUp();    }, { passive: false });

  window.addEventListener('resize', () => { _resizeCanvas(); _redraw(); });

  document.querySelectorAll('.editor-hand-count-btn').forEach(btn => {
    btn.addEventListener('click', () => _setHandCount(parseInt(btn.dataset.count)));
  });

  document.querySelectorAll('.editor-hand-tab').forEach(btn => {
    btn.addEventListener('click', () => _selectHand(parseInt(btn.dataset.hand)));
  });

  document.getElementById('editor-save-btn').addEventListener('click',  _save);
  document.getElementById('editor-reset-btn').addEventListener('click', _reset);
  document.getElementById('editor-back-btn').addEventListener('click',  closeEditor);
}

// ─── 保存・リセット ───────────────────────────────────────

function _save() {
  const pose = _poses[_curIdx];
  const { computeVecFromKeyPoints } = window.PoseExtractorModule;

  const data = {
    handCount:    _handCount,
    rawKeyPoints: _keyPoints.map(p => ({ ...p })),
    vec:          computeVecFromKeyPoints(_keyPoints),
  };

  if (_handCount === 2) {
    data.rawKeyPoints2 = _keyPoints2.map(p => ({ ...p }));
    data.vec2          = computeVecFromKeyPoints(_keyPoints2);
  }

  _saveDataToStorage(pose.name, data);

  _renderTabs();
  const badgeEl = document.getElementById('editor-saved-badge');
  if (badgeEl) badgeEl.style.display = 'inline';

  const btn  = document.getElementById('editor-save-btn');
  const orig = btn.textContent;
  btn.textContent = '✓ 保存しました！';
  btn.classList.add('editor-btn-flash');
  setTimeout(() => { btn.textContent = orig; btn.classList.remove('editor-btn-flash'); }, 2000);
}

function _reset() {
  const pose = _poses[_curIdx];
  _removeFromStorage(pose.name);

  _handCount = 1;
  _curHand   = 0;
  _dragIdx   = -1;

  const mpData = window.GameModule.getMediapipeVec(pose.name);
  if (mpData && mpData.rawKeyPoints && mpData.rawKeyPoints.length === 12) {
    _keyPoints = mpData.rawKeyPoints.map(p => ({ ...p }));
    window.GameModule.setReferenceVec(pose.name, { handCount: 1, ...mpData });
  } else {
    _keyPoints = DEFAULT_KEY_POINTS.map(p => ({ ...p }));
    window.GameModule.setReferenceVec(pose.name, null);
  }
  _keyPoints2 = DEFAULT_KEY_POINTS2.map(p => ({ ...p }));

  _renderTabs();
  const badgeEl = document.getElementById('editor-saved-badge');
  if (badgeEl) badgeEl.style.display = 'none';

  _updateHandCountUI();
  _redraw();
}

// ─── エクスポート ─────────────────────────────────────────
window.EditorModule = { openEditor, closeEditor };
