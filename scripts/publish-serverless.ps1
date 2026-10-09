param(
    [ValidateSet('status', 'publish', 'migrate-check', 'migrate-safe')][string]$Action = 'status',
    [string]$AppId,
    [string]$Node = 'node'
)

$ErrorActionPreference = 'Stop'
$projectDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not (Get-Command $Node -ErrorAction SilentlyContinue)) {
    $bundledNode = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
    if (Test-Path -LiteralPath $bundledNode) { $Node = $bundledNode }
    else { throw 'Install Node.js 24 or provide -Node C:\path\to\node.exe.' }
}
if ([string]::IsNullOrWhiteSpace($AppId)) { throw 'Provide -AppId with the intended numeric Telegram Serverless app ID.' }
$previousDebug = $env:TGCLOUD_DEBUG
$env:TGCLOUD_DEBUG = '0'
Push-Location (Join-Path $projectDirectory 'serverless')
try {
    & $Node 'tools/manage.mjs' --action $Action --app-id $AppId
    if ($LASTEXITCODE -ne 0) { throw "Serverless $Action did not complete." }
} finally { $env:TGCLOUD_DEBUG = $previousDebug; Pop-Location }
