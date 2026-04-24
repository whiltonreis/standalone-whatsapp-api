#!/usr/bin/env bash

set -Eeuo pipefail

# Script de atualizacao para Ubuntu/Debian.
# Faz backup do .env e da sessao, atualiza o codigo, reinstala dependencias,
# valida a API e reinicia o servico systemd.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${APP_DIR}/.env"
REQUESTED_SERVICE_NAME="${WHATSAPP_SERVICE_NAME:-whatsapp-api}"
BACKUP_ROOT="${APP_DIR}/backups"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${BACKUP_ROOT}/${TIMESTAMP}"
SKIP_GIT_PULL="${WHATSAPP_SKIP_GIT_PULL:-false}"
ALLOW_DIRTY_UPDATE="${WHATSAPP_ALLOW_DIRTY_UPDATE:-false}"

log() {
    printf '[update-ubuntu] %s\n' "$*"
}

fail() {
    printf '[update-ubuntu] ERRO: %s\n' "$*" >&2
    exit 1
}

to_bool() {
    case "${1:-}" in
        1|true|TRUE|yes|YES|on|ON) return 0 ;;
        *) return 1 ;;
    esac
}

require_root() {
    if [[ "${EUID}" -ne 0 ]]; then
        fail "Execute com sudo. Exemplo: sudo bash scripts/update-ubuntu.sh"
    fi
}

assert_ubuntu_family() {
    if [[ -f /etc/os-release ]]; then
        # shellcheck disable=SC1091
        source /etc/os-release
        if [[ "${ID:-}" != "ubuntu" && "${ID_LIKE:-}" != *"ubuntu"* && "${ID_LIKE:-}" != *"debian"* ]]; then
            log "Aviso: este script foi pensado para Ubuntu/Debian. Continuando por sua conta."
        fi
    fi
}

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

service_exists() {
    local service_name="$1"

    systemctl list-unit-files --type=service --no-legend 2>/dev/null \
        | awk '{print $1}' \
        | grep -Fxq "${service_name}.service"
}

service_matches_app_dir() {
    local unit="$1"
    local definition=""

    definition="$(systemctl cat "${unit}" 2>/dev/null || true)"
    [[ -n "${definition}" ]] || return 1

    grep -Fq "WorkingDirectory=${APP_DIR}" <<<"${definition}" \
        || grep -Fq "${APP_DIR}/index.js" <<<"${definition}"
}

resolve_service_name() {
    if service_exists "${REQUESTED_SERVICE_NAME}"; then
        printf '%s' "${REQUESTED_SERVICE_NAME}"
        return
    fi

    while read -r unit _; do
        [[ -n "${unit}" ]] || continue
        service_matches_app_dir "${unit}" || continue
        printf '%s' "${unit%.service}"
        return
    done < <(systemctl list-unit-files --type=service --no-legend 2>/dev/null)

    printf '%s' "${REQUESTED_SERVICE_NAME}"
}

list_api_process_pids() {
    local pid=""
    local args=""
    local cwd=""

    while read -r pid; do
        [[ -n "${pid}" ]] || continue
        args="$(ps -p "${pid}" -o args= 2>/dev/null || true)"
        [[ -n "${args}" ]] || continue

        if [[ "${args}" == *"${APP_DIR}/index.js"* ]]; then
            printf '%s\n' "${pid}"
            continue
        fi

        cwd="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)"
        if [[ "${cwd}" == "${APP_DIR}" && "${args}" == *"index.js"* ]]; then
            printf '%s\n' "${pid}"
        fi
    done < <(pgrep -x node 2>/dev/null || true)
}

detect_app_user() {
    if [[ -f "${SERVICE_FILE}" ]]; then
        local configured_user
        configured_user="$(sed -n 's/^User=//p' "${SERVICE_FILE}" | head -n 1)"
        if [[ -n "${configured_user}" ]]; then
            printf '%s' "${configured_user}"
            return
        fi
    fi

    printf '%s' "${WHATSAPP_SERVICE_USER:-${SUDO_USER:-root}}"
}

SERVICE_NAME="$(resolve_service_name)"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
APP_USER="$(detect_app_user)"

log "Servico resolvido para atualizacao: ${SERVICE_NAME}"

ensure_prerequisites() {
    [[ -f "${ENV_FILE}" ]] || fail "Arquivo .env nao encontrado. Rode primeiro o install-ubuntu.sh."
    command_exists node || fail "Node.js nao encontrado."
    command_exists npm || fail "npm nao encontrado."
    command_exists systemctl || fail "systemctl nao encontrado."

    if ! id -u "${APP_USER}" >/dev/null 2>&1; then
        fail "O usuario '${APP_USER}' nao existe no sistema."
    fi
}

run_as_app_user() {
    if [[ "${APP_USER}" == "root" ]]; then
        "$@"
        return
    fi

    sudo -u "${APP_USER}" -H "$@"
}

ensure_runtime_structure() {
    mkdir -p "${APP_DIR}/runtime/auth" "${APP_DIR}/runtime/cache" "${APP_DIR}/runtime/logs"
    chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}/runtime"
}

