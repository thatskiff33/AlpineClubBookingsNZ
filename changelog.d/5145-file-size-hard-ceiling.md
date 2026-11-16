- **Oversized source files can no longer keep growing without limit (#4926).**
  The file-size check already let an over-budget file grow when a change
  declared the new length and a reason. That escape now stops at three times
  the budget — 2,100 lines for a module, 750 for a route handler, 1,500 for a
  page. A file already past that may stay the same length or shrink, and a
  change that needs it longer must split part of it out first. No file is
  exempt.

  Every run of `pnpm run quality:budget` on a change also prints how many lines
  of size debt the change adds or removes. Nothing a club sees in the app
  changes; this matters to anyone maintaining or forking the code.
