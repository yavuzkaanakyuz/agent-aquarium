import { TRADE_ITEMS, type MarketOrder, type MarketTrade, type PriceInfo, type TradeItem } from '../../shared/economy';
import { ITEMS, type Inventory, type ItemType } from '../../shared/protocol';
import type { Agent } from '../agent';
import type { SimContext } from '../context';

const ORDER_TTL_DAYS = 2;
const MAX_ORDERS_PER_AGENT = 4;
const HISTORY = 60;

/**
 * Central market: an order book. Sellers escrow materials, buyers escrow berries;
 * when prices cross, orders match at the resting order's price. Proceeds land in the inhabitant's
 * "market account" and are moved into their bag on their next visit.
 */
export class Market {
  orders: MarketOrder[] = [];
  trades: MarketTrade[] = [];
  /** Deliveries waiting at the market: agent id → items (berries included) */
  accounts = new Map<string, Inventory>();
  feeRate = 0; // share of berries burned on every trade (admin setting)
  private nextId = 1;

  private credit(agentId: string, item: ItemType, qty: number) {
    if (qty <= 0) return;
    const acc = this.accounts.get(agentId) ?? {};
    acc[item] = (acc[item] ?? 0) + qty;
    this.accounts.set(agentId, acc);
  }

  /** Total berries held in escrow (for supply stats). */
  berriesHeld(): number {
    let sum = 0;
    for (const o of this.orders) if (o.side === 'buy') sum += o.qty * o.price;
    for (const acc of this.accounts.values()) sum += acc.berry ?? 0;
    return sum;
  }

  ordersOf(agentId: string) {
    return this.orders.filter((o) => o.agentId === agentId);
  }

  /** A visiting inhabitant collects as much of their account as fits in their bag. */
  collect(agent: Agent): string[] {
    const acc = this.accounts.get(agent.id);
    if (!acc) return [];
    const got: string[] = [];
    for (const [item, n] of Object.entries(acc) as [ItemType, number][]) {
      const qty = Math.min(n, Math.max(0, agent.capacity - agent.itemCount));
      if (qty <= 0) continue;
      agent.addItem(item, qty);
      acc[item] = n - qty;
      if (!acc[item]) delete acc[item];
      got.push(`${qty} ${ITEMS[item].emoji}`);
    }
    if (!Object.keys(acc).length) this.accounts.delete(agent.id);
    return got;
  }

  /** Places an order; any immediately matching part executes. Returns an explanation on error. */
  place(agent: Agent, side: 'sell' | 'buy', item: TradeItem, qty: number, price: number, ctx: SimContext): string | null {
    if (!TRADE_ITEMS.includes(item)) return "This item can't be traded at the market.";
    qty = Math.max(1, Math.min(10, Math.round(qty)));
    price = Math.max(1, Math.min(20, Math.round(price)));
    if (this.ordersOf(agent.id).length >= MAX_ORDERS_PER_AGENT) return 'I already have too many open orders at the market.';
    if (side === 'sell') {
      const have = agent.inventory[item] ?? 0;
      if (have < 1) return `I have no ${ITEMS[item].name.toLowerCase()} to sell.`;
      qty = Math.min(qty, have);
      agent.removeItem(item, qty);
    } else {
      const berries = agent.inventory.berry ?? 0;
      if (berries < price) return `I don't have ${price} berries; I can't buy.`;
      qty = Math.min(qty, Math.floor(berries / price));
      agent.removeItem('berry', qty * price);
    }
    const order: MarketOrder = { id: this.nextId++, agentId: agent.id, agentName: agent.name, side, item, qty, price, day: ctx.clock.day };
    this.match(order, ctx);
    if (order.qty > 0) this.orders.push(order);
    return null;
  }

  cancelAll(agent: Agent) {
    for (const o of this.ordersOf(agent.id)) this.refund(o);
    this.orders = this.orders.filter((o) => o.agentId !== agent.id);
  }

  private refund(o: MarketOrder) {
    if (o.side === 'sell') this.credit(o.agentId, o.item, o.qty);
    else this.credit(o.agentId, 'berry', o.qty * o.price);
  }

