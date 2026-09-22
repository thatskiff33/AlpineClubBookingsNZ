- **Every amount a person reads now says `$84.50`, not `8450 cents` (#3533).**
  The audit trail's own sentences, operator report lines, cron summaries and
  error messages render money through the shared `formatCents` — 30 sites, seven
  of them in the cancellation path alone — and the admin audit-log's metadata
  panel annotates every `…Cents` key with the amount beside the stored number
  (`"refundAmountCents": 2275,  // $22.75`). Nothing stored changed: money is
  still whole cents, existing audit rows are untouched, and a new lint arm now
  fails the build on the next `${someCents} cents` sentence.
