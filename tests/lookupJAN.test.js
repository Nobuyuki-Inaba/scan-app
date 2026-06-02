const FDBFactory = require('fake-indexeddb/lib/FDBFactory');
const { bulkInsert, lookupJAN } = require('../js/app.js');

function openTestDB() {
  const factory = new FDBFactory();
  return new Promise((resolve, reject) => {
    const req = factory.open('test_db', 1);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore('products', { keyPath: 'jan' });
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

describe('lookupJAN()', () => {
  let db;

  beforeEach(async () => {
    db = await openTestDB();
    await bulkInsert(db, [
      { jan: '4901234567890', name: 'Test Product', category: '分類A', description: 'A test item' },
      { jan: '0000000000000', name: '',             category: '分類B', description: '' },
    ]);
  });

  afterEach(() => {
    db.close();
  });

  test('returns the matching product object for an existing JAN', async () => {
    const result = await lookupJAN(db, '4901234567890');
    expect(result).toEqual({
      jan: '4901234567890',
      name: 'Test Product',
      category: '分類A',
      description: 'A test item',
    });
  });

  test('returns null for a JAN that does not exist', async () => {
    const result = await lookupJAN(db, '0000000000001');
    expect(result).toBeNull();
  });

  test('returns the correct product when JAN is all zeros', async () => {
    const result = await lookupJAN(db, '0000000000000');
    expect(result).toMatchObject({ jan: '0000000000000', category: '分類B' });
  });

  test('JAN is stored and matched as a string (no numeric coercion)', async () => {
    const result = await lookupJAN(db, '4901234567890');
    expect(typeof result.jan).toBe('string');
  });

  test('returns null for old JAN after bulkInsert replaces the store', async () => {
    await bulkInsert(db, [{ jan: '9999999999999', name: 'Other', category: 'C', description: '' }]);
    const result = await lookupJAN(db, '4901234567890');
    expect(result).toBeNull();
  });
});
