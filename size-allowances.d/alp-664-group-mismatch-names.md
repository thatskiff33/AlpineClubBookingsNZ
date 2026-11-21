# File-size allowance for ALP-664

The grouping snapshot now names the managed groups an information-only entry
sits in (#5234), so the mismatch panel can say which group to take the contact
out of. The one added line is the id-to-name map built from the membership
rows the snapshot already reads.

file: src/lib/xero-member-grouping-resync.ts
lines: 813
reason: the group names come from the same membership-cache read that the
  snapshot's id lists are built from, so the map belongs beside it; moving the
  snapshot out of this already-oversized module to absorb one line would invent
  a seam for this change alone.
