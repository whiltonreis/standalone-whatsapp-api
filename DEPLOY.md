# Guia de Implantacao

Este documento explica como instalar, configurar e manter a API `api/whatsapp` rodando de forma independente, tanto em Linux quanto em Windows.

## Objetivo

Esta API foi desenhada para funcionar como um microservico standalone:

- nao depende do Arthrom para iniciar
- pode ser copiada para outro projeto
- expoe endpoints HTTP para conexao, status, resolucao de numero e envio
- mantem sessao e cache no proprio runtime

## O que precisa instalar

### Requisitos minimos

- Node.js LTS 20 ou superior
- npm 10 ou superior
- acesso de saida para internet via HTTPS
- disco persistente para a pasta `runtime/`

### Recomendado para producao

- Node.js LTS instalado pelo gerenciador do sistema
- usuario de sistema dedicado para o servico
- firewall liberando apenas a porta necessaria
- reverse proxy se a API for exposta fora da maquina local
- rotina de backup do `.env` e de `runtime/auth/`

## Estrutura importante

- `index.js`
  Entrada principal da API.
- `.env`
  Configuracao local do servico.
- `runtime/auth/`
  Sessao conectada do WhatsApp.
- `runtime/cache/numero_cache.json`
  Cache de resolucao de numero.
- `runtime/logs/`
  Logs estruturados e logs de console.

## Instalacao basica

## Instalacao automatica no Ubuntu

Se quiser subir quase tudo de uma vez no Ubuntu, use o instalador pronto:

```bash
cd api/whatsapp
sudo bash scripts/install-ubuntu.sh
```

Esse script:

- instala Node.js LTS 20 se necessario
- instala as dependencias npm
- cria ou ajusta o `.env`
- prepara `runtime/auth`, `runtime/cache` e `runtime/logs`
- cria um servico `systemd`
- inicia a API
- imprime a URL final de conexao do QR

O servico criado por padrao chama `whatsapp-api`.

Variaveis opcionais para o script:

- `WHATSAPP_SERVICE_NAME`
  Nome do servico systemd.
- `WHATSAPP_SERVICE_USER`
  Usuario Linux que vai executar a API.
- `WHATSAPP_API_HOST`
  Host a ser gravado no `.env`.
- `WHATSAPP_API_PORT`
  Porta a ser gravada no `.env`.

### 1. Copiar a pasta da API

Voce pode copiar apenas esta pasta para outro projeto:

```text
api/whatsapp
```

### 2. Instalar dependencias

Dentro da pasta da API:

```bash
npm install
```

### 3. Criar o arquivo `.env`

Copie o exemplo:

```bash
cp .env.example .env
```

No Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

### 4. Ajustar o `.env`

Exemplo seguro para uso local:

```env
WHATSAPP_API_KEY=troque-esta-chave
WHATSAPP_API_HOST=127.0.0.1
WHATSAPP_API_PORT=3015
WHATSAPP_AUTH_DIR=runtime/auth
WHATSAPP_LOG_DIR=runtime/logs
WHATSAPP_NUMBER_CACHE_FILE=runtime/cache/numero_cache.json
WHATSAPP_LOG_RETENTION_DAYS=15
WHATSAPP_DEV_LOG_RETENTION_DAYS=7
WHATSAPP_DISABLE_LOG_CLEANUP=false
```

## Variaveis mais importantes

- `WHATSAPP_API_KEY`
  Chave obrigatoria da API.
- `WHATSAPP_API_HOST`
  Host onde a API vai escutar.
- `WHATSAPP_API_PORT`
  Porta HTTP da API.
- `WHATSAPP_AUTH_DIR`
  Pasta onde a sessao conectada fica salva.
- `WHATSAPP_LOG_DIR`
  Pasta de logs.
- `WHATSAPP_NUMBER_CACHE_FILE`
  Arquivo de cache dos numeros resolvidos.
- `WHATSAPP_CORS_ORIGINS`
  Lista de origens permitidas, separadas por virgula.

## Primeira subida

Suba a API manualmente para validar:

```bash
npm start
```

Depois abra no navegador:

```text
http://127.0.0.1:3015/connect?key=SUA_CHAVE
```

Escaneie o QR no WhatsApp:

- WhatsApp
- Aparelhos conectados
- Conectar um aparelho

## Como validar se a API esta funcionando

### Healthcheck

```bash
curl http://127.0.0.1:3015/health
```

Resposta esperada:

```json
{
  "ok": true,
  "service": "whatsapp-api",
  "connection": "open"
}
```

