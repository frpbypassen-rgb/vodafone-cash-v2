const { logExecutorFailure } = require('../../../services/executorTransactionError');
const { proofSourceUrl, streamProofImage, streamExecutorProof } = require('../../../services/proofStorageService');
const { getExecutorProofIds } = require('../../../utils/executorProofIds');
const Employee = require('../../../models/Employee');
const Transaction = require('../../../models/Transaction');
const { objectIdString } = require('./access');

exports.getProxyImage = async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        if (!tx) return res.status(404).send('Not found');
        const emp = req.executorEmployee || (await Employee.findById(req.session.executorId));
        const employeeGroupId = objectIdString(emp?.groupId);
        const ownsExecutorTask = objectIdString(tx.executorGroupId) === employeeGroupId;
        const ownsManagerTask = objectIdString(tx.managerGroupId) === employeeGroupId;
        if (!emp || (!ownsExecutorTask && !ownsManagerTask)) {
            return res.status(403).send('Forbidden');
        }
        const index = req.params.index ? parseInt(req.params.index) : 0;
        let photoId = null;
        if (tx.proofImages && tx.proofImages.length > index) {
            photoId = tx.proofImages[index];
        } else if (tx.proofImage && index === 0) {
            photoId = tx.proofImage;
        }
        if (!photoId) return res.status(404).send('No photo');

        await streamProofImage(proofSourceUrl(photoId), res);
        return;
    } catch (error) {
        logExecutorFailure('proof-image', error);
        res.status(500).send('Server error');
    }
};

exports.getProxyExecutorImage = async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        if (!tx) return res.status(404).send('Not found');
        const emp = req.executorEmployee || (await Employee.findById(req.session.executorId));
        const employeeGroupId = objectIdString(emp?.groupId);
        const ownsExecutorTask = objectIdString(tx.executorGroupId) === employeeGroupId;
        const ownsManagerTask = objectIdString(tx.managerGroupId) === employeeGroupId;
        if (!emp || emp.role !== 'manager' || (!ownsExecutorTask && !ownsManagerTask)) {
            return res.status(403).send('Forbidden');
        }
        const index = req.params.index ? parseInt(req.params.index) : 0;
        const photoId = getExecutorProofIds(tx)[index];
        if (!photoId) return res.status(404).send('No photo');

        await streamExecutorProof(photoId, res);
        return;
    } catch (error) {
        if (error.statusCode === 404) return res.status(404).send('No photo');
        logExecutorFailure('private-proof-image', error);
        res.status(500).send('Server error');
    }
};
