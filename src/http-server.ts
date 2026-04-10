#!/usr/bin/env node

/**
 * HTTP Server Entry Point for Docker Deployment
 *
 * Provides Streamable HTTP transport for remote MCP clients.
 * Use src/index.ts for local stdio-based usage.
 *
 * Endpoints:
 *   GET  /health  — liveness probe
 *   POST /mcp     — MCP Streamable HTTP (session-aware)
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  searchDecisions,
  getDecision,
  searchGuidelines,
  getGuideline,
  listTopics,
  getDataFreshness,
} from "./db.js";
import { buildCitation } from "./utils/citation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const SERVER_NAME = "irish-data-protection-mcp";

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback
}

// --- Shared helpers ----------------------------------------------------------

function responseMeta() {
  return {
    disclaimer:
      "Data sourced from the Irish Data Protection Commission (DPC). This MCP provides access to publicly available regulatory decisions and guidance. Not legal advice. Always verify against official DPC publications at https://www.dataprotection.ie/.",
    data_age: "See check_data_freshness tool for current data age.",
    copyright: "Data Protection Commission Ireland. Reproduced for informational purposes.",
    source_url: "https://www.dataprotection.ie/",
  };
}

// --- Tool definitions (shared with index.ts) ---------------------------------

const TOOLS = [
  {
    name: "ie_dp_search_decisions",
    description:
      "Full-text search across DPC decisions, inquiries, and enforcement notices. The DPC is the lead supervisory authority under Article 56 for major tech companies.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (e.g., 'data transfers', 'children consent', 'Meta WhatsApp')" },
        type: {
          type: "string",
          enum: ["decision", "inquiry", "enforcement_notice", "binding_decision"],
          description: "Filter by decision type. Optional.",
        },
        topic: { type: "string", description: "Filter by topic ID. Optional." },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "ie_dp_get_decision",
    description: "Get a specific DPC decision by reference number (e.g., 'DPC-IN-18-2-1').",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: { type: "string", description: "DPC decision reference" },
      },
      required: ["reference"],
    },
  },
  {
    name: "ie_dp_search_guidelines",
    description: "Search DPC guidance documents: guides, codes of practice, and regulatory advice.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
        type: {
          type: "string",
          enum: ["guide", "code_of_practice", "regulatory_advice", "FAQ"],
          description: "Filter by guidance type. Optional.",
        },
        topic: { type: "string", description: "Filter by topic ID. Optional." },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "ie_dp_get_guideline",
    description: "Get a specific DPC guidance document by its database ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "Guideline database ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "ie_dp_list_topics",
    description: "List all covered data protection topics with English names.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "ie_dp_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "list_sources",
    description:
      "List all data sources used by this MCP server, including URLs, coverage dates, and licensing information.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "check_data_freshness",
    description:
      "Check when the data was last ingested, total record counts, and whether the corpus is up to date.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

// --- Zod schemas -------------------------------------------------------------

const SearchDecisionsArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["decision", "inquiry", "enforcement_notice", "binding_decision"]).optional(),
  topic: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetDecisionArgs = z.object({
  reference: z.string().min(1),
});

const SearchGuidelinesArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["guide", "code_of_practice", "regulatory_advice", "FAQ"]).optional(),
  topic: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetGuidelineArgs = z.object({
  id: z.number().int().positive(),
});

// --- MCP server factory ------------------------------------------------------

function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: pkgVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    function textContent(data: unknown) {
      const payload =
        typeof data === "object" && data !== null
          ? { ...(data as Record<string, unknown>), _meta: responseMeta() }
          : { data, _meta: responseMeta() };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
    }

    function errorContent(message: string, errorType = "tool_error") {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { error: message, _error_type: errorType, _meta: responseMeta() },
              null,
              2,
            ),
          },
        ],
        isError: true as const,
      };
    }

    try {
      switch (name) {
        case "ie_dp_search_decisions": {
          const parsed = SearchDecisionsArgs.parse(args);
          const results = searchDecisions({ query: parsed.query, type: parsed.type, topic: parsed.topic, limit: parsed.limit });
          const resultsWithCitations = (results as Record<string, unknown>[]).map((r) => ({
            ...r,
            _citation: buildCitation(
              String(r["reference"] ?? ""),
              String(r["title"] ?? r["reference"] ?? ""),
              "ie_dp_get_decision",
              { reference: String(r["reference"] ?? "") },
            ),
          }));
          return textContent({ results: resultsWithCitations, count: results.length });
        }
        case "ie_dp_get_decision": {
          const parsed = GetDecisionArgs.parse(args);
          const decision = getDecision(parsed.reference);
          if (!decision) return errorContent(`Decision not found: ${parsed.reference}`, "not_found");
          const dec = decision as Record<string, unknown>;
          return textContent({
            ...decision,
            _citation: buildCitation(
              String(dec["reference"] ?? parsed.reference),
              String(dec["title"] ?? dec["reference"] ?? parsed.reference),
              "ie_dp_get_decision",
              { reference: parsed.reference },
            ),
          });
        }
        case "ie_dp_search_guidelines": {
          const parsed = SearchGuidelinesArgs.parse(args);
          const results = searchGuidelines({ query: parsed.query, type: parsed.type, topic: parsed.topic, limit: parsed.limit });
          const resultsWithCitations = (results as Record<string, unknown>[]).map((r) => ({
            ...r,
            _citation: buildCitation(
              String(r["reference"] ?? r["id"] ?? ""),
              String(r["title"] ?? r["reference"] ?? ""),
              "ie_dp_get_guideline",
              { id: String(r["id"] ?? "") },
            ),
          }));
          return textContent({ results: resultsWithCitations, count: results.length });
        }
        case "ie_dp_get_guideline": {
          const parsed = GetGuidelineArgs.parse(args);
          const guideline = getGuideline(parsed.id);
          if (!guideline) return errorContent(`Guideline not found: id=${parsed.id}`, "not_found");
          const gl = guideline as Record<string, unknown>;
          return textContent({
            ...guideline,
            _citation: buildCitation(
              String(gl["reference"] ?? gl["id"] ?? parsed.id),
              String(gl["title"] ?? gl["reference"] ?? `Guideline ${parsed.id}`),
              "ie_dp_get_guideline",
              { id: String(parsed.id) },
            ),
          });
        }
        case "ie_dp_list_topics": {
          const topics = listTopics();
          return textContent({ topics, count: topics.length });
        }
        case "ie_dp_about": {
          return textContent({
            name: SERVER_NAME,
            version: pkgVersion,
            description: "DPC (Data Protection Commission) MCP server. Provides access to Irish data protection authority decisions, inquiries, and enforcement notices. Lead supervisory authority for GDPR under Article 56 for most major tech companies.",
            data_source: "DPC (https://www.dataprotection.ie/)",
            tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
          });
        }
        case "list_sources": {
          return textContent({
            sources: [
              {
                name: "DPC Decisions & Enforcement",
                url: "https://www.dataprotection.ie/en/dpc-guidance/decisions",
                description:
                  "Irish Data Protection Commission decisions, cross-border inquiries, binding decisions, and enforcement notices",
                coverage: "DPC decisions since establishment; GDPR decisions from May 2018",
                license: "Public sector information — reproduced for informational purposes",
                refresh_schedule: "Manual ingest on new DPC publication",
              },
              {
                name: "DPC Guidance Documents",
                url: "https://www.dataprotection.ie/en/dpc-guidance",
                description:
                  "DPC guidance: codes of practice, data protection guides, regulatory advice, and FAQs",
                coverage: "Active guidance documents published by the DPC",
                license: "Public sector information — reproduced for informational purposes",
                refresh_schedule: "Manual ingest on new DPC publication",
              },
            ],
            count: 2,
          });
        }
        case "check_data_freshness": {
          const freshness = getDataFreshness();
          const status =
            freshness.decisions_count === 0 && freshness.guidelines_count === 0
              ? "empty"
              : "populated";
          return textContent({
            status,
            decisions_count: freshness.decisions_count,
            guidelines_count: freshness.guidelines_count,
            topics_count: freshness.topics_count,
            latest_decision_date: freshness.latest_decision_date,
            latest_guideline_date: freshness.latest_guideline_date,
            source: "https://www.dataprotection.ie/",
            note: "Run the ingest workflow or `npm run ingest` to refresh the dataset.",
          });
        }
        default:
          return errorContent(`Unknown tool: ${name}`, "unknown_tool");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorContent(`Error executing ${name}: ${message}`);
    }
  });

  return server;
}

// --- HTTP server -------------------------------------------------------------

async function main(): Promise<void> {
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server }
  >();

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, sessions).catch((err) => {
      console.error(`[${SERVER_NAME}] Unhandled error:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  async function handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    activeSessions: Map<
      string,
      { transport: StreamableHTTPServerTransport; server: Server }
    >,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: pkgVersion }));
      return;
    }

    if (url.pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        return;
      }

      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type mismatch with exactOptionalPropertyTypes
      await mcpServer.connect(transport as any);

      transport.onclose = () => {
        if (transport.sessionId) {
          activeSessions.delete(transport.sessionId);
        }
        mcpServer.close().catch(() => {});
      };

      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        activeSessions.set(transport.sessionId, { transport, server: mcpServer });
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  httpServer.listen(PORT, () => {
    console.error(`${SERVER_NAME} v${pkgVersion} (HTTP) listening on port ${PORT}`);
    console.error(`MCP endpoint:  http://localhost:${PORT}/mcp`);
    console.error(`Health check:  http://localhost:${PORT}/health`);
  });

  process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down...");
    httpServer.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
