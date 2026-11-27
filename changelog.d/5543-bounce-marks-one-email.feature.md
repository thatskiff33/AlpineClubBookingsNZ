- **A bounce now marks only the email that bounced, and officers are told when
  a member reports a club email as spam (#5469).** When the mail provider
  reported a bounce or a complaint, every earlier email to that address was
  marked bounced, so a member's history could show delivered emails as bounced
  and officers could not tell which one had failed. Now only the email the
  report is about is marked. The address is still blocked from further emails
  exactly as before. A member who received their waitlist offer still counts as
  told when a different email to them later bounces.

  To match a report to its email, the app now stores the id the mail server
  gives each email when it is sent. This works for Amazon SES without any
  setup. Emails sent before this upgrade are matched only if your SES
  notifications include the original email headers, which is optional; without
  it an older email that bounces keeps reading as sent, while the address is
  still blocked.

  What officers notice, by owner decision: a new alert, "Complaint About a Club
  Email", sent to officers with the "Reported issues" preference when a member
  marks a club email as spam, once for each report. It names the address, the
  members who use it, the email where the app can tell, and says the address is
  now blocked, with a link to the Email Deliverability page where the block can
  be lifted. The email itself stays recorded as sent, because it did arrive. A
  "not spam" report, where a member moves a club email out of their spam folder,
  no longer blocks the address. The block covers this site's own emails;
  invoices emailed by Xero are not affected by it. In the Exhausted Email
  Failures list, an email to a blocked address now says so and offers no "Try
  again", which could only be refused.

  Emails the old rule already marked bounced stay marked. During the upgrade, a
  server still running the previous version marks every email to an address as
  before and sends no complaint alert. The upgrade adds a column and an index
  to the email log; building the index makes email sending wait briefly, longer
  on a very large email log (see the upgrade notes if email-log pruning is off
  and your log is large).
