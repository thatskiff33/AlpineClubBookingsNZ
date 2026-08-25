# Configuration

This reference covers the public configuration contract for AlpineClubBookingsNZ.
Start from `.env.example` and `config/club.example.json`, then replace values
for your club before running a shared or production deployment.

Do not commit `.env`, production credentials, payment/accounting tokens, or
database backups.

## Club Config

`src/config/club.ts` loads `config/club.json` first and falls back to
`config/club.example.json` when `club.json` is absent. For a new club, copy the
example and edit it:

```bash
cp config/club.example.json config/club.json
```

Copying the example is optional. Under the DB-first model the club's live
configuration lives in the **database**, and `config/club.json` is only an
optional seed/fallback (see "DB-first identity" below). The primary way to
configure a club is the admin UI at `/admin/setup` and its linked editors
(identity, lodges/capacity, seasons/rates, email, Stripe, Xero).

You can also run the setup wizard once the database is migrated and seeded:

```bash
npm run setup:wizard
```

The wizard now **writes the club's configuration to the database**, not to a
file — it upserts the same settings rows the admin editors write:

- club name / short name → `ClubIdentitySettings`
- club/booking name, email from-name, support and contact email, public URL →
  `EmailMessageSetting`
- total bunk/bed capacity → `LodgeSettings.capacity`
- age-tier labels, ages, and subscription rules → `AgeTierSetting` (the four
  fixed slots INFANT/CHILD/YOUTH/ADULT; per-tier nightly **rates** are set at
  `/admin/seasons`, not by the wizard)

It writes no `config/club.json`, no `.env` file, and stores no API keys, OAuth
secrets, SMTP secrets, or bearer tokens. If the database is not yet reachable
(pre-migration), the wizard writes nothing and instead points you at
`/admin/setup` to complete configuration after the deploy. Re-running the wizard
against an already-configured database prompts for confirmation before it
overwrites existing values (it is an interactive operator tool).

`config/club.json`, when present, is validated by `src/config/schema.ts`.

### Boot-safe config loading

The config loader (`src/config/club.ts`) never throws, so an absent or broken
`config/club.json` can never crash the app at boot. Resolution rules:

- **Valid `club.json`** → used as-is (no change for healthy installs).
- **Malformed `club.json`** (present but invalid JSON or failing schema
  validation) → the app degrades to the built-in `SAFE_DEFAULT_CONFIG` and logs
  a warning. The `club.example.json` fallback is intentionally **skipped** in
  this case so a broken primary is not silently masked, and `npm run setup`
  reports the Club Config step as **blocked**. Fix `config/club.json`.
- **Absent `club.json`** → falls back to a valid `config/club.example.json`; if
  the example is also absent or malformed, the app boots on
  `SAFE_DEFAULT_CONFIG` with a logged warning.

`SAFE_DEFAULT_CONFIG` (`src/config/safe-default-config.ts`) is the single
canonical "unconfigured club" default; the setup wizard/CLI reference the same
constant, and it always carries a valid absolute `publicUrl` so the identity
bootstrap layer (`src/config/club-identity.ts`) cannot throw. It is a safe
placeholder only — a real deployment must still configure the club.

#### Bootstrap layer for the collapsing identity fields (C6)

Five identity fields — **public URL**, **support email**, **contact email**,
**email from-name**, and **social links** — are never read from
`config/club.json` at runtime. Every consumer resolves them one of two ways:

- **Async-context readers resolve DB-first.** Outbound email identity (sender
  from-name, support/contact addresses) comes from `EmailMessageSetting`,
  applied at send time via `applyEmailMessageSettings*` /
  `formatEmailFromAddressWithSettings` (`src/lib/email-message-settings.ts`); the
  public contact `mailto:` (contact route + the pre-setup website screen) reads
  `EmailMessageSetting.contactEmail`; CMS `{{facebook-url}}` /
  URL tokens resolve through the DB-first `getClubIdentity()` identity
  (`src/lib/page-content-embeds.ts`).
- **Genuinely synchronous, boot-critical sites use the bootstrap layer, not
  `club.json`.** The app origin (sitemap, root metadata `metadataBase`, the
  identity `publicHost` used for `clubDomainEmail`) comes from the `NEXTAUTH_URL`
  bootstrap env var, falling back to `SAFE_DEFAULT_CONFIG.publicUrl`. The
  outbound **envelope sender** (`EMAIL_FROM` in `src/lib/email-sender.ts`) is a
  bootstrap concern — it must be a provider-verified (SES) address — so it comes
  from the `EMAIL_FROM` env var, falling back to
  `SAFE_DEFAULT_CONFIG.supportEmail`. The From/envelope **address** is always
  this bootstrap value — the DB-first `EmailMessageSetting.supportEmail` is
  never used as the sender address (it governs the body/footer support links via
  send-time replacement, and `emailFromName` governs the From display name), so
  production must set `EMAIL_FROM` to a provider-verified address. The
  `SUPPORT_EMAIL` / `EMAIL_FROM_NAME` module constants and
  `email-message-settings.ts`'s `EMAIL_DEFAULT_FROM_NAME` / default settings are
  the **stable search keys** that the send-time replacement swaps for the live DB
  values, so they stay config-derived (never the safe default) — mirroring the
  `EMAIL_DEFAULT_LODGE_NAME` invariant.

`NEXTAUTH_URL` and `EMAIL_FROM` are the only genuine bootstrap env inputs here;
these fallbacks are intentional bootstrap defaults, never a `club.json` runtime
read. On a real install the club's `config/club.json` values reach the DB via the
seed / boot self-heal (see below), after which the DB is authoritative.

### DB-first identity (admin-editable)

The club **name**, **short name**, **hut-leader label**, and **Facebook URL** are
DB-first: an admin edits them under **Admin > Site Appearance & Content > Club
Identity** (no redeploy). Each field resolves through a per-field fallback chain —
**database (`ClubIdentitySettings`) → `config/club.json` → hard default** — so an
empty/absent row keeps working from the file config, and clearing a field in the
admin UI restores the configured default. The Facebook URL resolves
**`ClubIdentitySettings.facebookUrl` → `config/club.json` `socialLinks.facebook` →
undefined** and, when set, must be a valid http(s) URL. **Clearing the Facebook
URL is not durable like the other three fields.** Clearing the name, short name,
or hut-leader label leaves that column null permanently, so it keeps tracking
`config/club.json` on every later boot; clearing the Facebook URL is only transient, because
`facebookUrl` is filled by a **column-level** boot backfill (not a row-level
create-if-absent) — the next boot re-heals it from the *then-current*
`socialLinks.facebook`, after which the column holds that snapshot and stops
tracking subsequent `club.json` edits. To change it durably, set the new value in
the admin UI rather than clearing it to fall back to the file. Changes propagate to the site header,
footer, page titles, and emails within a few seconds (a 15s tagged cache; the
TOTP issuer label used at 2FA enrolment can lag by a short process-cache TTL and
only affects new enrolments). `config/club.json` is never modified by these
edits — it remains the seed and the fallback.

On a fresh install `prisma/seed.ts` create-only upserts the `config/club.json`
identity into `ClubIdentitySettings` so the admin card shows the configured
values. A routine production upgrade runs `prisma migrate deploy` **only** (the
seed never fires, and a SQL migration cannot read `config/club.json`), so the
app also **self-heals this row on every boot**: it copies the current effective
config value into the DB row if — and only if — the row is still absent, and
never overwrites an admin edit. Healing runs **only from a valid primary
`config/club.json`** — a boot that fell back to the example or the safe default
(missing/malformed primary) skips healing so a placeholder identity is never
frozen into the DB, and self-repairs on a later boot once the primary is fixed
(the manual `npm run config:self-heal` exits non-zero on such a fallback skip).
This is what lets later collapse work drop the file/env fallbacks without
stranding a live deploy. See "Config self-heal on boot" in `docs/DEPLOYMENT.md`,
`src/lib/config-self-heal.ts` (the runner) and `src/lib/config-self-heal-steps.ts`
(the step definitions, split out in #2989 when the module reached its size
budget; every export is still re-exported from the runner, so nothing that
imported it had to change).

**One step is deliberately exempt from that `config/club.json` guard**: the club
timezone (#2989). The value it copies comes from `TZ` / `NEXT_PUBLIC_TZ`, not from
`club.json`, and since #1987 an absent `club.json` is normal for a database-first
install — so gating it on the file would mean those installs never recorded their
timezone at all. It therefore runs on every boot regardless of config provenance,
and it can only ever CREATE the row, never overwrite one. `npm run
config:self-heal` now prints the results of the steps that did run even on a
provenance skip, and still exits non-zero, because a partial run is not a
success.

The **lodge display name** is not stored in club identity: it always resolves
from the **default lodge**'s `Lodge.name` (edit it under Club Identity > Lodge
details, or Admin > Setup > Lodges for multi-lodge clubs). The lodge also carries
an admin-editable **address** (shown on the public contact page and via the
`{{lodge-name}}` / `{{lodge-address}}` content tokens).

Email club-name precedence is `EmailMessageSetting.clubName` (Admin > Email
Messages) → `ClubIdentitySettings.name` → `config/club.json`. Email template
default subjects keep the config-derived lodge name as their stable search key;
the live lodge name is substituted at send time.

