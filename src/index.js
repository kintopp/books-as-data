#!/usr/bin/env node
// Entry point: serve the UB-SGBR MCP server over stdio.
// stdout is reserved for JSON-RPC — all logging goes to stderr.

import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';
import { assertAuthEndpointsSecure } from './config.js';

// Fail fast (before serving) if an ACL token is malformed or would ride on a
// non-HTTPS endpoint.
assertAuthEndpointsSecure();

serveStdio(() => createServer(), {
  onerror: (err) => console.error('[ub-sgbr-mcp] transport error:', err),
});

console.error('[ub-sgbr-mcp] listening on stdio');
