// PM2 supplies DOTENV_CONFIG_PATH for isolated environments such as staging.
// Production keeps the existing default of .env.
require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });
const { assertProductionSecurityEnv, isPasswordOnlyLoginMode } = require('./config/securityPolicy');
assertProductionSecurityEnv();
const { SYSTEM_TIME_ZONE } = require('./config/systemTime');
const { getAllowedOrigins, getMobileAllowedOrigins } = require('./config/corsOrigins');
require('ts-node').register({
    transpileOnly: true,
    compilerOptions: { module: 'CommonJS' }
});
const Sentry = require('@sentry/node');

if (process.env.SENTRY_DSN) {
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.NODE_ENV || 'production',
        tracesSampleRate: 0.1
    });
    console.log('✅ Sentry error tracking initialized successfully');
}

const express = require('express');
const session = require('express-session');
const mongoose = require('mongoose');
const path = require('path');
const cron = require('node-cron');
const https = require('https'); 
const http = require('http'); // 🟢 للإقلاع مع الـ Sockets
const { Server } = require('socket.io'); // 🟢 خادم الزمن الفعلي
const rateLimit = require('express-rate-limit'); // 🟢 جدار الحماية
const helmet = require('helmet'); // 🟢 حماية الهيدرز
const cors = require('cors');
const multer = require('multer');

// 🟢 إعداد رفع الملفات في مجلد التخزين مع فحص نوع الملف
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
        if (allowedMimeTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('نوع الملف غير مسموح به. يُقبل فقط: JPEG, PNG, WEBP, GIF'), false);
        }
    }
});

const connectDB = require('./config/database');
const { initRedis } = require('./config/redis');
const { requireAuth, requireMaster } = require('./middlewares/auth');
const { errorHandler, notFoundHandler } = require('./middlewares/errorHandler');
const requestLogger = require('./middlewares/requestLogger');
const { metricsMiddleware, metricsEndpoint } = require('./middlewares/metrics');
const {
    isAuthorizedOperationalSocket,
    requireOperationalAccess
} = require('./middlewares/operationalAccess');
const csrfProtection = require('./middlewares/csrfProtection');
const logger = require('./utils/logger');
const { startApiCompletionMonitor } = require('./services/apiExecutionLifecycleService');
const {
    ensureApiReconciliationIndexes,
    startApiProviderReturnMonitor
} = require('./services/apiProviderReconciliationService');
const { ensurePerformanceIndexes } = require('./services/performanceIndexService');
const { ensureSecurityDeviceIndexes } = require('./services/securityControlService');
const { closeEligibleDailySettlement } = require('./services/settlementService');
const systemMonitor = require('./services/systemMonitorService');
const { restorePendingRateActivation, startRateChangeActivationMonitor } = require('./services/rateChangeService');
const { startExecutorPushNotificationWorker } = require('./services/executorPushNotificationService');
const { ensureUnifiedReportInfrastructure } = require('./services/unifiedReportService');

// 🟢 استدعاء طابور المهام الجديد (Queue System)

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
app.locals.systemTimeZone = SYSTEM_TIME_ZONE;
app.locals.sessionStoreHealthy = true;
app.locals.isShuttingDown = false;

app.set('trust proxy', 1); 
app.use(require('./middlewares/trustedProxyHttps').normalizeTrustedProxyHttps({
    enabled: isProduction && process.env.TRUST_PROXY_HTTPS === 'true'
}));

const server = http.createServer(app);

let fatalShutdownStarted = false;
const shutdownAfterFatalError = (origin, error) => {
    const normalizedError = error instanceof Error ? error : new Error(String(error || origin));
    logger.error(`Fatal process error: ${origin}`, { error: normalizedError.stack || normalizedError.message });
    if (!isProduction || fatalShutdownStarted) return;

    fatalShutdownStarted = true;
    app.locals.isShuttingDown = true;
    process.exitCode = 1;
    const forceExitTimer = setTimeout(() => process.exit(1), 5000);
    forceExitTimer.unref();
    server.close(() => process.exit(1));
};

process.on('unhandledRejection', (reason) => shutdownAfterFatalError('unhandledRejection', reason));
process.on('uncaughtException', (error) => shutdownAfterFatalError('uncaughtException', error));

// ✅ إصلاح: تقييد CORS في Socket.IO بدل السماح لأي نطاق
const allowedOrigins = getAllowedOrigins();
const mobileAllowedOrigins = getMobileAllowedOrigins();

