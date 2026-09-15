"""`ConvexCredentialStore` — the only store that runs in production, and the one
nothing was testing.

Every vault test uses `MemoryStore`, which is the right call: the RULES (AAD,
lazy rewrap, compare-and-set, decrypt-failure handling) should be provable with
no database. But it left the actual production implementation uncovered, and
that implementation is a **cross-plane wire contract written twice** — camelCase
keys in Python, read back by hand in `convex/http.ts` — with no shared schema and
no compiler spanning the two.

The failure mode that matters is therefore not a crash. Rename `expiresAt` on one
side and every write still returns 200; the field simply stops arriving, tokens
lose their expiry, and the first symptom is users being asked to authorize again
for no reason. So the tests below do two distinct things:

  1. **Behaviour** — round-trip a record through a fake ingress and assert the
     mapping, including the null cases and the millisecond conversion.
  2. **Contract** — read `convex/http.ts` and assert every key Python SENDS is a
     key Convex READS, and vice versa. That is the half a Python-only test can
     never cover, and it is where a rename actually goes wrong.
"""

from __future__ import annotations

import pathlib
import re
from datetime import UTC, datetime

import pytest

from app.mcp.vault.aad import AadKind
from app.mcp.vault.convex_store import ConvexCredentialStore
from app.mcp.vault.models import ClientRecord, CredentialRecord, CredentialStatus

pytestmark = pytest.mark.anyio

ENVELOPE = "v1.1.AAAAAAAAAAAAAAAA.Y2lwaGVydGV4dA"


class FakeConvex:
    """Records every ingress body, and answers as `convex/http.ts` does."""

    def __init__(self, replies: dict | None = None) -> None:
        self.sent: list[dict] = []
        self.replies = replies or {}

    async def ingress(self, body: dict) -> dict:
        self.sent.append(body)
        return self.replies.get(body["op"], {})

    def body_for(self, op: str) -> dict:
        found = [b for b in self.sent if b["op"] == op]
        assert len(found) == 1, f"expected one {op}, got {len(found)}"
        return found[0]


def _record(**overrides) -> CredentialRecord:
    base = dict(
        credential_id="cred_1",
        user_id="user-a",
        workspace_id="ws-1",
        connection_id="conn-1",
        server_name="acme.test/server",
        resource="https://acme.test/mcp",
        kind=AadKind.OAUTH_TOKEN,
        envelope=ENVELOPE,
        key_version=1,
        expires_at=datetime(2026, 9, 11, 12, 0, tzinfo=UTC),
        scope="mcp:read mcp:write",
        status=CredentialStatus.ACTIVE,
        rev=3,
    )
    base.update(overrides)
    return CredentialRecord(**base)


# ------------------------------------------------------------------ behaviour
async def test_a_save_sends_the_envelope_and_nothing_resembling_plaintext():
    convex = FakeConvex({"mcp-credential-save": {"stored": True}})
    store = ConvexCredentialStore(convex)

    assert await store.save(_record(), expected_rev=2) is True
    body = convex.body_for("mcp-credential-save")

    assert body["envelope"] == ENVELOPE
    assert body["expectedRev"] == 2
    assert body["rev"] == 3
    # The enums must cross as their VALUES. `str()` on a plain Enum would send
    # "AadKind.OAUTH_TOKEN", which the Convex validator rejects outright — the
    # StrEnum base is load-bearing, not stylistic.
    assert body["kind"] == "oauth_token"
    assert body["status"] == "active"
    # And nothing secret-shaped rides along beside the envelope.
    for key in ("access_token", "refresh_token", "client_secret", "token"):
        assert key not in body


async def test_expiry_crosses_as_epoch_milliseconds():
    # Convex stores `v.number()` milliseconds; Python holds an aware datetime.
    # A seconds/milliseconds mix-up would put every expiry in 1970 and make
    # every token read as expired forever.
    convex = FakeConvex({"mcp-credential-save": {"stored": True}})
    await ConvexCredentialStore(convex).save(_record(), expected_rev=0)
    sent = convex.body_for("mcp-credential-save")["expiresAt"]
    assert sent == int(datetime(2026, 9, 11, 12, 0, tzinfo=UTC).timestamp() * 1000)
    assert sent > 1_700_000_000_000, "looks like seconds, not milliseconds"


async def test_an_absent_expiry_and_scope_cross_as_null_not_as_a_string():
    convex = FakeConvex({"mcp-credential-save": {"stored": True}})
    await ConvexCredentialStore(convex).save(
        _record(expires_at=None, scope=None), expected_rev=0
    )
    body = convex.body_for("mcp-credential-save")
    assert body["expiresAt"] is None
    assert body["scope"] is None


