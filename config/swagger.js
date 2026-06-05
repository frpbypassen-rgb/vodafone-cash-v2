// config/swagger.js
// ===============================================
// 📚 إعداد توثيق Swagger/OpenAPI للـ Mobile API
// ===============================================

const swaggerJsdoc = require('swagger-jsdoc');

const options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'Al-Ahram Pay — Mobile API',
            version: '2.0.0',
            description: `
## نظام Al-Ahram Pay للتحويلات المالية

واجهة برمجية كاملة لتطبيق الموبايل تدعم:
- **العملاء الأفراد والشركات**: تسجيل الدخول، الرصيد، التحويلات
- **المنفذين (Executors)**: استلام المهام وإتمام التحويلات
- **نظام JWT**: توكن وصول (1 ساعة) + توكن تجديد (30 يوم)
- **Idempotency**: منع تكرار العمليات بإرسال \`Idempotency-Key\` في الهيدر

### ملاحظات الأمان
- جميع المسارات (عدا login و refresh-token) تتطلب \`Authorization: Bearer <token>\`
- Rate Limiting: 8 محاولات دخول / 15 دق، و15 تحويل / دقيقة
- يتم تسجيل جميع العمليات في Audit Log
            `,
            contact: {
                name: 'Eng. Mohamed',
                email: 'support@ahram-pay.com'
            },
            license: {
                name: 'ISC'
            }
        },
        servers: [
            {
                url: '/api/mobile',
                description: 'Mobile API v2'
            }
        ],
        components: {
            securitySchemes: {
                BearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                    description: 'أدخل توكن JWT الخاص بك. مثال: `Bearer eyJhbGci...`'
                }
            },
            schemas: {
                // ─── الاستجابات العامة ───
                SuccessResponse: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean', example: true },
                        message: { type: 'string', example: 'تمت العملية بنجاح' }
                    }
                },
                ErrorResponse: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean', example: false },
                        code: { type: 'string', example: 'INVALID_CREDENTIALS' },
                        message: { type: 'string', example: 'بيانات الدخول غير صحيحة' }
                    }
                },
                // ─── نماذج البيانات ───
                LoginRequest: {
                    type: 'object',
                    required: ['username', 'password'],
                    properties: {
                        username: { type: 'string', example: 'ahmed_ali', description: 'اسم المستخدم أو رقم الهاتف' },
                        password: { type: 'string', format: 'password', example: '••••••••' }
                    }
                },
                LoginResponse: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean', example: true },
                        token: { type: 'string', description: 'Access Token (صالح لساعة واحدة)' },
                        refreshToken: { type: 'string', description: 'Refresh Token (صالح 30 يوم)' },
                        accountType: { type: 'string', enum: ['executor', 'client_company', 'client_user'] },
                        id: { type: 'string', example: '507f1f77bcf86cd799439011' },
                        name: { type: 'string', example: 'أحمد علي' },
                        balance: { type: 'number', example: 450.5 }
                    }
                },
                TransferRequest: {
                    type: 'object',
                    required: ['transferType', 'amount', 'number'],
                    properties: {
                        transferType: {
                            type: 'string',
                            enum: ['كاش', 'بريد حساب', 'بريد بطاقة', 'post_account', 'post_card'],
                            example: 'كاش'
                        },
                        amount: { type: 'number', minimum: 1, example: 500, description: 'المبلغ بالجنيه المصري (EGP)' },
                        number: { type: 'string', example: '01012345678', description: 'رقم المحفظة أو الحساب' },
                        name: { type: 'string', example: 'محمد أحمد', description: 'اسم المستفيد (اختياري)' },
                        notes: { type: 'string', example: 'تحويل عاجل', description: 'ملاحظات (اختياري)' }
                    }
                },
                TransferResponse: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean', example: true },
                        code: { type: 'string', example: 'SUCCESS' },
                        message: { type: 'string', example: 'تم إرسال طلبك بنجاح' },
                        txId: { type: 'string', example: 'ATT-2606-0042' },
                        newBalance: { type: 'number', example: 294.961 }
                    }
                },
                Transaction: {
                    type: 'object',
                    properties: {
                        _id: { type: 'string' },
                        customId: { type: 'string', example: 'ATT-2606-0042' },
                        amount: { type: 'number', example: 500 },
                        costLYD: { type: 'number', example: 77.52 },
                        exchangeRate: { type: 'number', example: 6.45 },
                        vodafoneNumber: { type: 'string', example: '01012345678' },
                        transferType: { type: 'string', example: 'كاش' },
                        status: {
                            type: 'string',
                            enum: ['pending', 'processing', 'accepted', 'completed', 'rejected', 'cancelled_by_admin'],
                            example: 'pending'
                        },
                        notes: { type: 'string' },
                        createdAt: { type: 'string', format: 'date-time' }
                    }
                },
                Task: {
                    type: 'object',
                    properties: {
                        _id: { type: 'string' },
                        customId: { type: 'string', example: 'ATT-2606-0042' },
                        amount: { type: 'number', example: 500 },
                        vodafoneNumber: { type: 'string', example: '01012345678' },
                        transferType: { type: 'string', example: 'كاش' },
                        status: { type: 'string', enum: ['processing', 'accepted'] },
                        companyName: { type: 'string' },
                        employeeName: { type: 'string' },
                        createdAt: { type: 'string', format: 'date-time' }
                    }
                }
            }
        },
        security: [{ BearerAuth: [] }],
        tags: [
            { name: '🔐 Auth', description: 'تسجيل الدخول والخروج وتجديد التوكن' },
            { name: '👤 Client', description: 'عمليات العملاء: الرصيد، السجل، التحويل' },
            { name: '🤖 Executor', description: 'عمليات المنفذين: المهام، القبول، الإتمام' },
            { name: '📁 Media', description: 'جلب صور إثباتات العمليات' }
        ]
    },
    apis: ['./routes/mobileApi.js']
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = swaggerSpec;
