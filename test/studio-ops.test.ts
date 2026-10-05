import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { editLuau, lightingLuau, queryLuau, scriptSearchLuau, terrainLuau, toLua } from "../src/shared/studio-ops.ts";
import { scriptsToLuau } from "../src/shared/to-luau.ts";
import { summarizeOutput } from "../src/server/forge-mcp.ts";

const LUNE = process.env.LUNE_BIN ?? "lune";
let luneAvailable = true;
try {
  execFileSync(LUNE, ["--version"], { stdio: "ignore" });
} catch {
  luneAvailable = false;
}

describe("studio power tools", () => {
  it("turns JSON into Luau tables (nulls survive as FORGE_NULL)", () => {
    expect(toLua({ a: [1, "x", true, null], "b-c": { d: 2.5 } })).toBe('{["a"]={1,"x",true,FORGE_NULL},["b-c"]={["d"]=2.5}}');
  });

  it("puts problems first when summarizing a play-test", () => {
    const before = "old line\n";
    const out = summarizeOutput(`${before}Server started\nWorkspace.Door.Script:4: attempt to index nil with 'Position'\nhello\n`, before);
    expect(out).toMatch(/^Output: 3 lines, 1 problem\./);
    expect(out.split("\n")[2]).toMatch(/attempt to index nil/);
    expect(out).not.toContain("old line");
  });
});

