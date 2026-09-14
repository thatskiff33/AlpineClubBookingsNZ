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

  Where the result is a CARD rather than a whole page — the lodge-capacity
  card, for one, which sits well below its heading — you are taken to the card
  itself instead of to the top of the page, so the confirmation and the focus
  ring are in the same place.

  Keyboard and screen-reader users get a real focus target in each case rather
  than a mouse-only scroll, and each of those targets now announces what it is
  ("Hut fees", "Joining fees", "Allocation preferences", the Xero section you
  asked for) instead of an unnamed box. Covered: the fees console's Edit
  buttons, per-fee pencils and season Edit/Copy, the family-groups editor, the
  allocation-preferences card, the committee screen, and the
  membership-cancellations, roster, booking-exception, member-fields, modules,
  membership-types, lodge-capacity and Xero mappings screens, plus the Xero
  setup's "go to section" links.

  One smaller correction rides along: an error message that centres itself was
  landing a little below the centre, because it was being given the clearance
  meant for messages that tuck under the sticky header. That affected every
  screen with a centred error box, members' as well as admins'.
