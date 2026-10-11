// Shared contract between the server (simulation) and the client (visualization).
import type { AchievementUnlock } from './achievements';
import type { EconomyStats } from './economy';
export type { EconomyStats } from './economy';
import type { Blueprint, BlueprintKind, EquipmentState, Shape } from './invention';
export type { AchievementUnlock } from './achievements';
export type { Blueprint, EquipmentState } from './invention';

export const TICK_RATE = 10; // simulation steps per second (at 1x)
export const DAY_TICKS = TICK_RATE * 180; // one day = 3 minutes at 1x
export const SPEEDS = [0, 1, 2, 4, 8] as const;

export type TileType = 'water' | 'sand' | 'grass' | 'dirt' | 'flowers';
export type ObjectType = 'tree' | 'rock' | 'bush' | 'structure';

export interface WorldObject {
  id: number;
  type: ObjectType;
  x: number; // tile coordinate
  y: number;
  variant: number;
  amount: number; // remaining resource (berries, wood, stone)
  max: number;
  structure?: StructureInfo;
}

export interface StructureInfo {
  blueprintId: string;
  name: string;
  kind: BlueprintKind;
  shape: Shape | 'grave' | 'flag' | 'market';
  color: string;
  ownerId: string;
  ownerName: string;
  shelter: number;
  light: number;
  defense: number;
  // Structure HP lives in amount/max (raids reduce it; at 0 the structure is destroyed).
}

export interface ObjectUpdate {
  id: number;
  amount: number;
}

// ---------- items ----------
export type ItemType = 'berry' | 'wood' | 'stone' | 'fiber';
export type Inventory = Partial<Record<ItemType, number>>;

export const ITEMS: Record<ItemType, { name: string; emoji: string }> = {
  berry: { name: 'Berry', emoji: '🫐' },
  wood: { name: 'Wood', emoji: '🪵' },
  stone: { name: 'Stone', emoji: '🪨' },
  fiber: { name: 'Fiber', emoji: '🧵' },
};

export interface Needs {
  food: number; // 0..100, 100 = full
  energy: number; // 0..100
  health: number; // 0..100
}

export interface WorldMap {
  seed: number;
  width: number;
  height: number;
  tiles: TileType[]; // row-major: tiles[y * width + x]
  objects: WorldObject[];
}

export type Accessory = 'none' | 'sprout' | 'tophat' | 'bow' | 'antenna' | 'flower';

export interface Personality {
  curiosity: number; // 0..1
  aggression: number;
  sociability: number;
  caution: number;
  creativity: number;
  laziness: number;
}

export type AgentAction = 'idle' | 'walk' | 'sleep' | 'gather' | 'eat' | 'talk' | 'attack';
export type TaskKind =
  | 'rest' | 'wander' | 'gather' | 'eat' | 'sleep' | 'think' | 'approach' | 'talk'
  | 'craft' | 'invent' | 'attack' | 'flee' | 'follow';

// ---------- emotions & relationships ----------
export type Emotion = 'joy' | 'fear' | 'anger' | 'sadness' | 'loneliness' | 'pride';
export type Mood = Emotion | 'calm';
export const EMOTION_META: Record<Mood, { name: string; emoji: string; color: string }> = {
  joy: { name: 'Joy', emoji: '😊', color: '#f2b84b' },
  fear: { name: 'Fear', emoji: '😨', color: '#8a7fd1' },
  anger: { name: 'Anger', emoji: '😠', color: '#e0524f' },
  sadness: { name: 'Sadness', emoji: '😢', color: '#5b8fd6' },
  loneliness: { name: 'Loneliness', emoji: '🥺', color: '#9aa3b5' },
  pride: { name: 'Pride', emoji: '😎', color: '#4fb38a' },
  calm: { name: 'Calm', emoji: '🙂', color: '#a7b59a' },
};

export interface RelationState {
  id: string;
  name: string;
  label: string; // "friend", "tense" …
  affection: number; // -1..1
  trust: number; // -1..1
  familiarity: number; // 0..1
  opinion: string | null; // opinion from long-term memory
}

export interface MindState {
  thought: string | null; // latest inner voice
  plan: string | null; // long-term intention
  thinking: boolean; // waiting for an LLM reply
  source: 'llm' | 'reflex'; // who chose the current task
  memories: string[]; // most recent memories (newest last)
  longTerm: string | null; // summary from the nightly reflection
}

