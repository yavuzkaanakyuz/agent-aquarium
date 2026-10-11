import './env';
import { existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { SPEEDS, TICK_RATE, type ClientMessage, type ServerMessage } from '../shared/protocol';
import { applyAdmin, type AdminMessage } from './admin';
import { createGateway } from './mind/config';
import { listSaves, loadSimulation, saveSimulation } from './persistence';
import { Simulation } from './sim';

const PORT = Number(process.env.SIM_PORT ?? 8787);
// Localhost only by default: the socket controls the world and spends your LLM budget.
const HOST = process.env.HOST ?? '127.0.0.1';
const AUTOSAVE = 'autosave';
const AUTOSAVE_MS = 60_000;
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const newSeed = () => Math.floor(Math.random() * 1_000_000_000);

const llm = createGateway();

/** Resumes from the autosave on startup (FRESH=1 starts over) — the aquarium survives restarts. */
function boot(): Simulation {
  if (process.env.FRESH !== '1') {
    try {
      const restored = loadSimulation(AUTOSAVE, llm);
      if (restored) return restored;
    } catch (err) {
      console.warn(`[save] could not load autosave: ${(err as Error).message}`);
    }
  }
  return new Simulation(Number(process.env.SEED ?? newSeed()), llm);
}

let sim = boot();
let loadedName: string | null = null;

// ---------- HTTP: serves the built client (npm start); in dev, Vite serves it instead ----------
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  if (!existsSync(DIST)) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Agent Aquarium simulation server. Run `npm run dev` and open http://localhost:5173, or `npm start` to serve the built client here.\n');
    return;
  }
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const file = normalize(join(DIST, url === '/' ? 'index.html' : url));
  const safe = file.startsWith(DIST) && existsSync(file) && statSync(file).isFile() ? file : join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': MIME[extname(safe)] ?? 'application/octet-stream' });
  res.end(readFileSync(safe));
});
const wss = new WebSocketServer({ server, path: '/ws' });

const send = (ws: WebSocket, msg: ServerMessage) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
const broadcast = (msg: ServerMessage) => {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(data);
};

const initMessage = (): ServerMessage => ({
  type: 'init',
  world: sim.world.map,
  agents: sim.agentStates(),
  clock: sim.clock,
  events: sim.events.slice(-50),
  llm: llm.stats(),
  blueprints: [...sim.blueprints.values()],
  achievements: sim.achievements.unlocks,
  saveName: loadedName,
});

/** When switching simulations, drop pending deltas (clients get everything in the init message). */
function replace(next: Simulation, name: string | null) {
  const speed = sim.speed;
  sim = next;
  sim.speed = speed;
  loadedName = name;
  sim.drainEvents();
  sim.world.drainChanges();
  sim.world.drainAdded();
  sim.world.drainRemoved();
  sim.drainBlueprints();
  sim.achievements.drain();
  broadcast(initMessage());
}

function autosave() {
  try {
    saveSimulation(sim, AUTOSAVE);
  } catch (err) {
    console.warn(`[save] autosave failed: ${(err as Error).message}`);
  }
}

function handleAdmin(msg: AdminMessage) {
  applyAdmin(sim, msg);
  console.log(`[admin] ${JSON.stringify(msg)} → scarcity ×${sim.world.scarcity}`);
}

wss.on('connection', (ws) => {
  send(ws, initMessage());
  ws.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    switch (msg.type) {
      case 'setSpeed':
        if ((SPEEDS as readonly number[]).includes(msg.speed)) sim.speed = msg.speed;
        break;
      case 'regenerate':
        autosave();
        replace(new Simulation(newSeed(), llm), null);
        break;
      case 'setMind':
        llm.enabled = Boolean(msg.enabled);
        break;
      case 'admin':
        handleAdmin(msg);
        break;
      case 'save': {
        const name = saveSimulation(sim, `day${sim.clock.day}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`);
        sim.log(`💾 World saved: ${name}`);
        send(ws, { type: 'saves', saves: listSaves() });
        break;
      }
      case 'listSaves':
        send(ws, { type: 'saves', saves: listSaves() });
        break;
      case 'load':
        try {
          const loaded = loadSimulation(msg.name, llm);
          if (loaded) replace(loaded, msg.name);
          else send(ws, { type: 'notice', text: `Save not found: ${msg.name}` });
        } catch (err) {
          send(ws, { type: 'notice', text: `Could not load save: ${(err as Error).message}` });
        }
        break;
    }
  });
});

let broadcasts = 0;
setInterval(() => {
  for (let i = 0; i < sim.speed; i++) sim.step();
  const withEconomy = broadcasts++ % 10 === 0; // economy stats once per second
  broadcast({
    type: 'state',
    agents: sim.agentStates(),
    clock: sim.clock,
    events: sim.drainEvents(),
    objects: sim.world.drainChanges(),
    newObjects: sim.world.drainAdded(),
    removedObjects: sim.world.drainRemoved(),
    blueprints: sim.drainBlueprints(),
    achievements: sim.achievements.drain(),
    llm: llm.stats(),
    economy: withEconomy ? sim.economyStats() : null,
  });
}, 1000 / TICK_RATE);

setInterval(autosave, AUTOSAVE_MS);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    autosave();
    process.exit(0);
  });
}

server.listen(PORT, HOST, () => {
  const ui = existsSync(DIST) ? `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}` : 'http://localhost:5173 (npm run dev)';
  console.log(`🦀 Agent Aquarium — open ${ui}  (seed ${sim.seed}, day ${sim.clock.day})`);
  console.log(`🧠 Mind: ${llm.provider.name} / ${llm.provider.model}`);
});
