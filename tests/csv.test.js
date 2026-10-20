// jsdom 環境には TextDecoder が無いので Node のものを使う。Papa はブラウザ版をグローバルに置く
global.TextDecoder = require('node:util').TextDecoder;
global.Papa = require('../public/vendor/papaparse.min.js');

const { buildColumnMap, rowToRecord, decodeCsvBytes, parseCsvRecords } = require('../public/js/app.js');

describe('decodeCsvBytes()', () => {
  test('decodes UTF-8 and strips the BOM', () => {
    const bytes = new Uint8Array([0xEF, 0xBB, 0xBF, ...Buffer.from('JAN,商品名\n', 'utf8')]);
    expect(decodeCsvBytes(bytes)).toBe('JAN,商品名\n');
  });

  test('falls back to Shift_JIS (Japanese Excel "CSV")', () => {
    // "JAN,商品名\n" in Shift_JIS
    const bytes = new Uint8Array([0x4A, 0x41, 0x4E, 0x2C, 0x8F, 0xA4, 0x95, 0x69, 0x96, 0xBC, 0x0A]);
    expect(decodeCsvBytes(bytes)).toBe('JAN,商品名\n');
  });
});

describe('parseCsvRecords()', () => {
  test('reads a header CSV with Japanese product names', () => {
    const { records, skippedExp, noDetails } = parseCsvRecords(
      'JAN,sku-name,category,description\r\n4901234567894,ボールペン 黒,横浜へ移動,棚A-3\r\n');
    expect(records).toEqual([
      { jan: '4901234567894', name: 'ボールペン 黒', category: '横浜へ移動', description: '棚A-3' },
    ]);
    expect(skippedExp).toBe(0);
    expect(noDetails).toBe(false);
  });

  test('keeps quoted commas and newlines inside a product name', () => {
    const { records } = parseCsvRecords('JAN,商品名\n4901234567894,"ペン, 黒\n0.5mm"\n');
    expect(records[0].name).toBe('ペン, 黒\n0.5mm');
  });

  test('reads a headerless CSV by column order', () => {
    const { records } = parseCsvRecords('490123456789,名前,分類A,説明\n');
    expect(records[0]).toEqual({ jan: '0490123456789', name: '名前', category: '分類A', description: '説明' });
  });

  test('deduplicates JAN (last row wins) and skips blank JAN', () => {
    const { records } = parseCsvRecords('JAN,商品名\n4901234567894,旧\n,空\n4901234567894,新\n');
    expect(records).toEqual([{ jan: '4901234567894', name: '新', category: '', description: '' }]);
  });

  test('counts and skips Excel exponent JAN', () => {
    const { records, skippedExp } = parseCsvRecords('JAN,商品名\n4.90123E+12,a\n4901234567894,b\n');
    expect(records).toHaveLength(1);
    expect(skippedExp).toBe(1);
  });

  test('flags a CSV without name/category columns', () => {
    expect(parseCsvRecords('JAN,ラック,棚番号\n4901234567894,A,3\n').noDetails).toBe(true);
  });

  test('rejects a header CSV without a JAN column (e.g. an HTML page)', () => {
    expect(() => parseCsvRecords('<!DOCTYPE html>\n<html>\n')).toThrow('JAN列が見つかりません');
  });

  test('rejects an empty CSV', () => {
    expect(() => parseCsvRecords('')).toThrow('CSVにデータがありません');
    expect(() => parseCsvRecords('JAN,商品名\n')).toThrow('CSVにデータがありません');
  });
});

describe('buildColumnMap()', () => {
  test('treats a row starting with digits as data (no header)', () => {
    const { hasHeader, index } = buildColumnMap(['4901234567894', 'Name', 'Cat', 'Desc']);
    expect(hasHeader).toBe(false);
    expect(index).toEqual({ jan: 0, name: 1, category: 2, description: 3 });
  });

  test('treats an Excel exponent first cell as data', () => {
    expect(buildColumnMap(['4.90123E+12', 'x']).hasHeader).toBe(false);
  });

  test('maps header names in any order, case-insensitively, with BOM', () => {
    const { hasHeader, index } = buildColumnMap(['description', 'Category', '﻿JAN', 'sku-name']);
    expect(hasHeader).toBe(true);
    expect(index).toEqual({ jan: 2, name: 3, category: 1, description: 0 });
  });

  test.each(['sku-name', 'sku_name', 'SKU Name', 'SKU_NAME', 'skuname'])(
    'accepts the product-name header spelled %s', (h) => {
      expect(buildColumnMap(['JAN', h]).index.name).toBe(1);
    });

  test('accepts Japanese aliases', () => {
    const { index } = buildColumnMap(['JAN', '商品名', 'カテゴリ', '備考']);
    expect(index).toEqual({ jan: 0, name: 1, category: 2, description: 3 });
  });

  test('marks missing columns as -1', () => {
    const { index } = buildColumnMap(['JAN', 'ラック', '棚番号']);
    expect(index.jan).toBe(0);
    expect(index.name).toBe(-1);
    expect(index.category).toBe(-1);
  });

  test('reports jan -1 when there is no JAN column', () => {
    expect(buildColumnMap(['code', 'name']).index.jan).toBe(-1);
  });
});

describe('rowToRecord()', () => {
  const index = { jan: 0, name: 1, category: 2, description: 3 };

  test('builds a trimmed record and pads 12-digit JAN', () => {
    expect(rowToRecord([' 490123456789 ', ' Name ', 'Cat', 'Desc'], index)).toEqual({
      jan: '0490123456789', name: 'Name', category: 'Cat', description: 'Desc',
    });
  });

  test('fills missing cells and missing columns with empty strings', () => {
    expect(rowToRecord(['4901234567894'], { jan: 0, name: 1, category: -1, description: -1 })).toEqual({
      jan: '4901234567894', name: '', category: '', description: '',
    });
  });
});
