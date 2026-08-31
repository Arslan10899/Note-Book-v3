import base64
import io
import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

BASE_DIR = Path(__file__).resolve().parent.parent
_ENV_ROOT = Path(tempfile.mkdtemp(prefix="assistant-test-"))
os.environ["ASSISTANT_DB"] = str(_ENV_ROOT / "test.db")
os.environ["ASSISTANT_UPLOADS"] = str(_ENV_ROOT / "uploads")

sys.path.insert(0, str(BASE_DIR))
import app as app_module  # noqa: E402


class BaseTest(unittest.TestCase):
    def setUp(self):
        self.app = app_module.app
        self.client = self.app.test_client()
        # Chat tests must never hit the network: strip provider config BEFORE
        # reset_db() so the real keys never get seeded into chat_settings.
        self._genv_key = os.environ.pop("GEMINI_API_KEY", None)
        self._genv_model = os.environ.pop("GEMINI_MODEL", None)
        for p in tuple(app_module.CHAT_PROVIDERS):
            if p == "gemini":
                continue
            os.environ.pop(f"{p.upper()}_API_KEY", None)
            os.environ.pop(f"{p.upper()}_MODEL", None)
        app_module.reset_db()
        conn = sqlite3.connect(app_module.DB_PATH)
        conn.executescript("DELETE FROM users; DELETE FROM app_settings; DELETE FROM agent_pending;")
        conn.commit()
        conn.close()

    def tearDown(self):
        for p in tuple(app_module.CHAT_PROVIDERS):
            os.environ.pop(f"{p.upper()}_API_KEY", None)
            os.environ.pop(f"{p.upper()}_MODEL", None)
        if self._genv_key is not None:
            os.environ["GEMINI_API_KEY"] = self._genv_key
        if self._genv_model is not None:
            os.environ["GEMINI_MODEL"] = self._genv_model

    def register(self, username="tester", password="secret1", display_name="Tester"):
        return self.client.post(
            "/api/auth/register",
            json={"username": username, "password": password, "display_name": display_name},
        )

    def login(self, username="tester", password="secret1"):
        return self.client.post("/api/auth/login", json={"username": username, "password": password})


class TestAuth(BaseTest):
    def test_register_and_login(self):
        r = self.register()
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.get_json()["role"], "admin")  # first user becomes admin
        self.client.post("/api/auth/logout")
        r = self.login()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["username"], "tester")

    def test_register_validation(self):
        r = self.register(username="x", password="secret1")
        self.assertEqual(r.status_code, 400)
        r = self.register(username="validname", password="123")
        self.assertEqual(r.status_code, 400)

    def test_login_rate_limited(self):
        app_module._failed_attempts.clear()
        for _ in range(5):
            self.login(password="wrong-pass")
        r = self.login(password="wrong-pass")
        self.assertEqual(r.status_code, 429)
        app_module._failed_attempts.clear()

    def test_register_rate_limited(self):
        app_module._failed_attempts.clear()
        self.register(username="dummy")  # success resets the counter
        for _ in range(10):
            self.register(username="dummy")  # duplicates all fail
        r = self.register(username="freshname")
        self.assertEqual(r.status_code, 429)
        app_module._failed_attempts.clear()


class TestTasks(BaseTest):
    def setUp(self):
        super().setUp()
        self.register()

    def test_create_patch_delete(self):
        r = self.client.post("/api/tasks", json={"title": "Buy milk", "priority": "high"})
        self.assertEqual(r.status_code, 201)
        tid = r.get_json()["id"]
        r = self.client.patch(f"/api/tasks/{tid}", json={"done": True})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.get_json()["done"])
        tasks = self.client.get("/api/tasks").get_json()
        self.assertEqual(len(tasks), 1)
        r = self.client.delete(f"/api/tasks/{tid}")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.client.get("/api/tasks").get_json(), [])

    def test_requires_title(self):
        r = self.client.post("/api/tasks", json={"title": "  "})
        self.assertEqual(r.status_code, 400)


class TestNotes(BaseTest):
    def setUp(self):
        super().setUp()
        self.register()

    def test_create_and_sanitize(self):
        r = self.client.post("/api/notes", json={"title": "Note A", "content": "<p>Hello</p>"})
        self.assertEqual(r.status_code, 201)
        self.assertIn("Hello", r.get_json()["content"])
        self.assertEqual(r.get_json()["title"], "Note A")

    def test_script_stripped(self):
        payload = "<script>alert(1)</script><b onclick=\"x()\">hi</b><a href=\"javascript:evil()\">link</a>"
        r = self.client.post("/api/notes", json={"title": "Safe", "content": payload})
        self.assertEqual(r.status_code, 201)
        content = r.get_json()["content"]
        self.assertNotIn("<script", content)
        self.assertNotIn("onclick", content)
        self.assertNotIn("javascript:", content)
        self.assertIn("hi", content)

    def test_versions_created(self):
        r = self.client.post("/api/notes", json={"title": "V", "content": "v1"})
        nid = r.get_json()["id"]
        self.client.put(f"/api/notes/{nid}", json={"title": "V", "content": "v2"})
        versions = self.client.get(f"/api/notes/{nid}/versions").get_json()
        self.assertGreaterEqual(len(versions), 1)

    def test_svg_sanitized_in_html(self):
        # svg tag stripped even without closing tags via block removal
        payload = "<svg onload=\"alert(1)\"></svg>ok"
        r = self.client.post("/api/notes", json={"title": "S", "content": payload})
        content = r.get_json()["content"]
        self.assertNotIn("<svg", content)
        self.assertIn("ok", content)

    def test_checklist_data_task_preserved(self):
        # the checklist feature depends on ul[data-task] surviving the sanitizer
        payload = '<ul data-task="2"><li>done item</li></ul><p>x</p>'
        r = self.client.post("/api/notes", json={"title": "C", "content": payload})
        self.assertEqual(r.status_code, 201)
        content = r.get_json()["content"]
        self.assertIn('data-task="2"', content)
        self.assertIn("done item", content)

    def test_entity_bypass_blocked(self):
        # entity-encoded markup must NEVER become live markup: the < from a
        # character reference is inert text per HTML parsing. The sanitizer
        # re-escapes it, so it renders literally and can never execute.
        payload = "&#60;script&#62;alert(&#39;xss&#39;)&#60;/script&#62;hello"
        r = self.client.post("/api/notes", json={"title": "E", "content": payload})
        self.assertEqual(r.status_code, 201)
        content = r.get_json()["content"]
        self.assertNotIn("<script", content)           # no raw/real tag
        self.assertEqual(content.count("<"), 0)         # nothing tag-like survives
        self.assertIn("&lt;script&gt;", content)        # safe escaped text instead
        self.assertIn("hello", content)

    def test_legacy_stored_content_cleaned_on_read(self):
        # simulate a row written by the old weak sanitizer
        nid = self.client.post("/api/notes", json={"title": "L", "content": "ok"}).get_json()["id"]
        conn = sqlite3.connect(app_module.DB_PATH)
        conn.execute("UPDATE notes SET content = ? WHERE id = ?",
                     ("&#60;img src=x onerror=alert(1)&#62;safe", nid))
        conn.commit()
        conn.close()
        rows = self.client.get("/api/notes").get_json()
        match = next(n for n in rows if n["id"] == nid)
        self.assertNotIn("<img", match["content"])
        self.assertEqual(match["content"].count("<"), 0)  # only &lt; remains
        self.assertIn("&lt;img", match["content"])
        self.assertIn("safe", match["content"])


class TestUploads(BaseTest):
    def setUp(self):
        super().setUp()
        self.register()

    def test_svg_rejected(self):
        data = {"file": (io.BytesIO(b"<svg xmlns='http://www.w3.org/2000/svg'/>"), "pic.svg")}
        r = self.client.post("/api/upload", data=data, content_type="multipart/form-data")
        self.assertEqual(r.status_code, 400)
        self.assertIn("not allowed", r.get_json()["error"])

    def test_html_rejected(self):
        data = {"file": (io.BytesIO(b"<html><script>alert(1)</script></html>"), "page.html")}
        r = self.client.post("/api/upload", data=data, content_type="multipart/form-data")
        self.assertEqual(r.status_code, 400)
        self.assertIn("not allowed", r.get_json()["error"])

    def test_fake_image_rejected(self):
        data = {"file": (io.BytesIO(b"not really a png"), "pic.png")}
        r = self.client.post("/api/upload", data=data, content_type="multipart/form-data")
        self.assertEqual(r.status_code, 400)

    def test_png_accepted(self):
        from PIL import Image

        buf = io.BytesIO()
        Image.new("RGB", (10, 10), "red").save(buf, format="PNG")
        buf.seek(0)
        data = {"file": (buf, "pic.png")}
        r = self.client.post("/api/upload", data=data, content_type="multipart/form-data")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.get_json()["is_image"])


class TestShare(BaseTest):
    def setUp(self):
        super().setUp()
        self.register()

    def test_create_revoke_share(self):
        nid = self.client.post("/api/notes", json={"title": "Public", "content": "<p>Hello world</p>"}).get_json()["id"]
        r = self.client.post(f"/api/notes/{nid}/share")
        self.assertEqual(r.status_code, 201)
        url = r.get_json()["url"]
        self.assertIn("/s/", url)
        token = url.rsplit("/", 1)[-1]
        # creating again returns the same URL
        r2 = self.client.post(f"/api/notes/{nid}/share")
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(r2.get_json()["url"], url)
        # public page reachable without a session
        anon = app_module.app.test_client()
        pg = anon.get(f"/s/{token}")
        self.assertEqual(pg.status_code, 200)
        self.assertIn("Public", pg.get_data(as_text=True))
        self.assertIn("Hello world", pg.get_data(as_text=True))
        self.assertNotIn("<script", pg.get_data(as_text=True))
        # share GET returns url
        got = self.client.get(f"/api/notes/{nid}/share").get_json()
        self.assertEqual(got["url"], url)
        # revoke -> page 404
        rv = self.client.delete(f"/api/notes/{nid}/share")
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(anon.get(f"/s/{token}").status_code, 404)
        self.assertIsNone(self.client.get(f"/api/notes/{nid}/share").get_json()["url"])

    def test_share_requires_login(self):
        anon = app_module.app.test_client()
        r = anon.post("/api/notes/1/share")
        self.assertEqual(r.status_code, 401)

    def test_share_missing_note(self):
        r = self.client.post("/api/notes/999999/share")
        self.assertEqual(r.status_code, 404)

    def test_share_roundtrip_via_json_backup(self):
        nid = self.client.post("/api/notes", json={"title": "Shared", "content": "<p>Keep me</p>"}).get_json()["id"]
        self.client.post(f"/api/notes/{nid}/share")
        backup = self.client.get("/api/export/json").get_json()
        self.assertIn("note_shares", backup["data"])
        shares = backup["data"]["note_shares"]
        self.assertTrue(any(s["note_id"] == nid for s in shares))
        # reset + restore keeps the share link working
        self.client.post("/api/reset")
        st = self.client.post(
            "/api/import",
            data={"file": (io.BytesIO(json.dumps(backup).encode("utf-8")), "b.json"), "mode": "replace"},
            content_type="multipart/form-data",
        )
        self.assertEqual(st.status_code, 200)
        refreshed = self.client.get("/api/export/json").get_json()
        self.assertEqual(len(refreshed["data"]["note_shares"]), len(shares))
        anon = app_module.app.test_client()
        token = shares[0]["token"]
        self.assertEqual(anon.get(f"/s/{token}").status_code, 200)


