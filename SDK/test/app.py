#!/usr/bin/env python3
"""Primary licenx SDK diagnostic console launcher (no legacy SDK).

Never performs a license login unless the diagnostic console explicitly asks.
"""
from pathlib import Path
import runpy

if __name__ == "__main__":
    script = Path(__file__).resolve().parents[1] / "client" / "python" / "licenx" / "test" / "app.py"
    if not script.is_file():
        raise SystemExit("Primary licenx SDK diagnostic console is unavailable")
    runpy.run_path(str(script), run_name="__main__")
