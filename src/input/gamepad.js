// Gamepad support: maps any connected pads onto the Mega Drive buttons the
// game uses, plus mute and rumble.
//
// Standard layout (Xbox / PlayStation names):
//   D-pad / left stick: move     A, B: jump        X, Y, RT: fire
//   LB / RB, D-pad up/down: change weapon            Start: pause / start
//   Back / Select / Share: mute
import { BTN_UP, BTN_DOWN, BTN_LEFT, BTN_RIGHT, BTN_A, BTN_B, BTN_C, BTN_START } from '../ss/engine.js';

const DEADZONE = 0.4;
export const PAD_MUTE = 0x100; // not a Mega Drive button

export class Gamepads {
  constructor() {
    this.connected = new Map(); // index -> id
    this.notice = null;
    addEventListener('gamepadconnected', (e) => {
      this.connected.set(e.gamepad.index, e.gamepad.id);
      this.notice = { text: 'GAMEPAD CONNECTED', until: performance.now() + 2500 };
    });
    addEventListener('gamepaddisconnected', (e) => {
      this.connected.delete(e.gamepad.index);
      this.notice = { text: 'GAMEPAD DISCONNECTED', until: performance.now() + 2500 };
    });
  }

  pads() {
    return navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
  }

  poll() {
    let v = 0;
    for (const gp of this.pads()) {
      const b = (i) => {
        const btn = gp.buttons[i];
        return !!btn && (btn.pressed || btn.value > 0.5);
      };
      const ax = (i) => gp.axes[i] ?? 0;
      // left stick: horizontal only, so pushing diagonally doesn't change weapons
      if (ax(0) < -DEADZONE) v |= BTN_LEFT;
      if (ax(0) > DEADZONE) v |= BTN_RIGHT;
      if (gp.mapping === 'standard') {
        if (b(14)) v |= BTN_LEFT;
        if (b(15)) v |= BTN_RIGHT;
        if (b(12) || b(4)) v |= BTN_UP;
        if (b(13) || b(5)) v |= BTN_DOWN;
        if (b(0)) v |= BTN_B;
        if (b(1)) v |= BTN_C;
        if (b(2) || b(3) || b(7)) v |= BTN_A;
        if (b(9)) v |= BTN_START;
        if (b(8)) v |= PAD_MUTE;
      } else {
        // unknown layout: face buttons 0-3, shoulders 4/5, triggers 6/7,
        // select 8, start 9, and a hat switch on axes 6/7 (or 4/5)
        const hx = gp.axes.length > 6 ? ax(6) : ax(4);
        const hy = gp.axes.length > 7 ? ax(7) : ax(5);
        if (hx < -0.5) v |= BTN_LEFT;
        if (hx > 0.5) v |= BTN_RIGHT;
        if (hy < -0.5 || b(4)) v |= BTN_UP;
        if (hy > 0.5 || b(5)) v |= BTN_DOWN;
        if (b(0)) v |= BTN_B;
        if (b(1)) v |= BTN_C;
        if (b(2) || b(3) || b(7)) v |= BTN_A;
        if (b(9)) v |= BTN_START;
        if (b(8)) v |= PAD_MUTE;
      }
    }
    return v;
  }

  rumble(strong, weak, ms) {
    for (const gp of this.pads()) {
      const act = gp.vibrationActuator;
      if (act?.playEffect) act.playEffect('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {});
    }
  }
}
