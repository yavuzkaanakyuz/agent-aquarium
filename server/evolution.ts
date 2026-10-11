import type { Blueprint } from '../shared/invention';
import { DAY_TICKS, type Accessory, type AgentAction, type Personality } from '../shared/protocol';
import { Agent } from './agent';
import type { SimContext } from './context';
import type { Point } from './pathfinding';
import { pick, type Rng } from './rng';
import { AttackTask } from './social/combat';
import { ApproachTask, GatherTask, WanderTask, type Task, type TaskStatus } from './tasks';

// Works in Node and in the browser demo (where there is no process.env).
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

export const MAX_POPULATION = Number(env.MAX_AGENTS ?? 12);
const ACCESSORIES: Accessory[] = ['none', 'sprout', 'tophat', 'bow', 'antenna', 'flower'];
const SYLLABLES = ['Pi', 'Mo', 'Ki', 'Lu', 'Bo', 'Na', 'Ri', 'Zu', 'Te', 'Fi', 'Ca', 'Do', 'Me', 'Su', 'Yo', 'Ne', 'Ta'];
const ENDINGS = ['p', 'n', 'ko', 'mi', 'ru', 'li', 'ba', 'to', 'ni', 'z', 'bo', 'shi'];

function mixColor(a: string, b: string, rng: Rng): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const t = 0.35 + rng() * 0.3;
  const ch = (shift: number) => {
    const v = Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t + (rng() - 0.5) * 30);
    return Math.max(30, Math.min(235, v));
  };
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('')}`;
}

function blendPersonality(a: Personality, b: Personality, rng: Rng): Personality {
  const out = {} as Personality;
  for (const k of Object.keys(a) as (keyof Personality)[]) {
    const base = rng() < 0.5 ? a[k] : b[k];
    const mid = (a[k] + b[k]) / 2;
    const v = (base + mid) / 2 + (rng() - 0.5) * 0.3; // mutation
    out[k] = Math.round(Math.min(1, Math.max(0, v)) * 100) / 100;
  }
  return out;
}

function freeTileNear(ctx: SimContext, p: Point): Point | null {
  for (let r = 1; r <= 3; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = p.x + dx;
        const y = p.y + dy;
        if (ctx.world.isWalkable(x, y) && !ctx.agents.some((a) => a.tile.x === x && a.tile.y === y)) return { x, y };
      }
    }
  }
  return null;
}

/** Starting a family: if conditions allow, an egg is laid. */
export function startFamily(a: Agent, b: Agent, ctx: SimContext, nextId: () => string, add: (agent: Agent) => void): boolean {
  if (a.isGolem || b.isGolem || a.stage !== 'adult' || b.stage !== 'adult') return false;
  if (ctx.agents.filter((x) => !x.isGolem).length >= MAX_POPULATION) {
    ctx.log(`The island is crowded; ${a.name} and ${b.name} can't start a family for now`, a.id);
    return false;
  }
  if (a.familyCooldownDay > ctx.clock.day || b.familyCooldownDay > ctx.clock.day) return false;
  if (a.needs.food < 45 || b.needs.food < 45 || a.needs.energy < 30 || b.needs.energy < 30) return false;
  if (a.relations.get(b.id).affection < 0.35 || b.relations.get(a.id).affection < 0.35) return false;
  const berries = (a.inventory.berry ?? 0) + (b.inventory.berry ?? 0);
  if (berries < 4) return false;

  // The egg costs two berries from each parent (or from the other if one is short).
  let need = 4;
  for (const p of [a, b, a, b]) {
    if (need > 0 && p.removeItem('berry', 1)) need--;
  }
  const home = a.homeId != null ? ctx.world.objectById(a.homeId) : b.homeId != null ? ctx.world.objectById(b.homeId) : undefined;
  const spot = freeTileNear(ctx, home ? { x: home.x, y: home.y } : a.tile);
  if (!spot) return false;

  const usedNames = new Set(ctx.agents.map((x) => x.name));
  let name = '';
  for (let i = 0; i < 20 && (!name || usedNames.has(name)); i++) name = pick(ctx.rng, SYLLABLES) + pick(ctx.rng, ENDINGS);

  const egg = new Agent(
    {
      id: nextId(),
      name,
      color: mixColor(a.color, b.color, ctx.rng),
      accessory: ctx.rng() < 0.6 ? pick(ctx.rng, [a.accessory, b.accessory]) : pick(ctx.rng, ACCESSORIES),
      personality: blendPersonality(a.personality, b.personality, ctx.rng),
    },
    spot,
    ctx.rng,
  );
  egg.stage = 'egg';
  egg.hatchTicks = Math.round(DAY_TICKS * 0.6);
  egg.parents = [a.id, b.id];
  egg.needs = { food: 80, energy: 90, health: 100 };
  // Cultural inheritance: some of the parents' recipes and a share of their knowledge.
  egg.knowledge = ((a.knowledge + b.knowledge) / 2) * 0.25;
  for (const id of new Set([...a.known, ...b.known])) if (ctx.rng() < 0.5) egg.known.add(id);
  for (const p of [a, b]) {
    egg.relations.adjust(p.id, { affection: 0.7, trust: 0.7, familiarity: 0.5 });
    p.relations.adjust(egg.id, { affection: 0.8, trust: 0.6, familiarity: 0.5 });
    p.familyCooldownDay = ctx.clock.day + 3;
    p.emotions.feel('joy', 0.4);
    p.mind.remember(`${a === p ? b.name : a.name} and I have an egg; we'll call them ${name}.`, ctx.clock);
  }
  egg.mind.longTerm = `I am ${name}, the child of ${a.name} and ${b.name}.`;
  add(egg);
  ctx.log(`🥚 ${a.name} and ${b.name} laid an egg! (${name})`, a.id);
  return true;
}

