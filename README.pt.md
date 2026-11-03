# MCP Chrome Bridge (PT-BR)

[![Licença: MIT](https://img.shields.io/badge/Licença-MIT-yellow.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-chrome--bridge-blue)](#)

> Dê ao seu agente de IA (Claude Code, Copilot CLI, Cursor ou qualquer cliente MCP) **acesso real ao navegador** através do Chrome DevTools (CDP).  
> Navegue, inspecione o DOM, avalie JavaScript, leia **requisições e respostas HTTP**, console, cookies, storage e capture screenshots — sem abrir outro navegador.

---

## Por quê

A maioria das ferramentas “browser” para agentes limita-se a screenshots ou páginas isoladas. **MCP Chrome Bridge** anexa-se diretamente a uma aba real do Chrome via `chrome.debugger`, oferecendo **acesso irrestrito ao DevTools**:

- Rastrear **chamadas de API (XHR/fetch)**, status, headers e bodies.
- Depurar JavaScript na página viva (`Runtime.evaluate`).
- Inspecionar e alterar o DOM.
- Capturar **requisições/respostas HTTP** e métricas de performance.
- Trabalhar com cookies, storage, frames e screenshots.

Roda **localmente** (WebSocket em `127.0.0.1`) e é destinado a **desenvolvimento, depuração e testes autorizados** apenas.

---

## Arquitetura

```
Cliente de IA (Claude Code / Copilot CLI)  --stdio MCP-->  Ponte Node  --WebSocket-->  Extensão Chrome  --chrome.debugger/CDP-->  Aba do navegador
```

---

## Início rápido

### 1. Clone e instale o servidor MCP

```bash
git clone https://github.com/danilocarrenho/mcp-chrome-extension.git
cd mcp-chrome-extension/server
npm install
```

### 2. Execute a ponte (ou deixe o cliente MCP executar)

```bash
node src/index.js
# exibe: Token stored at ~/.mcp-chrome/token
```

A primeira execução gera um token aleatório em `~/.mcp-chrome/token`.

### 3. Carregue a extensão no Chrome

1. Abra `chrome://extensions` → ative **Modo desenvolvedor**.
2. **Carregar sem compactação** → selecione a pasta `extension/`.
3. Clique no ícone da extensão → preencha **host** (`127.0.0.1`), **porta** (`8765`) e **token**.
4. Clique em **Save & Connect**. O badge deve mostrar `ON`.

### 4. Registre no cliente MCP

**Claude Code** (escopo do projeto ou do usuário):

```bash
claude mcp add chrome -- node /caminho/absoluto/para/server/src/index.js
```

Ou em `.mcp.json` / `~/.claude.json`:

```json
{
  "mcpServers": {
    "chrome": {
      "command": "node",
      "args": ["/caminho/absoluto/para/server/src/index.js"],
      "env": { "MCP_CHROME_TOKEN": "seu-token-aqui" }
    }
  }
}
```

**Copilot CLI / outros clientes**: mesmo comando/args.

### `ollama launch claude`

Se você usa Claude via Ollama, certifique-se de que a configuração MCP está disponível para essa sessão. Caso as tools não apareçam ali, use o `claude` direto ou teste manualmente (veja “Testes”).

---

## Teste sem UI MCP (ponta a ponta)

Um smoke test mínimo basta para validar ponte + extensão:

```bash
cd server
MCP_CHROME_TOKEN="$(cat ~/.mcp-chrome/token)" node src/index.js   # em outro terminal
```

No agente: “rode `chrome_status`, liste abas, anexe o debugger na aba ativa, navegue para https://example.com e liste as requisições de rede”.

---

## Ferramentas disponíveis

| Ferramenta | Propósito |
|------------|-----------|
| `chrome_status` | Status da ponte + extensão |
| `chrome_list_tabs` | Abas abertas |
| `chrome_attach_debugger` / `chrome_detach_debugger` | Ativa/desativa domínios CDP |
| `chrome_navigate` / `chrome_reload` | Navegação |
| `chrome_evaluate_js` | `Runtime.evaluate` |
| `chrome_query_dom` / `chrome_click` / `chrome_type` | Interação DOM |
| `chrome_get_network_requests` | Requisições/respostas capturadas |
| `chrome_get_console` | Mensagens de console |
| `chrome_get_extension_errors` | Erros runtime do service worker |
| `chrome_screenshot` | Screenshot da viewport |
| `chrome_cdp_send` | **Qualquer comando CDP** |
| `chrome_get_cookies` / `chrome_set_cookie` | Cookies |
| `chrome_storage_get` | `chrome.storage`/`localStorage` |
| `chrome_get_performance` | Timing de navegação |
| `chrome_list_frames` | Frames da aba |

### Fluxo típico

1. `chrome_attach_debugger` (aba ativa por padrão)
2. `chrome_navigate` para o alvo
3. Aguarde o carregamento
4. `chrome_get_network_requests` — todas as chamadas
5. `chrome_cdp_send` com `Network.getResponseBody`
6. `chrome_evaluate_js` para dados dinâmicos
7. `chrome_screenshot` para confirmar visualmente

---

## Configuração (variáveis de ambiente)

- `MCP_CHROME_PORT` — porta WebSocket (padrão `8765`)
- `MCP_CHROME_TOKEN` — override do token de autenticação
- `MCP_CHROME_DISABLE_AUTH=1` — só dev, desliga o token (não use em produção)

---

## Segurança

- A ponte escuta somente em **127.0.0.1**.
- Cookies, tráfego de rede e dados da página ficam acessíveis após anexar o debugger.
- Use um **perfil dedicado** do Chrome para o agente.
- Ao anexar o debugger, o Chrome exibe o banner *“Chrome is being controlled by automated test software”*.
- Rote o token (delete/recrie o arquivo `~/.mcp-chrome/token`) antes de compartilhar a máquina.
- Em **produção**, defina um token forte em `MCP_CHROME_TOKEN`.

---

## Solução de problemas

- **Badge `ERR` / `connection refused`**  
  O servidor MCP não está rodando. Inicie o cliente (Claude Code/Copilot CLI) primeiro e então conecte.

- **`chrome_attach_debugger` falha em páginas `chrome://`**  
  O Chrome proíbe anexar debugger a páginas internas. Use uma URL `http(s)`.

- **“Another debugger is already attached”**  
  Desanexe primeiro ou troque de aba.

- **Tools não aparecem no cliente MCP**  
  Veja `claude mcp list`. Processos órfãos na porta 8765 podem bloquear — mate-os e reinicie.

- **Ruídos de auto-connect**  
  A extensão tenta reconectar quando o servidor está fora. Inicie o servidor antes de carregar a extensão.

---

## Apoie o projeto / Doações

Se esta ferramenta te economizou tempo, você pode apoiar o desenvolvimento:

[![PayPal](https://img.shields.io/badge/Doar-PayPal-00457C?style=for-the-badge&logo=paypal&logoColor=white)](https://www.paypal.com/cgi-bin/webscr?cmd=_donations&business=dancarf%40gmail.com&currency_code=USD&source=url)

➡️ Doação direta: https://www.paypal.com/cgi-bin/webscr?cmd=_donations&business=dancarf%40gmail.com&currency_code=USD&source=url

Outras formas de apoio:
- ⭐ Dar estrela no repo: https://github.com/danilocarrenho/mcp-chrome-extension
- 🐞 Abrir issues/feature requests no GitHub

---

## Contribuindo

Pull requests são bem-vindos. Diretrizes:
- Mantenha o servidor portável (CommonJS, sem build obrigatório).
- Mantenha a extensão compatível com MV3.
- Prefira mudanças pequenas e focadas, com testes quando fizer sentido.

---

## Avisos

- O projeto fornece **capacidades de automação irrestrita** via DevTools.
- Use apenas em sistemas/navegadores que você **possui e está autorizado a testar**.
- Você é responsável por cumprir ToS dos sistemas-alvo e leis aplicáveis.

---

## Licença

MIT — veja [LICENSE](LICENSE).

---

## 🇬🇧 English

For the English documentation, see [README.md](README.md).