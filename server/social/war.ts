import { DAY_TICKS, type AgentAction, type WorldObject } from '../../shared/protocol';
import type { Agent } from '../agent';
import type { SimContext } from '../context';
import { explore } from '../pathfinding';
import type { Task, TaskStatus } from '../tasks';
import { areAllies, onAttacked } from './combat';

const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Wars are tracked between pairs of inhabitants; a declaration pulls in both sides' allies. */
export class Wars {
  private pairs = new Map<string, { since: number; lastActive: number }>();

  atWar(a: Agent, b: Agent): boolean {
    return this.pairs.has(key(a.id, b.id));
  }

  enemiesOf(agentId: string): string[] {
    const out: string[] = [];
    for (const k of this.pairs.keys()) {
      const [x, y] = k.split('|');
      if (x === agentId) out.push(y);
      else if (y === agentId) out.push(x);
    }
    return out;
  }

  touch(a: Agent, b: Agent, tick: number) {
    const w = this.pairs.get(key(a.id, b.id));
    if (w) w.lastActive = tick;
  }

  declare(attacker: Agent, target: Agent, ctx: SimContext) {
    const side = (x: Agent) => [x, ...ctx.agents.filter((o) => o !== x && !o.isGolem && areAllies(o, x))];
    const left = side(attacker);
    const right = side(target).filter((r) => !left.includes(r));
    for (const a of left) {
      for (const b of right) {
        this.pairs.set(key(a.id, b.id), { since: ctx.clock.tick, lastActive: ctx.clock.tick });
        for (const [x, y] of [[a, b], [b, a]] as const) {
          const r = x.relations.get(y.id);
          r.affection = Math.min(r.affection, -0.5);
          r.trust = Math.min(r.trust, -0.3);
        }
      }
    }
    const names = (xs: Agent[]) => xs.map((x) => x.name).join(', ');
    ctx.log(`⚔️ ${attacker.name} declared war on ${target.name}! (${names(left)} ⚔ ${names(right)})`, attacker.id);
    for (const x of [...left, ...right]) {
      x.mind.remember(`War broke out: ${names(left)} and ${names(right)} are enemies.`, ctx.clock);
      x.emotions.feel(left.includes(x) ? 'anger' : 'fear', 0.25);
    }
    ctx.emit({ type: 'war', a: attacker, b: target });
  }

  /** Peace: every pair across the two sides leaves the war. */
  end(a: Agent, b: Agent, ctx: SimContext) {
    let ended = false;
    for (const x of [a, ...ctx.agents.filter((o) => areAllies(o, a))]) {
      for (const y of [b, ...ctx.agents.filter((o) => areAllies(o, b))]) ended = this.pairs.delete(key(x.id, y.id)) || ended;
    }
    if (ended) ctx.log(`🕊️ The war between ${a.name} and ${b.name} is over`, a.id);
  }

  /** Wars with no fighting for 2 days fizzle out; wars of the dead are removed. */
  tick(ctx: SimContext) {
    if (ctx.clock.tick % 100 !== 0) return;
    const alive = new Set(ctx.agents.map((a) => a.id));
    for (const [k, w] of this.pairs) {
      const [x, y] = k.split('|');
      if (!alive.has(x) || !alive.has(y)) this.pairs.delete(k);
      else if (ctx.clock.tick - w.lastActive > DAY_TICKS * 2) {
        this.pairs.delete(k);
        const ax = ctx.agents.find((a) => a.id === x)!;
        const ay = ctx.agents.find((a) => a.id === y)!;
        ctx.log(`🕊️ The war between ${ax.name} and ${ay.name} quietly fizzled out`, ax.id);
      }
    }
  }

  serialize() {
    return [...this.pairs.entries()];
  }

  restore(d: [string, { since: number; lastActive: number }][]) {
    this.pairs = new Map(d);
  }
}

/** Raid on a structure: walk up and strike it; at 0 HP it is destroyed. Damage on a vehicle counts as siege power. */
export class RaidTask implements Task {
  readonly kind = 'attack';
  readonly label: string;
  action: AgentAction = 'walk';
  progress = null;
  private ticks = 0;
  private pathSet = false;
  private announced = false;

  constructor(private target: WorldObject) {
    this.label = `Raiding ${target.structure?.name ?? 'a structure'}`;
  }

