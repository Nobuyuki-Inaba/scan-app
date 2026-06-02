// Install fake-indexeddb as global IndexedDB before any test file loads app.js.
require('fake-indexeddb/auto');

// Set a known demoMode default so app.js line 25 evaluates deterministically.
localStorage.setItem('demo_mode', 'false');
