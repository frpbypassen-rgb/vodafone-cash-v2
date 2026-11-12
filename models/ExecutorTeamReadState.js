const mongoose = require('mongoose');
const schema = new mongoose.Schema({
    groupId: { type: mongoose.Schema.Types.ObjectId, required: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, required: true },
    lastReadAt: { type: Date, required: true }
});
schema.index({ groupId: 1, employeeId: 1 }, { unique: true });
module.exports = mongoose.model('ExecutorTeamReadState', schema);
