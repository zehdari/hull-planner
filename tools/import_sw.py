#!/usr/bin/env python3
"""Convert a SolidWorks assembly (2015+ format) into a Hull Planner layout with real part meshes.

    python3 tools/import_sw.py "CAD/Venus Hull Assembly.SLDASM" static/models/venus --hull "Base hull layout"

Reads each part's tessellated display mesh (Contents/DisplayLists) and the assembly's component
placements (Contents/Config-0), so no SolidWorks or CAD kernel is needed. Writes one .hpm mesh per
part plus layout.json. Masses aren't in the files (no materials), so they start at 0.

Frames: SolidWorks here is Y up with the hull's length along Z (+Z = bow, where the FFC sits).
The planner is X forward, Y port, Z up, origin at the centre of the hull's inside.
"""
import argparse, json, re, struct, sys, zlib
from pathlib import Path
import numpy as np

MARK = b'\x14\x00\x06\x00\x08\x00'
PLACE = b'\xa5\x05\x00\x01\x00\x00\x00\x01'
# planner axes from SolidWorks axes: x_p = z_sw, y_p = x_sw, z_p = y_sw (a proper rotation)
SW2P = np.array([[0, 0, 1], [1, 0, 0], [0, 1, 0]], float)


def sections(data):
    """(name, decompressed bytes) for every compressed section in the file."""
    pos = [m.start() for m in re.finditer(re.escape(MARK), data)]
    for i, p in enumerate(pos):
        f = struct.unpack_from('<IIIII', data, p + 6)
        nlen = f[4]
        if nlen > 300:
            continue
        name = bytes(((x << 4) & 0xF0) | (x >> 4) for x in data[p + 26:p + 26 + nlen]).decode('latin1')
        start = p + 26 + nlen
        end = pos[i + 1] if i + 1 < len(pos) else len(data)
        try:
            yield name, zlib.decompressobj(-15).decompress(data[start:end])
        except zlib.error:
            pass


def typed_arrays(d):
    out = []
    for m in re.finditer(b'\x02\x00\x00\x00', d):
        o = m.start()
        if o < 8 or o + 8 > len(d):
            continue
        es, ty = struct.unpack_from('<II', d, o - 8)
        if (es, ty) not in ((12, 100), (4, 8)):
            continue
        n = struct.unpack_from('<I', d, o + 4)[0]
        if n and o + 8 + es * n <= len(d):
            out.append((es, n, o + 8))
    return out


def faces(d):
    """Each face: int32 strip lengths, then float32 xyz positions, then float32 xyz normals."""
    arrs = typed_arrays(d)
    for (e0, n0, s0), (e1, n1, s1), (e2, n2, s2) in zip(arrs, arrs[1:], arrs[2:]):
        if (e0, e1, e2) != (4, 12, 12) or n1 != n2 or s1 != s0 + 4 * n0 + 16 or s2 != s1 + 12 * n1 + 16:
            continue
        lens = np.frombuffer(d, '<i4', n0, s0)
        if lens.min() < 3 or lens.sum() != n1:
            continue
        P = np.frombuffer(d, '<f4', 3 * n1, s1).reshape(-1, 3).astype(float)
        N = np.frombuffer(d, '<f4', 3 * n1, s2).reshape(-1, 3).astype(float)
        if not np.all(np.isfinite(P)) or not np.allclose(np.linalg.norm(N, axis=1), 1, atol=1e-2):
            continue
        tris, base = [], 0
        for L in lens:
            for k in range(L - 2):
                tris.append((base + k, base + k + 1, base + k + 2) if k % 2 == 0 else (base + k + 1, base + k, base + k + 2))
            base += L
        yield P, N, np.array(tris, np.int64)


