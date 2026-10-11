import { techLevel, vehicleDurability, type Blueprint, type ComponentType, type EquipmentState } from '../shared/invention';
import { DAY_TICKS, isNight, type Accessory, type AgentAction, type AgentState, type Inventory, type ItemType, type Needs, type Personality } from '../shared/protocol';
import { systemPrompt } from './mind/perception';
import { Emotions } from './emotions';
import { Relations } from './relations';
import { knockout, type AttackTask } from './social/combat';
import type { TalkTask } from './social/conversation';
import { BALANCE } from './balance';
import { golemTask } from './evolution';
import { chooseTask } from './brain';
import type { SimContext } from './context';
import { Mind } from './mind/mind';
import { findNearest, type Mobility, type Point } from './pathfinding';
import { randInt, type Rng } from './rng';
import { EatTask, type Task } from './tasks';

export interface AgentSeed {
  id: string;
  name: string;
  color: string;
  accessory: Accessory;
  personality: Personality;
}

/**
 * The agent's "body": needs, inventory, movement and task runner.
 * What to do next is decided by the mind (LLM) or, as a fallback, by brain.ts (reflexes).
 */
export class Agent {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly accessory: Accessory;
  readonly personality: Personality;

  x: number;
  y: number;
  facing: -1 | 1 = 1;
  bubble: string | null = null;
  needs: Needs;
  inventory: Inventory = {};
  path: Point[] = [];
  task: Task | null = null;
  fainted = false;
  readonly mind: Mind;
  readonly emotions: Emotions;
  readonly relations = new Relations();
  talkCooldown = 0;
  knowledge = 0;
  readonly known = new Set<string>(); // ids of known recipes
  equipment: EquipmentState[] = [];
  homeId: number | null = null;
  flying = false;
  isGolem = false;
  readonly allies = new Set<string>();
  lastHitBy: Agent | null = null;
  lastReactTick = -Infinity;
  stage: 'egg' | 'child' | 'adult' = 'adult';
  parents: string[] = [];
  ownerId: string | null = null;
  hatchTicks = 0;
  growTicks = 0;
  battery = 0;
  familyCooldownDay = 0;
  starvationFaints = 0;
  marketCooldown = 0;
  readonly explored = new Set<number>();
  private pathNeedsFlight = false;
  swimming = false;
  insideId: number | null = null;
  private announcedFlight = false;

  private bubbleTicks = 0;
  private greetCooldown: number;
  faintTicks = 0;
  private hungerWarned = false;

  constructor(seed: AgentSeed, tile: Point, rng: Rng) {
    this.id = seed.id;
    this.name = seed.name;
    this.color = seed.color;
    this.accessory = seed.accessory;
    this.personality = seed.personality;
    this.x = tile.x + 0.5;
    this.y = tile.y + 0.5;
    this.needs = { food: randInt(rng, 60, 90), energy: randInt(rng, 70, 95), health: 100 };
    this.greetCooldown = randInt(rng, 50, 200);
    this.mind = new Mind(this);
    this.emotions = new Emotions(seed.personality);
  }

  get tile(): Point {
    return { x: Math.floor(this.x), y: Math.floor(this.y) };
  }

  get tech(): number {
    return techLevel(this.knowledge);
  }

  /** Effective power of a component across equipment: only one tool is used at a time, so the strongest counts. */
  bonus(type: ComponentType): number {
    let best = 0;
    for (const e of this.equipment) {
      if (e.kind === 'consumable') continue;
      for (const c of e.components) if (c.type === type) best = Math.max(best, c.power);
    }
    return best;
  }

  get canFly(): boolean {
    return this.bonus('flight') > 0;
  }

  get canSwim(): boolean {
    return this.bonus('swim') > 0;
  }

  get mobility(): Mobility {
    return this.canFly ? 'fly' : this.canSwim ? 'swim' : 'walk';
  }

  /** The vehicle in use (non-flying): the fastest/strongest one. */
  get vehicle(): EquipmentState | undefined {
    return this.equipment
      .filter((e) => e.kind === 'vehicle')
      .sort((a, b) => b.components.reduce((s, c) => s + c.power, 0) - a.components.reduce((s, c) => s + c.power, 0))[0];
  }

