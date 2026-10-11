import type { Accessory } from '../shared/protocol';

// ---------- color helpers ----------
type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const css = ([r, g, b]: RGB) => `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;

/** amt > 0 lightens, amt < 0 darkens (-1..1). */
export function shade(hex: string, amt: number): string {
  const f = (c: number) => (amt >= 0 ? c + (255 - c) * amt : c * (1 + amt));
  const [r, g, b] = hexToRgb(hex);
  return css([f(r), f(g), f(b)]);
}
export function mix(a: string, b: string, t: number): string {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return css([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
}

/** Deterministic 0..1 hash — for textures and variations. */
export function hash(x: number, y: number, s = 0): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  return { c, ctx, put: (x: number, y: number, col: string) => ((ctx.fillStyle = col), ctx.fillRect(x, y, 1, 1)) };
}

function drawMap(put: (x: number, y: number, c: string) => void, rows: string[], oy: number, pal: Record<string, string>) {
  rows.forEach((row, y) => [...row].forEach((ch, x) => ch !== '.' && pal[ch] && put(x, oy + y, pal[ch])));
}

// ---------- crab ----------
export const CRAB_W = 13;
export const CRAB_H = 12;
const HEAD = 4; // headroom for accessories

const BODY = [
  '..LLLLLLLLL..',
  '..BBBBBBBBB..',
  '..BBBBBBBBB..',
  'BBBKBBBBBKBBB',
  'BBBBBBBBBBBBB',
  '..DDDDDDDDD..',
];
const LEGS = {
  stand: ['...D.D.D.D...', '...D.D.D.D...'],
  walkA: ['...D.D.D.D...', '...D...D.....'],
  walkB: ['...D.D.D.D...', '.....D...D...'],
};
const ACCESSORIES: Record<Exclude<Accessory, 'none'>, string[]> = {
  sprout: ['....GG.GG....', '......g......', '......g......'],
  tophat: ['....KKKKK....', '....KKKKK....', '....KRRRK....', '...KKKKKKK...'],
  bow: ['.......PP.PP.', '.......PPpPP.'],
  antenna: ['..Y.......Y..', '...K.....K...', '....K...K....'],
  flower: ['.........W...', '........WYW..', '.........g...'],
};
const ACC_PAL: Record<string, string> = {
  G: '#7ccf55', g: '#3f8a2e', K: '#2a2433', R: '#d64545',
  P: '#ff8fc2', p: '#d9578f', Y: '#ffd84d', W: '#ffffff',
};

export interface CrabPose {
  legs: keyof typeof LEGS;
  eyes: 'open' | 'closed' | 'happy' | 'sad' | 'angry';
  look: -1 | 0 | 1;
  squash: 0 | 1;
}

const crabCache = new Map<string, HTMLCanvasElement>();

export function crabSprite(color: string, accessory: Accessory, pose: CrabPose): HTMLCanvasElement {
  const key = `${color}|${accessory}|${pose.legs}|${pose.eyes}|${pose.look}|${pose.squash}`;
  const cached = crabCache.get(key);
  if (cached) return cached;

  const { c, put } = canvas(CRAB_W, CRAB_H);
  const eye = '#1d1a22';
  const pal = { B: color, L: shade(color, 0.22), D: shade(color, -0.28), K: mix(color, '#ff6f91', 0.4) };

  drawMap(put, LEGS[pose.legs], HEAD + 6, pal);
  const by = HEAD + pose.squash;
  drawMap(put, BODY, by, pal);

  const ex1 = 4 + pose.look;
  const ex2 = 8 + pose.look;
  switch (pose.eyes) {
    case 'open':
      for (const ex of [ex1, ex2]) {
        put(ex, by + 1, eye);
        put(ex, by + 2, eye);
      }
      break;
    case 'closed':
      [ex1 - 1, ex1, ex2, ex2 + 1].forEach((x) => put(x, by + 2, eye));
      break;
    case 'happy': // ^ ^
      for (const ex of [ex1, ex2]) {
        put(ex, by + 1, eye);
        put(ex - 1, by + 2, eye);
        put(ex + 1, by + 2, eye);
      }
      break;
    case 'sad': // low eyes + drooping outer brows
      for (const ex of [ex1, ex2]) put(ex, by + 2, eye);
      put(ex1 - 1, by + 1, pal.D);
      put(ex2 + 1, by + 1, pal.D);
      break;
    case 'angry': // inward-slanted brows
      for (const ex of [ex1, ex2]) put(ex, by + 2, eye);
      put(ex1 + 1, by + 1, eye);
      put(ex2 - 1, by + 1, eye);
      break;
  }

  if (accessory !== 'none') {
    const rows = ACCESSORIES[accessory];
    drawMap(put, rows, by - rows.length, ACC_PAL);
  }

  crabCache.set(key, c);
  return c;
}

// ---------- environment objects ----------
const TREE_PALETTES = [
  ['#2f7a3a', '#3f9a45', '#6cc05a'],
  ['#2b6b4a', '#3a8c5e', '#62bb80'],
  ['#4b7d2b', '#609e37', '#91c958'],
];

const objectCache = new Map<string, HTMLCanvasElement>();
function cached(key: string, build: () => HTMLCanvasElement) {
  let c = objectCache.get(key);
  if (!c) objectCache.set(key, (c = build()));
  return c;
}

export const TREE_W = 16;
export const TREE_H = 24;
export function treeSprite(variant: number) {
  return cached(`tree${variant}`, () => {
    const { c, put } = canvas(TREE_W, TREE_H);
    const [dark, mid, light] = TREE_PALETTES[variant % 3];
    for (let y = 16; y < 24; y++) {
      put(6, y, '#7a5233');
      put(7, y, '#8c6040');
      put(8, y, '#7a5233');
      put(9, y, '#5e3d24');
    }
    put(5, 23, '#5e3d24');
    put(10, 23, '#5e3d24');
    const cx = 7.5;
    const cy = 8.5;
    for (let y = 0; y < 18; y++) {
      for (let x = 0; x < 16; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const r = 7.6 - hash(x, y, variant) * 0.9;
        if (dx * dx + dy * dy > r * r) continue;
        let col = mid;
        if (dx + dy > 3.5) col = dark;
        else if (dx + dy < -4.5 && dx * dx + dy * dy < (r - 1.5) ** 2) col = light;
        if (hash(x, y, variant + 9) < 0.07) col = dark;
        put(x, y, col);
      }
    }
    return c;
  });
}

export const ROCK_W = 12;
export const ROCK_H = 9;
export function rockSprite(variant: number) {
  return cached(`rock${variant}`, () => {
    const { c, put } = canvas(ROCK_W, ROCK_H);
    const rx = 5.4 - variant * 0.4;
    const ry = 3.6 + (variant % 2) * 0.4;
    for (let y = 0; y < ROCK_H; y++) {
      for (let x = 0; x < ROCK_W; x++) {
        const dx = (x - 5.5) / rx;
        const dy = (y - 5) / ry;
        if (dx * dx + dy * dy > 1) continue;
        let col = '#8d929c';
        if (dy > 0.45 || dx > 0.6) col = '#666a74';
        else if (dx + dy < -0.7) col = '#b9bec8';
        put(x, y, col);
      }
    }
    return c;
  });
}

export const BUSH_W = 14;
export const BUSH_H = 11;
export function bushSprite(variant: number, berries = true) {
  return cached(`bush${variant}${berries}`, () => {
    const { c, put } = canvas(BUSH_W, BUSH_H);
    const blobs = [
      [4.5, 6.5, 4],
      [9.5, 6.5, 4],
      [7, 4.5, 4.2],
    ];
    for (let y = 0; y < BUSH_H; y++) {
      for (let x = 0; x < BUSH_W; x++) {
        const inside = blobs.some(([bx, by, r]) => (x - bx) ** 2 + (y - by) ** 2 <= r * r);
        if (!inside) continue;
        let col = '#4f9e3f';
        if (y > 7) col = '#3a7d30';
        else if (y < 3 || hash(x, y, 3) < 0.08) col = '#76c35a';
        if (berries && hash(x, y, variant + 20) < 0.07 && y > 2 && y < 9) col = variant === 2 ? '#7d6be0' : '#e0444f';
        put(x, y, col);
      }
    }
    return c;
  });
}

/** A tree with no wood left: a stump with a tiny new sprout. Same size as the tree sprite. */
export function stumpSprite(variant: number) {
  return cached(`stump${variant}`, () => {
    const { c, put } = canvas(TREE_W, TREE_H);
    for (let y = 19; y < 24; y++) {
      for (let x = 5; x < 11; x++) put(x, y, x === 10 ? '#5e3d24' : x === 5 ? '#6b4a2e' : '#7a5233');
    }
    for (let x = 5; x < 11; x++) put(x, 19, '#c9a273');
    put(7, 19, '#a8825a');
    put(8, 19, '#a8825a');
    put(4, 23, '#5e3d24');
    put(11, 23, '#5e3d24');
    put(9, 18, '#7ccf55');
    put(10, 17, '#7ccf55');
    put(9, 17, '#3f8a2e');
    return c;
  });
}

// ---------- inventions: structures and item icons ----------
export const STRUCT_W = 18;
export const STRUCT_H = 22;

/** Structure sprite: procedural by shape; `color` is the accent (roof, flag…). */
export function structureSprite(shape: string, color: string) {
  return cached(`struct${shape}${color}`, () => {
    const { c, ctx, put } = canvas(STRUCT_W, STRUCT_H);
    const rect = (x: number, y: number, w: number, h: number, col: string) => ((ctx.fillStyle = col), ctx.fillRect(x, y, w, h));
    const accent = color;
    const accentDark = shade(color, -0.3);
    const accentLight = shade(color, 0.25);
    switch (shape) {
      case 'flag': {
        rect(8, 4, 1, 17, '#5e3d24');
        rect(9, 4, 7, 5, accent);
        rect(9, 8, 6, 1, accentDark);
        rect(10, 5, 2, 1, accentLight);
        rect(6, 20, 5, 1, '#5e3d24');
        break;
      }
      case 'market': {
        // Stall: striped awning, wooden counter, berry baskets
        for (let x = 0; x < 18; x++) rect(x, 7, 1, 4, Math.floor(x / 3) % 2 ? '#ffffff' : accent);
        rect(0, 11, 18, 1, accentDark);
        rect(1, 12, 1, 9, '#7a5233');
        rect(16, 12, 1, 9, '#7a5233');
        rect(1, 16, 16, 3, '#a8794d');
        rect(1, 16, 16, 1, '#c9a273');
        for (const [bx, col] of [[3, '#5a3d8a'], [7, '#8a5a2b'], [11, '#9a9ea8']] as const) {
          rect(bx, 14, 3, 2, col);
          put(bx + 1, 13, col);
        }
        break;
      }
      case 'grave': {
        rect(6, 9, 6, 12, '#9a9ea8');
        rect(7, 8, 4, 1, '#9a9ea8');
        rect(11, 9, 1, 12, '#7d818b');
        rect(7, 11, 4, 1, '#6a6e78');
        rect(8, 10, 1, 4, '#6a6e78');
        rect(4, 20, 10, 2, '#5e7a3c');
        put(4, 19, accentLight);
        put(13, 19, accent);
        break;
      }
      case 'house': {
        rect(3, 11, 12, 10, '#efe2c4');
        rect(3, 20, 12, 1, '#c9b48a');
        rect(14, 11, 1, 10, '#d6c49c');
        for (let i = 0; i < 7; i++) rect(1 + i, 10 - i, 16 - i * 2, 1, i % 2 ? accent : accentDark);
        rect(2, 10, 14, 1, accentDark);
        rect(7, 15, 4, 6, '#7a5233');
        put(10, 18, '#e8c35a');
        rect(4, 13, 2, 2, '#8fc7e8');
        rect(12, 13, 2, 2, '#8fc7e8');
        break;
      }
      case 'tower': {
        rect(5, 6, 8, 15, '#9a9ea8');
        for (let y = 7; y < 21; y += 3) rect(5, y, 8, 1, '#7d818b');
        rect(12, 6, 1, 15, '#7d818b');
        rect(4, 4, 10, 2, '#b4b8c2');
        for (let x = 4; x < 14; x += 3) rect(x, 3, 2, 1, '#b4b8c2');
        rect(8, 9, 2, 3, '#2a2433');
        rect(8, 0, 1, 4, '#5e3d24');
        rect(9, 0, 4, 2, accent);
        rect(7, 17, 4, 4, '#5e3d24');
        break;
      }
      case 'wall': {
        rect(1, 12, 16, 9, '#9a9ea8');
        for (let y = 12; y < 21; y += 3) {
          rect(1, y, 16, 1, '#7d818b');
          for (let x = (y / 3) % 2 ? 1 : 4; x < 17; x += 6) rect(x, y, 1, 3, '#7d818b');
        }
        for (let x = 1; x < 17; x += 4) rect(x, 10, 2, 2, accent);
        break;
      }
      default: {
        // hut: a little thatched hut
        rect(4, 13, 10, 8, '#a8794d');
        for (let x = 4; x < 14; x += 2) rect(x, 13, 1, 8, '#8c6040');
        for (let i = 0; i < 7; i++) rect(2 + i, 13 - i, 14 - i * 2, 1, i % 2 ? accentLight : accent);
        rect(1, 13, 16, 1, accentDark);
        rect(7, 16, 4, 5, '#3d2a1a');
        break;
      }
    }
    return c;
  });
}

const ICON_MAPS: Record<string, string[]> = {
  axe: ['......CC..', '.....CCCC.', '....BCCC..', '...B.CC...', '..B.......', '.B........', 'B.........', '..........', '..........', '..........'],
  hammer: ['...CCCC...', '...CCCC...', '....BB....', '....BB....', '....BB....', '....BB....', '....BB....', '....BB....', '..........', '..........'],
  pickaxe: ['..CCCCCC..', '.C..BB..C.', '....BB....', '....BB....', '....BB....', '....BB....', '....BB....', '..........', '..........', '..........'],
  sword: ['........W.', '.......CW.', '......CC..', '.....CC...', '....CC....', '.D.CC.....', '..DD......', '.BBD......', 'B.........', '..........'],
  spear: ['........CC', '.......CC.', '......B...', '.....B....', '....B.....', '...B......', '..B.......', '.B........', 'B.........', '..........'],
  bow: ['...CC.....', '..C..W....', '.C....W...', '.C....W...', '.C....W...', '.C....W...', '..C..W....', '...CC.....', '..........', '..........'],
  shield: ['.DDDDDD...', 'DCCCCCCD..', 'DCCWWCCD..', 'DCCWWCCD..', 'DCCCCCCD..', '.DCCCCD...', '..DCCD....', '...DD.....', '..........', '..........'],
  helmet: ['..CCCCC...', '.CCWCCCC..', 'CCCCCCCCC.', 'CDDDDDDDC.', 'C.......C.', '..........', '..........', '..........', '..........', '..........'],
  armor: ['.CC..CC...', 'CCCCCCCC..', 'CCCWCCCC..', '.CCCCCC...', '.CCCCCC...', '.CDDDDC...', '..........', '..........', '..........', '..........'],
  boots: ['..........', '.CC...CC..', '.CC...CC..', '.CC...CC..', '.CCC..CCC.', '.DDDD.DDDD', '..........', '..........', '..........', '..........'],
  wings: ['C........C', 'CC......CC', 'CCC....CCC', 'WCCC..CCCW', '.WCC..CCW.', '..WC..CW..', '..........', '..........', '..........', '..........'],
  glider: ['..........', '....BB....', 'CCCCCCCCCC', '.CCCWWCCC.', '..CC..CC..', '....BB....', '....BB....', '..........', '..........', '..........'],
  boat: ['....W.....', '....WW....', '....WWW...', '....B.....', 'CCCCCCCCC.', '.CCCCCCC..', '..DDDDD...', '..........', '..........', '..........'],
  backpack: ['...BBB....', '..B...B...', '.CCCCCCC..', '.CCDDDCC..', '.CCCCCCC..', '.CCCCCCC..', '.DDDDDDD..', '..........', '..........', '..........'],
  potion: ['....BB....', '....WW....', '...W..W...', '..WCCCCW..', '..WCCCCW..', '..WCCCCW..', '...WWWW...', '..........', '..........', '..........'],
  lantern: ['....DD....', '...D..D...', '..DDDDDD..', '..DYYYYD..', '..DYCCYD..', '..DYYYYD..', '..DDDDDD..', '..........', '..........', '..........'],
  totem: ['..CCCCC...', '..CDCDC...', '..CCCCC...', '..BBBBB...', '..BWBWB...', '..BBBBB...', '..CCCCC...', '..CCCCC...', '..........', '..........'],
  cart: ['..........', '.CCCCCCCC.', '.CDDDDDDC.', '.CCCCCCCC.', '..B....B..', '.BBB..BBB.', '..B....B..', '..........', '..........', '..........'],
  chariot: ['W.........', 'WCCCCCCC..', '.CDDDDDCW.', '.CCCCCCCWW', '..B....B..', '.BBB..BBB.', '..B....B..', '..........', '..........', '..........'],
  catapult: ['........C.', '.......CC.', '......B...', '.....B....', '....B.....', '.BBBBBBBB.', '.B.B..B.B.', 'BBB....BBB', '.B......B.', '..........'],
  golem: ['..GGGGG...', '.GYGGGYG..', '.GGGGGGG..', 'GGGCCCGGG.', 'G.GGGGG.G.', '..GG.GG...', '..GG.GG...', '..........', '..........', '..........'],
};

/** 10x10 item icon; unknown shapes are drawn as a totem. */
export function itemIcon(shape: string, color: string) {
  return cached(`icon${shape}${color}`, () => {
    const { c, put } = canvas(10, 10);
    const pal: Record<string, string> = {
      C: color, D: shade(color, -0.4), B: '#8c6040', W: '#f4f1ea', Y: '#ffd84d', G: '#8d929c',
    };
    drawMap(put, ICON_MAPS[shape] ?? ICON_MAPS.totem, 0, pal);
    return c;
  });
}

/** Wings of a flying crab (two frames: up/down). */
export function wingSprite(up: boolean) {
  return cached(`wings${up}`, () => {
    const { c, put } = canvas(21, 6);
    const rows = up
      ? ['WW.................WW', 'WWW...............WWW', '.WWW.............WWW.', '..WW.............WW..', '.....................', '.....................']
      : ['.....................', '.....................', 'WWWW.............WWWW', '.WWWW...........WWWW.', '..WW.............WW..', '.....................'];
    drawMap(put, rows, 0, { W: '#ffffff' });
    return c;
  });
}

/** Egg: speckled in the parent's color. */
export function eggSprite(color: string) {
  return cached(`egg${color}`, () => {
    const { c, put } = canvas(10, 12);
    for (let y = 0; y < 12; y++) {
      for (let x = 0; x < 10; x++) {
        const dx = (x - 4.5) / 4.6;
        const dy = (y - 6.5) / (y < 6.5 ? 6.2 : 5.2);
        if (dx * dx + dy * dy > 1) continue;
        let col = '#fbf6ea';
        if (dx + dy > 0.6) col = '#ddd3bd';
        else if (dx + dy < -0.9) col = '#ffffff';
        if (hash(x, y, 77) < 0.12 && y > 1 && y < 11) col = color;
        put(x, y, col);
      }
    }
    return c;
  });
}

export const RIDE_W = 20;
export const RIDE_H = 9;
/** Vehicle drawn under the crab (cart, chariot, catapult, boat). Two frames for spinning wheels. */
export function rideSprite(shape: string, color: string, frame: number) {
  return cached(`ride${shape}${color}${frame}`, () => {
    const { c, ctx, put } = canvas(RIDE_W, RIDE_H);
    const rect = (x: number, y: number, w: number, h: number, col: string) => ((ctx.fillStyle = col), ctx.fillRect(x, y, w, h));
    const dark = shade(color, -0.35);
    const light = shade(color, 0.2);
    if (shape === 'boat') {
      rect(1, 3, 18, 3, color);
      rect(3, 6, 14, 2, dark);
      rect(1, 3, 18, 1, light);
      put(0, 2, color);
      put(19, 2, color);
      return c;
    }
    // Body
    rect(1, 2, 18, 4, color);
    rect(1, 2, 18, 1, light);
    rect(1, 5, 18, 1, dark);
    if (shape === 'chariot') for (const x of [0, 19]) rect(x, 3, 1, 2, '#e8e8e8');
    if (shape === 'catapult') {
      rect(14, 0, 1, 3, '#7a5233');
      rect(15, 0, 3, 1, '#7a5233');
    }
    // Wheels
    for (const wx of [3, 14]) {
      rect(wx, 6, 3, 3, '#2a2433');
      put(wx + 1, frame ? 6 : 8, '#9a9ea8');
      put(wx + 1, 7, '#9a9ea8');
    }
    return c;
  });
}
