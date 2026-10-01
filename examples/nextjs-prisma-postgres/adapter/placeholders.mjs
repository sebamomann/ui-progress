/**
 * Procedural placeholder illustrations (SVG strings), one per subject kind. The same seed
 * always yields the same picture; different seeds differ in species, colours and pot.
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
const POTS = ["#c8744f", "#e8e2d6", "#5f6f7a", "#d9a441", "#8a9a7b", "#3d3d3d", "#b9c7d4"];
const GREENS = [
  ["#3f7d4e", "#2f5f3b"],
  ["#5a9a5f", "#3d7545"],
  ["#2f6b55", "#214c3d"],
  ["#7aa85a", "#557a3c"],
  ["#4c8a72", "#346352"],
];

const pick = (r, list) => list[Math.floor(r() * list.length)];

function frame(r, body) {
  const [top, bottom] = pick(r, BACKDROPS);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800">
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs>
<rect width="800" height="800" fill="url(#bg)"/>
<rect y="640" width="800" height="160" fill="#000" opacity="0.06"/>
${body}</svg>`;
}

function pot(r, cx = 400, top = 520, w = 220, h = 170) {
  const color = pick(r, POTS);
  const style = Math.floor(r() * 3);
  const shadow = `<ellipse cx="${cx}" cy="${top + h + 6}" rx="${w * 0.62}" ry="16" fill="#000" opacity="0.12"/>`;
  if (style === 0) {
    return `${shadow}<path d="M${cx - w / 2} ${top} h${w} l-${w * 0.14} ${h} h-${w * 0.72} z" fill="${color}"/>
<rect x="${cx - w / 2 - 10}" y="${top - 26}" width="${w + 20}" height="34" rx="6" fill="${color}"/>
<rect x="${cx - w / 2 - 10}" y="${top - 26}" width="${w + 20}" height="34" rx="6" fill="#000" opacity="0.08"/>`;
  }
  if (style === 1) {
    return `${shadow}<path d="M${cx - w / 2} ${top - 10} h${w} c0 ${h * 0.9} -${w * 0.2} ${h + 10} -${w / 2} ${h + 10} s-${w / 2} -${h * 0.1 + 10} -${w / 2} -${h + 10} z" fill="${color}"/>
<path d="M${cx - w / 2} ${top - 10} h${w} v18 h-${w} z" fill="#000" opacity="0.1"/>`;
  }
  return `${shadow}<rect x="${cx - w / 2}" y="${top - 10}" width="${w}" height="${h + 10}" rx="14" fill="${color}"/>
<rect x="${cx - w / 2}" y="${top + h * 0.45}" width="${w}" height="14" fill="#fff" opacity="0.25"/>`;
}

function leaf(x, y, len, width, angle, fill) {
  return `<path transform="translate(${x} ${y}) rotate(${angle})" d="M0 0 C ${width} ${-len * 0.3}, ${width} ${-len * 0.8}, 0 ${-len} C ${-width} ${-len * 0.8}, ${-width} ${-len * 0.3}, 0 0 z" fill="${fill}"/>`;
}

const SPECIES = [
  // Broad leaves on arching stems.
  (r, [light, dark]) => {
    let out = "";
    const n = 5 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      const angle = -70 + (140 / (n - 1)) * i + (r() - 0.5) * 12;
      const reach = 170 + r() * 110;
      const rad = (angle * Math.PI) / 180;
      const x = 400 + Math.sin(rad) * reach;
      const y = 500 - Math.cos(rad) * reach;
      out += `<path d="M400 500 Q ${400 + Math.sin(rad) * reach * 0.3} ${500 - Math.cos(rad) * reach * 0.8} ${x} ${y}" stroke="${dark}" stroke-width="7" fill="none"/>`;
      out += leaf(x, y + 10, 150 + r() * 50, 62 + r() * 22, angle * 0.8, i % 2 ? light : dark);
    }
    return out;
  },
  // Upright blades.
  (r, [light, dark]) => {
    let out = "";
    const n = 6 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) {
      const angle = -24 + (48 / (n - 1)) * i + (r() - 0.5) * 6;
      const len = 250 + r() * 170;
      out += leaf(330 + (140 / (n - 1)) * i, 512, len, 26 + r() * 10, angle, i % 2 ? light : dark);
      out += leaf(330 + (140 / (n - 1)) * i, 512, len * 0.96, 8, angle, "#e9e3a8");
      out += leaf(330 + (140 / (n - 1)) * i, 512, len * 0.9, 20 + r() * 6, angle, i % 2 ? light : dark);
    }
    return out;
  },
  // Round leaves on thin stalks.
  (r, [light, dark]) => {
    let out = "";
    const n = 9 + Math.floor(r() * 5);
    for (let i = 0; i < n; i++) {
      const angle = -80 + (160 / (n - 1)) * i + (r() - 0.5) * 14;
      const reach = 120 + r() * 200;
      const rad = (angle * Math.PI) / 180;
      const x = 400 + Math.sin(rad) * reach;
      const y = 505 - Math.cos(rad) * reach;
      const size = 34 + r() * 26;
      out += `<path d="M400 505 L ${x} ${y}" stroke="${dark}" stroke-width="4"/>`;
      out += `<circle cx="${x}" cy="${y}" r="${size}" fill="${i % 2 ? light : dark}"/><circle cx="${x}" cy="${y}" r="4" fill="#fff" opacity="0.5"/>`;
    }
    return out;
  },
  // Trailing vines.
  (r, [light, dark]) => {
    let out = "";
    for (let v = 0; v < 6; v++) {
      const dir = v % 2 ? 1 : -1;
      const spread = 60 + r() * 130;
      const drop = 90 + r() * 210;
      const x1 = 400 + dir * spread;
      out += `<path d="M400 500 C ${400 + dir * spread * 0.4} ${380 - r() * 60}, ${x1} ${440}, ${x1 + dir * 20} ${500 + drop}" stroke="${dark}" stroke-width="5" fill="none"/>`;
      for (let k = 0; k < 5; k++) {
        const t = k / 4;
        out += leaf(x1 + dir * 20 * t, 470 + (drop + 20) * t, 54, 26, dir * (100 + r() * 40), k % 2 ? light : dark);
      }
    }
    for (let i = 0; i < 5; i++) out += leaf(340 + i * 30, 500, 80 + r() * 50, 30, -30 + i * 15, i % 2 ? light : dark);
    return out;
  },
  // Columnar cactus.
  (r, [light, dark]) => {
    const h = 250 + r() * 120;
    let out = `<rect x="350" y="${510 - h}" width="100" height="${h}" rx="50" fill="${light}"/>`;
    out += `<rect x="388" y="${520 - h}" width="10" height="${h - 20}" rx="5" fill="${dark}" opacity="0.5"/><rect x="418" y="${520 - h}" width="8" height="${h - 20}" rx="4" fill="${dark}" opacity="0.5"/>`;
    const armY = 510 - h * (0.4 + r() * 0.2);
    out += `<path d="M350 ${armY + 60} h-50 a34 34 0 0 1 -34 -34 v-${60 + r() * 50}" stroke="${light}" stroke-width="56" stroke-linecap="round" fill="none"/>`;
    if (r() > 0.4) out += `<path d="M450 ${armY + 110} h44 a30 30 0 0 0 30 -30 v-${50 + r() * 50}" stroke="${dark}" stroke-width="50" stroke-linecap="round" fill="none"/>`;
    if (r() > 0.5) out += `<circle cx="400" cy="${505 - h}" r="18" fill="#e58aa0"/>`;
    return out;
  },
];

/** A potted plant. `species` selects the plant shape so one type looks alike across photos. */
export function plantSvg(seed, species = seed) {
  const r = rng(seed + 1);
  const greens = GREENS[Math.abs(species) % GREENS.length];
  return frame(r, SPECIES[Math.abs(species) % SPECIES.length](r, greens) + pot(r));
}

