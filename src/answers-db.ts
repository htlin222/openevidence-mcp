import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Local store for fetched answers, in the same SQLite file the Python
 * collection-sort CLI mirrors chats/collections into (~/.openevidence-mcp/db/
 * oe.sqlite). The `chats` table only carries list-API metadata; this adds the
 * answer bodies so they survive tmpdir cleanup, are full-text searchable
 * (FTS5), and let oe_article_get answer from disk instead of the relay.
 *
 * Keyed (account, article_id) to match the Python schema's account dimension —
 * account is the login email (or auth sub), same as collection_sort.py.
 * Python's migrate() only rebuilds its own tables, so adding ours is safe.
 */

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS answers (
  account           TEXT NOT NULL,
  article_id        TEXT NOT NULL,
  title             TEXT,
  question          TEXT,
  answer_markdown   TEXT,
  citations_json    TEXT,
  figures_json      TEXT,
  follow_up_json    TEXT,
  article_type      TEXT,
  status            TEXT,
  datetime_created  TEXT,
  fetched_at        TEXT NOT NULL,
  PRIMARY KEY (account, article_id)
);
CREATE INDEX IF NOT EXISTS answers_article ON answers(article_id);

CREATE VIRTUAL TABLE IF NOT EXISTS answers_fts USING fts5(
  question, title, answer_markdown,
  content='answers', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS answers_fts_ai AFTER INSERT ON answers BEGIN
  INSERT INTO answers_fts(rowid, question, title, answer_markdown)
  VALUES (new.rowid, new.question, new.title, new.answer_markdown);
END;
CREATE TRIGGER IF NOT EXISTS answers_fts_ad AFTER DELETE ON answers BEGIN
  INSERT INTO answers_fts(answers_fts, rowid, question, title, answer_markdown)
  VALUES ('delete', old.rowid, old.question, old.title, old.answer_markdown);
END;
CREATE TRIGGER IF NOT EXISTS answers_fts_au AFTER UPDATE ON answers BEGIN
  INSERT INTO answers_fts(answers_fts, rowid, question, title, answer_markdown)
  VALUES ('delete', old.rowid, old.question, old.title, old.answer_markdown);
  INSERT INTO answers_fts(rowid, question, title, answer_markdown)
  VALUES (new.rowid, new.question, new.title, new.answer_markdown);
END;

-- One row per submitted ask (POST /api/article), shared across all MCP sessions
-- so they cooperatively pace against OpenEvidence's per-account question limit.
CREATE TABLE IF NOT EXISTS ask_log (
  account   TEXT NOT NULL,
  asked_at  INTEGER NOT NULL  -- ms epoch
);
CREATE INDEX IF NOT EXISTS ask_log_at ON ask_log(account, asked_at);
`;

export interface AnswerRecord {
  account: string;
  articleId: string;
  title: string | null;
  question: string | null;
  answerMarkdown: string | null;
  citationsJson: string | null;
  figuresJson: string | null;
  followUpJson: string | null;
  articleType: string | null;
  status: string | null;
  datetimeCreated: string | null;
  fetchedAt: string;
}

export interface AnswerSearchHit {
  articleId: string;
  account: string;
  title: string | null;
  question: string | null;
  snippet: string;
  datetimeCreated: string | null;
  fetchedAt: string;
}

export class AnswersDb {
  private constructor(private readonly db: DatabaseSync) {}

  static open(dbPath: string): AnswersDb {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    // WAL + busy timeout so we coexist with the Python CLI writing the same file.
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=3000");
    db.exec(SCHEMA_SQL);
    // Additive migration: earlier builds created `answers` without follow_up_json.
    const cols = db.prepare("PRAGMA table_info(answers)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "follow_up_json")) {
      db.exec("ALTER TABLE answers ADD COLUMN follow_up_json TEXT");
    }
    return new AnswersDb(db);
  }

  upsert(rec: AnswerRecord): void {
    this.db
      .prepare(
        `INSERT INTO answers (account, article_id, title, question, answer_markdown,
           citations_json, figures_json, follow_up_json, article_type, status,
           datetime_created, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account, article_id) DO UPDATE SET
           title = excluded.title,
           question = excluded.question,
           answer_markdown = excluded.answer_markdown,
           citations_json = excluded.citations_json,
           figures_json = excluded.figures_json,
           follow_up_json = excluded.follow_up_json,
           article_type = excluded.article_type,
           status = excluded.status,
           datetime_created = excluded.datetime_created,
           fetched_at = excluded.fetched_at`,
      )
      .run(
        rec.account,
        rec.articleId,
        rec.title,
        rec.question,
        rec.answerMarkdown,
        rec.citationsJson,
        rec.figuresJson,
        rec.followUpJson,
        rec.articleType,
        rec.status,
        rec.datetimeCreated,
        rec.fetchedAt,
      );
  }

  /** Account-scoped lookup: locally cached clinical content must never cross logins. */
  getByArticleId(account: string, articleId: string): AnswerRecord | null {
    const row = this.db
      .prepare(
        `SELECT account, article_id, title, question, answer_markdown, citations_json,
           figures_json, follow_up_json, article_type, status, datetime_created, fetched_at
         FROM answers WHERE account = ? AND article_id = ? LIMIT 1`,
      )
      .get(account, articleId) as Record<string, string | null> | undefined;
    return row ? rowToRecord(row) : null;
  }

  search(account: string, query: string, limit = 10): AnswerSearchHit[] {
    const sql = `SELECT a.account, a.article_id, a.title, a.question, a.datetime_created, a.fetched_at,
        snippet(answers_fts, 2, '»', '«', ' … ', 24) AS snip
      FROM answers_fts
      JOIN answers a ON a.rowid = answers_fts.rowid
      WHERE answers_fts MATCH ? AND a.account = ?
      ORDER BY bm25(answers_fts) LIMIT ?`;
    const run = (match: string) =>
      this.db.prepare(sql).all(match, account, limit) as Record<string, string | null>[];
    let rows: Record<string, string | null>[];
    try {
      rows = run(query);
    } catch {
      // Raw query tripped FTS5 syntax (unbalanced quotes, stray operators…):
      // retry with every token quoted, which searches the literal terms.
      const quoted = query
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => `"${t.replaceAll('"', '""')}"`)
        .join(" ");
      if (!quoted) return [];
      rows = run(quoted);
    }
    return rows.map((r) => ({
      articleId: String(r.article_id),
      account: String(r.account),
      title: r.title ?? null,
      question: r.question ?? null,
      snippet: String(r.snip ?? ""),
      datetimeCreated: r.datetime_created ?? null,
      fetchedAt: String(r.fetched_at ?? ""),
    }));
  }

  count(account?: string): number {
    const row = (account
      ? this.db.prepare("SELECT COUNT(*) AS n FROM answers WHERE account = ?").get(account)
      : this.db.prepare("SELECT COUNT(*) AS n FROM answers").get()) as { n: number };
    return row.n;
  }

  accounts(): { account: string; count: number }[] {
    const rows = this.db
      .prepare("SELECT account, COUNT(*) AS count FROM answers GROUP BY account ORDER BY account")
      .all() as { account: string; count: number }[];
    return rows.map((row) => ({ account: String(row.account), count: Number(row.count) }));
  }

  // ---- ask pacing (per-account question-rate cooperation) ---------------------

  /** Epoch-ms of the most recent recorded ask for this account, or 0 if none. */
  lastAskAt(account: string): number {
    const row = this.db
      .prepare("SELECT MAX(asked_at) AS m FROM ask_log WHERE account = ?")
      .get(account) as { m: number | null } | undefined;
    return row?.m ?? 0;
  }

  /** How many asks this account submitted in the trailing `windowMs`. */
  asksSince(account: string, sinceMs: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM ask_log WHERE account = ? AND asked_at >= ?")
      .get(account, sinceMs) as { n: number };
    return row.n;
  }

  /** How many asks on this machine (any account) since `sinceMs`. */
  asksSinceAny(sinceMs: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM ask_log WHERE asked_at >= ?")
      .get(sinceMs) as { n: number };
    return row.n;
  }

  /** Record an ask at `atMs` and opportunistically prune rows older than a day. */
  recordAsk(account: string, atMs: number): void {
    this.db.prepare("INSERT INTO ask_log (account, asked_at) VALUES (?, ?)").run(account, atMs);
    this.db
      .prepare("DELETE FROM ask_log WHERE asked_at < ?")
      .run(atMs - 24 * 60 * 60 * 1000);
  }

  /**
   * Atomically reserve the next per-account ask slot across MCP processes.
   * A future timestamp is intentional: later reservers queue behind it instead
   * of all observing the same last ask and waking at once.
   */
  reserveAsk(account: string, nowMs: number, minIntervalMs: number): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const reservedAt = Math.max(nowMs, this.lastAskAt(account) + minIntervalMs);
      this.db.prepare("INSERT INTO ask_log (account, asked_at) VALUES (?, ?)").run(account, reservedAt);
      this.db.prepare("DELETE FROM ask_log WHERE asked_at < ?").run(nowMs - 24 * 60 * 60 * 1000);
      this.db.exec("COMMIT");
      return reservedAt;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Release a slot when account revalidation prevents the POST from happening. */
  cancelAskReservation(account: string, reservedAt: number): void {
    this.db
      .prepare("DELETE FROM ask_log WHERE account = ? AND asked_at = ?")
      .run(account, reservedAt);
  }

  close(): void {
    this.db.close();
  }
}

function rowToRecord(row: Record<string, string | null>): AnswerRecord {
  return {
    account: String(row.account),
    articleId: String(row.article_id),
    title: row.title ?? null,
    question: row.question ?? null,
    answerMarkdown: row.answer_markdown ?? null,
    citationsJson: row.citations_json ?? null,
    figuresJson: row.figures_json ?? null,
    followUpJson: row.follow_up_json ?? null,
    articleType: row.article_type ?? null,
    status: row.status ?? null,
    datetimeCreated: row.datetime_created ?? null,
    fetchedAt: String(row.fetched_at ?? ""),
  };
}
