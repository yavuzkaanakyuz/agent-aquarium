import type { ItemType } from './protocol';

/**
 * Invention system: agents never write code. They design recipes (blueprints) that combine components the engine
 * already knows. The engine validates each recipe against tech level, material budget and component rules.
 */
export type ComponentType =
  | 'harvest' | 'damage' | 'defense' | 'range' | 'speed' | 'flight'
  | 'storage' | 'shelter' | 'heal' | 'light' | 'automaton' | 'swim';

export type BlueprintKind = 'tool' | 'weapon' | 'armor' | 'vehicle' | 'structure' | 'consumable' | 'golem';

export const SHAPES = [
  'hammer', 'axe', 'pickaxe', 'sword', 'spear', 'bow', 'shield', 'helmet', 'armor', 'boots',
  'wings', 'glider', 'boat', 'cart', 'chariot', 'catapult', 'backpack', 'potion', 'lantern', 'totem', 'golem',
  'hut', 'house', 'tower', 'wall',
] as const;
export type Shape = (typeof SHAPES)[number];
export const STRUCTURE_SHAPES: Shape[] = ['hut', 'house', 'tower', 'wall'];

export interface ComponentDef {
  name: string;
  minTech: number;
  cost: number; // budget cost per power point
  kinds: BlueprintKind[];
  desc: string;
  emoji: string;
}

export const COMPONENTS: Record<ComponentType, ComponentDef> = {
  harvest: { name: 'Harvest', minTech: 1, cost: 2, kinds: ['tool'], desc: 'gathers resources faster', emoji: '⛏️' },
  damage: { name: 'Damage', minTech: 1, cost: 2.5, kinds: ['weapon', 'tool', 'golem', 'vehicle'], desc: 'attack power; on a vehicle it is siege power against structures (×2)', emoji: '⚔️' },
  defense: { name: 'Defense', minTech: 1, cost: 2.5, kinds: ['armor', 'structure', 'golem', 'vehicle'], desc: 'reduces damage taken; durability on structures', emoji: '🛡️' },
  range: { name: 'Range', minTech: 3, cost: 3, kinds: ['weapon', 'vehicle'], desc: 'attack from a distance', emoji: '🏹' },
  speed: { name: 'Speed', minTech: 2, cost: 3, kinds: ['vehicle', 'armor'], desc: 'move faster', emoji: '💨' },
  flight: { name: 'Flight', minTech: 4, cost: 10, kinds: ['vehicle'], desc: 'fly over water and obstacles', emoji: '🪽' },
  storage: { name: 'Storage', minTech: 1, cost: 2, kinds: ['tool', 'vehicle', 'structure'], desc: 'bag capacity (+3 per power)', emoji: '🎒' },
  shelter: { name: 'Shelter', minTech: 1, cost: 1.5, kinds: ['structure'], desc: 'faster rest and safety when sleeping at home', emoji: '🏠' },
  heal: { name: 'Heal', minTech: 2, cost: 3, kinds: ['consumable'], desc: 'restores health (consumable)', emoji: '❤️‍🩹' },
  light: { name: 'Light', minTech: 2, cost: 2, kinds: ['tool', 'structure'], desc: 'see in the dark; less fear at night', emoji: '💡' },
  automaton: { name: 'Automaton', minTech: 4, cost: 8, kinds: ['golem'], desc: 'creates a helper that works for its owner', emoji: '🤖' },
  swim: { name: 'Swim', minTech: 2, cost: 3, kinds: ['vehicle'], desc: 'travel on water (boat)', emoji: '🚣' },
};

/** Vehicles wear out: every ride or raid uses up one durability point. */
export const vehicleDurability = (components: BlueprintComponent[]) => 4 + 2 * components.reduce((s, c) => s + c.power, 0);

export const KINDS: Record<BlueprintKind, string> = {
  tool: 'Tool',
  weapon: 'Weapon',
  armor: 'Armor/clothing',
  vehicle: 'Vehicle',
  structure: 'Structure',
  consumable: 'Consumable',
  golem: 'Golem',
};

export const MATERIAL_VALUE: Record<ItemType, number> = { wood: 1, stone: 1.5, fiber: 0.8, berry: 0.5 };

/** Knowledge thresholds: index = level - 1. */
export const TECH_THRESHOLDS = [0, 25, 70, 140, 250];
export const techLevel = (knowledge: number) => TECH_THRESHOLDS.filter((t) => knowledge >= t).length;
export const budgetMultiplier = (tech: number) => 0.8 + 0.15 * tech;
export const budgetFor = (materialValue: number, tech: number) => materialValue * budgetMultiplier(tech);

export interface BlueprintComponent {
  type: ComponentType;
  power: number;
}

export interface Blueprint {
  id: string;
  name: string;
  kind: BlueprintKind;
  description: string;
  components: BlueprintComponent[];
  materials: Partial<Record<ItemType, number>>;
  shape: Shape;
  color: string;
  inventorId: string;
  inventorName: string;
  day: number;
  workTicks: number;
}

export interface EquipmentState {
  blueprintId: string;
  name: string;
  kind: BlueprintKind;
  components: BlueprintComponent[];
  shape: Shape;
  color: string;
  uses: number | null; // for consumables
}
