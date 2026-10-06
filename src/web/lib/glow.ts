// Bloom for effect previews (like Roblox's BloomEffect): bright, light-emitting particles, beams
// and trails get a soft glow; the dummy, the floor and smoke never do. Off falls back to a plain
// render.
import * as THREE from "three";
import { createSelectiveBloom, type SelectiveBloom } from "./selective-bloom.ts";

export type Glow = SelectiveBloom;

export function createGlow(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): Glow {
  return createSelectiveBloom(renderer, scene, camera, { strength: 0.75, radius: 0.45, threshold: 0.6 });
}
