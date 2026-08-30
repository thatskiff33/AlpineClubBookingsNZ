- **Server-side code can no longer slip into the browser download without the
  build stopping it (#2851, #2850).** Every page a member opens downloads some
  code to run in their browser. Code meant only for the server — the database
  connection, the sign-in machinery, the audit writer, the email, Xero and
  Stripe machinery — must never end up in that download. One such leak existed:
  the booking policy-exception module was reaching the browser because two small
  values a screen needed happened to live in it, which meant the whole module,
  including its server-side cryptography, was being sent out with the page.

  Those two values now live in a tiny module of their own that depends on
  nothing, so the server-side module stays on the server. Nothing about how
  booking-rule exception requests behave, are validated or are approved has
  changed — the same code runs in the same order, it is simply no longer
  shipped to visitors.

  The check that had been tolerating that one leak as a known exception no
  longer has any way to tolerate anything: the exception list is gone, not
  emptied. And six modules — sign-in, the database connection, the audit
  writer, email, Xero and Stripe — are now marked so the production build
  itself refuses to compile if any browser-side screen ever reaches them, with
  a test that plants exactly such a mistake on every CI run and proves the
  build still catches it.

- **Maintenance commands are now run with `npm run`, and the runbooks say so
  (#2850).** Marking the database connection has a catch: the marker also stops
  the module loading in a plain command-line script, so every maintenance tool
  that touches the database would have refused to start, with an error message
  about React that explains nothing. The tools now start in a mode where the
  marker stands down, and — because an operator copying a command in the middle
  of a payment problem should not have to remember a flag — the five repair
  commands that used to be published as long `npx tsx …` lines are now ordinary
  named commands:

  - `npm run xero:booking-repair`
  - `npm run xero:refund-note-link-repair`
  - `npm run payments:backfill-orphaned-credits`
  - `npm run payments:audit-ib-hold-clearing`
  - `npm run calendar:diagnose-access`

  Arguments go after `--`, for example
  `npm run xero:booking-repair -- --dry-run`. The old `npx tsx …` spellings of
  these five will no longer start; every place the documentation published one
  has been updated, and a test now fails the build if a command that needs the
  new mode is ever published without it.
