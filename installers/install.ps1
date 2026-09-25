# sitegen setup for Codex and Claude Code on Windows (PowerShell 5.1 or 7+).
#
#   Install:    irm __SITEGEN_BASE_URL__/install.ps1 | iex
#   Undo:       irm __SITEGEN_BASE_URL__/uninstall.ps1 | iex
#               (or the "Undo sitegen setup" shortcut in the Start menu)
#
# Points Codex (CLI, desktop app, IDE extension), Claude Code (CLI, IDE
# extensions) and OpenCode (CLI, desktop app) at your sitegen account: GPT
# models for Codex, Claude models for Claude Code, every chat model for
# OpenCode.
#
# Your API key is stored encrypted for your Windows account (DPAPI) in
# %USERPROFILE%\.sitegen. The Codex and Claude Code settings only name a small
# helper script that decrypts it; the key itself is never written into them.
# Every file this changes is backed up to %USERPROFILE%\.sitegen\backups first,
# and the uninstall command puts your previous settings back.
#
# Optional environment variables:
#   SITEGEN_TOOLS         codex, claude, opencode, several joined by commas, or
#                         all (skips the question); undo reverts only the named
#                         tools when it is set
#   SITEGEN_OPENCODE_MODEL  default OpenCode model (skips the question)
#   SITEGEN_API_KEY       use this key instead of asking for it
#   SITEGEN_CODEX_MODEL   default Codex model (skips the question)
#   SITEGEN_CLAUDE_MODEL  default Claude Code model (skips the question)
#   SITEGEN_SKIP_TEST=1   skip the final one-message test
#   SITEGEN_BASE_URL      sitegen server (default: the one this script came from)
#   SITEGEN_HOME          where the key and state live (default: ~\.sitegen)

& {
# This script's own text, saved at install time so undo works offline.
$SelfText = $MyInvocation.MyCommand.ScriptBlock.ToString()
Set-StrictMode -Version 1
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$InstallerVersion = 2
$ProviderId = 'sitegen'
$BaseUrl = '__SITEGEN_BASE_URL__'
if ($env:SITEGEN_BASE_URL) { $BaseUrl = $env:SITEGEN_BASE_URL }
$BaseUrl = $BaseUrl.TrimEnd('/')
# /uninstall.ps1 serves this same script with 'uninstall' written in here.
$DefaultAction = '__SITEGEN_DEFAULT_ACTION__'
$Action = if ($env:SITEGEN_ACTION) { $env:SITEGEN_ACTION } elseif (-not $DefaultAction.StartsWith('__')) { $DefaultAction } else { 'install' }

$SitegenDir = if ($env:SITEGEN_HOME) { $env:SITEGEN_HOME } else { Join-Path $HOME '.sitegen' }
$KeyFile = Join-Path $SitegenDir 'api-key.dpapi'
$HelperFile = Join-Path $SitegenDir 'key.ps1'
$StateFile = Join-Path $SitegenDir 'state.json'
$BackupRoot = Join-Path $SitegenDir 'backups'
$LocalCopy = Join-Path $SitegenDir 'sitegen-setup.ps1'
$UndoShortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Undo sitegen setup.lnk'
$CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$CodexConfig = Join-Path $CodexHome 'config.toml'
$CodexCatalog = Join-Path $CodexHome 'sitegen-models.json'
$ClaudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$ClaudeSettings = Join-Path $ClaudeDir 'settings.json'
# OpenCode reads ~/.config/opencode on every system, XDG_CONFIG_HOME if set.
$OpenCodeDir = if ($env:XDG_CONFIG_HOME) { Join-Path $env:XDG_CONFIG_HOME 'opencode' } else { Join-Path $HOME '.config\opencode' }
# OpenCode can only read a key from a file or a variable, never run a helper,
# so it gets a plain copy readable by this Windows account alone.
$PlainKeyFile = Join-Path $SitegenDir 'api-key'
$ToolNames = [ordered]@{ codex = 'Codex'; claude = 'Claude Code'; opencode = 'OpenCode' }

# Every line the installer adds to config.toml is marked, and every line it
# turns off is commented with a prefix, so uninstall can undo exactly that.
$BlockStart = '# >>> sitegen'
$BlockEnd = '# <<< sitegen'
$ManagedTag = '# sitegen-managed'
$DisabledPrefix = '# sitegen-disabled: '
$TopLevelKeys = @('model', 'model_provider', 'model_catalog_json', 'web_search')
# Codex features whose tools sitegen's Responses endpoint cannot accept.
$DisabledFeatures = @('multi_agent', 'view_image')
# Claude Code settings the installer owns while installed.
$ClaudeEnvKeys = @('ANTHROPIC_BASE_URL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL')

function Say([string]$Text) { Write-Host $Text }
function Step([string]$Text) { Write-Host ''; Write-Host $Text -ForegroundColor Cyan }
function Ok([string]$Text) { Write-Host "  OK  $Text" -ForegroundColor Green }
function Warn([string]$Text) { Write-Host "  !   $Text" -ForegroundColor Yellow }
function Fail([string]$Text) { throw (New-Object System.InvalidOperationException $Text) }

function Write-Utf8([string]$Path, [string]$Text) {
  $parent = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  [IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding $false))
}

function Restrict-ToCurrentUser([string]$Path) {
  try {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $Path /inheritance:r /grant:r "*${sid}:(F)" 2>$null | Out-Null
  } catch { }
}

function Get-Prop($Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  $p = $Object.PSObject.Properties[$Name]
  if ($null -eq $p) { return $null }
  return $p.Value
}

# Updates in place so a changed setting keeps its position in the file.
function Set-Prop($Object, [string]$Name, $Value) {
  $p = $Object.PSObject.Properties[$Name]
  if ($null -ne $p) { $p.Value = $Value }
  else { $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
}

function Remove-Prop($Object, [string]$Name) {
  if ($null -ne $Object.PSObject.Properties[$Name]) { $Object.PSObject.Properties.Remove($Name) }
}

function ConvertTo-TomlString([string]$Value) {
  return '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
}

function New-BackupDir {
  $dir = Join-Path $BackupRoot (Get-Date -Format 'yyyyMMdd-HHmmss')
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  return $dir
}

function Backup-File([string]$Path, [string]$Dir, [string]$Name) {
  if (Test-Path -LiteralPath $Path) { Copy-Item -LiteralPath $Path -Destination (Join-Path $Dir $Name) -Force }
}

# Runs a native command without letting its stderr become a terminating error
# (Windows PowerShell turns redirected stderr into error records).
function Invoke-Native([string]$Exe, [string[]]$Arguments, [hashtable]$Environment = @{}) {
  $saved = @{}
  foreach ($name in $Environment.Keys) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $Environment[$name], 'Process')
  }
  $eap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  # Codex prints UTF-8; Windows PowerShell would decode it with the OEM code page.
  $encoding = $null
  try { $encoding = [Console]::OutputEncoding; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
  try {
    $output = & $Exe @Arguments 2>$null
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $eap
    if ($null -ne $encoding) { try { [Console]::OutputEncoding = $encoding } catch { } }
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
  }
  return @{ Code = $code; Output = (@($output) -join "`n") }
}

# ---------------------------------------------------------------- HTTP

