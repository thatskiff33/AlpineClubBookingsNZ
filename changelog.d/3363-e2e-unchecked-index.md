- **The browser test suite is now held to the same "prove it is there" rule as
  the application (#3363).** TypeScript's `noUncheckedIndexedAccess` check, which
  the application code has run under since #2802, now also covers the Playwright
  end-to-end suite. Every place a browser test reached into a list or a keyed
  lookup without proving the entry existed was rewritten to fail loudly when it
  is missing, and three small date and stay-window helpers were added to
  `e2e/helpers/stay-dates.ts` so six copies of the same date-splitting code
  became one.

  Nothing a member or administrator uses changed. The unit-test project stays
  outside this rule by an owner decision recorded on #3363.
