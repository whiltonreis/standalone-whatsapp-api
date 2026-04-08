'use strict';

const fs = require('fs');
const path = require('path');

function ensureDirectory(directoryPath) {
    fs.mkdirSync(directoryPath, { recursive: true });
}

function isExpired(stat, retentionDays) {
    const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;
    return Date.now() - stat.mtimeMs > maxAgeMs;
}

function cleanupLogFiles(logDir, options = {}) {
    ensureDirectory(logDir);

    const retentionDays = options.retentionDays ?? 15;
    const devRetentionDays = options.devRetentionDays ?? 7;
    const deletedFiles = [];

    for (const entry of fs.readdirSync(logDir, { withFileTypes: true })) {
        if (!entry.isFile()) {
            continue;
        }

        const fileName = entry.name;
        const filePath = path.join(logDir, fileName);
        const stat = fs.statSync(filePath);

        if (/^log_\d{4}-\d{2}-\d{2}\.log$/i.test(fileName) && isExpired(stat, retentionDays)) {
            fs.unlinkSync(filePath);
            deletedFiles.push(fileName);
            continue;
        }

        if (/^dev-(stdout|stderr)(-escalated)?\.log$/i.test(fileName) && isExpired(stat, devRetentionDays)) {
            fs.unlinkSync(filePath);
            deletedFiles.push(fileName);
        }
    }

    return deletedFiles;
}

function normalizeMeta(meta) {
    const normalized = {};

    for (const [key, value] of Object.entries(meta || {})) {
        if (value === undefined) {
            continue;
        }

        normalized[key] = value instanceof Error ? value.message : value;
    }

    return normalized;
}

function formatMeta(meta) {
    const normalized = normalizeMeta(meta);

    if (Object.keys(normalized).length === 0) {
        return '';
    }

    return ` ${JSON.stringify(normalized)}`;
}

function createLogger(options) {
    const logDir = options.logDir;

    ensureDirectory(logDir);

    if (options.cleanupEnabled !== false) {
        try {
            const deletedFiles = cleanupLogFiles(logDir, {
                retentionDays: options.retentionDays,
                devRetentionDays: options.devRetentionDays,
            });

            if (deletedFiles.length > 0) {
                console.log(
                    `[${new Date().toISOString()}] [INFO] Limpeza automatica de logs executada ${JSON.stringify({
                        removed: deletedFiles.length,
                        files: deletedFiles,
                    })}`
                );
            }
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] [WARN] Falha ao limpar logs antigos: ${error.message}`);
        }
    }

    function write(level, message, meta = {}) {
        const timestamp = new Date().toISOString();
        const payload = {
            timestamp,
            level,
            message,
            ...normalizeMeta(meta),
        };
        const line = `${JSON.stringify(payload)}\n`;
        const fileName = `log_${timestamp.slice(0, 10)}.log`;
        const filePath = path.join(logDir, fileName);
        const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';

        console[consoleMethod](`[${timestamp}] [${level.toUpperCase()}] ${message}${formatMeta(meta)}`);

        fs.appendFile(filePath, line, (error) => {
            if (error) {
                console.error(`[${timestamp}] [LOGGER] Falha ao gravar log: ${error.message}`);
            }
        });
    }

    return {
        info: (message, meta) => write('info', message, meta),
        warn: (message, meta) => write('warn', message, meta),
        error: (message, meta) => write('error', message, meta),
    };
}

module.exports = {
    cleanupLogFiles,
    createLogger,
    ensureDirectory,
};
