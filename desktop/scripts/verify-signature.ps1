param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,
    [switch]$AllowUnsigned
)

$ErrorActionPreference = 'Stop'
$resolved = (Resolve-Path -LiteralPath $InstallerPath).Path
$signature = Get-AuthenticodeSignature -LiteralPath $resolved
$result = [ordered]@{
    file = $resolved
    status = [string]$signature.Status
    status_message = [string]$signature.StatusMessage
    signer_subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' }
    thumbprint = if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { '' }
    verified_at = (Get-Date).ToString('o')
}
$result | ConvertTo-Json -Depth 4

if ($signature.Status -eq 'Valid') {
    Write-Output 'SIGNATURE_VALID=1'
    exit 0
}

if ($AllowUnsigned) {
    Write-Warning "安装包未通过 Authenticode 校验，当前仅作为未签名预览包继续。Status=$($signature.Status)"
    Write-Output 'SIGNATURE_VALID=0'
    exit 0
}

Write-Error "安装包未通过 Authenticode 校验：$($signature.Status)。正式发布必须使用受信任代码签名证书。"
exit 1