const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { Bridge, TOKEN_FILE } = require('./bridge.js');

const bridge = new Bridge();
bridge.start();

const server = new McpServer({ name: 'mcp-chrome', version: '0.1.0' });

function tool(name, desc, schema, handler, opts = {}) {
  server.registerTool(name, {
    description: desc,
    inputSchema: z.object(schema),
  }, async (args) => {
    try {
      const res = await handler(args || {});
      return { content: [{ type: 'text', text: typeof res === 'string' ? res : JSON.stringify(res, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `ERROR: ${e && e.message ? e.message : e}` }], isError: true };
    }
  });
}

// status
tool('chrome_status', 'Connection status of the MCP bridge and the Chrome extension.', {}, async () => {
  return {
    bridgePort: bridge.port,
    tokenFile: TOKEN_FILE,
    extensionConnected: bridge.isConnected(),
  };
}, {});

tool('chrome_list_tabs', 'List open Chrome tabs (requires extension connected).', {}, async () => bridge.send('listTabs'));

tool('chrome_attach_debugger', 'Attach Chrome DevTools Protocol debugger to a tab. Defaults to active tab. Enables Network, Runtime, Page, DOM, Console domains.', {
  tabId: z.number().optional().describe('Target tab id; omit for active tab'),
}, async ({ tabId }) => bridge.send('attachDebugger', { tabId }));

tool('chrome_detach_debugger', 'Detach debugger from a tab.', {
  tabId: z.number().optional(),
}, async ({ tabId }) => bridge.send('detachDebugger', { tabId }));

tool('chrome_navigate', 'Navigate a tab to a URL.', {
  url: z.string().describe('URL to open'),
  tabId: z.number().optional(),
}, async ({ url, tabId }) => bridge.send('navigate', { url, tabId }));

tool('chrome_reload', 'Reload a tab.', {
  tabId: z.number().optional(),
  ignoreCache: z.boolean().optional(),
}, async ({ tabId, ignoreCache }) => bridge.send('reload', { tabId, ignoreCache }));

tool('chrome_evaluate_js', 'Evaluate JavaScript in the page context of a tab (Runtime.evaluate).', {
  expression: z.string(),
  tabId: z.number().optional(),
  awaitPromise: z.boolean().optional(),
  returnByValue: z.boolean().optional(),
}, async ({ expression, tabId, awaitPromise, returnByValue }) => bridge.send('evaluate', { expression, tabId, awaitPromise, returnByValue }));

tool('chrome_query_dom', 'Query DOM nodes via CSS selector (returns outerHTML list).', {
  selector: z.string(),
  tabId: z.number().optional(),
}, async ({ selector, tabId }) => bridge.send('queryDom', { selector, tabId }));

tool('chrome_click', 'Click an element matching a CSS selector.', {
  selector: z.string(),
  tabId: z.number().optional(),
}, async ({ selector, tabId }) => bridge.send('click', { selector, tabId }));

tool('chrome_type', 'Type text into an element matching a CSS selector.', {
  selector: z.string(),
  text: z.string(),
  tabId: z.number().optional(),
}, async ({ selector, text, tabId }) => bridge.send('typeText', { selector, text, tabId }));

tool('chrome_get_network_requests', 'Get buffered network requests/responses for a tab. Attach debugger first.', {
  tabId: z.number().optional(),
  urlFilter: z.string().optional(),
  limit: z.number().optional(),
}, async ({ tabId, urlFilter, limit }) => bridge.send('getNetwork', { tabId, urlFilter, limit }));

tool('chrome_get_console', 'Get buffered console messages for a tab.', {
  tabId: z.number().optional(),
  limit: z.number().optional(),
}, async ({ tabId, limit }) => bridge.send('getConsole', { tabId, limit }));

tool('chrome_screenshot', 'Capture a screenshot of a tab viewport.', {
  tabId: z.number().optional(),
  fullPage: z.boolean().optional(),
}, async ({ tabId, fullPage }) => bridge.send('screenshot', { tabId, fullPage }, 60000));

tool('chrome_cdp_send', 'Send an arbitrary Chrome DevTools Protocol command to a tab (unrestricted DevTools access).', {
  method: z.string().describe('CDP method, e.g. Network.getResponseBody, Storage.getCookies'),
  params: z.any().optional(),
  tabId: z.number().optional(),
}, async ({ method, params, tabId }) => bridge.send('cdpSend', { method, params: params || {}, tabId }));

tool('chrome_get_cookies', 'Get cookies for current tab/URL.', {
  urls: z.array(z.string()).optional(),
  name: z.string().optional(),
}, async ({ urls, name }) => bridge.send('getCookies', { urls, name }));

tool('chrome_set_cookie', 'Set a cookie.', {
  name: z.string(),
  value: z.string(),
  url: z.string().optional(),
  domain: z.string().optional(),
  path: z.string().optional(),
  secure: z.boolean().optional(),
  httpOnly: z.boolean().optional(),
  expirationDate: z.number().optional(),
}, async (args) => bridge.send('setCookie', args));

tool('chrome_storage_get', 'Read chrome.storage.local for the extension or window.localStorage of a page.', {
  area: z.enum(['local', 'page']).default('page'),
  key: z.string().optional(),
  tabId: z.number().optional(),
}, async (args) => bridge.send('storageGet', args));

tool('chrome_get_performance', 'Get basic performance timing metrics of a tab.', {
  tabId: z.number().optional(),
}, async ({ tabId }) => bridge.send('getPerformance', { tabId }));

tool('chrome_list_frames', 'List frames in a tab.', {
  tabId: z.number().optional(),
}, async ({ tabId }) => bridge.send('listFrames', { tabId }));

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[mcp-chrome] MCP server running. WS bridge on ws://127.0.0.1:${bridge.port}. Token stored at ${TOKEN_FILE}\n`);
}
main().catch((e) => { console.error(e); process.exit(1); });
