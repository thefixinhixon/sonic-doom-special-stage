// Port of the Sonic 2 special stage (s2.asm: SpecialStage and objects
// 09, 10, 5A, 5B, 5E, 5F, 59, 60, 61, 63, 87). The main routine is a
// generator; every `yield` is one WaitForVint, i.e. one 60 Hz frame.
//
// Integer behaviour (byte/word wraparound, arithmetic shifts) follows the
// 68000 code so that the stage plays like the original.

import {
  TRACK_ANIMS, TRACK_ANIM_LEN, FRAME_STRAIGHT2, FRAME_STRAIGHT4, FRAME_RISE14, FRAME_DROP6,
  ANIM_BASE_DURATION, CURVE_OFFSETS, BG_SCROLL_STEPS, VSCROLL_RISE, VSCROLL_DROP, VSCROLL_STRAIGHT,
  DEPTH_SCALE, OCTANT_ANIM, HURT_FRAMES, PLAYER_ANIMS, AIR_SHADOW_ANGLE, PLAYER_SHADOW,
  SPILL_ANGLES_EVEN, SPILL_ANGLES_ODD, STAR_COLORS, RAINBOW_CYCLE, RAINBOW_SET, RAINBOW_FRAMES,
  RAINBOW_POSITIONS, RING_ANIMS, BOMB_ANIMS, EMERALD_ANIMS, EMERALD_BOB, LETTER_FRAMES,
  FRAME_WINGS, FRAME_HAND, TOGO_OFFSETS,
} from './tables.js';

const s8 = (x) => (x << 24) >> 24;
const s16 = (x) => (x << 16) >> 16;
const u8 = (x) => x & 0xff;
const u16 = (x) => x & 0xffff;

// Controller bits (Mega Drive layout used by the game)
export const BTN_UP = 0x01;
export const BTN_DOWN = 0x02;
export const BTN_LEFT = 0x04;
export const BTN_RIGHT = 0x08;
export const BTN_B = 0x10;
export const BTN_C = 0x20;
export const BTN_A = 0x40;
export const BTN_START = 0x80;
const BTN_JUMP = BTN_A | BTN_B | BTN_C;

const NUM_SLOTS = 127;
const FIRST_DYNAMIC = 8;
const SLOT_SONIC = 0;
const SLOT_TAILS = 1;

class Obj {
  constructor(id) {
    this.id = id;
    this.routine = 0;
    this.routine2 = 0;
    this.x = 0; // 16.16 fixed
    this.y = 0;
    this.xVel = 0;
    this.yVel = 0;
    this.inertia = 0;
    this.angle = 0;
    this.anim = 0;
    this.prevAnim = 0;
    this.animFrame = 0;
    this.animDur = 0;
    this.frame = 0;
    this.xflip = false;
    this.yflip = false;
    this.onScreen = false;
    this.status = 0;
    this.priority = 0;
    this.collisionFlags = 0;
    this.collisionProperty = 0;
    this.depth = 0; // objoff_30 as 16.16
    this.child = null; // objoff_34 (shadow object)
    this.parent = null;
    this.timer = 0; // objoff_2A
    this.v2b = 0; // objoff_2B
    this.v2c = 0;
    this.v2e = 0;
    this.v2f = 0;
    this.v30w = 0;
    this.v3a = 0;
    this.v3b = 0;
    this.v3c = 0;
    this.v3e = 0;
    this.speed = 0; // objoff_14 used by fly-outs
    this.kill = false; // objoff_2A flag on shadows
    this.kind = ''; // display kind for the renderer
    this.art = 0;
    this.digits = null;
    this.glyph = 0;
  }
  get px() {
    return this.x >> 16;
  }
  set px(v) {
    this.x = (s16(v) << 16) | (this.x & 0xffff);
  }
  get py() {
    return this.y >> 16;
  }
  set py(v) {
    this.y = (s16(v) << 16) | (this.y & 0xffff);
  }
}

class Player extends Obj {
  constructor(id) {
    super(id);
    this.ssX = 0; // ss_x_pos:ss_x_sub (16.16)
    this.ssY = 0;
    this.z = 0;
    this.initFlipTimer = 0;
    this.flipTimer = 0;
    this.hurtTimer = 0;
    this.slideTimer = 0;
    this.dplcTimer = 0;
    this.lastAngleIndex = 0;
    this.ringsH = 0;
    this.ringsT = 0;
    this.ringsU = 0;
    this.jumping = false;
    this.slowing = false;
    this.flipBits = 0; // status x/y flip
  }
  get ssXw() {
    return this.ssX >> 16;
  }
  set ssXw(v) {
    this.ssX = (s16(v) << 16) | (this.ssX & 0xffff);
  }
  get ssYw() {
    return this.ssY >> 16;
  }
  set ssYw(v) {
    this.ssY = (s16(v) << 16) | (this.ssY & 0xffff);
  }
}

export class SpecialStageEngine {
  // res: { sine: Int16Array(320), perspective: Uint8Array, layout: Uint8Array,
  //        objects: Uint8Array, ringReq: number[], stageIndex, palLine3, emeraldPal }
  constructor(res, opts = {}) {
    this.res = res;
    this.opts = opts;
    this.events = []; // sound/music events for the host: {type:'sfx'|'music', id}
    this.objs = new Array(NUM_SLOTS).fill(null);
    this.lists = Array.from({ length: 8 }, () => []);
    this.sprites = []; // sprite list built by BuildSprites
    this.shownSprites = [];
    this.vintCount = 0;
    this.ctrl1 = 0; // held | press<<8 (raw pad, read in vint)
    this.ctrl1Logical = 0;
    this.ctrl2Logical = 0;
    this.padHeld = 0;
    this.prevPadHeld = 0;
    this.record = new Array(16).fill(0); // SS_Ctrl_Record_Buf
    this.tailsControlCounter = 0;
    this.done = false;
    this.result = null;
    this.fade = 1; // 1 = white, 0 = normal
    this.fadeDir = 0;
    this.gen = this.main();
  }

  // ---------------------------------------------------------------- helpers
  sincos(angle) {
    const a = angle & 0xff;
    return [this.res.sine[a], this.res.sine[a + 0x40]];
  }
  calcAngle(x, y) {
    if (x === 0 && y === 0) return 0x40;
    return u8(Math.round((Math.atan2(y, x) * 128) / Math.PI));
  }
  sfx(id) {
    this.events.push({ type: 'sfx', id });
  }
  music(id) {
    this.events.push({ type: 'music', id });
  }
  allocate() {
    for (let i = FIRST_DYNAMIC; i < NUM_SLOTS; i++) if (!this.objs[i]) return i;
    return -1;
  }
  allocateAfter(obj) {
    const start = this.objs.indexOf(obj);
    for (let i = start; i < NUM_SLOTS; i++) if (!this.objs[i]) return i;
    return -1;
  }
  spawn(slot, obj) {
    if (slot < 0) return null;
    this.objs[slot] = obj;
    obj.slot = slot;
    return obj;
  }
  spawnDynamic(id) {
    return this.spawn(this.allocate(), new Obj(id));
  }
  spawnAfter(cur, id) {
    return this.spawn(this.allocateAfter(cur), new Obj(id));
  }
  deleteObj(obj) {
    if (this.objs[obj.slot] === obj) this.objs[obj.slot] = null;
    obj.deleted = true;
  }
  display(obj) {
    this.lists[obj.priority & 7].push(obj);
  }
  get sonic() {
    return this.objs[SLOT_SONIC];
  }
  get tails() {
    return this.objs[SLOT_TAILS];
  }

  // ---------------------------------------------------------------- main
  step(pad) {
    this.padHeld = pad;
    if (this.done) return false;
    const r = this.gen.next();
    if (r.done) this.done = true;
    return !this.done;
  }

  *waitVint(kind = 'ss') {
    this.vint(kind);
    yield;
  }

  // The 68000 main loop often overruns a frame; the vertical interrupt that
  // fires mid-loop does nothing (Vint_Lag), so the picture holds for another
  // frame. This cost model was fitted against the real game's timing (see
  // tools/lagfit.mjs); weights are in frames.
  *lagFrames() {
    if (this.opts.lag === false) return;
    const di = this.decodedQuarter;
    let unc = 0;
    let runs = 0;
    let runTiles = 0;
    let decode = 0;
    if (di !== undefined && di < 4 && this.pendingFrame && this.res.trackFrame) {
      const work = this.res.trackFrame(this.pendingFrame.frame, this.pendingFrame.flipped).work;
      for (let r = di * 7; r < di * 7 + 7; r++) {
        unc += work.unc[r];
        runs += work.runs[r];
        runTiles += work.runTiles[r];
      }
      decode = 1;
    }
    let nobj = 0;
    for (const o of this.objs) if (o) nobj++;
    const cost =
      0.0016648 * unc + 0.001802 * runs - 0.0000459 * runTiles + 0.005298 * nobj + 0.006238 * this.sprites.length +
      0.0131 * (this.orientation ? 1 : 0) + 0.545 * decode - 0.165;
    const n = Math.max(0, Math.floor(cost));
    for (let i = 0; i < n; i++) yield* this.waitVint('lag');
  }

