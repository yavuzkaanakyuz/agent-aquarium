import { COMPONENTS, TECH_THRESHOLDS } from '../../shared/invention';
import { EMOTION_META, ITEMS, formatTime, isNight, type ItemType, type ObjectType, type Personality } from '../../shared/protocol';
import { describeBlueprint } from '../invention/engine';
import { flags, territoryOwnerAt } from '../social/territory';
import type { Agent } from '../agent';
import { BALANCE } from '../balance';
import type { SimContext } from '../context';
import { findNearest } from '../pathfinding';

const SOURCES: Record<'berry' | 'wood' | 'stone', ObjectType> = { berry: 'bush', wood: 'tree', stone: 'rock' };
const NEARBY_RADIUS = 8;

/** What an agent perceives right now: rendered into the prompt and also handed to the mock mind as structured data. */
export interface Observation {
  name: string;
  personality: Personality;
  day: number;
  time: string;
  night: boolean;
  needs: { food: number; energy: number; health: number };
  inventory: Partial<Record<ItemType, number>>;
  itemCount: number;
  capacity: number;
  nearest: Partial<Record<'berry' | 'wood' | 'stone', { steps: number; dir: string }>>;
  nearby: { name: string; dist: number; dir: string; doing: string; note: string }[];
  memories: string[];
  plan: string | null;
  feelings: string;
  loneliness: number;
  longTerm: string | null;
  relations: { name: string; label: string; opinion: string | null }[];
  tech: number;
  knowledge: number;
  equipment: string[];
  knownBlueprints: string[];
  knownNames: string[];
  home: string | null;
  hasHome: boolean;
  hasFlag: boolean;
  creativity: number;
  territory: string;
  wars: string[];
  market: string;
  vehicle: string | null;
  inside: boolean;
}

export function direction(dx: number, dy: number): string {
  if (Math.hypot(dx, dy) < 1.2) return 'right next to you';
  const deg = (Math.atan2(-dy, dx) * 180) / Math.PI; // up on screen = north
  const names = ['to the east', 'to the northeast', 'to the north', 'to the northwest', 'to the west', 'to the southwest', 'to the south', 'to the southeast'];
  return names[Math.round(((deg + 360) % 360) / 45) % 8];
}

