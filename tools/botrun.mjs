// Run stages with the autopilot to check they can be finished.
// usage: node tools/botrun.mjs <rom> [seed] [levels]
import fs from 'node:fs';
import { SSData } from '../src/ss/resources.js';
import { SpecialStageEngine } from '../src/ss/engine.js';
import { generateStage } from '../src/ss/generator.js';
import { botInput } from '../src/ss/bot.js';

const [romPath, seedArg = '1', levelsArg = '2-10'] = process.argv.slice(2);
const ss = new SSData(new Uint8Array(fs.readFileSync(romPath)));
const run = (res, label) => {
  const eng = new SpecialStageEngine(res, { lag: false });
  let frames = 0;
  let checkpoints = [];
  eng.onIteration = (e) => {
    e.padHeld = botInput(e);
  };
  while (!eng.done && frames < 20000) {
    eng.step(eng.padHeld || 0);
    for (const ev of eng.events) if (ev.id === 'checkpoint' || ev.id === 'error') checkpoints.push(ev.id === 'checkpoint' ? `ok@${eng.ringCount + eng.ringCount2P}/${eng.ringRequirement}` : `FAIL@${eng.ringCount + eng.ringCount2P}/${eng.ringRequirement}`);
    eng.events.length = 0;
    frames++;
  }
  const r = eng.result || {};
  console.log(`${label.padEnd(18)} ${r.emerald ? 'EMERALD' : 'failed '} rings ${String((r.rings ?? 0) + (r.rings2 ?? 0)).padStart(3)} perfect=${eng.perfectRingsLeft} req ${res.ringReq.slice(0, 3).join('/')} [${checkpoints.join(' ')}] frames ${frames}`);
  return r.emerald;
};
if (seedArg === 'orig') {
  for (let s = 0; s < 7; s++) run(ss.original(s), `original SS${s + 1}`);
} else {
  const [a, b] = levelsArg.split('-').map(Number);
  let wins = 0;
  for (let lv = a; lv <= b; lv++) {
    const g = generateStage(lv, (Number(seedArg) + lv * 7919) >>> 0);
    const st = (lv - 1) % 7;
    if (run({ ...ss.original(st), layout: g.layout, objects: g.objects, ringReq: g.ringReq, stageIndex: st }, `gen level ${lv}`)) wins++;
  }
  console.log(`bot cleared ${wins}/${b - a + 1}`);
}
