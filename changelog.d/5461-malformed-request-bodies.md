- **A request body that is not valid JSON is now refused with a clear 400
  (#5407).** About eighty routes, among them payment, booking,
  credit and Xero routes, read their body their own way. On some, a body that
  was not valid JSON caused a server error (500). On others it got the same
  message as a body with a wrong field, or was quietly treated as no body at
  all, so the request went ahead with its defaults.

  These routes now answer such a body with a 400 and the standard message
  "Invalid JSON". A body with a wrong or missing field still gets the same
  answer as before. Where a body is optional, only an absent body (empty, or
  only spaces, tabs and line breaks) means "use the defaults"; a body that is
  valid JSON but not an object, such as `null`, is refused with a 400 and
  never runs the default action. The app's own screens always send valid
  JSON or no body, so officers and members will not notice a difference. A
  script or integration that sent a malformed body and relied on it being
  ignored will now be refused instead.

  A few answers change for bodies the app never sends. An empty body sent to
  a route that requires one now gets the shared invalid-JSON 400, where it
  got that route's own field message or a 500. The finance monthly-fact
  backfill now runs with its defaults for an empty JSON body, and the
  mountain-conditions refresh now refreshes for a body of only spaces or
  line breaks; both used to answer 400. Payment-link checkout, draft
  confirmation, removing a guest, the mountain-conditions refresh and the
  backfill used to treat a `null` body as no body; it is now a 400.
