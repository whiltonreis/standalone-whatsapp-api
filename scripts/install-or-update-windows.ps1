[CmdletBinding()]
param(
    [string]$ServiceName = "whatsapp-api",
    [string]$ApiHost = "127.0.0.1",
    [int]$ApiPort = 3015,
    [switch]$SkipGitPull,
    [switch]$AllowDirtyUpdate,
    [switch]$SkipNpmInstall,
    [string]$NssmPath = ""
)

$ErrorActionPreference = "Stop"

$script:ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:AppDir = Split-Path -Parent $script:ScriptDir
$script:EnvExampleFile = Join-Path $script:AppDir ".env.example"
$script:EnvFile = Join-Path $script:AppDir ".env"
$script:RuntimeDir = Join-Path $script:AppDir "runtime"
$script:RuntimeAuthDir = Join-Path $script:RuntimeDir "auth"
$script:RuntimeCacheDir = Join-Path $script:RuntimeDir "cache"
$script:RuntimeLogsDir = Join-Path $script:RuntimeDir "logs"
$script:BackupsRoot = Join-Path $script:AppDir "backups"
$script:Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$script:BackupDir = Join-Path $script:BackupsRoot $script:Timestamp

function Write-Log {
    param([string]$Message)

    Write-Host "[setup-windows] $Message"
}

function Fail {
    param([string]$Message)

    throw "[setup-windows] ERRO: $Message"
}

function Assert-Administrator {
    $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($currentIdentity)

    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
        Fail "Execute este script como Administrador."
    }
}

function Get-RequiredCommandPath {
    param([string]$CommandName)

    $command = Get-Command $CommandName -ErrorAction SilentlyContinue

    if (-not $command) {
        Fail "Comando '$CommandName' nao encontrado. Instale-o antes de continuar."
    }

    return $command.Source
}

function Get-NssmExecutable {
    if ($NssmPath) {
        return (Resolve-Path $NssmPath -ErrorAction Stop).Path
    }

    $command = Get-Command nssm.exe -ErrorAction SilentlyContinue
    if (-not $command) {
        return $null
    }

    return $command.Source
}

function New-ApiKey {
    $bytes = [byte[]]::new(24)
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    } finally {
        $rng.Dispose()
    }

    return -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

function Read-EnvLines {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        return [System.Collections.Generic.List[string]]::new()
    }

    return [System.Collections.Generic.List[string]]::new([string[]](Get-Content $Path))
}

function Get-EnvValue {
    param(
        [System.Collections.Generic.List[string]]$Lines,
        [string]$Key
    )

    $prefix = "$Key="
    foreach ($line in $Lines) {
        if ($line.StartsWith($prefix, [System.StringComparison]::Ordinal)) {
            return $line.Substring($prefix.Length)
        }
    }

    return ""
}

function Set-EnvValue {
    param(
        [System.Collections.Generic.List[string]]$Lines,
        [string]$Key,
        [string]$Value
    )

    $prefix = "$Key="

    for ($i = 0; $i -lt $Lines.Count; $i += 1) {
        if ($Lines[$i].StartsWith($prefix, [System.StringComparison]::Ordinal)) {
            $Lines[$i] = "$Key=$Value"
            return
        }
    }

    $Lines.Add("$Key=$Value")
}

function Save-EnvLines {
    param(
        [System.Collections.Generic.List[string]]$Lines,
        [string]$Path
    )

    Set-Content -Path $Path -Value $Lines -Encoding UTF8
}

function Ensure-Directory {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        New-Item -ItemType Directory -Path $Path | Out-Null
    }
}

function Ensure-RuntimeStructure {
    Write-Log "Preparando pastas de runtime..."
    Ensure-Directory $script:RuntimeDir
    Ensure-Directory $script:RuntimeAuthDir
    Ensure-Directory $script:RuntimeCacheDir
    Ensure-Directory $script:RuntimeLogsDir
}