  get riding(): boolean {
    return !!this.vehicle && (this.action === 'walk' || this.action === 'attack') && !this.flying;
  }

  /** One use worth of wear on the vehicle; it breaks when worn out. */
  wearVehicle(ctx: SimContext) {
    const v = this.vehicle;
    if (!v) return;
    v.uses = (v.uses ?? vehicleDurability(v.components)) - 1;
    if (v.uses <= 0) {
      this.equipment.splice(this.equipment.indexOf(v), 1);
      this.say('💥', 25);
      ctx.log(`💥 ${this.name}'s “${v.name}” fell apart`, this.id);
    }
  }

  // ---------- ev ----------
  enter(home: { id: number }) {
    this.insideId = home.id;
    this.path = [];
    this.flying = false;
    this.swimming = false;
  }

  exit() {
    this.insideId = null;
  }

  get capacity(): number {
    return BALANCE.inventoryCapacity + 3 * this.bonus('storage');
  }

  knows(blueprintId: string): boolean {
    return this.known.has(blueprintId);
  }

  systemPrompt(): string {
    return systemPrompt(this);
  }

  /** Assigns a new path; a flyer whose path crosses water/obstacles will fly. */
  setPath(path: Point[], world: SimContext['world']) {
    this.path = path;
    this.pathNeedsFlight = this.canFly && path.some((p) => !world.isWalkable(p.x, p.y));
    if (this.insideId != null && path.length) this.exit();
    this.announcedFlight = false;
  }

  learn(bp: Blueprint, ctx: SimContext, how: string, teacher: Agent | null = null) {
    if (this.known.has(bp.id)) return;
    this.known.add(bp.id);
    ctx.log(`👀 ${this.name} learned the “${bp.name}” recipe ${how}`, this.id);
    this.emotions.feel('joy', 0.08);
    this.gainKnowledge(8, ctx);
    ctx.emit({ type: 'learned', agent: this, blueprint: bp, teacher });
  }

  gainKnowledge(n: number, ctx: SimContext) {
    const before = this.tech;
    this.knowledge += n;
    const after = this.tech;
    if (after > before) {
      ctx.log(`🎓 ${this.name} reached tech level ${after}!`, this.id);
      this.emotions.feel('pride', 0.2);
      ctx.emit({ type: 'tech_up', agent: this, level: after });
    }
  }

  get action(): AgentAction {
    if (this.stage === 'egg') return 'sleep';
    return this.fainted ? 'sleep' : (this.task?.action ?? 'idle');
  }

  say(text: string, ticks = 25) {
    this.bubble = text;
    this.bubbleTicks = ticks;
  }

  step(ctx: SimContext) {
    if (this.bubbleTicks > 0 && --this.bubbleTicks === 0) this.bubble = null;
    if (this.stage === 'egg') {
      if (--this.hatchTicks <= 0) this.hatch(ctx);
      return;
    }
    if (this.isGolem) {
      this.golemStep(ctx);
      return;
    }
    if (this.stage === 'child' && --this.growTicks <= 0) {
      this.stage = 'adult';
      ctx.log(`🌱 ${this.name} has grown up!`, this.id);
    }
    if (this.greetCooldown > 0) this.greetCooldown--;
    if (this.talkCooldown > 0) this.talkCooldown--;
    if (this.marketCooldown > 0) this.marketCooldown--;
    this.updateNeeds(ctx);
    const alone = !ctx.agents.some(
      (a) => a !== this && a.action !== 'sleep' && Math.hypot(a.x - this.x, a.y - this.y) < 6,
    );
    this.emotions.tick(alone && this.action !== 'sleep');

    if (this.fainted) {
      if (--this.faintTicks <= 0) {
        this.fainted = false;
        this.needs.health = 30;
        this.say('😵‍💫', 30);
        ctx.log(`${this.name} kendine geldi`, this.id);
        ctx.emit({ type: 'recovered', agent: this });
      }
      return;
    }

    this.useHealingIfNeeded(ctx);
    if (this.task && this.mustInterrupt(ctx)) this.task = null;
    // Hunger reflex: low fullness and food in the bag → eat right away, no deliberation.
    if (this.needs.food < BALANCE.food.hungryAt && this.inventory.berry && this.task?.kind !== 'eat' && this.task?.kind !== 'flee') {
      this.task = new EatTask();
    }
    if (!this.task) this.task = this.mind.nextTask(ctx) ?? chooseTask(this, ctx);
    // Leave the house when starting something that isn't done indoors, or if the house is gone.
    if (this.insideId != null) {
      const home = ctx.world.objectById(this.insideId);
      if (!home || !['sleep', 'rest', 'think'].includes(this.task.kind)) this.exit();
    }
    const current = this.task;
    // The task may have assigned a new task this step (e.g. starting a chat on arrival) — don't clear it.
    if (current.step(this, ctx) !== 'running' && this.task === current) this.task = null;

    if (this.action !== 'sleep' && this.insideId == null) this.tryGreet(ctx);
  }

