# Personal Assistant v3 — System Architecture & Feature Report

**Prepared:** 2026-08-30 · **Codebase:** `app.py` (~5,420 lines), `static/js/app.js` (~6,575 lines), `templates/index.html`, `tests/test_app.py`
**Quality gates:** 55 unit tests passing · `py_compile` clean · `node --check` clean · Phase1/2/3 integration harnesses all passing

---

## 1. Executive Summary

Single-page Flask + SQLite web app that has evolved from a personal productivity
tool (tasks / notes / pages / schedule) into an **enterprise medical-billing RCM
assistant** with:

- A **multi-agent office model** — 6 named department "head" agents plus a central
  administrator/RCM reviewer, orchestrated by a dispatcher + keyword router.
- **Task-aware dual-tier LLM routing** — Fast model (Gemini) for simple CRUD,
  Strong model (OmniRoute local gateway → omni) for medical-billing reasoning.
- **Local-first RAG** — SQLite FTS5 full-text + cached vector embeddings +
  conversation-context injection; degrades gracefully when no LLM key exists.
- **Maker-Checker review loop** — every billing-relevant worker draft (and every
  write action) is reviewed by a senior agent on the Strong model before release
  to the user; rejected drafts self-correct up to N loops, else **manual-review flag**.
- **Hardened security** — role-based auth with brute-force throttling, HTML
  whitelist sanitizer, CSP/security headers, read-only SQL tool with table
  allowlist, and an SSRF-guarded external-API allowlist (NPI registry seeded).

**Deployment model:** single process on the user's Windows machine; real data in
`assistant.db`; secrets in `.env` + `chat_settings`/`chat_api_keys` (never sent to
the browser); local OmniRoute gateway on `localhost:20128`.

---

## 2. High-Level Architecture

```
Browser (index.html + app.js)
        │  fetch() / EventSource (SSE)
        ▼
Flask app (app.py)  ── security: auth(RBAC+throttle) → role_required → handlers
        │
        ├── SQLite (assistant.db, WAL mode)
        │     ├─ User data:  users, tasks, notes, note_versions, note_shares,
        │     │              pages, routines, routine_completions, knowledge_base
        │     ├─ AI data:    chat_sessions, chat_messages, chat_agents,
        │     │              chat_settings, chat_api_keys, api_tools,
        │     │              app_settings (k/v), agent_pending
        │     ├─ RAG index:  entry_fts (virtual FTS5) + embed_vectors (cached)
        │     └─ Audit:      in-memory ring buffer (Settings → AI log)
        │
        ├── LLM layer (urllib; per-provider base/headers/parse)
        │     └─ Fast tier (gemini)  · Strong tier (omni→OmniRoute)  · reviewer
        ├── External APIs (allowlist, SSRF-guarded; NPI Registry on HMAC-free GET)
        └── SSE streaming chat /api/chat/sessions/<sid>/stream
```

**Data flow for one chat message:**
1. `chatSend()` → SSE `/stream` → `_chat_flow_events()` server generator.
2. Node tracker events (input → RAG → agents → LLM → response) stream to UI.
3. RAG node: `_search_best()` = FTS5 keywords + vector similarity (merged/deduped).
4. Agent mode → `agent_answer()`: pending-plan merge OR new plan classification
   (JSON decision); `none` answer or action prepared as **draft**.
5. Maker-Checker: draft/action reviewed by reviewer agent on Strong model →
   approved (release) | rejected → worker fixes → … | manual flag.
6. Reply saved to `chat_messages`, footer chips appended, `final` event → UI.

---

## 3. Comprehensive Feature Breakdown

### 3.1 Frontend / User-facing features