class TestExport(BaseTest):
    def setUp(self):
        super().setUp()
        self.register()

    def test_excel_export(self):
        r = self.client.get("/api/export/excel")
        self.assertEqual(r.status_code, 200)
        self.assertIn("spreadsheet", r.content_type)
        self.assertGreater(len(r.data), 1000)

    def test_json_backup(self):
        self.client.post("/api/notes", json={"title": "B", "content": "x"})
        r = self.client.get("/api/export/json")
        self.assertEqual(r.status_code, 200)
        payload = r.get_json()
        self.assertIn("notes", payload["data"])


class TestDotEnv(BaseTest):
    def test_env_file_loaded(self):
        tmp = tempfile.NamedTemporaryFile("w", suffix=".env", delete=False, encoding="utf-8")
        tmp.write('GEMINI_API_KEY="AIza-fake-key"\n# a comment\nGEMINI_MODEL=gemini-2.5-flash\nbroken-line\nRECORD=value\n')
        tmp.close()
        try:
            app_module._load_env_file(Path(tmp.name))
            self.assertEqual(os.environ.get("GEMINI_API_KEY"), "AIza-fake-key")
            self.assertEqual(os.environ.get("GEMINI_MODEL"), "gemini-2.5-flash")
            self.assertEqual(os.environ.get("RECORD"), "value")
            # already-set real env vars are never overwritten
            os.environ["GEMINI_MODEL"] = "winning"
            app_module._load_env_file(Path(tmp.name))
            self.assertEqual(os.environ.get("GEMINI_MODEL"), "winning")
        finally:
            os.unlink(tmp.name)
            os.environ.pop("GEMINI_API_KEY", None)
            os.environ.pop("GEMINI_MODEL", None)
            os.environ.pop("RECORD", None)


class TestChatSettings(BaseTest):
    def register_admin(self):
        self.register()
        self.login()
        return self

    def test_settings_admin_only(self):
        self.register()
        self.client.post("/api/auth/logout")
        self.register(username="alice", password="secret2")
        self.login(username="alice", password="secret2")
        # non-admin cannot read, save or delete provider settings
        self.assertEqual(self.client.get("/api/chat/settings").status_code, 403)
        r = self.client.put("/api/chat/settings", json={"provider": "gemini", "api_key": "x"})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.client.delete("/api/chat/settings/gemini").status_code, 403)

    def test_save_provider_writes_env(self):
        self.register_admin()
        with mock.patch.object(app_module, "_write_env_entry", side_effect=lambda k, v: os.environ.__setitem__(k, v)):
            r = self.client.put(
                "/api/chat/settings",
                json={"provider": "openai", "model": "gpt-4o", "api_key": "sk-test-123"},
            )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(os.environ.get("OPENAI_API_KEY"), "sk-test-123")
        self.assertEqual(os.environ.get("OPENAI_MODEL"), "gpt-4o")
        data = r.get_json()
        row = next(x for x in data["providers"] if x["provider"] == "openai")
        self.assertEqual(row["api_key"], "sk-test-123")
        self.assertEqual(row["model"], "gpt-4o")

    def test_set_active_uses_db_and_messages_use_it(self):
        self.register_admin()
        with mock.patch.object(app_module, "_write_env_entry", side_effect=lambda k, v: os.environ.__setitem__(k, v)):
            self.client.put("/api/chat/settings", json={"provider": "gemini", "api_key": "AIza-test"})
            r = self.client.post("/api/chat/settings/active", json={"provider": "gemini"})
        data = r.get_json()
        self.assertEqual(data["active"], "gemini")
        self.assertEqual(data["active_label"], "Gemini (Google)")
        # cloud call now targets the active provider; mocked, so just confirm flow works
        with mock.patch.object(app_module, "_gemini_reply", return_value="active model reply") as m:
            sid = self.client.post("/api/chat/sessions", json={}).get_json()["id"]
            r = self.client.post(f"/api/chat/sessions/{sid}/messages", json={"message": "how to submit 1500"})
        self.assertEqual(r.get_json()["assistant"]["source_type"], "cloud_llm")
        call = m.call_args[0]
        self.assertEqual(call[0], "gemini")

    def test_models_endpoint_omits_keys(self):
        self.register_admin()
        with mock.patch.object(app_module, "_write_env_entry", side_effect=lambda k, v: os.environ.__setitem__(k, v)):
            self.client.put("/api/chat/settings", json={"provider": "groq", "api_key": "gsk-test"})
        self.client.post("/api/auth/logout")
        self.register(username="bob", password="secret3")
        self.login(username="bob", password="secret3")
        data = self.client.get("/api/chat/models").get_json()
        # API keys must not be exposed to regular users
        self.assertNotIn("gsk-test", str(data))
        groq = next((p for p in data["providers"] if p["provider"] == "groq"), None)
        self.assertIsNotNone(groq)
        self.assertTrue(groq["configured"])
        self.assertNotIn("api_key", groq)

    def test_models_detail_endpoint_safe_without_key(self):
        """Without an API key the detail endpoint returns no_key error and never hits the network."""
        self.register_admin()
        for k in ("GEMINI_API_KEY", "OPENAI_API_KEY", "GROQ_API_KEY", "XAI_API_KEY"):
            os.environ.pop(k, None)
        r = self.client.get("/api/chat/models/detail?provider=groq")
        data = r.get_json()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(data["error"], "no_key")
        self.assertEqual(data["models"], [])
        self.assertNotIn("api_key", data)

    def test_models_detail_endpoint_unknown_provider(self):
        self.register_admin()
        r = self.client.get("/api/chat/models/detail?provider=nope")
        self.assertEqual(r.status_code, 400)

    def test_delete_provider_key(self):
        self.register_admin()
        with mock.patch.object(app_module, "_write_env_entry", side_effect=lambda k, v: os.environ.__setitem__(k, v)):
            self.client.put("/api/chat/settings", json={"provider": "xai", "api_key": "xai-test"})
            r = self.client.delete("/api/chat/settings/xai")
        self.assertEqual(r.status_code, 200)
        row = next(x for x in r.get_json()["providers"] if x["provider"] == "xai")
        self.assertEqual(row["api_key"], "")
        self.assertFalse(os.environ.get("XAI_API_KEY"))


class TestIndexes(BaseTest):
    def test_indexes_exist(self):
        conn = sqlite3.connect(app_module.DB_PATH)
        idx = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='index'")}
        conn.close()
        for name in [
            "idx_tasks_page_id",
            "idx_notes_page_id",
            "idx_notes_updated_at",
            "idx_note_versions_note_id",
            "idx_routine_completions_routine_id",
            "idx_routine_completions_date",
            "idx_knowledge_updated",
            "idx_chat_sessions_user",
            "idx_chat_messages_session",
            "idx_chat_settings_enabled",
        ]:
            self.assertIn(name, idx, f"missing index {name}")


class TestKnowledge(BaseTest):
    def register_and_login(self):
        self.register()
        self.login()

    def test_crud(self):
        self.register_and_login()
        r = self.client.post(
            "/api/knowledge",
            json={"title": "Claim window", "category": "CalViva", "content": "Submit within 14 days"},
        )
        self.assertEqual(r.status_code, 201)
        k = r.get_json()

        r = self.client.put(f"/api/knowledge/{k['id']}", json={"content": "Submit within 30 days"})
        self.assertEqual(r.status_code, 200)
        self.assertIn("30 days", r.get_json()["content"])

        r = self.client.get("/api/knowledge")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.get_json()), 1)

        r = self.client.delete(f"/api/knowledge/{k['id']}")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.client.get("/api/knowledge").get_json(), [])

    def test_write_role_required(self):
        # first user becomes admin; a later "user"-role account cannot write
        self.register()
        self.client.post("/api/auth/logout")
        self.register(username="alice", password="secret2")
        self.login(username="alice", password="secret2")
        r = self.client.post("/api/knowledge", json={"title": "X", "content": "y"})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.client.get("/api/knowledge").status_code, 200)

    def test_requires_title(self):
        self.register_and_login()
        r = self.client.post("/api/knowledge", json={"category": "CPT", "content": "no title"})
        self.assertEqual(r.status_code, 400)


