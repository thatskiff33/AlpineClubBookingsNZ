- **Allocation preferences now live with the rooms and beds they apply to, in
  Bookings Setup → Rooms & Beds (#2937).** Whether the system proposes bed
  placements for a lodge, and what it tries to keep together first, used to be
  edited on the daily Bed Allocation board — a screen an officer works several
  times a day, carrying a setting they change perhaps twice a year. It has moved
  to the foot of **Bookings Setup → Rooms & Beds**, beside the rooms and beds it
  orders guests into. Nothing about how beds are allocated changed: the same
  preferences, in the same order, meaning the same things, saved in the same
  place, and needing the same bookings-edit access as before. The board now
  carries a link to the new home, already pointed at the lodge you were looking
  at, so getting there is one click from where you noticed the ordering was
  wrong. If that lodge has since been closed, the link takes you to the page's
  own lodge chooser instead of quietly opening a different lodge's preferences.

  Rooms & Beds sits under Lodge Operations while everything on it is gated on
  bookings access, so the move would have shut two shipped roles — the finance
  admin and the membership admin — out of a setting they could change the day
  before, by redirecting them away with no message. The page now opens for
  anyone holding either Lodge Operations or Bookings access. Nobody who could
  reach it loses it, and nobody gains anything the bed-allocation screens did
  not already give them.

  The move was also used to close a risk the old screen carried. Preferences are
  per lodge, and the card now takes its lodge from the page's own lodge chooser
  rather than working it out for itself. If no single lodge is settled — you are
  looking at every lodge, the lodge list is still loading, it failed to load,
  your admin role cannot choose a lodge, or the club has no active lodge — the
  card says which of those it is, shows nothing to change, and asks the club
  system for nothing at all. It can never fall back to "some lodge". And if you
  start editing one lodge's preferences and then switch to another, the unsaved
  changes are discarded rather than carried across, so a staged change can never
  be saved onto the wrong lodge.
