import { TICK_RATE, isNight, type AgentState, type ClientMessage, type ServerMessage, type WorldClock, type WorldMap, type WorldObject } from '../shared/protocol';
import { Renderer } from './renderer';
import { AudioEngine } from './audio';
import { EconomyPanel } from './economy';
import { UI } from './ui';
import './style.css';

const SNAPSHOT_MS = 1000 / TICK_RATE;

/** The server sends at 10 Hz; frames in between smoothly interpolate positions. */
interface Tracked {
  prev: AgentState;
  curr: AgentState;
}

const tracked = new Map<string, Tracked>();
const objects = new Map<number, WorldObject>();
let world: WorldMap | null = null;
let clock: WorldClock | null = null;
let lastSnapshotAt = performance.now();
let selectedId: string | null = null;
let ws: WebSocket | null = null;

const send = (msg: ClientMessage) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
const select = (id: string | null, focus = true) => {
  selectedId = id;
  const t = id ? tracked.get(id) : null;
  if (t && focus) renderer.centerOn([t.curr]);
  ui.setSelected(id);
  ui.updateAgents([...tracked.values()].map((t) => t.curr));
};

const renderer = new Renderer(document.querySelector<HTMLCanvasElement>('#world')!);
const ui = new UI(send, select);
const economy = new EconomyPanel(send);
const audio = new AudioEngine();
setupSoundControls();

// ---------- sound ----------
const lastBubble = new Map<string, string | null>();
const SFX: Record<string, 'hit' | 'tap' | 'munch' | 'chime'> = { '💥': 'hit', '⚔️': 'hit', '🔨': 'tap', '😋': 'munch', '☀️': 'chime', '🐣': 'chime', '✨': 'chime' };
const SILENT = new Set(['…', '💭', '💤', '💡']);
const seedOf = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

function playSounds(agents: AgentState[]) {
  for (const a of agents) {
    const prev = lastBubble.get(a.id);
    lastBubble.set(a.id, a.bubble);
    if (!a.bubble || a.bubble === prev || SILENT.has(a.bubble) || a.insideId != null) continue;
    const { pan, gain } = renderer.audibility(a.x, a.y);
    if (gain <= 0) continue;
    const effect = SFX[a.bubble];
    if (effect) audio.sfx(effect, pan, gain);
    else audio.speak(a.bubble, { seed: seedOf(a.id), mood: a.mood, child: a.stage === 'child', golem: a.isGolem, pan, gain });
  }
}

function setupSoundControls() {
  const btn = document.querySelector<HTMLButtonElement>('#sound')!;
  const menu = document.querySelector<HTMLElement>('#sound-menu')!;
  const toggle = document.querySelector<HTMLButtonElement>('#sound-toggle')!;
  const music = document.querySelector<HTMLInputElement>('#vol-music')!;
  const voice = document.querySelector<HTMLInputElement>('#vol-voice')!;
  try {
    const saved = JSON.parse(localStorage.getItem('aquarium-sound') ?? '{}');
    if (typeof saved.music === 'number') audio.musicVolume = saved.music;
    if (typeof saved.voice === 'number') audio.voiceVolume = saved.voice;
  } catch {
    // no browser storage: keep defaults
  }
  music.value = String(audio.musicVolume);
  voice.value = String(audio.voiceVolume);
  const persist = () => {
    try {
      localStorage.setItem('aquarium-sound', JSON.stringify({ music: audio.musicVolume, voice: audio.voiceVolume }));
    } catch {
      // ignore
    }
  };
  const refresh = () => {
    btn.textContent = audio.enabled ? '🔊' : '🔇';
    toggle.textContent = audio.enabled ? 'Turn sound off' : 'Turn sound on';
  };
  btn.onclick = async () => {
    // The first click starts audio (browser rule); later clicks open the settings menu.
    if (!audio.enabled) await audio.enable();
    else menu.hidden = !menu.hidden;
    refresh();
  };
  toggle.onclick = async () => {
    if (audio.enabled) audio.disable();
    else await audio.enable();
    refresh();
  };
  music.oninput = () => {
    audio.musicVolume = Number(music.value);
    audio.applyVolumes();
    persist();
  };
  voice.oninput = () => {
    audio.voiceVolume = Number(voice.value);
    audio.applyVolumes();
    persist();
  };
}

