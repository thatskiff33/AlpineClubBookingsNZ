# File-size allowances for #5009

Each of these files links a Members page, and now takes that link from the
hub registry (`adminHref`) instead of writing the URL by hand. The only
growth in each is the one line that imports `adminHref`.

file: src/app/(admin)/admin/bookings/page.tsx
lines: 835
reason: one import line, so the member link on a booking comes from the hub
  registry. Splitting the bookings list is a refactor of its own and would
  not shrink this hunk.

file: src/app/(admin)/admin/membership/deletion-requests/deletion-requests-client.tsx
lines: 1494
reason: one import line, so the member link on a deletion request comes from
  the hub registry. The link sits beside the request it opens.

file: src/app/(admin)/admin/membership/family-groups/page.tsx
lines: 882
reason: one import line, so the member links on a family group come from the
  hub registry. Splitting the family-groups page is a refactor of its own.

file: src/app/(admin)/admin/membership/members/[id]/page.tsx
lines: 1354
reason: one import line, so this member page's own links come from the hub
  registry. Splitting the member page is a refactor of its own and would not
  shrink this hunk.

file: src/app/(admin)/admin/membership/members/page.tsx
lines: 605
reason: one import line, so the member list links come from the hub registry.
  Splitting the member list is a refactor of its own and would not shrink
  this hunk.

file: src/app/(admin)/admin/membership/membership-cancellations/page.tsx
lines: 1229
reason: one import line, so the member link on a cancellation comes from the
  hub registry. The link sits beside the cancellation it opens.

file: src/app/(admin)/admin/rules/promo-codes/promo-redemptions-panel.tsx
lines: 819
reason: one import line, so the member link on a redemption comes from the
  hub registry. The link sits beside the redemption it explains.

file: src/components/admin/booking-requests/policy-exception-requests-panel.tsx
lines: 1015
reason: one import line, so the member link on an exception request comes
  from the hub registry. Splitting the exception queue is a refactor of its
  own and would not shrink this hunk.
