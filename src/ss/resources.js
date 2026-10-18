// Pulls everything the special stage needs out of the Sonic 2 ROM.
import { kosinski, nemesis, enigma } from '../sega/compress.js';
import { ROM, ROM_SERIAL, TRACK_FRAMES } from '../sega/romdata.js';
import { decodeTrackFrame, flipTrackNames } from './track.js';
import { RING_REQ_TEAM, RING_REQ_ALONE } from './tables.js';

const rd16 = (b, o) => (b[o] << 8) | b[o + 1];

export function checkRom(rom) {
  if (rom.length < 0x100000) return 'ROM is too small';
  let serial = '';
  for (let i = 0x180; i < 0x18e; i++) serial += String.fromCharCode(rom[i]);
  if (serial !== ROM_SERIAL) return `unexpected ROM serial "${serial}" (need Sonic 2 REV01, ${ROM_SERIAL})`;
  return null;
}

function words(rom, off, count) {
  const out = new Uint16Array(count);
  for (let i = 0; i < count; i++) out[i] = rd16(rom, off + i * 2);
  return out;
}

// Parse a Sonic 2 sprite mapping table at a ROM address.
export function parseMappings(rom, off, frames) {
  const out = [];
  for (let f = 0; f < frames; f++) {
    const fo = off + rd16(rom, off + f * 2);
    const n = rd16(rom, fo);
    const pieces = [];
    for (let i = 0; i < n; i++) {
      const p = fo + 2 + i * 8;
      const y = (rom[p] << 24) >> 24;
      const size = rom[p + 1];
      const tile = rd16(rom, p + 2);
      const x = (rd16(rom, p + 6) << 16) >> 16;
      pieces.push({
        x,
        y,
        w: ((size >> 2) & 3) + 1,
        h: (size & 3) + 1,
        tile: tile & 0x7ff,
        flipX: (tile & 0x800) !== 0,
        flipY: (tile & 0x1000) !== 0,
        pal: (tile >> 13) & 3,
        pri: tile >> 15,
      });
    }
    out.push(pieces);
  }
  return out;
}

// Mapping tables in REV01 (addresses from the s2disasm label names).
export const MAPPINGS = {
  rings: { off: 0x3632a, frames: 33 },
  bomb: { off: 0x36508, frames: 13 },
  emerald: { off: 0x3625a, frames: 10 },
  shadow: { off: 0x34492, frames: 30 },
};
export const ART_TILES = {
  rings: 0x322,
  bomb: 0x38a,
  explosion: 0x2b5,
  emerald: 0x174,
  flatShadow: 0x23c,
  diagShadow: 0x262,
  sideShadow: 0x29c,
  stars: 0x77f,
  back: 0x700,
};

export class SSData {
  constructor(rom) {
    this.rom = rom;
    this.sine = new Int16Array(320);
    for (let i = 0; i < 320; i++) this.sine[i] = (rd16(rom, ROM.sine.off + i * 2) << 16) >> 16;
    this.perspective = kosinski(rom, ROM.perspective.off);
    this.layouts = nemesis(rom, ROM.layouts.off);
    this.objectLocs = kosinski(rom, ROM.objectLocations.off);
    this.palMain = words(rom, ROM.palSSMain.off, 48);
    this.palStages = [];
    for (let i = 1; i <= 7; i++) this.palStages.push(words(rom, ROM['palSS' + i].off, 16));
    this.emeraldPal = words(rom, ROM.palEmerald.off, 21);
    this.pnt = { unc: ROM.pntUnc.off, uncPart2: ROM.pntUnc.part2, rle: ROM.pntRLE.off, rlePart2: ROM.pntRLE.part2 };
    this.frameCache = new Map();
    this.mappings = {};
    for (const [k, v] of Object.entries(MAPPINGS)) this.mappings[k] = parseMappings(rom, v.off, v.frames);
  }

  // Decoded 28x128 name table for a track frame (optionally mirrored).
  trackFrame(frame, flipped) {
    const key = frame * 2 + (flipped ? 1 : 0);
    let t = this.frameCache.get(key);
    if (!t) {
      t = decodeTrackFrame(this.rom, TRACK_FRAMES[frame], this.pnt);
      if (flipped) t = flipTrackNames(t);
      this.frameCache.set(key, t);
    }
    return t;
  }

  // Tile art for the VDP: track, background and the object art used for
  // shadows (and for the original-art debug view).
  loadArt(vdp) {
    const rom = this.rom;
    const art = kosinski(rom, ROM.artTrack.off);
    vdp.loadRowTiles(art, 0, 2, rd16(art, 0));
    vdp.loadTiles(nemesis(rom, ROM.artBack.off), ART_TILES.back);
    vdp.loadTiles(nemesis(rom, ROM.artStars.off), ART_TILES.stars);
    vdp.loadTiles(nemesis(rom, ROM.artRings.off), ART_TILES.rings);
    vdp.loadTiles(nemesis(rom, ROM.artFlatShadow.off), ART_TILES.flatShadow);
    vdp.loadTiles(nemesis(rom, ROM.artDiagShadow.off), ART_TILES.diagShadow);
    vdp.loadTiles(nemesis(rom, ROM.artSideShadow.off), ART_TILES.sideShadow);
    vdp.loadTiles(nemesis(rom, ROM.artExplosion.off), ART_TILES.explosion);
    vdp.loadTiles(nemesis(rom, ROM.artBomb.off), ART_TILES.bomb);
    vdp.loadTiles(nemesis(rom, ROM.artEmerald.off), ART_TILES.emerald);
  }

  // Plane B: SSPlaneB_Background (32x32 block repeated across 128 columns)
  backgroundPlane() {
    const rom = this.rom;
    const chunk = new Uint16Array(32 * 32);
    chunk.set(enigma(rom, ROM.mapBackBottom.off, ART_TILES.back).subarray(0, 32 * 16), 0);
    chunk.set(enigma(rom, ROM.mapBack.off, ART_TILES.back).subarray(0, 32 * 16), 32 * 16);
    const plane = new Uint16Array(128 * 32);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 32; r++) for (let x = 0; x < 32; x++) plane[r * 128 + c * 32 + x] = chunk[r * 32 + x];
    return plane;
  }

  stageLayout(stage) {
    const o = rd16(this.layouts, stage * 2);
    return this.layouts.subarray(o);
  }
  stageObjects(stage) {
    const o = rd16(this.objectLocs, stage * 2);
    return this.objectLocs.subarray(o);
  }

  // Engine resources for one of the seven original stages. `alone` uses the
  // Sonic-alone ring requirements (no Tails).
  original(stage, alone = false) {
    return {
      sine: this.sine,
      perspective: this.perspective,
      layout: this.stageLayout(stage),
      objects: this.stageObjects(stage),
      ringReq: (alone ? RING_REQ_ALONE : RING_REQ_TEAM)[stage].slice(),
      stageIndex: stage,
      palMain: this.palMain,
      palLine3: this.palStages[stage],
      emeraldPal: this.emeraldPal,
      trackFrame: (f, flip) => this.trackFrame(f, flip),
    };
  }
}
