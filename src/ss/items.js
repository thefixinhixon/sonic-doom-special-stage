// Places DOOM ammo and weapon pickups into a stage, in spots that don't clash
// with the stage's own rings and bombs.
import { TRACK_ANIM_LEN } from './tables.js';
import { mulberry32 } from './generator.js';

// Read the object-location list into per-segment groups ([dist, angle, bomb]).
export function segmentObjects(layout, objects) {
  const segs = [];
  let p = 0;
  for (let seg = 0; seg < layout.length && p < objects.length; seg++) {
    const objs = [];
    let marker = 0xff;
    for (;;) {
      const b = objects[p++];
      if (b === undefined) break;
      if (b & 0x80) {
        marker = b;
        break;
      }
      objs.push([b & 0x3f, objects[p++], (b & 0x40) !== 0]);
    }
    segs.push({ type: layout[seg] & 0x7f, objs, marker });
    if (marker === 0xfd) break;
  }
  return segs;
}

// Weapon handed out in each stage of the main loop
const STAGE_WEAPON = ['SHOT', 'MGUN', 'LAUN', 'PLAS', 'SGN2', 'BFUG', 'CELP'];

function ammoPool(level, hasDoom2) {
  const pool = [['CLIP', 5]];
  if (level >= 2) pool.push(['AMMO', 1]);
  pool.push(['SHEL', 3]);
  if (level >= 3) pool.push(['SBOX', 1], ['ROCK', 2]);
  if (level >= 4) pool.push(['BROK', 1], ['CELL', 2]);
  if (level >= 6) pool.push(['CELP', 1]);
  return pool;
}

export function placeItems(layout, objects, level, seed, hasDoom2) {
  const rnd = mulberry32(seed >>> 0);
  const segs = segmentObjects(layout, objects);
  const items = new Map();
  const pool = ammoPool(level, hasDoom2);
  const total = pool.reduce((a, [, w]) => a + w, 0);
  const pickAmmo = () => {
    let r = rnd() * total;
    for (const [t, w] of pool) if ((r -= w) < 0) return t;
    return pool[0][0];
  };
  let weapon = level <= 7 ? STAGE_WEAPON[level - 1] : rnd() < 0.5 ? ['SHOT', 'MGUN', 'LAUN', 'PLAS', 'BFUG', 'SGN2'][Math.floor(rnd() * 6)] : null;
  if (weapon === 'SGN2' && !hasDoom2) weapon = 'SBOX';
  const weaponSeg = 4 + Math.floor(rnd() * 3);
  const angleDiff = (a, b) => Math.abs(((((a - b) & 0xff) + 0x80) & 0xff) - 0x80);
  segs.forEach((s, seg) => {
    if (seg < 4 || s.marker === 0xfe || s.marker === 0xfd) return;
    const giveWeapon = weapon && seg >= weaponSeg;
    if (!giveWeapon && rnd() > 0.4) return;
    const len = TRACK_ANIM_LEN[s.type] || 16;
    for (let tries = 0; tries < 20; tries++) {
      const dist = Math.floor(rnd() * len);
      // weapons sit near the bottom of the pipe so they're hard to miss
      const spread = giveWeapon ? 0x10 : 0x24;
      const angle = (0x40 + Math.round((rnd() * 2 - 1) * spread)) & 0xff;
      const clash = s.objs.some(([d, a, bomb]) => Math.abs(d - dist) <= (bomb ? 3 : 1) && angleDiff(a, angle) < (bomb ? 0x18 : 0x0c));
      if (clash) continue;
      items.set(seg, [{ dist, angle, type: giveWeapon ? weapon : pickAmmo() }]);
      if (giveWeapon) weapon = null;
      break;
    }
  });
  return items;
}