| Module | What it does |
|---|---|
| **Auth / Roles** | Sign in / register (first user = admin); role badge; Manage Users (admin). Roles: `admin`, `manager`, `user`. Permissions enforce read (any logged-in), write (admin/manager), destructive (admin only). |
| **Dashboard** | Stat cards (tasks, pending, notes, routines), today progress "rings" chart (SVG), recent notes, today's tasks & routines with inline checkboxes. Meh Boom clock (PK/US). Theme toggle (dark/light). |
| **Tasks** | List with tabs, priorities (low/medium/high), due-date chips, add/edit dialog, done toggle, creator chip. |
| **Notes** | Card grid, tag bar, pin, search incl. **deep search** (content search), full rich-text editor (toolbar: font, color, highlight, lists, checklist, link, table with column resize, emoji picker, image upload with inline resize) — content sanitized server-side. Version history (≤20 versions), print, share (public token link `/s/<token>`), related-notes panel. |
| **Pages** | Dept/section pages (icon picker with 3 icon families), auto-linked notes + tasks, per-page Excel export. |
| **Web Portals** | Manage Google Sheets / websites (name, type, url, notes) — injected into agent system prompts so bots point users to the right sheet. |
| **Schedule** | Weekly routine calendar chips + day editor; daily progress. |
| **Calendar** | Month grid highlighting days that have tasks/routines; day drill-down dialog. |
| **Chat** | Session sidebar (per-user conversations), SSE **node-tracker flow** ("input → SQLite RAG → Agents → Cloud LLM → response"), source chips, provider badges, **Actions Agent toggle** (on = can modify app data), **Live Chat toggle** (off = agent persona, on = plain AI), per-session delete. |
| **Knowledge Base** | Guidelines (office rules) CRUD; seeded content feeds the RAG index. |
| **Agents page** | List/activate/de-activate custom agents, master Agent On/Off switch, create agent (name, icon, description, system prompt). |
| **Settings → AI Models** | Per-provider tiles (Gemini, OpenAI, Groq, Grok, OmniRoute), active provider, model selection, live model fetch, temperature/max_tokens tuning, multi-key management with **auto-rotate on 401/403/429**, key add/activate/enable/delete (masked), per-provider test, **Activity Log** (live 800-entry ring buffer with WARNING/ERROR filter + search). |
| **Settings → Tools & Routing** | **Task-aware routing** toggle + Fast/Strong selects (no-key options disabled) + live test box; **Maker-Checker review** toggle + max correction loops (0–3); **External API allowlist** (add/edit/delete/enable tools with `{placeholder}` templates). |
| **Settings → Data** | Full backup (JSON, Excel multi-sheet, SQLite), restore (JSON/excel/SQLite — validates schema & ownership), Erase All Data (admin, throttled). |

### 3.2 Multi-Agent System

Six custom agents live in `chat_agents`; all **active** (is_active=1), plus the
implicit **Actions Agent** (the system's CRUD/orchestrator persona built into
`agent_answer`).

| # | Agent | Role / System prompt essence |
|---|---|---|
| 2 | **Adnan Gul** | VDL Data Entry Dept Head — answers only data-entry questions from notes/pages/guidelines/portals. |
| 5 | **Abdul Sameed** | VDL Calling Dept Head — patient calling, eligibility calls, appts, reminders, follow-ups, denial calling. |
| 6 | **Noman Munir** | VDK ERN Dept Head — ERN workflow, filings, corrections, submissions. |
| 7 | **Asmar** | VDL Processing Dept Head — claims processing, submission, clearinghouse, rejections, prior auths. |
| 8 | **Rumman Lashari** | **Administrator & Agent Coordinator** — the "boss": reads user intent, delegates (`adnan se kaho` → Adnan), manages notes/tasks/pages/guidelines/routines/portals. |
| 9 | **Medical Billing** | RCM specialist — answers strictly from app sources; **Golden Rule: never change/invent CPT/ICD codes, dates, figures.** Also the billing-domain Reviewer. |

**How agents interact (dispatcher + router):**
- `_agent_router(question, actives)`: singleton short-circuit → `_dispatcher_target`:
  1. **delegation intent** phrases (`se kaho`, `ko bolo`, `ask`, `through`, …) with a named agent → that agent (never admin-as-target);
  2. exactly one agent **named** → that agent;
  3. task-management request, no agent named → **admin**;
- else **keyword overlap scoring** over name+description+system prompt (name tokens +10, newest wins ties).
- Reply footer token `__agentby__<name>__<icon>__<role>` renders the "replied by" chip.
- Reviewer selection (Phase 3): billing text/worker → **Medical Billing**, unless the worker **is** Medical Billing → **Rumman** (no self-review); other work → **Rumman**. Name-priority matching prevents false matches from description text.

### 3.3 Routing & AI Logic

- `_task_kind_heuristic(question)` — `_COMPLEX_MARKERS` (~34 medical-billing +
  analysis/writing markers: denial, cpt, icd, n197, norc, appeal, reimbursement,
  "step by step", "draft", "analyze"…) minus `_COMPLEX_EXCLUDE` ("write off",
  "write a task|note|email"…) → `complex`/`simple`.
- `_chat_provider(question)` — if `route_auto`=1: complex → `route_strong` (default
  **omni**), simple → `route_fast` (default **gemini**); tier without a key falls
  back to **Active** provider (`chat_settings.enabled=1`, latest → omni currently).