  *main() {
    this.init();
    // wait for drawing index to wrap
    do {
      yield* this.waitVint('ss');
    } while (this.drawingIndex !== 0);
    this.trackDraw();
    do {
      yield* this.waitVint('ss');
      this.trackDraw();
      this.loadPerspective();
      this.objectsManager();
    } while (u8(this.durationTimer - 1) !== 0);

    this.createRingsToGoText();
    this.scrollBG();
    this.runObjects();
    this.buildSprites();
    yield* this.waitVint('dma');
    this.music('ss');
    // Pal_FadeFromWhite: $15 steps
    for (let i = 0; i <= 0x15; i++) {
      this.fade = 1 - i / 0x15;
      yield* this.waitVint('fade');
    }
    this.fade = 0;

    while (!this.started) {
      this.ctrl1Logical = this.ctrl1;
      this.ctrl2Logical = 0;
      yield* this.waitVint('ss');
      this.trackDraw();
      this.setGeometryOffsets();
      this.loadPerspective();
      this.objectsManager();
      this.scrollBG();
      this.runObjects();
      this.buildSprites();
      yield* this.lagFrames();
    }
    for (;;) {
      yield* this.waitVint('ss');
      this.trackDraw();
      this.setGeometryOffsets();
      this.loadPerspective();
      this.objectsManager();
      this.scrollBG();
      this.palCycle();
      if (this.pauseOnly) {
        this.ctrl1Logical = this.ctrl1 & ((BTN_START << 8) | BTN_START);
      } else {
        this.ctrl1Logical = this.ctrl1;
      }
      this.ctrl2Logical = 0;
      this.runObjects();
      if (this.opts.combat && !this.checkRings) this.opts.combat.update(this);
      if (this.checkRings) break;
      this.buildSprites();
      yield* this.lagFrames();
    }
    const total = this.ringCount + this.ringCount2P;
    this.perfect = total === this.perfectRingsLeft;
    for (let i = 0; i <= 0x15; i++) {
      this.fade = i / 0x15;
      yield* this.waitVint('fade');
    }
    this.result = {
      rings: this.ringCount,
      rings2: this.ringCount2P,
      emerald: this.gotEmerald,
      perfect: this.perfect,
    };
  }

  init() {
    const res = this.res;
    this.hscrollB1 = 0;
    this.hscrollB2 = 0;
    this.vscrollBG = 0;
    this.lastVScroll = 0;
    this.started = false;
    this.currentSegment = 0;
    this.lastSegment = 0;
    this.lastSegment2 = 0xff;
    this.trackAnim = 0;
    this.trackAnimFrame = 0;
    this.lastAnimFrame = 0;
    this.mappingFrame = 0;
    this.lastMappingFrame = 0;
    this.lastMappings = -1;
    this.lastMappingsCopy = -1;
    this.drawingIndex = 0;
    this.durationTimer = 0;
    this.playerAnimFrameTimer = 0;
    this.curSpeedFactor = 0;
    this.newSpeedFactor = 0;
    this.altPNT = false;
    this.orientation = false;
    this.altHScroll = false;
    this.lastAltHScroll = false;
    this.pendingFrame = null; // frame being drawn: {frame, flipped}
    this.shownFrame = null;
    this.offsetX = 0x80;
    this.offsetY = 0x36;
    this.perspective = 0; // byte offset into perspective data
    this.swapFlag = false;
    this.ringCount = 0;
    this.ringCount2P = 0;
    this.perfectRingsLeft = 0;
    this.gotEmerald = false;
    this.act = 0;
    this.ringRequirement = 0;
    this.checkRings = false;
    this.pauseOnly = false;
    this.noCheckpoint = false;
    this.noCheckpointMsg = false;
    this.rainbowFlag = false;
    this.rainbowPalette = 0;
    this.starColor1 = 0;
    this.starColor2 = 4;
    this.hideRingsToGo = false;
    this.triggerRingsToGo = false;
    this.noRingsTogoLifetime = 0;
    this.ringsToGoBCD = 0;
    this.objPtr = 0; // SS_CurrentLevelObjectLocations offset
    this.travel = 0; // depth units travelled (objects approach 0.8 per frame)

    // palette: lines 0-2 from SS main, line 3 per stage
    this.palette = new Uint16Array(64);
    this.palette.set(res.palMain.subarray(0, 48), 0);
    this.palette.set(res.palLine3, 48);
    this.shownPalette = new Uint16Array(this.palette);

    // objects
    const sonic = this.spawn(SLOT_SONIC, new Player('sonic'));
    if (!this.opts.alone) this.spawn(SLOT_TAILS, new Player('tails'));
    this.spawn(2, new Obj('hud'));
    this.spawn(3, new Obj('banner'));
    this.spawn(4, new Obj('ringcount'));
    this.newSpeedFactor = 0x000c;
  }

  // ---------------------------------------------------------------- vint
  vint(kind) {
    if (kind === 'ss' && this.onIteration) this.onIteration(this);
    this.vintCount = (this.vintCount + 1) >>> 0;
    if (kind === 'lag') return;
    // ReadJoypads
    const held = this.padHeld & 0xff;
    const press = held & ~this.prevPadHeld & 0xff;
    this.prevPadHeld = held;
    this.ctrl1 = (held << 8) | press;
    this.shownPalette.set(this.palette);
    this.shownSprites = this.sprites;
    this.shownVScroll = this.vscrollBG;
    this.shownHScrollB = this.altHScroll ? this.hscrollB2 : this.hscrollB1;
    this.shownAltH = this.altHScroll;
    this.shownTravel = this.travel;
    if (kind !== 'ss') return;
    this.travel += 0.8;
    // SSRun_Animation_Timers
    let d1;
    if (this.curSpeedFactor !== this.newSpeedFactor) {
      this.curSpeedFactor = this.newSpeedFactor;
      this.durationTimer = 0;
    }
    this.durationTimer = s8(this.durationTimer - 1);
    if (this.durationTimer <= 0) {
      d1 = ANIM_BASE_DURATION[this.curSpeedFactor >> 1];
      this.playerAnimFrameTimer = d1;
      this.durationTimer = d1;
      this.playerAnimFrameTimer = u8(this.playerAnimFrameTimer - 1);
    } else {
      d1 = u8(this.playerAnimFrameTimer + 1);
    }
    this.drawingIndex = u8(this.drawingIndex + 1);
    if (!(s8(this.drawingIndex) < s8(d1))) {
      this.drawingIndex = 0;
      // the plane that just finished drawing becomes visible
      this.altPNT = !this.altPNT;
      if (this.pendingFrame) this.shownFrame = this.pendingFrame;
    }
  }

  // ---------------------------------------------------------------- track
  trackDraw() {
    let d0 = this.drawingIndex;
    this.decodedQuarter = d0;
    if (d0 >= 4) {
      this.setOrientation();
      return;
    }
    if (d0 === 0) {
      this.lastMappingsCopy = this.lastMappings;
      this.lastMappingFrame = this.mappingFrame;
      const seg = this.res.layout[this.currentSegment & 0xff] ?? 0;
      const d3 = seg & 0x7f;
      this.trackAnim = d3;
      const anim = TRACK_ANIMS[d3] || TRACK_ANIMS[3];
      this.mappingFrame = anim[this.trackAnimFrame] ?? 0x11;
      this.lastMappings = this.mappingFrame;
      const len = TRACK_ANIM_LEN[d3];
      this.lastAnimFrame = this.trackAnimFrame;
      this.trackAnimFrame = u8(this.trackAnimFrame + 1);
      if (this.trackAnimFrame === len) {
        this.trackAnimFrame = 0;
        this.lastSegment = this.currentSegment;
        this.currentSegment = u8(this.currentSegment + 1);
      }
    }
    this.setOrientation();
    if (d0 === 0) this.pendingFrame = { frame: this.mappingFrame, flipped: this.orientation };
  }

