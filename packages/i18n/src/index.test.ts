import { describe, expect, it } from 'vitest';

import { DEFAULT_LANGUAGE, resources, SUPPORTED_LANGUAGES } from './index.js';

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object') {
      return flattenKeys(value as Record<string, unknown>, path);
    }
    return [path];
  });
}

describe('i18n 词典', () => {
  it('所有语言的 key 集合一致', () => {
    const reference = flattenKeys(resources[DEFAULT_LANGUAGE].translation).sort();
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(flattenKeys(resources[lang].translation).sort()).toEqual(reference);
    }
  });
});
