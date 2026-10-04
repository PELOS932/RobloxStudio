// Roblox engine reference data. Enum values were taken from the rbx-dom
// reflection database (via Lune) so exported .rbxmx files and generated Luau
// stay in sync with what Studio expects.

export const MATERIAL_ENUM = {
  Plastic: 256,
  SmoothPlastic: 272,
  Neon: 288,
  Wood: 512,
  WoodPlanks: 528,
  Marble: 784,
  Basalt: 788,
  Slate: 800,
  CrackedLava: 804,
  Concrete: 816,
  Limestone: 820,
  Granite: 832,
  Pavement: 836,
  Brick: 848,
  Pebble: 864,
  Cobblestone: 880,
  Rock: 896,
  Sandstone: 912,
  CorrodedMetal: 1040,
  DiamondPlate: 1056,
  Foil: 1072,
  Metal: 1088,
  Grass: 1280,
  LeafyGrass: 1284,
  Sand: 1296,
  Fabric: 1312,
  Snow: 1328,
  Mud: 1344,
  Ground: 1360,
  Asphalt: 1376,
  Salt: 1392,
  Ice: 1536,
  Glacier: 1552,
  Glass: 1568,
  ForceField: 1584,
  Cardboard: 2304,
  Carpet: 2305,
  CeramicTiles: 2306,
  ClayRoofTiles: 2307,
  RoofShingles: 2308,
  Leather: 2309,
  Plaster: 2310,
  Rubber: 2311,
} as const;

export type MaterialName = keyof typeof MATERIAL_ENUM;
export const MATERIALS = Object.keys(MATERIAL_ENUM) as [MaterialName, ...MaterialName[]];

export const PART_TYPE_ENUM = { Ball: 0, Block: 1, Cylinder: 2 } as const;

export const NORMAL_ID_ENUM = { Right: 0, Top: 1, Back: 2, Left: 3, Bottom: 4, Front: 5 } as const;
export type NormalIdName = keyof typeof NORMAL_ID_ENUM;
export const NORMAL_IDS = Object.keys(NORMAL_ID_ENUM) as [NormalIdName, ...NormalIdName[]];

export const TEXT_X_ALIGN_ENUM = { Left: 0, Right: 1, Center: 2 } as const;
export const TEXT_Y_ALIGN_ENUM = { Top: 0, Center: 1, Bottom: 2 } as const;
export const FILL_DIRECTION_ENUM = { Horizontal: 0, Vertical: 1 } as const;
export const HORIZONTAL_ALIGN_ENUM = { Center: 0, Left: 1, Right: 2 } as const;
export const VERTICAL_ALIGN_ENUM = { Center: 0, Top: 1, Bottom: 2 } as const;
export const SORT_ORDER_LAYOUT_ORDER = 2;
export const SCALE_TYPE_ENUM = { Stretch: 0, Slice: 1, Tile: 2, Fit: 3, Crop: 4 } as const;
export const AUTOMATIC_SIZE_ENUM = { None: 0, X: 1, Y: 2, XY: 3 } as const;
export const APPLY_STROKE_MODE_BORDER = 1;
export const ZINDEX_BEHAVIOR_SIBLING = 1;
export const SCREEN_INSETS_ENUM = { None: 0, DeviceSafeInsets: 1, CoreUISafeInsets: 2 } as const;
export const SCROLLING_DIRECTION_ENUM = { X: 1, Y: 2, XY: 4 } as const;

