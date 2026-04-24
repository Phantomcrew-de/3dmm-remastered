/**
 * helper.mjs — Pure utility functions shared across all modules.
 *
 * No DOM, no Three.js, no side-effects on import.
 */

export {
  rotStepsFromDeg,
  _touchCacheEntry,
  _evictOldestCacheEntries,
  _yieldToBrowser,
  _nextFrame,
  _forceDomComposite,
  _smoothstep,
  _dedupeAndSortKeys,
  _arrayBufferToBase64,
  _base64ToArrayBuffer,
};

// re-export common utils from editor-state for convenience
export { _num, _clamp, _low, normalizeAssetPath } from "./editor-state.mjs";


function rotStepsFromDeg(deg) {
  const d = +deg;
  if (d === 90) return 1;
  if (d === 180) return 2;
  if (d === 270) return 3;
  return 0;
}

function _smoothstep(x) {
  const v = Math.max(0, Math.min(1, x));
  return v * v * (3 - 2 * v);
}


// ─── Cache helpers ───────────────────────────────────────────────────

function _touchCacheEntry(map, key, value) {
  if (!map.has(key)) return;
  map.delete(key);
  map.set(key, value);
}

function _evictOldestCacheEntries(map, limit, disposer) {
  while (map.size > limit) {
    const firstKey = map.keys().next().value;
    const firstVal = map.get(firstKey);
    map.delete(firstKey);
    try { disposer?.(firstKey, firstVal); } catch { }
  }
}


// ─── Async helpers ───────────────────────────────────────────────────

function _yieldToBrowser() {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function _nextFrame() {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function _forceDomComposite(el) {
  try {
    if (!el) return;
    void el.offsetWidth;
    void el.offsetHeight;
    el.getBoundingClientRect();
  } catch { }
}


// ─── Keyframe helpers ────────────────────────────────────────────────

function _dedupeAndSortKeys(keys) {
  if (!Array.isArray(keys) || keys.length <= 1) return Array.isArray(keys) ? keys : [];
  const sorted = keys.slice().sort((a, b) => (+a.t || 0) - (+b.t || 0));
  const out = [];
  const eps = 1e-5;
  for (const k of sorted) {
    const tt = +k.t || 0;
    const prev = out.length ? out[out.length - 1] : null;
    if (prev && Math.abs((+prev.t || 0) - tt) <= eps) {
      // Last key at the same timestamp wins.
      out[out.length - 1] = { ...prev, ...k, t: tt };
    } else {
      out.push({ ...k, t: tt });
    }
  }
  return out;
}


// ─── Base64 ↔ ArrayBuffer ───────────────────────────────────────────

function _arrayBufferToBase64(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function _base64ToArrayBuffer(b64) {
  const binary = atob(b64 || '');
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}