## Who

operator

## What to do

Before or during the deploy, check that your Stripe webhook endpoint sends the
four `charge.dispute.*` events added by #5061, as `DEPLOYMENT.md` lists them.

## How to check it worked

The endpoint's event list in the Stripe dashboard includes
`charge.dispute.created`, `charge.dispute.funds_withdrawn`,
`charge.dispute.funds_reinstated` and `charge.dispute.closed`.
