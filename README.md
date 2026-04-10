# Standalone WhatsApp API

Servico Node.js independente do sistema principal. Qualquer projeto pode consumir os endpoints desta API depois, sem depender do Arthrom.

## Documentos

- `README.md`
  Visao tecnica rapida da API.
- [DEPLOY.md](./DEPLOY.md)
  Guia de implantacao, operacao e servico para Linux e Windows.
- `scripts/install-ubuntu.sh`
  Instalador rapido para Ubuntu com `systemd`.
- `scripts/update-ubuntu.sh`
  Atualizador rapido para Ubuntu com backup e reinicio do servico.
- `scripts/install-or-update-windows.ps1`
  Script unico para criar no Windows se nao existir e atualizar se ja existir.

## O que esta base faz

- gerencia a conexao com WhatsApp via Baileys
- expoe endpoints HTTP para status, QR, resolucao de numero, envio e logout
- usa autenticacao por API key
- mantem a sessao em disco para reconectar sem novo pareamento
- grava logs operacionais sem expor o texto da mensagem por padrao
- resolve o formato canonico do numero antes do envio para reduzir tentativas erradas
- limpa logs antigos automaticamente no runtime

## Estrutura de runtime

A API standalone usa estas pastas/arquivos em runtime:

- `runtime/auth/`
  Guarda a sessao conectada do WhatsApp.
- `runtime/cache/numero_cache.json`
  Guarda os numeros ja resolvidos para evitar consultas repetidas.
- `runtime/logs/log_YYYY-MM-DD.log`
  Log estruturado da API.
- `runtime/logs/dev-stdout*.log`
  Log de console do processo, normalmente quando voce sobe manualmente.
- `runtime/logs/dev-stderr*.log`
  Erros de console do processo.

## Politica de limpeza automatica

A API limpa automaticamente apenas logs de runtime. Ela nao apaga sessao conectada nem cache de numeros.

Configuracoes disponiveis:

- `WHATSAPP_LOG_RETENTION_DAYS=15`
  Mantem os arquivos `log_YYYY-MM-DD.log` por 15 dias.
- `WHATSAPP_DEV_LOG_RETENTION_DAYS=7`
  Mantem `dev-stdout*.log` e `dev-stderr*.log` por 7 dias.
- `WHATSAPP_DISABLE_LOG_CLEANUP=false`
  Permite desligar a limpeza automatica se necessario.

## Configuracao

1. Copie `.env.example` para `.env`
2. Defina `WHATSAPP_API_KEY`
3. Ajuste host, porta e runtime se quiser

Exemplo minimo:

```env
WHATSAPP_API_KEY=defina-uma-chave-forte-aqui
WHATSAPP_API_HOST=127.0.0.1
WHATSAPP_API_PORT=3015
WHATSAPP_AUTH_DIR=runtime/auth
WHATSAPP_LOG_DIR=runtime/logs
WHATSAPP_NUMBER_CACHE_FILE=runtime/cache/numero_cache.json
```

## Inicializacao

```bash
npm start
```

## Conectar um numero

Depois de subir a API, abra no navegador:

```text
http://127.0.0.1:3015/connect?key=SUA_CHAVE
```

Essa pagina mostra o QR localmente para pareamento.

## Autenticacao

Use o header:

```http
Authorization: Bearer SUA_CHAVE
```

Tambem e aceito o valor puro no header `Authorization` para compatibilidade. A pagina `/connect` tambem aceita `?key=` na query string.

## Endpoints

### `GET /health`

Nao exige autenticacao. Retorna o estado basico do servico.

Resposta exemplo:

```json
{
  "ok": true,
  "service": "whatsapp-api",
  "connection": "open"
}
```

### `GET /status`

Retorna estado da conexao e dados resumidos da conta conectada.

### `GET /qrcode`

Retorna o QR atual em JSON enquanto a sessao nao estiver conectada.

### `GET /qrcode.svg`

Retorna o QR em SVG para exibir no navegador.

### `GET /connect`

Pagina HTML local para conectar o numero por QR.

### `POST /resolve-number`

Resolve e cacheia o numero canonico antes do envio.

Regras atuais:

- sempre tenta primeiro exatamente o numero informado
- no caso do Brasil, so tenta a variacao com/sem `9` como fallback
- se o numero ja foi resolvido antes, usa cache

Payload:

```json
{
  "number": "554384162658"
}
```

Resposta exemplo:

```json
{
  "normalizedNumber": "554384162658",
  "resolvedNumber": "554384162658",
  "cachedResolution": true,
  "exactMatch": true,
  "candidatesTried": [
    "554384162658"
  ]
}
```

### `POST /send`

Envia uma mensagem de texto.

Payload:

```json
{
  "number": "5543999999999",
  "message": "Ola!"
}
```

Resposta exemplo:

```json
{
  "status": "Mensagem enviada com sucesso!",
  "normalizedNumber": "5543999999999",
  "sentTo": "5543999999999",
  "cachedResolution": false
}
```

### `POST /logout`

Encerra a sessao atual, limpa o diretorio de autenticacao e reinicia o fluxo para gerar um novo QR.

## Fluxo recomendado para evitar bloqueios

Para reduzir tentativas erradas no WhatsApp:

1. consulte `POST /resolve-number`
2. grave o `resolvedNumber` no banco do seu sistema
3. use esse numero resolvido nos envios futuros
4. evite usar `/send` com numeros nunca validados em massa

## O que salvar no sistema integrador

A API mantem um cache tecnico local, mas o dado oficial deve ficar no sistema que consome a API.

Sugestao de campos:

- `telefone_informado`
- `whatsapp_numero_canonico`
- `whatsapp_resolvido_em`
- `whatsapp_status_resolucao`

## Observacoes operacionais

- a sessao do WhatsApp fica em `runtime/auth/`
- se apagar `runtime/auth/`, sera necessario parear de novo
- o cache de numeros fica em `runtime/cache/numero_cache.json`
- apagar o cache nao derruba a sessao, apenas faz a API revalidar numeros
- a API foi desenhada para rodar sozinha e ser chamada por qualquer sistema depois
