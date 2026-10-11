import { TRADE_ITEMS, type EconomyStats } from '../shared/economy';
import { ITEMS, formatTime, type AgentState, type ClientMessage } from '../shared/protocol';

/**
 * Admin "central bank" panel: berry supply, flows, prices, wealth distribution, and
 * monetary/nature policies applied without the inhabitants knowing.
 */

interface Series {
  name: string;
  color: string;
  values: number[];
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Small line chart: single axis, thin lines, crosshair + value on hover. */
function lineChart(el: HTMLElement, labels: string[], series: Series[], unit: string) {
  const W = 360;
  const H = 120;
  const pad = { l: 30, r: 10, t: 10, b: 18 };
  const n = Math.max(...series.map((s) => s.values.length), 0);
  if (n < 2) {
    el.innerHTML = `<p class="eco-empty">The chart needs at least two days of data.</p>`;
    return;
  }
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const x = (i: number) => pad.l + (i / (n - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const ticks = [0, Math.round(max / 2), max];
  const grid = ticks
    .map((t) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${pad.l - 4}" y="${y(t) + 3}" class="axis" text-anchor="end">${t}</text>`)
    .join('');
  const lines = series
    .map((s) => `<polyline fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')}"/>`)
    .join('');
  const xl = [0, n - 1].map((i) => `<text x="${x(i)}" y="${H - 4}" class="axis" text-anchor="${i ? 'end' : 'start'}">${esc(labels[i] ?? '')}</text>`).join('');
  const legend =
    series.length > 1
      ? `<div class="eco-legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>`
      : '';
  el.innerHTML = `${legend}<div class="eco-chart"><svg viewBox="0 0 ${W} ${H}" role="img">${grid}${lines}${xl}<line class="cross" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/></svg><div class="eco-tip" hidden></div></div>`;
  const svg = el.querySelector('svg')!;
  const cross = svg.querySelector<SVGLineElement>('.cross')!;
  const tip = el.querySelector<HTMLElement>('.eco-tip')!;
  svg.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (n - 1))));
    cross.setAttribute('x1', String(x(i)));
    cross.setAttribute('x2', String(x(i)));
    cross.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.innerHTML = `<b>${esc(labels[i] ?? '')}</b>${series.map((s) => `<div><i style="background:${s.color}"></i>${esc(s.name)}: <b>${s.values[i] ?? '—'}</b> ${unit}</div>`).join('')}`;
    tip.style.left = `${Math.min(70, (x(i) / W) * 100)}%`;
  });
  svg.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  });
}

function sparkline(values: number[]): string {
  if (values.length < 2) return '<span class="eco-muted">—</span>';
  const W = 80;
  const H = 22;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = Math.max(1, max - min);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * W},${H - 2 - ((v - min) / span) * (H - 4)}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" class="spark"><polyline fill="none" stroke="var(--eco-s1)" stroke-width="1.5" points="${pts}"/><title>${values.join(' → ')} 🫐</title></svg>`;
}

/** Turns the scarcity multiplier into words: 0.25 → "4× abundant", 3 → "3× scarce". */
function abundanceLabel(scarcity: number): string {
  if (Math.abs(scarcity - 1) < 0.05) return 'normal';
  return scarcity < 1 ? `${(1 / scarcity).toFixed(1).replace('.0', '')}× abundant` : `${scarcity.toFixed(1).replace('.0', '')}× scarce`;
}

export class EconomyPanel {
  private el: HTMLElement;
  private stats: EconomyStats | null = null;
  private agents: AgentState[] = [];
  private controlsBuilt = false;

  constructor(private send: (msg: ClientMessage) => void) {
    this.el = document.querySelector<HTMLElement>('#economy')!;
    document.querySelector<HTMLButtonElement>('#eco-toggle')!.onclick = () => this.toggle();
  }

  toggle(open = this.el.hidden) {
    this.el.hidden = !open;
    if (open) this.render();
  }

  update(stats: EconomyStats | null, agents: AgentState[]) {
    this.agents = agents;
    if (!stats) return;
    this.stats = stats;
    if (!this.el.hidden) this.render();
  }

  private admin(msg: Extract<ClientMessage, { type: 'admin' }>) {
    this.send(msg);
  }

