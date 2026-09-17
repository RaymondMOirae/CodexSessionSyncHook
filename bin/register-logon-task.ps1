param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$NodePath
)

$ErrorActionPreference = 'Stop'
$HookEntry = Join-Path $RepoRoot 'bin\hook-entry.mjs'
$TaskName = 'Codex History Sync'
$Action = New-ScheduledTaskAction -Execute $NodePath -Argument ('"{0}" start' -f $HookEntry) -WorkingDirectory $RepoRoot
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description 'Synchronize configured Codex homes through a private Git repository.' -Force | Out-Null

