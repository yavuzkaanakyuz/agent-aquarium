import type { Decision } from '../decision';
import type { Observation } from '../perception';
import type { LLMProvider, LLMRequest, LLMResponse } from '../types';

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

/**
 * Fake mind used when no API key is configured: decides with simple rules instead of an LLM,
 * but still exercises the whole pipeline (prompt → JSON → validation → task) end to end. Costs nothing.
 */
export class MockProvider implements LLMProvider {
  readonly name = 'mock';
  readonly model = 'offline-rules';

  constructor(private latencyMs = 250) {}

  async complete(req: LLMRequest, signal: AbortSignal): Promise<LLMResponse> {
    await new Promise((r, reject) => {
      const t = setTimeout(r, this.latencyMs * (1 + Math.random() * 2));
      signal.addEventListener('abort', () => (clearTimeout(t), reject(new Error('abort'))));
    });
    const meta = req.meta as { kind?: string };
    const result =
      meta.kind === 'talk'
        ? talk(meta as TalkMeta)
        : meta.kind === 'reflect'
          ? reflect(meta as ReflectMeta)
          : meta.kind === 'design'
            ? design(meta as DesignMeta)
            : decide(req.meta as Observation);
    const text = JSON.stringify(result);
    return { text, inputTokens: Math.round((req.system.length + req.user.length) / 4), outputTokens: Math.round(text.length / 4) };
  }
}

interface TalkMeta {
  speaker: string;
  listener: string;
  personality: Observation['personality'];
  affection: number;
  turn: number;
  inventory: Observation['inventory'];
  pendingOffer: { want: string | null; wantQty: number } | null;
  pendingPact: 'alliance' | 'peace' | 'family' | null;
  allied: boolean;
  trust: number;
  known: string[];
}

function talk(m: TalkMeta) {
  const p = m.personality;
  const hostile = p.aggression > 0.7 && m.affection < 0.1 && Math.random() < 0.4;
  const tone = hostile ? 'hostile' : p.sociability > 0.4 || m.affection > 0.2 ? 'friendly' : 'neutral';
  const lines = {
    friendly: [`Hi ${m.listener}! So good to see you.`, 'The berries are extra sweet today, right?', 'Have you seen the north side? Amazing!', 'Shall we build a house together someday?', 'Take care, see you!'],
    neutral: ['Hmm, hello.', 'Not bad weather.', 'I was gathering wood.', 'Anyway, back to work.'],
    hostile: ['Get out of my way!', 'Stay away from my bushes.', "I've no time for you."],
  }[tone];
  const none = { give_item: 'none', give_qty: 0, want_item: 'none', want_qty: 0 };
  let offer = none;
  const berries = m.inventory.berry ?? 0;
  if (tone === 'friendly' && m.turn < 3 && berries >= 2 && Math.random() < 0.3) {
    offer = Math.random() < 0.5 ? { ...none, give_item: 'berry', give_qty: 1 } : { give_item: 'berry', give_qty: 2, want_item: 'wood', want_qty: 1 };
  }
  const canPay = m.pendingOffer && (!m.pendingOffer.want || (m.inventory[m.pendingOffer.want as keyof typeof m.inventory] ?? 0) >= m.pendingOffer.wantQty);
  let pact = 'none';
  if (m.pendingPact && (m.affection > 0.15 || (m.pendingPact === 'peace' && p.aggression < 0.6))) pact = `accept_${m.pendingPact}`;
  else if (!m.allied && m.affection > 0.3 && m.trust > 0.1 && Math.random() < 0.3) pact = 'propose_alliance';
  else if (m.affection < -0.1 && p.sociability > 0.5 && Math.random() < 0.4) pact = 'propose_peace';
  else if (m.allied && m.affection > 0.5 && Math.random() < 0.2) pact = 'propose_family';
  const teach = tone === 'friendly' && m.known.length && Math.random() < 0.35 ? m.known[0] : '';
  return {
    pact,
    teach,
    thought: tone === 'hostile' ? 'This one gets on my nerves.' : `Talking with ${m.listener} feels good.`,
    say: m.pendingOffer && canPay ? 'Deal, thank you!' : pick(lines),
    tone,
    end: m.turn >= 3 + Math.floor(Math.random() * 2) || hostile,
    offer,
    accept_offer: Boolean(canPay && tone !== 'hostile'),
  };
}

