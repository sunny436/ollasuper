"""Error reporting, shared by both units.

Extracted from app/main.py so the SCHEDULER can use it too. It could not import
it from there: app/main.py builds a FastAPI app at module scope, and the
scheduler has no business constructing one.

That the scheduler had no reporting at all was a real gap — a wedged or
crash-looping scheduler is invisible in a way a wedged web server is not,
because nobody is waiting on a response to notice.
"""

from __future__ import annotations

from app.config import Settings
from app.logging import get_logger

log = get_logger(__name__)


def redact_sentry_event(event: dict) -> dict:
    """Scrub a Sentry/GlitchTip event before it leaves the box.

    Whole-event and recursive on purpose. Redacting `message` and the exception
    `value` alone left three populated carriers untouched: `breadcrumbs` (the
    SDK's default LoggingIntegration turns every INFO record into one), `extra`,
    and stack-frame locals, which the SDK sends by default — so a key held in a
    local variable anywhere in the traceback rode out to an external service.

    It also uses the CONFIGURED secrets rather than the shape regexes alone: the
    old hook called the redactor with no secrets at all, so a key that does not
    look like `sk-`/`bearer `/`data:` was never matched by name.

    HONEST LIMIT: this walks str/dict/list/tuple leaves. An object whose repr
    holds a secret is not reached — the SDK stringifies frame locals before
    before_send runs, so in practice the leaves are already strings."""
    from app.logging import configured_secrets, redact_obj

    return redact_obj(event, configured_secrets())


def init_sentry(settings: Settings, *, component: str) -> None:
    """Report unhandled errors to GlitchTip/Sentry.

    Guarded on the DSN AND an optional import, so nothing is required unless an
    operator installs sentry-sdk and sets AI_SENTRY_DSN — CI, tests and a default
    deployment are all unaffected. Events are scrubbed through the same redactor
    as the logs before they leave the box, so no key, data-URI or bearer token
    rides out in a DSN-bound event.

    `component` tags the events, so a scheduler crash is distinguishable from an
    inference-plane one in the same project.
    """
    dsn = settings.ai_sentry_dsn
    if not dsn:
        return
    try:
        import sentry_sdk
    except ImportError:
        log.warning("sentry_dsn_set_but_sdk_missing")
        return
    def _before_send(event: dict, _hint: object) -> dict:
        try:
            return redact_sentry_event(event)
        except Exception:  # noqa: BLE001 — redaction must never drop the report
            return event

    sentry_sdk.init(dsn=dsn, traces_sample_rate=0.0, before_send=_before_send)
    try:
        sentry_sdk.set_tag("component", component)
    except Exception:  # noqa: BLE001, S110 — a tag is never worth a crash
        pass
    log.info("sentry_initialized", extra={"component": component})
