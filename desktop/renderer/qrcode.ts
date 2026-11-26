/** Pure TypeScript ISO/IEC 18004 Byte-mode QR generator (ECC Level L, Versions 1-16). */

interface QrVersionSpec {
  version: number;
  totalDataCodewords: number;
  ecPerBlock: number;
  g1Blocks: number;
  g1Data: number;
  g2Blocks: number;
  g2Data: number;
  remainderBits: number;
  alignments: number[];
}

const QR_SPECS: QrVersionSpec[] = [
  { version: 1, totalDataCodewords: 19, ecPerBlock: 7, g1Blocks: 1, g1Data: 19, g2Blocks: 0, g2Data: 0, remainderBits: 0, alignments: [] },
  { version: 2, totalDataCodewords: 34, ecPerBlock: 10, g1Blocks: 1, g1Data: 34, g2Blocks: 0, g2Data: 0, remainderBits: 7, alignments: [6, 18] },
  { version: 3, totalDataCodewords: 55, ecPerBlock: 15, g1Blocks: 1, g1Data: 55, g2Blocks: 0, g2Data: 0, remainderBits: 7, alignments: [6, 22] },
  { version: 4, totalDataCodewords: 80, ecPerBlock: 20, g1Blocks: 1, g1Data: 80, g2Blocks: 0, g2Data: 0, remainderBits: 7, alignments: [6, 26] },
  { version: 5, totalDataCodewords: 108, ecPerBlock: 26, g1Blocks: 1, g1Data: 108, g2Blocks: 0, g2Data: 0, remainderBits: 7, alignments: [6, 30] },
  { version: 6, totalDataCodewords: 136, ecPerBlock: 18, g1Blocks: 2, g1Data: 68, g2Blocks: 0, g2Data: 0, remainderBits: 7, alignments: [6, 34] },
  { version: 7, totalDataCodewords: 156, ecPerBlock: 20, g1Blocks: 2, g1Data: 78, g2Blocks: 0, g2Data: 0, remainderBits: 0, alignments: [6, 22, 38] },
  { version: 8, totalDataCodewords: 194, ecPerBlock: 24, g1Blocks: 2, g1Data: 97, g2Blocks: 0, g2Data: 0, remainderBits: 0, alignments: [6, 24, 42] },
  { version: 9, totalDataCodewords: 232, ecPerBlock: 30, g1Blocks: 2, g1Data: 116, g2Blocks: 0, g2Data: 0, remainderBits: 0, alignments: [6, 26, 46] },
  { version: 10, totalDataCodewords: 274, ecPerBlock: 18, g1Blocks: 2, g1Data: 68, g2Blocks: 2, g2Data: 69, remainderBits: 0, alignments: [6, 28, 50] },
  { version: 11, totalDataCodewords: 324, ecPerBlock: 20, g1Blocks: 4, g1Data: 81, g2Blocks: 0, g2Data: 0, remainderBits: 0, alignments: [6, 30, 54] },
  { version: 12, totalDataCodewords: 370, ecPerBlock: 24, g1Blocks: 2, g1Data: 92, g2Blocks: 2, g2Data: 93, remainderBits: 0, alignments: [6, 32, 58] },
  { version: 13, totalDataCodewords: 428, ecPerBlock: 26, g1Blocks: 4, g1Data: 107, g2Blocks: 0, g2Data: 0, remainderBits: 0, alignments: [6, 34, 62] },
  { version: 14, totalDataCodewords: 461, ecPerBlock: 30, g1Blocks: 3, g1Data: 115, g2Blocks: 1, g2Data: 116, remainderBits: 3, alignments: [6, 26, 46, 66] },
  { version: 15, totalDataCodewords: 523, ecPerBlock: 22, g1Blocks: 5, g1Data: 87, g2Blocks: 1, g2Data: 88, remainderBits: 3, alignments: [6, 26, 48, 70] },
  { version: 16, totalDataCodewords: 589, ecPerBlock: 24, g1Blocks: 5, g1Data: 98, g2Blocks: 1, g2Data: 99, remainderBits: 3, alignments: [6, 26, 50, 74] },
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let val = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = val;
    GF_LOG[val] = i;
    val <<= 1;
    if (val & 0x100) val ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function computeEcCodewords(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGenerator(ecCount);
  const res = new Uint8Array(data.length + ecCount);
  res.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = res[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      res[i + j] ^= gfMul(gen[j], factor);
    }
  }
  return res.subarray(data.length);
}