class TestChat(BaseTest):
    def register_and_login(self):
        self.register()
        self.login()

    def test_session_and_local_rag(self):
        self.register_and_login()
        self.client.post(
            "/api/knowledge",
            json={"title": "Claim window", "category": "CalViva", "content": "Claims must be submitted within 14 business days."},
        )
        r = self.client.post("/api/chat/sessions", json={})
        self.assertEqual(r.status_code, 201)
        sid = r.get_json()["id"]

        r = self.client.post(f"/api/chat/sessions/{sid}/messages", json={"message": "claim window calviva"})
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertEqual(data["user"]["sender"], "user")
        self.assertEqual(data["assistant"]["sender"], "assistant")
        # Keyword hit should be answered from the local knowledge base (no Gemini key)
        self.assertIn("14 business days", data["assistant"]["message"])
        self.assertEqual(data["assistant"]["source_type"], "local_rag")
        # New-chat session title is auto-derived from the first question
        self.assertEqual(data["session"]["title"], "claim window calviva")

    def test_chat_searches_notes(self):
        """Chat can pull answers from app notes, not just the knowledge base."""
        self.register_and_login()
        self.client.post(
            "/api/notes",
            json={
                "title": "Appeal policy 1099",
                "content": "Form 1099 denials must be appealed within 30 calendar days. Submit via the portal.",
                "tags": "billing",
            },
        )
        r = self.client.post("/api/chat/sessions", json={})
        sid = r.get_json()["id"]
        resp = self.client.post(
            f"/api/chat/sessions/{sid}/messages",
            json={"message": "What is the appeal window for a 1099?"},
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data["assistant"]["source_type"], "local_rag")
        self.assertIn("Note: Appeal policy 1099", data["assistant"]["message"])
        self.assertIn("30 calendar days", data["assistant"]["message"])

    @mock.patch.object(app_module, "_gemini_reply", return_value="General guidance from Gemini.")
    def test_chat_cloud_fallback(self, _mock_gemini):
        self.register_and_login()
        self.client.post(
            "/api/knowledge",
            json={"title": "Claim window", "category": "CalViva", "content": "Claims must be submitted within 14 business days."},
        )
        # AI model connected (key in env): query with no local overlap -> answer from the model
        os.environ["GEMINI_API_KEY"] = "AIza-test"
        try:
            r = self.client.post("/api/chat/sessions", json={})
            sid = r.get_json()["id"]
            r = self.client.post(f"/api/chat/sessions/{sid}/messages", json={"message": "how do I write an appeal letter about a minor issue today"})
            self.assertEqual(r.status_code, 200)
            data = r.get_json()
            self.assertEqual(data["assistant"]["source_type"], "cloud_llm")
            self.assertEqual(data["assistant"]["message"], "General guidance from Gemini.")
        finally:
            os.environ.pop("GEMINI_API_KEY", None)

    def test_chat_greets_user_by_name(self):
        self.register_and_login()  # username "tester", display_name "Tester"
        r = self.client.post("/api/chat/sessions", json={})
        sid = r.get_json()["id"]
        os.environ["GEMINI_API_KEY"] = "AIza-test"
        try:
            with mock.patch.object(app_module, "_gemini_reply", return_value="hi") as m:
                self.client.post(f"/api/chat/sessions/{sid}/messages", json={"message": "hello"})
            self.assertEqual(m.call_args[0][4], "Tester")
            self.assertIs(m.call_args[0][5], True)
            with mock.patch.object(app_module, "_gemini_reply", return_value="hi2") as m:
                self.client.post(f"/api/chat/sessions/{sid}/messages", json={"message": "again"})
            self.assertIs(m.call_args[0][5], False)
        finally:
            os.environ.pop("GEMINI_API_KEY", None)

    def test_local_rag_first_message_greets(self):
        self.register_and_login()
        self.client.post(
            "/api/knowledge", json={"title": "Rule", "category": "Policy", "content": "Submit claims within 14 calendar days."}
        )
        r = self.client.post("/api/chat/sessions", json={})
        sid = r.get_json()["id"]
        r = self.client.post(f"/api/chat/sessions/{sid}/messages", json={"message": "what is the claim submission rule"})
        data = r.get_json()
        self.assertEqual(data["assistant"]["source_type"], "local_rag")
        self.assertIn("Tester", data["assistant"]["message"])
        self.assertRegex(data["assistant"]["message"], r"Good (morning|afternoon|evening), Tester!")
        self.register()
        self.login()
        first = self.client.post("/api/chat/sessions", json={}).get_json()
        self.client.post("/api/auth/logout")

        self.register(username="alice", password="secret2")
        self.login(username="alice", password="secret2")
        # Cannot list, read, or delete another user's conversation
        self.assertEqual(self.client.get("/api/chat/sessions").get_json(), [])
        r = self.client.get(f"/api/chat/sessions/{first['id']}/messages")
        self.assertEqual(r.status_code, 404)
        r = self.client.delete(f"/api/chat/sessions/{first['id']}")
        self.assertEqual(r.status_code, 404)

    def test_message_requires_session(self):
        self.register_and_login()
        r = self.client.post("/api/chat/sessions/nonexistent/messages", json={"message": "hi"})
        self.assertEqual(r.status_code, 404)

    def test_delete_all_conversations(self):
        self.register_and_login()
        a = self.client.post("/api/chat/sessions", json={}).get_json()["id"]
        b = self.client.post("/api/chat/sessions", json={}).get_json()["id"]
        self.client.post(f"/api/chat/sessions/{a}/messages", json={"message": "hi"})
        self.assertEqual(len(self.client.get("/api/chat/sessions").get_json()), 2)
        r = self.client.delete("/api/chat/sessions")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["deleted"], 2)
        self.assertEqual(self.client.get("/api/chat/sessions").get_json(), [])
        self.assertEqual(self.client.get(f"/api/chat/sessions/{a}/messages").status_code, 404)
        # Pending plan rows for wiped sessions are cleaned too
        s = self.client.post("/api/chat/sessions", json={}).get_json()["id"]
        app_module._set_pending(s, {"action": "create", "kind": "task", "id": None, "title": "X", "fields": {}})
        self.assertEqual(app_module._pending_plan(s)["title"], "X")
        self.assertEqual(self.client.delete("/api/chat/sessions").get_json()["deleted"], 1)
        self.assertIsNone(app_module._pending_plan(s))

    def _stream_events(self, sid, q):
        r = self.client.get(
            f"/api/chat/sessions/{sid}/stream?q={q.replace(' ', '+')}",
            buffered=True,
        )
        events = []
        for chunk in r.get_data(as_text=True).split("data: "):
            chunk = chunk.strip()
            if chunk:
                events.append(json.loads(chunk))
        return r, events

    def test_stream_flow_local_rag(self):
        self.register_and_login()
        self.client.post(
            "/api/knowledge",
            json={"title": "Claim window", "category": "CalViva", "content": "Claims must be submitted within 14 business days."},
        )
        sid = self.client.post("/api/chat/sessions", json={}).get_json()["id"]
        r, events = self._stream_events(sid, "claim window calviva")
        self.assertEqual(r.status_code, 200)
        self.assertIn("text/event-stream", r.content_type)
        nodes = [e for e in events if e.get("event") != "final"]
        self.assertEqual(nodes[0], {"node": "input", "status": "running", "label": "User Input"})
        statuses = [(e["node"], e["status"]) for e in nodes]
        self.assertIn(("rag", "success"), statuses)
        self.assertIn(("llm", "skipped"), statuses)
        self.assertIn(("response", "success"), statuses)
        final = events[-1]
        self.assertEqual(final["event"], "final")
        self.assertEqual(final["assistant"]["source_type"], "local_rag")
        self.assertIn("14 business days", final["assistant"]["message"])
        # user + assistant messages were persisted by the stream
        msgs = self.client.get(f"/api/chat/sessions/{sid}/messages").get_json()
        self.assertEqual([m["sender"] for m in msgs], ["user", "assistant"])
        # session title auto-derived, even when sent through the stream
        sessions = self.client.get("/api/chat/sessions").get_json()
        self.assertEqual(sessions[0]["title"], "claim window calviva")

    def test_stream_flow_owner_isolation(self):
        self.register()
        self.login()
        sid = self.client.post("/api/chat/sessions", json={}).get_json()["id"]
        self.client.post("/api/auth/logout")
        self.register(username="alice", password="secret2")
        self.login(username="alice", password="secret2")
        r = self.client.get(f"/api/chat/sessions/{sid}/stream?q=hi")
        self.assertEqual(r.status_code, 404)

    def test_stream_flow_requires_message(self):
        self.register_and_login()
        sid = self.client.post("/api/chat/sessions", json={}).get_json()["id"]
        self.assertEqual(self.client.get(f"/api/chat/sessions/{sid}/stream?q=").status_code, 400)
        self.assertEqual(self.client.get(f"/api/chat/sessions/{sid}/stream").status_code, 400)


