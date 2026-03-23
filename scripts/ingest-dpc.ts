#!/usr/bin/env tsx
/**
 * DPC (Data Protection Commission) ingestion crawler.
 *
 * Crawls dataprotection.ie for:
 *   Phase 1 — Published decisions (enforcement actions, inquiries)
 *   Phase 2 — Guidance documents (guides, codes of practice, FAQs)
 *   Phase 3 — Topics (controlled vocabulary seeded from decision/guidance metadata)
 *
 * The DPC is the Irish supervisory authority under the GDPR and — due to
 * Ireland's status as the EU establishment for most US Big Tech companies —
 * one of the most consequential data protection authorities worldwide.  It
 * has issued the largest GDPR fine to date (EUR 1.2 billion, Meta, 2023).
 *
 * Decisions live at:
 *   https://www.dataprotection.ie/en/dpc-guidance/law/decisions-made-under-data-protection-act-2018
 * Guidance lives at:
 *   https://www.dataprotection.ie/en/dpc-guidance
 *
 * Usage:
 *   npx tsx scripts/ingest-dpc.ts                   # full run
 *   npx tsx scripts/ingest-dpc.ts --dry-run         # crawl but don't write to DB
 *   npx tsx scripts/ingest-dpc.ts --resume           # skip already-ingested items
 *   npx tsx scripts/ingest-dpc.ts --force            # drop + recreate tables first
 *   npx tsx scripts/ingest-dpc.ts --decisions-only   # skip guidance
 *   npx tsx scripts/ingest-dpc.ts --guidance-only    # skip decisions
 *   npx tsx scripts/ingest-dpc.ts --limit 5          # stop after N items per phase
 *   npx tsx scripts/ingest-dpc.ts --verbose          # extra logging
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL = "https://www.dataprotection.ie";
const DECISIONS_INDEX_URL = `${BASE_URL}/en/dpc-guidance/law/decisions-made-under-data-protection-act-2018`;
const GUIDANCE_INDEX_URL = `${BASE_URL}/en/dpc-guidance`;

const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 3000;
const REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT =
  "AnsvarDPCCrawler/1.0 (+https://ansvar.eu; compliance research)";

const DB_PATH = process.env["DPC_DB_PATH"] ?? "data/dpc.db";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

interface CliFlags {
  dryRun: boolean;
  resume: boolean;
  force: boolean;
  decisionsOnly: boolean;
  guidanceOnly: boolean;
  limit: number;
  verbose: boolean;
}

function parseFlags(): CliFlags {
  const args = process.argv.slice(2);
  const flags: CliFlags = {
    dryRun: false,
    resume: false,
    force: false,
    decisionsOnly: false,
    guidanceOnly: false,
    limit: 0,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--dry-run":
        flags.dryRun = true;
        break;
      case "--resume":
        flags.resume = true;
        break;
      case "--force":
        flags.force = true;
        break;
      case "--decisions-only":
        flags.decisionsOnly = true;
        break;
      case "--guidance-only":
        flags.guidanceOnly = true;
        break;
      case "--verbose":
        flags.verbose = true;
        break;
      case "--limit": {
        const next = args[++i];
        if (!next || isNaN(parseInt(next, 10))) {
          console.error("--limit requires a numeric argument");
          process.exit(1);
        }
        flags.limit = parseInt(next, 10);
        break;
      }
      default:
        console.error(`Unknown flag: ${arg}`);
        process.exit(1);
    }
  }

  return flags;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

let lastRequestTime = 0;

async function rateLimit(): Promise<void> {
  const elapsed = Date.now() - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }
  lastRequestTime = Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(url: string, retries = MAX_RETRIES): Promise<string> {
  await rateLimit();

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );

      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-IE,en;q=0.9",
        },
        signal: controller.signal,
        redirect: "follow",
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      return await response.text();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      if (attempt < retries) {
        const backoff = RETRY_BACKOFF_MS * attempt;
        console.warn(
          `  [retry ${attempt}/${retries}] ${url} — ${msg}, waiting ${backoff}ms`,
        );
        await sleep(backoff);
      } else {
        throw new Error(`Failed after ${retries} attempts: ${url} — ${msg}`);
      }
    }
  }

  // Unreachable, but TypeScript needs it.
  throw new Error("Unexpected: retry loop exited without return or throw");
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Resolve a potentially relative or malformed href against the base URL. */
function resolveUrl(href: string): string {
  // Some links on the DPC site include the full domain as a prefix without
  // protocol — e.g. "/www.dataprotection.ie/en/..." — strip it.
  const cleaned = href.replace(/^\/www\.dataprotection\.ie/, "");

  if (cleaned.startsWith("http://") || cleaned.startsWith("https://")) {
    return cleaned;
  }
  return `${BASE_URL}${cleaned.startsWith("/") ? "" : "/"}${cleaned}`;
}

