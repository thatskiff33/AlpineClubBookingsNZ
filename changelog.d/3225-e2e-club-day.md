- **The automated browser tests no longer break on the first of the month
  (#3221).** Nothing about the booking system itself changes — this is entirely
  about the tests that check it before a release goes out.

  Those tests run on a machine set to UTC, while the club's own website works in
  New Zealand time. For about half of every day the two are on different dates,
  and on the last day of a month they are in different months. One test opened
  the booking calendar, believed it would be showing August because the test
  machine still said 31 August, and found the calendar correctly showing
  September — because the site had been in September for two and a half hours by
  then. The test failed, and because these checks guard every change, it briefly
  blocked all work in progress. It had passed on the same code that morning.

  The tests now ask the club's calendar what day it is, in one place, the way
  the site itself does. The step that pages the booking calendar back to an
  earlier month reads the month actually on screen instead of being told which
  one to expect, so it cannot be misled even by a test run that crosses midnight
  while it is running. Three new checks run on every change to make sure no test
  goes back to reading the machine's clock, and a separate on-demand check can
  run the whole browser suite with a computer's clock deliberately parked at a
  month boundary to prove it holds.

  This was the fifth time a date rollover has turned the build red. The four
  before it were in a different set of tests, which have been protected since;
  this closes the same gap for the browser tests.
