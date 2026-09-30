param([string]$Node = (Get-Command node -ErrorAction Stop).Source)
$ErrorActionPreference = 'Stop'
$simRoot = Split-Path $PSScriptRoot -Parent
$dest = Join-Path $simRoot 'out/aster-sim'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'Requires .NET Framework C# compiler (Windows built-in Framework64/v4.0.30319/csc.exe)' }
if (!(Test-Path -LiteralPath (Join-Path $simRoot 'node_modules/@napi-rs/canvas'))) { throw 'Run npm ci before packaging' }
# Skip identical runtime/native binaries, which Windows may currently have mapped.
function File-Hash([string]$File) {
  $sha = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($File)
  try { return [BitConverter]::ToString($sha.ComputeHash($stream)) }
  finally { $stream.Dispose(); $sha.Dispose() }
}
function Copy-Changed([string]$Source, [string]$Target) {
  $entry = Get-Item -LiteralPath $Source
  if ($entry.PSIsContainer) {
    New-Item -ItemType Directory -Path $Target -Force | Out-Null
    foreach ($child in (Get-ChildItem -LiteralPath $Source -Force)) {
      Copy-Changed $child.FullName (Join-Path $Target $child.Name)
    }
  } else {
    if (Test-Path -LiteralPath $Target) {
      $current = Get-Item -LiteralPath $Target
      if ($current.Length -eq $entry.Length -and
          (File-Hash $Source) -eq (File-Hash $Target)) { return }
    }
    Copy-Item -LiteralPath $Source -Destination $Target -Force
  }
}
New-Item -ItemType Directory -Path $dest,(Join-Path $dest 'runtime') -Force | Out-Null
# Portable output is simulator-only. Prune stale output from older builds.
$allowed = @('src','web','node_modules','runtime','aster-sim.exe','aster-sim.cmd','README.md','LICENSE')
$resolvedDest = [IO.Path]::GetFullPath($dest).TrimEnd([IO.Path]::DirectorySeparatorChar)
foreach ($entry in (Get-ChildItem -LiteralPath $dest -Force)) {
  if ($allowed -notcontains $entry.Name) {
    $target = [IO.Path]::GetFullPath($entry.FullName)
    if (![String]::Equals([IO.Path]::GetDirectoryName($target), $resolvedDest, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected cleanup target' }
    Remove-Item -LiteralPath $target -Recurse -Force
  }
}

foreach ($item in @('src','web','node_modules')) { Copy-Changed (Join-Path $simRoot $item) (Join-Path $dest $item) }
foreach ($item in @('aster-sim.cmd','README.md','LICENSE')) { Copy-Changed (Join-Path $simRoot $item) (Join-Path $dest $item) }
Copy-Changed $Node (Join-Path $dest 'runtime/node.exe')
Copy-Changed (Join-Path $PSScriptRoot 'NODE-LICENSE.txt') (Join-Path $dest 'runtime/LICENSE.txt')
$launcherSource = Join-Path $PSScriptRoot 'launcher.cs'
$launcherExe = Join-Path $dest 'aster-sim.exe'
if (!(Test-Path -LiteralPath $launcherExe) -or
    (Get-Item -LiteralPath $launcherSource).LastWriteTimeUtc -gt (Get-Item -LiteralPath $launcherExe).LastWriteTimeUtc) {
  & $compiler /nologo /target:exe /platform:anycpu ('/out:' + $launcherExe) $launcherSource
  if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed; close the running simulator before updating its launcher' }
}
Write-Host "Portable simulator: $dest/aster-sim.exe"
Write-Host 'Keep the whole folder together; Node.js installation is not required.'