def part_mesh(path):
    best = None
    for name, d in sections(path.read_bytes()):
        if name != 'Contents/DisplayLists' or len(d) < 64:
            continue
        fs = list(faces(d))
        if fs and (best is None or sum(len(f[0]) for f in fs) > sum(len(f[0]) for f in best)):
            best = fs
    if not best:
        raise SystemExit(f'{path.name}: no display mesh found (was it saved with display data?)')
    P, N, T, off = [], [], [], 0
    for p, n, t in best:
        # wind each triangle to agree with the stored normals
        g = np.cross(p[t[:, 1]] - p[t[:, 0]], p[t[:, 2]] - p[t[:, 0]])
        flip = np.einsum('ij,ij->i', g, n[t].sum(1)) < 0
        t[flip] = t[flip][:, [0, 2, 1]]
        P.append(p); N.append(n); T.append(t + off); off += len(p)
    return np.vstack(P) * 1000, np.vstack(N), np.vstack(T)  # mm


def placements(asm_path):
    cfg = max((d for n, d in sections(asm_path.read_bytes()) if n == 'Contents/Config-0'), key=len)
    names = [(m.start(), m.group().decode('utf-16le')) for m in re.finditer(rb'(?:[\x20-\x7e]\x00){3,}', cfg)]
    out = []
    for m in re.finditer(re.escape(PLACE), cfg):
        o = m.start()
        if cfg[o + 8] == 1:  # full rotation follows
            v = np.frombuffer(cfg, '<f8', 13, o + 9); R, t, s = v[:9].reshape(3, 3), v[9:12], v[12]
        else:                # translation only
            v = np.frombuffer(cfg, '<f8', 4, o + 9); R, t, s = np.eye(3), v[:3], v[3]
        if abs(s - 1) > 1e-6:
            continue
        prev = [n for p, n in names if p < o and re.fullmatch(r'.+-\d+', n)]
        if prev:
            out.append((prev[-1], R, t * 1000))
    return out


def hidden_components(asm_path):
    """Instance index -> hidden, from the first display state (same order as Config-0)."""
    for n, d in sections(asm_path.read_bytes()):
        if n == 'swXmlContents/COMPINSTANCETREE':
            m = re.search(rb'swShowState="([^"]*)"', d)
            if m:
                return [s == b'No' for s in m.group(1).split(b',') if s]
    return []


def write_hpm(path, P, N, T):
    """Hull Planner mesh: 'HPM1', nVerts, nTris, int16 pos (0.01 mm), int8 normals, uint16/uint32 indices."""
    pad = lambda b: b + b'\0' * (-len(b) % 4)
    big = len(P) > 65535
    body = (struct.pack('<4sII', b'HPM1', len(P), len(T))
            + pad(np.round(P * 100).astype('<i2').tobytes())
            + pad(np.round(N * 127).astype('i1').tobytes())
            + T.astype('<u4' if big else '<u2').tobytes())
    path.write_bytes(body)


def euler_xyz(Q):
    """three.js 'XYZ' Euler angles (degrees) for rotation matrix Q."""
    y = np.arcsin(np.clip(Q[0, 2], -1, 1))
    if abs(Q[0, 2]) < 0.9999999:
        x, z = np.arctan2(-Q[1, 2], Q[2, 2]), np.arctan2(-Q[0, 1], Q[0, 0])
    else:
        x, z = np.arctan2(Q[2, 1], Q[1, 1]), 0.0
    return [round(float(np.degrees(a)), 3) + 0.0 for a in (x, y, z)]


COLORS = {'Thor': '#4a5560', 'Orin': '#5d7a3a', 'Electrical Board': '#2f7d4f', 'Network Switch': '#7aa2f7',
          'Boat FOG': '#e0af68', 'Vectornav': '#bb9af7', 'FFC': '#73daca', 'DFC': '#2ac3de'}
