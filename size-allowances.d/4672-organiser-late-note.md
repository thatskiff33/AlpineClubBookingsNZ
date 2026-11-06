# File-size allowance for #4655 (PR #4672): the late note's re-taken claim

file: src/lib/xero-operation-outbox.ts
lines: 3455
reason: the outbox must write every outcome for an organiser adjustment under
  the claim the run actually holds. A late credit note can take the reset row
  back RUNNING under a fresh claim (INV-INT-034), and the outbox adopts it
  through `onRetake`. The growth is that one `let outcomeClaim` plus the hook
  that sets it, the switch of the busy give-back, the cooldown give-back and the
  failure write to it, and the stood-down count. Each line sits at an existing
  outcome write in the dispatch loop, beside the claim it replaces. Moving them
  into a helper would hide which claim each write uses, and that is exactly
  what the review found wrong. Splitting the 3,446-line module is its own
  piece of work, not this fix.
