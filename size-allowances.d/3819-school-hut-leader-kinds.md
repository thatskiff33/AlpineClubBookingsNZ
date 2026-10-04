# File-size allowances for #3819

file: src/app/(admin)/admin/lodges/[id]/page.tsx
lines: 646
reason: the hub renders the new "Who can be hut leader for school bookings"
  card and vouches for it with the page's one view-only banner (#2168), whose
  wording now names the setting. The card, its state and its fetches live in
  `school-hut-leader-kinds-card.tsx`; what stays here is the import, the
  module-gated render site with its vouch, and its comment.

file: src/lib/school-booking-request.ts
lines: 3072
reason: approval now reads the booking lodge's teacher tick instead of the
  club-wide switch, computes the teacher's last night (checkout - 1) once for
  the assignment and its PIN email, and refuses if the default lodge moved
  between that read and the lodge lock. All three belong to the one approval
  flow and its pre-transaction read; the resolver itself lives in
  `lodge-settings.ts`.

file: src/lib/config-transfer/categories/club-settings.ts
lines: 1178
reason: the retired switch moves from the booking-request settings field list
  to that spec's `excluded` map with its reason, which the reverse drift guard
  requires for every real column.

file: src/app/api/admin/hut-leaders/eligible-members/route.ts
lines: 278
reason: on a school night a suggestion may only offer a member whose kind the
  lodge ticks (#3819 review), so the route carries each stay's booking id and
  asks the shared `memberMayLeadNight` per night, and reports the nights left
  out. The rule itself lives in `hut-leader-night-cover.ts`; what stays here
  is the per-member night lookup that only this route's data shape has.

file: src/lib/config-transfer/categories/lodge-config.ts
lines: 1074
reason: the school hut-leader ticks travel in lodge.json beside capacity
  (#3819 review), so the lodge batch, the export descriptor, the plan's
  changed field and both apply paths each gain a call. Validation, the older
  bundle's switch mapping and the write live in
  `lodge-school-hut-leaders.ts`, as capacity's live in `lodge-capacity.ts`.
