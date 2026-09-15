"""Whether a local MCP server may start at all. PURE: no I/O, no Docker, no clock.

THIS IS WHERE PHASE 6's SECURITY ACTUALLY LIVES, and it is deliberately the part
that needs no Docker to be correct or to be tested. Container isolation is the
execution substrate's job; deciding *what is allowed to execute* is OllaSuper's,
and that decision is pure logic over an operator-curated row.

EVERY CHECK FAILS CLOSED (§101). There is no "warn and continue" branch, no
default that permits, and no partial start. A row that does not satisfy every
rule below produces a refusal with a reason, and nothing is launched.

WHAT CANNOT BE ASKED FOR AT ALL. The most important controls are not checks here
— they are columns that do not exist on `mcp_local_servers`: `privileged`,
`network_mode`, `bind_mounts`, `capabilities`, `user`. A row cannot request host
networking or a Docker socket mount because there is nowhere to write it, which
is stronger than validating it away (§102/§130). The checks below cover what CAN
be expressed.

AND THE HONEST LIMIT, stated where it will be read: passing this validator means
OllaSuper approved the configuration. It does NOT mean the gateway applied it.
OllaSuper reaches the gateway as an MCP client, and no MCP method reports which
flags the gateway was launched with — so the invocation is shipped and
documented, never verified from here.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from app.logging import get_logger

log = get_logger(__name__)

__all__ = [
    "DENIED_ENV_ALWAYS",
    "LocalServerPolicyError",
    "LocalTrust",
    "PolicyCeilings",
    "validate_local_server",
]


class LocalTrust:
    """Only the states the implementation actually distinguishes (§7).

    `APPROVED` and `BLOCKED` are operator decisions. `TEST` exists because the
    fixtures need to be startable in tests without being startable in a
    deployment — it is refused unless the unsafe development flag is on.

    There is deliberately no `UNTRUSTED` state: a server that is not APPROVED is
    simply not startable, which is the same thing said without implying that some
    lesser execution is available.
    """

    TEST = "test"
    APPROVED = "approved"
    BLOCKED = "blocked"

    ALL = frozenset({TEST, APPROVED, BLOCKED})


#: Environment variables that may NEVER be forwarded into a local MCP container,
#: whatever a row's `env_allow` says.
#:
#: A DENYLIST ON TOP OF AN ALLOWLIST, and both are load-bearing. `env_allow` is
#: the allowlist — nothing reaches a container unless a row names it. This is the
#: second layer, so that a mistaken row naming `AI_SERVICE_KEY` is refused rather
#: than honoured. A test walks `Settings.secrets()` and asserts every configured
#: secret's variable is covered, so a secret added later cannot quietly fall
#: outside the guard.
DENIED_ENV_ALWAYS = frozenset(
    {
        # The Phase 4 vault master key. Its presence in a container would make
        # every stored credential readable (§118/§120).
        "MCP_CREDENTIAL_KEYS",
        "MCP_CREDENTIAL_ACTIVE_KEY_VERSION",
        # The two service secrets that authorize the plane boundaries.
        "AI_INGRESS_SECRET",
        "AI_SERVICE_KEY",
        "BACKEND_WEBHOOK_SECRET",
        # Model and provider keys.
        "OPENROUTER_API_KEY",
        "OLLIMA_API_KEY",
        "OLLAGRAPH_API_KEY",
        "RESEND_API_KEY",
        # Datastores and the control plane.
        "POSTGRES_URL",
        "DATABASE_URL",
        "CONVEX_DEPLOY_KEY",
        "CONVEX_SELF_HOSTED_ADMIN_KEY",
        "MCP_GATEWAY_AUTH_TOKEN",
        "SCHEDULED_EMAIL_WEBHOOK_SECRET",
        "AI_SENTRY_DSN",
    }
)

#: Anything that merely LOOKS like a secret is refused too, so a variable nobody
#: thought to enumerate cannot slip through a row.
_SECRET_SHAPED = re.compile(
    r"(?:^|_)(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|DSN|URL)$", re.IGNORECASE
)

#: An env var name at all. A row supplying something else is a malformed row.
_ENV_NAME = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")

#: `sha256:` plus 64 hex. A tag is not acceptable: an image that changes under a
#: tag must not be silently trusted (§11/§12).
_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")

#: A network allowlist entry is a HOSTNAME. An IP or CIDR is refused: allowing a
#: raw address is how `169.254.169.254` and `127.0.0.1` get in, and a hostname
#: at least has to resolve to something the gateway will then police.
#:
#: THE REGEX ALONE IS NOT ENOUGH, and the test found that: a dotted quad matches
#: it, because digits are legal in a label. `169.254.169.254` sailed through the
#: "hostnames only" rule until `_is_address` was added in front of it.
_HOSTNAME = re.compile(
    r"^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$"
)


def _is_address(text: str) -> bool:
    """Does this parse as an IP address or CIDR? Checked BEFORE the hostname
    shape, because a dotted quad is a valid hostname shape."""
    import ipaddress

    candidate = text.split("/", 1)[0]
    try:
        ipaddress.ip_address(candidate)
    except ValueError:
        return "/" in text and _is_network(text)
    return True


def _is_network(text: str) -> bool:
    import ipaddress

    try:
        ipaddress.ip_network(text, strict=False)
    except ValueError:
        return False
    return True


@dataclass(frozen=True)
class PolicyCeilings:
    """Operator-set upper bounds. A row may ask for less, never for more."""

    max_cpus: float = 2.0
    max_memory_mb: int = 2048
    max_network_allow: int = 16
    max_secret_refs: int = 8
    max_env_allow: int = 16


@dataclass
class PolicyResult:
    ok: bool
    reasons: list[str] = field(default_factory=list)

    def raise_if_refused(self, slug: str) -> None:
        if not self.ok:
            raise LocalServerPolicyError(slug, self.reasons)


class LocalServerPolicyError(RuntimeError):
    """A local server was refused. Carries EVERY reason, not just the first.

    All of them, because an operator fixing a row one refusal per attempt is an
    operator who will eventually turn the validator off.
    """

    def __init__(self, slug: str, reasons: list[str]) -> None:
        self.slug = slug
        self.reasons = list(reasons)
        super().__init__(f"local server {slug!r} refused: {'; '.join(reasons)}")


def validate_local_server(
    row: Any,
    *,
    ceilings: PolicyCeilings | None = None,
    allow_untrusted: bool = False,
    remote_slugs: frozenset[str] = frozenset(),
) -> PolicyResult:
    """May this row be launched? Returns every reason it may not.

    `allow_untrusted` is the unsafe development flag (§52). It permits a `test`
    row and nothing else — it does NOT permit a blocked row, an unpinned image,
    a denied environment variable, or any other refusal below. An unsafe flag
    that disabled the whole validator would be a switch nobody could reason
    about.
    """
    limits = ceilings or PolicyCeilings()
    reasons: list[str] = []

    slug = str(getattr(row, "slug", "") or "")
    if not slug:
        return PolicyResult(False, ["the row has no slug"])

    # --- identity -----------------------------------------------------------
    if slug in remote_slugs:
        # One slug is one provider in `ToolRegistry`. Two rows sharing it would
        # make `mcp:<slug>:<tool>` ambiguous and let a local server shadow a
        # remote one's tools (§95).
        reasons.append(f"slug {slug!r} is already used by a curated remote server")

    # --- trust --------------------------------------------------------------
    trust = str(getattr(row, "trust", "") or "")
    if trust not in LocalTrust.ALL:
        reasons.append(f"unknown trust level {trust!r}")
    elif trust == LocalTrust.BLOCKED:
        reasons.append("the server is blocked")
    elif trust == LocalTrust.TEST and not allow_untrusted:
        reasons.append(
            "trust is 'test', which is startable only when the unsafe "
            "development flag is enabled"
        )

    if not bool(getattr(row, "enabled", False)):
        reasons.append("the server is not enabled")

    # --- image (§10/§11/§12) -------------------------------------------------
    image = str(getattr(row, "image", "") or "")
    digest = str(getattr(row, "image_digest", "") or "")
    if not image:
        reasons.append("no image")
    if not _DIGEST.fullmatch(digest):
        # A tag is mutable. "The image exists" is not "the image is trusted".
        reasons.append(
            "image_digest must be a pinned sha256 digest, not a tag "
            f"(got {digest[:24]!r})"
        )
    if image.endswith(":latest"):
        reasons.append("':latest' is not a reproducible image reference")

    # --- network (§20/§21) ---------------------------------------------------
    network = str(getattr(row, "network", "none") or "none")
    if network not in ("none", "allowlist"):
        # There is deliberately no 'internet' mode to select.
        reasons.append(f"unknown network policy {network!r}")
    elif network == "allowlist":
        # Representable, NOT launchable (audit H-12): no egress filter has been
        # verified on this host, so the only policy the launcher emits — and
        # the attestation checks — is `--network none`.
        reasons.append(
            "network 'allowlist' cannot be launched: no egress filter is verified; "
            "use 'none'"
        )
    allow = list(getattr(row, "network_allow", None) or [])
    if network == "none" and allow:
        reasons.append("network is 'none' but an allowlist was supplied")
    if len(allow) > limits.max_network_allow:
        reasons.append(
            f"{len(allow)} network allow entries exceeds the ceiling of "
            f"{limits.max_network_allow}"
        )
    for entry in allow:
        text = str(entry or "")
        if _is_address(text) or not _HOSTNAME.fullmatch(text):
            reasons.append(
                f"network allow entry {text[:40]!r} is not a hostname "
                "(addresses and CIDRs are refused)"
            )

    # --- secrets (§28/§29) ---------------------------------------------------
    refs = list(getattr(row, "secret_refs", None) or [])
    if len(refs) > limits.max_secret_refs:
        reasons.append(
            f"{len(refs)} secret refs exceeds the ceiling of {limits.max_secret_refs}"
        )
    for ref in refs:
        text = str(ref or "")
        if not text or " " in text:
            reasons.append(f"malformed secret ref {text[:40]!r}")
        # A REFERENCE, never a value. Anything long and high-entropy here is an
        # operator having pasted the secret itself into the row.
        if len(text) > 64:
            reasons.append(
                "a secret ref is a name, not a value — this one is "
                f"{len(text)} characters"
            )

    # --- environment (§82/§83) ----------------------------------------------
    env = list(getattr(row, "env_allow", None) or [])
    if len(env) > limits.max_env_allow:
        reasons.append(
            f"{len(env)} env entries exceeds the ceiling of {limits.max_env_allow}"
        )
    for name in env:
        text = str(name or "")
        if not _ENV_NAME.fullmatch(text):
            reasons.append(f"malformed environment variable name {text[:40]!r}")
            continue
        if text in DENIED_ENV_ALWAYS:
            reasons.append(f"{text} may never be forwarded to a local MCP server")
        elif _SECRET_SHAPED.search(text):
            reasons.append(
                f"{text} looks like a secret; use a scoped secret ref instead of "
                "an environment variable"
            )

    # --- resources (§34-§38) -------------------------------------------------
    cpus = _number(getattr(row, "cpus", None), 1.0)
    if cpus <= 0 or cpus > limits.max_cpus:
        reasons.append(f"cpus {cpus} outside (0, {limits.max_cpus}]")
    memory = int(_number(getattr(row, "memory_mb", None), 512))
    if memory <= 0 or memory > limits.max_memory_mb:
        reasons.append(f"memory_mb {memory} outside (0, {limits.max_memory_mb}]")

    # --- infrastructure a row must not be able to request (§102/§130) --------
    # These attributes do not exist on the table. The check is here so that a
    # future column, or a hand-built object in a test, cannot smuggle one in.
    for forbidden in (
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
    ):
        if getattr(row, forbidden, None):
            reasons.append(
                f"a local server may not request {forbidden!r}; it is not a "
                "configurable property"
            )

    if reasons:
        # Identifiers and reasons only — never the row's secret refs or env.
        log.warning(
            "mcp.local_server_refused",
            extra={"slug": slug, "reason_count": len(reasons)},
        )
    return PolicyResult(not reasons, reasons)


def _number(value: Any, default: float) -> float:
    try:
        return float(value) if value is not None else default
    except (TypeError, ValueError):
        # Unparseable reads as out-of-range rather than as the default, so a
        # malformed row is refused instead of silently getting the default.
        return -1.0
