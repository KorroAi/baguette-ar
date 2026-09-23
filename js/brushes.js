// Pinceaux : chaque trait est une géométrie pré-allouée qu'on remplit point par point.
// Les couleurs sont passées en valeurs sRGB brutes (pas de conversion de gestion des couleurs)
// et les ShaderMaterial écrivent directement à l'écran.
import * as THREE from 'three';

export const shared = {
  uTime: { value: 0 },
  uPointScale: { value: 900 }, // pixels par mètre à 1 m de distance (pour la taille des particules)
};

const MAX_POINTS = 2500;

const GLSL_COLOR = /* glsl */ `
  uniform vec3 uColor;
  uniform float uRainbow;
  uniform float uTime;
  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }
  vec3 baseColor(float s) {
    vec3 rb = hsv2rgb(vec3(fract(s * 2.0 - uTime * 0.25), 0.85, 1.0));
    return mix(uColor, rb, uRainbow);
  }
`;

const SURFACE_VERT = /* glsl */ `
  attribute float aS;
  attribute float aAcross;
  varying float vS;
  varying float vAcross;
  varying vec3 vN;
  varying vec3 vView;
  void main() {
    vS = aS;
    vAcross = aAcross;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const SURFACE_HEAD = /* glsl */ `
  varying float vS;
  varying float vAcross;
  varying vec3 vN;
  varying vec3 vView;
  ${GLSL_COLOR}
  float facing() {
    vec3 n = normalize(vN);
    return abs(dot(n, normalize(vView)));
  }
`;

const FRAG = {
  peinture: /* glsl */ `${SURFACE_HEAD}
    void main() {
      float ndv = facing();
      vec3 c = baseColor(vS);
      vec3 col = c * (0.35 + 0.65 * ndv) + vec3(pow(ndv, 24.0)) * 0.3;
      gl_FragColor = vec4(col, 1.0);
    }`,
  neonCore: /* glsl */ `${SURFACE_HEAD}
    void main() {
      gl_FragColor = vec4(mix(baseColor(vS), vec3(1.0), 0.6), 1.0);
    }`,
  neonHalo: /* glsl */ `${SURFACE_HEAD}
    void main() {
      float ndv = facing();
      float pulse = 0.65 + 0.35 * sin(uTime * 4.0 - vS * 30.0);
      gl_FragColor = vec4(baseColor(vS), pow(ndv, 1.2) * 0.6 * pulse);
    }`,
  pointilles: /* glsl */ `${SURFACE_HEAD}
    void main() {
      if (fract(vS * 28.0 - uTime * 1.2) > 0.55) discard;
      float ndv = facing();
      vec3 col = baseColor(vS) * (0.5 + 0.5 * ndv) + vec3(0.25 * ndv);
      gl_FragColor = vec4(col, 1.0);
    }`,
  ruban: /* glsl */ `${SURFACE_HEAD}
    void main() {
      float ndv = facing();
      float edge = smoothstep(0.0, 0.18, vAcross) * smoothstep(1.0, 0.82, vAcross);
      float shimmer = 0.85 + 0.15 * sin(vS * 40.0 - uTime * 3.0);
      vec3 col = baseColor(vS) * (0.45 + 0.55 * ndv) * mix(0.55, 1.0, edge) * shimmer;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

function surfaceMaterial(frag, color, rainbow, extra = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color }, uRainbow: { value: rainbow }, uTime: shared.uTime },
    vertexShader: SURFACE_VERT,
    fragmentShader: frag,
    side: THREE.DoubleSide,
    ...extra,
  });
}

const _t = new THREE.Vector3();
const _b = new THREE.Vector3();
const _v = new THREE.Vector3();
const _side = new THREE.Vector3();
const _n = new THREE.Vector3();

function perpendicular(t, out) {
  const axis = Math.abs(t.y) < 0.9 ? _v.set(0, 1, 0) : _v.set(1, 0, 0);
  return out.crossVectors(t, axis).normalize();
}

function dynAttr(array, itemSize) {
  return new THREE.BufferAttribute(array, itemSize).setUsage(THREE.DynamicDrawUsage);
}

function markDirty(attrs, start, count) {
  for (const a of attrs) {
    a.addUpdateRange(start * a.itemSize, count * a.itemSize);
    a.needsUpdate = true;
  }
}

