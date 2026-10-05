- **Accepted booking quotes now wait for officer review (#3415).** A requester
  sees a durable confirmation after accepting, while the booking team reviews
  the accepted quote before creating a booking, invoice, payment link, or PIN.

  The accepted quote keeps its held places until an officer approves or declines
  it, and the Public Requests queue now highlights it for action.

  The obsolete accept-time capacity-block audit record is retired because an
  accepted quote now keeps its existing bed hold through officer review. Its
  remaining acceptance record stays in the booking audit category.
