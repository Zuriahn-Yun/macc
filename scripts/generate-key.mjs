#!/usr/bin/env node
/**
 * Issue a MACC Pro license key for a customer.
 *
 * Usage:
 *   node scripts/generate-key.mjs <customer-id>
 *
 * customer-id: any 1-8 char alphanumeric string — use your order ID, a random
 * slug, or the customer's email initials. It's embedded in the key so you can
 * trace a key back to an order if needed.
 *
 * Example:
 *   node scripts/generate-key.mjs ORD00042
 *   → MACC-PRO-ORD00042-A3F9C12B8E4D7A6F2C8B
 *
 * Run this on your local machine (never commit the output).
 * Send the key to the customer; they add it to ~/.macc/config.json.
 */

import crypto from 'node:crypto';

const LICENSE_SECRET = 'macc-pro-license-secret-v1';

function generateLicenseKey(id) {
  const normalId = id.toUpperCase().padEnd(8, '0').slice(0, 8);
  const hmac = crypto
    .createHmac('sha256', LICENSE_SECRET)
    .update(normalId)
    .digest('hex')
    .slice(0, 24)
    .toUpperCase();
  return `MACC-PRO-${normalId}-${hmac}`;
}

const customerId = process.argv[2];
if (!customerId || !/^[A-Za-z0-9]{1,8}$/.test(customerId)) {
  console.error('Usage: node scripts/generate-key.mjs <1-8 alphanumeric chars>');
  console.error('Example: node scripts/generate-key.mjs ORD00001');
  process.exit(1);
}

const key = generateLicenseKey(customerId);
console.log(key);
