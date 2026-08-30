# File-size allowances for #3037 (epic #2943)

file: src/lib/policies/adult-member-hosting.ts
lines: 965
reason: this file IS the single home of the host-scope model — the scope set,
  the built-in default, the row reader, the per-night OR, the enabled-scope
  switch and the member-facing wording — and #3037 adds a third scope to every
  one of those in turn. Splitting it would put the scope list in one file and
  the rule that reads it in another, which is precisely the drift `INV-SSOT`
  and `INV-HOST-017` exist to prevent: the seam a wider scope arrives through
  is `HostingParticipant.hostScope`, and it only works while one module owns
  both ends of it. Most of the growth is rationale rather than logic — why the
  new column sits outside the all-or-none CHECK, and why NULL on a decided row
  reads as OFF. The one new function, `hostScopesAreSameBookingOnly`, exists to
  make this file SMALLER in the sense that matters: the public policy page and
  the member-facing refusal sentence each used to spell out "same booking and
  no wider scope" for themselves, the second copy went stale the moment a third
  scope existed, and both now ask here.

file: src/app/api/admin/booking-policies/adult-member-hosting/route.ts
lines: 499
reason: sixty-seven lines, and every one of them is the reason a reader needs at
  the point they are reading. The route is where the third scope's asymmetry
  becomes visible — `storedHostScopes` reads the new column but does not TEST
  it, the write's materiality comparison must include it or a Group-Trip-only
  edit is reported as saved while nothing is written, and the request schema
  makes it OPTIONAL rather than required so a browser tab loaded from the
  previous colour can still save. That last one carries most of the added
  prose, because the obvious spelling is wrong in a way that looks safe: a
  `.default(false)` cannot be told apart from an explicit `false`, so an
  old-colour body clears an opt-in it could not express, and the compare-and-
  swap does not catch it because that tab holds the current version quite
  legitimately. Splitting a keyed-singleton admin route whose whole job is one
  GET and one compare-and-swapping PUT would separate the validation from the
  write it guards, and this route is deliberately shaped after
  `minimum-stay/[id]/route.ts` — the house pattern for exactly this kind of
  policy singleton.

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
lines: 768
reason: eight lines. The public booking-rules read is a narrowed `select` on the
  hosting policy, and a scope column omitted from it publishes a sentence
  describing a rule the club is not applying — silently, because Prisma does
  not typecheck `select` keys through the hand-written client interface these
  paths use. The rest is the correction review found: this page branched on the
  #2569 pair by hand, so a club running `SAME_BOOKING` + `SAME_GROUP_TRIP`
  PUBLISHED a narrower rule than it applied. It now asks
  `hostScopesAreSameBookingOnly`, and the note explaining why says so where the
  next person to touch that branch will read it. There is nothing to split.
