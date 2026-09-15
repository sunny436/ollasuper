"""Local MCP runtime enforcement (audit H-12 / N-06): the argv the launcher
emits, the attestation the plane gates on, the bearer the bridge demands.

The container itself is not started here (Docker is not part of the test
environment); what is tested is everything that decides whether one may be
dialled — which is exactly the part that used to be policy on paper.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.mcp.local import attest
from app.mcp.local.launch import (
    CONTAINER_USER,
    LaunchRefused,
    docker_argv,
    expected,
)
from tests.fakes.mcp_gateway import LocalRow

DIGEST = "sha256:" + "a" * 64
ENV = "/etc/myos/mcp-local/gw-fixture.env"


# ---------------------------------------------------------------- the argv
def test_the_argv_is_the_hardened_golden_line():
    row = LocalRow(
        image="docker.io/example/fixture", image_digest=DIGEST, cpus=1, memory_mb=512
    )
    assert docker_argv(row, env_file=ENV) == [
        "docker",
        "run",
        "--rm",
        "-i",
        "--name",
        "myos-mcp-gw-fixture",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "256",
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--user",
        CONTAINER_USER,
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m",  # noqa: S108 -- the container's /tmp
        "--env-file",
        ENV,
        f"docker.io/example/fixture@{DIGEST}",
    ]


def test_the_argv_pins_by_digest_whatever_the_image_string_says():
    row = LocalRow(image=f"example/fixture:latest@{DIGEST}", image_digest=DIGEST)
    assert docker_argv(row, env_file=ENV)[-1] == f"example/fixture@{DIGEST}"
    with pytest.raises(LaunchRefused, match="different digest"):
        docker_argv(
            LocalRow(image="example/fixture@sha256:" + "b" * 64, image_digest=DIGEST),
            env_file=ENV,
        )
    with pytest.raises(LaunchRefused, match="pinned sha256"):
        docker_argv(
            LocalRow(image="example/fixture", image_digest="latest"), env_file=ENV
        )


@pytest.mark.parametrize(
    "field, value, match",
    [
        ("network", "allowlist", "only network=none"),
        ("slug", "Bad Slug", "container name"),
        ("cpus", 0, "positive"),
        ("memory_mb", -1, "positive"),
    ],
)
def test_no_row_field_can_widen_the_launch(field, value, match):
    with pytest.raises(LaunchRefused, match=match):
        docker_argv(LocalRow(**{field: value}), env_file=ENV)


def test_row_attributes_cannot_add_flags():
    """Property: whatever extra attributes a row carries — `privileged`,
    `cap_add`, `volumes`, `network_mode`, anything — the argv never changes."""
    base = docker_argv(LocalRow(), env_file=ENV)
    for extra in (
        "privileged",
        "cap_add",
        "volumes",
        "network_mode",
        "user",
        "devices",
        "x",
    ):
        assert docker_argv(LocalRow(**{extra: "host"}), env_file=ENV) == base
    assert "--privileged" not in base and "--cap-add" not in base


def test_the_policy_refuses_an_allowlist_row_outright():
    from app.mcp.local.policy import validate_local_server

    verdict = validate_local_server(
        LocalRow(network="allowlist", network_allow=["api.example"])
    )
    assert not verdict.ok
    assert any("cannot be launched" in r for r in verdict.reasons)


# -------------------------------------------------------- the attestation
def _inspect(**over: Any) -> dict[str, Any]:
    """A `docker inspect` document for a CORRECT launch of `LocalRow()`."""
    exp = expected(LocalRow())
    doc = {
        "Id": "c" * 64,
        "Image": exp.image_digest,
        "State": {"Running": True},
        "Config": {"User": exp.user},
        "HostConfig": {
            "CapDrop": ["ALL"],
            "CapAdd": None,
            "Privileged": False,
            "SecurityOpt": ["no-new-privileges"],
            "ReadonlyRootfs": True,
            "NetworkMode": "none",
            "PidsLimit": exp.pids_limit,
            "Memory": exp.memory_bytes,
            "NanoCpus": exp.nano_cpus,
            "Binds": None,
            "Devices": [],
            "PidMode": "",
            "IpcMode": "private",
        },
        "Mounts": [{"Type": "tmpfs", "Destination": "/tmp"}],  # noqa: S108
    }
    for key, value in over.items():
        section, _, name = key.partition(".")
        if name:
            doc[section][name] = value
        else:
            doc[section] = value
    return doc


def test_a_correct_container_attests_clean():
    assert attest.check(_inspect(), expected(LocalRow())) == []


@pytest.mark.parametrize(
    "over, failed",
    [
        ({"Image": "sha256:" + "b" * 64}, "image digest"),
        ({"HostConfig.CapDrop": []}, "CapDrop"),
        ({"HostConfig.CapAdd": ["NET_ADMIN"]}, "CapAdd"),
        ({"HostConfig.Privileged": True}, "Privileged"),
        ({"HostConfig.SecurityOpt": []}, "no-new-privileges"),
        ({"HostConfig.ReadonlyRootfs": False}, "ReadonlyRootfs"),
        ({"HostConfig.NetworkMode": "bridge"}, "NetworkMode"),
        ({"Config.User": ""}, "User"),
        ({"Config.User": "0:0"}, "User"),
        ({"HostConfig.PidsLimit": 0}, "PidsLimit"),
        ({"HostConfig.Memory": 0}, "Memory"),
        ({"HostConfig.NanoCpus": 4_000_000_000}, "NanoCpus"),
        ({"HostConfig.Binds": ["/:/host"]}, "Binds"),
        ({"Mounts": [{"Type": "bind", "Destination": "/data"}]}, "Mounts"),
        ({"HostConfig.Devices": [{"PathOnHost": "/dev/sda"}]}, "Devices"),
        ({"HostConfig.PidMode": "host"}, "PidMode/IpcMode"),
    ],
)
def test_every_single_deviation_is_caught(over, failed):
    """Each hardening property, removed one at a time, is named in the
    failure list — so a launcher regression cannot pass on the others."""
    assert failed in attest.check(_inspect(**over), expected(LocalRow()))


def test_the_plane_gate_needs_a_fresh_verified_matching_attestation(tmp_path):
    row = LocalRow()
    now = 1_800_000_000.0
    ok = attest.Attestation(
        slug=row.slug,
        verified=True,
        image_digest=DIGEST,
        container_id="c",
        started_at=now - 60,
    )
    assert attest.verified_for(row, tmp_path, now=now) is False  # nothing written
    attest.write(ok, tmp_path)
    assert attest.verified_for(row, tmp_path, now=now) is True
    # Another digest: the row was re-pinned since the container started.
    assert (
        attest.verified_for(
            LocalRow(image_digest="sha256:" + "b" * 64), tmp_path, now=now
        )
        is False
    )
    # Failed / unverified / stale / from the future.
    attest.write(attest.Attestation(**{**ok.__dict__, "verified": False}), tmp_path)
    assert attest.verified_for(row, tmp_path, now=now) is False
    attest.write(attest.Attestation(**{**ok.__dict__, "failed": ("User",)}), tmp_path)
    assert attest.verified_for(row, tmp_path, now=now) is False
    attest.write(
        attest.Attestation(**{**ok.__dict__, "started_at": now - attest.MAX_AGE_S - 1}),
        tmp_path,
    )
    assert attest.verified_for(row, tmp_path, now=now) is False
    attest.write(attest.Attestation(**{**ok.__dict__, "started_at": now + 5}), tmp_path)
    assert attest.verified_for(row, tmp_path, now=now) is False
    # Garbage on disk is "no attestation", not a crash.
    attest.attestation_path(row.slug, tmp_path).write_text(
        "{not json", encoding="utf-8"
    )
    assert attest.verified_for(row, tmp_path, now=now) is False


async def test_resolve_local_spec_refuses_without_an_attestation(tmp_path, monkeypatch):
    """The gate in the path the turn and the connect actually take."""
    from app.mcp.local import gateway
    from app.mcp.local.policy import LocalServerPolicyError
    from app.mcp.registry import local_store
    from tests.conftest import make_settings

    row = LocalRow()

    async def resolve(_engine, slug):
        return row if slug == row.slug else None

    monkeypatch.setattr(local_store, "resolve", resolve)
    settings = make_settings(
        "http://x",
        mcp_local_enabled=True,
        mcp_gateway_url="http://127.0.0.1:8811",
        mcp_local_attestation_dir=str(tmp_path),
    )
    with pytest.raises(LocalServerPolicyError, match="attestation"):
        await gateway.resolve_local_spec(
            object(),
            row.slug,
            connection_id="c",
            user_id="u",
            workspace_id="w",
            settings=settings,
        )
    attest.write(
        attest.Attestation(
            slug=row.slug,
            verified=True,
            image_digest=row.image_digest,
            container_id="c",
            started_at=1.0,
        ),
        tmp_path,
    )
    monkeypatch.setattr(attest.time, "time", lambda: 100.0)
    spec = await gateway.resolve_local_spec(
        object(),
        row.slug,
        connection_id="c",
        user_id="u",
        workspace_id="w",
        settings=settings,
    )
    assert spec is not None and spec.endpoint_trust == "gateway"
    assert spec.identity.trusted is False


# ----------------------------------------------------------- the bearer
async def test_the_bridge_refuses_without_the_bearer_and_serves_with_it():
    import httpx2
    from starlette.applications import Starlette
    from starlette.responses import PlainTextResponse
    from starlette.routing import Route

    from bridge.mcp_bridge import BearerGate

    async def hello(_request):
        return PlainTextResponse("ok")

    app = Starlette(routes=[Route("/mcp", hello, methods=["GET", "POST"])])
    app.add_middleware(BearerGate, token="s3cret-token")
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app), base_url="http://127.0.0.1:8811"
    ) as c:
        assert (await c.post("/mcp")).status_code == 401
        assert (
            await c.post("/mcp", headers={"Authorization": "Bearer wrong"})
        ).status_code == 401
        assert (
            await c.post("/mcp", headers={"Authorization": "Basic s3cret-token"})
        ).status_code == 401
        ok = await c.post("/mcp", headers={"Authorization": "Bearer s3cret-token"})
        assert ok.status_code == 200 and ok.text == "ok"


def test_the_plane_sends_the_bearer_only_to_gateway_endpoints():
    """N-06: the token was configured and never sent. Now the pool holds it
    and the actor adds it for gateway-trust specs only — a catalogue server
    must never see it."""
    from pathlib import Path

    src = Path("app/mcp/session.py").read_text(encoding="utf-8")
    assert "if self.spec.endpoint_trust == GATEWAY_TRUST:" in src
    assert 'headers["Authorization"] = (' in src
    from app.mcp.session import PoolLimits

    assert "gateway_auth_token" not in repr(PoolLimits(gateway_auth_token="x"))


def test_the_local_listing_reports_attestation_per_server():
    """`/v1/mcp/local` used to hard-code `flags_verified: false` for the
    gateway; it now reports the launcher's verdict per server."""
    from pathlib import Path

    src = Path("app/routers/mcp.py").read_text(encoding="utf-8")
    assert '"flags_verified": False' not in src
    assert '"attested": attested' in src


def test_no_module_in_the_mcp_package_spawns_anything_the_bridge_does():
    """The bridge lives OUTSIDE app/mcp; the package stays spawn-free. Code
    identifiers, not prose — a docstring may mention what it refuses."""
    import ast
    from pathlib import Path

    for path in Path("app/mcp").rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
        names |= {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
        names |= {
            alias.name
            for n in ast.walk(tree)
            if isinstance(n, ast.Import | ast.ImportFrom)
            for alias in n.names
        }
        assert not (
            {"subprocess", "StdioServerParameters", "stdio_client", "Popen"} & names
        ), path
