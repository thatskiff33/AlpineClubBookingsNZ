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
Exact form, one row per id:

| ID | Ceiling | Deciding issue | Reason |
| --- | ---: | --- | --- |

There are no approved exceptions yet. Candidates are proposed on #2789 as the
compaction waves reach them; until the owner approves one, an oversize entry is
migration debt below.

## Migration ratchet

Temporary. Each row is the exact word count an oversize entry had when it was
last measured, and the gate holds the entry to that number: it may only shrink
(record the new count when it does) and it leaves this table the moment it is
within budget. A compliant entry can never join it. When the last row goes,
delete this section — and when the exceptions table is also empty, delete this
file; the checker treats an absent register as "no exceptions, no debt".

| ID | Words |
| --- | ---: |
| `INV-PAY-051` | 5814 |
| `INV-MOD-025` | 4615 |
| `INV-MOD-028` | 4285 |
| `INV-ADDPAY-037` | 2729 |
| `INV-SSOT-004` | 2561 |
| `INV-HOST-050` | 2175 |
| `INV-PRIV-012` | 2093 |
| `INV-CONFIG-005` | 1724 |
| `INV-HOST-046` | 1693 |
| `INV-HOST-045` | 1646 |
| `INV-ADDPAY-039` | 1553 |
| `INV-MOD-027` | 1519 |
| `INV-SSOT-001` | 1489 |
| `INV-PRIV-016` | 1486 |
| `INV-OPS-013` | 1428 |
| `INV-HOST-051` | 1419 |
| `INV-DATE-019` | 1347 |
| `INV-CAP-032` | 1322 |
| `INV-CONFIG-004` | 1280 |
| `INV-OPS-012` | 1197 |
| `INV-DATE-013` | 1163 |
| `INV-ADDPAY-036` | 1129 |
| `INV-SSOT-003` | 1129 |
| `INV-PAY-046` | 1054 |
| `INV-ADDPAY-038` | 1018 |
| `INV-HOST-043` | 970 |
| `INV-DATE-024` | 898 |
| `INV-CAP-031` | 868 |
| `INV-CONFIG-002` | 867 |
| `INV-MONEY-003` | 826 |
| `INV-MOD-026` | 820 |
| `INV-LOCKOUT-040` | 805 |
| `INV-ADDPAY-034` | 799 |
| `INV-HOST-052` | 799 |
| `INV-HOST-041` | 782 |
| `INV-PRIV-011` | 777 |
| `INV-GUEST-016` | 771 |
| `INV-INT-016` | 730 |
| `INV-PAY-022` | 706 |
| `INV-HOST-049` | 705 |
| `INV-HOST-029` | 700 |
| `INV-DATE-015` | 696 |
| `INV-MOD-021` | 650 |
| `INV-LIFE-062` | 640 |
| `INV-ADDPAY-017` | 630 |
| `INV-MOD-006` | 614 |
| `INV-PRIV-013` | 607 |
| `INV-HOST-042` | 595 |
| `INV-LOCK-002` | 575 |
| `INV-PAY-047` | 571 |
| `INV-CONFIG-003` | 556 |
| `INV-CAP-030` | 554 |
| `INV-LOCKOUT-037` | 547 |
| `INV-ADDPAY-030` | 541 |
| `INV-LOCKOUT-064` | 539 |
| `INV-OPS-014` | 533 |
| `INV-PAY-025` | 520 |
| `INV-CAP-023` | 509 |
| `INV-PAY-023` | 505 |
| `INV-EXCEPT-009` | 503 |
| `INV-LOCK-004` | 501 |
| `INV-HOST-044` | 500 |
| `INV-CAP-034` | 476 |
| `INV-DATE-025` | 472 |
| `INV-CAP-033` | 466 |
| `INV-INT-017` | 464 |
| `INV-PAY-018` | 456 |
| `INV-PRIV-015` | 455 |
| `INV-PAY-009` | 450 |
| `INV-DATE-020` | 448 |
| `INV-DATE-022` | 440 |
| `INV-CAP-005` | 440 |
| `INV-LOCKOUT-049` | 440 |
| `INV-CAP-029` | 423 |
| `INV-DATE-026` | 417 |
| `INV-HOST-028` | 401 |
| `INV-MOD-017` | 401 |
| `INV-HOST-033` | 394 |
| `INV-LOCKOUT-070` | 394 |
| `INV-PAY-020` | 393 |
| `INV-OPS-001` | 391 |
| `INV-REQ-007` | 388 |
| `INV-ADDPAY-011` | 387 |
| `INV-PRIV-014` | 382 |
| `INV-DATE-014` | 367 |
| `INV-DATE-005` | 361 |
| `INV-LOCKOUT-069` | 359 |
| `INV-MOD-005` | 349 |
| `INV-MONEY-024` | 348 |
| `INV-HOST-023` | 347 |
| `INV-PAY-024` | 347 |
| `INV-LOCKOUT-043` | 346 |
| `INV-PAY-019` | 336 |
| `INV-ADDPAY-035` | 332 |
| `INV-DATE-023` | 331 |
| `INV-ADDPAY-009` | 325 |
| `INV-MONEY-017` | 317 |
| `INV-HOST-004` | 309 |
| `INV-MOD-016` | 309 |
| `INV-CAP-009` | 307 |
| `INV-CAP-027` | 306 |
| `INV-PAY-021` | 306 |
