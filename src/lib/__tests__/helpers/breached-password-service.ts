import { createHash } from "node:crypto";
import { vi } from "vitest";
import {
  BREACHED_PASSWORD_PREFIX_LENGTH,
  BREACHED_PASSWORD_RANGE_URL,
} from "@/lib/breached-password";

// A stand-in for the public breached-password range service (#4610). Tests
// never reach the real one: every suite that drives a password writer stubs
// `fetch` with this, and it throws on any other URL so a stray outbound call
// fails loudly instead of leaving the test machine.

export function sha1Upper(password: string): string {
  return createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
}

/**
 * The range body the service would return for `prefix`: one `SUFFIX:COUNT`
 * line per listed password sharing the prefix, plus zero-count padding lines,
 * CRLF-separated as the service sends them.
 */
export function rangeBody(prefix: string, breached: readonly string[]): string {
  const lines = breached
    .map(sha1Upper)
    .filter((hash) => hash.startsWith(prefix))
    .map((hash) => `${hash.slice(BREACHED_PASSWORD_PREFIX_LENGTH)}:4821`);
  lines.push(`${"0".repeat(40 - BREACHED_PASSWORD_PREFIX_LENGTH)}:0`);
  lines.push(`${"F".repeat(40 - BREACHED_PASSWORD_PREFIX_LENGTH)}:0`);
  return lines.join("\r\n");
}

/** Stub `fetch` with a range service that lists exactly `breached`. */
export function stubBreachedPasswordService(breached: readonly string[] = []) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(BREACHED_PASSWORD_RANGE_URL)) {
      throw new Error(`Unexpected outbound fetch in a test: ${url}`);
    }
    const prefix = url.slice(BREACHED_PASSWORD_RANGE_URL.length);
    return new Response(rangeBody(prefix, breached), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
