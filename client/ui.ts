import {
  EMOTION_META, ITEMS, SPEEDS, formatTime, isNight, type Emotion,
  type AgentState, type ClientMessage, type ItemType, type LLMStats, type LogEvent, type Needs, type Personality, type SaveInfo, type WorldClock,
} from '../shared/protocol';
import { ACHIEVEMENTS, type AchievementUnlock } from '../shared/achievements';
import { COMPONENTS, KINDS, TECH_THRESHOLDS, type Blueprint, type EquipmentState } from '../shared/invention';
import { CRAB_H, CRAB_W, crabSprite, itemIcon } from './sprites';

const TRAIT_LABELS: Record<keyof Personality, string> = {
  curiosity: 'Curiosity',
  sociability: 'Sociability',
  creativity: 'Creativity',
  aggression: 'Aggression',
  caution: 'Caution',
  laziness: 'Laziness',
};

const NEED_META: Record<keyof Needs, { label: string; icon: string; color: string }> = {
  food: { label: 'Fullness', icon: '🍓', color: '#e8894a' },
  energy: { label: 'Energy', icon: '⚡', color: '#e8c33a' },
  health: { label: 'Health', icon: '❤️', color: '#e05a6a' },
};

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

function crabPortrait(a: Pick<AgentState, 'color' | 'accessory'>, scale: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = CRAB_W * scale;
  c.height = CRAB_H * scale;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const sprite = crabSprite(a.color, a.accessory, { legs: 'stand', eyes: 'open', look: 0, squash: 0 });
  ctx.drawImage(sprite, 0, 0, c.width, c.height);
  return c;
}

const bar = (value: number, color: string) =>
  `<div class="bar"><i style="width:${value}%;background:${value < 20 ? '#d64545' : color}"></i></div>`;

function iconCanvas(shape: string, color: string, scale = 2): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 10 * scale;
  c.height = 10 * scale;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(itemIcon(shape, color), 0, 0, c.width, c.height);
  return c;
}

const compChips = (cs: EquipmentState['components']) =>
  cs.map((c) => `<span class="comp" title="${COMPONENTS[c.type].desc}">${COMPONENTS[c.type].emoji} ${COMPONENTS[c.type].name} ${c.power}</span>`).join('');

export class UI {
  private blueprintCount = 0;

  private agentIds = '';
  private inspectedId: string | null = null;
  private selectedId: string | null = null;

  constructor(
    private send: (msg: ClientMessage) => void,
    private onSelect: (id: string | null) => void,
  ) {
    $('#logo').replaceWith(Object.assign(crabPortrait({ color: '#D97757', accessory: 'none' }, 2), { id: 'logo' }));

    const speed = $('#speed');
    for (const s of SPEEDS) {
      const b = document.createElement('button');
      b.dataset.speed = String(s);
      b.textContent = s === 0 ? '⏸' : `${s}×`;
      b.title = s === 0 ? 'Pause' : `${s}× speed`;
      b.onclick = () => this.send({ type: 'setSpeed', speed: s });
      speed.append(b);
    }
    $('#save').onclick = () => this.send({ type: 'save' });
    $('#load').onclick = () => {
      const menu = $('#load-menu');
      if (!menu.hidden) return void (menu.hidden = true);
      this.send({ type: 'listSaves' });
    };
    $('#regen').onclick = () => {
      if (confirm('Generate a new world? The current aquarium will be reset.')) this.send({ type: 'regenerate' });
    };
  }

  updateLLM(stats: LLMStats) {
    const el = $('#mind');
    const tokens = stats.inputTokens + stats.outputTokens;
    const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
    const cost = stats.costUsd != null ? ` · $${stats.costUsd.toFixed(3)}` : '';
    el.textContent = stats.enabled ? `🧠 ${stats.model} · ${stats.calls} calls · ${fmt(tokens)} tokens${cost}` : '🧠 Mind off (reflexes)';
    el.classList.toggle('off', !stats.enabled);
    el.classList.toggle('error', stats.enabled && stats.errors > 0 && stats.lastError != null);
    el.title = [
      `Provider: ${stats.provider} / ${stats.model}`,
      `Calls: ${stats.calls} (errors ${stats.errors}, in flight ${stats.inFlight})`,
      `Tokens: ${stats.inputTokens} in (${stats.cacheReadTokens} cached) + ${stats.outputTokens} out`,
      `Left in today's budget: ${fmt(stats.budgetLeft)} tokens`,
      stats.lastError ? `Last error: ${stats.lastError}` : '',
      'Click: turn the mind on/off',
    ].filter(Boolean).join('\n');
    el.onclick = () => this.send({ type: 'setMind', enabled: !stats.enabled });
  }

