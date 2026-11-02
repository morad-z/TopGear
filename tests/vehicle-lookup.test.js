"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const source = readFileSync(join(__dirname, "..", "app.js"), "utf8");
const jobOptions = { fillModel: true, fillYear: true, fillEngine: true };
const vehicle = {
  tozeret_nm: "Toyota Japan", kinuy_mishari: "Corolla", shnat_yitzur: 2020,
  tozeret_cd: 7, degem_cd: 42, tzeva_rechev: "White", sug_delek_nm: "Petrol"
};
const model = { tozar: "Toyota", nefah_manoa: 1798 };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let i = 0; i < 15; i++) await Promise.resolve();
}

function element(name = "") {
  const attributes = new Map();
  const listeners = new Map();
  const classes = new Set();
  return {
    name, value: "", dataset: {},
    querySelectorAll() { return []; },
    classList: {
      add: (value) => classes.add(value), remove: (value) => classes.delete(value),
      contains: (value) => classes.has(value), toggle() {}
    },
    setAttribute: (key, value) => attributes.set(key, value),
    removeAttribute: (key) => attributes.delete(key),
    getAttribute: (key) => attributes.get(key),
    addEventListener(type, callback, options) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push({ callback, capture: options === true || options?.capture });
    },
    fire(type, target = this, captureOnly = false) {
      for (const listener of listeners.get(type) || []) {
        if (!captureOnly || listener.capture) listener.callback({ currentTarget: this, target });
      }
    }
  };
}

function form(plate = "12-345-67", initial = {}) {
  const result = element();
  result.elements = Object.fromEntries(
    ["vehiclePlate", "vehicleModel", "vehicleYear", "engineDisplacement"].map((name) => [name, element(name)])
  );
  result.elements.vehiclePlate.value = plate;
  for (const [name, value] of Object.entries(initial)) result.elements[name].value = value;
  return result;
}

function harness(t) {
  let clock = 0, timerId = 0, storageTouches = 0;
  const timers = new Map(), nodes = new Map(), calls = [], toasts = [];
  nodes.set("#jobForm", form());
  nodes.set("#appointmentForm", form());
  const context = vm.createContext({
    AbortController, URLSearchParams,
    Date: class extends Date { static now() { return clock; } },
    console: { warn() {}, error() {} },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, due: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    document: {
      addEventListener() {}, querySelectorAll() { return []; }, getElementById() { return null; },
      querySelector(selector) {
        if (!nodes.has(selector)) nodes.set(selector, element());
        return nodes.get(selector);
      }
    },
    window: { addEventListener() {} },
    testToasts: toasts,
    fetch(url, { signal }) {
      const response = deferred();
      calls.push({ url: new URL(url), signal, response });
      signal.addEventListener("abort", () => response.reject(new Error("aborted")), { once: true });
      return response.promise;
    }
  });
  // Any storage access is a test failure, including accesses swallowed by error handling.
  for (const name of ["indexedDB", "localStorage", "sessionStorage"]) {
    Object.defineProperty(context, name, { get() { storageTouches++; throw new Error("Unexpected storage access"); } });
  }
  vm.runInContext(source, context);
  vm.runInContext("showToast = (message) => testToasts.push(message)", context);
  const api = vm.runInContext("({ autofillVehicleFields, lookupVehicleByPlate, ckanQuery, resetVehicleLookup, handleVehicleLookupInput, closeModal, cacheElements, bindEvents, els, state, vehicleQueryCache, vehicleQueryRequests })", context);
  api.cacheElements();
  api.bindEvents();
  t.after(() => assert.equal(storageTouches, 0, "lookups must never access customer storage"));
  return {
    api, calls, toasts, timers, nodes,
    lookup(target, options = jobOptions) { return api.autofillVehicleFields(target.elements.vehiclePlate, target, options); },
    reply(index, record, extra = {}) {
      calls[index].response.resolve({ ok: true, json: async () => ({ success: true, result: { records: record ? [record] : [] } }), ...extra });
    },
    edit(target, name, value) {
      const field = target.elements[name];
      field.value = value;
      api.handleVehicleLookupInput({ currentTarget: target, target: field });
    },
    async advance(ms) {
      clock += ms;
      for (const [id, timer] of timers) {
        if (timer.due <= clock) { timers.delete(id); timer.callback(); }
      }
      await flush();
    }
  };
}

