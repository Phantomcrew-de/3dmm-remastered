/**
 * depth.mjs — Spectral-colormap depth texture decoding pipeline.
 *
 * Converts pseudo-colored (Matplotlib "Spectral") depth PNGs to
 * single-channel R8 DataTextures for depth-clip shaders.
 *
 * Dependencies: Three.js (via importmap), helper.mjs utilities.
 */

import * as THREE from "three";

export {
  SPECTRAL_LUT,
  decodeSpectralRGBToIndex,
  loadAndDecodeDepthTexture,
  loadImage,
  setDepthTextureFromUrl,
  setBackgroundImageFromUrl,
  refreshDepthTextureBindings,
  syncCover,
  syncScreenPx,
  getDepthTex,
  setDepthTex,
  getCover,
  getScreenPx,
  getBgDimensions,
  setBgDimensions,
  _primeDepthTextureOnGPU,
  BG_PERF,
  projectLoadUI,
  showProjectLoadOverlay,
  updateProjectLoadOverlay,
  hideProjectLoadOverlay,
  clearPresentationWarmCache,
};


// ─── Imports from project modules ────────────────────────────────────
// These will be wired when the full integration is done.
// For now the module is self-contained with its own caches.

import { computeCoverTransform, renderer, scene3d } from "./render-engine.mjs";
import { ui, syncLabels } from "./ui.mjs";


// ─── Caches ──────────────────────────────────────────────────────────

const _bgImageCache = new Map();
const _bgObjectUrlCache = new Map();
const _depthTextureCache = new Map();
const _bgPresentationWarmCache = new Map();
const _bgPresentationWarmElements = new Map();

const BG_CACHE_LIMIT = 48;
const DEPTH_CACHE_LIMIT = 32;


// ─── Cache helpers (inline to avoid import issues) ───────────────────

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

