import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BRUSHES, COLOR_MODES, POINT_BRUSHES, createStroke, disposeObject, liftFor, shared } from './brushes.js';
import { SHAPES } from './shapes.js';

// ---------- Réglages ----------
const SOLID_COLORS = ['#ffffff', '#111111', '#ff2e88', '#ff1744', '#ff7a00', '#ffe600', '#39ff14', '#00e5ff', '#2979ff', '#b14cff'];

const state = {
  brush: 'neon',
  color: '#ff2e88',
  mode: 'solid', // 'solid' ou un id de COLOR_MODES
  tool: 'libre',
  surface: false,
  size: 6, // rayon en mm
  distance: 35, // cm devant l'écran (dessin dans l'air)
  shapeSize: 25, // cm
  realism: 80, // % d'influence de la caméra sur la peinture posée sur une surface
  flipCam: false,
};
const STORAGE_KEY = 'baguette-ar-settings';
try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  for (const k of Object.keys(state)) if (k in saved) state[k] = saved[k];
} catch { /* stockage indisponible : réglages par défaut */ }
if (!BRUSHES.some((b) => b.id === state.brush)) state.brush = 'neon';
if (state.tool !== 'libre' && !SHAPES.some((s) => s.id === state.tool)) state.tool = 'libre';
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

// Surfaces factices pour tester le mode surface dans l'aperçu sans AR
const previewSurfaces = new THREE.Group();
{
  const mat = new THREE.MeshStandardMaterial({ color: 0x5a5a70, roughness: 0.95 });
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(3, 2), mat);
  wall.position.set(0, 0.5, -0.7);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), mat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.5;
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.22, 48, 32), new THREE.MeshStandardMaterial({ color: 0x8a7a6a, roughness: 0.8 }));
  ball.position.set(0.3, -0.28, -0.35);
  previewSurfaces.add(wall, floor, ball);
  previewSurfaces.add(new THREE.HemisphereLight(0xffffff, 0x303040, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(1, 2, 1.5);
  previewSurfaces.add(sun);
  previewSurfaces.visible = false;
  scene.add(previewSurfaces);
}
const previewHitTargets = previewSurfaces.children.filter((o) => o.isMesh);

const strokesRoot = new THREE.Group();
scene.add(strokesRoot);

// Curseur (dessin dans l'air)
const cursorMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false });
const cursor = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), cursorMat);
cursor.renderOrder = 10;
cursor.visible = false;
scene.add(cursor);

// Réticule (mode surface) : anneau posé à plat sur la surface détectée
const reticle = new THREE.Group();
{
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.028, 0.036, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide }),
  );
  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(0.005, 20).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, side: THREE.DoubleSide }),
  );
  ring.renderOrder = dot.renderOrder = 10;
  reticle.add(ring, dot);
  reticle.visible = false;
  scene.add(reticle);
}

// Aperçu fantôme de la forme sélectionnée
const ghostMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthTest: false });
const ghost = new THREE.Line(new THREE.BufferGeometry(), ghostMat);
ghost.matrixAutoUpdate = false;
ghost.renderOrder = 9;
ghost.visible = false;
scene.add(ghost);

// Texture de l'image caméra (accès caméra WebXR), branchée à la main dans three.js
const camTex = new THREE.Texture();
shared.uCam.value = camTex;

// ---------- Traits ----------
const undoStack = [];
let gesture = null; // { group, stroke, last, count }

