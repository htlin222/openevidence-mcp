import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AppConfig } from "./config.js";
import { extractAnswerText } from "./openevidence-client.js";

export interface CitationRecord {
  key: string;
  citation: string;
  title?: string;
  href?: string;
  doi?: string;
  pmid?: number;
  repository?: string;
  published?: string;
  authors?: string;
  journal?: string;
  publicationInfo?: string;
  pageImage?: string;
  crossref?: CrossrefValidation;
}

export interface CrossrefValidation {
  status: "validated" | "not_found" | "candidate" | "error" | "skipped";
  method: "doi" | "bibliographic" | "none";
  httpStatus?: number;
  doi?: string;
  title?: string;
  score?: number;
  similarity?: number;
  message?: string;
  work?: CrossrefWork;
}

export interface ArticleArtifacts {
  artifactDir: string;
  articlePath: string;
  answerPath: string;
  citationsJsonPath: string;
  bibPath: string;
  crossrefValidationPath: string;
  bibtex?: string;
  citationCount: number;
  crossrefValidatedCount: number;
}

export interface CrossrefLookup {
  byDoi(doi: string, mailto?: string): Promise<CrossrefWork | null>;
  byBibliographic(query: string, mailto?: string): Promise<CrossrefWork | null>;
}

interface CitationInput {
  citation?: unknown;
  metadata?: {
    citation_detail?: CitationDetail;
    content_metadata?: {
      figures?: { url?: unknown }[];
    };
  };
}

interface CitationDetail {
  doi?: unknown;
  href?: unknown;
  pmid?: unknown;
  title?: unknown;
  repository?: unknown;
  dt_published?: unknown;
  authors_string?: unknown;
  journal_name?: unknown;
  publication_info_string?: unknown;
}

interface CrossrefWork {
  DOI?: string;
  URL?: string;
  type?: string;
  title?: string[];
  author?: { given?: string; family?: string; name?: string }[];
  publisher?: string;
  "container-title"?: string[];
  "published-print"?: { "date-parts"?: number[][] };
  "published-online"?: { "date-parts"?: number[][] };
  published?: { "date-parts"?: number[][] };
  issued?: { "date-parts"?: number[][] };
  volume?: string;
  issue?: string;
  page?: string;
  score?: number;
}

const DOI_RE = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi;
const MARKDOWN_LINK_RE = /\[([^\]]+)]\((https?:\/\/[^)\s]+)\)/g;

export async function saveArticleArtifacts(
  article: Record<string, unknown>,
  config: AppConfig,
  options?: { validateWithCrossref?: boolean; crossrefLookup?: CrossrefLookup },
): Promise<ArticleArtifacts> {
  const articleId = String(article.id ?? "unknown-article");
  const artifactDir = path.join(config.artifactDir, sanitizePathSegment(articleId));
  await mkdir(artifactDir, { recursive: true });

  const answer = extractAnswerText(article) ?? "";
  const citations = extractCitations(article, answer);
  const shouldValidate = options?.validateWithCrossref ?? config.crossrefValidate;
  const validatedCitations = shouldValidate
    ? await validateCitationsWithCrossref(citations, config.crossrefMailto, options?.crossrefLookup)
    : citations.map((citation) => ({
        ...citation,
        crossref: { status: "skipped", method: "none" } as CrossrefValidation,
      }));
  const bibtex = citationsToBibTeX(validatedCitations);

  const articlePath = path.join(artifactDir, "article.json");
  const answerPath = path.join(artifactDir, "answer.md");
  const citationsJsonPath = path.join(artifactDir, "citations.json");
  const bibPath = path.join(artifactDir, "citations.bib");
  const crossrefValidationPath = path.join(artifactDir, "crossref-validation.json");

  await writeFile(articlePath, `${JSON.stringify(article, null, 2)}\n`);
  await writeFile(answerPath, answer);
  await writeFile(citationsJsonPath, `${JSON.stringify(validatedCitations, null, 2)}\n`);
  await writeFile(bibPath, `${bibtex}\n`);
  await writeFile(
    crossrefValidationPath,
    `${JSON.stringify(
      validatedCitations.map(({ key, title, doi, href, crossref }) => ({
        key,
        title,
        doi,
        href,
        crossref,
      })),
      null,
      2,
    )}\n`,
  );

  return {
    artifactDir,
    articlePath,
    answerPath,
    citationsJsonPath,
    bibPath,
    crossrefValidationPath,
    bibtex,
    citationCount: validatedCitations.length,
    crossrefValidatedCount: validatedCitations.filter(
      (citation) => citation.crossref?.status === "validated",
    ).length,
  };
}

