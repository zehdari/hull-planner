// Hull Planner: lay out robot internals inside a hull.
// Frame: X forward (bow), Y port, Z up. Units: mm and kg. The hull is centred on the origin.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { OBB } from 'three/addons/math/OBB.js';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
const DEG = Math.PI / 180;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const LS_KEY = 'hullplanner.layout.v1';
const WATER = { fresh: 997, salt: 1025 };
const PALETTE = ['#4fd1c5', '#7aa2f7', '#e0af68', '#bb9af7', '#9ece6a', '#f7768e', '#ff9e64', '#73daca', '#c0caf5', '#2ac3de'];

// ---------- state ----------
let uid = 1;
const newId = () => 'p' + (Date.now().toString(36)) + (uid++);

function starter() {
  const P = (name, shape, size, mass, color, pos, rot = [0, 0, 0], kind = 'part') => ({
    id: newId(), name, shape, kind, size: { x: size[0], y: size[1], z: size[2] ?? size[1] }, mass, color,
    pos: { x: pos[0], y: pos[1], z: pos[2] }, rot: { x: rot[0], y: rot[1], z: rot[2] }, locked: false, hidden: false,
  });
  return {
    version: 1,
    name: 'Starter',
    hull: { shape: 'box', length: 500, width: 250, height: 200, radius: 15, diameter: 203, wall: 6, cap: 15, hullMass: 6.5, water: 'fresh' },
    settings: { clearance: 2, snap: 5 },
    parts: [
      P('Electronics tray', 'box', [440, 236, 4], 0.45, '#5c6f7b', [5, 0, -30]),
      P('Battery A (4S 10Ah)', 'box', [166, 69, 44], 0.85, '#e0af68', [-95, 0, -56]),
      P('Battery B (4S 10Ah)', 'box', [166, 69, 44], 0.85, '#e0af68', [95, 0, -56]),
      P('Jetson Orin', 'box', [110, 110, 72], 0.65, '#9ece6a', [-30, 0, 10]),
      P('ESC stack', 'box', [90, 60, 40], 0.30, '#f7768e', [-160, 0, -6]),
      P('Power distribution', 'box', [100, 80, 25], 0.15, '#7aa2f7', [95, 0, -13.5]),
      P('Ethernet switch', 'box', [90, 60, 25], 0.12, '#bb9af7', [200, 0, -13.5]),
      P('Microcontroller', 'box', [80, 60, 20], 0.06, '#73daca', [95, 0, 11.5]),
      P('Fan', 'cylinder', [25, 60], 0.05, '#c0caf5', [-30, 0, 62], [0, 90, 0]),
      P('Penetrator clearance (aft cap)', 'box', [25, 250, 200], 0, '#ef5b5b', [-237.5, 0, 0], [0, 0, 0], 'keepout'),
    ],
  };
}

function emptyLayout() {
  const s = starter();
  s.name = 'Untitled';
  s.parts = [];
  return s;
}

const DEFAULT_LAYOUT = 'models/venus/layout.json'; // the team's CAD layout (tools/import_sw.py)
const local = loadLocal();
let state = local || starter();
let selectedId = null;
let issues = new Map(); // id -> { hits: Set<id>, outside: bool }
const narrow = matchMedia('(max-width: 860px)').matches;
const view = { hull: true, labels: !narrow, markers: true };

function loadLocal() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY));
    if (s && s.name === 'Starter') return null; // old placeholder layout: show the CAD layout instead
    return s && s.parts ? normalize(s) : null;
  } catch { return null; }
}

function normalize(s) {
  const base = starter();
  s.hull = { ...base.hull, ...(s.hull || {}) };
  s.settings = { ...base.settings, ...(s.settings || {}) };
  s.parts = (s.parts || []).map((p, i) => ({
    id: p.id || newId(), name: p.name || `Part ${i + 1}`, shape: p.shape === 'cylinder' ? 'cylinder' : 'box',
    kind: p.kind === 'keepout' ? 'keepout' : 'part',
    size: { x: +p.size?.x || 50, y: +p.size?.y || 50, z: +p.size?.z || +p.size?.y || 50 },
    mass: +p.mass || 0, color: p.color || PALETTE[i % PALETTE.length],
    pos: { x: +p.pos?.x || 0, y: +p.pos?.y || 0, z: +p.pos?.z || 0 },
    rot: { x: +p.rot?.x || 0, y: +p.rot?.y || 0, z: +p.rot?.z || 0 },
    locked: !!p.locked, hidden: !!p.hidden,
    ...(typeof p.mesh === 'string' ? { mesh: p.mesh } : {}), ...(p.source ? { source: String(p.source) } : {}),
  }));
  return s;
}

// ---------- history ----------
const undoStack = [], redoStack = [];
let lastSnap = JSON.stringify(state);
function commit() {
  const snap = JSON.stringify(state);
  if (snap === lastSnap) return;
  undoStack.push(lastSnap);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  lastSnap = snap;
  localStorage.setItem(LS_KEY, snap);
  updateUndoButtons();
}
function restore(snap) {
  state = normalize(JSON.parse(snap));
  lastSnap = snap;
  localStorage.setItem(LS_KEY, snap);
  if (selectedId && !partById(selectedId)) selectedId = null;
  rebuildAll();
  updateUndoButtons();
}
function undo() { if (undoStack.length) { redoStack.push(lastSnap); restore(undoStack.pop()); } }
function redo() { if (redoStack.length) { undoStack.push(lastSnap); restore(redoStack.pop()); } }
function updateUndoButtons() { $('#undo').disabled = !undoStack.length; $('#redo').disabled = !redoStack.length; }
function replaceState(s, keepHistory = true) {
  state = normalize(s);
  selectedId = null;
  if (keepHistory) commit(); else { lastSnap = JSON.stringify(state); localStorage.setItem(LS_KEY, lastSnap); }
  rebuildAll();
  fitView();
}

const partById = id => state.parts.find(p => p.id === id);

// ---------- three.js scene ----------
const host = $('#viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x0d1418);
host.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xdfefff, 0x1a2228, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(300, -500, 800);
scene.add(sun);

const persp = new THREE.PerspectiveCamera(40, 1, 5, 50000);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -50000, 50000);
let camera = persp;

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = false;
orbit.screenSpacePanning = true;
orbit.addEventListener('change', requestRender);

const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.setSpace('world');
if (matchMedia('(pointer: coarse)').matches) gizmo.setSize(1.35);
scene.add(gizmo.getHelper());
gizmo.addEventListener('change', requestRender);
gizmo.addEventListener('dragging-changed', e => {
  orbit.enabled = !e.value;
  if (!e.value) { commit(); renderEditor(); }
});
gizmo.addEventListener('objectChange', () => {
  const p = partById(selectedId); const m = gizmo.object;
  if (!p || !m) return;
  p.pos = { x: r2(m.position.x), y: r2(m.position.y), z: r2(m.position.z) };
  p.rot = { x: r2(m.rotation.x / DEG), y: r2(m.rotation.y / DEG), z: r2(m.rotation.z / DEG) };
  evaluate();
  syncEditorTransform();
});

const hullGroup = new THREE.Group(); scene.add(hullGroup);
const partsGroup = new THREE.Group(); scene.add(partsGroup);
const markerGroup = new THREE.Group(); scene.add(markerGroup);
const decoGroup = new THREE.Group(); scene.add(decoGroup);
const meshes = new Map(); // id -> mesh

const r2 = v => Math.round(v * 100) / 100;
const fmt = (v, d = 0) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d);