function _yieldToBrowser() {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function normalizeAssetPath(rel) {
  return String(rel || "").replace(/^\+/, "").replace(/^\/+/, "").replace(/\\/g, "/");
}


// ─── State ───────────────────────────────────────────────────────────

/** Current depth texture (R8 DataTexture decoded from spectral PNG). */
let depthTex = null;

function getDepthTex() { return depthTex; }
function setDepthTex(tex) { depthTex = tex; }

/** Background image dimensions. */
let bgW = 1, bgH = 1;
function getBgDimensions() { return { bgW, bgH }; }
function setBgDimensions(w, h) { bgW = w; bgH = h; }

/** Cover transform vector (maps image coords ↔ screen coords). */
const cover = new THREE.Vector4(1, 1, 0, 0);
function getCover() { return cover; }

/** Screen pixel size for shaders. */
const screenPx = new THREE.Vector2(1, 1);
function getScreenPx() { return screenPx; }

function syncScreenPx() { renderer.getDrawingBufferSize(screenPx); }

function syncCover() {
  const c = computeCoverTransform(innerWidth, innerHeight, bgW, bgH);
  cover.set(c.scaleX, c.scaleY, c.offX, c.offY);
}


// ─── BG_PERF profiling ──────────────────────────────────────────────

const BG_PERF = {
  enabled: true,
  seq: 0,
  activeSwitchId: 0,
  now() { return performance.now(); },
  fmt(ms) { return `${Number(ms || 0).toFixed(1)}ms`; },
  log(...args) { if (this.enabled) console.log("[BG PERF]", ...args); },
  warn(...args) { if (this.enabled) console.warn("[BG PERF]", ...args); },
  begin(kind, entry, extra = {}) {
    const id = ++this.seq;
    const label = normalizeAssetPath(entry?.background || entry?.zbuffer || entry?.id || "unknown");
    const info = { id, kind, label, entry, start: this.now(), marks: [], extra: { ...extra } };
    this.log(`#${id} START ${kind}:`, label, extra);
    return info;
  },
  mark(info, label, extra = {}) {
    if (!info) return;
    const t = this.now();
    const dt = t - info.start;
    info.marks.push({ label, t, dt, extra });
    this.log(`#${info.id} ${info.kind} ${label}: ${this.fmt(dt)}`, extra);
  },
  end(info, extra = {}) {
    if (!info) return;
    const total = this.now() - info.start;
    this.log(`#${info.id} END ${info.kind}: ${info.label} total=${this.fmt(total)}`, extra);
  }
};
window.BG_PERF = BG_PERF;


// ─── Project load overlay ────────────────────────────────────────────

const projectLoadUI = {
  overlay: document.getElementById("projectLoadOverlay"),
  title: document.getElementById("projectLoadTitle"),
  mode: document.getElementById("projectLoadMode"),
  file: document.getElementById("projectLoadFile"),
  detail: document.getElementById("projectLoadDetail"),
  fill: document.getElementById("projectLoadFill"),
  pct: document.getElementById("projectLoadPct"),
  warmHost: document.getElementById("bgWarmHost"),
};

function showProjectLoadOverlay(meta = {}) {
  if (!projectLoadUI.overlay) return;
  projectLoadUI.overlay.classList.add("open");
  projectLoadUI.overlay.setAttribute("aria-hidden", "false");
  updateProjectLoadOverlay(meta);
}

function updateProjectLoadOverlay(meta = {}) {
  if (!projectLoadUI.overlay) return;
  if (meta.title != null) projectLoadUI.title.textContent = String(meta.title || "Project is loading…");
  if (meta.mode != null) projectLoadUI.mode.textContent = String(meta.mode || "Preparing assets");
  if (meta.file != null) projectLoadUI.file.textContent = String(meta.file || "–");
  if (meta.detail != null) projectLoadUI.detail.textContent = String(meta.detail || "Please wait…");
  if (meta.progress != null) {
    const p = Math.max(0, Math.min(1, Number(meta.progress) || 0));
    if (projectLoadUI.fill) projectLoadUI.fill.style.width = `${(p * 100).toFixed(1)}%`;
    if (projectLoadUI.pct) projectLoadUI.pct.textContent = `${Math.round(p * 100)}%`;
  }
}

function hideProjectLoadOverlay() {
  if (!projectLoadUI.overlay) return;
  projectLoadUI.overlay.classList.remove("open");
  projectLoadUI.overlay.setAttribute("aria-hidden", "true");
}

function clearPresentationWarmCache() {
  for (const el of _bgPresentationWarmElements.values()) {
    try { el.remove(); } catch { }
  }
  _bgPresentationWarmElements.clear();
  _bgPresentationWarmCache.clear();
}


// ─── GPU depth priming ───────────────────────────────────────────────

async function _primeDepthTextureOnGPU(tex) {
  if (!tex || !renderer) return tex;
  const t0 = performance.now();
  try {
    if (typeof renderer.initTexture === "function") renderer.initTexture(tex);
    BG_PERF.log("depth-gpu-init", tex.image?.width || tex.source?.data?.width || "?", "x", tex.image?.height || tex.source?.data?.height || "?", BG_PERF.fmt(performance.now() - t0));
  } catch (err) {
    console.debug("Depth texture GPU init skipped", err);
  }
  return tex;
}


// ─── Image loading with cache ────────────────────────────────────────

async function loadImage(url) {
  const u = String(url || "");
  if (!u) throw new Error("Leere Bild-URL.");
  const t0 = performance.now();
  if (_bgImageCache.has(u)) {
    const cached = _bgImageCache.get(u);
    _touchCacheEntry(_bgImageCache, u, cached);
    const value = await cached;
    BG_PERF.log("loadImage cache-hit", normalizeAssetPath(u), BG_PERF.fmt(performance.now() - t0));
    return value;
  }
  const promise = (async () => {
    let objectUrl = _bgObjectUrlCache.get(u) || null;
    const hadObjectUrl = !!objectUrl;
    if (!objectUrl) {
      const tFetch = performance.now();
      const res = await fetch(u, { cache: "force-cache" });
      if (!res.ok) throw new Error(`Bild konnte nicht geladen werden: ${u}`);
      const blob = await res.blob();
      objectUrl = URL.createObjectURL(blob);
      _bgObjectUrlCache.set(u, objectUrl);
      BG_PERF.log("loadImage fetch+blob", normalizeAssetPath(u), BG_PERF.fmt(performance.now() - tFetch));
    }
    const img = await new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = async () => {
        try { if (img.decode) await img.decode(); } catch { }
        resolve(img);
      };
      img.onerror = () => reject(new Error(`Bild konnte nicht geladen werden: ${u}`));
      img.src = objectUrl;
    });
    BG_PERF.log("loadImage decode", normalizeAssetPath(u), BG_PERF.fmt(performance.now() - t0), { hadObjectUrl });
    return img;
  })();
  _bgImageCache.set(u, promise);
  try {
    const img = await promise;
    _bgImageCache.set(u, img);
    _evictOldestCacheEntries(_bgImageCache, BG_CACHE_LIMIT, (key) => {
      const objUrl = _bgObjectUrlCache.get(key);
      if (objUrl) URL.revokeObjectURL(objUrl);
      _bgObjectUrlCache.delete(key);
    });
    return img;
  } catch (err) {
    _bgImageCache.delete(u);
    const objUrl = _bgObjectUrlCache.get(u);
    if (objUrl) URL.revokeObjectURL(objUrl);
    _bgObjectUrlCache.delete(u);
    throw err;
  }
}