/** An empty pot. */
export function potSvg(seed) {
  const r = rng(seed + 101);
  const w = 240 + r() * 120;
  const h = 200 + r() * 90;
  const top = 640 - h;
  return frame(r, pot(r, 400, top, w, h) + `<ellipse cx="400" cy="${top - 8}" rx="${w * 0.42}" ry="12" fill="#3b2a20" opacity="0.55"/>`);
}

/** A spot in the home: window, sill and a couple of small plants. */
export function locationSvg(seed) {
  const r = rng(seed + 211);
  const greens = pick(r, GREENS);
  const sky = pick(r, ["#cfe6f2", "#f4e3c4", "#dfe9d6", "#e6ddf0"]);
  const wide = r() > 0.5;
  const x = wide ? 130 : 220;
  const w = wide ? 540 : 360;
  let out = `<rect x="${x}" y="110" width="${w}" height="400" rx="10" fill="#fff"/><rect x="${x + 18}" y="128" width="${w - 36}" height="364" fill="${sky}"/>`;
  out += `<rect x="${x + w / 2 - 6}" y="128" width="12" height="364" fill="#fff"/><rect x="${x + 18}" y="300" width="${w - 36}" height="10" fill="#fff"/>`;
  out += `<circle cx="${x + w * 0.72}" cy="200" r="34" fill="#fff" opacity="0.7"/>`;
  out += `<rect x="${x - 40}" y="510" width="${w + 80}" height="26" rx="6" fill="#b08968"/>`;
  const count = 2 + Math.floor(r() * 2);
  for (let i = 0; i < count; i++) {
    const cx = x + 70 + ((w - 140) / Math.max(1, count - 1)) * i;
    for (let k = 0; k < 5; k++) out += leaf(cx, 452, 70 + r() * 60, 18 + r() * 10, -40 + k * 20, k % 2 ? greens[0] : greens[1]);
    out += `<path d="M${cx - 34} 450 h68 l-8 60 h-52 z" fill="${pick(r, POTS)}"/>`;
  }
  return frame(r, out);
}

/** A flat avatar: tinted disc with an initial. */
export function avatarSvg(seed, initial = "?") {
  const r = rng(seed + 307);
  const [, tint] = pick(r, BACKDROPS);
  const [fill] = pick(r, GREENS);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
<rect width="400" height="400" fill="${tint}"/><circle cx="200" cy="160" r="78" fill="${fill}"/><path d="M50 400 a150 150 0 0 1 300 0 z" fill="${fill}"/>
<text x="200" y="188" font-family="Helvetica, Arial, sans-serif" font-size="92" font-weight="700" text-anchor="middle" fill="#fff">${initial}</text></svg>`;
}
