# Word-budget register: approved exceptions and migration ratchet

Audience: Developer, Agent.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) · the rule this
register serves: [`SCHEME.md`](SCHEME.md) §8.1 · deciding issue: #2789.

Every invariant entry is at most **300 words** and every index-row description
at most **12 words** (`SCHEME.md` §8.1). This file is the only place an entry
may be allowed more, and `npm run docs:indexcheck` reads it: an id listed here
is held to the limit on its row, an id not listed here is held to 300, and the
index cap has no register at all. **Nothing in this file is a rule and nothing
here has an id**; it is an inventory the gate enforces exactly, so a row that is
stale, duplicated, malformed or for an id nothing defines fails the check.

To read a figure the way the gate does, run
`node scripts/ci/check-doc-index-integrity.mjs --words`. Do not measure with a
script of your own: two instruments that measure differently agree where both
are blind (`INV-SSOT-004`).

## Approved exceptions

An entry may exceed 300 words only where it is genuinely one atomic standing
rule that cannot be split or compacted without semantic damage or artificial
fragmentation. Convenience, history, copied rationale, rejected alternatives
and narrative are not reasons. Each row is an owner approval taken on the
deciding issue, and the ceiling on the row is the exact number CI enforces.
The reason may not contain a `|`, even inside backticks (cells are split on pipes). Exact form, one row per id:

| ID | Ceiling | Deciding issue | Reason |
| --- | ---: | --- | --- |

There are no approved exceptions yet. Candidates are proposed on #2789 as the
compaction waves reach them; until the owner approves one, an oversize entry is
migration debt below.

## Migration ratchet

Temporary. Each row is the exact word count an oversize entry had when it was
last measured, and the gate holds the entry to that number: it may only shrink
(record the new count when it does) and it leaves this table the moment it is
within budget. A compliant entry can never join it. One row is a restore rather than a
regression: `INV-CAP-027` measured 317 words on the epic base (82f820dfb), was
briefly 298 after a lossy rewrite, and stands at 303 with its original wording
put back — a shrink against the base. When the last row goes,
delete this section — and when the exceptions table is also empty, delete this
file; the checker treats an absent register as "no exceptions, no debt".

| ID | Words |
| --- | ---: |
| `INV-MOD-025` | 4650 |
| `INV-MOD-028` | 4377 |
| `INV-ADDPAY-037` | 2769 |
| `INV-SSOT-004` | 2658 |
| `INV-HOST-050` | 2220 |
| `INV-PRIV-012` | 2159 |
| `INV-CONFIG-005` | 1742 |
| `INV-HOST-046` | 1726 |
| `INV-HOST-045` | 1680 |
| `INV-ADDPAY-039` | 1570 |
| `INV-MOD-027` | 1538 |
| `INV-SSOT-001` | 1531 |
| `INV-PRIV-016` | 1512 |
| `INV-OPS-013` | 1508 |
| `INV-HOST-051` | 1443 |
| `INV-HOST-053` | 1434 |
| `INV-CONFIG-004` | 1304 |
| `INV-OPS-012` | 1219 |
| `INV-SSOT-003` | 1161 |
| `INV-ADDPAY-036` | 1137 |
| `INV-ADDPAY-038` | 1032 |
| `INV-HOST-052` | 1010 |
| `INV-HOST-043` | 1003 |
| `INV-CONFIG-002` | 909 |
| `INV-MONEY-003` | 869 |
| `INV-ADDPAY-034` | 828 |
| `INV-MOD-026` | 828 |
| `INV-PRIV-011` | 814 |
| `INV-HOST-041` | 794 |
| `INV-DATE-013` | 781 |
| `INV-GUEST-016` | 781 |
| `INV-INT-016` | 762 |
| `INV-HOST-049` | 715 |
| `INV-HOST-029` | 707 |
| `INV-MOD-021` | 672 |
| `INV-LIFE-062` | 645 |
| `INV-ADDPAY-017` | 637 |
| `INV-PRIV-013` | 627 |
| `INV-MOD-006` | 623 |
| `INV-HOST-042` | 607 |
| `INV-LOCK-002` | 589 |
| `INV-CONFIG-003` | 578 |
| `INV-LIFE-042` | 562 |
| `INV-OPS-014` | 561 |
| `INV-ADDPAY-030` | 559 |
| `INV-LIFE-064` | 516 |
| `INV-LOCK-004` | 512 |
| `INV-HOST-044` | 506 |
| `INV-EXCEPT-009` | 505 |
| `INV-INT-017` | 489 |
| `INV-PRIV-015` | 458 |
| `INV-LIFE-054` | 449 |
| `INV-LIFE-024` | 431 |
| `INV-DATE-026` | 430 |
| `INV-PRIV-014` | 425 |
| `INV-DATE-025` | 418 |
| `INV-MOD-017` | 412 |
| `INV-OPS-001` | 408 |
| `INV-HOST-028` | 404 |
| `INV-HOST-033` | 396 |
| `INV-ADDPAY-011` | 395 |
| `INV-REQ-007` | 391 |
| `INV-LIFE-078` | 387 |
| `INV-CAP-005` | 368 |
| `INV-CAP-023` | 365 |
| `INV-PAY-052` | 363 |
| `INV-LIFE-050` | 359 |
| `INV-LIFE-085` | 352 |
| `INV-CAP-031` | 351 |
| `INV-MOD-005` | 351 |
| `INV-DATE-024` | 350 |
| `INV-HOST-023` | 348 |
| `INV-MONEY-024` | 348 |
| `INV-PAY-025` | 348 |
| `INV-PAY-023` | 343 |
| `INV-ADDPAY-035` | 340 |
| `INV-LIFE-018` | 338 |
| `INV-CAP-030` | 337 |
| `INV-ADDPAY-009` | 334 |
| `INV-CAP-032` | 332 |
| `INV-LIFE-065` | 325 |
| `INV-MONEY-017` | 323 |
| `INV-MOD-016` | 319 |
| `INV-DATE-027` | 316 |
| `INV-PAY-060` | 316 |
| `INV-HOST-004` | 310 |
| `INV-PAY-046` | 308 |
| `INV-CAP-036` | 303 |
| `INV-CAP-027` | 303 |
