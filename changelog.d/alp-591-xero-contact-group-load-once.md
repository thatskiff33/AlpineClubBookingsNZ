- **The Xero Setup Tools section no longer re-requests contact groups in a loop
  (ALP-591).** Opening the section loads the Xero contact groups once. If that
  load fails, or Xero has no groups, the result stays on screen until the admin
  presses "Load Contact Groups"; before, the panel kept asking the server again
  for as long as the section was open. Closing and reopening the section loads
  them afresh.
