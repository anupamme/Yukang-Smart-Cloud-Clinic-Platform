# YuKang Clinic Desktop Packager v5.1

本目录是愈康云诊所 Windows x64 离线单机版的 Electron + NSIS 构建工程。它负责把现行 `clinic_system` 源码、完整知识库、生产依赖和桌面壳打成一个可选安装目录的 EXE 安装程序。

## 构建前提

- Windows 10/11 x64。
- Node.js 22.5 或更高版本。
- 完整知识库文件，默认路径为 `D:\YukangKnowledge\v5-full\knowledge_index.db`。
- 正式发布需要受信任的 Windows OV/EV 代码签名证书；仅做内部验收时可显式允许未签名构建。
- 所有下载缓存、构建中间物和交付目录应放在 `D:\`。

## 推荐构建命令

在仓库根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File tools\build-commercial-release.ps1
```

该脚本会完成：

1. 校验 `愈康项目源码/clinic_system/package.json` 和 `desktop/package.json` 版本一致。
2. 校验输出根目录位于 `D:\`。
3. 调用 `npm ci` 安装桌面构建工具。
4. 调用 `prepare:runtime` 复制源码、安装生产依赖并把 `node_modules` 改名为 `vendor`。
5. 复制完整 `knowledge_index.db`。
6. 调用 `verify:runtime` 检查离线资源、版本和敏感数据遗漏。
7. 调用 electron-builder 生成 NSIS 安装程序。
8. 校验 Authenticode，执行安装包运行时冒烟测试，计算 SHA-256，并生成带推广闸门标记的独立客户交付目录。

仅做未签名内部验收时：

```powershell
powershell -ExecutionPolicy Bypass -File tools\build-commercial-release.ps1 -AllowUnsigned
```

正式发布时传入 PFX：

```powershell
powershell -ExecutionPolicy Bypass -File tools\build-commercial-release.ps1 `
  -CertificatePath 'D:\ReleaseSecrets\yukang-code-signing.pfx' `
  -DataLicenseConfirmed `
  -CleanVmVerified `
  -CertificatePassword '证书密码'
```

如果证书通过环境变量提供，也可以设置 `CSC_LINK`、`CSC_KEY_PASSWORD` 后直接运行 `npm run dist:win`。脚本会同步设置 `WIN_CSC_LINK`、关闭证书自动探测，并使用时间戳服务器。

## 只构建安装程序

```powershell
Set-Location desktop
$env:npm_config_cache = 'D:\CodexCache\npm'
$env:ELECTRON_CACHE = 'D:\CodexCache\electron'
$env:ELECTRON_BUILDER_CACHE = 'D:\CodexCache\electron-builder'
$env:YUKANG_KNOWLEDGE_DB = 'D:\YukangKnowledge\v5-full\knowledge_index.db'
npm ci --no-audit --no-fund
npm run install:electron
npm run dist:win
```

不提供完整知识库、只做启动测试时：

```powershell
$env:YUKANG_ALLOW_LITE_INDEX = '1'
npm run dist:win
```

精简版只保留关键词检索回退，不能作为商业完整版交付。

## 运行时约定

`prepare-runtime.js` 生成 `desktop/runtime/clinic_system`，其中：

- `node_modules` 被改名为 `vendor`，由桌面壳通过 `NODE_PATH` 加载。
- `clinic_database`、测试、工具、日志、原始药典输入文件不会进入运行时。
- `data/knowledge_index.db` 只在提供 `YUKANG_KNOWLEDGE_DB` 时复制。
- `build-info.json` 记录版本、知识库来源、SHA-256、构建时间。

- `smoke-runtime.js` 会在打包后启动未打包的 Windows 程序，验证登录页、二维码、Font Awesome 和 SheetJS 的离线运行链路。

`verify-runtime.js` 会在打包前检查：

- 主程序和桌面版本一致。
- 完整知识库大于 10 MiB。
- Font Awesome、SheetJS、Express、CORS 和二维码依赖存在。
- 页面不包含 `cdnjs.cloudflare.com`、`cdn.jsdelivr.net` 或 `api.qrserver.com`。
- 不包含患者数据库、DPAPI 密钥、日志、备份、原始药典输入和发布私钥。

## 产物与更新

- 安装程序写入 `desktop/artifacts/`，不提交到 Git。
- 正式交付目录由 `tools/build-commercial-release.ps1` 写入 `D:\WorkBuddy下载\愈康商业化交付\v<版本>\`。
- 静态更新通道使用 Ed25519 签名清单、HTTPS 下载地址、SHA-256 和 Authenticode 校验。
- 更新密钥生成、清单签名和发布顺序见 `docs/commercial/更新与版本发布.md`。

## 发布边界

未签名包只能标记为“内部验收预览”，Windows SmartScreen 可能弹出“未知发布者”。正式推广前必须完成：

1. 使用受信任代码签名证书构建并验证 `Status=Valid`。
2. 在干净 Windows 虚拟机完成安装、启动、备份、恢复、卸载和数据保留测试。
3. 从旧版本升级到新版本，并验证失败回退和手动重装。
4. 取得药典数据及所有第三方内容的商业使用授权。
5. 确认面向局域网部署，不把本地 HTTP 端口直接映射到公网。
