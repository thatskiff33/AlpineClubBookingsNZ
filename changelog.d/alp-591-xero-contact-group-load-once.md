- **The Xero Setup Tools step no longer re-requests contact groups in a loop
  (ALP-591).** When the step appears it asks for the Xero contact groups once.
  If that load fails, or Xero returns no groups, nothing more is requested and
  the panel shows "Load Contact Groups" (with the error, if there was one) until
  the admin presses it; before, the panel kept asking the server again for as
  long as it was shown. Reset still clears the list and loads it again.
