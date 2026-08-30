- **Server-side code can no longer slip into the browser download without the
  build stopping it (#2851, #2850).** Every page a member opens downloads some
  code to run in their browser. Code meant only for the server — the database
  connection, the sign-in machinery — must never end up in that download. One
  such leak existed: the booking policy-exception module was reaching the
  browser because two small values a screen needed happened to live in it,
  which meant the whole module, including its server-side cryptography, was
  being sent out with the page.

  Those two values now live in a tiny module of their own that depends on
  nothing, so the server-side module stays on the server. Nothing about how
  booking-rule exception requests behave, are validated or are approved has
  changed — the same code runs in the same order, it is simply no longer
  shipped to visitors.

  The check that had been tolerating that one leak as a known exception no
  longer has any way to tolerate anything: the exception list is gone, not
  emptied. And the sign-in module is now marked so the production build itself
  refuses to compile if any browser-side screen ever reaches it, with a test
  that plants exactly such a mistake on every CI run and proves the build still
  catches it.

  Two things an operator should know. The database module is deliberately NOT
  marked the same way, because fourteen maintenance commands — `npm run setup`,
  the seed, the Xero and credit repair tools — load it directly and the marking
  would stop them from starting; it stays covered by the source-level checks
  instead. And the reason previously recorded for not marking these modules was
  simply wrong when it was written, so it has been replaced with what was
  actually measured.
