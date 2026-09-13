import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 本地主密钥与 API Key 加密。见 docs/M2-CONTRACT.md §3.1。
 * 主密钥文件 `data/<user>/master.key`（32 字节 hex，不存在则生成，权限 0600）。
 * 密文格式 `v1:<iv hex>:<tag hex>:<cipher hex>`，AES-256-GCM。
 */

const VERSION = 'v1';
const IV_BYTES = 12;

export interface Secrets {
  /** 明文对象 → 密文字符串 */
  encryptJson(value: unknown): string;
  /** 密文字符串 → 明文对象；空串返回 null */
  decryptJson(text: string): unknown;
}

/** 只取末 4 位，供 UI 区分多个 Key；对外永不返回明文 */
export function keyHint(key: string): string {
  return key.length <= 4 ? key : key.slice(-4);
}

export function createSecrets(dataDir: string): Secrets {
  const keyPath = path.join(dataDir, 'master.key');
  let master: Buffer | null = null;

  const loadKey = (): Buffer => {
    if (master) return master;
    if (fs.existsSync(keyPath)) {
      const hex = fs.readFileSync(keyPath, 'utf8').trim();
      if (/^[0-9a-fA-F]{64}$/.test(hex)) {
        master = Buffer.from(hex, 'hex');
        return master;
      }
    }
    const generated = randomBytes(32);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(keyPath, generated.toString('hex'), { encoding: 'utf8', mode: 0o600 });
    master = generated;
    return master;
  };

  return {
    encryptJson(value) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', loadKey(), iv);
      const plain = Buffer.from(JSON.stringify(value ?? null), 'utf8');
      const body = Buffer.concat([cipher.update(plain), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, iv.toString('hex'), tag.toString('hex'), body.toString('hex')].join(':');
    },
    decryptJson(text) {
      if (!text) return null;
      const [version, ivHex, tagHex, bodyHex] = text.split(':');
      if (version !== VERSION || !ivHex || !tagHex || bodyHex === undefined) {
        throw new Error('密文格式非法');
      }
      const decipher = createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      const plain = Buffer.concat([decipher.update(Buffer.from(bodyHex, 'hex')), decipher.final()]);
      return JSON.parse(plain.toString('utf8')) as unknown;
    },
  };
}
