#!/usr/bin/env node

/**
 * Irish Data Protection MCP — stdio entry point.
 *
 * Provides MCP tools for querying DPC decisions, sanctions, and
 * data protection guidance documents.
 *
 * Tool prefix: ie_dp_
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback to default
}

const SERVER_NAME = "irish-data-protection-mcp";

// --- Tool definitions ---------------------------------------------------------

const TOOLS = [
  {
    name: "ie_dp_search_decisions",
    description:
      "Full-text search across DPC (Data Protection Commission) decisions, inquiries, and enforcement notices. The DPC is the lead supervisory authority for GDPR under Article 56 for most major tech companies (Meta, Google, Apple, Twitter/X, TikTok). Returns matching decisions with reference, entity name, fine amount, and GDPR articles cited.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., 'data transfers', 'children consent', 'Meta WhatsApp', 'Twitter breach')",
        },
        type: {
          type: "string",
          enum: ["decision", "inquiry", "enforcement_notice", "binding_decision"],
          description: "Filter by decision type. Optional.",
        },
        topic: {
          type: "string",
          description: "Filter by topic ID (e.g., 'transfers', 'children', 'big_tech'). Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "ie_dp_get_decision",
    description:
      "Get a specific DPC decision by reference number (e.g., 'DPC-IN-18-2-1', 'DPC-D-21-001').",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: {
          type: "string",
          description: "DPC decision reference (e.g., 'DPC-IN-18-2-1')",
        },
      },
      required: ["reference"],
    },
  },
  {
    name: "ie_dp_search_guidelines",
    description:
      "Search DPC guidance documents: guides, codes of practice, and regulatory advice. Covers data transfers post-Schrems II, children's data, DPIA requirements, consent, breach notification, and more.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., 'standard contractual clauses', 'children online', 'data breach')",
        },
        type: {
          type: "string",
          enum: ["guide", "code_of_practice", "regulatory_advice", "FAQ"],
          description: "Filter by guidance type. Optional.",
        },
        topic: {
          type: "string",
          description: "Filter by topic ID (e.g., 'transfers', 'children', 'consent'). Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "ie_dp_get_guideline",
    description:
      "Get a specific DPC guidance document by its database ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number",
          description: "Guideline database ID (from ie_dp_search_guidelines results)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "ie_dp_list_topics",
    description:
      "List all covered data protection topics with English names. Use topic IDs to filter decisions and guidelines.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "ie_dp_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "list_sources",
    description:
      "List all data sources used by this MCP server, including URLs, coverage dates, and licensing information.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "check_data_freshness",
    description:
      "Check when the data was last ingested, total record counts, and whether the corpus is up to date.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// --- Zod schemas for argument validation --------------------------------------

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

// --- Helpers ------------------------------------------------------------------

function responseMeta() {
  return {
    disclaimer:
      "Data sourced from the Irish Data Protection Commission (DPC). This MCP provides access to publicly available regulatory decisions and guidance. Not legal advice. Always verify against official DPC publications at https://www.dataprotection.ie/.",
    data_age: "See check_data_freshness tool for current data age.",
    copyright: "Data Protection Commission Ireland. Reproduced for informational purposes.",
    source_url: "https://www.dataprotection.ie/",
  };
}

function textContent(data: unknown) {
  const payload =
    typeof data === "object" && data !== null
      ? { ...(data as Record<string, unknown>), _meta: responseMeta() }
      : { data, _meta: responseMeta() };
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
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

// --- Server setup ------------------------------------------------------------

const server = new Server(
  { name: SERVER_NAME, version: pkgVersion },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case "ie_dp_search_decisions": {
        const parsed = SearchDecisionsArgs.parse(args);
        const results = searchDecisions({
          query: parsed.query,
          type: parsed.type,
          topic: parsed.topic,
          limit: parsed.limit,
        });
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
        if (!decision) {
          return errorContent(`Decision not found: ${parsed.reference}`, "not_found");
        }
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
        const results = searchGuidelines({
          query: parsed.query,
          type: parsed.type,
          topic: parsed.topic,
          limit: parsed.limit,
        });
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
        if (!guideline) {
          return errorContent(`Guideline not found: id=${parsed.id}`, "not_found");
        }
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
          description:
            "DPC (Data Protection Commission) MCP server. Provides access to Irish data protection authority decisions, inquiries, and enforcement notices. The DPC is the EU lead supervisory authority for GDPR under Article 56 for most major tech companies headquartered in Ireland (Meta, Google, Apple, Twitter/X, TikTok, LinkedIn, Airbnb).",
          data_source: "DPC (https://www.dataprotection.ie/)",
          coverage: {
            decisions: "DPC decisions, cross-border inquiries, enforcement notices, and binding decisions",
            guidelines: "DPC guides, codes of practice, regulatory advice, and FAQs",
            topics: "Transfers, children, big_tech, social_media, breach_notification, consent, profiling, data_subject_rights, adequacy",
          },
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

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
