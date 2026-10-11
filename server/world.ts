import { structureMaxHp, type ObjectUpdate, type StructureInfo, type TileType, type WorldMap, type WorldObject } from '../shared/protocol';
import { DEFAULT_SCARCITY, RESOURCES } from './balance';
import { mulberry32, randInt, type Rng } from './rng';

/** Smoothed value noise: samples a coarse random grid with bilinear + smoothstep. */
function makeNoise(rng: Rng, width: number, height: number, cell: number) {
  const gw = Math.ceil(width / cell) + 2;
  const gh = Math.ceil(height / cell) + 2;
  const grid = Array.from({ length: gw * gh }, () => rng());
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y: number) => {
    const gx = x / cell;
    const gy = y / cell;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const tx = smooth(gx - x0);
    const ty = smooth(gy - y0);
    const v = (ix: number, iy: number) => grid[iy * gw + ix];
    const top = v(x0, y0) * (1 - tx) + v(x0 + 1, y0) * tx;
    const bottom = v(x0, y0 + 1) * (1 - tx) + v(x0 + 1, y0 + 1) * tx;
    return top * (1 - ty) + bottom * ty;
  };
}

/** Flags, gravestones and the market don't block the way; they can be walked over. */
export const isPassableStructure = (o: WorldObject) => ['flag', 'grave', 'market'].includes(o.structure?.shape ?? '');

export class World {
  readonly map: WorldMap;
  private blocked: Uint8Array;
  private byTile = new Map<number, WorldObject>();
  private regenTimers = new Map<number, number>();
  private changed = new Set<WorldObject>();
  private added: WorldObject[] = [];
  private removed: number[] = [];
  private byId = new Map<number, WorldObject>();
  private nextId: number;
  /** Resource regrowth-time multiplier (1 = normal). Agents don't know it; they only live with the results. */
  scarcity = DEFAULT_SCARCITY;

  constructor(map: WorldMap) {
    this.map = map;
    this.blocked = new Uint8Array(map.width * map.height);
    map.tiles.forEach((t, i) => {
      if (t === 'water') this.blocked[i] = 1;
    });
    for (const o of map.objects) {
      const i = o.y * map.width + o.x;
      if (!isPassableStructure(o)) this.blocked[i] = 1;
      this.byTile.set(i, o);
      this.byId.set(o.id, o);
      // Give HP to structures from old saves.
      if (o.structure && !o.max) o.amount = o.max = structureMaxHp(o.structure);
    }
    this.nextId = Math.max(0, ...map.objects.map((o) => o.id)) + 1;
  }

  /** By boat: land or water (with no object on it). */
  isSwimmable(x: number, y: number): boolean {
    if (!this.isFlyable(x, y)) return false;
    const i = y * this.map.width + x;
    return this.blocked[i] === 0 || (this.map.tiles[i] === 'water' && !this.byTile.has(i));
  }

  isWater(x: number, y: number): boolean {
    return this.isFlyable(x, y) && this.map.tiles[y * this.map.width + x] === 'water';
  }

  get market(): WorldObject | undefined {
    return this.map.objects.find((o) => o.structure?.shape === 'market');
  }

