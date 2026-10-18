// Draws the special stage: planes through the VDP model (256x224), then DOOM
// sprites and HUD at full canvas resolution on top.
import { VDP, SCREEN_W, SCREEN_H } from '../sega/vdp.js';
import { trackHScroll } from '../ss/track.js';
import { ART_TILES } from '../ss/resources.js';
import { DEPTH_SCALE } from '../ss/tables.js';
import { makeCanvas } from './doomart.js';
import { MONSTERS } from '../ss/doomdefs.js';
import { buildPipeMap, mirrorPipeMap } from './pipemap.js';


const DOOM_ASPECT = 1.2; // DOOM pixels are 20% taller than wide on a 4:3 screen

export { MONSTERS };

export class Renderer {
  constructor(canvas, ss, art) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ss = ss;
    this.art = art;
    this.vdp = new VDP();
    ss.loadArt(this.vdp);
    this.bgPlane = ss.backgroundPlane();
    this.plane = makeCanvas(SCREEN_W, SCREEN_H);
    this.planeCtx = this.plane.getContext('2d');
    this.planeImg = this.planeCtx.createImageData(SCREEN_W, SCREEN_H);
    this.planeBuf = new Uint32Array(this.planeImg.data.buffer);
    this.sx = canvas.width / SCREEN_W;
    this.sy = canvas.height / SCREEN_H;
    this.theme = { kind: 'sonic' };
    this.sizes = {
      ring: this.measure('rings', ART_TILES.rings, 10),
      bomb: this.measure('bomb', ART_TILES.bomb, 10),
      emerald: this.measure('emerald', ART_TILES.emerald, 10),
    };
    this.time = 0;
    this.pipeMaps = new Map();
  }

  pipeMap(frame, flipped) {
    const key = frame * 2 + (flipped ? 1 : 0);
    let m = this.pipeMaps.get(key);
    if (!m) {
      const base = this.pipeMaps.get(frame * 2) || buildPipeMap(this.ss.perspective, frame);
      this.pipeMaps.set(frame * 2, base);
      m = flipped ? mirrorPipeMap(base) : base;
      this.pipeMaps.set(key, m);
    }
    return m;
  }

  // Build pipe maps a few at a time so the first lap doesn't hitch.
  prebuildPipeMaps() {
    let f = 0;
    const next = () => {
      for (let k = 0; k < 3 && f < 56; k++, f++) if (!this.pipeMaps.has(f * 2)) this.pipeMap(f, false);
      if (f < 56) setTimeout(next, 16);
    };
    setTimeout(next, 0);
  }

  flatRGBA(name) {
    const f = this.art.flat(name);
    if (!f) return null;
    const out = new Uint32Array(4096);
    let lum = 0;
    for (let i = 0; i < 4096; i++) {
      const c = this.art.pal[f.px[i]];
      out[i] = c;
      lum += 0.299 * (c & 255) + 0.587 * ((c >> 8) & 255) + 0.114 * ((c >> 16) & 255);
    }
    out.lum = lum / 4096 || 1;
    return out;
  }

  // per-role brightness gain so textures keep the original light/mid/dark bands
  roleGains(line3, tex) {
    const g = new Float32Array(8);
    for (let role = 1; role <= 7; role++) {
      const rgb = line3[role] ?? 0x808080;
      const lum = 0.299 * ((rgb >> 16) & 255) + 0.587 * ((rgb >> 8) & 255) + 0.114 * (rgb & 255);
      const t = role === 7 ? tex.stripe[0] : role === 2 || role === 4 || role === 5 ? tex.rim : tex.body;
      g[role] = lum / t.lum;
    }
    return g;
  }

  // Replace pipe pixels with DOOM textures mapped onto the pipe surface.
  texturePipe(view) {
    const tex = this.tex;
    if (!tex || !view.frame) return;
    const map = this.pipeMap(view.frame.frame, view.frame.flipped);
    const v = this.vdp;
    const out = this.planeBuf;
    const travel = view.travel || 0;
    const anim = (this.time >> 3);
    const stripe = tex.stripe[anim % tex.stripe.length];
    for (let i = 0; i < out.length; i++) {
      const role = v.colorIdx[i] - 48;
      if (role < 1 || role > 7) continue;
      const t = role === 7 ? stripe : role === 2 || role === 4 || role === 5 ? tex.rim : tex.body;
      const tv = ((map.depth[i] + travel) * 6) & 63;
      const tu = (map.angle[i] * 2) & 63;
      const c = t[tv * 64 + tu];
      const shade = v.intensity[i] ? 1 : 0.55;
      let r;
      let g;
      let b;
      if (role === 7) {
        // the stripe is a channel of animated nukage / lava / blood
        const k = tex.gains[7] * shade;
        r = (c & 255) * k;
        g = ((c >> 8) & 255) * k;
        b = ((c >> 16) & 255) * k;
      } else {
        // keep the band colour, add texture grain
        const base = this.themeRGB[role];
        const lum = (0.299 * (c & 255) + 0.587 * ((c >> 8) & 255) + 0.114 * ((c >> 16) & 255)) / t.lum;
        const k = (0.72 + 0.28 * lum) * shade;
        r = ((base >> 16) & 255) * k;
        g = ((base >> 8) & 255) * k;
        b = (base & 255) * k;
      }
      out[i] = 0xff000000 | (Math.min(255, b) << 16) | (Math.min(255, g) << 8) | Math.min(255, r);
    }
  }

  // Height in pixels of the opaque part of each scale frame of an object.
  measure(map, tileBase, frames) {
    const out = [];
    const v = this.vdp;
    for (let f = 0; f < frames; f++) {
      let minY = 99;
      let maxY = -99;
      for (const p of this.ss.mappings[map][f]) {
        for (let ty = 0; ty < p.h * 8; ty++) {
          for (let tx = 0; tx < p.w * 8; tx++) {
            const tile = tileBase + p.tile + (tx >> 3) * p.h + (ty >> 3);
            if (v.tiles[tile * 64 + (ty & 7) * 8 + (tx & 7)]) {
              minY = Math.min(minY, p.y + ty);
              maxY = Math.max(maxY, p.y + ty);
            }
          }
        }
      }
      out.push(maxY >= minY ? maxY - minY + 1 : 8);
    }
    return out;
  }

  setTheme(theme) {
    this.theme = theme;
    const v = this.vdp;
    v.overrides.clear();
    v.bgSampler = null;
    v.shadowHalves = false;
    this.tex = null;
    if (theme.kind === 'doom') {
      for (const [i, rgb] of Object.entries(theme.line3)) v.overrides.set(48 + Number(i), rgb);
      this.sky = this.buildSky(theme.sky, theme.skyBottom);
      const sky = this.sky;
      const t = theme.textures;
      this.tex = t
        ? {
            body: this.flatRGBA(t.body[0]),
            rim: this.flatRGBA(t.rim[0]),
            stripe: t.stripe.map((n) => this.flatRGBA(n)),
            floor: t.floor.map((n) => this.flatRGBA(n)),
          }
        : null;
      if (this.tex) this.tex.gains = this.roleGains(theme.line3, this.tex);
      this.prebuildPipeMaps();
      this.themeRGB = new Uint32Array(8);
      for (const [i, rgb] of Object.entries(theme.line3)) this.themeRGB[Number(i)] = rgb;
      v.shadowHalves = !!this.tex;
      v.bgSampler = (x, y) => {
        const sx = (x - this.hscrollB) & 255;
        let syy = y + ((this.vscrollB * 3) >> 2) + sky.offset;
        if (syy < 0) syy = 0;
        if (syy < sky.h) return sky.px[syy * 256 + sx];
        if (!this.tex) return sky.bottom;
        // a sea of nukage/lava/blood below the horizon, in perspective
        const row = syy - sky.h + 1;
        const dist = 256 / row;
        const floor = this.tex.floor[(this.time >> 3) % this.tex.floor.length];
        const u = (((x - 128) * dist) / 48 + this.hscrollB) & 63;
        const vv = (dist * 2 + this.travel * 3.5) & 63;
        const c = floor[vv * 64 + u];
        const k = Math.min(1, 0.35 + row / 40);
        return 0xff000000 | ((((c >> 16) & 255) * k) << 16) | ((((c >> 8) & 255) * k) << 8) | ((c & 255) * k);
      };
    }
  }

  buildSky(name, bottomRGB) {
    const tex = this.art.texture(name);
    // stop at the last row with opaque pixels (sky patches are often offset)
    let h = tex ? tex.h : 128;
    if (tex) {
      while (h > 1) {
        let any = false;
        for (let x = 0; x < tex.w; x++) if (tex.px[(h - 1) * tex.w + x] >= 0) any = true;
        if (any) break;
        h--;
      }
    }
    const px = new Uint32Array(256 * h);
    const pal = this.art.pal;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < 256; x++) {
        const c = tex ? tex.px[y * tex.w + (x % tex.w)] : 0;
        px[y * 256 + x] = pal[c < 0 ? 0 : c];
      }
    }
    const r = (bottomRGB >> 16) & 255;
    const g = (bottomRGB >> 8) & 255;
    const b = bottomRGB & 255;
    return { px, h, offset: 4, bottom: 0xff000000 | (b << 16) | (g << 8) | r };
  }

  // ------------------------------------------------------------------ frame
  render(view, hud) {
    this.time++;
    const v = this.vdp;
    const ctx = this.ctx;
    if (!view.palette) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      return;
    }
    // palette
    v.cram.set(view.palette);
    v.updateLUT();
    // planes
    if (view.frame) {
      const names = this.ss.trackFrame(view.frame.frame, view.frame.flipped);
      v.planeA.set(names);
    }
    this.hscrollB = view.hscrollB;
    this.vscrollB = view.vscrollB;
    v.planeBEnabled = this.theme.kind !== 'doom';
    if (v.planeBEnabled) v.planeB.set(this.bgPlane);
    for (let y = 0; y < SCREEN_H; y++) {
      v.hscrollA[y] = trackHScroll(y, view.altH);
      v.hscrollB[y] = view.hscrollB;
    }
    v.vscrollA = 0;
    v.vscrollB = view.vscrollB;
    this.travel = view.travel || 0;
    v.renderPlanes(this.planeBuf);
    if (this.theme.kind === 'doom' && this.tex) this.texturePipe(view);
    // shadows are VDP shadow operators: apply them in the plane pass
    const sprites = view.sprites;
    for (let i = sprites.length - 1; i >= 0; i--) {
      const s = sprites[i];
      if (s.kind === 'pshadow' || s.kind === 'oshadow') this.drawShadow(s);
    }
    this.planeCtx.putImageData(this.planeImg, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.plane, 0, 0, this.canvas.width, this.canvas.height);

    // DOOM sprites back to front
    this.firing = hud?.combat?.firing ? hud.combat.firingTimer : 0;
    for (let i = sprites.length - 1; i >= 0; i--) this.drawSprite(sprites[i], view);
    if (hud?.combat) this.drawCombat(hud.combat);
    if (hud) this.drawHud(view, hud);
    if (view.fade > 0) {
      ctx.fillStyle = `rgba(255,255,255,${Math.min(1, view.fade)})`;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  drawShadow(s) {
    const map = this.ss.mappings.shadow[s.frame];
    if (!map) return;
    const base = [ART_TILES.flatShadow, ART_TILES.diagShadow, ART_TILES.sideShadow][s.art] ?? ART_TILES.flatShadow;
    const pieces = map.map((p) => ({ ...p, tile: p.tile + base, pal: 3 }));
    this.vdp.drawTileSprite(this.planeBuf, pieces, s.x, s.y, s.xflip, s.yflip);
  }

  // Draw a DOOM image centred at Genesis coordinates (gx, gy) with a given
  // height in Genesis pixels.
  blit(img, gx, gy, height, { rot = 0, flip = false, alpha = 1, anchorY = 0.5, widthScale = 1 } = {}) {
    if (!img) return;
    const ctx = this.ctx;
    const syy = (height * this.sy) / img.h;
    const sxx = (syy / DOOM_ASPECT) * widthScale;
    ctx.save();
    ctx.translate(gx * this.sx, gy * this.sy);
    if (rot) ctx.rotate(rot);
    const f = flip !== img.flip;
    ctx.scale(f ? -sxx : sxx, syy);
    if (alpha !== 1) ctx.globalAlpha = alpha;
    ctx.drawImage(img.canvas, -img.w / 2, -img.h * anchorY);
    ctx.restore();
  }

  drawSprite(s, view) {
    const art = this.art;
    switch (s.kind) {
      case 'sonic':
      case 'tails':
        return this.drawPlayer(s);
      case 'ring': {
        const scale = s.anim <= 9 ? s.anim : 9;
        const letter = 'ABCD'[(s.animFrame + 3) & 3];
        return this.blit(art.sprite('BON1', letter, 0), s.x, s.y, this.sizes.ring[scale] * 1.25);
      }
      case 'spill': {
        const letter = 'ABCD'[(this.time >> 2) & 3];
        return this.blit(art.sprite('BON1', letter, 0), s.x, s.y, this.sizes.ring[s.anim === 9 ? 9 : 8] * 1.25);
      }
      case 'sparkle': {
        const scale = DEPTH_SCALE[Math.min(30, s.depth ?? 0)] ?? 9;
        const letter = 'ABCDE'[Math.min(4, (s.age ?? 0) >> 2)];
        return this.blit(art.sprite('IFOG', letter, 0), s.x, s.y, this.sizes.ring[scale] * 1.8);
      }
      case 'bomb':
        return this.drawHazard(s, false);
      case 'explosion':
        return this.drawHazard(s, true);
      case 'emerald': {
        const letter = 'ABCD'[(this.time >> 3) & 3];
        return this.blit(art.sprite('SOUL', letter, 0), s.x, s.y, this.sizes.emerald[Math.min(9, s.frame)] * 1.5);
      }
      case 'rainbow': {
        const letter = 'ABCDEFGHIJ'[Math.min(9, s.frame)];
        return this.blit(art.sprite('TFOG', letter, 0), s.x, s.y, this.sizes.ring[Math.min(9, s.frame)] * 1.5);
      }
      case 'item': {
        const scale = s.anim <= 9 ? s.anim : 9;
        const img = art.sprite(s.itemType, 'A', 0);
        const weapon = ['SHOT', 'SGN2', 'MGUN', 'LAUN', 'PLAS', 'BFUG'].includes(s.itemType);
        return this.blit(img, s.x, s.y, this.sizes.ring[scale] * (weapon ? 1.4 : 1.3), { widthScale: 1 });
      }
      case 'letter':
        return this.drawGlyph(s.glyph, s.x, s.y, s.kind);
      case 'number':
        return this.drawGlyph(String(s.frame), s.x, s.y, s.kind);
      case 'togo-digits': {
        const xs = [0x5a, 0x52, 0x4a];
        const d = s.digits || [];
        for (let i = 0; i < d.length; i++) this.drawGlyph(String(d[d.length - 1 - i]), xs[i], s.y);
        return;
      }
      case 'hand': {
        const face = s.yflip ? 'STFDEAD0' : 'STFEVL0';
        return this.blit(art.pic(face), s.x, s.y, 44);
      }
      case 'wings':
        return;
      case 'banner':
        return this.drawBanner(s);
      default:
        return;
    }
  }

  drawPlayer(s) {
    const art = this.art;
    const isDoomguy = s.who === 'sonic';
    const f = s.frame;
    let rot = 0;
    let letter;
    if (s.jumping || f >= 0x10) {
      rot = ((this.time * 0.35) % (Math.PI * 2)) * (isDoomguy ? 1 : -1);
      letter = isDoomguy ? ((this.time >> 2) & 1 ? 'F' : 'E') : (this.time >> 2) & 1 ? 'D' : 'C';
    } else {
      const deg = Math.PI / 180;
      if (f < 4) rot = s.yflip ? 180 * deg : 0;
      else if (f < 0xc) rot = (s.yflip ? (s.xflip ? -135 : 135) : s.xflip ? -45 : 45) * deg;
      else rot = (s.xflip ? -90 : 90) * deg;
      if (isDoomguy) letter = 'ABCD'[f < 4 ? f : f < 0xc ? (f - 4) & 3 : (f - 0xc) & 3];
      else letter = (this.time >> 3) & 1 ? 'B' : 'A';
    }
    if (isDoomguy && this.firing && !s.jumping && f < 0x10) letter = this.firing > 3 ? 'F' : 'E';
    if (s.hurt) letter = isDoomguy ? 'G' : 'E';
    const img = isDoomguy ? art.sprite('PLAY', letter, 5) : art.sprite('SKUL', letter, 5);
    this.blit(img, s.x, s.y, isDoomguy ? 50 : 36, { rot });
  }

  drawHazard(s, exploding) {
    const art = this.art;
    const variant = s.variant || 'BAR1';
    const depthScale = DEPTH_SCALE[Math.min(30, s.depth ?? 0)] ?? 9;
    const scale = exploding ? depthScale : Math.min(9, s.frame);
    const size = this.sizes.bomb[scale];
    if (variant === 'BAR1') {
      if (!exploding) return this.blit(art.sprite('BAR1', (this.time >> 3) & 1 ? 'B' : 'A', 0), s.x, s.y, size * 1.2);
      const letter = 'ABCDE'[Math.min(4, (s.age ?? 0) >> 2)];
      return this.blit(art.sprite('BEXP', letter, 0), s.x, s.y, size * 1.6);
    }
    const m = MONSTERS[variant];
    let letter;
    if (!exploding) letter = s.pain ? m.pain : m.walk[(this.time >> 3) % m.walk.length];
    else {
      const age = s.age ?? 0;
      // shot: straight to the death animation; ran into: attack, then die
      const lead = s.killed ? 0 : m.attack.length * 4;
      if (age < lead) letter = m.attack[age >> 2];
      else letter = m.death[Math.min(m.death.length - 1, (age - lead) >> 2)];
    }
    const img = art.sprite(variant, letter, exploding && letter && m.death.includes(letter) ? 0 : 1);
    this.blit(img, s.x, s.y, size * 1.25 * m.height);
  }

  // DOOM HUD font glyph centred in the original 8x16 letter cell.
  drawGlyph(ch, gx, gy, kind = 'letter', height = 12) {
    const code = ch.charCodeAt(0);
    if (ch === ' ') return;
    const img = this.art.pic(`STCFN${String(code).padStart(3, '0')}`);
    if (!img) return;
    const ctx = this.ctx;
    const syy = (height * this.sy) / 8;
    const sxx = Math.min(syy / DOOM_ASPECT, (8.5 * this.sx) / img.w);
    ctx.save();
    ctx.translate(gx * this.sx, gy * this.sy);
    ctx.scale(sxx, syy);
    ctx.drawImage(img.canvas, -img.w / 2, -4 - img.oy);
    ctx.restore();
  }

  drawText(text, gx, gy, height = 8, align = 'left') {
    const ctx = this.ctx;
    const syy = (height * this.sy) / 8;
    const sxx = syy / DOOM_ASPECT;
    let w = 0;
    const glyphs = [];
    for (const ch of text.toUpperCase()) {
      if (ch === ' ') {
        glyphs.push(null);
        w += 4;
        continue;
      }
      const img = this.art.pic(`STCFN${String(ch.charCodeAt(0)).padStart(3, '0')}`);
      glyphs.push(img);
      w += img ? img.w : 4;
    }
    let x = gx * this.sx;
    if (align === 'center') x -= (w * sxx) / 2;
    else if (align === 'right') x -= w * sxx;
    for (const img of glyphs) {
      if (!img) {
        x += 4 * sxx;
        continue;
      }
      ctx.save();
      ctx.translate(x, gy * this.sy);
      ctx.scale(sxx, syy);
      // patch offsets place small glyphs like '.' and ',' on the baseline
      ctx.drawImage(img.canvas, 0, -img.oy);
      ctx.restore();
      x += img.w * sxx;
    }
    return w * sxx;
  }

  drawBigNumber(n, gx, gy, height = 14, align = 'left') {
    const s = String(n);
    const ctx = this.ctx;
    const syy = (height * this.sy) / 16;
    const sxx = syy / DOOM_ASPECT;
    const imgs = [...s].map((d) => this.art.pic(`STTNUM${d}`));
    const w = imgs.reduce((a, i) => a + (i ? i.w : 14), 0);
    let x = gx * this.sx;
    if (align === 'center') x -= (w * sxx) / 2;
    else if (align === 'right') x -= w * sxx;
    for (const img of imgs) {
      if (img) {
        ctx.save();
        ctx.translate(x, gy * this.sy);
        ctx.scale(sxx, syy);
        ctx.drawImage(img.canvas, 0, 0);
        ctx.restore();
      }
      x += (img ? img.w : 14) * sxx;
    }
  }

  drawBanner(s) {
    // START banner: torches for the checkered flags, big letters in between
    const pieces = [
      { x: -0x48 + 16, t: 'flag' },
      { x: -0x28 + 8, t: 'S' },
      { x: -0x18 + 8, t: 'T' },
      { x: -8 + 8, t: 'A' },
      { x: 8 + 8, t: 'R' },
      { x: 0x18 + 8, t: 'T' },
      { x: 0x28 + 16, t: 'flag' },
    ];
    const list = s.frame === 0 ? pieces : [pieces[s.frame - 2]];
    for (const p of list) {
      const gx = s.x + p.x - (s.frame === 0 ? 0 : p.x);
      const gy = s.y + 16;
      if (p.t === 'flag') this.blit(this.art.sprite('TRED', 'ABCD'[(this.time >> 2) & 3], 0), gx, gy, 30);
      else this.drawGlyph(p.t, gx, gy, 'banner', 26);
    }
  }

  drawCombat(c) {
    const art = this.art;
    for (const f of c.puffs) {
      const size = 34 / Math.sqrt(f.d || 1);
      if (f.boom) this.blit(art.sprite('MISL', 'BCD'[Math.min(2, f.age >> 2)], 0), f.x, f.y, size * 2.2);
      else if (f.sprite === 'BFE1') this.blit(art.sprite('BFE1', 'ABCDEF'[Math.min(5, f.age >> 2)], 0), f.x, f.y, 90);
      else if (f.sprite === 'PLSE') this.blit(art.sprite('PLSE', 'ABCDE'[Math.min(4, f.age >> 2)], 0), f.x, f.y, size * 1.4);
      else this.blit(art.sprite(f.sprite, 'ABCD'[Math.min(3, f.age >> 2)], 0), f.x, f.y, size * (f.sprite === 'BLUD' ? 1.0 : 0.8));
    }
    for (const pr of c.projectiles) {
      const size = 40 / Math.sqrt(pr.d || 1);
      const frame = pr.sprite === 'MISL' ? 'A' : 'AB'[(pr.age >> 2) & 1];
      this.blit(art.sprite(pr.sprite, frame, pr.sprite === 'MISL' ? 5 : 0), pr.x, pr.y, size * (pr.sprite === 'BFS1' ? 1.8 : 1));
    }
  }

  drawHud(view, hud) {
    const c = hud.combat;
    if (c) {
      // ammo, bottom right, like the status bar
      const w = c.weapon;
      this.drawBigNumber(c.ammo, 246, 204, 13, 'right');
      this.drawText(w.name, 246, 194, 6, 'right');
      const icon = this.art.sprite({ bullets: 'CLIP', shells: 'SHEL', rockets: 'ROCK', cells: 'CELL' }[w.ammo], 'A', 0);
      if (icon) this.blit(icon, 196, 211, 9);
      if (c.message) this.drawText(c.message, 6, 200, 6);
    }
    const face = hud.face ? this.art.pic(hud.face) : null;
    // left: rings
    this.drawText('DOOMGUY', 14, 10, 7);
    this.drawText('RINGS', 14, 20, 7);
    this.drawBigNumber(view.ringCount + view.ringCount2P, 54, 18, 12);
    // right: rings still needed for the next checkpoint
    const toGo = Math.max(0, view.requirement - view.ringCount - view.ringCount2P);
    this.drawText('TO GO', 242, 10, 7, 'right');
    this.drawBigNumber(toGo, 242, 18, 12, 'right');
    // centre: status face
    if (face) this.blit(face, 128, 20, 24, { anchorY: 0.5 });
  }
}
