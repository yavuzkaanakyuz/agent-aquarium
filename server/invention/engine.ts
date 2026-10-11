import {
  COMPONENTS, KINDS, MATERIAL_VALUE, SHAPES, STRUCTURE_SHAPES, budgetFor, budgetMultiplier,
  type Blueprint, type BlueprintComponent, type BlueprintKind, type ComponentType, type Shape,
} from '../../shared/invention';
import { ITEMS, type ItemType } from '../../shared/protocol';
import type { Agent } from '../agent';

export const MAX_COMPONENTS = 3;
export const MAX_EQUIPMENT = 5;
const KIND_LIST = Object.keys(KINDS) as BlueprintKind[];
const COMPONENT_LIST = Object.keys(COMPONENTS) as ComponentType[];
const MATERIALS: ItemType[] = ['wood', 'stone', 'fiber', 'berry'];

export interface Design {
  thought: string;
  name: string;
  kind: BlueprintKind;
  description: string;
  components: BlueprintComponent[];
  materials: Partial<Record<ItemType, number>>;
  shape: Shape;
  color: string;
}

export const DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    thought: { type: 'string', description: 'One sentence going through your mind as you design.' },
    name: { type: 'string', description: 'A short, creative English name for the invention (max 30 characters).' },
    kind: { type: 'string', enum: KIND_LIST },
    description: { type: 'string', description: 'What it does, 1 sentence.' },
    components: {
      type: 'array',
      description: `At most ${MAX_COMPONENTS} components.`,
      items: {
        type: 'object',
        properties: { type: { type: 'string', enum: COMPONENT_LIST }, power: { type: 'integer' } },
        required: ['type', 'power'],
        additionalProperties: false,
      },
    },
    materials: {
      type: 'object',
      properties: Object.fromEntries(MATERIALS.map((m) => [m, { type: 'integer' }])),
      required: MATERIALS,
      additionalProperties: false,
    },
    shape: { type: 'string', enum: [...SHAPES] },
    color: { type: 'string', description: 'Ana renk, #rrggbb.' },
  },
  required: ['thought', 'name', 'kind', 'description', 'components', 'materials', 'shape', 'color'],
  additionalProperties: false,
};

export function parseDesign(text: string): Design | null {
  try {
    const raw = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? text);
    if (typeof raw.name !== 'string' || !KIND_LIST.includes(raw.kind)) return null;
    const components = (Array.isArray(raw.components) ? raw.components : [])
      .filter((c: { type?: string }) => COMPONENT_LIST.includes(c?.type as ComponentType))
      .map((c: { type: ComponentType; power: unknown }) => ({ type: c.type, power: Math.max(0, Math.round(Number(c.power) || 0)) }));
    const materials: Partial<Record<ItemType, number>> = {};
    for (const m of MATERIALS) {
      const n = Math.max(0, Math.round(Number(raw.materials?.[m]) || 0));
      if (n) materials[m] = n;
    }
    return {
      thought: String(raw.thought ?? '').slice(0, 200),
      name: raw.name.trim().slice(0, 30),
      kind: raw.kind,
      description: String(raw.description ?? '').slice(0, 160),
      components,
      materials,
      shape: SHAPES.includes(raw.shape) ? raw.shape : raw.kind === 'structure' ? 'hut' : 'hammer',
      color: /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : '#c08a4e',
    };
  } catch {
    return null;
  }
}

export const materialValue = (m: Partial<Record<ItemType, number>>) =>
  (Object.entries(m) as [ItemType, number][]).reduce((s, [k, n]) => s + MATERIAL_VALUE[k] * n, 0);
export const componentCost = (cs: BlueprintComponent[]) => cs.reduce((s, c) => s + COMPONENTS[c.type].cost * c.power, 0);

