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

tool('chrome_get_extension_errors', 'Read runtime errors logged by the extension service worker (its own console.error/unhandled exceptions).', {}, async () => bridge.send('getExtensionErrors'));

tool('chrome_list_frames', 'List frames in a tab.', {
  tabId: z.number().optional(),
}, async ({ tabId }) => bridge.send('listFrames', { tabId }));

// Enhanced interaction/navigation helpers
tool('chrome_create_tab', 'Create a new Chrome tab (optionally wait for load).', {
  url: z.string().optional(),
  active: z.boolean().optional(),
  waitForLoad: z.boolean().optional(),
  timeout: z.number().optional(),
  tabId: z.number().optional(),
}, async (args) => bridge.send('createTab', args));

tool('chrome_close_tab', 'Close a tab.', { tabId: z.number().optional() }, async ({ tabId }) => bridge.send('closeTab', { tabId }));

tool('chrome_focus_tab', 'Focus/activate a tab.', { tabId: z.number().optional() }, async ({ tabId }) => bridge.send('focusTab', { tabId }));

tool('chrome_wait_for_load', 'Wait until a tab finishes loading.', {
  tabId: z.number().optional(),
  timeout: z.number().optional(),
}, async ({ tabId, timeout }) => bridge.send('waitForLoad', { tabId, timeout }));

tool('chrome_wait_for_selector', 'Wait until a CSS selector appears in a tab.', {
  selector: z.string(),
  tabId: z.number().optional(),
  timeout: z.number().optional(),
  interval: z.number().optional(),
}, async ({ selector, tabId, timeout, interval }) => bridge.send('waitForSelector', { selector, tabId, timeout, interval }));

tool('chrome_hover', 'Hover an element matching a CSS selector.', {
  selector: z.string(),
  tabId: z.number().optional(),
}, async ({ selector, tabId }) => bridge.send('hover', { selector, tabId }));

tool('chrome_scroll', 'Scroll window or bring an element into view.', {
  selector: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  behavior: z.string().optional(),
  tabId: z.number().optional(),
}, async (args) => bridge.send('scroll', args));

tool('chrome_press_key', 'Press a keyboard key (optionally focusing selector first).', {
  key: z.string(),
  code: z.string().optional(),
  selector: z.string().optional(),
  tabId: z.number().optional(),
}, async (args) => bridge.send('pressKey', args));

// Navigation/history
tool('chrome_go_back', 'Navigate back in tab history.', { tabId: z.number().optional() }, async ({ tabId }) => bridge.send('goBack', { tabId }));
tool('chrome_go_forward', 'Navigate forward in tab history.', { tabId: z.number().optional() }, async ({ tabId }) => bridge.send('goForward', { tabId }));

// Advanced interaction
tool('chrome_drag_and_drop', 'Drag an element onto another element.', { sourceSelector: z.string(), targetSelector: z.string(), tabId: z.number().optional() }, async (args) => bridge.send('dragAndDrop', args));
tool('chrome_select_option', 'Select an option in a <select>.', { selector: z.string(), value: z.string().optional(), text: z.string().optional(), tabId: z.number().optional() }, async (args) => bridge.send('selectOption', args));
tool('chrome_upload_file', 'Set files on a file input (paths on the machine running Chrome).', { selector: z.string(), files: z.array(z.string()), tabId: z.number().optional() }, async (args) => bridge.send('uploadFile', args));

// Emulation
tool('chrome_emulate_device', 'Emulate device metrics/UA.', { width: z.number().optional(), height: z.number().optional(), deviceScaleFactor: z.number().optional(), mobile: z.boolean().optional(), userAgent: z.string().optional(), tabId: z.number().optional(), reset: z.boolean().optional() }, async (args) => bridge.send('emulateDevice', args));
tool('chrome_set_geolocation', 'Override geolocation.', { latitude: z.number(), longitude: z.number(), accuracy: z.number().optional(), tabId: z.number().optional() }, async (args) => bridge.send('setGeolocation', args));
tool('chrome_set_color_scheme', 'Emulate preferred color scheme.', { scheme: z.enum(['dark','light','no-preference']).optional(), tabId: z.number().optional() }, async (args) => bridge.send('setColorScheme', args));