**Email identity is admin-managed, DB-first (Admin > Email Messages).** The
sender **display name** (`emailFromName`), the **support address**
(`supportEmail`, used for body/footer support links), and the **contact-form
recipient** (`contactEmail`, which falls back to `supportEmail`) all resolve from
`EmailMessageSetting` → `config/club.json`. There are **no** `EMAIL_FROM_NAME`,
`SUPPORT_EMAIL`, or `CONTACT_EMAIL` env vars — they were removed (#1986) so
`EmailMessageSetting` is the single source for email identity. `EMAIL_FROM`
remains the sole email env var (besides transport secrets): it is the
envelope / Return-Path sender **address** and must be a provider-verified (SES)
address in production; the DB `supportEmail` is never used as the sender address.
The now-dead `NEXT_PUBLIC_CONTACT_EMAIL` build arg was deleted at the same time.
**Upgrade note:** a deployment that previously routed the contact form via the
`CONTACT_EMAIL` env var must set the DB `contactEmail` under Admin > Email
Messages; if left unset it falls back to `club.json`'s `contactEmail`, then to
the support address, per the precedence above (via the boot self-heal chain),
so removing the env var causes no hard break. As a safety net, if any of the
removed vars (`EMAIL_FROM_NAME`, `SUPPORT_EMAIL`, `CONTACT_EMAIL`,
`NEXT_PUBLIC_CONTACT_EMAIL`) is still set at boot, the server logs a single
warning naming it (scope `ignored-email-env`) so an operator knows the value is
ignored and identity is admin-managed.

Split-booking confirmations depend on the `{{provisionalGuestsNote}}` token in
the **booking-confirmed** body (Admin > Email Messages): it renders the
provisional non-member portion story on a split parent and nothing otherwise
(the `{{paymentNote}}` precedent). An operator who overrides the
booking-confirmed body must keep this token, or split-parent confirmations
silently lose the "held provisionally / charged later" explanation.

Promo pricing on the booking-confirmed email works the same way through the
pre-composed `{{promoSummary}}` token: when a promo code changed the price it
renders the whole explanatory block — a `Subtotal:` line plus a signed
`Promo adjustment (CODE):` line (`-$30.00` for a discount, `+$1,370.00` for a
promo such as an exclusive-use flat rate that *raises* the price) — and
renders nothing at all when no promo applied. Each line carries its own
trailing line break, so the default body places it hard against the money
outcome (`{{promoSummary}}{{paymentOutcome}}`); keep that placement in an
override or the block renders detached from the money it explains.

The money outcome itself is the pre-composed `{{paymentOutcome}}` block: a paid
booking renders `Total Paid:` plus the payment-processed sentence, while a
booking confirmed with money still owing (a member whole-lodge approval's
internet-banking receivable) renders `Total Due:` plus a sentence stating the
amount owing and the payment reference — so the default body can never tell a
member their payment was processed when it was not. An override may instead
build its own money lines from the per-piece tokens (`{{totalPaid}}`,
`{{totalDue}}`, `{{paymentDueNote}}`, `{{paymentReference}}`); exactly one of
`{{totalPaid}}`/`{{totalDue}}` carries a figure on any given send.

On that unpaid send only, `{{paymentDueNote}}` closes with one further
sentence: *"If the invoice asks for a different amount — for example because the
club has put account credit you hold towards it — please transfer the amount the
invoice shows."* The `Total Due:` line is the **booking's** price; the invoice
the member pays against is a separate document an admin can adjust by hand, so
the email defers to it rather than to itself. The sentence is deliberately
conditional and names no second amount — for the great majority of members the
invoice matches the total exactly — and it is part of the same
`{{paymentDueNote}}` value, so no new token was added: an override that renders
`{{paymentOutcome}}` or `{{paymentDueNote}}` picks the sentence up with no edit
at all. An override that builds its own money lines from the per-piece tokens
**without** either of those, as the paragraph above allows, has never carried the
unpaid send's payment instructions and still does not — add `{{paymentDueNote}}`
to such a body, or its members are told a `Total Due:` figure and never told how
to pay it. The sentence renders on the unpaid send and nowhere else; on every
other send `{{paymentDueNote}}` is empty, so it is declared emptyable and the
editor warns if you type a label in front of it. Where the booking app's own
records show **no** account credit against the booking — which is every unpaid
confirmation the system sends today — nothing nets credit off such an invoice
for you, and an admin who wants a member's credit applied does it in Xero, which
is why the sentence describes a possibility rather than promising one.

Where the booking app's OWN records DO say account credit has been applied to
that booking, two things change. The invoice is netted **for you** — the
allocate-existing engine (#1620) allocates the member's credit against it
automatically the moment those records exist — so do **not** allocate credit to
that invoice by hand in Xero as well, or the member's credit is spent twice. And
the unpaid send states the netting instead of the sentence above (#2483).
`{{paymentOutcome}}` then renders three reconciling lines —
`Booking Total: $300.00`, `Account credit applied: -$120.00`,
`Total Due: $180.00` — and `{{paymentDueNote}}` names the netted figure, states
the arithmetic in words, and asks the member to transfer that figure and tell
the club if their invoice disagrees. `{{totalDue}}` carries the **netted**
amount, because it has always meant "what is still owed", so an override that
writes its own money lines out of the per-piece tokens asks for the right amount
with no edit at all; again, no new token was added. `{{creditNote}}` stays empty
here — it explains where the money came from on a booking that has been settled,
and an unpaid one has no such story. The figure comes from the club's own credit
records, not from Xero, so the email never waits on your accounting system to
catch up; a separate reconciliation check (#2501) is being built to warn admins
if the two ever disagree — until it lands, that comparison is a manual check.

Two edge cases behave differently, and both err towards asking a member for
**less** rather than more. When the credit covers the booking exactly, the same
three lines render and land on `Total Due: $0.00`, and the paragraph says there
is nothing further to transfer — it never asks for the full price. When the
records hold **more** credit than the booking costs, the two cannot both be
true, so the email names no figure at all: it states the `Booking Total` as a
fact, `{{totalDue}}` is **empty**, and the member is asked to wait while the
club confirms what, if anything, is left to pay. An admin gets a log entry for
that case. A booking with no applied credit is unchanged — the conditional
sentence above renders exactly as before.

When the Xero module is off and you invoice by hand, the "Whole-lodge booking
needs a manual invoice" alert quotes the same netted amount the member was asked
to transfer, so invoice what the alert says rather than the booking's price.

Account credit spent on the booking is explained by the pre-composed
`{{creditNote}}` block, on the same convention again. When a member put account
credit towards their stay it renders two reconciling lines — `Account credit
applied: -$120.00` and `Paid by card: $180.00` — and when they did not (the
great majority of bookings) it renders **nothing at all**, so those
confirmations are byte-for-byte what they were before the token existed.
`Total Paid` above it stays the booking's **full price**, because the credit
really did pay for part of the stay, so the three figures reconcile:
`300.00 − 120.00 = 180.00`. Whenever money really did change hands, the second
line names how the club was actually paid — `Paid by card`, `Paid by bank
transfer`, or `Paid by cash or bank transfer` for a manually-recorded
settlement — read from the booking's own payment record, so a member who
bank-transferred is never told their card was charged. When the credit covered
the **whole** stay no money changed hands by any method, and the booking's
payment record cannot say which method the member would have used, so the line
drops the method word and reads `Nothing more to pay: $0.00` — the line stays,
because completing the arithmetic is the point of it. On a partly-paid settle
the pair sits between `Paid:` and `Still Owing:` and breaks down the settled
slice; on a confirmed-but-unpaid send nothing has been paid yet, so no pair is
rendered at all.

The figure itself comes from the member credit **ledger** for that booking, read
at send time from the persisted rows — never re-computed from the credit policy,
whose answer depends on a balance and a price that both move after the booking
is paid. `{{creditNote}}` is already carried **inside** `{{paymentOutcome}}`, so
the shipped default body needs no change; it is supplied separately for an
override that builds its own money lines, exactly as `{{totalPaid}}` is. An
override written before this token existed keeps rendering and keeps re-saving
(it is not a required token) — but a hand-built money body that omits it will
show a member who was charged $180.00 a bare `Total Paid: $300.00`, so add it
under your total line.

**The promo explanation is required, not advisory.** An override of the
booking-confirmed body that shows a member no promo explanation at all is
rejected on save, because a member charged a promo price would otherwise read a
total with no reason for it. The rule is satisfied three ways, so it never
invalidates an override a club already saved: keep `{{promoSummary}}`, or show
the adjustment yourself with `{{promoAdjustment}}` (the signed value) or the
older `{{discount}}` — the shape the previous default body shipped
(`Subtotal: {{subtotal}}` above `Discount ({{promoCode}}): -{{discount}}`), so
every override saved from that default keeps validating and re-saving. A
`{{subtotal}}` line on its own does **not** satisfy it: a subtotal with no
adjustment beside it is exactly the "two amounts that differ, with nothing in
between to say why" email this rule exists to prevent. The editor prints the
rule and its alternatives under the token chips, and a rejected save explains
it in the same words.

Of the three, only `{{promoSummary}}` handles all promo shapes cleanly —
`{{discount}}` is empty for a price-raising promo, and `{{promoAdjustment}}`
carries its own `+`/`-` sign, so never write a manual minus in front of it. The
editor enforces that last point too: a body or subject that types `+` or `-`
immediately before `{{promoSummary}}`, `{{promoAdjustment}}` or `{{creditNote}}`
is rejected on save with an explanation — `{{creditNote}}`'s first line already
reads `Account credit applied: -$120.00`.

Two other pre-composed tokens follow the same pattern. The booking-confirmed
body's `{{doorCodeNote}}` renders the whole `Door code: 1234` line, and nothing
at all for a lodge with no door code recorded — an override may instead write
its own label around the bare `{{doorCode}}` value, and either form satisfies
the "the door code must stay in the body" rule. The booking-modified body's
`{{changeSummary}}` renders only the rows that actually changed
(`Previous`/`New` pairs where something moved, a single `Dates:` / `Guests:` /
`Total:` line where it did not, and a `Change Fee:` line only when a fee was
charged), so an override that keeps it always matches the built-in HTML email.
The per-piece `{{oldCheckIn}}`, `{{newTotal}}`, `{{changeFee}}` and siblings
stay available for existing overrides, but they cannot express "only show what
changed" — a body built from them lists every row on every modification.

Both of those are instances of one rule that governs **every** admin-editable
email body: **there is no conditional syntax.** `renderTemplateString` is a flat
regex substitution — a token whose value does not apply to a particular send
renders as an empty string, and nothing else happens. A body written as
`Door code: {{doorCode}}` therefore prints a bare `Door code:` to every member
staying at a lodge with no door code, and a body written as
`Requested: {{requestedAmount}}` prints a bare `Requested:` on an appeal that
named no figure.

The one security-specific exception is `{{bookingUrl}}` (#2362). It is offered
as an **optional** chip only on templates tied to one concrete booking. The
mailer supplies the canonical `/bookings/<encoded-id>` URL only after confirming
that the exact signed-in recipient is the booking owner, a linked member, or an
admin with bookings-view access. For a public/non-login contact, an aggregate
operator message, or an unauthorized member, the renderer removes the whole
line containing `{{bookingUrl}}`; it does not leave a bare label. Existing
stored override source and re-save behavior are not rewritten, and public bearer
links such as `/pay/<token>` or consent/respond URLs remain separate and
unchanged. At delivery time, a legacy/admin-authored authenticated booking href
is removed from an unauthorized override copy; authorized output is unchanged.
Failed retry-safe booking mail repeats both the current authority check and the
current direct/inherited mailbox match from durable recipient context before
replay. Retained new-version booking HTML is isolated from the legacy retry
column, so rolling the application back to the pre-#2362 worker cannot resend it.

Anything optional is therefore supplied as a **pre-composed line**: the sender
builds the whole line — label, value and its trailing blank line — or the empty
string, and the default body carries only the token. `{{doorCodeNote}}`,
`{{expectedArrivalNote}}`, `{{reasonNote}}`, `{{adminNoteLine}}`,
`{{adminNotesLine}}`, `{{reviewNoteLine}}`, `{{committeeNote}}`,
`{{rejoinProcessNote}}`, `{{reviewReasonNote}}`, `{{requestedAmountNote}}`,
`{{amountRecordedNote}}`, `{{bookingReferenceNote}}`, `{{choreListNote}}`,
`{{choreLinkNote}}`, `{{localRecordNote}}`, `{{latestErrorNote}}`,
`{{xeroLinksNote}}`, `{{refundOutcomeNote}}`, `{{settlementActionNote}}`,
`{{creditNote}}`, `{{checkoutChoreNote}}` and `{{ownBookingNote}}` all behave
this way, alongside the
older `{{provisionalGuestsNote}}`, `{{paymentNote}}` and `{{promoSummary}}`, and
the multi-line `{{ical}}` add-to-calendar block on the Booking Confirmed
message (fork #35), which renders its whole four-line section or nothing. An
operator overriding one of these bodies should place the token on a line of its
own and **never** write a label of their own in front of it. The raw value
behind each (`{{doorCode}}`, `{{reason}}`, `{{adminNote}}` …) stays valid for
overrides written before the change, so nothing an operator already saved stops
rendering or stops being re-savable.

`{{checkoutChoreNote}}` is the newest of these (#2621, owner decision D-M5) and
shows the shape at its clearest: on the **Pre-arrival Information** template the
sender emits the whole checkout-day chore sentence when the club's **Chores**
module is enabled, and the empty string when it is not. It is conditional on a
module rather than on a per-booking value because **the chores module defaults
off** — an unconditional sentence would tell every member of every chore-free
club that they are on a roster that does not exist, and send them to find a hut
leader about it, on the last message most members read before they travel. The
module read fails soft to off, which is the safe direction here: a database blip
costs a chores club one sentence, where failing open would misinform a club that
keeps no roster.

`{{expectedArrivalNote}}` on the same template is the ordinary per-booking form
of the pattern: the member's expected arrival time is **display-only
information** for the hut leader (#2621, owner decision 8 Aug), so the token
renders the whole "Expected arrival: 4:30 PM" line for a booking that has one and
nothing at all for a booking that does not. It changes no date, no charge and no
chore assignment. The picker members and admins use offers 6:00 AM–11:00 PM on
the hour and half hour, while the system accepts any half hour of the day, so a
genuine after-midnight arrival can be recorded through the API or simply
mentioned to the hut leader; a value stored outside the picker's range — or from
before the half-hour rule was tightened — still reads back in 12-hour form on the
booking page and the kiosk, and is named beside the dropdown so the screen never
shows nothing where a time is recorded.

A related rule follows from the same limitation: **one registered template
serves exactly one outcome.** A body that has to say either "your appeal was
approved" or "your appeal was declined" cannot choose between them, so the two
are separate registered templates with separate defaults, separate overrides and
separate token surfaces — `refund-request-approved` and `refund-request-declined`
(split in v0.13 from a single `refund-request-resolved`), alongside the existing
`booking-review-approved` / `booking-review-rejected` and
`membership-cancellation-approved` / `membership-cancellation-rejected` pairs.
The declined refund template deliberately has **no `{{amount}}` token at all**:
there is no refund to state, so the token is not supplied and not allowed, and an
override that reaches for it is refused when it is saved rather than rendering
"A refund of  will be processed". An installation that had customised the old
combined template keeps that row in the database, where it is reported in Admin →
Email Messages as a stale override needing cleanup; both new templates start from
their built-in wording, so no declined member can inherit approval copy.

`[only when …]`-style guidance must **never** appear in a default body or in an
override. The template engine does not understand it; the admin editor pre-fills
its textarea from the default body and stores whatever it is given verbatim, so
such a note is printed to the member the first time the template is saved. The
build enforces this: `src/lib/email-message-token-contract.ts` fails the test
suite on any square-bracketed text in a shipped default, on any default token
that is not in `APPROVED_EMAIL_TEMPLATE_TOKENS`, on any supplied override token
that is not approved (the state `{{promoAdjustment}}` was in), and on any
default that would leave a dangling label when a declared-optional value renders
empty. The same square-bracket detector runs at save time
(`validateEmailTemplateContent`), so an override carrying such a note is
refused with a plain-English explanation rather than stored; and because a row
saved **before** that check existed keeps sending its notes until re-authored,
the Admin → Email Messages page lists every stored override that still matches
the pattern so an operator can clean each one up by name.

| Field                                              | Required | Description                                                                                                      |
| -------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `name`                                             | yes      | Full public club name.                                                                                           |
| `shortName`                                        | no       | Short label used where space is limited.                                                                         |
| `supportEmail`                                     | yes      | Main support address and default sender fallback.                                                                |
| `contactEmail`                                     | no       | Contact-form recipient; falls back to `supportEmail`.                                                            |
| `publicUrl`                                        | yes      | Canonical public origin with no trailing slash.                                                                  |
| `emailFromName`                                    | yes      | Display name for outbound email sender headers.                                                                  |
| `lodgeTravelNote`                                  | no       | Email reminder travel/location note.                                                                             |
| `hutLeaderLabel`                                   | no       | User-facing label for the hut-leader **role** (e.g. `Lodge Leader`, `Warden`, `Duty Manager`), rendered wherever `{{hut-leader}}` appears — it is the role name, never a specific person. Defaults to `Hut Leader`. Who currently holds the role is assigned separately under Admin > Hut Leaders. |
| `socialLinks.facebook`                             | no       | Facebook URL used by public pages/footer. Must be an http(s) URL, like `publicUrl`. DB-first: admin-editable as **Facebook URL** under Club Identity (`ClubIdentitySettings.facebookUrl`); this file value is the seed/fallback. |
| `beds[].id`                                        | yes      | Stable bed or lodge identifier.                                                                                  |
| `beds[].name`                                      | yes      | User-facing bed/lodge name.                                                                                      |
| `beds[].capacity`                                  | yes      | Positive integer. Seed-template/import capacity + the value the boot self-heal backfills into the default lodge (not read at runtime, #1982). |
| `beds[].type`                                      | yes      | One of `dormitory`, `private`, or `shared`.                                                                      |
| `ageTiers[].id`                                    | yes      | One of `INFANT`, `CHILD`, `YOUTH`, or `ADULT`. (`NOT_APPLICABLE` is the fixed organisation/school tier — server-managed, never configured here.) |
| `ageTiers[].label`                                 | yes      | User-facing age-tier label.                                                                                      |
| `ageTiers[].minAge`                                | yes      | Minimum age, inclusive.                                                                                          |
| `ageTiers[].maxAge`                                | yes      | Maximum age, inclusive, or `null` for no upper bound.                                                            |
| `ageTiers[].subscriptionRequiredForBooking`        | yes      | Whether the tier must hold a subscription to book as a member.                                                   |
| `ageTiers[].familyGroupRequestCreateMemberAllowed` | yes      | Whether admins may create a non-login dependant from a pending family group request whose DOB maps to this tier. |
| `ageTiers[].nightlyRates.winter.memberCents`       | yes      | Winter member nightly rate in integer cents.                                                                     |
| `ageTiers[].nightlyRates.winter.nonMemberCents`    | yes      | Winter non-member nightly rate in integer cents.                                                                 |
| `ageTiers[].nightlyRates.summer.memberCents`       | yes      | Summer member nightly rate in integer cents.                                                                     |
| `ageTiers[].nightlyRates.summer.nonMemberCents`    | yes      | Summer non-member nightly rate in integer cents.                                                                 |

> **Age tiers are DB-only at runtime (#1983).** `config/club.json ageTiers[]` is
> a **seed input only**. At runtime the age tiers (boundaries, labels, per-tier
> subscription/family flags) are read solely from the `AgeTierSetting` table;
> `config/club.json` is never consulted for age classification once the DB is
> populated. On a fresh install `prisma/seed.ts` create-only upserts the config
> tiers into `AgeTierSetting`, and — because a routine `prisma migrate deploy`
> never runs the seed — the app **self-heals the tiers on every boot**: if the
> table is EMPTY it populates it from the current effective config tiers (only
> from a valid primary `config/club.json`; never overwriting an existing row, so
> admin edits survive). A hard-coded 4-tier TAC default (INFANT 0-4, CHILD 5-9,
> YOUTH 10-17, ADULT 18+) is the last-resort safety net if the table is still
> empty, so age classification never breaks. Nightly RATES are NOT self-healed
> here — they live independently in `MembershipTypeSeasonRate` (see below). See
> `src/lib/policies/age-tier.ts`, `src/lib/config-self-heal-steps.ts`, and
> "Config self-heal on boot" in `docs/DEPLOYMENT.md`.

> **Admins may run a contiguous SUBSET of the four slots (#2009).** On
> `/admin/age-tier-settings` an admin can save any contiguous subset of the four
> built-in age slots, not just all four. The saved rows must still tile `[0, ∞)`
> with no gaps or overlaps: the youngest tier starts at age 0, and `ADULT` is
> always present as the unbounded terminal (top) tier. So `CHILD 0-17 + ADULT
> 18+` or `ADULT 0+` alone are both valid; a set without `ADULT`, or one that
> leaves a gap, is rejected. Removing a tier is blocked (HTTP 409) while any
> member (archived members included) or any current/upcoming booking guest is
> still classified into it — reclassify those people first (edit their age tier
> or date of birth on the member page, and trim upcoming bookings' guests), then
> save again. The four enum slots (`INFANT`, `CHILD`, `YOUTH`, `ADULT`) remain
> the identity ceiling — a club cannot add a fifth tier or rename a slot's
> identity here (labels are free text); the data-driven-identities epic is the
> path beyond four.

> **Hut rates are keyed by membership type (#1930, E4).** The `memberCents` /
> `nonMemberCents` seed values above are fanned out at seed time into
> per-membership-type `MembershipTypeSeasonRate` rows: `memberCents` seeds every
> `MEMBER_RATE` type (FULL, LIFE, FAMILY, …) and `nonMemberCents` seeds the
> built-in `NON_MEMBER` type. `NON_MEMBER_RATE` (except `NON_MEMBER`) and
> `BLOCK_BOOKING` types get no rate rows. Each type starts age-keyed
> (`ageGroupsApply = true`, one row per tier); an admin may later set a type
> flat (one `NULL`-ageTier row). Xero hut-fee item codes
> (`XeroItemCodeMapping.membershipTypeId`) re-key the same way so an invoice
> line never disagrees with the rate that priced it. The legacy boolean-keyed
> `SeasonRate` table was frozen after E4 and **dropped** by
> `20260721120000_contract_drop_season_rate` (#2129 step 2), once the public
> `{{hut-fees}}` embed had been re-sourced onto `MembershipTypeSeasonRate`.

When the bed allocation module is effectively enabled and at least one active
bed exists in Admin -> Configuration -> Rooms & Beds, booking capacity is the
active bed count from that configurator — unless a per-lodge capacity is set
below that count, which caps it (the lower of the two applies, so a lodge may
have more beds than it is allowed to sleep). If the module is disabled, or the
module is enabled but no active beds exist yet, the system falls back to the
per-lodge `LodgeSettings.capacity`; if that is also unset the lodge resolves to
**0** (unbookable) and the setup-readiness Club Config check warns.

Since #1982 the DB is the **sole runtime source** of booking capacity —
`beds[].capacity` in `config/club.json` is **not** read at runtime. Instead the
default lodge's `LodgeSettings.capacity` is backfilled from the `config/club.json`
bed total by the boot-time config self-heal (see `DEPLOYMENT.md`), and
`config/club.json` remains a **seed template**: use the Rooms & Beds import
action to seed the configurator from it. See `docs/CAPACITY_MODEL.md` for the
full resolution table.

Keep all money values in integer cents.

## Branding Assets

Shared public-website, member-area, and admin-area brand colours and fonts are
managed by administrators at `/admin/site-style`. The existing primary accent
and neutral-ramp fields theme all three surfaces; the app does not maintain a
second accent setting. The occupancy meter follows the primary accent. Semantic
success, warning, information, danger/error, and waitlist colours stay curated,
contrast-locked light/dark pairs and are not editable brand fields. Fresh
deployments show a neutral public-site holding page until an admin finishes that
wizard. The logo is public-site only and is stored in the database — an uploaded
logo as a served image (`/api/images/<id>`), with a small validated inline data
URL kept for legacy and hand-crafted logos; there is no runtime upload directory
to preserve. Either way the stored bytes have their EXIF/XMP/comment metadata
(camera GPS) removed first, like every other image this system stores (#2242).

Saved palettes must meet the **WCAG AA 4.5:1** minimum text-contrast ratio on
the key public/app pairs — body and muted text on the page background, app text
on the secondary/mist surface, header text on the navigation bar, button text on
the primary-action colour, the app
accent on dark app chrome, and the contrast-safe dark accent-text role on the
light app background. App text-bearing surfaces use only the directly gated
snow/mist/deep/charcoal endpoints rather than interpolated colour mixes. The
editable primary accent remains visible as filled controls, decorative borders,
and the occupancy meter; it is not used directly for app text or focus rings.
App controls keep those text/background endpoints opaque on hover and selected
states; shadows or direct semantic endpoints provide interaction feedback rather
than `/NN` transparency utilities that could cross between accepted endpoints.
Bed-allocation booking colours are likewise confined to decorative strips and
rings; their text-bearing cards and Held badges use the gated card/secondary
pairs.
App keyboard focus uses deep on light surfaces and snow in dark mode, with a
two-pixel offset outline that remains visible on opacity-reduced controls. The wizard
disables its Save/Finish buttons and the `/admin/site-style` API rejects the
request (`400`) while any pair falls short, so an admin cannot ship an unreadable
theme. Both accepted colour formats are measured — hex directly, and `oklch()`
values via an oklch→linear-sRGB conversion — so pasting a low-contrast oklch
colour into the value field is blocked the same as a hex one. The current render
fallback uses glacial teal `#57b3ab`; the fresh-seed colour choice remains
unresolved and separately tracked in issue #1832. Site Style raw CSS is appended
to the public website stylesheet only. Authenticated/admin shells receive only
generated, validated brand/font variables, so raw CSS cannot override their
curated semantic status tokens.

Transactional and admin **emails** derive their brand palette from the same club
theme, so a colour change in `/admin/site-style` also restyles the emails
(header bar, accents, buttons, tables). Emails read the palette through a
process-level cache that refreshes at most every five minutes, so a theme change
propagates to newly sent emails within that window; a freshly started process (or
a database read failure) renders with the site default palette until the cache
warms. Emails render **hex** colours only: because email clients cannot render
`oklch()`, a Site Style colour saved as oklch falls back to the site-default hex
for that slot in email (a full oklch→hex conversion is a possible follow-up), so
emails never emit unrenderable oklch. Status colours in warning/success callouts
stay fixed.

The remaining public image assets are still file-based. Replace the default
assets in `public/branding/`:

- `favicon.ico`
- `favicon.png`
- `og-image.png`
- `lodge.jpg`
- `ski-field.jpg`
- `snowboarder.jpg`
- `sunset.jpg`

The matching `*.example.*` files are placeholders for forks and public docs.

Running the seed with `SEED_THEME_COMPLETE=1` marks site-style setup complete for
the **generic default** palette (stamping `completedAt` only — no colours, no
logo) so the public site renders its real header/footer/title chrome instead of
the "getting ready" holding page; E2E and staging use it. A deployment fork that
wants its own brand palette keeps that palette in its own `ClubTheme` database row
and provisions it from its own seed override — per standing directive D15, no
fork's brand colours (or a fork-specific seed path) live in this public repository.

## Website Page Content

Public website pages are database-backed (`PageContent`) and edited in
Admin > Page Content. The website header menu is generated from each page's
menu title and menu order; pages with an empty menu title stay out of the
menu.

- Seeding creates starter pages (`home`, `about`, `join`, `join/apply`,
  `rules`, `contact`, `committee`, `privacy`, `terms`, `faq`,
  `booking-requests`, `school-bookings`) only when they do not already exist, so
  re-running the seed never overwrites edited content. The two form pages seed an
  EMPTY menu title, so a fresh install keeps them unlisted until a club opts in
  (see "Booking-request and school-booking pages" below). The seeded copy is fully club-agnostic: the starter privacy policy,
  booking terms, and FAQ carry no club-specific lodge name or geography and
  instead resolve the installing club's own identity through the text tokens
  below (`{{club-name}}`, `{{lodge-name}}`, `{{lodge-capacity}}`). Each club
  edits the wording in Admin > Page Content.
- The home route (`/`) renders the `home` page record. `/contact`, `/join`,
  and `/join/apply` are code-backed routes that render their matching record;
  `/booking-requests` and `/school-bookings` are also code-backed routes (in the
  `(website-dynamic)` group, so they render per request and are never stored),
  each rendering its matching record around the booking form; all other records,
  including `/privacy`, `/terms`, and `/faq`, are served by the dynamic catch-all
  route.
- Admin-created pages can be hidden from the public site with the
  **Hide**/**Publish** toggle in Admin > Page Content (no permanent delete):
  hidden pages drop out of the menu and return a 404 on the catch-all route.
  System pages (`home`, `404`) and the built-in starter pages above cannot be
  hidden. For most of them that is because code routes, the footer, and the
  sitemap link to them; `booking-requests` and `school-bookings` are the
  exception — they are neither footer- nor sitemap-linked (they are unlisted and
  noindex until a club opts in), but they still cannot be hidden because their
  code routes would 404 without the record.
- Slugs use lowercase letters, numbers, and hyphens, with optional forward
  slashes between segments (`trip-reports`, `trips/2026`). Application
  route names (`admin`, `api`, `book`, `dashboard`, `login`, and similar)
  are reserved and rejected in every segment position.
- **Catch-all pages are cached whole (#2352).** Since slice 1 of #2352 the
  admin-authored pages served by the catch-all are built once and then handed to
  every visitor from a cache, instead of being rebuilt from scratch on every
  visit. What this means in practice:
  - **An edit appears immediately.** Saving in Admin > Page Content clears the
    cached copy, exactly as before. So do the Hide/Publish toggle, a theme or
    logo change, a site banner change, a module switch, a lodge capacity or
    bed-allocation change, and an Image Manager upload, delete or folder change.
    Every admin save that changes something a public page shows clears the cache.
  - **Anything that changes without a save takes at least five minutes, and then
    one more visit.** A site banner whose start time simply arrives is the usual
    example. Be precise about the timing, because "within five minutes" is not
    what happens: after five minutes the next visitor is still served the old
    copy and only triggers the rebuild, so the change shows from the visit AFTER
    that. On a quiet weekday that can be hours. Five minutes is the owner's
    decision (#2352 D3), taken so a busy site does not pay a background rebuild
    every minute; the previous behaviour was about fifteen seconds.
  - **The cached copy is the same for everyone.** No member name or other
    personal detail has ever appeared on these pages, and the "Log In" /
    "Dashboard" button corrects itself in the browser. If you are adding
    something to a public page, do not make it depend on who is looking.
  - **The cache is emptied by a restart and by every deploy**, so it never holds
    stale content across a release.
  - **Multi-tenant forks: read this.** The cache is keyed by web address with no
    club dimension. That is correct for this template, which runs one club per
    deployment. A fork that served several clubs from one process would serve
    club A's pages to club B.
  - **Some slugs are refused, and the list grew.** A content page may not start
    with a segment the application itself owns — `admin`, `api`, `login`,
    `register`, `pay`, `chores`, `calendar`, `notices`, `profile`, `bookings`,
    `lodge`, `finance`, `display` and the rest. Saving one now returns a clear
    error. Before #2352 a page like `/pay` could be created and would appear to
    work; under whole-page caching it would have been served with a security
    token that no longer matched, so nothing on it would run. If you have such a
    page from an earlier release it now answers "page not found" — rename it and
    the content comes back.
  - **Check for one after upgrading, because the page keeps its content and only
    loses its address.** A page in that position is no longer advertised anywhere
    — the site menu drops it, and a Book Now button pointing at it reverts to the
    normal booking flow — so nothing links to a dead address, but nothing tells
    you it is there either. Admin > Page Content still lists it with its address,
    and this query names them outright:

    ```sql
    SELECT slug, title, published FROM "PageContent"
    WHERE split_part(slug, '/', 1) IN (
      'admin', 'api', 'asset-not-found', 'book', 'bookings',
      'calendar', 'change-password', 'chores', 'confirm-email-change',
      'dashboard', 'display', 'family-invite', 'finance', 'forgot-password',
      'induction', 'lodge', 'lodge-instructions', 'login',
      'membership-cancellation', 'nominations', 'notices', 'pay', 'profile',
      'register', 'reset-password', 'verify-email'
    );
    ```

    The list is `NON_WEBSITE_ROOT_SEGMENTS` in
    `src/lib/public-website-paths.ts`; read it there if you are on a later
    release, because it grows whenever the application claims a new top-level
    address. Renaming the page in Admin > Page Content is the whole fix — the
    content, header and menu title come with it.

    **`booking-requests` and `school-bookings` are a different, tighter rule
    (#2818).** These two are built-in pages the club owns, so the bare
    `/booking-requests` and `/school-bookings` rows are legitimate and must NOT be
    renamed. But the two WORDS are reserved in every segment position — the
    application owns the one-time token links directly under them
    (`/booking-requests/verify/<token>`, `/school-bookings/confirm/<token>`) — so
    a content page that puts either word in ANY segment (`trips/booking-requests`,
    `booking-requests/archive`) is refused by the catch-all and, since this
    release, dropped from the menu and from any Book Now button. This query names
    such a page while leaving the two built-in rows alone:

    ```sql
    SELECT slug, title, published FROM "PageContent"
    WHERE ('booking-requests' = ANY (string_to_array(slug, '/'))
        OR 'school-bookings' = ANY (string_to_array(slug, '/')))
      AND slug NOT IN ('booking-requests', 'school-bookings');
    ```

    Rename any page it returns; the two built-in rows it deliberately excludes
    stay exactly as they are.

    Three more shapes are refused for the same reason, and the query above does
    not find them because they are not top-level segments:
    `hut-leader-instructions`, a ONE-level address under `join/`
    (`join/<group-code>`), and `join/verify/<token>` are real public pages of the
    application (lodge instructions for a hut leader, and the two group-join
    screens), so a content page at one of them could never have been served in any
    release. This query names one if it exists:

    ```sql
    SELECT slug, title, published FROM "PageContent"
    WHERE slug = 'hut-leader-instructions'
       OR (slug ~ '^join/[^/]+$' AND slug <> 'join/apply')
       OR slug ~ '^join/verify/[^/]+$';
    ```

    The bounds matter both ways, so do not widen the query to `slug LIKE 'join/%'`.
    `join/apply` is a valid code-backed starter page, and so is anything DEEPER than
    the shapes above — `join/2026/spring-camp` and `join/verify/notes/2026` are served
    normally, because the application's routes there are exactly two and three
    segments long and nothing claims a deeper address. A page one level deeper under
    a reserved NAME is fine for the same reason: `trips/hut-leader-instructions` is
    claimed by nothing and the catch-all serves it.
- Page HTML supports embed tokens that render interactive sections across
  PageContent-backed public routes, including code-backed starter routes.
  Supported tokens are `{{committee-members-cards}}`,
  `{{member-application-form}}`, `{{join-apply-form}}`, `{{contact-form}}`,
  `{{booking-requests}}`, `{{school-bookings}}`, `{{skifield-whakapapa}}`,
  `{{skifield-conditions:dataHash}}`, `{{photo-gallery}}`,
  `{{photo-gallery:path}}`, `{{photo-slideshow}}`, and `{{photo-slideshow:path}}`.
  `{{booking-requests}}` and `{{school-bookings}}` render the public booking-request
  and school-booking forms; they seed the `/booking-requests` and `/school-bookings`
  pages, but you can also drop either onto a page of your own. A page that carries
  one is served under that page's CSP nonce and analytics posture — the dedicated
  `/booking-requests` and `/school-bookings` pages are the canonical
  per-request-nonce, analytics-free entry points. Authoritative fee embeds are `{{hut-fees}}`,
  `{{joining-fees}}`, and `{{annual-fees}}` (with `{{entrance-fees}}` and
  `{{membership-types}}` retained as deprecated aliases of `{{joining-fees}}`
  and `{{annual-fees}}` respectively); the policy embeds are
  `{{booking-policy-summary}}` and `{{cancellation-policy}}`. Each defaults
  hidden until its family is enabled in Admin > Page Content — hut fees use the
  **Hut fees** toggle, joining fees the **Joining fees** toggle, and annual fees
  their own dedicated **Annual membership fees** double-opt-in (which also
  governs the `{{membership-types}}` alias); annual fees additionally require
  each type's public-listing flag. `{{hut-fees}}` renders a **table** per lodge
  × season — age tiers down the side, one nightly-rate column per publicly
  listed membership type that carries rates for that season, with
  identically-priced types collapsed into a single shared column headed by their
  names (#2129). Publicly listing at least two membership types is what makes
  the table worth publishing; the setup-readiness **Seasons And Rates** step
  warns when a season would show fewer than two columns. The fee embeds accept
  comma-separated parameters after a colon (`lodge=`, `type=`, `group-by=`, plus
  a bare lodge slug for `{{hut-fees}}` back-compat; `by-age` ≡ `group-by=age`;
  `{{annual-fees:components}}` shows the per-line breakdown); the policy embeds
  accept `:lodge-slug`. For `{{hut-fees}}`, `type=` filters the table to that
  one membership type's column, `group-by=type` splits a season into one table
  per column, and `group-by=age` transposes the table so membership types are
  the rows. An unknown key, unlisted `type=`, or inactive lodge slug
  renders no data rather than another group's or lodge's fallback. See
  `docs/PUBLIC_PAGE_CONTENT_TOKENS.md` for the full grammar. Legal and help-copy pages can also use text
  tokens `{{club-name}}`, `{{currency}}`, `{{lodge-capacity}}`,
  `{{lodge-capacity:lodge-slug}}` (a named lodge's capacity; unknown slug falls
  back to the default lodge), `{{lodge-name}}` / `{{lodge-name:lodge-slug}}`,
  `{{lodge-address}}` / `{{lodge-address:lodge-slug}}` (a lodge's name/address;
  empty address renders nothing), `{{hut-leader}}`, and `{{hut-leader-lower}}`, which
  are resolved server-side
  from the current club/runtime settings (`{{hut-leader}}` renders the
  configured hut-leader **role label**, default `Hut Leader` — the role name,
  never a specific person; who holds the role is managed under Admin > Hut
  Leaders. `{{hut-leader-lower}}` renders its lower-cased form for mid-sentence
  prose). The `dataHash`
  parameter is the Snow.nz widget hash. Photo token `path` parameters are
  normalised relative to
  `public/images/` and load images from that shared image-manager storage tree:
  a committed `public/images/` directory in a source checkout, or the mounted
  `public/images` volume in containerised deployments. Without a path, photo
  tokens use inline images already inserted in the page body. Photo tokens
  require double braces. Legacy single-brace syntax remains accepted only for
  non-photo tokens.
- Content and header HTML are sanitised on save and again on render. The
  allowlist lives in `src/lib/page-content-html.ts`. It includes native
  `<details>`/`<summary>` elements (plus the boolean `open` attribute on
  `<details>`), which the starter FAQ page uses for its collapsible
  question-and-answer accordion.
- The editor's image picker can insert images from three sources:
  database-backed image-library uploads, deployed branding files under
  `public/branding/`, and filesystem/image-manager files under the shared
  `public/images` tree. The root picker view combines the latest database
  uploads, branding images, and root-level filesystem images; choosing another
  Images folder shows filesystem images from that folder only.
- The picker Upload button stores one image at a time in the database-backed
  image library. Those images are served publicly from `/api/images/[id]`; the
  picker can delete those database records, while branding files are managed by
  deployment/repository asset updates and filesystem images are managed through
  Admin > Image Manager.
- Database-backed image-library uploads accept PNG, JPEG, GIF, WebP, AVIF, and
  SVG files up to 2MB. The server validates the stored content type from the
  file bytes rather than trusting the browser-declared type or filename. SVG is
  allowed only through the `/api/images/[id]` serving route, which adds
  `Content-Security-Policy` and `X-Content-Type-Options: nosniff` response
  headers.
- Admin > Image Manager uploads filesystem images into the shared
  `public/images` tree/volume and serves them from `/api/images/uploaded/...`.
  Those uploads accept PNG, JPEG, GIF, WebP, and AVIF files up to 10MB per file.
  A single upload batch is capped at 25 files and an 80MB total request body; a
  batch that exceeds either cap is rejected (`413`) with an actionable message
  naming the limit that was hit ("at most 25 files" vs "keep each batch under
  80MB — split the upload"). SVG is intentionally rejected there because
  filesystem uploads are served as static image assets without the database image
  route's restrictive CSP.
- All multipart upload routes (member photos, the image library, the image
  manager, and configuration-bundle imports) read the request body through a
  shared **streamed, capped reader** (`src/lib/capped-multipart.ts`, #2235)
  rather than buffering the whole body first. An oversize body — including a
  chunked request with no `Content-Length` or a spoofed-small one — is cut off
  mid-stream and rejected (`413`) before it can exhaust memory, and each route's
  per-file byte cap is enforced incrementally as an **inclusive** maximum (a file
  of exactly the cap is accepted; only one byte over is rejected). The
  **guaranteed backstop** is
  still the reverse-proxy / platform request-body limit: the repo's `Caddyfile`
  and `Caddyfile.staging` set `request_body { max_size 100MB }`, comfortably
  above the largest in-app cap, so an oversize body is dropped at the edge
  before it reaches the app. Deployments not fronted by Caddy must set the
  equivalent (Nginx `client_max_body_size`, or the host platform limit). See
  `docs/SECURITY-ATTACK-SURFACE.md` for the full threat model.

### Configurable "Book Now" button

The public website header's **Book Now** button is configured on the same
Admin > Page Content panel (`PublicContentSettings`):

- **Show the button** — off hides it entirely (desktop and mobile). **Off
  everywhere since #2430.** A fresh install ships with it off (the column
  default), and `20260802100000_public_book_now_default_off` also switched it
  off for **every existing club**, whether or not the club had chosen to show
  it — the owner's decision (1 Aug 2026), which deliberately overrode saved
  choices rather than only changing what new installs get. A club that wants
  the button turns it back on in one click: **Admin → Setup & Configuration →
  Site Appearance & Content → Page Content** → tick **Show the Book Now
  button** → **Save visibility**. From that save on, the stored value is what
  governs and nothing in the product moves it again. (A database error while
  reading the row still falls back to showing the button — see the fail-open
  contract below.)
- **Target** — *booking flow* (the default: a logged-in member goes to `/book`,
  a guest is sent through login) or a chosen **published content page**.
- A page target that becomes unpublished or is deleted **fails open** to the
  booking flow, so the button is never dead. Since #2352 slice 1 so does a target
  whose address is now reserved (see "Some slugs are refused, and the list grew"
  above) — the page is published but no longer served, so the button goes back to
  the booking flow rather than pointing at a 404. So does a database error reading
  the settings row: `getBookNowVariants`'s catch shows the button (#1929's
  contract, deliberately unchanged by #2430 — the no-row branch fails closed
  because that is a club's absent choice, whereas an outage is not). The
  authenticated dashboard's own Book Now action is unaffected — a signed-in
  member can always book.
- **The label follows the visitor, not the target** (#2430). A signed-out
  visitor sees **Member booking**, because booking here is for members: with the
  booking-flow target the button sends them to the member login, and with a page
  target it sends them to a content page — neither is a booking they can make.
  A signed-in member sees **Book Now**. Both surfaces (desktop header and mobile
  drawer) take both labels from one `getBookNowVariants` read, so they cannot
  disagree. Since #2352 the choice between them is made in the browser, from the
  sign-in marker cookie, because the public pages are one stored copy served to
  everyone — a member may see the signed-out label for a moment before it
  corrects itself. The label is not configurable, and it does not change when you
  change the target.

## Website Site Content

Shared public website chrome is database-backed (`SiteContent`) and edited in
Admin > Site Content. This is separate from `PageContent`: page records still
own per-page header/body content and menu entries, while site content owns
reusable layout fragments that are not routable pages.

- The first site-content sections are the three public footer columns:
  `FOOTER_BLURB`, `FOOTER_QUICK_LINKS`, and `FOOTER_AFFILIATIONS`.
- The public footer keeps the logo, current year, copyright line, and
  privacy/terms links code-managed. Admins can edit or clear the three column
  HTML fragments; clearing either link column hides that column.
- `20260702124500_add_site_content` backfills starter footer rows with the
  previous hardcoded footer copy, so deploy-only environments keep the same
  footer without running the seed. The seed also creates the starter rows when
  missing and never overwrites existing admin edits.
- **`FOOTER_AFFILIATIONS` is empty on a fresh install (#2490).** A club's
  affiliations are facts about that club, so this project ships none and the
  footer hides the column until an admin adds the club's own. The original
  backfill planted a list naming the Ruapehu Mountain Clubs Association, which
  every install then published on every public page;
  `20260802140000_clear_starter_footer_affiliations` clears that value from any
  database that still holds it byte for byte, leaving an edited column alone.
  `src/lib/__tests__/seed-account-defaults.test.ts` now runs the
  founding-club geography guard over `starterSiteContent` as well as
  `starterPageContent` and the seeded chore templates.
- Footer section HTML is sanitised on save and again on render with the same
  allowlist as page content (`src/lib/page-content-html.ts`). Footer text
  tokens include `{{club-name}}`, `{{currency}}`, `{{lodge-capacity}}`,
  `{{lodge-capacity:lodge-slug}}`, and `{{facebook-url}}`; embed tokens are not
  supported in footer sections.
- URL-bearing tokens are scheme-validated when they resolve: `{{facebook-url}}`
  only renders http, https, or mailto values. Anything else is replaced with
  the configured `publicUrl` (or `#`) and logged as a server warning.

## Website Site Banners

Admin > Site Banners manages site-wide notification banners stored as
`SiteBanner` records. Banners are plain text only and render above the public
website, public-auth, and signed-in member headers while active and while the
current New Zealand date-only value falls inside the inclusive display window.

- Priorities are `URGENT`, `WARNING`, and `NOTIFY`, displayed with faded red,
  amber, and blue styling respectively.
- Admins can create, edit, activate/deactivate, and delete banners. The admin
  page groups banners into current, upcoming, and the 50 most recent past
  banners by their date-only display windows.
- Visitors can dismiss a banner per browser. Dismissal is stored in
  localStorage and is invalidated when an admin edits the banner, so updated
  wording is shown again.
- Banner create/update/delete actions write structured audit logs. Messages are
  rendered as escaped plain text; HTML and tokens are not supported.

## Lodge Instructions

Lodge opening, closing, and day-to-day instructions for hut leaders are
database-backed (`LodgeInstruction`, one row per document) and edited in
Admin > Lodge Instructions. They are protected content, deliberately separate
from `PageContent`: they never appear in the public menu or the dynamic
public page route.

- Readers: admins, plus members with a current or upcoming hut leader
  assignment, at `/lodge-instructions` (printable). The lodge kiosk shows
  the documents to the signed-in hut leader tier.
- HTML is sanitised on save and again on render with the same allowlist as
  page content (`src/lib/page-content-html.ts`).
- Text tokens `{{club-name}}`, `{{currency}}`, `{{lodge-capacity}}`,
  `{{lodge-capacity:lodge-slug}}`, `{{hut-leader}}`, and `{{hut-leader-lower}}` are
  resolved on the reader and kiosk surfaces (embed tokens are not supported here). The admin editor shows
  the literal tokens; the editor's token help button lists what is available.
- The migration backfills the three empty documents, so deploy-only
  environments get editable rows without running the seed.

## Lodge Settings

Admin > Setup includes lodge-wide settings stored in the singleton
`LodgeSettings` row:

- Capacity: optional per-lodge maximum sleeping capacity. Leave blank to use the
  active bed count (Bed Allocation on) or the club-config bed total. When set
  alongside configured beds it acts as a ceiling — the lower of the capacity and
  the active bed count applies (`docs/CAPACITY_MODEL.md`).
- Hut-leader lookahead: defaults to 14 days and controls how far ahead
  unassigned hut-leader dates are reported on the admin dashboard, stuck-state
  dashboard, the hut-leader assignment API, and the queue-driven Needs
  Attention sidebar item.

For a club that runs more than one lodge, each lodge gets its own
`LodgeSettings` row (capacity override, school-group soft cap); the hut-leader
lookahead stays a single club-wide value. See "Adding a Second Lodge" below.

## Adding a Second Lodge

A club can run more than one lodge property under one membership, one finance
backend, and one admin. The lodge data model is always present, but a
single-lodge club never sees it. This section walks an admin through turning
on and setting up a second lodge. Design rationale lives in
`docs/multi-lodge/` (start with `feature-overview.md`); this is the operator
how-to.

### 1. Open the Lodges page

Multi-lodge is **core** — there is no module to enable (ADR-005). Admin >
**Lodges** is always available; every club starts with one seeded lodge and
adds more with **Add lodge** as needed. Adding a lodge does **not** by itself
change anything members see — member-facing screens only gain a lodge dimension
once a *second active lodge actually exists*.

### 2. Create the lodge

On the Lodges page, create the new lodge: name, and optionally its address, door
code, and travel note (the door code and travel note are used in that lodge's
confirmation and pre-arrival emails; the name and address are also public — the
contact page and the `{{lodge-name}}` / `{{lodge-address}}` content tokens read
them). The club's original lodge already exists as the seeded default lodge. For
a single-lodge club, the same fields are editable under **Admin > Club Identity >
Lodge details** without opening the multi-lodge management UI.

### 3. Run the setup wizard

Creating a lodge lands in a guided setup wizard (`/admin/lodges/[id]/setup`):
identity → rooms/beds → lockers → seasons/rates → chores. Every step is
skippable, and rooms/beds/lockers support bulk seeding ("8 rooms of 4 beds",
"N lockers" with a name prefix) plus copy-from-another-lodge for seasons/rates
and chores. The lodge configuration hub (`/admin/lodges/[id]`) is the
"what does this lodge still need?" view and links into each editor pre-filtered
to that lodge. Wizard and hub cards for module-gated areas (bed allocation,
lockers, chores) appear only when that module is enabled.

### 4. Capacity and the 0-capacity fail-safe (read this first)

**A newly created lodge is unbookable until you give it beds or a capacity
override.** This is deliberate, and it will look like a bug the first time:
a lodge with no configured beds and no override resolves to **capacity 0**, so
the booking flow refuses all bookings at it rather than risk overbooking an
unconfigured lodge.

Each lodge's capacity resolves in this order (`getLodgeCapacityStatus`):

1. Active configured beds, when the Bed Allocation module is on and the lodge
   has active beds.
2. Otherwise, the per-lodge **capacity override** on the lodge's
   `LodgeSettings` (set it on the lodge hub or Admin > Setup). This works even
   with Bed Allocation off.
3. Otherwise, the club-config bed total — but **only for the original default
   lodge**. Any *additional* lodge falls through to 0.

So to make a new lodge bookable, either configure its beds (Bed Allocation
module) or set its capacity override. Until then it correctly shows as
unavailable.

Per-lodge overrides *replace*, they do not merge: setting a lodge's capacity
override does not add to the club-config total, it substitutes for it at that
lodge.

### 5. Bind the kiosk account to the lodge

Each lodge's shared kiosk device signs in with a lodge-operational (kiosk)
account bound to that lodge. On the **Lodge Kiosk** admin page (`/admin/lodge`)
you can see every kiosk account with its bound lodge, create an additional
kiosk account bound to the new lodge in one step, and rebind or unbind existing
accounts (an unbound account falls back to the default lodge). The kiosk shows
only its bound lodge's arrivals, departures, and roster, and its header names
the lodge it is operating. Binding is a `STAFF` grant in `MemberLodgeAccess`;
you can also manage a member's STAFF grants from their member page.

### 6. Per-lodge hut-leader PINs

A hut-leader assignment belongs to one lodge. A hut leader's PIN works only at
that lodge's kiosk and surfaces only that lodge's roster, chore sign-off, and
guest lists — it does nothing at another lodge's kiosk. Assign hut leaders per
lodge in Admin > Hut leaders; each assignment carries its lodge, and PIN
matching is scoped to the kiosk's bound lodge.

### 7. Per-lodge policy overrides ("replace, not merge")

Cancellation, minimum-stay, and booking-period rules are **club-wide by
default**. Most clubs never need per-lodge rules. When a lodge does need its
own (for example a remote lodge with a longer cancellation window), you set
that lodge's own rules on the policy pages via the per-lodge override path.

The key semantic: a lodge's own rules **replace** the club-wide set for that
policy type — they are not merged with it. If you give Lodge B a cancellation
tier set, Lodge B uses *only* those tiers; it does not also inherit the
club-wide tiers. Lodges with no override keep using the club-wide rules. The
booking flow shows a member the rules for the lodge they booked. Lodge
opening/closing/day-to-day kiosk instructions follow the same replace-not-merge
rule per document.

Each minimum-stay row also carries an explicit exception-capacity mode and a
revision. `HOLD` means a later exception-review request will reserve the
requested capacity while it waits; `NO_HOLD` means capacity is not reserved
until approval. Existing rows migrate to `HOLD`, and every new admin/API write
must choose one. The revision is an optimistic concurrency token: update,
activate/deactivate, and delete writes that present an older version are refused
and the admin reloads the current row instead of overwriting it.

Minimum-stay policies are the one destructive config-transfer category. The
bundle file `booking-policies/minimum-stay.csv` is a complete club-wide and
lodge-scoped set, not a patch: omitted target rows appear as **Deleted** in the
dry-run and are removed on Apply, while a valid header-only file explicitly
clears the set. Malformed or missing headers block Apply. Import takes the
config-transfer lock and then the minimum-stay policy-set lock, re-plans inside
the transaction, and relies on the automatic pre-apply database backup for
rollback. Ordinary config-transfer categories remain non-deleting.

**Adult-member hosting (#2364, #2569, #2576).** A club may require every
non-member guest-night to overlap an eligible adult member. The policy has two
independent dimensions: the consequence (**Disabled**, **Send to admin review**,
or **Enforce the rule**) and the permitted host scopes (**Same booking** and/or
**Another booking owned by the same member** at the same lodge on the same
night). Ownership alone never counts as attendance, and an unrelated member,
shared email, or Family Group link never supplies cover. Each lodge may inherit
or override each dimension independently; the built-in default is disabled with
same-booking-only scope, preserving pre-upgrade behaviour.

Review mode allows the booking and opens officer work. Enforced mode rolls back
a non-compliant member write and offers the signed-in exception-request journey;
school and organisation approvals remain review-only. An admin booking on
someone else's behalf may record an explicit reason as an attributable approval.
Accepted bookings that later lose same-owner cover remain accepted but open an
urgent incident, which resolves automatically when cover returns. Like
minimum-stay rows, the policy carries an explicit exception-capacity mode — there
is no automatic default, so the first save must state one — and a revision that
refuses a stale write. It travels in the destructive `booking-policies` category
as `booking-policies/adult-member-hosting.csv`; a configuration scope omitted
from that replace-set file is deleted back to inherited or built-in behaviour.

### 8. Eligibility restrictions and cross-lodge waitlist

- **Eligibility is default-open.** Every active member can book every active
  lodge unless you configure a restriction. On a member's page you can add a
  booking restriction limiting them to specific lodges; a restricted member
  simply never sees the other lodges offered. Admin bookings made on behalf of
  a member deliberately bypass the restriction (the audited override path).
- **Promo codes** are club-wide by default; each promo can optionally be
  restricted to selected lodges. An unrestricted promo works at every lodge,
  including lodges created later.
- **Cross-lodge waitlist (ADR-004).** When a member waitlists a full lodge,
  they can opt in to alternate lodges they would also accept. When a bed frees,
  the processor may offer an opted-in alternate. The queue order is a single
  club-wide setting on the booking-policies page,
  `BookingDefaults.waitlistCrossLodgeOrder`:
  - `OWN_LODGE_FIRST` (default): the freeing lodge's own queue is served first
    in join order, then cross-lodge opt-ins, so no one is overtaken in a queue
    they joined.
  - `MERGED`: everyone who could be satisfied at that lodge — its own queue
    plus opt-ins — is ranked purely by join time.
  A cross-lodge offer states the alternate lodge and its price and requires the
  member to confirm; accepting creates a fresh booking at that lodge rather
  than moving the original. (Waitlist entries carrying a promo redemption are
  not offered cross-lodge — a documented limitation.)

Every one of these follows the single-lodge presentation rule: with only one
active lodge, none of the selectors, columns, or lodge names appear, and the
club behaves exactly as it does today.

## Book on Behalf

Book on Behalf (`/admin/book`) lets a Booking Officer (anyone with the
**bookings:edit** permission — no membership permission required) create a
booking for someone other than themselves. The owner can be either an existing
member (search the MemberPicker) or a **non-member**.

**Non-member bookings.** Choose "Non-member booking" beside the member search
and enter the guest's first/last name, email and phone. The system creates a
lightweight, **non-login** contact — exactly the kind of record an approved
public booking request already creates — and the booking then proceeds at
non-member rates through the normal dates → guests → quote → confirm flow.

- The record is always `NON_MEMBER`, can never sign in, is created with its
  email **unverified** (an officer-typed address is not a verified one), and is
  billed identically to a public booking-request non-member.
- The endpoint is `POST /api/admin/bookings/non-member-contact`, gated on
  **bookings:edit** (the same scope as the rest of Book on Behalf).

**Reuse instead of duplicating (suggest-and-pick).** As you type an email or
name, existing non-login contacts are suggested so a repeat guest is reused
rather than duplicated. Reuse is always an explicit pick ("Use existing") — the
system never silently attaches a booking to an existing contact by email,
because several walk-in contacts can legitimately share one email. If the email
belongs to a **real member who can sign in**, creation is blocked with a pointer
to search for them in the member picker instead. (Duplicate non-member contacts
that do accumulate over time are cleaned up with the member-merge tool (#1937).)

**Walk-ins with no email.** Tick "No email address" for a phone/walk-in guest.
The contact is stored with a club-internal placeholder address, and that owner
is **never emailed** (no booking confirmation, no hold email) and the
placeholder is **never shared with Xero** as a real address.

**Notifying the owner.** On confirm you choose whether the owner is emailed the
standard confirmation/hold email; for a non-member owner this defaults to *not*
emailing. A no-email (walk-in) owner is never emailed regardless of the choice.
An Internet Banking (Xero) invoice email, when applicable, is still sent.
## Hut Leaders

A hut-leader assignment (`/admin/hut-leaders`) is a date-ranged roster record
that issues a dedicated lodge kiosk PIN for the assigned member (the plaintext
PIN is shown only once, when it is issued or reset) — it is not a role or
access-role capability. Assignment is admin-controlled; completing a Hut Leader
Induction only sets `Member.hutLeaderEligible` and never creates or dates an
assignment.

The New Assignment form has two member tabs. **Staying** is booking-derived: it
lists adult members who hold the standard member (`USER`) access role and have
an operational booking overlapping the selected dates. **Any member** searches
every eligible member, so a season-long custodian with no booking of their own
is assigned from there. The create API still rejects any member who lacks the
`USER` role, so keep that role ticked on the custodian's account — a member
whose only roles are custom (definition-backed) roles cannot be assigned.

### Holding a bed for a custodian

An assignment can optionally **hold one bed** for its whole date range. That
turns it into a *custodian occupancy*: for the night of every covered date the
bed leaves the bookable pool and the allocation board, with **no booking
anywhere**. The custodian is not a guest — they never appear on the chore
roster, never count as a booking, and are never invoiced for the held bed.

- Pick the bed in the **Hold a bed (optional)** step of the New Assignment form.
  The default is **No bed — role only**, which behaves exactly as an assignment
  always has and changes no capacity at all.
- The hold covers `startDate` to `endDate` **inclusive** — including the night
  of the end date itself. The bed is bookable again for the following night.
- Members see one fewer bed on the availability calendar for those nights and
  nothing else: there is deliberately no custodian-specific label on any
  member-facing surface.
- The lodge screen shows a **Custodian** line in its footer while the
  assignment is running. A minor-age custodian is never named there, at any
  name-display setting.
- Beds and rooms cannot be deactivated or deleted while a custodian holds them,
  and no guest can be allocated onto a held bed-night.

This replaces the earlier free-promo-code workaround, which existed only to give
a bookingless custodian a booking. Do not create a 100%-off booking for a
custodian any more — it inflates the utilisation reports and puts them on the
chore roster.

## Required Local Setup Variables

These are enough for a local database-backed app with external services left in
test/demo mode or disabled:

| Variable                | Description                                                      |
| ----------------------- | ---------------------------------------------------------------- |
| `APP_ENVIRONMENT_ROLE`  | **Required.** Whether this installation is the club's live site or a copy: exactly `production` or `non-production`. Nothing is inferred; see "Environment Role" below and [`docs/guides/environment-role.md`](docs/guides/environment-role.md). |
| `DATABASE_URL`          | PostgreSQL connection string used by Prisma.                     |
| `DB_PASSWORD`           | PostgreSQL password used by Docker Compose.                      |
| `AUTH_SECRET`           | Auth.js session secret. Also the root of 2FA-secret and in-app provider-credential encryption (#2079) — use a strong value (>= 32 chars); rotating it is a planned maintenance event (see `DEPLOYMENT.md`). |
| `NEXTAUTH_SECRET`       | Legacy Auth.js secret fallback; keep aligned with `AUTH_SECRET`. |
| `NEXTAUTH_URL`          | Exact app origin, for example `http://localhost:3000`.           |
| `AUTH_TRUST_HOST`       | Set `true` behind trusted proxies/Compose.                       |
| `CRON_SECRET`           | Shared secret for cron and deploy status endpoints.              |
| `SEED_ADMIN_EMAIL`      | Email for the first seeded admin account.                        |
| `SEED_ADMIN_PASSWORD`   | Initial password for the first seeded admin account.             |
| `SEED_ADMIN_FIRST_NAME` | Optional first name for the seeded admin; defaults to `Admin`.   |
| `SEED_ADMIN_LAST_NAME`  | Optional last name for the seeded admin; defaults to `User`.     |
| `SEED_LODGE_PASSWORD`   | Initial password for the seeded shared lodge kiosk account.      |
| `ALLOW_DEMO_SEED`       | Local-only opt-in; must be `1` for `npm run db:seed:demo`.       |
| `DEMO_SEED_PASSWORD`    | Optional local-only password for `npm run db:seed:demo` users.   |
| `DEMO_SECOND_LODGE`     | Local-only; set to `1` to also seed a second demo lodge (rooms + a few bookings) so two-lodge flows are demoable. Default demo dataset is unchanged when unset. |

`prisma/seed.ts` fails before seeding if `SEED_ADMIN_EMAIL` or
`SEED_ADMIN_PASSWORD` is unset, and fails before creating the lodge kiosk
account if `SEED_LODGE_PASSWORD` is unset. The seeded admin is created with
`role: ADMIN`, `canLogin: true`, `emailVerified: true`, and a `NOT_REQUIRED`
membership subscription for the current season, and is forced through
`/change-password` on first login. The seed also writes the normalized
`MemberAccessRole.ADMIN` row for the seeded admin and
`MemberAccessRole.LODGE` row for the seeded lodge kiosk account. Re-running
the seed repairs those missing normalized access-role rows without overwriting
the existing accounts. The seed only creates the admin when no `ADMIN` member
exists yet, so changing `SEED_ADMIN_*` later has no effect on an existing
database.

The whole seed is create-if-missing: re-running it against a populated
database never deletes, overwrites, or duplicates data. Committee entries and
chore templates are seeded as generic placeholders only when their tables are
empty; replace them through the admin screens after first login.

The seed also creates built-in seasonal membership types: Full, Associate,
Life, School, Non-Member, and Family. Associate is the built-in
Associate/Reserve-style type and can be renamed by the club. It backfills the
current membership season from current and historical role values (`USER`,
historical `MEMBER`, `ADMIN`, and `LODGE` to Full, historical `ASSOCIATE` and
legacy `RESERVE` to Associate, historical `LIFE` to Life, `SCHOOL` to School,
and `NON_MEMBER` to Non-Member) using create-if-missing assignments. Re-running
the seed does not overwrite existing seasonal assignments.

`npm run db:seed:demo` is separate from the first-run seed. It is intended only
for disposable local demo databases and must never be run on a deployment host.
It requires `ALLOW_DEMO_SEED=1`, refuses `NODE_ENV=production`, refuses
non-local `DATABASE_URL` hosts, and refuses to run when the `Member` table
contains any email outside `demo.alpineclub.test`. The demo seed then deletes
demo plus transactional rows before rebuilding a broad sample dataset. The demo
seed uses fake emails under `demo.alpineclub.test` and fake provider
identifiers only. Set `DEMO_SEED_PASSWORD` to override the default local demo
password.

## Setup Readiness

Run this before bootstrapping a new install:

```bash
npm run setup:check
```

The check validates environment variable presence/format, module capability
flags, and first-install readiness. It reads club configuration **DB-first**: it
attempts a database snapshot and reports the club-config, age-tier, admin,
booking, and integration steps from real database state. When the database is
reachable, an absent `config/club.json` is normal — the club-config step is
satisfied by the persisted identity (`ClubIdentitySettings` /
`EmailMessageSetting`), not by a file. A **malformed** primary `config/club.json`
still surfaces loudly as **blocked**. When the database is not reachable
(pre-migration), the DB-backed steps are reported as "not checked" and the
club-config step is a warning that points at `/admin/setup` rather than a hard
block.

After signing in as an administrator, open `/admin/setup` to review:

- readiness KPIs, blockers, setup hub cards, club config, and module controls
- first admin and seeded database settings
- booking policies, membership cancellation settings, age tiers, seasons, and rates
- Stripe, SES/email, Sentry, operational Xero, and finance-dashboard readiness
- Xero account and item-code mappings from the `/admin/setup/finance` drill-down

Provider tests on `/admin/setup` run only when an admin clicks the relevant test
button. They should use test/demo provider credentials until the environment is
ready for production.

## Membership Cancellation Settings

Membership cancellation setup is stored in database settings, not environment
variables. `/admin/setup` exposes:

- cancellation warning text shown by future member-facing request flows
- rejoin-process text for cancelled members
- operational Xero contact groups that represent cancelled members
- whether approved cancellation processing should archive the Xero contact

These settings are audited when saved. They do not call Xero on save; future
approval processing must keep Xero writes outside long database transactions.

While **archive the Xero contact** is on, a cancellation approval is refused
whenever the member's Xero contact still has an open invoice or bill with an
amount due — and refused too when Xero cannot be asked (disconnected, rate
limited, unreachable, or refusing the request), because an unknown answer is not
a clean one. Every one of those refusals names this setting as the way out, and
turning it off removes the archive and with it the check. Because the archive
itself runs later on the Xero outbox, it re-checks immediately before it
archives and defers if the answer has changed. See
[`docs/CANCELLATIONS.md`](docs/CANCELLATIONS.md#unpaid-invoices-block-approval).

## Member Deletion Requests Page

`/admin/deletion-requests` surfaces two distinct member-deletion flows in one
place:

- **Member self-service requests** — a member asks for their own account to be
  deleted (anonymised). Approval anonymises the account, cancels future
  bookings, and deactivates login. Backed by the `DeletionRequest` model.
- **Admin-initiated deletion requests** — an admin raises a permanent
  hard-delete of a member record added in error (no meaningful booking,
  financial, lodge, Xero, or audit history). Backed by
  `MemberLifecycleActionRequest` with `action = DELETE`.

Admin-initiated requests enforce **separation of duties**: a *different* admin
must approve or reject the request. The requester sees the approve/reject
buttons disabled with "A different admin must review this request"; the server
review endpoint stays authoritative and returns 403 on self-review regardless
of the UI. Both flows contribute to the sidebar's "Deletion Requests" attention
badge (self-service `PENDING` + admin-initiated `REQUESTED`).

The admin-initiated alert email (`admin-member-delete-requested`) deep-links to
this review queue. It is delivered under its own dedicated **Member delete
requests** notification preference (`adminMemberDeleteRequest`), kept separate
from the shared **Member requests** category (`adminFamilyGroupRequest`, which
covers membership applications, family-group, cancellation, and archive
requests). This preference is additive and defaults **on**, so existing rows
keep delete-request alerts enabled; muting the shared member-requests category
no longer also silences delete-request review alerts.

## Membership Type Settings

Seasonal membership type settings are database-backed and managed from
`/admin/membership-types`. Access roles, seasonal membership type, age tier,
Xero contact-group rules, and committee assignment are separate axes:

- `MemberAccessRole` is the normalized access source for login permissions.
  Rows carry the legacy enum value (`USER`, `ADMIN`, `ADMIN_READONLY`,
  `ADMIN_BOOKINGS`, `ADMIN_MEMBERSHIP`, `ADMIN_CONTENT`, `LODGE`,
  `FINANCE_USER`, `FINANCE_ADMIN`, `ORG`) and/or a link to a club-editable
  `AccessRoleDefinition` (managed at `/admin/access-roles`, Full Admin only).
  Runtime authorization must read these rows (with the definition joined)
  only. `ADMIN` is the protected full-admin bundle and is never editable;
  the six seeded defaults — read-only admin, booking officer, membership
  officer, content manager, finance viewer, and treasurer — are definition
  rows that can be renamed, re-permissioned, or deleted, and new custom roles
  can be created. Multiple rows may be combined for a custom mix; finance
  portal access derives from the merged finance area level.
  `session.user.role` is kept only for display and older serialized shapes.
  `Member.role` remains a compatibility/classification field with only
  `USER`, `ADMIN`, `LODGE`, `NON_MEMBER`, and `SCHOOL`; Associate, Life, and
  club-created categories live in `MembershipType`. `financeAccessLevel`
  remains synchronized for compatibility/export visibility, but does not grant
  runtime finance access.
- Access is resolved per area (Overview, Bookings, Membership, Finance, Lodge,
  Content, Support & System) at one of three levels — none, view, or edit —
  and multiple roles merge to the highest level per area. **View grants
  read-only access; edit is required to change anything.** The admin screens
  honour this in the UI as well as on the server: a **content:view** admin
  (for example a Read-only Admin, whose roles merge to `content:view`) opens
  the content editors — Page Content, Site Content, Site Banners, Site Style,
  Image Manager, and Mountain Conditions — as **read-only**, with disabled
  editors and a "view only" notice instead of a working Save button; only a
  **content:edit** admin can save. Lodge Instructions gate the same way on the
  **Lodge** area. The matching route handlers require `content` (or `lodge`)
  `view` on reads and `edit` on writes, so a stale-tab save is rejected with a
  visible error even if the editors were still on screen.
  The same read-only pattern extends to the settings/config editors in the other
  areas (#1940), each gating on its own area: **Membership** — Nomination gate
  (Induction Settings), Induction checklist templates, and Membership
  Cancellation settings; **Support & System** — Email Settings/Templates and
  Booking Messages; **Finance** — Finance Report Mappings; **Bookings** — the
  Rooms & Beds manager (its writes hit the bed-allocation APIs, which enforce
  `bookings:edit`, even though the page lives under Lodge Operations). A viewer
  sees disabled inputs, a "view only" notice, and, on a stale-tab 403 save, a
  persistent forbidden-save error. Message/template **Preview** actions are pure
  renders and stay available to viewers.
- `MembershipType` stores admin-configurable seasonal categories and policy:
  Full, Associate (renameable, including Reserve naming), Life, School,
  Non-Member, Family, or club-created types. The `/admin/membership-types`
  page shows these as a compact ordered list; creating or editing a type opens
  a dedicated editor for identity fields, booking behavior (`MEMBER_RATE`,
  `NON_MEMBER_RATE`, `BLOCK_BOOKING`), subscription behavior (`REQUIRED`,
  `NOT_REQUIRED`), and allowed age tiers. New types default to the four age
  tiers (Infant/Child/Youth/Adult); the explicit **N/A (no age)**
  (`NOT_APPLICABLE`) tier makes a type *age-exempt* — ticked **alone** every
  member on the type becomes N/A (like an organisation); ticked **alongside**
  person tiers admins may hand-pick N/A per member. Age-exempt config (N/A ticked
  in either shape) is only valid when subscription behavior is `NOT_REQUIRED`
  (N/A must never bypass subscription lockout), and an edit that turns N/A-only
  on or off is blocked while incompatible current/future-season members exist. At
  least one tier must always be selected. Xero contact-group rules are no longer
  edited here — they live on the single **Xero member grouping** surface (see
  below). Display names must be unique: creating or renaming a type to a
  case-insensitive exact match of an existing name is rejected.
- `AgeTierSetting` remains separate because a member can be Adult Full, Adult
  Life, Adult Associate, Child Family, Youth School, and so on. Age tiers still
  drive age-based rates. Xero grouping by age tier is now configured on the
  **Xero member grouping** surface (see below), not on the age-tier settings
  page.
- `SeasonalMembershipAssignment` records one membership type per member per
  membership `seasonYear`, including the assignment source (`ADMIN`, `IMPORT`,
  `FAMILY_SUBSCRIPTION`, `ROLL_FORWARD`, or `SYSTEM`) and an optional
  date-only `applyFrom` changeover for mid-season moves between membership
  types.
- Admin member detail pages show access roles separately from seasonal
  membership type. The Admin > Members list also shows the current seasonal
  Membership Type beside Access. Changing the seasonal type requires a preview
  and admin reason; the preview counts future confirmed bookings, drafts,
  waitlist records, and subscription history before the save is audited.
  Existing future bookings are not automatically repriced by changing the type
  or `applyFrom` date. Production preview tokens require `AUTH_SECRET` or
  `NEXTAUTH_SECRET`; setup readiness blocks when neither secret is configured.
- `/admin/membership-types` includes a separate idempotent roll-forward section
  that previews and then copies missing assignments from one season to another
  while leaving existing target assignments unchanged and flagging missing or
  inactive-type exceptions.
- Committee assignment remains public/contact metadata and does not grant app
  access.

## Xero member grouping

How (or whether) members are auto-sorted into Xero contact groups is a single
club-level setting, managed on the dedicated **Xero member grouping** admin
surface (finance area). One mode plus one rule table replaces the old age-tier
group fields and the membership-type Xero rules.

- **Mode** (`XeroGroupingSettings` singleton):

  | Mode | Behaviour |
  |---|---|
  | `None` | The sync is a total no-op. Existing Xero group memberships are left untouched — never added, never removed — including on the membership-cancellation path. |
  | `Membership Type` | Only type-keyed rules apply. Tier-bearing rules (a non-empty `ageTiers` set) are inert (shown but not applied). |
  | `Membership Type + Age` | Most-specific `MANAGED` match wins: `type + tiers` > `type-only` > `tiers-only`; among tiered rules **fewer tiers is more specific**, and an "all age tiers" (`[]`) rule is the **least** specific. Exact ties break deterministically by `sortOrder` then group id. `ACCEPTED` groups are the union of matching accepted rules plus the matched managed group. |

- **Rules** (`XeroContactGroupRule`): each rule is a (membership type?, **age
  tier set**, `MANAGED`/`ACCEPTED`, group) tuple. The tier set (`ageTiers`) may
  name any subset of tiers; an **empty set means "all age tiers"** (the wildcard,
  displayed "All age tiers") — this is the migrated null "Any age" semantics.
  Sets are stored canonical-sorted and a full-tier selection collapses to the
  empty set, so `[ADULT, YOUTH] == [YOUTH, ADULT]` is one shape. `MANAGED` is the
  group the sync adds; `ACCEPTED` is a group the sync tolerates and never removes.
  Duplicate rule shapes are rejected (app-side for a friendly error and by a DB
  partial unique index over the canonical array). The effective membership type
  is resolved at the current season year (the same resolver as pricing, but
  pricing resolves per stay-night season and grouping resolves at "now").
- **Managed universe / never delete:** the sync only ever adds/removes a
  contact's membership of groups referenced by active rules. It **never deletes
  a Xero contact group**, and never touches a group no active rule references.
  A member already sitting in an accepted group is not given a spurious managed
  add.
- **No auto-resync:** changing the mode, or adding/editing/deactivating/deleting
  a rule, never re-groups the existing population. Deleting a rule only shrinks
  the managed universe — members already in that group are **not** removed by
  the system. Members re-group on their next trigger (age-tier change,
  current-season membership-type change, cron age-up) or via the explicit bulk
  re-sync.
- **Refresh from Xero + last synced:** a lightweight **"Refresh from Xero"**
  button re-pulls the contact-group cache (the same full refresh as the
  members-list "Refresh Xero Groups" button) and a prominent **"Last synced"**
  header shows when the cache was last refreshed. Refreshing moves the
  `CONTACT_GROUP_FULL_REFRESH` cursor, so it also invalidates any prior dry-run.
- **Dry-run + bulk re-sync:** the surface shows a cache-based dry-run diff
  (counts, per-member add/remove, an estimated Xero call budget, and members
  skipped because they have no Xero contact) before any run. The bulk re-sync is
  the heavyweight, admin-triggered, chunked, resumable, rate-limited action
  (distinct from the lightweight refresh above); it never advances the
  CONTACT delta-sync watermark. See
  `docs/XERO_MEMBER_GROUPING_RUNBOOK.md` for the Tokoroa cutover procedure.
- Existing age-configured installs migrate to `Membership Type + Age` with
  tier-only rules, preserving behaviour identically (a correctly-grouped member
  produces zero diff). The legacy `AgeTierSetting` Xero group columns and the
  `AgeTierXeroAcceptedContactGroup` table are retained but no longer read
  (dropped in the deferred E13).

## Committee Settings

Committee settings are database-backed and managed from `/admin/committee`.
`CommitteeRole` stores reusable master roles such as President, Secretary, or
Booking Officer, including the role email alias used for committee contact
delivery. `CommitteeAssignment` links a member to one of those roles and stores
presentation controls: blurb, sort order, published, show-phone, contactable,
contact email mode (role alias, member email, or a custom override address),
and active/deactivated state. Multiple members can hold the same master role.

Committee assignment is separate from `Member.role` and
`SeasonalMembershipAssignment`; it never grants admin, lodge, booking, finance,
or subscription privileges. Member detail pages show committee assignments in
their own card alongside access role and seasonal membership type controls.

Public committee and contact-form recipient data is derived from published,
active `CommitteeAssignment` rows whose master role is also active. The public
API returns the linked member's display name, the role name, the assignment
blurb or role description, and an opaque assignment contact key only when the
assignment is contactable. Member email addresses are never returned to the
browser; `/api/contact` resolves contactable assignment keys server-side and
delivers to the address selected by the assignment's contact email mode — the
role email alias configured on `CommitteeRole` (the default), the linked
member's own email, or the assignment's custom override address. When the
selected address is blank or missing, delivery falls back to the role alias and
then the linked member's email so contact mail is never lost, then to the
configured club contact address when no published, contactable assignment or
recipient email is available. Committee-routed contact emails use an opaque
committee-contact marker in EmailLog rows instead of persisting the recipient
address. Phone numbers come from the linked member profile and display only when
the assignment's show-phone flag is enabled.

The legacy standalone `CommitteeMember` table has been removed. It was a
migration aid for clubs moving onto the role/assignment model and never powered
`/api/committee` or committee recipient routing once assignments existed. Seed
steps now create master roles only; the historical migrations that seeded roles
and hidden assignments from legacy rows remain in place for installs that ran
them. Assignment changes and master role changes are audited with before/after
metadata.

## Member Photos

Members can have a profile photo (epic #171). There is nothing to configure at
deploy time — no environment variables, no image service — but the visibility
model matters for privacy.

- **Storage.** A photo is a `MediaImage` row (`kind = MEMBER_PHOTO`, bytes in
  Postgres so it survives redeploys) referenced by `Member.photoImageId`. It is
  kept out of the website content picker (`/api/admin/image-library`, which lists
  `kind = CONTENT` only) and is never served through the public
  `/api/images/[id]` content path.
- **Who can set it.** A member uploads/replaces/removes **their own** photo from
  their profile page; a `membership:edit` admin can do the same on a member's
  behalf from the member-detail page (a read-only admin sees it but cannot
  change it). Uploads are cropped and downscaled in the browser to a 512×512
  square; the server validates content type (JPEG/PNG/WebP), a 2 MB cap, and a
  4096 px backstop, then stores the bytes verbatim. Every admin change is
  audited (`member_photo.upload` / `member_photo.remove`, with the on-behalf
  flag).
- **Who can see it.** The photo is served through a scoped, member-keyed
  endpoint (`/api/members/[id]/photo`). It is **public only** when the member is
  active, holds an active, **published** `CommitteeAssignment`, and the club's
  **Committee photo display** setting below is not "Don't show photos" — in
  lockstep with `/api/committee`. Otherwise only the member themselves or a
  `membership:view` admin can see it; everyone else gets a 404 (the endpoint
  prefers 404 over 403 so a private photo's existence is never confirmed).
- **Consent.** Implied by self-upload; the enforced boundary is control (who can
  set / remove / see). Removal is always permitted.
- **Committee roster display.** Whether the public committee roster
  (`{{committee-members-cards}}`) actually shows photos is a separate opt-in on
  `PublicContentSettings.committeePhotoDisplay`, set from either the Page Content
  admin or the Committee admin page (both edit the same global setting, gated on
  content edit):
  - `NONE` (default) — text-only roster; no photos are shown even for members
    who have one.
  - `CIRCLE` / `SQUARE` — show each published member's photo in that shape, with
    an initials placeholder for members without one.

  Setting it to "Don't show photos" genuinely takes committee photos off the
  public internet, not just off the roster page: the roster stops rendering
  them, `/api/committee` stops emitting photo metadata, **and** the photo
  endpoint stops serving the bytes to anonymous callers (#2242). That is what
  makes it usable as a takedown control. It never hides a photo from the member
  themselves or from a `membership:view` admin, who both keep seeing it in the
  member and profile screens, and it never makes a photo public that the
  published-assignment rule above does not already allow. See
  `docs/member-photos/decisions/ADR-001-member-photos.md` for the full design and
  `docs/SECURITY-ATTACK-SURFACE.md` for the serving/upload authorisation matrix.

Booking and subscription enforcement is season-aware:

- `MEMBER_RATE` keeps normal member pricing for linked member guests.
- `NON_MEMBER_RATE` prices the member at non-member nightly rates while keeping
  the member identity on booking guests, audit records, and promo checks.
- `BLOCK_BOOKING` prevents the member from booking as owner or linked member
  guest and returns a structured policy error with safe member ids/names.
- `NOT_REQUIRED` makes subscription lockout display and booking gates effective
  `NOT_REQUIRED` for that season without deleting or hiding raw Xero invoice or
  subscription history.

Membership type is the **sole authority** for whether a member owes a
subscription (#2149): `subscriptionBehavior` — plus the per-age-tier flag where
the type is `BASED_ON_AGE_TIER`. Access **role carries no subscription
exemption** and is a pure permission concept. Operational accounts are exempt
only because they resolve to a `NOT_REQUIRED` membership type: `ADMIN` and
`LODGE` accounts with no explicit season assignment fall back to the built-in
`ADMIN` (BLOCK_BOOKING, NOT_REQUIRED) and `LODGE` (MEMBER_RATE, NOT_REQUIRED)
types, and `SCHOOL`/`NON_MEMBER` to their own NOT_REQUIRED built-ins. A real
fee-paying human who holds the admin permission is assigned a normal membership
type (Full etc.) and now correctly owes a subscription — the profile, admin
members list, subscriptions list, CSV export, booking gate, and Xero sync all
read the same derivation, so a fee-paying admin shows their real Paid/Unpaid
status everywhere. `Member.lifeMemberDate` is **informational only**; the Life
exemption comes from the `LIFE` membership type (subscriptionBehavior
`NOT_REQUIRED`), never from that field. Seasonal membership type changes do not
automatically reprice existing future bookings, rewrite
subscription/Xero/payment history, or call external providers.

### Membership subscription billing

Finance editors operate Annual Membership Fee billing from `/admin/subscriptions`.
The preview resolves the selected membership year's effective annual fee,
explicit family recipient, billing basis, and proration rule without writing or
calling Xero. The preview also requires an explicitly configured
`subscriptionIncome` account mapping and freezes its account/item identifiers;
the legacy account-code fallback is not sufficient for a billing run. `NONE`
charges the full GST-inclusive integer-cent annual amount;
`REMAINING_MONTHS_INCLUSIVE` charges annual cents multiplied by the decision
month through membership-year end, divided by 12 and rounded to cents. The
decision month is included.

An operator must explicitly confirm the unchanged preview token before durable
charge snapshots and Xero outbox rows are created. Invoice due days are persisted
in `MembershipSubscriptionBillingSettings` and default to 30. The same settings
row holds `familyBillingMode`, the club billing model, also editable from
`/admin/subscriptions`:

- `BILL_FAMILY_VIA_BILLING_MEMBER` (the default, preserving pre-#159 behaviour):
  each family is invoiced once via its nominated billing member, `PER_FAMILY`
  fee schedules are allowed, and a missing or inactive same-family billing
  recipient is a visible exception.
- `BILL_MEMBERS_INDIVIDUALLY`: every member is invoiced directly. The
  Fees page family-billing card is hidden, no billing-member exception
  is raised, and `PER_FAMILY` schedules are rejected server-side on
  create/update. A `PER_FAMILY` schedule left over from a mode switch is not
  reinterpreted as per-member; it surfaces as a
  `PER_FAMILY_FEE_IN_INDIVIDUAL_MODE` exception and must be changed to a
  per-member or no-invoice basis before it can be invoiced.

Operator rollout: a club that invoices each member directly should switch
`familyBillingMode` to `BILL_MEMBERS_INDIVIDUALLY` from `/admin/subscriptions`
after this feature deploys. Before flipping the mode, re-base any existing
`PER_FAMILY` fee schedules to per-member or no-invoice; a `PER_FAMILY` schedule
left in place becomes an uninvoiceable `PER_FAMILY_FEE_IN_INDIVIDUAL_MODE`
exception under individual billing.

Each annual fee is itemised into one or more **components** (E6, #1932), edited
under its fee row in the Annual Membership Fees section of `/admin/fees`. Every invoiceable fee has at
least one component and the components' integer-cent amounts must sum exactly to
the fee total (an amount edit is rejected unless its components are reconciled in
the same request); each component becomes its own GST-inclusive Xero invoice
line, optionally coded to its own account/item, with its own proration flag. A
`NO_INVOICE` fee has no components. Existing installs are backfilled to a single
default component, so day-one invoices are unchanged.

A member in more than one family is billed for a `PER_FAMILY` fee via an
admin-chosen **billing family** (`Member.billingFamilyGroupId`), set from the
member detail family card or the fee-config family-billing panel (audited; greyed
in `BILL_MEMBERS_INDIVIDUALLY` mode). An unset selection stays an
`AMBIGUOUS_FAMILY` exception; a stale one is an `INVALID_BILLING_FAMILY_SELECTION`
exception. Removing the member from a family clears the selection in the same
transaction, so it can never cause silent misbilling.

Missing seasonal
type, fee schedule, family, or active same-family billing recipient becomes a
visible exception and never produces an invoice. `NO_INVOICE` produces a
zero-cent, not-required snapshot rather than being confused with missing setup.
If a member joins a family after that family/membership-type/year was billed, the existing
charge remains immutable and a `FAMILY_ALREADY_BILLED` exception replaces a
second family invoice.
New-member approval runs the same planner after the membership transaction;
failure or incomplete configuration is a warning/exception and cannot undo the
approval.

### Manual mark-paid (clubs that do not use Xero, or cash payments)

Finance editors can mark a member's current-season subscription paid without the
Xero pipeline, from the row actions on `/admin/subscriptions` (finance-view users
see no action). "Mark as paid (manual)" sets the subscription to `PAID`, records
`manuallyMarkedPaidAt`, the acting admin, and an optional free-text note (up to
500 characters, entered in the confirmation dialog and kept for club records
only — the member never sees it), and is audited.
It never calls Xero and never creates or voids an invoice. A manually
marked-paid member is then paid-up everywhere the app enforces it: lodge booking,
membership nomination, and the member's own subscription status. The status chip
shows a `(manual)` suffix and a provenance tooltip.

The confirmation dialog also asks the club's standard email question, and the
answer is required — the API rejects a mark-paid that does not state it (422),
so the choice is never made by default. "Mark paid and email member" sends the
`membership-payment-recorded` receipt: the season, the amount, and the date it
was recorded, all in NZ time. "Mark paid without emailing" records the identical
payment silently. Either way the decision is written to the audit entry. A
membership subscription is not a booking, so the per-booking "No emails" switch
does not apply to this receipt.

The amount line is printed only when the season's frozen charge snapshot is
unambiguously about that one member: a `PER_MEMBER` basis covering exactly one
subscription, with a non-zero total. It is omitted for a `PER_FAMILY` charge
(whose total is the whole family's fee — printing it would tell one member the
family's bill was settled against them while their relatives' subscriptions are
still unpaid), for any charge covering more than one subscription, for a
no-invoice (zero) fee, and when there is no active coverage at all. A manual
payment is cash the app never saw, so no figure is ever inferred.

The confirmation the admin gets back reports what became of the receipt, not
what was asked for: "a receipt is being emailed" only when the mailer accepted
it, and an explicit "the receipt could not be sent" when the address is a
club-internal placeholder, the recipient is suppressed, or the send failed. The
money state is committed either way — a mail failure never rolls back or
re-prompts a recorded payment.

Manual mark-paid is for cash payments where no Xero invoice exists. The action
is not offered — and the API rejects it — when the row already carries a Xero
invoice link (record the payment against the invoice in Xero instead), when the
row is already `PAID`, or when the subscription is `NOT_REQUIRED` (nothing to
pay).

"Mark as unpaid" reverses a manual payment: it restores the row's unpaid state
(`NOT_INVOICED`; `UNPAID` on a legacy row that still carries a Xero invoice
link), clears the provenance columns, and is audited with the previous status.
A reversal never emails the member (there is no "your payment was un-recorded"
notice), so the API rejects a reversal that carries the email flag at all.
Reversal is available only on a row that was manually marked paid — a
Xero-owned `PAID` is never overwritten here. The annual-invoice sweep never
re-invoices a subscription that is already `PAID`, a queued invoice charge
raises a `SUBSCRIPTION_ALREADY_PAID` conflict instead of invoicing a member who
has since paid, Xero sync/reconciliation never downgrades a manual-PAID row
that has no Xero invoice link, and a Xero contact link/push/unlink resync never
deletes a manual-PAID row.
### Application Approval Mapping

When an admin approves a membership application, each person on it — the
applicant and every family member — is approved as **Create new** (the default,
identical to previous behavior) or **Map to an existing member**. Mapping is a
link **and overwrite**: the existing record's name, date of birth, phone, and
both address blocks are overwritten from the application (the applicant also
overwrites email + recomputed age tier). Before approving, the admin previews a
field-by-field diff (current → application) and the approval echoes back an HMAC
preview token; if anything that changes the previewed outcome has moved since —
either row edited, or a recomputed value such as an age-tier boundary — approval
is refused (409) and the admin re-previews. Concurrent approvals mapping the
same member serialize on a per-member advisory lock, and the second one 409s on
token drift.

Collision rules refuse approval (BLOCK) when a mapping target is inactive or
archived, already belongs to a family group (for a family application), is
mapped for two people at once, is a nominator on this application, is an admin
mapped as a dependent, or when the application email belongs to a *different*
login-capable member. A target that already has this season's membership
coverage is kept as-is and excluded from new subscription billing (SKIP with a
note, repeated in the post-approval warnings), so nobody is double-charged.

Mapping also refuses (BLOCK) when a **scoped** admin's mapping would overwrite
the login email of a member who holds a privileged access role — the same
Full-Admin gate as direct member edit (issue #1026), because an email change
plus a public forgot-password request hands the account and its roles to the
new address. A Full Admin can approve such a mapping, and a mapping that leaves
the email unchanged is unaffected. The acting admin's roles are recomputed
inside the approval transaction, so a preview minted by a Full Admin cannot be
replayed by a scoped admin — that approval fails closed with a 409 token
mismatch.

A mapped target that is already linked to a Xero contact keeps that link: the
post-approval contact sync reuses the existing `xeroContactId` and does **not**
re-push the member's details to Xero after the overwrite. If the mapping
changed the member's name or email, the Xero contact keeps its old values
(stale-name caveat) until an operator edits the contact in Xero manually. Only
a member without an existing link gets a Xero contact found-or-created.

Auth is never silently rewritten: mapping a family member never touches a
login-capable target's password/login/2FA or email; mapping the applicant onto
an existing login member keeps that member's auth untouched (and sends no
set-password email), while mapping onto a non-login member promotes it to a
login account (fresh password, set-password email, verified email, cleared email
inheritance). Confirmation timestamps are set only when currently empty and are
never regressed. The **joining fee defaults to skip** for a mapped applicant
(reason "Mapped to existing member"); the admin can switch it back on for a
lapsed rejoiner. Family-member joining fees remain out of scope. Every mapped
person writes a critical `MEMBER_APPLICATION_MAPPED_TO_EXISTING` audit record
capturing the overwritten fields and whether login was promoted.

## Member Import And Addresses

Admin member CSV import treats a member identity as the normalized email plus
normalized first and last name. Rows are skipped as duplicates when that same
identity already exists in the database or earlier in the same import, even
when dates of birth differ or one row has a blank date of birth. Date of birth
is not part of the duplicate key; a blank date of birth is unknown and cannot
prove a distinct identity. Different names may share an email address,
including rows with the same or blank date of birth.

Only one login-enabled member can use an email address. If an existing member
with `canLogin: true` already has the email, every new shared-email import is
created with `canLogin: false`. If the email first appears in the CSV, the first
allowed identity can log in and later same-email identities are imported as
non-login members. Setup invite emails and setup/password tokens are created
only for imported rows that can log in.

Address forms default "Postal same as physical" on for new or blank postal
addresses. Existing members keep it off only when a saved postal address has
material postal fields that differ from the physical address. Server routes
remain authoritative: when `postalSameAsPhysical` is submitted, physical address
fields are copied into postal fields before the member or application is saved.

## Merging Duplicate Members

When the same person ends up with two member records (for example one from an old
import and one from a new application, or a duplicated Book-on-Behalf contact), a
**Full Admin** can merge them from **Admin > Members > (open the record you want
to keep) > "Merge a duplicate into this member"**. Only Full Admins see the
action; scoped admins cannot merge.

- **Who is kept.** The record you open is the **master** and survives. You pick
  the duplicate to merge in; it is **permanently deleted** at the end (there is no
  undo). A swap control lets you flip which record is the master before you
  commit.
- **What merges.** Blank fields on the master are filled from the duplicate;
  where both have a value the master's wins. All history — bookings, payments,
  credits, subscriptions, family/partner links, inductions, committee roles, and
  so on — moves onto the master. Login details, security settings (password,
  2FA), and the Xero accounting link always stay the master's and are never
  taken from the duplicate.
- **What is blocked.** The merge stops (with a clear reason in the preview) when
  the master is inactive/archived, the duplicate holds an admin role (demote it
  first), either record has a pending deletion/archive/family request (including
  a member's own pending account-deletion request), or the duplicate carries a
  real (invoiced/paid) membership-subscription for a season the master already
  has a subscription row for — paid history is never silently dropped.
- **What is warned.** The preview lists every access role the master will gain
  from the duplicate — including custom (definition-backed) roles — plus any
  confirmed-partner link, promo allocation, or group-booking join row that will
  be dropped as a duplicate, so nothing changes silently.
- **The manual Xero step.** The system does **not** touch Xero over the network
  during a merge. The duplicate's Xero *contact* is left in Xero — the preview
  warns you to **archive or merge it in Xero manually**. The one thing it does
  re-point in the database is the duplicate's joining-fee (entrance-fee) invoice
  link, so the master is still recognised as having paid a joining fee and is not
  re-charged. The duplicate is also signed out on their next request.
- **Confirming.** Before anything happens you see a full preview: the field-by-
  field result, how many history rows move, which duplicate rows are de-duplicated,
  and every warning. You must type `MERGE <duplicate's full name>` to enable the
  irreversible **Merge and delete duplicate** button. Every merge writes one
  critical `MEMBER_MERGED` audit record. Historic audit rows that referenced the
  duplicate keep its id and stored name by design, so the audit trail stays intact.

## App Defaults

| Variable                           | Description                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `CURRENCY`, `NEXT_PUBLIC_CURRENCY` | Currency display and server default.                                                                 |
| `TZ`, `NEXT_PUBLIC_TZ`             | **A seed only, since CT-1 (#2989).** The club's time zone is now recorded in the database and edited in-app at **Admin → Setup & Configuration → Club Time Zone** (`/admin/club-time`); see [`docs/guides/club-time.md`](docs/guides/club-time.md). These variables are read for exactly one purpose: on the first start after upgrading, an installation that has no recorded zone copies the value it is *already effectively using* from here, so nothing about its behaviour changes. After that the recorded setting is the authority and editing these variables does not change the club's civil time. They are **not** the server's own clock policy either — that is the container's business and is deliberately irrelevant to what members see. `Pacific/Auckland` is the generic New Zealand default and applies only where neither a recorded zone nor these variables say anything. Store an IANA identifier naming a place (`Pacific/Auckland`); an abbreviation (`NZT`) or a fixed offset (`+12:00`, `Etc/GMT-12`) is refused. The transitional `APP_TIME_ZONE` constant still derives from these for the display call sites epic #2988 has not migrated yet, and CT-6 retires it. Booking dates remain New Zealand date-only lodge nights unless a feature says otherwise. |
| `LOCALE`, `NEXT_PUBLIC_LOCALE`     | Locale for formatting.                                                                               |
| ~~`NEXT_PUBLIC_GA_MEASUREMENT_ID`~~ | **Removed as configuration (#2573).** The GA4 measurement id, the consent-banner mode and the banner wording now live **only** in the database, entered in-app at Admin → Integrations → Google Analytics. Nothing in the app reads the environment variable, there is no fallback to it, and its value is **not** imported automatically — so after deploying this release Google Analytics stays inactive until an authorised admin saves a valid measurement id in-app. Remove the variable from your environment. See the Google Analytics section below. |
| ~~`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`~~ | **Removed as configuration (#2087).** Google OAuth credentials now live **only** in the encrypted `IntegrationCredential` store, entered and verified in-app (Admin → Integrations → Google sign-in). Any legacy `GOOGLE_CLIENT_*` env vars are **detected, warned about, and ignored** — re-enter the credentials in the wizard, then remove the env vars. This reverses the earlier #2035 "bootstrap-class secret, never in the DB" posture by owner decision (epic #2078). See the Google sign-in section below. |
| `LOG_LEVEL`                        | Pino log level such as `debug`, `info`, `warn`, `error`, or `fatal`.                                 |
| `APP_ENVIRONMENT_ROLE`             | **Required, and the only authority for whether this installation is the club's live site.** Exactly `production` or `non-production`. See "Environment Role" below — and note it is **not** `APP_RUNTIME_ROLE` on the next line. |
| `APP_RUNTIME_ROLE`                 | Runtime label used by health/status reporting, usually set by Compose (`web-blue`, `web-green`, `cron-leader`, `staging`). Names which container **slot** this is. **Never read to decide whether this installation is production** — that is `APP_ENVIRONMENT_ROLE` above (`INV-CONFIG-003`). |
| `NODE_ENV`                         | Runtime mode set by Node/Next.                                                                       |
| `NEXT_RUNTIME`                     | Runtime marker set by Next.js instrumentation.                                                       |
| `npm_package_version`              | Package version exposed by npm scripts.                                                              |

## Environment Role

**Is this installation the club's live site, or a copy of it?** One environment
variable answers that, and nothing else does:

```
APP_ENVIRONMENT_ROLE=production      # the club's live site
APP_ENVIRONMENT_ROLE=non-production  # a staging site, a copy, a developer's checkout
```

It matters because a copy restored from the live database holds the club's real
members and their real email addresses. Anything that leaves this application —
an email to a member, an invoice written into the club's Xero organisation — has
to know which installation it is running on before it goes out.

**Nothing is inferred, deliberately** (`INV-CONFIG-003`). Not `NODE_ENV`, which
is a build mode — a staging container runs a production build, so `NODE_ENV` says
`production` there too. Not the hostname, the branch, the URL or the
`DATABASE_URL`, because a restored copy looks identical to the site it was copied
from. And **not `APP_RUNTIME_ROLE`**, which names which container slot this is
(`web-blue`, `cron-leader`, `staging`) and is a deployment naming convention.
Every one of those is right until somebody stands up a copy that breaks the
convention, and that is precisely the day it matters.

### The three states

| Effective role | When | What it means |
| --- | --- | --- |
| `PRODUCTION` | `APP_ENVIRONMENT_ROLE=production` and the safer override is off | Ordinary live behaviour. |
| `NON_PRODUCTION` | `APP_ENVIRONMENT_ROLE=non-production`, **or** an administrator has switched the safer override on | Treated as a copy. |
| `UNKNOWN` | The variable is unset, or holds anything other than those two words | **Not production, and not confirmed non-production either.** Anything whose safety depends on knowing which installation this is is held back until it is declared. |

A near miss — `prod`, `staging`, `true`, `non_production` — is **refused**, not
guessed at, because guessing is how a typo silently becomes "production". The
refused value is shown back to you on the setup checklist and at
**Admin → Setup & Configuration → Environment Safety** (`/admin/environment`) so
you can see the typo.

### The safer override

A Full Administrator can force an installation to be treated as a copy at
`/admin/environment`, whatever the deployment says. It is stored in the database
(`EnvironmentSafetySettings`), and it can only ever move the answer **towards**
non-production — the table has no column in which "this is production" could be
expressed, so a restored production dump cannot carry a production claim into a
copy. Switching the override **off** is not an elevation: the deployment
declaration decides again, so an undeclared installation goes back to `UNKNOWN`
rather than becoming the live site. Both directions are Full-Admin-only and
audited (`ENVIRONMENT_SAFETY_OVERRIDE_UPDATED`).

### Upgrading an existing production installation

An installation that predates this release has no declaration, so it would
resolve `UNKNOWN`. Four things stop that becoming a silent outage:

1. **The production deploy refuses to run without it, and refuses the wrong
   value too.** `scripts/run-production-blue-green-deploy.sh` validates the `.env`
   entry at **step 3 of 20** — before the migration (step 13), before the new
   release's first process starts (step 14) and long before the Caddy cutover
   (step 17). It requires **exactly `production`**, which is narrower than the
   application parser on purpose: that script deploys the club's live site and
   nothing else, so a `.env` saying `non-production` is the one value it can prove
   is wrong. `.env.example` ships `non-production` (right for a local checkout,
   wrong for a live deployment) and is also the file operators diff against their
   real `.env` when upgrading, so copying that value across is the likeliest
   error — and it would produce a live site holding back member email and, once
   Xero containment lands, rewriting the club's real contact addresses. Either
   mistake aborts with the old release still serving and nothing changed.
2. **The deploy also asks each container what IT got, not only what the file
   says.** Those are different questions. The step-3 check reads `.env`; Docker
   Compose prefers a value set in the invoking shell over the env file, and takes
   the last of any duplicate assignments rather than the first. So at **step 14**
   — new colour started, old colour still serving every request — the deploy
   asks **the running application** (`GET /api/deploy/runtime-status`, from inside
   the container) which declaration it read, and aborts before the cutover if any
   container answers anything other than `production`. Asking the application
   rather than re-parsing the container's environment is deliberate: a second
   implementation of the rule is a second thing that can drift from the first, and
   this is the check that has to hold when the file check does not. It checks the
   *declaration*, not the effective role, so a production deployment whose
   administrator has switched the safer override on still deploys normally.
3. **The app says so loudly.** A boot with an unresolved role logs an error
   explaining the specific cause — an absent declaration and an unreadable
   override are different faults with different repairs — and the setup
   checklist's **Production Or Non-Production** step reports `blocked` with the
   repair. A boot that resolves non-production says that too, at info level, and
   names which source decided it.
4. **Confirm the answer after the deploy, from the message rather than the
   tick.** On `/admin/setup` the **Production Or Non-Production** step must read
   *production*. A non-production installation shows a green tick there too, since
   both are validly configured states and the checklist cannot know which one this
   installation is meant to be — so the tick means "answered", and the message
   means "which answer".

For a deployment brought up by hand rather than through the deploy script, set
`APP_ENVIRONMENT_ROLE` in the Compose `.env` before starting the app. The base
`docker-compose.yml` passes it through with **no default** on purpose: a default
would be exactly the silent inference this design removes.
`docker-compose.staging.yml` hard-codes `non-production`, so a staging or E2E
stack is never blocked on it.

Full operator walkthrough: [`docs/guides/environment-role.md`](docs/guides/environment-role.md).

## Module Controls And Admin Modules

Optional modules are activated from Admin > Modules and stored in the
`ClubModuleSettings` database table. There are no module `FEATURE_*`
environment variables. Admin Modules do not store secrets, tokens, tenant ids,
bank account details, or provider credentials; Stripe, Xero, email, cron, and
other operator-owned credentials stay in environment variables and provider
setup screens.

The effective module state is the saved Admin Modules value. Missing module
settings use the hardened first-install defaults below. If the settings table
cannot be read, optional modules fail closed.

| Module | Default | Description |
| --- | --- | --- |
| Lodge kiosk | off | Guest arrival, departure, and lodge access screens. |
| Chores and roster | off | Roster generation, chore templates, and guest chore tracking. |
| Finance dashboard | off | Finance reports, sync diagnostics, and finance-only dashboards. |
| Waitlist | off | Waitlist booking state, admin queue, offer handling, and waitlist cron. |
| Xero integration | off | Operational Xero linking, sync actions, reconciliation tools, Xero cron, and Xero webhooks. |
| Bed allocation | off | Room and bed inventory, guest-to-bed allocation, auto-allocation, and allocation approvals. |
| Internet Banking payments | off | Member Internet Banking payment option backed by Xero invoices. Operational Xero still needs credentials and a tenant connection before invoices can be issued and reconciled. |
| Address autocomplete | off | Addy-powered suggestions on address fields. Manual address entry remains available whenever the module is off, credentials are missing, Addy fails, or rate limiting applies. |
| Group bookings | on | Group-booking organiser, join, and settlement surfaces. |
| Lockers | on | Physical locker records and member allocations. |
| Lodge induction | on | Lodge induction templates, assigned signers, and single-Pass sign-off. |
| Work parties | on | Volunteer work-party events and the internal booking discounts they grant. |
| Promo codes | on | Promo-code administration and promo-aware booking flows. |
| Hut leaders | on | Hut-leader assignments, kiosk access, and auto-assignment. |
| Communications | on | Admin bulk email to members. Transactional notifications are unaffected. |
| Events calendar | on | Club events calendar for meetings, working bees, and social events, with recurring events and optional MiroTalk video-meeting links. Defaults on, which is exactly how the calendar behaved before it had a module at all, so an existing club sees no change. Switching it off makes `/calendar`, `/admin/calendar`, and `/api/calendar/*` return Not Found and removes the dashboard Events card; existing events are kept and reappear if it is switched back on. Organisation accounts never see the calendar whether the module is on or off. |
| Ski-field conditions | on | Live mountain/road status panel, public API routes, and admin cache controls. |
| Two-factor authentication | off | Requires users to complete authenticator-app, email-code, or recovery-code verification after password login. |
| Email sign-in link | off | Lets members request a single-use email link to sign in without their password (additive to password login, never a replacement). Only ever works for existing active members with a verified email; the `magic-link-login` link expiry defaults to 15 minutes (stored on the Login & Security settings, range 5–60) and is read by the sign-in request flow. |
| Google sign-in | off | Lets members sign in with a Google account they have linked from their profile (additive to password login, never a replacement). Credentials are entered and verified **in-app** on the Google sign-in setup page (Admin → Integrations → Google) — no env vars, no restart. The module cannot be turned on until a real Google OAuth round-trip verifies (hard gate), and replacing a credential re-locks it until re-verified. The "Continue with Google" button appears only when the module is on AND credentials resolve. No account is ever created from Google, and an unlinked Google account is refused with a friendly message. See the Google sign-in section below. |
| Google Analytics | off | GA4 tracking on the public website, configured **in-app** at Admin → Integrations → Google Analytics (measurement id, consent-banner mode, banner wording) — no env vars, no restart. The module is the master switch: with it off there is no card, no configuration API and no tag. With the consent banner on (the default and the recommended option) nothing at all is sent to Google until a visitor selects Accept; with it off the tag loads automatically and visitors opt out afterwards from the footer's Analytics preferences link. Advertising consent categories stay denied in both modes, and analytics never runs on admin pages, signed-in member pages, or any address carrying a token, PIN or personal identifier. See the Google Analytics section below. |
| AI help assistant | off | Free-text help questions answered by a paid AI model (Anthropic Claude Haiku), grounded strictly in each page's curated help content. The Anthropic API key is entered **in-app** on Admin → Integrations (encrypted vault, never an env var). Unlike Google sign-in there is **no** enable-gate on a present key — with the module on but no key, the ask box degrades to a structured fallback and curated page help still works. A monthly spend cap (default NZ$10) hard-stops AI answers for the rest of the month once reached. See the AI help assistant section below. |
| Add another member as a guest | off | Lets a member add another club member, outside their own family group, as a guest on their booking. With the module off, a cross-family add is refused exactly as it was before this feature existed, so an existing club sees no change until an admin turns it on. With it on, the other member is emailed and asked first by default, and a bed is held for them until they answer or the request lapses. A member who has been asked but has not answered holds a bed and is deliberately kept off the kiosk arrivals list, the chore roster, bed allocation and the arrival emails until they accept. The surface exists both when a booking is created and when it is edited, and admins get the same section on a member's booking page. Turning the module on also brings admin adds, the admin booking-copy and the booking-request pipeline under the always-notify rule; with it off, none of those write a consent record or send anything. See the member-guest settings section below. |

### Member-guest settings

The "Add another member as a guest" module stores its policy in the
`MemberGuestSettings` singleton (`id = "default"`), created lazily on first
write. Admins edit it on the **Member guests** card under **Admin → Bookings
setup** (`/admin/bookings-setup`); the card stays editable while the module is
off, with a banner saying nothing is in use yet, so the policy can be configured
before the module is switched on. The card reads and writes through `GET`/`PUT
/api/admin/member-guest-settings`, gated on the **bookings** permission area:
view-level access reads the settings, edit-level access changes them, and the
payload says which so a card never shows a Save button that would be refused.
The row is created on the first save, so a club that has never opened the page is
running on the defaults below and nothing has been written.

| Setting | Default | Travels in config transfer | Description |
| --- | --- | --- | --- |
| Approval required | on | yes | The member being added must agree before they appear on the booking. Turning it off means they are told rather than asked. |
| Pending hold expiry (days) | 7 (range 1–60) | yes | How long a bed stays held for a member who has been asked and has not answered. After that the hold is released. |
| Open member search | off | **no** | Off means a booker can only find another member by typing their exact email address. On makes the club's member name list browsable to anyone who can start a booking. |
| Include minors in open member search | off | **no** | Off means minors are excluded from that browsable list even when open member search is on. |

**Who the settings do and do not bind.** The two search settings are about what
MEMBERS can see. An admin's own member picker on a booking is not bound by
either: an admin holding membership view access can already browse the whole roll
from Admin → Members, so gating their booking-side picker on a member-facing
privacy switch would protect nothing and only slow an officer down. The rider is
that the admin name search is gated on the **membership** permission area rather
than on bookings — a Booking Officer whose role has membership access removed
gets the exact-email box instead, which preserves the guarantee that such a role
never sees a member directory. Every admin lookup is written to the audit log
against the officer who made it, exactly as a member's is.

The two search settings deliberately **never travel** in a club config transfer
(owner decision D-18): importing another club's bundle must not widen this
club's member privacy without this club's admin choosing it, the same rule the
sign-in method toggles follow. A fresh import keeps whatever this club already
had, which for a new install is off.

**A request never outlives the stay.** Whatever the expiry days are set to, a
pending request always lapses at the start of the day *before* check-in, and
never sooner than two hours after it was made. The clamp is a day early on
purpose: releasing a bed goes through the same path a member's own "take myself
off" uses, and that path refuses once check-in is no longer in the future, so an
expiry landing on check-in day would fire on a morning it could not act.

**When a lapse cannot release the bed.** Expiry settles the reduction as account
credit to the booking owner, so an ordinary paid booking always releases on time
and no card refund is issued that nobody asked for. Four cases genuinely cannot
be resolved automatically — the pending member is the booking's only guest, the
booking was priced by hand as a quote, the booking's status forbids guest
changes, or check-in has already started. Those stay on the booking, are counted
separately by the nightly job, and appear to admins as consent needing attention
with the actual remedy named (cancel the booking, or re-quote the request).

**Consent email and the mute switches.** Being asked for consent is not treated
as a mutable preference: consent-adjacent email ignores the per-action "notify the
member" tick and ignores the member's own notification-category preferences,
because a member who had muted a category would otherwise never be asked and
would silently lapse off the booking days later. It **is** withheld by the
per-booking **No emails** switch, and each withheld send is recorded on that
booking's withheld list.

Cron-backed optional module schedules are still registered when
`CRON_ENABLED=true`; each run checks the effective module state before doing
module work. If an Admin Modules setting is disabled, the cron runner records a
clean skipped result rather than running the module task.

## Admin Module Activation

The Admin dashboard includes `/admin/modules` for club-level activation of the
optional modules above. These settings are stored in the `ClubModuleSettings`
database table as booleans only.

## Login And Security (Password Policy)

Admin > Login & Security (`/admin/security`) sets the club-wide password
complexity policy, stored in the `LoginSecuritySetting` singleton (one row,
`id = "default"`). The page is gated by the `support` admin permission area
(view to read, edit to change), and every save is written to the audit log under
the `security` category.

| Setting | Default | Accepted range | Notes |
| --- | --- | --- | --- |
| Minimum password length | 12 | 8–64 | A non-configurable hard maximum of 128 characters always applies. |
| Require an uppercase letter | off | on/off | `A–Z` |
| Require a lowercase letter | off | on/off | `a–z` |
| Require a number | off | on/off | `0–9` |
| Require a symbol | off | on/off | any non-alphanumeric character |
| Magic-link TTL (minutes) | 15 | 5–60 | Read by the magic-link sign-in flow (#2034). Shown on the Login & Security page's Email sign-in link card; editing the value from that page is a planned follow-up, so it is read-only there for now. |

The policy governs only the paths where a member **chooses** a password —
`/change-password` and the reset/setup-invite redemption at `/reset-password`.
It is enforced at set time by a shared validator (`src/lib/password-policy.ts`,
loaded from the DB via `src/lib/login-security-settings.ts`); existing password
hashes are never re-validated, so a stronger policy never locks anyone out at
login. When no row is configured the effective policy is the code default (min
12, no required character classes), which is byte-identical to the historical
behaviour. To force existing members onto a new policy, set
`Member.forcePasswordChange` (the "require password change" lever), which routes
them through `/change-password` on next sign-in.

A public, unauthenticated endpoint (`GET /api/auth/password-policy`) discloses
the active rules so the reset and change-password forms can show live hints and
validate length client-side; disclosing the policy is standard and the server
enforces it regardless.

## Two-Factor Authentication

The Two-factor authentication Admin Modules toggle is a global enforcement
switch. It defaults off. When enabled, password sign-in creates a limited JWT
session with `twoFactorVerified=false`; protected route-group layouts and API
guards redirect or reject that session until the user completes `/login/enroll`
or `/login/verify`. A session becomes verified only when the Auth.js jwt
callback consumes a single-use, short-lived challenge token minted server-side
after a successful code check (stored hashed in `TwoFactorSessionChallenge`);
client-initiated session updates cannot flip the flag.

The member Profile page shows its Two-factor authentication security card only
when the module is enabled or the member is already enrolled. If the club later
turns the module off, enrolled members still see their enabled state and recovery
code controls, while non-enrolled members do not see an enrollment prompt.

The Email sign-in link (magic link) Admin Modules toggle is additive to password
login and defaults off. When enabled, `/login` shows an "Email me a sign-in link"
option that posts to `POST /api/auth/magic-link`. That endpoint is
enumeration-safe (it always returns `{success:true}` and gives an identical
confirmation) and mints a single-use, SHA-256-hashed token (`MagicLinkToken`)
ONLY for an existing active member whose email is verified — deliberately
stricter than forgot-password, so a magic link is never an email-verification
bypass. The link (`/login/magic?token=…`) is emailed through the club's own SES
pipeline as the `magic-link-login` template, whose rendered HTML is never
persisted in `EmailLog` (sensitive-log redaction). Clicking it signs in through a
second Auth.js Credentials provider that replicates every password-login gate,
claims the token single-use via a conditional `updateMany` (so two concurrent
clicks mint at most one session), refuses members with a pending forced password
change (pointing them at Forgot password, which clears the flag), and never sets
`twoFactorVerified` — so a 2FA-enabled member is still challenged on
`/login/verify`. The link expiry defaults to 15 minutes (supported range 5–60),
is stored on the `LoginSecuritySetting` singleton, and is read by the request
route when a link is minted. The Login & Security page's Email sign-in link card
shows the current expiry; changing it from that page is a planned follow-up, so
the value is read-only there for now.

### Google sign-in (profile-initiated linking)

The Google sign-in Admin Modules toggle is additive to password login and
defaults off. It is **profile-initiated linking only**: a member is never created
from Google, and Google is never matched to an account by email at login (that
would let anyone controlling the matching Google Workspace domain take over an
account — closed by owner decision). Sign-in resolves a member **solely** by a
pinned Google subject id (`Member.googleSub`).

**How linking works (no adapter, JWT strategy).** A signed-in member opens their
profile → Security → "Connected accounts" and clicks **Connect Google**. That
posts to `POST /api/profile/google/link/start`, which sets a short-lived,
HttpOnly, HMAC-signed "link intent" cookie bound to that member's id, then starts
the Google OAuth round-trip. The single Google provider serves both login and
linking; the callback distinguishes them by the presence of that cookie. On the
link round-trip the `signIn` callback requires `email_verified === true` on the
Google profile, pins `Member.googleSub = profile.sub` (guarded: refused if the
sub is already linked to another member, or the member is already linked to a
different Google account), writes a `security`-category audit, and returns a
redirect **string** — which makes Auth.js redirect **before** minting a session,
so linking never switches the member's session identity. Unlinking
(`POST /api/profile/google/unlink`) nulls `googleSub`, is audited, and is always
allowed because every login-capable member keeps password login.

**Where credentials live (#2087).** The per-club Google OAuth client id and
secret are stored **only** in the encrypted `IntegrationCredential` store
(AES-256-GCM, key derived from `AUTH_SECRET`), entered through the in-app setup
wizard — never in the environment. The NextAuth config is **request-scoped**
(`NextAuth((request) => config)`): the Google provider is resolved from the DB
per request and is **omitted entirely** when unconfigured (no ghost button, no
direct-URL provider error), and the resolver **fails open** — a DB or decrypt
failure degrades Google to "unconfigured" and can never break
credentials/magic-link/2FA sign-in. Any legacy `GOOGLE_CLIENT_*` env vars are
ignored (detected + warned about); re-enter them in the wizard and remove them.

**How sign-in works.** When the module is on and credentials resolve from the
store, `/login` shows a "Continue with Google" button. The provider resolves the member
by `googleSub === profile.sub` among login-capable members only — never by email,
never provisioning — and applies the same gate as password login
(`canLogin && active && emailVerified`) plus a forced-password-change refusal. An
unlinked or ineligible identity is refused with a friendly message surfaced via
`/login?error=…` (unlinked, refused, password-change, disabled, generic). The
resolved member returns the exact same user shape as password login, so 2FA and
the admin-permission matrix apply identically — a 2FA-enabled member is still
challenged on `/login/verify`. Disabling the module refuses both new Google logins
and new links immediately, even for already-linked members. Because linking pins
the Google subject id (not the email), a member whose Google **or** club email
later changes stays signed in; a member with a brand-new Google account unlinks
then re-links.

**Per-club Google Cloud console setup (guided, in-app — #2087).**

Do it all from **Admin → Integrations → Google sign-in setup**, which walks a
Full Admin through the wizard with exact copy-paste values. No env vars, no
restart, no command line.

1. In the [Google Cloud console](https://console.cloud.google.com/), create (or
   select) a project for the club.
2. Configure the **OAuth consent screen** (External user type unless the club is
   a Google Workspace and wants Internal): set the app name, support email, and
   the club's public domain as an authorised domain.
3. Under **APIs & Services → Credentials**, create an **OAuth client ID** of type
   **Web application**.
4. Add the **authorised redirect URI** — copy it from the wizard's first step (it
   shows the exact resolved value, `https://<your-domain>/api/auth/callback/google`,
   derived from `NEXTAUTH_URL`). The requested scopes are the defaults
   `openid email profile`.
5. Paste the generated **Client ID** and **Client secret** into the wizard's
   write-only credential fields (Full Admin only). They are encrypted at rest and
   never shown again; entering a new value replaces the old one and re-locks the
   module.
6. On the wizard's **Verify** step, click **Verify with Google** and complete the
   consent screen once as yourself. This is a real OAuth round-trip through the
   production callback — it links nothing and mints no session; it only proves
   Google accepts the client and redirects back.
7. Once verified, turn on **Google sign-in** in Admin → Login & Security (the
   toggle stays locked until verification passes). Members can then link their
   Google accounts from their profiles.

**Upgrading an env-configured deployment.** If this club previously set
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in the environment, those values are
now **ignored** (a readiness warning flags them). Re-enter the same credentials
in the wizard, verify, then delete the env vars.

Users enroll either an authenticator app (TOTP) or an email one-time code. TOTP
secrets are encrypted at rest using key material derived from `AUTH_SECRET` (or
`NEXTAUTH_SECRET` fallback), so rotating that secret invalidates stored TOTP
secrets and recovery-code hashes. Email codes are short-lived, hashed at rest,
and the `two-factor-code` email template is marked sensitive so rendered code
content is not retained in email logs. Recovery codes are generated on
enrollment and profile regeneration, shown once, hashed at rest, and consumed
once.

> **Operational note — rotating `AUTH_SECRET`/`NEXTAUTH_SECRET` is a planned
> event, not a casual credential refresh.** Because members' TOTP secrets and
> recovery-code hashes are bound to key material derived from the secret,
> rotating it **invalidates every member's enrolled authenticator and recovery
> codes at once** — on their next sign-in each member is forced back through
> two-factor enrollment. Since #2079 the blast radius also includes **all stored
> provider credentials** (Xero client id/secret/webhook key) **and the wrapped
> Xero token-encryption key**: after rotation those fail decryption and must be
> re-entered in-app, and Xero must be reconnected (re-OAuth). Schedule rotation
> as a maintenance action with advance member communication and a support plan
> for anyone who cannot immediately re-enroll (e.g. members who no longer have
> their authenticator device); never rotate ad hoc. See the **auth-secret
> rotation runbook** in `DEPLOYMENT.md`. Short-lived email one-time codes are
> unaffected (re-issued per attempt).

Invalid two-factor attempts are rate-limited and tracked per member. Five
invalid app, email, or recovery-code attempts lock the two-factor challenge for
15 minutes. Accounts that still have `forcePasswordChange=true` must finish
`/change-password` before enrolling or verifying two-factor authentication.

## Stripe

**Stripe credentials are DB-only (#2082).** The Stripe secret key, publishable
key, and webhook signing secret live **only** in the encrypted
`IntegrationCredential` store and are captured in-app through the **guided setup
wizard at Admin > Integrations > Stripe** (Full Admin only) — it links you to the
Stripe API-keys page (use test mode while you set up), captures the keys
write-only, verifies the connection by reading your Stripe account and showing
its display name (the right-account confirmation), and walks you through the
webhook endpoint (URL to paste, signing secret back, verified via a Stripe
test event). The webhook step is **optional/skippable** and freshness-scoped —
replacing any Stripe credential drops the verified webhook badge.

There are **no** `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, or
`STRIPE_WEBHOOK_SECRET` environment variables any more — if any are still present
they are **ignored** and setup readiness raises a warning naming them for removal
(never silently honoured). Secrets are encrypted at rest with AES-256-GCM under a
key derived from `AUTH_SECRET`/`NEXTAUTH_SECRET` via HKDF-SHA256.

The **publishable key** is not secret; it is delivered to the card form at
**runtime** from the store via `GET /api/stripe/publishable-key` — there is no
build-time `NEXT_PUBLIC_*` inlining, so changing keys in the wizard takes effect
without a rebuild. The webhook route stays **fail-closed**: with no stored signing
secret it rejects every event.

## Google Analytics

> See the [Integrations guide](docs/guides/integrations.md) for the operator
> walkthrough, and [`docs/UPGRADING.md`](docs/UPGRADING.md) for the cutover.

**The Google Analytics configuration is DB-only (#2573).** The GA4 measurement id,
the consent-banner mode and the banner wording live **only** in the
`AnalyticsSettings` singleton, entered in-app at **Admin → Setup & Configuration →
Integrations → Google Analytics** (finance **view** to see the status, finance
**edit** to change it). Saving takes effect promptly — the public configuration
cache is invalidated on write — and needs no restart or redeploy.

`NEXT_PUBLIC_GA_MEASUREMENT_ID` is **not read at all** any more. There is no
environment fallback and its value is **not** imported into the database, so
analytics is inactive from the moment this release deploys until an admin saves a
valid measurement id in-app. That hard cutover is deliberate, so no club's website
starts tracking under a configuration nobody has reviewed. Remove the variable from
your environment.

Admin → **Modules** remains the master switch: with the `analytics` module off there
is no Integrations card, the configuration API answers 404, and no tag loads.

Two consent modes, chosen by the club:

- **Show the consent banner** (the default, and the option the setup screen
  recommends). Nothing whatsoever is sent to Google — no tag, no request, no
  cookieless ping, no consent-status signal — until a visitor selects **Accept**.
  Declining or dismissing the banner leaves analytics off.
- **Do not show the consent banner.** The tag loads automatically on eligible
  public pages. A decline recorded while the banner was showing is invalidated once;
  a later opt-out through the public **Analytics preferences** link is always
  honoured. The setup screen warns the admin before this mode is saved.

Advertising storage, advertising user data and advertising personalisation stay
**denied** in both modes, and Google's advanced consent mode is not implemented.

Everything **fails closed**: no measurement id, an invalid one, a disabled module or
a database read failure all mean no analytics, and the public website still renders
normally.

Two things are fixed in application code and are **not** configurable: where
analytics may run (the public website only — never admin pages, signed-in member
pages, or any address carrying a token, PIN or personal identifier) and what is sent
about the address (origin and pathname only, never a query string or fragment, with
the referrer sanitised too).

One **Google-side** setting matters and the application cannot reach it, so
switching it off is a **required** setup step, not a refinement: turn **Page
changes based on browser history events** off under Enhanced measurement in your
GA4 web stream. The app sends one sanitised page view per *eligible* address
itself. That option instead watches the browser's own history, so left on Google
adds a page view whenever a visitor moves between pages — including the move that
leaves the public website for a login, member or dashboard address the route
policy excludes, and that hit may carry the address as the browser has it rather
than the stripped one the app sends. Double-counted views are the visible symptom;
the disclosure is the reason. See the
[Integrations guide](docs/guides/integrations.md) step 7.

The application never states whether a chosen configuration is legally compliant.
Whichever mode a club picks, its privacy policy should disclose the use of Google
Analytics; the setup screen warns when no privacy policy page is published, and
while one is published the consent banner and the preferences panel link it.

## AI help assistant

> See the [AI Help Assistant guide](docs/guides/ai-help.md) for the operator
> walkthrough and what members see.

**The Anthropic API key is DB-only (#2211).** The key lives **only** in the
encrypted `IntegrationCredential` store (provider `anthropic`, key `api_key`),
captured write-only on **Admin → Integrations** (Full Admin only). There is **no**
`ANTHROPIC_API_KEY` environment variable — the key is never read from the
environment for operation, and it is never returned to a browser, logged, or put
in an audit row. It is encrypted at rest with AES-256-GCM under a key derived
from `AUTH_SECRET`/`NEXTAUTH_SECRET`; if the auth secret is rotated the key drops
to a "needs re-entry" state and the assistant stops answering until it is
re-entered.

The assistant answers free-text help questions with a paid model
(Anthropic Claude Haiku 4.5), **grounded strictly** in each page's curated help
content: if the answer is not in that content it says it does not know and points
to the page's help panel or to contacting the club — it never invents features,
prices, dates, or policies, and it has no tools and no data access.

**Where it appears (#2212).** Once the module is on **and** a key is stored, the
help widget on every **authenticated** surface (member, admin, finance) grows a
free-text ask box under the curated chips, with a persistent disclaimer that AI
answers can be wrong and that the question is sent to Anthropic (US). The
**public website** widget stays curated-only — it never gets the free-text path.
Each conversation is capped to a few exchanges, then offers "Start new chat".
The admin surface lives at **Admin → AI help assistant** (`/admin/ai-assistant`),
reached from the **"AI help assistant"** card on **Admin → Integrations** or the
sidebar item under *Monitoring & Support*. That page carries the write-only key
field, the monthly spend-cap editor, and a usage panel (month spend vs cap, token
totals, request/failed counts, per-surface breakdown, and recent failures — no
question text is ever stored). The whole page 404s while the module is off.

**Recommended setup sequence:**

1. **Enter the key** on Admin → Integrations → **AI help assistant** (or Admin →
   AI help assistant). We strongly recommend creating a **dedicated Anthropic
   workspace** for this key and setting a **console spend limit of about
   US$20–30/month** on it as a hard backstop that sits *outside* the app — so
   even a misconfiguration or an app bug cannot spend beyond it.
2. **Enable the module** on Admin → Modules ("AI help assistant"). Unlike Google
   sign-in there is **no verify-gate**: enabling with no key stored is harmless —
   the ask box degrades to a structured fallback and curated page help still
   works. This asymmetry is deliberate (an unconfigured assistant is invisible,
   not broken).
3. **Adjust the budget** if needed on **Admin → AI help assistant** (the
   monthly spend-cap editor takes dollars-and-cents; support-edit access). The
   in-app **monthly spend cap** (default **NZ$10**, `AiAssistantSettings.monthlyBudgetCents`,
   integer cents) is a **hard cutoff**: once the month's estimated spend would
   exceed it, the assistant returns a "budget exhausted" fallback for the rest of
   the calendar month (Pacific/Auckland) and no further paid calls are made. Cost
   is deliberately **over-estimated** (conservative NZD FX, rounded up) so the cap
   trips early rather than late, and the app also stops spending if it can no
   longer record usage ("can't-meter ⇒ don't-spend"). The cap is a
   deployment-specific control and does **not** travel in a config-transfer
   bundle — a fresh import gets the NZ$10 default.

Per-member, per-IP, and global daily rate limits throttle abuse, but the monthly
budget cap is the real spend ceiling.

**Privacy — update your privacy page before enabling.** When the assistant is on,
a member's typed question (and any page context the widget attaches) is sent to
**Anthropic PBC (United States)** to generate the answer; Anthropic acts as a
data **processor** for the club. The question text is **not** stored by this app —
only aggregate metering (token counts, cost, success/failure) is kept, never the
question itself. The in-widget disclaimer already warns members not to include
personal details, but the club's own **privacy statement is club-authored**
(PageContent `/privacy`), so a club enabling this module should add Anthropic to
its list of processors. Suggested wording:

> _"If you use our in-app AI help assistant, the question you type is sent to
> Anthropic PBC (United States), our AI processor, to generate a reply. We do not
> store the text of your question. Please don't include personal or sensitive
> details in AI help questions."_

## Operational Xero

**Xero credentials are DB-only (#2079).** The Xero OAuth client id/secret, the
webhook signing key, and the token-encryption key live **only** in the encrypted
`IntegrationCredential` store and are captured in-app through the **guided setup
wizard at Admin > Xero > Setup** (#2080; Full Admin only) — it walks you through
creating the Xero app with copy-paste-exact values, entering the credentials, and
the OAuth connect, then confirms the connected organisation name. The redirect
URI is **derived from `NEXTAUTH_URL`** (`{origin}/api/admin/xero/callback`) and
shown for copy-paste in the wizard. There are **no**
`XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_REDIRECT_URI`,
`XERO_ENCRYPTION_KEY`, or `XERO_WEBHOOK_KEY` environment variables any more — if
any are still present they are **ignored** and setup readiness raises a warning
naming them for removal (never silently honoured). Credentials are encrypted at
rest with AES-256-GCM under a key derived from `AUTH_SECRET`/`NEXTAUTH_SECRET`
via HKDF-SHA256; the wrapped Xero token-encryption key is auto-generated on
first use (a strong auth secret is required — see the auth-secret note above).

The wizard then finishes the connection (#2081): an optional **Webhooks** step
shows the delivery URL (`{origin}/api/webhooks/xero`), captures Xero's webhook
signing key, and verifies it against Xero's real intent-to-receive ping
(freshness-scoped and key-bound; replacing the key re-arms verification);
account/item **mapping** and the one-time contact **import** follow, ending on a
summary. Webhooks are skippable — until verified, a persistent amber
**"Webhooks not configured — payment updates rely on scheduled sync"** badge
shows on the Xero pages, and a localhost/non-public-HTTPS deployment can't verify
there (the scheduled sync still keeps payments current).

Only these operational-tuning env vars remain (they are not credentials):

| Variable                                   | Description                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| `XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH`     | Enables daily membership refresh behavior when operational Xero is on. |
| `XERO_ENABLE_LIVE_MEMBER_GROUP_LOOKUPS`    | Enables live Xero member group lookups.                                |
| `XERO_ENABLE_AUTOLOAD_XERO_CONTACT_GROUPS` | Enables automatic Xero contact-group loading.                          |
| `XERO_INBOUND_FAILED_RETRY_BACKOFF_MS`     | Optional retry backoff for failed inbound Xero reconciliation.         |
| `XERO_HTTP_TIMEOUT_MS`                     | Optional OAuth-layer HTTP timeout (identity discovery and token requests) in ms; default 10000, overriding xero-node's 3500ms. |

Existing env-configured deployments upgrading past #2079 must re-enter Xero
credentials in-app and reconnect Xero — see the **upgrade runbook** in
`DEPLOYMENT.md`.

## Finance dashboard

### Membership and joining fee authority

Annual membership and joining fee amounts are database configuration, not
environment variables or provider metadata. Membership editors own public
descriptions/listing under `/admin/membership-types`; Finance editors own
effective-dated amounts and family billing members in the Joining Fees and
Annual Membership Fees sections of `/admin/fees`. Joining fees (`JoiningFee`, #1931) key on membership
type × optional age tier, resolved with no legacy mapping fallback; the Family
fee is strictly type-driven (only members assigned the Family type get it — the
composition heuristic is removed). Hut fees remain lodge season/rate
configuration. See `docs/AUTHORITATIVE_FEES.md` for operator rules and the
frozen Xero idempotency contract.

These fee schedules are config-transferable (#1941): the `membership-fees`
category of the configuration transfer tool carries `joining-fees.csv`,
`annual-fees.csv`, and `annual-fee-components.csv` (money in integer cents), so a
club can move its joining-fee and annual-fee schedules — with their per-line Xero
components — between installs. This schedule takes **precedence** over the Xero
**item-code-amount** joining-fee materialisation (#1931 — still live, not
retired): when a bundle carries the joining-fee schedule and the
`membership-fees` category is applied, the authoritative amounts come from these
CSVs and the item-code fan-out is skipped (an import that deselects
`membership-fees` keeps the item-code-amount path, so its joining fees are not
silently dropped). See [`docs/config-transfer/README.md`](docs/config-transfer/README.md).

The consolidated `/admin/fees` page (#1933, E7) shows Hut Fees (per lodge →
season → membership-type × age-tier nightly rates; edits need `bookings:edit`),
Joining Fees, Annual Membership Fees, and (only when `familyBillingMode` is
`BILL_FAMILY_VIA_BILLING_MEMBER`) family billing members; Joining/Annual/family
edits need `finance:edit`, and the page admits any viewer with finance **or**
bookings access. `/admin/fee-configuration` redirects here and `/admin/seasons`
now holds only season windows. Each section loads read-only. Use the section's Edit button to
expose its form and per-row controls; changes are staged locally and only
written when you commit that section (Add/Update fee, or Save billing members).
Leaving a section without committing (Close section on the fee sections, Cancel
on family billing) discards staged changes without an API call, and finance
view-only users see the saved values with no Edit buttons. When the club bills
members individually the family-billing card is hidden entirely, the membership
billing-basis picker omits the per-family option, and any pre-existing
per-family schedule shows a warning prompting an operator to change its basis.

The finance dashboard reads its revenue, cost, and balance figures from the
single operational Xero connection configured above. There are no separate
finance Xero credentials. The finance report sync requires these granular Xero
OAuth scopes:

- `accounting.reports.profitandloss.read`
- `accounting.reports.balancesheet.read`
- `accounting.reports.banksummary.read`

Before reconnecting, update the Xero developer app allowed scopes to include the
exact app request. The redirect URI is **derived from `NEXTAUTH_URL`**
(`{origin}/api/admin/xero/callback`) — there is no `XERO_REDIRECT_URI` env var
any more (#2079) — so confirm `NEXTAUTH_URL` is the deployed origin and that the
derived callback URL (shown in the in-app Xero setup) is listed in the Xero
developer app's redirect URIs. Then reconnect Xero from `/admin/xero` so fresh
tokens carry the current scope set. Access is controlled per member by
`MemberAccessRole` rows. `FINANCE_USER` can read the finance dashboard and
finance viewer APIs; `FINANCE_ADMIN` is the Treasurer bundle and can also run
manager-only finance actions such as manual sync, report mapping writes, and
finance admin routes. `ADMIN` has full admin access, while `LODGE` does not
grant finance access by itself. Mixed-role accounts such as `LODGE` plus
`FINANCE_USER` are valid. The legacy `financeAccessLevel` field is kept
synchronized for compatibility only; finance page and API guards ignore it and
read `MemberAccessRole` rows.

## Email Delivery

| Variable                                 | Description                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `USE_AWS_SES`                            | Boolean toggle (`true`/`false`) to use AWS SES SMTP credentials.                                                                                             |
| `USE_SMTP_RELAY`                         | Boolean toggle (`true`/`false`) to use an external SMTP relay. Exactly one provider flag may be `true` (legacy default is AWS SES when all three are omitted). |
| `USE_LOCAL_CAPTURE`                      | Boolean toggle (`true`/`false`) declaring that the SMTP relay below is a **capture mailbox** that forwards mail nowhere (mailpit, MailHog, a developer's sink). It reads the same four `EMAIL_SERVER_*` settings as `USE_SMTP_RELAY`; only the declaration differs, and nothing is ever inferred from the host name. Its purpose is that a confirmed **non-production** installation may transmit into a capture instead of suppressing every send (ENV-SAFETY 2, #3035 — `INV-CONFIG-004`), which is how the browser suite reads its own mail back. **Leave it `false` on the club's live site:** an installation declaring `APP_ENVIRONMENT_ROLE=production` *and* `USE_LOCAL_CAPTURE=true` is refused, because a live site in capture mode would accept every message and deliver none. It also does NOT cover invoice emails, which the accounting provider sends from its own servers to the member's real address. **On a developer's laptop this is what makes local email work at all:** with `.env.example`'s shipped values (`APP_ENVIRONMENT_ROLE=non-production`, all three provider flags false) every send is held back and the "Email sent (dev mode)" log line never appears — run a capture mailbox, point `EMAIL_SERVER_*` at it, and set this `true`. |
| `SMTP_HOST`                              | SMTP host for AWS SES SMTP mode (defaults to `email-smtp.ap-southeast-2.amazonaws.com` when unset).                                                          |
| `SMTP_PORT`                              | SMTP port for AWS SES SMTP mode (defaults to `587` when unset).                                                                                              |
| `AWS_SES_ACCESS_KEY_ID`                  | SES SMTP/API access key (required when `USE_AWS_SES=true`).                                                                                                  |
| `AWS_SES_SECRET_ACCESS_KEY`              | SES SMTP/API secret key (required when `USE_AWS_SES=true`).                                                                                                  |
| `EMAIL_SERVER_HOST`                      | SMTP relay host (required when `USE_SMTP_RELAY=true` or `USE_LOCAL_CAPTURE=true`).                                                                            |
| `EMAIL_SERVER_PORT`                      | SMTP relay port (required when `USE_SMTP_RELAY=true` or `USE_LOCAL_CAPTURE=true`).                                                                            |
| `EMAIL_SERVER_USER`                      | SMTP relay username (required when `USE_SMTP_RELAY=true` or `USE_LOCAL_CAPTURE=true`).                                                                        |
| `EMAIL_SERVER_PASSWORD`                  | SMTP relay password (required when `USE_SMTP_RELAY=true` or `USE_LOCAL_CAPTURE=true`).                                                                        |
| `EMAIL_CAPTURE_ALLOW_PUBLIC_HOST`        | Boolean toggle (`true`/`false`, default `false`). Allows `USE_LOCAL_CAPTURE=true` when `EMAIL_SERVER_HOST` names a host on the **public internet**, which is otherwise **refused** with every send held back (#3071 review). The refusal exists because that combination was a live defect: an installation already running `USE_SMTP_RELAY` against a real relay, told to "set `USE_LOCAL_CAPTURE=true`", flipped the one flag and kept its live relay host — so a copy emailed the club's real members while the log recorded that the message reached nobody. Accepted **without** this flag: a container or service name (`mailpit`, `mailhog`), `localhost`, any loopback/RFC1918/CGNAT/link-local/unique-local address, and the reserved suffixes `.local`, `.internal`, `.home.arpa`, `.test`, `.invalid`, `.example`. Set this `true` only for a sink that genuinely forwards nothing but has a public name — **nothing verifies that, and nothing can**: a mail server on a private address can relay outward too, so the declaration is what carries it. |
| `EMAIL_FROM`                             | Envelope / Return-Path sender address (bootstrap; must be a provider-verified SES address in production). The ONLY email-identity env var besides transport secrets — from display name, support address, and contact-form recipient are admin-managed DB-first (Admin > Email Messages). |
| `SES_SNS_TOPIC_ARN`                      | SNS topic ARN for SES bounce/complaint webhooks (required for full SES feedback handling when `USE_AWS_SES=true`).                                           |
| `SES_SNS_ALLOW_UNSAFE_MISSING_TOPIC_ARN` | Local/dev escape hatch only; never enable for deployed SES feedback ingestion.                                                                               |
| `SES_SNS_ALLOW_SIGNATURE_V1`             | Temporarily permit legacy SNS SignatureVersion 1 (SHA1). Default rejects v1; enable SignatureVersion 2 on the SNS topic and leave this unset in production.   |
| `BULK_SENDMAIL_LIMIT`                    | Admin bulk-communication sends allowed per hour (default `1`).                                                                                               |

## Address Autocomplete

| Variable          | Description                                     |
| ----------------- | ----------------------------------------------- |
| `ADDY_API_KEY`    | Addy API key for server-side address search.    |
| `ADDY_API_SECRET` | Addy API secret for server-side address search. |

Address autocomplete is also controlled by Admin > Modules and defaults off.
The server-side `/api/address-autocomplete/**` proxy is unavailable while the
module is disabled, before any Addy call can run. If the module is enabled but
either Addy credential is missing, Admin Setup reports the module as blocked.
The credentials stay server-side and are never returned in setup/module JSON
payloads. Address fields remain normal editable inputs in every state, so users
can save a full manual address when autocomplete is disabled, unconfigured,
rate-limited, or temporarily unavailable.

## Sentry

| Variable                                  | Description                                                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `SENTRY_DSN`                              | Server/edge Sentry DSN.                                                                                          |
| `NEXT_PUBLIC_SENTRY_DSN`                  | Browser Sentry DSN.                                                                                              |
| `SENTRY_ORG`                              | Sentry organization slug for source map uploads.                                                                 |
| `SENTRY_PROJECT`                          | Sentry project slug for source map uploads.                                                                      |
| `SENTRY_AUTH_TOKEN`                       | Sentry auth token for source map uploads during build.                                                           |
| `OBSERVABILITY_SENTRY_DEDUP_COOLDOWN_MS` | Optional in-process cooldown for Sentry event deduplication, shared by the cron/webhook bridge and the auth-bounce anomaly alert (#1669); defaults to 300000 ms. |
| `AUTH_BOUNCE_AUDIT_MAX_WRITES_PER_MINUTE` | Optional per-process cap on durable auth-bounce `AuditLog` rows per minute (#1669); suppressed rows are tallied onto the next written row. Defaults to 10. |

## Cron, Waitlist, And Backups

| Variable                              | Description                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `CRON_ENABLED`                        | Enables scheduled jobs in a runtime. Blue/green web slots set this `false`. |
| `CRON_LEADER_RUNTIME_STATUS_URL`      | Optional internal URL Admin > System Health uses to query the cron leader's runtime status (Compose defaults to the `app` service). |
| `WAITLIST_OFFER_HOURS`                | Waitlist offer expiry window; defaults to 48 hours.                         |
| `GROUP_SETTLEMENT_REAP_HOURS`         | Stale organiser-pays group settlement window; defaults to 48 hours (clamped to the group's check-in, 2-hour floor). |
| `GROUP_CANCEL_RESUME_GRACE_MINUTES`   | Grace before the group-settlement-reaper resumes a crash-interrupted organiser-cancel cleanup (#1236); defaults to 15 minutes. |
| `WAITLIST_TRANSACTION_RETRY_ATTEMPTS` | Optional waitlist transaction retry count.                                  |
| `WAITLIST_TRANSACTION_RETRY_DELAY_MS` | Optional waitlist transaction retry delay.                                  |
| `NODE_BUILD_OPTIONS`                  | Optional Node flags for `docker compose build` only, applied to `next build` as `NODE_OPTIONS` inside the builder stage. Empty by default. Typically `--max-old-space-size=4096` where a small server's build is OOM-killed. Does NOT affect the running container. |
| `BACKUP_CRON_SCHEDULE`                | Cron expression for the nightly backup schedule (cron-leader timing).       |
| `BACKUP_LOCAL_HOST_DIR`               | Host directory bind-mounted into the app container for local database backups. Used only by `docker-compose.yml`; empty uses the `backup_data` named volume instead. Must be owned by uid 1001. |
| `BACKUP_LOCAL_DIR`                    | Path **inside the container** that mount lands on (default `/backups`). What the app writes to, and the value `/admin/backups` pre-fills. A path saved on that page overrides it. |
| `AUDIT_ARCHIVE_DATABASE_URL`          | Preferred optional archive database for audit retention.                    |
| `AUDIT_LOG_ARCHIVE_DATABASE_URL`      | Backward-compatible archive database alias.                                 |
| `SHADOW_DATABASE_URL`                 | Optional Prisma shadow database URL for migration validation.               |
| `AI_DIAGNOSTICS_DATABASE_URL`         | Dedicated **non-superuser, SELECT-only** database role for AI Diagnostics tool reads (ADR-007). Required before the AI Diagnostics module can be used; never the app's `DATABASE_URL`. Provision with `npm run diagnostics:provision-role`. See [`docs/ai-diagnostics/deployment.md`](docs/ai-diagnostics/deployment.md). |

> **Backups are configured in-app, not by environment (#2095).** The S3 bucket,
> region, access key/secret, retention window, restore-validation shadow
> database URL, and the enabled switch all live in the encrypted
> `IntegrationCredential` store and are managed at **Admin → Integrations →
> Database Backups**. First-time setup uses the guided wizard
> (`/admin/backups/setup` — S3 credentials → destination → nightly schedule → a
> real verification run); the flat page (`/admin/backups`) is the post-setup
> editing surface. The legacy `BACKUP_ENABLED`,
> `BACKUP_S3_BUCKET`, `BACKUP_S3_REGION`, `BACKUP_S3_ACCESS_KEY_ID`,
> `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_RETENTION_DAYS`, and
> `BACKUP_RESTORE_VALIDATION_URL` variables are **no longer read**: a deployment
> that still sets them sees a "no longer used — re-enter in-app, then remove from
> the environment" warning on the Backups page. `BACKUP_CRON_SCHEDULE`,
> `BACKUP_LOCAL_HOST_DIR` and `BACKUP_LOCAL_DIR` are the exceptions and remain
> environment variables, because they are deployment infrastructure rather than
> club configuration: cron-leader timing, and where a volume is mounted. The two
> `BACKUP_LOCAL_*` variables are a PAIR describing the two ends of one mount —
> the host directory and the container path it appears at — and entering a HOST
> path on the Backups page cannot work: the container has a read-only filesystem
> and cannot see or create it. See
> [`docs/guides/backups.md`](docs/guides/backups.md#setting-the-directory-on-a-docker-deployment). The S3 access key/secret and the restore-validation DSN
> are write-only and never returned to the browser or an audit row; the S3
> destination (bucket/region) and credentials can only be changed by a Full
> Admin.

## Legacy Finance Bridge

| Variable                        | Description                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LEGACY_DASHBOARD_EXPORT_TOKEN` | Shared bearer token for the legacy dashboard export bridge. Leave empty to disable the export bridge unless you still run it; do not store this token in the database or client-side code. |

## Deployment And Compose

| Variable                               | Description                                                           |
| -------------------------------------- | --------------------------------------------------------------------- |
| `DOMAIN`                               | Public domain used by Caddy.                                          |
| `COMPOSE_PROJECT_NAME`                 | Docker Compose project name; defaults vary by script.                 |
| `APP_IMAGE`                            | Prebuilt app image override for blue/green deployment.                |
| `MIGRATE_IMAGE`                        | Prebuilt migration image override for blue/green deployment.          |
| `GHCR_APP_IMAGE_REPOSITORY`            | App image repository used by the production wrapper.                  |
| `GHCR_MIGRATE_IMAGE_REPOSITORY`        | Migration image repository used by the production wrapper.            |
| `GHCR_READ_TOKEN`                      | Example token name for logging a host into GHCR with `read:packages`. |
| `SOURCE_REPO`                          | Source checkout used by the production wrapper.                       |
| `DEPLOY_REF`                           | Git ref deployed by the production wrapper, default `origin/main`.    |
| `FETCH_LATEST`                         | Whether the wrapper fetches before resolving `DEPLOY_REF`.            |
| `DEPLOY_WORKSPACE_ROOT`                | Parent directory for clean deploy workspaces.                         |
| `SYNC_SOURCE_REPO_AFTER_DEPLOY`        | Whether the wrapper syncs the source checkout after deploy.           |
| `PRUNE_STALE_DEPLOY_WORKSPACES`        | Whether the wrapper removes stale deployment workspaces.              |
| `PROJECT_DIR`                          | Low-level blue/green deploy project directory.                        |
| `HEALTH_TIMEOUT_SECONDS`               | Readiness wait timeout for blue/green deploy.                         |
| `DEPLOY_WARMUP_ENABLED`                | Whether the pre-cutover warm-up gate runs at step 16 of 20 (#2566). Default `1`; `1`, `true`, `yes`, and `on` enable it and any other value disables it. Disabling is refused unless `DEPLOY_WARMUP_OVERRIDE_REASON` is also set. |
| `DEPLOY_WARMUP_OVERRIDE_REASON`        | The written justification required when `DEPLOY_WARMUP_ENABLED` is off. Default empty. Printed in the deploy log and repeated after the completion banner. |
| `DEPLOY_WARMUP_SERVICES`               | Which app services the gate warms, space-separated. Default empty, meaning the target colour plus the `app` cron leader. Only `app`, `app_blue`, and `app_green` are accepted, and a value that resolves to no services is refused rather than treated as "nothing to check". |
| `DEPLOY_WARMUP_CONCURRENCY`            | Warm-up requests in flight at once. Default `3`, accepted `1`-`8`.     |
| `DEPLOY_WARMUP_REQUEST_TIMEOUT_SECONDS` | Per-request ceiling for one warm-up request. Default `20`, accepted `1`-`120`. |
| `DEPLOY_WARMUP_TOTAL_TIMEOUT_SECONDS`  | Whole-gate ceiling, applied **per warmed service**. Default `240`, accepted `5`-`1800`; with the default two services the gate can add up to 480s to the migrate-to-cutover window. |
| `DEPLOY_WARMUP_MAX_FAILED_CMS_ROUTES`  | The count half of the tolerated non-critical CMS failures. Default `1`, accepted `0`-`100`. |
| `DEPLOY_WARMUP_MAX_FAILED_CMS_PERCENT` | The percentage half of the same tolerance. Default `10`, accepted `0`-`100`. Both halves must hold, so a club with fewer than ten published pages tolerates none. Ranges are enforced by the deploy script and again by the endpoint — see `DEPLOYMENT.md` → "Pre-cutover warm-up gate". |
| `PRUNE_UNTIL`                          | Docker prune age window used by deploy scripts.                       |
| `FORCE_NO_CACHE`                       | Forces local Docker rebuilds without cache.                           |
| `SKIP_APP_IMAGE_BUILD`                 | Skips local app image build when using prebuilt images.               |
| `BLUE_GREEN_DRAIN_SECONDS`             | Drain window for previous blue/green slot.                            |
| `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS` | Explicit migration safety override.                                   |
| `BLUE_GREEN_MIGRATION_OVERRIDE_REASON` | Required explanation when allowing a breaking migration.              |
| `MIGRATION_SAFETY_LEDGER`              | Path to the migration safety ledger.                                  |
| `RELEASE_ID`                           | Docker **build** arg, not a runtime setting. Identifies the release, and the public website's fixed CSP script nonce is derived from it (#2352). CI and `scripts/run-production-blue-green-deploy.sh` set it to the deployed commit SHA automatically; `docker-compose.yml` falls back to `GIT_COMMIT_SHA`. If neither is set — a hand-rolled `docker build` — the nonce falls back to a random per-BUILD seed baked into the bundles, which is still one value per release; you only lose the ability to read the deployed revision out of the image. Leave it alone unless you build images by hand — see "Public website page caching" below. |
| `CONFIG_BUNDLE_IMPORT_PATH`            | Optional. Path to a config-transfer bundle applied non-interactively on boot **only** when the database is empty of non-seed configuration (DR / clone provisioning, ADR-003). Fails closed on a non-empty target, a bad bundle, or an unreadable path, and never blocks startup. See "Config Bundle Auto-Import On Boot (DR / clone)" in `DEPLOYMENT.md`. |

## Staging And Accessibility

| Variable                | Description                                              |
| ----------------------- | -------------------------------------------------------- |
| `STAGING_HTTP_PORT`     | Host port for the staging app.                           |
| `STAGING_POSTGRES_PORT` | Host port for the staging PostgreSQL service.            |
| `STAGING_APP_URL`       | Base URL for staging checks.                             |
| `STAGING_CADDY_SITE`    | Caddy site address for local staging.                    |
| `STAGING_A11Y_PATHS`    | Comma-separated paths for Lighthouse checks.             |
| `STAGING_A11Y_OUT_DIR`  | Output directory for Lighthouse reports.                 |
| `LIGHTHOUSE_BIN`        | Optional Lighthouse command override.                    |
| `PRODUCTION_APP_URL`    | Optional guard URL that staging checks refuse to target. |

## Public CI And Forks

Public forks should keep live provider credentials out of GitHub Actions. Use
Stripe test mode, Xero demo tenants, SES sandbox credentials, and non-production
databases for validation.
