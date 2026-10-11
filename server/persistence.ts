import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SaveInfo } from '../shared/protocol';
import type { LLMGateway } from './mind/gateway';
import { Simulation } from './sim';

export const SAVE_DIR = process.env.SAVE_DIR ? `${process.env.SAVE_DIR.replace(/\/$/, '')}/` : fileURLToPath(new URL('../saves/', import.meta.url));
const VERSION = 1;

function ensureDir() {
  if (!existsSync(SAVE_DIR)) mkdirSync(SAVE_DIR, { recursive: true });
}

const safeName = (name: string) => name.replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);

/** Writes atomically (to .tmp, then rename) — no half-written saves. */
export function saveSimulation(sim: Simulation, name: string): string {
  ensureDir();
  const file = `${SAVE_DIR}${safeName(name)}.json`;
  writeFileSync(`${file}.tmp`, JSON.stringify({ version: VERSION, savedAt: new Date().toISOString(), ...sim.serialize() }));
  renameSync(`${file}.tmp`, file);
  return safeName(name);
}

export function loadSimulation(name: string, llm: LLMGateway): Simulation | null {
  const file = `${SAVE_DIR}${safeName(name)}.json`;
  if (!existsSync(file)) return null;
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (data.version !== VERSION) throw new Error(`Incompatible save version (${data.version})`);
  return Simulation.restore(data, llm);
}

export function listSaves(): SaveInfo[] {
  ensureDir();
  return readdirSync(SAVE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const path = `${SAVE_DIR}${f}`;
      try {
        const head = JSON.parse(readFileSync(path, 'utf8'));
        return { name: f.replace(/\.json$/, ''), day: head.day ?? 0, agents: head.agents?.length ?? 0, savedAt: head.savedAt ?? statSync(path).mtime.toISOString() };
      } catch {
        return null;
      }
    })
    .filter((s): s is SaveInfo => !!s)
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}
