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
  of a payment problem should not have to remember a flag — that mode is built
  into the named `npm run` commands rather than left for you to type.

  Five tools had no named command at all before this release. The only way they
  were ever published was a long `npx tsx …` line, and that is what a runbook or
  a colleague would have handed you:

  - `npm run xero:booking-repair`
  - `npm run xero:refund-note-link-repair`
  - `npm run payments:backfill-orphaned-credits`
  - `npm run payments:audit-ib-hold-clearing`
  - `npm run calendar:diagnose-access`

  Seven already had a named command, and it has not changed. If `npm run` is how
  you already ran these, nothing about them is different for you:

  - `npm run xero:audit-invoice-rounding`
  - `npm run payments:backfill-cancel-flattened`
  - `npm run finance:backfill-monthly-facts`
  - `npm run config:self-heal`
  - `npm run induction:baseline`
  - `npm run setup:check` and `npm run setup:wizard`

  What changed for all twelve is the other spelling: running one of these tools
  directly with `npx tsx …` no longer works, and will stop with that unhelpful
  React message. Use the named command. Arguments go after `--`, for example
  `npm run xero:booking-repair -- --dry-run`.

  That mattered most in the one place it was easiest to miss: the tools'
  **own** help text. Ask `xero-booking-repair` how to run it and, until now, it
  printed back the very `npx tsx …` line that aborts — so the operator most
  likely to be reading it, mid-incident with a money repair in front of them,
  was the operator most likely to be handed a broken command. Every one of
  these tools now prints its `npm run` name in its `--help` output and in the
  worked examples at the top of its source, and the misleading "run me
  directly" first line has been removed from each, since none of these files
  was ever executable in the first place. A test now fails the build if a
  command that needs the new mode is published without it anywhere — the
  runbooks, the package scripts, the workflows, or a tool's own help text.

  One page deliberately reads differently, and it is right: the induction
  baseline runbook runs inside the deployment's own container, where `npm run`
  is not available, so it spells the tool and the mode out in full. Copy that
  page's commands exactly as printed.
