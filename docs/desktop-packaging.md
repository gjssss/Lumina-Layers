# 桌面端打包（GitHub Actions）

`Desktop build` workflow（`.github/workflows/desktop-build.yml`）把 Lumina Studio
打包成可直接运行的桌面应用，覆盖 Windows / Linux / macOS 的 x86-64 与 ARM64
共 6 个组合。手动触发（Actions 页 Run workflow）只产出构建 artifact；推送
`v*` 标签时还会把 6 个平台的产物汇总发布为 GitHub Release。

## 产物

| 平台 | 产物 | 说明 |
| --- | --- | --- |
| Windows x64 / ARM64 | `*-win-x64.exe`（安装版 NSIS）、`*-win-portable.exe`（便携版） | 便携版双击即运行 |
| Linux x64 / ARM64 | `*.AppImage`、`*.tar.gz` | AppImage 赋予可执行权限后直接运行 |
| macOS arm64 / x64 | `*.dmg`、`*.zip` | 未做 Apple 签名/公证，首次打开需在右键菜单选「打开」 |

## 打包结构

安装包只包含 Electron 壳（`electron/`），两个重型运行时以 resources 形式随包：

- `resources/backend/`：用 PyInstaller 冻结的 `api_server.py`
  （`packaging/build_backend.py` + `packaging/lumina-backend.spec`），
  自带 Python 与全部依赖，用户机器无需安装 Python/Node。
- `resources/frontend/`：`frontend` 的 Vite 构建产物（静态文件）。

`electron/main.cjs` 通过 `app.isPackaged` 识别打包模式：启动冻结后端
（环境变量契约与源码模式相同），并用内置静态服务器
（`electron/static-server.cjs`）在 4174 端口提供前端并代理 `/api`，
不再启动 `.venv` Python 与 Vite。可写数据（输出、耗材、工坊）仍写到
系统用户数据目录：后端在打包模式下由主进程注入 `LUMINA_OUTPUT_DIR`，
`config.py` 据此把 `output/` 放到用户数据目录而不是只读的安装目录。

## 平台差异（与 README 的依赖支持面一致）

README 已说明完整原生依赖的 wheel 只覆盖 Windows x64、Linux x86-64、
macOS arm64。本工作流对另外三个组合的处理：

- **Intel macOS**：`fatcat-metadata`、`neroued-3mf`、`neroued-vectorizer`
  无 x86-64 wheel，CI 中从官方 sdist 源码构建（`--source-native`）。
- **Linux ARM64**：上述三个包外加 `lumina-svg-core` 均无 aarch64 wheel，
  全部从 sdist 源码构建（`--source-native --svg-core-source`，需要 Rust
  工具链，workflow 已安装）。ARM64 后端在 Ubuntu 24.04 上构建，
  要求 glibc ≥ 2.39 的发行版。
- **Windows ARM64**：SciPy 与上述原生包均无 win-arm64 wheel，源码构建
  不可行。该包是原生 ARM64 Electron 壳 + x64 后端，后端在
  Windows-on-ARM 仿真层下运行（Windows 11 ARM 的内置 x64 仿真）。

## 验证

每个平台的后端在打包前必须通过 `packaging/build_backend.py` 的冒烟测试：
后端自带的 `--material-sampling-self-test`、`--svg-hole-compensation-self-test`、
`--native-svg-self-test`（有 fixture 时）以及一次真实的
`GET /api/health` 往返。Linux/macOS 的打包任务还会解出成品包，
对包内后端再跑一次自检，确保产物里的后端确实可执行。

## 本地复现

```bash
# 后端（任选当前平台）
python packaging/build_backend.py            # 支持面内的平台
python packaging/build_backend.py --source-native   # Intel Mac 等无 wheel 平台

# 前端与打包
pnpm --dir frontend install --frozen-lockfile && pnpm --dir frontend build
pnpm --dir electron install --frozen-lockfile
pnpm --dir electron exec electron-builder --config electron-builder.yml --publish never
```
