#!/usr/bin/env bash

set -Eeuo pipefail

# Script de implantacao rapida para Ubuntu.
# Instala Node.js LTS, dependencias da API, prepara o .env e registra um servico systemd.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_EXAMPLE_FILE="${APP_DIR}/.env.example"
ENV_FILE="${APP_DIR}/.env"

SERVICE_NAME="${WHATSAPP_SERVICE_NAME:-whatsapp-api}"
APP_USER="${WHATSAPP_SERVICE_USER:-${SUDO_USER:-root}}"
API_HOST_DEFAULT="${WHATSAPP_API_HOST:-0.0.0.0}"
API_PORT_DEFAULT="${WHATSAPP_API_PORT:-3015}"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
NODE_MAJOR_REQUIRED=20

log() {
    printf '[install-ubuntu] %s\n' "$*"
}

fail() {
    printf '[install-ubuntu] ERRO: %s\n' "$*" >&2
    exit 1
}

require_root() {
    if [[ "${EUID}" -ne 0 ]]; then
        fail "Execute com sudo. Exemplo: sudo bash scripts/install-ubuntu.sh"
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

ensure_user_exists() {
    id -u "${APP_USER}" >/dev/null 2>&1 || fail "O usuario '${APP_USER}' nao existe no sistema."
}

run_as_app_user() {
    if [[ "${APP_USER}" == "root" ]]; then
        "$@"
        return
    fi

    sudo -u "${APP_USER}" -H "$@"
}

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

current_node_major() {
    if ! command_exists node; then
        echo 0
        return
    fi

    node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0
}

install_base_packages() {
    log "Instalando pacotes base do sistema..."
    apt-get update -y
    apt-get install -y ca-certificates curl gnupg apt-transport-https
}

install_nodejs_if_needed() {
    local current_major
    current_major="$(current_node_major)"

    if [[ "${current_major}" -ge "${NODE_MAJOR_REQUIRED}" ]]; then
        log "Node.js ${current_major} detectado. Nao sera reinstalado."
        return
    fi

    log "Instalando Node.js ${NODE_MAJOR_REQUIRED}.x..."
    mkdir -p /etc/apt/keyrings

    if [[ ! -f /etc/apt/keyrings/nodesource.gpg ]]; then
        curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
            | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
    fi

    cat >/etc/apt/sources.list.d/nodesource.list <<EOF
deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR_REQUIRED}.x nodistro main
EOF

    apt-get update -y
    apt-get install -y nodejs
}

ensure_runtime_structure() {
    log "Preparando pastas de runtime..."
    mkdir -p "${APP_DIR}/runtime/auth" "${APP_DIR}/runtime/cache" "${APP_DIR}/runtime/logs"
    chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}/runtime"
}

generate_api_key() {
    node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
}

upsert_env() {
    local key="$1"
    local value="$2"
    local escaped

    escaped="${value//\\/\\\\}"
    escaped="${escaped//|/\\|}"
    escaped="${escaped//&/\\&}"

    if grep -Eq "^${key}=" "${ENV_FILE}"; then
        sed -i "s|^${key}=.*|${key}=${escaped}|" "${ENV_FILE}"
    else
        printf '%s=%s\n' "${key}" "${value}" >>"${ENV_FILE}"
    fi
}

prepare_env_file() {
    local desired_key
    local current_key=""

    if [[ ! -f "${ENV_FILE}" ]]; then
        log "Criando .env a partir do exemplo..."
        cp "${ENV_EXAMPLE_FILE}" "${ENV_FILE}"
    else
        log "Reaproveitando .env existente."
    fi

    current_key="$(sed -n 's/^WHATSAPP_API_KEY=//p' "${ENV_FILE}" | head -n 1)"

    if [[ -z "${current_key}" || "${current_key}" == "defina-uma-chave-forte-aqui" ]]; then
        desired_key="$(generate_api_key)"
    else
        desired_key="${current_key}"
    fi

    upsert_env "WHATSAPP_API_KEY" "${desired_key}"
    upsert_env "WHATSAPP_API_HOST" "${API_HOST_DEFAULT}"
    upsert_env "WHATSAPP_API_PORT" "${API_PORT_DEFAULT}"
    upsert_env "WHATSAPP_AUTH_DIR" "runtime/auth"
    upsert_env "WHATSAPP_LOG_DIR" "runtime/logs"
    upsert_env "WHATSAPP_NUMBER_CACHE_FILE" "runtime/cache/numero_cache.json"
    upsert_env "WHATSAPP_LOG_RETENTION_DAYS" "15"
    upsert_env "WHATSAPP_DEV_LOG_RETENTION_DAYS" "7"
    upsert_env "WHATSAPP_DISABLE_LOG_CLEANUP" "false"

    chown "${APP_USER}:${APP_USER}" "${ENV_FILE}" || true
}

