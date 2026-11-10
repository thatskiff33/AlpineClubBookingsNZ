- **Signed-in sessions now remember when the person last proved who they are,
  ready for officers to be asked to confirm it's them (#4616).** Each session
  records the moment its sign-in completed, and a new "Confirm it's you" step
  lets a signed-in person prove themselves again with their authenticator app
  code, or with their password if they have no app. A confirmation counts for
  five minutes, a fixed security floor rather than a club setting.

  Nothing asks for it yet: the officer actions that will (restoring a backup,
  changing payment credentials and the like) are wired up in a later change of
  the same release. An emailed code and a recovery code are never accepted to
  confirm, and wrong attempts count towards the same lockouts sign-in uses.
  The upgrade adds one small database table and needs no action.
