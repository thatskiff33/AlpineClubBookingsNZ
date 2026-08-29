- **Someone whose only admin job is the money can now get into the admin area to
  do it — and still cannot get at anything else (#2984, #2975).** A club that
  gave somebody the "Finance Viewer" or "Treasurer" role, and nothing else, had
  handed them a job they could not fully reach. The system had two different
  ideas about whether such a person counted as an administrator: parts of it
  said no and hid the Admin link, other parts said yes and pointed them at the
  Payments screen. The visible symptom was small and confusing — pages that
  needed the list of lodge names to say *which* lodge a payment was for came up
  empty for them, with no way for an administrator to fix it from the Access
  Roles screen.

  Holding any one of the seven admin areas — Overview, Bookings, Membership,
  Finance, Lodge Operations, Content, or Support — now counts as being an
  administrator, and the Admin link appears. That is the whole of the change:
  being let in the front door grants nothing on its own. Every screen, every
  action and every underlying request still asks for the specific area it
  belongs to, exactly as before. A finance-only administrator reaches the admin
  area and the Finance screens and nothing else — they cannot open Members,
  Bookings, Site Content, Access Roles or Settings, and they cannot change
  anything in Finance either if their role is view-only.

  A Full Admin is unaffected in every respect.

  Two smaller tightenings ship with it. The built-in help assistant used to
  decide which help text to give an administrator by asking only "are you an
  administrator", which meant any administrator could ask it for the help page
  of any admin screen, including ones they cannot open. It now asks whether they
  could open that screen. Nobody loses anything by this — asking about the page
  you are looking at always works. And the roster on the Notification Recipients
  screen now lists finance-only administrators alongside everyone else; who
  actually receives which alert is unchanged, because every alert is still
  matched to the recipient's own areas.

  Underneath, this release also adds a permanent check that the admin area's
  permissions really are enforced. It walks every admin screen and every admin
  request the software has, and tries each one as sixteen different kinds of
  administrator, so a future change that let the wrong role through — or shut
  the right one out — fails the build instead of reaching a club.
