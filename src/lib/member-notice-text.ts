import { htmlToPlainText } from "@/lib/email-text";
import type { MemberNoticeView } from "@/lib/notices";

/** A notice as an AI app connection reads it (ALP-718): its body as plain text, so no markup reaches the app. */
export type MemberNoticeTextView = Omit<MemberNoticeView, "bodyHtml"> & { body: string };

/** The one place a notice's markup is stripped for a connection, for `list_notices` and `get_notice` alike. */
export function memberNoticeAsText({ bodyHtml, ...rest }: MemberNoticeView): MemberNoticeTextView {
  return { ...rest, body: htmlToPlainText(bodyHtml) };
}
