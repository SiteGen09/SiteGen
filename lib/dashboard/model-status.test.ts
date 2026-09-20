import { describe, expect, it } from 'vitest';
import { classifyModelHealth } from './model-status';

describe('classifyModelHealth', () => {
  it('reports operational below the degraded threshold', () => {
    expect(classifyModelHealth('active', 100, 9)).toEqual({ health: 'operational', errorRate: 0.09 });
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