  private match(order: MarketOrder, ctx: SimContext) {
    const book = this.orders
      .filter((o) => o.item === order.item && o.side !== order.side && o.agentId !== order.agentId)
      .filter((o) => (order.side === 'buy' ? o.price <= order.price : o.price >= order.price))
      .sort((a, b) => (order.side === 'buy' ? a.price - b.price : b.price - a.price) || a.id - b.id);
    for (const rest of book) {
      if (order.qty <= 0) break;
      const qty = Math.min(order.qty, rest.qty);
      const price = rest.price; // the resting order's price
      const [buy, sell] = order.side === 'buy' ? [order, rest] : [rest, order];
      // The buyer escrowed at their own price; the difference is refunded.
      const paid = qty * price;
      const fee = Math.floor(paid * this.feeRate);
      this.credit(buy.agentId, buy.item, qty);
      this.credit(buy.agentId, 'berry', qty * (buy.price - price));
      this.credit(sell.agentId, 'berry', paid - fee);
      if (fee) ctx.emit({ type: 'berries', kind: 'burned', qty: fee });
      order.qty -= qty;
      rest.qty -= qty;
      const t: MarketTrade = {
        tick: ctx.clock.tick, day: ctx.clock.day, timeOfDay: ctx.clock.timeOfDay,
        item: order.item, qty, price, buyer: buy.agentName, seller: sell.agentName,
      };
      this.trades.push(t);
      if (this.trades.length > 400) this.trades.shift();
      ctx.log(`💰 Market: ${buy.agentName} bought ${qty} ${ITEMS[order.item].emoji} from ${sell.agentName} (${price} 🫐 each)`, buy.agentId);
      const seller = ctx.agents.find((a) => a.id === sell.agentId);
      const buyer = ctx.agents.find((a) => a.id === buy.agentId);
      seller?.mind.remember(`I sold ${qty} ${ITEMS[order.item].name.toLowerCase()} at the market and earned ${paid - fee} berries (in my account).`, ctx.clock);
      buyer?.mind.remember(`I bought ${qty} ${ITEMS[order.item].name.toLowerCase()} at the market (${price} berries each; in my account).`, ctx.clock);
      if (seller && buyer) ctx.emit({ type: 'trade', from: seller, to: buyer });
    }
    this.orders = this.orders.filter((o) => o.qty > 0);
  }

  /** Expired orders are refunded; accounts of the dead are dissolved. */
  tick(ctx: SimContext) {
    if (ctx.clock.tick % 50 !== 0) return;
    const alive = new Set(ctx.agents.map((a) => a.id));
    const keep: MarketOrder[] = [];
    for (const o of this.orders) {
      if (!alive.has(o.agentId)) continue;
      if (ctx.clock.day - o.day >= ORDER_TTL_DAYS) this.refund(o);
      else keep.push(o);
    }
    this.orders = keep;
    for (const id of [...this.accounts.keys()]) if (!alive.has(id)) this.accounts.delete(id);
  }

  prices(day: number): Record<TradeItem, PriceInfo> {
    const out = {} as Record<TradeItem, PriceInfo>;
    for (const item of TRADE_ITEMS) {
      const trades = this.trades.filter((t) => t.item === item);
      const bids = this.orders.filter((o) => o.item === item && o.side === 'buy').map((o) => o.price);
      const asks = this.orders.filter((o) => o.item === item && o.side === 'sell').map((o) => o.price);
      out[item] = {
        last: trades.at(-1)?.price ?? null,
        bid: bids.length ? Math.max(...bids) : null,
        ask: asks.length ? Math.min(...asks) : null,
        volume: trades.filter((t) => t.day === day).reduce((s, t) => s + t.qty, 0),
        history: trades.slice(-HISTORY).map((t) => ({ tick: t.tick, price: t.price })),
      };
    }
    return out;
  }

  /** Short market summary for the prompt. */
  describe(agent: Agent, day: number): string {
    const p = this.prices(day);
    const lines = TRADE_ITEMS.map((item) => {
      const x = p[item];
      const parts = [
        x.last != null ? `last ${x.last}` : 'no sales yet',
        x.ask != null ? `cheapest ask ${x.ask}` : '',
        x.bid != null ? `best bid ${x.bid}` : '',
      ].filter(Boolean);
      return `- ${ITEMS[item].name}: ${parts.join(', ')} (🫐 per unit)`;
    });
    const mine = this.ordersOf(agent.id).map((o) => `${o.side} ${o.qty} ${o.item} @${o.price}`);
    const acc = this.accounts.get(agent.id);
    const accText = acc ? Object.entries(acc).map(([k, n]) => `${n} ${k}`).join(', ') : '';
    return `${lines.join('\n')}${mine.length ? `\nYour open orders: ${mine.join('; ')}` : ''}${accText ? `\nWaiting in your market account: ${accText} (collect it at the market)` : ''}`;
  }

  serialize() {
    return { orders: this.orders, trades: this.trades, accounts: [...this.accounts.entries()], feeRate: this.feeRate, nextId: this.nextId };
  }

  restore(d: ReturnType<Market['serialize']>) {
    this.orders = d.orders;
    this.trades = d.trades;
    this.accounts = new Map(d.accounts);
    this.feeRate = d.feeRate ?? 0;
    this.nextId = d.nextId ?? 1;
  }
}

