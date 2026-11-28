/**
 * Why a send to a suppressed address was refused, as the email core and the
 * retry job record it on the row (#5469: it names no mail service, since any
 * service's bounce or complaint can block an address). A leaf of its own so
 * neither sender's tests have to stub it with the suppression list.
 */
export function suppressedEmailErrorMessage(reason: string): string {
  return `Email suppressed after a ${reason.toLowerCase()} report`;
}
