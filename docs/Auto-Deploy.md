# Auto Deploy

The repository deploys automatically on every push to `main` through
`.github/workflows/deploy.yml`.

## Required GitHub Secrets

Open the repository on GitHub, then go to:

`Settings -> Secrets and variables -> Actions -> New repository secret`

Add these secrets:

- `DEPLOY_HOST`: server IP address or hostname.
- `DEPLOY_USER`: SSH user on the server.
- `DEPLOY_PORT`: SSH port. Use `22` if unsure.
- `DEPLOY_SSH_KEY`: private SSH key allowed to connect to the server.
- `DEPLOY_PATH`: absolute app path on the server, for example `/var/www/vodafone-cash-v2`.

Add one restart method:

- `DEPLOY_RESTART_COMMAND`: full command to restart the app, for example:
  `pm2 reload ecosystem.config.js --env production || pm2 start ecosystem.config.js --env production`

Or:

- `DEPLOY_SYSTEMD_SERVICE`: systemd service name, for example `vodafone-cash`.

## Server Requirements

Install these on the server:

- Git
- Node.js 20.19 or newer
- npm
- MongoDB or a reachable MongoDB connection in `.env`
- pm2 or a systemd service for restarting the app

## First Server Setup

```bash
sudo mkdir -p /var/www
sudo chown -R "$USER":"$USER" /var/www

git clone https://github.com/frpbypassen-rgb/vodafone-cash-v2.git /var/www/vodafone-cash-v2
cd /var/www/vodafone-cash-v2
cp .env.example .env
npm ci --omit=dev
```

Edit `.env` on the server with real production values before enabling deployment.
