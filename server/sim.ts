import type { Blueprint } from '../shared/invention';
import { DAY_TICKS, type Accessory, type LogEvent, type Personality, type WorldClock } from '../shared/protocol';
import { AchievementTracker } from './achievements';
import { Market } from './economy/market';
import { EconomyTracker } from './economy/stats';
import { Wars } from './social/war';
import type { SimEvent } from './events';
import { Agent, type AgentSeed } from './agent';
import type { SimContext } from './context';
import type { LLMGateway } from './mind/gateway';
import { MAX_POPULATION, createGolem, spawnImmigrants, startFamily, type Temperament } from './evolution';
import { Conversation, TalkTask } from './social/conversation';
import { mulberry32, shuffle, type Rng } from './rng';
import { World, generateWorld } from './world';

const ROSTER: { name: string; color: string; accessory: Accessory }[] = [
  { name: 'Pip', color: '#D97757', accessory: 'none' },
  { name: 'Miso', color: '#5BA8A0', accessory: 'sprout' },
  { name: 'Tofu', color: '#9C80D6', accessory: 'tophat' },
  { name: 'Nori', color: '#E8B54A', accessory: 'antenna' },
  { name: 'Kiki', color: '#E37FA6', accessory: 'bow' },
  { name: 'Bobo', color: '#6B9BD8', accessory: 'flower' },
];

export type SavedSim = ReturnType<Simulation['serialize']>;

const DAY_START = Math.round(DAY_TICKS * 0.3); // start at 07:12
const MAX_EVENTS = 200;

function randomPersonality(rng: Rng): Personality {
  const trait = () => Math.round(rng() * 100) / 100;
  return {
    curiosity: trait(),
    aggression: trait(),
    sociability: trait(),
    caution: trait(),
    creativity: trait(),
    laziness: trait(),
  };
}

export class Simulation {
  readonly seed: number;
  readonly world: World;
  readonly agents: Agent[] = [];
  readonly events: LogEvent[] = [];
  readonly conversations: Conversation[] = [];
  readonly blueprints = new Map<string, Blueprint>();
  private newBlueprints: Blueprint[] = [];
  private listeners: ((e: SimEvent, ctx: SimContext) => void)[] = [];
  readonly achievements = new AchievementTracker();
  readonly market = new Market();
  readonly economy = new EconomyTracker();
  readonly wars = new Wars();
  private lastDay = 0;
  tick = 0;
  speed = 1;

  private readonly rng: Rng;
  private pending: LogEvent[] = [];
  private nextEventId = 1;

  constructor(seed: number, readonly llm: LLMGateway, saved?: SavedSim) {
    this.seed = seed;
    this.onEvent((e, ctx) => this.achievements.handle(e, ctx));
    this.onEvent((e) => this.economy.handle(e));
    if (saved) {
      // Resuming from a save: the RNG stream isn't saved, so it's reseeded from the tick.
      this.rng = mulberry32((seed ^ saved.tick) >>> 0);
      this.world = new World(saved.world);
      this.world.scarcity = saved.scarcity ?? this.world.scarcity;
      this.speed = saved.speed ?? 1; // a paused world stays paused after a restart
      this.tick = saved.tick;
      this.agentCounter = saved.agentCounter;
      this.nextEventId = saved.nextEventId;
      this.events.push(...saved.events);
      for (const bp of saved.blueprints) this.blueprints.set(bp.id, bp);
      for (const a of saved.agents) this.agents.push(Agent.restore(a, this.rng));
      this.achievements.restore(saved.achievements);
      if (saved.market) this.market.restore(saved.market);
      if (saved.economy) this.economy.restore(saved.economy);
      if (saved.wars) this.wars.restore(saved.wars);
      this.world.ensureMarket();
      this.lastDay = this.clock.day;
      this.log(`📂 Save loaded — Day ${this.clock.day}, ${this.agents.length} inhabitants.`);
      return;
    }
    this.rng = mulberry32(seed ^ 0x9e3779b9);
    this.world = generateWorld(seed);

    const spawnTiles = shuffle(this.rng, this.world.largestRegion());
    ROSTER.forEach((entry, i) => {
      const idx = spawnTiles[i * 7 % spawnTiles.length];
      const tile = { x: idx % this.world.width, y: Math.floor(idx / this.world.width) };
      const seedData: AgentSeed = { id: `a${i + 1}`, ...entry, personality: randomPersonality(this.rng) };
      this.agents.push(new Agent(seedData, tile, this.rng));
    });
    this.world.ensureMarket();
    this.log(`Aquarium created (seed ${seed}). ${this.agents.length} inhabitants are waking up.`);
  }

