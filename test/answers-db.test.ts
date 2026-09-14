import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { AnswersDb, type AnswerRecord } from "../src/answers-db.js";

function tempDb(): { db: AnswersDb; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "oe-answers-db-"));
  return { db: AnswersDb.open(path.join(dir, "db", "oe.sqlite")), dir };
}

function rec(overrides: Partial<AnswerRecord> = {}): AnswerRecord {
  return {
    account: "doc@example.com",
    articleId: "11111111-1111-1111-1111-111111111111",
    title: "Stage III Colon Cancer Treatment",
    question: "What is the standard adjuvant therapy for stage III colon cancer?",
    answerMarkdown: "FOLFOX or CAPEOX is the standard adjuvant therapy.",
    citationsJson: JSON.stringify([{ key: "a", title: "IDEA Collaboration" }]),
    figuresJson: JSON.stringify([]),
    followUpJson: JSON.stringify(["How does this differ in elderly patients?"]),
    articleType: "Ask OpenEvidence Light with citations",
    status: "success",
    datetimeCreated: "2026-07-12T02:24:16Z",
    fetchedAt: "2026-07-12T03:00:00Z",
    ...overrides,
  };
}

test("upsert + getByArticleId round-trips a record", () => {
  const { db, dir } = tempDb();
  try {
    db.upsert(rec());
    const got = db.getByArticleId("doc@example.com", "11111111-1111-1111-1111-111111111111");
    assert.ok(got);
    assert.equal(got.account, "doc@example.com");
    assert.equal(got.status, "success");
    assert.match(got.answerMarkdown ?? "", /FOLFOX/);
    assert.deepEqual(JSON.parse(got.followUpJson ?? "[]"), [
      "How does this differ in elderly patients?",
    ]);
    assert.equal(db.count(), 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upsert same (account, article_id) replaces instead of duplicating", () => {
  const { db, dir } = tempDb();
  try {
    db.upsert(rec());
    db.upsert(rec({ answerMarkdown: "Updated: CAPEOX 3 months for low-risk." }));
    assert.equal(db.count(), 1);
    const got = db.getByArticleId("doc@example.com", "11111111-1111-1111-1111-111111111111");
    assert.match(got?.answerMarkdown ?? "", /Updated/);
    // FTS index must follow the update (AFTER UPDATE trigger), not keep stale text.
    assert.equal(db.search("doc@example.com", "FOLFOX").length, 0);
    assert.equal(db.search("doc@example.com", "CAPEOX").length, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search matches question, title, and answer body with snippets", () => {
  const { db, dir } = tempDb();
  try {
    db.upsert(rec());
    db.upsert(
      rec({
        articleId: "22222222-2222-2222-2222-222222222222",
        title: "Multiple Myeloma Induction",
        question: "First-line treatment for transplant-eligible NDMM?",
        answerMarkdown: "Quadruplet induction with daratumumab-VRd, then ASCT.",
      }),
    );
    assert.equal(db.count(), 2);

    const byBody = db.search("doc@example.com", "daratumumab");
    assert.equal(byBody.length, 1);
    assert.equal(byBody[0].articleId, "22222222-2222-2222-2222-222222222222");
    assert.match(byBody[0].snippet, /»daratumumab«/);

    const byQuestion = db.search("doc@example.com", "adjuvant colon");
    assert.equal(byQuestion.length, 1);
    assert.equal(byQuestion[0].articleId, "11111111-1111-1111-1111-111111111111");

    const byTitle = db.search("doc@example.com", "myeloma");
    assert.equal(byTitle.length, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search survives FTS5 syntax landmines via quoted-token fallback", () => {
  const { db, dir } = tempDb();
  try {
    db.upsert(rec({ answerMarkdown: 'Dose is 5-FU/leucovorin ("de Gramont").' }));
    // Unbalanced quote + stray operators would throw in raw FTS5 MATCH.
    assert.doesNotThrow(() => db.search("doc@example.com", 'de Gramont" AND ('));
    assert.equal(db.search("doc@example.com", "leucovorin").length, 1);
    assert.deepEqual(db.search("doc@example.com", "   "), []);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getByArticleId returns null for unknown ids", () => {
  const { db, dir } = tempDb();
  try {
    assert.equal(
      db.getByArticleId("doc@example.com", "99999999-9999-9999-9999-999999999999"),
      null,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cached answers and search results are isolated by account", () => {
  const { db, dir } = tempDb();
  try {
    const articleId = "11111111-1111-1111-1111-111111111111";
    db.upsert(rec({ account: "a@example.com", answerMarkdown: "private alpha finding" }));
    db.upsert(rec({ account: "b@example.com", answerMarkdown: "private beta finding" }));

    assert.match(db.getByArticleId("a@example.com", articleId)?.answerMarkdown ?? "", /alpha/);
    assert.match(db.getByArticleId("b@example.com", articleId)?.answerMarkdown ?? "", /beta/);
    assert.equal(db.search("a@example.com", "beta").length, 0);
    assert.equal(db.search("b@example.com", "alpha").length, 0);
    assert.deepEqual(db.accounts(), [
      { account: "a@example.com", count: 1 },
      { account: "b@example.com", count: 1 },
    ]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ask log: lastAskAt, asksSince, and per-account isolation", () => {
  const { db, dir } = tempDb();
  try {
    const now = 1_000_000_000_000;
    assert.equal(db.lastAskAt("a@x.com"), 0, "no asks yet → 0");

    db.recordAsk("a@x.com", now - 7_200_000); // 2h ago
    db.recordAsk("a@x.com", now - 1_800_000); // 30m ago
    db.recordAsk("a@x.com", now - 500); // just now
    db.recordAsk("b@y.com", now - 100); // other account

    assert.equal(db.lastAskAt("a@x.com"), now - 500, "latest ask wins");
    // Trailing hour for account a: the 30m + the just-now = 2 (the 2h-ago is out).
    assert.equal(db.asksSince("a@x.com", now - 3_600_000), 2);
    // Account isolation: b's ask does not count for a.
    assert.equal(db.asksSince("b@y.com", now - 3_600_000), 1);
    // Any-account count in the trailing hour = a's 2 + b's 1.
    assert.equal(db.asksSinceAny(now - 3_600_000), 3);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ask reservations serialize concurrent slots and can be cancelled", () => {
  const { db, dir } = tempDb();
  try {
    const now = 1_000_000;
    const first = db.reserveAsk("a@x.com", now, 1_000);
    const second = db.reserveAsk("a@x.com", now, 1_000);
    const otherAccount = db.reserveAsk("b@y.com", now, 1_000);
    assert.equal(first, now);
    assert.equal(second, now + 1_000);
    assert.equal(otherAccount, now);

    db.cancelAskReservation("a@x.com", second);
    assert.equal(db.lastAskAt("a@x.com"), first);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
