import { DAY_TICKS, type EconomyStats } from '../../shared/protocol';
import { TRADE_ITEMS } from '../../shared/economy';
import type { Agent } from '../agent';
import type { SimEvent } from '../events';
import type { World } from '../world';
import type { Market } from './market';

type Flows = EconomyStats['flows'];
const emptyFlows = (): Flows => ({ harvested: 0, eaten: 0, airdropped: 0, burned: 0, spoiled: 0 });

/** Tracks berry supply and flows; applies the admin's "central bank" settings. */
export class EconomyTracker {
  spoilage = 0; // daily spoilage rate (0..1) — berries in bags
  private today = emptyFlows();
  private day = 0;
  daily: EconomyStats['daily'] = [];

  handle(e: SimEvent) {
    if (e.type !== 'berries') return;
    this.today[e.kind] += e.qty;
  }

  /** Day rollover and spoilage. */
  tick(tick: number, day: number, agents: Agent[], world: World, market: Market, rng: () => number, emit: (e: SimEvent) => void) {
    if (day !== this.day) {
      if (this.day) {
        this.daily.push({ day: this.day, supply: this.supply(agents, world, market).total, harvested: this.today.harvested, eaten: this.today.eaten });
        if (this.daily.length > 30) this.daily.shift();
      }
      this.day = day;
      this.today = emptyFlows();
    }
    // Spoilage: every 100 ticks the matching share of the daily rate rots (probabilistically).
    if (this.spoilage > 0 && tick % 100 === 0) {
      const p = this.spoilage * (100 / DAY_TICKS);
      for (const a of agents) {
        const n = a.inventory.berry ?? 0;
        let lost = 0;
        for (let i = 0; i < n; i++) if (rng() < p) lost++;
        if (lost) {
          a.removeItem('berry', lost);
          emit({ type: 'berries', kind: 'spoiled', qty: lost });
        }
      }
    }
  }

  supply(agents: Agent[], world: World, market: Market) {
    const inventories = agents.reduce((s, a) => s + (a.inventory.berry ?? 0), 0);
    const bushes = world.map.objects.reduce((s, o) => s + (o.type === 'bush' ? o.amount : 0), 0);
    const held = market.berriesHeld();
    return { inventories, bushes, market: held, total: inventories + bushes + held };
  }

  snapshot(day: number, agents: Agent[], world: World, market: Market, marketId: number | null): EconomyStats {
    const prices = market.prices(day);
    const unit = (item: (typeof TRADE_ITEMS)[number]) => prices[item].last ?? prices[item].ask ?? 1;
    const wealth = agents
      .filter((a) => !a.isGolem && a.stage !== 'egg')
      .map((a) => {
        const acc = market.accounts.get(a.id) ?? {};
        const berries = (a.inventory.berry ?? 0) + (acc.berry ?? 0);
        const materials = TRADE_ITEMS.reduce((s, it) => s + ((a.inventory[it] ?? 0) + (acc[it] ?? 0)) * unit(it), 0);
        return { id: a.id, name: a.name, color: a.color, berries, materials: Math.round(materials), netWorth: Math.round(berries + materials) };
      })
      .sort((x, y) => y.netWorth - x.netWorth);
    return {
      day,
      berries: this.supply(agents, world, market),
      flows: { ...this.today },
      daily: this.daily,
      prices,
      wealth,
      gini: gini(wealth.map((w) => w.netWorth)),
      orders: market.orders,
      recentTrades: market.trades.slice(-15).reverse(),
      settings: { scarcity: world.scarcity, spoilage: this.spoilage, fee: market.feeRate },
      marketId,
    };
  }

  serialize() {
    return { spoilage: this.spoilage, daily: this.daily, today: this.today, day: this.day };
  }

  restore(d: ReturnType<EconomyTracker['serialize']>) {
    this.spoilage = d.spoilage ?? 0;
    this.daily = d.daily ?? [];
    this.today = d.today ?? emptyFlows();
    this.day = d.day ?? 0;
  }
}

/** Gini coefficient: 0 = everyone equal, 1 = one agent owns everything. */
function gini(values: number[]): number {
  const v = values.filter((x) => x >= 0).sort((a, b) => a - b);
  const n = v.length;
  const sum = v.reduce((s, x) => s + x, 0);
  if (n < 2 || sum === 0) return 0;
  const weighted = v.reduce((s, x, i) => s + (i + 1) * x, 0);
  return Math.round(((2 * weighted) / (n * sum) - (n + 1) / n) * 100) / 100;
}
