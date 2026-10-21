/**
 * 认证：PBKDF2-SHA256（WebCrypto，Workers 原生支持）。
 *
 * 为什么不是 argon2：Workers 运行时没有原生 argon2，纯 JS 实现既慢又容易被打爆 CPU 限额。
 * PBKDF2-SHA256 + 10 万轮 + 16 字节随机盐，对「单人自用 + 登录限流」的场景强度足够。
 */

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

export function randomToken(): string {
  // 32 字节 → base64url，无填充
  return toBase64(randomBytes(32))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function hashPassword(
  password: string,
  saltB64?: string,
): Promise<{ hash: string; salt: string; iterations: number }> {
  const salt = saltB64 ? fromBase64(saltB64) : randomBytes(SALT_BYTES);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    KEY_BITS,
  );
  return {
    hash: toBase64(new Uint8Array(bits)),
    salt: toBase64(salt),
    iterations: PBKDF2_ITERATIONS,
  };
}

/** 恒定时间比较，避免时序侧信道。 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

export async function verifyPassword(
  password: string,
  expectedHashB64: string,
  saltB64: string,
  iterations: number,
): Promise<boolean> {
  const salt = fromBase64(saltB64);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    KEY_BITS,
  );
  return timingSafeEqual(new Uint8Array(bits), fromBase64(expectedHashB64));
}

/** 会话 token 入库前先哈希，数据库泄露也无法直接冒用。 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
