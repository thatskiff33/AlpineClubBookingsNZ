# ADR-001: Lobby display device pairing and auth model

**Status:** Accepted (2026-07-11)
**Issue:** fork hoppers99/AlpineClubBookingsNZ#27 (LTV-002), epic hoppers99/AlpineClubBookingsNZ#25
**Deciders:** fork owner (delivery authorisation on epic hoppers99/AlpineClubBookingsNZ#25), implementation agent

## Context

The lobby TV display needs a way for a credential-less device (a TV browser or
Raspberry Pi) to authenticate to exactly one lodge's read-only display data,
survive reboots, and be individually revocable — without anyone typing a
password on a TV remote, and without granting the device anything beyond the
display surface. This is a new auth surface, deliberately the
weakest-privileged in the system.

## Decision

### 1. Route namespace: `/display` and `/api/display/*`, NOT `/lodge/display`

The design sketch placed display routes under `/lodge/display`. The proxy's
module gating (`src/config/feature-routes.ts`) requires **every** flag whose
rule matches a path to be enabled, and the `kiosk` flag already gates the
whole `/lodge` + `/api/lodge` prefix space. Under `/lodge/display`, a club
running displays without the kiosk module would 404. The display is an
independent module, so its routes live in their own namespace:

- `/display` — the display page (LTV-007)
- `/api/display/pair`, `/api/display/heartbeat`, `/api/display/state` (LTV-003)
- `/api/admin/display/*` — admin device management (this issue provides
  pairing confirmation; LTV-008 adds CRUD/revoke)

All are gated by a single `lobbyDisplay` rule in `FEATURE_ROUTE_RULES`
(proxy-level 404 when the module is off, per the kiosk precedent).

### 2. Pairing: stateless start, admin bind, device claim

Chromecast-style three-step flow. No database writes are possible from the
unauthenticated side until an admin binds a code:

1. **Start (public, rate-limited):** the unpaired display page requests a
   pairing code. The server generates a 6-character code from an unambiguous
   alphabet (`A–H J–N P–Z 2–9`, 31 symbols ≈ 8.9 × 10⁸ combinations) and
   returns it, alongside an **HMAC-signed pairing blob** (`{code, exp}`
   signed with the auth secret — the `lodge-pin-session` signing pattern)
   set as an httpOnly cookie on the device. Nothing is persisted server-side:
   the code's expiry travels tamper-proof inside the signed blob, so
   anonymous requests cannot create database rows.
2. **Bind (admin session):** the admin reads the code off the TV and enters
   it against a device record (`POST /api/admin/display/devices/[id]/pairing`).
   The server persists `pairingCode` + `pairingCodeExpiresAt` on that row —
   the single-use persistence required by the schema (LTV-001).
3. **Claim (public, rate-limited):** the display page polls claim. The server
   verifies the signed blob (signature + expiry), then looks for a device
   whose stored `pairingCode` matches the blob's code and is unexpired, and
   whose `revokedAt` is null. On match, inside one transaction: issue the
   display token, store only its hash, **clear the pairing fields**
   (single-use). The claim can only present a code the server itself signed
   for that device's browser — a shoulder-surfed code alone is useless
   without the signed blob cookie.

Re-pairing a paired device is allowed (admin re-binds a new code; a
successful claim **replaces** `tokenHash`, immediately invalidating the old
device's token) — this is the device-swap/lost-TV story.

### 3. Display token: hashed at rest, httpOnly cookie

- Issued via the existing `issueActionToken()` (32 random bytes, 64-hex);
  stored as its SHA-256 hash in `LodgeDisplayDevice.tokenHash` (unique) per
  `docs/TOKEN_HASHING.md`. No plaintext token column exists (LTV-001 pins
  this with a type-level test).
- Delivered as an httpOnly, Secure, `SameSite=Lax` cookie, max-age 365 days,
  scoped to `/`. Cookie-based because TV browsers need zero client-side
  storage code and httpOnly keeps the token out of page script reach.
- CSRF exposure is acceptable by construction: the token authorises only
  reads (display state) and the `lastSeenAt` heartbeat — no state-changing
  capability exists to ride.
- Expiry/revocation → the device falls back to the pairing screen; re-pair
  is the recovery path. No silent renewal in v1 (simplicity over convenience;
  revisit if 365-day re-pairs prove annoying).

### 4. A separate guard, not a `KioskTier` extension

`checkLodgeAuth`/`KioskTier` model **member sessions** with interactive
capabilities (attendance, chores) and lodge resolution via member bindings.
Display auth is **device-bound and sessionless**: `checkDisplayAuth()` in
`src/lib/lodge-display-auth.ts` resolves `tokenHash → device → lodgeId (FK)`
and nothing else. Keeping the guards separate means the display token can
never inherit a kiosk capability by accident, and kiosk changes can never
widen the display surface. The two share no code paths beyond the token
hashing utilities.

### 5. Rate limiting

Two new limiters: `displayPairing` (auth-sensitive, 10 / 15 minutes per IP)
for pairing **start** and the admin **bind**; `displayClaim` (30 / minute per
IP) for the display page's claim **poll** — the claim can only present the
code inside its own server-signed blob, so it has no guessable surface and a
poll-friendly limit is safe. Heartbeat uses the general `api` limiter.
Auth-sensitive limiters fail closed at reduced limits when the shared store
is degraded (existing `rate-limit.ts` semantics).

## Security considerations

- **Anonymous surface creates no state:** pairing start is stateless (signed
  blob); claim only reads/updates rows an admin explicitly bound. No
  unauthenticated database writes exist on this surface.
- **Code interception:** a code alone cannot be claimed (needs the signed
  blob held by the requesting browser); a blob alone cannot be claimed until
  an admin binds that exact code to a device; both expire in 15 minutes and
  are single-use.
- **Token theft:** the token is httpOnly (not script-readable), hashed at
  rest (a database leak reveals no usable tokens), unique per device, and
  individually revocable with immediate effect (`revokedAt` checked on every
  request; a rejected request does not update `lastSeenAt`).
- **Privilege containment:** the guard authorises only display-namespace
  routes; every kiosk/member/admin route continues to require its own auth.
  The display token never maps to a Member.
- **Brute force:** code space ≈ 8.9 × 10⁸ × 15-minute window × single-use ×
  auth-sensitive IP rate limiting; claim additionally requires a
  server-signed blob, reducing online guessing to nil.
- **Secrets:** signing reuses `AUTH_SECRET`/`NEXTAUTH_SECRET` via
  `getAuthSecret()` (no new secret to provision); HMAC-SHA256 with
  timing-safe comparison, matching `lodge-pin-session`.

## Alternatives considered

- **`/lodge/display` namespace** — rejected: couples the display module to
  the kiosk flag (see §1).
- **Extending `KioskTier` with a "display" tier** — rejected: entangles a
  sessionless device credential with member-session semantics; risk of
  privilege bleed both directions.
- **Pre-created pairing codes in the admin UI (admin reads code to the TV)**
  — rejected: the TV has no input to type into; showing the code on the TV
  and confirming from a logged-in phone matches the hardware reality.
- **DB-persisted pairing sessions from the public endpoint** — rejected:
  lets anonymous traffic create rows (DoS/garbage risk); the signed-blob
  design keeps the anonymous side stateless.
- **JWT display tokens (self-contained, no DB lookup)** — rejected: loses
  per-device instant revocation, which the brief's success criteria require.
