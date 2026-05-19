"use strict";

const DB_NAME = "topgear_offline_garage";
const DB_VERSION = 4;
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

const DEFAULT_BUSINESS = {
  id: "business",
  name: "",
  taxId: "",
  licenseNumber: "",
  address: "",
  phone: "",
  defaultTaxRate: 18
};

const state = {
  db: null,
  jobs: [],
  inventory: [],
  customCategories: [],
  appointments: [],
  business: { ...DEFAULT_BUSINESS },
  whatsappSource: "job",
  whatsappSelectedId: null,
  activeVehiclePlate: "",
  activeView: "jobs",
  activeRange: "today",
  specificRangeDate: "",
  specificRangeMonth: "",
  activeJobsFilter: "open",
  activeDeliveryRange: "upcoming",
  activeAppointmentRange: "upcoming",
  activePartCategory: "all",
  activeInventoryCategory: "all",
  selectedPartId: null,
  editingJobId: null,
  editingPartId: null,
  editingAppointmentId: null,
  appointmentBeingConverted: null,
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
    whatsapp: document.querySelector("#whatsappView"),
    vehicleHistory: document.querySelector("#vehicleHistoryView"),
    backup: document.querySelector("#backupView")
  };

  els.rangeButtons = Array.from(document.querySelectorAll("[data-range]"));
  els.specificRangeDate = document.querySelector("#specificRangeDate");
  els.specificRangeMonth = document.querySelector("#specificRangeMonth");
  els.revenueMetric = document.querySelector("#revenueMetric");
  els.costMetric = document.querySelector("#costMetric");
  els.profitMetric = document.querySelector("#profitMetric");

  els.jobSearch = document.querySelector("#jobSearch");
  els.jobsBody = document.querySelector("#jobsBody");
  els.jobsEmpty = document.querySelector("#jobsEmpty");
  els.addJobButton = document.querySelector("#addJobButton");
  els.jobsFilterButtons = Array.from(document.querySelectorAll("[data-jobs-filter]"));

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
  els.inlinePartTemporary = document.querySelector("#inlinePartTemporary");
  els.inlinePartTitle = document.querySelector("#inlinePartTitle");
  els.inlinePartSkuLabel = document.querySelector("#inlinePartSkuLabel");
  els.inlinePartQuantityLabel = document.querySelector("#inlinePartQuantityLabel");
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
  els.isQuote = document.querySelector("#isQuote");

  els.partModal = document.querySelector("#partModal");
  els.partForm = document.querySelector("#partForm");
  els.partModalTitle = document.querySelector("#partModalTitle");
  els.partError = document.querySelector("#partError");
  els.partCategorySelect = document.querySelector("#partCategorySelect");

  els.exportJsonButton = document.querySelector("#exportJsonButton");
  els.exportJobsCsvButton = document.querySelector("#exportJobsCsvButton");
  els.exportInventoryCsvButton = document.querySelector("#exportInventoryCsvButton");
  els.importJsonInput = document.querySelector("#importJsonInput");
  els.businessSettingsForm = document.querySelector("#businessSettingsForm");
  els.whatsappSourceTabs = Array.from(document.querySelectorAll("[data-wa-source]"));
  els.whatsappSourceSearch = document.querySelector("#whatsappSourceSearch");
  els.whatsappSourceList = document.querySelector("#whatsappSourceList");
  els.whatsappCustomerName = document.querySelector("#whatsappCustomerName");
  els.whatsappPhone = document.querySelector("#whatsappPhone");
  els.whatsappMessage = document.querySelector("#whatsappMessage");
  els.whatsappTemplates = Array.from(document.querySelectorAll("[data-wa-template]"));
  els.whatsappSendButton = document.querySelector("#whatsappSendButton");
  els.whatsappInvoiceButton = document.querySelector("#whatsappInvoiceButton");
  els.invoiceModal = document.querySelector("#invoiceModal");
  els.invoiceSheet = document.querySelector("#invoiceSheet");
  els.invoicePrintButton = document.querySelector("#invoicePrintButton");
  els.vehicleHistorySearch = document.querySelector("#vehicleHistorySearch");
  els.vehicleHistoryClearButton = document.querySelector("#vehicleHistoryClearButton");
  els.vehicleHistorySuggestions = document.querySelector("#vehicleHistorySuggestions");
  els.vehicleHistoryEmpty = document.querySelector("#vehicleHistoryEmpty");
  els.vehicleHistoryDetail = document.querySelector("#vehicleHistoryDetail");
  els.vehicleHistorySummary = document.querySelector("#vehicleHistorySummary");
  els.vehicleHistoryList = document.querySelector("#vehicleHistoryList");
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

      if (state.activeRange === "specific") {
        els.specificRangeDate.classList.remove("hidden");
        if (!els.specificRangeDate.value) {
          els.specificRangeDate.value = toIsoDate(new Date());
        }
        state.specificRangeDate = els.specificRangeDate.value;
      } else {
        els.specificRangeDate.classList.add("hidden");
      }

      if (state.activeRange === "month") {
        els.specificRangeMonth.classList.remove("hidden");
        if (!els.specificRangeMonth.value) {
          const now = new Date();
          els.specificRangeMonth.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        }
        state.specificRangeMonth = els.specificRangeMonth.value;
      } else {
        els.specificRangeMonth.classList.add("hidden");
      }

      renderAnalytics();
    });
  });

  els.specificRangeDate.addEventListener("change", () => {
    state.specificRangeDate = els.specificRangeDate.value;
    renderAnalytics();
  });

  els.specificRangeMonth.addEventListener("change", () => {
    state.specificRangeMonth = els.specificRangeMonth.value;
    renderAnalytics();
  });

  els.jobSearch.addEventListener("input", renderJobs);
  els.jobsFilterButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.activeJobsFilter = button.dataset.jobsFilter;
      els.jobsFilterButtons.forEach((item) => item.classList.toggle("active", item === button));
      renderJobs();
    });
  });
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
  els.inlinePartTemporary.addEventListener("change", updateInlinePartMode);
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
  els.businessSettingsForm.addEventListener("submit", saveBusinessFromForm);
  els.invoicePrintButton.addEventListener("click", printInvoiceWithFilename);
  // Safety net: the iframe-based print flow does not mutate the main window's
  // document.title, but the fallback path (if the iframe is denied for any
  // reason) does. Restore the original title whenever a print dialog closes.
  window.addEventListener("afterprint", () => {
    if (document.title !== "TopGear - ניהול מוסך") {
      document.title = "TopGear - ניהול מוסך";
    }
  });

  els.whatsappSourceTabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      state.whatsappSource = btn.dataset.waSource;
      state.whatsappSelectedId = null;
      els.whatsappSourceTabs.forEach((b) => b.classList.toggle("active", b === btn));
      renderWhatsappSourceList();
    });
  });
  els.whatsappSourceSearch.addEventListener("input", renderWhatsappSourceList);
  els.whatsappTemplates.forEach((btn) => {
    btn.addEventListener("click", () => applyWhatsappTemplate(btn.dataset.waTemplate));
  });
  els.whatsappSendButton.addEventListener("click", sendWhatsapp);
  els.whatsappInvoiceButton.addEventListener("click", downloadInvoiceForWhatsapp);

  els.vehicleHistorySearch.addEventListener("input", () => {
    const q = els.vehicleHistorySearch.value;
    const exactMatch = state.jobs.find((j) => normalizePlate(j.vehiclePlate) === normalizePlate(q));
    if (exactMatch && normalizePlate(q).length >= 3) {
      state.activeVehiclePlate = q;
    } else {
      state.activeVehiclePlate = "";
    }
    renderVehicleHistory();
  });
  els.vehicleHistoryClearButton.addEventListener("click", () => {
    els.vehicleHistorySearch.value = "";
    state.activeVehiclePlate = "";
    renderVehicleHistory();
    els.vehicleHistorySearch.focus();
  });

  document.addEventListener("click", (event) => {
    const plateBtn = event.target?.closest?.("[data-vehicle-history]");
    if (plateBtn) {
      event.stopPropagation();
      openVehicleHistory(plateBtn.dataset.vehicleHistory);
    }
  });

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

      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "id" });
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
  const [jobs, inventory, categories, appointments, settings] = await Promise.all([
    getAll("jobs"),
    getAll("inventory"),
    getAll("categories"),
    getAll("appointments"),
    getAll("settings")
  ]);
  state.jobs = jobs.sort((a, b) => `${b.jobDate}${b.id}`.localeCompare(`${a.jobDate}${a.id}`));
  state.inventory = inventory.sort((a, b) => a.name.localeCompare(b.name, "he"));
  state.customCategories = categories.sort((a, b) => a.label.localeCompare(b.label, "he"));
  state.appointments = appointments.sort((a, b) => {
    const aKey = `${a.appointmentDate || ""}${a.appointmentTime || ""}`;
    const bKey = `${b.appointmentDate || ""}${b.appointmentTime || ""}`;
    return aKey.localeCompare(bKey);
  });
  const businessRecord = settings.find((s) => s.id === "business");
  state.business = businessRecord ? { ...DEFAULT_BUSINESS, ...businessRecord } : { ...DEFAULT_BUSINESS };
}

