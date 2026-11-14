# Public authoritative content

Audience: Developer, Agent.

Prefix defined in this file: **`INV-PUB`** — what the public site is allowed to
publish: fee and policy page content, effective-dated public fees, and lodge
token resolution.

Read this file when you are changing public fee or policy page content, public
fee resolution, or named lodge tokens and the view models built from them.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) — every `INV-*` ID
with a one-line description of what it covers. ID scheme and allocation rules:
[`SCHEME.md`](SCHEME.md).

Every heading below whose whole text is an `INV-*` ID defines that invariant. IDs
are permanent: never renumbered, never reused. **The text under each ID is a
verbatim move from the source document and must not be reworded in place** —
only the ID heading lines were added.

## INV-PUB-001

- Fee/policy PageContent blocks are explicitly enabled and server-rendered; a
  token alone publishes nothing.

## INV-PUB-002

- Public fees use current effective-dated schedules. Joining fees resolve from
  the `JoiningFee` schedule (membership type × age tier) only — no legacy Xero
  mapping-amount fallback.

## INV-PUB-003

- Named lodge tokens resolve exactly one active lodge or no data, never the
  default lodge. Public view models exclude ids, provider codes, and secrets.

## INV-PUB-004

The `{{data-hosting}}` page-body token (#4918) publishes only the two values an
admin typed into `PrivacyHostingSettings` (`hostingProvider`, `dataLocation`),
or fixed fallback wording for a blank one. It never derives a value from the
environment, a credential, the backup region, the mail host or a cloud lookup.

- **One sentence, one module.** `dataHostingSentence` in
  `src/lib/privacy-hosting.ts` builds the raw sentence for all four states; the
  renderer escapes the whole sentence once through `escapeHtmlText`, never the
  values first.
- **Plain text only.** Each value is trimmed, one line, no control characters
  or bidi override and isolate controls, at most 120 characters; blank is
  stored as null.
- **Page bodies only.** The catalogue entry allows `page-content-body` and no
  other context.
- **Release boundary.** A release that lacks a token publishes it verbatim, so
  starter text may use `{{data-hosting}}` only in a release after one that
  renders it has shipped.
- Proof: `privacy-hosting.test.ts`, `page-content-embeds.test.ts`,
  `token-catalogue.test.ts`.
