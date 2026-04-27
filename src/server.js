'use strict';

const cors = require('cors');
const express = require('express');
const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');

const { config, assertConfig } = require('./config');
const { createLogger } = require('./logger');
const { HttpError } = require('./whatsapp-service');
const { SessionManager, DEFAULT_SESSION_ID } = require('./session-manager');

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function extractToken(req) {
    const queryKey = typeof req.query?.key === 'string' ? req.query.key.trim() : '';

    if (queryKey) {
        return queryKey;
    }

    const raw = String(req.headers.authorization || '').trim();

    if (!raw) {
        return '';
    }

    if (/^Bearer\s+/i.test(raw)) {
        return raw.replace(/^Bearer\s+/i, '').trim();
    }

    return raw;
}

function buildCorsOptions() {
    return {
        origin(origin, callback) {
            if (!origin) {
                return callback(null, true);
            }

            const allowedOrigins = config.api.corsOrigins;

            if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
                return callback(null, true);
            }

            return callback(new HttpError(403, 'Origem nao autorizada pelo CORS.'));
        },
        methods: ['GET', 'POST'],
        allowedHeaders: ['Authorization', 'Content-Type'],
        credentials: false,
    };
}

function buildQrSvg(text) {
    const qr = new QRCode(-1, QRErrorCorrectLevel.L);
    const cellSize = 8;
    const margin = 4;

    qr.addData(text);
    qr.make();

    const moduleCount = qr.getModuleCount();
    const canvasSize = (moduleCount + margin * 2) * cellSize;
    let body = '';

    for (let row = 0; row < moduleCount; row += 1) {
        for (let col = 0; col < moduleCount; col += 1) {
            if (!qr.modules[row][col]) {
                continue;
            }

            body += `<rect x="${(col + margin) * cellSize}" y="${(row + margin) * cellSize}" width="${cellSize}" height="${cellSize}" />`;
        }
    }

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvasSize} ${canvasSize}" width="${canvasSize}" height="${canvasSize}" shape-rendering="crispEdges">`,
        `<rect width="${canvasSize}" height="${canvasSize}" fill="#ffffff"/>`,
        `<g fill="#111827">${body}</g>`,
        '</svg>',
    ].join('');
}