install_dependencies() {
    log "Instalando dependencias npm..."
    run_as_app_user npm --prefix "${APP_DIR}" install --omit=dev
}

validate_application() {
    log "Validando sintaxe da API..."
    run_as_app_user npm --prefix "${APP_DIR}" run check
}

create_systemd_service() {
    local node_path

    node_path="$(command -v node)"
    [[ -n "${node_path}" ]] || fail "Node.js nao foi encontrado apos a instalacao."

    log "Criando servico systemd ${SERVICE_NAME}..."
    cat >"${SERVICE_FILE}" <<EOF
[Unit]
Description=Standalone WhatsApp API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${node_path} ${APP_DIR}/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
}

start_service() {
    log "Registrando e iniciando o servico..."
    systemctl daemon-reload
    systemctl enable "${SERVICE_NAME}" >/dev/null
    systemctl restart "${SERVICE_NAME}"
}

wait_for_healthcheck() {
    local port
    local attempts=15
    local response=""

    port="$(sed -n 's/^WHATSAPP_API_PORT=//p' "${ENV_FILE}" | head -n 1)"
    port="${port:-${API_PORT_DEFAULT}}"

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

primary_ip() {
    hostname -I 2>/dev/null | awk '{print $1}'
}

print_summary() {
    local api_key
    local api_host
    local api_port
    local ip
    local health=""

    api_key="$(sed -n 's/^WHATSAPP_API_KEY=//p' "${ENV_FILE}" | head -n 1)"
    api_host="$(sed -n 's/^WHATSAPP_API_HOST=//p' "${ENV_FILE}" | head -n 1)"
    api_port="$(sed -n 's/^WHATSAPP_API_PORT=//p' "${ENV_FILE}" | head -n 1)"
    ip="$(primary_ip)"

    log "Resumo da implantacao"
    printf '  Servico: %s\n' "${SERVICE_NAME}"
    printf '  Usuario do servico: %s\n' "${APP_USER}"
    printf '  Pasta da API: %s\n' "${APP_DIR}"
    printf '  Host: %s\n' "${api_host}"
    printf '  Porta: %s\n' "${api_port}"
    printf '  API key: %s\n' "${api_key}"

    if health="$(wait_for_healthcheck)"; then
        printf '  Healthcheck: %s\n' "${health}"
    else
        printf '  Healthcheck: falhou ao responder automaticamente. Consulte: systemctl status %s\n' "${SERVICE_NAME}"
    fi

    printf '\n'
    printf 'URL local para conectar o numero:\n'
    printf '  http://127.0.0.1:%s/connect?key=%s\n' "${api_port}" "${api_key}"

    if [[ -n "${ip}" && "${api_host}" != "127.0.0.1" ]]; then
        printf '\n'
        printf 'URL de rede na maquina atual:\n'
        printf '  http://%s:%s/connect?key=%s\n' "${ip}" "${api_port}" "${api_key}"
    fi

    printf '\n'
    printf 'Comandos uteis:\n'
    printf '  sudo systemctl status %s\n' "${SERVICE_NAME}"
    printf '  sudo journalctl -u %s -f\n' "${SERVICE_NAME}"
    printf '  curl http://127.0.0.1:%s/health\n' "${api_port}"
}

main() {
    require_root
    assert_ubuntu_family
    ensure_user_exists
    install_base_packages
    install_nodejs_if_needed
    ensure_runtime_structure
    prepare_env_file
    install_dependencies
    validate_application
    create_systemd_service
    start_service
    print_summary
}

main "$@"
