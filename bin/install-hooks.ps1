param(
    [switch]$InstallLogonTask,
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$Node = (Get-Command node).Source
$HookEntry = Join-Path $RepoRoot 'bin\hook-entry.mjs'
$Config = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'sync.config.json') | ConvertFrom-Json
$Homes = @($Config.homes | Where-Object { $_.installHooks -ne $false } | ForEach-Object {
    $value = [string]$_.path
    if ($value -eq '~') { $env:USERPROFILE }
    elseif ($value.StartsWith('~/') -or $value.StartsWith('~\')) { Join-Path $env:USERPROFILE $value.Substring(2) }
    elseif ([System.IO.Path]::IsPathRooted($value)) { $value }
    else { Join-Path $RepoRoot $value }
})

$hookObject = @{
    description = 'Bidirectional Codex conversation history synchronization'
    hooks = @{
        SessionStart = @(
            @{
                matcher = 'startup|resume'
                hooks = @(
                    @{
                        type = 'command'
                        commandWindows = ('"{0}" "{1}" start' -f $Node, $HookEntry)
                        command = ('"{0}" "{1}" start' -f $Node, $HookEntry)
                        timeout = 180
                        statusMessage = 'Syncing Codex conversation history'
                    }
                )
            }
        )
        SessionEnd = @(
            @{
                hooks = @(
                    @{
                        type = 'command'
                        commandWindows = ('"{0}" "{1}" enqueue' -f $Node, $HookEntry)
                        command = ('"{0}" "{1}" enqueue' -f $Node, $HookEntry)
                        timeout = 3
                    }
                )
            }
        )
    }
}

foreach ($codexHome in $Homes) {
    New-Item -ItemType Directory -Force -Path $codexHome | Out-Null
    $hookPath = Join-Path $codexHome 'hooks.json'
    if (Test-Path -LiteralPath $hookPath) {
        Copy-Item -LiteralPath $hookPath -Destination "$hookPath.bak.$(Get-Date -Format yyyyMMdd-HHmmss)"
    }
    $hookObject | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $hookPath -Encoding utf8

    $configPath = Join-Path $codexHome 'config.toml'
    if (-not (Test-Path -LiteralPath $configPath)) {
        "[features]`nhooks = true`n" | Set-Content -LiteralPath $configPath -Encoding utf8
        continue
    }
    $text = Get-Content -Raw -LiteralPath $configPath
    Copy-Item -LiteralPath $configPath -Destination "$configPath.bak.history-sync.$(Get-Date -Format yyyyMMdd-HHmmss)"
    # Normalize mixed and bare CR newlines before editing TOML. A standalone
    # CR is invalid TOML and makes Codex reject the entire config layer.
    $text = $text.Replace("`r`n", "`n").Replace("`r", "`n")
    if ($text -match '(?ms)^\[features\]\s*(.*?)(?=^\[|\z)') {
        if ($Matches[1] -notmatch '(?m)^\s*hooks\s*=') {
            $text = [regex]::Replace($text, '(?m)^\[features\]\s*$', "[features]`nhooks = true", 1)
        } else {
            $text = [regex]::Replace($text, '(?m)^\s*hooks\s*=\s*.*$', 'hooks = true')
        }
    } else {
        $text = $text.TrimEnd() + "`n`n[features]`nhooks = true`n"
    }
    if (-not $text.EndsWith("`n")) { $text += "`n" }
    [System.IO.File]::WriteAllText($configPath, $text, (New-Object System.Text.UTF8Encoding($false)))
}

if ($InstallLogonTask) {
    $taskName = 'Codex History Sync'
    $argument = ('"{0}" "{1}" start' -f $Node, $HookEntry)
    $action = New-ScheduledTaskAction -Execute $Node -Argument ('"{0}" start' -f $HookEntry) -WorkingDirectory $RepoRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Pull, merge, import and refresh Codex conversation history.' -Force | Out-Null
}

Write-Host 'Hooks installed. Open /hooks in each configured Codex client and trust the new hook definitions.'
