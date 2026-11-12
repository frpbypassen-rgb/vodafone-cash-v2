const mongoose = require('mongoose');
const schema = new mongoose.Schema({
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExecutorGroup', required: true, index: true },
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    senderName: { type: String, required: true },
    text: { type: String, maxlength: 2000, default: '' },
    imageUrl: { type: String, default: '' },
    mentions: [{ id: String, name: String }],
    linkedOperation: { type: Object },
    createdAt: { type: Date, default: Date.now }
});
schema.index({ groupId: 1, _id: -1 });
module.exports = mongoose.model('ExecutorTeamMessage', schema);
