export type Vec3 = [number, number, number];
/** Row-major 3x3 rotation matrix: [R00, R01, R02, R10, R11, R12, R20, R21, R22]. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];
export type RGB = [number, number, number];

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const DEG = Math.PI / 180;

export function mul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}

export function rotX(rad: number): Mat3 {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}
export function rotY(rad: number): Mat3 {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}
export function rotZ(rad: number): Mat3 {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/** Same convention as Roblox CFrame.Angles / fromEulerAnglesXYZ and three.js Euler "XYZ": R = Rx * Ry * Rz. */
export function eulerXYZDeg(rot: Vec3 | undefined): Mat3 {
  if (!rot || (rot[0] === 0 && rot[1] === 0 && rot[2] === 0)) return [...IDENTITY];
  return mul(mul(rotX(rot[0] * DEG), rotY(rot[1] * DEG)), rotZ(rot[2] * DEG));
}

/** Inverse of eulerXYZDeg (matches CFrame:ToEulerAnglesXYZ). */
export function matToEulerXYZDeg(m: Mat3): Vec3 {
  const r02 = Math.max(-1, Math.min(1, m[2]));
  const y = Math.asin(r02);
  let x: number, z: number;
  if (Math.abs(r02) < 0.9999999) {
    x = Math.atan2(-m[5], m[8]);
    z = Math.atan2(-m[1], m[0]);
  } else {
    x = Math.atan2(m[7], m[4]);
    z = 0;
  }
  return [x / DEG, y / DEG, z / DEG];
}

export function applyMat(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function transpose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function isIdentity(m: Mat3, eps = 1e-9): boolean {
  return m.every((v, i) => Math.abs(v - IDENTITY[i]) < eps);
}

export function matEquals(a: Mat3, b: Mat3, eps = 1e-6): boolean {
  return a.every((v, i) => Math.abs(v - b[i]) < eps);
}

/** Round to a fixed number of decimals and strip "-0". */
export function round(n: number, decimals = 4): number {
  const f = 10 ** decimals;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

export function hexToRgb(hex: string): RGB {
  const h = hex.replace(/^#/, "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  if (!/^[0-9a-fA-F]{6}$/.test(full) || Number.isNaN(n)) return [163, 162, 165];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: RGB): string {
  return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
