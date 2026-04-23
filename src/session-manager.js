'use strict';

const fs   = require('fs');
const path = require('path');
const { WhatsAppService } = require('./whatsapp-service');

const DEFAULT_SESSION_ID = 'default';

class SessionManager {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        this.sessions = new Map();
    }

    _configForSession(sessionId) {
        if (sessionId === DEFAULT_SESSION_ID) {
            return {
                ...this.config,
                runtime: {
                    ...this.config.runtime,
                    sessionId,
                },
            };
        }

        const sessionsBaseDir = path.join(this.config.runtime.authDir, 'sessions', sessionId);

        return {
            ...this.config,
            runtime: {
                ...this.config.runtime,
                sessionId,
                authDir: sessionsBaseDir,
                numberCacheFile: path.join(sessionsBaseDir, 'number_cache.json'),
            },
        };
    }

    getOrCreate(sessionId) {
        if (!this.sessions.has(sessionId)) {
            const sessionConfig = this._configForSession(sessionId);
            const service = new WhatsAppService(sessionConfig, this.logger);
            this.sessions.set(sessionId, service);
        }

        return this.sessions.get(sessionId);
    }

    get(sessionId) {
        return this.sessions.get(sessionId) || null;
    }

    async start(sessionId) {
        const service = this.getOrCreate(sessionId);
        await service.start();
        return service;
    }

    list() {
        const result = {};

        for (const [id, service] of this.sessions) {
            const status = service.getStatus();
            result[id] = {
                connection: status.connection,
                connected: status.connected,
                hasQr: status.hasQr,
                user: status.user,
                lastError: status.lastError,
            };
        }

        return result;
    }

    async autoStartSavedSessions() {
        const sessionsDir = path.join(this.config.runtime.authDir, 'sessions');

        if (!fs.existsSync(sessionsDir)) return;

        const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;

            const sessionId = entry.name;

            if (sessionId === DEFAULT_SESSION_ID || this.sessions.has(sessionId)) continue;

            const sessionAuthDir = path.join(sessionsDir, sessionId);
            const hasCreds = fs.existsSync(path.join(sessionAuthDir, 'creds.json'));

            if (!hasCreds) continue;

            try {
                await this.start(sessionId);
            } catch (_err) {
                // non-fatal — session will need manual reconnect
            }
        }
    }

    async stopAll() {
        const promises = [...this.sessions.values()].map((s) => s.stop().catch(() => {}));
        await Promise.all(promises);
    }
}

module.exports = { SessionManager, DEFAULT_SESSION_ID };
