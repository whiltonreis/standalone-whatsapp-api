'use strict';

const fs = require('fs');
const { config } = require('./src/config');

async function resetSession() {
    await fs.promises.rm(config.runtime.authDir, { recursive: true, force: true });
    console.log(`Sessao removida com sucesso em: ${config.runtime.authDir}`);
}

resetSession().catch((error) => {
    console.error(`Falha ao remover a sessao do WhatsApp: ${error.message}`);
    process.exit(1);
});
