// Sonic 2 special stage x DOOM: boot, game flow, input and main loop.
import { SSData, checkRom } from './ss/resources.js';
import { SpecialStageEngine, BTN_UP, BTN_DOWN, BTN_LEFT, BTN_RIGHT, BTN_A, BTN_B, BTN_C, BTN_START } from './ss/engine.js';
import { generateStage, mulberry32 } from './ss/generator.js';
import { DoomArt } from './render/doomart.js';
import { Renderer } from './render/renderer.js';
import { MONSTERS } from './ss/doomdefs.js';
import { Combat, newArsenal } from './ss/combat.js';
import { placeItems } from './ss/items.js';
import { Audio } from './audio/audio.js';
import { themeForStage, MAIN_LOOP } from './themes.js';
import { botInput } from './ss/bot.js';
import { Gamepads, PAD_MUTE } from './input/gamepad.js';

const canvas = document.getElementById('screen');
const statusEl = document.getElementById('status');
const FRAME_MS = 1000 / 59.922743; // NTSC Mega Drive

const files = { rom: null, doom: null, doom2: null };
let ss = null;
let art = null;
let renderer = null;
const audio = new Audio();

// ---------------------------------------------------------------- loading
function identify(buf) {
  const u8 = new Uint8Array(buf);
  const head = String.fromCharCode(...u8.subarray(0, 4));
  if (head === 'IWAD' || head === 'PWAD') {
    const dv = new DataView(buf);
    const n = dv.getInt32(4, true);
    const dir = dv.getInt32(8, true);
    let hasMap01 = false;
    let hasE1M1 = false;
    for (let i = 0; i < n; i++) {
      const o = dir + i * 16 + 8;
      const nm = String.fromCharCode(...u8.subarray(o, o + 8)).replace(/\0.*$/, '');
      if (nm === 'MAP01') hasMap01 = true;
      if (nm === 'E1M1') hasE1M1 = true;
    }
    if (hasE1M1) return 'doom';
    if (hasMap01) return 'doom2';
    return null;
  }
  if (u8.length >= 0x100000 && String.fromCharCode(...u8.subarray(0x100, 0x104)) === 'SEGA') return 'rom';
  return null;
}

async function tryFetch(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.arrayBuffer();
  } catch {
    return null;
  }
}

async function loadFromServer() {
  const [rom, doom, doom2] = await Promise.all([tryFetch('assets/sonic2.md'), tryFetch('assets/doom.wad'), tryFetch('assets/doom2.wad')]);
  if (rom) files.rom = new Uint8Array(rom);
  if (doom) files.doom = new Uint8Array(doom);
  if (doom2) files.doom2 = new Uint8Array(doom2);
}

function showFilePicker() {
  const box = document.getElementById('files');
  const drop = document.getElementById('drop');
  const pick = document.getElementById('pick');
  const mark = () => {
    document.getElementById('need-rom').className = files.rom ? 'ok' : '';
    document.getElementById('need-doom').className = files.doom ? 'ok' : '';
    document.getElementById('need-doom2').className = files.doom2 ? 'ok' : '';
  };
  mark();
  box.classList.add('show');
  return new Promise((resolve) => {
    const take = async (list) => {
      for (const f of list) {
        const buf = await f.arrayBuffer();
        const kind = identify(buf);
        if (kind) files[kind] = new Uint8Array(buf);
      }
      mark();
      if (files.rom && files.doom) {
        box.classList.remove('show');
        resolve();
      }
    };
    pick.onchange = () => take(pick.files);
    drop.ondragover = (e) => {
      e.preventDefault();
      drop.classList.add('hover');
    };
    drop.ondragleave = () => drop.classList.remove('hover');
    drop.ondrop = (e) => {
      e.preventDefault();
      drop.classList.remove('hover');
      take(e.dataTransfer.files);
    };
    document.body.ondragover = (e) => e.preventDefault();
    document.body.ondrop = (e) => {
      e.preventDefault();
      take(e.dataTransfer.files);
    };
  });
}

