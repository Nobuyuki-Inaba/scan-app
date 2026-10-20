describe('loadEnabledFormatKeys()', () => {
  let loadEnabledFormatKeys, buildReaderOptions;

  beforeEach(() => {
    localStorage.removeItem('scan_formats_v2');
    jest.resetModules();
    ({ loadEnabledFormatKeys, buildReaderOptions } = require('../public/js/app.js'));
  });

  test('defaults to EAN-13 and EAN-8 only', () => {
    expect(loadEnabledFormatKeys()).toEqual(['EAN_13', 'EAN_8']);
    expect(buildReaderOptions().formats).toEqual(['EAN13', 'EAN8']);
  });

  test('uses saved keys', () => {
    localStorage.setItem('scan_formats_v2', JSON.stringify(['EAN_13', 'QR_CODE']));
    expect(buildReaderOptions().formats).toEqual(['EAN13', 'QRCode']);
  });

  test.each(['null', '"EAN_13"', '{}', '[]', 'not json', '["UNKNOWN"]'])(
    'falls back to defaults for a broken saved value %s', (raw) => {
      localStorage.setItem('scan_formats_v2', raw);
      expect(loadEnabledFormatKeys()).toEqual(['EAN_13', 'EAN_8']);
    });
});

describe('toSourceRect()', () => {
  const { guideRect, toSourceRect } = require('../public/js/app.js');

  test('maps the visible area of a portrait video shown with object-fit: cover', () => {
    // 375x180 の表示枠に 1080x1920 の縦長映像 → 横幅基準で拡大、上下がはみ出す
    const view = { x: 0, y: 0, w: 375, h: 180 };
    const src = toSourceRect(view, 375, 180, 1080, 1920);
    const scale = 375 / 1080;
    expect(src.w).toBeCloseTo(1080);
    expect(src.h).toBeCloseTo(180 / scale);
    expect(src.x).toBeCloseTo(0);
    expect(src.y).toBeCloseTo((1920 - 180 / scale) / 2);
  });

  test('keeps the guide box aspect ratio (no distortion)', () => {
    const g = guideRect(375, 180, false);
    const src = toSourceRect(g, 375, 180, 1080, 1920);
    expect(src.w / src.h).toBeCloseTo(g.w / g.h);
  });

  test('decodes at source resolution, not CSS pixels', () => {
    const g = guideRect(375, 180, false);
    const src = toSourceRect(g, 375, 180, 1080, 1920);
    expect(src.w).toBeGreaterThan(900);
  });

  test('square guide for QR fits inside the view', () => {
    const g = guideRect(375, 180, true);
    expect(g.w).toBe(g.h);
    expect(g.h).toBeLessThanOrEqual(180);
  });
});
