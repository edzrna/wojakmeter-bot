'use strict';

// ===============================
// WOJAKMETER — HEX TOPOLOGY (v2)
//
// Neutral at the centre, six states on a closed ring. The ring is
// the old linear scale with its ends joined and neutral lifted out
// of the middle:
//
//   ring:  doubt · optimism · content · euphoria · frustration · concern
//
//   seams: optimism ↔ doubt        a calm market flips side with no neutral pause
//          euphoria ↔ frustration  the violent extremes touch
//
// v1 drew the figure; v2 gives it axes, so a cell is something you
// measure instead of a label you assign:
//
//   x = direction  (breadth: share of the universe up over 24 h)
//   y = intensity  (last hour's movement against the same hour over
//                   the previous 30 days; positive = more violent)
//
//                   calm
//             doubt      optimism
//   falling  concern  (neutral)  content   rising
//          frustration      euphoria
//                  violent
//
// Cell centres sit at unit distance, pointy-top. A point belongs to
// the nearest centre, so the drawing and the classifier are the same
// object: the neutral region IS the central hexagon (inradius 0.5).
// Same graph as v1 — every hex distance is unchanged — the figure is
// only turned 30° so the seams line up with the intensity axis.
// ===============================

const CENTRE = 'neutral';

// Ring order, walking round the figure
const RIM = ['doubt', 'optimism', 'content', 'euphoria', 'frustration', 'concern'];

const ALL = [CENTRE, ...RIM];

// The old scale, kept so the lab can compare the two head to head
const LINEAR = ['frustration', 'concern', 'doubt', 'neutral', 'optimism', 'content', 'euphoria'];

// Which side of the market each state is on
const VALENCE = {
  euphoria: 1, content: 1, optimism: 1,
  neutral: 0,
  doubt: -1, concern: -1, frustration: -1
};

// Axial coordinates, pointy-top. In the (direction, intensity) plane:
//   x = q + r / 2,  y = (√3 / 2) · r      (y grows toward "violent")
const AXIAL = {
  neutral:     { q:  0, r:  0 },
  content:     { q:  1, r:  0 },
  euphoria:    { q:  0, r:  1 },
  frustration: { q: -1, r:  1 },
  concern:     { q: -1, r:  0 },
  doubt:       { q:  0, r: -1 },
  optimism:    { q:  1, r: -1 }
};

const SQRT3_2 = Math.sqrt(3) / 2;
const CELL_RADIUS = 1 / Math.sqrt(3); // circumradius that makes unit-spaced hexagons tile
const NEUTRAL_LIMIT = 0.5;            // inradius of the centre cell
const EPS = 1e-12;

function isValid(mood) {
  return Object.prototype.hasOwnProperty.call(AXIAL, mood);
}

function centre(mood) {
  const { q, r } = AXIAL[mood];
  return { x: q + r / 2, y: SQRT3_2 * r };
}

function hexDistance(a, b) {
  if (!isValid(a) || !isValid(b)) return null;
  const dq = AXIAL[a].q - AXIAL[b].q;
  const dr = AXIAL[a].r - AXIAL[b].r;
  return (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2;
}

function linearDistance(a, b) {
  const i = LINEAR.indexOf(a);
  const j = LINEAR.indexOf(b);
  if (i < 0 || j < 0) return null;
  return Math.abs(j - i);
}

// Steps around the ring, ignoring the centre entirely
function rimDistance(a, b) {
  const i = RIM.indexOf(a);
  const j = RIM.indexOf(b);
  if (i < 0 || j < 0) return null;
  const forward = (j - i + RIM.length) % RIM.length;
  return Math.min(forward, RIM.length - forward);
}

// ===============================
// CLASSIFIER
// ===============================

const DIRECTIONS = RIM.map(mood => ({ mood, ...centre(mood) }));

// On an exact tie (a point on a seam), prefer the cell on the same
// side of the market as the point, then the cell on the same side of
// the intensity axis. Deterministic, so the same snapshot always
// lands in the same cell.
function prefers(a, b, x, y) {
  const sx = x >= 0 ? 1 : -1;
  const sy = y >= 0 ? 1 : -1;
  const ax = Math.sign(a.x) * sx;
  const bx = Math.sign(b.x) * sx;
  if (ax !== bx) return ax > bx;
  return Math.sign(a.y) * sy > Math.sign(b.y) * sy;
}

// Nearest centre. For unit-spaced centres that is the direction with
// the largest projection, and the centre cell wins while every
// projection stays within its inradius.
function classifyPoint(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  let best = null;
  for (const d of DIRECTIONS) {
    const p = x * d.x + y * d.y;
    if (!best || p > best.p + EPS || (Math.abs(p - best.p) <= EPS && prefers(d, best.d, x, y))) {
      best = { p, d };
    }
  }

  return best.p <= NEUTRAL_LIMIT + EPS ? CENTRE : best.d.mood;
}

// The same classifier with a dead band: a cell is kept until the point
// is `margin` past the boundary, measured on the same projection the
// classifier uses. Without it, a reading sitting on a seam flips cell
// on measurement noise alone and every flip counts as a transition.
function classifyPointSticky(x, y, previous, margin = 0) {
  const fresh = classifyPoint(x, y);
  if (!margin || fresh === null || !isValid(previous) || fresh === previous) return fresh;

  let best = null;
  for (const d of DIRECTIONS) {
    const p = x * d.x + y * d.y;
    if (!best || p > best.p) best = { p, mood: d.mood };
  }

  // Inside the neutral region: leave a rim cell only once clearly in
  if (best.p <= NEUTRAL_LIMIT + EPS) {
    return best.p <= NEUTRAL_LIMIT - margin ? CENTRE : previous;
  }

  // Coming out of neutral: the point must be clearly out
  if (previous === CENTRE) return best.p > NEUTRAL_LIMIT + margin ? best.mood : CENTRE;

  const c = centre(previous);
  const pPrev = x * c.x + y * c.y;
  return best.p > pPrev + margin ? best.mood : previous;
}

// ===============================
// TRANSITIONS
// ===============================

function transitionKind(from, to) {
  if (!isValid(from) || !isValid(to)) return 'unknown';
  if (from === to) return 'none';
  if (from === CENTRE) return 'expansion';      // left neutral: tension building
  if (to === CENTRE) return 'decompression';    // back to neutral: tension released
  const rim = rimDistance(from, to);
  if (rim === 1) return 'drift';                // adjacent rim states
  return rim === 3 ? 'inversion' : 'rotation';  // across the lattice / two rim steps
}

// Everything the desk needs to draw the lattice, served by the API so
// the browser never keeps its own copy of the geometry.
function geometry() {
  const cells = {};
  for (const mood of ALL) cells[mood] = centre(mood);
  return {
    cells,
    ring: RIM.slice(),
    cellRadius: CELL_RADIUS,
    neutralLimit: NEUTRAL_LIMIT,
    orientation: 'pointy-top',
    axes: {
      x: 'direction: breadth, share of the universe up over 24 h (right = rising)',
      y: 'intensity: last hour against the same hour over 30 days (down = more violent)'
    }
  };
}

module.exports = {
  CENTRE,
  RIM,
  ALL,
  LINEAR,
  VALENCE,
  AXIAL,
  CELL_RADIUS,
  NEUTRAL_LIMIT,
  isValid,
  centre,
  hexDistance,
  linearDistance,
  rimDistance,
  classifyPoint,
  classifyPointSticky,
  transitionKind,
  geometry
};
