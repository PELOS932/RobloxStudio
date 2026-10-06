// A small DDS reader for Roblox's built-in textures (content/textures/…/*.dds): the top mip level
// of DXT1, DXT3, DXT5 or uncompressed 32/24-bit images, decoded to RGBA8.

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, row by row from the top. */
  data: Uint8ClampedArray<ArrayBuffer>;
}

const DDSD_MAGIC = 0x20534444; // "DDS "
const DDPF_FOURCC = 0x4;
const fourCC = (s: string) => s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24);
const DXT1 = fourCC("DXT1");
const DXT3 = fourCC("DXT3");
const DXT5 = fourCC("DXT5");

function rgb565(c: number, out: number[], o: number) {
  const r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
  out[o] = (r << 3) | (r >> 2);
  out[o + 1] = (g << 2) | (g >> 4);
  out[o + 2] = (b << 3) | (b >> 2);
}

/** Decode the 4×4 color part of a DXT block at `p` into `px` (16 RGBA pixels). */
function colorBlock(v: DataView, p: number, px: Uint8ClampedArray, alphaFromColor: boolean) {
  const c0 = v.getUint16(p, true), c1 = v.getUint16(p + 2, true);
  const pal: number[] = new Array(16).fill(255);
  rgb565(c0, pal, 0);
  rgb565(c1, pal, 4);
  if (c0 > c1 || !alphaFromColor) {
    for (let i = 0; i < 3; i++) {
      pal[8 + i] = Math.round((2 * pal[i] + pal[4 + i]) / 3);
      pal[12 + i] = Math.round((pal[i] + 2 * pal[4 + i]) / 3);
    }
  } else {
    for (let i = 0; i < 3; i++) pal[8 + i] = Math.round((pal[i] + pal[4 + i]) / 2);
    pal[12] = pal[13] = pal[14] = pal[15] = 0;
  }
  const bits = v.getUint32(p + 4, true);
  for (let i = 0; i < 16; i++) {
    const k = ((bits >>> (2 * i)) & 3) * 4;
    px[i * 4] = pal[k];
    px[i * 4 + 1] = pal[k + 1];
    px[i * 4 + 2] = pal[k + 2];
    px[i * 4 + 3] = pal[k + 3];
  }
}

export function decodeDds(buffer: ArrayBuffer): DecodedImage {
  const v = new DataView(buffer);
  if (buffer.byteLength < 128 || v.getUint32(0, true) !== DDSD_MAGIC) throw new Error("not a DDS file");
  const height = v.getUint32(12, true);
  const width = v.getUint32(16, true);
  const pfFlags = v.getUint32(80, true);
  const code = v.getUint32(84, true);
  const bitCount = v.getUint32(88, true);
  const masks = [v.getUint32(92, true), v.getUint32(96, true), v.getUint32(100, true), v.getUint32(104, true)];
  let offset = 128;
  if (pfFlags & DDPF_FOURCC && code === fourCC("DX10")) throw new Error("DX10 DDS files are not supported");
  const data = new Uint8ClampedArray(width * height * 4);

  if (pfFlags & DDPF_FOURCC) {
    if (code !== DXT1 && code !== DXT3 && code !== DXT5) throw new Error("unsupported DDS compression");
    const blockSize = code === DXT1 ? 8 : 16;
    const bw = Math.max(1, Math.ceil(width / 4)), bh = Math.max(1, Math.ceil(height / 4));
    if (offset + bw * bh * blockSize > buffer.byteLength) throw new Error("truncated DDS file");
    const px = new Uint8ClampedArray(64);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        const p = offset + (by * bw + bx) * blockSize;
        if (code === DXT1) colorBlock(v, p, px, true);
        else {
          colorBlock(v, p + 8, px, false);
          if (code === DXT3) {
            for (let i = 0; i < 16; i++) {
              const nibble = (v.getUint8(p + (i >> 1)) >> ((i & 1) * 4)) & 15;
              px[i * 4 + 3] = nibble * 17;
            }
          } else {
            const a0 = v.getUint8(p), a1 = v.getUint8(p + 1);
            const a = [a0, a1, 0, 0, 0, 0, 0, 0];
            if (a0 > a1) for (let i = 1; i < 7; i++) a[i + 1] = Math.round(((7 - i) * a0 + i * a1) / 7);
            else {
              for (let i = 1; i < 5; i++) a[i + 1] = Math.round(((5 - i) * a0 + i * a1) / 5);
              a[6] = 0;
              a[7] = 255;
            }
            // 48 bits of 3-bit indices, little endian.
            const lo = v.getUint32(p + 2, true), hi = v.getUint16(p + 6, true);
            for (let i = 0; i < 16; i++) {
              const idx = i < 10 ? (lo >>> (3 * i)) & 7 : i === 10 ? ((lo >>> 30) | ((hi & 1) << 2)) & 7 : (hi >>> (3 * (i - 11) + 1)) & 7;
              px[i * 4 + 3] = a[idx];
            }
          }
        }
        for (let y = 0; y < 4; y++) {
          const yy = by * 4 + y;
          if (yy >= height) break;
          for (let x = 0; x < 4; x++) {
            const xx = bx * 4 + x;
            if (xx >= width) continue;
            const s = (y * 4 + x) * 4, d = (yy * width + xx) * 4;
            data[d] = px[s];
            data[d + 1] = px[s + 1];
            data[d + 2] = px[s + 2];
            data[d + 3] = px[s + 3];
          }
        }
      }
    }
    return { width, height, data };
  }

  // Uncompressed: read channels through the bit masks.
  const bytes = bitCount / 8;
  if (bytes !== 4 && bytes !== 3) throw new Error(`unsupported DDS pixel size ${bitCount}`);
  if (offset + width * height * bytes > buffer.byteLength) throw new Error("truncated DDS file");
  const shift = (m: number) => (m ? 31 - Math.clz32(m & -m) : 0);
  const scale = (m: number) => (m ? 255 / (m >>> shift(m)) : 0);
  for (let i = 0; i < width * height; i++) {
    const p = offset + i * bytes;
    const word = bytes === 4 ? v.getUint32(p, true) : v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getUint8(p + 2) << 16);
    for (let c = 0; c < 4; c++) {
      const m = masks[c];
      data[i * 4 + c] = m ? Math.round(((word & m) >>> shift(m)) * scale(m)) : c === 3 ? 255 : 0;
    }
  }
  return { width, height, data };
}
