param([string]$Pnpm = 'pnpm')

$ErrorActionPreference = 'Stop'
$projectDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$frontendDirectory = Join-Path $projectDirectory 'frontend'
$staticDirectory = Join-Path $projectDirectory 'src/marketapp_rent/dashboard_static'

Push-Location $frontendDirectory
try {
    & $Pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' }
    & $Pnpm test
    if ($LASTEXITCODE -ne 0) { throw 'Frontend tests failed.' }
    & $Pnpm build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
    New-Item -ItemType Directory -Path $staticDirectory -Force | Out-Null
    $resolvedStaticDirectory = (Resolve-Path -LiteralPath $staticDirectory).Path
    $expectedStaticDirectory = [IO.Path]::GetFullPath((Join-Path $projectDirectory 'src/marketapp_rent/dashboard_static'))
    if ($resolvedStaticDirectory -ne $expectedStaticDirectory -or
        -not $resolvedStaticDirectory.StartsWith($projectDirectory + [IO.Path]::DirectorySeparatorChar)) {
        throw 'Refusing to clean a build destination outside this project.'
    }
    # This directory contains generated frontend output only.
    Get-ChildItem -LiteralPath $resolvedStaticDirectory -Force | ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Recurse -Force
    }
    Copy-Item -Path (Join-Path $frontendDirectory 'dist/*') -Destination $staticDirectory -Recurse -Force
    Write-Output "Dashboard built and copied to $staticDirectory"
} finally {
    Pop-Location
}
