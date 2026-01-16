import os from 'os';

/**
 * Sample-based CPU usage tracking
 * Measures CPU load over a sampling interval (not cumulative since boot)
 */
let lastCPUSample: { idle: number; total: number; timestamp: number } | null = null;

function getCPUTimes() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;

  for (const cpu of cpus) {
    for (const type in cpu.times) {
      total += cpu.times[type as keyof typeof cpu.times];
    }
    idle += cpu.times.idle;
  }

  return { idle, total };
}

export function getCPUUsage(): number {
  const now = Date.now();
  const current = getCPUTimes();

  // First call or stale sample (> 5 seconds old) - return load average fallback
  if (!lastCPUSample || now - lastCPUSample.timestamp > 5000) {
    lastCPUSample = { ...current, timestamp: now };

    // Use system load average as fallback (1-minute average)
    const cpuCount = os.cpus().length;
    const loadAvg = os.loadavg()[0];
    return Math.min(loadAvg / cpuCount, 1.0);
  }

  // Calculate usage since last sample
  const idleDiff = current.idle - lastCPUSample.idle;
  const totalDiff = current.total - lastCPUSample.total;

  // Update sample for next call
  lastCPUSample = { ...current, timestamp: now };

  if (totalDiff === 0) return 0;

  return 1 - idleDiff / totalDiff;
}

export function getMemoryUsage(): { usedMB: number; percentUsed: number } {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  return {
    usedMB: Math.round(usedMem / 1024 / 1024),
    percentUsed: usedMem / totalMem,
  };
}
