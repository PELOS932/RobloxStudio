import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeModelSpec, ModelSpecSchema } from "../src/shared/model.ts";
import { modelToLuau } from "../src/shared/to-luau.ts";

// Camera placement in Studio, executed in Lune with a fake camera and a floor to raycast against.

const LUNE = process.env.LUNE_BIN ?? "lune";
let luneAvailable = true;
try {
  execFileSync(LUNE, ["--version"], { stdio: "ignore" });
} catch {
  luneAvailable = false;
}

const dir = mkdtempSync(join(tmpdir(), "forge-place-cam-"));
const crate = sanitizeModelSpec(ModelSpecSchema.parse({ name: "Crate", parts: [{ name: "Box", size: [4, 4, 4], pos: [0, 2, 0] }] }));

function place(cam: number[], look: number[], floorY: number, faceCamera = true) {
  const file = join(dir, `${Math.random().toString(36).slice(2)}.luau`);
  writeFileSync(file, modelToLuau(crate, { placement: "camera", faceCamera, select: false }).code);
  const out = execFileSync(LUNE, ["run", join(import.meta.dirname, "lune", "placement-harness.luau"), file, cam.join(","), look.join(","), String(floorY)], { encoding: "utf8" });
  const [x, y, z, lx, ly, lz] = out.trim().split("\n").find((l) => l.startsWith("PIVOT "))!.slice(6).split(" ").map(Number);
  return { pos: [x, y, z], look: [lx, ly, lz] };
}

const close = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-3);

describe.skipIf(!luneAvailable)("placing new models where the Studio camera looks", () => {
  it("lands on the floor in the middle of the view, facing the camera", () => {
    const r = place([0, 20, 40], [0, 0, 0], 0);
    expect(close(r.pos, [0, 0, 0])).toBe(true);
    expect(close(r.look, [0, 0, 1])).toBe(true); // the model's front points back at the camera
  });

  it("sits on raised floors, snaps to whole studs and turns in 90° steps", () => {
    const r = place([100, 30, 3], [60.4, 5, 2.6], 5);
    expect(close(r.pos, [60, 5, 3])).toBe(true);
    expect(close(r.look, [1, 0, 0])).toBe(true); // camera is toward +X
  });

  it("falls back to straight ahead on the ground when looking at the sky", () => {
    const r = place([0, 10, 0], [0, 15, -10], 0);
    expect(r.pos[1]).toBe(0);
    expect(r.pos[2]).toBeLessThan(-10); // ahead of the camera
    expect(Number.isInteger(r.pos[0]) && Number.isInteger(r.pos[2])).toBe(true);
  });

  it("keeps the designed orientation when facing is off", () => {
    const r = place([0, 20, 40], [0, 0, 0], 0, false);
    expect(close(r.look, [0, 0, -1])).toBe(true);
  });
});
