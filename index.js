'use strict';

const { startServer } = require('./src/server');

startServer().catch((error) => {
    console.error(`[whatsapp-api] Falha fatal ao iniciar o servico: ${error.message}`);
    process.exit(1);
});
