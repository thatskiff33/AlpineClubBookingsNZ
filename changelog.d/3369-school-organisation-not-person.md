- A school's booking now belongs to the school, and there is no longer an
  invented person standing in for it. Until this release every school that ever
  booked with the club existed as a member record carrying the school's name
  where a first name goes and nothing where a surname goes; that row owned the
  booking, held the school's Xero customer, and was the subject of every audit
  line about it. The school's own record does all three now, so the booking
  officer stops meeting buildings in the member list and the treasurer stops
  seeing surnameless people in Xero
  ([#3369](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3369),
  stage 4 of [#2912](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/2912)).
- Every screen that names who a booking belongs to reads the same either way, so
  a school appears under its own name exactly as it did before — with one
  correction: a school whose name is longer than a hundred characters is no
  longer shown cut off. Where a screen offers a link to a member's page, a school
  is named without one, because there is no member page to go to.
- Schools already in the club's records are moved across by the release itself,
  and **nothing about it is guessed**. Before the release runs, a read-only
  census sorts every school-shaped record into "this is a school", "this is a
  teacher", or "cannot tell", proving the first two from the club's own approval
  records rather than from how a name looks. Every "cannot tell" row goes to a
  person, who records the answer under their own name with their own reason. If
  even one is left undecided the move refuses and writes nothing at all, and the
  upgrade waits — which is the point.
- What a school was charged does not change. No price, fee, discount or refund
  moves, no money row is repaired, and a school's Xero customer keeps its id, its
  history and every invoice already on it.
- Two things a school's booking now says no to rather than doing quietly, because
  both belong to a person and a school is not one: it cannot be settled as
  account credit (a refund goes back the way it came instead), and it cannot be
  copied or turned into a group booking. Each refusal says so in words rather
  than failing somewhere later.
- A member profile can no longer be merged with a school's record. Two records
  for one school are merged as schools instead, where they belong.
- Upgrading takes a short planned outage rather than a rolling changeover,
  because the previous version cannot read a booking that has no member. The
  operator steps — including the classification, which is done days beforehand —
  are in the School Organisation Cutover guide.
