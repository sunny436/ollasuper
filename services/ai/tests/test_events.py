from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from app.models.events import (
    EVENT_SCHEMA_VERSION,
    PAYLOAD_MODELS,
    EventType,
    make_event,
)


def test_make_event_builds_valid_envelope():
    e = make_event(
        EventType.TOOL_CALL,
        3,
        generation_id="s1",
        text_offset=10,
        tool_name="web_search",
        call_id="c1",
        arguments={"q": "x"},
    )
    assert e.type is EventType.TOOL_CALL
    assert e.seq == 3
    assert e.generationId == "s1"
    assert e.v == EVENT_SCHEMA_VERSION == 1
    assert e.textOffset == 10
    body = json.loads(e.payload)
    assert body["tool_name"] == "web_search"
    assert body["status"] == "running"  # default filled in


def test_to_wire_omits_generation_id_and_absent_text_offset():
    e = make_event(EventType.FINAL, 0, generation_id="s1", finish_reason="stop")
    w = e.to_wire()
    assert set(w) >= {"eventId", "seq", "type", "v", "ts", "payload"}
    assert "generationId" not in w  # scoped by streamId on the wire
    assert "textOffset" not in w  # None -> omitted
    assert w["type"] == "FINAL"


def test_every_event_type_has_a_payload_model():
    for et in EventType:
        assert et in PAYLOAD_MODELS


def test_invalid_bodies_are_rejected():
    # progress out of [0,1]
    with pytest.raises(ValidationError):
        make_event(
            EventType.TOOL_PROGRESS, 0, generation_id="s1", call_id="c1", progress=5.0
        )
    # missing required fields
    with pytest.raises(ValidationError):
        make_event(EventType.TOOL_CALL, 0, generation_id="s1")
    # extra="forbid": unknown field rejected
    with pytest.raises(ValidationError):
        make_event(
            EventType.TOOL_CALL,
            0,
            generation_id="s1",
            tool_name="x",
            call_id="c1",
            bogus="nope",
        )


def test_unknown_type_raises():
    with pytest.raises(KeyError):
        make_event("NOT_A_TYPE", 0, generation_id="s1")  # type: ignore[arg-type]
