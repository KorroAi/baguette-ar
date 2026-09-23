import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createStroke, disposeObject, shared } from './brushes.js';
import { SHAPES } from './shapes.js';

// ---------- Réglages ----------
const BRUSHES = [
  { id: 'neon', label: 'Néon' },
  { id: 'peinture', label: 'Peinture' },
  { id: 'ruban', label: 'Ruban' },
  { id: 'pointilles', label: 'Pointillés' },
  { id: 'etincelles', label: 'Étincelles' },
  { id: 'perles', label: 'Perles' },
];
const COLORS = ['rainbow', '#ffffff', '#ff2e88', '#ff1744', '#ff7a00', '#ffe600', '#39ff14', '#00e5ff', '#2979ff', '#b14cff'];

const state = {
  brush: 'neon',
  color: '#ff2e88',
  rainbow: false,
  tool: 'libre',
  size: 6, // rayon en mm
  distance: 25, // cm devant le téléphone
  shapeSize: 25, // cm
};
const STORAGE_KEY = 'baguette-ar-settings';
try {
  Object.assign(state, JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
} catch { /* stockage indisponible : réglages par défaut */ }
function saveSettings() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignoré */ }
}

// ---------- Scène ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const PREVIEW_BG = new THREE.Color(0x0b0b12);
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 100);
camera.position.set(0, 0, 0.8);

const controls = new OrbitControls(camera, renderer.domElement);
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };
controls.enableDamping = true;
controls.enabled = false;

const grid = new THREE.GridHelper(4, 40, 0x3a3a55, 0x1c1c2a);
grid.position.y = -0.5;
grid.visible = false;
scene.add(grid);

const strokesRoot = new THREE.Group();
scene.add(strokesRoot);

// Curseur : bout de la baguette
const cursorMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false });
const cursor = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), cursorMat);
cursor.renderOrder = 10;
cursor.visible = false;
scene.add(cursor);

// Aperçu fantôme de la forme sélectionnée
const ghostMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthTest: false });
const ghost = new THREE.Line(new THREE.BufferGeometry(), ghostMat);
ghost.matrixAutoUpdate = false;
ghost.renderOrder = 9;
ghost.visible = false;
scene.add(ghost);

// ---------- Traits ----------
const undoStack = [];
let gesture = null; // { group, stroke, last }

function newStroke(s0 = 0) {
  return createStroke(state.brush, {
    color: state.color,
    rainbow: state.rainbow,
    radius: state.size / 1000,
    s0,
  });
}

function beginGesture() {
  const group = new THREE.Group();
  strokesRoot.add(group);
  undoStack.push(group);
  const stroke = newStroke();
  group.add(stroke.object);
  gesture = { group, stroke, last: null, count: 0 };
}

function addPoint(p, fwd) {
  if (!gesture) return;
  if (gesture.last && gesture.last.distanceTo(p) < 0.002) return;
  if (gesture.stroke.full) {
    // trait trop long : on enchaîne sur un nouveau segment dans le même geste
    const next = newStroke(gesture.stroke.s);
    gesture.group.add(next.object);
    next.add(gesture.last, fwd);
    gesture.stroke = next;
  }
  gesture.stroke.add(p, fwd);
  gesture.last = (gesture.last || new THREE.Vector3()).copy(p);
  gesture.count++;
}

function endGesture() {
  if (!gesture) return;
  const needsLine = !['etincelles', 'perles'].includes(state.brush);
  if (gesture.count < (needsLine ? 2 : 1)) {
    strokesRoot.remove(gesture.group);
    undoStack.pop();
    disposeObject(gesture.group);
  }
  gesture = null;
}

function undo() {
  const g = undoStack.pop();
  if (!g) return;
  strokesRoot.remove(g);
  disposeObject(g);
}

function clearAll() {
  while (undoStack.length) undo();
}

// ---------- Pose du téléphone ----------
const pose = {
  pos: new THREE.Vector3(), fwd: new THREE.Vector3(),
  right: new THREE.Vector3(), up: new THREE.Vector3(),
};
const tip = new THREE.Vector3();
const smoothTip = new THREE.Vector3();
const _m = new THREE.Matrix4();
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

let mode = 'home'; // 'home' | 'preview' | 'ar'
let pressing = false;