function Backup-State {
    Write-Log "Gerando backup de seguranca em $script:BackupDir..."
    Ensure-Directory $script:BackupsRoot
    Ensure-Directory $script:BackupDir

    if (Test-Path $script:EnvFile) {
        Copy-Item $script:EnvFile (Join-Path $script:BackupDir ".env") -Force
    }

    if (Test-Path $script:RuntimeAuthDir) {
        Copy-Item $script:RuntimeAuthDir (Join-Path $script:BackupDir "auth") -Recurse -Force
    }

    $cacheFile = Join-Path $script:RuntimeCacheDir "numero_cache.json"
    if (Test-Path $cacheFile) {
        Copy-Item $cacheFile (Join-Path $script:BackupDir "numero_cache.json") -Force
    }
}

function Prepare-EnvFile {
    Write-Log "Preparando .env..."

    if (-not (Test-Path $script:EnvFile)) {
        if (-not (Test-Path $script:EnvExampleFile)) {
            Fail "Arquivo .env.example nao encontrado."
        }

        Copy-Item $script:EnvExampleFile $script:EnvFile -Force
    }

    $lines = Read-EnvLines $script:EnvFile

    $currentApiKey = Get-EnvValue -Lines $lines -Key "WHATSAPP_API_KEY"
    if (-not $currentApiKey -or $currentApiKey -eq "defina-uma-chave-forte-aqui") {
        Set-EnvValue -Lines $lines -Key "WHATSAPP_API_KEY" -Value (New-ApiKey)
    }

    if (-not (Get-EnvValue -Lines $lines -Key "WHATSAPP_API_HOST")) {
        Set-EnvValue -Lines $lines -Key "WHATSAPP_API_HOST" -Value $ApiHost
    }

    if (-not (Get-EnvValue -Lines $lines -Key "WHATSAPP_API_PORT")) {
        Set-EnvValue -Lines $lines -Key "WHATSAPP_API_PORT" -Value "$ApiPort"
    }

    if (-not (Get-EnvValue -Lines $lines -Key "WHATSAPP_AUTH_DIR")) {
        Set-EnvValue -Lines $lines -Key "WHATSAPP_AUTH_DIR" -Value "runtime/auth"
    }

    if (-not (Get-EnvValue -Lines $lines -Key "WHATSAPP_LOG_DIR")) {
        Set-EnvValue -Lines $lines -Key "WHATSAPP_LOG_DIR" -Value "runtime/logs"
    }

    if (-not (Get-EnvValue -Lines $lines -Key "WHATSAPP_NUMBER_CACHE_FILE")) {
        Set-EnvValue -Lines $lines -Key "WHATSAPP_NUMBER_CACHE_FILE" -Value "runtime/cache/numero_cache.json"
    }

    if (-not (Get-EnvValue -Lines $lines -Key "WHATSAPP_LOG_RETENTION_DAYS")) {
        Set-EnvValue -Lines $lines -Key "WHATSAPP_LOG_RETENTION_DAYS" -Value "15"
    }

    if (-not (Get-EnvValue -Lines $lines -Key "WHATSAPP_DEV_LOG_RETENTION_DAYS")) {
        Set-EnvValue -Lines $lines -Key "WHATSAPP_DEV_LOG_RETENTION_DAYS" -Value "7"
    }

    if (-not (Get-EnvValue -Lines $lines -Key "WHATSAPP_DISABLE_LOG_CLEANUP")) {
        Set-EnvValue -Lines $lines -Key "WHATSAPP_DISABLE_LOG_CLEANUP" -Value "false"
    }

    Save-EnvLines -Lines $lines -Path $script:EnvFile
}

function Assert-CleanGitWorktree {
    if (-not (Test-Path (Join-Path $script:AppDir ".git"))) {
        Write-Log "Pasta nao esta em um repositorio Git. Pulando git pull."
        return $false
    }

    $gitStatus = git -C $script:AppDir status --porcelain
    if ($gitStatus -and -not $AllowDirtyUpdate.IsPresent) {
        Fail "Repositorio com alteracoes locais. Use -AllowDirtyUpdate se quiser forcar."
    }

    return $true
}

function Update-CodeFromGit {
    if ($SkipGitPull.IsPresent) {
        Write-Log "Pulando etapa de git pull."
        return
    }

    if (-not (Assert-CleanGitWorktree)) {
        return
    }

    $remoteNames = git -C $script:AppDir remote
    if (-not $remoteNames) {
        Write-Log "Repositorio local sem remote configurado. Pulando git pull."
        return
    }

    Write-Log "Atualizando codigo via Git..."
    git -C $script:AppDir fetch --all --tags --prune | Out-Host
    git -C $script:AppDir pull --ff-only | Out-Host
}

