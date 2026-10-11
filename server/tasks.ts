import { ITEMS, isNight, type AgentAction, type TaskKind, type WorldObject } from '../shared/protocol';
import type { Agent } from './agent';
import { BALANCE, RESOURCES, type ResourceType } from './balance';
import type { SimContext } from './context';
import type { Direction } from './mind/decision';
import { explore, findNearest } from './pathfinding';
import { onHarvest } from './social/territory';
import { pick, randInt } from './rng';

export type TaskStatus = 'running' | 'done' | 'failed';

/**
 * Tasks are the concrete things an agent can do. The LLM mind picks them through structured decisions;
 * the reflex brain picks them when the mind is unavailable.
 */
export interface Task {
  readonly kind: TaskKind;
  readonly label: string;
  /** Which urgent need this task serves — so it isn't interrupted for that need. */
  readonly satisfies?: 'food' | 'energy';
  action: AgentAction;
  progress: number | null;
  step(agent: Agent, ctx: SimContext): TaskStatus;
}

export class WanderTask implements Task {
  readonly kind = 'wander';
  action: AgentAction = 'walk';
  progress = null;
  satisfies?: 'food';

  /** When no food is nearby: wander far in search of food (hunger won't interrupt this). */
  static searchFood(agent: Agent, ctx: SimContext): WanderTask | null {
    const t = WanderTask.create(agent, ctx, 'any', 22);
    if (!t) return null;
    t.satisfies = 'food';
    t.label = 'Searching for food';
    return t;
  }

  static create(agent: Agent, ctx: SimContext, direction: Direction = 'any', minRadius = 0): WanderTask | null {
    const directed = direction !== 'any';
    const radius = Math.max(minRadius, Math.round((directed ? 6 : 3) + agent.personality.curiosity * 9));
    const explored = explore(ctx.world, agent.tile, radius, agent.mobility);
    const pathTo = explored.pathTo;
    // Flyers may cross water but always land on ground.
    const reachable = explored.reachable.filter((i) => ctx.world.isWalkable(i % ctx.world.width, Math.floor(i / ctx.world.width)));
    if (!reachable.length) return null;
    // Search walks prefer far-away points.
    let target = minRadius
      ? pick(ctx.rng, reachable.slice(Math.floor(reachable.length * 0.6)))
      : pick(ctx.rng, reachable);
    if (directed) {
      // Pick one of the tiles that advance furthest in the requested direction.
      const [vx, vy] = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[direction];
      const { width } = ctx.world;
      const ranked = reachable
        .map((i) => ({ i, score: ((i % width) - agent.tile.x) * vx + (Math.floor(i / width) - agent.tile.y) * vy }))
        .sort((a, b) => b.score - a.score);
      if (ranked[0].score <= 0) return null;
      target = pick(ctx.rng, ranked.slice(0, 6)).i;
    }
    agent.setPath(pathTo(target), ctx.world);
    return new WanderTask(directed ? `Exploring ${direction}` : undefined);
  }

  label: string;
  constructor(label?: string) {
    this.label = label ?? 'Exploring';
  }

  step(agent: Agent, ctx: SimContext): TaskStatus {
    if (!agent.moveAlongPath(ctx)) return 'running';
    if (agent.vehicle) agent.wearVehicle(ctx);
    return 'done';
  }

  /** A long joyride with the vehicle. */
  static joyride(agent: Agent, ctx: SimContext): WanderTask | null {
    if (!agent.vehicle) return null;
    const t = WanderTask.create(agent, ctx, 'any', 20);
    if (!t) return null;
    t.label = `Riding the ${agent.vehicle.name}`;
    agent.emotions.feel('joy', 0.15);
    ctx.emit({ type: 'rode', agent });
    return t;
  }
}

export class RestTask implements Task {
  readonly kind = 'rest';
  readonly label: string;
  action: AgentAction = 'idle';
  progress = null;

  constructor(
    private ticks: number,
    label = 'Resting',
  ) {
    this.label = label;
  }

  step(agent: Agent, ctx: SimContext): TaskStatus {
    if (!agent.bubble && ctx.rng() < 0.003) agent.say(pick(ctx.rng, agent.musings()));
    return --this.ticks <= 0 ? 'done' : 'running';
  }
}

export class SleepTask implements Task {
  readonly kind = 'sleep';
  readonly satisfies = 'energy';
  readonly label: string;
  action: AgentAction = 'sleep';
  progress = null;
  private started = false;

