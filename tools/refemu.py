#!/usr/bin/env python3
"""Reference harness: runs the real Sonic 2 in the Genesis Plus GX libretro
core (from the user's RetroArch install) to capture ground-truth frames, RAM
and audio from the special stage. Dev tool only.

usage: refemu.py <core.so> <rom> <outdir> [--frames N] [--every K] [--stage S]
"""
import ctypes as C
import os
import sys
import struct
import zlib
import argparse

ap = argparse.ArgumentParser()
ap.add_argument('core')
ap.add_argument('rom')
ap.add_argument('out')
ap.add_argument('--frames', type=int, default=900)
ap.add_argument('--every', type=int, default=60)
ap.add_argument('--stage', type=int, default=0)
ap.add_argument('--mode', type=int, default=0, help='Player_mode: 0 Sonic+Tails, 1 Sonic alone')
ap.add_argument('--input', default='', help='frame:buttons,... e.g. 400:L,460:,500:J')
ap.add_argument('--audio', default='', help='write raw s16 stereo audio here')
ap.add_argument('--ramdump', default='', help='comma list of frames to dump RAM at')
ap.add_argument('--policy', default='', help='seg.af-seg.af:BTNS;... buttons chosen from SS state')
ap.add_argument('--trace', default='', help='write per-frame SS state trace (jsonl) here')
args = ap.parse_args()
os.makedirs(args.out, exist_ok=True)

core = C.CDLL(args.core)

ENV_CB = C.CFUNCTYPE(C.c_bool, C.c_uint, C.c_void_p)
VIDEO_CB = C.CFUNCTYPE(None, C.c_void_p, C.c_uint, C.c_uint, C.c_size_t)
AUDIO_CB = C.CFUNCTYPE(None, C.c_int16, C.c_int16)
AUDIOB_CB = C.CFUNCTYPE(C.c_size_t, C.POINTER(C.c_int16), C.c_size_t)
POLL_CB = C.CFUNCTYPE(None)
STATE_CB = C.CFUNCTYPE(C.c_int16, C.c_uint, C.c_uint, C.c_uint, C.c_uint)

sysdir = C.c_char_p(args.out.encode())
state = {'fmt': 0, 'frame': None, 'w': 0, 'h': 0, 'audio': bytearray(), 'buttons': set()}


def env(cmd, data):
    cmd &= 0xFFFF
    if cmd == 10:  # SET_PIXEL_FORMAT
        fmt = C.cast(data, C.POINTER(C.c_int)).contents.value
        state['fmt'] = fmt
        return fmt in (1, 2)
    if cmd in (9, 31):  # system / save directory
        C.cast(data, C.POINTER(C.c_char_p))[0] = sysdir.value
        return True
    if cmd == 3:  # GET_CAN_DUPE
        C.cast(data, C.POINTER(C.c_bool))[0] = True
        return True
    if cmd == 17:  # GET_VARIABLE_UPDATE
        C.cast(data, C.POINTER(C.c_bool))[0] = False
        return True
    return False


def video(data, w, h, pitch):
    if not data:
        return
    buf = C.string_at(data, pitch * h)
    state['frame'] = (buf, w, h, pitch)


def audio(l, r):
    state['audio'] += struct.pack('<hh', l, r)


def audiob(data, frames):
    state['audio'] += C.string_at(data, frames * 4)
    return frames


def poll():
    pass


BTN = {'B': 0, 'Y': 1, 'S': 3, 'U': 4, 'D': 5, 'L': 6, 'R': 7, 'A': 8}


POLICY = []
for item in filter(None, args.policy.split(';')):
    rng, b = item.split(':')
    a, z = rng.split('-')
    sa, fa = map(int, a.split('.'))
    sz, fz = map(int, z.split('.'))
    POLICY.append(((sa, fa), (sz, fz), set(b)))


def policy_buttons():
    if rd(0xF600) != 0x10:
        return None
    key = (rd(0xDB0A), rd(0xDB0B))
    for a, z, b in POLICY:
        if a <= key < z:
            return b
    return set()


def inp(port, device, index, id_):
    if port != 0 or device != 1:
        return 0
    btns = state['buttons']
    if POLICY and state.get('in_ss'):
        pb = policy_buttons()
        if pb is not None:
            btns = pb
    for name, bid in BTN.items():
        if bid == id_ and name in btns:
            return 1
    return 0


