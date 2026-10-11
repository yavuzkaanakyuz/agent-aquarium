import type { Blueprint } from '../shared/invention';
import type { Agent } from './agent';

/** Notable simulation events — achievements and economy stats listen to these. */
export type SimEvent =
  | { type: 'invented' | 'crafted'; agent: Agent; blueprint: Blueprint }
  | { type: 'invention_failed'; agent: Agent }
  | { type: 'learned'; agent: Agent; blueprint: Blueprint; teacher: Agent | null }
  | { type: 'tech_up'; agent: Agent; level: number }
  | { type: 'explored'; agent: Agent; ratio: number }
  | { type: 'flew'; agent: Agent }
  | { type: 'trade' | 'gift'; from: Agent; to: Agent }
  | { type: 'conversation'; a: Agent; b: Agent; turns: number; friendly: number }
  | { type: 'relation'; agent: Agent; other: Agent; label: string }
  | { type: 'fight'; attacker: Agent; target: Agent }
  | { type: 'knockout'; winner: Agent; loser: Agent }
  | { type: 'alliance' | 'peace' | 'alliance_broken'; a: Agent; b: Agent }
  | { type: 'fainted' | 'recovered'; agent: Agent }
  | { type: 'born'; child: Agent; parents: [Agent, Agent] }
  | { type: 'golem'; owner: Agent; golem: Agent }
  | { type: 'healed'; agent: Agent }
  | { type: 'berries'; kind: 'harvested' | 'eaten' | 'airdropped' | 'burned' | 'spoiled'; qty: number }
  | { type: 'war'; a: Agent; b: Agent }
  | { type: 'raid'; attacker: Agent; owner: Agent | null; destroyed: boolean }
  | { type: 'claimed'; agent: Agent }
  | { type: 'rode'; agent: Agent }
