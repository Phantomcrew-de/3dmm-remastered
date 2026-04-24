/**
 * editor-state.mjs — Shared mutable state hub for the 3DMM Editor.
 *
 * Every module imports its shared state objects from here to avoid circular
 * dependencies.  Only plain data objects and tiny pure utilities live here;
 * no DOM, no Three.js, no side-effects on import.
 */

export {
  /* tiny utils */
  _num, _clamp, _low, _genId, _abToB64, _b64ToAb,

  /* background entry helpers */
  normalizeAssetPath,
  _cloneBackgroundEntry,
  _makeDefaultBackgroundEntry,
  _backgroundEntrySignature,
  _getBackgroundDisplayLabel,
  _dedupeAndSortBackgroundKeys,

  /* state objects */
  timeline,
  anim,
  characters,
  getActiveCharacter, setActiveCharacterRef,
  backgroundState,
  onionSkin,
  takeManagerState,
  historyState,

  /* constants */
  TL_FPS, TL_DT, JKL_SHUTTLE_SPEEDS, PRECISE_STEP_DT,
  PROJECT_MAGIC, PROJECT_VERSION,
  HISTORY_LIMIT,
  UI_FIELDS,
  DEFAULT_ACTOR_TRANSFORM,
  BG_CACHE_LIMIT, DEPTH_CACHE_LIMIT, BG_BUNDLE_CACHE_LIMIT,
};

// ─── Tiny utilities ──────────────────────────────────────────────────

function _num(v, fallback = 0) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function _clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

const _low = (s) => (s ?? "").toString().trim().toLowerCase();

let _idSeq = 0;
function _genId() { return `clip_${Date.now()}_${++_idSeq}_${Math.random().toString(36).slice(2, 6)}`; }

