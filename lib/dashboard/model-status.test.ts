import { describe, expect, it } from 'vitest';
import { classifyModelHealth, classifyObservedHealth, availabilityOf } from './model-status';

describe('classifyModelHealth', () => {
  it('reports operational below the degraded threshold', () => {
    expect(classifyModelHealth('active', 100, 9)).toEqual({
      health: 'operational',
      errorRate: 0.09,
    });
  });

  it('degrades at 10% failures and calls an outage at 50%', () => {
    expect(classifyModelHealth('active', 100, 10).health).toBe('degraded');
    expect(classifyModelHealth('active', 100, 49).health).toBe('degraded');
    expect(classifyModelHealth('active', 100, 50).health).toBe('outage');
  });

  it('honours an operator-flagged channel even when traffic looks clean', () => {
    expect(classifyModelHealth('degraded', 100, 0).health).toBe('degraded');
  });

  // A single failure out of two is 50% — an outage by rate alone. The minimum
  // sample exists so a quiet model cannot be declared down on that evidence.
  it('withholds a verdict below the minimum sample', () => {
    expect(classifyModelHealth('active', 2, 1)).toEqual({ health: 'idle', errorRate: null });
    expect(classifyModelHealth('active', 0, 0).health).toBe('idle');
  });

  it('still surfaces an operator flag on an idle model', () => {
    expect(classifyModelHealth('degraded', 0, 0).health).toBe('degraded');
  });
});

describe('synthetic evidence', () => {
  // Keep the reported regressions together: real successes must not turn into
  // an outage because the scheduled probe had a single transient failure.
  it.each([
    {
      name: '1 good probe, no traffic',
      requests: 0,
      failed: 0,
      probes: 1,
      probeFailures: 0,
      health: 'operational',
    },
    {
      name: '1 failed probe, no traffic',
      requests: 0,
      failed: 0,
      probes: 1,
      probeFailures: 1,
      health: 'outage',
    },
    {
      name: '5 real requests all OK + 1 failed probe',
      requests: 5,
      failed: 0,
      probes: 1,
      probeFailures: 1,
      health: 'operational',
    },
    {
      name: '20 real requests, 2 failed, no probe',
      requests: 20,
      failed: 2,
      probes: 0,
      probeFailures: 0,
      health: 'degraded',
    },
    {
      name: '20 real requests all OK + 1 failed probe',
      requests: 20,
      failed: 0,
      probes: 1,
      probeFailures: 1,
      health: 'operational',
    },
    {
      name: 'all probes failed, no traffic',
      requests: 0,
      failed: 0,
      probes: 3,
      probeFailures: 3,
      health: 'outage',
    },
    {
      name: 'all probes and real requests failed',
      requests: 2,
      failed: 2,
      probes: 2,
      probeFailures: 2,
      health: 'outage',
    },
    {
      name: 'mixed successful traffic + 1 failed probe',
      requests: 5,
      failed: 1,
      probes: 1,
      probeFailures: 1,
      health: 'degraded',
    },
    {
      name: 'successful and failed probes without traffic',
      requests: 0,
      failed: 0,
      probes: 2,
      probeFailures: 1,
      health: 'operational',
    },
  ])('$name → $health', ({ requests, failed, probes, probeFailures, health }) => {
    expect(classifyObservedHealth('active', requests, failed, probes, probeFailures).health).toBe(
      health,
    );
  });
  it('does not invent evidence for missing buckets', () => {
    expect(classifyObservedHealth('active', 0, 0, 0, 0).health).toBe('idle');
    expect(classifyObservedHealth('degraded', 0, 0, 0, 0).health).toBe('idle');
    expect(availabilityOf([{ health: 'idle' }])).toBeNull();
  });
  it('combines real failures with probes through the shared classifier', () => {
    expect(classifyObservedHealth('active', 10, 5, 1, 0)).toEqual(
      classifyModelHealth('active', 20, 5),
    );
    expect(
      availabilityOf([{ health: 'idle' }, { health: 'operational' }, { health: 'outage' }]),
    ).toBe(50);
  });
});
