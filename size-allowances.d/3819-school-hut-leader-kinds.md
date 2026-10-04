# File-size allowances for #3819

file: src/app/(admin)/admin/lodges/[id]/page.tsx
lines: 646
reason: the hub renders the new "Who can be hut leader for school bookings"
  card and vouches for it with the page's one view-only banner (#2168), whose
  wording now names the setting. The card, its state and its fetches live in
  `school-hut-leader-kinds-card.tsx`; what stays here is the import, the
  module-gated render site with its vouch, and its comment.

file: src/lib/school-booking-request.ts
lines: 3070
reason: approval now reads the booking lodge's teacher tick instead of the
  club-wide switch, computes the teacher's last night (checkout - 1) once for
  the assignment and its PIN email, and refuses if the default lodge moved
  between that read and the lodge lock. All three belong to the one approval
  flow and its pre-transaction read; the resolver itself lives in
  `lodge-settings.ts`.

file: src/lib/config-transfer/categories/club-settings.ts
lines: 1177
reason: the retired switch moves from the booking-request settings field list
  to that spec's `excluded` map with its reason, which the reverse drift guard
  requires for every real column.
