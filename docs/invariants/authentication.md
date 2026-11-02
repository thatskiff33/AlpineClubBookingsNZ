# Authentication

Audience: Developer, Agent.

Prefix defined in this file: **`INV-AUTH`** — how the app decides whether a
sign-in attempt may proceed, without telling anyone which accounts exist.

Read this file when you are changing password sign-in, the per-account
password throttle, what a refused or throttled sign-in answers, or anything
that keys a limit on an account rather than an internet address.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) — every `INV-*` ID
with a one-line description of what it covers. ID scheme and allocation rules:
[`SCHEME.md`](SCHEME.md).

Every heading below whose whole text is an `INV-*` ID defines that invariant. IDs
are permanent: never renumbered, never reused.

The threat, the fallback and the stated limits are in
[`SECURITY.md`](../SECURITY.md#per-account-password-throttle-4609); the row
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

- **The throttle decides before any Member read, from the key alone.** A
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
- **Password sign-in only.** Emailed sign-in links, Google, two-factor code
  entry and lodge PIN sign-in are unaffected, and the per-address limiter is
  unchanged.
- **A store failure never becomes a sign-in outage.** The claim falls back to a
  bounded per-process count at the budget divided as the auth-sensitive
  limiters divide theirs (#1142).