backup_state() {
    log "Gerando backup de seguranca em ${BACKUP_DIR}..."
    mkdir -p "${BACKUP_DIR}"

    if [[ -f "${ENV_FILE}" ]]; then
        cp "${ENV_FILE}" "${BACKUP_DIR}/.env"
    fi

    if [[ -d "${APP_DIR}/runtime/auth" ]]; then
        cp -a "${APP_DIR}/runtime/auth" "${BACKUP_DIR}/auth"
    fi

    if [[ -f "${APP_DIR}/runtime/cache/numero_cache.json" ]]; then
        cp "${APP_DIR}/runtime/cache/numero_cache.json" "${BACKUP_DIR}/numero_cache.json"
    fi
}

stop_service() {
    if service_exists "${SERVICE_NAME}"; then
        log "Parando servico ${SERVICE_NAME}..."
        systemctl stop "${SERVICE_NAME}" || true
        return
    fi

    log "Servico ${SERVICE_NAME} nao encontrado. Vou continuar sem parar servico."
}

stop_stray_processes() {
    mapfile -t api_pids < <(list_api_process_pids)
    [[ ${#api_pids[@]} -gt 0 ]] || return 0

    log "Encerrando processos avulsos da API: ${api_pids[*]}"
    kill "${api_pids[@]}" 2>/dev/null || true
    sleep 2

    mapfile -t remaining_pids < <(list_api_process_pids)
    [[ ${#remaining_pids[@]} -gt 0 ]] || return 0

    log "Forcando encerramento dos processos restantes: ${remaining_pids[*]}"
    kill -9 "${remaining_pids[@]}" 2>/dev/null || true
}

assert_clean_git_worktree() {
    if [[ ! -d "${APP_DIR}/.git" ]]; then
        log "Pasta nao esta em um repositorio Git. Pulando git pull."
        return 1
    fi

    local status
    status="$(run_as_app_user git -C "${APP_DIR}" status --porcelain)"

    if [[ -n "${status}" ]] && ! to_bool "${ALLOW_DIRTY_UPDATE}"; then
        fail "Repositorio com alteracoes locais. Use WHATSAPP_ALLOW_DIRTY_UPDATE=true se quiser forcar."
    fi

    return 0
}

update_code_from_git() {
    if to_bool "${SKIP_GIT_PULL}"; then
        log "WHATSAPP_SKIP_GIT_PULL=true. Pulando atualizacao via Git."
        return
    fi

    if ! assert_clean_git_worktree; then
        return
    fi

    log "Atualizando codigo via Git..."
    run_as_app_user git -C "${APP_DIR}" fetch --all --tags --prune
    run_as_app_user git -C "${APP_DIR}" pull --ff-only
}

install_dependencies() {
    log "Atualizando dependencias npm..."
    run_as_app_user npm --prefix "${APP_DIR}" install --omit=dev
}

validate_application() {
    log "Validando sintaxe da API..."
    run_as_app_user npm --prefix "${APP_DIR}" run check
}

restart_service() {
    if service_exists "${SERVICE_NAME}"; then
        log "Reiniciando servico ${SERVICE_NAME}..."
        systemctl daemon-reload
        systemctl restart "${SERVICE_NAME}"
        return
    fi

    fail "Servico ${SERVICE_NAME} nao encontrado. Rode o install-ubuntu.sh primeiro ou informe WHATSAPP_SERVICE_NAME com o nome correto."
}

wait_for_healthcheck() {
    local port
    local attempts=15
    local response=""

    port="$(sed -n 's/^WHATSAPP_API_PORT=//p' "${ENV_FILE}" | head -n 1)"
    port="${port:-3015}"

    log "Aguardando a API responder na porta ${port}..."

    for ((i = 1; i <= attempts; i += 1)); do
        if response="$(curl -fsS --max-time 4 "http://127.0.0.1:${port}/health" 2>/dev/null)"; then
            printf '%s' "${response}"
            return 0
        fi

        sleep 2
    done

    return 1
}

print_summary() {
    local api_key
    local api_port
    local health=""

    api_key="$(sed -n 's/^WHATSAPP_API_KEY=//p' "${ENV_FILE}" | head -n 1)"
    api_port="$(sed -n 's/^WHATSAPP_API_PORT=//p' "${ENV_FILE}" | head -n 1)"

    log "Atualizacao concluida"
    printf '  Servico: %s\n' "${SERVICE_NAME}"
    printf '  Usuario do servico: %s\n' "${APP_USER}"
    printf '  Backup: %s\n' "${BACKUP_DIR}"
    printf '  Porta: %s\n' "${api_port}"

    if health="$(wait_for_healthcheck)"; then
        printf '  Healthcheck: %s\n' "${health}"
    else
        printf '  Healthcheck: falhou ao responder automaticamente. Consulte: systemctl status %s\n' "${SERVICE_NAME}"
    fi

    printf '\n'
    printf 'URL local para reconectar se necessario:\n'
    printf '  http://127.0.0.1:%s/connect?key=%s\n' "${api_port}" "${api_key}"

    printf '\n'
    printf 'Comandos uteis:\n'
    printf '  sudo systemctl status %s\n' "${SERVICE_NAME}"
    printf '  sudo journalctl -u %s -f\n' "${SERVICE_NAME}"
}

main() {
    require_root
    assert_ubuntu_family
    ensure_prerequisites
    ensure_runtime_structure
    backup_state
    stop_service
    stop_stray_processes
    update_code_from_git
    install_dependencies
    validate_application
    restart_service
    print_summary
}

main "$@"
