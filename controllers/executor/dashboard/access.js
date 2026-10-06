const objectIdString = (value) => String(value?._id || value || '');

const belongsToGroup = (employee, group) =>
    Boolean(employee) && objectIdString(employee.groupId) === objectIdString(group);

module.exports = { objectIdString, belongsToGroup };