class TestAgent(BaseTest):
    def register_admin(self):
        return self.register()

    def register_and_login(self):
        self.register()
        return self.login()

    def _stream_events(self, sid, q):
        r = self.client.get(
            f"/api/chat/sessions/{sid}/stream?q={q.replace(' ', '+')}",
            buffered=True,
        )
        events = []
        for chunk in r.get_data(as_text=True).split("data: "):
            chunk = chunk.strip()
            if chunk:
                events.append(json.loads(chunk))
        return r, events

    def test_agent_setting_endpoints(self):
        self.register_admin()
        self.assertFalse(self.client.get("/api/chat/agent").get_json()["enabled"])
        r = self.client.put("/api/chat/agent", json={"enabled": True})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.get_json()["enabled"])
        self.assertTrue(self.client.get("/api/chat/agent").get_json()["enabled"])
        # non-admin can read but not change
        self.client.post("/api/auth/logout")
        self.register(username="bob", password="secret3")
        self.login(username="bob", password="secret3")
        self.assertTrue(self.client.get("/api/chat/agent").get_json()["enabled"])
        r = self.client.put("/api/chat/agent", json={"enabled": False})
        self.assertIn(r.status_code, (401, 403))

    def test_agent_create_task_from_message(self):
        self.register_and_login()
        self.client.put("/api/chat/agent", json={"enabled": True})
        os.environ["GEMINI_API_KEY"] = "AIza-test"
        try:
            with mock.patch.object(
                app_module,
                "_agent_plan",
                return_value={"action": "create", "kind": "task", "id": None, "title": "",
                              "fields": {"title": "Call insurer", "description": "Verify auth",
                                         "priority": "high", "due_date": "2026-09-01"}},
            ):
                sid = self.client.post("/api/chat/sessions", json={}).get_json()["id"]
                r = self.client.post(f"/api/chat/sessions/{sid}/messages", json={"message": "add a task: call the insurer"})
            self.assertEqual(r.status_code, 200)
            data = r.get_json()
            self.assertEqual(data["assistant"]["source_type"], "agent_action")
            self.assertIn("Call insurer", data["assistant"]["message"])
        finally:
            os.environ.pop("GEMINI_API_KEY", None)
        tasks = self.client.get("/api/tasks").get_json()
        self.assertEqual(len(tasks), 1)
        self.assertEqual(tasks[0]["title"], "Call insurer")
        self.assertEqual(tasks[0]["priority"], "high")
        self.assertEqual(tasks[0]["created_by"], "AI")

    def test_agent_disabled_ignores_actions(self):
        self.register_and_login()
        os.environ["GEMINI_API_KEY"] = "AIza-test"
        try:
            with mock.patch.object(app_module, "_agent_plan") as m, mock.patch.object(
                app_module, "_gemini_reply", return_value="plain answer"
            ):
                sid = self.client.post("/api/chat/sessions", json={}).get_json()["id"]
                r = self.client.post(f"/api/chat/sessions/{sid}/messages", json={"message": "add a task please"})
            m.assert_not_called()
            self.assertEqual(r.get_json()["assistant"]["source_type"], "cloud_llm")
            self.assertEqual(r.get_json()["assistant"]["message"], "plain answer")
        finally:
            os.environ.pop("GEMINI_API_KEY", None)

    def test_agent_helper_update_and_delete(self):
        self.register_and_login()
        self.client.post("/api/tasks", json={"title": "Old Task", "description": "x", "priority": "low"})
        self.client.post("/api/notes", json={"title": "Office Memo", "content": "draft"})
        # update by unique title
        text = app_module._run_agent_action(
            {"action": "update", "kind": "task", "id": None, "title": "Old Task",
             "fields": {"priority": "high", "due_date": "2026-09-10"}}
        )
        self.assertIn("updated", text)
        tasks = self.client.get("/api/tasks").get_json()
        self.assertEqual(tasks[0]["priority"], "high")
        self.assertEqual(tasks[0]["due_date"], "2026-09-10")
        # create then delete note by title
        text = app_module._run_agent_action(
            {"action": "create", "kind": "note", "id": None, "title": "",
             "fields": {"title": "Temp Note", "content": "delete me later"}}
        )
        note_id = next(n["id"] for n in self.client.get("/api/notes").get_json() if n["title"] == "Temp Note")
        text = app_module._run_agent_action(
            {"action": "delete", "kind": "note", "id": note_id, "title": ""}
        )
        self.assertIn("deleted", text)
        self.assertNotIn("Temp Note", [n["title"] for n in self.client.get("/api/notes").get_json()])

    def test_agent_helper_ambiguous_title(self):
        self.register_and_login()
        self.client.post("/api/tasks", json={"title": "Renew policy", "description": "a"})
        self.client.post("/api/tasks", json={"title": "Renew policy", "description": "b"})
        text = app_module._run_agent_action(
            {"action": "update", "kind": "task", "id": None, "title": "Renew policy", "fields": {"done": True}}
        )
        self.assertIn("matching", text)

    def test_stream_flow_agent_action(self):
        self.register_and_login()
        self.client.put("/api/chat/agent", json={"enabled": True})
        os.environ["GEMINI_API_KEY"] = "AIza-test"
        try:
            with mock.patch.object(
                app_module,
                "_agent_plan",
                return_value={"action": "create", "kind": "routine", "id": None, "title": "",
                              "fields": {"title": "Morning chart review", "weekday": 0, "time": "09:30"}},
            ):
                sid = self.client.post("/api/chat/sessions", json={}).get_json()["id"]
                r, events = self._stream_events(sid, "add a routine: morning chart review at 9 30")
            self.assertEqual(r.status_code, 200)
            statuses = [(e["node"], e["status"]) for e in events if e.get("event") != "final"]
            self.assertIn(("agent", "success"), statuses)
            final = events[-1]
            self.assertEqual(final["assistant"]["source_type"], "agent_action")
            self.assertIn("Morning chart review", final["assistant"]["message"])
        finally:
            os.environ.pop("GEMINI_API_KEY", None)
        routines = self.client.get("/api/routines").get_json()
        self.assertEqual(len(routines), 1)
        self.assertEqual(routines[0]["title"], "Morning chart review")
        self.assertEqual(routines[0]["weekday"], 0)


    def test_agent_asks_for_missing_details(self):
        self.register_and_login()
        self.client.put("/api/chat/agent", json={"enabled": True})
        os.environ["GEMINI_API_KEY"] = "AIza-test"
        try:
            with mock.patch.object(
                app_module,
                "_agent_plan",
                return_value={"action": "create", "kind": "note", "id": None, "title": "",
                              "fields": {}},
            ):
                sid = self.client.post("/api/chat/sessions", json={}).get_json()["id"]
                r = self.client.post(f"/api/chat/sessions/{sid}/messages", json={"message": "add a note"})
            self.assertEqual(r.status_code, 200)
            data = r.get_json()
            self.assertEqual(data["assistant"]["source_type"], "agent_ask")
            self.assertIn("title", data["assistant"]["message"].lower())
            # nothing saved yet, but the partial plan is remembered
            self.assertEqual(self.client.get("/api/notes").get_json(), [])
            self.assertIsNotNone(app_module._pending_plan(sid))
        finally:
            os.environ.pop("GEMINI_API_KEY", None)

    def test_agent_fill_completes_pending_create(self):
        self.register_and_login()
        self.client.put("/api/chat/agent", json={"enabled": True})
        os.environ["GEMINI_API_KEY"] = "AIza-test"
        try:
            with mock.patch.object(
                app_module,
                "_agent_plan",
                return_value={"action": "create", "kind": "note", "id": None, "title": "",
                              "fields": {}},
            ), mock.patch.object(
                app_module,
                "_agent_fill",
                return_value={"action": "create", "kind": "note", "id": None, "title": "",
                              "fields": {"title": "History of Pakistan",
                                         "content": "Independence in 1947"}},
            ):
                sid = self.client.post("/api/chat/sessions", json={}).get_json()["id"]
                r1 = self.client.post(f"/api/chat/sessions/{sid}/messages", json={"message": "add a note"})
                self.assertEqual(r1.get_json()["assistant"]["source_type"], "agent_ask")
                r2 = self.client.post(
                    f"/api/chat/sessions/{sid}/messages",
                    json={"message": "title History of Pakistan, content about independence in 1947"},
                )
            self.assertEqual(r2.status_code, 200)
            data = r2.get_json()
            self.assertEqual(data["assistant"]["source_type"], "agent_action")
            self.assertIn("History of Pakistan", data["assistant"]["message"])
            self.assertIsNone(app_module._pending_plan(sid))
        finally:
            os.environ.pop("GEMINI_API_KEY", None)
        notes = self.client.get("/api/notes").get_json()
        self.assertEqual(len(notes), 1)
        self.assertEqual(notes[0]["title"], "History of Pakistan")
        self.assertEqual(notes[0]["created_by"], "AI")

    def test_user_created_items_tagged_with_creator(self):
        self.register_and_login()
        n = self.client.post("/api/notes", json={"title": "User Note", "content": "hi"}).get_json()
        t = self.client.post("/api/tasks", json={"title": "User Task", "description": "x"}).get_json()
        self.assertEqual(n["created_by"], "Tester")
        self.assertEqual(t["created_by"], "Tester")

    def test_agent_update_asks_for_target(self):
        self.register_and_login()
        self.client.put("/api/chat/agent", json={"enabled": True})
        os.environ["GEMINI_API_KEY"] = "AIza-test"
        try:
            with mock.patch.object(
                app_module,
                "_agent_plan",
                return_value={"action": "update", "kind": "task", "id": None, "title": "",
                              "fields": {"priority": "high"}},
            ):
                sid = self.client.post("/api/chat/sessions", json={}).get_json()["id"]
                r = self.client.post(f"/api/chat/sessions/{sid}/messages",
                                     json={"message": "make a task high priority"})
            self.assertEqual(r.get_json()["assistant"]["source_type"], "agent_ask")
            self.assertIn("which", r.get_json()["assistant"]["message"].lower())
        finally:
            os.environ.pop("GEMINI_API_KEY", None)

    def test_agent_create_task_with_title_only(self):
        self.register_and_login()
        self.client.put("/api/chat/agent", json={"enabled": True})
        os.environ["GEMINI_API_KEY"] = "AIza-test"
        try:
            with mock.patch.object(
                app_module,
                "_agent_plan",
                return_value={"action": "create", "kind": "task", "id": None, "title": "",
                              "fields": {"title": "Prepare VDL My Report"}},
            ):
                sid = self.client.post("/api/chat/sessions", json={}).get_json()["id"]
                r = self.client.post(f"/api/chat/sessions/{sid}/messages",
                                     json={"message": "Today i need to prepare VDL My Report"})
            self.assertEqual(r.status_code, 200)
            data = r.get_json()
            self.assertEqual(data["assistant"]["source_type"], "agent_action")
            self.assertIn("Prepare VDL My Report", data["assistant"]["message"])
            self.assertIsNone(app_module._pending_plan(sid))
        finally:
            os.environ.pop("GEMINI_API_KEY", None)
        tasks = self.client.get("/api/tasks").get_json()
        self.assertEqual(len(tasks), 1)
        self.assertEqual(tasks[0]["title"], "Prepare VDL My Report")
        self.assertEqual(tasks[0]["description"], "")
        self.assertEqual(tasks[0]["created_by"], "AI")


