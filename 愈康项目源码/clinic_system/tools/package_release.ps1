param(
    [string]$Version = "5.1.0",
    [string]$OutputRoot = "D:\WorkBuddy下载\愈康交付"
)

$ErrorActionPreference = "Stop"
$source = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$releaseName = "愈康云诊所-v$Version-Windows免安装版-$stamp"
$stagingRoot = Join-Path $OutputRoot $releaseName
$packageDir = Join-Path $stagingRoot "clinic_system"
New-Item -ItemType Directory -Force -Path $packageDir | Out-Null

# 客户包绝不能携带本机业务库、DPAPI 设备密钥、测试和构建中间文件。
$excludeDirs = @(
    (Join-Path $source "clinic_database"),
    (Join-Path $source "docs"),
    (Join-Path $source "tests"),
    (Join-Path $source "tools"),
    (Join-Path $source "local_rag_worker"),
    (Join-Path $source ".pytest_cache")
)
$backupDirs = Get-ChildItem -LiteralPath $source -Directory -Filter "_backup_*" -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
$excludeDirs += $backupDirs
$excludeFiles = @(
    "*.log",
    "*.zip",
    "*.tmp",
    "_hybrid_input_*.jsonl",
    "knowledge_index.db-wal",
    "knowledge_index.db-shm",
    "start.command",
    "start.sh"
)

$roboArgs = @($source, $packageDir, "/E", "/R:1", "/W:1", "/XD") + $excludeDirs + @("/XF") + $excludeFiles
& robocopy @roboArgs | Out-Host
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }

# 防止源码 node_modules 不完整时把缺依赖的版本打进客户包。
$requiredRuntimeDependencies = @(
    "express",
    "cors",
    "qrcode",
    "xlsx",
    "@fortawesome/fontawesome-free"
)
$missingRuntimeDependencies = @()
foreach ($dependency in $requiredRuntimeDependencies) {
    if (-not (Test-Path -LiteralPath (Join-Path $packageDir "node_modules/$dependency/package.json"))) {
        $missingRuntimeDependencies += $dependency
    }
}
if ($missingRuntimeDependencies.Count -gt 0) {
    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npmCommand) { throw "缺少 npm，无法补齐运行依赖: $($missingRuntimeDependencies -join ', ')" }
    Write-Host "正在补齐运行依赖: $($missingRuntimeDependencies -join ', ')"
    Push-Location -LiteralPath $packageDir
    try {
        & $npmCommand.Source install --omit=dev --no-audit --no-fund --no-package-lock
        if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}
foreach ($dependency in $requiredRuntimeDependencies) {
    if (-not (Test-Path -LiteralPath (Join-Path $packageDir "node_modules/$dependency/package.json"))) {
        throw "发布包运行依赖缺失: $dependency"
    }
}

$forbiddenPaths = @(
    (Join-Path $packageDir "clinic_database"),
    (Join-Path $packageDir "clinic_database\device-key.dpapi"),
    (Join-Path $packageDir "clinic_database\users.json")
)
foreach ($path in $forbiddenPaths) {
    if (Test-Path -LiteralPath $path) { throw "安全校验失败：客户包中仍包含本机数据 $path" }
}

$launcherLines = @(
    '@echo off',
    'setlocal EnableExtensions',
    'chcp 936 >nul',
    'title 愈康云诊所 v5.1',
    '',
    'set "APP_DIR=%~dp0clinic_system"',
    'set "NODE_EXE=%APP_DIR%\node\node.exe"',
    'set "PORT=3002"',
    '',
    'echo ========================================',
    'echo         愈康云诊所 v5.1 快速启动',
    'echo ========================================',
    'echo.',
    '',
    'if not exist "%NODE_EXE%" (',
    '    echo [错误] 缺少内置 Node.js：node\node.exe',
    '    echo 请重新完整解压压缩包，不要只复制部分文件。',
    '    echo.',
    '    pause',
    '    exit /b 1',
    ')',
    '',
    'for %%D in (express cors qrcode xlsx @fortawesome\fontawesome-free) do (',
    '    if not exist "%APP_DIR%\node_modules\%%D\package.json" (',
    '        echo [错误] 缺少运行依赖：%%D',
    '        echo 请重新完整解压压缩包。',
    '        echo.',
    '        pause',
    '        exit /b 1',
    '    )',
    ')',
    '',
    'netstat -ano | findstr ":3002" | findstr "LISTENING" >nul 2>&1',
    'if not errorlevel 1 (',
    '    echo [提示] 3002 端口已有程序在运行。',
    '    echo 如果系统已经启动，浏览器将直接打开登录页面；',
    '    echo 如果不是本系统，请先关闭占用 3002 端口的程序。',
    '    echo.',
    '    start "" "http://localhost:3002/login.html"',
    '    pause',
    '    exit /b 0',
    ')',
    '',
    'cd /d "%APP_DIR%"',
    'set "YUKONG_APP_DIR=%APP_DIR%\"',
    '',
    'echo [信息] 正在启动本地服务...',
    'echo [提示] 首次启动时 Windows 防火墙询问，请选择“允许访问”。',
    'echo [提示] 保持此黑色窗口开启；关闭窗口即停止系统。',
    'echo.',
    '',
    '"%NODE_EXE%" --disable-warning=ExperimentalWarning server.js',
    '',
    'echo.',
    'echo 服务已停止。如启动失败，请把此窗口中的错误内容截图反馈。',
    'pause'
)
$launcherText = $launcherLines -join "`r`n"

