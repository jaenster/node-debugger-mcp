# Install / update node-debugger-mcp for Claude Code on Windows.
#
# Two modes (auto-detected):
#   1. In-repo:    .\install.ps1
#   2. Bootstrap:  irm https://raw.githubusercontent.com/jaenster/node-debugger-mcp/main/install.ps1 | iex

$ErrorActionPreference = "Stop"

$RepoUrl = if ($env:NDM_REPO_URL) { $env:NDM_REPO_URL } else { "https://github.com/jaenster/node-debugger-mcp.git" }
$InstallDir = if ($env:NDM_INSTALL_DIR) { $env:NDM_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "node-debugger-mcp" }
$Name = "node-debugger"

function Need-Cmd($cmd) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Write-Host "error: '$cmd' not found on PATH" -ForegroundColor Red
    exit 1
  }
}

Need-Cmd node
Need-Cmd npm

$nodeMajor = [int]((node -p "process.versions.node.split('.')[0]"))
if ($nodeMajor -lt 20) {
  Write-Host "error: node $nodeMajor is too old; need >= 20" -ForegroundColor Red
  exit 1
}

# Detect in-repo vs bootstrap. $PSCommandPath is empty when piped via iex.
$scriptDir = $null
if ($PSCommandPath) { $scriptDir = Split-Path -Parent $PSCommandPath }

$inRepoPkg = if ($scriptDir) { Join-Path $scriptDir "package.json" } else { $null }
if ($inRepoPkg -and (Test-Path $inRepoPkg) -and ((Get-Content $inRepoPkg -Raw) -match '"node-debugger-mcp"')) {
  Write-Host "==> in-repo install from $scriptDir"
  Set-Location $scriptDir
}
else {
  Write-Host "==> bootstrap install into $InstallDir"
  Need-Cmd git
  if (Test-Path (Join-Path $InstallDir ".git")) {
    Write-Host "==> updating existing checkout"
    Push-Location $InstallDir
    git fetch --quiet origin
    git reset --hard --quiet "origin/HEAD"
    Pop-Location
  }
  else {
    Write-Host "==> cloning $RepoUrl"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $InstallDir) | Out-Null
    git clone --quiet --depth 1 $RepoUrl $InstallDir
  }
  Set-Location $InstallDir
}

$Entry = Join-Path (Get-Location) "dist\server.js"

# Flags / env
$AllowRaw = if ($env:NDM_ALLOW_RAW -eq "1") { $true } else { $false }
$Scope = if ($env:NDM_SCOPE) { $env:NDM_SCOPE } else { "user" }
foreach ($arg in $args) {
  switch -Wildcard ($arg) {
    "--allow-raw"     { $AllowRaw = $true }
    "--scope=local"   { $Scope = "local" }
    "--scope=project" { $Scope = "project" }
    "--scope=user"    { $Scope = "user" }
    "-h"              { Write-Host "Usage: .\install.ps1 [--allow-raw] [--scope=user|local|project]"; exit 0 }
    "--help"          { Write-Host "Usage: .\install.ps1 [--allow-raw] [--scope=user|local|project]"; exit 0 }
    default           { Write-Host "unknown flag: $arg"; exit 1 }
  }
}

Write-Host "==> installing dependencies (npm install)"
npm install --silent

Write-Host "==> building bundle (tsup)"
npm run build --silent

if (-not (Test-Path $Entry)) {
  Write-Host "error: build did not produce $Entry" -ForegroundColor Red
  exit 1
}

if (Get-Command claude -ErrorAction SilentlyContinue) {
  Write-Host "==> registering with ``claude mcp`` (scope=$Scope)"
  claude mcp remove -s $Scope $Name 2>$null | Out-Null
  $envArgs = @()
  if ($AllowRaw) { $envArgs += @("-e", "MCP_DEBUGGER_ALLOW_RAW=1") }
  claude mcp add -s $Scope @envArgs $Name node $Entry
  Write-Host ""
  Write-Host "==> installed. Verify with:  claude mcp list"
  Write-Host "    In an open Claude Code session, run /mcp to reconnect; otherwise tools appear at next session start."
}
else {
  Write-Host ""
  Write-Host "==> ``claude`` CLI not found on PATH — skipping auto-registration."
  Write-Host "    Add this to your Claude Code MCP config manually:"
  Write-Host ""
  Write-Host "      `"node-debugger`": {"
  Write-Host "        `"command`": `"node`","
  Write-Host "        `"args`": [`"$Entry`"]" + $(if ($AllowRaw) { "," } else { "" })
  if ($AllowRaw) {
    Write-Host "        `"env`": { `"MCP_DEBUGGER_ALLOW_RAW`": `"1`" }"
  }
  Write-Host "      }"
}
