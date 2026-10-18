// Compare engine vs reference per (segment, anim frame) block: player
// positions/angles and ring count at the end of each block.
import fs from 'node:fs';
import { SSData } from '../src/ss/resources.js';
import { SpecialStageEngine } from '../src/ss/engine.js';

const [romPath, refPath, stage = '0', inputSpec = '', policySpec = ''] = process.argv.slice(2);
const BITS = { L: 4, R: 8, U: 1, D: 2, B: 0x10, A: 0x40, Y: 0x40, C: 0x20, S: 0x80 };
const POLICY = policySpec.split(';').filter(Boolean).map((item) => {
  const [rng, b] = item.split(':');
  const [a, z] = rng.split('-').map((x) => x.split('.').map(Number));
  let v = 0;
  for (const ch of b) v |= BITS[ch] || 0;
  return { a, z, v };
});
const lt = (p, q) => p[0] < q[0] || (p[0] === q[0] && p[1] < q[1]);
const policy = (e) => {
  const k = [e.currentSegment, e.trackAnimFrame];
  for (const p of POLICY) if (!lt(k, p.a) && lt(k, p.z)) return p.v;
  return 0;
};
const rom = new Uint8Array(fs.readFileSync(romPath));
const data = new SSData(rom);
const alone = !!process.env.ALONE;
const eng = new SpecialStageEngine(data.original(+stage, alone), { alone });
const sched = new Map();
for (const item of inputSpec.split(',').filter(Boolean)) {
  const [f, b] = item.split(':');
  let v = 0;
  for (const ch of b) v |= { L: 4, R: 8, U: 1, D: 2, B: 0x10, A: 0x40, C: 0x20, S: 0x80 }[ch] || 0;
  sched.set(+f, v);
}
const ref = fs.readFileSync(refPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.mode === 16);
const refEnd = new Map();
for (const r of ref) refEnd.set(`${r.seg},${r.af}`, r);
const mine = new Map();
eng.onIteration = (e) => {
  if (POLICY.length) e.padHeld = policy(e);
  const s = e.objs[0];
  const t = e.objs[1];
  mine.set(`${e.currentSegment},${e.trackAnimFrame}`, { sx: s?.px ?? 0, sy: s?.py ?? 0, sang: s?.angle ?? 0, tx: t?.px ?? 0, ty: t?.py ?? 0, tang: t?.angle ?? 0, rings: e.ringCount });
};
let pad = 0;
for (let i = 0; i < 8000 && !eng.done; i++) {
  if (sched.has(i)) pad = sched.get(i);
  eng.step(POLICY.length ? eng.padHeld : pad);
}
let n = 0, bad = 0;
for (const [k, m] of mine) {
  const r = refEnd.get(k);
  if (!r || r.sx === 0) continue;
  n++;
  const diffs = ['sx', 'sy', 'sang', 'tx', 'ty', 'tang', 'rings'].filter((f) => (m[f] & 0xffff) !== r[f]);
  if (diffs.length) {
    if (bad < 8) console.log(`stage ${stage} block ${k}:`, diffs.map((f) => `${f} ${m[f]}/${r[f]}`).join(' '));
    bad++;
  }
}
const lastRef = ref.filter((r) => r.sx !== 0).pop();
console.log(`stage ${stage}: ${n} blocks compared, ${bad} differ; result`, JSON.stringify(eng.result), 'ref final rings', lastRef?.rings);
