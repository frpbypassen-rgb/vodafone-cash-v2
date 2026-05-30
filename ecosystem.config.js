module.exports = {
  apps: [
    {
      name: "Ahram_Core_API",
      script: "./app.js",
      instances: "max", // استغلال كافة أنوية المعالج (Cluster Mode)
      exec_mode: "cluster",
      watch: false,
      max_memory_restart: "1G", // إعادة تشغيل تلقائية إذا استهلك الرام لحماية السيرفر
      env: {
        NODE_ENV: "development",
      },
      env_production: {
        NODE_ENV: "production",
      }
    }
  ]
};