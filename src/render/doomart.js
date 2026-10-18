// Turns DOOM pictures into canvases for drawing, with caching.
import { Wad, WadSet, SpriteSet, readPalette, decodePicture, decodeSound, buildTextures, composeTexture, decodeFlat } from '../doom/wad.js';

export function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function picToCanvas(pic, pal, tint = null) {
  const c = makeCanvas(pic.w, pic.h);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(pic.w, pic.h);
  const u32 = new Uint32Array(img.data.buffer);
  for (let i = 0; i < pic.px.length; i++) {
    const v = pic.px[i];
    if (v < 0) continue;
    u32[i] = tint ? tint[v] : pal[v];
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export class DoomArt {
  constructor(wadBuffers) {
    this.wads = new WadSet(wadBuffers.map((b, i) => new Wad(b, `wad${i}`)));
    this.pal = readPalette(this.wads.lump('PLAYPAL'), 0);
    this.sprites = new SpriteSet(this.wads);
    this.cache = new Map();
    this.sounds = new Map();
    this.textures = null;
    // colormap-based white/red flash palettes
    const cm = this.wads.lump('COLORMAP');
    this.colormap = cm;
  }

  sprite(name, frame, rot = 0) {
    const key = `S:${name}${frame}${rot}`;
    let e = this.cache.get(key);
    if (e === undefined) {
      const s = this.sprites.get(name, frame, rot);
      e = s ? { canvas: picToCanvas(s.pic, this.pal), w: s.pic.w, h: s.pic.h, ox: s.pic.ox, oy: s.pic.oy, flip: s.flip } : null;
      this.cache.set(key, e);
    }
    return e;
  }

  // Any lump in picture format (fonts, status bar faces, menu graphics)
  pic(lump) {
    const key = `P:${lump}`;
    let e = this.cache.get(key);
    if (e === undefined) {
      const data = this.wads.lump(lump);
      if (data) {
        const p = decodePicture(data);
        e = { canvas: picToCanvas(p, this.pal), w: p.w, h: p.h, ox: p.ox, oy: p.oy, flip: false, pic: p };
      } else e = null;
      this.cache.set(key, e);
    }
    return e;
  }

  // Composite wall texture as indexed picture
  texture(name) {
    const key = `T:${name}`;
    let e = this.cache.get(key);
    if (e === undefined) {
      // skies and wall textures come from the first WAD (DOOM), whose
      // SKY1-3 are the episode skies the themes are built around
      if (!this.texWads) this.texWads = new WadSet([this.wads.wads[0]]);
      if (!this.textures) this.textures = buildTextures(this.texWads);
      const t = this.textures.get(name);
      e = t ? composeTexture(this.texWads, t) : null;
      this.cache.set(key, e);
    }
    return e;
  }

  flat(name) {
    const key = `F:${name}`;
    let e = this.cache.get(key);
    if (e === undefined) {
      const d = this.wads.lump(name);
      e = d && d.length >= 4096 ? decodeFlat(d) : null;
      this.cache.set(key, e);
    }
    return e;
  }

  sound(name) {
    let s = this.sounds.get(name);
    if (s === undefined) {
      s = decodeSound(this.wads.lump(name));
      this.sounds.set(name, s);
    }
    return s;
  }

  lump(name) {
    return this.wads.lump(name);
  }
}
