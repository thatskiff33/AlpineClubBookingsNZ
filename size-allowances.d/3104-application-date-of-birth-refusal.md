# File-size allowance for #3104

One file, and one entry, for the review-round fix on #3082's pull request.

The other three files this change grows already hold an allowance from CT-4
group F1 (#2870, PR #3081), and this gate measures against `main` — where that
group is not yet merged — so one path may hold only one allowance and their
numbers were updated in `size-allowances.d/3081-club-season-year.md` instead of
duplicated here. This file is for the one path that had no allowance.

**Sixty-six lines were extracted rather than absorbed.** The shared decode, the
refusal wording, and all of the reasoning behind both now live in the new
`src/lib/member-application-date-of-birth.ts`, which is well under budget, has a
single dependency, and breaks the `nomination.ts` ⇄
`member-application-mapping.ts` import cycle for those three helpers rather than
deepening it. The entry below is what remains after that extraction, and after a
second pass that cut the comments here down to a pointer at that module so the
same reasoning is not stated twice.

file: src/lib/member-application-mapping.ts
lines: 1141
reason: thirty-six lines, closing a liveness defect on the membership-approval
  path. `MemberApplication.familyMembers` is a `Json` column, so PostgreSQL
  validates nothing in it, and the UNAUTHENTICATED `POST /api/applications` used
  to accept any `\d{4}-\d{2}-\d{2}` for those dates. Once #3082 gave `computeAge`
  its stored-calendar-day precondition, a malformed value threw a `RangeError`
  out of both the approval preview and the approval itself — and this function is
  the preview, which is the surface an admin needs in order to act at all, so a
  throw here blanks the very screen that would tell them what is wrong. The
  thirty-six lines decode the applicant's day and each dependent's day, and route
  a failure through `blockingErrors`, the channel this module already has for
  "the approval cannot proceed, and here is why". About half are the two
  comments, one of which records why the dependent decode sits BEFORE the CREATE
  early return: only the MAP branch derives a tier from that date, but the
  approval writes it on both paths.
  **Why splitting is worse here.** The seam that exists in this file is
  `computeApprovalMappingOutcomes` itself, and it is one function precisely
  because the approval preview and the approval's own recompute must produce
  byte-identical outcomes — that identity is what the HMAC preview token
  verifies, and a drift between the two is a 409 rather than a silent divergence.
  Splitting the per-person loop out to save thirty-six lines would put the two
  halves of that guarantee in different files, in the same change as a
  price-band correctness fix. The decode and the refusal wording have already
  been extracted to the module named above; what is left is the decision to
  refuse, which belongs at the site that takes it.
