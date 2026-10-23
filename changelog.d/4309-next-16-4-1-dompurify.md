- **Next.js 16.4.1 and DOMPurify 3.4.17 close six dependency advisories (#4309).**
  GitHub published advisories on 23 October 2026 against the Next.js release
  the site ran on (two critical, unauthenticated remote code execution, and one
  denial of service) and against the DOMPurify copy that PDF export pulls in.
  Both move to their patched releases; nothing in the app's own code changes.
  The braces mitigation record (#3843) is refreshed on unchanged evidence with
  the new lockfile digest and a new expiry. Deployments pick the fix up with
  the next image build.
