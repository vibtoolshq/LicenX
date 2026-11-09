from pathlib import Path
import sys
from zipfile import BadZipFile, ZipFile

ROOT = Path(__file__).resolve().parents[1]
SDK_ROOT = ROOT / "SDK" / "client" / "python" / "licenx"
CONFIG_TEMPLATE = ROOT / "SDK" / "client" / "python" / "licenx.config.py"
ARCHIVE_PATH = ROOT / "public" / "licenx-python-sdk.zip"
EXCLUDED_DIRS = {"__pycache__", "licenx.egg-info", "test", "SDK feature", ".git"}


def eligible_source_files() -> dict[str, Path]:
    files: dict[str, Path] = {}
    for p in SDK_ROOT.rglob("*"):
        if not p.is_file() or p.is_symlink():
            continue
        rel = p.relative_to(SDK_ROOT)
        if any(component in EXCLUDED_DIRS for component in rel.parts):
            continue
        if p.suffix in {".pyc", ".pyo"} or p.name == ".DS_Store":
            continue
        files[rel.as_posix()] = p
    files["licenx.config.py"] = CONFIG_TEMPLATE
    return files


def main() -> int:
    expected = eligible_source_files()
    errors: list[str] = []
    try:
        with ZipFile(ARCHIVE_PATH) as archive:
            corrupt = archive.testzip()
            if corrupt:
                errors.append(f"Corrupt ZIP member: {corrupt}")
            actual = {member.filename for member in archive.infolist() if not member.is_dir()}
            errors.extend(f"Missing: {name}" for name in sorted(expected.keys() - actual))
            errors.extend(f"Unexpected: {name}" for name in sorted(actual - expected.keys()))
            for name in sorted(actual & expected.keys()):
                if archive.read(name) != expected[name].read_bytes():
                    errors.append(f"Different content: {name}")
            for mandatory in ("pyproject.toml", "__init__.py", "config.py", "README.md", "licenx.config.py"):
                if mandatory not in actual:
                    errors.append(f"Missing mandatory file: {mandatory}")
    except (BadZipFile, OSError) as error:
        errors.append(f"Failed to read SDK ZIP: {error}")
    if errors:
        print("Primary licenx archive FAIL:")
        for issue in errors:
            print("- " + issue)
        return 1
    print(f"Primary licenx SDK ZIP parity PASS ({len(expected)} files).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
