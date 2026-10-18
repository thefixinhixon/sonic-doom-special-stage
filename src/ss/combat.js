// Doomguy's guns. Shots travel straight down the pipe from his position:
// hitscan weapons hit the nearest barrel or monster in line, projectile
// weapons fly along the pipe. Ammo and weapons persist between stages.
import { BTN_A, BTN_UP, BTN_DOWN } from './engine.js';
import { MONSTERS, WEAPONS, ITEMS, AMMO } from './doomdefs.js';

const angleDiff = (a, b) => Math.abs(((((a - b) & 0xff) + 0x80) & 0xff) - 0x80);
const MAX_RANGE = 40;

export function newArsenal() {
  return { owned: new Set(['pistol']), ammo: { bullets: 50, shells: 0, rockets: 0, cells: 0 }, current: 'pistol' };
}

export class Combat {
  constructor(arsenal, hasDoom2) {
    this.arsenal = arsenal;
    this.hasDoom2 = hasDoom2;
    this.cooldown = 0;
    this.fireTimer = 0;
    this.projectiles = [];
    this.puffs = [];
    this.message = null;
    this.kills = 0;
    this.items = 0;
    this.pending = []; // chain-reaction explosions
  }

  get weapon() {
    return WEAPONS.find((w) => w.id === this.arsenal.current);
  }

  sfx(eng, lump, volume = 0.8) {
    eng.events.push({ type: 'sfx', lump, volume });
  }

  pickup(eng, type) {
    const it = ITEMS[type];
    if (!it) return;
    const a = this.arsenal;
    this.items++;
    if (it.weapon) {
      const isNew = !a.owned.has(it.weapon);
      a.owned.add(it.weapon);
      if (isNew) a.current = it.weapon;
      this.sfx(eng, 'DSWPNUP', 0.9);
    } else this.sfx(eng, 'DSITEMUP', 0.7);
    if (it.ammo) a.ammo[it.ammo] = Math.min(AMMO[it.ammo].max, a.ammo[it.ammo] + it.amount);
    this.message = { text: it.msg, timer: 150 };
  }

  switchWeapon(dir) {
    const owned = WEAPONS.filter((w) => this.arsenal.owned.has(w.id));
    let i = owned.findIndex((w) => w.id === this.arsenal.current);
    for (let k = 0; k < owned.length; k++) {
      i = (i + dir + owned.length) % owned.length;
      const w = owned[i];
      if (this.arsenal.ammo[w.ammo] >= w.cost) {
        this.arsenal.current = w.id;
        return;
      }
    }
  }

  // Hazards that can be shot: live bombs/monsters that are on screen.
  targets(eng) {
    const out = [];
    for (const o of eng.objs) {
      if (!o || o.id !== 'bomb' || o.routine !== 2 || !o.onScreen) continue;
      out.push(o);
    }
    return out;
  }

  damage(eng, o, dmg) {
    if (o.routine !== 2) return;
    const variant = o.variant || 'BAR1';
    if (variant === 'BAR1') {
      if (eng.destroyHazard(o)) {
        this.sfx(eng, 'DSBAREXP', 0.8);
        // barrels set off whatever is next to them
        this.pending.push({ depth: o.depth >> 16, angle: o.angle, dmg: 6, delay: 6 });
      }
      return;
    }
    const m = MONSTERS[variant];
    if (o.hp === undefined) o.hp = m.hp;
    o.hp -= dmg;
    if (o.hp <= 0) {
      if (eng.destroyHazard(o)) {
        this.kills++;
        this.sfx(eng, m.deathSound, 0.8);
      }
    } else {
      o.painTimer = 10;
      this.sfx(eng, m.painSound, 0.5);
    }
  }

  splash(eng, depth, angle, dmg, radiusD = 4, radiusA = 0x20) {
    for (const o of this.targets(eng)) {
      if (Math.abs((o.depth >> 16) - depth) <= radiusD && angleDiff(o.angle, angle) <= radiusA) this.damage(eng, o, dmg);
    }
  }

  puff(eng, depth, angle, sprite) {
    this.puffs.push({ depth, angle, sprite, age: 0, travel: eng.travel });
  }

