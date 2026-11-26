- **Every booking edit now settles the price the member was shown, or stops (#5238).**
  Since v0.14.0 an ordinary edit refused to save when the price had moved since the member saw it. Three other ways of saving a change still worked the price out again at save time, so a change-fee band, a rate or a promotion that moved in between could charge or refund a different amount from the one the member agreed to. They now behave the same way:

  - Moving two of your bookings together. When a change would leave another of your bookings without an adult, the offer to move both now holds each booking's price. If either price has moved by the time you accept, neither booking is changed. The panel shows the new offer and says nothing was saved, so you can choose again.
  - Date changes sent to the date-only save. These now check the price shown and refuse if it has moved, with nothing charged, refunded, invoiced or emailed.
  - A save that carries no price at all is now refused with "This page is out of date. Reload it, check the price and save again." Only a page left open from before this release, or a script, sends one. Reloading the page fixes it.

  Officers approving an exception or carrying out a change request are not affected: those changes have no preview, and they are priced when they are carried out, as before.
