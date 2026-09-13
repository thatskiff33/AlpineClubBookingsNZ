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

  The existing warning for the opposite case is unchanged: a capacity **below**
  the active beds still tells you it caps the lodge and how many beds are left
  allocatable but unbookable. Only one of the two ever appears at a time, and
  neither appears when the two numbers match. A value the save would refuse —
  blank, zero, a negative or a fraction — is no longer explained as though it
  would be accepted; previously typing `0` claimed it would cap the lodge at
  zero, which the save would never have done.

  Nothing about how capacity is calculated changed anywhere in the system. The
  calculation simply moved into one place that both the booking engine and this
  screen read, so what an officer is shown while typing cannot drift from what
  the club's booking pages will go on to do.
