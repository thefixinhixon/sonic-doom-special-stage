// Decoder for the special stage halfpipe frames (port of SSTrack_Draw).
//
// Each frame file has three segments (bit flags, uncompressed name indices,
// RLE name indices). Decoding yields 28 rows of 128 pattern names: the plane
// is four 32-cell screens, and per-line H scroll shows screen N on lines
// 2N and 2N+1 of every 8-line tile row, quadrupling vertical resolution.

export const TRACK_ROWS = 28;
export const TRACK_COLS = 128;

class BitReader {
  constructor(src, pos) {
    this.src = src;
    this.pos = pos;
    this.buf = 0;
    this.left = 0;
  }
  // Mirrors the 68k pattern: when the buffer is empty a fresh byte is fetched.
  fetchIfEmpty() {
    if (this.left === 0) {
      this.buf = this.src[this.pos++];
      this.left = 8;
      return true;
    }
    return false;
  }
  bit() {
    this.fetchIfEmpty();
    this.left--;
    return (this.buf >> this.left) & 1;
  }
  bits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
    return v;
  }
}

function readSegment(src, pos) {
  const len = (src[pos + 2] << 8) | src[pos + 3];
  return { data: pos + 4, next: pos + 4 + len };
}

// Decode one track frame. rom: ROM bytes, off: frame offset,
// lutUnc/lutRLE: offsets of SSPNT_UncLUT / SSPNT_RLELUT in the ROM.
export function decodeTrackFrame(rom, off, pnt) {
  const seg1 = readSegment(rom, off);
  const seg2 = readSegment(rom, seg1.next);
  const seg3 = readSegment(rom, seg2.next);
  const flags = new BitReader(rom, seg1.data);
  const unc = new BitReader(rom, seg2.data);
  const rle = new BitReader(rom, seg3.data);
  const rd16 = (o) => (rom[o] << 8) | rom[o + 1];

  const names = new Uint16Array(TRACK_ROWS * TRACK_COLS);
  // per-row work counters (used to model the 68000's drawing cost)
  const work = { unc: new Uint16Array(TRACK_ROWS), runs: new Uint16Array(TRACK_ROWS), runTiles: new Uint16Array(TRACK_ROWS) };
  names.work = work;
  let w = 0;
  for (let line = 0; line < TRACK_ROWS; line++) {
    const lineStart = line * TRACK_COLS;
    w = lineStart;
    for (;;) {
      if (flags.bit()) {
        // single tile from the uncompressed list, palette line 3, low priority
        let idx;
        if (unc.bit()) idx = unc.bits(10) + (pnt.uncPart2 >> 1);
        else idx = unc.bits(6);
        names[w++] = rd16(pnt.unc + idx * 2) | 0x6000;
        work.unc[line]++;
        continue;
      }
      // RLE run; a fresh 0xFF byte at the flag position ends the line
      if (rle.left === 0) {
        rle.buf = rom[rle.pos++];
        rle.left = 8;
        if (rle.buf === 0xff) {
          rle.left = 0;
          break;
        }
      }
      rle.left--;
      const big = (rle.buf >> rle.left) & 1;
      let idx;
      if (big) {
        idx = rle.bits(7);
        if (idx === 0x7f) break;
        idx += pnt.rlePart2 >> 2;
      } else {
        idx = rle.bits(6);
      }
      const name = rd16(pnt.rle + idx * 4) | 0xe000;
      const count = rd16(pnt.rle + idx * 4 + 2) + 1;
      for (let i = 0; i < count; i++) names[w++] = name;
      work.runs[line]++;
      work.runTiles[line] += count;
    }
    if (w - lineStart !== TRACK_COLS) {
      // Not expected for valid data; keep going so problems are visible.
      if (typeof console !== 'undefined') console.warn(`track line ${line}: ${w - lineStart} cells`);
    }
  }
  return names;
}

// The flipped drawing path writes each 128-cell row backwards with X flip
// toggled (SSTrackDrawLineFlipLoop); the alternate H scroll buffer then maps
// line pair N to screen 3-N, which mirrors the picture.
export function flipTrackNames(names) {
  const out = new Uint16Array(names.length);
  out.work = names.work;
  for (let r = 0; r < TRACK_ROWS; r++) {
    const o = r * TRACK_COLS;
    for (let c = 0; c < TRACK_COLS; c++) out[o + TRACK_COLS - 1 - c] = names[o + c] ^ 0x0800;
  }
  return out;
}

// Plane A H scroll for a screen line (ssInitTableBuffers).
export function trackHScroll(y, flipped) {
  const pair = (y & 7) >> 1;
  return -0x100 * (flipped ? 3 - pair : pair);
}