// ---------------------------------------------------------------- input
const keys = new Set();
const KEYMAP = {
  ArrowLeft: BTN_LEFT,
  ArrowRight: BTN_RIGHT,
  ArrowUp: BTN_UP,
  ArrowDown: BTN_DOWN,
  KeyA: BTN_LEFT,
  KeyD: BTN_RIGHT,
  KeyW: BTN_UP,
  KeyS: BTN_DOWN,
  KeyZ: BTN_A,
  ControlLeft: BTN_A,
  ControlRight: BTN_A,
  KeyJ: BTN_A,
  KeyX: BTN_B,
  KeyC: BTN_C,
  KeyK: BTN_B,
  KeyL: BTN_C,
  Space: BTN_B,
  KeyQ: BTN_UP,
  KeyE: BTN_DOWN,
  Enter: BTN_START,
};
addEventListener('keydown', (e) => {
  if (KEYMAP[e.code] !== undefined) e.preventDefault();
  keys.add(e.code);
  if (e.code === 'KeyM') audio.setMuted(!audio.muted);
  if (e.code === 'KeyF') canvas.requestFullscreen?.();
  unlockAudio();
});
addEventListener('keyup', (e) => keys.delete(e.code));
canvas.addEventListener('pointerdown', () => unlockAudio());

const gamepads = new Gamepads();

function readPad() {
  let v = 0;
  for (const k of keys) v |= KEYMAP[k] || 0;
  return v | gamepads.poll();
}

// Rumble for the big moments (no-op on pads without vibration)
const RUMBLE = {
  DSSHOTGN: [0.3, 0.5, 90],
  DSDSHTGN: [0.5, 0.7, 120],
  DSRLAUNC: [0.4, 0.4, 110],
  DSBAREXP: [0.6, 0.4, 160],
  DSBFG: [1, 1, 400],
  DSRXPLOD: [1, 0.8, 350],
};

let audioUnlocked = false;
async function unlockAudio() {
  if (!files.rom || !art) return;
  if (audioUnlocked) {
    // the context may have been created by a gamepad press, which browsers
    // don't treat as a gesture; a later key or click can start it
    if (audio.ctx?.state === 'suspended' && !game.paused) audio.ctx.resume();
    return;
  }
  audioUnlocked = true;
  try {
    await audio.start(files.rom, art);
    if (game.mode === 'stage' && game.musicPending) startMusic();
  } catch (e) {
    console.warn('audio failed', e);
  }
}

// ---------------------------------------------------------------- game
const params = new URLSearchParams(location.search);
const game = {
  mode: 'title',
  level: 1,
  souls: 0,
  engine: null,
  theme: null,
  demo: null,
  prevPad: 0,
  results: null,
  timer: 0,
  paused: false,
  face: { name: 'STFST01', until: 0 },
  frame: 0,
  seed: Number(params.get('seed')) || (Date.now() & 0x7fffffff),
  arsenal: newArsenal(),
};

