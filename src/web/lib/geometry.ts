import * as THREE from "three";
import { wedgeVertices, type NativePart } from "../../shared/model.ts";
import type { Vec3 } from "../../shared/math.ts";

/** Box with UVs measured in texture repeats (size / tile) so textures keep a constant world scale. */
function box(size: Vec3, tile: number) {
  const g = new THREE.BoxGeometry(size[0], size[1], size[2]);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  // Face order: +x, -x, +y, -y, +z, -z (4 vertices each).
  const faces: [number, number][] = [
    [size[2], size[1]], [size[2], size[1]],
    [size[0], size[2]], [size[0], size[2]],
    [size[0], size[1]], [size[0], size[1]],
  ];
  for (let f = 0; f < 6; f++) {
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, uv.getX(k) * (faces[f][0] / tile), uv.getY(k) * (faces[f][1] / tile));
    }
  }
  return g;
}

function scaleUv(g: THREE.BufferGeometry, su: number, sv: number) {
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return g;
}

function wedge(size: Vec3, tile: number) {
  const v = wedgeVertices(size);
  // Triangles (counter-clockwise from outside).
  const tris: [number, number, number][] = [
    [0, 1, 3], [0, 3, 2], // bottom
    [2, 3, 5], [2, 5, 4], // back (+Z)
    [0, 4, 5], [0, 5, 1], // slope
    [0, 2, 4], // left (-X)
    [1, 5, 3], // right (+X)
  ];
  const pos: number[] = [];
  const uvs: number[] = [];
  for (const t of tris) {
    const p = t.map((i) => v[i]);
    const n = new THREE.Vector3().crossVectors(
      new THREE.Vector3(...p[1]).sub(new THREE.Vector3(...p[0])),
      new THREE.Vector3(...p[2]).sub(new THREE.Vector3(...p[0])),
    );
    // Planar UV projection along the dominant normal axis.
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    for (const q of p) {
      pos.push(...q);
      if (ax >= ay && ax >= az) uvs.push(q[2] / tile, q[1] / tile);
      else if (ay >= az) uvs.push(q[0] / tile, q[2] / tile);
      else uvs.push(q[0] / tile, q[1] / tile);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  return g;
}

export function partGeometry(p: NativePart, tile: number): THREE.BufferGeometry {
  const [x, y, z] = p.size;
  if (p.className === "WedgePart") return wedge(p.size, tile);
  if (p.shape === "Ball") {
    const g = new THREE.SphereGeometry(x / 2, 40, 24);
    return scaleUv(g, (Math.PI * x) / tile, (Math.PI * x) / 2 / tile);
  }
  if (p.shape === "Cylinder") {
    // Roblox cylinders run along local X.
    const g = new THREE.CylinderGeometry(y / 2, y / 2, x, 40, 1);
    g.rotateZ(-Math.PI / 2);
    return scaleUv(g, (Math.PI * y) / tile, x / tile);
  }
  return box([x, y, z], tile);
}

export function partMatrix(p: NativePart): THREE.Matrix4 {
  const r = p.rot;
  return new THREE.Matrix4().set(
    r[0], r[1], r[2], p.pos[0],
    r[3], r[4], r[5], p.pos[1],
    r[6], r[7], r[8], p.pos[2],
    0, 0, 0, 1,
  );
}

/** Direction a light faces for a Roblox NormalId, in part space. */
export function faceNormal(face: string): THREE.Vector3 {
  switch (face) {
    case "Top": return new THREE.Vector3(0, 1, 0);
    case "Bottom": return new THREE.Vector3(0, -1, 0);
    case "Right": return new THREE.Vector3(1, 0, 0);
    case "Left": return new THREE.Vector3(-1, 0, 0);
    case "Back": return new THREE.Vector3(0, 0, 1);
    default: return new THREE.Vector3(0, 0, -1); // Front
  }
}
