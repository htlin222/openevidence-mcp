import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  citationsToBibTeX,
  extractCitations,
  extractFigures,
  saveArticleArtifacts,
  validateCitationsWithCrossref,
  type CrossrefLookup,
} from "../src/citations.js";
import type { AppConfig } from "../src/config.js";
import {
  extractAnswerText,
  extractFiguresFromText,
  resolveVisualTags,
} from "../src/openevidence-client.js";

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

    // figures.json should exist with extracted figures
    assert.equal(artifacts.figureCount, 2);
    const figuresJson = JSON.parse(await readFile(artifacts.figuresJsonPath, "utf8"));
    assert.equal(figuresJson.length, 2);
    assert.equal(figuresJson[0].name, "FOLL-A");
    assert.equal(figuresJson[1].name, "Figure 1");

    // answer.md should have resolved <visual> tags
    const answerMd = await readFile(artifacts.answerPath, "utf8");
    assert.match(answerMd, /!\[FOLL-A: Follicular Lymphoma Algorithm/);
    assert.doesNotMatch(answerMd, /<visual>FOLL-A/);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("extractFiguresFromText parses PublicationFigure REACTCOMPONENT blocks", () => {
  const text = [
    "Some text before",
    'REACTCOMPONENT!:!PublicationFigure!:!{"url":"https://example.com/fig1.jpg","name":"FIG-1","caption":"First figure"}',
    "Middle text",
    'REACTCOMPONENT!:!Thinking!:!{"content":"ignore me"}',
    'REACTCOMPONENT!:!PublicationFigure!:!{"url":"https://example.com/fig2.jpg","name":"FIG-2"}',
    "",
  ].join("\n");

  const figures = extractFiguresFromText(text);
  assert.equal(figures.length, 2);
  assert.equal(figures[0].name, "FIG-1");
  assert.equal(figures[0].url, "https://example.com/fig1.jpg");
  assert.equal(figures[0].caption, "First figure");
  assert.equal(figures[1].name, "FIG-2");
  assert.equal(figures[1].caption, undefined);
});

test("resolveVisualTags replaces tags with markdown images", () => {
  const text = "See <visual>CERV-7[34]</visual> and <visual>Unknown[99]</visual> for details.";
  const figures = [
    { name: "CERV-7", url: "https://example.com/cerv7.jpg", caption: "Cervical Algorithm" },
  ];

  const resolved = resolveVisualTags(text, figures);
  assert.match(resolved, /!\[CERV-7: Cervical Algorithm\]\(https:\/\/example\.com\/cerv7\.jpg\)/);
  assert.match(resolved, /<visual>Unknown\[99\]<\/visual>/); // unresolved tag stays
});

test("extractFigures collects from both citation metadata and REACTCOMPONENT blocks", () => {
  const figures = extractFigures(makeArticle());
  assert.equal(figures.length, 2);
  assert.equal(figures[0].name, "FOLL-A");
  assert.equal(figures[0].url, "https://storage.googleapis.com/nccn_images/b-cell/page_5.jpg");
  assert.equal(figures[1].name, "Figure 1");
  assert.equal(figures[1].url, "https://example.com/figure1.jpg");
});

function makeArticle(): Record<string, unknown> {
  return {
    id: "test-article",
    output: {
      text: [
        'REACTCOMPONENT!:!Thinking!:!{"content":"planning"}',
        "",
        "",
        "",
        "Some answer text.",
        'REACTCOMPONENT!:!PublicationFigure!:!{"url":"https://example.com/figure1.jpg","name":"Figure 1","caption":"Overall Survival"}',
      ].join("\n"),
      structured_article: {
        raw_text:
          "Per the **NCCN B-Cell Lymphomas Guidelines (v3.2026)**, see <visual>FOLL-A[15]</visual> for the algorithm. R-CHOP and Pola-R-CHP are preferred.[15][40]\n\nThe POLARIX trial supports Pola-R-CHP.[40]",
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
                          content_metadata: {
                            figures: [
                              {
                                url: "https://storage.googleapis.com/nccn_images/b-cell/page_5.jpg",
                                name: "FOLL-A",
                                caption: "Follicular Lymphoma Algorithm",
                              },
                            ],
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
