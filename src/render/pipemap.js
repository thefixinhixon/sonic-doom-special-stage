// Recovers pipe-surface coordinates (depth along the pipe, angle around it)
// for every screen pixel of a track frame, using the same perspective table
// the game uses to place rings and bombs on the pipe. DOOM themes use this to
// texture-map the halfpipe.

import { SCREEN_W, SCREEN_H } from '../sega/vdp.js';

export function buildPipeMap(persp, frame) {
  const base = (persp[frame * 2] << 8) | persp[frame * 2 + 1];
  const n = (persp[base] << 8) | persp[base + 1];
  const rings = [];
  for (let d = 0; d < n; d++) {
    const e = base + 2 + d * 6;
    let cy = persp[e + 1];
    if (cy >= 0x80) cy = (cy << 24) >> 24;
    rings.push({ cx: persp[e], cy, rx: Math.max(1, persp[e + 2]), ry: Math.max(1, persp[e + 3]) });
  }
  const depth = new Float32Array(SCREEN_W * SCREEN_H);
  const angle = new Uint8Array(SCREEN_W * SCREEN_H);
  const toAngle = (dx, dy) => Math.round((Math.atan2(dy, dx) * 128) / Math.PI) & 0xff;
  for (let y = 0; y < SCREEN_H; y++) {
    for (let x = 0; x < SCREEN_W; x++) {
      const i = y * SCREEN_W + x;
      let prev = -1;
      let found = false;
      for (let d = 0; d < rings.length; d++) {
        const r = rings[d];
        const nx = (x - r.cx) / r.rx;
        const ny = (y - r.cy) / r.ry;
        const rho = Math.sqrt(nx * nx + ny * ny);
        if (rho >= 1) {
          if (d === 0) depth[i] = 1 / rho;
          else {
            const t = (1 - prev) / Math.max(1e-6, rho - prev);
            depth[i] = d + Math.min(1, Math.max(0, t));
          }
          angle[i] = toAngle(nx, ny);
          found = true;
          break;
        }
        prev = rho;
      }
      if (!found) {
        const r = rings[rings.length - 1];
        depth[i] = rings.length + 1;
        angle[i] = r ? toAngle(x - r.cx, y - r.cy) : 0;
      }
    }
  }
  return { depth, angle };
}

// Mirror a map for flipped track frames.
export function mirrorPipeMap(m) {
  const depth = new Float32Array(m.depth.length);
  const angle = new Uint8Array(m.angle.length);
  for (let y = 0; y < SCREEN_H; y++) {
    for (let x = 0; x < SCREEN_W; x++) {
      const s = y * SCREEN_W + (SCREEN_W - 1 - x);
      const d = y * SCREEN_W + x;
      depth[d] = m.depth[s];
      angle[d] = (0x80 - m.angle[s]) & 0xff;
    }
  }
  return { depth, angle };
}
