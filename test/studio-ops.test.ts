import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditLuau, editLuau, lightingLuau, parseScriptRead, queryLuau, scriptPatchLuau, scriptReadLuau, scriptSearchLuau, studioContextLuau, terrainLuau, toLua,
} from "../src/shared/studio-ops.ts";
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

  it("parses script read ranges", () => {
    expect(parseScriptRead("ServerScriptService.Main")).toEqual({ path: "ServerScriptService.Main" });
    expect(parseScriptRead("ServerScriptService.Main:10-40")).toEqual({ path: "ServerScriptService.Main", from: 10, to: 40 });
    expect(parseScriptRead("A.B:12")).toEqual({ path: "A.B", from: 12, to: 12 });
    expect(parseScriptRead("A.B:12-")).toEqual({ path: "A.B", from: 12 });
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

  it("works on the selection: group, weld, scale, bounds, ungroup, and the live context line", () => {
    run(editLuau([
      { op: "create", class: "Folder", name: "Yard", parent: "Workspace", children: [
        { class: "Part", name: "Base", props: { Size: [4, 1, 4], Position: [0, 0.5, 0] } },
        { class: "Part", name: "Top", props: { Size: [2, 2, 2], Position: [0, 2, 0] } },
      ] },
      { op: "select", paths: ["Workspace.Yard.Base", "Workspace.Yard.Top"] },
    ]));
    expect(run(studioContextLuau())).toBe('place "DataModel" · selected Workspace.Yard.Base [Part] size 4,1,4 at 0,0.5,0; Workspace.Yard.Top [Part] size 2,2,2 at 0,2,0');
    expect(run(queryLuau({ path: "@selection", props: ["Size"] })).split("\n")).toEqual(["2 matches", "Workspace.Yard.Base [Part] Size=4,1,4", "Workspace.Yard.Top [Part] Size=2,2,2"]);
    expect(run(editLuau([{ op: "group", path: "@selection", name: "Stack" }, { op: "weld", path: "Workspace.Yard.Stack", unanchor: true }])).split("\n")).toEqual([
      "ok · 4 instances changed (one undo step)",
      "1 grouped 2 into Workspace.Yard.Stack",
      "2 welded 1 parts to Workspace.Yard.Stack.Base (unanchored)",
    ]);
    expect(run(queryLuau({ path: "Workspace.Yard", depth: 1, props: ["Bounds", "Parts", "PrimaryPart"] }))).toBe("in Workspace.Yard: 1 match\nStack [Model] Bounds=4,3,4 at 0,1.5,0 Parts=2 PrimaryPart=Workspace.Yard.Stack.Base");
    // The selection is the new group now; scale it about its pivot.
    run(editLuau([{ op: "scale", path: "@selection", factor: 2 }]));
    expect(run(queryLuau({ path: "Workspace.Yard.Stack", class: "BasePart", props: ["Size", "Position"] })).split("\n").slice(1)).toEqual([
      "Base [Part] Size=8,2,8 Position=0,0.5,0",
      "Top [Part] Size=4,4,4 Position=0,3.5,0",
    ]);
    expect(run(editLuau([{ op: "ungroup", path: "Workspace.Yard.Stack" }]))).toBe("ok · 2 instances changed (one undo step)\n1 ungrouped 2");
    expect(run(editLuau([{ op: "delete", path: "Workspace.Nothing" }, { op: "group", query: { path: "Workspace.Yard", name: "zzz" } }])).split("\n").slice(1)).toEqual([
      "1 FAILED delete: not found: Workspace.Nothing",
      "2 FAILED group: nothing to group",
    ]);
  });

  it("reads numbered script lines and patches several scripts in one call", () => {
    run(scriptsToLuau([{ name: "Shop", kind: "Script", parent: "ServerScriptService", source: "local price = 10\nspawn(function()\n\twait(1)\n\tprint(price)\nend)\nreturn price" }]).code);
    expect(run(scriptReadLuau([parseScriptRead("ServerScriptService.Shop:2-3"), parseScriptRead("Workspace")]))).toBe(
      "== ServerScriptService.Shop [Script] lines 2-3 of 6\n2\tspawn(function()\n3\t\twait(1)\n== Workspace: Workspace is a Workspace, not a script",
    );
    const out = run(scriptPatchLuau([
      { path: "ServerScriptService.Shop", edits: [{ old: "spawn(", new: "task.spawn(" }, { old: "\twait(1)", new: "\ttask.wait(1)" }, { old: "price", new: "cost", all: true }] },
      { path: "ServerScriptService.Shop", edits: [{ old: "print(cost) ", new: "x" }] },
      { path: "ServerScriptService.Shop", edits: [{ old: "cost", new: "x" }] },
      { path: "ReplicatedStorage.Prices", source: "return { sword = 10 }", class: "ModuleScript" },
    ]));
    expect(out.split("\n")).toEqual([
      "2 of 4 scripts failed (the others were saved)",
      "1 ServerScriptService.Shop: 3 edits at line 2, 3, 1 (6 → 6 lines)",
      "2 FAILED ServerScriptService.Shop: edit 1: old text not found (its first line is at line 4: check whitespace and the lines after it)",
      "3 FAILED ServerScriptService.Shop: edit 1: old text is found 3 times; include more surrounding text or set all",
      "4 ReplicatedStorage.Prices: created (1 → 1 lines)",
    ]);
    expect(run(scriptReadLuau([{ path: "ServerScriptService.Shop" }])).split("\n").slice(1)).toEqual([
      "1\tlocal cost = 10", "2\ttask.spawn(function()", "3\t\ttask.wait(1)", "4\t\tprint(cost)", "5\tend)", "6\treturn cost",
    ]);
  });

  it("audits the place for what will break or slow the game", () => {
    run(editLuau([
      { op: "create", class: "Folder", name: "Audit", parent: "Workspace", children: [
        { class: "Part", name: "Falls", props: { Size: [1, 1, 1], Position: [0, 5, 0], Anchored: false } },
        { class: "Part", name: "Held", props: { Size: [1, 1, 1], Position: [0, 6, 0], Anchored: false } },
        { class: "Part", name: "Root", props: { Size: [1, 1, 1], Position: [0, 7, 0], Anchored: false }, children: [{ class: "WeldConstraint", name: "W" }] },
        { class: "Part", name: "Wall", props: { Size: [1, 9, 9], Position: [9, 4.5, 0], Transparency: 1 } },
        { class: "Part", name: "Wall2", props: { Size: [1, 9, 9], Position: [9, 4.5, 0], Transparency: 1 } },
        { class: "Part", name: "Void", props: { Size: [1, 1, 1], Position: [0, -900, 0] } },
        { class: "LocalScript", name: "Lost", props: { Source: "print('never runs')" } },
      ] },
      { op: "set", path: "Workspace.Audit.Root.W", props: { Part0: "@Workspace.Audit.Root", Part1: "@Workspace.Audit.Held" } },
    ]));
    expect(run(auditLuau("Workspace.Audit")).split("\n")).toEqual([
      "Audit of Workspace.Audit: 6 parts in Workspace, 1 scripts, 0 shadow-casting lights, StreamingEnabled off.",
      "Problems:",
      "- unanchored parts with no joints (they fall at play: anchor or weld them) (1): Workspace.Audit.Falls",
      "- parts below FallenPartsDestroyHeight (deleted at play) (1): Workspace.Audit.Void",
      "- LocalScripts that never run there (use StarterPlayerScripts, StarterGui or StarterCharacterScripts) (1): Workspace.Audit.Lost",
      "Warnings:",
      "- invisible parts that still collide (2): Workspace.Audit.Wall, Workspace.Audit.Wall2",
      "- duplicate parts in the same spot as another (flicker, wasted parts) (1): Workspace.Audit.Wall2",
    ]);
    run(scriptsToLuau([{ name: "Old", kind: "Script", parent: "ServerScriptService", source: "local p = game.Players.LocalPlayer\nwait(1)\nscript.Parent.Touched:connect(print)\n-- spawn(f) in a comment" }]).code);
    const scripts = run(auditLuau("ServerScriptService")).split("\n");
    expect(scripts).toContain("- server Scripts using LocalPlayer (it is nil on the server) (1): ServerScriptService.Old:1");
    expect(scripts).toContain("- wait() is deprecated: use task.wait() (1): ServerScriptService.Old:2");
    expect(scripts).toContain("- :connect() is deprecated: use :Connect() (1): ServerScriptService.Old:3");
    expect(scripts.join("\n")).not.toMatch(/spawn\(\) is deprecated/);
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
