// Visual/music themes. Sonic themes keep the original CRAM colours; DOOM
// themes recolour the halfpipe (palette line 3, colours 1-7) and replace the
// starfield with a DOOM sky.
//
// Track colour roles: 1/3/6 pipe body light/mid/dark, 2/4/5 rim light/mid/dark, 7 stripe.

export const DOOM_THEMES = [
  {
    id: 'tech',
    name: 'TECH BASE',
    kind: 'doom',
    sky: 'SKY1',
    skyBottom: 0x3b2b1f,
    line3: { 1: 0x8f8f8f, 3: 0x6b6b6b, 6: 0x474747, 2: 0xbf9b6b, 4: 0x8f6f4b, 5: 0x5f4b33, 7: 0x47ff47 },
    textures: { body: ['FLOOR4_8'], rim: ['CEIL3_5'], stripe: ['NUKAGE1', 'NUKAGE2', 'NUKAGE3'], floor: ['NUKAGE1', 'NUKAGE2', 'NUKAGE3'] },
    music: ['D_E1M1', 'D_E1M2', 'D_E1M3', 'D_E1M5', 'D_E1M6', 'D_E1M7'],
  },
  {
    id: 'hell',
    name: 'INFERNO',
    kind: 'doom',
    sky: 'SKY3',
    skyBottom: 0x2b0000,
    line3: { 1: 0x9b2b1b, 3: 0x731b0f, 6: 0x4b0b07, 2: 0xff9f2f, 4: 0xd76b17, 5: 0x9b3b0b, 7: 0xffff73 },
    textures: { body: ['FLOOR6_1'], rim: ['FLAT5_7'], stripe: ['LAVA1', 'LAVA2', 'LAVA3', 'LAVA4'], floor: ['LAVA1', 'LAVA2', 'LAVA3', 'LAVA4'] },
    music: ['D_E3M1', 'D_E3M2', 'D_E3M3', 'D_E3M5', 'D_E2M2', 'D_E3M8'],
  },
  {
    id: 'deimos',
    name: 'DEIMOS',
    kind: 'doom',
    sky: 'SKY2',
    skyBottom: 0x1f1f1f,
    line3: { 1: 0x7b8f73, 3: 0x5b6b53, 6: 0x37432f, 2: 0xb7b7b7, 4: 0x8b8b8b, 5: 0x5f5f5f, 7: 0xff3f3f },
    textures: { body: ['FLOOR7_2'], rim: ['FLOOR5_2'], stripe: ['BLOOD1', 'BLOOD2', 'BLOOD3'], floor: ['BLOOD1', 'BLOOD2', 'BLOOD3'] },
    music: ['D_E2M1', 'D_E2M3', 'D_E2M4', 'D_E2M5', 'D_E2M6', 'D_E2M7'],
  },
];

// The main loop is the seven original stages: Sonic 2 first, then down
// through the tech base into hell. After that, stages are randomized and the
// descent repeats (Sonic, tech base, Deimos, hell).
export const MAIN_LOOP = 7;

export function themeForStage(level) {
  const doom = (id, index) => {
    const t = DOOM_THEMES.find((x) => x.id === id);
    return { ...t, track: t.music[index % t.music.length] };
  };
  if (level <= MAIN_LOOP) {
    if (level === 1) return { kind: 'sonic', palette: 0, name: 'SPECIAL STAGE 1' };
    if (level <= 4) return doom('tech', level - 2);
    return doom('hell', level - 5);
  }
  const k = level - MAIN_LOOP - 1;
  const lap = Math.floor(k / 4);
  switch (k % 4) {
    case 0:
      return { kind: 'sonic', palette: (lap + 1) % 7, name: `SPECIAL STAGE ${level}` };
    case 1:
      return doom('tech', lap + 3);
    case 2:
      return doom('deimos', lap);
    default:
      return doom('hell', lap + 3);
  }
}
