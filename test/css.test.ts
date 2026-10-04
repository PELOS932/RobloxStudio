import { describe, expect, it } from "vitest";
import { instanceName, mapFont, parseColor, parseLinearGradient, parseShadows, parseTransform, toHex } from "../src/shared/css.ts";

describe("computed CSS parsing", () => {
  it("parses rgb/rgba/hex/transparent colors", () => {
    expect(parseColor("rgb(59, 130, 246)")).toEqual({ r: 59, g: 130, b: 246, a: 1 });
    expect(parseColor("rgba(0, 0, 0, 0.45)")?.a).toBeCloseTo(0.45);
    expect(parseColor("rgb(10 20 30 / 50%)")).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(toHex(parseColor("#abc")!)).toBe("#aabbcc");
    expect(parseColor("transparent")?.a).toBe(0);
    expect(parseColor("oklch(0.7 0.1 200)")).toBeNull(); // left to the browser resolver
  });

  it("parses linear gradients with angles, sides, missing positions and hints", () => {
    const g = parseLinearGradient("linear-gradient(135deg, rgb(249, 115, 22), rgb(239, 68, 68))")!;
    expect(g.angle).toBe(135);
    expect(g.stops.map((s) => s.pos)).toEqual([0, 1]);
    const side = parseLinearGradient("linear-gradient(to right, rgb(1, 2, 3) 10%, rgb(4, 5, 6), rgb(7, 8, 9) 90%)")!;
    expect(side.angle).toBe(90);
    expect(side.stops.map((s) => s.pos)).toEqual([0.1, 0.5, 0.9]);
    expect(parseLinearGradient("linear-gradient(rgb(0, 0, 0), rgb(255, 255, 255))")!.angle).toBe(180);
    expect(parseLinearGradient("linear-gradient(in oklab 0.25turn, red, blue)")!.angle).toBe(90);
    expect(parseLinearGradient("url(a.png), linear-gradient(red, blue)")!.stops).toHaveLength(2);
    expect(parseLinearGradient("radial-gradient(red, blue)")).toBeNull();
  });

  it("parses box shadows", () => {
    const [s, inset] = parseShadows("rgba(0, 0, 0, 0.5) 0px 20px 60px 0px, rgb(255, 255, 255) 0px 0px 0px 1px inset");
    expect(s).toMatchObject({ x: 0, y: 20, blur: 60, spread: 0, inset: false, color: "rgba(0, 0, 0, 0.5)" });
    expect(inset.inset).toBe(true);
    expect(parseShadows("none")).toEqual([]);
  });

  it("decomposes transforms", () => {
    const r = parseTransform("matrix(0.866025, 0.5, -0.5, 0.866025, 10, 20)");
    expect(r.rotation).toBeCloseTo(30, 3);
    expect(r).toMatchObject({ tx: 10, ty: 20, identityLinear: false });
    expect(parseTransform("matrix(1, 0, 0, 1, -50, 0)").identityLinear).toBe(true);
  });

  it("maps CSS font stacks to Roblox fonts", () => {
    expect(mapFont("Inter, sans-serif", 400)).toBe("BuilderSans");
    expect(mapFont('"Inter", sans-serif', 800)).toBe("BuilderSansExtraBold");
    expect(mapFont("Montserrat", 700)).toBe("GothamBold");
    expect(mapFont("Fredoka, sans-serif", 600)).toBe("FredokaOne");
    expect(mapFont('"Luckiest Guy", cursive', 400)).toBe("LuckiestGuy");
    expect(mapFont('"Press Start 2P"', 400)).toBe("Arcade");
    expect(mapFont("Comic Papyrus, monospace", 400)).toBe("RobotoMono");
    expect(mapFont("UnknownFont", 700)).toBe("BuilderSansBold");
  });

  it("builds instance names", () => {
    expect(instanceName("shop-card__title")).toBe("ShopCardTitle");
    expect(instanceName("3d-view")).toBe("N3dView");
  });
});