function hullDims() {
  const h = state.hull;
  if (h.shape === 'cylinder') return { L: h.length, W: h.diameter, H: h.diameter, R: h.diameter / 2 };
  const r = Math.max(0, Math.min(h.radius || 0, h.width / 2, h.height / 2));
  return { L: h.length, W: h.width, H: h.height, r };
}

// Perimeter of a rounded rectangle (half sizes a, b; corner radius r) in the YZ plane, as [y, z] pairs.
function roundedRectPts(a, b, r, seg = 10) {
  const pts = [];
  const corners = [[a - r, b - r, 0], [-(a - r), b - r, 90], [-(a - r), -(b - r), 180], [a - r, -(b - r), 270]];
  for (const [cy, cz, start] of corners) {
    for (let i = 0; i <= seg; i++) {
      const t = (start + 90 * i / seg) * DEG;
      pts.push([cy + Math.cos(t) * r, cz + Math.sin(t) * r]);
      if (r === 0) break;
    }
  }
  return pts;
}
// Extrude a rounded rectangle along X, centred on the origin.
function roundedPrism(a, b, r, len) {
  const shape = new THREE.Shape(roundedRectPts(a, b, r).map(([y, z]) => new THREE.Vector2(y, z)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, -len / 2);
  // shape (u, v, extrude) -> world (x = extrude, y = u, z = v)
  g.applyMatrix4(new THREE.Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1));
  return g;
}
function roundedRectArea(a, b, r) { return 4 * a * b - (4 - Math.PI) * r * r; }

function buildHull() {
  hullGroup.clear(); decoGroup.clear();
  const h = state.hull, d = hullDims();
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x8fd3ff, transparent: true, opacity: 0.10, roughness: 0.1, side: THREE.DoubleSide, depthWrite: false,
  });
  const lineMat = new THREE.LineBasicMaterial({ color: 0x4f7f95, transparent: true, opacity: 0.8 });
  const faintMat = new THREE.LineBasicMaterial({ color: 0x4f7f95, transparent: true, opacity: 0.3 });
  const capMat = new THREE.MeshStandardMaterial({ color: 0x4f6672, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false });

  if (h.shape === 'cylinder') {
    const Ro = d.R + h.wall;
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(Ro, Ro, d.L, 72, 1, true), glass);
    tube.rotation.z = Math.PI / 2;
    hullGroup.add(tube);
    // rings: inner surface at the ends, plus a few along the length
    const ring = (x, r, mat) => {
      const pts = [];
      for (let i = 0; i <= 96; i++) { const a = i / 96 * Math.PI * 2; pts.push(new THREE.Vector3(x, Math.cos(a) * r, Math.sin(a) * r)); }
      hullGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    };
    for (const s of [-1, 1]) { ring(s * d.L / 2, d.R, lineMat); ring(s * d.L / 2, Ro, lineMat); }
    const n = Math.max(1, Math.round(d.L / 100));
    for (let i = 1; i < n; i++) ring(-d.L / 2 + i * d.L / n, d.R, faintMat);
    // longitudinal lines at the top, bottom and sides
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2;
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-d.L / 2, Math.cos(a) * d.R, Math.sin(a) * d.R), new THREE.Vector3(d.L / 2, Math.cos(a) * d.R, Math.sin(a) * d.R)]);
      hullGroup.add(new THREE.Line(g, faintMat));
    }
    if (h.cap > 0) for (const s of [-1, 1]) {
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(Ro, Ro, h.cap, 72), capMat);
      cap.rotation.z = Math.PI / 2; cap.position.x = s * (d.L / 2 + h.cap / 2);
      hullGroup.add(cap);
    }
  } else {
    const w = h.wall, a = d.W / 2, b = d.H / 2, ro = d.r > 0 ? d.r + w : 0;
    hullGroup.add(new THREE.Mesh(roundedPrism(a + w, b + w, ro, d.L), glass));
    const ring = (x, pts, mat) => hullGroup.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([...pts, pts[0]].map(([y, z]) => new THREE.Vector3(x, y, z))), mat));
    const innerPts = roundedRectPts(a, b, d.r), outerPts = roundedRectPts(a + w, b + w, ro);
    for (const s of [-1, 1]) { ring(s * d.L / 2, innerPts, lineMat); ring(s * d.L / 2, outerPts, lineMat); }
    const n = Math.max(1, Math.round(d.L / 100));
    for (let i = 1; i < n; i++) ring(-d.L / 2 + i * d.L / n, innerPts, faintMat);
    // inner edges running fore-aft, where the flat walls meet the corner fillets
    for (const [y, z] of [[a, b - d.r], [a - d.r, b], [-a, b - d.r], [-(a - d.r), b], [a, -(b - d.r)], [a - d.r, -b], [-a, -(b - d.r)], [-(a - d.r), -b]]) {
      hullGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-d.L / 2, y, z), new THREE.Vector3(d.L / 2, y, z)]), lineMat));
      if (d.r === 0) break;
    }
    if (d.r === 0) for (const [y, z] of [[a, b], [-a, b], [a, -b], [-a, -b]])
      hullGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-d.L / 2, y, z), new THREE.Vector3(d.L / 2, y, z)]), lineMat));
    if (h.cap > 0) for (const s of [-1, 1]) {
      const cap = new THREE.Mesh(roundedPrism(a + w, b + w, ro, h.cap), capMat);
      cap.position.x = s * (d.L / 2 + h.cap / 2);
      hullGroup.add(cap);
    }
  }
  hullGroup.visible = view.hull;

  // bow arrow + floor grid
  const extent = d.L / 2 + (h.cap || 0);
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(10, 30, 24), new THREE.MeshBasicMaterial({ color: 0x4fd1c5 }));
  arrow.rotation.z = -Math.PI / 2; arrow.position.set(extent + 30, 0, 0);
  decoGroup.add(arrow);
  const size = Math.ceil((Math.max(d.L, d.W) + 400) / 100) * 100;
  const grid = new THREE.GridHelper(size, size / 25, 0x2a3c46, 0x1a272f);
  grid.rotation.x = Math.PI / 2;
  grid.position.z = -(d.H / 2 + h.wall + 40);
  decoGroup.add(grid);
  const axes = new THREE.AxesHelper(40); axes.position.copy(grid.position).setX(-extent - 60);
  decoGroup.add(axes);
}

function partGeometry(p) {
  if (p.shape === 'cylinder') {
    const g = new THREE.CylinderGeometry(p.size.y / 2, p.size.y / 2, p.size.x, 40);
    g.rotateZ(Math.PI / 2); // axis along local X
    return g;
  }
  return new THREE.BoxGeometry(p.size.x, p.size.y, p.size.z);
}

// CAD meshes (.hpm from tools/import_sw.py): 'HPM1', nVerts, nTris, int16 xyz (0.01 mm), int8 normals, uint16/32 indices.
// Centred on their bounding box, so a part's size/pos/rot describe the box the mesh sits in.
const meshCache = new Map();
function loadMesh(url) {
  if (!meshCache.has(url)) {
    meshCache.set(url, fetch(url).then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }).then(buf => {
      const dv = new DataView(buf), nV = dv.getUint32(4, true), nT = dv.getUint32(8, true);
      const pad = n => Math.ceil(n / 4) * 4;
      let o = 12;
      const raw = new Int16Array(buf, o, nV * 3); o += pad(nV * 6);
      const nrm = new Int8Array(buf, o, nV * 3); o += pad(nV * 3);
      const idx = nV > 65535 ? new Uint32Array(buf, o, nT * 3) : new Uint16Array(buf, o, nT * 3);
      const pos = new Float32Array(nV * 3);
      for (let i = 0; i < pos.length; i++) pos[i] = raw[i] / 100;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3, true));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.userData.shared = true;
      return { geo: g, edges: Object.assign(new THREE.EdgesGeometry(g, 30), { userData: { shared: true } }) };
    }));
  }
  return meshCache.get(url);
}
const disposeGeo = g => { if (!g.userData.shared) g.dispose(); };

