// The dark stage that effect and ability previews play on: renderer, floor with a polar grid,
// orbit camera, optional bloom, backdrops, and camera framing helpers.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { createGlow, type Glow } from "./glow.ts";

export const BACKDROPS = { night: 0x0d0e12, dusk: 0x2a2f3d, day: 0x9fb6c9 } as const;
export type Backdrop = keyof typeof BACKDROPS;

export interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  glow: Glow;
  setBackdrop(b: Backdrop): void;
  /** Point the camera at a sphere from a direction, fitting the narrower field of view. */
  frame(center: THREE.Vector3, radius: number, dir: THREE.Vector3): void;
  render(): void;
  dispose(): void;
}

export function createStage(host: HTMLElement, opts: { characters?: boolean } = {}): Stage {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  if (opts.characters) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  let pmrem: THREE.PMREMGenerator | null = null;
  if (opts.characters) {
    // Rigs are lit like the animation viewer, dimmer so effects stand out.
    pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.45;
    const sun = new THREE.DirectionalLight(0xfff3e0, 1.4);
    sun.position.set(8, 14, -6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = sc.bottom = -12;
    sc.right = sc.top = 12;
    scene.add(sun);
  }
  scene.add(new THREE.HemisphereLight(0xbfd2ff, 0x1a1712, opts.characters ? 0.5 : 0.35));
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x24262c, roughness: 0.92 });
  const floor = new THREE.Mesh(new THREE.CircleGeometry(80, 96), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.PolarGridHelper(80, 16, 20, 96, 0x30323a, 0x30323a);
  grid.position.y = 0.01;
  scene.add(grid);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 800);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.495;
  const glow = createGlow(renderer, scene, camera);
  const resize = () => {
    const w = host.clientWidth || 1, h = host.clientHeight || 1;
    renderer.setSize(w, h, false);
    glow.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();
  return {
    renderer,
    scene,
    camera,
    controls,
    glow,
    setBackdrop(b) {
      scene.background = new THREE.Color(BACKDROPS[b]);
      floorMat.color.set(b === "day" ? 0x6f7a63 : b === "dusk" ? 0x2f3240 : 0x24262c);
    },
    frame(center, radius, dir) {
      const vfov = THREE.MathUtils.degToRad(camera.fov);
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
      const dist = Math.max(8, (radius / Math.sin(Math.min(vfov, hfov) / 2)) * 1.05);
      controls.target.copy(center);
      camera.position.copy(center).addScaledVector(dir.clone().normalize(), dist);
      controls.minDistance = 2;
      controls.maxDistance = dist * 4;
      controls.update();
    },
    render() {
      controls.update();
      glow.render();
    },
    dispose() {
      ro.disconnect();
      renderer.setAnimationLoop(null);
      controls.dispose();
      glow.dispose();
      pmrem?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
