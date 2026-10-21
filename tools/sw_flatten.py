#!/usr/bin/env python3
"""Flatten a SolidWorks assembly whose components are embedded in the file (e.g. an imported STEP
saved as .SLDASM) into one triangle mesh, in the assembly's frame, in mm.

    python3 tools/sw_flatten.py "NVidia Real.SLDASM" out.npz [--min-size 3] [--transpose]

Walks Contents/Config-0 placements recursively; parts come from ImportedComp/<name> sections,
each a complete SolidWorks document with its own display mesh. Writes positions, normals, tris.
"""
import argparse, re, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).parent))
from import_sw import sections, faces

PLACE = re.compile(rb'\x05\x00\x01\x00\x00\x00\x01([\x00\x01])', re.S)


def secmap(data):
    m = {}
    for name, dec in sections(data):
        m.setdefault(name, []).append(dec)
    return m


def placements(cfg):
    names = [(m.start(), m.group().decode('utf-16le')) for m in re.finditer(rb'(?:[\x20-\x7e]\x00){3,}', cfg)]
    out = []
    for m in PLACE.finditer(cfg):
        o = m.end()
        if m.group(1) == b'\x01':
            if o + 104 > len(cfg): continue
            v = np.frombuffer(cfg, '<f8', 13, o); R, t, s = v[:9].reshape(3, 3), v[9:12], v[12]
            if not np.allclose(R @ R.T, np.eye(3), atol=1e-5): continue
        else:
            if o + 32 > len(cfg): continue
            v = np.frombuffer(cfg, '<f8', 4, o); R, t, s = np.eye(3), v[:3], v[3]
        if not np.all(np.isfinite(v)) or abs(s - 1) > 1e-9 or np.abs(t).max() > 10: continue
        prev = [n for p, n in names if p < m.start() and re.fullmatch(r'.+-\d+', n)]
        if prev:
            out.append((prev[-1], R, t * 1000))
    return out


def part_mesh(doc):
    best = None
    for d in doc.get('Contents/DisplayLists', []):
        fs = list(faces(d))
        if fs and (best is None or sum(len(f[0]) for f in fs) > sum(len(f[0]) for f in best)):
            best = fs
    if not best: return None
    P, N, T, off = [], [], [], 0
    for p, n, t in best:
        g = np.cross(p[t[:, 1]] - p[t[:, 0]], p[t[:, 2]] - p[t[:, 0]])
        flip = np.einsum('ij,ij->i', g, n[t].sum(1)) < 0
        t[flip] = t[flip][:, [0, 2, 1]]
        P.append(p * 1000); N.append(n); T.append(t + off); off += len(p)
    return np.vstack(P), np.vstack(N), np.vstack(T)


def tess_models(outer):
    """model name (e.g. '065-0738-000_1.stp') -> (P, N, T) from FaceTessellations, via its Directory."""
    d = outer.get('FaceTessellations/Directory', [b''])[0]
    streams = {k.split('/', 1)[1]: v[0] for k, v in outer.items() if k.startswith('FaceTessellations/0')}
    marks = [(m.start(), m.end()) for m in re.finditer(b'\xff\xfe\xff', d)]
    model_keys = {}
    for i, (s0, s1) in enumerate(marks):
        n = d[s1]
        path = d[s1 + 1:s1 + 1 + 2 * n].decode('utf-16le', 'replace')
        if '@' not in path: continue
        model = re.sub(r'-\d+@.*$', '', path.rsplit('/', 1)[-1])
        tail = d[s1 + 1 + 2 * n: marks[i + 1][0] if i + 1 < len(marks) else len(d)]
        for k in range(0, len(tail) - 8):
            key = tail[k:k + 8]
            if key.count(0) < 3:
                model_keys.setdefault(model, [])
                if key not in model_keys[model]: model_keys[model].append(key)
    # locate every key in the streams; a model's block runs to the next key's block
    starts = {}
    for sname, t in streams.items():
        for model, keys in model_keys.items():
            for key in keys:
                i = t.find(key)
                if i >= 0: starts.setdefault(sname, []).append((i, model))
    out = {}
    for sname, lst in starts.items():
        lst = sorted(set(lst))
        t = streams[sname]
        for j, (i, model) in enumerate(lst):
            if model in out: continue
            end = lst[j + 1][0] if j + 1 < len(lst) else len(t)
            fs = list(faces(t[i:end]))
            if not fs: continue
            P, N, T, off = [], [], [], 0
            for p, n, tr in fs:
                g = np.cross(p[tr[:, 1]] - p[tr[:, 0]], p[tr[:, 2]] - p[tr[:, 0]])
                flip = np.einsum('ij,ij->i', g, n[tr].sum(1)) < 0
                tr[flip] = tr[flip][:, [0, 2, 1]]
                P.append(p * 1000); N.append(n); T.append(tr + off); off += len(p)
            out[model] = (np.vstack(P), np.vstack(N), np.vstack(T))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('asm', type=Path); ap.add_argument('out', type=Path)
    ap.add_argument('--min-size', type=float, default=3.0, help='skip parts whose bounding box diagonal is under this (mm)')
    ap.add_argument('--transpose', action='store_true', help='apply R^T instead of R (frame convention check)')
    a = ap.parse_args()
    outer = secmap(a.asm.read_bytes())
    embedded = {k.split('/', 1)[1]: v[0] for k, v in outer.items() if k.startswith('ImportedComp/')}
    cache, P, N, T, n_off, stats = {}, [], [], [], 0, {'parts': 0, 'skipped': 0, 'missing': set()}

    def doc_of(comp):
        if comp not in cache:
            cache[comp] = secmap(embedded[comp]) if comp in embedded else None
        return cache[comp]

    def walk(doc, M, depth=0):
        nonlocal n_off
        cfg = max(doc.get('Contents/Config-0', [b'']), key=len)
        for inst, R, t in placements(cfg):
            base = re.sub(r'-\d+$', '', inst)
            Rm = R.T if a.transpose else R
            Mc = M @ np.block([[Rm, t[:, None]], [np.zeros((1, 3)), np.ones((1, 1))]])
            for ext in ('SLDASM', 'SLDPRT'):
                sub = doc_of(f'{base}.{ext}')
                if sub is None and not (ext == 'SLDPRT' and base in tess): continue
                if ext == 'SLDASM':
                    walk(sub, Mc, depth + 1)
                else:
                    key = ('mesh', base)
                    if key not in cache: cache[key] = tess.get(base) or (part_mesh(sub) if sub else None)
                    m = cache[key]
                    if m is None: stats['missing'].add(base); break
                    p, n, tr = m
                    if np.linalg.norm(p.max(0) - p.min(0)) < a.min_size: stats['skipped'] += 1; break
                    P.append(p @ Mc[:3, :3].T + Mc[:3, 3]); N.append(n @ Mc[:3, :3].T); T.append(tr + n_off); n_off += len(p)
                    stats['parts'] += 1
                break
            else:
                stats['missing'].add(base)

    tess = tess_models(outer)
    print(f'{len(tess)} part models with tessellation')
    walk(outer, np.eye(4))
    P, N, T = np.vstack(P), np.vstack(N), np.vstack(T)
    np.savez_compressed(a.out, P=P, N=N, T=T)
    print(f"{stats['parts']} part instances, {stats['skipped']} tiny ones skipped, {len(P)} verts, {len(T)} tris")
    print('extent mm', (P.max(0) - P.min(0)).round(1), 'min', P.min(0).round(1))
    if stats['missing']: print('no mesh for:', sorted(stats['missing'])[:20])


if __name__ == '__main__':
    main()
