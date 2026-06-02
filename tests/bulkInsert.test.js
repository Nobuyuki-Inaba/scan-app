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

describe('bulkInsert()', () => {
  let db;

  beforeEach(async () => {
    db = await openTestDB();
  });

  afterEach(() => {
    db.close();
  });

  test('resolves with the count of inserted records', async () => {
    const records = [
      { jan: '4901234567890', name: 'Alpha', category: 'A', description: '' },
      { jan: '4901234567891', name: 'Beta',  category: 'B', description: '' },
    ];
    const count = await bulkInsert(db, records);
    expect(count).toBe(2);
  });

  test('inserted records are retrievable afterwards', async () => {
    const record = { jan: '1000000000001', name: 'Item1', category: 'X', description: 'desc1' };
    await bulkInsert(db, [record]);
    const result = await lookupJAN(db, '1000000000001');
    expect(result).toEqual(record);
  });

  test('clears previous records before inserting (replace semantics)', async () => {
    await bulkInsert(db, [{ jan: '9999999999999', name: 'Old', category: 'Old', description: '' }]);
    await bulkInsert(db, [{ jan: '1111111111111', name: 'New', category: 'New', description: '' }]);

    expect(await lookupJAN(db, '9999999999999')).toBeNull();
    expect(await lookupJAN(db, '1111111111111')).not.toBeNull();
  });

  test('resolves with 0 for an empty records array', async () => {
    const count = await bulkInsert(db, []);
    expect(count).toBe(0);
  });

  test('handles a large batch (1000 records) without error', async () => {
    const records = Array.from({ length: 1000 }, (_, i) => ({
      jan: String(i).padStart(13, '0'),
      name: 'Product ' + i,
      category: 'Cat',
      description: '',
    }));
    const count = await bulkInsert(db, records);
    expect(count).toBe(1000);
  });
});
