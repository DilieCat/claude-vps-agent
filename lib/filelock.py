"""
filelock.py — Cross-process file locking and atomic write utilities.

Uses fcntl.flock() for advisory locking (works on Linux and macOS,
no external dependencies). Provides a context-manager FileLock and
an atomic_write helper that writes to a temp file then os.replace().
"""

import fcntl
import os
import tempfile
from pathlib import Path


class FileLock:
    """Advisory file lock using a .lock sidecar file.

    Usage:
        with FileLock(data_path):
            data = data_path.read_text()
            # ... modify data ...
            atomic_write(data_path, data)
    """

    def __init__(self, path: str | Path):
        self.lock_path = str(path) + ".lock"
        self._f = None

    def __enter__(self):
        self._f = open(self.lock_path, "w")
        fcntl.flock(self._f, fcntl.LOCK_EX)
        return self

    def __exit__(self, *args):
        fcntl.flock(self._f, fcntl.LOCK_UN)
        self._f.close()
        self._f = None


def atomic_write(path: Path, data: str) -> None:
    """Write *data* to *path* atomically via a temp file + os.replace()."""
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(data)
        os.replace(tmp, str(path))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