  /** Moves one step along the path; returns true on arrival. */
  moveAlongPath(ctx?: SimContext): boolean {
    const next = this.path[0];
    if (!next) {
      this.flying = false;
      this.swimming = false;
      return true;
    }
    this.flying = this.pathNeedsFlight;
    if (ctx) this.swimming = !this.flying && ctx.world.isWater(next.x, next.y);
    if (this.flying && !this.announcedFlight && ctx) {
      this.announcedFlight = true;
      this.say('🕊️', 25);
      if (ctx.rng() < 0.3) ctx.log(`🕊️ ${this.name} took off!`, this.id);
      ctx.emit({ type: 'flew', agent: this });
    }
    const tx = next.x + 0.5;
    const ty = next.y + 0.5;
    const dx = tx - this.x;
    const dy = ty - this.y;
    const dist = Math.hypot(dx, dy);
    // Tired or sad agents walk slower, happy ones a little faster.
    const e = this.emotions.values;
    const mood = 1 - e.sadness * 0.3 + e.joy * 0.1 + e.fear * 0.15;
    const gear = (1 + 0.15 * this.bonus('speed')) * (this.flying ? 1.3 + 0.1 * this.bonus('flight') : 1);
    const speed = (this.stage === 'child' ? 0.8 : 1) * (0.045 + this.personality.curiosity * 0.02) * (this.needs.energy < 20 ? 0.6 : 1) * mood * gear;
    if (Math.abs(dx) > 0.01) this.facing = dx > 0 ? 1 : -1;
    if (dist <= speed) {
      this.x = tx;
      this.y = ty;
      this.path.shift();
      if (ctx) this.markExplored(ctx);
    } else {
      this.x += (dx / dist) * speed;
      this.y += (dy / dist) * speed;
    }
    return this.path.length === 0;
  }

  // ---------- envanter ----------
  get itemCount(): number {
    return Object.values(this.inventory).reduce((s, n) => s + (n ?? 0), 0);
  }
  hasRoom(): boolean {
    return this.itemCount < this.capacity;
  }

  private hatch(ctx: SimContext) {
    this.stage = 'child';
    this.growTicks = DAY_TICKS;
    this.say('🐣', 40);
    this.emotions.feel('joy', 0.5);
    const parents = this.parents.map((id) => ctx.agents.find((a) => a.id === id)).filter((a): a is Agent => !!a);
    ctx.log(`🐣 An egg hatched! ${this.name} was born`, this.id);
    for (const p of parents) p.mind.remember(`Our little one ${this.name} hatched!`, ctx.clock);
    if (parents.length === 2) ctx.emit({ type: 'born', child: this, parents: [parents[0], parents[1]] });
  }

  private golemStep(ctx: SimContext) {
    if (--this.battery <= 0 || this.needs.health <= 0) {
      ctx.removeAgent(this, this.needs.health <= 0 ? 'crumbled' : 'ran out of power and returned to the earth');
      return;
    }
    if (!this.task) this.task = golemTask(this, ctx);
    const current = this.task;
    if (current && current.step(this, ctx) !== 'running' && this.task === current) this.task = null;
  }