// ---------- Tube (néon, peinture, pointillés) ----------
class Tube {
  constructor(radius, radial, material, s0) {
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
    this.mesh = new THREE.Mesh(this.geo, material);
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

// ---------- Ruban plat, toujours tourné vers le téléphone ----------
class Ribbon {
  constructor(width, material, s0) {
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
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
  }

  get full() { return this.n >= MAX_POINTS; }

  add(p, fwd) {
    if (this.full) return;
    if (this.n === 0) { this.last.copy(p); this.n = 1; return; }
    _t.subVectors(p, this.last);
    const len = _t.length();
    if (len < 1e-5) return;
    _t.divideScalar(len);

    _side.crossVectors(_t, fwd);
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

// ---------- Étincelles : particules qui scintillent ----------
const SPARK_VERT = /* glsl */ `
  attribute float aS;
  attribute float aSeed;
  uniform float uTime;
  uniform float uSize;
  uniform float uPointScale;
  varying float vS;
  varying float vA;
  void main() {
    vS = aS;
    vec3 p = position + vec3(
      sin(uTime * 1.3 + aSeed * 40.0),
      cos(uTime * 1.1 + aSeed * 23.0),
      sin(uTime * 0.9 + aSeed * 57.0)) * 0.003;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float tw = 0.5 + 0.5 * sin(uTime * (2.0 + aSeed * 4.0) + aSeed * 60.0);
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
    vec3 c = mix(baseColor(vS), vec3(1.0), 0.5 * core);
    gl_FragColor = vec4(c, core * vA);
  }
`;

class Sparkles {
  constructor(radius, color, rainbow, s0) {
    this.max = 6000;
    this.perPoint = 3;
    this.spread = radius * 2.5;
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
        uColor: { value: color }, uRainbow: { value: rainbow }, uTime: shared.uTime,
        uSize: { value: radius * 2.2 }, uPointScale: shared.uPointScale,
      },
      vertexShader: SPARK_VERT,
      fragmentShader: SPARK_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
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
      _v.randomDirection().multiplyScalar(this.spread * Math.cbrt(Math.random()));
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
    vec3 c = baseColor(vS);
    vec3 col = c * (0.25 + 0.75 * ndv) + vec3(pow(ndv, 18.0)) * 0.6 + c * pow(1.0 - ndv, 2.0) * 0.4;
    gl_FragColor = vec4(col, 1.0);
  }
`;

const _m = new THREE.Matrix4();
const pearlBase = new THREE.SphereGeometry(1, 16, 12);

class Pearls {
  constructor(radius, color, rainbow, s0) {
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
      uniforms: { uColor: { value: color }, uRainbow: { value: rainbow }, uTime: shared.uTime },
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
    add(p, fwd) { for (const part of parts) part.add(p, fwd); },
    get full() { return parts.some((part) => part.full); },
    get s() { return parts[0].s; },
  };
}

export function createStroke(brush, { color, rainbow, radius, s0 = 0 }) {
  const col = new THREE.Color().setStyle(color, THREE.LinearSRGBColorSpace);
  const rb = rainbow ? 1 : 0;
  switch (brush) {
    case 'neon': {
      const core = new Tube(radius * 0.4, 6, surfaceMaterial(FRAG.neonCore, col, rb), s0);
      const halo = new Tube(radius * 1.8, 10, surfaceMaterial(FRAG.neonHalo, col, rb, {
        side: THREE.FrontSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      }), s0);
      halo.mesh.renderOrder = 1;
      const g = new THREE.Group();
      g.add(core.mesh, halo.mesh);
      return combine(g, [core, halo]);
    }
    case 'peinture': {
      const t = new Tube(radius, 10, surfaceMaterial(FRAG.peinture, col, rb), s0);
      return combine(t.mesh, [t]);
    }
    case 'pointilles': {
      const t = new Tube(radius * 0.7, 8, surfaceMaterial(FRAG.pointilles, col, rb), s0);
      return combine(t.mesh, [t]);
    }
    case 'ruban': {
      const r = new Ribbon(radius * 4, surfaceMaterial(FRAG.ruban, col, rb), s0);
      return combine(r.mesh, [r]);
    }
    case 'etincelles': {
      const sp = new Sparkles(radius, col, rb, s0);
      return combine(sp.mesh, [sp]);
    }
    case 'perles': {
      const pe = new Pearls(radius * 1.2, col, rb, s0);
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
