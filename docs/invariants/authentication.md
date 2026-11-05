# Authentication

Audience: Developer, Agent.

Prefix defined in this file: **`INV-AUTH`** — how the app decides whether a
sign-in attempt may proceed, without telling anyone which accounts exist, and
which passwords it lets a person choose.

Read this file when you are changing password sign-in, the per-account
password throttle, what a refused or throttled sign-in answers, anything
that keys a limit on an account rather than an internet address, or any code
that writes `passwordHash`.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) — every `INV-*` ID
with a one-line description of what it covers. ID scheme and allocation rules:
[`SCHEME.md`](SCHEME.md).

Every heading below whose whole text is an `INV-*` ID defines that invariant. IDs
are permanent: never renumbered, never reused.

The threat, the fallback and the stated limits are in
[`SECURITY.md`](../SECURITY.md#per-account-password-throttle-4609) and
[`SECURITY.md`](../SECURITY.md#breached-password-check-4610); the row
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

- **A password a person chooses is screened against the public breach list
  before it is hashed.** Every place a person chooses a password — change,
  reset and account-setup links, and an officer setting a kiosk password —
  awaits `screenChosenPassword` in
  [`breached-password.ts`](../../src/lib/breached-password.ts) first, and a
  listed password is refused with `PASSWORD_BREACHED`. It is the one helper
  (`INV-SSOT`); sign-in never calls it, and passwords already set are not
  re-checked.
- **Only a five-character prefix of the password's SHA-1 hash leaves the
  server.** The range answer is matched locally. No password, full hash or
  member identifier is sent, and nothing logs the prefix.
- **It fails open.** No answer within three seconds, a network error, a non-200
  or a malformed body accepts the password and logs only the failure class.
- **The check is a club setting, on by default**
  (`LoginSecuritySetting.breachedPasswordCheck`, `INV-CONFIG-001`). Switched
  off, no request is made.
- **Every `passwordHash` writer is classified.**
  `password-hash-writer-census.test.ts` fails a new writer that neither screens
  first nor is listed as exempt with its reason: a generated or deliberately
  unusable hash (placeholders, imports, erasure, seeds).
