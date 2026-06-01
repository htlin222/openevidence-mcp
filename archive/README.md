# archive/ — superseded approaches

This directory holds code that no longer works against the live OpenEvidence
service, kept for reference so the approach (and *why it fails*) isn't
re-attempted. It is **excluded from the build** (`tsconfig.json` → `exclude`)
and **not published to npm** (not in `package.json` → `files`).

## `node-fetch-ask.ts` — pure Node `fetch` ask submission

The original ask path issued `POST /api/article` directly from Node's `fetch`
with a real browser **header fingerprint** (captured from a HAR, see
`src/fingerprint.ts`) and a valid exported cookie jar including the `datadome`
cookie.

**It does not work.** `POST /api/article` is gated by DataDome's anti-bot
layer, which returns **HTTP 403** regardless of headers or cookies. We verified
this exhaustively:

| Variable | Tried | POST result |
|----------|-------|-------------|
| Login session | valid (auth 200) | — |
| Header fingerprint | default → HAR-derived Brave/macOS | 403 |
| Server process | stale → freshly respawned | 403 |
| `cookies.json` | refreshed in-browser, reloaded, valid `datadome` token | 403 |
| GET `/api/article/list` | same cookies/headers | ✅ 200 |

A valid DataDome cookie + a real captured header set still gets a write-path
403, while GET endpoints pass. The signal being scored is what Node's `fetch`
(undici) cannot fake: the **TLS/JA3 + HTTP-2 fingerprint**. Header
fingerprinting is necessary for the GET paths but **not sufficient** for the
POST.

### What replaced it

The working ask path issues the *same* request from inside a real browser tab
attached over the Chrome DevTools Protocol, so it rides the browser's genuine
TLS/H2 stack and live DataDome JS state:

- `src/browser-ask.ts` — the browser transport (`submitAskViaBrowser`).
- `src/openevidence-client.ts` → `ask()` — tries Node `fetch` first and falls
  back to the browser path on `DataDomeChallengeError` (configurable; can be
  forced browser-first with `OE_MCP_ASK_VIA_BROWSER=1`).
- `src/playwright-ask.ts` — standalone CLI (`npm run pw-ask`).

The live client still *attempts* the Node POST first only so it can detect the
DataDome challenge and fall back; it is never expected to succeed on its own.
