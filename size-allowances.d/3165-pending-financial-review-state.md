# File-size allowances for #3165

file: src/lib/booking-cancel.ts
lines: 2411
reason: this change adds three lines to a file that was already 1,708 lines
  over its 700-line budget before anyone touched it, and the three lines are
  the point of the change rather than incidental to it. `booking-cancel.ts`
  truncated the `ManualRefundTask.reason` sentence it writes at a bare `500`
  literal, which was one of four separate homes for one database column's
  width — the schema, this literal, a private constant in
  `edit-financial-review.ts`, and the sibling note field. It now imports the
  shared `MANUAL_REFUND_TASK_REASON_MAX` constant instead, so widening the
  column is a one-line change rather than a hunt (`INV-SSOT`). Routing to a
  named constant costs an import line and a slightly longer expression.
  Splitting a 2,400-line cancellation module to pay for that is a refactor of
  its own — it would touch every cancellation path, every lock ordering
  comment and a large share of the booking test suite, and it belongs on an
  issue where it can be reviewed as the domain change it is rather than
  ridden in on a money-constant tidy-up. The module was over budget
  independently of this pull request and stays over it by the same margin
  plus three.