function applyAgents(agents: AgentState[], reset: boolean) {
  const seen = new Set<string>();
  for (const a of agents) {
    seen.add(a.id);
    const t = tracked.get(a.id);
    // Don't interpolate across long jumps (e.g. a new world).
    if (!t || reset || Math.hypot(t.curr.x - a.x, t.curr.y - a.y) > 3) tracked.set(a.id, { prev: a, curr: a });
    else tracked.set(a.id, { prev: t.curr, curr: a });
  }
  for (const id of tracked.keys()) if (!seen.has(id)) tracked.delete(id);
  lastSnapshotAt = performance.now();
  ui.updateAgents(agents);
}

function handle(msg: ServerMessage) {
  if (msg.type === 'saves') return ui.showSaves(msg.saves);
  if (msg.type === 'notice') return ui.toast('⚠️', msg.text);
  if (msg.type === 'init') {
    ui.resetAchievements(msg.achievements);
    renderer.setWorld(msg.world);
    objects.clear();
    for (const o of msg.world.objects) objects.set(o.id, o);
    world = msg.world;
    ui.resetBlueprints(msg.blueprints);
    applyAgents(msg.agents, true);
    renderer.centerOn(msg.agents);
    ui.resetEvents(msg.events);
  } else {
    for (const u of msg.objects) {
      const o = objects.get(u.id);
      if (o) o.amount = u.amount;
    }
    for (const o of msg.newObjects) {
      objects.set(o.id, o);
      world?.objects.push(o);
    }
    for (const id of msg.removedObjects) {
      const o = objects.get(id);
      objects.delete(id);
      if (o && world) world.objects.splice(world.objects.indexOf(o), 1);
    }
    if (msg.blueprints.length) ui.addBlueprints(msg.blueprints);
    if (msg.achievements.length) ui.addAchievements(msg.achievements, true);
    economy.update(msg.economy, msg.agents);
    applyAgents(msg.agents, false);
    playSounds(msg.agents);
    ui.appendEvents(msg.events);
  }
  clock = msg.clock;
  audio.setNight(isNight(msg.clock.timeOfDay));
  ui.updateClock(msg.clock);
  ui.updateLLM(msg.llm);
}

function connect() {
  ui.setConnection('connecting');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => ui.setConnection('open');
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    ui.setConnection('closed');
    setTimeout(connect, 1500);
  };
}

function frame(now: number) {
  const t = Math.min(1, (now - lastSnapshotAt) / SNAPSHOT_MS);
  const agents = [...tracked.values()].map(({ prev, curr }) => ({
    ...curr,
    x: prev.x + (curr.x - prev.x) * t,
    y: prev.y + (curr.y - prev.y) * t,
  }));
  renderer.render({ agents, clock, selectedId, now });
  requestAnimationFrame(frame);
}

// ---------- camera: drag to pan, wheel to zoom, click to select ----------
const canvas = renderer.canvas;
let drag: { x: number; y: number; moved: number } | null = null;

canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, moved: 0 };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  drag.moved += Math.abs(dx) + Math.abs(dy);
  drag.x = e.clientX;
  drag.y = e.clientY;
  if (drag.moved > 4) {
    canvas.classList.add('dragging');
    renderer.pan(dx, dy);
  }
});
canvas.addEventListener('pointerup', (e) => {
  canvas.classList.remove('dragging');
  if (drag && drag.moved <= 4) {
    const rect = canvas.getBoundingClientRect();
    const agents = [...tracked.values()].map((t) => t.curr);
    select(renderer.hitTest(e.clientX - rect.left, e.clientY - rect.top, agents)?.id ?? null, false);
  }
  drag = null;
});
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    renderer.zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1 : -1);
  },
  { passive: false },
);

connect();
requestAnimationFrame(frame);
