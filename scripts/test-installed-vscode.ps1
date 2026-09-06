param([string]$Version = '0.3.1')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$codeCommand = (Get-Command code.cmd -ErrorAction Stop).Source
$codeExecutable = Join-Path (Split-Path -Parent (Split-Path -Parent $codeCommand)) 'Code.exe'
$resultsRoot = Join-Path $projectRoot '.test-results'
$profile = Join-Path $resultsRoot 'installed-profile'
$extensions = Join-Path $resultsRoot 'installed-extensions'
$runner = Join-Path $resultsRoot 'installed-test-runner'
$testWorkspace = Join-Path $resultsRoot 'installed-auto-workspace'
New-Item -ItemType Directory -Force -Path $testWorkspace | Out-Null
$env:CODEX_HOME = Join-Path $resultsRoot 'installed-codex-home'
$codexCommand = Get-Command codex -ErrorAction SilentlyContinue
if ($codexCommand) { $env:SHARED_TERMINAL_CODEX_TEST_EXE = $codexCommand.Source }
New-Item -ItemType Directory -Force -Path $runner | Out-Null
$manifest = '{"name":"shared-terminal-test-runner","publisher":"local-tests","version":"1.0.0","engines":{"vscode":"^1.102.0"},"main":"./extension.js"}'
[System.IO.File]::WriteAllText((Join-Path $runner 'package.json'), $manifest)
[System.IO.File]::WriteAllText((Join-Path $runner 'extension.js'), 'exports.activate = function () {};')
$vsix = Join-Path $projectRoot "shared-terminal-mcp-$Version.vsix"
& $codeCommand --user-data-dir $profile --extensions-dir $extensions --install-extension $vsix --force
if ($LASTEXITCODE -ne 0) { throw 'Failed to install test VSIX.' }
$arguments = @(
    ('--extensionDevelopmentPath="' + $runner + '"'),
    ('--extensionTestsPath="' + (Join-Path $projectRoot 'dist\integration\run.js') + '"'),
    ('--user-data-dir="' + $profile + '"'),
    ('--extensions-dir="' + $extensions + '"'),
    '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window',
    ('"' + $testWorkspace + '"')
)
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:SHARED_TERMINAL_TEST_INSTALLED = '1'
$process = Start-Process -FilePath $codeExecutable -ArgumentList $arguments -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput (Join-Path $resultsRoot 'installed-stdout.log') -RedirectStandardError (Join-Path $resultsRoot 'installed-stderr.log')
if ($process.ExitCode -ne 0) { throw "Installed VSIX tests failed with exit code $($process.ExitCode). See .test-results." }
Get-Content -Encoding utf8 (Join-Path $resultsRoot 'vscode-integration.json')
