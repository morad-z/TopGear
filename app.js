"use strict";

const DB_NAME = "topgear_offline_garage";
const DB_VERSION = 3;
const DAY_NAMES = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
const PART_CATEGORIES = [
  { id: "all", label: "הכל" },
  { id: "engine", label: "מנוע" },
  { id: "filters", label: "פילטרים" },
  { id: "brakes", label: "בלמים" },
  { id: "gear", label: "גיר" },
  { id: "electric", label: "חשמל" },
  { id: "suspension", label: "מתלים" },
  { id: "body", label: "מרכב" },
  { id: "general", label: "כללי" }
];
const NEW_CATEGORY_OPTION = "__add_new_category__";

const state = {
  db: null,
  jobs: [],
  inventory: [],
  customCategories: [],
  appointments: [],
  activeView: "jobs",
  activeRange: "today",
  activeDeliveryRange: "upcoming",
  activeAppointmentRange: "upcoming",
  activePartCategory: "all",
  activeInventoryCategory: "all",
  selectedPartId: null,
  editingJobId: null,
  editingPartId: null,
  editingAppointmentId: null,
  draftParts: [],
  selectedJobRow: 0,
  selectedInventoryRow: 0
};

const els = {};

document.addEventListener("DOMContentLoaded", async () => {
  cacheElements();
  renderCategorySelects();
  bindEvents();

  try {
    state.db = await openDatabase();
    await refreshData();
    renderAll();
    showToast("המערכת נטענה בהצלחה");
  } catch (error) {
    console.error(error);
    showToast("שגיאה בטעינת מסד הנתונים המקומי");
  }

  setTimeout(() => { checkForUpdates().catch(() => {}); }, 3000);
});

const VEHICLE_DATASET_ID = "053cea08-09bc-40ec-8f7a-156f0677aff3";
const MODELS_DATASET_ID = "142afde2-6228-49f9-8a29-9b6c3a0cbe40";

async function ckanQuery(resourceId, filters) {
  const url = `https://data.gov.il/api/3/action/datastore_search?resource_id=${resourceId}&filters=${encodeURIComponent(JSON.stringify(filters))}&limit=1`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  return data?.result?.records?.[0] || null;
}

async function lookupVehicleByPlate(plate) {
  const digits = String(plate || "").replace(/\D/g, "");
  if (digits.length < 5) return null;

  const vehicle = await ckanQuery(VEHICLE_DATASET_ID, { mispar_rechev: digits });
  if (!vehicle) return null;

  const manufacturerVerbose = String(vehicle.tozeret_nm || "").trim();
  const commercial = String(vehicle.kinuy_mishari || "").trim();
  const year = vehicle.shnat_yitzur || null;
  const color = String(vehicle.tzeva_rechev || "").trim();
  const fuelType = String(vehicle.sug_delek_nm || "").trim();

  let cleanBrand = manufacturerVerbose;
  let engineDisplacement = null;
  let modelDetails = null;

  try {
    const modelFilters = { tozeret_cd: vehicle.tozeret_cd, degem_cd: vehicle.degem_cd };
    if (year) modelFilters.shnat_yitzur = year;
    modelDetails = await ckanQuery(MODELS_DATASET_ID, modelFilters);
  } catch (error) {
    console.warn("Model dataset query failed:", error);
  }

  if (modelDetails) {
    if (modelDetails.tozar) cleanBrand = String(modelDetails.tozar).trim();
    if (modelDetails.nefah_manoa) engineDisplacement = Number(modelDetails.nefah_manoa) || null;
  }

  const model = [cleanBrand, commercial].filter(Boolean).join(" ");

  return {
    model,
    year,
    engineDisplacement,
    color,
    fuelType
  };
}

async function autofillVehicleFields(plateInput, form, opts = {}) {
  const plate = plateInput.value;
  const digits = plate.replace(/\D/g, "");
  if (digits.length < 5) return;
  if (plateInput.dataset.lastLookup === digits) return;
  plateInput.dataset.lastLookup = digits;

  showToast("מחפש פרטי רכב...");
  try {
    const data = await lookupVehicleByPlate(plate);
    if (!data) {
      showToast("הרכב לא נמצא במאגר משרד התחבורה");
      return;
    }

    let filled = false;
    if (opts.fillModel && form.elements.vehicleModel && !form.elements.vehicleModel.value && data.model) {
      form.elements.vehicleModel.value = data.model;
      filled = true;
    }
    if (opts.fillYear && form.elements.vehicleYear && !form.elements.vehicleYear.value && data.year) {
      form.elements.vehicleYear.value = String(data.year);
      filled = true;
    }
    if (opts.fillEngine && form.elements.engineDisplacement && !form.elements.engineDisplacement.value && data.engineDisplacement) {
      form.elements.engineDisplacement.value = String(data.engineDisplacement);
      filled = true;
    }

    const summary = [data.model, data.year, data.engineDisplacement && `${data.engineDisplacement} סמ"ק`].filter(Boolean).join(" · ");
    if (filled) {
      showToast(`נמצא: ${summary}`);
    } else {
      showToast(`נמצא: ${summary} (שדות כבר מולאו)`);
    }
  } catch (error) {
    console.warn("Vehicle lookup failed:", error);
    showToast("שגיאה בחיפוש הרכב (בדוק חיבור לאינטרנט)");
  }
}

async function checkForUpdates() {
  if (!window.__TAURI__ || !window.__TAURI__.core) return;
  const { invoke } = window.__TAURI__.core;

  let update;
  try {
    update = await invoke("check_for_updates");
  } catch (error) {
    console.warn("Update check failed:", error);
    return;
  }
  if (!update || !update.available) return;

  const notes = (update.body || "").trim();
  const notesBlock = notes ? `\n\nמה חדש בגרסה זו:\n${notes}\n` : "";
  const proceed = confirm(`גרסה חדשה (${update.version}) זמינה.\nהגרסה הנוכחית: ${update.current_version}${notesBlock}\nלהוריד ולהתקין כעת? המערכת תאתחל בסיום.`);
  if (!proceed) return;

  showToast("מוריד עדכון, אנא המתינו...");
  try {
    await invoke("install_update");
  } catch (error) {
    console.error(error);
    showToast(`שגיאה בעדכון: ${error}`);
  }
}

function cacheElements() {
  els.screenTitle = document.querySelector("#screenTitle");
  els.screenSubtitle = document.querySelector("#screenSubtitle");
  els.navButtons = Array.from(document.querySelectorAll(".nav-button"));
  els.views = {
    jobs: document.querySelector("#jobsView"),
    inventory: document.querySelector("#inventoryView"),
    deliveries: document.querySelector("#deliveriesView"),
    appointments: document.querySelector("#appointmentsView"),
    backup: document.querySelector("#backupView")
  };

  els.rangeButtons = Array.from(document.querySelectorAll(".range-button"));
  els.revenueMetric = document.querySelector("#revenueMetric");
  els.costMetric = document.querySelector("#costMetric");
  els.profitMetric = document.querySelector("#profitMetric");

  els.jobSearch = document.querySelector("#jobSearch");
  els.jobsBody = document.querySelector("#jobsBody");
  els.jobsEmpty = document.querySelector("#jobsEmpty");
  els.addJobButton = document.querySelector("#addJobButton");

  els.inventorySearch = document.querySelector("#inventorySearch");
  els.inventoryBody = document.querySelector("#inventoryBody");
  els.inventoryEmpty = document.querySelector("#inventoryEmpty");
  els.addPartButton = document.querySelector("#addPartButton");
  els.inventoryCategoryTabs = document.querySelector("#inventoryCategoryTabs");
  els.inventoryTotalCost = document.querySelector("#inventoryTotalCost");
  els.inventoryTotalSell = document.querySelector("#inventoryTotalSell");
  els.inventoryTotalProfit = document.querySelector("#inventoryTotalProfit");
  els.inventoryTotalUnits = document.querySelector("#inventoryTotalUnits");

  els.deliverySearch = document.querySelector("#deliverySearch");
  els.deliveriesBody = document.querySelector("#deliveriesBody");
  els.deliveriesEmpty = document.querySelector("#deliveriesEmpty");
  els.deliveryRangeButtons = Array.from(document.querySelectorAll("[data-delivery-range]"));

  els.appointmentSearch = document.querySelector("#appointmentSearch");
  els.appointmentsBody = document.querySelector("#appointmentsBody");
  els.appointmentsEmpty = document.querySelector("#appointmentsEmpty");
  els.appointmentRangeButtons = Array.from(document.querySelectorAll("[data-appointment-range]"));
  els.addAppointmentButton = document.querySelector("#addAppointmentButton");
  els.appointmentModal = document.querySelector("#appointmentModal");
  els.appointmentForm = document.querySelector("#appointmentForm");
  els.appointmentModalTitle = document.querySelector("#appointmentModalTitle");
  els.appointmentError = document.querySelector("#appointmentError");

  els.jobModal = document.querySelector("#jobModal");
  els.jobForm = document.querySelector("#jobForm");
  els.jobModalTitle = document.querySelector("#jobModalTitle");
  els.jobError = document.querySelector("#jobError");
  els.partPickerSearch = document.querySelector("#partPickerSearch");
  els.partCategoryTabs = document.querySelector("#partCategoryTabs");
  els.partCardGrid = document.querySelector("#partCardGrid");
  els.partPickerEmpty = document.querySelector("#partPickerEmpty");
  els.partQuantity = document.querySelector("#partQuantity");
  els.toggleInlinePartButton = document.querySelector("#toggleInlinePartButton");
  els.inlinePartPanel = document.querySelector("#inlinePartPanel");
  els.cancelInlinePartButton = document.querySelector("#cancelInlinePartButton");
  els.saveInlinePartButton = document.querySelector("#saveInlinePartButton");
  els.inlinePartError = document.querySelector("#inlinePartError");
  els.inlinePartSku = document.querySelector("#inlinePartSku");
  els.inlinePartName = document.querySelector("#inlinePartName");
  els.inlinePartCategory = document.querySelector("#inlinePartCategory");
  els.inlinePartQuantity = document.querySelector("#inlinePartQuantity");
  els.inlinePartGarageCost = document.querySelector("#inlinePartGarageCost");
  els.inlinePartCustomerPrice = document.querySelector("#inlinePartCustomerPrice");
  els.selectedParts = document.querySelector("#selectedParts");
  els.draftPartsCost = document.querySelector("#draftPartsCost");
  els.draftPartsPrice = document.querySelector("#draftPartsPrice");
  els.draftSubtotal = document.querySelector("#draftSubtotal");
  els.draftTaxLine = document.querySelector("#draftTaxLine");
  els.draftTaxRateLabel = document.querySelector("#draftTaxRateLabel");
  els.draftTaxAmount = document.querySelector("#draftTaxAmount");
  els.draftTotal = document.querySelector("#draftTotal");
  els.draftProfit = document.querySelector("#draftProfit");
  els.taxEnabled = document.querySelector("#taxEnabled");
  els.taxRate = document.querySelector("#taxRate");

  els.partModal = document.querySelector("#partModal");
  els.partForm = document.querySelector("#partForm");
  els.partModalTitle = document.querySelector("#partModalTitle");
  els.partError = document.querySelector("#partError");
  els.partCategorySelect = document.querySelector("#partCategorySelect");

  els.exportJsonButton = document.querySelector("#exportJsonButton");
  els.exportJobsCsvButton = document.querySelector("#exportJobsCsvButton");
  els.exportInventoryCsvButton = document.querySelector("#exportInventoryCsvButton");
  els.importJsonInput = document.querySelector("#importJsonInput");
  els.toast = document.querySelector("#toast");
}

