// Bloom for effect previews (like Roblox's BloomEffect): bright, additive particles get a soft
// glow. Off falls back to a plain render.
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

export interface Glow {
  render(): void;
  setSize(w: number, h: number): void;
  enabled: boolean;
  dispose(): void;
}

export function createGlow(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): Glow {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.75, 0.45, 0.6);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const glow: Glow = {
    enabled: true,
    render() {
      if (glow.enabled) composer.render();
      else renderer.render(scene, camera);
    },
    setSize(w, h) {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
    },
    dispose() {
      bloom.dispose();
      composer.dispose();
    },
  };
  return glow;
}
