# File-size allowances for #3819

file: src/app/(admin)/admin/lodges/[id]/page.tsx
lines: 651
reason: the hub renders the new "Who can be hut leader for school bookings"
  card and vouches for it with the page's one view-only banner (#2168), whose
  wording now names the setting. The card, its state and its fetches live in
  `school-hut-leader-kinds-card.tsx`; what stays here is the import, the
  module-gated render site with its vouch, and its comment.

file: src/lib/school-booking-request.ts
lines: 3040
reason: approval now reads the booking lodge's teacher tick instead of the
  club-wide switch, computes the teacher's last night (checkout - 1) once for
  the assignment and its PIN email, and refuses if the default lodge moved
  between that read and the lodge lock. All three belong to the one approval
  flow and its pre-transaction read; the resolver itself lives in
  `lodge-settings.ts`.

file: src/lib/config-transfer/categories/club-settings.ts
lines: 1185
reason: the retired switch moves from the booking-request settings field list
  to that spec's `excluded` map with its reason, which the reverse drift guard
  requires for every real column.

file: src/lib/config-transfer/categories/lodge-config.ts
lines: 1074
reason: the school hut-leader ticks travel in lodge.json beside capacity
  (#3819 review), so the lodge batch, the export descriptor, the plan's
  changed field and both apply paths each gain a call. Validation, the older
  bundle's switch mapping and the write live in
  `lodge-school-hut-leaders.ts`, as capacity's live in `lodge-capacity.ts`.

file: src/app/api/admin/hut-leaders/eligible-members/route.ts
lines: 278
reason: a school night is offered to a member only when the lodge ticks that
  member's kind (on the school booking, or on a separate stay), so the stays
  carry their booking id and the uncovered nights are filtered once through
  the shared `memberMayLeadNight` rule, with the count of nights held back
  returned for the officer. It is the one place the suggestion list is built;
  the rule itself lives in `hut-leader-night-cover.ts`.
