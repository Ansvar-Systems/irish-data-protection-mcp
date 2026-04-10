# Tools

All tools use the prefix `ie_dp_` and are provided by the Irish Data Protection MCP server.

## ie_dp_search_decisions

Full-text search across DPC decisions, inquiries, and enforcement notices.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query (e.g., `"data transfers"`, `"children consent"`, `"Meta WhatsApp"`) |
| `type` | string | No | Filter by decision type: `decision`, `inquiry`, `enforcement_notice`, `binding_decision` |
| `topic` | string | No | Filter by topic ID (see `ie_dp_list_topics` for available IDs) |
| `limit` | number | No | Maximum results to return (default: 20, max: 100) |

**Returns:** Array of matching decisions, each with `_citation` metadata for entity linking.

---

## ie_dp_get_decision

Retrieve a single DPC decision by its reference number.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `reference` | string | Yes | DPC reference number (e.g., `"DPC-IN-18-2-1"`, `"DPC-D-21-001"`) |

**Returns:** Full decision record including `reference`, `title`, `date`, `type`, `entity_name`, `fine_amount`, `summary`, `full_text`, `topics`, `gdpr_articles`, `status`, and `_citation`.

---

## ie_dp_search_guidelines

Search DPC guidance documents including codes of practice, guides, regulatory advice, and FAQs.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query (e.g., `"standard contractual clauses"`, `"children online"`) |
| `type` | string | No | Filter by guidance type: `guide`, `code_of_practice`, `regulatory_advice`, `FAQ` |
| `topic` | string | No | Filter by topic ID |
| `limit` | number | No | Maximum results to return (default: 20, max: 100) |

**Returns:** Array of matching guidelines, each with `_citation` metadata for entity linking.

---

## ie_dp_get_guideline

Retrieve a single DPC guidance document by its database ID.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Guideline database ID (from `ie_dp_search_guidelines` results) |

**Returns:** Full guideline record including `id`, `reference`, `title`, `date`, `type`, `summary`, `full_text`, `topics`, `language`, and `_citation`.

---

## ie_dp_list_topics

List all covered data protection topics with English names.

**Parameters:** None

**Returns:** Array of topic objects with `id`, `name_en`, and `description`. Use `id` values to filter decisions and guidelines.

---

## ie_dp_about

Return metadata about this MCP server.

**Parameters:** None

**Returns:** Server name, version, description, data source, coverage summary, and full tool list.

---

## list_sources

List all data sources used by this MCP server.

**Parameters:** None

**Returns:** Array of source objects with `name`, `url`, `description`, `coverage`, `license`, and `refresh_schedule`.

---

## check_data_freshness

Check when the data was last ingested and current record counts.

**Parameters:** None

**Returns:** `status`, `decisions_count`, `guidelines_count`, `topics_count`, `latest_decision_date`, `latest_guideline_date`, and a note on how to refresh.
