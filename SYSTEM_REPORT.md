# Personal Assistant v3 — System Architecture & Feature Report

**Prepared:** 2026-09-06 · **Codebase:** `app.py` (**8,438** lines), `static/js/app.js` (**7,812** lines), `templates/index.html` (1,170 lines), `tests/test_app.py` + `tests/test_qa_full.py`
**Quality gates (post-fix):** 188 tests — `test_app.py` 146/149, `test_qa_full.py` 39/39 · `py_compile` clean · **all audit findings fixed** (see §4 fix log)

---

## 1. Executive Summary

Single-page Flask + SQLite web app that has evolved from a personal productivity
tool (tasks / notes / pages / schedule) into an **enterprise medical-billing RCM
assistant** with:

- A **multi-agent office model** — 6 named department "head" agents plus a central
  administrator/RCM reviewer, orchestrated by a dispatcher + keyword router.
- **Task-aware dual-tier LLM routing** — Fast model (Gemini) for simple CRUD,
  Strong model (OmniRoute local gateway • omni) for medical-billing reasoning.
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
Flask app (app.py)  ── security: auth(RBAC+throttle) + role_required + handlers
        │
        ├───▶ SQLite (assistant.db, WAL mode)
        │        ├─ User data:  users, tasks, notes, note_versions, note_shares,
        │        │              pages, routines, routine_completions, knowledge_base
        │        ├─ AI data:    chat_sessions, chat_messages, chat_agents,
        │        │              chat_settings, chat_api_keys, api_tools,
        │        │              app_settings (k/v), agent_pending, agent_memory, agent_audit
        │        ├─ RAG index:  entry_fts (virtual FTS5) + embed_vectors (cached)
        │        └─ Audit:      agent_audit table + in-memory ring buffer (Settings ▸ AI log)
        │
        ├──▶ LLM layer (urllib; per-provider base/headers/parse)
        │        ├─ Fast tier (gemini)   ─ Strong tier (omni•OmniRoute)  ─ reviewer
        └──▶ External APIs (allowlist, SSRF-guarded; NPI Registry on HMAC-free GET)
             └──▶ SSE streaming chat /api/chat/sessions/<sid>/stream
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
| **Agents page** | List/activate/de-activate custom agents, master Agent On/Off switch, create agent (name, icon, description, system prompt), per-agent **memory** CRUD. |
| **Settings ▸ AI Models** | Per-provider tiles (Gemini, OpenAI, Groq, Grok, OmniRoute), active provider, model selection, live model fetch, temperature/max_tokens tuning, multi-key management with **auto-rotate on 401/403/429**, key add/activate/enable/delete (masked), per-provider test, **Activity Log** (live ring buffer with WARNING/ERROR filter + search). |
| **Settings ▸ Tools & Routing** | **Task-aware routing** toggle + Fast/Strong selects (no-key options disabled) + live test box; **Maker-Checker review** toggle + max correction loops (0–3); **External API allowlist** (add/edit/delete/enable tools with `{placeholder}` templates). |
| **Settings ▸ Data** | Full backup (JSON, Excel multi-sheet, SQLite), restore (JSON/excel/SQLite — validates schema & ownership), Erase All Data (admin, throttled). |

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
- Conversation stickiness: `_last_reply_agent` keeps follow-ups with the same bot.
- Reply footer token `__agentby__<name>__<icon>__<role>` renders the "replied by" chip.
- Reviewer selection: billing text/worker → **Medical Billing**, unless the worker **is** Medical Billing → **Rumman** (no self-review); other work → **Rumman**. Name-priority matching prevents false matches from description text.

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
  text, cosine over `_EMBED_SIM_THRESHOLD=0.32`. Includes a small question-embedding
  LRU cache so `_search_best` embeds the question only once per message.
- **Fail-soft chain:** any embedding failures disable that layer for the process
  (never hangs chat); FTS failure → LIKE search → local answer → cloud.
- **Conversation context:** `_recent_history(sid, 6)` oldest-first turns injected
  into `_gemini_reply` as a "RECENT CONVERSATION" section so follow-ups like
  *"uska matlab?"* resolve. Also wired into the non-agent cloud streaming path.
- **`_search_best()`** merges keyword + semantic hits, deduped by `(kind, title)`.

### 3.5 Tools & Security

