# Auxilia MCP Apps Context — For Chart MCP Server Planning

Since this mcp server will be mainly used in Auxilia, it is a good thing you know how Auxilia works.

## How MCP Apps Work in Auxilia (End-to-End)

### 1. Tool Discovery & UI Metadata

When an agent initializes (`agents/runtime.py`), it connects to all bound MCP servers via
`MultiServerMCPClient` (langchain-mcp-adapters) using **streamable HTTP** transport.

For each tool, `_extract_mcp_app_resource_uri()` looks for a UI resource URI in the tool's metadata:
- `tool.metadata._meta.ui.resourceUri` OR
- `tool.metadata._meta["io.modelcontextprotocol/ui"].resourceUri`

If found, the tool is considered an **MCP App tool**. A mapping is built:
`{sanitized_tool_name: {mcp_app_resource_uri: "...", mcp_server_id: "..."}}`.

### 2. Tool Execution & Artifact Injection

Tools use `response_format="content_and_artifact"` (from langchain-mcp-adapters), returning
a `(content, artifact)` tuple. `inject_ui_metadata_into_tool()` (`mcp/client/tools.py`) wraps
the coroutine to inject `mcp_app_resource_uri` and `mcp_server_id` into the artifact dict
**before** LangChain assembles the `ToolMessage`. This metadata persists in LangGraph checkpoints,
enabling widget re-render on page refresh.

### 3. Streaming to Frontend

`AISDKStreamAdapter` (`adapters/stream/`) converts LangGraph events to **AI SDK v5 SSE**.
On `tool-input-start` / `tool-input-available` events, it injects `providerMetadata`:
```json
{"auxilia": {"mcpAppResourceUri": "...", "mcpServerId": "..."}}
```
For thread history reconstruction, `message_adapter.py` extracts the same metadata from
`ToolMessage.artifact` and places it in `callProviderMetadata`.

### 4. Frontend Rendering

In the chat page (`agents/[id]/chat/[threadId]/page.tsx`), each tool part is checked via
`getMcpAppToolInfo()`. If metadata exists, `McpAppWidget` renders **below** the collapsible
tool input/output block.

`McpAppWidget` (`chat/components/mcp-app-widget.tsx`) uses `@mcp-ui/client`'s `AppRenderer`:
- **`toolResourceUri`**: the resource URI from metadata
- **`toolInput`**: the tool call arguments (as `Record<string, unknown>`)
- **`toolResult`**: `CallToolResult` built from `toolPart.output` / `toolPart.errorText`
- **`sandbox`**: points to `/sandbox.html` (double-iframe isolation with `allow-scripts allow-same-origin allow-forms`)
- **`hostContext`**: Auxilia theme mapped to MCP UI style variables via `useMcpHostContext()`
- **`onReadResource`** / **`onCallTool`**: proxy callbacks hitting the backend

### 5. Backend App Proxy Endpoints

`mcp/apps/router.py` exposes two stateless endpoints (fresh MCP session per request):
- `POST /mcp-servers/{server_id}/app/read-resource` — reads a resource URI from the MCP server
- `POST /mcp-servers/{server_id}/app/call-tool` — calls a tool on the MCP server

Both require auth (`get_current_user`) and resolve the server from DB.

### 6. Theme Integration

`useMcpHostContext()` (`hooks/use-mcp-host-context.ts`) maps Auxilia's Tailwind CSS variables
to the `McpUiStyles` spec (background, text, border, ring colors + border-radius). It detects
dark/light mode via MutationObserver on `<html class>`. The chart MCP server should use these
CSS variables from `hostContext.styles.variables` for consistent theming.

---

## Key Constraints for the Chart MCP Server

### Rendering Environment
- MCP App UI runs inside a **sandboxed iframe** (`allow-scripts allow-same-origin allow-forms`).
- The HTML is loaded via `srcdoc` on the inner iframe — no external URL navigation.
- The iframe has `width: 100%` and adapts to the chat column width. There is CSS forcing
  `[&_iframe]:w-full! [&_iframe]:max-w-full!` on the widget container.
- No fixed height is set by Auxilia — the iframe auto-sizes based on content.

### Data Flow
- The LLM calls the chart tool with structured arguments (chart type, data, labels, config).
- The tool returns `(content, artifact)` — content is a text summary, artifact holds metadata.
- `AppRenderer` receives `toolInput` (the arguments) and `toolResult` (the output).
- The MCP server's `read-resource` endpoint serves the HTML/JS that renders the chart.
- The HTML receives `toolInput` and `toolResult` via postMessage from the `AppRenderer`.

### What the MCP Server Must Expose
1. **Tools**: one or more tools the LLM calls (e.g., `render_chart`). Each tool must declare
   `_meta.ui.resourceUri` pointing to the app resource.
2. **Resources**: a resource at the declared URI that returns the HTML/JS for the chart renderer.
3. **(Optional) Additional tools**: callable from within the iframe via `onCallTool` for
   interactivity (e.g., drill-down, filter, export).

### Input/Output Contract
- `toolInput`: the LLM-generated arguments — chart type, datasets, labels, options.
- `toolResult.content[0].text`: stringified output from the tool (summary or raw data).
- The chart HTML receives both and must parse them to render.

### Theming
- `hostContext.styles.variables` provides CSS variables matching Auxilia's current theme.
- The chart library should consume these variables for colors, borders, and radii.
- Dark/light mode is communicated via `hostContext.theme` ("light" | "dark").

### Chat UI Fit
- Charts render inline in the chat, below the tool call accordion.
- Width is constrained to the chat message column (~700-800px typical).
- Height is content-driven — the chart HTML controls its own height.
- Multiple chart tool calls in one response each get their own widget.

---

## File Reference

| Area | Path |
|------|------|
| Tool metadata extraction | `backend/app/agents/runtime.py` (`_extract_mcp_app_resource_uri`, `_build_tool_ui_metadata_map`) |
| Artifact injection | `backend/app/mcp/client/tools.py` (`inject_ui_metadata_into_tool`) |
| Stream adapter | `backend/app/adapters/stream/adapter.py`, `handlers.py` |
| Message serialization | `backend/app/adapters/message_adapter.py` |
| App proxy endpoints | `backend/app/mcp/apps/router.py` |
| MCP server connection | `backend/app/mcp/utils.py` (`connect_to_server`) |
| Frontend widget | `web/src/app/(protected)/agents/[id]/chat/components/mcp-app-widget.tsx` |
| Theme hook | `web/src/hooks/use-mcp-host-context.ts` |
| Sandbox HTML | `web/public/sandbox.html` |
| Chat page (tool rendering) | `web/src/app/(protected)/agents/[id]/chat/[threadId]/page.tsx` |
| MCP UI client lib | `@mcp-ui/client` (AppRenderer) |
| MCP UI types | `@modelcontextprotocol/ext-apps` (McpUiHostContext, McpUiStyles) |