function bindEvents() {
  els.navButtons.forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });

  els.rangeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.activeRange = button.dataset.range;
      els.rangeButtons.forEach((item) => item.classList.toggle("active", item === button));
      renderAnalytics();
    });
  });

  els.jobSearch.addEventListener("input", renderJobs);
  els.inventorySearch.addEventListener("input", renderInventory);
  els.deliverySearch.addEventListener("input", renderDeliveries);
  els.deliveryRangeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.activeDeliveryRange = button.dataset.deliveryRange;
      els.deliveryRangeButtons.forEach((item) => item.classList.toggle("active", item === button));
      renderDeliveries();
    });
  });

  els.appointmentSearch.addEventListener("input", renderAppointments);
  els.appointmentRangeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.activeAppointmentRange = button.dataset.appointmentRange;
      els.appointmentRangeButtons.forEach((item) => item.classList.toggle("active", item === button));
      renderAppointments();
    });
  });
  els.addAppointmentButton.addEventListener("click", () => openAppointmentModal());
  els.appointmentForm.addEventListener("submit", saveAppointmentFromForm);

  els.jobForm.elements.vehiclePlate.addEventListener("blur", (event) => {
    autofillVehicleFields(event.target, els.jobForm, { fillModel: true, fillYear: true, fillEngine: true });
  });
  els.appointmentForm.elements.vehiclePlate.addEventListener("blur", (event) => {
    autofillVehicleFields(event.target, els.appointmentForm, { fillModel: true });
  });
  els.partPickerSearch.addEventListener("input", renderPartPicker);
  els.addJobButton.addEventListener("click", () => openJobModal());
  els.addPartButton.addEventListener("click", () => openPartModal());
  els.toggleInlinePartButton.addEventListener("click", showInlinePartPanel);
  els.cancelInlinePartButton.addEventListener("click", hideInlinePartPanel);
  els.saveInlinePartButton.addEventListener("click", saveInlinePart);
  els.jobForm.addEventListener("submit", saveJobFromForm);
  els.partForm.addEventListener("submit", savePartFromForm);
  els.inlinePartCategory.addEventListener("change", handleCategorySelectChange);
  els.partCategorySelect.addEventListener("change", handleCategorySelectChange);

  document.querySelectorAll("[data-close-modal]").forEach((button) => {
    button.addEventListener("click", () => closeModal(button.dataset.closeModal));
  });

  els.exportJsonButton.addEventListener("click", exportJson);
  els.exportJobsCsvButton.addEventListener("click", exportJobsCsv);
  els.exportInventoryCsvButton.addEventListener("click", exportInventoryCsv);
  els.importJsonInput.addEventListener("change", importJson);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeAllModals();
    }

    if (event.ctrlKey && event.key.toLowerCase() === "n") {
      event.preventDefault();
      if (state.activeView === "jobs") openJobModal();
      if (state.activeView === "inventory") openPartModal();
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      handleTableArrowNavigation(event);
    }
  });
}

function getAllPartCategories() {
  return [...PART_CATEGORIES, ...state.customCategories];
}