test("job details fill before the engine request finishes; queries omit unused fields and totals", async (t) => {
  const h = harness(t), target = form();
  const pending = h.lookup(target);
  const query = h.calls[0].url.searchParams;
  assert.deepEqual(JSON.parse(query.get("filters")), { mispar_rechev: "1234567" });
  assert.equal(query.get("include_total"), "false");
  assert.equal(query.get("limit"), "1");
  assert.ok(query.get("fields").includes("degem_cd"));
  h.reply(0, vehicle);
  await flush();
  assert.equal(target.elements.vehicleModel.value, "Toyota Japan Corolla");
  assert.equal(target.elements.vehicleYear.value, "2020");
  assert.equal(target.elements.engineDisplacement.value, "");
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].url.searchParams.get("fields"), "tozar,nefah_manoa");
  h.reply(1, model);
  await pending;
  assert.equal(target.elements.vehicleModel.value, "Toyota Corolla");
  assert.equal(target.elements.engineDisplacement.value, "1798");
  assert.equal(target.elements.vehiclePlate.getAttribute("aria-busy"), undefined);
  assert.equal(h.timers.size, 0);
});

test("appointment blur fills the model with just one request", async (t) => {
  const h = harness(t), target = h.api.els.appointmentForm;
  target.elements.vehiclePlate.fire("blur");
  h.reply(0, vehicle);
  await flush();
  assert.equal(target.elements.vehicleModel.value, "Toyota Japan Corolla");
  assert.equal(target.elements.vehicleYear.value, "");
  assert.equal(h.calls.length, 1);
});

test("concurrent forms share requests and repeated formatted plates use the session cache", async (t) => {
  const h = harness(t), first = form(), second = form("123 45 67");
  const one = h.lookup(first), two = h.lookup(second);
  assert.equal(h.calls.length, 1);
  h.reply(0, vehicle);
  await flush();
  assert.equal(h.calls.length, 2);
  h.reply(1, model);
  await Promise.all([one, two]);
  const repeated = form("1234567");
  await h.lookup(repeated);
  assert.equal(h.calls.length, 2);
  for (const target of [first, second, repeated]) assert.equal(target.elements.engineDisplacement.value, "1798");
  assert.equal(h.api.vehicleQueryRequests.size, 0);
});

test("different vehicles of the same model share the engine request", async (t) => {
  const h = harness(t);
  const one = h.lookup(form()), two = h.lookup(form("7654321"));
  h.reply(0, vehicle);
  h.reply(1, vehicle);
  await flush();
  assert.equal(h.calls.length, 3);
  h.reply(2, model);
  await Promise.all([one, two]);
});

test("cached records expire after 30 minutes", async (t) => {
  const h = harness(t), target = form();
  const first = h.lookup(target, { fillModel: true });
  h.reply(0, vehicle);
  await first;
  await h.advance(30 * 60 * 1000);
  const second = h.lookup(form(), { fillModel: true });
  assert.equal(h.calls.length, 2);
  h.reply(1, vehicle);
  await second;
});

test("session cache has a fixed size", async (t) => {
  const h = harness(t);
  for (let i = 0; i < 205; i++) {
    const pending = h.lookup(form(String(1000000 + i)), { fillModel: true });
    h.reply(i, vehicle);
    await pending;
  }
  assert.equal(h.api.vehicleQueryCache.size, 200);
});

for (const failure of ["network", "http", "api", "malformed", "missing"]) {
  test(`${failure} failure permits another lookup of the same plate`, async (t) => {
    const h = harness(t), target = form();
    const first = h.lookup(target, { fillModel: true });
    if (failure === "network") h.calls[0].response.reject(new Error("offline"));
    else if (failure === "http") h.reply(0, null, { ok: false, status: 503 });
    else if (failure === "api") h.reply(0, null, { json: async () => ({ success: false }) });
    else if (failure === "malformed") h.reply(0, null, { json: async () => ({ success: true }) });
    else h.reply(0, null);
    await first;
    const second = h.lookup(target, { fillModel: true });
    assert.equal(h.calls.length, 2);
    h.reply(1, vehicle);
    await second;
    assert.equal(target.elements.vehicleModel.value, "Toyota Japan Corolla");
    assert.equal(h.timers.size, 0);
  });
}

test("a stalled vehicle query aborts at eight seconds and can be retried", async (t) => {
  const h = harness(t), target = form();
  const first = h.lookup(target, { fillModel: true });
  await h.advance(8000);
  await first;
  assert.equal(h.calls[0].signal.aborted, true);
  assert.match(h.toasts.at(-1), /החיפוש ארך/);
  assert.equal(target.elements.vehiclePlate.getAttribute("aria-busy"), undefined);
  const second = h.lookup(target, { fillModel: true });
  h.reply(1, vehicle);
  await second;
  assert.equal(target.elements.vehicleYear.value, "");
  assert.equal(target.elements.vehicleModel.value, "Toyota Japan Corolla");
});

test("the timeout also covers reading a stalled JSON response body", async (t) => {
  const h = harness(t), target = form();
  const pending = h.lookup(target, { fillModel: true });
  h.reply(0, null, { json: () => new Promise((resolve, reject) => {
    h.calls[0].signal.addEventListener("abort", () => reject(new Error("body aborted")), { once: true });
  }) });
  await flush();
  await h.advance(8000);
  await pending;
  assert.match(h.toasts.at(-1), /החיפוש ארך/);
  assert.equal(h.timers.size, 0);
});

