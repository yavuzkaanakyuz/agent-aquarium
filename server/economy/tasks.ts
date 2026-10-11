import type { TradeItem } from '../../shared/economy';
import { ITEMS, type AgentAction } from '../../shared/protocol';
import type { Agent } from '../agent';
import type { SimContext } from '../context';
import { findNearest } from '../pathfinding';
import type { Task, TaskStatus } from '../tasks';

export type MarketOp = { op: 'sell' | 'buy'; item: TradeItem; qty: number; price: number } | { op: 'cancel' } | { op: 'collect' };

/** Walks to the market, collects the account, then places/cancels orders. */
export class MarketTask implements Task {
  readonly kind = 'wander';
  readonly label: string;
  action: AgentAction = 'walk';
  progress = null;

  static create(agent: Agent, ctx: SimContext, op: MarketOp): MarketTask | null {
    const market = ctx.world.market;
    if (!market) return null;
    if (Math.hypot(market.x + 0.5 - agent.x, market.y + 0.5 - agent.y) > 2) {
      const found = findNearest(ctx.world, agent.tile, 80, (o) => o.id === market.id, agent.mobility);
      if (!found) return null;
      agent.setPath(found.path, ctx.world);
    } else agent.path = [];
    return new MarketTask(op);
  }

  private constructor(private op: MarketOp) {
    this.label =
      op.op === 'sell' ? `Going to sell ${ITEMS[op.item].name.toLowerCase()} at the market`
      : op.op === 'buy' ? `Going to buy ${ITEMS[op.item].name.toLowerCase()} at the market`
      : 'Going to the market';
  }

  step(agent: Agent, ctx: SimContext): TaskStatus {
    if (!agent.moveAlongPath(ctx)) return 'running';
    const got = ctx.market.collect(agent);
    if (got.length) {
      agent.say('🧺', 20);
      agent.mind.remember(`Collected from my market account: ${got.join(', ')}.`, ctx.clock);
    }
    const op = this.op;
    if (op.op === 'cancel') {
      ctx.market.cancelAll(agent);
      ctx.market.collect(agent);
      return 'done';
    }
    if (op.op === 'collect') return 'done';
    const err = ctx.market.place(agent, op.op, op.item, op.qty, op.price, ctx);
    if (err) {
      agent.mind.remember(`Couldn't trade at the market: ${err}`, ctx.clock);
      return 'failed';
    }
    agent.say(op.op === 'sell' ? '🏷️' : '🪙', 20);
    ctx.log(
      `🏪 ${agent.name} ${op.op === 'sell' ? 'put up for sale' : 'placed a buy order for'} ${op.qty} ${ITEMS[op.item].emoji} × ${op.price} 🫐`,
      agent.id,
    );
    // Collect deliveries right away if the order matched.
    ctx.market.collect(agent);
    agent.marketCooldown = 400;
    return 'done';
  }
}
