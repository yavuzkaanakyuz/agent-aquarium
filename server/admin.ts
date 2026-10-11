import type { ClientMessage } from '../shared/protocol';
import type { Simulation } from './sim';

export type AdminMessage = Extract<ClientMessage, { type: 'admin' }>;

/** Secret "central bank" / nature controls. Nothing is written to the event log; the inhabitants never find out. */
export function applyAdmin(sim: Simulation, msg: AdminMessage) {
  const clamp = (v: unknown, min: number, max: number) => Math.min(max, Math.max(min, Number(v) || 0));
  switch (msg.op) {
    case 'scarcity':
      if (Number.isFinite(msg.value)) sim.world.setScarcity(msg.value, 0);
      break;
    case 'wither':
      sim.world.setScarcity(sim.world.scarcity, clamp(msg.fraction, 0, 1));
      break;
    case 'rain':
      sim.world.rain();
      break;
    case 'airdrop':
      sim.airdrop(Math.round(clamp(msg.berries, 0, 50)), msg.target ?? null);
      break;
    case 'tax':
      sim.tax(clamp(msg.fraction, 0, 1));
      break;
    case 'spoilage':
      sim.economy.spoilage = clamp(msg.rate, 0, 1);
      break;
    case 'fee':
      sim.market.feeRate = clamp(msg.rate, 0, 0.5);
      break;
    case 'immigrants':
      sim.immigrants(Math.round(clamp(msg.count || 3, 1, 4)), msg.temperament ?? 'aggressive', Boolean(msg.armed));
      break;
  }
}
