import { ITEMS, TERRITORY_RADIUS, type AgentAction, type ItemType, type WorldObject } from '../../shared/protocol';
import type { Agent } from '../agent';
import type { SimContext } from '../context';
import type { Task, TaskStatus } from '../tasks';
import type { World } from '../world';
import { areAllies } from './combat';

export const CLAIM_COST = 2; // wood

export const flags = (world: World) => world.map.objects.filter((o) => o.structure?.shape === 'flag');
export const flagOf = (world: World, agentId: string) => flags(world).find((f) => f.structure!.ownerId === agentId);

/** Whose land is (x,y) on? The owner of the nearest flag within the radius. */
export function territoryOwnerAt(world: World, x: number, y: number): WorldObject | null {
  let best: WorldObject | null = null;
  let bestD = TERRITORY_RADIUS + 0.5;
  for (const f of flags(world)) {
    const d = Math.hypot(f.x - x, f.y - y);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  return best;
}

/** Claiming land: plants a flag nearby (the old flag is removed). */
export class ClaimTask implements Task {
  readonly kind = 'craft';
  readonly label = 'Planting a flag';
  action: AgentAction = 'gather';
  progress: number | null = 0;
  private work = 0;

  step(agent: Agent, ctx: SimContext): TaskStatus {
    if (this.work === 0) {
      const reason = canClaim(agent, ctx);
      if (reason) {
        agent.mind.remember(reason, ctx.clock);
        return 'failed';
      }
      agent.removeItem('wood', CLAIM_COST);
    }
    this.progress = ++this.work / 60;
    if (this.work < 60) return 'running';

    const old = flagOf(ctx.world, agent.id);
    if (old) ctx.world.removeObject(old);
    const spot = freeNeighbor(agent, ctx);
    if (!spot) {
      agent.addItem('wood', CLAIM_COST);
      return 'failed';
    }
    ctx.world.addStructure(spot.x, spot.y, {
      blueprintId: 'flag', name: `${agent.name}'s land`, kind: 'structure', shape: 'flag', color: agent.color,
      ownerId: agent.id, ownerName: agent.name, shelter: 0, light: 0, defense: 0,
    });
    agent.emotions.feel('pride', 0.2);
    agent.mind.remember('I planted my flag; the land around it is mine now.', ctx.clock);
    ctx.log(`🚩 ${agent.name} claimed this land`, agent.id);
    ctx.emit({ type: 'claimed', agent });
    for (const other of ctx.agents) {
      if (other === agent || Math.hypot(other.x - agent.x, other.y - agent.y) > 8 || areAllies(other, agent)) continue;
      other.mind.remember(`${agent.name} planted a flag near me and claimed land.`, ctx.clock);
    }
    return 'done';
  }
}

function canClaim(agent: Agent, ctx: SimContext): string | null {
  if ((agent.inventory.wood ?? 0) < CLAIM_COST) return `A flag needs ${CLAIM_COST} wood.`;
  for (const f of flags(ctx.world)) {
    const owner = ctx.agents.find((a) => a.id === f.structure!.ownerId);
    if (!owner || owner === agent || areAllies(owner, agent)) continue;
    if (Math.hypot(f.x - agent.x, f.y - agent.y) < TERRITORY_RADIUS * 1.6) return `This is too close to ${owner.name}'s land; I couldn't plant a flag.`;
  }
  if (ctx.world.market && Math.hypot(ctx.world.market.x - agent.x, ctx.world.market.y - agent.y) < TERRITORY_RADIUS) {
    return 'The marketplace belongs to everyone; no flags there.';
  }
  return null;
}

function freeNeighbor(agent: Agent, ctx: SimContext) {
  const { x, y } = agent.tile;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
    if (ctx.world.isFree(x + dx, y + dy) && !ctx.agents.some((a) => a.tile.x === x + dx && a.tile.y === y + dy)) return { x: x + dx, y: y + dy };
  }
  return null;
}

/** Gathering on someone else's land: the owner gets angry if they see it. */
export function onHarvest(agent: Agent, obj: WorldObject, item: ItemType, ctx: SimContext) {
  const flag = territoryOwnerAt(ctx.world, obj.x, obj.y);
  if (!flag) return;
  const owner = ctx.agents.find((a) => a.id === flag.structure!.ownerId);
  if (!owner || owner === agent || areAllies(owner, agent) || owner.isGolem && owner.ownerId === agent.id) return;
  agent.mind.remember(`I gathered ${ITEMS[item].name.toLowerCase()} on ${owner.name}'s land.`, ctx.clock);
  const sees = owner.action !== 'sleep' && owner.insideId == null && Math.hypot(owner.x - agent.x, owner.y - agent.y) < 9;
  if (!sees) return;
  // Aggressive owners react much more harshly to trespassing.
  owner.relations.adjust(agent.id, { affection: -0.06 - owner.personality.aggression * 0.08, trust: -0.05 });
  owner.emotions.feel('anger', 0.06 + owner.personality.aggression * 0.2);
  owner.mind.remember(`${agent.name} gathered ${ITEMS[item].name.toLowerCase()} on my land!`, ctx.clock);
  if (ctx.rng() < 0.3) ctx.log(`🚩 ${agent.name} is gathering on ${owner.name}'s land`, owner.id);
}
