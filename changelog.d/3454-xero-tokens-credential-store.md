- **The audit log now says who changed the club's Xero connection, and who
  turned on a member's two-factor sign-in (#3454).** Connecting Xero,
  disconnecting it, and every automatic token refresh are now recorded:
  connecting and disconnecting name the administrator who did it, and a refresh
  names the background job. Before, the trail recorded nothing at all about the
  tokens. Saving a new Xero client id or secret still disconnects Xero, but the
  save and the disconnect now happen together as one action. They can no longer
  be split by a failure, and the log entry for the disconnect names the
  credential that caused it. The Xero tokens are now held in the same encrypted
  store as the club's other provider credentials. Turning on two-factor sign-in
  is recorded too, as are replacing the recovery codes and clearing it all when
  an account is erased. The member can see their own enrolment on their
  activity history. These entries
  are filed under Security, so anyone who can read Security entries in the
  audit log (including a support-only operator) can see them. That audience is
  one entry type wider than before, and deliberately so: they hold no secret,
  only what changed (two-factor turned on, recovery codes replaced, or the
  second factor cleared) and by which method.
  Nothing changes for the operator: the existing connection keeps working
  through the upgrade without a reconnect.
