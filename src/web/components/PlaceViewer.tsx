import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { NO_HIT, type PlaceScene, type PlaceTerrain, type ScenePart } from "../../shared/place.ts";
import { matToEulerXYZDeg, rgbToHex } from "../../shared/math.ts";
import { wedgeVertices } from "../../shared/model.ts";
import type { MaterialName } from "../../shared/roblox-data.ts";
import { materialFor, studioEnvironment, tileOf } from "../lib/materials.ts";
import { createSelectiveBloom, markGlow, type SelectiveBloom } from "../lib/selective-bloom.ts";
import { Icon } from "../lib/icons.tsx";

// A read-only view of a whole place: parts are drawn with one instanced mesh per
// (shape, material, transparency), so maps with tens of thousands of parts stay smooth.
// Textures are projected in each part's own scale in the shader, like Roblox's studs.

interface Props {
  scene: PlaceScene;
  onSelectInStudio?: (part: ScenePart) => void;
  onAsk?: (part: ScenePart) => void;
}

type Geo = "box" | "ball" | "cylinder" | "wedge" | "corner";
const GEO_OF: Record<ScenePart["kind"], Geo> = {
  block: "box", ball: "ball", cylinder: "cylinder", wedge: "wedge", cornerWedge: "corner",
  truss: "box", mesh: "box", union: "box", other: "box",
};
const APPROX = new Set<ScenePart["kind"]>(["mesh", "union", "truss"]);

function unitGeometry(geo: Geo): THREE.BufferGeometry {
  switch (geo) {
    case "ball":
      return new THREE.SphereGeometry(0.5, 20, 14);
    case "cylinder":
      // Roblox cylinders run along local X.
      return new THREE.CylinderGeometry(0.5, 0.5, 1, 20, 1).rotateZ(-Math.PI / 2);
    case "wedge":
      return triangles(wedgeVertices([1, 1, 1]), [[0, 1, 3], [0, 3, 2], [2, 3, 5], [2, 5, 4], [0, 4, 5], [0, 5, 1], [0, 2, 4], [1, 5, 3]]);
    case "corner": {
      // Four bottom corners and the top corner above (+X, -Z).
      const v: [number, number, number][] = [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, -0.5]];
      return triangles(v, [[0, 1, 3], [0, 3, 2], [1, 4, 3], [0, 4, 1], [2, 3, 4], [0, 2, 4]]);
    }
    default:
      return new THREE.BoxGeometry(1, 1, 1);
  }
}

function triangles(v: [number, number, number][], tris: number[][]): THREE.BufferGeometry {
  const pos: number[] = [];
  for (const t of tris) for (const i of t) pos.push(...v[i]);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(new Array((pos.length / 3) * 2).fill(0), 2));
  g.computeVertexNormals();
  return g;
}

/** UVs from the part's own position scaled to studs, picked by the dominant face axis. */
function studUvs(mat: THREE.Material, tile: number) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.forgeTile = { value: tile };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float forgeTile;")
      .replace(
        "#include <uv_vertex>",
        `#include <uv_vertex>
#ifdef USE_INSTANCING
	vec3 forgeScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
#else
	vec3 forgeScale = vec3(1.0);
#endif
	vec3 forgeP = position * forgeScale / forgeTile;
	vec3 forgeN = abs(normal);
	vec2 forgeUv = (forgeN.x >= forgeN.y && forgeN.x >= forgeN.z) ? forgeP.zy : ((forgeN.y >= forgeN.z) ? forgeP.xz : forgeP.xy);
#ifdef USE_MAP
	vMapUv = forgeUv;
#endif
#ifdef USE_BUMPMAP
	vBumpMapUv = forgeUv;
#endif`,
      );
  };
  mat.customProgramCacheKey = () => "forge-stud-uv";
}

