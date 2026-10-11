export type Rng = () => number;

/** Seedable, deterministic RNG — the same seed yields the same world. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const range = (rng: Rng, min: number, max: number) => min + rng() * (max - min);
export const randInt = (rng: Rng, min: number, max: number) => Math.floor(range(rng, min, max + 1));
export const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)];

export function shuffle<T>(rng: Rng, items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
