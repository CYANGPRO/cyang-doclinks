[CmdletBinding()]
param(
  [string]$RequiredNode = "22.19.0",
  [string]$RequiredNpm = "10.9.2"
)

$ErrorActionPreference = "Stop"

function Get-CommandPathOrNull {
  param([string]$Name)
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($null -eq $cmd) {
    return $null
  }
  return $cmd.Source
}

function Get-NodeVersionOrNull {
  $nodePath = Get-CommandPathOrNull "node"
  if (-not $nodePath) {
    return $null
  }
  return ((& $nodePath --version) -replace "^v", "").Trim()
}

function Get-NpmVersionOrNull {
  $npmPath = Get-CommandPathOrNull "npm"
  if (-not $npmPath) {
    return $null
  }
  return ((& $npmPath --version)).Trim()
}

function Write-Step($Message) {
  Write-Host "==> $Message" -ForegroundColor Cyan
}

Write-Step "Checking current runtime"
$currentNode = Get-NodeVersionOrNull
$currentNpm = Get-NpmVersionOrNull

Write-Host ("Current Node.js: " + ($(if ($currentNode) { $currentNode } else { "not found" })))
Write-Host ("Current npm: " + ($(if ($currentNpm) { $currentNpm } else { "not found" })))
Write-Host ("Required Node.js: $RequiredNode")
Write-Host ("Required npm: $RequiredNpm")

if ($currentNode -eq $RequiredNode -and $currentNpm -eq $RequiredNpm) {
  Write-Host "Proof runtime already matches the pinned baseline." -ForegroundColor Green
  exit 0
}

$voltaPath = Get-CommandPathOrNull "volta"
if ($voltaPath) {
  Write-Step "Using Volta to install the pinned proof baseline"
  & $voltaPath install "node@$RequiredNode" "npm@$RequiredNpm"
  Write-Host "Volta installed the pinned runtime. Open a fresh shell, then rerun npm run prove:build." -ForegroundColor Green
  exit 0
}

$nvmPath = Get-CommandPathOrNull "nvm"
if ($nvmPath) {
  Write-Step "Using nvm-windows to install and activate Node $RequiredNode"
  & $nvmPath install $RequiredNode
  & $nvmPath use $RequiredNode
  $updatedNode = Get-NodeVersionOrNull
  $updatedNpm = Get-NpmVersionOrNull
  Write-Host ("Active Node.js: " + ($(if ($updatedNode) { $updatedNode } else { "not found" })))
  Write-Host ("Active npm: " + ($(if ($updatedNpm) { $updatedNpm } else { "not found" })))
  if ($updatedNode -eq $RequiredNode -and $updatedNpm -eq $RequiredNpm) {
    Write-Host "nvm-windows activated the pinned runtime. Rerun npm run prove:build." -ForegroundColor Green
    exit 0
  }
  Write-Warning "nvm-windows switched Node successfully, but npm does not match the pinned baseline yet."
  Write-Host "Install npm $RequiredNpm inside that Node toolchain, then rerun npm run prove:build."
  exit 1
}

Write-Warning "Neither Volta nor nvm-windows was found on PATH."
Write-Host "Recommended install options for Windows:"
Write-Host "  1. Volta: https://volta.sh"
Write-Host "     Then run: volta install node@$RequiredNode npm@$RequiredNpm"
Write-Host "  2. nvm-windows: https://github.com/coreybutler/nvm-windows"
Write-Host "     Then run: nvm install $RequiredNode && nvm use $RequiredNode"
Write-Host ""
Write-Host "After switching runtimes, rerun:"
Write-Host "  npm ci --include=dev"
Write-Host "  npm run prove:build"
exit 1