export function extractCitations(
  article: Record<string, unknown>,
  answerText = extractAnswerText(article) ?? "",
): CitationRecord[] {
  const structured = article.output as Record<string, unknown> | undefined;
  const candidates = collectStructuredCitations(structured?.structured_article).concat(
    collectMarkdownCitations(answerText),
  );

  const seen = new Set<string>();
  const unique: CitationRecord[] = [];
  for (const citation of candidates) {
    const key = dedupeKey(citation);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(citation);
  }

  return assignCitationKeys(unique);
}

export async function validateCitationsWithCrossref(
  citations: CitationRecord[],
  mailto?: string,
  lookup: CrossrefLookup = defaultCrossrefLookup,
): Promise<CitationRecord[]> {
  const validated: CitationRecord[] = [];
  for (const citation of citations) {
    validated.push({
      ...citation,
      crossref: await validateCitationWithCrossref(citation, mailto, lookup),
    });
  }
  return validated;
}

function collectStructuredCitations(root: unknown): CitationRecord[] {
  const citations: CitationRecord[] = [];

  function walk(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }

    const node = value as { citations?: unknown };
    if (Array.isArray(node.citations)) {
      for (const citation of node.citations as CitationInput[]) {
        const normalized = normalizeStructuredCitation(citation);
        if (normalized) {
          citations.push(normalized);
        }
      }
    }

    for (const child of Object.values(value)) {
      walk(child);
    }
  }

  walk(root);
  return citations;
}

function normalizeStructuredCitation(input: CitationInput): CitationRecord | null {
  const detail = input.metadata?.citation_detail ?? {};
  const rawCitation = typeof input.citation === "string" ? stripHtml(input.citation) : "";
  const title = stringValue(detail.title) ?? titleFromCitation(rawCitation);
  const href = stringValue(detail.href);
  const doi = normalizeDoi(stringValue(detail.doi) ?? doiFromText(rawCitation));
  const authors = stringValue(detail.authors_string);
  const published = stringValue(detail.dt_published);

  if (!rawCitation && !title && !href && !doi) {
    return null;
  }

  return {
    key: "",
    citation: rawCitation,
    title,
    href,
    doi,
    pmid: numberValue(detail.pmid),
    repository: stringValue(detail.repository),
    published,
    authors,
    journal: stringValue(detail.journal_name),
    publicationInfo: stringValue(detail.publication_info_string),
    pageImage: stringValue(input.metadata?.content_metadata?.figures?.[0]?.url),
  };
}

function collectMarkdownCitations(text: string): CitationRecord[] {
  const citations: CitationRecord[] = [];
  for (const match of text.matchAll(MARKDOWN_LINK_RE)) {
    citations.push({
      key: "",
      citation: stripHtml(match[1]),
      title: stripHtml(match[1]),
      href: match[2],
      doi: normalizeDoi(doiFromText(match[2]) ?? doiFromText(match[1])),
    });
  }
  for (const match of text.matchAll(DOI_RE)) {
    const doi = normalizeDoi(match[0]);
    if (!doi) {
      continue;
    }
    citations.push({
      key: "",
      citation: `doi:${doi}`,
      doi,
      href: `https://doi.org/${doi}`,
    });
  }
  return citations;
}

