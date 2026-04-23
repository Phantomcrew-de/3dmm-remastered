export { ui, setLanguage, tr, trFormat, populateLanguageSelect, applyI18n, i18nObserver, currentLanguage, syncLabels, toggleMenu, exportPreviewCanvas };

// ---------- UI ----------
    const $ = (id) => document.getElementById(id);

// Localization helper functions and data structures
    // ---------- I18N ----------
    const I18N_STORAGE_KEY = "three_depth_occlusion_lang";
    const I18N_CACHE = new Map();
    const i18nTextOriginals = new WeakMap();
    let i18nDict = {};
    let currentLanguage = localStorage.getItem(I18N_STORAGE_KEY) || "en";
    let i18nApplying = false;

    async function loadLanguageFile(lang) {
      if (I18N_CACHE.has(lang)) return I18N_CACHE.get(lang);
      const url = new URL(`./lang/${lang}.json`, import.meta.url);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Language file could not be loaded: ${lang}`);
      const json = await res.json();
      const dict = (json && typeof json.translations === 'object' && !Array.isArray(json.translations)) ? json.translations : null;
      if (!dict) throw new Error(`Invalid language file: ${lang}`);
      I18N_CACHE.set(lang, dict);
      return dict;
    }

    async function loadLanguageRegistry() {
      const url = new URL('./lang/languages.json', import.meta.url);
      const res = await fetch(url);
      if (!res.ok) throw new Error('Language registry could not be loaded');
      const json = await res.json();
      return Array.isArray(json?.languages) ? json.languages : [];
    }

    async function populateLanguageSelect() {
      const select = $('languageSelect');
      if (!select) return;
      const languages = await loadLanguageRegistry();
      if (!languages.length) return;
      const current = currentLanguage;
      select.innerHTML = '';
      for (const lang of languages) {
        const option = document.createElement('option');
        option.value = lang.code;
        option.textContent = lang.name || lang.code;
        select.appendChild(option);
      }
      if ([...select.options].some(option => option.value === current)) select.value = current;
      else if ([...select.options].some(option => option.value === 'en')) select.value = 'en';
    }

    function tr(text) {
      const raw = String(text ?? '');
      if (!raw) return raw;
      return i18nDict[raw] ?? raw;
    }

    function trFormat(text, vars = {}) {
      return String(tr(text)).replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? ''));
    }


    function applyI18nToElement(el) {
      if (!el || el.nodeType !== 1) return;
      const explicitKey = el.getAttribute?.('data-i18n');
      if (explicitKey && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
        const translatedText = tr(explicitKey);
        if (el.textContent !== translatedText) el.textContent = translatedText;
      }
      const attrs = ['title', 'aria-label', 'placeholder', 'alt'];
      for (const attr of attrs) {
        if (!el.hasAttribute(attr)) continue;
        el.__i18nOriginalAttrs = el.__i18nOriginalAttrs || {};
        if (!(attr in el.__i18nOriginalAttrs)) el.__i18nOriginalAttrs[attr] = el.getAttribute(attr) || '';
        const translated = tr(el.__i18nOriginalAttrs[attr]);
        if (el.getAttribute(attr) !== translated) el.setAttribute(attr, translated);
      }
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return;
      for (const child of Array.from(el.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) {
          const original = i18nTextOriginals.has(child) ? i18nTextOriginals.get(child) : child.textContent;
          if (!i18nTextOriginals.has(child)) i18nTextOriginals.set(child, original);
          const trimmed = String(original || '').trim();
          if (!trimmed) continue;
          const leading = original.match(/^\s*/)?.[0] || '';
          const trailing = original.match(/\s*$/)?.[0] || '';
          const translated = leading + tr(trimmed) + trailing;
          if (child.textContent !== translated) child.textContent = translated;
        }
      }
    }

    function applyI18n(root = document.body) {
      if (!root) return;
      i18nApplying = true;
      try {
        if (root.nodeType === 1) applyI18nToElement(root);
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let node = walker.currentNode;
        while (node) {
          applyI18nToElement(node);
          node = walker.nextNode();
        }
        const languageSelect = $('languageSelect');
        if (languageSelect && languageSelect.value !== currentLanguage) languageSelect.value = currentLanguage;
        document.documentElement.lang = currentLanguage;
      } finally {
        i18nApplying = false;
      }
    }

    async function setLanguage(lang) {
      const nextLanguage = String(lang || 'en');
      try {
        i18nDict = await loadLanguageFile(nextLanguage);
        currentLanguage = nextLanguage;
      } catch (err) {
        console.warn('Falling back to English language file.', err);
        i18nDict = await loadLanguageFile('en');
        currentLanguage = 'en';
      }
      localStorage.setItem(I18N_STORAGE_KEY, currentLanguage);
      applyI18n(document.body);
    }

    const i18nObserver = new MutationObserver((mutations) => {
      if (i18nApplying) return;
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === 1) applyI18n(node);
            else if (node.nodeType === Node.TEXT_NODE && mutation.target?.nodeType === 1) applyI18n(mutation.target);
          });
        } else if (mutation.type === 'characterData') {
          const textNode = mutation.target;
          if (!i18nTextOriginals.has(textNode)) i18nTextOriginals.set(textNode, textNode.textContent || '');
          if (textNode.parentElement) applyI18n(textNode.parentElement);
        } else if (mutation.type === 'attributes' && mutation.target?.nodeType === 1) {
          const el = mutation.target;
          el.__i18nOriginalAttrs = el.__i18nOriginalAttrs || {};
          const attr = mutation.attributeName;
          if (attr) el.__i18nOriginalAttrs[attr] = el.getAttribute(attr) || '';
          applyI18n(el);
        }
      }
    });
    const ui = {
      overlay: $("overlay"), overlayV: $("overlayV"),
      fmm: $("fmm"), fmmV: $("fmmV"),
      horizon: $("horizon"), horizonV: $("horizonV"),
      pitch: $("pitch"), pitchV: $("pitchV"),
      camHeight: $("camHeight"), camHeightV: $("camHeightV"),
      showH: $("showH"), showHV: $("showHV"),
      showGrid: $("showGrid"), showGridV: $("showGridV"),

      shStr: $("shStr"), shStrV: $("shStrV"),
      shRad: $("shRad"), shRadV: $("shRadV"),
      shSoft: $("shSoft"), shSoftV: $("shSoftV"),
      shOx: $("shOx"), shOxV: $("shOxV"),
      shOy: $("shOy"), shOyV: $("shOyV"),

      exposure: $("exposure"), exposureV: $("exposureV"),
      lightMul: $("lightMul"), lightMulV: $("lightMulV"),

      sx: $("sx"), sxV: $("sxV"),
      sy: $("sy"), syV: $("syV"),
      ox: $("ox"), oxV: $("oxV"),
      oy: $("oy"), oyV: $("oyV"),

      rot: $("rot"),
      fx: $("fx"), fxV: $("fxV"),
      fy: $("fy"), fyV: $("fyV"),
      bias: $("bias"), biasV: $("biasV"),


      clipSoft: $("clipSoft"), clipSoftV: $("clipSoftV"),
      backDepthMul: $("backDepthMul"), backDepthMulV: $("backDepthMulV"),


      mouthFps: $("mouthFps"), mouthFpsV: $("mouthFpsV"),
      mouthThrF: $("mouthThrF"), mouthThrFV: $("mouthThrFV"),
      mouthThrE: $("mouthThrE"), mouthThrEV: $("mouthThrEV"),
      mouthThrA: $("mouthThrA"), mouthThrAV: $("mouthThrAV"),

      walkMin: $("walkMin"), walkMinV: $("walkMinV"),
      walkMax: $("walkMax"), walkMaxV: $("walkMaxV"),
      runMin: $("runMin"), runMinV: $("runMinV"),
      runMax: $("runMax"), runMaxV: $("runMaxV"),




      animXfade: $("animXfade"), animXfadeV: $("animXfadeV"),
      charPos: $("charPos"),
      charRot: $("charRot"),
      charScale: $("charScale"),
      charSize: $("charSize"),
      dragMulLive: $("dragMulLive"),

      hline: $("hline"),
      panel: $("panel"),
      togglePanel: $("togglePanel"),
    };



    
    // update label text, for example when langauge changes or when sliders are moved

    function syncLabels() {
      ui.overlayV.textContent = (+ui.overlay.value).toFixed(2);
      ui.fmmV.textContent = (+ui.fmm.value).toFixed(1);
      ui.horizonV.textContent = (+ui.horizon.value).toFixed(4);
      ui.pitchV.textContent = (+ui.pitch.value).toFixed(2);
      if (ui.camHeightV) ui.camHeightV.textContent = (+ui.camHeight.value).toFixed(2);
      ui.showHV.textContent = ui.showH.value;
      ui.showGridV.textContent = ui.showGrid.value;

      ui.shStrV.textContent = (+ui.shStr.value).toFixed(2);
      ui.shRadV.textContent = (+ui.shRad.value).toFixed(3);
      ui.shSoftV.textContent = (+ui.shSoft.value).toFixed(3);
      ui.shOxV.textContent = (+ui.shOx.value).toFixed(3);
      ui.shOyV.textContent = (+ui.shOy.value).toFixed(3);

      ui.exposureV.textContent = (+ui.exposure.value).toFixed(2);
      ui.lightMulV.textContent = (+ui.lightMul.value).toFixed(2);

      ui.sxV.textContent = (+ui.sx.value).toFixed(3);
      ui.syV.textContent = (+ui.sy.value).toFixed(3);
      ui.oxV.textContent = (+ui.ox.value).toFixed(4);
      ui.oyV.textContent = (+ui.oy.value).toFixed(4);
      ui.fxV.textContent = ui.fx.value;
      ui.fyV.textContent = ui.fy.value;
      ui.biasV.textContent = (+ui.bias.value).toFixed(4);


      ui.clipSoftV.textContent = (+ui.clipSoft.value).toFixed(4);
      ui.backDepthMulV.textContent = (+ui.backDepthMul.value).toFixed(1);

      ui.mouthFpsV.textContent = String(Math.round(+ui.mouthFps.value));
      ui.mouthThrFV.textContent = (+ui.mouthThrF.value).toFixed(3);
      ui.mouthThrEV.textContent = (+ui.mouthThrE.value).toFixed(3);
      ui.mouthThrAV.textContent = (+ui.mouthThrA.value).toFixed(3);
      ui.walkMinV.textContent = (+ui.walkMin.value).toFixed(2);
      ui.walkMaxV.textContent = (+ui.walkMax.value).toFixed(2);
      ui.runMinV.textContent = (+ui.runMin.value).toFixed(2);
      ui.runMaxV.textContent = (+ui.runMax.value).toFixed(2);
      ui.animXfadeV.textContent = (+ui.animXfade.value).toFixed(2);
    }




    
// voice threshold parameters should be ordered and within reasonable bounds, and mouth fps should be a positive integer
// enforce this on input.

    function enforceMouthParams() {
      // Keep thresholds ordered: F <= E <= A
      if (!ui.mouthThrF) return;
      let f = +ui.mouthThrF.value;
      let e = +ui.mouthThrE.value;
      let a = +ui.mouthThrA.value;
      f = Math.max(0, Math.min(0.5, f));
      e = Math.max(0, Math.min(0.5, e));
      a = Math.max(0, Math.min(0.5, a));
      const arr = [f, e, a].sort((x, y) => x - y);
      [f, e, a] = arr;
      ui.mouthThrF.value = f;
      ui.mouthThrE.value = e;
      ui.mouthThrA.value = a;
      if (ui.mouthFps) ui.mouthFps.value = Math.max(1, Math.min(60, Math.round(+ui.mouthFps.value || 20)));
      syncLabels();
    }



    // Extra: keep mouth thresholds ordered + fps integer
    if (ui.mouthThrF) ui.mouthThrF.addEventListener('input', enforceMouthParams);
    if (ui.mouthThrE) ui.mouthThrE.addEventListener('input', enforceMouthParams);
    if (ui.mouthThrA) ui.mouthThrA.addEventListener('input', enforceMouthParams);
    if (ui.mouthFps) ui.mouthFps.addEventListener('input', enforceMouthParams);


    // set default values for UI controls
    ui.overlay.value = 0.00;

    ui.fmm.value = 86.0;
    ui.horizon.value = -0.3000;
    ui.pitch.value = 0.00;
    if (ui.camHeight) ui.camHeight.value = 1.20;
    ui.showH.value = 0;


    ui.showGrid.value = 0;
    ui.shStr.value = 0.35;
    ui.shRad.value = 0.110;
    ui.shSoft.value = 0.060;
    ui.shOx.value = 0.000;
    ui.shOy.value = 0.050;

    ui.exposure.value = 1.04;
    ui.lightMul.value = 1.01;

    ui.sx.value = 1.000;
    ui.sy.value = 0.720;
    ui.ox.value = -0.0010;
    ui.oy.value = 0.1395;

    ui.rot.value = "0";
    ui.fx.value = 0;
    ui.fy.value = 1;
    ui.bias.value = 0.0127;
    ui.clipSoft.value = 0.0500;

    // Drag speed multipliers (walking vs running)
    ui.walkMin.value = 0.60;
    ui.walkMax.value = 1.10;
    ui.runMin.value = 1.00;
    ui.runMax.value = 2.40;


    function toggleMenu() { ui.panel.classList.toggle("hidden"); }
    ui.togglePanel.addEventListener("click", toggleMenu);


     const exportPreviewCanvas = document.createElement('canvas');
    exportPreviewCanvas.id = 'exportPreviewCanvas';
    Object.assign(exportPreviewCanvas.style, {
      position: 'fixed',
      inset: '0',
      width: '100vw',
      height: '100vh',
      pointerEvents: 'none',
      zIndex: '1',
      opacity: '0',
      transition: 'opacity 120ms ease',
      filter: 'blur(6px) saturate(1.08) brightness(0.92)',
      transform: 'scale(1.03)',
      transformOrigin: 'center center'
    });