const io = new Server(server, {
    cors: {
        origin: (origin, callback) => {
            // السماح للطلبات بدون origin (تطبيقات الموبايل، Postman، إلخ)
            if (!origin || allowedOrigins.includes(origin)) {
                callback(null, true);
            } else {
                callback(new Error('غير مسموح بالاتصال من هذا النطاق'));
            }
        },
        credentials: true
    }
});

// إتاحة السوكت في كامل التطبيق لتجنب تكرار الأحداث
app.set('io', io);
systemMonitor.attachSocketServer(io);
io.on('connection', (socket) => {
    if (
        String(socket.handshake?.query?.monitor || '') === '1'
        && !isAuthorizedOperationalSocket(socket, 'SYSTEM_MONITOR_AUTH_TOKEN')
    ) {
        socket.emit('monitor:error', { code: 'FORBIDDEN' });
        socket.disconnect(true);
        return;
    }
    systemMonitor.handleSocket(socket);
});

// ==========================================
// 🛡️ التحديث الذكي للزمن الفعلي (Targeted Socket Updates)
// بدلاً من إرسال إشعار عند تحديث أي جدول (مثل Logs أو Sessions)، سنقوم 
// بربط الإشعارات فقط بجدول العمليات (Transaction) لتقليل الضغط بنسبة 90%
// ==========================================
const Transaction = require('./models/Transaction');
const triggerUpdate = (doc) => {
    if (app.get('io')) app.get('io').emit('update_data');
    systemMonitor.recordTransactionChange(doc, 'تحديث');
};
Transaction.schema.post('save', triggerUpdate);
Transaction.schema.post('findOneAndUpdate', triggerUpdate);
Transaction.schema.post('updateOne', triggerUpdate);
Transaction.schema.post('updateMany', triggerUpdate);
Transaction.schema.post('findOneAndDelete', triggerUpdate);
Transaction.schema.post('deleteOne', triggerUpdate);
Transaction.schema.post('deleteMany', triggerUpdate);
// 🛡️ جدار الحماية والأمان (Security Middlewares)
// ==========================================
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "cdnjs.cloudflare.com"],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "cdnjs.cloudflare.com", "fonts.googleapis.com"],
            fontSrc: ["'self'", "fonts.gstatic.com", "cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "blob:", "assets.mixkit.co"],
            connectSrc: ["'self'", "wss:", "ws:"],
            mediaSrc: ["'self'", "assets.mixkit.co"],
            frameSrc: ["'none'"],
        }
    },
    crossOriginEmbedderPolicy: false,
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    permissionsPolicy: {
        features: { camera: ["'none'"], microphone: ["'none'"], geolocation: ["'self'"] }
    }
}));

// The browser preview is allowed to call only the mobile API, not the full website.
app.use('/api/mobile', cors({ origin: mobileAllowedOrigins, credentials: true }));
app.use('/api/v1/mobile', cors({ origin: mobileAllowedOrigins, credentials: true }));
app.use(cors({ origin: allowedOrigins, credentials: true }));

// Serve public files before request processing, session checks, and metrics.
app.use(express.static(path.join(__dirname, 'public')));

const limiter = rateLimit({
    windowMs: 5 * 60 * 1000, 
    max: Number(process.env.GLOBAL_RATE_LIMIT_MAX || (isProduction ? 1000 : 5000)),
    message: { success: false, error: 'معدل الطلبات مرتفع جداً، يرجى المحاولة بعد قليل.' },
    standardHeaders: true, 
    legacyHeaders: false,
});
app.use(limiter);

// 📊 Request Logger + Prometheus Metrics
app.use(requestLogger);
app.use(metricsMiddleware);

const requireIp = require('./middlewares/ipCheck');
app.use(requireIp);

// إيصالات إيداع شركة التنفيذ تُرسل كصور Base64. خمس صور بحجم 5MB
// تحتاج مساحة أكبر من حجم الملفات الأصلي بسبب ترميز Base64 (نحو 33%).
// يبقى التحقق الصارم من عدد الصور وحجم كل صورة داخل خدمة الإيداعات.
app.use(express.json({ limit: '40mb' }));
app.use(express.urlencoded({ extended: true, limit: '40mb' }));

// 🚫 منع تخزين الصفحات في الكاش المؤقت لضمان تحديث البيانات فوراً (حل مشكلة عدم تحديث البيانات بعد الإرسال)
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
    next();
});
app.set('view engine', 'ejs');

