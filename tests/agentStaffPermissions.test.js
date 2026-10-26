jest.mock('../models/SubAccount', () => ({ find: jest.fn(() => ({ distinct: async () => ['customer-a'] })) }));
const { resolveAgentPermissions, canAccessAgentPage } = require('../utils/agentPortalPolicy');
const { STAFF_PERMISSION_OPTIONS, buildStaffPermissions, canEditStaffPermissions } = require('../utils/agentStaffPermissions');
const { buildAgentTransactionScope } = require('../services/agentTransactionScopeService');
const base = Object.fromEntries(STAFF_PERMISSION_OPTIONS.map(({key}) => [key, false]));
const actor = permissions => ({ _id: 'staff-a', role: 'employee', name: 'Staff', staffPermissions: {...base,...permissions} });
const owner = { _id:'owner',role:'agent' };
test('legacy role permissions stay compatible', () => {
    expect(resolveAgentPermissions({role:'employee'})).toMatchObject({canTransfer:true,canViewBalance:false,canManageStaff:false});
    expect(resolveAgentPermissions({role:'accountant'})).toMatchObject({canTransfer:false,canViewBalance:true,canViewAllReports:true});
    expect(resolveAgentPermissions({role:'agent',staffPermissions:base})).toMatchObject({canTransfer:true,canManageStaff:true});
});
test.each(STAFF_PERMISSION_OPTIONS.map(({key})=>[key]))('%s can be granted independently', key => {
    const access = resolveAgentPermissions(actor({[key]:true}));
    STAFF_PERMISSION_OPTIONS.forEach(option => expect(access[option.key]).toBe(option.key===key));
    expect(access.canEditSettings).toBe(false);
});
test('transfer denial blocks both transfer forms and internal transfers', () => {
    const workspace={isAgent:true,permissions:resolveAgentPermissions(actor({}))};
    expect(canAccessAgentPage(workspace,'service_workbench')).toBe(false);
    expect(canAccessAgentPage(workspace,'internal_transfer')).toBe(false);
    expect(canAccessAgentPage(workspace,'finance')).toBe(false);
    expect(canAccessAgentPage(workspace,'customers')).toBe(false);
});
test('custom staff administrators can reach staff without broader settings permission', () => {
    const permissions=resolveAgentPermissions(actor({canManageStaff:true}));
    expect(canAccessAgentPage({isAgent:true,permissions},'staff')).toBe(true);
    expect(permissions.canEditSettings).toBe(false);
});
test('balance-only access does not expose the agency ledger, customer accounts or profits',()=>{
    const workspace={isAgent:true,permissions:resolveAgentPermissions(actor({canViewBalance:true}))};
    for(const page of ['finance','agency_profits','customer_profile'])expect(canAccessAgentPage(workspace,page)).toBe(false);
    workspace.permissions=resolveAgentPermissions(actor({canViewBalance:true,canViewAllTransactions:true}));
    expect(canAccessAgentPage(workspace,'finance')).toBe(true);
    expect(canAccessAgentPage(workspace,'agency_profits')).toBe(false);
});
test('accountant cannot obtain transfer permission through custom input', () => {
    expect(buildStaffPermissions({permissionsMode:'custom',permission_canTransfer:'on'},owner,'accountant').canTransfer).toBe(false);
});
test('delegated staff cannot grant permissions they lack or edit a stronger target', () => {
    const delegated=actor({canManageStaff:true});
    expect(()=>buildStaffPermissions({permissionsMode:'custom',permission_canTransfer:'on'},delegated,'employee')).toThrow('PERMISSION_ESCALATION');
    expect(canEditStaffPermissions(delegated,{...actor({canTransfer:true}),_id:'staff-b'})).toBe(false);
    expect(canEditStaffPermissions(owner,{...actor({canTransfer:true}),_id:'staff-b'})).toBe(true);
    expect(canEditStaffPermissions(delegated,delegated)).toBe(false);
});
test('report-wide and transaction-wide access use separate scopes', async () => {
    const agent={_id:'agency',role:'agent',phone:'0910000000'};
    const reportActor=actor({canViewAllReports:true});
    const txActor=actor({canViewAllTransactions:true});
    const ownTx=await buildAgentTransactionScope({agent,actor:reportActor,purpose:'transactions'});
    const allReports=await buildAgentTransactionScope({agent,actor:reportActor,purpose:'reports'});
    const ownReport=await buildAgentTransactionScope({agent,actor:txActor,purpose:'reports'});
    const allTx=await buildAgentTransactionScope({agent,actor:txActor,purpose:'transactions'});
    expect(ownTx.$and).toBeDefined();
    expect(allReports.$and).toBeUndefined();
    expect(ownReport.$and).toBeDefined();
    expect(allTx.$and).toBeUndefined();
});
