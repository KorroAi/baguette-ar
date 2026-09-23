// Formes prêtes à poser. Coordonnées locales pour une taille unitaire (~1 de large) :
// x = droite, y = haut, z = profondeur (vers l'avant du téléphone).
const TAU = Math.PI * 2;

function sample(fn, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(fn(i / n));
  return pts;
}

function polyline(vertices, stepsPerEdge) {
  const pts = [];
  for (let i = 0; i < vertices.length - 1; i++) {
    const [ax, ay, az] = vertices[i];
    const [bx, by, bz] = vertices[i + 1];
    for (let k = 0; k < stepsPerEdge; k++) {
      const u = k / stepsPerEdge;
      pts.push([ax + (bx - ax) * u, ay + (by - ay) * u, az + (bz - az) * u]);
    }
  }
  pts.push(vertices[vertices.length - 1]);
  return pts;
}

export const SHAPES = [
  {
    id: 'cercle',
    label: 'Cercle',
    points: () => sample((u) => [0.5 * Math.cos(u * TAU), 0.5 * Math.sin(u * TAU), 0], 240),
  },
  {
    id: 'etoile',
    label: 'Étoile',
    points: () => {
      const v = [];
      for (let i = 0; i <= 10; i++) {
        const r = i % 2 ? 0.2 : 0.5;
        const a = Math.PI / 2 + (i * TAU) / 10;
        v.push([r * Math.cos(a), r * Math.sin(a), 0]);
      }
      return polyline(v, 30);
    },
  },
  {
    id: 'coeur',
    label: 'Cœur',
    points: () => sample((u) => {
      const t = u * TAU;
      const x = 16 * Math.sin(t) ** 3;
      const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      return [x / 32, y / 32 + 0.05, 0];
    }, 300),
  },
  {
    id: 'spirale',
    label: 'Spirale',
    points: () => sample((u) => {
      const a = u * TAU * 4;
      return [0.5 * u * Math.cos(a), 0.5 * u * Math.sin(a), 0];
    }, 500),
  },
  {
    id: 'infini',
    label: 'Infini',
    points: () => sample((u) => {
      const t = u * TAU;
      const d = 1 + Math.sin(t) ** 2;
      return [(0.55 * Math.cos(t)) / d, (0.55 * Math.sin(t) * Math.cos(t)) / d, 0];
    }, 300),
  },
  {
    id: 'helice',
    label: 'Hélice',
    points: () => sample((u) => {
      const a = u * TAU * 5;
      return [0.25 * Math.cos(a), 0.25 * Math.sin(a), u * 1.5];
    }, 600),
  },
];