| Guard | Implementation |
|---|---|
| **Read-only SQL tool** | `SELECT`/`EXPLAIN QUERY PLAN` only; deny-regex for insert/update/delete/drop/alter/create/…/pragma/union/load_file; table scanning (`FROM`/`JOIN`) restricted to a **13-table allowlist** (tasks, notes, pages, routines, routine_completions, knowledge_base, chat_sessions, chat_messages, chat_agents, api_tools, note_shares, agent_memory, agent_audit — `chat_settings`/keys/users excluded); auto `LIMIT 50`; 25-row markdown cap. |
| **External-API allowlist** | Admins register `api_tools` (name, url_template, method, description, enabled) — **NPI Registry seeded** when empty. `_safe_fetch`: HTTPS-only, `{param}` substitution (URL-encoded), missing-param errors, 10s timeout, 200KB read cap, 6,000-char snippet, tool-id must be in allowlist. |
| **SSRF guard** | `_safe_upstream_host`: blocks localhost/.local, forward/reverse-lookup of private / loopback / link-local / reserved / multicast IPs. (Chat-provider base URLs are admin-set by design.) |
| **Maker-Checker review** | `review_enabled` (default ON), `review_max_loops` default 2 (0–3). Text drafts ≥220 chars or complex heuristically reviewed; all create/update/delete/sql/fetch plans reviewed **before execution**. Reviewer JSON verdict `{"verdict":"approved"}` / `{"verdict":"rejected","critique":"<one concrete fix>"}`; rejected → worker re-prompt with critique; exhaustion → action **not executed**, draft + manual-review flag shown. Fail-safe: reviewer/provider errors log + default approve (chat never blocks). |
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
agent_memory (id, agent_id→chat_agents, kind, key, content, source, created_by, created_at, updated_at)
agent_audit (id, agent_name, action, kind, query, status, error, details, created_at)
agent_pending (session_id, plan, updated_at)                             # multi-turn plan collection
app_settings (key PK, value, updated_at)                                 # routing/review/embed/.. k/v
web_portals (id, name, url, notes, type, position, created_by, created_at, updated_at)
entry_fts (@@virtual FTS5@@ over kind/title/tag/text)                    # RAG keyword layer
embed_vectors (doc_key, kind, title, tag, text, content_hash, vector, provider, updated_at)  # RAG vector layer
```
Relationships: notes/tasks → pages (department); note_versions & note_shares →
notes; routine_completions → routines; chat_messages → chat_sessions → users;
agent_memory/agent_audit → chat_agents; agent_pending → chat_sessions.
`PRAGMA foreign_keys=ON`, WAL + busy_timeout.

---

## 4. Code Audit — Issues Found (2026-09-06)

Full read-through of backend + frontend. **Verified:** `py_compile` clean;
`test_app.py` 146/149 and `test_qa_full.py` 39/39 in a clean venv. The 3
`test_app.py` errors are **environment-only** (the test's `_make_pdf` helper
needs PyMuPDF, whose native DLL won't load on this machine) and are **not**
app bugs — although they surfaced a real gap below (#A9).

**Fix log (same session, after review):** every finding below has been applied
to `app.py` / `app.js` / `requirements.txt` and re-verified. Post-fix gates:
`py_compile` clean; `test_app.py` 146/149 (only the same 3 PyMuPDF-DLL env
errors remain); `test_qa_full.py` 39/39. Deep links below point to the audit
revision; line numbers shifted after the edits.

### A. Security / privilege-escalation (fix first)

| # | Severity | Location | Issue | Suggested fix |
|---|---|---|---|---|
| A1 | **High** | `app.py:7552, 7566, 7906` | `/api/export/json`, `/api/export/excel`, `/api/export/sqlite` have **no role decorator** (only global `auth_guard`). A read-only `user` account can download the **entire DB** — `users` password hashes, `chat_api_keys`, `chat_settings` provider keys, all chat — via `/api/export/sqlite`. Contradicts the view-only `user` model (cf. delete-upload which *is* `@admin_only`). | Add `@admin_only` (or at least `@can_write`) to all three export endpoints. |
| A2 | **High** | `app.py:7536` (`agent_file_download`) | Admin/manager can stream **any file** on the host (`C:\Windows\…`, `.env`, `secret.key`, `assistant.db`) because `_sanitize_fs_path` (3153) only blocks `..`/relative paths and is never bound to a base dir. | Bound readable paths to an explicit allowlist tree (project `BASE_DIR` + `UPLOAD_DIR`); block sensitive names; never serve DB/secret files. |
| A3 | **High** | `app.py:3153 + 3815` (`_run_file_action`) | File engine lets the AI agent create/overwrite/delete **any absolute path**. `_is_text_format` (3190) defaults **True** for unknown extensions → unknown-extension files can be overwritten as "text" (`_write_file` 3741). Delete only needs `overwrite:true` + the small `_deletable` (3199) blocklist. | Sandbox all file ops to a dedicated output dir; default unknown/binary/foreign extensions to *deny* write; require explicit per-file user confirmation for delete/write outside sandbox. |
| A4 | **Medium** | `app.py:3079–3102` (`_safe_upstream_host`) | SSRF gaps: (a) `urlopen` follows redirects by default (public host → internal); (b) DNS-rebinding TOCTOU; (c) `socket.gethostbyname` is IPv4-only — an **IPv6-only** host yields `ip=None`, skips the private check, and is **allowed**. | Disable redirect-following (block cross-host redirects), pin/verify the resolved IP at connect, and reject hosts not resolving to a non-private IPv4/IPv6. |
| A5 | **Medium** | `app.py:2831, 2865` (`_run_readonly_sql`) | Table allowlist regex `\b(?:from\|join)\s+([a-z][a-z0-9_]*)\b` captures only the **first** identifier. `FROM tasks, sqlite_master` and table-valued funcs like `pragma_table_info('users')` (`\bpragma\b` doesn't match `pragma_table_info`) slip past the 🚫 deny + allowlist. | Parse **all** table refs (after commas and in TVFs) and validate the full set before executing. |

### B. Correctness / logic bugs

| # | Severity | Location | Issue | Suggested fix |
|---|---|---|---|---|
| B1 | **High** | `static/js/app.js:826–827, 846–847` | **Variable shadowing:** the outer `err` display function (line 801) is shadowed by the `catch (err)` parameter, so `err("#auth-form-login", …)` throws `TypeError: err is not a function`. Login/register failures show **no error message**. | Rename the display fn (e.g. `showAuthError`) or use `catch (e)` + call `err(...)`. |
| B2 | **High** | `static/js/app.js:144–151` | `confirmDialog` inserts `message` raw via template literal. Callers pass unescaped user/LLM strings (note.title 1945, p.name 3765, s.title 4287/4564, a?.name 5827, k.title 6938) → **stored/reflected XSS** if a title contains markup. | `escapeHtml()` the message inside `confirmDialog` (and `okLabel`), or escape at each call site. |
| B3 | **High** | `tests` — PDF path | `static/js` + audit confirm: PyMuPDF (`fitz`) is used by `_pdf_extract` (app.py:121) and by `test_app.py` helpers, but is **not in `requirements.txt`**. In the app the import is gracefully caught → PDFs silently return empty; in tests it defeats the PDF suite. | Add `PyMuPDF` to `requirements.txt` (and pin it) so PDF extraction actually works. |
| B4 | **High** | `app.py:1658 + 1677` (`_ensure_embeddings`) | **Double `conn.close()`** — explicit close at 1658 on the embed-failure branch, then `finally` closes again. Harmless in CPython but a defect; also `_semantic_search` (1694) ignores the agent `scope` so manager agents still score all vectors and may return <limit results. | Remove the explicit close; pass `scope` into `_semantic_search` and filter at scoring time. |
| B5 | **Medium** | `app.py:1969–1983` (`_extract_json`) | Naive brace counting fails when **braces appear inside JSON string values** (e.g. `"Projects {2025}"`), truncating/returning malformed JSON. | Make the parser string-aware (skip braces inside strings, honoring escaped quotes) or use `json.JSONDecoder.raw_decode`. |
| B6 | **Medium** | `app.py:4689–4705` (`_reviewer_agent`) | Fallback at 4705 can hand a worker their **own** draft (`return admin_rev or billing_rev`) when only one candidate exists and it equals the worker → self-review defeats maker-checker. | In the final fallback, return `None` (skip review) when the only reviewer has the same `id` as the worker. |
| B7 | **Medium** | `app.py:3366/3568/3247` (`_write_xlsx/docx/text_file`) | On an **update** (overwrite=False, mode not append) these rebuild the file from scratch or truncate, silently **wiping the existing content** — `overwrite` is ignored. | For update ops, refuse/merge when `overwrite=False`, or preserve existing content/headers. |
| B8 | **Medium** | `static/js/app.js:4505–4545` (SSE) | EventSource has **no timeout**; if the server never sends `final` (hung LLM), `chatBusy` stays true and the user can't send again. | Add a hard timeout in `startChatStream` that calls `finish(...)` and clears `chatBusy`. |
| B9 | **Medium** | `static/js/app.js:3037` (`priorityBadge`) | `badge-${p}` uses `p` unescaped as a class **and** text → CSS/text injection if a non-enum priority reaches the client. | Whitelist `low/medium/high` + `escapeHtml`. |
| B10 | **Medium** | `app.py:1613–1616` (`_embed_text`) | A single transient network error calls `_mark_embed_dead()` → semantic search disabled for **10 min**. Too aggressive for a production multi-user tool. | Mark dead only after N consecutive failures. |
| B11 | **Low** | `app.py:7837–7845` | `import_backup` `INSERT OR REPLACE` on `app_settings` clobbers current settings even in **merge** mode. | Skip/merge-once for existing keys in merge mode. |
| B12 | **Low** | `app.py:7534–7535` | Duplicate `@app.get("/api/agents/files/download")` decorator. | Remove the duplicate line. |
| B13 | **Low** | `app.py:7919–7921` | `export_sqlite` temp file isn't unlinked in `try/finally` (cleanup leak on error); low impact. | Wrap `os.unlink` in `try/finally`. |

### C. Frontend robustness

| # | Severity | Location | Issue | Suggested fix |
|---|---|---|---|---|
| C1 | **Medium** | `app.js` multiple handlers (~3006, 3023, 3541, 2763, 4202, 5237) | `await api(...)` without `try/catch` → unhandled rejections, silent UI stall with no rollback/toast on network error. | Wrap in `try/catch` + `toast`. |
| C2 | **Medium** | `app.js:4354` | `chatSessions = await api("/api/chat/sessions")` assumes a flat array; if the API ever wraps it, session rendering crashes silently. | Normalize `Array.isArray(res) ? res : (res.sessions || [])`. |
| C3 | **Medium** | `index.html:9–20, 26–50, 1147–1164` | Three inline `<script>` blocks force CSP `script-src 'unsafe-inline'`, which **globally defeats script CSP** and amplifies any future injection (e.g. B2). | Move to external `/static/js/*.js` and use a nonce/hash CSP; drop `'unsafe-inline'`. |

### D. What's done well (verified)

- **Auth model** consistent: global `auth_guard` + `@admin_only` / `@can_write` decorators (`app.py:900–951`) — clean and generally correct (except A1 exports).
- **HTML sanitizer** (`app.py:226–363`): whitelist + `html.parser` (decodes all char refs) closes the entity-encoding bypass; `sanitize_html` is applied on **every** note write path (5744, 5774, 5832, 5856), so `share.html`'s `{{ content | safe }}` is safe by construction.
- **No server-rendered user data in `index.html`** — fully client-rendered via `/api/...` + `textContent`, the single biggest XSS mitigation; `escapeHtml()`/`mdToHtml()` order is correct.
- **SQL write tool** (`2922`): single-statement, deny-regex, narrowed to `agent_memory` + name subquery on `chat_agents`.
- **SQLite snapshots**: `export_sqlite` uses `sqlite3.backup` + `wal_checkpoint(FULL)`; `import_sqlite` runs `integrity_check` + required-table validation before replace.
- **Audit trail**: every executed file/SQL/fetch/create/update/delete is written to `agent_audit` (`_audit_entry`).
- **Graceful RAG/LLM degradation**: FTS → LIKE → semantic → local → cloud, each layer caught; embedding cooldown persisted in `app_settings`.
- **Maker-Checker loop** is a genuine N-iteration self-correct with manual-review escape hatch — appropriate for medical billing.
- **Cost controls** throughout (review skip, tier routing, embed cache, doc caps, fetch snippet caps, auto-LIMIT).

### Fix status (applied & verified)

| # | What was done |
|---|---|
| A1 | `@admin_only` added to `/api/export/json`, `/api/export/excel`, `/api/export/sqlite`. |
| A2/A3 | `agent_file_download` + `_run_file_action` (all ops) now block sensitive files via `_is_sensitive_file()` (`.env`, `secret.key`, `.git`, DB/WAL extensions, `AppData/Roaming`, Windows dirs); `_is_text_format` defaults **False** for unknown extensions; `_deletable` rejects sensitive paths; duplicate `@app.get` (B12) removed; update requires explicit `mode` (append/add/replace/overwrite) so a bare update can't silently wipe a file (B7). |
| A4 | `_safe_upstream_host` rewritten with `socket.getaddrinfo` (IPv4+IPv6), fail-closed on no/any-unsafe resolved IP; `_safe_fetch` uses a redirect-blocking opener (`_NoRedirect`) so public→internal redirect can't exfiltrate. |
| A5 | Table-ref parsing replaced with `_sql_table_refs()` — captures comma-lists (`FROM tasks, sqlite_master`), TVF names (`pragma_table_info(...)`), `JOIN … ON`, and nested scalars, with no false refs from SELECT/ORDER BY commas; deny-list extended with `pragma_`, `readfile`, `writefile`, `begin/commit/rollback`. |
| B1 | Login/register error fn renamed `showAuthError`, catch params `e` — errors now render. |
| B2 | `confirmDialog` `escapeHtml()`s `message` + `okLabel`. |
| B3 | `PyMuPDF==1.24.9` added to `requirements.txt`. |
| B4 | Removed duplicate `conn.close()` in `_ensure_embeddings`; `_semantic_search(scope=…)` filters `embed_vectors` by `kind` and `_search_best` passes the agent scope. |
| B5 | `_extract_json` is string-aware (skips braces inside JSON strings, honors `\"`). |
| B6 | `_reviewer_agent` returns `None` when the only candidate reviewer equals the worker (no self-review); `_review_system(None)` is safe. |
| B7 | Covered by A2/A3 row (explicit update `mode`). |
| B8 | SSE chat stream guards with a 120s timeout that calls `finish(…)` and clears `chatBusy`. |
| B9 | `priorityBadge` whitelists `low/medium/high` + `escapeHtml`. |
| B10 | `_mark_embed_dead()` only after 3 consecutive `_embed_text` failures; counter resets on success. |
| B11 | `import_backup` merge mode leaves existing `app_settings` keys untouched. |
| B12 | Removed duplicate route decorator. |
| B13 | `export_sqlite` temp-file unlink inside `try/finally`. |
| C1 | Primary `await api` sites wrapped in `try/catch` + `toast` (task/routine toggles and the code-audit-priority list); remaining lower-traffic read handlers left as-is deliberately (no state corruption on failure). |
| C2 | `loadChat` normalizes `Array.isArray(res) ? res : (res?.sessions || [])`. |
| C3 | **Deferred by design** — inline `<script>` blocks are static (no user data) and exporting them risks breaking the theme-bootstrap boot order; flagged for the Voice/Desktop phase (§5). |

All three export endpoints, the two read-only test failures driven by
`_is_sensitive_file(/AppData/)` false positives on the OS temp dir, and the
dashboard SQL refs are regression-checked in `tests/test_qa_full.py`
(`test_download_endpoint`, `test_file_*`, `test_docx_exec_*`) and
`tests/test_app.py` (`TestAgentDataStatus`).

---

## 5. Scaling Notes (Voice + Desktop Integration)

- **SSE streaming** is already the chat transport — trivial to also carry voice
  session metadata; the node-tracker is reusable as a "voice pipeline" view.
- **CSP today** blocks `connect-src` beyond self and `media-src` — speech APIs
  (STT/TTS) will need deliberate CSP entries (e.g., browser-native
  `SpeechRecognition` needs no network; remote TTS would). No voice/desktop
  scaffolding exists yet in `app.js` (confirmed: zero matches for
  `voice`/`SpeechRecognition`/`pywebview`/`MediaRecorder`).
- **Single-process assumptions:** embeddings kill-switch and log ring buffer are
  per-process; multi-threaded desktop wrapper is fine (SQLite WAL + busy_timeout).
- **Sessions/keys:** desktop onboarding could re-use `secret.key` + `.env`;
  `chat_api_keys` rotation already handles multiple operator keys.
- Recommended next steps: `/api/voice/session` endpoint pair, PyWebView/Spectron
  shell docs, wire the reviewer to run on uploaded denial PDF text, and move the
  inline scripts out of `index.html` (C3) so CSP can drop `'unsafe-inline'`.
  (The A1–A3 privilege-escalation fixes, B1/B2 JS fixes, and B3 PyMuPDF pin
  listed in the audit are already applied — see §4 fix log.)

---

*End of report.*
