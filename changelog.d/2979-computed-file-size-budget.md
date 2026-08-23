- **The file-size check no longer keeps a list, so it stops causing merge
  conflicts (#2979).** The check that stops large source files quietly getting
  larger used to work from a written-down list of every file that was already
  too big, with the length each one was allowed to keep. That list was a real
  file in the repository, and every change that touched one of those files had
  to edit it — so the moment two pieces of work were in progress at once, they
  collided on it. On one day in August, five of nine parallel pieces of work
  were all editing the same list.

  Worse, those collisions had to be resolved by hand, and twice that produced a
  wrong number. In one case two pieces of work each recorded a different allowed
  length for the same file, and whichever was kept was wrong for the file that
  actually resulted. In another, the recorded length was three lines *below*
  what the untouched file already was, so the check would have failed on work
  nobody had done.

  The list is now gone. The check works out how long each file was by reading it
  from `origin/main` when it runs, so there is nothing written down for two
  branches to disagree about. The rule itself has not changed at all: a file
  that was within its budget may not go over it, a file that was already over
  may not grow, and shrinking is always allowed. Two loopholes close as a side
  effect — renaming a file (including from `.ts` to `.js`) no longer leaves its
  allowance behind, and one change after another can no longer creep a shrunken
  file back up to its old size, because each is measured against what the last
  one really left behind rather than against a number somebody wrote down. (A
  branch cut *before* the shrink is still measured against the larger file until
  it merges the latest work in. In the automated checks that gap never opens at
  all, because they compare against the same commit either way; it only shows up
  when the check is run by hand on a branch that has fallen behind.)

  Two things that could quietly get past the check are also fixed. Moving a file
  **into** the checked area — from the database seed or scripts folders, or back
  from a test folder — used to let it keep whatever length it had where nothing
  was watching, so a 1,300-line file could arrive well over budget and the check
  would say nothing; done in two steps, any amount of growth could be laundered
  the same way. Such a file now has to meet its budget like any other new one.
  And the check no longer reports a clean result when it scanned nothing at all,
  which is what a checkout missing its source folder used to produce.

  There is still a way to say "yes, this file grows, I mean it", and it needed
  to stay: 283 files are already over their target size, including most of the
  ones people work in every day, so a rule with no exception at all would have
  stopped ordinary work rather than large files. A piece of work that has to
  make one of those files longer now adds **its own small file** saying which
  file, how long it becomes, and why splitting it would be worse — the same
  one-file-per-change shape used for release notes, so two pieces of work in
  progress can never collide over it. The note is checked rather than trusted:
  the length it records has to be the file's real length, it is used up by the
  change that wrote it and cannot be reused later, and one that turned out not
  to be needed is reported rather than passed over. It cannot be used to bring
  in a brand new oversized file, or to walk one in from outside the checked
  area — those stay refused.

  For a contributor, the practical effect is that `npm run quality:budget:update`
  is gone, because there is no longer anything to regenerate; a size increase
  that is genuinely necessary is declared in that per-change file instead. The
  overall figure the list used to give away — how many files are over budget and
  by how much in total — is now produced on demand by
  `npm run quality:budget -- --report`, and appears in `npm run quality:report`
  as before. The check also measures each file against the point where the
  branch was cut rather than against the tip of `origin/main`, so work is judged
  on what it changed rather than on how far `main` has moved underneath it —
  and, when it runs on `main` itself after a merge, against what `main` held
  before that merge, so two pieces of work that each grow the same file within
  their own allowance cannot add up to a breach that nothing ever reports.
