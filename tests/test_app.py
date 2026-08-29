import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

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
        app_module.reset_db()
        conn = sqlite3.connect(app_module.DB_PATH)
        conn.executescript("DELETE FROM users;")
        conn.commit()
        conn.close()

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
        ]:
            self.assertIn(name, idx, f"missing index {name}")


if __name__ == "__main__":
    unittest.main(verbosity=2)