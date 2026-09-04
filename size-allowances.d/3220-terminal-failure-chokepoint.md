# File-size allowances for #3220

file: src/lib/payment-recovery.ts
lines: 2583
reason: This change makes the module SHORTER in machinery and longer in prose.
  The three terminal-failure transitions became one function, and the
  stale-worker reaper lost a whole bulk-update arm and a second query - but the
  chokepoint has to argue why terminality is an argument rather than a
  re-derivation, why `nextRetryAt` is forced null, and why the write is
  status-fenced (a `P2025` from the old `update` by id escaped the worker
  loop's own catch and abandoned the rest of the batch). Every one of those is
  a rule a future edit would otherwise re-derive wrongly, and this repository's
  convention is that the reasoning lives at the site it governs.

  Splitting is worse here rather than merely inconvenient. The transition is
  the module's own state machine: the chokepoint, the two status-set constants
  the readers share, the claim, the completion and the stale-worker reaper are
  one topic that has to be read together, and moving half of it into a sibling
  module would put the fence and the thing it fences in different files. The
  seam this module genuinely has - the per-type processors - is unaffected by
  this change and is where a future split belongs.
