# Deploy to PythonAnywhere

Apna Flask app PythonAnywhere (PA) par free tier mein host karne ke ready-to-run steps. Sab PA **Bash console** se chalta hai.

## 0. Prerequisites
- GitHub repo: `https://github.com/Arslan10899/Note-Book-v3.git` (public/private, yes ban raha hai aap men)
- PA account banao ya login karo → https://www.pythonanywhere.com

## 1. Web app + virtualenv banao
PA dashboard men:
**Web > Add a new web app > Flask > Python 3.10 (ya 3.11) — WSGI file: `flask_app` (default na, manual)**
- Uske baad **Web > Virtualenv** section mein: `Create a virtualenv` karke install:

```
pip install Flask==3.0.3 Pillow==10.4.0 openpyxl==3.1.5 python-docx==1.1.2 reportlab==4.2.5 pypdf==5.1.0 PyMuPDF==1.24.9
```

## 2. Source code consol par lao

Ek **Bash console** kholo (`Consoles > Bash`) aur:
```
cd ~
git clone https://github.com/Arslan10899/Note-Book-v3.git
mv Note-Book-v3 note_book && cd note_book    # PA ke liye short, no-space name
```

## 3. WSGI file — project directory par point karo

PA ka default WSGI sirf `flask_app.py` import karta hai. Hamare repo mein `wsgi.py` hai jo `application = app` export karta hai. PA **Web tab > WSGI configuration file** kholo aur poori file ko is se badlo:

```python
import os
import sys

# Project directory
project_home = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, project_home)
os.chdir(project_home)

from wsgi import application   # wsgi.py exports `application = app`
```

> Haan ye `from wsgi import application` wala wsgi.py? Nahin — wsgi.py already `from app import app as application` karta hai; PA ko bas project dir path men rakhna hai. Soch simplify: sirf `import sys; sys.path.insert(0, "/home/YOURUSERNAME/note_book"); from app import app as application` — 2 line. PA WSGI file mein direct:

```python
import sys
sys.path.insert(0, "/home/YOUR_UPA_USERNAME/note_book")
from app import app as application
```

## 4. Static files

**Web > Static files**: URL `/static/` → `/home/YOUR_UPA_USERNAME/note_book/static/` (Add a new static file mapping tab add karo). Yehr main jin `static/js/app.js` register assets render).

## 5. DB / uploads / secret — environment

Web app par environment variables set karne ke liye: WSGI file ke top par `os.environ`:

```python
import os
os.environ["ASSISTANT_DB"] = "/home/YOUR_UPA_USERNAME/note_book/assistant.db"
os.environ["ASSISTANT_UPLOADS"] = "/home/YOUR_UPA_USERNAME/note_book/uploads"
os.environ["ASSISTANT_SECRET"] = "kuch-strong-value"   # agar app secret env se leta hai
```

Aur **secret.key** file banao (wo secret_key_file path use hota hai toh):
```
cd ~/note_book
echo "change-this-to-a-long-random-string" > secret.key
mkdir -p uploads
```

## 6. Reload

**Web tab > Reload** dabao. Browser mein `http://YOUR_UPA_USERNAME.pythonanywhere.com` kholo.

## 7. Updated code push karne par (future)

```
cd ~/note_book
git pull
# Web > Reload (purana pedantic reload hi kafi)
```

---

## Troubleshooting
- **502/503** → app exception: console se `tail -f /var/log/*error.log*` dekhpurana logfile manzil pa pythonanywhere.
- **static CSS/JS nahi dikh raha** → Static mapping step 4 chhuta hai, ya browser cache: Ctrl+Shift+R.
- **jinja templates aur CSS dark/light theme** → index.html mein `app.js?v=N` script tag cache-bust use hota hai; koi issue nahi.
- DB path change possible `ASSISTANT_DB` env se PA par.

---
*Repo (git) deployment pack v3 — build from commit `9b9e33c` (brand icon blood red + portal icon colorful-square removed).*
