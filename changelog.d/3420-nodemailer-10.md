- **The club's email sending now runs on the current version of the mail
  library (#3420).** The component that hands every message to the mail server —
  booking confirmations, password resets, officer notifications, door codes — was
  updated from version 9 to version 10, which the authors rewrote from the ground
  up.

  Nothing an administrator or member does changes, and no email looks any
  different. The club's mail settings, the send-from address and the local
  capture mailbox used on test copies of the site all behave exactly as before.
