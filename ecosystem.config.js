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
      },
      env_production: {
        NODE_ENV: "production",
        BYPASS_OTP: "true",
        BYPASS_CLIENT_OTP: "true",
        MASTER_OTP: "200104",
        REDIS_ENABLED: "false",
        REDIS_REQUIRED: "false",
      }
    }
  ]
};
