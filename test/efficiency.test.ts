import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expandModelInput, ModelSpecInputSchema, ModelSpecSchema, sanitizeModelSpec } from "../src/shared/model.ts";
import { expandUiInput, sanitizeUiSpec, UiSpecInputSchema, UiSpecSchema } from "../src/shared/ui.ts";
import { modelToLuau, uiToLuau } from "../src/shared/to-luau.ts";
import { ForgeMcp } from "../src/server/forge-mcp.ts";
import { compactModel, compactUi, nodesUnder, partsInGroup } from "../src/shared/compact.ts";
import { checkModel, describeIssues } from "../src/shared/diagnostics.ts";

describe("spec shorthand", () => {
  it("expands styles, repeat, copies and clones into plain parts", () => {
    const input = ModelSpecInputSchema.parse({
      name: "Yard",
      styles: { post: { size: [0.6, 3, 0.6], color: "#6b4a2b", material: "Wood" } },
      parts: [
        { name: "Post", style: "post", pos: [0, 1.5, 0], repeat: { count: 3, step: [4, 0, 0] } },
        { name: "Lamp", size: [1, 1, 1], pos: [0, 4, 0], copies: [[10, 0, 0]], material: "Neon" },
        { name: "Trunk", style: "post", size: [1, 4, 1], pos: [20, 2, 0], group: "Tree" },
        { name: "Leaves", size: [4, 4, 4], pos: [20, 6, 0], shape: "ball", group: "Tree/Top" },
      ],
      clones: [{ group: "Tree", offsets: [[0, 0, 10], [0, 0, 20]] }],
    });
    const spec = sanitizeModelSpec(expandModelInput(input));
    const byName = Object.fromEntries(spec.parts.map((p) => [p.name, p]));
    expect(spec.parts.map((p) => p.name)).toEqual(["Post1", "Post2", "Post3", "Lamp1", "Lamp2", "Trunk", "Leaves", "Trunk2", "Leaves2", "Trunk3", "Leaves3"]);
    expect(byName.Post3).toMatchObject({ pos: [8, 1.5, 0], size: [0.6, 3, 0.6], material: "Wood", color: "#6b4a2b" });
    expect(byName.Lamp2.pos).toEqual([10, 4, 0]);
    expect(byName.Trunk.size).toEqual([1, 4, 1]); // fields on the part win over the style
    expect(byName.Leaves3).toMatchObject({ group: "Tree3/Top", pos: [20, 6, 20] });
    expect(ModelSpecSchema.safeParse(spec).success).toBe(true);
  });

  it("explains missing styles and sizes", () => {
    expect(() => expandModelInput(ModelSpecInputSchema.parse({ name: "A", parts: [{ style: "nope", size: [1, 1, 1], pos: [0, 0, 0] }] }))).toThrow(/Unknown style "nope"/);
    expect(() => expandModelInput(ModelSpecInputSchema.parse({ name: "A", parts: [{ name: "X", pos: [0, 0, 0] }] }))).toThrow(/"X" has no size/);
  });

  it("expands UI styles (node fields win)", () => {
    const input = UiSpecInputSchema.parse({
      name: "Shop",
      styles: { card: { type: "Frame", bg: "#1e2230", corner: 12, size: [0, 200, 0, 120] } },
      nodes: [
        { name: "A", type: "Frame", style: "card" },
        { name: "B", type: "TextLabel", style: "card", bg: "#000000", text: "Hi" },
      ],
    });
    const { spec } = sanitizeUiSpec(expandUiInput(input));
    expect(spec.nodes[0]).toMatchObject({ name: "A", bg: "#1e2230", corner: 12, size: [0, 200, 0, 120] });
    expect(spec.nodes[1]).toMatchObject({ name: "B", type: "TextLabel", bg: "#000000", corner: 12 });
    expect(UiSpecSchema.safeParse(spec).success).toBe(true);
  });
});

