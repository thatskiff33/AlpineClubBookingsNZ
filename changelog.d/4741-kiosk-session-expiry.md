- **The lodge kiosk tablet now really stays signed in for 30 days without use
  (#4612).** The kiosk account was meant to stay signed in on the shared lodge
  tablet for 30 days, but the setting never took effect: like every other
  account, it was signed out after 8 hours without use, so a quiet night could
  leave the tablet needing someone with the kiosk password.

  The kiosk account now stays signed in for 30 days without use, and each time
  the kiosk page is opened or brought back to the front the 30 days start again.
  Only the kiosk account itself gets this: the account whose User Type is
  "Lodge (kiosk account)", which has no role besides User and Lodge. Every
  other account still signs out after 8 hours without use, including an admin
  or officer who also has the Lodge box ticked, and anyone who signs in with
  their own account on the kiosk tablet. A person's record with only User and
  Lodge ticked counts as the kiosk too, so give that person a second role or
  untick Lodge. Give the kiosk account itself a second role and its next refresh
  drops it to 8 hours. A hut leader's PIN unlock is unchanged: it still locks
  after 10 minutes without use.