const materials = new Map<string, THREE.Material>();
function placeMaterial(name: string, transparency: number): THREE.Material {
  const key = `${name}|${transparency}`;
  let m = materials.get(key);
  if (m) return m;
  if (name === "Neon") {
    // Instance colours tint the glow (an emissive colour can't be per instance).
    m = markGlow(new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.2, 2.2), toneMapped: false, transparent: transparency > 0, opacity: 1 - transparency }));
  } else {
    const base = materialFor((name in MATERIAL_SET ? name : "Plastic") as MaterialName, [255, 255, 255], transparency, 0);
    m = base.clone();
    if ((m as THREE.MeshStandardMaterial).map) studUvs(m, tileOf(name as MaterialName));
  }
  materials.set(key, m);
  return m;
}
const MATERIAL_SET: Record<string, true> = {};
for (const n of ["Plastic", "SmoothPlastic", "Wood", "WoodPlanks", "Marble", "Basalt", "Slate", "CrackedLava", "Concrete", "Limestone", "Granite", "Pavement", "Brick", "Pebble", "Cobblestone", "Rock", "Sandstone", "CorrodedMetal", "DiamondPlate", "Foil", "Metal", "Grass", "LeafyGrass", "Sand", "Fabric", "Snow", "Mud", "Ground", "Asphalt", "Salt", "Ice", "Glacier", "Glass", "ForceField", "Cardboard", "Carpet", "CeramicTiles", "ClayRoofTiles", "RoofShingles", "Leather"]) MATERIAL_SET[n] = true;

const tmpColor = new THREE.Color();
function partMatrix4(p: ScenePart, out: THREE.Matrix4) {
  const r = p.rot, [sx, sy, sz] = p.size;
  return out.set(
    r[0] * sx, r[1] * sy, r[2] * sz, p.pos[0],
    r[3] * sx, r[4] * sy, r[5] * sz, p.pos[1],
    r[6] * sx, r[7] * sy, r[8] * sz, p.pos[2],
    0, 0, 0, 1,
  );
}

function terrainMeshes(t: PlaceTerrain): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const idx = (i: number, j: number) => j * t.nx + i;
  const pos = new Float32Array(t.nx * t.nz * 3);
  const col = new Float32Array(t.nx * t.nz * 3);
  const uv = new Float32Array(t.nx * t.nz * 2);
  const palette = t.colors.map((c) => new THREE.Color().setRGB(((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255, THREE.SRGBColorSpace));
  for (let j = 0; j < t.nz; j++) {
    for (let i = 0; i < t.nx; i++) {
      const k = idx(i, j);
      const x = t.x0 + i * t.step, z = t.z0 + j * t.step;
      const h = t.heights[k];
      pos.set([x, h === NO_HIT ? 0 : h, z], k * 3);
      uv.set([x / 6, z / 6], k * 2);
      const c = palette[(t.mats[k] || 1) - 1] ?? tmpColor.set(0x7f7f7f);
      // A little per-sample variation so flat areas don't look plastic.
      const n = 0.94 + (((i * 73856093) ^ (j * 19349663)) & 255) / 255 * 0.12;
      col.set([c.r * n, c.g * n, c.b * n], k * 3);
    }
  }
  const index: number[] = [];
  const waterIndex: number[] = [];
  for (let j = 0; j < t.nz - 1; j++) {
    for (let i = 0; i < t.nx - 1; i++) {
      const a = idx(i, j), b = idx(i + 1, j), c = idx(i, j + 1), d = idx(i + 1, j + 1);
      if (t.heights[a] !== NO_HIT && t.heights[b] !== NO_HIT && t.heights[c] !== NO_HIT && t.heights[d] !== NO_HIT) index.push(a, c, b, b, c, d);
      if (t.water[a] !== NO_HIT && t.water[b] !== NO_HIT && t.water[c] !== NO_HIT && t.water[d] !== NO_HIT) waterIndex.push(a, c, b, b, c, d);
    }
  }
  if (index.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setIndex(index);
    g.computeVertexNormals();
    const m = (materialFor("Grass", [255, 255, 255], 0, 0) as THREE.MeshStandardMaterial).clone();
    m.vertexColors = true;
    const mesh = new THREE.Mesh(g, m);
    mesh.receiveShadow = true;
    mesh.name = "Terrain";
    out.push(mesh);
  }
  if (waterIndex.length) {
    const wpos = new Float32Array(t.nx * t.nz * 3);
    for (let k = 0; k < t.nx * t.nz; k++) wpos.set([pos[k * 3], t.water[k] === NO_HIT ? 0 : t.water[k], pos[k * 3 + 2]], k * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(wpos, 3));
    g.setIndex(waterIndex);
    g.computeVertexNormals();
    const c = t.waterColor;
    const m = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255, THREE.SRGBColorSpace),
      roughness: 0.08,
      metalness: 0.1,
      transparent: true,
      opacity: Math.max(0.35, Math.min(0.85, 1 - t.waterTransparency * 0.6)),
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.name = "Water";
    out.push(mesh);
  }
  return out;
}