function buildPart(p) {
  const old = meshes.get(p.id);
  if (old) { partsGroup.remove(old); disposeGeo(old.geometry); }
  const geo = partGeometry(p);
  const ko = p.kind === 'keepout';
  const mat = new THREE.MeshStandardMaterial({
    color: p.color, roughness: p.mesh ? 0.7 : 0.55, metalness: 0.05,
    transparent: ko || !!p.mesh, opacity: ko ? 0.18 : p.mesh ? 0.25 : 1, depthWrite: !ko,
    side: ko || p.mesh ? THREE.DoubleSide : THREE.FrontSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), new THREE.LineBasicMaterial({ color: 0x0d1418, transparent: true, opacity: 0.6 }));
  mesh.add(edges);
  mesh.userData = { id: p.id, edges };
  if (p.mesh) {
    // show the bounding box faintly until the CAD mesh arrives
    loadMesh(p.mesh).then(({ geo: g, edges: eg }) => {
      if (meshes.get(p.id) !== mesh) return;
      mesh.geometry.dispose(); mesh.geometry = g;
      edges.geometry.dispose(); edges.geometry = eg;
      mat.transparent = ko; mat.opacity = ko ? 0.18 : 1; mat.needsUpdate = true;
      requestRender();
    }).catch(() => toast(`Couldn't load the CAD mesh for ${p.name}; showing its bounding box`));
  }
  mesh.visible = !p.hidden;
  mesh.position.set(p.pos.x, p.pos.y, p.pos.z);
  mesh.rotation.set(p.rot.x * DEG, p.rot.y * DEG, p.rot.z * DEG);
  partsGroup.add(mesh);
  meshes.set(p.id, mesh);
  return mesh;
}

function syncMesh(p) {
  const m = meshes.get(p.id); if (!m) return;
  m.position.set(p.pos.x, p.pos.y, p.pos.z);
  m.rotation.set(p.rot.x * DEG, p.rot.y * DEG, p.rot.z * DEG);
  m.visible = !p.hidden;
}

function rebuildParts() {
  for (const m of meshes.values()) { partsGroup.remove(m); disposeGeo(m.geometry); }
  meshes.clear();
  state.parts.forEach(buildPart);
  attachGizmo();
}

function rebuildAll() {
  buildHull(); rebuildParts(); evaluate(); renderHullForm(); renderEditor(); renderList();
  $('#layout-name').value = state.name || '';
}

// ---------- checks ----------
function partOBB(p, grow = 0) {
  const half = p.shape === 'cylinder'
    ? new THREE.Vector3(p.size.x / 2, p.size.y / 2, p.size.y / 2)
    : new THREE.Vector3(p.size.x / 2, p.size.y / 2, p.size.z / 2);
  half.addScalar(grow);
  const rot = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(p.rot.x * DEG, p.rot.y * DEG, p.rot.z * DEG)));
  return new OBB(new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z), half, rot);
}

// Points on the part's surface that must stay inside the hull.
function hullTestPoints(p) {
  const pts = [];
  if (p.shape === 'cylinder') {
    const r = p.size.y / 2;
    for (const sx of [-1, 1]) for (let i = 0; i < 24; i++) {
      const a = i / 24 * Math.PI * 2;
      pts.push(new THREE.Vector3(sx * p.size.x / 2, Math.cos(a) * r, Math.sin(a) * r));
    }
  } else {
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1])
      pts.push(new THREE.Vector3(sx * p.size.x / 2, sy * p.size.y / 2, sz * p.size.z / 2));
  }
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(p.rot.x * DEG, p.rot.y * DEG, p.rot.z * DEG)),
    new THREE.Vector3(1, 1, 1));
  return pts.map(v => v.applyMatrix4(m));
}

function insideHull(p) {
  const d = hullDims(), c = state.settings.clearance, eps = 0.01;
  for (const v of hullTestPoints(p)) {
    if (Math.abs(v.x) > d.L / 2 - c + eps) return false;
    if (state.hull.shape === 'cylinder') {
      if (Math.hypot(v.y, v.z) > d.R - c + eps) return false;
    } else {
      // rounded-rectangle cross-section, shrunk by the clearance
      const a = d.W / 2 - c + eps, b = d.H / 2 - c + eps, r = Math.max(0, d.r - c);
      const y = Math.abs(v.y), z = Math.abs(v.z);
      if (y > a || z > b) return false;
      if (y > a - r && z > b - r && Math.hypot(y - (a - r), z - (b - r)) > r) return false;
    }
  }
  return true;
}

function collides(a, b) {
  if (a.kind === 'keepout' && b.kind === 'keepout') return false;
  const g = state.settings.clearance / 2 - 0.01;
  return partOBB(a, g).intersectsOBB(partOBB(b, g));
}

function evaluate() {
  issues = new Map();
  const live = state.parts.filter(p => !p.hidden);
  for (const p of live) issues.set(p.id, { hits: new Set(), outside: p.kind !== 'keepout' && !insideHull(p) });
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
    if (collides(live[i], live[j])) { issues.get(live[i].id).hits.add(live[j].id); issues.get(live[j].id).hits.add(live[i].id); }
  }
  for (const [id, m] of meshes) {
    const is = issues.get(id), sel = id === selectedId;
    const bad = is && is.hits.size, out = is && is.outside;
    const em = m.material.emissive;
    if (bad) em.set(0x7a1010); else if (out) em.set(0x6a4200); else if (sel) em.set(0x0f3d3a); else em.set(0x000000);
    m.userData.edges.material.color.set(bad ? 0xff5050 : out ? 0xf5a623 : sel ? 0x4fd1c5 : 0x0d1418);
    m.userData.edges.material.opacity = (bad || out || sel) ? 1 : 0.6;
  }
  updateMarkers();
  renderStats();
  updateListFlags();
  requestRender();
}

// ---------- mass properties ----------
function massProps() {
  const h = state.hull, d = hullDims();
  let m = h.hullMass, mx = 0, my = 0, mz = 0, partVol = 0;
  for (const p of state.parts) {
    if (p.kind === 'keepout' || p.hidden) continue;
    m += p.mass; mx += p.mass * p.pos.x; my += p.mass * p.pos.y; mz += p.mass * p.pos.z;
    partVol += p.shape === 'cylinder' ? Math.PI * (p.size.y / 2) ** 2 * p.size.x : p.size.x * p.size.y * p.size.z;
  }
  const com = m > 0 ? { x: mx / m, y: my / m, z: mz / m } : { x: 0, y: 0, z: 0 };
  const Lo = d.L + 2 * (h.cap || 0);
  const outerVol = h.shape === 'cylinder' ? Math.PI * (d.R + h.wall) ** 2 * Lo : Lo * roundedRectArea(d.W / 2 + h.wall, d.H / 2 + h.wall, d.r > 0 ? d.r + h.wall : 0);
  const innerVol = h.shape === 'cylinder' ? Math.PI * d.R ** 2 * d.L : d.L * roundedRectArea(d.W / 2, d.H / 2, d.r);
  const rho = WATER[h.water] || 997;
  const buoyKg = outerVol * 1e-9 * rho;
  return { mass: m, com, outerVol, innerVol, partVol, buoyKg, net: buoyKg - m };
}

