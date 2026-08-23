"""Where the local skilljit catalog db lives — must match the Node CLI's
default exactly, since both read/write the same file."""

import os
from pathlib import Path


def default_catalog_path() -> Path:
    home = Path(os.environ.get("SKILLJIT_HOME", Path.home()))
    return home / ".skilljit" / "catalog.db"
