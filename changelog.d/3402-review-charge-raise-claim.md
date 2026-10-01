- **Two officers settling two money-owed reviews of one booking change at the
  same moment can no longer leave the member asked for less than the total
  (#3402).** Both settlements used to raise the member's payment request side by
  side, and whichever finished last won - so shares of $10 and $40 on a $50
  request could leave it at $60 instead of $100, with nothing recording the
  missing $40. Raising the request is now done by one settlement at a time: the
  other waits its turn and the first raises again for it, or the payment
  recovery job finishes the raise. A raise Stripe refuses changes nothing and is
  retried by that same job.
