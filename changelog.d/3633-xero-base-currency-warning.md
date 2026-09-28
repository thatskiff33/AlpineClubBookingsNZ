- **A warning when the club's currency and its Xero base currency differ
  (#3633).** Invoices this site sends to Xero carry no currency of their own,
  so Xero books them in the organisation's base currency, while card payments
  are charged in the club's currency. A club whose two currencies differed got
  card charges in one currency and Xero invoices in another, and nothing said
  so.

  Once Xero is connected, the site now compares the two. When they differ, a
  warning names both currencies on the Club Currency & Locale page, at the
  Connect step of the Xero setup wizard, and on the Operational Xero step of the
  setup list. It is a warning only: it blocks nothing and changes no invoice. It
  shows only to administrators with finance access, who can already read the
  Xero organisation's details, and it costs no extra call to Xero. A club on
  NZD with an NZD Xero organisation sees no change.
