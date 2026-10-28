"""Build and smoke-test the packaged Lumina Studio backend for one platform.

This script is the single entry point used by the desktop build workflow
(``.github/workflows/desktop-build.yml``) for every OS/architecture leg. It:

1. creates an isolated build virtualenv from the interpreter that runs it
   (CI selects the interpreter architecture per leg — notably, the Windows
   ARM64 leg deliberately runs the x64 interpreter so the bundled backend
   uses the x64 wheels and runs under Windows-on-ARM emulation, because
   opencv-python and the pinned native 3MF/SVG packages publish no win-arm64 wheels);
2. installs ``requirements.txt`` — on legs flagged ``--source-native`` the
   pinned native packages whose wheels do not cover the target platform
   are built from source instead: fatcat-metadata and neroued-3mf through
   the repository's own pinned-source wheel builder
   (scripts/build_3mf_native_wheels.py, the maintainer path documented in
   docs/desktop-electron.md), neroued-vectorizer — and on Linux ARM64 also
   lumina-svg-core — from their published source distributions;
3. freezes ``api_server.py`` with PyInstaller using
   ``packaging/lumina-backend.spec``;
4. smoke-tests the frozen executable with the backend's own diagnostic
   commands and a real ``GET /api/health`` server round-trip.

Usage (from the repository root):

    python packaging/build_backend.py [--source-native] [--svg-core-source]
                                      [--skip-smoke]

The bundle is written to ``packaging/dist/lumina-backend/``.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGING_DIR = ROOT / "packaging"
VENV_DIR = PACKAGING_DIR / ".venv-build"
DIST_DIR = PACKAGING_DIR / "dist"
BUNDLE_DIR = DIST_DIR / "lumina-backend"

# Packages pinned in requirements.txt that publish wheels only for
# Windows x64 / Linux x86-64 / macOS arm64. On other legs they are removed
# from the requirements pass and built from their source distributions.
SOURCE_NATIVE_PINS = {
    "fatcat-metadata": "fatcat-metadata==0.1.3",
    "neroued-3mf": "neroued-3mf==0.4.2",
    "neroued-vectorizer": "neroued-vectorizer>=0.1.1",
    "lumina-svg-core": "lumina-svg-core==0.3.4",
}

PYINSTALLER_REQUIREMENT = "pyinstaller>=6.11,<7"


def log(message: str) -> None:
    print(f"[build_backend] {message}", flush=True)


def run(command: list[str], **kwargs) -> subprocess.CompletedProcess:
    log("+ " + " ".join(str(part) for part in command))
    return subprocess.run(command, check=True, **kwargs)


def venv_python(venv_dir: Path) -> Path:
    if os.name == "nt":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def create_venv() -> Path:
    if VENV_DIR.exists():
        shutil.rmtree(VENV_DIR)
    run([sys.executable, "-m", "venv", str(VENV_DIR)])
    python = venv_python(VENV_DIR)
    run([str(python), "-m", "pip", "install", "--upgrade", "pip"])
    return python


def filtered_requirements(excluded: set[str]) -> Path:
    """Write a requirements copy without the given package lines.

    Also drops the ``--only-binary=...`` guard line, because the source
    builds below intentionally compile those packages from their sdists.
    """
    lines: list[str] = []
    for raw in (ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines():
        stripped = raw.strip()
        if stripped.startswith("--only-binary"):
            continue
        name = stripped.split("=")[0].split(">")[0].split("<")[0].strip().lower()
        if name in excluded:
            continue
        lines.append(raw)
    target = PACKAGING_DIR / "requirements.filtered.txt"
    target.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return target


# Pinned upstream sources for the two 3MF native packages, mirroring
# scripts/fatcat_packaging_contract.py (the contract module is the source
# of truth; the build script below re-verifies both commits and refuses
# anything else).
FATCAT_REPO = "https://github.com/MOVIBALE/fatcat-metadata.git"
FATCAT_COMMIT = "5023982e03680e0cd89fb9175dd0ca401d41f6f4"
NEROUED_REPO = "https://github.com/Neroued/neroued_3mf.git"
NEROUED_COMMIT = "656f87c55caf742cef2e958a7fc5199cdba2c6f0"


def build_pinned_native_wheels(python: Path) -> None:
    """Build fatcat-metadata + neroued-3mf with the repo's own script.

    The published sdists are not relied on: docs/desktop-electron.md
    documents this maintainer path (scripts/build_3mf_native_wheels.py),
    which clones-at-pinned-commits, builds both wheels and installs the
    exact artifacts after hash verification.
    """
    src_dir = PACKAGING_DIR / "native-src"
    if src_dir.exists():
        shutil.rmtree(src_dir)
    src_dir.mkdir(parents=True)
    fatcat_root = src_dir / "fatcat-metadata"
    neroued_root = src_dir / "neroued_3mf"
    run(["git", "clone", FATCAT_REPO, str(fatcat_root)])
    run(["git", "-C", str(fatcat_root), "checkout", FATCAT_COMMIT])
    run(["git", "clone", NEROUED_REPO, str(neroued_root)])
    run(["git", "-C", str(neroued_root), "checkout", NEROUED_COMMIT])
    run([str(python), "-m", "pip", "install", "build"])
    run(
        [
            str(python),
            str(ROOT / "scripts" / "build_3mf_native_wheels.py"),
            "--fatcat-root", str(fatcat_root),
            "--neroued-source", str(neroued_root),
            "--install",
        ],
        cwd=ROOT,
    )


def install_dependencies(
    python: Path,
    source_native: bool,
    svg_core_source: bool,
    constraints: Path | None = None,
) -> None:
    constraint_args = ["-c", str(constraints)] if constraints else []
    if not source_native and not svg_core_source:
        run([str(python), "-m", "pip", "install", *constraint_args, "-r", str(ROOT / "requirements.txt")])
    else:
        excluded = {"fatcat-metadata", "neroued-3mf", "neroued-vectorizer"}
        if svg_core_source:
            excluded.add("lumina-svg-core")
        requirements = filtered_requirements(excluded)
        run([str(python), "-m", "pip", "install", *constraint_args, "-r", str(requirements)])
        # fatcat-metadata / neroued-3mf come from the repository's own
        # pinned-source wheel builder, not from pip sdists.
        build_pinned_native_wheels(python)
        # --no-binary makes pip build the remaining pinned packages from
        # their published source distributions (both are scikit-build-core
        # C++ builds; build isolation supplies CMake/pybind11). Installed
        # one at a time so a failure names the exact package.
        pip_source = ["neroued-vectorizer"]
        if svg_core_source:
            pip_source.append("lumina-svg-core")
        for name in pip_source:
            run(
                [
                    str(python), "-m", "pip", "install",
                    "--no-binary", name,
                    SOURCE_NATIVE_PINS[name],
                ]
            )
    run([str(python), "-m", "pip", "install", PYINSTALLER_REQUIREMENT])


def freeze(python: Path) -> Path:
    if DIST_DIR.exists():
        shutil.rmtree(DIST_DIR)
    work_dir = PACKAGING_DIR / "build"
    if work_dir.exists():
        shutil.rmtree(work_dir)
    run(
        [
            str(python), "-m", "PyInstaller",
            str(PACKAGING_DIR / "lumina-backend.spec"),
            "--noconfirm",
            "--distpath", str(DIST_DIR),
            "--workpath", str(work_dir),
        ],
        cwd=ROOT,
    )
    exe_name = "lumina-backend.exe" if os.name == "nt" else "lumina-backend"
    exe = BUNDLE_DIR / exe_name
    if not exe.is_file():
        raise SystemExit(f"PyInstaller did not produce {exe}")
    return exe


def run_self_test(exe: Path, args: list[str], label: str) -> None:
    log(f"smoke: {label}")
    completed = subprocess.run(
        [str(exe), *args],
        capture_output=True,
        text=True,
        timeout=600,
    )
    output = (completed.stdout or "") + (completed.stderr or "")
    if completed.returncode != 0:
        raise SystemExit(f"{label} failed with exit {completed.returncode}:\n{output[-4000:]}")
    payload_lines = [line for line in completed.stdout.splitlines() if line.strip().startswith("{")]
    if payload_lines:
        payload = json.loads(payload_lines[-1])
        if payload.get("status") != "ok":
            raise SystemExit(f"{label} reported non-ok payload: {payload}")
    log(f"smoke: {label} ok")


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def run_server_smoke(exe: Path) -> None:
    log("smoke: server health round-trip")
    port = free_port()
    with tempfile.TemporaryDirectory(prefix="lumina-smoke-") as tmp:
        env = {
            **os.environ,
            "LUMINA_API_HOST": "127.0.0.1",
            "LUMINA_API_PORT": str(port),
            "LUMINA_OUTPUT_DIR": os.path.join(tmp, "output"),
            "LUMINA_MATERIALS_DIR": os.path.join(tmp, "materials"),
            "LUMINA_WORKSHOP_DATA_DIR": os.path.join(tmp, "workshop"),
            "LUMINA_DESKTOP_INSTANCE_ID": "packaging-smoke",
        }
        process = subprocess.Popen(
            [str(exe)],
            cwd=tmp,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        try:
            deadline = time.time() + 300
            health: dict | None = None
            while time.time() < deadline:
                if process.poll() is not None:
                    output = process.stdout.read() if process.stdout else ""
                    raise SystemExit(
                        f"backend exited early with {process.returncode}:\n{output[-4000:]}"
                    )
                try:
                    with urllib.request.urlopen(
                        f"http://127.0.0.1:{port}/api/health", timeout=5
                    ) as response:
                        health = json.loads(response.read().decode("utf-8"))
                    break
                except Exception:
                    time.sleep(2)
            if health is None:
                raise SystemExit("backend did not answer /api/health within 300s")
            if health.get("status") != "ok":
                raise SystemExit(f"unexpected /api/health payload: {health}")
            log(f"smoke: /api/health ok: {health}")
        finally:
            process.terminate()
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                process.kill()


def smoke(exe: Path) -> None:
    run_self_test(exe, ["--material-sampling-self-test"], "material sampling self-test")
    run_self_test(exe, ["--svg-hole-compensation-self-test"], "svg hole compensation self-test")
    fixture = ROOT / "color_card_36.svg"
    if fixture.is_file():
        run_self_test(exe, ["--native-svg-self-test", str(fixture)], "native svg self-test")
    run_server_smoke(exe)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source-native",
        action="store_true",
        help="Build fatcat-metadata / neroued-3mf / neroued-vectorizer from source (legs without wheels).",
    )
    parser.add_argument(
        "--svg-core-source",
        action="store_true",
        help="Also build lumina-svg-core from source (Linux ARM64). Implies --source-native handling for it.",
    )
    parser.add_argument(
        "--constraints",
        type=Path,
        default=None,
        help="Extra pip constraints file for the main requirements install (e.g. pinning versions that still publish wheels for a legacy platform).",
    )
    parser.add_argument("--skip-smoke", action="store_true", help="Skip the frozen-executable smoke tests.")
    args = parser.parse_args()

    constraints = (ROOT / args.constraints).resolve() if args.constraints else None
    python = create_venv()
    install_dependencies(python, args.source_native, args.svg_core_source, constraints)
    exe = freeze(python)
    if not args.skip_smoke:
        smoke(exe)
    log(f"backend bundle ready: {BUNDLE_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
