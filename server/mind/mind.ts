import { formatTime, isNight, type MindState, type WorldClock } from '../../shared/protocol';
import type { Agent } from '../agent';
import type { SimContext } from '../context';
import { CraftTask, InventTask } from '../invention/tasks';
import { MarketTask } from '../economy/tasks';
import { AttackTask, StealTask } from '../social/combat';
import { ClaimTask } from '../social/territory';
import { RaidTask, raidTargetOf } from '../social/war';
import { ApproachTask, EatTask, GatherTask, GoHomeTask, RestTask, SleepTask, ThinkTask, WanderTask, type Task } from '../tasks';
import { minThinkTicks } from './config';
import { DECISION_SCHEMA, REFLECT_SCHEMA, parseDecision, parseReflection, type Decision } from './decision';
import { observe, reflectPrompt, systemPrompt, userPrompt } from './perception';

const MAX_MEMORIES = 40;
const STALE_TICKS = 400; // decisions older than this are discarded

interface Memory {
  day: number;
  time: string;
  text: string;
}

/**
 * The agent's "slow" mind. It thinks when the agent is free and the LLM has capacity;
 * otherwise (or if thinking fails) the reflex layer takes over.
 */
export class Mind {
  thought: string | null = null;
  plan: string | null = null;
  thinking = false;
  source: 'llm' | 'reflex' = 'reflex';
  longTerm: string | null = null;

  private memories: Memory[] = [];
  private pending: { decision: Decision; tick: number } | null = null;
  private lastThinkTick = -Infinity;
  private memoriesSinceReflect = 0;
  private lastReflectDay = 0;

  constructor(private agent: Agent) {}

  remember(text: string, clock: WorldClock) {
    if (this.memories.at(-1)?.text === text) return; // same memory twice in a row
    this.memories.push({ day: clock.day, time: formatTime(clock.timeOfDay), text });
    if (this.memories.length > MAX_MEMORIES) this.memories.shift();
    this.memoriesSinceReflect++;
  }

  serialize() {
    return {
      thought: this.thought,
      plan: this.plan,
      longTerm: this.longTerm,
      memories: this.memories,
      lastReflectDay: this.lastReflectDay,
      memoriesSinceReflect: this.memoriesSinceReflect,
    };
  }

  restore(d: ReturnType<Mind['serialize']>) {
    this.thought = d.thought;
    this.plan = d.plan;
    this.longTerm = d.longTerm;
    this.memories = d.memories;
    this.lastReflectDay = d.lastReflectDay;
    this.memoriesSinceReflect = d.memoriesSinceReflect;
  }

  /** When falling asleep: summarizes the day's memories into long-term memory and opinions. */
  reflect(ctx: SimContext) {
    if (this.memoriesSinceReflect < 6 || this.lastReflectDay === ctx.clock.day || !ctx.llm.available) return;
    this.lastReflectDay = ctx.clock.day;
    const agent = this.agent;
    const recent = this.recentMemories(Math.min(25, this.memoriesSinceReflect));
    this.memoriesSinceReflect = 0;
    ctx.llm
      .request({
        system: systemPrompt(agent),
        user: reflectPrompt(agent, ctx, recent),
        schema: REFLECT_SCHEMA,
        temperature: 0.7,
        meta: { kind: 'reflect', name: agent.name, memories: recent, known: agent.relations.snapshot(new Map(ctx.agents.map((a) => [a.id, a.name]))) },
      })
      .then((text) => {
        const r = parseReflection(text);
        if (!r) return;
        this.longTerm = r.summary;
        for (const { name, opinion } of r.opinions) {
          const other = ctx.agents.find((a) => a.name.toLowerCase() === name.toLowerCase());
          if (other && other !== agent) agent.relations.get(other.id).opinion = opinion;
        }
        ctx.log(`💭 ${agent.name} reflected on the day before sleeping`, agent.id);
      })
      .catch(() => {});
  }

