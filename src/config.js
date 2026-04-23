'use strict';

const fs = require('fs');
const path = require('path');

const moduleRoot = path.resolve(__dirname, '..');

loadEnvFile(path.join(moduleRoot, '.env'));

function loadEnvFile(filePath) {
    if (!fs.existsSync(filePath)) {
        return;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);

    for (const rawLine of lines) {
        const line = rawLine.trim();

        if (!line || line.startsWith('#')) {
            continue;
        }

        const separatorIndex = line.indexOf('=');

        if (separatorIndex === -1) {
            continue;
        }

        const key = line.slice(0, separatorIndex).trim();

        if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) {
            continue;
        }

        let value = line.slice(separatorIndex + 1).trim();

        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }

        process.env[key] = value;
    }
}

function toInt(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function toBool(value, fallback = false) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }

    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function toList(value) {
    if (!value) {
        return [];
    }

    return String(value)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

function resolveCustomPath(envValue, fallbackPath) {
    if (!envValue) {
        return fallbackPath;
    }

    return path.isAbsolute(envValue) ? envValue : path.join(moduleRoot, envValue);
}

function resolvePathWithLegacyFallback(preferredRelativePath, legacyRelativePath) {
    const preferredPath = path.join(moduleRoot, preferredRelativePath);
    const legacyPath = path.join(moduleRoot, legacyRelativePath);

    if (fs.existsSync(preferredPath)) {
        return preferredPath;
    }

    if (fs.existsSync(legacyPath)) {
        return legacyPath;
    }

    return preferredPath;
}

const defaultAuthDir = resolvePathWithLegacyFallback('runtime/auth', 'auth');
const defaultLogDir = resolvePathWithLegacyFallback('runtime/logs', 'logs');
const defaultNumberCacheFile = resolvePathWithLegacyFallback('runtime/cache/numero_cache.json', 'numero_cache.json');

const config = {
    moduleRoot,
    auth: {
        enabled: !toBool(process.env.WHATSAPP_DISABLE_AUTH, false),
    },
    api: {
        host: process.env.WHATSAPP_API_HOST || '0.0.0.0',
        port: toInt(process.env.WHATSAPP_API_PORT, 3000),
        key: process.env.WHATSAPP_API_KEY || '',
        corsOrigins: toList(process.env.WHATSAPP_CORS_ORIGINS),
        bodyLimit: process.env.WHATSAPP_BODY_LIMIT || '256kb',
    },
    runtime: {
        authDir: resolveCustomPath(process.env.WHATSAPP_AUTH_DIR, defaultAuthDir),
        logDir: resolveCustomPath(process.env.WHATSAPP_LOG_DIR, defaultLogDir),
        numberCacheFile: resolveCustomPath(process.env.WHATSAPP_NUMBER_CACHE_FILE, defaultNumberCacheFile),
    },
    logs: {
        cleanupEnabled: !toBool(process.env.WHATSAPP_DISABLE_LOG_CLEANUP, false),
        retentionDays: Math.max(toInt(process.env.WHATSAPP_LOG_RETENTION_DAYS, 15), 1),
        devRetentionDays: Math.max(toInt(process.env.WHATSAPP_DEV_LOG_RETENTION_DAYS, 7), 1),
    },
    send: {
        countryCode: process.env.WHATSAPP_COUNTRY_CODE || '55',
        enableNineDigitFallback: toBool(process.env.WHATSAPP_ENABLE_NINE_DIGIT_FALLBACK, true),
        maxMessageLength: toInt(process.env.WHATSAPP_MAX_MESSAGE_LENGTH, 4096),
        logMessageContent: toBool(process.env.WHATSAPP_LOG_MESSAGE_CONTENT, false),
    },
    reconnect: {
        baseDelayMs: toInt(process.env.WHATSAPP_RECONNECT_BASE_DELAY_MS, 3000),
        maxDelayMs: toInt(process.env.WHATSAPP_RECONNECT_MAX_DELAY_MS, 30000),
    },
    webhook: {
        enabled: toBool(process.env.WHATSAPP_WEBHOOK_ENABLED, false),
        url: process.env.WHATSAPP_WEBHOOK_URL || '',
        token: process.env.WHATSAPP_WEBHOOK_TOKEN || '',
        timeoutMs: Math.max(toInt(process.env.WHATSAPP_WEBHOOK_TIMEOUT_MS, 5000), 1000),
    },
};

function assertConfig() {
    if (config.auth.enabled && !config.api.key) {
        throw new Error('Defina WHATSAPP_API_KEY no arquivo api/whatsapp/.env ou no ambiente.');
    }
}

module.exports = {
    config,
    assertConfig,
};
