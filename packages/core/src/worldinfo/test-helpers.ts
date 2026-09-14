/** 世界书引擎测试的构造助手：只在测试里使用。 */

import { scanWorldInfo } from './engine.js';
import {
  type WIBook,
  type WIEntry,
  type WIScanInput,
  type WIScanMessage,
  type WIScanResult,
  type WIScope,
  type WISettings,
} from './types.js';

export function makeEntry(partial: Partial<WIEntry> & { id: string }): WIEntry {
  return {
    bookId: 'book-1',
    keys: [],
    secondaryKeys: [],
    content: `content of ${partial.id}`,
    constant: false,
    selective: true,
    selectiveLogic: 0,
    position: 0,
    order: 100,
    disabled: false,
    ...partial,
  };
}

export function makeBook(entries: WIEntry[], scope: WIScope = 'global', id = 'book-1'): WIBook {
  return { id, name: `${id}-name`, scope, entries };
}

export function makeSettings(partial: Partial<WISettings> = {}): WISettings {
  return {
    scanDepth: 2,
    budgetTokens: 1_000_000,
    budgetCap: 0,
    recursive: false,
    caseSensitive: false,
    matchWholeWords: false,
    useGroupScoring: false,
    maxRecursionSteps: 0,
    minActivations: 0,
    minActivationsDepthMax: 0,
    includeNames: false,
    ...partial,
  };
}

export function userMessage(text: string, name?: string): WIScanMessage {
  return { role: 'user', text, ...(name === undefined ? {} : { name }) };
}

export type ScanOverrides = Partial<WIScanInput> & { books: WIBook[] };

/** 默认：无历史、恒定随机 0.5、token = 字符数、宏替换为恒等 */
export function runScan(overrides: ScanOverrides): WIScanResult {
  const history = overrides.history ?? [];
  return scanWorldInfo({
    settings: makeSettings(),
    globalScan: {},
    state: null,
    substitute: (text) => text,
    random: () => 0.5,
    countTokens: (text) => text.length,
    ...overrides,
    history,
    messageCount: overrides.messageCount ?? history.length,
  });
}

export const activatedIds = (result: WIScanResult): string[] =>
  result.activations.map((item) => item.entry.id);

export const rejectionOf = (result: WIScanResult, entryId: string): string[] =>
  result.rejected.filter((item) => item.entryId === entryId).map((item) => item.reason);
