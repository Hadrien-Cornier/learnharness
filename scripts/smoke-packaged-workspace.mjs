/** Run a custom packaged app with its bundled server and a synthetic profile.
 * Usage: node scripts/smoke-packaged-workspace.mjs /path/App.app/Contents/MacOS/executable
 * The environment contains no credentials. The production app is never touched.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const executable = process.argv[2];
assert.ok(executable && fs.existsSync(executable), "Pass the packaged custom app executable.");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-packaged-workspace-"));
const profile = path.join(home, "profile");
const evidence = process.env.LH_WORKSPACE_EVIDENCE_DIR || path.join(os.tmpdir(), "lh-packaged-workspace-evidence");
fs.mkdirSync(evidence, { recursive: true });
fs.mkdirSync(path.join(profile, "data", "chats"), { recursive: true });
fs.writeFileSync(path.join(profile, "auth.json"), "{}\n", { mode: 0o600 });
const checks = [], failures = [];
let logs = "", browser, child;
async function until(check, message, timeout = 60000) {
 const start = Date.now();
 while (Date.now() - start < timeout) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 100)); }
 throw new Error(message);
}
async function stop() {
 if (!child || child.exitCode !== null || child.signalCode !== null) return;
 const closed = once(child, "exit"); child.kill("SIGTERM");
 const timer = setTimeout(() => child.kill("SIGKILL"), 5000); timer.unref(); await closed; clearTimeout(timer);
}
try {
 const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB8kAAAAASUVORK5CYII=";
 const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
 const assistant = (id, content, stopReason = "stop") => ({ id, role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "synthetic", timestamp: 1, stopReason, usage, content });
 const messages = [
  { id: "learner", role: "user", content: "Show the stored synthetic PNG.", timestamp: 0 },
  assistant("read_call", [{ type: "toolCall", id: "read_png", name: "read", arguments: { path: "/synthetic/fixture.png" } }], "toolUse"),
  { id: "read_result", role: "toolResult", toolCallId: "read_png", toolName: "read", content: [{ type: "text", text: "Stored synthetic image" }, { type: "image", mimeType: "image/png", data: png }], details: null, isError: false, timestamp: 2 },
  assistant("explanation", [{ type: "text", text: "The PNG uses stored attachment bytes. No source file exists or is read." }]),
 ];
 fs.writeFileSync(path.join(profile, "data", "chats", "packaged_png.json"), JSON.stringify({ version: 1, id: "packaged_png", title: "Packaged PNG fixture", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z", messages }));
 fs.writeFileSync(path.join(profile, "workspace-v1.json"), JSON.stringify({ version: 1, windows: [{ id: "packaged_window", panes: [{ id: "packaged_pane", sessionId: "packaged_png" }], activePaneId: "packaged_pane", split: .5, zoom: 1 }], views: {} }));
 const listener = net.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening"); const debug = listener.address().port; await new Promise(resolve => listener.close(resolve));
 child = spawn(path.resolve(executable), [`--remote-debugging-port=${debug}`, "--disable-background-networking", "--disable-sync"], {
  cwd: home, env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, LH_PROFILE_DIR: profile, LH_IGNORE_ENV_KEYS: "1", NEXT_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"],
 });
 const capture = value => { logs = (logs + value).slice(-30000); }; child.stdout.on("data", capture); child.stderr.on("data", capture);
 const endpoint = await until(async () => { try { return (await (await fetch(`http://127.0.0.1:${debug}/json/version`)).json()).webSocketDebuggerUrl; } catch { if (child.exitCode !== null) throw new Error(logs); } }, "Packaged app debug endpoint did not start.");
 browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
 const first = await until(async () => (await browser.pages()).find(page => /^http:\/\/127\.0\.0\.1:/.test(page.url())), "Bundled app server did not open.");
 first.setDefaultTimeout(60000); first.on("pageerror", error => failures.push(error.message));
 await first.waitForSelector('[data-testid="session-workspace"]');
 await first.waitForSelector('[data-testid="read-image"] summary img');
 assert.match(logs, /custom build: manual updates only/i);
 assert.match(logs, /server listening|server ready|window open:/i);
 checks.push("The custom app starts its bundled backend without LH_DEV_URL and disables the official updater.");
 const firstOrigin = new URL(first.url()).origin;
 const record = await first.evaluate(async () => (await fetch("/api/chats/packaged_png")).json()); assert.equal(record.id, "packaged_png"); assert.equal(record.messages.length, 4);
 assert.equal((await first.evaluate(() => window.lh.workspace.get())).panes[0].sessionId, "packaged_png");
 checks.push("The bundled backend serves the synthetic profile and the native bridge restores its session assignment.");
 await first.waitForFunction(() => { const image = document.querySelector('[data-testid="read-image"] summary img'); return image?.complete && image.naturalWidth > 0; });
 assert.equal(await first.$eval('[data-testid="tool-call-card"]', element => element.hasAttribute("open")), false);
 assert.equal(await first.$eval('[data-testid="read-image"]', element => element.closest('[data-testid="tool-call-card"]')), null);
 await first.$eval('[data-testid="read-image"] summary', summary => summary.click());
 await first.waitForFunction(() => { const image = document.querySelector('[aria-label="Full-size image fixture.png"] img'); return image?.complete && image.naturalWidth > 0 && image.getBoundingClientRect().height > 0; });
 await first.screenshot({ path: path.join(evidence, "packaged-png-full-size.png") });
 checks.push("A stored PNG decodes outside its collapsed trace and the full-size control displays a decoded image.");
 await first.evaluate(() => localStorage.setItem("lh.smoke.partition", "first"));
 await first.evaluate(() => window.lh.workspace.open(null, "window"));
 const second = await until(async () => (await browser.pages()).find(page => page !== first && page.url().startsWith(firstOrigin)), "Second packaged window did not open.");
 await second.waitForSelector('[data-testid="session-workspace"]');
 assert.equal(new URL(second.url()).origin, firstOrigin);
 assert.equal(await second.evaluate(() => localStorage.getItem("lh.smoke.partition")), null);
 checks.push("Two packaged windows share one backend origin and use separate browser storage partitions.");
 const persisted = JSON.parse(fs.readFileSync(path.join(profile, "workspace-v1.json"), "utf8")); assert.equal(persisted.windows.length, 2);
 assert.deepEqual(failures, []);
 console.log(JSON.stringify({ ok: true, checks, evidence, limits: ["No real model generation, completed demo retry, microphone, or second physical display is tested."] }, null, 2));
} catch (error) {
 if (browser) { for (const page of await browser.pages()) { console.error("Packaged failure DOM", await page.evaluate(() => document.body.innerText).catch(() => "closed")); await page.screenshot({ path: path.join(evidence, "failure.png") }).catch(() => {}); } }
 failures.push(error.stack || String(error)); console.error(JSON.stringify({ ok: false, checks, failures, logs }, null, 2)); process.exitCode = 1;
} finally {
 if (browser) await browser.close().catch(() => {}); await stop();
 fs.writeFileSync(path.join(evidence, "results.json"), JSON.stringify({ date: new Date().toISOString(), ok: failures.length === 0, checks, failures }, null, 2));
 fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
