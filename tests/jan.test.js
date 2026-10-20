const {
  normalizeCode, normalizeScanned, isExcelExponent, hasValidCheckDigit, expandUPCE,
} = require('../public/js/app.js');

describe('normalizeCode()', () => {
  test('pads a 12-digit code with a leading 0', () => {
    expect(normalizeCode('490123456789')).toBe('0490123456789');
  });

  test('keeps 13-digit and 8-digit codes as they are', () => {
    expect(normalizeCode('4901234567894')).toBe('4901234567894');
    expect(normalizeCode('96385074')).toBe('96385074');
  });

  test('trims whitespace and BOM', () => {
    expect(normalizeCode('﻿ 4901234567894 ')).toBe('4901234567894');
  });

  test('does not pad 12-character non-numeric text (e.g. QR content)', () => {
    expect(normalizeCode('ABCDEFGHIJKL')).toBe('ABCDEFGHIJKL');
  });

  test('returns empty string for null / undefined', () => {
    expect(normalizeCode(null)).toBe('');
    expect(normalizeCode(undefined)).toBe('');
  });
});

describe('isExcelExponent()', () => {
  test('detects Excel scientific notation', () => {
    expect(isExcelExponent('4.90123E+12')).toBe(true);
    expect(isExcelExponent('4E+12')).toBe(true);
  });

  test('ignores ordinary codes', () => {
    expect(isExcelExponent('4901234567894')).toBe(false);
  });
});

describe('hasValidCheckDigit()', () => {
  test('accepts valid EAN-13 / EAN-8 / UPC-A', () => {
    expect(hasValidCheckDigit('4006381333931')).toBe(true);
    expect(hasValidCheckDigit('96385074')).toBe(true);
    expect(hasValidCheckDigit('036000291452')).toBe(true);
  });

  test('rejects a wrong check digit', () => {
    expect(hasValidCheckDigit('4006381333932')).toBe(false);
    expect(hasValidCheckDigit('96385075')).toBe(false);
  });

  test('rejects unsupported lengths and non-digits', () => {
    expect(hasValidCheckDigit('12345')).toBe(false);
    expect(hasValidCheckDigit('40063813339AB')).toBe(false);
  });
});

describe('expandUPCE()', () => {
  test('expands each UPC-E pattern to UPC-A', () => {
    expect(expandUPCE('01234565')).toBe('012345000065'); // 末尾 5-9
    expect(expandUPCE('01234505')).toBe('012000003455'); // 末尾 0-2
    expect(expandUPCE('01234531')).toBe('012300000451'); // 末尾 3
    expect(expandUPCE('01234546')).toBe('012340000056'); // 末尾 4
  });

  test('expanded codes carry a valid check digit', () => {
    expect(hasValidCheckDigit(expandUPCE('01234565'))).toBe(true);
  });

  test('returns input unchanged when it is not UPC-E', () => {
    expect(expandUPCE('4901234567894')).toBe('4901234567894');
  });
});

describe('normalizeScanned()', () => {
  test('converts UPC-E to the 13-digit key used in the DB', () => {
    expect(normalizeScanned('01234565', 'UPCE')).toBe('0012345000065');
  });

  test('passes EAN-13 through', () => {
    expect(normalizeScanned('4901234567894', 'EAN13')).toBe('4901234567894');
  });
});
