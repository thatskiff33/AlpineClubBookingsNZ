- **Moving a guest to another bed no longer records the change as happening
  half a day in the future (#3825).** When an admin moved a guest's bed
  allocation, the moved rows' "last changed" time was written in the database's
  local time zone rather than UTC, so on a standard install it read 12 or 13
  hours ahead of every other change. Anything that showed or sorted allocations
  by when they last changed put those moves in the wrong place.

  Moves now record the correct time. Which bed each guest is in, capacity, and
  the protection against two admins moving the same guest at once are
  unchanged. Rows already moved keep their old timestamp until they are next
  changed; nothing needs to be done about them.
