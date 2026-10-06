import { describe, expect, it } from "vitest";
import { decodeDds } from "../src/shared/dds.ts";

/** A DDS file: 128-byte header followed by the given payload. */
function dds(width: number, height: number, format: { fourCC?: string; bits?: number; masks?: number[] }, payload: number[]): ArrayBuffer {
  const buf = new ArrayBuffer(128 + payload.length);
  const v = new DataView(buf);
  v.setUint32(0, 0x20534444, true);
  v.setUint32(4, 124, true);
  v.setUint32(12, height, true);
  v.setUint32(16, width, true);
  v.setUint32(76, 32, true);
  if (format.fourCC) {
    v.setUint32(80, 0x4, true);
    for (let i = 0; i < 4; i++) v.setUint8(84 + i, format.fourCC.charCodeAt(i));
  } else {
    v.setUint32(80, 0x41, true);
    v.setUint32(88, format.bits!, true);
    format.masks!.forEach((m, i) => v.setUint32(92 + i * 4, m, true));
  }
  new Uint8Array(buf, 128).set(payload);
  return buf;
}
const px = (img: { data: Uint8ClampedArray; width: number }, x: number, y: number) => [...img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

describe("DDS textures", () => {
  it("decodes DXT5 with interpolated alpha", () => {
    // alpha0 255, alpha1 0, every pixel index 0 except pixel 1 → index 1 and pixel 15 → index 7
    const alphaBits = (1n << 3n) | (7n << 45n);
    const a = [...Array(6)].map((_, i) => Number((alphaBits >> BigInt(8 * i)) & 255n));
    // color: c0 red, c1 blue; pixel 0 → c0, pixel 1 → c1, pixel 2 → 2/3 c0 + 1/3 c1, others c0
    const colorBits = (1 << 2) | (2 << 4);
    const payload = [255, 0, ...a, 0x00, 0xf8, 0x1f, 0x00, colorBits & 255, (colorBits >> 8) & 255, 0, 0];
    const img = decodeDds(dds(4, 4, { fourCC: "DXT5" }, payload));
    expect(px(img, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(img, 1, 0)).toEqual([0, 0, 255, 0]);
    expect(px(img, 2, 0)).toEqual([170, 0, 85, 255]);
    expect(px(img, 3, 3)[3]).toBe(36); // index 7: (1·255 + 6·0) / 7
  });

  it("decodes DXT1 with its transparent mode", () => {
    // c0 <= c1 → 3 colors + transparent black; pixel 0 → index 3
    const payload = [0x00, 0x00, 0xff, 0xff, 3, 0, 0, 0];
    const img = decodeDds(dds(4, 4, { fourCC: "DXT1" }, payload));
    expect(px(img, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(px(img, 1, 0)).toEqual([0, 0, 0, 255]);
  });

  it("decodes uncompressed BGRA and crops odd sizes", () => {
    const img = decodeDds(dds(1, 1, { bits: 32, masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000] }, [10, 20, 30, 40]));
    expect(px(img, 0, 0)).toEqual([30, 20, 10, 40]);
    const small = decodeDds(dds(2, 2, { fourCC: "DXT1" }, [0x00, 0xf8, 0x00, 0xf8, 0, 0, 0, 0]));
    expect(small.data.length).toBe(16);
    expect(() => decodeDds(new ArrayBuffer(10))).toThrow(/DDS/);
  });
});