  private render() {
    const s = this.stats;
    if (!this.controlsBuilt) this.buildControls();
    const body = this.el.querySelector<HTMLElement>('.eco-body')!;
    if (!s) {
      body.innerHTML = '<p class="eco-empty">Waiting for data…</p>';
      return;
    }
    const b = s.berries;
    const f = s.flows;
    body.innerHTML = `
      <section class="eco-tiles">
        <div class="tile hero"><small>Total 🫐 in circulation</small><b>${b.total}</b></div>
        <div class="tile"><small>In bags</small><b>${b.inventories}</b></div>
        <div class="tile"><small>On bushes</small><b>${b.bushes}</b></div>
        <div class="tile"><small>At market (escrow)</small><b>${b.market}</b></div>
        <div class="tile"><small>Inequality (Gini)</small><b>${s.gini.toFixed(2)}</b><small>${s.gini < 0.25 ? 'equal' : s.gini < 0.45 ? 'moderate' : 'high'}</small></div>
      </section>
      <h3>Today's flows (Day ${s.day})</h3>
      <ul class="eco-flows">
        <li><span>🌿 Harvested</span><b>+${f.harvested}</b></li>
        <li><span>😋 Eaten</span><b>−${f.eaten}</b></li>
        <li><span>🪂 Airdropped</span><b>+${f.airdropped}</b></li>
        <li><span>🔥 Burned (tax/fees)</span><b>−${f.burned}</b></li>
        <li><span>🍂 Spoiled</span><b>−${f.spoiled}</b></li>
      </ul>
      <h3>Daily supply</h3><div class="chart-supply"></div>
      <h3>Berries harvested vs. eaten</h3><div class="chart-flows"></div>
      <h3>Market prices <small>(🫐 / unit)</small></h3>
      <table class="eco-table">
        <thead><tr><th>Item</th><th>Last</th><th>Bid</th><th>Ask</th><th>Volume</th><th>History</th></tr></thead>
        <tbody>${TRADE_ITEMS.map((it) => {
          const p = s.prices[it];
          return `<tr><td>${ITEMS[it].emoji} ${ITEMS[it].name}</td><td>${p.last ?? '—'}</td><td>${p.bid ?? '—'}</td><td>${p.ask ?? '—'}</td><td>${p.volume}</td><td>${sparkline(p.history.map((h) => h.price))}</td></tr>`;
        }).join('')}</tbody>
      </table>
      <h3>Wealth</h3>
      <ul class="eco-wealth">${(() => {
        const top = Math.max(1, ...s.wealth.map((w) => w.netWorth));
        return s.wealth
          .map((w) => `<li><span class="who"><i style="background:${w.color}"></i>${esc(w.name)}</span><span class="bar"><i style="width:${(w.netWorth / top) * 100}%;background:${w.color}"></i></span><b>${w.netWorth}</b><small>${w.berries}🫐 + ${w.materials}</small></li>`)
          .join('') || '<li class="eco-empty">Nobody</li>';
      })()}</ul>
      <h3>Open orders (${s.orders.length})</h3>
      <ul class="eco-list">${s.orders.map((o) => `<li>${o.side === 'sell' ? '🏷️ Sell' : '🪙 Buy'} · ${esc(o.agentName)} · ${o.qty} ${ITEMS[o.item].emoji} × ${o.price} 🫐</li>`).join('') || '<li class="eco-empty">None</li>'}</ul>
      <h3>Recent trades</h3>
      <ul class="eco-list">${s.recentTrades.map((t) => `<li>D${t.day} ${formatTime(t.timeOfDay)} · ${esc(t.seller)} → ${esc(t.buyer)} · ${t.qty} ${ITEMS[t.item].emoji} × ${t.price} 🫐</li>`).join('') || '<li class="eco-empty">No trades yet</li>'}</ul>`;

    const days = s.daily.map((d) => `D${d.day}`);
    lineChart(body.querySelector('.chart-supply')!, days, [{ name: 'Total supply', color: 'var(--eco-s1)', values: s.daily.map((d) => d.supply) }], '🫐');
    lineChart(body.querySelector('.chart-flows')!, days, [
      { name: 'Harvested', color: 'var(--eco-s1)', values: s.daily.map((d) => d.harvested) },
      { name: 'Eaten', color: 'var(--eco-s2)', values: s.daily.map((d) => d.eaten) },
    ], '🫐');

    // Setting indicators
    const st = s.settings;
    this.el.querySelector<HTMLOutputElement>('#eco-scarcity-out')!.value = abundanceLabel(st.scarcity);
    this.el.querySelector<HTMLOutputElement>('#eco-spoil-out')!.value = `${Math.round(st.spoilage * 100)}%/day`;
    this.el.querySelector<HTMLOutputElement>('#eco-fee-out')!.value = `${Math.round(st.fee * 100)}%`;
    const target = this.el.querySelector<HTMLSelectElement>('#eco-target')!;
    const keep = target.value;
    target.innerHTML = `<option value="">Everyone</option>${this.agents
      .filter((a) => !a.isGolem && a.stage !== 'egg')
      .map((a) => `<option value="${a.id}">${esc(a.name)} (🍓${Math.round(a.needs.food)} ❤️${Math.round(a.needs.health)})</option>`)
      .join('')}`;
    target.value = keep;
  }

