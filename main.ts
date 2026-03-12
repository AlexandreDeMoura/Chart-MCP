import { randomUUID } from "node:crypto";
import cors from "cors";
import express from "express";
import type { Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "./server.js";

type SessionEntry = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
};

const DEFAULT_HOST = process.env.HOST ?? "127.0.0.1";
const DEFAULT_PORT = Number(process.env.PORT ?? "3002");

function getSessionId(req: Request): string | undefined {
  const headerValue = req.header("mcp-session-id");
  return headerValue?.trim() || undefined;
}

function createErrorResponse(message: string) {
  return {
    jsonrpc: "2.0" as const,
    error: {
      code: -32000,
      message
    },
    id: null
  };
}

async function runStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Chart MCP server is running on stdio.");
}

async function runHttp(): Promise<void> {
  const app = createMcpExpressApp({ host: DEFAULT_HOST });
  const sessions = new Map<string, SessionEntry>();

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/", (_req, res) => {
    res.json({
      name: "chart-mcp",
      transport: "streamable-http",
      endpoint: "/mcp"
    });
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionId = getSessionId(req);

    try {
      if (sessionId && sessions.has(sessionId)) {
        await sessions.get(sessionId)!.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        const server = createServer();
        let activeSessionId: string | undefined;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            activeSessionId = sid;
            sessions.set(sid, { server, transport });
          }
        });

        transport.onclose = () => {
          if (activeSessionId) {
            sessions.delete(activeSessionId);
          }
          void server.close().catch((error) => {
            console.error("Error while closing session server:", error);
          });
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      res.status(400).json(createErrorResponse("Bad Request: invalid or missing MCP session."));
    } catch (error) {
      console.error("Error handling MCP POST request:", error);
      if (!res.headersSent) {
        res.status(500).json(createErrorResponse("Internal server error"));
      }
    }
  });

  app.get("/mcp", async (req: Request, res: Response) => {
    const sessionId = getSessionId(req);
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }

    try {
      await sessions.get(sessionId)!.transport.handleRequest(req, res);
    } catch (error) {
      console.error("Error handling MCP GET request:", error);
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  });

  app.delete("/mcp", async (req: Request, res: Response) => {
    const sessionId = getSessionId(req);
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }

    try {
      await sessions.get(sessionId)!.transport.handleRequest(req, res);
    } catch (error) {
      console.error("Error handling MCP DELETE request:", error);
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  });

  app.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
    console.log(`Chart MCP server listening on http://${DEFAULT_HOST}:${DEFAULT_PORT}/mcp`);
  });

  process.on("SIGINT", async () => {
    for (const [sessionId, entry] of sessions.entries()) {
      try {
        await entry.transport.close();
        await entry.server.close();
      } catch (error) {
        console.error(`Error closing session ${sessionId}:`, error);
      } finally {
        sessions.delete(sessionId);
      }
    }
    process.exit(0);
  });
}

async function main(): Promise<void> {
  if (process.argv.includes("--stdio")) {
    await runStdio();
    return;
  }
  await runHttp();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
