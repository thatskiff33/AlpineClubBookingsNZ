- **A request body that is not valid JSON is now refused with a clear 400
  (#5407).** About eighty routes, among them payment, booking,
  credit and Xero routes, read their body their own way. On some, a body that
  was not valid JSON caused a server error (500). On others it got the same
  message as a body with a wrong field, or was quietly treated as no body at
  all, so the request went ahead with its defaults.

  These routes now answer such a body with a 400 and the standard message
  "Invalid JSON". A body with a wrong or missing field still gets the same
  answer as before. Where a body is optional, an empty one still means "use
  the defaults", exactly as before, and a body of just `null` now means the
  same. The app's own screens always send valid
  JSON or no body, so officers and members will not notice a difference. A
  script or integration that sent a malformed body and relied on it being
  ignored will now be refused instead.