// Lightweight operational endpoints should not wait on sessions or tenant lookup.
app.get('/metrics', requireOperationalAccess({ tokenEnv: 'METRICS_AUTH_TOKEN' }), metricsEndpoint);

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        version: '2.0.0',
        authenticationMode: isPasswordOnlyLoginMode() ? 'password-only' : 'enhanced-verification'
    });
});

app.get('/health/ready', async (req, res) => {
    try {
        const dbState = require('mongoose').connection.readyState;
        const dbStatus = dbState === 1 ? 'connected' : dbState === 2 ? 'connecting' : 'disconnected';
        const ready = dbState === 1 && app.locals.sessionStoreHealthy && !app.locals.isShuttingDown;
        res.status(ready ? 200 : 503).json({
            status: ready ? 'ok' : 'degraded',
            db: dbStatus,
            sessionStore: app.locals.sessionStoreHealthy ? 'connected' : 'degraded',
            shuttingDown: Boolean(app.locals.isShuttingDown),
            uptime: process.uptime()
        });
    } catch (e) {
        res.status(503).json({ status: 'error', db: 'unreachable' });
    }
});

app.use('/system-monitor', require('./routes/systemMonitor'));

const configuredSessionMaxAgeMs = Number(process.env.SESSION_MAX_AGE_MS);
const defaultSessionMaxAgeMs = isProduction ? 2 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
const sessionMaxAgeMs = Number.isFinite(configuredSessionMaxAgeMs)
    && configuredSessionMaxAgeMs >= 5 * 60 * 1000
    && configuredSessionMaxAgeMs <= 24 * 60 * 60 * 1000
    ? configuredSessionMaxAgeMs
    : defaultSessionMaxAgeMs;

let sessionStore;
try {
    if ((process.env.SESSION_STORE || '').toLowerCase() === 'memory') {
        sessionStore = new session.MemoryStore();
        console.warn('⚠️ Session Store: MemoryStore (SESSION_STORE=memory)');
    } else {
        const { MongoStore } = require('connect-mongo');
        sessionStore = MongoStore.create({
            mongoUrl: process.env.MONGO_URI,
            ttl: Math.ceil(sessionMaxAgeMs / 1000),
            autoRemove: 'native',
            mongoOptions: {
                retryWrites: false,
                serverSelectionTimeoutMS: 120000,
                connectTimeoutMS: 120000,
                socketTimeoutMS: 120000
            }
        });
        sessionStore.on('error', (error) => {
            app.locals.sessionStoreHealthy = false;
            logger.error('Session store error', { error: error.message });
        });
        sessionStore.on('connected', () => {
            app.locals.sessionStoreHealthy = true;
        });
        console.log('✅ Session Store: MongoDB (connect-mongo)');
    }
} catch (error) {
    if (isProduction) throw new Error(`Production session store initialization failed: ${error.message}`);
    console.warn("⚠️ تحذير: تعذر تحميل connect-mongo — استخدام MemoryStore محلياً.", error);
    sessionStore = new session.MemoryStore();
}

app.use(session({
    name: 'ahram.sid',
    secret: process.env.SESSION_SECRET || 'dev-session-secret-change-me-only-local',
    resave: false, 
    saveUninitialized: false, 
    rolling: true,
    unset: 'destroy',
    proxy: isProduction,
    store: sessionStore,
    cookie: {
        secure: isProduction || process.env.SECURE_COOKIE === 'true',
        httpOnly: true,
        sameSite: process.env.COOKIE_SAMESITE || 'lax',
        maxAge: sessionMaxAgeMs,
        priority: 'high'
    }
}));

app.use(systemMonitor.trackRequest);

app.use('/uploads/proofs', (req, res, next) => {
    if (req.session && (req.session.isLoggedIn || req.session.isClientLoggedIn || req.session.isExecutorLoggedIn)) {
        return next();
    }
    return res.status(403).send('Forbidden');
});
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// روابط الإيصالات الموقعة المخصصة لقوالب واتساب. لا تتطلب جلسة، لكنها تنتهي تلقائياً.
app.use('/public', require('./routes/publicReceipts'));

// WhatChimp delivers external messages here. This must remain before CSRF protection.
app.use('/webhooks/whatchimp', require('./routes/whatChimpWebhook'));
app.use(csrfProtection);
app.use('/', require('./routes/emergencySecurity'));

