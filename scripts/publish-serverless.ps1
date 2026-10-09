param(
    [ValidateSet('status', 'publish', 'migrate-check', 'migrate-safe')][string]$Action = 'status',
    [string]$Node = 'node'
)

$ErrorActionPreference = 'Stop'
$projectDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not (Get-Command $Node -ErrorAction SilentlyContinue)) {
    $bundledNode = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
    if (Test-Path -LiteralPath $bundledNode) { $Node = $bundledNode }
    else { throw 'Install Node.js 18+ or provide -Node C:\path\to\node.exe.' }
}
$previousDebug = $env:TGCLOUD_DEBUG
$env:TGCLOUD_DEBUG = '0'
Push-Location (Join-Path $projectDirectory 'serverless')
try {
    $cli = 'node_modules/@tgcloud/cli/bin/tgcloud.js'
    if ($Action -eq 'publish') {
        if (-not (Test-Path -LiteralPath 'dist/index.html')) { throw 'Build with scripts/build-serverless.ps1 first.' }
        & $Node 'tools/preflight.mjs'
        if ($LASTEXITCODE -ne 0) { throw 'Private configuration or build validation failed.' }
        # Targeted push preserves unrelated bot modules and update handlers.
        & $Node $cli push 'tgcloud/schema.js' 'tgcloud/lib/' 'tgcloud/endpoints/' 'dist/'
    } elseif ($Action -eq 'migrate-check') { & $Node $cli migrate --dry-run }
    elseif ($Action -eq 'migrate-safe') { & $Node $cli migrate --safe }
    else { & $Node $cli status }
    if ($LASTEXITCODE -ne 0) { throw "Serverless $Action did not complete." }
} finally { $env:TGCLOUD_DEBUG = $previousDebug; Pop-Location }
