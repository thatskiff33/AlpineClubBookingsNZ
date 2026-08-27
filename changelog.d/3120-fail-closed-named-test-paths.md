- **A local test command agents were told to run could quietly under-run and
  still report success (#3120).** When an agent lane named several test files
  to run directly — the way this repository's contributor guide asks for a
  handful of tests that a faster check cannot reach on its own — a mistyped or
  renamed file name used to be silently dropped as long as at least one other
  named file still matched. The run finished, reported "passed", and gave no
  hint that one of the files never ran at all.

  A new command, `npm run test:named`, refuses to run anything until every
  named file both exists and is recognised as a real test, and lists every
  problem file rather than stopping at the first one. The contributor guide
  now points at this command instead of the old plain instruction.

  Nothing about the tests themselves changed — only the safety net around
  naming them.
