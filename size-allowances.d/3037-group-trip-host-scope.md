# File-size allowances for #3037 (epic #2943)

file: src/lib/policies/adult-member-hosting.ts
lines: 939
reason: this file IS the single home of the host-scope model — the scope set,
  the built-in default, the row reader, the per-night OR, the enabled-scope
  switch and the member-facing wording — and #3037 adds a third scope to every
  one of those in turn. Splitting it would put the scope list in one file and
  the rule that reads it in another, which is precisely the drift `INV-SSOT`
  and `INV-HOST-017` exist to prevent: the seam a wider scope arrives through
  is `HostingParticipant.hostScope`, and it only works while one module owns
  both ends of it. Most of the growth is rationale rather than logic — why the
  new column sits outside the all-or-none CHECK, why NULL on a decided row
  reads as OFF, and why the same-booking-only sentence has to deny each wider
  scope by name — and every line of it is the reasoning a future lane needs at
  the moment it edits these functions.

file: src/app/api/admin/booking-policies/adult-member-hosting/route.ts
lines: 463
reason: thirty-one lines, and every one of them is the reason a reader needs at
  the point they are reading. The route is where the third scope's asymmetry
  becomes visible — `storedHostScopes` reads the new column but does not TEST
  it, the write's materiality comparison must include it or a Group-Trip-only
  edit is reported as saved while nothing is written, and the request schema
  defaults it rather than requiring it so a browser tab loaded from the
  previous colour can still save. Splitting a keyed-singleton admin route whose
  whole job is one GET and one compare-and-swapping PUT would separate the
  validation from the write it guards, and this route is deliberately shaped
  after `minimum-stay/[id]/route.ts` — the house pattern for exactly this kind
  of policy singleton.

file: src/lib/adult-member-hosting-review.ts
lines: 2602
reason: one line — the new scope column added to the policy loader's narrowed
  `select`. That select is pinned to the schema by the call-site census for a
  reason: an omitted column hands the resolver `undefined`, which it reads as
  "this row did not decide", quietly widening or narrowing a lodge's rule with
  a green typecheck. The column has to be named here; there is nothing to
  split, and the file's existing length is #3128's business rather than this
  change's.

file: src/lib/public-page-content-tokens.ts
lines: 761
reason: one line. The public booking-rules read is a narrowed `select` on the
  hosting policy, and a scope column omitted from it publishes a sentence
  describing a rule the club is not applying — silently, because Prisma does
  not typecheck `select` keys through the hand-written client interface these
  paths use. The column has to be named here; there is nothing to split.
