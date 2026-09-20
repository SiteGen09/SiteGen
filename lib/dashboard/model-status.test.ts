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
  it('makes an unused successfully probed model operational', () => {
    expect(classifyObservedHealth('active', 0, 0, 1, 0).health).toBe('operational');
  });
  it('makes a failed probe without traffic an outage', () => {
    expect(classifyObservedHealth('active', 0, 0, 1, 1).health).toBe('outage');
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
