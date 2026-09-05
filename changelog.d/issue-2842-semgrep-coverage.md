- **The security scanner now has to prove what it actually read, and 113
  suppressions that suppressed nothing are gone (#2842).** Semgrep exits 0 on
  findings-free code even when it could not parse some of that code, so a file
  the scanner could not read has been indistinguishable from a file it read and
  cleared. Re-measured on the pinned image: 177 of 4,219 files carried a parse
  error behind a green gate, three of them whole-file failures where no rule ran
  at all. Two constructs caused all of them, both valid TypeScript the build
  accepts, and both fixed here in the five production files and three
  zero-coverage files that mattered; the 169 test files that remain are recorded
  in a versioned allowlist that a new build step enforces as a one-way ratchet —
  a newly unparsed file fails the build, and so does an allowlist entry whose
  file has started parsing, so the list can only shrink. Separately, re-running
  the scan with every suppression disabled showed that just 3 of the tree's 116
  `nosemgrep` annotations suppress anything the blocking gate can emit; the
  other 113 were deleted with that evidence, and the three kept now name the
  finding they suppress. That measurement also corrected a documented claim:
  `react-dangerouslysetinnerhtml` **is** emitted by the blocking gate, so not
  every non-repository rule id was cloud-only as previously recorded. Members
  and administrators see no change; maintainers get a scanner whose green means
  what it says.