  /** Stepping on a tile for the first time earns knowledge (curiosity = learning). */
  private markExplored(ctx: SimContext) {
    const i = this.tile.y * ctx.world.width + this.tile.x;
    if (this.explored.has(i)) return;
    this.explored.add(i);
    this.gainKnowledge(0.4, ctx);
    if (this.explored.size % 50 === 0) ctx.emit({ type: 'explored', agent: this, ratio: this.explored.size / ctx.world.landTiles });
  }

  private useHealingIfNeeded(ctx: SimContext) {
    if (this.needs.health >= 55) return;
    const potion = this.equipment.find((e) => e.kind === 'consumable' && e.components.some((c) => c.type === 'heal'));
    if (!potion) return;
    const power = potion.components.find((c) => c.type === 'heal')!.power;
    this.needs.health = Math.min(100, this.needs.health + 25 * power);
    potion.uses = (potion.uses ?? 1) - 1;
    if (potion.uses <= 0) this.equipment.splice(this.equipment.indexOf(potion), 1);
    this.say('❤️‍🩹', 30);
    ctx.log(`❤️‍🩹 ${this.name} healed with “${potion.name}”`, this.id);
    ctx.emit({ type: 'healed', agent: this });
  }
  addItem(item: ItemType, n = 1) {
    this.inventory[item] = (this.inventory[item] ?? 0) + n;
  }
  removeItem(item: ItemType, n = 1): boolean {
    const have = this.inventory[item] ?? 0;
    if (have < n) return false;
    if (have === n) delete this.inventory[item];
    else this.inventory[item] = have - n;
    return true;
  }

  /** Makes room in a full bag: drops one of the most plentiful items other than `keep`. */
  dropLeastUseful(keep: ItemType): ItemType | null {
    const candidates = (Object.entries(this.inventory) as [ItemType, number][]).filter(([k, n]) => k !== keep && n > 0);
    if (!candidates.length) return null;
    const [item] = candidates.sort((a, b) => b[1] - a[1])[0];
    this.removeItem(item);
    return item;
  }

  musings(): string[] {
    const p = this.personality;
    const pool = ['🌸', '♪'];
    if (p.curiosity > 0.5) pool.push('?', '🔍');
    if (p.creativity > 0.5) pool.push('💡', '✨');
    if (p.laziness > 0.5) pool.push('…', '🥱');
    if (p.aggression > 0.6) pool.push('💢');
    if (p.sociability > 0.6) pool.push('♥');
    return pool;
  }

  serialize() {
    return {
      id: this.id, name: this.name, color: this.color, accessory: this.accessory, personality: this.personality,
      x: this.x, y: this.y, facing: this.facing, needs: this.needs, inventory: this.inventory,
      fainted: this.fainted, faintTicks: this.faintTicks, knowledge: this.knowledge, known: [...this.known],
      equipment: this.equipment, homeId: this.homeId, allies: [...this.allies], isGolem: this.isGolem,
      stage: this.stage, parents: this.parents, ownerId: this.ownerId, hatchTicks: this.hatchTicks,
      growTicks: this.growTicks, battery: this.battery, familyCooldownDay: this.familyCooldownDay,
      starvationFaints: this.starvationFaints,
      insideId: this.insideId,
      explored: [...this.explored], emotions: { ...this.emotions.values }, relations: this.relations.entries(),
      mind: this.mind.serialize(),
    };
  }

  static restore(d: ReturnType<Agent['serialize']>, rng: Rng): Agent {
    const a = new Agent(d, { x: 0, y: 0 }, rng);
    Object.assign(a, {
      x: d.x, y: d.y, facing: d.facing, needs: d.needs, inventory: d.inventory, fainted: d.fainted,
      faintTicks: d.faintTicks, knowledge: d.knowledge, equipment: d.equipment, homeId: d.homeId,
      isGolem: d.isGolem, stage: d.stage, parents: d.parents, ownerId: d.ownerId, hatchTicks: d.hatchTicks,
      growTicks: d.growTicks, battery: d.battery, familyCooldownDay: d.familyCooldownDay,
      starvationFaints: d.starvationFaints ?? 0,
      insideId: d.insideId ?? null,
    });
    // Give durability to vehicles from old saves.
    for (const e of a.equipment) if (e.kind === 'vehicle' && e.uses == null) e.uses = vehicleDurability(e.components);
    d.known.forEach((k) => a.known.add(k));
    d.allies.forEach((k) => a.allies.add(k));
    d.explored.forEach((k) => a.explored.add(k));
    Object.assign(a.emotions.values, d.emotions);
    a.relations.restore(d.relations);
    a.mind.restore(d.mind);
    return a;
  }