/** Golem: an LLM-free helper that gathers for its owner and crumbles when its power runs out. */
export function createGolem(owner: Agent, bp: Blueprint, ctx: SimContext, nextId: () => string, add: (agent: Agent) => void) {
  const spot = freeTileNear(ctx, owner.tile);
  if (!spot) {
    ctx.log(`${owner.name} found no room for their golem`, owner.id);
    return;
  }
  const count = ctx.agents.filter((a) => a.ownerId === owner.id).length + 1;
  const golem = new Agent(
    {
      id: nextId(),
      name: `${owner.name}-Golem${count > 1 ? count : ''}`,
      color: '#8d929c',
      accessory: 'antenna',
      personality: { curiosity: 0.3, aggression: 0.5, sociability: 0, caution: 0.2, creativity: 0, laziness: 0 },
    },
    spot,
    ctx.rng,
  );
  const autonomy = bp.components.find((c) => c.type === 'automaton')?.power ?? 1;
  golem.isGolem = true;
  golem.ownerId = owner.id;
  golem.battery = Math.round(DAY_TICKS * (1 + autonomy));
  golem.equipment = [{ blueprintId: bp.id, name: bp.name, kind: 'golem', components: bp.components, shape: 'golem', color: bp.color, uses: null }];
  golem.allies.add(owner.id);
  owner.allies.add(golem.id);
  add(golem);
  ctx.log(`🤖 ${owner.name} created a golem: ${golem.name} (lasts ${Math.round(golem.battery / DAY_TICKS)} days)`, owner.id);
  ctx.emit({ type: 'golem', owner, golem });
}

/** The golem's simple brain: protect the owner, gather what they need, deliver when full. */
export function golemTask(golem: Agent, ctx: SimContext): Task | null {
  const owner = ctx.agents.find((a) => a.id === golem.ownerId);
  if (!owner) return WanderTask.create(golem, ctx);
  const threat = owner.lastHitBy;
  if (threat && !threat.fainted && golem.bonus('damage') > 0 && Math.hypot(threat.x - golem.x, threat.y - golem.y) < 10) {
    return new AttackTask(threat, true);
  }
  if (golem.itemCount >= 4 || (!golem.hasRoom() && golem.itemCount > 0)) return new DeliverTask(owner);
  const inv = owner.inventory;
  const type = owner.needs.food < 50 || (inv.berry ?? 0) < 2 ? 'bush' : (inv.wood ?? 0) <= (inv.stone ?? 0) ? 'tree' : 'rock';
  return GatherTask.create(golem, ctx, type, 4) ?? GatherTask.create(golem, ctx, 'bush', 4) ?? WanderTask.create(golem, ctx);
}

class DeliverTask implements Task {
  readonly kind = 'follow';
  readonly label: string;
  action: AgentAction = 'walk';
  progress = null;
  private approach: Task | null = null;
  private delivered = false;

  constructor(private owner: Agent) {
    this.label = `Delivering to ${owner.name}`;
  }

  step(golem: Agent, ctx: SimContext): TaskStatus {
    if (this.delivered) return 'done';
    if (Math.hypot(this.owner.x - golem.x, this.owner.y - golem.y) > 2) {
      this.approach ??= ApproachTask.create(golem, ctx, this.owner);
      if (!this.approach) return 'failed';
      if (this.approach.step(golem, ctx) === 'running') return 'running';
      this.approach = null;
      if (Math.hypot(this.owner.x - golem.x, this.owner.y - golem.y) > 2.5) return 'running';
    }
    let moved = 0;
    for (const [item, n] of Object.entries(golem.inventory) as [keyof typeof golem.inventory, number][]) {
      const qty = Math.min(n, this.owner.capacity - this.owner.itemCount);
      if (qty <= 0) continue;
      golem.removeItem(item, qty);
      this.owner.addItem(item, qty);
      moved += qty;
    }
    if (moved) {
      golem.say('📦', 20);
      if (ctx.rng() < 0.3) ctx.log(`📦 ${golem.name} brought ${this.owner.name} ${moved} items`, this.owner.id);
    }
    this.delivered = true;
    return 'done';
  }
}

