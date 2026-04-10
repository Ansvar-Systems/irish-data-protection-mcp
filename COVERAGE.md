# Coverage

This document describes the corpus completeness of the Irish Data Protection MCP.

## Data Sources

| Source | URL | Coverage |
|--------|-----|----------|
| DPC Decisions & Enforcement | https://www.dataprotection.ie/en/dpc-guidance/decisions | GDPR-era decisions from May 2018 |
| DPC Guidance Documents | https://www.dataprotection.ie/en/dpc-guidance | Active guidance documents |

## Corpus Statistics

Authoritative counts are available at runtime via the `check_data_freshness` tool.

| Entity | Description |
|--------|-------------|
| Decisions | DPC decisions, cross-border inquiries (Article 56 GDPR), enforcement notices, and binding decisions |
| Guidelines | Guides, codes of practice, regulatory advice, and FAQs issued by the DPC |
| Topics | Controlled vocabulary: `transfers`, `children`, `big_tech`, `social_media`, `breach_notification`, `consent`, `profiling`, `data_subject_rights`, `adequacy` |

## Date Range

- **Decisions**: May 2018 (GDPR entry into force) onwards
- **Guidelines**: Active documents at time of last ingest

## Known Gaps

- Pre-GDPR decisions under the Data Protection Acts 1988/2003 are not included
- Decisions published after the last ingest date will not appear until the next ingest run
- Informal correspondence and unpublished regulatory exchanges are not included
- EDPB binding decisions addressed to the DPC (Article 65) are partially covered

## Refresh Schedule

Data is ingested manually when new DPC decisions or guidance documents are published. The `ingest.yml` workflow can also be triggered manually via GitHub Actions.

To check current data age and counts, call the `check_data_freshness` tool.
