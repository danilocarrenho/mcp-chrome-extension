# MCP Chrome Bridge

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-chrome--bridge-blue)](#)

**Languages:** 🇬🇧 English (this file) | 🇧🇷 [Português](README.pt.md)

> Give your AI agent (Claude Code, Copilot CLI, Cursor, or any MCP client) **real browser access** through Chrome DevTools (CDP).  
> Navigate, inspect the DOM, evaluate JavaScript, read **network requests & responses**, console, cookies, storage, and capture screenshots — all without a separate browser.

---

## Why

Most “browser” tools for agents are limited to screenshots or isolated pages. **MCP Chrome Bridge** attaches directly to a real Chrome tab using `chrome.debugger`, giving you **unrestricted DevTools access**:

- Trace **API calls (XHR/fetch)**, status codes, headers and bodies.
- Debug JavaScript in the live page (`Runtime.evaluate`).
- Inspect & mutate the DOM.
- Capture **HTTP requests/responses** and performance timings.
- Work with cookies, storage, frames and screenshots.

It runs **locally** (WebSocket on `127.0.0.1`) and is meant for **development, debugging and authorized testing only**.

---

## Architecture

```
AI client (Claude Code / Copilot CLI)  --stdio MCP-->  Node bridge  --WebSocket-->  Chrome extension  --chrome.debugger/CDP-->  Browser tab
```

---

## Quick start

### 1. Clone & install MCP server

```bash
git clone https://github.com/danilocarrenho/mcp-chrome-extension.git
cd mcp-chrome-extension/server
npm install
```

### 2. Run the bridge (or let your MCP client run it)

```bash
node src/index.js
# prints: Token stored at ~/.mcp-chrome/token
```

The first run generates a random token in `~/.mcp-chrome/token`.

### 3. Load the extension in Chrome

1. Open `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select the `extension/` folder.
3. Click the extension icon → paste **host** (`127.0.0.1`), **port** (`8765`) and **token** (from step 2).
4. Click **Save & Connect**. The badge should show `ON`.

### 4. Register in your MCP client

**Claude Code** (project or user scope):

```bash
claude mcp add chrome -- node /absolute/path/to/server/src/index.js
```

Or put in `.mcp.json` / `~/.claude.json`:

```json
{
  "mcpServers": {
    "chrome": {
      "command": "node",
      "args": ["/absolute/path/to/server/src/index.js"],
      "env": { "MCP_CHROME_TOKEN": "your-token-here" }
    }
  }
}
```

**Copilot CLI / other clients**: same command/args.

### `ollama launch claude`

If you run Claude through Ollama (`ollama launch claude`), make sure your **MCP config is available** to that session. In case tools are not exposed there, you can also use the official `claude` CLI directly or test manually (see “Testing” below).

---

## Testing without an MCP UI (end-to-end)

A small JSON-RPC smoke test is enough to validate the bridge + extension:

```bash
cd server
MCP_CHROME_TOKEN="$(cat ~/.mcp-chrome/token)" node src/index.js   # in another terminal
```

Then, in a Node script, send over stdio:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"chrome_status","arguments":{}}}
```

Or simply ask your agent: _“run chrome_status, list tabs, attach debugger to the active tab, navigate to https://example.com and list network requests.”_

---

## Available tools

| Tool | Purpose |
|------|---------|
| `chrome_status` | Bridge + extension connection status |
| `chrome_list_tabs` | List open tabs |
| `chrome_attach_debugger` / `chrome_detach_debugger` | Enable/disable CDP domains (Network, Runtime, Console, Page, DOM) |
| `chrome_navigate` / `chrome_reload` | Page navigation |
| `chrome_evaluate_js` | `Runtime.evaluate` |
| `chrome_query_dom` / `chrome_click` / `chrome_type` | DOM interaction |
| `chrome_get_network_requests` | Buffered requests/responses (attach debugger first) |
| `chrome_get_console` | Console messages |
| `chrome_get_extension_errors` | Runtime errors captured by the extension service worker |
| `chrome_screenshot` | Visible viewport screenshot |
| `chrome_cdp_send` | **Any CDP command** (unrestricted DevTools) |
| `chrome_get_cookies` / `chrome_set_cookie` | Cookies |
| `chrome_storage_get` | `chrome.storage` or `localStorage` |
| `chrome_get_performance` | Navigation timing |
| `chrome_list_frames` | Frames in a tab |

### Typical workflow

1. `chrome_attach_debugger` (defaults to active tab)
2. `chrome_navigate` to target (or reload)
3. Let the page load for a couple of seconds
4. `chrome_get_network_requests` — all recorded calls
5. `chrome_cdp_send` with `Network.getResponseBody` for body inspection
6. `chrome_evaluate_js` for dynamic data
7. `chrome_screenshot` for visual confirmation

---

## Configuration (environment variables)

- `MCP_CHROME_PORT` — WebSocket port (default `8765`)
- `MCP_CHROME_TOKEN` — override the auth token
- `MCP_CHROME_DISABLE_AUTH=1` — dev only, disables token check (do **not** use in production)

---

## Security notes

- The bridge binds to **127.0.0.1 only**.
- Cookies, network traffic and page data are accessible once the debugger is attached.
- Use a **dedicated Chrome profile** for agent work.
- When a debugger is attached, Chrome shows the banner *“Chrome is being controlled by automated test software”* and a debugging indicator in the tab.
- Rotate the token (delete/recreate `~/.mcp-chrome/token`) before sharing a machine.
- For **production** systems always set a strong `MCP_CHROME_TOKEN` instead of the dev defaults.

---

## Troubleshooting

- **Badge shows `ERR` / `connection refused`**  
  The MCP server is not running. Start the client (Claude Code/Copilot CLI) first, then click **Connect** in the extension popup.

- **`chrome_attach_debugger` fails on `chrome://` pages**  
  Chrome forbids debugger attachments to internal pages. Use a normal `http(s)` URL.

- **“Another debugger is already attached”**  
  Detach first (`chrome_detach_debugger`) or switch to another tab.

- **Tools not available in your MCP client**  
  Check `claude mcp list` / client MCP panel. Orphans on port 8765 can block new servers: kill lingering `node` processes and restart.

- **Auto-connect noise in DevTools**  
  The extension retries connection when the server is down. Start the server before loading the extension to avoid `ERR_CONNECTION_REFUSED`.

---

## Support / Donate

If this tool saved you time, you can support the development:

[![PayPal](https://img.shields.io/badge/Donate-PayPal-00457C?style=for-the-badge&logo=paypal&logoColor=white)](https://www.paypal.com/cgi-bin/webscr?cmd=_donations&business=dancarf%40gmail.com&currency_code=USD&source=url)

➡️ Direct donation: https://www.paypal.com/cgi-bin/webscr?cmd=_donations&business=dancarf%40gmail.com&currency_code=USD&source=url

Other ways to support:
- ⭐ Star the repo: https://github.com/danilocarrenho/mcp-chrome-extension
- 🐞 Report issues / feature requests on GitHub Issues

---

## Contributing

Pull requests are welcome. Guidelines:
- Keep server code portable (CommonJS, no build step required).
- Keep extension MV3-compatible.
- Prefer small, focused changes with tests where sensible.

---

## Disclaimers

- This project provides **unrestricted browser-automation capabilities** via DevTools.
- Use it only on systems/browsers you **own and are authorized to test**.
- You are responsible for compliance with target systems’ ToS and applicable laws.

---

## License

MIT — see [LICENSE](LICENSE).