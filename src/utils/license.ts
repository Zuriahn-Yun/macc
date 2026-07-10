import crypto from 'node:crypto';
import { loadConfig } from './config.js';

// MACC-PRO-{8-char-id}-{24-char-hmac-hex-prefix}
// The HMAC secret is baked in; real keys are generated server-side with the same secret.
const LICENSE_SECRET = 'macc-pro-license-secret-v1';
const KEY_RE = /^MACC-PRO-([A-Z0-9]{8})-([A-F0-9]{24})$/;

export function validateLicense(key: string): boolean {
  const match = key.trim().toUpperCase().match(KEY_RE);
  if (!match) return false;
  const [, id, givenHmac] = match;
  const expected = crypto
    .createHmac('sha256', LICENSE_SECRET)
    .update(id)
    .digest('hex')
    .slice(0, 24)
    .toUpperCase();
  return crypto.timingSafeEqual(Buffer.from(givenHmac), Buffer.from(expected));
}

/** Returns a valid Pro license key for a given 8-char ID (key generation tool). */
export function generateLicenseKey(id: string): string {
  const normalId = id.toUpperCase().padEnd(8, '0').slice(0, 8);
  const hmac = crypto
    .createHmac('sha256', LICENSE_SECRET)
    .update(normalId)
    .digest('hex')
    .slice(0, 24)
    .toUpperCase();
  return `MACC-PRO-${normalId}-${hmac}`;
}

let _cachedPro: boolean | null = null;

/** Returns true if the user's config has a valid Pro license key. */
export async function isPro(): Promise<boolean> {
  if (_cachedPro !== null) return _cachedPro;
  try {
    const config = await loadConfig();
    _cachedPro = config.licenseKey ? validateLicense(config.licenseKey) : false;
  } catch {
    _cachedPro = false;
  }
  return _cachedPro;
}

/** Reset the cached Pro status (used in tests). */
export function resetProCache(): void {
  _cachedPro = null;
}
