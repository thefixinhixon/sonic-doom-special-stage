# Sonic DOOM Special Stage

Sonic the Hedgehog 2's Special Stage (the halfpipe bonus stage), played by
Doomguy and a Lost Soul, using graphics and music from your own copies of
Sonic 2 and DOOM. It runs in the browser.

- **The main loop is the seven original Special Stages**, layouts and all.
  Stage 1 keeps Sonic 2's colours and music; stages 2-4 are the tech base and
  stages 5-7 are hell, with DOOM music. After that, stages are randomly
  generated and the descent repeats (Sonic, tech base, Deimos, hell).
- Rings are Health Bonuses and bombs are explosive barrels, with DOOM monsters
  showing up in place of barrels after stage 1. The Chaos Emerald is a
  Soulsphere.
- Doomguy can shoot: monsters take several hits depending on type, barrels
  blow up (and set off their neighbours). Ammo is limited and carries over
  between stages; clips, shells, rockets, cells and DOOM's weapons (shotgun,
  chaingun, rocket launcher, plasma gun, super shotgun with DOOM II, BFG9000)
  are scattered on the pipe.

## Files you need

This repository contains no game data. Put your own files in `assets/`:

| File | What |
|---|---|
| `assets/sonic2.md` | Sonic the Hedgehog 2 Mega Drive/Genesis ROM, **REV01** ("Rev A", header serial `GM 00001051-01`) |
| `assets/doom.wad` | DOOM.WAD from The Ultimate DOOM / DOOM |
| `assets/doom2.wad` | DOOM2.WAD (optional; adds the super shotgun) |
| `assets/music/*.ogg` | DOOM's music rendered on a Roland SC-55 (see below; optional) |

If the files aren't found, the page asks you to drop them in instead.

## Run

```sh
./start.sh            # or: node serve.mjs, then open http://localhost:8090/
```

On Windows: double-click `start.bat` (or run it in a command prompt, with an
optional port number). It needs Node.js installed, starts the same server in
its own window, and opens the game in your browser. Close the server window
to stop it.

Requires Node.js (any recent version) and a modern browser.

## DOOM music on a Roland SC-55

DOOM's soundtrack is played from recordings of the music running on an
emulated Roland SC-55 (Nuked-SC55, which emulates the real hardware from its
ROMs). Without them the game falls back to an AdLib-style OPL2 synth.

To make them (one time, about 10 minutes):

1. Put the original SC-55 ROMs in `assets/sc55/` (from the MAME `sc55` set:
   `roland_r15199778_6435328a97f.ic30`, `roland_r15209363.ic23`,
   `roland-gss.a/b/c_*.ic2x`).
2. Build the renderer from https://github.com/jcmoyer/Nuked-SC55
   (`cmake -DCMAKE_BUILD_TYPE=Release .. && cmake --build . --target nuked-sc55-render`;
   it needs rtmidi unless you set `USE_RTMIDI` to `FALSE` in CMakeLists.txt).
3. Run `node tools/render_sc55.mjs path/to/nuked-sc55-render` (needs ffmpeg).

Each track is rendered twice in a row and the second pass kept, so it loops
seamlessly with the reverb carried across the loop point.

## Controls

| Action | Keyboard | Gamepad |
|---|---|---|
| Move around the pipe | Left / Right (or A / D) | D-pad / left stick |
| Jump | X, C, Space (or K, L) | A / B |
| Fire | Z, Ctrl (or J) | X / Y / RT |
| Change weapon | Q / E | LB / RB, D-pad up / down |
| Pause / start | Enter | Start |
| Mute | M | Back / Select |
| Fullscreen | F | |

Any browser-recognised pad works (Xbox, PlayStation, Switch Pro and most
generic pads); pads with vibration rumble on hits, explosions and big guns.
Browsers don't let a gamepad press start audio, so click or press a key once
for sound.

Flatpak browsers on Linux (Firefox, Zen, etc.) only see pads plugged in
after the browser started, because the sandbox hides the udev database. To
fix that, give the browser read access to it and restart it, e.g.
`flatpak override --user --filesystem=/run/udev:ro org.mozilla.firefox`.

URL options: `?stage=N` starts at stage N, `?seed=N` fixes the random stages,
`?bot=1` lets an autopilot play.

## How it works

- `src/ss/engine.js` is a port of the Special Stage code from the Sonic 2
  disassembly (s2disasm), with the original's 68000 integer behaviour. Its
  track timing, objects, player physics, Tails AI, checkpoints and emerald
  were checked frame by frame against the real game running in Genesis Plus GX,
  on all seven stages and with player input. The original's
  slowdown is modelled from the same measurements, so it runs at the speed the
  real game does.
- Track frames, perspective tables, layouts, object lists, palettes and art
  are decoded from the ROM at run time (`src/sega/`, `src/ss/resources.js`).
- Sonic 2's music comes from the game's own Z80 sound driver, running on an
  emulated Z80, YM2612 and SN76489 in an AudioWorklet (`src/audio/smps.js`).
- DOOM music is played the way DMX did on DOS: MUS scores through an
  emulated OPL2 with the GENMIDI instrument bank (`src/audio/opl.js`).
- DOOM looks texture the halfpipe using pipe coordinates recovered from the
  game's perspective tables (`src/render/pipemap.js`).

## Developer tools

`tools/` has the scripts used for verification: `find_offsets.mjs` (locate
data in the ROM using s2disasm), `refemu.py` (run the real game in a libretro
core and record traces), `compare_blocks.mjs` (engine vs. real game),
`botrun.mjs` (autopilot over many stages), `render_music.mjs` /
`render_mus.mjs` (offline audio renders) and `cdp.mjs` (headless browser
screenshots).
