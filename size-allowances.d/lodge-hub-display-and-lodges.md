# File-size allowances for the Lobby Display and Lodges move (C11 part 1, #4808)

Each of these files links a Lobby Display or Lodges page, and now takes that
link from the hub registry (`adminHref` / `adminLink`) instead of writing the
URL by hand, so the link follows the page when the switch goes on. The only
growth in each is the one line that imports the helper; the links themselves
stay the same length.

file: src/app/(admin)/admin/lodge-ops/display/devices/page.tsx
lines: 537
reason: one import line, so the back link comes from the hub registry.
  Splitting the devices page is a refactor of its own and would not shrink
  this hunk.

file: src/app/(admin)/admin/lodge-ops/display/reference/page.tsx
lines: 611
reason: one import line, so the back link comes from the hub registry.
  Splitting the reference page is a refactor of its own and would not shrink
  this hunk.

file: src/app/(admin)/admin/lodge-ops/display/templates/page.tsx
lines: 1134
reason: one import line, so the back link and the preview and builder openers
  come from the hub registry. Splitting the template editor is a refactor of
  its own and would not shrink this hunk.
