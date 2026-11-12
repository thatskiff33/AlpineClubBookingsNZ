- **Browser tests for the admin hubs are ready for the switch-on (#4814).**
  A new browser test checks what officers will see once admin hubs are
  switched on: old admin addresses forward to the new ones, each role's menu
  lists the right hubs, and the search box finds pages. It is skipped until
  the hubs are switched on. The Preview as role check is a placeholder until
  that feature is built.

  The existing browser tests now ask the app where each admin page lives
  instead of spelling out the address, so they keep passing on either side of
  the switch. Nothing a club sees changes in this release.
