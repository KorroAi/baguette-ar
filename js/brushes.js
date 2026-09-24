// Pinceaux : chaque trait est une géométrie pré-allouée qu'on remplit point par point.
// Les couleurs sont passées en valeurs sRGB brutes (pas de conversion de gestion des couleurs)
// et les ShaderMaterial écrivent directement à l'écran.
import * as THREE from 'three';

export const BRUSHES = [
  { id: 'neon', label: 'Néon' },
  { id: 'peinture', label: 'Peinture' },
  { id: 'bombe', label: 'Bombe' },
  { id: 'craie', label: 'Craie' },
  { id: 'ruban', label: 'Ruban' },
  { id: 'flamme', label: 'Flamme' },
  { id: 'eclair', label: 'Éclair' },
  { id: 'pointilles', label: 'Pointillés' },
  { id: 'etincelles', label: 'Étincelles' },
  { id: 'perles', label: 'Perles' },
];

// Modes de couleur animés (en plus des couleurs unies)
export const COLOR_MODES = [
  { id: 'rainbow', label: 'Arc-en-ciel' },
  { id: 'iris', label: 'Irisé' },
  { id: 'feu', label: 'Feu' },
  { id: 'aurore', label: 'Aurore' },
  { id: 'or', label: 'Or' },
];
const MODE_INDEX = { solid: 0, rainbow: 1, iris: 2, feu: 3, aurore: 4, or: 5 };

// Pinceaux qui n'ont besoin que d'un point pour exister
export const POINT_BRUSHES = ['etincelles', 'perles', 'bombe'];

export const shared = {
  uTime: { value: 0 },
  uPointScale: { value: 900 }, // pixels par mètre à 1 m de distance (pour la taille des particules)
  // Réalisme sur surface : image caméra utilisée pour reprendre lumière et texture du support
  uCam: { value: null },
  uCamOn: { value: 0 },
  uViewport: { value: new THREE.Vector2(1, 1) },
  uFlip: { value: 0 },
  uReal: { value: 0.8 },
};

const MAX_POINTS = 2500;
let surfaceStrokeCount = 0;

// ---------- GLSL ----------
const GLSL_UTIL = /* glsl */ `
  float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  vec3 hash3(float n) { return fract(sin(vec3(n, n + 1.7, n + 3.1)) * 43758.5453123); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x),
               mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x), f.y);
  }
`;

const GLSL_COLOR = /* glsl */ `
  uniform vec3 uColor;
  uniform float uMode;
  uniform float uTime;
  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }
  // s = longueur le long du trait (m), ndv = orientation vers la caméra (1 = de face)
  vec3 modeColor(float s, float ndv) {
    if (uMode < 0.5) return uColor;
    if (uMode < 1.5) return hsv2rgb(vec3(fract(s * 2.0 - uTime * 0.25), 0.85, 1.0));
    if (uMode < 2.5) {
      float h = fract(ndv * 1.4 + s * 0.7 + uTime * 0.05);
      vec3 c = hsv2rgb(vec3(h, 0.5, 1.0));
      return mix(c, vec3(1.0), pow(1.0 - ndv, 3.0) * 0.5);
    }
    if (uMode < 3.5) {
      float k = 0.5 + 0.5 * sin(s * 25.0 - uTime * 6.0);
      return mix(vec3(1.0, 0.18, 0.0), vec3(1.0, 0.8, 0.15), k);
    }
    if (uMode < 4.5) {
      float k = 0.5 + 0.5 * sin(s * 6.0 - uTime * 1.5);
      vec3 a = mix(vec3(0.1, 1.0, 0.6), vec3(0.2, 0.6, 1.0), k);
      return mix(a, vec3(0.7, 0.3, 1.0), 0.5 + 0.5 * sin(s * 3.3 + uTime));
    }
    return mix(vec3(0.5, 0.32, 0.07), vec3(1.0, 0.86, 0.5), pow(ndv, 2.5)) + vec3(pow(ndv, 40.0)) * 0.6;
  }
`;

