<#
.SYNOPSIS
    Builds the SCA VS Code extension and installs it into VS Code - one script.

.DESCRIPTION
    1. Checks that Node.js, npm and the VS Code 'code' command are available.
    2. Installs dependencies (npm ci).
    3. Optionally runs the tests.
    4. Packages the extension into sca.vsix.
    5. Installs sca.vsix into VS Code.

    Run it from the root of the sca repository:
        powershell -ExecutionPolicy Bypass -File .\installer.ps1

.PARAMETER RunTests
    Also run unit and integration tests before packaging (slower; first run downloads a test VS Code).

.PARAMETER Uninstall
    Remove the SCA extension from VS Code and exit.

.PARAMETER CodeCommand
    The VS Code CLI to use. Default 'code'. Use 'code-insiders' for VS Code Insiders.
#>
[CmdletBinding()]
param(
    [switch]$RunTests,
    [switch]$Uninstall,
    [string]$CodeCommand = "code"
)

$ErrorActionPreference = "Stop"
$ExtensionId = "tomasi12.sca"
$MinNodeMajor = 22
$RepoRoot = $PSScriptRoot
$VsixPath = Join-Path $RepoRoot "sca.vsix"

function Write-Step([string]$Text) { Write-Host "`n==> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text)   { Write-Host "    OK  $Text" -ForegroundColor Green }
function Fail([string]$Text) {
    Write-Host "`nERROR: $Text" -ForegroundColor Red
    exit 1
}

# Runs a native command and stops the installer if it fails.
function Invoke-Checked([string]$Description, [scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) { Fail "$Description failed (exit code $LASTEXITCODE)." }
}

function Test-Command([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# ---------------------------------------------------------------- uninstall
if ($Uninstall) {
    Write-Step "Uninstalling $ExtensionId"
    if (-not (Test-Command $CodeCommand)) { Fail "'$CodeCommand' not found. Is VS Code installed and on PATH?" }
    Invoke-Checked "Uninstall" { & $CodeCommand --uninstall-extension $ExtensionId }
    Write-Ok "Removed. Reload VS Code windows to finish."
    exit 0
}

# ---------------------------------------------------------------- 1. prerequisites
Write-Step "Checking prerequisites"

if (-not (Test-Path (Join-Path $RepoRoot "package.json"))) {
    Fail "package.json not found next to installer.ps1. Run this script from the sca repository."
}

if (-not (Test-Command "node")) { Fail "Node.js not found. Install Node.js $MinNodeMajor+ from https://nodejs.org and restart the terminal." }
$nodeVersion = (& node --version).Trim()
$nodeMajor = [int]($nodeVersion.TrimStart("v").Split(".")[0])
if ($nodeMajor -lt $MinNodeMajor) { Fail "Node.js $nodeVersion is too old. Install Node.js $MinNodeMajor+." }
Write-Ok "Node.js $nodeVersion"

if (-not (Test-Command "npm")) { Fail "npm not found. It comes with Node.js - reinstall Node.js." }
Write-Ok "npm $((& npm --version).Trim())"

if (-not (Test-Command $CodeCommand)) {
    Fail "'$CodeCommand' not found. Install VS Code from https://code.visualstudio.com (keep 'Add to PATH' checked) and restart the terminal."
}
Write-Ok "VS Code $((& $CodeCommand --version | Select-Object -First 1).Trim())"

Push-Location $RepoRoot
try {
    # ------------------------------------------------------------ 2. dependencies
    Write-Step "Installing dependencies (npm ci)"
    Invoke-Checked "npm ci" { npm ci --no-fund --no-audit }
    Write-Ok "Dependencies installed"

    # ------------------------------------------------------------ 3. tests (optional)
    if ($RunTests) {
        Write-Step "Running unit tests"
        Invoke-Checked "Unit tests" { npm run test:unit }
        Write-Step "Running lint + integration tests"
        Invoke-Checked "Integration tests" { npm test }
        Write-Ok "All tests passed"
    }

    # ------------------------------------------------------------ 4. package
    Write-Step "Packaging extension (sca.vsix)"
    if (Test-Path $VsixPath) { Remove-Item $VsixPath -Force }
    Invoke-Checked "Packaging" { npm run package }
    if (-not (Test-Path $VsixPath)) { Fail "sca.vsix was not created." }
    Write-Ok "Created $VsixPath"

    # ------------------------------------------------------------ 5. install
    Write-Step "Installing into VS Code"
    Invoke-Checked "Extension install" { & $CodeCommand --install-extension $VsixPath --force }

    $installed = & $CodeCommand --list-extensions --show-versions | Where-Object { $_ -like "$ExtensionId@*" }
    if (-not $installed) { Fail "VS Code does not list $ExtensionId after install." }
    Write-Ok "Installed $installed"
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host "SCA is installed." -ForegroundColor Green
Write-Host "  1. Reload open VS Code windows (Ctrl+Shift+P -> 'Developer: Reload Window') or restart VS Code."
Write-Host "  2. Open any .c or .cpp file."
Write-Host "  3. Ctrl+Shift+P -> 'SCA: Show Info'."
Write-Host "To remove it: powershell -ExecutionPolicy Bypass -File .\installer.ps1 -Uninstall"
