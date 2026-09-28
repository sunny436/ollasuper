"""Physical blob reclamation for the self-hosted Convex volume.

WHY THIS EXISTS. When the app deletes a file, Convex deletes its STORAGE RECORD
in the same transaction — from that moment the blob can no longer be served,
fetched or listed. But this self-hosted backend never removes the BYTES from its
local storage volume (measured on production: 2,761 blob files for 1,013 live
records; deleted files from August still on disk). A user's delete therefore
did not reach the disk. This tool is what does.

A BLOB FILE IS DELETED ONLY WHEN ALL OF THESE HOLD:

  1. no retained revision of any file-storage table names its key as LIVE
     (the latest revision of its record is not a deletion);
  2. if its record WAS deleted, the deletion is older than ``grace`` (default
     10 minutes) — long past any read still in flight at the old snapshot;
  3. the file itself is older than ``min_age`` (default 30 minutes): an upload
     in flight has written its bytes before it commits its record;
  4. the key is still unprotected when the protected set is re-read
     immediately before the unlink;
  5. no backup is exporting (backup.sh holds the storage lock; a busy lock
     skips this run, it never waits or races);
  6. the run's candidates are at most ``max_delete`` (default 200). More than
     that at once means Convex's view looks wrong — a restore, a bug — and the
     run stops WITHOUT deleting, loudly.

Dry run unless ``--apply``. ``--quarantine DIR`` moves instead of deleting
(same filesystem, reversible) and ``--purge-quarantine`` removes quarantined
files older than ``--hold-hours``. Every run writes a JSON report the host
monitor reads (orphan count, bytes, what was done).

EXPORTS (``--exports``): the backup's server-side export zips pile up in
``storage/exports`` (3.3 GB on production). A zip is reclaimable when its
export is finished (or it has no record at all), it is older than
``exports_keep_hours`` and it is not one of the newest ``exports_keep``.

Stdlib only: this runs as root from the service tree, outside the service.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import shlex
import shutil
import subprocess  # noqa: S404 — fixed argv from operator config, no shell
import sys
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field

BLOB_SUFFIX = ".blob"

# ------------------------------------------------------------------ SQL

# Every table (component tables included) whose newest live document is a
# file-storage record: it carries both `storageId` and `storageKey`. Found by a
# loose index scan over (table_id, ...), so it costs one probe per table.
SQL_FILE_TABLES = """
WITH RECURSIVE t AS (
  (SELECT table_id FROM documents ORDER BY table_id LIMIT 1)
  UNION ALL
  SELECT (SELECT d.table_id FROM documents d WHERE d.table_id > t.table_id
          ORDER BY d.table_id LIMIT 1)
  FROM t WHERE t.table_id IS NOT NULL
), sample AS (
  SELECT t.table_id,
    (SELECT convert_from(d.json_value, 'UTF8') FROM documents d
      WHERE d.table_id = t.table_id AND NOT d.deleted
      ORDER BY d.ts DESC LIMIT 1) AS j
  FROM t WHERE t.table_id IS NOT NULL
)
SELECT encode(table_id, 'hex') FROM sample
WHERE j LIKE '%"storageKey"%' AND j LIKE '%"storageId"%';
"""

# Protected keys of the given tables: the key of every record whose latest
# revision is live, or whose deletion is younger than the grace cutoff (ns).
SQL_PROTECTED = """
WITH latest AS (
  SELECT DISTINCT ON (d.table_id, d.id) d.table_id, d.id, d.ts, d.deleted
  FROM documents d WHERE d.table_id IN ({tables})
  ORDER BY d.table_id, d.id, d.ts DESC
), keyed AS (
  SELECT d.table_id, d.id,
         convert_from(d.json_value, 'UTF8')::jsonb ->> 'storageKey' AS k
  FROM documents d WHERE d.table_id IN ({tables}) AND NOT d.deleted
)
SELECT DISTINCT keyed.k FROM keyed
JOIN latest ON latest.table_id = keyed.table_id AND latest.id = keyed.id
WHERE keyed.k IS NOT NULL AND (NOT latest.deleted OR latest.ts > {cutoff_ns});
"""

# Every export record: its zip key and state.
SQL_EXPORTS = """
SELECT convert_from(d.json_value, 'UTF8')::jsonb ->> 'zip_object_key',
       convert_from(d.json_value, 'UTF8')::jsonb ->> 'state'