// Sur une surface réelle, on module la peinture par la luminance de l'image caméra :
// ombres, grain et texture du support transparaissent à travers la peinture.
const GLSL_SURFACE = /* glsl */ `
  uniform sampler2D uCam;
  uniform float uCamOn;
  uniform vec2 uViewport;
  uniform float uFlip;
  uniform float uReal;
  vec3 finalColor(vec3 c) {
    #ifdef SURFACE
    if (uCamOn > 0.5) {
      vec2 uv = gl_FragCoord.xy / uViewport;
      if (uFlip > 0.5) uv.y = 1.0 - uv.y;
      float lum = dot(texture2D(uCam, uv).rgb, vec3(0.299, 0.587, 0.114));
      c = mix(c, c * clamp(lum * 1.7 + 0.08, 0.15, 1.25), uReal);
    }
    #endif
    return c;
  }
`;

const SURFACE_VERT = /* glsl */ `
  attribute float aS;
  attribute float aAcross;
  uniform float uTime;
  uniform float uZap;
  varying float vS;
  varying float vAcross;
  varying vec3 vN;
  varying vec3 vView;
  vec3 hash3(float n) { return fract(sin(vec3(n, n + 1.7, n + 3.1)) * 43758.5453123); }
  void main() {
    vS = aS;
    vAcross = aAcross;
    vec3 pos = position;
    #ifdef ZAP
      // éclair : chaque anneau du tube est décalé en zigzag, re-tiré 14 fois par seconde
      float k = floor(uTime * 14.0) * 17.0;
      float x = aS * 55.0;
      float i = floor(x);
      pos += (mix(hash3(i + k), hash3(i + 1.0 + k), fract(x)) - 0.5) * uZap;
    #endif
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    vN = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG_HEAD = /* glsl */ `
  varying float vS;
  varying float vAcross;
  varying vec3 vN;
  varying vec3 vView;
  ${GLSL_UTIL}
  ${GLSL_COLOR}
  ${GLSL_SURFACE}
  float facing() { return abs(dot(normalize(vN), normalize(vView))); }
  float across() { return abs(vAcross - 0.5) * 2.0; }