class TestAgentDataStatus(BaseTest):
    """Data-status queries (pending/current tasks, dashboard) MUST use the
    read-only SQL tool, never the RAG/semantic search path."""

    def setUp(self):
        super().setUp()
        self.register()
        self.login()
        conn = sqlite3.connect(app_module.DB_PATH)
        conn.executescript(
            "INSERT INTO tasks (title, description, priority, due_date, done, completed_at, created_at, page_id, created_by) VALUES "
            "('Call payer', '', 'high', '2026-09-01', 0, NULL, '2026-01-01 00:00:00', NULL, 'AI'), "
            "('Recheck claim', '', 'low', '2026-09-02', 0, NULL, '2026-01-01 00:00:00', NULL, 'AI'), "
            "('Old finished', '', 'medium', NULL, 1, '2026-02-01 00:00:00', '2026-01-01 00:00:00', NULL, 'AI');"
        )
        conn.commit()
        conn.close()
        app_module._set_app_setting("agent_enabled", "1")
        app_module._set_app_setting("live_chat_ai", "0")
        app_module._set_app_setting("review_enabled", "0")

    def test_pending_tasks_query(self):
        plan = app_module._data_status_plan("current pending tasks dikhao")
        self.assertEqual(plan["action"], "sql")
        self.assertIn("done = 0", plan["query"])
        text, ok = app_module._run_readonly_sql(plan["query"])
        self.assertTrue(ok)
        self.assertIn("Call payer", text)
        self.assertIn("Recheck claim", text)
        self.assertNotIn("Old finished", text)

    def test_due_tasks_variant(self):
        plan = app_module._data_status_plan("aj due tasks samjhao")
        self.assertEqual(plan["action"], "sql")
        self.assertIn("due_date IS NOT NULL", plan["query"])

    def test_count_variant(self):
        plan = app_module._data_status_plan("kitne tasks pending hain")
        self.assertEqual(plan["action"], "sql")
        self.assertIn("COUNT(*)", plan["query"])
        text, _ok = app_module._run_readonly_sql(plan["query"])
        self.assertIn("pending", text)

    def test_dashboard_summary(self):
        plan = app_module._data_status_plan("dashboard ka status batao")
        self.assertEqual(plan["action"], "sql")
        self.assertIn("pending_tasks", plan["query"])
        text, ok = app_module._run_readonly_sql(plan["query"])
        self.assertTrue(ok)
        self.assertIn("pending_tasks", text)

    def test_guard_ignores_actions_and_greetings(self):
        for q in ("task add karo", "note likh do", "delete the task", "hello", "salam",
                  "translate this to english"):
            self.assertIsNone(app_module._data_status_plan(q), q)

    def test_runs_sql_not_rag_with_key(self):
        os.environ["GEMINI_API_KEY"] = "AIza-test"
        try:
            with mock.patch.object(app_module, "_agent_plan", side_effect=AssertionError("_agent_plan called")):
                with mock.patch.object(app_module, "hybrid_answer", side_effect=AssertionError("RAG path used")):
                    text, source, outcome = app_module.agent_answer("sess-x", "current pending tasks dikhao")
        finally:
            os.environ.pop("GEMINI_API_KEY", None)
        self.assertEqual(outcome, "action")
        self.assertEqual(source, "agent_action")
        self.assertIn("Call payer", text)
        self.assertNotIn("Old finished", text)

    def test_runs_sql_without_key(self):
        text, source, outcome = app_module.agent_answer("sess-y", "pending tasks kya hain")
        self.assertEqual(outcome, "action")
        self.assertIn("Recheck claim", text)


class TestManagerStaffRouting(BaseTest):
    """Strict Manager vs Staff separation:
    - Rumman (Administrator/Manager) only manages schedule & workflow via SQL.
    - Staff domain experts (billing/data-entry/calling/ERN/processing) own RAG.
    - Domain questions asked TO the Manager re-route to the matching expert."""

    def setUp(self):
        super().setUp()
        self.register()
        self.login()
        conn = sqlite3.connect(app_module.DB_PATH)
        conn.executescript(
            """
            DELETE FROM chat_agents;
            INSERT INTO chat_agents (name, description, system_prompt, is_active, created_at, icon) VALUES
            ('Rumman Lashari',
             'Administrator & Agent Coordinator — poore system ka boss: agents ko task assign karta hai aur notes, tasks, pages, guidelines, routines, portal configs manage karta hai.',
             'Aap Administrator hain.', 1, '2026-01-01 00:00:00', ''),
            ('Medical Billing',
             'Medical Billing specialist - answers from Notes, Tasks & Guidelines',
             'Aap Medical Billing (RCM) specialist hain.', 1, '2026-01-01 00:00:00', ''),
            ('Adnan Gul',
             'VDL-DE Dep Head — Data entry se related notes, pages aur web portals ke sawalon ka jawab deta hai.',
             'Aap VDL Data Entry Department ke Head hain.', 1, '2026-01-01 00:00:00', ''),
            ('Abdul Sameed',
             'VDL Calling Dep Head — Calling department se related notes, pages aur web portals ke sawalon ka jawab deta hai.',
             'Aap VDL Calling Department ke Head hain.', 1, '2026-01-01 00:00:00', ''),
            ('Noman Munir',
             'VDK ERN Dep Head — ERN department se related notes, pages aur web portals ke sawalon ka jawab deta hai.',
             'Aap VDK ERN Department ke Head hain.', 1, '2026-01-01 00:00:00', ''),
            ('Asmar',
             'VDL Processing Dep Head — Processing department se related notes, pages aur web portals ke sawalon ka jawab deta hai.',
             'Aap VDL Processing Department ke Head hain.', 1, '2026-01-01 00:00:00', '');
            """
        )
        conn.commit()
        conn.close()
        app_module._set_app_setting("agent_enabled", "1")
        app_module._set_app_setting("live_chat_ai", "0")
        app_module._set_app_setting("review_enabled", "0")

    def _route(self, q):
        return app_module._agent_router(q, app_module._active_agents())

    def _name(self, agent):
        return agent["name"] if agent else None

    def test_billing_question_routes_to_billing(self):
        self.assertEqual(self._name(self._route("CPT 99213 ka code kya hai")), "Medical Billing")
        self.assertEqual(self._name(self._route("ICD 10 modifier 25 kis liye hai")), "Medical Billing")

    def test_domain_questions_route_to_experts(self):
        self.assertEqual(self._name(self._route("data entry kaise karte hain")), "Adnan Gul")
        self.assertEqual(self._name(self._route("calling department ke rules batao")), "Abdul Sameed")
        self.assertEqual(self._name(self._route("ERN dept kya karta hai")), "Noman Munir")
        self.assertEqual(self._name(self._route("processing dep ka kaam"), ), "Asmar")

    def test_manager_named_with_domain_reroutes(self):
        self.assertEqual(self._name(self._route("Rumman, CPT 99213 ka code batao")), "Medical Billing")
        self.assertEqual(self._name(self._route("Rumman, data entry kaise karein")), "Adnan Gul")

    def test_task_management_stays_with_manager(self):
        self.assertEqual(self._name(self._route("pending tasks kya hain")), "Rumman Lashari")
        self.assertEqual(self._name(self._route("dashboard ka status batao")), "Rumman Lashari")

    def test_named_staff_wins_over_domain(self):
        self.assertEqual(self._name(self._route("Adnan, CPT ka data entry track karo")), "Adnan Gul")

    def test_rag_scope_blocks_guidelines_for_manager(self):
        self.client.post(
            "/api/knowledge",
            json={"title": "CPT 99213 policy", "category": "Billing",
                  "content": "CPT 99213 claims need prior auth within 14 days."},
        )
        self.client.post(
            "/api/tasks",
            json={"title": "Call payer", "description": "cpt claim followup", "priority": "high"},
        )
        rumman = app_module._admin_agent()
        mb = app_module._billing_agent()
        self.assertEqual(app_module._rag_scope(rumman), {"task", "routine", "page"})
        self.assertIsNone(app_module._rag_scope(mb))
        full = app_module._search_best("cpt 99213 prior auth", agent=None)
        self.assertIn("guideline", {h["entry"]["kind"] for h in full})
        man = app_module._search_best("cpt 99213 prior auth", agent=rumman)
        kinds = {h["entry"]["kind"] for h in man}
        self.assertNotIn("guideline", kinds)
        self.assertNotIn("note", kinds)

    def test_local_reply_hides_match_counts(self):
        self.client.post(
            "/api/knowledge",
            json={"title": "Claim window", "category": "CalViva",
                  "content": "Claims must be submitted within 14 business days."},
        )
        best = app_module._search_best("claim window calviva")
        text = app_module._local_reply_text(best, ["claim", "window", "calviva"])
        self.assertIn("14 business days", text)
        self.assertNotIn("I found", text)
        self.assertNotIn("matches in your saved data", text)
        self.assertEqual(app_module._append_answer_footer("answer", None, "local_rag"), "answer")


