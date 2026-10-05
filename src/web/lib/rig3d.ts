// three.js meshes for the R6/R15 dummy rigs, posed from shared/animation.ts forward kinematics.
import * as THREE from "three";
import type { Rig } from "../../shared/animation.ts";
import type { Mat3, Vec3 } from "../../shared/math.ts";

let faceTexture: THREE.CanvasTexture | null = null;

/** The classic smiley face. */
function face(): THREE.CanvasTexture {
  if (faceTexture) return faceTexture;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#1a1a1a";
  for (const x of [44, 84]) {
    g.beginPath();
    g.ellipse(x, 50, 7, 13, 0, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = "#1a1a1a";
  g.lineWidth = 7;
  g.lineCap = "round";
  g.beginPath();
  g.arc(64, 64, 30, Math.PI * 0.2, Math.PI * 0.8);
  g.stroke();
  faceTexture = new THREE.CanvasTexture(c);
  faceTexture.colorSpace = THREE.SRGBColorSpace;
  return faceTexture;
}

export interface RigMeshes {
  group: THREE.Group;
  parts: Map<string, THREE.Object3D>;
  dispose: () => void;
}

export function buildRig(rig: Rig): RigMeshes {
  const group = new THREE.Group();
  const parts = new Map<string, THREE.Object3D>();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  for (const p of rig.parts) {
    if (p.hidden) continue;
    const holder = new THREE.Group();
    holder.matrixAutoUpdate = false;
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(p.color), roughness: 0.6, metalness: 0 });
    materials.push(mat);
    let mesh: THREE.Mesh;
    if (p.name === "Head") {
      // Roblox's head mesh at scale 1.25: a slightly rounded cylinder.
      const geo = new THREE.CylinderGeometry(0.62, 0.62, 1.2, 28, 1);
      geometries.push(geo);
      mesh = new THREE.Mesh(geo, mat);
      const decalGeo = new THREE.PlaneGeometry(0.9, 0.9);
      geometries.push(decalGeo);
      const decalMat = new THREE.MeshBasicMaterial({ map: face(), transparent: true, depthWrite: false });
      materials.push(decalMat);
      const decal = new THREE.Mesh(decalGeo, decalMat);
      // Characters face -Z; the decal sits on the front of the head, facing out.
      decal.position.set(0, 0, -0.625);
      decal.rotation.y = Math.PI;
      mesh.add(decal);
    } else {
      // Slightly inset boxes read better than touching ones.
      const geo = new THREE.BoxGeometry(p.size[0] * 0.98, p.size[1] * 0.98, p.size[2] * 0.98);
      geometries.push(geo);
      mesh = new THREE.Mesh(geo, mat);
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    holder.add(mesh);
    group.add(holder);
    parts.set(p.name, holder);
  }
  return {
    group,
    parts,
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
