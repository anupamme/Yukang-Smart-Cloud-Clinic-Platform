param(
    [Parameter(Mandatory = $true)]
    [string]$DeliveryPath
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $DeliveryPath).Path
$required = @(
    'README_FIRST.txt',
    '安装包',
    '文档\客户安装指南.md',
    '文档\故障排查手册.md',
    '文档\备份与换机迁移.md',
    '文档\更新与版本发布.md',
    '文档\第三方许可与声明.md',
    '文档\商业发布检查清单.md',
    '文档\发布说明与已知问题.md',
    '文档\客户服务与支持信息.md',
    '文档\未签名预览包使用限制.md',
    '更新通道\sign-update.js',
    '更新通道\update-config.example.json',
    '更新通道\update-manifest.example.json',
    '许可\LICENSE.txt',
    '许可\THIRD_PARTY_NOTICES.txt',
    '发布信息\RELEASE_INFO.json',
    '发布信息\SIGNATURE_STATUS.txt',
    '校验\SHA256SUMS.txt'
)

$missing = @($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $root $_)) })
if ($missing.Count -gt 0) {
    throw "交付目录缺少必要文件或目录: $($missing -join ', ')"
}

$installers = @(Get-ChildItem -LiteralPath (Join-Path $root '安装包') -File -Filter '*.exe' -ErrorAction Stop)
if ($installers.Count -ne 1 -or $installers[0].Name -notmatch '^YuKangClinic-Setup-\d+\.\d+\.\d+-x64\.exe$') {
    throw "安装包目录应且仅应包含一个 YuKangClinic-Setup-<version>-x64.exe，当前：$($installers.Name -join ', ')"
}

$forbidden = @(Get-ChildItem -LiteralPath $root -Recurse -File -Force | Where-Object {
    $relative = $_.FullName.Substring($root.Length + 1).Replace('\', '/')
    $relative -match '(?i)(^|/)(clinic_database|node_modules|logs?|release-secrets)(/|$)' -or
    $relative -match '(?i)(^|/)device-key\.dpapi$' -or
    $relative -match '(?i)(^|/)\.env(\.|$)' -or
    $relative -match '(?i)\.(pfx|p12|pvk|snk|pem|key|crt|csr|db)(-wal|-shm)?$' -or
    $relative -match '(?i)(^|/)_hybrid_input_'
})
if ($forbidden.Count -gt 0) {
    throw "交付目录包含禁止外发的敏感或运行时文件: $($forbidden.FullName -join ', ')"
}

$extraPackages = @(Get-ChildItem -LiteralPath $root -Recurse -File -Force | Where-Object {
    $relative = $_.FullName.Substring($root.Length + 1).Replace('\', '/')
    $_.Extension -match '(?i)^\.(exe|msi|appimage|deb|dmg|zip)$' -and $relative -notmatch '^安装包/YuKangClinic-Setup-\d+\.\d+\.\d+-x64\.exe$'
})
if ($extraPackages.Count -gt 0) {
    throw "交付目录包含计划外的安装包或压缩包: $($extraPackages.FullName -join ', ')"
}

$releaseInfoPath = Join-Path $root '发布信息\RELEASE_INFO.json'
$release = Get-Content -Raw -Encoding UTF8 $releaseInfoPath | ConvertFrom-Json
if (-not $release.version -or -not $release.release_channel -or $null -eq $release.promotion_ready) {
    throw 'RELEASE_INFO.json 缺少版本、发布通道或推广状态。'
}
if ($release.promotion_ready -and ($release.signature_status -ne 'Valid' -or -not $release.data_license_confirmed -or -not $release.clean_vm_verified)) {
    throw 'RELEASE_INFO.json 将未全部通过发布闸门的包错误标记为可推广。'
}
if ($release.release_channel -eq 'commercial-signed' -and -not $release.promotion_ready) {
    throw '发布通道与推广状态矛盾。'
}

$readmeFirst = Get-Content -Raw -Encoding UTF8 (Join-Path $root 'README_FIRST.txt')
if (-not $release.promotion_ready -and $readmeFirst -notmatch '是否达到推广条件：否') {
    throw '未达到推广条件的交付包必须在 README_FIRST.txt 中明确标记。'
}

$hashFile = Join-Path $root '校验\SHA256SUMS.txt'
$hashLines = Get-Content -Encoding UTF8 $hashFile
$hashErrors = @()
$checked = 0
$listedPaths = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($line in $hashLines) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $match = [regex]::Match($line, '^([a-fA-F0-9]{64}) \*(.+)$')
    if (-not $match.Success) {
        $hashErrors += "格式错误: $line"
        continue
    }
    $expected = $match.Groups[1].Value.ToLowerInvariant()
    $relative = $match.Groups[2].Value.Replace('/', [IO.Path]::DirectorySeparatorChar)
$relativeKey = $match.Groups[2].Value
if (-not $listedPaths.Add($relativeKey)) {
    $hashErrors += "重复清单: $relativeKey"
    continue
}
    $fullPath = [IO.Path]::GetFullPath((Join-Path $root $relative))
    $rootPrefix = $root.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $fullPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        $hashErrors += "路径越界: $relative"
        continue
    }
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        $hashErrors += "文件缺失: $relative"
        continue
    }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $fullPath).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
        $hashErrors += "哈希不一致: $relative"
        continue
    }
    $checked += 1
}
$actualFiles = @(Get-ChildItem -LiteralPath $root -Recurse -File -Force | Where-Object {
    $candidate = $_.FullName.Substring($root.Length + 1).Replace([IO.Path]::DirectorySeparatorChar, '/')
    $candidate -ne '校验/SHA256SUMS.txt'
})
$unlisted = @($actualFiles | Where-Object {
    $candidate = $_.FullName.Substring($root.Length + 1).Replace([IO.Path]::DirectorySeparatorChar, '/')
    -not $listedPaths.Contains($candidate)
})
if ($unlisted.Count -gt 0) {
    $hashErrors += "存在未纳入哈希清单的文件: $($unlisted.Name -join ', ')"
}

if ($hashErrors.Count -gt 0) {
    throw "SHA-256 校验失败:`n$($hashErrors -join [Environment]::NewLine)"
}

Write-Output "DELIVERY_VERIFY=PASS"
Write-Output "FILES_HASHED=$checked"
Write-Output "RELEASE_CHANNEL=$($release.release_channel)"
Write-Output "PROMOTION_READY=$($release.promotion_ready)"