async function validateCitationWithCrossref(
  citation: CitationRecord,
  mailto?: string,
  lookup: CrossrefLookup = defaultCrossrefLookup,
): Promise<CrossrefValidation> {
  try {
    if (citation.doi) {
      const work = await lookup.byDoi(citation.doi, mailto);
      if (!work) {
        return { status: "not_found", method: "doi", doi: citation.doi };
      }
      const title = firstTitle(work);
      return {
        status: "validated",
        method: "doi",
        doi: work.DOI,
        title,
        similarity: title && citation.title ? titleSimilarity(citation.title, title) : undefined,
        work,
      };
    }

    if (citation.title) {
      const work = await lookup.byBibliographic(citation.title, mailto);
      if (!work) {
        return { status: "not_found", method: "bibliographic" };
      }
      const title = firstTitle(work);
      const similarity = title ? titleSimilarity(citation.title, title) : 0;
      return {
        status: similarity >= 0.7 ? "candidate" : "not_found",
        method: "bibliographic",
        doi: work.DOI,
        title,
        score: work.score,
        similarity,
        work,
      };
    }

    return { status: "skipped", method: "none", message: "No DOI or title to validate." };
  } catch (error) {
    return {
      status: "error",
      method: citation.doi ? "doi" : citation.title ? "bibliographic" : "none",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchCrossrefDoi(doi: string, mailto?: string): Promise<CrossrefWork | null> {
  const url = new URL(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
  if (mailto) {
    url.searchParams.set("mailto", mailto);
  }
  const json = await fetchCrossref(url);
  return (json.message as CrossrefWork | undefined) ?? null;
}

async function fetchCrossrefBibliographic(
  query: string,
  mailto?: string,
): Promise<CrossrefWork | null> {
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("rows", "1");
  url.searchParams.set("query.bibliographic", query);
  if (mailto) {
    url.searchParams.set("mailto", mailto);
  }
  const json = await fetchCrossref(url);
  const items = (json.message as { items?: CrossrefWork[] } | undefined)?.items ?? [];
  return items[0] ?? null;
}

const defaultCrossrefLookup: CrossrefLookup = {
  byDoi: fetchCrossrefDoi,
  byBibliographic: fetchCrossrefBibliographic,
};

async function fetchCrossref(url: URL): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "openevidence-mcp/0.1.0 (https://github.com/bakhtiersizhaev/openevidence-mcp)",
    },
  });
  if (res.status === 404) {
    return {};
  }
  if (!res.ok) {
    throw new Error(`Crossref request failed (${res.status})`);
  }
  return (await res.json()) as Record<string, unknown>;
}

export function citationsToBibTeX(citations: CitationRecord[]): string {
  return citations.map(citationToBibTeX).join("\n\n");
}

function citationToBibTeX(citation: CitationRecord): string {
  const work =
    citation.crossref?.status === "validated" || citation.crossref?.status === "candidate"
      ? citation.crossref.work
      : undefined;
  const fields = new Map<string, string>();
  const type = bibType(work?.type, citation);

  addField(fields, "title", firstTitle(work) ?? citation.title);
  addField(fields, "author", crossrefAuthors(work) ?? citation.authors);
  addField(fields, "journal", firstValue(work?.["container-title"]) ?? citation.journal);
  addField(fields, "year", crossrefYear(work) ?? yearFromDate(citation.published));
  addField(fields, "volume", work?.volume);
  addField(fields, "number", work?.issue);
  addField(fields, "pages", work?.page);
  addField(fields, "doi", work?.DOI ?? citation.doi);
  addField(fields, "url", work?.URL ?? citation.href);
  addField(fields, "publisher", work?.publisher ?? citation.repository);
  addField(fields, "note", citation.publicationInfo);

  const body = [...fields.entries()]
    .map(([name, value]) => `  ${name} = {${bibEscape(value)}},`)
    .join("\n");

  return `@${type}{${citation.key},\n${body}\n}`;
}

