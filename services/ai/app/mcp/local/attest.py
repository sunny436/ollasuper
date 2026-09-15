"""Is the running container the one the row describes? PURE checks + the
attestation file the plane gates on.

THE HONEST LIMIT THIS CLOSES. `policy.py` said, of the previous gateway:
"passing this validator means OllaSuper approved the configuration. It does
NOT mean the gateway applied it." This module is the other half. The
launcher (`bridge/mcp_bridge.py`, root, holds the Docker socket) runs
`docker inspect` on the container it started and hands the JSON to `check`,
which compares it field by field with `launch.expected(row)`. Any mismatch:
the container is removed, the attestation says `verified: false`, the unit
exits non-zero. Success: an attestation file is written, root-owned, under
`/run/myos/mcp-local/<slug>.json`.

THE PLANE GATES ON THE FILE. `gateway.resolve_local_spec` refuses to dial a
local server unless a fresh, verified attestation exists whose digest matches
the row — so "the flags were applied" is checked before every session, not
assumed from a script having run. The AI plane still holds no Docker socket:
it reads a file root wrote.

WHAT IS CHECKED, and why each is enough:
  Image            == the row's digest: the content that runs is the content
                      the operator pinned
  CapDrop == [ALL], CapAdd empty, Privileged false, SecurityOpt has
  no-new-privileges: no capability, no escalation
  ReadonlyRootfs   true; Binds/Mounts only the tmpfs: no host filesystem
  NetworkMode      none: no egress at all
  User             65534:65534: never root inside
  PidsLimit, Memory, NanoCpus == the row's ceilings
  Devices empty, IpcMode/PidMode not host
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from app.mcp.local.launch import Expected

__all__ = [
    "ATTESTATION_DIR",
    "Attestation",
    "attestation_path",
    "check",
    "load",
    "verified_for",
    "write",
]

ATTESTATION_DIR = Path("/run/myos/mcp-local")
#: An attestation older than this is stale: the launcher rewrites it on every
#: start, and a container that has outlived its unit is not one we vouch for.
MAX_AGE_S = 7 * 24 * 3600
#: The one mount a container may have: the launcher's scratch tmpfs. (This is
#: the CONTAINER's /tmp, not a host temp path — the S108 lint is about hosts.)
TMPFS_MOUNT = "/tmp"  # noqa: S108


def attestation_path(slug: str, base: Path | None = None) -> Path:
    return (base or ATTESTATION_DIR) / f"{slug}.json"


@dataclass(frozen=True)
class Attestation:
    slug: str
    verified: bool
    image_digest: str
    container_id: str
    started_at: float
    failed: tuple[str, ...] = ()

    def as_json(self) -> str:
        return json.dumps(asdict(self), sort_keys=True)


def _host_config(inspect: dict[str, Any]) -> dict[str, Any]:
    return inspect.get("HostConfig") or {}


def check(inspect: dict[str, Any], exp: Expected) -> list[str]:
    """Every way the running container differs from the row. Empty = attested."""
    failed: list[str] = []
    host = _host_config(inspect)
    config = inspect.get("Config") or {}

    image = str(inspect.get("Image") or "")
    if image != exp.image_digest:
        failed.append("image digest")
    if [str(c).upper() for c in (host.get("CapDrop") or [])] != ["ALL"]:
        failed.append("CapDrop")
    if host.get("CapAdd"):
        failed.append("CapAdd")
    if host.get("Privileged") is not False:
        failed.append("Privileged")
    opts = [str(o) for o in (host.get("SecurityOpt") or [])]
    if not any(o.startswith("no-new-privileges") for o in opts):
        failed.append("no-new-privileges")
    if host.get("ReadonlyRootfs") is not True:
        failed.append("ReadonlyRootfs")
    if str(host.get("NetworkMode") or "") != exp.network_mode:
        failed.append("NetworkMode")
    if str(config.get("User") or "") != exp.user:
        failed.append("User")
    if int(host.get("PidsLimit") or 0) != exp.pids_limit:
        failed.append("PidsLimit")
    if int(host.get("Memory") or 0) != exp.memory_bytes:
        failed.append("Memory")
    if int(host.get("NanoCpus") or 0) != exp.nano_cpus:
        failed.append("NanoCpus")
    if host.get("Binds"):
        failed.append("Binds")
    mounts = inspect.get("Mounts") or []
    if any(
        str(m.get("Type")) != "tmpfs" or str(m.get("Destination")) != TMPFS_MOUNT
        for m in mounts
    ):
        failed.append("Mounts")
    if host.get("Devices"):
        failed.append("Devices")
    if (
        str(host.get("PidMode") or "") == "host"
        or str(host.get("IpcMode") or "") == "host"
    ):
        failed.append("PidMode/IpcMode")
    return failed


def write(att: Attestation, base: Path | None = None) -> Path:
    path = attestation_path(att.slug, base)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(att.as_json(), encoding="utf-8")
    tmp.replace(path)
    return path


def load(slug: str, base: Path | None = None) -> Attestation | None:
    path = attestation_path(slug, base)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    try:
        return Attestation(
            slug=str(raw["slug"]),
            verified=bool(raw["verified"]),
            image_digest=str(raw.get("image_digest") or ""),
            container_id=str(raw.get("container_id") or ""),
            started_at=float(raw.get("started_at") or 0.0),
            failed=tuple(str(f) for f in raw.get("failed") or ()),
        )
    except (KeyError, TypeError, ValueError):
        return None


def verified_for(
    row: Any, base: Path | None = None, *, now: float | None = None
) -> bool:
    """The plane's gate: a fresh, verified attestation for THIS row's digest."""
    att = load(str(getattr(row, "slug", "") or ""), base)
    if att is None or not att.verified or att.failed:
        return False
    if att.image_digest != str(getattr(row, "image_digest", "") or ""):
        return False
    current = time.time() if now is None else now
    return 0 < att.started_at <= current and current - att.started_at <= MAX_AGE_S
