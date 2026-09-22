"""The streaming writer, against a real loopback Convex stand-in."""

from __future__ import annotations

import asyncio

import pytest

from app.clients.convex import ConvexRejected
from app.runtime.writer import DeltaWriter

SAMPLE = (
    "The quick brown fox jumps over the lazy dog. " * 180
)  # ~8,000 chars, a realistic long answer


def tokenize(text: str, avg: int = 4) -> list[str]:
    return [text[i : i + avg] for i in range(0, len(text), avg)]


async def test_batches_orders_and_pools_connections(convex_client, fake_convex):
    convex, settings = convex_client
    writer = DeltaWriter(convex, "s1", settings)

    for tok in tokenize(SAMPLE):
        await writer.push(tok)
    await writer.flush(force=True)
    await writer.finalize("done", usage={"promptTokens": 10, "completionTokens": 99})

    deltas = sorted(fake_convex.deltas["s1"], key=lambda d: d.seq)

    # 1. contiguous seqs, no gaps, no duplicates
    assert [d.seq for d in deltas] == list(range(len(deltas)))

    # 2. lossless
    assert "".join(d.text for d in deltas) == SAMPLE

    # 3. actually batching — not one POST per token
    assert len(deltas) < 60, f"{len(deltas)} flushes for {len(tokenize(SAMPLE))} tokens"

    # 4. exactly one finalize, carrying the whole text
    assert fake_convex.finalize_count["s1"] == 1
    assert fake_convex.finalized["s1"].text == SAMPLE
    assert fake_convex.finalized["s1"].usage == {
        "promptTokens": 10,
        "completionTokens": 99,
    }

    # 5. connection pooling. A per-flush AsyncClient shows ~150 here. This is
    #    the assertion that catches the worst possible implementation mistake.
    assert 1 <= fake_convex.connections_opened <= 2


async def test_realistic_output_rate_produces_meaningful_batches(
    convex_client, fake_convex
):
    """Regression guard for the flush-policy bug.

    A real model streams ~280 chars/s. With the original 100ms interval floor
    the timer beat the 96-char target every time and emitted ~32-char batches —
    236 flushes on an 8k answer, which is ~944KB downstream per viewer and
    makes the batching pointless. Batches must stay meaningful at that rate.
    """
    convex, settings = convex_client
    writer = DeltaWriter(convex, "rate", settings)

    text = "lorem ipsum dolor sit amet " * 60  # ~1,620 chars
    chunks = [text[i : i + 8] for i in range(0, len(text), 8)]
    for c in chunks:
        await writer.push(c)
        await asyncio.sleep(0.025)  # 8 chars / 25ms = 320 chars/s
    await writer.flush(force=True)

    deltas = sorted(fake_convex.deltas["rate"], key=lambda d: d.seq)
    assert "".join(d.text for d in deltas) == text

    # First flush is immediate for TTFT, so judge the steady state.
    steady = deltas[1:]
    mean = sum(len(d.text) for d in steady) / max(1, len(steady))
    assert mean >= 64, f"mean batch {mean:.0f} chars — timer is beating the size target"

    # And TTFT is still fast: the first chunk does not wait for either trigger.
    assert deltas[0].t_ms < 200


async def test_slow_producer_uses_the_interval_branch(convex_client, fake_convex):
    """The char-target and interval branches need independent coverage, or one
    silently rots."""
    convex, settings = convex_client
    writer = DeltaWriter(convex, "slow", settings)

    # ~15 tok/s: far below the 96-char target, so only the timer can fire.
    for _ in range(12):
        await writer.push("word ")
        await asyncio.sleep(0.065)
    await writer.flush(force=True)

    deltas = fake_convex.deltas["slow"]
    assert len(deltas) >= 3, "interval branch never fired"
    assert all(len(d.text) < 96 for d in deltas[1:]), (
        "these should be small, timed flushes"
    )
    assert "".join(d.text for d in sorted(deltas, key=lambda d: d.seq)) == "word " * 12


async def test_batch_size_grows_with_output_length(convex_client, fake_convex):
    """Without the growth term a 40k answer is ~417 flushes and megabytes of
    downstream traffic."""
    convex, settings = convex_client
    writer = DeltaWriter(convex, "long", settings)

    big = "x" * 40_000
    for tok in tokenize(big, avg=8):
        await writer.push(tok)
    await writer.flush(force=True)

    deltas = sorted(fake_convex.deltas["long"], key=lambda d: d.seq)
    assert "".join(d.text for d in deltas) == big
    assert len(deltas) < 150, f"{len(deltas)} flushes — growth term not applied"
    # Later batches must be materially larger than the 96-char floor.
    assert len(deltas[-1].text) > 96


