# MCP Chrome Bridge

Chrome extension + MCP server that lets an AI agent (Claude Code, Copilot CLI, any MCP client) drive the browser: navigate, run JS, inspect DOM, read network requests/responses, console, cookies, take screenshots, and send arbitrary Chrome DevTools Protocol commands.

## Architecture

```
AI client (Claude Code/Copilot)  --stdio MCP-->  Node MCP server  --WebSocket-->  Chrome extension (service worker)  --chrome.debugger/CDP-->  Browser
```

## 1. Install MCP server dependencies

```bash
cd server
npm install
node src/index.js   # prints "Token stored at ~/.mcp-chrome/token"
```

Copy the token from `~/.mcp-chrome/token` (or set `MCP_CHROME_TOKEN` env).

## 2. Load the Chrome extension

1. Open `chrome://extensions`, enable "Developer mode".
2. "Load unpacked" -> select the `extension/` folder.
3. Click the extension icon, set Host/Port/Token, "Save & Connect". Badge should show `ON`.

## 3. Register MCP server in your client

Claude Code:
```bash
claude mcp add chrome -- node /absolute/path/to/server/src/index.js
```

Or in `~/.claude.json` / settings:
```json
{
  "mcpServers": {
    "chrome": { "command": "node", "args": ["/abs/path/server/src/index.js"] }
  }
}
```

Copilot CLI: add to your MCP config with the same command.

## Tools (MCP)

- `chrome_status`, `chrome_list_tabs`
- `chrome_attach_debugger` / `chrome_detach_debugger` (enables CDP domains)
- `chrome_navigate`, `chrome_reload`
- `chrome_evaluate_js`, `chrome_query_dom`, `chrome_click`, `chrome_type`
- `chrome_get_network_requests` (requests + responses buffered)
- `chrome_get_console`
- `chrome_screenshot`
- `chrome_cdp_send` (arbitrary CDP command, unrestricted DevTools)
- `chrome_get_cookies` / `chrome_set_cookie`
- `chrome_storage_get`, `chrome_get_performance`, `chrome_list_frames`

## Usage examples

- "Attach debugger to current tab and list all XHR/fetch calls with status codes."
- "Navigate to https://example.com, attach, and dump Network requests to api.example.com."
- "Evaluate `document.title` and click `button#submit`."
- "Send CDP command `Network.getResponseBody` for requestId X."
- "Take a screenshot of the page."

## Configuration env vars

- `MCP_CHROME_PORT` (default 8765)
- `MCP_CHROME_TOKEN` (override token)
- `MCP_CHROME_DISABLE_AUTH=1` (dev only, disables token check)

## Security note

Unrestricted DevTools access can read all page data, network traffic and cookies. Only enable on browsers/profiles you control; use a dedicated Chrome profile for agent work. The bridge binds to 127.0.0.1 only.

## Development

Server is plain CommonJS JS; extension is MV3. Edit and reload extension via chrome://extensions -> refresh.

