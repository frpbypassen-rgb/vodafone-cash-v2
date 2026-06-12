'use strict';

const request = require('supertest');
const express = require('express');
const { metricsMiddleware, metricsEndpoint } = require('../middlewares/metrics');

describe('Prometheus Metrics Tests', () => {
    let app;

    beforeAll(() => {
        app = express();
        app.use(metricsMiddleware);
        app.get('/metrics', metricsEndpoint);
    });

    test('GET /metrics should return 200 OK and plaintext metrics', async () => {
        const res = await request(app)
            .get('/metrics')
            .expect(200);

        expect(res.headers['content-type']).toContain('text/plain');
        expect(res.text).toContain('# HELP http_requests_total');
        expect(res.text).toContain('process_memory_rss_bytes');
        expect(res.text).toContain('process_memory_heap_used_bytes');
        expect(res.text).toContain('process_uptime_seconds');
        expect(res.text).toContain('process_cpu_user_seconds_total');
        expect(res.text).toContain('process_cpu_system_seconds_total');
        expect(res.text).toContain('active_transfers_count');
    });
});
