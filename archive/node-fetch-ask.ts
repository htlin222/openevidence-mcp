/**
 * ARCHIVED — DOES NOT WORK. Reference only. Excluded from build & npm package.
 *
 * Original pure-Node `fetch` ask submission. POST /api/article is DataDome-gated
 * and returns HTTP 403 from Node regardless of headers or a valid `datadome`
 * cookie, because DataDome scores the TLS/JA3 + HTTP-2 fingerprint that Node's
 * fetch cannot reproduce. See ./README.md for the full investigation.
 *
 * Superseded by src/browser-ask.ts (submitAskViaBrowser) + the auto-fallback in
 * src/openevidence-client.ts → ask(). This snapshot is kept so the approach and
 * its failure mode stay documented in the tree.
 *
 * This is a self-contained illustration; it intentionally does not import from
 * src/ (those modules have moved on).
 */

interface ArchivedAskPayload {
  question: string;
  articleType?: string;
  variantConfigurationFile?: string;
  personalizationEnabled?: boolean;
  disableCaching?: boolean;
  originalArticleId?: string;
}

const DEFAULT_ARTICLE_TYPE = "Ask OpenEvidence Light with citations";

/**
 * Issues POST /api/article over Node `fetch` with a real browser header
 * fingerprint and the exported cookie jar. In practice this resolves to a
 * DataDome 403 interstitial for the write path — that is the whole reason this
 * file is archived.
 */
async function archivedNodeAsk(
  baseUrl: string,
  cookieHeader: string,
  fingerprintHeaders: Array<[string, string]>,
  payload: ArchivedAskPayload,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    article_type: payload.articleType ?? DEFAULT_ARTICLE_TYPE,
    inputs: {
      variant_configuration_file: payload.variantConfigurationFile ?? "prod",
      attachments: [],
      question: payload.question,
      use_gatekeeper: true,
    },
    personalization_enabled: payload.personalizationEnabled ?? false,
    disable_caching: payload.disableCaching ?? false,
  };
  if (payload.originalArticleId) {
    body.original_article = payload.originalArticleId;
  }

  const headers = new Headers(fingerprintHeaders);
  headers.set("content-type", "application/json");
  headers.set("cookie", cookieHeader);

  const res = await fetch(new URL("/api/article", baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (res.status === 403) {
    // DataDome interstitial. No client-side bypass from Node — the request must
    // originate from a real browser (see src/browser-ask.ts).
    const snippet = (await res.text()).slice(0, 200);
    throw new Error(`DataDome bot-protection challenge on POST /api/article (403): ${snippet}`);
  }
  if (!res.ok) {
    throw new Error(`POST /api/article failed with status ${res.status}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

export { archivedNodeAsk };