  private buildControls() {
    this.controlsBuilt = true;
    const c = this.el.querySelector<HTMLElement>('.eco-controls')!;
    c.innerHTML = `
      <p class="eco-note">These controls are secret: the inhabitants and the event log never hear about them — they only live with the consequences.</p>
      <label>🌱 Nature's bounty <small>(left: scarcity · middle: normal · right: abundance)</small>
        <span class="row"><span>🏜️</span><input id="eco-scarcity" type="range" min="-3" max="2" step="0.25" value="0"><span>🌳</span><output id="eco-scarcity-out">normal</output><button id="eco-scarcity-apply">Apply</button></span>
      </label>
      <span class="row"><button id="eco-rain">🌧️ Make it rain</button><button id="eco-wither">☀️ Drought shock (50%)</button></span>
      <label>🪂 Airdrop berries
        <span class="row"><input id="eco-air-n" type="number" min="1" max="50" value="5"><select id="eco-target"></select><button id="eco-air">Drop</button></span>
      </label>
      <label>🧾 Tax <small>(destroy a share of the berries in everyone's bags)</small>
        <span class="row"><input id="eco-tax" type="number" min="1" max="100" value="20"><span>%</span><button id="eco-tax-go">Apply</button></span>
      </label>
      <label>🍂 Spoilage <small>(daily loss of berries in bags — discourages hoarding)</small>
        <span class="row"><input id="eco-spoil" type="range" min="0" max="0.5" step="0.05" value="0"><output id="eco-spoil-out">0%</output></span>
      </label>
      <label>⛵ Send an immigrant tribe <small>(allied strangers wash ashore)</small>
        <span class="row"><input id="eco-imm-n" type="number" min="1" max="4" value="3">
          <select id="eco-imm-t"><option value="aggressive">Aggressive</option><option value="mixed">Mixed</option><option value="peaceful">Peaceful</option></select>
          <label class="inline"><input id="eco-imm-armed" type="checkbox" checked> armed</label>
          <button id="eco-imm">Send</button></span>
      </label>
      <label>💸 Market fee <small>(share of every sale that is burned)</small>
        <span class="row"><input id="eco-fee" type="range" min="0" max="0.3" step="0.05" value="0"><output id="eco-fee-out">0%</output></span>
      </label>`;
    const q = <T extends HTMLElement>(id: string) => c.querySelector<T>(`#${id}`)!;
    const scarcity = q<HTMLInputElement>('eco-scarcity');
    // The slider is "abundance"; the server value is the regrowth-time multiplier (scarcity) = 1 / abundance.
    const toScarcity = () => Math.round(2 ** -Number(scarcity.value) * 100) / 100;
    scarcity.oninput = () => (q<HTMLOutputElement>('eco-scarcity-out').value = abundanceLabel(toScarcity()));
    q('eco-scarcity-apply').onclick = () => this.admin({ type: 'admin', op: 'scarcity', value: toScarcity() });
    q('eco-imm').onclick = () =>
      confirm('Send an immigrant tribe to the island? This cannot be undone.') &&
      this.admin({
        type: 'admin', op: 'immigrants',
        count: Number(q<HTMLInputElement>('eco-imm-n').value) || 3,
        temperament: q<HTMLSelectElement>('eco-imm-t').value as 'aggressive' | 'peaceful' | 'mixed',
        armed: q<HTMLInputElement>('eco-imm-armed').checked,
      });
    q('eco-rain').onclick = () => this.admin({ type: 'admin', op: 'rain' });
    q('eco-wither').onclick = () => confirm('Wither half of the berries currently on bushes?') && this.admin({ type: 'admin', op: 'wither', fraction: 0.5 });
    q('eco-air').onclick = () =>
      this.admin({ type: 'admin', op: 'airdrop', berries: Number(q<HTMLInputElement>('eco-air-n').value) || 0, target: q<HTMLSelectElement>('eco-target').value || null });
    q('eco-tax-go').onclick = () => {
      const pct = Number(q<HTMLInputElement>('eco-tax').value) || 0;
      if (confirm(`Destroy ${pct}% of the berries in everyone's bag?`)) this.admin({ type: 'admin', op: 'tax', fraction: pct / 100 });
    };
    q<HTMLInputElement>('eco-spoil').onchange = (e) => this.admin({ type: 'admin', op: 'spoilage', rate: Number((e.target as HTMLInputElement).value) });
    q<HTMLInputElement>('eco-fee').onchange = (e) => this.admin({ type: 'admin', op: 'fee', rate: Number((e.target as HTMLInputElement).value) });
  }
}
