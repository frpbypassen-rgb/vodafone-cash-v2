const { logExecutorFailure } = require('../../../services/executorTransactionError');
const { proofSourceUrl, streamProofImage } = require('../../../services/proofStorageService');
const {
    executorRequestTenantScope,
    taskTenantMatches,
} = require('../../../services/executorTaskRoutingService');
const Employee = require('../../../models/Employee');
const Transaction = require('../../../models/Transaction');
const { objectIdString } = require('./access');

const canViewExecutorProof = (emp, tx, tenantScope) => {
    if (!emp || !taskTenantMatches(tx, tenantScope)) return false;
    const employeeGroupId = objectIdString(emp.groupId);
    const inGroup =
        objectIdString(tx.executorGroupId) === employeeGroupId ||
        objectIdString(tx.managerGroupId) === employeeGroupId;
    if (!inGroup) return false;
    if (emp.role === 'manager' || emp.role === 'accountant') return true;
    const self = objectIdString(emp._id);
    if (objectIdString(tx.operatorId) === self || objectIdString(tx.assignedExecutorId) === self) return true;
    const unassigned = !objectIdString(tx.operatorId) && !objectIdString(tx.assignedExecutorId);
    return unassigned && ['processing', 'pending'].includes(String(tx.status || ''));
};

const loadVisibleProofTask = async (req, res) => {
    const tx = await Transaction.findById(req.params.id);
    if (!tx) {
        res.status(404).send('Not found');
        return null;
    }
    const emp = req.executorEmployee || (await Employee.findById(req.session.executorId));
    if (!canViewExecutorProof(emp, tx, executorRequestTenantScope(req))) {
        res.status(403).send('Forbidden');
        return null;
    }
    return tx;
};

exports.getProxyImage = async (req, res) => {
    try {
        const tx = await loadVisibleProofTask(req, res);
        if (!tx) return;
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
        const tx = await loadVisibleProofTask(req, res);
        if (!tx) return;
        const index = req.params.index ? parseInt(req.params.index) : 0;
        const photoId =
            Array.isArray(tx.executorProofImages) && tx.executorProofImages.length > index
                ? tx.executorProofImages[index]
                : null;
        if (!photoId) return res.status(404).send('No photo');

        await streamProofImage(proofSourceUrl(photoId), res);
        return;
    } catch (error) {
        logExecutorFailure('private-proof-image', error);
        res.status(500).send('Server error');
    }
};
