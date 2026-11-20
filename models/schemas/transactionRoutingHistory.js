'use strict';

module.exports = {
    type: [{
        _id: false,
        kind: { type: String, enum: ['admin_routed', 'admin_pulled', 'auto_routed', 'executor_assigned', 'executor_accepted'] },
        at: Date,
        actor: String,
        executor: String,
        previousRouter: String
    }],
    default: undefined,
    select: false
};
