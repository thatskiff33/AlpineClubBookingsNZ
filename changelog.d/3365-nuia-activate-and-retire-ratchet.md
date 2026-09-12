- **Internal type-safety programme finished: the compiler now permanently
  refuses a class of "missing data read as if it were present" bug (#2802).**
  This closes the multi-stage programme (#2694) that taught the codebase to
  handle a lookup that might find nothing -- an array position, a dictionary
  key -- explicitly, instead of quietly treating it as if something was
  there.

  This final stage cleared the last handful of cases, all in the tools that
  build and seed the system rather than in anything a member or an
  administrator uses day to day: the demo data generator, the club's
  first-run setup script, and a few build/reporting tools. Each was changed
  to either make the missing case impossible by construction, or to fail
  loudly with a clear explanation if it were ever reached -- never to guess.

  With the count at zero, the underlying compiler rule is now switched on
  permanently for the whole application, so a future change that makes the
  same mistake is caught automatically before it ships, rather than relying
  on a reviewer to notice. The temporary tracking machinery used to manage
  the multi-stage rollout has been removed now that it has done its job.

  Members and administrators will not see any change to any screen.
