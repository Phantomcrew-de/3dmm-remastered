/**
 * media.mjs — Audio decode helpers (WAV/PCM fallback).
 *
 * Provides parseWavToAudioBuffer and decodeAudioCompat for decoding
 * RIFF/WAVE variants that browsers cannot natively handle (PCM/Float,
 * IMA ADPCM 0x11, MS ADPCM 0x02, WAVE_FORMAT_EXTENSIBLE 0xFFFE).
 *
 * Both functions are also attached to `window.*` for backward compatibility
 * with other scripts that reference them via the global object.
 */

export { parseWavToAudioBuffer, decodeAudioCompat };

// ─── WAV / ADPCM decoder ────────────────────────────────────────────

/**
 * Parse a raw ArrayBuffer containing RIFF/WAVE data and return an AudioBuffer.
 * Supports: PCM 8/16/24/32, IEEE Float32, IMA ADPCM (0x11),
 * MS ADPCM (0x02), and WAVE_FORMAT_EXTENSIBLE (0xFFFE).
 *
 * @param {AudioContext} ac
 * @param {ArrayBuffer} arrayBuffer
 * @returns {AudioBuffer|null}
 */
function parseWavToAudioBuffer(ac, arrayBuffer) {
  try {
    const dv = new DataView(arrayBuffer);
    const u8 = new Uint8Array(arrayBuffer);
    const str = (o, l) => { let s = ""; for (let i = 0; i < l; i++) s += String.fromCharCode(dv.getUint8(o + i)); return s; };
    if (dv.byteLength < 44) return null;
    if (str(0, 4) !== "RIFF" || str(8, 4) !== "WAVE") return null;

    let off = 12;
    let fmt = null;
    let dataOff = null, dataSize = null;

    while (off + 8 <= dv.byteLength) {
      const id = str(off, 4);
      const sz = dv.getUint32(off + 4, true);
      off += 8;

      if (id === "fmt ") {
        const wFormatTag = dv.getUint16(off, true);
        const numChannels = dv.getUint16(off + 2, true);
        const sampleRate = dv.getUint32(off + 4, true);
        const avgBytesSec = dv.getUint32(off + 8, true);
        const blockAlign = dv.getUint16(off + 12, true);
        const bitsPerSample = dv.getUint16(off + 14, true);

        // resolve WAVE_FORMAT_EXTENSIBLE (0xFFFE) to PCM(1) or IEEE_FLOAT(3) when possible.
        let resolvedFormat = wFormatTag;
        let validBitsPerSample = null;
        if (wFormatTag === 0xFFFE && sz >= 40) {
          validBitsPerSample = dv.getUint16(off + 18, true);
          const subData1 = dv.getUint32(off + 24, true);
          if (subData1 === 1 || subData1 === 3) resolvedFormat = subData1;
        }

        // extra fmt fields (ADPCM)
        let cbSize = (sz >= 18) ? dv.getUint16(off + 16, true) : 0;
        let samplesPerBlock = null;
        if ((resolvedFormat === 0x11 || resolvedFormat === 0x02) && sz >= 20) {
          samplesPerBlock = dv.getUint16(off + 18, true);
        }

        // MS ADPCM coefficients
        let msAdpcmCoefs = null;
        if (resolvedFormat === 0x02 && sz >= 22) {
          const numCoef = dv.getUint16(off + 20, true);
          const coefs = [];
          let cOff = off + 22;
          for (let i = 0; i < numCoef; i++) {
            if (cOff + 4 > off + sz) break;
            coefs.push([dv.getInt16(cOff, true), dv.getInt16(cOff + 2, true)]);
            cOff += 4;
          }
          msAdpcmCoefs = coefs.length ? coefs : null;
        }

        fmt = { audioFormat: resolvedFormat, numChannels, sampleRate, bitsPerSample, blockAlign, avgBytesSec, cbSize, samplesPerBlock, validBitsPerSample, msAdpcmCoefs };
      } else if (id === "data") {
        dataOff = off;
        dataSize = sz;
      }

      off += sz + (sz % 2);
    }

    if (!fmt || dataOff == null || dataSize == null) return null;

    const { audioFormat, numChannels, sampleRate, bitsPerSample, blockAlign } = fmt;

    // ---------- PCM / IEEE Float ----------
    if (audioFormat === 1 || audioFormat === 3) {
      const bps = bitsPerSample / 8;
      if (!Number.isFinite(bps) || bps <= 0) return null;

      const frames = Math.floor(dataSize / (numChannels * bps));
      if (!Number.isFinite(frames) || frames <= 0) return null;

      const audioBuf = ac.createBuffer(numChannels, frames, sampleRate);

      for (let ch = 0; ch < numChannels; ch++) {
        const out = audioBuf.getChannelData(ch);
        for (let i = 0; i < frames; i++) {
          const p = dataOff + (i * numChannels + ch) * bps;
          let v = 0;

          if (audioFormat === 3 && bitsPerSample === 32) {
            v = dv.getFloat32(p, true);
          } else if (bitsPerSample === 8) {
            v = (dv.getUint8(p) - 128) / 128;
          } else if (bitsPerSample === 16) {
            v = dv.getInt16(p, true) / 32768;
          } else if (bitsPerSample === 24) {
            const b0 = dv.getUint8(p), b1 = dv.getUint8(p + 1), b2 = dv.getUint8(p + 2);
            let n = (b2 << 16) | (b1 << 8) | b0;
            if (n & 0x800000) n |= 0xFF000000;
            v = n / 8388608;
          } else if (bitsPerSample === 32) {
            v = dv.getInt32(p, true) / 2147483648;
          } else {
            return null;
          }
          out[i] = v;
        }
      }
      return audioBuf;
    }

    // ---------- IMA ADPCM (0x11) ----------
    if (audioFormat === 0x11) {
      const stepTable = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
      const indexTable = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

      const spb = fmt.samplesPerBlock || Math.floor(((blockAlign - (4 * numChannels)) * 8) / (4 * numChannels) + 1);
      if (!spb || spb <= 1) return null;

      const blocks = Math.floor(dataSize / blockAlign);
      if (blocks <= 0) return null;

      const totalFrames = blocks * spb;
      const audioBuf = ac.createBuffer(numChannels, totalFrames, sampleRate);
      const outs = Array.from({ length: numChannels }, (_, ch) => audioBuf.getChannelData(ch));

      let src = dataOff;
      let dstFrame = 0;

      for (let b = 0; b < blocks; b++) {
        const predictor = new Int32Array(numChannels);
        const index = new Int32Array(numChannels);

        for (let ch = 0; ch < numChannels; ch++) {
          predictor[ch] = dv.getInt16(src + ch * 4, true);
          index[ch] = dv.getUint8(src + ch * 4 + 2);
          if (index[ch] < 0) index[ch] = 0;
          if (index[ch] > 88) index[ch] = 88;
          outs[ch][dstFrame] = predictor[ch] / 32768;
        }
        dstFrame++;

        let nibOff = src + 4 * numChannels;
        const nibEnd = src + blockAlign;

        while (dstFrame < (b + 1) * spb && nibOff < nibEnd) {
          for (let ch = 0; ch < numChannels; ch++) {
            if (dstFrame >= (b + 1) * spb || nibOff >= nibEnd) break;

            const byte = dv.getUint8(nibOff++);
            const n0 = byte & 0x0F;
            const n1 = (byte >> 4) & 0x0F;

            const decodeNib = (n) => {
              let step = stepTable[index[ch]];
              let diff = step >> 3;
              if (n & 1) diff += step >> 2;
              if (n & 2) diff += step >> 1;
              if (n & 4) diff += step;
              if (n & 8) diff = -diff;
              predictor[ch] += diff;
              if (predictor[ch] > 32767) predictor[ch] = 32767;
              if (predictor[ch] < -32768) predictor[ch] = -32768;
              index[ch] += indexTable[n];
              if (index[ch] < 0) index[ch] = 0;
              if (index[ch] > 88) index[ch] = 88;
              return predictor[ch] / 32768;
            };

            outs[ch][dstFrame] = decodeNib(n0);
            if (dstFrame + 1 < (b + 1) * spb) {
              outs[ch][dstFrame + 1] = decodeNib(n1);
            }
          }
          dstFrame += 2;
        }

        src += blockAlign;
        dstFrame = (b + 1) * spb;
      }

      return audioBuf;
    }

    // ---------- MS ADPCM (0x02) ----------
    if (audioFormat === 0x02) {
      const adaptTable = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];
      const coefs = fmt.msAdpcmCoefs || [[256, 0], [512, -256], [0, 0], [192, 64], [240, 0], [460, -208], [392, -232]];
      const spb = fmt.samplesPerBlock || Math.floor((blockAlign - (7 * numChannels)) * 2 / numChannels + 2);
      if (!spb || spb <= 2) return null;

      const blocks = Math.floor(dataSize / blockAlign);
      if (blocks <= 0) return null;

      const totalFrames = blocks * spb;
      const audioBuf = ac.createBuffer(numChannels, totalFrames, sampleRate);
      const outs = Array.from({ length: numChannels }, (_, ch) => audioBuf.getChannelData(ch));

      let src = dataOff;
      let dstBase = 0;

      const clamp16 = (x) => (x > 32767 ? 32767 : (x < -32768 ? -32768 : x));

      for (let b = 0; b < blocks; b++) {
        const pred = new Int32Array(numChannels);
        const delta = new Int32Array(numChannels);
        const s1 = new Int32Array(numChannels);
        const s2 = new Int32Array(numChannels);

        let h = src;
        for (let ch = 0; ch < numChannels; ch++) {
          pred[ch] = dv.getUint8(h++);
          if (pred[ch] < 0 || pred[ch] >= coefs.length) pred[ch] = 0;
        }
        for (let ch = 0; ch < numChannels; ch++) {
          delta[ch] = dv.getInt16(h, true); h += 2;
        }
        for (let ch = 0; ch < numChannels; ch++) {
          s1[ch] = dv.getInt16(h, true); h += 2;
        }
        for (let ch = 0; ch < numChannels; ch++) {
          s2[ch] = dv.getInt16(h, true); h += 2;
        }

        for (let ch = 0; ch < numChannels; ch++) {
          outs[ch][dstBase] = s2[ch] / 32768;
          outs[ch][dstBase + 1] = s1[ch] / 32768;
        }

        let nOff = h;
        const nEnd = src + blockAlign;

        const neededNibbles = (spb - 2) * numChannels;
        let nibCount = 0;

        while (nOff < nEnd && nibCount < neededNibbles) {
          const byte = dv.getUint8(nOff++);
          const n0 = (byte >> 4) & 0x0F;
          const n1 = byte & 0x0F;

          for (const nib of [n0, n1]) {
            if (nibCount >= neededNibbles) break;

            const ch = nibCount % numChannels;
            const frame = dstBase + 2 + Math.floor(nibCount / numChannels);

            const sn = (nib & 0x08) ? (nib - 16) : nib;
            const c = coefs[pred[ch]] || coefs[0];

            let samp = ((s1[ch] * c[0] + s2[ch] * c[1]) >> 8) + sn * delta[ch];
            samp = clamp16(samp);

            s2[ch] = s1[ch];
            s1[ch] = samp;

            delta[ch] = (adaptTable[nib] * delta[ch]) >> 8;
            if (delta[ch] < 16) delta[ch] = 16;

            outs[ch][frame] = samp / 32768;

            nibCount++;
          }
        }

        src += blockAlign;
        dstBase += spb;
      }

      return audioBuf;
    }

    return null;
  } catch {
    return null;
  }
}