async def test_cancel_flag_rides_the_delta_response(convex_client, fake_convex):
    convex, settings = convex_client
    fake_convex.cancel_streams.add("c1")
    writer = DeltaWriter(convex, "c1", settings)

    await writer.push("hello")
    await writer.flush(force=True)

    # This is the worker-agnostic cancel path: the authority is a Convex field,
    # not this process's memory.
    assert writer.cancel_requested is True


async def test_transient_failures_retry_without_losing_or_duplicating(
    convex_client, fake_convex
):
    convex, settings = convex_client
    writer = DeltaWriter(convex, "r1", settings)

    fake_convex.fail_next = 2  # first two attempts 500, then succeed
    await writer.push("alpha")
    await writer.flush(force=True)
    await writer.push("beta")
    await writer.flush(force=True)

    deltas = sorted(fake_convex.deltas["r1"], key=lambda d: d.seq)
    assert "".join(d.text for d in deltas) == "alphabeta"
    assert [d.seq for d in deltas] == list(range(len(deltas)))


async def test_client_errors_are_not_retried(convex_client, fake_convex):
    """A 401 means the secret is wrong; retrying just burns the deadline."""
    convex, settings = convex_client
    writer = DeltaWriter(convex, "e1", settings)

    fake_convex.fail_next = 1
    fake_convex.fail_status = 401
    before = fake_convex.attempts

    # push() itself flushes the first chunk immediately (for TTFT), so the
    # rejection surfaces there rather than on the explicit flush.
    with pytest.raises(ConvexRejected):
        await writer.push("hello")
        await writer.flush(force=True)

    assert fake_convex.attempts - before == 1, "a 4xx must not be retried"


async def test_unknown_stream_is_not_an_error_but_stops_generation(
    convex_client, fake_convex
):
    convex, settings = convex_client
    fake_convex.unknown_streams.add("gone")
    writer = DeltaWriter(convex, "gone", settings)

    await writer.push("orphan")
    await writer.flush(force=True)

    assert writer.cancel_requested is True
    assert "gone" not in fake_convex.deltas


async def test_finalize_is_attempted_even_when_deltas_failed(
    convex_client, fake_convex
):
    """A lost delta is cosmetic; a lost finalize hangs the message in the UI, so
    finalize gets a much larger retry budget."""
    convex, settings = convex_client
    writer = DeltaWriter(convex, "f1", settings)

    await writer.push("partial answer")
    await writer.flush(force=True)
    fake_convex.fail_next = 3  # finalize fails three times, then lands
    await writer.finalize("done")

    assert fake_convex.finalize_count["f1"] == 1
    assert fake_convex.finalized["f1"].text == "partial answer"


async def test_hot_ops_take_the_mutation_path_and_fall_back_when_absent(
    convex_client, fake_convex
):
    """delta / heartbeat / finalize go to chat/ingress:apply over /api/mutation
    (the ~10 ms path); the HTTP action is used only when the deployment lacks
    the mutation, and a wrong key is refused loudly, not retried."""
    from app.clients.convex import ConvexRejected

    convex, settings = convex_client
    writer = DeltaWriter(convex, "hot", settings)
    for tok in tokenize(SAMPLE[:400]):
        await writer.push(tok)
    await writer.flush(force=True)
    await writer.heartbeat()
    await writer.finalize("done", usage={"promptTokens": 1, "completionTokens": 2})
    assert fake_convex.mutation_calls >= 3  # every hot op used /api/mutation
    assert fake_convex.total_text("hot") == SAMPLE[:400]
    assert fake_convex.finalize_count["hot"] == 1

    # A non-hot op never touches the mutation path.
    before = fake_convex.mutation_calls
    await convex.ingress({"op": "title", "streamId": "hot", "title": "T"})
    assert fake_convex.mutation_calls == before
    assert fake_convex.titles["hot"] == "T"

    # Wrong key: rejected immediately (ConvexRejected), no silent fallback.
    fake_convex.expected_key = "something-else"
    try:
        await convex.ingress({"op": "heartbeat", "streamId": "hot"})
        raise AssertionError("a wrong key must be rejected")
    except ConvexRejected:
        pass
    fake_convex.expected_key = settings.ai_ingress_secret

    # Deployment without the mutation: fall back to /ai/ingress for good.
    convex._mutation_path_ok = True
    from app.clients import convex as convex_mod

    real = convex_mod._MUTATION_PATH
    convex_mod._MUTATION_PATH = "chat/ingress:missing"
    try:
        r = await convex.ingress({"op": "heartbeat", "streamId": "hot"})
        assert r.get("ok") is True
        assert convex._mutation_path_ok is False
    finally:
        convex_mod._MUTATION_PATH = real