async def test_a_lost_compare_and_set_reads_as_false_not_as_an_error():
    # The vault treats a CAS loss as information rather than a failure, so this
    # must not raise — see `store.py` for why a loser must not fail the caller.
    convex = FakeConvex({"mcp-credential-save": {"stored": False}})
    assert await ConvexCredentialStore(convex).save(_record(), expected_rev=9) is False


@pytest.mark.parametrize("reply", [{}, None, "not a dict", {"stored": None}])
async def test_a_malformed_save_reply_is_not_read_as_success(reply):
    # Claiming a token was stored when it was not leaves a connection reporting
    # CONNECTED while holding nothing.
    convex = FakeConvex({"mcp-credential-save": reply})
    assert await ConvexCredentialStore(convex).save(_record(), expected_rev=0) is False


async def test_a_load_round_trips_every_field_convex_returns():
    row = {
        "credentialId": "cred_1",
        "userId": "user-a",
        "workspaceId": "ws-1",
        "connectionId": "conn-1",
        "serverName": "acme.test/server",
        "resource": "https://acme.test/mcp",
        "kind": "oauth_token",
        "envelope": ENVELOPE,
        "keyVersion": 2,
        "expiresAt": 1_789_000_000_000,
        "scope": "mcp:read",
        "status": "active",
        "rev": 4,
        "createdAt": 1_788_000_000_000,
        "updatedAt": 1_788_500_000_000,
        "lastUsedAt": None,
        "revokedAt": None,
    }
    convex = FakeConvex({"mcp-credential-load": {"credential": row}})
    got = await ConvexCredentialStore(convex).load(
        connection_id="conn-1",
        resource="https://acme.test/mcp",
        kind="oauth_token",
        user_id="user-a",
        workspace_id="ws-1",
    )
    assert got is not None
    assert got.credential_id == "cred_1"
    assert got.envelope == ENVELOPE
    assert got.key_version == 2
    # `rev` MUST survive: it is what the next write compares against, and losing
    # it silently disarms the rotation guard.
    assert got.rev == 4
    assert got.kind is AadKind.OAUTH_TOKEN
    assert got.status is CredentialStatus.ACTIVE
    assert got.expires_at == datetime.fromtimestamp(1_789_000_000, tz=UTC)
    assert got.last_used_at is None


@pytest.mark.parametrize(
    "row",
    [
        {},
        {"envelope": ""},
        {"envelope": None},
        {"envelope": ENVELOPE, "kind": "not-a-kind"},
        {"envelope": ENVELOPE, "status": "not-a-status"},
    ],
    ids=["empty", "blank", "null", "bad-kind", "bad-status"],
)
async def test_a_malformed_row_reads_as_none_rather_than_raising(row):
    """A bad row must look like "no usable credential", not like a crash.

    The caller's correct response is identical either way — ask the user to
    authorize again — and raising here would WEDGE a connection that a fresh
    authorization would have fixed.
    """
    convex = FakeConvex({"mcp-credential-load": {"credential": row}})
    assert (
        await ConvexCredentialStore(convex).load(
            connection_id="c",
            resource="r",
            kind="oauth_token",
            user_id="u",
            workspace_id="w",
        )
        is None
    )


async def test_a_missing_credential_reads_as_none():
    convex = FakeConvex({"mcp-credential-load": {"credential": None}})
    assert (
        await ConvexCredentialStore(convex).load(
            connection_id="c",
            resource="r",
            kind="oauth_token",
            user_id="u",
            workspace_id="w",
        )
        is None
    )


async def test_every_op_names_the_tenant_and_there_is_no_delete():
    """H-17. A read or a mark states whose credential it wants — user,
    workspace AND connection — so Convex can hold the caller to it; the ingress
    secret alone addresses nothing. And there is no delete op: the control
    plane purges rows itself after a confirmed disconnect."""
    convex = FakeConvex({"mcp-credential-load": {"credential": None}})
    store = ConvexCredentialStore(convex)
    await store.load(
        connection_id="conn-1",
        resource="r",
        kind="oauth_token",
        user_id="user-a",
        workspace_id="ws-1",
    )
    await store.mark(
        credential_id="cred_1",
        status="revoked",
        user_id="user-a",
        workspace_id="ws-1",
        connection_id="conn-1",
    )
    assert convex.body_for("mcp-credential-load") == {
        "op": "mcp-credential-load",
        "connectionId": "conn-1",
        "resource": "r",
        "kind": "oauth_token",
        "userId": "user-a",
        "workspaceId": "ws-1",
    }
    assert convex.body_for("mcp-credential-mark") == {
        "op": "mcp-credential-mark",
        "credentialId": "cred_1",
        "status": "revoked",
        "userId": "user-a",
        "workspaceId": "ws-1",
        "connectionId": "conn-1",
    }
    assert not hasattr(store, "delete")