/** Normalise whitespace: collapse runs, trim. */
function normaliseText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Extract a date from a DPC title or page text.
 *
 * DPC uses formats like:
 *   "... - September 2023"
 *   "... – December 2024"
 *   "12 December 2024"
 *   "Date of Decision: 22 October 2024"
 */
const MONTHS: Record<string, string> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

function extractDateFromText(text: string): string | null {
  // Try "DD Month YYYY" first (most precise).
  const dayMonthYear =
    /(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i;
  const dmMatch = dayMonthYear.exec(text);
  if (dmMatch) {
    const day = dmMatch[1]!.padStart(2, "0");
    const month = MONTHS[dmMatch[2]!.toLowerCase()]!;
    return `${dmMatch[3]}-${month}-${day}`;
  }

  // Fall back to "Month YYYY" (set day to 01).
  const monthYear =
    /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i;
  const mMatch = monthYear.exec(text);
  if (mMatch) {
    const month = MONTHS[mMatch[1]!.toLowerCase()]!;
    return `${mMatch[2]}-${month}-01`;
  }

  return null;
}

/**
 * Extract a DPC reference number from text, e.g. "IN-18-2-1" or "(IN-18-10-1)".
 */
function extractReference(text: string): string | null {
  const match = /\b(IN-\d{2}-\d{1,2}-\d{1,2})\b/i.exec(text);
  if (match) return `DPC-${match[1]!.toUpperCase()}`;

  // Some older decisions use "AE-" prefix.
  const aeMatch = /\b(AE-\d{2}-\d{1,2}-\d{1,2})\b/i.exec(text);
  if (aeMatch) return `DPC-${aeMatch[1]!.toUpperCase()}`;

  return null;
}

/**
 * Extract the entity name from a decision title.
 *
 * Typical patterns:
 *   "Inquiry into TikTok Technology Limited - September 2023"
 *   "Inquiry concerning the University of Limerick – December 2025"
 *   "A&G Couriers Limited T/A Fastway Couriers (Ireland) - December 2022"
 */
function extractEntityFromTitle(title: string): string | null {
  // Strip the trailing date portion.
  const withoutDate = title
    .replace(
      /\s*[-–—]\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}.*$/i,
      "",
    )
    .replace(/\s*[-–—]\s*\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}.*$/i, "");

  // Strip "Inquiry into" / "Inquiry concerning" / "Inquiries into" prefix.
  const withoutPrefix = withoutDate
    .replace(/^Inquir(?:y|ies)\s+(?:into|concerning)\s+(?:the\s+)?/i, "")
    .trim();

  return withoutPrefix || null;
}

/**
 * Extract GDPR article numbers from body text.
 * Returns deduplicated list like ["5","6","13","25"].
 */
function extractGdprArticles(text: string): string[] {
  const articles = new Set<string>();

  // Match "Article 5(1)(a)", "Article 33", "Articles 5 and 6", etc.
  const pattern = /Articles?\s+([\d,\s]+(?:and\s+\d+)?)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const fragment = match[1]!;
    const nums = fragment.match(/\d+/g);
    if (nums) {
      for (const n of nums) {
        // GDPR has 99 articles; filter out obvious non-article numbers.
        const num = parseInt(n, 10);
        if (num >= 1 && num <= 99) {
          articles.add(n);
        }
      }
    }
  }

  // Also catch standalone "Art. 5(1)(f)" style.
  const artDot = /Art\.\s*(\d+)/gi;
  while ((match = artDot.exec(text)) !== null) {
    const num = parseInt(match[1]!, 10);
    if (num >= 1 && num <= 99) {
      articles.add(match[1]!);
    }
  }

  return [...articles].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