`;

const FRAG = {
  peinture: /* glsl */ `${FRAG_HEAD}
    void main() {
      float ndv = facing();
      vec3 c = modeColor(vS, ndv);
      vec3 col = c * (0.35 + 0.65 * ndv) + vec3(pow(ndv, 24.0)) * 0.3;
      gl_FragColor = vec4(col, 1.0);
    }`,
  peintureFlat: /* glsl */ `${FRAG_HEAD}
    void main() {
      float d = across();
      float rough = vnoise(vec2(vS * 180.0, vAcross * 6.0));
      if (d > 0.88 + (rough - 0.5) * 0.25) discard;
      vec3 c = modeColor(vS, facing());
      c *= 0.9 + 0.1 * vnoise(vec2(vS * 500.0, vAcross * 30.0));
      gl_FragColor = vec4(finalColor(c), 1.0);
    }`,
  neonCore: /* glsl */ `${FRAG_HEAD}
    void main() {
      gl_FragColor = vec4(mix(modeColor(vS, facing()), vec3(1.0), 0.6), 1.0);
    }`,
  neonHalo: /* glsl */ `${FRAG_HEAD}
    void main() {
      float ndv = facing();
      float pulse = 0.65 + 0.35 * sin(uTime * 4.0 - vS * 30.0);
      gl_FragColor = vec4(modeColor(vS, ndv), pow(ndv, 1.2) * 0.6 * pulse);
    }`,
  neonFlat: /* glsl */ `${FRAG_HEAD}
    void main() {
      float d = across();
      float core = smoothstep(0.3, 0.0, d);
      float glow = pow(1.0 - d, 2.0) * (0.65 + 0.35 * sin(uTime * 4.0 - vS * 30.0));
      vec3 c = modeColor(vS, 1.0);
      gl_FragColor = vec4(mix(c, vec3(1.0), core * 0.7), clamp(glow + core, 0.0, 1.0));
    }`,
  pointilles: /* glsl */ `${FRAG_HEAD}
    void main() {
      if (fract(vS * 28.0 - uTime * 1.2) > 0.55) discard;
      float ndv = facing();
      vec3 col = modeColor(vS, ndv) * (0.5 + 0.5 * ndv) + vec3(0.25 * ndv);
      gl_FragColor = vec4(finalColor(col), 1.0);
    }`,
  ruban: /* glsl */ `${FRAG_HEAD}
    void main() {
      float ndv = facing();
      float edge = smoothstep(0.0, 0.18, vAcross) * smoothstep(1.0, 0.82, vAcross);
      float shimmer = 0.85 + 0.15 * sin(vS * 40.0 - uTime * 3.0);
      vec3 col = modeColor(vS, ndv) * (0.45 + 0.55 * ndv) * mix(0.55, 1.0, edge) * shimmer;
      gl_FragColor = vec4(finalColor(col), 1.0);
    }`,
  bombe: /* glsl */ `${FRAG_HEAD}
    void main() {
      float d = across();
      float soft = smoothstep(1.0, 0.25, d);
      float speck = step(0.82, hash2(floor(vec2(vS * 1400.0, vAcross * 70.0))));
      float a = soft * 0.85 + speck * (1.0 - d) * 0.6 * step(0.45, d);
      a *= 0.85 + 0.15 * vnoise(vec2(vS * 120.0, vAcross * 8.0));
      if (a < 0.02) discard;
      gl_FragColor = vec4(finalColor(modeColor(vS, 1.0)), a);
    }`,
  drip: /* glsl */ `${FRAG_HEAD}
    uniform float uBirth;
    uniform float uS0;
    void main() {
      // la coulure s'allonge vite puis ralentit, avec une goutte plus large au bout
      float prog = 1.0 - exp(-max(uTime - uBirth, 0.0) * 0.8);
      float e = prog - vS;
      if (e < 0.0) discard;
      float d = across();
      float bulb = smoothstep(0.1, 0.0, e);
      float w = mix(0.3 + 0.25 * (1.0 - vS), 1.0, bulb);
      if (d > w) discard;
      vec3 c = modeColor(uS0 + vS * 0.02, 1.0);
      c += vec3(0.12) * smoothstep(0.35, 0.0, abs(vAcross - 0.38) * 2.0);
      gl_FragColor = vec4(finalColor(c), 0.95);
    }`,
  craie: /* glsl */ `${FRAG_HEAD}
    void main() {
      float d = across();
      float grain = hash2(floor(vec2(vS * 1100.0, vAcross * 45.0)));
      float body = smoothstep(1.0, 0.5, d + (vnoise(vec2(vS * 60.0, 1.0)) - 0.5) * 0.4);
      if (grain > body * 0.8 + 0.05) discard;
      vec3 c = modeColor(vS, 1.0) * (0.85 + 0.15 * grain);
      gl_FragColor = vec4(finalColor(c), 1.0);
    }`,
  flamme: /* glsl */ `${FRAG_HEAD}
    void main() {
      float d = across();
      float n = vnoise(vec2(vS * 22.0 - uTime * 1.5, vAcross * 4.0 - uTime * 4.0)) * 0.6
              + vnoise(vec2(vS * 50.0 + uTime * 2.0, vAcross * 9.0 - uTime * 7.0)) * 0.4;
      float inten = clamp(1.0 - d * 1.15 + (n - 0.5) * 0.9, 0.0, 1.0);
      inten = pow(inten, 1.5);
      vec3 col = mix(modeColor(vS, 1.0) * 0.9, vec3(1.0, 0.95, 0.75), smoothstep(0.55, 1.0, inten));
      gl_FragColor = vec4(col, inten);
    }`,
};

const ADDITIVE = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };
const TRANSLUCENT = { transparent: true, depthWrite: false };

function material(frag, color, mode, { surface = false, zap = 0, extra = {}, uniforms = {} } = {}) {
  const defines = {};
  if (surface) defines.SURFACE = '';
  if (zap) defines.ZAP = '';
  const m = new THREE.ShaderMaterial({
    defines,
    uniforms: {
      uColor: { value: color },
      uMode: { value: mode },
      uTime: shared.uTime,
      uZap: { value: zap },
      uCam: shared.uCam,
      uCamOn: shared.uCamOn,
      uViewport: shared.uViewport,
      uFlip: shared.uFlip,
      uReal: shared.uReal,
      ...uniforms,
    },
    vertexShader: SURFACE_VERT,
    fragmentShader: frag,
    side: THREE.DoubleSide,
    ...extra,
  });
  if (surface) {
    // les traits récents passent devant les anciens sur une même surface
    m.polygonOffset = true;
    m.polygonOffsetFactor = -1;
    m.polygonOffsetUnits = -(1 + (surfaceStrokeCount % 200) * 2);
  }
  return m;
}

const _t = new THREE.Vector3();
const _b = new THREE.Vector3();
const _v = new THREE.Vector3();
const _side = new THREE.Vector3();
const _n = new THREE.Vector3();
const _g = new THREE.Vector3();

function perpendicular(t, out) {
  const axis = Math.abs(t.y) < 0.9 ? _v.set(0, 1, 0) : _v.set(1, 0, 0);
  return out.crossVectors(t, axis).normalize();
}

function dynAttr(array, itemSize) {
  return new THREE.BufferAttribute(array, itemSize).setUsage(THREE.DynamicDrawUsage);
}

// Une seule plage d'envoi GPU par attribut et par image : on fusionne avec celle
// qui n'a pas encore été envoyée (three.js vide la liste après chaque envoi).
function markDirty(attrs, start, count) {
  for (const a of attrs) {
    let s = start * a.itemSize;
    let e = s + count * a.itemSize;
    const pending = a.updateRanges[0];
    if (pending) {
      s = Math.min(s, pending.start);
      e = Math.max(e, pending.start + pending.count);
      a.clearUpdateRanges();
    }
    a.addUpdateRange(s, e - s);
    a.needsUpdate = true;
  }
}

// ---------- Tube (néon, peinture, pointillés, éclair) ----------
class Tube {
  constructor(radius, radial, mat, s0) {
    this.r = radius;
    this.radial = radial;
    this.n = 0;
    this.s = s0;
    this.last = new THREE.Vector3();
    this.normal = new THREE.Vector3();

    const nv = MAX_POINTS * radial;
    this.pos = dynAttr(new Float32Array(nv * 3), 3);
    this.nor = dynAttr(new Float32Array(nv * 3), 3);
    this.sa = dynAttr(new Float32Array(nv), 1);

    const idx = new Uint32Array((MAX_POINTS - 1) * radial * 6);
    for (let i = 0; i < MAX_POINTS - 1; i++) {
      for (let j = 0; j < radial; j++) {
        const a = i * radial + j;
        const b = i * radial + ((j + 1) % radial);
        const c = a + radial;
        const d = b + radial;
        idx.set([a, b, c, b, d, c], (i * radial + j) * 6);
      }
    }

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', this.pos);
    this.geo.setAttribute('normal', this.nor);
    this.geo.setAttribute('aS', this.sa);
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
  }

  get full() { return this.n >= MAX_POINTS; }

  add(p) {
    if (this.full) return;
    if (this.n === 0) { this.last.copy(p); this.n = 1; return; }
    _t.subVectors(p, this.last);
    const len = _t.length();
    if (len < 1e-5) return;
    _t.divideScalar(len);

    let from;
    if (this.n === 1) {
      perpendicular(_t, this.normal);
      this.ring(0, this.last, _t, this.s);
      from = 0;
    } else {
      // transport parallèle : le cadre du tube tourne sans vriller
      this.normal.addScaledVector(_t, -this.normal.dot(_t));
      if (this.normal.lengthSq() < 1e-10) perpendicular(_t, this.normal);
      this.normal.normalize();
      from = this.n;
    }
    this.s += len;
    this.ring(this.n, p, _t, this.s);
    this.n++;
    this.last.copy(p);
    this.geo.setDrawRange(0, (this.n - 1) * this.radial * 6);
    markDirty([this.pos, this.nor, this.sa], from * this.radial, (this.n - from) * this.radial);
  }

  ring(i, p, t, s) {
    _b.crossVectors(t, this.normal).normalize();
    const P = this.pos.array, N = this.nor.array, S = this.sa.array;
    for (let j = 0; j < this.radial; j++) {
      const a = (j / this.radial) * Math.PI * 2;
      const c = Math.cos(a), sn = Math.sin(a);
      const nx = c * this.normal.x + sn * _b.x;
      const ny = c * this.normal.y + sn * _b.y;
      const nz = c * this.normal.z + sn * _b.z;
      const k = i * this.radial + j;
      P[k * 3] = p.x + nx * this.r;
      P[k * 3 + 1] = p.y + ny * this.r;
      P[k * 3 + 2] = p.z + nz * this.r;
      N[k * 3] = nx; N[k * 3 + 1] = ny; N[k * 3 + 2] = nz;
      S[k] = s;
    }
  }
}

// ---------- Ruban plat ----------
// `orient` = direction vers laquelle le ruban fait face :
// dans l'air, la direction de visée (il fait face au téléphone) ;
// sur une surface, la normale du support (il se plaque dessus et suit ses courbes).
class Ribbon {
  constructor(width, mat, s0) {
    this.w = width;
    this.n = 0;
    this.s = s0;
    this.last = new THREE.Vector3();
    this.prevSide = new THREE.Vector3();

    const nv = MAX_POINTS * 2;
    this.pos = dynAttr(new Float32Array(nv * 3), 3);
    this.nor = dynAttr(new Float32Array(nv * 3), 3);
    this.sa = dynAttr(new Float32Array(nv), 1);
    const across = new Float32Array(nv);
    for (let i = 0; i < nv; i++) across[i] = i % 2;

    const idx = new Uint32Array((MAX_POINTS - 1) * 6);
    for (let i = 0; i < MAX_POINTS - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.set([a, b, c, b, d, c], i * 6);
    }

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', this.pos);
    this.geo.setAttribute('normal', this.nor);
    this.geo.setAttribute('aS', this.sa);
    this.geo.setAttribute('aAcross', new THREE.BufferAttribute(across, 1));
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
  }

  get full() { return this.n >= MAX_POINTS; }

  add(p, orient) {
    if (this.full) return;
    if (this.n === 0) { this.last.copy(p); this.n = 1; return; }
    _t.subVectors(p, this.last);
    const len = _t.length();
    if (len < 1e-5) return;
    _t.divideScalar(len);

    _side.crossVectors(_t, orient);
    const hasPrev = this.n > 1;
    if (_side.lengthSq() < 1e-6) {
      if (hasPrev) _side.copy(this.prevSide); else perpendicular(_t, _side);
    }
    _side.normalize();
    if (hasPrev) {
      if (_side.dot(this.prevSide) < 0) _side.negate();
      _side.lerp(this.prevSide, 0.5).normalize(); // lisse les à-coups de la main
    }
    _n.crossVectors(_side, _t).normalize();

    let from = this.n;
    if (this.n === 1) { this.pair(0, this.last, this.s); from = 0; }
    this.s += len;
    this.pair(this.n, p, this.s);
    this.prevSide.copy(_side);
    this.n++;
    this.last.copy(p);
    this.geo.setDrawRange(0, (this.n - 1) * 6);
    markDirty([this.pos, this.nor, this.sa], from * 2, (this.n - from) * 2);
  }

  pair(i, p, s) {
    const P = this.pos.array, N = this.nor.array, S = this.sa.array;
    const h = this.w / 2;
    for (let k = 0; k < 2; k++) {
      const sign = k === 0 ? -1 : 1;
      const v = i * 2 + k;
      P[v * 3] = p.x + _side.x * h * sign;
      P[v * 3 + 1] = p.y + _side.y * h * sign;
      P[v * 3 + 2] = p.z + _side.z * h * sign;
      N[v * 3] = _n.x; N[v * 3 + 1] = _n.y; N[v * 3 + 2] = _n.z;
      S[v] = s;
    }
  }
}

// ---------- Bombe de peinture sur surface : trait diffus + coulures ----------
class Spray {
  constructor(radius, color, mode, s0) {
    this.r = radius;
    this.color = color;
    this.mode = mode;
    this.group = new THREE.Group();
    this.ribbon = new Ribbon(radius * 6, material(FRAG.bombe, color, mode, { surface: true, extra: TRANSLUCENT }), s0);
    this.group.add(this.ribbon.mesh);
    this.lastP = new THREE.Vector3();
    this.lastN = new THREE.Vector3();
    this.has = false;
    this.wet = 0;
    this.travel = 0;
    this.nextDrip = 0.1 + Math.random() * 0.25;
    this.drips = 0;
  }

  get full() { return this.ribbon.full; }
  get s() { return this.ribbon.s; }

  add(p, n) {
    if (this.has) {
      const d = p.distanceTo(this.lastP);
      this.travel += d;
      this.wet = Math.max(0, this.wet - d * 8); // bouger vite = moins de peinture accumulée
    }
    this.ribbon.add(p, n);
    this.lastP.copy(p);
    this.lastN.copy(n);
    this.has = true;
    if (this.travel > this.nextDrip) {
      this.travel = 0;
      this.nextDrip = 0.12 + Math.random() * 0.3;
      if (Math.random() < 0.55) this.drip(0.6 + Math.random() * 0.5);
    }
  }

  // rester appuyé au même endroit charge la peinture jusqu'à ce qu'elle coule
  update(dt, pressing) {
    if (!pressing || !this.has) return;
    this.wet += dt;
    if (this.wet > 0.9) {
      this.wet = 0;
      this.drip(1 + Math.random() * 0.6);
    }
  }

  drip(strength) {
    if (this.drips >= 40) return;
    const n = this.lastN;
    // gravité projetée dans le plan de la surface
    _g.set(0, -1, 0).addScaledVector(n, n.y);
    if (_g.length() < 0.4) return; // surface trop horizontale : pas de coulure
    _g.normalize();
    const L = (0.03 + Math.random() * 0.07) * strength * Math.sqrt(this.r / 0.006);
    const W = this.r * 1.3;
    _side.crossVectors(_g, n).normalize();
    const start = this.lastP.clone().addScaledVector(_side, (Math.random() - 0.5) * this.r * 3);

    const segs = 24;
    const nv = (segs + 1) * 2;
    const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3);
    const S = new Float32Array(nv), A = new Float32Array(nv);
    const idx = [];
    for (let i = 0; i <= segs; i++) {
      const T = i / segs;
      for (let k = 0; k < 2; k++) {
        const v = i * 2 + k;
        const off = (k - 0.5) * W;
        P[v * 3] = start.x + _g.x * L * T + _side.x * off + n.x * 0.0005;
        P[v * 3 + 1] = start.y + _g.y * L * T + _side.y * off + n.y * 0.0005;
        P[v * 3 + 2] = start.z + _g.z * L * T + _side.z * off + n.z * 0.0005;
        N[v * 3] = n.x; N[v * 3 + 1] = n.y; N[v * 3 + 2] = n.z;
        S[v] = T;
        A[v] = k;
      }
      if (i < segs) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    geo.setAttribute('aS', new THREE.BufferAttribute(S, 1));
    geo.setAttribute('aAcross', new THREE.BufferAttribute(A, 1));
    geo.setIndex(idx);
    const mat = material(FRAG.drip, this.color, this.mode, {
      surface: true,
      extra: TRANSLUCENT,
      uniforms: { uBirth: { value: shared.uTime.value }, uS0: { value: this.ribbon.s } },
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.drips++;
  }
}

// ---------- Particules : étincelles (lumineuses) ou brume de bombe ----------
const PART_VERT = /* glsl */ `
  attribute float aS;
  attribute float aSeed;
  uniform float uTime;
  uniform float uSize;
  uniform float uPointScale;
  uniform float uTwinkle;
  varying float vS;
  varying float vA;
  void main() {
    vS = aS;
    vec3 p = position + vec3(
      sin(uTime * 1.3 + aSeed * 40.0),
      cos(uTime * 1.1 + aSeed * 23.0),
      sin(uTime * 0.9 + aSeed * 57.0)) * 0.003 * uTwinkle;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float tw = mix(1.0, 0.5 + 0.5 * sin(uTime * (2.0 + aSeed * 4.0) + aSeed * 60.0), uTwinkle);
    vA = tw;
    gl_PointSize = uSize * (0.5 + aSeed) * (0.6 + 0.8 * tw) * uPointScale / max(-mv.z, 0.01);
    gl_Position = projectionMatrix * mv;
  }
