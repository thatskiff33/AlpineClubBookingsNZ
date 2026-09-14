/**
 * Hosts an ADMIN-SUPPLIED destination may never name.
 *
 * WHY THIS IS ITS OWN MODULE (#2940). It was `isBlockedSyncHost`, private to
 * `servernz-settings.ts`, because the Alpine Central Server base URL was the
 * first admin-typed string in this codebase that decided where something of
 * ours gets sent. It is no longer the only one: moving the club-editable
 * MiroTalk configuration into Admin -> Integrations makes the meeting-server
 * base URL a second such field, and a signed join token — carrying the host
 * credentials encrypted under the club's own JWT key — is minted straight at
 * whatever it names. Two fields with the same hazard must not have two copies
 * of the rule that bounds it, so the rule moved here and both import it
 * (`INV-SSOT`).
 *
 * Literal-form only, deliberately. A DNS name that RESOLVES to a private
 * address is not caught here and cannot be without resolving at request time
 * and pinning the answer (a TOCTOU fix of its own). What this does close is the
 * direct, typed-in case — cloud metadata at 169.254.169.254, `localhost`, and
 * RFC1918 space — which is the shape an admin-supplied field actually takes.
 *
 * `docs/SECURITY-ATTACK-SURFACE.md` argues `/api/deploy/warmup` is safe
 * precisely BECAUSE no request input reaches it; a field an administrator types
 * cannot make that argument and needs a real rule instead.
 */

/**
 * A `URL.hostname` reduced to the form every rule below may be written against:
 * lower-cased, unbracketed, and with the DNS ROOT LABEL removed.
 *
 * THE TRAILING ROOT LABEL IS WHY THIS EXISTS. `localhost.` and
 * `metadata.google.internal.` are the SAME hosts as `localhost` and
 * `metadata.google.internal` — a trailing dot is the DNS root label, which
 * resolvers accept and which the URL parser preserves verbatim. The IP rules
 * never needed this (the parser normalises `127.0.0.1.` down to `127.0.0.1`
 * before it reaches us) and that is exactly what made the gap easy to miss: the
 * literal forms looked covered, so the NAME forms looked covered too. They were
 * not, and one keystroke defeated every one of them. More than one trailing dot
 * parses as well (`localhost..`), so this strips ALL of them rather than one.
 *
 * Exported because a caller that asks a SECOND question about a hostname — "is
 * this a single label?" — has to ask it of the same string this one judges, or
 * `meet.` sails through a "needs a domain" test on the strength of a dot that
 * is not part of the name.
 */
export function normaliseDestinationHost(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
}

/**
 * True when `hostname` is a loopback, private, link-local, CGNAT, multicast or
 * otherwise non-public literal — or is empty, which fails CLOSED.
 *
 * Takes a `URL.hostname`, so an IPv6 literal may still arrive bracketed. A host
 * of nothing but dots normalises to empty and fails CLOSED on the first line.
 */
export function isBlockedDestinationHost(hostname: string): boolean {
  const host = normaliseDestinationHost(hostname);
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // `.local` (mDNS) and `.internal` (common private zone, incl. GCP metadata).
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  // IPv6 loopback / unspecified, and IPv4-mapped forms of the same.
  if (host === "::1" || host === "::" || host.startsWith("::ffff:")) return true;
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    // Fail CLOSED, not open: the 4-group match guarantees both octets are
    // present, but this function gates where an admin-typed destination may
    // point, so an unreachable gap here must read as "blocked", never as
    // "not blocked".
    if (a === undefined || b === undefined) return true;
    if ([a, b].some((n) => Number.isNaN(n) || n > 255)) return true;
    if (a === 127 || a === 0 || a === 10) return true; // loopback, "this host", RFC1918
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC6598)
    if (a >= 224) return true; // multicast and reserved
  }
  return false;
}
