- **Setting a lodge's capacity higher than its beds now explains what will
  actually happen (#2724).** On **Admin → Lodges → [a lodge]**, the capacity
  field always worked this way: what can be booked is the lower of the capacity
  you set and the beds currently switched on. Setting 30 while 24 beds are
  active was allowed and still is — it is a perfectly reasonable thing to do
  when more beds are on their way — but the screen said nothing about it, so
  the lodge quietly took 24 bookings and the 30 you typed looked wrong.

  The field now says so in figures as you type: that 30 is above the 24 active
  beds, that saving 30 is allowed, that only 24 places can be booked right now,
  and that activating 6 more beds raises the effective capacity up to 30. It is
  guidance, not an error — the **Save** button stays available and the value
  you typed is stored exactly as you typed it.

  **It also tells you what that extra capacity is already doing.** The figure
  above the bed count is not sitting idle waiting for beds: it is the room a
  lodge has for *partner spots* — the second occupant of a shareable double
  bed, which an officer can place by hand. With 24 beds of which 5 are doubles,
  a capacity of 30 allows up to 5 partner spots and a capacity of 24 allows
  none, so tidying the number down to match the beds would quietly remove every
  one of them. The field now names the spots the figure allows and says what
  lowering it would cost, and the capping warning below says the same thing for
  a capacity set under the bed count.

  The warning for that opposite case is otherwise unchanged: a capacity
  **below** the active beds still tells you it caps the lodge and how many beds
  are left allocatable but unbookable. Only one of the two ever appears at a
  time, and neither appears when the two numbers match. A value the save would
  refuse — zero, a negative, a fraction, or anything above the 100,000 maximum
  — is no longer explained as though it would be accepted: previously typing
  `0` claimed it would cap the lodge at zero, and a stray extra zero on a large
  figure was told the save was allowed and then failed with a bare "Invalid
  input". The field now carries the same limits the server uses and says what
  the accepted range is, and so does the second place a lodge's capacity can be
  set — the lodge settings card on **Admin → Setup**, which had no upper limit
  of its own at all.

  The explanation is also attached to the capacity field itself, so a screen
  reader announces it when you reach the field — including for an officer with
  view-only access, who cannot type at all — instead of interrupting with a
  half-typed figure's sentence on every keystroke.

  Nothing about how capacity is calculated changed anywhere in the system. The
  calculation simply moved into one place that both the booking engine and this
  screen read — the effective capacity, the partner-spot allowance and the
  accepted range alike — so what an officer is shown while typing cannot drift
  from what the club's booking pages will go on to do.