function renderCategorySelects() {
  const selectableCategories = getAllPartCategories().filter((category) => category.id !== "all");
  const options = selectableCategories
    .map((category) => `<option value="${escapeHtml(category.id)}">${escapeHtml(category.label)}</option>`)
    .join("");
  const addOption = `<option value="${NEW_CATEGORY_OPTION}">+ קטגוריה חדשה</option>`;
  const html = options + addOption;

  [els.inlinePartCategory, els.partCategorySelect].forEach((select) => {
    const previousValue = select.value;
    select.innerHTML = html;
    if (previousValue && Array.from(select.options).some((opt) => opt.value === previousValue)) {
      select.value = previousValue;
    }
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains("jobs")) {
        const jobs = db.createObjectStore("jobs", { keyPath: "id", autoIncrement: true });
        jobs.createIndex("jobDate", "jobDate", { unique: false });
        jobs.createIndex("vehiclePlate", "vehiclePlate", { unique: false });
      }

      if (!db.objectStoreNames.contains("inventory")) {
        const inventory = db.createObjectStore("inventory", { keyPath: "id", autoIncrement: true });
        inventory.createIndex("sku", "sku", { unique: true });
        inventory.createIndex("name", "name", { unique: false });
      }

      if (!db.objectStoreNames.contains("categories")) {
        db.createObjectStore("categories", { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains("appointments")) {
        const appointments = db.createObjectStore("appointments", { keyPath: "id", autoIncrement: true });
        appointments.createIndex("appointmentDate", "appointmentDate", { unique: false });
        appointments.createIndex("phoneNumber", "phoneNumber", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("הפעולה בוטלה"));
  });
}

async function getAll(storeName) {
  const transaction = state.db.transaction(storeName, "readonly");
  const store = transaction.objectStore(storeName);
  return idbRequest(store.getAll());
}

async function refreshData() {
  const [jobs, inventory, categories, appointments] = await Promise.all([
    getAll("jobs"),
    getAll("inventory"),
    getAll("categories"),
    getAll("appointments")
  ]);
  state.jobs = jobs.sort((a, b) => `${b.jobDate}${b.id}`.localeCompare(`${a.jobDate}${a.id}`));
  state.inventory = inventory.sort((a, b) => a.name.localeCompare(b.name, "he"));
  state.customCategories = categories.sort((a, b) => a.label.localeCompare(b.label, "he"));
  state.appointments = appointments.sort((a, b) => {
    const aKey = `${a.appointmentDate || ""}${a.appointmentTime || ""}`;
    const bKey = `${b.appointmentDate || ""}${b.appointmentTime || ""}`;
    return aKey.localeCompare(bKey);
  });
}

function renderAll() {
  renderCategorySelects();
  renderPartPicker();
  renderJobs();
  renderInventory();
  renderDeliveries();
  renderAppointments();
  renderAnalytics();
}

async function createCategory(rawLabel) {
  const label = (rawLabel || "").trim();
  if (!label) return null;

  const duplicate = getAllPartCategories().find((category) => category.label.toLowerCase() === label.toLowerCase());
  if (duplicate) {
    showToast("קטגוריה בשם זה כבר קיימת");
    return duplicate;
  }

  const id = `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const category = { id, label, custom: true, createdAt: new Date().toISOString() };

  try {
    const transaction = state.db.transaction("categories", "readwrite");
    transaction.objectStore("categories").add(category);
    await transactionDone(transaction);

    await refreshData();
    renderCategorySelects();
    showToast(`נוספה קטגוריה: ${label}`);
    return category;
  } catch (error) {
    console.error(error);
    showToast("שגיאה בשמירת הקטגוריה");
    return null;
  }
}

async function promptAddCategory() {
  const rawLabel = window.prompt("שם הקטגוריה החדשה?");
  return createCategory(rawLabel);
}

async function handleCategorySelectChange(event) {
  const select = event.target;
  if (select.value === NEW_CATEGORY_OPTION) {
    const previousValue = select.dataset.lastValue || "general";
    const created = await promptAddCategory();
    if (created) {
      select.value = created.id;
    } else {
      select.value = previousValue;
    }
  }
  select.dataset.lastValue = select.value;
}

function switchView(view) {
  state.activeView = view;
  els.navButtons.forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  Object.entries(els.views).forEach(([key, element]) => element.classList.toggle("active", key === view));

  const titles = {
    jobs: ["יומן עבודה", "מעקב תיקונים יומי, חלקים, חיובים ורווחיות"],
    inventory: ["ניהול מלאי חלקים", "קטלוג חלקים מקומי עם כמויות ומחירים"],
    deliveries: ["מסירות צפויות", "עבודות לפי תאריך מסירה עם סטטוס ואיחורים"],
    appointments: ["תורים ופגישות", "תיאום הגעות עם פרטי לקוח, רכב וסיבת ההגעה"],
    backup: ["גיבוי וייצוא", "שמירת נתונים מקומית לקבצי גיבוי ו-CSV"]
  };

  els.screenTitle.textContent = titles[view][0];
  els.screenSubtitle.textContent = titles[view][1];
}

function renderJobs() {
  const query = normalizeSearch(els.jobSearch.value);
  const rows = state.jobs.filter((job) => {
    const haystack = normalizeSearch([
      job.vehiclePlate,
      job.vehicleModel,
      job.ownerName,
      job.parts?.map((part) => part.nameSnapshot).join(" ")
    ].join(" "));
    return haystack.includes(query);
  });

  els.jobsBody.innerHTML = "";
  rows.forEach((job, index) => {
    const totals = getJobTotals(job);
    const row = document.createElement("tr");
    row.tabIndex = 0;
    row.dataset.rowIndex = String(index);
    row.classList.toggle("selected", index === state.selectedJobRow);

    row.innerHTML = `
      <td>${formatDate(job.jobDate)}</td>
      <td>${getHebrewDay(job.jobDate)}</td>
      <td>${escapeHtml(job.vehiclePlate)}</td>
      <td>${escapeHtml(job.vehicleModel || "")}</td>
      <td>${job.vehicleYear || ""}</td>
      <td>${job.engineDisplacement || ""}</td>
      <td>${escapeHtml(job.ownerName || "")}</td>
      <td class="parts-cell" title="${escapeHtml(getPartsText(job))}">${escapeHtml(getPartsText(job))}</td>
      <td class="numeric">${formatCurrency(totals.partsCost)}</td>
      <td class="numeric">${formatCurrency(totals.partsPrice)}</td>
      <td class="numeric">${formatCurrency(job.laborPrice || 0)}</td>
      <td>${renderTaxCell(totals)}</td>
      <td class="numeric">${formatCurrency(totals.total)}</td>
      <td class="numeric">${formatCurrency(totals.profit)}</td>
      <td>${formatDate(job.deliveryDate)}</td>
      <td>
        <span class="row-actions">
          <button class="row-action" type="button" data-job-edit="${job.id}">עריכה</button>
          <button class="row-action danger-action" type="button" data-job-delete="${job.id}">מחיקה</button>
        </span>
      </td>
    `;

    row.addEventListener("focus", () => {
      state.selectedJobRow = index;
      paintSelectedRows(els.jobsBody, state.selectedJobRow);
    });

    els.jobsBody.appendChild(row);
  });

  els.jobsBody.querySelectorAll("[data-job-edit]").forEach((button) => {
    button.addEventListener("click", () => openJobModal(Number(button.dataset.jobEdit)));
  });
  els.jobsBody.querySelectorAll("[data-job-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteJob(Number(button.dataset.jobDelete)));
  });

  els.jobsEmpty.classList.toggle("hidden", rows.length > 0);
}

function renderInventory() {
  renderInventoryCategoryTabs();

  const query = normalizeSearch(els.inventorySearch.value);
  const activeCategory = state.activeInventoryCategory || "all";
  const rows = state.inventory.filter((part) => {
    if (activeCategory !== "all" && getPartCategoryId(part) !== activeCategory) return false;
    const haystack = normalizeSearch(`${part.sku} ${part.name} ${getPartCategoryLabel(part)}`);
    return haystack.includes(query);
  });

  renderInventoryTotals(rows);

  els.inventoryBody.innerHTML = "";
  rows.forEach((part, index) => {
    const row = document.createElement("tr");
    row.tabIndex = 0;
    row.dataset.rowIndex = String(index);
    row.classList.toggle("selected", index === state.selectedInventoryRow);

    row.innerHTML = `
      <td>${escapeHtml(part.sku)}</td>
      <td>${escapeHtml(part.name)}</td>
      <td>${escapeHtml(getPartCategoryLabel(part))}</td>
      <td>
        <span class="quantity-tools">
          <button type="button" aria-label="הפחתת כמות" data-quantity-down="${part.id}">−</button>
          <span class="${part.quantity <= 2 ? "low-stock" : ""}">${part.quantity}</span>
          <button type="button" aria-label="הוספת כמות" data-quantity-up="${part.id}">+</button>
        </span>
      </td>
      <td class="numeric">${formatCurrency(part.garageCost)}</td>
      <td class="numeric">${formatCurrency(part.customerPrice)}</td>
      <td>
        <span class="row-actions">
          <button class="row-action" type="button" data-part-edit="${part.id}">עריכה</button>
          <button class="row-action danger-action" type="button" data-part-delete="${part.id}">מחיקה</button>
        </span>
      </td>
    `;

    row.addEventListener("focus", () => {
      state.selectedInventoryRow = index;
      paintSelectedRows(els.inventoryBody, state.selectedInventoryRow);
    });

    els.inventoryBody.appendChild(row);
  });

  els.inventoryBody.querySelectorAll("[data-part-edit]").forEach((button) => {
    button.addEventListener("click", () => openPartModal(Number(button.dataset.partEdit)));
  });
  els.inventoryBody.querySelectorAll("[data-part-delete]").forEach((button) => {
    button.addEventListener("click", () => deletePart(Number(button.dataset.partDelete)));
  });
  els.inventoryBody.querySelectorAll("[data-quantity-up]").forEach((button) => {
    button.addEventListener("click", () => adjustPartQuantity(Number(button.dataset.quantityUp), 1));
  });
  els.inventoryBody.querySelectorAll("[data-quantity-down]").forEach((button) => {
    button.addEventListener("click", () => adjustPartQuantity(Number(button.dataset.quantityDown), -1));
  });

  els.inventoryEmpty.classList.toggle("hidden", rows.length > 0);
}

function renderDeliveries() {
  const query = normalizeSearch(els.deliverySearch.value);
  const rangeFilter = state.activeDeliveryRange || "upcoming";

  const candidates = state.jobs.filter((job) => {
    if (!job.deliveryDate) return false;
    const haystack = normalizeSearch([
      job.vehiclePlate,
      job.vehicleModel,
      job.ownerName,
      job.parts?.map((part) => part.nameSnapshot).join(" ")
    ].join(" "));
    return haystack.includes(query);
  });

  const enriched = candidates.map((job) => ({ job, days: getDaysUntil(job.deliveryDate) }));
  const filtered = enriched.filter(({ days }) => isDeliveryInRange(days, rangeFilter));
  filtered.sort((a, b) => a.job.deliveryDate.localeCompare(b.job.deliveryDate));

  els.deliveriesBody.innerHTML = "";
  filtered.forEach(({ job, days }) => {
    const totals = getJobTotals(job);
    const statusClass = getDeliveryStatusClass(days);
    const statusLabel = getDeliveryStatusLabel(days);
    const row = document.createElement("tr");
    row.classList.add(`delivery-${statusClass}`);

    row.innerHTML = `
      <td><span class="delivery-badge ${statusClass}">${statusLabel}</span></td>
      <td>${formatDate(job.deliveryDate)}</td>
      <td>${formatDaysUntil(days)}</td>
      <td>${escapeHtml(job.vehiclePlate)}</td>
      <td>${escapeHtml(job.vehicleModel || "")}</td>
      <td>${escapeHtml(job.ownerName || "")}</td>
      <td class="parts-cell" title="${escapeHtml(getPartsText(job))}">${escapeHtml(getPartsText(job))}</td>
      <td class="numeric">${formatCurrency(totals.total)}</td>
      <td>
        <span class="row-actions">
          <button class="row-action" type="button" data-delivery-edit="${job.id}">פתיחת עבודה</button>
        </span>
      </td>
    `;

    els.deliveriesBody.appendChild(row);
  });

  els.deliveriesBody.querySelectorAll("[data-delivery-edit]").forEach((button) => {
    button.addEventListener("click", () => openJobModal(Number(button.dataset.deliveryEdit)));
  });

  els.deliveriesEmpty.classList.toggle("hidden", filtered.length > 0);
}

function getDaysUntil(dateValue) {
  if (!dateValue) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(`${dateValue}T12:00:00`);
  target.setHours(0, 0, 0, 0);
  const diffMs = target - today;
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

function formatDaysUntil(days) {
  if (days === null) return "";
  if (days < 0) return `באיחור ${Math.abs(days)} ימים`;
  if (days === 0) return "היום";
  if (days === 1) return "מחר";
  return `בעוד ${days} ימים`;
}

function getDeliveryStatusClass(days) {
  if (days === null) return "later";
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days <= 3) return "soon";
  if (days <= 7) return "week";
  return "later";
}

function getDeliveryStatusLabel(days) {
  if (days === null) return "ללא תאריך";
  if (days < 0) return "באיחור";
  if (days === 0) return "היום";
  if (days === 1) return "מחר";
  if (days <= 7) return "השבוע";
  return "בהמשך";
}

function isDeliveryInRange(days, range) {
  if (days === null) return range === "all";
  switch (range) {
    case "upcoming":
      return days >= 0;
    case "week":
      return days >= 0 && days <= 7;
    case "month":
      return days >= 0 && days <= 31;
    case "overdue":
      return days < 0;
    case "all":
      return true;
    default:
      return days >= 0;
  }
}

function renderAppointments() {
  const query = normalizeSearch(els.appointmentSearch.value);
  const range = state.activeAppointmentRange || "upcoming";

  const filtered = state.appointments.filter((appointment) => {
    if (!isAppointmentInRange(appointment, range)) return false;
    const haystack = normalizeSearch([
      appointment.customerName,
      appointment.phoneNumber,
      appointment.vehiclePlate,
      appointment.vehicleModel,
      appointment.reason,
      appointment.notes
    ].join(" "));
    return haystack.includes(query);
  });

  els.appointmentsBody.innerHTML = "";
  filtered.forEach((appointment) => {
    const days = getDaysUntil(appointment.appointmentDate);
    const statusClass = getAppointmentStatusClass(days);
    const statusLabel = getAppointmentStatusLabel(days);
    const row = document.createElement("tr");
    row.classList.add(`appointment-${statusClass}`);

    const phoneHtml = appointment.phoneNumber
      ? `<a href="tel:${escapeHtml(appointment.phoneNumber)}" class="phone-link">${escapeHtml(appointment.phoneNumber)}</a>`
      : "";

    row.innerHTML = `
      <td><span class="delivery-badge ${statusClass}">${statusLabel}</span></td>
      <td>${formatDate(appointment.appointmentDate)}</td>
      <td>${escapeHtml(appointment.appointmentTime || "")}</td>
      <td>${escapeHtml(appointment.customerName)}</td>
      <td>${phoneHtml}</td>
      <td>${escapeHtml(appointment.vehiclePlate || "")}</td>
      <td>${escapeHtml(appointment.vehicleModel || "")}</td>
      <td>${escapeHtml(appointment.reason || "")}</td>
      <td class="notes-cell" title="${escapeHtml(appointment.notes || "")}">${escapeHtml(appointment.notes || "")}</td>
      <td>
        <span class="row-actions">
          <button class="row-action" type="button" data-appointment-edit="${appointment.id}">עריכה</button>
          <button class="row-action danger-action" type="button" data-appointment-delete="${appointment.id}">מחיקה</button>
        </span>
      </td>
    `;

    els.appointmentsBody.appendChild(row);
  });

  els.appointmentsBody.querySelectorAll("[data-appointment-edit]").forEach((button) => {
    button.addEventListener("click", () => openAppointmentModal(Number(button.dataset.appointmentEdit)));
  });
  els.appointmentsBody.querySelectorAll("[data-appointment-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteAppointment(Number(button.dataset.appointmentDelete)));
  });

  els.appointmentsEmpty.classList.toggle("hidden", filtered.length > 0);
}

function isAppointmentInRange(appointment, range) {
  const days = getDaysUntil(appointment.appointmentDate);
  if (days === null) return range === "all";
  switch (range) {
    case "upcoming":
      return days >= 0;
    case "today":
      return days === 0;
    case "tomorrow":
      return days === 1;
    case "week":
      return days >= 0 && days <= 7;
    case "all":
      return true;
    default:
      return days >= 0;
  }
}

function getAppointmentStatusClass(days) {
  if (days === null) return "later";
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days === 1) return "soon";
  if (days <= 7) return "week";
  return "later";
}

function getAppointmentStatusLabel(days) {
  if (days === null) return "ללא תאריך";
  if (days < 0) return "עבר";
  if (days === 0) return "היום";
  if (days === 1) return "מחר";
  if (days <= 7) return "השבוע";
  return "בהמשך";
}

function openAppointmentModal(appointmentId = null) {
  state.editingAppointmentId = appointmentId;
  clearError(els.appointmentError);
  els.appointmentForm.reset();

  if (appointmentId) {
    const appointment = state.appointments.find((item) => item.id === appointmentId);
    if (!appointment) return;

    els.appointmentModalTitle.textContent = "עריכת תור";
    els.appointmentForm.elements.appointmentDate.value = appointment.appointmentDate || "";
    els.appointmentForm.elements.appointmentTime.value = appointment.appointmentTime || "";
    els.appointmentForm.elements.customerName.value = appointment.customerName || "";
    els.appointmentForm.elements.phoneNumber.value = appointment.phoneNumber || "";
    els.appointmentForm.elements.vehiclePlate.value = appointment.vehiclePlate || "";
    els.appointmentForm.elements.vehicleModel.value = appointment.vehicleModel || "";
    els.appointmentForm.elements.reason.value = appointment.reason || "";
    els.appointmentForm.elements.notes.value = appointment.notes || "";
  } else {
    els.appointmentModalTitle.textContent = "הוספת תור";
    els.appointmentForm.elements.appointmentDate.value = toIsoDate(new Date());
  }

  delete els.appointmentForm.elements.vehiclePlate.dataset.lastLookup;
  openModal("appointmentModal");
  requestAnimationFrame(() => els.appointmentForm.elements.customerName.focus());
}

async function saveAppointmentFromForm(event) {
  event.preventDefault();
  clearError(els.appointmentError);

  const form = new FormData(els.appointmentForm);
  const appointment = {
    appointmentDate: String(form.get("appointmentDate") || "").trim(),
    appointmentTime: String(form.get("appointmentTime") || "").trim(),
    customerName: String(form.get("customerName") || "").trim(),
    phoneNumber: String(form.get("phoneNumber") || "").trim(),
    vehiclePlate: String(form.get("vehiclePlate") || "").trim(),
    vehicleModel: String(form.get("vehicleModel") || "").trim(),
    reason: String(form.get("reason") || "").trim(),
    notes: String(form.get("notes") || "").trim(),
    updatedAt: new Date().toISOString()
  };

  if (!appointment.appointmentDate) {
    showError(els.appointmentError, "תאריך הוא שדה חובה");
    return;
  }
  if (!appointment.customerName) {
    showError(els.appointmentError, "שם הלקוח הוא שדה חובה");
    return;
  }
  if (!appointment.phoneNumber) {
    showError(els.appointmentError, "מספר טלפון הוא שדה חובה");
    return;
  }

  try {
    await saveAppointment(appointment, state.editingAppointmentId);
    await refreshData();
    renderAppointments();
    closeModal("appointmentModal");
    showToast(state.editingAppointmentId ? "התור עודכן" : "תור נוסף ליומן");
  } catch (error) {
    console.error(error);
    showError(els.appointmentError, error.message || "שגיאה בשמירת התור");
  }
}

async function saveAppointment(appointment, appointmentId = null) {
  const transaction = state.db.transaction("appointments", "readwrite");
  const store = transaction.objectStore("appointments");
  const now = new Date().toISOString();

  if (appointmentId) {
    const existing = await idbRequest(store.get(appointmentId));
    if (!existing) throw new Error("התור לא נמצא");
    store.put({ ...existing, ...appointment, id: appointmentId, updatedAt: now });
  } else {
    store.add({ ...appointment, createdAt: now, updatedAt: now });
  }

  await transactionDone(transaction);
}

async function deleteAppointment(appointmentId) {
  const appointment = state.appointments.find((item) => item.id === appointmentId);
  if (!appointment) return;
  if (!confirm(`למחוק את התור של ${appointment.customerName}?`)) return;

  const transaction = state.db.transaction("appointments", "readwrite");
  transaction.objectStore("appointments").delete(appointmentId);
  await transactionDone(transaction);

  await refreshData();
  renderAppointments();
  showToast("התור נמחק");
}

function renderAnalytics() {
  const { start, end } = getDateRange(state.activeRange);
  const totals = state.jobs.reduce(
    (sum, job) => {
      if (!isDateInRange(job.jobDate, start, end)) return sum;
      const jobTotals = getJobTotals(job);
      sum.revenue += jobTotals.subtotal;
      sum.cost += jobTotals.partsCost;
      sum.profit += jobTotals.profit;
      return sum;
    },
    { revenue: 0, cost: 0, profit: 0 }
  );

  els.revenueMetric.textContent = formatCurrency(totals.revenue);
  els.costMetric.textContent = formatCurrency(totals.cost);
  els.profitMetric.textContent = formatCurrency(totals.profit);
}

function renderPartPicker() {
  renderPartCategoryTabs();

  const visibleParts = getFilteredPickerParts();
  if (state.selectedPartId && !visibleParts.some((part) => part.id === state.selectedPartId)) {
    state.selectedPartId = null;
  }

  els.partCardGrid.innerHTML = "";
  visibleParts.forEach((part) => {
    const isSelected = part.id === state.selectedPartId;
    const remainingQuantity = getRemainingQuantityForPicker(part.id);
    const isOutOfStock = remainingQuantity <= 0;
    const hasNoPrice = Number(part.customerPrice || 0) <= 0;
    const isDisabled = isOutOfStock;
    const card = document.createElement("div");
    card.className = "part-card";
    if (isSelected) card.classList.add("is-selected");
    if (isDisabled) card.classList.add("is-disabled");
    card.dataset.partCard = String(part.id);
    card.setAttribute("role", "option");
    card.setAttribute("aria-selected", String(isSelected));
    card.setAttribute("aria-disabled", String(isDisabled));
    card.tabIndex = isDisabled ? -1 : 0;
    card.innerHTML = `
      <span class="part-card-topline">
        <strong>${escapeHtml(part.name)}</strong>
        <span>${escapeHtml(getPartCategoryLabel(part))}</span>
      </span>
      <span class="part-card-meta">מק"ט ${escapeHtml(part.sku)}</span>
      <span class="part-card-values">
        <span class="${isOutOfStock ? "stock-danger" : ""}">מלאי: ${remainingQuantity}</span>
        <span>${formatCurrency(part.customerPrice)}</span>
      </span>
      ${hasNoPrice ? '<span class="part-card-warning">חסר מחיר ללקוח</span>' : ""}
      ${isSelected && !isDisabled ? '<button type="button" class="part-card-add">+ הוספה לעבודה</button>' : ""}
    `;

    card.addEventListener("click", (event) => {
      if (isDisabled) return;
      if (event.target.closest(".part-card-add")) return;
      state.selectedPartId = part.id;
      clearError(els.jobError);
      renderPartPicker();
    });

    card.addEventListener("keydown", (event) => {
      if (isDisabled) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (isSelected) {
          addPartToDraft(part.id, toPositiveInt(els.partQuantity.value) || 1);
        } else {
          state.selectedPartId = part.id;
          clearError(els.jobError);
          renderPartPicker();
        }
      }
    });

    const addBtn = card.querySelector(".part-card-add");
    if (addBtn) {
      addBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        addPartToDraft(part.id, toPositiveInt(els.partQuantity.value) || 1);
      });
    }

    els.partCardGrid.appendChild(card);
  });

  els.partPickerEmpty.classList.toggle("hidden", visibleParts.length > 0);
}

function renderPartCategoryTabs() {
  els.partCategoryTabs.innerHTML = "";
  getAllPartCategories().forEach((category) => {
    const count = category.id === "all"
      ? state.inventory.length
      : state.inventory.filter((part) => getPartCategoryId(part) === category.id).length;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "part-category-button";
    button.dataset.partCategory = category.id;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(state.activePartCategory === category.id));
    button.innerHTML = `${escapeHtml(category.label)} <span>${count}</span>`;
    button.addEventListener("click", () => {
      state.activePartCategory = category.id;
      state.selectedPartId = null;
      clearError(els.jobError);
      renderPartPicker();
    });
    els.partCategoryTabs.appendChild(button);
  });

  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "part-category-button add-category";
  addButton.title = "הוספת קטגוריה חדשה";
  addButton.textContent = "+ קטגוריה";
  addButton.addEventListener("click", () => beginInlineCategoryAdd(addButton));
  els.partCategoryTabs.appendChild(addButton);
}

function beginInlineCategoryAdd(triggerButton) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "part-category-button add-category-input";
  input.placeholder = "שם קטגוריה...";
  input.setAttribute("aria-label", "שם קטגוריה חדשה");
  input.maxLength = 32;

  let resolved = false;
  const finish = async (commit) => {
    if (resolved) return;
    resolved = true;
    const label = input.value;
    input.replaceWith(triggerButton);
    if (!commit) return;
    const created = await createCategory(label);
    if (created) {
      state.activePartCategory = created.id;
      renderPartPicker();
    }
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));

  triggerButton.replaceWith(input);
  input.focus();
}

function renderInventoryTotals(parts) {
  const totalCost = parts.reduce((sum, p) => sum + Number(p.garageCost || 0) * Number(p.quantity || 0), 0);
  const totalSell = parts.reduce((sum, p) => sum + Number(p.customerPrice || 0) * Number(p.quantity || 0), 0);
  const totalUnits = parts.reduce((sum, p) => sum + Number(p.quantity || 0), 0);
  els.inventoryTotalCost.textContent = formatCurrency(totalCost);
  els.inventoryTotalSell.textContent = formatCurrency(totalSell);
  els.inventoryTotalProfit.textContent = formatCurrency(totalSell - totalCost);
  els.inventoryTotalUnits.textContent = String(totalUnits);
}

function renderInventoryCategoryTabs() {
  if (!els.inventoryCategoryTabs) return;
  els.inventoryCategoryTabs.innerHTML = "";
  getAllPartCategories().forEach((category) => {
    const count = category.id === "all"
      ? state.inventory.length
      : state.inventory.filter((part) => getPartCategoryId(part) === category.id).length;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "part-category-button";
    button.dataset.inventoryCategory = category.id;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String((state.activeInventoryCategory || "all") === category.id));
    button.innerHTML = `${escapeHtml(category.label)} <span>${count}</span>`;
    button.addEventListener("click", () => {
      state.activeInventoryCategory = category.id;
      renderInventory();
    });
    els.inventoryCategoryTabs.appendChild(button);
  });
}

function getFilteredPickerParts() {
  const query = normalizeSearch(els.partPickerSearch.value);
  return state.inventory
    .filter((part) => state.activePartCategory === "all" || getPartCategoryId(part) === state.activePartCategory)
    .filter((part) => {
      const haystack = normalizeSearch(`${part.sku} ${part.name} ${getPartCategoryLabel(part)}`);
      return haystack.includes(query);
    })
    .sort((a, b) => {
      const stockDiff = Number(b.quantity || 0) - Number(a.quantity || 0);
      if ((Number(a.quantity || 0) > 0) !== (Number(b.quantity || 0) > 0)) return stockDiff;
      return a.name.localeCompare(b.name, "he");
    });
}

function openJobModal(jobId = null) {
  state.editingJobId = jobId;
  state.selectedPartId = null;
  state.activePartCategory = "all";
  clearError(els.jobError);
  els.jobForm.reset();
  els.partPickerSearch.value = "";
  state.draftParts = [];
  hideInlinePartPanel();

  const today = toIsoDate(new Date());
  els.jobForm.elements.jobDate.value = today;
  els.jobForm.elements.laborPrice.value = "0";
  els.taxEnabled.checked = true;
  els.taxRate.value = "18";

  if (jobId) {
    const job = state.jobs.find((item) => item.id === jobId);
    if (!job) return;

    els.jobModalTitle.textContent = "עריכת עבודה";
    els.jobForm.elements.jobDate.value = job.jobDate || today;
    els.jobForm.elements.vehiclePlate.value = job.vehiclePlate || "";
    els.jobForm.elements.vehicleModel.value = job.vehicleModel || "";
    els.jobForm.elements.vehicleYear.value = job.vehicleYear || "";
    els.jobForm.elements.engineDisplacement.value = job.engineDisplacement || "";
    els.jobForm.elements.ownerName.value = job.ownerName || "";
    els.jobForm.elements.laborPrice.value = String(job.laborPrice || 0);
    els.jobForm.elements.deliveryDate.value = job.deliveryDate || "";
    els.taxEnabled.checked = Boolean(job.taxEnabled);
    els.taxRate.value = String(job.taxRate ?? 18);
    state.draftParts = structuredClone(job.parts || []);
  } else {
    els.jobModalTitle.textContent = "הוספת עבודה";
  }

  renderDraftParts();
  renderPartPicker();
  delete els.jobForm.elements.vehiclePlate.dataset.lastLookup;
  openModal("jobModal");
  requestAnimationFrame(() => els.jobForm.elements.vehiclePlate.focus());
}

function openPartModal(partId = null) {
  state.editingPartId = partId;
  clearError(els.partError);
  els.partForm.reset();

  if (partId) {
    const part = state.inventory.find((item) => item.id === partId);
    if (!part) return;

    els.partModalTitle.textContent = "עריכת חלק";
    els.partForm.elements.sku.value = part.sku;
    els.partForm.elements.name.value = part.name;
    els.partForm.elements.category.value = getPartCategoryId(part);
    els.partForm.elements.quantity.value = String(part.quantity);
    els.partForm.elements.garageCost.value = String(part.garageCost);
    els.partForm.elements.customerPrice.value = String(part.customerPrice);
  } else {
    els.partModalTitle.textContent = "הוספת חלק";
    els.partForm.elements.category.value = "general";
    els.partForm.elements.quantity.value = "0";
    els.partForm.elements.garageCost.value = "0";
    els.partForm.elements.customerPrice.value = "0";
  }

  els.partCategorySelect.dataset.lastValue = els.partCategorySelect.value;

  openModal("partModal");
  requestAnimationFrame(() => els.partForm.elements.sku.focus());
}

function addPartToDraft(explicitPartId, explicitQuantity) {
  clearError(els.jobError);

  const partId = Number(explicitPartId ?? state.selectedPartId);
  const quantity = explicitQuantity ?? toPositiveInt(els.partQuantity.value);
  const part = state.inventory.find((item) => item.id === partId);

  if (!part) {
    showError(els.jobError, "יש לבחור חלק מהמלאי");
    return;
  }

  if (!quantity) {
    showError(els.jobError, "יש להזין כמות תקינה");
    return;
  }

  if (Number(part.customerPrice || 0) <= 0) {
    showError(els.jobError, "יש לעדכן מחיר חלק ללקוח לפני הוספת החלק לעבודה");
    return;
  }

  const existing = state.draftParts.find((item) => item.partId === part.id);
  const nextQuantity = (existing?.quantityUsed || 0) + quantity;
  const availableQuantity = getAvailableQuantityForDraft(part.id);
  if (nextQuantity > availableQuantity) {
    showError(els.jobError, `אין מספיק מלאי עבור ${part.name}. זמין: ${availableQuantity}`);
    return;
  }

  if (existing) {
    existing.quantityUsed = nextQuantity;
    existing.garageCostSnapshot = Number(part.garageCost) || 0;
    existing.customerPriceSnapshot = Number(part.customerPrice) || 0;
  } else {
    state.draftParts.push({
      partId: part.id,
      skuSnapshot: part.sku,
      nameSnapshot: part.name,
      quantityUsed: quantity,
      garageCostSnapshot: Number(part.garageCost) || 0,
      customerPriceSnapshot: Number(part.customerPrice) || 0
    });
  }

  els.partQuantity.value = "1";
  state.selectedPartId = null;
  renderDraftParts();
  renderPartPicker();
}

function getAvailableQuantityForDraft(partId) {
  const part = state.inventory.find((item) => item.id === partId);
  if (!part) return 0;

  let available = Number(part.quantity || 0);
  if (state.editingJobId) {
    const existingJob = state.jobs.find((job) => job.id === state.editingJobId);
    const alreadyUsedByThisJob = (existingJob?.parts || [])
      .filter((jobPart) => jobPart.partId === partId)
      .reduce((sum, jobPart) => sum + Number(jobPart.quantityUsed || 0), 0);
    available += alreadyUsedByThisJob;
  }

  return available;
}

function getRemainingQuantityForPicker(partId) {
  const totalAvailable = getAvailableQuantityForDraft(partId);
  const draftedQuantity = state.draftParts
    .filter((item) => item.partId === partId)
    .reduce((sum, item) => sum + Number(item.quantityUsed || 0), 0);
  return totalAvailable - draftedQuantity;
}

function showInlinePartPanel() {
  clearError(els.inlinePartError);
  els.inlinePartPanel.classList.remove("hidden");
  els.inlinePartCategory.value = state.activePartCategory !== "all" ? state.activePartCategory : "general";
  els.inlinePartCategory.dataset.lastValue = els.inlinePartCategory.value;
  els.inlinePartQuantity.value = "1";
  els.inlinePartGarageCost.value = "0";
  els.inlinePartCustomerPrice.value = "0";
  requestAnimationFrame(() => els.inlinePartSku.focus());
}

function hideInlinePartPanel() {
  clearError(els.inlinePartError);
  els.inlinePartPanel.classList.add("hidden");
  els.inlinePartSku.value = "";
  els.inlinePartName.value = "";
  els.inlinePartCategory.value = "general";
  els.inlinePartQuantity.value = "1";
  els.inlinePartGarageCost.value = "0";
  els.inlinePartCustomerPrice.value = "0";
}

async function saveInlinePart() {
  clearError(els.inlinePartError);

  const part = {
    sku: els.inlinePartSku.value.trim(),
    name: els.inlinePartName.value.trim(),
    category: els.inlinePartCategory.value || "general",
    quantity: toOptionalInt(els.inlinePartQuantity.value) ?? 0,
    garageCost: toMoney(els.inlinePartGarageCost.value),
    customerPrice: toMoney(els.inlinePartCustomerPrice.value),
    updatedAt: new Date().toISOString()
  };

  if (!part.sku || !part.name) {
    showError(els.inlinePartError, "מק\"ט ושם חלק הם שדות חובה");
    return;
  }

  if (part.quantity < 1) {
    showError(els.inlinePartError, "כדי להוסיף חלק לעבודה יש להזין לפחות יחידה אחת במלאי");
    return;
  }

  if (part.customerPrice <= 0) {
    showError(els.inlinePartError, "מחיר ללקוח חייב להיות גדול מ-0");
    return;
  }

  try {
    const newPartId = await savePart(part, null);
    await refreshData();
    renderInventory();
    renderAnalytics();

    state.activePartCategory = getPartCategoryId(part);
    state.selectedPartId = newPartId;
    els.partQuantity.value = "1";
    renderPartPicker();
    addPartToDraft();
    hideInlinePartPanel();
    showToast("החלק נוצר ונוסף לעבודה");
  } catch (error) {
    console.error(error);
    if (error.name === "ConstraintError") {
      showError(els.inlinePartError, "מק\"ט זה כבר קיים במלאי");
    } else {
      showError(els.inlinePartError, error.message || "שגיאה ביצירת החלק");
    }
  }
}

function renderDraftParts() {
  els.selectedParts.innerHTML = "";

  if (state.draftParts.length === 0) {
    const empty = document.createElement("span");
    empty.className = "empty-inline";
    empty.textContent = "לא נבחרו חלקים";
    els.selectedParts.appendChild(empty);
  } else {
    state.draftParts.forEach((part, index) => {
      const chip = document.createElement("span");
      chip.className = "part-chip";
      chip.innerHTML = `
        <span>${escapeHtml(part.nameSnapshot)} × ${part.quantityUsed}</span>
        <button type="button" aria-label="הסרת חלק" data-remove-draft-part="${index}">×</button>
      `;
      els.selectedParts.appendChild(chip);
    });
  }

  els.selectedParts.querySelectorAll("[data-remove-draft-part]").forEach((button) => {
    button.addEventListener("click", () => {
      state.draftParts.splice(Number(button.dataset.removeDraftPart), 1);
      renderDraftParts();
      renderPartPicker();
    });
  });

  renderDraftTotals();
}

function renderDraftTotals() {
  const laborPrice = toMoney(els.jobForm.elements.laborPrice.value);
  const taxEnabled = els.taxEnabled?.checked || false;
  const taxRate = Number(els.taxRate?.value) || 0;
  const totals = getPartsTotals(state.draftParts, laborPrice, taxEnabled, taxRate);
  els.draftPartsCost.textContent = formatCurrency(totals.partsCost);
  els.draftPartsPrice.textContent = formatCurrency(totals.partsPrice);
  els.draftSubtotal.textContent = formatCurrency(totals.subtotal);
  els.draftTaxAmount.textContent = formatCurrency(totals.taxAmount);
  els.draftTaxRateLabel.textContent = String(taxRate);
  els.draftTaxLine.classList.toggle("hidden", !taxEnabled);
  els.draftTotal.textContent = formatCurrency(totals.total);
  els.draftProfit.textContent = formatCurrency(totals.profit);
}

elsReadyForLaborTotals();

function elsReadyForLaborTotals() {
  document.addEventListener("input", (event) => {
    if (event.target?.name === "laborPrice" || event.target?.id === "taxRate") {
      renderDraftTotals();
    }
  });
  document.addEventListener("change", (event) => {
    if (event.target?.id === "taxEnabled") {
      renderDraftTotals();
    }
  });
}

async function saveJobFromForm(event) {
  event.preventDefault();
  clearError(els.jobError);

  const form = new FormData(els.jobForm);
  const job = {
    id: state.editingJobId || undefined,
    jobDate: String(form.get("jobDate") || toIsoDate(new Date())),
    vehiclePlate: String(form.get("vehiclePlate") || "").trim(),
    vehicleModel: String(form.get("vehicleModel") || "").trim(),
    vehicleYear: toOptionalInt(form.get("vehicleYear")),
    engineDisplacement: toOptionalInt(form.get("engineDisplacement")),
    ownerName: String(form.get("ownerName") || "").trim(),
    laborPrice: toMoney(form.get("laborPrice")),
    deliveryDate: String(form.get("deliveryDate") || ""),
    parts: structuredClone(state.draftParts),
    taxEnabled: els.taxEnabled.checked,
    taxRate: Number(els.taxRate.value) || 0,
    updatedAt: new Date().toISOString()
  };

  if (!job.vehiclePlate) {
    showError(els.jobError, "מספר רכב הוא שדה חובה");
    return;
  }

  const validationError = validateJobParts(job.parts);
  if (validationError) {
    showError(els.jobError, validationError);
    return;
  }

  try {
    await saveJobWithInventoryTransaction(job, state.editingJobId);
    await refreshData();
    renderAll();
    closeModal("jobModal");
    showToast("העבודה נשמרה והמלאי עודכן");
  } catch (error) {
    console.error(error);
    showError(els.jobError, error.message || "שגיאה בשמירת העבודה");
  }
}

function validateJobParts(parts) {
  const requiredByPart = new Map();

  for (const part of parts || []) {
    if (!part.partId) return "אחד החלקים בעבודה אינו קיים במלאי";
    if (Number(part.quantityUsed || 0) <= 0) return "כמות חלק חייבת להיות גדולה מ-0";
    if (Number(part.customerPriceSnapshot || 0) <= 0) return `יש לעדכן מחיר ללקוח עבור ${part.nameSnapshot}`;
    requiredByPart.set(part.partId, (requiredByPart.get(part.partId) || 0) + Number(part.quantityUsed || 0));
  }

  for (const [partId, requiredQuantity] of requiredByPart.entries()) {
    const part = state.inventory.find((item) => item.id === partId);
    if (!part) return "חלק שנבחר אינו קיים עוד במלאי";
    const availableQuantity = getAvailableQuantityForDraft(partId);
    if (requiredQuantity > availableQuantity) {
      return `אין מספיק מלאי עבור ${part.name}. זמין: ${availableQuantity}`;
    }
  }

  return "";
}

async function saveJobWithInventoryTransaction(job, existingJobId) {
  const transaction = state.db.transaction(["jobs", "inventory"], "readwrite");
  const jobsStore = transaction.objectStore("jobs");
  const inventoryStore = transaction.objectStore("inventory");

  const existingJob = existingJobId ? await idbRequest(jobsStore.get(existingJobId)) : null;
  const deltas = new Map();

  for (const part of existingJob?.parts || []) {
    if (!part.partId) continue;
    deltas.set(part.partId, (deltas.get(part.partId) || 0) - Number(part.quantityUsed || 0));
  }

  for (const part of job.parts || []) {
    if (!part.partId) continue;
    deltas.set(part.partId, (deltas.get(part.partId) || 0) + Number(part.quantityUsed || 0));
  }

  for (const [partId, delta] of deltas.entries()) {
    if (delta === 0) continue;
    const part = await idbRequest(inventoryStore.get(partId));
    if (!part) {
      transaction.abort();
      throw new Error("חלק שנבחר אינו קיים עוד במלאי");
    }

    const nextQuantity = Number(part.quantity || 0) - delta;
    if (nextQuantity < 0) {
      transaction.abort();
      throw new Error(`אין מספיק מלאי עבור ${part.name}`);
    }

    part.quantity = nextQuantity;
    part.updatedAt = new Date().toISOString();
    inventoryStore.put(part);
  }

  const now = new Date().toISOString();
  if (existingJob) {
    jobsStore.put({ ...existingJob, ...job, id: existingJobId, updatedAt: now });
  } else {
    const newJob = { ...job, createdAt: now, updatedAt: now };
    delete newJob.id;
    jobsStore.add(newJob);
  }

  await transactionDone(transaction);
}

async function savePartFromForm(event) {
  event.preventDefault();
  clearError(els.partError);

  const form = new FormData(els.partForm);
  const part = {
    sku: String(form.get("sku") || "").trim(),
    name: String(form.get("name") || "").trim(),
    category: String(form.get("category") || "general"),
    quantity: toOptionalInt(form.get("quantity")) ?? 0,
    garageCost: toMoney(form.get("garageCost")),
    customerPrice: toMoney(form.get("customerPrice")),
    updatedAt: new Date().toISOString()
  };

  if (!part.sku || !part.name) {
    showError(els.partError, "מק\"ט ושם חלק הם שדות חובה");
    return;
  }

  if (part.quantity < 0) {
    showError(els.partError, "כמות לא יכולה להיות שלילית");
    return;
  }

  try {
    await savePart(part);
    await refreshData();
    renderAll();
    closeModal("partModal");
    showToast("החלק נשמר בהצלחה");
  } catch (error) {
    console.error(error);
    if (error.name === "ConstraintError") {
      showError(els.partError, "מק\"ט זה כבר קיים במלאי");
    } else {
      showError(els.partError, error.message || "שגיאה בשמירת החלק");
    }
  }
}

async function savePart(part, partId = state.editingPartId) {
  const transaction = state.db.transaction("inventory", "readwrite");
  const store = transaction.objectStore("inventory");
  const now = new Date().toISOString();
  let savedId;

  if (partId) {
    const existing = await idbRequest(store.get(partId));
    if (!existing) throw new Error("החלק לא נמצא");
    savedId = await idbRequest(store.put({ ...existing, ...part, id: partId, updatedAt: now }));
  } else {
    savedId = await idbRequest(store.add({ ...part, createdAt: now, updatedAt: now }));
  }

  await transactionDone(transaction);
  return savedId;
}

async function adjustPartQuantity(partId, delta) {
  const transaction = state.db.transaction("inventory", "readwrite");
  const store = transaction.objectStore("inventory");
  const part = await idbRequest(store.get(partId));
  if (!part) return;

  const nextQuantity = Math.max(0, Number(part.quantity || 0) + delta);
  part.quantity = nextQuantity;
  part.updatedAt = new Date().toISOString();
  store.put(part);
  await transactionDone(transaction);

  await refreshData();
  renderAll();
}

async function deleteJob(jobId) {
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) return;
  if (!confirm("למחוק את העבודה ולהחזיר את החלקים למלאי?")) return;

  const transaction = state.db.transaction(["jobs", "inventory"], "readwrite");
  const jobsStore = transaction.objectStore("jobs");
  const inventoryStore = transaction.objectStore("inventory");

  for (const jobPart of job.parts || []) {
    if (!jobPart.partId) continue;
    const part = await idbRequest(inventoryStore.get(jobPart.partId));
    if (!part) continue;
    part.quantity = Number(part.quantity || 0) + Number(jobPart.quantityUsed || 0);
    part.updatedAt = new Date().toISOString();
    inventoryStore.put(part);
  }

  jobsStore.delete(jobId);
  await transactionDone(transaction);

  await refreshData();
  renderAll();
  showToast("העבודה נמחקה והמלאי עודכן");
}

async function deletePart(partId) {
  const part = state.inventory.find((item) => item.id === partId);
  if (!part) return;
  if (!confirm(`למחוק את החלק "${part.name}" מהמלאי? עבודות קיימות ישמרו את פרטי החלק ההיסטוריים.`)) return;

  const transaction = state.db.transaction("inventory", "readwrite");
  transaction.objectStore("inventory").delete(partId);
  await transactionDone(transaction);

  await refreshData();
  renderAll();
  showToast("החלק נמחק מהמלאי");
}

function renderTaxCell(totals) {
  if (totals.taxEnabled) {
    return `<span class="tax-badge included" title="מע&quot;מ של ${totals.taxRate}% נוסף לסה&quot;כ (${formatCurrency(totals.taxAmount)})">כלול ${totals.taxRate}%</span>`;
  }
  return `<span class="tax-badge excluded" title="ללא מע&quot;מ">ללא</span>`;
}

function getJobTotals(job) {
  return getPartsTotals(
    job.parts || [],
    Number(job.laborPrice) || 0,
    Boolean(job.taxEnabled),
    Number(job.taxRate) || 0
  );
}

function getPartsTotals(parts, laborPrice = 0, taxEnabled = false, taxRate = 0) {
  const partsCost = parts.reduce((sum, part) => sum + Number(part.garageCostSnapshot || 0) * Number(part.quantityUsed || 0), 0);
  const partsPrice = parts.reduce((sum, part) => sum + Number(part.customerPriceSnapshot || 0) * Number(part.quantityUsed || 0), 0);
  const subtotal = partsPrice + laborPrice;
  const taxAmount = taxEnabled ? subtotal * (Number(taxRate) || 0) / 100 : 0;
  const total = subtotal + taxAmount;
  return {
    partsCost,
    partsPrice,
    subtotal,
    taxEnabled,
    taxRate: Number(taxRate) || 0,
    taxAmount,
    total,
    profit: partsPrice - partsCost + laborPrice
  };
}

function getPartsText(job) {
  const parts = job.parts || [];
  if (parts.length === 0) return "";
  return parts.map((part) => `${part.nameSnapshot} × ${part.quantityUsed}`).join(", ");
}

function getPartCategoryId(part) {
  if (part?.category && getAllPartCategories().some((category) => category.id === part.category)) {
    return part.category;
  }

  return inferPartCategory(part?.name || "");
}

function getPartCategoryLabel(part) {
  const categoryId = getPartCategoryId(part);
  return getAllPartCategories().find((category) => category.id === categoryId)?.label || "כללי";
}

function inferPartCategory(name) {
  const text = normalizeSearch(name);
  if (text.includes("גיר") || text.includes("קלאץ") || text.includes("מצמד") || text.includes("תיבת")) return "gear";
  if (text.includes("בלם") || text.includes("ברקס") || text.includes("רפיד") || text.includes("דיסק")) return "brakes";
  if (text.includes("מסנן") || text.includes("פילטר")) return "filters";
  if (text.includes("מנוע") || text.includes("שמן") || text.includes("פלאג") || text.includes("רצוע")) return "engine";
  if (text.includes("מצבר") || text.includes("נור") || text.includes("חשמל") || text.includes("חיישן")) return "electric";
  if (text.includes("בולם") || text.includes("מתלה") || text.includes("משולש")) return "suspension";
  if (text.includes("מגב") || text.includes("פנס") || text.includes("מראה") || text.includes("דלת")) return "body";
  return "general";
}

function getHebrewDay(dateValue) {
  if (!dateValue) return "";
  const date = new Date(`${dateValue}T12:00:00`);
  return DAY_NAMES[date.getDay()] || "";
}

function getDateRange(range) {
  const today = new Date();
  const start = new Date(today);
  const end = new Date(today);
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);

  if (range === "week") {
    start.setDate(today.getDate() - today.getDay());
  }

  if (range === "month") {
    start.setDate(1);
  }

  if (range === "all") {
    return { start: null, end: null };
  }

  return { start, end };
}

function isDateInRange(dateValue, start, end) {
  if (!start || !end) return true;
  if (!dateValue) return false;
  const date = new Date(`${dateValue}T12:00:00`);
  return date >= start && date <= end;
}

function exportJson() {
  const payload = {
    app: "TopGear",
    exportedAt: new Date().toISOString(),
    version: 3,
    jobs: state.jobs,
    inventory: state.inventory,
    customCategories: state.customCategories,
    appointments: state.appointments
  };
  downloadFile(`topgear-backup-${toIsoDate(new Date())}.json`, JSON.stringify(payload, null, 2), "application/json");
  showToast("קובץ JSON נשמר");
}

function exportJobsCsv() {
  const headers = [
    "תאריך",
    "יום",
    "מספר רכב",
    "סוג רכב",
    "שנת הרכב",
    "נפח מנוע",
    "שם בעל הרכב",
    "חלקים",
    "מחיר חלקים למוסך",
    "מחיר חלקים ללקוח",
    "מחיר עבודה",
    "סה\"כ לפני מע\"מ",
    "אחוז מע\"מ",
    "מע\"מ",
    "סה\"כ לתשלום",
    "רווח",
    "תאריך מסירה"
  ];

  const rows = state.jobs.map((job) => {
    const totals = getJobTotals(job);
    return [
      job.jobDate,
      getHebrewDay(job.jobDate),
      job.vehiclePlate,
      job.vehicleModel,
      job.vehicleYear,
      job.engineDisplacement,
      job.ownerName,
      getPartsText(job),
      totals.partsCost,
      totals.partsPrice,
      job.laborPrice,
      totals.subtotal,
      totals.taxEnabled ? totals.taxRate : 0,
      totals.taxAmount,
      totals.total,
      totals.profit,
      job.deliveryDate
    ];
  });

  downloadFile(`topgear-jobs-${toIsoDate(new Date())}.csv`, toCsv(headers, rows), "text/csv;charset=utf-8");
  showToast("קובץ יומן CSV נשמר");
}

function exportInventoryCsv() {
  const headers = ["מק\"ט חלק", "חלק", "קטגוריה", "כמות", "מחיר חלק למוסך", "מחיר חלק ללקוח"];
  const rows = state.inventory.map((part) => [part.sku, part.name, getPartCategoryLabel(part), part.quantity, part.garageCost, part.customerPrice]);
  downloadFile(`topgear-inventory-${toIsoDate(new Date())}.csv`, toCsv(headers, rows), "text/csv;charset=utf-8");
  showToast("קובץ מלאי CSV נשמר");
}

async function importJson(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const payload = JSON.parse(text);

    if (!Array.isArray(payload.jobs) || !Array.isArray(payload.inventory)) {
      throw new Error("מבנה קובץ הגיבוי אינו תקין");
    }

    if (!confirm("הייבוא יחליף את כל הנתונים הקיימים. להמשיך?")) {
      event.target.value = "";
      return;
    }

    await replaceAllData(
      payload.jobs,
      payload.inventory,
      Array.isArray(payload.customCategories) ? payload.customCategories : [],
      Array.isArray(payload.appointments) ? payload.appointments : []
    );
    await refreshData();
    renderAll();
    showToast("הגיבוי יובא בהצלחה");
  } catch (error) {
    console.error(error);
    showToast(error.message || "שגיאה בייבוא הגיבוי");
  } finally {
    event.target.value = "";
  }
}

async function replaceAllData(jobs, inventory, customCategories = [], appointments = []) {
  const transaction = state.db.transaction(["jobs", "inventory", "categories", "appointments"], "readwrite");
  const jobsStore = transaction.objectStore("jobs");
  const inventoryStore = transaction.objectStore("inventory");
  const categoriesStore = transaction.objectStore("categories");
  const appointmentsStore = transaction.objectStore("appointments");

  jobsStore.clear();
  inventoryStore.clear();
  categoriesStore.clear();
  appointmentsStore.clear();

  for (const category of customCategories) {
    if (!category?.id || !category?.label) continue;
    categoriesStore.put({
      id: String(category.id),
      label: String(category.label),
      custom: true,
      createdAt: category.createdAt || new Date().toISOString()
    });
  }

  for (const appointment of appointments) {
    if (!appointment?.appointmentDate || !appointment?.customerName) continue;
    const record = {
      appointmentDate: String(appointment.appointmentDate || ""),
      appointmentTime: String(appointment.appointmentTime || ""),
      customerName: String(appointment.customerName || ""),
      phoneNumber: String(appointment.phoneNumber || ""),
      vehiclePlate: String(appointment.vehiclePlate || ""),
      vehicleModel: String(appointment.vehicleModel || ""),
      reason: String(appointment.reason || ""),
      notes: String(appointment.notes || ""),
      createdAt: appointment.createdAt || new Date().toISOString(),
      updatedAt: appointment.updatedAt || new Date().toISOString()
    };
    if (appointment.id !== undefined && appointment.id !== null) record.id = appointment.id;
    appointmentsStore.put(record);
  }

  for (const part of inventory) {
    const record = {
      sku: String(part.sku || ""),
      name: String(part.name || ""),
      category: part.category || inferPartCategory(part.name || ""),
      quantity: toOptionalInt(part.quantity) ?? 0,
      garageCost: toMoney(part.garageCost),
      customerPrice: toMoney(part.customerPrice),
      createdAt: part.createdAt || new Date().toISOString(),
      updatedAt: part.updatedAt || new Date().toISOString()
    };
    if (part.id !== undefined && part.id !== null) record.id = part.id;
    inventoryStore.put(record);
  }

  for (const job of jobs) {
    const record = {
      jobDate: job.jobDate || toIsoDate(new Date()),
      vehiclePlate: String(job.vehiclePlate || ""),
      vehicleModel: String(job.vehicleModel || ""),
      vehicleYear: toOptionalInt(job.vehicleYear),
      engineDisplacement: toOptionalInt(job.engineDisplacement),
      ownerName: String(job.ownerName || ""),
      laborPrice: toMoney(job.laborPrice),
      deliveryDate: job.deliveryDate || "",
      parts: Array.isArray(job.parts) ? job.parts : [],
      taxEnabled: Boolean(job.taxEnabled),
      taxRate: Number(job.taxRate) || 0,
      createdAt: job.createdAt || new Date().toISOString(),
      updatedAt: job.updatedAt || new Date().toISOString()
    };
    if (job.id !== undefined && job.id !== null) record.id = job.id;
    jobsStore.put(record);
  }

  await transactionDone(transaction);
}

function toCsv(headers, rows) {
  const bom = "\uFEFF";
  const lines = [headers, ...rows].map((row) => row.map(csvCell).join(","));
  return bom + lines.join("\n");
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function openModal(id) {
  document.querySelector(`#${id}`).classList.remove("hidden");
}

function closeModal(id) {
  document.querySelector(`#${id}`).classList.add("hidden");
}

function closeAllModals() {
  closeModal("jobModal");
  closeModal("partModal");
  closeModal("appointmentModal");
}

function showError(element, message) {
  element.textContent = message;
  element.classList.remove("hidden");
}

function clearError(element) {
  element.textContent = "";
  element.classList.add("hidden");
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.add("hidden"), 2800);
}

function handleTableArrowNavigation(event) {
  const activeModal = !els.jobModal.classList.contains("hidden") || !els.partModal.classList.contains("hidden");
  const activeTag = document.activeElement?.tagName?.toLowerCase();
  if (activeModal || ["input", "select", "textarea", "button"].includes(activeTag)) return;

  if (state.activeView === "jobs") {
    const rows = Array.from(els.jobsBody.querySelectorAll("tr"));
    if (rows.length === 0) return;
    event.preventDefault();
    state.selectedJobRow = clamp(state.selectedJobRow + (event.key === "ArrowDown" ? 1 : -1), 0, rows.length - 1);
    rows[state.selectedJobRow].focus();
    paintSelectedRows(els.jobsBody, state.selectedJobRow);
  }

  if (state.activeView === "inventory") {
    const rows = Array.from(els.inventoryBody.querySelectorAll("tr"));
    if (rows.length === 0) return;
    event.preventDefault();
    state.selectedInventoryRow = clamp(state.selectedInventoryRow + (event.key === "ArrowDown" ? 1 : -1), 0, rows.length - 1);
    rows[state.selectedInventoryRow].focus();
    paintSelectedRows(els.inventoryBody, state.selectedInventoryRow);
  }
}

function paintSelectedRows(tbody, selectedIndex) {
  Array.from(tbody.querySelectorAll("tr")).forEach((row, index) => {
    row.classList.toggle("selected", index === selectedIndex);
  });
}

function formatCurrency(value) {
  return new Intl.NumberFormat("he-IL", {
    style: "currency",
    currency: "ILS",
    maximumFractionDigits: 0
  }).format(Number(value) || 0);
}

function formatDate(dateValue) {
  if (!dateValue) return "";
  return new Intl.DateTimeFormat("he-IL", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(`${dateValue}T12:00:00`));
}

function toIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toMoney(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function toOptionalInt(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number.parseInt(String(value), 10);
  return Number.isFinite(number) ? number : null;
}

function toPositiveInt(value) {
  const number = Number.parseInt(String(value), 10);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeSearch(value) {
  return String(value || "").trim().toLowerCase();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
