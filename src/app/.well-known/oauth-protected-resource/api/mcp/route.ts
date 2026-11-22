/**
 * GET /.well-known/oauth-protected-resource/api/mcp (ALP-653, RFC 9728)
 *
 * The path-suffixed form of the protected-resource metadata, which is the
 * address the MCP endpoint's 401 names. The same answer as the bare path.
 */
export { GET } from "../../route";
