"""HTTP client for talking back to Convex.

One AsyncClient for the process lifetime, created in the FastAPI lifespan and
injected. Constructing a client per flush would mean a TCP handshake every 96
characters — the single most common way this design goes wrong, and the thing
tests/test_writer.py explicitly asserts against.
"""

from __future__ import annotations

import asyncio
import random

import httpx

from app.config import Settings
from app.logging import get_logger

log = get_logger(__name__)

# Retry only what is worth retrying. A 401 means the secret is wrong; retrying
# just burns the deadline.
_RETRY_BACKOFF = (0.15, 0.4, 1.0, 2.5)


class ConvexUnavailable(RuntimeError):
    """Convex could not be reached, or returned a retryable error.

    The writer swallows these and carries the backlog into the next flush.
    """


class ConvexRejected(RuntimeError):
    """Convex refused the request and will keep refusing it.

    Separate from ConvexUnavailable on purpose: a 401 means AI_INGRESS_SECRET
    is wrong, and treating that as "transient" means every generation quietly
    burns the full 20s ingress deadline before failing. This must surface
    immediately and loudly.
    """


# The ops chat/ingress.ts serves as a guarded public mutation. Everything else
# stays on the HTTP action.
_HOT_OPS = frozenset(
    {
        "delta",
        "event",
        "heartbeat",
        "finalize",
        "sched-list",
        "sched-materialize",
        "sched-claim",
        "sched-heartbeat",
        "sched-verify",
    }
)
_MUTATION_PATH = "chat/ingress:apply"


