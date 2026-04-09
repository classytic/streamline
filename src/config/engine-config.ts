import os from 'node:os';

interface CpuSample {
  processMicros: number;
  wallMs: number;
}

let lastSample: CpuSample | null = null;
const STALE_SAMPLE_MS = 5000;

function getLoadAverageFallback(): number {
  const cpuCount = Math.max(os.cpus().length, 1);
  const load = os.loadavg()[0] ?? 0;
  return Math.min(Math.max(load / cpuCount, 0), 1);
}

export function getCPUUsage(): number {
  const now = Date.now();
  const usage = process.cpuUsage();
  const current: CpuSample = {
    processMicros: usage.user + usage.system,
    wallMs: now,
  };

  if (!lastSample || now - lastSample.wallMs > STALE_SAMPLE_MS) {
    lastSample = current;
    return getLoadAverageFallback();
  }

  const wallDeltaMicros = (current.wallMs - lastSample.wallMs) * 1000;
  const cpuDeltaMicros = current.processMicros - lastSample.processMicros;
  lastSample = current;

  if (wallDeltaMicros <= 0) {
    return getLoadAverageFallback();
  }

  return Math.min(Math.max(cpuDeltaMicros / wallDeltaMicros, 0), 1);
}
