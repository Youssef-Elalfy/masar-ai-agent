import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { packages: trips } = JSON.parse(readFileSync(new URL('../fixtures/packages.json', import.meta.url), 'utf8'));
test('initial four demos exist', () => assert.deepEqual(new Set(trips.map(p=>p.destination)), new Set(['Hurghada','Nubia','Sharm El Sheikh','Fayoum'])));
test('cheapest package is Fayoum demo', () => assert.equal([...trips].sort((a,b)=>a.price_per_person-b.price_per_person)[0].destination, 'Fayoum'));
test('all demo packages do not claim live inventory', () => assert.ok(trips.every(p=>p.booking_enabled===false && p.seats_remaining===null && p.departure_dates.length===0)));