function newStroke(s0 = 0) {
  return createStroke(state.brush, {
    color: state.color,
    mode: state.mode,
    radius: state.size / 1000,
    surface: state.surface,
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

function addPoint(p, orient) {
  if (!gesture) return;
  if (gesture.last) {
    const d = gesture.last.distanceTo(p);
    if (d < 0.002 || d > 0.3) return; // trop près, ou saut aberrant d'une image à l'autre
  }
  if (gesture.stroke.full) {
    // trait trop long : on enchaîne sur un nouveau segment dans le même geste
    const next = newStroke(gesture.stroke.s);
    gesture.group.add(next.object);
    next.add(gesture.last, orient);
    gesture.stroke = next;
  }
  gesture.stroke.add(p, orient);
  gesture.last = (gesture.last || new THREE.Vector3()).copy(p);
  gesture.count++;
}

function endGesture() {
  if (!gesture) return;
  const minPoints = POINT_BRUSHES.includes(state.brush) ? 1 : 2;
  if (gesture.count < minPoints) {
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

// ---------- XR ----------
let mode = 'home'; // 'home' | 'preview' | 'ar'
let refSpace = null;
let viewerHitSource = null;
let transientHitSource = null;
let glBinding = null;
let activeSource = null; // doigt en cours (source d'entrée "screen" WebXR)

let pressing = false;
let pendingShape = false;

// Pose du téléphone
const view = { pos: new THREE.Vector3(), fwd: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3() };
// Rayon sous le doigt (ou au centre de l'écran quand on ne touche pas)
const ray = { origin: new THREE.Vector3(), dir: new THREE.Vector3() };
// Surface réelle sous le rayon
const hit = { ok: false, point: new THREE.Vector3(), normal: new THREE.Vector3() };
// Dernier point de surface du trait en cours : sert de plan de secours et évite les sauts
const lastSurf = { ok: false, point: new THREE.Vector3(), normal: new THREE.Vector3() };

const target = new THREE.Vector3();
const targetDir = new THREE.Vector3();
const smoothTip = new THREE.Vector3();
const smoothDir = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _size = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

function readView(frame) {
  if (mode === 'ar') {
    if (!frame) return false;
    const vp = frame.getViewerPose(refSpace);
    if (!vp) return false;
    _m.fromArray(vp.transform.matrix);
    updateCameraImage(vp.views[0]);
  } else {
    camera.updateMatrixWorld();
    _m.copy(camera.matrixWorld);
  }
  view.pos.setFromMatrixPosition(_m);
  view.right.set(1, 0, 0).transformDirection(_m);
  view.up.set(0, 1, 0).transformDirection(_m);
  view.fwd.set(0, 0, -1).transformDirection(_m);
  return true;
}

function updateCameraImage(xrView) {
  shared.uCamOn.value = 0;
  if (!glBinding || !xrView || !xrView.camera) return;
  try {
    const tex = glBinding.getCameraImage(xrView.camera);
    if (!tex) return;
    const props = renderer.properties.get(camTex);
    props.__webglTexture = tex;
    props.__webglInit = true;
    shared.uCamOn.value = 1;
  } catch { /* accès caméra refusé ou non supporté */ }
}

function readRay(frame) {
  if (mode === 'ar') {
    if (pressing && activeSource) {
      const rp = frame.getPose(activeSource.targetRaySpace, refSpace);
      if (rp) {
        _m.fromArray(rp.transform.matrix);
        ray.origin.setFromMatrixPosition(_m);
        ray.dir.set(0, 0, -1).transformDirection(_m);
        return;
      }
    }
    ray.origin.copy(view.pos);
    ray.dir.copy(view.fwd);
  } else {
    raycaster.setFromCamera(mouse, camera);
    ray.origin.copy(raycaster.ray.origin);
    ray.dir.copy(raycaster.ray.direction);
  }
}

function readHit(frame) {
  hit.ok = false;
  if (mode === 'ar') {
    let result = null;
    if (pressing && transientHitSource) {
      for (const r of frame.getHitTestResultsForTransientInput(transientHitSource)) {
        if (!activeSource || r.inputSource === activeSource) { result = r.results[0]; break; }
      }
    } else if (!pressing && viewerHitSource) {
      result = frame.getHitTestResults(viewerHitSource)[0];
    }
    const p = result && result.getPose(refSpace);
    if (p) {
      _m.fromArray(p.transform.matrix);
      hit.point.setFromMatrixPosition(_m);
      hit.normal.set(0, 1, 0).transformDirection(_m);
      hit.ok = true;
    }
  } else {
    raycaster.set(ray.origin, ray.dir);
    const h = raycaster.intersectObjects(previewHitTargets, false)[0];
    if (h) {
      hit.point.copy(h.point);
      hit.normal.copy(h.face.normal).transformDirection(h.object.matrixWorld);
      hit.ok = true;
    }
  }

  // Pendant un trait : on reste collé à la surface choisie au premier contact
  if (pressing && lastSurf.ok) {
    if (hit.ok && hit.point.distanceTo(lastSurf.point) > 0.12) hit.ok = false; // saut vers un autre objet
    if (!hit.ok) {
      const denom = ray.dir.dot(lastSurf.normal);
      if (Math.abs(denom) > 1e-3) {
        const t = _v.subVectors(lastSurf.point, ray.origin).dot(lastSurf.normal) / denom;
        if (t > 0) {
          hit.point.copy(ray.origin).addScaledVector(ray.dir, t);
          hit.normal.copy(lastSurf.normal);
          hit.ok = true;
        }
      }
    }
  }
}

// ---------- Formes ----------
function shapeById(id) { return SHAPES.find((s) => s.id === id); }

// Repère de la forme : à plat sur la surface, ou face au téléphone dans l'air
const shapeBasis = { right: new THREE.Vector3(), up: new THREE.Vector3(), out: new THREE.Vector3() };
function computeShapeBasis() {
  if (state.surface) {
    const n = targetDir;
    shapeBasis.out.copy(n);
    shapeBasis.right.copy(view.right).addScaledVector(n, -view.right.dot(n));
    if (shapeBasis.right.lengthSq() < 1e-6) shapeBasis.right.copy(view.up).addScaledVector(n, -view.up.dot(n));
    shapeBasis.right.normalize();
    shapeBasis.up.crossVectors(n, shapeBasis.right).normalize();
  } else {
    shapeBasis.right.copy(view.right);
    shapeBasis.up.copy(view.up);
    shapeBasis.out.copy(ray.dir);
  }
}

function placeShape() {
  const shape = shapeById(state.tool);
  if (!shape) return;
  computeShapeBasis();
  const S = state.shapeSize / 100;
  const w = new THREE.Vector3();
  beginGesture();
  for (const [x, y, z] of shape.points()) {
    w.copy(target)
      .addScaledVector(shapeBasis.right, x * S)
      .addScaledVector(shapeBasis.up, y * S)
      .addScaledVector(shapeBasis.out, z * S);
    addPoint(w, targetDir);
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
function onPress(e) {
  if (mode === 'home') return;
  activeSource = e && e.inputSource ? e.inputSource : null;
  pressing = true;
  lastSurf.ok = false;
  if (state.tool === 'libre') fadeHint();
  else pendingShape = true; // posée à la prochaine image, quand la position du doigt est connue
}

function onRelease() {
  if (!pressing) return;
  pressing = false;
  activeSource = null;
  lastSurf.ok = false;
  endGesture();
}

// Aperçu sur ordinateur : clic gauche = dessiner, clic droit = tourner
const activePointers = new Set();
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (mode !== 'preview') return;
  activePointers.add(e.pointerId);
  updateMouse(e);
  if (activePointers.size > 1) { onRelease(); return; } // deux doigts = navigation
  if (e.button === 0) onPress();
});
renderer.domElement.addEventListener('pointermove', updateMouse);
window.addEventListener('pointerup', (e) => { activePointers.delete(e.pointerId); if (mode === 'preview') onRelease(); });
window.addEventListener('pointercancel', (e) => { activePointers.delete(e.pointerId); if (mode === 'preview') onRelease(); });
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

function updateMouse(e) {
  mouse.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
}

// ---------- Boucle de rendu ----------
let lastTime = 0;
let surfaceFound = null;

renderer.setAnimationLoop((time, frame) => {
  const dt = Math.min((time - lastTime) / 1000, 0.1);
  lastTime = time;
  shared.uTime.value = time / 1000;
  renderer.getDrawingBufferSize(_size);
  shared.uViewport.value.copy(_size);

  let haveTarget = false;
  if (mode !== 'home' && readView(frame)) {
    readRay(frame);
    const radius = state.size / 1000;
    if (state.surface) {
      readHit(frame);
      if (hit.ok) {
        target.copy(hit.point).addScaledVector(hit.normal, liftFor(state.brush, radius));
        targetDir.copy(hit.normal);
        haveTarget = true;
      }
      if (surfaceFound !== hit.ok) { surfaceFound = hit.ok; if (!pressing) showHint(); }
    } else {
      const d = mode === 'ar' ? state.distance / 100 : camera.position.distanceTo(controls.target);
      target.copy(ray.origin).addScaledVector(ray.dir, d);
      targetDir.copy(ray.dir);
      haveTarget = true;
    }

    if (pendingShape && haveTarget) {
      pendingShape = false;
      placeShape();
    } else if (pendingShape && state.surface && !hit.ok) {
      pendingShape = false;
      flashHint('Aucune surface détectée ici');
    }

    if (pressing && state.tool === 'libre' && haveTarget) {
      if (!gesture) {
        beginGesture();
        smoothTip.copy(target);
        smoothDir.copy(targetDir);
      } else {
        smoothTip.lerp(target, state.surface ? 0.5 : 0.6);
        smoothDir.lerp(targetDir, 0.35).normalize();
      }
      addPoint(smoothTip, smoothDir);
      if (state.surface) {
        lastSurf.ok = true;
        lastSurf.point.copy(hit.point);
        lastSurf.normal.copy(smoothDir);
      }
    }
    if (gesture) gesture.stroke.update(dt, pressing);

    updateIndicators(haveTarget, time);
  } else {
    cursor.visible = reticle.visible = ghost.visible = false;
  }
  if (mode === 'preview') controls.update();
  renderer.render(scene, camera);
});

function updateIndicators(haveTarget, time) {
  const radius = Math.max(state.size / 1000, 0.003);
  if (state.mode !== 'solid') cursorMat.color.setHSL((time / 4000) % 1, 0.9, 0.6);

  if (state.surface) {
    cursor.visible = false;
    reticle.visible = haveTarget;
    if (haveTarget) {
      reticle.position.copy(pressing ? smoothTip : target);
      reticle.quaternion.setFromUnitVectors(_v.set(0, 1, 0), targetDir);
      reticle.scale.setScalar(Math.max(radius / 0.006, 0.6));
    }
  } else {
    reticle.visible = false;
    cursor.visible = haveTarget;
    cursor.position.copy(pressing && gesture ? smoothTip : target);
    cursor.scale.setScalar(radius * 1.3);
  }

  if (state.tool !== 'libre' && haveTarget) {
    computeShapeBasis();
    const S = state.shapeSize / 100;
    ghost.matrix.makeBasis(shapeBasis.right, shapeBasis.up, shapeBasis.out)
      .scale(_v.set(S, S, S)).setPosition(target);
    ghost.visible = true;
  } else {
    ghost.visible = false;
  }
}

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

function applySceneMode() {
  const preview = mode === 'preview';
  scene.background = preview ? PREVIEW_BG : null;
  grid.visible = preview && !state.surface;
  previewSurfaces.visible = preview && state.surface;
}

async function startAR() {
  try {
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['local'],
      optionalFeatures: ['dom-overlay', 'hit-test', 'camera-access'],
      domOverlay: { root: overlay },
    });
    clearAll();
    renderer.xr.setReferenceSpaceType('local');
    await renderer.xr.setSession(session);
    refSpace = renderer.xr.getReferenceSpace();
    mode = 'ar';
    applySceneMode();
    controls.enabled = false;
    home.classList.add('hidden');
    overlay.classList.remove('hidden');
    updatePointScale(renderer.getDrawingBufferSize(new THREE.Vector2()).y, 65);

    const features = session.enabledFeatures || [];
    if (features.includes('camera-access') && window.XRWebGLBinding) {
      try { glBinding = new XRWebGLBinding(session, renderer.getContext()); } catch { glBinding = null; }
    }
    setupHitTest(session);

    session.addEventListener('selectstart', onPress);
    session.addEventListener('selectend', onRelease);
    session.addEventListener('end', () => {
      onRelease();
      mode = 'home';
      viewerHitSource = transientHitSource = glBinding = refSpace = null;
      shared.uCamOn.value = 0;
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

async function setupHitTest(session) {
  const entityTypes = ['plane', 'point'];
  try {
    const viewerSpace = await session.requestReferenceSpace('viewer');
    viewerHitSource = await session.requestHitTestSource({ space: viewerSpace, entityTypes })
      .catch(() => session.requestHitTestSource({ space: viewerSpace }));
    transientHitSource = await session.requestHitTestSourceForTransientInput({ profile: 'generic-touchscreen', entityTypes })
      .catch(() => session.requestHitTestSourceForTransientInput({ profile: 'generic-touchscreen' }));
  } catch (err) {
    console.warn('Détection de surface indisponible', err);
  }
}

function startPreview() {
  mode = 'preview';
  applySceneMode();
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
  if (state.surface) {
    if (!surfaceFound) return 'Scanne la surface : bouge doucement le téléphone';
    return state.tool === 'libre' ? 'Glisse ton doigt sur la surface pour peindre' : 'Touche la surface pour poser la forme';
  }
  if (state.tool !== 'libre') return 'Touche l\'écran pour poser la forme';
  return mode === 'ar'
    ? 'Glisse ton doigt sur l\'écran pour dessiner dans l\'air'
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
const dots = (list, cls, r) => list.map(([x, y, rr]) => `<circle class="${cls}" cx="${x}" cy="${y}" r="${rr ?? r}"/>`).join('');
const BRUSH_ICONS = {
  neon: `<path class="ico-line ico-glow" stroke-width="6" opacity=".35" d="${SQUIGGLE}"/><path class="ico-line" stroke-width="2.5" d="${SQUIGGLE}" style="stroke:#fff"/>`,
  peinture: `<path class="ico-line" stroke-width="6" d="${SQUIGGLE}"/>`,
  bombe: `<path class="ico-line" stroke-width="9" opacity=".35" d="${SQUIGGLE}" style="filter:blur(1.5px)"/><path class="ico-line" stroke-width="4" opacity=".9" d="${SQUIGGLE}"/>`
    + `<path class="ico-line" stroke-width="1.6" d="M18 8 v8 M30 17 v6"/>`,
  craie: `<path class="ico-line" stroke-width="5" stroke-dasharray="1.5 1.2" d="${SQUIGGLE}"/>`,
  ruban: `<path class="ico-line" stroke-width="10" stroke-linecap="butt" opacity=".85" d="${SQUIGGLE}"/><path d="${SQUIGGLE}" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="1.5"/>`,
  flamme: `<path class="ico-fill ico-glow" d="M24 24c-7 0-10-5-8-10 1 3 3 4 4 3-2-5 1-10 5-13-1 4 2 6 4 9 1-1 1-3 1-4 3 3 4 7 3 10-1 3-4 5-9 5z"/>`,
  eclair: `<path class="ico-line ico-glow" stroke-width="2.5" stroke-linejoin="round" d="M4 16 L12 8 L16 17 L24 6 L28 18 L36 9 L44 14"/>`,
  pointilles: `<path class="ico-line" stroke-width="4" stroke-dasharray="4 5" d="${SQUIGGLE}"/>`,
  etincelles: dots([[6, 16, 2], [12, 9, 1.5], [18, 7, 2.5], [24, 13, 1.5], [30, 19, 2], [37, 15, 1.5], [43, 8, 2.5], [15, 15, 1], [34, 9, 1]], 'ico-fill ico-glow'),
  perles: dots([[5, 17], [12, 9], [20, 7], [26, 13], [33, 19], [41, 11]], 'ico-fill', 3.2),
};
const MODE_GRADIENT = { rainbow: 'rbgrad', iris: 'irisgrad', feu: 'feugrad', aurore: 'auroregrad', or: 'orgrad' };

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

  $('color-row').innerHTML = [
    ...COLOR_MODES.map((m) => `<button class="swatch mode-${m.id}" data-mode="${m.id}" aria-label="${m.label}"></button>`),
    '<span class="row-sep"></span>',
    ...SOLID_COLORS.map((c) => `<button class="swatch" data-color="${c}" style="--c:${c}" aria-label="${c}"></button>`),
  ].join('');

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
    const b = e.target.closest('[data-mode], [data-color]');
    if (!b) return;
    if (b.dataset.mode) state.mode = b.dataset.mode;
    else { state.mode = 'solid'; state.color = b.dataset.color; }
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
    ['sl-real', 'out-real', 'realism', (v) => `${v} %`],
  ];
  for (const [inId, outId, key, fmt] of sliders) {
    const input = $(inId);
    input.value = state[key];
    $(outId).textContent = fmt(state[key]);
    input.addEventListener('input', () => {
      state[key] = Number(input.value);
      $(outId).textContent = fmt(state[key]);
      syncUI();
    });
  }
  const flip = $('chk-flip');
  flip.checked = state.flipCam;
  flip.addEventListener('change', () => { state.flipCam = flip.checked; syncUI(); });

  const panel = $('panel');
  panel.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) panel.dataset.tab = b.dataset.tab;
  });

  $('btn-surface').addEventListener('click', () => {
    state.surface = !state.surface;
    surfaceFound = null;
    applySceneMode();
    syncUI();
    showHint();
    if (state.surface && mode === 'ar' && !viewerHitSource) flashHint('Détection de surface non supportée sur cet appareil');
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
  for (const el of document.querySelectorAll('[data-mode]')) el.classList.toggle('active', state.mode === el.dataset.mode);
  for (const el of document.querySelectorAll('[data-color]')) el.classList.toggle('active', state.mode === 'solid' && el.dataset.color === state.color);
  for (const el of document.querySelectorAll('[data-tool]')) el.classList.toggle('active', el.dataset.tool === state.tool);
  $('btn-surface').classList.toggle('active', state.surface);

  const css = document.documentElement.style;
  const solid = state.mode === 'solid';
  css.setProperty('--brush-col', solid ? state.color : `url(#${MODE_GRADIENT[state.mode]})`);
  css.setProperty('--glow', solid ? state.color : '#ff2e88');
  if (solid) cursorMat.color.set(state.color);

  shared.uReal.value = state.realism / 100;
  shared.uFlip.value = state.flipCam ? 1 : 0;
  saveSettings();
}

buildUI();
refreshGhost();
syncUI();
checkSupport();

// Accès depuis la console pour le débogage
window.baguette = { state, scene, strokesRoot, undoStack, target, smoothTip, mouse, ray, camera, controls };