async function saveBusinessSettings(updates) {
  const next = { ...DEFAULT_BUSINESS, ...state.business, ...updates, id: "business" };
  const transaction = state.db.transaction("settings", "readwrite");
  transaction.objectStore("settings").put(next);
  await transactionDone(transaction);
  state.business = next;
}

function renderAll() {
  renderCategorySelects();
  renderPartPicker();
  renderJobs();
  renderInventory();
  renderDeliveries();
  renderAppointments();
  renderAnalytics();
  renderBusinessSettings();
  renderWhatsappSourceList();
  renderVehicleHistory();
}

function normalizePlate(plate) {
  return String(plate || "").replace(/\s+|-/g, "").toLowerCase();
}

const AVATAR_PALETTE = [
  "#fde2e4", "#fad2e1", "#e2ece9", "#bee1e6", "#f0efeb",
  "#dfe7fd", "#cddafd", "#fff1e6", "#fde2cf", "#e0bbe4",
  "#d8e2dc", "#ffe5d9", "#dbe7e4"
];

function getAvatarColor(seed) {
  const s = String(seed || "");
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

function renderWhatsappSourceList() {
  if (!els.whatsappSourceList) return;
  const query = normalizeSearch(els.whatsappSourceSearch.value);
  let items = [];
  if (state.whatsappSource === "job") {
    items = state.jobs
      .filter((j) => j.phoneNumber)
      .map((j) => ({
        id: `job-${j.id}`,
        title: j.ownerName || "—",
        sub: `${formatDate(j.jobDate)}${j.deliveredAt ? " · ✓ נמסר" : " · בעבודה"}`,
        phone: j.phoneNumber,
        name: j.ownerName || "",
        plate: j.vehiclePlate || "",
        jobId: j.id,
        type: "job"
      }));
  } else if (state.whatsappSource === "appointment") {
    items = state.appointments
      .filter((a) => a.phoneNumber)
      .map((a) => ({
        id: `appt-${a.id}`,
        title: a.customerName || "—",
        sub: `${formatDate(a.appointmentDate)}${a.appointmentTime ? " " + a.appointmentTime : ""}${a.arrivedAt ? " · ✓ הגיע" : ""}`,
        phone: a.phoneNumber,
        name: a.customerName || "",
        plate: a.vehiclePlate || "",
        reason: a.reason || "",
        appointmentDate: a.appointmentDate,
        appointmentTime: a.appointmentTime,
        type: "appointment"
      }));
  } else {
    els.whatsappSourceList.innerHTML = '<div class="empty-inline">במצב ידני: מלא טלפון ושם בצד שמאל</div>';
    return;
  }

  if (query) {
    items = items.filter((it) => normalizeSearch([it.title, it.sub, it.phone, it.plate, it.name].join(" ")).includes(query));
  }

  if (items.length === 0) {
    els.whatsappSourceList.innerHTML = '<div class="empty-inline">לא נמצאו רשומות</div>';
    return;
  }

  els.whatsappSourceList.innerHTML = items.slice(0, 80).map((it) => {
    const isSelected = state.whatsappSelectedId === it.id;
    const initial = String(it.name || it.plate || "?").trim().charAt(0).toUpperCase() || "?";
    const avatarColor = getAvatarColor(it.name || it.plate || "");
    return `
      <div class="wa-row${isSelected ? " is-selected" : ""}" data-wa-pick="${it.id}">
        <div class="wa-avatar" style="background:${avatarColor}">
          ${isSelected ? "✓" : escapeHtml(initial)}
        </div>
        <div class="wa-row-main">
          <div class="wa-row-name">${escapeHtml(it.name || "—")}</div>
          <div class="wa-row-context">${escapeHtml((it.plate || "") + (it.plate ? " · " : "") + (it.sub || ""))}</div>
        </div>
        <div class="wa-row-phone" dir="ltr">${escapeHtml(it.phone || "")}</div>
      </div>
    `;
  }).join("");

  els.whatsappSourceList.querySelectorAll("[data-wa-pick]").forEach((row) => {
    row.addEventListener("click", () => {
      const pickId = row.dataset.waPick;
      const item = items.find((x) => x.id === pickId);
      if (!item) return;
      state.whatsappSelectedId = pickId;
      els.whatsappCustomerName.value = item.name || "";
      els.whatsappPhone.value = item.phone || "";
      els.whatsappInvoiceButton.disabled = item.type !== "job";
      els.whatsappInvoiceButton.dataset.jobId = item.type === "job" ? String(item.jobId) : "";
      els.whatsappMessage.dataset.context = JSON.stringify(item);
      renderWhatsappSourceList();
    });
  });
}

function applyWhatsappTemplate(kind) {
  const ctx = (() => { try { return JSON.parse(els.whatsappMessage.dataset.context || "{}"); } catch { return {}; } })();
  const name = els.whatsappCustomerName.value.trim() || ctx.name || "לקוח";
  const garageName = state.business.name || "המוסך";
  const plate = ctx.plate || "";
  const date = ctx.appointmentDate ? formatDate(ctx.appointmentDate) : "";
  const time = ctx.appointmentTime || "";
  const phoneLine = state.business.phone ? `\nליצירת קשר: ${state.business.phone}` : "";

  let msg = "";
  switch (kind) {
    case "appointment": {
      const whenParts = [];
      if (date) whenParts.push(date);
      if (time) whenParts.push(`בשעה ${time}`);
      const whenStr = whenParts.length ? whenParts.join(" ") : "";
      msg = `שלום ${name},\nתזכורת קצרה לגבי התור שלך ב-${garageName}${whenStr ? ` ביום ${whenStr}` : ""}.${ctx.reason ? `\nמטרת הביקור: ${ctx.reason}` : ""}${plate ? `\nרכב: ${plate}` : ""}\nנתראה!${phoneLine}`;
      break;
    }
    case "ready": {
      msg = `שלום ${name},\nהרכב${plate ? " " + plate : ""} מוכן לאיסוף ב-${garageName}.\nנשמח לראותך בשעות הפעילות.${phoneLine}`;
      break;
    }
    case "invoice": {
      msg = `שלום ${name},\nמצורפת חשבונית עבור הטיפול ב-${garageName}${plate ? ` עבור הרכב ${plate}` : ""}.\nתודה על האמון!`;
      break;
    }
    case "general": {
      msg = `שלום ${name},\nתודה שבחרת ב-${garageName}. נשמח לראותך שוב.${phoneLine}`;
      break;
    }
  }
  els.whatsappMessage.value = msg;
}

function formatPhoneForWhatsapp(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("972")) return digits;
  if (digits.startsWith("0")) return "972" + digits.slice(1);
  return digits;
}

function sendWhatsapp() {
  const phone = formatPhoneForWhatsapp(els.whatsappPhone.value);
  const msg = els.whatsappMessage.value.trim();
  if (!phone) { showToast("מספר טלפון חסר או לא תקין"); return; }
  if (!msg) { showToast("ההודעה ריקה"); return; }
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
  openExternalUrl(url);
  showToast("נפתח חלון WhatsApp — לחץ Send שם");
}

function openExternalUrl(url) {
  // Tauri v2 — use the shell/opener plugin when running inside the desktop app
  if (window.__TAURI__?.opener?.openUrl) {
    window.__TAURI__.opener.openUrl(url).catch((err) => console.warn("opener.openUrl failed:", err));
    return;
  }
  if (window.__TAURI__?.shell?.open) {
    window.__TAURI__.shell.open(url).catch((err) => console.warn("shell.open failed:", err));
    return;
  }
  // Browser fallback — synthesize an anchor click. Browsers reliably allow
  // this pattern for user-initiated link navigation, unlike window.open()
  // which is often popup-blocked even from click handlers.
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadInvoiceForWhatsapp() {
  const jobIdStr = els.whatsappInvoiceButton.dataset.jobId;
  if (!jobIdStr) return;
  const jobId = Number(jobIdStr);
  openInvoiceForJob(jobId);
  showToast('בחר "🖨 הדפס / שמור PDF" → "Save as PDF" כדי לקבל את הקובץ');
}

function renderBusinessSettings() {
  if (!els.businessSettingsForm) return;
  els.businessSettingsForm.elements.name.value = state.business.name || "";
  els.businessSettingsForm.elements.taxId.value = state.business.taxId || "";
  els.businessSettingsForm.elements.licenseNumber.value = state.business.licenseNumber || "";
  els.businessSettingsForm.elements.address.value = state.business.address || "";
  els.businessSettingsForm.elements.phone.value = state.business.phone || "";
  els.businessSettingsForm.elements.defaultTaxRate.value = String(state.business.defaultTaxRate ?? 18);
}

async function saveBusinessFromForm(event) {
  event.preventDefault();
  const f = els.businessSettingsForm;
  try {
    await saveBusinessSettings({
      name: f.elements.name.value.trim(),
      taxId: f.elements.taxId.value.trim(),
      licenseNumber: f.elements.licenseNumber.value.trim(),
      address: f.elements.address.value.trim(),
      phone: f.elements.phone.value.trim(),
      defaultTaxRate: Number(f.elements.defaultTaxRate.value) || 18
    });
    showToast("פרטי העסק נשמרו");
  } catch (error) {
    console.error(error);
    showToast("שגיאה בשמירת פרטי העסק");
  }
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
    whatsapp: ["שליחה ללקוח", "שליחת הודעות WhatsApp ללקוחות מתוך עבודות ותורים"],
    vehicleHistory: ["היסטוריית רכב", "כל הביקורים של רכב לפי מספר רישוי"],
    backup: ["גיבוי וייצוא", "שמירת נתונים מקומית לקבצי גיבוי ו-CSV"]
  };

  els.screenTitle.textContent = titles[view][0];
  els.screenSubtitle.textContent = titles[view][1];
}

