/** Exercise Retry in the packaged app with its own backend and real demo runner.
 * The only model endpoint is an in-process, keyless, deterministic HTTP fixture.
 * Run: node scripts/smoke-demo-retry-packaged.mjs [path/to/custom/executable]
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const executable = path.resolve(process.argv[2] || "dist-custom/mac-arm64/Hadrien LearnHarness.app/Contents/MacOS/Hadrien LearnHarness");
assert.ok(fs.existsSync(executable), "Build the custom app first or pass its executable path.");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-demo-retry-packaged-"));
const profile = path.join(home, "profile");
const evidence = process.env.LH_DEMO_EVIDENCE_DIR || path.join(os.tmpdir(), "lh-demo-retry-packaged-evidence");
fs.mkdirSync(evidence, { recursive: true });
const chatId = "packaged_retry", originalId = "job_failed_fixture";
const input = { title: "Verified counter", brief: "Create a button labeled Add one and a Count readout. Clicking the button must increase Count from 0 to 1." };
const html = '<!doctype html><html><head><meta charset="utf-8"><title>Verified counter</title></head><body><h2>Verified counter</h2><button id="add">Add one</button><p>Count: <output id="count">0</output></p><script>document.getElementById("add").onclick=function(){document.getElementById("count").textContent=String(Number(document.getElementById("count").textContent)+1);};</script></body></html>';
const probe = '(() => {document.getElementById("add").click();return document.getElementById("count").textContent === "1";})()';
const requests = [], checks = [], failures = [];
let logs = "", child, browser, page, successor;
async function until(check, message, timeout = 90000) {
 const start = Date.now();
 while (Date.now() - start < timeout) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 100)); }
 throw new Error(message);
}
async function freePort() { const server = net.createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening"); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function stop() {
 if (!child || child.exitCode !== null || child.signalCode !== null) return;
 const closed = once(child, "exit"); child.kill("SIGTERM");
 const timer = setTimeout(() => child.kill("SIGKILL"), 5000); timer.unref(); await closed; clearTimeout(timer);
}
function completion(response, delta, finish = "stop") {
 const chunk = (part, finish_reason = null) => ({ id: "chatcmpl_local_fixture", object: "chat.completion.chunk", created: 1, model: "demo-fixture", choices: [{ index: 0, delta: part, finish_reason }] });
 response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
 for (const data of [chunk({ role: "assistant" }), chunk(delta), chunk({}, finish)]) response.write(`data: ${JSON.stringify(data)}\n\n`);
 response.end("data: [DONE]\n\n");
}
const provider = http.createServer(async (request, response) => {
 try {
  if (request.url === "/v1/models" && request.method === "GET") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ object: "list", data: [{ id: "demo-fixture", object: "model", owned_by: "local-fixture" }] })); return; }
  if (request.url !== "/v1/chat/completions" || request.method !== "POST") { response.writeHead(404); response.end("Fixture route missing"); return; }
  let bytes = ""; for await (const chunk of request) { bytes += chunk; if (bytes.length > 2e6) throw new Error("Unexpected fixture request size."); }
  const body = JSON.parse(bytes);
  assert.equal(body.model, "demo-fixture"); assert.equal(body.stream, true);
  const names = (body.tools || []).map(tool => tool.function?.name);
  const tools = body.messages.filter(message => message.role === "tool");
  const demo = names.includes("write_demo");
  requests.push({ purpose: demo ? "builder" : "teacher", tools: names, toolResults: tools.map(message => ({ tool_call_id: message.tool_call_id, content: message.content })) });
  if (!demo) { completion(response, { content: "The counter demo is ready. Click Add one to increase Count." }); return; }
  const wrote = body.messages.some(message => message.tool_calls?.some(tool => tool.function.name === "write_demo"));
  const ran = body.messages.some(message => message.tool_calls?.some(tool => tool.function.name === "run_demo"));
  if (!wrote) completion(response, { tool_calls: [{ index: 0, id: "fixture_write", type: "function", function: { name: "write_demo", arguments: JSON.stringify({ html }) } }] }, "tool_calls");
  else if (!ran) completion(response, { tool_calls: [{ index: 0, id: "fixture_run", type: "function", function: { name: "run_demo", arguments: JSON.stringify({ probe }) } }] }, "tool_calls");
  else {
   assert.ok(tools.some(tool => String(tool.content).includes("PASSED")), "Real run_demo must report PASSED before the fixture finishes.");
   completion(response, { content: "The counter passes its browser test. Click Add one to increase the displayed count." });
  }
 } catch (error) { failures.push(error.stack || String(error)); if (!response.headersSent) response.writeHead(500); response.end("Fixture assertion failed"); }
});
try {
 provider.listen(0, "127.0.0.1"); await once(provider, "listening");
 const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
 const bindingId = "0123456789abcdef0123456789abcdef";
 fs.mkdirSync(path.join(profile, "data", "chats"), { recursive: true }); fs.mkdirSync(path.join(profile, "data", "jobs"), { recursive: true });
 fs.writeFileSync(path.join(profile, "auth.json"), JSON.stringify({ __learnharness_custom_provider_binding: JSON.stringify({ version: 1, id: bindingId, baseUrl, authMode: "keyless" }) }), { mode: 0o600 });
 const slot = { model: { provider: "custom", id: "demo-fixture" }, thinkingLevel: "off" };
 fs.writeFileSync(path.join(profile, "data", "settings.json"), JSON.stringify({ version: 1, models: { strong: slot, cheap: slot, vision: slot }, customProvider: { baseUrl, authMode: "keyless", credentialBindingId: bindingId, models: [{ id: "demo-fixture", context: 131072, maxTokens: 4096 }], manualModels: ["demo-fixture"] } }));
 const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
 const assistant = (id, content, stopReason = "stop") => ({ id, role: "assistant", api: "openai-completions", provider: "custom", model: "demo-fixture", timestamp: 1, stopReason, usage, content });
 const messages = [
  { id: "learner", role: "user", content: "Show a counter demo.", timestamp: 0 },
  assistant("dispatch", [{ type: "toolCall", id: "demo_fixture", name: "demo", arguments: input }], "toolUse"),
  { id: "ack", role: "toolResult", toolCallId: "demo_fixture", toolName: "demo", content: [{ type: "text", text: `Dispatched (job ${originalId}). Continue teaching.` }], details: null, isError: false, timestamp: 2 },
  assistant("lesson", [{ type: "text", text: "The first demo attempt failed. Use Retry to rebuild it." }]),
 ];
 fs.writeFileSync(path.join(profile, "data", "chats", `${chatId}.json`), JSON.stringify({ version: 1, id: chatId, title: "Packaged retry fixture", kind: "teach", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z", messages }));
 const original = { id: originalId, kind: "demo", chatId, toolCallId: "demo_fixture", input, status: "error", activity: "failed", error: "Synthetic original failure", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z", result: { title: input.title, html: "", tested: true, notes: "FAILED: Synthetic original failure" } };
 fs.writeFileSync(path.join(profile, "data", "jobs", `${originalId}.json`), JSON.stringify(original));
 fs.writeFileSync(path.join(profile, "workspace-v1.json"), JSON.stringify({ version: 1, windows: [{ id: "retry_window", panes: [{ id: "retry_pane", sessionId: chatId }], activePaneId: "retry_pane", split: .5, zoom: 1 }], views: { [chatId]: { draft: "Keep this unsent draft." } } }));
 const debug = await freePort();
 child = spawn(executable, [`--remote-debugging-port=${debug}`, "--disable-background-networking", "--disable-sync"], { cwd: home, env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, LH_PROFILE_DIR: profile, LH_IGNORE_ENV_KEYS: "1", NEXT_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"] });
 const capture = value => { logs = (logs + value).slice(-50000); }; child.stdout.on("data", capture); child.stderr.on("data", capture);
 const endpoint = await until(async () => { try { return (await (await fetch(`http://127.0.0.1:${debug}/json/version`)).json()).webSocketDebuggerUrl; } catch { if (child.exitCode !== null) throw new Error(logs); } }, "Packaged debug endpoint did not start.");
 browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
 page = await until(async () => (await browser.pages()).find(candidate => /^http:\/\/127\.0\.0\.1:/.test(candidate.url())), "Bundled backend did not open.");
 page.setDefaultTimeout(90000); page.on("pageerror", error => failures.push(error.message));
 await page.waitForSelector('[data-testid="dispatch-retry"]');
 checks.push("The packaged app and its bundled backend show Retry for a stored failed demo.");
 await page.click('[data-testid="dispatch-retry"]');
 const jobDir = path.join(profile, "data", "jobs");
 successor = await until(() => {
  const found = fs.readdirSync(jobDir).map(file => JSON.parse(fs.readFileSync(path.join(jobDir, file), "utf8"))).find(job => job.retryOf === originalId);
  if (found?.status === "error") throw new Error(`Successor failed: ${JSON.stringify(found)}`);
  return found?.status === "done" && found;
 }, "The actual demo runner did not complete.");
 assert.equal(successor.result.tested, true); assert.equal(successor.result.html, html);
 assert.ok(requests.filter(request => request.purpose === "builder").length >= 3);
 assert.ok(requests.some(request => request.toolResults.some(tool => String(tool.content).includes("PASSED"))));
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(jobDir, `${originalId}.json`), "utf8")), original);
 checks.push("Retry creates a successor, runs write_demo and run_demo against the local provider fixture, and saves tested HTML with status done.");
 await until(async () => {
  const status = await page.evaluate(async (chatId) => (await fetch(`/api/jobs?chatId=${chatId}`)).json(), chatId);
  return !status.turnInFlight && status.jobs.some(job => job.id === successor.id && job.delivery?.status === "delivered");
 }, "Completed demo did not reach the settled lesson.");
 await page.waitForSelector('[data-testid="demo-iframe"]');
 const frameElement = await page.$('[data-testid="demo-iframe"]');
 const frame = await frameElement.contentFrame();
 await frame.waitForSelector("#add");
 await frame.waitForFunction(() => typeof document.getElementById("add")?.onclick === "function");
 assert.equal(await frame.$eval("#count", element => element.textContent), "0");
 await frame.click("#add");
 await frame.waitForFunction(() => document.getElementById("count").textContent === "1");
 assert.equal(await frame.$eval("#count", element => element.textContent), "1");
 checks.push("The result reaches the native transcript and its sandboxed demo button changes Count from 0 to 1.");
 assert.equal((await page.evaluate(() => window.lh.workspace.get())).views[chatId].draft, "Keep this unsent draft.");
 const savedChat = JSON.parse(fs.readFileSync(path.join(profile, "data", "chats", `${chatId}.json`), "utf8"));
 assert.equal(savedChat.messages.filter(message => message.role === "user").length, 1);
 checks.push("Retry preserves the unsent draft and adds no learner answer or message.");
 await page.screenshot({ path: path.join(evidence, "completed-retry.png") });
 assert.deepEqual(failures, []);
 console.log(JSON.stringify({ ok: true, checks, successor: successor.id, providerCalls: requests.length, evidence }, null, 2));
} catch (error) {
 failures.push(error.stack || String(error));
 if (page) { await page.screenshot({ path: path.join(evidence, "failure.png") }).catch(() => {}); fs.writeFileSync(path.join(evidence, "failure-dom.txt"), await page.evaluate(() => document.body.innerText).catch(() => "closed")); }
 console.error(JSON.stringify({ ok: false, checks, failures, requests, logs }, null, 2)); process.exitCode = 1;
} finally {
 if (browser) await browser.close().catch(() => {}); await stop();
 provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
 fs.writeFileSync(path.join(evidence, "results.json"), JSON.stringify({ date: new Date().toISOString(), ok: failures.length === 0, checks, failures, successor, providerRequests: requests, limits: ["The model responses come from a deterministic local fixture. No remote model reliability is tested."] }, null, 2));
 fs.writeFileSync(path.join(evidence, "runtime.log"), logs);
 fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
