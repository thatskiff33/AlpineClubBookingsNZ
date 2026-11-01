- Card refund retries now check Stripe before sending money again. If a dashboard
  refund may already have paid the debt, automatic retries stop and officers are
  alerted to check it before paying anything else. Refunds first discovered by
  that check retain their existing accounting corrections. The hold writes one
  `payment` audit entry, readable by the people who already see payment records.
