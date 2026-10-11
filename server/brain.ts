import { isNight } from '../shared/protocol';
import type { Agent } from './agent';
import { BALANCE } from './balance';
import type { SimContext } from './context';
import type { Blueprint } from '../shared/invention';
import { CraftTask } from './invention/tasks';
import { MarketTask } from './economy/tasks';
import { AttackTask, StealTask } from './social/combat';
import { ClaimTask, flagOf } from './social/territory';
import { RaidTask, raidTargetOf } from './social/war';
import { ApproachTask, EatTask, GatherTask, GoHomeTask, SleepTask, WanderTask, restFor, type Task } from './tasks';

type Option = { score: number; make: () => Task | null };

/**
 * Reflex layer (utility AI): scores every option by needs and personality and tries the best.
 * A bit of noise keeps even identical personalities from acting like robots.
 * The LLM mind sits on top; this layer takes over when it's unavailable and in emergencies.
 */
export function chooseTask(agent: Agent, ctx: SimContext): Task {
  const p = agent.personality;
  const { food, energy } = agent.needs;
  const night = isNight(ctx.clock.timeOfDay);
  const hunger = (100 - food) / 100;
  const tiredness = (100 - energy) / 100;
  const inv = agent.inventory;
  const options: Option[] = [];

  if (food < 70 && inv.berry) options.push({ score: 0.6 + hunger * 1.5, make: () => new EatTask() });
  if (food < 55 && !inv.berry) {
    options.push({
      score: 0.3 + hunger * 1.3,
      // No berry bush nearby and really hungry: go search for food.
      make: () => GatherTask.create(agent, ctx, 'bush', 3) ?? (food < 35 ? WanderTask.searchFood(agent, ctx) : null),
    });
  }

  // Curious agents with a light may stay up a little later.
  const nightOwl = agent.bonus('light') > 0 ? 0.3 + p.curiosity * 0.2 : 0;
  if (night) {
    options.push({ score: 0.95 + p.laziness * 0.3 - nightOwl, make: () => GoHomeTask.create(agent, ctx, true) ?? new SleepTask(false) });
  }
  else if (energy < 30) options.push({ score: 0.2 + tiredness * 1.1, make: () => new SleepTask(true) });

  if (agent.hasRoom()) {
    const berryStock = 2 + Math.round(p.caution * 3);
    if ((inv.berry ?? 0) < berryStock) {
      options.push({ score: 0.2 + p.caution * 0.35, make: () => GatherTask.create(agent, ctx, 'bush', 2) });
    }
    // Creative agents tend to stockpile materials for future inventions —
    // but a few bag slots are always kept free for food.
    const materialCap = 3 + Math.round(p.creativity * 6);
    const roomForMaterials = agent.itemCount < agent.capacity - BALANCE.foodReserveSlots;
    if (roomForMaterials && (inv.wood ?? 0) < materialCap) {
      options.push({ score: 0.1 + p.creativity * 0.4, make: () => GatherTask.create(agent, ctx, 'tree', 2) });
    }
    if (roomForMaterials && (inv.stone ?? 0) < materialCap) {
      options.push({ score: 0.1 + p.creativity * 0.4, make: () => GatherTask.create(agent, ctx, 'rock', 2) });
    }
  }

  // Emotions: the sad rest, the happy roam, the scared stockpile food, the lonely seek company.
  const e = agent.emotions.values;
  options.push({
    score: (0.2 + p.curiosity * 0.5 + e.joy * 0.2) * (night ? 0.3 : 1) * (1 - e.sadness * 0.5),
    make: () => WanderTask.create(agent, ctx),
  });
  options.push({ score: 0.15 + p.laziness * 0.4 + e.sadness * 0.4 + e.fear * 0.2, make: () => restFor(ctx, p.laziness) });
  if (e.fear > 0.3 && agent.hasRoom()) {
    options.push({ score: 0.2 + e.fear * 0.4, make: () => GatherTask.create(agent, ctx, 'bush', 2) });
  }
  const lonely = e.loneliness * (0.3 + p.sociability);
  if (!night && lonely > 0.25) {
    options.push({
      score: 0.2 + lonely * 1.2,
      make: () => {
        const friend = ctx.agents
          .filter((a) => a !== agent && a.action !== 'sleep' && !a.fainted)
          .sort((a, b) => Math.hypot(a.x - agent.x, a.y - agent.y) - Math.hypot(b.x - agent.x, b.y - agent.y))[0];
        if (!friend) return null;
        return ApproachTask.create(agent, ctx, friend, () => ctx.startConversation(agent, friend, 'I was feeling lonely.'));
      },
    });
  }

  // An angry, aggressive agent may attack someone they dislike on sight.
  const near = (r: number) => ctx.agents.filter((a) => a !== agent && !a.fainted && a.action !== 'sleep' && Math.hypot(a.x - agent.x, a.y - agent.y) <= r);
  if (e.anger > 0.4 && p.aggression > 0.5) {
    const enemy = near(5).find((a) => agent.relations.get(a.id).affection < -0.15 && !agent.allies.has(a.id));
    if (enemy) options.push({ score: 0.3 + e.anger * 0.8 + p.aggression * 0.3, make: () => new AttackTask(enemy) });
  }
  // A very aggressive, hungry agent may try to rob a lone stranger.
  if (p.aggression > 0.75 && food < 45 && !inv.berry) {
    const prey = near(5).find((a) => (a.inventory.berry ?? 0) >= 2 && !agent.allies.has(a.id) && a.allies.size === 0 && a.needs.health < agent.needs.health);
    if (prey) options.push({ score: 0.4 + hunger * 0.6, make: () => new AttackTask(prey) });
  }
  // A desperate, morally flexible agent may pinch a neighbor's berries.
  if (food < 20 && !inv.berry && p.aggression > 0.4) {
    const mark = near(6).find((a) => (a.inventory.berry ?? 0) >= 2 && !agent.allies.has(a.id));
    if (mark) options.push({ score: 0.3 + hunger * 0.6 + p.aggression * 0.2, make: () => new StealTask(mark, 'berry') });
  }

  // War: attack nearby enemies (if strong enough); aggressive agents raid enemy homes.
  const enemies = ctx.wars.enemiesOf(agent.id).map((id) => ctx.agents.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => !!a);
  if (enemies.length && agent.needs.health > 40) {
    const close = enemies.find((en) => !en.fainted && en.insideId == null && Math.hypot(en.x - agent.x, en.y - agent.y) < 6);
    if (close && (p.aggression > 0.3 || agent.allies.size > 0)) options.push({ score: 0.5 + p.aggression * 0.5 + e.anger * 0.3, make: () => new AttackTask(close) });
    if (p.aggression > 0.5 && !night) {
      const en = enemies[Math.floor(ctx.rng() * enemies.length)];
      const struct = raidTargetOf(en, ctx);
      if (struct) options.push({ score: 0.15 + p.aggression * 0.4 + (agent.vehicle?.components.some((c) => c.type === 'damage') ? 0.3 : 0), make: () => new RaidTask(struct) });
    }
  }

  // Market: sell surplus, buy what's missing, collect the account.
  if (!night && agent.marketCooldown <= 0 && ctx.world.market) {
    const acc = ctx.market.accounts.get(agent.id);
    if (acc && Object.keys(acc).length) options.push({ score: 0.35, make: () => MarketTask.create(agent, ctx, { op: 'collect' }) });
    const prices = ctx.market.prices(ctx.clock.day);
    for (const item of ['wood', 'stone', 'fiber'] as const) {
      const have = inv[item] ?? 0;
      const ref = prices[item].last ?? prices[item].bid ?? 2;
      const keep = item === 'fiber' ? 1 : 2 + Math.round(p.creativity * 2);
      if (have > keep) {
        // Sells cheap when hungry, otherwise at (or a bit above) the market price.
        const price = Math.max(1, food < 35 ? ref - 1 : ref + (p.aggression > 0.6 ? 1 : 0));
        options.push({ score: 0.12 + (food < 35 && !inv.berry ? 0.5 : 0) + (1 - p.caution) * 0.1, make: () => MarketTask.create(agent, ctx, { op: 'sell', item, qty: have - keep, price }) });
      }
    }
    const berries = inv.berry ?? 0;
    // A (creative) agent with plenty of berries places a buy order for materials, even with no sellers yet.
    if (berries >= 5 && p.creativity > 0.3 && !ctx.market.ordersOf(agent.id).some((o) => o.side === 'buy')) {
      const need = (inv.stone ?? 0) < 2 ? 'stone' : (inv.wood ?? 0) < 2 ? 'wood' : (inv.fiber ?? 0) < 1 ? 'fiber' : null;
      if (need) {
        const ref = prices[need].ask ?? prices[need].last ?? 2;
        const price = Math.min(ref, Math.floor(berries / 2));
        if (price >= 1) options.push({ score: 0.15 + p.creativity * 0.25, make: () => MarketTask.create(agent, ctx, { op: 'buy', item: need, qty: 2, price }) });
      }
    }
  }

  // Joyrides (curious and happy agents)
  if (agent.vehicle && !night) options.push({ score: 0.1 + p.curiosity * 0.3 + e.joy * 0.2, make: () => WanderTask.joyride(agent, ctx) });
  // Claiming land: careful or aggressive agents with a home plant a flag.
  if (agent.homeId != null && !flagOf(ctx.world, agent.id) && (inv.wood ?? 0) >= 2) {
    options.push({ score: 0.1 + Math.max(p.caution, p.aggression) * 0.3, make: () => new ClaimTask() });
  }

  // Using known recipes: build a home if homeless, rebuild missing tools.
  const canAfford = (b: Blueprint) => Object.entries(b.materials).every(([k, n]) => (inv[k as keyof typeof inv] ?? 0) >= (n ?? 0));
  for (const id of agent.known) {
    const bp = ctx.blueprints.get(id);
    if (!bp || !canAfford(bp) || bp.kind === 'golem') continue;
    if (bp.kind === 'structure') {
      if (agent.homeId == null && bp.components.some((c) => c.type === 'shelter')) {
        options.push({ score: 0.35 + p.creativity * 0.3, make: () => new CraftTask(bp) });
      }
    } else if (bp.kind === 'consumable' ? !agent.equipment.some((e) => e.blueprintId === bp.id) : bp.components.some((c) => agent.bonus(c.type) < c.power)) {
      options.push({ score: 0.15 + p.creativity * 0.25, make: () => new CraftTask(bp) });
    }
  }

  for (const o of options) o.score += ctx.rng() * 0.25;
  options.sort((a, b) => b.score - a.score);
  for (const o of options) {
    const task = o.make();
    if (task) return task;
  }
  return restFor(ctx, p.laziness);
}
