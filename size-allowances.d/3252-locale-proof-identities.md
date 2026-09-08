# File-size allowances for #3252 / #3250 / #3251 — locale-proof identities

Eight already-over-budget files grow here, and **every one of them shrinks in
logic and grows in explanation.** The code change at each site is a like-for-like
swap: one comparison expression becomes a call to `compareOrdinal`. What is added
is the sentence saying why the ordering at that particular line must not vary
with the runtime's collation — because that is precisely the knowledge whose
absence caused this defect, and its presence in three other files is what makes
the case.

**That is not decoration, and #3252 is the evidence.** The ordinal comparator was
already hand-rolled in three modules, each with a docblock explaining why
locale-aware comparison was wrong there, while the booking-exception proposal
hash two files away still used bare `localeCompare`. Three correct explanations
and no shared helper. The remedy is one home for the comparator plus a note at
each identity site saying which ordering it is and what re-derives it later — a
`compareOrdinal(...)` with no comment reads as a stylistic preference and invites
the next reader to "improve" it back.

**Nothing new needed an allowance.** The comparator's home,
`src/lib/ordinal-order.ts`, is a new 70-line module and well inside its budget;
so are the census suite, the config-transfer test, and the migration and its
verification fixture, which the budget does not measure.

**Nothing here was split, and that is deliberate rather than lazy.** Each of
these files is over budget for reasons that predate this change and that a
comparator swap cannot address. Splitting one to make room for a two-line
comment would put an unrelated seam in a module on a booking, money or provider
path in a pull request whose whole claim is that it changes one ordering rule —
the shape of change this repository's own conventions refuse.

file: src/lib/booking-exception-requests.ts
lines: 740
reason: the anchor defect. `canonicalizeProposalParty` is the sort whose order
  becomes `proposalHash`, and the added lines say two things a reader cannot
  infer from the expression: that a locale-resolved collation makes a STORED
  signature depend on an unpinned setting, and that the chain is now TOTAL. The
  second matters more than it looks — before this the chain stopped at nights, so
  two guests alike in name, member link and nights but differing in age tier
  TIED, and `Array#sort`'s stability let the caller's input order decide the hash.
  The docblock claimed order-independence that the code did not deliver for that
  shape. Three further orderings in the file (the reservation night list, the
  frozen policy refs, the overridable set) carry a line each naming what
  re-derives them.

file: src/lib/policies/adult-member-hosting.ts
lines: 999
reason: seven lines, all one comment. This sort's result is stored VERBATIM in
  `frozenEvidence` and string-joined at approval into a violation fingerprint
  compared against a freshly evaluated one, so fixing the proposal hash without
  it would have refused the identical waiting requests through a different door,
  with the policy-drift message instead of the tampering one. That connection is
  two modules away from this line and there is nowhere else to put it.

file: src/lib/membership-subscription-billing.ts
lines: 1561
reason: the largest, and it holds two separate records. The ordering comment
  explains why a divergence here is CONSTRUCTIBLE rather than theoretical:
  `entry.key` is `<year>:<id>:family:<id>`, and `:` is punctuation, which locale
  collation orders before a digit and a code-unit comparison orders after — so
  two real keys sort oppositely under the two rules, and the preview and the
  confirm are two requests that a blue/green changeover can serve from two
  colours. The rest is the docblock on `digest`, which now routes to the canonical
  `stableDigest` (#3250's second copy, character for character): it records that
  the STORED exception fingerprint is byte-identical because it hashes an array of
  primitives, and that the confirmation token moves once at deploy and is answered
  by the route's ordinary 409. A reader who found that token had changed with no
  note would reasonably suspect a defect.

file: src/lib/xero-sync.ts
lines: 901
reason: the whole growth is a docblock that adds no code at all, and it is the
  most load-bearing text in this change. `buildXeroPayloadHash` is DELIBERATELY
  excluded from the unification: it preserves insertion order and feeds
  `XeroSyncOperation.idempotencyKey` and Xero's own idempotency header, so sorting
  its keys would re-derive every stored key and a replay would emit a duplicate
  invoice, credit note or payment at the provider. Without the note, the next
  reader tidying up this family finds the one function that was left out and
  finishes the job. The census names the exclusion so removing the note fails a
  test rather than only a review.

file: src/lib/xero-member-grouping-resync.ts
lines: 808
reason: #3250's own file. The private `stableDigest` that shadowed the canonical
  one is deleted, so the executable content shrinks; the growth is the import
  comment recording that the swap moves no fingerprint and naming the test that
  measures it, plus the comment on the chunked-resume cursor. That cursor is the
  one ordering here that is not a digest at all: a chunk stops at a member id and
  the next takes everything after it, so two chunks ordering differently would
  SKIP members or reprocess them, and a reader has to be told that before they
  relax the comparison.

file: src/lib/admin-roster-service.ts
lines: 840
reason: three lines. The comparator swap plus one sentence saying this order
  decides the bytes of the roster revision token that a later save re-derives and
  compares as an optimistic-concurrency check.

file: src/lib/induction-baseline.ts
lines: 899
reason: one line — the import. The four comparator swaps are like-for-like.

file: src/lib/email-message-token-contract.ts
lines: 720
reason: one line. The tie-break that was spelled out inline becomes
  `compareOrdinal`, the existing docblock already explained why (this byte
  sequence is also written into migration SQL), and it now names the one home
  instead of restating the rule. The expression is shorter than what it replaced;
  the file grows by the import.