class ConvexClient:
    def __init__(self, settings: Settings, client: httpx.AsyncClient) -> None:
        self._s = settings
        self._c = client
        # Flipped once if the deployment does not have chat/ingress:apply yet
        # (deploy skew: Convex must ship before this build). Every hot op then
        # takes the HTTP action, exactly as before this path existed.
        self._mutation_path_ok = True

    @staticmethod
    def build_http_client() -> httpx.AsyncClient:
        return httpx.AsyncClient(
            limits=httpx.Limits(
                max_connections=32,
                max_keepalive_connections=16,
                keepalive_expiry=30,
            ),
            timeout=httpx.Timeout(connect=2.0, read=8.0, write=8.0, pool=2.0),
            # Loopback to a Rust server; HTTP/1.1 keep-alive is plenty and
            # avoids pulling in the h2 dependency.
            http2=False,
        )

    async def ingress(self, body: dict) -> dict:
        """Apply one ingress op. Raises ConvexUnavailable on failure.

        A hot op (delta / event / heartbeat / finalize) goes to the guarded
        mutation `chat/ingress:apply` over /api/mutation: measured on
        production, the HTTP action path costs ~136 ms per POST of which the
        mutation is ~11 ms, and /api/mutation round-trips in 8-14 ms — the
        same secret check, the same capability-scoped mutations, the same
        results. Anything else, or a deployment without the mutation, uses
        /ai/ingress as always.
        """
        if body.get("op") in _HOT_OPS and self._mutation_path_ok:
            out = await self._ingress_mutation(body)
            if out is not None:
                return out
        return await self._ingress_http(body)

    async def _ingress_mutation(self, body: dict) -> dict | None:
        """The /api/mutation path. None => fall back to the HTTP action."""
        payload = {
            "path": _MUTATION_PATH,
            "args": {"key": self._s.ai_ingress_secret, "body": body},
            "format": "json",
        }
        last: Exception | None = None
        for attempt, backoff in enumerate(_RETRY_BACKOFF):
            try:
                r = await self._c.post(self._s.mutation_url, json=payload)
            except (httpx.TransportError, httpx.TimeoutException) as e:
                last = e
            else:
                if r.status_code == 200:
                    try:
                        env = r.json()
                    except ValueError:
                        return None
                    if env.get("status") == "success":
                        value = env.get("value") or {}
                        status = int(value.get("status", 500))
                        out = value.get("body")
                        if status < 400:
                            return out if isinstance(out, dict) else {}
                        if status == 404:
                            # Unknown or already-finalized stream. Not
                            # retryable, and not an error: tell the caller to stop.
                            return {"ok": False, "cancel": True, "unknown": True}
                        if status < 500:
                            log.error(
                                "ingress_rejected",
                                extra={"status": status, "op": body.get("op")},
                            )
                            raise ConvexRejected(f"ingress rejected: {status}")
                        last = ConvexUnavailable(f"ingress {status}")
                    else:
                        msg = str(env.get("errorMessage", ""))
                        if "Could not find public function" in msg:
                            # Older Convex deployment: fall back for the rest of
                            # this process's life (logged once).
                            if self._mutation_path_ok:
                                log.warning("ingress_mutation_path_unavailable")
                            self._mutation_path_ok = False
                            return None
                        if "unauthorized" in msg:
                            log.error(
                                "ingress_rejected",
                                extra={"status": 401, "op": body.get("op")},
                            )
                            raise ConvexRejected("ingress rejected: unauthorized")
                        last = ConvexUnavailable(f"ingress mutation error: {msg[:120]}")
                elif r.status_code == 404:
                    # No /api/mutation at this origin at all: not our backend.
                    if self._mutation_path_ok:
                        log.warning("ingress_mutation_path_unavailable")
                    self._mutation_path_ok = False
                    return None
                elif r.status_code < 500:
                    log.error(
                        "ingress_rejected",
                        extra={"status": r.status_code, "op": body.get("op")},
                    )
                    raise ConvexRejected(f"ingress rejected: {r.status_code}")
                else:
                    last = ConvexUnavailable(f"ingress {r.status_code}")

            if attempt < len(_RETRY_BACKOFF) - 1:
                jitter = 0.75 + random.random() * 0.5  # noqa: S311
                await asyncio.sleep(backoff * jitter)

        raise ConvexUnavailable(str(last) if last else "ingress unavailable")

    async def _ingress_http(self, body: dict) -> dict:
        """POST one op to /ai/ingress. Raises ConvexUnavailable on failure."""
        headers = {
            "content-type": "application/json",
            "x-ai-key": self._s.ai_ingress_secret,
        }
        last: Exception | None = None
        for attempt, backoff in enumerate(_RETRY_BACKOFF):
            try:
                r = await self._c.post(self._s.ingress_url, json=body, headers=headers)
            except (httpx.TransportError, httpx.TimeoutException) as e:
                last = e
            else:
                if r.status_code < 400:
                    try:
                        return r.json()
                    except ValueError:
                        return {}
                if r.status_code == 404:
                    # Unknown or already-finalized stream. Not retryable, and
                    # not an error: tell the caller to stop.
                    return {"ok": False, "cancel": True, "unknown": True}
                if r.status_code < 500:
                    log.error(
                        "ingress_rejected",
                        extra={"status": r.status_code, "op": body.get("op")},
                    )
                    raise ConvexRejected(f"ingress rejected: {r.status_code}")
                last = ConvexUnavailable(f"ingress {r.status_code}")

            if attempt < len(_RETRY_BACKOFF) - 1:
                jitter = 0.75 + random.random() * 0.5  # noqa: S311
                await asyncio.sleep(backoff * jitter)

        raise ConvexUnavailable(str(last) if last else "ingress unavailable")

    async def fetch_file(self, storage_id: str, stream_id: str) -> tuple[bytes, str]:
        """Fetch attachment bytes.

        Goes through Convex with the ingress secret rather than using a
        ctx.storage.getUrl(). That URL is a BEARER CAPABILITY — unguessable but
        unscoped — so passing it around would leak it into request bodies,
        httpx logs and traces.

        `stream_id` is not decoration: /ai/file is capability-scoped, and Convex
        will only return the blob if it belongs to an attachment on THIS
        stream's thread. Without it the ingress secret alone would be a key to
        every blob in the deployment.
        """
        r = await self._c.post(
            self._s.file_url,
            json={"storageId": storage_id, "streamId": stream_id},
            headers={
                "content-type": "application/json",
                "x-ai-key": self._s.ai_ingress_secret,
            },
        )
        if r.status_code == 404:
            # Not ours, or gone. Retrying cannot help.
            raise ConvexRejected("attachment not available")
        if r.status_code != 200:
            raise ConvexUnavailable(f"file fetch failed: {r.status_code}")
        return r.content, r.headers.get("content-type", "application/octet-stream")

    async def fetch_ingest_file(self, ingest_id: str) -> tuple[bytes, str]:
        """Fetch the staging bytes for a knowledge-base file.

        Sibling of fetch_file, scoped by the ingestId capability (not streamId).
        Convex resolves the storageId server-side and returns the blob only if it
        is this row's own staging blob — the storageId never crosses to Python.
        """
        r = await self._c.post(
            self._s.ingest_file_url,
            json={"fileId": ingest_id},
            headers={
                "content-type": "application/json",
                "x-ai-key": self._s.ai_ingress_secret,
            },
            timeout=httpx.Timeout(connect=2.0, read=30.0, write=8.0, pool=2.0),
        )
        if r.status_code == 404:
            raise ConvexRejected("ingest file not available")
        if r.status_code != 200:
            raise ConvexUnavailable(f"ingest file fetch failed: {r.status_code}")
        return r.content, r.headers.get("content-type", "application/octet-stream")

    async def store_artifact(
        self,
        blob: bytes,
        *,
        stream_id: str,
        filename: str,
        fmt: str,
        mime: str,
        sha256: str | None = None,
        artifact_key: str | None = None,
        parent_artifact_id: str | None = None,
        role: str | None = None,
        page: int | None = None,
    ) -> dict:
        """Store a GENERATED file blob and register it (File Generation System).

        POSTs the raw bytes to /ai/artifact (a dedicated binary endpoint, not the
        JSON ingress) with the metadata in headers. Capability-scoped by streamId
        exactly like /ai/file: Convex derives the owning user/thread/message from the
        stream and never trusts a client-sent owner. Returns `{artifactId, size}`;
        the download URL is minted later, owner-checked, so no bearer token is issued
        here. Raises on failure so the tool reports honestly, never a fake file.

        Phase 3 (additive): `x-artifact-sha256` declares the content hash for
        server-side integrity verification (mismatch → 400); `x-artifact-key` makes
        the store idempotent (a re-store with the same stream+key returns the existing
        artifactId). Both omitted for filegen ⇒ byte-identical."""
        headers = {
            "content-type": mime,
            "x-ai-key": self._s.ai_ingress_secret,
            "x-stream-id": stream_id,
            "x-artifact-format": fmt,
            # RFC 5987 not needed: filename is server-slugified to ASCII already.
            "x-artifact-filename": filename,
        }
        if sha256:
            headers["x-artifact-sha256"] = sha256
        if artifact_key:
            headers["x-artifact-key"] = artifact_key
        # Documents preview (additive): a child artifact (page image) links to its
        # parent
        # artifact + carries role/page, so the UI can render the inline preview. Omitted
        # for filegen/SEO ⇒ byte-identical.
        if parent_artifact_id:
            headers["x-artifact-parent"] = parent_artifact_id
        if role:
            headers["x-artifact-role"] = role
        if page is not None:
            headers["x-artifact-page"] = str(page)
        r = await self._c.post(
            self._s.artifact_url,
            content=blob,
            headers=headers,
            timeout=httpx.Timeout(connect=2.0, read=30.0, write=30.0, pool=2.0),
        )
        if r.status_code == 422:
            raise ConvexRejected("artifact checksum mismatch")
        if r.status_code == 404:
            raise ConvexRejected("artifact stream not available")
        if r.status_code >= 400:
            raise ConvexUnavailable(f"artifact store failed: {r.status_code}")
        try:
            return r.json()
        except ValueError:
            return {}

    # ── Phase 5: durable SEO runs (runId + leaseToken scoped) ──────────────────
    # All go through the retrying ingress(); the mutations always answer 200 with a
    # {stale}/{cancel}/{ok} envelope (a stale lease or a terminal run → {stale:true},
    # never a 404), so a transient Convex blip is retried, not treated as gone.

    async def seo_run_enqueue(
        self,
        *,
        stream_id: str,
        target: str,
        scope: str,
        input_hash: str,
        max_urls: int | None = None,
    ) -> dict:
        body: dict = {
            "op": "seo-run-enqueue",
            "streamId": stream_id,
            "target": target,
            "scope": scope,
            "inputHash": input_hash,
        }
        if max_urls is not None:
            body["maxUrls"] = max_urls
        return await self.ingress(body)

    async def seo_run_progress(
        self,
        *,
        run_id: str,
        lease_token: str,
        step_key: str,
        input_hash: str,
        processed_count: int,
        cost: float,
        findings_counts: dict | None = None,
        artifact_keys: list[str] | None = None,
        checkpoint: str | None = None,
        summary: str | None = None,
    ) -> dict:
        body: dict = {
            "op": "seo-run-progress",
            "runId": run_id,
            "leaseToken": lease_token,
            "stepKey": step_key,
            "inputHash": input_hash,
            "processedCount": processed_count,
            "cost": cost,
        }
        if findings_counts is not None:
            body["findingsCounts"] = findings_counts
        if artifact_keys is not None:
            body["artifactKeys"] = artifact_keys
        if checkpoint is not None:
            body["checkpoint"] = checkpoint
        if summary is not None:
            body["summary"] = summary
        return await self.ingress(body)

    async def seo_run_heartbeat(self, *, run_id: str, lease_token: str) -> dict:
        return await self.ingress(
            {"op": "seo-run-heartbeat", "runId": run_id, "leaseToken": lease_token}
        )

    async def seo_run_park(
        self,
        *,
        run_id: str,
        lease_token: str,
        checkpoint: str | None = None,
        summary: str | None = None,
    ) -> dict:
        body: dict = {"op": "seo-run-park", "runId": run_id, "leaseToken": lease_token}
        if checkpoint is not None:
            body["checkpoint"] = checkpoint
        if summary is not None:
            body["summary"] = summary
        return await self.ingress(body)

    async def register_artifact(
        self,
        *,
        stream_id: str,
        kind: str,
        subject: str,
        supersedes_artifact_id: str | None = None,
    ) -> dict:
        """Register what this turn produced as an addressable artifact.

        Keyed on the stream, which is also the authorization: Convex resolves
        the thread and the message from it, so a turn can only ever register
        work against its own message.
        """
        body: dict = {
            "op": "artifact",
            "streamId": stream_id,
            "kind": kind,
            "subject": subject,
        }
        if supersedes_artifact_id:
            body["supersedesArtifactId"] = supersedes_artifact_id
        return await self.ingress(body)

    async def context_state(
        self,
        *,
        stream_id: str,
        through_seq: int,
        operation: str | None = None,
        active_subject: str | None = None,
        user_constraints: list[str] | None = None,
        user_decisions: list[str] | None = None,
        open_loops: list[str] | None = None,
    ) -> dict:
        """Persist the turn's context state.

        `operation` is floor-owned — the classifier that produced it is
        deterministic code — so it is always sent. The enrichment fields are
        omitted unless supplied, because an absent field leaves the stored
        value standing: a turn that says nothing must not be able to erase a
        constraint the user set several turns ago.
        """
        body: dict = {
            "op": "context-state",
            "streamId": stream_id,
            "throughSeq": through_seq,
        }
        if operation is not None:
            body["operation"] = operation
        if active_subject is not None:
            body["activeSubject"] = active_subject
        if user_constraints is not None:
            body["userConstraints"] = user_constraints
        if user_decisions is not None:
            body["userDecisions"] = user_decisions
        if open_loops is not None:
            body["openLoops"] = open_loops
        return await self.ingress(body)

    async def seo_run_finalize(
        self,
        *,
        run_id: str,
        lease_token: str,
        status: str,
        report_id: str | None = None,
        error_code: str | None = None,
        summary: str | None = None,
    ) -> dict:
        body: dict = {
            "op": "seo-run-finalize",
            "runId": run_id,
            "leaseToken": lease_token,
            "status": status,
        }
        if report_id is not None:
            body["reportId"] = report_id
        if error_code is not None:
            body["errorCode"] = error_code
        if summary is not None:
            body["summary"] = summary
        return await self.ingress(body)

    async def seo_run_report(
        self, *, run_id: str, lease_token: str, report: dict
    ) -> dict:
        return await self.ingress(
            {
                "op": "seo-run-report",
                "runId": run_id,
                "leaseToken": lease_token,
                "report": report,
            }
        )

    async def store_seo_artifact(
        self,
        blob: bytes,
        *,
        run_id: str,
        lease_token: str,
        step_key: str,
        artifact_key: str,
        filename: str,
        fmt: str,
        mime: str,
        row_count: int,
        sha256: str | None = None,
    ) -> dict:
        """Store a run's compressed crawl artifact (POST /ai/seo-artifact).

        Run-owned (runId + leaseToken headers): Convex derives the owner from the
        seoRuns row and validates the lease, so it does not depend on the enqueuing
        stream. The server always recomputes the SHA-256 and returns the authoritative
        stored `contentHash` (on a dedup hit that is the EXISTING blob's hash). Raises
        on failure so the worker records the batch honestly."""
        headers = {
            "content-type": mime,
            "x-ai-key": self._s.ai_ingress_secret,
            "x-run-id": run_id,
            "x-lease-token": lease_token,
            "x-artifact-key": artifact_key,
            "x-artifact-step": step_key,
            "x-artifact-format": fmt,
            "x-artifact-filename": filename,
            "x-artifact-rowcount": str(row_count),
        }
        if sha256:
            headers["x-artifact-sha256"] = sha256
        r = await self._c.post(
            self._s.seo_artifact_url,
            content=blob,
            headers=headers,
            timeout=httpx.Timeout(connect=2.0, read=30.0, write=30.0, pool=2.0),
        )
        if r.status_code == 422:
            raise ConvexRejected("seo artifact checksum mismatch")
        if r.status_code == 404:
            raise ConvexRejected("seo run not available")
        if r.status_code >= 400:
            raise ConvexUnavailable(f"seo artifact store failed: {r.status_code}")
        try:
            return r.json()
        except ValueError:
            return {}

    # ── Scheduled Tasks (Phase 1) ─────────────────────────────────────────────
    # All ride the retrying ingress(): the mutations answer 200 with a
    # {stale}/{cancel}/{unknown} envelope rather than a 404, so a transient
    # Convex blip is retried instead of being treated as "this occurrence is
    # gone". Identical contract to the chat ingest ops.

    async def sched_list(self, *, limit: int) -> dict:
        """The scheduler's work list. Carries NO task prompt or title."""
        return await self.ingress({"op": "sched-list", "limit": limit})

    async def sched_materialize(
        self,
        *,
        task_id: str,
        from_cursor: int,
        to_cursor: int,
        scheduled_for: list[int],
        next_run_at: int | None = None,
        invalid_reason: str | None = None,
        schedule_ended: bool = False,
    ) -> dict:
        """Create occurrence rows and advance the cursor.

        `from_cursor` is a compare-and-swap on the server: if another tick moved
        the cursor first, nothing is written and {stale:true} comes back. That
        is what stops two overlapping ticks skipping the gap between them.
        """
        body: dict = {
            "op": "sched-materialize",
            "taskId": task_id,
            "fromCursor": from_cursor,
            "toCursor": to_cursor,
            "scheduledFor": scheduled_for,
        }
        if next_run_at is not None:
            body["nextRunAt"] = next_run_at
        if invalid_reason is not None:
            body["invalidReason"] = invalid_reason
        if schedule_ended:
            body["scheduleEnded"] = True
        return await self.ingress(body)

    async def sched_claim(self, *, limit: int, max_per_user: int) -> dict:
        """Take a lease on up to `limit` due occurrences, at most one per task."""
        return await self.ingress(
            {"op": "sched-claim", "limit": limit, "maxPerUser": max_per_user}
        )

    async def sched_verify(
        self, *, occurrence_key: str, lease_token: str, workflow_id: str
    ) -> dict:
        """Re-validate before ANY side effect.

        A workflow recovered from a stale DBOS system database lands here and is
        refused, because Convex — not DBOS — is the ledger.
        """
        return await self.ingress(
            {
                "op": "sched-verify",
                "occurrenceKey": occurrence_key,
                "leaseToken": lease_token,
                "workflowId": workflow_id,
            }
        )

    async def sched_heartbeat(self, *, occurrence_key: str, lease_token: str) -> dict:
        """Prove liveness and learn about cancellation in the same round-trip."""
        return await self.ingress(
            {
                "op": "sched-heartbeat",
                "occurrenceKey": occurrence_key,
                "leaseToken": lease_token,
            }
        )

    async def sched_finalize(
        self,
        *,
        occurrence_key: str,
        lease_token: str,
        outcome: str,
        error_code: str | None = None,
        retryable: bool = False,
    ) -> dict:
        """Terminal completion. Idempotent: a duplicate is a no-op server-side."""
        body: dict = {
            "op": "sched-finalize",
            "occurrenceKey": occurrence_key,
            "leaseToken": lease_token,
            "outcome": outcome,
            "retryable": retryable,
        }
        if error_code is not None:
            body["errorCode"] = error_code[:200]
        return await self.ingress(body)

    # ── Scheduled Tasks execution (Phase 2) ───────────────────────────────────

    async def sched_start_run(
        self, *, occurrence_key: str, lease_token: str, deadline_ms: int
    ) -> dict:
        """Start / resume / retry the AI turn for one occurrence.

        Convex decides which of the three it is from the occurrence's own
        recorded stream — the caller never has to know, which is what makes a
        DBOS-recovered workflow safe to re-enter.
        """
        return await self.ingress(
            {
                "op": "sched-start-run",
                "occurrenceKey": occurrence_key,
                "leaseToken": lease_token,
                "deadlineMs": deadline_ms,
            }
        )

    async def sched_run_status(self, *, occurrence_key: str, lease_token: str) -> dict:
        """Poll the turn. Terminal state + the message's durable error code."""
        return await self.ingress(
            {
                "op": "sched-run-status",
                "occurrenceKey": occurrence_key,
                "leaseToken": lease_token,
            }
        )

    async def sched_cancel_run(self, *, occurrence_key: str, lease_token: str) -> dict:
        """Ask the running turn to stop (the same durable flag the Stop button
        sets; the worker sees it on its next ingress response)."""
        return await self.ingress(
            {
                "op": "sched-cancel-run",
                "occurrenceKey": occurrence_key,
                "leaseToken": lease_token,
            }
        )

    async def set_file_status(
        self,
        ingest_id: str,
        status: str,
        *,
        chunk_count: int | None = None,
        parser_used: str | None = None,
        page_count: int | None = None,
        detected_type: str | None = None,
        content_hash: str | None = None,
        error: str | None = None,
        note: str | None = None,
    ) -> dict:
        """Report terminal ingestion status back to Convex (op:"file").

        Goes through the retrying ingress() so a transient Convex blip doesn't
        strand the file in `processing` (the stall reaper is the backstop). A 404
        (file deleted mid-ingest) surfaces as {unknown: True} and is not an error.
        `note` is a truthful partial-success message (e.g. a content-limit
        truncation), stored alongside a `ready` status.
        """
        body: dict = {"op": "file", "fileId": ingest_id, "status": status}
        if chunk_count is not None:
            body["chunkCount"] = chunk_count
        if parser_used is not None:
            body["parserUsed"] = parser_used
        if page_count is not None:
            body["pageCount"] = page_count
        if detected_type is not None:
            body["detectedType"] = detected_type
        if content_hash is not None:
            body["contentHash"] = content_hash
        if error is not None:
            body["error"] = error[:500]
        if note is not None:
            body["note"] = note[:300]
        return await self.ingress(body)

    async def set_file_progress(
        self,
        ingest_id: str,
        *,
        stage: str,
        progress: int | None = None,
        processed_units: int | None = None,
        total_units: int | None = None,
        message: str | None = None,
    ) -> dict:
        """Report intermediate ingestion progress (op:"file-progress"), status
        stays `processing`. Best-effort and coarse/throttled by the caller: the
        userFiles row it patches is behind a usePaginatedQuery, so each write
        re-sends the whole list to every subscriber (mirrors the chat two-write
        discipline). The terminal set_file_status is the authority."""
        body: dict = {"op": "file-progress", "fileId": ingest_id, "stage": stage}
        if progress is not None:
            body["progress"] = max(0, min(100, int(progress)))
        if processed_units is not None:
            body["processedUnits"] = processed_units
        if total_units is not None:
            body["totalUnits"] = total_units
        if message is not None:
            body["stageMessage"] = message[:120]
        return await self.ingress(body)

    async def healthy(self) -> bool:
        try:
            r = await self._c.get(
                f"{self._s.convex_internal_url.rstrip('/')}/version", timeout=3.0
            )
            return r.status_code < 500
        except httpx.HTTPError:
            return False
