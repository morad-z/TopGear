"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

function checker() {
  const context = vm.createContext({ document: { addEventListener() {} } });
  for (const name of ["indexedDB", "localStorage", "sessionStorage"]) {
    Object.defineProperty(context, name, { get() { assert.fail(`Backup inspection accessed ${name}`); } });
  }
  vm.runInContext(readFileSync(join(__dirname, "..", "app.js"), "utf8"), context);
  return vm.runInContext("inspectBackup", context);
}

function backup() {
  return {
    app: "TopGear", version: 5, exportedAt: "2026-11-02T12:00:00Z",
    jobs: [{ id: 1, vehiclePlate: "TEST-1", jobDate: "2026-11-02", laborPrice: 100, taxEnabled: true, taxRate: 18,
      parts: [{ partId: 999, nameSnapshot: "Historical part", quantityUsed: 1, garageCostSnapshot: 20, customerPriceSnapshot: 40 }] }],
    inventory: [{ id: 1, sku: "SKU-1", name: "Part", quantity: 3, garageCost: 20, customerPrice: 40 }],
    customCategories: [{ id: "custom_one", label: "Category" }],
    appointments: [{ id: 1, appointmentDate: "2026-11-03", customerName: "Fixture" }],
    expenses: [{ id: 1, date: "2026-11-02", amount: 10 }],
    business: { name: "Fixture", defaultTaxRate: 18 }
  };
}

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test("current backup is inspected without storage access or changing records", () => {
  const payload = freeze(backup());
  const before = JSON.stringify(payload);
  const result = checker()(payload);
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.counts.jobs, 1);
  assert.equal(result.counts.business, 1);
  assert.equal(result.exportedAt, payload.exportedAt);
  assert.equal(JSON.stringify(payload), before);
});

test("older backups may omit optional lists and business settings", () => {
  const result = checker()({ app: "TopGear", version: 1, jobs: [], inventory: [] });
  assert.equal(result.valid, true);
  assert.equal(result.counts.appointments, 0);
  assert.equal(result.counts.expenses, 0);
  assert.ok(result.warnings.length > 0);
});

test("deleted inventory references do not invalidate historical price snapshots", () => {
  const payload = backup();
  payload.inventory = [];
  assert.equal(checker()(payload).valid, true);
});

for (const value of [null, [], "backup", 12, true]) {
  test(`rejects a non-record top level (${JSON.stringify(value)})`, () => {
    assert.equal(checker()(value).valid, false);
  });
}

const invalidCases = {
  "missing jobs": (payload) => { delete payload.jobs; },
  "wrong inventory type": (payload) => { payload.inventory = {}; },
  "foreign app": (payload) => { payload.app = "Another App"; },
  "future format": (payload) => { payload.version = 6; },
  "malformed record": (payload) => { payload.jobs[0] = null; },
  "duplicate job IDs": (payload) => { payload.jobs.push({ ...payload.jobs[0] }); },
  "duplicate SKUs": (payload) => { payload.inventory.push({ ...payload.inventory[0], id: 2 }); },
  "invalid numeric ID": (payload) => { payload.inventory[0].id = "1"; },
  "missing category label": (payload) => { delete payload.customCategories[0].label; },
  "missing appointment customer": (payload) => { delete payload.appointments[0].customerName; },
  "invalid calendar date": (payload) => { payload.jobs[0].jobDate = "2026-02-30"; },
  "wrong date format": (payload) => { payload.expenses[0].date = "02/11/2026"; },
  "negative expense": (payload) => { payload.expenses[0].amount = -1; },
  "zero expense skipped by import": (payload) => { payload.expenses[0].amount = 0; },
  "fractional inventory quantity": (payload) => { payload.inventory[0].quantity = 1.5; },
  "non-numeric historical price": (payload) => { payload.jobs[0].parts[0].garageCostSnapshot = "bad"; },
  "missing historical price": (payload) => { delete payload.jobs[0].parts[0].customerPriceSnapshot; },
  "invalid job parts": (payload) => { payload.jobs[0].parts = {}; },
  "string tax flag": (payload) => { payload.jobs[0].taxEnabled = "false"; },
  "out-of-range tax": (payload) => { payload.business.defaultTaxRate = 150; },
  "malformed business": (payload) => { payload.business = []; }
};

for (const [name, change] of Object.entries(invalidCases)) {
  test(`reports ${name}`, () => {
    const payload = backup();
    change(payload);
    const before = JSON.stringify(payload);
    const result = checker()(payload);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
    assert.equal(JSON.stringify(payload), before);
  });
}

test("large malformed backups produce a bounded error summary", () => {
  const payload = backup();
  payload.jobs = Array(1000).fill(null);
  const result = checker()(payload);
  assert.equal(result.valid, false);
  assert.equal(result.counts.jobs, 1000);
  assert.ok(result.errors.length <= 21);
  assert.match(result.errors.at(-1), /980/);
});