`;
const SPARK_FRAG = /* glsl */ `
  varying float vS;
  varying float vA;
  ${GLSL_COLOR}
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float core = pow(1.0 - d, 2.0);
    vec3 c = mix(modeColor(vS, 1.0), vec3(1.0), 0.5 * core);
    gl_FragColor = vec4(c, core * vA);
  }
`;
const MIST_FRAG = /* glsl */ `
  varying float vS;
  varying float vA;
  ${GLSL_COLOR}
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    gl_FragColor = vec4(modeColor(vS, 1.0), smoothstep(1.0, 0.3, d) * 0.6);
  }
`;

function gauss() { return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5; }

class Particles {
  constructor(radius, color, mode, s0, kind) {
    const mist = kind === 'mist';
    this.max = mist ? 12000 : 6000;
    this.perPoint = mist ? 10 : 3;
    this.spread = radius * (mist ? 3 : 2.5);
    this.mist = mist;
    this.n = 0;
    this.s = s0;
    this.last = null;
    this.pos = dynAttr(new Float32Array(this.max * 3), 3);
    this.sa = dynAttr(new Float32Array(this.max), 1);
    this.seed = dynAttr(new Float32Array(this.max), 1);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', this.pos);
    this.geo.setAttribute('aS', this.sa);
    this.geo.setAttribute('aSeed', this.seed);
    this.geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: color }, uMode: { value: mode }, uTime: shared.uTime,
        uSize: { value: radius * (mist ? 0.6 : 2.2) }, uPointScale: shared.uPointScale,
        uTwinkle: { value: mist ? 0 : 1 },
      },
      vertexShader: PART_VERT,
      fragmentShader: mist ? MIST_FRAG : SPARK_FRAG,
      ...(mist ? TRANSLUCENT : ADDITIVE),
    });
    this.mesh = new THREE.Points(this.geo, mat);
    this.mesh.frustumCulled = false;
  }

  get full() { return this.n + this.perPoint > this.max; }

  add(p) {
    if (this.full) return;
    if (this.last) this.s += p.distanceTo(this.last);
    else this.last = new THREE.Vector3();
    this.last.copy(p);
    const P = this.pos.array;
    const start = this.n;
    for (let k = 0; k < this.perPoint; k++) {
      if (this.mist) _v.set(gauss(), gauss(), gauss()).multiplyScalar(this.spread);
      else _v.randomDirection().multiplyScalar(this.spread * Math.cbrt(Math.random()));
      P[this.n * 3] = p.x + _v.x;
      P[this.n * 3 + 1] = p.y + _v.y;
      P[this.n * 3 + 2] = p.z + _v.z;
      this.sa.array[this.n] = this.s;
      this.seed.array[this.n] = Math.random();
      this.n++;
    }
    this.geo.setDrawRange(0, this.n);
    markDirty([this.pos, this.sa, this.seed], start, this.perPoint);
  }
}

// ---------- Perles : sphères qui respirent ----------
const PEARL_VERT = /* glsl */ `
  attribute float aS;
  uniform float uTime;
  varying float vS;
  varying vec3 vN;
  varying vec3 vView;
  void main() {
    vS = aS;
    vec4 lp = vec4(position * (1.0 + 0.15 * sin(uTime * 3.0 + aS * 25.0)), 1.0);
    #ifdef USE_INSTANCING
      lp = instanceMatrix * lp;
    #endif
    vec4 mv = modelViewMatrix * lp;
    vN = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;
const PEARL_FRAG = /* glsl */ `
  varying float vS;
  varying vec3 vN;
  varying vec3 vView;
  ${GLSL_COLOR}
  void main() {
    float ndv = abs(dot(normalize(vN), normalize(vView)));
    vec3 c = modeColor(vS, ndv);
    vec3 col = c * (0.25 + 0.75 * ndv) + vec3(pow(ndv, 18.0)) * 0.6 + c * pow(1.0 - ndv, 2.0) * 0.4;
    gl_FragColor = vec4(col, 1.0);
  }
`;

const _m = new THREE.Matrix4();
const pearlBase = new THREE.SphereGeometry(1, 16, 12);

class Pearls {
  constructor(radius, color, mode, s0) {
    this.max = 800;
    this.r = radius;
    this.spacing = radius * 2.6;
    this.n = 0;
    this.s = s0;
    this.last = null;
    this.lastPearl = new THREE.Vector3();
    this.geo = pearlBase.clone();
    this.sa = new THREE.InstancedBufferAttribute(new Float32Array(this.max), 1).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('aS', this.sa);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: color }, uMode: { value: mode }, uTime: shared.uTime },
      vertexShader: PEARL_VERT,
      fragmentShader: PEARL_FRAG,
    });
    this.mesh = new THREE.InstancedMesh(this.geo, mat, this.max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  get full() { return this.n >= this.max; }

  add(p) {
    if (this.full) return;
    if (this.last) this.s += p.distanceTo(this.last);
    else this.last = new THREE.Vector3();
    this.last.copy(p);
    if (this.n > 0 && p.distanceTo(this.lastPearl) < this.spacing) return;
    this.lastPearl.copy(p);
    _m.makeScale(this.r, this.r, this.r).setPosition(p);
    this.mesh.setMatrixAt(this.n, _m);
    this.sa.array[this.n] = this.s;
    markDirty([this.mesh.instanceMatrix, this.sa], this.n, 1);
    this.n++;
    this.mesh.count = this.n;
  }
}

