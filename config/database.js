// config/database.js
const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        // الاتصال بالسيرفر المحلي بدون الإعدادات القديمة
        const conn = await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/vodafone_cash_system');
        
        console.log(`[Database] MongoDB Connected: ${conn.connection.host}`);
    } catch (error) {
        console.error(`[Database Error] Connection Failed: ${error.message}`);
        process.exit(1); 
    }
};

module.exports = connectDB;