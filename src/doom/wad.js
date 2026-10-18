// DOOM WAD reader: lumps, palette, pictures, sprites, sounds, textures.

const td = new TextDecoder('latin1');

export class Wad {
  constructor(buffer, label = '') {
    this.buf = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.dv = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    this.label = label;
    const id = td.decode(this.buf.subarray(0, 4));
    if (id !== 'IWAD' && id !== 'PWAD') throw new Error(`${label}: not a WAD file`);
    const n = this.dv.getInt32(4, true);
    const dir = this.dv.getInt32(8, true);
    this.lumps = [];
    for (let i = 0; i < n; i++) {
      const o = dir + i * 16;
      const pos = this.dv.getInt32(o, true);
      const size = this.dv.getInt32(o + 4, true);
      let name = td.decode(this.buf.subarray(o + 8, o + 16));
      const z = name.indexOf('\0');
      if (z >= 0) name = name.slice(0, z);
      this.lumps.push({ name: name.toUpperCase(), pos, size, index: i });
    }
    this.byName = new Map();
    for (const l of this.lumps) this.byName.set(l.name, l); // last one wins, like DOOM
  }
  has(name) {
    return this.byName.has(name);
  }
  lump(name) {
    const l = this.byName.get(name);
    return l ? this.buf.subarray(l.pos, l.pos + l.size) : null;
  }
  // lumps between two markers (e.g. S_START/S_END)
  between(start, end) {
    const out = [];
    let inside = false;
    for (const l of this.lumps) {
      if (l.name === start || l.name === start[0] + start) inside = true;
      else if (l.name === end || l.name === end[0] + end) inside = false;
      else if (inside && l.size > 0) out.push(l);
    }
    return out;
  }
}

// A set of WADs searched last-first (DOOM II overrides DOOM where both exist).
export class WadSet {
  constructor(wads) {
    this.wads = wads;
  }
  lump(name) {
    for (let i = this.wads.length - 1; i >= 0; i--) {
      const l = this.wads[i].lump(name);
      if (l) return l;
    }
    return null;
  }
  lumpFrom(wadIndex, name) {
    return this.wads[wadIndex]?.lump(name) ?? null;
  }
  has(name) {
    return this.wads.some((w) => w.has(name));
  }
}

export function readPalette(playpal, index = 0) {
  const pal = new Uint32Array(256);
  const o = index * 768;
  for (let i = 0; i < 256; i++) {
    const r = playpal[o + i * 3];
    const g = playpal[o + i * 3 + 1];
    const b = playpal[o + i * 3 + 2];
    pal[i] = 0xff000000 | (b << 16) | (g << 8) | r;
  }
  return pal;
}

// DOOM picture (patch) format -> { w, h, ox, oy, px: Int16Array (-1 = transparent) }
export function decodePicture(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const w = dv.getUint16(0, true);
  const h = dv.getUint16(2, true);
  const ox = dv.getInt16(4, true);
  const oy = dv.getInt16(6, true);
  const px = new Int16Array(w * h).fill(-1);
  for (let x = 0; x < w; x++) {
    let p = dv.getUint32(8 + x * 4, true);
    let top = -1;
    for (;;) {
      const delta = data[p];
      if (delta === 0xff) break;
      // tall patch support: a delta <= previous top is relative
      top = delta <= top ? top + delta : delta;
      const len = data[p + 1];
      for (let i = 0; i < len; i++) {
        const y = top + i;
        if (y < h) px[y * w + x] = data[p + 3 + i];
      }
      p += len + 4;
    }
  }
  return { w, h, ox, oy, px };
}

// Raw 64x64 flat
export function decodeFlat(data) {
  const px = new Int16Array(64 * 64);
  for (let i = 0; i < 4096; i++) px[i] = data[i];
  return { w: 64, h: 64, ox: 0, oy: 0, px };
}

