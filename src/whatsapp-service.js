'use strict';

const fs = require('fs');
const qrcode = require('qrcode-terminal');
const {
    makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
} = require('@whiskeysockets/baileys');

const { ensureDirectory } = require('./logger');
const { JsonStore } = require('./json-store');

class HttpError extends Error {
    constructor(status, message, details = undefined) {
        super(message);
        this.status = status;
        this.details = details;
    }
}

function maskPhone(number) {
    const digits = String(number ?? '').replace(/\D/g, '');

    if (!digits) {
        return '';
    }

    if (digits.length <= 6) {
        return `${digits.slice(0, 2)}***`;
    }

    return `${digits.slice(0, 4)}***${digits.slice(-4)}`;
}

class WhatsAppService {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        this.sock = null;
        this.currentQr = null;
        this.reconnectTimer = null;
        this.isStarting = false;
        this.isStopping = false;
        this.isLoggingOut = false;
        this.state = {
            connection: 'idle',
            reconnectAttempt: 0,
            lastError: null,
            startedAt: null,
        };
        this.numberCache = new JsonStore(this.config.runtime.numberCacheFile, {});
    }

    clearReconnectTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    async start() {
        if (this.isStopping || this.isLoggingOut || this.isStarting) {
            return;
        }

        this.isStarting = true;
        this.clearReconnectTimer();
        ensureDirectory(this.config.runtime.authDir);

        try {
            const { state, saveCreds } = await useMultiFileAuthState(this.config.runtime.authDir);

            let version;

            try {
                const latestVersion = await fetchLatestBaileysVersion();
                version = latestVersion.version;
            } catch (error) {
                this.logger.warn('Nao foi possivel obter a versao mais recente do Baileys. Usando a versao padrao do pacote.', {
                    error: error.message,
                });
            }

            const socket = makeWASocket({
                ...(version ? { version } : {}),
                auth: state,
                printQRInTerminal: false,
                syncFullHistory: false,
                markOnlineOnConnect: false,
            });

            this.attachSocket(socket, saveCreds);
            this.sock = socket;
            this.state.connection = 'connecting';
            this.state.lastError = null;
            this.state.startedAt = this.state.startedAt || new Date().toISOString();

            this.logger.info('Cliente WhatsApp inicializado', {
                authDir: this.config.runtime.authDir,
                version: version ? version.join('.') : 'default',
            });
        } catch (error) {
            this.state.connection = 'error';
            this.state.lastError = error.message;
            this.logger.error('Falha ao iniciar o cliente WhatsApp', { error: error.message });
            this.scheduleReconnect();
        } finally {
            this.isStarting = false;
        }
    }

    attachSocket(socket, saveCreds) {
        socket.ev.on('creds.update', saveCreds);
        socket.ev.on('connection.update', (update) => {
            this.handleConnectionUpdate(socket, update).catch((error) => {
                this.state.lastError = error.message;
                this.logger.error('Erro ao processar evento de conexao', { error: error.message });
            });
        });
    }

    async handleConnectionUpdate(socket, update) {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            this.currentQr = qr;
            this.state.connection = 'qr_ready';
            this.state.lastError = null;
            this.logger.info('QR Code atualizado');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            this.sock = socket;
            this.currentQr = null;
            this.state.connection = 'open';
            this.state.lastError = null;
            this.state.reconnectAttempt = 0;
            this.clearReconnectTimer();

            this.logger.info('WhatsApp conectado', {
                userId: socket.user?.id || null,
                userName: socket.user?.name || null,
            });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode || null;
            const loggedOut = statusCode === DisconnectReason.loggedOut;

            this.currentQr = null;

            if (this.isStopping) {
                this.state.connection = 'stopped';
                return;
            }

            if (loggedOut || this.isLoggingOut) {
                this.sock = null;
                this.state.connection = 'logged_out';
                this.state.lastError = loggedOut ? 'Sessao encerrada.' : null;

                this.logger.warn('Sessao WhatsApp encerrada', {
                    statusCode,
                });

                return;
            }

            this.sock = null;
            this.state.connection = 'disconnected';
            this.state.lastError = lastDisconnect?.error?.message || 'Conexao encerrada.';

            this.logger.warn('Conexao WhatsApp encerrada', {
                statusCode,
                reconnectAttempt: this.state.reconnectAttempt + 1,
            });

            this.scheduleReconnect();
        }
    }

    scheduleReconnect() {
        if (this.reconnectTimer || this.isStopping || this.isLoggingOut) {
            return;
        }

        const attempt = this.state.reconnectAttempt + 1;
        const delayMs = Math.min(
            this.config.reconnect.baseDelayMs * Math.pow(2, attempt - 1),
            this.config.reconnect.maxDelayMs
        );

        this.state.reconnectAttempt = attempt;

        this.logger.info('Agendando reconexao do WhatsApp', {
            attempt,
            delayMs,
        });

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.start();
        }, delayMs);
    }

    getStatus() {
        return {
            service: 'whatsapp-api',
            connection: this.state.connection,
            connected: Boolean(this.sock?.user),
            hasQr: Boolean(this.currentQr),
            reconnectAttempt: this.state.reconnectAttempt,
            user: this.sock?.user
                ? {
                    id: this.sock.user.id || null,
                    name: this.sock.user.name || null,
                    lid: this.sock.user.lid || null,
                }
                : null,
            lastError: this.state.lastError,
            authDir: this.config.runtime.authDir,
            logDir: this.config.runtime.logDir,
            cacheFile: this.config.runtime.numberCacheFile,
            startedAt: this.state.startedAt,
        };
    }

    getQr() {
        return this.currentQr;
    }

    ensureConnected() {
        if (!this.sock || !this.sock.user) {
            throw new HttpError(503, 'WhatsApp nao esta conectado.');
        }
    }

    sanitizeMessage(message) {
        if (typeof message !== 'string') {
            throw new HttpError(400, 'Informe uma mensagem valida.');
        }

        const trimmed = message.trim();

        if (!trimmed) {
            throw new HttpError(400, 'Informe uma mensagem valida.');
        }

        if (trimmed.length > this.config.send.maxMessageLength) {
            throw new HttpError(
                400,
                `Mensagem excede o limite de ${this.config.send.maxMessageLength} caracteres.`
            );
        }

        return trimmed;
    }

    normalizeNumber(number) {
        const digits = String(number ?? '').replace(/\D/g, '');

        if (!digits) {
            throw new HttpError(400, 'Informe um numero valido.');
        }

        if (
            !digits.startsWith(this.config.send.countryCode) ||
            digits.length < 12 ||
            digits.length > 13
        ) {
            throw new HttpError(400, 'Numero invalido para o padrao configurado.');
        }

        return digits;
    }

    classifyBrazilianNumber(normalizedNumber) {
        if (this.config.send.countryCode !== '55' || !normalizedNumber.startsWith('55')) {
            return null;
        }

        const localNumber = normalizedNumber.slice(2);

        if (localNumber.length !== 10 && localNumber.length !== 11) {
            return null;
        }

        return {
            ddd: localNumber.slice(0, 2),
            subscriber: localNumber.slice(2),
            localLength: localNumber.length,
            firstDigit: localNumber.slice(2, 3),
        };
    }

    buildCandidates(normalizedNumber) {
        const candidates = [normalizedNumber];
        const brazilianNumber = this.classifyBrazilianNumber(normalizedNumber);

        if (!this.config.send.enableNineDigitFallback) {
            return candidates;
        }

        if (brazilianNumber) {
            if (brazilianNumber.localLength === 11 && brazilianNumber.firstDigit === '9') {
                candidates.push(
                    this.config.send.countryCode +
                    brazilianNumber.ddd +
                    brazilianNumber.subscriber.slice(1)
                );
            } else if (
                brazilianNumber.localLength === 10 &&
                !['2', '3', '4', '5'].includes(brazilianNumber.firstDigit)
            ) {
                candidates.push(
                    this.config.send.countryCode +
                    brazilianNumber.ddd +
                    '9' +
                    brazilianNumber.subscriber
                );
            }

            return [...new Set(candidates.filter((item) => item.length >= 12 && item.length <= 13))];
        }

        const localStart = this.config.send.countryCode.length + 2;

        if (normalizedNumber.length >= localStart + 8) {
            if (normalizedNumber[localStart] === '9') {
                candidates.push(
                    normalizedNumber.slice(0, localStart) +
                    normalizedNumber.slice(localStart + 1)
                );
            } else if (normalizedNumber.length === this.config.send.countryCode.length + 10) {
                candidates.push(
                    normalizedNumber.slice(0, localStart) +
                    '9' +
                    normalizedNumber.slice(localStart)
                );
            }
        }

        return [...new Set(candidates.filter((item) => item.length >= 12 && item.length <= 13))];
    }

    async resolveRegisteredNumber(normalizedNumber) {
        const cached = this.numberCache.get(normalizedNumber);

        if (cached) {
            return { number: cached, cached: true, candidates: [cached] };
        }

        const candidates = this.buildCandidates(normalizedNumber);

        for (const candidate of candidates) {
            const result = await this.sock.onWhatsApp(candidate);

            if (result?.[0]?.exists) {
                this.numberCache.set(normalizedNumber, candidate);

                if (candidate !== normalizedNumber) {
                    this.numberCache.set(candidate, candidate);
                }

                return { number: candidate, cached: false, candidates };
            }
        }

        throw new HttpError(404, 'Numero nao registrado no WhatsApp.', {
            normalizedNumber,
            candidates,
        });
    }

    async resolveNumber(payload) {
        const normalizedNumber = this.normalizeNumber(payload.number);

        this.ensureConnected();

        const resolved = await this.resolveRegisteredNumber(normalizedNumber);

        return {
            normalizedNumber,
            resolvedNumber: resolved.number,
            cachedResolution: resolved.cached,
            exactMatch: resolved.number === normalizedNumber,
            candidatesTried: resolved.candidates,
        };
    }

    async sendText(payload) {
        const message = this.sanitizeMessage(payload.message);
        const normalizedNumber = this.normalizeNumber(payload.number);

        this.ensureConnected();

        const resolved = await this.resolveRegisteredNumber(normalizedNumber);
        const jid = `${resolved.number}@s.whatsapp.net`;

        await this.sock.sendMessage(jid, { text: message });

        const logMeta = {
            number: maskPhone(normalizedNumber),
            sentTo: maskPhone(resolved.number),
            cachedResolution: resolved.cached,
            messageLength: message.length,
        };

        if (this.config.send.logMessageContent) {
            logMeta.message = message;
        }

        this.logger.info('Mensagem enviada', logMeta);

        return {
            status: 'Mensagem enviada com sucesso!',
            normalizedNumber,
            sentTo: resolved.number,
            cachedResolution: resolved.cached,
        };
    }

    async logout() {
        this.isLoggingOut = true;
        this.clearReconnectTimer();

        try {
            if (this.sock) {
                try {
                    await this.sock.logout();
                } catch (error) {
                    this.logger.warn('Logout via socket retornou erro', {
                        error: error.message,
                    });
                }

                try {
                    this.sock.end?.(new Error('Sessao encerrada manualmente.'));
                } catch (error) {
                    this.logger.warn('Falha ao encerrar o socket apos logout', {
                        error: error.message,
                    });
                }
            }

            this.sock = null;
            this.currentQr = null;
            this.state.connection = 'logged_out';

            await fs.promises.rm(this.config.runtime.authDir, { recursive: true, force: true });

            this.logger.warn('Sessao WhatsApp removida', {
                authDir: this.config.runtime.authDir,
            });
        } finally {
            this.isLoggingOut = false;
        }

        await this.start();

        return {
            status: 'Logout feito com sucesso. Nova sessao iniciada.',
            authDir: this.config.runtime.authDir,
        };
    }

    async stop() {
        this.isStopping = true;
        this.clearReconnectTimer();

        if (this.sock) {
            try {
                this.sock.end?.(new Error('Servico encerrado.'));
            } catch (error) {
                this.logger.warn('Falha ao encerrar o socket', {
                    error: error.message,
                });
            }

            this.sock = null;
        }

        this.state.connection = 'stopped';
    }
}

module.exports = {
    HttpError,
    WhatsAppService,
};
