import { ITEMS, type AgentAction, type ItemType } from '../../shared/protocol';
import type { Agent } from '../agent';
import type { SimContext } from '../context';
import { explore } from '../pathfinding';
import type { Task, TaskStatus } from '../tasks';
import { RaidTask } from './war';

const HIT_EVERY = 18;
const WITNESS_RADIUS = 7;

const dist = (a: Agent, b: Agent) => Math.hypot(a.x - b.x, a.y - b.y);
const reach = (a: Agent) => 1.6 + a.bonus('range') * 1.5;

/** Plots a path around obstacles to the reachable tile closest to the target. */
function chase(agent: Agent, target: Agent, ctx: SimContext) {
  const { reachable, pathTo } = explore(ctx.world, agent.tile, 20, agent.mobility);
  const { width } = ctx.world;
  let best = -1;
  let bestD = Math.hypot(agent.tile.x + 0.5 - target.x, agent.tile.y + 0.5 - target.y);
  for (const i of reachable) {
    const x = i % width;
    const y = Math.floor(i / width);
    if (!ctx.world.isWalkable(x, y)) continue;
    const d = Math.hypot(x + 0.5 - target.x, y + 0.5 - target.y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  agent.setPath(best >= 0 ? pathTo(best) : [], ctx.world);
}

export function areAllies(a: Agent, b: Agent) {
  return a.allies.has(b.id) && b.allies.has(a.id);
}

export function formAlliance(a: Agent, b: Agent, ctx: SimContext) {
  if (areAllies(a, b)) return;
  a.allies.add(b.id);
  b.allies.add(a.id);
  for (const [x, y] of [[a, b], [b, a]] as const) {
    x.relations.adjust(y.id, { trust: 0.2, affection: 0.1 });
    x.mind.remember(`${y.name} and I formed an alliance.`, ctx.clock);
    x.emotions.feel('joy', 0.15);
  }
  ctx.log(`🤝 ${a.name} and ${b.name} formed an alliance!`, a.id);
  ctx.emit({ type: 'alliance', a, b });
}

export function breakAlliance(a: Agent, b: Agent, ctx: SimContext, reason: string) {
  if (!a.allies.has(b.id) && !b.allies.has(a.id)) return;
  a.allies.delete(b.id);
  b.allies.delete(a.id);
  ctx.log(`💔 The alliance between ${a.name} and ${b.name} broke (${reason})`, a.id);
  ctx.emit({ type: 'alliance_broken', a, b });
}

export function makePeace(a: Agent, b: Agent, ctx: SimContext) {
  for (const [x, y] of [[a, b], [b, a]] as const) {
    const r = x.relations.get(y.id);
    r.affection = Math.max(r.affection, 0.1);
    r.trust = Math.max(r.trust + 0.2, 0);
    x.emotions.feel('anger', -0.3);
    x.emotions.feel('fear', -0.2);
    x.mind.remember(`${y.name} and I made peace.`, ctx.clock);
  }
  ctx.wars.end(a, b, ctx);
  ctx.log(`☮️ ${a.name} and ${b.name} made peace`, a.id);
  ctx.emit({ type: 'peace', a, b });
}

/** When attacked: fight back or flee depending on personality and state; allies rush to help. */
export function onAttacked(victim: Agent, attacker: Agent, ctx: SimContext) {
  if (victim === attacker || victim.fainted || victim.isGolem) return;
  const p = victim.personality;
  const e = victim.emotions.values;
  if (!(victim.task instanceof AttackTask) && !(victim.task instanceof FleeTask)) {
    const courage = p.aggression + e.anger + victim.bonus('damage') * 0.15 + victim.needs.health / 200;
    const timidity = p.caution + e.fear + 0.3;
    victim.path = [];
    victim.task = courage > timidity ? new AttackTask(attacker, true) : new FleeTask(attacker);
    if (ctx.clock.tick - victim.lastReactTick < 200) return;
    victim.lastReactTick = ctx.clock.tick;
    ctx.log(
      victim.task instanceof AttackTask ? `⚔️ ${victim.name} fights back!` : `🏃 ${victim.name} runs away from ${attacker.name}!`,
      victim.id,
    );
  }
  for (const ally of ctx.agents) {
    if (ally === victim || ally === attacker || !areAllies(ally, victim) || ally.fainted || ally.action === 'sleep' || ally.insideId != null) continue;
    if (dist(ally, victim) > WITNESS_RADIUS || ally.task instanceof AttackTask) continue;
    if (ally.personality.aggression > 0.3 || ally.relations.get(victim.id).affection > 0.6) {
      ally.path = [];
      ally.task = new AttackTask(attacker, true);
      ctx.log(`🛡️ ${ally.name} attacks ${attacker.name} to defend their ally ${victim.name}!`, ally.id);
    }
  }
}

/** Attacks an inhabitant: closes in and strikes at intervals; ends when the target faints, escapes, or anger subsides. */
export class AttackTask implements Task {
  readonly kind = 'attack';
  readonly label: string;
  action: AgentAction = 'walk';
  progress = null;
  private ticks = 0;
  private hits = 0;
  private repathIn = 0;
  private announced: boolean;
  private maxHits: number;

  constructor(
    readonly target: Agent,
    private defending = false,
  ) {
    this.label = defending ? `Fighting ${target.name}` : `Attacking ${target.name}`;
    this.announced = defending;
    this.maxHits = defending ? 4 : 3;
  }

  step(agent: Agent, ctx: SimContext): TaskStatus {
    const t = this.target;
    if (t.fainted || t.action === 'sleep' && !this.defending) return this.end(agent, ctx, t.fainted);
    if (t.insideId != null) {
      // Target hid at home: raid the house if at war and bold enough, otherwise give up.
      const home = ctx.world.objectById(t.insideId);
      if (home && (ctx.wars.atWar(agent, t) || agent.emotions.values.anger > 0.6) && agent.personality.aggression > 0.4) {
        agent.task = new RaidTask(home);
      }
      return 'done';
    }
    if (agent.needs.health < 25) {
      agent.task = new FleeTask(t);
      ctx.log(`🏳️ ${agent.name} retreats`, agent.id);
      return 'done';
    }
    const d = dist(agent, t);
    if (d > 12) return this.end(agent, ctx, false);

    if (d > reach(agent)) {
      this.action = 'walk';
      if (--this.repathIn <= 0 || !agent.path.length) {
        this.repathIn = 15;
        chase(agent, t, ctx);
      }
      agent.moveAlongPath(ctx);
      return 'running';
    }

    if (!this.announced) {
      this.announced = true;
      this.firstStrike(agent, ctx);
    }
    this.action = 'attack';
    agent.facing = t.x > agent.x ? 1 : -1;
    if (++this.ticks % HIT_EVERY !== 0) return 'running';

    this.strike(agent, t, ctx);
    if (++this.hits >= this.maxHits && agent.emotions.values.anger < 0.6) return this.end(agent, ctx, false);
    return 'running';
  }

  private firstStrike(agent: Agent, ctx: SimContext) {
    const t = this.target;
    ctx.log(`⚔️ ${agent.name} attacked ${t.name}!`, agent.id);
    ctx.emit({ type: 'fight', attacker: agent, target: t });
    if (areAllies(agent, t)) breakAlliance(agent, t, ctx, 'ihanet');
    t.relations.adjust(agent.id, { affection: -0.4, trust: -0.5, familiarity: 0.05 });
    agent.relations.adjust(t.id, { affection: -0.1 });
    t.mind.remember(`${agent.name} attacked me!`, ctx.clock);
    for (const w of ctx.agents) {
      if (w === agent || w === t || w.action === 'sleep' || dist(w, agent) > WITNESS_RADIUS) continue;
      w.relations.adjust(agent.id, { affection: -0.15, trust: -0.1 });
      w.emotions.feel('fear', 0.15 + w.personality.caution * 0.1);
      w.mind.remember(`I saw ${agent.name} attack ${t.name}.`, ctx.clock);
    }
    // A peaceful temperament feels guilty after attacking.
    if (agent.personality.aggression < 0.4) agent.emotions.feel('sadness', 0.2);
  }

  private strike(agent: Agent, t: Agent, ctx: SimContext) {
    const raw = 5 + agent.bonus('damage') * 4 + agent.emotions.values.anger * 3;
    const home = t.homeId != null ? ctx.world.objectById(t.homeId) : undefined;
    const homeDefense = home && Math.hypot(home.x + 0.5 - t.x, home.y + 0.5 - t.y) < 2.2 ? (home.structure?.defense ?? 0) : 0;
    const reduction = Math.min(0.75, 0.12 * (t.bonus('defense') + homeDefense));
    const dmg = Math.round(raw * (1 - reduction));
    t.needs.health = Math.max(0, t.needs.health - dmg);
    t.lastHitBy = agent;
    ctx.wars.touch(agent, t, ctx.clock.tick);
    t.say('💥', 12);
    agent.say('⚔️', 12);
    t.emotions.feel('fear', 0.08 + t.personality.caution * 0.05);
    t.emotions.feel('anger', 0.05 + t.personality.aggression * 0.08);
    agent.emotions.feel('anger', -0.08);
    onAttacked(t, agent, ctx);
  }

  private end(agent: Agent, ctx: SimContext, won: boolean): TaskStatus {
    if (won) {
      agent.emotions.feel('pride', 0.2);
      agent.emotions.feel('anger', -0.3);
    }
    return 'done';
  }
}

/** Gets away from the attacker (flying if possible). */
export class FleeTask implements Task {
  readonly kind = 'flee';
  readonly label: string;
  action: AgentAction = 'walk';
  progress = null;
  private ticks = 0;

  constructor(private from: Agent) {
    this.label = `Fleeing from ${from.name}`;
  }

  step(agent: Agent, ctx: SimContext): TaskStatus {
    if (++this.ticks > 400 || dist(agent, this.from) > 10 || this.from.fainted) {
      agent.emotions.feel('fear', -0.1);
      return 'done';
    }
    if (!agent.path.length) {
      const away = Math.atan2(agent.y - this.from.y, agent.x - this.from.x);
      let best: { x: number; y: number } | null = null;
      for (let r = 8; r >= 3 && !best; r--) {
        for (const spread of [0, 0.5, -0.5, 1, -1]) {
          const x = Math.floor(agent.x + Math.cos(away + spread) * r);
          const y = Math.floor(agent.y + Math.sin(away + spread) * r);
          if (ctx.world.isWalkable(x, y)) {
            best = { x, y };
            break;
          }
        }
      }
      if (!best) return 'done';
      agent.setPath([best], ctx.world);
    }
    // Panic run: two steps per tick.
    agent.moveAlongPath(ctx);
    agent.moveAlongPath(ctx);
    return 'running';
  }
}

/** Tries to secretly take items from someone's bag. */
export class StealTask implements Task {
  readonly kind = 'attack';
  readonly label: string;
  action: AgentAction = 'walk';
  progress = null;
  private repathIn = 0;

  constructor(
    private target: Agent,
    private want: ItemType | null,
  ) {
    this.label = `Sneaking up on ${target.name}`;
  }

  step(agent: Agent, ctx: SimContext): TaskStatus {
    const t = this.target;
    if (t.fainted || t.insideId != null || dist(agent, t) > 15) return 'failed';
    if (dist(agent, t) > 1.6) {
      if (--this.repathIn <= 0 || !agent.path.length) {
        this.repathIn = 15;
        chase(agent, t, ctx);
      }
      agent.moveAlongPath(ctx);
      return 'running';
    }
    const item =
      (this.want && (t.inventory[this.want] ?? 0) > 0 ? this.want : null) ??
      (Object.entries(t.inventory) as [ItemType, number][]).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!item || !agent.hasRoom()) return 'failed';
    const qty = Math.min(2, t.inventory[item] ?? 0);
    t.removeItem(item, qty);
    agent.addItem(item, qty);

    // An awake, careful target notices.
    const noticed = t.action !== 'sleep' && ctx.rng() < 0.4 + t.personality.caution * 0.4;
    if (noticed) {
      ctx.log(`🫳 ${agent.name} stole ${qty} ${ITEMS[item].emoji} from ${t.name}'s bag — and got caught!`, agent.id);
      t.relations.adjust(agent.id, { affection: -0.3, trust: -0.5 });
      t.emotions.feel('anger', 0.3 + t.personality.aggression * 0.2);
      t.mind.remember(`${agent.name} stole ${ITEMS[item].name.toLowerCase()} from me!`, ctx.clock);
      if (areAllies(agent, t)) breakAlliance(agent, t, ctx, 'theft');
      if (t.personality.aggression > 0.5) onAttacked(t, agent, ctx);
    } else {
      ctx.log(`🫳 ${agent.name} quietly pinched ${qty} ${ITEMS[item].emoji}`, agent.id);
      agent.mind.remember(`I took ${ITEMS[item].name.toLowerCase()} from ${t.name}'s bag without them noticing.`, ctx.clock);
    }
    if (agent.personality.aggression < 0.4) agent.emotions.feel('sadness', 0.1);
    return 'done';
  }
}

/** The winner loots the bag of the one who fainted. */
export function knockout(loser: Agent, winner: Agent, ctx: SimContext) {
  const loot = (Object.entries(loser.inventory) as [ItemType, number][]).sort((a, b) => b[1] - a[1]).slice(0, 2);
  const taken: string[] = [];
  for (const [item, n] of loot) {
    const qty = Math.min(n, 2, winner.capacity - winner.itemCount);
    if (qty <= 0) continue;
    loser.removeItem(item, qty);
    winner.addItem(item, qty);
    taken.push(`${qty} ${ITEMS[item].emoji}`);
  }
  ctx.log(`😵 ${loser.name} was knocked out by ${winner.name}!${taken.length ? ` ${winner.name} took ${taken.join(' ')}.` : ''}`, winner.id);
  loser.mind.remember(`${winner.name} knocked me out in a fight${taken.length ? ' and took my things' : ''}.`, ctx.clock);
  winner.mind.remember(`I fought ${loser.name} and won.`, ctx.clock);
  loser.relations.adjust(winner.id, { affection: -0.3, trust: -0.3 });
  ctx.emit({ type: 'knockout', winner, loser });
}