describe.skipIf(!luneAvailable)("studio power tools in the mock Studio (Lune)", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-ops-"));
  const place = join(dir, "place.rbxlx");
  const run = (code: string) => {
    const file = join(dir, "code.luau");
    writeFileSync(file, code);
    return execFileSync(LUNE, ["run", join(import.meta.dirname, "..", "scripts", "mock-studio", "run.luau"), place, file, join(dir, "sel.txt")], { encoding: "utf8" });
  };

  it("builds, clones, bulk-edits, moves and deletes in one call", () => {
    const out = run(editLuau([
      { op: "create", class: "Folder", name: "Map", parent: "Workspace", children: [
        { class: "Part", name: "Floor", props: { Size: [64, 1, 64], Color: "#3a7d2c", Material: "Grass", Position: [0, -0.5, 0] } },
        { class: "Model", name: "Tree", children: [
          { class: "Part", name: "Trunk", props: { Size: [1, 6, 1], Color: [107, 74, 43], Material: "Wood", Position: [5, 3, 5] } },
          { class: "Part", name: "Leaves", props: { Size: [5, 5, 5], Color: "#2f6b2a", Position: [5, 7, 5] } },
        ] },
      ] },
      { op: "clone", path: "Workspace.Map.Tree", count: 3, offset: [10, 0, 0], name: "Tree" },
      { op: "set", query: { path: "Workspace.Map", name: "Leaves" }, props: { Color: "#ff8800", Tags: ["Foliage"], Attributes: { Health: 10 } } },
      { op: "move", path: "Workspace.Map.Tree1", by: [0, 2, 0] },
      { op: "set", path: "Workspace.Map.Nope", props: { Color: "#ffffff" } },
      { op: "delete", path: "Workspace.Map.Tree3" },
    ]));
    expect(out.split("\n")).toEqual([
      "1 of 6 ops failed · 10 instances changed (one undo step)",
      "1 created Workspace.Map",
      "2 cloned 3: Workspace.Map.Tree1, Workspace.Map.Tree2, Workspace.Map.Tree3",
      "3 set 4",
      "4 moved 1",
      "5 FAILED set: not found: Workspace.Map.Nope",
      "6 deleted 1",
    ]);
    const q = run(queryLuau({ path: "Workspace.Map", class: "BasePart", name: "leaves", props: ["Color", "Position", "Tags", "Anchored"] }));
    expect(q.split("\n")).toEqual([
      "in Workspace.Map: 3 matches",
      'Tree.Leaves [Part] Color=#ff8800 Position=5,7,5 Tags="Foliage" Anchored=true',
      'Tree1.Leaves [Part] Color=#ff8800 Position=15,9,5 Tags="Foliage" Anchored=true',
      'Tree2.Leaves [Part] Color=#ff8800 Position=25,7,5 Tags="Foliage" Anchored=true',
    ]);
    expect(run(queryLuau({ path: "Workspace", tree: true })).split("\n")).toEqual([
      "Workspace [Workspace]",
      "  Map [Folder]",
      "    Floor [Part]",
      "    Tree [Model] (2 inside: Part×2)",
      "    Tree1 [Model] (2 inside: Part×2)",
      "    Tree2 [Model] (2 inside: Part×2)",
    ]);
    expect(run(queryLuau({ path: "game", tag: "Foliage", limit: 1 }))).toMatch(/^3 matches\n.+\n… 2 more/);
  });

  it("writes several scripts at once and updates them in place", () => {
    const first = JSON.parse(run(scriptsToLuau([
      { name: "Main", kind: "Script", parent: "ServerScriptService", source: 'local Players = game:GetService("Players")\nPlayers.PlayerAdded:Connect(function(p)\n\tprint("hi", p.Name)\nend)' },
      { name: "Util", kind: "ModuleScript", parent: "ReplicatedStorage", source: "return {}" },
    ]).code));
    expect(first).toMatchObject({ ok: true });
    const again = JSON.parse(run(scriptsToLuau([{ name: "Main", kind: "Script", parent: "ServerScriptService", source: "print('v2')" }]).code));
    expect(Object.values(again.scripts)).toEqual([{ path: "ServerScriptService.Main", class: "Script", lines: 1, updated: true }]);
    const found = run(scriptSearchLuau({ pattern: "return", context: 0 }));
    expect(found).toBe("1 matches in 2 scripts\nReplicatedStorage.Util:1: return {}");
    expect(run(scriptSearchLuau({})).split("\n").sort()).toEqual(["2 scripts", "ReplicatedStorage.Util [ModuleScript] 1 lines", "ServerScriptService.Main [Script] 1 lines"].sort());
  });

  it("applies a lighting preset with effects", () => {
    expect(run(lightingLuau({ preset: "sunset", lighting: { ClockTime: 18 }, bloom: false }))).toBe(
      "Lighting preset sunset: ClockTime 18, Brightness 2; added SunRaysEffect, added ColorCorrectionEffect, added Atmosphere",
    );
    expect(run(queryLuau({ path: "Lighting", class: "Atmosphere", props: ["Density", "Color", "Haze"] }))).toBe("in Lighting: 1 match\nAtmosphere [Atmosphere] Density=0.35 Color=#ffb07a Haze=1.5");
  });

  it("generates hills chunk by chunk, with water below the level", () => {
    const file = join(dir, "terrain.luau");
    writeFileSync(file, terrainLuau([
      { op: "block", material: "Grass", pos: [0, 0, 0], size: [8, 4, 8] },
      { op: "hills", center: [0, 0, 0], size: [200, 200], height: 30, seed: 3, water: 6 },
      { op: "replace", from: "Grass", to: "Snow", min: [-10, 20, -10], max: [10, 60, 10] },
      { op: "nope" as "clear" },
    ]));
    const out = execFileSync(LUNE, ["run", join(import.meta.dirname, "lune", "terrain-harness.luau"), file], { encoding: "utf8" });
    const pick = (tag: string) => JSON.parse(out.split("\n").find((l) => l.startsWith(tag + " "))!.slice(tag.length + 1));
    const calls = pick("CALLS") as { name: string; dims?: number[]; size?: number[]; filled?: number; water?: number; maxY?: number; material?: string }[];
    expect(calls[0]).toMatchObject({ name: "FillBlock", material: "Grass" });
    const voxels = calls.filter((c) => c.name === "WriteVoxels");
    // 200 studs at 4 studs per voxel = 50 columns, in 32-column chunks: 2 × 2 writes.
    expect(voxels.map((v) => v.dims![0] * v.dims![2]).reduce((a, b) => a + b)).toBe(50 * 50);
    for (const v of voxels) expect(v.size).toEqual([v.dims![0] * 4, v.dims![1] * 4, v.dims![2] * 4]);
    expect(voxels.reduce((n, v) => n + v.filled!, 0)).toBeGreaterThan(50 * 50 * 3);
    expect(voxels.some((v) => v.water! > 0)).toBe(true);
    expect(calls.at(-1)).toMatchObject({ name: "ReplaceMaterial", material: "Snow" });
    const text = pick("RESULT").text as string;
    expect(text).toMatch(/^1 block ok\n2 hills: \d+ voxels\n3 replace ok\n4 FAILED nope: unknown op nope$/);
  });
});
