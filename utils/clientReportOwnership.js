'use strict';

// Customer reports must not treat a display name as an owner. Names are not
// unique, and a client can change theirs. Rows that carry clientActorId are
// owned by that id. Older rows may only store a unique account key (the
// account id, phone, or username) in userId; those stay visible. A row with
// neither, or with only employeeName / companyName, is ambiguous and is
// excluded rather than guessed.

const accountKeys = (account) => {
    const keys = [account && account._id, account && account.phone, account && account.webUsername]
        .map((value) => String(value || '').trim())
        .filter(Boolean);
    return [...new Set(keys)];
};

const missingClientActor = {
    $or: [
        { clientActorId: { $exists: false } },
        { clientActorId: null },
        { clientActorId: '' }
    ]
};

const directClientReportScope = (account) => {
    const accountId = String((account && account._id) || '').trim();
    if (!accountId) return { _id: null };

    const keys = accountKeys(account);
    const owner = [{ clientActorId: accountId }];
    if (keys.length) {
        owner.push({ $and: [{ userId: { $in: keys } }, missingClientActor] });
    }

    return {
        companyId: null,
        isSubAccountTx: { $ne: true },
        $or: owner
    };
};

const clientActorReportScope = (actorId) => {
    const id = String(actorId || '').trim();
    return id ? { clientActorId: id } : { _id: null };
};

module.exports = {
    accountKeys,
    clientActorReportScope,
    directClientReportScope
};