  serialize() {
    return {
      seed: this.seed,
      tick: this.tick,
      day: this.clock.day,
      world: this.world.map,
      agents: this.agents.map((a) => a.serialize()),
      blueprints: [...this.blueprints.values()],
      events: this.events,
      nextEventId: this.nextEventId,
      agentCounter: this.agentCounter,
      scarcity: this.world.scarcity,
      speed: this.speed,
      market: this.market.serialize(),
      economy: this.economy.serialize(),
      wars: this.wars.serialize(),
      achievements: this.achievements.serialize(),
    };
  }

  static restore(data: SavedSim, llm: LLMGateway): Simulation {
    return new Simulation(data.seed, llm, data);
  }

  get clock(): WorldClock {
    const t = this.tick + DAY_START;
    return {
      tick: this.tick,
      day: Math.floor(t / DAY_TICKS) + 1,
      timeOfDay: (t % DAY_TICKS) / DAY_TICKS,
      speed: this.speed,
    };
  }

  step() {
    this.tick++;
    const ctx = this.makeCtx();
    if (ctx.clock.day !== this.lastDay) {
      if (this.lastDay) this.achievements.daily(this.agents, ctx);
      this.lastDay = ctx.clock.day;
    }
    this.world.tick();
    for (const agent of [...this.agents]) agent.step(ctx);
    for (const c of this.conversations) c.step(ctx);
    this.market.tick(ctx);
    this.wars.tick(ctx);
    this.economy.tick(this.tick, ctx.clock.day, this.agents, this.world, this.market, this.rng, ctx.emit);
    for (let i = this.conversations.length - 1; i >= 0; i--) if (this.conversations[i].done) this.conversations.splice(i, 1);
  }

  /** Simulation context for this tick (also usable by tests and tools). */
  makeCtx(): SimContext {
    const ctx: SimContext = {
      world: this.world,
      agents: this.agents,
      rng: this.rng,
      clock: this.clock,
      llm: this.llm,
      log: (text, agentId) => this.log(text, agentId),
      startConversation: (a, b, opener) => this.startConversation(a, b, opener, ctx),
      blueprints: this.blueprints,
      addBlueprint: (bp) => {
        this.blueprints.set(bp.id, bp);
        this.newBlueprints.push(bp);
      },
      emit: (e) => this.listeners.forEach((l) => l(e, ctx)),
      spawnGolem: (owner, bp) => {
        if (this.agents.length >= MAX_POPULATION + 6) return ctx.log(`There's no room left on the island for a golem`, owner.id);
        createGolem(owner, bp, ctx, () => this.nextAgentId(), (x) => this.agents.push(x));
      },
      startFamily: (a, b) => startFamily(a, b, ctx, () => this.nextAgentId(), (x) => this.agents.push(x)),
      removeAgent: (agent, reason) => this.removeAgent(agent, reason, ctx),
      killAgent: (agent, cause) => this.killAgent(agent, cause, ctx),
      market: this.market,
      wars: this.wars,
    };
    return ctx;
  }

  agentStates() {
    const names = new Map(this.agents.map((a) => [a.id, a.name]));
    return this.agents.map((a) => a.toState(names, this.blueprints, this.achievements.ofAgent(a.id), this.wars.enemiesOf(a.id)));
  }

  economyStats() {
    return this.economy.snapshot(this.clock.day, this.agents, this.world, this.market, this.world.market?.id ?? null);
  }

  // ---------- admin ("central bank") operations: never written to the event log ----------
  airdrop(berries: number, targetId: string | null) {
    const ctx = this.makeCtx();
    for (const a of this.agents) {
      if (a.isGolem || a.stage === 'egg' || (targetId && a.id !== targetId)) continue;
      a.addItem('berry', berries); // may exceed capacity: berries falling from the sky
      ctx.emit({ type: 'berries', kind: 'airdropped', qty: berries });
    }
  }

  immigrants(count: number, temperament: Temperament, armed: boolean) {
    spawnImmigrants(count, temperament, armed, this.makeCtx(), () => this.nextAgentId(), (a) => this.agents.push(a));
  }

