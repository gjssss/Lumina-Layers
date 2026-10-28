# PyInstaller spec for the Lumina Studio desktop backend.
#
# Builds a self-contained onedir bundle whose entry point is the repository's
# ``api_server.py``. The Electron shell (see electron/main.cjs, packaged mode)
# spawns the produced ``lumina-backend`` executable with the same environment
# contract it uses for a source checkout (LUMINA_API_HOST / LUMINA_API_PORT /
# LUMINA_MATERIALS_DIR / ...), so the bundle behaves like the source runtime.
#
# Run via packaging/build_backend.py; do not invoke PyInstaller with this
# spec from a different working directory: all paths are resolved relative
# to the repository root derived from SPECPATH.

import os

from PyInstaller.utils.hooks import collect_all, collect_data_files

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))

datas = []
binaries = []
hiddenimports = []


def _collect(package):
    """Collect data files, binaries and submodules for one package.

    Missing optional packages are tolerated so a single spec can serve every
    platform matrix leg; genuinely required packages fail later at the
    self-test stage of packaging/build_backend.py, not silently here.
    """
    global datas, binaries, hiddenimports
    try:
        pkg_datas, pkg_binaries, pkg_hidden = collect_all(package)
    except Exception as exc:  # pragma: no cover - build-time diagnostics
        print(f"[lumina-backend.spec] collect_all({package!r}) skipped: {exc}")
        return
    datas += pkg_datas
    binaries += pkg_binaries
    hiddenimports += pkg_hidden


# Native / data-heavy runtime dependencies. Several ship compiled extensions
# plus data files (SciPy direction numbers, llvmlite's LLVM library, OpenCV
# Haar cascades, Shapely/GEOS, ...) that static analysis cannot discover.
for _package in (
    "scipy",
    "numpy",
    "numba",
    "llvmlite",
    "cv2",
    "shapely",
    "manifold3d",
    "resvg_py",
    "lumina_svg_core",
    "fatcat_metadata",
    "fatcat_metadata_neroued",
    "neroued_3mf",
    "neroued_vectorizer",
    "rawpy",
    "pillow_heif",
    "mapbox_earcut",
    "trimesh",
    "networkx",
    "lxml",
    "uvicorn",
    "fastapi",
    "multipart",
    "colormath",
    "svgelements",
    "msgpack",
    "cryptography",
    "psutil",
):
    _collect(_package)

# Application data that the backend resolves relative to its own tree
# (config.py's _BASE_DIR). Code packages (api/, core/, utils/,
# machine_registry/) are picked up as modules by the analysis; their
# non-Python payload files are added explicitly below.
for _data_dir in ("assets", "machine_registry", "lut-preset"):
    _abs = os.path.join(ROOT, _data_dir)
    if os.path.isdir(_abs):
        datas.append((_abs, _data_dir))

for _package in ("api", "core", "utils"):
    try:
        datas += collect_data_files(_package, includes=["**/*.json", "**/*.yaml", "**/*.yml", "**/*.txt", "**/*.ini", "**/*.mako", "**/*.npy", "**/*.npz", "**/*.msgpack"])
    except Exception as exc:  # pragma: no cover - build-time diagnostics
        print(f"[lumina-backend.spec] collect_data_files({_package!r}) skipped: {exc}")

hiddenimports += [
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on",
    "api.app",
    "config",
]

a = Analysis(
    [os.path.join(ROOT, "api_server.py")],
    pathex=[ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Test / notebook tooling that heavy dependencies try to drag in.
        "pytest",
        "IPython",
        "jupyter",
        "notebook",
        "matplotlib.tests",
        "numpy.tests",
        "scipy.tests",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="lumina-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="lumina-backend",
)