  setOrientation() {
    this.lastAltHScroll = this.altHScroll;
    const f = this.lastMappings;
    const segByte = () => this.res.layout[this.currentSegment & 0xff] ?? 0;
    let flip;
    if (f === FRAME_STRAIGHT2 || f === FRAME_RISE14 || f === FRAME_DROP6) flip = (segByte() & 0x80) !== 0;
    else return;
    this.orientation = flip;
    if (this.drawingIndex >= this.playerAnimFrameTimer) this.altHScroll = flip;
  }

  setGeometryOffsets() {
    if (this.drawingIndex !== this.playerAnimFrameTimer) return;
    let dx = CURVE_OFFSETS[this.mappingFrame * 2];
    if (this.orientation) dx = -dx;
    this.offsetX = dx + 0x80;
    this.offsetY = CURVE_OFFSETS[this.mappingFrame * 2 + 1] + 0x36;
  }

  loadPerspective() {
    if (this.drawingIndex !== 4) return;
    const p = this.res.perspective;
    const i = this.mappingFrame * 2;
    this.perspective = (p[i] << 8) | p[i + 1];
  }

  objectsManager() {
    if (this.drawingIndex !== 4) return;
    const seg = this.currentSegment;
    if (seg === this.lastSegment2) return;
    this.lastSegment2 = seg;
    const segType = (this.res.layout[seg] ?? 3) & 0x7f;
    const d3 = TRACK_ANIM_LEN[segType] * 4;
    for (const it of this.res.items?.get(seg) ?? []) {
      const obj = this.spawnDynamic('item');
      if (!obj) break;
      obj.depth = ((it.dist * 4 + d3) & 0xffff) << 16;
      obj.angle = it.angle;
      obj.itemType = it.type;
    }
    const src = this.res.objects;
    let p = this.objPtr;
    for (;;) {
      const slot = this.allocate();
      if (slot < 0) return;
      const d0 = src[p++];
      if (d0 === undefined) return;
      if (!(d0 & 0x80)) {
        let obj;
        if (!(d0 & 0x40)) {
          this.perfectRingsLeft++;
          obj = this.spawn(slot, new Obj('ring'));
          obj.depth = ((d0 * 4 + d3) & 0xffff) << 16;
        } else {
          obj = this.spawn(slot, new Obj('bomb'));
          obj.depth = (((d0 & 0x3f) * 4 + d3) & 0xffff) << 16;
          this.bombCounter = (this.bombCounter || 0) + 1;
          obj.variant = this.opts.bombVariant ? this.opts.bombVariant(this.bombCounter, seg) : 'BAR1';
        }
        obj.angle = src[p++];
        continue;
      }
      this.objPtr = p;
      if (d0 === 0xff) return;
      if (d0 === 0xfe) {
        this.spawn(slot, new Obj('message'));
        return;
      }
      if (d0 === 0xfd) {
        this.spawn(slot, new Obj('emerald'));
        return;
      }
      this.noCheckpoint = true;
      this.noCheckpointMsg = false;
      this.spawn(slot, new Obj('message'));
      return;
    }
  }

  // SS_ScrollBG: SSPlaneB_SetHorizOffset + SSTrack_SetVscroll
  scrollBG() {
    const d2last = this.lastAnimFrame;
    const di = this.drawingIndex;
    if (this.trackAnim <= 2) {
      let d1 = 0;
      if (d2last >= 1) {
        d1 = 2;
        if (d2last >= 2) {
          d1 = 4;
          if (d2last >= 0xa) {
            d1 = 2;
            if (d2last >= 0xb) {
              d1 = 0;
              if (d2last >= 0xc) d1 = -1;
            }
          }
        }
      }
      if (d1 >= 0) {
        let d2 = BG_SCROLL_STEPS[d1 >> 1][di] ?? 0;
        let useAlt;
        if (this.lastAltHScroll) {
          useAlt = this.altHScroll;
        } else {
          useAlt = this.altHScroll;
        }
        if (useAlt) this.hscrollB2 = s16(this.hscrollB2 + d2);
        else this.hscrollB1 = s16(this.hscrollB1 - d2);
      }
    }
    // vertical
    this.lastVScroll = this.vscrollBG;
    let table = null;
    let increase = false;
    if (this.trackAnim === 0) table = VSCROLL_RISE;
    else if (this.trackAnim === 1) {
      table = VSCROLL_DROP;
      increase = true;
    } else if (this.trackAnim === 3 && !this.pauseOnly) table = VSCROLL_STRAIGHT;
    if (!table) return;
    const d1 = table[d2last] ?? -1;
    if (d1 < 0) return;
    const d2 = BG_SCROLL_STEPS[d1 >> 1][di] ?? 0;
    if (increase) this.vscrollBG = s16(this.vscrollBG + d2);
    else this.vscrollBG = s16(this.vscrollBG - d2);
  }

  palCycle() {
    const pal = this.palette;
    if ((this.vintCount & 3) === 0) {
      pal[14] = STAR_COLORS[this.starColor1 & 7];
      this.starColor1 = u8(this.starColor1 + 1);
      pal[15] = STAR_COLORS[this.starColor2 & 7];
      this.starColor2 = u8(this.starColor2 + 1);
    }
    if (this.res.stageIndex === 6 && this.act === 3 && this.pauseOnly) {
      if (!(this.vintCount & 1) && this.ringCount + this.ringCount2P >= this.ringRequirement) {
        const first = pal[1];
        for (let i = 1; i < 13; i++) pal[i] = pal[i + 1];
        pal[13] = first;
      }
      return;
    }
    if (this.rainbowFlag && (this.vintCount & 7) === 0) {
      const d0 = this.rainbowPalette & 3;
      this.rainbowPalette = u8(this.rainbowPalette + 1);
      pal[48 + 11] = RAINBOW_CYCLE[d0 * 3];
      pal[48 + 12] = RAINBOW_CYCLE[d0 * 3 + 1];
      pal[48 + 13] = RAINBOW_CYCLE[d0 * 3 + 2];
    }
  }

  rainbowPaletteSet(d0) {
    const i = d0 / 2;
    this.palette[48 + 11] = RAINBOW_SET[i];
    this.palette[48 + 12] = RAINBOW_SET[i + 1];
    this.palette[48 + 13] = RAINBOW_SET[i + 2];
  }

  // ---------------------------------------------------------------- objects
  runObjects() {
    for (const l of this.lists) l.length = 0;
    for (let i = 0; i < NUM_SLOTS; i++) {
      const o = this.objs[i];
      if (!o) continue;
      this.runObject(o);
    }
  }

  buildSprites() {
    const out = [];
    for (let p = 0; p < 8; p++) for (const o of this.lists[p]) out.push(this.snapshot(o));
    this.sprites = out; // index 0 is frontmost
  }

  snapshot(o) {
    const s = {
      kind: o.kind || o.id,
      x: o.px,
      y: o.py,
      frame: o.frame,
      anim: o.anim,
      animFrame: o.animFrame,
      xflip: o.xflip,
      yflip: o.yflip,
      art: o.art,
      angle: o.angle,
      priority: o.priority,
    };
    if (o.id === 'sonic' || o.id === 'tails') {
      s.who = o.id;
      s.routine = o.routine;
      s.hurt = o.routine2 !== 0;
      s.jumping = o.jumping;
    }
    if (o.digits) s.digits = o.digits.slice();
    if (o.variant) s.variant = o.variant;
    if (o.killed) s.killed = true;
    if (o.painTimer) s.pain = o.painTimer;
    if (o.itemType) s.itemType = o.itemType;
    if (o.age !== undefined) s.age = o.age;
    if (o.glyph) s.glyph = o.glyph;
    if (o.parentKind) s.parentKind = o.parentKind;
    if (o.depth) s.depth = o.depth >> 16;
    return s;
  }

  runObject(o) {
    switch (o.id) {
      case 'sonic':
        return this.objSonic(o);
      case 'tails':
        return this.objTails(o);
      case 'shadow':
        return this.objShadow(o);
      case 'hud':
        return this.objHud(o);
      case 'banner':
        return this.objBanner(o);
      case 'ringcount':
        return this.objRingCount(o);
      case 'ring':
        return this.objRing(o);
      case 'bomb':
        return this.objBomb(o);
      case 'spill':
        return this.objSpill(o);
      case 'message':
        return this.objMessage(o);
      case 'emerald':
        return this.objEmerald(o);
      case 'item':
        return this.objItem(o);
    }
  }

