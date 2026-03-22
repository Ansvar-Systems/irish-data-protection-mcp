/**
 * Seed the DPC (Data Protection Commission) database with sample decisions and guidelines.
 *
 * Includes real DPC decisions (Meta/WhatsApp, Meta/Instagram, Meta/Facebook transfers,
 * Twitter/X breach, TikTok children) and representative guidance documents so MCP tools
 * can be tested without running a full ingestion pipeline.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force   # drop and recreate
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["DPC_DB_PATH"] ?? "data/dpc.db";
const force = process.argv.includes("--force");

// --- Bootstrap database ------------------------------------------------------

const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

if (force && existsSync(DB_PATH)) {
  unlinkSync(DB_PATH);
  console.log(`Deleted existing database at ${DB_PATH}`);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);

console.log(`Database initialised at ${DB_PATH}`);

// --- Topics ------------------------------------------------------------------

interface TopicRow {
  id: string;
  name_en: string;
  description: string;
}

const topics: TopicRow[] = [
  {
    id: "transfers",
    name_en: "International data transfers",
    description: "Transfers of personal data to third countries, including Standard Contractual Clauses (SCCs), Schrems II implications, and adequacy decisions (GDPR Art. 44-49).",
  },
  {
    id: "children",
    name_en: "Children's data protection",
    description: "Processing of personal data of children and minors, including age verification, parental consent, and design requirements for services directed at children (GDPR Art. 8).",
  },
  {
    id: "big_tech",
    name_en: "Big tech and platform companies",
    description: "GDPR enforcement against major technology companies headquartered in Ireland under the one-stop-shop mechanism (GDPR Art. 56).",
  },
  {
    id: "social_media",
    name_en: "Social media platforms",
    description: "Data protection obligations of social media platforms, including content moderation, advertising targeting, and user data practices.",
  },
  {
    id: "breach_notification",
    name_en: "Data breach notification",
    description: "Notification of personal data breaches to the DPC within 72 hours and to affected individuals without undue delay (GDPR Art. 33-34).",
  },
  {
    id: "consent",
    name_en: "Consent",
    description: "Validity of consent as a legal basis for processing, including freely given, specific, informed, and unambiguous consent requirements (GDPR Art. 6-7).",
  },
  {
    id: "profiling",
    name_en: "Profiling and automated decision-making",
    description: "Automated processing of personal data to evaluate personal aspects, including targeted advertising and algorithmic decision-making (GDPR Art. 22).",
  },
  {
    id: "data_subject_rights",
    name_en: "Data subject rights",
    description: "Rights of individuals including access, rectification, erasure, restriction, portability, and objection (GDPR Art. 15-22).",
  },
  {
    id: "adequacy",
    name_en: "Adequacy decisions and Schrems II",
    description: "European Commission adequacy decisions and the Schrems II ruling (Case C-311/18) invalidating Privacy Shield and its implications for US data transfers.",
  },
];

const insertTopic = db.prepare(
  "INSERT OR IGNORE INTO topics (id, name_en, description) VALUES (?, ?, ?)",
);

for (const t of topics) {
  insertTopic.run(t.id, t.name_en, t.description);
}

console.log(`Inserted ${topics.length} topics`);

// --- Decisions ---------------------------------------------------------------

interface DecisionRow {
  reference: string;
  title: string;
  date: string;
  type: string;
  entity_name: string;
  fine_amount: number | null;
  summary: string;
  full_text: string;
  topics: string;
  gdpr_articles: string;
  status: string;
}

const decisions: DecisionRow[] = [
  // DPC-IN-18-2-1 — Meta/WhatsApp (EUR 225M)
  {
    reference: "DPC-IN-18-2-1",
    title: "DPC Inquiry — WhatsApp Ireland Limited (transparency and data sharing)",
    date: "2021-09-02",
    type: "decision",
    entity_name: "WhatsApp Ireland Limited (Meta)",
    fine_amount: 225_000_000,
    summary:
      "The DPC imposed a fine of EUR 225 million on WhatsApp Ireland Limited for failing to meet transparency obligations regarding the processing of personal data and how that information was shared between WhatsApp and other Facebook companies. This was the largest DPC fine at the time of issue.",
    full_text:
      "The Data Protection Commission concluded its inquiry into WhatsApp Ireland Limited and imposed a fine of EUR 225,000,000. The inquiry examined WhatsApp's compliance with transparency obligations under GDPR Articles 12, 13, and 14. The DPC found that WhatsApp had failed to provide sufficient information to data subjects and non-users about the processing of their personal data. Specifically, the DPC found that WhatsApp failed to: (1) provide sufficient information about the processing of data belonging to non-WhatsApp users (so-called 'non-users' whose phone numbers are stored in WhatsApp users' contact lists); (2) provide adequate information about the nature and extent of data sharing between WhatsApp and other Facebook companies including Facebook Ireland Limited; (3) provide sufficiently clear and accessible information about data processing in its privacy policy. The European Data Protection Board (EDPB) issued a binding decision under Article 65 GDPR requiring the DPC to increase the proposed fine. The EDPB found that the infringements were serious and that the DPC's initial proposed fine was insufficient. The final fine of EUR 225 million reflects the EDPB's binding decision. The DPC also required WhatsApp to bring its processing operations into compliance.",
    topics: JSON.stringify(["big_tech", "social_media", "data_subject_rights"]),
    gdpr_articles: JSON.stringify(["12", "13", "14"]),
    status: "final",
  },
  // DPC-IN-20-9-1 — Meta/Instagram (children, EUR 405M)
  {
    reference: "DPC-IN-20-9-1",
    title: "DPC Inquiry — Instagram (children's data processing)",
    date: "2022-09-15",
    type: "decision",
    entity_name: "Meta Platforms Ireland Limited (Instagram)",
    fine_amount: 405_000_000,
    summary:
      "The DPC imposed a fine of EUR 405 million on Meta Platforms Ireland Limited in relation to Instagram's processing of children's personal data. The inquiry found that Instagram's settings allowed children's accounts to be set to 'public' by default, and that business accounts registered by children exposed their contact information publicly.",
    full_text:
      "The Data Protection Commission concluded its inquiry into Meta Platforms Ireland Limited's operation of the Instagram platform and imposed a fine of EUR 405,000,000. The inquiry focused on Instagram's processing of children's personal data, particularly: (1) Instagram allowed child users (aged 13-17) to operate 'business' accounts which resulted in children's phone numbers and/or email addresses being published publicly as contact information; (2) Instagram's settings could result in children's accounts being set to 'public' by default, exposing their posts and personal information to any Instagram user. The DPC found that these practices violated GDPR Articles 5(1)(f) (integrity and confidentiality), 24 (responsibility of the controller), 25 (data protection by design and by default), and 6 (lawfulness of processing). The European Data Protection Board issued a binding decision requiring the DPC to increase its proposed fine and to make findings of additional infringements. The final fine of EUR 405 million was the largest fine imposed on Meta at that time and one of the largest GDPR fines globally. The DPC required Meta to bring Instagram's processing of children's data into compliance within a specified timeframe.",
    topics: JSON.stringify(["children", "big_tech", "social_media"]),
    gdpr_articles: JSON.stringify(["5", "6", "24", "25"]),
    status: "final",
  },
  // DPC-IN-21-7-1 — Meta/Facebook (transfers, EUR 1.2B)
  {
    reference: "DPC-IN-21-7-1",
    title: "DPC Inquiry — Meta Platforms Ireland Limited (EU-US data transfers)",
    date: "2023-05-22",
    type: "decision",
    entity_name: "Meta Platforms Ireland Limited (Facebook)",
    fine_amount: 1_200_000_000,
    summary:
      "The DPC imposed a fine of EUR 1.2 billion on Meta Platforms Ireland Limited for transferring the personal data of Facebook users in the EU/EEA to the United States without adequate safeguards following the invalidation of Privacy Shield by the Court of Justice of the EU in the Schrems II ruling. This is the largest GDPR fine ever imposed.",
    full_text:
      "The Data Protection Commission concluded its inquiry into Meta Platforms Ireland Limited (Facebook) and imposed a fine of EUR 1,200,000,000 — the largest fine ever issued under the GDPR. The inquiry examined Meta's continued transfers of EU/EEA Facebook users' personal data to the United States using Standard Contractual Clauses (SCCs) following the Court of Justice of the European Union's Schrems II judgment (Case C-311/18, Data Protection Commissioner v Facebook Ireland Limited and Maximillian Schrems, July 2020), which invalidated the EU-US Privacy Shield framework. The DPC found that Meta's reliance on SCCs for EU-US data transfers did not adequately protect data subjects' rights. Despite the Schrems II ruling, Meta continued to transfer European users' personal data to the US without implementing sufficient supplementary technical and organisational measures to address the risks posed by US surveillance laws (including FISA Section 702 and Executive Order 12333). The DPC found infringements of GDPR Articles 46(1) and 46(2)(c) (transfers subject to appropriate safeguards). The European Data Protection Board's binding decision under Article 65 GDPR required the DPC to issue the fine and ordered Meta to suspend data transfers to the US within five months. The EU-US Data Privacy Framework (DPF), adopted by the European Commission in July 2023 as an adequacy decision, provides a new legal basis for such transfers going forward.",
    topics: JSON.stringify(["transfers", "big_tech", "adequacy"]),
    gdpr_articles: JSON.stringify(["44", "46"]),
    status: "final",
  },
  // DPC-AE-19-1-1 — Twitter/X (breach, EUR 450K)
  {
    reference: "DPC-AE-19-1-1",
    title: "DPC Inquiry — Twitter International Unlimited Company (data breach notification)",
    date: "2022-12-09",
    type: "decision",
    entity_name: "Twitter International Unlimited Company (X)",
    fine_amount: 450_000,
    summary:
      "The DPC imposed a fine of EUR 450,000 on Twitter International Unlimited Company for failing to notify the DPC of a data breach within the mandatory 72-hour window and for failing to document the breach adequately. The breach involved exposure of private tweets of protected accounts.",
    full_text:
      "The Data Protection Commission concluded its inquiry into Twitter International Unlimited Company (now X Corp) and imposed a fine of EUR 450,000. The inquiry examined Twitter's handling of a personal data breach that occurred in January 2019. The breach involved a bug in Twitter's Android app that resulted in protected/private tweets of approximately 88,726 affected users being made public without the users' consent. The DPC found that Twitter failed to: (1) notify the DPC of the breach within 72 hours of becoming aware of it, as required by Article 33(1) GDPR. Twitter became aware of the potential breach on 31 December 2018 but did not notify the DPC until 8 January 2019 — well outside the 72-hour window; (2) adequately document the breach as required by Article 33(5) GDPR, which requires controllers to document all personal data breaches, their effects, and the remedial action taken. The DPC found infringements of GDPR Articles 33(1) (notification of breach to supervisory authority) and 33(5) (documentation of breaches). The fine of EUR 450,000 was the first fine the DPC issued following the GDPR coming into effect. The DPC noted that Twitter had cooperated with the investigation and had taken remedial action.",
    topics: JSON.stringify(["breach_notification", "big_tech", "social_media"]),
    gdpr_articles: JSON.stringify(["33"]),
    status: "final",
  },
  // DPC-IN-20-8-1 — TikTok (children, EUR 345M)
  {
    reference: "DPC-IN-20-8-1",
    title: "DPC Inquiry — TikTok Technology Limited (children's data)",
    date: "2023-09-01",
    type: "decision",
    entity_name: "TikTok Technology Limited",
    fine_amount: 345_000_000,
    summary:
      "The DPC imposed a fine of EUR 345 million on TikTok Technology Limited for failing to protect children's data when processing the personal data of child users aged 13-17. The inquiry found that TikTok's default settings and 'Family Pairing' feature did not adequately protect children's privacy.",
    full_text:
      "The Data Protection Commission concluded its inquiry into TikTok Technology Limited and imposed a fine of EUR 345,000,000 in relation to TikTok's processing of the personal data of child users. The inquiry examined TikTok's compliance with GDPR in respect of its users between the ages of 13 and 17. The DPC found the following infringements: (1) TikTok's 'public by default' account settings for child users meant that children's videos and other content were accessible to all TikTok users and to users who were not logged in, without the children understanding or consenting to this exposure; (2) TikTok's 'Family Pairing' feature — designed to allow parents to manage their child's account — was not actually verified. Any TikTok user, not just parents, could link to a child's account; (3) TikTok failed to apply data protection by design and by default in settings relating to child users; (4) TikTok failed to provide transparent information to child users about processing of their data. The DPC found infringements of GDPR Articles 5(1)(a) (lawfulness, fairness, transparency), 5(1)(c) (data minimisation), 13 (information to be provided), 24 (controller responsibility), and 25 (data protection by design and by default). The EDPB's binding decision required the DPC to make additional findings and adjust the fine.",
    topics: JSON.stringify(["children", "big_tech", "social_media", "consent"]),
    gdpr_articles: JSON.stringify(["5", "13", "24", "25"]),
    status: "final",
  },
  // DPC-IN-19-1-1 — LinkedIn (consent for advertising)
  {
    reference: "DPC-IN-19-1-1",
    title: "DPC Inquiry — LinkedIn Ireland Unlimited Company (consent for targeted advertising)",
    date: "2024-10-11",
    type: "decision",
    entity_name: "LinkedIn Ireland Unlimited Company",
    fine_amount: 310_000_000,
    summary:
      "The DPC imposed a fine of EUR 310 million on LinkedIn Ireland Unlimited Company for unlawfully processing personal data for targeted advertising without a valid legal basis, without freely given consent, and without meeting the transparency requirements of the GDPR.",
    full_text:
      "The Data Protection Commission concluded its inquiry into LinkedIn Ireland Unlimited Company and imposed a fine of EUR 310,000,000. The inquiry examined LinkedIn's processing of personal data for the purpose of behavioural analysis and targeted advertising. The DPC found that LinkedIn relied on consent, legitimate interests, and contract performance as legal bases for processing members' data for targeted advertising. The DPC found: (1) LinkedIn's reliance on consent was invalid as the consent was not freely given — members were not presented with a genuine choice and the granting of consent was bundled with acceptance of LinkedIn's terms of service; (2) LinkedIn's reliance on legitimate interests as a legal basis for processing was not valid as the interests of LinkedIn and third-party advertisers did not override members' fundamental rights and expectations; (3) LinkedIn's reliance on contract performance as a legal basis for behavioural advertising was not valid as such advertising was not necessary for the performance of the contract with members; (4) LinkedIn failed to provide sufficient transparency about the legal bases relied on and the purposes of processing. The DPC found infringements of GDPR Articles 5(1)(a), 6(1), and 13. The inquiry was conducted on foot of a complaint and was subject to the one-stop-shop cooperation mechanism, with the EDPB issuing a binding decision requiring the DPC to make additional findings.",
    topics: JSON.stringify(["consent", "big_tech", "profiling"]),
    gdpr_articles: JSON.stringify(["5", "6", "13"]),
    status: "final",
  },
];

const insertDecision = db.prepare(`
  INSERT OR IGNORE INTO decisions
    (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertDecisionsAll = db.transaction(() => {
  for (const d of decisions) {
    insertDecision.run(
      d.reference,
      d.title,
      d.date,
      d.type,
      d.entity_name,
      d.fine_amount,
      d.summary,
      d.full_text,
      d.topics,
      d.gdpr_articles,
      d.status,
    );
  }
});

insertDecisionsAll();
console.log(`Inserted ${decisions.length} decisions`);

// --- Guidelines --------------------------------------------------------------

interface GuidelineRow {
  reference: string | null;
  title: string;
  date: string;
  type: string;
  summary: string;
  full_text: string;
  topics: string;
  language: string;
}

const guidelines: GuidelineRow[] = [
  {
    reference: "DPC-GUIDE-TRANSFERS-2021",
    title: "Guide to Transfers of Personal Data to Third Countries post-Schrems II",
    date: "2021-02-01",
    type: "guide",
    summary:
      "DPC guide on international data transfers following the Court of Justice of the EU's Schrems II judgment (Case C-311/18), which invalidated the EU-US Privacy Shield. Covers standard contractual clauses, binding corporate rules, and supplementary measures.",
    full_text:
      "The Data Protection Commission published this guide to assist organisations in understanding their obligations regarding international data transfers following the Court of Justice of the EU's Schrems II judgment in July 2020. The Schrems II judgment (Case C-311/18) invalidated the EU-US Privacy Shield framework and imposed stricter requirements on the use of Standard Contractual Clauses (SCCs) and other transfer mechanisms. Key requirements post-Schrems II: (1) Transfer Impact Assessments (TIAs) — before relying on SCCs or Binding Corporate Rules (BCRs), exporters must carry out a case-by-case assessment to determine whether the legal framework of the destination country provides an equivalent level of protection to that guaranteed in the EU; (2) Supplementary measures — where the TIA reveals that SCCs alone do not provide adequate protection, additional technical, contractual, or organisational measures must be implemented. Technical measures include end-to-end encryption and pseudonymisation. Contractual measures include enhanced audit rights and breach notification obligations. Organisational measures include data minimisation; (3) Suspension of transfers — if no effective supplementary measures can be implemented, transfers must be suspended; (4) New SCCs — the European Commission adopted new standard contractual clauses in June 2021, which organisations were required to transition to by December 2022. The guide also covers other transfer mechanisms including adequacy decisions, derogations under Article 49 GDPR, and binding corporate rules. The EU-US Data Privacy Framework adopted in 2023 now provides an adequacy-based transfer mechanism for US transfers.",
    topics: JSON.stringify(["transfers", "adequacy"]),
    language: "en",
  },
  {
    reference: "DPC-GUIDE-CHILDREN-2021",
    title: "Children's Data Protection Guidance",
    date: "2021-07-01",
    type: "guide",
    summary:
      "DPC guidance on the protection of children's personal data under the GDPR. Covers age-appropriate design, parental consent, the Fundamentals for a Child-Oriented Approach to Data Processing, and the DPC's Children's Code.",
    full_text:
      "The Data Protection Commission published comprehensive guidance on the protection of children's personal data. Children merit specific protection when their personal data is processed, as they are less aware of the risks, consequences, and safeguards concerned. The DPC's guidance addresses: (1) The Fundamentals for a Child-Oriented Approach to Data Processing — the DPC has set out key principles that organisations processing children's data should apply, including: best interests of the child must be a primary consideration; data protection by design and by default must account for children's needs; services should apply age-appropriate defaults; privacy information must be provided in clear, plain language accessible to children; (2) Age verification and parental consent — under Article 8 GDPR, consent for information society services can only be provided by children from the age of 16 (Member States may lower this to 13). Below this age, consent must be provided by the holder of parental responsibility. Organisations must make reasonable efforts to verify the age of users; (3) Data minimisation — organisations should collect only the minimum data necessary from children; (4) Profiling and automated decision-making — the DPC considers profiling of children for targeted advertising to be particularly problematic and generally inconsistent with children's best interests; (5) Design requirements — platforms targeting children should implement default settings that maximise privacy and minimise data collection. The guidance includes a checklist for organisations to assess their compliance with children's data protection requirements.",
    topics: JSON.stringify(["children", "consent"]),
    language: "en",
  },
  {
    reference: "DPC-GUIDE-DPIA-2020",
    title: "Data Protection Impact Assessment (DPIA) Guidance",
    date: "2020-03-01",
    type: "guide",
    summary:
      "DPC guidance on when and how to conduct a Data Protection Impact Assessment (DPIA) under Article 35 GDPR. Includes the DPC's list of processing types requiring a mandatory DPIA.",
    full_text:
      "The Data Protection Commission published guidance on Data Protection Impact Assessments (DPIAs). Article 35 GDPR requires controllers to carry out a DPIA before processing that is likely to result in a high risk to the rights and freedoms of natural persons. When is a DPIA mandatory? A DPIA is always required for: (1) Systematic and extensive profiling with significant effects, including automated decision-making; (2) Large-scale processing of special categories of data (health, biometric, genetic, racial origin, political opinions, etc.); (3) Systematic monitoring of publicly accessible areas on a large scale (e.g., CCTV). The DPC has published a list of additional processing types that require a mandatory DPIA in Ireland, including: processing of personal data of vulnerable individuals at large scale; use of innovative technologies; cross-border transfers of data to countries without adequacy decisions; profiling of employees. How to conduct a DPIA: a DPIA must include: (1) a systematic description of the processing operations and their purposes; (2) an assessment of the necessity and proportionality of the processing; (3) an assessment of the risks to data subjects; (4) the measures envisaged to address the risks, including safeguards and security measures. Where a DPIA reveals high residual risks that cannot be mitigated, the controller must consult with the DPC before proceeding with the processing. The DPC must respond to consultation requests within 8 weeks (extendable by 6 weeks).",
    topics: JSON.stringify(["data_subject_rights", "consent"]),
    language: "en",
  },
];

const insertGuideline = db.prepare(`
  INSERT INTO guidelines (reference, title, date, type, summary, full_text, topics, language)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertGuidelinesAll = db.transaction(() => {
  for (const g of guidelines) {
    insertGuideline.run(
      g.reference,
      g.title,
      g.date,
      g.type,
      g.summary,
      g.full_text,
      g.topics,
      g.language,
    );
  }
});

insertGuidelinesAll();
console.log(`Inserted ${guidelines.length} guidelines`);

// --- Summary -----------------------------------------------------------------

const decisionCount = (
  db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }
).cnt;
const guidelineCount = (
  db.prepare("SELECT count(*) as cnt FROM guidelines").get() as { cnt: number }
).cnt;
const topicCount = (
  db.prepare("SELECT count(*) as cnt FROM topics").get() as { cnt: number }
).cnt;
const decisionFtsCount = (
  db.prepare("SELECT count(*) as cnt FROM decisions_fts").get() as { cnt: number }
).cnt;
const guidelineFtsCount = (
  db.prepare("SELECT count(*) as cnt FROM guidelines_fts").get() as { cnt: number }
).cnt;

console.log(`\nDatabase summary:`);
console.log(`  Topics:         ${topicCount}`);
console.log(`  Decisions:      ${decisionCount} (FTS entries: ${decisionFtsCount})`);
console.log(`  Guidelines:     ${guidelineCount} (FTS entries: ${guidelineFtsCount})`);
console.log(`\nDone. Database ready at ${DB_PATH}`);

db.close();