function renderConnectPage() {
    const token = escapeHtml(config.api.key);

    return `<!doctype html>
<html lang="pt-BR">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Conectar WhatsApp</title>
    <style>
        :root {
            color-scheme: dark;
            --bg: #0f172a;
            --panel: #17233a;
            --panel-soft: #1e2b44;
            --border: #294160;
            --text: #f8fafc;
            --muted: #9fb1c9;
            --accent: #2f6fb3;
            --success: #22c55e;
            --warning: #f59e0b;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            padding: 24px;
            background: radial-gradient(circle at top, #1b2a44 0, var(--bg) 48%);
            color: var(--text);
            font-family: "Segoe UI", Tahoma, sans-serif;
        }
        .connect-card {
            width: min(100%, 540px);
            background: rgba(23, 35, 58, 0.96);
            border: 1px solid var(--border);
            border-radius: 24px;
            padding: 24px;
            box-shadow: 0 24px 60px rgba(15, 23, 42, 0.45);
        }
        .connect-title {
            margin: 0 0 8px;
            font-size: 1.75rem;
            font-weight: 700;
        }
        .connect-subtitle {
            margin: 0 0 18px;
            color: var(--muted);
            line-height: 1.6;
        }
        .connect-status {
            display: inline-flex;
            align-items: center;
            gap: 10px;
            min-height: 44px;
            padding: 10px 14px;
            border-radius: 999px;
            background: rgba(30, 43, 68, 0.9);
            border: 1px solid var(--border);
            color: var(--text);
            font-weight: 600;
        }
        .connect-status::before {
            content: "";
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: var(--warning);
            box-shadow: 0 0 0 6px rgba(245, 158, 11, 0.12);
        }
        .connect-status[data-state="open"]::before {
            background: var(--success);
            box-shadow: 0 0 0 6px rgba(34, 197, 94, 0.12);
        }
        .connect-status[data-state="qr_ready"]::before {
            background: var(--accent);
            box-shadow: 0 0 0 6px rgba(47, 111, 179, 0.12);
        }
        .connect-qr-shell {
            margin-top: 20px;
            min-height: 336px;
            display: grid;
            place-items: center;
            padding: 24px;
            background: var(--panel-soft);
            border: 1px solid var(--border);
            border-radius: 20px;
        }
        .connect-qr-image {
            width: min(100%, 320px);
            height: auto;
            display: none;
            background: #ffffff;
            border-radius: 16px;
            padding: 16px;
        }
        .connect-qr-image.is-visible {
            display: block;
        }
        .connect-placeholder {
            text-align: center;
            color: var(--muted);
            line-height: 1.7;
            max-width: 320px;
        }
        .connect-placeholder strong {
            color: var(--text);
            display: block;
            margin-bottom: 8px;
            font-size: 1.05rem;
        }
        .connect-meta {
            margin-top: 18px;
            color: var(--muted);
            font-size: 0.95rem;
        }
        .connect-meta code {
            color: var(--text);
            background: rgba(15, 23, 42, 0.7);
            border: 1px solid var(--border);
            border-radius: 10px;
            padding: 2px 8px;
        }
    </style>
</head>
<body>
    <main class="connect-card">
        <h1 class="connect-title">Conectar numero no WhatsApp</h1>
        <p class="connect-subtitle">Abra o WhatsApp no celular, entre em <strong>Aparelhos conectados</strong> e escaneie o QR abaixo. A pagina se atualiza sozinha.</p>
        <div id="status" class="connect-status" data-state="connecting">Carregando status...</div>
        <section class="connect-qr-shell">
            <img id="qr-image" class="connect-qr-image" alt="QR Code para conectar o WhatsApp">
            <div id="placeholder" class="connect-placeholder">
                <strong>Preparando o QR Code</strong>
                Aguarde alguns segundos enquanto a API inicializa a sessao do WhatsApp.
            </div>
        </section>
        <p id="meta" class="connect-meta">API local: <code>http://${escapeHtml(config.api.host)}:${escapeHtml(config.api.port)}</code></p>
    </main>

    <script>
        const apiKey = ${JSON.stringify(token)};
        const qrImage = document.getElementById('qr-image');
        const placeholder = document.getElementById('placeholder');
        const statusNode = document.getElementById('status');
        const metaNode = document.getElementById('meta');

        async function fetchJson(url) {
            const response = await fetch(url, {
                headers: {
                    Authorization: 'Bearer ' + apiKey
                },
                cache: 'no-store'
            });

            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                throw new Error(data.error || 'Falha ao consultar a API.');
            }

            return data;
        }

        function setPlaceholder(title, text) {
            placeholder.innerHTML = '<strong>' + title + '</strong>' + text;
            placeholder.style.display = 'block';
            qrImage.classList.remove('is-visible');
            qrImage.removeAttribute('src');
        }

        async function refresh() {
            try {
                const status = await fetchJson('/status');
                statusNode.dataset.state = status.connection || 'connecting';

                if (status.connected) {
                    statusNode.textContent = 'Conectado';
                    setPlaceholder('Numero conectado com sucesso', 'A sessao do WhatsApp foi vinculada. Esta pagina pode ser fechada.');
                    metaNode.innerHTML = 'Usuario conectado: <code>' + (status.user?.id || 'desconhecido') + '</code>';
                    return;
                }

                if (status.hasQr) {
                    statusNode.textContent = 'QR pronto para escanear';
                    qrImage.src = '/qrcode.svg?key=' + encodeURIComponent(apiKey) + '&t=' + Date.now();
                    qrImage.classList.add('is-visible');
                    placeholder.style.display = 'none';
                    metaNode.innerHTML = 'Estado atual: <code>' + (status.connection || 'desconhecido') + '</code>';
                    return;
                }

                statusNode.textContent = 'Aguardando QR';
                setPlaceholder('Ainda sem QR Code', 'A API esta conectando ao WhatsApp. Se demorar demais, confira os logs do servico.');
                metaNode.innerHTML = 'Estado atual: <code>' + (status.connection || 'desconhecido') + '</code>';
            } catch (error) {
                statusNode.dataset.state = 'error';
                statusNode.textContent = 'Falha ao consultar a API';
                setPlaceholder('Nao foi possivel carregar o QR', error.message);
                metaNode.innerHTML = 'Confira se o servico esta rodando e se a chave da API esta correta.';
            }
        }

        refresh();
        setInterval(refresh, 5000);
    </script>
</body>
</html>`;
}

