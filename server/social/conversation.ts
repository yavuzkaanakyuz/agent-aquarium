import { EMOTION_META, ITEMS, formatTime, type AgentAction, type ItemType } from '../../shared/protocol';
import type { Agent } from '../agent';
import { areAllies, breakAlliance, formAlliance, makePeace } from './combat';
import type { SimContext } from '../context';
import { systemPrompt } from '../mind/perception';
import { relationLabel } from '../relations';
import type { Task, TaskStatus } from '../tasks';

const MAX_TURNS = 6;
const LINE_TICKS = 35; // how long a line stays on screen (ticks)
const WAIT_LIMIT = 300; // how long to wait for LLM capacity before giving up
const ITEM_OPTIONS = ['berry', 'wood', 'stone', 'fiber', 'none'] as const;
const PACTS = ['none', 'propose_alliance', 'accept_alliance', 'break_alliance', 'propose_peace', 'accept_peace', 'propose_family', 'accept_family'] as const;
type Pact = (typeof PACTS)[number];
type PactKind = 'alliance' | 'peace' | 'family';
type ItemOption = (typeof ITEM_OPTIONS)[number];
export type Tone = 'friendly' | 'neutral' | 'hostile';

export const TALK_SCHEMA = {
  type: 'object',
  properties: {
    thought: { type: 'string', description: 'A one-sentence inner thought at this moment.' },
    say: { type: 'string', description: 'What you say to them, short (max 80 characters).' },
    tone: { type: 'string', enum: ['friendly', 'neutral', 'hostile'] },
    end: { type: 'boolean', description: 'true if this line ends the conversation.' },
    offer: {
      type: 'object',
      description: 'Trade/gift offer. If none, give_item and want_item are "none" and quantities 0.',
      properties: {
        give_item: { type: 'string', enum: [...ITEM_OPTIONS] },
        give_qty: { type: 'integer' },
        want_item: { type: 'string', enum: [...ITEM_OPTIONS] },
        want_qty: { type: 'integer' },
      },
      required: ['give_item', 'give_qty', 'want_item', 'want_qty'],
      additionalProperties: false,
    },
    accept_offer: { type: 'boolean', description: "true if you accept the other's pending offer." },
    pact: { type: 'string', enum: [...PACTS], description: 'Propose or accept an alliance/peace/family; otherwise "none".' },
    teach: { type: 'string', description: 'Name of a recipe you know and want to teach them; otherwise "".' },
  },
  required: ['thought', 'say', 'tone', 'end', 'offer', 'accept_offer', 'pact', 'teach'],
  additionalProperties: false,
};

interface TalkTurn {
  thought: string;
  say: string;
  tone: Tone;
  end: boolean;
  give: ItemType | null;
  giveQty: number;
  want: ItemType | null;
  wantQty: number;
  accept: boolean;
  pact: Pact;
  teach: string;
}

interface Offer {
  from: Agent;
  to: Agent;
  give: ItemType | null;
  giveQty: number;
  want: ItemType | null;
  wantQty: number;
}

const qty = (v: unknown) => Math.max(0, Math.min(5, Math.round(Number(v) || 0)));
const item = (v: unknown): ItemType | null => (ITEM_OPTIONS.includes(v as ItemOption) && v !== 'none' ? (v as ItemType) : null);

function parseTalk(text: string): TalkTurn | null {
  try {
    const raw = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? text);
    if (typeof raw.say !== 'string' || !raw.say.trim()) return null;
    const o = raw.offer ?? {};
    return {
      thought: String(raw.thought ?? '').slice(0, 200),
      say: raw.say.trim().slice(0, 100),
      tone: ['friendly', 'neutral', 'hostile'].includes(raw.tone) ? raw.tone : 'neutral',
      end: Boolean(raw.end),
      give: item(o.give_item),
      giveQty: qty(o.give_qty),
      want: item(o.want_item),
      wantQty: qty(o.want_qty),
      accept: Boolean(raw.accept_offer),
      pact: PACTS.includes(raw.pact) ? raw.pact : 'none',
      teach: typeof raw.teach === 'string' ? raw.teach.trim().slice(0, 40) : '',
    };
  } catch {
    return null;
  }
}

const describeItems = (inv: Agent['inventory']) =>
  Object.entries(inv)
    .filter(([, n]) => n)
    .map(([k, n]) => `${ITEMS[k as ItemType].name.toLowerCase()} ${n}`)
    .join(', ') || 'nothing';

const offerText = (o: Offer) => {
  const give = o.give && o.giveQty ? `${o.giveQty} ${ITEMS[o.give].emoji}` : null;
  const want = o.want && o.wantQty ? `${o.wantQty} ${ITEMS[o.want].emoji}` : null;
  if (give && want) return `${give} ↔ ${want}`;
  return give ? `${give} as a gift` : `asks for ${want}`;
};

