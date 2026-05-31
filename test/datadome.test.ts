import test from "node:test";
import assert from "node:assert/strict";

import { DataDomeChallengeError, isDataDomeChallenge } from "../src/openevidence-client.js";

function headers(init: Record<string, string> = {}): Pick<Response, "headers"> {
  return { headers: new Headers(init) };
}

test("isDataDomeChallenge: detects captcha-delivery interstitial body", () => {
  const body = '{"url":"https://geo.captcha-delivery.com/interstitial/?initialCid=AHrl"}';
  assert.equal(isDataDomeChallenge(headers(), body), true);
});

test("isDataDomeChallenge: detects x-datadome header", () => {
  assert.equal(isDataDomeChallenge(headers({ "x-datadome": "protected" }), ""), true);
});

test("isDataDomeChallenge: detects datadome set-cookie", () => {
  assert.equal(
    isDataDomeChallenge(headers({ "set-cookie": "datadome=abc; Path=/" }), ""),
    true,
  );
});

test("isDataDomeChallenge: ignores an ordinary 403 body", () => {
  assert.equal(isDataDomeChallenge(headers(), '{"error":"forbidden: insufficient scope"}'), false);
});

test("DataDomeChallengeError: is a non-retryable 403 with actionable message", () => {
  const err = new DataDomeChallengeError("POST /api/article");
  assert.equal(err.status, 403);
  assert.equal(err.name, "DataDomeChallengeError");
  assert.match(err.message, /POST \/api\/article/);
  assert.match(err.message, /browser/i);
  assert.match(err.message, /cookies\.json/);
});