- Applied in `agent_answer`, `hybrid_answer`, `_chat_flow_events`.
- **Reviewer** always uses Strong tier (`_reviewer_provider()`), fallback Active.
- Provider abstraction: `gemini` (Google REST, `x-goog-api-key`) vs
  `openai-compat` (Bearer `/chat/completions`); per-provider base URL override
  (admin), tuning, model; SSE-tolerant response parser (OmniRoute streams); key
  auto-rotation with masked logging.

### 3.4 Memory & RAG

- **FTS5** (compile-time `ENABLE_FTS5`): virtual `entry_fts` over the unified
  "local library" (knowledge_base guidelines, notes, tasks, routines, pages).
  Rebuilt lazily only when `fts_digest` fingerprint changes. Query = `("t1" "t2" …)*`
  prefix AND with bm25 ranking; OR fallback; then LIKE-based `_search_local`.
- **Embeddings**: `embed_vectors` (doc_key=md5, content_hash, json vector,
  provider). Provider order: preferred → omni → gemini → openai → groq (whichever
  has a key); gemini uses `embedding-001:embedContent` REST, others
  `/embeddings`. Lazy rebuild gated by `embed_digest`, capped 60 docs / 4000-char
  text, cosine over `_EMBED_SIM_THRESHOLD=0.32`. **This session:** added a small
  question-embedding cache (24 entries) so the two `_search_best` calls per
  message embed the question only once.
- **Fail-soft chain:** any embedding failures disable that layer for the process
  (never hangs chat); FTS failure → LIKE search → local answer → cloud.
- **Conversation context:** `_recent_history(sid, 6)` oldest-first turns injected
  into `_gemini_reply` as a "RECENT CONVERSATION" section so follow-ups like
  *"uska matlab?"* resolve. Now also wired into the non-agent cloud streaming path.
- **`_search_best()`** merges keyword + semantic hits, deduped by `(kind, title)`.

### 3.5 Tools & Security

| Guard | Implementation |
|---|---|
| **Read-only SQL tool** | `SELECT`/`EXPLAIN QUERY PLAN` only; deny-regex for insert/update/delete/drop/alter/create/…/pragma/union/load_file; table scanning (`FROM`/`JOIN`) restricted to **11-table allowlist** (tasks, notes, pages, routines, routine_completions, knowledge_base, chat_sessions, chat_messages, chat_agents, api_tools, note_shares — `chat_settings`/keys/users excluded); auto `LIMIT 50`; 25-row markdown cap. |
| **External-API allowlist** | Admins register `api_tools` (name, url_template, method, description, enabled) — **NPI Registry seeded** when empty. `_safe_fetch`: HTTPS-only, `{param}` substitution (URL-encoded), missing-param errors, 10s timeout, 200KB read cap, 6,000-char snippet, tool-id must be in allowlist. |
| **SSRF guard** | `_safe_upstream_host`: blocks localhost/.local, forward/reverse-lookup of private / loopback / link-local / reserved / multicast IPs. (Chat-provider base URLs are admin-set by design.) |
| **Maker-Checker review** | `review_enabled` (default ON), `review_max_loops` default 2 (0–3). Text drafts ≥220 chars or complex heuristically reviewed; all create/update/delete/sql/fetch plans reviewed **before execution**. Reviewer JSON verdict `{"verdict":"approved"}` / `{"verdict":"rejected","critique":"<one concrete fix>"}`; rejected → worker re-prompt with critique (plan revision reuses orchestrator + tool inventory); exhaustion → action **not executed**, draft + ⚠️ manual-review flag shown. Fail-safe: reviewer/provider errors log + default approve (chat never blocks). |
| **Auth hardening** | Argon-ish werkzeug hashes; per-IP in-memory throttles (login 5/5min, register 10/5min); 30-day sessions; HttpOnly + SameSite=Lax + optional Secure; `secret.key` persisted. |
| **Output/XSS** | Whitelist HTML sanitizer (`HTMLParser` based — decodes all char refs, blocks js/vb/data/file URLs, drops script/style/svg/…, style url() stripping). |
| **Transport/UI** | CSP (`default-src 'self'`, connect-src self, img data:), nosniff, frame-ancestors none, no-store on `/api/`, robots noindex on shares, no-cache on HTML. |
| **Cost controls** | Review skip for short/simple answers, tier routing, cache-embedded question, 60-doc cap, 8KB input caps, 6,000-char fetch snippet, auto-LIMIT SQL. |

### 3.6 Database Schema (17 tables + virtual FTS5)