function Invoke-Sitegen([string]$Method, [string]$Path, [string]$Key, $Body = $null, [hashtable]$Headers = @{}) {
  $h = @{ Authorization = "Bearer $Key" }
  foreach ($k in $Headers.Keys) { $h[$k] = $Headers[$k] }
  $params = @{ Method = $Method; Uri = "$BaseUrl$Path"; Headers = $h; TimeoutSec = 90; UseBasicParsing = $true }
  if ($null -ne $Body) {
    $params.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 10 -Compress))
    $params.ContentType = 'application/json'
  }
  try {
    $r = Invoke-WebRequest @params
    return @{ Status = [int]$r.StatusCode; Text = [string]$r.Content }
  } catch {
    $status = 0
    if ($_.Exception.PSObject.Properties['Response'] -and $null -ne $_.Exception.Response) {
      $status = [int]$_.Exception.Response.StatusCode
    }
    $text = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
    return @{ Status = $status; Text = [string]$text }
  }
}

function Get-ErrorMessage([string]$Text) {
  try {
    $j = $Text | ConvertFrom-Json
    $e = Get-Prop $j 'error'
    if ($e -is [string]) { return $e }
    $m = Get-Prop $e 'message'
    if ($m) { return [string]$m }
  } catch { }
  if ($Text.Length -gt 200) { return $Text.Substring(0, 200) }
  return $Text
}

# ---------------------------------------------------------------- input

function Test-Interactive {
  try { return [Environment]::UserInteractive -and -not [Console]::IsInputRedirected } catch { return $false }
}

function Read-ApiKey {
  if ($env:SITEGEN_API_KEY) { return $env:SITEGEN_API_KEY.Trim() }
  if (-not (Test-Interactive)) { Fail 'No terminal to ask for your API key. Set SITEGEN_API_KEY and run again.' }
  Say "  Create a key at $BaseUrl/dashboard/keys (it is shown only once), then paste it here."
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $secure = Read-Host -AsSecureString '  API key (typing is hidden)'
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr).Trim() }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    if ($key -match '^sk_live_[A-Za-z0-9]{32,64}$') { return $key }
    Warn 'That does not look like a sitegen key (it starts with sk_live_). Try again.'
  }
  Fail 'No valid API key was entered.'
}

function Select-Model([string]$Title, [string[]]$Ids, [string]$Default, [string]$Override) {
  if ($Override) {
    if ($Ids -contains $Override) { return $Override }
    Warn "$Override is not available to this key; using $Default instead."
    return $Default
  }
  if (-not (Test-Interactive)) { return $Default }
  $ordered = @($Default) + @($Ids | Where-Object { $_ -ne $Default })
  Say ''
  Say "  $Title"
  for ($i = 0; $i -lt $ordered.Count; $i++) {
    $mark = if ($i -eq 0) { '  (recommended)' } else { '' }
    Say ('    {0,2}. {1}{2}' -f ($i + 1), $ordered[$i], $mark)
  }
  while ($true) {
    $answer = (Read-Host "  Press Enter for 1, or type a number").Trim()
    if ($answer -eq '') { return $ordered[0] }
    if ($answer -match '^\d+$' -and [int]$answer -ge 1 -and [int]$answer -le $ordered.Count) { return $ordered[[int]$answer - 1] }
    if ($ordered -contains $answer) { return $answer }
    Warn "Type a number from 1 to $($ordered.Count)."
  }
}

# ---------------------------------------------------------------- models

# Newest first. GPT tiers: astra > sol > (none) > terra > luna > mini > nano.
function Get-GptRank([string]$Id) {
  $version = 0
  if ($Id -match '^gpt-(\d+)(?:[.-](\d+))?') {
    $version = [int]$Matches[1] * 100
    if ($Matches[2]) { $version += [int]$Matches[2] }
  }
  $tier = 3
  foreach ($pair in @(@('astra', 6), @('sol', 5), @('terra', 2), @('luna', 1), @('mini', 0), @('nano', -1))) {
    if ($Id -match "(^|[-.])$($pair[0])($|[-.])") { $tier = $pair[1]; break }
  }
  return $version * 10 + $tier
}

function Get-ClaudeVersion([string]$Id) {
  if ($Id -match '^claude-[a-z]+-(\d+)(?:-(\d+))?(?:-|$)') {
    $v = [int]$Matches[1] * 100
    if ($Matches[2] -and $Matches[2].Length -le 2) { $v += [int]$Matches[2] }
    return $v
  }
  if ($Id -match '^claude-(\d+)(?:-(\d+))?-') { return [int]$Matches[1] * 100 + [int]("0" + $Matches[2]) }
  return 0
}

function Get-ClaudeBest([string[]]$Ids, [string]$Family) {
  $matching = @($Ids | Where-Object { $_ -match "(^|-)$Family(-|$)" } | Sort-Object { Get-ClaudeVersion $_ } -Descending)
  if ($matching.Count -gt 0) { return $matching[0] }
  return $null
}

function Get-FirstOf([object[]]$Values) {
  foreach ($v in $Values) { if ($v) { return $v } }
  return $null
}

# ---------------------------------------------------------------- tools

function Find-Codex {
  $apps = @(Get-Command codex -All -CommandType Application -ErrorAction SilentlyContinue)
  if ($apps.Count -gt 0) { return $apps[0].Source }
  $bundled = @(Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin\*\codex.exe') -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending)
  if ($bundled.Count -gt 0) { return $bundled[0].FullName }
  return $null
}

function Find-Claude {
  $apps = @(Get-Command claude -All -CommandType Application -ErrorAction SilentlyContinue)
  if ($apps.Count -gt 0) { return $apps[0].Source }
  $local = Join-Path $HOME '.local\bin\claude.exe'
  if (Test-Path -LiteralPath $local) { return $local }
  return $null
}

function Find-OpenCode {
  $apps = @(Get-Command opencode -All -CommandType Application -ErrorAction SilentlyContinue)
  if ($apps.Count -gt 0) { return $apps[0].Source }
  foreach ($candidate in @(
      (Join-Path $env:LOCALAPPDATA 'Programs\@opencode-aidesktop\OpenCode.exe'),
      (Join-Path $env:LOCALAPPDATA 'Programs\OpenCode\OpenCode.exe'),
      (Join-Path $HOME '.opencode\bin\opencode.exe'))) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  return $null
}

# The file OpenCode reads: opencode.json, or the .jsonc variant already in use.
function Get-OpenCodeConfig {
  $json = Join-Path $OpenCodeDir 'opencode.json'
  $jsonc = Join-Path $OpenCodeDir 'opencode.jsonc'
  if (-not (Test-Path -LiteralPath $json) -and (Test-Path -LiteralPath $jsonc)) { return $jsonc }
  return $json
}

# JSON with comments and trailing commas, as OpenCode allows, read as JSON.
# Comments do not survive the rewrite; the backup keeps the original.
function Read-JsoncFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return @{ Value = [pscustomobject]@{}; HadComments = $false } }
  return ConvertFrom-Jsonc ([IO.File]::ReadAllText($Path)) $Path
}