interface ReflectMeta {
  name: string;
  memories: string[];
  known: { name: string; label: string }[];
}

function reflect(m: ReflectMeta) {
  return {
    summary: `I am ${m.name}. I went through ${m.memories.length} things today; I know the island better and I'm hopeful about tomorrow.`,
    opinions: m.known.map((k) => ({ name: k.name, opinion: k.label === 'tense' || k.label === 'enemy' ? 'I should be careful around them.' : 'Seems like a good one.' })),
  };
}

interface DesignMeta {
  idea: string;
  tech: number;
  inventory: Record<string, number | undefined>;
}

/** A rough recipe based on keywords in the idea and the materials at hand; sometimes overshoots the budget on purpose (for testing). */
function design(m: DesignMeta) {
  const inv = (k: string) => m.inventory[k] ?? 0;
  const idea = m.idea.toLowerCase();
  const overreach = Math.random() < 0.2 ? 2 : 0;
  const mats = (wood: number, stone: number, fiber: number) => ({
    wood: Math.min(inv('wood'), wood), stone: Math.min(inv('stone'), stone), fiber: Math.min(inv('fiber'), fiber), berry: 0,
  });
  if (/golem|helper/.test(idea) && m.tech >= 4) {
    return { thought: 'I will breathe life into stone!', name: 'Stone Golem', kind: 'golem', description: 'Gathers resources for me.',
      components: [{ type: 'automaton', power: 1 }, { type: 'damage', power: 1 }], materials: mats(3, 4, 1), shape: 'golem', color: '#8d929c' };
  }
  if (/fly|wing|glider/.test(idea) || (m.tech >= 4 && Math.random() < 0.4)) {
    return { thought: "I'll catch the wind and glide!", name: 'Leaf Glider', kind: 'vehicle', description: 'Glides over the water.',
      components: [{ type: 'flight', power: 1 + overreach }], materials: mats(5, 0, 4), shape: 'glider', color: '#8fd17a' };
  }
  if (/home|house|hut|shelter/.test(idea) || inv('wood') >= 5) {
    return { thought: 'I need a roof over my head.', name: pick(['Twig Hut', 'Stone Nest', 'Tiny House']), kind: 'structure', description: 'A home to shelter in at night.',
      components: [{ type: 'shelter', power: 2 + overreach }], materials: mats(5, 1, 1), shape: pick(['hut', 'house']), color: pick(['#c0703f', '#a65e3a', '#d9a35f']) };
  }
  if (/light|lantern|night/.test(idea) && m.tech >= 2) {
    return { thought: 'If I can see in the dark I can work at night too.', name: 'Firefly Lantern', kind: 'tool', description: 'Lights up the dark.',
      components: [{ type: 'light', power: 1 + overreach }], materials: mats(2, 1, 2), shape: 'lantern', color: '#ffd166' };
  }
  return { thought: 'Chopping wood will be much easier with this.', name: pick(['Stone Axe', 'Sharp Pickaxe', 'Twig Rake']), kind: 'tool', description: 'Speeds up gathering.',
    components: [{ type: 'harvest', power: 1 + overreach }], materials: mats(2, 2, 0), shape: pick(['axe', 'pickaxe', 'hammer']), color: '#9a9aa2' };
}

