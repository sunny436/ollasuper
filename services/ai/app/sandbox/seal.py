"""Make a sandbox's whole filesystem view read-only in ONE syscall.

Run by the sandbox mount script as `python -I -S seal.py` - stdlib only, no
site, no app import - as root of the sandbox's own user namespace, inside its
own mount namespace, before any untrusted byte is read.

WHY ONE SYSCALL. `mount_setattr(2)` with AT_RECURSIVE sets MOUNT_ATTR_RDONLY on
every mount in the tree at once and touches no other flag. The per-mount
remount it replaces resolved each mount point BY PATH and re-stated its flags,
so any mount the sandbox cannot reach by path - one tucked under another, or
below a directory it may not search - or whose locked flags it mis-stated
failed the whole setup, and the harness (failing closed, as it must) then
refused EVERY decode. That took production's Library parsing down on
29-09-2026 while every fresh replica passed. Nothing about the mount table can
make this call fail: it only ever adds a restriction, the kernel's one check.

Then /dev/shm is made writable again - the render/OCR pool's multiprocessing
semaphores live there (the service creates them, the sandboxed worker opens
them read-write) - and so is /proc, best effort: a decoder writing its own
/proc entries is harmless, and a read-only /proc only restricts further.

On any error it prints `sandbox-setup: <step>: <reason>` to stdout (read by
the harness, which logs it) and exits 97, so the decode is refused, not run
less isolated.
"""

from __future__ import annotations

import ctypes
import os
import sys

# mount_setattr(2): 442 in the unified syscall table (x86_64 and arm64 alike).
_NR_MOUNT_SETATTR = 442
_AT_FDCWD = -100
_AT_RECURSIVE = 0x8000
_MOUNT_ATTR_RDONLY = 0x1
SETUP_FAILED = 97


class _MountAttr(ctypes.Structure):
    _fields_ = [
        ("attr_set", ctypes.c_uint64),
        ("attr_clr", ctypes.c_uint64),
        ("propagation", ctypes.c_uint64),
        ("userns_fd", ctypes.c_uint64),
    ]


def _setattr(libc: ctypes.CDLL, path: bytes, flags: int, set_: int, clr: int) -> int:
    """0, or the errno of mount_setattr(path)."""
    attr = _MountAttr(set_, clr, 0, 0)
    rc = libc.syscall(
        ctypes.c_long(_NR_MOUNT_SETATTR),
        ctypes.c_long(_AT_FDCWD),
        ctypes.c_char_p(path),
        ctypes.c_long(flags),
        ctypes.byref(attr),
        ctypes.c_long(ctypes.sizeof(attr)),
    )
    return 0 if rc == 0 else ctypes.get_errno()


def _fail(step: str, err: int) -> int:
    print(f"sandbox-setup: {step}: {os.strerror(err)}", flush=True)
    return SETUP_FAILED


def main() -> int:
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    err = _setattr(libc, b"/", _AT_RECURSIVE, _MOUNT_ATTR_RDONLY, 0)
    if err:
        return _fail("seal", err)
    if os.path.ismount("/dev/shm"):  # noqa: S108 - a mount point, not a temp file
        err = _setattr(libc, b"/dev/shm", 0, 0, _MOUNT_ATTR_RDONLY)
        if err:
            return _fail("shm", err)
    if os.path.ismount("/proc"):
        _setattr(libc, b"/proc", 0, 0, _MOUNT_ATTR_RDONLY)
    return 0


if __name__ == "__main__":
    sys.exit(main())