function makeEngine(level, demo = false) {
  const theme = themeForStage(level);
  let res;
  if (level <= MAIN_LOOP) {
    res = ss.original(level - 1, true);
  } else {
    // randomized stages start a little easier than where the main loop ends
    const gen = generateStage(level - 5, (game.seed + level * 7919) >>> 0);
    const st = (level - 1) % 7;
    // the generator's targets assume two collectors; one player gets ~80%
    const ringReq = gen.ringReq.map((r) => Math.max(10, Math.round((r * 0.8) / 5) * 5));
    res = { ...ss.original(st, true), layout: gen.layout, objects: gen.objects, ringReq, stageIndex: st };
  }
  if (!demo) res = { ...res, items: placeItems(res.layout, res.objects, level, (game.seed ^ (level * 0x51ed27)) >>> 0, !!files.doom2) };
  if (theme.kind === 'sonic') res = { ...res, palLine3: ss.palStages[theme.palette] };
  let bombVariant = null;
  if (level > 1) {
    const rnd = mulberry32((game.seed ^ (level * 0x9e3779b1)) >>> 0);
    const d = Math.min(level - 2, 8);
    const pool = ['POSS', 'TROO'];
    if (d >= 1) pool.push('SPOS', 'SARG');
    if (d >= 3) pool.push('HEAD');
    if (d >= 5) pool.push('BOSS');
    const rate = Math.min(0.25 + d * 0.03, 0.5);
    const segVariant = new Map();
    // keep bombs of one pattern consistent: decide per segment
    bombVariant = (k, seg) => {
      if (!segVariant.has(seg)) segVariant.set(seg, rnd() < rate ? pool[Math.floor(rnd() * pool.length)] : 'BAR1');
      return segVariant.get(seg);
    };
  }
  const combat = demo ? null : new Combat(game.arsenal, !!files.doom2);
  // longer post-hit invulnerability than the original's 30 frames, so a row
  // of hazards can't hit Doomguy again right after he recovers
  const engine = new SpecialStageEngine(res, { bombVariant, combat, invulnFrames: 90, alone: true });
  return { engine, theme, combat };
}

function startStage(level) {
  const { engine, theme, combat } = makeEngine(level);
  game.engine = engine;
  game.combat = combat;
  game.theme = theme;
  game.level = level;
  game.mode = 'stage';
  game.paused = false;
  game.musicPending = true;
  renderer.setTheme(theme);
  audio.stopAll();
  audio.preload(theme.track);
  audio.sfx('DSTELEPT', { volume: 0.8 });
}

function startMusic() {
  game.musicPending = false;
  const t = game.theme;
  if (t.kind === 'sonic') audio.sonicMusic(0x92);
  else audio.doomMusic(t.track);
}

function setFace(name, frames) {
  game.face = { name, until: game.frame + frames };
}

function handleEvents(engine) {
  for (const e of engine.events) {
    if (e.type === 'sfx' && e.lump) {
      audio.sfx(e.lump, { volume: e.volume ?? 0.8 });
      if (RUMBLE[e.lump]) gamepads.rumble(...RUMBLE[e.lump]);
      continue;
    }
    if (e.type === 'sfx') {
      switch (e.id) {
        case 'ring':
          audio.sfx('DSITEMUP', { volume: 0.55 });
          break;
        case 'bomb':
          if (e.variant === 'BAR1') audio.sfx('DSBAREXP', { volume: 0.8 });
          else audio.sfx(MONSTERS[e.variant]?.sound ?? 'DSCLAW', { volume: 0.8 });
          break;
        case 'ringspill':
        case 'hurt':
          audio.sfx('DSPLPAIN', { volume: 0.9 });
          setFace('STFOUCH0', 40);
          gamepads.rumble(0.9, 0.6, 300);
          break;
        case 'ringspill2':
        case 'hurt2':
          audio.sfx('DSDMPAIN', { volume: 0.7 });
          break;
        case 'jump':
          audio.sfx('DSPISTOL', { volume: 0.45 });
          break;
        case 'jump2':
          audio.sfx('DSSKLATK', { volume: 0.2, rate: 1.1 });
          break;
        case 'land':
          audio.sfx('DSOOF', { volume: 0.35 });
          break;
        case 'checkpoint':
          audio.sfx('DSGETPOW', { volume: 0.8 });
          setFace('STFEVL0', 120);
          break;
        case 'error':
          audio.sfx('DSNOWAY', { volume: 0.9 });
          setFace('STFKILL0', 120);
          break;
      }
    } else if (e.type === 'music') {
      if (e.id === 'ss') {
        if (audio.ready) startMusic();
        else game.musicPending = true;
      } else if (e.id === 'fadeout') audio.fadeOut();
      else if (e.id === 'emerald') {
        setFace('STFEVL0', 200);
        if (game.theme.kind === 'sonic') audio.sonicMusic(0x9d);
        else {
          audio.stopAll();
          audio.sfx('DSGETPOW', { volume: 1 });
        }
      }
    }
  }
  engine.events.length = 0;
}

