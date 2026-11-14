- **A card refund Stripe failed later can no longer be paid back twice (#4492).**
  Stuck States no longer offers **Paid another way** on a refund the app gave
  up on while the same money may already be going back to the card, including
  after that card refund has succeeded. The button is also withheld on a refund
  that replaces a superseded payment while the other refund has not gone back
  to the card, and on a failed refund that died because that charge was already
  sent. The row stays on the list and says why.
