#!/usr/bin/env python3
"""Swap placeholder parts in a layout for manufacturer CAD meshes (run after import_sw.py).

    ~/tools/cadvenv/bin/python tools/replace_parts.py static/models/venus

Sources (simplified copies live in vendor/, mm units, made from the vendor STEP files):
  ZED X / ZED X Mini   https://www.stereolabs.com/3dmodels  ("ZED X Wide", "ZED X Mini Wide";
                       FOV cones and image planes removed)
  VN-100 Rugged        https://www.vectornav.com/resources/detail/vn-100-rugged-step-file
  Jetson AGX Thor kit  NVIDIA Jetson Download Center, "Jetson Thor Series Developer Kit 3D CAD STEP
                       model" (parts hidden inside the case dropped)
  Jetson AGX Orin kit  NVIDIA's P3737 STEP as imported into the team's Talos CAD ("NVidia Real.SLDASM"),
                       flattened with tools/sw_flatten.py --transpose (fan cover, feet, PCIe cover
                       and WiFi board were hidden in that file, so they're absent)

Each replacement keeps the placeholder's spot: `anchor` says which face of the new bounding box
lines up with the old one. `rot` maps the vendor model's axes into the planner frame
(X forward, Y port, Z up): rows are the planner axes written in vendor-model axes.
"""
import json, sys
from pathlib import Path
import numpy as np
import trimesh
sys.path.insert(0, str(Path(__file__).parent))
from import_sw import write_hpm

ROOT = Path(__file__).resolve().parent.parent
I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
# extra looks for a part, switchable in the editor: placeholder name -> [(label, vendor mesh)]
VARIANTS = {
    'Thor': [('With case', 'thor_dec.glb'), ('Case off (board, module, heatsink, fan)', 'thor_nocase.glb')],
}
SPEC = [
    # placeholder name      vendor mesh       new name                      rot (planner <- vendor)              anchor    mass kg
    ('Thor',                'thor_dec.glb',   'Jetson AGX Thor Dev Kit',    I,                                   'center', 0),
    ('Orin + capture card', 'orin_dec.glb',   'Jetson AGX Orin Dev Kit',    I,                                   'bottom', 0),
    ('VectorNav VN-100',    'vn100_dec.glb',  'VectorNav VN-100 Rugged',    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],   'center', 0.015),
    # cameras look along -Y in the Stereolabs files: FFC lens forward, DFC lens down
    ('FFC (ZED)',           'zedx_dec.glb',   'FFC · ZED X',                [[0, -1, 0], [1, 0, 0], [0, 0, 1]],  'front',  0.240),
    ('DFC',                 'zedxm_dec.glb',  'DFC · ZED X Mini',           [[0, 0, 1], [1, 0, 0], [0, 1, 0]],   'bottom', 0.150),
]


def prepare(src, rot):
    m = trimesh.load(ROOT / 'vendor' / src, force='mesh')
    M = np.array(rot, float)
    assert abs(np.linalg.det(M) - 1) < 1e-9
    m.apply_transform(np.block([[M, np.zeros((3, 1))], [np.zeros((1, 3)), np.ones((1, 1))]]))
    lo, hi = m.bounds
    m.apply_translation(-(lo + hi) / 2)
    return m.smooth_shaded, hi - lo  # smooth_shaded splits vertices at creases so boxy parts keep sharp edges


def main():
    out = Path(sys.argv[1])
    layout = json.loads((out / 'layout.json').read_text())
    url = f'models/{out.name}/'
    for old_name, src, new_name, rot, anchor, mass in SPEC:
        p = next((q for q in layout['parts'] if q['name'] == old_name), None)
        if p is None:
            print(f'skip {old_name}: not in layout'); continue
        assert all(v == 0 for v in p['rot'].values()), f'{old_name} is rotated; anchor maths assumes it is not'
        m, size = prepare(src, rot)
        P, S = np.array([p['pos'][k] for k in 'xyz']), np.array([p['size'][k] for k in 'xyz'])
        pos = P.copy()
        if anchor == 'bottom': pos[2] = P[2] - S[2] / 2 + size[2] / 2
        if anchor == 'front': pos[0] = P[0] + S[0] / 2 - size[0] / 2
        old_mesh = p.get('mesh')
        slug = Path(src).stem.replace('_dec', '')
        write_hpm(out / f'{slug}.hpm', np.asarray(m.vertices), np.asarray(m.vertex_normals), np.asarray(m.faces))
        p.update(name=new_name, mesh=url + f'{slug}.hpm', mass=mass, source={'thor': 'NVIDIA', 'orin': 'NVIDIA via the Talos CAD', 'zedx': 'Stereolabs', 'zedxm': 'Stereolabs', 'vn100': 'VectorNav'}[Path(src).stem.replace('_dec', '')] + ' CAD',
                 size={k: round(float(v), 2) for k, v in zip('xyz', size)},
                 pos={k: round(float(v), 2) for k, v in zip('xyz', pos)})
        variants = []
        for label, vsrc in VARIANTS.get(old_name, []):
            vm, vsize = (m, size) if vsrc == src else prepare(vsrc, rot)
            vslug = Path(vsrc).stem.replace('_dec', '').replace('_', '-')
            if vsrc != src:
                write_hpm(out / f'{vslug}.hpm', np.asarray(vm.vertices), np.asarray(vm.vertex_normals), np.asarray(vm.faces))
            variants.append({'label': label, 'mesh': url + f'{vslug}.hpm', 'size': {k: round(float(v), 2) for k, v in zip('xyz', vsize)}})
        if variants:
            p['variants'] = variants; p['variant'] = 0
        if old_mesh and not any(q.get('mesh') == old_mesh for q in layout['parts']):
            (out / Path(old_mesh).name).unlink(missing_ok=True)
        print(f'{old_name:22s} -> {new_name:26s} {len(m.faces):6d} tris, {np.round(size, 1)} mm at {np.round(pos, 1)}')
    layout['rev'] = 3
    (out / 'layout.json').write_text(json.dumps(layout, indent=1))


if __name__ == '__main__':
    main()
