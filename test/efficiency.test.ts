import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expandModelInput, ModelSpecInputSchema, ModelSpecSchema, sanitizeModelSpec } from "../src/shared/model.ts";
import { expandUiInput, sanitizeUiSpec, UiSpecInputSchema, UiSpecSchema } from "../src/shared/ui.ts";
import { modelToLuau, uiToLuau } from "../src/shared/to-luau.ts";
import { ForgeMcp } from "../src/server/forge-mcp.ts";

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
    expect(json.length).toBeLessThan(24_000);
    expect(json).not.toContain('"pattern"');
    expect(json).not.toContain("9007199254740991");
    const tool = (n: string) => list.find((t) => t.name === n)!.inputSchema;
    expect(tool("create_model").required).toEqual(expect.arrayContaining(["name", "parts"]));
    expect(tool("create_ui").required).toEqual(expect.arrayContaining(["name", "nodes"]));
    expect(tool("edit_model").required).toEqual(["id"]);
    expect(tool("edit_ui").properties.add.description).toMatch(/create_ui/);
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
