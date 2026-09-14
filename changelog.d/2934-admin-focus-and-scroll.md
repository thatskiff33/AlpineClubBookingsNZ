- **Admin screens now take you to the result of what you just did (#2934).**
  After clicking Edit, saving, or hitting an error on an admin page, the page
  used to change somewhere you might not be looking — an editor opening above
  the pencil you clicked, an error message off the top of the screen, a saved
  confirmation below it. Now one shared rule decides where you land: an error
  is brought into view and takes focus (and always wins over any "saved"
  positioning); an editor you opened comes into view and takes focus; a
  successful save that changed the screen positions you at the top of the
  resulting page or card. Background refreshes never move the page or steal
  focus, and admins who have asked their device for reduced motion get an
  instant jump instead of a smooth scroll.

  Keyboard and screen-reader users get a real focus target in each case rather
  than a mouse-only scroll. Covered: the fees console's Edit buttons and
  per-fee pencils, the family-groups editor, the allocation-preferences card,
  the membership-cancellations, roster, booking-exception, member-fields,
  modules, membership-types, lodge-capacity and Xero mappings screens, and the
  Xero setup's "go to section" links.
