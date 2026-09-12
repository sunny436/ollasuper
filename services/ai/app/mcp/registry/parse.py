"""Registry JSON → normalized catalogue records. PURE: no I/O, no DB, no clock.

Kept pure like `app/finance/calc.py`, so every parsing and classification
decision is testable against captured fixtures with nothing running.

TWO RULES THIS FILE EXISTS TO ENFORCE:

1. UPSTREAM IS PRESERVED, NOT INTERPRETED. `remotes`, `packages` and the whole
   `raw` payload are carried verbatim. `transports` and `auth_kind` are DERIVED
   for filtering and are labelled as such everywhere — OllaSuper must never
   present its own derivation as something the publisher asserted.

2. EVERY STRING IS HOSTILE. These values come from an open registry anyone can
   publish to. They are length-bounded and stripped of control characters before
   they reach a database, a log line or a UI. Nothing here is executed,
   interpolated into SQL, or used to build a filesystem path.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

__all__ = [
    "AUTH_KINDS",
    "ParsedPage",
    "ServerRecord",
    "VersionRecord",
    "parse_page",
]

# Field bounds. A registry entry is published by a stranger; an unbounded
# description is a cheap way to bloat every row and every search index.
_MAX_NAME = 512
_MAX_TITLE = 512
_MAX_DESC = 8_000
_MAX_URL = 2_048
_MAX_VERSION = 128
# Control characters other than tab/newline. Stripped so a crafted description
# cannot forge log structure or smuggle terminal escapes.
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

# Derived classification, recorded as DECLARED_BY_REGISTRY or UNKNOWN — never
# inferred from documentation or guessed from a URL.
AUTH_KINDS = ("none", "oauth", "api_key", "bearer", "unknown")

_UPSTREAM_STATUSES = ("active", "deprecated", "deleted")
_OFFICIAL_META = "io.modelcontextprotocol.registry/official"


def _clean(value: Any, limit: int) -> str | None:
    """Bounded, control-stripped text, or None. The single funnel every upstream
    string passes through before it is stored or logged."""
    if not isinstance(value, str):
        return None
    out = _CTRL.sub("", value).strip()
    if not out:
        return None
    return out[:limit]


def _ts(value: Any) -> datetime | None:
    """RFC3339 → datetime. A malformed timestamp is None, never an exception:
    one unparseable field must not cost the whole record."""
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _status(value: Any) -> str:
    """Upstream lifecycle, constrained to the values the API documents."""
    return value if value in _UPSTREAM_STATUSES else "active"


def _publisher(name: str) -> str | None:
    """The reverse-DNS namespace that owns the server.

    Registry names look like "ac.inference.sh/mcp" or "ai.smithery/x". The part
    before the first "/" is the publisher namespace, which the registry itself
    verifies via DNS/GitHub ownership — so it is the most meaningful grouping key
    available and is worth a column of its own.
    """
    head = name.split("/", 1)[0]
    return head or None


def _derive_transports(remotes: list, packages: list) -> list[str]:
    """DERIVED. The transport kinds this version declares, de-duplicated.

    Remote entries carry `type` ("streamable-http" / "sse"); package entries
    carry a nested `transport.type` (usually "stdio"). Filtering on a text[] is
    far cheaper than digging through jsonb on every query.
    """
    kinds: list[str] = []
    for r in remotes:
        t = _clean((r or {}).get("type"), 64) if isinstance(r, dict) else None
        if t and t not in kinds:
            kinds.append(t)
    for p in packages:
        if not isinstance(p, dict):
            continue
        tr = p.get("transport")
        t = _clean((tr or {}).get("type"), 64) if isinstance(tr, dict) else None
        if t and t not in kinds:
            kinds.append(t)
    return kinds


def _derive_auth_kind(remotes: list, packages: list) -> str:
    """DERIVED, and deliberately conservative.

    The registry does not publish an auth-scheme field. What it DOES publish is
    concrete: a remote's `headers[]` (with `isSecret`) and a package's
    `environmentVariables[]` (with `isSecret`). So this reports what was
    DECLARED — a secret is required, and what it looks like — and returns
    "unknown" rather than guessing when nothing says.

    Phase 4 consumes this to decide which credential flow a connection needs; a
    wrong guess here would send a user down an OAuth flow a server does not
    speak, so an honest "unknown" is worth more than a confident guess.
    """
    saw_secret = False
    for r in remotes:
        if not isinstance(r, dict):
            continue
        for h in r.get("headers") or []:
            if not isinstance(h, dict):
                continue
            name = (_clean(h.get("name"), 128) or "").lower()
            value = (_clean(h.get("value"), 256) or "").lower()
            if h.get("isSecret"):
                saw_secret = True
            if name == "authorization":
                # "Bearer {token}" is the overwhelmingly common shape and is a
                # static token, NOT an OAuth flow — calling it oauth would be
                # exactly the inference this function refuses to make.
                return "bearer" if value.startswith("bearer") else "api_key"
            if "api" in name and "key" in name:
                return "api_key"
    for p in packages:
        if not isinstance(p, dict):
            continue
        for e in p.get("environmentVariables") or []:
            if isinstance(e, dict) and e.get("isSecret"):
                saw_secret = True
    if saw_secret:
        return "api_key"
    # No secret declared anywhere. Still not "none" for a remote server: the
    # registry simply may not describe its auth. Only a package server with no
    # secret env vars is confidently unauthenticated.
    if packages and not remotes:
        return "none"
    return "unknown"


@dataclass(frozen=True)
class VersionRecord:
    server_name: str
    version: str
    is_latest: bool
    status: str
    published_at: datetime | None
    upstream_updated_at: datetime | None
    schema_version: str | None
    remotes: list = field(default_factory=list)
    packages: list = field(default_factory=list)
    transports: list[str] = field(default_factory=list)
    auth_kind: str = "unknown"
    raw: dict = field(default_factory=dict)


@dataclass(frozen=True)
class ServerRecord:
    name: str
    title: str | None
    description: str | None
    status: str
    status_changed_at: datetime | None
    status_message: str | None
    latest_version: str | None
    publisher: str | None
    repository_url: str | None
    repository_source: str | None
    repository_subfolder: str | None
    upstream_updated_at: datetime | None


@dataclass(frozen=True)
class ParsedPage:
    servers: list[ServerRecord]
    versions: list[VersionRecord]
    next_cursor: str | None
    skipped: int
    #: Oldest `updatedAt` seen. The sync uses this to detect that an
    #: `updated_since` filter was silently ignored — see sync.py.
    oldest_updated_at: datetime | None


def parse_entry(entry: Any) -> tuple[ServerRecord, VersionRecord] | None:
    """One `{server, _meta}` entry → (server, version), or None if unusable.

    Returns None rather than raising: one malformed record must not cost the
    whole page.
    """
    if not isinstance(entry, dict):
        return None
    server = entry.get("server")
    if not isinstance(server, dict):
        return None
    name = _clean(server.get("name"), _MAX_NAME)
    version = _clean(server.get("version"), _MAX_VERSION)
    if not name or not version:
        return None

    meta = entry.get("_meta")
    official = {}
    if isinstance(meta, dict):
        official = meta.get(_OFFICIAL_META) or {}
        if not isinstance(official, dict):
            official = {}

    repo = server.get("repository")
    repo = repo if isinstance(repo, dict) else {}
    remotes = server.get("remotes")
    remotes = remotes if isinstance(remotes, list) else []
    packages = server.get("packages")
    packages = packages if isinstance(packages, list) else []

    status = _status(official.get("status"))
    updated_at = _ts(official.get("updatedAt"))

    return (
        ServerRecord(
            name=name,
            title=_clean(server.get("title"), _MAX_TITLE),
            description=_clean(server.get("description"), _MAX_DESC),
            status=status,
            status_changed_at=_ts(official.get("statusChangedAt")),
            status_message=_clean(official.get("statusMessage"), _MAX_DESC),
            latest_version=version if official.get("isLatest") else None,
            publisher=_publisher(name),
            repository_url=_clean(repo.get("url"), _MAX_URL),
            repository_source=_clean(repo.get("source"), 64),
            repository_subfolder=_clean(repo.get("subfolder"), _MAX_URL),
            upstream_updated_at=updated_at,
        ),
        VersionRecord(
            server_name=name,
            version=version,
            is_latest=bool(official.get("isLatest")),
            status=status,
            published_at=_ts(official.get("publishedAt")),
            upstream_updated_at=updated_at,
            schema_version=_clean(server.get("$schema"), _MAX_URL),
            remotes=remotes,
            packages=packages,
            transports=_derive_transports(remotes, packages),
            auth_kind=_derive_auth_kind(remotes, packages),
            raw=server,
        ),
    )


def parse_page(payload: Any) -> ParsedPage:
    """A `/v0.1/servers` response → normalized records + the next cursor."""
    servers: list[ServerRecord] = []
    versions: list[VersionRecord] = []
    skipped = 0
    oldest: datetime | None = None

    entries = payload.get("servers") if isinstance(payload, dict) else None
    for entry in entries or []:
        parsed = parse_entry(entry)
        if parsed is None:
            skipped += 1
            continue
        srv, ver = parsed
        servers.append(srv)
        versions.append(ver)
        if ver.upstream_updated_at is not None and (
            oldest is None or ver.upstream_updated_at < oldest
        ):
            oldest = ver.upstream_updated_at

    meta = payload.get("metadata") if isinstance(payload, dict) else None
    cursor = (
        _clean((meta or {}).get("nextCursor"), 1024) if isinstance(meta, dict) else None
    )

    return ParsedPage(
        servers=servers,
        versions=versions,
        next_cursor=cursor,
        skipped=skipped,
        oldest_updated_at=oldest,
    )
