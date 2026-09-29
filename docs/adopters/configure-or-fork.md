# Configure, don't fork

Audience: Adopter, Operator, Developer

This is the canonical guide to the question every club hits in its first week:
*"the product doesn't do what my club needs — do I change the code?"*

Almost always, no. This repository is the **generic product**. Each deployment
serves exactly one club, but the codebase itself must never encode which club.
Everything that differs between clubs — capacity, rates, age tiers, wording,
branding, which capabilities exist at all, and most policy — is a value you
supply, not a line you edit.

The test to apply, every time:

> **Would a different club answer this question differently?**

If yes, the answer belongs on one of the first three levers below, and a code
change that hard-codes your answer is a bug in the product rather than a feature
of your fork.

## The four levers, in the order to try them

### 1. Module toggle — "my club doesn't want this at all"

A **module** switches a whole capability on or off for the deployment: its admin
pages, sidebar entries, public widgets, API routes and background work all
appear or disappear together. Kiosk, chores and roster, waitlist, Xero, bed
allocation, lobby displays, group bookings, lockers, two-factor, and the two AI
assistants are all modules.

- **Where:** Admin → Setup & Configuration → Modules (`/admin/modules`).
- **The live list:** [Modules](../guides/modules.md) names every module, what it
  enables, and its out-of-the-box default. Capability modules that need
  deploy-time setup default off; general-purpose ones default on.
- **Reach for it when** the capability is genuinely optional for a club — when
  some clubs would want it and others would not want it visible at all.

A module toggle holds no secrets. A module that also needs credentials or
inventory shows **Needs setup** until they exist, rather than failing at the
point of use.

### 2. Setting — "the capability is right, the value isn't"

A **setting** is a stored value an admin edits in the app. Cancellation refund
tiers, minimum stay, group discount, the subscription lockout policy, booking
request rules, member-guest consent policy, hut-leader label, notification
recipients, email wording, public page content, colours and fonts are all
settings.

- **Where:** the relevant admin area, and the setup hub at `/admin/setup`.
- **Reach for it when** every club needs the capability but each supplies its
  own value or policy.
- Settings are stored in the database and take effect immediately. They do not
  need a redeploy, a `.env` edit, or a restart.

**Install-time configuration** is the same lever, one layer down.
`config/club.json` holds the values needed *before* an admin can sign in — club
name, short name, public URL, contact addresses, bed capacity, age tiers and
their integer-cent nightly rates. `pnpm run setup:wizard` writes it for you.
[`../../CONFIGURATION.md`](../../CONFIGURATION.md) is the full reference for it
and for every environment variable. Some of these values, including club name
and the hut-leader label, can be overridden later from Admin → Appearance →
Club Identity without touching the file.

Provider credentials — Stripe, Xero, SES, Sentry, the AI keys, the backup
destination — are **not** `.env` edits in current releases. They are entered
in-app, encrypted at rest, through the wizards in the relevant admin area.

### 3. Seed default — "the starting value is wrong for everyone"

A **seed default** is the value a fresh install begins with: the seeded
permission bundles, the starter public pages, the default email templates, the
default site style, the baseline chore templates. An admin can change any of
them afterwards; the seed decides only where they start.

- **Where:** `prisma/seed.ts` and `prisma/seed-data.ts`, plus the defaults
  declared alongside each setting.
- **Reach for it when** the value is a *setting* already, but the shipped
  starting point is a poor default for a typical club — not just for yours.
- The seeded content is deliberately generic and token-driven: starter pages
  fill in `{{club-name}}`, `{{lodge-name}}` and `{{lodge-capacity}}` at render
  time rather than naming a club, and a guard test keeps club-specific names out
  of them.

Changing a seed default is a change to the **product**, so it goes upstream. It
is not a way to bake your club into your own copy — a fork that edits the seed
to hold its own club's data has just made every future upgrade harder.

### 4. Code change — "no configuration surface exists for this"

Reach for code when the behaviour genuinely is not expressible through the
generic model: a new capability, a new admin surface, a new integration, a fix.

When you do, build the configuration surface at the same time. The rule the
product holds itself to is
[`INV-CONFIG-001`](../invariants/product-configuration.md#inv-config-001), which
is its binding home; in plain terms:

- A new value or feature a club could reasonably want differently gets an
  explicit configuration surface — a module, a setting, or a seed default.
- An upgrade that introduces a new setting falls back to a safe documented
  default rather than hard-failing because the setting is absent.
- Where an operator has to act, the unconfigured state is visible — the
  readiness badge, the setup checklist, or the system health page — instead of
  failing silently at the point of use.

Then send it upstream: [Contribute a change upstream](upstream-contributions.md)
covers how to tell a reusable improvement from club-specific configuration, and
how to prepare it. [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) is the
canonical contribution process.

## What legitimately stays in your own fork

Not everything belongs upstream. Keep in your deployment fork or its
environment:

- your club's `config/club.json`, real branding assets, and logos;
- production identifiers, domains, and service credentials;
- operational data fixes for your own database;
- deployment-only behaviour specific to your hosting.

Keep these out of the public repository entirely — no real hostnames,
usernames, filesystem paths, server topology, or credentials.

## Quick reference

| Your situation | Lever | Where |
| --- | --- | --- |
| We don't want this feature at all | Module toggle | [Modules](../guides/modules.md) |
| We want it, with our own value or policy | Setting | The relevant admin area, [Setup](../guides/setup.md) |
| We need it before an admin can log in | Install-time config | [`../../CONFIGURATION.md`](../../CONFIGURATION.md) |
| The shipped starting value is wrong for everyone | Seed default | `prisma/seed.ts`, then upstream |
| Our branding and wording | Setting | [Site Style](../guides/site-style.md), [Page Content](../guides/page-content.md) |
| No configuration surface exists | Code change | [Contribute upstream](upstream-contributions.md) |
| Our domain, credentials, real assets | Neither — deployment-local | [`../../DEPLOYMENT.md`](../../DEPLOYMENT.md) |

## Related links

- Back to [Run this for your club](README.md).
- [`../IMPLEMENTATION_GUIDE.md`](../IMPLEMENTATION_GUIDE.md) — the practical
  configuration walkthrough.
- [`../../CONFIGURATION.md`](../../CONFIGURATION.md) — every environment
  variable and the `config/club.json` schema.
- [Contribute a change upstream](upstream-contributions.md) — getting a reusable
  change into the product.
