import fs from 'node:fs';

import { afterAll, describe, expect, it } from 'vitest';

import { schema } from './db/client.js';
import { makeTempDataDir, makeTestApp } from './test-helpers.js';

/**
 * 开场白里的卡类宏（docs/M4-CONTRACT.md §9「修正（2026-09-16，MSS）」）：
 * ST 1.18 新宏引擎下 {{persona}} {{description}} 取各字段 baseChatReplace 后的值——
 * 字段里的卡类宏为空，{{user}} {{char}} 照常展开。实录见 packages/core 的 assemble-card-macros.test.ts。
 */

const dataDir = makeTempDataDir();
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('开场白的 {{persona}}', () => {
  it('展开为档案描述的 baseChatReplace 值（描述里的卡类宏为空）', async () => {
    const { app, db } = makeTestApp(dataDir);
    const character = db
      .insert(schema.characters)
      .values({
        name: 'Quill',
        spec: 'v2',
        data: {
          name: 'Quill',
          description: '  DESC[persona={{persona}}|user={{user}}]\n',
          first_mes: 'FIRST[persona={{persona}}|description={{description}}]',
        },
      })
      .returning()
      .get();
    const persona = (await (
      await app.request(
        '/api/personas',
        post({ name: 'Wren', description: 'PDESC[char={{char}}|description={{description}}]' }),
      )
    ).json()) as { id: string };

    const chat = (await (
      await app.request('/api/chats', post({ characterIds: [character.id], personaId: persona.id }))
    ).json()) as { nodes: { parts: { text?: string }[] }[] };
    expect(chat.nodes[0]?.parts[0]?.text).toBe(
      'FIRST[persona=PDESC[char=Quill|description=]|description=DESC[persona=|user=Wren]]',
    );
  });
});
