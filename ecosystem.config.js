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
        // Client OTP is deliberately disabled by the system owner until it is re-enabled.
        CLIENT_OTP_ENABLED: "false",
        CLIENT_OTP_DISABLED_REASON: "Temporary operational access requested by system owner",
        FORCE_CLIENT_OTP: "false",
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
        // Temporary guarded fallback while the production MongoDB instance is converted to a replica set.
        EMERGENCY_STANDALONE_FINANCIAL_WRITES: "true",
        EMERGENCY_STANDALONE_FINANCIAL_WRITES_EXPIRES_AT: "2026-08-21T19:45:00Z",
        EMERGENCY_STANDALONE_FINANCIAL_WRITES_REASON: "Production MongoDB replica set incident",
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