const comMarker = makeMarker(0xff9e64), cobMarker = makeMarker(0x7aa2f7);
markerGroup.add(comMarker, cobMarker);
function makeMarker(color) {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true });
  const s = new THREE.Mesh(new THREE.SphereGeometry(6, 20, 12), mat); s.renderOrder = 10; g.add(s);
  const lm = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.8 });
  for (const ax of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
    const v = new THREE.Vector3(...ax).multiplyScalar(18);
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([v.clone().negate(), v]), lm); l.renderOrder = 10; g.add(l);
  }
  return g;
}
function updateMarkers() {
  const mp = massProps();
  comMarker.position.set(mp.com.x, mp.com.y, mp.com.z);
  cobMarker.position.set(0, 0, 0);
  markerGroup.visible = view.markers;
}

// ---------- labels ----------
const labelHost = $('#labels');
const labelEls = new Map();
function updateLabels() {
  const w = host.clientWidth, h = host.clientHeight;
  const seen = new Set();
  const place = (key, text, pos, cls) => {
    let el = labelEls.get(key);
    if (!el) { el = document.createElement('div'); labelHost.appendChild(el); labelEls.set(key, el); }
    seen.add(key);
    const v = pos.clone().project(camera);
    const vis = v.z < 1 && v.z > -1;
    el.style.display = vis ? '' : 'none';
    if (!vis) return;
    el.textContent = text; el.className = cls;
    el.style.left = ((v.x + 1) / 2 * w) + 'px'; el.style.top = ((1 - v.y) / 2 * h) + 'px';
  };
  for (const p of state.parts) {
    if (p.hidden || (!view.labels && p.id !== selectedId)) continue;
    const is = issues.get(p.id);
    place(p.id, p.name, new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z), (p.id === selectedId ? 'sel' : '') + (is && (is.hits.size || is.outside) ? ' bad' : ''));
  }
  if (view.markers) {
    place('_com', 'CoM', comMarker.position, 'marker');
    place('_cob', 'CoB', cobMarker.position, 'marker');
    labelEls.get('_com').style.color = '#ff9e64'; labelEls.get('_cob').style.color = '#7aa2f7';
  }
  for (const [k, el] of labelEls) if (!seen.has(k)) { el.remove(); labelEls.delete(k); }
}

// ---------- render loop (on demand) ----------
let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderer.render(scene, camera); updateLabels(); });
}

function resize() {
  const w = host.clientWidth, h = host.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  persp.aspect = w / h; persp.updateProjectionMatrix();
  const half = ortho.userData.half || 400, a = w / h;
  ortho.left = -half * a; ortho.right = half * a; ortho.top = half; ortho.bottom = -half; ortho.updateProjectionMatrix();
  requestRender();
}
new ResizeObserver(resize).observe(host);

function useCamera(cam) {
  camera = cam; orbit.object = cam; gizmo.camera = cam;
}

let currentView = 'iso';
function setView(name) {
  currentView = name;
  $$('[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === name));
  fitView();
}
function fitView() {
  const d = hullDims(), h = state.hull;
  const span = Math.max(d.L + 2 * (h.cap || 0) + 120, d.W + 2 * h.wall, d.H + 2 * h.wall);
  const w = host.clientWidth || 800, ht = host.clientHeight || 600, a = w / ht;
  orbit.target.set(0, 0, 0);
  if (currentView === 'iso') {
    useCamera(persp);
    const dist = span / 2 / Math.tan(persp.fov * DEG / 2) / Math.min(1, a) * (narrow ? 0.95 : 1.15);
    persp.position.set(0.55, -0.75, 0.45).normalize().multiplyScalar(dist);
    persp.near = dist / 100; persp.far = dist * 20; persp.updateProjectionMatrix();
    orbit.enableRotate = true;
  } else {
    useCamera(ortho);
    const dist = span * 4;
    let viewW, viewH;
    if (currentView === 'top') { ortho.position.set(0, -dist * 1e-4, dist); viewW = d.L + 2 * (h.cap || 0) + 120; viewH = d.W + 2 * h.wall + 60; }
    if (currentView === 'side') { ortho.position.set(0, -dist, 0); viewW = d.L + 2 * (h.cap || 0) + 120; viewH = d.H + 2 * h.wall + 60; }
    if (currentView === 'front') { ortho.position.set(dist, 0, 0); viewW = d.W + 2 * h.wall + 60; viewH = d.H + 2 * h.wall + 60; }
    // leave room for the toolbar and stats overlays
    const half = Math.max(viewH / 2, viewW / 2 / a) * 1.35;
    ortho.userData.half = half; ortho.zoom = 1;
    orbit.enableRotate = false;
    resize();
  }
  camera.lookAt(0, 0, 0);
  orbit.update();
  requestRender();
}

// ---------- picking ----------
const ray = new THREE.Raycaster();
let downAt = null;
renderer.domElement.addEventListener('pointerdown', e => { downAt = { x: e.clientX, y: e.clientY }; });
renderer.domElement.addEventListener('pointerup', e => {
  if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6 || gizmo.dragging) return;
  if (gizmo.axis) return; // a click on the gizmo, not the scene
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), camera);
  const hits = ray.intersectObjects([...meshes.values()].filter(m => m.visible), false);
  // keep-outs are see-through, so prefer a solid part behind one
  const solid = hits.find(h => partById(h.object.userData.id)?.kind !== 'keepout');
  const hit = solid || hits[0];
  select(hit ? hit.object.userData.id : null);
});

function select(id) {
  selectedId = id;
  attachGizmo();
  evaluate();
  renderEditor();
  renderList();
  if (id) { $$('.tabs [data-tab]')[0].click(); $('#tab-parts').scrollTop = 0; }
}
function attachGizmo() {
  const p = selectedId && partById(selectedId);
  const m = p && meshes.get(p.id);
  if (m && !p.locked && !p.hidden) gizmo.attach(m); else gizmo.detach();
  applySnap();
  requestRender();
}
function applySnap() {
  const s = +state.settings.snap || 0;
  gizmo.setTranslationSnap(s > 0 ? s : null);
  gizmo.setRotationSnap(15 * DEG);
}

