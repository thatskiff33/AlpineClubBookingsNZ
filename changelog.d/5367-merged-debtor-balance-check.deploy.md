## Who

owner

## What to do

On a deployment whose member-money journal is active, run the read-only
receipt census once the new release is serving:
`pnpm run member-money:receipt-catch-up --dry-run`. It changes nothing.
Look in its JSON `findings` for any `MERGED_DEBTOR_BALANCE` row: a receivable
left on a merged-away member by a refund-debt withdrawal posted before #5367.
Record the result on #5438. If there are none, write "checked, none"; if
there are any, a one-off repair is the owner's decision and needs its own plan.

## How to check it worked

#5438 records the result of the run, and the census output lists no
`MERGED_DEBTOR_BALANCE` finding, or each one found is tracked on #5438.