function selectSpec(byteLength: number): QrVersionSpec {
  for (const spec of QR_SPECS) {
    const countBits = spec.version <= 9 ? 8 : 16;
    const totalBits = 4 + countBits + byteLength * 8;
    if (Math.ceil(totalBits / 8) <= spec.totalDataCodewords) {
      return spec;
    }
  }
  throw new Error('二维码内容超出支持长度上限。');
}

function encodeDataBits(bytes: Uint8Array, spec: QrVersionSpec): number[] {
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  pushBits(0b0100, 4);
  pushBits(bytes.length, spec.version <= 9 ? 8 : 16);
  for (const b of bytes) pushBits(b, 8);

  const capacityBits = spec.totalDataCodewords * 8;
  const term = Math.min(4, capacityBits - bits.length);
  for (let i = 0; i < term; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  let padByte = 0xec;
  while (bits.length < capacityBits) {
    pushBits(padByte, 8);
    padByte = padByte === 0xec ? 0x11 : 0xec;
  }

  const codewords = new Uint8Array(spec.totalDataCodewords);
  for (let i = 0; i < codewords.length; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b];
    codewords[i] = v;
  }

  const blocks: Uint8Array[] = [];
  const ecs: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < spec.g1Blocks; i++) {
    const slice = codewords.subarray(offset, offset + spec.g1Data);
    blocks.push(slice);
    ecs.push(computeEcCodewords(slice, spec.ecPerBlock));
    offset += spec.g1Data;
  }
  for (let i = 0; i < spec.g2Blocks; i++) {
    const slice = codewords.subarray(offset, offset + spec.g2Data);
    blocks.push(slice);
    ecs.push(computeEcCodewords(slice, spec.ecPerBlock));
    offset += spec.g2Data;
  }

  const interleaved: number[] = [];
  const maxDataLen = Math.max(spec.g1Data, spec.g2Data);
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of blocks) {
      if (i < block.length) pushInterleavedBits(interleaved, block[i]);
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const ec of ecs) pushInterleavedBits(interleaved, ec[i]);
  }
  for (let i = 0; i < spec.remainderBits; i++) interleaved.push(0);
  return interleaved;
}

function pushInterleavedBits(out: number[], byte: number) {
  for (let i = 7; i >= 0; i--) out.push((byte >>> i) & 1);
}

function bchFormatBits(maskPattern: number): number {
  // Error correction L indicator is 0b01.
  const data = (0b01 << 3) | (maskPattern & 0b111);
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) rem ^= 0b10100110111 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0b101010000010010;
}

function bchVersionBits(version: number): number {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) {
    if ((rem >>> i) & 1) rem ^= 0b1111100100101 << (i - 12);
  }
  return (version << 12) | rem;
}

function maskCondition(pattern: number, row: number, col: number): boolean {
  switch (pattern) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

function penaltyScore(grid: boolean[][]): number {
  const n = grid.length;
  let score = 0;
  for (let r = 0; r < n; r++) {
    let runLen = 1;
    for (let c = 1; c < n; c++) {
      if (grid[r][c] === grid[r][c - 1]) {
        runLen++;
      } else {
        if (runLen >= 5) score += 3 + (runLen - 5);
        runLen = 1;
      }
    }
    if (runLen >= 5) score += 3 + (runLen - 5);
  }
  for (let c = 0; c < n; c++) {
    let runLen = 1;
    for (let r = 1; r < n; r++) {
      if (grid[r][c] === grid[r - 1][c]) {
        runLen++;
      } else {
        if (runLen >= 5) score += 3 + (runLen - 5);
        runLen = 1;
      }
    }
    if (runLen >= 5) score += 3 + (runLen - 5);
  }
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = grid[r][c];
      if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) score += 3;
    }
  }
  const hasFinderLike = (seq: boolean[]) => {
    for (let i = 0; i <= seq.length - 11; i++) {
      const a = seq[i] && !seq[i + 1] && seq[i + 2] && seq[i + 3] && seq[i + 4] && !seq[i + 5] && seq[i + 6] && !seq[i + 7] && !seq[i + 8] && !seq[i + 9] && !seq[i + 10];
      const b = !seq[i] && !seq[i + 1] && !seq[i + 2] && !seq[i + 3] && seq[i + 4] && !seq[i + 5] && seq[i + 6] && seq[i + 7] && seq[i + 8] && !seq[i + 9] && seq[i + 10];
      if (a || b) score += 40;
    }
  };
  for (let r = 0; r < n; r++) hasFinderLike(grid[r]);
  for (let c = 0; c < n; c++) hasFinderLike(grid.map(row => row[c]));

  let dark = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (grid[r][c]) dark++;
  const pct = (dark * 100) / (n * n);
  const k = Math.min(Math.floor(Math.abs(pct - 50) / 5), 10);
  return score + k * 10;
}

