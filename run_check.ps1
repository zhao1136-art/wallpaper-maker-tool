# 壁纸工坊一键自检：语法检查 → API 冒烟 → 产物校验
# 用法：powershell .\run_check.ps1    （可设 $env:PYTHON 指定解释器）
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# 优先用 F 盘 Python 3.14（本机 Pillow 安装于此），其次取 $env:PYTHON，最后回退 python
if ($env:PYTHON) { $py = $env:PYTHON }
elseif (Test-Path "F:\Python314\python.exe") { $py = "F:\Python314\python.exe" }
else { $py = "python" }

Write-Host "== 1/3 语法检查 =="
$syntaxOk = $true
$targets = @("server.py", "main.py") + (Get-ChildItem core -Filter *.py | ForEach-Object { $_.FullName })
foreach ($f in $targets) {
    & $py -m py_compile $f 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { $syntaxOk = $false }
}
if (-not $syntaxOk) { Write-Host "FAIL: 语法检查未通过"; exit 1 }
Write-Host "语法检查通过"

Write-Host "== 2/3 API 冒烟测试（_smoke_test.py）=="
& $py _smoke_test.py
$code = $LASTEXITCODE

Write-Host "== 3/3 产物校验 =="
$builtinCount = (Get-ChildItem wallpapers\builtin -Filter *.png -ErrorAction SilentlyContinue | Measure-Object).Count
$assetCount = (Get-ChildItem assets\images -Filter *.png -ErrorAction SilentlyContinue | Measure-Object).Count
$builtinOk = $builtinCount -ge 25
$assetOk = $assetCount -ge 30
Write-Host ("壁纸库: {0} 张 (需>=25) -> {1}" -f $builtinCount, $(if ($builtinOk) { "PASS" } else { "FAIL" }))
Write-Host ("素材库: {0} 张 (需>=30) -> {1}" -f $assetCount, $(if ($assetOk) { "PASS" } else { "FAIL" }))

if ($code -eq 0 -and $builtinOk -and $assetOk) {
    Write-Host "`n==== 全部通过 ===="
} else {
    Write-Host ("`n==== 存在问题：冒烟={0} 壁纸={1} 素材={2} ====" -f $code, $builtinOk, $assetOk)
    if ($code -eq 0) { $code = 1 }
}
exit $code
