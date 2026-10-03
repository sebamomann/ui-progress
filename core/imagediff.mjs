/**
 * How different two screenshots look. Both are scaled to the same width and cut into small
 * blocks; a block counts when its pixels differ clearly, so anti-aliasing and other render
 * noise count as no change. Byte-identical files are 0.
 */
import crypto from "node:crypto";
import fs from "node:fs";

/** compare(a, b) and difference(a, b) for screenshot files, with decoded samples cached; identical(a, b). */
export function imageComparer(sharp) {
  // A changed date or counter touches a block or two; a new layout touches most of them.
  const WIDTH = 96, BLOCK = 8, MAX_ROWS = 1600;
  const sampleCache = new Map();
  const digest = (file) => crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
  async function sample(file) {
    if (!sampleCache.has(file)) {
      const { data, info } = await sharp(file).resize({ width: WIDTH }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      sampleCache.set(file, { data, height: Math.min(info.height, MAX_ROWS), hash: digest(file) });
    }
    return sampleCache.get(file);
  }
  /** Returns the share of changed blocks and the mask of which blocks changed (row-major, run-length encoded). */
  async function compare(fileA, fileB) {
    if (fileA === fileB) return { diff: 0, mask: null }; // the same stored screenshot
    const [a, b] = await Promise.all([sample(fileA), sample(fileB)]);
    const cols = WIDTH / BLOCK;
    if (a.hash === b.hash) return { diff: 0, mask: null };
    const rows = Math.ceil(Math.max(a.height, b.height) / BLOCK);
    const shared = Math.min(a.height, b.height);
    let changed = 0;
    const bits = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        // Blocks below the shorter page exist in one screenshot only.
        let hit = false;
        if (row * BLOCK >= shared) hit = true;
        else {
          let sum = 0, count = 0;
          for (let y = row * BLOCK; y < Math.min((row + 1) * BLOCK, shared); y++) {
            for (let x = col * BLOCK; x < (col + 1) * BLOCK; x++) {
              const i = (y * WIDTH + x) * 3;
              sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
              count += 3;
            }
          }
          hit = sum / count > 10;
        }
        if (hit) changed++;
        bits.push(hit ? 1 : 0);
      }
    }
    // Run-length encode: alternating counts of unchanged and changed blocks.
    const runs = [];
    let current = 0, run = 0;
    for (const bit of bits) { if (bit === current) run++; else { runs.push(run); current = bit; run = 1; } }
    runs.push(run);
    return { diff: changed / (rows * cols), mask: { cols, rows, runs } };
  }
  const difference = async (fileA, fileB) => (await compare(fileA, fileB)).diff;
  /**
   * Whether two screenshots show the same thing, strictly: the same size, and at full
   * resolution no more than `NOISE_PIXELS` pixels differ clearly (a channel by more than
   * `NOISE_LEVEL`). Anti-aliasing flips a few edge pixels; a changed word changes hundreds.
   */
  async function identical(fileA, fileB) {
    if (fileA === fileB) return true;
    const bytesA = fs.readFileSync(fileA), bytesB = fs.readFileSync(fileB);
    if (bytesA.equals(bytesB)) return true;
    const [a, b] = await Promise.all([bytesA, bytesB].map((bytes) => sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true })));
    if (a.info.width !== b.info.width || a.info.height !== b.info.height) return false;
    let off = 0;
    for (let i = 0; i < a.data.length; i += 3) {
      if (Math.abs(a.data[i] - b.data[i]) > NOISE_LEVEL || Math.abs(a.data[i + 1] - b.data[i + 1]) > NOISE_LEVEL || Math.abs(a.data[i + 2] - b.data[i + 2]) > NOISE_LEVEL) {
        if (++off > NOISE_PIXELS) return false;
      }
    }
    return true;
  }
  return { compare, difference, identical };
}

const NOISE_LEVEL = 32, NOISE_PIXELS = 10;
