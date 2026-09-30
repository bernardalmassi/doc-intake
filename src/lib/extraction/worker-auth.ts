// The worker route's bearer check. pg_net sends
// "Authorization: Bearer <extraction_worker_secret>" from the app project's
// Vault (private.wake_extraction_worker, 20260925000002), and the route
// compares it with the same secret, which extraction/worker.ts alone reads
// from the environment and passes in. Pure, so tests/unit/worker-auth.test.ts
// can drive it without the secret or a server.
//
// Refused: no header, any scheme but Bearer, a value of another length or
// content, and a configured secret that is unset or shorter than
// MIN_WORKER_SECRET_LENGTH (a short one would be guessable, and an unset one
// must not match an empty bearer). The values are compared in constant time.

import { timingSafeEqual } from "node:crypto";

export const MIN_WORKER_SECRET_LENGTH = 32;

export function isAuthorizedWorkerCall(header: string | null | undefined, configured: string | undefined): boolean {
  if (typeof configured !== "string" || configured.length < MIN_WORKER_SECRET_LENGTH) return false;
  if (typeof header !== "string") return false;
  // the scheme is case-insensitive (RFC 9110); exactly one space after it
  const match = /^bearer ([^\s]+)$/i.exec(header);
  if (!match) return false;
  const given = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(configured, "utf8");
  if (given.length !== expected.length) {
    // the same work as a comparison, so a wrong length takes no less time
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(given, expected);
}
