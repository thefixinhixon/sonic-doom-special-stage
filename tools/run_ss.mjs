// Headless run of the special stage engine; writes a per-frame trace in the
// same shape as tools/refemu.py --trace and compares when a reference is given.
import fs from 'node:fs';
import { SSData } from '../src/ss/resources.js';
import { SpecialStageEngine } from '../src/ss/engine.js';

const [romPath, frames = '3000', refPath, inputSpec = ''] = process.argv.slice(2);
const rom = new Uint8Array(fs.readFileSync(romPath));
const data = new SSData(rom);
const eng = new SpecialStageEngine(data.original(0));
const sched = new Map();
for (const item of inputSpec.split(',').filter(Boolean)) {
  const [f, b] = item.split(':');
  let v = 0;
  for (const ch of b) v |= { L: 4, R: 8, U: 1, D: 2, B: 0x10, A: 0x40, C: 0x20, S: 0x80 }[ch] || 0;
  sched.set(+f, v);
}
const trace = [];
let pad = 0;
for (let i = 0; i < +frames && !eng.done; i++) {
  if (sched.has(i)) pad = sched.get(i);
  eng.step(pad);
  const s = eng.objs[0];
  const t = eng.objs[1];
  trace.push({
    f: i, seg: eng.currentSegment ?? 0, af: eng.trackAnimFrame ?? 0, di: eng.drawingIndex ?? 0, mf: eng.mappingFrame ?? 0,
    sx: s ? s.px : 0, sy: s ? s.py : 0, sang: s ? s.angle : 0, tx: t ? t.px : 0, ty: t ? t.py : 0, tang: t ? t.angle : 0,
    rings: eng.ringCount,
  });
}
console.log('frames run', trace.length, 'result', JSON.stringify(eng.result));
if (refPath) {
  const ref = fs.readFileSync(refPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  // align on the first frame where segment 1 starts
  const key = (r) => `${r.seg},${r.af},${r.di}`;
  const firstMine = trace.findIndex((r) => r.seg === 1);
  const firstRef = ref.findIndex((r) => r.seg === 1);
  const off = firstRef - firstMine;
  console.log('alignment offset (ref - mine):', off);
  let mism = 0;
  const fields = ['seg', 'af', 'di', 'mf', 'sx', 'sy', 'sang', 'tx', 'ty', 'tang', 'rings'];
  for (const r of trace) {
    const q = ref[r.f + off];
    if (!q || q.mode !== 16) continue;
    const bad = fields.filter((k) => r[k] !== q[k]);
    if (bad.length) {
      if (mism < 25) console.log('frame', r.f, 'ref', r.f + off, bad.map((k) => `${k}: mine ${r[k]} ref ${q[k]}`).join('; '));
      mism++;
    }
  }
  console.log('mismatching frames:', mism, 'of', trace.length);
}
