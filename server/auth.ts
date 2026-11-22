import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
const parameters = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
function derive(password: string, salt: string) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, parameters, (error, hash) => {
      if (error) reject(error);
      else resolve(hash);
    });
  });
}

// An unknown account still incurs a password derivation.
const placeholder = '0'.repeat(32) + ':' + '0'.repeat(128);

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt);
  return salt + ':' + hash.toString('hex');
}

export async function validPassword(password: string, stored = placeholder) {
  const [salt, hash] = stored.split(':');
  const candidate = await derive(password, salt);
  return timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

export function sessionToken() {
  return randomBytes(32).toString('base64url');
}

export function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
