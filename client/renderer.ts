import { EMOTION_META, TERRITORY_RADIUS, type AgentState, type WorldClock, type WorldMap, type WorldObject } from '../shared/protocol';
import {
  BUSH_H, BUSH_W, CRAB_H, ROCK_H, ROCK_W, TREE_H, TREE_W,
  RIDE_W, STRUCT_H, STRUCT_W, bushSprite, crabSprite, eggSprite, rideSprite, hash, itemIcon, rockSprite, structureSprite, stumpSprite, treeSprite, wingSprite, type CrabPose,
} from './sprites';
import { TILE, buildTerrain } from './terrain';

export interface FrameState {
  agents: AgentState[]; // x/y zaten interpolasyonlu
  clock: WorldClock | null;
  selectedId: string | null;
  now: number;
}

type Drawable = { y: number; draw: () => void };

const idPhase = (id: string) => [...id].reduce((h, c) => h * 31 + c.charCodeAt(0), 7) % 1000;

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private world: WorldMap | null = null;
  private terrain: HTMLCanvasElement | null = null;
  private waterTiles: number[] = [];
  private dpr = 1;
  zoom = 3; // device pixels per world pixel
  camX = 0; // world pixel at the screen center
  camY = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  setWorld(world: WorldMap) {
    this.world = world;
    this.terrain = buildTerrain(world);
    this.waterTiles = world.tiles.flatMap((t, i) => (t === 'water' ? [i] : []));
    this.camX = (world.width * TILE) / 2;
    this.camY = (world.height * TILE) / 2;
    const fit = Math.min(this.canvas.width / (world.width * TILE), this.canvas.height / (world.height * TILE));
    this.zoom = Math.min(this.maxZoom, Math.max(Math.ceil(fit), Math.round(3 * this.dpr)));
    this.clampCamera();
  }

  centerOn(points: { x: number; y: number }[]) {
    if (!points.length) return;
    this.camX = (points.reduce((s, p) => s + p.x, 0) / points.length) * TILE;
    this.camY = (points.reduce((s, p) => s + p.y, 0) / points.length) * TILE;
    this.clampCamera();
  }

  get minZoom() {
    return Math.max(1, Math.round(this.dpr));
  }
  get maxZoom() {
    return Math.round(8 * this.dpr);
  }

  private resize() {
    this.dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    this.clampCamera();
  }

  clampCamera() {
    if (!this.world) return;
    this.camX = Math.min(Math.max(this.camX, 0), this.world.width * TILE);
    this.camY = Math.min(Math.max(this.camY, 0), this.world.height * TILE);
  }

  /** Converts CSS pixel coordinates to world pixels. */
  screenToWorld(sx: number, sy: number) {
    return {
      x: (sx * this.dpr - this.canvas.width / 2) / this.zoom + this.camX,
      y: (sy * this.dpr - this.canvas.height / 2) / this.zoom + this.camY,
    };
  }

  /** How "audible" a world point is from the camera: left/right pan and closeness-based gain. */
  audibility(tileX: number, tileY: number): { pan: number; gain: number } {
    const sx = (tileX * TILE - this.camX) * this.zoom; // device pixels relative to the screen center
    const sy = (tileY * TILE - this.camY) * this.zoom;
    const hw = this.canvas.width / 2;
    const hh = this.canvas.height / 2;
    const d = Math.hypot(sx / hw, sy / hh); // 0 = merkez, 1 ≈ kenar
    if (d > 1.25) return { pan: 0, gain: 0 }; // off screen: inaudible
    const closeness = Math.min(1.3, Math.max(0.35, this.zoom / (3 * this.dpr)));
    return { pan: Math.max(-1, Math.min(1, sx / hw)) * 0.8, gain: Math.max(0, 1 - d * 0.7) * closeness };
  }

  zoomAt(sx: number, sy: number, delta: number) {
    const before = this.screenToWorld(sx, sy);
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom + delta));
    const after = this.screenToWorld(sx, sy);
    this.camX += before.x - after.x;
    this.camY += before.y - after.y;
    this.clampCamera();
  }

  pan(dxCss: number, dyCss: number) {
    this.camX -= (dxCss * this.dpr) / this.zoom;
    this.camY -= (dyCss * this.dpr) / this.zoom;
    this.clampCamera();
  }

  hitTest(sx: number, sy: number, agents: AgentState[]): AgentState | null {
    const p = this.screenToWorld(sx, sy);
    let best: AgentState | null = null;
    let bestD = 12;
    for (const a of agents) {
      const d = Math.hypot(a.x * TILE - p.x, a.y * TILE - 3 - p.y);
      if (d < bestD) {
        best = a;
        bestD = d;
      }
    }
    return best;
  }

  render(frame: FrameState) {
    const { ctx, canvas, zoom } = this;
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#2e60a4';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!this.world || !this.terrain) return;

    const ox = Math.round(canvas.width / 2 - this.camX * zoom);
    const oy = Math.round(canvas.height / 2 - this.camY * zoom);
    const toScreen = (wx: number, wy: number) => [ox + Math.round(wx) * zoom, oy + Math.round(wy) * zoom] as const;
    const blit = (img: HTMLCanvasElement, wx: number, wy: number) => {
      const [sx, sy] = toScreen(wx, wy);
      ctx.drawImage(img, sx, sy, img.width * zoom, img.height * zoom);
    };

    ctx.drawImage(this.terrain, ox, oy, this.terrain.width * zoom, this.terrain.height * zoom);
    this.drawSparkles(frame.now, toScreen);
    this.drawTerritories(toScreen);

    // Draw sorted by Y so a crab behind a tree stays behind it.
    const occupants = new Map<number, number>();
    for (const a of frame.agents) if (a.insideId != null) occupants.set(a.insideId, (occupants.get(a.insideId) ?? 0) + 1);
    const drawables: Drawable[] = this.world.objects.map((o) => this.objectDrawable(o, blit, toScreen, occupants.get(o.id) ?? 0, frame.now));
    for (const a of frame.agents) {
      if (a.insideId != null) continue; // inside a house: invisible
      const wx = a.x * TILE;
      const wy = a.y * TILE;
      if (a.stage === 'egg') {
        // Eggs about to hatch wobble.
        const wobble = (a.hatchProgress ?? 0) > 0.8 && Math.floor(frame.now / 150) % 2 ? 1 : 0;
        drawables.push({ y: wy + 3, draw: () => blit(eggSprite(a.color), wx - 5 + wobble, wy - 8) });
        continue;
      }
      const { dx, dy: moodDy } = this.moodOffset(a, frame.now);
      // Flyers rise up while their shadow shrinks on the ground.
      const vehicle = a.equipment.find((e) => e.kind === 'vehicle' && !e.components.some((c) => c.type === 'flight'));
      const ride = !a.flying && (a.swimming || (a.riding && vehicle)) ? (a.swimming ? 'boat' : vehicle!.shape) : null;
      const lift = a.flying ? 7 + Math.round(Math.sin(frame.now / 250 + idPhase(a.id)) * 1.5) : ride ? 3 : 0;
      const dy = moodDy - lift;
      drawables.push({
        y: wy + 3,
        draw: () => {
          ctx.fillStyle = a.flying ? 'rgba(20,30,20,0.14)' : 'rgba(20,30,20,0.22)';
          const [sx, sy] = toScreen(wx - 6, wy + 2);
          if (a.flying) ctx.fillRect(sx + 3 * zoom, sy, 7 * zoom, zoom);
          else {
            ctx.fillRect(sx + zoom, sy, 11 * zoom, zoom);
            ctx.fillRect(sx, sy + zoom, 13 * zoom, zoom);
          }
          const top = wy + 4 - CRAB_H + dy;
          if (ride) {
            const bob = ride === 'boat' ? Math.round(Math.sin(frame.now / 300) * 1) : 0;
            blit(rideSprite(ride, a.swimming && vehicle?.shape !== 'boat' ? '#8c6040' : (vehicle?.color ?? '#8c6040'), Math.floor(frame.now / 120) % 2), wx - RIDE_W / 2, wy - 3 + bob);
          }
          if (a.flying) blit(wingSprite(Math.floor(frame.now / 160) % 2 === 0), wx - 10 + dx, top + 3);
          const sprite = crabSprite(a.color, a.accessory, this.poseFor(a, frame.now));
          if (a.stage === 'child') {
            // Children are drawn smaller (feet stay on the ground).
            const s = 0.7;
            const [sx2, sy2] = toScreen(wx - 6 * s + dx, wy + 4 - CRAB_H * s + dy);
            ctx.drawImage(sprite, sx2, sy2, Math.round(sprite.width * zoom * s), Math.round(sprite.height * zoom * s));
          } else blit(sprite, wx - 6 + dx, top);
          // The tool in hand shows while working.
          const tool = a.action === 'gather' ? a.equipment.find((e) => e.kind === 'tool' || e.kind === 'weapon') : undefined;
          const shown = tool ?? (a.action === 'talk' || a.action === 'walk' ? a.equipment.find((e) => e.kind === 'weapon') : undefined);
          if (shown) {
            const swing = a.action === 'gather' && Math.floor(frame.now / 160) % 2 ? -1 : 0;
            blit(itemIcon(shown.shape, shown.color), a.facing > 0 ? wx + 5 + dx : wx - 15 + dx, top + 4 + swing);
          }
        },
      });
    }
    drawables.sort((a, b) => a.y - b.y).forEach((d) => d.draw());

    this.drawLighting(frame, toScreen);
    this.drawOverlays(frame, toScreen);
  }

  /** Land around flags: a faint tint and border in the owner's color. */
  private drawTerritories(toScreen: (x: number, y: number) => readonly [number, number]) {
    const { ctx, zoom } = this;
    const flags = this.world!.objects.filter((o) => o.structure?.shape === 'flag');
    for (const f of flags) {
      const color = f.structure!.color;
      for (let dy = -TERRITORY_RADIUS; dy <= TERRITORY_RADIUS; dy++) {
        for (let dx = -TERRITORY_RADIUS; dx <= TERRITORY_RADIUS; dx++) {
          const d = Math.hypot(dx, dy);
          if (d > TERRITORY_RADIUS + 0.5) continue;
          const edge = d > TERRITORY_RADIUS - 0.6;
          const [sx, sy] = toScreen((f.x + dx) * TILE, (f.y + dy) * TILE);
          ctx.globalAlpha = edge ? 0.28 : 0.1;
          ctx.fillStyle = color;
          ctx.fillRect(sx, sy, TILE * zoom, TILE * zoom);
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  private objectDrawable(
    o: WorldObject,
    blit: (img: HTMLCanvasElement, x: number, y: number) => void,
    toScreen: (x: number, y: number) => readonly [number, number],
    occupants: number,
    now: number,
  ): Drawable {
    const bx = o.x * TILE + TILE / 2;
    const by = o.y * TILE + TILE - 2;
    switch (o.type) {
      case 'tree':
        return {
          y: by,
          draw: () => blit(o.amount > 0 ? treeSprite(o.variant) : stumpSprite(o.variant), bx - TREE_W / 2, by - TREE_H + 1),
        };
      case 'rock':
        return { y: by, draw: () => blit(rockSprite(o.variant), bx - ROCK_W / 2, by - ROCK_H + 1) };
      case 'bush':
        return { y: by, draw: () => blit(bushSprite(o.variant, o.amount > 0), bx - BUSH_W / 2, by - BUSH_H + 1) };
      case 'structure':
        return {
          y: by + 1,
          draw: () => {
            blit(structureSprite(o.structure?.shape ?? 'hut', o.structure?.color ?? '#c0703f'), bx - STRUCT_W / 2, by - STRUCT_H + 2);
            const { ctx, zoom } = this;
            // Smoke rises from the chimney when someone is inside.
            if (occupants > 0) {
              ctx.fillStyle = 'rgba(235,235,240,0.75)';
              for (let i = 0; i < 3; i++) {
                const t = ((now / 1400 + i / 3) % 1);
                const [sx, sy] = toScreen(bx + 4 + Math.sin(t * 6 + i) * 2, by - STRUCT_H + 2 - t * 10);
                const r = Math.max(1, Math.round((1 + t * 2) * zoom));
                ctx.globalAlpha = 1 - t;
                ctx.fillRect(sx, sy, r, r);
              }
              ctx.globalAlpha = 1;
            }
            // HP bar when damaged
            if (o.max > 0 && o.max < 9999 && o.amount < o.max) {
              const [sx, sy] = toScreen(bx - 8, by - STRUCT_H);
              ctx.fillStyle = 'rgba(29,26,34,0.8)';
              ctx.fillRect(sx, sy, 16 * zoom, 2 * zoom);
              ctx.fillStyle = o.amount / o.max > 0.5 ? '#8fe06a' : o.amount / o.max > 0.25 ? '#e8b54a' : '#e0524f';
              ctx.fillRect(sx, sy, 16 * zoom * (o.amount / o.max), 2 * zoom);
            }
          },
        };
    }
  }

  /** Small mood-based motions: joy makes them hop, fear makes them tremble. */
  private moodOffset(a: AgentState, now: number): { dx: number; dy: number } {
    if (a.action === 'sleep' || a.action === 'gather') return { dx: 0, dy: 0 };
    const phase = idPhase(a.id);
    if (a.action === 'attack') return { dx: Math.floor((now + phase) / 120) % 2 ? a.facing * 2 : 0, dy: 0 }; // lunge
    if (a.mood === 'fear') return { dx: Math.floor((now + phase) / 70) % 2 ? 1 : 0, dy: 0 };
    if (a.mood === 'joy' && a.action !== 'eat') {
      const t = (now + phase * 3) % 1600;
      return { dx: 0, dy: t < 220 ? -Math.round(Math.sin((t / 220) * Math.PI) * 3) : 0 };
    }
    if (a.action === 'talk' && a.bubble && a.bubble.length > 3) {
      return { dx: 0, dy: Math.floor(now / 180) % 2 ? -1 : 0 }; // slight bob while talking
    }
    return { dx: 0, dy: 0 };
  }

  /** Eyes by mood (blinking overrides this briefly). */
  private moodEyes(a: AgentState, now: number, phase: number): CrabPose['eyes'] {
    if ((now + phase * 7) % 3800 < 130) return 'closed';
    switch (a.mood) {
      case 'joy':
        return (now + phase * 3) % 1600 < 400 ? 'happy' : 'open';
      case 'sadness':
      case 'loneliness':
        return 'sad';
      case 'anger':
        return 'angry';
      default:
        return 'open';
    }
  }

  private poseFor(a: AgentState, now: number): CrabPose {
    const phase = idPhase(a.id);
    if (a.action === 'sleep') {
      return { legs: 'stand', eyes: 'closed', look: 0, squash: Math.floor((now + phase) / 1400) % 2 ? 1 : 0 };
    }
    if (a.action === 'gather') {
      // Quick "whack-whack" motion
      return { legs: 'stand', eyes: a.mood === 'anger' ? 'angry' : 'open', look: a.facing, squash: Math.floor((now + phase) / 160) % 2 ? 1 : 0 };
    }
    if (a.action === 'eat') {
      const chew = Math.floor((now + phase) / 220) % 2;
      return { legs: 'stand', eyes: chew ? 'closed' : 'open', look: 0, squash: chew ? 1 : 0 };
    }
    const eyes = this.moodEyes(a, now, phase);
    if (a.action === 'walk') {
      const stride = a.mood === 'sadness' ? 220 : 140;
      return { legs: Math.floor((now + phase) / stride) % 2 ? 'walkA' : 'walkB', eyes, look: a.facing, squash: 0 };
    }
    if (a.action === 'talk') return { legs: 'stand', eyes, look: a.facing, squash: 0 };
    if (a.action === 'attack') {
      return { legs: Math.floor((now + phase) / 120) % 2 ? 'walkA' : 'walkB', eyes: 'angry', look: a.facing, squash: Math.floor((now + phase) / 120) % 2 ? 1 : 0 };
    }
    return {
      legs: 'stand',
      eyes,
      look: a.bubble ? a.facing : 0,
      // Slumped posture when sad, otherwise breathing.
      squash: a.mood === 'sadness' ? 1 : Math.floor((now + phase) / 700) % 2 ? 1 : 0,
    };
  }

  private drawSparkles(now: number, toScreen: (x: number, y: number) => readonly [number, number]) {
    const { ctx, zoom } = this;
    const w = this.world!.width;
    const frame = Math.floor(now / 450);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    for (const i of this.waterTiles) {
      if (hash(i, frame, 41) > 0.06) continue;
      const tx = (i % w) * TILE + 3 + Math.floor(hash(i, frame, 42) * 10);
      const ty = Math.floor(i / w) * TILE + 3 + Math.floor(hash(i, frame, 43) * 10);
      const [sx, sy] = toScreen(tx, ty);
      ctx.fillRect(sx, sy, zoom * 2, zoom);
    }
  }

  private lightLayer = document.createElement('canvas');

  private drawLighting(frame: FrameState, toScreen: (x: number, y: number) => readonly [number, number]) {
    const clock = frame.clock;
    if (!clock) return;
    const { ctx, canvas } = this;
    const sun = Math.cos((clock.timeOfDay - 0.5) * Math.PI * 2); // noon 1, midnight -1
    const dark = Math.min(0.55, Math.max(0, (0.3 - sun) * 0.5));
    const dusk = Math.max(0, 0.16 - Math.abs(sun - 0.1) * 0.6);
    if (dusk > 0) {
      ctx.fillStyle = `rgba(255,140,60,${dusk})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    if (dark <= 0) return;
    // Draw darkness on its own layer and carve out light sources.
    const layer = this.lightLayer;
    if (layer.width !== canvas.width || layer.height !== canvas.height) {
      layer.width = canvas.width;
      layer.height = canvas.height;
    }
    const lctx = layer.getContext('2d')!;
    lctx.globalCompositeOperation = 'source-over';
    lctx.clearRect(0, 0, layer.width, layer.height);
    lctx.fillStyle = `rgba(16,20,58,${dark})`;
    lctx.fillRect(0, 0, layer.width, layer.height);
    lctx.globalCompositeOperation = 'destination-out';
    const lights: { x: number; y: number; r: number }[] = [];
    for (const a of frame.agents) if (a.light > 0) lights.push({ x: a.x * TILE, y: a.y * TILE - 4, r: (2 + a.light) * TILE });
    for (const o of this.world!.objects) {
      if (o.structure?.light) lights.push({ x: o.x * TILE + 8, y: o.y * TILE + 4, r: (2.5 + o.structure.light) * TILE });
    }
    const flicker = 1 + Math.sin(frame.now / 120) * 0.03;
    for (const l of lights) {
      const [sx, sy] = toScreen(l.x, l.y);
      const r = l.r * this.zoom * flicker;
      const g = lctx.createRadialGradient(sx, sy, 0, sx, sy, r);
      g.addColorStop(0, 'rgba(0,0,0,0.95)');
      g.addColorStop(0.6, 'rgba(0,0,0,0.5)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      lctx.fillStyle = g;
      lctx.fillRect(sx - r, sy - r, r * 2, r * 2);
    }
    ctx.drawImage(layer, 0, 0);
    // Warm light tint
    ctx.globalCompositeOperation = 'lighter';
    for (const l of lights) {
      const [sx, sy] = toScreen(l.x, l.y);
      const r = l.r * this.zoom * 0.7;
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
      g.addColorStop(0, `rgba(255,190,90,${0.18 * dark})`);
      g.addColorStop(1, 'rgba(255,190,90,0)');
      ctx.fillStyle = g;
      ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  private drawOverlays(frame: FrameState, toScreen: (x: number, y: number) => readonly [number, number]) {
    const { ctx, zoom, dpr } = this;
    const showNames = zoom >= 2 * dpr;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const a of frame.agents) {
      if (a.insideId != null || a.stage === 'egg' && a.id !== frame.selectedId) continue;
      const selected = a.id === frame.selectedId;
      const [cx, top] = toScreen(a.x * TILE, a.y * TILE + 4 - CRAB_H);
      let y = top + 2 * zoom;

      if (selected) {
        const bob = Math.sin(frame.now / 200) * 2 * dpr;
        const s = 4 * dpr;
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#1d1a22';
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath();
        ctx.moveTo(cx - s, y - 6 * dpr - s + bob);
        ctx.lineTo(cx + s, y - 6 * dpr - s + bob);
        ctx.lineTo(cx, y - 6 * dpr + bob);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        y -= 10 * dpr;
      }

      if (a.progress != null) {
        const w = 16 * zoom;
        const h = Math.max(3 * dpr, zoom);
        const px = cx - w / 2;
        const py = y - h - 2 * dpr;
        ctx.fillStyle = 'rgba(29,26,34,0.75)';
        ctx.fillRect(px - dpr, py - dpr, w + 2 * dpr, h + 2 * dpr);
        ctx.fillStyle = a.action === 'eat' ? '#ffb347' : '#8fe06a';
        ctx.fillRect(px, py, w * a.progress, h);
        y = py - 3 * dpr;
      }

      if (showNames || selected) {
        ctx.font = `600 ${10 * dpr}px ui-rounded, "SF Pro Rounded", system-ui, sans-serif`;
        const label = a.name;
        const w = ctx.measureText(label).width + 8 * dpr;
        const ny = y - 7 * dpr;
        ctx.fillStyle = selected ? 'rgba(29,26,34,0.85)' : 'rgba(29,26,34,0.55)';
        roundRect(ctx, cx - w / 2, ny - 7 * dpr, w, 14 * dpr, 7 * dpr);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(label, cx, ny + 0.5 * dpr);
        if (a.mood !== 'calm') {
          ctx.font = `${10 * dpr}px system-ui, "Apple Color Emoji", sans-serif`;
          ctx.fillText(EMOTION_META[a.mood].emoji, cx + w / 2 + 7 * dpr, ny + 0.5 * dpr);
        }
        y = ny - 8 * dpr;
      }

      if (a.action === 'sleep') {
        ctx.font = `700 ${10 * dpr}px ui-rounded, system-ui, sans-serif`;
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        for (let i = 0; i < 3; i++) {
          const t = ((frame.now / 1800 + i / 3 + idPhase(a.id) / 1000) % 1);
          ctx.globalAlpha = Math.sin(t * Math.PI);
          ctx.fillText('z', cx + (6 + t * 10) * dpr, y - t * 18 * dpr);
        }
        ctx.globalAlpha = 1;
      } else if (a.bubble) {
        this.drawBubble(a.bubble, cx, y - 2 * dpr);
      }
    }
  }

  private drawBubble(raw: string, cx: number, bottom: number) {
    const { ctx, dpr } = this;
    const speech = [...raw].length > 3; // a real line, not an emoji
    ctx.font = speech
      ? `600 ${11 * dpr}px ui-rounded, "SF Pro Rounded", system-ui, sans-serif`
      : `${13 * dpr}px system-ui, "Apple Color Emoji", sans-serif`;
    const lines = speech ? wrap(ctx, raw, 150 * dpr, 3) : [raw];
    const lineH = 14 * dpr;
    const w = Math.max(22 * dpr, ...lines.map((l) => ctx.measureText(l).width + 12 * dpr));
    const h = speech ? lines.length * lineH + 7 * dpr : 20 * dpr;
    const x = cx - w / 2;
    const y = bottom - h - 4 * dpr;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(29,26,34,0.85)';
    ctx.lineWidth = 1.5 * dpr;
    roundRect(ctx, x, y, w, h, 7 * dpr);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 4 * dpr, y + h - 0.5);
    ctx.lineTo(cx, y + h + 4 * dpr);
    ctx.lineTo(cx + 4 * dpr, y + h - 0.5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#1d1a22';
    if (!speech) ctx.fillText(raw, cx, y + h / 2 + 1 * dpr);
    else lines.forEach((l, i) => ctx.fillText(l, cx, y + 3.5 * dpr + lineH * (i + 0.5) + dpr));
  }
}

/** Wraps text into at most `maxLines` lines; truncates the rest with "…". */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= maxW || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/\s*\S*$/, '')}…`;
  }
  return lines;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

