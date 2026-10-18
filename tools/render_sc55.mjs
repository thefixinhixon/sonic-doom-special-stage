// Pre-render DOOM's music on an emulated Roland SC-55 (Nuked-SC55) into
// seamless loops the game can play: assets/music/<LUMP>.ogg
//
// usage: node tools/render_sc55.mjs <nuked-sc55-render> [lump ...]
//   env SC55_ROMS (default assets/sc55), JOBS (default 4)
// Each track is rendered twice in a row and the second pass is kept, so the
// reverb tail of the end flows into the start when the file loops.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Wad } from '../src/doom/wad.js';
import { mus2mid, musTicks } from './mus2mid.mjs';

const run = promisify(execFile);
const [renderer, ...wanted] = process.argv.slice(2);
if (!renderer) {
  console.error('usage: node tools/render_sc55.mjs <nuked-sc55-render> [lump ...]');
  process.exit(1);
}
const roms = process.env.SC55_ROMS || 'assets/sc55';
const outDir = 'assets/music';
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc55-'));

const wads = ['assets/doom.wad', 'assets/doom2.wad'].filter((f) => fs.existsSync(f)).map((f) => new Wad(new Uint8Array(fs.readFileSync(f)), f));
const lumps = new Map();
for (const w of wads) for (const l of w.lumps) if (l.name.startsWith('D_') && !lumps.has(l.name)) lumps.set(l.name, w.lump(l.name));
const list = wanted.length ? wanted : [...lumps.keys()];

async function renderOne(name) {
  const out = path.join(outDir, `${name}.ogg`);
  if (fs.existsSync(out)) return `${name}: exists`;
  const mus = lumps.get(name);
  if (!mus) return `${name}: not found`;
  const secs = musTicks(mus) / 140;
  const mid = path.join(tmp, `${name}.mid`);
  const wav = path.join(tmp, `${name}.wav`);
  fs.writeFileSync(mid, mus2mid(mus, 2));
  await run(renderer, ['-d', roms, '--romset', 'mk1', '-n', '2', '-r', 'gs', '--quiet', '-o', wav, mid], { maxBuffer: 1 << 26 });
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-ss', String(secs), '-t', String(secs), '-ar', '48000', '-c:a', 'libvorbis', '-q:a', '6', out]);
  fs.rmSync(wav);
  return `${name}: ${secs.toFixed(1)}s`;
}

const jobs = Number(process.env.JOBS) || 4;
let next = 0;
await Promise.all(
  Array.from({ length: jobs }, async () => {
    while (next < list.length) {
      const name = list[next++];
      try {
        console.log(await renderOne(name));
      } catch (e) {
        console.log(`${name}: FAILED ${e.message}`);
      }
    }
  }),
);
fs.rmSync(tmp, { recursive: true, force: true });
