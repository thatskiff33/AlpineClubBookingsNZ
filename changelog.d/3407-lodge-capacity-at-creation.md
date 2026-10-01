- **A new lodge is created with its capacity, and a lodge without one says so (#3407).**
  **Add lodge** now asks how many guests the lodge can sleep, and the lodge is
  created with that figure already in place, so it can take bookings straight
  away. With Bed Allocation off, the setup wizard gains a **Capacity** step, and
  its last step says the lodge is ready only when it can actually take a
  booking. A lodge that still has no capacity, such as one created before this
  release, no longer tells people "a booking cannot exceed 0 guests" or offers
  every night as **Waitlist**. The refusal and the booking calendar now say the
  lodge is not set up for bookings yet, for members and for officers booking on
  their behalf, and the public booking-request and school forms show the same
  notice instead of "0 max". Setup readiness now names every active lodge in
  that state, not only the default one. Adding guests to a booking at a second
  lodge is no longer refused because of the default lodge's capacity. On
  **Admin → Book**, the not-set-up notice links an officer whose role can open
  lodges to the lodge's capacity setting. A configuration export now carries each lodge's capacity,
  and an import restores it; a bundle exported before this release still
  imports as it did. An admin who can only view lodges can now step through the
  setup wizard instead of being stuck on its first step. The
  booking rules are unchanged, and a lodge with a capacity behaves exactly as
  before. See the [Lodges guide](../docs/guides/lodges.md).