  tax(fraction: number) {
    const ctx = this.makeCtx();
    for (const a of this.agents) {
      const take = Math.floor((a.inventory.berry ?? 0) * fraction);
      if (take > 0) {
        a.removeItem('berry', take);
        ctx.emit({ type: 'berries', kind: 'burned', qty: take });
      }
    }
  }

  onEvent(listener: (e: SimEvent, ctx: SimContext) => void) {
    this.listeners.push(listener);
  }

  drainBlueprints(): Blueprint[] {
    const out = this.newBlueprints;
    this.newBlueprints = [];
    return out;
  }

  private agentCounter = 0;

  nextAgentId(): string {
    let id: string;
    do id = `a${++this.agentCounter}`;
    while (this.agents.some((a) => a.id === id));
    return id;
  }

  private killAgent(agent: Agent, cause: string, ctx: SimContext) {
    const { x, y } = agent.tile;
    const i = this.agents.indexOf(agent);
    if (i < 0) return;
    this.agents.splice(i, 1);
    ctx.log(`🪦 ${agent.name} died ${cause}.`, agent.id);
    // Gravestone (if the tile is free)
    if (ctx.world.isFree(x, y)) {
      ctx.world.addStructure(x, y, {
        blueprintId: 'grave', name: `${agent.name} — Day ${ctx.clock.day}`, kind: 'structure', shape: 'grave', color: agent.color,
        ownerId: agent.id, ownerName: agent.name, shelter: 0, light: 0, defense: 0,
      });
    }
    // Mourning: those who loved them grieve, everyone remembers.
    for (const other of this.agents) {
      other.allies.delete(agent.id);
      if (other.isGolem) continue;
      const love = other.relations.get(agent.id).affection;
      if (love > 0.2 || other.parents.includes(agent.id) || agent.parents.includes(other.id)) {
        other.emotions.feel('sadness', 0.35 + love * 0.4);
        other.mind.remember(`${agent.name} died ${cause}. I will miss them so much.`, ctx.clock);
      } else if (Math.hypot(other.x - agent.x, other.y - agent.y) < 10 || love < -0.2) {
        other.emotions.feel('fear', 0.15);
        other.mind.remember(`${agent.name} died ${cause}.`, ctx.clock);
      }
    }
    for (const g of this.agents.filter((a) => a.ownerId === agent.id)) g.battery = Math.min(g.battery, 50);
  }

  private removeAgent(agent: Agent, reason: string, ctx: SimContext) {
    const i = this.agents.indexOf(agent);
    if (i < 0) return;
    this.agents.splice(i, 1);
    for (const a of this.agents) a.allies.delete(agent.id);
    ctx.log(`🪨 ${agent.name} ${reason}`, agent.ownerId ?? undefined);
  }

  private startConversation(a: Agent, b: Agent, opener: string | null, ctx: SimContext): boolean {
    const free = (x: Agent) =>
      !x.fainted &&
      !x.isGolem &&
      x.action !== 'sleep' &&
      x.task?.kind !== 'talk' &&
      x.talkCooldown <= 0 &&
      !(x.task?.satisfies === 'food' && x.needs.food < 30);
    if (a === b || !free(a) || !free(b) || !this.llm.available) return false;
    if (Math.hypot(a.x - b.x, a.y - b.y) > 2.5) return false;
    const conv = new Conversation(a, b, opener);
    this.conversations.push(conv);
    for (const [x, y] of [[a, b], [b, a]] as const) {
      x.path = [];
      x.task = new TalkTask(conv, y);
    }
    ctx.log(`💬 ${a.name} and ${b.name} started chatting`, a.id);
    return true;
  }

  private recentLogs = new Map<string, number>();

  log(text: string, agentId?: string) {
    // Skip identical events from the same agent within a short window (so loops can't flood memory and the log).
    const key = `${agentId ?? ''}|${text}`;
    const last = this.recentLogs.get(key);
    if (last !== undefined && this.tick - last < 300) return;
    this.recentLogs.set(key, this.tick);
    if (this.recentLogs.size > 500) {
      for (const [k, t] of this.recentLogs) if (this.tick - t >= 300) this.recentLogs.delete(k);
    }
    const { day, timeOfDay } = this.clock;
    const event: LogEvent = { id: this.nextEventId++, day, timeOfDay, text, agentId };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this.pending.push(event);
    // Events about an agent also go into their memory (LLM context).
    const agent = agentId ? this.agents.find((a) => a.id === agentId) : undefined;
    agent?.mind.remember(text, this.clock);
  }

  drainEvents(): LogEvent[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}