// ─── Smart decode helper ─────────────────────────────────────────────

/**
 * Decode helper: prefer WAV parser for RIFF/WAVE; otherwise use native decodeAudioData.
 *
 * @param {AudioContext} ac
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<AudioBuffer>}
 */
async function decodeAudioCompat(ac, arrayBuffer) {
  try {
    // If it's a WAV, try our parser first (handles ADPCM variants that browsers often reject).
    try {
      if (arrayBuffer && arrayBuffer.byteLength >= 12) {
        const dv = new DataView(arrayBuffer);
        const isWav = (dv.getUint32(0, false) === 0x52494646 /*RIFF*/ && dv.getUint32(8, false) === 0x57415645 /*WAVE*/);
        if (isWav) {
          const wb = parseWavToAudioBuffer(ac, arrayBuffer);
          if (wb) return wb;
        }
      }
    } catch { }

    const ab = (arrayBuffer && arrayBuffer.slice) ? arrayBuffer.slice(0) : arrayBuffer;
    return await ac.decodeAudioData(ab);
  } catch (e) {
    // last-chance: try WAV parser even if native failed.
    try {
      const wb = parseWavToAudioBuffer(ac, arrayBuffer);
      if (wb) return wb;
    } catch { }
    throw e;
  }
}


// ─── window.* backward compatibility bridge ──────────────────────────

window.parseWavToAudioBuffer = window.parseWavToAudioBuffer || parseWavToAudioBuffer;
window.decodeAudioCompat = window.decodeAudioCompat || decodeAudioCompat;
