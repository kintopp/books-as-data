// Builds a fresh McpServer with all tools registered. Used as the serveStdio
// factory — invoked once per connection (and possibly per protocol era), so it
// must be side-effect-free beyond registration. Shared state (caches) belongs
// at module scope in the modules that own it, not here.

import { McpServer } from '@modelcontextprotocol/server';
import { SERVER_NAME, SERVER_VERSION, SERVER_INSTRUCTIONS, CACHE_HINTS } from './config.js';
import { registerSearchTool } from './tools/search.js';
import { registerGetRecordTool } from './tools/get_record.js';
import { registerFacetValuesTool } from './tools/facet_values.js';
import { registerFacetBreakdownTool } from './tools/facet_breakdown.js';
import { registerGetFullTextTool } from './tools/get_fulltext.js';
import { registerAutocompleteTool } from './tools/autocomplete.js';
import { registerInspectImageTool } from './tools/inspect_image.js';
import { registerGetPageOcrTool } from './tools/get_page_ocr.js';
import { registerLocateTextTool } from './tools/locate_text.js';
import { registerGuideTool } from './tools/guide.js';

export function createServer() {
  // `listChanged` must be an explicit false: the SDK fills an absent value with
  // `true`, and this server never emits notifications/tools/list_changed. A
  // client told "cached for ttlMs, and I'll ping you if that changes" has no
  // correct refresh strategy when the second half is a lie — the TTL in
  // CACHE_HINTS is the only freshness signal here, and must be the only one
  // advertised.
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: { listChanged: false } },
      instructions: SERVER_INSTRUCTIONS,
      cacheHints: CACHE_HINTS,
    },
  );
  registerSearchTool(server);
  registerGetRecordTool(server);
  registerFacetValuesTool(server);
  registerFacetBreakdownTool(server);
  registerGetFullTextTool(server);
  registerAutocompleteTool(server);
  registerInspectImageTool(server);
  registerGetPageOcrTool(server);
  registerLocateTextTool(server);
  registerGuideTool(server);
  return server;
}
