import { COMPONENTS, type Blueprint } from '../../shared/invention';
import { ITEMS, type AgentAction, type ItemType } from '../../shared/protocol';
import type { Agent } from '../agent';
import type { SimContext } from '../context';
import type { Task, TaskStatus } from '../tasks';
import { DESIGN_SCHEMA, MAX_EQUIPMENT, designPrompt, parseDesign, validateDesign, workTicksFor, type Design } from './engine';

const compText = (b: Pick<Blueprint, 'components'>) => b.components.map((c) => `${COMPONENTS[c.type].emoji}${c.power}`).join(' ');

/** Builds a known recipe: spends materials and effort, then puts the result into equipment or the world. */
export class CraftTask implements Task {
  readonly kind = 'craft';
  readonly label: string;
  action: AgentAction = 'gather';
  progress: number | null = 0;
  private started = false;
  private work = 0;
  private site: { x: number; y: number } | null = null;

  constructor(
    private bp: Blueprint,
    private invented = false,
  ) {
    this.label = `Building ${bp.name}`;
  }

  step(agent: Agent, ctx: SimContext): TaskStatus {
    if (!this.started) {
      const missing = (Object.entries(this.bp.materials) as [ItemType, number][]).find(([k, n]) => (agent.inventory[k] ?? 0) < n);
      if (missing) {
        agent.mind.remember(`I didn't have enough ${ITEMS[missing[0]].name.toLowerCase()} to build ${this.bp.name}.`, ctx.clock);
        return 'failed';
      }
      if (this.bp.kind === 'structure') {
        const shelter = this.bp.components.find((c) => c.type === 'shelter')?.power ?? 0;
        const home = agent.homeId != null ? ctx.world.objectById(agent.homeId) : undefined;
        if (shelter > 0 && home && (home.structure?.shelter ?? 0) >= shelter) {
          agent.mind.remember(`I already have ${home.structure?.name ?? 'a home'}; no need for a new one unless it's better.`, ctx.clock);
          return 'failed';
        }
        const others = ctx.world.map.objects.filter((o) => o.structure?.ownerId === agent.id && !o.structure.shelter && o.structure.shape !== 'flag' && o.structure.shape !== 'grave');
        if (!shelter && others.length >= 2) {
          agent.mind.remember('I already have two structures; no room for more.', ctx.clock);
          return 'failed';
        }
        this.site = findBuildSite(agent, ctx);
        if (!this.site) {
          agent.mind.remember(`I couldn't find a free spot to build ${this.bp.name}.`, ctx.clock);
          return 'failed';
        }
      } else if (agent.equipment.length >= MAX_EQUIPMENT) {
        agent.equipment.shift(); // drop the oldest item
      }
      for (const [k, n] of Object.entries(this.bp.materials) as [ItemType, number][]) agent.removeItem(k, n);
      this.started = true;
      agent.say('🔨', 30);
    }

    if (this.site) agent.facing = this.site.x + 0.5 > agent.x ? 1 : -1;
    this.progress = ++this.work / this.bp.workTicks;
    if (this.work < this.bp.workTicks) return 'running';

    this.complete(agent, ctx);
    return 'done';
  }

  private complete(agent: Agent, ctx: SimContext) {
    const bp = this.bp;
    if (bp.kind === 'structure' && this.site) {
      const power = (t: string) => bp.components.find((c) => c.type === t)?.power ?? 0;
      const obj = ctx.world.addStructure(this.site.x, this.site.y, {
        blueprintId: bp.id,
        name: bp.name,
        kind: bp.kind,
        shape: bp.shape,
        color: bp.color,
        ownerId: agent.id,
        ownerName: agent.name,
        shelter: power('shelter'),
        light: power('light'),
        defense: power('defense'),
      });
      const current = agent.homeId != null ? ctx.world.objectById(agent.homeId) : undefined;
      if (power('shelter') > 0 && (!current || (current.structure?.shelter ?? 0) <= power('shelter'))) {
        if (current) {
          // The old house is taken down (anyone inside steps out).
          for (const a of ctx.agents) if (a.insideId === current.id) a.exit();
          ctx.world.removeObject(current);
          ctx.log(`${agent.name} took down their old home and built ${bp.name} instead`, agent.id);
        }
        agent.homeId = obj.id;
        agent.mind.remember(`I have a home now: ${bp.name}.`, ctx.clock);
      }
    } else if (bp.kind === 'golem') {
      ctx.spawnGolem(agent, bp);
    } else {
      const heal = bp.components.find((c) => c.type === 'heal')?.power ?? 0;
      agent.equipment.push({
        blueprintId: bp.id,
        name: bp.name,
        kind: bp.kind,
        components: bp.components,
        shape: bp.shape,
        color: bp.color,
        uses: bp.kind === 'consumable' ? 1 + heal : null,
      });
    }

    agent.emotions.feel('pride', this.invented ? 0.35 : 0.12);
    agent.emotions.feel('joy', this.invented ? 0.2 : 0.06);
    agent.gainKnowledge(this.invented ? 15 : 6, ctx);
    agent.say(this.invented ? '✨' : '🔨', 30);
    ctx.log(
      this.invented
        ? `🔨 ${agent.name} invented something new: “${bp.name}” ${compText(bp)}`
        : `${agent.name} built a ${bp.name} ${compText(bp)}`,
      agent.id,
    );
    ctx.emit({ type: this.invented ? 'invented' : 'crafted', agent, blueprint: bp });

    // Learning by watching: curious inhabitants nearby may pick up the recipe.
    for (const other of ctx.agents) {
      if (other === agent || other.action === 'sleep' || other.knows(bp.id) || other.isGolem) continue;
      if (Math.hypot(other.x - agent.x, other.y - agent.y) > 5) continue;
      if (ctx.rng() < 0.25 + other.personality.curiosity * 0.5) {
        other.learn(bp, ctx, `by watching ${agent.name}`);
      }
    }
  }
}