function authMiddleware(req, res, next) {
    if (req.method === 'OPTIONS' || !config.auth.enabled || req.path === '/health') {
        return next();
    }

    const token = extractToken(req);

    if (!token || token !== config.api.key) {
        return res.status(401).json({ error: 'Nao autorizado.' });
    }

    return next();
}

function asyncHandler(handler) {
    return (req, res, next) => {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}

function attachShutdown(server, sessionManager, logger) {
    const shutdown = async (signal) => {
        logger.warn('Encerrando a API WhatsApp', { signal });
        await sessionManager.stopAll();

        await new Promise((resolve) => {
            server.close(resolve);
        });

        process.exit(0);
    };

    ['SIGINT', 'SIGTERM'].forEach((signal) => {
        process.once(signal, () => {
            shutdown(signal).catch((error) => {
                console.error(`[whatsapp-api] Falha ao encerrar: ${error.message}`);
                process.exit(1);
            });
        });
    });
}

async function startServer() {
    assertConfig();

    const logger = createLogger({
        logDir: config.runtime.logDir,
        cleanupEnabled: config.logs.cleanupEnabled,
        retentionDays: config.logs.retentionDays,
        devRetentionDays: config.logs.devRetentionDays,
    });

    const sessionManager = new SessionManager(config, logger);
    await sessionManager.start(DEFAULT_SESSION_ID);
    await sessionManager.autoStartSavedSessions();

    const app = express();
    app.disable('x-powered-by');
    app.use(cors(buildCorsOptions()));
    app.use(express.json({ limit: config.api.bodyLimit }));

    // ── Legacy single-session routes (backward compat → default session) ──

    app.get('/connect', (req, res) => {
        if (config.auth.enabled && extractToken(req) !== config.api.key) {
            return res.status(401).send('Nao autorizado.');
        }

        res.type('html').send(renderConnectPage());
    });

    app.get('/qrcode.svg', (req, res) => {
        if (config.auth.enabled && extractToken(req) !== config.api.key) {
            return res.status(401).send('Nao autorizado.');
        }

        const service = sessionManager.get(DEFAULT_SESSION_ID);
        const qr = service ? service.getQr() : null;

        if (!qr) {
            return res.status(404).send('QR Code nao disponivel.');
        }

        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.type('image/svg+xml').send(buildQrSvg(qr));
    });

    app.use(authMiddleware);

    app.get('/health', (req, res) => {
        const service = sessionManager.get(DEFAULT_SESSION_ID);
        res.json({
            ok: true,
            service: 'whatsapp-api',
            connection: service ? service.getStatus().connection : 'idle',
        });
    });

    app.get('/status', (req, res) => {
        const service = sessionManager.get(DEFAULT_SESSION_ID);
        res.json(service ? service.getStatus() : { connection: 'idle', connected: false, hasQr: false });
    });

    app.get('/qrcode', (req, res) => {
        const service = sessionManager.get(DEFAULT_SESSION_ID);
        const qr = service ? service.getQr() : null;

        if (!qr) {
            return res.status(404).json({ error: 'QR Code nao disponivel ou sessao ja conectada.' });
        }

        return res.json({ qr });
    });

    app.post('/send', asyncHandler(async (req, res) => {
        const service = sessionManager.get(DEFAULT_SESSION_ID);
        if (!service) return res.status(503).json({ error: 'Sessao padrao nao iniciada.' });
        const result = await service.sendText(req.body || {});
        res.json(result);
    }));

    app.post('/send-media', asyncHandler(async (req, res) => {
        const service = sessionManager.get(DEFAULT_SESSION_ID);
        if (!service) return res.status(503).json({ error: 'Sessao padrao nao iniciada.' });
        const result = await service.sendMedia(req.body || {});
        res.json(result);
    }));

    app.post('/resolve-number', asyncHandler(async (req, res) => {
        const service = sessionManager.get(DEFAULT_SESSION_ID);
        if (!service) return res.status(503).json({ error: 'Sessao padrao nao iniciada.' });
        const result = await service.resolveNumber(req.body || {});
        res.json(result);
    }));

    app.post('/delete-message', asyncHandler(async (req, res) => {
        const service = sessionManager.get(DEFAULT_SESSION_ID);
        if (!service) return res.status(503).json({ error: 'Sessao padrao nao iniciada.' });
        const result = await service.deleteMessage(req.body || {});
        res.json(result);
    }));

    app.post('/send-reaction', asyncHandler(async (req, res) => {
        const service = sessionManager.get(DEFAULT_SESSION_ID);
        if (!service) return res.status(503).json({ error: 'Sessao padrao nao iniciada.' });
        const result = await service.sendReaction(req.body || {});
        res.json(result);
    }));

    app.post('/logout', asyncHandler(async (req, res) => {
        const service = sessionManager.get(DEFAULT_SESSION_ID);
        if (!service) return res.status(503).json({ error: 'Sessao padrao nao iniciada.' });
        const result = await service.logout();
        res.json(result);
    }));

    // ── Multi-session routes ──

    app.get('/sessions', (req, res) => {
        res.json(sessionManager.list());
    });

    app.post('/sessions/:id/start', asyncHandler(async (req, res) => {
        const sessionId = req.params.id;
        await sessionManager.start(sessionId);
        res.json({ ok: true, sessionId });
    }));

    app.get('/sessions/:id/status', (req, res) => {
        const service = sessionManager.get(req.params.id);

        if (!service) {
            return res.status(404).json({ error: 'Sessao nao encontrada.' });
        }

        res.json(service.getStatus());
    });

    app.get('/sessions/:id/qrcode.svg', (req, res) => {
        if (config.auth.enabled && extractToken(req) !== config.api.key) {
            return res.status(401).send('Nao autorizado.');
        }

        const service = sessionManager.get(req.params.id);

        if (!service) {
            return res.status(404).send('Sessao nao encontrada.');
        }

        const qr = service.getQr();

        if (!qr) {
            return res.status(404).send('QR Code nao disponivel.');
        }

        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.type('image/svg+xml').send(buildQrSvg(qr));
    });

    app.post('/sessions/:id/send', asyncHandler(async (req, res) => {
        const service = sessionManager.get(req.params.id);

        if (!service) {
            return res.status(404).json({ error: 'Sessao nao encontrada.' });
        }

        const result = await service.sendText(req.body || {});
        res.json(result);
    }));

    app.post('/sessions/:id/send-media', asyncHandler(async (req, res) => {
        const service = sessionManager.get(req.params.id);

        if (!service) {
            return res.status(404).json({ error: 'Sessao nao encontrada.' });
        }

        const result = await service.sendMedia(req.body || {});
        res.json(result);
    }));

    app.post('/sessions/:id/delete-message', asyncHandler(async (req, res) => {
        const service = sessionManager.get(req.params.id);
        if (!service) return res.status(404).json({ error: 'Sessao nao encontrada.' });
        const result = await service.deleteMessage(req.body || {});
        res.json(result);
    }));

    app.post('/sessions/:id/send-reaction', asyncHandler(async (req, res) => {
        const service = sessionManager.get(req.params.id);
        if (!service) return res.status(404).json({ error: 'Sessao nao encontrada.' });
        const result = await service.sendReaction(req.body || {});
        res.json(result);
    }));

    app.post('/sessions/:id/logout', asyncHandler(async (req, res) => {
        const service = sessionManager.get(req.params.id);

        if (!service) {
            return res.status(404).json({ error: 'Sessao nao encontrada.' });
        }

        const result = await service.logout();
        res.json(result);
    }));

    app.use((req, res) => {
        res.status(404).json({ error: 'Endpoint nao encontrado.' });
    });

    app.use((error, req, res, next) => {
        const status = error.status || 500;

        if (status >= 500) {
            logger.error('Erro interno na API WhatsApp', {
                method: req.method,
                path: req.path,
                error: error.message,
            });
        } else {
            logger.warn('Falha de requisicao na API WhatsApp', {
                method: req.method,
                path: req.path,
                error: error.message,
                status,
            });
        }

        res.status(status).json({
            error: error.message || 'Erro interno da API WhatsApp.',
            ...(error.details ? { details: error.details } : {}),
        });
    });

    const server = app.listen(config.api.port, config.api.host, () => {
        logger.info('API WhatsApp pronta para receber requisicoes', {
            host: config.api.host,
            port: config.api.port,
        });
    });

    attachShutdown(server, sessionManager, logger);

    return { app, server, sessionManager, logger };
}

module.exports = {
    startServer,
};
