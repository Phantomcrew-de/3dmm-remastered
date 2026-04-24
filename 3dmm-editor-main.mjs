import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";


import { ui, setLanguage, tr, trFormat, populateLanguageSelect, applyI18n, i18nObserver, currentLanguage, syncLabels, toggleMenu, exportPreviewCanvas } from "./ui.mjs";
import { renderer, computeCoverTransform, scene3d } from "./render-engine.mjs";
import { rotStepsFromDeg } from "./helper.mjs";
import { parseWavToAudioBuffer, decodeAudioCompat } from "./media.mjs";


// ---------- Audio decode helpers are now in media.mjs ----------
// (parseWavToAudioBuffer, decodeAudioCompat — also attached to window.* for backward compat)



// PBR-friendly environment light for brighter, more natural textured shading
const pmrem = new THREE.PMREMGenerator(renderer);
scene3d.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
pmrem.dispose();


const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 50);
camera.position.set(0, 1.2, 5.0);
if (ui.camHeight) camera.position.y = +(ui.camHeight.value || 1.2);
camera.lookAt(0, 1.0, 0);

// ---------- Lighting (for textured / PBR materials) ----------
// Without lights, MeshStandard/Physical materials from the GLB will render black.
// Brighter 3‑point setup + a touch of ambient for better texture visibility.
//const hemiLight = new THREE.HemisphereLight(0xffffff, 0x334455, 0.90);
const hemiLight = new THREE.HemisphereLight(0x0000ff, 0xff0000, 0.90);
hemiLight.position.set(0, 10, 0);
scene3d.add(hemiLight);

const ambient = new THREE.AmbientLight(0xffffff, 0.14);
//const ambient = new THREE.AmbientLight(0x00ff00, 1);
scene3d.add(ambient);

const keyLight = new THREE.DirectionalLight(0xffffff, 1.65);
keyLight.position.set(3.5, 7.0, 2.5);
keyLight.target.position.set(0, 1.0, 0);
scene3d.add(keyLight);
scene3d.add(keyLight.target);

const fillLight = new THREE.DirectionalLight(0xffffff, 0.65);
fillLight.position.set(-4.5, 4.0, -2.5);
scene3d.add(fillLight);





// update light intensities based on UI multiplier, and remember base intensities for clean scaling

const baseLights = {
    hemi: hemiLight.intensity,
    ambient: ambient.intensity,
    key: keyLight.intensity,
    fill: fillLight.intensity,
};

function applyBrightnessFromUI() {
    const exposure = +ui.exposure.value;
    const lightMul = +ui.lightMul.value;
    renderer.toneMappingExposure = exposure;

    hemiLight.intensity = baseLights.hemi * lightMul;
    ambient.intensity = baseLights.ambient * lightMul;
    keyLight.intensity = baseLights.key * lightMul;
    fillLight.intensity = baseLights.fill * lightMul;
}


// register event listeners for UI controls
["input", "change"].forEach(evt => {
    Object.keys(ui).forEach(k => {
        const el = ui[k];
        if (!el) return;
        const t = el.tagName;
        if (t === "INPUT" || t === "SELECT") el.addEventListener(evt, syncLabels);
    });
});


// Animation transition duration (cross-fade)
// preserve the value from the HTML / saved project / menu instead of forcing 0.25 here.
if (!ui.animXfade.value) ui.animXfade.value = 0.50;
syncLabels();



// ---------- background size after loading ----------
const bgImgEl = document.getElementById("bg");
await (bgImgEl.complete ? Promise.resolve() : new Promise(res => bgImgEl.addEventListener("load", res, { once: true })));
let bgW = bgImgEl.naturalWidth || 1;
let bgH = bgImgEl.naturalHeight || 1;





// ---------- three.js ----------

document.body.appendChild(renderer.domElement);


document.body.appendChild(exportPreviewCanvas);
const exportPreviewCtx = exportPreviewCanvas.getContext('2d', { alpha: false, desynchronized: true });






//TODO: add sane controls for camera extrinsics and intrinsics
// as well as projection matrix parameters
// maybe explain with a sketch

const SENSOR_HEIGHT_MM = 24.0;
function focalToFovDeg(fmm) {
    const f = Math.max(1e-6, fmm);
    return 2 * Math.atan(SENSOR_HEIGHT_MM / (2 * f)) * (180 / Math.PI);
}

// IMPORTANT: keep projectionMatrixInverse valid for raycasting after manual edit
function applyHorizonShift(cam, shiftY) {
    cam.updateProjectionMatrix();
    cam.projectionMatrix.elements[9] = shiftY * 2.0;
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
}

// always update camera BEFORE rendering
function updateCameraFromUI() {
    camera.fov = focalToFovDeg(+ui.fmm.value);
    camera.position.y = +(ui.camHeight ? ui.camHeight.value : 1.2);
    camera.rotation.set(THREE.MathUtils.degToRad(+ui.pitch.value), 0, 0);
    camera.updateMatrixWorld(true);
    applyHorizonShift(camera, +ui.horizon.value);
    camera.updateMatrixWorld(true);
}

// ---------- Depth: decode Spectral (red->...->blue) PNG to single-channel R8 ----------
// This avoids "waves" and geometric bending caused by approximate inverse colormap in-shader.
const _bgImageCache = new Map();
const _bgObjectUrlCache = new Map();
const _depthTextureCache = new Map();
const _bgLayerCache = new Map();
const _bgPinnedLayerKeys = new Set();
let _activeBgLayerKey = "";
const _backgroundBundleCache = new Map();
const BG_CACHE_LIMIT = 48;
const DEPTH_CACHE_LIMIT = 32;
const BG_BUNDLE_CACHE_LIMIT = 96;
const _bgPresentationWarmCache = new Map();
const _bgPresentationWarmElements = new Map();

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

function normalizeAssetPath(rel) {
    return String(rel || "").replace(/^\+/, "").replace(/^\/+/, "").replace(/\\/g, "/");
}

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

function _hideAllBackgroundLayers(exceptKey = "") {
    for (const [key, img] of _bgLayerCache.entries()) {
        if (!img) continue;
        const active = key && key === exceptKey;
        img.classList.toggle("active", !!active);
        img.style.opacity = active ? "1" : "0";
    }
}

async function ensureBackgroundLayer(bundle, opts = {}) {
    if (!bundle) return null;
    const sig = String(bundle.sig || _backgroundEntrySignature(bundle.entry) || `${bundle.bgUrl || ''}|${bundle.zbUrl || ''}`);
    const stage = document.getElementById("bgStage");
    const objectUrl = _bgObjectUrlCache.get(String(bundle.bgUrl || "")) || bundle.bgUrl;
    if (!stage || !objectUrl) return null;
    let layer = _bgLayerCache.get(sig) || null;
    if (!layer) {
        layer = new Image();
        layer.className = "bgLayer";
        layer.alt = "";
        layer.decoding = "async";
        layer.loading = "eager";
        layer.dataset.bgSig = sig;
        stage.appendChild(layer);
        _bgLayerCache.set(sig, layer);
    }
    if (opts.pin) _bgPinnedLayerKeys.add(sig);
    if (layer.src !== objectUrl) layer.src = objectUrl;
    try { if (layer.decode) await layer.decode(); } catch { }
    await _yieldToBrowser();
    return layer;
}

async function warmBackgroundLayer(bundle, opts = {}) {
    const layer = await ensureBackgroundLayer(bundle, opts);
    if (!layer) return null;
    const prev = _activeBgLayerKey;
    layer.style.opacity = "0.001";
    await _yieldToBrowser();
    layer.style.opacity = "0";
    _hideAllBackgroundLayers(prev);
    return layer;
}

function applyBackgroundLayer(bundle) {
    if (!bundle) return false;
    const sig = String(bundle.sig || _backgroundEntrySignature(bundle.entry) || `${bundle.bgUrl || ''}|${bundle.zbUrl || ''}`);
    const layer = _bgLayerCache.get(sig) || null;
    if (!layer) return false;
    _activeBgLayerKey = sig;
    _hideAllBackgroundLayers(sig);
    if (bgImgEl) bgImgEl.style.opacity = "0";
    return true;
}

async function warmBackgroundBundleForPresentation(bundle) {
    if (!bundle) return null;
    const sig = String(bundle.sig || _backgroundEntrySignature(bundle.entry) || `${bundle.bgUrl || ''}|${bundle.zbUrl || ''}`);
    if (_bgPresentationWarmCache.has(sig)) return await _bgPresentationWarmCache.get(sig);
    const promise = (async () => {
        const img = await warmBackgroundLayer(bundle, { pin: true });
        _bgPresentationWarmElements.set(sig, img);
        await _yieldToBrowser();
        await _yieldToBrowser();
        return img;
    })();
    _bgPresentationWarmCache.set(sig, promise);
    try {
        const img = await promise;
        _bgPresentationWarmCache.set(sig, Promise.resolve(img));
        return img;
    } catch (err) {
        _bgPresentationWarmCache.delete(sig);
        throw err;
    }
}

function _capturePresentationWarmState() {
    return {
        bgSrc: String(bgImgEl?.src || ""),
        bgW, bgH,
        depthTex,
        fmm: ui.fmm ? String(ui.fmm.value) : "",
        horizon: ui.horizon ? String(ui.horizon.value) : "",
        pitch: ui.pitch ? String(ui.pitch.value) : "",
        camHeight: ui.camHeight ? String(ui.camHeight.value) : "",
        currentEntryId: backgroundState.currentEntryId,
        currentSelection: _cloneBackgroundEntry(backgroundState.currentSelection),
        appliedSignature: timeline._bgAppliedSignature,
    };
}

async function _restorePresentationWarmState(state) {
    if (!state) return;
    try {
        bgW = Number(state.bgW) || bgW || 1;
        bgH = Number(state.bgH) || bgH || 1;
        syncCover();
        if (bgImgEl && state.bgSrc) {
            if (bgImgEl.src !== state.bgSrc) bgImgEl.src = state.bgSrc;
            try { if (bgImgEl.decode) await bgImgEl.decode(); } catch { }
            bgImgEl.style.opacity = state.appliedSignature ? "0" : "1";
        }
        _activeBgLayerKey = state.appliedSignature || "";
        _hideAllBackgroundLayers(_activeBgLayerKey);
        if (state.depthTex) {
            depthTex = state.depthTex;
            refreshDepthTextureBindings();
        }
        if (ui.fmm) ui.fmm.value = state.fmm;
        if (ui.horizon) ui.horizon.value = state.horizon;
        if (ui.pitch) ui.pitch.value = state.pitch;
        if (ui.camHeight && state.camHeight !== undefined && state.camHeight !== "") ui.camHeight.value = state.camHeight;
        syncLabels();
        updateCameraFromUI();
        backgroundState.currentEntryId = state.currentEntryId || "";
        backgroundState.currentSelection = _cloneBackgroundEntry(state.currentSelection);
        timeline._bgAppliedSignature = state.appliedSignature || null;
        await _yieldToBrowser();
        await _yieldToBrowser();
    } catch (err) {
        console.debug("Presentation warm-state restore skipped", err);
    }
}

async function warmBackgroundBundleByRealApply(bundle) {
    if (!bundle) return null;
    const sig = String(bundle.sig || _backgroundEntrySignature(bundle.entry) || `${bundle.bgUrl || ''}|${bundle.zbUrl || ''}`);
    if (_bgPresentationWarmCache.has(`real:${sig}`)) return await _bgPresentationWarmCache.get(`real:${sig}`);
    const promise = (async () => {
        await ensureBackgroundLayer(bundle, { pin: true });
        applyBackgroundBundleSync(bundle, { recordTimeline: false, source: "warmup" });
        applyBackgroundLayer(bundle);
        refreshDepthTextureBindings();
        await _yieldToBrowser();
        await _yieldToBrowser();
        await _yieldToBrowser();
        return bundle;
    })();
    _bgPresentationWarmCache.set(`real:${sig}`, promise);
    try {
        const warmed = await promise;
        _bgPresentationWarmCache.set(`real:${sig}`, Promise.resolve(warmed));
        return warmed;
    } catch (err) {
        _bgPresentationWarmCache.delete(`real:${sig}`);
        throw err;
    }
}

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

function _forceDomComposite(el) {
    try {
        if (!el) return;
        void el.offsetWidth;
        void el.offsetHeight;
        el.getBoundingClientRect();
    } catch { }
}

function _flushRendererNow() {
    if (!renderer) return;
    try {
        renderer.compile(scene3d, camera);
        renderer.compile(shadowScene, orthoCam);
        renderer.compile(overlayScene, orthoCam);
    } catch { }
    try {
        const _tm = renderer.toneMapping;
        const _tme = renderer.toneMappingExposure;
        renderer.toneMapping = THREE.NoToneMapping;
        renderer.toneMappingExposure = 1.0;
        renderer.setRenderTarget(rtScene);
        renderer.clear();
        if (+ui.shStr.value > 0.0001) renderer.render(shadowScene, orthoCam);
        renderer.render(scene3d, camera);
        if (+ui.overlay.value > 0.001) renderer.render(overlayScene, orthoCam);
        renderer.setRenderTarget(null);
        renderer.toneMapping = _tm;
        renderer.toneMappingExposure = _tme;
        presentMat.uniforms.tTex.value = rtScene.texture;
        renderer.clear();
        renderer.render(presentScene, postCam);
        try {
            const gl = renderer.getContext?.();
            gl?.flush?.();
            gl?.finish?.();
        } catch { }
    } catch (err) {
        console.debug("Warm render flush skipped", err);
    }
}

async function _forceWarmBundlePresentation(bundle, frames = 3) {
    if (!bundle) return;
    const sig = String(bundle.sig || _backgroundEntrySignature(bundle.entry) || `${bundle.bgUrl || ''}|${bundle.zbUrl || ''}`);
    const layer = await ensureBackgroundLayer(bundle, { pin: true });
    applyBackgroundBundleSync(bundle, { recordTimeline: false, source: "warmup-scene" });
    applyBackgroundLayer(bundle);
    _forceDomComposite(layer);
    _forceDomComposite(bgImgEl);
    refreshDepthTextureBindings();
    for (let i = 0; i < frames; i++) {
        _flushRendererNow();
        await _yieldToBrowser();
        _forceDomComposite(layer);
    }
    _bgPinnedLayerKeys.add(sig);
}

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


//old version

/*

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

        const out = new Uint8Array(w * h); // R8: 0..255
        for (let p = 0, o = 0; o < out.length; o++, p += 4) {
            const r = data[p], g = data[p + 1], b = data[p + 2];
            out[o] = decodeSpectralRGBToIndex(r, g, b);
        }
        BG_PERF.log("loadZBuffer spectral-decode", normalizeAssetPath(u), BG_PERF.fmt(performance.now() - tDecode), { w, h });

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

*/

// greyscale decode (RGB → just use luminance or R channel)
function decodeGreyscale(r, g, b) {
    // Decode the visible z-map brightness exactly like the old tree.js.renderer.html:
    // white pixels mean near/front, black pixels mean far/back.
    // The depth-clip shaders expect depth01: 0 = near/front, 1 = far/back.
    const grey = (r === g && g === b) ? r : ((0.299 * r + 0.587 * g + 0.114 * b) | 0);
    return 255 - grey;
}


// detect BMP from URL
function isBMP(url) {
    return /\.bmp$/i.test(url);
}


// minimal 8-bit BMP decoder (uncompressed only)
async function loadBMP8Bit(url) {
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    const dv = new DataView(buf);

    const dataOffset = dv.getUint32(10, true);
    const width = dv.getInt32(18, true);
    const height = dv.getInt32(22, true);
    const bpp = dv.getUint16(28, true);

    if (bpp !== 8) {
        throw new Error("Only 8-bit BMP supported");
    }

    const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
    const out = new Uint8Array(width * Math.abs(height));

    let ptr = dataOffset;

    const flipped = height > 0; // BMP stored bottom-up
    const h = Math.abs(height);

    for (let y = 0; y < h; y++) {
        const row = flipped ? (h - 1 - y) : y;
        for (let x = 0; x < width; x++) {
            // 8-bit BMP z-map uses the same convention as PNG/JPG z-maps:
                // white = near/front, black = far/back. Store shader depth01 instead.
                out[row * width + x] = 255 - dv.getUint8(ptr++);
        }
        ptr += rowSize - width;
    }

    return { data: out, width, height: h };
}


//main depth texture loading function
//TODO: add switches between colormap formats in ui
//TODO; right now maps to material for depth clipping with 8-bit resolution, add support for 24-bit 

async function loadAndDecodeDepthTexture(url) {
    const u = String(url || "");
    if (!u) throw new Error("Leere ZBuffer-URL.");

    // --- BMP path ---
    if (isBMP(u)) {
        const bmp = await loadBMP8Bit(u);

        const tex = new THREE.DataTexture(
            bmp.data,
            bmp.width,
            bmp.height,
            THREE.RedFormat,
            THREE.UnsignedByteType
        );

        tex.colorSpace = THREE.NoColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.needsUpdate = true;

        return tex;
    }

    // --- Standard image path (PNG/JPG greyscale) ---
    const img = await loadImage(u);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);

    const { data } = ctx.getImageData(0, 0, w, h);

    const out = new Uint8Array(w * h);

    for (let p = 0, o = 0; o < out.length; o++, p += 4) {
        const r = data[p];
        const g = data[p + 1];
        const b = data[p + 2];

        out[o] = decodeGreyscale(r, g, b);
    }

    const tex = new THREE.DataTexture(
        out,
        w,
        h,
        THREE.RedFormat,
        THREE.UnsignedByteType
    );

    tex.colorSpace = THREE.NoColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;

    return tex;
}

let depthTex = await loadAndDecodeDepthTexture("./depth.png");

const cover = new THREE.Vector4(1, 1, 0, 0);
function syncCover() {
    const c = computeCoverTransform(innerWidth, innerHeight, bgW, bgH);
    cover.set(c.scaleX, c.scaleY, c.offX, c.offY);
}
syncCover();

async function setBackgroundImageFromUrl(url) {
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

function refreshDepthTextureBindings() {
    const t0 = performance.now();
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
    refreshDepthTextureBindings();
}

const screenPx = new THREE.Vector2(1, 1);
function syncScreenPx() { renderer.getDrawingBufferSize(screenPx); }
syncScreenPx();

// ---------- Cube material (unchanged shader logic) ----------
const cubeMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
        uDepth: { value: depthTex },
        uNear: { value: camera.near },
        uFar: { value: camera.far },
        uCamPos: { value: camera.position.clone() },
        uColor: { value: new THREE.Color(0x55ccff) },

        uScreenPx: { value: screenPx },
        uCover: { value: cover },

        uScale: { value: new THREE.Vector2(1, 1) },
        uOffset: { value: new THREE.Vector2(0, 0) },
        uFlip: { value: new THREE.Vector2(0, 0) },
        uRot: { value: 0.0 },

        uBias: { value: 0.002 },


        uClipSoft: { value: 0.01 },
        uDfRadius: { value: 2.1 },
        uDfEdge: { value: 0.051 },
    },
    vertexShader: `
        varying vec3 vN;
        varying vec3 vWPos;
        void main(){
          vN = normalize(mat3(modelMatrix) * normal);
          vec4 wPos = modelMatrix * vec4(position, 1.0);
          vWPos = wPos.xyz;
          gl_Position = projectionMatrix * viewMatrix * wPos;
        }
      `,
    fragmentShader: `
        uniform sampler2D uDepth;
        uniform float uNear;
        uniform float uFar;
        uniform vec3 uCamPos;
        uniform vec3 uColor;

        uniform vec2 uScreenPx;
        uniform vec4 uCover;

        uniform vec2 uScale;
        uniform vec2 uOffset;
        uniform vec2 uFlip;
        uniform float uRot;

        uniform float uBias;
        uniform float uClipSoft;

        uniform float uDfRadius;
        uniform float uDfEdge;

        varying vec3 vN;
        varying vec3 vWPos;

        float linearizeDepth01(float depthNdc01, float near, float far){
          float z = depthNdc01 * 2.0 - 1.0;
          float viewZ = (2.0 * near * far) / (far + near - z * (far - near));
          return clamp((viewZ - near) / (far - near), 0.0, 1.0);
        }

        vec2 rotate90(vec2 uv, float r){
          if (r < 0.5) return uv;
          if (r < 1.5) return vec2(uv.y, 1.0 - uv.x);
          if (r < 2.5) return vec2(1.0 - uv.x, 1.0 - uv.y);
          return vec2(1.0 - uv.y, uv.x);
        }
        // Depth texture is pre-decoded: depth01 is stored in uDepth.r (0..1)
        float bgDepthAtScreenUV(vec2 suv){
          vec2 uv = suv;
          uv = rotate90(uv, uRot);
          if (uFlip.x > 0.5) uv.x = 1.0 - uv.x;
          if (uFlip.y > 0.5) uv.y = 1.0 - uv.y;
          uv = uv * uScale + uOffset;
          uv = uv * uCover.xy + uCover.zw;

          uv = clamp(uv, vec2(0.0), vec2(1.0));

          float depth01 = texture2D(uDepth, uv).r;
          return depth01;
        }

        float bgDepthFiltered(vec2 suv){
          if (uDfRadius <= 0.001) return bgDepthAtScreenUV(suv);

          vec2 texel = 1.0 / uScreenPx;
          float centerD = bgDepthAtScreenUV(suv);

          float sigmaS = max(uDfRadius * 0.75, 0.001);
          float sigmaD = max(uDfEdge, 0.0005);

          float sumW = 0.0;
          float sumD = 0.0;

          for (int y=-3; y<=3; y++){
            for (int x=-3; x<=3; x++){
              vec2 o = vec2(float(x), float(y));
              float r = length(o);
              if (r > uDfRadius) continue;

              vec2 p = suv + o * texel;
              float d = bgDepthAtScreenUV(p);

              float ws = exp(-(r*r) / (2.0*sigmaS*sigmaS));
              float dd = d - centerD;
              float wd = exp(-(dd*dd) / (2.0*sigmaD*sigmaD));

              float w = ws * wd;
              sumW += w;
              sumD += w * d;
            }
          }
          return sumD / max(sumW, 1e-6);
        }

        void main(){
          vec2 suv = gl_FragCoord.xy / uScreenPx;

          float bgDepth01 = bgDepthFiltered(suv);
          float cubeDepth01 = linearizeDepth01(gl_FragCoord.z, uNear, uFar);

          float d = (bgDepth01 + uBias) - cubeDepth01; // >0: cube in front
          float a = 1.0;
          if (uClipSoft > 0.00001){
            // fade out over a small depth range as the cube goes behind the depth surface
            if (d < -uClipSoft) discard;
            a = smoothstep(-uClipSoft, 0.0, d);
          } else {
            if (d < 0.0) discard;
          }

          vec3 N = normalize(vN);
          vec3 L = normalize(vec3(0.35, 0.95, 0.15));
          float ndl = max(dot(N, L), 0.0);

          vec3 V = normalize(uCamPos - vWPos);
          float rim = pow(1.0 - max(dot(N, V), 0.0), 2.0);

          vec3 col = uColor * (0.25 + 0.85 * ndl) + vec3(1.0) * (0.20 * rim);
          gl_FragColor = vec4(col, a);
        }
      `
});

// ---------- Actor (GLB) ----------
// We load ./gregory.animation.glb and apply the same depth-clipping shader to its meshes.
const actor = new THREE.Group();
actor.position.set(5.632, -4.734, -25.999);
actor.rotation.set(0, THREE.MathUtils.degToRad(-43.32), 0);
actor.scale.set(1, 1, 1);
scene3d.add(actor);


// Used for shadow contact + drag depth calculations
const actorBBox = new THREE.Box3();

// meshes that can be raycast/picked (filled after GLB load)
let pickables = [];

// Selection helper for the last clicked character
const selectionBox = new THREE.Box3Helper(new THREE.Box3(), 0xffffff);
selectionBox.visible = false;
if (selectionBox.material) {
    selectionBox.material.depthTest = false;
    selectionBox.material.transparent = true;
    selectionBox.material.opacity = 0.95;
    selectionBox.material.toneMapped = false;
}
scene3d.add(selectionBox);

function updateSelectionOutline() {
    if (document.body.classList.contains("cleanfeed-hide") || !activeCharacter || !activeCharacter.group) {
        selectionBox.visible = false;
        return;
    }
    try {
        selectionBox.box.setFromObject(activeCharacter.group);
        const min = selectionBox.box.min, max = selectionBox.box.max;
        const valid = [min.x, min.y, min.z, max.x, max.y, max.z].every(Number.isFinite);
        const dx = Math.abs(max.x - min.x), dy = Math.abs(max.y - min.y), dz = Math.abs(max.z - min.z);
        if (!valid || (dx < 1e-6 && dy < 1e-6 && dz < 1e-6)) {
            selectionBox.visible = false;
            return;
        }
        selectionBox.visible = true;
    } catch {
        selectionBox.visible = false;
    }
}

// ---------- Character animation state ----------
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
let activeCharacter = null;
let characterSeq = 1;
let gregoryCharacter = null;
let gregoryReferenceHeight = 1;
const gregoryReferenceSize = new THREE.Vector3(1, 1, 1);
const DEFAULT_ACTOR_TRANSFORM = {
    position: [5.632, -4.734, -25.999],
    rotationYDeg: -43.32,
    scale: [1, 1, 1],
};
let characterRuntimeSeq = 1;

const TL_FPS = 5;
const TL_DT = 1 / TL_FPS;
const JKL_SHUTTLE_SPEEDS = [1, 2, 4, 8];
const PRECISE_STEP_DT = 1 / 24;

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

const HISTORY_LIMIT = 10;
const historyState = {
    undo: [],
    redo: [],
    restoring: false,
    moveGesture: null,
};
function _makeInitialCharacterTransform() {
    return {
        position: DEFAULT_ACTOR_TRANSFORM.position.slice(),
        quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, THREE.MathUtils.degToRad(DEFAULT_ACTOR_TRANSFORM.rotationYDeg), 0)).toArray(),
        scale: DEFAULT_ACTOR_TRANSFORM.scale.slice(),
    };
}

function _makeAnimState() {
    return {
        root: null,
        mixer: null,
        clips: [],
        actions: new Map(),
        action: null,
        selectedName: null,
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
}
function _copyAnimState(src) {
    return {
        root: src.root || null,
        mixer: src.mixer || null,
        clips: Array.isArray(src.clips) ? src.clips.slice() : [],
        actions: src.actions instanceof Map ? new Map(src.actions) : new Map(),
        action: src.action || null,
        selectedName: (src.selectedName ?? null),
        restClip: src.restClip || null,
        restAction: src.restAction || null,
        holdClip: src.holdClip || null,
        holdAction: src.holdAction || null,
        playingWhileDrag: !!src.playingWhileDrag,
        blendRemaining: +src.blendRemaining || 0,
        blendPauseAfter: !!src.blendPauseAfter,
        blendFrom: src.blendFrom || null,
        cycleSpeed: +src.cycleSpeed || 1,
    };
}
function _saveActiveCharacterAnimState() {
    if (!activeCharacter) return;
    activeCharacter.animState = _copyAnimState(anim);
    activeCharacter.pickables = Array.isArray(pickables) ? pickables.slice() : [];
}
function _loadAnimStateIntoGlobals(state) {
    const s = state || _makeAnimState();
    anim.root = s.root || null;
    anim.mixer = s.mixer || null;
    anim.clips = Array.isArray(s.clips) ? s.clips.slice() : [];
    anim.actions = s.actions instanceof Map ? new Map(s.actions) : new Map();
    anim.action = s.action || null;
    anim.selectedName = (s.selectedName ?? null);
    anim.restClip = s.restClip || null;
    anim.restAction = s.restAction || null;
    anim.holdClip = s.holdClip || null;
    anim.holdAction = s.holdAction || null;
    anim.playingWhileDrag = !!s.playingWhileDrag;
    anim.blendRemaining = +s.blendRemaining || 0;
    anim.blendPauseAfter = !!s.blendPauseAfter;
    anim.blendFrom = s.blendFrom || null;
    anim.cycleSpeed = +s.cycleSpeed || 1;
}
function getActiveActor() { return (activeCharacter && activeCharacter.group) ? activeCharacter.group : actor; }
function getActiveKeys() { return (activeCharacter && Array.isArray(activeCharacter.keys)) ? activeCharacter.keys : timeline.keys; }
function setActiveKeys(keys) { if (activeCharacter) activeCharacter.keys = keys; else timeline.keys = keys; }
function getActiveDuration() { return activeCharacter ? (+activeCharacter.duration || 0) : (+timeline.duration || 0); }
function setActiveDuration(v) { if (activeCharacter) activeCharacter.duration = Math.max(0, +v || 0); timeline.duration = getProjectDuration(); }
function getProjectDuration() {
    let d = 0;
    for (const ch of characters) { d = Math.max(d, +ch.duration || 0); }
    const bgKeys = Array.isArray(timeline?.backgroundKeys) ? timeline.backgroundKeys : [];
    if (bgKeys.length) d = Math.max(d, _num(bgKeys[bgKeys.length - 1]?.t, 0));
    return d;
}
function getSceneBoundaries() {
    const duration = Math.max(0, getProjectDuration(), +timeline.duration || 0);
    const bgKeys = _dedupeAndSortBackgroundKeys(Array.isArray(timeline?.backgroundKeys) ? timeline.backgroundKeys : []);
    const starts = [0];
    const eps = 1e-5;
    let prevSignature = null;
    for (const k of bgKeys) {
        const t = _clamp(_num(k?.t, 0), 0, duration);
        const signature = _backgroundEntrySignature(k?.entry || k?.backgroundSelection || k);
        if (!signature) continue;
        if (prevSignature === null) {
            prevSignature = signature;
            if (t > eps && !starts.some(v => Math.abs(v - t) <= eps)) starts.push(t);
            continue;
        }
        if (signature === prevSignature) continue;
        prevSignature = signature;
        if (!starts.some(v => Math.abs(v - t) <= eps)) starts.push(t);
    }
    starts.sort((a, b) => a - b);
    if (!starts.length) starts.push(0);
    if (duration > starts[starts.length - 1] + eps) starts.push(duration);
    else if (starts.length === 1) starts.push(duration);
    const segments = [];
    for (let i = 0; i < Math.max(1, starts.length - 1); i++) {
        const start = starts[i] ?? 0;
        const end = starts[i + 1] ?? duration;
        segments.push({ index: i, start, end, duration: Math.max(0, end - start) });
    }
    if (!segments.length) segments.push({ index: 0, start: 0, end: duration, duration: duration });
    return segments;
}
function getSceneIndexForTime(t) {
    const segments = getSceneBoundaries();
    const tt = Math.max(0, +t || 0);
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const isLast = i === segments.length - 1;
        if (tt >= seg.start - 1e-6 && (tt < seg.end - 1e-6 || isLast)) return i;
    }
    return Math.max(0, segments.length - 1);
}
function getCurrentSceneSegment() {
    const segments = getSceneBoundaries();
    return segments[getSceneIndexForTime(timeline.playhead)] || segments[0] || { index: 0, start: 0, end: Math.max(0, +timeline.duration || 0), duration: Math.max(0, +timeline.duration || 0) };
}
function seekToScene(index, { snapToStart = true } = {}) {
    const segments = getSceneBoundaries();
    if (!segments.length) return;
    const idx = _clamp(index | 0, 0, segments.length - 1);
    const seg = segments[idx];
    const nextPlayhead = snapToStart ? seg.start : _clamp(timeline.playhead, seg.start, Math.max(seg.start, seg.end));
    timeline.playhead = nextPlayhead;
    _trimTakeManagerToSceneCount();
    _applySelectedTakeForScene(idx, { refresh: false });
    applyTimelineAt(timeline.playhead);
    renderTakeManager();
    syncTransportUI();
}
function stepScene(delta) {
    const idx = getSceneIndexForTime(timeline.playhead);
    seekToScene(idx + (delta < 0 ? -1 : 1));
}
function registerCharacter(ch) {
    characters.push(ch);
    ch.pickables = ch.pickables || [];
    ch.animState = ch.animState || _makeAnimState();
    ch.keys = Array.isArray(ch.keys) ? ch.keys : [];
    ch.duration = +ch.duration || 0;
    ch.projectId = ch.projectId || ch.id;
    ch.runtimeUid = ch.runtimeUid || `runtime_${characterRuntimeSeq++}`;
    return ch;
}
function setActiveCharacter(ch, { refreshMenu = true } = {}) {
    if (!ch) {
        if (activeCharacter) _saveActiveCharacterAnimState();
        activeCharacter = null;
        pickables = [];
        try { updateSelectionOutline(); } catch { }
        if (refreshMenu && animMenuEl && animMenuEl.style.display !== 'none') {
            try { buildAnimMenuItems(); } catch { }
        }
        return;
    }
    if (activeCharacter === ch) {
        try { updateSelectionOutline(); } catch { }
        return;
    }
    _saveActiveCharacterAnimState();
    activeCharacter = ch;
    pickables = Array.isArray(ch.pickables) ? ch.pickables.slice() : [];
    _loadAnimStateIntoGlobals(ch.animState);
    try { updateActorBBox(); } catch { }
    try { updateSelectionOutline(); } catch { }
    if (refreshMenu && animMenuEl && animMenuEl.style.display !== 'none') {
        try { buildAnimMenuItems(); } catch { }
    }
}
function findCharacterById(id) { return characters.find(ch => String(ch.id) === String(id)) || null; }
function findCharacterByRuntimeUid(uid) { return characters.find(ch => String(ch.runtimeUid) === String(uid)) || null; }
function findCharacterByObject(obj) {
    let cur = obj;
    while (cur) {
        const runtimeUid = cur.userData && cur.userData.characterRuntimeUid;
        if (runtimeUid) { const ch = findCharacterByRuntimeUid(runtimeUid); if (ch) return ch; }
        const id = cur.userData && cur.userData.characterId;
        if (id) { const ch = findCharacterById(id); if (ch) return ch; }
        cur = cur.parent || null;
    }
    return null;
}
function _getCharacterDisplayName(ch, idx) {
    const base = (ch && ch.name) ? String(ch.name) : `Character ${idx + 1}`;
    const short = ch && ch.runtimeUid ? String(ch.runtimeUid).replace(/^runtime_/, '#') : `#${idx + 1}`;
    return `${base} ${short}`;
}
function _updateCharacterDuration(ch) {
    ch.duration = (Array.isArray(ch.keys) && ch.keys.length) ? (+ch.keys[ch.keys.length - 1].t || 0) : 0;
    timeline.duration = getProjectDuration();
    transport.timeSlider.max = String(Math.max(timeline.duration, 0));
}
function _clearCustomCharacters() {
    for (let i = characters.length - 1; i >= 0; i--) {
        const ch = characters[i];
        if (ch === gregoryCharacter) continue;
        try { scene3d.remove(ch.group); } catch { }
        characters.splice(i, 1);
    }
    if (gregoryCharacter) setActiveCharacter(gregoryCharacter, { refreshMenu: false });
    timeline.duration = getProjectDuration();
    transport.timeSlider.max = String(Math.max(timeline.duration, 0));
}
gregoryCharacter = registerCharacter({
    id: "gregory",
    name: "Gregory",
    group: actor,
    source: { kind: "builtin", path: "./gregory.animation.glb" },
    animState: _makeAnimState(),
    pickables: [],
    keys: [],
    duration: 0,
});
activeCharacter = gregoryCharacter;

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
function _getDefaultCharacterTransform() {
    return _makeInitialCharacterTransform();
}
function _snapshotCharacterTransforms() {
    return characters.map(ch => ({
        ch,
        position: [ch.group.position.x, ch.group.position.y, ch.group.position.z],
        quaternion: [ch.group.quaternion.x, ch.group.quaternion.y, ch.group.quaternion.z, ch.group.quaternion.w],
        scale: [ch.group.scale.x, ch.group.scale.y, ch.group.scale.z],
    }));
}
function _restoreCharacterTransforms(snaps) {
    for (const s of (snaps || [])) {
        if (!s || !s.ch || !s.ch.group) continue;
        try {
            s.ch.group.position.fromArray(s.position || [0, 0, 0]);
            s.ch.group.quaternion.fromArray(s.quaternion || [0, 0, 0, 1]);
            s.ch.group.scale.fromArray(s.scale || [1, 1, 1]);
            s.ch.group.updateMatrixWorld(true);
        } catch { }
    }
}
function _makeTransformSnapshotFromObject(obj) {
    return {
        position: [obj.position.x, obj.position.y, obj.position.z],
        quaternion: [obj.quaternion.x, obj.quaternion.y, obj.quaternion.z, obj.quaternion.w],
        scale: [obj.scale.x, obj.scale.y, obj.scale.z],
    };
}
function _applyTransformSnapshotToObject(obj, snap) {
    if (!obj || !snap) return;
    obj.position.fromArray(snap.position || [0, 0, 0]);
    obj.quaternion.fromArray(snap.quaternion || [0, 0, 0, 1]);
    obj.scale.fromArray(snap.scale || [1, 1, 1]);
    obj.updateMatrixWorld(true);
}
function _transformSnapshotDelta(fromSnap, toSnap) {
    const m0 = new THREE.Matrix4().compose(
        new THREE.Vector3().fromArray(fromSnap?.position || [0, 0, 0]),
        new THREE.Quaternion().fromArray(fromSnap?.quaternion || [0, 0, 0, 1]),
        new THREE.Vector3().fromArray(fromSnap?.scale || [1, 1, 1]),
    );
    const m1 = new THREE.Matrix4().compose(
        new THREE.Vector3().fromArray(toSnap?.position || [0, 0, 0]),
        new THREE.Quaternion().fromArray(toSnap?.quaternion || [0, 0, 0, 1]),
        new THREE.Vector3().fromArray(toSnap?.scale || [1, 1, 1]),
    );
    return m1.multiply(m0.invert());
}
function _bakeIdleTransformIntoCharacter(ch, fromSnap, toSnap) {
    if (!ch || !ch.group || !fromSnap || !toSnap) return;
    const changed =
        Math.hypot(
            (toSnap.position?.[0] ?? 0) - (fromSnap.position?.[0] ?? 0),
            (toSnap.position?.[1] ?? 0) - (fromSnap.position?.[1] ?? 0),
            (toSnap.position?.[2] ?? 0) - (fromSnap.position?.[2] ?? 0)
        ) > 1e-6 ||
        Math.abs((toSnap.scale?.[0] ?? 1) - (fromSnap.scale?.[0] ?? 1)) > 1e-6 ||
        Math.abs((toSnap.scale?.[1] ?? 1) - (fromSnap.scale?.[1] ?? 1)) > 1e-6 ||
        Math.abs((toSnap.scale?.[2] ?? 1) - (fromSnap.scale?.[2] ?? 1)) > 1e-6 ||
        (1 - Math.abs(
            ((toSnap.quaternion?.[0] ?? 0) * (fromSnap.quaternion?.[0] ?? 0)) +
            ((toSnap.quaternion?.[1] ?? 0) * (fromSnap.quaternion?.[1] ?? 0)) +
            ((toSnap.quaternion?.[2] ?? 0) * (fromSnap.quaternion?.[2] ?? 0)) +
            ((toSnap.quaternion?.[3] ?? 1) * (fromSnap.quaternion?.[3] ?? 1))
        )) > 1e-6;
    if (!changed) return;

    const delta = _transformSnapshotDelta(fromSnap, toSnap);
    if (Array.isArray(ch.keys) && ch.keys.length) {
        ch.keys = ch.keys.map(k => {
            const m = new THREE.Matrix4().compose(
                new THREE.Vector3().fromArray(k.p || [0, 0, 0]),
                new THREE.Quaternion().fromArray(k.q || [0, 0, 0, 1]),
                new THREE.Vector3().fromArray(k.s || [1, 1, 1]),
            );
            const out = delta.clone().multiply(m);
            const p = new THREE.Vector3();
            const q = new THREE.Quaternion();
            const s = new THREE.Vector3();
            out.decompose(p, q, s);
            return {
                ...k,
                p: [p.x, p.y, p.z],
                q: [q.x, q.y, q.z, q.w],
                s: [s.x, s.y, s.z],
            };
        });
    }
    _applyTransformSnapshotToObject(ch.group, toSnap);
    if (activeCharacter === ch) {
        try { applyCharacterSelectionToGlobals(ch); } catch { }
    }
    _updateCharacterDuration(ch);
}
const _low = (s) => (s ?? "").toString().trim().toLowerCase();
function _num(v, fallback = 0) {
    const n = typeof v === "number" ? v : parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
}
function _clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
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
        meta: {
            focal_mm: 86,
            horizon_y: -0.3,
            pitch_deg: 0,
            cam_height: 1.2,
        },
    });
}
function _getBackgroundDisplayLabel(entry) {
    const v = _cloneBackgroundEntry(entry);
    if (!v) return 'Kein Background';
    if (String(v.id || '') === '__default_background__') return 'Default';
    const raw = String(v.id || v.name_key || v.background || 'Background');
    const tail = raw.split('/').pop() || raw;
    return tail.replace(/\.[^.]+$/, '') || 'Background';
}
function _backgroundEntrySignature(entry) {
    const v = _cloneBackgroundEntry(entry);
    return v ? JSON.stringify(v) : "";
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
function _transformsDiffer(a, b) {
    if (!a || !b) return !!(a || b);
    const posDiff = Math.hypot(
        (a.position?.[0] ?? 0) - (b.position?.[0] ?? 0),
        (a.position?.[1] ?? 0) - (b.position?.[1] ?? 0),
        (a.position?.[2] ?? 0) - (b.position?.[2] ?? 0)
    ) > 1e-6;
    const scaleDiff =
        Math.abs((a.scale?.[0] ?? 1) - (b.scale?.[0] ?? 1)) > 1e-6 ||
        Math.abs((a.scale?.[1] ?? 1) - (b.scale?.[1] ?? 1)) > 1e-6 ||
        Math.abs((a.scale?.[2] ?? 1) - (b.scale?.[2] ?? 1)) > 1e-6;
    const quatDot = Math.abs(
        ((a.quaternion?.[0] ?? 0) * (b.quaternion?.[0] ?? 0)) +
        ((a.quaternion?.[1] ?? 0) * (b.quaternion?.[1] ?? 0)) +
        ((a.quaternion?.[2] ?? 0) * (b.quaternion?.[2] ?? 0)) +
        ((a.quaternion?.[3] ?? 1) * (b.quaternion?.[3] ?? 1))
    );
    const rotDiff = (1 - quatDot) > 1e-6;
    return posDiff || scaleDiff || rotDiff;
}
function _beginManualMoveGesture(label = 'manual-transform') {
    if (historyState.restoring || timeline.recording || historyState.moveGesture || !activeCharacter || !activeCharacter.group) return false;
    historyState.moveGesture = {
        label,
        runtimeUid: activeCharacter.runtimeUid || null,
        startTransform: _makeTransformSnapshotFromObject(activeCharacter.group),
    };
    _pushUndoSnapshot(label);
    return true;
}
function _finishManualMoveGesture() {
    const gesture = historyState.moveGesture;
    historyState.moveGesture = null;
    if (!gesture) return false;
    const ch = findCharacterByRuntimeUid(gesture.runtimeUid) || activeCharacter;
    if (!ch || !ch.group) return false;
    const changed = _transformsDiffer(gesture.startTransform, _makeTransformSnapshotFromObject(ch.group));
    if (!changed && historyState.undo.length) {
        const last = historyState.undo[historyState.undo.length - 1];
        if (last && last.label === gesture.label) historyState.undo.pop();
    }
    return changed;
}
function _resolveAnimName(name, state = anim) {
    const wanted = _low(name);
    if (!wanted || !state || !(state.actions instanceof Map) || state.actions.size === 0) return null;
    if (state.actions.has(wanted)) return wanted;
    const aliasGroups = [
        ['walk', 'walking', 'walkcycle', 'walk cycle'],
        ['run', 'running', 'jog', 'jogging', 'sprint', 'sprinting']
    ];
    for (const group of aliasGroups) {
        if (!group.some(v => wanted.includes(v) || v.includes(wanted))) continue;
        for (const [k] of state.actions) {
            const lk = _low(k);
            if (group.some(v => lk.includes(v))) return k;
        }
    }
    for (const [k] of state.actions) {
        const lk = _low(k);
        if (lk === wanted) return k;
    }
    for (const [k] of state.actions) {
        const lk = _low(k);
        if (lk.includes(wanted) || wanted.includes(lk)) return k;
    }
    return null;
}

function getAnimCycleSpeed() {
    const raw = (anim && typeof anim.cycleSpeed !== "undefined") ? anim.cycleSpeed : 1;
    return THREE.MathUtils.clamp(_num(raw, 1), 0.05, 3.0);
}
function applyAnimCycleSpeedToCurrent() {
    const sp = getAnimCycleSpeed();
    try {
        if (anim.action && anim.selectedName !== null) anim.action.setEffectiveTimeScale?.(sp);
        if (anim.blendFrom && anim.blendFrom !== anim.restAction && anim.blendFrom !== anim.holdAction) anim.blendFrom.setEffectiveTimeScale?.(sp);
    } catch { }
}
function setAnimCycleSpeed(v, { capture = false, refreshMenu = false } = {}) {
    anim.cycleSpeed = THREE.MathUtils.clamp(_num(v, 1), 0.05, 3.0);
    applyAnimCycleSpeedToCurrent();
    if (capture && timeline && timeline.recording) {
        try { upsertKeyAt(timeline.playhead); } catch { }
    }
    if (refreshMenu && animMenuEl && animMenuEl.style.display !== "none") {
        try { buildAnimMenuItems(); } catch { }
    }
}

function makeRestPoseAction(root, mixer) {
    // Build a synthetic clip that holds the bind/rest pose (so we can cross-fade to/from "none").
    // This avoids hard cuts when switching between "0. none" and any real clip.
    const times = [0, 1];
    const tracks = [];

    const bones = [];
    root.traverse((o) => { if (o && o.isBone) bones.push(o); });

    for (const b of bones) {
        const n = b.name || "";
        if (!n) continue;

        // position
        tracks.push(new THREE.VectorKeyframeTrack(
            `${n}.position`,
            times,
            [b.position.x, b.position.y, b.position.z, b.position.x, b.position.y, b.position.z]
        ));
        // quaternion
        tracks.push(new THREE.QuaternionKeyframeTrack(
            `${n}.quaternion`,
            times,
            [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w, b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w]
        ));
        // scale
        tracks.push(new THREE.VectorKeyframeTrack(
            `${n}.scale`,
            times,
            [b.scale.x, b.scale.y, b.scale.z, b.scale.x, b.scale.y, b.scale.z]
        ));
    }

    if (!tracks.length) return null;

    const clip = new THREE.AnimationClip("__REST_POSE__", 1, tracks);
    const act = mixer.clipAction(clip);
    act.enabled = true;
    act.setLoop(THREE.LoopOnce, 1);
    act.clampWhenFinished = true;
    act.play();
    act.paused = true;
    act.setEffectiveWeight(1);
    act.time = 0;
    mixer.update(0); // apply pose once
    return { clip, action: act };
}

function _disposeHold() {
    if (!anim.mixer) return;
    if (anim.holdAction) {
        try { anim.holdAction.stop(); } catch { }
        try { anim.holdAction.enabled = false; } catch { }
        try { anim.holdAction.setEffectiveWeight?.(0); } catch { }
        try { anim.mixer.uncacheAction?.(anim.holdClip, anim.root); } catch { }
    }
    if (anim.holdClip) {
        try { anim.mixer.uncacheClip?.(anim.holdClip); } catch { }
    }
    anim.holdAction = null;
    anim.holdClip = null;
}

function makeHoldPoseAction(root, mixer) {
    // Snapshot the CURRENT evaluated pose into a constant clip.
    // Used to fade to/from "none" without popping even if other transitions overlap.
    const times = [0, 1];
    const tracks = [];
    const bones = [];
    root.traverse((o) => { if (o && o.isBone) bones.push(o); });

    for (const b of bones) {
        const n = b.name || "";
        if (!n) continue;

        tracks.push(new THREE.VectorKeyframeTrack(
            `${n}.position`,
            times,
            [b.position.x, b.position.y, b.position.z, b.position.x, b.position.y, b.position.z]
        ));
        tracks.push(new THREE.QuaternionKeyframeTrack(
            `${n}.quaternion`,
            times,
            [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w,
            b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w]
        ));
        tracks.push(new THREE.VectorKeyframeTrack(
            `${n}.scale`,
            times,
            [b.scale.x, b.scale.y, b.scale.z, b.scale.x, b.scale.y, b.scale.z]
        ));
    }

    if (!tracks.length) return null;

    const clip = new THREE.AnimationClip("__HOLD_POSE__", 1, tracks);
    const act = mixer.clipAction(clip);
    act.enabled = true;
    act.setLoop(THREE.LoopOnce, 1);
    act.clampWhenFinished = true;
    act.play();
    act.paused = true;
    act.setEffectiveWeight(1);
    act.time = 0;
    mixer.update(0); // apply pose once
    return { clip, action: act };
}

let dragging = false; // hoisted for animation helpers

function setAnimRest() {
    _finalizeBlend();
    anim.selectedName = null;

    // If not loaded yet, fallback to the old "stop" behavior.
    if (!anim.mixer || !anim.restAction) {
        if (anim.action) {
            try { anim.action.stop(); } catch { }
            anim.action.paused = true;
        }
        anim.action = null;
        return;
    }

    const next = anim.restAction;
    const prev = (anim.action && anim.action !== next) ? anim.action : null;

    // Prepare NEXT at its first frame (bind pose)
    next.enabled = true;
    next.reset();
    next.time = 0;
    next.setEffectiveTimeScale(1);
    next.setEffectiveWeight(1);
    next.paused = false;
    next.play();

    _stopAllExcept(prev, next);

    // Transition duration (seconds)
    const xfade = Math.max(0, (+ui.animXfade?.value || 0));
    const eps = 1e-4;

    if (prev) {
        // Ensure mixer is evaluated at the currently visible pose
        try {
            prev.enabled = true;
            prev.paused = false;
            prev.play();
            anim.mixer.update(0);
        } catch { }

        if (xfade > 0) {
            // Snapshot the current evaluated pose into a HOLD action and fade that into REST.
            // This avoids pops when "none" is triggered quickly or while other blends are still settling.
            _disposeHold();
            let hold = null;
            try {
                const h = makeHoldPoseAction(anim.root, anim.mixer);
                if (h) { anim.holdClip = h.clip; anim.holdAction = h.action; hold = h.action; }
            } catch (e) { console.warn("Failed to build hold pose", e); }

            if (hold) {
                // REST should start at weight 0 so crossFade controls the blend from the first frame.
                try { next.setEffectiveWeight?.(0); } catch { }
                try { next.enabled = true; next.paused = false; next.play(); } catch { }

                // Stop all other actions so nothing else influences the pose.
                _stopAllExcept(hold, next);

                // Prevent the previous clip from contributing during the fade (we fade from HOLD instead)
                try { prev.stop(); } catch { }
                try { prev.enabled = false; } catch { }
                try { prev.setEffectiveWeight?.(0); } catch { }

                try { next.crossFadeFrom(hold, xfade, false); } catch { }
                anim.blendRemaining = xfade;
                anim.blendPauseAfter = !dragging;
                anim.blendFrom = hold;
            } else {
                // Fallback if HOLD couldn't be created
                try { next.setEffectiveWeight?.(0); } catch { }
                try { next.crossFadeFrom(prev, xfade, false); } catch { }
                anim.blendRemaining = xfade;
                anim.blendPauseAfter = !dragging;
                anim.blendFrom = prev;
            }
        } else {
            // Hard cut
            try { prev.stop(); } catch { }
            anim.blendRemaining = 0;
            anim.blendPauseAfter = !dragging;
            anim.blendFrom = null;
            anim.blendPauseAfter = false;
        }
    } else {
        anim.blendRemaining = 0;
        anim.blendPauseAfter = !dragging;
        anim.blendFrom = null;
    }

    anim.action = next;

    // Prime mixer immediately
    anim.mixer.update(0);

    // If we are not dragging/holding and there is no fade to run, pause now.
    if (!dragging && anim.action) {
        if (anim.blendRemaining <= 0) {
            anim.action.paused = true;
        }
    }
}

function setAnimNone() { setAnimRest(); }


// Stop any lingering actions (can otherwise leave small weights that cause "non-neutral" rests)
function _stopAllExcept(prev, next) {
    if (!anim.mixer) return;
    const keep = new Set([prev, next].filter(Boolean));
    // include restAction and all real actions
    const list = [];
    if (anim.restAction) list.push(anim.restAction);
    if (anim.holdAction) list.push(anim.holdAction);
    if (anim.actions && anim.actions.size) {
        for (const a of anim.actions.values()) list.push(a);
    }
    for (const a of list) {
        if (!a || keep.has(a)) continue;
        try { a.stop(); } catch { }
        try { a.enabled = false; } catch { }
        try { a.setEffectiveWeight?.(0); } catch { }
    }
}


// If a new animation switch happens while a previous cross-fade is still running,
// finalize the current blend first so we always fade FROM the current pose (no pops).
function _finalizeBlend() {
    if (!anim.mixer) return;
    const cur = anim.action || null;

    // Promote current action to full weight at its current pose
    if (cur) {
        try { cur.enabled = true; } catch { }
        try { cur.paused = false; } catch { }
        try { cur.play(); } catch { }
        try { cur.setEffectiveTimeScale?.(1); } catch { }
        try { cur.setEffectiveWeight?.(1); } catch { }
    }

    // Stop the previous "from" action (and any lingering weights) to avoid mixed poses
    const list = [];
    if (anim.restAction) list.push(anim.restAction);
    if (anim.holdAction) list.push(anim.holdAction);
    if (anim.actions && anim.actions.size) {
        for (const a of anim.actions.values()) list.push(a);
    }
    for (const a of list) {
        if (!a) continue;
        if (a === cur) continue;
        try { a.stop(); } catch { }
        try { a.enabled = false; } catch { }
        try { a.setEffectiveWeight?.(0); } catch { }
    }

    anim.blendRemaining = 0;
    anim.blendFrom = null;
    _disposeHold();

    // Prime mixer with the finalized pose
    try { anim.mixer.update(0); } catch { }
}


function setAnimByName(name) {
    _finalizeBlend();
    if (!name) { setAnimRest(); return; }
    anim.selectedName = name;

    // If not loaded yet, just remember the name.
    if (!anim.mixer || anim.actions.size === 0) {
        anim.action = null;
        return;
    }

    const resolvedKey = _resolveAnimName(name, anim);
    const key = resolvedKey || _low(name);
    let next = resolvedKey ? anim.actions.get(resolvedKey) : anim.actions.get(key);
    if (!next) {
        setAnimNone();
        return;
    }
    anim.selectedName = resolvedKey || name;

    const prev = anim.action;

    // Same action -> nothing to do
    if (prev === next) {
        anim.action = next;
        applyAnimCycleSpeedToCurrent();
        return;
    }

    // Transition duration (seconds)
    const xfade = Math.max(0, (+ui.animXfade?.value || 0));
    const eps = 1e-4;

    // Prepare NEXT action at its first frame
    next.enabled = true;
    next.reset();
    next.time = 0;
    next.setEffectiveTimeScale(getAnimCycleSpeed());
    next.setEffectiveWeight(1);
    next.paused = false;
    next.play();

    _stopAllExcept(prev, next);

    if (prev) {
        // Ensure PREV is active at its current pose before fading out (no "jump to last frame")
        try {
            prev.enabled = true;
            prev.paused = false;
            prev.play();
            anim.mixer.update(0);
        } catch { }

        if (xfade > 0) {
            // Cross-fade from prev(last frame) -> next(first frame)
            try { next.crossFadeFrom(prev, xfade, false); } catch { }
            anim.blendRemaining = xfade;
            anim.blendPauseAfter = !dragging; // if not holding, pause after blend
            anim.blendFrom = prev;
        } else {
            // Hard cut
            try { prev.stop(); } catch { }
            anim.blendRemaining = 0;
            anim.blendPauseAfter = !dragging;
            anim.blendFrom = null;
        }
    } else {
        // No previous action -> just start next (optionally pause if not dragging)
        anim.blendRemaining = 0;
        anim.blendPauseAfter = !dragging;
        anim.blendFrom = null;
    }

    anim.action = next;
    applyAnimCycleSpeedToCurrent();

    // Prime mixer immediately
    anim.mixer.update(0);

    // If we are not dragging/holding and there is no fade to run, pause now.
    if (!dragging && anim.action) {
        if (anim.blendRemaining <= 0) {
            anim.action.paused = true;
        }
    }
}

function getAnimPhase01() {
    if (!anim.action) return 0;
    const clip = anim.action.getClip?.();
    const dur = Math.max(1e-6, clip?.duration ?? 0);
    const t = ((anim.action.time ?? 0) % dur + dur) % dur;
    return t / dur;
}

// ---------- Context menu for animation selection ----------
let animMenuEl = null;

function ensureAnimMenu() {
    if (animMenuEl) return animMenuEl;
    const el = document.createElement("div");
    el.id = "animMenu";
    el.style.position = "fixed";
    el.style.zIndex = "9999";
    el.style.minWidth = "180px";
    el.style.background = "rgba(20,20,24,0.92)";
    el.style.border = "1px solid rgba(255,255,255,0.12)";
    el.style.borderRadius = "10px";
    el.style.padding = "6px";
    el.style.backdropFilter = "blur(8px)";
    el.style.font = "12px/1.3 system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    el.style.color = "#fff";
    el.style.display = "none";
    el.style.boxShadow = "0 10px 30px rgba(0,0,0,0.35)";
    document.body.appendChild(el);
    animMenuEl = el;

    // Allow scrolling inside the menu even when the canvas has global listeners
    el.addEventListener("wheel", (ev) => { ev.stopPropagation(); }, { passive: true });

    // click outside closes
    addEventListener("pointerdown", (e) => {
        if (!animMenuEl || animMenuEl.style.display === "none") return;
        if (e.target === animMenuEl || animMenuEl.contains(e.target)) return;
        hideAnimMenu();
    }, { capture: true });

    addEventListener("blur", hideAnimMenu);
    addEventListener("scroll", hideAnimMenu, { passive: true });

    return el;
}

function hideAnimMenu() {
    if (!animMenuEl) return;
    animMenuEl.style.display = "none";
}

function _menuItem(label, onClick, isActive = false, closeOnClick = true) {
    const b = document.createElement("div");
    b.textContent = tr(label);
    b.style.padding = "8px 10px";
    b.style.borderRadius = "8px";
    b.style.cursor = "pointer";
    b.style.userSelect = "none";
    b.style.margin = "2px 0";
    b.style.background = isActive ? "rgba(255,255,255,0.14)" : "transparent";
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); });
    b.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        onClick();
        if (closeOnClick) hideAnimMenu();
    });
    b.addEventListener("mouseenter", () => { b.style.background = "rgba(255,255,255,0.10)"; });
    b.addEventListener("mouseleave", () => { b.style.background = isActive ? "rgba(255,255,255,0.14)" : "transparent"; });
    return b;
}

function _stripAudioExt(name) {
    const s = String(name || "");
    return s.replace(/\.(mp3|mpeg|wav|ogg|m4a|aac|flac)$/i, "");
}

function _genId() {
    return "c_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);
}


function _menuRow(label, { onMainClick, onPreviewClick = null, closeOnMainClick = true } = {}) {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "8px";
    row.style.padding = "6px 6px";
    row.style.borderRadius = "8px";
    row.style.margin = "2px 0";
    row.style.userSelect = "none";
    row.style.cursor = "default";

    const main = document.createElement("div");
    main.textContent = label;
    main.style.flex = "1 1 auto";
    main.style.padding = "2px 4px";
    main.style.borderRadius = "6px";
    main.style.cursor = "pointer";
    main.style.whiteSpace = "nowrap";
    main.style.overflow = "hidden";
    main.style.textOverflow = "ellipsis";

    main.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); });
    main.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        try { onMainClick && onMainClick(); } catch (err) { console.error(err); }
        if (closeOnMainClick) hideAnimMenu();
    });

    row.addEventListener("mouseenter", () => { row.style.background = "rgba(255,255,255,0.08)"; });
    row.addEventListener("mouseleave", () => { row.style.background = "transparent"; });

    row.appendChild(main);

    if (typeof onPreviewClick === "function") {
        const btn = document.createElement("button");
        btn.textContent = "▶";
        btn.title = "Preview (max 3s)";
        btn.style.flex = "0 0 auto";
        btn.style.width = "34px";
        btn.style.height = "26px";
        btn.style.borderRadius = "8px";
        btn.style.border = "1px solid rgba(255,255,255,.18)";
        btn.style.background = "rgba(0,0,0,.35)";
        btn.style.color = "#fff";
        btn.style.cursor = "pointer";
        btn.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); });
        btn.addEventListener("click", (e) => {
            e.preventDefault(); e.stopPropagation();
            try { onPreviewClick(); } catch (err) { console.error(err); }
        });
        row.appendChild(btn);
    }

    return row;
}



// ---------- Context menu content (Movement / Dialog / Foley) ----------
// Optional template banks (external references). If JSON files exist next to the HTML, they are loaded:
//   ./dialog_templates.json and ./foley_templates.json
// Format: [{ "id": "greeting", "name": "Greeting", "url": "assets/dialog/greeting.mp3" }, ...]
const templateBanks = { dialog: [], foley: [] };

async function _loadTemplateBank(kind) {
    const fname = (kind === "foley") ? "foley_templates.json" : "dialog_templates.json";
    try {
        const r = await fetch("./" + fname, { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        if (Array.isArray(j)) {
            templateBanks[kind] = j
                .map((x, i) => ({
                    id: String(x?.id ?? i),
                    name: String(x?.name ?? x?.title ?? x?.id ?? ("Template " + i)),
                    url: String(x?.url ?? x?.src ?? ""),
                }))
                .filter(x => x.url);
        }
    } catch (_e) {
        // It's OK if the file doesn't exist yet.
        templateBanks[kind] = [];
    }
}
// Template banks are optional; avoid 404 spam when the json files are not present.
const ENABLE_TEMPLATE_AUTOFETCH = true;
if (ENABLE_TEMPLATE_AUTOFETCH) {
    _loadTemplateBank("dialog");
    _loadTemplateBank("foley");
}
let animMenuPage = "root"; // 'root' | 'movement' | 'flatplate' | 'dialog' | 'foley'

function _menuSep(el) {
    const sep = document.createElement("div");
    sep.style.height = "1px";
    sep.style.margin = "6px 4px";
    sep.style.background = "rgba(255,255,255,0.10)";
    el.appendChild(sep);
}
function _menuHdr(el, text) {
    const hdr = document.createElement("div");
    hdr.textContent = tr(text);
    hdr.style.opacity = "0.85";
    hdr.style.fontWeight = "600";
    hdr.style.padding = "2px 8px 6px";
    el.appendChild(hdr);
}

const menuSearch = { movement: "", dialog: "", foley: "" };
const menuSearchFocus = { key: null, pos: 0 };

function _menuSearchBox(el, key, placeholder) {
    const wrap = document.createElement("div");
    wrap.style.padding = "0 8px 8px";
    wrap.addEventListener("mousedown", (e) => e.stopPropagation());
    wrap.addEventListener("click", (e) => e.stopPropagation());
    const inp = document.createElement("input");
    inp.type = "text";
    inp.value = String(menuSearch[key] || "");
    inp.placeholder = tr(placeholder || "Search…");
    inp.style.width = "100%";
    inp.style.boxSizing = "border-box";
    inp.style.borderRadius = "8px";
    inp.style.border = "1px solid rgba(255,255,255,.18)";
    inp.style.background = "rgba(0,0,0,.35)";
    inp.style.color = "#fff";
    inp.style.padding = "6px 8px";
    inp.style.outline = "none";
    // Prevent the context menu from stealing focus/closing while typing
    for (const ev of ["mousedown", "click", "dblclick", "keydown", "keyup", "keypress", "wheel", "pointerdown"]) {
        inp.addEventListener(ev, (e) => { e.stopPropagation(); }, { passive: false });
    }

    // Keep caret position across menu rebuilds (the menu is rebuilt on each keystroke)
    inp.addEventListener("input", () => {
        menuSearch[key] = inp.value;
        menuSearchFocus.key = key;
        try { menuSearchFocus.pos = inp.selectionStart ?? inp.value.length; } catch (_) { menuSearchFocus.pos = inp.value.length; }
        buildAnimMenuItems();
    });

    // Restore focus/caret after rebuild if this was the active search box
    if (menuSearchFocus.key === key) {
        const pos = Math.max(0, Math.min(Number(menuSearchFocus.pos || 0), inp.value.length));
        requestAnimationFrame(() => {
            try { inp.focus({ preventScroll: true }); } catch (_) { inp.focus(); }
            try { inp.setSelectionRange(pos, pos); } catch (_) { }
        });
    }
    wrap.appendChild(inp);
    el.appendChild(wrap);
}

function _qmatch(key, name) {
    const q = String(menuSearch[key] || "").trim().toLowerCase();
    if (!q) return true;
    return String(name || "").toLowerCase().includes(q);
}
function _menuBack(el) {
    el.appendChild(_menuItem("← Back", () => { _enterAnimMenuPage("root"); }, false, false));
    _menuSep(el);
}

function _appendCycleSpeedSection(el) {
    _menuSep(el);

    const hdr = document.createElement("div");
    hdr.textContent = "Cycle Speed";
    hdr.style.opacity = "0.8";
    hdr.style.padding = "2px 8px 6px";
    el.appendChild(hdr);

    const wrap = document.createElement("div");
    wrap.style.padding = "0 8px 8px";
    wrap.style.display = "grid";
    wrap.style.gridTemplateColumns = "1fr auto";
    wrap.style.gap = "8px";
    wrap.style.alignItems = "center";
    for (const ev of ["mousedown", "click", "dblclick", "keydown", "keyup", "keypress", "wheel", "pointerdown"]) {
        wrap.addEventListener(ev, (e) => { e.stopPropagation(); }, { passive: false });
    }

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0.05";
    slider.max = "3.00";
    slider.step = "0.01";
    slider.value = getAnimCycleSpeed().toFixed(2);
    slider.style.width = "100%";
    slider.title = tr("Current movement cycle speed");

    const value = document.createElement("div");
    value.textContent = slider.value + "×";
    value.style.minWidth = "44px";
    value.style.textAlign = "right";
    value.style.fontVariantNumeric = "tabular-nums";
    value.style.opacity = "0.92";

    slider.addEventListener("input", () => {
        value.textContent = Number(slider.value).toFixed(2) + "×";
        setAnimCycleSpeed(slider.value, { capture: true, refreshMenu: false });
    });

    wrap.appendChild(slider);
    wrap.appendChild(value);
    el.appendChild(wrap);

    const hint = document.createElement("div");
    hint.textContent = tr("Recorded during capture.");
    hint.style.opacity = "0.65";
    hint.style.padding = "0 8px 2px";
    hint.style.fontSize = "11px";
    el.appendChild(hint);
}

async function _openActiveFlatplatePlaybackOptions() {
    if (!activeCharacter || !activeCharacter.flatplate) return null;
    const current = activeCharacter;
    const settings = await _askFlatplateOptions({
        fps: current.flatplate.fps || current.source?.fps || 24,
        mode: current.flatplate.mode || current.source?.playback || 'forward',
        stopAtLastFrame: current.flatplate.stopAtLastFrame || current.source?.stopAtLastFrame || false,
        infinite: (current.flatplate.infinite ?? current.source?.infinite ?? true),
        repeats: current.flatplate.repeats || current.source?.repeats || 1,
    });
    if (!settings || activeCharacter !== current) return null;
    await _setFlatplatePlaybackSettings(current, settings, { capture: true, label: 'flatplate-playback-options' });
    return settings;
}

function _appendFlatplatePlaybackSection(el) {
    if (!activeCharacter || !activeCharacter.flatplate) return;
    _menuSep(el);
    const hdr = document.createElement("div");
    hdr.textContent = "Flatplate Playback";
    hdr.style.opacity = "0.8";
    hdr.style.padding = "2px 8px 6px";
    el.appendChild(hdr);

    const fp = activeCharacter.flatplate;
    const mode = _normalizeFlatplateModeValue(fp.mode || 'forward');
    const summary = document.createElement("div");
    summary.style.opacity = "0.72";
    summary.style.padding = "0 8px 8px";
    summary.style.fontSize = "11px";
    const repeatsText = (fp.infinite ?? true) ? '∞' : String(_normalizeFlatplateRepeatCount(fp.repeats, 1));
    const modeLabelMap = { pingpong: 'Ping Pong', random: 'Random', forward: 'Forward', backward: 'Backward' };
    summary.textContent = `Mode: ${modeLabelMap[mode] || 'Forward'} · ${Math.round(_num(fp.fps, 24))} fps · repeats: ${repeatsText}${fp.stopAtLastFrame ? ' · stop at last' : ''}`;
    el.appendChild(summary);

    const fpsWrap = document.createElement("div");
    fpsWrap.style.padding = "0 8px 8px";
    fpsWrap.style.display = "grid";
    fpsWrap.style.gridTemplateColumns = "1fr auto";
    fpsWrap.style.gap = "8px";
    fpsWrap.style.alignItems = "center";
    for (const ev of ["mousedown", "click", "dblclick", "keydown", "keyup", "keypress", "wheel", "pointerdown"]) {
        fpsWrap.addEventListener(ev, (e) => { e.stopPropagation(); }, { passive: false });
    }
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "1";
    slider.max = "60";
    slider.step = "1";
    slider.value = String(Math.round(_num(activeCharacter.flatplate.fps, 24)));
    slider.style.width = "100%";
    const value = document.createElement("div");
    value.textContent = `${slider.value} fps`;
    value.style.minWidth = "56px";
    value.style.textAlign = "right";
    value.style.fontVariantNumeric = "tabular-nums";
    slider.addEventListener("input", () => {
        const nextFps = Math.max(1, Math.round(_num(slider.value, activeCharacter.flatplate.fps || 24)));
        slider.value = String(nextFps);
        value.textContent = `${nextFps} fps`;
        _setFlatplatePlaybackSettings(activeCharacter, { fps: nextFps }, { capture: true, label: 'flatplate-fps' });
    });
    fpsWrap.appendChild(slider);
    fpsWrap.appendChild(value);
    el.appendChild(fpsWrap);

    el.appendChild(_menuItem('Optionen…', () => { _openActiveFlatplatePlaybackOptions(); }, false, false));

    const hint = document.createElement("div");
    hint.textContent = tr("Recorded during capture.");
    hint.style.opacity = "0.65";
    hint.style.padding = "6px 8px 2px";
    hint.style.fontSize = "11px";
    el.appendChild(hint);
}
function _buildFlatplateMenu(el) {
    _menuHdr(el, "Flatplate");
    if (!activeCharacter || !activeCharacter.flatplate) {
        const hint = document.createElement('div');
        hint.textContent = 'No flatplate selected.';
        hint.style.opacity = '0.7';
        hint.style.padding = '6px 8px 4px';
        el.appendChild(hint);
        return;
    }
    const info = document.createElement('div');
    const frameCount = Array.isArray(activeCharacter.flatplate.frames) ? activeCharacter.flatplate.frames.length : 0;
    const fpModeLabelMap = { pingpong: 'Ping Pong', random: 'Random', forward: 'Forward', backward: 'Backward' };
    const fpModeLabel = fpModeLabelMap[_normalizeFlatplateModeValue(activeCharacter.flatplate.mode || 'forward')] || 'Forward';
    const fpRepeatLabel = (activeCharacter.flatplate.infinite ?? true) ? '∞' : `${_normalizeFlatplateRepeatCount(activeCharacter.flatplate.repeats, 1)}x`;
    info.textContent = `${frameCount} frame${frameCount === 1 ? '' : 's'} · ${Math.round(_num(activeCharacter.flatplate.fps, 24))} fps · ${fpModeLabel} · ${fpRepeatLabel}${activeCharacter.flatplate.stopAtLastFrame ? ' · stop last' : ''}`;
    info.style.opacity = '0.72';
    info.style.padding = '0 8px 8px';
    el.appendChild(info);
    _appendFlatplatePlaybackSection(el);
    _menuSep(el);
    el.appendChild(_menuItem('Change PNG / ZIP…', () => {
        pendingFlatplateReplaceTarget = activeCharacter;
        hideAnimMenu();
        if (transport.flatplateFile) { transport.flatplateFile.value = ''; transport.flatplateFile.click(); }
    }, false, false));
    _appendFlatplateHistorySection(el, activeCharacter);
    _appendCharacterSelectorSection(el, lastMenuCharacterCandidates);
}

function _buildMovementMenu(el) {
    _menuHdr(el, "Movement");
    _menuSearchBox(el, "movement", "Search movement…");

    const resolvedSelected = _resolveAnimName(anim.selectedName, anim) || _low(anim.selectedName);
    el.appendChild(_menuItem("0. none", () => setAnimNone(), anim.selectedName === null));

    const quickEntries = [];
    const quickDefs = [
        { label: 'Walking', wants: ['walk', 'walking', 'walkcycle', 'walk cycle'] },
        { label: 'Running', wants: ['run', 'running', 'jog', 'jogging', 'sprint', 'sprinting'] },
    ];
    for (const def of quickDefs) {
        let matchedName = null;
        for (const clip of (anim.clips || [])) {
            const clipName = String(clip?.name || '');
            const low = _low(clipName);
            if (def.wants.some(v => low.includes(v))) { matchedName = clipName; break; }
        }
        if (matchedName) quickEntries.push({ label: def.label, clipName: matchedName });
    }
    for (let i = 0; i < quickEntries.length; i++) {
        const item = quickEntries[i];
        const resolved = _resolveAnimName(item.clipName, anim) || _low(item.clipName);
        if (_qmatch('movement', item.label) || _qmatch('movement', item.clipName)) {
            el.appendChild(_menuItem(`${i + 1}. ${item.label}`, () => setAnimByName(item.clipName), resolvedSelected === resolved));
        }
    }

    if (anim.clips && anim.clips.length) {
        const quickSet = new Set(quickEntries.map(e => _low(e.clipName)));
        const extras = anim.clips
            .map(c => c?.name ?? '')
            .filter(n => n && !quickSet.has(_low(n)));
        if (extras.length) {
            _menuSep(el);
            const hdr = document.createElement('div');
            hdr.textContent = tr('Clips');
            hdr.style.opacity = '0.8';
            hdr.style.padding = '2px 8px 6px';
            el.appendChild(hdr);
            for (const n of extras) {
                if (!_qmatch('movement', n)) continue;
                const resolved = _resolveAnimName(n, anim) || _low(n);
                el.appendChild(_menuItem(n, () => setAnimByName(n), resolvedSelected === resolved));
            }
        }
    } else {
        const hint = document.createElement('div');
        hint.textContent = tr('No animations in this GLB.');
        hint.style.opacity = '0.7';
        hint.style.padding = '6px 8px 4px';
        el.appendChild(hint);
    }

    _appendCycleSpeedSection(el);
}

function _buildDialogMenu(el) {
    _menuHdr(el, "Dialog");
    _menuSearchBox(el, "dialog", "Search dialog…");

    const all = (voice && voice.clips) ? voice.clips.slice() : [];
    const placed = all.filter(c => c && c.enabled && Number.isFinite(+c.t));
    const lib = all.filter(c => !c || !(c.enabled && Number.isFinite(+c.t)));

    const info = document.createElement("div");
    info.textContent = `${tr("Library")}: ${lib.length} | ${tr("Placed")}: ${placed.length}`;
    info.style.opacity = "0.70";
    info.style.padding = "0 8px 8px";
    el.appendChild(info);

    // Library
    const hdrLib = document.createElement("div");
    hdrLib.textContent = tr("Dialog library (not placed)");
    hdrLib.style.opacity = "0.8";
    hdrLib.style.padding = "2px 8px 6px";
    el.appendChild(hdrLib);

    if (lib.length) {
        const listLib = lib.slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
        for (const c of listLib) {
            if (!_qmatch("dialog", c.name || "")) continue;
            const nm = _stripAudioExt(c.name || "dialog");
            el.appendChild(_menuRow(nm, {
                onMainClick: () => voice.placeClipAt(c.id, timeline.playhead),
                onPreviewClick: () => { try { voice.previewClip(c.id, 3.0); } catch { } },
                closeOnMainClick: true,
            }));
        }
    } else {
        const hint = document.createElement("div");
        hint.textContent = tr("No dialog clips in library yet.");
        hint.style.opacity = "0.65";
        hint.style.padding = "2px 8px 8px";
        el.appendChild(hint);
    }

    _menuSep(el);
    el.appendChild(_menuItem("Add custom MP3(s) to library (embed)", async () => { try { await voice.pickFilesToLibrary(); } catch { } buildAnimMenuItems(); }, false, false));


    // Helpers: make template files usable immediately (like manually imported ones)
    async function _ensureDialogTemplateClip(it) {
        const url = String(it?.url || "");
        const name = String(it?.name || "template");
        if (!url) return null;

        // reuse existing library item for same URL if possible
        let c = null;
        try {
            c = (voice.clips || []).find(x => x && x.sourceType === "external" && String(x.url || "") === url && !(x.enabled && Number.isFinite(+x.t)));
        } catch { }
        if (!c) {
            try { c = await voice.addExternalToLibrary(url, name); } catch (e) { console.warn(e); }
        }
        return c;
    }

    _menuSep(el);
    const list = templateBanks.dialog || [];
    if (list.length) {
        const hdr = document.createElement("div");
        hdr.textContent = tr("Templates (click = place at playhead, ▶ = preview)");
        hdr.style.opacity = "0.8";
        hdr.style.padding = "2px 8px 6px";
        el.appendChild(hdr);

        for (const it of list) {
            if (!_qmatch("dialog", it.name || "")) continue;
            const nm = _stripAudioExt(it.name);
            el.appendChild(_menuRow(nm, {
                onMainClick: async () => {
                    try { await voice.addExternalAt(String(it?.url || ""), String(it?.name || "template"), timeline.playhead, { enabled: true }); } catch (e) { console.warn(e); }
                    buildAnimMenuItems();
                },
                onPreviewClick: async () => {
                    try { await voice.previewExternal(String(it?.url || ""), 3.0); } catch (e) { console.warn(e); }
                },
                closeOnMainClick: true,
            }));
        }
    } else {
        const hint = document.createElement("div");
        hint.textContent = tr("No dialog_templates.json found (optional).");
        hint.style.opacity = "0.65";
        hint.style.padding = "2px 8px 8px";
        el.appendChild(hint);
    }

    _menuSep(el);

    const hdr2 = document.createElement("div");

    hdr2.textContent = tr("Placed on timeline");
    hdr2.style.opacity = "0.8";
    hdr2.style.padding = "2px 8px 6px";
    el.appendChild(hdr2);

    if (placed.length) {
        const list2 = placed.slice().sort((a, b) => (+a.t || 0) - (+b.t || 0));
        for (const c of list2) {
            if (!_qmatch("dialog", c.name || "")) continue;
            const t0 = (+c.t || 0);
            const label = `${t0.toFixed(2)}s — ${_stripAudioExt(c.name || "dialog")} (jump)`;
            el.appendChild(_menuItem(label, () => {
                timeline.playhead = _clamp(t0, 0, timeline.duration || Math.max(t0, 0));
                applyTimelineAt(timeline.playhead);
                syncTransportUI();
            }, false));
        }
    } else {
        const hint = document.createElement("div");
        hint.textContent = tr("No dialog clips placed yet.");
        hint.style.opacity = "0.65";
        hint.style.padding = "2px 8px 8px";
        el.appendChild(hint);
    }

    _menuSep(el);
    el.appendChild(_menuItem("Remove last placed dialog clip", () => voice.removeLastPlaced(), false));
    el.appendChild(_menuItem("Clear ALL placed dialog clips", () => voice.clearPlaced(), false));
    _menuSep(el);
    el.appendChild(_menuItem("Delete ALL dialog library items", () => voice.clearLibrary(), false));
}

function _buildFoleyMenu(el) {
    _menuHdr(el, "Foley");
    _menuSearchBox(el, "foley", "Search foley…");

    const all = (foley && foley.clips) ? foley.clips.slice() : [];
    const placed = all.filter(c => c && c.enabled && Number.isFinite(+c.t));
    const lib = all.filter(c => !c || !(c.enabled && Number.isFinite(+c.t)));

    const info = document.createElement("div");
    info.textContent = `${tr("Library")}: ${lib.length} | ${tr("Placed")}: ${placed.length}`;
    info.style.opacity = "0.70";
    info.style.padding = "0 8px 8px";
    el.appendChild(info);

    const hdrLib = document.createElement("div");
    hdrLib.textContent = tr("Foley library (not placed)");
    hdrLib.style.opacity = "0.8";
    hdrLib.style.padding = "2px 8px 6px";
    el.appendChild(hdrLib);

    if (lib.length) {
        const listLib = lib.slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
        for (const c of listLib) {
            if (!_qmatch("foley", c.name || "")) continue;
            const nm = _stripAudioExt(c.name || "foley");
            el.appendChild(_menuRow(nm, {
                onMainClick: () => foley.placeClipAt(c.id, timeline.playhead),
                onPreviewClick: () => { try { foley.previewClip(c.id, 3.0); } catch { } },
                closeOnMainClick: true,
            }));
        }
    } else {
        const hint = document.createElement("div");
        hint.textContent = tr("No foley clips in library yet.");
        hint.style.opacity = "0.65";
        hint.style.padding = "2px 8px 8px";
        el.appendChild(hint);
    }

    _menuSep(el);
    el.appendChild(_menuItem("Add custom MP3(s) to library (embed)", async () => { try { await foley.pickFilesToLibrary(); } catch { } buildAnimMenuItems(); }, false, false));


    // Helpers: make template files usable immediately (like manually imported ones)
    async function _ensureFoleyTemplateClip(it) {
        const url = String(it?.url || "");
        const name = String(it?.name || "template");
        if (!url) return null;

        // reuse existing library item for same URL if possible
        let c = null;
        try {
            c = (foley.clips || []).find(x => x && x.sourceType === "external" && String(x.url || "") === url && !(x.enabled && Number.isFinite(+x.t)));
        } catch { }
        if (!c) {
            try { c = await foley.addExternalToLibrary(url, name); } catch (e) { console.warn(e); }
        }
        return c;
    }

    _menuSep(el);
    const list = templateBanks.foley || [];
    if (list.length) {
        const hdr = document.createElement("div");
        hdr.textContent = tr("Templates (click = place at playhead, ▶ = preview)");
        hdr.style.opacity = "0.8";
        hdr.style.padding = "2px 8px 6px";
        el.appendChild(hdr);

        for (const it of list) {
            if (!_qmatch("foley", it.name || "")) continue;
            const nm = _stripAudioExt(it.name);
            el.appendChild(_menuRow(nm, {
                onMainClick: async () => {
                    try { await foley.addExternalAt(String(it?.url || ""), String(it?.name || "template"), timeline.playhead, { enabled: true }); } catch (e) { console.warn(e); }
                    buildAnimMenuItems();
                },
                onPreviewClick: async () => {
                    try { await foley.previewExternal(String(it?.url || ""), 3.0); } catch (e) { console.warn(e); }
                },
                closeOnMainClick: true,
            }));
        }
    } else {
        const hint = document.createElement("div");
        hint.textContent = tr("No foley_templates.json found (optional).");
        hint.style.opacity = "0.65";
        hint.style.padding = "2px 8px 8px";
        el.appendChild(hint);
    }

    _menuSep(el);

    const hdr2 = document.createElement("div");

    hdr2.textContent = tr("Placed on timeline");
    hdr2.style.opacity = "0.8";
    hdr2.style.padding = "2px 8px 6px";
    el.appendChild(hdr2);

    if (placed.length) {
        const list2 = placed.slice().sort((a, b) => (+a.t || 0) - (+b.t || 0));
        for (const c of list2) {
            if (!_qmatch("foley", c.name || "")) continue;
            const t0 = (+c.t || 0);
            const label = `${t0.toFixed(2)}s — ${_stripAudioExt(c.name || "foley")} (jump)`;
            el.appendChild(_menuItem(label, () => {
                timeline.playhead = _clamp(t0, 0, timeline.duration || Math.max(t0, 0));
                applyTimelineAt(timeline.playhead);
                syncTransportUI();
            }, false));
        }
    } else {
        const hint = document.createElement("div");
        hint.textContent = tr("No foley clips placed yet.");
        hint.style.opacity = "0.65";
        hint.style.padding = "2px 8px 8px";
        el.appendChild(hint);
    }

    _menuSep(el);
    el.appendChild(_menuItem("Remove last placed foley clip", () => foley.removeLastPlaced(), false));
    el.appendChild(_menuItem("Clear ALL placed foley clips", () => foley.clearPlaced(), false));
    _menuSep(el);
    el.appendChild(_menuItem("Delete ALL foley library items", () => foley.clearLibrary(), false));
}


function clampAnimMenuToViewport() {
    const el = ensureAnimMenu();
    if (!el || el.style.display === "none") return;
    const pad = 8;
    const vw = innerWidth, vh = innerHeight;

    // Measure current size (after content rebuild / search)
    const rect = el.getBoundingClientRect();

    // Prefer the explicit style positions if present, otherwise current rect
    let x = Number.parseFloat(el.style.left || "");
    let y = Number.parseFloat(el.style.top || "");
    if (!Number.isFinite(x)) x = rect.left;
    if (!Number.isFinite(y)) y = rect.top;

    if (x + rect.width + pad > vw) x = vw - rect.width - pad;
    if (y + rect.height + pad > vh) y = vh - rect.height - pad;

    x = Math.max(pad, x);
    y = Math.max(pad, y);

    el.style.left = x + "px";
    el.style.top = y + "px";
}

var lastMenuCharacterCandidates = [];
let pendingFlatplateReplaceTarget = null;

function _enterAnimMenuPage(page) {
    animMenuPage = page;
    if (page === "movement" || page === "flatplate" || page === "dialog" || page === "foley") {
        menuSearchFocus.key = page;
        try { menuSearchFocus.pos = String(menuSearch[page] || "").length; } catch (_) { menuSearchFocus.pos = 0; }
    } else {
        menuSearchFocus.key = null;
        menuSearchFocus.pos = 0;
    }
    buildAnimMenuItems();
    // Ensure we can reach all entries
    try { ensureAnimMenu().scrollTop = 0; } catch (_) { }
}
function buildAnimMenuItems() {
    const el = ensureAnimMenu();
    el.innerHTML = "";

    if (animMenuPage === "root") {
        _menuHdr(el, "Choose");
        if (activeCharacter && activeCharacter.flatplate) {
            el.appendChild(_menuItem("Flatplate ▸", () => { _enterAnimMenuPage("flatplate"); }, false, false));
            el.appendChild(_menuItem("Dialog ▸", () => { _enterAnimMenuPage("dialog"); }, false, false));
            el.appendChild(_menuItem("Foley ▸", () => { _enterAnimMenuPage("foley"); }, false, false));
        } else {
            el.appendChild(_menuItem("Movement ▸", () => { _enterAnimMenuPage("movement"); }, false, false));
            el.appendChild(_menuItem("Dialog ▸", () => { _enterAnimMenuPage("dialog"); }, false, false));
            el.appendChild(_menuItem("Foley ▸", () => { _enterAnimMenuPage("foley"); }, false, false));
            _appendCycleSpeedSection(el);
        }
        _appendCharacterSelectorSection(el, lastMenuCharacterCandidates);
        clampAnimMenuToViewport();
        return;
    }

    _menuBack(el);

    if (animMenuPage === "movement") _buildMovementMenu(el);
    else if (animMenuPage === "flatplate") _buildFlatplateMenu(el);
    else if (animMenuPage === "dialog") _buildDialogMenu(el);
    else if (animMenuPage === "foley") _buildFoleyMenu(el);
    else { animMenuPage = "root"; buildAnimMenuItems(); return; }

    clampAnimMenuToViewport();
}

// ---------- Voice playback + lipsync (dynamic mouth texture swap) ----------
// Dialog is now a MULTI-CLIP system: you can add multiple MP3 clips, each with its own trigger time.
// Playback is sample-accurately locked to the timeline playhead (pause/seek/scrub safe).
const voice = (() => {
    /** @type {AudioContext|null} */
    let ac = null;
    /** @type {GainNode|null} */
    let gain = null;
    /** @type {AnalyserNode|null} */
    let analyser = null;
    /** @type {AudioBufferSourceNode|null} */
    let source = null;
    /** @type {AudioBufferSourceNode|null} */
    let previewSource = null;
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "audio/mpeg,audio/mp3,audio/*";
    fileInput.multiple = true;
    fileInput.style.display = "none";
    document.body.appendChild(fileInput);

    /** @type {Array<{
     *   id:string, name:string, t:number,
     *   sourceType:"embedded"|"external",
     *   url?:string,
     *   mime?:string,
     *   bytes?:ArrayBuffer|null,
     *   buffer?:AudioBuffer|null
     * }>} */
    const clips = [];

    // Cache decoded buffers for external templates so preview doesn't create library/project items
    const _extBufCache = new Map();

    const state = {
        // rms smoothing
        _rmsSmooth: 0,
        _lastRms: 0,

        // internal sync
        _playing: false,
        _previewPlaying: false,
        _clipId: "",
        _startedAtTL: -1,
        _ctxStart: 0,
        _offset: 0,

        lastPlayhead: 0,
    };

    function _ensureAudioGraph() {
        if (ac) return;
        ac = new (window.AudioContext || window.webkitAudioContext)();
        gain = ac.createGain();
        analyser = ac.createAnalyser();
        analyser.fftSize = 2048;
        gain.gain.value = 1.0;
        gain.connect(analyser);
        analyser.connect(ac.destination);
    }

    async function _resume() {
        _ensureAudioGraph();
        try { if (ac && ac.state === "suspended") await ac.resume(); } catch { }
    }

    function _stopSource() {
        if (!source) return;
        try { source.stop(0); } catch { }
        try { source.disconnect(); } catch { }
        source = null;
        state._playing = false;
        state._clipId = "";
        state._startedAtTL = -1;
        state._ctxStart = 0;
        state._offset = 0;
    }

    function stop() {
        _stopSource();
    }

    function _stopPreview() {
        if (!previewSource) { state._previewPlaying = false; return; }
        try { previewSource.stop(0); } catch { }
        try { previewSource.disconnect(); } catch { }
        previewSource = null;
        state._previewPlaying = false;
    }

    async function previewClip(id, maxSeconds = 3.0) {
        _ensureAudioGraph();
        await _resume();
        _stopPreview();
        const c = clips.find(x => String(x?.id) === String(id));
        if (!c) return;
        if (!c.buffer) {
            // Best-effort load/decode if external
            if (c.sourceType === "external" && c.url) {
                try {
                    const r = await fetch(String(c.url), { cache: "no-store" });
                    if (r.ok) {
                        const ab = await r.arrayBuffer();
                        c.buffer = await (window.decodeAudioCompat ? window.decodeAudioCompat(ac, ab) : (window.decodeAudioCompat ? window.decodeAudioCompat(ac, ab) : ac.decodeAudioData(ab.slice(0))));
                    }
                } catch { }
            }
        }
        if (!c.buffer) return;
        previewSource = ac.createBufferSource();
        previewSource.buffer = c.buffer;
        previewSource.connect(gain);
        state._previewPlaying = true;
        previewSource.onended = () => { _stopPreview(); };
        const dur = Math.max(0, Math.min(Number(maxSeconds) || 3.0, c.buffer.duration || 0));
        try { previewSource.start(0, 0); } catch { _stopPreview(); return; }
        if (dur > 0) {
            setTimeout(() => { _stopPreview(); }, Math.ceil(dur * 1000));
        }
    }
    async function previewExternal(url, maxSeconds = 3.0) {
        _ensureAudioGraph();
        await _resume();
        _stopPreview();
        const u = String(url || "");
        if (!u) return;

        let buf = _extBufCache.get(u) || null;
        if (!buf) {
            try {
                const r = await fetch(u, { cache: "no-store" });
                if (!r.ok) throw new Error(String(r.status));
                const ab = await r.arrayBuffer();
                buf = await (window.decodeAudioCompat ? window.decodeAudioCompat(ac, ab) : (window.decodeAudioCompat ? window.decodeAudioCompat(ac, ab) : ac.decodeAudioData(ab.slice(0))));
                _extBufCache.set(u, buf);
            } catch (err) {
                console.warn("previewExternal failed:", u, err);
                return;
            }
        }

        previewSource = ac.createBufferSource();
        previewSource.buffer = buf;
        previewSource.connect(gain);
        state._previewPlaying = true;
        previewSource.onended = () => { _stopPreview(); };

        const dur = Math.max(0, Math.min(Number(maxSeconds) || 3.0, buf.duration || 0));
        try { previewSource.start(0, 0); } catch { _stopPreview(); return; }
        if (dur > 0) {
            setTimeout(() => { _stopPreview(); }, Math.ceil(dur * 1000));
        }
    }


    function clear() {
        // backwards compat: clear everything
        while (clips.length) clips.pop();
        if (state._playing) _stopSource();
    }

    function removeLast() { removeLastPlaced(); }

    function _genId() {
        return "c_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);
    }

    function _abToB64(ab) {
        if (!ab) return "";
        const bytes = new Uint8Array(ab);
        const CHUNK = 0x8000;
        let bin = "";
        for (let i = 0; i < bytes.length; i += CHUNK) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return btoa(bin);
    }
    function _b64ToAb(b64) {
        const bin = atob(b64 || "");
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
    }

    function _clipDuration(c) {
        const d = c?.buffer?.duration ?? 0;
        return (Number.isFinite(d) && d > 0) ? d : 0;
    }

    function _findActiveClip(playhead) {
        const ph = +playhead || 0;
        /** @type {any|null} */
        let best = null;
        for (const c of clips) {
            if (!c || !c.enabled) continue;
            const t0 = +c.t;
            if (!Number.isFinite(t0)) continue;
            if (t0 <= ph + 1e-6) {
                const dur = _clipDuration(c);
                if (dur > 0 && ph <= t0 + dur + 1e-6) {
                    // among overlapping, take the latest start
                    if (!best || t0 > best.t) best = c;
                } else if (dur === 0) {
                    // not decoded yet; we still prefer latest start, but it can't play
                    if (!best || t0 > best.t) best = c;
                }
            }
        }
        return best;
    }

    function _startAtOffset(c, expectedOffset) {
        if (!ac || !gain) return;
        _stopSource();

        if (!c?.buffer) return;

        source = ac.createBufferSource();
        source.buffer = c.buffer;
        source.connect(gain);

        const off = Math.max(0, Math.min(expectedOffset, c.buffer.duration));
        state._offset = off;
        state._ctxStart = ac.currentTime;
        state._startedAtTL = +c.t || 0;
        state._clipId = String(c.id || "");
        state._playing = true;

        try { source.start(0, off); } catch (err) { console.error("voice source.start failed:", err); _stopSource(); }
    }

    async function addEmbeddedAt(t, file, { enabled = true } = {}) {
        _ensureAudioGraph();
        await _resume();

        const ab = await file.arrayBuffer();
        let buf = null;
        try {
            buf = await (window.decodeAudioCompat ? window.decodeAudioCompat(ac, ab) : (window.decodeAudioCompat ? window.decodeAudioCompat(ac, ab) : ac.decodeAudioData(ab.slice(0))));
        } catch (err) {
            console.error("decodeAudioData failed:", err);
            return null;
        }

        const tt = (Number.isFinite(+t) ? Math.max(0, +t) : NaN);

        const inferredMime = String(file?.type || "").trim();

        const clip = {
            id: _genId(),
            name: file.name || "dialog",
            t: (enabled ? tt : NaN),
            enabled: !!enabled && Number.isFinite(tt),
            sourceType: "embedded",
            mime: inferredMime || "audio/mpeg",
            bytes: ab.slice(0),
            buffer: buf,
        };
        clips.push(clip);
        clips.sort((a, b) => {
            const ta = Number.isFinite(+a.t) ? +a.t : 1e15;
            const tb = Number.isFinite(+b.t) ? +b.t : 1e15;
            return ta - tb;
        });
        return clip;
    }

    function addExternalToLibrary(url, name) {
        return addExternalAt(url, name, NaN, { enabled: false });
    }

    function placeClipAt(id, t) {
        const src = clips.find(x => String(x.id) === String(id));
        if (!src) return null;

        const tt = (Number.isFinite(+t) ? Math.max(0, +t) : NaN);

        // If placing a library item (disabled / no valid t), keep it in the library and create a new placed instance.
        if (!src.enabled || !Number.isFinite(+src.t)) {
            const placed = {
                ...src,
                id: _genId(),
                t: tt,
                enabled: Number.isFinite(tt),
            };
            clips.push(placed);
            clips.sort((a, b) => {
                const ta = Number.isFinite(+a.t) ? +a.t : 1e15;
                const tb = Number.isFinite(+b.t) ? +b.t : 1e15;
                return ta - tb;
            });
            return placed;
        }

        // If placing an already placed clip, just move it.
        src.t = tt;
        src.enabled = Number.isFinite(tt);
        return src;
    }

    function removeLastPlaced() {
        // last placed by time
        let best = null;
        for (const c of clips) {
            if (c && c.enabled && Number.isFinite(+c.t)) {
                if (!best || (+c.t) > (+best.t)) best = c;
            }
        }
        if (best) {
            const idx = clips.indexOf(best);
            if (idx >= 0) clips.splice(idx, 1);
            if (state._clipId === best.id) _stopSource();
        }
    }

    function clearPlaced() {
        for (let i = clips.length - 1; i >= 0; i--) {
            const c = clips[i];
            if (c && c.enabled && Number.isFinite(+c.t)) clips.splice(i, 1);
        }
        if (state._playing) _stopSource();
    }

    function clearLibrary() {
        for (let i = clips.length - 1; i >= 0; i--) {
            const c = clips[i];
            if (!c || !(c.enabled && Number.isFinite(+c.t))) clips.splice(i, 1);
        }
        // stopping not necessary; placed clips remain
    }


    function _mimeFromUrl(u) {
        const s = String(u || "").toLowerCase();
        if (s.endsWith(".wav")) return "audio/wav";
        if (s.endsWith(".mp3")) return "audio/mpeg";
        if (s.endsWith(".ogg")) return "audio/ogg";
        if (s.endsWith(".m4a") || s.endsWith(".mp4")) return "audio/mp4";
        return "audio/mpeg";
    }

    async function addExternalAt(url, name, t, { enabled = true } = {}) {
        _ensureAudioGraph();
        await _resume();

        const u0 = String(url || "");
        const tt = (Number.isFinite(+t) ? Math.max(0, +t) : NaN);
        const mime = _mimeFromUrl(u0);

        const clip = {
            id: _genId(),
            name: String(name || "template"),
            t: (enabled ? tt : NaN),
            enabled: !!enabled && Number.isFinite(tt),
            sourceType: "external",
            url: u0,
            mime,
            bytes: null,
            buffer: null,
        };
        clips.push(clip);
        clips.sort((a, b) => {
            const ta = Number.isFinite(+a.t) ? +a.t : 1e15;
            const tb = Number.isFinite(+b.t) ? +b.t : 1e15;
            return ta - tb;
        });

        // Load & decode for playback (but keep it external for project saving)
        try {
            const r = await fetch(clip.url, { cache: "no-store" });
            if (!r.ok) throw new Error(String(r.status));
            const ab = await r.arrayBuffer();
            clip.buffer = await (window.decodeAudioCompat ? window.decodeAudioCompat(ac, ab) : ac.decodeAudioData(ab.slice(0)));
        } catch (err) {
            console.warn("Failed to load external dialog clip:", clip.url, err);
        }
        return clip;
    }

    function pickFilesToLibrary() {
        return new Promise((resolve) => {
            fileInput.value = "";
            const onChange = async () => {
                fileInput.removeEventListener("change", onChange);
                const files = (fileInput.files) ? Array.from(fileInput.files) : [];
                if (!files.length) { resolve([]); return; }

                const added = [];
                for (const f of files) {
                    try {
                        const clip = await addEmbeddedAt(NaN, f, { enabled: false });
                        if (clip) added.push(clip);
                    } catch (err) {
                        console.error("addEmbeddedAt failed:", err);
                    }
                }
                resolve(added);
            };
            fileInput.addEventListener("change", onChange, { once: true });
            fileInput.click();
        });
    }

    function updateFromTimeline(playhead, { playing, recording, scrubbing }) {
        const ph = +playhead || 0;
        const active = !!(playing || recording);
        const backwards = ph < state.lastPlayhead - 1e-6;

        // If scrubbing/backwards: stop immediately.
        if (scrubbing || backwards) {
            if (state._playing) _stopSource();
            state.lastPlayhead = ph;
            return;
        }

        // If paused: stop.
        if (!active) {
            if (state._playing) _stopSource();
            state.lastPlayhead = ph;
            return;
        }

        const c = _findActiveClip(ph);
        if (!c || !c.buffer) {
            if (state._playing) _stopSource();
            state.lastPlayhead = ph;
            return;
        }

        const expectedOffset = ph - (+c.t || 0);
        const inRange = expectedOffset >= 0 && expectedOffset <= c.buffer.duration + 1e-6;
        if (!inRange) {
            if (state._playing) _stopSource();
            state.lastPlayhead = ph;
            return;
        }

        _resume();

        // Start or switch clips.
        if (!state._playing || state._clipId !== c.id) {
            _startAtOffset(c, expectedOffset);
            state.lastPlayhead = ph;
            return;
        }

        // Drift correction.
        const audioPos = state._offset + (ac.currentTime - state._ctxStart);
        const drift = audioPos - expectedOffset;
        if (Math.abs(drift) > 0.03) {
            _startAtOffset(c, expectedOffset);
        }

        state.lastPlayhead = ph;
    }

    function isAnyPlaying() {
        return !!(state._playing || state._previewPlaying);
    }

    function getRms(dt) {
        if (!analyser || !(state._playing || state._previewPlaying)) return 0;

        const buf = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(buf);

        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
        }
        const rms = Math.sqrt(sum / Math.max(1, buf.length));

        // smooth (attack a bit faster than release)
        const a = rms;
        const s = state._rmsSmooth;
        const atk = Math.exp(-dt / 0.03);
        const rel = Math.exp(-dt / 0.10);
        state._rmsSmooth = (a > s) ? (atk * s + (1 - atk) * a) : (rel * s + (1 - rel) * a);

        state._lastRms = rms;
        return state._rmsSmooth;
    }

    function isClipActiveAt(playhead) {
        const c = _findActiveClip(playhead);
        return !!(c && c.buffer && (Number.isFinite(c.buffer.duration) ? c.buffer.duration > 0 : true));
    }

    function getRmsAt(playhead, windowSec) {
        const c = _findActiveClip(playhead);
        if (!c || !c.buffer) return 0;
        const sr = Math.max(1, c.buffer.sampleRate || 48000);
        const offset = Math.max(0, Math.min((+playhead || 0) - (+c.t || 0), Math.max(0, c.buffer.duration || 0)));
        const dur = Math.max(1 / sr, Number.isFinite(+windowSec) && +windowSec > 0 ? +windowSec : (1 / 30));
        const startSample = Math.max(0, Math.floor(offset * sr));
        const endSample = Math.min(c.buffer.length, Math.max(startSample + 1, Math.ceil((offset + dur) * sr)));
        if (!(endSample > startSample)) return 0;

        let sum = 0;
        let count = 0;
        const channelCount = Math.max(1, c.buffer.numberOfChannels || 1);
        for (let ch = 0; ch < channelCount; ch++) {
            const data = c.buffer.getChannelData(ch);
            for (let i = startSample; i < endSample; i++) {
                const v = data[i] || 0;
                sum += v * v;
            }
            count += (endSample - startSample);
        }
        return count > 0 ? Math.sqrt(sum / count) : 0;
    }

    function getProjectData() {
        return {
            clips: clips.map(c => {
                const audio =
                    (c.sourceType === "external" && c.url)
                        ? ({ type: "external", url: String(c.url) })
                        : (c.bytes && c.bytes.byteLength)
                            ? ({ type: "embedded", mime: String(c.mime || "audio/mpeg"), b64: _abToB64(c.bytes) })
                            : ({ type: "none" });
                return { id: String(c.id), name: String(c.name || ""), t: (Number.isFinite(+c.t) ? (+c.t) : null), enabled: !!c.enabled, audio };
            }),
        };
    }

    async function loadProjectData(v) {
        clear();
        if (!v || typeof v !== "object") return;
        const list = Array.isArray(v.clips) ? v.clips : [];
        if (!list.length) return;

        _ensureAudioGraph();
        await _resume();

        for (const item of list) {
            const tRaw = item?.t;
            const t = Number.isFinite(+tRaw) ? Math.max(0, +tRaw) : NaN;
            const enabled = !!item?.enabled && Number.isFinite(t);
            const nm = String(item?.name || "dialog");
            const id = String(item?.id || _genId());
            const audio = item?.audio;

            if (audio?.type === "external" && audio.url) {
                const clip = { id, name: nm, t, enabled, sourceType: "external", url: String(audio.url), mime: "audio/mpeg", bytes: null, buffer: null };
                clips.push(clip);
                try {
                    const r = await fetch(clip.url, { cache: "no-store" });
                    if (!r.ok) throw new Error(String(r.status));
                    const ab = await r.arrayBuffer();
                    clip.buffer = await (window.decodeAudioCompat ? window.decodeAudioCompat(ac, ab) : (window.decodeAudioCompat ? window.decodeAudioCompat(ac, ab) : ac.decodeAudioData(ab.slice(0))));
                } catch (err) {
                    console.warn("Failed to load external dialog clip:", clip.url, err);
                }
                continue;
            }

            if (audio?.type === "embedded" && audio.b64) {
                const ab = _b64ToAb(String(audio.b64 || ""));
                let buf = null;
                try { buf = await (window.decodeAudioCompat ? window.decodeAudioCompat(ac, ab) : (window.decodeAudioCompat ? window.decodeAudioCompat(ac, ab) : ac.decodeAudioData(ab.slice(0)))); } catch (err) { console.error("decodeAudioData (dialog project) failed:", err); buf = null; }
                const clip = { id, name: nm, t, enabled, sourceType: "embedded", mime: String(audio.mime || "audio/mpeg"), bytes: ab.slice(0), buffer: buf };
                clips.push(clip);
                continue;
            }
        }

        clips.sort((a, b) => {
            const ta = Number.isFinite(+a.t) ? +a.t : 1e15;
            const tb = Number.isFinite(+b.t) ? +b.t : 1e15;
            return ta - tb;
        });
    }

    return { state, clips, pickFilesToLibrary, addExternalAt, addExternalToLibrary, placeClipAt, clear, removeLastPlaced, clearPlaced, clearLibrary, stop, previewClip, previewExternal, updateFromTimeline, getRms, getRmsAt, isClipActiveAt, isAnyPlaying, getProjectData, loadProjectData };
})();


// ---------- Foley playback (multi-clip, no lipsync) ----------
const foley = (() => {
    /** @type {AudioContext|null} */
    let ac = null;
    /** @type {GainNode|null} */
    let gain = null;
    /** @type {AudioBufferSourceNode|null} */
    let source = null;
    /** @type {AudioBufferSourceNode|null} */
    let previewSource = null;

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "audio/mpeg,audio/mp3,audio/*";
    fileInput.multiple = true;
    fileInput.style.display = "none";
    document.body.appendChild(fileInput);

    /** @type {Array<{
     *   id:string, name:string, t:number,
     *   sourceType:"embedded"|"external",
     *   url?:string,
     *   mime?:string,
     *   bytes?:ArrayBuffer|null,
     *   buffer?:AudioBuffer|null
     * }>} */
    const clips = [];

    // Cache decoded buffers for external templates so preview doesn't create library/project items
    const _extBufCache = (window._extBufCache ||= new Map());

    const state = {
        _playing: false,
        _clipId: "",
        _startedAtTL: -1,
        _ctxStart: 0,
        _offset: 0,
        lastPlayhead: 0,
    };

    function _ensureAudio() {
        if (ac) return;
        ac = new (window.AudioContext || window.webkitAudioContext)();
        gain = ac.createGain();
        gain.gain.value = 1.0;
        gain.connect(ac.destination);
    }

    async function _resume() {
        _ensureAudio();
        try { if (ac && ac.state === "suspended") await ac.resume(); } catch { }
    }

    function _stopSource() {
        if (!source) return;
        try { source.stop(0); } catch { }
        try { source.disconnect(); } catch { }
        source = null;
        state._playing = false;
        state._clipId = "";
        state._startedAtTL = -1;
        state._ctxStart = 0;
        state._offset = 0;
    }

    function stop() { _stopSource(); }

    function _stopPreview() {
        if (!previewSource) return;
        try { previewSource.stop(0); } catch { }
        try { previewSource.disconnect(); } catch { }
        previewSource = null;
    }

    async function previewClip(id, maxSeconds = 3.0) {
        _ensureAudio();
        await _resume();
        _stopPreview();
        const c = clips.find(x => String(x?.id) === String(id));
        if (!c) return;
        if (!c.buffer) {
            if (c.sourceType === "external" && c.url) {
                try {
                    const r = await fetch(String(c.url), { cache: "no-store" });
                    if (r.ok) {
                        const ab = await r.arrayBuffer();
                        c.buffer = await (window.decodeAudioCompat ? window.decodeAudioCompat(ac, ab) : (window.decodeAudioCompat ? window.decodeAudioCompat(ac, ab) : ac.decodeAudioData(ab.slice(0))));
                    }
                } catch { }
            }
        }
        if (!c.buffer) return;
        previewSource = ac.createBufferSource();
        previewSource.buffer = c.buffer;
        previewSource.connect(gain);
        const dur = Math.max(0, Math.min(Number(maxSeconds) || 3.0, c.buffer.duration || 0));
        try { previewSource.start(0, 0); } catch { _stopPreview(); return; }
        if (dur > 0) {
            setTimeout(() => { _stopPreview(); }, Math.ceil(dur * 1000));
        }
    }
    async function previewExternal(url, maxSeconds = 3.0) {
        _ensureAudio();
        await _resume();
        _stopPreview();
        const u = String(url || "");
        if (!u) return;

        let buf = _extBufCache.get(u) || null;
        if (!buf) {
            try {
                const r = await fetch(u, { cache: "no-store" });
                if (!r.ok) throw new Error(String(r.status));
                const ab = await r.arrayBuffer();
                buf = await (window.decodeAudioCompat ? window.decodeAudioCompat(ac, ab) : (window.decodeAudioCompat ? window.decodeAudioCompat(ac, ab) : ac.decodeAudioData(ab.slice(0))));
                _extBufCache.set(u, buf);
            } catch (err) {
                console.warn("previewExternal failed:", u, err);
                return;
            }
        }

        previewSource = ac.createBufferSource();
        previewSource.buffer = buf;
        previewSource.connect(gain);
        state._previewPlaying = true;
        previewSource.onended = () => { _stopPreview(); };

        const dur = Math.max(0, Math.min(Number(maxSeconds) || 3.0, buf.duration || 0));
        try { previewSource.start(0, 0); } catch { _stopPreview(); return; }
        if (dur > 0) {
            setTimeout(() => { _stopPreview(); }, Math.ceil(dur * 1000));
        }
    }

    function clear() { while (clips.length) clips.pop(); if (state._playing) _stopSource(); }
    function _b64ToAb(b64) {
        const bin = atob(b64 || "");
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
    }

    function _clipDuration(c) {
        const d = c?.buffer?.duration ?? 0;
        return (Number.isFinite(d) && d > 0) ? d : 0;
    }

    function _findActiveClip(playhead) {
        const ph = +playhead || 0;
        let best = null;
        for (const c of clips) {
            if (!c || !c.enabled) continue;
            const t0 = +c.t;
            if (!Number.isFinite(t0)) continue;
            if (t0 <= ph + 1e-6) {
                const dur = _clipDuration(c);
                if (dur > 0 && ph <= t0 + dur + 1e-6) {
                    if (!best || t0 > best.t) best = c;
                } else if (dur === 0) {
                    if (!best || t0 > best.t) best = c;
                }
            }
        }
        return best;
    }

    function _startAtOffset(c, expectedOffset) {
        if (!ac || !gain) return;
        _stopSource();
        if (!c?.buffer) return;

        source = ac.createBufferSource();
        source.buffer = c.buffer;
        source.connect(gain);

        const off = Math.max(0, Math.min(expectedOffset, c.buffer.duration));
        state._offset = off;
        state._ctxStart = ac.currentTime;
        state._startedAtTL = +c.t || 0;
        state._clipId = String(c.id || "");
        state._playing = true;

        try { source.start(0, off); } catch (err) { console.error("foley source.start failed:", err); _stopSource(); }
    }

    async function addEmbeddedAt(t, file, { enabled = true } = {}) {
        _ensureAudio();
        await _resume();
        const ab = await file.arrayBuffer();
        let buf = null;
        try { buf = await (window.decodeAudioCompat ? window.decodeAudioCompat(ac, ab) : (window.decodeAudioCompat ? window.decodeAudioCompat(ac, ab) : ac.decodeAudioData(ab.slice(0)))); } catch (err) { console.error("decodeAudioData failed:", err); return null; }

        const tt = (Number.isFinite(+t) ? Math.max(0, +t) : NaN);

        const clip = { id: _genId(), name: file.name || "foley", t: (enabled ? tt : NaN), enabled: !!enabled && Number.isFinite(tt), sourceType: "embedded", mime: file.type || "audio/mpeg", bytes: ab.slice(0), buffer: buf };
        clips.push(clip);
        clips.sort((a, b) => {
            const ta = Number.isFinite(+a.t) ? +a.t : 1e15;
            const tb = Number.isFinite(+b.t) ? +b.t : 1e15;
            return ta - tb;
        });
        return clip;
    }

    function addExternalToLibrary(url, name) {
        return addExternalAt(url, name, NaN, { enabled: false });
    }

    function placeClipAt(id, t) {
        const c = clips.find(x => String(x.id) === String(id));
        if (!c) return null;
        c.t = Number.isFinite(+t) ? (+t) : NaN;
        c.enabled = Number.isFinite(c.t);
        return c;
    }

    function removeLastPlaced() {
        let best = null;
        for (const c of clips) {
            if (c && c.enabled && Number.isFinite(+c.t)) {
                if (!best || (+c.t) > (+best.t)) best = c;
            }
        }
        if (best) {
            const idx = clips.indexOf(best);
            if (idx >= 0) clips.splice(idx, 1);
            if (state._clipId === best.id) _stopSource();
        }
    }

    function clearPlaced() {
        for (let i = clips.length - 1; i >= 0; i--) {
            const c = clips[i];
            if (c && c.enabled && Number.isFinite(+c.t)) clips.splice(i, 1);
        }
        if (state._playing) _stopSource();
    }

    function clearLibrary() {
        for (let i = clips.length - 1; i >= 0; i--) {
            const c = clips[i];
            if (!c || !(c.enabled && Number.isFinite(+c.t))) clips.splice(i, 1);
        }
    }

    async function addExternalAt(url, name, t, { enabled = true } = {}) {
        _ensureAudio();
        await _resume();

        const tt = (Number.isFinite(+t) ? Math.max(0, +t) : NaN);

        const clip = { id: _genId(), name: name || "template", t: (enabled ? tt : NaN), enabled: !!enabled && Number.isFinite(tt), sourceType: "external", url: String(url || ""), mime: "audio/mpeg", bytes: null, buffer: null };
        clips.push(clip);
        clips.sort((a, b) => {
            const ta = Number.isFinite(+a.t) ? +a.t : 1e15;
            const tb = Number.isFinite(+b.t) ? +b.t : 1e15;
            return ta - tb;
        });

        try {
            const r = await fetch(clip.url, { cache: "no-store" });
            if (!r.ok) throw new Error(String(r.status));
            const ab = await r.arrayBuffer();
            clip.buffer = await (window.decodeAudioCompat ? window.decodeAudioCompat(ac, ab) : (window.decodeAudioCompat ? window.decodeAudioCompat(ac, ab) : ac.decodeAudioData(ab.slice(0))));
        } catch (err) {
            console.warn("Failed to load external foley clip:", clip.url, err);
        }
        return clip;
    }

    function pickFilesToLibrary() {
        return new Promise((resolve) => {
            fileInput.value = "";
            const onChange = async () => {
                fileInput.removeEventListener("change", onChange);
                const files = (fileInput.files) ? Array.from(fileInput.files) : [];
                if (!files.length) { resolve([]); return; }

                const added = [];
                for (const f of files) {
                    try {
                        const clip = await addEmbeddedAt(NaN, f, { enabled: false });
                        if (clip) added.push(clip);
                    } catch (err) {
                        console.error("addEmbeddedAt failed:", err);
                    }
                }
                resolve(added);
            };
            fileInput.addEventListener("change", onChange, { once: true });
            fileInput.click();
        });
    }

    function updateFromTimeline(playhead, { playing, recording, scrubbing }) {
        const ph = +playhead || 0;
        const active = !!(playing || recording);
        const backwards = ph < state.lastPlayhead - 1e-6;

        if (scrubbing || backwards) {
            if (state._playing) _stopSource();
            state.lastPlayhead = ph;
            return;
        }
        if (!active) {
            if (state._playing) _stopSource();
            state.lastPlayhead = ph;
            return;
        }

        const c = _findActiveClip(ph);
        if (!c || !c.buffer) {
            if (state._playing) _stopSource();
            state.lastPlayhead = ph;
            return;
        }

        const expectedOffset = ph - (+c.t || 0);
        const inRange = expectedOffset >= 0 && expectedOffset <= c.buffer.duration + 1e-6;
        if (!inRange) {
            if (state._playing) _stopSource();
            state.lastPlayhead = ph;
            return;
        }

        _resume();

        if (!state._playing || state._clipId !== c.id) {
            _startAtOffset(c, expectedOffset);
            state.lastPlayhead = ph;
            return;
        }

        const audioPos = state._offset + (ac.currentTime - state._ctxStart);
        const drift = audioPos - expectedOffset;
        if (Math.abs(drift) > 0.03) {
            _startAtOffset(c, expectedOffset);
        }

        state.lastPlayhead = ph;
    }

    function getProjectData() {
        return {
            clips: clips.map(c => {
                const audio =
                    (c.sourceType === "external" && c.url)
                        ? ({ type: "external", url: String(c.url) })
                        : (c.bytes && c.bytes.byteLength)
                            ? ({ type: "embedded", mime: String(c.mime || "audio/mpeg"), b64: _abToB64(c.bytes) })
                            : ({ type: "none" });
                return { id: String(c.id), name: String(c.name || ""), t: (Number.isFinite(+c.t) ? (+c.t) : null), enabled: !!c.enabled, audio };
            }),
        };
    }

    async function loadProjectData(v) {
        clear();
        if (!v || typeof v !== "object") return;
        const list = Array.isArray(v.clips) ? v.clips : [];
        if (!list.length) return;

        _ensureAudio();
        await _resume();

        for (const item of list) {
            const tRaw = item?.t;
            const t = Number.isFinite(+tRaw) ? Math.max(0, +tRaw) : NaN;
            const enabled = !!item?.enabled && Number.isFinite(t);
            const nm = String(item?.name || "foley");
            const id = String(item?.id || _genId());
            const audio = item?.audio;

            if (audio?.type === "external" && audio.url) {
                const clip = { id, name: nm, t, enabled, sourceType: "external", url: String(audio.url), mime: "audio/mpeg", bytes: null, buffer: null };
                clips.push(clip);
                try {
                    const r = await fetch(clip.url, { cache: "no-store" });
                    if (!r.ok) throw new Error(String(r.status));
                    const ab = await r.arrayBuffer();
                    clip.buffer = await (window.decodeAudioCompat ? window.decodeAudioCompat(ac, ab) : (window.decodeAudioCompat ? window.decodeAudioCompat(ac, ab) : ac.decodeAudioData(ab.slice(0))));
                } catch (err) {
                    console.warn("Failed to load external foley clip:", clip.url, err);
                }
                continue;
            }

            if (audio?.type === "embedded" && audio.b64) {
                const ab = _b64ToAb(String(audio.b64 || ""));
                let buf = null;
                try { buf = await (window.decodeAudioCompat ? window.decodeAudioCompat(ac, ab) : (window.decodeAudioCompat ? window.decodeAudioCompat(ac, ab) : ac.decodeAudioData(ab.slice(0)))); } catch (err) { console.error("decodeAudioData (foley project) failed:", err); buf = null; }
                const clip = { id, name: nm, t, enabled, sourceType: "embedded", mime: String(audio.mime || "audio/mpeg"), bytes: ab.slice(0), buffer: buf };
                clips.push(clip);
                continue;
            }
        }

        clips.sort((a, b) => {
            const ta = Number.isFinite(+a.t) ? +a.t : 1e15;
            const tb = Number.isFinite(+b.t) ? +b.t : 1e15;
            return ta - tb;
        });
    }

    return { state, clips, pickFilesToLibrary, addExternalAt, addExternalToLibrary, placeClipAt, clear, removeLastPlaced, clearPlaced, clearLibrary, stop, previewClip, previewExternal, updateFromTimeline, getProjectData, loadProjectData };
})();


// --- Mouth texture replacement ---
// We ONLY swap the specific embedded face texture "264.TMAP" (and ONLY the material slots that reference that texture).
// All other textures must remain untouched.
const mouth = (() => {
    /** @type {Array<{mat:any, slot:string}>} */
    const targets = [];
    /** @type {Record<string, THREE.Texture>} */
    const tex = {};
    let ready = false;
    let currentKey = "";

    /** @type {THREE.Texture|null} */
    let faceTex = null;

    // Remember the original texture per target so we can restore when no audio is playing.
    let swapFps = 20;
    let thrF = 0.030, thrE = 0.080, thrA = 0.160;
    let _lastSwapMs = 0;

    // Try a few common filenames (so you can name them flexibly inside ./mouth_greg/)
    const CANDIDATES = {
        "A": ["A.png", "a.png", "mouth_A.png"],
        // Prefer underscore variant first to avoid noisy 404s (your set: E_Oo.png)
        "E": ["E_Oo.png", "E+Oo.png", "E_OO.png", "EOo.png", "e_oo.png", "mouth_EOo.png"],
        // Your set uses "FVMbp.png" (no plus signs) – try that first to avoid noisy 404s.
        "F": ["FVMbp.png", "F+V+M+B+P.png", "F_V_M_B_P.png", "F.png", "mouth_F.png"],
        "U": ["U.png", "u.png", "mouth_U.png"],
    };

    async function _resolveFaceTextureFromGLTF(gltf) {
        try {
            const parser = gltf?.parser;
            const json = parser?.json;
            if (!parser || !json) return null;

            const images = json.images || [];
            const textures = json.textures || [];

            const needle = "264.tmap";

            // 1) Find image index whose name/uri contains "264.TMAP"
            let imgIndex = -1;
            for (let i = 0; i < images.length; i++) {
                const im = images[i] || {};
                const s = String(im.name || im.uri || "").toLowerCase();
                if (s.includes(needle)) {
                    imgIndex = i;
                    break;
                }
            }
            if (imgIndex < 0) return null;

            // 2) Find texture index that references that image
            let texIndex = -1;
            for (let i = 0; i < textures.length; i++) {
                const tj = textures[i] || {};
                if (tj.source === imgIndex) {
                    texIndex = i;
                    // prefer named textures that also contain needle
                    const nm = String(tj.name || "").toLowerCase();
                    if (!nm || nm.includes(needle)) break;
                }
            }
            if (texIndex < 0) return null;

            // 3) Resolve into THREE.Texture (dependency is async)
            const t = await parser.getDependency("texture", texIndex);
            if (t) {
                // ensure it has a name for debugging
                if (!t.name) t.name = "264.TMAP";
            }
            return t || null;
        } catch (err) {
            console.warn("resolveFaceTextureFromGLTF failed:", err);
            return null;
        }
    }

    async function findTargets(root, gltf) {
        targets.length = 0;
        if (!root) return;

        // Resolve the exact texture object that came from the embedded 264.TMAP image.
        faceTex = await _resolveFaceTextureFromGLTF(gltf);

        if (!faceTex) {
            console.warn("Face texture '264.TMAP' not found via GLTF metadata; will NOT swap any textures.");
            return;
        }

        const SLOTS = ["map", "emissiveMap", "alphaMap"]; // keep minimal to avoid accidental swaps

        root.traverse((o) => {
            if (!o.isMesh) return;
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of mats) {
                if (!m) continue;
                for (const slot of SLOTS) {
                    if (m[slot] && m[slot] === faceTex) {
                        targets.push({ mat: m, slot, orig: m[slot] });
                    }
                }
            }
        });

        if (!targets.length) {
            console.warn("Face texture resolved, but no material slot references it (nothing to swap).");
        }
    }

    async function _loadFirstExisting(paths) {
        const loader = new THREE.TextureLoader();
        for (const p of paths) {
            try {
                const t = await new Promise((res, rej) => loader.load(`./mouth_greg/${p}`, res, undefined, rej));
                // glTF texture conventions
                t.colorSpace = THREE.SRGBColorSpace;
                t.flipY = false;
                t.anisotropy = 4;
                t.needsUpdate = true;
                return t;
            } catch { }
        }
        return null;
    }

    async function loadAll() {
        tex.A = await _loadFirstExisting(CANDIDATES.A);
        tex.E = await _loadFirstExisting(CANDIDATES.E);
        tex.F = await _loadFirstExisting(CANDIDATES.F);
        tex.U = await _loadFirstExisting(CANDIDATES.U);
        ready = !!(tex.A && tex.E && tex.F && tex.U);
        if (!ready) {
            console.warn("Not all mouth textures could be loaded from ./mouth_greg/. Check filenames.");
        }
    }

    function restore() {
        if (!targets.length) return;
        for (const trg of targets) {
            if (trg.orig) trg.mat[trg.slot] = trg.orig;
            else if (faceTex) trg.mat[trg.slot] = faceTex;
            trg.mat.needsUpdate = true;
        }
        currentKey = "";
    }

    function setParams(p) {
        if (!p) return;
        if (typeof p.fps === 'number') swapFps = Math.max(1, Math.min(60, Math.round(p.fps)));
        if (typeof p.thrF === 'number') thrF = Math.max(0, Math.min(0.5, p.thrF));
        if (typeof p.thrE === 'number') thrE = Math.max(0, Math.min(0.5, p.thrE));
        if (typeof p.thrA === 'number') thrA = Math.max(0, Math.min(0.5, p.thrA));
        const arr = [thrF, thrE, thrA].sort((a, b) => a - b);
        thrF = arr[0]; thrE = arr[1]; thrA = arr[2];
    }

    function set(key) {
        if (!ready || !targets.length) return;
        if (key === currentKey) return;
        const t = tex[key];
        if (!t) return;

        for (const trg of targets) {
            trg.mat[trg.slot] = t;
            trg.mat.needsUpdate = true;
        }
        currentKey = key;
    }

    function applyRms(rms, audioPlaying) {
        if (!ready || !targets.length) return;
        if (!audioPlaying) {
            restore();
            return;
        }
        let k = "U";
        if (rms >= thrA) k = "A";
        else if (rms >= thrE) k = "E";
        else if (rms >= thrF) k = "F";
        else k = "U";
        set(k);
    }

    function update(rms, nowMs, audioPlaying) {
        if (!ready || !targets.length) return;
        // Restore original face texture when no audio is playing.
        if (!audioPlaying) {
            restore();
            return;
        }
        const minDt = 1000 / Math.max(1, swapFps || 5);
        if (nowMs != null) {
            if ((nowMs - _lastSwapMs) < minDt) return;
            _lastSwapMs = nowMs;
        }
        applyRms(rms, audioPlaying);
    }

    return {
        findTargets,
        loadAll,
        set,
        restore,
        setParams,
        applyRms,
        update,
        get ready() { return ready; },
        get targetCount() { return targets.length; }
    };
})();


function updateActorBBox() {
    actorBBox.setFromObject(getActiveActor());
    // If model hasn't loaded yet, Box3 may be empty
    if (!isFinite(actorBBox.min.x) || !isFinite(actorBBox.max.x)) {
        actorBBox.min.set(0, 0, 0);
        actorBBox.max.set(0, 0, 0);
    }
    getActiveActor().userData.bbox = actorBBox.clone();
}
function updateCharReadout() {
    updateActorBBox();
    const p = getActiveActor().position;
    const r = getActiveActor().rotation;
    const s = getActiveActor().scale;
    const size = new THREE.Vector3();
    actorBBox.getSize(size);

    if (ui.charPos) ui.charPos.textContent = `${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)}`;
    if (ui.charRot) ui.charRot.textContent = `${THREE.MathUtils.radToDeg(r.x).toFixed(2)}°, ${THREE.MathUtils.radToDeg(r.y).toFixed(2)}°, ${THREE.MathUtils.radToDeg(r.z).toFixed(2)}°`;
    if (ui.charScale) ui.charScale.textContent = `${s.x.toFixed(3)}, ${s.y.toFixed(3)}, ${s.z.toFixed(3)}`;
    if (ui.charSize) ui.charSize.textContent = `${size.x.toFixed(3)} × ${size.y.toFixed(3)} × ${size.z.toFixed(3)}`;
}



// Load GLB
const gltfLoader = new GLTFLoader();
function loadCharacterFromArrayBuffer(arrayBuffer, { fileName = "character.glb" } = {}) {
    return new Promise((resolve, reject) => {
        try {
            const resourcePath = (() => {
                try {
                    const safeName = String(fileName || "character.glb");
                    const slash = Math.max(safeName.lastIndexOf('/'), safeName.lastIndexOf('\\'));
                    if (slash >= 0) return safeName.slice(0, slash + 1);
                } catch { }
                return './';
            })();
            gltfLoader.parse(arrayBuffer, resourcePath, resolve, reject);
        } catch (err) {
            reject(err);
        }
    });
}
gltfLoader.load(
    "./gregory.animation.glb",
    (gltf) => {
        const root = gltf.scene || gltf.scenes?.[0];
        if (!root) return;

        // Remove previous children (if any) and add model
        while (actor.children.length) actor.remove(actor.children[0]);
        actor.add(root);

        // Ensure matrices update normally and build pickable mesh list for raycasting
        pickables = [];
        root.traverse((o) => {
            // Some GLBs ship with matrixAutoUpdate disabled; enable it so raycasting matches visuals.
            o.userData = o.userData || {};
            o.userData.characterId = gregoryCharacter.id;
            o.userData.characterRuntimeUid = gregoryCharacter.runtimeUid;
            o.matrixAutoUpdate = true;
            if (o.isMesh) {
                // Keep a direct list of meshes for reliable picking (SkinnedMesh included)
                pickables.push(o);
                // Make sure bounds exist (helps some loaders/models)
                if (o.geometry) {
                    if (!o.geometry.boundingSphere) { try { o.geometry.computeBoundingSphere(); } catch { } }
                    if (!o.geometry.boundingBox) { try { o.geometry.computeBoundingBox(); } catch { } }
                }
            }
        });
        root.updateMatrixWorld(true);
        gregoryCharacter.pickables = pickables.slice();


        // Setup animations (if present)
        anim.root = root;
        anim.clips = (gltf.animations || []).slice();
        anim.actions.clear();

        // Always create a mixer so we can also drive a synthetic "rest pose" action for cross-fades.
        anim.mixer = new THREE.AnimationMixer(root);

        // Build synthetic REST pose (bind pose) action for smooth transitions to/from "0. none"
        anim.restClip = null;
        anim.restAction = null;
        try {
            const rest = makeRestPoseAction(root, anim.mixer);
            if (rest) {
                anim.restClip = rest.clip;
                anim.restAction = rest.action;
            }
        } catch (e) {
            console.warn("Failed to build rest pose clip", e);
        }

        // Create actions for real clips
        if (anim.clips.length) {
            for (const clip of anim.clips) {
                const a = anim.mixer.clipAction(clip);
                a.enabled = true;
                a.paused = true;   // paused by default (plays only while dragging)
                a.setLoop(THREE.LoopRepeat, Infinity);
                anim.actions.set(_low(clip.name), a);
            }
        }

        // Default to none (rest pose)
        setAnimNone();
        buildAnimMenuItems();
        gregoryCharacter.animState = _copyAnimState(anim);
        setActiveCharacter(gregoryCharacter, { refreshMenu: false });
        try { const bb = new THREE.Box3().setFromObject(actor); const sz = new THREE.Vector3(); bb.getSize(sz); if (sz.y > 1e-6) gregoryReferenceHeight = sz.y; gregoryReferenceSize.copy(sz); } catch { }

        // --- Init mouth texture swap targets + load expression textures ---
        (async () => {
            try {
                // Avoid repeated 404s when mouth sprite assets are not shipped.
                // Some servers return 200 for directory HEADs; probe for at least one real file.
                const _exists = async (u) => {
                    try { const r = await fetch(u, { method: "HEAD", cache: "no-store" }); return !!r && r.ok; } catch (_e) { return false; }
                };
                let mouthAssetsOk = false;
                // Try a few common filenames; your set uses E_Oo.png.
                const probes = [
                    "./mouth_greg/E_Oo.png",
                    "./mouth_greg/E+Oo.png",
                    "./mouth_greg/E_OO.png",
                    "./mouth_greg/EOo.png",
                    // Your shipped file is typically FVMbp.png
                    "./mouth_greg/FVMbp.png",
                    "./mouth_greg/F+V+M+B+P.png",
                    "./mouth_greg/A.png",
                    "./mouth_greg/U.png",
                ];
                for (const p of probes) {
                    if (await _exists(p)) { mouthAssetsOk = true; break; }
                }
                if (!mouthAssetsOk) {
                    console.log("Mouth swap disabled (no ./mouth_greg assets found).");
                    return;
                }

                await mouth.findTargets(root, gltf);
                await mouth.loadAll();
                // No audio playing initially -> keep original face texture
                mouth.restore();
                console.log("Mouth swap ready. Targets:", mouth.targetCount);
            } catch (e) {
                console.warn("Mouth init failed:", e);
            }
        })();

        // Apply our depth-clipping shader to all meshes
        root.traverse((o) => {
            if (!o.isMesh) return;

            // Keep original materials so embedded textures render correctly.
            const applyDepthClip = (mat) => {
                if (!mat || mat.userData.__depthClipPatched) return mat;
                mat.userData.__depthClipPatched = true;

                // --- Enable soft depth clipping on character ---
                // The soft edge is implemented via alpha fade, so the material must be transparent.
                // We still keep depthWrite ON to avoid incorrect self-sorting ("back foot in front").
                mat.transparent = true;
                mat.opacity = 1.0;
                mat.depthWrite = true;
                mat.depthTest = true;

                mat.onBeforeCompile = (shader) => {
                    // Share the SAME uniforms/values as cubeMat so everything lines up (scale/offset/cover/rot/flips).
                    shader.uniforms.uDepth = { value: depthTex };
                    shader.uniforms.uScreenPx = { value: screenPx };
                    shader.uniforms.uCover = { value: cover };

                    shader.uniforms.uScale = { value: cubeMat.uniforms.uScale.value };
                    shader.uniforms.uOffset = { value: cubeMat.uniforms.uOffset.value };
                    shader.uniforms.uFlip = { value: cubeMat.uniforms.uFlip.value };
                    shader.uniforms.uRot = { value: cubeMat.uniforms.uRot.value };

                    shader.uniforms.uNear = { value: cubeMat.uniforms.uNear.value };
                    shader.uniforms.uFar = { value: cubeMat.uniforms.uFar.value };

                    shader.uniforms.uBias = { value: cubeMat.uniforms.uBias.value };
                    shader.uniforms.uClipSoft = { value: cubeMat.uniforms.uClipSoft.value };

                    shader.uniforms.uDfRadius = { value: cubeMat.uniforms.uDfRadius.value };
                    shader.uniforms.uDfEdge = { value: cubeMat.uniforms.uDfEdge.value };

                    // Keep a handle so we can update scalar uniforms each frame.
                    mat.userData.__dcUniforms = shader.uniforms;

                    shader.fragmentShader =
                        `uniform sampler2D uDepth;\n` +
                        `uniform vec2 uScreenPx;\n` +
                        `uniform vec4 uCover;\n` +
                        `uniform vec2 uScale;\n` +
                        `uniform vec2 uOffset;\n` +
                        `uniform vec2 uFlip;\n` +
                        `uniform float uRot;\n` +
                        `uniform float uNear;\n` +
                        `uniform float uFar;\n` +
                        `uniform float uBias;\n` +
                        `uniform float uClipSoft;\n` +
                        `uniform float uDfRadius;\n` +
                        `uniform float uDfEdge;\n` +
                        shader.fragmentShader;

                    // Helper functions (same as cubeMat)
                    const helpers = `
float linearizeDepth01(float depthNdc01, float near, float far){
  float z = depthNdc01 * 2.0 - 1.0;
  float viewZ = (2.0 * near * far) / (far + near - z * (far - near));
  return clamp((viewZ - near) / (far - near), 0.0, 1.0);
}

vec2 rotate90(vec2 uv, float r){
  if (r < 0.5) return uv;
  if (r < 1.5) return vec2(uv.y, 1.0 - uv.x);
  if (r < 2.5) return vec2(1.0 - uv.x, 1.0 - uv.y);
  return vec2(1.0 - uv.y, uv.x);
}

// Depth texture is pre-decoded: linear depth01 is stored in uDepth.r (0..1)
float bgDepthAtScreenUV(vec2 suv){
  vec2 uv = suv;
  uv = rotate90(uv, uRot);
  if (uFlip.x > 0.5) uv.x = 1.0 - uv.x;
  if (uFlip.y > 0.5) uv.y = 1.0 - uv.y;
  uv = uv * uScale + uOffset;
  uv = uv * uCover.xy + uCover.zw;
  uv = clamp(uv, vec2(0.0), vec2(1.0));
  return texture2D(uDepth, uv).r;
}

float bgDepthFiltered(vec2 suv){
  float resultDepth = bgDepthAtScreenUV(suv);
  if (uDfRadius <= 0.001) return resultDepth;

  vec2 texel = 1.0 / uScreenPx;
  float centerD = bgDepthAtScreenUV(suv);

  float sigmaS = max(uDfRadius * 0.75, 0.001);
  float sigmaD = max(uDfEdge, 0.0005);

  float sumW = 0.0;
  float sumD = 0.0;

  for (int y=-3; y<=3; y++){
    for (int x=-3; x<=3; x++){
      vec2 o = vec2(float(x), float(y));
      float r = length(o);
      if (r > uDfRadius) continue;

      vec2 p = suv + o * texel;
      float d = bgDepthAtScreenUV(p);

      float ws = exp(-(r*r) / (2.0*sigmaS*sigmaS));
      float dd = d - centerD;
      float wd = exp(-(dd*dd) / (2.0*sigmaD*sigmaD));

      float w = ws * wd;
      sumW += w;
      sumD += w * d;
    }
  }
  resultDepth = sumD / max(sumW, 1e-6);
  return resultDepth;
}
`;

                    // Inject helpers near the start of main (right after common includes)
                    shader.fragmentShader = shader.fragmentShader.replace(
                        '#include <common>',
                        '#include <common>\n' + helpers
                    );

                    // Insert depth-clip right before dithering (end of fragment shader)
                    shader.fragmentShader = shader.fragmentShader.replace(
                        '#include <dithering_fragment>',
                        `// --- Depth clip (same logic as cubeMat) ---\n` +
                        `vec2 _dcSuv = gl_FragCoord.xy / uScreenPx;\n` +
                        `float _bgDepth01 = bgDepthFiltered(_dcSuv);\n` +
                        `float _fragDepth01 = linearizeDepth01(gl_FragCoord.z, uNear, uFar);\n` +
                        `float _d = (_bgDepth01 + uBias) - _fragDepth01;\n` +
                        `float _a = 1.0;\n` +
                        `if (uClipSoft > 0.00001){\n` +
                        `  if (_d < -uClipSoft) discard;\n` +
                        `  _a = smoothstep(-uClipSoft, 0.0, _d);\n` +
                        `} else {\n` +
                        `  if (_d < 0.0) discard;\n` +
                        `}\n` +
                        `gl_FragColor.a *= _a;\n` +
                        `#include <dithering_fragment>`
                    );
                };

                // If the material is already compiled, this forces a recompile.
                mat.needsUpdate = true;
                return mat;
            };

            if (Array.isArray(o.material)) {
                o.material = o.material.map(applyDepthClip);
            } else {
                o.material = applyDepthClip(o.material);
            }

            o.castShadow = false;
            o.receiveShadow = false;
        });
        updateActorBBox();
    },
    undefined,
    (err) => {
        console.warn("Failed to load gregory.animation.glb", err);
    }
);


const grid = new THREE.GridHelper(120, 120, 0xffffff, 0xffffff);
// 3D grid (perspective + depth): stays in world space and gets occluded by the character
grid.material.opacity = 0.45;
grid.material.transparent = true;
// IMPORTANT: keep depthTest ON so the grid looks 3D (not like a 2D HUD overlay)
grid.material.depthTest = true;
grid.material.depthWrite = false;
grid.position.y = 0;
grid.visible = false; // default OFF (controlled by sidebar toggle)
scene3d.add(grid);

// ---------- Shadow + Overlay (unchanged setup from working version) ----------
const shadowScene = new THREE.Scene();
const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

const shadowMat = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
        uDepth: { value: depthTex },
        uCover: { value: cover },
        uScale: { value: new THREE.Vector2(1, 1) },
        uOffset: { value: new THREE.Vector2(0, 0) },
        uFlip: { value: new THREE.Vector2(0, 0) },
        uRot: { value: 0.0 },

        uScreenPx: { value: screenPx },
        uDfRadius: { value: 2.1 },
        uDfEdge: { value: 0.051 },

        uCenterUV: { value: new THREE.Vector2(0.5, 0.5) },
        uCenterDepth01: { value: 0.5 },
        uStrength: { value: 0.35 },
        uRadius: { value: 0.11 },
        uSoftness: { value: 0.06 },
        uOffsetUV: { value: new THREE.Vector2(0.0, 0.05) },
        uBias: { value: 0.002 },
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy,0.0,1.0); }`,
    fragmentShader: `
        uniform sampler2D uDepth;
        uniform vec4 uCover;
        uniform vec2 uScale;
        uniform vec2 uOffset;
        uniform vec2 uFlip;
        uniform float uRot;

        uniform vec2 uScreenPx;
        uniform float uDfRadius;
        uniform float uDfEdge;

        uniform vec2 uCenterUV;
        uniform float uCenterDepth01;
        uniform float uStrength;
        uniform float uRadius;
        uniform float uSoftness;
        uniform vec2 uOffsetUV;
        uniform float uBias;

        varying vec2 vUv;

        vec2 rotate90(vec2 uv, float r){
          if (r < 0.5) return uv;
          if (r < 1.5) return vec2(uv.y, 1.0 - uv.x);
          if (r < 2.5) return vec2(1.0 - uv.x, 1.0 - uv.y);
          return vec2(1.0 - uv.y, uv.x);
        }

        float blob(vec2 p, vec2 c, float radius, float softness){
          float dist = length(p - c);
          float edge0 = radius;
          float edge1 = max(radius - softness, 0.00001);
          return 1.0 - smoothstep(edge1, edge0, dist);
        }
        // Depth texture is pre-decoded: depth01 is stored in uDepth.r (0..1)
        float bgDepthAtScreenUV(vec2 suv){
          vec2 uv = suv;
          uv = rotate90(uv, uRot);
          if (uFlip.x > 0.5) uv.x = 1.0 - uv.x;
          if (uFlip.y > 0.5) uv.y = 1.0 - uv.y;
          uv = uv * uScale + uOffset;
          uv = uv * uCover.xy + uCover.zw;

          uv = clamp(uv, vec2(0.0), vec2(1.0));

          float depth01 = texture2D(uDepth, uv).r;
          return depth01;
        }

        float bgDepthFiltered(vec2 suv){
          if (uDfRadius <= 0.001) return bgDepthAtScreenUV(suv);

          vec2 texel = 1.0 / uScreenPx;
          float centerD = bgDepthAtScreenUV(suv);

          float sigmaS = max(uDfRadius * 0.75, 0.001);
          float sigmaD = max(uDfEdge, 0.0005);

          float sumW = 0.0;
          float sumD = 0.0;

          for (int y=-3; y<=3; y++){
            for (int x=-3; x<=3; x++){
              vec2 o = vec2(float(x), float(y));
              float r = length(o);
              if (r > uDfRadius) continue;

              vec2 p = suv + o * texel;
              float d = bgDepthAtScreenUV(p);

              float ws = exp(-(r*r) / (2.0*sigmaS*sigmaS));
              float dd = d - centerD;
              float wd = exp(-(dd*dd) / (2.0*sigmaD*sigmaD));

              float w = ws * wd;
              sumW += w;
              sumD += w * d;
            }
          }
          return sumD / max(sumW, 1e-6);
        }

        void main(){
          vec2 uv = vUv;

          vec2 center = uCenterUV + uOffsetUV;
          float a = blob(uv, center, uRadius, uSoftness);
          if (a <= 0.0001) discard;

          float bgDepth01 = bgDepthFiltered(uv);
          if (bgDepth01 + uBias < uCenterDepth01) discard;

          gl_FragColor = vec4(0.0, 0.0, 0.0, uStrength * a);
        }
      `
});

shadowScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), shadowMat));

const overlayScene = new THREE.Scene();
const overlayMat = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
        uDepth: { value: depthTex },
        uAlpha: { value: 0.0 },
        uCover: { value: cover },
        uScale: { value: new THREE.Vector2(1, 1) },
        uOffset: { value: new THREE.Vector2(0, 0) },
        uFlip: { value: new THREE.Vector2(0, 0) },
        uRot: { value: 0.0 },
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0);} `,
    fragmentShader: `
        uniform sampler2D uDepth;
        uniform float uAlpha;
        uniform vec4 uCover;
        uniform vec2 uScale;
        uniform vec2 uOffset;
        uniform vec2 uFlip;
        uniform float uRot;
        varying vec2 vUv;

        vec2 rotate90(vec2 uv, float r){
          if (r < 0.5) return uv;
          if (r < 1.5) return vec2(uv.y, 1.0 - uv.x);
          if (r < 2.5) return vec2(1.0 - uv.x, 1.0 - uv.y);
          return vec2(1.0 - uv.y, uv.x);
        }

        void main(){
          vec2 uv = vUv;
          uv = rotate90(uv, uRot);
          if (uFlip.x > 0.5) uv.x = 1.0 - uv.x;
          if (uFlip.y > 0.5) uv.y = 1.0 - uv.y;
          uv = uv * uScale + uOffset;
          uv = uv * uCover.xy + uCover.zw;

          vec3 col = texture2D(uDepth, uv).rgb;
          gl_FragColor = vec4(col, uAlpha);
        }
      `
});
overlayScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), overlayMat));


// ---------- Timeline (5 fps keyframes, smooth interpolation, full-FPS playback) ----------
const transport = {
    rewBtn: document.getElementById("rewBtn"),
    playBtn: document.getElementById("playBtn"),
    recBtn: document.getElementById("recBtn"),
    renderExportBtn: document.getElementById("renderExportBtn"),
    exportBtn: document.getElementById("exportBtn"),
    importBtn: document.getElementById("importBtn"),
    appendBtn: document.getElementById("appendBtn"),
    importCharBtn: document.getElementById("importCharBtn"),
    importFlatplateBtn: document.getElementById("importFlatplateBtn"),
    backgroundBtn: document.getElementById("backgroundBtn"),
    onionSkinBtn: document.getElementById("onionSkinBtn"),
    shortcutMenuBtn: document.getElementById("shortcutMenuBtn"),
    charFile: document.getElementById("charFile"),
    flatplateFile: document.getElementById("flatplateFile"),
    projFile: document.getElementById("projFile"),
    recLamp: document.getElementById("recLamp"),
    timeSlider: document.getElementById("timeSlider"),
    timeReadout: document.getElementById("timeReadout"),
    sceneReadout: document.getElementById("sceneReadout"),
    sceneStartBtn: document.getElementById("sceneStartBtn"),
    scenePrevBtn: document.getElementById("scenePrevBtn"),
    sceneNextBtn: document.getElementById("sceneNextBtn"),
    sceneEndBtn: document.getElementById("sceneEndBtn"),
    sceneSlider: document.getElementById("sceneSlider"),
    takeManagerBtn: document.getElementById("takeManagerBtn"),
    timelineFoldBtn: document.getElementById("timelineFoldBtn"),
};


function setTimelineCompactMode(compact) {
    document.body.classList.toggle("timeline-compact", !!compact);
    if (transport.timelineFoldBtn) {
        transport.timelineFoldBtn.textContent = compact ? "▸" : "◂";
        transport.timelineFoldBtn.title = compact ? "Timeline nach rechts ausklappen" : "Timeline nach rechts einklappen";
        transport.timelineFoldBtn.setAttribute("aria-expanded", compact ? "false" : "true");
    }
}

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

const takeUI = {
    wrap: document.getElementById("takeManagerWrap"),
    header: document.getElementById("takeManagerHeader"),
    close: document.getElementById("takeManagerClose"),
    sceneMeta: document.getElementById("takeManagerSceneMeta"),
    takeSelect: document.getElementById("takeSelect"),
    takeNameInput: document.getElementById("takeNameInput"),
    stars: document.getElementById("takeStars"),
    addBtn: document.getElementById("takeAddBtn"),
    duplicateBtn: document.getElementById("takeDuplicateBtn"),
    deleteBtn: document.getElementById("takeDeleteBtn"),
    summary: document.getElementById("takeSummary"),
};

function _defaultTakeLabel(index) {
    return `${tr('Take')} ${index + 1}`;
}

function _cloneTakeClipCharacter(ch, sceneStart, sceneEnd) {
    const eps = 1e-6;
    const keys = _dedupeAndSortKeys(Array.isArray(ch?.keys) ? ch.keys : [])
        .filter(k => _num(k?.t, 0) >= sceneStart - eps && _num(k?.t, 0) <= sceneEnd + eps)
        .map(k => {
            const c = _cloneKeyframe(k);
            c.t = _clamp(_num(c.t, 0) - sceneStart, 0, Math.max(0, sceneEnd - sceneStart));
            return c;
        });
    return {
        characterId: ch?.id || null,
        runtimeUid: ch?.runtimeUid || null,
        name: ch?.name || null,
        keys,
    };
}

function _cloneTakeClipData(data = []) {
    return (Array.isArray(data) ? data : []).map(item => ({
        characterId: item?.characterId || null,
        runtimeUid: item?.runtimeUid || null,
        name: item?.name || null,
        keys: _dedupeAndSortKeys(Array.isArray(item?.keys) ? item.keys : []).map(_cloneKeyframe),
    }));
}

function _captureSceneDataForTake(sceneIndex) {
    const segments = getSceneBoundaries();
    const seg = segments[Math.max(0, Math.min(segments.length - 1, sceneIndex | 0))] || { start: 0, end: 0 };
    return characters.map(ch => _cloneTakeClipCharacter(ch, seg.start, seg.end));
}

function _findTakeClipForCharacter(take, ch) {
    const clips = Array.isArray(take?.clipData) ? take.clipData : [];
    return clips.find(item =>
        (item?.characterId && ch?.id && item.characterId === ch.id) ||
        (item?.runtimeUid && ch?.runtimeUid && item.runtimeUid === ch.runtimeUid) ||
        (item?.name && ch?.name && item.name === ch.name)
    ) || null;
}

function _captureSceneBackgroundEntry(sceneIndex) {
    const segments = getSceneBoundaries();
    const seg = segments[Math.max(0, Math.min(segments.length - 1, sceneIndex | 0))] || { start: 0 };
    return _cloneBackgroundEntry(_getBackgroundEntryAtTime(seg.start) || backgroundState.currentSelection || _makeDefaultBackgroundEntry());
}

function _storeCurrentSceneIntoTake(sceneIndex, take) {
    if (!take) return;
    take.clipData = _captureSceneDataForTake(sceneIndex);
    take.backgroundEntry = _captureSceneBackgroundEntry(sceneIndex);
}

function _makeEmptyTakeClipData() {
    return characters.map(ch => ({
        characterId: ch?.id || null,
        runtimeUid: ch?.runtimeUid || null,
        name: ch?.name || null,
        keys: [],
    }));
}

function _refreshTakeOptionLabel(sceneIndex, takeIndex) {
    if (!takeUI.takeSelect) return;
    const scene = _ensureSceneTakeData(sceneIndex);
    const take = scene.takes[takeIndex] || null;
    const opt = takeUI.takeSelect.options[takeIndex] || null;
    if (!take || !opt) return;
    const stars = take.rating ? ` ${'★'.repeat(take.rating)}` : '';
    opt.textContent = `${takeIndex + 1}. ${take.name}${stars}`;
}

function _refreshTakeSummary(sceneIndex) {
    if (!takeUI.summary) return;
    const scene = _ensureSceneTakeData(sceneIndex);
    const take = scene.takes[scene.selectedTakeIndex] || scene.takes[0] || null;
    const keyCount = Array.isArray(take?.clipData)
        ? take.clipData.reduce((sum, clip) => sum + ((clip?.keys && clip.keys.length) || 0), 0)
        : 0;
    const bgLabel = _getBackgroundDisplayLabel(take?.backgroundEntry || _captureSceneBackgroundEntry(sceneIndex));
    takeUI.summary.textContent = take
        ? `Enabled: ${take.name} · ${bgLabel} · ${keyCount} keyframes in this camera setup`
        : 'No takes for this camera setup';
}

function _commitActiveTakeFromTimeline() {
    if (takeManagerState.applying) return;
    const sceneIndex = Math.round(Number(takeManagerState.activeSceneIndex));
    if (!Number.isFinite(sceneIndex) || sceneIndex < 0) return;
    const scene = _ensureSceneTakeData(sceneIndex);
    const take = scene.takes.find(item => item?.id === takeManagerState.activeTakeId) || scene.takes[scene.selectedTakeIndex] || scene.takes[0] || null;
    if (!take) return;
    _storeCurrentSceneIntoTake(sceneIndex, take);
}

function _applyTakeToScene(sceneIndex, take, { refresh = true } = {}) {
    if (!take || takeManagerState.applying) return;
    const segments = getSceneBoundaries();
    const seg = segments[Math.max(0, Math.min(segments.length - 1, sceneIndex | 0))] || null;
    if (!seg) return;
    const eps = 1e-6;
    takeManagerState.applying = true;
    try {
        for (const ch of characters) {
            const before = _dedupeAndSortKeys(Array.isArray(ch?.keys) ? ch.keys : []).filter(k => _num(k?.t, 0) < seg.start - eps);
            const after = _dedupeAndSortKeys(Array.isArray(ch?.keys) ? ch.keys : []).filter(k => _num(k?.t, 0) > seg.end + eps);
            const clip = _findTakeClipForCharacter(take, ch);
            const mid = clip ? _dedupeAndSortKeys(Array.isArray(clip.keys) ? clip.keys : []).map(k => {
                const c = _cloneKeyframe(k);
                c.t = _clamp(seg.start + _num(c.t, 0), seg.start, seg.end);
                return c;
            }) : [];
            ch.keys = _dedupeAndSortKeys(before.concat(mid, after));
            _updateCharacterDuration(ch);
        }
        const takeBackgroundEntry = _cloneBackgroundEntry(take?.backgroundEntry || _captureSceneBackgroundEntry(sceneIndex) || backgroundState.currentSelection || _makeDefaultBackgroundEntry());
        if (takeBackgroundEntry) {
            upsertBackgroundKeyAt(seg.start, takeBackgroundEntry);
            if (sceneIndex === 0) backgroundState.currentSelection = _cloneBackgroundEntry(takeBackgroundEntry);
            timeline._bgAppliedSignature = null;
        }
        timeline.duration = getProjectDuration();
        timeline.playhead = _clamp(timeline.playhead, 0, Math.max(0, timeline.duration));
        applyTimelineAt(timeline.playhead);
    } finally {
        takeManagerState.applying = false;
    }
    if (refresh) syncTransportUI();
}

function _ensureSceneTakeData(sceneIndex) {
    const segments = getSceneBoundaries();
    const safeIndex = Math.max(0, Math.min(Math.max(segments.length - 1, 0), Math.round(Number(sceneIndex) || 0)));
    while (takeManagerState.scenes.length <= safeIndex) {
        const nextSceneIndex = takeManagerState.scenes.length;
        takeManagerState.scenes.push({
            takes: [{
                id: `scene_${nextSceneIndex + 1}_take_1`,
                name: _defaultTakeLabel(0),
                rating: 0,
                clipData: _captureSceneDataForTake(nextSceneIndex),
                backgroundEntry: _captureSceneBackgroundEntry(nextSceneIndex),
            }],
            selectedTakeIndex: 0,
        });
    }
    const scene = takeManagerState.scenes[safeIndex];
    if (!Array.isArray(scene.takes) || !scene.takes.length) {
        scene.takes = [{
            id: `scene_${safeIndex + 1}_take_1`,
            name: _defaultTakeLabel(0),
            rating: 0,
            clipData: _captureSceneDataForTake(safeIndex),
            backgroundEntry: _captureSceneBackgroundEntry(safeIndex),
        }];
    }
    scene.takes = scene.takes.map((take, takeIndex) => ({
        id: String(take?.id || `scene_${safeIndex + 1}_take_${takeIndex + 1}`),
        name: String((take?.name ?? '').toString().trim() || _defaultTakeLabel(takeIndex)),
        rating: Math.max(0, Math.min(5, Math.round(Number(take?.rating) || 0))),
        clipData: Array.isArray(take?.clipData) ? _cloneTakeClipData(take.clipData) : _captureSceneDataForTake(safeIndex),
        backgroundEntry: _cloneBackgroundEntry(take?.backgroundEntry) || _captureSceneBackgroundEntry(safeIndex),
    }));
    scene.selectedTakeIndex = Math.max(0, Math.min(scene.takes.length - 1, Math.round(Number(scene.selectedTakeIndex) || 0)));
    return scene;
}

function _trimTakeManagerToSceneCount() {
    const segments = getSceneBoundaries();
    const count = Math.max(1, segments.length || 1);
    while (takeManagerState.scenes.length > count) takeManagerState.scenes.pop();
    for (let i = 0; i < count; i++) _ensureSceneTakeData(i);
}

function _getCurrentTakeSceneIndex() {
    const seg = getCurrentSceneSegment();
    return Math.max(0, Math.round(Number(seg?.index) || 0));
}

function _getCurrentTakeSceneData() {
    return _ensureSceneTakeData(_getCurrentTakeSceneIndex());
}

function _getCurrentTake() {
    const scene = _getCurrentTakeSceneData();
    return scene.takes[scene.selectedTakeIndex] || scene.takes[0] || null;
}

function setTakeManagerVisible(visible = true) {
    takeManagerState.panelVisible = !!visible;
    if (!takeUI.wrap) return;
    takeUI.wrap.classList.toggle('hidden', !takeManagerState.panelVisible);
    takeUI.wrap.setAttribute('aria-hidden', takeManagerState.panelVisible ? 'false' : 'true');
    if (takeManagerState.panelVisible) _applyTakeManagerPosition();
}

function toggleTakeManager(force) {
    const visible = (typeof force === 'boolean') ? force : !takeManagerState.panelVisible;
    setTakeManagerVisible(visible);
    renderTakeManager();
}

function createTakeForCurrentScene({ duplicate = false } = {}) {
    const sceneIndex = _getCurrentTakeSceneIndex();
    const scene = _ensureSceneTakeData(sceneIndex);
    const currentTake = scene.takes[scene.selectedTakeIndex] || scene.takes[0] || null;
    if (currentTake) _storeCurrentSceneIntoTake(sceneIndex, currentTake);
    const takeIndex = scene.takes.length;
    const baseClip = duplicate && currentTake
        ? _cloneTakeClipData(currentTake.clipData)
        : _makeEmptyTakeClipData();
    const baseBackgroundEntry = duplicate && currentTake
        ? _cloneBackgroundEntry(currentTake.backgroundEntry)
        : _captureSceneBackgroundEntry(sceneIndex);
    const newTake = {
        id: `scene_${sceneIndex + 1}_take_${Date.now()}_${takeIndex + 1}`,
        name: _defaultTakeLabel(takeIndex),
        rating: duplicate && currentTake ? Math.max(0, Math.min(5, Math.round(Number(currentTake.rating) || 0))) : 0,
        clipData: baseClip,
        backgroundEntry: baseBackgroundEntry,
    };
    scene.takes.push(newTake);
    scene.selectedTakeIndex = scene.takes.length - 1;
    takeManagerState.activeSceneIndex = -1;
    takeManagerState.activeTakeId = null;
    _applyTakeToScene(sceneIndex, newTake, { refresh: false });
    setTakeManagerVisible(true);
    renderTakeManager();
    syncTransportUI();
    requestAnimationFrame(() => {
        if (takeUI.takeNameInput) {
            takeUI.takeNameInput.focus();
            takeUI.takeNameInput.select();
        }
    });
}

function deleteCurrentTakeForScene() {
    const sceneIndex = _getCurrentTakeSceneIndex();
    const scene = _ensureSceneTakeData(sceneIndex);
    if (scene.takes.length <= 1) {
        const onlyTake = scene.takes[0];
        if (onlyTake) {
            onlyTake.name = _defaultTakeLabel(0);
            onlyTake.rating = 0;
            onlyTake.clipData = _captureSceneDataForTake(sceneIndex);
            onlyTake.backgroundEntry = _captureSceneBackgroundEntry(sceneIndex);
            scene.selectedTakeIndex = 0;
            takeManagerState.activeSceneIndex = -1;
            takeManagerState.activeTakeId = null;
            _applyTakeToScene(sceneIndex, onlyTake, { refresh: false });
        }
        renderTakeManager();
        syncTransportUI();
        return;
    }
    const idx = Math.max(0, Math.min(scene.takes.length - 1, scene.selectedTakeIndex || 0));
    scene.takes.splice(idx, 1);
    scene.selectedTakeIndex = Math.max(0, Math.min(scene.takes.length - 1, idx));
    const nextTake = scene.takes[scene.selectedTakeIndex] || scene.takes[0] || null;
    takeManagerState.activeSceneIndex = -1;
    takeManagerState.activeTakeId = null;
    if (nextTake) _applyTakeToScene(sceneIndex, nextTake, { refresh: false });
    renderTakeManager();
    syncTransportUI();
}

function _applyTakeManagerSelection(sceneIndex, take, { refresh = true, force = false } = {}) {
    if (!take) return;
    if (!force && takeManagerState.activeSceneIndex === sceneIndex && takeManagerState.activeTakeId === take.id) return;
    _applyTakeToScene(sceneIndex, take, { refresh });
    takeManagerState.activeSceneIndex = sceneIndex;
    takeManagerState.activeTakeId = take.id;
}

function _applySelectedTakeForScene(sceneIndex, { refresh = true, force = false } = {}) {
    const scene = _ensureSceneTakeData(sceneIndex);
    const take = scene.takes[scene.selectedTakeIndex] || scene.takes[0] || null;
    if (!take) return null;
    _applyTakeManagerSelection(Math.max(0, Math.round(Number(sceneIndex) || 0)), take, { refresh, force });
    return take;
}

function _applyTakeManagerPosition() {
    if (!takeUI.wrap) return;
    const rect = takeUI.wrap.getBoundingClientRect();
    const width = rect.width || Math.min(360, window.innerWidth - 24);
    const height = rect.height || 280;
    let left = Number.isFinite(takeManagerState.panelPos?.x) ? takeManagerState.panelPos.x : Math.max(12, window.innerWidth - width - 12);
    let top = Number.isFinite(takeManagerState.panelPos?.y) ? takeManagerState.panelPos.y : 12;
    left = _clamp(left, 12, Math.max(12, window.innerWidth - width - 12));
    top = _clamp(top, 12, Math.max(12, window.innerHeight - height - 12));
    takeManagerState.panelPos = { x: left, y: top };
    takeUI.wrap.style.left = `${left}px`;
    takeUI.wrap.style.top = `${top}px`;
    takeUI.wrap.style.right = 'auto';
}

function _startTakeManagerDrag(e) {
    if (!takeUI.wrap || e.target === takeUI.close) return;
    const rect = takeUI.wrap.getBoundingClientRect();
    takeManagerState.drag = {
        dx: e.clientX - rect.left,
        dy: e.clientY - rect.top,
    };
    e.preventDefault();
}

function _moveTakeManagerDrag(e) {
    if (!takeManagerState.drag || !takeUI.wrap) return;
    const rect = takeUI.wrap.getBoundingClientRect();
    const width = rect.width || 360;
    const height = rect.height || 280;
    const left = _clamp(e.clientX - takeManagerState.drag.dx, 12, Math.max(12, window.innerWidth - width - 12));
    const top = _clamp(e.clientY - takeManagerState.drag.dy, 12, Math.max(12, window.innerHeight - height - 12));
    takeManagerState.panelPos = { x: left, y: top };
    _applyTakeManagerPosition();
}

function _stopTakeManagerDrag() {
    takeManagerState.drag = null;
}

function _normalizeTakeManagerState(src = null) {
    const scenes = Array.isArray(src?.scenes) ? src.scenes : [];
    takeManagerState.scenes = scenes.map((scene, sceneIndex) => {
        const takesIn = Array.isArray(scene?.takes) ? scene.takes : [];
        const takes = takesIn.map((take, takeIndex) => ({
            id: String(take?.id || `scene_${sceneIndex + 1}_take_${takeIndex + 1}`),
            name: String((take?.name ?? '').toString().trim() || _defaultTakeLabel(takeIndex)),
            rating: Math.max(0, Math.min(5, Math.round(Number(take?.rating) || 0))),
            clipData: _cloneTakeClipData(take?.clipData),
            backgroundEntry: _cloneBackgroundEntry(take?.backgroundEntry) || _captureSceneBackgroundEntry(sceneIndex),
        }));
        if (!takes.length) takes.push({ id: `scene_${sceneIndex + 1}_take_1`, name: _defaultTakeLabel(0), rating: 0, clipData: null, backgroundEntry: _captureSceneBackgroundEntry(sceneIndex) });
        const selectedTakeIndex = Math.max(0, Math.min(takes.length - 1, Math.round(Number(scene?.selectedTakeIndex) || 0)));
        return { takes, selectedTakeIndex };
    });
    if (typeof src?.panelVisible === "boolean") takeManagerState.panelVisible = !!src.panelVisible;
    if (src?.panelPos && Number.isFinite(+src.panelPos.x) && Number.isFinite(+src.panelPos.y)) {
        takeManagerState.panelPos = { x: +src.panelPos.x, y: +src.panelPos.y };
    }
    takeManagerState.activeSceneIndex = -1;
    takeManagerState.activeTakeId = null;
}

function renderTakeManager() {
    _trimTakeManagerToSceneCount();
    const sceneIndex = _getCurrentTakeSceneIndex();
    const scene = _ensureSceneTakeData(sceneIndex);
    const take = scene.takes[scene.selectedTakeIndex] || scene.takes[0] || null;
    if (takeUI.sceneMeta) {
        const ratingText = take?.rating ? ` · ${'★'.repeat(take.rating)}` : '';
        const takeWord = tr('Take');
        const sceneWord = tr('Scene');
        takeUI.sceneMeta.textContent = `${sceneWord} ${sceneIndex + 1} · ${scene.takes.length} ${takeWord}${scene.takes.length === 1 ? '' : 's'}${ratingText}`;
    }
    if (takeUI.takeSelect) {
        const prevValue = String(scene.selectedTakeIndex);
        takeUI.takeSelect.innerHTML = '';
        scene.takes.forEach((item, idx) => {
            const opt = document.createElement('option');
            opt.value = String(idx);
            const stars = item.rating ? ` ${'★'.repeat(item.rating)}` : '';
            opt.textContent = `${idx + 1}. ${item.name}${stars}`;
            takeUI.takeSelect.appendChild(opt);
        });
        takeUI.takeSelect.value = prevValue;
    }
    if (takeUI.takeNameInput && (!takeManagerState.nameEditing || document.activeElement !== takeUI.takeNameInput)) {
        takeUI.takeNameInput.value = take?.name || '';
    }
    if (takeUI.stars) {
        takeUI.stars.innerHTML = '';
        for (let i = 1; i <= 5; i++) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `takeStar${(take?.rating || 0) >= i ? ' active' : ''}`;
            btn.textContent = '★';
            btn.title = `${i} Stern${i === 1 ? '' : 'e'}`;
            const applyStarRating = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const sceneIndex = _getCurrentTakeSceneIndex();
                const scene = _ensureSceneTakeData(sceneIndex);
                const takeIndex = Math.max(0, Math.min(scene.takes.length - 1, Math.round(Number(scene.selectedTakeIndex) || 0)));
                const current = scene.takes[takeIndex] || scene.takes[0] || null;
                if (!current) return;
                current.rating = (current.rating === i) ? 0 : i;
                _refreshTakeOptionLabel(sceneIndex, takeIndex);
                _refreshTakeSummary(sceneIndex);
                renderTakeManager();
                syncTransportUI();
            };
            btn.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
            btn.addEventListener('pointerup', applyStarRating);
            btn.addEventListener('click', applyStarRating);
            takeUI.stars.appendChild(btn);
        }
    }
    if (takeUI.summary) {
        _refreshTakeSummary(sceneIndex);
    }
    setTakeManagerVisible(takeManagerState.panelVisible);
}

_normalizeTakeManagerState();
// --- Datei-Menü ---
const fileMenu = document.getElementById("fileMenu");
const fileMenuBtn = document.getElementById("fileMenuBtn");
function closeFileMenu() { if (fileMenu) fileMenu.style.display = "none"; }
function toggleFileMenu() {
    if (!fileMenu) return;
    fileMenu.style.display = (fileMenu.style.display === "block") ? "none" : "block";
}
if (fileMenuBtn) fileMenuBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleFileMenu(); });

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

if (!Array.isArray(timeline.backgroundKeys) || !timeline.backgroundKeys.length) {
    timeline.backgroundKeys = [{ t: 0, entry: _cloneBackgroundEntry(backgroundState.currentSelection) }];
} else if (_num(timeline.backgroundKeys[0]?.t, 0) > 1e-5) {
    timeline.backgroundKeys = [{ t: 0, entry: _cloneBackgroundEntry(backgroundState.currentSelection) }].concat(_dedupeAndSortBackgroundKeys(timeline.backgroundKeys || []));
    timeline.backgroundKeys = _dedupeAndSortBackgroundKeys(timeline.backgroundKeys);
}

const onionSkin = {
    enabled: false,
    opacity: 0.50,
    pastFrames: 10,
    futureFrames: 10,
    stepFps: 5,
};

const onionUI = {
    modal: document.getElementById("onionSkinModal"),
    panel: document.getElementById("onionSkinPanel"),
    close: document.getElementById("onionSkinClose"),
    enabled: document.getElementById("onionEnabled"),
    enabledV: document.getElementById("onionEnabledV"),
    opacity: document.getElementById("onionOpacity"),
    opacityV: document.getElementById("onionOpacityV"),
    pastFrames: document.getElementById("onionPastFrames"),
    pastFramesV: document.getElementById("onionPastFramesV"),
    futureFrames: document.getElementById("onionFutureFrames"),
    futureFramesV: document.getElementById("onionFutureFramesV"),
    stepFps: document.getElementById("onionStepFps"),
    stepFpsV: document.getElementById("onionStepFpsV"),
};

function syncOnionSkinUI() {
    if (!onionUI.enabled) return;
    onionUI.enabled.value = onionSkin.enabled ? "1" : "0";
    onionUI.enabledV.textContent = onionSkin.enabled ? "1" : "0";
    onionUI.opacity.value = String(onionSkin.opacity);
    onionUI.opacityV.textContent = onionSkin.opacity.toFixed(2);
    onionUI.pastFrames.value = String(onionSkin.pastFrames);
    onionUI.pastFramesV.textContent = String(onionSkin.pastFrames);
    onionUI.futureFrames.value = String(onionSkin.futureFrames);
    onionUI.futureFramesV.textContent = String(onionSkin.futureFrames);
    onionUI.stepFps.value = String(onionSkin.stepFps);
    onionUI.stepFpsV.textContent = String(onionSkin.stepFps);
}

function normalizeOnionSkinState(v = {}) {
    onionSkin.enabled = !!(v.enabled);
    onionSkin.opacity = _clamp(_num(v.opacity, onionSkin.opacity), 0, 1);
    onionSkin.pastFrames = Math.max(0, Math.min(20, Math.round(_num(v.pastFrames, onionSkin.pastFrames))));
    onionSkin.futureFrames = Math.max(0, Math.min(20, Math.round(_num(v.futureFrames, onionSkin.futureFrames))));
    onionSkin.stepFps = Math.max(1, Math.min(60, Math.round(_num(v.stepFps, onionSkin.stepFps))));
    syncOnionSkinUI();
}

function openOnionSkinModal() {
    syncOnionSkinUI();
    if (!onionUI.modal) return;
    onionUI.modal.classList.add("open");
    onionUI.modal.setAttribute("aria-hidden", "false");
}
function closeOnionSkinModal() {
    if (!onionUI.modal) return;
    onionUI.modal.classList.remove("open");
    onionUI.modal.setAttribute("aria-hidden", "true");
}

onionUI.enabled?.addEventListener("input", () => normalizeOnionSkinState({ ...onionSkin, enabled: +onionUI.enabled.value > 0.5 }));
onionUI.opacity?.addEventListener("input", () => normalizeOnionSkinState({ ...onionSkin, opacity: onionUI.opacity.value }));
onionUI.pastFrames?.addEventListener("input", () => normalizeOnionSkinState({ ...onionSkin, pastFrames: onionUI.pastFrames.value }));
onionUI.futureFrames?.addEventListener("input", () => normalizeOnionSkinState({ ...onionSkin, futureFrames: onionUI.futureFrames.value }));
onionUI.stepFps?.addEventListener("input", () => normalizeOnionSkinState({ ...onionSkin, stepFps: onionUI.stepFps.value }));
onionUI.close?.addEventListener("click", closeOnionSkinModal);
onionUI.modal?.addEventListener("click", (e) => { if (e.target === onionUI.modal) closeOnionSkinModal(); });
transport.onionSkinBtn?.addEventListener("click", () => { closeFileMenu(); openOnionSkinModal(); });

normalizeOnionSkinState(onionSkin);

const flatplateOptionsUI = {
    modal: document.getElementById("flatplateOptionsModal"),
    panel: document.getElementById("flatplateOptionsPanel"),
    fps: document.getElementById("flatplateOptionsFps"),
    mode: document.getElementById("flatplateOptionsMode"),
    endInfinite: document.getElementById("flatplateOptionsEndInfinite"),
    endStopAtLastFrame: document.getElementById("flatplateOptionsEndStopAtLastFrame"),
    repeats: document.getElementById("flatplateOptionsRepeats"),
    apply: document.getElementById("flatplateOptionsApply"),
    cancel: document.getElementById("flatplateOptionsCancel"),
};
let flatplateOptionsResolver = null;

function _normalizeFlatplateModeValue(v) {
    const low = String(v || '').trim().toLowerCase();
    if (low === 'pingpong' || low === 'ping-pong' || low === 'ping pong') return 'pingpong';
    if (low === 'random') return 'random';
    if (low === 'forward' || low === 'loop') return 'forward';
    if (low === 'backward') return 'backward';
    return 'forward';
}
function _normalizeFlatplateRepeatCount(v, fallback = 1) {
    const n = Math.floor(_num(v, fallback));
    return Math.max(1, Math.min(9999, n));
}
function _normalizeFlatplateInfinite(v) {
    return v == null ? true : !!v;
}
function _syncFlatplateOptionsRepeatUI() {
    const infinite = !!flatplateOptionsUI.endInfinite?.checked;
    if (flatplateOptionsUI.repeats) {
        flatplateOptionsUI.repeats.disabled = infinite;
        flatplateOptionsUI.repeats.style.opacity = infinite ? '0.55' : '1';
    }
}
function openFlatplateOptionsModal(defaults = {}) {
    if (!flatplateOptionsUI.modal) return;
    flatplateOptionsUI.fps.value = String(Math.round(THREE.MathUtils.clamp(_num(defaults.fps, 24), 1, 120)));
    flatplateOptionsUI.mode.value = _normalizeFlatplateModeValue(defaults.mode || 'forward');
    const useInfinite = _normalizeFlatplateInfinite(defaults.infinite);
    if (flatplateOptionsUI.endInfinite) flatplateOptionsUI.endInfinite.checked = useInfinite;
    if (flatplateOptionsUI.endStopAtLastFrame) flatplateOptionsUI.endStopAtLastFrame.checked = !useInfinite;
    if (flatplateOptionsUI.repeats) flatplateOptionsUI.repeats.value = String(_normalizeFlatplateRepeatCount(defaults.repeats, 1));
    _syncFlatplateOptionsRepeatUI();
    flatplateOptionsUI.modal.classList.add('open');
    flatplateOptionsUI.modal.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
        try { flatplateOptionsUI.fps?.focus(); flatplateOptionsUI.fps?.select?.(); } catch { }
    });
}
function closeFlatplateOptionsModal() {
    if (!flatplateOptionsUI.modal) return;
    flatplateOptionsUI.modal.classList.remove('open');
    flatplateOptionsUI.modal.setAttribute('aria-hidden', 'true');
}
function resolveFlatplateOptions(result) {
    const resolve = flatplateOptionsResolver;
    flatplateOptionsResolver = null;
    closeFlatplateOptionsModal();
    if (resolve) resolve(result);
}
function _collectFlatplateOptionsFromUI() {
    const fps = Math.round(THREE.MathUtils.clamp(_num(flatplateOptionsUI.fps?.value, 24), 1, 120));
    const mode = _normalizeFlatplateModeValue(flatplateOptionsUI.mode?.value || 'forward');
    const infinite = !!flatplateOptionsUI.endInfinite?.checked;
    const stopAtLastFrame = !infinite;
    const repeats = _normalizeFlatplateRepeatCount(flatplateOptionsUI.repeats?.value, 1);
    return { fps, mode, stopAtLastFrame, infinite, repeats };
}
async function _askFlatplateOptions(defaults = {}) {
    if (!flatplateOptionsUI.modal) {
        const infinite = _normalizeFlatplateInfinite(defaults.infinite);
        return {
            fps: Math.round(THREE.MathUtils.clamp(_num(defaults.fps, 24), 1, 120)),
            mode: _normalizeFlatplateModeValue(defaults.mode || 'forward'),
            stopAtLastFrame: !infinite,
            infinite,
            repeats: _normalizeFlatplateRepeatCount(defaults.repeats, 1),
        };
    }
    if (flatplateOptionsResolver) resolveFlatplateOptions(null);
    openFlatplateOptionsModal(defaults);
    return await new Promise((resolve) => { flatplateOptionsResolver = resolve; });
}

flatplateOptionsUI.endInfinite?.addEventListener('change', _syncFlatplateOptionsRepeatUI);
flatplateOptionsUI.endStopAtLastFrame?.addEventListener('change', _syncFlatplateOptionsRepeatUI);
flatplateOptionsUI.apply?.addEventListener('click', () => resolveFlatplateOptions(_collectFlatplateOptionsFromUI()));
flatplateOptionsUI.cancel?.addEventListener('click', () => resolveFlatplateOptions(null));
flatplateOptionsUI.modal?.addEventListener('click', (e) => { if (e.target === flatplateOptionsUI.modal) resolveFlatplateOptions(null); });
flatplateOptionsUI.panel?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const tag = String(e.target?.tagName || '').toUpperCase();
        if (tag !== 'TEXTAREA') {
            e.preventDefault();
            resolveFlatplateOptions(_collectFlatplateOptionsFromUI());
        }
    }
});

const bgBrowser = {
    modal: document.getElementById("bgBrowserModal"),
    panel: document.getElementById("bgBrowserPanel"),
    grid: document.getElementById("bgBrowserGrid"),
    title: document.getElementById("bgBrowserTitle"),
    sub: document.getElementById("bgBrowserSub"),
    status: document.getElementById("bgBrowserStatus"),
    prev: document.getElementById("bgBrowserPrev"),
    next: document.getElementById("bgBrowserNext"),
    back: document.getElementById("bgBrowserBack"),
    close: document.getElementById("bgBrowserClose"),
};

//background catalog json, when colormap switch in ui load different jsons

const BG_JSON_CANDIDATES = ["./Backgrounds/backgrounds.json", "./backgrounds.json"];


const BG_ASSET_BASES = ["./Backgrounds/", "./"];
async function fetchFirstOk(urls) {
    let lastErr = null;
    for (const url of urls) {
        try {
            const res = await fetch(url, { cache: "no-store" });
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
            return { url, response: res };
        } catch (err) { lastErr = err; }
    }
    throw lastErr || new Error("File could not be loaded.");
}

async function resolveImageUrl(candidates) {
    let lastErr = null;
    for (const url of candidates) {
        try {
            await loadImage(url);
            return url;
        } catch (err) { lastErr = err; }
    }
    throw lastErr || new Error("Image could not be loaded.");
}

function buildAssetCandidates(rel) {
    const clean = normalizeAssetPath(rel);
    return BG_ASSET_BASES.map(base => `${base}${clean}`);
}

function prettyGroupName(group) {
    const raw = String(group?.displayName || group?.key || "Background");
    return raw.replace(/[_-]+/g, " ").replace(/\b\w/g, ch => ch.toUpperCase());
}

function getVisibleBackgroundItems() {
    if (backgroundState.mode === "shots") {
        const group = backgroundState.groups.find(g => g.key === backgroundState.selectedGroupKey);
        return group ? group.items : [];
    }
    return backgroundState.groups;
}

function updateBackgroundBrowserStatus(totalItems) {
    const items = getVisibleBackgroundItems();
    const pageCount = Math.max(1, Math.ceil(items.length / backgroundState.pageSize));
    backgroundState.page = Math.max(0, Math.min(backgroundState.page, pageCount - 1));
    bgBrowser.prev.disabled = backgroundState.page <= 0;
    bgBrowser.next.disabled = backgroundState.page >= pageCount - 1;
    bgBrowser.back.disabled = backgroundState.mode !== "shots";
    const pageLabel = `${backgroundState.page + 1}/${pageCount}`;
    if (backgroundState.mode === "shots") {
        const group = backgroundState.groups.find(g => g.key === backgroundState.selectedGroupKey);
        bgBrowser.title.textContent = `Backgrounds · ${prettyGroupName(group)}`;
        bgBrowser.sub.textContent = "Choose a camera setup — background, Z-buffer, and camera metadata will be adopted.";
        bgBrowser.status.textContent = `${items.length} camera views · page ${pageLabel}`;
    } else {
        bgBrowser.title.textContent = "Backgrounds";
        bgBrowser.sub.textContent = "Choose a folder — the preview shows the first image from each folder.";
        bgBrowser.status.textContent = `${totalItems} folders · page ${pageLabel}`;
    }
}

function clearBackgroundGrid() {
    while (bgBrowser.grid.firstChild) bgBrowser.grid.removeChild(bgBrowser.grid.firstChild);
}

function buildTileImage(urlCandidates, alt) {
    const img = document.createElement("img");
    img.className = "bgTileThumb";
    img.alt = alt;
    let idx = 0;
    const tryNext = () => {
        if (idx >= urlCandidates.length) return;
        img.src = urlCandidates[idx++];
    };
    img.addEventListener("error", tryNext, { once: false });
    tryNext();
    return img;
}

function renderBackgroundBrowser() {
    if (!bgBrowser.grid) return;
    const items = getVisibleBackgroundItems();
    const totalItems = backgroundState.groups.length;
    updateBackgroundBrowserStatus(totalItems);
    clearBackgroundGrid();
    const start = backgroundState.page * backgroundState.pageSize;
    const pageItems = items.slice(start, start + backgroundState.pageSize);

    for (const item of pageItems) {
        const isShot = backgroundState.mode === "shots";
        const entry = isShot ? item : item.preview;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "bgTile" + ((isShot && entry?.id === backgroundState.currentEntryId) ? " is-selected" : "");
        const title = isShot ? String(entry.name_key || entry.id || "View") : prettyGroupName(item);
        const imageCandidates = buildAssetCandidates(entry?.background || "");
        btn.appendChild(buildTileImage(imageCandidates, title));

        const name = document.createElement("div");
        name.className = "bgTileName";
        name.textContent = title;
        btn.appendChild(name);

        const meta = document.createElement("div");
        meta.className = "bgTileMeta";
        if (isShot) {
            meta.innerHTML = `<span>${entry?.meta?.focal_mm ?? "–"} mm</span><span>Pitch ${entry?.meta?.pitch_deg ?? 0}°</span>`;
        } else {
            meta.innerHTML = `<span>${item.items.length} Ansichten</span><span>${normalizeAssetPath(item.key).split("/").pop() || ""}</span>`;
        }
        btn.appendChild(meta);

        const hint = document.createElement("div");
        hint.className = "bgTileHint";
        hint.textContent = isShot
            ? `Horizon ${entry?.meta?.horizon_y ?? 0}`
            : `Open`;
        btn.appendChild(hint);

        if (isShot) {
            const primeSelection = () => {
                try { beginBackgroundSelectionLoad(item, { showProgress: false }); } catch { }
            };
            btn.addEventListener("pointerenter", primeSelection, { passive: true });
            btn.addEventListener("pointerdown", primeSelection, { passive: true });
        }

        btn.addEventListener("click", async () => {
            try {
                if (backgroundState.mode === "groups") {
                    backgroundState.mode = "shots";
                    backgroundState.selectedGroupKey = item.key;
                    backgroundState.page = 0;
                    renderBackgroundBrowser();
                    const preloadItems = Array.isArray(item?.items) ? item.items.slice(0, backgroundState.pageSize) : [];
                    for (const preloadItem of preloadItems) {
                        Promise.resolve().then(async () => {
                            const bundle = await preloadBackgroundEntry(preloadItem);
                            try { await ensureBackgroundLayer(bundle, { pin: true }); } catch { }
                        }).catch(() => { });
                    }
                } else {
                    showProjectLoadOverlay({
                        title: "Background is loading…",
                        mode: "Background selection",
                        file: normalizeAssetPath(item?.background || item?.zbuffer || item?.id || "Background"),
                        detail: "Starting load…",
                        progress: 0.02,
                    });
                    await _nextFrame();
                    await applyBackgroundEntry(item, { showProgress: true, source: "browser-select" });
                    closeBackgroundBrowser();
                }
            } catch (err) {
                console.error(err);
                alert(String(err?.message || err));
            }
        });
        bgBrowser.grid.appendChild(btn);
    }

    for (let i = pageItems.length; i < backgroundState.pageSize; i++) {
        const filler = document.createElement("div");
        filler.className = "bgTileEmpty";
        bgBrowser.grid.appendChild(filler);
    }
}



    async function loadBackgroundCatalog() {
      if (backgroundState.loaded) return;
      if (backgroundState.loadingPromise) return backgroundState.loadingPromise;
      backgroundState.loadingPromise = (async () => {
        const { url, response } = await fetchFirstOk(BG_JSON_CANDIDATES);
        backgroundState.jsonUrl = url;
        const json = await response.json();
        const entries = Array.isArray(json) ? json : (Array.isArray(json?.dataset?.entries) ? json.dataset.entries : []);
        if (!entries.length) throw new Error("backgrounds.json contains no entries.");

        const validEntries = entries.filter(e => e && e.background && e.zbuffer).map(e => ({
          ...e,
          relative_dir: normalizeAssetPath(e.relative_dir || ""),
          background: normalizeAssetPath(e.background),
          zbuffer: normalizeAssetPath(e.zbuffer),
          meta: {
            focal_mm: Number(e?.meta?.focal_mm ?? 86),
            horizon_y: Number(e?.meta?.horizon_y ?? -0.3),
            pitch_deg: Number(e?.meta?.pitch_deg ?? 0),
            cam_height: Number(e?.meta?.cam_height ?? 1.2),
          },
        }));

        if (!validEntries.length) throw new Error("No valid background pairs found in backgrounds.json.");

        const groupsMap = new Map();
        for (const entry of validEntries) {
          const key = entry.relative_dir || normalizeAssetPath(entry.background).split("/").slice(0, -1).join("/");
          if (!groupsMap.has(key)) {
            groupsMap.set(key, { key, displayName: key.split("/").pop() || key, items: [], preview: null });
          }
          const group = groupsMap.get(key);
          group.items.push(entry);
        }

        const groups = Array.from(groupsMap.values()).map(group => {
          group.items.sort((a, b) => String(a.name_key || a.background).localeCompare(String(b.name_key || b.background), undefined, { numeric: true, sensitivity: "base" }));
          group.preview = group.items[0] || null;
          return group;
        }).sort((a, b) => prettyGroupName(a).localeCompare(prettyGroupName(b), undefined, { sensitivity: "base" }));

        // try to auto-detect asset base from first preview image
        const firstRel = groups[0]?.preview?.background;
        if (firstRel) {
          const candidates = BG_ASSET_BASES.map(base => `${base}${firstRel}`);
          const resolved = await resolveImageUrl(candidates);
          backgroundState.assetBase = resolved.includes("./Backgrounds/") ? "./Backgrounds/" : "./";
        }

        backgroundState.entries = validEntries;
        backgroundState.groups = groups;
        backgroundState.loaded = true;
      })();
      try {
        await backgroundState.loadingPromise;
      } finally {
        backgroundState.loadingPromise = null;
      }
    }



async function ensureBackgroundBundle(entry) {
    const normalizedEntry = _cloneBackgroundEntry(entry);
    if (!normalizedEntry) return null;
    const sig = _backgroundEntrySignature(normalizedEntry) || `${normalizedEntry?.background || ""}|${normalizedEntry?.zbuffer || ""}`;
    const perf = BG_PERF.begin("ensureBackgroundBundle", normalizedEntry, { cachedBundle: _backgroundBundleCache.has(sig) });
    if (_backgroundBundleCache.has(sig)) {
        const cached = _backgroundBundleCache.get(sig);
        _touchCacheEntry(_backgroundBundleCache, sig, cached);
        const value = await cached;
        BG_PERF.mark(perf, "bundle-cache-hit", { hasPromise: cached instanceof Promise });
        BG_PERF.end(perf);
        return value;
    }
    const promise = (async () => {
        const bgCandidates = buildAssetCandidates(normalizedEntry.background);
        const zbCandidates = buildAssetCandidates(normalizedEntry.zbuffer);
        const tResolve = performance.now();
        const bgUrl = await resolveImageUrl(bgCandidates);
        const zbUrl = await resolveImageUrl(zbCandidates);
        BG_PERF.mark(perf, "resolve-urls", { dt: BG_PERF.fmt(performance.now() - tResolve), bgUrl, zbUrl });
        const tAssets = performance.now();
        const [img, depthTex] = await Promise.all([
            loadImage(bgUrl),
            loadAndDecodeDepthTexture(zbUrl),
        ]);
        BG_PERF.mark(perf, "assets-ready", { dt: BG_PERF.fmt(performance.now() - tAssets) });
        const tPrime = performance.now();
        await _primeDepthTextureOnGPU(depthTex);
        BG_PERF.mark(perf, "depth-gpu-prime", { dt: BG_PERF.fmt(performance.now() - tPrime) });
        return { sig, entry: normalizedEntry, bgUrl, zbUrl, img, depthTex };
    })();
    _backgroundBundleCache.set(sig, promise);
    try {
        const bundle = await promise;
        _backgroundBundleCache.set(sig, bundle);
        _evictOldestCacheEntries(_backgroundBundleCache, BG_BUNDLE_CACHE_LIMIT, (_key, value) => {
            Promise.resolve(value).catch(() => { });
        });
        BG_PERF.end(perf, { stored: true });
        return bundle;
    } catch (err) {
        _backgroundBundleCache.delete(sig);
        BG_PERF.warn(`#${perf.id} FAIL ensureBackgroundBundle`, perf.label, err);
        throw err;
    }
}

function applyBackgroundBundleSync(bundle, opts = {}) {
    if (!bundle) return false;
    const perf = BG_PERF.begin("applyBackgroundBundleSync", bundle.entry, {
        source: opts?.source || "unknown",
        hasLayer: !!_bgLayerCache.get(String(bundle.sig || "")),
        hasDepthTex: !!bundle.depthTex,
    });
    const objectUrl = _bgObjectUrlCache.get(String(bundle.bgUrl || "")) || bundle.bgUrl;
    bgW = bundle.img?.naturalWidth || bundle.img?.width || bgW || 1;
    bgH = bundle.img?.naturalHeight || bundle.img?.height || bgH || 1;
    syncCover();
    const usedLayer = applyBackgroundLayer(bundle);
    BG_PERF.mark(perf, "apply-layer", { usedLayer, objectUrl });
    if (!usedLayer) {
        if (bgImgEl.src !== objectUrl) bgImgEl.src = objectUrl;
        bgImgEl.style.opacity = "1";
        _activeBgLayerKey = "";
        _hideAllBackgroundLayers("");
    }
    depthTex = bundle.depthTex;
    const tBindings = performance.now();
    refreshDepthTextureBindings();
    BG_PERF.mark(perf, "refreshDepthTextureBindings", { dt: BG_PERF.fmt(performance.now() - tBindings) });

    const prevSelection = _cloneBackgroundEntry(backgroundState.currentSelection);
    const prevSignature = _backgroundEntrySignature(prevSelection);
    const normalizedEntry = _cloneBackgroundEntry(bundle.entry);
    if (ui.fmm) ui.fmm.value = String(Number(normalizedEntry?.meta?.focal_mm ?? ui.fmm.value));
    if (ui.horizon) ui.horizon.value = String(Number(normalizedEntry?.meta?.horizon_y ?? ui.horizon.value));
    if (ui.pitch) ui.pitch.value = String(Number(normalizedEntry?.meta?.pitch_deg ?? ui.pitch.value));
    if (ui.camHeight) ui.camHeight.value = String(Number(normalizedEntry?.meta?.cam_height ?? ui.camHeight.value));
    syncLabels();
    updateCameraFromUI();

    backgroundState.currentEntryId = normalizedEntry.id || normalizedEntry.name_key || normalizedEntry.background;
    backgroundState.currentSelection = normalizedEntry;
    timeline._bgAppliedSignature = _backgroundEntrySignature(backgroundState.currentSelection);

    if (opts.recordTimeline !== false) {
        const eps = 1e-5;
        const currentT = _clamp(timeline.playhead, 0, Math.max(timeline.playhead, getProjectDuration()));
        const keys = _dedupeAndSortBackgroundKeys(timeline.backgroundKeys || []);
        const hasStartKey = keys.some(k => Math.abs(_num(k?.t, 0)) <= eps);
        const nextSignature = _backgroundEntrySignature(backgroundState.currentSelection);
        if (prevSelection && currentT > eps && !hasStartKey) {
            upsertBackgroundKeyAt(0, prevSelection);
        }
        if (!keys.length || !prevSignature || prevSignature !== nextSignature || timeline.recording) {
            upsertBackgroundKeyAt(currentT, backgroundState.currentSelection);
        }
    }
    BG_PERF.end(perf, { source: opts?.source || "unknown" });
    return true;
}

async function preloadBackgroundEntry(entry) {
    return await ensureBackgroundBundle(entry);
}

function getBackgroundPreloadNeighbors(entry) {
    const normalizedEntry = _cloneBackgroundEntry(entry);
    if (!normalizedEntry) return [];
    const groupKey = normalizedEntry.relative_dir || normalizeAssetPath(normalizedEntry.background).split("/").slice(0, -1).join("/");
    const group = backgroundState.groups.find(g => g.key === groupKey);
    if (!group?.items?.length) return [];
    const idx = group.items.findIndex(it => String(it?.id || it?.name_key || it?.background) === String(normalizedEntry.id || normalizedEntry.name_key || normalizedEntry.background));
    if (idx < 0) return group.items.slice(0, Math.min(4, group.items.length));
    const neighbors = [];
    for (let off = -1; off <= 1; off++) {
        const item = group.items[idx + off];
        if (item) neighbors.push(item);
    }
    return neighbors;
}

let _deferredBackgroundWarmTimer = 0;
const _deferredBackgroundWarmQueue = new Map();

function _scheduleDeferredBackgroundWarm() {
    if (_deferredBackgroundWarmTimer) return;
    _deferredBackgroundWarmTimer = setTimeout(async () => {
        _deferredBackgroundWarmTimer = 0;
        if (timeline?.playing || timeline?._scrubbing || timeline?.recording) {
            _scheduleDeferredBackgroundWarm();
            return;
        }
        const pending = Array.from(_deferredBackgroundWarmQueue.values());
        _deferredBackgroundWarmQueue.clear();
        for (const item of pending) {
            try {
                const bundle = await preloadBackgroundEntry(item);
                await ensureBackgroundLayer(bundle, { pin: true });
            } catch (err) {
                console.debug("Deferred background preload skipped:", err);
            }
            await _yieldToBrowser();
        }
    }, 120);
}

function warmBackgroundBuffer(entry, opts = {}) {
    const queue = [entry, ...getBackgroundPreloadNeighbors(entry)];
    const duringPlayback = !!(timeline?.playing || timeline?._scrubbing || timeline?.recording);
    for (const item of queue) {
        if (!item) continue;
        const sig = _backgroundEntrySignature(item) || `${item?.background || ''}|${item?.zbuffer || ''}`;
        if (duringPlayback && !opts.force) {
            _deferredBackgroundWarmQueue.set(sig, _cloneBackgroundEntry(item));
            continue;
        }
        Promise.resolve().then(async () => { const bundle = await preloadBackgroundEntry(item); await ensureBackgroundLayer(bundle, { pin: true }); }).catch(err => console.debug("Background preload skipped:", err));
    }
    if (duringPlayback && !opts.force) _scheduleDeferredBackgroundWarm();
}

function collectProjectBackgroundEntries(proj) {
    const out = [];
    const pushEntry = (entry) => {
        const normalized = _cloneBackgroundEntry(entry);
        if (normalized) out.push(normalized);
    };
    if (proj?.backgroundSelection) pushEntry(proj.backgroundSelection);
    if (Array.isArray(proj?.backgroundTimeline)) {
        for (const key of proj.backgroundTimeline) pushEntry(key?.entry);
    }
    return out;
}
function collectLiveTimelineBackgroundEntries(proj = null) {
    const out = collectProjectBackgroundEntries(proj || {});
    const pushEntry = (entry) => {
        const normalized = _cloneBackgroundEntry(entry);
        if (normalized) out.push(normalized);
    };
    if (backgroundState?.currentSelection) pushEntry(backgroundState.currentSelection);
    if (Array.isArray(timeline?.backgroundKeys)) {
        for (const key of timeline.backgroundKeys) pushEntry(key?.entry);
    }
    return out;
}

async function warmProjectBackgroundBuffer(proj, opts = {}) {
    const entries = collectProjectBackgroundEntries(proj);
    if (!entries.length) {
        opts.onProgress?.({ progress: 1, done: 0, total: 0, file: "No backgrounds in project", detail: "There is nothing to prewarm." });
        return [];
    }
    try { await loadBackgroundCatalog(); } catch { }
    const unique = new Map();
    for (const entry of entries) {
        const sig = _backgroundEntrySignature(entry) || `${entry?.background || ''}|${entry?.zbuffer || ''}`;
        if (!unique.has(sig)) unique.set(sig, entry);
    }
    const all = Array.from(unique.values());
    const results = [];
    const total = all.length;
    const presentationState = _capturePresentationWarmState();
    try {
        for (let i = 0; i < all.length; i++) {
            const entry = all[i];
            const label = normalizeAssetPath(entry?.background || entry?.zbuffer || `Asset ${i + 1}`);
            opts.onProgress?.({ progress: i / Math.max(total, 1), done: i, total, file: label, detail: `Loading background ${i + 1} of ${total}` });
            try {
                const bundle = await preloadBackgroundEntry(entry);
                await warmBackgroundBundleForPresentation(bundle);
                await _primeDepthTextureOnGPU(bundle?.depthTex);
                opts.onProgress?.({ progress: (i + 0.35) / Math.max(total, 1), done: i, total, file: label, detail: `Warming playback buffer ${i + 1} of ${total}` });
                await warmBackgroundBundleByRealApply(bundle);
                results.push({ status: "fulfilled", value: bundle });
            } catch (err) {
                results.push({ status: "rejected", reason: err });
                console.warn("Project background warmup failed for", label, err);
            }
            opts.onProgress?.({ progress: (i + 1) / Math.max(total, 1), done: i + 1, total, file: label, detail: `In buffer: ${i + 1} of ${total}` });
            await _yieldToBrowser();
        }
    } finally {
        await _restorePresentationWarmState(presentationState);
    }
    const failed = results.filter(r => r.status === "rejected");
    if (failed.length) console.warn(`Project background warmup: ${failed.length} asset pairs could not be fully preloaded.`);
    return results;
}

async function warmProjectBackgroundPlaybackAfterSceneReady(proj, opts = {}) {
    const entries = collectLiveTimelineBackgroundEntries(proj);
    if (!entries.length) {
        opts.onProgress?.({ progress: 1, done: 0, total: 0, file: "No backgrounds in project", detail: "No playback backgrounds to warm" });
        return [];
    }
    const unique = new Map();
    for (const entry of entries) {
        const sig = _backgroundEntrySignature(entry) || `${entry?.background || ''}|${entry?.zbuffer || ''}`;
        if (!unique.has(sig)) unique.set(sig, entry);
    }
    const all = Array.from(unique.values());
    const total = all.length;
    const state = _capturePresentationWarmState();
    const out = [];
    try {
        for (let i = 0; i < all.length; i++) {
            const entry = all[i];
            const label = normalizeAssetPath(entry?.background || entry?.zbuffer || `Asset ${i + 1}`);
            opts.onProgress?.({ progress: i / Math.max(total, 1), done: i, total, file: label, detail: `Simulating first playback ${i + 1} of ${total}` });
            try {
                const bundle = await ensureBackgroundBundle(entry);
                await _forceWarmBundlePresentation(bundle, 3);
                out.push({ status: 'fulfilled', value: bundle });
            } catch (err) {
                out.push({ status: 'rejected', reason: err });
                console.warn('Scene-ready background warmup failed for', label, err);
            }
            opts.onProgress?.({ progress: (i + 1) / Math.max(total, 1), done: i + 1, total, file: label, detail: `Playback ready ${i + 1} of ${total}` });
            await _yieldToBrowser();
        }
    } finally {
        await _restorePresentationWarmState(state);
        try { requestBackgroundTimelineApplyAt(timeline.playhead || 0); } catch { }
        _flushRendererNow();
    }
    return out;
}

const _selectionWarmPromiseCache = new Map();

function _nextFrame() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function beginBackgroundSelectionLoad(entry, opts = {}) {
    const normalizedEntry = _cloneBackgroundEntry(entry);
    if (!normalizedEntry) return { entry: null, label: "", promise: Promise.resolve(null) };
    const sig = _backgroundEntrySignature(normalizedEntry) || `${normalizedEntry?.background || ''}|${normalizedEntry?.zbuffer || ''}`;
    const label = normalizeAssetPath(normalizedEntry?.background || normalizedEntry?.zbuffer || normalizedEntry?.id || "Background");
    if (opts.showProgress) {
        showProjectLoadOverlay({
            title: "Background is loading…",
            mode: "Background selection",
            file: label,
            detail: "Starting load…",
            progress: 0.02,
        });
    }
    let promise = _selectionWarmPromiseCache.get(sig);
    if (!promise) {
        promise = Promise.resolve().then(async () => {
            const bundle = await ensureBackgroundBundle(normalizedEntry);
            try { await ensureBackgroundLayer(bundle, { pin: true }); } catch { }
            return bundle;
        }).finally(() => {
            _selectionWarmPromiseCache.delete(sig);
        });
        _selectionWarmPromiseCache.set(sig, promise);
    }
    return { entry: normalizedEntry, label, promise };
}

async function applyBackgroundEntry(entry, opts = {}) {
    if (!entry) return;
    const normalizedEntry = _cloneBackgroundEntry(entry);
    if (!normalizedEntry) return;
    const perf = BG_PERF.begin("applyBackgroundEntry", normalizedEntry, { source: opts?.source || "unknown" });
    const showProgress = !!opts?.showProgress;
    const load = beginBackgroundSelectionLoad(normalizedEntry, { showProgress });
    const label = load.label;
    if (showProgress) {
        await _nextFrame();
        updateProjectLoadOverlay({
            title: "Background is loading…",
            mode: "Background selection",
            file: label,
            detail: "Loading background and Z-buffer…",
            progress: 0.08,
        });
    }
    try {
        const bundle = await load.promise;
        BG_PERF.mark(perf, "bundle-ready");
        if (showProgress) {
            updateProjectLoadOverlay({
                title: "Background is loading…",
                mode: "Background selection",
                file: label,
                detail: "Applying background to the scene…",
                progress: 0.82,
            });
        }
        applyBackgroundBundleSync(bundle, opts);
        BG_PERF.mark(perf, "bundle-applied");
        warmBackgroundBuffer(normalizedEntry, { force: !timeline?.playing && !timeline?._scrubbing && !timeline?.recording });
        BG_PERF.end(perf);
        if (showProgress) {
            updateProjectLoadOverlay({
                title: "Background is loading…",
                mode: "Background selection",
                file: label,
                detail: "Fertig",
                progress: 1,
            });
            await new Promise(r => setTimeout(r, 60));
        }
    } finally {
        if (showProgress) hideProjectLoadOverlay();
    }
}

async function openBackgroundBrowser() {
    closeFileMenu();
    bgBrowser.status.textContent = "Loading backgrounds…";
    bgBrowser.modal.classList.add("open");
    bgBrowser.modal.setAttribute("aria-hidden", "false");
    try {
        await loadBackgroundCatalog();
        backgroundState.mode = "groups";
        backgroundState.selectedGroupKey = null;
        backgroundState.page = 0;
        renderBackgroundBrowser();
    } catch (err) {
        bgBrowser.status.textContent = "Error while loading";
        console.error(err);
        alert(String(err?.message || err));
    }
}

function closeBackgroundBrowser() {
    bgBrowser.modal.classList.remove("open");
    bgBrowser.modal.setAttribute("aria-hidden", "true");
}

bgBrowser.prev?.addEventListener("click", () => { backgroundState.page = Math.max(0, backgroundState.page - 1); renderBackgroundBrowser(); });
bgBrowser.next?.addEventListener("click", () => { backgroundState.page += 1; renderBackgroundBrowser(); });
bgBrowser.back?.addEventListener("click", () => { if (backgroundState.mode === "shots") { backgroundState.mode = "groups"; backgroundState.selectedGroupKey = null; backgroundState.page = 0; renderBackgroundBrowser(); } });
bgBrowser.close?.addEventListener("click", closeBackgroundBrowser);
bgBrowser.modal?.addEventListener("click", (e) => { if (e.target === bgBrowser.modal) closeBackgroundBrowser(); });
transport.backgroundBtn?.addEventListener("click", openBackgroundBrowser);

window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && bgBrowser.modal?.classList.contains("open")) closeBackgroundBrowser();
    if (e.key === "Escape" && onionUI.modal?.classList.contains("open")) closeOnionSkinModal();
    if (e.key === "Escape" && languageUI.modal?.classList.contains("open")) closeLanguageModal();
    if (e.key === "Escape" && flatplateOptionsUI.modal?.classList.contains("open")) resolveFlatplateOptions(null);
});



const SHORTCUT_STORAGE_KEY = "three_depth_ui_shortcuts_v2";
const SHORTCUT_DEFAULTS = {
    toggleMenu: "M",
    toggleCleanfeed: "H",
    toggleRecArmed: "R",
    togglePlay: "Space",
    playReverse: "J",
    pausePlayback: "K",
    playForward: "L",
    manualKeyframe: "Ctrl+R",
    rewindTimeline: "Home",
    toggleFullscreen: "F",
    openShortcuts: "Ctrl+/",
    prevScene: "PageUp",
    nextScene: "PageDown",
    moveLeft: "A",
    moveRight: "D",
    moveForward: "W",
    moveBackward: "S",
    moveDown: "Q",
    moveUp: "E",
};
const SHORTCUT_SECTIONS = [
    {
        title: "Program", items: [
            { id: "toggleMenu", label: "Toggle menu", description: "Open or close the developer menu" },
            { id: "openShortcuts", label: "Shortcut window", description: "View and change key bindings" },
            { id: "toggleCleanfeed", label: "Cleanfeed UI", description: "Hide / show interface" },
            { id: "toggleFullscreen", label: "Fullscreen", description: "Toggle fullscreen" },
        ]
    },
    {
        title: "Timeline", items: [
            { id: "togglePlay", label: "Play / Pause", description: "Start or stop the current scene" },
            { id: "playReverse", label: "Play reverse (J)", description: "Press repeatedly for faster reverse shuttle playback" },
            { id: "pausePlayback", label: "Pause (K)", description: "Pause playback; hold K + J/L for frame stepping" },
            { id: "playForward", label: "Play forward (L)", description: "Press repeatedly for faster forward shuttle playback" },
            { id: "manualKeyframe", label: "Record hold pose", description: "Record the current pose from the playhead through the rest of the current scene" },
            { id: "rewindTimeline", label: "To start", description: "Set current scene to 0" },
            { id: "toggleRecArmed", label: "Arm REC", description: "Toggle recording readiness" },
            { id: "prevScene", label: "Previous scene", description: "Jump to the previous scene/camera setup" },
            { id: "nextScene", label: "Next scene", description: "Jump to the next scene/camera setup" },
        ]
    },
    {
        title: "Move character", items: [
            { id: "moveForward", label: "Forward", description: "Move active character forward" },
            { id: "moveBackward", label: "Backward", description: "Move active character backward" },
            { id: "moveLeft", label: "Left", description: "Move active character left" },
            { id: "moveRight", label: "Right", description: "Move active character right" },
            { id: "moveUp", label: "Up", description: "Move active character up" },
            { id: "moveDown", label: "Down", description: "Move active character down" },
        ]
    }
];

const shortcutUI = {
    modal: document.getElementById("shortcutModal"),
    panel: document.getElementById("shortcutPanel"),
    grid: document.getElementById("shortcutGrid"),
    close: document.getElementById("shortcutClose"),
    resetAll: document.getElementById("shortcutResetAll"),
};

const languageUI = {
    modal: document.getElementById("languageModal"),
    panel: document.getElementById("languagePanel"),
    select: document.getElementById("languageSelect"),
    apply: document.getElementById("languageApplyBtn"),
    close: document.getElementById("languageCloseBtn"),
    menuBtn: document.getElementById("languageMenuBtn"),
};

function openLanguageModal() {
    closeFileMenu();
    if (!languageUI.modal) return;
    if (languageUI.select) languageUI.select.value = currentLanguage;
    languageUI.modal.classList.add('open');
    languageUI.modal.setAttribute('aria-hidden', 'false');
}

function closeLanguageModal() {
    if (!languageUI.modal) return;
    languageUI.modal.classList.remove('open');
    languageUI.modal.setAttribute('aria-hidden', 'true');
}

let shortcutCaptureId = null;
let shortcuts = loadShortcuts();

function normalizeShortcutKeyName(key) {
    if (key == null) return "";
    const raw = String(key);
    if (raw === " ") return "Space";
    const k = raw.trim();
    if (!k) return "";
    const lower = k.toLowerCase();
    if (lower === "space") return "Space";
    if (lower === "spacebar") return "Space";
    if (lower === "escape") return "Esc";
    if (lower === "control") return "Ctrl";
    if (lower === "arrowleft") return "ArrowLeft";
    if (lower === "arrowright") return "ArrowRight";
    if (lower === "arrowup") return "ArrowUp";
    if (lower === "arrowdown") return "ArrowDown";
    if (lower === "pageup") return "PageUp";
    if (lower === "pagedown") return "PageDown";
    if (lower === "plus") return "+";
    if (lower === "slash") return "/";
    if (lower.length === 1) return lower.toUpperCase();
    return k.charAt(0).toUpperCase() + k.slice(1);
}

function normalizeShortcutString(value) {
    if (typeof value !== "string") return "";
    let raw = value.trim();
    if (!raw) return "";
    raw = raw.replace(/\s+/g, "");
    const parts = raw.split("+").filter(Boolean);
    let ctrl = false, shift = false, alt = false, meta = false;
    let key = "";
    for (const part of parts) {
        const p = part.toLowerCase();
        if (p === "ctrl" || p === "control" || p === "strg") ctrl = true;
        else if (p === "shift") shift = true;
        else if (p === "alt" || p === "option") alt = true;
        else if (p === "meta" || p === "cmd" || p === "command") meta = true;
        else key = part;
    }
    key = normalizeShortcutKeyName(key || raw);
    const out = [];
    if (ctrl) out.push("Ctrl");
    if (shift) out.push("Shift");
    if (alt) out.push("Alt");
    if (meta) out.push("Meta");
    if (key) out.push(key);
    return out.join("+");
}

function shortcutFromEvent(e) {
    const key = normalizeShortcutKeyName(e.key);
    if (!key || ["Ctrl", "Shift", "Alt", "Meta"].includes(key)) return "";
    const out = [];
    if (e.ctrlKey) out.push("Ctrl");
    if (e.shiftKey) out.push("Shift");
    if (e.altKey) out.push("Alt");
    if (e.metaKey) out.push("Meta");
    out.push(key);
    return out.join("+");
}

function loadShortcuts() {
    try {
        const saved = JSON.parse(localStorage.getItem(SHORTCUT_STORAGE_KEY) || "{}");
        const out = { ...SHORTCUT_DEFAULTS };
        for (const [id, val] of Object.entries(saved || {})) {
            if (!(id in SHORTCUT_DEFAULTS)) continue;
            out[id] = normalizeShortcutString(val);
        }
        return out;
    } catch {
        return { ...SHORTCUT_DEFAULTS };
    }
}

function saveShortcuts() {
    try { localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(shortcuts)); } catch { }
}

function isTypingTarget(target) {
    const tag = target && target.tagName ? String(target.tagName).toLowerCase() : "";
    return !!(target && (target.isContentEditable || tag === "input" || tag === "textarea" || tag === "select"));
}

function eventMatchesShortcut(e, actionId) {
    const combo = shortcutFromEvent(e);
    if (!combo) return false;
    return combo === normalizeShortcutString(shortcuts[actionId]);
}

function pressedShortcutForAction(actionId) {
    const combo = normalizeShortcutString(shortcuts[actionId]);
    if (!combo) return false;
    return keys.has(combo.toLowerCase());
}

function getShortcutConflicts(actionId) {
    const combo = normalizeShortcutString(shortcuts[actionId]);
    if (!combo) return [];
    const conflicts = [];
    for (const section of SHORTCUT_SECTIONS) {
        for (const item of section.items) {
            if (item.id !== actionId && normalizeShortcutString(shortcuts[item.id]) === combo) conflicts.push(item.label);
        }
    }
    return conflicts;
}

function refreshShortcutHints() {
    if (ui.togglePanel) ui.togglePanel.title = `Toggle menu (${normalizeShortcutString(shortcuts.toggleMenu) || "–"})`;
    if (fileMenuBtn) fileMenuBtn.title = `Load/save project file · Shortcuts (${normalizeShortcutString(shortcuts.openShortcuts) || "–"})`;
    if (transport.rewBtn) transport.rewBtn.title = `Rewind (${normalizeShortcutString(shortcuts.rewindTimeline) || "–"})`;
    if (transport.playBtn) transport.playBtn.title = `Play/Pause (${normalizeShortcutString(shortcuts.togglePlay) || "–"}) · Reverse ${normalizeShortcutString(shortcuts.playReverse) || "–"} · Pause ${normalizeShortcutString(shortcuts.pausePlayback) || "–"} · Forward ${normalizeShortcutString(shortcuts.playForward) || "–"}`;
    if (transport.recBtn) transport.recBtn.title = `REC arm/disarm (${normalizeShortcutString(shortcuts.toggleRecArmed) || "–"}) · Manual keyframe ${normalizeShortcutString(shortcuts.manualKeyframe) || "–"}`;
    if (transport.scenePrevBtn) transport.scenePrevBtn.title = `Previous scene/camera setup (${normalizeShortcutString(shortcuts.prevScene) || "–"})`;
    if (transport.sceneNextBtn) transport.sceneNextBtn.title = `Next scene/camera setup (${normalizeShortcutString(shortcuts.nextScene) || "–"})`;
    if (transport.takeManagerBtn) transport.takeManagerBtn.title = tr('Toggle Take Manager');
}

function setShortcut(actionId, combo) {
    const normalized = normalizeShortcutString(combo);
    if (!normalized) return;
    shortcuts[actionId] = normalized;
    shortcutCaptureId = null;
    saveShortcuts();
    renderShortcutUI();
    refreshShortcutHints();
}

function renderShortcutUI() {
    if (!shortcutUI.grid) return;
    shortcutUI.grid.innerHTML = "";
    for (const section of SHORTCUT_SECTIONS) {
        const card = document.createElement("section");
        card.className = "shortcutCard";
        const heading = document.createElement("h4");
        heading.textContent = tr(section.title);
        card.appendChild(heading);
        for (const item of section.items) {
            const row = document.createElement("div");
            row.className = "shortcutRow";

            const label = document.createElement("div");
            label.className = "shortcutActionLabel";
            label.innerHTML = `<div class="shortcutActionTitle">${tr(item.label)}</div><div class="shortcutActionDesc">${tr(item.description)}</div>`;

            const controls = document.createElement("div");
            controls.className = "shortcutControls";

            const keyBtn = document.createElement("button");
            keyBtn.type = "button";
            keyBtn.className = "shortcutKeyBtn" + (shortcutCaptureId === item.id ? " is-listening" : "");
            keyBtn.textContent = shortcutCaptureId === item.id ? tr("Press a key…") : (normalizeShortcutString(shortcuts[item.id]) || tr("Not set"));
            keyBtn.addEventListener("click", () => { shortcutCaptureId = item.id; renderShortcutUI(); });

            const resetBtn = document.createElement("button");
            resetBtn.type = "button";
            resetBtn.className = "shortcutGhostBtn";
            resetBtn.textContent = tr("Reset");
            resetBtn.addEventListener("click", () => {
                shortcuts[item.id] = SHORTCUT_DEFAULTS[item.id];
                saveShortcuts();
                renderShortcutUI();
                refreshShortcutHints();
            });

            const clearBtn = document.createElement("button");
            clearBtn.type = "button";
            clearBtn.className = "shortcutGhostBtn";
            clearBtn.textContent = tr("Delete");
            clearBtn.addEventListener("click", () => {
                shortcuts[item.id] = "";
                saveShortcuts();
                renderShortcutUI();
                refreshShortcutHints();
            });

            controls.append(keyBtn, resetBtn, clearBtn);
            row.append(label, controls);

            const conflicts = getShortcutConflicts(item.id);
            if (conflicts.length) {
                const warn = document.createElement("div");
                warn.className = "shortcutConflict";
                warn.textContent = `${tr("Conflict with:")} ${conflicts.map(label => tr(label)).join(", ")}`;
                row.appendChild(warn);
            }
            card.appendChild(row);
        }
        shortcutUI.grid.appendChild(card);
    }
    applyI18n(shortcutUI.grid);
}

function openShortcutModal() {
    renderShortcutUI();
    closeFileMenu();
    if (!shortcutUI.modal) return;
    shortcutUI.modal.classList.add("open");
    shortcutUI.modal.setAttribute("aria-hidden", "false");
}

function closeShortcutModal() {
    shortcutCaptureId = null;
    if (!shortcutUI.modal) return;
    shortcutUI.modal.classList.remove("open");
    shortcutUI.modal.setAttribute("aria-hidden", "true");
    renderShortcutUI();
}

function resetAllShortcuts() {
    shortcuts = { ...SHORTCUT_DEFAULTS };
    saveShortcuts();
    renderShortcutUI();
    refreshShortcutHints();
}

function _smoothstep(x) { x = _clamp(x, 0, 1); return x * x * (3 - 2 * x); }

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

function upsertBackgroundKeyAt(t, entry = backgroundState.currentSelection) {
    const cloned = _cloneBackgroundEntry(entry);
    if (!cloned || !cloned.background || !cloned.zbuffer) return;
    const eps = 1e-5;
    const keys = _dedupeAndSortBackgroundKeys(timeline.backgroundKeys || []).filter(k => Math.abs(_num(k.t, 0) - t) > eps);
    keys.push({ t, entry: cloned });
    timeline.backgroundKeys = _dedupeAndSortBackgroundKeys(keys);
    timeline.duration = getProjectDuration();
    transport.timeSlider.max = String(Math.max(timeline.duration, 0));
}

function _getBackgroundEntryAtTime(t) {
    const keys = _dedupeAndSortBackgroundKeys(timeline.backgroundKeys || []);
    if (!keys.length) return null;
    let chosen = null;
    for (const k of keys) {
        if (_num(k.t, 0) <= t + 1e-5) chosen = k;
        else break;
    }
    return chosen ? _cloneBackgroundEntry(chosen.entry) : null;
}

function requestBackgroundTimelineApplyAt(t) {
    const entry = _getBackgroundEntryAtTime(t);
    if (!entry) return;
    const sig = _backgroundEntrySignature(entry);
    if (sig && sig === timeline._bgAppliedSignature) return;
    const perf = BG_PERF.begin("timeline-switch", entry, {
        t,
        scrubbing: !!timeline._scrubbing,
        playing: !!timeline.playing,
        recording: !!timeline.recording,
    });
    BG_PERF.activeSwitchId = perf.id;
    const token = ++timeline._bgApplyToken;
    const cached = sig ? _backgroundBundleCache.get(sig) : null;
    BG_PERF.mark(perf, "cache-state", {
        bundleCached: !!cached,
        bundleResolved: !!(cached && !(cached instanceof Promise)),
        imageCached: _bgImageCache.has(String(cached?.bgUrl || entry?.background || "")),
        zbufferCached: _depthTextureCache.has(String(cached?.zbUrl || entry?.zbuffer || "")),
    });
    if (cached && !(cached instanceof Promise)) {
        try {
            applyBackgroundBundleSync(cached, { recordTimeline: false, source: "timeline" });
            if (token === timeline._bgApplyToken) timeline._bgAppliedSignature = sig;
            warmBackgroundBuffer(entry);
            BG_PERF.end(perf, { path: "sync-cache" });
            return;
        } catch (err) {
            BG_PERF.warn(`#${perf.id} timeline sync switch failed`, err);
        }
    }
    applyBackgroundEntry(entry, { recordTimeline: false, source: "timeline" }).then(() => {
        if (token === timeline._bgApplyToken) timeline._bgAppliedSignature = sig;
        BG_PERF.end(perf, { path: "async-apply" });
    }).catch(err => {
        BG_PERF.warn(`#${perf.id} Timeline background switch failed`, err);
        console.warn("Timeline background switch failed", err);
    });
}

function _catmullRom(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    // 0.5 * (2p1 + (-p0+p2)t + (2p0-5p1+4p2-p3)t^2 + (-p0+3p1-3p2+p3)t^3)
    return 0.5 * (
        2 * p1 +
        (-p0 + p2) * t +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
        (-p0 + 3 * p1 - 3 * p2 + p3) * t3
    );
}

function _sampleVec3(keys, i0, i1, u) {
    // Use Catmull-Rom when possible, otherwise lerp
    const k0 = keys[i0], k1 = keys[i1];
    const t = _smoothstep(u);
    const out = new THREE.Vector3();

    const im1 = Math.max(0, i0 - 1);
    const ip2 = Math.min(keys.length - 1, i1 + 1);

    if (keys.length >= 4 && im1 !== i0 && ip2 !== i1) {
        const p0 = keys[im1].p, p1 = k0.p, p2 = k1.p, p3 = keys[ip2].p;
        out.set(
            _catmullRom(p0[0], p1[0], p2[0], p3[0], t),
            _catmullRom(p0[1], p1[1], p2[1], p3[1], t),
            _catmullRom(p0[2], p1[2], p2[2], p3[2], t),
        );
    } else {
        out.fromArray(k0.p).lerp(new THREE.Vector3().fromArray(k1.p), t);
    }
    return out;
}

function _sampleScale(keys, i0, i1, u) {
    const k0 = keys[i0], k1 = keys[i1];
    const t = _smoothstep(u);
    const out = new THREE.Vector3();

    const im1 = Math.max(0, i0 - 1);
    const ip2 = Math.min(keys.length - 1, i1 + 1);

    if (keys.length >= 4 && im1 !== i0 && ip2 !== i1) {
        const s0 = keys[im1].s, s1 = k0.s, s2 = k1.s, s3 = keys[ip2].s;
        out.set(
            _catmullRom(s0[0], s1[0], s2[0], s3[0], t),
            _catmullRom(s0[1], s1[1], s2[1], s3[1], t),
            _catmullRom(s0[2], s1[2], s2[2], s3[2], t),
        );
    } else {
        out.fromArray(k0.s).lerp(new THREE.Vector3().fromArray(k1.s), t);
    }
    return out;
}

function _sampleQuat(keys, i0, i1, u) {
    const k0 = keys[i0], k1 = keys[i1];
    const t = _smoothstep(u);
    const q0 = new THREE.Quaternion().fromArray(k0.q);
    const q1 = new THREE.Quaternion().fromArray(k1.q);
    return q0.slerp(q1, t);
}


function _timelineAnimKey(name) {
    if (name === null || typeof name === 'undefined') return null;
    return _resolveAnimName(name, anim) || _low(name);
}

function _timelineSameAnim(a, b) {
    if (a === null || typeof a === 'undefined') return (b === null || typeof b === 'undefined');
    if (b === null || typeof b === 'undefined') return false;
    return _timelineAnimKey(a) === _timelineAnimKey(b);
}

function _timelineGetAction(name) {
    if (!anim.mixer) return null;
    if (name === null || typeof name === 'undefined') return anim.restAction || null;
    const resolved = _resolveAnimName(name, anim) || _low(name);
    return anim.actions.get(resolved) || anim.actions.get(_low(name)) || null;
}

function _timelinePoseAction(action, name, phase01, speed, weight) {
    if (!action) return;
    try { action.enabled = true; } catch { }
    try { action.paused = false; } catch { }
    try { action.play(); } catch { }
    try { action.setEffectiveWeight?.(weight); } catch { }
    try { action.setEffectiveTimeScale?.((name === null || typeof name === 'undefined') ? 1 : _num(speed, 1)); } catch { }
    try {
        if (name === null || typeof name === 'undefined') {
            action.time = 0;
        } else {
            const clip = action.getClip?.();
            const dur = Math.max(1e-6, clip?.duration || 0);
            action.time = (((phase01 ?? 0) % 1) + 1) % 1 * dur;
        }
    } catch { }
}

function _timelineStopUnusedActions(keepList) {
    const keep = new Set((keepList || []).filter(Boolean));
    const list = [];
    if (anim.restAction) list.push(anim.restAction);
    if (anim.holdAction) list.push(anim.holdAction);
    if (anim.actions && anim.actions.size) {
        for (const a of anim.actions.values()) list.push(a);
    }
    for (const a of list) {
        if (!a || keep.has(a)) continue;
        try { a.stop(); } catch { }
        try { a.enabled = false; } catch { }
        try { a.paused = true; } catch { }
        try { a.setEffectiveWeight?.(0); } catch { }
    }
}

function _applyTimelineAnimState(name, phase01, speed) {
    const act = _timelineGetAction(name);
    if (!act) {
        _timelineStopUnusedActions([]);
        anim.action = null;
        anim.selectedName = (name ?? null);
        anim.blendRemaining = 0;
        anim.blendPauseAfter = false;
        anim.blendFrom = null;
        return;
    }
    _timelineStopUnusedActions([act]);
    _timelinePoseAction(act, name, phase01, speed, 1);
    anim.action = act;
    anim.selectedName = (name ?? null);
    anim.blendRemaining = 0;
    anim.blendPauseAfter = false;
    anim.blendFrom = null;
    try { if (anim.mixer) anim.mixer.update(0); } catch { }
    try { act.paused = true; } catch { }
}

function _timelineAdvancePhase(name, phase01, speed, deltaSec) {
    if (name === null || typeof name === 'undefined') return 0;
    const act = _timelineGetAction(name);
    const clip = act && act.getClip ? act.getClip() : null;
    const dur = Math.max(1e-6, clip?.duration || 0);
    const dt = _num(deltaSec, 0);
    const cycPerSec = _num(speed, 1) / dur;
    const phase = _num(phase01, 0) + dt * cycPerSec;
    return ((phase % 1) + 1) % 1;
}

function _applyTimelineAnimBlend(fromName, fromPhase, fromSpeed, toName, toPhase, toSpeed, blend01) {
    const t = _smoothstep(_clamp(_num(blend01, 0), 0, 1));
    if (_timelineSameAnim(fromName, toName)) {
        const phase = t < 0.5 ? _num(fromPhase, 0) : _num(toPhase, 0);
        const speed = THREE.MathUtils.lerp(_num(fromSpeed, 1), _num(toSpeed, 1), t);
        _applyTimelineAnimState((t < 0.5 ? fromName : toName), phase, speed);
        return;
    }

    const fromAct = _timelineGetAction(fromName);
    const toAct = _timelineGetAction(toName);

    if (!fromAct && !toAct) {
        _timelineStopUnusedActions([]);
        anim.action = null;
        anim.selectedName = null;
        return;
    }
    if (!fromAct) {
        _applyTimelineAnimState(toName, toPhase, toSpeed);
        return;
    }
    if (!toAct) {
        _applyTimelineAnimState(fromName, fromPhase, fromSpeed);
        return;
    }

    _timelineStopUnusedActions([fromAct, toAct]);
    _timelinePoseAction(fromAct, fromName, fromPhase, fromSpeed, 1 - t);
    _timelinePoseAction(toAct, toName, toPhase, toSpeed, t);

    anim.action = (t >= 0.5) ? toAct : fromAct;
    anim.selectedName = (t >= 0.5) ? (toName ?? null) : (fromName ?? null);
    anim.blendRemaining = 0;
    anim.blendPauseAfter = false;
    anim.blendFrom = null;
    try { if (anim.mixer) anim.mixer.update(0); } catch { }
    try { fromAct.paused = true; } catch { }
    try { toAct.paused = true; } catch { }
}

function _findTimelineAnimTransition(keys, tt, xfade) {
    if (!(xfade > 1e-6) || !Array.isArray(keys) || keys.length < 2) return null;
    const half = xfade * 0.5;
    let best = null;
    for (let j = 1; j < keys.length; j++) {
        const fromName = (keys[j - 1]?.a ?? null);
        const toName = (keys[j]?.a ?? null);
        if (_timelineSameAnim(fromName, toName)) continue;
        const changeT = _num(keys[j]?.t, 0);
        if (tt < changeT - half || tt > changeT + half) continue;
        const dist = Math.abs(tt - changeT);
        if (!best || dist < best.dist) {
            best = { index: j, dist, changeT, fromKey: keys[j - 1], toKey: keys[j] };
        }
    }
    if (!best) return null;
    best.blend01 = _clamp((tt - (best.changeT - half)) / Math.max(1e-6, xfade), 0, 1);
    return best;
}

function _setTimelineAnimImmediate(name) {
    const prevXfade = ui && ui.animXfade ? ui.animXfade.value : null;
    try {
        if (ui && ui.animXfade) ui.animXfade.value = '0';
        if (name === null || typeof name === 'undefined') setAnimNone();
        else setAnimByName(name);
    } finally {
        if (ui && ui.animXfade && prevXfade !== null) ui.animXfade.value = prevXfade;
    }
    anim.blendRemaining = 0;
    anim.blendPauseAfter = false;
    anim.blendFrom = null;
    try { if (anim.action) anim.action.paused = true; } catch { }
    try { if (anim.mixer) anim.mixer.update(0); } catch { }
}

function captureKey(t) {
    const p = getActiveActor().position;
    const q = getActiveActor().quaternion;
    const s = getActiveActor().scale;

    // Animation state (name + phase) so replay matches exactly
    const a = anim.selectedName; // null => none
    const at = getAnimPhase01(); // 0..1

    const keys = getActiveKeys();
    const key = {
        t,
        p: [p.x, p.y, p.z],
        q: [q.x, q.y, q.z, q.w],
        s: [s.x, s.y, s.z],
        a,
        at,
        spd: getAnimCycleSpeed(),
    };
    const fpState = _captureFlatplateKeyState(activeCharacter);
    if (fpState) key.fp = _cloneFlatplateKeyState(fpState);
    keys.push(key);
    setActiveKeys(_dedupeAndSortKeys(keys));
    setActiveDuration(Math.max(getActiveDuration(), t));
    _updateCharacterDuration(activeCharacter);
}

function upsertKeyAt(t) {
    // Remove any key extremely close to t, then capture a fresh one at t
    const eps = 1e-5;
    const keys = getActiveKeys().filter(k => Math.abs((+k.t || 0) - t) > eps);
    setActiveKeys(_dedupeAndSortKeys(keys));
    captureKey(t);
    setActiveKeys(_dedupeAndSortKeys(getActiveKeys()));
    _updateCharacterDuration(activeCharacter);
}

function upsertCharacterKeyAt(ch, t) {
    if (!ch) return;
    const prevActive = activeCharacter;
    if (activeCharacter !== ch) setActiveCharacter(ch, { refreshMenu: false });
    try {
        upsertKeyAt(t);
    } finally {
        if (prevActive !== ch) setActiveCharacter(prevActive, { refreshMenu: false });
    }
}

function _cloneKeyframe(k) {
    return {
        t: _num(k?.t, 0),
        p: Array.isArray(k?.p) ? k.p.slice(0, 3).map(n => _num(n, 0)) : [0, 0, 0],
        q: Array.isArray(k?.q) ? k.q.slice(0, 4).map(n => _num(n, 0)) : [0, 0, 0, 1],
        s: Array.isArray(k?.s) ? k.s.slice(0, 3).map(n => _num(n, 1)) : [1, 1, 1],
        a: (k?.a === null || typeof k?.a === 'string') ? k.a : null,
        at: _num(k?.at, 0),
        spd: THREE.MathUtils.clamp(_num(k?.spd ?? k?.speed, 1), 0.05, 3.0),
        fp: _cloneFlatplateKeyState(k?.fp || null),
    };
}

function _captureHistorySnapshot(label = 'timeline-change') {
    return {
        label,
        activeRuntimeUid: activeCharacter?.runtimeUid || null,
        playhead: _num(timeline.playhead, 0),
        duration: _num(timeline.duration, 0),
        backgroundSelection: _cloneBackgroundEntry(backgroundState.currentSelection),
        backgroundKeys: _dedupeAndSortBackgroundKeys(timeline.backgroundKeys || []).map(k => ({
            t: _num(k?.t, 0),
            entry: _cloneBackgroundEntry(k?.entry),
        })),
        characters: characters.map(ch => ({
            runtimeUid: ch.runtimeUid || null,
            duration: _num(ch.duration, 0),
            transform: _makeTransformSnapshotFromObject(ch.group),
            source: ch.source && ch.source.kind === 'flatplate' ? _cloneFlatplateSource(ch.source) : (ch.source ? JSON.parse(JSON.stringify(ch.source)) : null),
            flatplateState: _captureFlatplateKeyState(ch),
            keys: _dedupeAndSortKeys(Array.isArray(ch.keys) ? ch.keys : []).map(_cloneKeyframe),
        })),
    };
}

function _pushUndoSnapshot(label = 'timeline-change') {
    if (historyState.restoring) return;
    historyState.undo.push(_captureHistorySnapshot(label));
    if (historyState.undo.length > HISTORY_LIMIT) historyState.undo.splice(0, historyState.undo.length - HISTORY_LIMIT);
    historyState.redo.length = 0;
}

function _restoreHistorySnapshot(snapshot) {
    if (!snapshot) return false;
    historyState.restoring = true;
    try {
        try { stopRecording(); } catch { }
        try { voice.stop(); } catch { }
        try { foley.stop(); } catch { }
        timeline.playing = false;
        timeline.playbackRate = 1;
        timeline.shuttleStepIndex = 0;
        timeline.shuttleDirection = 1;
        updatePlayButtonIcon();
        timeline._scrubbing = false;

        for (const chSnap of (snapshot.characters || [])) {
            const ch = findCharacterByRuntimeUid(chSnap?.runtimeUid);
            if (!ch || !ch.group) continue;
            ch.keys = _dedupeAndSortKeys(Array.isArray(chSnap?.keys) ? chSnap.keys.map(_cloneKeyframe) : []);
            ch.duration = _num(chSnap?.duration, ch.keys.length ? ch.keys[ch.keys.length - 1].t : 0);
            if (ch.flatplate && chSnap?.source && chSnap.source.kind === 'flatplate') {
                ch.source = _cloneFlatplateSource(chSnap.source);
                Promise.resolve(_applyFlatplateStateToCharacter(ch, chSnap.flatplateState || {
                    fps: ch.source.fps,
                    mode: ch.source.playback,
                    spin: ch.source.spin,
                    planeWidth: ch.source.planeWidth,
                    planeHeight: ch.source.planeHeight,
                    frames: ch.source.frames,
                    sourceName: ch.source.name,
                }, { keepClock: false })).catch(console.warn);
            }
        }

        timeline.backgroundKeys = _dedupeAndSortBackgroundKeys(snapshot.backgroundKeys || []);
        timeline.duration = Math.max(_num(snapshot.duration, 0), getProjectDuration());
        transport.timeSlider.max = String(Math.max(timeline.duration, 0));
        timeline.playhead = _clamp(_num(snapshot.playhead, 0), 0, Math.max(timeline.duration, 0));
        timeline._bgAppliedSignature = null;

        backgroundState.currentSelection = _cloneBackgroundEntry(snapshot.backgroundSelection);

        const restoreActive = snapshot.activeRuntimeUid ? findCharacterByRuntimeUid(snapshot.activeRuntimeUid) : null;
        if (restoreActive) setActiveCharacter(restoreActive, { refreshMenu: false });

        applyTimelineAt(timeline.playhead);
        for (const chSnap of (snapshot.characters || [])) {
            const ch = findCharacterByRuntimeUid(chSnap?.runtimeUid);
            if (!ch || !ch.group) continue;
            _applyTransformSnapshotToObject(ch.group, chSnap?.transform || null);
        }
        syncTransportUI();
        return true;
    } finally {
        historyState.restoring = false;
    }
}

function undoTimelineChange() {
    if (timeline.recording || !historyState.undo.length) return false;
    const current = _captureHistorySnapshot('redo');
    const snapshot = historyState.undo.pop();
    historyState.redo.push(current);
    if (historyState.redo.length > HISTORY_LIMIT) historyState.redo.splice(0, historyState.redo.length - HISTORY_LIMIT);
    return _restoreHistorySnapshot(snapshot);
}

function redoTimelineChange() {
    if (timeline.recording || !historyState.redo.length) return false;
    const current = _captureHistorySnapshot('undo');
    const snapshot = historyState.redo.pop();
    historyState.undo.push(current);
    if (historyState.undo.length > HISTORY_LIMIT) historyState.undo.splice(0, historyState.undo.length - HISTORY_LIMIT);
    return _restoreHistorySnapshot(snapshot);
}

function startRecording() {
    if (!timeline.recArmed) return;
    _pushUndoSnapshot('recording-start');

    // Record from the CURRENT playhead only inside the active scene/take.
    // Keys after the current camera setting stay untouched.
    const t0 = _clamp(timeline.playhead, 0, Math.max(timeline.duration, getProjectDuration()));
    const activeSceneSeg = getCurrentSceneSegment();
    const activeTakeScene = _ensureSceneTakeData(Number(activeSceneSeg.index || 0));
    const activeTake = activeTakeScene.takes[activeTakeScene.selectedTakeIndex] || activeTakeScene.takes[0] || null;
    if (activeTake) _storeCurrentSceneIntoTake(Number(activeSceneSeg.index || 0), activeTake);
    const activeKeys0 = getActiveKeys();
    if (activeKeys0.length) {
        const eps = 1e-6;
        setActiveKeys(activeKeys0.filter(k => k.t <= t0 + eps || k.t > activeSceneSeg.end + eps));
    }

    _updateCharacterDuration(activeCharacter);
    timeline.duration = getProjectDuration();
    transport.timeSlider.max = String(Math.max(timeline.duration, 0));
    timeline._recAccum = 0;
    timeline._lastRecT = t0;
    timeline._nextRecT = t0 + TL_DT;
    timeline.recording = true;
    timeline.playing = false;
    timeline.playbackRate = 1;
    timeline.shuttleStepIndex = 0;
    timeline.shuttleDirection = 1;
    updatePlayButtonIcon();
    transport.recLamp.classList.add("recording");

    // Ensure there's an exact key at the branch point with the CURRENT pose.
    upsertKeyAt(t0);
    upsertBackgroundKeyAt(t0, backgroundState.currentSelection);

    // While recording, the playhead advances from the branch point,
    // not from the project's global max duration.
    timeline.playhead = t0;
    applyTimelineAt(timeline.playhead, { excludeCharacter: activeCharacter });
    syncTransportUI();
}

function stopRecording() {
    if (!timeline.recording) return;
    timeline.recording = false;
    transport.recLamp.classList.remove("recording");
    // Store a final key so the release pose is captured for the ACTIVE character.
    const t = _clamp(timeline.playhead, 0, Math.max(timeline.playhead, getActiveDuration(), getProjectDuration()));
    upsertKeyAt(t);
    _updateCharacterDuration(activeCharacter);
    const activeSceneSeg = getCurrentSceneSegment();
    const activeTakeScene = _ensureSceneTakeData(Number(activeSceneSeg.index || 0));
    const activeTake = activeTakeScene.takes[activeTakeScene.selectedTakeIndex] || activeTakeScene.takes[0] || null;
    if (activeTake) _storeCurrentSceneIntoTake(Number(activeSceneSeg.index || 0), activeTake);
    takeManagerState.activeSceneIndex = -1;
    takeManagerState.activeTakeId = null;
    timeline.playhead = t;
    timeline.duration = getProjectDuration();
    transport.timeSlider.max = String(Math.max(timeline.duration, 0));
    timeline._nextRecT = timeline.playhead + TL_DT;
    syncTransportUI();
}

function rewindTimeline() {
    try { voice.stop(); } catch { }
    try { foley.stop(); } catch { }
    timeline.playing = false;
    timeline.playbackRate = 1;
    timeline.shuttleStepIndex = 0;
    timeline.shuttleDirection = 1;
    updatePlayButtonIcon();
    const scene = getCurrentSceneSegment();
    timeline.playhead = scene.start;
    applyTimelineAt(timeline.playhead);
    syncTransportUI();
}

function updatePlayButtonIcon() {
    if (!transport.playBtn) return;
    transport.playBtn.textContent = timeline.playing
        ? (timeline.playbackRate < 0 ? "⏪" : "⏸")
        : "▶";
}

function stopTimelinePlayback() {
    timeline.playing = false;
    timeline.playbackRate = 1;
    timeline.shuttleStepIndex = 0;
    timeline.shuttleDirection = 1;
    try { voice.stop(); } catch { }
    try { foley.stop(); } catch { }
    updatePlayButtonIcon();
}

function setTimelinePlaybackRate(rate, { resetStepIndex = false } = {}) {
    const safeRate = Number.isFinite(rate) && Math.abs(rate) > 0 ? rate : 1;
    timeline.playbackRate = safeRate;
    timeline.playing = true;
    if (resetStepIndex) timeline.shuttleStepIndex = 0;
    timeline.shuttleDirection = safeRate < 0 ? -1 : 1;
    if (safeRate <= 0) {
        try { voice.stop(); } catch { }
        try { foley.stop(); } catch { }
    }
    updatePlayButtonIcon();
}

function shuttleTimeline(direction) {
    if (timeline.recording) return;
    const dir = direction < 0 ? -1 : 1;
    if (timeline.playing && Math.sign(timeline.playbackRate || dir) === dir) {
        timeline.shuttleStepIndex = Math.min(JKL_SHUTTLE_SPEEDS.length - 1, _num(timeline.shuttleStepIndex, 0) + 1);
    } else {
        timeline.shuttleStepIndex = 0;
    }
    const rate = JKL_SHUTTLE_SPEEDS[Math.max(0, Math.min(JKL_SHUTTLE_SPEEDS.length - 1, timeline.shuttleStepIndex))] * dir;
    setTimelinePlaybackRate(rate);
    syncTransportUI();
}

function pauseTimelinePlayback() {
    stopTimelinePlayback();
    syncTransportUI();
}

function stepTimelineFrame(direction, dt = PRECISE_STEP_DT) {
    if (timeline.recording) return;
    stopTimelinePlayback();
    const projectDuration = Math.max(0, getProjectDuration(), +timeline.duration || 0);
    timeline.playhead = _clamp(_num(timeline.playhead, 0) + (direction < 0 ? -1 : 1) * Math.max(1 / 240, _num(dt, PRECISE_STEP_DT)), 0, projectDuration);
    applyTimelineAt(timeline.playhead);
    syncTransportUI();
}

function writeManualKeyframeAtPlayhead() {
    if (timeline.recording || !activeCharacter) return false;
    const eps = 1e-6;
    const t = Math.max(0, _num(timeline.playhead, 0));
    const nextT = t + Math.max(1 / 240, _num(TL_DT, 1 / 30));

    const actor = getActiveActor();
    if (!actor) return false;

    _pushUndoSnapshot('manual-keyframe-record');

    const p = actor.position;
    const q = actor.quaternion;
    const s = actor.scale;
    const fpState = _captureFlatplateKeyState(activeCharacter);
    const poseKey = {
        p: [p.x, p.y, p.z],
        q: [q.x, q.y, q.z, q.w],
        s: [s.x, s.y, s.z],
        a: anim.selectedName,
        at: getAnimPhase01(),
        spd: getAnimCycleSpeed(),
        fp: fpState ? _cloneFlatplateKeyState(fpState) : undefined,
    };

    const existing = getActiveKeys().filter(k => {
        const kt = _num(k?.t, 0);
        return Math.abs(kt - t) > eps && Math.abs(kt - nextT) > eps;
    });

    const keyA = { ...poseKey, t };
    const keyB = { ...poseKey, t: nextT, fp: poseKey.fp ? _cloneFlatplateKeyState(poseKey.fp) : undefined };
    existing.push(keyA, keyB);
    setActiveKeys(_dedupeAndSortKeys(existing));
    setActiveDuration(Math.max(getActiveDuration(), nextT));
    _updateCharacterDuration(activeCharacter);

    upsertBackgroundKeyAt(t, backgroundState.currentSelection);
    upsertBackgroundKeyAt(nextT, backgroundState.currentSelection);

    timeline.duration = Math.max(getProjectDuration(), _num(timeline.duration, 0), nextT, getActiveDuration());
    transport.timeSlider.max = String(Math.max(timeline.duration, 0));
    timeline.playhead = nextT;
    applyTimelineAt(timeline.playhead);
    syncTransportUI();
    return true;
}

function togglePlay() {
    if (timeline.recording) return;
    const totalKeyCount = characters.reduce((n, ch) => n + ((ch.keys && ch.keys.length) || 0), 0);
    if (totalKeyCount < 2) return;
    const projectDuration = Math.max(0, getProjectDuration(), +timeline.duration || 0);
    if (!timeline.playing) {
        if (timeline.playhead >= projectDuration - 1e-6 || timeline.playhead < 0) {
            timeline.playhead = 0;
            applyTimelineAt(timeline.playhead);
            syncTransportUI();
        }
        timeline.shuttleStepIndex = 0;
        setTimelinePlaybackRate(1, { resetStepIndex: true });
    } else {
        stopTimelinePlayback();
    }
    updatePlayButtonIcon();
}

function setRecArmed(on) {
    timeline.recArmed = !!on;
    transport.recBtn.classList.toggle("active", timeline.recArmed);
    transport.recLamp.classList.toggle("armed", timeline.recArmed);
    if (!timeline.recArmed) stopRecording();
}

function toggleCleanfeedUI(force = null) {
    const next = (force == null) ? !document.body.classList.contains("cleanfeed-hide") : !!force;
    document.body.classList.toggle("cleanfeed-hide", next);
    if (next) {
        closeFileMenu();
        try { closeBackgroundBrowser(); } catch { }
        try { hideAnimMenu(); } catch { }
    }
    try { updateSelectionOutline(); } catch { }
}

async function toggleFullscreen() {
    try {
        if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
        else await document.exitFullscreen();
    } catch (err) {
        console.warn("Fullscreen toggle failed", err);
    }
}

const keys = new Set();

if (shortcutUI.close) shortcutUI.close.addEventListener("click", closeShortcutModal);
if (shortcutUI.resetAll) shortcutUI.resetAll.addEventListener("click", resetAllShortcuts);
if (shortcutUI.modal) shortcutUI.modal.addEventListener("click", (e) => { if (e.target === shortcutUI.modal) closeShortcutModal(); });
if (shortcutUI.panel) shortcutUI.panel.addEventListener("click", (e) => e.stopPropagation());
if (transport.shortcutMenuBtn) transport.shortcutMenuBtn.addEventListener("click", () => { closeFileMenu(); openShortcutModal(); });
if (languageUI.menuBtn) languageUI.menuBtn.addEventListener("click", () => { openLanguageModal(); });
if (languageUI.close) languageUI.close.addEventListener("click", () => { closeLanguageModal(); });
if (languageUI.apply) languageUI.apply.addEventListener("click", async () => { await setLanguage(languageUI.select?.value || "en"); closeLanguageModal(); });
if (languageUI.select) languageUI.select.addEventListener("change", async () => { await setLanguage(languageUI.select.value || "en"); });
renderShortcutUI();
refreshShortcutHints();
if (fileMenu) fileMenu.addEventListener("click", (e) => e.stopPropagation());
window.addEventListener("click", () => closeFileMenu());

function _eventTargetsEditableField(evt) {
    const el = evt?.target instanceof Element ? evt.target : document.activeElement;
    if (!el) return false;
    const field = el.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], [contenteditable]');
    if (!field) return false;
    if (field instanceof HTMLInputElement) {
        const type = String(field.type || 'text').toLowerCase();
        return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file'].includes(type);
    }
    return true;
}

function _takeManagerOwnsEventTarget(evt) {
    const el = evt?.target instanceof Element ? evt.target : null;
    return !!(el && takeUI.wrap && takeUI.wrap.contains(el));
}

function stopShortcutCapture() {
    shortcutCaptureId = null;
    renderShortcutUI();
}

const _tmpRotationAxisVec = new THREE.Vector3();
function getRotationAxisFromHeldKeys() {
    if (keys.has('x')) return 'x';
    if (keys.has('y')) return 'y';
    if (keys.has('z')) return 'z';
    return null;
}

window.addEventListener("keydown", (e) => {
    if (shortcutCaptureId) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") {
            stopShortcutCapture();
            return;
        }
        const combo = shortcutFromEvent(e);
        if (combo) setShortcut(shortcutCaptureId, combo);
        return;
    }
    const k0 = e.key;
    const combo = shortcutFromEvent(e);
    const baseKey = normalizeShortcutKeyName(k0).toLowerCase();

    if (_eventTargetsEditableField(e)) {
        if (combo) keys.delete(combo.toLowerCase());
        if (baseKey) keys.delete(baseKey);
        return;
    }

    if (combo) keys.add(combo.toLowerCase());
    if (baseKey) keys.add(baseKey);


    if ((e.ctrlKey || e.metaKey) && baseKey === 'r') {
        e.preventDefault();
        e.stopPropagation();
        writeManualKeyframeAtPlayhead();
        return;
    }

    if (eventMatchesShortcut(e, "togglePlay")) {
        e.preventDefault();
        e.stopPropagation();
        togglePlay();
        return;
    }
    if (eventMatchesShortcut(e, "pausePlayback")) {
        e.preventDefault();
        e.stopPropagation();
        pauseTimelinePlayback();
        return;
    }
    if (eventMatchesShortcut(e, "manualKeyframe")) {
        e.preventDefault();
        e.stopPropagation();
        writeManualKeyframeAtPlayhead();
        return;
    }
    if (eventMatchesShortcut(e, "playReverse")) {
        e.preventDefault();
        e.stopPropagation();
        if (pressedShortcutForAction("pausePlayback")) stepTimelineFrame(-1);
        else shuttleTimeline(-1);
        return;
    }
    if (eventMatchesShortcut(e, "playForward")) {
        e.preventDefault();
        e.stopPropagation();
        if (pressedShortcutForAction("pausePlayback")) stepTimelineFrame(1);
        else shuttleTimeline(1);
        return;
    }
    if (eventMatchesShortcut(e, "rewindTimeline")) {
        e.preventDefault();
        e.stopPropagation();
        rewindTimeline();
        return;
    }
    if (eventMatchesShortcut(e, "toggleMenu")) {
        e.preventDefault();
        e.stopPropagation();
        toggleMenu();
        return;
    }
    if (eventMatchesShortcut(e, "openShortcuts")) {
        e.preventDefault();
        e.stopPropagation();
        openShortcutModal();
        return;
    }
    if (eventMatchesShortcut(e, "toggleCleanfeed")) {
        e.preventDefault();
        e.stopPropagation();
        toggleCleanfeedUI();
        return;
    }
    if (eventMatchesShortcut(e, "toggleRecArmed")) {
        e.preventDefault();
        e.stopPropagation();
        setRecArmed(!timeline.recArmed);
        return;
    }
    if (eventMatchesShortcut(e, "prevScene")) {
        e.preventDefault();
        e.stopPropagation();
        stepScene(-1);
        return;
    }
    if (eventMatchesShortcut(e, "nextScene")) {
        e.preventDefault();
        e.stopPropagation();
        stepScene(1);
        return;
    }
    if ((e.ctrlKey || e.metaKey) && baseKey === 'z') {
        e.preventDefault();
        if (e.shiftKey) redoTimelineChange();
        else undoTimelineChange();
        return;
    }
    if (eventMatchesShortcut(e, "toggleFullscreen")) {
        e.preventDefault();
        e.stopPropagation();
        toggleFullscreen();
    }
}, true);
addEventListener("keyup", (e) => {
    const combo = shortcutFromEvent(e);
    if (combo) keys.delete(combo.toLowerCase());
    keys.delete(normalizeShortcutKeyName(e.key).toLowerCase());
    if (_eventTargetsEditableField(e)) {
        _finishManualMoveGesture();
        return;
    }
    const stillMoving = [
        shortcuts.moveLeft, shortcuts.moveRight, shortcuts.moveForward, shortcuts.moveBackward, shortcuts.moveDown, shortcuts.moveUp,
        "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"
    ].map(v => normalizeShortcutString(v).toLowerCase()).filter(Boolean).some(code => keys.has(code));
    if (!stillMoving) _finishManualMoveGesture();
});

function _applyCharacterDepthClipMaterials(root) {
    if (!root) return;
    root.traverse((o) => {
        if (!o.isMesh) return;

        const applyDepthClip = (mat) => {
            if (!mat || mat.userData.__depthClipPatched) return mat;
            mat.userData.__depthClipPatched = true;

            mat.transparent = true;
            mat.opacity = 1.0;
            mat.depthWrite = true;
            mat.depthTest = true;

            mat.onBeforeCompile = (shader) => {
                shader.uniforms.uDepth = { value: depthTex };
                shader.uniforms.uScreenPx = { value: screenPx };
                shader.uniforms.uCover = { value: cover };

                shader.uniforms.uScale = { value: cubeMat.uniforms.uScale.value };
                shader.uniforms.uOffset = { value: cubeMat.uniforms.uOffset.value };
                shader.uniforms.uFlip = { value: cubeMat.uniforms.uFlip.value };
                shader.uniforms.uRot = { value: cubeMat.uniforms.uRot.value };

                shader.uniforms.uNear = { value: cubeMat.uniforms.uNear.value };
                shader.uniforms.uFar = { value: cubeMat.uniforms.uFar.value };

                shader.uniforms.uBias = { value: cubeMat.uniforms.uBias.value };
                shader.uniforms.uClipSoft = { value: cubeMat.uniforms.uClipSoft.value };

                shader.uniforms.uDfRadius = { value: cubeMat.uniforms.uDfRadius.value };
                shader.uniforms.uDfEdge = { value: cubeMat.uniforms.uDfEdge.value };

                mat.userData.__dcUniforms = shader.uniforms;

                shader.fragmentShader =
                    `uniform sampler2D uDepth;\n` +
                    `uniform vec2 uScreenPx;\n` +
                    `uniform vec4 uCover;\n` +
                    `uniform vec2 uScale;\n` +
                    `uniform vec2 uOffset;\n` +
                    `uniform vec2 uFlip;\n` +
                    `uniform float uRot;\n` +
                    `uniform float uNear;\n` +
                    `uniform float uFar;\n` +
                    `uniform float uBias;\n` +
                    `uniform float uClipSoft;\n` +
                    `uniform float uDfRadius;\n` +
                    `uniform float uDfEdge;\n` +
                    shader.fragmentShader;

                const helpers = `
float linearizeDepth01(float depthNdc01, float near, float far){
  float z = depthNdc01 * 2.0 - 1.0;
  float viewZ = (2.0 * near * far) / (far + near - z * (far - near));
  return clamp((viewZ - near) / (far - near), 0.0, 1.0);
}

vec2 rotate90(vec2 uv, float r){
  if (r < 0.5) return uv;
  if (r < 1.5) return vec2(uv.y, 1.0 - uv.x);
  if (r < 2.5) return vec2(1.0 - uv.x, 1.0 - uv.y);
  return vec2(1.0 - uv.y, uv.x);
}

float bgDepthAtScreenUV(vec2 suv){
  vec2 uv = suv;
  uv = rotate90(uv, uRot);
  if (uFlip.x > 0.5) uv.x = 1.0 - uv.x;
  if (uFlip.y > 0.5) uv.y = 1.0 - uv.y;
  uv = uv * uScale + uOffset;
  uv = uv * uCover.xy + uCover.zw;
  uv = clamp(uv, vec2(0.0), vec2(1.0));
  return texture2D(uDepth, uv).r;
}

float bgDepthFiltered(vec2 suv){
  float resultDepth = bgDepthAtScreenUV(suv);
  if (uDfRadius <= 0.001) return resultDepth;

  vec2 texel = 1.0 / uScreenPx;
  float centerD = bgDepthAtScreenUV(suv);

  float sigmaS = max(uDfRadius * 0.75, 0.001);
  float sigmaD = max(uDfEdge, 0.0005);

  float sumW = 0.0;
  float sumD = 0.0;

  for (int y=-3; y<=3; y++){
    for (int x=-3; x<=3; x++){
      vec2 o = vec2(float(x), float(y));
      float r = length(o);
      if (r > uDfRadius) continue;

      vec2 p = suv + o * texel;
      float d = bgDepthAtScreenUV(p);

      float ws = exp(-(r*r) / (2.0*sigmaS*sigmaS));
      float dd = d - centerD;
      float wd = exp(-(dd*dd) / (2.0*sigmaD*sigmaD));

      float w = ws * wd;
      sumW += w;
      sumD += w * d;
    }
  }
  resultDepth = sumD / max(sumW, 1e-6);
  return resultDepth;
}
`;
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <common>',
                    '#include <common>\n' + helpers
                );

                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <dithering_fragment>',
                    `// --- Depth clip (same logic as cubeMat) ---\n` +
                    `vec2 _dcSuv = gl_FragCoord.xy / uScreenPx;\n` +
                    `float _bgDepth01 = bgDepthFiltered(_dcSuv);\n` +
                    `float _fragDepth01 = linearizeDepth01(gl_FragCoord.z, uNear, uFar);\n` +
                    `float _d = (_bgDepth01 + uBias) - _fragDepth01;\n` +
                    `float _a = 1.0;\n` +
                    `if (uClipSoft > 0.00001){\n` +
                    `  if (_d < -uClipSoft) discard;\n` +
                    `  _a = smoothstep(-uClipSoft, 0.0, _d);\n` +
                    `} else {\n` +
                    `  if (_d < 0.0) discard;\n` +
                    `}\n` +
                    `gl_FragColor.a *= _a;\n` +
                    `#include <dithering_fragment>`
                );
            };

            mat.needsUpdate = true;
            return mat;
        };

        if (Array.isArray(o.material)) o.material = o.material.map(applyDepthClip);
        else o.material = applyDepthClip(o.material);

        o.renderOrder = 0;
        o.frustumCulled = false;
        if (typeof o.castShadow !== "undefined") o.castShadow = false;
        if (typeof o.receiveShadow !== "undefined") o.receiveShadow = false;
    });
}
function _fitCharacterLikeGregory(root, group) {
    if (!root || !group) return;
    try {
        root.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(root);
        if (box.isEmpty()) return;
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);

        root.position.x -= center.x;
        root.position.y -= box.min.y;
        root.position.z -= center.z;
        root.updateMatrixWorld(true);

        if (gregoryReferenceSize.y > 1e-6 && size.y > 1e-6) {
            const hMul = gregoryReferenceSize.y / size.y;
            const xMul = (gregoryReferenceSize.x > 1e-6 && size.x > 1e-6) ? (gregoryReferenceSize.x / size.x) : hMul;
            const zMul = (gregoryReferenceSize.z > 1e-6 && size.z > 1e-6) ? (gregoryReferenceSize.z / size.z) : hMul;
            const mul = Math.min(hMul, xMul, zMul);
            group.scale.set(mul, mul, mul);
        }
        group.updateMatrixWorld(true);
    } catch { }
}
function _normalizeCharacterRootPivot(root) {
    try {
        root.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(root);
        if (box.isEmpty()) return;
        const center = new THREE.Vector3();
        box.getCenter(center);
        root.position.x -= center.x;
        root.position.y -= box.min.y;
        root.position.z -= center.z;
        root.updateMatrixWorld(true);
    } catch { }
}
function _fitCharacterScaleToGregory(root, group) {
    if (!(gregoryReferenceHeight > 1e-6)) return;
    try {
        root.updateMatrixWorld(true);
        group.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(root);
        const size = new THREE.Vector3();
        box.getSize(size);
        if (size.y > 1e-6) {
            const mul = gregoryReferenceHeight / size.y;
            group.scale.multiplyScalar(mul);
            group.updateMatrixWorld(true);
        }
    } catch { }
}
function _setupImportedCharacterAnimations(ch, gltf) {
    const state = _makeAnimState();
    state.root = ch.root;
    state.clips = (gltf.animations || []).slice();
    state.actions = new Map();
    state.mixer = new THREE.AnimationMixer(ch.root);
    try {
        const rest = makeRestPoseAction(ch.root, state.mixer);
        if (rest) { state.restClip = rest.clip; state.restAction = rest.action; }
    } catch (e) { console.warn('Failed to build rest pose clip for imported character', e); }
    if (state.clips.length) {
        for (const clip of state.clips) {
            const a = state.mixer.clipAction(clip);
            a.enabled = true;
            a.paused = true;
            a.setLoop(THREE.LoopRepeat, Infinity);
            state.actions.set(_low(clip.name), a);
        }
    }
    ch.animState = state;
}


function _cloneFlatplateSource(source) {
    if (!source || source.kind !== 'flatplate') return source ? JSON.parse(JSON.stringify(source)) : null;
    return {
        kind: 'flatplate',
        name: String(source.name || 'flatplate'),
        fps: Math.max(1, _num(source.fps, 24)),
        playback: _normalizeFlatplateModeValue(source.playback || source.mode || 'forward'),
        stopAtLastFrame: !!source.stopAtLastFrame,
        infinite: _normalizeFlatplateInfinite(source.infinite),
        repeats: _normalizeFlatplateRepeatCount(source.repeats, 1),
        billboard: source.billboard !== false,
        spin: _num(source.spin, 0),
        planeWidth: Math.max(0.05, _num(source.planeWidth, 1)),
        planeHeight: Math.max(0.05, _num(source.planeHeight, gregoryReferenceHeight > 1e-6 ? gregoryReferenceHeight : 1.8)),
        frames: Array.isArray(source.frames) ? source.frames.map(f => ({
            name: String(f?.name || 'frame.png'),
            dataUrl: String(f?.dataUrl || ''),
            width: Math.max(1, _num(f?.width, 1)),
            height: Math.max(1, _num(f?.height, 1)),
        })).filter(f => !!f.dataUrl) : [],
    };
}
function _captureFlatplateKeyState(ch) {
    if (!ch || !ch.flatplate || !ch.source || ch.source.kind !== 'flatplate') return null;
    return {
        fps: Math.max(1, _num(ch.flatplate.fps ?? ch.source.fps, 24)),
        mode: _normalizeFlatplateModeValue(ch.flatplate.mode || ch.source.playback || ch.source.mode || 'forward'),
        stopAtLastFrame: !!(ch.flatplate.stopAtLastFrame ?? ch.source.stopAtLastFrame),
        infinite: _normalizeFlatplateInfinite(ch.flatplate.infinite ?? ch.source.infinite),
        repeats: _normalizeFlatplateRepeatCount(ch.flatplate.repeats ?? ch.source.repeats, 1),
        spin: _num(ch.flatplate.spin ?? ch.source.spin, 0),
        playing: !!ch.flatplate.playing,
        anchorPlayhead: Number.isFinite(+ch.flatplate.anchorPlayhead) ? +ch.flatplate.anchorPlayhead : _num(timeline?.playhead, 0),
        anchorFrame: Math.max(0, Math.floor(_num(ch.flatplate.anchorFrame, 0))),
        pausedFrame: Math.max(0, Math.floor(_num(ch.flatplate.pausedFrame, ch.flatplate.currentFrame >= 0 ? ch.flatplate.currentFrame : 0))),
        planeWidth: Math.max(0.05, _num(ch.source.planeWidth, 1)),
        planeHeight: Math.max(0.05, _num(ch.source.planeHeight, gregoryReferenceHeight > 1e-6 ? gregoryReferenceHeight : 1.8)),
        frames: Array.isArray(ch.source.frames) ? ch.source.frames.map(f => ({
            name: String(f?.name || 'frame.png'),
            dataUrl: String(f?.dataUrl || ''),
            width: Math.max(1, _num(f?.width, 1)),
            height: Math.max(1, _num(f?.height, 1)),
        })).filter(f => !!f.dataUrl) : [],
        sourceName: String(ch.source.name || ch.name || 'flatplate'),
    };
}
function _cloneFlatplateKeyState(state) {
    if (!state) return null;
    return {
        fps: Math.max(1, _num(state.fps, 24)),
        mode: _normalizeFlatplateModeValue(state.mode || 'forward'),
        stopAtLastFrame: !!state.stopAtLastFrame,
        infinite: _normalizeFlatplateInfinite(state.infinite),
        repeats: _normalizeFlatplateRepeatCount(state.repeats, 1),
        spin: _num(state.spin, 0),
        playing: !!state.playing,
        anchorPlayhead: Number.isFinite(+state.anchorPlayhead) ? +state.anchorPlayhead : 0,
        anchorFrame: Math.max(0, Math.floor(_num(state.anchorFrame, 0))),
        pausedFrame: Math.max(0, Math.floor(_num(state.pausedFrame, state.anchorFrame ?? 0))),
        planeWidth: Math.max(0.05, _num(state.planeWidth, 1)),
        planeHeight: Math.max(0.05, _num(state.planeHeight, gregoryReferenceHeight > 1e-6 ? gregoryReferenceHeight : 1.8)),
        frames: Array.isArray(state.frames) ? state.frames.map(f => ({
            name: String(f?.name || 'frame.png'),
            dataUrl: String(f?.dataUrl || ''),
            width: Math.max(1, _num(f?.width, 1)),
            height: Math.max(1, _num(f?.height, 1)),
        })).filter(f => !!f.dataUrl) : [],
        sourceName: String(state.sourceName || 'flatplate'),
    };
}
function _getFlatplateAspectFromFrames(frameStates, fallbackAspect = 1) {
    const first = Array.isArray(frameStates) ? frameStates.find(f => f && Number.isFinite(+f.width) && Number.isFinite(+f.height) && +f.width > 0 && +f.height > 0) : null;
    if (!first) return Math.max(1 / 64, Math.min(64, _num(fallbackAspect, 1)));
    return Math.max(1 / 64, Math.min(64, _num(first.width, 1) / Math.max(1, _num(first.height, 1))));
}
function _getFlatplateFrameAspect(frame, fallbackAspect = 1) {
    if (!frame || !Number.isFinite(+frame.width) || !Number.isFinite(+frame.height) || +frame.width <= 0 || +frame.height <= 0) {
        return Math.max(1 / 64, Math.min(64, _num(fallbackAspect, 1)));
    }
    return Math.max(1 / 64, Math.min(64, _num(frame.width, 1) / Math.max(1, _num(frame.height, 1))));
}
function _computeFlatplatePlaneSizeFromFrames(frameStates, fallbackHeight) {
    const aspect = _getFlatplateAspectFromFrames(frameStates, 1);
    const planeHeight = Math.max(0.05, _num(fallbackHeight, gregoryReferenceHeight > 1e-6 ? gregoryReferenceHeight : 1.8));
    const planeWidth = Math.max(0.05, planeHeight * aspect);
    return { planeWidth, planeHeight, aspect };
}
function _fitFlatplateWidthToAspect(ch, planeHeight, opts = {}) {
    if (!ch || !ch.source || ch.source.kind !== 'flatplate') return false;
    const height = Math.max(0.05, _num(planeHeight, ch.source.planeHeight || (gregoryReferenceHeight > 1e-6 ? gregoryReferenceHeight : 1.8)));
    const aspect = _getFlatplateAspectFromFrames(ch.source.frames, _num(ch.source.planeWidth, 1) / Math.max(0.05, _num(ch.source.planeHeight, 1)));
    const planeWidth = Math.max(0.05, height * aspect);
    const changed = _applyFlatplatePlaneGeometry(ch, { planeWidth, planeHeight: height });
    if (changed && opts.capture !== false) {
        try { upsertCharacterKeyAt(ch, _clamp(_num(timeline?.playhead, 0), 0, Math.max(getProjectDuration(), _num(timeline?.playhead, 0)))); } catch { }
    }
    return changed;
}
function _flatplateRandomFrameForStep(step, span) {
    let x = (Math.max(0, Math.floor(_num(step, 0))) + 1) | 0;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return Math.abs(x) % Math.max(1, span | 0);
}
function _getFlatplateModeCycleLength(span, mode) {
    const safeSpan = Math.max(1, span | 0);
    if (safeSpan <= 1) return 1;
    const normalizedMode = _normalizeFlatplateModeValue(mode || 'forward');
    if (normalizedMode === 'pingpong') return Math.max(1, safeSpan * 2 - 2);
    return safeSpan;
}
function _getFlatplateTerminalFrameIndex(span, mode, repeats) {
    const safeSpan = Math.max(1, span | 0);
    if (safeSpan <= 1) return 0;
    const normalizedMode = _normalizeFlatplateModeValue(mode || 'forward');
    const safeRepeats = _normalizeFlatplateRepeatCount(repeats, 1);
    if (normalizedMode === 'backward') return 0;
    if (normalizedMode === 'pingpong') return (safeRepeats % 2 === 1) ? 0 : (safeSpan - 1);
    if (normalizedMode === 'random') return _flatplateRandomFrameForStep(_getFlatplateModeCycleLength(safeSpan, normalizedMode) * safeRepeats - 1, safeSpan);
    return safeSpan - 1;
}
function _getFlatplateCurrentStep(fp, nowSec, playheadSec = null) {
    if (!fp) return 0;
    const fps = Math.max(1, _num(fp.fps, 24));
    const baseStep = Math.max(0, Math.floor(_num(fp.anchorFrame, fp.pausedFrame ?? 0)));
    if (playheadSec != null && Number.isFinite(+playheadSec)) {
        if (fp.playing && Number.isFinite(+fp.anchorPlayhead)) {
            const elapsed = Math.max(0, _num(playheadSec, 0) - _num(fp.anchorPlayhead, 0));
            return Math.max(0, baseStep + Math.floor(elapsed * fps));
        }
        return Math.max(0, Math.floor(_num(fp.pausedFrame, baseStep)));
    }
    if (fp.playing) {
        const elapsed = Math.max(0, _num(nowSec, 0) - _num(fp.startedAtSec, nowSec));
        return Math.max(0, baseStep + Math.floor(elapsed * fps));
    }
    return Math.max(0, Math.floor(_num(fp.pausedFrame, baseStep)));
}
function _getFlatplateStepForDisplayedFrameIndex(frameIndex, span, mode, refStep = 0) {
    const safeSpan = Math.max(1, span | 0);
    if (safeSpan <= 1) return 0;
    const idx = THREE.MathUtils.clamp(Math.floor(_num(frameIndex, 0)), 0, safeSpan - 1);
    const normalizedMode = _normalizeFlatplateModeValue(mode || 'forward');
    const cycle = _getFlatplateModeCycleLength(safeSpan, normalizedMode);
    const ref = Math.max(0, Math.floor(_num(refStep, 0)));
    const candidates = [];
    if (normalizedMode === 'forward') {
        candidates.push(idx);
    } else if (normalizedMode === 'backward') {
        candidates.push((safeSpan - 1) - idx);
    } else if (normalizedMode === 'pingpong') {
        const a = idx;
        const b = cycle - idx;
        candidates.push(a);
        if (b !== a && b >= 0) candidates.push(b);
    } else if (normalizedMode === 'random') {
        for (let step = 0; step < cycle; step++) {
            if (_flatplateRandomFrameForStep(step, safeSpan) === idx) candidates.push(step);
        }
    }
    if (!candidates.length) return idx;
    let best = candidates[0];
    let bestDist = Infinity;
    for (const candidate of candidates) {
        const cand = Math.max(0, Math.floor(_num(candidate, 0)));
        const dist = Math.abs(cand - ref);
        if (dist < bestDist || (dist === bestDist && cand < best)) {
            best = cand;
            bestDist = dist;
        }
    }
    return best;
}
function _foldFlatplateFrameStep(step, span, mode, opts = {}) {
    const safeSpan = Math.max(1, span | 0);
    if (safeSpan <= 1) return 0;
    const normalizedMode = _normalizeFlatplateModeValue(mode || 'forward');
    const safeStep = Math.max(0, Math.floor(_num(step, 0)));
    const infinite = _normalizeFlatplateInfinite(opts.infinite);
    const repeats = _normalizeFlatplateRepeatCount(opts.repeats, 1);
    const stopAtLastFrame = !!opts.stopAtLastFrame;
    const cycle = _getFlatplateModeCycleLength(safeSpan, normalizedMode);
    const totalSteps = infinite ? Infinity : Math.max(1, cycle * repeats);
    const isFinished = Number.isFinite(totalSteps) && safeStep >= totalSteps;
    if (isFinished && stopAtLastFrame) return _getFlatplateTerminalFrameIndex(safeSpan, normalizedMode, repeats);
    const wrapped = Number.isFinite(totalSteps) ? (safeStep % totalSteps) : safeStep;
    if (normalizedMode === 'pingpong') {
        const pingWrapped = wrapped % cycle;
        return pingWrapped < safeSpan ? pingWrapped : (cycle - pingWrapped);
    }
    if (normalizedMode === 'forward') return Math.min(safeSpan - 1, wrapped % safeSpan);
    if (normalizedMode === 'backward') return Math.max(0, (safeSpan - 1) - (wrapped % safeSpan));
    if (normalizedMode === 'random') return _flatplateRandomFrameForStep(wrapped, safeSpan);
    return wrapped % safeSpan;
}
function _getFlatplateDisplayedFrameIndex(fp, nowSec, playheadSec = null) {
    if (!fp || !Array.isArray(fp.frames) || !fp.frames.length) return 0;
    const span = fp.frames.length;
    if (span <= 1) return 0;
    const foldOpts = { infinite: fp.infinite, repeats: fp.repeats, stopAtLastFrame: fp.stopAtLastFrame };
    return _foldFlatplateFrameStep(_getFlatplateCurrentStep(fp, nowSec, playheadSec), span, fp.mode, foldOpts);
}
function _startFlatplatePlaybackHold(ch, playheadSec = null) {
    if (!ch || !ch.flatplate) return false;
    const fp = ch.flatplate;
    fp.playing = true;
    fp.previewHoldActive = true;
    fp.anchorFrame = 0;
    fp.pausedFrame = 0;
    fp.startedAtSec = performance.now() / 1000;
    fp.anchorPlayhead = Number.isFinite(+playheadSec) ? +playheadSec : _num(timeline?.playhead, 0);
    _updateFlatplateCharacter(ch, performance.now() / 1000);
    return true;
}
function _stopFlatplatePlaybackHold(ch, playheadSec = null, nowSec = null) {
    if (!ch || !ch.flatplate) return false;
    const fp = ch.flatplate;
    const evalNow = Number.isFinite(+nowSec) ? +nowSec : (performance.now() / 1000);
    const evalPlayhead = Number.isFinite(+playheadSec) ? +playheadSec : ((timeline?.playing || timeline?.recording || timeline?._scrubbing) ? _num(timeline?.playhead, 0) : null);
    const freezeStep = _getFlatplateCurrentStep(fp, evalNow, evalPlayhead);
    const freezeIdx = _getFlatplateDisplayedFrameIndex(fp, evalNow, evalPlayhead);
    fp.playing = false;
    fp.previewHoldActive = false;
    fp.anchorFrame = freezeStep;
    fp.pausedFrame = freezeStep;
    fp.startedAtSec = evalNow;
    if (evalPlayhead != null && Number.isFinite(+evalPlayhead)) fp.anchorPlayhead = +evalPlayhead;
    fp.currentFrame = freezeIdx;
    if (fp.material && Array.isArray(fp.frames) && fp.frames[freezeIdx]) {
        fp.material.map = fp.frames[freezeIdx].texture;
        fp.material.needsUpdate = true;
    }
    return true;
}
function _applyFlatplatePlaneGeometry(ch, size = {}) {
    if (!ch || !ch.root || !(ch.root.isMesh)) return false;
    const planeWidth = Math.max(0.05, _num(size.planeWidth, ch?.source?.planeWidth || 1));
    const planeHeight = Math.max(0.05, _num(size.planeHeight, ch?.source?.planeHeight || (gregoryReferenceHeight > 1e-6 ? gregoryReferenceHeight : 1.8)));
    const geom = new THREE.PlaneGeometry(planeWidth, planeHeight);
    geom.translate(0, planeHeight * 0.5, 0);
    try { if (ch.root.geometry) ch.root.geometry.dispose(); } catch { }
    ch.root.geometry = geom;
    ch.root.updateMatrixWorld(true);
    if (ch.source && ch.source.kind === 'flatplate') {
        ch.source.planeWidth = planeWidth;
        ch.source.planeHeight = planeHeight;
    }
    if (ch.flatplate) {
        ch.flatplate._displayWidth = planeWidth;
        ch.flatplate._displayHeight = planeHeight;
    }
    return true;
}
function _applyFlatplateDisplayFrameGeometry(ch, frame) {
    if (!ch || !ch.root || !(ch.root.isMesh) || !ch.source || ch.source.kind !== 'flatplate') return false;
    const planeHeight = Math.max(0.05, _num(ch.source.planeHeight, gregoryReferenceHeight > 1e-6 ? gregoryReferenceHeight : 1.8));
    const fallbackAspect = Math.max(1 / 64, Math.min(64, _num(ch.source.planeWidth, 1) / Math.max(0.05, planeHeight)));
    const aspect = _getFlatplateFrameAspect(frame, fallbackAspect);
    const planeWidth = Math.max(0.05, planeHeight * aspect);
    const fp = ch.flatplate || {};
    const sameWidth = Math.abs(_num(fp._displayWidth, -1) - planeWidth) <= 1e-6;
    const sameHeight = Math.abs(_num(fp._displayHeight, -1) - planeHeight) <= 1e-6;
    if (sameWidth && sameHeight) return false;
    return _applyFlatplatePlaneGeometry(ch, { planeWidth, planeHeight });
}
async function _loadFlatplateFramesFromState(frameStates) {
    const out = [];
    for (const state of (frameStates || [])) {
        if (!state || !state.dataUrl) continue;
        const loaded = await _dataUrlToTexture(state.dataUrl);
        out.push({
            name: String(state.name || 'frame.png'),
            dataUrl: String(state.dataUrl || ''),
            texture: loaded.texture,
            width: loaded.width,
            height: loaded.height,
        });
    }
    return out;
}
async function _replaceFlatplateFrames(ch, frameStates, meta = {}) {
    if (!ch || !ch.flatplate || !ch.source || ch.source.kind !== 'flatplate') return false;
    const loadedFrames = await _loadFlatplateFramesFromState(frameStates);
    if (!loadedFrames.length) throw new Error('Keine PNG-Frames für Flatplate gefunden.');
    const prevFrames = Array.isArray(ch.flatplate.frames) ? ch.flatplate.frames : [];
    for (const frame of prevFrames) {
        try { if (frame && frame.texture && !loadedFrames.some(nf => nf.texture === frame.texture)) frame.texture.dispose(); } catch { }
    }
    ch.flatplate.frames = loadedFrames;
    ch.flatplate.currentFrame = -1;
    ch.flatplate.playing = false;
    ch.flatplate.previewHoldActive = false;
    ch.flatplate.anchorFrame = 0;
    ch.flatplate.pausedFrame = 0;
    ch.flatplate.startedAtSec = performance.now() / 1000;
    ch.flatplate.anchorPlayhead = _num(timeline?.playhead, 0);
    ch.source.frames = loadedFrames.map(f => ({ name: f.name, dataUrl: f.dataUrl, width: f.width, height: f.height }));
    const nextSize = _computeFlatplatePlaneSizeFromFrames(ch.source.frames, meta && Number.isFinite(+meta.planeHeight) ? +meta.planeHeight : ch.source.planeHeight);
    _applyFlatplatePlaneGeometry(ch, {
        planeWidth: (meta && Number.isFinite(+meta.planeWidth)) ? +meta.planeWidth : nextSize.planeWidth,
        planeHeight: (meta && Number.isFinite(+meta.planeHeight)) ? +meta.planeHeight : nextSize.planeHeight,
    });
    if (meta && meta.sourceName) ch.source.name = String(meta.sourceName || ch.source.name || ch.name || 'flatplate');
    if (meta && meta.renameCharacter && meta.sourceName) ch.name = String(meta.sourceName);
    if (ch.flatplate.material) {
        ch.flatplate.material.map = loadedFrames[0].texture;
        ch.flatplate.material.needsUpdate = true;
    }
    _updateFlatplateCharacter(ch, performance.now() / 1000);
    return true;
}
async function _applyFlatplateStateToCharacter(ch, fpState, opts = {}) {
    if (!ch || !ch.flatplate || !fpState) return false;
    const normalized = _cloneFlatplateKeyState(fpState);
    ch.flatplate.fps = Math.max(1, _num(normalized.fps, 24));
    ch.flatplate.mode = _normalizeFlatplateModeValue(normalized.mode || 'forward');
    ch.flatplate.stopAtLastFrame = !!normalized.stopAtLastFrame;
    ch.flatplate.infinite = _normalizeFlatplateInfinite(normalized.infinite);
    ch.flatplate.repeats = _normalizeFlatplateRepeatCount(normalized.repeats, 1);
    ch.flatplate.spin = _num(normalized.spin, 0);
    ch.flatplate.playing = !!normalized.playing;
    ch.flatplate.previewHoldActive = false;
    ch.flatplate.anchorPlayhead = Number.isFinite(+normalized.anchorPlayhead) ? +normalized.anchorPlayhead : _num(timeline?.playhead, 0);
    ch.flatplate.anchorFrame = Math.max(0, Math.floor(_num(normalized.anchorFrame, 0)));
    ch.flatplate.pausedFrame = Math.max(0, Math.floor(_num(normalized.pausedFrame, ch.flatplate.anchorFrame)));
    if (ch.source && ch.source.kind === 'flatplate') {
        ch.source.fps = ch.flatplate.fps;
        ch.source.playback = ch.flatplate.mode;
        ch.source.stopAtLastFrame = ch.flatplate.stopAtLastFrame;
        ch.source.infinite = ch.flatplate.infinite;
        ch.source.repeats = ch.flatplate.repeats;
        ch.source.spin = ch.flatplate.spin;
    }
    const normalizedPlaneSize = {
        planeWidth: Math.max(0.05, _num(normalized.planeWidth, ch?.source?.planeWidth || 1)),
        planeHeight: Math.max(0.05, _num(normalized.planeHeight, ch?.source?.planeHeight || (gregoryReferenceHeight > 1e-6 ? gregoryReferenceHeight : 1.8))),
    };
    if (Array.isArray(normalized.frames) && normalized.frames.length) {
        const currentSig = JSON.stringify((ch.source && Array.isArray(ch.source.frames)) ? ch.source.frames.map(f => [f.name || '', f.dataUrl || '']) : []);
        const nextSig = JSON.stringify(normalized.frames.map(f => [f.name || '', f.dataUrl || '']));
        if (currentSig !== nextSig) {
            await _replaceFlatplateFrames(ch, normalized.frames, {
                sourceName: normalized.sourceName || (ch.source && ch.source.name) || ch.name || 'flatplate',
                planeWidth: normalizedPlaneSize.planeWidth,
                planeHeight: normalizedPlaneSize.planeHeight,
            });
        } else {
            _applyFlatplatePlaneGeometry(ch, normalizedPlaneSize);
            if (ch.source && ch.source.kind === 'flatplate') {
                ch.source.name = String(normalized.sourceName || ch.source.name || ch.name || 'flatplate');
            }
        }
    } else {
        _applyFlatplatePlaneGeometry(ch, normalizedPlaneSize);
    }
    if (!(opts && opts.keepClock)) ch.flatplate.startedAtSec = performance.now() / 1000;
    _updateFlatplateCharacter(ch, performance.now() / 1000);
    return true;
}
async function _setFlatplatePlaybackSettings(ch, changes = {}, opts = {}) {
    if (!ch || !ch.flatplate || !ch.source || ch.source.kind !== 'flatplate') return false;
    const capture = opts.capture !== false;
    if (capture && !timeline.recording) _pushUndoSnapshot(opts.label || 'flatplate-settings');
    const nowSec = performance.now() / 1000;
    const playheadNow = ((timeline?.playing || timeline?.recording || timeline?._scrubbing) ? _num(timeline?.playhead, 0) : null);
    const currentStep = _getFlatplateCurrentStep(ch.flatplate, nowSec, playheadNow);
    const frozenFrame = _getFlatplateDisplayedFrameIndex(ch.flatplate, nowSec, playheadNow);
    const nextMode = (typeof changes.mode !== 'undefined')
        ? _normalizeFlatplateModeValue(changes.mode || ch.flatplate.mode || 'forward')
        : _normalizeFlatplateModeValue(ch.flatplate.mode || 'forward');
    const span = Array.isArray(ch.flatplate.frames) ? ch.flatplate.frames.length : 0;
    const remappedStep = span > 1
        ? _getFlatplateStepForDisplayedFrameIndex(frozenFrame, span, nextMode, currentStep)
        : 0;
    ch.flatplate.anchorFrame = remappedStep;
    ch.flatplate.pausedFrame = remappedStep;
    ch.flatplate.currentFrame = frozenFrame;
    if (playheadNow != null && Number.isFinite(+playheadNow)) ch.flatplate.anchorPlayhead = +playheadNow;
    if (typeof changes.fps !== 'undefined') {
        ch.flatplate.fps = Math.max(1, _num(changes.fps, ch.flatplate.fps || ch.source.fps || 24));
        ch.source.fps = ch.flatplate.fps;
    }
    if (typeof changes.mode !== 'undefined') {
        ch.flatplate.mode = nextMode;
        ch.source.playback = ch.flatplate.mode;
    }
    if (typeof changes.stopAtLastFrame !== 'undefined') {
        ch.flatplate.stopAtLastFrame = !!changes.stopAtLastFrame;
        ch.source.stopAtLastFrame = ch.flatplate.stopAtLastFrame;
    }
    if (typeof changes.infinite !== 'undefined') {
        ch.flatplate.infinite = _normalizeFlatplateInfinite(changes.infinite);
        ch.source.infinite = ch.flatplate.infinite;
    }
    if (typeof changes.repeats !== 'undefined') {
        ch.flatplate.repeats = _normalizeFlatplateRepeatCount(changes.repeats, ch.flatplate.repeats || 1);
        ch.source.repeats = ch.flatplate.repeats;
    }
    if (typeof changes.spin !== 'undefined') {
        ch.flatplate.spin = _num(changes.spin, ch.flatplate.spin || 0);
        ch.source.spin = ch.flatplate.spin;
    }
    ch.flatplate.startedAtSec = nowSec;
    _updateFlatplateCharacter(ch, nowSec);
    if (capture) {
        try { upsertCharacterKeyAt(ch, timeline.playhead); } catch { }
    }
    buildAnimMenuItems();
    return true;
}
async function replaceFlatplateMediaFromFile(ch, file, opts = {}) {
    if (!ch || !ch.flatplate || !file) return null;
    const capture = opts.capture !== false;
    if (capture && !timeline.recording) _pushUndoSnapshot(opts.label || 'flatplate-media');
    _rememberFlatplateHistory(ch);
    const name = String(file.name || 'flatplate').trim() || 'flatplate';
    let frames = [];
    let settings = null;
    if (/\.zip$/i.test(name)) {
        frames = await _readFlatplateZipFrames(file);
        settings = await _askFlatplateOptions({ fps: ch.flatplate.fps || ch.source?.fps || 24, mode: ch.flatplate.mode || ch.source?.playback || 'forward', stopAtLastFrame: ch.flatplate.stopAtLastFrame || ch.source?.stopAtLastFrame || false, infinite: (ch.flatplate.infinite ?? ch.source?.infinite ?? true), repeats: ch.flatplate.repeats || ch.source?.repeats || 1 });
        if (!settings) return null;
    } else if (/\.png$/i.test(name) || String(file.type || '').toLowerCase() === 'image/png') {
        frames = [{ name, dataUrl: await _fileToDataUrl(file) }];
        settings = { fps: ch.flatplate.fps || ch.source?.fps || 24, mode: ch.flatplate.mode || ch.source?.playback || 'forward', stopAtLastFrame: ch.flatplate.stopAtLastFrame || ch.source?.stopAtLastFrame || false, infinite: (ch.flatplate.infinite ?? ch.source?.infinite ?? true), repeats: ch.flatplate.repeats || ch.source?.repeats || 1 };
    } else {
        throw new Error('Flatplate-Import erwartet .png oder .zip.');
    }
    if (settings) {
        ch.flatplate.fps = Math.max(1, _num(settings.fps, ch.flatplate.fps || 24));
        ch.flatplate.mode = _normalizeFlatplateModeValue(settings.mode || ch.flatplate.mode || 'forward');
        ch.flatplate.stopAtLastFrame = !!settings.stopAtLastFrame;
        ch.flatplate.infinite = _normalizeFlatplateInfinite(settings.infinite);
        ch.flatplate.repeats = _normalizeFlatplateRepeatCount(settings.repeats, 1);
    }
    if (ch.source && ch.source.kind === 'flatplate') {
        ch.source.fps = ch.flatplate.fps;
        ch.source.playback = ch.flatplate.mode;
        ch.source.stopAtLastFrame = ch.flatplate.stopAtLastFrame;
        ch.source.infinite = ch.flatplate.infinite;
        ch.source.repeats = ch.flatplate.repeats;
        ch.source.name = name;
    }
    await _replaceFlatplateFrames(ch, frames, { sourceName: name });
    _fitFlatplateWidthToAspect(ch, ch?.source?.planeHeight, { capture: false });
    _rememberFlatplateHistory(ch);
    if (capture) {
        try { upsertCharacterKeyAt(ch, timeline.playhead); } catch { }
    }
    buildAnimMenuItems();
    return ch;
}

function _flatplateNaturalCompare(a, b) {
    return String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' });
}
function _inferFlatplateSpawnTransform() {
    const actorPos = actor ? actor.position.clone() : new THREE.Vector3();
    const toCam = new THREE.Vector3().subVectors(camera.position, actorPos);
    toCam.y = 0;
    if (toCam.lengthSq() < 1e-6) {
        camera.getWorldDirection(toCam);
        toCam.multiplyScalar(-1);
        toCam.y = 0;
    }
    if (toCam.lengthSq() < 1e-6) toCam.set(0, 0, 1);
    toCam.normalize();
    const spawn = actorPos.clone().add(toCam.multiplyScalar(Math.max(1.5, Math.min(3.5, actorPos.distanceTo(camera.position) * 0.18))));
    spawn.y = actorPos.y;
    return {
        position: [spawn.x, spawn.y, spawn.z],
        quaternion: [camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w],
        scale: [1, 1, 1],
    };
}
function _dataUrlToTexture(dataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const tex = new THREE.Texture(img);
            tex.needsUpdate = true;
            tex.colorSpace = THREE.SRGBColorSpace || THREE.sRGBEncoding || tex.colorSpace;
            tex.minFilter = THREE.LinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.generateMipmaps = false;
            tex.flipY = true;
            resolve({ texture: tex, width: img.naturalWidth || img.width || 1, height: img.naturalHeight || img.height || 1 });
        };
        img.onerror = () => reject(new Error('PNG konnte nicht geladen werden.'));
        img.src = dataUrl;
    });
}
function _fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => reject(fr.error || new Error('Datei konnte nicht gelesen werden.'));
        fr.readAsDataURL(file);
    });
}
async function _readFlatplateZipFrames(file) {
    if (!window.JSZip) throw new Error('ZIP-Import braucht JSZip, ist aber hier nicht verfügbar.');
    const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
    const entries = Object.values(zip.files || {})
        .filter(entry => {
            if (!entry || entry.dir) return false;
            const fullName = String(entry.name || '');
            const baseName = fullName.split('/').pop() || fullName;
            if (!/\.png$/i.test(baseName)) return false;
            if (/^__MACOSX\//.test(fullName)) return false;
            if (/^\._/.test(baseName)) return false;
            return true;
        })
        .sort((a, b) => _flatplateNaturalCompare(a.name, b.name));
    if (!entries.length) throw new Error('Im ZIP wurden keine PNG-Dateien gefunden.');
    const out = [];
    for (const entry of entries) {
        const b64 = await entry.async('base64');
        const fullName = String(entry.name || 'frame.png');
        const baseName = fullName.split('/').pop() || fullName || 'frame.png';
        out.push({ name: baseName, dataUrl: `data:image/png;base64,${b64}` });
    }
    return out;
}
function _updateFlatplateCharacter(ch, nowSec) {
    if (!ch || !ch.flatplate || !ch.group) return;
    const fp = ch.flatplate;
    if (fp.billboard !== false) {
        ch.group.quaternion.copy(camera.quaternion);
        const spin = _num(fp.spin, 0);
        if (Math.abs(spin) > 1e-12) {
            const qSpin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), spin);
            ch.group.quaternion.multiply(qSpin);
        }
    }
    if (!Array.isArray(fp.frames) || !fp.frames.length || !fp.material) return;
    if (fp.frames.length === 1) {
        const frame = fp.frames[0];
        fp.currentFrame = 0;
        fp.pausedFrame = 0;
        _applyFlatplateDisplayFrameGeometry(ch, frame);
        if (fp.material.map !== frame.texture) {
            fp.material.map = frame.texture;
            fp.material.needsUpdate = true;
        }
        return;
    }
    const playheadSec = (!fp.previewHoldActive && timeline && Number.isFinite(+timeline.playhead)) ? _num(timeline.playhead, 0) : null;
    const step = _getFlatplateCurrentStep(fp, nowSec, playheadSec);
    const idx = _getFlatplateDisplayedFrameIndex(fp, nowSec, playheadSec);
    const frame = fp.frames[idx] || fp.frames[0];
    if (!fp.playing || playheadSec != null) fp.pausedFrame = step;
    _applyFlatplateDisplayFrameGeometry(ch, frame);
    if (fp.currentFrame !== idx) {
        fp.currentFrame = idx;
        fp.material.map = frame.texture;
        fp.material.needsUpdate = true;
    } else if (fp.material.map !== frame.texture) {
        fp.material.map = frame.texture;
        fp.material.needsUpdate = true;
    }
}
async function importFlatplateFromFrames(frameEntries, fileName, opts = {}) {
    const transformSnapshot = _snapshotCharacterTransforms();
    const prevActive = activeCharacter;
    const loadedFrames = [];
    for (const entry of (frameEntries || [])) {
        const loaded = await _dataUrlToTexture(entry.dataUrl);
        loadedFrames.push({
            name: entry.name || 'frame.png',
            dataUrl: entry.dataUrl,
            texture: loaded.texture,
            width: loaded.width,
            height: loaded.height,
        });
    }
    if (!loadedFrames.length) throw new Error('Keine PNG-Frames für Flatplate gefunden.');
    const first = loadedFrames[0];
    const aspect = Math.max(1 / 64, Math.min(64, (first.width || 1) / Math.max(1, first.height || 1)));
    const planeHeight = Math.max(0.25, _num(opts.height, gregoryReferenceHeight > 1e-6 ? gregoryReferenceHeight : 1.8));
    const planeWidth = Math.max(0.05, planeHeight * aspect);
    const geom = new THREE.PlaneGeometry(planeWidth, planeHeight);
    geom.translate(0, planeHeight * 0.5, 0);
    const mat = new THREE.MeshBasicMaterial({
        map: first.texture,
        transparent: true,
        alphaTest: 0.001,
        side: THREE.DoubleSide,
        depthWrite: false,
        toneMapped: false,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.renderOrder = 50;
    mesh.frustumCulled = false;
    _applyCharacterDepthClipMaterials(mesh);
    const group = new THREE.Group();
    const base = _inferFlatplateSpawnTransform();
    group.position.fromArray((opts.transform && opts.transform.position) || base.position);
    if (opts.transform && Array.isArray(opts.transform.quaternion)) group.quaternion.fromArray(opts.transform.quaternion); else group.quaternion.fromArray(base.quaternion);
    if (opts.transform && Array.isArray(opts.transform.scale)) group.scale.fromArray(opts.transform.scale); else group.scale.fromArray(base.scale);
    group.add(mesh);
    group.frustumCulled = false;
    scene3d.add(group);
    const source = opts.source || {
        kind: 'flatplate',
        name: fileName || 'flatplate',
        fps: Math.max(1, _num(opts.fps, 24)),
        playback: _normalizeFlatplateModeValue(opts.mode || 'forward'),
        stopAtLastFrame: !!opts.stopAtLastFrame,
        infinite: _normalizeFlatplateInfinite(opts.infinite),
        repeats: _normalizeFlatplateRepeatCount(opts.repeats, 1),
        billboard: true,
        spin: _num(opts.spin, 0),
        planeWidth,
        planeHeight,
        frames: loadedFrames.map(f => ({ name: f.name, dataUrl: f.dataUrl, width: f.width, height: f.height })),
    };
    if (!Number.isFinite(+source.planeHeight)) source.planeHeight = planeHeight;
    if (!Number.isFinite(+source.planeWidth)) source.planeWidth = planeWidth;
    const ch = registerCharacter({
        id: opts.id || `flatplate_${characterSeq++}`,
        name: opts.name || fileName || `Flatplate ${characterSeq}`,
        group,
        root: mesh,
        source,
        pickables: [mesh],
        animState: _makeAnimState(),
        keys: Array.isArray(opts.keys) ? opts.keys.map(_cloneKeyframe) : [],
        duration: 0,
    });
    mesh.userData = mesh.userData || {};
    mesh.userData.characterId = ch.id;
    mesh.userData.characterRuntimeUid = ch.runtimeUid;
    mesh.userData.flatplate = true;
    ch.flatplate = {
        frames: loadedFrames,
        fps: Math.max(1, _num(source.fps, opts.fps ?? 24)),
        mode: _normalizeFlatplateModeValue(source.playback || source.mode || opts.mode || 'forward'),
        stopAtLastFrame: !!(source.stopAtLastFrame ?? opts.stopAtLastFrame),
        infinite: _normalizeFlatplateInfinite(source.infinite ?? opts.infinite),
        repeats: _normalizeFlatplateRepeatCount(source.repeats ?? opts.repeats, 1),
        material: mat,
        billboard: source.billboard !== false,
        spin: _num(source.spin, opts.spin ?? 0),
        currentFrame: -1,
        playing: false,
        previewHoldActive: false,
        anchorPlayhead: _num(timeline?.playhead, 0),
        anchorFrame: 0,
        pausedFrame: 0,
        startedAtSec: performance.now() / 1000,
    };
    _updateFlatplateCharacter(ch, performance.now() / 1000);
    if (Array.isArray(opts.keys)) _updateCharacterDuration(ch);
    _restoreCharacterTransforms(transformSnapshot);
    if (prevActive && prevActive !== ch) {
        try { prevActive.group.updateMatrixWorld(true); } catch { }
    }
    if (opts.select !== false) setActiveCharacter(ch, { refreshMenu: false });
    else if (activeCharacter !== prevActive) setActiveCharacter(prevActive, { refreshMenu: false });
    try { updateSelectionOutline(); } catch { }
    _rememberFlatplateHistory(ch);
    return ch;
}
async function importFlatplateFromFile(file, opts = {}) {
    if (!file) throw new Error('Keine Datei gewählt.');
    const name = String(file.name || 'flatplate').trim() || 'flatplate';
    let frames = [];
    let options = opts.options || null;
    if (/\.zip$/i.test(name)) {
        frames = await _readFlatplateZipFrames(file);
        if (!options) options = await _askFlatplateOptions({ fps: 24, mode: 'forward', stopAtLastFrame: false, infinite: true, repeats: 1 });
        if (!options) return null;
    } else if (/\.png$/i.test(name) || String(file.type || '').toLowerCase() === 'image/png') {
        frames = [{ name, dataUrl: await _fileToDataUrl(file) }];
        if (!options) options = { fps: 24, mode: 'forward', stopAtLastFrame: false, infinite: true, repeats: 1 };
    } else {
        throw new Error('Flatplate-Import erwartet .png oder .zip.');
    }
    return importFlatplateFromFrames(frames, name, {
        fps: options.fps,
        mode: options.mode,
        stopAtLastFrame: options.stopAtLastFrame,
        infinite: options.infinite,
        repeats: options.repeats,
        select: opts.select !== false,
    });
}

async function importCharacterFromArrayBuffer(arrayBuffer, fileName, opts = {}) {
    const transformSnapshot = _snapshotCharacterTransforms();
    const prevActive = activeCharacter;
    const gltf = await loadCharacterFromArrayBuffer(arrayBuffer, { fileName });
    const root = gltf.scene || gltf.scenes?.[0];
    if (!root) throw new Error('Kein Root-Node in GLB/GBL gefunden.');
    const group = new THREE.Group();
    const base = _getDefaultCharacterTransform();
    group.position.fromArray((opts.transform && opts.transform.position) || base.position);
    if (opts.transform && Array.isArray(opts.transform.quaternion)) group.quaternion.fromArray(opts.transform.quaternion); else group.quaternion.fromArray(base.quaternion);
    if (opts.transform && Array.isArray(opts.transform.scale)) group.scale.fromArray(opts.transform.scale); else group.scale.fromArray(base.scale);
    group.add(root);
    scene3d.add(group);
    const ch = registerCharacter({
        id: opts.id || `char_${characterSeq++}`,
        name: opts.name || fileName || `Character ${characterSeq}`,
        group,
        root,
        source: opts.source || { kind: 'embedded-glb', name: fileName || 'character.glb', mime: 'model/gltf-binary', bytesBase64: _arrayBufferToBase64(arrayBuffer) },
        pickables: [],
        animState: _makeAnimState(),
        keys: Array.isArray(opts.keys) ? opts.keys.map(_cloneKeyframe) : [],
        duration: 0,
    });
    root.traverse((o) => {
        o.userData = o.userData || {};
        o.userData.characterId = ch.id;
        o.userData.characterRuntimeUid = ch.runtimeUid;
        o.matrixAutoUpdate = true;
        if (o.isMesh) {
            ch.pickables.push(o);
            if (o.geometry) {
                if (!o.geometry.boundingSphere) { try { o.geometry.computeBoundingSphere(); } catch { } }
                if (!o.geometry.boundingBox) { try { o.geometry.computeBoundingBox(); } catch { } }
            }
        }
    });
    _fitCharacterLikeGregory(root, group);
    if (opts.transform && Array.isArray(opts.transform.scale)) group.scale.fromArray(opts.transform.scale);
    _applyCharacterDepthClipMaterials(root);
    _setupImportedCharacterAnimations(ch, gltf);
    try { const rest = _copyAnimState(ch.animState); ch.animState = rest; } catch { }
    if (Array.isArray(opts.keys)) _updateCharacterDuration(ch);
    _restoreCharacterTransforms(transformSnapshot);
    if (prevActive && prevActive !== ch) {
        try { prevActive.group.updateMatrixWorld(true); } catch { }
    }
    if (opts.select !== false) setActiveCharacter(ch, { refreshMenu: false });
    else if (activeCharacter !== prevActive) setActiveCharacter(prevActive, { refreshMenu: false });
    return ch;
}
// ---------- Project Export/Import (native .3dmmproj JSON) ----------
const PROJECT_MAGIC = "3DMM_NATIVE_PROJECT";
const PROJECT_VERSION = 1;

const UI_FIELDS = [
    "overlay", "fmm", "horizon", "pitch", "camHeight", "showH", "drawSceneDepth",
    "shStr", "shRad", "shSoft", "shOx", "shOy",
    "exposure", "lightMul",
    "sx", "sy", "ox", "oy", "rot", "fx", "fy", "bias", "clipSoft", "backDepthMul",
    "mouthFps", "mouthThrF", "mouthThrE", "mouthThrA",
    "walkMin", "walkMax", "runMin", "runMax", "animXfade",
];

function collectProject() {
    const uiState = {};
    for (const k of UI_FIELDS) {
        const el = ui[k];
        if (!el) continue;
        if (el.tagName === "SELECT") uiState[k] = String(el.value);
        else uiState[k] = _num(el.value, 0);
    }

    return {
        type: PROJECT_MAGIC,
        version: PROJECT_VERSION,
        created: new Date().toISOString(),
        ui: uiState,
        backgroundSelection: backgroundState.currentSelection ? JSON.parse(JSON.stringify(backgroundState.currentSelection)) : null,
        backgroundTimeline: _dedupeAndSortBackgroundKeys(timeline.backgroundKeys || []).map(k => ({
            t: _num(k.t, 0),
            entry: _cloneBackgroundEntry(k.entry),
        })),
        voice: (voice && voice.getProjectData) ? voice.getProjectData() : null,
        foley: (foley && foley.getProjectData) ? foley.getProjectData() : null,
        actor: {
            position: [actor.position.x, actor.position.y, actor.position.z],
            quaternion: [actor.quaternion.x, actor.quaternion.y, actor.quaternion.z, actor.quaternion.w],
            scale: [actor.scale.x, actor.scale.y, actor.scale.z],
        },
        characters: characters.map(ch => ({
            id: ch.id,
            name: ch.name,
            source: ch.source && ch.source.kind === 'flatplate' ? _cloneFlatplateSource(ch.source) : (ch.source || null),
            transform: {
                position: [ch.group.position.x, ch.group.position.y, ch.group.position.z],
                quaternion: [ch.group.quaternion.x, ch.group.quaternion.y, ch.group.quaternion.z, ch.group.quaternion.w],
                scale: [ch.group.scale.x, ch.group.scale.y, ch.group.scale.z],
            },
            keys: (ch.keys || []).map(k => ({
                t: _num(k.t, 0),
                p: Array.isArray(k.p) ? k.p.slice(0, 3).map(n => _num(n, 0)) : [0, 0, 0],
                q: Array.isArray(k.q) ? k.q.slice(0, 4).map(n => _num(n, 0)) : [0, 0, 0, 1],
                s: Array.isArray(k.s) ? k.s.slice(0, 3).map(n => _num(n, 1)) : [1, 1, 1],
                a: (k.a === null || typeof k.a === "string") ? k.a : null,
                at: _num(k.at, 0),
                spd: THREE.MathUtils.clamp(_num(k.spd ?? k.speed, 1), 0.05, 3.0),
                fp: _cloneFlatplateKeyState(k.fp || null),
            })),
        })),
        timeline: {
            fps: TL_FPS,
            duration: getProjectDuration(),
            keys: (gregoryCharacter?.keys || []).map(k => ({
                t: _num(k.t, 0),
                p: Array.isArray(k.p) ? k.p.slice(0, 3).map(n => _num(n, 0)) : [0, 0, 0],
                q: Array.isArray(k.q) ? k.q.slice(0, 4).map(n => _num(n, 0)) : [0, 0, 0, 1],
                s: Array.isArray(k.s) ? k.s.slice(0, 3).map(n => _num(n, 1)) : [1, 1, 1],
                a: (k.a === null || typeof k.a === "string") ? k.a : null,
                at: _num(k.at, 0),
                spd: THREE.MathUtils.clamp(_num(k.spd ?? k.speed, 1), 0.05, 3.0),
                fp: _cloneFlatplateKeyState(k.fp || null),
            })),
        },
        onionSkin: {
            enabled: !!onionSkin.enabled,
            opacity: _num(onionSkin.opacity, 0.5),
            pastFrames: Math.round(_num(onionSkin.pastFrames, 10)),
            futureFrames: Math.round(_num(onionSkin.futureFrames, 10)),
            stepFps: Math.round(_num(onionSkin.stepFps, 5)),
        },
        takeManager: {
            panelVisible: !!takeManagerState.panelVisible,
            panelPos: takeManagerState.panelPos ? { x: _num(takeManagerState.panelPos.x, 12), y: _num(takeManagerState.panelPos.y, 12) } : null,
            scenes: takeManagerState.scenes.map((scene, sceneIndex) => ({
                selectedTakeIndex: Math.max(0, Math.min((scene?.takes?.length || 1) - 1, Math.round(Number(scene?.selectedTakeIndex) || 0))),
                takes: (Array.isArray(scene?.takes) ? scene.takes : []).map((take, takeIndex) => ({
                    id: String(take?.id || `scene_${sceneIndex + 1}_take_${takeIndex + 1}`),
                    name: String((take?.name ?? '').toString().trim() || _defaultTakeLabel(takeIndex)),
                    rating: Math.max(0, Math.min(5, Math.round(Number(take?.rating) || 0))),
                    clipData: _cloneTakeClipData(take?.clipData),
                    backgroundEntry: _cloneBackgroundEntry(take?.backgroundEntry),
                })),
            })),
        },
        flatplateRecentHistory: _sanitizeFlatplateHistoryEntries(recentFlatplateHistory),
    };
}

function _normalizeKeys(keys) {
    const out = [];
    if (!Array.isArray(keys)) return { keys: out, duration: 0 };

    for (const k of keys) {
        if (!k) continue;
        const t = _num(k.t, 0);
        const p = Array.isArray(k.p) ? k.p.slice(0, 3).map(n => _num(n, 0)) : null;
        const q = Array.isArray(k.q) ? k.q.slice(0, 4).map(n => _num(n, 0)) : null;
        const s = Array.isArray(k.s) ? k.s.slice(0, 3).map(n => _num(n, 1)) : null;
        if (!p || p.length !== 3 || !q || q.length !== 4 || !s || s.length !== 3) continue;

        out.push({
            t,
            p,
            q,
            s,
            a: (k.a === null || typeof k.a === "string") ? k.a : null,
            at: _num(k.at, 0),
            spd: THREE.MathUtils.clamp(_num(k.spd ?? k.speed, 1), 0.05, 3.0),
        });
    }

    out.sort((a, b) => a.t - b.t);
    const t0 = out.length ? out[0].t : 0;
    if (out.length && Math.abs(t0) > 1e-9) {
        for (const k of out) k.t -= t0; // start at 0
    }
    const duration = out.length ? out[out.length - 1].t : 0;
    return { keys: out, duration };
}

async function applyProject(proj, { mode = "replace", progress = null, loadLabel = "" } = {}) {
    if (!proj || typeof proj !== "object") throw new Error("Invalid file (not an object).");
    if (proj.type !== PROJECT_MAGIC) throw new Error("Unknown project format (type).");
    if ((proj.version | 0) !== PROJECT_VERSION) {
        // forward-compatible: still try if keys exist
        console.warn("Project version differs:", proj.version);
    }

    // Stop any transport state
    try { stopRecording(); } catch { }
    timeline.playing = false;
    updatePlayButtonIcon();
    timeline._scrubbing = false;

    const appendBaseOffset = (mode === "append") ? Math.max(0, timeline.duration) : 0;

    // UI
    if (mode !== "append" && proj.ui && typeof proj.ui === "object") {
        for (const k of UI_FIELDS) {
            const el = ui[k];
            if (!el) continue;
            if (!(k in proj.ui)) continue;
            const v = proj.ui[k];
            if (el.tagName === "SELECT") el.value = String(v);
            else el.value = String(_num(v, _num(el.value, 0)));
        }
        syncLabels();
    }
    if (mode !== "append") normalizeOnionSkinState(proj.onionSkin || {});
    if (mode !== "append") _normalizeTakeManagerState(proj.takeManager || null);
    const incomingFlatplateHistory = _sanitizeFlatplateHistoryEntries(proj.flatplateRecentHistory || []);
    if (mode === "append") recentFlatplateHistory = _sanitizeFlatplateHistoryEntries((Array.isArray(recentFlatplateHistory) ? recentFlatplateHistory : []).concat(incomingFlatplateHistory));
    else recentFlatplateHistory = incomingFlatplateHistory;

    if (mode !== "append") clearPresentationWarmCache();
    try {
        await warmProjectBackgroundBuffer(proj, {
            onProgress: (info) => {
                if (typeof progress === "function") {
                    const phaseBase = 0.18;
                    const phaseSpan = 0.58;
                    progress({
                        title: "Project is loading…",
                        mode: loadLabel || (mode === "append" ? "Project is being appended" : "Project is opening"),
                        file: info?.file || loadLabel || "Project file",
                        detail: info?.detail || "Backgrounds und ZBuffer werden vorgeladen",
                        progress: phaseBase + phaseSpan * Math.max(0, Math.min(1, Number(info?.progress) || 0)),
                    });
                }
            }
        });
    } catch (err) { console.debug("Project background warmup skipped:", err); }

    if (mode !== "append") {
        timeline.backgroundKeys = [];
        timeline._bgAppliedSignature = null;
    }
    progress?.({ title: "Project is loading…", mode: loadLabel || (mode === "append" ? "Project is being appended" : "Project is opening"), file: loadLabel || "Project file", detail: "Building scene", progress: 0.80 });
    if (mode !== "append" && proj.backgroundSelection) {
        try { await applyBackgroundEntry(proj.backgroundSelection, { recordTimeline: false, source: "project" }); }
        catch (err) { console.warn("Background selection could not be restored", err); }
    }
    if (Array.isArray(proj.backgroundTimeline) && proj.backgroundTimeline.length) {
        const normalizedBg = _dedupeAndSortBackgroundKeys(proj.backgroundTimeline).map(k => ({
            t: _num(k.t, 0) + appendBaseOffset,
            entry: _cloneBackgroundEntry(k.entry),
        }));
        if (mode === "append") timeline.backgroundKeys = _dedupeAndSortBackgroundKeys((timeline.backgroundKeys || []).concat(normalizedBg));
        else timeline.backgroundKeys = _dedupeAndSortBackgroundKeys(normalizedBg);
    }
    try { requestBackgroundTimelineApplyAt(timeline.playhead || 0); } catch (err) { console.debug("Initial background apply skipped:", err); }

    const offsetProjectAudio = (data, offset) => {
        if (!data || typeof data !== "object") return null;
        const clips = Array.isArray(data.clips) ? data.clips.map(c => ({
            ...c,
            t: Number.isFinite(+c?.t) ? Math.max(0, +c.t + offset) : c?.t,
        })) : [];
        return { ...data, clips };
    };

    // Voice (mp3 + triggers)
    if (voice && voice.loadProjectData) {
        if (mode === "append") {
            const mergedVoice = {
                clips: [
                    ...((voice.getProjectData?.()?.clips || []).map(c => ({ ...c }))),
                    ...((offsetProjectAudio(proj.voice, appendBaseOffset)?.clips || []).map(c => ({ ...c }))),
                ],
            };
            if (mergedVoice.clips.length) voice.loadProjectData(mergedVoice);
        } else if (proj.voice) {
            voice.loadProjectData(proj.voice);
        } else {
            try { voice.clear(); } catch { }
        }
    }

    // Foley (mp3 + triggers)
    if (foley && foley.loadProjectData) {
        if (mode === "append") {
            const mergedFoley = {
                clips: [
                    ...((foley.getProjectData?.()?.clips || []).map(c => ({ ...c }))),
                    ...((offsetProjectAudio(proj.foley, appendBaseOffset)?.clips || []).map(c => ({ ...c }))),
                ],
            };
            if (mergedFoley.clips.length) foley.loadProjectData(mergedFoley);
        } else if (proj.foley) {
            foley.loadProjectData(proj.foley);
        } else {
            try { foley.clear(); } catch { }
        }
    }


    // Characters + timelines
    if (mode !== "append") _clearCustomCharacters();

    const incomingCharacters = Array.isArray(proj.characters) && proj.characters.length
        ? proj.characters
        : [{
            id: "gregory",
            name: "Gregory",
            source: { kind: "builtin", path: "./gregory.animation.glb" },
            transform: proj.actor || _getDefaultCharacterTransform(),
            keys: (proj.timeline?.keys || proj.keys || []),
        }];

    const appendOffset = appendBaseOffset;
    for (const item of incomingCharacters) {
        const norm = _normalizeKeys(item.keys || []);
        let ch = null;
        if ((item.source && item.source.kind === 'builtin') || String(item.id) === 'gregory') {
            ch = gregoryCharacter;
            if (item.transform && item.transform.position) ch.group.position.fromArray(item.transform.position);
            if (item.transform && item.transform.quaternion) ch.group.quaternion.fromArray(item.transform.quaternion);
            if (item.transform && item.transform.scale) ch.group.scale.fromArray(item.transform.scale);
        } else if (item.source && item.source.kind === 'embedded-glb' && item.source.bytesBase64) {
            ch = await importCharacterFromArrayBuffer(_base64ToArrayBuffer(item.source.bytesBase64), item.source.name || item.name || 'character.glb', { id: item.id, name: item.name, source: item.source, transform: item.transform, select: false });
        } else if (item.source && item.source.kind === 'flatplate' && Array.isArray(item.source.frames) && item.source.frames.length) {
            ch = await importFlatplateFromFrames(item.source.frames, item.source.name || item.name || 'flatplate', {
                id: item.id,
                name: item.name,
                source: item.source,
                transform: item.transform,
                fps: item.source.fps,
                mode: item.source.playback || item.source.mode,
                select: false,
            });
        }
        if (!ch) continue;
        const incoming = norm.keys.map(k => ({ ...k, t: k.t + appendOffset }));
        if (mode === 'append' && Array.isArray(ch.keys) && ch.keys.length) ch.keys = ch.keys.concat(incoming);
        else ch.keys = incoming;
        ch.keys.sort((a, b) => a.t - b.t);
        _updateCharacterDuration(ch);
    }

    timeline.duration = getProjectDuration();
    transport.timeSlider.max = String(Math.max(timeline.duration, 0));
    timeline.playhead = (mode === "append") ? _clamp(appendBaseOffset, 0, Math.max(timeline.duration, appendBaseOffset)) : 0;
    const firstBgKeyTime = timeline.backgroundKeys.length ? _num(timeline.backgroundKeys[0]?.t, 0) : Infinity;
    if (backgroundState.currentSelection && (!timeline.backgroundKeys.length || firstBgKeyTime > 1e-5)) upsertBackgroundKeyAt(0, backgroundState.currentSelection);
    applyTimelineAt(timeline.playhead);
    syncTransportUI();

    try {
        await warmProjectBackgroundPlaybackAfterSceneReady(proj, {
            onProgress: (info) => {
                if (typeof progress === "function") {
                    progress({
                        title: "Project is loading…",
                        mode: loadLabel || (mode === "append" ? "Project is being appended" : "Project is opening"),
                        file: info?.file || loadLabel || "Project file",
                        detail: info?.detail || "Finalizing playback buffer",
                        progress: 0.92 + 0.08 * Math.max(0, Math.min(1, Number(info?.progress) || 0)),
                    });
                }
            }
        });
    } catch (err) {
        console.debug("Scene-ready playback warmup skipped:", err);
    }
}


const exportUI = {
    modal: document.getElementById("exportModal"),
    closeBtn: document.getElementById("exportCloseBtn"),
    startBtn: document.getElementById("exportStartBtn"),
    mode: document.getElementById("exportMode"),
    scope: document.getElementById("exportScope"),
    resolution: document.getElementById("exportResolution"),
    fps: document.getElementById("exportFps"),
    quality: document.getElementById("exportQuality"),
    qualityV: document.getElementById("exportQualityV"),
    mbSamples: document.getElementById("exportMBSamples"),
    mbSamplesV: document.getElementById("exportMBSamplesV"),
    filename: document.getElementById("exportFilename"),
    status: document.getElementById("exportStatus"),
    progressBar: document.getElementById("exportProgressBar"),
    progressMeta: document.getElementById("exportProgressMeta"),
};

const exportState = { busy: false, progress: 0, message: tr("Ready."), previewActive: false, lastPreviewSource: null };

const EXPORT_RESOLUTION_PRESETS = {
    "8k": { w: 7680, h: 4320, label: "8K" },
    "4k": { w: 3840, h: 2160, label: "4K" },
    "1080p": { w: 1920, h: 1080, label: "FullHD" },
    "720p": { w: 1280, h: 720, label: "720p" },
    "480p": { w: 854, h: 480, label: "480p" },
};

function _syncExportPreviewCanvasSize() {
    if (!exportPreviewCanvas) return;
    const w = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
    const h = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    if (exportPreviewCanvas.width !== w) exportPreviewCanvas.width = w;
    if (exportPreviewCanvas.height !== h) exportPreviewCanvas.height = h;
}

function _setExportPreviewVisible(visible) {
    exportState.previewActive = !!visible;
    if (!exportPreviewCanvas) return;
    exportPreviewCanvas.style.opacity = visible ? '1' : '0';
    if (!visible && exportPreviewCtx) {
        exportPreviewCtx.clearRect(0, 0, exportPreviewCanvas.width || 1, exportPreviewCanvas.height || 1);
    }
}

function _drawExportPreviewFrame(source) {
    if (!source || !exportPreviewCtx) return;
    exportState.lastPreviewSource = source;
    _syncExportPreviewCanvasSize();
    const dw = exportPreviewCanvas.width || 1;
    const dh = exportPreviewCanvas.height || 1;
    exportPreviewCtx.save();
    exportPreviewCtx.clearRect(0, 0, dw, dh);
    exportPreviewCtx.fillStyle = '#000';
    exportPreviewCtx.fillRect(0, 0, dw, dh);
    exportPreviewCtx.globalAlpha = 1;
    _drawSourceCover2D(exportPreviewCtx, source, 0, 0, dw, dh);
    exportPreviewCtx.restore();
}

function _syncExportModeConstraints() {
    const mode = String(exportUI.mode?.value || 'screenshot');
    const isWebm = mode === 'webm';
    const resolution = String(exportUI.resolution?.value || '1080p');
    const webmAllowed = new Set(['4k', '1080p', '720p', '480p']);
    if (exportUI.resolution) {
        for (const opt of Array.from(exportUI.resolution.options || [])) {
            const allowed = !isWebm || webmAllowed.has(String(opt.value || ''));
            opt.disabled = !allowed;
            opt.hidden = !allowed;
        }
        if (isWebm && !webmAllowed.has(resolution)) {
            exportUI.resolution.value = '1080p';
        }
    }
    const activeResolution = String(exportUI.resolution?.value || '1080p');
    const maxFps = isWebm ? (activeResolution === '4k' ? 24 : 60) : 120;
    if (exportUI.fps) {
        exportUI.fps.max = String(maxFps);
        if ((+exportUI.fps.value || 0) > maxFps) exportUI.fps.value = String(maxFps);
        exportUI.fps.title = isWebm ? (activeResolution === '4k' ? 'WebM export supports up to 24 fps in 4K.' : 'WebM export supports up to 60 fps up to Full HD.') : '';
    }
}

function setExportProgress(progress = 0, msg = exportState.message || "", meta = "") {
    exportState.progress = Math.max(0, Math.min(1, Number(progress) || 0));
    exportState.message = String(msg || "");
    if (exportUI.status) exportUI.status.textContent = exportState.message;
    if (exportUI.progressBar) exportUI.progressBar.value = exportState.progress;
    if (exportUI.progressMeta) {
        const pct = Math.round(exportState.progress * 100);
        exportUI.progressMeta.textContent = meta ? `${pct}% · ${meta}` : `${pct}%`;
    }
}

function setExportStatus(msg, meta = "") {
    setExportProgress(exportState.progress || 0, msg, meta);
}

function syncExportLabels() {
    if (exportUI.qualityV) exportUI.qualityV.textContent = (+exportUI.quality.value).toFixed(2);
    if (exportUI.mbSamplesV) exportUI.mbSamplesV.textContent = String(Math.round(+exportUI.mbSamples.value || 1));
}

function getExportRange() {
    const total = Math.max(0, getProjectDuration(), +timeline.duration || 0);
    if (exportUI.scope && exportUI.scope.value === "scene") {
        const seg = getCurrentSceneSegment();
        const start = Math.max(0, _num(seg?.start, 0));
        const end = Math.max(start, _num(seg?.end, start));
        return { start, end, duration: Math.max(0, end - start), label: "scene" };
    }
    return { start: 0, end: total, duration: total, label: "project" };
}

function getExportResolution() {
    return EXPORT_RESOLUTION_PRESETS[String(exportUI.resolution?.value || "1080p")] || EXPORT_RESOLUTION_PRESETS["1080p"];
}

function getExportFilenameBase() {
    const raw = String(exportUI.filename?.value || "cleanfeed_export").trim() || "cleanfeed_export";
    return raw.replace(/[\/:*?"<>|]+/g, "_").replace(/\s+/g, "_");
}

function openExportModal() {
    if (!exportUI.modal || exportState.busy) return;
    closeFileMenu();
    syncExportLabels();
    _syncExportModeConstraints();
    setExportProgress(0, tr("Ready."), "0%");
    exportUI.modal.classList.add("open");
    exportUI.modal.setAttribute("aria-hidden", "false");
}

function closeExportModal() {
    if (!exportUI.modal || exportState.busy) return;
    exportUI.modal.classList.remove("open");
    exportUI.modal.setAttribute("aria-hidden", "true");
}

function _getVisibleBackgroundSource() {
    const bgLayers = Array.from(document.querySelectorAll(".bgLayer"));
    for (const layer of bgLayers) {
        const op = parseFloat(getComputedStyle(layer).opacity || "0");
        if (op > 0.5 && layer.complete && (layer.naturalWidth || 0) > 0) return layer;
    }
    if (bgImgEl && bgImgEl.complete && (bgImgEl.naturalWidth || 0) > 0) return bgImgEl;
    return null;
}

function _drawSourceCover2D(ctx, img, dx, dy, dw, dh) {
    if (!ctx || !img || !dw || !dh) return;
    const iw = Math.max(1, img.naturalWidth || img.videoWidth || img.width || 1);
    const ih = Math.max(1, img.naturalHeight || img.videoHeight || img.height || 1);
    const cover = computeCoverTransform(dw, dh, iw, ih);
    const sx = (cover.offX * -iw) / cover.scaleX;
    const sy = (cover.offY * -ih) / cover.scaleY;
    const sw = iw / cover.scaleX;
    const sh = ih / cover.scaleY;
    try { ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh); } catch (err) { console.debug("Background compose skipped", err); }
}

function _composeCleanfeedFrame(targetCanvas, width, height) {
    if (!targetCanvas) return;
    if (targetCanvas.width !== width) targetCanvas.width = width;
    if (targetCanvas.height !== height) targetCanvas.height = height;
    const ctx = targetCanvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);
    const bgSource = _getVisibleBackgroundSource();
    if (bgSource) _drawSourceCover2D(ctx, bgSource, 0, 0, width, height);
    try { ctx.drawImage(renderer.domElement, 0, 0, width, height); } catch (err) { console.debug("Canvas compose skipped", err); }
}

function _downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function _canvasToBlob(canvas, type = "image/png", quality = 0.92) {
    return new Promise((resolve, reject) => {
        try { canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error(tr("Export blob could not be created."))), type, quality); }
        catch (err) { reject(err); }
    });
}

async function _ensureCCaptureReady() {
    if (window.CCapture) return window.CCapture;
    throw new Error(tr("CCapture.js could not be loaded."));
}

let _ffmpegBundlePromise = null;
async function _ensureFfmpegBundle() {
    if (_ffmpegBundlePromise) return _ffmpegBundlePromise;
    _ffmpegBundlePromise = (async () => {
        const ffmpegMod = await import('https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js');
        const utilMod = await import('https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js');
        const { FFmpeg, fetchFile } = ffmpegMod || {};
        const { toBlobURL } = utilMod || {};
        if (!FFmpeg || !fetchFile || !toBlobURL) throw new Error(tr('FFmpeg modules could not be loaded.'));
        const ffmpeg = new FFmpeg();
        const base = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
        await ffmpeg.load({
            coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
            wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm')
        });
        return { ffmpeg, fetchFile };
    })();
    return _ffmpegBundlePromise;
}


function _audioBufferToWavBlob(buffer) {
    if (!buffer) return null;
    const numChannels = Math.max(1, buffer.numberOfChannels || 1);
    const sampleRate = Math.max(1, buffer.sampleRate || 48000);
    const frameCount = Math.max(0, buffer.length || 0);
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = frameCount * blockAlign;
    const out = new ArrayBuffer(44 + dataSize);
    const view = new DataView(out);
    let offset = 0;
    const writeStr = (s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset++, s.charCodeAt(i)); };
    const writeU16 = (v) => { view.setUint16(offset, v, true); offset += 2; };
    const writeU32 = (v) => { view.setUint32(offset, v, true); offset += 4; };
    writeStr('RIFF');
    writeU32(36 + dataSize);
    writeStr('WAVE');
    writeStr('fmt ');
    writeU32(16);
    writeU16(1);
    writeU16(numChannels);
    writeU32(sampleRate);
    writeU32(byteRate);
    writeU16(blockAlign);
    writeU16(16);
    writeStr('data');
    writeU32(dataSize);
    const channels = [];
    for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));
    for (let i = 0; i < frameCount; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
            const sample = Math.max(-1, Math.min(1, channels[ch]?.[i] || 0));
            view.setInt16(offset, sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7FFF), true);
            offset += 2;
        }
    }
    return new Blob([out], { type: 'audio/wav' });
}

async function _renderExportAudioBuffer(start, end) {
    const clips = _collectExportAudioClips(start, end);
    const duration = Math.max(0, (Number(end) || 0) - (Number(start) || 0));
    if (!clips.length || !(duration > 0)) return null;
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) return null;
    const sampleRate = 48000;
    const frameCount = Math.max(1, Math.ceil(duration * sampleRate));
    const offline = new OAC(2, frameCount, sampleRate);
    const master = offline.createGain();
    master.gain.value = 1.0;
    master.connect(offline.destination);
    for (const clip of clips) {
        if (!clip?.buffer) continue;
        const src = offline.createBufferSource();
        src.buffer = clip.buffer;
        src.connect(master);
        const clipStart = Math.max(0, Number(clip.start) || 0);
        const offset = Math.max(0, start - clipStart);
        const when = Math.max(0, clipStart - start);
        const available = Math.max(0, (clip.buffer.duration || 0) - offset);
        const dur = Math.max(0, Math.min(available, duration - when));
        if (!(dur > 0)) continue;
        try { src.start(when, offset, dur); } catch { }
    }
    return await offline.startRendering();
}

async function _renderExportAudioWav(start, end) {
    const rendered = await _renderExportAudioBuffer(start, end);
    return rendered ? _audioBufferToWavBlob(rendered) : null;
}


async function _restoreFullscreenAfterPicker(state) {
    if (!state?.wasFullscreen) return;
    if (document.fullscreenElement) return;
    const target = (state.target && typeof state.target.requestFullscreen === 'function') ? state.target : document.documentElement;
    let restored = false;
    try {
        await target.requestFullscreen();
        restored = !!document.fullscreenElement;
    } catch (err) {
        try {
            await document.documentElement.requestFullscreen();
            restored = !!document.fullscreenElement;
        } catch (err2) {
            console.warn('Fullscreen restore after picker failed', err2 || err);
        }
    }
    if (!restored && !document.fullscreenElement) return;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await _sleep(220);
    _syncExportPreviewCanvasSize();
    try { renderer.setSize(window.innerWidth, window.innerHeight, false); } catch { }
}

async function _pickExportDirectory(opts = {}) {
    if (typeof window.showDirectoryPicker !== 'function') return null;
    const fullscreenState = {
        wasFullscreen: !!document.fullscreenElement,
        target: document.fullscreenElement || document.documentElement
    };
    const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    if (opts.restoreFullscreen !== false) {
        await _restoreFullscreenAfterPicker(fullscreenState);
    }
    return dirHandle;
}

async function _getDiskBackedTempExportDirectory(baseName = 'cleanfeed_export_cache') {
    try {
        const root = await navigator.storage?.getDirectory?.();
        if (!root) return null;
        const tempRoot = await root.getDirectoryHandle('cleanfeed_temp_exports', { create: true });
        const stamp = `${String(baseName || 'cleanfeed_export_cache').replace(/[^a-z0-9._-]+/gi, '_')}_${Date.now()}`;
        return await tempRoot.getDirectoryHandle(stamp, { create: true });
    } catch (err) {
        console.warn('Disk-backed temp export directory unavailable', err);
        return null;
    }
}

async function _writeBlobToDirectory(dirHandle, filename, blob) {
    if (!dirHandle || !filename || !blob) throw new Error(tr('A writable export folder is not available.'));
    const fileHandle = await dirHandle.getFileHandle(String(filename), { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    return fileHandle;
}

async function _renderPngSequenceToDirectory(dirHandle, frames, onProgress) {
    for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        await _writeBlobToDirectory(dirHandle, frame.name, frame.blob);
        if (typeof onProgress === 'function') onProgress((i + 1) / Math.max(1, frames.length), i + 1, frames.length);
        if ((i % 2) === 0 || i + 1 === frames.length) await _yieldToBrowser();
    }
}

async function _cleanupDirectoryContents(dirHandle) {
    if (!dirHandle || typeof dirHandle.keys !== 'function') return;
    try {
        for await (const name of dirHandle.keys()) {
            try { await dirHandle.removeEntry(name, { recursive: true }); } catch { }
        }
    } catch (err) {
        console.warn('Temp export cleanup skipped', err);
    }
}

async function _encodeDiskBufferedFramesToWebm(frameEntries, audioBuffer, opts = {}) {
    const fps = Math.max(1, Math.min(120, Math.round(opts.fps || 30)));
    const width = Math.max(1, Math.round(opts.width || 1920));
    const height = Math.max(1, Math.round(opts.height || 1080));
    const bitrate = Math.max(1_000_000, Math.round(opts.videoBitsPerSecond || Math.max(2_000_000, width * height * fps * 0.18)));
    const progress = typeof opts.onProgress === 'function' ? opts.onProgress : () => { };
    if (!frameEntries?.length) throw new Error(tr('No rendered frames available for WebM encoding.'));

    try {
        const { ffmpeg, fetchFile } = await _ensureFfmpegBundle();
        const digits = Math.max(4, String(frameEntries.length).length);
        const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const framePattern = `cfexp_${stamp}_%0${digits}d.png`;
        const outputName = `cfexp_${stamp}.webm`;
        const cleanupNames = [];

        let offProgress = null;
        if (typeof ffmpeg.on === 'function') {
            offProgress = ({ progress: ratio }) => {
                const safe = Math.max(0, Math.min(1, Number(ratio) || 0));
                progress(safe, Math.max(1, Math.round(safe * frameEntries.length)), frameEntries.length);
            };
            try { ffmpeg.on('progress', offProgress); } catch { }
        }

        try {
            for (let i = 0; i < frameEntries.length; i++) {
                const entry = frameEntries[i];
                const blob = entry?.blob ? entry.blob : (typeof entry?.getBlob === 'function' ? await entry.getBlob() : (entry?.fileHandle?.getFile ? await entry.fileHandle.getFile() : null));
                if (!blob) throw new Error(tr('A buffered export frame could not be read.'));
                const ffName = `cfexp_${stamp}_${String(i + 1).padStart(digits, '0')}.png`;
                cleanupNames.push(ffName);
                await ffmpeg.writeFile(ffName, await fetchFile(blob));
                progress((i + 1) / Math.max(1, frameEntries.length), i + 1, frameEntries.length);
                if ((i % 2) === 0 || i + 1 === frameEntries.length) await _yieldToBrowser();
            }

            let audioName = '';
            if (audioBuffer) {
                const wavBlob = _audioBufferToWavBlob(audioBuffer);
                if (wavBlob) {
                    audioName = `cfexp_${stamp}.wav`;
                    cleanupNames.push(audioName);
                    await ffmpeg.writeFile(audioName, await fetchFile(wavBlob));
                }
            }

            const args = [
                '-framerate', String(fps),
                '-i', framePattern,
                '-c:v', 'libvpx-vp9',
                '-pix_fmt', 'yuv420p',
                '-b:v', `${Math.max(1000, Math.round(bitrate / 1000))}k`,
                '-r', String(fps),
                '-s', `${width}x${height}`,
                '-row-mt', '1',
                '-deadline', 'good',
                '-cpu-used', '2'
            ];
            if (audioName) {
                args.push('-i', audioName, '-c:a', 'libopus', '-b:a', '192k', '-shortest');
            } else {
                args.push('-an');
            }
            args.push('-y', outputName);

            await ffmpeg.exec(args);
            const out = await ffmpeg.readFile(outputName);
            cleanupNames.push(outputName);
            return new Blob([out.buffer ? out : new Uint8Array(out)], { type: 'video/webm' });
        } finally {
            for (const name of cleanupNames) {
                try { await ffmpeg.deleteFile(name); } catch { }
            }
            if (typeof ffmpeg.off === 'function' && offProgress) {
                try { ffmpeg.off('progress', offProgress); } catch { }
            }
        }
    } catch (err) {
        console.warn('FFmpeg disk-buffered encode failed, falling back to in-memory encode.', err);
        const frameBlobs = [];
        for (let i = 0; i < frameEntries.length; i++) {
            const entry = frameEntries[i];
            const blob = entry?.blob ? entry.blob : (typeof entry?.getBlob === 'function' ? await entry.getBlob() : (entry?.fileHandle?.getFile ? await entry.fileHandle.getFile() : null));
            if (!blob) throw err;
            frameBlobs.push(blob);
        }
        return await _encodeRenderedFramesToWebm(frameBlobs, audioBuffer, opts);
    }
}

function _getSupportedWebmMimeType() {
    const MR = window.MediaRecorder;
    if (!MR) return '';
    const candidates = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm'
    ];
    for (const mime of candidates) {
        try {
            if (MR.isTypeSupported && MR.isTypeSupported(mime)) return mime;
        } catch { }
    }
    return 'video/webm';
}

function _sleep(ms) {
    return new Promise(resolve => window.setTimeout(resolve, Math.max(0, ms || 0)));
}

async function _encodeRenderedFramesToWebm(frameBlobs, audioBuffer, opts = {}) {
    const fps = Math.max(1, Math.min(120, Math.round(opts.fps || 30)));
    const width = Math.max(1, Math.round(opts.width || 1920));
    const height = Math.max(1, Math.round(opts.height || 1080));
    const bitrate = Math.max(1_000_000, Math.round(opts.videoBitsPerSecond || Math.max(2_000_000, width * height * fps * 0.18)));
    const progress = typeof opts.onProgress === 'function' ? opts.onProgress : () => { };
    if (!frameBlobs?.length) throw new Error(tr('No rendered frames available for WebM encoding.'));
    if (!window.MediaRecorder) throw new Error(tr('MediaRecorder is not available in this browser.'));

    const playbackCanvas = document.createElement('canvas');
    playbackCanvas.width = width;
    playbackCanvas.height = height;
    const ctx = playbackCanvas.getContext('2d', { alpha: false, desynchronized: false });
    if (!ctx) throw new Error(tr('Playback canvas could not be created.'));
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);

    const canvasStream = playbackCanvas.captureStream(0);
    const videoTrack = canvasStream.getVideoTracks()[0] || null;
    const canRequestFrame = !!(videoTrack && typeof videoTrack.requestFrame === 'function');
    const outStream = new MediaStream();
    if (videoTrack) outStream.addTrack(videoTrack);

    let audioContext = null;
    let destination = null;
    let source = null;
    if (audioBuffer) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) throw new Error(tr('AudioContext is not available in this browser.'));
        audioContext = new AC({ sampleRate: audioBuffer.sampleRate || 48000 });
        destination = audioContext.createMediaStreamDestination();
        source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(destination);
        for (const track of destination.stream.getAudioTracks()) outStream.addTrack(track);
    }

    const mimeType = _getSupportedWebmMimeType();
    const recorder = new MediaRecorder(outStream, {
        mimeType,
        videoBitsPerSecond: bitrate,
        audioBitsPerSecond: 192000
    });

    const chunks = [];
    let stopped = false;
    let stopResolver = null;
    let stopRejecter = null;
    const stoppedPromise = new Promise((resolve, reject) => {
        stopResolver = resolve;
        stopRejecter = reject;
    });

    recorder.ondataavailable = (ev) => {
        if (ev?.data && ev.data.size) chunks.push(ev.data);
    };
    recorder.onerror = (ev) => {
        const err = ev?.error || ev;
        if (!stopped) {
            stopped = true;
            stopRejecter(err instanceof Error ? err : new Error(String(err?.message || err || 'MediaRecorder error')));
        }
    };
    recorder.onstop = () => {
        if (stopped) return;
        stopped = true;
        stopResolver();
    };

    const frameDurationMs = 1000 / fps;
    const frameDurationSec = 1 / fps;
    const renderedDurationSec = frameBlobs.length * frameDurationSec;
    const audioDurationSec = audioBuffer?.duration ? Math.max(0, audioBuffer.duration) : 0;
    const finalDurationSec = Math.max(renderedDurationSec, audioDurationSec);
    const leadInMs = 250;
    const fallbackVideoWarmupMs = 100;

    const bitmaps = [];
    for (let i = 0; i < frameBlobs.length; i++) {
        bitmaps.push(await createImageBitmap(frameBlobs[i]));
        progress(Math.max(0, Math.min(0.1, ((i + 1) / frameBlobs.length) * 0.1)), i + 1, frameBlobs.length);
    }

    function drawFrame(bitmap) {
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(bitmap, 0, 0, width, height);
        if (canRequestFrame) {
            try { videoTrack.requestFrame(); } catch { }
        }
    }

    async function waitUntil(targetMs) {
        while (true) {
            const remaining = targetMs - performance.now();
            if (remaining <= 1) return;
            await _sleep(Math.min(remaining > 16 ? remaining - 8 : remaining, 50));
        }
    }

    try {
        if (audioContext) {
            try { await audioContext.resume(); } catch { }
        }

        drawFrame(bitmaps[0]);
        recorder.start(1000);

        const startAtMs = performance.now() + leadInMs;
        if (source) source.start((audioContext?.currentTime || 0) + (leadInMs / 1000));

        if (!canRequestFrame) {
            await _sleep(fallbackVideoWarmupMs);
        }

        for (let i = 0; i < bitmaps.length; i++) {
            await waitUntil(startAtMs + (i * frameDurationMs));
            drawFrame(bitmaps[i]);
            progress((i + 1) / bitmaps.length, i + 1, bitmaps.length);
        }

        await waitUntil(startAtMs + (finalDurationSec * 1000) + Math.max(120, frameDurationMs * 2));
        if (recorder.state !== 'inactive') recorder.stop();
        await stoppedPromise;
    } finally {
        try { source && source.stop(0); } catch { }
        try { source && source.disconnect(); } catch { }
        try { bitmaps.forEach(bitmap => { try { bitmap.close && bitmap.close(); } catch { }; }); } catch { }
        try { canvasStream.getTracks().forEach(t => t.stop()); } catch { }
        try { outStream.getTracks().forEach(t => t.stop()); } catch { }
        try { audioContext && audioContext.close(); } catch { }
    }

    if (!chunks.length) throw new Error(tr('The browser encoder produced an empty WebM file.'));
    return new Blob(chunks, { type: mimeType || 'video/webm' });
}

function _withTemporaryRenderSettings(resolution, motionBlurSamples) {
    const prev = {
        pixelRatio: renderer.getPixelRatio ? renderer.getPixelRatio() : (window.devicePixelRatio || 1),
        styleW: renderer.domElement.style.width,
        styleH: renderer.domElement.style.height,
        mbEnabled: MOTION_BLUR.enabled,
        mbSamples: MOTION_BLUR.samples,
        mbInited: MOTION_BLUR.inited,
    };
    renderer.setPixelRatio(1);
    renderer.setSize(resolution.w, resolution.h, false);
    renderer.domElement.style.width = "100vw";
    renderer.domElement.style.height = "100vh";
    camera.aspect = resolution.w / resolution.h;
    camera.updateProjectionMatrix();
    MOTION_BLUR.enabled = true;
    MOTION_BLUR.samples = Math.max(1, Math.round(motionBlurSamples || MOTION_BLUR.samples || 1));
    MOTION_BLUR.inited = false;
    return () => {
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(window.innerWidth, window.innerHeight, false);
        renderer.domElement.style.width = prev.styleW;
        renderer.domElement.style.height = prev.styleH;
        camera.aspect = window.innerWidth / Math.max(1, window.innerHeight);
        camera.updateProjectionMatrix();
        MOTION_BLUR.enabled = prev.mbEnabled;
        MOTION_BLUR.samples = prev.mbSamples;
        MOTION_BLUR.inited = prev.mbInited;
    };
}


function _renderExportSceneAt(renderTime) {
    timeline.playhead = Math.max(0, Math.min(+timeline.duration || getProjectDuration() || 0, Number(renderTime) || 0));
    applyTimelineAt(timeline.playhead);
    mouth.setParams({ fps: +ui.mouthFps.value, thrF: +ui.mouthThrF.value, thrE: +ui.mouthThrE.value, thrA: +ui.mouthThrA.value });
    const exportClipActive = !!(voice.isClipActiveAt && voice.isClipActiveAt(timeline.playhead));
    const exportRms = voice.getRmsAt ? voice.getRmsAt(timeline.playhead, 1 / Math.max(1, +ui.mouthFps.value || 20)) : 0;
    if (mouth.applyRms) mouth.applyRms(exportRms, exportClipActive);
    updateCameraFromUI();
    applyBrightnessFromUI();
    updateCharReadout();

    const show = (+ui.showH.value) > 0.5;
    ui.hline.style.opacity = show ? "0.8" : "0.0";
    if (show) {
        const y = 0.5 - (+ui.horizon.value) * 0.5;
        ui.hline.style.top = (y * innerHeight) + "px";
    }
    if (grid) grid.visible = (+ui.showGrid.value) > 0.5;

    const rot = rotStepsFromDeg(ui.rot.value);
    const sx = +ui.sx.value, sy = +ui.sy.value;
    const ox = +ui.ox.value, oy = +ui.oy.value;
    const fx = +ui.fx.value, fy = +ui.fy.value;
    const bias = +ui.bias.value;
    const clipSoft = +ui.clipSoft.value;
    const dfR = 1.8;
    const dfE = 0.051;

    cubeMat.uniforms.uScale.value.set(sx, sy);
    cubeMat.uniforms.uOffset.value.set(ox, oy);
    cubeMat.uniforms.uFlip.value.set(fx, fy);
    cubeMat.uniforms.uRot.value = rot;
    cubeMat.uniforms.uBias.value = bias;
    cubeMat.uniforms.uClipSoft.value = clipSoft;
    cubeMat.uniforms.uCamPos.value.copy(camera.position);
    cubeMat.uniforms.uNear.value = camera.near;
    cubeMat.uniforms.uFar.value = camera.far;
    cubeMat.uniforms.uDfRadius.value = dfR;
    cubeMat.uniforms.uDfEdge.value = dfE;

    for (const ch of characters) ch.group.traverse((o) => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const mat of mats) {
            const U = mat && mat.userData && mat.userData.__dcUniforms;
            if (!U) continue;
            if (U.uRot) U.uRot.value = rot;
            if (U.uNear) U.uNear.value = camera.near;
            if (U.uFar) U.uFar.value = camera.far;
            if (U.uBias) U.uBias.value = bias;
            if (U.uClipSoft) U.uClipSoft.value = clipSoft;
            if (U.uDfRadius) U.uDfRadius.value = dfR;
            if (U.uDfEdge) U.uDfEdge.value = dfE;
        }
    });

    shadowMat.uniforms.uScale.value.set(sx, sy);
    shadowMat.uniforms.uOffset.value.set(ox, oy);
    shadowMat.uniforms.uFlip.value.set(fx, fy);
    shadowMat.uniforms.uRot.value = rot;
    shadowMat.uniforms.uBias.value = bias;
    shadowMat.uniforms.uStrength.value = +ui.shStr.value;
    shadowMat.uniforms.uRadius.value = +ui.shRad.value;
    shadowMat.uniforms.uSoftness.value = +ui.shSoft.value;
    shadowMat.uniforms.uOffsetUV.value.set(+ui.shOx.value, +ui.shOy.value);
    shadowMat.uniforms.uDfRadius.value = dfR;
    shadowMat.uniforms.uDfEdge.value = dfE;

    const shadowInfos = [];
    for (const ch of characters) {
        try {
            if (!ch || !ch.group || !ch.group.visible) continue;
            shadowInfos.push(getCharacterContactInfo(ch));
        } catch { }
    }
    if (!shadowInfos.length) shadowInfos.push(getActorContactInfo());
    const primaryShadowInfo = shadowInfos[0];
    shadowMat.uniforms.uCenterUV.value.copy(primaryShadowInfo.uv);
    shadowMat.uniforms.uCenterDepth01.value = primaryShadowInfo.depth01;

    overlayMat.uniforms.uScale.value.set(sx, sy);
    overlayMat.uniforms.uOffset.value.set(ox, oy);
    overlayMat.uniforms.uFlip.value.set(fx, fy);
    overlayMat.uniforms.uRot.value = rot;
    overlayMat.uniforms.uAlpha.value = +ui.overlay.value;
    updateSelectionOutline();

    const _tm = renderer.toneMapping;
    const _tme = renderer.toneMappingExposure;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1.0;

    renderer.setRenderTarget(rtScene);
    renderer.clear();
    if (+ui.shStr.value > 0.0001) {
        for (const info of shadowInfos) {
            shadowMat.uniforms.uCenterUV.value.copy(info.uv);
            shadowMat.uniforms.uCenterDepth01.value = info.depth01;
            renderer.render(shadowScene, orthoCam);
        }
    }
    renderOnionSkinPasses();
    renderer.render(scene3d, camera);
    if (+ui.overlay.value > 0.001) renderer.render(overlayScene, orthoCam);
    renderer.setRenderTarget(null);

    renderer.toneMapping = _tm;
    renderer.toneMappingExposure = _tme;
}

function _presentExportTexture(tex) {
    presentMat.uniforms.tTex.value = tex;
    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.render(presentScene, postCam);
}

function _renderExportSingleFrameAt(renderTime) {
    _renderExportSceneAt(renderTime);
    _presentExportTexture(rtScene.texture);
}

function _renderExportMotionBlurFrame(targetCanvas, width, height, centerTime, sampleCount, frameDt) {
    if (!targetCanvas) return;
    if (targetCanvas.width !== width) targetCanvas.width = width;
    if (targetCanvas.height !== height) targetCanvas.height = height;

    const samples = Math.max(1, Math.min(128, Math.round(sampleCount || 1)));
    if (samples <= 1) {
        _renderExportSingleFrameAt(centerTime);
        _composeCleanfeedFrame(targetCanvas, width, height);
        return;
    }

    const shutter = Math.max(1 / 480, Number(frameDt) || (1 / 30));
    const half = shutter * 0.5;
    const accumCanvas = _renderExportMotionBlurFrame._accumCanvas || (_renderExportMotionBlurFrame._accumCanvas = document.createElement("canvas"));
    const sampleCanvas = _renderExportMotionBlurFrame._sampleCanvas || (_renderExportMotionBlurFrame._sampleCanvas = document.createElement("canvas"));
    if (accumCanvas.width !== width) accumCanvas.width = width;
    if (accumCanvas.height !== height) accumCanvas.height = height;
    if (sampleCanvas.width !== width) sampleCanvas.width = width;
    if (sampleCanvas.height !== height) sampleCanvas.height = height;

    const accumCtx = accumCanvas.getContext("2d", { alpha: false, desynchronized: true });
    const sampleCtx = sampleCanvas.getContext("2d", { alpha: false, desynchronized: true });
    const targetCtx = targetCanvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!accumCtx || !sampleCtx || !targetCtx) return;

    accumCtx.globalCompositeOperation = 'source-over';
    accumCtx.globalAlpha = 1;
    accumCtx.clearRect(0, 0, width, height);
    accumCtx.fillStyle = '#000';
    accumCtx.fillRect(0, 0, width, height);

    for (let s = 0; s < samples; s++) {
        const u = (s + 0.5) / samples;
        const sampleTime = Math.max(0, centerTime - half + shutter * u);
        _renderExportSingleFrameAt(sampleTime);
        _composeCleanfeedFrame(sampleCanvas, width, height);
        if (s === 0) {
            accumCtx.globalCompositeOperation = 'copy';
            accumCtx.globalAlpha = 1;
        } else {
            accumCtx.globalCompositeOperation = 'source-over';
            accumCtx.globalAlpha = 1 / (s + 1);
        }
        accumCtx.drawImage(sampleCanvas, 0, 0, width, height);
    }

    accumCtx.globalCompositeOperation = 'source-over';
    accumCtx.globalAlpha = 1;
    targetCtx.globalCompositeOperation = 'copy';
    targetCtx.globalAlpha = 1;
    targetCtx.drawImage(accumCanvas, 0, 0, width, height);
    targetCtx.globalCompositeOperation = 'source-over';
}

async function exportScreenshot() {
    const res = getExportResolution();
    const filename = `${getExportFilenameBase()}_${res.label}.png`;
    const canvas = document.createElement("canvas");
    const wasClean = document.body.classList.contains("cleanfeed-hide");
    toggleCleanfeedUI(true);
    try {
        const restoreRender = _withTemporaryRenderSettings(res, +exportUI.mbSamples.value || 8);
        try {
            await _yieldToBrowser();
            await _yieldToBrowser();
            _renderExportSingleFrameAt(timeline.playhead);
            _composeCleanfeedFrame(canvas, res.w, res.h);
            const blob = await _canvasToBlob(canvas, "image/png", +exportUI.quality.value || 0.92);
            _downloadBlob(blob, filename);
            setExportProgress(1, trFormat("Screenshot exported: {filename}", { filename }), res.label);
        } finally { restoreRender(); }
    } finally { toggleCleanfeedUI(wasClean); }
}

function _collectExportAudioClips(start, end) {
    const out = [];
    const pushClips = (list) => {
        for (const clip of Array.isArray(list) ? list : []) {
            if (!clip || !clip.enabled || !clip.buffer) continue;
            const clipStart = Math.max(0, Number(clip.t) || 0);
            const clipEnd = clipStart + Math.max(0, Number(clip.buffer.duration) || 0);
            if (clipEnd <= start || clipStart >= end) continue;
            out.push({ buffer: clip.buffer, start: clipStart });
        }
    };
    pushClips(voice?.clips); pushClips(foley?.clips);
    return out;
}

async function _createExportAudioTrack(start, end) {
    const clips = _collectExportAudioClips(start, end);
    if (!clips.length) return null;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const ac = new AC();
    const dest = ac.createMediaStreamDestination();
    const gain = ac.createGain();
    gain.gain.value = 1.0;
    gain.connect(dest);
    const sources = [];
    for (const clip of clips) {
        const src = ac.createBufferSource();
        src.buffer = clip.buffer;
        src.connect(gain);
        const offset = Math.max(0, start - clip.start);
        const when = ac.currentTime + Math.max(0, clip.start - start) + 0.05;
        const available = Math.max(0, (clip.buffer.duration || 0) - offset);
        const dur = Math.max(0, Math.min(available, end - Math.max(start, clip.start)));
        try { if (dur > 0) src.start(when, offset, dur); sources.push(src); } catch { }
    }
    return {
        track: dest.stream.getAudioTracks()[0] || null,
        stop() {
            for (const src of sources) { try { src.stop(0); } catch { } try { src.disconnect(); } catch { } }
            try { gain.disconnect(); } catch { }
            setTimeout(() => { try { ac.close(); } catch { } }, 120);
        }
    };
}

function _crc32(bytes) {
    if (!_crc32.table) {
        const table = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            table[i] = c >>> 0;
        }
        _crc32.table = table;
    }
    let crc = -1;
    for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ _crc32.table[(crc ^ bytes[i]) & 255];
    return (crc ^ (-1)) >>> 0;
}

async function _buildStoredZipBlob(files, onProgress) {
    const encoder = new TextEncoder();
    const prepared = [];
    let localSize = 0;
    for (let i = 0; i < files.length; i++) {
        const nameBytes = encoder.encode(String(files[i].name || `frame_${i + 1}.png`));
        const data = new Uint8Array(await files[i].blob.arrayBuffer());
        const crc = _crc32(data);
        prepared.push({ nameBytes, data, crc, offset: localSize >>> 0 });
        localSize += 30 + nameBytes.length + data.length;
        if (onProgress && ((i % 2) === 0 || i + 1 === files.length)) onProgress((i + 1) / Math.max(1, files.length));
    }
    const centralSize = prepared.reduce((n, e) => n + 46 + e.nameBytes.length, 0);
    const out = new Uint8Array(localSize + centralSize + 22);
    const view = new DataView(out.buffer);
    let pos = 0;
    const w16 = (v) => { view.setUint16(pos, v, true); pos += 2; };
    const w32 = (v) => { view.setUint32(pos, v >>> 0, true); pos += 4; };
    for (const e of prepared) {
        w32(0x04034b50); w16(20); w16(0); w16(0); w16(0); w16(0); w32(e.crc); w32(e.data.length); w32(e.data.length); w16(e.nameBytes.length); w16(0);
        out.set(e.nameBytes, pos); pos += e.nameBytes.length;
        out.set(e.data, pos); pos += e.data.length;
    }
    const centralOffset = pos;
    for (const e of prepared) {
        w32(0x02014b50); w16(20); w16(20); w16(0); w16(0); w16(0); w16(0); w32(e.crc); w32(e.data.length); w32(e.data.length); w16(e.nameBytes.length); w16(0); w16(0); w16(0); w16(0); w32(0); w32(e.offset);
        out.set(e.nameBytes, pos); pos += e.nameBytes.length;
    }
    w32(0x06054b50); w16(0); w16(0); w16(prepared.length); w16(prepared.length); w32(pos - centralOffset); w32(centralOffset); w16(0);
    return new Blob([out], { type: 'application/zip' });
}

async function _savePngSequenceZip(frames, outName) {
    if (window.JSZip) {
        const zip = new window.JSZip();
        for (const frame of frames) zip.file(frame.name, frame.blob);
        const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 3 } }, (meta) => {
            setExportProgress(0.94 + 0.06 * Math.max(0, Math.min(1, (meta?.percent || 0) / 100)), tr('Packing PNG ZIP…'), `${Math.round(meta?.percent || 0)}%`);
        });
        _downloadBlob(zipBlob, outName);
        return;
    }
    const zipBlob = await _buildStoredZipBlob(frames, (ratio) => {
        setExportProgress(0.94 + 0.06 * Math.max(0, Math.min(1, ratio || 0)), tr('Packing PNG ZIP (built-in)…'), `${Math.round((ratio || 0) * 100)}%`);
    });
    _downloadBlob(zipBlob, outName);
}

async function _exportAudioOnlyWav() {
    const range = getExportRange();
    if (!(range.end > range.start + 1e-6)) throw new Error(tr("Nothing to export in the selected range."));
    const base = getExportFilenameBase();
    setExportProgress(0.05, tr('Rendering export audio…'), tr('Mixing dialog / foley'));
    const wavBlob = await _renderExportAudioWav(range.start, range.end);
    if (!wavBlob) throw new Error(tr('No audio clips are active in the selected range.'));
    const filename = `${base}_${range.label}.wav`;
    _downloadBlob(wavBlob, filename);
    setExportProgress(1, tr('WAV export complete.'), filename);
}

async function _encodeWebmFromRendererStream(composeCanvas, audioBuffer, opts = {}) {
    const fps = Math.max(1, Math.min(120, Math.round(opts.fps || 30)));
    const width = Math.max(1, Math.round(opts.width || composeCanvas?.width || 1920));
    const height = Math.max(1, Math.round(opts.height || composeCanvas?.height || 1080));
    const bitrate = Math.max(1_000_000, Math.round(opts.videoBitsPerSecond || Math.max(2_000_000, width * height * fps * 0.18)));
    const totalFrames = Math.max(1, Math.round(opts.totalFrames || 1));
    const renderFrame = typeof opts.renderFrame === 'function' ? opts.renderFrame : null;
    const progress = typeof opts.onProgress === 'function' ? opts.onProgress : () => { };
    if (!composeCanvas || !renderFrame) throw new Error(tr('Streaming WebM export could not be initialized.'));
    if (!window.MediaRecorder) throw new Error(tr('MediaRecorder is not available in this browser.'));

    const stream = composeCanvas.captureStream(fps);
    const videoTrack = stream.getVideoTracks()[0] || null;
    const canRequestFrame = !!(videoTrack && typeof videoTrack.requestFrame === 'function');
    const outStream = new MediaStream();
    if (videoTrack) outStream.addTrack(videoTrack);

    let audioContext = null;
    let destination = null;
    let source = null;
    if (audioBuffer) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) throw new Error(tr('AudioContext is not available in this browser.'));
        audioContext = new AC({ sampleRate: audioBuffer.sampleRate || 48000 });
        destination = audioContext.createMediaStreamDestination();
        source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(destination);
        for (const track of destination.stream.getAudioTracks()) outStream.addTrack(track);
    }

    const mimeType = _getSupportedWebmMimeType();
    const recorder = new MediaRecorder(outStream, {
        mimeType,
        videoBitsPerSecond: bitrate,
        audioBitsPerSecond: 192000
    });
    const chunks = [];
    recorder.ondataavailable = (ev) => { if (ev?.data?.size) chunks.push(ev.data); };
    const stoppedPromise = new Promise((resolve, reject) => {
        recorder.onstop = () => resolve();
        recorder.onerror = (ev) => reject(ev?.error || ev || new Error('MediaRecorder error'));
    });

    const frameDurationMs = 1000 / fps;
    const leadInMs = 120;
    const startAtMs = performance.now() + leadInMs;

    try {
        if (audioContext) { try { await audioContext.resume(); } catch { } }
        renderFrame(0);
        if (canRequestFrame) { try { videoTrack.requestFrame(); } catch { } }
        recorder.start(1000);
        if (source) source.start((audioContext?.currentTime || 0) + (leadInMs / 1000));
        for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
            const targetMs = startAtMs + frameIndex * frameDurationMs;
            while (true) {
                const remaining = targetMs - performance.now();
                if (remaining <= 1) break;
                await _sleep(Math.min(remaining > 16 ? remaining - 8 : remaining, 50));
            }
            renderFrame(frameIndex);
            if (canRequestFrame) { try { videoTrack.requestFrame(); } catch { } }
            progress((frameIndex + 1) / totalFrames, frameIndex + 1, totalFrames);
            if ((frameIndex % 1) === 0 || frameIndex + 1 === totalFrames) await _yieldToBrowser();
        }
        await _sleep(Math.max(200, frameDurationMs * 2));
        if (recorder.state !== 'inactive') recorder.stop();
        await stoppedPromise;
    } finally {
        try { source && source.stop(); } catch { }
        try { source && source.disconnect(); } catch { }
        try { destination && destination.disconnect(); } catch { }
        try { audioContext && audioContext.close(); } catch { }
        try { outStream.getTracks().forEach(track => track.stop()); } catch { }
    }

    if (!chunks.length) throw new Error(tr('The browser encoder produced an empty WebM file.'));
    return new Blob(chunks, { type: mimeType || 'video/webm' });
}

async function exportRealtimeCapture(format) {
    _syncExportModeConstraints();
    const res = getExportResolution();
    const fps = Math.max(1, Math.min(120, Math.round(+exportUI.fps.value || 30)));
    const quality = Math.max(0.10, Math.min(1.0, +exportUI.quality.value || 0.92));
    const range = getExportRange();
    if (!(range.end > range.start + 1e-6)) throw new Error(tr("Nothing to export in the selected range."));
    const base = getExportFilenameBase();
    const composeCanvas = document.createElement("canvas");
    const wasClean = document.body.classList.contains("cleanfeed-hide");
    const prevPlayhead = timeline.playhead;
    const prevPlaying = timeline.playing;
    const prevRec = timeline.recording;
    const prevScrub = timeline._scrubbing;
    const sampleCount = Math.max(1, Math.min(128, Math.round(+exportUI.mbSamples.value || 1)));
    const restoreRender = _withTemporaryRenderSettings(res, sampleCount);
    let finalizingTimer = 0;
    let tempFrameDir = null;
    try {
        toggleCleanfeedUI(true);
        try { voice.stop(); } catch { }
        try { foley.stop(); } catch { }
        timeline.recording = false;
        timeline._scrubbing = false;
        timeline.playing = false;
        timeline.duration = Math.max(+timeline.duration || 0, getProjectDuration());
        timeline.playhead = range.start;
        applyTimelineAt(timeline.playhead);
        syncTransportUI();

        const frameDt = 1 / fps;
        const totalFrames = Math.max(1, Math.ceil(range.duration * fps));
        const digits = Math.max(4, String(totalFrames).length);
        composeCanvas.width = res.w;
        composeCanvas.height = res.h;

        if (format === 'png' || format === 'png-folder') {
            let dirHandle = null;
            const useFolder = format === 'png-folder';
            if (useFolder) {
                dirHandle = await _pickExportDirectory({ restoreFullscreen: true });
                if (!dirHandle) throw new Error(tr('Folder export is not available in this browser.'));
            }
            const frames = useFolder ? null : [];
            setExportProgress(0, tr('Rendering PNG sequence…'), `${res.label} · ${fps} fps`);
            for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
                const centerTime = Math.min(range.end, range.start + (frameIndex / fps));
                timeline.playhead = centerTime;
                _renderExportMotionBlurFrame(composeCanvas, res.w, res.h, centerTime, sampleCount, frameDt);
                _drawExportPreviewFrame(composeCanvas);
                const blob = await _canvasToBlob(composeCanvas, 'image/png', 1);
                const frameName = `${base}_${res.label}_${String(frameIndex + 1).padStart(digits, '0')}.png`;
                if (useFolder) await _writeBlobToDirectory(dirHandle, frameName, blob);
                else frames.push({ name: frameName, blob });
                const progress = Math.max(0, Math.min(useFolder ? 1 : 0.94, ((frameIndex + 1) / totalFrames) * (useFolder ? 1 : 0.94)));
                setExportProgress(progress, tr('Rendering PNG sequence…'), trFormat('{current} / {total} frames', { current: frameIndex + 1, total: totalFrames }));
                if ((frameIndex % 1) === 0 || frameIndex + 1 === totalFrames) await _yieldToBrowser();
            }
            if (useFolder) {
                setExportProgress(1, tr('PNG sequence export complete.'), tr('Frames were written directly into the selected folder.'));
            } else {
                await _savePngSequenceZip(frames, `${base}_${res.label}_${fps}fps_png_sequence.zip`);
                setExportProgress(1, tr('PNG sequence export complete.'), `${res.label} · ${fps} fps`);
            }
            return;
        }

        let audioBuffer = null;
        try {
            setExportProgress(0.02, tr('Rendering export audio…'), tr('Mixing dialog / foley'));
            audioBuffer = await _renderExportAudioBuffer(range.start, range.end);
        } catch (audioErr) {
            console.warn('Audio render failed:', audioErr);
        }

        setExportProgress(0.04, tr('Rendering frames to disk…'), `${res.label} · ${fps} fps`);
        tempFrameDir = await _getDiskBackedTempExportDirectory(base);
        const frameEntries = [];
        if (tempFrameDir) {
            for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
                const centerTime = Math.min(range.end, range.start + (frameIndex / fps));
                timeline.playhead = centerTime;
                _renderExportMotionBlurFrame(composeCanvas, res.w, res.h, centerTime, sampleCount, frameDt);
                _drawExportPreviewFrame(composeCanvas);
                const blob = await _canvasToBlob(composeCanvas, 'image/png', 1);
                const frameName = `${base}_${res.label}_${String(frameIndex + 1).padStart(digits, '0')}.png`;
                const fileHandle = await _writeBlobToDirectory(tempFrameDir, frameName, blob);
                frameEntries.push({
                    name: frameName,
                    fileHandle,
                    getBlob: async () => await fileHandle.getFile()
                });
                const p = Math.max(0.04, Math.min(0.72, 0.04 + (((frameIndex + 1) / totalFrames) * 0.68)));
                setExportProgress(p, tr('Rendering frames to disk…'), trFormat('{current} / {total} frames', { current: frameIndex + 1, total: totalFrames }));
                if ((frameIndex % 1) === 0 || frameIndex + 1 === totalFrames) await _yieldToBrowser();
            }
        } else {
            for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
                const centerTime = Math.min(range.end, range.start + (frameIndex / fps));
                timeline.playhead = centerTime;
                _renderExportMotionBlurFrame(composeCanvas, res.w, res.h, centerTime, sampleCount, frameDt);
                _drawExportPreviewFrame(composeCanvas);
                const blob = await _canvasToBlob(composeCanvas, 'image/png', 1);
                const frameName = `${base}_${res.label}_${String(frameIndex + 1).padStart(digits, '0')}.png`;
                frameEntries.push({ name: frameName, blob });
                const p = Math.max(0.04, Math.min(0.72, 0.04 + (((frameIndex + 1) / totalFrames) * 0.68)));
                setExportProgress(p, tr('Rendering frames…'), trFormat('{current} / {total} frames', { current: frameIndex + 1, total: totalFrames }));
                if ((frameIndex % 1) === 0 || frameIndex + 1 === totalFrames) await _yieldToBrowser();
            }
        }

        const encodeMetaLabel = tempFrameDir ? tr('Assembling disk-buffered frames with FFmpeg') : tr('Assembling buffered frames');
        const encodeUiState = { lastTs: 0, lastProgress: -1, lastCurrent: -1, lastMeta: '' };
        const pushStableEncodeProgress = (ratio = 0, current = 0, total = frameEntries.length, force = false) => {
            const clampedRatio = Math.max(0, Math.min(1, ratio || 0));
            const p = Math.max(0.72, Math.min(0.995, 0.72 + (clampedRatio * 0.275)));
            const metaText = (Number.isFinite(current) && Number.isFinite(total) && total > 0)
                ? trFormat('{current} / {total} encoded', { current, total })
                : encodeMetaLabel;
            const now = (window.performance && performance.now) ? performance.now() : Date.now();
            const progressDelta = Math.abs(p - (encodeUiState.lastProgress >= 0 ? encodeUiState.lastProgress : 0));
            if (!force && (now - encodeUiState.lastTs) < 120 && progressDelta < 0.003 && current === encodeUiState.lastCurrent && metaText === encodeUiState.lastMeta) return;
            encodeUiState.lastTs = now;
            encodeUiState.lastProgress = p;
            encodeUiState.lastCurrent = current;
            encodeUiState.lastMeta = metaText;
            setExportProgress(p, tr('Encoding buffered WebM…'), metaText);
        };

        pushStableEncodeProgress(0, 0, frameEntries.length, true);
        const deliveredBlob = await _encodeDiskBufferedFramesToWebm(frameEntries, audioBuffer, {
            fps,
            width: res.w,
            height: res.h,
            videoBitsPerSecond: Math.max(2_000_000, Math.round(res.w * res.h * fps * (0.10 + quality * 0.20))),
            onProgress: (ratio, current, total) => {
                pushStableEncodeProgress(ratio, current, total, false);
            }
        });

        pushStableEncodeProgress(1, frameEntries.length, frameEntries.length, true);
        const deliveredName = `${base}_${res.label}_${fps}fps.webm`;
        _downloadBlob(deliveredBlob, deliveredName);
        setExportProgress(1, tr('WebM export complete.'), trFormat('{resolution} · {fps} fps · {samples} samples', { resolution: res.label, fps, samples: sampleCount }));
    } finally {
        if (finalizingTimer) clearInterval(finalizingTimer);
        try { if (tempFrameDir) await _cleanupDirectoryContents(tempFrameDir); } catch { }
        restoreRender();
        timeline.playing = prevPlaying;
        timeline.recording = prevRec;
        timeline._scrubbing = prevScrub;
        timeline.playhead = prevPlayhead;
        applyTimelineAt(timeline.playhead);
        syncTransportUI();
        toggleCleanfeedUI(wasClean);
    }
}

async function runExportFromModal() {
    if (exportState.busy) return;
    exportState.busy = true;
    _setExportPreviewVisible(true);
    setExportProgress(0, tr("Preparing export…"), tr("Starting"));
    if (exportUI.startBtn) exportUI.startBtn.disabled = true;
    if (exportUI.closeBtn) exportUI.closeBtn.disabled = true;
    try {
        syncExportLabels();
        const mode = String(exportUI.mode?.value || "screenshot");
        if (mode === "screenshot") await exportScreenshot();
        else if (mode === "wav") await _exportAudioOnlyWav();
        else await exportRealtimeCapture(mode);
    } catch (err) {
        console.error(err);
        setExportProgress(exportState.progress || 0, trFormat('Export failed: {message}', { message: String(err?.message || err) }), tr('Error'));
        alert(`${tr('Export failed:')}
${String(err?.message || err)}`);
    } finally {
        exportState.busy = false;
        exportState.lastPreviewSource = null;
        _setExportPreviewVisible(false);
        if (exportUI.startBtn) exportUI.startBtn.disabled = false;
        if (exportUI.closeBtn) exportUI.closeBtn.disabled = false;
    }
}

function downloadProject() {
    const proj = collectProject();
    const json = JSON.stringify(proj, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    const ts = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    a.href = URL.createObjectURL(blob);
    a.download = `project_${ts}.3dmmproj`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function loadProjectsFromFiles(fileList, { mode = "replace" } = {}) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    const totalFiles = files.length;
    const modeLabel = mode === "append" ? "Project is being appended" : "Project is opening";
    showProjectLoadOverlay({ title: "Project is loading…", mode: modeLabel, file: files[0]?.name || "Project file", detail: "Reading file", progress: 0.02 });
    let first = true;
    try {
        for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
            const f = files[fileIndex];
            const fileBase = fileIndex / Math.max(totalFiles, 1);
            const fileSpan = 1 / Math.max(totalFiles, 1);
            updateProjectLoadOverlay({ title: "Project is loading…", mode: modeLabel, file: f.name, detail: `Lese Project file ${fileIndex + 1} von ${totalFiles}`, progress: fileBase + fileSpan * 0.04 });
            const txt = await f.text();
            let proj;
            try { proj = JSON.parse(txt); }
            catch { throw new Error(`JSON parse error: ${f.name}`); }

            updateProjectLoadOverlay({ title: "Project is loading…", mode: modeLabel, file: f.name, detail: `Analysiere Assets in ${f.name}`, progress: fileBase + fileSpan * 0.08 });
            if (mode === "append") {
                // If there's nothing yet, first project replaces; others append
                if (characters.reduce((n, ch) => n + ((ch.keys && ch.keys.length) || 0), 0) === 0 && first) {
                    await applyProject(proj, {
                        mode: "replace",
                        loadLabel: f.name,
                        progress: (info) => updateProjectLoadOverlay({ ...info, progress: fileBase + fileSpan * Math.max(0.08, Math.min(1, Number(info?.progress) || 0)) })
                    });
                } else {
                    await applyProject(proj, {
                        mode: "append",
                        loadLabel: f.name,
                        progress: (info) => updateProjectLoadOverlay({ ...info, progress: fileBase + fileSpan * Math.max(0.08, Math.min(1, Number(info?.progress) || 0)) })
                    });
                }
            } else {
                if (first) await applyProject(proj, {
                    mode: "replace",
                    loadLabel: f.name,
                    progress: (info) => updateProjectLoadOverlay({ ...info, progress: fileBase + fileSpan * Math.max(0.08, Math.min(1, Number(info?.progress) || 0)) })
                });
                // ignore the rest in replace-mode
            }
            first = false;
        }
        updateProjectLoadOverlay({ title: "Project is loading…", mode: modeLabel, file: files[files.length - 1]?.name || "Project file", detail: "Alle Assets sind im Buffer", progress: 1 });
        await _yieldToBrowser();
    } finally {
        setTimeout(() => hideProjectLoadOverlay(), 220);
    }
}

let _pendingLoadMode = "replace";
function openProjectPicker(mode) {
    _pendingLoadMode = mode;
    if (transport.projFile) {
        transport.projFile.value = "";
        transport.projFile.multiple = (mode === "append");
        transport.projFile.click();
    }
}

if (transport.renderExportBtn) transport.renderExportBtn.addEventListener("click", () => { openExportModal(); });
if (transport.exportBtn) transport.exportBtn.addEventListener("click", () => { closeFileMenu(); downloadProject(); });
if (exportUI.quality) exportUI.quality.addEventListener("input", syncExportLabels);
if (exportUI.mbSamples) exportUI.mbSamples.addEventListener("input", syncExportLabels);
if (exportUI.mode) exportUI.mode.addEventListener("change", _syncExportModeConstraints);
if (exportUI.resolution) exportUI.resolution.addEventListener("change", _syncExportModeConstraints);
if (exportUI.fps) exportUI.fps.addEventListener("input", _syncExportModeConstraints);
window.addEventListener('resize', () => { _syncExportPreviewCanvasSize(); if (exportState.lastPreviewSource && exportState.previewActive) _drawExportPreviewFrame(exportState.lastPreviewSource); });
if (exportUI.closeBtn) exportUI.closeBtn.addEventListener("click", closeExportModal);
if (exportUI.startBtn) exportUI.startBtn.addEventListener("click", runExportFromModal);
if (exportUI.modal) exportUI.modal.addEventListener("click", (e) => { if (e.target === exportUI.modal) closeExportModal(); });
if (transport.importBtn) transport.importBtn.addEventListener("click", () => { closeFileMenu(); openProjectPicker("replace"); });
if (transport.appendBtn) transport.appendBtn.addEventListener("click", () => { closeFileMenu(); openProjectPicker("append"); });
if (transport.importCharBtn) transport.importCharBtn.addEventListener("click", () => { closeFileMenu(); if (transport.charFile) { transport.charFile.value = ""; transport.charFile.click(); } });
if (transport.importFlatplateBtn) transport.importFlatplateBtn.addEventListener("click", () => { closeFileMenu(); if (transport.flatplateFile) { transport.flatplateFile.value = ""; transport.flatplateFile.click(); } });

if (transport.charFile) {
    transport.charFile.addEventListener("change", async (e) => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        try {
            for (const f of files) {
                const ab = await f.arrayBuffer();
                await importCharacterFromArrayBuffer(ab, f.name, { select: true });
            }
            timeline.duration = getProjectDuration();
            transport.timeSlider.max = String(Math.max(timeline.duration, 0));
            applyTimelineAt(timeline.playhead || 0);
            syncTransportUI();
        } catch (err) {
            console.error(err);
            alert(String(err?.message || err));
        } finally {
            e.target.value = "";
        }
    });
}

if (transport.flatplateFile) {
    transport.flatplateFile.addEventListener("change", async (e) => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        const replaceTarget = pendingFlatplateReplaceTarget;
        pendingFlatplateReplaceTarget = null;
        try {
            if (replaceTarget && replaceTarget.flatplate) {
                await replaceFlatplateMediaFromFile(replaceTarget, files[0], { capture: true, label: 'flatplate-media-replace' });
                if (files.length > 1) console.warn('Flatplate replacement supports only one file; additional files were ignored.');
                if (activeCharacter !== replaceTarget) setActiveCharacter(replaceTarget, { refreshMenu: false });
            } else {
                for (const f of files) {
                    await importFlatplateFromFile(f, { select: true });
                }
            }
            timeline.duration = getProjectDuration();
            transport.timeSlider.max = String(Math.max(timeline.duration, 0));
            applyTimelineAt(timeline.playhead || 0);
            syncTransportUI();
        } catch (err) {
            console.error(err);
            alert(String(err?.message || err));
        } finally {
            pendingFlatplateReplaceTarget = null;
            e.target.value = "";
        }
    });
}

if (transport.projFile) {
    transport.projFile.addEventListener("change", async (e) => {
        const files = e.target.files;
        if (!files || !files.length) return;
        try {
            await loadProjectsFromFiles(files, { mode: _pendingLoadMode });
        } catch (err) {
            console.error(err);
            alert(String(err?.message || err));
        } finally {
            // reset
            e.target.value = "";
        }
    });
}




transport.rewBtn?.addEventListener("click", rewindTimeline);
transport.playBtn?.addEventListener("click", togglePlay);
transport.recBtn?.addEventListener("click", () => {
    setRecArmed(!timeline.recArmed);
});
transport.sceneStartBtn?.addEventListener("click", () => seekToScene(0));
transport.scenePrevBtn?.addEventListener("click", () => stepScene(-1));
transport.sceneNextBtn?.addEventListener("click", () => stepScene(1));
transport.sceneEndBtn?.addEventListener("click", () => {
    const segments = getSceneBoundaries();
    seekToScene(Math.max(0, segments.length - 1));
});
transport.sceneSlider?.addEventListener("input", () => {
    seekToScene(parseInt(transport.sceneSlider.value || "0", 10), { snapToStart: true });
});
transport.takeManagerBtn?.addEventListener("click", () => toggleTakeManager());
transport.timelineFoldBtn?.addEventListener("click", () => {
    setTimelineCompactMode(!document.body.classList.contains("timeline-compact"));
});
setTimelineCompactMode(false);

if (takeUI.close) takeUI.close.addEventListener("click", () => toggleTakeManager(false));
if (takeUI.wrap) takeUI.wrap.addEventListener("click", (e) => e.stopPropagation());
if (takeUI.header) takeUI.header.addEventListener("pointerdown", _startTakeManagerDrag);
window.addEventListener("pointermove", _moveTakeManagerDrag);
window.addEventListener("pointerup", _stopTakeManagerDrag);
window.addEventListener("resize", _applyTakeManagerPosition);
if (takeUI.takeSelect) {
    ["keydown", "keyup", "keypress", "pointerdown", "mousedown", "click"].forEach((type) => {
        takeUI.takeSelect.addEventListener(type, (e) => e.stopPropagation(), { passive: false });
    });
    takeUI.takeSelect.addEventListener("focus", () => { keys.clear(); _finishManualMoveGesture(); });
    takeUI.takeSelect.addEventListener("change", () => {
        const sceneIndex = _getCurrentTakeSceneIndex();
        const scene = _ensureSceneTakeData(sceneIndex);
        const currentTake = scene.takes[scene.selectedTakeIndex] || scene.takes[0] || null;
        if (currentTake) _storeCurrentSceneIntoTake(sceneIndex, currentTake);
        scene.selectedTakeIndex = Math.max(0, Math.min(scene.takes.length - 1, parseInt(takeUI.takeSelect.value || "0", 10)));
        const nextTake = scene.takes[scene.selectedTakeIndex] || scene.takes[0] || null;
        takeManagerState.activeSceneIndex = -1;
        takeManagerState.activeTakeId = null;
        if (nextTake) _applyTakeToScene(sceneIndex, nextTake, { refresh: false });
        renderTakeManager();
        syncTransportUI();
    });
}
if (takeUI.takeNameInput) {
    ["keydown", "keyup", "keypress", "pointerdown", "mousedown", "click"].forEach((type) => {
        takeUI.takeNameInput.addEventListener(type, (e) => e.stopPropagation(), { passive: false });
    });
    const applyTakeName = ({ live = false } = {}) => {
        const sceneIndex = _getCurrentTakeSceneIndex();
        const scene = _ensureSceneTakeData(sceneIndex);
        const takeIndex = Math.max(0, Math.min(scene.takes.length - 1, Math.round(Number(scene.selectedTakeIndex) || 0)));
        const take = scene.takes[takeIndex] || scene.takes[0] || null;
        if (!take) return;
        const fallback = _defaultTakeLabel(takeIndex);
        const rawValue = String(takeUI.takeNameInput.value || "");
        take.name = live ? (rawValue || fallback) : (rawValue.trim() || fallback);
        _refreshTakeOptionLabel(sceneIndex, takeIndex);
        _refreshTakeSummary(sceneIndex);
        if (!live) {
            renderTakeManager();
            syncTransportUI();
        }
    };
    takeUI.takeNameInput.addEventListener("focus", () => { takeManagerState.nameEditing = true; keys.clear(); _finishManualMoveGesture(); });
    takeUI.takeNameInput.addEventListener("input", () => applyTakeName({ live: true }));
    takeUI.takeNameInput.addEventListener("change", () => applyTakeName({ live: false }));
    takeUI.takeNameInput.addEventListener("blur", () => {
        takeManagerState.nameEditing = false;
        applyTakeName({ live: false });
    });
}
if (takeUI.addBtn) takeUI.addBtn.addEventListener("click", () => createTakeForCurrentScene({ duplicate: false }));
if (takeUI.duplicateBtn) takeUI.duplicateBtn.addEventListener("click", () => createTakeForCurrentScene({ duplicate: true }));
if (takeUI.deleteBtn) takeUI.deleteBtn.addEventListener("click", deleteCurrentTakeForScene);

transport.timeSlider?.addEventListener("pointerdown", () => {
    // Scrubbing should PAUSE everything immediately (playback + recording + voice)
    timeline._scrubbing = true;

    if (timeline.playing) {
        timeline.playing = false;
        timeline.playbackRate = 1;
        timeline.shuttleStepIndex = 0;
        timeline.shuttleDirection = 1;
        updatePlayButtonIcon();
    }

    if (timeline.recording) {
        stopRecording();
    }

    try { voice.stop(); } catch { }
    try { foley.stop(); } catch { }
});
addEventListener("pointerup", () => { timeline._scrubbing = false; });

transport.timeSlider?.addEventListener("input", () => {
    const scene = getCurrentSceneSegment();
    const localT = parseFloat(transport.timeSlider.value || "0");
    timeline.playhead = _clamp(scene.start + localT, scene.start, scene.end);
    applyTimelineAt(timeline.playhead);
    syncTransportUI();
});

function updateKeyboard(dt) {
    const speed = 2.0;
    let dx = 0, dy = 0, dz = 0;
    if (pressedShortcutForAction("moveLeft") || keys.has("arrowleft")) dx -= 1;
    if (pressedShortcutForAction("moveRight") || keys.has("arrowright")) dx += 1;
    if (pressedShortcutForAction("moveForward") || keys.has("arrowup")) dz -= 1;
    if (pressedShortcutForAction("moveBackward") || keys.has("arrowdown")) dz += 1;
    if (pressedShortcutForAction("moveDown")) dy -= 1;
    if (pressedShortcutForAction("moveUp")) dy += 1;

    const mag = Math.hypot(dx, dy, dz);
    if (mag <= 1e-9) return;
    if (!timeline.recording) _beginManualMoveGesture('keyboard-transform');

    const len = mag || 1;
    dx /= len; dy /= len; dz /= len;

    getActiveActor().position.x += dx * speed * dt;
    getActiveActor().position.y += dy * speed * dt;
    getActiveActor().position.z += dz * speed * dt;
}

// ---------- Mouse drag on model (no pointer lock: cursor stays where you release) ----------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
dragging = false;
let activePointerId = null;
let dragStartTransform = null;
let dragStartCharacter = null;
let dragWasRecording = false;


let lastClientX = 0;
let lastClientY = 0;

// Soft facing direction while dragging
let targetYaw = 0;
const tmpMoveDir = new THREE.Vector3();

function clientToNDC(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((clientY - rect.top) / rect.height) * 2 + 1;
    return { x, y };
}

function pickActor(clientX, clientY) {
    // ensure camera matches UI *now* (fix grabbing after horizon/pitch changes)
    updateCameraFromUI();
    // Make sure world matrices are up to date BEFORE raycasting
    camera.updateMatrixWorld(true);
    scene3d.updateMatrixWorld(true);
    for (const ch of characters) { try { ch.group.updateMatrixWorld(true); } catch { } }
    if (anim.root) anim.root.updateMatrixWorld(true);

    const { x, y } = clientToNDC(clientX, clientY);
    ndc.set(x, y);
    raycaster.setFromCamera(ndc, camera);

    // Prefer explicit mesh list if we have it (more robust across GLB structures)
    const targets = characters.flatMap(ch => (Array.isArray(ch.pickables) && ch.pickables.length) ? ch.pickables : [ch.group]);
    const hits = raycaster.intersectObjects(targets, true);
    if (!hits.length) return null;
    return hits[0];
}

function _getCharacterScreenRect(ch) {
    try {
        const box = new THREE.Box3().setFromObject(ch.group);
        if (box.isEmpty()) return null;
        const min = box.min, max = box.max;
        const pts = [
            new THREE.Vector3(min.x, min.y, min.z), new THREE.Vector3(min.x, min.y, max.z),
            new THREE.Vector3(min.x, max.y, min.z), new THREE.Vector3(min.x, max.y, max.z),
            new THREE.Vector3(max.x, min.y, min.z), new THREE.Vector3(max.x, min.y, max.z),
            new THREE.Vector3(max.x, max.y, min.z), new THREE.Vector3(max.x, max.y, max.z),
        ];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minDepth = Infinity;
        for (const p of pts) {
            p.project(camera);
            if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue;
            const sx = (p.x * 0.5 + 0.5) * innerWidth;
            const sy = (-p.y * 0.5 + 0.5) * innerHeight;
            minX = Math.min(minX, sx); minY = Math.min(minY, sy);
            maxX = Math.max(maxX, sx); maxY = Math.max(maxY, sy);
            minDepth = Math.min(minDepth, p.z);
        }
        if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
        return { minX, minY, maxX, maxY, minDepth, area: Math.max(1, (maxX - minX) * (maxY - minY)) };
    } catch {
        return null;
    }
}

function pickCharacterCandidates(clientX, clientY) {
    updateCameraFromUI();
    camera.updateMatrixWorld(true);
    scene3d.updateMatrixWorld(true);
    for (const ch of characters) { try { ch.group.updateMatrixWorld(true); } catch { } }
    const { x, y } = clientToNDC(clientX, clientY);
    ndc.set(x, y);
    raycaster.setFromCamera(ndc, camera);
    const targets = characters.flatMap(ch => (Array.isArray(ch.pickables) && ch.pickables.length) ? ch.pickables : [ch.group]);
    const hits = raycaster.intersectObjects(targets, true);
    const seen = new Set();
    const out = [];
    for (const hit of hits) {
        const ch = findCharacterByObject(hit.object);
        if (!ch || seen.has(ch.runtimeUid)) continue;
        seen.add(ch.runtimeUid);
        out.push(ch);
    }

    // Fallback: use an expanded screen-space rect so animated/moving characters stay clickable.
    const fallback = [];
    for (const ch of characters) {
        if (seen.has(ch.runtimeUid)) continue;
        const rect = _getCharacterScreenRect(ch);
        if (!rect) continue;
        const w = Math.max(0, rect.maxX - rect.minX);
        const h = Math.max(0, rect.maxY - rect.minY);
        const pad = Math.max(22, Math.min(56, Math.max(w, h) * 0.12));
        if (clientX < rect.minX - pad || clientX > rect.maxX + pad || clientY < rect.minY - pad || clientY > rect.maxY + pad) continue;
        fallback.push({ ch, depth: rect.minDepth, area: rect.area });
    }
    fallback.sort((a, b) => (a.depth - b.depth) || (a.area - b.area));
    for (const item of fallback) out.push(item.ch);
    return out;
}
function _appendCharacterSelectorSection(el, candidates) {
    if (!Array.isArray(candidates) || candidates.length <= 1) return;
    _menuSep(el);
    const hdr = document.createElement('div');
    hdr.textContent = tr('Character');
    hdr.style.opacity = '0.8';
    hdr.style.padding = '2px 8px 6px';
    el.appendChild(hdr);
    candidates.forEach((ch, idx) => {
        el.appendChild(_menuItem(_getCharacterDisplayName(ch, idx), () => {
            setActiveCharacter(ch, { refreshMenu: false });
            buildAnimMenuItems();
        }, activeCharacter === ch));
    });
}

function _serializeFlatplateHistoryEntry(ch) {
    if (!ch || !ch.flatplate || !ch.source || ch.source.kind !== 'flatplate') return null;
    return {
        name: String(ch.source.name || ch.name || 'flatplate'),
        fps: Math.max(1, _num(ch.flatplate.fps, ch.source.fps || 24)),
        mode: _normalizeFlatplateModeValue(ch.flatplate.mode || ch.source.playback || 'forward'),
        stopAtLastFrame: !!(ch.flatplate.stopAtLastFrame ?? ch.source.stopAtLastFrame),
        infinite: _normalizeFlatplateInfinite(ch.flatplate.infinite ?? ch.source.infinite),
        repeats: _normalizeFlatplateRepeatCount(ch.flatplate.repeats ?? ch.source.repeats, 1),
        planeHeight: Math.max(0.05, _num(ch.source.planeHeight, 1.8)),
        planeWidth: Math.max(0.05, _num(ch.source.planeWidth, 1)),
        frames: (Array.isArray(ch.source.frames) ? ch.source.frames : []).map(f => ({
            name: String(f?.name || 'frame.png'),
            dataUrl: String(f?.dataUrl || ''),
            width: Math.max(1, _num(f?.width, 1)),
            height: Math.max(1, _num(f?.height, 1)),
        })).filter(f => f.dataUrl),
    };
}
function _flatplateHistoryKey(entry) {
    if (!entry) return '';
    const first = Array.isArray(entry.frames) ? entry.frames[0] : null;
    return [String(entry.name || ''), Math.round(_num(entry.fps, 24)), String(entry.mode || 'forward'), Array.isArray(entry.frames) ? entry.frames.length : 0, String(first?.dataUrl || '').slice(0, 96)].join('::');
}
function _sanitizeFlatplateHistoryEntries(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of list) {
        const entry = {
            name: String(raw?.name || 'flatplate'),
            fps: Math.max(1, _num(raw?.fps, 24)),
            mode: _normalizeFlatplateModeValue(raw?.mode || 'forward'),
            stopAtLastFrame: !!raw?.stopAtLastFrame,
            infinite: _normalizeFlatplateInfinite(raw?.infinite),
            repeats: _normalizeFlatplateRepeatCount(raw?.repeats, 1),
            planeHeight: Math.max(0.05, _num(raw?.planeHeight, 1.8)),
            planeWidth: Math.max(0.05, _num(raw?.planeWidth, 1)),
            frames: (Array.isArray(raw?.frames) ? raw.frames : []).map(f => ({
                name: String(f?.name || 'frame.png'),
                dataUrl: String(f?.dataUrl || ''),
                width: Math.max(1, _num(f?.width, 1)),
                height: Math.max(1, _num(f?.height, 1)),
            })).filter(f => f.dataUrl),
        };
        if (!entry.frames.length) continue;
        const key = _flatplateHistoryKey(entry);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(entry);
        if (out.length >= 8) break;
    }
    return out;
}
function _loadFlatplateHistory() {
    try { localStorage.removeItem('flatplateRecentHistory'); } catch (_err) { }
    return [];
}
function _saveFlatplateHistory(list) {
    recentFlatplateHistory = _sanitizeFlatplateHistoryEntries(list);
    try { localStorage.removeItem('flatplateRecentHistory'); } catch (_err) { }
    return recentFlatplateHistory;
}
let recentFlatplateHistory = _loadFlatplateHistory();
function _rememberFlatplateHistory(ch) {
    const entry = _serializeFlatplateHistoryEntry(ch);
    if (!entry || !entry.frames.length) return;
    const key = _flatplateHistoryKey(entry);
    recentFlatplateHistory = [entry].concat((Array.isArray(recentFlatplateHistory) ? recentFlatplateHistory : []).filter(item => _flatplateHistoryKey(item) !== key)).slice(0, 8);
    _saveFlatplateHistory(recentFlatplateHistory);
}
function _appendFlatplateHistorySection(el, ch) {
    recentFlatplateHistory = _sanitizeFlatplateHistoryEntries(recentFlatplateHistory);
    const current = _serializeFlatplateHistoryEntry(ch);
    const currentKey = _flatplateHistoryKey(current);
    const items = recentFlatplateHistory.filter(item => _flatplateHistoryKey(item) !== currentKey).slice(0, 6);
    if (!items.length) return;
    _menuSep(el);
    const hdr = document.createElement('div');
    hdr.textContent = 'Recent plates';
    hdr.style.opacity = '0.8';
    hdr.style.padding = '2px 8px 6px';
    el.appendChild(hdr);
    items.forEach((entry) => {
        const frameCount = Array.isArray(entry.frames) ? entry.frames.length : 0;
        const label = `${entry.name} · ${frameCount}f · ${Math.round(_num(entry.fps, 24))} fps`;
        el.appendChild(_menuItem(label, () => {
            if (!activeCharacter || !activeCharacter.flatplate) return;
            _rememberFlatplateHistory(activeCharacter);
            Promise.resolve(_replaceFlatplateFrames(activeCharacter, entry.frames, {
                sourceName: entry.name,
                planeHeight: Math.max(0.05, _num(activeCharacter?.source?.planeHeight, entry.planeHeight)),
            })).then(() => {
                activeCharacter.flatplate.fps = Math.max(1, _num(entry.fps, activeCharacter.flatplate.fps || 24));
                activeCharacter.flatplate.mode = _normalizeFlatplateModeValue(entry.mode || 'forward');
                activeCharacter.flatplate.stopAtLastFrame = !!entry.stopAtLastFrame;
                activeCharacter.flatplate.infinite = _normalizeFlatplateInfinite(entry.infinite);
                activeCharacter.flatplate.repeats = _normalizeFlatplateRepeatCount(entry.repeats, 1);
                if (activeCharacter.source) {
                    activeCharacter.source.fps = activeCharacter.flatplate.fps;
                    activeCharacter.source.playback = activeCharacter.flatplate.mode;
                    activeCharacter.source.stopAtLastFrame = activeCharacter.flatplate.stopAtLastFrame;
                    activeCharacter.source.infinite = activeCharacter.flatplate.infinite;
                    activeCharacter.source.repeats = activeCharacter.flatplate.repeats;
                    activeCharacter.source.name = entry.name;
                }
                _rememberFlatplateHistory(activeCharacter);
                _updateFlatplateCharacter(activeCharacter, performance.now() / 1000);
                buildAnimMenuItems();
            }).catch(err => console.warn('Failed to restore recent flatplate', err));
        }, false, false));
    });
}

// Right-click animation menu on character
lastMenuCharacterCandidates = Array.isArray(lastMenuCharacterCandidates) ? lastMenuCharacterCandidates : [];
renderer.domElement.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const candidates = pickCharacterCandidates(e.clientX, e.clientY);
    const hit = pickActor(e.clientX, e.clientY);
    if (!hit && !candidates.length) { hideAnimMenu(); return; }
    const hitCharacter = hit && findCharacterByObject(hit.object);
    const pickedCharacter = hitCharacter || candidates[0] || null;
    if (!pickedCharacter) { hideAnimMenu(); return; }
    const filteredCandidates = (pickedCharacter.flatplate
        ? candidates.filter(ch => ch && ch !== gregoryCharacter)
        : candidates.slice()).filter((ch, idx, arr) => ch && arr.indexOf(ch) === idx);
    lastMenuCharacterCandidates = filteredCandidates.length ? filteredCandidates : [pickedCharacter];
    setActiveCharacter(pickedCharacter, { refreshMenu: false });

    animMenuPage = "root";
    buildAnimMenuItems();
    const el = ensureAnimMenu();

    // place menu near cursor, clamp to viewport
    const pad = 8;
    const vw = innerWidth, vh = innerHeight;
    el.style.display = "block";
    el.style.left = "0px";
    el.style.top = "0px";
    const rect = el.getBoundingClientRect();
    let x = e.clientX + 8;
    let y = e.clientY + 8;
    if (x + rect.width + pad > vw) x = vw - rect.width - pad;
    if (y + rect.height + pad > vh) y = vh - rect.height - pad;
    x = Math.max(pad, x);
    y = Math.max(pad, y);
    el.style.left = x + "px";
    el.style.top = y + "px";
});

function worldUnitsPerPixelAtDepth(depthAlongCam) {
    const fovRad = THREE.MathUtils.degToRad(camera.fov);
    const viewH = 2 * depthAlongCam * Math.tan(fovRad * 0.5);
    return viewH / innerHeight;
}

// --- Drag translation speed (walking vs running) ---
const dragSpeedCfg = {
    mousePxForMax: 60, // pixels per frame-ish; higher => less sensitive to fast moves
    getProfile() {
        const name = (anim && anim.selectedName) ? String(anim.selectedName).toLowerCase() : "";
        const isRunning = name.includes("run");
        // default: walking profile (also when no animation selected)
        const min = isRunning ? (+ui.runMin.value) : (+ui.walkMin.value);
        const max = isRunning ? (+ui.runMax.value) : (+ui.walkMax.value);
        return { min, max };
    },
    factorFromDelta(dx, dy) {
        const { min, max } = this.getProfile();
        const sp = Math.hypot(dx, dy);
        const t = THREE.MathUtils.clamp(sp / this.mousePxForMax, 0, 1);
        const f = THREE.MathUtils.lerp(min, max, t);
        return f;
    }
};

function setCursor(mode) { renderer.domElement.style.cursor = mode; }

// PointerLock for infinite mouse area while dragging.
function requestPL() { try { const p = renderer.domElement.requestPointerLock(); if (p && typeof p.catch === "function") p.catch(() => { }); } catch { } }
function exitPL() { try { document.exitPointerLock(); } catch { } }

const vcurEl = document.getElementById("vcur");
let vcurX = innerWidth * 0.5;
let vcurY = innerHeight * 0.5;
function showVcur(on) { if (!vcurEl) return; vcurEl.style.opacity = on ? "1" : "0"; }
function updateVcur() {
    if (!vcurEl) return;
    const x = Math.max(0, Math.min(innerWidth, vcurX));
    const y = Math.max(0, Math.min(innerHeight, vcurY));
    vcurEl.style.left = x + "px";
    vcurEl.style.top = y + "px";
}

document.addEventListener("pointerlockchange", () => {
    // If we lost pointerlock during a drag, end the drag cleanly.
    if (dragging && document.pointerLockElement !== renderer.domElement) {
        dragging = false;
        activePointerId = null;
        document.body.classList.remove("dragging");
        setCursor("default");
        // keep virtual cursor at last position
        showVcur(true);
    }
});

renderer.domElement.addEventListener("pointerdown", (e) => {
    // Left click drag only; right click is handled by context menu above.
    if (e.button !== 0) return;

    hideAnimMenu();
    const candidates = pickCharacterCandidates(e.clientX, e.clientY);
    const hit = pickActor(e.clientX, e.clientY);
    if (!hit && !candidates.length) {
        setActiveCharacter(null, { refreshMenu: false });
        return;
    }
    const pickedCharacter = (activeCharacter && candidates.includes(activeCharacter))
        ? activeCharacter
        : ((hit && findCharacterByObject(hit.object)) || candidates[0] || gregoryCharacter);
    setActiveCharacter(pickedCharacter, { refreshMenu: false });
    if (activeCharacter && activeCharacter.flatplate) {
        _startFlatplatePlaybackHold(activeCharacter, timeline?.playhead);
    }

    dragging = true;
    dragStartCharacter = activeCharacter;
    dragStartTransform = activeCharacter ? _makeTransformSnapshotFromObject(getActiveActor()) : null;
    // REC armed => timeline overwrite/branch is captured by startRecording().
    // REC off   => plain manual transform is captured here.
    if (!timeline.recArmed) _beginManualMoveGesture('drag-transform');
    startRecording();
    dragWasRecording = !!timeline.recording;


    // If the user starts dragging during an animation cross-fade,
    // never pause the action at the end of the blend (prevents "stuck in-between" pose).
    anim.blendPauseAfter = false;
    // Start animation playback (but only while dragging)
    if (anim.action) {
        anim.action.paused = false;
        anim.playingWhileDrag = true;
    }
    activePointerId = e.pointerId;
    renderer.domElement.setPointerCapture(e.pointerId);
    setCursor("grabbing");
    lastClientX = e.clientX;
    lastClientY = e.clientY;
    vcurX = e.clientX;
    vcurY = e.clientY;
    updateVcur();
    showVcur(false);
    document.body.classList.add("dragging");
    requestPL();
    targetYaw = getActiveActor().rotation.y;
    e.preventDefault();
});

renderer.domElement.addEventListener("pointermove", (e) => {
    if (!dragging) {
        const hit = pickActor(e.clientX, e.clientY);
        setCursor(hit ? "grab" : "default");
        return;
    }
    if (activePointerId !== null && e.pointerId !== activePointerId) return;

    let dx = 0, dy = 0;
    if (document.pointerLockElement === renderer.domElement) {
        dx = e.movementX || 0;
        dy = e.movementY || 0;
        vcurX += dx;
        vcurY += dy;
    } else {
        dx = e.clientX - lastClientX;
        dy = e.clientY - lastClientY;
        lastClientX = e.clientX;
        lastClientY = e.clientY;
        vcurX = e.clientX;
        vcurY = e.clientY;
    }
    updateVcur();
    // ALT: scale up/down (uniform)
    if (e.altKey) {
        const s0 = getActiveActor().scale.x;
        const k = 0.01; // sensitivity
        const s1 = THREE.MathUtils.clamp(s0 * Math.exp(-dy * k), 0.05, 20.0);
        getActiveActor().scale.setScalar(s1);
        e.preventDefault();
        return;
    }

    // X / Y / Z + mouse drag: rotate the active 3D character on the chosen axis without Ctrl.
    const heldRotAxis = getRotationAxisFromHeldKeys();
    if (heldRotAxis && !(e.ctrlKey || e.metaKey || keys.has('ctrl') || keys.has('meta'))) {
        const rotAxis = heldRotAxis;
        const rotSpeed = 0.006; // rad per pixel
        const ang = dx * rotSpeed;
        if (Math.abs(ang) > 1e-12) {
            if (activeCharacter && activeCharacter.flatplate) {
                activeCharacter.flatplate.spin = _num(activeCharacter.flatplate.spin, 0) - ang;
                if (activeCharacter.source) activeCharacter.source.spin = activeCharacter.flatplate.spin;
                _updateFlatplateCharacter(activeCharacter, performance.now() / 1000);
                if (timeline && timeline.recording) {
                    const recT = _clamp(_num(timeline.playhead, 0), 0, Math.max(timeline.playhead, getActiveDuration(), getProjectDuration()));
                    try { upsertKeyAt(recT); } catch (err) { console.warn(err); }
                }
            } else {
                const actor = getActiveActor();
                if (actor) {
                    const qRot = new THREE.Quaternion();
                    if (rotAxis === 'x') {
                        const axisWorld = new THREE.Vector3(1, 0, 0).applyQuaternion(actor.quaternion).normalize();
                        qRot.setFromAxisAngle(axisWorld, ang);
                        actor.quaternion.premultiply(qRot);
                    } else if (rotAxis === 'z') {
                        const axisWorld = new THREE.Vector3(0, 0, 1).applyQuaternion(actor.quaternion).normalize();
                        qRot.setFromAxisAngle(axisWorld, ang);
                        actor.quaternion.premultiply(qRot);
                    } else {
                        const up = new THREE.Vector3(0, 1, 0);
                        qRot.setFromAxisAngle(up, ang);
                        actor.quaternion.premultiply(qRot);
                    }
                    if (timeline && timeline.recording) {
                        const recT = _clamp(_num(timeline.playhead, 0), 0, Math.max(timeline.playhead, getActiveDuration(), getProjectDuration()));
                        try { upsertKeyAt(recT); } catch (err) { console.warn(err); }
                    }
                }
            }
        }
        e.preventDefault();
        return;
    }

    // CTRL: keep the original drag-rotate behavior.
    // X / Y / Z can still override the rotation axis while Ctrl-dragging.
    if (e.ctrlKey || e.metaKey || keys.has('ctrl') || keys.has('meta')) {
        const rotAxis = heldRotAxis || 'y';
        const rotSpeed = 0.006; // rad per pixel
        const ang = dx * rotSpeed;
        if (Math.abs(ang) > 1e-12) {
            if (activeCharacter && activeCharacter.flatplate) {
                activeCharacter.flatplate.spin = _num(activeCharacter.flatplate.spin, 0) - ang;
                if (activeCharacter.source) activeCharacter.source.spin = activeCharacter.flatplate.spin;
                _updateFlatplateCharacter(activeCharacter, performance.now() / 1000);
                if (timeline && timeline.recording) {
                    const recT = _clamp(_num(timeline.playhead, 0), 0, Math.max(timeline.playhead, getActiveDuration(), getProjectDuration()));
                    try { upsertKeyAt(recT); } catch (err) { console.warn(err); }
                }
            } else {
                const actor = getActiveActor();
                if (actor) {
                    const qRot = new THREE.Quaternion();
                    if (rotAxis === 'x') {
                        const axisWorld = new THREE.Vector3(1, 0, 0).applyQuaternion(actor.quaternion).normalize();
                        qRot.setFromAxisAngle(axisWorld, ang);
                        actor.quaternion.premultiply(qRot);
                    } else if (rotAxis === 'z') {
                        const axisWorld = new THREE.Vector3(0, 0, 1).applyQuaternion(actor.quaternion).normalize();
                        qRot.setFromAxisAngle(axisWorld, ang);
                        actor.quaternion.premultiply(qRot);
                    } else {
                        const up = new THREE.Vector3(0, 1, 0);
                        qRot.setFromAxisAngle(up, ang);
                        actor.quaternion.premultiply(qRot);
                    }
                    if (timeline && timeline.recording) {
                        const recT = _clamp(_num(timeline.playhead, 0), 0, Math.max(timeline.playhead, getActiveDuration(), getProjectDuration()));
                        try { upsertKeyAt(recT); } catch (err) { console.warn(err); }
                    }
                }
            }
        }
        e.preventDefault();
        return;
    }

    // ensure camera is current while dragging too
    updateCameraFromUI();

    // --- Brightness controls ---
    const exposure = +ui.exposure.value;
    const lightMul = +ui.lightMul.value;
    renderer.toneMappingExposure = exposure;

    hemiLight.intensity = baseLights.hemi * lightMul;
    ambient.intensity = baseLights.ambient * lightMul;
    keyLight.intensity = baseLights.key * lightMul;
    fillLight.intensity = baseLights.fill * lightMul;

    // --- Character info readout ---
    updateActorBBox();
    const p = getActiveActor().position;
    const r = getActiveActor().rotation;
    const s = getActiveActor().scale;
    const size = new THREE.Vector3();
    actorBBox.getSize(size);

    if (ui.charPos) {
        ui.charPos.textContent = `${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)}`;
        ui.charRot.textContent = `${THREE.MathUtils.radToDeg(r.x).toFixed(2)}°, ${THREE.MathUtils.radToDeg(r.y).toFixed(2)}°, ${THREE.MathUtils.radToDeg(r.z).toFixed(2)}°`;
        ui.charScale.textContent = `${s.x.toFixed(3)}, ${s.y.toFixed(3)}, ${s.z.toFixed(3)}`;
        ui.charSize.textContent = `${size.x.toFixed(3)} × ${size.y.toFixed(3)} × ${size.z.toFixed(3)}`;
    }

    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
    const upWorld = new THREE.Vector3(0, 1, 0);

    const camToCube = new THREE.Vector3().subVectors(getActiveActor().position, camera.position);
    const depthAlongCam = Math.max(0.1, camToCube.dot(forward));
    const unitsPerPx = worldUnitsPerPixelAtDepth(depthAlongCam);

    // Drag multiplier depends on current animation selection (walking vs running)
    const dragMul = dragSpeedCfg.factorFromDelta(dx, dy);
    if (ui.dragMulLive) {
        const prof = dragSpeedCfg.getProfile();
        ui.dragMulLive.textContent = `${dragMul.toFixed(3)}  (min ${prof.min.toFixed(2)} / max ${prof.max.toFixed(2)})`;
    }
    const moveX = right.clone().multiplyScalar(dx * unitsPerPx * dragMul);

    let move2;
    if (e.shiftKey) {
        move2 = upWorld.clone().multiplyScalar(-dy * unitsPerPx * dragMul);
    } else {
        // Depth movement speed (both directions) — controlled by Back Depth × slider
        const factor = (+ui.backDepthMul.value);
        move2 = forward.clone().multiplyScalar(-dy * unitsPerPx * factor * dragMul);
    }

    const deltaMove = moveX.clone().add(move2);
    getActiveActor().position.add(deltaMove);

    // Soft facing direction while dragging (stable: quaternion-based yaw, avoids Euler flips after scrub/resume)
    tmpMoveDir.copy(deltaMove);
    tmpMoveDir.y = 0;
    if (tmpMoveDir.lengthSq() > 1e-10) {
        const desired = tmpMoveDir.normalize();

        // current forward (local +Z) projected to XZ
        const curFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(getActiveActor().quaternion);
        curFwd.y = 0;
        if (curFwd.lengthSq() > 1e-12) {
            curFwd.normalize();

            const dot = THREE.MathUtils.clamp(curFwd.dot(desired), -1, 1);
            const crossY = curFwd.clone().cross(desired).y; // sign around Y
            const angle = Math.atan2(crossY, dot);

            // Soft interpolation toward target
            const soft = 0.12; // smaller = softer
            const step = angle * soft;

            if (Math.abs(step) > 1e-12) {
                const up = new THREE.Vector3(0, 1, 0);
                const qYaw = new THREE.Quaternion().setFromAxisAngle(up, step);
                getActiveActor().quaternion.premultiply(qYaw);
            }
        }
    }

    e.preventDefault();
});

function endDrag(e) {
    if (!dragging) return;
    const draggedCharacter = dragStartCharacter || activeCharacter;
    const beforeStop = !!timeline.recording;
    const endTransform = draggedCharacter ? _makeTransformSnapshotFromObject(draggedCharacter.group) : null;
    if (draggedCharacter && draggedCharacter.flatplate) {
        _stopFlatplatePlaybackHold(draggedCharacter, timeline?.playhead, performance.now() / 1000);
    }
    // Pause animation when releasing the character (keep phase)
    if (anim.action) { anim.action.paused = true; anim.playingWhileDrag = false; }
    stopRecording();
    if (!beforeStop && !dragWasRecording && draggedCharacter && dragStartTransform && endTransform) {
        const changed = _transformsDiffer(dragStartTransform, endTransform);
        if (changed) {
            // Manual repositioning with REC off is preview-only and must not touch
            // already recorded keys. Overwriting happens only when a new recording
            // is started from the current playhead, where startRecording() truncates
            // this character's future keys and records a fresh branch.
            syncTransportUI();
        }
    }
    _finishManualMoveGesture();
    dragging = false;
    activePointerId = null;
    dragStartTransform = null;
    dragStartCharacter = null;
    dragWasRecording = false;
    try { renderer.domElement.releasePointerCapture(e.pointerId); } catch { }
    exitPL();
    document.body.classList.remove("dragging");
    setCursor("default");
    showVcur(true);
    e.preventDefault();
}
renderer.domElement.addEventListener("pointerup", endDrag);
renderer.domElement.addEventListener("pointercancel", endDrag);
// Actor contact point for shadow (bottom center of bounding box)
function getCharacterContactInfo(ch) {
    const target = (ch && ch.group) ? ch.group : getActiveActor();
    const box = new THREE.Box3().setFromObject(target);
    if (!isFinite(box.min.x) || !isFinite(box.max.x)) {
        box.min.set(0, 0, 0);
        box.max.set(0, 0, 0);
    }
    // bottom-center in world space
    const p = new THREE.Vector3(
        (box.min.x + box.max.x) * 0.5,
        box.min.y,
        (box.min.z + box.max.z) * 0.5
    );

    const clip = p.clone().project(camera);
    const uv = new THREE.Vector2(clip.x * 0.5 + 0.5, clip.y * 0.5 + 0.5);

    const depthNdc01 = clip.z * 0.5 + 0.5;
    const near = camera.near, far = camera.far;
    const z = depthNdc01 * 2 - 1;
    const viewZ = (2 * near * far) / (far + near - z * (far - near));
    const depth01 = THREE.MathUtils.clamp((viewZ - near) / (far - near), 0, 1);
    return { uv, depth01 };
}
function getActorContactInfo() {
    return getCharacterContactInfo(activeCharacter);
}

function _forEachCharacterMaterial(fn) {
    for (const ch of characters) {
        if (!ch || !ch.group || ch.group.visible === false) continue;
        ch.group.traverse((o) => {
            if (!o || !o.isMesh || !o.material) return;
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            for (const mat of mats) {
                if (mat) fn(mat, o, ch);
            }
        });
    }
}

function _renderOnionTintPass(colorHex, opacity) {
    const backups = [];
    const prevSelectionVisible = !!selectionBox.visible;
    selectionBox.visible = false;
    _forEachCharacterMaterial((mat) => {
        const backup = {
            mat,
            transparent: mat.transparent,
            opacity: mat.opacity,
            depthWrite: mat.depthWrite,
            color: mat.color?.clone?.() || null,
            emissive: mat.emissive?.clone?.() || null,
            emissiveIntensity: mat.emissiveIntensity,
        };
        backups.push(backup);
        mat.transparent = true;
        mat.opacity = opacity;
        mat.depthWrite = false;
        if (mat.color) mat.color.lerp(new THREE.Color(colorHex), 0.72);
        if (mat.emissive) {
            mat.emissive.copy(new THREE.Color(colorHex));
            mat.emissiveIntensity = Math.max(0.35, opacity * 0.9);
        }
    });
    renderer.render(scene3d, camera);
    for (const b of backups) {
        const mat = b.mat;
        mat.transparent = b.transparent;
        mat.opacity = b.opacity;
        mat.depthWrite = b.depthWrite;
        if (b.color && mat.color) mat.color.copy(b.color);
        if (b.emissive && mat.emissive) mat.emissive.copy(b.emissive);
        if (typeof b.emissiveIntensity === 'number') mat.emissiveIntensity = b.emissiveIntensity;
    }
    selectionBox.visible = prevSelectionVisible;
}

function renderOnionSkinPasses() {
    if (!onionSkin.enabled) return;
    if (!(onionSkin.opacity > 0.0001)) return;
    const stepDt = 1 / Math.max(1, onionSkin.stepFps || 5);
    if (!(stepDt > 0)) return;
    const totalFrames = (onionSkin.pastFrames | 0) + (onionSkin.futureFrames | 0);
    if (totalFrames <= 0) return;
    if (!characters.some(ch => ch && ch.group && ch.group.visible !== false && Array.isArray(ch.keys) && ch.keys.length)) return;

    const savedPlayhead = timeline.playhead;
    const savedActive = activeCharacter;

    try {
        for (let i = onionSkin.pastFrames; i >= 1; i--) {
            const sampleT = savedPlayhead - stepDt * i;
            if (sampleT < -1e-6) continue;
            const weight = 1 - ((i - 1) / Math.max(1, onionSkin.pastFrames)) * 0.65;
            applyTimelineAt(_clamp(sampleT, 0, timeline.duration), { skipBackground: true });
            _renderOnionTintPass(0xff3a3a, onionSkin.opacity * weight);
        }
        for (let i = onionSkin.futureFrames; i >= 1; i--) {
            const sampleT = savedPlayhead + stepDt * i;
            if (sampleT > timeline.duration + 1e-6) continue;
            const weight = 1 - ((i - 1) / Math.max(1, onionSkin.futureFrames)) * 0.65;
            applyTimelineAt(_clamp(sampleT, 0, timeline.duration), { skipBackground: true });
            _renderOnionTintPass(0x41ff6a, onionSkin.opacity * weight);
        }
    } finally {
        applyTimelineAt(savedPlayhead, { skipBackground: true });
        if (activeCharacter !== savedActive) setActiveCharacter(savedActive, { refreshMenu: false });
    }
}

function applyTimelineAt(t, opts = {}) {
    if (!(opts && opts.skipBackground)) requestBackgroundTimelineApplyAt(t);
    const excludeCharacter = opts && opts.excludeCharacter ? opts.excludeCharacter : null;
    function applyForCharacter(ch, t) {
        if (excludeCharacter && ch === excludeCharacter) return;
        const keys = _dedupeAndSortKeys(Array.isArray(ch.keys) ? ch.keys : []);
        if (keys.length === 0) return;
        if (keys !== ch.keys) ch.keys = keys;
        const prevActive = activeCharacter;
        if (activeCharacter !== ch) setActiveCharacter(ch, { refreshMenu: false });
        const localDuration = +ch.duration || (keys.length ? +keys[keys.length - 1].t || 0 : 0);
        if (keys.length === 1) {
            const k = keys[0];
            getActiveActor().position.fromArray(k.p);
            getActiveActor().quaternion.fromArray(k.q);
            getActiveActor().scale.fromArray(k.s);
            setAnimCycleSpeed(k.spd ?? 1, { capture: false, refreshMenu: false });
            const onlyName = (k.a ?? null);
            _applyTimelineAnimState(onlyName, (k.at ?? 0), (k.spd ?? 1));
            if (ch.flatplate) Promise.resolve(_applyFlatplateStateToCharacter(ch, k.fp || _captureFlatplateKeyState(ch), { keepClock: true })).catch(console.warn);
            ch.animState = _copyAnimState(anim);
            if (prevActive !== ch) setActiveCharacter(prevActive, { refreshMenu: false });
            return;
        }
        const tt = _clamp(t, 0, localDuration);
        let i1 = 1;
        while (i1 < keys.length && keys[i1].t < tt) i1++;
        i1 = _clamp(i1, 1, keys.length - 1);
        const i0 = i1 - 1;
        const k0 = keys[i0], k1 = keys[i1];
        const span = Math.max(1e-6, (k1.t - k0.t));
        const u = _clamp((tt - k0.t) / span, 0, 1);
        const p = _sampleVec3(keys, i0, i1, u);
        const q = _sampleQuat(keys, i0, i1, u);
        const s = _sampleScale(keys, i0, i1, u);
        getActiveActor().position.copy(p);
        getActiveActor().quaternion.copy(q);
        getActiveActor().scale.copy(s);
        const a0 = k0.a ?? null;
        const a1 = k1.a ?? null;
        let phase = 0;
        let cycleSpeed = 1;
        let name = a0;
        if (a0 === a1) {
            const t2 = _smoothstep(u);
            const p0 = (k0.at ?? 0);
            const p1 = (k1.at ?? 0);
            let dp = p1 - p0;
            if (dp > 0.5) dp -= 1.0;
            if (dp < -0.5) dp += 1.0;
            phase = p0 + dp * t2;
            phase = (phase % 1 + 1) % 1;
            cycleSpeed = THREE.MathUtils.lerp(_num(k0.spd, 1), _num(k1.spd, 1), t2);
            name = a0;
        } else {
            phase = (k0.at ?? 0);
            cycleSpeed = _num(k0.spd, 1);
            name = a0;
        }
        setAnimCycleSpeed(cycleSpeed, { capture: false, refreshMenu: false });
        if (ch.flatplate) {
            const fpState = (u >= 0.999999) ? (k1.fp || k0.fp || _captureFlatplateKeyState(ch)) : (k0.fp || k1.fp || _captureFlatplateKeyState(ch));
            Promise.resolve(_applyFlatplateStateToCharacter(ch, fpState, { keepClock: true })).catch(console.warn);
        }

        const timelineXfade = Math.max(0, (+ui.animXfade?.value || 0));
        const nearbyTransition = _findTimelineAnimTransition(keys, tt, timelineXfade);
        if (nearbyTransition) {
            const fromName = nearbyTransition.fromKey?.a ?? null;
            const toName = nearbyTransition.toKey?.a ?? null;
            const fromSpeed = nearbyTransition.fromKey?.spd ?? 1;
            const toSpeed = nearbyTransition.toKey?.spd ?? 1;
            const fromPhase = _timelineAdvancePhase(
                fromName,
                nearbyTransition.fromKey?.at ?? 0,
                fromSpeed,
                tt - _num(nearbyTransition.fromKey?.t, tt)
            );
            const toPhase = _timelineAdvancePhase(
                toName,
                nearbyTransition.toKey?.at ?? 0,
                toSpeed,
                tt - _num(nearbyTransition.toKey?.t, tt)
            );
            _applyTimelineAnimBlend(
                fromName,
                fromPhase,
                fromSpeed,
                toName,
                toPhase,
                toSpeed,
                nearbyTransition.blend01
            );
        } else {
            _applyTimelineAnimState(name, phase, cycleSpeed);
        }
        ch.animState = _copyAnimState(anim);
        if (prevActive !== ch) setActiveCharacter(prevActive, { refreshMenu: false });
    }
    if (!characters.some(ch => (ch.keys && ch.keys.length))) return;
    t = _clamp(t, 0, timeline.duration);
    const prevActive = activeCharacter;
    for (const ch of characters) applyForCharacter(ch, t);
    if (activeCharacter !== prevActive) setActiveCharacter(prevActive, { refreshMenu: false });
}


function updateTimelineSliderDecorations() {
    const scene = getCurrentSceneSegment();
    if (transport.timeSlider) {
        transport.timeSlider.style.background = `linear-gradient(90deg, rgba(255,255,255,.12) 0%, rgba(255,255,255,.12) 100%)`;
    }
    if (transport.sceneSlider) {
        transport.sceneSlider.style.background = `linear-gradient(90deg, rgba(57,211,83,.28) 0%, rgba(57,211,83,.28) 100%)`;
        transport.sceneSlider.style.backgroundRepeat = 'no-repeat';
    }
}

function syncTransportUI() {
    _commitActiveTakeFromTimeline();
    const projectDuration = Math.max(0, Number(getProjectDuration()) || 0);
    timeline.duration = projectDuration;
    const scene = getCurrentSceneSegment();
    const localDuration = Math.max(0, scene.duration || 0);
    const localPlayhead = _clamp(timeline.playhead - scene.start, 0, localDuration);
    if (transport.timeSlider) {
        transport.timeSlider.min = "0";
        transport.timeSlider.max = String(localDuration);
        transport.timeSlider.value = String(localPlayhead);
    }
    if (transport.sceneSlider) {
        const segments = getSceneBoundaries();
        transport.sceneSlider.min = "0";
        transport.sceneSlider.max = String(Math.max(0, segments.length - 1));
        transport.sceneSlider.step = "1";
        transport.sceneSlider.value = String(scene.index || 0);
    }
    _trimTakeManagerToSceneCount();
    _applySelectedTakeForScene(Number(scene.index || 0), { refresh: false });
    const currentTakeScene = _ensureSceneTakeData(Number(scene.index || 0));
    const activeTake = currentTakeScene.takes[currentTakeScene.selectedTakeIndex] || currentTakeScene.takes[0] || null;
    const localA = localPlayhead.toFixed(2);
    const localB = localDuration.toFixed(2);
    const globalA = timeline.playhead.toFixed(2);
    const globalB = projectDuration.toFixed(2);
    const takeStars = activeTake?.rating ? `${"★".repeat(activeTake.rating)}` : "";
    const takeLabel = activeTake ? ` · ${activeTake.name}` : "";
    transport.timeReadout.textContent = `${localA}s / ${localB}s · ${tr('Scene')} ${Number(scene.index || 0) + 1}${takeLabel}`;
    if (transport.sceneReadout) transport.sceneReadout.textContent = `${globalA}s / ${globalB}s${takeStars ? ` · ${takeStars}` : ""}`;
    renderTakeManager();
    updateTimelineSliderDecorations();
}

// ---------- Motion blur (approx. 24fps @ 180° shutter, but render at max framerate) ----------
// Screen-space temporal accumulation with shutter time ~1/48s.
// We render the 3D scene into an HDR render target (HalfFloat when available),
// then accumulate in linear space, and finally tone-map on the PRESENT pass.
// This keeps the original lighting/colors and makes the Exposure slider work.

const MOTION_BLUR = {
    enabled: true,
    shutterSec: 1 / 48, // 24fps, 180° shutter
    inited: false,
};

const rtSize = new THREE.Vector2();
renderer.getDrawingBufferSize(rtSize);

function makeRT(w, h, { depth = false } = {}) {
    // Try HDR (HalfFloat) first; fall back to 8-bit if unavailable.
    const base = {
        format: THREE.RGBAFormat,
        stencilBuffer: false,
        depthBuffer: depth,
        type: THREE.HalfFloatType,
    };
    let rt;
    try {
        rt = new THREE.WebGLRenderTarget(w, h, base);
        // force linear space for HDR buffers
        rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
    } catch (err) {
        base.type = THREE.UnsignedByteType;
        rt = new THREE.WebGLRenderTarget(w, h, base);
        rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
    }
    return rt;
}

let rtScene = makeRT(rtSize.x, rtSize.y, { depth: true });
let rtAccumA = makeRT(rtSize.x, rtSize.y, { depth: false });
let rtAccumB = makeRT(rtSize.x, rtSize.y, { depth: false });

const postScene = new THREE.Scene();
const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const postMat = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
        tCur: { value: null },
        tPrev: { value: null },
        uDecay: { value: 0.0 },
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy,0.0,1.0);} `,
    fragmentShader: `
        uniform sampler2D tCur;
        uniform sampler2D tPrev;
        uniform float uDecay;
        varying vec2 vUv;
        void main(){
          vec4 c = texture2D(tCur, vUv);
          vec4 p = texture2D(tPrev, vUv);
          // EMA-style temporal accumulation (linear HDR)
          gl_FragColor = mix(c, p, clamp(uDecay, 0.0, 0.999));
        }
      `
});
postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat));

// ---------- Present pass (tone mapping + output colorspace) ----------
// Accumulation happens in linear HDR. For the final blit to the canvas we MUST apply
// renderer tone-mapping (so Exposure works) and convert linear -> output (sRGB),
// otherwise the image looks overly contrasty and Exposure appears "stuck".
const presentScene = new THREE.Scene();
const presentMat = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
        tTex: { value: null },
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy,0.0,1.0);} `,
    fragmentShader: `        uniform sampler2D tTex;
        varying vec2 vUv;
        #include <common>
        void main(){
          vec4 c = texture2D(tTex, vUv); // linear HDR
          c.rgb = toneMapping( c.rgb );
          gl_FragColor = linearToOutputTexel( c );
        }
      `
});
// Let three.js provide the correct tone-mapping defines + exposure uniform.
presentMat.toneMapped = true;
presentScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), presentMat));

// ---------- Developer depth draw mode ----------
// Renders scene objects with their framebuffer depth value instead of their materials.
// BasicDepthPacking outputs white at the near plane and black at the far plane.
const sceneDepthDebugMaterial = new THREE.MeshDepthMaterial({
    depthPacking: THREE.BasicDepthPacking,
    side: THREE.DoubleSide,
});
sceneDepthDebugMaterial.blending = THREE.NoBlending;
sceneDepthDebugMaterial.toneMapped = false;
sceneDepthDebugMaterial.skinning = true;
sceneDepthDebugMaterial.morphTargets = true;
sceneDepthDebugMaterial.morphNormals = true;

function drawSceneDepthBuffer() {
    const prevOverride = scene3d.overrideMaterial;
    const prevBackground = scene3d.background;
    const prevEnvironment = scene3d.environment;

    scene3d.overrideMaterial = sceneDepthDebugMaterial;
    scene3d.background = null;
    scene3d.environment = null;
    renderer.render(scene3d, camera);

    scene3d.overrideMaterial = prevOverride;
    scene3d.background = prevBackground;
    scene3d.environment = prevEnvironment;
}


function resizeRenderTargets() {
    renderer.getDrawingBufferSize(rtSize);

    rtScene.dispose(); rtScene = makeRT(rtSize.x, rtSize.y, { depth: true });
    rtAccumA.dispose(); rtAccumA = makeRT(rtSize.x, rtSize.y, { depth: false });
    rtAccumB.dispose(); rtAccumB = makeRT(rtSize.x, rtSize.y, { depth: false });

    MOTION_BLUR.inited = false;
}

addEventListener("resize", () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    syncCover();
    syncScreenPx();
    resizeRenderTargets();
    updateTimelineSliderDecorations();
});

// ---------- Render loop ----------
renderer.autoClear = false;
let last = performance.now();

function loop(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    // --- Animation update (while dragging OR during cross-fade) ---
    const _doAnim = !!(anim.mixer && (
        (dragging && anim.action && !anim.action.paused) ||
        (anim.blendRemaining && anim.blendRemaining > 0)
    ));
    if (_doAnim) {
        anim.mixer.update(dt);
        if (anim.blendRemaining && anim.blendRemaining > 0) {
            anim.blendRemaining -= dt;
            if (anim.blendRemaining <= 0) {
                // Blend finished: hard-set weights to avoid tiny residual influence (prevents "non-neutral" rest)
                const prev = anim.blendFrom;
                const next = anim.action;

                if (prev) {
                    // If we faded from a HOLD pose, dispose it completely after the blend.
                    if (prev === anim.holdAction) {
                        _disposeHold();
                    } else {
                        try { prev.setEffectiveWeight?.(0); } catch { }
                        try { prev.enabled = false; } catch { }
                        try { prev.stop(); } catch { }
                    }
                    anim.blendFrom = null;
                }

                if (next) {
                    try { next.enabled = true; } catch { }
                    try { next.setEffectiveWeight?.(1); } catch { }
                }

                anim.blendRemaining = 0;

                // Snap mixer once so the final pose is exactly the blended result
                try { anim.mixer.update(0); } catch { }

                if (anim.blendPauseAfter && !dragging && next) {
                    next.paused = true;
                    // Keep "none" fully neutral
                    if (next === anim.restAction) {
                        try { next.time = 0; } catch { }
                        try { anim.mixer.update(0); } catch { }
                    }
                }
            }
        }
    }
    // --- Timeline update ---
    if (timeline.recording) {
        // Recording advances from the current playhead for the ACTIVE character only.
        // Existing animation on the OTHER characters is still previewed live,
        // so you can rewind and perform against the rest of the scene.
        const prevPlayhead = timeline.playhead;
        timeline.playhead += dt;
        applyTimelineAt(timeline.playhead, { excludeCharacter: activeCharacter });
        setActiveDuration(Math.max(getActiveDuration(), timeline.playhead));
        timeline.duration = getProjectDuration();
        transport.timeSlider.max = String(Math.max(timeline.duration, 0));

        // IMPORTANT:
        // Never write multiple keys with the exact same timestamp during low FPS frames.
        // That caused zero-span segments and made characters / movement drop out while scrubbing.
        const sampleEnd = timeline.playhead + 1e-6;
        let nextT = Math.max(
            _num(timeline._nextRecT, prevPlayhead + TL_DT),
            prevPlayhead + 1e-6
        );
        while (nextT <= sampleEnd) {
            captureKey(nextT);
            timeline._lastRecT = nextT;
            nextT += TL_DT;
        }
        timeline._nextRecT = nextT;
    } else if (timeline.playing && !timeline._scrubbing) {
        const projectDuration = Math.max(0, getProjectDuration(), +timeline.duration || 0);
        timeline.playhead += dt * _num(timeline.playbackRate, 1);
        if (timeline.playhead >= projectDuration) {
            timeline.playhead = projectDuration;
            stopTimelinePlayback();
        } else if (timeline.playhead <= 0) {
            timeline.playhead = 0;
            stopTimelinePlayback();
        }
        applyTimelineAt(timeline.playhead);
    }
    syncTransportUI();

    // --- Voice trigger + LipSync update ---
    voice.updateFromTimeline(timeline.playhead, { playing: timeline.playing, recording: timeline.recording, scrubbing: timeline._scrubbing });
    foley.updateFromTimeline(timeline.playhead, { playing: timeline.playing, recording: timeline.recording, scrubbing: timeline._scrubbing });
    const rms = voice.getRms(dt);
    mouth.setParams({ fps: +ui.mouthFps.value, thrF: +ui.mouthThrF.value, thrE: +ui.mouthThrE.value, thrA: +ui.mouthThrA.value });
    mouth.update(rms, performance.now(), (voice.isAnyPlaying ? voice.isAnyPlaying() : voice.state._playing));

    updateCameraFromUI();
    for (const ch of characters) { if (ch && ch.source && ch.source.kind === 'flatplate') _updateFlatplateCharacter(ch, now / 1000); }

    const show = (+ui.showH.value) > 0.5;
    ui.hline.style.opacity = show ? "0.8" : "0.0";
    if (show) {
        const y = 0.5 - (+ui.horizon.value) * 0.5;
        ui.hline.style.top = (y * innerHeight) + "px";
    }

    // Grid visibility
    if (grid) grid.visible = (+ui.showGrid.value) > 0.5;

    updateKeyboard(dt);

    applyBrightnessFromUI();
    updateCharReadout();

    const rot = rotStepsFromDeg(ui.rot.value);
    const sx = +ui.sx.value, sy = +ui.sy.value;
    const ox = +ui.ox.value, oy = +ui.oy.value;
    const fx = +ui.fx.value, fy = +ui.fy.value;
    const bias = +ui.bias.value;
    const clipSoft = +ui.clipSoft.value;

    const dfR = 1.8;
    const dfE = 0.051;

    cubeMat.uniforms.uScale.value.set(sx, sy);
    cubeMat.uniforms.uOffset.value.set(ox, oy);
    cubeMat.uniforms.uFlip.value.set(fx, fy);
    cubeMat.uniforms.uRot.value = rot;
    cubeMat.uniforms.uBias.value = bias;
    cubeMat.uniforms.uClipSoft.value = clipSoft;
    cubeMat.uniforms.uCamPos.value.copy(camera.position);
    cubeMat.uniforms.uNear.value = camera.near;
    cubeMat.uniforms.uFar.value = camera.far;
    cubeMat.uniforms.uDfRadius.value = dfR;
    cubeMat.uniforms.uDfEdge.value = dfE;

    // --- Keep textured (original) materials in sync with the same depth-clip parameters ---
    for (const ch of characters) ch.group.traverse((o) => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const mat of mats) {
            const U = mat && mat.userData && mat.userData.__dcUniforms;
            if (!U) continue;
            if (U.uRot) U.uRot.value = rot;
            if (U.uNear) U.uNear.value = camera.near;
            if (U.uFar) U.uFar.value = camera.far;
            if (U.uBias) U.uBias.value = bias;
            if (U.uClipSoft) U.uClipSoft.value = clipSoft;
            if (U.uDfRadius) U.uDfRadius.value = dfR;
            if (U.uDfEdge) U.uDfEdge.value = dfE;
        }
    });


    shadowMat.uniforms.uScale.value.set(sx, sy);
    shadowMat.uniforms.uOffset.value.set(ox, oy);
    shadowMat.uniforms.uFlip.value.set(fx, fy);
    shadowMat.uniforms.uRot.value = rot;
    shadowMat.uniforms.uBias.value = bias;

    shadowMat.uniforms.uStrength.value = +ui.shStr.value;
    shadowMat.uniforms.uRadius.value = +ui.shRad.value;
    shadowMat.uniforms.uSoftness.value = +ui.shSoft.value;
    shadowMat.uniforms.uOffsetUV.value.set(+ui.shOx.value, +ui.shOy.value);

    shadowMat.uniforms.uDfRadius.value = dfR;
    shadowMat.uniforms.uDfEdge.value = dfE;

    const shadowInfos = [];
    for (const ch of characters) {
        try {
            if (!ch || !ch.group || !ch.group.visible) continue;
            shadowInfos.push(getCharacterContactInfo(ch));
        } catch { }
    }
    if (!shadowInfos.length) {
        shadowInfos.push(getActorContactInfo());
    }
    const primaryShadowInfo = shadowInfos[0];
    shadowMat.uniforms.uCenterUV.value.copy(primaryShadowInfo.uv);
    shadowMat.uniforms.uCenterDepth01.value = primaryShadowInfo.depth01;

    overlayMat.uniforms.uScale.value.set(sx, sy);
    overlayMat.uniforms.uOffset.value.set(ox, oy);
    overlayMat.uniforms.uFlip.value.set(fx, fy);
    overlayMat.uniforms.uRot.value = rot;
    overlayMat.uniforms.uAlpha.value = +ui.overlay.value;

    updateSelectionOutline();

    // --- Render to offscreen scene target ---
    // Render linear HDR into rtScene (tone mapping happens only when presenting to screen)
    const _tm = renderer.toneMapping;
    const _tme = renderer.toneMappingExposure;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1.0;

    renderer.setRenderTarget(rtScene);
    renderer.clear();
    if ((+ui.drawSceneDepth.value) > 0.5) {
        drawSceneDepthBuffer();
    } else {
        if (+ui.shStr.value > 0.0001) {
            for (const info of shadowInfos) {
                shadowMat.uniforms.uCenterUV.value.copy(info.uv);
                shadowMat.uniforms.uCenterDepth01.value = info.depth01;
                renderer.render(shadowScene, orthoCam);
            }
        }
        renderOnionSkinPasses();
        renderer.render(scene3d, camera);
        if (+ui.overlay.value > 0.001) renderer.render(overlayScene, orthoCam);
    }
    renderer.setRenderTarget(null);

    renderer.toneMapping = _tm;
    renderer.toneMappingExposure = _tme;
    // --- Motion blur composite ---
    if (MOTION_BLUR.enabled) {
        const decay = Math.exp(-dt / Math.max(1e-4, MOTION_BLUR.shutterSec));
        if (!MOTION_BLUR.inited) {
            // First frame: just copy current
            postMat.uniforms.tCur.value = rtScene.texture;
            postMat.uniforms.tPrev.value = rtScene.texture;
            postMat.uniforms.uDecay.value = 0.0;
            renderer.setRenderTarget(rtAccumA);
            renderer.clear();
            renderer.render(postScene, postCam);
            renderer.setRenderTarget(null);
            MOTION_BLUR.inited = true;
        } else {
            postMat.uniforms.tCur.value = rtScene.texture;
            postMat.uniforms.tPrev.value = rtAccumA.texture;
            postMat.uniforms.uDecay.value = decay;

            renderer.setRenderTarget(rtAccumB);
            renderer.clear();
            renderer.render(postScene, postCam);
            renderer.setRenderTarget(null);

            // swap
            const tmp = rtAccumA; rtAccumA = rtAccumB; rtAccumB = tmp;
        }

        // present accumulated to screen (with tone mapping + output conversion)
        presentMat.uniforms.tTex.value = rtAccumA.texture;
        renderer.setRenderTarget(null);
        renderer.clear();
        renderer.render(presentScene, postCam);
    } else {
        // present current to screen (with tone mapping + output conversion)
        presentMat.uniforms.tTex.value = rtScene.texture;
        renderer.setRenderTarget(null);
        renderer.clear();
        renderer.render(presentScene, postCam);
    }


    requestAnimationFrame(loop);
}
i18nObserver.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["title", "aria-label", "placeholder", "alt"] });
await populateLanguageSelect();
await setLanguage(currentLanguage);
requestAnimationFrame(loop);