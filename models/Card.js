const mongoose = require('mongoose');

const cardSchema = new mongoose.Schema({
    category: { type: String, required: true },
    subcategory: { type: String, default: "" },
    name: { type: String, required: true },
    price_1: { type: Number, required: true, default: 0 },
    price_2: { type: Number, required: true, default: 0 },
    price_3: { type: Number, required: true, default: 0 },
    code: { type: String, default: "" },
    serial: { type: String, default: "" },
    pin: { type: String, default: "" },
    op_code: { type: String, default: "" },
    sold: { type: Boolean, default: false },
    added_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Card', cardSchema);