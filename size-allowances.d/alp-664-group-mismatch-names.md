# File-size allowance for ALP-664

The grouping snapshot now names the managed groups an information-only entry
sits in (#5234), so the mismatch panel can say which group to take the contact
out of. The added lines are the id-to-name map built from the membership rows
the snapshot already reads, and the old id list kept beside the named groups so
an older server or an open tab still works during a blue-green deploy.

file: src/lib/xero-member-grouping-resync.ts
lines: 820
reason: the group names come from the same membership-cache read that the
  snapshot's id lists are built from, so the map belongs beside it; moving the
  snapshot out of this already-oversized module to absorb these 8 lines would
  invent a seam for this change alone.