/** A turn-based, LLM-generated conversation between two inhabitants. */
export class Conversation {
  readonly turns: { speaker: Agent; text: string; tone: Tone }[] = [];
  done = false;

  private inFlight = false;
  private pending: { speaker: Agent; listener: Agent; turn: TalkTurn } | null = null;
  private pause = 0;
  private waited = 0;
  private ending = false;
  private offer: Offer | null = null;
  private pact: { from: Agent; kind: PactKind } | null = null;
  private friendlyLines = 0;

  constructor(
    readonly a: Agent,
    readonly b: Agent,
    private opener: string | null,
  ) {}

  partnerOf(x: Agent): Agent {
    return x === this.a ? this.b : this.a;
  }

  step(ctx: SimContext) {
    if (this.done) return;
    if (!this.stillTogether()) return this.finish(ctx, true);
    if (this.pending) {
      const { speaker, listener, turn } = this.pending;
      this.pending = null;
      this.applyTurn(speaker, listener, turn, ctx);
    }
    if (this.inFlight) return;
    if (this.pause > 0) {
      this.pause--;
      return;
    }
    // If an offer is pending, give the other side a chance to reply.
    if (this.ending || (this.turns.length >= MAX_TURNS && !this.offer)) return this.finish(ctx, false);
    if (!ctx.llm.available) {
      if (++this.waited > WAIT_LIMIT) this.finish(ctx, false);
      return;
    }
    this.requestTurn(ctx);
  }

  private stillTogether(): boolean {
    return [this.a, this.b].every(
      (x) => !x.fainted && x.task instanceof TalkTask && x.task.conv === this,
    ) && Math.hypot(this.a.x - this.b.x, this.a.y - this.b.y) < 3.5;
  }

  private requestTurn(ctx: SimContext) {
    const speaker = this.turns.length % 2 === 0 ? this.a : this.b;
    const listener = this.partnerOf(speaker);
    this.inFlight = true;
    speaker.say('…', 600);
    ctx.llm
      .request({
        system: systemPrompt(speaker),
        user: this.prompt(speaker, listener, ctx),
        schema: TALK_SCHEMA,
        temperature: 1,
        meta: {
          kind: 'talk',
          speaker: speaker.name,
          listener: listener.name,
          personality: speaker.personality,
          affection: speaker.relations.get(listener.id).affection,
          turn: this.turns.length,
          inventory: { ...speaker.inventory },
          pendingOffer: this.offer && this.offer.to === speaker ? { want: this.offer.want, wantQty: this.offer.wantQty } : null,
          pendingPact: this.pact && this.pact.from !== speaker ? this.pact.kind : null,
          allied: areAllies(speaker, listener),
          trust: speaker.relations.get(listener.id).trust,
          known: [...speaker.known].filter((id) => !listener.knows(id)).flatMap((id) => ctx.blueprints.get(id)?.name ?? []),
        },
      })
      .then((text) => {
        const turn = parseTalk(text);
        if (turn) this.pending = { speaker, listener, turn };
        else this.ending = true;
      })
      .catch(() => {
        this.ending = true;
      })
      .finally(() => {
        this.inFlight = false;
        if (speaker.bubble === '…') speaker.bubble = null;
      });
  }

