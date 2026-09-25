import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseRelay } from "../src/relay-diagnosis.js";

const NOW = 1_000_000;

test("diagnose: daemon down", () => {
  const d = diagnoseRelay(null, { distVersion: "0.4.0", now: NOW });
  assert.equal(d.state, "down");
  assert.match(d.hint!, /not answering/);
});

test("diagnose: connected and versions agree → no hint", () => {
  const d = diagnoseRelay({ connected: true, extensionVersion: "0.4.0" }, { distVersion: "0.4.0", now: NOW });
  assert.equal(d.state, "connected");
  assert.equal(d.hint, null);
});

test("diagnose: connected but extension older than extension/dist → reload", () => {
  const d = diagnoseRelay({ connected: true, extensionVersion: "0.3.0" }, { distVersion: "0.4.0", now: NOW });
  assert.equal(d.state, "stale-extension");
  assert.match(d.hint!, /0\.3\.0/);
  assert.match(d.hint!, /0\.4\.0/);
  assert.match(d.hint!, /brave:\/\/extensions|chrome:\/\/extensions/);
});

test("diagnose: not connected, rejected within the last minute → say why", () => {
  const d = diagnoseRelay(
    { connected: false, lastRejectAt: NOW - 5_000, lastRejectReason: "paired extension channel required", lastRejectPath: "/poll" },
    { distVersion: "0.4.0", now: NOW },
  );
  assert.equal(d.state, "rejected");
  assert.match(d.hint!, /paired extension channel required/);
  assert.match(d.hint!, /Reload/);
});

test("diagnose: a recent rejection on a non-extension path is not the extension being refused", () => {
  const d = diagnoseRelay(
    { connected: false, lastRejectAt: NOW - 5_000, lastRejectReason: "browser origin not allowed", lastRejectPath: "/whatever" },
    { distVersion: "0.4.0", now: NOW },
  );
  assert.equal(d.state, "silent");
});

test("diagnose: a recent rejection on /result counts as the extension being refused", () => {
  const d = diagnoseRelay(
    { connected: false, lastRejectAt: NOW - 5_000, lastRejectReason: "request belongs to another extension", lastRejectPath: "/result" },
    { distVersion: "0.4.0", now: NOW },
  );
  assert.equal(d.state, "rejected");
  assert.match(d.hint!, /request belongs to another extension/);
});

test("diagnose: recent-rejection window is inclusive at 60 s and excludes older or future stamps", () => {
  const at = (lastRejectAt: number) =>
    diagnoseRelay(
      { connected: false, lastRejectAt, lastRejectReason: "paired extension channel required", lastRejectPath: "/poll" },
      { distVersion: "0.4.0", now: NOW },
    ).state;
  assert.equal(at(NOW - 60_000), "rejected");
  assert.equal(at(NOW - 60_001), "silent");
  assert.equal(at(NOW + 5_000), "silent");
});

test("diagnose: not connected, no recent rejection → extension is not polling", () => {
  const d = diagnoseRelay({ connected: false, lastRejectAt: NOW - 600_000 }, { distVersion: "0.4.0", now: NOW });
  assert.equal(d.state, "silent");
  assert.match(d.hint!, /not polling/);
});

test("diagnose: unknown versions never trigger the stale hint", () => {
  const d = diagnoseRelay({ connected: true, extensionVersion: null }, { distVersion: null, now: NOW });
  assert.equal(d.state, "connected");
});
