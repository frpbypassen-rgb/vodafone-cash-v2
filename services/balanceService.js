// services/balanceService.js
// ⚠️ هذا الملف أصبح re-export فقط — الكود الحقيقي في utils/helpers.js
// يمنع كسر أي import موجود في المشروع
const { syncBotBalance } = require('../utils/helpers');
module.exports = { syncBotBalance };
