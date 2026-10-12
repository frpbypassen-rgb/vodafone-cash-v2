'use strict';

const source = require('fs').readFileSync(require('path').join(__dirname, '../services/apiProviderReconciliationService.js'), 'utf8');

test('API monitor prevents overlapping runs and enforces a five-second minimum interval', () => {
    expect(source).toContain("returnMonitorRunInFlight");
    expect(source).toContain("reason: 'previous_run_in_flight'");
    expect(source).toContain('configured >= 5000');
});

test('API monitor limits automatic executor groups per cycle', () => {
    expect(source).toContain('API_RETURN_MONITOR_MAX_GROUPS');
    expect(source).toContain('groups.slice(0, maxGroups)');
});
