- **A group's emailed Internet Banking invoice now always matches the group,
  and money paid against it is never quietly lost (#3642).** When an organiser
  pays for their whole group by Internet Banking, one combined Xero invoice is
  emailed. Until now the group could change underneath it: someone joining
  afterwards and the organiser clicking Internet Banking again raised the
  amount owed without changing the invoice, so paying the old invoice marked
  everyone paid for less than they cost. Paying by card instead left the
  emailed invoice payable in Xero, so a second payment could be kept without
  anyone noticing, and a settlement that lapsed unpaid left its invoice sitting
  in receivables.

  Now the organiser's page shows the outstanding invoice from the server,
  including after a reload, and says whether it is still being prepared, has
  been emailed, or could not be sent. It names anyone who joined after the
  invoice went out. If the group has changed, the organiser can send an updated
  invoice: the old one is cancelled in Xero and a new one is raised for the
  current total. If the old invoice has already been partly or fully paid, it
  is left alone, the organiser is told the club will be in touch, and the
  admins get an alert. The invoice can't be switched to a card payment while it
  is open.

  When an unpaid settlement lapses, its invoice is cancelled in Xero
  automatically. If the invoice has started being paid, the group keeps its
  beds and the admins are alerted rather than the group being released. A
  payment is only applied when it matches what the group owes. An invoice paid
  for a different total, a payment on an invoice that was already replaced or
  cancelled, and an invoice paid on top of a card payment each send the admins
  one alert instead of passing silently. Nothing changes for groups where each
  person pays for themselves.