export function observe(agent: Agent, ctx: SimContext): Observation {
  const nearest: Observation['nearest'] = {};
  for (const [item, type] of Object.entries(SOURCES) as ['berry' | 'wood' | 'stone', ObjectType][]) {
    const found = findNearest(ctx.world, agent.tile, BALANCE.senseRadius, (o) => o.type === type && o.amount > 0);
    if (found) nearest[item] = { steps: found.path.length, dir: direction(found.obj.x + 0.5 - agent.x, found.obj.y + 0.5 - agent.y) };
  }
  const nearby = ctx.agents
    .filter((a) => a !== agent)
    .map((a) => ({ a, dist: Math.hypot(a.x - agent.x, a.y - agent.y) }))
    .filter(({ dist }) => dist <= NEARBY_RADIUS)
    .sort((p, q) => p.dist - q.dist)
    .map(({ a, dist }) => ({
      name: a.name,
      dist: Math.round(dist),
      dir: direction(a.x - agent.x, a.y - agent.y),
      doing: a.fainted ? 'unconscious' : (a.task?.label.toLowerCase() ?? 'idle'),
      note: [
        `health ${Math.round(a.needs.health)}`,
        a.emotions.mood !== 'calm' ? EMOTION_META[a.emotions.mood].name.toLowerCase() : '',
        a.bonus('damage') ? 'armed' : '',
        agent.allies.has(a.id) ? 'your ally' : '',
        a.isGolem ? 'golem' : '',
      ].filter(Boolean).join(', '),
    }));

  return {
    name: agent.name,
    personality: agent.personality,
    day: ctx.clock.day,
    time: formatTime(ctx.clock.timeOfDay),
    night: isNight(ctx.clock.timeOfDay),
    needs: {
      food: Math.round(agent.needs.food),
      energy: Math.round(agent.needs.energy),
      health: Math.round(agent.needs.health),
    },
    inventory: { ...agent.inventory },
    itemCount: agent.itemCount,
    capacity: agent.capacity,
    nearest,
    nearby,
    memories: agent.mind.recentMemories(8),
    plan: agent.mind.plan,
    feelings: agent.emotions.describe(),
    loneliness: agent.emotions.values.loneliness,
    longTerm: agent.mind.longTerm,
    tech: agent.tech,
    knowledge: Math.round(agent.knowledge),
    equipment: agent.equipment.map(
      (e) => `${e.name} (${e.components.map((c) => `${COMPONENTS[c.type].name.toLowerCase()} ${c.power}`).join(', ')}${e.uses != null ? `, ${e.uses} uses left` : ''})`,
    ),
    knownBlueprints: [...agent.known].flatMap((id) => {
      const b = ctx.blueprints.get(id);
      return b ? [describeBlueprint(b)] : [];
    }),
    knownNames: [...agent.known].flatMap((id) => ctx.blueprints.get(id)?.name ?? []),
    home: (() => {
      const h = agent.homeId != null ? ctx.world.objectById(agent.homeId) : undefined;
      if (!h) return null;
      const d = Math.hypot(h.x + 0.5 - agent.x, h.y + 0.5 - agent.y);
      return `${h.structure?.name ?? 'home'} — ${d < 2.2 ? 'right next to you' : `${Math.round(d)} tiles ${direction(h.x + 0.5 - agent.x, h.y + 0.5 - agent.y)}`}`;
    })(),
    hasHome: agent.homeId != null,
    hasFlag: flags(ctx.world).some((f) => f.structure!.ownerId === agent.id),
    creativity: agent.personality.creativity,
    territory: (() => {
      const here = territoryOwnerAt(ctx.world, agent.tile.x, agent.tile.y);
      const mine = flags(ctx.world).find((f) => f.structure!.ownerId === agent.id);
      const parts = [
        here ? (here.structure!.ownerId === agent.id ? 'You are on your own land.' : `You are on ${here.structure!.ownerName}'s land.`) : "You are on no one's land.",
        mine ? '' : "You don't have land (a flag) yet.",
      ];
      const others = flags(ctx.world)
        .filter((f) => f.structure!.ownerId !== agent.id)
        .map((f) => `${f.structure!.ownerName} (${Math.round(Math.hypot(f.x - agent.x, f.y - agent.y))} tiles ${direction(f.x - agent.x, f.y - agent.y)})`);
      if (others.length) parts.push(`Other lands: ${others.join(', ')}.`);
      return parts.filter(Boolean).join(' ');
    })(),
    wars: ctx.wars.enemiesOf(agent.id).flatMap((id) => ctx.agents.find((a) => a.id === id)?.name ?? []),
    market: (() => {
      const m = ctx.world.market;
      const where = m ? `The marketplace is ${Math.round(Math.hypot(m.x - agent.x, m.y - agent.y))} tiles ${direction(m.x - agent.x, m.y - agent.y)}.` : '';
      return `${where}\n${ctx.market.describe(agent, ctx.clock.day)}`;
    })(),
    vehicle: agent.vehicle ? `${agent.vehicle.name} (${agent.vehicle.uses ?? '?'} uses left)` : null,
    inside: agent.insideId != null,
    relations: agent.relations
      .snapshot(new Map(ctx.agents.map((a) => [a.id, a.name])))
      .map((r) => ({ name: r.name, label: r.label, opinion: r.opinion })),
  };
}

// ---------- prompt ----------
const TRAITS: [keyof Personality, string, string, string][] = [
  ['curiosity', 'Curiosity', 'you long to explore new places and things', 'you like to stay where you know'],
  ['sociability', 'Sociability', 'you love company and conversation', 'you prefer to be alone'],
  ['creativity', 'Creativity', 'you dream of building, collecting and inventing things', 'you think in plain, practical terms'],
  ['aggression', 'Aggression', 'you are impatient, harsh and quarrelsome', 'you are gentle and peaceful'],
  ['caution', 'Caution', 'you avoid risk and always keep something in reserve', 'you rarely save and live in the moment'],
  ['laziness', 'Laziness', 'you love resting and taking life slowly', 'you are hard-working and energetic'],
];

const level = (v: number) => (v >= 0.75 ? 'very high' : v >= 0.5 ? 'high' : v >= 0.25 ? 'low' : 'very low');