  // DOOM pickup lying on the pipe; only the player (Doomguy) collects it.
  objItem(o) {
    switch (o.routine) {
      case 0:
        o.routine = 2;
        o.priority = 3;
        o.collisionFlags = 1;
        o.kind = 'item';
        if (o.angle < 0x80) this.makeShadow(o);
      // fallthrough
      case 2: {
        if (!this.depthUpdate(o)) return;
        this.perspectivePos(o);
        const p = this.sonic;
        if (o.anim === 8 && o.collisionFlags && p && this.collidesWith(o, p, 0x0c)) {
          o.routine = 6;
          if (o.child) {
            o.child.kill = true;
            o.child = null;
          }
          this.opts.combat?.pickup(this, o.itemType);
        }
        if (o.onScreen) this.display(o);
        return;
      }
      case 4:
        return this.objectShadow(o);
      case 6:
        o.anim = 0xa;
        o.kind = 'sparkle';
        o.age = (o.age ?? -1) + 1;
        if (!this.depthUpdate(o)) return;
        this.perspectivePos(o);
        this.display(o);
        return;
    }
  }

  // Blow up a bomb/monster without hurting anyone (shot by the player).
  destroyHazard(o) {
    if (o.routine !== 2) return false;
    o.routine = 6;
    o.collisionFlags = 0;
    o.animFrame = 0;
    o.animDur = 0;
    o.killed = true;
    if (o.child) {
      o.child.kill = true;
      o.child = null;
    }
    return true;
  }

  // Screen position of a point on the pipe (same maths as loc_351A0).
  project(depth, angle) {
    const p = this.res.perspective;
    const base = this.perspective;
    const count = (p[base] << 8) | p[base + 1];
    const d = Math.max(1, Math.min(count, Math.round(depth)));
    const e = base + 2 + (d - 1) * 6;
    let d3 = p[e + 1];
    if (d3 >= 0x80) d3 = s8(d3);
    const d2 = this.orientation ? 0x100 - p[e] : p[e];
    const [sin, cos] = this.sincos(angle);
    return { x: ((cos * p[e + 2]) >> 8) + d2, y: ((sin * p[e + 3]) >> 8) + d3, d, count };
  }

  // ---------------------------------------------------------------- Obj09 / Obj10
  // loc_33908: shifts 15 words (bytesToWcnt already subtracts one) so the
  // sidekick replays the player's input 15 frames late.
  recordCtrl() {
    for (let i = 15; i >= 1; i--) this.record[i] = this.record[i - 1];
    this.record[0] = this.opts.combat ? this.ctrl1Logical & ~((BTN_A << 8) | BTN_A) : this.ctrl1Logical;
  }

  playerInit(o, isSonic) {
    o.routine = 2;
    if (isSonic) {
      o.ssX = 0;
      o.ssYw = 0x80;
      o.ssY &= ~0xffff;
      o.z = 0x6e;
      o.priority = 3;
    } else {
      o.ssXw = 0;
      o.ssYw = 0x80;
      o.z = 0x80;
      o.priority = 2;
    }
    o.px = this.offsetX;
    o.py = 0x80 + this.offsetY;
    o.initFlipTimer = 0x04;
    o.flipTimer = 0x00;
    o.angle = 0x40;
    o.slideTimer = 0;
    o.slowing = false;
    o.collisionProperty = 0;
    o.dplcTimer = 0;
    o.lastLoadedFrame = 1;
    o.kind = isSonic ? 'sonic' : 'tails';
    const shadow = this.spawn(isSonic ? 5 : 6, new Obj('shadow'));
    shadow.parent = o;
    shadow.px = o.px;
    shadow.py = o.py + 0x18;
    shadow.priority = 4;
    shadow.kind = 'pshadow';
    shadow.ownerTails = !isSonic;
  }

  objSonic(o) {
    this.recordCtrl();
    const held = (this.ctrl1Logical >> 8) & 0xff;
    // with combat on, A is the fire button rather than a jump button
    const press = this.ctrl1Logical & 0xff & (this.opts.combat ? ~BTN_A : 0xff);
    switch (o.routine) {
      case 0:
        this.playerInit(o, true);
        return this.playerDisplay(o);
      case 2:
        if (o.routine2) {
          this.hurtAnimation(o);
          this.swapPositions(o);
          this.ssObjectMove(o);
          this.anglePos(o);
          return this.playerDisplay(o);
        }
        this.playerMove(o, held);
        this.traction(o);
        this.swapPositions(o);
        this.ssObjectMove(o);
        this.anglePos(o);
        this.playerJump(o, press);
        this.setAnimation(o);
        this.animate(o);
        this.playerCollision(o);
        return this.playerDisplay(o);
      case 4:
        this.chgJumpDir(o, held);
        this.moveAndFall(o);
        this.jumpAngle(o);
        this.levelCollision(o);
        this.swapPositions(o);
        this.anglePos(o);
        this.animate(o);
        return this.playerDisplay(o);
      case 8:
        this.chgJumpDir(o, held);
        this.moveAndFall(o);
        this.jumpAngle(o);
        this.levelCollision(o);
        this.swapPositions(o);
        this.anglePos(o);
        this.setAnimation(o);
        this.animate(o);
        return this.playerDisplay(o);
    }
  }

  objTails(o) {
    if (o.routine === 0) {
      this.playerInit(o, false);
      return this.playerDisplay(o);
    }
    if (o.routine === 2) {
      if (o.routine2) {
        this.hurtAnimation(o);
        this.swapPositions(o);
        this.ssObjectMove(o);
        this.anglePos(o);
        return this.playerDisplay(o);
      }
      this.tailsCPU();
    }
    const held = (this.ctrl2Logical >> 8) & 0xff;
    const press = this.ctrl2Logical & 0xff;
    switch (o.routine) {
      case 2:
        this.playerMove(o, held);
        this.traction(o);
        this.swapPositions(o);
        this.ssObjectMove(o);
        this.anglePos(o);
        this.playerJump(o, press);
        this.setAnimation(o);
        this.animate(o);
        this.playerCollision(o);
        return this.playerDisplay(o);
      case 4:
        this.chgJumpDir(o, held);
        this.moveAndFall(o);
        this.levelCollision(o);
        this.swapPositions(o);
        this.anglePos(o);
        this.jumpAngle(o);
        this.animate(o);
        return this.playerDisplay(o);
      case 8:
        this.chgJumpDir(o, held);
        this.moveAndFall(o);
        this.jumpAngle(o);
        this.levelCollision(o);
        this.swapPositions(o);
        this.anglePos(o);
        this.setAnimation(o);
        this.animate(o);
        return this.playerDisplay(o);
    }
  }

  tailsCPU() {
    if (this.tailsControlCounter) {
      this.tailsControlCounter--;
      return;
    }
    this.ctrl2Logical = this.record[15];
  }

  playerDisplay(o) {
    if (o.dplcTimer) {
      o.dplcTimer = u8(o.dplcTimer - 1);
      if (o.dplcTimer & 1) return;
    }
    this.display(o);
  }

  hurtAnimation(o) {
    let d0 = u8(o.hurtTimer + 8);
    o.hurtTimer = d0;
    if (d0 === 0) {
      o.routine2 = 0;
      // post-hit invulnerability (blinking); the original is $1E frames
      o.dplcTimer = this.opts.invulnFrames ?? 0x1e;
    }
    d0 = u8(u8(d0 + o.angle) - 0x10) >> 5;
    o.frame = HURT_FRAMES[d0 * 2];
    const f = HURT_FRAMES[d0 * 2 + 1];
    o.xflip = (f & 1) !== 0;
    o.yflip = (f & 2) !== 0;
    if (u8(o.hurtTimer - 8) !== 0) return;
    o.collisionProperty = 0;
    const count = o.id === 'sonic' ? this.ringCount : this.ringCount2P;
    if (!count) return;
    const spill = this.spawnDynamic('spill');
    if (spill) spill.parent = o;
  }

  playerJump(o, press) {
    if (!(press & BTN_JUMP)) return;
    const [sin, cos] = this.sincos(o.angle + 0x80);
    o.xVel = s16(o.xVel + ((cos * 0x780) >> 8));
    o.yVel = s16(o.yVel + ((sin * 0x780) >> 7));
    o.jumping = true;
    o.routine = 4;
    o.anim = 3;
    o.animDur = 0;
    o.animFrame = 0;
    o.collisionProperty = 0;
    if (!this.opts.alone) this.swapFlag = !this.swapFlag;
    this.sfx(o.id === 'sonic' ? 'jump' : 'jump2');
  }

  moveAndFall(o) {
    o.ssX = (o.ssX + (s16(o.xVel) << 8)) | 0;
    const vy = o.yVel;
    o.yVel = s16(o.yVel + 0xa8);
    o.ssY = (o.ssY + (s16(vy) << 8)) | 0;
  }

