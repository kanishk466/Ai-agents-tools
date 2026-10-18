# AI Agent with Real Tools (ReAct)

Give the agent a task — it **plans**, **searches the web**, **runs code**, **scrapes pages**,
**does math**, **saves reports**, and answers with **cited sources** and a **live thought stream**.

Built with **Fastify + TypeScript**, using **Gemini** (primary) and **Groq** (fallback) for
reasoning, **Tavily → DuckDuckGo** for search, **Redis** for cache/memory, and **PostgreSQL**
for durable run history.

Everything degrades gracefully: with **zero API keys** the agent runs fully offline via a
deterministic rule-based actor, an in-memory KV store, and keyless DuckDuckGo search — so the
whole pipeline is testable with nothing but `npm run dev`.

```
USER → API (rate limit + validate + cost cap)
         → PLANNER (simple or complex?)
           → ReAct LOOP (Gemini/Groq + 5 tools)
             → GUARDRAILS (cost + time + safety)
               → FINALIZER (format + cite + save report)
                 → USER (answer + sources + report)

Storage: Redis (cache/memory) or in-memory · Postgres (history/reports) or in-memory
Cost:    ₹0 — every provider has a free tier, and the offline mode is free forever
```

## Quick start (no API keys required)

```bash
npm install
npm run dev                # http://localhost:3000
```

Open http://localhost:3000, type a task, and watch the thoughts/actions stream live. Try:

- `calculate 2 * (3 + 4) ^ 2` → calculator tool
- `Compare the population of India vs China` → two web searches + a comparison
- `https://example.com` → scrapes the page
- `hello` → answered directly, no tools

> `PORT=3010 npm run dev` if 3000 is taken.

Run the automated smoke test (boots the server, runs tasks, asserts results):

```bash
npm run smoke
```

## Cloud mode (real reasoning + real search)

```bash
cp .env.example .env       # fill in whichever keys you have
```

```env
GEMINI_API_KEY=...         # primary LLM  - aistudio.google.com/apikey
GROQ_API_KEY=...           # fallback LLM - console.groq.com/keys
TAVILY_API_KEY=...         # web search   - app.tavily.com
DATABASE_URL=postgresql://agent:agent@localhost:5432/agent
REDIS_URL=redis://localhost:6379
```

```bash
docker compose up -d       # PostgreSQL + Redis (both optional)
npm run dev
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_MODE` | `auto` | `auto` = cloud when keys exist, `cloud` = require keys, `local` = never call out |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | – / `gemini-2.0-flash` | primary LLM |
| `GROQ_API_KEY` / `GROQ_MODEL` | – / `llama-3.3-70b-versatile` | fallback when Gemini 429s |
| `TAVILY_API_KEY` | – | web search; falls back to DuckDuckGo when unset |
| `DATABASE_URL` | – | falls back to in-memory stores when unset/unreachable |
| `REDIS_URL` | – | cache/memory/rate-limit; falls back to in-memory when unreachable |
| `MAX_ITERATIONS` | `8` | hard cap on ReAct loop iterations |
| `MAX_COST_USD` | `0.50` | per-task cost budget |
| `TOTAL_TIMEOUT_MS` | `60000` | wall-clock cap for a whole run |
| `TOOL_TIMEOUT_MS` / `CODE_TIMEOUT_MS` | `30000` / `5000` | per-tool / code-sandbox timeout |
| `DAILY_LIMIT_PER_IP` | `20` | requests per IP per day |
| `DAILY_COST_CAP_USD` | `5` | spend cap per IP per day |

Fallbacks are additive and independent: no keys ⇒ offline actor, no Tavily ⇒ DuckDuckGo,
no Redis ⇒ in-memory KV, no Postgres ⇒ in-memory stores.

## API

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/agent/run` | start a task → `202` + `runId`, `statusUrl`, `streamUrl` |
| `GET` | `/api/agent/status/:runId` | poll status / progress / result |
| `GET` | `/api/agent/stream/:runId` | **SSE** — live thoughts, actions, observations |
| `GET` | `/api/agent/history?sessionId=&limit=` | past runs for a session |
| `GET` | `/api/reports/:runId` | the generated markdown report |
| `GET` | `/api/health` | mode of every subsystem + guardrail config |

```bash
# Start a task
curl -X POST localhost:3000/api/agent/run \
  -H "Content-Type: application/json" \
  -d '{"query":"Compare iPhone 16 price on Flipkart vs Amazon","sessionId":"user_123"}'

# Stream live thoughts (SSE)
curl -N localhost:3000/api/agent/stream/<runId>

# Poll for the result
curl localhost:3000/api/agent/status/<runId>
```

`POST /api/agent/run` accepts an optional `config`:

```json
{
  "query": "…",
  "sessionId": "user_123",
  "config": { "maxIterations": 6, "budget": 0.3, "tools": ["web_search", "calculator"] }
}
```

### SSE event shapes

```json
{ "type": "thought", "iteration": 1, "content": "Need both site prices…" }
{ "type": "action", "iteration": 1, "tool": "web_search", "args": { "query": "…" } }
{ "type": "observation", "iteration": 1, "tool": "web_search", "content": "₹79,999 …", "ok": true }
{ "type": "final", "content": "Amazon is ₹1,499 cheaper…", "sources": [ … ] }
{ "type": "done", "stats": { "timeSeconds": 5.2, "costUsd": 0.012 } }
```

## How it works

```
POST /api/agent/run
      │
      ▼
┌─────────────┐   simple ("hello")   ┌──────────────────────┐
│   PLANNER   │ ───────────────────▶ │  single LLM call     │
│ (heuristic) │                      │  (no tools, no loop) │
└──────┬──────┘                      └──────────────────────┘
       │ complex ("compare X vs Y")
       ▼
