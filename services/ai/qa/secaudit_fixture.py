"""A small, deliberately vulnerable git repository for security-audit tests.

Used by the unit tests AND by `deploy/65-secaudit.sh` on the VM, so the repository
the headed-Chrome verification audits is exactly the one the tests pin.

NO SECRET LITERAL IS COMMITTED TO OLLASUPER. The fake credentials are assembled at
generation time from fragments and a seed, so neither this file nor the repo it
lives in carries a token-shaped string (GitHub push protection and our own
secret sweep stay quiet on OllaSuper itself). They exist only inside the
generated fixture.

    uv run python -m qa.secaudit_fixture /opt/secaudit/fixture
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

APP_PY = """\
import sqlite3

import requests
from flask import Flask, request, send_file

from config import DB_PATH

app = Flask(__name__)


@app.get("/users")
def users():
    name = request.args.get("name", "")
    db = sqlite3.connect(DB_PATH)
    query = "SELECT id, email FROM users WHERE name = '" + name + "'"
    rows = db.execute(query).fetchall()
    return {"rows": rows}


@app.get("/invoices/<int:invoice_id>")
def invoice(invoice_id):
    db = sqlite3.connect(DB_PATH)
    row = db.execute("SELECT * FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
    return {"invoice": row}


@app.get("/preview")
def preview():
    url = request.args.get("url", "")
    return requests.get(url, timeout=5).text


@app.get("/download")
def download():
    name = request.args.get("file", "")
    return send_file("/srv/uploads/" + name)
"""

REQUIREMENTS = "flask==0.12.2\nrequests==2.19.0\njinja2==2.10\n"

README = "# billing-lite\n\nA tiny invoice service used to exercise security audits.\n"


def planted(seed: str = "ollasuper-secaudit") -> dict[str, str]:
    """The fake credentials the fixture carries (for leak checks by value)."""
    h = hashlib.sha256(seed.encode("utf-8")).hexdigest()
    return {
        "github_token": "gh" + "p_" + (h + h)[:36],
        "aws_access_key": "AK" + "IA" + h[:16].upper(),
        "db_password": "Pw" + h[16:40],
        "env_only_secret": "sk" + "_live_" + h[40:64],
    }


def build(path: Path, seed: str = "ollasuper-secaudit") -> dict[str, str]:
    """Create (or recreate) the fixture repository at `path`; returns `planted()`."""
    secrets = planted(seed)
    path.mkdir(parents=True, exist_ok=True)
    files = {
        "app.py": APP_PY,
        "config.py": (
            'DB_PATH = "billing.db"\n'
            f'GITHUB_TOKEN = "{secrets["github_token"]}"\n'
            f'AWS_ACCESS_KEY_ID = "{secrets["aws_access_key"]}"\n'
            f'DB_PASSWORD = "{secrets["db_password"]}"\n'
        ),
        "requirements.txt": REQUIREMENTS,
        "README.md": README,
        ".gitignore": ".env\n*.db\n",
    }
    for name, text in files.items():
        (path / name).write_text(text, encoding="utf-8", newline="\n")
    # Present on disk but IGNORED: the audit must never be able to read it.
    (path / ".env").write_text(
        f"STRIPE_KEY={secrets['env_only_secret']}\n", encoding="utf-8", newline="\n"
    )

    def git(*args: str) -> None:
        subprocess.run(  # noqa: S603 — fixed argv
            [  # noqa: S607
                "git",
                "-c",
                "user.name=secaudit",
                "-c",
                "user.email=secaudit@localhost",
                "-c",
                "commit.gpgsign=false",
                *args,
            ],
            cwd=path,
            check=True,
            capture_output=True,
        )

    if not (path / ".git").exists():
        git("init", "-q", "-b", "main")
    git("add", "app.py", "config.py", "requirements.txt", "README.md", ".gitignore")
    git("commit", "-q", "--allow-empty", "-m", "billing-lite fixture")
    return secrets


if __name__ == "__main__":
    target = Path(sys.argv[1] if len(sys.argv) > 1 else "secaudit-fixture")
    build(target)
    print(json.dumps({"fixture": str(target), "files": 5}))
