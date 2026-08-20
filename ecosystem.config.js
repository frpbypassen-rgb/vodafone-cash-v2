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
        FORCE_CLIENT_OTP: "true",
        BYPASS_OTP: "false",
        BYPASS_CLIENT_OTP: "false",
        DISABLE_OTP: "false",
        SECURE_COOKIE: "true",
        TRUST_PROXY_HTTPS: "true",
        SESSION_STORE: "mongo",
        MONGO_TRANSACTIONS_REQUIRED: "true",
        TENANT_ISOLATION_REQUIRED: "true",
        TENANT_MODE: "single",
        ALLOW_LEGACY_TENANTLESS_RECORDS: "false",
        ALLOW_LEGACY_TENANT_TOKENS: "false",
        REDIS_ENABLED: "false",
        REDIS_REQUIRED: "false",
      }
    }
  ]
};