NICE = {'Orin with capture card': 'Orin + capture card', 'FFC Full zed': 'FFC (ZED)', 'Vectornav VN100': 'VectorNav VN-100'}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('asm', type=Path)
    ap.add_argument('out', type=Path)
    ap.add_argument('--hull', default='Base hull layout', help='part name of the hull shell')
    ap.add_argument('--url', default=None, help='URL prefix the app uses for meshes (default models/<out dir name>/)')
    ap.add_argument('--name', default=None)
    ap.add_argument('--clearance', type=float, default=1.0, help='min gap in mm for the fit checks')
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    url = a.url or f'models/{a.out.name}/'
    cad = a.asm.parent

    places = placements(a.asm)
    hidden = hidden_components(a.asm)

    # hull: inside of the open-top shell (largest box minus walls) from its mesh
    HP, HN, _ = part_mesh(cad / f'{a.hull}.SLDPRT')
    lo, hi = HP.min(0), HP.max(0)
    # inner faces are the ones whose normal points inward; take the extent of the floor's top face
    inner_floor = HP[(HN[:, 1] > 0.9) & (HP[:, 1] > lo[1] + 0.1) & (HP[:, 1] < hi[1] - 0.1)]
    wall = float(inner_floor[:, 0].min() - lo[0])
    in_lo = np.array([lo[0] + wall, inner_floor[:, 1].min(), lo[2] + wall])
    in_hi = np.array([hi[0] - wall, hi[1], hi[2] - wall])
    hull_ctr = (in_lo + in_hi) / 2
    inner = in_hi - in_lo  # sw x, y, z
    hull = {'shape': 'box', 'length': round(float(inner[2]), 2), 'width': round(float(inner[0]), 2),
            'height': round(float(inner[1]), 2), 'radius': 0, 'diameter': 203,
            'wall': round(wall, 3), 'cap': round(wall, 3), 'hullMass': 0, 'water': 'fresh'}

    meshes, parts = {}, []
    for i, (inst, R, t) in enumerate(places):
        base = re.sub(r'-\d+$', '', inst)
        if base == a.hull:
            continue
        if base not in meshes:
            P, N, T = part_mesh(cad / f'{base}.SLDPRT')
            Pl, Nl = P @ SW2P.T, N @ SW2P.T       # part's own axes, renamed to planner axes
            c = (Pl.min(0) + Pl.max(0)) / 2
            slug = re.sub(r'[^a-z0-9]+', '-', base.lower()).strip('-')
            write_hpm(a.out / f'{slug}.hpm', Pl - c, Nl, T)
            meshes[base] = {'url': url + f'{slug}.hpm', 'c': c, 'size': Pl.max(0) - Pl.min(0)}
            print(f'  mesh {base}: {len(P)} verts, {len(T)} tris, {np.round(Pl.max(0) - Pl.min(0), 1)} mm')
        mm = meshes[base]
        R = R.T  # SolidWorks stores component rotations transposed (row-vector form)
        Q = SW2P @ R @ SW2P.T
        pos = Q @ mm['c'] + SW2P @ (t - hull_ctr)
        name = NICE.get(base, base)
        n_same = sum(1 for n, _, _ in places if re.sub(r'-\d+$', '', n) == base)
        if n_same > 1:
            name += ' ' + inst.rsplit('-', 1)[1]
        color = next((v for k, v in COLORS.items() if base.startswith(k)), '#9aa5b1')
        parts.append({
            'id': 'cad-' + re.sub(r'[^a-z0-9]+', '-', inst.lower()), 'name': name, 'shape': 'box', 'kind': 'part',
            'size': {k: round(float(v), 2) for k, v in zip('xyz', mm['size'])}, 'mass': 0, 'color': color,
            'pos': {k: round(float(v), 2) for k, v in zip('xyz', pos)},
            'rot': dict(zip('xyz', euler_xyz(Q))), 'locked': False,
            'hidden': bool(hidden[i]) if i < len(hidden) else False, 'mesh': mm['url'], 'source': inst,
        })

    layout = {'version': 1, 'name': a.name or a.asm.stem, 'hull': hull,
              'settings': {'clearance': a.clearance, 'snap': 5}, 'parts': parts}
    (a.out / 'layout.json').write_text(json.dumps(layout, indent=1))
    print(f'hull inside {hull["length"]} x {hull["width"]} x {hull["height"]} mm, wall {hull["wall"]} mm; {len(parts)} parts')
    for p in parts:
        print(f'  {p["name"]:28s} pos={list(p["pos"].values())} rot={list(p["rot"].values())}{"  (hidden)" if p["hidden"] else ""}')


if __name__ == '__main__':
    main()
