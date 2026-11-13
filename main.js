// main.js — rendering + interaction only. Every number shown is recomputed with ./src/core.mjs,
// the same module node runs, and diffed against data/reference.json baked by tools/gen-sample.mjs.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { auditRelative, repairConvexity, bboxDiagonal } from './src/core.mjs';

const view = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(view.clientWidth, view.clientHeight);
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e1116);
const camera = new THREE.PerspectiveCamera(45, view.clientWidth / view.clientHeight, 0.01, 100);
camera.position.set(3.2, 2.6, 4.4);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1b2430, 0.9));
const key = new THREE.DirectionalLight(0xffffff, 1.5);
key.position.set(4, 6, 5);
scene.add(key);
const rim = new THREE.DirectionalLight(0x88aaff, 0.7);
rim.position.set(-5, -2, -4);
scene.add(rim);
const grid = new THREE.GridHelper(8, 16, 0x2a3546, 0x1a222c);
grid.position.y = -1.9;
scene.add(grid);

addEventListener('resize', () => {
  renderer.setSize(view.clientWidth, view.clientHeight);
  camera.aspect = view.clientWidth / view.clientHeight;
  camera.updateProjectionMatrix();
});

const state = { index: [], reference: null, current: null, show: { base: false, punctured: true, repaired: true }, groups: {} };

function geometry(mesh) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(mesh.vertices.flat(), 3));
  g.setIndex(mesh.faces.flat());
  g.computeVertexNormals();
  return g;
}

function build(mesh, color, wireColor) {
  const group = new THREE.Group();
  const g = geometry(mesh);
  const solid = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, flatShading: true, metalness: 0.15, roughness: 0.55 }));
  group.add(solid);
  const wire = new THREE.LineSegments(new THREE.WireframeGeometry(g), new THREE.LineBasicMaterial({ color: wireColor, transparent: true, opacity: 0.35 }));
  group.add(wire);
  return group;
}

function clearScene() {
  for (const k of Object.keys(state.groups)) {
    scene.remove(state.groups[k]);
    state.groups[k].traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
  }
  state.groups = {};
}

function frame(mesh) {
  const d = bboxDiagonal(mesh) || 1;
  camera.position.set(1.5 * d, 1.2 * d, 2.1 * d);
  controls.target.set(0, 0, 0);
  controls.update();
}

function row(label, value, cls) {
  return `<div><span class="lbl">${label}</span><span class="num ${cls || ''}">${value}</span></div>`;
}

async function select(name) {
  const rec = await (await fetch(`./data/${name}.json`)).json();
  state.current = rec;
  clearScene();
  const base = { vertices: rec.base.vertices, faces: rec.base.faces };
  const punctured = { vertices: rec.punctured.vertices, faces: rec.punctured.faces };
  const repair = repairConvexity(punctured, { epsRel: 1e-9 });
  const repaired = { vertices: repair.vertices, faces: punctured.faces };

  state.groups.base = build(base, 0x3f6f4f, 0x8ef0b6);
  state.groups.punctured = build(punctured, 0x8f3b3b, 0xffb0b0);
  state.groups.repaired = build(repaired, 0x2f5f9f, 0xa8ccff);
  for (const k of ['base', 'punctured', 'repaired']) {
    state.groups[k].visible = state.show[k === 'base' ? 'base' : k === 'punctured' ? 'punctured' : 'repaired'];
    scene.add(state.groups[k]);
  }
  frame(base);

  const ref = state.reference.meshes.find((m) => m.name === name);
  const before = auditRelative(punctured, 1e-9);
  const after = auditRelative(repaired, 1e-9);
  const same =
    before.violationCount === ref.beforeViolations &&
    after.violationCount === (ref.repairedStatus === 'converged' ? 0 : ref.repairedResidual) &&
    repair.status === ref.repairedStatus;

  document.getElementById('hud').innerHTML =
    row('violations before', before.violationCount) +
    row('violations after', after.violationCount) +
    row('status', repair.status) +
    row('iterations', repair.iterations) +
    row('max L&infin; shift', repair.maxIterShift.toExponential(4)) +
    row('bbox diagonal', bboxDiagonal(punctured).toFixed(4));
  document.getElementById('ref').innerHTML =
    row('before (node)', ref.beforeViolations) +
    row('after (node)', ref.repairedStatus === 'converged' ? 0 : ref.repairedResidual) +
    row('status (node)', ref.repairedStatus) +
    row('iterations (node)', ref.repairedIterations);
  document.getElementById('verdict').innerHTML = same
    ? '<div class="ok">MATCHES node-baked reference</div>'
    : '<div class="bad">MISMATCH vs node-baked reference</div>';
  document.querySelectorAll('#meshes button').forEach((b) => b.classList.toggle('on', b.dataset.name === name));
}

async function boot() {
  state.index = await (await fetch('./data/index.json')).json();
  state.reference = await (await fetch('./data/reference.json')).json();
  const holder = document.getElementById('meshes');
  for (const m of state.index.meshes) {
    const b = document.createElement('button');
    b.textContent = m.name;
    b.dataset.name = m.name;
    b.onclick = () => select(m.name);
    holder.appendChild(b);
  }
  for (const [id, k] of [['bBase', 'base'], ['bPunct', 'punctured'], ['bRepaired', 'repaired']]) {
    document.getElementById(id).onclick = (e) => {
      state.show[k] = !state.show[k];
      e.target.classList.toggle('on', state.show[k]);
      if (state.groups[k]) state.groups[k].visible = state.show[k];
    };
  }
  await select(state.index.meshes[0].name);
  if (state.index.meshes.some((m) => m.name === 'bipyramid12-dent')) await select('bipyramid12-dent');
  if (state.index.meshes.some((m) => m.name === 'cone16-dent')) await select('cone16-dent');
  await select(state.index.meshes[0].name);
}

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
boot().catch((e) => {
  document.getElementById('hud').innerHTML = '<div class="bad">' + String(e) + '</div>';
});
