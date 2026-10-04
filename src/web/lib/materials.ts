// Roblox-style materials for three.js. Each Enum.Material gets a procedural,
// tileable texture (multiplied by the part color, like Roblox) plus PBR settings.
import * as THREE from "three";
import type { MaterialName } from "../../shared/roblox-data.ts";

type Pattern =
  | "none" | "plastic" | "grain" | "planks" | "brick" | "cobble" | "stone" | "marble" | "speckle"
  | "diamond" | "brushed" | "rust" | "weave" | "tiles" | "roof" | "shingles" | "cracks" | "concrete" | "leather";

interface MatDef {
  pattern: Pattern;
  rough: number;
  metal: number;
  /** Studs covered by one texture repeat. */
  tile: number;
  bump?: number;
}

const DEFS: Record<MaterialName, MatDef> = {
  Plastic: { pattern: "plastic", rough: 0.55, metal: 0, tile: 4, bump: 0.15 },
  SmoothPlastic: { pattern: "none", rough: 0.42, metal: 0, tile: 4 },
  Neon: { pattern: "none", rough: 0.4, metal: 0, tile: 4 },
  Wood: { pattern: "grain", rough: 0.72, metal: 0, tile: 4, bump: 0.6 },
  WoodPlanks: { pattern: "planks", rough: 0.7, metal: 0, tile: 4, bump: 1 },
  Marble: { pattern: "marble", rough: 0.25, metal: 0, tile: 6, bump: 0.2 },
  Basalt: { pattern: "stone", rough: 0.85, metal: 0, tile: 6, bump: 1.2 },
  Slate: { pattern: "stone", rough: 0.8, metal: 0, tile: 5, bump: 1 },
  CrackedLava: { pattern: "cracks", rough: 0.8, metal: 0, tile: 6, bump: 1 },
  Concrete: { pattern: "concrete", rough: 0.88, metal: 0, tile: 5, bump: 0.6 },
  Limestone: { pattern: "concrete", rough: 0.85, metal: 0, tile: 6, bump: 0.5 },
  Granite: { pattern: "speckle", rough: 0.6, metal: 0, tile: 4, bump: 0.5 },
  Pavement: { pattern: "tiles", rough: 0.85, metal: 0, tile: 6, bump: 0.8 },
  Brick: { pattern: "brick", rough: 0.85, metal: 0, tile: 4, bump: 1.2 },
  Pebble: { pattern: "cobble", rough: 0.8, metal: 0, tile: 3, bump: 1 },
  Cobblestone: { pattern: "cobble", rough: 0.85, metal: 0, tile: 5, bump: 1.4 },
  Rock: { pattern: "stone", rough: 0.9, metal: 0, tile: 7, bump: 1.4 },
  Sandstone: { pattern: "concrete", rough: 0.85, metal: 0, tile: 6, bump: 0.7 },
  CorrodedMetal: { pattern: "rust", rough: 0.75, metal: 0.55, tile: 4, bump: 0.8 },
  DiamondPlate: { pattern: "diamond", rough: 0.4, metal: 0.85, tile: 2, bump: 1.2 },
  Foil: { pattern: "brushed", rough: 0.25, metal: 1, tile: 4, bump: 0.2 },
  Metal: { pattern: "brushed", rough: 0.38, metal: 0.85, tile: 4, bump: 0.15 },
  Grass: { pattern: "speckle", rough: 0.95, metal: 0, tile: 4, bump: 0.8 },
  LeafyGrass: { pattern: "speckle", rough: 0.95, metal: 0, tile: 5, bump: 1 },
  Sand: { pattern: "speckle", rough: 0.95, metal: 0, tile: 3, bump: 0.4 },
  Fabric: { pattern: "weave", rough: 0.95, metal: 0, tile: 1.5, bump: 0.6 },
  Snow: { pattern: "speckle", rough: 0.9, metal: 0, tile: 4, bump: 0.3 },
  Mud: { pattern: "stone", rough: 0.8, metal: 0, tile: 6, bump: 0.8 },
  Ground: { pattern: "speckle", rough: 0.95, metal: 0, tile: 5, bump: 0.7 },
  Asphalt: { pattern: "speckle", rough: 0.9, metal: 0, tile: 3, bump: 0.5 },
  Salt: { pattern: "speckle", rough: 0.8, metal: 0, tile: 3, bump: 0.4 },
  Ice: { pattern: "cracks", rough: 0.1, metal: 0, tile: 8, bump: 0.2 },
  Glacier: { pattern: "cracks", rough: 0.2, metal: 0, tile: 8, bump: 0.4 },
  Glass: { pattern: "none", rough: 0.05, metal: 0, tile: 4 },
  ForceField: { pattern: "none", rough: 0.2, metal: 0, tile: 4 },
  Cardboard: { pattern: "concrete", rough: 0.9, metal: 0, tile: 3, bump: 0.3 },
  Carpet: { pattern: "weave", rough: 1, metal: 0, tile: 1, bump: 0.8 },
  CeramicTiles: { pattern: "tiles", rough: 0.3, metal: 0, tile: 3, bump: 0.6 },
  ClayRoofTiles: { pattern: "roof", rough: 0.75, metal: 0, tile: 4, bump: 1.2 },
  RoofShingles: { pattern: "shingles", rough: 0.85, metal: 0, tile: 4, bump: 1 },
  Leather: { pattern: "leather", rough: 0.6, metal: 0, tile: 2, bump: 0.6 },
  Plaster: { pattern: "concrete", rough: 0.92, metal: 0, tile: 4, bump: 0.3 },
  Rubber: { pattern: "plastic", rough: 0.9, metal: 0, tile: 3, bump: 0.2 },
};