  chgJumpDir(o, held) {
    if (held & BTN_LEFT) o.xVel = s16(o.xVel - 0x40);
    else if (held & BTN_RIGHT) o.xVel = s16(o.xVel + 0x40);
  }

  jumpAngle(o) {
    let d2 = o.ssYw;
    let d3;
    const div = (a, b) => Math.floor((a << 5) / b) & 0xffff;
    if (d2 < 0) {
      d2 = -d2;
      d3 = o.ssXw;
      if (d3 < 0) {
        d3 = -d3;
        if (d3 >= d2) o.angle = u8(div(d2, d3) + 0x80);
        else o.angle = u8(0xc0 - div(d3, d2));
      } else if (d3 < d2) o.angle = u8(div(d3, d2) + 0xc0);
      else o.angle = u8(0x100 - div(d2, d3));
      return;
    }
    d3 = o.ssXw;
    if (d3 < 0) {
      d3 = -d3;
      if (d3 >= d2) o.angle = u8(0x80 - div(d2, d3));
      else o.angle = u8(div(d3, d2) + 0x40);
      return;
    }
    if (d3 < d2) {
      o.angle = u8(0x40 - div(d3, d2));
      return;
    }
    if (d3 === d2 && d3 === 0) {
      o.angle = 0x40;
      return;
    }
    o.angle = u8(div(d2, d3));
  }

  levelCollision(o) {
    const y = o.ssYw;
    if (y <= 0) return;
    const yy = (y * y) >>> 0;
    const xx = (o.ssXw * o.ssXw) >>> 0;
    // the original adds only the low words (add.w)
    const d0 = ((yy & 0xffff0000) | ((yy + xx) & 0xffff)) >>> 0;
    const zz = (o.z * o.z) >>> 0;
    if (d0 < zz) return;
    o.routine = 2;
    o.jumping = false;
    o.xVel = 0;
    o.yVel = 0;
    o.inertia = 0;
    o.slideTimer = 0;
    o.slowing = true;
    this.ssObjectMove(o);
    this.anglePos(o);
    this.sfx(o.id === 'sonic' ? 'land' : 'land2');
  }

  playerCollision(o) {
    if (!o.collisionProperty) return;
    o.collisionProperty = 0;
    if (o.dplcTimer) return;
    o.inertia = o.inertia & 0xff;
    let count;
    if (o.id === 'sonic') {
      this.swapFlag = true;
      count = this.ringCount;
    } else {
      this.swapFlag = false;
      count = this.ringCount2P;
    }
    if (count) this.sfx(o.id === 'sonic' ? 'ringspill' : 'ringspill2');
    else this.sfx(o.id === 'sonic' ? 'hurt' : 'hurt2');
    o.routine2 = 2;
    o.hurtTimer = 0;
  }

  swapPositions(o) {
    if (this.opts.alone) return;
    let d0 = o.z;
    let increase;
    if (o.id === 'sonic') increase = this.swapFlag;
    else increase = !this.swapFlag;
    if (increase) {
      if (d0 === 0x80) return;
      d0++;
    } else {
      if (d0 === 0x6e) return;
      d0--;
    }
    o.z = d0;
    o.priority = d0 >= 0x77 ? 2 : 3;
  }

  setAnimation(o) {
    if (o.jumping) {
      o.anim = 3;
      o.flipBits = 0;
      return;
    }
    const oct = u8(o.angle - 0x10) >> 5;
    const d2 = OCTANT_ANIM[oct * 2];
    if (d2 === o.anim && oct === o.lastAngleIndex) return;
    o.lastAngleIndex = oct;
    o.anim = d2;
    o.flipBits = OCTANT_ANIM[oct * 2 + 1];
    if (oct === 1 || oct === 5) {
      o.initFlipTimer = 0x04;
      o.flipTimer = 0;
    }
  }

  animate(o) {
    if (o.anim !== o.prevAnim) {
      o.animFrame = 0;
      o.prevAnim = o.anim;
      o.animDur = 0;
    }
    o.animDur = s8(o.animDur - 1);
    if (o.animDur >= 0) return;
    const script = PLAYER_ANIMS[o.anim];
    o.animDur = this.playerAnimFrameTimer >> 1;
    if (o.anim === 0) {
      o.flipTimer = s8(o.flipTimer - 1);
      if (o.flipTimer <= 0) {
        o.flipBits ^= 1;
        o.flipTimer = o.initFlipTimer;
      }
    }
    let f = script[1 + o.animFrame];
    if (f === undefined) {
      o.animFrame = 0;
      f = script[1];
    }
    o.frame = f & 0x7f;
    o.xflip = (o.flipBits & 1) !== 0;
    o.yflip = (o.flipBits & 2) !== 0;
    o.animFrame++;
  }

  playerMove(o, held) {
    let d2 = o.inertia;
    if (held & BTN_LEFT) {
      d2 += 0x60;
      if (d2 > 0x600) d2 = 0x600;
      o.inertia = d2;
      o.slowing = false;
      o.slideTimer = 0;
      return;
    }
    if (held & BTN_RIGHT) {
      d2 -= 0x60;
      if (d2 < -0x600) d2 = -0x600;
      o.inertia = d2;
      o.slowing = false;
      o.slideTimer = 0;
      return;
    }
    if (!o.slowing) {
      o.slowing = true;
      o.slideTimer = 0x1e;
    }
    d2 = d2 - (d2 >> 3);
    o.inertia = s16(d2);
    if (o.slideTimer) o.slideTimer--;
  }

  traction(o) {
    if (!o.slideTimer) {
      const [, cos] = this.sincos(o.angle);
      o.inertia = s16(o.inertia + ((cos * 0x50) >> 8));
    }
    if (o.angle < 0x80) return;
    if (u8(o.angle + 4) < 0x88) return;
    if (Math.abs(o.inertia) >= 0x100) return;
    o.routine = 8;
  }

  ssObjectMove(o) {
    const d2 = o.inertia;
    if (d2 < 0) o.angle = u8(o.angle - (u16(-d2) >> 8));
    else o.angle = u8(o.angle + (d2 >> 8));
    const [sin, cos] = this.sincos(o.angle);
    o.ssXw = (cos * o.z) >> 8;
    o.ssYw = (sin * o.z) >> 8;
  }

  anglePos(o) {
    o.px = ((o.ssXw * 0xcc) >> 8) + this.offsetX;
    o.py = o.ssYw + this.offsetY;
  }

  // ---------------------------------------------------------------- Obj63
  objShadow(o) {
    const p = o.parent;
    if (p.routine === 2) {
      o.px = p.px;
      o.py = p.py;
      o.angle = p.angle;
    } else {
      // loc_33D02
      let neg = false;
      let d0 = p.ssXw;
      if (d0 < 0) {
        neg = true;
        d0 = -d0;
      }
      d0 = Math.floor((d0 << 7) / p.z) & 0xffff;
      d0 = AIR_SHADOW_ANGLE[d0] ?? 0;
      if (!neg) d0 = u8(-(d0 - 0x80));
      if (p.ssYw < 0) d0 = u8(-d0);
      o.angle = d0;
      const [sin, cos] = this.sincos(o.angle);
      const prod = s16(cos * p.z);
      o.px = ((prod * 0xcc) >> 16) + this.offsetX;
      o.py = ((sin * p.z) >> 8) + this.offsetY;
    }
    const oct = u8(o.angle - 0x10) >> 5;
    const e = PLAYER_SHADOW[oct];
    o.art = e[0];
    o.px = o.px + e[1];
    o.py = o.py + e[2];
    o.frame = e[3];
    o.xflip = e[4] !== 0;
    o.yflip = false;
    if (o.angle >= 0x80) {
      if (oct === 3 || oct === 7) o.frame += 3;
      const d1 = this.offsetY - o.py;
      o.py = o.py + d1 * 2;
    }
    if (o.ownerTails && p.anim === 1) {
      const fb = p.flipBits;
      if (fb < 2) {
        o.px = o.px + (fb ? -4 : 4);
        o.py = o.py - 4;
      }
    }
    this.display(o);
  }

  // ---------------------------------------------------------------- HUD (Obj5E / Obj87)
  objHud(o) {
    o.priority = 0;
    this.display(o);
  }
  objRingCount(o) {
    o.priority = 0;
    this.display(o);
  }
  playerRingDigits(p) {
    return [p.ringsH, p.ringsT, p.ringsU];
  }

