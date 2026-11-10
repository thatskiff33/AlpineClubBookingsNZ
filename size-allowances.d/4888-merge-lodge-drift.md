# File-size allowances for #4888

file: src/lib/member-merge.ts
lines: 3152
reason: The participant-attempt savepoint and the partner-share lodge prefix
  have to stay in this function. The coverage proof is pinned to the call that
  try-locks a lodge only after a rolled-back attempt, and splitting that call
  out would hide the order the lock tests read from this file.

file: src/lib/bed-allocation-lifecycle.ts
lines: 2593
reason: The guest-row lodge derivation and the try-lock that follows a rolled-back
  merge attempt belong next to the coverage proof they feed. A guest row with no
  booking relation has to be ignored here, or the residual-reference refusal
  never runs. Moving that read would split the derivation from the proof.
