// A small software model of the parts of the Mega Drive VDP the special stage
// uses: 4bpp tiles, two scroll planes with per-line H scroll and full-screen
// V scroll, CRAM colours, and shadow/highlight mode.

// Measured DAC output levels of the Mega Drive VDP for each 3-bit channel value.
const LEVEL_NORMAL = [0, 52, 87, 116, 144, 172, 206, 255];
const LEVEL_SHADOW = [0, 29, 52, 70, 87, 101, 116, 130];
const LEVEL_HILITE = [130, 144, 158, 172, 187, 206, 228, 255];

export function cramToRGB(c, mode = 0) {
  const t = mode === 0 ? LEVEL_NORMAL : mode === 1 ? LEVEL_SHADOW : LEVEL_HILITE;
  const r = t[(c >> 1) & 7];
  const g = t[(c >> 5) & 7];
  const b = t[(c >> 9) & 7];
  return 0xff000000 | (b << 16) | (g << 8) | r; // little-endian ABGR for Uint32 ImageData views
}

export const SCREEN_W = 256;
export const SCREEN_H = 224;

export class VDP {
  constructor() {
    this.tiles = new Uint8Array(2048 * 64); // one byte per pixel, 2048 tiles
    this.cram = new Uint16Array(64);
    this.shMode = true;
    this.planeA = new Uint16Array(128 * 32);
    this.planeB = new Uint16Array(128 * 32);
    this.planeW = 128;
    this.planeH = 32;
    this.hscrollA = new Int16Array(SCREEN_H);
    this.hscrollB = new Int16Array(SCREEN_H);
    this.vscrollA = 0;
    this.vscrollB = 0;
    this.bgColor = 0;
    this.lut = [new Uint32Array(64), new Uint32Array(64), new Uint32Array(64)];
    // optional full-colour overrides per CRAM index: 0xRRGGBB
    this.overrides = new Map();
    // optional sampler for pixels where both planes are transparent:
    // (x, y) -> ABGR colour drawn at normal intensity
    this.bgSampler = null;
    this.planeBEnabled = true;
    // when the picture has been post-processed (textured), shadow operators
    // darken the final colour instead of re-reading CRAM
    this.shadowHalves = false;
    // per-pixel intensity buffer after plane composition: 0=shadow 1=normal
    this.intensity = new Uint8Array(SCREEN_W * SCREEN_H);
    this.colorIdx = new Uint8Array(SCREEN_W * SCREEN_H);
  }

  // Load 4bpp packed tile data (32 bytes per tile) at a tile index.
  loadTiles(data, tileIndex, byteOffset = 0, count = (data.length - byteOffset) >> 5) {
    for (let t = 0; t < count; t++) {
      const dst = (tileIndex + t) * 64;
      const src = byteOffset + t * 32;
      for (let i = 0; i < 32; i++) {
        const b = data[src + i];
        this.tiles[dst + i * 2] = b >> 4;
        this.tiles[dst + i * 2 + 1] = b & 15;
      }
    }
  }

  // Load tiles stored as a single 4-byte row each, repeated for all 8 rows
  // (how ssLdComprsdData expands the special stage track art).
  loadRowTiles(data, tileIndex, byteOffset, count) {
    for (let t = 0; t < count; t++) {
      const dst = (tileIndex + t) * 64;
      for (let r = 0; r < 8; r++) {
        for (let i = 0; i < 4; i++) {
          const b = data[byteOffset + t * 4 + i];
          this.tiles[dst + r * 8 + i * 2] = b >> 4;
          this.tiles[dst + r * 8 + i * 2 + 1] = b & 15;
        }
      }
    }
  }

  // Load palette words (big-endian 9-bit colours) into CRAM.
  loadPalette(src, off, line, count = 16) {
    for (let i = 0; i < count; i++) this.cram[line * 16 + i] = (src[off + i * 2] << 8) | src[off + i * 2 + 1];
  }

  updateLUT() {
    for (let i = 0; i < 64; i++) {
      const o = this.overrides.get(i);
      if (o !== undefined) {
        const r = (o >> 16) & 255;
        const g = (o >> 8) & 255;
        const b = o & 255;
        const pack = (r2, g2, b2) => 0xff000000 | (b2 << 16) | (g2 << 8) | r2;
        this.lut[1][i] = pack(r, g, b);
        this.lut[0][i] = pack(r >> 1, g >> 1, b >> 1);
        this.lut[2][i] = pack(128 + (r >> 1), 128 + (g >> 1), 128 + (b >> 1));
        continue;
      }
      this.lut[0][i] = cramToRGB(this.cram[i], 1);
      this.lut[1][i] = cramToRGB(this.cram[i], 0);
      this.lut[2][i] = cramToRGB(this.cram[i], 2);
    }
  }

