$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
function Check-Exit { if ($LASTEXITCODE -ne 0) { throw "Build command failed ($LASTEXITCODE)." } }
# Build-time only: Node.js >=22, Python 3.12 and .NET SDK >=8. End users need none of them.
$pythonVersion = & py -3.12 -c "import platform; print(platform.python_version())"
Check-Exit
if (-not $pythonVersion.StartsWith('3.12.')) { throw 'Install Python 3.12 x64 with the Python launcher.' }
$cache = Join-Path $env:LOCALAPPDATA 'Yanmo\build-cache'
New-Item -ItemType Directory -Force $cache | Out-Null
$archive = Join-Path $cache 'python-3.12.10-embed-amd64.zip'
$expected = '4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3'
if (-not (Test-Path $archive)) { Invoke-WebRequest 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip' -OutFile $archive }
if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Python archive checksum mismatch; remove the cached archive and retry.' }
$target = Join-Path $root 'runtime\windows\python'
New-Item -ItemType Directory -Force $target | Out-Null
Expand-Archive -LiteralPath $archive -DestinationPath $target -Force
$site = Join-Path $target 'Lib\site-packages'
if (Test-Path $site) { Remove-Item -Recurse -Force $site }
& py -3.12 -m pip install --disable-pip-version-check --no-compile --require-hashes -r backend/requirements-api-windows.lock --target $site
Check-Exit
@('python312.zip', '.', 'Lib\site-packages', 'import site') | Set-Content -Encoding ASCII (Join-Path $target 'python312._pth')
# Smoke-test the actual bundled interpreter and backend, with no torch/MLX installed.
$env:YANMO_API_ONLY = '1'
& "$target\python.exe" -B scripts/check-api-runtime.py
Check-Exit
& dotnet publish native/windows/YanmoBridge.csproj -c Release -o runtime/windows/native --nologo
Check-Exit
