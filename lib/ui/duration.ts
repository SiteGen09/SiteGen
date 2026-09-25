/**
 * A latency as people read it: `850 ms`, `41.1 s`, `3 m 47 s`, `1 h 5 m`.
 * Milliseconds only below one second, where they are the useful unit.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (Math.round(ms) < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) {
    const seconds = Math.round(ms / 100) / 10;
    // 59.96 s would round to "60.0 s"; that belongs in minutes.
    if (seconds < 60) return `${seconds.toFixed(1)} s`;
  }
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${minutes} m` : `${minutes} m ${seconds} s`;
  }
  const totalMinutes = Math.round(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} m`;
}
