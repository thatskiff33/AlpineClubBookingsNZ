# File-size allowances for CT-5 (#2869 — provider, job and export boundaries)

Ten already-over-budget files grow here. **Every one of them SHRINKS in logic and
grows in explanation**: the change at each site replaces one expression with
another of about the same length, and the lines added are the docblock saying
which of the epic's three temporal concepts that field is and why the previous
reading was wrong. That is the deliverable of this issue as much as the code is
— the census the issue asks for is only durable if the classification lives at
the call site rather than in a pull-request comment.

**No new file needed an allowance, and none is over budget.** The three modules
this change adds — `src/lib/xero-provider-dates.ts` (the Xero temporal
boundary), `src/lib/email-templates-club-time.ts` (the email surface's club
zone) and their two test suites — were written to stay inside their budgets
rather than folded into the modules that call them, which is why the two largest
concentrations of new logic cost nothing here.

file: src/instrumentation.node.ts
lines: 1709
reason: this is the change. The file is one declarative registration table for
  twenty-five scheduled jobs, and a cron expression is a club-local scheduled
  time — so the zone that resolves it has to be read once, at boot, before the
  first `cron.schedule(...)`, in this file and nowhere else. The growth is that
  resolution, the boot prime of the email surface's club zone beside the existing
  palette prime, and the docblock stating the one thing a reader must know and
  cannot infer: `node-cron` reads the `timezone` option when a job is registered
  and never again, so a club that changes its timezone keeps the old schedule
  until the next restart. Splitting a registration table by line count would put
  some jobs somewhere else for no reason a reader could name. Review added the
  resolution's honest reporting — it runs AFTER the database readiness probe and
  logs a warning naming the fallback when the club's own zone could not be read,
  rather than logging every outcome as a success — and removed nineteen
  hard-coded "AM NZST" strings from the job-registration log lines, which is an
  `INV-CONFIG-001` correction in the same breath.

file: src/lib/admin-cron-health.ts
lines: 829
reason: the zone becomes an argument and the forty hand-written
  "02:20 NZT/NZDT daily" strings become the configured zone, which is both the
  CT-5 correction and an `INV-CONFIG-001` one — this is the generic product, and
  it was spelling one club's timezone into the operator-facing description of
  every job. The net growth is the module docblock explaining that; the job table
  itself is very slightly shorter. Review added the RUNNING-versus-CONFIGURED
  distinction to the report: `node-cron` pins a job's zone when the job is
  registered, so between an admin changing the setting and the next restart the
  page was asserting an hour no job would fire at.

file: src/app/api/webhooks/xero/route.ts
lines: 313
reason: the anchor defect of this issue, in the one place the census could not
  see it. `eventDateUtc` is offset-less on Xero's wire, and `new Date(...)` read
  it in the container's zone — storing `XeroInboundEvent.eventCreatedAt` about
  thirteen hours early — while the payload validator beside it was as lenient as
  `new Date` itself and accepted prose such as "11 March 2019". Both now go
  through `@/lib/xero-provider-dates`. The code is two lines shorter; the growth
  is the docblock naming the wire shape, because the line it sits on now reads
  as trivially safe and the next person to touch it has no other way to learn
  that the provider omits the offset. Splitting a Next route handler in half to
  carry one field's classification would put the validator somewhere the reader
  of the handler will not look.

file: src/lib/config-transfer/categories/xero-config.ts
lines: 815
reason: two "today" reads move onto the persisted club timezone. Seven of the
  lines are the comment on the second one, which sits inside the apply
  transaction and therefore has to say why a single indexed primary-key read on
  the shared client is acceptable there, and that threading the zone through
  `ApplyContext` would be tidier and belongs with that machinery.

file: src/lib/membership-cancellation-xero.ts
lines: 1396
reason: one line. The import of the environment-zoned date helper is replaced by
  two imports — the club-zone reader and the boundary's document-date helper.

file: src/lib/xero-applied-credit-deallocation.ts
lines: 993
reason: one line, and the same import swap as above.

file: src/lib/xero-booking-invoices.ts
lines: 1375
reason: the invoice due date now takes the club's zone explicitly, so the zone is
  read ONCE outside the `buildInvoice` closure — that closure runs for the
  recorded request payload and again on every contact-repair attempt, and both
  must carry the same date. The growth is that hoist plus the comment saying why
  it is hoisted, which is the property a future reader is most likely to undo.

file: src/lib/xero-contacts.ts
lines: 1905
reason: `getContactFirstInvoiceDate` is the original defect this issue was filed
  for, and the fourteen lines are its docblock. The function body got SHORTER —
  a five-line parse became one call to the boundary. The explanation has to sit
  on the function, because the next person to read it will be looking at a line
  that now looks trivially safe and will have no way to know that the wire shape
  it consumes is typed `string` and is a `Date` at runtime.

file: src/lib/xero-credit-notes.ts
lines: 958
reason: four lines. Three "today" reads move onto the persisted zone, the fourth
  passes the refund payment's date into a builder that is now a pure function of
  its inputs, and the import swap.

file: src/lib/xero-membership-sync.ts
lines: 1699
reason: the largest, and the two changes in it are the two subscription defects
  this issue found. The season window compared a HOST-local midnight against a
  date whose meaning depended on which Xero wire shape arrived, so on a container
  west of Greenwich an invoice dated the first day of a season fell outside it
  and a paid member read as unpaid; and "past due" compared a midnight against
  the wall clock, so an invoice went overdue partway through the day it was due,
  at an hour that moved with the container. Both replacements are shorter than
  what they replace; the growth is the two comments describing the defect, which
  is what stops the next reader "simplifying" the calendar comparison back into a
  `Date` comparison. Splitting them out would separate the season rule from the
  season matcher it is the only caller of.
  #3123 adds forty-nine lines, and none of them touches the two defects above.
  `enqueueHostingCoverageReevaluationForMember` now takes a REQUIRED club day
  and bounds `checkOut >= today` under a `Member` row lock, so the day has to
  be resolved before each of the four transactions in this file opens
  (`INV-LOCK-004`). Three of the four are the identical seven-line hoist and
  comment; the fourth, in `checkMembershipStatus`, reuses the club day the
  subscription status was ALREADY judged against, so the status and the
  fan-out cannot land on different days. The runtime reader rather than
  `club-time/server`, because this module is reachable from both a CLI entry
  point and `instrumentation.node.ts`. Recorded here rather than in a file of
  its own because the gate measures against `main`, where the whole
  1650-to-1699 growth is one change, and one file may hold only one allowance.

file: src/lib/xero-record-activity.ts
lines: 747
reason: one formatter was rendering both a `@db.Date` lodge night and a real
  `submittedAt` instant, which are different concepts needing opposite treatment
  — the whole distinction this epic exists to make explicit. It becomes two
  named functions, one taking no zone at all because a calendar day has none, and
  the growth is those two docblocks. They belong beside the record-reference
  builders that are their only callers.
