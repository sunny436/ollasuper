"""What a validated local server row becomes on the command line. PURE.

WHY THIS REPLACES THE DOCKER MCP GATEWAY (audit H-12). `docker mcp gateway
run` was the previous launcher, and three facts made it unenforceable: it is
not installed on the production host (`docker: unknown command: docker mcp`,
measured 2026-09-15); its `--block-network` and `--verify-signatures` flags are
documented in one line each with no statement of what they do; and it reads
the server's image from its own catalogue, so the row's pinned digest, CPU and
memory ceilings and network policy were policy on paper — nothing consumed
them. `policy.py` validated a configuration that nothing then applied.

WHAT THIS IS INSTEAD. One `docker run` per local server, every flag explicit
and every flag derived from the validated row or fixed by this module:

    --network none                 the ONLY network policy this module emits
    --read-only                    no writable root filesystem
    --cap-drop ALL                 no capabilities at all
    --security-opt no-new-privileges
    --pids-limit 256
    --memory <row>m --cpus <row>   the row's ceilings, under the operator's
    --user 65534:65534             nobody, never root
    --tmpfs /tmp:rw,noexec,nosuid,size=64m
    --env-file <operator file>     the row's `env_allow` names, resolved by the
                                   launcher from a root-only file, never here
    <image>@<sha256 digest>        the pinned digest, so Docker resolves
                                   exactly that content

The container speaks MCP over STDIO (the Docker MCP catalogue's contract);
`bridge/mcp_bridge.py` — a separate process, NOT part of the AI plane —
spawns it, inspects it (`attest.py`), and serves it over loopback HTTP with a
bearer token. This module never spawns anything: it is an argv builder that
`tests/test_mcp_local_launch.py` can hold to a golden string.

`network = allowlist` IS REFUSED HERE even though the schema allows it: no
egress filter has been verified on this host, and emitting a permissive
`--network` with an unverified filter behind it would be the exact "policy on
paper" this module exists to end. A future allowlist lands with its own
attestation check or not at all.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

__all__ = [
    "CONTAINER_USER",
    "PIDS_LIMIT",
    "Expected",
    "LaunchRefused",
    "container_name",
    "docker_argv",
    "expected",
]

CONTAINER_USER = "65534:65534"
PIDS_LIMIT = 256
# The CONTAINER's scratch space, not a host path (S108 is about host temp dirs).
TMPFS = "/tmp:rw,noexec,nosuid,size=64m"  # noqa: S108
_SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,23}$")
_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")


class LaunchRefused(ValueError):
    """The row cannot be turned into a launch. Names the field, never a value."""


def container_name(slug: str) -> str:
    return f"myos-mcp-{slug}"


@dataclass(frozen=True)
class Expected:
    """What `docker inspect` must show for the launch to be attested."""

    image_digest: str
    memory_bytes: int
    nano_cpus: int
    pids_limit: int
    user: str
    network_mode: str


def _require(row: Any, name: str) -> Any:
    value = getattr(row, name, None)
    if value in (None, ""):
        raise LaunchRefused(f"row has no {name}")
    return value


def expected(row: Any) -> Expected:
    """The attestation expectations for `row` — derived exactly once, here, so
    the launcher and the plane agree on what a correct container looks like."""
    digest = str(_require(row, "image_digest"))
    if not _DIGEST.fullmatch(digest):
        raise LaunchRefused("image_digest is not a pinned sha256 digest")
    memory_mb = int(_require(row, "memory_mb"))
    cpus = float(_require(row, "cpus"))
    if memory_mb <= 0 or cpus <= 0:
        raise LaunchRefused("memory_mb and cpus must be positive")
    return Expected(
        image_digest=digest,
        memory_bytes=memory_mb * 1024 * 1024,
        nano_cpus=int(round(cpus * 1_000_000_000)),
        pids_limit=PIDS_LIMIT,
        user=CONTAINER_USER,
        network_mode="none",
    )


def docker_argv(row: Any, *, env_file: str) -> list[str]:
    """`docker run …` for a row that ALREADY passed `validate_local_server`.

    Re-checks the few facts it relies on rather than trusting the caller
    remembered to validate: a wrong argv is a running container, and this is
    the last pure step before one exists.
    """
    slug = str(_require(row, "slug"))
    if not _SLUG.fullmatch(slug):
        raise LaunchRefused("slug is not a valid container name component")
    network = str(getattr(row, "network", "none") or "none")
    if network != "none":
        raise LaunchRefused(
            "only network=none can be launched; no egress allowlist is verified"
        )
    image = str(_require(row, "image"))
    if "@" in image:
        # A digest-qualified image is accepted only if it names the SAME digest.
        base, _, given = image.partition("@")
        if given != _require(row, "image_digest"):
            raise LaunchRefused("image names a different digest than image_digest")
        image = base
    if ":" in image.rsplit("/", 1)[-1]:
        # `name:tag@digest` is legal for Docker, but a tag next to a digest is
        # noise that invites drift; the row pins by digest alone.
        image = image.rsplit(":", 1)[0]
    exp = expected(row)
    if not env_file or " " in env_file:
        raise LaunchRefused("env_file must be a plain path")
    return [
        "docker",
        "run",
        "--rm",
        "-i",
        "--name",
        container_name(slug),
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        str(exp.pids_limit),
        "--memory",
        f"{int(exp.memory_bytes // (1024 * 1024))}m",
        "--cpus",
        f"{exp.nano_cpus / 1_000_000_000:g}",
        "--user",
        exp.user,
        "--tmpfs",
        TMPFS,
        "--env-file",
        env_file,
        f"{image}@{exp.image_digest}",
    ]