// Network helpers
tool('chrome_block_urls', 'Block requests by URL patterns.', { urls: z.array(z.string()), tabId: z.number().optional() }, async (args) => bridge.send('blockUrls', args));

// Capture / export
tool('chrome_full_page_screenshot', 'Capture a full-page screenshot (beyond viewport).', { format: z.enum(['png','jpeg']).optional(), tabId: z.number().optional() }, async (args) => bridge.send('fullPageScreenshot', args));
tool('chrome_screenshot_element', 'Capture screenshot of a specific element.', { selector: z.string(), format: z.enum(['png','jpeg']).optional(), tabId: z.number().optional() }, async (args) => bridge.send('screenshotElement', args));
tool('chrome_print_to_pdf', 'Print tab to PDF.', { landscape: z.boolean().optional(), printBackground: z.boolean().optional(), scale: z.number().optional(), tabId: z.number().optional() }, async (args) => bridge.send('printToPdf', args));

// DOM helpers
tool('chrome_get_element_info', 'Get tag, text, attributes and bounding box for a selector.', { selector: z.string(), tabId: z.number().optional() }, async (args) => bridge.send('getElementInfo', args));

// Tab/window management
tool('chrome_move_tab', 'Move a tab to a new position.', { tabId: z.number(), index: z.number().optional(), position: z.number().optional() }, async (args) => bridge.send('moveTab', args));
tool('chrome_pin_tab', 'Pin/unpin a tab.', { tabId: z.number().optional(), pinned: z.boolean().optional() }, async (args) => bridge.send('pinTab', args));
tool('chrome_mute_tab', 'Mute/unmute a tab.', { tabId: z.number().optional(), muted: z.boolean().optional() }, async (args) => bridge.send('muteTab', args));
tool('chrome_duplicate_tab', 'Duplicate a tab.', { tabId: z.number().optional() }, async (args) => bridge.send('duplicateTab', args));
tool('chrome_list_windows', 'List browser windows and their tabs.', {}, async () => bridge.send('listWindows', {}));
tool('chrome_close_tabs_matching', 'Close tabs matching URL/title filters.', { urlContains: z.string().optional(), titleContains: z.string().optional() }, async (args) => bridge.send('closeTabsMatching', args));

// Frames
tool('chrome_evaluate_in_frame', 'Evaluate JS in a specific frame.', { frameId: z.number().optional(), urlContains: z.string().optional(), expression: z.string(), tabId: z.number().optional() }, async (args) => bridge.send('evaluateInFrame', args));
tool('chrome_query_dom_in_frame', 'Query DOM in a specific frame.', { selector: z.string(), frameId: z.number().optional(), urlContains: z.string().optional(), tabId: z.number().optional() }, async (args) => bridge.send('queryDomInFrame', args));

// Network interception / manipulation
tool('chrome_enable_request_interception', 'Enable Fetch.requestPaused interception.', { patterns: z.any().optional(), tabId: z.number().optional() }, async (args) => bridge.send('enableRequestInterception', args));
tool('chrome_disable_request_interception', 'Disable request interception.', { tabId: z.number().optional() }, async (args) => bridge.send('disableRequestInterception', args));
tool('chrome_continue_request', 'Continue an intercepted request.', { requestId: z.string(), url: z.string().optional(), method: z.string().optional(), postData: z.string().optional(), headers: z.any().optional(), tabId: z.number().optional() }, async (args) => bridge.send('continueRequest', args));
tool('chrome_fulfill_request', 'Fulfill an intercepted request locally.', { requestId: z.string(), status: z.number().optional(), headers: z.any().optional(), body: z.string().optional(), tabId: z.number().optional() }, async (args) => bridge.send('fulfillRequest', args));
tool('chrome_fail_request', 'Fail an intercepted request.', { requestId: z.string(), reason: z.string().optional(), tabId: z.number().optional() }, async (args) => bridge.send('failRequest', args));
tool('chrome_set_extra_headers', 'Set extra HTTP headers.', { headers: z.any(), tabId: z.number().optional() }, async (args) => bridge.send('setExtraHeaders', args));
tool('chrome_set_offline_mode', 'Emulate offline/online network state.', { offline: z.boolean(), tabId: z.number().optional() }, async (args) => bridge.send('setOfflineMode', args));
tool('chrome_clear_browser_cache', 'Clear browser cache for a tab.', { tabId: z.number().optional() }, async (args) => bridge.send('clearBrowserCache', args));
tool('chrome_clear_browser_cookies_cdp', 'Clear browser cookies via CDP.', { tabId: z.number().optional() }, async (args) => bridge.send('clearBrowserCookiesCdp', args));
tool('chrome_clear_site_data', 'Clear storage for an origin.', { origin: z.string(), storageTypes: z.string().optional(), tabId: z.number().optional() }, async (args) => bridge.send('clearSiteData', args));