/** The engine's "laws of physics": returns the reasons a recipe is invalid. */
export function validateDesign(d: Design, agent: Agent): string[] {
  const errors: string[] = [];
  const tech = agent.tech;
  if (!d.name) errors.push('The invention needs a name.');
  // Merge components of the same type.
  const merged = new Map<ComponentType, number>();
  for (const c of d.components) if (c.power > 0) merged.set(c.type, (merged.get(c.type) ?? 0) + c.power);
  d.components = [...merged.entries()].map(([type, power]) => ({ type, power }));

  if (!d.components.length) errors.push('At least one component is required.');
  if (d.components.length > MAX_COMPONENTS) errors.push(`At most ${MAX_COMPONENTS} different components are allowed.`);
  for (const c of d.components) {
    const def = COMPONENTS[c.type];
    if (!def.kinds.includes(d.kind)) errors.push(`The ${def.name} component can't go on a ${KINDS[d.kind].toLowerCase()}.`);
    if (tech < def.minTech) errors.push(`${def.name} needs tech level ${def.minTech} (yours is ${tech}).`);
    if (c.power > Math.min(5, tech + 1)) errors.push(`${def.name} power can be at most ${Math.min(5, tech + 1)}.`);
  }
  if (d.kind === 'structure' && !STRUCTURE_SHAPES.includes(d.shape)) d.shape = 'hut';
  if (d.kind !== 'structure' && STRUCTURE_SHAPES.includes(d.shape)) d.shape = 'totem';
  if (d.kind === 'vehicle' && totalQty(d.materials) < 6) errors.push('A vehicle needs at least 6 materials.');
  if (d.kind === 'structure' && totalQty(d.materials) < 5) errors.push('A structure needs at least 5 materials.');

  const value = materialValue(d.materials);
  const cost = componentCost(d.components);
  const budget = budgetFor(value, tech);
  if (cost > budget) {
    errors.push(`Not enough materials: components cost ${cost.toFixed(1)}, your material budget is ${budget.toFixed(1)}. Use more materials or lower the power.`);
  }
  for (const [k, n] of Object.entries(d.materials) as [ItemType, number][]) {
    if ((agent.inventory[k] ?? 0) < n) errors.push(`Not enough ${ITEMS[k].name.toLowerCase()} in your bag (${n} needed, ${agent.inventory[k] ?? 0} available).`);
  }
  return errors;
}

const totalQty = (m: Partial<Record<ItemType, number>>) => Object.values(m).reduce((s, n) => s + (n ?? 0), 0);

export function workTicksFor(d: Pick<Design, 'components' | 'kind'>): number {
  const base = 40 + componentCost(d.components) * 25;
  return Math.round(d.kind === 'structure' ? base * 2 : base);
}

export function describeBlueprint(b: Pick<Blueprint, 'name' | 'kind' | 'components' | 'materials'>): string {
  const comps = b.components.map((c) => `${COMPONENTS[c.type].name} ${c.power}`).join(', ');
  const mats = (Object.entries(b.materials) as [ItemType, number][]).map(([k, n]) => `${n} ${ITEMS[k].name.toLowerCase()}`).join(', ');
  return `${b.name} (${KINDS[b.kind].toLowerCase()}; ${comps}; materials: ${mats})`;
}

export function designPrompt(agent: Agent, idea: string, knownBlueprints: Blueprint[]): string {
  const tech = agent.tech;
  const inv = (Object.entries(agent.inventory) as [ItemType, number][])
    .filter(([, n]) => n)
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');
  const comps = COMPONENT_LIST.map((t) => {
    const c = COMPONENTS[t];
    const ok = tech >= c.minTech ? '' : ` — LOCKED (needs level ${c.minTech})`;
    return `- ${t}: ${c.desc}; cost per power ${c.cost}; kinds: ${c.kinds.join('/')}${ok}`;
  }).join('\n');
  const known = knownBlueprints.length ? knownBlueprints.map((b) => `- ${describeBlueprint(b)}`).join('\n') : '- (none yet)';
  const next = [25, 70, 140, 250].find((t) => t > agent.knowledge);

  return `You are designing an invention. Your idea: "${idea}"

Your tech level: ${tech} (knowledge ${Math.round(agent.knowledge)}${next ? `, next level at ${next}` : ''}).
Materials in your bag (you can only use these): ${inv || 'empty'}
Material values: wood 1, stone 1.5, fiber 0.8, berry 0.5.
Budget rule: total component cost ≤ material value × ${budgetMultiplier(tech).toFixed(2)}.
Each component's power must be between 1 and ${Math.min(5, tech + 1)}; at most ${MAX_COMPONENTS} components.

Components:
${comps}

Kinds: ${KIND_LIST.map((k) => `${k} (${KINDS[k]})`).join(', ')}
Rules: a vehicle needs at least 6 materials, a structure at least 5. Structures (hut/house/tower/wall shapes) are built into the world; everything else is carried.

Recipes you know:
${known}

Turn your idea into a realistic recipe that follows these rules. A recipe that breaks the rules fails — your materials are not lost, but you lose time. Do the budget math; don't exceed it.`;
}
