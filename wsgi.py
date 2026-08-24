import sys
import os

# Ensure project folder is on the path & writable (SQLite + uploads)
project_home = os.path.dirname(os.path.abspath(__file__))
if project_home not in sys.path:
    sys.path.insert(0, project_home)
os.chdir(project_home)

from app import app as application  # noqa: E402