function ConvertFrom-Jsonc([string]$Raw, [string]$Path) {
  $raw = $Raw
  if ($raw.Length -gt 0 -and $raw[0] -eq [char]0xFEFF) { $raw = $raw.Substring(1) }
  $sb = New-Object System.Text.StringBuilder
  $inString = $false; $escaped = $false; $i = 0; $hadComments = $false
  while ($i -lt $raw.Length) {
    $ch = $raw[$i]
    if ($inString) {
      [void]$sb.Append($ch)
      if ($escaped) { $escaped = $false } elseif ($ch -eq '\') { $escaped = $true } elseif ($ch -eq '"') { $inString = $false }
      $i++; continue
    }
    if ($ch -eq '"') { $inString = $true; [void]$sb.Append($ch); $i++; continue }
    if ($ch -eq '/' -and $i + 1 -lt $raw.Length -and $raw[$i + 1] -eq '/') {
      $hadComments = $true
      while ($i -lt $raw.Length -and $raw[$i] -ne "`n") { $i++ }
      continue
    }
    if ($ch -eq '/' -and $i + 1 -lt $raw.Length -and $raw[$i + 1] -eq '*') {
      $hadComments = $true
      $end = $raw.IndexOf('*/', $i + 2)
      $i = if ($end -lt 0) { $raw.Length } else { $end + 2 }
      continue
    }
    [void]$sb.Append($ch); $i++
  }
  $clean = [regex]::Replace($sb.ToString(), ',(\s*[\]}])', '$1')
  if ($clean.Trim() -eq '') { return @{ Value = [pscustomobject]@{}; HadComments = $hadComments } }
  $parsed = $clean | ConvertFrom-Json
  if ($parsed -isnot [pscustomobject]) { Fail "$Path does not contain a JSON object." }
  return @{ Value = $parsed; HadComments = $hadComments }
}

# Codex's own built-in catalog, read from a clean home so the user's current
# catalog (which may already be this installer's) is never the template.
function Get-BundledCatalog([string]$Codex) {
  $temp = Join-Path ([IO.Path]::GetTempPath()) ('sitegen-codex-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $temp -Force | Out-Null
  try {
    $r = Invoke-Native $Codex @('debug', 'models') @{ CODEX_HOME = $temp }
    if ($r.Code -ne 0 -or -not $r.Output) { return $null }
    $start = $r.Output.IndexOf('{')
    if ($start -lt 0) { return $null }
    return ($r.Output.Substring($start) | ConvertFrom-Json)
  } catch { return $null }
  finally { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
}

# One catalog entry per sitegen GPT model, cloned from the closest built-in
# model so Codex keeps its own instructions, then limited to what sitegen's
# Responses endpoint serves: plain function tools, text input, no hosted
# search, no priority tier, no "responses lite" or code-mode tool surfaces.
function New-CodexCatalog($Bundled, [string[]]$Ids) {
  $models = @($Bundled.models)
  $listed = @($models | Where-Object { (Get-Prop $_ 'visibility') -eq 'list' } | Sort-Object { [int](Get-Prop $_ 'priority') })
  $fallback = if ($listed.Count -gt 0) { $listed[0] } else { $models[0] }
  $levels = @((Get-Prop $fallback 'supported_reasoning_levels') | Where-Object { (Get-Prop $_ 'effort') -ne 'ultra' })
  $effortNames = @($levels | ForEach-Object { Get-Prop $_ 'effort' })
  $entries = @()
  $priority = 1
  foreach ($id in $Ids) {
    $norm = $id.Replace('.', '-')
    $template = $models | Where-Object { ([string](Get-Prop $_ 'slug')).Replace('.', '-') -eq $norm } | Select-Object -First 1
    if ($null -eq $template) { $template = $fallback }
    $e = $template | ConvertTo-Json -Depth 100 | ConvertFrom-Json
    Set-Prop $e 'slug' $id
    Set-Prop $e 'display_name' $id
    Set-Prop $e 'description' "$id through sitegen"
    Set-Prop $e 'visibility' 'list'
    Set-Prop $e 'supported_in_api' $true
    Set-Prop $e 'priority' $priority
    Set-Prop $e 'apply_patch_tool_type' $null
    Set-Prop $e 'supports_search_tool' $false
    Set-Prop $e 'use_responses_lite' $false
    Set-Prop $e 'input_modalities' @('text')
    Set-Prop $e 'service_tiers' @()
    Set-Prop $e 'additional_speed_tiers' @()
    Set-Prop $e 'availability_nux' $null
    Set-Prop $e 'upgrade' $null
    Set-Prop $e 'supported_reasoning_levels' $levels
    if ($effortNames -notcontains (Get-Prop $e 'default_reasoning_level')) { Set-Prop $e 'default_reasoning_level' 'medium' }
    foreach ($name in @('tool_mode', 'multi_agent_version', 'multi_agent_reasoning_effort')) { Remove-Prop $e $name }
    $entries += $e
    $priority++
  }
  return [pscustomobject]@{ models = $entries }
}

# ---------------------------------------------------------------- config.toml

function Split-Lines([string]$Text) {
  if ([string]::IsNullOrEmpty($Text)) { return @() }
  $lines = [regex]::Split($Text, '\r?\n')
  if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') { $lines = $lines[0..($lines.Count - 2)] }
  return @($lines)
}

function Test-TableHeader([string]$Line) {
  return $Line -match '^\s*\[\[?\s*[A-Za-z0-9_\-."'']+(\s*\.\s*[A-Za-z0-9_\-."'']+)*\s*\]\]?\s*(#.*)?$'
}

# Removes everything a previous install added and re-enables what it disabled.
# -Fallback (uninstall only) also drops a sitegen provider table or pointer that
# lost its markers, e.g. in a config another tool rewrote.
function Remove-SitegenToml([string[]]$Lines, [switch]$Fallback) {
  $out = New-Object System.Collections.Generic.List[string]
  $skip = $false
  $inProvider = $false
  foreach ($line in $Lines) {
    if ($line.StartsWith($BlockStart)) { $skip = $true; continue }
    if ($skip) { if ($line.StartsWith($BlockEnd)) { $skip = $false }; continue }
    if ($line.TrimEnd().EndsWith($ManagedTag)) { continue }
    if ($line.StartsWith($DisabledPrefix)) { $out.Add($line.Substring($DisabledPrefix.Length)); continue }
    # Fallback for a config rewritten by another tool that dropped the markers:
    # the sitegen provider table and a top-level pointer to it still go.
    if (-not $Fallback) { $out.Add($line); continue }
    if (Test-TableHeader $line) { $inProvider = $line -match "^\s*\[\s*model_providers\s*\.\s*[""']?$ProviderId[""']?\s*[\].]" }
    if ($inProvider) { continue }
    if ($line -match "^\s*model_provider\s*=\s*[""']$ProviderId[""']\s*(#.*)?$") { continue }
    $out.Add($line)
  }
  while ($out.Count -gt 0 -and $out[$out.Count - 1].Trim() -eq '') { $out.RemoveAt($out.Count - 1) }
  return ,$out.ToArray()
}

function Add-SitegenToml([string[]]$Lines, [string]$Model, [string]$AuthCommand, [string[]]$AuthArgs) {
  $out = New-Object System.Collections.Generic.List[string]
  $out.Add("$BlockStart (added by the sitegen installer; remove with its uninstall command)")
  $out.Add("model_provider = $(ConvertTo-TomlString $ProviderId)")
  $out.Add("model = $(ConvertTo-TomlString $Model)")
  $out.Add("model_catalog_json = $(ConvertTo-TomlString $CodexCatalog)")
  $out.Add('web_search = "disabled"')
  $out.Add($BlockEnd)

  $section = 'top'
  $sawFeatures = $false
  $featureKeys = '^\s*(' + ($DisabledFeatures -join '|') + ')\s*='
  $topKeys = '^\s*(' + ($TopLevelKeys -join '|') + ')\s*='
  foreach ($line in $Lines) {
    if (Test-TableHeader $line) {
      if ($line -match "^\s*\[\s*model_providers\s*\.\s*[""']?$ProviderId[""']?\s*[\].]") { $section = 'provider' }
      elseif ($line -match '^\s*\[\s*features\s*\]') { $section = 'features' }
      else { $section = 'other' }
      if ($section -eq 'provider') { $out.Add($DisabledPrefix + $line); continue }
      $out.Add($line)
      if ($section -eq 'features') {
        $sawFeatures = $true
        foreach ($f in $DisabledFeatures) { $out.Add("$f = false $ManagedTag") }
      }
      continue
    }
    $isBlank = $line.Trim() -eq ''
    if ($section -eq 'provider' -and -not $isBlank) { $out.Add($DisabledPrefix + $line); continue }
    if ($section -eq 'top' -and $line -match $topKeys) { $out.Add($DisabledPrefix + $line); continue }
    if ($section -eq 'features' -and $line -match $featureKeys) { $out.Add($DisabledPrefix + $line); continue }
    $out.Add($line)
  }

  $tail = New-Object System.Collections.Generic.List[string]
  if (-not $sawFeatures) {
    $tail.Add("$BlockStart features")
    $tail.Add('[features]')
    foreach ($f in $DisabledFeatures) { $tail.Add("$f = false") }
    $tail.Add($BlockEnd)
  }
  $tail.Add("$BlockStart provider")
  $tail.Add("[model_providers.$ProviderId]")
  $tail.Add('name = "sitegen"')
  $tail.Add("base_url = $(ConvertTo-TomlString "$BaseUrl/v1")")
  $tail.Add('wire_api = "responses"')
  $tail.Add('')
  $tail.Add("[model_providers.$ProviderId.auth]")
  $tail.Add("command = $(ConvertTo-TomlString $AuthCommand)")
  $tail.Add('args = [' + (($AuthArgs | ForEach-Object { ConvertTo-TomlString $_ }) -join ', ') + ']')
  $tail.Add('timeout_ms = 15000')
  $tail.Add('refresh_interval_ms = 3600000')
  $tail.Add($BlockEnd)

  if ($out.Count -gt 0 -and $out[$out.Count - 1].Trim() -ne '') { $out.Add('') }
  foreach ($line in $tail) { $out.Add($line) }
  return ,$out.ToArray()
}

function Read-TomlLines {
  if (-not (Test-Path -LiteralPath $CodexConfig)) { return @{ Lines = @(); Newline = "`n" } }
  $raw = [IO.File]::ReadAllText($CodexConfig)
  if ($raw.Length -gt 0 -and $raw[0] -eq [char]0xFEFF) { $raw = $raw.Substring(1) }
  $newline = if ($raw.Contains("`r`n")) { "`r`n" } else { "`n" }
  return @{ Lines = (Split-Lines $raw); Newline = $newline }
}

function Write-TomlLines([string[]]$Lines, [string]$Newline) {
  Write-Utf8 $CodexConfig (($Lines -join $Newline) + $Newline)
}

# ---------------------------------------------------------------- state

function Read-State {
  if (-not (Test-Path -LiteralPath $StateFile)) { return $null }
  try { return (Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json) } catch { return $null }
}

function Read-JsonFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return [pscustomobject]@{} }
  $raw = [IO.File]::ReadAllText($Path)
  if ($raw.Trim() -eq '') { return [pscustomobject]@{} }
  $parsed = $raw | ConvertFrom-Json
  if ($parsed -isnot [pscustomobject]) { Fail "$Path does not contain a JSON object." }
  return $parsed
}

# Windows PowerShell indents JSON erratically; re-indent compact output with
# two spaces so settings files stay readable. Strings are copied verbatim.
function Format-Json([string]$Compact) {
  $sb = New-Object System.Text.StringBuilder
  $depth = 0; $inString = $false; $escaped = $false
  foreach ($ch in $Compact.ToCharArray()) {
    if ($inString) {
      [void]$sb.Append($ch)
      if ($escaped) { $escaped = $false } elseif ($ch -eq '\') { $escaped = $true } elseif ($ch -eq '"') { $inString = $false }
      continue
    }
    switch ($ch) {
      '"' { $inString = $true; [void]$sb.Append($ch) }
      { $_ -eq '{' -or $_ -eq '[' } { $depth++; [void]$sb.Append($ch).Append("`n").Append('  ' * $depth) }
      { $_ -eq '}' -or $_ -eq ']' } { $depth--; [void]$sb.Append("`n").Append('  ' * $depth).Append($ch) }
      ',' { [void]$sb.Append(",`n").Append('  ' * $depth) }
      ':' { [void]$sb.Append(': ') }
      default { if (-not [char]::IsWhiteSpace($ch)) { [void]$sb.Append($ch) } }
    }
  }
  # Empty containers print as {} and [] rather than split across lines.
  return [regex]::Replace($sb.ToString(), '([\[{])\n\s*([\]}])', '$1$2')
}

function Write-JsonFile([string]$Path, $Value, [switch]$Compact) {
  $json = $Value | ConvertTo-Json -Depth 100 -Compress
  if (-not $Compact) { $json = Format-Json $json }
  Write-Utf8 $Path ($json + "`n")
}

# ---------------------------------------------------------------- install

function Install-Codex([string]$Codex, [string[]]$GptIds, [string]$Model, [string]$BackupDir) {
  $bundled = Get-BundledCatalog $Codex
  if ($null -eq $bundled -or @($bundled.models).Count -eq 0) {
    Warn 'Could not read Codex''s built-in model list. Update Codex (codex update) and run this again.'
    return $false
  }
  Write-JsonFile $CodexCatalog (New-CodexCatalog $bundled $GptIds) -Compact

  $toml = Read-TomlLines
  Backup-File $CodexConfig $BackupDir 'codex-config.toml'
  $clean = Remove-SitegenToml $toml.Lines
  $authArgs = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $HelperFile)
  $updated = Add-SitegenToml $clean $Model 'powershell.exe' $authArgs
  $existed = Test-Path -LiteralPath $CodexConfig
  Write-TomlLines $updated $toml.Newline

  # Codex itself is the judge of whether the edited config is valid.
  $check = Invoke-Native $Codex @('debug', 'models') @{ CODEX_HOME = $CodexHome }
  if ($check.Code -ne 0 -or $check.Output -notmatch [regex]::Escape('"slug":"' + $Model + '"')) {
    if ($existed) { Copy-Item -LiteralPath (Join-Path $BackupDir 'codex-config.toml') -Destination $CodexConfig -Force }
    else { Remove-Item -LiteralPath $CodexConfig -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $CodexCatalog -Force -ErrorAction SilentlyContinue
    Warn 'Codex did not accept the new settings, so your previous Codex config was put back.'
    Warn 'Update Codex (codex update) and run this again.'
    return $false
  }
  return $true
}

function Install-Claude([string[]]$ClaudeIds, [string]$Model, [hashtable]$Tiers, $State, [string]$BackupDir) {
  try { $settings = Read-JsonFile $ClaudeSettings }
  catch { Warn "$ClaudeSettings is not valid JSON, so Claude Code was left unchanged. Fix or remove it and run this again."; return $null }
  Backup-File $ClaudeSettings $BackupDir 'claude-settings.json'

  $envBlock = Get-Prop $settings 'env'
  if ($envBlock -isnot [pscustomobject]) { $envBlock = [pscustomobject]@{} }

  # The values from before the FIRST install are what uninstall restores, so a
  # re-install keeps the originals instead of recording its own values.
  $previous = Get-Prop (Get-Prop $State 'claude') 'previous'
  if ($null -eq $previous) {
    $prevEnv = [ordered]@{}
    foreach ($k in $ClaudeEnvKeys) { $prevEnv[$k] = Get-Prop $envBlock $k }
    $previous = [pscustomobject]@{
      apiKeyHelper = Get-Prop $settings 'apiKeyHelper'
      model = Get-Prop $settings 'model'
      env = [pscustomobject]$prevEnv
      hadEnv = ($null -ne $settings.PSObject.Properties['env'])
      fileExisted = (Test-Path -LiteralPath $ClaudeSettings)
    }
  }

  $helper = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $HelperFile + '"'
  $applied = [ordered]@{
    ANTHROPIC_BASE_URL = $BaseUrl
    ANTHROPIC_DEFAULT_OPUS_MODEL = $Tiers.opus
    ANTHROPIC_DEFAULT_SONNET_MODEL = $Tiers.sonnet
    ANTHROPIC_DEFAULT_HAIKU_MODEL = $Tiers.haiku
    ANTHROPIC_SMALL_FAST_MODEL = $Tiers.haiku
  }
  foreach ($k in $applied.Keys) { Set-Prop $envBlock $k $applied[$k] }
  # A token or pinned model left in the settings would override the helper.
  foreach ($k in @('ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL')) { Remove-Prop $envBlock $k }
  Set-Prop $settings 'env' $envBlock
  Set-Prop $settings 'apiKeyHelper' $helper
  Set-Prop $settings 'model' $Model
  Write-JsonFile $ClaudeSettings $settings

  return [pscustomobject]@{
    settingsPath = $ClaudeSettings
    previous = $previous
    applied = [pscustomobject]@{ apiKeyHelper = $helper; model = $Model; env = [pscustomobject]$applied }
  }
}

# Canonical JSON text with keys sorted at every level, to compare two values
# regardless of key order.
function ConvertTo-SortedJson($Value) {
  function Sort-Value($v) {
    if ($v -is [pscustomobject]) {
      $o = [ordered]@{}
      foreach ($n in ($v.PSObject.Properties.Name | Sort-Object)) { $o[$n] = Sort-Value $v.$n }
      return [pscustomobject]$o
    }
    if ($v -is [array]) { return ,@($v | ForEach-Object { Sort-Value $_ }) }
    return $v
  }
  return ((Sort-Value $Value) | ConvertTo-Json -Depth 100 -Compress)
}

# The {file:...} reference OpenCode resolves itself, as an absolute path with
# forward slashes (the form verified with OpenCode on Windows).
function Get-OpenCodeKeyRef {
  return '{file:' + $PlainKeyFile.Replace('\', '/') + '}'
}

function Install-OpenCode([string[]]$Ids, [string]$Model, [string]$SmallModel, $State, [string]$BackupDir) {
  $path = Get-OpenCodeConfig
  try { $read = Read-JsoncFile $path }
  catch { Warn "$path could not be read as JSON, so OpenCode was left unchanged. Fix it and run this again."; return $null }
  $config = $read.Value
  Backup-File $path $BackupDir ('opencode-' + (Split-Path -Leaf $path))
  $providers = Get-Prop $config 'provider'
  if ($providers -isnot [pscustomobject]) { $providers = [pscustomobject]@{} }

  # As for Claude Code, the values from before the FIRST install are kept.
  $previous = Get-Prop (Get-Prop $State 'opencode') 'previous'
  if ($null -eq $previous) {
    $original = if (Test-Path -LiteralPath $path) { [IO.File]::ReadAllText($path) } else { $null }
    $previous = [pscustomobject]@{
      model = Get-Prop $config 'model'
      small_model = Get-Prop $config 'small_model'
      provider = Get-Prop $providers $ProviderId
      hadProviders = ($null -ne $config.PSObject.Properties['provider'])
      fileExisted = ($null -ne $original)
      original = $original
    }
  }

  $models = [ordered]@{}
  foreach ($id in $Ids) { $models[$id] = [pscustomobject]@{ name = $id } }
  $entry = [pscustomobject]@{
    npm = '@ai-sdk/openai-compatible'
    name = 'sitegen'
    options = [pscustomobject]@{ baseURL = "$BaseUrl/v1"; apiKey = (Get-OpenCodeKeyRef) }
    models = [pscustomobject]$models
  }
  if ($null -eq $config.PSObject.Properties['$schema']) { Set-Prop $config '$schema' 'https://opencode.ai/config.json' }
  Set-Prop $providers $ProviderId $entry
  Set-Prop $config 'provider' $providers
  Set-Prop $config 'model' "$ProviderId/$Model"
  Set-Prop $config 'small_model' "$ProviderId/$SmallModel"
  Write-JsonFile $path $config
  if ($read.HadComments) { Warn "Comments in $path are left out while sitegen is set up; undo puts the file back with them." }

  return [pscustomobject]@{
    config = $path
    previous = $previous
    applied = [pscustomobject]@{ model = "$ProviderId/$Model"; small_model = "$ProviderId/$SmallModel"; baseURL = "$BaseUrl/v1" }
  }
}

function Uninstall-OpenCode($OpenCodeState, [string]$BackupDir) {
  $path = [string](Get-Prop $OpenCodeState 'config')
  if (-not $path -or -not (Test-Path -LiteralPath $path)) { return }
  $read = Read-JsoncFile $path
  $config = $read.Value
  Backup-File $path $BackupDir ('opencode-' + (Split-Path -Leaf $path))
  $previous = Get-Prop $OpenCodeState 'previous'
  $applied = Get-Prop $OpenCodeState 'applied'
  foreach ($name in @('model', 'small_model')) {
    if ((Get-Prop $config $name) -eq (Get-Prop $applied $name)) {
      $old = Get-Prop $previous $name
      if ($null -eq $old) { Remove-Prop $config $name } else { Set-Prop $config $name $old }
    }
  }
  $providers = Get-Prop $config 'provider'
  if ($providers -is [pscustomobject]) {
    # Only the provider block this installer wrote is replaced.
    $current = Get-Prop $providers $ProviderId
    if ($null -ne $current -and (Get-Prop (Get-Prop $current 'options') 'baseURL') -eq (Get-Prop $applied 'baseURL')) {
      $old = Get-Prop $previous 'provider'
      if ($null -eq $old) { Remove-Prop $providers $ProviderId } else { Set-Prop $providers $ProviderId $old }
    }
    if (@($providers.PSObject.Properties).Count -eq 0 -and -not (Get-Prop $previous 'hadProviders')) { Remove-Prop $config 'provider' }
  }
  $left = @($config.PSObject.Properties | Where-Object { $_.Name -ne '$schema' })
  $original = Get-Prop $previous 'original'
  if ((Get-Prop $previous 'fileExisted') -eq $false -and $left.Count -eq 0) { Remove-Item -LiteralPath $path -Force }
  elseif ($null -ne $original -and (ConvertTo-SortedJson (ConvertFrom-Jsonc $original $path).Value) -eq (ConvertTo-SortedJson $config)) {
    # Nothing else changed since, so the file goes back byte for byte, comments and all.
    Write-Utf8 $path $original
  }
  else { Write-JsonFile $path $config }
}

function Test-Route([string]$Key, [string]$Kind, [string]$Model) {
  if ($Kind -eq 'opencode') {
    $r = Invoke-Sitegen 'POST' '/v1/chat/completions' $Key @{ model = $Model; max_tokens = 32; messages = @(@{ role = 'user'; content = 'Reply with the single word OK.' }) }
    if ($r.Status -eq 200) { return $null }
    return "HTTP $($r.Status): $(Get-ErrorMessage $r.Text)"
  }
  if ($Kind -eq 'codex') {
    $r = Invoke-Sitegen 'POST' '/v1/responses' $Key @{ model = $Model; input = 'Reply with the single word OK.'; max_output_tokens = 32 }
  } else {
    $r = Invoke-Sitegen 'POST' '/v1/messages' $Key @{ model = $Model; max_tokens = 32; messages = @(@{ role = 'user'; content = 'Reply with the single word OK.' }) } @{ 'anthropic-version' = '2023-06-01' }
  }
  if ($r.Status -eq 200) { return $null }
  return "HTTP $($r.Status): $(Get-ErrorMessage $r.Text)"
}

# SITEGEN_TOOLS as a set of tool ids; unset, 'all' or 'both' means every tool.
function Get-ToolsFilter {
  $raw = if ($env:SITEGEN_TOOLS) { $env:SITEGEN_TOOLS.ToLowerInvariant() } else { 'all' }
  $every = $raw -match 'all|both'
  $filter = @{ explicit = [bool]$env:SITEGEN_TOOLS }
  foreach ($id in $ToolNames.Keys) { $filter[$id] = $every -or $raw -match $id }
  if (-not ($ToolNames.Keys | Where-Object { $filter[$_] })) {
    Fail "SITEGEN_TOOLS must name codex, claude or opencode, or be all (it is '$env:SITEGEN_TOOLS')."
  }
  return $filter
}

# Which of the available tools to set up. The ones left out are not touched.
function Select-Tools([hashtable]$Can) {
  $filter = Get-ToolsFilter
  $available = @($ToolNames.Keys | Where-Object { $Can[$_] })
  $pick = @{}
  foreach ($id in $ToolNames.Keys) { $pick[$id] = [bool]$Can[$id] -and $filter[$id] }
  if ($filter.explicit -or $available.Count -lt 2 -or -not (Test-Interactive)) { return $pick }
  Say ''
  Say '  What should sitegen set up? Tools you leave out stay exactly as they are.'
  Say ('     1. All of them: ' + (($available | ForEach-Object { $ToolNames[$_] }) -join ', ') + '  (recommended)')
  for ($i = 0; $i -lt $available.Count; $i++) { Say ('     {0}. {1}' -f ($i + 2), $ToolNames[$available[$i]]) }
  while ($true) {
    $answer = (Read-Host '  Press Enter for 1, or type one number or several (for example 2,3)').Trim()
    $numbers = @($answer -split '[,\s]+' | Where-Object { $_ -ne '' })
    if ($numbers.Count -eq 0 -or $numbers -contains '1') {
      foreach ($id in $available) { $pick[$id] = $true }
      return $pick
    }
    $valid = @($numbers | Where-Object { $_ -match '^\d+$' -and [int]$_ -ge 2 -and [int]$_ -le $available.Count + 1 })
    if ($valid.Count -eq $numbers.Count) {
      foreach ($id in $ToolNames.Keys) { $pick[$id] = $false }
      foreach ($n in $valid) { $pick[$available[[int]$n - 2]] = $true }
      return $pick
    }
    Warn "Type numbers from 1 to $($available.Count + 1)."
  }
}

# A saved copy of this script and a Start menu shortcut that runs its undo, so
# reverting needs neither the network nor a command.
function Install-UndoShortcut {
  $command = "irm $BaseUrl/uninstall.ps1 | iex"
  if ($SelfText -and $SelfText.Trim()) {
    Write-Utf8 $LocalCopy ("# sitegen setup, saved by the installer for the Undo sitegen setup shortcut.`r`n& {`r`n" + $SelfText + "`r`n}`r`n")
    $command = "`$env:SITEGEN_ACTION = 'uninstall'; & '$($LocalCopy.Replace("'", "''"))'"
  }
  if ($env:SITEGEN_NO_SHORTCUT) { return $null }
  try {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($UndoShortcut)
    $link.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $link.Arguments = '-NoProfile -ExecutionPolicy Bypass -Command "' + $command + "; Read-Host 'Press Enter to close'" + '"'
    $link.Description = 'Put Codex and Claude Code back to how they were before sitegen setup'
    $link.Save()
    return $UndoShortcut
  } catch { return $null }
}

function Remove-UndoShortcut {
  foreach ($path in @($UndoShortcut, $LocalCopy)) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
  }
}

function Invoke-Install {
  Say ''
  Write-Host 'sitegen setup for Codex, Claude Code and OpenCode' -ForegroundColor White
  Say "Server: $BaseUrl"

  Step '1. Your sitegen API key'
  $key = Read-ApiKey
  $models = Invoke-Sitegen 'GET' '/v1/models' $key
  if ($models.Status -eq 401) { Fail 'sitegen did not accept that key. Check that you copied all of it, or create a new one.' }
  if ($models.Status -eq 403) { Fail 'That key cannot chat. Create a key with the chat permission and run this again.' }
  if ($models.Status -ne 200) { Fail "Could not reach sitegen ($($models.Status)): $(Get-ErrorMessage $models.Text)" }
  $ids = @((($models.Text | ConvertFrom-Json).data) | ForEach-Object { [string]$_.id } | Where-Object { $_ })
  $gpt = @($ids | Where-Object { $_ -match '^(gpt-|o\d|codex-)' } | Sort-Object @{ Expression = { Get-GptRank $_ }; Descending = $true }, @{ Expression = { $_ } })
  $claude = @($ids | Where-Object { $_ -match '^claude-' } | Sort-Object @{ Expression = { Get-ClaudeVersion $_ }; Descending = $true }, @{ Expression = { $_ } })
  # OpenCode speaks the chat completions format, which serves every family.
  $others = @($ids | Where-Object { $gpt -notcontains $_ -and $claude -notcontains $_ } | Sort-Object)
  $everything = @($claude) + @($gpt) + @($others)
  Ok "Key accepted: $($ids.Count) models ($($gpt.Count) GPT, $($claude.Count) Claude)."

  Step '2. Looking for Codex, Claude Code and OpenCode'
  $codex = Find-Codex
  $claudeExe = Find-Claude
  $openCodeExe = Find-OpenCode
  $openCodeFound = [bool]$openCodeExe -or (Test-Path -LiteralPath $OpenCodeDir)
  if ($codex) { Ok "Codex found: $codex" } else { Warn 'Codex was not found. Install it first (npm i -g @openai/codex, or the Codex app), then run this again to set it up.' }
  if ($claudeExe) { Ok "Claude Code found: $claudeExe" } else { Warn 'Claude Code was not found. Its settings will still be written, ready for when you install it (irm https://claude.ai/install.ps1 | iex).' }
  if ($openCodeExe) { Ok "OpenCode found: $openCodeExe" } elseif ($openCodeFound) { Ok "OpenCode settings found: $OpenCodeDir" } else { Warn 'OpenCode was not found (https://opencode.ai). Install it and run this again to set it up too.' }
  if ($codex -and $gpt.Count -eq 0) { Warn 'Your plan has no GPT models, so Codex was left unchanged.' }
  if ($claude.Count -eq 0) { Warn 'Your plan has no Claude models, so Claude Code was left unchanged.' }
  # Named explicitly, OpenCode is set up even before it is installed.
  $openCodeWanted = $openCodeFound -or ($env:SITEGEN_TOOLS -and $env:SITEGEN_TOOLS.ToLowerInvariant() -match 'opencode')
  $tools = Select-Tools @{ codex = ([bool]$codex -and $gpt.Count -gt 0); claude = ($claude.Count -gt 0); opencode = ($openCodeWanted -and $ids.Count -gt 0) }
  $doCodex = $tools.codex
  $doClaude = $tools.claude
  $doOpenCode = $tools.opencode
  if (-not $doCodex -and -not $doClaude -and -not $doOpenCode) { Fail 'Nothing to set up.' }

  $codexModel = $null; $claudeModel = $null; $tiers = $null; $openCodeModel = $null; $openCodeSmall = $null
  if ($doCodex) { $codexModel = Select-Model 'Default model for Codex (you can switch any time with /model):' $gpt $gpt[0] $env:SITEGEN_CODEX_MODEL }
  if ($doClaude) {
    $opus = Get-FirstOf @((Get-ClaudeBest $claude 'opus'), (Get-ClaudeBest $claude 'fable'), (Get-ClaudeBest $claude 'sonnet'), $claude[0])
    $sonnet = Get-FirstOf @((Get-ClaudeBest $claude 'sonnet'), $opus)
    $haiku = Get-FirstOf @((Get-ClaudeBest $claude 'haiku'), $sonnet)
    $tiers = @{ opus = $opus; sonnet = $sonnet; haiku = $haiku }
    $claudeModel = Select-Model 'Default model for Claude Code (you can switch any time with /model):' $claude $opus $env:SITEGEN_CLAUDE_MODEL
  }
  if ($doOpenCode) {
    $best = Get-FirstOf @((Get-ClaudeBest $claude 'opus'), (Get-ClaudeBest $claude 'sonnet'), $gpt[0], $everything[0])
    $openCodeModel = Select-Model 'Default model for OpenCode (you can switch any time with /models):' $everything $best $env:SITEGEN_OPENCODE_MODEL
    # Session titles and summaries go to a small, cheap model.
    $openCodeSmall = Get-FirstOf @((Get-ClaudeBest $claude 'haiku'), ($gpt | Where-Object { $_ -match 'mini|nano|luna' } | Select-Object -First 1), $openCodeModel)
  }

  Step '3. Saving your key securely'
  New-Item -ItemType Directory -Path $SitegenDir -Force | Out-Null
  $encrypted = ConvertFrom-SecureString -SecureString (ConvertTo-SecureString -String $key -AsPlainText -Force)
  Write-Utf8 $KeyFile $encrypted
  Restrict-ToCurrentUser $KeyFile
  $helperText = @"
# sitegen: prints your API key for Codex and Claude Code. Written by the sitegen
# installer; the key is decrypted with your Windows account (DPAPI).
`$ErrorActionPreference = 'Stop'
`$data = [IO.File]::ReadAllText('$($KeyFile.Replace("'", "''"))').Trim()
`$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR((ConvertTo-SecureString -String `$data))
try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR(`$ptr)) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR(`$ptr) }
"@
  Write-Utf8 $HelperFile $helperText
  $probe = Invoke-Native 'powershell.exe' @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $HelperFile)
  if ($probe.Output.Trim() -ne $key) { Fail 'The key helper could not read the saved key back. Nothing else was changed.' }
  Ok "Key encrypted for your Windows account in $SitegenDir"
  if ($doOpenCode) {
    Write-Utf8 $PlainKeyFile $key
    Restrict-ToCurrentUser $PlainKeyFile
    Ok 'OpenCode reads the key from a copy in the same folder that only your Windows account can open.'
  }

  $state = Read-State
  $backupDir = New-BackupDir
  # A tool left out this time keeps what an earlier run recorded, so undo can
  # still put it back.
  $newState = [ordered]@{
    version = $InstallerVersion; baseUrl = $BaseUrl; installedAt = (Get-Date).ToString('o')
    codex = $(if ($doCodex) { $null } else { Get-Prop $state 'codex' })
    claude = $(if ($doClaude) { $null } else { Get-Prop $state 'claude' })
    opencode = $(if ($doOpenCode) { $null } else { Get-Prop $state 'opencode' })
  }

  Step '4. Setting up the apps'
  if ($doCodex) {
    if (Install-Codex $codex $gpt $codexModel $backupDir) {
      $newState.codex = [pscustomobject]@{ home = $CodexHome; config = $CodexConfig; catalog = $CodexCatalog; model = $codexModel }
      Ok "Codex now uses sitegen ($codexModel by default, $($gpt.Count) models in its picker)."
    }
  }
  if ($doClaude) {
    $result = Install-Claude $claude $claudeModel $tiers $state $backupDir
    if ($null -ne $result) {
      $newState.claude = $result
      Ok "Claude Code now uses sitegen ($claudeModel by default; opus=$($tiers.opus), sonnet=$($tiers.sonnet), haiku=$($tiers.haiku))."
    }
  }
  if ($doOpenCode) {
    $result = Install-OpenCode $everything $openCodeModel $openCodeSmall $state $backupDir
    if ($null -ne $result) {
      $newState.opencode = $result
      Ok "OpenCode now uses sitegen ($openCodeModel by default, $($everything.Count) models under the sitegen provider)."
    }
  }
  Write-JsonFile $StateFile ([pscustomobject]$newState)
  Restrict-ToCurrentUser $StateFile
  Say "  Backups of your previous settings: $backupDir"

  $shortcut = Install-UndoShortcut

  if (-not $env:SITEGEN_SKIP_TEST) {
    Step '5. Sending one short test message'
    if ($doCodex -and $newState.codex) {
      $err = Test-Route $key 'codex' $codexModel
      if ($err) { Warn "Codex route test failed: $err" } else { Ok "Codex route answered ($codexModel)." }
    }
    if ($doClaude -and $newState.claude) {
      $err = Test-Route $key 'claude' $claudeModel
      if ($err) { Warn "Claude Code route test failed: $err" } else { Ok "Claude Code route answered ($claudeModel)." }
    }
    if ($doOpenCode -and $newState.opencode) {
      $err = Test-Route $key 'opencode' $openCodeModel
      if ($err) { Warn "OpenCode route test failed: $err" } else { Ok "OpenCode route answered ($openCodeModel)." }
    }
  }

  foreach ($name in @('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL')) {
    foreach ($scope in @('User', 'Machine')) {
      if ([Environment]::GetEnvironmentVariable($name, $scope)) {
        Warn "$name is set in your Windows $scope environment and may override these settings. Remove it if Claude Code does not use sitegen."
      }
    }
  }

  Say ''
  Write-Host 'Done.' -ForegroundColor Green
  if ($doCodex -and $newState.codex) { Say '  Codex:        restart the Codex app if it is open, or run: codex' }
  elseif ($newState.codex) { Say '  Codex:        not changed this time (still on sitegen from an earlier setup)' }
  else { Say '  Codex:        not changed' }
  if ($doClaude -and $newState.claude) { Say '  Claude Code:  open a new terminal and run: claude  (IDE extensions pick it up on restart)' }
  elseif ($newState.claude) { Say '  Claude Code:  not changed this time (still on sitegen from an earlier setup)' }
  else { Say '  Claude Code:  not changed' }
  if ($doOpenCode -and $newState.opencode) { Say '  OpenCode:     restart the OpenCode app if it is open, or run: opencode' }
  elseif ($newState.opencode) { Say '  OpenCode:     not changed this time (still on sitegen from an earlier setup)' }
  else { Say '  OpenCode:     not changed' }
  Say ''
  Say '  To go back to your previous setup:'
  if ($shortcut) { Say '    press the Windows key, type "Undo sitegen", press Enter; or run' }
  Say ('    irm ' + $BaseUrl + '/uninstall.ps1 | iex')
}

