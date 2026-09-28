import { describe, expect, it } from 'vitest';
import { createStore } from '../src/lib/store';

describe('createStore', () => {
  it('notifies subscribers on set and stops after unsubscribe', () => {
    const s = createStore(1);
    let calls = 0;
    const off = s.subscribe(() => { calls += 1; });
    s.set(2);
    expect(s.get()).toBe(2);
    expect(calls).toBe(1);
    off();
    s.set(3);
    expect(calls).toBe(1);
  });

  it('does not notify when the value is identical', () => {
    const s = createStore('a');
    let calls = 0;
    s.subscribe(() => { calls += 1; });
    s.set('a');
    expect(calls).toBe(0);
  });
});
