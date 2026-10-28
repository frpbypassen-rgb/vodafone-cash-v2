'use strict';

const request = require('supertest');
const express = require('express');
const { metricsMiddleware, metricsEndpoint, shouldSkipMetrics, recordWebhookQueue } = require('../middlewares/metrics');

describe('Prometheus Metrics Tests', () => {
    let app;

    beforeAll(() => {
        app = express();
        app.use(metricsMiddleware);
        app.get('/metrics', metricsEndpoint);
    });
    test('webhook queue gauges preserve last good values and mark unavailable observations explicitly',async()=>{
        recordWebhookQueue({available:true,pendingEvents:3,pendingDeliveries:4,oldestAgeSeconds:180,delayed:true});
        const healthy=await request(app).get('/metrics');
        expect(healthy.text).toContain('merchant_webhook_queue_pending_events 3');
        expect(healthy.text).toContain('merchant_webhook_queue_oldest_age_seconds 180');
        expect(healthy.text).toContain('merchant_webhook_queue_delayed 1');
        recordWebhookQueue({available:false});
        const unavailable=await request(app).get('/metrics');
        expect(unavailable.text).toContain('merchant_webhook_queue_available 0');
        expect(unavailable.text).toContain('merchant_webhook_queue_pending_events 3');
        expect(unavailable.text).toMatch(/merchant_webhook_queue_last_sample_timestamp_seconds [1-9]\d+/);
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

    test('skips static and high-frequency refresh paths', () => {
        expect(shouldSkipMetrics('/css/app.css')).toBe(true);
        expect(shouldSkipMetrics('/executor-portal/api/live-tasks')).toBe(true);
        expect(shouldSkipMetrics('/client/api/transactions?date=2026-08-08')).toBe(true);
        expect(shouldSkipMetrics('/transactions')).toBe(false);
    });
});
