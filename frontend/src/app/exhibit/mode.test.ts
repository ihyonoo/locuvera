import { beforeEach, describe, expect, it } from 'vitest';
import { syncExhibitFlag } from './mode';

describe('syncExhibitFlag', () => {
  beforeEach(() => sessionStorage.clear());

  it('stays off without the switch', () => {
    expect(syncExhibitFlag('')).toBe(false);
  });

  it('turns on with ?exhibit=1 and remembers it after the address changes', () => {
    expect(syncExhibitFlag('?exhibit=1')).toBe(true);
    expect(syncExhibitFlag('?tab=list')).toBe(true);
  });

  it('turns off with ?exhibit=0', () => {
    syncExhibitFlag('?exhibit=1');
    expect(syncExhibitFlag('?exhibit=0')).toBe(false);
    expect(syncExhibitFlag('')).toBe(false);
  });
});
