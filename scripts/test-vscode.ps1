$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$codeCommand = (Get-Command code.cmd -ErrorAction Stop).Source
$codeExecutable = Join-Path (Split-Path -Parent (Split-Path -Parent $codeCommand)) 'Code.exe'
$resultsRoot = Join-Path $projectRoot '.test-results'
New-Item -ItemType Directory -Force -Path $resultsRoot | Out-Null
$testWorkspace = Join-Path $resultsRoot 'auto-workspace'
New-Item -ItemType Directory -Force -Path $testWorkspace | Out-Null
$env:CODEX_HOME = Join-Path $resultsRoot 'codex-test-home'
$codexCommand = Get-Command codex -ErrorAction SilentlyContinue
if ($codexCommand) { $env:SHARED_TERMINAL_CODEX_TEST_EXE = $codexCommand.Source }
$arguments = @(
    ('--extensionDevelopmentPath="' + $projectRoot + '"'),
    ('--extensionTestsPath="' + (Join-Path $projectRoot 'dist\integration\run.js') + '"'),
    ('--user-data-dir="' + (Join-Path $resultsRoot 'vscode-profile') + '"'),
    ('--extensions-dir="' + (Join-Path $resultsRoot 'extensions') + '"'),
    '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window',
    ('"' + $testWorkspace + '"')
)
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$process = Start-Process -FilePath $codeExecutable -ArgumentList $arguments -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput (Join-Path $resultsRoot 'vscode-stdout.log') -RedirectStandardError (Join-Path $resultsRoot 'vscode-stderr.log')
if ($process.ExitCode -ne 0) { throw "VS Code integration tests failed with exit code $($process.ExitCode). See .test-results." }
Get-Content -Encoding utf8 (Join-Path $resultsRoot 'vscode-integration.json')