/** Strong, concrete motives for pronounced temperaments — "you can be a bit harsh" is not enough for a model. */
function drives(p: Personality): string[] {
  const out: string[] = [];
  if (p.aggression >= 0.75) {
    out.push(
      "Power is your language. You prefer solving problems by force rather than talk. If someone enters your land, takes something from you or stands in your way, you don't let it go unpunished. When you see someone weak or alone, you see an opportunity: you can take what you want and, if needed, fight them and loot their bag. Sharing is not for you; your tribe's interest comes before everyone else's.",
    );
  } else if (p.aggression >= 0.55) {
    out.push('You are competitive and tough. If you are wronged you strike back; you will fight for what is yours.');
  } else if (p.aggression < 0.2) {
    out.push('You hate violence and try to settle every disagreement by talking.');
  }
  if (p.caution < 0.25) out.push('You are not afraid of risk; you are bold and sometimes rush in without thinking.');
  if (p.caution > 0.75) out.push('You are very careful; you stay away from danger and never turn your back on someone you do not trust.');
  if (p.sociability < 0.2) out.push('You do not trust easily and keep strangers at a distance.');
  return out;
}

export function systemPrompt(agent: Agent): string {
  const traits = TRAITS.map(([k, label, hi, lo]) => {
    const v = agent.personality[k];
    return `- ${label}: ${level(v)} (${v.toFixed(2)}) — ${v >= 0.5 ? hi : lo}`;
  }).join('\n');
  const motives = drives(agent.personality);

  return `You are ${agent.name}, a tiny, cute pixel creature living on a small island called "Agent Aquarium". Other inhabitants like you live here too; each one makes its own decisions.

Your personality:
${traits}
${motives.length ? `\nYour temperament:\n${motives.map((m) => `- ${m}`).join('\n')}\n` : ''}
This is a game world. Stay true to your personality: not everyone has to be good or peaceful. Let your decisions, words and inner voice reflect your temperament; do what someone like you would do, not what is "right" or "polite".

Rules of the world:
- Fullness drops over time; at 0 your health falls and you eventually faint. One berry adds +${BALANCE.food.perBerry} fullness.
- Energy drops as you move and refills when you sleep. Sleeping at night is natural.
- Every job takes time and effort: picking berries is quick, chopping wood takes longer, breaking stone takes longest. Resources regrow over time.
- Your bag holds ${BALANCE.inventoryCapacity} items (more with storage gear). Wood, stone and fiber are materials for tools, homes and inventions.

Actions (always choose ONE next action):
- gather + target (berry|wood|stone): go to the nearest source and gather it
- eat: eat a berry from your bag (you must have one)
- sleep: sleep or take a nap
- explore + direction (north|south|east|west|any): set off exploring in that direction
- rest: rest a little and watch around
- approach + who (an inhabitant's name): walk over to them
- talk + who: have a conversation with them (walks over first if far); trades can happen in conversation
- invent + idea: design something new (tool, weapon, armor, vehicle, home/structure, potion, golem) and try to build it from the materials in your bag. Powerful things need more materials and a higher tech level (e.g. flight needs level 4). A failed design wastes time but teaches you.
- craft + item: build a recipe you already know again
- go_home: go back home (if you have one)
- attack + who: attack them (if they faint you loot their bag). Attacking ruins relationships, witnesses turn against you, the victim may fight back or their allies may come to help.
- steal + who (+ target: the item you want): secretly take from their bag; if caught, your relationship suffers.
- ride: take a long ride with your vehicle (car, boat…); vehicles wear out with use
- claim: plant a flag with 2 wood and declare the area around it (5 tiles) your land. If you see someone gathering on your land you get angry.
- declare_war + who: declare war on them and their allies; your allies join the war too. Peace is made in conversation.
- raid + who: raid their home or flag and try to destroy it (damage on a vehicle counts as siege power)
- market + market_op (sell/buy/cancel) + target (wood/stone/fiber) + qty + price: walk to the marketplace and place an order. Selling escrows your materials, buying escrows your berries; when orders match, the proceeds go to your market account (collect them when you visit). With market_op "none" you just go and collect your account.

ECONOMY: Berries are both food and money. Every berry you eat makes you poorer; if you save you get rich but may go hungry. Materials can be bought and sold for berries at the market; supply and demand set the price.

Power and conflict are part of this world too. Knock someone out and you loot their bag; raze their home and their land is yours; a war declaration pulls your allies in with you. The cost: you make enemies, witnesses turn against you, retaliation may come. Peace, trade and alliances are powerful too. Your temperament and your interests decide which you choose. In conversations you can form alliances, make peace with rivals and start a family with someone you love.

Inventions and technology: as you explore, build and learn, your knowledge and tech level rise. A home lets you rest better; tools speed up gathering; light makes the night less frightening; storage enlarges your bag; vehicles speed you up and wings let you fly. You can learn a recipe by watching someone build it.

In "thought", write a short first-person inner voice in English that reflects your personality. If someone is nearby you can say something to them with "say"; leave it "" if you stay silent. If you form or change a long-term intention, write it in "plan".`;
}

