# One-click build script: PyInstaller onedir (directory mode, no console)
# Usage: powershell -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = "Stop"

$Python = "F:\Python314\python.exe"   # dependencies are installed on F drive
$Root   = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path $Python)) {
    Write-Host "Python not found: $Python" -ForegroundColor Red
    exit 1
}

Push-Location $Root
try {
    Write-Host "==> Cleaning old artifacts (build / dist) ..." -ForegroundColor Cyan
    Remove-Item -Recurse -Force "build", "dist" -ErrorAction SilentlyContinue

    Write-Host "==> Running PyInstaller (first run may be slow) ..." -ForegroundColor Cyan
    & $Python -m PyInstaller --noconfirm --clean wallpaper.spec
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Build FAILED, exit code $LASTEXITCODE" -ForegroundColor Red
        exit $LASTEXITCODE
    }

    $Exe = Join-Path $Root "dist\WallpaperMaker\WallpaperMaker.exe"
    if (-not (Test-Path $Exe)) {
        Write-Host "Build finished but exe not found: $Exe" -ForegroundColor Red
        exit 1
    }

    Write-Host ""
    Write-Host "BUILD OK!" -ForegroundColor Green
    Write-Host "Output dir: $(Split-Path -Parent $Exe)"
    Write-Host "Run: $Exe"
} finally {
    Pop-Location
}
