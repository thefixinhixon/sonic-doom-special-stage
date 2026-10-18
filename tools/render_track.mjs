// Headless check: decode and render a few halfpipe frames with the SS1 palette.
import fs from 'node:fs';
import { writePNG } from './png.mjs';
import { kosinski, nemesis, enigma } from '../src/sega/compress.js';
import { VDP, SCREEN_W, SCREEN_H } from '../src/sega/vdp.js';
import { ROM, TRACK_FRAMES } from '../src/sega/romdata.js';
import { decodeTrackFrame, flipTrackNames, trackHScroll } from '../src/ss/track.js';

const rom = new Uint8Array(fs.readFileSync(process.argv[2]));
const outDir = process.argv[3];
const frames = (process.argv[4] || '0,17,21,38,44,49').split(',').map(Number);
const vdp = new VDP();
const art = kosinski(rom, ROM.artTrack.off);
const ntiles = (art[0] << 8) | art[1];
console.log('track art tiles', ntiles, 'bytes', art.length);
vdp.loadRowTiles(art, 0, 2, ntiles);
const back = nemesis(rom, ROM.artBack.off);
console.log('back tiles', back.length / 32);
vdp.loadTiles(back, 0x700);
vdp.loadPalette(rom, ROM.palSSMain.off, 0, 48);
vdp.loadPalette(rom, ROM.palSS1.off, 3, 16);
vdp.updateLUT();
// plane B background (SSPlaneB_Background)
const chunk = new Uint16Array(32 * 32);
const bottom = enigma(rom, ROM.mapBackBottom.off, 0x700);
const main = enigma(rom, ROM.mapBack.off, 0x700);
console.log('bg maps', bottom.length, main.length);
chunk.set(bottom.subarray(0, Math.min(bottom.length, 32 * 32)), 0);
chunk.set(main.subarray(0, Math.min(main.length, 32 * 16)), 32 * 16);
for (let c = 0; c < 4; c++) for (let r = 0; r < 32; r++) for (let x = 0; x < 32; x++) vdp.planeB[r * 128 + c * 32 + x] = chunk[r * 32 + x];
const pnt = { unc: ROM.pntUnc.off, uncPart2: ROM.pntUnc.part2, rle: ROM.pntRLE.off, rlePart2: ROM.pntRLE.part2 };
const buf = new Uint32Array(SCREEN_W * SCREEN_H);
for (const f of frames) {
  for (const flipped of [false, true]) {
    let names = decodeTrackFrame(rom, TRACK_FRAMES[f], pnt);
    if (flipped) names = flipTrackNames(names);
    vdp.planeA.fill(0);
    vdp.planeA.set(names);
    for (let y = 0; y < SCREEN_H; y++) {
      vdp.hscrollA[y] = trackHScroll(y, flipped);
      vdp.hscrollB[y] = 0;
    }
    vdp.renderPlanes(buf);
    writePNG(`${outDir}/frame${f}${flipped ? 'f' : ''}.png`, SCREEN_W, SCREEN_H, new Uint8Array(buf.buffer), 2);
  }
}