FROM documents d
WHERE position('"zip_object_key"' in convert_from(d.json_value, 'UTF8')) > 0
  AND NOT d.deleted;
"""

# ------------------------------------------------------------------ model


@dataclass
class BlobFile:
    key: str
    path: str
    size: int
    mtime: float


@dataclass
class Report:
    mode: str
    apply: bool
    status: str = "ok"
    at: float = field(default_factory=time.time)
    storage_dir: str = ""
    tables: list[str] = field(default_factory=list)
    protected: int = 0
    on_disk: int = 0
    on_disk_bytes: int = 0
    candidates: int = 0
    candidate_bytes: int = 0
    too_young: int = 0
    rescued_by_recheck: int = 0
    deleted: int = 0
    deleted_bytes: int = 0
    quarantined: int = 0
    purged_from_quarantine: int = 0
    oldest_candidate_mtime: float | None = None
    sample: list[str] = field(default_factory=list)
    disk_free_before: int | None = None
    disk_free_after: int | None = None
    message: str = ""

    def to_json(self) -> str:
        return json.dumps(self.__dict__, sort_keys=True)


Query = Callable[[str], list[list[str]]]


def psql_runner(command: str) -> Query:
    """A Query over `command` (e.g. `sudo -u postgres psql -d convex_self_hosted`),
    which reads SQL on stdin; rows come back tab-separated."""
    argv = [
        *shlex.split(command),
        "-At",
        "-F",
        "\t",
        "-v",
        "ON_ERROR_STOP=1",
        "-f",
        "-",
    ]

    def run(sql: str) -> list[list[str]]:
        done = subprocess.run(  # noqa: S603 — operator-configured argv, no shell
            argv, input=sql.encode(), capture_output=True, timeout=300, check=False
        )
        if done.returncode != 0:
            raise RuntimeError(
                f"psql failed: {done.stderr.decode(errors='replace')[:400]}"
            )
        out = done.stdout.decode()
        return [line.split("\t") for line in out.splitlines() if line.strip()]

    return run


def list_blobs(directory: str) -> list[BlobFile]:
    out: list[BlobFile] = []
    with os.scandir(directory) as it:
        for e in it:
            if not e.is_file(follow_symlinks=False) or not e.name.endswith(BLOB_SUFFIX):
                continue
            st = e.stat(follow_symlinks=False)
            out.append(
                BlobFile(e.name[: -len(BLOB_SUFFIX)], e.path, st.st_size, st.st_mtime)
            )
    return out


def file_tables(query: Query) -> list[str]:
    tables = [r[0] for r in query(SQL_FILE_TABLES) if r and r[0]]
    for t in tables:
        if not all(c in "0123456789abcdef" for c in t):
            raise RuntimeError(f"unexpected table id {t!r}")
    return tables


def protected_keys(
    query: Query, tables: list[str], grace_s: float, now: float
) -> set[str]:
    if not tables:
        return set()
    cutoff_ns = int((now - grace_s) * 1_000_000_000)
    sql = SQL_PROTECTED.format(
        tables=", ".join(f"decode('{t}', 'hex')" for t in tables), cutoff_ns=cutoff_ns
    )
    return {r[0] for r in query(sql) if r and r[0]}


def disk_free(path: str) -> int | None:
    try:
        st = os.statvfs(path)
    except (AttributeError, OSError):
        return None
    return st.f_bavail * st.f_frsize


@contextlib.contextmanager
def storage_lock(path: str):
    """The lock backup.sh holds while it exports. Non-blocking: busy -> skip."""
    import fcntl  # Linux-only, like this whole tool

    fh = open(path, "a+")  # noqa: SIM115 — held for the whole run
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fh.close()
        yield False
        return
    try:
        yield True
    finally:
        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        fh.close()


def _dispose(f: BlobFile, quarantine: str | None, stamp: str) -> None:
    if quarantine:
        dest = os.path.join(quarantine, stamp)
        os.makedirs(dest, mode=0o700, exist_ok=True)
        os.rename(f.path, os.path.join(dest, os.path.basename(f.path)))
    else:
        os.unlink(f.path)


def select_candidates(
    blobs: Iterable[BlobFile], protected: set[str], *, min_age_s: float, now: float
) -> tuple[list[BlobFile], int]:
    candidates: list[BlobFile] = []
    too_young = 0
    for b in blobs:
        if b.key in protected:
            continue
        if now - b.mtime < min_age_s:
            too_young += 1
            continue
        candidates.append(b)
    return candidates, too_young


def reclaim_files(
    query: Query,
    *,
    storage_dir: str,
    apply: bool,
    grace_s: float = 600,
    min_age_s: float = 1800,
    max_delete: int = 200,
    quarantine: str | None = None,
    now: float | None = None,
) -> Report:
    now = time.time() if now is None else now
    rep = Report(mode="files", apply=apply, storage_dir=storage_dir)
    rep.disk_free_before = disk_free(storage_dir)
    rep.tables = file_tables(query)
    if not rep.tables:
        # No file-storage table found at all: nothing proves any file is
        # unreferenced. Refuse rather than treat every blob as garbage.
        rep.status = "stopped"
        rep.message = "no file-storage table found; refusing to judge any blob"
        return rep
    protected = protected_keys(query, rep.tables, grace_s, now)
    rep.protected = len(protected)
    blobs = list_blobs(storage_dir)
    rep.on_disk = len(blobs)
    rep.on_disk_bytes = sum(b.size for b in blobs)
    candidates, rep.too_young = select_candidates(
        blobs, protected, min_age_s=min_age_s, now=now
    )
    rep.candidates = len(candidates)
    rep.candidate_bytes = sum(b.size for b in candidates)
    rep.sample = sorted(b.key for b in candidates)[:10]
    if candidates:
        rep.oldest_candidate_mtime = min(b.mtime for b in candidates)
    if len(candidates) > max_delete:
        rep.status = "stopped"
        rep.message = (
            f"{len(candidates)} candidates exceed the ceiling of {max_delete}; "
            "nothing deleted - check the protected set before raising --max"
        )
        return rep
    if not apply or not candidates:
        return rep
    # Re-read the protected set right before touching anything (TOCTOU).
    again = protected_keys(query, rep.tables, grace_s, time.time())
    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime(now))
    for b in candidates:
        if b.key in again:
            rep.rescued_by_recheck += 1
            continue
        try:
            _dispose(b, quarantine, stamp)
        except FileNotFoundError:
            continue
        if quarantine:
            rep.quarantined += 1
        else:
            rep.deleted += 1
        rep.deleted_bytes += b.size
    rep.disk_free_after = disk_free(storage_dir)
    return rep


def reclaim_exports(
    query: Query,
    *,
    exports_dir: str,
    apply: bool,
    keep: int = 2,
    keep_hours: float = 48,
    max_delete: int = 200,
    now: float | None = None,
) -> Report:
    now = time.time() if now is None else now
    rep = Report(mode="exports", apply=apply, storage_dir=exports_dir)
    rep.disk_free_before = disk_free(exports_dir)
    states = {
        r[0]: (r[1] if len(r) > 1 else "") for r in query(SQL_EXPORTS) if r and r[0]
    }
    # An export still being written is never touched, whatever its age.
    in_flight = {
        k for k, s in states.items() if s not in ("completed", "failed", "canceled")
    }
    rep.protected = len(in_flight)
    blobs = sorted(list_blobs(exports_dir), key=lambda b: b.mtime, reverse=True)
    rep.on_disk = len(blobs)
    rep.on_disk_bytes = sum(b.size for b in blobs)
    newest = {b.key for b in blobs[:keep]}
    candidates = [
        b
        for b in blobs
        if b.key not in newest
        and b.key not in in_flight
        and now - b.mtime > keep_hours * 3600
    ]
    rep.candidates = len(candidates)
    rep.candidate_bytes = sum(b.size for b in candidates)
    rep.sample = sorted(b.key for b in candidates)[:10]
    if candidates:
        rep.oldest_candidate_mtime = min(b.mtime for b in candidates)
    if len(candidates) > max_delete:
        rep.status = "stopped"
        rep.message = f"{len(candidates)} export candidates exceed {max_delete}"
        return rep
    if not apply:
        return rep
    for b in candidates:
        try:
            os.unlink(b.path)
        except FileNotFoundError:
            continue
        rep.deleted += 1
        rep.deleted_bytes += b.size
    rep.disk_free_after = disk_free(exports_dir)
    return rep


def purge_quarantine(quarantine: str, hold_hours: float, apply: bool) -> int:
    """Remove quarantined batches older than the hold (the undo window)."""
    if not os.path.isdir(quarantine):
        return 0
    removed = 0
    cutoff = time.time() - hold_hours * 3600
    for name in os.listdir(quarantine):
        path = os.path.join(quarantine, name)
        if os.path.isdir(path) and os.stat(path).st_mtime < cutoff:
            removed += sum(1 for _ in os.scandir(path))
            if apply:
                shutil.rmtree(path)
    return removed


def _write_report(path: str | None, rep: Report) -> None:
    line = rep.to_json()
    print(line)
    if path:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        tmp = f"{path}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(line + "\n")
        os.replace(tmp, path)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="blob_reclaim", description=__doc__.split("\n")[0]
    )
    ap.add_argument("--storage-dir", default=os.environ.get("RECLAIM_STORAGE_DIR", ""))
    ap.add_argument(
        "--psql",
        default=os.environ.get(
            "RECLAIM_PSQL", "sudo -u postgres psql -d convex_self_hosted"
        ),
    )
    ap.add_argument("--apply", action="store_true", help="delete (default: dry run)")
    ap.add_argument(
        "--quarantine", default=os.environ.get("RECLAIM_QUARANTINE") or None
    )
    ap.add_argument("--grace-s", type=float, default=600)
    ap.add_argument("--min-age-s", type=float, default=1800)
    ap.add_argument("--max", type=int, default=200, dest="max_delete")
    ap.add_argument(
        "--exports", action="store_true", help="reclaim export zips instead"
    )
    ap.add_argument("--exports-keep", type=int, default=2)
    ap.add_argument("--exports-keep-hours", type=float, default=48)
    ap.add_argument("--purge-quarantine", action="store_true")
    ap.add_argument("--hold-hours", type=float, default=72)
    ap.add_argument(
        "--lock", default=os.environ.get("RECLAIM_LOCK", "/run/lock/myos-storage.lock")
    )
    ap.add_argument("--report", default=os.environ.get("RECLAIM_REPORT") or None)
    a = ap.parse_args(argv)
    if not a.storage_dir:
        print("--storage-dir (or RECLAIM_STORAGE_DIR) is required", file=sys.stderr)
        return 2
    if a.purge_quarantine:
        if not a.quarantine:
            print("--purge-quarantine needs --quarantine", file=sys.stderr)
            return 2
        n = purge_quarantine(a.quarantine, a.hold_hours, a.apply)
        print(json.dumps({"mode": "purge-quarantine", "apply": a.apply, "files": n}))
        return 0
    query = psql_runner(a.psql)
    with storage_lock(a.lock) as got:
        if not got:
            rep = Report(mode="exports" if a.exports else "files", apply=a.apply)
            rep.status = "skipped"
            rep.message = "a backup holds the storage lock"
            _write_report(a.report, rep)
            return 0
        if a.exports:
            rep = reclaim_exports(
                query,
                exports_dir=os.path.join(a.storage_dir, "exports"),
                apply=a.apply,
                keep=a.exports_keep,
                keep_hours=a.exports_keep_hours,
                max_delete=a.max_delete,
            )
        else:
            rep = reclaim_files(
                query,
                storage_dir=os.path.join(a.storage_dir, "files"),
                apply=a.apply,
                grace_s=a.grace_s,
                min_age_s=a.min_age_s,
                max_delete=a.max_delete,
                quarantine=a.quarantine,
            )
    _write_report(a.report, rep)
    return 0 if rep.status in ("ok", "skipped") else 3


if __name__ == "__main__":
    raise SystemExit(main())
