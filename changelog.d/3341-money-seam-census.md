- **A money check in the test suite can no longer be switched off by the test
  that is checking it (#3341).** #3340 under-charged two members because every
  test that touched the step retiring an unpaid extra replaced that step with a
  stand-in, so the amount a member was asked for was never tested together with
  the step that retired the old one. A new check fails the build when a test
  does that; the six tests that did it now run the real step, and one new test
  follows two unpaid edits end to end. Review findings about payments must now
  say what happens to the money, and `.github/CODEOWNERS` marks the money code
  so the owner's approval on it can be made mechanical. Nothing a member or
  officer sees changes.