// Composite wall texture (TEXTURE1/2 + PNAMES)
export function buildTextures(wadset) {
  const textures = new Map();
  const pnamesLump = wadset.lump('PNAMES');
  if (!pnamesLump) return textures;
  const pdv = new DataView(pnamesLump.buffer, pnamesLump.byteOffset, pnamesLump.byteLength);
  const np = pdv.getInt32(0, true);
  const pnames = [];
  for (let i = 0; i < np; i++) {
    let s = td.decode(pnamesLump.subarray(4 + i * 8, 12 + i * 8));
    const z = s.indexOf('\0');
    if (z >= 0) s = s.slice(0, z);
    pnames.push(s.toUpperCase());
  }
  for (const tname of ['TEXTURE1', 'TEXTURE2']) {
    const t = wadset.lump(tname);
    if (!t) continue;
    const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
    const n = dv.getInt32(0, true);
    for (let i = 0; i < n; i++) {
      const o = dv.getInt32(4 + i * 4, true);
      let name = td.decode(t.subarray(o, o + 8));
      const z = name.indexOf('\0');
      if (z >= 0) name = name.slice(0, z);
      const w = dv.getUint16(o + 12, true);
      const h = dv.getUint16(o + 14, true);
      const pc = dv.getUint16(o + 20, true);
      const patches = [];
      for (let k = 0; k < pc; k++) {
        const po = o + 22 + k * 10;
        patches.push({ x: dv.getInt16(po, true), y: dv.getInt16(po + 2, true), name: pnames[dv.getUint16(po + 4, true)] });
      }
      textures.set(name.toUpperCase(), { w, h, patches });
    }
  }
  return textures;
}

export function composeTexture(wadset, tex) {
  const px = new Int16Array(tex.w * tex.h).fill(-1);
  for (const p of tex.patches) {
    const data = wadset.lump(p.name);
    if (!data) continue;
    const pic = decodePicture(data);
    for (let y = 0; y < pic.h; y++) {
      const ty = p.y + y;
      if (ty < 0 || ty >= tex.h) continue;
      for (let x = 0; x < pic.w; x++) {
        const tx = p.x + x;
        if (tx < 0 || tx >= tex.w) continue;
        const c = pic.px[y * pic.w + x];
        if (c >= 0) px[ty * tex.w + tx] = c;
      }
    }
  }
  return { w: tex.w, h: tex.h, ox: 0, oy: 0, px };
}

// DMX sound lump -> { rate, samples: Float32Array }
export function decodeSound(data) {
  if (!data || data.length < 8) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getUint16(0, true) !== 3) return null;
  const rate = dv.getUint16(2, true);
  const n = dv.getUint32(4, true);
  // 16 padding bytes at each end of the sample data
  const start = 8 + 16;
  const count = Math.max(0, Math.min(n - 32, data.length - start));
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) samples[i] = (data[start + i] - 128) / 128;
  return { rate, samples };
}

// Sprite frame lookup: SPRT + frame letter + rotation, honouring the
// "A2A8"-style mirrored lump names.
export class SpriteSet {
  constructor(wadset) {
    this.wadset = wadset;
    this.frames = new Map(); // key 'PLAYA5' -> {lump, flip}
    for (const w of wadset.wads) {
      for (const l of w.between('S_START', 'S_END')) {
        const n = l.name;
        if (n.length < 6) continue;
        const base = n.slice(0, 4);
        this.frames.set(base + n[4] + n[5], { wad: w, name: n, flip: false });
        if (n.length >= 8) this.frames.set(base + n[6] + n[7], { wad: w, name: n, flip: true });
      }
    }
    this.cache = new Map();
  }
  get(sprite, frame, rot = 0) {
    const key = `${sprite}${frame}${rot}`;
    let e = this.frames.get(key);
    if (!e && rot !== 0) e = this.frames.get(`${sprite}${frame}0`);
    if (!e && rot === 0) e = this.frames.get(`${sprite}${frame}1`);
    if (!e) return null;
    let pic = this.cache.get(e.name);
    if (!pic) {
      pic = decodePicture(e.wad.lump(e.name));
      this.cache.set(e.name, pic);
    }
    return { pic, flip: e.flip };
  }
}