function renderJobs() {
  const query = normalizeSearch(els.jobSearch.value);
  const filter = state.activeJobsFilter || "open";
  const rows = state.jobs.filter((job) => {
    const isDelivered = Boolean(job.deliveredAt);
    const isQuote = Boolean(job.isQuote);
    const isRejected = Boolean(job.rejectedAt);
    // Rejected quotes have their own dedicated tab. They should NOT bleed
    // into "open", "quote" (active proposals), "delivered", or any future
    // filter — only the explicit "rejected" tab and the catch-all "all"
    // tab should ever show them.
    if (filter === "rejected") {
      if (!isRejected) return false;
    } else {
      if (isRejected && filter !== "all") return false;
      if (filter === "quote" && !isQuote) return false;
      if (filter !== "quote" && filter !== "all" && isQuote) return false;
      if (filter === "open" && isDelivered) return false;
      if (filter === "delivered" && !isDelivered) return false;
    }
    const haystack = normalizeSearch([
      job.vehiclePlate,
      job.vehicleModel,
      job.ownerName,
      job.phoneNumber,
      job.parts?.map((part) => part.nameSnapshot).join(" ")
    ].join(" "));
    return haystack.includes(query);
  });

  els.jobsBody.innerHTML = "";
  rows.forEach((job, index) => {
    const totals = getJobTotals(job);
    const isDelivered = Boolean(job.deliveredAt);
    const isQuote = Boolean(job.isQuote);
    const isRejected = Boolean(job.rejectedAt);
    const row = document.createElement("tr");
    row.tabIndex = 0;
    row.dataset.rowIndex = String(index);
    row.classList.toggle("selected", index === state.selectedJobRow);
    row.classList.toggle("job-delivered", isDelivered);
    row.classList.toggle("job-quote", isQuote && !isRejected);
    row.classList.toggle("job-rejected", isRejected);

    // Primary action depends on state:
    //   - rejected quote: offer un-reject so user can recover an estimate
    //     they dismissed by mistake
    //   - active quote: approve (becomes job) OR reject (moves to נדחו tab)
    //   - delivered job: re-open
    //   - open job: mark delivered
    const primaryAction = isRejected
      ? `<button class="row-action" type="button" data-job-unreject="${job.id}">↩ החזר להצעה</button>`
      : isQuote
      ? `<button class="row-action success-action" type="button" data-job-approve="${job.id}">✓ אשר וצור עבודה</button>
         <button class="row-action danger-action" type="button" data-job-reject="${job.id}">✗ דחה</button>`
      : isDelivered
      ? `<button class="row-action" type="button" data-job-reopen="${job.id}">↩ החזר לפתוח</button>`
      : `<button class="row-action success-action" type="button" data-job-deliver="${job.id}">✓ סמן כנמסר</button>`;

    // Reuse the legacy "deliverButton" name in the row template below.
    const deliverButton = primaryAction;

    const dateBadge = isRejected
      ? ' <span class="quote-badge quote-rejected-badge">נדחתה</span>'
      : isQuote
      ? ' <span class="quote-badge">הצעה</span>'
      : '';

    row.innerHTML = `
      <td>${formatDate(job.jobDate)}${dateBadge}</td>
      <td>${getHebrewDay(job.jobDate)}</td>
      <td><button type="button" class="plate-link" data-vehicle-history="${escapeHtml(job.vehiclePlate)}">${escapeHtml(job.vehiclePlate)}</button></td>
      <td>${escapeHtml(job.vehicleModel || "")}</td>
      <td>${job.vehicleYear || ""}</td>
      <td>${job.engineDisplacement || ""}</td>
      <td>${escapeHtml(job.ownerName || "")}</td>
      <td>${job.phoneNumber ? `<a href="tel:${escapeHtml(job.phoneNumber)}" class="phone-link">${escapeHtml(job.phoneNumber)}</a>` : ""}</td>
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
          ${deliverButton}
          <button class="row-action" type="button" data-job-invoice="${job.id}">🧾 חשבונית</button>
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
  els.jobsBody.querySelectorAll("[data-job-deliver]").forEach((button) => {
    button.addEventListener("click", () => markJobDelivered(Number(button.dataset.jobDeliver)));
  });
  els.jobsBody.querySelectorAll("[data-job-reopen]").forEach((button) => {
    button.addEventListener("click", () => markJobReopened(Number(button.dataset.jobReopen)));
  });
  els.jobsBody.querySelectorAll("[data-job-invoice]").forEach((button) => {
    button.addEventListener("click", () => openInvoiceForJob(Number(button.dataset.jobInvoice)));
  });
  els.jobsBody.querySelectorAll("[data-job-approve]").forEach((button) => {
    button.addEventListener("click", () => approveQuote(Number(button.dataset.jobApprove)));
  });
  els.jobsBody.querySelectorAll("[data-job-reject]").forEach((button) => {
    button.addEventListener("click", () => rejectQuote(Number(button.dataset.jobReject)));
  });
  els.jobsBody.querySelectorAll("[data-job-unreject]").forEach((button) => {
    button.addEventListener("click", () => unrejectQuote(Number(button.dataset.jobUnreject)));
  });

  els.jobsEmpty.classList.toggle("hidden", rows.length > 0);
}

async function markJobDelivered(jobId) {
  const transaction = state.db.transaction("jobs", "readwrite");
  const store = transaction.objectStore("jobs");
  const job = await idbRequest(store.get(jobId));
  if (!job) return;
  job.deliveredAt = new Date().toISOString();
  job.updatedAt = job.deliveredAt;
  store.put(job);
  await transactionDone(transaction);
  await refreshData();
  renderJobs();
  renderDeliveries();
  showToast(`העבודה ${job.vehiclePlate} סומנה כנמסרה`);
}

async function approveQuote(jobId) {
  const quote = state.jobs.find((j) => j.id === jobId);
  if (!quote || !quote.isQuote) return;
  if (!confirm(`אישור הצעת המחיר עבור ${quote.vehiclePlate || quote.ownerName} — החלקים יורדו מהמלאי וההצעה תהפוך לעבודה פעילה. להמשיך?`)) return;

  // Check inventory availability before flipping
  const validationError = validateJobParts(quote.parts, false);
  if (validationError) {
    showToast(`לא ניתן לאשר: ${validationError}`);
    return;
  }

  // Drop the rejection marker if it was ever set — an approved quote is by
  // definition not rejected. Leaving it would corrupt analytics filters.
  const updated = { ...quote, isQuote: false };
  delete updated.rejectedAt;
  try {
    await saveJobWithInventoryTransaction(updated, jobId);
    await syncFollowUpAppointment(jobId, updated);
    await refreshData();
    renderAll();
    showToast(`ההצעה אושרה והפכה לעבודה פעילה — המלאי עודכן`);
  } catch (error) {
    console.error(error);
    showToast(error.message || "שגיאה באישור ההצעה");
  }
}

async function rejectQuote(jobId) {
  const transaction = state.db.transaction("jobs", "readwrite");
  const store = transaction.objectStore("jobs");
  const job = await idbRequest(store.get(jobId));
  if (!job || !job.isQuote) return;
  if (!confirm(`לסמן את הצעת המחיר עבור ${job.vehiclePlate || job.ownerName} כ"נדחתה"? ההצעה תועבר לטאב "נדחו" — אפשר להחזיר אותה מאוחר יותר.`)) return;
  job.rejectedAt = new Date().toISOString();
  job.updatedAt = job.rejectedAt;
  store.put(job);
  await transactionDone(transaction);
  await refreshData();
  renderJobs();
  showToast(`הצעת המחיר עבור ${job.vehiclePlate || job.ownerName} סומנה כנדחתה`);
}

async function unrejectQuote(jobId) {
  const transaction = state.db.transaction("jobs", "readwrite");
  const store = transaction.objectStore("jobs");
  const job = await idbRequest(store.get(jobId));
  if (!job || !job.rejectedAt) return;
  delete job.rejectedAt;
  job.updatedAt = new Date().toISOString();
  store.put(job);
  await transactionDone(transaction);
  await refreshData();
  renderJobs();
  showToast(`הצעת המחיר עבור ${job.vehiclePlate || job.ownerName} הוחזרה לטאב "הצעות"`);
}

async function markJobReopened(jobId) {
  const transaction = state.db.transaction("jobs", "readwrite");
  const store = transaction.objectStore("jobs");
  const job = await idbRequest(store.get(jobId));
  if (!job) return;
  delete job.deliveredAt;
  job.updatedAt = new Date().toISOString();
  store.put(job);
  await transactionDone(transaction);
  await refreshData();
  renderJobs();
  renderDeliveries();
  showToast(`העבודה ${job.vehiclePlate} הוחזרה לפתוחה`);
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
    if (job.deliveredAt) return false;
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
      <td><button type="button" class="plate-link" data-vehicle-history="${escapeHtml(job.vehiclePlate)}">${escapeHtml(job.vehiclePlate)}</button></td>
      <td>${escapeHtml(job.vehicleModel || "")}</td>
      <td>${escapeHtml(job.ownerName || "")}</td>
      <td class="parts-cell" title="${escapeHtml(getPartsText(job))}">${escapeHtml(getPartsText(job))}</td>
      <td class="numeric">${formatCurrency(totals.total)}</td>
      <td>
        <span class="row-actions">
          <button class="row-action success-action" type="button" data-delivery-deliver="${job.id}">✓ סמן כנמסר</button>
          <button class="row-action" type="button" data-delivery-edit="${job.id}">פתיחת עבודה</button>
        </span>
      </td>
    `;

    els.deliveriesBody.appendChild(row);
  });

  els.deliveriesBody.querySelectorAll("[data-delivery-edit]").forEach((button) => {
    button.addEventListener("click", () => openJobModal(Number(button.dataset.deliveryEdit)));
  });
  els.deliveriesBody.querySelectorAll("[data-delivery-deliver]").forEach((button) => {
    button.addEventListener("click", () => markJobDelivered(Number(button.dataset.deliveryDeliver)));
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
    const arrived = Boolean(appointment.arrivedAt);
    const days = getDaysUntil(appointment.appointmentDate);
    const statusClass = arrived ? "arrived" : getAppointmentStatusClass(days);
    const statusLabel = arrived ? "הגיע" : getAppointmentStatusLabel(days);
    const row = document.createElement("tr");
    row.classList.add(`appointment-${statusClass}`);
    if (arrived) row.classList.add("appointment-arrived");

    const phoneHtml = appointment.phoneNumber
      ? `<a href="tel:${escapeHtml(appointment.phoneNumber)}" class="phone-link">${escapeHtml(appointment.phoneNumber)}</a>`
      : "";

    const autoFollowUpBadge = appointment.sourceJobId
      ? ' <small class="auto-followup-badge" title="נוצר אוטומטית מתאריך חזרה של עבודה">🔁 מעקב</small>'
      : '';

    const arriveButtonHtml = arrived
      ? `<button class="row-action" type="button" data-appointment-revert="${appointment.id}">↩ סמן כלא הגיע</button>`
      : `<button class="row-action success-action" type="button" data-appointment-arrive="${appointment.id}">✓ הגיע - פתח עבודה</button>`;

    row.innerHTML = `
      <td><span class="delivery-badge ${statusClass}">${statusLabel}</span></td>
      <td>${formatDate(appointment.appointmentDate)}</td>
      <td>${getHebrewDay(appointment.appointmentDate)}</td>
      <td>${escapeHtml(appointment.appointmentTime || "")}</td>
      <td>${escapeHtml(appointment.customerName)}${autoFollowUpBadge}</td>
      <td>${phoneHtml}</td>
      <td>${appointment.vehiclePlate ? `<button type="button" class="plate-link" data-vehicle-history="${escapeHtml(appointment.vehiclePlate)}">${escapeHtml(appointment.vehiclePlate)}</button>` : ""}</td>
      <td>${escapeHtml(appointment.vehicleModel || "")}</td>
      <td>${escapeHtml(appointment.reason || "")}</td>
      <td class="notes-cell" title="${escapeHtml(appointment.notes || "")}">${escapeHtml(appointment.notes || "")}</td>
      <td>
        <span class="row-actions">
          ${arriveButtonHtml}
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
  els.appointmentsBody.querySelectorAll("[data-appointment-arrive]").forEach((button) => {
    button.addEventListener("click", () => {
      const appointmentId = Number(button.dataset.appointmentArrive);
      const appointment = state.appointments.find((item) => item.id === appointmentId);
      if (!appointment) return;
      switchView("jobs");
      openJobModal(null, appointment);
    });
  });
  els.appointmentsBody.querySelectorAll("[data-appointment-revert]").forEach((button) => {
    button.addEventListener("click", () => revertAppointmentArrival(Number(button.dataset.appointmentRevert)));
  });

  els.appointmentsEmpty.classList.toggle("hidden", filtered.length > 0);
}

function isAppointmentInRange(appointment, range) {
  const arrived = Boolean(appointment.arrivedAt);
  if (range === "arrived") return arrived;
  if (range === "all") return true;
  if (arrived) return false;
  const days = getDaysUntil(appointment.appointmentDate);
  if (days === null) return false;
  switch (range) {
    case "upcoming":
      return days >= 0;
    case "today":
      return days === 0;
    case "tomorrow":
      return days === 1;
    case "week":
      return days >= 0 && days <= 7;
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

async function revertAppointmentArrival(appointmentId) {
  const transaction = state.db.transaction("appointments", "readwrite");
  const store = transaction.objectStore("appointments");
  const existing = await idbRequest(store.get(appointmentId));
  if (!existing) return;
  delete existing.arrivedAt;
  existing.updatedAt = new Date().toISOString();
  store.put(existing);
  await transactionDone(transaction);
  await refreshData();
  renderAppointments();
  showToast(`התור של ${existing.customerName} סומן כלא הגיע`);
}

function renderAnalytics() {
  const { start, end } = getDateRange(state.activeRange);
  const totals = state.jobs.reduce(
    (sum, job) => {
      if (!isDateInRange(job.jobDate, start, end)) return sum;
      // Only realized income/cost/profit counts:
      //   - quotes are non-binding estimates (no money has changed hands)
      //   - undelivered jobs are work-in-progress (customer hasn't paid yet)
      // Both are excluded so the banner reflects actual cash, not promises.
      if (job.isQuote) return sum;
      if (!job.deliveredAt) return sum;
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

function openJobModal(jobId = null, prefillAppointment = null) {
  state.editingJobId = jobId;
  state.appointmentBeingConverted = (!jobId && prefillAppointment) ? prefillAppointment.id : null;
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
  els.taxRate.value = String(state.business?.defaultTaxRate ?? 18);
  els.isQuote.checked = false;

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
    els.jobForm.elements.phoneNumber.value = job.phoneNumber || "";
    els.jobForm.elements.mileage.value = job.mileage ? String(job.mileage) : "";
    els.jobForm.elements.laborPrice.value = String(job.laborPrice || 0);
    els.jobForm.elements.deliveryDate.value = job.deliveryDate || "";
    els.jobForm.elements.notes.value = job.notes || "";
    els.jobForm.elements.followUpDate.value = job.followUpDate || "";
    els.taxEnabled.checked = Boolean(job.taxEnabled);
    els.taxRate.value = String(job.taxRate ?? 18);
    els.isQuote.checked = Boolean(job.isQuote);
    state.draftParts = structuredClone(job.parts || []);
  } else {
    els.jobModalTitle.textContent = "הוספת עבודה";
    if (prefillAppointment) {
      els.jobForm.elements.vehiclePlate.value = prefillAppointment.vehiclePlate || "";
      els.jobForm.elements.vehicleModel.value = prefillAppointment.vehicleModel || "";
      els.jobForm.elements.ownerName.value = prefillAppointment.customerName || "";
      els.jobForm.elements.phoneNumber.value = prefillAppointment.phoneNumber || "";
    }
  }

  renderDraftParts();
  renderPartPicker();
  delete els.jobForm.elements.vehiclePlate.dataset.lastLookup;
  openModal("jobModal");
  requestAnimationFrame(() => els.jobForm.elements.vehiclePlate.focus());

  if (!jobId && prefillAppointment && prefillAppointment.vehiclePlate) {
    autofillVehicleFields(els.jobForm.elements.vehiclePlate, els.jobForm, { fillModel: true, fillYear: true, fillEngine: true });
  }
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
  els.inlinePartTemporary.checked = false;
  updateInlinePartMode();
  requestAnimationFrame(() => els.inlinePartSku.focus());
}

function updateInlinePartMode() {
  const isTemp = els.inlinePartTemporary.checked;
  els.inlinePartTitle.textContent = isTemp ? "חלק זמני לעבודה זו" : "חלק חדש למלאי";
  els.inlinePartSkuLabel.textContent = isTemp ? "מק\"ט חלק (אופציונלי)" : "מק\"ט חלק";
  els.inlinePartQuantityLabel.textContent = isTemp ? "כמות לעבודה" : "כמות במלאי";
  els.saveInlinePartButton.textContent = isTemp ? "הוספה לעבודה" : "שמירה והוספה לעבודה";
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
  els.inlinePartTemporary.checked = false;
  updateInlinePartMode();
}

async function saveInlinePart() {
  clearError(els.inlinePartError);

  const isTemp = els.inlinePartTemporary.checked;
  const sku = els.inlinePartSku.value.trim();
  const name = els.inlinePartName.value.trim();
  const category = els.inlinePartCategory.value || "general";
  const quantity = toOptionalInt(els.inlinePartQuantity.value) ?? 0;
  const garageCost = toMoney(els.inlinePartGarageCost.value);
  const customerPrice = toMoney(els.inlinePartCustomerPrice.value);

  if (!name) {
    showError(els.inlinePartError, "שם חלק הוא שדה חובה");
    return;
  }

  if (!isTemp && !sku) {
    showError(els.inlinePartError, "מק\"ט הוא שדה חובה לחלק קבוע");
    return;
  }

  if (quantity < 1) {
    showError(els.inlinePartError, isTemp ? "כמות לעבודה חייבת להיות לפחות 1" : "כמות במלאי חייבת להיות לפחות 1");
    return;
  }

  if (customerPrice <= 0) {
    showError(els.inlinePartError, "מחיר ללקוח חייב להיות גדול מ-0");
    return;
  }

  if (isTemp) {
    const effectiveSku = sku || `TEMP-${Date.now()}`;
    state.draftParts.push({
      partId: null,
      temporary: true,
      skuSnapshot: effectiveSku,
      nameSnapshot: name,
      categorySnapshot: category,
      quantityUsed: quantity,
      garageCostSnapshot: garageCost,
      customerPriceSnapshot: customerPrice
    });
    renderDraftParts();
    renderPartPicker();
    hideInlinePartPanel();
    showToast(`חלק זמני "${name}" נוסף לעבודה`);
    return;
  }

  const part = {
    sku,
    name,
    category,
    quantity,
    garageCost,
    customerPrice,
    updatedAt: new Date().toISOString()
  };

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
      chip.className = part.temporary ? "part-chip part-chip-temp" : "part-chip";
      const tempBadge = part.temporary ? ' <small class="chip-temp-badge">זמני</small>' : "";
      chip.innerHTML = `
        <span>${escapeHtml(part.nameSnapshot)} × ${part.quantityUsed}${tempBadge}</span>
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

async function syncFollowUpAppointment(jobId, job) {
  if (!jobId) return;
  const tx = state.db.transaction("appointments", "readwrite");
  const store = tx.objectStore("appointments");
  const all = await idbRequest(store.getAll());
  const existing = all.find((a) => a.sourceJobId === jobId);
  const wantsFollowUp = Boolean(job.followUpDate);
  const now = new Date().toISOString();

  if (!wantsFollowUp) {
    if (existing) store.delete(existing.id);
    await transactionDone(tx);
    return;
  }

  const apptData = {
    appointmentDate: job.followUpDate,
    appointmentTime: "",
    customerName: job.ownerName || "",
    phoneNumber: job.phoneNumber || "",
    vehiclePlate: job.vehiclePlate || "",
    vehicleModel: job.vehicleModel || "",
    reason: "ביקור חוזר / מעקב",
    notes: job.notes || "",
    sourceJobId: jobId,
    updatedAt: now
  };

  if (existing) {
    // Preserve arrivedAt if user already marked it (don't undo their action)
    const preserved = { ...existing, ...apptData, id: existing.id };
    if (existing.arrivedAt) preserved.arrivedAt = existing.arrivedAt;
    store.put(preserved);
  } else {
    store.add({ ...apptData, createdAt: now });
  }
  await transactionDone(tx);
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
    phoneNumber: String(form.get("phoneNumber") || "").trim(),
    mileage: toOptionalInt(form.get("mileage")),
    laborPrice: toMoney(form.get("laborPrice")),
    deliveryDate: String(form.get("deliveryDate") || ""),
    notes: String(form.get("notes") || "").trim(),
    followUpDate: String(form.get("followUpDate") || ""),
    parts: structuredClone(state.draftParts),
    taxEnabled: els.taxEnabled.checked,
    taxRate: Number(els.taxRate.value) || 0,
    isQuote: els.isQuote.checked,
    updatedAt: new Date().toISOString()
  };

  if (!job.vehiclePlate) {
    showError(els.jobError, "מספר רכב הוא שדה חובה");
    return;
  }

  const validationError = validateJobParts(job.parts, job.isQuote);
  if (validationError) {
    showError(els.jobError, validationError);
    return;
  }

  try {
    const savedJobId = await saveJobWithInventoryTransaction(job, state.editingJobId);
    await syncFollowUpAppointment(savedJobId, job);
    const convertedAppointmentId = state.appointmentBeingConverted;
    if (convertedAppointmentId) {
      try {
        const transaction = state.db.transaction("appointments", "readwrite");
        const store = transaction.objectStore("appointments");
        const existing = await idbRequest(store.get(convertedAppointmentId));
        if (existing) {
          existing.arrivedAt = new Date().toISOString();
          existing.updatedAt = existing.arrivedAt;
          store.put(existing);
        }
        await transactionDone(transaction);
      } catch (markError) {
        console.warn("Failed to mark linked appointment as arrived:", markError);
      }
      state.appointmentBeingConverted = null;
    }
    await refreshData();
    renderAll();
    closeModal("jobModal");
    showToast(convertedAppointmentId ? "העבודה נשמרה והתור סומן כהגיע" : "העבודה נשמרה והמלאי עודכן");
  } catch (error) {
    console.error(error);
    showError(els.jobError, error.message || "שגיאה בשמירת העבודה");
  }
}

function validateJobParts(parts, isQuote = false) {
  if (isQuote) {
    // For a quote we only sanity-check the line items; no inventory enforcement.
    for (const part of parts || []) {
      if (!part.partId && !part.temporary) return "אחד החלקים בעבודה אינו קיים במלאי";
      if (Number(part.quantityUsed || 0) <= 0) return "כמות חלק חייבת להיות גדולה מ-0";
      if (Number(part.customerPriceSnapshot || 0) <= 0) return `יש לעדכן מחיר ללקוח עבור ${part.nameSnapshot}`;
    }
    return "";
  }

  const requiredByPart = new Map();

  for (const part of parts || []) {
    if (!part.partId && !part.temporary) return "אחד החלקים בעבודה אינו קיים במלאי";
    if (Number(part.quantityUsed || 0) <= 0) return "כמות חלק חייבת להיות גדולה מ-0";
    if (Number(part.customerPriceSnapshot || 0) <= 0) return `יש לעדכן מחיר ללקוח עבור ${part.nameSnapshot}`;
    if (part.partId) {
      requiredByPart.set(part.partId, (requiredByPart.get(part.partId) || 0) + Number(part.quantityUsed || 0));
    }
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

  // Inventory delta logic:
  // - If the existing job WAS already a real (non-quote) job, count its parts as "previously taken" so we restore on edit.
  // - If the existing job WAS a quote, it never decremented inventory → no need to restore.
  // - If the new job is a quote, do NOT take parts from inventory (it's just an estimate).
  const oldCountedAsTaken = existingJob && !existingJob.isQuote;
  const newCountsAsTaken = !job.isQuote;

  if (oldCountedAsTaken) {
    for (const part of existingJob?.parts || []) {
      if (!part.partId) continue;
      deltas.set(part.partId, (deltas.get(part.partId) || 0) - Number(part.quantityUsed || 0));
    }
  }

  if (newCountsAsTaken) {
    for (const part of job.parts || []) {
      if (!part.partId) continue;
      deltas.set(part.partId, (deltas.get(part.partId) || 0) + Number(part.quantityUsed || 0));
    }
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
  let savedJobId = existingJobId || null;
  if (existingJob) {
    jobsStore.put({ ...existingJob, ...job, id: existingJobId, updatedAt: now });
  } else {
    const newJob = { ...job, createdAt: now, updatedAt: now };
    delete newJob.id;
    const addReq = jobsStore.add(newJob);
    addReq.onsuccess = () => { savedJobId = addReq.result; };
  }

  await transactionDone(transaction);
  return savedJobId;
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
  const isQuote = Boolean(job.isQuote);
  const msg = isQuote
    ? "למחוק את הצעת המחיר?"
    : "למחוק את העבודה ולהחזיר את החלקים למלאי?";
  if (!confirm(msg)) return;

  const transaction = state.db.transaction(["jobs", "inventory"], "readwrite");
  const jobsStore = transaction.objectStore("jobs");
  const inventoryStore = transaction.objectStore("inventory");

  // Only restore inventory if this was a real (non-quote) job that had taken parts
  if (!isQuote) {
    for (const jobPart of job.parts || []) {
      if (!jobPart.partId) continue;
      const part = await idbRequest(inventoryStore.get(jobPart.partId));
      if (!part) continue;
      part.quantity = Number(part.quantity || 0) + Number(jobPart.quantityUsed || 0);
      part.updatedAt = new Date().toISOString();
      inventoryStore.put(part);
    }
  }

  jobsStore.delete(jobId);
  await transactionDone(transaction);

  // Also remove any auto-generated follow-up appointment linked to this job
  const apptTx = state.db.transaction("appointments", "readwrite");
  const apptStore = apptTx.objectStore("appointments");
  const allAppts = await idbRequest(apptStore.getAll());
  for (const a of allAppts) {
    if (a.sourceJobId === jobId) apptStore.delete(a.id);
  }
  await transactionDone(apptTx);

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
    return `<span class="tax-badge included" title="${totals.taxRate}% מע&quot;מ על ${formatCurrency(totals.subtotal)}">${formatCurrency(totals.taxAmount)}</span>`;
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
    if (state.specificRangeMonth) {
      const [yearStr, monthStr] = state.specificRangeMonth.split("-");
      const year = Number(yearStr);
      const month = Number(monthStr) - 1;
      const monthStart = new Date(year, month, 1, 0, 0, 0, 0);
      const monthEnd = new Date(year, month + 1, 0, 23, 59, 59, 999);
      return { start: monthStart, end: monthEnd };
    }
    start.setDate(1);
  }

  if (range === "all") {
    return { start: null, end: null };
  }

  if (range === "specific") {
    if (!state.specificRangeDate) return { start: null, end: null };
    const specificStart = new Date(`${state.specificRangeDate}T00:00:00`);
    const specificEnd = new Date(`${state.specificRangeDate}T23:59:59.999`);
    return { start: specificStart, end: specificEnd };
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
    version: 4,
    jobs: state.jobs,
    inventory: state.inventory,
    customCategories: state.customCategories,
    appointments: state.appointments,
    business: state.business
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
    "טלפון",
    "ק\"מ",
    "חלקים",
    "מחיר חלקים למוסך",
    "מחיר חלקים ללקוח",
    "מחיר עבודה",
    "סה\"כ לפני מע\"מ",
    "אחוז מע\"מ",
    "מע\"מ",
    "סה\"כ לתשלום",
    "רווח",
    "סטטוס",
    "תאריך מסירה מתוכנן",
    "תאריך מסירה בפועל",
    "הערות",
    "מועד חזרה מומלץ"
  ];

  const rows = state.jobs.map((job) => {
    const totals = getJobTotals(job);
    // Status reflects the same eligibility logic the analytics banner uses,
    // so anyone analysing the CSV in Excel can filter "נמסר" rows to match
    // the realised-revenue totals shown in the app.
    let status;
    if (job.rejectedAt) status = "הצעה נדחתה";
    else if (job.isQuote) status = "הצעת מחיר";
    else if (job.deliveredAt) status = "נמסר";
    else status = "פתוח";
    return [
      job.jobDate,
      getHebrewDay(job.jobDate),
      job.vehiclePlate,
      job.vehicleModel,
      job.vehicleYear,
      job.engineDisplacement,
      job.ownerName,
      job.phoneNumber || "",
      job.mileage || "",
      getPartsText(job),
      totals.partsCost,
      totals.partsPrice,
      job.laborPrice,
      totals.subtotal,
      totals.taxEnabled ? totals.taxRate : 0,
      totals.taxAmount,
      totals.total,
      totals.profit,
      status,
      job.deliveryDate || "",
      job.deliveredAt ? toIsoDate(new Date(job.deliveredAt)) : "",
      job.notes || "",
      job.followUpDate || ""
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
      Array.isArray(payload.appointments) ? payload.appointments : [],
      payload.business || null
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

async function replaceAllData(jobs, inventory, customCategories = [], appointments = [], business = null) {
  const transaction = state.db.transaction(["jobs", "inventory", "categories", "appointments", "settings"], "readwrite");
  const jobsStore = transaction.objectStore("jobs");
  const inventoryStore = transaction.objectStore("inventory");
  const categoriesStore = transaction.objectStore("categories");
  const appointmentsStore = transaction.objectStore("appointments");
  const settingsStore = transaction.objectStore("settings");

  jobsStore.clear();
  inventoryStore.clear();
  categoriesStore.clear();
  appointmentsStore.clear();
  if (business && typeof business === "object") {
    settingsStore.put({ ...DEFAULT_BUSINESS, ...business, id: "business" });
  }

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
    if (appointment.arrivedAt) record.arrivedAt = String(appointment.arrivedAt);
    if (appointment.sourceJobId !== undefined && appointment.sourceJobId !== null) {
      record.sourceJobId = Number(appointment.sourceJobId);
    }
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
      phoneNumber: String(job.phoneNumber || ""),
      mileage: toOptionalInt(job.mileage),
      laborPrice: toMoney(job.laborPrice),
      deliveryDate: job.deliveryDate || "",
      notes: String(job.notes || ""),
      followUpDate: job.followUpDate || "",
      parts: Array.isArray(job.parts) ? job.parts : [],
      taxEnabled: Boolean(job.taxEnabled),
      taxRate: Number(job.taxRate) || 0,
      isQuote: Boolean(job.isQuote),
      createdAt: job.createdAt || new Date().toISOString(),
      updatedAt: job.updatedAt || new Date().toISOString()
    };
    if (job.deliveredAt) record.deliveredAt = String(job.deliveredAt);
    if (job.rejectedAt) record.rejectedAt = String(job.rejectedAt);
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
  closeModal("invoiceModal");
}

function openVehicleHistory(plate) {
  state.activeVehiclePlate = String(plate || "").trim();
  els.vehicleHistorySearch.value = state.activeVehiclePlate;
  switchView("vehicleHistory");
  renderVehicleHistory();
}

function renderVehicleHistory() {
  if (!els.vehicleHistorySearch) return;
  const query = els.vehicleHistorySearch.value;
  const queryKey = normalizePlate(query);
  const queryNormalized = normalizeSearch(query);
  const activeKey = normalizePlate(state.activeVehiclePlate);

  // Build a unique list of plates from jobs + appointments
  const plateMap = new Map();
  for (const j of state.jobs) {
    const k = normalizePlate(j.vehiclePlate);
    if (!k) continue;
    const e = plateMap.get(k) || { plate: j.vehiclePlate, owner: "", phone: "", model: "", year: "", visits: 0, lastDate: "" };
    e.visits += 1;
    if (j.ownerName && !e.owner) e.owner = j.ownerName;
    if (j.phoneNumber && !e.phone) e.phone = j.phoneNumber;
    if (j.vehicleModel && !e.model) e.model = j.vehicleModel;
    if (j.vehicleYear && !e.year) e.year = String(j.vehicleYear);
    if (j.jobDate > (e.lastDate || "")) e.lastDate = j.jobDate;
    plateMap.set(k, e);
  }
  for (const a of state.appointments) {
    const k = normalizePlate(a.vehiclePlate);
    if (!k || plateMap.has(k)) continue;
    plateMap.set(k, {
      plate: a.vehiclePlate,
      owner: a.customerName || "",
      phone: a.phoneNumber || "",
      model: a.vehicleModel || "",
      year: "",
      visits: 0,
      lastDate: ""
    });
  }
  const allPlates = Array.from(plateMap.values()).sort((a, b) => (b.lastDate || "").localeCompare(a.lastDate || ""));

  // Show suggestions: matching the query (or recent if empty)
  let suggestions;
  if (queryNormalized) {
    suggestions = allPlates.filter((p) => {
      const hay = normalizeSearch([p.plate, p.owner, p.phone, p.model].join(" "));
      return hay.includes(queryNormalized);
    });
  } else {
    suggestions = allPlates.slice(0, 8);
  }

  els.vehicleHistorySuggestions.innerHTML = "";
  if (suggestions.length === 0) {
    els.vehicleHistorySuggestions.innerHTML = '<div class="empty-inline">לא נמצאו רכבים</div>';
  } else {
    suggestions.slice(0, 24).forEach((p) => {
      const isActive = normalizePlate(p.plate) === activeKey;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "vh-chip" + (isActive ? " active" : "");
      chip.innerHTML = `
        <strong>${escapeHtml(p.plate)}</strong>
        <span>${escapeHtml(p.owner || "—")}${p.model ? " · " + escapeHtml(p.model) : ""}</span>
        <small>${p.visits ? `${p.visits} ביקורים` : "תור בלבד"}${p.lastDate ? ` · ${formatDate(p.lastDate)}` : ""}</small>
      `;
      chip.addEventListener("click", () => {
        state.activeVehiclePlate = p.plate;
        els.vehicleHistorySearch.value = p.plate;
        renderVehicleHistory();
      });
      els.vehicleHistorySuggestions.appendChild(chip);
    });
  }

  // Detail panel
  if (!activeKey) {
    els.vehicleHistoryDetail.classList.add("hidden");
    els.vehicleHistoryEmpty.classList.toggle("hidden", queryNormalized.length > 0);
    return;
  }

  els.vehicleHistoryEmpty.classList.add("hidden");
  els.vehicleHistoryDetail.classList.remove("hidden");

  const matchingJobs = state.jobs.filter((j) => normalizePlate(j.vehiclePlate) === activeKey);
  const matchingAppts = state.appointments.filter((a) => normalizePlate(a.vehiclePlate) === activeKey);

  if (matchingJobs.length === 0 && matchingAppts.length === 0) {
    els.vehicleHistorySummary.innerHTML = `<div class="empty-inline">לא נמצאו עבודות או תורים עבור ${escapeHtml(state.activeVehiclePlate)}</div>`;
    els.vehicleHistoryList.innerHTML = "";
    return;
  }

  // Money totals only count jobs that have actually been paid for —
  // exclude quotes (non-binding estimates) and undelivered jobs (open work
  // where the customer has not paid yet). Visit count below still shows all
  // jobs so the history list and the count stay consistent.
  const realizedJobs = matchingJobs.filter((j) => !j.isQuote && j.deliveredAt);
  const totalSpend = realizedJobs.reduce((s, j) => s + getJobTotals(j).total, 0);
  const totalProfit = realizedJobs.reduce((s, j) => s + getJobTotals(j).profit, 0);
  const lastJob = matchingJobs[0];
  // Last recorded mileage = most recent job that has a mileage value
  const lastMileage = matchingJobs.find((j) => j.mileage)?.mileage || null;
  // Find any future follow-up date in this car's history
  const today = toIsoDate(new Date());
  const nextFollowUp = matchingJobs
    .map((j) => j.followUpDate)
    .filter((d) => d && d >= today)
    .sort()[0] || null;
  const owner = (matchingJobs.find((j) => j.ownerName) || matchingAppts.find((a) => a.customerName) || {})?.ownerName
              || (matchingAppts.find((a) => a.customerName) || {})?.customerName || "";
  const phone = (matchingJobs.find((j) => j.phoneNumber) || {})?.phoneNumber
              || (matchingAppts.find((a) => a.phoneNumber) || {})?.phoneNumber || "";
  const model = (matchingJobs.find((j) => j.vehicleModel) || {})?.vehicleModel
              || (matchingAppts.find((a) => a.vehicleModel) || {})?.vehicleModel || "";
  const year = (matchingJobs.find((j) => j.vehicleYear) || {})?.vehicleYear || "";
  const engineCC = (matchingJobs.find((j) => j.engineDisplacement) || {})?.engineDisplacement || "";

  els.vehicleHistorySummary.innerHTML = `
    <div class="vh-hero">
      <div class="il-plate" aria-label="מספר רישוי">
        <div class="il-plate-il">IL</div>
        <div class="il-plate-number">${escapeHtml(state.activeVehiclePlate)}</div>
      </div>
      <div class="vh-hero-info">
        <div class="vh-hero-vehicle">${escapeHtml(model || "רכב")}${year ? " · " + year : ""}${engineCC ? ` · ${engineCC} סמ"ק` : ""}</div>
        <div class="vh-hero-owner">
          <span class="vh-hero-owner-name">${escapeHtml(owner || "ללא בעלים רשום")}</span>
          ${phone ? `<a href="tel:${escapeHtml(phone)}" class="vh-hero-phone">📞 ${escapeHtml(phone)}</a>` : ""}
        </div>
      </div>
    </div>

    <div class="vh-stat-strip">
      <div class="vh-stat">
        <div class="vh-stat-value">${matchingJobs.length}</div>
        <div class="vh-stat-label">סה"כ ביקורים</div>
      </div>
      <div class="vh-stat">
        <div class="vh-stat-value">${formatCurrency(totalSpend)}</div>
        <div class="vh-stat-label">סה"כ הכנסה</div>
      </div>
      <div class="vh-stat">
        <div class="vh-stat-value vh-stat-profit">${formatCurrency(totalProfit)}</div>
        <div class="vh-stat-label">רווח מצטבר</div>
      </div>
      <div class="vh-stat">
        <div class="vh-stat-value">${lastJob ? formatDate(lastJob.jobDate) : "—"}</div>
        <div class="vh-stat-label">ביקור אחרון</div>
      </div>
      <div class="vh-stat">
        <div class="vh-stat-value">${lastMileage ? lastMileage.toLocaleString("he-IL") : "—"}</div>
        <div class="vh-stat-label">ק"מ אחרון</div>
      </div>
      ${nextFollowUp ? `<div class="vh-stat vh-stat-followup">
        <div class="vh-stat-value">${formatDate(nextFollowUp)}</div>
        <div class="vh-stat-label">חזרה מתוכננת</div>
      </div>` : ""}
    </div>
    ${matchingAppts.length > 0 ? `<div class="vh-appointments-summary">${matchingAppts.length} תורים רשומים</div>` : ""}
  `;

  if (matchingJobs.length === 0) {
    els.vehicleHistoryList.innerHTML = '<div class="empty-inline">אין עבודות (רק תורים) — לחץ "✓ הגיע" במסך תורים כדי לפתוח עבודה חדשה</div>';
    return;
  }

  els.vehicleHistoryList.innerHTML = "";
  matchingJobs.forEach((job) => {
    const totals = getJobTotals(job);
    const isDelivered = Boolean(job.deliveredAt);
    const isCheckOnly = (!job.parts || job.parts.length === 0) && Number(job.laborPrice || 0) === 0;
    const statusBadge = isCheckOnly
      ? '<span class="tax-badge later">בדיקה בלבד</span>'
      : isDelivered
      ? '<span class="tax-badge included">נמסר</span>'
      : '<span class="tax-badge excluded">פתוח</span>';
    const partsText = getPartsText(job);
    const bodyLines = [];
    if (partsText) bodyLines.push(escapeHtml(partsText));
    if (Number(job.laborPrice) > 0) bodyLines.push(`עבודה: ${formatCurrency(job.laborPrice)}`);
    if (job.mileage) bodyLines.push(`ק"מ: ${Number(job.mileage).toLocaleString("he-IL")}`);
    if (isCheckOnly && bodyLines.length === 0) bodyLines.push("ביקור ללא חיוב");

    const card = document.createElement("div");
    card.className = "vh-visit-card" + (isDelivered ? " is-delivered" : "") + (isCheckOnly ? " is-check-only" : "");
    card.innerHTML = `
      <div class="vh-visit-head">
        <div class="vh-visit-date">${formatDate(job.jobDate)}</div>
        ${statusBadge}
        <strong class="vh-visit-total">${formatCurrency(totals.total)}</strong>
      </div>
      <div class="vh-visit-body">${bodyLines.join(" · ")}</div>
      ${job.notes ? `<div class="vh-visit-notes">📝 ${escapeHtml(job.notes)}</div>` : ""}
      ${job.followUpDate ? `<div class="vh-visit-followup">📅 חזרה מתוכננת: ${formatDate(job.followUpDate)}</div>` : ""}
      <div class="vh-visit-actions">
        <button class="row-action" type="button" data-vh-open-job="${job.id}">פתח לעריכה</button>
        <button class="row-action" type="button" data-vh-invoice="${job.id}">🧾 חשבונית</button>
      </div>
    `;
    els.vehicleHistoryList.appendChild(card);
  });

  els.vehicleHistoryList.querySelectorAll("[data-vh-open-job]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.vhOpenJob);
      switchView("jobs");
      openJobModal(id);
    });
  });
  els.vehicleHistoryList.querySelectorAll("[data-vh-invoice]").forEach((btn) => {
    btn.addEventListener("click", () => openInvoiceForJob(Number(btn.dataset.vhInvoice)));
  });
}

function openInvoiceForJob(jobId) {
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) return;
  if (!state.business.name || !state.business.taxId) {
    if (!confirm("פרטי העסק לא הוגדרו (שם, מספר עוסק). החשבונית תופק אך לא תעמוד בדרישות חוק. להמשיך?")) return;
  }
  els.invoiceSheet.innerHTML = renderInvoiceHtml(job);
  els.invoiceSheet.dataset.invoiceTitle = buildInvoiceFilename(job);
  openModal("invoiceModal");
}

