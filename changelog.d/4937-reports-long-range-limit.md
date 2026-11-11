- **Running Reports over several years no longer freezes the booking site
  (#4937).** **Admin → Finance → Reports** worked out each night's occupancy by
  re-reading every booking once per night, on the same server thread that
  serves members, so a five-year range could stall everyone's pages for a few
  seconds. It now reads the bookings once for the whole range, and the figures
  are unchanged.

  Reports now cover at most 732 days (about two years). A longer From/To range
  shows a message naming that limit in place of the figures; run one report
  per year or two and combine the exports.