export function tileOf(material: MaterialName): number {
  return DEFS[material]?.tile ?? 4;
}

// --------------------------------------------------------------- procedural

const SIZE = 256;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable value noise. */
function makeNoise(seed: number, period: number) {
  const rand = mulberry32(seed);
  const grid = Array.from({ length: period * period }, rand);
  const at = (x: number, y: number) => grid[((y % period) + period) % period * period + (((x % period) + period) % period)];
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (u: number, v: number) => {
    const x = u * period, y = v * period;
    const xi = Math.floor(x), yi = Math.floor(y);
    const tx = smooth(x - xi), ty = smooth(y - yi);
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
}

function fbm(seed: number, base: number, octaves: number) {
  const layers = Array.from({ length: octaves }, (_, i) => makeNoise(seed + i * 101, base * 2 ** i));
  return (u: number, v: number) => {
    let sum = 0, amp = 0.5, norm = 0;
    for (const n of layers) {
      sum += n(u, v) * amp;
      norm += amp;
      amp *= 0.5;
    }
    return sum / norm;
  };
}

type Shade = (u: number, v: number, x: number, y: number) => number | [number, number, number];

function paint(shade: Shade): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const s = shade(x / SIZE, y / SIZE, x, y);
      const [r, g, b] = typeof s === "number" ? [s, s, s] : s;
      const i = (y * SIZE + x) * 4;
      img.data[i] = Math.max(0, Math.min(255, r * 255));
      img.data[i + 1] = Math.max(0, Math.min(255, g * 255));
      img.data[i + 2] = Math.max(0, Math.min(255, b * 255));
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

const frac = (x: number) => x - Math.floor(x);

function shader(pattern: Pattern): Shade {
  const n1 = fbm(7, 4, 4);
  const n2 = fbm(13, 8, 3);
  const fine = makeNoise(29, 64);
  switch (pattern) {
    case "plastic":
      return (u, v) => 0.93 + fine(u, v) * 0.07;
    case "grain":
      return (u, v) => {
        const w = Math.sin((u * 18 + n1(u, v) * 3.5) * Math.PI);
        return 0.78 + w * 0.08 + fine(u * 0.5, v * 4) * 0.12;
      };
    case "planks": {
      const rand = mulberry32(3);
      const tones = Array.from({ length: 16 }, () => 0.82 + rand() * 0.16);
      return (u, v) => {
        const row = Math.floor(v * 4);
        const offset = (row % 2) * 0.5;
        const col = Math.floor(u + offset);
        const seam = frac(v * 4) < 0.035 || frac(u + offset) < 0.008 ? 0.45 : 1;
        const grain = Math.sin((v * 4 * 9 + n1(u, v) * 2.5) * Math.PI) * 0.05;
        return (tones[(row * 3 + col) % 16] + grain + fine(u * 3, v * 0.6) * 0.06) * seam;
      };
    }
    case "brick":
      return (u, v) => {
        const rows = 8;
        const row = Math.floor(v * rows);
        const uu = frac(u * 4 + (row % 2) * 0.5);
        const mortar = frac(v * rows) < 0.1 || uu < 0.04;
        const tone = 0.8 + makeNoiseCache(row * 7 + Math.floor(u * 4 + (row % 2) * 0.5)) * 0.18;
        return mortar ? 1.25 - n2(u, v) * 0.15 : tone - n2(u, v) * 0.12;
      };
    case "cobble": {
      const rand = mulberry32(11);
      const pts = Array.from({ length: 22 }, () => [rand(), rand(), 0.8 + rand() * 0.2]);
      return (u, v) => {
        let d1 = 9, d2 = 9, tone = 1;
        for (const [px, py, t] of pts) {
          for (const ox of [-1, 0, 1]) for (const oy of [-1, 0, 1]) {
            const dx = u - px - ox, dy = v - py - oy;
            const d = dx * dx + dy * dy;
            if (d < d1) {
              d2 = d1;
              d1 = d;
              tone = t;
            } else if (d < d2) d2 = d;
          }
        }
        const edge = Math.sqrt(d2) - Math.sqrt(d1);
        return (edge < 0.012 ? 0.45 : tone - n2(u, v) * 0.12) + fine(u, v) * 0.04;
      };
    }
    case "stone":
      return (u, v) => 0.68 + n1(u, v) * 0.32 + (fine(u, v) - 0.5) * 0.08;
    case "marble":
      return (u, v) => {
        const vein = Math.abs(Math.sin((u * 3 + v * 2 + n1(u, v) * 4) * Math.PI));
        return 0.86 + Math.pow(vein, 0.25) * 0.14 - (vein < 0.06 ? 0.25 : 0);
      };
    case "speckle":
      return (u, v) => 0.8 + n2(u, v) * 0.14 + (fine(u * 4, v * 4) - 0.5) * 0.18;
    case "diamond":
      return (u, v) => {
        const a = frac(u * 4 + v * 4), b = frac(u * 4 - v * 4);
        const raised = Math.abs(a - 0.5) < 0.12 && Math.abs(b - 0.5) < 0.38;
        return (raised ? 1.05 : 0.8) + fine(u * 2, v * 2) * 0.06;
      };
    case "brushed":
      return (u, v) => 0.86 + fine(u * 0.05, v * 6) * 0.12 + n2(u, v) * 0.04;
    case "rust":
      return (u, v) => {
        const r = n1(u, v);
        if (r > 0.55) {
          const k = Math.min(1, (r - 0.55) * 4);
          return [0.85 + k * 0.1, 0.78 - k * 0.25, 0.7 - k * 0.4];
        }
        return 0.85 + fine(u, v) * 0.1;
      };
    case "weave":
      return (u, v) => {
        const a = Math.sin(u * 64 * Math.PI) * Math.sin(v * 64 * Math.PI);
        return 0.86 + a * 0.08 + fine(u * 2, v * 2) * 0.06;
      };
    case "tiles":
      return (u, v) => (frac(u * 4) < 0.04 || frac(v * 4) < 0.04 ? 0.6 : 0.95 - n2(u, v) * 0.08);
    case "roof":
      return (u, v) => {
        const row = Math.floor(v * 6);
        const uu = frac(u * 6 + (row % 2) * 0.5);
        const curve = Math.cos((uu - 0.5) * Math.PI);
        const shade = 0.68 + curve * 0.3 * (0.6 + frac(v * 6) * 0.4);
        return frac(v * 6) > 0.92 ? 0.45 : shade;
      };
    case "shingles":
      return (u, v) => {
        const row = Math.floor(v * 8);
        const uu = frac(u * 5 + (row % 2) * 0.5);
        const gap = uu < 0.03 || frac(v * 8) > 0.9;
        return gap ? 0.5 : 0.75 + n2(u + row, v) * 0.2;
      };
    case "cracks":
      return (u, v) => {
        const c = Math.abs(n1(u, v) - 0.5);
        return c < 0.015 ? 0.7 : 0.95 + fine(u, v) * 0.05;
      };
    case "concrete":
      return (u, v) => 0.84 + n2(u, v) * 0.1 + (fine(u * 4, v * 4) - 0.5) * 0.08;
    case "leather":
      return (u, v) => 0.82 + Math.abs(n2(u * 2, v * 2) - 0.5) * 0.3;
    default:
      return () => 1;
  }
}

const brickTone = mulberry32(5);
const brickTones = Array.from({ length: 512 }, brickTone);
function makeNoiseCache(i: number) {
  return brickTones[((i % 512) + 512) % 512];
}

const textureCache = new Map<Pattern, THREE.CanvasTexture>();

function textureFor(pattern: Pattern): THREE.CanvasTexture | null {
  if (pattern === "none") return null;
  let t = textureCache.get(pattern);
  if (!t) {
    t = new THREE.CanvasTexture(paint(shader(pattern)));
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    textureCache.set(pattern, t);
  }
  return t;
}

// ----------------------------------------------------------------- materials

const materialCache = new Map<string, THREE.Material>();

export function materialFor(name: MaterialName, rgb: [number, number, number], transparency: number, reflectance: number): THREE.Material {
  const key = `${name}|${rgb.join(",")}|${transparency}|${reflectance}`;
  const hit = materialCache.get(key);
  if (hit) return hit;
  const color = new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
  const def = DEFS[name] ?? DEFS.Plastic;
  const opacity = 1 - transparency;
  let mat: THREE.Material;

  if (name === "Neon") {
    mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0, 0, 0),
      emissive: color,
      emissiveIntensity: 2.4,
      roughness: 0.5,
      transparent: transparency > 0,
      opacity,
    });
  } else if (name === "Glass") {
    mat = new THREE.MeshPhysicalMaterial({
      color,
      roughness: 0.04,
      metalness: 0,
      transparent: true,
      opacity: Math.max(0.12, Math.min(0.85, opacity * 0.7)),
      envMapIntensity: 1.6,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  } else if (name === "ForceField") {
    mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.35 * Math.max(0.2, opacity),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  } else {
    const map = textureFor(def.pattern);
    mat = new THREE.MeshStandardMaterial({
      color,
      map,
      bumpMap: def.bump ? map : null,
      bumpScale: def.bump ?? 0,
      roughness: def.rough * (1 - reflectance * 0.8),
      metalness: Math.max(def.metal, reflectance * 0.6),
      envMapIntensity: 1 + reflectance,
      transparent: transparency > 0,
      opacity,
      depthWrite: transparency < 0.5,
    });
  }
  materialCache.set(key, mat);
  return mat;
}