function faceName() {
  if (game.frame < game.face.until) return game.face.name;
  const s = game.engine?.objs[0];
  if (s && s.routine2) return 'STFOUCH0';
  // look around like the status bar face
  const t = (game.frame >> 6) % 6;
  return t === 2 ? 'STFST00' : t === 4 ? 'STFST02' : 'STFST01';
}

function update() {
  game.frame++;
  const pad = readPad();
  const press = pad & ~game.prevPad;
  game.prevPad = pad;
  if (press & PAD_MUTE) audio.setMuted(!audio.muted);
  // gamepad presses don't count as a user gesture for audio in browsers,
  // but try anyway in case this one does
  if (press) unlockAudio();
  switch (game.mode) {
    case 'title': {
      if (!game.demo || game.demo.engine.done) {
        game.demo = makeEngine(1, true);
        renderer.setTheme(game.demo.theme);
      }
      game.demo.engine.step(0);
      game.demo.engine.events.length = 0;
      if (press & (BTN_START | BTN_A | BTN_B | BTN_C)) {
        unlockAudio();
        game.souls = 0;
        game.arsenal = newArsenal();
        startStage(Number(params.get('stage')) || 1);
      }
      break;
    }
    case 'stage': {
      if (press & BTN_START) {
        game.paused = !game.paused;
        if (game.paused) audio.ctx?.suspend();
        else audio.ctx?.resume();
      }
      if (game.paused) break;
      game.engine.step(params.has('bot') ? botInput(game.engine) : pad & ~BTN_START);
      handleEvents(game.engine);
      if (game.engine.done) {
        const r = game.engine.result;
        if (r.emerald) game.souls++;
        game.results = { ...r, level: game.level, theme: game.theme, kills: game.combat.kills, items: game.combat.items };
        game.mode = 'results';
        game.timer = 0;
        audio.stopAll();
        // Sonic's act-clear jingle or DOOM's intermission music
        if (game.theme.kind === 'sonic') audio.sonicMusic(0x9a);
        else audio.doomMusic('D_INTER');
        audio.preload(themeForStage(game.level + 1).track);
      }
      break;
    }
    case 'results': {
      game.timer++;
      if (game.timer > 40 && (press & (BTN_START | BTN_A | BTN_B | BTN_C) || (params.has('bot') && game.timer > 240))) startStage(game.level + 1);
      break;
    }
  }
}

function draw() {
  const ctx = renderer.ctx;
  switch (game.mode) {
    case 'title': {
      const view = game.demo.engine.view();
      renderer.render({ ...view, fade: 0 }, null);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const logo = art.pic('M_DOOM');
      if (logo) renderer.blit(logo, 128, 52, 52);
      renderer.drawText('SONIC 2 SPECIAL STAGE', 128, 92, 9, 'center');
      renderer.drawText('PRESS ENTER', 128, 150, 10, 'center');
      renderer.drawText('ARROWS: MOVE   X/C/SPACE: JUMP   Z/CTRL: FIRE   Q/E: WEAPON', 128, 186, 6, 'center');
      renderer.drawText('ENTER: PAUSE   M: MUTE   F: FULLSCREEN', 128, 195, 6, 'center');
      renderer.drawText('PAD: A/B JUMP   X/Y/RT FIRE   LB/RB WEAPON   START   BACK: MUTE', 128, 204, 6, 'center');
      break;
    }
    case 'stage': {
      const view = game.engine.view();
      renderer.render(view, { face: faceName(), combat: game.combat.view(game.engine) });
      if (game.paused) {
        const p = art.pic('M_PAUSE');
        if (p) renderer.blit(p, 128, 100, 20);
      }
      break;
    }
    case 'results':
      drawResults();
      break;
  }
  if (gamepads.notice && performance.now() < gamepads.notice.until) renderer.drawText(gamepads.notice.text, 128, 214, 6, 'center');
  if (gamepads.pads().length && audio.ctx?.state !== 'running' && !audio.muted && (game.frame >> 5) & 1) {
    renderer.drawText('CLICK OR PRESS A KEY TO ENABLE SOUND', 128, 172, 7, 'center');
  }
}

