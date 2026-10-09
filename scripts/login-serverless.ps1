param([string]$Node = 'node')

$ErrorActionPreference = 'Stop'
$projectDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not (Get-Command $Node -ErrorAction SilentlyContinue)) {
    $bundledNode = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
    if (Test-Path -LiteralPath $bundledNode) { $Node = $bundledNode }
    else { throw 'Install Node.js 24 or provide -Node C:\path\to\node.exe.' }
}
$previousDebug = $env:TGCLOUD_DEBUG
Push-Location (Join-Path $projectDirectory 'serverless')
try {
    $env:TGCLOUD_DEBUG = '0'
    & $Node 'tools/manage.mjs' --action login
    if ($LASTEXITCODE -ne 0) { throw 'Serverless login did not complete.' }
    Write-Output 'Serverless login saved locally. The app has not been deployed.'
} finally { $env:TGCLOUD_DEBUG = $previousDebug; Pop-Location }
