#!/usr/bin/env node
// Generic OpenAPI "meta" MCP server: 3 tools (search -> describe -> call) give full coverage of any REST API.
// Env: OPENAPI_PATH, BASE_URL, EXTRA_HEADERS (JSON, auth lives here, never with the agent), MAX_CHARS (default 20000).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import YAML from "yaml";

const OPENAPI_PATH = process.env.OPENAPI_PATH;
if (!OPENAPI_PATH) { console.error("OPENAPI_PATH is required"); process.exit(1); }
const MAX_CHARS = Number(process.env.MAX_CHARS) || 20000;
let EXTRA = {};
try { EXTRA = JSON.parse(process.env.EXTRA_HEADERS || "{}"); } catch { console.error("EXTRA_HEADERS is not valid JSON"); process.exit(1); }

const raw = readFileSync(OPENAPI_PATH, "utf8");
const spec = /^\s*[{[]/.test(raw) ? JSON.parse(raw) : YAML.parse(raw);
const BASE = (process.env.BASE_URL || spec.servers?.[0]?.url || "").replace(/\/+$/, "");

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const ops = new Map();
for (const [path, item] of Object.entries(spec.paths || {})) {
  for (const m of METHODS) {
    const o = item?.[m];
    if (!o) continue;
    let id = o.operationId || `${m}_${path.replace(/[^a-zA-Z0-9]+/g, "_")}`;
    while (ops.has(id)) id += "_";
    ops.set(id, { id, method: m.toUpperCase(), path, op: o, shared: item.parameters || [] });
  }
}
for (const o of ops.values()) {
  o.hay = {
    id: o.id.toLowerCase(), summary: (o.op.summary || "").toLowerCase(),
    desc: (o.op.description || "").toLowerCase(), path: o.path.toLowerCase(),
    tags: (o.op.tags || []).join(" ").toLowerCase(),
  };
}

const ref = (r) => r.replace(/^#\//, "").split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~")).reduce((a, k) => a?.[k], spec);
const clip = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

function simplify(s, depth, seen = []) {
  if (!s || typeof s !== "object") return s;
  if (s.$ref) {
    if (seen.includes(s.$ref)) return `<recursive ${s.$ref.split("/").pop()}>`;
    if (depth <= 0) return `<${s.$ref.split("/").pop()}>`;
    return simplify(ref(s.$ref), depth, [...seen, s.$ref]);
  }
  const out = {};
  if (s.type) out.type = s.type;
  if (s.format) out.format = s.format;
  if (s.enum) out.enum = s.enum;
  if (s.description) out.description = clip(s.description, 80);
  if (s.example !== undefined && typeof s.example !== "object") out.example = s.example;
  if (s.required) out.required = s.required;
  for (const k of ["allOf", "oneOf", "anyOf"]) if (s[k]) out[k] = s[k].map((x) => simplify(x, depth - 1, seen));
  if (s.items) out.items = depth <= 0 ? "…" : simplify(s.items, depth - 1, seen);
  if (s.properties) {
    if (depth <= 0) out.properties = `{${Object.keys(s.properties).join(", ")}}`;
    else out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, simplify(v, depth - 1, seen)]));
  }
  return out;
}

const text = (t) => ({ content: [{ type: "text", text: t }] });
const err = (t) => ({ isError: true, content: [{ type: "text", text: t }] });

const server = new McpServer({ name: "oapi-meta", version: "0.1.0" });
const title = spec.info?.title || "this API";

server.registerTool("search_operations", {
  description: `Find operations of ${title} (${ops.size} total) by keyword. Workflow: search_operations -> describe_operation -> call_operation. Returns 'operationId | METHOD path | summary'.`,
  inputSchema: { query: z.string().describe("keywords, e.g. 'list invoices' or 'delete client'"), limit: z.number().int().min(1).max(50).optional().describe("max results (default 10)") },
}, async ({ query, limit = 10 }) => {
  const toks = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (!toks.length) return err("Empty query.");
  const scored = [];
  for (const o of ops.values()) {
    let s = 0;
    for (const t of toks) {
      const stem = t.length > 3 ? t.replace(/(es|s)$/, "") : t;
      const hit = (h) => h.includes(t) || h.includes(stem);
      if (hit(o.hay.id)) s += 4;
      if (hit(o.hay.summary)) s += 3;
      if (hit(o.hay.path)) s += 3;
      if (hit(o.hay.tags)) s += 2;
      if (hit(o.hay.desc)) s += 1;
    }
    if (s) scored.push([s, o]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].path.length - b[1].path.length);
  if (!scored.length) return text("No matches. Try fewer or different keywords.");
  return text(scored.slice(0, limit).map(([, o]) => `${o.id} | ${o.method} ${o.path} | ${clip(o.op.summary || o.op.description, 100)}`).join("\n"));
});

