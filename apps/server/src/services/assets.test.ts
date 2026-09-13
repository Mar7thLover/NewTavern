import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { createAssetsService } from './assets.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-assets-'));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

// 最小合法 PNG（1x1，IHDR 宽高在 16..24 字节）
const PNG_2X3 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03, 0x08, 0x02, 0x00, 0x00, 0x00, 0x12, 0xf1, 0x59,
  0x3a,
]);

describe('assets service', () => {
  it('保存资产并按 sha256 去重', () => {
    const db = createDatabase(':memory:');
    runMigrations(db);
    const assets = createAssetsService(db, tmpDir);

    const a1 = assets.save({ bytes: PNG_2X3, kind: 'upload', mime: 'image/png', source: 'test' });
    const a2 = assets.save({ bytes: PNG_2X3, kind: 'upload', mime: 'image/png', source: 'test' });
    expect(a2.id).toBe(a1.id);

    expect(a1.width).toBe(2);
    expect(a1.height).toBe(3);
    expect(fs.existsSync(assets.resolvePath(a1))).toBe(true);
    expect(fs.readFileSync(assets.resolvePath(a1))).toEqual(Buffer.from(PNG_2X3));

    const fetched = assets.getById(a1.id);
    expect(fetched?.sha256).toBe(a1.sha256);
  });
});
