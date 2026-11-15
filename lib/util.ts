// Shared helpers for the forge: deterministic clock, ids, hashing.
// The trial is deterministic: no wall clock or unseeded randomness in any
// request path. Dates come only from MAKEFUN_TRIAL_NOW (an ISO string the
// env sets per trial); without it we fall back to the scenario epoch.
import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';
/** The scenario viewer: wire.ts buildScenario() users[0] under the fixed
 *  SCENARIO_SEED 0x6a09e667f3bcc909n. Same in practice and in the final. */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';
/** wire.ts SCENARIO_EPOCH_SEC: 2025-01-01T00:00:00Z. */
export const SCENARIO_EPOCH_SEC = 1735689600;

export function epochNow(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum > 0) return Math.floor(asNum);
  return SCENARIO_EPOCH_SEC;
}

export function isoNow(): string {
  return new Date(epochNow() * 1000).toISOString();
}

export function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function unb64url(text: string): string {
  return Buffer.from(text, 'base64url').toString('utf8');
}

export function isHex40(s: string): boolean {
  return /^[0-9a-f]{40}$/i.test(s);
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** A git ident line for commits the forge itself authors. */
export function gitIdent(): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epochNow()} +0000`;
}