  recentMemories(n: number): string[] {
    return this.memories.slice(-n).map((m) => `[G${m.day} ${m.time}] ${m.text}`);
  }

  /** The agent's next task: a ready LLM decision, starting to think, or null (reflexes). */
  nextTask(ctx: SimContext): Task | null {
    if (this.pending) {
      const { decision, tick } = this.pending;
      this.pending = null;
      if (ctx.clock.tick - tick <= STALE_TICKS) {
        const task = this.apply(decision, ctx);
        if (task) {
          this.source = 'llm';
          return task;
        }
      }
    }
    this.source = 'reflex';
    if (this.thinking || !ctx.llm.available) return null;
    if (ctx.clock.tick - this.lastThinkTick < minThinkTicks()) return null;
    this.think(ctx);
    return new ThinkTask(() => !this.thinking);
  }

  toState(): MindState {
    return {
      thought: this.thought,
      plan: this.plan,
      thinking: this.thinking,
      source: this.source,
      memories: this.recentMemories(6),
      longTerm: this.longTerm,
    };
  }

  private think(ctx: SimContext) {
    this.thinking = true;
    this.lastThinkTick = ctx.clock.tick;
    const obs = observe(this.agent, ctx);
    ctx.llm
      .request({
        system: systemPrompt(this.agent),
        user: userPrompt(obs),
        schema: DECISION_SCHEMA,
        temperature: 0.9,
        meta: obs,
      })
      .then((text) => {
        const decision = parseDecision(text);
        if (decision) this.pending = { decision, tick: ctx.clock.tick };
        else console.warn(`[mind] ${this.agent.name}: invalid reply → ${text.slice(0, 120)}`);
      })
      .catch(() => {})
      .finally(() => {
        this.thinking = false;
      });
  }

