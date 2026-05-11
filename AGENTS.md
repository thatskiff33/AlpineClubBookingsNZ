<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Production Environment Rule

This workspace is on the live Lightsail production environment. Do not start local development servers (`npm run dev`, `next dev`, or similar) unless the user explicitly asks for one.

## External Connector Boundary

Before using any external connector, MCP tool, or third-party account, verify that it belongs to this repository's client/context or was explicitly identified by the user for the task. If the connector identity is unclear, do not call it.
