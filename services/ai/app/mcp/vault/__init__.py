"""The credential vault: encrypt in Python, persist ciphertext in Convex.

    aad.py       the canonical Associated Authenticated Data — ONE definition
    keys.py      master key -> per-version AES key (HKDF), fail-closed
    envelope.py  the versioned ciphertext envelope; PURE seal/open
    models.py    what a stored credential IS
    store.py     the vault proper: get/put/delete/rotate, locking, CAS

WHAT THE ENCRYPTION IS FOR, stated precisely so it is not over-claimed: it
protects credential material in a Convex backup or a leaked database dump. It is
NOT a substitute for authorization — every read and write is still owner-checked
in Convex — and it is NOT protection against loss of the master key, which
decrypts everything. See the plan's threat model.
"""
