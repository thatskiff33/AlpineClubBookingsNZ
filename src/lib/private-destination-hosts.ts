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
 *
 * ## The other IPv4 table in this tree, and why it stays where it is
 *
 * `email-delivery.ts`'s `isPrivateIpv4` lists the same RFC1918, CGNAT,
 * link-local and loopback ranges. It was weighed for merging in #2940's review
 * (T6) and deliberately left alone, for three reasons rather than the usual
 * one. The SETS are not the same: this one additionally refuses `0.0.0.0/8` and
 * multicast, which "cannot be a public mail server" has no opinion about. The
 * FAIL DIRECTIONS are opposite and both are load-bearing — an unrecognised
 * shape is blocked here and is NOT reported as a private capture there, because
 * "I could not tell" must come out as the safe answer in each, and the safe
 * answer differs. And the underlying fact is frozen by IANA allocation, so
 * there is no drift for a shared home to prevent: these ranges have not moved
 * in twenty years and will not. A merged table would have to be reassembled
 * differently by each caller, which buys nothing and buries the asymmetry.
 *
 * What a shared home WOULD be good for is a new range appearing. If one ever
 * does, add it to both and revisit this note.
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
 * True when `hostname` names THIS MACHINE — a loopback literal, the unspecified
 * address, or a `localhost` name.
 *
 * WHY IT LIVES HERE (#2940 review, T2). `mirotalk-config.ts` had its own
 * `isLoopbackHost`, written for a different question — "is the app's own origin
 * local, so meeting links should point at the dev instance?" rather than "may an
 * administrator send us here?" — and the two had already diverged in four ways,
 * every one of them a host {@link isBlockedDestinationHost} treats as loopback
 * and the copy did not: `localhost.` with the DNS root label, `127.0.0.2`
 * anywhere in loopback/8, `0.0.0.0`, and the IPv6 unspecified `::`. The visible
 * symptom was `NEXTAUTH_URL=http://localhost.:3000` deriving the meeting address
 * `https://meet.localhost.` instead of taking the dev fallback. So the rule has
 * one home and both callers read it through {@link normaliseDestinationHost}.
 *
 * IT IS A STRICT SUBSET of {@link isBlockedDestinationHost} — every host this
 * returns true for is also blocked — and that is asserted by a test rather than
 * left as a claim. It is NOT a substitute for it: the blocked rule additionally
 * covers RFC1918, CGNAT, link-local and mDNS space, which is a private
 * destination but is not this machine.
 *
 * AN UNUSABLE HOST reads as local, which is the same direction its sibling
 * fails in: neither function ever answers "this is a public host" about a string
 * it could not make sense of. For the caller that asks this, the local answer is
 * the diagnosable one — a named dev instance rather than `https://meet.`.
 */
export function isLoopbackDestinationHost(hostname: string): boolean {
  const host = normaliseDestinationHost(hostname);
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // IPv6 loopback and unspecified.
  if (host === "::1" || host === "::") return true;

  // An IPv4-mapped literal is judged by its IPv4 half, so `::ffff:127.0.0.1` is
  // local and `::ffff:10.0.0.1` is private-but-elsewhere. The sibling blocks
  // every `::ffff:` form, which keeps the subset property either way.
  const mapped = host.startsWith("::ffff:") ? host.slice("::ffff:".length) : host;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(mapped);
  if (v4) {
    const [a] = v4.slice(1).map(Number);
    // Same fail direction as the sibling: an unreachable gap reads as local.
    if (a === undefined || Number.isNaN(a) || a > 255) return true;
    // 127/8 is loopback; 0/8 is "this host, this network" (RFC 1122).
    if (a === 127 || a === 0) return true;
  }
  return false;
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
