import type { ModelSpec } from "../src/shared/model.ts";
import type { UiSpec } from "../src/shared/ui.ts";
import type { ScriptSpec } from "../src/shared/script.ts";

export const lanternModel: ModelSpec = {
  name: "Street Lantern",
  parts: [
    { name: "Base", size: [3, 0.6, 3], pos: [0, 0.3, 0], color: "#2b2b30", material: "Slate" },
    { name: "Pole", shape: "cylinder", axis: "y", size: [0.5, 9, 0.5], pos: [0, 5.1, 0], color: "#1d1d22", material: "Metal" },
    { name: "Arm", size: [2.5, 0.3, 0.3], pos: [1, 9.4, 0], rot: [0, 0, 15], color: "#1d1d22", material: "Metal" },
    { name: "Glass", size: [1.4, 1.8, 1.4], pos: [2, 8.6, 0], color: "#ffd27a", material: "Glass", transparency: 0.4, group: "Lamp" },
    {
      name: "Bulb", shape: "ball", size: [0.8, 0.8, 0.8], pos: [2, 8.6, 0], color: "#ffcc66", material: "Neon", group: "Lamp",
      light: { type: "point", color: "#ffbb55", brightness: 2, range: 18, shadows: true },
    },
    { name: "Cap", shape: "wedge", size: [1.6, 0.5, 1.6], pos: [2, 9.75, 0], rot: [0, 90, 0], color: "#1d1d22", material: "Metal", group: "Lamp/Top" },
    { name: "Side", shape: "cylinder", axis: "z", size: [0.4, 0.4, 2], pos: [0, 2, 0], color: "#444444", material: "DiamondPlate", collide: false },
    {
      name: "Spot", size: [0.4, 0.2, 0.4], pos: [0, 0.7, 0], color: "#ffffff", material: "SmoothPlastic",
      light: { type: "spot", angle: 60, face: "Top", brightness: 1.5, range: 10 },
    },
  ],
};

/** Six touching identical blocks forming a wall → should merge into one part. */
export const wallModel: ModelSpec = {
  name: "Wall",
  parts: Array.from({ length: 6 }, (_, i) => ({
    name: `Brick${i}`,
    size: [2, 3, 1],
    pos: [i * 2, 1.5, 0],
    color: "#8a3b2b",
    material: "Brick" as const,
  })),
};

export const shopUi: UiSpec = {
  name: "ShopUI",
  ignoreInset: true,
  nodes: [
    {
      name: "Window", type: "Frame", pos: [0.5, 0, 0.5, 0], size: [0.6, 0, 0.7, 0], anchor: [0.5, 0.5], bg: "#15161c",
      corner: 16, stroke: { color: "#3a3d4d", thickness: 2 }, padding: 16, aspect: 1.6,
    },
    {
      name: "Title", parent: "Window", type: "TextLabel", size: [1, 0, 0, 48], text: "Item Shop <b>&</b> more", font: "GothamBold",
      textSize: 32, textColor: "#f4f4f8", xAlign: "left", rich: true, textStroke: { color: "#000000", transparency: 0.6 },
    },
    {
      name: "Grid", parent: "Window", type: "ScrollingFrame", pos: [0, 0, 0, 60], size: [1, 0, 1, -60], bgT: 1,
      canvas: [0, 0, 0, 0], autoCanvas: "y", scrollBar: 4, scrollColor: "#6c6f85",
      layout: { type: "grid", cell: [0, 140, 0, 170], cellGap: [12, 12], hAlign: "center", maxCells: 4 },
    },
    {
      name: "Card1", parent: "Grid", type: "Frame", bg: "#ffffff", corner: [0, 12], order: 1,
      gradient: { colors: ["#3b82f6", "#8b5cf6"], rotation: 90, transparency: [0, 0.2] },
      layout: { type: "list", dir: "vertical", gap: 6, hAlign: "center", vAlign: "center" },
    },
    { name: "Icon", parent: "Card1", type: "ImageLabel", size: [0, 64, 0, 64], image: "rbxassetid://1234567", scaleType: "Fit", imageColor: "#ffffff" },
    { name: "Price", parent: "Card1", type: "TextButton", size: [0.8, 0, 0, 32], bg: "#22c55e", corner: [0.5, 0], text: "250 💎", font: "FredokaOne", textScaled: true, order: 2 },
    { name: "Search", parent: "Window", type: "TextBox", pos: [1, 0, 0, 8], anchor: [1, 0], size: [0, 200, 0, 32], placeholder: "Search…", placeholderColor: "#8888aa", bg: "#23242d", textColor: "#ffffff", xAlign: "left", padding: [0, 8, 0, 8], corner: 8 },
    { name: "Badge", parent: "Window", type: "ImageButton", pos: [1, -8, 1, -8], anchor: [1, 1], size: [0, 40, 0, 40], image: "rbxassetid://99", scaleType: "Slice", slice: [8, 8, 24, 24], rotation: 12, z: 3 },
    { name: "Footer", parent: "Window", type: "Frame", pos: [0, 0, 1, 0], anchor: [0, 1], size: [1, 0, 0, 0], autoSize: "y", bgT: 1, visible: false, clip: true, layout: { type: "list", dir: "horizontal", gap: 4, wraps: true } },
  ],
};

export const doorScript: ScriptSpec = {
  name: "DoorController",
  kind: "Script",
  parent: "ServerScriptService",
  source: 'local msg = "say \\"hi\\" ]] ]=] ]==]"\nprint(msg, [[\nlong]])\n-- ünïcødé ✓\n',
};

/** Auto-scaled HUD with explicit gradient stops and truncated text. */
export const scaledHud: UiSpec = {
  name: "ScaledHud",
  ignoreInset: true,
  autoScale: { width: 1280, height: 720, min: 0.4 },
  nodes: [
    { name: "Health", type: "Frame", pos: [0, 24, 1, -24], anchor: [0, 1], size: [0, 320, 0, 28], bg: "#ffffff", corner: [0.5, 0],
      gradient: { colors: ["#ef4444", "#f97316", "#facc15"], stops: [0, 0.7, 1], transparency: [0, 0.1, 0.3], rotation: 0 } },
    { name: "Quest", type: "TextLabel", parent: "Health", pos: [0, 0, 0, -30], size: [1, 0, 0, 22], text: "Defeat the dragon in the northern mountains before nightfall", truncate: true, xAlign: "left", textSize: 16 },
  ],
};
