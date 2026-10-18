// Pair per-track-frame work in the engine with the number of real frames the
// original game spent on that track frame (lag), for fitting a cost model.
import fs from 'node:fs';
import { SSData } from '../src/ss/resources.js';
import { SpecialStageEngine } from '../src/ss/engine.js';

const [romPath, refPath, stage = '0', inputSpec = '', outPath] = process.argv.slice(2);
const rom = new Uint8Array(fs.readFileSync(romPath));
const data = new SSData(rom);
const eng = new SpecialStageEngine(data.original(+stage));
const sched = new Map();
for (const item of inputSpec.split(',').filter(Boolean)) {
  const [f, b] = item.split(':');
  let v = 0;
  for (const ch of b) v |= { L: 4, R: 8, U: 1, D: 2, B: 0x10, A: 0x40, C: 0x20, S: 0x80 }[ch] || 0;
  sched.set(+f, v);
}
const ref = fs.readFileSync(refPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.mode === 16);
const refBlocks = new Map();
for (const r of ref) {
  const k = `${r.seg},${r.af}`;
  refBlocks.set(k, (refBlocks.get(k) || 0) + 1);
}
const blocks = new Map();
eng.onIteration = (e) => {
  if (!e.started || !e.pendingFrame) return;
  const k = `${e.currentSegment},${e.trackAnimFrame}`;
  if (!blocks.has(k)) blocks.set(k, []);
  const di = e.drawingIndex;
  let unc = 0, rn = 0, rt = 0;
  if (di < 4) {
    const work = data.trackFrame(e.pendingFrame.frame, e.pendingFrame.flipped).work;
    for (let row = di * 7; row < di * 7 + 7; row++) {
      unc += work.unc[row];
      rn += work.runs[row];
      rt += work.runTiles[row];
    }
  }
  const c = {};
  for (const o of e.objs) if (o) c[o.id] = (c[o.id] || 0) + 1;
  blocks.get(k).push({ di, flipped: e.pendingFrame.flipped ? 1 : 0, unc, rn, rt, rings: c.ring || 0, bombs: c.bomb || 0, msgs: c.message || 0, spill: c.spill || 0, emerald: c.emerald || 0, banner: c.banner || 0, sprites: e.sprites.length, nobj: Object.values(c).reduce((a, b) => a + b, 0) });
};
let pad = 0;
for (let i = 0; i < 6000 && !eng.done; i++) {
  if (sched.has(i)) pad = sched.get(i);
  eng.step(pad);
}
const out = [];
for (const [k, iters] of blocks) {
  if (!refBlocks.has(k) || iters.length !== 5) continue;
  out.push({ k, frames: refBlocks.get(k), iters });
}
fs.writeFileSync(outPath, JSON.stringify(out));
console.log('blocks', out.length);
