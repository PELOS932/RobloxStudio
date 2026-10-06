// Glow (bloom) that only comes from what should glow: Neon parts and light-emitting particles.
// Everything else is drawn black (opaque) or left out (transparent) in the glow pass, so a white
// wall in the sun or a bright plastic ball never gets a halo. With nothing glowing in view, the
// glow pass is skipped and a frame costs one plain render.
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

export interface SelectiveBloom {
  render(): void;
  setSize(w: number, h: number): void;
  /** Off: no glow at all. */
  enabled: boolean;
  dispose(): void;
}

/** Marks a material as a glow source (Neon). */
export function markGlow<M extends THREE.Material>(m: M): M {
  m.userData.glow = true;
  return m;
}

function glows(m: THREE.Material): boolean {
  if (m.userData.glow) return true;
  // Effect particles, beams and trails: LightEmission above 0.
  const emission = (m as THREE.ShaderMaterial).uniforms?.uEmission?.value;
  return typeof emission === "number" && emission > 0;
}

const isGlowing = (o: THREE.Object3D): boolean => {
  const m = (o as THREE.Mesh).material;
  if (!m) return false;
  return Array.isArray(m) ? m.some(glows) : glows(m);
};

export function createSelectiveBloom(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  { strength = 0.9, radius = 0.45, threshold = 0 }: { strength?: number; radius?: number; threshold?: number } = {},
): SelectiveBloom {
  const glowComposer = new EffectComposer(renderer);
  glowComposer.renderToScreen = false;
  glowComposer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), strength, radius, threshold);
  glowComposer.addPass(bloom);

  const mix = new ShaderPass(
    new THREE.ShaderMaterial({
      uniforms: { baseTexture: { value: null }, bloomTexture: { value: glowComposer.renderTarget2.texture } },
      vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader:
        "uniform sampler2D baseTexture; uniform sampler2D bloomTexture; varying vec2 vUv; void main() { gl_FragColor = texture2D(baseTexture, vUv) + vec4(texture2D(bloomTexture, vUv).rgb, 0.0); }",
    }),
    "baseTexture",
  );
  mix.needsSwap = true;
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(mix);
  composer.addPass(new OutputPass());

  const black = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const swapped: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
  const hidden: THREE.Object3D[] = [];

  const sb: SelectiveBloom = {
    enabled: true,
    render() {
      let any = false;
      if (sb.enabled) {
        scene.traverseVisible((o) => {
          if (!any && isGlowing(o)) any = true;
        });
      }
      mix.enabled = any;
      if (any) {
        scene.traverseVisible((o) => {
          const m = (o as THREE.Mesh).material;
          if (!m || isGlowing(o)) return;
          const transparent = Array.isArray(m) ? m.some((x) => x.transparent) : m.transparent;
          if ((o as THREE.Mesh).isMesh && !transparent) swapped.push([o as THREE.Mesh, m]);
          else hidden.push(o);
        });
        for (const [mesh] of swapped) mesh.material = black;
        for (const o of hidden) o.visible = false;
        const background = scene.background;
        scene.background = null;
        glowComposer.render();
        scene.background = background;
        for (const [mesh, m] of swapped) mesh.material = m;
        for (const o of hidden) o.visible = true;
        swapped.length = 0;
        hidden.length = 0;
      }
      composer.render();
    },
    setSize(w, h) {
      glowComposer.setPixelRatio(renderer.getPixelRatio());
      composer.setPixelRatio(renderer.getPixelRatio());
      glowComposer.setSize(w, h);
      composer.setSize(w, h);
    },
    dispose() {
      bloom.dispose();
      black.dispose();
      glowComposer.dispose();
      composer.dispose();
    },
  };
  return sb;
}
