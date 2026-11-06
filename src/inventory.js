import { PortalError } from './client.js';
import { rows, meter } from './parser.js';

// Cache only a complete, normalized export. Failed refreshes remain retryable.
export function createInventory(client, { ttlMs = 60000, now = Date.now } = {}) {
  let cached, expires = 0, pending;
  return async function inventory() {
    if (cached && now() < expires) return cached;
    if (pending) return pending;
    pending = (async () => {
      const payload = await client.metadata();
      const data = rows(payload);
      if (!Number.isSafeInteger(payload.total) || payload.total < 0 || payload.total !== data.length) {
        throw new PortalError('INCOMPLETE_EXPORT', 'Portal export count mismatch.');
      }
      const normalized = data.map(meter);
      if (new Set(normalized.map(m => m.id)).size !== normalized.length) {
        throw new PortalError('INVALID_DATA', 'Portal export contains duplicate meter IDs.');
      }
      cached = normalized;
      expires = now() + ttlMs;
      return cached;
    })();
    try { return await pending; }
    finally { pending = undefined; }
  };
}