  /** Builds the marketplace in the middle of the island (largest landmass, free tile closest to its center). */
  ensureMarket(): WorldObject {
    const existing = this.market;
    if (existing) return existing;
    const region = this.largestRegion();
    const cx = region.reduce((s, i) => s + (i % this.width), 0) / region.length;
    const cy = region.reduce((s, i) => s + Math.floor(i / this.width), 0) / region.length;
    const spot = region
      .map((i) => ({ x: i % this.width, y: Math.floor(i / this.width) }))
      .filter((p) => [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dy]) => this.isWalkable(p.x + dx, p.y + dy)))
      .sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy))[0];
    return this.addStructure(spot.x, spot.y, {
      blueprintId: 'market', name: 'Pazar Yeri', kind: 'structure', shape: 'market', color: '#e8b54a',
      ownerId: '', ownerName: 'Ada', shelter: 0, light: 1, defense: 0,
    });
  }

  damageStructure(obj: WorldObject, dmg: number): boolean {
    obj.amount = Math.max(0, obj.amount - dmg);
    this.changed.add(obj);
    return obj.amount <= 0;
  }

  objectById(id: number): WorldObject | undefined {
    return this.byId.get(id);
  }

  /** For flyers: every tile on the map is passable. */
  isFlyable(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.map.width && y < this.map.height;
  }

  addStructure(x: number, y: number, info: StructureInfo): WorldObject {
    const hp = structureMaxHp(info);
    const obj: WorldObject = { id: this.nextId++, type: 'structure', x, y, variant: 0, amount: hp, max: hp, structure: info };
    const i = y * this.map.width + x;
    this.map.objects.push(obj);
    this.byTile.set(i, obj);
    this.byId.set(obj.id, obj);
    if (!isPassableStructure(obj)) this.blocked[i] = 1;
    this.added.push(obj);
    return obj;
  }

  /** Is this a walkable tile with no object on it? (for building) */
  isFree(x: number, y: number): boolean {
    return this.isWalkable(x, y) && !this.byTile.has(y * this.map.width + x);
  }

  /**
   * Would blocking (x,y) trap someone nearby? Temporarily blocks it and runs a short BFS
   * from each nearby point; if the reachable area is tiny, the answer is yes.
   */
  wouldTrap(x: number, y: number, points: { x: number; y: number }[]): boolean {
    const i = y * this.map.width + x;
    const prev = this.blocked[i];
    this.blocked[i] = 1;
    try {
      for (const p of points) {
        if (Math.abs(p.x - x) > 3 || Math.abs(p.y - y) > 3) continue;
        if (this.reachableCount(p.x, p.y, 25) < 25) return true;
      }
      // Neighboring walkable tiles must stay connected too (don't block passages).
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (this.isWalkable(x + dx, y + dy) && this.reachableCount(x + dx, y + dy, 25) < 25) return true;
      }
      return false;
    } finally {
      this.blocked[i] = prev;
    }
  }

  /** Counts tiles reachable from (x,y) with 4-way walking, up to `limit`. */
  reachableCount(x: number, y: number, limit: number): number {
    const w = this.map.width;
    const seen = new Set<number>([y * w + x]);
    const queue = [y * w + x];
    while (queue.length && seen.size < limit) {
      const i = queue.shift()!;
      const cx = i % w;
      const cy = (i / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx;
        const ny = cy + dy;
        const ni = ny * w + nx;
        if (!this.isWalkable(nx, ny) || seen.has(ni)) continue;
        seen.add(ni);
        queue.push(ni);
      }
    }
    return seen.size;
  }

  /** For someone stuck: they can squeeze between structures (but not through water or trees). */
  isEscapable(x: number, y: number): boolean {
    if (this.isWalkable(x, y)) return true;
    const o = this.objectAt(x, y);
    return !!o && o.type === 'structure' && !this.isWater(x, y);
  }

  removeObject(obj: WorldObject) {
    const i = obj.y * this.map.width + obj.x;
    this.map.objects.splice(this.map.objects.indexOf(obj), 1);
    this.byTile.delete(i);
    this.byId.delete(obj.id);
    this.blocked[i] = this.map.tiles[i] === 'water' ? 1 : 0;
    this.removed.push(obj.id);
  }

  drainAdded(): WorldObject[] {
    const out = this.added;
    this.added = [];
    return out;
  }

  drainRemoved(): number[] {
    const out = this.removed;
    this.removed = [];
    return out;
  }

  get landTiles(): number {
    return this.map.tiles.filter((t) => t !== 'water').length;
  }

  objectAt(x: number, y: number): WorldObject | undefined {
    if (x < 0 || y < 0 || x >= this.map.width || y >= this.map.height) return undefined;
    return this.byTile.get(y * this.map.width + x);
  }

  /** Takes one unit of a resource; returns false if it is depleted. */
  harvest(obj: WorldObject): boolean {
    if (obj.amount <= 0) return false;
    obj.amount--;
    this.changed.add(obj);
    return true;
  }

  /** Resources regrow over time. */
  tick() {
    for (const o of this.map.objects) {
      if (o.type === 'structure') {
        // Damaged structures slowly repair themselves.
        if (o.amount < o.max && Math.random() < 0.005) {
          o.amount++;
          this.changed.add(o);
        }
        continue;
      }
      if (o.amount >= o.max) continue;
      const t = (this.regenTimers.get(o.id) ?? 0) + 1;
      if (t >= RESOURCES[o.type as keyof typeof RESOURCES].regenTicks * this.scarcity) {
        o.amount++;
        this.changed.add(o);
        this.regenTimers.set(o.id, 0);
      } else {
        this.regenTimers.set(o.id, t);
      }
    }
  }

  /** Secret drought: sets scarcity and quietly withers a share of the existing berries. */
  setScarcity(value: number, wither: number) {
    this.scarcity = Math.max(0.2, value);
    for (const o of this.map.objects) {
      if (o.type !== 'bush' || o.amount <= 0) continue;
      const left = Math.floor(o.amount * (1 - wither));
      if (left !== o.amount) {
        o.amount = left;
        this.changed.add(o);
      }
      this.regenTimers.set(o.id, 0);
    }
  }

  /** Rain: every bush and tree refills instantly. */
  rain() {
    for (const o of this.map.objects) {
      if (o.type !== 'bush' && o.type !== 'tree') continue;
      if (o.amount < o.max) {
        o.amount = o.max;
        this.changed.add(o);
      }
      this.regenTimers.set(o.id, 0);
    }
  }

  drainChanges(): ObjectUpdate[] {
    const out = [...this.changed].map((o) => ({ id: o.id, amount: o.amount }));
    this.changed.clear();
    return out;
  }

  get width() {
    return this.map.width;
  }
  get height() {
    return this.map.height;
  }

  isWalkable(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.map.width || y >= this.map.height) return false;
    return this.blocked[y * this.map.width + x] === 0;
  }

  /** The largest walkable region — agents spawn here so nobody is stranded on an islet. */
  largestRegion(): number[] {
    const { width, height } = this.map;
    const seen = new Uint8Array(width * height);
    let best: number[] = [];
    for (let start = 0; start < width * height; start++) {
      if (seen[start] || this.blocked[start]) continue;
      const region: number[] = [];
      const queue = [start];
      seen[start] = 1;
      while (queue.length) {
        const i = queue.pop()!;
        region.push(i);
        const x = i % width;
        const y = (i / width) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (!this.isWalkable(nx, ny)) continue;
          const ni = ny * width + nx;
          if (seen[ni]) continue;
          seen[ni] = 1;
          queue.push(ni);
        }
      }
      if (region.length > best.length) best = region;
    }
    return best;
  }
}