function readPose(frame) {
  if (mode === 'ar') {
    if (!frame) return false;
    const vp = frame.getViewerPose(renderer.xr.getReferenceSpace());
    if (!vp) return false;
    _m.fromArray(vp.transform.matrix);
  } else {
    camera.updateMatrixWorld();
    _m.copy(camera.matrixWorld);
  }
  pose.pos.setFromMatrixPosition(_m);
  pose.right.set(1, 0, 0).transformDirection(_m);
  pose.up.set(0, 1, 0).transformDirection(_m);

  if (mode === 'ar') {
    pose.fwd.set(0, 0, -1).transformDirection(_m);
    tip.copy(pose.pos).addScaledVector(pose.fwd, state.distance / 100);
  } else {
    raycaster.setFromCamera(mouse, camera);
    pose.fwd.copy(raycaster.ray.direction);
    tip.copy(pose.pos).addScaledVector(pose.fwd, camera.position.distanceTo(controls.target));
  }
  return true;
}

// ---------- Formes ----------
function shapeById(id) { return SHAPES.find((s) => s.id === id); }

function placeShape() {
  const shape = shapeById(state.tool);
  if (!shape) return;
  const S = state.shapeSize / 100;
  const w = new THREE.Vector3();
  beginGesture();
  for (const [x, y, z] of shape.points()) {
    w.copy(tip)
      .addScaledVector(pose.right, x * S)
      .addScaledVector(pose.up, y * S)
      .addScaledVector(pose.fwd, z * S);
    addPoint(w, pose.fwd);
  }
  endGesture();
  flashHint(`${shape.label} posé !`);
}

function refreshGhost() {
  const shape = shapeById(state.tool);
  if (!shape) { ghost.visible = false; return; }
  const pts = shape.points().map(([x, y, z]) => new THREE.Vector3(x, y, z));
  ghost.geometry.dispose();
  ghost.geometry = new THREE.BufferGeometry().setFromPoints(pts);
}

// ---------- Entrées ----------
function onPress() {
  if (mode === 'home') return;
  if (state.tool === 'libre') {
    pressing = true;
    smoothTip.copy(tip);
    beginGesture();
    addPoint(smoothTip, pose.fwd);
    fadeHint();
  } else {
    placeShape();
  }
}

function onRelease() {
  if (!pressing) return;
  pressing = false;
  endGesture();
}

// Aperçu sur ordinateur : clic gauche = dessiner, clic droit = tourner
const activePointers = new Set();
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (mode !== 'preview') return;
  activePointers.add(e.pointerId);
  updateMouse(e);
  if (activePointers.size > 1) { onRelease(); return; } // deux doigts = navigation
  if (e.button === 0) { readPose(null); onPress(); }
});
renderer.domElement.addEventListener('pointermove', updateMouse);
window.addEventListener('pointerup', (e) => { activePointers.delete(e.pointerId); if (mode === 'preview') onRelease(); });
window.addEventListener('pointercancel', (e) => { activePointers.delete(e.pointerId); if (mode === 'preview') onRelease(); });
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

function updateMouse(e) {
  mouse.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
}

// ---------- Boucle de rendu ----------
renderer.setAnimationLoop((time, frame) => {
  shared.uTime.value = time / 1000;
  if (mode !== 'home' && readPose(frame)) {
    if (pressing) {
      smoothTip.lerp(tip, 0.55);
      addPoint(smoothTip, pose.fwd);
    }
    const shown = pressing ? smoothTip : tip;
    const r = Math.max(state.size / 1000, 0.003) * 1.3;
    cursor.position.copy(shown);
    cursor.scale.setScalar(r);
    cursor.visible = true;
    if (state.rainbow) cursorMat.color.setHSL((time / 4000) % 1, 0.9, 0.6);

    if (state.tool !== 'libre') {
      const S = state.shapeSize / 100;
      ghost.matrix.makeBasis(pose.right, pose.up, pose.fwd).scale(new THREE.Vector3(S, S, S)).setPosition(tip);
      ghost.visible = true;
    } else {
      ghost.visible = false;
    }
  } else {
    cursor.visible = false;
    ghost.visible = false;
  }
  if (mode === 'preview') controls.update();
  renderer.render(scene, camera);
});

window.addEventListener('resize', () => {
  if (renderer.xr.isPresenting) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  updatePointScale();
});

function updatePointScale(fbHeight, fovDeg) {
  const h = fbHeight ?? renderer.getDrawingBufferSize(new THREE.Vector2()).y;
  const fov = THREE.MathUtils.degToRad(fovDeg ?? camera.fov);
  shared.uPointScale.value = h / (2 * Math.tan(fov / 2));
}
updatePointScale();

