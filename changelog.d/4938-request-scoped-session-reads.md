- **Signed-in pages make fewer database reads (#4938).** Each page load used to
  check who was signed in two or three times, once for the page frame and again
  for the page itself, reading the member's record, the club's module settings
  and its login-security settings each time. Those checks are now done once per
  page load and shared, so a busy moment holds fewer database connections.

  Nothing a member sees changes, and nothing is remembered between page loads:
  a role change, a switched-off login or a changed session setting still
  applies on the very next request.