const { tenantResolver } = require('./middlewares/tenantResolver');
app.use(tenantResolver);

const {
    enforceSecuritySession,
    enforceEmergencyLockdown,
    enforceAdminPermissions
} = require('./middlewares/securityControl');
app.use(enforceSecuritySession);
app.use(enforceEmergencyLockdown);

app.use((req, res, next) => {
    res.locals.adminName = req.session.adminName || 'مدير';
    // ✅ إصلاح: استخدام adminRole (وليس role) بما يتوافق مع auth middleware
    res.locals.role = req.session.adminRole || null;
    res.locals.tenant = req.tenant || null;
    next();
});

const { syncBotBalance } = require('./services/balanceService');

// ==========================================
// 🔗 ربط المسارات المنفصلة
// ==========================================
app.use('/client', require('./routes/clientPortal'));
app.use('/client', require('./routes/clientReports')); // Reports for clients
app.use('/executor-portal', require('./routes/executorPortal'));
app.use('/executor-portal', require('./routes/executorReports')); // Reports for executors
app.use('/api/mobile', require('./routes/mobileApi'));
app.use('/api/v1/mobile', require('./routes/mobileApi'));
app.use('/api/v1/merchant', require('./routes/merchantApi'));

app.use('/', require('./routes/auth'));
app.use('/admin/security', require('./routes/securityAdmin'));
app.use(enforceAdminPermissions);
app.use('/', require('./routes/dashboard'));
app.use('/', require('./routes/adminTransactions'));
app.use('/', require('./routes/financialMovements'));
app.use('/', require('./routes/executors'));
app.use('/', require('./routes/clients'));
app.use('/', require('./routes/adminAccounts'));
app.use('/settings', require('./routes/settings'));
app.use('/', require('./routes/employees'));
app.use('/', require('./routes/broadcast'));
app.use('/', require('./routes/support'));
app.use('/whatsapp-monitor', require('./routes/whatsappMonitoring'));
app.use('/', require('./routes/registrationRequests'));
app.use('/audit-log', requireAuth, require('./routes/auditLog'));
app.use('/', require('./routes/reports'));




// 📚 Swagger API Documentation
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./config/swagger');
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'Al-Ahram Pay API Docs'
}));

app.use(notFoundHandler);

if (process.env.SENTRY_DSN) {
    Sentry.setupExpressErrorHandler(app);
}

app.use(errorHandler);

const PORT = process.env.PORT || 3000;
Promise.all([connectDB(), initRedis()]).then(async () => {
    await Promise.all([
        ensureApiReconciliationIndexes(),
        ensurePerformanceIndexes(),
        ensureSecurityDeviceIndexes(),
        ensureUnifiedReportInfrastructure()
    ]);
    await restorePendingRateActivation({ app });
    startRateChangeActivationMonitor({ app });
    startApiCompletionMonitor();
    startApiProviderReturnMonitor();
    await startExecutorPushNotificationWorker().catch((error) => {
        logger.error('Executor push notification worker failed to start', { error: error.message });
    });
    closeEligibleDailySettlement().catch((error) => {
        logger.error('Initial financial day close failed', { error: error.message });
    });
    cron.schedule('*/15 * * * *', () => {
        closeEligibleDailySettlement().catch((error) => {
            logger.error('Scheduled financial day close failed', { error: error.message });
        });
    }, { timezone: SYSTEM_TIME_ZONE });
    // 🟢 التأكد من وجود الإعدادات الافتراضية في قاعدة البيانات لتفادي أخطاء null pointer
    server.listen(PORT, () => {
        logger.info(`🟢 Al-Ahram Pay v2.0 running on port ${PORT}`, { port: PORT, env: process.env.NODE_ENV || 'development' });
        console.log(`🟢 السيرفر يعمل بقوة الزمن الفعلي والحماية الشاملة على البورت ${PORT}`);
        systemMonitor.recordActivity('system', `اكتمل تشغيل السيرفر المحلي على المنفذ ${PORT}.`, { level: 'success', silent: true });

        // تسجيل بدء تشغيل النظام في Audit Log
        if (process.env.ENABLE_STARTUP_AUDIT === 'true') {
            const { logAction } = require('./services/auditService');
            logAction({ action: 'SYSTEM_STARTUP', metadata: { port: PORT, nodeVersion: process.version } }).catch(() => {});
        }
    });
}).catch((error) => {
    logger.error('Application startup failed', { error: error.message });
    process.exit(1);
});
