- **Automated checks cover accessibility and phone screens (#4466).** Browser
  tests now flag serious accessibility problems and exercise member notices,
  bookings and card payments on a Pixel 7 screen. Lint prevents increases in
  existing accessibility and small-text violations, including text below 12px.
- **Accessibility fixes the new checks found (#4466).** Error text, toast
  messages, chart legends and the bookings calendar's status filters now meet
  WCAG contrast; filter dropdowns and other unlabelled controls are named for
  screen readers; small checkboxes and the members Export button are easier to
  hit; and a link to a switched-off feature shows a "Page not found" page
  instead of a blank one.