class TestStickyRoutingAndFollowups(BaseTest):
    """Sticky context lock + implicit dashboard routing + bulk done follow-ups."""

    def setUp(self):
        super().setUp()
        self.register()
        self.login()
        conn = sqlite3.connect(app_module.DB_PATH)
        conn.executescript(
            """
            DELETE FROM chat_agents;
            INSERT INTO chat_agents (name, description, system_prompt, is_active, created_at, icon) VALUES
            ('Rumman Lashari',
             'Administrator & Agent Coordinator — poore system ka boss: agents ko task assign karta hai aur notes, tasks, pages, guidelines, routines, portal configs manage karta hai.',
             'Aap Administrator hain.', 1, '2026-01-01 00:00:00', ''),
            ('Medical Billing',
             'Medical Billing specialist - answers from Notes, Tasks & Guidelines',
             'Aap Medical Billing (RCM) specialist hain.', 1, '2026-01-01 00:00:00', ''),
            ('Asmar',
             'VDL Processing Dep Head — Processing department se related notes, pages aur web portals ke sawalon ka jawab deta hai.',
             'Aap VDL Processing Department ke Head hain.', 1, '2026-01-01 00:00:00', '');
            """
        )
        conn.commit()
        conn.close()
        app_module._set_app_setting("agent_enabled", "1")
        app_module._set_app_setting("live_chat_ai", "0")
        app_module._set_app_setting("review_enabled", "0")

    def _new_session(self):
        return self.client.post("/api/chat/sessions", json={}).get_json()["id"]

    def _seed_reply(self, sid, agent_name):
        conn = sqlite3.connect(app_module.DB_PATH)
        conn.execute(
            "INSERT INTO chat_messages (session_id, sender, message, source_type, created_at) "
            "VALUES (?, 'assistant', ?, '', '2026-01-01 00:00:00')",
            (sid, f"pichla jawab\n\n__agentby__{agent_name}__🔵__Role"),
        )
        conn.commit()
        conn.close()

    def _route(self, q, sid):
        return app_module._agent_router(q, app_module._active_agents(), sid=sid)

    def _name(self, agent):
        return agent["name"] if agent else None

    def test_sticky_lock_keeps_staff_agent(self):
        sid = self._new_session()
        self._seed_reply(sid, "Medical Billing")
        self.assertEqual(self._name(self._route("theek hai, aur batao", sid)), "Medical Billing")

    def test_sticky_lock_keeps_manager(self):
        sid = self._new_session()
        self._seed_reply(sid, "Rumman Lashari")
        self.assertEqual(self._name(self._route("aur kuch update ho", sid)), "Rumman Lashari")

    def test_management_override_breaks_sticky(self):
        sid = self._new_session()
        self._seed_reply(sid, "Medical Billing")
        self.assertEqual(self._name(self._route("mark them all completed", sid)), "Rumman Lashari")

    def test_domain_topic_breaks_sticky(self):
        sid = self._new_session()
        self._seed_reply(sid, "Rumman Lashari")
        self.assertEqual(self._name(self._route("CPT 99213 ka mera prashn hai", sid)), "Medical Billing")

    def test_explicit_name_switches_sticky(self):
        sid = self._new_session()
        self._seed_reply(sid, "Medical Billing")
        self.assertEqual(self._name(self._route("Asmar, processing dept ka status batao", sid)), "Asmar")

    def test_no_sticky_without_history_falls_to_domain(self):
        sid = self._new_session()
        self.assertEqual(self._name(self._route("pending tasks dikhao", sid)), "Rumman Lashari")

    def test_mark_all_completed_runs_action(self):
        conn = sqlite3.connect(app_module.DB_PATH)
        conn.executescript(
            "INSERT INTO tasks (title, description, priority, due_date, done, completed_at, created_at, page_id, created_by) VALUES "
            "('Call payer', '', 'high', NULL, 0, NULL, '2026-01-01 00:00:00', NULL, 'AI'), "
            "('Recheck claim', '', 'low', NULL, 0, NULL, '2026-01-01 00:00:00', NULL, 'AI');"
        )
        conn.commit()
        conn.close()
        plan = app_module._action_followup_plan("mark them all completed")
        self.assertEqual(plan["action"], "done")
        self.assertTrue(plan["all"])
        text, source, outcome = app_module.agent_answer("sess-done", "mark them all completed")
        self.assertEqual(outcome, "action")
        self.assertIn("mark ho gaye", text)
        conn = sqlite3.connect(app_module.DB_PATH)
        pending = conn.execute("SELECT COUNT(*) FROM tasks WHERE done = 0").fetchone()[0]
        conn.close()
        self.assertEqual(pending, 0)

    def test_mark_all_no_pending_says_so(self):
        conn = sqlite3.connect(app_module.DB_PATH)
        conn.executescript(
            "INSERT INTO tasks (title, description, priority, due_date, done, completed_at, created_at, page_id, created_by) VALUES "
            "('Old finished', '', 'medium', NULL, 1, '2026-02-01 00:00:00', '2026-01-01 00:00:00', NULL, 'AI');"
        )
        conn.commit()
        conn.close()
        text, _source, _outcome = app_module.agent_answer("sess-done2", "sab done kar do")
        self.assertIn("pehle se hi done", text)

    def test_agent_plan_receives_history(self):
        sid = self._new_session()
        conn = sqlite3.connect(app_module.DB_PATH)
        conn.execute(
            "INSERT INTO chat_messages (session_id, sender, message, source_type, created_at) "
            "VALUES (?, 'assistant', ?, '', '2026-01-01 00:00:00')",
            (sid, "1. **Call payer** — *pending*\n2. **Recheck claim** — *pending*"),
        )
        conn.commit()
        conn.close()
        os.environ["GEMINI_API_KEY"] = "AIza-test"
        try:
            with mock.patch.object(app_module, "_llm_prompt", return_value='{"action":"none"}') as m:
                app_module._agent_plan("gemini", "mark them all completed", "", sid=sid)
            self.assertIn("CONVERSATION HISTORY", m.call_args[0][2])
            self.assertIn("mark them all completed", m.call_args[0][2])
            self.assertIn("Call payer", m.call_args[0][2])
        finally:
            os.environ.pop("GEMINI_API_KEY", None)


class TestToolRenderingAndPersona(BaseTest):
    """Conversational tool output (empty states, no hardcoded footers) + persona rule."""

    def setUp(self):
        super().setUp()
        self.register()
        self.login()
        conn = sqlite3.connect(app_module.DB_PATH)
        conn.executescript(
            """
            DELETE FROM chat_agents;
            INSERT INTO chat_agents (name, description, system_prompt, is_active, created_at, icon) VALUES
            ('Rumman Lashari',
             'Administrator & Agent Coordinator - poore system ka boss: agents ko task assign karta hai aur notes, tasks, pages, guidelines, routines, portal configs manage karta hai.',
             'Aap Administrator hain.', 1, '2026-01-01 00:00:00', '');
            """
        )
        conn.commit()
        conn.close()
        app_module._set_app_setting("agent_enabled", "1")
        app_module._set_app_setting("live_chat_ai", "0")
        app_module._set_app_setting("review_enabled", "0")

    def _fresh_session(self):
        return self.client.post("/api/chat/sessions", json={}).get_json()["id"]

    def test_readonly_sql_empty_state_string(self):
        conn = sqlite3.connect(app_module.DB_PATH)
        conn.execute("DELETE FROM tasks")
        conn.commit()
        conn.close()
        text, ok = app_module._run_readonly_sql("SELECT title FROM tasks")
        self.assertTrue(ok)
        self.assertEqual(text, "Result: No records found for this query.")

    def test_readonly_sql_returns_table_when_rows(self):
        self.client.post("/api/tasks", json={"title": "Call insurer", "description": "x", "priority": "high"})
        text, ok = app_module._run_readonly_sql("SELECT title FROM tasks")
        self.assertTrue(ok)
        self.assertIn("| title |", text)
        self.assertIn("Call insurer", text)

    def test_wrap_sql_empty_state_no_table_no_footer(self):
        text = app_module._wrap_sql_result("completed tasks", "Result: No records found for this query.")
        self.assertIn("No records found", text)
        self.assertNotIn("|", text)
        self.assertNotIn("Need any changes or follow-ups?", text)

    def test_wrap_sql_no_hardcoded_footer(self):
        text = app_module._wrap_sql_result("pending tasks dikhao", "| title |\n| --- |\n| x |")
        self.assertNotIn("Need any changes or follow-ups?", text)
        self.assertNotIn("follow-ups?", text)

    def test_keyed_path_renders_empty_state_naturally(self):
        self.client.post("/api/tasks", json={"title": "already done", "done": True})
        sid = self._fresh_session()
        os.environ["GEMINI_API_KEY"] = "AIza-test"
        rendered = "Right now you don't have any pending tasks. Would you like me to bring up all tasks instead?"
        try:
            with mock.patch.object(app_module, "_llm_prompt", return_value=rendered):
                text, source, outcome = app_module.agent_answer(sid, "pending tasks dikhao")
            self.assertEqual(outcome, "action")
            self.assertEqual(source, "agent_action")
            self.assertIn("pending tasks", text)
            self.assertIn("all tasks instead", text)
            self.assertNotIn("Need any changes", text)
            self.assertNotIn("Result: No records", text)
        finally:
            os.environ.pop("GEMINI_API_KEY", None)

    def test_render_tool_output_injects_persona(self):
        os.environ["GEMINI_API_KEY"] = "AIza-test"
        try:
            with mock.patch.object(app_module, "_llm_prompt", return_value="natural reply") as m:
                out = app_module._render_tool_output(
                    "gemini", {"action": "sql"}, "|a|\n|--|", "Aap Administrator hain.", "tasks dikhao"
                )
            self.assertEqual(out, "natural reply")
            sys_txt = m.call_args[0][1]
            self.assertIn("professional executive assistant", sys_txt)
            self.assertIn("Never break character", sys_txt)
            self.assertIn("proactive question", sys_txt)
        finally:
            os.environ.pop("GEMINI_API_KEY", None)

    def test_gemini_reply_persona_rule(self):
        os.environ["GEMINI_API_KEY"] = "AIza-test"
        try:
            with mock.patch.object(app_module, "_llm_prompt", return_value="ok answer") as m:
                app_module._gemini_reply("gemini", "us phrase ka matlab kya tha?", "", agent_prompt="Aap Administrator hain.")
            sys_txt = m.call_args[0][1]
            self.assertIn("Never break character", sys_txt)
            self.assertIn("Never explain your own", sys_txt)
            self.assertNotIn("__agentby__", sys_txt)
        finally:
            os.environ.pop("GEMINI_API_KEY", None)

    def test_history_turn_strips_footer_token(self):
        out = app_module._history_turn_txt({"sender": "assistant", "message": "jawab\n\n__agentby__Rumman Lashari__🔵__Admin"})
        self.assertIn("jawab", out)
        self.assertNotIn("__agentby__", out)
        self.assertNotIn("Rumman Lashari", out)

    def test_wrap_fetch_no_outro(self):
        text = app_module._wrap_fetch_result("npi lookup", "data")
        self.assertIn("NPI registry result", text)
        self.assertNotIn("look up anything else", text)

    def test_decision_system_staff_directory_rule(self):
        sys_txt = app_module._AGENT_DECISION_SYSTEM
        self.assertIn("STAFF DIRECTORY RULE", sys_txt)
        low = sys_txt.lower()
        self.assertIn("users", low)
        self.assertIn("chat_settings", low)
        self.assertIn("content like", low)

    def test_tool_inventory_staff_guidance(self):
        inv = app_module._tool_inventory_text()
        low = inv.lower()
        self.assertIn("users table", low)
        self.assertIn("chat_settings", low)
        self.assertIn("pages.content", low)
        self.assertIn("like '%name%'", low)

    def test_sql_tool_refused_detection(self):
        self.assertTrue(app_module._sql_tool_refused(ValueError("SQL tool: ye query allow nahi hai (read-only mode).")))
        self.assertTrue(app_module._sql_tool_refused(ValueError("SQL tool: table(s) allowlist mein nahi: users.")))
        self.assertTrue(app_module._sql_tool_refused(ValueError("SQL tool: sirf SELECT-type read-only queries allowed hain.")))
        self.assertFalse(app_module._sql_tool_refused(ValueError("SQL tool: empty query.")))
        self.assertFalse(app_module._sql_tool_refused(ValueError("boom")))

    def test_sql_refusal_fallback_finds_page_email(self):
        self.client.post(
            "/api/pages",
            json={"title": "Staff Directory", "content": "Ali Raza - Gmail: ali.raza@example.com"},
        )
        text = app_module._sql_refusal_fallback("Ali ka email kya hai")
        self.assertIn("ali.raza@example.com", text)
        self.assertNotIn("I couldn't do that", text)

    def test_sql_refusal_fallback_empty_graceful(self):
        text = app_module._sql_refusal_fallback("zzzzq email kya hai")
        self.assertNotIn("I couldn't do that", text)
        self.assertIn("nahi mili", text)

    def test_keyed_path_sql_refusal_self_corrects(self):
        self.client.post(
            "/api/pages",
            json={"title": "Staff Directory", "content": "Ali Raza - Gmail: ali.raza@example.com"},
        )
        sid = self._fresh_session()
        os.environ["GEMINI_API_KEY"] = "AIza-test"
        try:
            with mock.patch.object(
                app_module,
                "_agent_plan",
                return_value={"action": "sql", "kind": "sql",
                              "query": "SELECT email FROM users WHERE name = 'Ali'",
                              "id": None, "title": "", "fields": {}},
            ), mock.patch.object(app_module, "_review_draft", return_value=("approved", "")):
                text, source, outcome = app_module.agent_answer(sid, "Ali ka email kya hai")
            self.assertEqual(outcome, "answer")
            self.assertEqual(source, "local_rag")
            self.assertIn("ali.raza@example.com", text)
            self.assertNotIn("I couldn't do that", text)
            self.assertNotIn("allow nahi hai", text)
        finally:
            os.environ.pop("GEMINI_API_KEY", None)


