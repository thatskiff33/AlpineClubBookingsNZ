- **Password-reset and sign-in-link emails are now limited per member, not
  just per internet address (#4613).** Someone sending requests from many
  addresses could previously make the club send one member a stream of
  "forgot password" or "sign-in link" emails they never asked for, at the cost
  of the club's sending quota and email reputation.

  Each of those emails now goes to one account at most 3 times an hour,
  however many addresses ask. A request past that limit gets the usual "check
  your email" answer and sends nothing, exactly as for an email address the
  club does not know, so the limit reveals nothing about who is a member. If a
  member says a reset or sign-in email never arrived, ask them to wait an hour
  and try again. No email address is stored for this count, and nothing needs
  setting up.