// ─── Spectral LUT and depth decode ──────────────────────────────────

// Exact 256-step LUT from Matplotlib "Spectral" colormap (not *_r), 0..255 -> RGB
const SPECTRAL_LUT = new Uint8Array([
  158, 1, 66, 160, 3, 67, 162, 6, 67, 164, 8, 68, 167, 11, 68, 169, 13, 69, 171, 15, 69, 173, 18, 70, 175, 20, 70, 177, 23, 71, 180, 25, 71, 182, 27, 72, 184, 30, 72, 186, 32, 73, 188, 34, 73, 190, 37, 74, 193, 39, 74, 195, 42, 75, 197, 44, 75, 199, 46, 76, 201, 49, 76, 203, 51, 77, 205, 54, 77, 208, 56, 78, 210, 58, 78, 212, 61, 79, 214, 63, 79, 215, 65, 78, 216, 67, 78, 217, 68, 77, 218, 70, 77, 220, 72, 76, 221, 74, 76, 222, 76, 75, 223, 78, 75, 225, 80, 75, 226, 81, 74, 227, 83, 74, 228, 85, 73, 229, 87, 73, 231, 89, 72, 232, 91, 72, 233, 92, 71, 234, 94, 71, 235, 96, 70, 237, 98, 70, 238, 100, 69, 239, 102, 69, 240, 103, 68, 242, 105, 68, 243, 107, 67, 244, 109, 67, 244, 112, 68, 245, 114, 69, 245, 117, 71, 245, 119, 72, 246, 122, 73, 246, 124, 74, 246, 127, 75, 247, 129, 76, 247, 132, 78, 248, 134, 79, 248, 137, 80, 248, 140, 81, 249, 142, 82, 249, 145, 83, 249, 147, 85, 250, 150, 86, 250, 152, 87, 250, 155, 88, 251, 157, 89, 251, 160, 91, 251, 163, 92, 252, 165, 93, 252, 168, 94, 252, 170, 95, 253, 173, 96, 253, 175, 98, 253, 177, 99, 253, 179, 101, 253, 181, 103, 253, 183, 104, 253, 185, 106, 253, 187, 108, 253, 189, 109, 253, 191, 111, 253, 193, 113, 253, 195, 114, 253, 197, 116, 253, 199, 118, 254, 200, 119, 254, 202, 121, 254, 204, 123, 254, 206, 124, 254, 208, 126, 254, 210, 127, 254, 212, 129, 254, 214, 131, 254, 216, 132, 254, 218, 134, 254, 220, 136, 254, 222, 137, 254, 224, 139, 254, 225, 141, 254, 226, 143, 254, 228, 145, 254, 229, 147, 254, 230, 149, 254, 231, 151, 254, 233, 153, 254, 234, 155, 254, 235, 157, 254, 236, 159, 254, 237, 161, 254, 239, 163, 255, 240, 166, 255, 241, 168, 255, 242, 170, 255, 243, 172, 255, 245, 174, 255, 246, 176, 255, 247, 178, 255, 248, 180, 255, 250, 182, 255, 251, 184, 255, 252, 186, 255, 253, 188, 255, 254, 190, 255, 255, 190, 254, 254, 189, 253, 254, 187, 252, 254, 186, 251, 253, 184, 250, 253, 183, 249, 252, 181, 248, 252, 180, 247, 252, 178, 246, 251, 176, 245, 251, 175, 244, 250, 173, 243, 250, 172, 242, 250, 170, 241, 249, 169, 240, 249, 167, 239, 249, 166, 238, 248, 164, 237, 248, 163, 236, 247, 161, 235, 247, 160, 234, 247, 158, 233, 246, 157, 232, 246, 155, 231, 245, 154, 230, 245, 152, 228, 244, 152, 225, 243, 153, 223, 242, 153, 221, 241, 154, 218, 240, 154, 216, 239, 155, 214, 238, 155, 211, 237, 156, 209, 237, 156, 207, 236, 157, 205, 235, 157, 202, 234, 158, 200, 233, 158, 198, 232, 159, 195, 231, 159, 193, 230, 160, 191, 229, 160, 188, 228, 160, 186, 227, 161, 184, 226, 161, 181, 225, 162, 179, 224, 162, 177, 223, 163, 174, 222, 163, 172, 221, 164, 170, 220, 164, 167, 219, 164, 164, 218, 164, 162, 217, 164, 159, 216, 164, 156, 215, 164, 153, 214, 164, 151, 213, 164, 148, 212, 164, 145, 211, 164, 143, 210, 164, 140, 209, 164, 137, 208, 164, 134, 207, 165, 132, 206, 165, 129, 205, 165, 126, 204, 165, 124, 202, 165, 121, 201, 165, 118, 200, 165, 116, 199, 165, 113, 198, 165, 110, 197, 165, 107, 196, 165, 105, 195, 165, 102, 194, 165, 100, 192, 166, 98, 189, 167, 96, 187, 168, 94, 185, 169, 92, 183, 170, 90, 180, 171, 88, 178, 172, 86, 176, 173, 84, 174, 173, 82, 171, 174, 80, 169, 175, 78, 167, 176, 75, 164, 177, 73, 162, 178, 71, 160, 179, 69, 158, 180, 67, 155, 181, 65, 153, 182, 63, 151, 183, 61, 149, 184, 59, 146, 185, 57, 144, 186, 55, 142, 187, 53, 139, 188, 51, 137, 189, 51, 135, 188, 53, 133, 187, 54, 130, 186, 56, 128, 185, 58, 126, 184, 59, 124, 183, 61, 121, 182, 63, 119, 181, 65, 117, 180, 66, 115, 179, 68, 113, 178, 70, 110, 177, 72, 108, 176, 73, 106, 175, 75, 104, 174, 77, 101, 173, 78, 99, 172, 80, 97, 170, 82, 95, 169, 84, 92, 168, 85, 90, 167, 87, 88, 166, 89, 86, 165, 91, 83, 164, 92, 81, 163, 94, 79, 162
]);