function buildInvoiceFilename(job) {
  const number = String(job.id).padStart(6, "0");
  const plate = String(job.vehiclePlate || "").replace(/[^\w֐-׿-]/g, "_");
  const date = job.jobDate || toIsoDate(new Date());
  const prefix = job.isQuote ? "הצעת_מחיר" : "חשבונית";
  return `${prefix}_${number}${plate ? "_" + plate : ""}_${date}`;
}

function printInvoiceWithFilename() {
  // Chromium derives the Save-as-PDF filename from the printing document's <title>.
  // Mutating document.title on the main window then calling window.print() is racy:
  // WebView2 reads the title at an unpredictable moment relative to the rAF/microtask
  // queue, and some Chromium versions strip non-ASCII chars from the suggestion.
  //
  // The robust pattern is to print from a same-origin iframe that has its own <title>.
  // The iframe's document is fully under our control, the print dialog reads its title
  // synchronously when iframe.contentWindow.print() is invoked, and there is no race
  // with the main window's title or any other DOM mutation.
  const rawTitle = els.invoiceSheet.dataset.invoiceTitle || "חשבונית";
  // Strip HTML-significant chars so the value is safe inside <title>...</title>.
  const safeTitle = String(rawTitle).replace(/[<>&"]/g, "");
  const sheetHtml = els.invoiceSheet.innerHTML;

  // If user clicks the print button twice quickly, drop any in-flight iframe first.
  const previous = document.getElementById("__topgear_print_frame__");
  if (previous && previous.parentNode) previous.parentNode.removeChild(previous);

  const iframe = document.createElement("iframe");
  iframe.id = "__topgear_print_frame__";
  iframe.setAttribute("aria-hidden", "true");
  // Keep it in-flow but invisible. Tiny on-screen size avoids layout shifts.
  iframe.style.cssText =
    "position:fixed;left:0;top:0;width:0;height:0;border:0;opacity:0;pointer-events:none;";

  // srcdoc resolves relative URLs (styles.css) against the parent document, unlike
  // document.write() which would leave the iframe at about:blank and break the link.
  iframe.srcdoc = `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
<meta charset="utf-8">
<title>${safeTitle}</title>
<link rel="stylesheet" href="styles.css">
<style>
  /* The main stylesheet's @media print rule hides every element except
     #invoiceModal. That rule assumes we are printing from the main document,
     so inside this isolated iframe (which has no #invoiceModal wrapper)
     it would hide the entire invoice. Re-show everything explicitly. */
  @media print {
    body * { visibility: visible !important; }
  }
  html, body { margin: 0; padding: 0; background: #fff; }
  @page { size: A4; margin: 0; }
  .inv-page { padding: 18mm 14mm; }
</style>
</head>
<body>${sheetHtml}</body>
</html>`;

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
  };

  iframe.addEventListener(
    "load",
    () => {
      try {
        const win = iframe.contentWindow;
        // Hook afterprint on the iframe window so we tear down only after the user
        // has finished interacting with the Save-as-PDF dialog. The 30s safety
        // timeout below covers the case where afterprint never fires.
        win.addEventListener("afterprint", cleanup, { once: true });
        // WebView2/Tauri (and some Chromium builds) derive the Save-as-PDF
        // filename from the TOP-LEVEL window's document.title even when print
        // is invoked from a child frame. So we set the main window's title
        // synchronously right before calling print(). The window-level
        // afterprint listener registered at boot time will restore the
        // original "TopGear - ניהול מוסך" title once the dialog closes.
        document.title = safeTitle;
        win.focus();
        win.print();
      } catch (err) {
        // Defensive fallback: if the iframe path is blocked by the runtime
        // (very unlikely in Tauri WebView2), still try the main window with a
        // title swap so the user is never left without a working print.
        try {
          document.title = safeTitle;
          window.print();
        } catch (_) {
          /* swallow — surface nothing useful to the end user */
        }
        cleanup();
      }
    },
    { once: true }
  );

  // Safety net in case the print dialog is dismissed without firing afterprint.
  setTimeout(cleanup, 30000);

  document.body.appendChild(iframe);
}

function renderInvoiceHtml(job) {
  const totals = getJobTotals(job);
  const b = state.business;
  const isQuote = Boolean(job.isQuote);
  const invoiceNumber = String(job.id).padStart(6, "0");
  const issuedAt = formatDate(toIsoDate(new Date()));
  const jobDate = formatDate(job.jobDate);
  let title;
  if (isQuote) {
    title = "כרטיס עבודה / הצעת מחיר";
  } else {
    title = totals.taxEnabled ? "חשבונית מס" : "חשבונית";
  }
  const numberLabel = isQuote ? "מספר הצעה" : "מספר חשבונית";
  const dateLabel = isQuote ? "תאריך הצעה" : "תאריך הפקה";
  const workLabel = isQuote ? "תאריך הביקור" : "תאריך עבודה";

  // Job context block: mileage / notes / follow-up date. Only render when at
  // least one field has data so regular invoices for simple jobs stay tidy.
  const hasJobMeta = Boolean(job.mileage || (job.notes && job.notes.trim()) || job.followUpDate);
  const jobMetaSection = hasJobMeta
    ? `
      <section class="inv-job-meta-section">
        <div class="inv-section-label">הערות ומעקב</div>
        ${job.mileage ? `<div class="inv-job-meta-line"><span class="inv-job-meta-key">ק"מ ברכב:</span> <strong>${Number(job.mileage).toLocaleString("he-IL")}</strong></div>` : ""}
        ${job.notes && job.notes.trim() ? `<div class="inv-job-meta-line inv-job-meta-notes"><span class="inv-job-meta-key">הערות הביקור:</span> ${escapeHtml(job.notes)}</div>` : ""}
        ${job.followUpDate ? `<div class="inv-job-meta-line"><span class="inv-job-meta-key">מועד מומלץ לחזרה:</span> <strong>${escapeHtml(formatDate(job.followUpDate))}</strong></div>` : ""}
      </section>
    `
    : "";

  const lineItems = (job.parts || []).map((p, idx) => {
    const lineTotal = Number(p.customerPriceSnapshot || 0) * Number(p.quantityUsed || 0);
    return `
      <tr>
        <td class="col-idx">${idx + 1}</td>
        <td class="col-desc">${escapeHtml(p.nameSnapshot)}${p.skuSnapshot ? ` <small class="sku">${escapeHtml(p.skuSnapshot)}</small>` : ''}${p.temporary ? ' <small class="temp-mark">(זמני)</small>' : ''}</td>
        <td class="col-qty">${p.quantityUsed}</td>
        <td class="col-price">${formatInvoiceCurrency(p.customerPriceSnapshot)}</td>
        <td class="col-total">${formatInvoiceCurrency(lineTotal)}</td>
      </tr>
    `;
  }).join("");

  const laborRow = Number(job.laborPrice) > 0 ? `
    <tr>
      <td class="col-idx">${(job.parts?.length || 0) + 1}</td>
      <td class="col-desc">עבודה / שירות</td>
      <td class="col-qty">1</td>
      <td class="col-price">${formatInvoiceCurrency(job.laborPrice)}</td>
      <td class="col-total">${formatInvoiceCurrency(job.laborPrice)}</td>
    </tr>
  ` : "";

  return `
    <div class="inv-page">
      <header class="inv-top">
        <div class="inv-meta">
          <div class="inv-meta-row"><span>${numberLabel}</span><strong>${invoiceNumber}</strong></div>
          <div class="inv-meta-row"><span>${dateLabel}</span><strong>${issuedAt}</strong></div>
          <div class="inv-meta-row"><span>${workLabel}</span><strong>${jobDate}</strong></div>
        </div>

        <div class="inv-title-block">
          <h1 class="inv-title">${title}</h1>
          <div class="inv-rule"></div>
        </div>

        <div class="inv-business">
          <div class="inv-business-name">${escapeHtml(b.name || "TopGear")}</div>
          ${b.taxId ? `<div class="inv-business-id">עוסק מורשה: ${escapeHtml(b.taxId)}</div>` : ""}
          ${b.licenseNumber ? `<div class="inv-business-id">מספר רישוי: ${escapeHtml(b.licenseNumber)}</div>` : ""}
          ${b.address ? `<div class="inv-business-line">${escapeHtml(b.address)}</div>` : ""}
          ${b.phone ? `<div class="inv-business-line">טלפון: ${escapeHtml(b.phone)}</div>` : ""}
        </div>
      </header>

      <section class="inv-customer-section">
        <div class="inv-section-label">לכבוד</div>
        <div class="inv-customer-name">${escapeHtml(job.ownerName || "—")}</div>
        ${job.phoneNumber ? `<div class="inv-customer-line">טלפון: ${escapeHtml(job.phoneNumber)}</div>` : ""}
        <div class="inv-customer-line">
          רכב: <strong>${escapeHtml(job.vehiclePlate || "")}</strong>${job.vehicleModel ? " · " + escapeHtml(job.vehicleModel) : ""}${job.vehicleYear ? " · שנת ייצור " + job.vehicleYear : ""}${job.engineDisplacement ? ` · ${job.engineDisplacement} סמ"ק` : ""}
        </div>
      </section>

      ${jobMetaSection}

      <table class="inv-items">
        <thead>
          <tr>
            <th class="col-idx">#</th>
            <th class="col-desc">תיאור</th>
            <th class="col-qty">כמות</th>
            <th class="col-price">מחיר יחידה</th>
            <th class="col-total">סה"כ</th>
          </tr>
        </thead>
        <tbody>
          ${lineItems}
          ${laborRow}
        </tbody>
      </table>

      <section class="inv-totals-section">
        <div class="inv-notes">
          <div class="inv-section-label">${isQuote ? "תנאים" : "הערות"}</div>
          ${isQuote
            ? `<div class="inv-notes-line">הצעה זו תקפה ל-14 יום מתאריך ההפקה.</div>
               <div class="inv-notes-line inv-notes-small">המחירים אינם מחייבים עד לאישור הלקוח. עם האישור תופק חשבונית מס.</div>`
            : `<div class="inv-notes-line">תודה על העסקים!</div>`
          }
          ${totals.taxEnabled ? `<div class="inv-notes-line inv-notes-small">כולל מע"מ בשיעור ${totals.taxRate}%</div>` : '<div class="inv-notes-line inv-notes-small">ללא מע"מ</div>'}
        </div>

        <div class="inv-totals">
          <div class="inv-totals-row"><span>סה"כ לפני מע"מ</span><strong>${formatInvoiceCurrency(totals.subtotal)}</strong></div>
          ${totals.taxEnabled ? `<div class="inv-totals-row"><span>מע"מ (${totals.taxRate}%)</span><strong>${formatInvoiceCurrency(totals.taxAmount)}</strong></div>` : ""}
          <div class="inv-totals-row grand"><span>סה"כ לתשלום</span><strong>${formatInvoiceCurrency(totals.total)}</strong></div>
        </div>
      </section>

      <footer class="inv-footer">
        <div class="inv-signatures">
          <div class="inv-signature">
            <div class="inv-signature-line"></div>
            <div class="inv-signature-label">${isQuote ? "חתימת אישור לקוח" : "חתימת הלקוח"}</div>
          </div>
          <div class="inv-signature">
            <div class="inv-signature-line"></div>
            <div class="inv-signature-label">חתימת בעל העסק / חותמת</div>
          </div>
        </div>
        <div class="inv-footer-fine">המסמך הופק באמצעות TopGear · ${new Date().toLocaleString("he-IL")}</div>
      </footer>
    </div>
  `;
}

function formatInvoiceCurrency(value) {
  // Standard Israeli invoice format: "1,234.00 ₪"
  const n = Number(value) || 0;
  return n.toLocaleString("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ₪";
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
