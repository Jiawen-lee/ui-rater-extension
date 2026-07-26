import { createHash } from 'node:crypto';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function assertString(value: unknown, name: string, maxLength = 500): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`${name} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

export function assertId(value: unknown, name: string): string {
  const id = assertString(value, name, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error(`${name} has invalid characters`);
  return id;
}

/** Header-safe idempotency keys may contain separators such as ':' and '/'. */
export function assertIdempotencyKey(value: unknown, name = 'Idempotency-Key'): string {
  const key = assertString(value, name, 255);
  if (!/^[\x21-\x7E]+$/.test(key)) throw new Error(`${name} contains invalid header characters`);
  return key;
}

export function assertPositiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${name} must be a positive integer`);
  return value as number;
}

export function assertHttpUrl(value: unknown, name: string): string {
  const raw = assertString(value, name, 2_000);
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error(`${name} must be an absolute URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${name} must use http or https`);
  return parsed.href;
}

function canonicalValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON cannot contain non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(source).sort()) {
      // JSON.stringify omits undefined object properties; mirror that rule so
      // normalized descriptors can safely include optional fields.
      if (source[key] === undefined) continue;
      result[key] = canonicalValue(source[key]);
    }
    return result;
  }
  throw new Error('Canonical JSON cannot contain undefined or functions');
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function requestDigest(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

export function optionalString(value: unknown, name: string, maxLength = 500): string | undefined {
  if (value === undefined || value === null) return undefined;
  return assertString(value, name, maxLength);
}
