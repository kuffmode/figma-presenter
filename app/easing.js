// Figma transition curves. Each returns progress for a time in seconds (springs may overshoot 1).
const SPRINGS = { GENTLE: [100, 15, 1], QUICK: [300, 20, 1], BOUNCY: [600, 15, 1], SLOW: [80, 20, 1] };
const BEZIERS = {
  LINEAR: [0, 0, 1, 1], EASE_IN: [0.42, 0, 1, 1], EASE_OUT: [0, 0, 0.58, 1], EASE_IN_AND_OUT: [0.42, 0, 0.58, 1],
  EASE_IN_BACK: [0.3, -0.05, 0.7, -0.5], EASE_OUT_BACK: [0.45, 1.45, 0.8, 1], EASE_IN_AND_OUT_BACK: [0.7, -0.4, 0.4, 1.4],
};

function spring([stiffness, damping, mass]) {
  const w0 = Math.sqrt(stiffness / mass), zeta = damping / (2 * Math.sqrt(stiffness * mass));
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return s => 1 - Math.exp(-zeta * w0 * s) * (Math.cos(wd * s) + (zeta * w0 / wd) * Math.sin(wd * s));
  }
  return s => 1 - Math.exp(-w0 * s) * (1 + w0 * s);
}

function bezier([x1, y1, x2, y2]) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const fx = t => ((ax * t + bx) * t + cx) * t, fy = t => ((ay * t + by) * t + cy) * t;
  return x => {
    let lo = 0, hi = 1, t = x;
    for (let i = 0; i < 24; i++) { const v = fx(t); if (Math.abs(v - x) < 1e-5) break; if (v < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    return fy(t);
  };
}

export function curve(name, duration) {
  if (SPRINGS[name]) return spring(SPRINGS[name]);
  const f = bezier(BEZIERS[name] || BEZIERS.EASE_IN_AND_OUT);
  return s => f(Math.min(1, Math.max(0, s / Math.max(duration, 1e-3))));
}