// Accessibility / performance
tool('chrome_accessibility_tree', 'Get full accessibility tree.', { tabId: z.number().optional() }, async (args) => bridge.send('accessibilityTree', args));
tool('chrome_performance_metrics', 'Get CDP performance metrics.', { tabId: z.number().optional() }, async (args) => bridge.send('performanceMetrics', args));

// Downloads
tool('chrome_download', 'Download a URL.', { url: z.string(), filename: z.string().optional(), saveAs: z.boolean().optional() }, async (args) => bridge.send('downloadFile', args));
tool('chrome_list_downloads', 'List downloads.', { query: z.string().optional(), state: z.string().optional(), limit: z.number().optional() }, async (args) => bridge.send('listDownloads', args));
tool('chrome_cancel_download', 'Cancel a download.', { id: z.number() }, async (args) => bridge.send('cancelDownload', args));

// Diagnostics
tool('chrome_get_page_errors', 'Get buffered console/page errors.', { tabId: z.number().optional(), limit: z.number().optional() }, async (args) => bridge.send('getPageErrors', args));

// Extended interaction
tool('chrome_type_human', 'Type text with per-character delay.', { text: z.string(), selector: z.string().optional(), delay: z.number().optional(), tabId: z.number().optional() }, async (args) => bridge.send('typeTextHuman', args));
tool('chrome_scroll_by', 'Scroll by pixel delta.', { x: z.number().optional(), y: z.number().optional(), smooth: z.boolean().optional(), tabId: z.number().optional() }, async (args) => bridge.send('scrollBy', args));
tool('chrome_submit_form', 'Submit a form.', { selector: z.string().optional(), tabId: z.number().optional() }, async (args) => bridge.send('submitForm', args));
tool('chrome_query_shadow', 'Query DOM inside a shadow root.', { selector: z.string(), rootSelector: z.string().optional(), tabId: z.number().optional() }, async (args) => bridge.send('queryShadow', args));

// Network advanced
tool('chrome_set_throttle', 'Emulate network conditions.', { offline: z.boolean().optional(), latency: z.number().optional(), downloadThroughput: z.number().optional(), uploadThroughput: z.number().optional(), tabId: z.number().optional() }, async (args) => bridge.send('setThrottle', args));
tool('chrome_set_cache_disabled', 'Enable/disable HTTP cache.', { disabled: z.boolean(), tabId: z.number().optional() }, async (args) => bridge.send('setCacheDisabled', args));
tool('chrome_get_response_body', 'Get response body by requestId.', { requestId: z.string(), tabId: z.number().optional() }, async (args) => bridge.send('getResponseBody', args));
tool('chrome_get_har', 'Get buffered network entries.', { tabId: z.number().optional() }, async (args) => bridge.send('getHAR', args));