/** Enum.Font name → serialized FontFace + closest freely available web font for previews. */
export const FONTS = {
  BuilderSans: { family: "BuilderSans", weight: 400, style: "Normal", web: "Inter", value: 46 },
  BuilderSansMedium: { family: "BuilderSans", weight: 500, style: "Normal", web: "Inter", value: 47 },
  BuilderSansBold: { family: "BuilderSans", weight: 700, style: "Normal", web: "Inter", value: 48 },
  BuilderSansExtraBold: { family: "BuilderSans", weight: 800, style: "Normal", web: "Inter", value: 49 },
  Gotham: { family: "GothamSSm", weight: 400, style: "Normal", web: "Montserrat", value: 17 },
  GothamMedium: { family: "GothamSSm", weight: 500, style: "Normal", web: "Montserrat", value: 18 },
  GothamBold: { family: "GothamSSm", weight: 700, style: "Normal", web: "Montserrat", value: 19 },
  GothamBlack: { family: "GothamSSm", weight: 900, style: "Normal", web: "Montserrat", value: 20 },
  SourceSans: { family: "SourceSansPro", weight: 400, style: "Normal", web: "Source Sans 3", value: 3 },
  SourceSansLight: { family: "SourceSansPro", weight: 300, style: "Normal", web: "Source Sans 3", value: 5 },
  SourceSansSemibold: { family: "SourceSansPro", weight: 600, style: "Normal", web: "Source Sans 3", value: 16 },
  SourceSansBold: { family: "SourceSansPro", weight: 700, style: "Normal", web: "Source Sans 3", value: 4 },
  SourceSansItalic: { family: "SourceSansPro", weight: 400, style: "Italic", web: "Source Sans 3", value: 6 },
  Arial: { family: "Arial", weight: 400, style: "Normal", web: "Arimo", value: 1 },
  ArialBold: { family: "Arial", weight: 700, style: "Normal", web: "Arimo", value: 2 },
  Arimo: { family: "Arimo", weight: 400, style: "Normal", web: "Arimo", value: 50 },
  ArimoBold: { family: "Arimo", weight: 700, style: "Normal", web: "Arimo", value: 51 },
  Roboto: { family: "Roboto", weight: 400, style: "Normal", web: "Roboto", value: 39 },
  RobotoCondensed: { family: "RobotoCondensed", weight: 400, style: "Normal", web: "Roboto Condensed", value: 40 },
  RobotoMono: { family: "RobotoMono", weight: 400, style: "Normal", web: "Roboto Mono", value: 41 },
  Ubuntu: { family: "Ubuntu", weight: 400, style: "Normal", web: "Ubuntu", value: 45 },
  Nunito: { family: "Nunito", weight: 400, style: "Normal", web: "Nunito", value: 35 },
  Oswald: { family: "Oswald", weight: 400, style: "Normal", web: "Oswald", value: 36 },
  Merriweather: { family: "Merriweather", weight: 400, style: "Normal", web: "Merriweather", value: 33 },
  FredokaOne: { family: "FredokaOne", weight: 400, style: "Normal", web: "Fredoka", value: 26, webWeight: 600 },
  LuckiestGuy: { family: "LuckiestGuy", weight: 400, style: "Normal", web: "Luckiest Guy", value: 32 },
  Bangers: { family: "Bangers", weight: 400, style: "Normal", web: "Bangers", value: 22 },
  Creepster: { family: "Creepster", weight: 400, style: "Normal", web: "Creepster", value: 23 },
  DenkOne: { family: "DenkOne", weight: 400, style: "Normal", web: "Denk One", value: 24 },
  Fondamento: { family: "Fondamento", weight: 400, style: "Normal", web: "Fondamento", value: 25 },
  GrenzeGotisch: { family: "GrenzeGotisch", weight: 400, style: "Normal", web: "Grenze Gotisch", value: 27 },
  IndieFlower: { family: "IndieFlower", weight: 400, style: "Normal", web: "Indie Flower", value: 28 },
  JosefinSans: { family: "JosefinSans", weight: 400, style: "Normal", web: "Josefin Sans", value: 29 },
  Jura: { family: "Jura", weight: 400, style: "Normal", web: "Jura", value: 30 },
  Kalam: { family: "Kalam", weight: 400, style: "Normal", web: "Kalam", value: 31 },
  Michroma: { family: "Michroma", weight: 400, style: "Normal", web: "Michroma", value: 34 },
  PatrickHand: { family: "PatrickHand", weight: 400, style: "Normal", web: "Patrick Hand", value: 37 },
  PermanentMarker: { family: "PermanentMarker", weight: 400, style: "Normal", web: "Permanent Marker", value: 38 },
  Sarpanch: { family: "Sarpanch", weight: 400, style: "Normal", web: "Sarpanch", value: 42 },
  SpecialElite: { family: "SpecialElite", weight: 400, style: "Normal", web: "Special Elite", value: 43 },
  TitilliumWeb: { family: "TitilliumWeb", weight: 400, style: "Normal", web: "Titillium Web", value: 44 },
  AmaticSC: { family: "AmaticSC", weight: 400, style: "Normal", web: "Amatic SC", value: 21 },
  Arcade: { family: "PressStart2P", weight: 400, style: "Normal", web: "Press Start 2P", value: 13 },
  Code: { family: "Inconsolata", weight: 400, style: "Normal", web: "Inconsolata", value: 10 },
  Cartoon: { family: "ComicNeueAngular", weight: 400, style: "Normal", web: "Comic Neue", value: 9 },
  Fantasy: { family: "Balthazar", weight: 400, style: "Normal", web: "Balthazar", value: 14 },
  SciFi: { family: "Zekton", weight: 400, style: "Normal", web: "Orbitron", value: 12 },
  Highway: { family: "HighwayGothic", weight: 400, style: "Normal", web: "Overpass", value: 11 },
  Garamond: { family: "Guru", weight: 400, style: "Normal", web: "Gurajada", value: 8 },
  Bodoni: { family: "AccanthisADFStd", weight: 400, style: "Normal", web: "Libre Bodoni", value: 7 },
  Antique: { family: "RomanAntique", weight: 400, style: "Normal", web: "Cinzel", value: 15 },
} as const;

export type FontName = keyof typeof FONTS;
export const FONT_NAMES = Object.keys(FONTS) as [FontName, ...FontName[]];

/** Roblox top bar inset used when a ScreenGui does not ignore the GUI inset. */
export const TOPBAR_INSET = 58;

export const FONT_WEIGHT_NAMES: Record<number, string> = {
  100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Heavy",
};

export function fontFamilyUrl(font: FontName): string {
  return `rbxasset://fonts/families/${FONTS[font].family}.json`;
}
