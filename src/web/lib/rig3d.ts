// three.js meshes for the R6/R15 dummy rigs, posed from shared/animation.ts forward kinematics.
// They look like Studio's Rig Builder dummies: grey, softly rounded parts, a rounded-cube head,
// the classic smile on R6 and the block rig's neutral face on R15.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { Rig } from "../../shared/animation.ts";
import type { Mat3, Vec3 } from "../../shared/math.ts";
import { markGlow } from "./selective-bloom.ts";

const faces = new Map<string, THREE.CanvasTexture>();

/** "smile" (R6's classic face) or "neutral" (two dot eyes and a flat mouth, R15 block rig). */
function face(kind: "smile" | "neutral"): THREE.CanvasTexture {
  const hit = faces.get(kind);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = g.strokeStyle = "#1a1a1a";
  g.lineCap = "round";
  if (kind === "smile") {
    for (const x of [92, 164]) {
      g.beginPath();
      g.ellipse(x, 100, 14, 26, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.lineWidth = 13;
    g.beginPath();
    g.arc(128, 124, 58, Math.PI * 0.2, Math.PI * 0.8);
    g.stroke();
  } else {
    for (const x of [98, 158]) {
      g.beginPath();
      g.ellipse(x, 104, 10, 18, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.lineWidth = 9;
    g.beginPath();
    g.moveTo(108, 168);
    g.lineTo(148, 168);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  faces.set(kind, tex);
  return tex;
}

export interface RigMeshes {
  group: THREE.Group;
  parts: Map<string, THREE.Object3D>;
  /** Fade a rig built with a look (0 = invisible, 1 = as built). */
  fade: (f: number) => void;
  dispose: () => void;
}

/** A summon's look: Roblox material, colour and transparency for every part. */
export interface RigLook {
  color: string;
  material: "ForceField" | "Neon" | "Glass" | "SmoothPlastic" | "Plastic";
  transparency: number;
}

function lookMaterial(look: RigLook): { material: THREE.Material; opacity: number } {
  const color = new THREE.Color(look.color);
  const shown = 1 - look.transparency;
  switch (look.material) {
    case "ForceField": {
      // Roblox's ForceField material: a glowing, see-through energy shell.
      const opacity = 0.1 + shown * 0.4;
      return { material: markGlow(new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false })), opacity };
    }
    case "Neon":
      return { material: markGlow(new THREE.MeshStandardMaterial({ color: 0x000000, emissive: color, emissiveIntensity: 2.2, transparent: true, opacity: shown })), opacity: shown };
    case "Glass": {
      const opacity = 0.1 + shown * 0.45;
      return { material: new THREE.MeshPhysicalMaterial({ color, roughness: 0.08, transparent: true, opacity, depthWrite: false }), opacity };
    }
    default:
      return { material: new THREE.MeshStandardMaterial({ color, roughness: look.material === "SmoothPlastic" ? 0.6 : 0.8, transparent: true, opacity: shown }), opacity: shown };
  }
}

export function buildRig(rig: Rig, look?: RigLook): RigMeshes {
  const group = new THREE.Group();
  const parts = new Map<string, THREE.Object3D>();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const shared = new Map<string, THREE.MeshStandardMaterial>();
  const looked = look ? lookMaterial(look) : null;
  if (looked) materials.push(looked.material);
  const material = (color: string): THREE.Material => {
    if (looked) return looked.material;
    let m = shared.get(color);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.85, metalness: 0 });
      shared.set(color, m);
      materials.push(m);
    }
    return m;
  };
  const faces = !look || look.material === "Plastic" || look.material === "SmoothPlastic";
  for (const p of rig.parts) {
    if (p.hidden) continue;
    const holder = new THREE.Group();
    holder.matrixAutoUpdate = false;
    let mesh: THREE.Mesh;
    if (p.name === "Head") {
      // R6's classic head (mesh at scale 1.25) and the block rig's cube head are both ~1.2 studs.
      const r6 = rig.type === "R6";
      const s = 1.2;
      const geo = new RoundedBoxGeometry(s, s, s, 4, r6 ? 0.34 : 0.2);
      geometries.push(geo);
      mesh = new THREE.Mesh(geo, material(p.color));
      if (faces) {
        const decalGeo = new THREE.PlaneGeometry(s * 0.82, s * 0.82);
        geometries.push(decalGeo);
        const decalMat = new THREE.MeshStandardMaterial({ map: face(r6 ? "smile" : "neutral"), transparent: true, depthWrite: false, roughness: 0.8 });
        materials.push(decalMat);
        const decal = new THREE.Mesh(decalGeo, decalMat);
        // Characters face -Z; the face sits on the front of the head, facing out.
        decal.position.set(0, 0, -s / 2 - 0.004);
        decal.rotation.y = Math.PI;
        mesh.add(decal);
      }
    } else {
      // Slightly inset, softly rounded blocks read like Roblox parts without z-fighting at joints.
      const [x, y, z] = p.size;
      const geo = new RoundedBoxGeometry(x * 0.985, y * 0.985, z * 0.985, 2, Math.min(0.1, Math.min(x, y, z) * 0.18));
      geometries.push(geo);
      mesh = new THREE.Mesh(geo, material(p.color));
    }
    mesh.castShadow = !look || look.material === "Plastic" || look.material === "SmoothPlastic";
    mesh.receiveShadow = !look;
    holder.add(mesh);
    group.add(holder);
    parts.set(p.name, holder);
  }
  return {
    group,
    parts,
    fade: (f: number) => {
      if (!looked) return;
      looked.material.opacity = looked.opacity * Math.max(0, Math.min(1, f));
      looked.material.visible = f > 0.002;
    },
    dispose: () => {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
    },
  };
}

const m4 = new THREE.Matrix4();
export function applyPose(rig: RigMeshes, world: Map<string, { rot: Mat3; pos: Vec3 }>) {
  for (const [name, obj] of rig.parts) {
    const w = world.get(name);
    if (!w) continue;
    const r = w.rot;
    m4.set(r[0], r[1], r[2], w.pos[0], r[3], r[4], r[5], w.pos[1], r[6], r[7], r[8], w.pos[2], 0, 0, 0, 1);
    obj.matrix.copy(m4);
    obj.matrixWorldNeedsUpdate = true;
  }
}
