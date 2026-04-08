import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  citationsToBibTeX,
  extractCitations,
  saveArticleArtifacts,
  validateCitationsWithCrossref,
  type CrossrefLookup,
} from "../src/citations.js";
import type { AppConfig } from "../src/config.js";
import { extractAnswerText } from "../src/openevidence-client.js";

const mockLookup: CrossrefLookup = {
  async byDoi(doi) {
    if (doi === "10.1056/nejmoa2115304") {
      return {
        DOI: "10.1056/nejmoa2115304",
        URL: "https://doi.org/10.1056/nejmoa2115304",
        type: "journal-article",
        title: ["Polatuzumab Vedotin in Previously Untreated Diffuse Large B-Cell Lymphoma"],
        author: [
          { family: "Tilly", given: "Herve" },
          { family: "Morschhauser", given: "Franck" },
        ],
        publisher: "Massachusetts Medical Society",
        "container-title": ["New England Journal of Medicine"],
        issued: { "date-parts": [[2022, 1, 27]] },
        volume: "386",
        issue: "4",
        page: "351-363",
      };
    }
    return null;
  },
  async byBibliographic(query) {
    if (query === "B-Cell Lymphomas") {
      return {
        DOI: "10.1007/bad-match",
        type: "book-chapter",
        title: ["Cutaneous T-Cell Lymphomas and Rare T-Cell Non-Hodgkin Lymphomas"],
        issued: { "date-parts": [[2026]] },
        score: 1,
      };
    }
    return null;
  },
};

test("extracts structured OpenEvidence citations and answer text", () => {
  const article = makeArticle();
  const answer = extractAnswerText(article);
  assert.equal(answer?.startsWith("Per the **NCCN"), true);

  const citations = extractCitations(article, answer ?? "");
  assert.equal(citations.length, 2);
  assert.deepEqual(
    citations.map((citation) => citation.title),
    [
      "B-Cell Lymphomas",
      "Polatuzumab Vedotin in Previously Untreated Diffuse Large B-Cell Lymphoma",
    ],
  );
  assert.equal(citations[1].doi, "10.1056/nejmoa2115304");
});

test("validates DOI citations and rejects low-similarity Crossref title candidates", async () => {
  const citations = extractCitations(makeArticle());
  const validated = await validateCitationsWithCrossref(citations, undefined, mockLookup);

  assert.equal(validated[0].crossref?.status, "not_found");
  assert.equal(validated[0].crossref?.similarity, 0.25);
  assert.equal(validated[1].crossref?.status, "validated");

  const bib = citationsToBibTeX(validated);
  assert.match(bib, /@misc\{NationalComprehensiveCancerNetwork2026B,/);
  assert.match(bib, /title = \{B-Cell Lymphomas\}/);
  assert.doesNotMatch(bib, /Cutaneous T-Cell Lymphomas/);
  assert.match(bib, /@article\{TillyH2022Polatuzumab,/);
  assert.match(bib, /doi = \{10\.1056\/nejmoa2115304\}/);
});

test("saves article, answer, citations, BibTeX, and validation artifacts", async () => {
  const artifactRoot = await mkdtemp(path.join(tmpdir(), "oe-citations-test-"));
  try {
    const config: AppConfig = {
      baseUrl: "https://www.openevidence.com",
      cookiesPath: path.join(artifactRoot, "cookies.json"),
      artifactDir: artifactRoot,
      crossrefValidate: true,
      pollIntervalMs: 1200,
      pollTimeoutMs: 180000,
    };

    const artifacts = await saveArticleArtifacts(makeArticle(), config, {
      validateWithCrossref: true,
      crossrefLookup: mockLookup,
    });

    assert.equal(artifacts.citationCount, 2);
    assert.equal(artifacts.crossrefValidatedCount, 1);
    assert.match(artifacts.bibtex ?? "", /@article\{TillyH2022Polatuzumab,/);
    assert.match(await readFile(artifacts.answerPath, "utf8"), /POLARIX/);
    assert.match(await readFile(artifacts.bibPath, "utf8"), /@article\{TillyH2022Polatuzumab,/);
    assert.equal(
      JSON.parse(await readFile(artifacts.crossrefValidationPath, "utf8"))[0].crossref.status,
      "not_found",
    );
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

function makeArticle(): Record<string, unknown> {
  return {
    id: "test-article",
    output: {
      structured_article: {
        raw_text:
          "Per the **NCCN B-Cell Lymphomas Guidelines (v3.2026)**, R-CHOP and Pola-R-CHP are preferred.[15][40]\n\nThe POLARIX trial supports Pola-R-CHP.[40]",
        articlesection_set: [
          {
            articleparagraph_set: [
              {
                articlespan_set: [
                  {
                    text: "category 1",
                    citations: [
                      {
                        citation: "National Comprehensive Cancer Network. B-Cell Lymphomas.",
                        metadata: {
                          citation_detail: {
                            href: "https://www.nccn.org/professionals/physician_gls/pdf/b-cell.pdf",
                            title: "B-Cell Lymphomas",
                            repository: "NCCN Guidelines",
                            dt_published: "2026-03-12",
                            authors_string: "National Comprehensive Cancer Network",
                            publication_info_string: "Updated 2026-03-12",
                          },
                        },
                      },
                    ],
                  },
                  {
                    text: "POLARIX",
                    citations: [
                      {
                        citation:
                          'Tilly H, Morschhauser F, Sehn LH, et al. <a target="_blank" href="https://www.nejm.org/doi/full/10.1056/NEJMoa2115304">Polatuzumab Vedotin in Previously Untreated Diffuse Large B-Cell Lymphoma</a>. The New England Journal of Medicine. 2022;386(4):351-363. doi:10.1056/NEJMoa2115304.',
                        metadata: {
                          citation_detail: {
                            doi: "10.1056/NEJMoa2115304",
                            href: "https://www.nejm.org/doi/full/10.1056/NEJMoa2115304",
                            pmid: 34904799,
                            title:
                              "Polatuzumab Vedotin in Previously Untreated Diffuse Large B-Cell Lymphoma",
                            repository: "NEJM",
                            dt_published: "2022-01-27T00:00:00+00:00",
                            journal_name: "The New England Journal of Medicine",
                            authors_string: "Tilly H, Morschhauser F, Sehn LH, et al.",
                            publication_info_string:
                              "The New England Journal of Medicine. 2022;386(4):351-363. doi:10.1056/NEJMoa2115304.",
                          },
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  };
}