// ---------- part operations ----------
function addPart(kind) {
  const n = state.parts.length;
  const d = hullDims();
  const p = {
    id: newId(), name: kind === 'keepout' ? 'Keep-out' : `Part ${n + 1}`,
    shape: kind === 'cylinder' ? 'cylinder' : 'box', kind: kind === 'keepout' ? 'keepout' : 'part',
    size: kind === 'cylinder' ? { x: 80, y: 50, z: 50 } : { x: 60, y: 50, z: 40 },
    mass: kind === 'keepout' ? 0 : 0.1, color: kind === 'keepout' ? '#ef5b5b' : PALETTE[n % PALETTE.length],
    pos: { x: 0, y: 0, z: Math.min(d.H / 2 - 40, 40) }, rot: { x: 0, y: 0, z: 0 }, locked: false, hidden: false,
  };
  state.parts.push(p);
  buildPart(p);
  commit();
  select(p.id);
}
function duplicate(id) {
  const src = partById(id); if (!src) return;
  const p = structuredClone(src);
  p.id = newId(); p.name = src.name + ' copy'; p.locked = false;
  p.pos.y = r2(p.pos.y + Math.max(10, (src.shape === 'cylinder' ? src.size.y : src.size.y) + 5));
  state.parts.splice(state.parts.indexOf(src) + 1, 0, p);
  buildPart(p); commit(); select(p.id);
}
function removePart(id) {
  const i = state.parts.findIndex(p => p.id === id); if (i < 0) return;
  const m = meshes.get(id); if (m) { gizmo.detach(); partsGroup.remove(m); disposeGeo(m.geometry); meshes.delete(id); }
  state.parts.splice(i, 1);
  commit(); select(null);
}
function isValidAt(p) {
  if (p.kind !== 'keepout' && !insideHull(p)) return false;
  return !state.parts.some(o => o !== p && !o.hidden && collides(p, o));
}
// Drop a part into the lowest free spot in the hull, like settling it under gravity.
// Tries a grid of x/y positions, prefers low and central. Returns false (part unmoved) if nothing fits.
function autoPlace(p) {
  const d = hullDims(), c = state.settings.clearance, g = c / 2 - 0.01;
  const others = state.parts.filter(o => o !== p && !o.hidden && !(o.kind === 'keepout' && p.kind === 'keepout')).map(o => partOBB(o, g));
  const ok = () => (p.kind === 'keepout' || insideHull(p)) && !others.some(b => partOBB(p, g).intersectsOBB(b));
  const start = { ...p.pos };
  const xs = [0], ys = [0];
  for (let x = 20; x <= d.L / 2; x += 20) xs.push(x, -x);
  for (let y = 20; y <= d.W / 2; y += 20) ys.push(y, -y);
  let best = null;
  for (const x of xs) for (const y of ys) {
    p.pos.x = x; p.pos.y = y;
    let z = d.H / 2, found = false;
    for (; z >= -d.H / 2; z -= 4) { p.pos.z = z; if (ok()) { found = true; break; } }
    if (!found) continue;
    for (const step of [2, 0.5]) for (;;) { p.pos.z -= step; if (p.pos.z < -d.H / 2 || !ok()) { p.pos.z += step; break; } }
    const score = p.pos.z + Math.abs(x) * 0.15 + Math.abs(y) * 0.3;
    if (!best || score < best.score) best = { score, x, y, z: p.pos.z };
  }
  if (!best) { p.pos = start; return false; }
  p.pos = { x: best.x, y: best.y, z: r2(best.z) };
  return true;
}
// Slide a part along an axis until it touches the hull or another part.
function slide(id, axis, dir) {
  const p = partById(id); if (!p) return;
  const d = hullDims(), lim = { x: d.L / 2, y: d.W / 2, z: d.H / 2 }[axis] + 50;
  const start = p.pos[axis];
  if (!isValidAt(p)) {
    // start from the far side of the hull and come back until it fits
    let found = false;
    for (let v = -dir * lim; dir > 0 ? v <= lim : v >= -lim; v += dir * 1) {
      p.pos[axis] = v; if (isValidAt(p)) { found = true; break; }
    }
    if (!found) { p.pos[axis] = start; toast('No free spot along that line'); return; }
  }
  for (const step of [16, 4, 1, 0.25]) {
    while (Math.abs(p.pos[axis]) < lim) {
      p.pos[axis] += dir * step;
      if (!isValidAt(p)) { p.pos[axis] -= dir * step; break; }
    }
  }
  p.pos[axis] = r2(p.pos[axis]);
  syncMesh(p); evaluate(); commit(); renderEditor();
}
function rotate90(id, axis) {
  const p = partById(id); if (!p) return;
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(p.rot.x * DEG, p.rot.y * DEG, p.rot.z * DEG));
  const ax = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
  q.premultiply(new THREE.Quaternion().setFromAxisAngle(ax, Math.PI / 2));
  const e = new THREE.Euler().setFromQuaternion(q);
  const clean = v => { const d = Math.round(v / DEG * 100) / 100; return Math.abs(d) < 1e-6 ? 0 : d; };
  p.rot = { x: clean(e.x), y: clean(e.y), z: clean(e.z) };
  syncMesh(p); evaluate(); commit(); renderEditor();
}

// ---------- panel: editor ----------
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (key, label, val, step = 1) =>
  `<div><label>${label}</label><input type="number" data-k="${key}" value="${r2(val)}" step="${step}" inputmode="decimal"></div>`;

function renderEditor() {
  const ed = $('#editor');
  const p = selectedId && partById(selectedId);
  if (!p) { ed.innerHTML = ''; return; }
  const cyl = p.shape === 'cylinder';
  const snap = +state.settings.snap || 1;
  ed.innerHTML = `
    <div class="head">
      <input type="color" data-k="color" value="${esc(p.color)}" title="Colour">
      <input type="text" data-k="name" value="${esc(p.name)}" maxlength="60">
      <button class="close" data-act="deselect" aria-label="Close">×</button>
    </div>
    ${p.mesh ? `
    <p class="hint" style="margin:8px 0 0">CAD mesh${p.source ? ` (${esc(p.source)})` : ''}. Fit checks use its bounding box: ${fmt(p.size.x, 1)} × ${fmt(p.size.y, 1)} × ${fmt(p.size.z, 1)} mm.</p>
    <div class="grid two" style="margin-top:6px">
      <div><label>Type</label><select data-k="kind"><option value="part"${p.kind === 'part' ? ' selected' : ''}>Part</option><option value="keepout"${p.kind === 'keepout' ? ' selected' : ''}>Keep-out zone</option></select></div>
      ${p.kind === 'part' ? num('mass', 'Mass kg', p.mass, 0.01) : '<div></div>'}
    </div>
    <div class="row"><button class="btn small ghost" data-act="unmesh">Swap for a plain box (to resize it)</button></div>` : `
    <div class="grid two" style="margin-top:8px">
      <div><label>Shape</label><select data-k="shape"><option value="box"${!cyl ? ' selected' : ''}>Box</option><option value="cylinder"${cyl ? ' selected' : ''}>Cylinder</option></select></div>
      <div><label>Type</label><select data-k="kind"><option value="part"${p.kind === 'part' ? ' selected' : ''}>Part</option><option value="keepout"${p.kind === 'keepout' ? ' selected' : ''}>Keep-out zone</option></select></div>
    </div>
    <h3>Size (mm)${cyl ? ' · axis along local X' : ''}</h3>
    <div class="grid">
      ${cyl ? num('size.x', 'Length', p.size.x) + num('size.y', 'Diameter', p.size.y) + (p.kind === 'part' ? num('mass', 'Mass kg', p.mass, 0.01) : '<div></div>')
            : num('size.x', 'X length', p.size.x) + num('size.y', 'Y width', p.size.y) + num('size.z', 'Z height', p.size.z)}
    </div>
    ${!cyl && p.kind === 'part' ? `<div class="grid" style="margin-top:6px">${num('mass', 'Mass kg', p.mass, 0.01)}</div>` : ''}`}
    <h3>Position (mm, from hull centre)</h3>
    <div class="grid">${num('pos.x', 'X fwd', p.pos.x, snap)}${num('pos.y', 'Y port', p.pos.y, snap)}${num('pos.z', 'Z up', p.pos.z, snap)}</div>
    <h3>Rotation (°)</h3>
    <div class="grid">${num('rot.x', 'Roll X', p.rot.x, 15)}${num('rot.y', 'Pitch Y', p.rot.y, 15)}${num('rot.z', 'Yaw Z', p.rot.z, 15)}</div>
    <div class="row wrap" style="margin-top:8px">
      <button class="btn small" data-act="r90" data-ax="x">↻ 90° X</button>
      <button class="btn small" data-act="r90" data-ax="y">↻ 90° Y</button>
      <button class="btn small" data-act="r90" data-ax="z">↻ 90° Z</button>
    </div>
    <h3>Push until it touches</h3>
    <div class="row wrap">
      <button class="btn small" data-act="slide" data-ax="z" data-dir="-1">↓ Down</button>
      <button class="btn small" data-act="slide" data-ax="z" data-dir="1">↑ Up</button>
      <button class="btn small" data-act="slide" data-ax="x" data-dir="1">→ Fwd</button>
      <button class="btn small" data-act="slide" data-ax="x" data-dir="-1">← Aft</button>
      <button class="btn small" data-act="slide" data-ax="y" data-dir="1">Port</button>
      <button class="btn small" data-act="slide" data-ax="y" data-dir="-1">Stbd</button>
      <button class="btn small" data-act="center">Centre Y</button>
      <button class="btn small" data-act="auto">Auto-place</button>
    </div>
    <div class="row wrap" style="margin-top:10px">
      <button class="btn small" data-act="dup">Duplicate</button>
      <button class="btn small${p.locked ? ' on' : ''}" data-act="lock">${p.locked ? 'Locked' : 'Lock'}</button>
      <button class="btn small${p.hidden ? ' on' : ''}" data-act="hide">${p.hidden ? 'Hidden' : 'Hide'}</button>
      <button class="btn small danger" data-act="del">Delete</button>
    </div>
    <div class="issues"></div>`;
  renderEditorIssues();
}
function renderEditorIssues() {
  const el = $('#editor .issues'); const p = selectedId && partById(selectedId);
  if (!el || !p) return;
  const is = issues.get(p.id);
  const out = [];
  if (is?.outside) out.push(`<div class="warn">⚠ Pokes outside the hull (or inside the ${state.settings.clearance} mm clearance)</div>`);
  if (is?.hits.size) out.push(`<div class="bad">✕ Overlaps ${[...is.hits].map(id => esc(partById(id)?.name)).join(', ')}</div>`);
  if (!out.length && !p.hidden) out.push('<div class="good">✓ Fits, no overlaps</div>');
  el.innerHTML = out.join('');
}
function syncEditorTransform() {
  const p = selectedId && partById(selectedId); if (!p) return;
  for (const k of ['pos.x', 'pos.y', 'pos.z', 'rot.x', 'rot.y', 'rot.z']) {
    const el = $(`#editor [data-k="${k}"]`); if (el && document.activeElement !== el) el.value = r2(getPath(p, k));
  }
  renderEditorIssues();
}
const getPath = (o, k) => k.split('.').reduce((a, b) => a[b], o);
function setPath(o, k, v) { const ks = k.split('.'); const last = ks.pop(); ks.reduce((a, b) => a[b], o)[last] = v; }