  setConnection(status: 'connecting' | 'open' | 'closed') {
    const el = $('#conn');
    el.dataset.status = status;
    el.textContent = { connecting: 'Connecting…', open: 'Live', closed: 'Disconnected' }[status];
  }

  updateClock(clock: WorldClock) {
    $('#clock').textContent = `${isNight(clock.timeOfDay) ? '🌙' : '☀️'} Day ${clock.day} · ${formatTime(clock.timeOfDay)}`;
    document.querySelectorAll<HTMLButtonElement>('#speed button').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.speed) === clock.speed);
    });
  }

  setSelected(id: string | null) {
    this.selectedId = id;
  }

  private names = new Map<string, string>();

  updateAgents(agents: AgentState[]) {
    for (const a of agents) this.names.set(a.id, a.name);
    const list = $('#agents');
    const ids = agents.map((a) => a.id + a.color + a.accessory).join();
    if (ids !== this.agentIds) {
      this.agentIds = ids;
      list.replaceChildren(
        ...agents.map((a) => {
          const li = document.createElement('li');
          li.dataset.id = a.id;
          li.append(crabPortrait(a, 3));
          li.insertAdjacentHTML(
            'beforeend',
            `<div class="info"><strong></strong><small></small><div class="mini"></div></div><span class="mood"></span><span class="bubble"></span>`,
          );
          li.querySelector('strong')!.textContent = a.name;
          li.onclick = () => this.onSelect(this.selectedId === a.id ? null : a.id);
          return li;
        }),
      );
    }
    for (const a of agents) {
      const li = list.querySelector<HTMLElement>(`li[data-id="${a.id}"]`)!;
      li.classList.toggle('selected', a.id === this.selectedId);
      li.classList.toggle('fainted', a.fainted);
      li.querySelector('small')!.textContent =
        a.insideId != null ? `🏠 ${a.task}` : a.stage === 'egg' ? `Egg · ${Math.round((a.hatchProgress ?? 0) * 100)}%` : a.isGolem ? `🤖 ${a.task}` : a.stage === 'child' ? `Child · ${a.task}` : a.task;
      li.querySelector('.mini')!.innerHTML = bar(a.needs.food, NEED_META.food.color) + bar(a.needs.energy, NEED_META.energy.color);
      li.querySelector('.bubble')!.textContent = a.action === 'sleep' ? '💤' : a.bubble && [...a.bubble].length <= 3 ? a.bubble : '';
      const mood = li.querySelector<HTMLElement>('.mood')!;
      mood.textContent = EMOTION_META[a.mood].emoji;
      mood.title = EMOTION_META[a.mood].name;
    }
    this.updateInspector(agents.find((a) => a.id === this.selectedId) ?? null);
  }

  private updateInspector(agent: AgentState | null) {
    const panel = $('#inspector');
    if (!agent) {
      if (this.inspectedId !== null || !panel.hasChildNodes()) {
        this.inspectedId = null;
        panel.innerHTML = `<h2>Inspector</h2><p class="empty">Click an inhabitant to look into their inner world.</p>`;
      }
      return;
    }
    if (this.inspectedId !== agent.id) {
      this.inspectedId = agent.id;
      panel.innerHTML = `<h2>Inspector</h2><div class="who"></div><div class="badges"></div><div class="status"></div>
        <h3>Needs</h3><ul class="needs rows"></ul>
        <h3>Inventory</h3><div class="inventory"></div>
        <h3>Technology</h3><div class="tech"></div>
        <h3>Equipment</h3><ul class="equipment"></ul>
        <h3>Emotions <span class="mood-label"></span></h3><ul class="emotions rows"></ul>
        <h3>Mind <span class="source"></span></h3><div class="mind"></div>
        <h3>Relationships</h3><ul class="relations"></ul>
        <h3>Personality</h3><ul class="traits rows"></ul>
        <h3>Memories</h3><ol class="memories"></ol>`;
      const who = panel.querySelector('.who')!;
      who.append(crabPortrait(agent, 5));
      who.insertAdjacentHTML('beforeend', `<div><strong></strong><small>${agent.id}</small></div>`);
      who.querySelector('strong')!.textContent = agent.name;
      panel.querySelector('.badges')!.replaceChildren(
        ...agent.achievements.map((id) => {
          const def = ACHIEVEMENTS.find((a) => a.id === id)!;
          return Object.assign(document.createElement('span'), { className: 'badge', textContent: def.emoji, title: `${def.name} — ${def.desc}` });
        }),
      );
      panel.querySelector('.traits')!.innerHTML = (Object.keys(TRAIT_LABELS) as (keyof Personality)[])
        .map((k) => {
          const v = Math.round(agent.personality[k] * 100);
          return `<li><span>${TRAIT_LABELS[k]}</span>${bar(v, agent.color)}<b>${v}</b></li>`;
        })
        .join('');
    }

    const vehicle = agent.equipment.find((e) => e.kind === 'vehicle');
    panel.querySelector('.status')!.textContent = [
      agent.insideId != null ? '🏠 Inside their home' : '',
      agent.task,
      agent.riding ? `🚗 ${vehicle?.name ?? 'vehicle'}` : agent.swimming ? '🚣 on the water' : '',
      agent.enemies.length ? `⚔️ At war with: ${agent.enemies.map((id) => this.names.get(id) ?? id).join(', ')}` : '',
      `at (${Math.floor(agent.x)}, ${Math.floor(agent.y)})`,
    ].filter(Boolean).join(' · ');
    panel.querySelector('.needs')!.innerHTML = (Object.keys(NEED_META) as (keyof Needs)[])
      .map((k) => {
        const m = NEED_META[k];
        const v = Math.round(agent.needs[k]);
        return `<li><span>${m.icon} ${m.label}</span>${bar(v, m.color)}<b>${v}</b></li>`;
      })
      .join('');
    const next = TECH_THRESHOLDS.find((t) => t > agent.knowledge);
    const prev = [...TECH_THRESHOLDS].reverse().find((t) => t <= agent.knowledge) ?? 0;
    const pct = next ? Math.round(((agent.knowledge - prev) / (next - prev)) * 100) : 100;
    panel.querySelector('.tech')!.innerHTML = `<div class="tech-row"><b>Level ${agent.tech}</b>${bar(pct, '#7a5cd6')}<small>${agent.knowledge}${next ? ` / ${next}` : ''} knowledge</small></div>
      <small class="known">${agent.known.length ? `Known recipes: ${agent.known.map((k) => k.replace(/</g, '')).join(', ')}` : 'Knows no recipes yet.'}${agent.homeId != null ? ' · 🏠 Has a home' : ''}</small>`;
    const eq = panel.querySelector('.equipment')!;
    const eqKey = agent.equipment.map((e) => e.blueprintId + (e.uses ?? '')).join();
    if ((eq as HTMLElement).dataset.key !== eqKey) {
      (eq as HTMLElement).dataset.key = eqKey;
      eq.replaceChildren(
        ...(agent.equipment.length
          ? agent.equipment.map((e) => {
              const li = document.createElement('li');
              li.append(iconCanvas(e.shape, e.color));
              li.insertAdjacentHTML('beforeend', `<div><strong></strong><div class="comps">${compChips(e.components)}${e.uses != null ? `<span class="comp">×${e.uses}</span>` : ''}</div></div>`);
              li.querySelector('strong')!.textContent = e.name;
              return li;
            })
          : [Object.assign(document.createElement('li'), { className: 'empty', textContent: 'Carrying no equipment.' })]),
      );
    }

    const moodMeta = EMOTION_META[agent.mood];
    panel.querySelector('.mood-label')!.textContent = `${moodMeta.emoji} ${moodMeta.name}`;
    panel.querySelector('.emotions')!.innerHTML = (Object.keys(agent.emotions) as Emotion[])
      .map((e) => {
        const v = Math.round(agent.emotions[e] * 100);
        return `<li><span>${EMOTION_META[e].emoji} ${EMOTION_META[e].name}</span>${bar(v, EMOTION_META[e].color).replace('#d64545', EMOTION_META[e].color)}<b>${v}</b></li>`;
      })
      .join('');

    const rels = panel.querySelector('.relations')!;
    rels.replaceChildren(
      ...(agent.relations.length
        ? agent.relations.map((r) => {
            const li = document.createElement('li');
            const tone = r.affection >= 0.25 ? 'good' : r.affection <= -0.2 ? 'bad' : 'meh';
            const ally = agent.allies.includes(r.id) ? '<span class="tag ally">🤝 ally</span>' : agent.enemies.includes(r.id) ? '<span class="tag bad">⚔️ at war</span>' : '';
            li.innerHTML = `<div class="rel-head"><strong></strong><span class="tag ${tone}"></span>${ally}
              <span class="nums">♥ ${r.affection.toFixed(2)} · 🤝 ${r.trust.toFixed(2)}</span></div><p class="opinion"></p>`;
            li.querySelector('strong')!.textContent = r.name;
            li.querySelector('.tag')!.textContent = r.label;
            li.querySelector('.opinion')!.textContent = r.opinion ? `“${r.opinion}”` : '';
            li.onclick = () => this.onSelect(r.id);
            return li;
          })
        : [Object.assign(document.createElement('li'), { className: 'empty', textContent: "Hasn't met anyone yet." })]),
    );

    const m = agent.mind;
    const source = panel.querySelector('.source')!;
    source.textContent = m.thinking ? 'thinking…' : m.source === 'llm' ? 'LLM decision' : 'reflex';
    source.className = `source ${m.thinking ? 'thinking' : m.source}`;
    const mind = panel.querySelector('.mind')!;
    mind.replaceChildren();
    const thought = document.createElement('p');
    thought.className = 'thought';
    thought.textContent = m.thought ? `“${m.thought}”` : 'No deep thoughts yet.';
    mind.append(thought);
    if (m.longTerm) {
      const lt = document.createElement('p');
      lt.className = 'plan';
      lt.textContent = `📖 ${m.longTerm}`;
      mind.append(lt);
    }
    if (m.plan) {
      const plan = document.createElement('p');
      plan.className = 'plan';
      plan.textContent = `🎯 ${m.plan}`;
      mind.append(plan);
    }
    const memories = panel.querySelector('.memories')!;
    memories.replaceChildren(
      ...[...m.memories].reverse().map((text) => Object.assign(document.createElement('li'), { textContent: text })),
    );

    const items = (Object.entries(agent.inventory) as [ItemType, number][]).filter(([, n]) => n > 0);
    panel.querySelector('.inventory')!.innerHTML = items.length
      ? items.map(([k, n]) => `<span class="chip" title="${ITEMS[k].name}">${ITEMS[k].emoji} ${n}</span>`).join('')
      : `<span class="empty">Empty</span>`;
  }

  showSaves(saves: SaveInfo[]) {
    const menu = $('#load-menu');
    menu.replaceChildren(
      ...(saves.length
        ? saves.map((s) => {
            const b = document.createElement('button');
            b.innerHTML = `<strong></strong><small>Day ${s.day} · ${s.agents} inhabitants · ${new Date(s.savedAt).toLocaleString()}</small>`;
            b.querySelector('strong')!.textContent = s.name === 'autosave' ? 'Autosave' : s.name;
            b.onclick = () => {
              menu.hidden = true;
              if (confirm(`Load "${s.name}"? The current world will not be saved automatically.`)) this.send({ type: 'load', name: s.name });
            };
            return b;
          })
        : [Object.assign(document.createElement('p'), { className: 'empty', textContent: 'No saves yet.' })]),
    );
    menu.hidden = false;
  }

  toast(emoji: string, text: string, sub = '') {
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = `<span class="emoji">${emoji}</span><div><strong></strong><small></small></div>`;
    t.querySelector('strong')!.textContent = text;
    t.querySelector('small')!.textContent = sub;
    $('#toasts').append(t);
    setTimeout(() => t.classList.add('out'), 4200);
    setTimeout(() => t.remove(), 4800);
  }

  private unlocks: AchievementUnlock[] = [];

  resetAchievements(unlocks: AchievementUnlock[]) {
    this.unlocks = [];
    this.addAchievements(unlocks, false);
  }

  addAchievements(unlocks: AchievementUnlock[], notify: boolean) {
    this.unlocks.push(...unlocks);
    if (notify) {
      for (const u of unlocks) {
        const def = ACHIEVEMENTS.find((a) => a.id === u.achievementId)!;
        this.toast(def.emoji, `${u.agentName}: ${def.name}${u.firstInWorld ? ' — first in the world!' : ''}`, def.desc);
      }
    }
    const list = $('#achievements');
    list.replaceChildren(
      ...ACHIEVEMENTS.map((def) => {
        const got = this.unlocks.filter((u) => u.achievementId === def.id);
        const li = document.createElement('li');
        li.className = got.length ? 'got' : 'locked';
        li.innerHTML = `<span class="emoji">${got.length ? def.emoji : '🔒'}</span><div><strong>${def.name}</strong><small>${def.desc}</small><small class="who"></small></div>`;
        li.querySelector('.who')!.textContent = got.length
          ? `${got[0].agentName} (G${got[0].day})${got.length > 1 ? ` +${got.length - 1}` : ''}`
          : '';
        return li;
      }),
    );
    $('#ach-count').textContent = `${new Set(this.unlocks.map((u) => u.achievementId)).size}/${ACHIEVEMENTS.length}`;
  }

  resetBlueprints(bps: Blueprint[]) {
    $('#inventions').replaceChildren();
    this.blueprintCount = 0;
    this.addBlueprints(bps);
  }

  addBlueprints(bps: Blueprint[]) {
    const list = $('#inventions');
    for (const b of bps) {
      const li = document.createElement('li');
      li.append(iconCanvas(b.kind === 'structure' ? 'totem' : b.shape, b.color));
      li.insertAdjacentHTML(
        'beforeend',
        `<div><strong></strong> <small>${KINDS[b.kind]} · D${b.day}</small><div class="comps">${compChips(b.components)}</div><small class="by"></small></div>`,
      );
      li.querySelector('strong')!.textContent = b.name;
      li.querySelector('.by')!.textContent = `Invented by ${b.inventorName} — ${b.description}`;
      li.onclick = () => this.onSelect(b.inventorId);
      list.prepend(li);
      this.blueprintCount++;
    }
    $('#inv-count').textContent = String(this.blueprintCount);
  }

  resetEvents(events: LogEvent[]) {
    $('#log').replaceChildren();
    this.appendEvents(events);
  }

  appendEvents(events: LogEvent[]) {
    const log = $('#log');
    for (const e of events) {
      const li = document.createElement('li');
      li.innerHTML = `<time>D${e.day} ${formatTime(e.timeOfDay)}</time><span></span>`;
      li.querySelector('span')!.textContent = e.text;
      if (e.text.includes(' → ')) li.classList.add('speech');
      if (/🤝 .* traded|🎁|an offer|💰|🏪/.test(e.text)) li.classList.add('trade');
      if (/🔨 .* invented|🎓|🕊️ .* took off/.test(e.text)) li.classList.add('milestone');
      if (/💥 .* design failed/.test(e.text)) li.classList.add('fail');
      if (/⚔️|🛡️|😵|🫳|🏃|💔|🔥|💥 .* razed/.test(e.text)) li.classList.add('combat');
      if (/formed an alliance|☮️|🕊️ The war/.test(e.text)) li.classList.add('peace');
      if (/🪦/.test(e.text)) li.classList.add('death');
      if (e.agentId) {
        li.classList.add('clickable');
        li.onclick = () => this.onSelect(e.agentId!);
      }
      log.prepend(li);
    }
    while (log.children.length > 150) log.lastElementChild!.remove();
  }
}
