interface XeroUrlOptions {
  shortCode?: string | null;
}

function buildXeroUrl(path: string, options?: XeroUrlOptions): string {
  if (options?.shortCode) {
    const shortCode = encodeURIComponent(options.shortCode);
    const redirect = encodeURIComponent(path);
    return `https://go.xero.com/organisationlogin/default.aspx?shortcode=${shortCode}&redirecturl=${redirect}`;
  }

  return `https://go.xero.com${path}`;
}

export function buildXeroContactUrl(
  contactId: string,
  options?: XeroUrlOptions
): string {
  return buildXeroUrl(`/Contacts/View/${encodeURIComponent(contactId)}`, options);
}

export function buildXeroInvoiceUrl(
  invoiceId: string,
  options?: XeroUrlOptions
): string {
  return buildXeroUrl(
    `/AccountsReceivable/View.aspx?InvoiceID=${encodeURIComponent(invoiceId)}`,
    options
  );
}

export function buildXeroCreditNoteUrl(
  creditNoteId: string,
  options?: XeroUrlOptions
): string {
  return buildXeroUrl(
    `/AccountsReceivable/ViewCreditNote.aspx?creditNoteID=${encodeURIComponent(creditNoteId)}`,
    options
  );
}

export function buildXeroObjectUrl(
  objectType: string,
  objectId: string,
  options?: XeroUrlOptions
): string | null {
  switch (objectType) {
    case "CONTACT":
      return buildXeroContactUrl(objectId, options);
    case "INVOICE":
    case "SUBSCRIPTION":
      return buildXeroInvoiceUrl(objectId, options);
    case "CREDIT_NOTE":
    case "CREDITNOTE":
      return buildXeroCreditNoteUrl(objectId, options);
    default:
      return null;
  }
}
