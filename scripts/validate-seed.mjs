import fs from 'node:fs';
import assert from 'node:assert/strict';
const catalog = JSON.parse(fs.readFileSync(new URL('../fixtures/packages.json', import.meta.url),'utf8'));
const company = JSON.parse(fs.readFileSync(new URL('../fixtures/company.json', import.meta.url),'utf8'));
assert.equal(company.fictional, true);
assert.equal(company.actual_bookings_supported, false);
assert.equal(catalog.data_status, 'DEMO_ONLY_NOT_LIVE_OFFERS');
assert.ok(catalog.packages.length >= 4);
const ids = new Set();
for (const p of catalog.packages) {
  assert.ok(!ids.has(p.id), `duplicate ${p.id}`); ids.add(p.id);
  assert.ok(p.destination && p.destination_ar && p.name_ar);
  assert.ok(Number.isInteger(p.days) && p.days > 0);
  assert.equal(p.nights,p.days-1);
  assert.ok(typeof p.price_per_person === 'number' && p.price_per_person > 0);
  assert.equal(p.currency, 'EGP');
  assert.equal(p.status, 'demo_on_request');
  assert.equal(p.booking_enabled, false);
  assert.equal(p.seats_remaining,null);
  assert.deepEqual(p.departure_dates,[]);
  assert.ok(p.disclaimer_ar.includes('افتراضي'));
}
console.log(`PASS: ${catalog.packages.length} valid demo package fixtures (no fake live inventory)`);
