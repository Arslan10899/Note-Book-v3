import html
import json
import logging
import os
import re
import secrets
import sqlite3
import tempfile
import time
import uuid
from html.parser import HTMLParser
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from functools import wraps
from io import BytesIO
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_file, send_from_directory, session
from PIL import Image
from werkzeug.security import check_password_hash, generate_password_hash

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("assistant")

BASE_DIR = Path(__file__).parent
# Overridable via env so tests (and multiple instances) never touch real data
DB_PATH = Path(os.environ.get("ASSISTANT_DB", str(BASE_DIR / "assistant.db")))
UPLOAD_DIR = Path(os.environ.get("ASSISTANT_UPLOADS", str(BASE_DIR / "uploads")))
UPLOAD_DIR.mkdir(exist_ok=True)
PRIORITIES = {"low", "medium", "high"}
MAX_UPLOAD_SIZE = 5 * 1024 * 1024

app = Flask(__name__)

# Persistent random secret key so login sessions survive server restarts
_SECRET_FILE = BASE_DIR / "secret.key"
if not _SECRET_FILE.exists():
    _SECRET_FILE.write_text(secrets.token_hex(32))
app.secret_key = _SECRET_FILE.read_text().strip()
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(days=30)
app.config["SESSION_COOKIE_HTTPONLY"] = True
# Lax blocks cross-site cookies on POST/PUT/DELETE (a solid CSRF mitigation)
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
# Enable behind HTTPS with: COOKIE_SECURE=1
app.config["SESSION_COOKIE_SECURE"] = os.environ.get("COOKIE_SECURE") == "1"


@app.after_request
def no_cache_html(response):
    if response.content_type.startswith("text/html"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.after_request
def apply_security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src https://fonts.gstatic.com; "
        "img-src 'self' data:; "
        "connect-src 'self'; "
        "frame-ancestors 'none'; "
        "base-uri 'self'; "
        "form-action 'self'",
    )
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    if request.path.startswith("/s/"):
        response.headers["X-Robots-Tag"] = "noindex, nofollow"
    return response


def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        conn.execute("PRAGMA journal_mode = WAL")
    except sqlite3.Error:
        pass
    conn.execute("PRAGMA busy_timeout = 10000")
    return conn


def now_stamp():
    # Always store UTC so timestamps are consistent regardless of server timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


# ================= HTML sanitizer (whitelist-based) =================
# Notes/pages are rich text rendered with innerHTML, so we only ever emit a
# strict whitelist of tags/attributes. html.parser decodes ALL character
# references (e.g. &#60;script&#62; -> <script>), which closes the entity-
# encoding bypass that plagues regex-only sanitizers.

SANITIZE_ALLOWED_TAGS = {
    "p", "br", "b", "strong", "i", "em", "u", "s", "strike",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "a", "img", "table", "thead", "tbody", "tr", "td", "th",
    "colgroup", "col", "code", "pre", "blockquote", "span", "div", "sub", "sup", "hr",
}
# Tags we drop together with their entire subtree content
SANITIZE_DROP_TAGS = {
    "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet",
    "form", "input", "textarea", "select", "button", "noscript", "template",
    "svg", "math", "video", "audio", "source", "track", "base", "meta", "link",
    "title", "marquee", "dialog", "canvas", "portal",
}
SANITIZE_ALLOWED_ATTRS = {
    "a": {"href", "target", "rel"},
    "img": {"src", "alt", "width", "height", "loading", "style"},
    "span": {"style"},
    "div": {"style"},
    "ul": {"data-task"},
    "td": {"style"},
    "th": {"style"},
    "table": {"style"},
    "col": {"style", "span"},
    "colgroup": {"style"},
}
VOID_ELEMENTS = {"br", "img", "hr", "col"}


def _safe_url(value, image=False):
    v = (value or "").strip()
    # whitespace-insensitive scheme block (defeats java\tscript:/java\nscript:)
    compact = re.sub(r"\s+", "", v.lower())
    if compact.startswith(("javascript:", "vbscript:", "data:", "file:")):
        return None
    low = v.lower()
    if image:
        if low.startswith("/") or low.startswith("http://") or low.startswith("https://"):
            return value
        return None
    if low.startswith(("#", "/", "http://", "https://", "mailto:", "tel:")):
        return value
    return None


def _safe_style(value):
    v = re.sub(r"url\s*\(\s*['\"]?[^)'\"]*['\"]?\s*\)", "", value or "", flags=re.I)
    v = re.sub(r"expression\s*\(", "blocked(", v, flags=re.I)
    if re.search(r"(?i)javascript\s*:|vbscript\s*:|data\s*:|\bbehavior\s*:|@import", v):
        return None
    return v


class _SanitizeParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skip = 0  # depth of blocked (dangerous) subtree

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if self.skip:
            if tag not in VOID_ELEMENTS:
                self.skip += 1
            return
        if tag in SANITIZE_DROP_TAGS:
            self.skip = 1
            return
        if tag not in SANITIZE_ALLOWED_TAGS:
            return  # drop the tag, keep its text (escaped later)
        allowed = SANITIZE_ALLOWED_ATTRS.get(tag, ())
        out = []
        for k, val in attrs:
            k = k.lower()
            if k not in allowed:
                continue
            if k == "href":
                safe = _safe_url(val)
                if safe is None:
                    continue
                val = safe
            elif k == "src":
                safe = _safe_url(val, image=True)
                if safe is None:
                    continue
                val = safe
                if tag == "img":
                    val = re.sub(r"^//", "https://", val)
            elif k == "rel" and tag == "a":
                val = " ".join(w for w in val.split() if w in ("noopener", "noreferrer", "nofollow"))
            elif k == "style":
                val = _safe_style(val)
                if val is None:
                    continue
            val = html.escape(val.strip(), quote=True)
            out.append(f' {k}="{val}"')
        self.parts.append(f"<{tag}{''.join(out)}>")

    def handle_startendtag(self, tag, attrs):
        # self-closing form of an allowed tag, or a blocked one: just treat as start
        tag = tag.lower()
        if self.skip:
            return
        if tag in SANITIZE_ALLOWED_TAGS:
            self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        tag = tag.lower()
        if self.skip:
            if tag not in VOID_ELEMENTS:
                self.skip -= 1
            return
        if tag in SANITIZE_ALLOWED_TAGS and tag not in VOID_ELEMENTS:
            self.parts.append(f"</{tag}>")

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(html.escape(data, quote=False))

    def handle_comment(self, data):
        pass  # comments never survive

    def handle_decl(self, decl):
        pass  # no DOCTYPE

    def handle_pi(self, data):
        pass


def sanitize_html(value):
    if not value:
        return ""
    parser = _SanitizeParser()
    try:
        parser.feed(str(value))
        parser.close()
    except Exception:
        return ""
    return "".join(parser.parts).strip()


def clean_tags(raw):
    if raw is None:
        return ""
    seen = set()
    out = []
    for part in str(raw).split(","):
        tag = part.strip().lstrip("#").strip()
        if not tag:
            continue
        key = tag.lower()
        if key not in seen:
            seen.add(key)
            out.append(tag)
    return ", ".join(out)


