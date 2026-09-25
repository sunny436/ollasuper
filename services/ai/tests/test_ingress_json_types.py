"""The /api/mutation ingress path must hand Python the SAME JSON types as the
HTTP action.

Regression, 2026-09-22 → 2026-09-25: the scheduler's hot ops moved onto
`chat/ingress:apply` over /api/mutation, which encodes every Convex number as a
float64 (`8.0`) where the HTTP action's JSON.stringify writes `8`. `parse_spec`
requires an int hour, so every recurring task that needed new occurrences was
marked "invalid hour" and silently stopped running. The fake server used to
return plain ints on this path, which is why nothing caught it; it now encodes
floats the way the real backend does.
"""

from __future__ import annotations

from app.scheduler.recurrence import parse_spec

TASK = {
    "taskId": "t1",
    "cursorAt": 1_790_000_000_000,
    "spec": {
        "kind": "weekly",
        "timezone": "America/Los_Angeles",
        "hour": 8,
        "minute": 0,
        "weekdays": [0, 1, 2],
    },
    "ratio": 0.5,
    "paused": False,
}


async def test_sched_list_over_the_mutation_path_parses_like_the_http_action(
    convex_client, fake_convex
):
    convex, _ = convex_client
    fake_convex.sched_tasks = [TASK]

    before = fake_convex.mutation_calls
    via_mutation = await convex.ingress({"op": "sched-list", "limit": 5})
    assert fake_convex.mutation_calls == before + 1, "must take the mutation path"

    task = via_mutation["tasks"][0]
    spec = task["spec"]
    assert type(spec["hour"]) is int and type(spec["minute"]) is int
    assert all(type(d) is int for d in spec["weekdays"])
    assert type(task["cursorAt"]) is int
    # The exact call that rejected every recurring task on production.
    parsed = parse_spec(spec)
    assert (parsed.hour, parsed.minute) == (8, 0)

    # Byte-for-byte the HTTP action's answer, types included.
    convex._mutation_path_ok = False
    via_action = await convex.ingress({"op": "sched-list", "limit": 5})
    assert via_action == via_mutation
    action_types = [type(v) for v in via_action["tasks"][0].values()]
    assert action_types == [type(v) for v in task.values()]


async def test_non_integral_numbers_and_booleans_are_left_alone(
    convex_client, fake_convex
):
    convex, _ = convex_client
    fake_convex.sched_tasks = [TASK]
    task = (await convex.ingress({"op": "sched-list", "limit": 5}))["tasks"][0]
    assert task["ratio"] == 0.5 and type(task["ratio"]) is float
    assert task["paused"] is False
