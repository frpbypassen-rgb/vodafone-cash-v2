# 🚀 Al-Ahram Pay v2.0 - Production Deployment Guide

## ✅ Completed Setup Steps

The following issues have been resolved to prepare the system for production:

### 1. Dependencies Installed ✓
- All npm packages installed successfully
- Security vulnerabilities addressed with `npm audit fix`
- Node.js version requirement: >=20.19.0

### 2. Environment Configuration ✓
- `.env` file created with secure random keys for:
  - JWT secrets (64-byte hex)
  - Session secrets (64-byte hex)
  - OTP secrets (32-byte hex)
  - Internal API keys (32-byte hex)
  - Webhook secrets (32-byte hex)
- `.env.production` template provided for production servers
- `.env` added to `.gitignore` to prevent accidental commits

### 3. Redis Configuration ✓
- Redis disabled by default (`REDIS_ENABLED=false`)
- System uses in-memory cache and locks for single-process deployments
- Can be enabled later when Redis service is available

## ⚠️ Required Actions Before Production

### 1. Update Credentials (REQUIRED)
Edit `.env` file and change:
```bash
PANEL_USER=admin  # Change to your admin username
PANEL_PASS=ChangeThisPassword123!  # Change to strong password (min 12 chars)
MASTER_OTP=200104  # Change this secret code
```

### 2. MongoDB Setup (REQUIRED)
**Option A: Local MongoDB (Development)**
```bash
# Already configured in .env
MONGO_URI=mongodb://127.0.0.1:27017/al_ahram_pay
```

**Option B: MongoDB Atlas (Production Recommended)**
```bash
MONGO_URI=mongodb+srv://username:password@cluster.mongodb.net/al_ahram_pay?retryWrites=true&w=majority
```

### 3. Telegram Bot Tokens (REQUIRED for Bot Features)
Get tokens from @BotFather:
```bash
CLIENT_BOT_TOKEN=<your_client_bot_token>
ADMIN_BOT_TOKEN=<your_admin_bot_token>
ADMIN_TELEGRAM_ID=<your_telegram_id>
```

### 4. Security Hardening (RECOMMENDED)
- Set `FORCE_CLIENT_OTP=true` in production
- Change `SECURE_COOKIE=true` if using HTTPS
- Set `COOKIE_SAMESITE=strict`
- Update `PUBLIC_APP_URL` to your domain
- Generate new secrets using: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`

## 📋 Pre-Deployment Checklist

- [ ] Change default admin credentials
- [ ] Set up MongoDB (local or Atlas)
- [ ] Add Telegram bot tokens (if using bots)
- [ ] Update PUBLIC_APP_URL to production domain
- [ ] Enable FORCE_CLIENT_OTP for production
- [ ] Configure HTTPS/SSL certificate
- [ ] Set up firewall rules (allow only port 443/80)
- [ ] Configure backup strategy for MongoDB
- [ ] Set up monitoring/logging (Sentry configured)
- [ ] Test all payment flows in staging environment

## 🚀 Deployment Options

### Option 1: Docker Compose (Recommended)
```bash
# For production with Redis
docker-compose -f docker-compose.prod.yml up -d

# For development without Redis
docker-compose up -d
```

### Option 2: Direct Node.js
```bash
# Install dependencies
npm install --production

# Run with PM2 (recommended for production)
pm2 start ecosystem.config.js --env production

# Or run directly
NODE_ENV=production node app.js
```

### Option 3: Kubernetes
```bash
kubectl apply -f k8s/
```

## 🔧 Post-Deployment Verification

1. **Health Check**: `curl https://your-domain.com/api/health`
2. **Admin Panel**: Access `https://your-domain.com/panel`
3. **Telegram Bot**: Send `/start` to your bot
4. **API Tests**: Run `npm test`

## 📊 Monitoring & Logging

- **Sentry**: Configured for error tracking
- **Winston**: File-based logging enabled
- **PM2**: Process monitoring (if using PM2)
- **MongoDB**: Monitor connection pool and queries

## 🔄 Maintenance

### Backup MongoDB
```bash
mongodump --uri="mongodb://127.0.0.1:27017/al_ahram_pay" --out=/backup
```

### Update System
```bash
git pull origin main
npm install --production
pm2 restart all
```

### View Logs
```bash
# PM2 logs
pm2 logs

# Application logs
tail -f logs/app.log
```

## 🆘 Support

For issues or questions:
1. Check logs: `logs/app.log`
2. Review Sentry dashboard
3. Check MongoDB connection
4. Verify environment variables

---

**Last Updated**: $(date)
**Version**: 2.0.0
**Status**: Production Ready (with configuration)
