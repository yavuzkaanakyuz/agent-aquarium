import type { ItemType, ObjectType } from '../shared/protocol';

// Works in Node and in the browser demo (where there is no process.env).
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

/**
 * Experiment settings: economy, needs and resources in one place.
 * (DAY_TICKS = 1800 → one day is 3 minutes at 1x)
 */
export const BALANCE = {
  inventoryCapacity: 12,
  foodReserveSlots: 3, // bag slots kept free for food when gathering materials
  senseRadius: 30, // walking distance (tiles) within which an agent "sees" resources

  food: {
    decayAwake: 0.04, // per tick
    decaySleep: 0.015,
    perBerry: 22,
    hungryAt: 30, // "I'm hungry" threshold
    urgentAt: 15, // drops other work to look for food
  },
  energy: {
    decayIdle: 0.03,
    decayActive: 0.06,
    regenSleep: 0.13,
    exhaustedAt: 5,
  },
  health: {
    starveLoss: 0.06, // while fullness is 0
    exhaustLoss: 0.03, // while energy is 0
    regen: 0.02,
  },
  faintTicks: 300,
  /** Starvation death: fainting from hunger this many times without eating in between is fatal (.env PERMADEATH=0 disables). */
  permadeath: env.PERMADEATH !== '0',
  starvationFaintsToDie: 2,
  eatTicks: 12,
};

export interface ResourceDef {
  item: ItemType;
  max: number;
  workTicks: number; // effort needed per unit
  regenTicks: number; // time for one unit to regrow
  doing: string;
  did: string;
  bonus?: { item: ItemType; chance: number };
}

export type ResourceType = Exclude<ObjectType, 'structure'>;
/** Initial scarcity multiplier (.env SCARCITY); can be changed at runtime via World.scarcity. */
export const DEFAULT_SCARCITY = Math.max(0.2, Number(env.SCARCITY ?? 1) || 1);

export const RESOURCES: Record<ResourceType, ResourceDef> = {
  bush: {
    item: 'berry', max: 4, workTicks: 15, regenTicks: 380,
    doing: 'Picking berries', did: 'picked berries',
    bonus: { item: 'fiber', chance: 0.25 },
  },
  tree: { item: 'wood', max: 5, workTicks: 40, regenTicks: 450, doing: 'Chopping wood', did: 'chopped wood' },
  rock: { item: 'stone', max: 8, workTicks: 55, regenTicks: 900, doing: 'Breaking stone', did: 'broke stone' },
};
