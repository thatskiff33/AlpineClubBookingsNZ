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
| `club-format-server.ts` | `clubFormat()` / `clubFormatValues()`, request-scoped | a server component, route handler, cron or email builder |

`formatCents` / `formatSignedCents` stay in `@/lib/utils` and the finance
dashboard's renderings stay in `@/lib/finance-format`, because those are the
imports a hundred call sites already carry and moving them would have been churn
with no reader. What changed is that each takes the club's `format`.

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

`clubFormat()` is wrapped in React `cache()`: request-scoped, with no
invalidation contract at all. The admin route that changes the club's currency
cannot forget to bust anything, and the very next request reads the new value.
Outside a render pass — a cron tick, a webhook, a script — `cache()` degrades to
"no memo", which is correct: those are not requests. The `Intl` memo in
`club-format-intl.ts` is unaffected either way, so an uncached call costs one
primary-key read, never a rebuilt formatter.

## Which reader a given module wants

- **In a render pass or a request** — `clubFormat()`.
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

## The migration window, and how it ends

Programme [#3205](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3205)
moves the call sites in groups so each ships green. Until the last group lands,
every rendering also has a **deprecated one-argument overload**, which resolves
through `club-format-transitional.ts` — the environment's `APP_CURRENCY` /
`APP_LOCALE`, exactly what the call site rendered with before. It cannot reach
the persisted setting and no version of it could: `@/lib/utils` is on the
browser's import graph and the persisted format is an asynchronous `server-only`
read.

So while the window is open, a club that has CHANGED its currency sees the
persisted one on migrated surfaces and the environment's on the rest. A club on
the shipped defaults sees no difference at all, which is proven byte-for-byte in
`club-format-kernel.test.ts`. #3567 deletes `club-format-transitional.ts`, at
which point the compiler names every remaining one-argument caller.

## Adding a new rendering

Declare the shape in `club-format-intl.ts` beside the others and expose it from
the module the callers already import. **Never construct another
`Intl.NumberFormat`**: `club-format-kernel.test.ts` fails a second one anywhere
under `src/`, and the `INV-CONFIG-001` lint arms independently refuse a literal
locale or currency code, with no exemption list and no `eslint-disable`.
