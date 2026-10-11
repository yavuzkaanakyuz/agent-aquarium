import type { TileType, WorldMap } from '../shared/protocol';
import { hash } from './sprites';

export const TILE = 16;

type RGB = [number, number, number];
const lerp = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const GRASS: RGB[] = [[92, 158, 64], [106, 174, 74], [124, 190, 86]];
const SAND: RGB[] = [[214, 192, 138], [233, 214, 160], [244, 230, 186]];
const WET_SAND: RGB = [198, 176, 124];
const DIRT: RGB[] = [[128, 94, 64], [150, 112, 78], [170, 132, 94]];
const SHALLOW: RGB = [104, 178, 214];
const DEEP: RGB = [46, 96, 164];
const FOAM: RGB = [214, 238, 246];
const FLOWERS: RGB[] = [[255, 143, 194], [255, 255, 255], [255, 216, 77], [176, 150, 255]];

/** Distance (in tiles) from each water tile to the nearest land — for depth shading. */
function waterDepth(world: WorldMap): Float32Array {
  const { width, height, tiles } = world;
  const depth = new Float32Array(width * height).fill(Infinity);
  let frontier: number[] = [];
  tiles.forEach((t, i) => {
    if (t !== 'water') {
      depth[i] = 0;
      frontier.push(i);
    }
  });
  for (let d = 1; frontier.length; d++) {
    const next: number[] = [];
    for (const i of frontier) {
      const x = i % width;
      const y = (i / width) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (depth[ni] !== Infinity) continue;
        depth[ni] = d;
        next.push(ni);
      }
    }
    frontier = next;
  }
  return depth;
}

/** Draws the whole ground into ImageData once; each frame just copies this canvas. */
export function buildTerrain(world: WorldMap): HTMLCanvasElement {
  const { width, height, tiles } = world;
  const W = width * TILE;
  const H = height * TILE;
  const depth = waterDepth(world);
  const tileAt = (px: number, py: number): TileType => {
    const tx = Math.floor(px / TILE);
    const ty = Math.floor(py / TILE);
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) return 'water';
    return tiles[ty * width + tx];
  };
  const nearWater = (px: number, py: number, r: number) =>
    tileAt(px - r, py) === 'water' || tileAt(px + r, py) === 'water' || tileAt(px, py - r) === 'water' || tileAt(px, py + r) === 'water';
  const nearLand = (px: number, py: number, r: number) =>
    tileAt(px - r, py) !== 'water' || tileAt(px + r, py) !== 'water' || tileAt(px, py - r) !== 'water' || tileAt(px, py + r) !== 'water';

  // Bilinear sampling between tile centers for smooth depth transitions.
  const depthAt = (tx: number, ty: number) =>
    Math.min(5, depth[Math.min(height - 1, Math.max(0, ty)) * width + Math.min(width - 1, Math.max(0, tx))]);
  const sampleDepth = (px: number, py: number) => {
    const fx = px / TILE - 0.5;
    const fy = py / TILE - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const top = depthAt(x0, y0) * (1 - tx) + depthAt(x0 + 1, y0) * tx;
    const bottom = depthAt(x0, y0 + 1) * (1 - tx) + depthAt(x0 + 1, y0 + 1) * tx;
    return top * (1 - ty) + bottom * ty + (hash(px >> 1, py >> 1, 19) - 0.5) * 0.35;
  };

  const img = new ImageData(W, H);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      // Jitter tile borders slightly for organic edges.
      const jx = px + Math.round((hash(px, py, 1) - 0.5) * 5);
      const jy = py + Math.round((hash(px, py, 2) - 0.5) * 5);
      const t = tileAt(jx, jy);
      const n = hash(px, py, 7);
      const tileShade = hash(Math.floor(px / TILE), Math.floor(py / TILE), 11);
      let c: RGB;

      switch (t) {
        case 'grass':
        case 'flowers': {
          c = n < 0.1 ? GRASS[0] : n > 0.95 ? GRASS[2] : GRASS[1];
          if (tileShade < 0.3) c = lerp(c, GRASS[0], 0.25);
          // Little grass tufts
          if (hash(px >> 1, py >> 1, 5) > 0.97 && py % 2 === 0) c = GRASS[0];
          if (t === 'flowers' && hash(px >> 1, py >> 1, 13) > 0.975) {
            c = FLOWERS[Math.floor(hash(px >> 1, py >> 1, 17) * FLOWERS.length)];
          }
          break;
        }
        case 'sand':
          c = n < 0.07 ? SAND[0] : n > 0.96 ? SAND[2] : SAND[1];
          if (nearWater(jx, jy, 3)) c = lerp(c, WET_SAND, 0.7);
          break;
        case 'dirt':
          c = n < 0.12 ? DIRT[0] : n > 0.93 ? DIRT[2] : DIRT[1];
          break;
        case 'water': {
          const d = sampleDepth(px, py);
          c = lerp(SHALLOW, DEEP, Math.min(1, Math.max(0, (d - 1) / 4)));
          if (hash(px >> 2, py, 3) > 0.985) c = lerp(c, FOAM, 0.35);
          if (nearLand(jx, jy, 2)) c = FOAM;
          else if (nearLand(jx, jy, 4)) c = lerp(c, FOAM, 0.35);
          break;
        }
      }

      const o = (py * W + px) * 4;
      img.data[o] = c[0];
      img.data[o + 1] = c[1];
      img.data[o + 2] = c[2];
      img.data[o + 3] = 255;
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  canvas.getContext('2d')!.putImageData(img, 0, 0);
  return canvas;
}