/** Designs a new recipe with the LLM, validates it in the engine and, if valid, starts building it. */
export class InventTask implements Task {
  readonly kind = 'invent';
  label = 'Designing something new';
  action: AgentAction = 'idle';
  progress: number | null = null;
  private requested = false;
  private design: Design | null = null;
  private failed = false;
  private craft: CraftTask | null = null;
  private startedAt = Date.now();

  constructor(private idea: string) {}

  step(agent: Agent, ctx: SimContext): TaskStatus {
    if (this.craft) {
      const status = this.craft.step(agent, ctx);
      this.action = this.craft.action;
      this.progress = this.craft.progress;
      return status;
    }
    if (!this.requested) {
      if (!ctx.llm.available) return 'failed';
      this.requested = true;
      agent.say('💡', 600);
      const known = [...agent.known].map((id) => ctx.blueprints.get(id)).filter((b): b is Blueprint => !!b);
      ctx.llm
        .request({
          system: agent.systemPrompt(),
          user: designPrompt(agent, this.idea, known),
          schema: DESIGN_SCHEMA,
          temperature: 1,
          meta: { kind: 'design', idea: this.idea, tech: agent.tech, inventory: { ...agent.inventory }, name: agent.name },
        })
        .then((text) => {
          this.design = parseDesign(text);
          if (!this.design) this.failed = true;
        })
        .catch(() => {
          this.failed = true;
        });
      return 'running';
    }
    if (this.failed || Date.now() - this.startedAt > 30_000) {
      if (agent.bubble === '💡') agent.bubble = null;
      return 'failed';
    }
    if (!this.design) return 'running';
    if (agent.bubble === '💡') agent.bubble = null;

    const d = this.design;
    if (d.thought) agent.mind.thought = d.thought;
    const errors = validateDesign(d, agent);
    if (errors.length) {
      ctx.log(`💥 ${agent.name}'s “${d.name}” design failed: ${errors[0]}`, agent.id);
      agent.mind.remember(`My “${d.name}” invention failed: ${errors.join(' ')}`, ctx.clock);
      agent.emotions.feel('sadness', 0.12);
      agent.emotions.feel('anger', 0.05 + agent.personality.aggression * 0.1);
      agent.gainKnowledge(4, ctx); // failure teaches too
      agent.say('💥', 30);
      ctx.emit({ type: 'invention_failed', agent });
      return 'failed';
    }

    // Same name and same effects as a known recipe: that's rebuilding, not a new invention.
    const same = [...agent.known]
      .map((id) => ctx.blueprints.get(id))
      .find((b) => b && b.name.toLowerCase() === d.name.toLowerCase() && JSON.stringify(b.components) === JSON.stringify(d.components));
    if (same) {
      this.label = `Building ${same.name}`;
      this.craft = new CraftTask(same, false);
      return 'running';
    }

    const bp: Blueprint = {
      id: `bp${ctx.blueprints.size + 1}`,
      name: d.name,
      kind: d.kind,
      description: d.description,
      components: d.components,
      materials: d.materials,
      shape: d.shape,
      color: d.color,
      inventorId: agent.id,
      inventorName: agent.name,
      day: ctx.clock.day,
      workTicks: workTicksFor(d),
    };
    ctx.addBlueprint(bp);
    agent.known.add(bp.id);
    this.label = `Building ${bp.name}`;
    this.craft = new CraftTask(bp, true);
    return 'running';
  }
}

function findBuildSite(agent: Agent, ctx: SimContext): { x: number; y: number } | null {
  const { x, y } = agent.tile;
  const candidates: { x: number; y: number }[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const tx = x + dx;
      const ty = y + dy;
      if (!ctx.world.isFree(tx, ty)) continue;
      if (ctx.agents.some((a) => a.tile.x === tx && a.tile.y === ty)) continue;
      // Must not trap anyone (including the builder) or block passages.
      if (ctx.world.wouldTrap(tx, ty, ctx.agents.map((a) => a.tile))) continue;
      candidates.push({ x: tx, y: ty });
    }
  }
  // Prefer orthogonal neighbors so diagonal passages stay open.
  candidates.sort((a, b) => Math.abs(a.x - x) + Math.abs(a.y - y) - (Math.abs(b.x - x) + Math.abs(b.y - y)));
  return candidates[0] ?? null;
}
