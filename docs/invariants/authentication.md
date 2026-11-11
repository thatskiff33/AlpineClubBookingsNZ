# Authentication

Audience: Developer, Agent.

Prefix defined in this file: **`INV-AUTH`** — how the app decides whether a
sign-in attempt may proceed, without telling anyone which accounts exist,
which passwords it lets a person choose, how long a signed-in session
lasts, and how recently the person must have proved who they are.

Read this file when you are changing password sign-in, the per-account
password throttle, what a refused or throttled sign-in answers, the
per-account limits on password-reset and sign-in-link requests, anything that
keys a limit on an account rather than an internet address, any code that
writes `passwordHash`, the session token's `jwt` callback and
`sessionIssuedAt`, or `lastAuthenticatedAt` and `requireRecentAuth`.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) — every `INV-*` ID
with a one-line description of what it covers. ID scheme and allocation rules:
[`SCHEME.md`](SCHEME.md).

Every heading below whose whole text is an `INV-*` ID defines that invariant. IDs
are permanent: never renumbered, never reused.

The threat, the fallback and the stated limits are in
[`SECURITY.md`](../SECURITY.md#per-account-password-throttle-4609), for
the request limits
[`SECURITY.md`](../SECURITY.md#per-account-email-request-limits-4613), and
[`SECURITY.md`](../SECURITY.md#breached-password-check-4610), for the session
cap [`SECURITY.md`](../SECURITY.md#maximum-session-age-4611); the row
lock is in
[`CONCURRENCY_AND_LOCKING.md`](../CONCURRENCY_AND_LOCKING.md#narrow-row--and-table-lock-protocols).
This file holds only the rules.

## INV-AUTH-001

- **An account is keyed by an HMAC of its normalised sign-in email, never by
  the address.** `loginAccountKey` in
  [`login-throttle.ts`](../../src/lib/login-throttle.ts) is HMAC-SHA256 under
  the auth secret with the domain label `login-throttle:v1:`. The address never
  reaches the `LoginThrottle` table, a log line or an audit row; a store-failure
  log names neither the address nor the key.
- **The key's normaliser is the member lookup's normaliser.**
  `normaliseSignInEmail` is the one helper both use, so the key is never finer
  than the match (`INV-SSOT-002`): every spelling that signs in to an account
  counts against that account.
- Rotating the auth secret changes every key, which resets every count.

## INV-AUTH-002

- **At sign-in, the throttle decides before any Member read, from the key alone.** A
  throttled attempt runs the dummy bcrypt compare and answers
  `LOGIN_THROTTLED` — one error, one code, one message — for every account:
  real, unknown, inactive or deleted. Unknown emails are counted exactly as real
  ones. Throttled real and throttled unknown accounts are therefore identical by
  construction, not by care: the throttled path has no Member to differ on.
- **This is parity of the throttled answer, not of the count's history.** A
  valid sign-in or completed reset on a real account clears its count
  (`INV-AUTH-003`); an unknown email's never is. That difference is a stated
  limit in [`SECURITY.md`](../SECURITY.md#per-account-password-throttle-4609).

## INV-AUTH-003

- **An attempt is claimed under the account's row lock before its password is
  compared.** The claim ensures the `LoginThrottle` row, locks it, reads it,
  decides and counts in one transaction, so parallel guesses queue and a burst
  fired the moment a wait ends admits exactly one. Counting after a failed
  compare instead would let every guess in that burst pass one check.
- **A throttled attempt neither checks the password nor counts.** A correct
  guess during the wait does not succeed.
- **A valid password clears the count, and so does a completed password
  reset** (owner decision on #4609): the reset proves the mailbox.

## INV-AUTH-004

- **The values are a security floor, not a club setting** (`INV-CONFIG-001`
  records why the distinction exists; the owner settled this one on #4454): five
  counted attempts are free, then the next waits 30 seconds, doubling per
  further attempt to a 15-minute ceiling. **An hour with no counted attempt
  resets the count** — the chosen reading of "5 wrong passwords within an hour",
  so failures spaced 59 minutes apart still add up; a fixed hourly window would
  also reset the ceiling every hour.
- **Password sign-in and authenticated current-password checks share the
  budget** (#4640). Change-password uses the authenticated member's stored
  email after session validation; a refused claim answers HTTP 429 with
  `LOGIN_THROTTLED` without comparing the password. Emailed sign-in links, Google, two-factor code
  entry and lodge PIN sign-in are unaffected, and the per-address limiter is
  unchanged.
- **A store failure never becomes a sign-in outage.** The claim falls back to a
  bounded per-process count at the budget divided as the auth-sensitive
  limiters divide theirs (#1142).

## INV-AUTH-005

- **Password-reset and sign-in-link requests are also limited per account**
  (#4613), beside each route's per-address limiter: `forgotPasswordAccount`
  and `magicLinkRequestAccount` in
  [`rate-limit.ts`](../../src/lib/rate-limit.ts), counted by
  `checkAccountRequestLimit` in
  [`account-request-limit.ts`](../../src/lib/account-request-limit.ts).
- **The counter key is the `INV-AUTH-001` account key**, under an `account:`
  prefix in the shared `RateLimitCounter` table: no second keying, no new
  store, no address. Without an auth secret the count stays in the process and
  never reaches the table.
- **The limit decides from the key alone, before any Member read** (and, for
  sign-in links, before the module flag), **and a limited request gets the
  accepted answer**: HTTP 200 `{ success: true }` and no email. Unknown emails
  are counted exactly as real ones, so a limited real account and a limited
  unknown email look the same.
- **A store failure never blocks a request.** The count falls back to the
  #1142 per-process budget, as every auth-sensitive limiter's does.

## INV-AUTH-006

- **A password a person chooses is screened against the public breach list
  before it is hashed.** Every place a person chooses a password — change,
  reset and account-setup links, an officer setting a kiosk password, and the
  install seed's two passwords —
  awaits `screenChosenPassword` in
  [`breached-password.ts`](../../src/lib/breached-password.ts) first, and a
  listed password is refused with `PASSWORD_BREACHED`. It is the one helper
  (`INV-SSOT`); sign-in never calls it, and passwords already set are not
  re-checked.
- **Only a five-character prefix of the password's SHA-1 hash leaves the
  server.** The range answer is matched locally. No password, full hash or
  member identifier is sent, and no log line, Sentry span, breadcrumb or event
  carries the prefix (`sentry-privacy-options.ts` filters on the endpoint).
- **It fails open.** No answer within three seconds, a network error, a non-200
  or a malformed body accepts the password and logs only the failure class.
- **The check is a club setting, on by default**
  (`LoginSecuritySetting.breachedPasswordCheck`, `INV-CONFIG-001`). Switched
  off, no request is made.
- **Every `passwordHash` writer is classified**, raw-SQL `INSERT`/`UPDATE`
  literals included. `password-hash-writer-census.test.ts` fails a new writer
  that is neither guarded — a `const` bound to the awaited screen of the same
  unreassigned `const` or parameter it hashes, then `if (!result.ok)`
  returning, before the write in an enclosing block — nor listed as exempt
  with its reason: a generated or deliberately unusable hash (placeholders,
  imports, erasure, the demo seed, SQL fixtures). An exempt writer's value
  must trace to random bytes, the erased-account sentinel or an inline
  literal; a stored parameter or copied hash, to the screened or generated
  writer its `valueFrom` names. A copy is refused if its object is changed;
  an alias or call that changes the screened object voids a screen. Only the
  local demo seed is untraced.

## INV-AUTH-007

- **Every signed-in session ends at a fixed age counted from sign-in, however
  active it is.** `isSessionPastMaxAge` in
  [`session-max-age.ts`](../../src/lib/session-max-age.ts) is the one rule
  (`INV-SSOT`); its one caller is the `jwt` callback in
  [`auth.ts`](../../src/lib/auth.ts), which every session read passes through.
  At the limit the callback sets `sessionInvalidated`, ending the session as a
  revoked one ends.
- **The decision is recomputed from the sign-in stamp on every read.** The flag
  is saved only when the browser refreshes its session through the session
  endpoint; a bare `auth()` never writes the cookie. So raising the setting, or
  the account becoming the kiosk, re-admits a session past the old limit that
  was never saved as invalidated.
- **The age is measured from `sessionIssuedAt`, never `iat`**, which every
  refresh renews. Only the callback's sign-in branch mints the stamp; no
  refresh, role change or two-factor verification moves it. The rule judges
  the stamp the token arrived with, before the callback back-fills a missing
  one.
- **A token with no readable `sessionIssuedAt` is expired**, never unlimited.
- **The limit is a club setting** (`LoginSecuritySetting.sessionMaxAgeHours`,
  `INV-CONFIG-001`): default 168 hours, accepted 8 to 720. The save route
  refuses a value outside that range; a stored stray value is clamped on read.
  It is read on every refresh, so a change reaches existing sessions on their
  next one. A failed read fails the refresh closed: the session endpoint
  clears the cookie, as for a failed member read; it never extends a session.
- **The lodge kiosk account keeps its own 30 days**, which the club setting
  never shortens or lengthens, judged on the fresh member row
  (`isKioskSessionMember`).

## INV-AUTH-008

- **A session records when the person last proved who they are.**
  `requireRecentAuth` in
  [`require-recent-auth.ts`](../../src/lib/require-recent-auth.ts) is the one
  check (`INV-SSOT`). It passes only when `lastAuthenticatedAt` is a finite
  epoch millisecond and is not older than five minutes. A missing stamp fails
  closed. No route calls it yet.
- **The five minutes is a security floor, not a club setting.**
- **A password proof writes the stamp only when no authenticator factor is
  still owed.** An email factor does not count as owed, so that password step
  writes it and the later emailed code does not. An authenticator-app consume
  writes it, including enrolment. An emailed link, Google, a recovery code,
  and an emailed code do not, and none of them clears a stamp already there.
  The `jwt` callback in [`auth.ts`](../../src/lib/auth.ts) decides this from
  server-side facts: the credentials provider, the member row after reload,
  and the kind prefixed into the hashed two-factor challenge. A
  reauthentication challenge still writes it. A `session.update()` payload
  that carries the time, or a proof kind, is ignored. Each challenge is
  server-minted, stored as a keyed hash, and bound to one member. The
  reauthentication challenge is consumed by one status-guarded claim.
- **The confirm dialog accepts an authenticator-app code, a passkey once one
  exists, or the password only when the person has neither.** An emailed code
  and a recovery code are never accepted there. A failed proof counts toward
  the two-factor lockout, or the per-account password throttle when the proof
  is the password.
- **The confirm dialog replays the refused request once, with the same body.**
