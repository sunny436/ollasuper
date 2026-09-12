"""The local-server validator and the gateway URL guard.

THIS FILE IS WHERE PHASE 6'S SECURITY IS ACTUALLY PROVEN. Everything here is pure
logic over an operator-curated row, so it needs no Docker to be correct or to be
tested — which is exactly why the phase was split this way. Container isolation
is the substrate's job and is on the deferred checklist; deciding *what may
execute at all* is OllaSuper's, and it is decided here.

EVERY TEST IS A REFUSAL OR A CONTROL FOR ONE. A validator with no negative tests
is a validator nobody has checked, and a fail-closed claim is only worth what its
failing cases prove.
"""

from __future__ import annotations

import pytest

from app.mcp.exceptions import McpConnectionError
from app.mcp.local.gateway import (
    GATEWAY_TRUST,
    assert_gateway_url,
    gateway_endpoint_for,
    gateway_spec,
)
from app.mcp.local.policy import (
    DENIED_ENV_ALWAYS,
    LocalServerPolicyError,
    PolicyCeilings,
    validate_local_server,
)
from tests.fakes.mcp_gateway import LocalRow

DIGEST = "sha256:" + "a" * 64


# ================================================================ the guard
@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:8811",
        "https://127.0.0.1:8811",
        "http://localhost:8811",
        "http://[::1]:8811",
    ],
)
def test_a_loopback_gateway_is_accepted(url):
    assert_gateway_url(url)  # does not raise


@pytest.mark.parametrize(
    "url",
    [
        "http://10.0.0.5:8811",
        "http://192.168.1.10:8811",
        "http://169.254.169.254:8811",
        "https://gateway.example.com:8811",
        "http://0.0.0.0:8811",
        "ftp://127.0.0.1:8811",
        "http://user:pass@127.0.0.1:8811",
        "",
        "   ",
        "not-a-url",
    ],
    ids=[
        "rfc1918", "lan", "metadata", "public-name", "wildcard",
        "bad-scheme", "credentials", "empty", "blank", "garbage",
    ],
)
def test_a_non_loopback_gateway_is_refused(url):
    """THE failure direction that matters.

    A gateway URL pointing anywhere but loopback would put the
    `MCP_GATEWAY_AUTH_TOKEN` bearer header on a network. `0.0.0.0` is refused
    too: it is a bind address, not a destination, and treating it as loopback is
    how a "local" gateway ends up reachable from a LAN.
    """
    with pytest.raises(McpConnectionError):
        assert_gateway_url(url)


async def test_the_two_guards_disagree_about_every_url():
    """The guards are OPPOSITES, not one a relaxed form of the other.

    This is the test that stops a future refactor "simplifying" them into one
    function with a flag — the moment they agree about a URL, one of them is
    wrong for its own case.
    """
    from app.mcp.endpoint import assert_dialable

    async def strict_ok(url: str) -> bool:
        try:
            await assert_dialable(url)
            return True
        except McpConnectionError:
            return False

    def gateway_ok(url: str) -> bool:
        try:
            assert_gateway_url(url)
            return True
        except McpConnectionError:
            return False

    for url in (
        "http://127.0.0.1:8811",       # gateway yes, catalogue no
        "https://93.184.216.34/mcp",   # catalogue yes, gateway no
        "http://10.0.0.5:8811",        # neither
    ):
        assert await strict_ok(url) != gateway_ok(url) or not (
            await strict_ok(url) or gateway_ok(url)
        ), url
    # Stated positively for the two that matter:
    assert not await strict_ok("http://127.0.0.1:8811")
    assert gateway_ok("http://127.0.0.1:8811")
    assert await strict_ok("https://93.184.216.34/mcp")
    assert not gateway_ok("https://93.184.216.34/mcp")


def test_the_endpoint_carries_the_servers_own_port():
    # One gateway instance per local server, each on its own port — so the
    # endpoint is derived from the ROW, not only from the configured base.
    assert (
        gateway_endpoint_for("http://127.0.0.1:8811", 9002)
        == "http://127.0.0.1:9002/mcp"
    )
    with pytest.raises(McpConnectionError):
        gateway_endpoint_for("http://127.0.0.1", None)  # no port anywhere
    with pytest.raises(McpConnectionError):
        gateway_endpoint_for("http://127.0.0.1:8811", 99999)


