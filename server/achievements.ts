import { ACHIEVEMENTS, type AchievementUnlock } from '../shared/achievements';
import type { Agent } from './agent';
import type { SimContext } from './context';
import type { SimEvent } from './events';
import { relationLabel } from './relations';

const NAMES = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

interface Counters {
  inventions: number;
  failures: number;
  trades: number;
  chats: number;
  friendlyChats: number;
  lastFightDay: number;
  sinceDay: number;
}

/** Listens to the event bus and unlocks achievements; the first to unlock one is recorded as "first in the world". */
export class AchievementTracker {
  readonly unlocks: AchievementUnlock[] = [];
  private pending: AchievementUnlock[] = [];
  private counters = new Map<string, Counters>();

  private c(agent: Agent): Counters {
    let c = this.counters.get(agent.id);
    if (!c) this.counters.set(agent.id, (c = { inventions: 0, failures: 0, trades: 0, chats: 0, friendlyChats: 0, lastFightDay: 0, sinceDay: 1 }));
    return c;
  }

  has(agent: Agent, id: string) {
    return this.unlocks.some((u) => u.agentId === agent.id && u.achievementId === id);
  }

  ofAgent(agentId: string): string[] {
    return this.unlocks.filter((u) => u.agentId === agentId).map((u) => u.achievementId);
  }

  unlock(agent: Agent, id: string, ctx: SimContext) {
    if (agent.isGolem || this.has(agent, id)) return;
    const def = NAMES.get(id)!;
    const firstInWorld = !this.unlocks.some((u) => u.achievementId === id);
    const u: AchievementUnlock = {
      achievementId: id,
      agentId: agent.id,
      agentName: agent.name,
      day: ctx.clock.day,
      timeOfDay: ctx.clock.timeOfDay,
      firstInWorld,
    };
    this.unlocks.push(u);
    this.pending.push(u);
    agent.emotions.feel('pride', 0.15);
    ctx.log(`🏆 ${agent.name} earned an achievement: ${def.emoji} ${def.name}${firstInWorld ? ' (first in the world!)' : ''}`, agent.id);
  }

  drain(): AchievementUnlock[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  handle(e: SimEvent, ctx: SimContext) {
    switch (e.type) {
      case 'invented': {
        const c = this.c(e.agent);
        c.inventions++;
        this.unlock(e.agent, 'first_tool', ctx);
        if (c.inventions >= 5) this.unlock(e.agent, 'inventor', ctx);
        if (e.blueprint.kind === 'structure' && e.blueprint.components.some((x) => x.type === 'shelter')) this.unlock(e.agent, 'homeowner', ctx);
        break;
      }
      case 'crafted':
        if (e.blueprint.kind === 'structure' && e.blueprint.components.some((x) => x.type === 'shelter')) this.unlock(e.agent, 'homeowner', ctx);
        break;
      case 'invention_failed':
        if (++this.c(e.agent).failures >= 3) this.unlock(e.agent, 'failure', ctx);
        break;
      case 'explored':
        if (e.ratio >= 0.4) this.unlock(e.agent, 'explorer', ctx);
        break;
      case 'flew':
        this.unlock(e.agent, 'aviator', ctx);
        break;
      case 'tech_up':
        if (e.level >= 4) this.unlock(e.agent, 'scholar', ctx);
        break;
      case 'learned':
        if (e.teacher) {
          this.unlock(e.teacher, 'teacher', ctx);
          this.unlock(e.agent, 'student', ctx);
        } else this.unlock(e.agent, 'student', ctx);
        break;
      case 'trade':
        for (const x of [e.from, e.to]) {
          const n = ++this.c(x).trades;
          if (n >= 3) this.unlock(x, 'trader', ctx);
          if (n >= 5) this.unlock(x, 'merchant', ctx);
        }
        break;
      case 'gift':
        this.unlock(e.from, 'generous', ctx);
        break;
      case 'conversation':
        for (const [x, y] of [[e.a, e.b], [e.b, e.a]] as const) {
          const c = this.c(x);
          c.chats++;
          if (e.friendly >= 2) c.friendlyChats++;
          if (c.chats >= 10) this.unlock(x, 'chatterbox', ctx);
          if (relationLabel(x.relations.get(y.id)) === 'close friend') this.unlock(x, 'best_friend', ctx);
        }
        break;
      case 'alliance':
        this.unlock(e.a, 'ally', ctx);
        this.unlock(e.b, 'ally', ctx);
        break;
      case 'fight':
        this.unlock(e.attacker, 'first_fight', ctx);
        this.c(e.attacker).lastFightDay = ctx.clock.day;
        this.c(e.target).lastFightDay = ctx.clock.day;
        break;
      case 'knockout':
        this.unlock(e.winner, 'victor', ctx);
        break;
      case 'peace':
        this.unlock(e.a, 'peacemaker', ctx);
        this.unlock(e.b, 'peacemaker', ctx);
        break;
      case 'recovered':
        this.unlock(e.agent, 'survivor', ctx);
        break;
      case 'born':
        for (const p of e.parents) this.unlock(p, 'parent', ctx);
        break;
      case 'golem':
        this.unlock(e.owner, 'golem_maker', ctx);
        break;
      case 'healed':
        this.unlock(e.agent, 'healer', ctx);
        break;
      case 'claimed':
        this.unlock(e.agent, 'landlord', ctx);
        break;
      case 'war':
        this.unlock(e.a, 'warlord', ctx);
        break;
      case 'raid':
        if (e.destroyed) this.unlock(e.attacker, 'raider', ctx);
        break;
      case 'rode':
        this.unlock(e.agent, 'driver', ctx);
        break;
    }
  }

  /** Daily checks (achievements that span time, like pacifism). */
  daily(agents: Agent[], ctx: SimContext) {
    for (const a of agents) {
      if ((a.inventory.berry ?? 0) >= 30) this.unlock(a, 'tycoon', ctx);
      const c = this.c(a);
      const peacefulSince = Math.max(c.lastFightDay, c.sinceDay);
      if (ctx.clock.day - peacefulSince >= 3 && c.friendlyChats >= 5) this.unlock(a, 'pacifist', ctx);
    }
  }

  serialize() {
    return { unlocks: this.unlocks, counters: [...this.counters.entries()] };
  }

  restore(data: ReturnType<AchievementTracker['serialize']>) {
    this.unlocks.push(...data.unlocks);
    for (const [k, v] of data.counters) this.counters.set(k, v);
  }
}