// ---------- Modes ----------
const $ = (id) => document.getElementById(id);
const home = $('home');
const overlay = $('overlay');

async function startAR() {
  try {
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['local'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: overlay },
    });
    clearAll();
    renderer.xr.setReferenceSpaceType('local');
    await renderer.xr.setSession(session);
    mode = 'ar';
    scene.background = null;
    grid.visible = false;
    controls.enabled = false;
    home.classList.add('hidden');
    overlay.classList.remove('hidden');
    const layer = session.renderState.baseLayer;
    updatePointScale(layer ? layer.framebufferHeight : undefined, 65);

    session.addEventListener('selectstart', onPress);
    session.addEventListener('selectend', onRelease);
    session.addEventListener('end', () => {
      onRelease();
      mode = 'home';
      overlay.classList.add('hidden');
      home.classList.remove('hidden');
      updatePointScale();
    });
    showHint();
  } catch (err) {
    console.error(err);
    $('support-msg').textContent = `Impossible de lancer l'AR : ${err.message}`;
  }
}

function startPreview() {
  mode = 'preview';
  scene.background = PREVIEW_BG;
  grid.visible = true;
  controls.enabled = true;
  home.classList.add('hidden');
  overlay.classList.remove('hidden');
  showHint();
}

function exitMode() {
  const session = renderer.xr.getSession();
  if (session) { session.end(); return; }
  onRelease();
  mode = 'home';
  controls.enabled = false;
  overlay.classList.add('hidden');
  home.classList.remove('hidden');
}

async function checkSupport() {
  const btn = $('btn-ar');
  const msg = $('support-msg');
  if (!window.isSecureContext) {
    btn.textContent = 'AR indisponible';
    msg.textContent = "La page doit être ouverte en HTTPS pour accéder à la caméra.";
    return;
  }
  const ok = navigator.xr && await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
  if (ok) {
    btn.disabled = false;
    btn.textContent = 'Lancer la réalité augmentée';
  } else {
    btn.textContent = 'AR indisponible';
    msg.textContent = "Cet appareil ne supporte pas WebXR AR. Ouvre la page dans Chrome sur un Android compatible ARCore.";
  }
}

// ---------- Interface ----------
const hintEl = $('hint');
let hintTimer = 0;

function hintText() {
  if (state.tool !== 'libre') return 'Touche l\'écran pour poser la forme';
  return mode === 'ar'
    ? 'Maintiens l\'écran appuyé et bouge le téléphone'
    : 'Clic gauche : dessiner · clic droit : tourner · molette : zoom';
}
function showHint() {
  clearTimeout(hintTimer);
  hintEl.textContent = hintText();
  hintEl.classList.remove('faded');
}
function fadeHint() { hintEl.classList.add('faded'); }
function flashHint(text) {
  hintEl.textContent = text;
  hintEl.classList.remove('faded');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(showHint, 1400);
}

const SQUIGGLE = 'M4 18 C 12 4, 20 4, 24 13 S 36 22, 44 8';
const BRUSH_ICONS = {
  neon: `<path class="ico-line ico-glow" stroke-width="6" opacity=".35" d="${SQUIGGLE}"/><path class="ico-line" stroke-width="2.5" d="${SQUIGGLE}" style="stroke:#fff"/>`,
  peinture: `<path class="ico-line" stroke-width="6" d="${SQUIGGLE}"/>`,
  ruban: `<path class="ico-line" stroke-width="10" stroke-linecap="butt" opacity=".85" d="${SQUIGGLE}"/><path d="${SQUIGGLE}" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="1.5"/>`,
  pointilles: `<path class="ico-line" stroke-width="4" stroke-dasharray="4 5" d="${SQUIGGLE}"/>`,
  etincelles: [[6, 16, 2], [12, 9, 1.5], [18, 7, 2.5], [24, 13, 1.5], [30, 19, 2], [37, 15, 1.5], [43, 8, 2.5], [15, 15, 1], [34, 9, 1]]
    .map(([x, y, r]) => `<circle class="ico-fill ico-glow" cx="${x}" cy="${y}" r="${r}"/>`).join(''),
  perles: [[5, 17], [12, 9], [20, 7], [26, 13], [33, 19], [41, 11]]
    .map(([x, y]) => `<circle class="ico-fill" cx="${x}" cy="${y}" r="3.2"/>`).join(''),
};

