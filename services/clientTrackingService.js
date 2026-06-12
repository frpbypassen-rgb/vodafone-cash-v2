// services/clientTrackingService.js
const Transaction = require('../models/Transaction');

const updateClientTracking = async (txId, statusStep, extraNote = '', imageBuffer = null) => {
    try {
        const tx = await Transaction.findById(txId);
        if (!tx) return false;

        // 🟢 الإشعارات ستتم عبر Socket.IO لاحقاً (تم إزالة التيليجرام)
        return true;
    } catch (e) {
        console.error('[Live Tracking Error]:', e.message);
        return false;
    }
};

module.exports = { updateClientTracking };