$usageLines = @(
    '愈康云诊所 v5.1 Windows 免安装版',
    '',
    '【正确使用步骤】',
    '1. 先把整个压缩包完整解压到 D 盘、桌面或其他有写入权限的文件夹。',
    '2. 不要在压缩包预览窗口里直接运行文件。',
    '3. 双击根目录的“启动愈康.bat”。',
    '4. 保持黑色命令窗口开启，浏览器会自动打开 http://localhost:3002/login.html。',
    '5. 第一次使用请点击“注册”，按页面提示创建账号。',
    '',
    '【重要提醒】',
    '• 不要直接双击 clinic_system\index.html；页面必须通过启动脚本运行。',
    '• 如果 Windows 提示安全警告，请点“更多信息”后选择“仍要运行”。',
    '• 如果 3002 端口被占用，请先关闭旧的本系统进程或其他占用程序。',
    '• 业务数据保存在 clinic_system\clinic_database，停止系统后再复制该文件夹即可备份。',
    '• 不要把其他电脑的 clinic_database 直接复制过来。设备密钥由 Windows DPAPI 加密，换电脑后无法解密。',
    '• 业务数据默认保存在本机。启用第三方 AI 时，相关症状上下文可能发送给所选模型服务商，但不发送患者姓名和手机号。',
    '',
    '【首次启动排查】',
    '1. 确认已完整解压，目录中存在 clinic_system\node\node.exe。',
    '2. 确认杀毒软件没有拦截 node.exe；如有拦截，请选择信任。',
    '3. 如果浏览器没有自动打开，手动访问 http://localhost:3002/login.html。',
    '4. 如果命令窗口出现报错，请保留完整截图，不要只截浏览器页面。'
)
$usageText = $usageLines -join "`r`n"

$gbk = [Text.Encoding]::GetEncoding(936)
$utf8Bom = New-Object Text.UTF8Encoding($true)
$launcherPath = Join-Path $stagingRoot "启动愈康.bat"
$usagePath = Join-Path $stagingRoot "使用说明.txt"
[IO.File]::WriteAllText($launcherPath, $launcherText, $gbk)
[IO.File]::WriteAllText($usagePath, $usageText, $utf8Bom)
[IO.File]::WriteAllText((Join-Path $stagingRoot "RELEASE_VERSION.txt"), "$Version`r`n", [Text.Encoding]::ASCII)

$updateManifest = @{
    version = $Version
    app_dir = "clinic_system"
    restart_command = @("cmd.exe", "/c", "start", "YuKangClinic", "/min", "cmd.exe", "/c", "start.bat")
    healthcheck = @{
        url = "http://127.0.0.1:3002/api/server-info"
        timeout_ms = 60000
        interval_ms = 2000
    }
} | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText((Join-Path $stagingRoot "update-manifest.json"), $updateManifest, $utf8Bom)

$zipPath = Join-Path $OutputRoot "$releaseName.zip"
Compress-Archive -LiteralPath $stagingRoot -DestinationPath $zipPath -CompressionLevel Optimal
$zip = Get-Item -LiteralPath $zipPath
$hash = Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath

Write-Output "STAGING=$stagingRoot"
Write-Output "ZIP=$zipPath"
Write-Output "SIZE_MB=$([math]::Round($zip.Length / 1MB, 2))"
Write-Output "SHA256=$($hash.Hash)"