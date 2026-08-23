"""Thin shim: `pip install skilljit` gives you the `skilljit` command, but
the actual CLI/MCP server implementation lives in the npm package (the MCP
ecosystem is npx-first, and re-implementing the stdio server, ingestion,
and proxy layer twice would mean two ranking implementations to keep in
sync). This just forwards to it via npx, with a clear error if Node isn't
available — the read-only `skilljit.Catalog` Python API works standalone
without Node, for programs that only need to query an already-synced
catalog.
"""

from __future__ import annotations

import shutil
import subprocess
import sys


def main() -> None:
    if shutil.which("npx") is None:
        print(
            "skilljit's CLI/MCP server requires Node.js (for `npx`), which wasn't found on PATH.\n"
            "Install Node.js from https://nodejs.org, then re-run this command.\n"
            "(If you only need to read an already-synced catalog from Python, "
            "use `from skilljit import Catalog` instead — that part needs no Node.)",
            file=sys.stderr,
        )
        sys.exit(1)

    result = subprocess.run(["npx", "-y", "skilljit", *sys.argv[1:]])
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
