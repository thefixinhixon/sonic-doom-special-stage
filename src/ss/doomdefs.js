// DOOM things used by the special stage: monsters standing in for bombs,
// weapons, and pickups.

// hp is in pistol-shot units
export const MONSTERS = {
  POSS: { walk: 'ABCD', attack: 'EF', pain: 'G', death: 'HIJKL', sound: 'DSPISTOL', deathSound: 'DSPODTH1', painSound: 'DSPOPAIN', height: 1.15, hp: 2 },
  SPOS: { walk: 'ABCD', attack: 'EF', pain: 'G', death: 'HIJKL', sound: 'DSSHOTGN', deathSound: 'DSPODTH2', painSound: 'DSPOPAIN', height: 1.15, hp: 3 },
  TROO: { walk: 'ABCD', attack: 'EFG', pain: 'H', death: 'IJKLM', sound: 'DSCLAW', deathSound: 'DSBGDTH1', painSound: 'DSPOPAIN', height: 1.15, hp: 4 },
  SARG: { walk: 'ABCD', attack: 'EFG', pain: 'H', death: 'IJKLMN', sound: 'DSSGTATK', deathSound: 'DSSGTDTH', painSound: 'DSDMPAIN', height: 1.1, hp: 8 },
  HEAD: { walk: 'A', attack: 'BCD', pain: 'E', death: 'GHIJKL', sound: 'DSFIRSHT', deathSound: 'DSCACDTH', painSound: 'DSDMPAIN', height: 1.05, hp: 12 },
  BOSS: { walk: 'ABCD', attack: 'EFG', pain: 'H', death: 'IJKLMNO', sound: 'DSCLAW', deathSound: 'DSBRSDTH', painSound: 'DSDMPAIN', height: 1.3, hp: 30 },
};

export const AMMO = {
  bullets: { max: 200, icon: 'CLIP' },
  shells: { max: 50, icon: 'SHEL' },
  rockets: { max: 50, icon: 'ROCK' },
  cells: { max: 300, icon: 'CELL' },
};

// cooldown in game frames; window = angle half-width that a shot covers
export const WEAPONS = [
  { id: 'pistol', name: 'PISTOL', ammo: 'bullets', cost: 1, damage: 1, cooldown: 16, window: 0x0c, sound: 'DSPISTOL', pickup: null },
  { id: 'shotgun', name: 'SHOTGUN', ammo: 'shells', cost: 1, damage: 4, cooldown: 34, window: 0x18, sound: 'DSSHOTGN', pickup: 'SHOT' },
  { id: 'ssg', name: 'SUPER SHOTGUN', ammo: 'shells', cost: 2, damage: 9, cooldown: 50, window: 0x24, sound: 'DSDSHTGN', pickup: 'SGN2', doom2: true },
  { id: 'chaingun', name: 'CHAINGUN', ammo: 'bullets', cost: 1, damage: 1, cooldown: 5, window: 0x0c, sound: 'DSPISTOL', pickup: 'MGUN', auto: true },
  { id: 'rocket', name: 'ROCKET LAUNCHER', ammo: 'rockets', cost: 1, damage: 10, cooldown: 22, window: 0x0c, sound: 'DSRLAUNC', pickup: 'LAUN', projectile: 'MISL', speed: 1.6, splash: 6 },
  { id: 'plasma', name: 'PLASMA GUN', ammo: 'cells', cost: 1, damage: 2, cooldown: 4, window: 0x0c, sound: 'DSPLASMA', pickup: 'PLAS', projectile: 'PLSS', speed: 2.4, auto: true },
  { id: 'bfg', name: 'BFG9000', ammo: 'cells', cost: 40, damage: 40, cooldown: 60, window: 0x18, sound: 'DSBFG', pickup: 'BFUG', projectile: 'BFS1', speed: 1.2, bfg: true },
];

// pickups: sprite, what they give, message
export const ITEMS = {
  CLIP: { ammo: 'bullets', amount: 10, msg: 'PICKED UP A CLIP.' },
  AMMO: { ammo: 'bullets', amount: 50, msg: 'PICKED UP A BOX OF BULLETS.' },
  SHEL: { ammo: 'shells', amount: 4, msg: 'PICKED UP 4 SHOTGUN SHELLS.' },
  SBOX: { ammo: 'shells', amount: 20, msg: 'PICKED UP A BOX OF SHOTGUN SHELLS.' },
  ROCK: { ammo: 'rockets', amount: 1, msg: 'PICKED UP A ROCKET.' },
  BROK: { ammo: 'rockets', amount: 5, msg: 'PICKED UP A BOX OF ROCKETS.' },
  CELL: { ammo: 'cells', amount: 20, msg: 'PICKED UP AN ENERGY CELL.' },
  CELP: { ammo: 'cells', amount: 100, msg: 'PICKED UP AN ENERGY CELL PACK.' },
  SHOT: { weapon: 'shotgun', ammo: 'shells', amount: 8, msg: 'YOU GOT THE SHOTGUN!' },
  SGN2: { weapon: 'ssg', ammo: 'shells', amount: 8, msg: 'YOU GOT THE SUPER SHOTGUN!' },
  MGUN: { weapon: 'chaingun', ammo: 'bullets', amount: 20, msg: 'YOU GOT THE CHAINGUN!' },
  LAUN: { weapon: 'rocket', ammo: 'rockets', amount: 2, msg: 'YOU GOT THE ROCKET LAUNCHER!' },
  PLAS: { weapon: 'plasma', ammo: 'cells', amount: 40, msg: 'YOU GOT THE PLASMA GUN!' },
  BFUG: { weapon: 'bfg', ammo: 'cells', amount: 40, msg: 'OH, YES. YOU GOT THE BFG9000!' },
};