function _abToB64(ab) {
  let binary = "";
  const bytes = new Uint8Array(ab);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function _b64ToAb(b64) {
  const bin = atob(b64 || "");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}


// ─── Asset path normalizer ───────────────────────────────────────────

function normalizeAssetPath(rel) {
  return String(rel || "").replace(/^\+/, "").replace(/^\/+/, "").replace(/\\/g, "/");
}


// ─── Background entry helpers ────────────────────────────────────────

function _cloneBackgroundEntry(entry) {
  if (!entry) return null;
  return {
    id: entry.id || entry.name_key || entry.background || null,
    relative_dir: normalizeAssetPath(entry.relative_dir || ""),
    background: normalizeAssetPath(entry.background || ""),
    zbuffer: normalizeAssetPath(entry.zbuffer || ""),
    meta: {
      focal_mm: _num(entry?.meta?.focal_mm, 86),
      horizon_y: _num(entry?.meta?.horizon_y, -0.3),
      pitch_deg: _num(entry?.meta?.pitch_deg, 0),
      cam_height: _num(entry?.meta?.cam_height, 1.2),
    },
  };
}

function _makeDefaultBackgroundEntry() {
  return _cloneBackgroundEntry({
    id: '__default_background__',
    relative_dir: '',
    background: 'background.jpg',
    zbuffer: 'depth.png',
    meta: { focal_mm: 86, horizon_y: -0.3, pitch_deg: 0, cam_height: 1.2 },
  });
}

function _backgroundEntrySignature(entry) {
  const v = _cloneBackgroundEntry(entry);
  return v ? JSON.stringify(v) : "";
}

function _getBackgroundDisplayLabel(entry) {
  const v = _cloneBackgroundEntry(entry);
  if (!v) return 'Kein Background';
  if (String(v.id || '') === '__default_background__') return 'Default';
  const raw = String(v.id || v.name_key || v.background || 'Background');
  const tail = raw.split('/').pop() || raw;
  return tail.replace(/\.[^.]+$/, '') || 'Background';
}

function _dedupeAndSortBackgroundKeys(keys) {
  if (!Array.isArray(keys) || keys.length <= 1) return Array.isArray(keys) ? keys.slice() : [];
  const sorted = keys.slice().sort((a, b) => _num(a?.t, 0) - _num(b?.t, 0));
  const out = [];
  const eps = 1e-5;
  for (const k of sorted) {
    const tt = _num(k?.t, 0);
    const entry = _cloneBackgroundEntry(k?.entry || k?.backgroundSelection || k);
    if (!entry || !entry.background || !entry.zbuffer) continue;
    const prev = out.length ? out[out.length - 1] : null;
    if (prev && Math.abs(_num(prev.t, 0) - tt) <= eps) out[out.length - 1] = { t: tt, entry };
    else out.push({ t: tt, entry });
  }
  return out;
}


// ─── Constants ───────────────────────────────────────────────────────

const TL_FPS = 5;
const TL_DT = 1 / TL_FPS;
const JKL_SHUTTLE_SPEEDS = [1, 2, 4, 8];
const PRECISE_STEP_DT = 1 / 24;

const PROJECT_MAGIC = "3dmm-remastered-project";
const PROJECT_VERSION = 2;

const HISTORY_LIMIT = 10;

const DEFAULT_ACTOR_TRANSFORM = {
  position: [5.632, -4.734, -25.999],
  rotationYDeg: -43.32,
  scale: [1, 1, 1],
};

const BG_CACHE_LIMIT = 48;
const DEPTH_CACHE_LIMIT = 32;
const BG_BUNDLE_CACHE_LIMIT = 96;

/** UI field keys that are serialised into project files. */
const UI_FIELDS = [
  "overlay", "fmm", "horizon", "pitch", "camHeight",
  "showH", "showGrid", "drawSceneDepth",
  "shStr", "shRad", "shSoft", "shOx", "shOy",
  "exposure", "lightMul",
  "sx", "sy", "ox", "oy",
  "rot", "fx", "fy", "bias",
  "clipSoft", "backDepthMul",
  "mouthFps", "mouthThrF", "mouthThrE", "mouthThrA",
  "walkMin", "walkMax", "runMin", "runMax",
  "animXfade",
];


// ─── Shared mutable state objects ────────────────────────────────────

const timeline = {
  keys: /** @type {Array<{t:number, p:number[], q:number[], s:number[], a:string|null, at:number, spd:number}>} */ ([]),
  backgroundKeys: /** @type {Array<{t:number, entry:any}>} */ ([]),
  duration: 0,
  playhead: 0,
  playing: false,
  playbackRate: 1,
  shuttleStepIndex: 0,
  shuttleDirection: 1,
  recArmed: false,
  recording: false,
  _recAccum: 0,
  _lastRecT: 0,
  _nextRecT: 0,
  _scrubbing: false,
  _bgApplyToken: 0,
  _bgAppliedSignature: null,
};

const anim = {
  root: null,
  mixer: null,
  clips: [],
  actions: new Map(),   // lowerName -> AnimationAction
  action: null,         // currently selected action
  selectedName: null,   // null => none
  restClip: null,
  restAction: null,
  holdClip: null,
  holdAction: null,
  playingWhileDrag: false,
  blendRemaining: 0,
  blendPauseAfter: false,
  blendFrom: null,
  cycleSpeed: 1,
};

const characters = [];

/** @type {any} */
let _activeCharacter = null;

function getActiveCharacter() { return _activeCharacter; }
function setActiveCharacterRef(ch) { _activeCharacter = ch; }

const backgroundState = {
  loaded: false,
  loadingPromise: null,
  entries: [],
  groups: [],
  page: 0,
  mode: "groups",
  selectedGroupKey: null,
  currentEntryId: '__default_background__',
  currentSelection: _makeDefaultBackgroundEntry(),
  pageSize: 9,
  jsonUrl: null,
  assetBase: "./Backgrounds/",
};

const onionSkin = {
  enabled: false,
  opacity: 0.50,
  pastFrames: 10,
  futureFrames: 10,
  stepFps: 5,
};

const takeManagerState = {
  panelVisible: false,
  scenes: [],
  panelPos: null,
  activeSceneIndex: -1,
  activeTakeId: null,
  applying: false,
  drag: null,
  nameEditing: false,
};

const historyState = {
  undo: [],
  redo: [],
  restoring: false,
  moveGesture: null,
};
