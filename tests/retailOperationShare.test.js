'use strict';
const { canShareFile, shareFile } = require('../public/js/retail-operation-dialog');
test('shares the prepared image file without exposing a private server URL', async () => {
    const file = { name: 'receipt.png', type: 'image/png' },
        navigator = { canShare: () => true, share: jest.fn().mockResolvedValue() };
    await shareFile(file, navigator);
    expect(navigator.share).toHaveBeenCalledWith({ files: [file], title: 'إثبات العملية' });
});
test('unsupported browsers cannot falsely report a successful share', async () => {
    const navigator = { share: jest.fn() };
    expect(canShareFile({}, navigator)).toBe(false);
    await expect(shareFile({}, navigator)).rejects.toThrow('SHARE_UNSUPPORTED');
    expect(navigator.share).not.toHaveBeenCalled();
});
test('cancellation remains distinguishable from an actual sharing error', async () => {
    const error = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    await expect(
        shareFile({ name: 'receipt.png' }, { canShare: () => true, share: () => Promise.reject(error) })
    ).rejects.toHaveProperty('name', 'AbortError');
});