test("an engine timeout keeps basic details and retry fetches only the missing engine", async (t) => {
  const h = harness(t), target = form();
  const first = h.lookup(target);
  h.reply(0, vehicle);
  await flush();
  await h.advance(5000);
  await first;
  assert.equal(target.elements.vehicleYear.value, "2020");
  assert.equal(target.elements.engineDisplacement.value, "");
  assert.equal(h.calls[1].signal.aborted, true);
  const second = h.lookup(target);
  await flush();
  assert.equal(h.calls.length, 3);
  h.reply(2, model);
  await second;
  assert.equal(target.elements.engineDisplacement.value, "1798");
});

test("late results for another plate cannot fill the form or show stale notices", async (t) => {
  const h = harness(t), target = h.api.els.jobForm;
  const first = h.lookup(target);
  target.elements.vehiclePlate.value = "7654321";
  target.fire("input", target.elements.vehiclePlate);
  const second = h.lookup(target);
  h.reply(1, { ...vehicle, kinuy_mishari: "Yaris", degem_cd: 99 });
  await flush();
  h.reply(2, model);
  await second;
  const toastCount = h.toasts.length;
  h.reply(0, vehicle);
  await flush();
  h.reply(3, model);
  await first;
  assert.equal(target.elements.vehicleModel.value, "Toyota Yaris");
  assert.equal(h.toasts.length, toastCount);
});

test("changing plates clears only automatic values; manual edits and clears win over late results", async (t) => {
  const h = harness(t), target = form();
  const pending = h.lookup(target);
  h.reply(0, vehicle);
  await flush();
  h.edit(target, "vehicleModel", "My model");
  h.edit(target, "vehicleYear", "");
  h.edit(target, "engineDisplacement", "2000");
  h.reply(1, model);
  await pending;
  assert.equal(target.elements.vehicleModel.value, "My model");
  assert.equal(target.elements.vehicleYear.value, "");
  assert.equal(target.elements.engineDisplacement.value, "2000");
  h.edit(target, "vehiclePlate", "7654321");
  assert.equal(target.elements.vehicleModel.value, "My model");
  assert.equal(target.elements.engineDisplacement.value, "2000");
});

test("changing plates after basic autofill clears old automatic values and rejects the late engine", async (t) => {
  const h = harness(t), target = form();
  const pending = h.lookup(target);
  h.reply(0, vehicle);
  await flush();
  h.edit(target, "vehiclePlate", "7654321");
  assert.equal(target.elements.vehicleModel.value, "");
  assert.equal(target.elements.vehicleYear.value, "");
  h.reply(1, model);
  await pending;
  assert.equal(target.elements.engineDisplacement.value, "");
});

test("existing form values and stored business records are untouched", async (t) => {
  const h = harness(t);
  const initial = { vehicleModel: "Existing model", vehicleYear: "2019", engineDisplacement: "2500" };
  const target = form("1234567", initial);
  h.api.state.jobs.push({ id: 1, vehicleModel: "Saved model", parts: [{ garageCostSnapshot: 42 }] });
  const before = JSON.stringify(h.api.state);
  const pending = h.lookup(target);
  h.reply(0, vehicle);
  await flush();
  h.reply(1, model);
  await pending;
  for (const [name, value] of Object.entries(initial)) assert.equal(target.elements[name].value, value);
  assert.equal(JSON.stringify(h.api.state), before);
});

test("repeated blur and plate formatting changes share the pending lookup", async (t) => {
  const h = harness(t), target = h.api.els.jobForm;
  const pending = h.lookup(target);
  target.elements.vehiclePlate.value = "123 45 67";
  target.fire("input", target.elements.vehiclePlate);
  target.elements.vehiclePlate.fire("blur");
  assert.equal(h.calls.length, 1);
  h.reply(0, vehicle);
  await flush();
  h.reply(1, model);
  await pending;
  assert.equal(target.elements.engineDisplacement.value, "1798");
});

for (const action of ["reset", "submit", "close"]) {
  test(`${action} invalidates autofill even if a form reuses the same plate`, async (t) => {
    const h = harness(t), target = h.api.els.jobForm;
    const first = h.lookup(target);
    if (action === "close") h.api.closeModal("jobModal");
    else target.fire(action, target, action === "submit");
    h.reply(0, vehicle);
    await flush();
    assert.equal(target.elements.vehicleModel.value, "");
    h.reply(1, model);
    await first;
    assert.equal(target.elements.engineDisplacement.value, "");
    await h.lookup(target);
    assert.equal(target.elements.engineDisplacement.value, "1798");
  });
}

test("short or empty plates do not send requests", async (t) => {
  const h = harness(t);
  await h.lookup(form("12-34"));
  await h.lookup(form(""));
  assert.equal(h.calls.length, 0);
});
