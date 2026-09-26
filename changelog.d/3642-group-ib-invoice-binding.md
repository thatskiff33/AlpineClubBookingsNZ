- **A group's emailed Internet Banking invoice now stays the bill until it is
  paid or lapses (#3642).** When an organiser pays for their whole group by
  Internet Banking, one combined Xero invoice is emailed. Until now the group
  could change underneath it: someone joining afterwards and the organiser
  clicking Internet Banking again quietly raised the amount owed without
  changing the invoice, so paying the old invoice marked everyone paid for less
  than they cost. Paying by card instead left the emailed invoice payable in
  Xero, so a second payment could be kept without anyone noticing, and a
  settlement that lapsed unpaid left its invoice sitting in receivables.

  Now, while the invoice is outstanding, the organiser's page shows it as
  pending (also after a reload) and the system refuses to re-size it or switch
  it to card, saying why. When an unpaid settlement lapses, its invoice is
  voided in Xero automatically, and settling again raises a fresh invoice for
  the current total. A payment is only applied when it matches what the group
  owes; a short payment, a payment on an invoice that was already replaced, or
  an invoice paid on top of a card payment now sends the admins an alert
  instead of passing silently. Nothing changes for groups where each person
  pays for themselves.