  constructor(private nap: boolean) {
    this.label = nap ? 'Napping' : 'Sleeping';
  }

  step(agent: Agent, ctx: SimContext): TaskStatus {
    if (!this.started) {
      this.started = true;
      agent.path = [];
      agent.bubble = null;
      ctx.log(this.nap ? `${agent.name} is tired and takes a nap` : `${agent.name} fell asleep`, agent.id);
      // Night sleep: the moment to reflect on the day and write long-term memory.
      if (!this.nap) agent.mind.reflect(ctx);
    }
    const { energy } = agent.needs;
    // Night sleep lasts until morning; a nap ends once energy is restored.
    const awake = this.nap
      ? energy >= 85
      : !isNight(ctx.clock.timeOfDay) && (energy >= 100 || (energy >= 50 && ctx.rng() < 0.01 * (1.5 - agent.personality.laziness)));
    if (!awake) return 'running';
    agent.say('☀️', 30);
    agent.emotions.feel('joy', 0.08);
    ctx.log(`${agent.name} woke up`, agent.id);
    return 'done';
  }
}

export class EatTask implements Task {
  readonly kind = 'eat';
  readonly satisfies = 'food';
  readonly label = 'Eating';
  action: AgentAction = 'eat';
  progress = 0;
  private ticks = 0;

  step(agent: Agent, ctx: SimContext): TaskStatus {
    if (!agent.inventory.berry) return 'failed';
    this.progress = ++this.ticks / BALANCE.eatTicks;
    if (this.ticks < BALANCE.eatTicks) return 'running';
    agent.removeItem('berry');
    ctx.emit({ type: 'berries', kind: 'eaten', qty: 1 });
    agent.emotions.feel('joy', agent.needs.food < 40 ? 0.15 : 0.04);
    agent.needs.food = Math.min(100, agent.needs.food + BALANCE.food.perBerry);
    agent.say('😋', 15);
    if (ctx.rng() < 0.15) ctx.log(`${agent.name} happily ate a berry`, agent.id);
    return 'done';
  }
}

export class GatherTask implements Task {
  readonly kind = 'gather';
  readonly label: string;
  readonly satisfies?: 'food';
  action: AgentAction = 'walk';
  progress: number | null = null;
  private phase: 'move' | 'work' = 'move';
  private work = 0;
  private collected = 0;

  static create(agent: Agent, ctx: SimContext, type: ResourceType, want: number): GatherTask | null {
    const found = findNearest(ctx.world, agent.tile, BALANCE.senseRadius, (o) => o.type === type && o.amount > 0, agent.mobility);
    if (!found) return null;
    agent.setPath(found.path, ctx.world);
    return new GatherTask(found.obj, want);
  }

  private constructor(private obj: WorldObject, private want: number) {
    this.label = RESOURCES[obj.type as ResourceType].doing;
    if (obj.type === 'bush') this.satisfies = 'food';
  }

  step(agent: Agent, ctx: SimContext): TaskStatus {
    const res = RESOURCES[this.obj.type as ResourceType];
    if (this.phase === 'move') {
      if (this.obj.amount <= 0) return 'failed'; // someone else got there first
      if (!agent.moveAlongPath(ctx)) return 'running';
      this.phase = 'work';
      this.action = 'gather';
      agent.facing = this.obj.x + 0.5 > agent.x ? 1 : -1;
    }

    if (!agent.hasRoom() && this.satisfies === 'food') {
      const dropped = agent.dropLeastUseful(res.item);
      if (dropped) ctx.log(`${agent.name} dropped 1 ${ITEMS[dropped].name.toLowerCase()} to make room`, agent.id);
    }
    if (this.obj.amount <= 0 || !agent.hasRoom()) return this.finish(agent, ctx);
    const workTicks = Math.round(res.workTicks / (1 + 0.35 * agent.bonus('harvest')));
    this.progress = ++this.work / workTicks;
    if (this.work < workTicks) return 'running';

    this.work = 0;
    if (ctx.world.harvest(this.obj)) {
      agent.addItem(res.item);
      if (res.item === 'berry') ctx.emit({ type: 'berries', kind: 'harvested', qty: 1 });
      onHarvest(agent, this.obj, res.item, ctx);
      this.collected++;
      agent.say(`+${ITEMS[res.item].emoji}`, 12);
      if (res.bonus && ctx.rng() < res.bonus.chance && agent.hasRoom()) agent.addItem(res.bonus.item);
    }
    return this.collected >= this.want ? this.finish(agent, ctx) : 'running';
  }

