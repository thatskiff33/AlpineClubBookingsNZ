import { sanitiseClubPostHtml } from "@/lib/club-post-html";

/**
 * Render one post's body (epic #2992).
 *
 * `bodyHtml` reaches here already sanitised — on write, and again in
 * `serializeClubPostForMember` — and is sanitised ONCE MORE here. Three passes
 * is deliberate rather than sloppy: this is the only component in the app that
 * hands member-authored markup to `dangerouslySetInnerHTML`, so it does not
 * rely on any caller having done the right thing. A future caller that assembles
 * a post from somewhere else gets the same guarantee for free.
 *
 * Falls back to the plain text for every post written before the editor
 * existed, and for anything whose HTML sanitised away to nothing.
 */
export function ClubPostBody({
  content,
  bodyHtml,
  className = "",
}: {
  content: string;
  bodyHtml: string | null;
  className?: string;
}) {
  const safe = bodyHtml ? sanitiseClubPostHtml(bodyHtml) : "";

  if (!safe) {
    return (
      // Plain text, escaped by React. `whitespace-pre-wrap` keeps the member's
      // own line breaks without any markup.
      <p className={`whitespace-pre-wrap text-sm text-foreground ${className}`}>
        {content}
      </p>
    );
  }

  return (
    <div
      className={`text-sm text-foreground [&_blockquote]:my-2 [&_blockquote]:border-l-4 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:italic [&_h1]:mb-2 [&_h1]:mt-3 [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:mb-2 [&_h2]:mt-3 [&_h2]:text-xl [&_h2]:font-bold [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:text-lg [&_h3]:font-semibold [&_img]:my-2 [&_img]:max-w-full [&_img]:rounded [&_li]:my-1 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-1 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_a]:underline ${className}`}
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}