async def test_a_refused_save_raises_rather_than_reading_as_a_lost_race():
    """H-04. `{refused: true}` is Convex declining the write for this tenant or
    connection (disconnected, wrong owner). It must surface, not be logged away
    as a compare-and-set loss that the caller shrugs off."""
    from app.mcp.vault.models import CredentialRefused

    convex = FakeConvex(
        {
            "mcp-credential-save": {
                "stored": False,
                "refused": True,
                "reason": "disconnected",
            }
        }
    )
    with pytest.raises(CredentialRefused, match="disconnected"):
        await ConvexCredentialStore(convex).save(_record(), expected_rev=1)


async def test_the_client_record_crosses_without_a_tenant():
    """A DCR client is deployment-scoped. Sending a user id with it would invite
    a future reader to scope it per user — a registration storm against someone
    else's authorization server."""
    convex = FakeConvex()
    await ConvexCredentialStore(convex).save_client(
        ClientRecord(
            client_record_id="cli_1",
            server_name="acme.test/server",
            issuer="https://issuer.test",
            envelope=ENVELOPE,
            key_version=1,
            registration_mode="dcr",
        )
    )
    body = convex.body_for("mcp-oauth-client-save")
    for tenant_field in ("userId", "workspaceId", "connectionId"):
        assert tenant_field not in body
    assert body["registrationMode"] == "dcr"


async def test_a_client_row_without_an_envelope_reads_as_none():
    convex = FakeConvex({"mcp-oauth-client-load": {"client": {"clientRecordId": "x"}}})
    assert (
        await ConvexCredentialStore(convex).load_client(server_name="s", issuer="i")
        is None
    )


# ------------------------------------------------------- the cross-plane contract
def _http_ts() -> str:
    path = pathlib.Path("../../packages/backend/convex/http.ts")
    assert path.exists(), (
        f"{path} not found — this contract test would silently stop checking "
        "anything, which is worse than failing"
    )
    return path.read_text(encoding="utf-8")


def _convex_case(source: str, op: str) -> str:
    """The body of one `case "<op>": { ... }` block."""
    start = source.index(f'case "{op}": {{')
    depth, i = 0, start
    while True:
        if source[i] == "{":
            depth += 1
        elif source[i] == "}":
            depth -= 1
            if depth == 0:
                return source[start : i + 1]
        i += 1


_BODY_READ = re.compile(r"\bbody\.([A-Za-z_][A-Za-z0-9_]*)")


async def _keys_python_sends(op: str) -> set[str]:
    """Drive the real store and capture what it actually put on the wire."""
    convex = FakeConvex({"mcp-credential-save": {"stored": True}})
    store = ConvexCredentialStore(convex)
    record = _record()
    await store.save(record, expected_rev=1)
    await store.load(
        connection_id="c",
        resource="r",
        kind="oauth_token",
        user_id="u",
        workspace_id="w",
    )
    await store.mark(
        credential_id="cred_1",
        status="revoked",
        user_id="u",
        workspace_id="w",
        connection_id="c",
    )
    await store.load_client(server_name="s", issuer="i")
    await store.save_client(
        ClientRecord(
            client_record_id="cli_1",
            server_name="s",
            issuer="i",
            envelope=ENVELOPE,
            key_version=1,
        )
    )
    return set(convex.body_for(op)) - {"op"}


@pytest.mark.parametrize(
    "op",
    [
        "mcp-credential-load",
        "mcp-credential-save",
        "mcp-credential-mark",
        "mcp-oauth-client-load",
        "mcp-oauth-client-save",
    ],
)
async def test_every_key_python_sends_is_a_key_convex_reads(op):
    """THE contract, checked mechanically in both directions.

    A renamed key on either side is a 200 that quietly drops a field. Nothing
    else in either test suite would notice: Python's tests use `MemoryStore`, and
    Convex's tests hand-write the body they expect.
    """
    sent = await _keys_python_sends(op)
    read = set(_BODY_READ.findall(_convex_case(_http_ts(), op))) - {"op"}

    assert sent, f"{op} sent nothing; this assertion would be vacuous"
    assert not sent - read, f"{op}: Python sends keys Convex never reads: {sent - read}"
    assert not read - sent, f"{op}: Convex reads keys Python never sends: {read - sent}"
