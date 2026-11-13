import test from "node:test";
import assert from "node:assert/strict";

import type { AppConfig } from "../src/config.js";
import {
	OpenEvidenceClient,
	type RelayTransport,
} from "../src/openevidence-client.js";
import { DEFAULT_RATE_LIMIT_CONFIG } from "../src/rate-limit.js";
import { runLiveProbe } from "../src/doctor.js";
import { attachConnectedRelay } from "../src/relay-client.js";

function relayConfig(): AppConfig {
	return {
		baseUrl: "https://www.openevidence.com",
		cookiesPath: "/nonexistent/cookies.json", // must NOT be touched in relay mode
		fingerprintPath: undefined,
		artifactDir: "/tmp",
		crossrefValidate: false,
		pollIntervalMs: 10,
		pollTimeoutMs: 1000,
		relayEnabled: true,
		relayPort: 8787,
		relayTransport: "all",
		rateLimit: DEFAULT_RATE_LIMIT_CONFIG,
	};
}

test("client routes through the relay (no cookies) when one is connected", async () => {
	const calls: { method: string; path: string; body?: string }[] = [];
	const transport: RelayTransport = {
		isConnected: () => true,
		request: async (req) => {
			calls.push(req);
			if (req.path === "/api/auth/me") {
				return { status: 200, body: JSON.stringify({ user: "me" }) };
			}
			if (req.path.startsWith("/api/article/list")) {
				return {
					status: 200,
					body: JSON.stringify({ results: [{ id: "a1" }] }),
				};
			}
			return { status: 200, body: "{}" };
		},
	};

	const client = new OpenEvidenceClient(relayConfig());
	client.useRelay(transport);
	await client.init(); // must succeed without reading the (nonexistent) cookie file

	const auth = await client.getAuthStatus();
	assert.equal(auth.authenticated, true);

	const hist = (await client.listHistory(5, 0)) as {
		results: { id: string }[];
	};
	assert.deepEqual(hist.results, [{ id: "a1" }]);

	assert.ok(calls.some((c) => c.method === "GET" && c.path === "/api/auth/me"));
	assert.ok(
		calls.some(
			(c) => c.method === "GET" && c.path.startsWith("/api/article/list"),
		),
	);
});

test("client POSTs the ask body through the relay verbatim", async () => {
	let seen: { method: string; path: string; body?: string } | undefined;
	const transport: RelayTransport = {
		isConnected: () => true,
		request: async (req) => {
			if (req.path === "/api/article" && req.method === "POST") {
				seen = req;
				return { status: 200, body: JSON.stringify({ id: "new-1" }) };
			}
			return { status: 200, body: "{}" };
		},
	};
	const client = new OpenEvidenceClient(relayConfig());
	client.useRelay(transport);
	await client.init();

	const created = await client.ask({ question: "what is sepsis" });
	assert.equal(created.id, "new-1");
	assert.ok(seen, "ask POST went through the relay");
	const body = JSON.parse(seen!.body ?? "{}") as {
		inputs?: { question?: string };
	};
	assert.equal(body.inputs?.question, "what is sepsis");
});

function fakeRelay(authStatus: number): RelayTransport {
	return {
		isConnected: () => true,
		request: async (req) => {
			if (req.path === "/api/auth/me") {
				return {
					status: authStatus,
					body: authStatus === 200 ? JSON.stringify({ email: "a@b" }) : "",
				};
			}
			return { status: 200, body: JSON.stringify({ results: [] }) };
		},
	};
}

test("doctor live probe goes through the relay, not the (stale/absent) cookie file", async () => {
	const checks = await runLiveProbe(relayConfig(), fakeRelay(200));
	assert.deepEqual(
		checks.map((c) => [c.level, c.code]),
		[
			["pass", "auth"],
			["pass", "datadome-live"],
		],
	);
	assert.match(checks[0].message, /via relay/);
});

test("doctor live probe via relay points a logged-out tab at the browser, not cookies", async () => {
	const checks = await runLiveProbe(relayConfig(), fakeRelay(204));
	assert.equal(checks.length, 1);
	assert.equal(checks[0].level, "fail");
	assert.match(checks[0].hint ?? "", /Sign in to openevidence\.com/);
	assert.doesNotMatch(checks[0].hint ?? "", /cookies\.json/);
});

test("attachConnectedRelay never spawns: null when disabled or nothing listens", async () => {
	assert.equal(
		await attachConnectedRelay({ ...relayConfig(), relayEnabled: false }),
		null,
	);
	assert.equal(
		await attachConnectedRelay({ ...relayConfig(), relayTransport: "off" }),
		null,
	);
	// Port 9 (discard) has no relay; a spawn here would leak a daemon.
	assert.equal(
		await attachConnectedRelay({ ...relayConfig(), relayPort: 9 }),
		null,
	);
});