$('#editor').addEventListener('input', e => {
  const k = e.target.dataset.k; const p = partById(selectedId);
  if (!k || !p) return;
  if (e.target.type === 'number') {
    const v = parseFloat(e.target.value); if (!isFinite(v)) return;
    if (k.startsWith('size.') && v <= 0) return;
    setPath(p, k, v);
    if (k === 'size.y' && p.shape === 'cylinder') p.size.z = v;
  } else if (k === 'name' || k === 'color') setPath(p, k, e.target.value);
  else return;
  if (k.startsWith('size.') || k === 'color') { buildPart(p); attachGizmo(); } else syncMesh(p);
  if (k === 'name') renderList();
  evaluate();
  if (k === 'color') renderList();
});
$('#editor').addEventListener('change', e => {
  const k = e.target.dataset.k; const p = partById(selectedId);
  if (!k || !p) return;
  if (k === 'shape' || k === 'kind') {
    p[k] = e.target.value;
    if (k === 'shape' && p.shape === 'cylinder') p.size.z = p.size.y;
    if (k === 'kind' && p.kind === 'keepout') { p.mass = 0; p.color = '#ef5b5b'; }
    buildPart(p); attachGizmo(); evaluate(); renderEditor(); renderList();
  }
  commit();
});
$('#editor').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const id = selectedId, p = partById(id); if (!p && b.dataset.act !== 'deselect') return;
  switch (b.dataset.act) {
    case 'deselect': select(null); break;
    case 'r90': rotate90(id, b.dataset.ax); break;
    case 'slide': slide(id, b.dataset.ax, +b.dataset.dir); break;
    case 'center': p.pos.y = 0; syncMesh(p); evaluate(); commit(); renderEditor(); break;
    case 'auto': if (autoPlace(p)) { syncMesh(p); evaluate(); commit(); renderEditor(); } else toast('No free spot big enough'); break;
    case 'unmesh': delete p.mesh; buildPart(p); attachGizmo(); evaluate(); commit(); renderEditor(); break;
    case 'dup': duplicate(id); break;
    case 'lock': p.locked = !p.locked; attachGizmo(); commit(); renderEditor(); renderList(); break;
    case 'hide': p.hidden = !p.hidden; syncMesh(p); attachGizmo(); evaluate(); commit(); renderEditor(); renderList(); break;
    case 'del': removePart(id); break;
  }
});

// ---------- panel: list ----------
function renderList() {
  const ul = $('#part-list');
  const fmtSize = p => p.shape === 'cylinder' ? `⌀${fmt(p.size.y)}×${fmt(p.size.x)}` : `${fmt(p.size.x)}×${fmt(p.size.y)}×${fmt(p.size.z)}`;
  ul.innerHTML = state.parts.map(p => `
    <li data-id="${p.id}" class="${p.id === selectedId ? 'sel' : ''}${p.hidden ? ' hid' : ''}">
      <span class="sw${p.kind === 'keepout' ? ' ko' : ''}" style="background:${esc(p.color)}"></span>
      <span class="nm">${p.locked ? '🔒 ' : ''}${esc(p.name)}<span class="flag" data-flag="${p.id}"></span></span>
      <span class="meta">${fmtSize(p)}${p.kind === 'part' ? `<br>${p.mass.toFixed(2)} kg` : '<br>keep-out'}</span>
    </li>`).join('') || '<p class="hint">No parts yet. Add one above or paste a list.</p>';
  updateListFlags();
}
function updateListFlags() {
  for (const el of $$('#part-list [data-flag]')) {
    const is = issues.get(el.dataset.flag);
    el.className = 'flag' + (is && !is.hits.size && is.outside ? ' warn' : '');
    el.textContent = is ? (is.hits.size ? ' ✕' : is.outside ? ' ⚠' : '') : '';
  }
}
$('#part-list').addEventListener('click', e => {
  const li = e.target.closest('li[data-id]'); if (li) select(li.dataset.id === selectedId ? null : li.dataset.id);
});