  step(agent: Agent, ctx: SimContext): TaskStatus {
    const t = this.target;
    if (!ctx.world.objectById(t.id)) return 'done';
    // You can't raid your own or an ally's structure; the market and graves are untouchable.
    const ownerId = t.structure?.ownerId;
    if (!ownerId || ownerId === agent.id || agent.allies.has(ownerId) || ['market', 'grave'].includes(t.structure!.shape)) return 'failed';
    if (agent.needs.health < 25) return 'failed';
    const d = Math.hypot(t.x + 0.5 - agent.x, t.y + 0.5 - agent.y);
    if (d > 1.7) {
      if (!this.pathSet) {
        this.pathSet = true;
        const { reachable, pathTo } = explore(ctx.world, agent.tile, 50, agent.mobility);
        const w = ctx.world.width;
        const best = reachable
          .filter((i) => ctx.world.isWalkable(i % w, Math.floor(i / w)))
          .sort((a, b) => Math.hypot((a % w) - t.x, Math.floor(a / w) - t.y) - Math.hypot((b % w) - t.x, Math.floor(b / w) - t.y))[0];
        if (best == null || Math.hypot((best % w) - t.x, Math.floor(best / w) - t.y) > 1.5) return 'failed';
        agent.setPath(pathTo(best), ctx.world);
      }
      this.action = 'walk';
      if (agent.moveAlongPath(ctx) && Math.hypot(t.x + 0.5 - agent.x, t.y + 0.5 - agent.y) > 1.7) return 'failed';
      return 'running';
    }
    const owner = ctx.agents.find((a) => a.id === t.structure?.ownerId) ?? null;
    if (!this.announced) {
      this.announced = true;
      ctx.log(`🔥 ${agent.name} is raiding ${t.structure?.name ?? 'a structure'}!`, agent.id);
      if (owner) {
        owner.relations.adjust(agent.id, { affection: -0.3, trust: -0.3 });
        owner.mind.remember(`${agent.name} attacked my ${t.structure?.name ?? 'structure'}!`, ctx.clock);
        // If the owner is nearby (and not inside), they rush to defend it.
        if (owner.insideId == null && Math.hypot(owner.x - agent.x, owner.y - agent.y) < 10) onAttacked(owner, agent, ctx);
        ctx.wars.touch(agent, owner, ctx.clock.tick);
      }
    }
    this.action = 'attack';
    agent.facing = t.x + 0.5 > agent.x ? 1 : -1;
    if (++this.ticks % 18 !== 0) return 'running';
    const siege = agent.vehicle?.components.find((c) => c.type === 'damage')?.power ?? 0;
    const dmg = Math.round((4 + agent.bonus('damage') * 3) * (siege ? 1 + siege : 1));
    agent.say(siege ? '💣' : '🔨', 12);
    if (!ctx.world.damageStructure(t, dmg)) return 'running';

    // Destroyed
    ctx.world.removeObject(t);
    for (const a of ctx.agents) {
      if (a.insideId !== t.id) continue;
      a.exit();
      a.needs.health = Math.max(1, a.needs.health - 15);
      a.emotions.feel('fear', 0.4);
      a.mind.remember(`${agent.name} destroyed my home while I was inside!`, ctx.clock);
    }
    if (owner) {
      if (owner.homeId === t.id) owner.homeId = null;
      owner.emotions.feel('sadness', 0.3);
      owner.emotions.feel('anger', 0.3 + owner.personality.aggression * 0.3);
    }
    if (agent.vehicle) agent.wearVehicle(ctx);
    agent.emotions.feel('pride', 0.2);
    ctx.log(`💥 ${agent.name} razed ${t.structure?.name ?? 'the structure'}!`, agent.id);
    ctx.emit({ type: 'raid', attacker: agent, owner, destroyed: true });
    return 'done';
  }
}

/** Find an enemy's home or flag. */
export function raidTargetOf(enemy: Agent, ctx: SimContext): WorldObject | undefined {
  const home = enemy.homeId != null ? ctx.world.objectById(enemy.homeId) : undefined;
  return home ?? ctx.world.map.objects.find((o) => o.structure?.shape === 'flag' && o.structure.ownerId === enemy.id);
}
