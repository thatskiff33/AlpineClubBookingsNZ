- **A date that does not exist, such as 30 February, is now refused cleanly
  in the last few places that only checked its shape (ALP-580).** The legacy
  dashboard bookings export answered such a date with a server error instead of
  saying the request was wrong, and the display board's preview tools would
  start "simulating" a day the board itself refuses. Both now treat it as an
  invalid date. Internal readers of stored Xero and hosting-coverage records
  also refuse a non-existent day instead of passing it on, and a new check stops
  hand-written date patterns from coming back.