// ---------- immigration: a tribe from overseas ----------
export type Temperament = 'aggressive' | 'peaceful' | 'mixed';
const TRIBE_COLORS = ['#8e3b46', '#4a5a8c', '#6b4f2a', '#2f6b5a', '#7a3f8f', '#9c6b1f'];
const TRIBE_NAMES = ['Kor', 'Vag', 'Drak', 'Zorg', 'Grim', 'Rax', 'Bruk', 'Tav', 'Ulla', 'Sev', 'Mira', 'Jun'];

function temperamentPersonality(t: Temperament, rng: Rng): Personality {
  const r = (lo: number, hi: number) => Math.round((lo + rng() * (hi - lo)) * 100) / 100;
  const kind = t === 'mixed' ? (rng() < 0.5 ? 'aggressive' : 'peaceful') : t;
  return kind === 'aggressive'
    ? { curiosity: r(0.3, 0.7), aggression: r(0.75, 0.95), sociability: r(0.3, 0.6), caution: r(0.1, 0.3), creativity: r(0.3, 0.7), laziness: r(0.05, 0.3) }
    : { curiosity: r(0.4, 0.8), aggression: r(0.05, 0.3), sociability: r(0.6, 0.9), caution: r(0.3, 0.6), creativity: r(0.4, 0.8), laziness: r(0.1, 0.4) };
}

/** A raft reaches the shore: a tribe of mutual allies sets foot on the island. */
export function spawnImmigrants(count: number, temperament: Temperament, armed: boolean, ctx: SimContext, nextId: () => string, add: (a: Agent) => void) {
  const w = ctx.world;
  // A shore tile far from the market (walkable, next to water)
  const region = w.largestRegion();
  const market = w.market;
  const shore = region
    .map((i) => ({ x: i % w.width, y: Math.floor(i / w.width) }))
    .filter((p) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => w.isWater(p.x + dx, p.y + dy)))
    .sort((a, b) => (market ? Math.hypot(b.x - market.x, b.y - market.y) - Math.hypot(a.x - market.x, a.y - market.y) : 0));
  const landing = shore[Math.floor(ctx.rng() * Math.min(10, shore.length))];
  if (!landing) return;
  const used = new Set(ctx.agents.map((a) => a.name));
  const tribe: Agent[] = [];
  for (let i = 0; i < count; i++) {
    const spot = freeTileNear(ctx, landing);
    if (!spot) break;
    let name = TRIBE_NAMES.find((n) => !used.has(n)) ?? `${pick(ctx.rng, TRIBE_NAMES)}${i}`;
    used.add(name);
    const a = new Agent(
      { id: nextId(), name, color: TRIBE_COLORS[i % TRIBE_COLORS.length], accessory: pick(ctx.rng, ['tophat', 'antenna', 'none'] as Accessory[]), personality: temperamentPersonality(temperament, ctx.rng) },
      spot,
      ctx.rng,
    );
    a.needs = { food: 45, energy: 70, health: 100 };
    a.addItem('berry', 2);
    a.addItem('wood', 2);
    a.knowledge = 30 + ctx.rng() * 40;
    if (armed) {
      a.equipment.push({ blueprintId: 'tribe-club', name: 'Sivri Sopa', kind: 'weapon', components: [{ type: 'damage', power: 2 }], shape: 'spear', color: '#8c6040', uses: null });
    }
    add(a);
    tribe.push(a);
    name = '';
  }
  const names = tribe.map((t) => t.name).join(', ');
  for (const a of tribe) {
    for (const b of tribe) {
      if (a === b) continue;
      a.allies.add(b.id);
      a.relations.adjust(b.id, { affection: 0.7, trust: 0.7, familiarity: 0.8 });
    }
    a.mind.longTerm =
      temperament === 'peaceful'
        ? `I am ${a.name}. Together with ${names} I fled famine across the sea and came to this island. We want to build a new home and get along with the people who live here.`
        : `I am ${a.name}. Together with ${names} I fled famine across the sea and came to this island. We must establish our own land, and take it by force if needed. I am loyal to my tribe; I don't trust strangers easily.`;
    a.mind.remember('Our raft washed ashore; we just arrived on this island.', ctx.clock);
  }
  ctx.log(`⛵ A raft appeared on the horizon! ${names} set foot on the island.`);
  for (const local of ctx.agents) {
    if (tribe.includes(local) || local.isGolem) continue;
    local.mind.remember(`Strangers arrived from the sea: ${names}.`, ctx.clock);
    local.emotions.feel(temperament === 'peaceful' ? 'joy' : 'fear', 0.1 + local.personality.caution * 0.15);
  }
}
