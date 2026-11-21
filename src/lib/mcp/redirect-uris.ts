/**
 * Where an AI app may be sent back to after a member approves it (ALP-653,
 * `INV-MCP-003`).
 *
 * The app's name is whatever the app typed when it registered, so it proves
 * nothing. The address the approval is delivered to is the only fact about an
 * app the club can check, and the club's approved-app list is a list of those
 * hosts. A redirect address is accepted when it is:
 *
 * - `https` on a host in the club's list, matched exactly (a subdomain is a
 *   different host), or
 * - `http` on this device's loopback address, which is how a desktop app
 *   receives the approval. Only software already running on the member's own
 *   computer can listen there.
 *
 * Asked when an app registers and again when a member approves, against the
 * list as it is at that moment, so removing a host stops new approvals for it.
 */

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export const MCP_REDIRECT_URI_MAX_LENGTH = 2000;

/**
 * An approved-app host as the club typed it, reduced to a bare lower-case
 * hostname, or null when it is not one. A pasted address is accepted and cut
 * down to its host, so "https://Claude.ai/" saves as "claude.ai".
 */
export function normaliseRedirectHost(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  let host = trimmed;
  if (trimmed.includes("://")) {
    try {
      host = new URL(trimmed).hostname;
    } catch {
      return null;
    }
  } else {
    // Cut at the first slash without a regular expression: the old
    // `/\/.*$/` backtracked quadratically on a long run of slashes (CodeQL
    // js/polynomial-redos). A line break never belongs in a hostname, and the
    // old pattern left such input whole (so it was refused below); refuse it
    // here so the result is the same.
    if (/[\n\r\u2028\u2029]/.test(trimmed)) return null;
    const slash = trimmed.indexOf("/");
    host = slash === -1 ? trimmed : trimmed.slice(0, slash);
  }

  return HOSTNAME_PATTERN.test(host) ? host : null;
}

export type McpRedirectUriCheck =
  | { readonly ok: true; readonly host: string; readonly loopback: boolean }
  | { readonly ok: false; readonly reason: string };

export function checkMcpRedirectUri(
  raw: string,
  allowedHosts: readonly string[],
): McpRedirectUriCheck {
  if (raw.length > MCP_REDIRECT_URI_MAX_LENGTH) {
    return { ok: false, reason: "The redirect address is too long." };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "The redirect address is not a valid URL." };
  }

  if (url.username || url.password) {
    return { ok: false, reason: "The redirect address must not carry a username or password." };
  }
  if (url.hash) {
    return { ok: false, reason: "The redirect address must not carry a fragment." };
  }

  const host = url.hostname.toLowerCase();

  if (url.protocol === "http:") {
    return LOOPBACK_HOSTNAMES.has(host)
      ? { ok: true, host, loopback: true }
      : { ok: false, reason: "An http redirect address is only accepted on this device (localhost)." };
  }

  if (url.protocol !== "https:") {
    return { ok: false, reason: "The redirect address must use https." };
  }

  return allowedHosts.some((allowed) => allowed.toLowerCase() === host)
    ? { ok: true, host, loopback: false }
    : { ok: false, reason: `${host} is not on this club's list of approved AI apps.` };
}

/**
 * Whether the address an app asks to be sent back to is one it registered.
 * Exact, except that a loopback address may differ in its port: a desktop app
 * listens on whichever port is free when the member connects (RFC 8252 §7.3).
 */
export function isRegisteredRedirectUri(
  requested: string,
  registered: readonly string[],
): boolean {
  if (registered.includes(requested)) return true;

  let requestedUrl: URL;
  try {
    requestedUrl = new URL(requested);
  } catch {
    return false;
  }
  if (
    requestedUrl.protocol !== "http:" ||
    !LOOPBACK_HOSTNAMES.has(requestedUrl.hostname.toLowerCase())
  ) {
    return false;
  }

  return registered.some((candidate) => {
    try {
      const url = new URL(candidate);
      return (
        url.protocol === "http:" &&
        url.hostname.toLowerCase() === requestedUrl.hostname.toLowerCase() &&
        url.pathname === requestedUrl.pathname &&
        url.search === requestedUrl.search
      );
    } catch {
      return false;
    }
  });
}