```
users (id, username, password_hash, display_name, role, created_at)
tasks (id, title, description, priority, due_date, done, completed_at, created_at, page_id→pages, created_by)
notes (id, title, content, pinned, tags, created_at, updated_at, page_id→pages, created_by)
note_versions (id, note_id→notes, title, content, created_at)            # snapshots, ≤20/note
note_shares (id, token, note_id→notes, created_at)                       # public /s/<token>
pages (id, title, icon, content, created_at, updated_at, created_by)     # dept sections
routines (id, title, weekday 0-6, time, active, created_at, created_by)
routine_completions (id, routine_id→routines, completed_date)            # streak/calendar
knowledge_base (id, title, category, content, created_at, updated_at, created_by)  # guidelines
chat_sessions (id, user_id→users, title, created_at, updated_at)
chat_messages (id, session_id→chat_sessions, sender, message, source_type, created_at)
chat_agents (id, name, description, system_prompt, is_active, created_at, icon)
chat_settings (provider PK, label, model, api_key, enabled, updated_at)  # one row per provider
chat_api_keys (id, provider, label, api_key, enabled, is_active, fails, created_at)  # multi-key, rotation
api_tools (id, name, url_template, method, enabled, description, created_at)
agent_pending (session_id, plan, updated_at)                             # multi-turn plan collection
app_settings (key PK, value, updated_at)                                 # routing/review/embed/.. k/v
entry_fts (@@virtual FTS5@@ over kind/title/tag/text)                    # RAG keyword layer
embed_vectors (doc_key, kind, title, tag, text, content_hash, vector, provider, updated_at)  # RAG vector layer
```
Relationships: notes/tasks → pages (department); note_versions & note_shares →
notes; routine_completions → routines; chat_messages → chat_sessions →
users; agent_pending → chat_sessions. `PRAGMA foreign_keys=ON`, WAL + busy_timeout.

---

## 4. Code Audit — Issues Found & Fixed

Performed a full read-through of backend + frontend during this audit. **All
fixes verified:** 55 tests pass, `py_compile` and `node --check` clean, Phase-2/3
harnesses still green.

| # | Issue | Severity | Fix |
|---|---|---|---|
| 1 | `_agent_fill()` built a `system` string including the custom agent prompt but called `_llm_prompt` with raw `_AGENT_FILL_SYSTEM` — **custom-agent instructions were silently dropped** when merging pending plans (multi-turn adds, persona continuity) | **Bug (functional)** | Use the `system` variable (app.py ~1870). |
| 2 | `_fts_matches()` had a dead `title_cat` dict built per-loop and never used | Cleanup | Removed (app.py ~1209). |
| 3 | Question embedding recomputed on every `_grid` call; `_search_best()` runs twice per message (RAG node + answer) → duplicate embed API calls | Perf/cost | Added 24-entry LRU question-embed cache in `_embed_text` (app.py ~1283). |
| 4 | Non-agent live-chat streaming path called `_gemini_reply` without `history` — follow-ups ("uska matlab?") lost context, unlike the agent path | Bug (minor) | Pass `history=_recent_history(sid)` (app.py ~3126). |
| 5 *(earlier)* | `_billing_agent()` matched Rumman because his description contains the phrase "Medical Billing" | Bug | Name-priority matching (exact `Medical`+`Billing`/`RCM` name wins). |
| 6 *(earlier)* | Plans were reviewed before completeness checks → half-formed plans wasted a review call | Design | Missing-fields ask now runs **before** the Maker-Checker gate. |

No further correctness issues found in the scrub of auth throttle, sanitizer,
import/export validation, upload path safety, streaming, or role decorators.

---

## 5. Scaling Notes for Next Phase (Voice + Desktop Integration)

- **SSE streaming** is already the chat transport — trivial to also carry voice
  session metadata; the node-tracker is reusable as a "voice pipeline" view.
- **CSP today** blocks `connect-src` beyond self and `media-src` — speech APIs
  (STT/TTS) will need deliberate CSP entries (e.g., browser-native
  `SpeechRecognition` needs no network; remote TTS would).
- **Single-process assumptions:** embeddings kill-switch and log ring buffer are
  per-process; multi-threaded desktop wrapper is fine (SQLite WAL + busy_timeout).
- **Sessions/keys:** desktop onboarding could re-use `secret.key` + `.env`;
  `chat_api_keys` rotation already handles multiple operator keys.
- Recommended next steps: a `/api/voice/session` endpoint pair, Spectron/PyWebView
  shell docs, and wire the reviewer to run on uploaded denial PDF text.

---

*End of report.*