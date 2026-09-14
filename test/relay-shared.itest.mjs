// Integration test for the shared relay daemon + client, on an alternate port so
// it never disturbs the live 8787 relay. Run: node test/relay-shared.itest.mjs
import { readFileSync } from "node:fs";
import { createServer } from "node:net";

async function reserveFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not reserve test port");
  await new Promise((resolve) => server.close(resolve));
  return String(address.port);
}

const PORT = process.env.ITEST_PORT ?? (await reserveFreePort());
process.env.OE_MCP_RELAY_PORT = PORT;
process.env.OE_MCP_RELAY_PID_PATH = `/tmp/oe-itest-relay-${PORT}.pid`;
process.env.OE_MCP_RELAY_LOG_PATH = `/tmp/oe-itest-relay-${PORT}.log`;

const { resolveConfig, ensureConfigDirs } = await import("../dist/config.js");
const { connectSharedRelay } = await import("../dist/relay-client.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXTENSION_HEADERS = {
  origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
  "x-openevidence-relay-client": "extension-v2:00000000-0000-4000-8000-000000000001",
};
let pass = 0;
let fail = 0;
const ok = (name) => { pass += 1; console.log(`  ok  - ${name}`); };
const bad = (name, detail) => { fail += 1; console.log(`  NOT ok - ${name}: ${detail}`); };

// A minimal stand-in for the browser extension: long-poll, echo the path back.
let extRunning = true;
let served = 0;
async function fakeExtension(port) {
  while (extRunning) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/poll`, { headers: EXTENSION_HEADERS });
      if (res.status === 200) {
        const { reqId, req } = await res.json();
        served += 1;
        await fetch(`http://127.0.0.1:${port}/result`, {
          method: "POST",
          headers: { "content-type": "application/json", ...EXTENSION_HEADERS },
          body: JSON.stringify({ reqId, status: 200, body: JSON.stringify({ echo: req.path }) }),
        });
      }
    } catch {
      await sleep(300); // daemon bounced — reconnect to the same port
    }
  }
}

function killByPidfile() {
  try {
    const pid = parseInt(readFileSync(process.env.OE_MCP_RELAY_PID_PATH, "utf8").trim(), 10);
    process.kill(pid, "SIGTERM");
    return pid;
  } catch {
    return null;
  }
}

async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`);
    return await r.json();
  } catch {
    return null;
  }
}

async function main() {
  const config = resolveConfig();
  ensureConfigDirs(config);
  killByPidfile(); // clear any leftover from a previous run
  await sleep(300);

  // 1) connectSharedRelay spawns the daemon from absent.
  const client = await connectSharedRelay(config);
  if (!client) return bad("connect", "returned null");
  ok("connectSharedRelay spawned a daemon and returned a client");

  const h = await health(PORT);
  if (h && h.version === 2 && typeof h.pid === "number") ok(`/health reports version=2 pid=${h.pid}`);
  else bad("/health", JSON.stringify(h));

  // 2) Bring the fake extension online; isConnected() should flip true.
  void fakeExtension(PORT);
  for (let i = 0; i < 20 && !client.isConnected(); i += 1) await sleep(150);
  if (client.isConnected()) ok("isConnected() true once the extension polls");
  else bad("isConnected", "never became connected");

  // 3) Round-trip a request through the daemon bridge.
  const r1 = await client.request({ method: "GET", path: "/api/auth/me" });
  if (r1.status === 200 && JSON.parse(r1.body).echo === "/api/auth/me") ok("request round-trips through /relay");
  else bad("round-trip", JSON.stringify(r1));

  // 4) Guardrail 1: kill the daemon, then a request must self-heal (respawn + retry).
  const oldPid = killByPidfile();
  for (let i = 0; i < 20 && (await health(PORT)); i += 1) await sleep(150); // wait for port to free
  const servedBefore = served;
  const r2 = await client.request({ method: "GET", path: "/api/auth/me" });
  if (r2.status === 200 && JSON.parse(r2.body).echo === "/api/auth/me") {
    ok("request self-heals after the daemon is killed (respawn + retry)");
  } else {
    bad("self-heal", JSON.stringify(r2));
  }
  const h2 = await health(PORT);
  if (h2 && typeof h2.pid === "number" && h2.pid !== oldPid) ok(`a fresh daemon (pid ${h2.pid}) replaced the killed one (pid ${oldPid})`);
  else bad("respawn-pid", JSON.stringify(h2));
  if (served > servedBefore) ok("the fresh daemon served the retried request via the extension");
  else bad("served-count", `served did not advance (${served})`);

  // Cleanup.
  extRunning = false;
  client.close();
  killByPidfile();
  await sleep(300);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
