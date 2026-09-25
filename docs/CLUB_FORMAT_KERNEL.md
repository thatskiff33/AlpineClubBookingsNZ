# The club-format kernel

Audience: Developer, Agent.

`@/lib/club-format-*` is the one place this product turns an integer-cent amount,
a proportion or a count into a string a person reads. If you are about to write
out money, a percentage or a ratio, it goes through here.

The rule it enforces is `INV-CONFIG-006` (in
[`invariants/product-configuration.md`](invariants/product-configuration.md)),
with `INV-SSOT-001` (in
[`invariants/single-source-of-truth.md`](invariants/single-source-of-truth.md))
for the one-home part. This page is the developer contract; it states no rule of
its own.

**It is deliberately the same shape as the club-time kernel**
([`CLUB_TIME_KERNEL.md`](CLUB_TIME_KERNEL.md)), which met the identical problem
for the timezone and solved it first. Where the two agree, the reasoning lives
there and is not restated here.

## Where the currency and locale come from

One ISO 4217 code and one BCP 47 tag, persisted in `ClubFormatSettings` and
edited in the admin panel (#3563). Not `process.env`, not the server's machine,
and above all **not the viewer's browser**: a member reading the site in London
must see the same club currency, the same thousands separator and the same
decimal mark as a member reading it in Ohakune. `Intl.NumberFormat()
.resolvedOptions()` answers for the viewer, so it is never the source.

## The four modules, and which one you want

| Module | What it is | Who imports it |
| --- | --- | --- |
| `club-format.ts` | the shape, the validators, the `ClubFormat` type | anyone, including the browser |
| `club-format-intl.ts` | the ONE `new Intl.NumberFormat` for rendering, memoised | only the two formatter modules |
| `club-format-bound.ts` | `bindClubFormat(format)` → the operations with the format closed over | anyone, including the browser |
| `club-format-server.ts` | `clubFormat()` / `clubFormatValues()`, request-scoped | a server component, route handler, cron or webhook — the entry point, which passes the result down |

`formatCents` / `formatSignedCents` stay in `@/lib/utils` and the finance
dashboard's renderings stay in `@/lib/finance-format`, because those are the
imports a hundred call sites already carry and moving them would have been churn
with no reader. What changed is that each takes the club's `format`, and takes it
as a **required** argument: there is no one-argument spelling, so a call site
that forgets the club's format does not compile.

## The same interface on both sides of the network

```ts
// server
const money = await clubFormat();
money.cents(booking.finalPriceCents);

// client — bound on a format that arrived as data
const money = bindClubFormat(props.clubFormat);
money.cents(booking.finalPriceCents);
```

The method names are identical, so a component that moves between server and
client changes the line that obtains the binding and nothing else.

**The underlying functions stay explicit** — `formatCents(cents, format)` —
because explicit is right at a boundary, and the binding is what makes it
bearable inside a component that renders fifteen amounts. That is the club-time
kernel's reasoning, unchanged.

## The caching contract

`clubFormat()` and `clubFormatValues()` are wrapped in React `cache()`:
request-scoped, with no invalidation contract at all. The admin route that changes the club's currency
cannot forget to bust anything, and the very next request reads the new value.
Outside a render pass — a cron tick, a webhook, a script — `cache()` degrades to
"no memo", which is correct: those are not requests. The `Intl` memo in
`club-format-intl.ts` is unaffected either way, so an uncached call costs one
primary-key read, never a rebuilt formatter.

## Which reader a given module wants

- **In a render pass or a request** — `clubFormat()` for the operations, or
  `clubFormatValues()` when what you need is the two VALUES: a prop for a
  `"use client"` child, or an argument for a `src/lib` helper that renders
  several amounts of its own. They share one memo, so a component that takes the
  values and a component below it that takes the binding cost one read between
  them. **Not the raw `getClubFormat()`** — React `cache()` memoises per function
  identity, so a call that bypasses these two is a second read of the same
  one-row table in the same pass. `club-format-provider-mount-census.test.tsx`
  holds that closed for the three surfaces that hand the format to the browser.
- **A `src/lib` module a `tsx` entry point can reach** — take
  `money: BoundClubFormat` (or `format: ClubFormat`) as a parameter, threaded
  from whoever is in the request. This is what keeps such a module off the
  `server-only` graph, where an import would throw before `main()` runs.
- **A `src/lib` module that already imports `@/lib/prisma`** — it is already
  inside that boundary, so `getClubFormat()` from `@/lib/club-format-settings`
  adds no new reach.
- **A `"use client"` module** — never read it; receive the resolved format as
  data and call `bindClubFormat`.

## What does NOT take a format

`formatCentsPlain` renders `(cents / 100).toFixed(2)` — no symbol, no grouping,
no locale — because it seeds an editable amount box and a report line that
already reads as a delta. There is nothing there for a club's format to change,
and localising a form field's value would be a defect rather than an
improvement. It stays one-argument, permanently.

## The format is required, and the compiler is the census

Stage 3 of programme
[#3205](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3205)
([#3565](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3565)) moved
every call site in one change, by the owner's decision of 23 Sep 2026. There is
**no one-argument overload and no transitional module**: `formatCents(cents)` is
a type error, so a screen, an email or a line of Xero text that forgets the
club's format cannot be built. That is the unrepresentable-over-policed shape
`INV-SSOT` prefers, and it replaced the counted ratchet the migration briefly
carried — a scanner counting arities cannot see a signature widened back to
optional, and the compiler can. `club-format-kernel.test.ts` pins that with a
`@ts-expect-error` per rendering, which turns a re-added optional parameter into
an "unused directive" compile error under `tsc -p tsconfig.test.json`.

**Stage 3 was money only**, by the owner's decision on #3565: every currency
amount, percentage and count. The DATE locale moved in stage 4
([#3566](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3566)) —
see "Dates take the same format" below.

The rules that make a required argument bearable, and that every call site now
follows:

- **The server resolves once per request or run, before any transaction or
  lock.** A route handler, server page, cron, webhook or script calls
  `await clubFormatValues()` (or `clubFormat()`) at the top and passes the result
  down. Never per amount, never inside a transaction callback, and never inside
  a library function a handler calls — outside a React render `cache()` gives
  no memo, so a helper that resolved for itself would read the setting once per
  email in a batch.
- **Email templates and Xero text builders take the format from their
  caller.** They are synchronous functions the sender or the outbox drives, so
  they take `format: ClubFormat` (positional, before the first optional
  parameter, or as a required property of their params object) and never look
  it up.
- **A `"use client"` component reads the stage 2 provider** —
  `useClubFormat()` for the values, or `bindClubFormat` on them for the
  operations — and never imports `club-format-server`.
- **A `src/lib` module a client file can reach takes a parameter**, so it stays
  off the `server-only` graph.

A club on the shipped New Zealand defaults sees byte-identical output on every
surface, including email bodies and the text written to Xero, which
`club-format-kernel.test.ts` proves against the retired module constants and the
email and Xero suites prove on their rendered output. `APP_CURRENCY` /
`APP_LOCALE` remain only as the seed-only environment reading `resolveClubFormat`
falls back to when nothing is persisted; since #3566 no module outside
`src/config/operational.ts` reads either (the seed reader, `club-format-env.ts`,
aside), and #3567 retires them.

## Dates take the same format (#3566)

Stage 4 made the club-time kernel's date renderings take the club's format the
same way money does, by the owner's decision of 25 Sep 2026. Every exported
rendering in `club-time/format.ts` ends in a **required** `format:
ClubDateFormat` — `Pick<ClubFormat, "locale">`, so any `ClubFormat` satisfies
it and a date does not depend on the currency — and `club-time/intl.ts` no
longer imports `APP_LOCALE`. `house-shapes.test.ts` carries one
`@ts-expect-error` per rendering, the same TS2578 lock as above.

- **Bound calls did not change.** `bindClubTime(zone, format)` closes over
  both, and `clubTime()` binds the persisted zone with `clubFormatValues()` —
  the same memo the money kernel and the providers read — so
  `clubTime.instantDate(x)` and friends take neither. `BoundClubTime.format`
  hands the locale to the zone-free calendar renderings.
- **In the browser**, `ClubTimeProvider` takes a required `locale` prop beside
  `zone`, the value `ClubFormatProvider` receives. A prop rather than an internal
  `useClubFormat()` read because the root-404 embeds mount it outside both
  chromes, where no `ClubFormatProvider` exists.
- **Emails** read the locale from the same boot-primed, five-minute cache that
  gives them the club's zone (`email-templates-club-time.ts`, owner decision 2),
  so their date calls are unchanged. The stated cost: email dates can lag a
  locale change by up to five minutes, and the compiler does not check that
  path — the render pins and the seam's own tests do.
- **The projection formatters stay `en-US`.** `clubZoneParts` and
  `clubZoneDateString` parse their parts back into numbers, and a club locale
  with non-Latin digits would break that; they render nothing a person reads.
- **The memo is keyed on the locale too** — `display|locale|zone|shape` — so the
  first locale asked for cannot win for the life of the process.

The AI spend conversion takes the club's STORED currency on the same terms
(`loadAiSpendCurrency(clubCurrency, db?)`); its price table stays in NZD, the
currency it is written in. A currency change clears the stored rate in the
club-format route's own transaction, because the rate records no currency.

## Adding a new rendering

Declare the shape in `club-format-intl.ts` beside the others and expose it from
the module the callers already import. **Never construct another
`Intl.NumberFormat`**: `club-format-kernel.test.ts` fails a second one anywhere
under `src/`, and the `INV-CONFIG-001` lint arms independently refuse a literal
locale or currency code, with no exemption list and no `eslint-disable`.
