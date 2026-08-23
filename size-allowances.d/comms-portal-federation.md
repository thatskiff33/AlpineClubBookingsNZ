# File-size allowances for the Communication Portal federation work

One already-over-budget file grows here, by five lines.

Every other file this change touches stayed inside its budget, and the three
new ones — `club-post-html.ts`, `club-post-editor.tsx` and `club-post-body.tsx`
— were written to their own ceilings rather than added to an existing module.
The editor in particular was deliberately NOT folded into
`components/admin/page-content-panel.tsx`: that file is 2,577 lines against a
700 ceiling, so extending it would have meant a far larger allowance than this
one, on top of coupling a member composer to an admin surface.

file: src/lib/member-merge.ts
lines: 3773
reason: one entry in MEMBER_MERGE_SNAPSHOT_SCALAR_COLUMNS for
  ClubPostImage.uploadedByMemberId, plus the four lines saying why it is a bare
  scalar rather than a relation. The contract of this module is that each
  member-id column is classified in exactly one authoritative list, and the
  DMMF completeness test is built on there being one place to look; a second
  file holding one of those entries is precisely the drift the guard exists to
  catch. The file is a long-standing split candidate on other grounds and is
  not made materially worse by five lines.
