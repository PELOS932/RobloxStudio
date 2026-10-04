import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyModelEdit, sanitizeModelSpec, toNativeModel, ModelSpecSchema } from "../src/shared/model.ts";
import { optimizeParts } from "../src/shared/optimize.ts";
import { applyUiEdit, sanitizeUiSpec, UiSpecSchema } from "../src/shared/ui.ts";
import { modelToLuau, scriptToLuau, uiToLuau } from "../src/shared/to-luau.ts";
import { modelToRbxmx, scriptToRbxmx, uiToRbxmx } from "../src/shared/to-rbxmx.ts";
import { eulerXYZDeg, matToEulerXYZDeg } from "../src/shared/math.ts";
import { luaLongString } from "../src/shared/luau.ts";
import { pullSelectionLuau } from "../src/shared/studio-luau.ts";
import { doorScript, lanternModel, scaledHud, shopUi, wallModel } from "./fixtures.ts";

const LUNE = process.env.LUNE_BIN ?? "lune";
const harness = join(import.meta.dirname, "lune", "harness.luau");
const tmp = mkdtempSync(join(tmpdir(), "forge-test-"));

let luneAvailable = true;
try {
  execFileSync(LUNE, ["--version"], { stdio: "ignore" });
} catch {
  luneAvailable = false;
}

function runLune(mode: "luau" | "rbxmx", content: string, parent: string) {
  const file = join(tmp, `${Math.random().toString(36).slice(2)}.${mode === "luau" ? "luau" : "rbxmx"}`);
  writeFileSync(file, content);
  const out = execFileSync(LUNE, ["run", harness, mode, file, parent], { encoding: "utf8" });
  const resultLine = out.split("\n").find((l) => l.startsWith("RESULT "))!;
  const dump = out.slice(out.indexOf("DUMP\n") + 5).trim();
  return { result: JSON.parse(resultLine.slice(7)), dump };
}

describe("math", () => {
  it("round-trips Euler XYZ angles", () => {
    const e: [number, number, number] = [10, -35, 70];
    const back = matToEulerXYZDeg(eulerXYZDeg(e));
    back.forEach((v, i) => expect(v).toBeCloseTo(e[i], 6));
  });
});

describe("model spec", () => {
  it("validates and names parts uniquely", () => {
    const parsed = ModelSpecSchema.parse({ name: "A", parts: [{ size: [1, 1, 1], pos: [0, 0, 0] }, { name: "X", size: [1, 1, 1], pos: [0, 0, 0] }, { name: "X", size: [1, 1, 1], pos: [0, 0, 0] }] });
    const s = sanitizeModelSpec(parsed);
    expect(s.parts.map((p) => p.name)).toEqual(["Block1", "X", "X_2"]);
  });

  it("maps upright cylinders onto Roblox's X-axis cylinders", () => {
    const m = toNativeModel(lanternModel);
    const pole = m.parts.find((p) => p.name === "Pole")!;
    expect(pole.size).toEqual([9, 0.5, 0.5]);
    // Local X now points world +Y.
    expect(pole.rot[3]).toBeCloseTo(1);
    expect(m.bounds.min[1]).toBeCloseTo(0);
  });

  it("applies partial edits by name", () => {
    const s = sanitizeModelSpec(lanternModel);
    const { spec, missing } = applyModelEdit(s, {
      update: [{ name: "Base", color: "#ff0000" }],
      remove: ["Spot", "Nope"],
      add: [{ name: "Flag", size: [1, 1, 0.1], pos: [0, 12, 0] }],
      move: [0, 1, 0],
    });
    expect(missing).toEqual(["Nope"]);
    expect(spec.parts.find((p) => p.name === "Base")!.color).toBe("#ff0000");
    expect(spec.parts.find((p) => p.name === "Base")!.pos[1]).toBeCloseTo(1.3);
    expect(spec.parts.some((p) => p.name === "Spot")).toBe(false);
    expect(spec.parts.some((p) => p.name === "Flag")).toBe(true);
  });
});

describe("optimizer", () => {
  it("merges touching identical blocks into one", () => {
    const { parts, stats } = optimizeParts(toNativeModel(wallModel).parts);
    expect(stats.before).toBe(6);
    expect(parts).toHaveLength(1);
    expect(parts[0].size).toEqual([12, 3, 1]);
    expect(parts[0].pos).toEqual([5, 1.5, 0]);
  });

  it("does not merge parts that differ in appearance or are offset", () => {
    const spec = { name: "x", parts: [
      { name: "a", size: [2, 1, 1], pos: [0, 0, 0] },
      { name: "b", size: [2, 1, 1], pos: [2, 0, 0], color: "#ff0000" },
      { name: "c", size: [2, 1, 1], pos: [4, 0.5, 0] },
    ] } satisfies Parameters<typeof toNativeModel>[0];
    expect(optimizeParts(toNativeModel(spec).parts).parts).toHaveLength(3);
  });
});

describe("ui spec", () => {
  it("fixes duplicate names and dangling parents", () => {
    const { spec, warnings } = sanitizeUiSpec(UiSpecSchema.parse({
      name: "G",
      nodes: [
        { name: "A", type: "Frame" },
        { name: "A", type: "Frame", parent: "A" },
        { name: "B", type: "TextLabel", parent: "Missing" },
      ],
    }));
    expect(spec.nodes.map((n) => n.name)).toEqual(["A", "A_2", "B"]);
    expect(spec.nodes[2].parent).toBeUndefined();
    expect(warnings.length).toBe(2);
  });

  it("removes descendants with their parent", () => {
    const { spec } = applyUiEdit(sanitizeUiSpec(shopUi).spec, { remove: ["Grid"] });
    expect(spec.nodes.some((n) => n.name === "Icon" || n.name === "Card1")).toBe(false);
  });
});