function decodeSpectralRGBToIndex(r, g, b) {
  let best = 1e9, bestI = 0;
  // brute-force nearest match in LUT (256 entries)
  for (let i = 0, j = 0; i < 256; i++, j += 3) {
    const dr = r - SPECTRAL_LUT[j];
    const dg = g - SPECTRAL_LUT[j + 1];
    const db = b - SPECTRAL_LUT[j + 2];
    const d = dr * dr + dg * dg + db * db;
    if (d < best) {
      best = d; bestI = i;
      if (d === 0) break;
    }
  }
  return bestI; // 0..255
}

function isGreyscalePixel(r, g, b) {
  return Math.abs(r - g) <= 2 && Math.abs(g - b) <= 2 && Math.abs(r - b) <= 2;
}

function decodeDepthPixelToShaderDepth01Byte(r, g, b) {
  if (isGreyscalePixel(r, g, b)) {
    // Match tree.js.renderer.html: z-map white is near/front and black is far/back.
    // Store shader depth01: 0 = near/front, 255 = far/back.
    return 255 - r;
  }
  return decodeSpectralRGBToIndex(r, g, b);
}

async function loadAndDecodeDepthTexture(url) {
  const u = String(url || "");
  if (!u) throw new Error("Leere ZBuffer-URL.");
  const t0 = performance.now();
  if (_depthTextureCache.has(u)) {
    const cached = _depthTextureCache.get(u);
    _touchCacheEntry(_depthTextureCache, u, cached);
    const value = await cached;
    BG_PERF.log("loadZBuffer cache-hit", normalizeAssetPath(u), BG_PERF.fmt(performance.now() - t0));
    return value;
  }
  const promise = (async () => {
    const tImg = performance.now();
    const img = await loadImage(u);
    BG_PERF.log("loadZBuffer image-ready", normalizeAssetPath(u), BG_PERF.fmt(performance.now() - tImg));
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;

    const tDecode = performance.now();
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);

    const out = new Uint8Array(w * h); // R8 depth01 byte: 0=near/front, 255=far/back
    let greyCount = 0;
    for (let p = 0, o = 0; o < out.length; o++, p += 4) {
      const r = data[p], g = data[p + 1], b = data[p + 2];
      if (isGreyscalePixel(r, g, b)) greyCount++;
      out[o] = decodeDepthPixelToShaderDepth01Byte(r, g, b);
    }
    BG_PERF.log("loadZBuffer depth-decode", normalizeAssetPath(u), BG_PERF.fmt(performance.now() - tDecode), {
      w, h,
      mode: greyCount > out.length * 0.90 ? "greyscale-white-near" : "spectral"
    });

    const tTex = performance.now();
    const tex = new THREE.DataTexture(out, w, h, THREE.RedFormat, THREE.UnsignedByteType);
    tex.colorSpace = THREE.NoColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    BG_PERF.log("loadZBuffer texture-create", normalizeAssetPath(u), BG_PERF.fmt(performance.now() - tTex), { w, h });
    return tex;
  })();
  _depthTextureCache.set(u, promise);
  try {
    const tex = await promise;
    _depthTextureCache.set(u, tex);
    _evictOldestCacheEntries(_depthTextureCache, DEPTH_CACHE_LIMIT, (_key, value) => {
      Promise.resolve(value).then(tex => { try { tex?.dispose?.(); } catch { } }).catch(() => { });
    });
    return tex;
  } catch (err) {
    _depthTextureCache.delete(u);
    throw err;
  }
}