  // Fetch the pixel of a plane at plane-space coordinates. Returns
  // (priority << 8) | (palette*16 + colour); colour 0 is transparent.
  planePixel(plane, px, py) {
    const w = this.planeW * 8;
    const h = this.planeH * 8;
    px = ((px % w) + w) % w;
    py = ((py % h) + h) % h;
    const name = plane[(py >> 3) * this.planeW + (px >> 3)];
    let tx = px & 7;
    let ty = py & 7;
    if (name & 0x0800) tx = 7 - tx;
    if (name & 0x1000) ty = 7 - ty;
    const c = this.tiles[(name & 0x7ff) * 64 + ty * 8 + tx];
    const pri = (name >> 15) & 1;
    return (pri << 8) | (c ? (((name >> 13) & 3) << 4) | c : 0);
  }

  // Compose both planes into an RGBA Uint32 buffer.
  renderPlanes(out) {
    const lut = this.lut;
    for (let y = 0; y < SCREEN_H; y++) {
      const ha = this.hscrollA[y];
      const hb = this.hscrollB[y];
      const ya = y + this.vscrollA;
      const yb = y + this.vscrollB;
      for (let x = 0; x < SCREEN_W; x++) {
        const a = this.planePixel(this.planeA, x - ha, ya);
        const b = this.planeBEnabled ? this.planePixel(this.planeB, x - hb, yb) : 0;
        const pa = a >> 8;
        const pb = b >> 8;
        const ca = a & 0x3f;
        const cb = b & 0x3f;
        let c;
        if (ca && (pa || !pb || !cb)) c = ca;
        else if (cb) c = cb;
        else if (ca) c = ca;
        else c = this.bgColor;
        // Shadow/highlight: pixel is shadowed unless one of the planes has priority there.
        const inten = this.shMode && !(pa | pb) ? 0 : 1;
        const i = y * SCREEN_W + x;
        this.intensity[i] = inten;
        this.colorIdx[i] = c;
        if (!ca && !cb && this.bgSampler) {
          this.intensity[i] = 1;
          this.colorIdx[i] = 0;
          out[i] = this.bgSampler(x, y);
          continue;
        }
        out[i] = lut[inten][c];
      }
    }
  }

  // Draw a tile-based sprite piece list into the composed buffer, honouring
  // shadow/highlight operator colours (palette 3, colours 14 and 15).
  // pieces: [{x, y, w, h, tile, flipX, flipY, pal}] with w/h in tiles.
  drawTileSprite(out, pieces, ox, oy, flipX = false, flipY = false) {
    const lut = this.lut;
    for (const p of pieces) {
      const pw = p.w * 8;
      const ph = p.h * 8;
      let px0 = flipX ? -p.x - pw : p.x;
      let py0 = flipY ? -p.y - ph : p.y;
      const fx = p.flipX !== flipX;
      const fy = p.flipY !== flipY;
      for (let sy = 0; sy < ph; sy++) {
        const y = oy + py0 + sy;
        if (y < 0 || y >= SCREEN_H) continue;
        for (let sx = 0; sx < pw; sx++) {
          const x = ox + px0 + sx;
          if (x < 0 || x >= SCREEN_W) continue;
          const lx = fx ? pw - 1 - sx : sx;
          const ly = fy ? ph - 1 - sy : sy;
          // sprite tiles are column-major
          const tile = p.tile + (lx >> 3) * p.h + (ly >> 3);
          const c = this.tiles[(tile & 0x7ff) * 64 + (ly & 7) * 8 + (lx & 7)];
          if (!c) continue;
          const i = y * SCREEN_W + x;
          if (p.pal === 3 && c === 15) {
            if (this.shadowHalves) {
              if (this.intensity[i] !== 0) out[i] = 0xff000000 | ((out[i] >> 1) & 0x7f7f7f);
            } else out[i] = lut[0][this.colorIdx[i]];
            this.intensity[i] = 0;
          } else if (p.pal === 3 && c === 14) {
            const inten = Math.min(2, this.intensity[i] + 1);
            this.intensity[i] = inten;
            out[i] = lut[inten][this.colorIdx[i]];
          } else {
            const ci = p.pal * 16 + c;
            this.colorIdx[i] = ci;
            this.intensity[i] = 1;
            out[i] = lut[1][ci];
          }
        }
      }
    }
  }
}