  get talkingWith(): Agent | null {
    return this.task?.kind === 'talk' ? (this.task as TalkTask).conv.partnerOf(this) : null;
  }

  toState(names: Map<string, string>, blueprints: Map<string, Blueprint>, achievements: string[], enemies: string[]): AgentState {
    const r = (n: number) => Math.round(n * 10) / 10;
    return {
      id: this.id,
      name: this.name,
      color: this.color,
      accessory: this.accessory,
      personality: this.personality,
      x: Math.round(this.x * 1000) / 1000,
      y: Math.round(this.y * 1000) / 1000,
      facing: this.facing,
      action: this.action,
      task: this.fainted ? 'Unconscious' : (this.task?.label ?? 'Thinking'),
      progress: this.task?.progress != null ? Math.min(1, Math.round(this.task.progress * 100) / 100) : null,
      bubble: this.bubble,
      needs: { food: r(this.needs.food), energy: r(this.needs.energy), health: r(this.needs.health) },
      inventory: { ...this.inventory },
      fainted: this.fainted,
      mind: this.mind.toState(),
      emotions: this.emotions.snapshot(),
      mood: this.emotions.mood,
      relations: this.relations.snapshot(names),
      talkingWith: this.talkingWith?.id ?? null,
      tech: this.tech,
      knowledge: Math.floor(this.knowledge),
      equipment: this.equipment,
      known: [...this.known].map((id) => blueprints.get(id)?.name ?? id),
      homeId: this.homeId,
      flying: this.flying,
      light: this.bonus('light'),
      allies: [...this.allies],
      achievements,
      insideId: this.insideId,
      riding: this.riding,
      swimming: this.swimming,
      enemies,
      stage: this.stage,
      isGolem: this.isGolem,
      ownerId: this.ownerId,
      parents: this.parents,
      hatchProgress: this.stage === 'egg' ? 1 - this.hatchTicks / (DAY_TICKS * 0.6) : null,
      fighting: this.task?.kind === 'attack' && 'target' in this.task ? (this.task as AttackTask).target.id : null,
    };
  }

  // ---------- internals ----------
  private updateNeeds(ctx: SimContext) {
    const n = this.needs;
    const action = this.action;
    const { food, energy, health } = BALANCE;
    const asleep = action === 'sleep';

    n.food = Math.max(0, n.food - (asleep ? food.decaySleep : food.decayAwake));
    // Sleeping at your own home is more restful and reassuring.
    const home = this.homeId != null ? ctx.world.objectById(this.homeId) : undefined;
    const atHome = home && Math.hypot(home.x + 0.5 - this.x, home.y + 0.5 - this.y) < 2.2;
    const shelter = atHome ? (home.structure?.shelter ?? 0) : 0;
    if (asleep) {
      n.energy = Math.min(100, n.energy + energy.regenSleep * (1 + 0.3 * shelter));
      if (shelter) this.emotions.feel('fear', -0.001 * shelter);
    }
    else n.energy = Math.max(0, n.energy - (action === 'idle' ? energy.decayIdle : energy.decayActive));

    // Wandering in the dark without a light is unsettling.
    if (!asleep && isNight(ctx.clock.timeOfDay) && this.bonus('light') === 0) this.emotions.feel('fear', 0.0002 * (0.5 + this.personality.caution));
    if (n.food <= 0) n.health -= health.starveLoss;
    if (n.energy <= 0) n.health -= health.exhaustLoss;
    if (n.food > 40 && n.energy > 20) n.health += health.regen;
    if (n.health > 60) this.lastHitBy = null;
    n.health = Math.min(100, Math.max(0, n.health));

    // Hungry, aggressive temperaments get angry.
    if (n.food < 35 && this.personality.aggression > 0.6) this.emotions.feel('anger', 0.0008 * this.personality.aggression);
    if (n.food < food.hungryAt && !this.hungerWarned) {
      this.hungerWarned = true;
      this.emotions.feel('sadness', 0.1);
      this.say('🍽️', 30);
      ctx.log(`${this.name} is hungry`, this.id);
    } else if (n.food > 50) {
      this.hungerWarned = false;
    }
    if (n.food > 30) this.starvationFaints = 0;

    if (n.health <= 0 && !this.fainted) {
      this.fainted = true;
      this.faintTicks = BALANCE.faintTicks;
      this.task = null;
      this.path = [];
      this.flying = false;
      this.say('😵', 40);
      ctx.emit({ type: 'fainted', agent: this });
      this.emotions.feel('fear', 0.6);
      this.emotions.feel('sadness', 0.3);
      if (this.lastHitBy && !this.lastHitBy.fainted) knockout(this, this.lastHitBy, ctx);
      else if (n.food <= 0 && BALANCE.permadeath && ++this.starvationFaints >= BALANCE.starvationFaintsToDie) {
        ctx.killAgent(this, 'of starvation');
        return;
      } else {
        ctx.log(`${this.name} fainted from ${n.food <= 0 ? 'hunger' : 'exhaustion'}!${n.food <= 0 && BALANCE.permadeath ? ' Next time may be fatal…' : ''}`, this.id);
        if (n.food <= 0) this.mind.remember("I fainted from hunger. If I don't find food right away, I will die.", ctx.clock);
      }
      this.lastHitBy = null;
    }
  }

