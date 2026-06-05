// config/database.js
const mongoose = require('mongoose');

const connectDB = async () => {
    // 🧪 وضع تجريبي: إذا كان MONGO_URI فارغاً أو يساوي 'demo'
    const mongoUri = process.env.MONGO_URI;
    
    if (!mongoUri || mongoUri === 'demo' || mongoUri === 'DEMO') {
        console.log('[Database] 🧪 لم يتم تحديد MONGO_URI — تشغيل الوضع التجريبي...');
        const { connectMockDB } = require('./mockDatabase');
        return await connectMockDB();
    }

    try {
        const conn = await mongoose.connect(mongoUri);
        console.log(`[Database] MongoDB Connected: ${conn.connection.host}`);
    } catch (error) {
        console.error(`[Database Error] Connection Failed: ${error.message}`);
        process.exit(1); 
    }
};

module.exports = connectDB;