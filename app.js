require('dotenv').config();
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
const csrfProtection = require('./middlewares/csrfProtection');
const logger = require('./utils/logger');

// 🟢 استدعاء طابور المهام الجديد (Queue System)

const app = express();
const isProduction = process.env.NODE_ENV === 'production';

// ==========================================
// 🛡️ درع حماية السيرفر من الانهيار
// ==========================================
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ [تخطي خطأ في الخلفية - Unhandled Rejection]:', reason.message || reason);
});

process.on('uncaughtException', (err) => {
    console.error('🚨 [تخطي خطأ حرج - Uncaught Exception]:', err.stack || err.message);
});

app.set('trust proxy', 1); 

const server = http.createServer(app);

// ✅ إصلاح: تقييد CORS في Socket.IO بدل السماح لأي نطاق
const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['http://localhost:3000', 'http://127.0.0.1:3000'];

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

// ==========================================
// 🛡️ التحديث الذكي للزمن الفعلي (Targeted Socket Updates)
// بدلاً من إرسال إشعار عند تحديث أي جدول (مثل Logs أو Sessions)، سنقوم 
// بربط الإشعارات فقط بجدول العمليات (Transaction) لتقليل الضغط بنسبة 90%
// ==========================================
const Transaction = require('./models/Transaction');
const triggerUpdate = () => { if (app.get('io')) app.get('io').emit('update_data'); };
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
        features: { camera: ["'none'"], microphone: ["'none'"], geolocation: ["'none'"] }
    }
}));

app.use(cors({ origin: allowedOrigins, credentials: true }));

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

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(express.static(path.join(__dirname, 'public')));

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
app.get('/metrics', metricsEndpoint);

app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString(), version: '2.0.0' });
});

app.get('/health/ready', async (req, res) => {
    try {
        const dbState = require('mongoose').connection.readyState;
        const dbStatus = dbState === 1 ? 'connected' : dbState === 2 ? 'connecting' : 'disconnected';
        res.json({ status: dbState === 1 ? 'ok' : 'degraded', db: dbStatus, uptime: process.uptime() });
    } catch (e) {
        res.status(503).json({ status: 'error', db: 'unreachable' });
    }
});

let sessionStore;
try {
    if ((process.env.SESSION_STORE || '').toLowerCase() === 'memory') {
        sessionStore = new session.MemoryStore();
        console.warn('⚠️ Session Store: MemoryStore (SESSION_STORE=memory)');
    } else {
        const { MongoStore } = require('connect-mongo');
        sessionStore = MongoStore.create({
            mongoUrl: process.env.MONGO_URI,
            ttl: 24 * 60 * 60,
            autoRemove: 'native',
            mongoOptions: {
                serverSelectionTimeoutMS: 120000,
                connectTimeoutMS: 120000,
                socketTimeoutMS: 120000
            }
        });
        sessionStore.on('error', (error) => {
            logger.error('Session store error', { error: error.message });
        });
        console.log('✅ Session Store: MongoDB (connect-mongo)');
    }
} catch (error) {
    console.warn("⚠️ تحذير: تعذر تحميل connect-mongo — استخدام MemoryStore.", error);
    sessionStore = new session.MemoryStore();
}

if (isProduction && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
    console.error('🚨 [FATAL] SESSION_SECRET غير موجود أو قصير جداً في بيئة الإنتاج.');
    process.exit(1);
}

app.use(session({
    secret: process.env.SESSION_SECRET || 'dev-session-secret-change-me-only-local',
    resave: false, 
    saveUninitialized: false, 
    store: sessionStore, 
    cookie: {
        secure: process.env.SECURE_COOKIE === 'true',
        httpOnly: true,
        sameSite: process.env.COOKIE_SAMESITE || 'lax',
        maxAge: 24 * 60 * 60 * 1000
    }
}));

app.use('/uploads/proofs', (req, res, next) => {
    if (req.session && (req.session.isLoggedIn || req.session.isClientLoggedIn || req.session.isExecutorLoggedIn)) {
        return next();
    }
    return res.status(403).send('Forbidden');
});
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use(csrfProtection);

const { tenantResolver } = require('./middlewares/tenantResolver');
app.use(tenantResolver);

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

app.use('/', require('./routes/auth'));
app.use('/', require('./routes/dashboard'));
app.use('/', require('./routes/adminTransactions'));
app.use('/', require('./routes/executors'));
app.use('/', require('./routes/clients'));
app.use('/settings', require('./routes/settings'));
app.use('/', require('./routes/employees'));
app.use('/', require('./routes/broadcast'));
app.use('/', require('./routes/support'));
app.use('/', require('./routes/registrationRequests'));
app.use('/audit-log', requireAuth, require('./routes/auditLog'));
app.use('/', require('./routes/reports'));




app.use('/api/v1/merchant', require('./routes/merchantApi'));

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
    // 🟢 التأكد من وجود الإعدادات الافتراضية في قاعدة البيانات لتفادي أخطاء null pointer
    try {
        const Settings = require('./models/Settings');
        const settingsCount = await Settings.countDocuments({});
        if (settingsCount === 0) {
            await Settings.create({});
            console.log('✅ [Settings] Created default system settings');
        }
    } catch (err) {
        console.error('⚠️ [Settings Error] Failed to ensure default settings:', err.message);
    }

    server.listen(PORT, () => {
        logger.info(`🟢 Al-Ahram Pay v2.0 running on port ${PORT}`, { port: PORT, env: process.env.NODE_ENV || 'development' });
        console.log(`🟢 السيرفر يعمل بقوة الزمن الفعلي والحماية الشاملة على البورت ${PORT}`);

        // تسجيل بدء تشغيل النظام في Audit Log
        const { logAction } = require('./services/auditService');
        logAction({ action: 'SYSTEM_STARTUP', metadata: { port: PORT, nodeVersion: process.version } }).catch(() => {});
    });
}).catch((error) => {
    logger.error('Application startup failed', { error: error.message });
    process.exit(1);
});