# ---------------------------------------------------------------- uninstall

function Invoke-Uninstall {
  $filter = Get-ToolsFilter
  $names = @($ToolNames.Keys | Where-Object { $filter[$_] } | ForEach-Object { $ToolNames[$_] }) -join ', '
  Say ''
  Write-Host "Putting $names back to how they were before sitegen setup" -ForegroundColor White
  $state = Read-State
  $backupDir = New-BackupDir

  if ($filter.codex -and (Test-Path -LiteralPath $CodexConfig)) {
    $toml = Read-TomlLines
    $clean = Remove-SitegenToml $toml.Lines -Fallback
    if (($clean -join "`n") -ne ($toml.Lines -join "`n")) {
      Backup-File $CodexConfig $backupDir 'codex-config.toml'
      Write-TomlLines $clean $toml.Newline
      Ok 'Codex settings restored.'
    }
  }
  if ($filter.codex -and (Test-Path -LiteralPath $CodexCatalog)) { Remove-Item -LiteralPath $CodexCatalog -Force }

  $claudeState = Get-Prop $state 'claude'
  if ($filter.claude -and $null -ne $claudeState -and (Test-Path -LiteralPath $ClaudeSettings)) {
    try {
      $settings = Read-JsonFile $ClaudeSettings
      Backup-File $ClaudeSettings $backupDir 'claude-settings.json'
      $previous = Get-Prop $claudeState 'previous'
      $applied = Get-Prop $claudeState 'applied'
      # Only a value that is still what the installer set is put back; a value
      # changed since then is the user's and stays.
      foreach ($name in @('apiKeyHelper', 'model')) {
        if ((Get-Prop $settings $name) -eq (Get-Prop $applied $name)) {
          $old = Get-Prop $previous $name
          if ($null -eq $old) { Remove-Prop $settings $name } else { Set-Prop $settings $name $old }
        }
      }
      $envBlock = Get-Prop $settings 'env'
      if ($envBlock -is [pscustomobject]) {
        $appliedEnv = Get-Prop $applied 'env'
        $previousEnv = Get-Prop $previous 'env'
        foreach ($k in $ClaudeEnvKeys) {
          $was = Get-Prop $previousEnv $k
          $set = Get-Prop $appliedEnv $k
          $now = Get-Prop $envBlock $k
          if ($null -ne $set) {
            # Set by the installer: restore it unless the user changed it since.
            if ($now -ne $set) { continue }
            if ($null -eq $was) { Remove-Prop $envBlock $k } else { Set-Prop $envBlock $k $was }
          } elseif ($null -ne $was -and $null -eq $now) {
            # Removed by the installer (an old token or pinned model): put it back.
            Set-Prop $envBlock $k $was
          }
        }
        if (@($envBlock.PSObject.Properties).Count -eq 0 -and -not (Get-Prop $previous 'hadEnv')) { Remove-Prop $settings 'env' }
      }
      # A settings file the installer created, and that is empty again, goes too.
      if ((Get-Prop $previous 'fileExisted') -eq $false -and @($settings.PSObject.Properties).Count -eq 0) {
        Remove-Item -LiteralPath $ClaudeSettings -Force
      } else {
        Write-JsonFile $ClaudeSettings $settings
      }
      Ok 'Claude Code settings restored.'
    } catch { Warn "Could not restore $ClaudeSettings ($($_.Exception.Message)). Your backups are in $BackupRoot." }
  }

  $openCodeState = Get-Prop $state 'opencode'
  if ($filter.opencode -and $null -ne $openCodeState) {
    try {
      Uninstall-OpenCode $openCodeState $backupDir
      Ok 'OpenCode settings restored.'
    } catch { Warn "Could not restore OpenCode's settings ($($_.Exception.Message)). Your backups are in $BackupRoot." }
  }
  if ($filter.opencode -and (Test-Path -LiteralPath $PlainKeyFile)) { Remove-Item -LiteralPath $PlainKeyFile -Force }

  # The key stays while any tool still uses sitegen.
  $remaining = [ordered]@{ version = Get-Prop $state 'version'; baseUrl = Get-Prop $state 'baseUrl'; installedAt = Get-Prop $state 'installedAt' }
  $kept = @()
  foreach ($id in $ToolNames.Keys) {
    $remaining[$id] = if ($filter[$id]) { $null } else { Get-Prop $state $id }
    if ($null -ne $remaining[$id]) { $kept += $ToolNames[$id] }
  }
  if ($kept.Count -gt 0) {
    Write-JsonFile $StateFile ([pscustomobject]$remaining)
    Ok "Saved key kept: $($kept -join ', ') still use$(if ($kept.Count -eq 1) { 's' }) sitegen."
  } else {
    foreach ($path in @($KeyFile, $PlainKeyFile, $HelperFile, $StateFile)) {
      if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    }
    Remove-UndoShortcut
    Ok 'Saved key and the Undo shortcut removed.'
  }
  Say "  Backups are kept in $BackupRoot (safe to delete)."
  Write-Host 'Done. Restart Codex, OpenCode or any open Claude Code sessions.' -ForegroundColor Green
}

try {
  if ($BaseUrl.StartsWith('__')) { Fail 'Run this from your sitegen setup page, or set SITEGEN_BASE_URL.' }
  $uri = [uri]$BaseUrl
  if ($uri.Scheme -ne 'https' -and $uri.Host -notin @('localhost', '127.0.0.1')) { Fail 'The sitegen address must use https.' }
  if ($Action -eq 'uninstall') { Invoke-Uninstall } else { Invoke-Install }
} catch {
  Write-Host ''
  Write-Host "  X   $($_.Exception.Message)" -ForegroundColor Red
  Write-Host '      Nothing further was changed.' -ForegroundColor Red
} finally {
  if ($env:SITEGEN_ACTION) { Remove-Item Env:SITEGEN_ACTION -ErrorAction SilentlyContinue }
}
}
