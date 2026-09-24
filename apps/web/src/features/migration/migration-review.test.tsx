import { resources } from '@newtavern/i18n';
import i18n from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { initReactI18next } from 'react-i18next';
import { beforeAll, describe, expect, it } from 'vitest';

import { MigrationReview } from './MigrationReview';
import type { StInventory } from '../../lib/api-migration';

/** 迁移清单（M4 §2.4 + M4（二）§A.5 / §B.1 + M5（三）§2.1）：立绘、预设脚本、背景与全局默认背景都报出来 */

const INVENTORY: StInventory = {
  root: 'D:/SillyTavern/data/default-user',
  characters: [
    { file: 'default_Seraphina.png', name: 'Seraphina', exists: false, chatCount: 1, sprites: 28 },
    { file: 'b.png', name: '乙', exists: true, chatCount: 0 },
  ],
  chats: [],
  groupChats: 0,
  presets: [
    { file: 'ARGO_1.2.json', name: 'ARGO_1.2', exists: false, scripts: 1, scriptsEnabled: true },
    { file: 'TG.json', name: 'TG', exists: false, scripts: 2, scriptsEnabled: false },
    { file: 'Default.json', name: 'Default', exists: false },
  ],
  lorebooks: [],
  regex: { count: 0, newCount: 0 },
  scripts: { count: 0, newCount: 0, globalEnabled: true },
  personas: [],
  defaultPersona: null,
  worldInfo: { globalBooks: [], hasSettings: false },
  backgrounds: { count: 23, newCount: 23, current: 'japan classroom side.jpg' },
  skipped: { instruct: 0, context: 0, themes: 0, quickReplies: 0 },
};

describe('MigrationReview', () => {
  let html = '';
  beforeAll(async () => {
    await i18n.use(initReactI18next).init({
      resources,
      lng: 'zh-CN',
      interpolation: { escapeValue: false },
    });
    html = renderToStaticMarkup(
      <MigrationReview inventory={INVENTORY} onBack={() => undefined} onStart={() => undefined} />,
    );
  });

  it('角色带立绘张数，预设带自带脚本数（开着的另外说明）', () => {
    expect(html).toMatch(/default_Seraphina\.png · [^<]*立绘 28 张/);
    expect(html).toContain('自带 1 个脚本（酒馆助手里开着');
    expect(html).toContain('自带 2 个脚本（导入后先关着）');
  });

  it('背景一行 + 「设为全局默认」一行（默认不勾）', () => {
    expect(html).toContain('japan classroom side');
    const row = html
      .split('data-part="migration-item"')
      .find((part) => part.includes('japan classroom side'));
    expect(row).toBeDefined();
    expect(row).not.toMatch(/<input[^>]*checked=""/);
  });

  it('开始键上的计数：新角色 1 + 新预设 3 + 背景 23', () => {
    expect(html).toContain('开始迁移 27 项');
  });
});
