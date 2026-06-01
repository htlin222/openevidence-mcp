import test from "node:test";
import assert from "node:assert/strict";

import { buildAskRequestBody } from "../src/openevidence-client.js";

test("buildAskRequestBody applies defaults", () => {
  const body = buildAskRequestBody({ question: "what is sepsis?" });
  assert.equal(body.article_type, "Ask OpenEvidence Light with citations");
  assert.equal(body.personalization_enabled, false);
  assert.equal(body.disable_caching, false);
  assert.ok(!("original_article" in body));

  const inputs = body.inputs as Record<string, unknown>;
  assert.equal(inputs.question, "what is sepsis?");
  assert.equal(inputs.variant_configuration_file, "prod");
  assert.equal(inputs.use_gatekeeper, true);
  assert.deepEqual(inputs.attachments, []);
});

test("buildAskRequestBody honors overrides and follow-up id", () => {
  const body = buildAskRequestBody({
    question: "follow up",
    articleType: "AskOE Deep Research",
    variantConfigurationFile: "staging",
    personalizationEnabled: true,
    disableCaching: true,
    originalArticleId: "ffb2016f-ffe9-4635-90ba-66846141828e",
  });
  assert.equal(body.article_type, "AskOE Deep Research");
  assert.equal(body.personalization_enabled, true);
  assert.equal(body.disable_caching, true);
  assert.equal(body.original_article, "ffb2016f-ffe9-4635-90ba-66846141828e");

  const inputs = body.inputs as Record<string, unknown>;
  assert.equal(inputs.variant_configuration_file, "staging");
});
