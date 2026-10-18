// Random special stage generator. Produces layout and object-location data
// in the same byte format as the ROM, so the engine runs it unchanged.
//
// Structure follows the original stages: three empty straights to start,
// three acts ending in a checkpoint (the last ends with the emerald), a
// "rings to go" marker a few segments before each checkpoint, and segment
// types chained with the same grammar the ROM layouts use.

import { TRACK_ANIM_LEN } from './tables.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ST_RISE = 0;
const ST_DROP = 1;
const ST_TURN_EXIT = 2;
const ST_STRAIGHT = 3;
const ST_ENTER_TURN = 4;

const MARK_END = 0xff;
const MARK_CHECKPOINT = 0xfe;
const MARK_EMERALD = 0xfd;
const MARK_TOGO = 0xfc;

const MAX_OBJECTS_PER_SEGMENT = 18;

export function generateStage(level, seed) {
  const rnd = mulberry32(seed);
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const chance = (p) => rnd() < p;
  // difficulty from 0 (stage 2) upwards
  const d = Math.max(0, level - 2);
  const bombRate = Math.min(0.2 + d * 0.05, 0.6);
  const ratio = Math.min(0.5 + d * 0.025, 0.72);
  const spread = Math.min(0x18 + d * 4, 0x38); // how far from the bottom objects wander

  const segments = []; // { type, flip, objs: [[dist, angle, bomb]], marker }
  let prev = ST_STRAIGHT;
  let flip = false;
  const nextType = (mustStraight) => {
    if (prev === ST_ENTER_TURN) {
      const r = rnd();
      return r < 0.3 ? ST_RISE : r < 0.6 ? ST_DROP : ST_TURN_EXIT;
    }
    if (mustStraight) return ST_STRAIGHT;
    return chance(prev === ST_STRAIGHT ? 0.45 : 0.4) ? ST_ENTER_TURN : ST_STRAIGHT;
  };
  const addSegment = (type, objs = [], marker = MARK_END) => {
    if (type === ST_ENTER_TURN) flip = chance(0.5);
    segments.push({ type, flip, objs, marker });
    prev = type;
  };

  // ---------------------------------------------------------------- patterns
  const center = () => 0x40 + ri(-spread, spread);
  const clampA = (a) => a & 0xff;
  const patterns = {
    ringLine(len) {
      const a = center();
      const n = ri(4, 8);
      const step = pick([1, 1, 2]);
      const d0 = ri(0, Math.max(0, len - n * step));
      return Array.from({ length: n }, (_, i) => [d0 + i * step, a, false]);
    },
    ringZigzag(len) {
      const a = center();
      const amp = pick([8, 0x10]);
      const n = ri(6, 8);
      const d0 = ri(0, Math.max(0, len - n));
      return Array.from({ length: n }, (_, i) => [d0 + i, clampA(a + (i & 1 ? amp : -amp) / 2), false]);
    },
    ringDiamond(len) {
      const a = center();
      const d0 = ri(0, Math.max(0, len - 5));
      return [
        [d0, a, false], [d0 + 1, a + 8, false], [d0 + 2, a + 8, false], [d0 + 3, a + 8, false],
        [d0 + 4, a, false], [d0 + 1, a - 8, false], [d0 + 2, a - 8, false], [d0 + 3, a - 8, false],
      ].map(([x, y, b]) => [x, clampA(y), b]);
    },
    ringTriangle(len) {
      const a = center();
      const d0 = ri(0, Math.max(0, len - 3));
      return [
        [d0, a + 0x10, false], [d0, a, false], [d0, a - 0x10, false],
        [d0 + 1, a + 8, false], [d0 + 1, a - 8, false], [d0 + 2, a, false],
      ].map(([x, y, b]) => [x, clampA(y), b]);
    },
    ringSweep(len) {
      // rings curving across the pipe: run with them
      const dir = chance(0.5) ? 1 : -1;
      const n = ri(6, 9);
      const a0 = 0x40 - dir * ri(0x10, spread);
      const d0 = ri(0, Math.max(0, len - n));
      return Array.from({ length: n }, (_, i) => [d0 + i, clampA(a0 + dir * i * 6), false]);
    },
    bombCluster(len) {
      const a = center();
      const d0 = ri(0, Math.max(0, len - 3));
      return [
        [d0, a, true], [d0 + 1, a - 8, true], [d0 + 1, a + 8, true], [d0 + 2, a, true],
      ].map(([x, y, b]) => [x, clampA(y), b]);
    },
    bombLine(len) {
      const a = center();
      const n = ri(2, 4);
      const d0 = ri(0, Math.max(0, len - n * 4));
      return Array.from({ length: n }, (_, i) => [d0 + i * 4, a, true]);
    },
    bombWall(len) {
      // ring of bombs with a gap that holds a few rings
      const gap = center();
      const gapW = Math.max(0x18, 0x30 - d * 2);
      const d0 = ri(2, Math.max(2, len - 2));
      const out = [];
      for (let a = 0; a < 0x100; a += 0x10) {
        const diff = ((a - gap + 0x180) & 0xff) - 0x80;
        if (Math.abs(diff) <= gapW / 2) continue;
        if (a > 0x90 && a < 0xf0 && chance(0.5)) continue; // keep the very top sparse
        out.push([d0, a, true]);
      }
      out.push([d0, gap, false], [d0 - 1, gap, false], [d0 - 2, gap, false]);
      return out;
    },
    guardedLine(len) {
      // ring line with bombs on both sides
      const a = center();
      const n = ri(4, 6);
      const d0 = ri(0, Math.max(0, len - n));
      const out = Array.from({ length: n }, (_, i) => [d0 + i, a, false]);
      out.push([d0 + 1, clampA(a - 0x18), true], [d0 + n - 2, clampA(a + 0x18), true]);
      return out;
    },
  };
  const ringPatterns = ['ringLine', 'ringZigzag', 'ringDiamond', 'ringTriangle', 'ringSweep'];
  const bombPatterns = d < 2 ? ['bombCluster', 'bombLine', 'guardedLine'] : ['bombCluster', 'bombLine', 'bombWall', 'guardedLine'];

  const fillSegment = (type) => {
    const len = TRACK_ANIM_LEN[type];
    const objs = [];
    const count = type === ST_TURN_EXIT || type === ST_ENTER_TURN ? ri(0, 1) : ri(1, 2);
    for (let i = 0; i < count; i++) objs.push(...patterns[pick(ringPatterns)](len));
    if (chance(bombRate)) objs.push(...patterns[pick(bombPatterns)](len));
    return sanitize(objs);
  };

  // remove overlaps and rings that sit on top of bombs; respect slot limits
  const sanitize = (objs) => {
    const bombs = objs.filter((o) => o[2]);
    const seen = new Set();
    const out = [];
    for (const o of objs) {
      const [dist, a, bomb] = o;
      if (dist < 0 || dist > 0x3f) continue;
      const key = `${dist},${a}`;
      if (seen.has(key)) continue;
      if (!bomb && bombs.some((b) => Math.abs(b[0] - dist) <= 1 && Math.abs((((b[1] - a + 0x180) & 0xff) - 0x80)) < 0x0c)) continue;
      seen.add(key);
      out.push(o);
    }
    // rings first, then bombs, like the original lists
    out.sort((p, q) => (p[2] - q[2]) || (p[0] - q[0]));
    return out.slice(0, MAX_OBJECTS_PER_SEGMENT);
  };

  // ---------------------------------------------------------------- stage
  for (let i = 0; i < 3; i++) addSegment(ST_STRAIGHT);
  const actRings = [];
  let total = 0;
  for (let act = 0; act < 3; act++) {
    if (act > 0) for (let i = ri(1, 2); i > 0; i--) addSegment(ST_STRAIGHT);
    const len = ri(11, 15) + Math.min(4, d);
    for (let i = 0; i < len; i++) {
      const last = i === len - 1;
      let t = nextType(last);
      if (last && t !== ST_STRAIGHT) {
        // finish the turn first, then close the act on a straight
        addSegment(t, fillSegment(t));
        t = ST_STRAIGHT;
      }
      const objs = last ? [] : fillSegment(t);
      let marker = MARK_END;
      if (i === len - 4) marker = MARK_TOGO;
      if (last) marker = act === 2 ? MARK_EMERALD : MARK_CHECKPOINT;
      addSegment(t, objs, marker);
      total += objs.filter((o) => !o[2]).length;
    }
    actRings.push(total);
  }
  for (let i = 0; i < 4; i++) addSegment(ST_STRAIGHT);

  // ---------------------------------------------------------------- encode
  const layout = new Uint8Array(segments.length + 8).fill(ST_STRAIGHT);
  const bytes = [];
  segments.forEach((s, i) => {
    layout[i] = s.type | (s.flip && s.type !== ST_STRAIGHT ? 0x80 : 0) | (s.flip && s.type === ST_STRAIGHT ? 0x80 : 0);
    for (const [dist, a, bomb] of s.objs) bytes.push(bomb ? 0x40 | dist : dist, a & 0xff);
    bytes.push(s.marker);
  });
  for (let i = 0; i < 8; i++) bytes.push(MARK_END);
  const ringReq = actRings.map((r) => Math.max(10, Math.round((r * ratio) / 5) * 5));
  return { layout, objects: Uint8Array.from(bytes), ringReq: [...ringReq, ringReq[2]], totals: actRings };
}