function Install-Dependencies {
    if ($SkipNpmInstall.IsPresent) {
        Write-Log "Pulando npm install."
        return
    }

    Write-Log "Instalando/atualizando dependencias npm..."
    npm --prefix $script:AppDir install --omit=dev | Out-Host
}

function Validate-Application {
    Write-Log "Validando sintaxe da API..."
    npm --prefix $script:AppDir run check | Out-Host
}

function Get-ServiceInstance {
    Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
}

function Ensure-WindowsService {
    $service = Get-ServiceInstance
    $nodePath = Get-RequiredCommandPath "node"
    $nssmExe = Get-NssmExecutable

    if (-not $service) {
        if (-not $nssmExe) {
            Fail "Servico '$ServiceName' nao existe e o NSSM nao foi encontrado. Instale o NSSM ou informe -NssmPath."
        }

        Write-Log "Criando servico Windows '$ServiceName'..."
        & $nssmExe install $ServiceName $nodePath (Join-Path $script:AppDir "index.js") | Out-Null
        & $nssmExe set $ServiceName AppDirectory $script:AppDir | Out-Null
        & $nssmExe set $ServiceName AppStdout (Join-Path $script:RuntimeLogsDir "service-stdout.log") | Out-Null
        & $nssmExe set $ServiceName AppStderr (Join-Path $script:RuntimeLogsDir "service-stderr.log") | Out-Null
        & $nssmExe set $ServiceName Start SERVICE_AUTO_START | Out-Null
        $service = Get-ServiceInstance
    }

    if (-not $service) {
        Fail "Nao foi possivel criar ou localizar o servico '$ServiceName'."
    }

    return $service
}

function Restart-WindowsService {
    $service = Ensure-WindowsService

    if ($service.Status -eq "Running") {
        Write-Log "Reiniciando servico '$ServiceName'..."
        Restart-Service -Name $ServiceName -Force
    } else {
        Write-Log "Iniciando servico '$ServiceName'..."
        Start-Service -Name $ServiceName
    }
}

function Wait-ForHealthcheck {
    $lines = Read-EnvLines $script:EnvFile
    $port = Get-EnvValue -Lines $lines -Key "WHATSAPP_API_PORT"
    if (-not $port) {
        $port = "$ApiPort"
    }

    Write-Log "Aguardando a API responder na porta $port..."

    for ($i = 0; $i -lt 15; $i += 1) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/health" -TimeoutSec 4
            return $response.Content
        } catch {
            Start-Sleep -Seconds 2
        }
    }

    return $null
}

function Print-Summary {
    $lines = Read-EnvLines $script:EnvFile
    $apiKey = Get-EnvValue -Lines $lines -Key "WHATSAPP_API_KEY"
    $apiHost = Get-EnvValue -Lines $lines -Key "WHATSAPP_API_HOST"
    $apiPort = Get-EnvValue -Lines $lines -Key "WHATSAPP_API_PORT"
    $health = Wait-ForHealthcheck

    Write-Log "Processo concluido"
    Write-Host "  Servico: $ServiceName"
    Write-Host "  Pasta da API: $script:AppDir"
    Write-Host "  Backup: $script:BackupDir"
    Write-Host "  Host: $apiHost"
    Write-Host "  Porta: $apiPort"
    Write-Host "  API key: $apiKey"

    if ($health) {
        Write-Host "  Healthcheck: $health"
    } else {
        Write-Host "  Healthcheck: falhou ao responder automaticamente. Consulte o servico Windows."
    }

    Write-Host ""
    Write-Host "URL local para conectar o numero:"
    Write-Host "  http://127.0.0.1:$apiPort/connect?key=$apiKey"
}

function Main {
    Assert-Administrator
    Get-RequiredCommandPath "node" | Out-Null
    Get-RequiredCommandPath "npm" | Out-Null

    Ensure-RuntimeStructure
    Backup-State
    Prepare-EnvFile
    Update-CodeFromGit
    Install-Dependencies
    Validate-Application
    Restart-WindowsService
    Print-Summary
}

Main
