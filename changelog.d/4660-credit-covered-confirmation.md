- **A booking paid entirely by credit, or at no charge, is now in the ledger when it is confirmed (#4660).**
  Creating that booking, or settling it on the pay step, marks it paid and posts its confirmation in the same step. The charge is in the journal without waiting for a later back-post. Doing it again does not post the charge a second time.
