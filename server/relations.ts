import type { RelationState } from '../shared/protocol';

export interface Relation {
  affection: number; // -1..1 liking
  trust: number; // -1..1 trust
  familiarity: number; // 0..1 how well they know each other
  opinion: string | null; // opinion written by the LLM during nightly reflection
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function relationLabel(r: Relation): string {
  if (r.affection <= -0.5) return 'enemy';
  if (r.affection <= -0.2 || r.trust <= -0.3) return 'tense';
  if (r.familiarity < 0.05) return 'stranger';
  if (r.affection >= 0.6 && r.trust >= 0.4) return 'close friend';
  if (r.affection >= 0.25) return 'friend';
  return 'acquaintance';
}

/** How one agent sees the others (one-directional: Pip liking Miso doesn't mean Miso likes Pip). */
export class Relations {
  private map = new Map<string, Relation>();

  get(id: string): Relation {
    let r = this.map.get(id);
    if (!r) this.map.set(id, (r = { affection: 0, trust: 0, familiarity: 0, opinion: null }));
    return r;
  }

  adjust(id: string, d: Partial<Pick<Relation, 'affection' | 'trust' | 'familiarity'>>) {
    const r = this.get(id);
    r.affection = clamp(r.affection + (d.affection ?? 0), -1, 1);
    r.trust = clamp(r.trust + (d.trust ?? 0), -1, 1);
    r.familiarity = clamp(r.familiarity + (d.familiarity ?? 0), 0, 1);
  }

  entries(): [string, Relation][] {
    return [...this.map.entries()];
  }

  restore(entries: [string, Relation][]) {
    for (const [id, r] of entries) this.map.set(id, { ...r });
  }

  snapshot(names: Map<string, string>): RelationState[] {
    return [...this.map.entries()]
      .filter(([, r]) => r.familiarity > 0)
      .map(([id, r]) => ({
        id,
        name: names.get(id) ?? id,
        label: relationLabel(r),
        affection: Math.round(r.affection * 100) / 100,
        trust: Math.round(r.trust * 100) / 100,
        familiarity: Math.round(r.familiarity * 100) / 100,
        opinion: r.opinion,
      }))
      .sort((a, b) => b.familiarity - a.familiarity);
  }
}
