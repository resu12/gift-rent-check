param([string]$Node = 'node')

$ErrorActionPreference = 'Stop'
$projectDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not (Get-Command $Node -ErrorAction SilentlyContinue)) {
    $bundledNode = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
    if (Test-Path -LiteralPath $bundledNode) { $Node = $bundledNode }
    else { throw 'Install Node.js 18+ or provide -Node C:\path\to\node.exe.' }
}
Push-Location (Join-Path $projectDirectory 'serverless')
try {
    if (-not (Test-Path -LiteralPath 'node_modules/@tgcloud/cli/bin/tgcloud.js')) {
        throw 'Install the locked serverless dependencies first; see docs/telegram-serverless.md.'
    }
    $previousDebug = $env:TGCLOUD_DEBUG
    $env:TGCLOUD_DEBUG = '0'
    & $Node 'node_modules/@tgcloud/cli/bin/tgcloud.js' login
    if ($LASTEXITCODE -ne 0) { throw 'Serverless login did not complete.' }
    Write-Output 'Serverless login saved locally. The app has not been deployed.'
} finally { $env:TGCLOUD_DEBUG = $previousDebug; Pop-Location }