interface Engine {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  composer: SelectiveBloom;
  sun: THREE.DirectionalLight;
  world: THREE.Group;
  pickables: THREE.InstancedMesh[];
  highlight: THREE.LineSegments | null;
  fit: () => void;
  /** Draw the next frame (the view only redraws when something changed). */
  invalidate: () => void;
}

export function PlaceViewer({ scene, onSelectInStudio, onAsk }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [showInvisible, setShowInvisible] = useState(false);
  const [counts, setCounts] = useState({ drawn: 0, hidden: 0, calls: 0 });

  useEffect(() => {
    const host = hostRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(renderer.domElement);

    const s = new THREE.Scene();
    const disposeEnv = studioEnvironment(renderer, s);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 20000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = false;
    controls.maxPolarAngle = Math.PI * 0.495;
    s.add(new THREE.HemisphereLight(0xcfe3ff, 0x3a3631, 1.3));
    const sun = new THREE.DirectionalLight(0xfff3e0, 2.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.05;
    s.add(sun, sun.target);
    const world = new THREE.Group();
    s.add(world);

    // Only Neon parts glow.
    const composer = createSelectiveBloom(renderer, s, camera, { strength: 0.8, radius: 0.45 });

    // Big maps are expensive to draw, so frames are only rendered while something changes.
    let dirty = true;
    const invalidate = () => (dirty = true);
    controls.addEventListener("change", invalidate);
    const resize = () => {
      const w = host.clientWidth || 1, h = host.clientHeight || 1;
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      invalidate();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();
    renderer.setAnimationLoop(() => {
      controls.update(); // keeps damping going; fires "change" while the camera moves
      if (!dirty) return;
      dirty = false;
      composer.render();
    });
    engineRef.current = { renderer, scene: s, camera, controls, composer, sun, world, pickables: [], highlight: null, fit: () => {}, invalidate };
    return () => {
      ro.disconnect();
      renderer.setAnimationLoop(null);
      controls.dispose();
      disposeEnv();
      composer.dispose();
      for (const o of world.children) (o as THREE.Mesh).geometry?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      engineRef.current = null;
    };
  }, []);

  // Build the world.
  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    for (const o of [...e.world.children]) {
      e.world.remove(o);
      (o as THREE.Mesh).geometry?.dispose();
    }
    e.pickables = [];
    setSelected(null);

    const buckets = new Map<string, { geo: Geo; material: string; t: number; parts: number[] }>();
    let hidden = 0;
    scene.parts.forEach((p, i) => {
      if (p.transparency >= 0.98 && !showInvisible) return void hidden++;
      const t = p.transparency >= 0.98 ? 0.85 : Math.round(p.transparency * 10) / 10;
      const geo = GEO_OF[p.kind];
      const key = `${geo}|${p.material}|${t}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { geo, material: p.material, t, parts: [] }));
      b.parts.push(i);
    });

    const geos = new Map<Geo, THREE.BufferGeometry>();
    const m4 = new THREE.Matrix4();
    for (const b of buckets.values()) {
      let g = geos.get(b.geo);
      if (!g) geos.set(b.geo, (g = unitGeometry(b.geo)));
      const mesh = new THREE.InstancedMesh(g, placeMaterial(b.material, b.t), b.parts.length);
      b.parts.forEach((pi, k) => {
        const p = scene.parts[pi];
        mesh.setMatrixAt(k, partMatrix4(p, m4));
        mesh.setColorAt(k, tmpColor.setRGB(p.color[0] / 255, p.color[1] / 255, p.color[2] / 255, THREE.SRGBColorSpace));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = b.t < 0.5 && b.material !== "Neon" && b.material !== "ForceField";
      mesh.receiveShadow = b.material !== "Neon";
      mesh.userData.parts = b.parts;
      e.world.add(mesh);
      e.pickables.push(mesh);
    }
    if (scene.terrain) for (const m of terrainMeshes(scene.terrain)) e.world.add(m);
    setCounts({ drawn: scene.parts.length - hidden, hidden, calls: buckets.size });

    const { min, max } = scene.bounds;
    const center = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    const radius = Math.max(4, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
    const shadow = e.sun.shadow.camera as THREE.OrthographicCamera;
    const span = Math.min(radius, 900);
    shadow.left = shadow.bottom = -span * 1.2;
    shadow.right = shadow.top = span * 1.2;
    shadow.near = 1;
    shadow.far = radius * 6 + 100;
    shadow.updateProjectionMatrix();
    e.sun.position.copy(center).add(new THREE.Vector3(radius * 0.8, radius * 1.6 + 50, radius * 0.6));
    e.sun.target.position.copy(center);
    e.scene.fog = new THREE.Fog(0x0b0b0c, radius * 2.5, radius * 7);

    e.fit = () => {
      const vfov = THREE.MathUtils.degToRad(e.camera.fov);
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * e.camera.aspect);
      const dist = (radius * 0.8) / Math.sin(Math.min(vfov, hfov) / 2);
      e.camera.position.copy(center).addScaledVector(new THREE.Vector3(0.75, 0.62, -1).normalize(), dist);
      e.camera.near = Math.max(0.1, dist / 2000);
      e.camera.far = dist * 20;
      e.camera.updateProjectionMatrix();
      e.controls.target.copy(center);
      e.controls.update();
    };
    e.fit();
    e.invalidate();
  }, [scene, showInvisible]);

  // Selection outline.
  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    if (e.highlight) {
      e.highlight.removeFromParent();
      e.highlight.geometry.dispose();
      e.highlight = null;
      e.invalidate();
    }
    if (selected === null) return;
    const p = scene.parts[selected];
    const g = unitGeometry(GEO_OF[p.kind]);
    const lines = new THREE.LineSegments(new THREE.EdgesGeometry(g, 30), new THREE.LineBasicMaterial({ color: 0x4c9dff, depthTest: false, transparent: true }));
    g.dispose();
    lines.matrixAutoUpdate = false;
    lines.matrix.copy(partMatrix4(p, new THREE.Matrix4()));
    lines.renderOrder = 10;
    e.scene.add(lines);
    e.highlight = lines;
    e.invalidate();
  }, [selected, scene]);

  const pickAt = (ev: React.PointerEvent) => {
    const e = engineRef.current;
    if (!e) return null;
    const rect = e.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1), e.camera);
    const hit = ray.intersectObjects(e.pickables, false)[0];
    if (!hit || hit.instanceId === undefined) return null;
    return (hit.object.userData.parts as number[])[hit.instanceId];
  };

  const focus = (i: number) => {
    const e = engineRef.current;
    if (!e) return;
    const p = scene.parts[i];
    const target = new THREE.Vector3(...p.pos);
    const offset = e.camera.position.clone().sub(e.controls.target);
    const want = Math.max(8, Math.hypot(...p.size) * 2.2);
    offset.setLength(want);
    e.controls.target.copy(target);
    e.camera.position.copy(target).add(offset);
    e.controls.update();
  };

  const downAt = useRef<{ x: number; y: number } | null>(null);
  const part = selected !== null ? scene.parts[selected] : null;
  const euler = part ? matToEulerXYZDeg(part.rot).map((v) => Math.round(v * 10) / 10) : null;
  const approx = scene.stats.meshes + scene.stats.unions;
  const t = scene.terrain;
  const info = useMemo(() => {
    const bits = [`${counts.drawn.toLocaleString()} parts`];
    if (approx) bits.push(approx === 1 ? "1 mesh shown as a box" : `${approx.toLocaleString()} meshes shown as boxes`);
    if (counts.hidden) bits.push(`${counts.hidden.toLocaleString()} invisible`);
    if (t) bits.push(`terrain ${Math.round((t.nx - 1) * t.step)}×${Math.round((t.nz - 1) * t.step)}`);
    if (scene.stats.truncated) bits.push(`${scene.stats.truncated.toLocaleString()} not loaded`);
    return bits.join(" · ");
  }, [counts, approx, t, scene.stats.truncated]);

  return (
    <div className="viewer-canvas">
      <div
        ref={hostRef}
        style={{ position: "absolute", inset: 0 }}
        onPointerDown={(ev) => (downAt.current = { x: ev.clientX, y: ev.clientY })}
        onPointerUp={(ev) => {
          const d = downAt.current;
          if (!d || Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 4) return;
          setSelected(pickAt(ev));
        }}
        onDoubleClick={(ev) => {
          const i = pickAt(ev as unknown as React.PointerEvent);
          if (i !== null) (setSelected(i), focus(i));
        }}
      />
      <div className="viewer-toolbar">
        <button className="icon-btn" title="Fit view" onClick={() => engineRef.current?.fit()}>
          <Icon name="focus" />
        </button>
        <button className={`icon-btn ${showInvisible ? "active" : ""}`} title="Show invisible parts (Transparency 1)" onClick={() => setShowInvisible((v) => !v)}>
          <Icon name="eye" />
        </button>
      </div>
      {part && (
        <div className="part-card">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <b style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{part.name}</b>
            <button className="icon-btn" style={{ width: 24, height: 24 }} onClick={() => setSelected(null)} title="Close">
              <Icon name="x" size={14} />
            </button>
          </div>
          <div className="row"><span>Class</span><b>{part.className}</b></div>
          {APPROX.has(part.kind) && <div className="row"><span /><b className="muted">shown as its bounding box</b></div>}
          <div className="row"><span>Size</span><b>{part.size.map((v) => +v.toFixed(2)).join(" × ")}</b></div>
          <div className="row"><span>Position</span><b>{part.pos.map((v) => +v.toFixed(1)).join(", ")}</b></div>
          {euler && euler.some((v) => v !== 0) && <div className="row"><span>Rotation</span><b>{euler.join("°, ")}°</b></div>}
          <div className="row">
            <span>Color</span>
            <b><span className="swatch" style={{ background: rgbToHex(part.color) }} />{rgbToHex(part.color)}</b>
          </div>
          <div className="row"><span>Material</span><b>{part.material}</b></div>
          {part.transparency > 0 && <div className="row"><span>Transparency</span><b>{part.transparency}</b></div>}
          {part.group.length > 0 && <div className="row"><span>In</span><b title={part.group.join(" / ")}>{part.group.join(" / ")}</b></div>}
          <div className="part-actions">
            {onSelectInStudio && (
              <button className="btn small" onClick={() => onSelectInStudio(part)}>
                <Icon name="focus" size={13} /> Select in Studio
              </button>
            )}
            {onAsk && (
              <button className="btn small" onClick={() => onAsk(part)}>
                <Icon name="message" size={13} /> Ask Claude
              </button>
            )}
          </div>
        </div>
      )}
      <div className="viewer-info">{info}</div>
    </div>
  );
}
