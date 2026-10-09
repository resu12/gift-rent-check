param([string]$Pnpm = 'pnpm')

$ErrorActionPreference = 'Stop'
$projectDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location (Join-Path $projectDirectory 'serverless')
try {
    & $Pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Serverless dependency installation failed.' }
    & $Pnpm test
    if ($LASTEXITCODE -ne 0) { throw 'Serverless tests failed.' }
} finally { Pop-Location }
Push-Location (Join-Path $projectDirectory 'frontend')
try {
    & $Pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' }
    & $Pnpm test
    if ($LASTEXITCODE -ne 0) { throw 'Frontend tests failed.' }
    & $Pnpm build:serverless
    if ($LASTEXITCODE -ne 0) { throw 'Serverless frontend build failed.' }
} finally { Pop-Location }
Write-Output 'Telegram dashboard built locally in serverless/dist. Nothing was deployed.'