  /** Urgent needs interrupt the current task (e.g. a starving agent stops chopping wood). */
  private foodCheckTick = -Infinity;
  private foodReachable = true;

  /** Is there food in the bag or on a reachable bush? (expensive search; cached for 60 ticks) */
  private canFindFood(ctx: SimContext): boolean {
    if (this.inventory.berry) return true;
    if (ctx.clock.tick - this.foodCheckTick > 60) {
      this.foodCheckTick = ctx.clock.tick;
      this.foodReachable = !!findNearest(ctx.world, this.tile, BALANCE.senseRadius, (o) => o.type === 'bush' && o.amount > 0, this.mobility);
    }
    return this.foodReachable;
  }

  private mustInterrupt(ctx: SimContext): boolean {
    const t = this.task!;
    if (t.kind === 'flee' || (t.kind === 'attack' && this.needs.food > 5)) return false;
    // Hunger only interrupts if food is actually reachable (or the task is idle) — otherwise it would loop.
    if (this.needs.food < BALANCE.food.urgentAt && t.satisfies !== 'food') {
      if (this.canFindFood(ctx)) return true;
      return t.kind === 'rest' || t.kind === 'wander';
    }
    if (this.needs.energy < BALANCE.energy.exhaustedAt && t.satisfies !== 'energy' && t.satisfies !== 'food') return true;
    return false;
  }

  private tryGreet(ctx: SimContext) {
    if (this.greetCooldown > 0) return;
    const other = ctx.agents.find(
      (a) => a !== this && !a.isGolem && a.insideId == null && a.action !== 'sleep' && a.greetCooldown <= 0 && Math.hypot(a.x - this.x, a.y - this.y) < 1.6,
    );
    if (!other || ctx.rng() > this.personality.sociability * 0.08) return;

    this.say('👋');
    other.say(other.personality.sociability > 0.4 ? '😊' : '😐');
    this.facing = other.x > this.x ? 1 : -1;
    other.facing = this.x > other.x ? 1 : -1;
    this.greetCooldown = randInt(ctx.rng, 400, 800);
    other.greetCooldown = randInt(ctx.rng, 400, 800);
    ctx.log(`${this.name} waved at ${other.name}`, this.id);
    other.mind.remember(`${this.name} waved at me`, ctx.clock);
    for (const [x, y] of [[this, other], [other, this]] as const) {
      x.emotions.feel('joy', 0.08);
      x.emotions.feel('loneliness', -0.25);
      x.relations.adjust(y.id, { familiarity: 0.05, affection: 0.03 });
    }
    // Sociable pairs may go beyond a wave and start chatting.
    const sociable = (this.personality.sociability + other.personality.sociability) / 2;
    if (ctx.rng() < sociable * 0.6) ctx.startConversation(this, other, null);
  }
}
