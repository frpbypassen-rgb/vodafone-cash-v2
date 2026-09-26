'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const workflowPath = path.join(__dirname, '../.github/workflows/deploy.yml');

describe('deploy workflow', () => {
    const text = fs.readFileSync(workflowPath, 'utf8');
    const doc = yaml.load(text);
    const trigger = doc.on || doc.true;

    test('parses as workflow_dispatch only and gates the deploy job', () => {
        expect(trigger).toBeTruthy();
        expect(trigger.workflow_run).toBeUndefined();
        expect(Object.keys(trigger)).toEqual(['workflow_dispatch']);
        expect(trigger.workflow_dispatch.inputs.confirm_sha.required).toBe(true);
        expect(trigger.workflow_dispatch.inputs.apply_repair.type).toBe('boolean');
        expect(trigger.workflow_dispatch.inputs.apply_repair.default).toBe(false);
        expect(doc.jobs.deploy.environment).toBe('production');
        expect(doc.jobs.deploy.needs).toContain('verify-ci');
        expect(text).not.toMatch(/^\s*workflow_run:/m);
        expect(text).not.toMatch(/node\s+scripts\/migrateTenantIsolation/);
        const repairApplyLines = text.split('\n').filter((line) => (
            /node\s+scripts\/repairProductionEnv\.js\s+\.env\s+--apply/.test(line)
        ));
        expect(repairApplyLines).toHaveLength(1);
        expect(text).toMatch(/APPLY_ENV_REPAIR:-false/);
        expect(text).toContain("= \"true\"");
    });
});
