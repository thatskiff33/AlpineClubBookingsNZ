# File-size allowances for CT-4 group C (#2870, epic #2988)
> **Line counts refreshed by CT-4 group F3 (#2870).** That group hoisted the
> shared helpers these files each wrote out privately, so several of them are now
> SHORTER than this file recorded and four are two or three lines longer where a
> two-line import pair became one multi-line import. The gate requires
> `lines:` to equal the file's real length, so the numbers below were reset to
> what the tree holds; nothing about the reasoning above changed, and no file
> here crossed a ceiling it was not already over.

Seven already-oversized components grew, by between seven and twenty-two lines
each. (An eighth, `booking-change-requests-panel.tsx`, was still INSIDE its
budget on the base ref, so no allowance can carry it over: its comments were
written shorter instead and it lands at 698.)

The shape of the growth is the same everywhere, so it is stated once here rather
than seven times below.

Before this change a client component formatted a date by calling a module-level
helper that closed over `APP_TIME_ZONE` — a synchronous environment constant. The
club's timezone is now a persisted database value that reaches the browser as
data (`INV-CONFIG-002`), so the helper has to read a React context, which means
it has to become a hook: a `function formatX(value)` becomes a
`function useXFormatter()` returning the same closure, plus one line inside the
component that calls it. That is a fixed three-to-five-line cost per file, paid
once, and it disappears again in CT-6 (#2991) when the legacy adapters retire
and the helpers can be shared.

The rest of the growth is the reasoning: each migrated site carries a comment
saying what the value IS — a calendar day, which takes no timezone, or an instant,
which requires one — because that distinction is the whole defect class this epic
exists to close, and a reader who cannot tell the two apart is exactly how the
next one gets written. Deleting those comments to fit a budget would be trading
the durable half of the change for the disposable half.

Splitting is not the better answer for any of them here. Each is a single admin
panel whose size comes from its FORM — dozens of fields, dialogs and status
branches in one screen — not from mixed responsibilities, so the seam a split
would need does not exist and inventing one to absorb four lines of temporal
plumbing would leave a worse file behind. Their length is pre-existing debt this
change neither created nor is the right place to repay.

file: src/components/admin/booking-policies/minimum-night-stay-section.tsx
lines: 871
reason: the minimum-stay boundary formatter moved off the zoned instant
  formatter onto the kernel's calendar-date one, which needs no zone at all, and
  the comment records why the value was never an instant. Splitting the section
  would separate the policy form from the draft model it edits.

file: src/components/admin/booking-requests/policy-exception-requests-panel.tsx
lines: 1034
reason: same split of kinds - the proposed nights are calendar days, the three
  request stamps are instants - in a single officer decision queue whose length
  is its form fields and status branches rather than mixed responsibilities.

file: src/components/admin/booking-requests/public-booking-requests-panel.tsx
lines: 2239
reason: the largest of the queue screens and the same fixed cost: one
  calendar-date helper, one instant hook, and the reasoning for each. It was
  already 2217 lines of one screen before this change; splitting it is a real
  refactor that this migration must not smuggle in beside a timezone fix.

file: src/components/admin/manual-refund-task-queue.tsx
lines: 740
reason: THREE distinct temporal kinds in one file, which is why this one grew
  most: the stay dates are calendar days, `refundedAt` is the payment task's
  `completedAt` and therefore an instant, and both appear in a sub-component that
  needs its own hook call. Getting that wrong moves money-facing dates by a day,
  so each is named rather than left to the reader.

file: src/components/admin/page-content-panel.tsx
lines: 2585
reason: one "last saved" stamp became a hook, plus its reasoning. Eight lines on
  a 2577-line CMS editor whose size is entirely pre-existing.

file: src/components/admin/xero-record-activity-panel.tsx
lines: 724
reason: the sync stamp is used from two components in the file, so the hook is
  called twice; the alternative is threading the binding through props, which is
  more lines and a worse shape.

file: src/components/website/skifield-whakapapa-widget.tsx
lines: 744
reason: this is the one public-site surface reading an instant, and its comment
  records the mount point that makes that possible on the one page outside both
  website route groups. That sentence is the only place a reader learns why
  `skifield-whakapapa-embed.tsx` exists.