┌──────────────────────────── ReAct LOOP (max 8 iters) ───────────────────────────┐
│                                                                                 │
│   Thought ─▶ Action(tool + JSON) ─▶ Observation ─▶ repeat…                      │
│      │                                                                            │
│      └──▶ once enough info: "Answer: …"  ─▶ break                                │
│                                                                                  │
│   LLM router:  Gemini ──429/error──▶ Groq ──down──▶ offline rule-based actor    │
│   Tool wrapper: validate ▸ retry(2) ▸ timeout(30s) ▸ truncate(1500) ▸ log       │
│   Guardrails (per iteration): cost < $0.50 ▸ iters < 8 ▸ time < 60s             │
└──────────────────────────────────────────────────────────────────────────────────┘
      │
      ▼
  FINALIZER: sanitize ▸ append citations ▸ save markdown report ▸ store history
```

### The ReAct protocol

The LLM replies in a strict text format that every provider (and the offline actor) shares:

```
Thought: I need the current price from both sites.
Action: web_search
Action Input: {"query": "iPhone 16 price Flipkart"}
```

…then the tool's `Observation` is fed back and the loop continues until the model emits
`Answer: …`. This text protocol is portable across Gemini, Groq and the offline actor — no
per-provider function-calling glue.

## The 5 tools

| Tool | Input | External dependency |
| --- | --- | --- |
| 🔍 `web_search` | `{ "query": "…" }` | Tavily (keyed) → DuckDuckGo (keyless), cached 1h |
| 💻 `execute_code` | `{ "code": "console.log(1+1)" }` | Node `vm` sandbox, 5s timeout, `require/process` blocked |
| 🌐 `scrape_url` | `{ "url": "https://…" }` | `fetch` + `cheerio`, SSRF guard on private hosts |
| 🔢 `calculator` | `{ "expression": "2*(3+4)^2" }` | safe recursive-descent parser (no `eval`) |
| 📄 `save_report` | `{ "title": "…", "content": "…" }` | report store + disk |

Every tool runs through a **common wrapper**: input validation → retry (infra failures only)
→ per-call timeout → output truncation (1500 chars) → logging.

## Guardrails

| Guardrail | Where | Effect |
| --- | --- | --- |
| Rate limiter | API layer | 20 requests / IP / day → `429` |
| Daily cost cap | API layer | $5 / IP / day → `402` |
| Input validator | API layer | query length, config bounds → `400` |
| Cost tracker | ReAct loop | stop at $0.50 / task |
| Iteration limiter | ReAct loop | stop at 8 iterations |
| Total timeout | ReAct loop | 60s wall clock |
| Pattern blocker | `execute_code` | blocks `require`, `process`, `eval`, … |
| SSRF guard | `scrape_url` | blocks localhost / private IPs |
| Output sanitizer | Finalizer | redacts anything key-shaped |

## Project structure

```
src/
├── index.ts                  Fastify server: wiring, health, static UI
├── types.ts                  shared domain types (Run, Source, SseEvent, …)
├── config/
│   ├── env.ts                env parsing + mode resolution + LLM pricing
│   ├── database.ts           PostgreSQL pool (falls back when unreachable)
│   └── kv.ts                 Redis / in-memory KV (cache, memory, rate-limit)
├── routes/
│   ├── agent.route.ts        run / status / stream (SSE) / history
│   └── reports.route.ts      generated markdown reports
├── services/
│   ├── llm/
│   │   ├── llm.service.ts    router: Gemini → Groq → offline
│   │   ├── gemini.provider.ts
│   │   ├── groq.provider.ts
│   │   └── local.provider.ts deterministic offline ReAct actor
│   ├── tools/
│   │   ├── tool.types.ts     ToolSpec / ToolResult contract
│   │   ├── tool.wrapper.ts   retry + timeout + truncate + validate + log
│   │   ├── registry.ts       tool registry + prompt block
│   │   └── *.tool.ts         web-search, scrape-url, calculator, execute-code, save-report
│   ├── planner.service.ts    classify simple vs complex, pick tools
│   ├── react.service.ts      the Thought→Action→Observation loop
│   ├── finalizer.service.ts  sanitize + cite + save report
│   ├── runs.service.ts       orchestration, live status, SSE fan-out
│   ├── guardrails.service.ts rate limit, cost cap, sanitizer
│   ├── memory.service.ts     session history for multi-turn context
│   └── cache.service.ts      typed KV helpers (search cache)
├── models/
│   ├── run.model.ts          agent_runs (Postgres / in-memory)
│   ├── conversation.model.ts conversations
│   └── report.model.ts       reports
└── utils/
    ├── logger.ts             winston
    ├── sse.ts                SSE frame helpers
    └── text.ts               truncate / sanitize / slugify
public/
└── index.html                chat UI with live SSE thought stream
scripts/
└── smoke-test.js             boots server, runs tasks, asserts results
```

## Design notes

- **Text ReAct protocol over native function calling** — one code path works for Gemini,
  Groq *and* the offline actor; no per-provider tool-call plumbing.
- **Throw vs return in tools** — `execute` *throws* for infrastructure failures (retried) and
  *returns* `{ ok: false }` for logical outcomes like a `403` (not retried).
- **In-process runs, not a queue** — runs are short-lived and SSE streaming is inherently
  per-process, so a BullMQ worker adds complexity without benefit on a single free instance.
  `runs.service.ts` is the single place to swap in a queue later.
- **Everything degrades** — each external dependency (LLM, search, Redis, Postgres) falls back
  independently, so the agent is always runnable.
```
