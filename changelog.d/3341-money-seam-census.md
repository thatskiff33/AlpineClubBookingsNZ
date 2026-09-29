- **A money check in the test suite can no longer be switched off by replacing
  the step it checks (#3341).** #3340 under-charged two members because every
  test that touched the step retiring an unpaid extra replaced that step with a
  stand-in, so the amount a member was asked for was never tested together with
  the step that retired the old one. A new check fails the build when a test
  replaces that step and still asserts the amount; the tests that did so now run
  the real step, and one new test follows two unpaid edits end to end. The check
  cannot see a test that stubs what the step itself reads, so the suites found
  doing that were fixed by hand. Review findings about payments must now say
  what happens to the money, and `.github/CODEOWNERS` marks the money code so
  the owner's approval on it can be made mechanical. Nothing a member or officer
  sees changes.
