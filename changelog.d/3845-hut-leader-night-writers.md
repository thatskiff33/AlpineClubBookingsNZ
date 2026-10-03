- **Hut-leader assignments now cover only the nights the leader stays (#3817).**
  The nightly automatic assignment ends on the last night slept, never the
  check-out day, and gives a split stay one assignment per run of nights. An
  officer can no longer assign a night the member is not staying at that lodge
  (a cancelled or deleted booking is not a stay, and owning a booking without
  being a guest on it does not count): the page names the night and offers to
  change the last night to the last one stayed. The form, the assignments table
  and the assignment email now say "Last night" rather than "End date". A leader can now sign
  in from the day before their first night until midnight on the day they leave.
  The nightly job also now starts from today rather than yesterday.
- **Custodians are marked with a tick (#3817).** The assignment form has a
  **Custodian (lives on site)** tick, with or without bed allocation. A
  custodian counts as staying every night covered with no booking, and takes one
  space off the lodge's capacity on each of those nights (once, even if they
  also hold a bed). A custodian who is also a guest on a booking at that lodge
  is one space, not two, so a full night still takes their booking; only while
  bed allocation is on does a held bed stay a second space.
  **Hold a bed** is no longer offered while bed allocation is off.
  Each assignment row has a **Custodian** button to mark an existing
  assignment, so a custodian who holds a bed can be ticked and then have the
  bed released; releasing the bed of an unticked member who is not staying is
  refused.
