/**
 * Save a fetched download under the server's `Content-Disposition` file name,
 * or `fallbackName` when the header names none (#2801). Browser only: it
 * clicks a temporary object-URL link, which is how a `fetch` (rather than a
 * plain link) can still report an error response on the page.
 */
export async function saveResponseAsFile(response: Response, fallbackName: string): Promise<void> {
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const [, matchedFilename] = disposition.match(/filename="(.+?)"/) ?? [];
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = matchedFilename ?? fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
