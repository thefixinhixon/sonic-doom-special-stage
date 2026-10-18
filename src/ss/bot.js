// Simple autopilot for testing: steers the player toward upcoming rings and
// away from bombs, jumping over bombs it can't dodge.
import { BTN_LEFT, BTN_RIGHT, BTN_B, BTN_A } from './engine.js';

const angleDiff = (a, b) => ((((a - b) & 0xff) + 0x80) & 0xff) - 0x80;

export function botInput(engine) {
  const p = engine.objs[0];
  if (!p || p.routine !== 2) return 0;
  let bestScore = 0;
  let target = 0x40;
  const bombs = [];
  for (const o of engine.objs) {
    if (!o || o.routine !== 2) continue;
    const depth = o.depth >> 16;
    if (o.id === 'bomb' && depth > 0 && depth < 14) bombs.push({ a: o.angle, depth });
  }
  // score candidate angles by nearby rings, penalise bombs
  for (let cand = 0; cand < 256; cand += 4) {
    if (cand > 0x88 && cand < 0xf8) continue; // stay on the lower half
    let score = -Math.abs(angleDiff(cand, 0x40)) * 0.02 - Math.abs(angleDiff(cand, p.angle)) * 0.01;
    for (const o of engine.objs) {
      if (!o || o.routine !== 2) continue;
      const depth = o.depth >> 16;
      if (depth <= 2 || depth > 40) continue;
      const d = Math.abs(angleDiff(o.angle, cand));
      if ((o.id === 'ring' || o.id === 'item') && d < 0x0c) score += (o.id === 'item' ? 5 : 3) / (1 + depth * 0.15);
      if (o.id === 'bomb' && d < 0x10) score -= 12 / (1 + depth * 0.2);
    }
    if (score > bestScore || cand === 0) {
      if (score > bestScore) {
        bestScore = score;
        target = cand;
      }
    }
  }
  let pad = 0;
  const diff = angleDiff(target, p.angle);
  if (diff > 3) pad |= BTN_LEFT;
  else if (diff < -3) pad |= BTN_RIGHT;
  // shoot what's ahead (alternating so semi-auto weapons re-trigger)
  if (engine.opts.combat && engine.vintCount & 1) {
    for (const o of engine.objs) {
      if (o && o.id === 'bomb' && o.routine === 2 && o.onScreen && Math.abs(angleDiff(o.angle, p.angle)) < 0x0c && (o.depth >> 16) > 4 && (o.depth >> 16) < 26) pad |= BTN_A;
    }
  }
  // jump over a bomb that is about to hit
  for (const b of bombs) {
    if (b.depth <= 7 && Math.abs(angleDiff(b.a, p.angle)) < 0x0c) pad |= BTN_B;
  }
  return pad;
}
