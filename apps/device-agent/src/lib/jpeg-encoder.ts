/**
 * Pure TypeScript Baseline JPEG Encoder & Image Downsampler.
 * Zero external dependencies, zero native C++ binaries.
 * Designed for ultra-low latency frame streaming from Android farm boards.
 */

const ZigZag = [
  0, 1, 5, 6, 14, 15, 27, 28,
  2, 4, 7, 13, 16, 26, 29, 42,
  3, 8, 12, 17, 25, 30, 41, 43,
  9, 11, 18, 24, 31, 40, 44, 53,
  10, 19, 23, 32, 39, 45, 52, 54,
  20, 22, 33, 38, 46, 51, 55, 60,
  21, 34, 37, 47, 50, 56, 59, 61,
  35, 36, 48, 49, 57, 58, 62, 63,
];

const std_dc_luminance_nrcodes = [0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const std_dc_luminance_values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

const std_dc_chrominance_nrcodes = [0, 0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const std_dc_chrominance_values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

const std_ac_luminance_nrcodes = [0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const std_ac_luminance_values = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12,
  0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
  0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16,
  0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
  0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
  0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79,
  0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98,
  0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
  0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4,
  0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea,
  0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

const std_ac_chrominance_nrcodes = [0, 0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const std_ac_chrominance_values = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21,
  0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
  0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34,
  0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38,
  0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
  0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
  0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78,
  0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96,
  0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
  0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2,
  0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9,
  0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

interface HuffmanTable {
  [key: number]: [number, number]; // [code, length]
}

function computeHuffmanTable(nrcodes: number[], values: number[]): HuffmanTable {
  let code = 0;
  let pos = 0;
  const table: HuffmanTable = {};
  for (let k = 1; k <= 16; k++) {
    for (let i = 1; i <= nrcodes[k]; i++) {
      table[values[pos]] = [code, k];
      pos++;
      code++;
    }
    code <<= 1;
  }
  return table;
}

const defaultYTable = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];

const defaultUVTable = [
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
];

// Precompute AAN FDCT scaling factors
const aasf = [
  1.0, 1.387039845, 1.306562965, 1.175875602,
  1.0, 0.785694958, 0.541196100, 0.275899379,
];

// Precompute category bit lengths
const categoryBits: number[][] = [];
for (let i = 0; i <= 2048; i++) {
  categoryBits[i] = [];
}
for (let i = -1023; i <= 1023; i++) {
  let val = i;
  let len = 0;
  if (val < 0) {
    val = -val;
    let temp = val;
    while (temp > 0) {
      len++;
      temp >>= 1;
    }
    categoryBits[i + 1024] = [len, (1 << len) - 1 - val];
  } else if (val > 0) {
    let temp = val;
    while (temp > 0) {
      len++;
      temp >>= 1;
    }
    categoryBits[i + 1024] = [len, val];
  } else {
    categoryBits[1024] = [0, 0];
  }
}

/**
 * 2x Box-filter downsampler for RGBA buffers.
 * Cuts data size by 4x and averages 4 adjacent pixels into 1.
 */
export function downsample2x(
  rgba: Buffer,
  width: number,
  height: number
): { data: Buffer; width: number; height: number } {
  const newWidth = Math.floor(width / 2);
  const newHeight = Math.floor(height / 2);
  const out = Buffer.alloc(newWidth * newHeight * 4);

  const rowStride = width * 4;
  for (let y = 0; y < newHeight; y++) {
    const srcRow0 = (y * 2) * rowStride;
    const srcRow1 = (y * 2 + 1) * rowStride;
    const dstRow = y * newWidth * 4;

    for (let x = 0; x < newWidth; x++) {
      const p0 = srcRow0 + x * 8;
      const p1 = p0 + 4;
      const p2 = srcRow1 + x * 8;
      const p3 = p2 + 4;

      const dstIdx = dstRow + x * 4;
      out[dstIdx] = (rgba[p0] + rgba[p1] + rgba[p2] + rgba[p3]) >> 2;
      out[dstIdx + 1] = (rgba[p0 + 1] + rgba[p1 + 1] + rgba[p2 + 1] + rgba[p3 + 1]) >> 2;
      out[dstIdx + 2] = (rgba[p0 + 2] + rgba[p1 + 2] + rgba[p2 + 2] + rgba[p3 + 2]) >> 2;
      out[dstIdx + 3] = 255;
    }
  }

  return { data: out, width: newWidth, height: newHeight };
}

/**
 * Encodes RGBA buffer to JPEG Buffer with given quality (1..100).
 * Default quality = 65 (sweet spot: sharp UI elements, ~40-60 KB size).
 */
export function encodeJpeg(
  rgba: Buffer,
  width: number,
  height: number,
  quality = 65
): Buffer {
  let q = Math.max(1, Math.min(100, quality));
  let sf = q < 50 ? Math.floor(5000 / q) : Math.floor(200 - q * 2);

  const YTable = new Int32Array(64);
  const UVTable = new Int32Array(64);
  const fdtbl_Y = new Float32Array(64);
  const fdtbl_UV = new Float32Array(64);

  for (let i = 0; i < 64; i++) {
    let yVal = Math.floor((defaultYTable[ZigZag[i]] * sf + 50) / 100);
    YTable[ZigZag[i]] = Math.max(1, Math.min(255, yVal));

    let uvVal = Math.floor((defaultUVTable[ZigZag[i]] * sf + 50) / 100);
    UVTable[ZigZag[i]] = Math.max(1, Math.min(255, uvVal));
  }

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const idx = row * 8 + col;
      fdtbl_Y[idx] = 1.0 / (YTable[ZigZag[idx]] * aasf[row] * aasf[col] * 8.0);
      fdtbl_UV[idx] = 1.0 / (UVTable[ZigZag[idx]] * aasf[row] * aasf[col] * 8.0);
    }
  }

  const DCHuffY = computeHuffmanTable(std_dc_luminance_nrcodes, std_dc_luminance_values);
  const ACHuffY = computeHuffmanTable(std_ac_luminance_nrcodes, std_ac_luminance_values);
  const DCHuffUV = computeHuffmanTable(std_dc_chrominance_nrcodes, std_dc_chrominance_values);
  const ACHuffUV = computeHuffmanTable(std_ac_chrominance_nrcodes, std_ac_chrominance_values);

  const outChunks: Buffer[] = [];
  let chunkBuf = Buffer.alloc(16384);
  let chunkPos = 0;

  function flushChunk() {
    if (chunkPos > 0) {
      outChunks.push(chunkBuf.subarray(0, chunkPos));
      chunkBuf = Buffer.alloc(16384);
      chunkPos = 0;
    }
  }

  function writeByte(b: number) {
    if (chunkPos >= chunkBuf.length) flushChunk();
    chunkBuf[chunkPos++] = b & 0xff;
  }

  function writeWord(w: number) {
    writeByte((w >> 8) & 0xff);
    writeByte(w & 0xff);
  }

  let byteBuffer = 0;
  let bitsLeft = 8;

  function writeBits(bits: [number, number]) {
    let value = bits[0];
    let count = bits[1];
    while (count > 0) {
      if (count >= bitsLeft) {
        count -= bitsLeft;
        byteBuffer |= (value >> count) & ((1 << bitsLeft) - 1);
        writeByte(byteBuffer);
        if (byteBuffer === 0xff) {
          writeByte(0);
        }
        byteBuffer = 0;
        bitsLeft = 8;
      } else {
        bitsLeft -= count;
        byteBuffer |= (value & ((1 << count) - 1)) << bitsLeft;
        count = 0;
      }
    }
  }

  // SOI
  writeWord(0xffd8);

  // APP0 (JFIF)
  writeWord(0xffe0);
  writeWord(16);
  writeByte(0x4a); writeByte(0x46); writeByte(0x49); writeByte(0x46); writeByte(0x00); // "JFIF\0"
  writeByte(1); writeByte(1); // Version 1.1
  writeByte(0); // units: 0 = none
  writeWord(1); writeWord(1); // density
  writeByte(0); writeByte(0); // thumbnail

  // DQT
  writeWord(0xffdb);
  writeWord(132);
  writeByte(0);
  for (let i = 0; i < 64; i++) writeByte(YTable[ZigZag[i]]);
  writeByte(1);
  for (let i = 0; i < 64; i++) writeByte(UVTable[ZigZag[i]]);

  // SOF0 (Baseline DCT)
  writeWord(0xffc0);
  writeWord(17);
  writeByte(8); // 8-bit precision
  writeWord(height);
  writeWord(width);
  writeByte(3); // 3 components (YCbCr)
  writeByte(1); writeByte(0x11); writeByte(0); // Y: 1x1 subsampling, DQT 0
  writeByte(2); writeByte(0x11); writeByte(1); // Cb: 1x1 subsampling, DQT 1
  writeByte(3); writeByte(0x11); writeByte(1); // Cr: 1x1 subsampling, DQT 1

  // DHT
  function writeDHT(marker: number, nrcodes: number[], values: number[]) {
    writeWord(0xffc4);
    let len = 3 + 16 + values.length;
    writeWord(len);
    writeByte(marker);
    for (let i = 1; i <= 16; i++) writeByte(nrcodes[i]);
    for (let i = 0; i < values.length; i++) writeByte(values[i]);
  }
  writeDHT(0x00, std_dc_luminance_nrcodes, std_dc_luminance_values);
  writeDHT(0x10, std_ac_luminance_nrcodes, std_ac_luminance_values);
  writeDHT(0x01, std_dc_chrominance_nrcodes, std_dc_chrominance_values);
  writeDHT(0x11, std_ac_chrominance_nrcodes, std_ac_chrominance_values);

  // SOS
  writeWord(0xffda);
  writeWord(12);
  writeByte(3);
  writeByte(1); writeByte(0x00);
  writeByte(2); writeByte(0x11);
  writeByte(3); writeByte(0x11);
  writeByte(0); writeByte(63); writeByte(0);

  // AAN Fast Forward DCT on 8x8 block
  const blockData = new Float32Array(64);
  function fDCTQuant(data: Float32Array, fdtbl: Float32Array, outZigZag: Int32Array) {
    let dataOff = 0;
    // Rows
    for (let i = 0; i < 8; i++) {
      const d0 = data[dataOff];
      const d1 = data[dataOff + 1];
      const d2 = data[dataOff + 2];
      const d3 = data[dataOff + 3];
      const d4 = data[dataOff + 4];
      const d5 = data[dataOff + 5];
      const d6 = data[dataOff + 6];
      const d7 = data[dataOff + 7];

      const tmp0 = d0 + d7;
      const tmp7 = d0 - d7;
      const tmp1 = d1 + d6;
      const tmp6 = d1 - d6;
      const tmp2 = d2 + d5;
      const tmp5 = d2 - d5;
      const tmp3 = d3 + d4;
      const tmp4 = d3 - d4;

      const tmp10 = tmp0 + tmp3;
      const tmp13 = tmp0 - tmp3;
      const tmp11 = tmp1 + tmp2;
      const tmp12 = tmp1 - tmp2;

      data[dataOff] = tmp10 + tmp11;
      data[dataOff + 4] = tmp10 - tmp11;

      const z1 = (tmp12 + tmp13) * 0.707106781;
      data[dataOff + 2] = tmp13 + z1;
      data[dataOff + 6] = tmp13 - z1;

      const tmp10_ = tmp4 + tmp5;
      const tmp11_ = tmp5 + tmp6;
      const tmp12_ = tmp6 + tmp7;

      const z5 = (tmp10_ - tmp12_) * 0.382683432;
      const z2 = 0.541196100 * tmp10_ + z5;
      const z4 = 1.306562965 * tmp12_ + z5;
      const z3 = tmp11_ * 0.707106781;

      const z11 = tmp7 + z3;
      const z13 = tmp7 - z3;

      data[dataOff + 5] = z13 + z2;
      data[dataOff + 3] = z13 - z2;
      data[dataOff + 1] = z11 + z4;
      data[dataOff + 7] = z11 - z4;

      dataOff += 8;
    }

    // Columns
    for (let i = 0; i < 8; i++) {
      const d0 = data[i];
      const d1 = data[i + 8];
      const d2 = data[i + 16];
      const d3 = data[i + 24];
      const d4 = data[i + 32];
      const d5 = data[i + 40];
      const d6 = data[i + 48];
      const d7 = data[i + 56];

      const tmp0 = d0 + d7;
      const tmp7 = d0 - d7;
      const tmp1 = d1 + d6;
      const tmp6 = d1 - d6;
      const tmp2 = d2 + d5;
      const tmp5 = d2 - d5;
      const tmp3 = d3 + d4;
      const tmp4 = d3 - d4;

      const tmp10 = tmp0 + tmp3;
      const tmp13 = tmp0 - tmp3;
      const tmp11 = tmp1 + tmp2;
      const tmp12 = tmp1 - tmp2;

      data[i] = tmp10 + tmp11;
      data[i + 32] = tmp10 - tmp11;

      const z1 = (tmp12 + tmp13) * 0.707106781;
      data[i + 16] = tmp13 + z1;
      data[i + 48] = tmp13 - z1;

      const tmp10_ = tmp4 + tmp5;
      const tmp11_ = tmp5 + tmp6;
      const tmp12_ = tmp6 + tmp7;

      const z5 = (tmp10_ - tmp12_) * 0.382683432;
      const z2 = 0.541196100 * tmp10_ + z5;
      const z4 = 1.306562965 * tmp12_ + z5;
      const z3 = tmp11_ * 0.707106781;

      const z11 = tmp7 + z3;
      const z13 = tmp7 - z3;

      data[i + 40] = z13 + z2;
      data[i + 24] = z13 - z2;
      data[i + 8] = z11 + z4;
      data[i + 56] = z11 - z4;
    }

    // Quantize and ZigZag
    for (let i = 0; i < 64; i++) {
      const qVal = data[i] * fdtbl[i];
      outZigZag[ZigZag[i]] = Math.round(qVal);
    }
  }

  const zzBlock = new Int32Array(64);

  function processDU(
    dataDU: Float32Array,
    fdtbl: Float32Array,
    dcDiff: number,
    dcTable: HuffmanTable,
    acTable: HuffmanTable
  ): number {
    fDCTQuant(dataDU, fdtbl, zzBlock);

    // DC encoding
    const diff = zzBlock[0] - dcDiff;
    const catIdx = diff + 1024;
    const cat = categoryBits[catIdx];
    writeBits(dcTable[cat[0]]);
    if (cat[0] > 0) {
      writeBits([cat[1], cat[0]]);
    }

    // AC encoding
    let r = 0;
    for (let k = 1; k < 64; k++) {
      const val = zzBlock[k];
      if (val === 0) {
        r++;
      } else {
        while (r > 15) {
          writeBits(acTable[0xf0]); // ZRL
          r -= 16;
        }
        const valCat = categoryBits[val + 1024];
        writeBits(acTable[(r << 4) | valCat[0]]);
        writeBits([valCat[1], valCat[0]]);
        r = 0;
      }
    }
    if (r > 0) {
      writeBits(acTable[0x00]); // EOB
    }

    return zzBlock[0]; // new prevDC
  }

  let prevDCY = 0;
  let prevDCU = 0;
  let prevDCV = 0;

  const yBlock = new Float32Array(64);
  const uBlock = new Float32Array(64);
  const vBlock = new Float32Array(64);

  const padWidth = (width + 7) & ~7;
  const padHeight = (height + 7) & ~7;

  for (let blockY = 0; blockY < padHeight; blockY += 8) {
    for (let blockX = 0; blockX < padWidth; blockX += 8) {
      // Extract 8x8 block
      for (let py = 0; py < 8; py++) {
        const curY = Math.min(height - 1, blockY + py);
        const rowOffset = curY * width * 4;
        for (let px = 0; px < 8; px++) {
          const curX = Math.min(width - 1, blockX + px);
          const p = rowOffset + curX * 4;

          const r = rgba[p];
          const g = rgba[p + 1];
          const b = rgba[p + 2];

          const bi = py * 8 + px;
          // RGB to YCbCr conversion (ITU-R BT.601) - 128 level shift
          yBlock[bi] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
          uBlock[bi] = -0.168736 * r - 0.331264 * g + 0.5 * b;
          vBlock[bi] = 0.5 * r - 0.418688 * g - 0.081312 * b;
        }
      }

      prevDCY = processDU(yBlock, fdtbl_Y, prevDCY, DCHuffY, ACHuffY);
      prevDCU = processDU(uBlock, fdtbl_UV, prevDCU, DCHuffUV, ACHuffUV);
      prevDCV = processDU(vBlock, fdtbl_UV, prevDCV, DCHuffUV, ACHuffUV);
    }
  }

  // Flush remaining bits
  if (bitsLeft < 8) {
    byteBuffer |= (1 << bitsLeft) - 1;
    writeByte(byteBuffer);
    if (byteBuffer === 0xff) {
      writeByte(0);
    }
  }

  // EOI
  writeWord(0xffd9);
  flushChunk();

  return Buffer.concat(outChunks);
}
