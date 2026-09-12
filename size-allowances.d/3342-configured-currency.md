# File-size allowance for PR #3342 (#3325, the configured currency everywhere)

One already-oversized component grows by exactly one line, for the same reason
#3326 recorded for four files: a hard-coded currency folded into the club's
configuration. Nothing else in the file moved.

## The panel's length is recorded in #3350's fragment, not here

`public-booking-requests-panel.tsx` grew in two epic children at once: this one,
and #3350's type-safety stage. One file, one allowance — so the entry lives in
`3350-nuia-src-components.md`, which states both causes and carries the length
measured off the merged tree. Nothing about this change's own reasoning moves
with it; only the number, so that two entries cannot describe half a file each.