  fire(eng, p) {
    const w = this.weapon;
    const a = this.arsenal;
    a.ammo[w.ammo] -= w.cost;
    this.cooldown = w.cooldown;
    this.fireTimer = 6;
    this.sfx(eng, w.sound, 0.55);
    if (w.projectile) {
      this.projectiles.push({ w, depth: 1.5, angle: p.angle, age: 0 });
      return;
    }
    // hitscan: nearest hazard in the firing line
    let best = null;
    for (const o of this.targets(eng)) {
      const d = o.depth >> 16;
      if (d < 2 || d > MAX_RANGE) continue;
      if (angleDiff(o.angle, p.angle) > w.window) continue;
      if (!best || d < best.depth >> 16) best = o;
    }
    if (best) {
      this.puff(eng, best.depth >> 16, best.angle, best.variant && best.variant !== 'BAR1' ? 'BLUD' : 'PUFF');
      this.damage(eng, best, w.damage);
      // shotguns spread: lesser damage to anything else in the cone
      if (w.window >= 0x18) {
        for (const o of this.targets(eng)) {
          const d = o.depth >> 16;
          if (o !== best && d >= 2 && d <= MAX_RANGE && angleDiff(o.angle, p.angle) <= w.window) this.damage(eng, o, w.damage >> 1);
        }
      }
    } else this.puff(eng, 14, p.angle, 'PUFF');
  }

  update(eng) {
    const held = (eng.ctrl1Logical >> 8) & 0xff;
    const press = eng.ctrl1Logical & 0xff;
    const p = eng.objs[0];
    if (press & BTN_UP) this.switchWeapon(-1);
    if (press & BTN_DOWN) this.switchWeapon(1);
    if (this.cooldown > 0) this.cooldown--;
    if (this.fireTimer > 0) this.fireTimer--;
    if (this.message && --this.message.timer <= 0) this.message = null;
    const w = this.weapon;
    const wantFire = press & BTN_A || (w.auto && held & BTN_A);
    if (wantFire && p && !p.routine2 && this.cooldown === 0) {
      if (this.arsenal.ammo[w.ammo] >= w.cost) this.fire(eng, p);
      else {
        this.switchWeapon(-1);
        if (press & BTN_A) this.sfx(eng, 'DSNOWAY', 0.3);
      }
    }
    // monsters flinch
    for (const o of eng.objs) if (o && o.painTimer) o.painTimer--;
    // chain reactions
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const e = this.pending[i];
      if (--e.delay > 0) continue;
      this.pending.splice(i, 1);
      this.splash(eng, e.depth, e.angle, e.dmg);
    }
    // projectiles fly down the pipe; objects come toward the player, so
    // relative closing speed is the projectile speed plus the track's
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      pr.age++;
      const before = pr.depth;
      pr.depth += pr.w.speed;
      let hit = null;
      for (const o of this.targets(eng)) {
        const d = (o.depth >> 16) + ((o.depth & 0xffff) / 65536);
        if (d >= before - 1 && d <= pr.depth + 1 && angleDiff(o.angle, pr.angle) <= pr.w.window) {
          hit = o;
          break;
        }
      }
      const done = hit || pr.depth > MAX_RANGE || (pr.w.bfg && pr.depth > 22);
      if (!done) continue;
      this.projectiles.splice(i, 1);
      const at = hit ? hit.depth >> 16 : Math.min(pr.depth, MAX_RANGE);
      if (pr.w.bfg) {
        // the BFG takes out everything in view
        this.sfx(eng, 'DSRXPLOD', 1);
        for (const o of this.targets(eng)) this.damage(eng, o, pr.w.damage);
        this.puffs.push({ depth: at, angle: pr.angle, sprite: 'BFE1', age: 0 });
      } else if (pr.w.splash) {
        this.sfx(eng, 'DSBAREXP', 0.8);
        if (hit) this.damage(eng, hit, pr.w.damage);
        this.splash(eng, at, pr.angle, pr.w.splash);
        this.puffs.push({ depth: at, angle: pr.angle, sprite: 'MISL', boom: true, age: 0 });
      } else if (hit) {
        this.damage(eng, hit, pr.w.damage);
        this.puffs.push({ depth: at, angle: pr.angle, sprite: 'PLSE', age: 0 });
      }
    }
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const f = this.puffs[i];
      f.age++;
      f.depth -= 0.8; // effects ride along with the track
      if (f.age > 20 || f.depth < 1) this.puffs.splice(i, 1);
    }
  }

  // Positions for the renderer
  view(eng) {
    const proj = (depth, angle) => (eng.perspective ? eng.project(depth, angle) : null);
    return {
      projectiles: this.projectiles.map((pr) => ({ ...proj(pr.depth, pr.angle), sprite: pr.w.projectile, age: pr.age })).filter((v) => v.x !== undefined),
      puffs: this.puffs.map((f) => ({ ...proj(f.depth, f.angle), sprite: f.sprite, age: f.age, boom: f.boom })).filter((v) => v.x !== undefined),
      weapon: this.weapon,
      ammo: this.arsenal.ammo[this.weapon.ammo],
      firing: this.fireTimer > 0,
      firingTimer: this.fireTimer,
      message: this.message?.text,
    };
  }
}