// ─── Depth texture binding ──────────────────────────────────────────

/**
 * Update all shader uniforms that reference the depth texture.
 * Called after loading a new depth map or switching backgrounds.
 *
 * @param {object} opts - { cubeMat, shadowMat, overlayMat } shader materials
 */
function refreshDepthTextureBindings(opts = {}) {
  const t0 = performance.now();
  const { cubeMat, shadowMat, overlayMat } = opts;
  if (cubeMat?.uniforms?.uDepth) cubeMat.uniforms.uDepth.value = depthTex;
  if (shadowMat?.uniforms?.uDepth) shadowMat.uniforms.uDepth.value = depthTex;
  if (overlayMat?.uniforms?.uDepth) overlayMat.uniforms.uDepth.value = depthTex;
  let matCount = 0;
  scene3d.traverse(obj => {
    const mats = obj?.material ? (Array.isArray(obj.material) ? obj.material : [obj.material]) : [];
    for (const mat of mats) {
      if (!mat) continue;
      if (mat.uniforms?.uDepth) mat.uniforms.uDepth.value = depthTex;
      if (mat.userData?.__dcUniforms?.uDepth) mat.userData.__dcUniforms.uDepth.value = depthTex;
      matCount++;
    }
  });
  if (BG_PERF.activeSwitchId) BG_PERF.log(`switch#${BG_PERF.activeSwitchId} depth-bind`, BG_PERF.fmt(performance.now() - t0), { matCount });
}

async function setDepthTextureFromUrl(url) {
  const newTex = await loadAndDecodeDepthTexture(url);
  depthTex = newTex;
  // Note: caller must provide materials context via refreshDepthTextureBindings
}


// ─── Background image helpers ────────────────────────────────────────

async function setBackgroundImageFromUrl(url) {
  const bgImgEl = document.getElementById("bg");
  if (!bgImgEl) throw new Error("Background image element not found.");
  const img = await loadImage(url);
  const objectUrl = _bgObjectUrlCache.get(String(url || "")) || url;
  await new Promise((resolve, reject) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      bgW = img.naturalWidth || img.width || bgImgEl.naturalWidth || bgImgEl.width || 1;
      bgH = img.naturalHeight || img.height || bgImgEl.naturalHeight || bgImgEl.height || 1;
      syncCover();
      resolve();
    };
    bgImgEl.onload = done;
    bgImgEl.onerror = () => {
      if (settled) return;
      settled = true;
      reject(new Error(`Background konnte nicht geladen werden: ${url}`));
    };
    if (bgImgEl.src === objectUrl && bgImgEl.complete && bgImgEl.naturalWidth > 0) {
      done();
      return;
    }
    bgImgEl.src = objectUrl;
    if (bgImgEl.complete && bgImgEl.naturalWidth > 0) done();
  });
}
