import type { WorldObject } from '../shared/protocol';
import type { World } from './world';

export interface Point {
  x: number;
  y: number;
}

const DIRS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
] as const;

/**
 * BFS for all tiles reachable from the start within `maxSteps` steps.
 * Diagonal moves can't cut corners (no slipping through the corner of a tree).
 */
/** How an agent moves: walking, by boat (over water) or flying. `true` means flying, for older callers. */
export type Mobility = 'walk' | 'swim' | 'fly';

export function explore(world: World, start: Point, maxSteps: number, mobility: Mobility | boolean = 'walk') {
  const mode = mobility === true ? 'fly' : mobility === false ? 'walk' : mobility;
  // A walker boxed in by structures (very little room) may squeeze between them.
  const trapped = mode === 'walk' && world.reachableCount(start.x, start.y, 12) < 12;
  const passable = (x: number, y: number) =>
    mode === 'fly' ? world.isFlyable(x, y) : mode === 'swim' ? world.isSwimmable(x, y) : trapped ? world.isEscapable(x, y) : world.isWalkable(x, y);
  const { width } = world;
  const startIdx = start.y * width + start.x;
  const prev = new Map<number, number>([[startIdx, -1]]);
  const reachable: number[] = [];
  let frontier = [startIdx];

  for (let step = 0; step < maxSteps && frontier.length; step++) {
    const next: number[] = [];
    for (const i of frontier) {
      const x = i % width;
      const y = (i / width) | 0;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (!passable(nx, ny)) continue;
        if (dx && dy && (!passable(x + dx, y) || !passable(x, y + dy))) continue;
        const ni = ny * width + nx;
        if (prev.has(ni)) continue;
        prev.set(ni, i);
        reachable.push(ni);
        next.push(ni);
      }
    }
    frontier = next;
  }

  const pathTo = (target: number): Point[] => {
    const path: Point[] = [];
    for (let i = target; i !== startIdx && i !== -1; i = prev.get(i) ?? -1) {
      path.push({ x: i % width, y: (i / width) | 0 });
    }
    return path.reverse();
  };

  return { reachable, pathTo };
}

/**
 * Finds the nearest reachable object and returns a path to a tile next to it.
 * BFS order is distance order, so the first match is the closest.
 */
export function findNearest(world: World, start: Point, maxSteps: number, match: (o: WorldObject) => boolean, mobility: Mobility | boolean = 'walk') {
  const { reachable, pathTo } = explore(world, start, maxSteps, mobility);
  const startIdx = start.y * world.width + start.x;
  for (const i of [startIdx, ...reachable]) {
    const x = i % world.width;
    const y = (i / world.width) | 0;
    if (i !== startIdx && !world.isWalkable(x, y)) continue; // even flyers must land on ground
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const obj = world.objectAt(x + dx, y + dy);
      if (obj && match(obj)) return { obj, path: i === startIdx ? [] : pathTo(i) };
    }
  }
  return null;
}
