import { describe, expect, it } from "vitest";
import { applyModelEdit, nameMatches, sanitizeModelSpec, type ModelSpec } from "../src/shared/model.ts";
import { applyUiEdit, sanitizeUiSpec, UiSpecSchema } from "../src/shared/ui.ts";

// Bulk edits change many parts or nodes in one short call instead of one update per name.

const house: ModelSpec = sanitizeModelSpec({
  name: "House",
  parts: [
    { name: "Floor", size: [10, 1, 10], pos: [0, 0.5, 0], material: "WoodPlanks", color: "#8a5a32" },
    { name: "Wall", size: [10, 6, 1], pos: [0, 4, -4.5], color: "#d9d2c0", group: "Walls" },
    { name: "Wall1", size: [10, 6, 1], pos: [0, 4, 4.5], color: "#d9d2c0", group: "Walls" },
    { name: "Roof", size: [11, 1, 11], pos: [0, 7.5, 0], color: "#7a2b22", group: "Roof" },
    { name: "Trim", size: [11, 0.3, 0.3], pos: [0, 7, 5.5], color: "#7a2b22", group: "Roof/Trim" },
    { name: "Lamp", size: [1, 1, 1], pos: [0, 6, 0], material: "Neon", color: "#ffd27a", light: { type: "point", color: "#ffd27a" } },
  ],
});

describe("bulk edits", () => {
  it("matches names exactly, by numbered-copy base, or with wildcards", () => {
    expect(nameMatches("Plank", "Plank")).toBe(true);
    expect(nameMatches("Plank12", "Plank")).toBe(true);
    expect(nameMatches("Planks", "Plank")).toBe(false);
    expect(nameMatches("LeftWindow", "*window")).toBe(true);
    expect(nameMatches("Window.Glass", "Window.*")).toBe(true);
    expect(nameMatches(undefined, "*")).toBe(false);
  });

  it("changes every model part matching a filter, and swaps colors everywhere", () => {
    const { spec, missing } = applyModelEdit(house, {
      updateWhere: [
        { where: { group: "Roof" }, set: { material: "Slate" } },
        { where: { name: "Wall" }, move: [0, 1, 0] },
        { where: { material: "Glass" }, set: { transparency: 0.5 } },
      ],
      recolor: { "#7A2B22": "#2b4a7a", "#ffd27a": "#9fd0ff" },
    });
    expect(missing).toEqual(['where {"material":"Glass"}']);
    const part = (n: string) => spec.parts.find((p) => p.name === n)!;
    expect([part("Roof").material, part("Trim").material, part("Floor").material]).toEqual(["Slate", "Slate", "WoodPlanks"]);
    expect([part("Wall").pos[1], part("Wall1").pos[1]]).toEqual([5, 5]);
    expect([part("Roof").color, part("Trim").color]).toEqual(["#2b4a7a", "#2b4a7a"]);
    expect(part("Lamp")).toMatchObject({ color: "#9fd0ff", light: { color: "#9fd0ff" } });
    expect(applyModelEdit(house, { recolor: { "#000000": "#ffffff" } }).missing).toEqual(["recolor: no part has #000000"]);
  });

  it("changes every UI node matching a filter, and swaps a theme color everywhere", () => {
    const ui = sanitizeUiSpec(UiSpecSchema.parse({
      name: "Shop",
      nodes: [
        { name: "Panel", type: "Frame", bg: "#1e2230", stroke: { color: "#3b82f6" } },
        { name: "Title", type: "TextLabel", parent: "Panel", text: "Shop", textColor: "#3b82f6" },
        { name: "Buy", type: "TextButton", parent: "Panel", bg: "#3b82f6", text: "Buy" },
        { name: "Buy1", type: "TextButton", parent: "Panel", bg: "#3b82f6", text: "Sell", gradient: { colors: ["#ffffff", "#3b82f6"] } },
        { name: "Close", type: "TextButton", bg: "#ef4444", text: "X" },
      ],
    })).spec;
    const { spec, missing } = applyUiEdit(ui, {
      updateWhere: [{ where: { type: "TextButton", under: "Panel" }, set: { corner: 12, textSize: 20 } }],
      recolor: { "#3b82f6": "#22c55e" },
    });
    expect(missing).toEqual([]);
    const node = (n: string) => spec.nodes.find((x) => x.name === n)!;
    expect([node("Buy").corner, node("Buy1").corner, node("Close").corner]).toEqual([12, 12, undefined]);
    expect(node("Panel").stroke?.color).toBe("#22c55e");
    expect(node("Title").textColor).toBe("#22c55e");
    expect(node("Buy").bg).toBe("#22c55e");
    expect(node("Buy1").gradient?.colors).toEqual(["#ffffff", "#22c55e"]);
    expect(node("Close").bg).toBe("#ef4444");
  });
});