function assignCitationKeys(citations: CitationRecord[]): CitationRecord[] {
  const used = new Map<string, number>();
  return citations.map((citation, index) => {
    const base = baseCitationKey(citation) || `oe${index + 1}`;
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    return {
      ...citation,
      key: count === 0 ? base : `${base}${count + 1}`,
    };
  });
}

function baseCitationKey(citation: CitationRecord): string {
  const author = citation.authors?.split(/[,.]/)[0] ?? citation.repository ?? "oe";
  const year = yearFromDate(citation.published) ?? "";
  const titleWord = citation.title?.match(/[A-Za-z0-9]+/)?.[0] ?? "";
  return sanitizeKey(`${author}${year}${titleWord}`);
}

function dedupeKey(citation: CitationRecord): string {
  return [
    citation.doi?.toLowerCase(),
    citation.pmid,
    citation.href?.replace(/#page=\d+$/, "").toLowerCase(),
    citation.title?.toLowerCase(),
    citation.citation.toLowerCase(),
  ]
    .filter(Boolean)
    .join("|");
}

function bibType(type: string | undefined, citation: CitationRecord): string {
  if (type === "journal-article" || citation.journal || citation.doi) {
    return "article";
  }
  if (type === "proceedings-article") {
    return "inproceedings";
  }
  return "misc";
}

function addField(fields: Map<string, string>, name: string, value: string | undefined): void {
  if (value && value.trim().length > 0) {
    fields.set(name, value.trim());
  }
}

function crossrefAuthors(work: CrossrefWork | undefined): string | undefined {
  if (!work?.author?.length) {
    return undefined;
  }
  return work.author
    .map((author) => {
      if (author.family && author.given) {
        return `${author.family}, ${author.given}`;
      }
      return author.name ?? author.family ?? author.given ?? "";
    })
    .filter(Boolean)
    .join(" and ");
}

function crossrefYear(work: CrossrefWork | undefined): string | undefined {
  return (
    yearFromParts(work?.issued?.["date-parts"]) ??
    yearFromParts(work?.published?.["date-parts"]) ??
    yearFromParts(work?.["published-print"]?.["date-parts"]) ??
    yearFromParts(work?.["published-online"]?.["date-parts"])
  );
}

function yearFromParts(parts: number[][] | undefined): string | undefined {
  const year = parts?.[0]?.[0];
  return typeof year === "number" ? String(year) : undefined;
}

function yearFromDate(date: string | undefined): string | undefined {
  return date?.match(/\d{4}/)?.[0];
}

function firstTitle(work: CrossrefWork | undefined): string | undefined {
  return firstValue(work?.title);
}

function firstValue(values: string[] | undefined): string | undefined {
  return values?.find((value) => value.trim().length > 0);
}

function titleSimilarity(a: string, b: string): number {
  const left = new Set(normalizeTitle(a).split(" ").filter(Boolean));
  const right = new Set(normalizeTitle(b).split(" ").filter(Boolean));
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) {
      overlap += 1;
    }
  }
  return overlap / Math.max(left.size, right.size);
}

function normalizeTitle(value: string): string {
  return stripHtml(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function titleFromCitation(citation: string): string | undefined {
  const match = citation.match(/\. ([^.]+)\. [A-Z][A-Za-z ]+\./);
  return match?.[1];
}

function doiFromText(text: string): string | undefined {
  return text.match(DOI_RE)?.[0];
}

function normalizeDoi(doi: string | undefined): string | undefined {
  return doi?.replace(/^doi:/i, "").replace(/[.);,\s]+$/, "").toLowerCase();
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function sanitizeKey(value: string): string {
  return value.replace(/[^A-Za-z0-9:_-]+/g, "");
}

function bibEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/[{}]/g, "");
}