export function encodeQrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  const spec = selectSpec(bytes.length);
  const n = 17 + 4 * spec.version;
  const base = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const reserved = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));

  const setFixed = (r: number, c: number, val: boolean) => {
    if (r >= 0 && r < n && c >= 0 && c < n) {
      base[r][c] = val;
      reserved[r][c] = true;
    }
  };

  const placeFinder = (top: number, left: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const dark = inside && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        setFixed(top + dr, left + dc, dark);
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, n - 7);
  placeFinder(n - 7, 0);

  for (let i = 8; i < n - 8; i++) {
    setFixed(6, i, i % 2 === 0);
    setFixed(i, 6, i % 2 === 0);
  }
  setFixed(n - 8, 8, true);

  const overlapsFinder = (ar: number, ac: number) =>
    (ar - 2 <= 7 && ac - 2 <= 7)
    || (ar - 2 <= 7 && ac + 2 >= n - 8)
    || (ar + 2 >= n - 8 && ac - 2 <= 7);

  for (const ar of spec.alignments) {
    for (const ac of spec.alignments) {
      if (overlapsFinder(ar, ac)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
          setFixed(ar + dr, ac + dc, dark);
        }
      }
    }
  }

  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      reserved[8][i] = true;
      reserved[i][8] = true;
    }
  }
  for (let i = n - 8; i < n; i++) {
    reserved[8][i] = true;
    if (i !== n - 8) reserved[i][8] = true;
  }

  if (spec.version >= 7) {
    const vBits = bchVersionBits(spec.version);
    for (let i = 0; i < 18; i++) {
      const bit = ((vBits >>> i) & 1) === 1;
      const r = Math.floor(i / 3);
      const c = n - 11 + (i % 3);
      setFixed(r, c, bit);
      setFixed(c, r, bit);
    }
  }

  const bits = encodeDataBits(bytes, spec);
  let bitIdx = 0;
  let upward = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < n; step++) {
      const row = upward ? n - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (!reserved[row][col]) {
          base[row][col] = bitIdx < bits.length ? bits[bitIdx] === 1 : false;
          bitIdx++;
        }
      }
    }
    upward = !upward;
  }

  let bestMask = 0;
  let bestScore = Infinity;
  let bestGrid: boolean[][] = base;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = base.map((row, r) => row.map((val, c) => (reserved[r][c] ? val : val !== maskCondition(mask, r, c))));
    const fmt = bchFormatBits(mask);
    const getBit = (bitIdx: number) => ((fmt >>> bitIdx) & 1) === 1;
    // ISO/IEC 18004 Figure 25: MSB (bit 14) at (8,0) / (n-1,8), LSB (bit 0) at (0,8) / (8,n-1).
    for (let c = 0; c <= 5; c++) candidate[8][c] = getBit(14 - c);
    candidate[8][7] = getBit(8);
    candidate[8][8] = getBit(7);
    candidate[7][8] = getBit(6);
    for (let r = 5; r >= 0; r--) candidate[r][8] = getBit(r);

    // Bottom-left vertical (7 bits only, preserving mandatory dark module at (n - 8, 8))
    for (let i = 0; i < 7; i++) candidate[n - 1 - i][8] = getBit(14 - i);
    // Top-right horizontal (8 bits)
    for (let i = 0; i < 8; i++) candidate[8][n - 8 + i] = getBit(7 - i);
    const score = penaltyScore(candidate);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
      bestGrid = candidate;
    }
  }
  void bestMask;
  return bestGrid;
}