function decide(o: Observation): Decision {
  const p = o.personality;
  const base = { target: 'none', direction: 'any', who: '', say: '', plan: '', idea: '', item: '', market_op: 'none', qty: 0, price: 0 } as const;
  const berries = o.inventory.berry ?? 0;
  const friend = o.nearby[0];
  const greet = friend && Math.random() < p.sociability * 0.5;
  const say = greet ? pick([`Hi ${friend.name}!`, `${friend.name}, how are you today?`, 'What a lovely day!', 'Berries are over this way!']) : '';

  if (o.needs.food < 45 && berries > 0) {
    return { ...base, action: 'eat', say, thought: pick(["My tummy's rumbling, let me eat a berry from my bag.", 'Food first.']) };
  }
  if (o.needs.food < 55 && o.nearest.berry) {
    return { ...base, action: 'gather', target: 'berry', say, thought: `I'm hungry. The nearest bush is ${o.nearest.berry.dir}, off I go.` };
  }
  if (o.night || o.needs.energy < 25) {
    return { ...base, action: 'sleep', thought: pick(['My eyes are closing… I need some sleep.', "Tomorrow's a new day; time to rest."]) };
  }
  const foe = o.nearby.find((n) => o.relations.some((r) => r.name === n.name && (r.label === 'tense' || r.label === 'enemy')));
  if (foe && p.aggression > 0.7 && Math.random() < 0.4) {
    return { ...base, action: 'attack', who: foe.name, thought: `${foe.name} again… This time we settle it!` };
  }
  if (o.needs.food < 25 && !berries && friend && p.aggression > 0.5 && Math.random() < 0.5) {
    return { ...base, action: 'steal', who: friend.name, target: 'berry', thought: `I'm starving… maybe ${friend.name} won't notice.` };
  }
  if (friend && (greet || o.loneliness > 0.3) && Math.random() < 0.5) {
    return { ...base, action: 'talk', who: friend.name, thought: `There's ${friend.name}! Let me go over and chat.` };
  }
  const items = o.itemCount;
  // Newer systems: vehicles, land, market, war
  if (o.vehicle && Math.random() < 0.25) return { ...base, action: 'ride', thought: 'A little ride to feel the wind!' };
  if (o.hasHome && !o.hasFlag && (o.inventory.wood ?? 0) >= 2 && Math.random() < 0.3) {
    return { ...base, action: 'claim', thought: 'I will claim the land around my home.' };
  }
  if ((o.inventory.wood ?? 0) >= 5 && Math.random() < 0.25) {
    return { ...base, action: 'market', market_op: 'sell', target: 'wood', qty: 2, price: 1 + Math.floor(Math.random() * 3), thought: 'I have spare wood; let me turn it into berries at the market.' };
  }
  if (berries >= 6 && (o.inventory.stone ?? 0) < 2 && o.creativity > 0.4 && Math.random() < 0.25) {
    return { ...base, action: 'market', market_op: 'buy', target: 'stone', qty: 2, price: 2, thought: 'I need stone for an invention; let me buy some at the market.' };
  }
  if (foe && !o.wars.length && p.aggression > 0.8 && Math.random() < 0.15) {
    return { ...base, action: 'declare_war', who: foe.name, thought: `Enough. It's open war with ${foe.name} now!` };
  }
  if (Math.random() < 0.2 + o.creativity * 0.6 && items >= 4 && (o.inventory.wood ?? 0) >= 2) {
    const idea = !o.hasHome && (o.inventory.wood ?? 0) >= 5 ? 'Build myself a little house' : o.tech >= 4 ? (Math.random() < 0.5 ? 'Wings so I can fly' : 'A golem helper') : o.tech >= 2 && Math.random() < 0.4 ? 'A lantern for the night' : 'A tool that makes chopping wood easier';
    return { ...base, action: 'invent', idea, thought: `I've got an idea: ${idea.toLowerCase()}!` };
  }
  const roll = Math.random();
  if (roll < p.creativity * 0.5 && o.itemCount < o.capacity - 3) {
    const t = Math.random() < 0.5 && o.nearest.wood ? 'wood' : o.nearest.stone ? 'stone' : 'wood';
    return {
      ...base, action: 'gather', target: t, say,
      thought: pick(["One day I'll build my own home; I need materials.", 'I wonder what I could make with this. Let me collect some.']),
      plan: o.plan ? '' : 'Collect enough wood and stone to build myself a nest.',
    };
  }
  if (roll < 0.35 + p.curiosity * 0.5) {
    const dir = pick(['north', 'south', 'east', 'west'] as const);
    return { ...base, action: 'explore', direction: dir, say, thought: pick(["I wonder what's on the other side of the island.", "Let's go somewhere I've never been!"]) };
  }
  if (berries < 2 + p.caution * 3 && o.nearest.berry) {
    return { ...base, action: 'gather', target: 'berry', say, thought: 'I should save a few berries for hard times.' };
  }
  return { ...base, action: 'rest', say, thought: pick(['Let me sit and watch the waves for a bit.', "No need to rush."]) };
}