  private finish(agent: Agent, ctx: SimContext): TaskStatus {
    if (this.collected === 0) {
      agent.emotions.feel('anger', 0.05 + agent.personality.aggression * 0.08);
      return 'failed';
    }
    agent.emotions.feel('pride', 0.03 * this.collected);
    const res = RESOURCES[this.obj.type as ResourceType];
    ctx.log(`${agent.name} ${res.did} (${this.collected} ${ITEMS[res.item].emoji})`, agent.id);
    return 'done';
  }
}

/** While waiting for the LLM: the agent stands and thinks (💭). */
export class ThinkTask implements Task {
  readonly kind = 'think';
  readonly label = 'Thinking…';
  action: AgentAction = 'idle';
  progress = null;
  private ticks = 0;
  private startedAt = Date.now();

  constructor(private ready: () => boolean) {}

  step(agent: Agent): TaskStatus {
    if (this.ticks++ === 0) agent.say('💭', 600);
    // Stop once the reply arrived or it took too long (real time or ticks) — reflexes take over.
    const done = this.ready() || Date.now() - this.startedAt > 10_000 || this.ticks > 600;
    if (done && agent.bubble === '💭') agent.bubble = null;
    return done ? 'done' : 'running';
  }
}

/** Walks over to another inhabitant. */
export class ApproachTask implements Task {
  readonly kind = 'approach';
  readonly label: string;
  action: AgentAction = 'walk';
  progress = null;

  static create(agent: Agent, ctx: SimContext, target: Agent, onArrive?: () => void): ApproachTask | null {
    const { reachable, pathTo } = explore(ctx.world, agent.tile, 40, agent.mobility);
    const { width } = ctx.world;
    let best = -1;
    let bestD = Infinity;
    for (const i of reachable) {
      if (!ctx.world.isWalkable(i % width, Math.floor(i / width))) continue;
      const d = Math.hypot((i % width) + 0.5 - target.x, Math.floor(i / width) + 0.5 - target.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0 || bestD > 3) return null;
    agent.setPath(pathTo(best), ctx.world);
    return new ApproachTask(target, onArrive);
  }

  private constructor(
    private target: Agent,
    private onArrive?: () => void,
  ) {
    this.label = `Going to ${target.name}`;
  }

  step(agent: Agent, ctx: SimContext): TaskStatus {
    if (!agent.moveAlongPath(ctx)) return 'running';
    agent.facing = this.target.x > agent.x ? 1 : -1;
    this.onArrive?.();
    return 'done';
  }
}

/** Returns home; falls asleep on arrival if asked to. */
export class GoHomeTask implements Task {
  readonly kind = 'wander';
  readonly label = 'Heading home';
  readonly satisfies = 'energy';
  action: AgentAction = 'walk';
  progress = null;

  static create(agent: Agent, ctx: SimContext, thenSleep: boolean): GoHomeTask | null {
    if (agent.homeId == null) return null;
    const home = ctx.world.objectById(agent.homeId);
    if (!home) {
      agent.homeId = null;
      return null;
    }
    if (Math.hypot(home.x + 0.5 - agent.x, home.y + 0.5 - agent.y) < 2.2) return new GoHomeTask(thenSleep);
    const found = findNearest(ctx.world, agent.tile, 60, (o) => o.id === home.id, agent.mobility);
    if (!found) return null;
    agent.setPath(found.path, ctx.world);
    return new GoHomeTask(thenSleep);
  }

  private constructor(private thenSleep: boolean) {}

  step(agent: Agent, ctx: SimContext): TaskStatus {
    if (!agent.moveAlongPath(ctx)) return 'running';
    // If it's a shelter, go inside: indoors you are safe from attacks and theft.
    const home = agent.homeId != null ? ctx.world.objectById(agent.homeId) : undefined;
    if (home && (home.structure?.shelter ?? 0) > 0) agent.enter(home);
    agent.task = this.thenSleep
      ? new SleepTask(!isNight(ctx.clock.timeOfDay))
      : new RestTask(80 + Math.round(agent.personality.laziness * 120), home ? 'Resting at home' : 'Resting');
    return 'done';
  }
}

export const restFor = (ctx: SimContext, laziness: number) => new RestTask(randInt(ctx.rng, 20, 60 + Math.round(laziness * 120)));