// Storage (session) / site data
tool('chrome_session_storage_get', 'Read sessionStorage.', { key: z.string().optional(), tabId: z.number().optional() }, async (args) => bridge.send('sessionStorageGet', args));
tool('chrome_session_storage_set', 'Write sessionStorage.', { key: z.string(), value: z.string(), tabId: z.number().optional() }, async (args) => bridge.send('sessionStorageSet', args));
// Compact state / tabs
tool('chrome_state', 'Get compact page + tab state.', { tabId: z.number().optional() }, async (args) => bridge.send('chromeState', args));

// Frames
tool('chrome_list_frames_detailed', 'List frames in a tab.', { tabId: z.number().optional() }, async (args) => bridge.send('listFramesDetailed', args));

// Network interception

// Coverage / tracing / screencast
tool('chrome_enable_coverage', 'Start JS/CSS coverage.', { type: z.enum(['js','css']).optional(), tabId: z.number().optional() }, async (args) => bridge.send('enableCoverage', args));
tool('chrome_get_coverage', 'Get JS/CSS coverage.', { tabId: z.number().optional() }, async (args) => bridge.send('getCoverage', args));
tool('chrome_tracing_start', 'Start performance tracing.', { categories: z.string().optional(), tabId: z.number().optional() }, async (args) => bridge.send('tracingStart', args));
tool('chrome_tracing_stop', 'Stop tracing and return events.', { tabId: z.number().optional() }, async (args) => bridge.send('tracingStop', args));
tool('chrome_start_screencast', 'Start screencast (frames buffered).', { format: z.enum(['jpeg','png']).optional(), quality: z.number().optional(), maxWidth: z.number().optional(), maxHeight: z.number().optional(), tabId: z.number().optional() }, async (args) => bridge.send('startScreencast', args));
tool('chrome_stop_screencast', 'Stop screencast and return frames.', { tabId: z.number().optional() }, async (args) => bridge.send('stopScreencast', args));

// Debugger
tool('chrome_pause_debugger', 'Pause JS execution.', { tabId: z.number().optional() }, async (args) => bridge.send('pauseDebugger', args));
tool('chrome_resume_debugger', 'Resume JS execution.', { tabId: z.number().optional() }, async (args) => bridge.send('resumeDebugger', args));
tool('chrome_step_over', 'Step over.', { tabId: z.number().optional() }, async (args) => bridge.send('stepOver', args));

// Accessibility / performance / memory / permissions
tool('chrome_get_memory_usage', 'Get memory/perf metrics.', { tabId: z.number().optional() }, async (args) => bridge.send('getMemoryUsage', args));
tool('chrome_grant_permissions', 'Grant permissions for origin.', { origin: z.string(), permissions: z.array(z.string()), tabId: z.number().optional() }, async (args) => bridge.send('setPermissions', args));
tool('chrome_query_permissions', 'Query permission states.', { names: z.array(z.string()).optional(), tabId: z.number().optional() }, async (args) => bridge.send('queryPermissions', args));
tool('chrome_virtual_authenticator', 'Enable/disable virtual WebAuthn authenticator.', { enable: z.boolean(), add: z.boolean().optional(), options: z.any().optional(), tabId: z.number().optional() }, async (args) => bridge.send('virtualAuthenticator', args));

// Diagnostics/DOM internals
tool('chrome_get_document', 'Get DOM document tree.', { depth: z.number().optional(), pierce: z.boolean().optional(), tabId: z.number().optional() }, async (args) => bridge.send('getDocument', args));
tool('chrome_query_selector_node', 'Get node info for selector.', { selector: z.string(), tabId: z.number().optional() }, async (args) => bridge.send('querySelectorNode', args));
tool('chrome_wait_network_idle', 'Wait (approx) for network idle.', { timeout: z.number().optional(), tabId: z.number().optional() }, async (args) => bridge.send('waitNetworkIdle', args));

// Downloads

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[mcp-chrome] MCP server running. WS bridge on ws://127.0.0.1:${bridge.port}. Token stored at ${TOKEN_FILE}\n`);

  const shutdown = () => { try { bridge.stop(); } catch {} process.exit(0); };
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGHUP', shutdown);
}
main().catch((e) => { console.error(e); process.exit(1); });
