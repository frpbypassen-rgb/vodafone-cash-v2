'use strict';

let puppeteerPromise = null;

const loadPuppeteer = () => {
    if (!puppeteerPromise) {
        puppeteerPromise = import('puppeteer')
            .then((module) => module.default || module)
            .catch((error) => {
                puppeteerPromise = null;
                throw error;
            });
    }
    return puppeteerPromise;
};

module.exports = { loadPuppeteer };