// ---------- panel: hull ----------
function renderHullForm() {
  const h = state.hull, s = state.settings, cyl = h.shape === 'cylinder';
  const f = (key, label, val, step = 1, unit = '') =>
    `<div><label>${label}${unit ? ` (${unit})` : ''}</label><input type="number" data-h="${key}" value="${val}" step="${step}" inputmode="decimal"></div>`;
  $('#hull-form').innerHTML = `
    <div class="field"><label>Hull shape</label>
      <select data-h="shape"><option value="box"${!cyl ? ' selected' : ''}>Box (rounded corners optional)</option><option value="cylinder"${cyl ? ' selected' : ''}>Cylinder tube (axis = X)</option></select></div>
    <h3>Internal space</h3>
    <div class="grid">
      ${f('length', 'Length', h.length, 5, 'mm')}
      ${cyl ? f('diameter', 'Inner ⌀', h.diameter, 1, 'mm') : f('width', 'Width Y', h.width, 5, 'mm') + f('height', 'Height Z', h.height, 5, 'mm') + f('radius', 'Corner radius', h.radius, 1, 'mm')}
    </div>
    <h3>Shell</h3>
    <div class="grid">
      ${f('wall', 'Wall', h.wall, 0.5, 'mm')}
      ${f('cap', 'End cap', h.cap, 1, 'mm')}
      ${f('hullMass', 'Hull mass', h.hullMass, 0.1, 'kg')}
    </div>
    <div class="field"><label>Water</label>
      <select data-h="water"><option value="fresh"${h.water === 'fresh' ? ' selected' : ''}>Fresh (997 kg/m³)</option><option value="salt"${h.water === 'salt' ? ' selected' : ''}>Salt (1025 kg/m³)</option></select></div>
    <h3>Placement rules</h3>
    <div class="grid two">
      <div><label>Min clearance (mm)</label><input type="number" data-s="clearance" value="${s.clearance}" step="0.5" min="0" inputmode="decimal"></div>
      <div><label>Move snap (mm, 0 = off)</label><input type="number" data-s="snap" value="${s.snap}" step="1" min="0" inputmode="decimal"></div>
    </div>
    <p class="hint">Length, width, height and diameter are the space inside. Wall and end caps only count toward displacement. Hull mass is the empty enclosure (tube, caps, flanges, penetrators). Its centre of mass is taken to be the hull centre, which is also the centre of buoyancy.</p>
    <div id="hull-calc"></div>`;
  renderHullCalc();
}
function renderHullCalc() {
  const el = $('#hull-calc'); if (!el) return;
  const mp = massProps();
  el.innerHTML = `<h3>Numbers</h3><p class="hint" style="font-family:var(--mono);line-height:1.7">
    Internal volume: ${(mp.innerVol / 1e6).toFixed(2)} L<br>
    Displaced volume: ${(mp.outerVol / 1e6).toFixed(2)} L → ${mp.buoyKg.toFixed(2)} kg of lift<br>
    Parts volume: ${(mp.partVol / 1e6).toFixed(2)} L (${(mp.partVol / mp.innerVol * 100).toFixed(0)}% packed)<br>
    Total mass: ${mp.mass.toFixed(2)} kg → net ${mp.net >= 0 ? '+' : ''}${mp.net.toFixed(2)} kg ${mp.net >= 0 ? '(floats)' : '(sinks)'}</p>`;
}
$('#hull-form').addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.h && t.type === 'number') {
    const v = parseFloat(t.value); if (!isFinite(v) || v < 0) return;
    if (['length', 'diameter', 'width', 'height'].includes(t.dataset.h) && v < 10) return;
    state.hull[t.dataset.h] = v;
    buildHull(); evaluate(); renderHullCalc();
  } else if (t.dataset.s) {
    const v = parseFloat(t.value); if (!isFinite(v) || v < 0) return;
    state.settings[t.dataset.s] = v; applySnap(); evaluate(); renderEditorIssues();
  }
});
$('#hull-form').addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.h === 'shape' || t.dataset.h === 'water') {
    state.hull[t.dataset.h] = t.value;
    if (t.dataset.h === 'shape' && t.value === 'box' && !state.hull.width) { state.hull.width = state.hull.diameter; state.hull.height = state.hull.diameter; }
    buildHull(); evaluate(); renderHullForm(); fitView();
  }
  commit();
});

// ---------- stats ----------
function renderStats() {
  const mp = massProps();
  let hits = 0, out = 0;
  for (const is of issues.values()) { hits += is.hits.size; if (is.outside) out++; }
  hits /= 2;
  const dz = mp.com.z;
  const parts = state.parts.filter(p => p.kind === 'part' && !p.hidden).length;
  const unset = state.parts.filter(p => p.kind === 'part' && !p.hidden && !p.mass).length;
  const stat = (k, v, cls = '') => `<div class="stat"><span class="k">${k}</span><span class="v ${cls}">${v}</span></div>`;
  $('#stats').innerHTML =
    stat('Mass', `${mp.mass.toFixed(2)} kg${unset ? ` · ${unset} unset` : ''}`, unset ? 'warn' : '') +
    stat('Net buoyancy', `${mp.net >= 0 ? '+' : ''}${mp.net.toFixed(2)} kg`, Math.abs(mp.net) < 0.25 ? 'good' : '') +
    stat('CoM vs CoB (x y z)', `${fmt(mp.com.x)} ${fmt(mp.com.y)} ${fmt(dz)} mm`, dz < -2 ? 'good' : dz > 2 ? 'bad' : 'warn') +
    stat('Packed', `${(mp.partVol / mp.innerVol * 100).toFixed(0)}% · ${parts} parts`) +
    stat('Fit', hits || out ? `${hits ? hits + ' overlap' + (hits > 1 ? 's' : '') : ''}${hits && out ? ' · ' : ''}${out ? out + ' outside' : ''}` : 'All clear', hits ? 'bad' : out ? 'warn' : 'good');
  renderHullCalc();
}

// ---------- paste / CSV import ----------
function parseList(text) {
  const out = [];
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const cells = line.split(/\t|,|;/).map(c => c.trim()).filter(c => c !== '');
    if (!cells.length) continue;
    if (/^name$/i.test(cells[0])) continue; // header row
    let name = cells[0], dims = null, cyl = false, nums = [];
    for (const c of cells.slice(1)) {
      const m = c.match(/^(⌀|ø|d|dia)?\s*([\d.]+)\s*(?:mm)?\s*[x×*]\s*([\d.]+)\s*(?:mm)?\s*(?:[x×*]\s*([\d.]+))?/i);
      if (m && !dims) {
        if (m[1] || !m[4]) { cyl = true; dims = [parseFloat(m[3]), parseFloat(m[2])]; } // ⌀D x L
        else dims = [parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])];
        continue;
      }
      const n = parseFloat(c.replace(/kg|g|mm/gi, ''));
      if (isFinite(n)) nums.push(/\d\s*g$/i.test(c) && !/kg/i.test(c) ? n / 1000 : n);
    }
    if (!dims && nums.length >= 3) dims = nums.splice(0, 3);
    if (!dims) continue;
    const mass = nums.length ? nums[0] : 0;
    out.push({ name, cyl, dims, mass });
  }
  return out;
}
function importList(items, replace) {
  if (replace) state.parts = [];
  const d = hullDims();
  let x = -d.L / 2, unplaced = 0;
  items.forEach((it, i) => {
    const n = state.parts.length;
    const p = {
      id: newId(), name: it.name, shape: it.cyl ? 'cylinder' : 'box', kind: 'part',
      size: it.cyl ? { x: it.dims[0], y: it.dims[1], z: it.dims[1] } : { x: it.dims[0], y: it.dims[1], z: it.dims[2] },
      mass: it.mass, color: PALETTE[n % PALETTE.length], pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0 }, locked: false, hidden: false,
    };
    state.parts.push(p);
    // biggest-first would pack better, but keeping list order keeps it predictable
    if (!autoPlace(p)) {
      // no room: park it beside the hull (flagged as outside) so it's easy to grab
      p.pos = { x: r2(x + p.size.x / 2), y: -(d.W / 2 + state.hull.wall + 40 + Math.max(p.size.y, p.size.z) / 2), z: 0 };
      x += p.size.x + 20; unplaced++;
    }
  });
  rebuildParts(); evaluate(); renderList(); commit();
  toast(`Added ${items.length} part${items.length === 1 ? '' : 's'}` + (unplaced ? `. ${unplaced} didn't fit and are parked beside the hull` : ''));
}
$('#paste-open').onclick = () => { $('#paste-box').hidden = !$('#paste-box').hidden; };
$('#paste-add').onclick = () => {
  const items = parseList($('#paste-text').value);
  if (!items.length) return toast("Couldn't read any parts. Use: name, L x W x H, mass");
  importList(items, $('#paste-replace').checked);
  $('#paste-text').value = ''; $('#paste-box').hidden = true;
};