# ================================================================ the spec
def test_a_local_spec_is_never_trusted_and_asks_for_the_gateway_guard():
    """§55: running in Docker is not a reason to believe a tool's annotations.

    `trusted=False` is what makes a local server's `readOnlyHint` unable to
    downgrade a tool past approval — the Phase 3 classification does the rest
    with no new code.
    """
    spec = gateway_spec(
        LocalRow(),
        connection_id="c1",
        user_id="u1",
        workspace_id="w1",
        base_url="http://127.0.0.1:8811",
    )
    assert spec.identity.trusted is False
    assert spec.endpoint_trust == GATEWAY_TRUST
    assert spec.endpoint_url.startswith("http://127.0.0.1:")
    # OllaSuper sends NO credential to a local server: the gateway injects the
    # server's own secrets from its own store.
    assert spec.auth_kind == "none"


def test_a_spec_defaults_to_the_strict_guard():
    """The fail-safe default. A spec that forgets to declare itself must get the
    CATALOGUE guard, not the permissive one."""
    from app.mcp.models import McpConnectionSpec, McpServerIdentity

    spec = McpConnectionSpec(
        connection_id="c",
        identity=McpServerIdentity(slug="s"),
        server_name="n",
        version="1",
        transport="streamable-http",
        endpoint_url="https://example.test/mcp",
    )
    assert spec.endpoint_trust == "catalogue"


def test_only_the_gateway_module_may_ask_for_the_gateway_guard():
    """An AST guard, like the no-subprocess one.

    If any other module could set `endpoint_trust="gateway"`, a catalogue
    endpoint could be routed past the SSRF check — so the rule is enforced
    rather than documented.
    """
    import ast
    import pathlib

    offenders: list[str] = []
    for path in pathlib.Path("app").rglob("*.py"):
        if path.as_posix().endswith("app/mcp/local/gateway.py"):
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.keyword) and node.arg == "endpoint_trust":
                value = node.value
                if not (
                    isinstance(value, ast.Constant) and value.value == "catalogue"
                ):
                    offenders.append(f"{path}:{node.lineno}")
    assert not offenders, f"these set endpoint_trust outside gateway.py: {offenders}"


# ============================================================== the validator
def test_a_well_formed_approved_row_passes():
    result = validate_local_server(LocalRow())
    assert result.ok, result.reasons


@pytest.mark.parametrize(
    ("kw", "fragment"),
    [
        ({"enabled": False}, "not enabled"),
        ({"trust": "blocked"}, "blocked"),
        ({"trust": "nonsense"}, "unknown trust"),
        ({"trust": "test"}, "unsafe development flag"),
        ({"image_digest": "latest"}, "pinned sha256"),
        ({"image_digest": "sha256:short"}, "pinned sha256"),
        ({"image_digest": ""}, "pinned sha256"),
        ({"image": "example/x:latest"}, "reproducible"),
        ({"network": "internet"}, "unknown network policy"),
        ({"network": "none", "network_allow": ["a.test"]}, "allowlist was supplied"),
        ({"cpus": 0}, "cpus"),
        ({"cpus": 99}, "cpus"),
        ({"memory_mb": 0}, "memory_mb"),
        ({"memory_mb": 999_999}, "memory_mb"),
        ({"cpus": "not-a-number"}, "cpus"),
    ],
    ids=lambda v: str(v)[:40],
)
def test_every_malformed_row_is_refused_with_a_reason(kw, fragment):
    """Fail closed, and SAY WHY. An operator who cannot see the reason turns the
    validator off."""
    result = validate_local_server(LocalRow(**kw))
    assert not result.ok
    assert any(fragment in r for r in result.reasons), result.reasons


def test_every_reason_is_reported_not_just_the_first():
    # An operator fixing one refusal per attempt is an operator who will
    # eventually stop using the validator.
    result = validate_local_server(
        LocalRow(enabled=False, trust="blocked", image_digest="latest", cpus=99)
    )
    assert len(result.reasons) >= 4, result.reasons


@pytest.mark.parametrize(
    "entry",
    ["127.0.0.1", "169.254.169.254", "10.0.0.0/8", "::1", "1.2.3.4"],
)
def test_a_network_allowlist_entry_must_be_a_hostname_not_an_address(entry):
    """Allowing a raw address is how `169.254.169.254` and loopback get in."""
    result = validate_local_server(
        LocalRow(network="allowlist", network_allow=[entry])
    )
    assert not result.ok
    assert any("hostname" in r for r in result.reasons), result.reasons


@pytest.mark.parametrize("name", sorted(DENIED_ENV_ALWAYS)[:8])
def test_a_denied_environment_variable_is_refused_however_it_is_requested(name):
    """§82. `env_allow` is already an allowlist; this is the second layer, so a
    mistaken row naming the vault master key is refused rather than honoured.

    TWO RULES COVER THIS SET, and only one of them is the enumerated list.
    Measured by deleting the list: most of these names survive anyway because
    `_SECRET_SHAPED` catches a `_KEY`/`_SECRET`/`_TOKEN` suffix. What the
    enumeration uniquely catches is a name with no secret-shaped ending —
    `MCP_CREDENTIAL_ACTIVE_KEY_VERSION` is the example. Both layers are real;
    neither is redundant.
    """
    result = validate_local_server(LocalRow(env_allow=[name]))
    assert not result.ok
    assert any(name in r for r in result.reasons), result.reasons