function shapeIcon(shape) {
  const pts = shape.points();
  const d = pts.map(([x, y, z], i) => {
    const px = 24 + (x + z * 0.35) * 30;
    const py = 13 - (y + z * 0.12) * 22;
    return `${i ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`;
  }).join(' ');
  return `<path class="ico-shape" d="${d}"/>`;
}

function buildUI() {
  $('brush-row').innerHTML = BRUSHES.map((b) =>
    `<button class="chip" data-brush="${b.id}"><svg viewBox="0 0 48 26">${BRUSH_ICONS[b.id]}</svg><span>${b.label}</span></button>`).join('');

  $('color-row').innerHTML = COLORS.map((c) => c === 'rainbow'
    ? '<button class="swatch rainbow" data-color="rainbow" aria-label="Arc-en-ciel"></button>'
    : `<button class="swatch" data-color="${c}" style="--c:${c}" aria-label="${c}"></button>`).join('');

  const tools = [{ id: 'libre', label: 'Main libre' }, ...SHAPES];
  $('shape-row').innerHTML = tools.map((t) => {
    const icon = t.id === 'libre' ? `<path class="ico-shape" d="${SQUIGGLE}"/>` : shapeIcon(t);
    return `<button class="chip" data-tool="${t.id}"><svg viewBox="0 0 48 26">${icon}</svg><span>${t.label}</span></button>`;
  }).join('');

  $('brush-row').addEventListener('click', (e) => {
    const b = e.target.closest('[data-brush]');
    if (!b) return;
    state.brush = b.dataset.brush;
    syncUI();
  });
  $('color-row').addEventListener('click', (e) => {
    const b = e.target.closest('[data-color]');
    if (!b) return;
    if (b.dataset.color === 'rainbow') state.rainbow = true;
    else { state.rainbow = false; state.color = b.dataset.color; }
    syncUI();
  });
  $('shape-row').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tool]');
    if (!b) return;
    state.tool = b.dataset.tool;
    refreshGhost();
    syncUI();
    showHint();
  });

  const sliders = [
    ['sl-size', 'out-size', 'size', (v) => `${v} mm`],
    ['sl-dist', 'out-dist', 'distance', (v) => `${v} cm`],
    ['sl-shape', 'out-shape', 'shapeSize', (v) => `${v} cm`],
  ];
  for (const [inId, outId, key, fmt] of sliders) {
    const input = $(inId);
    input.value = state[key];
    $(outId).textContent = fmt(state[key]);
    input.addEventListener('input', () => {
      state[key] = Number(input.value);
      $(outId).textContent = fmt(state[key]);
      saveSettings();
    });
  }

  const panel = $('panel');
  panel.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) panel.dataset.tab = b.dataset.tab;
  });

  $('btn-undo').addEventListener('click', undo);
  $('btn-clear').addEventListener('click', clearAll);
  $('btn-hide').addEventListener('click', () => overlay.classList.toggle('ui-hidden'));
  $('btn-exit').addEventListener('click', exitMode);
  $('btn-ar').addEventListener('click', startAR);
  $('btn-preview').addEventListener('click', startPreview);

  // Toucher l'interface ne doit pas dessiner dans la scène AR
  for (const el of overlay.querySelectorAll('.ui, .icon-btn')) {
    el.addEventListener('beforexrselect', (e) => e.preventDefault());
  }
}

function syncUI() {
  for (const el of document.querySelectorAll('[data-brush]')) el.classList.toggle('active', el.dataset.brush === state.brush);
  for (const el of document.querySelectorAll('[data-color]')) {
    el.classList.toggle('active', state.rainbow ? el.dataset.color === 'rainbow' : el.dataset.color === state.color);
  }
  for (const el of document.querySelectorAll('[data-tool]')) el.classList.toggle('active', el.dataset.tool === state.tool);
  const css = document.documentElement.style;
  css.setProperty('--brush-col', state.rainbow ? 'url(#rbgrad)' : state.color);
  css.setProperty('--glow', state.rainbow ? '#ff2e88' : state.color);
  if (!state.rainbow) cursorMat.color.set(state.color);
  saveSettings();
}

buildUI();
refreshGhost();
syncUI();
checkSupport();

// Accès depuis la console pour le débogage
window.baguette = { state, scene, strokesRoot, undoStack };
