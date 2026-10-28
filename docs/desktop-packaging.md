# 桌面端打包（GitHub Actions）

`Desktop build` workflow（`.github/workflows/desktop-build.yml`）把 Lumina Studio
打包成可直接运行的 Windows 桌面应用，覆盖 x86-64 与 ARM64 两个组合。
手动触发（Actions 页 Run workflow）只产出构建 artifact；推送
`v*` 标签时还会把两个平台的产物汇总发布为 GitHub Release。

## 产物

| 平台 | 产物 | 说明 |
| --- | --- | --- |
| Windows x64 / ARM64 | `*-win-x64.exe`（安装版 NSIS）、`*-win-portable.exe`（便携版） | 便携版双击即运行；包未做代码签名，首次运行可能触发 SmartScreen 提示 |

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

## 平台差异

- **Windows ARM64**：opencv-python 与 fatcat-metadata、neroued-3mf、
  neroued-vectorizer、lumina-svg-core 均无 win-arm64 wheel，源码构建
  不可行。该包是原生 ARM64 Electron 壳 + x64 后端，后端在
  Windows-on-ARM 仿真层下运行（Windows 11 ARM 的内置 x64 仿真）。

## 验证

每个平台的后端在打包前必须通过 `packaging/build_backend.py` 的冒烟测试：
后端自带的 `--material-sampling-self-test`、`--svg-hole-compensation-self-test`、
`--native-svg-self-test`（有 fixture 时）以及一次真实的
`GET /api/health` 往返。

## 本地复现

```bash
# 后端（在 Windows 上）
python packaging/build_backend.py

# 前端与打包
pnpm --dir frontend install --frozen-lockfile && pnpm --dir frontend build
pnpm --dir electron install --frozen-lockfile
pnpm --dir electron exec electron-builder --config electron-builder.yml --publish never
```
