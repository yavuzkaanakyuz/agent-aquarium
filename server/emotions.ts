import { EMOTION_META, type Emotion, type Mood, type Personality } from '../shared/protocol';

export const EMOTIONS: Emotion[] = ['joy', 'fear', 'anger', 'sadness', 'loneliness', 'pride'];

const DECAY = 0.0015; // per-tick pull toward baseline (~half-life: a quarter day)
const MOOD_THRESHOLD = 0.35;

/**
 * Emotions spike on events and decay over time toward a personality-dependent baseline.
 * They affect reflex behavior, the LLM prompt and sprite animation alike.
 */
export class Emotions {
  readonly values: Record<Emotion, number>;

  constructor(private p: Personality) {
    this.values = { joy: this.base('joy'), fear: 0, anger: 0, sadness: 0, loneliness: 0, pride: 0 };
  }

  /** Resting level by personality: cheerful types lean to joy, aggressive ones to anger. */
  private base(e: Emotion): number {
    const p = this.p;
    switch (e) {
      case 'joy':
        return 0.2 + (1 - p.aggression) * 0.1 + p.sociability * 0.05;
      case 'anger':
        return p.aggression * 0.12;
      case 'fear':
        return p.caution * 0.08;
      default:
        return 0;
    }
  }

  feel(e: Emotion, amount: number) {
    this.values[e] = Math.min(1, Math.max(0, this.values[e] + amount));
  }

  /** @param alone when nobody awake is nearby, loneliness builds up (scaled by sociability). */
  tick(alone: boolean) {
    for (const e of EMOTIONS) {
      if (e === 'loneliness') continue;
      this.values[e] += (this.base(e) - this.values[e]) * DECAY;
    }
    if (alone) this.feel('loneliness', 0.0003 * (0.2 + this.p.sociability));
    else this.values.loneliness *= 1 - DECAY * 3;
  }

  get mood(): Mood {
    let best: Emotion | null = null;
    for (const e of EMOTIONS) if (!best || this.values[e] > this.values[best]) best = e;
    return best && this.values[best] >= MOOD_THRESHOLD ? best : 'calm';
  }

  snapshot(): Record<Emotion, number> {
    return Object.fromEntries(EMOTIONS.map((e) => [e, Math.round(this.values[e] * 100) / 100])) as Record<Emotion, number>;
  }

  /** For the prompt: describes notable emotions in words. */
  describe(): string {
    const strong = EMOTIONS.filter((e) => this.values[e] >= 0.2)
      .sort((a, b) => this.values[b] - this.values[a])
      .map((e) => {
        const v = this.values[e];
        const level = v >= 0.7 ? 'intense' : v >= 0.45 ? 'clear' : 'mild';
        return `${EMOTION_META[e].name.toLowerCase()} (${level})`;
      });
    return strong.length ? strong.join(', ') : 'calm, balanced';
  }
}
