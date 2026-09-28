const { PRODUCTION_SECURITY_FLAGS } = require('./config/productionSecurityDefaults');

module.exports = {
  apps: [
    {
      name: "Ahram_Core_API",
      script: "./app.js",
      // Production requires Redis (`REDIS_REQUIRED=true`). One process still
      // keeps cron and Socket.IO simple; Redis holds cache, locks, and pub/sub.
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
        ...PRODUCTION_SECURITY_FLAGS,
        // Emergency OTP / standalone-write / device-binding break-glass stays
        // in `.env` only. Pinning those keys here would override a time-limited
        // .env window.
        OTP_RESEND_COOLDOWN_SECONDS: "60",
        TRUST_PROXY_HTTPS: "true",
        TENANT_MODE: "single",
        APP_INSTANCE_COUNT: "1",
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