/**
 * Extract fine amounts from body text.
 * Returns the largest fine found (total), or null.
 *
 * Patterns: "EUR 1.2 billion", "EUR 345 million", "€251 million", "€45,000"
 */
function extractFineAmount(text: string): number | null {
  const fines: number[] = [];

  // "EUR X,XXX,XXX" or "€X,XXX,XXX" or "EUR X million/billion"
  const patterns = [
    /(?:EUR|€)\s*([\d,]+(?:\.\d+)?)\s*billion/gi,
    /(?:EUR|€)\s*([\d,]+(?:\.\d+)?)\s*million/gi,
    /(?:EUR|€)\s*([\d,]+(?:\.\d+)?)\b(?!\s*(?:million|billion))/gi,
  ];

  const multipliers = [1_000_000_000, 1_000_000, 1];

  for (let i = 0; i < patterns.length; i++) {
    const pattern = patterns[i]!;
    const multiplier = multipliers[i]!;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const numStr = match[1]!.replace(/,/g, "");
      const value = parseFloat(numStr) * multiplier;
      if (value > 0 && isFinite(value)) {
        fines.push(value);
      }
    }
  }

  if (fines.length === 0) return null;

  // Return the largest value (typically the total fine).
  return Math.max(...fines);
}

/**
 * Classify a decision based on its title and content.
 * Returns one of: "decision", "inquiry", "enforcement_notice", "reprimand".
 */
function classifyDecisionType(title: string, bodyText: string): string {
  const combined = `${title} ${bodyText}`.toLowerCase();

  if (combined.includes("enforcement notice")) return "enforcement_notice";
  if (combined.includes("reprimand") && !combined.includes("fine"))
    return "reprimand";
  if (combined.includes("inquiry")) return "inquiry";
  return "decision";
}

/**
 * Assign topic tags based on entity name and content keywords.
 */
function assignTopics(
  entityName: string | null,
  bodyText: string,
): string[] {
  const topics: string[] = [];
  const text = `${entityName ?? ""} ${bodyText}`.toLowerCase();

  // Big tech companies with Irish headquarters.
  const bigTechNames = [
    "meta",
    "facebook",
    "instagram",
    "whatsapp",
    "tiktok",
    "google",
    "apple",
    "linkedin",
    "twitter",
    "microsoft",
    "airbnb",
    "yahoo",
    "uber",
  ];
  if (bigTechNames.some((name) => text.includes(name))) {
    topics.push("big_tech");
  }

  if (
    text.includes("social media") ||
    text.includes("facebook") ||
    text.includes("instagram") ||
    text.includes("tiktok") ||
    text.includes("twitter") ||
    text.includes("whatsapp") ||
    text.includes("linkedin")
  ) {
    topics.push("social_media");
  }

  if (
    text.includes("child") ||
    text.includes("children") ||
    text.includes("minor") ||
    text.includes("age verification") ||
    text.includes("parental consent")
  ) {
    topics.push("children");
  }

  if (
    text.includes("transfer") ||
    text.includes("schrems") ||
    text.includes("privacy shield") ||
    text.includes("third country") ||
    text.includes("data privacy framework")
  ) {
    topics.push("transfers");
  }

  if (
    text.includes("breach notification") ||
    text.includes("article 33") ||
    text.includes("article 34") ||
    text.includes("data breach")
  ) {
    topics.push("breach_notification");
  }

  if (
    text.includes("consent") ||
    text.includes("article 7") ||
    text.includes("freely given")
  ) {
    topics.push("consent");
  }

  if (
    text.includes("profiling") ||
    text.includes("automated decision") ||
    text.includes("targeted advertising") ||
    text.includes("behavioural")
  ) {
    topics.push("profiling");
  }

  if (
    text.includes("access request") ||
    text.includes("right of access") ||
    text.includes("erasure") ||
    text.includes("right to be forgotten") ||
    text.includes("data subject rights") ||
    text.includes("rectification") ||
    text.includes("portability")
  ) {
    topics.push("data_subject_rights");
  }

  if (
    text.includes("adequacy") ||
    text.includes("schrems ii") ||
    text.includes("privacy shield")
  ) {
    topics.push("adequacy");
  }

  // Deduplicate.
  return [...new Set(topics)];
}

