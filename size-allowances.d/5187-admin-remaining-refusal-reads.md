# File-size allowances for ALP-649 (#5187)

Each entry holds the lines a screen takes to throw a refusal through the shared
reader (`apiRefusalFromResponse`) before parsing, and to show it with
`refusalMessageOr` from the catch that also sees a request that never got an
answer (#4976). The read sits inside the handler beside the state it fills;
splitting these page components is its own refactor per page.

file: src/app/(admin)/admin/chores/page.tsx
lines: 749
reason: reading each failed admin request through the shared refusal reader
  before parsing; those lines sit inside this file, which was already over its
  limit before this change, and lifting it apart is a refactor of its own, not
  part of this fix.

file: src/app/(admin)/admin/work-parties/page.tsx
lines: 635
reason: reading each failed admin request through the shared refusal reader
  before parsing; those lines sit inside this file, which was already over its
  limit before this change, and lifting it apart is a refactor of its own, not
  part of this fix.
