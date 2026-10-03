/**
 * Procedural placeholder illustrations (SVG strings). The same seed always yields the same
 * picture; different seeds differ in colours and composition.
 *
 * `pictureSvg` is a neutral stand-in. For a real project, draw something that fits the
 * subject (products, rooms, vehicles, dishes...) so screenshots read like the real app.
 */

function rng(seed) {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BACKDROPS = [
  ["#e9efe4", "#cfdcc6"],
  ["#f1e9dd", "#e2d2bb"],
  ["#e3ecef", "#c5d8de"],
  ["#efe4e1", "#e0c8c1"],
  ["#ecebe2", "#d6d4c0"],
  ["#e6e6ef", "#cdcde0"],
];
const ACCENTS = ["#c8744f", "#5f6f7a", "#d9a441", "#4c8a72", "#7a5ea8", "#3d3d3d", "#3f7db8"];

const pick = (r, list) => list[Math.floor(r() * list.length)];

function frame(r, body) {
  const [top, bottom] = pick(r, BACKDROPS);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800">
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs>
<rect width="800" height="800" fill="url(#bg)"/>
<rect y="640" width="800" height="160" fill="#000" opacity="0.06"/>
${body}</svg>`;
}

/** A still life of a few simple shapes standing on a surface. */
export function pictureSvg(seed) {
  const r = rng(seed + 1);
  let out = "";
  const n = 2 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const color = pick(r, ACCENTS);
    const cx = 160 + ((480 / Math.max(1, n - 1)) * i || 240) + (r() - 0.5) * 40;
    const size = 90 + r() * 110;
    out += `<ellipse cx="${cx}" cy="646" rx="${size * 0.7}" ry="14" fill="#000" opacity="0.12"/>`;
    const shape = Math.floor(r() * 3);
    if (shape === 0) out += `<circle cx="${cx}" cy="${640 - size}" r="${size}" fill="${color}"/>`;
    else if (shape === 1) out += `<rect x="${cx - size * 0.6}" y="${640 - size * 2}" width="${size * 1.2}" height="${size * 2}" rx="18" fill="${color}"/>`;
    else out += `<path d="M${cx - size} 640 L${cx} ${640 - size * 1.9} L${cx + size} 640 z" fill="${color}"/>`;
    out += `<rect x="${cx - size * 0.5}" y="${640 - size * 1.2}" width="${size}" height="12" fill="#fff" opacity="0.25"/>`;
  }
  return frame(r, out);
}

/** A flat avatar: tinted disc with an initial. */
export function avatarSvg(seed, initial = "?") {
  const r = rng(seed + 307);
  const [, tint] = pick(r, BACKDROPS);
  const fill = pick(r, ACCENTS);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
<rect width="400" height="400" fill="${tint}"/><circle cx="200" cy="160" r="78" fill="${fill}"/><path d="M50 400 a150 150 0 0 1 300 0 z" fill="${fill}"/>
<text x="200" y="188" font-family="Helvetica, Arial, sans-serif" font-size="92" font-weight="700" text-anchor="middle" fill="#fff">${initial}</text></svg>`;
}
