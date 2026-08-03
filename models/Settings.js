const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
    rateLevel1: { type: Number, default: 6.40 },
    rateLevel2: { type: Number, default: 6.45 },
    rateLevel3: { type: Number, default: 6.50 },

    cashRateLevel1: { type: Number, default: 6.40 },
    cashRateLevel2: { type: Number, default: 6.45 },
    cashRateLevel3: { type: Number, default: 6.50 },

    postAccountRateLevel1: { type: Number, default: 6.35 },
    postAccountRateLevel2: { type: Number, default: 6.40 },
    postAccountRateLevel3: { type: Number, default: 6.45 },

    postCardRateLevel1: { type: Number, default: 6.25 },
    postCardRateLevel2: { type: Number, default: 6.30 },
    postCardRateLevel3: { type: Number, default: 6.35 },

    bankAccountRateLevel1: { type: Number, default: 6.40 },
    bankAccountRateLevel2: { type: Number, default: 6.45 },
    bankAccountRateLevel3: { type: Number, default: 6.50 },

    sefaNigerRateLevel1: { type: Number, default: 6.50 },
    sefaNigerRateLevel2: { type: Number, default: 6.55 },
    sefaNigerRateLevel3: { type: Number, default: 6.60 },

    bankakSudanRateLevel1: { type: Number, default: 6.60 },
    bankakSudanRateLevel2: { type: Number, default: 6.65 },
    bankakSudanRateLevel3: { type: Number, default: 6.70 },
    
    openingTime: { type: String, default: '09:00' },
    closingTime: { type: String, default: '23:00' },
    isManualClosed: { type: Boolean, default: false },
    
    welcomeMessage: { type: String, default: 'مرحباً بك في منظومة الأهرام الرقمية للصرافة.' },
    termsMessage: { type: String, default: '⚠️ يرجى التأكد من الرقم قبل الإرسال.\nالتحويل يتم خلال دقائق.' },
    closedMessage: { type: String, default: 'نعتذر، المنظومة مغلقة حالياً. يرجى المحاولة في أوقات العمل الرسمية.' },
    supportContact: { type: String, default: '@AhramSupport' },

    autoRouteEnabled: { type: Boolean, default: false },
    autoRouteBotId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExecutorGroup', default: null },

    executorWelcomeMessage: { type: String, default: 'أهلاً بك في لوحة تحكم التنفيذ الخاصة بشركة الأهرام.' },
    executorPendingMessage: { type: String, default: '⏳ حسابك لا يزال قيد المراجعة من قبل الإدارة.' },
    executorBannedMessage: { type: String, default: '⛔️ تم حظر حسابك. يرجى مراجعة الإدارة.' },

});

module.exports = mongoose.model('Settings', settingsSchema);
