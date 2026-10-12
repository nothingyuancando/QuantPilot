import { describe, expect, it } from 'vitest';

import {
  ACTIVE_CLI_IDS,
  DEFAULT_ACTIVE_CLI,
  buildActiveModelOptions,
  sanitizeActiveCli,
} from './cliOptions';

describe('product CLI normalization', () => {
  it('uses PI as the only active and default CLI', () => {
    expect(ACTIVE_CLI_IDS).toEqual(['pi']);
    expect(DEFAULT_ACTIVE_CLI).toBe('pi');
  });

  it('keeps PI canonical and falls back to PI for unknown values', () => {
    expect(sanitizeActiveCli('PI')).toBe('pi');
    expect(sanitizeActiveCli('unknown')).toBe('pi');
  });

  it('uses provider-discovered model definitions in the picker', () => {
    const options = buildActiveModelOptions({
      pi: {
        available: true,
        configured: true,
        models: ['deepseek-flash', 'deepseek-v4-pro'],
        modelDefinitions: [
          { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', supportsImages: true },
          { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', supportsImages: false },
        ],
      },
    });

    expect(options).toEqual([
      expect.objectContaining({ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', available: true, supportsImages: true }),
      expect.objectContaining({ id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', available: true, supportsImages: false }),
    ]);
  });
});