// ---------- share links (layout packed into the URL hash) ----------
const b64url = bytes => { let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
async function encodeLayout(obj) {
  const stream = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return b64url(new Uint8Array(await new Response(stream).arrayBuffer()));
}
async function decodeLayout(str) {
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const stream = new Blob([Uint8Array.from(bin, c => c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return JSON.parse(await new Response(stream).text());
}
$('#share').onclick = async () => {
  const url = `${location.origin}${location.pathname}#l=${await encodeLayout(state)}`;
  const title = state.name && state.name !== 'Starter' && state.name !== 'Untitled' ? state.name : 'Hull layout';
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ title, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('Link copied'); }
  catch { $('#share-msg').innerHTML = `Copy this link: <input type="text" readonly value="${esc(url)}" onclick="this.select()">`; }
};
async function loadFromHash() {
  const m = location.hash.match(/^#l=([\w-]+)/);
  if (!m) return;
  try { replaceState(await decodeLayout(m[1])); toast('Opened shared layout'); }
  catch { toast("That share link is damaged or incomplete"); }
  history.replaceState(null, '', location.pathname + location.search); // local autosave has it now
}
addEventListener('hashchange', loadFromHash);

// ---------- layouts (server, only when running on Cam-PC) ----------
let hasServer = false;
async function probeServer() {
  try { const r = await fetch('api/layouts'); hasServer = r.ok && (r.headers.get('content-type') || '').includes('json'); } catch { hasServer = false; }
  $('#server-box').hidden = !hasServer;
  if (hasServer) refreshLayouts();
}
async function api(method, path, body) {
  const r = await fetch('api/layouts' + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}
async function refreshLayouts() {
  try {
    const list = await api('GET', '');
    $('#layout-list').innerHTML = list.map(l => `
      <li><span class="nm">${esc(l.name)}</span><span class="t">${new Date(l.modified * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
      <button class="btn small" data-load="${esc(l.name)}">Open</button><button class="btn small ghost danger" data-del="${esc(l.name)}" aria-label="Delete">✕</button></li>`).join('')
      || '<li class="hint">Nothing saved yet.</li>';
  } catch (e) { $('#layout-list').innerHTML = `<li class="hint">Couldn't reach the server: ${esc(e.message)}</li>`; }
}
async function loadLayout(name) {
  try { replaceState(await api('GET', '/' + encodeURIComponent(name))); toast(`Opened “${name}”`); }
  catch (e) { toast(`Couldn't open ${name}: ${e.message}`); }
}
$('#save').onclick = async () => {
  const name = $('#layout-name').value.trim();
  if (!name) return toast('Give the layout a name first');
  state.name = name; commit();
  try {
    await api('PUT', '/' + encodeURIComponent(name), state);
    $('#save-msg').innerHTML = `Saved. Link: <code>${esc(location.origin + location.pathname)}?layout=${esc(encodeURIComponent(name))}</code>`;
    refreshLayouts();
  } catch (e) { toast('Save failed: ' + e.message); }
};
$('#layout-list').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.load) loadLayout(b.dataset.load);
  if (b.dataset.del && confirm(`Delete “${b.dataset.del}” from Cam-PC?`)) { await api('DELETE', '/' + encodeURIComponent(b.dataset.del)); refreshLayouts(); }
});

function download(name, blob) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const fileBase = () => (state.name || 'layout').replace(/[^\w.-]+/g, '_');
$('#export-json').onclick = () => download(fileBase() + '.json', new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' }));
$('#export-csv').onclick = () => {
  const rows = [['name', 'type', 'shape', 'x_len_mm', 'y_mm', 'z_mm', 'mass_kg', 'pos_x', 'pos_y', 'pos_z', 'roll', 'pitch', 'yaw']];
  for (const p of state.parts) rows.push([p.name, p.kind, p.shape, p.size.x, p.size.y, p.size.z, p.mass, p.pos.x, p.pos.y, p.pos.z, p.rot.x, p.rot.y, p.rot.z]);
  download(fileBase() + '-parts.csv', new Blob([rows.map(r => r.map(v => /[",]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v).join(',')).join('\n')], { type: 'text/csv' }));
};
$('#import-json').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try { replaceState(JSON.parse(await f.text())); toast('Imported ' + f.name); } catch { toast("That file isn't a layout"); }
  e.target.value = '';
};
$('#shot').onclick = () => { renderer.render(scene, camera); renderer.domElement.toBlob(b => download(fileBase() + '.png', b)); };
async function fetchDefault() {
  const r = await fetch(DEFAULT_LAYOUT);
  if (!r.ok) throw new Error(r.status);
  return r.json();
}
$('#reset-starter').onclick = async () => {
  if (!confirm('Replace the current layout with the Venus CAD layout? (Undo still works.)')) return;
  try { replaceState(await fetchDefault()); } catch { toast("Couldn't load the CAD layout"); }
};
$('#reset-empty').onclick = () => { if (confirm('Remove every part? (Undo still works.)')) { const s = structuredClone(state); s.parts = []; replaceState(s); } };

// ---------- toolbar / tabs / keys ----------
$$('[data-mode]').forEach(b => b.onclick = () => setMode(b.dataset.mode));
function setMode(m) { gizmo.setMode(m); $$('[data-mode]').forEach(x => x.classList.toggle('on', x.dataset.mode === m)); requestRender(); }
$$('[data-view]').forEach(b => b.onclick = () => setView(b.dataset.view));
$$('[data-toggle]').forEach(b => b.onclick = () => {
  const k = b.dataset.toggle; view[k] = !view[k]; b.classList.toggle('on', view[k]);
  hullGroup.visible = view.hull; markerGroup.visible = view.markers; requestRender();
});
$('#fit').onclick = fitView;
$('#undo').onclick = undo; $('#redo').onclick = redo;
$$('[data-add]').forEach(b => b.onclick = () => addPart(b.dataset.add));
$$('.tabs [data-tab]').forEach(b => b.onclick = () => {
  $$('.tabs [data-tab]').forEach(x => x.classList.toggle('on', x === b));
  $$('.tab').forEach(t => t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab));
  if (b.dataset.tab === 'layouts' && hasServer) refreshLayouts();
});

addEventListener('keydown', e => {
  if (e.target.closest('input, textarea, select')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); if (selectedId) duplicate(selectedId); return; }
  if (mod) return;
  const p = selectedId && partById(selectedId);
  const step = +state.settings.snap || 1;
  const nudge = { ArrowUp: ['x', 1], ArrowDown: ['x', -1], ArrowLeft: ['y', 1], ArrowRight: ['y', -1], PageUp: ['z', 1], PageDown: ['z', -1] }[e.key];
  if (nudge && p && !p.locked) {
    e.preventDefault(); p.pos[nudge[0]] = r2(p.pos[nudge[0]] + nudge[1] * step); syncMesh(p); evaluate(); syncEditorTransform(); commit(); return;
  }
  switch (e.key.toLowerCase()) {
    case 'w': setMode('translate'); break;
    case 'e': setMode('rotate'); break;
    case 'f': fitView(); break;
    case 'escape': select(null); break;
    case 'delete': case 'backspace': if (p) removePart(p.id); break;
  }
});

let toastTimer;
function toast(msg) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; el.style.opacity = 1;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.style.opacity = 0; }, 2600);
}

// ---------- boot ----------
$('[data-toggle=labels]').classList.toggle('on', view.labels);
rebuildAll();
updateUndoButtons();
setView('iso');
const wanted = new URLSearchParams(location.search).get('layout');
if (wanted) loadLayout(wanted);
else if (location.hash.startsWith('#l=')) loadFromHash();
else if (!local) fetchDefault().then(s => replaceState(s, false)).catch(() => toast("Couldn't load the CAD layout; showing placeholders"));
probeServer();
window.__hp = { get state() { return state; }, select, setView, evaluate, issues: () => issues };