  // ---------------------------------------------------------------- Obj5F banner
  objBanner(o) {
    switch (o.routine) {
      case 0:
        o.px = 0x80;
        o.py = -0x40;
        o.yVel = 0x100;
        o.priority = 1;
        o.kind = 'banner';
        o.frame = 0;
        o.routine = 2;
      // fallthrough
      case 2:
        o.y = (o.y + (s16(o.yVel) << 8)) | 0;
        if (o.py < 0x48) return this.display(o);
        o.yVel = 0;
        o.py = 0x48;
        o.routine = 4;
        o.timer = 0xf;
        return this.display(o);
      case 4: {
        o.timer = u8(o.timer - 1);
        if (o.timer) return this.display(o);
        o.speed = 8;
        o.routine = 6;
        const xs = [-0x48, -0x28, -0x18, -8, 8, 0x18, 0x28];
        for (let i = 0; i < 7; i++) {
          const n = this.spawnDynamic('banner');
          if (!n) continue;
          Object.assign(n, { x: o.x, y: o.y, priority: o.priority, kind: 'banner', speed: 8, routine: 6 });
          n.frame = 2 + i;
          n.angle = this.calcAngle(xs[i], -0x28);
        }
        o.routine = 0xa;
        o.timer = 0x1e;
        return;
      }
      case 6: {
        const [sin, cos] = this.sincos(o.angle);
        o.px = o.px + ((cos * o.speed) >> 8);
        o.py = o.py + ((sin * o.speed) >> 8);
        if (o.px < 0 || o.px > 0x100 || o.py < 0) return this.deleteObj(o);
        return this.display(o);
      }
      case 0xa:
        o.timer = s16(o.timer - 1);
        if (o.timer >= 0) return;
        this.createRingReqMessage();
        this.started = true;
        return this.deleteObj(o);
    }
  }

  // ---------------------------------------------------------------- Obj60 ring / Obj61 bomb
  // loc_3512A; returns false if the object was deleted
  depthUpdate(o) {
    if (o.status & 0x80) return this.depthDelete(o);
    o.depth = (o.depth - (this.drawingIndex === 4 ? 0xcccc : 0xcccd)) | 0;
    if (o.depth <= 0) return this.depthDelete(o);
    if (o.anim === 0xa) return true;
    let d0 = o.depth >> 16;
    if (d0 > 0x1d) d0 = 0x1e;
    o.anim = DEPTH_SCALE[d0];
    return true;
  }
  depthDelete(o) {
    if (o.child) {
      o.child.kill = true;
      o.child = null;
    }
    this.deleteObj(o);
    return false;
  }

  // loc_351A0
  perspectivePos(o) {
    const p = this.res.perspective;
    const base = this.perspective;
    const count = (p[base] << 8) | p[base + 1];
    let d0 = o.depth >> 16;
    if (d0 === 0 || d0 > count) {
      o.onScreen = false;
      return;
    }
    const e = base + 2 + (d0 - 1) * 6;
    let d2, d3, d4, d5, d6, d7;
    d6 = p[e + 4];
    d7 = p[e + 5];
    if (!this.orientation) {
      if (d7) {
        const a = o.angle;
        if (a >= d6 && a < d7) {
          o.onScreen = false;
          return;
        }
      }
      d2 = p[e];
    } else {
      if (d7) {
        const m6 = u8(0x80 - d6);
        const m7 = u8(0x80 - d7);
        const a = o.angle;
        if (a >= m7 && a < m6) {
          o.onScreen = false;
          return;
        }
      }
      d2 = 0x100 - p[e];
    }
    d4 = p[e + 2];
    d5 = p[e + 3];
    d3 = p[e + 1];
    if (d3 >= 0x80) d3 = s8(d3);
    const [sin, cos] = this.sincos(o.angle);
    o.px = ((cos * d4) >> 8) + d2;
    o.py = ((sin * d5) >> 8) + d3;
    if (o.child) {
      const c = o.child;
      const r4 = d4 + (d4 >> 2);
      const r5 = d5 + (d5 >> 2);
      c.px = ((cos * r4) >> 8) + d2;
      c.py = ((sin * r5) >> 8) + d3;
    }
    o.onScreen = true;
  }

  // loc_3529C: create the floor shadow for a ring/bomb/emerald
  makeShadow(o) {
    const s = this.spawnAfter(o, o.id);
    if (!s) return;
    s.parent = o;
    s.routine = 4;
    s.priority = 5;
    s.kind = 'oshadow';
    const a = s8(o.angle);
    if (a <= 0x10) {
      s.xflip = true;
      s.v2b = 2;
    } else if (a <= 0x30) {
      s.xflip = true;
      s.v2b = 1;
    } else if (a <= 0x50) {
      s.v2b = 0;
    } else if (a <= 0x70) {
      s.v2b = 1;
    } else {
      s.v2b = 2;
    }
    o.child = s;
  }

  // loc_3533A
  objectShadow(o) {
    if (o.kill) return this.deleteObj(o);
    const p = o.parent;
    if (!p.onScreen) return;
    let d0 = 10 - p.anim;
    if (d0 === 0xa) d0 = 9;
    o.frame = d0 * 3 + o.v2b;
    o.art = o.v2b;
    this.display(o);
  }

  // loc_3539E: animation without resetting on anim change
  ssAnimate(o, table) {
    o.animDur = s8(o.animDur - 1);
    if (o.animDur >= 0) return;
    const script = table[o.anim];
    o.animDur = script[0];
    let f = script[1 + o.animFrame];
    if (f === 0xff || f === undefined) {
      o.animFrame = 0;
      f = script[1];
    }
    o.frame = f & 0x7f;
    o.animFrame++;
  }

  // AnimateSprite (standard): resets on anim change, 0xFF loops
  animateSprite(o, table) {
    if (o.anim !== o.prevAnim) {
      o.prevAnim = o.anim;
      o.animFrame = 0;
      o.animDur = 0;
    }
    o.animDur = s8(o.animDur - 1);
    if (o.animDur >= 0) return;
    const script = table[o.anim];
    o.animDur = script[0];
    let f = script[1 + o.animFrame];
    if (f === 0xff || f === undefined) {
      o.animFrame = 0;
      f = script[1];
    }
    o.frame = f & 0x7f;
    o.animFrame++;
  }

  // Obj61_TestCollision; returns the player hit or null
  testCollision(o, d6) {
    if (o.anim !== 8 || !o.collisionFlags) return null;
    const a2 = this.sonic;
    const a3 = this.tails;
    const order = a2 && a3 && !(a2.z < a3.z) ? [a3, a2] : [a2, a3];
    for (const p of order) {
      if (p && this.collidesWith(o, p, d6)) return p;
    }
    return null;
  }
  collidesWith(o, p, d6) {
    if (p.routine !== 2 || p.routine2) return false;
    const d0 = p.angle;
    const a = o.angle;
    let d1 = a + d6;
    let d2 = a - d6;
    let hit;
    if (d1 > 0xff) {
      d1 &= 0xff;
      d2 &= 0xff;
      hit = d0 < d1 || d0 >= d2;
    } else if (d2 < 0) {
      d2 &= 0xff;
      hit = d0 < d1 || d0 >= d2;
    } else {
      hit = d0 < d1 && d0 >= d2;
    }
    if (hit) o.collisionFlags = 0;
    return hit;
  }

  objRing(o) {
    switch (o.routine) {
      case 0:
        o.routine = 2;
        o.px = 0x7f;
        o.py = 0x58;
        o.priority = 3;
        o.collisionFlags = 1;
        o.kind = 'ring';
        if (o.angle < 0x80) this.makeShadow(o);
      // fallthrough
      case 2:
        if (!this.depthUpdate(o)) return;
        this.perspectivePos(o);
        this.ringCollision(o);
        this.ssAnimate(o, RING_ANIMS);
        if (o.onScreen) this.display(o);
        return;
      case 4:
        return this.objectShadow(o);
      case 6:
        o.anim = 0xa;
        o.kind = 'sparkle';
        o.age = (o.age ?? -1) + 1;
        if ((o.depth >> 16) < 4) o.priority = 1;
        if (!this.depthUpdate(o)) return;
        this.perspectivePos(o);
        this.animateSprite(o, RING_ANIMS);
        this.display(o);
        return;
    }
  }

  ringCollision(o) {
    const p = this.testCollision(o, 0xa);
    if (!p) return;
    if (p.id === 'sonic') this.ringCount++;
    else this.ringCount2P++;
    p.ringsU++;
    if (p.ringsU >= 10) {
      p.ringsT++;
      p.ringsU = 0;
      if (p.ringsT >= 10) {
        p.ringsH++;
        p.ringsT = 0;
      }
    }
    o.routine = 6;
    if (o.child) {
      o.child.kill = true;
      o.child = null;
    }
    this.sfx('ring');
  }