class TestGreetingRule(BaseTest):
    def setUp(self):
        super().setUp()
        self.register()
        self.login()
        conn = sqlite3.connect(app_module.DB_PATH)
        conn.executescript(
            """
            DELETE FROM chat_agents;
            INSERT INTO chat_agents (name, description, system_prompt, is_active, created_at, icon) VALUES
            ('Rumman Lashari',
             'Administrator & Agent Coordinator - poore system ka boss.',
             'Aap Administrator hain.', 1, '2026-01-01 00:00:00', ''),
            ('Medical Billing',
             'Medical Billing specialist - answers from Notes, Tasks & Guidelines',
             'Aap Medical Billing (RCM) specialist hain.', 1, '2026-01-01 00:00:00', '');
            """
        )
        conn.commit()
        conn.close()
        app_module._set_app_setting("agent_enabled", "1")
        app_module._set_app_setting("live_chat_ai", "0")
        app_module._set_app_setting("review_enabled", "0")

    def _fresh_session(self):
        return self.client.post("/api/chat/sessions", json={}).get_json()["id"]

    def test_persona_has_warm_greeting_rule(self):
        sys_txt = app_module._AGENT_PERSONA_RULE
        self.assertIn("WARM GREETING RULE", sys_txt)
        self.assertIn("Good Morning Arslan", sys_txt)
        self.assertIn("Aap kaise hain", sys_txt)
        self.assertIn("RAG BYPASS ON GREETINGS", sys_txt)

    def test_decision_system_greeting_rule(self):
        sys_txt = app_module._AGENT_DECISION_SYSTEM
        self.assertIn("GREETINGS", sys_txt)
        self.assertIn('{"action":"none"}', sys_txt)

    def test_is_greeting_only_matches(self):
        for q in ("Good morning", "hello", "Hi?", "Assalam o alaikum",
                  "good morning arslan", "salam bhai", "good evening kese ho",
                  "subah bakhair", "hey jani", "Hello! how are you?"):
            self.assertTrue(app_module._is_greeting_only(q), q)

    def test_is_greeting_only_rejects(self):
        for q in ("Good morning what is the date today?", "hi task add karo",
                  "what is today's date", "kitne tasks pending hain", "", "   ",
                  "hello kaise recharge hota hai"):
            self.assertFalse(app_module._is_greeting_only(q), q)

    def test_hybrid_answer_skips_rag_on_greeting(self):
        os.environ["GEMINI_API_KEY"] = "AIza-test"
        try:
            with mock.patch.object(app_module, "_search_best", wraps=app_module._search_best) as sb, \
                 mock.patch.object(app_module, "_llm_prompt", return_value="warm reply"):
                text, source = app_module.hybrid_answer("Good morning")
            self.assertEqual(text, "warm reply")
            self.assertEqual(source, "cloud_llm")
            sb.assert_not_called()
        finally:
            os.environ.pop("GEMINI_API_KEY", None)

    def test_hybrid_answer_still_searches_non_greeting(self):
        os.environ["GEMINI_API_KEY"] = "AIza-test"
        try:
            with mock.patch.object(app_module, "_search_best", return_value=[]) as sb, \
                 mock.patch.object(app_module, "_llm_prompt", return_value="answer"):
                app_module.hybrid_answer("what is the date today")
            sb.assert_called_once()
        finally:
            os.environ.pop("GEMINI_API_KEY", None)

    def test_agent_answer_greeting_skips_orchestrator(self):
        sid = self._fresh_session()
        os.environ["GEMINI_API_KEY"] = "AIza-test"
        try:
            with mock.patch.object(app_module, "_agent_plan", return_value={"action": "sql"}) as plan, \
                 mock.patch.object(app_module, "_search_best", wraps=app_module._search_best) as sb, \
                 mock.patch.object(app_module, "_llm_prompt", return_value="Good Morning Arslan!"):
                text, source, outcome = app_module.agent_answer(sid, "Good morning")
            self.assertEqual(outcome, "answer")
            self.assertIn("Arslan", text)
            plan.assert_not_called()
            sb.assert_not_called()
        finally:
            os.environ.pop("GEMINI_API_KEY", None)


class TestDynamicVerbosity(unittest.TestCase):
    MARKERS = ("No-Resume Rule", "Zero-Fluff Policy", "Actionable Follow-ups", "Muhammad Arslan")

    def test_verbosity_in_persona_rule(self):
        sys_txt = app_module._AGENT_PERSONA_RULE
        for m in self.MARKERS:
            self.assertIn(m, sys_txt)
        low = sys_txt.lower()
        self.assertIn("never introduce yourself", low)
        self.assertIn("1-to-2 sentence", low)
        self.assertIn("how can i help you today?", low)

    def test_verbosity_in_fill_system(self):
        sys_txt = app_module._AGENT_FILL_SYSTEM
        for m in self.MARKERS:
            self.assertIn(m, sys_txt)

    def _with_key(self, fn):
        os.environ["GEMINI_API_KEY"] = "AIza-test"
        try:
            return fn()
        finally:
            os.environ.pop("GEMINI_API_KEY", None)

    def test_gemini_reply_injects_verbosity(self):
        def run():
            with mock.patch.object(app_module, "_llm_prompt", return_value="ok") as m:
                app_module._gemini_reply("gemini", "date kya hai?", "", agent_prompt="Aap Administrator hain.")
            sys_txt = m.call_args[0][1]
            for marker in ("No-Resume Rule", "Zero-Fluff Policy", "Actionable Follow-ups", "Muhammad Arslan"):
                self.assertIn(marker, sys_txt)
            self.assertNotIn("__agentby__", sys_txt)
        self._with_key(run)

    def test_agent_fill_injects_verbosity(self):
        def run():
            pending = {"action": "create", "kind": "task", "id": None, "title": "", "fields": {}}
            with mock.patch.object(app_module, "_llm_prompt", return_value='{"action":"create","kind":"task","id":null,"title":"Call","fields":{}}') as m:
                app_module._agent_fill(pending, "gemini", "title Call", agent_prompt="Aap Administrator hain.")
            sys_txt = m.call_args[0][1]
            for marker in ("No-Resume Rule", "Zero-Fluff Policy", "Actionable Follow-ups"):
                self.assertIn(marker, sys_txt)
        self._with_key(run)

    def test_render_tool_output_injects_verbosity(self):
        def run():
            with mock.patch.object(app_module, "_llm_prompt", return_value="natural reply") as m:
                app_module._render_tool_output(
                    "gemini", {"action": "sql"}, "|a|\n|--|", "Aap Administrator hain.", "tasks dikhao"
                )
            sys_txt = m.call_args[0][1]
            for marker in ("No-Resume Rule", "Zero-Fluff Policy", "Actionable Follow-ups"):
                self.assertIn(marker, sys_txt)
        self._with_key(run)

    def test_agent_plan_injects_verbosity(self):
        def run():
            with mock.patch.object(app_module, "_llm_prompt", return_value='{"action":"none"}') as m:
                app_module._agent_plan("gemini", "hi", agent_prompt="Aap Administrator hain.")
            sys_txt = m.call_args[0][1]
            for marker in ("No-Resume Rule", "Zero-Fluff Policy", "Actionable Follow-ups"):
                self.assertIn(marker, sys_txt)
        self._with_key(run)


_PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def _make_pdf(text="CPT 99213 was denied because modifier 25 is missing."):
    import fitz

    doc = fitz.open()
    page = doc.new_page(width=300, height=200)
    page.insert_text((40, 80), text, fontsize=11)
    buf = io.BytesIO()
    doc.save(buf)
    doc.close()
    return buf.getvalue()


def _make_scanned_pdf():
    import fitz

    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 180, 180))
    pix.clear_with(200)
    doc = fitz.open()
    page = doc.new_page(width=180, height=180)
    page.insert_image(page.rect, pixmap=pix)
    buf = io.BytesIO()
    doc.save(buf)
    doc.close()
    return buf.getvalue()


