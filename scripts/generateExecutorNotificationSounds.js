'use strict';

const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 22050;
const OUTPUT_DIR = path.join(__dirname, '..', 'mobile_app', 'android', 'app', 'src', 'main', 'res', 'raw');

const soundPlans = {
    ahram_task_arrival: [[523, 180], [659, 180], [784, 300]],
    ahram_task_assigned: [[659, 220], [880, 360]],
    ahram_task_reminder: [[784, 180], [0, 120], [784, 260]],
    ahram_urgent_alarm: [[880, 420], [660, 280], [880, 420], [660, 280], [988, 600]],
    ahram_status_update: [[587, 150], [698, 220]],
    ahram_success: [[523, 130], [659, 130], [784, 160], [1046, 360]],
    ahram_cancellation: [[440, 260], [349, 420]],
    ahram_support: [[698, 150], [880, 260]],
    ahram_balance_warning: [[392, 200], [392, 200], [330, 380]],
    ahram_security: [[740, 150], [554, 170], [740, 320]],
    ahram_report_ready: [[523, 130], [659, 260]]
};

const writeUInt32LE = (buffer, value, offset) => buffer.writeUInt32LE(value >>> 0, offset);
const writeUInt16LE = (buffer, value, offset) => buffer.writeUInt16LE(value & 0xffff, offset);

const renderPlan = (plan) => {
    const samples = [];
    const gapSamples = Math.round(SAMPLE_RATE * 0.045);
    for (const [frequency, durationMs] of plan) {
        const length = Math.round(SAMPLE_RATE * durationMs / 1000);
        for (let index = 0; index < length; index += 1) {
            if (!frequency) {
                samples.push(0);
                continue;
            }
            const position = index / SAMPLE_RATE;
            const fadeSamples = Math.max(1, Math.min(Math.round(SAMPLE_RATE * 0.03), Math.floor(length / 3)));
            const envelope = Math.min(1, index / fadeSamples, (length - index - 1) / fadeSamples);
            const fundamental = Math.sin(2 * Math.PI * frequency * position);
            const harmonic = 0.2 * Math.sin(2 * Math.PI * frequency * 2 * position);
            samples.push(Math.round(32767 * 0.28 * Math.max(0, envelope) * (fundamental + harmonic)));
        }
        for (let index = 0; index < gapSamples; index += 1) samples.push(0);
    }
    return samples;
};

const wavBuffer = (samples) => {
    const dataLength = samples.length * 2;
    const buffer = Buffer.alloc(44 + dataLength);
    buffer.write('RIFF', 0, 'ascii');
    writeUInt32LE(buffer, 36 + dataLength, 4);
    buffer.write('WAVE', 8, 'ascii');
    buffer.write('fmt ', 12, 'ascii');
    writeUInt32LE(buffer, 16, 16);
    writeUInt16LE(buffer, 1, 20);
    writeUInt16LE(buffer, 1, 22);
    writeUInt32LE(buffer, SAMPLE_RATE, 24);
    writeUInt32LE(buffer, SAMPLE_RATE * 2, 28);
    writeUInt16LE(buffer, 2, 32);
    writeUInt16LE(buffer, 16, 34);
    buffer.write('data', 36, 'ascii');
    writeUInt32LE(buffer, dataLength, 40);
    samples.forEach((sample, index) => buffer.writeInt16LE(sample, 44 + (index * 2)));
    return buffer;
};

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
for (const [name, plan] of Object.entries(soundPlans)) {
    fs.writeFileSync(path.join(OUTPUT_DIR, `${name}.wav`), wavBuffer(renderPlan(plan)));
}

console.log(`Generated ${Object.keys(soundPlans).length} notification sounds in ${OUTPUT_DIR}`);