describe("luau helpers", () => {
  it("picks a long-string level that cannot close early", () => {
    expect(luaLongString("a]")).toBe("[=[\na]]=]");
    expect(luaLongString("x]]y")).toBe("[=[\nx]]y]=]");
  });
});

describe.skipIf(!luneAvailable)("generated Luau matches exported .rbxmx (executed in Lune)", () => {
  const opts = { assetId: "asset-123", version: 2, placement: "keep" as const, select: false };

  it("model", () => {
    const spec = sanitizeModelSpec(lanternModel);
    const a = runLune("luau", modelToLuau(spec, opts).code, "Workspace");
    const b = runLune("rbxmx", modelToRbxmx(spec, opts), "Workspace");
    expect(a.result).toMatchObject({ ok: true, kind: "model", parts: 8, replaced: false });
    expect(a.dump).toBe(b.dump);
    expect(a.dump).toContain('class="WedgePart"');
    expect(a.dump).toContain('class="SpotLight"');
    expect(a.dump).toContain("Model:Lamp/Model:Top/WedgePart:Cap");
  });

  it("optimized model", () => {
    const a = runLune("luau", modelToLuau(wallModel, opts).code, "Workspace");
    const b = runLune("rbxmx", modelToRbxmx(wallModel, opts), "Workspace");
    expect(a.result.parts).toBe(1);
    expect(a.dump).toBe(b.dump);
  });

  it("places the model's bottom-center at the origin", () => {
    const spec = { name: "Box", parts: [{ name: "B", size: [2, 4, 2], pos: [10, 7, -3] }] } as const;
    const a = runLune("luau", modelToLuau(sanitizeModelSpec(structuredClone(spec) as never), { ...opts, placement: "origin" }).code, "Workspace");
    expect(a.dump).toMatch(/<X>0<\/X> <Y>2<\/Y> <Z>0<\/Z>/);
  });

  it("ui", () => {
    const spec = sanitizeUiSpec(shopUi).spec;
    const a = runLune("luau", uiToLuau(spec, opts).code, "StarterGui");
    const b = runLune("rbxmx", uiToRbxmx(spec, opts), "StarterGui");
    expect(a.result).toMatchObject({ ok: true, kind: "ui", elements: spec.nodes.length });
    expect(a.dump).toBe(b.dump);
    expect(a.dump).toContain("UIGridLayout");
    expect(a.dump).toContain("GothamSSm");
  });

  it("auto-scaled ui with gradient stops and truncation", () => {
    const spec = sanitizeUiSpec(scaledHud).spec;
    const a = runLune("luau", uiToLuau(spec, opts).code, "StarterGui");
    const b = runLune("rbxmx", uiToRbxmx(spec, opts), "StarterGui");
    expect(a.result).toMatchObject({ ok: true, kind: "ui" });
    expect(a.dump).toBe(b.dump);
    expect(a.dump).toContain("ScreenGui:ScaledHud/Frame:AutoScaleRoot/Frame:Health");
    expect(a.dump).toContain("UIScale:AutoScale");
    expect(a.dump).toContain("LocalScript:AutoScaleController");
    expect(a.dump).toContain('<token name="TextTruncate">1</token>');
    expect(a.dump).toContain("0.7 0.9765"); // explicit stop at t=0.7 (#f97316)
  });

  it("script", () => {
    const a = runLune("luau", scriptToLuau(doorScript, opts).code, "ServerScriptService");
    const b = runLune("rbxmx", scriptToRbxmx(doorScript, opts), "ServerScriptService");
    expect(a.result).toMatchObject({ ok: true, kind: "script" });
    expect(a.dump).toBe(b.dump);
  });

  it("reports errors as JSON instead of throwing", () => {
    const a = runLune("luau", uiToLuau(sanitizeUiSpec(shopUi).spec, { ...opts, parent: "Nowhere.Else" }).code, "StarterGui");
    expect(a.result.ok).toBe(false);
    expect(a.result.error).toContain("Path not found");
  });
});

describe.skipIf(!luneAvailable)("pull selection from Studio (executed in Lune)", () => {
  const pullHarness = join(import.meta.dirname, "lune", "pull-harness.luau");
  const file = join(tmp, "pull.luau");
  writeFileSync(file, pullSelectionLuau());
  const pull = (what: "model" | "ui") =>
    JSON.parse(execFileSync(LUNE, ["run", pullHarness, file, what], { encoding: "utf8" }).trim());

  it("reads a model selection back into a valid spec that re-imports", () => {
    const res = pull("model");
    expect(res.kind).toBe("model");
    const spec = sanitizeModelSpec(ModelSpecSchema.parse(res.spec));
    expect(spec.parts.map((p) => p.name)).toEqual(["Floor", "RoofLeft", "Lamp"]);
    expect(spec.parts[0].pos).toEqual([0, 0.5, 0]);
    expect(spec.parts[1].group).toBe("Roof");
    expect(spec.parts[2].light?.range).toBe(20);
    const back = runLune("luau", modelToLuau(spec, { placement: "keep", select: false }).code, "Workspace");
    expect(back.result).toMatchObject({ ok: true, parts: 3 });
  });

  it("reads a ScreenGui selection back into a valid UI spec", () => {
    const res = pull("ui");
    expect(res.kind).toBe("ui");
    const { spec } = sanitizeUiSpec(UiSpecSchema.parse(res.spec));
    expect(spec.ignoreInset).toBe(true);
    expect(spec.nodes.find((n) => n.name === "Panel")?.corner).toBe(10);
    expect(spec.nodes.find((n) => n.name === "Coins")).toMatchObject({ parent: "Panel", font: "GothamBold", text: "Coins: 10 ✓" });
  });
});