  private prompt(speaker: Agent, listener: Agent, ctx: SimContext): string {
    const rel = speaker.relations.get(listener.id);
    const lines = this.turns.length
      ? this.turns.map((t) => `${t.speaker.name}: “${t.text}”`).join('\n')
      : `(Nobody has spoken yet — you are starting the conversation.${this.opener ? ` On your mind: "${this.opener}"` : ''})`;
    const offer =
      this.offer && this.offer.to === speaker
        ? `\n${listener.name} made you an offer: ${this.describeOffer(this.offer)}. To accept, set accept_offer=true.`
        : '';
    const pact =
      this.pact && this.pact.from === listener
        ? `\n${listener.name} proposed ${{ alliance: 'an alliance', peace: 'peace', family: 'starting a family together (an egg)' }[this.pact.kind]}. To accept, set pact="accept_${this.pact.kind}".`
        : '';
    const teachable = [...speaker.known].filter((id) => !listener.knows(id)).flatMap((id) => ctx.blueprints.get(id)?.name ?? []);
    const n = speaker.needs;
    return `You are talking face to face with ${listener.name} (Day ${ctx.clock.day}, ${formatTime(ctx.clock.timeOfDay)}).
Your relationship with ${listener.name}: ${relationLabel(rel)} (affection ${rel.affection.toFixed(2)}, trust ${rel.trust.toFixed(2)})${areAllies(speaker, listener) ? ', you are allies' : ''}.${rel.opinion ? ` Your opinion of them: "${rel.opinion}"` : ''}
${listener.name} looks ${EMOTION_META[listener.emotions.mood].name.toLowerCase()} right now; they are carrying: ${describeItems(listener.inventory)}.

Your state: fullness ${Math.round(n.food)}/100, energy ${Math.round(n.energy)}/100. Your bag: ${describeItems(speaker.inventory)}.
Your feelings: ${speaker.emotions.describe()}
${speaker.mind.longTerm ? `What you know about yourself: ${speaker.mind.longTerm}\n` : ''}
${teachable.length ? `Recipes you know that ${listener.name} doesn't: ${teachable.join(', ')}\n` : ''}
Conversation:
${lines}${offer}${pact}

Your turn. Speak briefly and naturally, true to your personality (max 80 characters). If the conversation has run its course or you're bored, set end=true.
If you like: offer a trade or gift (offer; you can only give what is in your bag), teach a recipe (teach), propose an alliance (you protect each other), propose peace if you're on bad terms, or if you're very close propose starting a family (propose_family; best if you're both well fed and one of you has a home).`;
  }

  private describeOffer(o: Offer): string {
    const give = o.give && o.giveQty ? `they will give you ${o.giveQty} ${ITEMS[o.give].name.toLowerCase()}` : '';
    const want = o.want && o.wantQty ? `in exchange for ${o.wantQty} ${ITEMS[o.want].name.toLowerCase()}` : 'expecting nothing back (a gift)';
    return give ? `${give}, ${want}` : `they want ${o.wantQty} ${ITEMS[o.want!].name.toLowerCase()} from you`;
  }

  private applyTurn(speaker: Agent, listener: Agent, t: TalkTurn, ctx: SimContext) {
    this.turns.push({ speaker, text: t.say, tone: t.tone });
    speaker.say(t.say, LINE_TICKS + 15);
    if (t.thought) speaker.mind.thought = t.thought;
    ctx.log(`${speaker.name} → ${listener.name}: “${t.say}”`, speaker.id);
    listener.mind.remember(`${speaker.name} bana dedi ki: “${t.say}”`, ctx.clock);
    this.applyTone(speaker, listener, t.tone);

    // Reply to a pending offer
    if (this.offer && this.offer.to === speaker) {
      if (t.accept) this.execute(this.offer, ctx);
      else ctx.log(`${speaker.name} turned down ${this.offer.from.name}'s offer`, speaker.id);
      this.offer = null;
    }
    // Yeni teklif
    const hasOffer = (t.give && t.giveQty) || (t.want && t.wantQty);
    if (hasOffer && (!t.give || (speaker.inventory[t.give] ?? 0) >= t.giveQty)) {
      this.offer = { from: speaker, to: listener, give: t.give, giveQty: t.giveQty, want: t.want, wantQty: t.wantQty };
      ctx.log(`${speaker.name} made ${listener.name} an offer: ${offerText(this.offer)}`, speaker.id);
    }

    if (t.tone === 'friendly') this.friendlyLines++;
    this.applyPact(speaker, listener, t, ctx);
    if (t.teach) {
      const name = t.teach.toLowerCase();
      const bp = [...speaker.known].map((id) => ctx.blueprints.get(id)).find((b) => b && b.name.toLowerCase().includes(name));
      if (bp && !listener.knows(bp.id)) {
        listener.learn(bp, ctx, `from ${speaker.name}`, speaker);
        speaker.emotions.feel('pride', 0.1);
        listener.relations.adjust(speaker.id, { affection: 0.1, trust: 0.08 });
      }
    }

    // If an offer was just made, allow one more turn so the other side can answer.
    this.ending = t.end && !this.offer && !this.pact;
    this.pause = LINE_TICKS;
  }

  private applyPact(speaker: Agent, listener: Agent, t: TalkTurn, ctx: SimContext) {
    const p = t.pact;
    if (p === 'none') return;
    if (p === 'break_alliance') {
      breakAlliance(speaker, listener, ctx, `${speaker.name} wanted out`);
      return;
    }
    const [verb, kind] = p.split('_') as ['propose' | 'accept', PactKind];
    if (verb === 'propose') {
      if (kind === 'alliance' && areAllies(speaker, listener)) return;
      this.pact = { from: speaker, kind };
      const what = { alliance: 'an alliance', peace: 'peace', family: 'starting a family' }[kind];
      ctx.log(`${speaker.name} proposed ${what} to ${listener.name}`, speaker.id);
      return;
    }
    if (!this.pact || this.pact.from !== listener || this.pact.kind !== kind) return;
    this.pact = null;
    if (kind === 'alliance') formAlliance(speaker, listener, ctx);
    else if (kind === 'peace') makePeace(speaker, listener, ctx);
    else if (!ctx.startFamily(listener, speaker)) ctx.log(`${listener.name} and ${speaker.name} wanted to start a family, but the conditions weren't right`, speaker.id);
  }

  private applyTone(speaker: Agent, listener: Agent, tone: Tone) {
    const lp = listener.personality;
    listener.relations.adjust(speaker.id, { familiarity: 0.04 });
    speaker.relations.adjust(listener.id, { familiarity: 0.04 });
    listener.emotions.feel('loneliness', -0.15);
    if (tone === 'friendly') {
      listener.relations.adjust(speaker.id, { affection: 0.07, trust: 0.02 });
      speaker.relations.adjust(listener.id, { affection: 0.03 });
      listener.emotions.feel('joy', 0.08);
    } else if (tone === 'hostile') {
      listener.relations.adjust(speaker.id, { affection: -0.15, trust: -0.06 });
      speaker.relations.adjust(listener.id, { affection: -0.04 });
      // Aggressive temperaments get angry, cautious ones get scared.
      if (lp.aggression >= lp.caution) listener.emotions.feel('anger', 0.15 + lp.aggression * 0.2);
      else listener.emotions.feel('fear', 0.12 + lp.caution * 0.15);
      listener.emotions.feel('sadness', 0.06);
    }
  }

  private execute(o: Offer, ctx: SimContext) {
    const { from, to } = o;
    const canGive = !o.give || (from.inventory[o.give] ?? 0) >= o.giveQty;
    const canPay = !o.want || (to.inventory[o.want] ?? 0) >= o.wantQty;
    const room = (x: Agent, inQty: number, outQty: number) => x.itemCount + inQty - outQty <= x.capacity;
    if (!canGive || !canPay || !room(to, o.giveQty, o.wantQty) || !room(from, o.wantQty, o.giveQty)) {
      ctx.log(`${from.name} and ${to.name} agreed, but the trade fell through (not enough items or room)`, from.id);
      return;
    }
    if (o.give && o.giveQty) {
      from.removeItem(o.give, o.giveQty);
      to.addItem(o.give, o.giveQty);
    }
    if (o.want && o.wantQty) {
      to.removeItem(o.want, o.wantQty);
      from.addItem(o.want, o.wantQty);
    }
    const gift = !o.want || !o.wantQty;
    if (gift) {
      ctx.log(`🎁 ${from.name} gave ${to.name} ${o.giveQty} ${ITEMS[o.give!].emoji} as a gift`, from.id);
      to.relations.adjust(from.id, { affection: 0.2, trust: 0.12 });
      from.emotions.feel('pride', 0.12);
      to.emotions.feel('joy', 0.2);
      ctx.emit({ type: 'gift', from, to });
    } else {
      ctx.log(`🤝 ${from.name} and ${to.name} traded: ${offerText(o)}`, from.id);
      to.relations.adjust(from.id, { affection: 0.06, trust: 0.12 });
      from.relations.adjust(to.id, { affection: 0.06, trust: 0.12 });
      from.emotions.feel('joy', 0.12);
      to.emotions.feel('joy', 0.12);
      ctx.emit({ type: 'trade', from, to });
    }
    to.mind.remember(`${gift ? 'Got a gift from' : 'Traded with'} ${from.name}: ${offerText(o)}`, ctx.clock);
  }

  private finish(ctx: SimContext, interrupted: boolean) {
    if (this.done) return;
    this.done = true;
    for (const x of [this.a, this.b]) {
      const other = this.partnerOf(x);
      x.talkCooldown = 900;
      x.relations.adjust(other.id, { familiarity: 0.06 });
      x.emotions.feel('loneliness', -0.3);
      if (this.turns.length) x.mind.remember(`Had a ${this.turns.length}-line chat with ${other.name}`, ctx.clock);
      if (x.bubble === '…') x.bubble = null;
    }
    if (this.turns.length) ctx.emit({ type: 'conversation', a: this.a, b: this.b, turns: this.turns.length, friendly: this.friendlyLines });
    if (interrupted && this.turns.length) ctx.log(`${this.a.name} and ${this.b.name}'s conversation was cut short`, this.a.id);
  }
}

/** Keeps both agents in place for the duration of a conversation. */
export class TalkTask implements Task {
  readonly kind = 'talk';
  readonly label: string;
  action: AgentAction = 'talk';
  progress = null;

  constructor(
    readonly conv: Conversation,
    private partner: Agent,
  ) {
    this.label = `Chatting with ${partner.name}`;
  }

  step(agent: Agent): TaskStatus {
    agent.facing = this.partner.x > agent.x ? 1 : -1;
    return this.conv.done ? 'done' : 'running';
  }
}
