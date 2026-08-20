'use strict';

const isProduction = () => process.env.NODE_ENV === 'production';

const immutableRecordError = (recordName) => {
    const error = new Error(`${recordName.toUpperCase()}_IMMUTABLE`);
    error.code = 'FINANCIAL_RECORD_IMMUTABLE';
    error.statusCode = 409;
    return error;
};

const assertFinancialRecordMutationAllowed = (recordName) => {
    if (isProduction()) throw immutableRecordError(recordName);
};

const installAppendOnlyGuards = (schema, recordName) => {
    const rejectQueryMutation = function rejectQueryMutation() {
        assertFinancialRecordMutationAllowed(recordName);
    };

    for (const operation of [
        'updateOne',
        'updateMany',
        'findOneAndUpdate',
        'replaceOne',
        'deleteOne',
        'deleteMany',
        'findOneAndDelete'
    ]) {
        schema.pre(operation, rejectQueryMutation);
    }

    schema.pre('save', function rejectExistingDocumentSave() {
        if (!this.isNew) assertFinancialRecordMutationAllowed(recordName);
    });

    schema.pre('deleteOne', { document: true, query: false }, function rejectDocumentDelete() {
        assertFinancialRecordMutationAllowed(recordName);
    });

    if (!schema.statics) schema.statics = {};
    schema.statics.assertMutationAllowed = () => assertFinancialRecordMutationAllowed(recordName);
};

module.exports = {
    assertFinancialRecordMutationAllowed,
    immutableRecordError,
    installAppendOnlyGuards
};
