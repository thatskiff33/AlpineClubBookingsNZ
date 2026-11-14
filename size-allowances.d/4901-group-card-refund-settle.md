# File-size allowances for #4901

#4851 settles a dead group card refund from Stuck States. Settling a pre-#3653
whole-group refund by bank transfer has to apply the same per-child mirror the
plan replay applies, so that body is lifted out of the replay into two shared
functions instead of being copied.

file: src/lib/group-cancel.ts
lines: 1130
reason: the replay's per-child mirror and its follow-up become
  `applyLegacyGroupChildRefundMirror` and `recordLegacyGroupChildRefundRecovered`,
  shared with the Stuck States bank close (`card-refund-group-paid-another-way.ts`)
  so the two cannot drift. They sit beside the replay that still calls them;
  moving them to a new module would re-key the lock and audit censuses that
  name this file, a refactor of its own in a money path.