// ---------------------------------------------------------------------------
// Phase 1: Decisions
// ---------------------------------------------------------------------------

interface DecisionIndexEntry {
  href: string;
  title: string;
}

/** Scrape the decisions index page for all decision links. */
async function discoverDecisions(
  flags: CliFlags,
): Promise<DecisionIndexEntry[]> {
  console.log("\n=== Phase 1: Discovering decisions ===\n");
  console.log(`  Index URL: ${DECISIONS_INDEX_URL}`);

  const html = await fetchPage(DECISIONS_INDEX_URL);
  const $ = cheerio.load(html);

  const entries: DecisionIndexEntry[] = [];

  // Decision links are <a> elements inside the main content area,
  // pointing to paths that contain "decisions" or "law/decisions".
  $("a").each((_i, el) => {
    const href = $(el).attr("href");
    const text = normaliseText($(el).text());

    if (!href || !text) return;

    // Filter: only links that point to individual decision pages.
    const isDecisionLink =
      (href.includes("/decisions/") ||
        href.includes("/decisions-made-under-data-protection-act-2018/")) &&
      !href.endsWith("/decisions-made-under-data-protection-act-2018") &&
      !href.endsWith("/decisions-made-under-data-protection-act-2018/") &&
      text.length > 10;

    if (isDecisionLink) {
      entries.push({ href: resolveUrl(href), title: text });
    }
  });

  // Deduplicate by URL.
  const seen = new Set<string>();
  const unique = entries.filter((e) => {
    const key = e.href.replace(/^https?:\/\//, "").replace(/\/$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`  Found ${unique.length} decision links`);

  const limited = flags.limit > 0 ? unique.slice(0, flags.limit) : unique;
  if (flags.limit > 0) {
    console.log(`  Limited to ${limited.length} (--limit ${flags.limit})`);
  }

  return limited;
}

interface CrawledDecision {
  reference: string;
  title: string;
  date: string | null;
  type: string;
  entity_name: string | null;
  fine_amount: number | null;
  summary: string;
  full_text: string;
  topics: string;
  gdpr_articles: string;
  status: string;
  source_url: string;
}

/** Fetch and parse a single decision page. */
async function crawlDecision(
  entry: DecisionIndexEntry,
  flags: CliFlags,
): Promise<CrawledDecision | null> {
  const html = await fetchPage(entry.href);
  const $ = cheerio.load(html);

  // The main content is typically in a <div> with class containing "field--name-body"
  // or the main article body. Try multiple selectors.
  const bodySelectors = [
    ".field--name-body",
    ".node__content",
    "article .content",
    "main .content",
    "main article",
    "main",
  ];

  let bodyHtml = "";
  for (const selector of bodySelectors) {
    const el = $(selector).first();
    if (el.length > 0) {
      bodyHtml = el.html() ?? "";
      if (bodyHtml.length > 100) break;
    }
  }

  if (!bodyHtml) {
    if (flags.verbose) {
      console.warn(`    No body content found at ${entry.href}`);
    }
    return null;
  }

  // Extract text content from the body, stripping HTML tags.
  const bodyText = normaliseText(
    cheerio.load(bodyHtml).root().text(),
  );

  if (bodyText.length < 50) {
    if (flags.verbose) {
      console.warn(`    Body text too short (${bodyText.length} chars) at ${entry.href}`);
    }
    return null;
  }

  // Page heading (h1).
  const pageTitle = normaliseText($("h1").first().text()) || entry.title;

  // Extract metadata.
  const reference =
    extractReference(bodyText) ?? extractReference(pageTitle) ?? generateReference(entry.href);
  const date = extractDateFromText(bodyText) ?? extractDateFromText(entry.title);
  const entityName = extractEntityFromTitle(entry.title);
  const fineAmount = extractFineAmount(bodyText);
  const gdprArticles = extractGdprArticles(bodyText);
  const type = classifyDecisionType(entry.title, bodyText);
  const topics = assignTopics(entityName, bodyText);

  // Build a summary: first 500 chars of body text, cut at sentence boundary.
  const summaryRaw = bodyText.slice(0, 600);
  const sentenceEnd = summaryRaw.lastIndexOf(".");
  const summary = sentenceEnd > 100 ? summaryRaw.slice(0, sentenceEnd + 1) : summaryRaw;

  return {
    reference,
    title: pageTitle,
    date,
    type,
    entity_name: entityName,
    fine_amount: fineAmount,
    summary,
    full_text: bodyText,
    topics: JSON.stringify(topics),
    gdpr_articles: JSON.stringify(gdprArticles),
    status: "final",
    source_url: entry.href,
  };
}

/** Generate a fallback reference from the URL slug. */
function generateReference(url: string): string {
  const slug = url
    .split("/")
    .filter(Boolean)
    .pop()
    ?.replace(/[^a-zA-Z0-9-]/g, "")
    .slice(0, 60);
  return `DPC-${slug ?? "unknown"}`;
}

// ---------------------------------------------------------------------------
// Phase 2: Guidance
// ---------------------------------------------------------------------------

interface GuidanceIndexEntry {
  href: string;
  title: string;
  category: string;
}

/** Scrape the guidance index page for all guidance links. */
async function discoverGuidance(
  flags: CliFlags,
): Promise<GuidanceIndexEntry[]> {
  console.log("\n=== Phase 2: Discovering guidance ===\n");
  console.log(`  Index URL: ${GUIDANCE_INDEX_URL}`);

  const html = await fetchPage(GUIDANCE_INDEX_URL);
  const $ = cheerio.load(html);

  const entries: GuidanceIndexEntry[] = [];

  // The guidance page has sections with <h5> category headers, then <ul><li><a>
  // links under each. Also individual guidance links scattered in the body.
  let currentCategory = "general";

  // Walk through the main content elements in order.
  const mainContent = $(".field--name-body, .node__content, main .content").first();

  mainContent.find("h5, h4, h3, li a, p a").each((_i, el) => {
    const tagName = el.type === "tag" ? el.tagName.toLowerCase() : "";

    if (tagName === "h5" || tagName === "h4" || tagName === "h3") {
      currentCategory = normaliseText($(el).text()).toLowerCase();
      return;
    }

    // It's a link (<a>).
    const href = $(el).attr("href");
    const text = normaliseText($(el).text());

    if (!href || !text || text.length < 5) return;

    // Skip external links (EDPB, EU, etc.) — we only want DPC's own guidance.
    if (
      href.includes("edpb.europa.eu") ||
      href.includes("ec.europa.eu") ||
      href.includes("eur-lex.europa.eu") ||
      href.includes("coe.int")
    ) {
      return;
    }

    // Skip links that are just anchors, PDFs, or the decisions index.
    if (
      href.startsWith("#") ||
      href.endsWith(".pdf") ||
      href.includes("/decisions-made-under-data-protection-act-2018")
    ) {
      return;
    }

    // Must be an internal DPC page.
    if (
      href.startsWith("/en/") ||
      href.startsWith("/www.dataprotection.ie/en/") ||
      href.includes("dataprotection.ie/en/")
    ) {
      entries.push({
        href: resolveUrl(href),
        title: text,
        category: classifyGuidanceCategory(currentCategory),
      });
    }
  });

  // Deduplicate by URL.
  const seen = new Set<string>();
  const unique = entries.filter((e) => {
    const key = e.href.replace(/^https?:\/\//, "").replace(/\/$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`  Found ${unique.length} guidance links`);

  const limited = flags.limit > 0 ? unique.slice(0, flags.limit) : unique;
  if (flags.limit > 0) {
    console.log(`  Limited to ${limited.length} (--limit ${flags.limit})`);
  }

  return limited;
}

/** Map raw section headers to normalised guidance types. */
function classifyGuidanceCategory(raw: string): string {
  if (raw.includes("technolog")) return "technology";
  if (raw.includes("gdpr") || raw.includes("general data protection"))
    return "gdpr";
  if (raw.includes("marketing") || raw.includes("electoral"))
    return "direct_marketing";
  if (raw.includes("covid")) return "covid19";
  if (raw.includes("edpb") || raw.includes("european data protection board"))
    return "edpb";
  return "guide";
}

interface CrawledGuideline {
  reference: string | null;
  title: string;
  date: string | null;
  type: string;
  summary: string;
  full_text: string;
  topics: string;
  language: string;
  source_url: string;
}

/** Fetch and parse a single guidance page. */
async function crawlGuidance(
  entry: GuidanceIndexEntry,
  flags: CliFlags,
): Promise<CrawledGuideline | null> {
  const html = await fetchPage(entry.href);
  const $ = cheerio.load(html);

  // Extract body content.
  const bodySelectors = [
    ".field--name-body",
    ".node__content",
    "article .content",
    "main .content",
    "main article",
    "main",
  ];

  let bodyHtml = "";
  for (const selector of bodySelectors) {
    const el = $(selector).first();
    if (el.length > 0) {
      bodyHtml = el.html() ?? "";
      if (bodyHtml.length > 100) break;
    }
  }

  if (!bodyHtml) {
    if (flags.verbose) {
      console.warn(`    No body content found at ${entry.href}`);
    }
    return null;
  }

  const bodyText = normaliseText(cheerio.load(bodyHtml).root().text());

  if (bodyText.length < 30) {
    if (flags.verbose) {
      console.warn(
        `    Body text too short (${bodyText.length} chars) at ${entry.href}`,
      );
    }
    return null;
  }

  const pageTitle = normaliseText($("h1").first().text()) || entry.title;

  // Try to find a date from the page content or title.
  const date = extractDateFromText(bodyText) ?? extractDateFromText(pageTitle);

  // Generate a reference from the URL slug.
  const slug = entry.href
    .split("/")
    .filter(Boolean)
    .pop()
    ?.replace(/[^a-zA-Z0-9-]/g, "");
  const reference = slug ? `DPC-GUIDE-${slug}` : null;

  // Summary: first ~400 chars, cut at sentence boundary.
  const summaryRaw = bodyText.slice(0, 500);
  const sentenceEnd = summaryRaw.lastIndexOf(".");
  const summary =
    sentenceEnd > 80 ? summaryRaw.slice(0, sentenceEnd + 1) : summaryRaw;

  // Auto-detect topics from content.
  const topics = assignTopics(null, bodyText);

  return {
    reference,
    title: pageTitle,
    date,
    type: entry.category,
    summary,
    full_text: bodyText,
    topics: JSON.stringify(topics),
    language: "en",
    source_url: entry.href,
  };
}

// ---------------------------------------------------------------------------
// Phase 3: Topics
// ---------------------------------------------------------------------------

const TOPIC_DEFINITIONS: Array<{
  id: string;
  name_en: string;
  description: string;
}> = [
  {
    id: "transfers",
    name_en: "International data transfers",
    description:
      "Transfers of personal data to third countries, including Standard Contractual Clauses (SCCs), Schrems II implications, and adequacy decisions (GDPR Art. 44-49).",
  },
  {
    id: "children",
    name_en: "Children's data protection",
    description:
      "Processing of personal data of children and minors, including age verification, parental consent, and design requirements for services directed at children (GDPR Art. 8).",
  },
  {
    id: "big_tech",
    name_en: "Big tech and platform companies",
    description:
      "GDPR enforcement against major technology companies headquartered in Ireland under the one-stop-shop mechanism (GDPR Art. 56).",
  },
  {
    id: "social_media",
    name_en: "Social media platforms",
    description:
      "Data protection obligations of social media platforms, including content moderation, advertising targeting, and user data practices.",
  },
  {
    id: "breach_notification",
    name_en: "Data breach notification",
    description:
      "Notification of personal data breaches to the DPC within 72 hours and to affected individuals without undue delay (GDPR Art. 33-34).",
  },
  {
    id: "consent",
    name_en: "Consent",
    description:
      "Validity of consent as a legal basis for processing, including freely given, specific, informed, and unambiguous consent requirements (GDPR Art. 6-7).",
  },
  {
    id: "profiling",
    name_en: "Profiling and automated decision-making",
    description:
      "Automated processing of personal data to evaluate personal aspects, including targeted advertising and algorithmic decision-making (GDPR Art. 22).",
  },
  {
    id: "data_subject_rights",
    name_en: "Data subject rights",
    description:
      "Rights of individuals including access, rectification, erasure, restriction, portability, and objection (GDPR Art. 15-22).",
  },
  {
    id: "adequacy",
    name_en: "Adequacy decisions and Schrems II",
    description:
      "European Commission adequacy decisions and the Schrems II ruling (Case C-311/18) invalidating Privacy Shield and its implications for US data transfers.",
  },
  {
    id: "security",
    name_en: "Data security",
    description:
      "Technical and organisational measures for protecting personal data, including encryption, access controls, and security of processing (GDPR Art. 32).",
  },
  {
    id: "public_sector",
    name_en: "Public sector data protection",
    description:
      "Data protection obligations of government bodies, local authorities, and public agencies including data sharing agreements and legal bases for processing.",
  },
  {
    id: "cctv",
    name_en: "CCTV and surveillance",
    description:
      "Data protection requirements for CCTV systems, body-worn cameras, dash cams, and drone surveillance including signage, retention, and access rights.",
  },
  {
    id: "direct_marketing",
    name_en: "Direct marketing and ePrivacy",
    description:
      "Rules governing electronic marketing, cookies, and consent for direct marketing under the ePrivacy Regulations (SI 336 of 2011) and GDPR.",
  },
  {
    id: "dpia",
    name_en: "Data Protection Impact Assessments",
    description:
      "Requirements for conducting DPIAs where processing is likely to result in a high risk to data subjects' rights and freedoms (GDPR Art. 35).",
  },
  {
    id: "transparency",
    name_en: "Transparency and information obligations",
    description:
      "Requirements to provide clear, accessible information to data subjects about data processing, including privacy notices and policies (GDPR Art. 12-14).",
  },
  {
    id: "health_data",
    name_en: "Health data",
    description:
      "Processing of health-related personal data including special category data protections, health research, and COVID-19 contact tracing.",
  },
];

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

function initDatabase(flags: CliFlags): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (flags.force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Deleted existing database at ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  return db;
}

function insertDecision(
  db: Database.Database,
  decision: CrawledDecision,
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO decisions
      (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    decision.reference,
    decision.title,
    decision.date,
    decision.type,
    decision.entity_name,
    decision.fine_amount,
    decision.summary,
    decision.full_text,
    decision.topics,
    decision.gdpr_articles,
    decision.status,
  );
}

function insertGuideline(
  db: Database.Database,
  guideline: CrawledGuideline,
): void {
  const stmt = db.prepare(`
    INSERT INTO guidelines
      (reference, title, date, type, summary, full_text, topics, language)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    guideline.reference,
    guideline.title,
    guideline.date,
    guideline.type,
    guideline.summary,
    guideline.full_text,
    guideline.topics,
    guideline.language,
  );
}

function insertTopics(db: Database.Database): void {
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO topics (id, name_en, description) VALUES (?, ?, ?)",
  );

  const tx = db.transaction(() => {
    for (const t of TOPIC_DEFINITIONS) {
      stmt.run(t.id, t.name_en, t.description);
    }
  });

  tx();
}

function decisionExists(db: Database.Database, reference: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM decisions WHERE reference = ? LIMIT 1")
    .get(reference) as { 1: number } | undefined;
  return row !== undefined;
}

function guidelineExists(db: Database.Database, title: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM guidelines WHERE title = ? LIMIT 1")
    .get(title) as { 1: number } | undefined;
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const flags = parseFlags();

  console.log("DPC Ingestion Crawler");
  console.log("=====================");
  console.log(`  Database:       ${DB_PATH}`);
  console.log(`  Dry run:        ${flags.dryRun}`);
  console.log(`  Resume:         ${flags.resume}`);
  console.log(`  Force:          ${flags.force}`);
  console.log(`  Decisions only: ${flags.decisionsOnly}`);
  console.log(`  Guidance only:  ${flags.guidanceOnly}`);
  console.log(`  Limit:          ${flags.limit || "none"}`);
  console.log(`  Verbose:        ${flags.verbose}`);

  const db = flags.dryRun ? null : initDatabase(flags);

  // Phase 3 (topics) runs first — decisions and guidance reference them.
  if (db) {
    console.log("\n=== Phase 0: Seeding topics ===\n");
    insertTopics(db);
    console.log(`  Inserted ${TOPIC_DEFINITIONS.length} topic definitions`);
  }

  // ------------------------------------------------------------------
  // Phase 1: Decisions
  // ------------------------------------------------------------------

  if (!flags.guidanceOnly) {
    const decisionEntries = await discoverDecisions(flags);

    let crawled = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < decisionEntries.length; i++) {
      const entry = decisionEntries[i]!;

      if (flags.verbose) {
        console.log(`  [${i + 1}/${decisionEntries.length}] ${entry.title}`);
      }

      try {
        const decision = await crawlDecision(entry, flags);

        if (!decision) {
          skipped++;
          continue;
        }

        // Resume mode: skip if already in DB.
        if (flags.resume && db && decisionExists(db, decision.reference)) {
          if (flags.verbose) {
            console.log(`    SKIP (exists): ${decision.reference}`);
          }
          skipped++;
          continue;
        }

        const fineStr = decision.fine_amount
          ? ` | EUR ${(decision.fine_amount / 1_000_000).toFixed(1)}M`
          : "";
        const articleStr =
          JSON.parse(decision.gdpr_articles).length > 0
            ? ` | Art. ${JSON.parse(decision.gdpr_articles).join(",")}`
            : "";

        console.log(
          `  [${i + 1}/${decisionEntries.length}] ${decision.reference} — ${decision.entity_name ?? "unknown"}${fineStr}${articleStr}`,
        );

        if (!flags.dryRun && db) {
          insertDecision(db, decision);
        }
        crawled++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  [${i + 1}/${decisionEntries.length}] FAILED: ${entry.title}`);
        console.error(`    ${msg}`);
        failed++;
      }
    }

    console.log(
      `\n  Decisions summary: ${crawled} crawled, ${skipped} skipped, ${failed} failed`,
    );
  }

  // ------------------------------------------------------------------
  // Phase 2: Guidance
  // ------------------------------------------------------------------

  if (!flags.decisionsOnly) {
    const guidanceEntries = await discoverGuidance(flags);

    let crawled = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < guidanceEntries.length; i++) {
      const entry = guidanceEntries[i]!;

      if (flags.verbose) {
        console.log(
          `  [${i + 1}/${guidanceEntries.length}] ${entry.title} (${entry.category})`,
        );
      }

      try {
        const guideline = await crawlGuidance(entry, flags);

        if (!guideline) {
          skipped++;
          continue;
        }

        // Resume mode: skip if already in DB.
        if (flags.resume && db && guidelineExists(db, guideline.title)) {
          if (flags.verbose) {
            console.log(`    SKIP (exists): ${guideline.title}`);
          }
          skipped++;
          continue;
        }

        console.log(
          `  [${i + 1}/${guidanceEntries.length}] ${guideline.type} — ${guideline.title.slice(0, 70)}`,
        );

        if (!flags.dryRun && db) {
          insertGuideline(db, guideline);
        }
        crawled++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `  [${i + 1}/${guidanceEntries.length}] FAILED: ${entry.title}`,
        );
        console.error(`    ${msg}`);
        failed++;
      }
    }

    console.log(
      `\n  Guidance summary: ${crawled} crawled, ${skipped} skipped, ${failed} failed`,
    );
  }

  // ------------------------------------------------------------------
  // Final summary
  // ------------------------------------------------------------------

  if (db) {
    const decisionCount = (
      db.prepare("SELECT count(*) as cnt FROM decisions").get() as {
        cnt: number;
      }
    ).cnt;
    const guidelineCount = (
      db.prepare("SELECT count(*) as cnt FROM guidelines").get() as {
        cnt: number;
      }
    ).cnt;
    const topicCount = (
      db.prepare("SELECT count(*) as cnt FROM topics").get() as {
        cnt: number;
      }
    ).cnt;

    console.log("\n=== Database summary ===\n");
    console.log(`  Topics:     ${topicCount}`);
    console.log(`  Decisions:  ${decisionCount}`);
    console.log(`  Guidelines: ${guidelineCount}`);

    db.close();
  } else {
    console.log("\n  Dry run complete — no data written.");
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
