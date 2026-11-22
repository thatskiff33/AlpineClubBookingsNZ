- **The officers' Daily digest counts every alert, not every subject line
  (#5407).** The digest used to count alerts with the same subject as one, so
  two members' card payments failing on the same night showed as one payment
  failure, and two Xero sync errors in a day showed as one. It now counts each
  alert once, however many officers received a copy.

  Expect the Payment failures and Xero errors numbers in particular to go up:
  those alerts always have the same subject, so they were the most
  undercounted. Nothing about when the alerts themselves are sent changed, and
  a subject your club saved for an alert no longer affects the count.
