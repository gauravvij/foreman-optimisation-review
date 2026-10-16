import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAutoConfirm } from '../confirm';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isAutoConfirm', () => {
  it('is false when AUTO_CONFIRM is unset', () => {
    // stubEnv with undefined is how vitest models the unset case; unstub restores it.
    vi.stubEnv('AUTO_CONFIRM', undefined);
    expect(isAutoConfirm()).toBe(false);
  });

  it('is true for the documented truthy values, case-insensitive', () => {
    for (const value of ['true', 'TRUE', 'True', '1', 'yes', 'YES', ' true ', 'Yes']) {
      vi.stubEnv('AUTO_CONFIRM', value);
      expect(isAutoConfirm(), `AUTO_CONFIRM="${value}" should be truthy`).toBe(true);
    }
  });

  it('is false for empty, false-y, or unrelated values', () => {
    for (const value of ['', 'false', '0', 'no', 'off', 'maybe', 'True enough']) {
      vi.stubEnv('AUTO_CONFIRM', value);
      expect(isAutoConfirm(), `AUTO_CONFIRM="${value}" should be falsy`).toBe(false);
    }
  });
});
