/** Actions the LLM can choose — the public face of the tasks in tasks.ts. */
export const ACTIONS = [
  'gather', 'eat', 'sleep', 'explore', 'rest', 'approach', 'talk', 'invent', 'craft', 'go_home', 'attack', 'steal',
  'ride', 'claim', 'declare_war', 'raid', 'market',
] as const;
export const TARGETS = ['berry', 'wood', 'stone', 'fiber', 'none'] as const;
export const MARKET_OPS = ['none', 'sell', 'buy', 'cancel'] as const;
export const DIRECTIONS = ['north', 'south', 'east', 'west', 'any'] as const;

export type ActionName = (typeof ACTIONS)[number];
export type Target = (typeof TARGETS)[number];
export type Direction = (typeof DIRECTIONS)[number];

export interface Decision {
  thought: string;
  action: ActionName;
  target: Target;
  direction: Direction;
  who: string;
  say: string;
  plan: string;
  idea: string;
  item: string;
  market_op: (typeof MARKET_OPS)[number];
  qty: number;
  price: number;
}

export const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    thought: { type: 'string', description: 'First-person inner voice in English, 1-2 sentences.' },
    action: { type: 'string', enum: [...ACTIONS] },
    target: { type: 'string', enum: [...TARGETS], description: 'Resource for gather, item for steal and market; "none" otherwise.' },
    direction: { type: 'string', enum: [...DIRECTIONS], description: 'Direction for explore; "any" otherwise.' },
    who: { type: 'string', description: 'Inhabitant name for approach/talk/attack/steal/declare_war/raid; "" otherwise.' },
    say: { type: 'string', description: 'A short line nearby inhabitants will hear (max 60 characters), or "".' },
    plan: { type: 'string', description: 'New long-term plan (1 sentence) if it changed, otherwise "".' },
    idea: { type: 'string', description: 'Your invention idea for invent (what you want to make, 1 sentence); "" otherwise.' },
    item: { type: 'string', description: 'Name of a known recipe for craft; "" otherwise.' },
    market_op: { type: 'string', enum: [...MARKET_OPS], description: 'For market: sell/buy/cancel; "none" otherwise.' },
    qty: { type: 'integer', description: 'Quantity for market (1-10); 0 otherwise.' },
    price: { type: 'integer', description: 'Price in berries per unit for market (1-20); 0 otherwise.' },
  },
  required: ['thought', 'action', 'target', 'direction', 'who', 'say', 'plan', 'idea', 'item', 'market_op', 'qty', 'price'],
  additionalProperties: false,
};

const oneOf = <T extends string>(list: readonly T[], v: unknown, fallback: T): T =>
  list.includes(v as T) ? (v as T) : fallback;
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Validates model output; returns null if malformed (the agent falls back to reflexes). */
export function parseDecision(text: string): Decision | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      raw = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  if (!ACTIONS.includes(raw.action as ActionName)) return null;
  return {
    thought: str(raw.thought, 240),
    action: raw.action as ActionName,
    target: oneOf(TARGETS, raw.target, 'none'),
    direction: oneOf(DIRECTIONS, raw.direction, 'any'),
    who: str(raw.who, 30),
    say: str(raw.say, 80),
    plan: str(raw.plan, 160),
    idea: str(raw.idea, 200),
    item: str(raw.item, 40),
    market_op: oneOf(MARKET_OPS, raw.market_op, 'none'),
    qty: Math.max(0, Math.min(10, Math.round(Number(raw.qty) || 0))),
    price: Math.max(0, Math.min(20, Math.round(Number(raw.price) || 0))),
  };
}

// ---------- nightly reflection (long-term memory) ----------
export const REFLECT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'First-person, 3-4 sentence summary: who you are, key events, your goals.' },
    opinions: {
      type: 'array',
      description: 'A one-sentence opinion about each inhabitant you know.',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, opinion: { type: 'string' } },
        required: ['name', 'opinion'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'opinions'],
  additionalProperties: false,
};

export interface Reflection {
  summary: string;
  opinions: { name: string; opinion: string }[];
}

export function parseReflection(text: string): Reflection | null {
  try {
    const raw = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? text);
    if (typeof raw.summary !== 'string' || !raw.summary.trim()) return null;
    const opinions = Array.isArray(raw.opinions) ? raw.opinions : [];
    return {
      summary: raw.summary.trim().slice(0, 600),
      opinions: opinions
        .filter((o: unknown): o is { name: string; opinion: string } =>
          typeof (o as { name?: unknown })?.name === 'string' && typeof (o as { opinion?: unknown })?.opinion === 'string')
        .map((o: { name: string; opinion: string }) => ({ name: o.name.trim(), opinion: o.opinion.trim().slice(0, 200) })),
    };
  } catch {
    return null;
  }
}
