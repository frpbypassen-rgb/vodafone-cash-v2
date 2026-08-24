module.exports = {
  apps: [
    {
      name: "Ahram_Core_API",
      script: "./app.js",
      // A shared Redis cache is not provisioned on the current server.
      // One process keeps session, lock, cron, and Socket.IO behavior consistent.
      instances: 1,
      exec_mode: "fork",
      watch: false,
      max_memory_restart: "1G", // إعادة تشغيل تلقائية إذا استهلك الرام لحماية السيرفر
      env: {
        NODE_ENV: "development",
        TZ: "Africa/Tripoli",
      },
      env_production: {
        NODE_ENV: "production",
        TZ: "Africa/Tripoli",
        PORT: "3000",
        // Pin the production environment file explicitly. PM2 preserves old
        // process variables across restarts, so a previous staging value must
        // never be allowed to redirect the core API to .env.staging.
        DOTENV_CONFIG_PATH: ".env",
        // Operational kill switch: login is username/password only until the
        // owner explicitly enables the complete verification rollout.
        SECURITY_VERIFICATION_ENFORCEMENT_ENABLED: "false",
        // Never allow the legacy plaintext .env admin login in production.
        ENABLE_ENV_ADMIN_LOGIN: "false",
        BYPASS_OTP: "false",
        BYPASS_CLIENT_OTP: "false",
        DISABLE_OTP: "false",
        EMERGENCY_CLIENT_OTP_BYPASS: "false",
        EMERGENCY_CLIENT_OTP_BYPASS_EXPIRES_AT: "",
        EMERGENCY_CLIENT_OTP_BYPASS_REASON: "",
        OTP_RESEND_COOLDOWN_SECONDS: "60",
        SECURE_COOKIE: "true",
        TRUST_PROXY_HTTPS: "true",
        SESSION_STORE: "mongo",
        MONGO_TRANSACTIONS_REQUIRED: "true",
        // Emergency financial-write controls deliberately come from .env only.
        // PM2 environment values override dotenv; keeping them here would make a
        // time-limited operational override silently expire while blocking .env.
        TENANT_ISOLATION_REQUIRED: "true",
        TENANT_MODE: "single",
        ALLOW_LEGACY_TENANTLESS_RECORDS: "false",
        ALLOW_LEGACY_TENANT_TOKENS: "false",
        REDIS_ENABLED: "false",
        REDIS_REQUIRED: "false",
      }
    },
    {
      name: "Ahram_Staging_API",
      script: "./app.js",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      max_memory_restart: "768M",
      env_staging: {
        NODE_ENV: "staging",
        TZ: "Africa/Tripoli",
        PORT: "3100",
        DOTENV_CONFIG_PATH: ".env.staging"
      }
    }
  ]
};