  objBomb(o) {
    switch (o.routine) {
      case 0:
        o.routine = 2;
        o.px = 0x7f;
        o.py = 0x58;
        o.priority = 3;
        o.collisionFlags = 2;
        o.kind = 'bomb';
        if (o.angle < 0x80) this.makeShadow(o);
      // fallthrough
      case 2:
        if (!this.depthUpdate(o)) return;
        this.perspectivePos(o);
        this.ssAnimate(o, BOMB_ANIMS);
        if (!o.onScreen) return;
        this.bombCollision(o);
        this.display(o);
        return;
      case 4:
        return this.objectShadow(o);
      case 6:
        o.anim = 0xa;
        o.kind = 'explosion';
        o.age = (o.age ?? -1) + 1;
        if ((o.depth >> 16) < 4) o.priority = 1;
        if (!this.depthUpdate(o)) return;
        this.perspectivePos(o);
        this.animateSprite(o, BOMB_ANIMS);
        this.display(o);
        return;
    }
  }

  bombCollision(o) {
    const p = this.testCollision(o, 8);
    if (!p) return;
    p.collisionProperty = 1;
    this.events.push({ type: 'sfx', id: 'bomb', variant: o.variant || 'BAR1', who: p.id });
    o.routine = 6;
    o.animFrame = 0;
    o.animDur = 0;
    o.hitPlayer = p.id;
    if (o.child) {
      o.child.kill = true;
      o.child = null;
    }
  }

  // ---------------------------------------------------------------- Obj5B ring spill
  objSpill(o) {
    if (o.routine === 0) {
      const a3 = o.parent;
      let d1 = 0;
      let angles = null;
      if (a3.ringsT) {
        a3.ringsT--;
        d1 = 10;
        angles = SPILL_ANGLES_EVEN;
      } else if (a3.ringsH) {
        a3.ringsH--;
        a3.ringsT = 9;
        d1 = 10;
        angles = SPILL_ANGLES_EVEN;
      } else if (a3.ringsU) {
        d1 = a3.ringsU;
        a3.ringsU = 0;
        angles = d1 & 1 ? SPILL_ANGLES_ODD : SPILL_ANGLES_EVEN;
      }
      if (a3.id === 'sonic') this.ringCount -= d1;
      else this.ringCount2P -= d1;
      if (!d1) return this.deleteObj(o);
      let cur = o;
      for (let i = 0; i < d1; i++) {
        if (i > 0) {
          cur = this.spawnDynamic('spill');
          if (!cur) continue;
        }
        cur.routine = 2;
        cur.priority = 5;
        cur.collisionFlags = 0;
        cur.anim = 8;
        cur.kind = 'spill';
        cur.px = a3.px;
        cur.py = a3.py;
        const [sin, cos] = this.sincos(a3.angle + 0x40 + angles[i]);
        cur.xVel = s16((cos * 0x400) >> 8);
        cur.yVel = s16((sin * 0x1000) >> 8);
      }
      return;
    }
    // Obj5B_Main
    o.x = (o.x + (s16(o.xVel) << 8)) | 0;
    const vy = o.yVel;
    o.yVel = s16(o.yVel + 0x38);
    o.y = (o.y + (s16(vy) << 8)) | 0;
    o.yVel = s16(o.yVel + 0x80);
    if (o.yVel >= 0) {
      o.priority = 0;
      o.anim = 9;
    }
    if (o.px < 0 || o.px >= 256 || o.py > 224) return this.deleteObj(o);
    this.animateSprite(o, RING_ANIMS);
    this.display(o);
  }

  // ---------------------------------------------------------------- Obj5A messages
  objMessage(o) {
    switch (o.routine) {
      case 0:
        return this.msgInit(o);
      case 2:
        return this.msgRainbow(o);
      case 4:
        return this.msgFlyoutInit(o);
      case 6:
        return this.msgHandshake(o);
      case 8:
        return this.msgFlyout(o);
      case 0xc:
        o.timer = s16(o.timer - 1);
        if (o.timer !== 0) return;
        this.checkRings = true;
        this.clearObjects();
        return;
      case 0xe:
        return this.msgRingsNeeded(o);
      case 0x10:
        return this.msgFlash(o);
      case 0x12: {
        let d0 = 0;
        if (this.ringsToGoBCD < 2) d0 = -8;
        o.px = d0 + o.timer;
        return this.msgFlash(o);
      }
      case 0x14:
        if (this.ringsToGoBCD >= 2) return this.msgFlash(o);
        return;
    }
  }

  msgInit(o) {
    if (this.noCheckpoint) {
      this.noCheckpoint = false;
      this.hideRingsToGo = false;
      this.triggerRingsToGo = false;
      this.noRingsTogoLifetime = 0;
      return this.deleteObj(o);
    }
    if (this.lastMappingsCopy !== FRAME_STRAIGHT4) return;
    this.rainbowPaletteSet(6);
    this.rainbowFlag = true;
    for (let d0 = 6; d0 >= 0; d0--) {
      const r = this.spawnDynamic('message');
      if (!r) continue;
      r.routine = 2;
      r.priority = 5;
      r.timer = d0;
      r.v30w = 0;
      r.v2c = 0;
      r.frame = -1;
      r.kind = 'rainbow';
    }
    this.deleteObj(o);
  }

  msgRainbow(o) {
    if (this.drawingIndex === 4) {
      const f = RAINBOW_FRAMES[o.v2c];
      if (f !== 0xff) {
        o.frame = f;
        o.v2c++;
        const d0 = o.timer * 2 + o.v30w;
        o.px = RAINBOW_POSITIONS[d0];
        o.py = RAINBOW_POSITIONS[d0 + 1];
        o.v30w += 0xe;
        return this.display(o);
      }
      o.frame = -1;
      // finished: the piece that ends at $E8 evaluates the checkpoint
      if (o.px !== 0xe8) return this.deleteObj(o);
      this.rainbowPaletteSet(0);
      this.rainbowFlag = false;
      this.noCheckpointMsg = true;
      let d1 = 6;
      let snd = 'error';
      if (this.ringCount + this.ringCount2P >= this.ringRequirement) {
        d1 = 4;
        snd = 'checkpoint';
      }
      this.sfx(snd);
      this.printCheckpointMessage(d1);
      this.checkpointResult = d1 === 4 ? 'cool' : 'fail';
      return this.deleteObj(o);
    }
    if (o.frame >= 0) this.display(o);
  }

  createWingedHand(d0, d3) {
    const d4 = 0x48;
    const wings = this.spawnDynamic('message');
    if (!wings) return;
    Object.assign(wings, { routine: 6, priority: 1, kind: 'wings', frame: FRAME_WINGS, timer: 0x46 });
    wings.px = d3;
    wings.py = d4;
    const hand = this.spawnDynamic('message');
    if (!hand) return;
    Object.assign(hand, { routine: 6, priority: 0, kind: 'hand', frame: FRAME_HAND, timer: 0x46, v30w: d4 });
    hand.px = d3;
    hand.py = d4;
    if (d0 === 6) {
      hand.v2f = 1;
      hand.yflip = true;
    }
  }

  msgHandshake(o) {
    if (o.frame === FRAME_HAND) {
      let d0 = o.v30w;
      if (!o.v2e) {
        o.py = o.py - 1;
        if (!(d0 - 4 < o.py)) {
          o.py = d0 - 4 + 1;
          o.v2e = 1;
        }
      } else {
        o.py = o.py + 1;
        if (!(d0 + 4 > o.py)) {
          o.py = d0 + 4 - 1;
          o.v2e = 0;
        }
      }
    }
    o.timer = s16(o.timer - 1);
    if (o.timer !== 0) return this.display(o);
    if (o.v2f) {
      this.music('fadeout');
      o.timer = 0x30;
      o.routine = 0xc;
      return;
    }
    if (o.frame !== FRAME_HAND || !o.v30w) return this.deleteObj(o);
    this.createRingReqMessage();
    this.deleteObj(o);
  }

  msgFlyoutInit(o) {
    o.timer = s16(o.timer - 1);
    if (o.timer !== 0) return this.display(o);
    if (o.kind === 'wings' || o.kind === 'hand') return this.deleteObj(o);
    o.routine = 8;
    o.speed = 8;
    o.angle = this.calcAngle(o.px - 0x80, o.py - 0x70);
    this.display(o);
  }