function drawResults() {
  const ctx = renderer.ctx;
  const r = game.results;
  const flat = art.flat(r.theme.kind === 'doom' && r.theme.id === 'hell' ? 'FLOOR6_1' : 'FLOOR7_2');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (flat) {
    if (!game.flatCanvas || game.flatName !== r.theme.id) {
      const c = new OffscreenCanvas(64, 64);
      const fctx = c.getContext('2d');
      const img = fctx.createImageData(64, 64);
      const u = new Uint32Array(img.data.buffer);
      for (let i = 0; i < 4096; i++) u[i] = art.pal[flat.px[i]];
      fctx.putImageData(img, 0, 0);
      game.flatCanvas = c;
      game.flatName = r.theme.id;
    }
    ctx.save();
    ctx.globalAlpha = 0.6;
    const tile = 64 * 4;
    for (let y = 0; y < canvas.height; y += tile) for (let x = 0; x < canvas.width; x += tile) ctx.drawImage(game.flatCanvas, x, y, tile, tile);
    ctx.restore();
  }
  renderer.drawText(r.theme.name || `STAGE ${r.level}`, 128, 30, 12, 'center');
  const fin = art.pic('WIF');
  if (r.emerald && fin) renderer.blit(fin, 128, 56, 14);
  else renderer.drawText(r.emerald ? 'FINISHED' : 'NOT ENOUGH RINGS...', 128, 50, 10, 'center');
  renderer.drawText('RINGS', 40, 106, 9);
  renderer.drawBigNumber(r.rings, 216, 104, 14, 'right');
  renderer.drawText('KILLS', 40, 142, 9);
  renderer.drawBigNumber(r.kills, 216, 140, 14, 'right');
  if (r.emerald) {
    const soul = art.sprite('SOUL', 'ABCD'[(game.frame >> 3) & 3], 0);
    renderer.blit(soul, 128, 172, 20);
  }
  renderer.drawText(`ITEMS ${r.items}   SOULSPHERES ${game.souls}`, 128, 190, 8, 'center');
  if (r.level === MAIN_LOOP) renderer.drawText('THE INFERNO IS BEHIND YOU... FOR NOW', 128, 72, 7, 'center');
  if (game.timer > 40 && (game.frame >> 4) & 1) renderer.drawText('PRESS ENTER', 128, 206, 8, 'center');
}

// ---------------------------------------------------------------- main loop
let last = 0;
let acc = 0;
function loop(t) {
  if (!last) last = t;
  acc += Math.min(250, t - last);
  last = t;
  let steps = 0;
  while (acc >= FRAME_MS && steps < 4) {
    update();
    acc -= FRAME_MS;
    steps++;
  }
  if (steps) draw();
  requestAnimationFrame(loop);
}

async function boot() {
  statusEl.textContent = 'loading...';
  await loadFromServer();
  if (!files.rom || !files.doom) await showFilePicker();
  const err = checkRom(files.rom);
  if (err) {
    statusEl.textContent = err;
    return;
  }
  ss = new SSData(files.rom);
  art = new DoomArt(files.doom2 ? [files.doom, files.doom2] : [files.doom]);
  renderer = new Renderer(canvas, ss, art);
  statusEl.textContent = '';
  window.__game = { game, ss, art, renderer, audio };
  if (params.has('stage')) startStage(Number(params.get('stage')));
  requestAnimationFrame(loop);
}

boot().catch((e) => {
  statusEl.textContent = 'error: ' + e.message;
  console.error(e);
});