// ---------- Fabrique ----------
function combine(object, parts) {
  return {
    object,
    add(p, orient) { for (const part of parts) part.add(p, orient); },
    update(dt, pressing) { for (const part of parts) part.update?.(dt, pressing); },
    get full() { return parts.some((part) => part.full); },
    get s() { return parts[0].s; },
  };
}

function glowTubes(radius, col, mode, s0, zap = 0) {
  const core = new Tube(radius * (zap ? 0.3 : 0.4), 6, material(FRAG.neonCore, col, mode, { zap }), s0);
  const halo = new Tube(radius * 1.8, 10, material(FRAG.neonHalo, col, mode, {
    zap, extra: { ...ADDITIVE, side: THREE.FrontSide },
  }), s0);
  halo.mesh.renderOrder = 1;
  const g = new THREE.Group();
  g.add(core.mesh, halo.mesh);
  return combine(g, [core, halo]);
}

function ribbonStroke(width, frag, col, mode, s0, opts) {
  const r = new Ribbon(width, material(frag, col, mode, opts), s0);
  return combine(r.mesh, [r]);
}

// Décalage au-dessus de la surface réelle pour que le trait soit posé dessus
export function liftFor(brush, radius) {
  if (brush === 'eclair') return radius;
  if (brush === 'etincelles') return radius * 1.5;
  if (brush === 'perles') return radius * 1.2;
  return 0.0015;
}

