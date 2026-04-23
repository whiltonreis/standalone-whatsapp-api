'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const qrcode = require('qrcode-terminal');
const {
    makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    downloadMediaMessage,
} = require('@whiskeysockets/baileys');

const { ensureDirectory } = require('./logger');
const { JsonStore } = require('./json-store');

let ffmpegPath = null;
try { ffmpegPath = require('ffmpeg-static'); } catch (_) {}
let sharp = null;
try { sharp = require('sharp'); } catch (_) {}

function convertToOgg(inputPath) {
    return new Promise((resolve, reject) => {
        if (!ffmpegPath) return reject(new Error('ffmpeg-static nao instalado'));
        const outPath = inputPath + '_converted.ogg';
        execFile(ffmpegPath, [
            '-y', '-i', inputPath,
            '-c:a', 'libopus', '-b:a', '64k',
            '-ar', '48000', '-ac', '1', '-vn', outPath,
        ], (err) => {
            if (err) return reject(err);
            resolve(outPath);
        });
    });
}

async function prepareStickerBuffer(buffer, mime) {
    const cleanMime = String(mime || '').split(';')[0].trim().toLowerCase();
    if (cleanMime === 'image/webp' || !sharp) {
        return buffer;
    }

    return sharp(buffer, { animated: true })
        .rotate()
        .resize({
            width: 512,
            height: 512,
            fit: 'inside',
            withoutEnlargement: true,
        })
        .webp({ quality: 90 })
        .toBuffer();
}

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

    extractTextFromMessageContent(content) {
        if (!content || typeof content !== 'object') {
            return '';
        }

        const candidates = [
            content.conversation,
            content.extendedTextMessage?.text,
            content.imageMessage?.caption,
            content.videoMessage?.caption,
            content.documentMessage?.caption,
            content.reactionMessage?.text,
            content.buttonsResponseMessage?.selectedDisplayText,
            content.listResponseMessage?.title,
            content.templateButtonReplyMessage?.selectedDisplayText,
        ];

        for (const candidate of candidates) {
            if (typeof candidate === 'string' && candidate.trim()) {
                return candidate.trim();
            }
        }

        return '';
    }

    normalizeIncomingPhone(remoteJid) {
        const jid = String(remoteJid ?? '');
        if (!jid.includes('@')) {
            return '';
        }

        const phone = jid.split('@')[0].replace(/\D/g, '');
        return phone || '';
    }

    mediaTypeFromMessage(msgContent) {
        if (msgContent.imageMessage)    return 'image';
        if (msgContent.audioMessage)    return 'audio';
        if (msgContent.videoMessage)    return 'video';
        if (msgContent.stickerMessage)  return 'sticker';
        if (msgContent.documentMessage) return 'file';
        if (msgContent.documentWithCaptionMessage?.message?.documentMessage) return 'file';
        return null;
    }

    mediaExtension(msgContent, mediaType) {
        const mime =
            msgContent.imageMessage?.mimetype ||
            msgContent.audioMessage?.mimetype ||
            msgContent.videoMessage?.mimetype ||
            msgContent.stickerMessage?.mimetype ||
            msgContent.documentMessage?.mimetype ||
            msgContent.documentWithCaptionMessage?.message?.documentMessage?.mimetype || '';
        const map = {
            'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
            'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
            'video/mp4': 'mp4', 'video/3gpp': '3gp',
            'application/pdf': 'pdf',
        };
        return map[mime] || (mediaType === 'audio' ? 'ogg' : mediaType === 'image' ? 'jpg' : mediaType === 'sticker' ? 'webp' : 'bin');
    }

    async downloadAndSaveMedia(item, mediaType) {
        const storageDir = process.env.LARAVEL_STORAGE_PATH;
        if (!storageDir) return null;

        try {
            const buffer = await downloadMediaMessage(
                item, 'buffer', {},
                { logger: this.logger, reuploadRequest: this.sock.updateMediaMessage }
            );
            if (!buffer || !buffer.length) return null;

            const msgContent = item.message?.documentWithCaptionMessage?.message || item.message || {};
            const ext      = this.mediaExtension(msgContent, mediaType);
            const mime     = msgContent[`${mediaType}Message`]?.mimetype ||
                             msgContent.documentMessage?.mimetype ||
                             (mediaType === 'sticker' ? 'image/webp' : null) ||
                             (mediaType === 'audio' ? 'audio/ogg' : 'application/octet-stream');
            const origName = msgContent.documentMessage?.fileName ||
                             msgContent.documentWithCaptionMessage?.message?.documentMessage?.fileName || null;

            const now      = new Date();
            const subDir   = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
            const dirPath  = path.join(storageDir, subDir);
            if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });

            const hash     = crypto.randomBytes(8).toString('hex');
            const fileName = `${now.getTime()}_${hash}.${ext}`;
            const filePath = path.join(dirPath, fileName);
            fs.writeFileSync(filePath, buffer);

            return {
                media_type:     mediaType,
                media_url:      `chat-media/${subDir}/${fileName}`,
                media_filename: origName || fileName,
                media_mime:     mime,
            };
        } catch (err) {
            this.logger.warn('Falha ao baixar midia', { error: err.message });
            return null;
        }
    }

    resolveLidToPhone(lidJid) {
        const lid = String(lidJid ?? '').split('@')[0].replace(/\D/g, '');
        if (!lid) return '';

        try {
            const mappingFile = require('path').join(
                this.config.runtime.authDir,
                `lid-mapping-${lid}_reverse.json`
            );
            if (fs.existsSync(mappingFile)) {
                const phone = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
                if (typeof phone === 'string' && phone) {
                    return phone.replace(/\D/g, '');
                }
            }
        } catch (_) {}

        return '';
    }

    async dispatchIncomingWebhook(payload) {
        if (!this.config.webhook?.enabled || !this.config.webhook?.url) {
            return;
        }

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), this.config.webhook.timeoutMs);

            const response = await fetch(this.config.webhook.url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-webhook-token': this.config.webhook.token || '',
                },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });

            clearTimeout(timeout);

            const body = await response.text().catch(() => '');

            if (!response.ok) {
                this.logger.warn('Webhook de entrada respondeu com erro', {
                    status: response.status,
                    body,
                    sessionId: this.config.runtime.sessionId || null,
                });
            }
        } catch (error) {
            this.logger.warn('Falha ao enviar mensagem recebida para o webhook', {
                error: error.message,
                sessionId: this.config.runtime.sessionId || null,
            });
        }
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

        if (this.sock && ['connecting', 'open', 'qr_ready'].includes(this.state.connection)) {
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

            this.sock = socket;
            this.attachSocket(socket, saveCreds);
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
        socket.ev.on('messages.upsert', (event) => {
            this.handleIncomingMessages(event).catch((error) => {
                this.logger.warn('Falha ao processar mensagens recebidas', {
                    error: error.message,
                    sessionId: this.config.runtime.sessionId || null,
                });
            });
        });
    }

    async handleIncomingMessages(event) {
        const items = Array.isArray(event?.messages) ? event.messages : [];

        if (!items.length) {
            return;
        }

        for (const item of items) {
            const remoteJid = item?.key?.remoteJid || '';
            const fromMe    = item?.key?.fromMe ?? true;

            if (!item?.message || fromMe) {
                continue;
            }

            const isIndividual = remoteJid.endsWith('@s.whatsapp.net');
            const isLid        = remoteJid.endsWith('@lid');

            if (!isIndividual && !isLid) {
                continue;
            }

            const message   = this.extractTextFromMessageContent(item.message);
            const mediaType = this.mediaTypeFromMessage(item.message || {});

            if (!message && !mediaType) {
                continue;
            }

            const phone = isLid
                ? this.resolveLidToPhone(remoteJid)
                : this.normalizeIncomingPhone(remoteJid);

            if (!phone) {
                this.logger.warn('Nao foi possivel resolver numero do remetente', {
                    sessionId: this.config.runtime.sessionId || null,
                    remoteJid,
                });
                continue;
            }

            const contactJid = `${phone}@s.whatsapp.net`;
            const [avatarUrl, mediaInfo] = await Promise.all([
                this.sock.profilePictureUrl(contactJid, 'image').catch(() => null),
                mediaType ? this.downloadAndSaveMedia(item, mediaType) : Promise.resolve(null),
            ]);

            await this.dispatchIncomingWebhook({
                session_id:     this.config.runtime.sessionId || null,
                phone,
                name:           item.pushName || phone,
                message:        message || '',
                avatar_url:     avatarUrl || null,
                media_type:     mediaInfo?.media_type     || mediaType || null,
                media_url:      mediaInfo?.media_url      || null,
                media_filename: mediaInfo?.media_filename || null,
                media_mime:     mediaInfo?.media_mime     || null,
                sent_at:        this.messageTimestampIso(item),
            });
        }
    }

    messageTimestampIso(item) {
        const raw = item?.messageTimestamp;
        const value = raw && typeof raw.toNumber === 'function'
            ? raw.toNumber()
            : Number(raw);

        if (Number.isFinite(value) && value > 0) {
            const milliseconds = value > 100000000000 ? value : value * 1000;
            return new Date(milliseconds).toISOString();
        }

        return new Date().toISOString();
    }

    async handleConnectionUpdate(socket, update) {
        const { connection, lastDisconnect, qr } = update;

        if (socket !== this.sock) {
            if (connection === 'close') {
                this.logger.info('Ignorando fechamento de socket antigo', {
                    statusCode: lastDisconnect?.error?.output?.statusCode || null,
                });
            }
            return;
        }

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
            const replaced = statusCode === DisconnectReason.connectionReplaced;

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

            if (replaced) {
                this.sock = null;
                this.state.connection = 'replaced';
                this.state.lastError = 'Sessao substituida por outra conexao.';

                this.logger.warn('Sessao WhatsApp substituida por outra conexao', {
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

        if (this.sock?.user || this.state.connection === 'open' || this.state.connection === 'connecting') {
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
                // Numero com 9: tenta SEM o 9 primeiro (numeros antigos migrados pela operadora
                // podem estar registrados no WhatsApp sem o 9; colocar sem-9 na frente evita
                // falsos positivos onde onWhatsApp() retorna true para o numero errado)
                candidates.unshift(
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
                candidates.unshift(
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

    async sendMedia(payload) {
        const { number, mediaPath, mediaType, fileName, mime, caption } = payload;

        this.ensureConnected();

        const normalizedNumber = this.normalizeNumber(number);
        const resolved = await this.resolveRegisteredNumber(normalizedNumber);
        const jid = `${resolved.number}@s.whatsapp.net`;

        const buffer = require('fs').readFileSync(mediaPath);
        let msgContent;

        if (mediaType === 'image') {
            msgContent = { image: buffer, caption: caption || '', mimetype: mime || 'image/jpeg' };
        } else if (mediaType === 'sticker') {
            let stickerBuffer = buffer;
            try {
                stickerBuffer = await prepareStickerBuffer(buffer, mime);
            } catch (error) {
                this.logger.warn('Falha ao preparar figurinha em WebP, enviando arquivo original', { error: error.message });
            }
            msgContent = { sticker: stickerBuffer, mimetype: 'image/webp' };
        } else if (mediaType === 'audio') {
            let audioBuffer = buffer;
            let audioMime = (mime || 'audio/ogg').split(';')[0].trim();
            const originalMime = audioMime;
            // WebM/Opus precisa ser convertido para OGG/Opus para WhatsApp reconhecer como audio de voz
            if (audioMime !== 'audio/ogg' && audioMime !== 'audio/mpeg') {
                let convertedPath = null;
                try {
                    convertedPath = await convertToOgg(mediaPath);
                    audioBuffer = fs.readFileSync(convertedPath);
                    audioMime = 'audio/ogg';
                    this.logger.info('Audio convertido para OGG com sucesso', { from: originalMime });
                } catch (convErr) {
                    this.logger.warn('Falha ao converter audio para OGG, enviando no formato original', { error: convErr.message, originalMime });
                } finally {
                    if (convertedPath) try { fs.unlinkSync(convertedPath); } catch (_) {}
                }
            }
            const finalMime = audioMime === 'audio/ogg' ? 'audio/ogg; codecs=opus' : audioMime;
            msgContent = { audio: audioBuffer, mimetype: finalMime, ptt: true };
        } else if (mediaType === 'video') {
            msgContent = { video: buffer, caption: caption || '', mimetype: mime || 'video/mp4' };
        } else {
            msgContent = { document: buffer, fileName: fileName || 'arquivo', mimetype: mime || 'application/octet-stream' };
        }

        await this.sock.sendMessage(jid, msgContent);

        this.logger.info('Midia enviada', { number: maskPhone(normalizedNumber), mediaType, fileName });

        return { ok: true, status: 'Midia enviada com sucesso!' };
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