class TestChatAttachments(BaseTest):
    """Phase 4: document vision / PDF parsing in chat."""

    def setUp(self):
        super().setUp()
        self.register()
        self.login()
        app_module._set_app_setting("agent_enabled", "0")
        app_module._set_app_setting("live_chat_ai", "0")
        app_module._set_app_setting("review_enabled", "0")
        app_module._CHAT_FILE_BUCKET.clear()
        self._reg = None

    def tearDown(self):
        app_module._CHAT_FILE_BUCKET.clear()
        super().tearDown()

    def _with_key(self, fn):
        os.environ["GEMINI_API_KEY"] = "AIza-test"
        try:
            return fn()
        finally:
            os.environ.pop("GEMINI_API_KEY", None)

    def _resolved_pdf(self, text="CPT 99213 denied - wrong modifier"):
        return [{
            "kind": "pdf", "filename": "denial.pdf", "mime": "application/pdf",
            "text": text, "pages": [], "created": time.time(),
        }]

    def test_image_parts_provider_shapes(self):
        atts = [{"kind": "image", "filename": "x.png", "mime": "image/png", "b64": "QUJD"}]
        self.assertEqual(
            app_module._image_parts(atts, openai_style=False),
            [{"inline_data": {"mime_type": "image/png", "data": "QUJD"}}],
        )
        self.assertEqual(
            app_module._image_parts(atts, openai_style=True),
            [{"type": "image_url", "image_url": {"url": "data:image/png;base64,QUJD"}}],
        )

    def test_llm_payload_gemini_multimodal(self):
        meta = app_module.CHAT_PROVIDERS["gemini"]
        url, body, _parse = app_module._llm_payload("gemini", "sys", "user", meta, "g-model", 0.5, 100, attachments=[
            {"kind": "image", "filename": "a.png", "mime": "image/png", "b64": "QUJD"}
        ])
        self.assertIn("generateContent", url)
        parts = body["contents"][0]["parts"]
        self.assertEqual(parts[0]["text"], "user")
        self.assertEqual(parts[1]["inline_data"]["data"], "QUJD")

    def test_llm_payload_openai_multimodal(self):
        meta = app_module.CHAT_PROVIDERS["openai"]
        url, body, _parse = app_module._llm_payload("openai", "sys", "user", meta, "o-model", 0.5, 100, attachments=[
            {"kind": "image", "filename": "a.png", "mime": "image/png", "b64": "QUJD"}
        ])
        self.assertIn("chat/completions", url)
        user_msg = body["messages"][1]["content"]
        self.assertIsInstance(user_msg, list)
        self.assertEqual(user_msg[0]["type"], "text")
        self.assertEqual(user_msg[1]["image_url"]["url"], "data:image/png;base64,QUJD")

    def test_gemini_reply_injects_doc_text(self):
        def run():
            atts = self._resolved_pdf()
            with mock.patch.object(app_module, "_llm_prompt", return_value="ok") as m:
                app_module._gemini_reply("gemini", "why denied?", "", attachments=atts)
            self.assertIn("CPT 99213 denied", m.call_args[0][1])
            self.assertEqual(m.call_args[1]["attachments"], atts)
        self._with_key(run)

    def test_agent_plan_includes_uploaded_doc(self):
        def run():
            atts = self._resolved_pdf()
            with mock.patch.object(app_module, "_llm_prompt", return_value='{"action":"none"}') as m:
                app_module._agent_plan("gemini", "apply this to the denial", attachments=atts)
            user_txt = m.call_args[0][2]
            self.assertIn("UPLOADED DOCUMENT", user_txt)
            self.assertIn("CPT 99213 denied", user_txt)
        self._with_key(run)

    def test_review_draft_sees_document(self):
        def run():
            atts = self._resolved_pdf(text="18,000.00")
            with mock.patch.object(app_module, "_reviewer_provider", return_value="gemini"), \
                 mock.patch.object(app_module, "_llm_prompt", return_value='{"verdict":"approved"}') as m:
                verdict, critique = app_module._review_draft(None, "draft", "draft an appeal", "Medical Billing", attachments=atts)
            self.assertEqual(verdict, "approved")
            self.assertIn("18,000.00", m.call_args[0][2])
        self._with_key(run)

    def test_pdf_extract_text(self):
        out = app_module._pdf_extract(_make_pdf())
        self.assertIn("99213", out["text"])
        self.assertEqual(out["pages"], [])

    def test_pdf_extract_scanned_renders_pages(self):
        out = app_module._pdf_extract(_make_scanned_pdf())
        self.assertEqual(out["text"], "")
        self.assertTrue(out["pages"])
        self.assertEqual(out["pages"][0]["mime"], "image/jpeg")
        self.assertTrue(out["pages"][0]["b64"])

    def test_upload_rejects_bad_types_and_size(self):
        data = {"file": (io.BytesIO(b"just plain text"), "notes.txt")}
        self.assertEqual(self.client.post("/api/chat/upload", data=data, content_type="multipart/form-data").status_code, 400)
        data = {"file": (io.BytesIO(b"NOT an image"), "fake.png")}
        self.assertEqual(self.client.post("/api/chat/upload", data=data, content_type="multipart/form-data").status_code, 400)
        big = b"\x89PNG\r\n\x1a\n" + b"A" * (5 * 1024 * 1024)
        data = {"file": (io.BytesIO(big), "huge.png")}
        self.assertEqual(self.client.post("/api/chat/upload", data=data, content_type="multipart/form-data").status_code, 400)

    def test_upload_png_roundtrip(self):
        r = self.client.post(
            "/api/chat/upload",
            data={"file": (io.BytesIO(_PNG_1PX), "eob.png")},
            content_type="multipart/form-data",
        )
        self.assertEqual(r.status_code, 200)
        j = r.get_json()
        self.assertEqual(j["kind"], "image")
        res = app_module._resolve_attachments([j["token"]])
        self.assertEqual(res[0]["kind"], "image")
        self.assertTrue(res[0]["b64"])

    def test_upload_pdf_extracts_text(self):
        r = self.client.post(
            "/api/chat/upload",
            data={"file": (io.BytesIO(_make_pdf()), "denial.pdf")},
            content_type="multipart/form-data",
        )
        self.assertEqual(r.status_code, 200)
        res = app_module._resolve_attachments([r.get_json()["token"]])
        self.assertEqual(res[0]["kind"], "pdf")
        self.assertIn("99213", res[0]["text"])

    def test_resolve_purges_expired_tokens(self):
        app_module._CHAT_FILE_BUCKET["stale"] = {
            "kind": "image", "filename": "a.png", "mime": "image/jpeg",
            "b64": "QUJD", "created": time.time() - 99999,
        }
        self.assertIsNone(app_module._resolve_attachments(["stale"]))
        self.assertNotIn("stale", app_module._CHAT_FILE_BUCKET)

    def test_chat_message_with_attachments_reaches_llm(self):
        atts = self._resolved_pdf(text="Modifier 25 missing")
        app_module._CHAT_FILE_BUCKET["tokA"] = atts[0]
        sid = self.client.post("/api/chat/sessions", json={}).get_json()["id"]
        os.environ["GEMINI_API_KEY"] = "AIza-test"
        try:
            with mock.patch.object(app_module, "_llm_prompt", return_value="ok") as m:
                r = self.client.post(
                    f"/api/chat/sessions/{sid}/messages",
                    json={"message": "why was my claim denied?", "attachments": ["tokA"]},
                )
            self.assertEqual(r.status_code, 200)
            self.assertEqual(m.call_args[1].get("attachments"), atts)
            self.assertIn("Modifier 25 missing", m.call_args[0][1])
        finally:
            os.environ.pop("GEMINI_API_KEY", None)

    def test_stream_endpoint_parses_attachment_arg(self):
        app_module._CHAT_FILE_BUCKET["tokB"] = self._resolved_pdf(text="EOB 202,681.00")[0]
        sid = self.client.post("/api/chat/sessions", json={}).get_json()["id"]
        os.environ["GEMINI_API_KEY"] = "AIza-test"
        try:
            with mock.patch.object(app_module, "_chat_flow_events", return_value=iter([])) as mf:
                r = self.client.get(
                    f"/api/chat/sessions/{sid}/stream?q=parse this&a={json.dumps(['tokB'])}",
                    buffered=True,
                )
                called = mf.call_args
            self.assertEqual(r.status_code, 200)
            self.assertEqual(called.kwargs["attachments"][0]["text"], "EOB 202,681.00")
        finally:
            os.environ.pop("GEMINI_API_KEY", None)


class TestMentionRouting(unittest.TestCase):
    """@AgentName mention overrides every routing rule and strips the tag."""

    def _actives(self):
        return [
            {"id": 1, "name": "Rumman Lashari", "icon": "", "description": "Administrator & Agent Coordinator - poore system ka boss.", "system_prompt": ""},
            {"id": 2, "name": "Medical Billing", "icon": "", "description": "Medical Billing specialist - RCM.", "system_prompt": ""},
            {"id": 3, "name": "Adnan Gul", "icon": "", "description": "VDL Data Entry Dep Head.", "system_prompt": ""},
        ]

    def _route(self, q):
        return app_module._agent_router(q, self._actives())

    def _name(self, agent):
        return agent["name"] if agent else None

    def test_mention_forces_agent_over_domain(self):
        # "CPT" normally routes to the billing expert, but the @mention wins.
        self.assertEqual(self._name(self._route("@Adnan CPT 99213 ka code batao")), "Adnan Gul")

    def test_mention_forces_agent_over_named_manager(self):
        self.assertEqual(self._name(self._route("@Rumman pending tasks kya hain")), "Rumman Lashari")

    def test_mention_strips_tag_keeps_rest(self):
        agent, q = app_module._mention_target("@Adnan Gul data entry kaise karein", self._actives())
        self.assertEqual(agent["name"], "Adnan Gul")
        self.assertEqual(q, "data entry kaise karein")

    def test_mention_exact_token_keeps_rest(self):
        agent, q = app_module._mention_target("@Medical Billing claim deny kyun hua", self._actives())
        self.assertEqual(agent["name"], "Medical Billing")
        self.assertEqual(q, "claim deny kyun hua")

    def test_mention_not_at_start_untouched(self):
        agent, q = app_module._mention_target("kya hal hai @Adnan", self._actives())
        self.assertIsNone(agent)
        self.assertEqual(q, "kya hal hai @Adnan")

    def test_unknown_mention_untouched(self):
        agent, q = app_module._mention_target("@Doctor mera bp check karo", self._actives())
        self.assertIsNone(agent)
        self.assertEqual(q, "@Doctor mera bp check karo")

    def test_bare_mention_routes_and_strips(self):
        actives = self._actives() + [
            {"id": 9, "name": "Aazaz", "icon": "", "description": "Executive file-ops assistant.", "system_prompt": ""}
        ]
        agent, q = app_module._mention_target("@aazaz", actives)
        self.assertEqual(agent["name"], "Aazaz")
        self.assertEqual(q, "Aazaz")
        self.assertEqual(self._name(app_module._agent_router("@aazaz", actives)), "Aazaz")


if __name__ == "__main__":
    unittest.main(verbosity=2)