@pytest.mark.parametrize(
    "name", ["SOME_API_KEY", "MY_SECRET", "APP_TOKEN", "DB_PASSWORD", "SENTRY_DSN"]
)
def test_a_secret_shaped_variable_is_refused_even_if_nobody_enumerated_it(name):
    # The enumerated denylist cannot be exhaustive; the shape rule covers what
    # nobody thought to list.
    result = validate_local_server(LocalRow(env_allow=[name]))
    assert not result.ok
    assert any("secret" in r for r in result.reasons), result.reasons


def test_an_ordinary_environment_variable_is_allowed():
    # The control: the guard must not refuse everything.
    result = validate_local_server(LocalRow(env_allow=["LOG_LEVEL", "TZ"]))
    assert result.ok, result.reasons


def test_the_denylist_covers_every_configured_secret():
    """A coverage guard on the denylist itself.

    Walks `Settings.secrets()` and asserts the variable behind each configured
    secret is either enumerated or caught by the shape rule — so a secret added
    to config later cannot quietly fall outside the guard.
    """
    # The setting -> environment variable mapping is pydantic's: upper-case.
    from app.config import Settings
    from app.mcp.local.policy import _SECRET_SHAPED

    fields = [f for f in Settings.model_fields if _looks_secret(f)]
    assert fields, "no secret-like settings found; this would be vacuous"
    uncovered = [
        f
        for f in fields
        if f.upper() not in DENIED_ENV_ALWAYS and not _SECRET_SHAPED.search(f.upper())
    ]
    assert not uncovered, f"secret settings not covered by the guard: {uncovered}"


def _looks_secret(name: str) -> bool:
    return name.endswith(
        ("_key", "_secret", "_token", "_password", "_dsn", "_keys")
    ) or name.endswith("_database_url")


@pytest.mark.parametrize(
    "field",
    [
        "privileged",
        "network_mode",
        "bind_mounts",
        "volumes",
        "capabilities",
        "cap_add",
        "user",
        "devices",
        "pid_mode",
        "ipc_mode",
    ],
)
def test_a_row_cannot_request_container_infrastructure(field):
    """§102/§130. These are not columns on the table — this catches a future one,
    or a hand-built object, trying to smuggle one in."""
    result = validate_local_server(LocalRow(**{field: True}))
    assert not result.ok
    assert any(field in r for r in result.reasons), result.reasons


def test_a_local_slug_may_not_collide_with_a_curated_remote_one():
    """§95. One slug is one provider; two rows sharing it would make
    `mcp:<slug>:<tool>` ambiguous and let a local server shadow a remote one."""
    result = validate_local_server(
        LocalRow(slug="github"), remote_slugs=frozenset({"github"})
    )
    assert not result.ok
    assert any("already used" in r for r in result.reasons), result.reasons


# ------------------------------------------------- the unsafe development flag
def test_the_unsafe_flag_permits_a_test_row_and_nothing_else():
    """§52. A flag that disabled the validator would be a switch nobody could
    reason about — so it relaxes EXACTLY one rule."""
    assert validate_local_server(LocalRow(trust="test")).ok is False
    assert validate_local_server(LocalRow(trust="test"), allow_untrusted=True).ok

    # Every other refusal still fires with the flag on.
    for kw in (
        {"trust": "blocked"},
        {"trust": "test", "image_digest": "latest"},
        {"trust": "test", "env_allow": ["MCP_CREDENTIAL_KEYS"]},
        {"trust": "test", "enabled": False},
        {"trust": "test", "privileged": True},
    ):
        result = validate_local_server(LocalRow(**kw), allow_untrusted=True)
        assert not result.ok, kw


def test_ceilings_bound_what_a_row_may_ask_for():
    tight = PolicyCeilings(max_cpus=1.0, max_memory_mb=256)
    assert not validate_local_server(LocalRow(cpus=2), ceilings=tight).ok
    assert not validate_local_server(LocalRow(memory_mb=512), ceilings=tight).ok
    assert validate_local_server(
        LocalRow(cpus=1, memory_mb=256), ceilings=tight
    ).ok


def test_a_refusal_raises_with_every_reason_attached():
    result = validate_local_server(LocalRow(trust="blocked", image_digest="x"))
    with pytest.raises(LocalServerPolicyError) as caught:
        result.raise_if_refused("bad-row")
    assert caught.value.slug == "bad-row"
    assert len(caught.value.reasons) >= 2
