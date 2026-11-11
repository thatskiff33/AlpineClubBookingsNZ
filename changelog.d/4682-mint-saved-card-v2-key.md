- **A saved-card charge whose answer is lost, and that completes later, is
  matched to the booking even when Stripe sends no request id (#4682).**
  The charge now tells Stripe which attempt it belongs to, so the later
  payment is recorded on that booking instead of sitting unmatched for a
  treasurer to sort out by hand. A charge an earlier release already started
  is unchanged, and still needs a person to match it.