cbs = [ENV_CB(env), VIDEO_CB(video), AUDIO_CB(audio), AUDIOB_CB(audiob), POLL_CB(poll), STATE_CB(inp)]
core.retro_set_environment(cbs[0])
core.retro_set_video_refresh(cbs[1])
core.retro_set_audio_sample(cbs[2])
core.retro_set_audio_sample_batch(cbs[3])
core.retro_set_input_poll(cbs[4])
core.retro_set_input_state(cbs[5])
core.retro_init()


class GameInfo(C.Structure):
    _fields_ = [('path', C.c_char_p), ('data', C.c_void_p), ('size', C.c_size_t), ('meta', C.c_char_p)]


romdata = open(args.rom, 'rb').read()
rombuf = C.create_string_buffer(romdata, len(romdata))
gi = GameInfo(args.rom.encode(), C.cast(rombuf, C.c_void_p), len(romdata), None)
if not core.retro_load_game(C.byref(gi)):
    sys.exit('load failed')

core.retro_get_memory_data.restype = C.c_void_p
core.retro_get_memory_size.restype = C.c_size_t
ramp = core.retro_get_memory_data(2)
ramsz = core.retro_get_memory_size(2)
ram = (C.c_uint8 * ramsz).from_address(ramp)


def rd(addr):
    return ram[(addr & 0xFFFF) ^ 1]


def wr(addr, v):
    ram[(addr & 0xFFFF) ^ 1] = v & 0xFF


def png(path, frame):
    buf, w, h, pitch = frame
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        if state['fmt'] == 1:
            row = buf[y * pitch:y * pitch + w * 4]
            for x in range(w):
                b, g, r, _ = row[x * 4:x * 4 + 4]
                raw += bytes((r, g, b))
        else:
            row = buf[y * pitch:y * pitch + w * 2]
            for x in range(w):
                v = row[x * 2] | (row[x * 2 + 1] << 8)
                r = (v >> 11) & 31
                g = (v >> 5) & 63
                b = v & 31
                raw += bytes(((r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)))

    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(bytes(raw))) + chunk(b'IEND', b''))


GAME_MODE = 0xF600
CUR_SS = 0xFE16
sched = {}
for item in filter(None, args.input.split(',')):
    f, b = item.split(':')
    sched[int(f)] = set(b)
dumps = set(int(x) for x in filter(None, args.ramdump.split(',')))
trace = []

# boot to title, press start until in a level, then switch to the special stage
f = 0
entered = None
while f < 3000 and entered is None:
    state['buttons'] = {'S'} if (f // 10) % 2 == 0 and f > 200 else set()
    core.retro_run()
    if rd(GAME_MODE) == 0x0C and f > 300:
        wr(CUR_SS, args.stage)
        wr(0xFF70, 0)
        wr(0xFF71, args.mode)
        wr(GAME_MODE, 0x10)
        entered = f
    f += 1
print('entered special stage at frame', entered, file=sys.stderr)
state['buttons'] = set()
state['in_ss'] = True
state['audio'] = bytearray()
for i in range(args.frames):
    if i in sched:
        state['buttons'] = sched[i]
    core.retro_run()
    if i % args.every == 0 and state['frame']:
        png(os.path.join(args.out, f'ref{i:05d}.png'), state['frame'])
    if args.trace:
        w16 = lambda a: (rd(a) << 8) | rd(a + 1)
        rec = dict(f=i, seg=rd(0xDB0A), af=rd(0xDB0B), di=rd(0xDB0D), mf=rd(0xDB10), orient=rd(0xDB0E),
                   sx=w16(0xB008), sy=w16(0xB00C), sang=rd(0xB026), tx=w16(0xB048), ty=w16(0xB04C), tang=rd(0xB066),
                   rings=w16(0xFE20), mode=rd(0xF600))
        trace.append(rec)
    if i in dumps:
        with open(os.path.join(args.out, f'ram{i:05d}.bin'), 'wb') as fh:
            fh.write(bytes(ram[j ^ 1] for j in range(ramsz)))
if args.trace:
    import json
    with open(args.trace, 'w') as fh:
        for r in trace:
            fh.write(json.dumps(r) + '\n')
if args.audio:
    open(args.audio, 'wb').write(state['audio'])
print('done', state['frame'][1:3] if state['frame'] else None, file=sys.stderr)