  /** Turns a decision into a concrete task; if it can't be done, the reason goes into memory. */
  private apply(d: Decision, ctx: SimContext): Task | null {
    const agent = this.agent;
    if (d.thought) this.thought = d.thought;
    if (d.plan) {
      if (d.plan !== this.plan) ctx.log(`${agent.name} made a new plan: “${d.plan}”`, agent.id);
      this.plan = d.plan;
    }
    if (d.say) this.speak(d.say, ctx);

    const fail = (why: string) => {
      this.remember(why, ctx.clock);
      agent.emotions.feel('anger', 0.03 + agent.personality.aggression * 0.05);
      return null;
    };

    switch (d.action) {
      case 'gather': {
        const type = d.target === 'berry' ? 'bush' : d.target === 'wood' ? 'tree' : d.target === 'stone' ? 'rock' : null;
        if (!type) return fail("I couldn't decide what to gather.");
        if (!agent.hasRoom()) return fail("My bag was full, so I couldn't gather anything.");
        return GatherTask.create(agent, ctx, type, 3) ?? fail(`I couldn't find any ${d.target} to gather nearby.`);
      }
      case 'eat':
        return agent.inventory.berry ? new EatTask() : fail('I wanted to eat but had no berries in my bag.');
      case 'sleep':
        return GoHomeTask.create(agent, ctx, true) ?? new SleepTask(!isNight(ctx.clock.timeOfDay));
      case 'go_home':
        return GoHomeTask.create(agent, ctx, false) ?? fail("I wanted to go home but I don't have one (or couldn't find the way).");
      case 'invent':
        if (!d.idea) return fail("I wanted to invent something but my idea wasn't clear.");
        return new InventTask(d.idea);
      case 'craft': {
        const name = d.item.toLowerCase();
        const bp = [...agent.known]
          .map((id) => ctx.blueprints.get(id))
          .find((b) => b && (b.name.toLowerCase() === name || b.name.toLowerCase().includes(name)));
        if (!bp || !name) return fail(`I don't know a recipe called "${d.item}".`);
        return new CraftTask(bp);
      }
      case 'explore':
        return WanderTask.create(agent, ctx, d.direction) ?? fail("I couldn't find a way in that direction.");
      case 'rest':
        return new RestTask(40 + Math.round(agent.personality.laziness * 60));
      case 'approach': {
        const target = ctx.agents.find((a) => a !== agent && a.name.toLowerCase() === d.who.toLowerCase());
        if (!target) return fail(`I couldn't find anyone called "${d.who}".`);
        return ApproachTask.create(agent, ctx, target) ?? fail(`I couldn't reach ${target.name}.`);
      }
      case 'ride':
        return WanderTask.joyride(agent, ctx) ?? fail("I wanted a ride but I don't have a vehicle.");
      case 'claim':
        return new ClaimTask();
      case 'market': {
        const item = d.target === 'wood' || d.target === 'stone' || d.target === 'fiber' ? d.target : null;
        if (d.market_op === 'cancel') return MarketTask.create(agent, ctx, { op: 'cancel' }) ?? fail("I couldn't get to the market.");
        if (d.market_op === 'none' || !item) return MarketTask.create(agent, ctx, { op: 'collect' }) ?? fail("I couldn't get to the market.");
        return (
          MarketTask.create(agent, ctx, { op: d.market_op, item, qty: Math.max(1, d.qty), price: Math.max(1, d.price) }) ??
          fail("I couldn't find a way to the market.")
        );
      }
      case 'declare_war':
      case 'raid': {
        const target = ctx.agents.find((a) => a !== agent && a.name.toLowerCase() === d.who.toLowerCase());
        if (!target) return fail(`There was nobody called "${d.who}".`);
        if (d.action === 'declare_war') {
          if (!ctx.wars.atWar(agent, target)) ctx.wars.declare(agent, target, ctx);
          return new RestTask(20, 'Preparing for war');
        }
        const struct = raidTargetOf(target, ctx);
        return struct ? new RaidTask(struct) : fail(`${target.name} had no structure to raid.`);
      }
      case 'attack':
      case 'steal': {
        const target = ctx.agents.find((a) => a !== agent && a.name.toLowerCase() === d.who.toLowerCase());
        if (!target || target.fainted) return fail(`There was nobody called "${d.who}" to attack.`);
        if (d.action === 'attack') return new AttackTask(target);
        const want = d.target === 'berry' || d.target === 'wood' || d.target === 'stone' ? d.target : null;
        return new StealTask(target, want);
      }
      case 'talk': {
        const target = ctx.agents.find((a) => a !== agent && a.name.toLowerCase() === d.who.toLowerCase());
        if (!target) return fail(`I couldn't find anyone called "${d.who}".`);
        if (target.action === 'sleep') return fail(`${target.name} was asleep, so we couldn't talk.`);
        const opener = d.thought || null;
        if (Math.hypot(target.x - agent.x, target.y - agent.y) <= 2.5) {
          // If a chat task was assigned, this decision produces no other task.
          return ctx.startConversation(agent, target, opener) ? agent.task : fail(`${target.name} wasn't free to talk.`);
        }
        return (
          ApproachTask.create(agent, ctx, target, () => {
            if (!ctx.startConversation(agent, target, opener)) this.remember(`I couldn't talk to ${target.name}; they were busy.`, ctx.clock);
          }) ?? fail(`I couldn't reach ${target.name}.`)
        );
      }
    }
  }

  private speak(text: string, ctx: SimContext) {
    const agent = this.agent;
    agent.say(text, 50);
    ctx.log(`${agent.name}: “${text}”`, agent.id);
    for (const other of ctx.agents) {
      if (other === agent || other.action === 'sleep') continue;
      if (Math.hypot(other.x - agent.x, other.y - agent.y) <= 6) {
        other.mind.remember(`${agent.name} bana dedi ki: “${text}”`, ctx.clock);
      }
    }
  }
}