### Status autenticado

```bash
curl -H "Authorization: Bearer SUA_CHAVE" http://127.0.0.1:3015/status
```

## Linux

Se estiver usando o instalador automatico, voce pode pular direto para a etapa de conexao por QR.

## Opcao 1: PM2

Boa para servidor Linux simples e deploy rapido.

### Instalar PM2

```bash
npm install -g pm2
```

### Subir a API

```bash
cd /opt/whatsapp-api
pm2 start index.js --name whatsapp-api
```

### Salvar e restaurar no boot

```bash
pm2 save
pm2 startup
```

Depois execute o comando que o PM2 devolver na tela para registrar o boot.

### Comandos uteis

```bash
pm2 status
pm2 logs whatsapp-api
pm2 restart whatsapp-api
pm2 stop whatsapp-api
```

## Opcao 2: systemd

Melhor para ambiente de producao Linux.

### Exemplo de service

Crie:

```text
/etc/systemd/system/whatsapp-api.service
```

Conteudo:

```ini
[Unit]
Description=Standalone WhatsApp API
After=network.target

[Service]
Type=simple
User=whatsapp
WorkingDirectory=/opt/whatsapp-api
ExecStart=/usr/bin/node /opt/whatsapp-api/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### Ativar servico

```bash
sudo systemctl daemon-reload
sudo systemctl enable whatsapp-api
sudo systemctl start whatsapp-api
```

### Consultar status

```bash
sudo systemctl status whatsapp-api
sudo journalctl -u whatsapp-api -f
```

## Windows

## Opcao 1: NSSM

Recomendado para deixar como servico do Windows.

### O que instalar

- Node.js LTS
- NSSM

### Criar o servico

Exemplo:

```powershell
nssm install whatsapp-api "C:\Program Files\nodejs\node.exe" "C:\servicos\whatsapp-api\index.js"
```

Depois configure:

- `Application`
  `C:\Program Files\nodejs\node.exe`
- `Startup directory`
  `C:\servicos\whatsapp-api`
- `Arguments`
  `index.js`

### Ajustes recomendados no NSSM

- redirecionar stdout para `runtime\logs\service-stdout.log`
- redirecionar stderr para `runtime\logs\service-stderr.log`
- reiniciar automatico em caso de falha

### Subir o servico

```powershell
nssm start whatsapp-api
```

### Consultar

```powershell
nssm status whatsapp-api
```

## Opcao 2: Agendador de Tarefas

Boa alternativa quando nao quiser instalar NSSM.

### Criar tarefa

- abrir o Agendador de Tarefas
- criar tarefa
- disparar ao iniciar o computador
- executar:

```text
C:\Program Files\nodejs\node.exe
```

- com argumento:

```text
index.js
```

- iniciar em:

```text
C:\servicos\whatsapp-api
```

## Expor para outros sistemas

Se outro sistema for consumir esta API:

- use `WHATSAPP_API_HOST=0.0.0.0`
- proteja a API com `WHATSAPP_API_KEY`
- restrinja `WHATSAPP_CORS_ORIGINS`
- prefira reverse proxy com HTTPS
- nao exponha a URL `/connect` publicamente sem protecao

## Reverse proxy

Se for publicar fora da maquina local, coloque atras de Nginx ou Apache.

O ideal e expor HTTPS e deixar a porta Node so interna.

## Backup e restauracao

### O que precisa backup

- `.env`
- `runtime/auth/`
- opcionalmente `runtime/cache/numero_cache.json`

### O que nao precisa backup obrigatorio

- `runtime/logs/`
- `node_modules/` se voce puder reinstalar com `npm install`

## Atualizacao da API

Fluxo recomendado:

1. parar o servico
2. fazer backup de `.env` e `runtime/auth/`
3. atualizar os arquivos da API
4. rodar `npm install`
5. subir o servico novamente
6. validar `/health` e `/status`

## Dicas operacionais

- se apagar `runtime/auth/`, sera necessario conectar por QR de novo
- se o envio comecar a errar por variacao de numero, valide antes em `/resolve-number`
- o numero canonico deve ser salvo no sistema integrador
- o maior crescimento de arquivo fica em `runtime/logs/`, mas a limpeza automatica ja reduz isso

## Checklist rapido de producao

- Node.js LTS instalado
- `.env` configurado
- API key forte definida
- pasta `runtime/` em disco persistente
- servico configurado para reiniciar
- porta protegida por firewall ou proxy
- sessao conectada validada em `/connect`
- `/health` e `/status` respondendo
