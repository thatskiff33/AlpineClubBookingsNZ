export interface BookingErrorPaymentTarget {
  name: string;
  invoiceUrl: string | null;
  invoiceNumber: string | null;
}

export function getBookingErrorPaymentTargets(
  data: unknown
): BookingErrorPaymentTarget[] {
  if (!data || typeof data !== "object") {
    return [];
  }

  const payload = data as Record<string, unknown>;

  if (payload.code === "SUBSCRIPTION_REQUIRED") {
    const invoiceUrl =
      typeof payload.invoiceUrl === "string" ? payload.invoiceUrl : null;
    const invoiceNumber =
      typeof payload.invoiceNumber === "string" ? payload.invoiceNumber : null;

    return invoiceUrl || invoiceNumber
      ? [
          {
            name: "Your subscription",
            invoiceUrl,
            invoiceNumber,
          },
        ]
      : [];
  }

  if (
    payload.code !== "GUEST_SUBSCRIPTION_REQUIRED" ||
    !Array.isArray(payload.unpaidMemberInvoices)
  ) {
    return [];
  }

  return payload.unpaidMemberInvoices.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "Unpaid member";
    const invoiceUrl =
      typeof record.invoiceUrl === "string" ? record.invoiceUrl : null;
    const invoiceNumber =
      typeof record.invoiceNumber === "string" ? record.invoiceNumber : null;

    return invoiceUrl || invoiceNumber
      ? [
          {
            name,
            invoiceUrl,
            invoiceNumber,
          },
        ]
      : [];
  });
}
