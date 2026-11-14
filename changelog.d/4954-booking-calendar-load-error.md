- **The booking calendar now says when a month's availability could not be
  loaded, and offers Try again (#4954).** Before, a failed request (often a weak
  mobile signal) turned every night grey with a `?` and nothing else, so a member
  could pick nights blind and learn they were full only at submit. The calendar
  on Book a Stay and on the officer's Book on Behalf page now shows an error
  above the month, announced to screen readers, with a **Try again** button that
  asks for that month again. The legend gains an entry explaining `?`. Nights
  marked `?` can still be chosen, because the server re-checks the lodge when the
  booking is submitted; nothing about pricing or capacity changes.
