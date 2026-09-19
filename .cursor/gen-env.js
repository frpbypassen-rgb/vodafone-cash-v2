'use strict';

// Generates a local development .env for the Cloud Agent environment.
// Secrets are random and dev-only. Never used for production.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const rand = (n = 64) => crypto.randomBytes(n).toString('hex');
const envPath = path.join(__dirname, '..', '.env');

if (fs.existsSync(envPath)) {
    console.log('.env already exists; not overwriting');
    process.exit(0);
}

const contents = `# Local Cloud Agent development environment (auto-generated). Not for production.
TZ=Africa/Tripoli
NODE_ENV=development
PORT=3000

# Database (single-node replica set rs0 for financial transactions)
MONGO_URI=mongodb://127.0.0.1:27017/vodafone_cash_system?replicaSet=rs0
MONGO_TRANSACTIONS_REQUIRED=true

# Auth / crypto secrets (dev-only, randomly generated)
JWT_SECRET=${rand()}
JWT_REFRESH_SECRET=${rand()}
SESSION_SECRET=${rand()}
OTP_SECRET=${rand()}
SECURITY_DEVICE_HASH_SECRET=${rand(32)}
RECEIPT_SHARE_SECRET=${rand(32)}
INTERNAL_API_KEY=${rand(32)}
TENANT_ROUTING_SECRET=${rand(32)}

# Login mode: password-only for simple local development
PASSWORD_ONLY_LOGIN_MODE=true
SECURITY_VERIFICATION_ENFORCEMENT_ENABLED=false
SECURITY_VERIFICATION_MODE=optional
PASSKEY_REQUIRED=false
CLIENT_OTP_ENABLED=false
CLIENT_OTP_DISABLED_REASON=Local development environment

# Environment-based admin login for local development
ENABLE_ENV_ADMIN_LOGIN=true
PANEL_USER=admin
PANEL_PASS=Admin@Dev12345

# Session store
SESSION_STORE=mongo
SECURE_COOKIE=false
COOKIE_SAMESITE=lax

# Redis: in-memory fallback for single-process local dev
REDIS_ENABLED=false
REDIS_REQUIRED=false
APP_INSTANCE_COUNT=1

# Tenant isolation (single tenant for local dev)
TENANT_ISOLATION_REQUIRED=true
TENANT_MODE=single
DEFAULT_TENANT_SLUG=ahram
DEFAULT_TENANT_NAME=Al-Ahram Pay (Dev)
ALLOW_LEGACY_TENANTLESS_RECORDS=false
ALLOW_LEGACY_TENANT_TOKENS=false

# CORS / URLs
ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
PUBLIC_APP_URL=http://127.0.0.1:3000

# Optional integrations disabled for local dev
WHATCHIMP_ENABLED=false
FCM_ENABLED=false
BUSINESS_ASSISTANT_AI_ENABLED=false
GLOBAL_RATE_LIMIT_MAX=5000
`;

fs.writeFileSync(envPath, contents);
console.log('.env generated for local development');
