- **An email the app stopped while sending is no longer lost without trace
  (#5298).** The app records each email just before it hands it to the mail
  server. If the app stopped between the two (a crash, deploy or restart), the
  email stayed "queued" for good: never sent, and nothing reported it. This
  could happen to any email, including booking confirmations, payment requests
  and refund notices.

  The email retry job now finds such an email within about an hour with the
  default mail settings (longer if the mail server timeouts have been raised).
  If it never reached the mail server, it is sent then, once, unless it is an
  alert its own feature already sends again. If it may have reached it,
  it is not sent again automatically, because the member would then get it
  twice: it appears in Admin, Email Deliverability, under Exhausted Email
  Failures, marked "May already have been delivered", and every officer who
  receives email-failure alerts is told. **Try again** on such a row warns that
  the recipient may receive it twice, so check with them first. Emails the app
  stopped on more than seven days ago are left alone.
