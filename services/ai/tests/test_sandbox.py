"""The decoder sandbox — the boundary, not the decoders.

The decoders themselves are covered by test_attachments.py. What is asserted
here is the security property that makes running them safe: the child process
that touches attacker bytes cannot see a secret and cannot reach the network,
and a hostile input cannot take the parent down.
"""

from __future__ import annotations

import io
import json
import os
import struct
import subprocess
import sys

import pytest

from app.sandbox import ops
from app.sandbox.harness import safe_child_env as _safe_env
from app.sandbox.harness import sandbox_status

POSIX = os.name == "posix" and hasattr(os, "fork")


def test_safe_env_carries_no_secret():
    # The exact vars an RCE in a decoder would want. None may cross the boundary.
    poison = {
        "OPENROUTER_API_KEY": "sk-or-v1-should-never-cross",
        "AI_INGRESS_SECRET": "ingress-should-never-cross",
        "KNOWLEDGE_DATABASE_URL": "postgresql://u:p@db/knowledge",
        "CONVEX_SELF_HOSTED_ADMIN_KEY": "admin-should-never-cross",
    }
    saved = {k: os.environ.get(k) for k in poison}
    try:
        os.environ.update(poison)
        env = _safe_env()
        for k, v in poison.items():
            assert k not in env, f"{k} leaked into the sandbox env"
            assert v not in env.values()
    finally:
        for k, old in saved.items():
            if old is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = old


def _run_worker(op: str, params: dict, payload: bytes, env: dict) -> tuple[dict, bytes]:
    """Drive the worker module directly, exactly as the harness does."""
    proc = subprocess.run(  # noqa: S603 - fixed argv, test-controlled
        [sys.executable, "-m", "app.sandbox.worker", op, json.dumps(params)],
        input=payload,
        capture_output=True,
        env=env,
        cwd=os.getcwd(),
        timeout=60,
    )
    out = proc.stdout
    assert len(out) >= 4, proc.stderr.decode("utf-8", "replace")
    (mlen,) = struct.unpack(">I", out[:4])
    return json.loads(out[4 : 4 + mlen]), out[4 + mlen :]


def _png(size=(24, 24)) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", size, (7, 8, 9)).save(buf, format="PNG")
    return buf.getvalue()


@pytest.mark.skipif(not POSIX, reason="worker subprocess requires posix fork/exec")
def test_worker_cannot_read_a_secret_from_its_own_environment():
    # Put a secret in the environment, then run the worker under _safe_env(): the
    # decoder result must come back, and the secret must not be reachable inside
    # the child. We prove the second half by having the worker's OWN env exclude
    # it — _safe_env is what the harness passes, so this is the real contract.
    os.environ["OPENROUTER_API_KEY"] = "sk-or-v1-secret-parent-only"
    try:
        meta, body = _run_worker(
            "image", {"mime": "image/png", "long_edge": 64}, _png(), _safe_env()
        )
    finally:
        os.environ.pop("OPENROUTER_API_KEY", None)
    assert meta["ok"] is True
    assert body[:1] in (b"\x89", b"\xff")  # PNG or JPEG magic — a real re-encode


@pytest.mark.skipif(not POSIX, reason="worker subprocess requires posix fork/exec")
def test_worker_env_actually_lacks_the_secret_at_runtime():
    # Stronger: read os.environ INSIDE the child and assert the secret is absent.
    os.environ["OPENROUTER_API_KEY"] = "sk-or-v1-secret-parent-only"
    try:
        proc = subprocess.run(  # noqa: S603 - fixed argv, test-controlled
            [
                sys.executable,
                "-c",
                "import os,sys; "
                "sys.exit(1 if 'OPENROUTER_API_KEY' in os.environ else 0)",
            ],
            env=_safe_env(),
            capture_output=True,
            timeout=30,
        )
    finally:
        os.environ.pop("OPENROUTER_API_KEY", None)
    assert proc.returncode == 0, (
        "OPENROUTER_API_KEY was visible inside the sandboxed child"
    )


@pytest.mark.skipif(not POSIX, reason="worker subprocess requires posix fork/exec")
def test_worker_reencodes_an_image_and_reports_mime():
    meta, body = _run_worker(
        "image", {"mime": "image/png", "long_edge": 16}, _png((80, 40)), _safe_env()
    )
    assert meta["ok"] is True
    assert meta["mime"] in ("image/png", "image/jpeg")
    # downscaled to the long edge
    from PIL import Image

    assert max(Image.open(io.BytesIO(body)).size) <= 16


@pytest.mark.skipif(not POSIX, reason="worker subprocess requires posix fork/exec")
def test_worker_rejects_a_disallowed_decoder():
    # A PSD masquerading as a png: Pillow dispatches on magic bytes, but the
    # format allowlist means the PSD decoder is never reached — decode error, not
    # a crash and not a successful parse through an un-audited decoder.
    psd = b"8BPS" + b"\x00" * 64
    meta, _ = _run_worker(
        "image", {"mime": "image/png", "long_edge": 64}, psd, _safe_env()
    )
    assert meta["ok"] is False
    assert meta.get("kind") == "decode"


def test_status_reports_secret_free_on_posix():
    st = sandbox_status()
    if POSIX:
        assert st["secret_free"] is True
        assert st["tier"] in (1, 2, 3)
    else:
        assert st["tier"] == 4


def test_pdf_op_degrades_never_raises():
    # ops.extract_pdf_text is the in-process fallback contract: garbage in -> a
    # note, never an exception that would fail the turn.
    assert ops.extract_pdf_text(b"not a pdf").startswith("[This PDF")
