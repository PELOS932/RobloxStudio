import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { toNativeModel, type ModelSpec, type NativePart } from "../../shared/model.ts";
import { optimizeParts } from "../../shared/optimize.ts";
import { rgbToHex, matToEulerXYZDeg } from "../../shared/math.ts";
import { materialFor, tileOf } from "../lib/materials.ts";
import { faceNormal, partGeometry, partMatrix } from "../lib/geometry.ts";
import { Icon } from "../lib/icons.tsx";

interface Props {
  spec: ModelSpec;
  onReference?: (partName: string) => void;
}

interface Engine {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  composer: EffectComposer;
  sun: THREE.DirectionalLight;
  model: THREE.Group;
  grid: THREE.GridHelper;
  ground: THREE.Mesh;
  selection: THREE.LineSegments | null;
  meshes: THREE.Mesh[];
  fit: () => void;
  dispose: () => void;
}

const MAX_LIGHTS = 12;

export function ModelViewer({ spec, onReference }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; name: string } | null>(null);
  const [selected, setSelected] = useState<NativePart | null>(null);
  const [showGrid, setShowGrid] = useState(true);
  const [wire, setWire] = useState(false);
  const [spin, setSpin] = useState(false);

  const native = useMemo(() => toNativeModel(spec), [spec]);
  const optimizedCount = useMemo(() => optimizeParts(native.parts).parts.length, [native]);
  const dims = native.bounds.max.map((v, i) => Math.round((v - native.bounds.min[i]) * 10) / 10);

  // Create the renderer once.
  useEffect(() => {
    const host = hostRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.fog = new THREE.Fog(0x0d1017, 200, 900);

    const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 5000);
    camera.position.set(14, 10, 18);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;

    scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x2a2622, 0.65));
    const sun = new THREE.DirectionalLight(0xfff3e0, 2.4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    scene.add(sun, sun.target);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.ShadowMaterial({ opacity: 0.35 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    const grid = new THREE.GridHelper(400, 100, 0x3a4157, 0x1f2433);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.6;
    scene.add(grid);

    const model = new THREE.Group();
    scene.add(model);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.45, 0.92);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    const engine: Engine = {
      renderer, scene, camera, controls, composer, sun, model, grid, ground, selection: null, meshes: [],
      fit: () => {},
      dispose: () => {},
    };

    const resize = () => {
      const w = host.clientWidth || 1, h = host.clientHeight || 1;
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      bloom.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    renderer.setAnimationLoop(() => {
      controls.update();
      composer.render();
    });

    engine.dispose = () => {
      ro.disconnect();
      renderer.setAnimationLoop(null);
      controls.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
    engineRef.current = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  // Rebuild the model whenever the spec changes.
  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    for (const child of [...e.model.children]) {
      e.model.remove(child);
      (child as THREE.Mesh).geometry?.dispose();
    }
    e.meshes = [];
    setSelected(null);
    if (e.selection) {
      e.scene.remove(e.selection);
      e.selection = null;
    }

    let lights = 0;
    for (const p of native.parts) {
      const mesh = new THREE.Mesh(partGeometry(p, tileOf(p.material)), materialFor(p.material, p.color, p.transparency, p.reflectance));
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(partMatrix(p));
      mesh.castShadow = p.castShadow && p.transparency < 0.9;
      mesh.receiveShadow = p.material !== "Neon";
      mesh.userData.part = p;
      e.model.add(mesh);
      e.meshes.push(mesh);

      if (p.light && lights < MAX_LIGHTS) {
        lights++;
        const color = new THREE.Color().setRGB(p.light.color[0] / 255, p.light.color[1] / 255, p.light.color[2] / 255, THREE.SRGBColorSpace);
        const intensity = p.light.brightness * 14;
        let light: THREE.Light;
        if (p.light.className === "PointLight") {
          light = new THREE.PointLight(color, intensity, p.light.range * 1.2, 1.3);
        } else {
          const spot = new THREE.SpotLight(color, intensity * 1.5, p.light.range * 1.3, THREE.MathUtils.degToRad(Math.min(170, p.light.angle) / 2), 0.4, 1.2);
          spot.target.position.copy(faceNormal(p.light.face).multiplyScalar(5));
          mesh.add(spot.target);
          light = spot;
        }
        mesh.add(light);
      }
    }

    // Frame the model.
    const { min, max } = native.bounds;
    const center = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    const radius = Math.max(1, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
    e.ground.position.y = min[1] - 0.001;
    e.grid.position.y = min[1];
    const s = Math.max(1, radius / 25);
    e.grid.scale.set(s, 1, s);

    const shadowCam = e.sun.shadow.camera as THREE.OrthographicCamera;
    shadowCam.left = shadowCam.bottom = -radius * 1.6;
    shadowCam.right = shadowCam.top = radius * 1.6;
    shadowCam.near = 0.5;
    shadowCam.far = radius * 8;
    shadowCam.updateProjectionMatrix();
    e.sun.position.copy(center).add(new THREE.Vector3(radius * 1.6, radius * 2.8, radius * 1.2));
    e.sun.target.position.copy(center);

    e.fit = () => {
      // Fit the bounding sphere into the narrower of the two fields of view.
      const vfov = THREE.MathUtils.degToRad(e.camera.fov);
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * e.camera.aspect);
      const dist = (radius * 0.9) / Math.sin(Math.min(vfov, hfov) / 2);
      // Roblox models face -Z, so look from the front-right, slightly above.
      const dir = new THREE.Vector3(0.85, 0.6, -1).normalize();
      e.camera.position.copy(center).addScaledVector(dir, dist);
      e.camera.near = Math.max(0.01, dist / 500);
      e.camera.far = dist * 50;
      e.camera.updateProjectionMatrix();
      e.controls.target.copy(center);
      e.controls.update();
    };
    e.fit();
  }, [native]);

  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    e.grid.visible = showGrid;
  }, [showGrid]);

  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    for (const m of e.meshes) {
      const mat = m.material as THREE.MeshStandardMaterial;
      if ("wireframe" in mat) mat.wireframe = wire;
    }
  }, [wire, native]);

  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    e.controls.autoRotate = spin;
    e.controls.autoRotateSpeed = 1.2;
  }, [spin]);

  // Picking.
  const pick = (ev: React.PointerEvent) => {
    const e = engineRef.current;
    if (!e) return null;
    const rect = e.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, e.camera);
    const hit = ray.intersectObjects(e.meshes, false)[0];
    return hit ? { mesh: hit.object as THREE.Mesh, x: ev.clientX - rect.left, y: ev.clientY - rect.top } : null;
  };

  const downAt = useRef<{ x: number; y: number } | null>(null);

  const select = (mesh: THREE.Mesh | null) => {
    const e = engineRef.current!;
    if (e.selection) {
      e.selection.removeFromParent();
      e.selection.geometry.dispose();
      e.selection = null;
    }
    if (!mesh) return setSelected(null);
    const lines = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry, 30),
      new THREE.LineBasicMaterial({ color: 0xb6a4ff, depthTest: false, transparent: true }),
    );
    lines.renderOrder = 10;
    mesh.add(lines);
    e.selection = lines;
    setSelected(mesh.userData.part as NativePart);
  };

  const exportPng = () => {
    const e = engineRef.current;
    if (!e) return;
    e.composer.render();
    const a = document.createElement("a");
    a.download = `${spec.name.replace(/[^\w-]+/g, "_")}.png`;
    a.href = e.renderer.domElement.toDataURL("image/png");
    a.click();
  };

  const euler = selected ? matToEulerXYZDeg(selected.rot).map((v) => Math.round(v * 10) / 10) : null;

  return (
    <div className="viewer-canvas">
      <div
        ref={hostRef}
        style={{ position: "absolute", inset: 0 }}
        onPointerMove={(ev) => {
          const h = pick(ev);
          setHover(h ? { x: h.x, y: h.y, name: (h.mesh.userData.part as NativePart).name } : null);
        }}
        onPointerLeave={() => setHover(null)}
        onPointerDown={(ev) => (downAt.current = { x: ev.clientX, y: ev.clientY })}
        onPointerUp={(ev) => {
          const d = downAt.current;
          if (!d || Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 4) return;
          select(pick(ev)?.mesh ?? null);
        }}
      />
      {hover && (
        <div className="viewer-tip" style={{ left: hover.x, top: hover.y }}>
          {hover.name}
        </div>
      )}
      <div className="viewer-toolbar">
        <button className="icon-btn" title="Fit view" onClick={() => engineRef.current?.fit()}>
          <Icon name="focus" />
        </button>
        <button className={`icon-btn ${showGrid ? "active" : ""}`} title="Grid" onClick={() => setShowGrid((v) => !v)}>
          <Icon name="grid" />
        </button>
        <button className={`icon-btn ${wire ? "active" : ""}`} title="Wireframe" onClick={() => setWire((v) => !v)}>
          <Icon name="wireframe" />
        </button>
        <button className={`icon-btn ${spin ? "active" : ""}`} title="Turntable" onClick={() => setSpin((v) => !v)}>
          <Icon name="rotate" />
        </button>
        <button className="icon-btn" title="Save PNG" onClick={exportPng}>
          <Icon name="camera" />
        </button>
      </div>
      {selected && (
        <div className="part-card">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <b style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selected.name}</b>
            <button className="icon-btn" style={{ width: 24, height: 24 }} onClick={() => select(null)} title="Close">
              <Icon name="x" size={14} />
            </button>
          </div>
          <div className="row"><span>Shape</span><b>{selected.className === "WedgePart" ? "Wedge" : selected.shape}</b></div>
          <div className="row"><span>Size</span><b>{selected.size.map((v) => +v.toFixed(2)).join(" × ")}</b></div>
          <div className="row"><span>Position</span><b>{selected.pos.map((v) => +v.toFixed(2)).join(", ")}</b></div>
          {euler && euler.some((v) => v !== 0) && <div className="row"><span>Rotation</span><b>{euler.join("°, ")}°</b></div>}
          <div className="row">
            <span>Color</span>
            <b><span className="swatch" style={{ background: rgbToHex(selected.color) }} />{rgbToHex(selected.color)}</b>
          </div>
          <div className="row"><span>Material</span><b>{selected.material}</b></div>
          {selected.group && <div className="row"><span>Group</span><b>{selected.group}</b></div>}
          {onReference && (
            <button className="btn small" onClick={() => onReference(selected.name)}>
              <Icon name="message" size={13} /> Ask Claude to change it
            </button>
          )}
        </div>
      )}
      <div className="viewer-info">
        {native.parts.length} parts{optimizedCount < native.parts.length ? ` → ${optimizedCount} in Studio` : ""} · {dims.join(" × ")} studs
      </div>
    </div>
  );
}
