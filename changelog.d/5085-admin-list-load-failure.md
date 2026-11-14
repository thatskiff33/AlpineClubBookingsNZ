- **Admin lists now say when they could not load, instead of showing an empty
  list or $0.00 (#4961).** When the Payments, Subscriptions, Hut Leaders or
  Communications send-history list failed to load, the page showed its normal
  empty state — "No payments found", zero totals, "No hut leader assignments
  yet" — or kept the previous search's rows under the new filters. Both looked
  like a real answer.

  Each page now shows a clear error with the reason and a **Try again**
  button, clears the old rows and totals, and hides the summary figures until
  the list loads. On Payments, a filter the server refuses is also pointed out
  above the table, so it is visible without opening **More filters**. On Hut
  Leaders, a failed check of unassigned nights is said, rather than the
  warning simply not appearing, and while the assignments could not be loaded
  the confirm step says its overlap check is unavailable instead of showing no
  clash. Try again keeps keyboard focus on its button and announces that it is
  trying again.