export function generateWorld(seed: number, width = 48, height = 32): World {
  const rng = mulberry32(seed);
  const broad = makeNoise(rng, width, height, 9);
  const detail = makeNoise(rng, width, height, 4);
  const moisture = makeNoise(rng, width, height, 7);

  const tiles: TileType[] = [];
  const moist: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Island shape: height falls off with distance from the center; the edges become water.
      const nx = ((x + 0.5) / width) * 2 - 1;
      const ny = ((y + 0.5) / height) * 2 - 1;
      const d = Math.sqrt(nx * nx + ny * ny);
      const h = 0.55 * broad(x, y) + 0.3 * detail(x, y) + 0.42 - 0.8 * d * d;
      const m = moisture(x, y);
      moist.push(m);
      let t: TileType;
      if (h < 0.36) t = 'water';
      else if (h < 0.43) t = 'sand';
      else if (m < 0.28) t = 'dirt';
      else if (m > 0.66) t = 'flowers';
      else t = 'grass';
      tiles.push(t);
    }
  }

  const objects: WorldObject[] = [];
  let nextId = 1;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const t = tiles[i];
      const m = moist[i];
      const r = rng();
      let type: WorldObject['type'] | null = null;
      if (t === 'grass' || t === 'flowers') {
        if (r < 0.04 + m * 0.07) type = 'tree';
        else if (r < 0.09 + m * 0.07) type = 'bush';
        else if (r < 0.1 + m * 0.07) type = 'rock';
      } else if (t === 'dirt') {
        if (r < 0.05) type = 'rock';
        else if (r < 0.07) type = 'tree';
      } else if (t === 'sand' && r < 0.015) {
        type = 'rock';
      }
      if (type) {
        const max = RESOURCES[type as keyof typeof RESOURCES].max;
        objects.push({ id: nextId++, type, x, y, variant: Math.floor(rng() * 3), amount: randInt(rng, Math.ceil(max / 2), max), max });
      }
    }
  }

  return new World({ seed, width, height, tiles, objects });
}