server.registerTool("describe_operation", {
  description: "Get parameters, request body schema and response fields for one operationId (from search_operations). Call this before call_operation.",
  inputSchema: { operationId: z.string() },
}, async ({ operationId }) => {
  const o = ops.get(operationId);
  if (!o) return err(`Unknown operationId '${operationId}'. Use search_operations.`);
  const head = [`${o.id}: ${o.method} ${o.path}`];
  if (o.op.summary) head.push(clip(o.op.summary, 150));
  if (o.op.description && o.op.description !== o.op.summary) head.push(clip(o.op.description, 200));
  const params = [...o.shared, ...(o.op.parameters || [])].map((p) => (p.$ref ? ref(p.$ref) : p)).filter(Boolean)
    .filter((p) => !(p.in === "header" && Object.keys(EXTRA).some((k) => k.toLowerCase() === p.name.toLowerCase())));
  const plines = params.map((p) => {
    const sc = simplify(p.schema || {}, 1);
    return `param ${p.in}: ${p.name} (${sc.type || "any"}${sc.enum ? " enum " + sc.enum.join("|") : ""})${p.required ? " REQUIRED" : ""}${p.description ? " - " + clip(p.description, 70) : ""}`;
  });
  const tail = [];
  let rb = o.op.requestBody; if (rb?.$ref) rb = ref(rb.$ref);
  const media = rb?.content?.["application/json"] || Object.values(rb?.content || {})[0];
  if (media?.schema) { let j = JSON.stringify(simplify(media.schema, 3)); if (j.length > 1500) j = j.slice(0, 1500) + "…[body schema truncated]"; tail.push(`body${rb.required ? " (required)" : ""}: ` + j); }
  const okc = Object.keys(o.op.responses || {}).find((c) => /^2/.test(c));
  if (okc) {
    let r = o.op.responses[okc]; if (r?.$ref) r = ref(r.$ref);
    const sc = (r?.content?.["application/json"] || Object.values(r?.content || {})[0])?.schema;
    if (sc) tail.push(`response ${okc}: ` + JSON.stringify(simplify(sc, 1)).slice(0, 400));
  }
  const used = head.join("\n").length + tail.join("\n").length + 20;
  let budget = Math.max(600, 3000 - used), kept = [];
  for (const l of plines) { if (budget - l.length < 0) { kept.push(`…(${plines.length - kept.length} more params omitted; query params are optional)`); break; } kept.push(l); budget -= l.length + 1; }
  const out = [...head, ...kept, ...tail].join("\n");
  return text(out);
});

server.registerTool("call_operation", {
  description: "Execute an operation (after describe_operation). Auth is injected by the server. Large responses are truncated: use pagination/filter params.",
  inputSchema: {
    operationId: z.string(),
    path_params: z.record(z.any()).optional().describe("values for {placeholders} in the path"),
    query: z.record(z.any()).optional().describe("query string parameters"),
    body: z.any().optional().describe("JSON request body"),
  },
}, async ({ operationId, path_params, query, body }) => {
  const o = ops.get(operationId);
  if (!o) return err(`Unknown operationId '${operationId}'. Use search_operations.`);
  if (!BASE) return err("BASE_URL is not configured.");
  let path = o.path;
  for (const [k, v] of Object.entries(path_params || {})) path = path.replace(`{${k}}`, encodeURIComponent(String(v)));
  const missing = path.match(/\{[^}]+\}/g);
  if (missing) return err(`Missing path_params: ${missing.join(", ")}`);
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, String(x)); else url.searchParams.set(k, String(v));
  }
  const hasBody = body !== undefined && body !== null && o.method !== "GET";
  try {
    const res = await fetch(url, {
      method: o.method,
      headers: { Accept: "application/json", ...(hasBody ? { "Content-Type": "application/json" } : {}), ...EXTRA },
      body: hasBody ? JSON.stringify(body) : undefined,
    });
    let t = await res.text();
    try { t = JSON.stringify(JSON.parse(t)); } catch {}
    let note = "";
    if (t.length > MAX_CHARS) { note = `\n[truncated: ${t.length} chars, showing ${MAX_CHARS}. Use pagination/filter params (e.g. per_page, filter, status, fields) to narrow.]`; t = t.slice(0, MAX_CHARS); }
    const r = { status: res.status, content: [{ type: "text", text: `HTTP ${res.status}\n${t}${note}` }] };
    if (!res.ok) r.isError = true;
    return r;
  } catch (e) { return err(`Request failed: ${e.message}`); }
});

await server.connect(new StdioServerTransport());