describe("token and payload budgets", () => {
  const forge = new ForgeMcp({ bridge: { status: {}, connected: false } as never, getSettings: () => ({ autoApproveLuau: false }) as never, convertHtml: async () => { throw new Error("unused"); } });

  it("keeps the advertised tool list small without dropping required fields", () => {
    const list = forge.toolList;
    const json = JSON.stringify(list);
    // ~9k tokens for 32 tools (models, UIs, animations, effects with presets, abilities, scripts and
    // the Studio power tools), served from the prompt cache after the first turn.
    expect(json.length).toBeLessThan(35_500);
    expect(json).not.toMatch(/"pattern":"/); // regex constraints are stripped (a property may be named pattern)
    expect(json).not.toContain("9007199254740991");
    const tool = (n: string) => list.find((t) => t.name === n)!.inputSchema;
    expect(tool("create_model").required).toEqual(expect.arrayContaining(["name", "parts"]));
    expect(tool("create_ui").required).toEqual(expect.arrayContaining(["name", "nodes"]));
    expect(tool("edit_model").required).toEqual(["id"]);
    expect(tool("edit_ui").properties.add.description).toMatch(/create_ui/);
    // Lookups are marked read-only so Claude Code runs several of them in parallel.
    const hint = (n: string) => (list.find((t) => t.name === n) as { annotations?: { readOnlyHint?: boolean } }).annotations?.readOnlyHint;
    expect(["studio_query", "studio_scripts", "studio_audit", "get_asset"].map(hint)).toEqual([true, true, true, true]);
    expect(["studio_edit", "studio_script_patch", "create_model"].map(hint)).toEqual([undefined, undefined, undefined]);
  });

  it("writes only non-default properties in UI Luau", () => {
    const shop = sanitizeUiSpec(UiSpecSchema.parse(JSON.parse(readFileSync("examples/item-shop.ui.json", "utf8")).spec)).spec;
    const { code } = uiToLuau(shop, { assetId: "u_test01", version: 1 });
    expect(code.length).toBeLessThan(30_000);
    expect(code).not.toMatch(/Visible = true|ZIndex = 1,|LayoutOrder = 0,|RichText = false|TextScaled = false/);
    expect(code).toContain("local F = { Font.new(");
  });

  it("moves models with Model:PivotTo when available", () => {
    const cabin = sanitizeModelSpec(ModelSpecSchema.parse(JSON.parse(readFileSync("examples/cozy-cabin.model.json", "utf8")).spec));
    expect(modelToLuau(cabin).code).toContain("model:PivotTo(target)");
  });
});

describe("get_asset compact form", () => {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;

  it("factors repeated looks into styles and expands back to the same model", () => {
    const cabin = sanitizeModelSpec(ModelSpecSchema.parse(JSON.parse(readFileSync("examples/cozy-cabin.model.json", "utf8")).spec));
    const compact = compactModel(cabin);
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(cabin).length * 0.9);
    expect(canon(sanitizeModelSpec(expandModelInput(ModelSpecInputSchema.parse(compact))))).toEqual(canon(cabin));
  });

  it("does the same for UIs", () => {
    const shop = sanitizeUiSpec(UiSpecSchema.parse(JSON.parse(readFileSync("examples/item-shop.ui.json", "utf8")).spec)).spec;
    const compact = compactUi(shop);
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(shop).length * 0.85);
    expect(canon(sanitizeUiSpec(expandUiInput(UiSpecInputSchema.parse(compact))).spec)).toEqual(canon(shop));
  });

  it("reads one group of a model, or a node with its children", () => {
    const cabin = sanitizeModelSpec(ModelSpecSchema.parse(JSON.parse(readFileSync("examples/cozy-cabin.model.json", "utf8")).spec));
    const windows = partsInGroup(cabin.parts, "Cabin/Windows");
    expect(windows.length).toBeGreaterThan(3);
    expect(windows.every((p) => p.group === "Cabin/Windows")).toBe(true);
    expect(partsInGroup(cabin.parts, "Cabin").length).toBeGreaterThan(windows.length);
    const shop = sanitizeUiSpec(UiSpecSchema.parse(JSON.parse(readFileSync("examples/item-shop.ui.json", "utf8")).spec)).spec;
    const grid = nodesUnder(shop.nodes, ["Grid"]);
    expect(grid[0].name).toBe("Grid");
    expect(grid.length).toBeGreaterThan(4);
  });
});

describe("positioning checks", () => {
  const model = (parts: unknown[]) => sanitizeModelSpec(ModelSpecSchema.parse({ name: "T", parts }));

  it("finds floating parts, parts below the ground, z-fighting and duplicates", () => {
    const issues = checkModel(model([
      { name: "Floor", size: [10, 1, 10], pos: [0, 0.5, 0], color: "#808080" },
      { name: "Rug", size: [4, 1, 4], pos: [0, 0.5, 0], color: "#aa2222" }, // top face level with the floor's
      { name: "Bird", size: [1, 1, 1], pos: [0, 6, 0] }, // touches nothing
      { name: "Glow", size: [1, 1, 1], pos: [3, 6, 0], material: "Neon" }, // effects may hover
      { name: "Post", size: [1, 4, 1], pos: [4, 1, 4] }, // reaches y = -1
      { name: "PostCopy", size: [1, 4, 1], pos: [4, 1, 4] },
    ]));
    expect(issues.floating).toEqual(["Bird"]);
    expect(issues.belowGround).toEqual({ depth: 1, parts: ["Post", "PostCopy"] });
    expect(issues.zFighting).toEqual([expect.objectContaining({ face: "top" })]);
    expect(issues.duplicates).toEqual([["Post", "PostCopy"]]);
    expect(describeIssues(issues)).toHaveLength(4);
  });

  it("stays quiet for a well-built model", () => {
    const cabin = sanitizeModelSpec(ModelSpecSchema.parse(JSON.parse(readFileSync("examples/cozy-cabin.model.json", "utf8")).spec));
    expect(describeIssues(checkModel(cabin))).toEqual([]);
  });
});
