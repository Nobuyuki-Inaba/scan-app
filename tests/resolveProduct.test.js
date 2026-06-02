// resolveProduct depends on the module-level `demoMode` variable, which is
// evaluated once when app.js is first loaded. We use jest.resetModules() in
// beforeEach to force a fresh module evaluation with the desired localStorage state.

const CATEGORIES = ['分類A', '分類B', '分類C'];

describe('resolveProduct() — demoMode OFF', () => {
  let resolveProduct;

  beforeEach(() => {
    localStorage.setItem('demo_mode', 'false');
    jest.resetModules();
    ({ resolveProduct } = require('../js/app.js'));
  });

  test('returns dbProduct unchanged when found', () => {
    const dbProduct = { jan: '111', name: 'Widget', category: 'Tools', description: 'A tool' };
    expect(resolveProduct('111', dbProduct)).toEqual(dbProduct);
  });

  test('returns fallback with category 不明 when dbProduct is null', () => {
    expect(resolveProduct('999', null)).toEqual({
      jan: '999',
      name: '',
      category: '不明',
      description: '',
    });
  });
});

describe('resolveProduct() — demoMode ON', () => {
  let resolveProduct;

  beforeEach(() => {
    localStorage.setItem('demo_mode', 'true');
    jest.resetModules();
    ({ resolveProduct } = require('../js/app.js'));
  });

  test('overrides category with a round-robin value when dbProduct is provided', () => {
    const dbProduct = { jan: '222', name: 'Gadget', category: 'Electronics', description: '' };
    const result = resolveProduct('222', dbProduct);
    expect(CATEGORIES).toContain(result.category);
    expect(result.jan).toBe('222');
    expect(result.name).toBe('Gadget');
  });

  test('returns empty name and a round-robin category when dbProduct is null', () => {
    const result = resolveProduct('333', null);
    expect(CATEGORIES).toContain(result.category);
    expect(result.name).toBe('');
    expect(result.description).toBe('');
  });
});
