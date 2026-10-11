// Sends secret admin commands to the running simulation (the inhabitants and the event log never find out).
// Usage:
//   npx tsx scripts/admin.ts rain             → rain: bushes and trees refill instantly
//   npx tsx scripts/admin.ts scarcity 3       → resources regrow 3× slower (1 = normal)
//   npx tsx scripts/admin.ts wither 0.7       → 70% of the berries on bushes wither
//   npx tsx scripts/admin.ts pause | resume   → pause / resume the simulation
import WebSocket from 'ws';

const [op, arg] = process.argv.slice(2);
const msg =
  op === 'pause' ? { type: 'setSpeed', speed: 0 }
  : op === 'resume' ? { type: 'setSpeed', speed: 1 }
  : op === 'scarcity' ? { type: 'admin', op, value: Number(arg ?? 1) }
  : op === 'wither' ? { type: 'admin', op, fraction: Number(arg ?? 0) }
  : op === 'rain' ? { type: 'admin', op }
  : null;
if (!msg) {
  console.log('Commands: rain | scarcity <x> | wither <0..1> | pause | resume');
  process.exit(1);
}
const ws = new WebSocket(`ws://127.0.0.1:${process.env.SIM_PORT ?? 8787}/ws`);
ws.on('open', () => {
  ws.send(JSON.stringify(msg));
  console.log(`Sent: ${JSON.stringify(msg)}`);
  setTimeout(() => ws.close(), 300);
});
ws.on('error', (e) => console.error(`Could not connect (is the server running?): ${e.message}`));