export interface LLMStats {
  provider: string;
  model: string;
  enabled: boolean;
  calls: number;
  errors: number;
  inFlight: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsd: number | null; // if prices are set in env
  lastError: string | null;
  budgetLeft: number; // remaining tokens in today's budget
}

export interface AgentState {
  id: string;
  name: string;
  color: string;
  accessory: Accessory;
  personality: Personality;
  x: number; // tile units, continuous (tile center = x + 0.5)
  y: number;
  facing: -1 | 1;
  action: AgentAction;
  task: string; // human-readable task label, e.g. "Chopping wood"
  progress: number | null; // 0..1 while working
  bubble: string | null;
  needs: Needs;
  inventory: Inventory;
  fainted: boolean;
  mind: MindState;
  emotions: Record<Emotion, number>; // 0..1
  mood: Mood;
  relations: RelationState[];
  talkingWith: string | null; // id of the agent they are talking to
  tech: number;
  knowledge: number;
  equipment: EquipmentState[];
  known: string[]; // names of known recipes
  homeId: number | null;
  flying: boolean;
  light: number; // light component power (night glow)
  allies: string[];
  fighting: string | null; // id of the agent being fought
  achievements: string[];
  insideId: number | null; // house the agent is inside
  riding: boolean; // travelling by vehicle
  swimming: boolean; // on water by boat
  enemies: string[]; // agents they are at war with
  stage: 'egg' | 'child' | 'adult';
  isGolem: boolean;
  ownerId: string | null; // owner of a golem
  parents: string[];
  hatchProgress: number | null; // 0..1 for eggs
}

export interface WorldClock {
  tick: number;
  day: number;
  timeOfDay: number; // 0..1, 0 = midnight, 0.5 = noon
  speed: number;
}

export interface LogEvent {
  id: number;
  day: number;
  timeOfDay: number;
  text: string;
  agentId?: string;
}

export type ServerMessage =
  | { type: 'init'; world: WorldMap; agents: AgentState[]; clock: WorldClock; events: LogEvent[]; llm: LLMStats; blueprints: Blueprint[]; achievements: AchievementUnlock[]; saveName: string | null }
  | {
      type: 'state';
      agents: AgentState[];
      clock: WorldClock;
      events: LogEvent[];
      objects: ObjectUpdate[];
      newObjects: WorldObject[];
      removedObjects: number[];
      blueprints: Blueprint[]; // new inventions
      achievements: AchievementUnlock[]; // newly unlocked
      llm: LLMStats;
      economy: EconomyStats | null; // once per second
    }
  | { type: 'saves'; saves: SaveInfo[] }
  | { type: 'notice'; text: string };

export interface SaveInfo {
  name: string;
  day: number;
  agents: number;
  savedAt: string;
}

export type ClientMessage =
  | { type: 'setSpeed'; speed: number }
  | { type: 'regenerate' }
  | { type: 'setMind'; enabled: boolean }
  | { type: 'save' }
  | { type: 'listSaves' }
  | { type: 'load'; name: string }
  | { type: 'admin'; op: 'scarcity'; value: number }
  | { type: 'admin'; op: 'wither'; fraction: number }
  | { type: 'admin'; op: 'rain' }
  | { type: 'admin'; op: 'airdrop'; berries: number; target: string | null }
  | { type: 'admin'; op: 'tax'; fraction: number }
  | { type: 'admin'; op: 'spoilage'; rate: number }
  | { type: 'admin'; op: 'fee'; rate: number }
  | { type: 'admin'; op: 'immigrants'; count: number; temperament: 'aggressive' | 'peaceful' | 'mixed'; armed: boolean };

export const TERRITORY_RADIUS = 5;

/** A structure's max HP grows with its defense and shelter power. */
export const structureMaxHp = (s: { defense: number; shelter: number; shape: string }) =>
  s.shape === 'flag' ? 15 : s.shape === 'market' || s.shape === 'grave' ? 9999 : 30 + 20 * s.defense + 5 * s.shelter;

export function isNight(timeOfDay: number): boolean {
  return timeOfDay >= 0.86 || timeOfDay < 0.22;
}

export function formatTime(timeOfDay: number): string {
  const minutes = Math.floor(timeOfDay * 24 * 60);
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}