def within_throttle(prev_stamp, now_stamp, seconds=30):
    try:
        prev = datetime.strptime(prev_stamp, "%Y-%m-%d %H:%M:%S")
        cur = datetime.strptime(now_stamp, "%Y-%m-%d %H:%M:%S")
        return (cur - prev).total_seconds() < seconds
    except (TypeError, ValueError):
        return False


SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'medium',
    due_date TEXT,
    done INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT '',
    page_id INTEGER
);
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    tags TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT '',
    page_id INTEGER
);
CREATE TABLE IF NOT EXISTS note_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS routines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    weekday INTEGER NOT NULL DEFAULT 0,
    time TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS routine_completions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    routine_id INTEGER NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    completed_date TEXT NOT NULL,
    UNIQUE(routine_id, completed_date)
);
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS note_shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_tasks_page_id ON tasks(page_id);
CREATE INDEX IF NOT EXISTS idx_notes_page_id ON notes(page_id);
CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at);
CREATE INDEX IF NOT EXISTS idx_note_versions_note_id ON note_versions(note_id);
CREATE INDEX IF NOT EXISTS idx_routine_completions_routine_id ON routine_completions(routine_id);
CREATE INDEX IF NOT EXISTS idx_routine_completions_date ON routine_completions(completed_date);
CREATE INDEX IF NOT EXISTS idx_note_shares_token ON note_shares(token);
CREATE INDEX IF NOT EXISTS idx_note_shares_note_id ON note_shares(note_id);
"""


def migrate_db():
    conn = get_db()
    try:
        task_cols = [r[1] for r in conn.execute("PRAGMA table_info(tasks)").fetchall()]
        if "page_id" not in task_cols:
            conn.execute("ALTER TABLE tasks ADD COLUMN page_id INTEGER")
        note_cols = [r[1] for r in conn.execute("PRAGMA table_info(notes)").fetchall()]
        if "page_id" not in note_cols:
            conn.execute("ALTER TABLE notes ADD COLUMN page_id INTEGER")
        page_cols = [r[1] for r in conn.execute("PRAGMA table_info(pages)").fetchall()]
        if "icon" not in page_cols:
            conn.execute("ALTER TABLE pages ADD COLUMN icon TEXT NOT NULL DEFAULT ''")
        conn.executescript(
            """
            CREATE INDEX IF NOT EXISTS idx_tasks_page_id ON tasks(page_id);
            CREATE INDEX IF NOT EXISTS idx_notes_page_id ON notes(page_id);
            CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at);
            CREATE INDEX IF NOT EXISTS idx_note_versions_note_id ON note_versions(note_id);
            CREATE INDEX IF NOT EXISTS idx_routine_completions_routine_id ON routine_completions(routine_id);
            CREATE INDEX IF NOT EXISTS idx_routine_completions_date ON routine_completions(completed_date);
            CREATE TABLE IF NOT EXISTS note_shares (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token TEXT UNIQUE NOT NULL,
                note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_note_shares_token ON note_shares(token);
            CREATE INDEX IF NOT EXISTS idx_note_shares_note_id ON note_shares(note_id);
            """
        )
        conn.commit()
    finally:
        conn.close()


def init_db():
    conn = get_db()
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()
    migrate_db()


# ---------------- Authentication ----------------

def public_user(row):
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"] or row["username"],
        "role": row["role"],
        "created_at": row["created_at"],
    }


def current_user():
    uid = session.get("uid")
    if not uid:
        return None
    conn = get_db()
    try:
        return conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
    finally:
        conn.close()


@app.before_request
def auth_guard():
    p = request.path
    if (
        p.startswith("/api/auth/")
        or p.startswith("/static")
        or (request.method == "GET" and p == "/")
        or (request.method == "GET" and p.startswith("/s/"))
        # Images referenced from public share pages must load without a session
        or (request.method == "GET" and p.startswith("/uploads/"))
    ):
        return None
    if not session.get("uid"):
        return jsonify({"error": "Not authenticated"}), 401
    return None


def admin_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        u = current_user()
        if not u or u["role"] != "admin":
            return jsonify({"error": "Admin access required"}), 403
        return fn(*args, **kwargs)

    return wrapper


WRITE_ROLES = ("admin", "manager")


def role_required(roles):
    """roles: iterable of allowed roles for this endpoint."""

    def deco(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            u = current_user()
            if not u:
                return jsonify({"error": "Not authenticated"}), 401
            if u["role"] not in roles:
                return jsonify({"error": "Your account does not have permission for this action"}), 403
            return fn(*args, **kwargs)

        return wrapper

    return deco


can_write = role_required(WRITE_ROLES)      # add / edit data
admin_only = role_required(("admin",))      # delete & destructive ops


# ---------------- Brute-force throttling (in-memory, per IP) ----------------

_failed_attempts = defaultdict(list)
AUTH_WINDOW_SEC = 300
AUTH_MAX_ATTEMPTS = 5
REGISTER_WINDOW_SEC = 300
REGISTER_MAX_ATTEMPTS = 10


def _authed_key(kind):
    return "%s|%s" % (kind, request.remote_addr or "0.0.0.0")


def _check_throttle(kind, limit, window):
    key = _authed_key(kind)
    now = time.time()
    _failed_attempts[key] = [t for t in _failed_attempts[key] if now - t < window]
    if len(_failed_attempts[key]) >= limit:
        retry = int(window - (now - _failed_attempts[key][0]))
        return max(retry, 1)
    return None


def _record_failure(kind):
    _failed_attempts[_authed_key(kind)].append(time.time())


def _reset_throttle(kind):
    _failed_attempts.pop(_authed_key(kind), None)


@app.post("/api/auth/register")
def auth_register():
    retry = _check_throttle("register", REGISTER_MAX_ATTEMPTS, REGISTER_WINDOW_SEC)
    if retry:
        return jsonify({"error": f"Too many registration attempts. Please wait {retry}s."}), 429
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip().lower()
    password = str(data.get("password") or "")
    display_name = (data.get("display_name") or "").strip()[:60]
    if not re.fullmatch(r"[a-z0-9_.]{3,24}", username):
        _record_failure("register")
        return jsonify({"error": "Username: 3-24 chars, letters/numbers/._ only"}), 400
    if len(password) < 6:
        _record_failure("register")
        return jsonify({"error": "Password must be at least 6 characters"}), 400
    conn = get_db()
    try:
        count = conn.execute("SELECT COUNT(*) c FROM users").fetchone()["c"]
        role = "admin" if count == 0 else "user"
        cur = conn.execute(
            "INSERT INTO users (username, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)",
            (username, generate_password_hash(password), display_name or username, role, now_stamp()),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()
    except sqlite3.IntegrityError:
        _record_failure("register")
        return jsonify({"error": "Username already taken"}), 400
    finally:
        conn.close()
    _reset_throttle("register")
    session.clear()
    session["uid"] = row["id"]
    session.permanent = True
    logger.info("user registered: id=%s username=%s role=%s", row["id"], row["username"], row["role"])
    return jsonify(public_user(row)), 201


@app.post("/api/auth/login")
def auth_login():
    retry = _check_throttle("login", AUTH_MAX_ATTEMPTS, AUTH_WINDOW_SEC)
    if retry:
        return jsonify({"error": f"Too many failed attempts. Please wait {retry}s."}), 429
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip().lower()
    password = str(data.get("password") or "")
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    finally:
        conn.close()
    if not row or not check_password_hash(row["password_hash"], password):
        _record_failure("login")
        logger.warning("failed login attempt for username=%s from %s", username, request.remote_addr)
        return jsonify({"error": "Invalid username or password"}), 401
    _reset_throttle("login")
    session.clear()
    session["uid"] = row["id"]
    session.permanent = True
    logger.info("user logged in: id=%s username=%s", row["id"], row["username"])
    return jsonify(public_user(row))


@app.post("/api/auth/logout")
def auth_logout():
    session.clear()
    return jsonify({"ok": True})


@app.get("/api/auth/me")
def auth_me():
    u = current_user()
    if not u:
        return jsonify({"error": "Not authenticated"}), 401
    return jsonify(public_user(u))


@app.put("/api/auth/profile")
def auth_update_profile():
    u = current_user()
    if not u:
        return jsonify({"error": "Not authenticated"}), 401
    data = request.get_json(silent=True) or {}
    display_name = (data.get("display_name") or "").strip()[:60] or u["display_name"]
    username = (data.get("username") or u["username"]).strip().lower()
    if not re.fullmatch(r"[a-z0-9_.]{3,24}", username):
        return jsonify({"error": "Username: 3-24 chars, letters/numbers/._ only"}), 400
    conn = get_db()
    try:
        if username != u["username"]:
            dup = conn.execute("SELECT id FROM users WHERE username = ? AND id != ?", (username, u["id"])).fetchone()
            if dup:
                return jsonify({"error": "Username already taken"}), 400
        conn.execute("UPDATE users SET username = ?, display_name = ? WHERE id = ?", (username, display_name, u["id"]))
        conn.commit()
        row = conn.execute("SELECT * FROM users WHERE id = ?", (u["id"],)).fetchone()
    finally:
        conn.close()
    return jsonify(public_user(row))


@app.put("/api/auth/password")
def auth_change_password():
    u = current_user()
    if not u:
        return jsonify({"error": "Not authenticated"}), 401
    data = request.get_json(silent=True) or {}
    current_pw = str(data.get("current_password") or "")
    new_pw = str(data.get("new_password") or "")
    if not check_password_hash(u["password_hash"], current_pw):
        return jsonify({"error": "Current password is incorrect"}), 400
    if len(new_pw) < 6:
        return jsonify({"error": "New password must be at least 6 characters"}), 400
    conn = get_db()
    try:
        conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (generate_password_hash(new_pw), u["id"]))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True})


@app.get("/api/auth/users")
@admin_required
def auth_list_users():
    conn = get_db()
    try:
        rows = conn.execute("SELECT * FROM users ORDER BY id").fetchall()
    finally:
        conn.close()
    return jsonify([public_user(r) for r in rows])


@app.patch("/api/auth/users/<int:user_id>")
@admin_required
def auth_update_user(user_id):
    data = request.get_json(silent=True) or {}
    role = data.get("role")
    if role not in ("admin", "manager", "user"):
        return jsonify({"error": "Role must be admin, manager or user"}), 400
    me = current_user()
    if me["id"] == user_id and role != "admin":
        return jsonify({"error": "You cannot remove your own admin role"}), 400
    conn = get_db()
    try:
        cur = conn.execute("UPDATE users SET role = ? WHERE id = ?", (role, user_id))
        conn.commit()
        if cur.rowcount == 0:
            return jsonify({"error": "User not found"}), 404
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    finally:
        conn.close()
    return jsonify(public_user(row))


@app.delete("/api/auth/users/<int:user_id>")
@admin_required
def auth_delete_user(user_id):
    me = current_user()
    if me["id"] == user_id:
        return jsonify({"error": "You cannot delete your own account"}), 400
    conn = get_db()
    try:
        admins = conn.execute("SELECT COUNT(*) c FROM users WHERE role = 'admin'").fetchone()["c"]
        target = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if not target:
            return jsonify({"error": "User not found"}), 404
        if target["role"] == "admin" and admins <= 1:
            return jsonify({"error": "Cannot delete the last admin"}), 400
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True})


def clean_page_id(value):
    if value in (None, "", 0, "0", False):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def validate_task_payload(data, partial=False):
    errors = []
    out = {}
    if not partial or "title" in data:
        title = (data.get("title") or "").strip()
        if not title:
            errors.append("Title is required")
        else:
            out["title"] = title
    if "description" in data:
        out["description"] = (data.get("description") or "").strip()
    if "priority" in data:
        priority = data.get("priority") or "medium"
        if priority not in PRIORITIES:
            errors.append("Priority must be low, medium or high")
        else:
            out["priority"] = priority
    if "due_date" in data:
        due = data.get("due_date") or None
        if due:
            try:
                date.fromisoformat(due)
            except ValueError:
                errors.append("Due date must be YYYY-MM-DD")
        out["due_date"] = due
    if "done" in data:
        out["done"] = 1 if data.get("done") in (True, 1, "true", "1") else 0
    if "page_id" in data:
        out["page_id"] = clean_page_id(data.get("page_id"))
    return out, errors


@app.get("/api/tasks")
def list_tasks():
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM tasks ORDER BY done ASC, CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date ASC, id DESC"
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.post("/api/tasks")
@can_write
def create_task():
    data = request.get_json(silent=True) or {}
    payload, errors = validate_task_payload(data)
    if errors:
        return jsonify({"error": "; ".join(errors)}), 400
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO tasks (title, description, priority, due_date, created_at, page_id) VALUES (?, ?, ?, ?, ?, ?)",
        (payload["title"], payload.get("description", ""), payload.get("priority", "medium"),
         payload.get("due_date"), now_stamp(), payload.get("page_id")),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (cur.lastrowid,)).fetchone()
    conn.close()
    return jsonify(dict(row)), 201


@app.patch("/api/tasks/<int:task_id>")
@can_write
def update_task(task_id):
    data = request.get_json(silent=True) or {}
    payload, errors = validate_task_payload(data, partial=True)
    if errors:
        return jsonify({"error": "; ".join(errors)}), 400
    if not payload:
        return jsonify({"error": "Nothing to update"}), 400
    conn = get_db()
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        conn.close()
        return jsonify({"error": "Task not found"}), 404
    fields = dict(row)
    fields.update(payload)
    completed_at = fields["completed_at"]
    if "done" in payload:
        completed_at = now_stamp() if payload["done"] else None
    conn.execute(
        "UPDATE tasks SET title=?, description=?, priority=?, due_date=?, done=?, completed_at=?, page_id=? WHERE id=?",
        (fields["title"], fields["description"], fields["priority"], fields["due_date"],
         fields["done"], completed_at, fields.get("page_id"), task_id),
    )
    conn.commit()
    updated = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    conn.close()
    return jsonify(dict(updated))


@app.delete("/api/tasks/<int:task_id>")
@admin_only
def delete_task(task_id):
    conn = get_db()
    cur = conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        return jsonify({"error": "Task not found"}), 404
    return jsonify({"ok": True})


@app.get("/api/notes")
def list_notes():
    conn = get_db()
    rows = conn.execute(
        "SELECT id, title, content, pinned, tags, created_at, updated_at, page_id FROM notes ORDER BY pinned DESC, updated_at DESC"
    ).fetchall()
    conn.close()
    # Re-sanitize on read so legacy rows written by the old regex sanitizer can
    # never inject entity-encoded markup into the client.
    return jsonify([{**dict(r), "content": sanitize_html(r["content"])} for r in rows])


@app.post("/api/notes")
@can_write
def create_note():
    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()
    content = sanitize_html((data.get("content") or "").strip())
    if not title:
        return jsonify({"error": "Title is required"}), 400
    tags = clean_tags(data.get("tags")) if "tags" in data else ""
    pinned = 1 if data.get("pinned") in (True, 1, "true", "1") else 0
    page_id = clean_page_id(data.get("page_id")) if "page_id" in data else None
    stamp = now_stamp()
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO notes (title, content, pinned, tags, created_at, updated_at, page_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (title, content, pinned, tags, stamp, stamp, page_id),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM notes WHERE id = ?", (cur.lastrowid,)).fetchone()
    conn.close()
    return jsonify(dict(row)), 201


@app.put("/api/notes/<int:note_id>")
@can_write
def update_note(note_id):
    data = request.get_json(silent=True) or {}
    conn = get_db()
    row = conn.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
    if row is None:
        conn.close()
        return jsonify({"error": "Note not found"}), 404
    title = (data.get("title") or "").strip() or row["title"]
    content = sanitize_html(str(data.get("content", row["content"])))
    tags = clean_tags(data.get("tags")) if "tags" in data else row["tags"]
    pinned = row["pinned"]
    if "pinned" in data:
        pinned = 1 if data.get("pinned") in (True, 1, "true", "1") else 0
    page_id = row["page_id"]
    if "page_id" in data:
        page_id = clean_page_id(data.get("page_id"))
    stamp = now_stamp()
    if content != row["content"]:
        last = conn.execute(
            "SELECT content, created_at FROM note_versions WHERE note_id = ? ORDER BY id DESC LIMIT 1",
            (note_id,),
        ).fetchone()
        if last is None or last["content"] != row["content"] or not within_throttle(last["created_at"], stamp):
            conn.execute(
                "INSERT INTO note_versions (note_id, title, content, created_at) VALUES (?, ?, ?, ?)",
                (note_id, row["title"], row["content"], stamp),
            )
            conn.execute(
                """DELETE FROM note_versions WHERE note_id = ? AND id NOT IN (
                       SELECT id FROM note_versions WHERE note_id = ? ORDER BY id DESC LIMIT 20
                   )""",
                (note_id, note_id),
            )
    conn.execute(
        "UPDATE notes SET title=?, content=?, pinned=?, tags=?, updated_at=?, page_id=? WHERE id=?",
        (title, content, pinned, tags, stamp, page_id, note_id),
    )
    conn.commit()
    updated = conn.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
    conn.close()
    if content != row["content"]:
        gc_uploads()
    return jsonify(dict(updated))


@app.get("/api/notes/<int:note_id>/versions")
def list_versions(note_id):
    conn = get_db()
    rows = conn.execute(
        "SELECT id, note_id, title, created_at FROM note_versions WHERE note_id = ? ORDER BY id DESC LIMIT 20",
        (note_id,),
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.get("/api/notes/<int:note_id>/versions/<int:version_id>")
def get_version(note_id, version_id):
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM note_versions WHERE id = ? AND note_id = ?",
        (version_id, note_id),
    ).fetchone()
    conn.close()
    if row is None:
        return jsonify({"error": "Version not found"}), 404
    return jsonify({**dict(row), "content": sanitize_html(row["content"])})


@app.post("/api/notes/<int:note_id>/restore")
@can_write
def restore_version(note_id):
    data = request.get_json(silent=True) or {}
    version_id = data.get("version_id")
    conn = get_db()
    note = conn.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
    version = conn.execute(
        "SELECT * FROM note_versions WHERE id = ? AND note_id = ?",
        (version_id, note_id),
    ).fetchone()
    if note is None or version is None:
        conn.close()
        return jsonify({"error": "Version not found"}), 404
    stamp = now_stamp()
    conn.execute(
        "INSERT INTO note_versions (note_id, title, content, created_at) VALUES (?, ?, ?, ?)",
        (note_id, note["title"], note["content"], stamp),
    )
    conn.execute(
        "UPDATE notes SET title=?, content=?, updated_at=? WHERE id=?",
        (version["title"], sanitize_html(version["content"]), stamp, note_id),
    )
    conn.commit()
    updated = conn.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
    conn.close()
    return jsonify(dict(updated))


@app.delete("/api/notes/<int:note_id>/versions")
@admin_only
def clear_versions(note_id):
    conn = get_db()
    conn.execute("DELETE FROM note_versions WHERE note_id = ?", (note_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.delete("/api/notes/<int:note_id>")
@admin_only
def delete_note(note_id):
    conn = get_db()
    conn.execute("DELETE FROM note_versions WHERE note_id = ?", (note_id,))
    cur = conn.execute("DELETE FROM notes WHERE id = ?", (note_id,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        return jsonify({"error": "Note not found"}), 404
    gc_uploads()
    return jsonify({"ok": True})


# ---------------- Note sharing (public read-only link) ----------------

def share_url_for(token):
    return request.url_root.rstrip("/") + "/s/" + token


@app.get("/api/notes/<int:note_id>/share")
def get_note_share(note_id):
    conn = get_db()
    try:
        exists = conn.execute("SELECT 1 FROM notes WHERE id = ?", (note_id,)).fetchone()
        if not exists:
            return jsonify({"error": "Note not found"}), 404
        row = conn.execute("SELECT token FROM note_shares WHERE note_id = ?", (note_id,)).fetchone()
    finally:
        conn.close()
    return jsonify({"note_id": note_id, "url": share_url_for(row["token"]) if row else None})


@app.post("/api/notes/<int:note_id>/share")
@can_write
def create_note_share(note_id):
    conn = get_db()
    try:
        exists = conn.execute("SELECT 1 FROM notes WHERE id = ?", (note_id,)).fetchone()
        if not exists:
            return jsonify({"error": "Note not found"}), 404
        row = conn.execute("SELECT token FROM note_shares WHERE note_id = ?", (note_id,)).fetchone()
        if row:
            return jsonify({"note_id": note_id, "url": share_url_for(row["token"]), "created": False})
        token = secrets.token_urlsafe(16)
        conn.execute(
            "INSERT INTO note_shares (token, note_id, created_at) VALUES (?, ?, ?)",
            (token, note_id, now_stamp()),
        )
        conn.commit()
    finally:
        conn.close()
    logger.info("share created for note id=%s by user id=%s", note_id, session.get("uid"))
    return jsonify({"note_id": note_id, "url": share_url_for(token), "created": True}), 201


@app.delete("/api/notes/<int:note_id>/share")
@can_write
def revoke_note_share(note_id):
    conn = get_db()
    conn.execute("DELETE FROM note_shares WHERE note_id = ?", (note_id,))
    conn.commit()
    conn.close()
    logger.info("share revoked for note id=%s by user id=%s", note_id, session.get("uid"))
    return jsonify({"ok": True})


@app.get("/s/<token>")
def public_share_page(token):
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT n.* FROM notes n JOIN note_shares s ON s.note_id = n.id WHERE s.token = ?",
            (token,),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return render_template("share.html", missing=True, title="Shared note", meta="", content=""), 404
    title = row["title"] or "Untitled"
    # Re-sanitize on read for defense-in-depth (content is already sanitized on write)
    content = sanitize_html(row["content"] or "")
    tags = clean_tags(row["tags"])
    meta = "Last updated " + (row["updated_at"] or "").strip()
    return render_template(
        "share.html",
        missing=False,
        title=title,
        meta=meta,
        content=content,
        page_title="",
        tags=tags,
    )


def gc_uploads():
    conn = get_db()
    blobs = [r["content"] for r in conn.execute("SELECT content FROM notes")]
    blobs += [r["content"] for r in conn.execute("SELECT content FROM note_versions")]
    blobs += [r["content"] for r in conn.execute("SELECT content FROM pages")]
    conn.close()
    referenced = set()
    for blob in blobs:
        referenced.update(re.findall(r"uploads/([\w.-]+)", blob or ""))
    cutoff = time.time() - 24 * 3600
    for f in UPLOAD_DIR.iterdir():
        if f.name in referenced or not f.is_file():
            continue
        try:
            if f.stat().st_mtime > cutoff:
                continue
        except OSError:
            continue
        for _attempt in range(5):
            try:
                f.unlink()
                break
            except PermissionError:
                time.sleep(0.15)
            except FileNotFoundError:
                break


def compress_image(file_storage):
    img = Image.open(file_storage)
    img.load()
    img = img.convert("RGB") if img.mode not in ("RGB", "L") else img
    if max(img.size) > 1600:
        img.thumbnail((1600, 1600), Image.LANCZOS)
    buf = BytesIO()
    img.save(buf, format="JPEG", quality=82, optimize=True)
    buf.seek(0)
    return buf.read()


@app.get("/api/pages")
def list_pages():
    conn = get_db()
    rows = conn.execute("SELECT * FROM pages ORDER BY updated_at DESC, id DESC").fetchall()
    conn.close()
    return jsonify([{**dict(r), "content": sanitize_html(r["content"])} for r in rows])


@app.post("/api/pages")
@can_write
def create_page():
    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip() or "Untitled"
    icon = str(data.get("icon") or "").strip()[:24]
    content = sanitize_html(str(data.get("content") or ""))
    stamp = now_stamp()
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO pages (title, icon, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        (title, icon, content, stamp, stamp),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM pages WHERE id = ?", (cur.lastrowid,)).fetchone()
    conn.close()
    return jsonify(dict(row)), 201


@app.put("/api/pages/<int:page_id>")
@can_write
def update_page(page_id):
    data = request.get_json(silent=True) or {}
    conn = get_db()
    row = conn.execute("SELECT * FROM pages WHERE id = ?", (page_id,)).fetchone()
    if row is None:
        conn.close()
        return jsonify({"error": "Page not found"}), 404
    title = (data.get("title") or "").strip() or row["title"]
    icon = str(data.get("icon", row["icon"])).strip()[:24]
    content = sanitize_html(str(data.get("content", row["content"])))
    changed = content != row["content"]
    conn.execute(
        "UPDATE pages SET title=?, icon=?, content=?, updated_at=? WHERE id=?",
        (title, icon, content, now_stamp(), page_id),
    )
    conn.commit()
    updated = conn.execute("SELECT * FROM pages WHERE id = ?", (page_id,)).fetchone()
    conn.close()
    if changed:
        gc_uploads()
    return jsonify(dict(updated))


@app.delete("/api/pages/<int:page_id>")
@admin_only
def delete_page(page_id):
    conn = get_db()
    conn.execute("UPDATE notes SET page_id = NULL WHERE page_id = ?", (page_id,))
    conn.execute("UPDATE tasks SET page_id = NULL WHERE page_id = ?", (page_id,))
    cur = conn.execute("DELETE FROM pages WHERE id = ?", (page_id,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        return jsonify({"error": "Page not found"}), 404
    gc_uploads()
    return jsonify({"ok": True})


@app.post("/api/upload")
@can_write
def upload_file():
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "Empty filename"}), 400
    f.seek(0, 2)
    size = f.tell()
    f.seek(0)
    if size > MAX_UPLOAD_SIZE:
        return jsonify({"error": "File too large (max 5 MB)"}), 400
    ext = Path(f.filename).suffix.lower()[:10]
    safe_ext = re.sub(r"[^a-z0-9.]", "", ext)
    image_ext = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp")
    # Only images + inert documents — never .html/.htm/.xml/.svg etc. that could
    # execute script when served from the same origin.
    if safe_ext not in image_ext and safe_ext not in (".pdf", ".txt"):
        return jsonify({"error": "File type not allowed. Only images, PDF and TXT are supported."}), 400
    is_image = safe_ext in image_ext
    if is_image and safe_ext != ".gif":
        try:
            file_data = compress_image(f)
        except Exception:
            return jsonify({"error": "File is not a valid image"}), 400
        final_ext = ".jpg"
    else:
        f.seek(0)
        file_data = f.read()
        final_ext = safe_ext
    name = f"{uuid.uuid4().hex}{final_ext}"
    (UPLOAD_DIR / name).write_bytes(file_data)
    return jsonify({
        "url": f"uploads/{name}",
        "name": f.filename,
        "size": len(file_data),
        "is_image": is_image,
    })


@app.delete("/api/uploads/<path:name>")
@admin_only
def delete_upload(name):
    target = (UPLOAD_DIR / name).resolve()
    if not target.is_relative_to(UPLOAD_DIR) or not target.exists():
        return jsonify({"error": "Not found"}), 404
    for _attempt in range(5):
        try:
            target.unlink()
            return jsonify({"ok": True})
        except PermissionError:
            time.sleep(0.15)
    return jsonify({"error": "File is locked, try again in a moment"}), 409


def validate_routine_payload(data, partial=False):
    errors = []
    out = {}
    if not partial or "title" in data:
        title = (data.get("title") or "").strip()
        if not title:
            errors.append("Title is required")
        else:
            out["title"] = title
    if "weekday" in data:
        try:
            weekday = int(data.get("weekday"))
        except (TypeError, ValueError):
            weekday = -1
        if not 0 <= weekday <= 6:
            errors.append("Weekday must be 0-6 (Monday-Sunday)")
        else:
            out["weekday"] = weekday
    if "time" in data:
        out["time"] = data.get("time") or None
    if "active" in data:
        out["active"] = 1 if data.get("active") in (True, 1, "true", "1") else 0
    return out, errors


@app.get("/api/routines")
def list_routines():
    since = (date.today() - timedelta(days=90)).isoformat()
    conn = get_db()
    rows = conn.execute("SELECT * FROM routines ORDER BY CASE WHEN active=1 THEN 0 ELSE 1 END, weekday, time IS NULL, time").fetchall()
    comps = {}
    for c in conn.execute(
        "SELECT routine_id, completed_date FROM routine_completions WHERE completed_date >= ? ORDER BY completed_date DESC",
        (since,),
    ).fetchall():
        comps.setdefault(c["routine_id"], []).append(c["completed_date"])
    conn.close()
    out = []
    for r in rows:
        item = dict(r)
        item["completions"] = comps.get(r["id"], [])
        out.append(item)
    return jsonify(out)


@app.post("/api/routines")
@can_write
def create_routine():
    data = request.get_json(silent=True) or {}
    payload, errors = validate_routine_payload(data)
    if errors:
        return jsonify({"error": "; ".join(errors)}), 400
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO routines (title, weekday, time, created_at) VALUES (?, ?, ?, ?)",
        (payload["title"], payload.get("weekday", 0), payload.get("time"), now_stamp()),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM routines WHERE id = ?", (cur.lastrowid,)).fetchone()
    conn.close()
    item = dict(row)
    item["completions"] = []
    return jsonify(item), 201


@app.patch("/api/routines/<int:routine_id>")
@can_write
def update_routine(routine_id):
    data = request.get_json(silent=True) or {}
    payload, errors = validate_routine_payload(data, partial=True)
    if errors:
        return jsonify({"error": "; ".join(errors)}), 400
    if not payload:
        return jsonify({"error": "Nothing to update"}), 400
    conn = get_db()
    row = conn.execute("SELECT * FROM routines WHERE id = ?", (routine_id,)).fetchone()
    if row is None:
        conn.close()
        return jsonify({"error": "Routine not found"}), 404
    fields = dict(row)
    fields.update(payload)
    conn.execute(
        "UPDATE routines SET title=?, weekday=?, time=?, active=? WHERE id=?",
        (fields["title"], fields["weekday"], fields["time"], fields["active"], routine_id),
    )
    conn.commit()
    updated = conn.execute("SELECT * FROM routines WHERE id = ?", (routine_id,)).fetchone()
    comps = conn.execute(
        "SELECT completed_date FROM routine_completions WHERE routine_id = ? AND completed_date >= ? ORDER BY completed_date DESC",
        (routine_id, (date.today() - timedelta(days=90)).isoformat()),
    ).fetchall()
    conn.close()
    item = dict(updated)
    item["completions"] = [c["completed_date"] for c in comps]
    return jsonify(item)


@app.post("/api/routines/<int:routine_id>/toggle")
@can_write
def toggle_routine(routine_id):
    data = request.get_json(silent=True) or {}
    d = data.get("date")
    try:
        date.fromisoformat(d)
    except (TypeError, ValueError):
        return jsonify({"error": "date must be YYYY-MM-DD"}), 400
    conn = get_db()
    if conn.execute("SELECT id FROM routines WHERE id = ?", (routine_id,)).fetchone() is None:
        conn.close()
        return jsonify({"error": "Routine not found"}), 404
    existing = conn.execute(
        "SELECT id FROM routine_completions WHERE routine_id = ? AND completed_date = ?",
        (routine_id, d),
    ).fetchone()
    if existing:
        conn.execute("DELETE FROM routine_completions WHERE id = ?", (existing["id"],))
        done = False
    else:
        conn.execute(
            "INSERT INTO routine_completions (routine_id, completed_date) VALUES (?, ?)",
            (routine_id, d),
        )
        done = True
    conn.commit()
    conn.close()
    return jsonify({"done": done})


@app.delete("/api/routines/<int:routine_id>")
@admin_only
def delete_routine(routine_id):
    conn = get_db()
    conn.execute("DELETE FROM routine_completions WHERE routine_id = ?", (routine_id,))
    cur = conn.execute("DELETE FROM routines WHERE id = ?", (routine_id,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        return jsonify({"error": "Routine not found"}), 404
    return jsonify({"ok": True})


BACKUP_TABLES = ["tasks", "notes", "routines", "routine_completions", "note_versions", "pages", "note_shares"]


def reset_db():
    conn = get_db()
    for table in reversed(BACKUP_TABLES):
        conn.execute(f"DROP TABLE IF EXISTS {table}")
    conn.commit()
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()


@app.post("/api/reset")
@admin_only
def reset():
    reset_db()
    logger.warning("database reset by user id=%s (%s)", session.get("uid"), request.remote_addr)
    return jsonify({"ok": True})


def export_rows(conn):
    data = {}
    for table in BACKUP_TABLES:
        rows = conn.execute(f"SELECT * FROM {table}").fetchall()
        data[table] = [dict(r) for r in rows]
    return {"data": data}


@app.get("/api/export/json")
def export_json():
    conn = get_db()
    payload = export_rows(conn)
    conn.close()
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return send_file(
        BytesIO(json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")),
        mimetype="application/json",
        as_attachment=True,
        download_name=f"assistant-backup-{stamp}.json",
    )


@app.get("/api/export/excel")
def export_excel():
    from openpyxl import Workbook
    from openpyxl.styles import Font

    conn = get_db()
    wb = Workbook()
    wb.remove(wb.active)
    header_font = Font(bold=True)
    for table in BACKUP_TABLES:
        rows = conn.execute(f"SELECT * FROM {table}").fetchall()
        ws = wb.create_sheet(title=table[:31])
        columns = list(rows[0].keys()) if rows else ["id"]
        ws.append(columns)
        for cell in ws[1]:
            cell.font = header_font
        for r in rows:
            ws.append([r[c] for c in columns])
        for idx, col in enumerate(columns, start=1):
            width = min(max(len(col) + 4, *(len(str(r[col])) + 2 for r in rows)) if rows else len(col) + 4, 60)
            ws.column_dimensions[ws.cell(row=1, column=idx).column_letter].width = width
    conn.close()
    buf = BytesIO()
    wb.save(buf)
    buf.seek(0)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return send_file(
        buf,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        as_attachment=True,
        download_name=f"assistant-backup-{stamp}.xlsx",
    )


def _as_int(value, default=0):
    try:
        return int(float(str(value).strip() or default))
    except (TypeError, ValueError):
        return default


def _as_bool(value):
    return 1 if str(value).strip().lower() in ("1", "true", "yes") else 0


@app.post("/api/import")
@admin_only
def import_backup():
    mode = request.form.get("mode", "merge")
    if mode not in ("merge", "replace"):
        return jsonify({"error": "mode must be merge or replace"}), 400
    file = request.files.get("file")
    if file is None:
        return jsonify({"error": "No file provided"}), 400
    try:
        raw = json.loads(file.read().decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return jsonify({"error": "Invalid JSON backup file"}), 400
    if isinstance(raw, dict) and isinstance(raw.get("data"), dict):
        data = raw["data"]
    elif isinstance(raw, dict):
        data = raw
    else:
        return jsonify({"error": "Unexpected backup structure"}), 400
    unknown = set(data.keys()) - set(BACKUP_TABLES)
    if unknown:
        return jsonify({"error": f"Unknown tables: {', '.join(sorted(unknown))}"}), 400

    counts = {}
    def count(kind, what):
        counts.setdefault(kind, {"imported": 0, "skipped": 0})
        counts[kind][what] += 1

    conn = get_db()
    try:
        conn.execute("BEGIN")
        if mode == "replace":
            for table in reversed(BACKUP_TABLES):
                conn.execute(f"DELETE FROM {table}")
        note_id_map = {}
        routine_id_map = {}
        for row in data.get("tasks", []):
            title = str(row.get("title", "")).strip()
            if not title:
                continue
            due = str(row.get("due_date") or "").strip() or None
            done = _as_bool(row.get("done"))
            dup = conn.execute(
                "SELECT id FROM tasks WHERE lower(title)=lower(?) AND IFNULL(due_date,'')=IFNULL(?,'') AND done=?",
                (title, due, done),
            ).fetchone()
            if dup and mode == "merge":
                count("tasks", "skipped")
                continue
            conn.execute(
                "INSERT INTO tasks (title, description, priority, due_date, done, completed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (title, str(row.get("description") or ""), str(row.get("priority") or "medium"),
                 due, done, str(row.get("completed_at") or "") or None,
                 str(row.get("created_at") or now_stamp())),
            )
            count("tasks", "imported")
        for row in data.get("notes", []):
            title = str(row.get("title", "")).strip()
            if not title:
                continue
            content = sanitize_html(str(row.get("content") or ""))
            tags = str(row.get("tags") or "")
            pinned = _as_bool(row.get("pinned"))
            if mode == "merge":
                dup = conn.execute("SELECT id FROM notes WHERE lower(title)=lower(?)", (title,)).fetchone()
                if dup:
                    count("notes", "skipped")
                    note_id_map[_as_int(row.get("id"))] = dup["id"]
                    continue
            cur = conn.execute(
                "INSERT INTO notes (title, content, pinned, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                (title, content, pinned, tags,
                 str(row.get("created_at") or now_stamp()), str(row.get("updated_at") or now_stamp())),
            )
            note_id_map[_as_int(row.get("id"))] = cur.lastrowid
            count("notes", "imported")
        for row in data.get("note_versions", []):
            old_id = _as_int(row.get("note_id"))
            new_id = note_id_map.get(old_id)
            if not new_id:
                continue
            v_title = str(row.get("title") or "")
            v_content = sanitize_html(str(row.get("content") or ""))
            v_created = str(row.get("created_at") or now_stamp())
            if mode == "merge":
                dupv = conn.execute(
                    "SELECT 1 FROM note_versions WHERE note_id = ? AND title = ? AND content = ? AND created_at = ?",
                    (new_id, v_title, v_content, v_created),
                ).fetchone()
                if dupv:
                    continue
            conn.execute(
                "INSERT INTO note_versions (note_id, title, content, created_at) VALUES (?, ?, ?, ?)",
                (new_id, v_title, v_content, v_created),
            )
        for row in data.get("routines", []):
            title = str(row.get("title", "")).strip()
            if not title:
                continue
            weekday = _as_int(row.get("weekday"))
            if not 0 <= weekday <= 6:
                weekday = 0
            if mode == "merge":
                dup = conn.execute(
                    "SELECT id FROM routines WHERE lower(title)=lower(?) AND weekday=?",
                    (title, weekday),
                ).fetchone()
                if dup:
                    count("routines", "skipped")
                    routine_id_map[_as_int(row.get("id"))] = dup["id"]
                    continue
            cur = conn.execute(
                "INSERT INTO routines (title, weekday, time, active, created_at) VALUES (?, ?, ?, ?, ?)",
                (title, weekday, str(row.get("time") or "").strip() or None,
                 _as_bool(row.get("active", 1)), str(row.get("created_at") or now_stamp())),
            )
            routine_id_map[_as_int(row.get("id"))] = cur.lastrowid
            count("routines", "imported")
        for row in data.get("routine_completions", []):
            old_rid = _as_int(row.get("routine_id"))
            new_rid = routine_id_map.get(old_rid)
            d = str(row.get("completed_date") or "").strip()
            if not new_rid or not d:
                continue
            conn.execute(
                "INSERT OR IGNORE INTO routine_completions (routine_id, completed_date) VALUES (?, ?)",
                (new_rid, d),
            )
        for row in data.get("pages", []):
            title = str(row.get("title", "")).strip() or "Untitled"
            if mode == "merge":
                dup = conn.execute(
                    "SELECT id FROM pages WHERE lower(title)=lower(?)", (title,)
                ).fetchone()
                if dup:
                    count("pages", "skipped")
                    continue
            stamp_c = str(row.get("created_at") or now_stamp())
            stamp_u = str(row.get("updated_at") or now_stamp())
            icon = str(row.get("icon") or "").strip()[:24]
            conn.execute(
                "INSERT INTO pages (title, icon, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                (title, icon, sanitize_html(str(row.get("content") or "")), stamp_c, stamp_u),
            )
            count("pages", "imported")
        for row in data.get("note_shares", []):
            token = str(row.get("token") or "").strip()
            new_nid = note_id_map.get(_as_int(row.get("note_id")))
            if not token or new_nid is None:
                count("note_shares", "skipped")
                continue
            dup = conn.execute("SELECT 1 FROM note_shares WHERE token = ?", (token,)).fetchone()
            if dup and mode == "merge":
                count("note_shares", "skipped")
                continue
            try:
                conn.execute(
                    "INSERT INTO note_shares (note_id, token, created_at) VALUES (?, ?, ?)",
                    (new_nid, token, str(row.get("created_at") or now_stamp())),
                )
                count("note_shares", "imported")
            except sqlite3.IntegrityError:
                count("note_shares", "skipped")
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        conn.close()
        return jsonify({"error": "Import failed, backup rolled back"}), 500
    imported_total = sum(c["imported"] for c in counts.values())
    skipped_total = sum(c["skipped"] for c in counts.values())
    conn.close()
    logger.info("backup import by user id=%s mode=%s imported=%s skipped=%s", session.get("uid"), mode, imported_total, skipped_total)
    return jsonify({"ok": True, "mode": mode, "imported": imported_total, "skipped": skipped_total, "detail": counts})


REQUIRED_TABLES = {"notes", "tasks", "pages", "routines"}
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

TABLE_COLS = {
    "notes": ["id", "title", "content", "pinned", "tags", "page_id", "created_at", "updated_at"],
    "tasks": ["id", "title", "description", "priority", "due_date", "done", "completed_at", "created_at", "page_id"],
    "pages": ["id", "title", "icon", "content", "created_at", "updated_at"],
    "routines": ["id", "title", "weekday", "time", "active", "created_at"],
}


def _slug(name):
    s = re.sub(r"[^\w\- ]+", "", name or "").strip().replace(" ", "_")
    return s[:40] or "export"


def _xlsx_bytes(wb):
    buf = BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf


@app.get("/api/export/sqlite")
def export_sqlite():
    src = get_db()
    try:
        src.execute("PRAGMA wal_checkpoint(FULL)")
    except sqlite3.Error:
        pass
    fd, tmp_path = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    dst = sqlite3.connect(tmp_path)
    src.backup(dst)
    dst.close()
    src.close()
    with open(tmp_path, "rb") as fh:
        payload = fh.read()
    os.unlink(tmp_path)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return send_file(
        BytesIO(payload),
        mimetype="application/x-sqlite3",
        as_attachment=True,
        download_name=f"assistant-backup-{stamp}.sqlite",
    )


@app.post("/api/import/sqlite")
@admin_only
def import_sqlite():
    file = request.files.get("file")
    if file is None:
        return jsonify({"error": "No file provided"}), 400
    raw = file.read()
    if not raw.startswith(b"SQLite format 3\x00"):
        return jsonify({"error": "Not a valid SQLite database file"}), 400
    fd, tmp_path = tempfile.mkstemp(suffix=".sqlite")
    with os.fdopen(fd, "wb") as fh:
        fh.write(raw)
    try:
        import contextlib

        with contextlib.closing(sqlite3.connect(tmp_path)) as chk:
            try:
                ok = chk.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
                tables = {r[0] for r in chk.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            except sqlite3.DatabaseError as exc:
                raise ValueError(f"unreadable database ({exc.__class__.__name__})")
        if not ok:
            raise ValueError("integrity check failed")
        missing = REQUIRED_TABLES - tables
        if missing:
            raise ValueError(f"missing tables: {', '.join(sorted(missing))}")
    except ValueError as exc:
        os.unlink(tmp_path)
        return jsonify({"error": f"Invalid database backup ({exc})"}), 400
    conn = get_db()
    conn.close()
    try:
        os.replace(tmp_path, str(DB_PATH))
    except PermissionError:
        os.unlink(tmp_path)
        return jsonify({"error": "Database is busy (a save is in progress) — try again in a few seconds"}), 409
    init_db()
    return jsonify({"ok": True})


@app.post("/api/import/excel")
@admin_only
def import_excel():
    from openpyxl import load_workbook

    file = request.files.get("file")
    mode = request.form.get("mode", "merge")
    if file is None:
        return jsonify({"error": "No file provided"}), 400
    if mode not in ("merge", "replace"):
        return jsonify({"error": "Invalid mode"}), 400
    try:
        wb = load_workbook(BytesIO(file.read()), data_only=True, read_only=True)
    except Exception:
        return jsonify({"error": "Invalid Excel file"}), 400
    sheets = [t for t in TABLE_COLS if t in wb.sheetnames]
    if not sheets:
        return jsonify({"error": "No known data sheets found (need Notes/Tasks/Pages/Routines)"}), 400

    counts = {}

    def count(kind, what):
        counts.setdefault(kind, {"imported": 0, "skipped": 0})
        counts[kind][what] += 1

    conn = get_db()
    try:
        conn.execute("BEGIN")
        if mode == "replace":
            for t in reversed(BACKUP_TABLES):
                conn.execute(f"DELETE FROM {t}")
        for table in ["pages", "routines", "notes", "tasks"]:
            if table not in sheets:
                continue
            rows = list(wb[table].iter_rows(values_only=True))
            if len(rows) < 2:
                continue
            headers = [str(h).strip() if h is not None else "" for h in rows[0]]
            for r in rows[1:]:
                if all(v is None or str(v).strip() == "" for v in r):
                    continue
                rec = {headers[i]: r[i] for i in range(min(len(headers), len(r))) if headers[i]}
                title = str(rec.get("title") or "").strip()
                if not title:
                    count(table, "skipped")
                    continue
                cols = []
                vals = []
                for col in TABLE_COLS[table]:
                    raw_v = rec.get(col)
                    if col == "id":
                        try:
                            v = int(float(raw_v))
                        except (TypeError, ValueError):
                            continue
                        if v > 0:
                            cols.append("id")
                            vals.append(v)
                    elif col in ("pinned", "done", "active"):
                        cols.append(col)
                        vals.append(_as_bool(raw_v))
                    elif col == "weekday":
                        cols.append(col)
                        vals.append(max(0, min(6, _as_int(raw_v))))
                    elif col == "priority":
                        cols.append(col)
                        pv = str(raw_v or "").strip().lower()
                        vals.append(pv if pv in PRIORITIES else "medium")
                    elif col == "page_id":
                        cols.append(col)
                        try:
                            vals.append(int(float(raw_v)))
                        except (TypeError, ValueError):
                            vals.append(None)
                    elif col in ("due_date", "completed_at") and isinstance(raw_v, datetime):
                        cols.append(col)
                        vals.append(raw_v.date().isoformat() if col == "due_date" else raw_v.isoformat(sep=" ", timespec="seconds"))
                    elif table in ("notes", "pages") and col == "content":
                        cols.append(col)
                        vals.append(sanitize_html(str(raw_v or "")))
                    elif col == "icon":
                        cols.append(col)
                        vals.append(str(raw_v or "")[:24])
                    else:
                        cols.append(col)
                        vals.append(str(raw_v if raw_v is not None else ""))
                if mode == "merge":
                    dup = conn.execute(
                        f"SELECT 1 FROM {table} WHERE lower(title)=lower(?)", (title,)
                    ).fetchone()
                    if dup:
                        count(table, "skipped")
                        continue
                ph = ", ".join("?" for _ in cols)
                conn.execute(
                    f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({ph})", vals
                )
                count(table, "imported")
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        conn.close()
        return jsonify({"error": "Excel import failed, rolled back"}), 500
    conn.close()
    imported = sum(c["imported"] for c in counts.values())
    skipped = sum(c["skipped"] for c in counts.values())
    return jsonify({"ok": True, "mode": mode, "imported": imported, "skipped": skipped, "detail": counts})


@app.get("/api/tasks/<int:tid>/export.xlsx")
def export_task_xlsx(tid):
    from openpyxl import Workbook
    from openpyxl.styles import Font

    conn = get_db()
    row = conn.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
    conn.close()
    if not row:
        return jsonify({"error": "Not found"}), 404
    d = dict(row)
    d["status"] = "Done" if d.get("done") else "Pending"
    d.pop("done", None)
    ordered = {k: d[k] for k in ["id", "title", "status", "priority", "due_date", "description", "completed_at", "created_at"]}
    wb = Workbook()
    ws = wb.active
    ws.title = "Task"
    ws.append(list(ordered.keys()))
    for cell in ws[1]:
        cell.font = Font(bold=True)
    ws.append([str(v) if v is not None else "" for v in ordered.values()])
    ws.column_dimensions["B"].width = 40
    ws.column_dimensions["F"].width = 60
    return send_file(
        _xlsx_bytes(wb), mimetype=XLSX_MIME, as_attachment=True,
        download_name=f"task-{_slug(d['title'])}-{tid}.xlsx",
    )


@app.get("/api/pages/<int:pid>/export.xlsx")
def export_page_xlsx(pid):
    from openpyxl import Workbook
    from openpyxl.styles import Font

    conn = get_db()
    row = conn.execute("SELECT * FROM pages WHERE id=?", (pid,)).fetchone()
    notes_rows = [dict(r) for r in conn.execute("SELECT * FROM notes WHERE page_id=?", (pid,))]
    task_rows = [dict(r) for r in conn.execute("SELECT * FROM tasks WHERE page_id=?", (pid,))]
    conn.close()
    if not row:
        return jsonify({"error": "Not found"}), 404

    def fill(ws, rows):
        if not rows:
            ws.append(["(empty)"])
            return
        columns = list(rows[0].keys())
        ws.append(columns)
        for cell in ws[1]:
            cell.font = Font(bold=True)
        for rr in rows:
            ws.append([
                (" ".join(str(rr[c]).split()) if isinstance(rr[c], str) else rr[c])
                for c in columns
            ])

    d = dict(row)
    d.pop("icon", None)
    wb = Workbook()
    ws = wb.active
    ws.title = "Page"
    fill(ws, [d])
    fill(wb.create_sheet("Notes"), notes_rows)
    fill(wb.create_sheet("Tasks"), task_rows)
    return send_file(
        _xlsx_bytes(wb), mimetype=XLSX_MIME, as_attachment=True,
        download_name=f"page-{_slug(d['title'])}-{pid}.xlsx",
    )


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/uploads/<path:name>")
def uploaded_file(name):
    target = (UPLOAD_DIR / name).resolve()
    if not target.is_relative_to(UPLOAD_DIR) or not target.is_file():
        return jsonify({"error": "Not found"}), 404
    resp = send_from_directory(UPLOAD_DIR, name)
    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return resp


init_db()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