export function createStroke(brush, { color, mode = 'solid', radius, s0 = 0, surface = false }) {
  const col = new THREE.Color().setStyle(color, THREE.LinearSRGBColorSpace);
  const m = MODE_INDEX[mode] ?? 0;
  if (surface) surfaceStrokeCount++;
  const flat = { surface };
  switch (brush) {
    case 'neon':
      if (!surface) return glowTubes(radius, col, m, s0);
      return ribbonStroke(radius * 3.2, FRAG.neonFlat, col, m, s0, { surface, extra: ADDITIVE });
    case 'peinture': {
      if (surface) return ribbonStroke(radius * 2.4, FRAG.peintureFlat, col, m, s0, flat);
      const t = new Tube(radius, 10, material(FRAG.peinture, col, m), s0);
      return combine(t.mesh, [t]);
    }
    case 'bombe': {
      if (surface) {
        const sp = new Spray(radius, col, m, s0);
        return combine(sp.group, [sp]);
      }
      const mist = new Particles(radius, col, m, s0, 'mist');
      return combine(mist.mesh, [mist]);
    }
    case 'craie':
      return ribbonStroke(radius * 2.5, FRAG.craie, col, m, s0, flat);
    case 'ruban':
      return ribbonStroke(radius * 4, FRAG.ruban, col, m, s0, flat);
    case 'flamme':
      return ribbonStroke(radius * 5, FRAG.flamme, col, m, s0, { surface, extra: ADDITIVE });
    case 'eclair':
      return glowTubes(radius, col, m, s0, radius * 2.5);
    case 'pointilles': {
      if (surface) return ribbonStroke(radius * 1.6, FRAG.pointilles, col, m, s0, flat);
      const t = new Tube(radius * 0.7, 8, material(FRAG.pointilles, col, m), s0);
      return combine(t.mesh, [t]);
    }
    case 'etincelles': {
      const sp = new Particles(radius, col, m, s0, 'spark');
      return combine(sp.mesh, [sp]);
    }
    case 'perles': {
      const pe = new Pearls(radius * 1.2, col, m, s0);
      return combine(pe.mesh, [pe]);
    }
    default:
      throw new Error(`Pinceau inconnu : ${brush}`);
  }
}

export function disposeObject(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
}