export function userPrompt(o: Observation): string {
  const inv = Object.entries(o.inventory)
    .filter(([, n]) => n)
    .map(([k, n]) => `${ITEMS[k as ItemType].name.toLowerCase()} ${n}`)
    .join(', ');
  const res = (['berry', 'wood', 'stone'] as const)
    .map((k) => {
      const n = o.nearest[k];
      const label = { berry: 'berry bush', wood: 'tree', stone: 'rock' }[k];
      if (!n) return `- No ${label} nearby`;
      return `- Nearest ${label}: ${n.steps <= 1 ? 'right next to you' : `${n.steps} steps ${n.dir}`}`;
    })
    .join('\n');
  const people = o.nearby.length
    ? o.nearby.map((p) => `- ${p.name}: ${p.dist <= 1 ? 'right next to you' : `${p.dist} tiles ${p.dir}`}, ${p.doing} (${p.note})`).join('\n')
    : '- Nobody nearby';
  const mem = o.memories.length ? o.memories.map((m) => `- ${m}`).join('\n') : '- (no memories yet)';

  const rels = o.relations.length
    ? o.relations.map((r) => `- ${r.name}: ${r.label}${r.opinion ? ` — "${r.opinion}"` : ''}`).join('\n')
    : "- You don't know anyone yet";

  return `${o.longTerm ? `What you know about yourself: ${o.longTerm}\n\n` : ''}Now: Day ${o.day}, ${o.time} (${o.night ? 'night' : 'day'})
Your needs: fullness ${o.needs.food}/100, energy ${o.needs.energy}/100, health ${o.needs.health}/100
Your feelings: ${o.feelings}
Your bag (${o.itemCount}/${o.capacity}): ${inv || 'empty'}
Your plan: ${o.plan ?? 'none yet'}

Technology: level ${o.tech} (knowledge ${o.knowledge}${(() => {
    const next = TECH_THRESHOLDS.find((t) => t > o.knowledge);
    return next ? `, next level at ${next}` : ', highest level';
  })()})
Your equipment: ${o.equipment.length ? o.equipment.join('; ') : 'none'}
Your home: ${o.home ?? 'none'}${o.inside ? ' (you are inside your home right now, safe)' : ''}
Your vehicle: ${o.vehicle ?? 'none'}
Land: ${o.territory}${o.wars.length ? `\n⚔️ YOU ARE AT WAR: ${o.wars.join(', ')} are your enemies.` : ''}
Recipes you know: ${o.knownBlueprints.length ? o.knownBlueprints.join('; ') : 'none yet'}

Surroundings:
${res}

Inhabitants nearby:
${people}

People you know:
${rels}

Market:
${o.market}

Recent memories:
${mem}

What will you do now?`;
}

export function reflectPrompt(agent: Agent, ctx: SimContext, memories: string[]): string {
  const names = new Map(ctx.agents.map((a) => [a.id, a.name]));
  const rels = agent.relations
    .snapshot(names)
    .map((r) => `- ${r.name}: ${r.label} (affection ${r.affection}, trust ${r.trust})${r.opinion ? ` — your old opinion: "${r.opinion}"` : ''}`)
    .join('\n');
  return `Day ${ctx.clock.day} is over; as you fall asleep you think back on the day.

Your old summary: ${agent.mind.longTerm ?? '(none yet — this is your first reflection)'}
Your plan: ${agent.mind.plan ?? 'none'}
Your feelings: ${agent.emotions.describe()}

Recent memories:
${memories.map((m) => `- ${m}`).join('\n')}

People you know:
${rels || '- nobody'}

Keeping what matters from your old summary, write a new 3-4 sentence first-person summary of who you are, what you have been through and what you want. Then write a one-sentence up-to-date opinion of each inhabitant you know.`;
}