  msgFlyout(o) {
    const [sin, cos] = this.sincos(o.angle);
    o.px = o.px + ((cos * o.speed) >> 8);
    o.py = o.py + ((sin * o.speed) >> 8);
    if (o.px < 0 || o.px > 0x100 || o.py < 0) return this.deleteObj(o);
    this.display(o);
  }

  printWord(word, x, y) {
    for (const ch of word) {
      const n = this.spawnDynamic('message');
      if (!n) return x;
      Object.assign(n, { routine: 4, priority: 1, kind: 'letter', glyph: ch, frame: LETTER_FRAMES[ch] ?? 0, timer: 0x46 });
      n.px = x;
      n.py = y;
      x += 8;
    }
    return x;
  }

  printNumber(digit, x, y) {
    const n = this.spawnDynamic('message');
    if (!n) return;
    Object.assign(n, { routine: 4, priority: 1, kind: 'number', frame: digit, glyph: String(digit), timer: 0x46 });
    n.px = x;
    n.py = y;
  }

  startNewAct() {
    const req = this.res.ringReq[this.act] ?? this.res.ringReq[this.res.ringReq.length - 1];
    this.ringRequirement = req;
    this.act++;
    return req;
  }

  createRingReqMessage() {
    this.printWord('GET', 0x54, 0x6c);
    const req = this.startNewAct();
    const digits = String(Math.min(req, 999)).padStart(2, '0').split('').map(Number);
    let x = digits.length === 3 ? 0x80 : 0x78;
    for (let i = digits.length - 1; i >= 0; i--) {
      this.printNumber(digits[i], x, 0x6c);
      x -= 8;
    }
    x = digits.length === 3 ? 0x8c : 0x84;
    x = this.printWord('RINGS', x, 0x6c);
    this.printWord('!', x, 0x6c);
  }

  printCheckpointMessage(d0) {
    this.createWingedHand(d0, 0x80);
    if (d0 === 4) {
      this.printWord('COOL!', 0x74, 0x68);
      return;
    }
    let x = 0x5e;
    x = this.printWord('NOT', x, 0x68) + 8;
    this.printWord('ENOUGH', x, 0x68);
    x = this.printWord('RINGS', 0x5e, 0x7e) + 8;
    this.printWord('...', x, 0x7e);
  }

  createRingsToGoText() {
    this.triggerRingsToGo = true;
    const c = this.spawnDynamic('message');
    if (!c) return;
    Object.assign(c, { routine: 0xe, priority: 1, kind: 'togo-digits' });
    c.digitX = [0x5a, 0x52, 0x4a];
    c.digits = [];
    c.py = 0x38;
    let x = 0x68;
    for (const ch of 'RING') {
      const n = this.spawnDynamic('message');
      if (!n) return;
      Object.assign(n, { routine: 0x10, priority: 1, kind: 'letter', glyph: ch, frame: LETTER_FRAMES[ch] });
      n.px = x;
      n.py = 0x38;
      x += 8;
    }
    const togo = '!OGOT';
    for (let i = 0; i < togo.length; i++) {
      const n = this.spawnDynamic('message');
      if (!n) return;
      Object.assign(n, { routine: 0x12, priority: 1, kind: 'letter', glyph: togo[i], frame: LETTER_FRAMES[togo[i]], timer: TOGO_OFFSETS[i] });
      n.py = 0x38;
    }
    const s = this.spawnDynamic('message');
    if (!s) return;
    Object.assign(s, { routine: 0x14, priority: 1, kind: 'letter', glyph: 'S', frame: LETTER_FRAMES.S });
    s.px = TOGO_OFFSETS[5];
    s.py = 0x38;
  }

  msgRingsNeeded(o) {
    this.hideRingsToGo = this.triggerRingsToGo;
    if (this.triggerRingsToGo) return;
    let d0 = this.ringRequirement - (this.ringCount + this.ringCount2P);
    if (d0 <= 0) {
      d0 = 0;
      this.noRingsTogoLifetime++;
      if (this.noRingsTogoLifetime >= 0xc) this.hideRingsToGo = true;
    } else {
      this.noRingsTogoLifetime = 0;
      this.hideRingsToGo = false;
    }
    this.ringsToGoBCD = d0;
    o.digits = String(d0).split('').map(Number);
    this.msgFlash(o);
  }

  msgFlash(o) {
    if (this.noCheckpointMsg || this.hideRingsToGo) return;
    if ((this.vintCount & 7) < 6) this.display(o);
  }

  // ---------------------------------------------------------------- Obj59 emerald
  objEmerald(o) {
    switch (o.routine) {
      case 0:
        this.noCheckpointMsg = true;
        this.pauseOnly = true;
        o.timer = s16(o.timer - 1);
        if (o.timer !== -0x3c) return;
        const ep = this.res.emeraldPal;
        const st = this.res.stageIndex % 7;
        for (let i = 0; i < 3; i++) this.palette[48 + 11 + i] = ep[st * 3 + i];
        o.routine = 2;
        o.priority = 4;
        o.kind = 'emerald';
        o.depth = 0x36 << 16;
        o.angle = 0x40;
        this.makeShadow(o);
      // fallthrough
      case 2:
        this.emeraldCheck(o);
        if (!this.depthUpdate(o)) return;
        this.emeraldPos(o);
        this.ssAnimate(o, EMERALD_ANIMS);
        return this.display(o);
      case 4:
        return this.objectShadow(o);
      case 6:
        o.timer = s16(o.timer - 1);
        if (o.timer >= 0) return this.display(o);
        this.checkRings = true;
        this.clearObjects();
        return;
      case 8:
        o.timer = s16(o.timer - 1);
        if (o.timer < 0) {
          this.gotEmerald = true;
          this.checkRings = true;
          this.clearObjects();
          return;
        }
        o.v3c = u8(o.v3c + 1);
        o.py = o.v3b + EMERALD_BOB[(o.v3c >> 2) & 3];
        return this.display(o);
    }
  }

  emeraldCheck(o) {
    if (o.anim < 3) return;
    if (!o.v3e) {
      this.music('fadeout');
      o.v3e = 1;
    }
    if (o.anim < 6) return;
    if (this.ringCount + this.ringCount2P < this.ringRequirement) {
      this.newSpeedFactor = 0;
      o.routine = 6;
      o.timer = 0x4f;
      let x = 0x5e;
      x = this.printWord('NOT', x, 0x68) + 8;
      this.printWord('ENOUGH', x, 0x68);
      x = this.printWord('RINGS', 0x5e, 0x7e) + 8;
      this.printWord('...', x, 0x7e);
      this.sfx('error');
      return;
    }
    if (o.anim < 9) return;
    o.timer = 0x63;
    o.routine = 8;
    this.music('emerald');
  }

  emeraldPos(o) {
    const p = this.res.perspective;
    const e = this.perspective + 2 + ((o.depth >> 16) - 1) * 6;
    const d2 = p[e];
    let d3 = p[e + 1];
    let d4 = p[e + 2];
    let d5 = p[e + 3];
    if (d3 >= 0x80) d3 = s8(d3);
    const r4 = (d4 * 3) >> 2;
    const r5 = (d5 * 3) >> 2;
    const [sin, cos] = this.sincos(o.angle);
    o.px = ((cos * r4) >> 8) + d2;
    o.py = ((sin * r5) >> 8) + d3;
    o.v3a = u8(o.px);
    o.v3b = o.py;
    if (o.child) {
      const c = o.child;
      const s4 = d4 + (d4 >> 2);
      const s5 = d5 + (d5 >> 2);
      c.px = ((cos * s4) >> 8) + d2;
      c.py = ((sin * s5) >> 8) + d3;
    }
    o.onScreen = true;
  }

  clearObjects() {
    for (let i = 0; i < NUM_SLOTS; i++) this.objs[i] = null;
    this.sprites = [];
    for (const l of this.lists) l.length = 0;
  }

  // ---------------------------------------------------------------- render state
  // Everything the renderer needs for the current frame.
  view() {
    const sonic = this.objs[SLOT_SONIC];
    return {
      frame: this.shownFrame,
      altH: this.shownAltH,
      hscrollB: this.shownHScrollB,
      vscrollB: this.shownVScroll,
      palette: this.shownPalette,
      sprites: this.shownSprites,
      fade: this.fade,
      travel: this.shownTravel || 0,
      ringCount: this.ringCount,
      ringCount2P: this.ringCount2P,
      requirement: this.ringRequirement,
      ringsToGo: this.ringsToGoBCD,
    };
  }
}
