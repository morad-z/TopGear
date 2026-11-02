"""Independent, synthetic QA probes. No installed/customer browser profile is used.

Run: python tests/qa-edge-cases.py
The output records observed behavior, including known defects, for release review.
"""

import importlib.util
import json
from http.server import ThreadingHTTPServer
from pathlib import Path
import sys
import threading
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("ui_suite", Path(__file__).with_name("ui-improvements.py"))
suite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(suite)


def check_history_preservation(browser, base):
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    context.route("**/*", lambda route: route.continue_() if urlparse(route.request.url).hostname == "127.0.0.1" else route.abort())
    page = context.new_page()
    suite.loaded(page, f"{base}/baseline/")
    page.evaluate("""async () => {
      const tx=state.db.transaction(['jobs','inventory','categories','appointments','settings','expenses'],'readwrite');
      tx.objectStore('inventory').put({id:51,sku:'HISTORY',name:'Current part price',category:'custom_history',quantity:7,garageCost:90,customerPrice:190,createdAt:'2020-01-01T00:00:00.000Z',updatedAt:'2026-11-01T00:00:00.000Z'});
      tx.objectStore('categories').put({id:'custom_history',label:'History category',custom:true,createdAt:'2020-01-01T00:00:00.000Z'});
      const parts=[{partId:51,skuSnapshot:'OLD-SKU',nameSnapshot:'Original historical description',categorySnapshot:'general',quantityUsed:2,garageCostSnapshot:5.25,customerPriceSnapshot:9.75}];
      tx.objectStore('jobs').put({id:41,jobDate:'2020-01-02',vehiclePlate:'QA-HISTORY',vehicleModel:'Historic model',vehicleYear:1998,engineDisplacement:1500,ownerName:'Historic owner',phoneNumber:'0000000000',mileage:123456,laborPrice:123.45,deliveryDate:'2020-01-05',followUpDate:'2020-02-02',notes:'Old work',parts,taxEnabled:true,taxRate:17.5,isQuote:false,deliveredAt:'2020-01-05T12:00:00.000Z',createdAt:'2020-01-02T00:00:00.000Z',updatedAt:'2020-01-05T12:00:00.000Z'});
      tx.objectStore('jobs').put({id:42,jobDate:'2020-01-03',vehiclePlate:'QA-LEGACY',laborPrice:10,parts:[{partId:999,skuSnapshot:'DELETED',nameSnapshot:'Deleted inventory history',quantityUsed:1,garageCostSnapshot:2.5,customerPriceSnapshot:6.75}]});
      tx.objectStore('jobs').put({id:43,jobDate:'2020-01-04',vehiclePlate:'QA-QUOTE',laborPrice:25,taxEnabled:false,taxRate:18,isQuote:true,rejectedAt:'2020-01-05T00:00:00.000Z',parts:[{partId:null,temporary:true,skuSnapshot:'TEMP-HISTORICAL',nameSnapshot:'Temporary historical part',categorySnapshot:'general',quantityUsed:3,garageCostSnapshot:1.11,customerPriceSnapshot:2.22}]});
      tx.objectStore('appointments').put({id:61,appointmentDate:'2020-02-02',appointmentTime:'09:30',customerName:'Historic owner',phoneNumber:'0000000000',vehiclePlate:'QA-HISTORY',vehicleModel:'Historic model',sourceJobId:41,arrivedAt:'2020-02-02T09:30:00.000Z',reason:'Historic appointment',notes:'Retain flags',createdAt:'2020-01-02T00:00:00.000Z'});
      tx.objectStore('appointments').put({id:62,appointmentDate:'2020-02-03',customerName:'No show fixture',phoneNumber:'0000000000',noShowAt:'2020-02-03T10:00:00.000Z'});
      tx.objectStore('settings').put({id:'business',name:'Historic garage',taxId:'000000000',licenseNumber:'QA',address:'Fixture address',phone:'0000000000',defaultTaxRate:18});
      tx.objectStore('expenses').put({id:71,date:'2020-01-01',category:'rent',description:'Historic expense',amount:15.75,createdAt:'2020-01-01T00:00:00.000Z',updatedAt:'2020-01-02T00:00:00.000Z'});
      await transactionDone(tx); await refreshData(); renderAll();
    }""")
    before = suite.snapshot(page)
    totals = page.evaluate("state.jobs.map(job=>({id:job.id,...getJobTotals(job)}))")
    suite.loaded(page, f"{base}/current/")
    assert suite.snapshot(page) == before
    assert page.evaluate("state.jobs.map(job=>({id:job.id,...getJobTotals(job)}))") == totals
    inspection = page.evaluate("inspectBackup({app:'TopGear',version:5,jobs:state.jobs,inventory:state.inventory,customCategories:state.customCategories,appointments:state.appointments,business:state.business,expenses:state.expenses})")
    assert inspection["valid"] is True
    suite.loaded(page, f"{base}/baseline/")
    assert suite.snapshot(page) == before
    assert page.evaluate("state.jobs.map(job=>({id:job.id,...getJobTotals(job)}))") == totals
    context.close()
    return {"allSixStoresExact": True, "historicalSnapshotsExact": True, "financialTotals": totals, "currentBackupValid": inspection["valid"]}


def main():
    observations = {}
    server = ThreadingHTTPServer(("127.0.0.1", 0), suite.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for version in ["baseline", "current"]:
                context = browser.new_context(viewport={"width": 1440, "height": 1000})
                context.route("**/*", lambda route: route.continue_() if urlparse(route.request.url).hostname == "127.0.0.1" else route.abort())
                page = context.new_page()
                suite.loaded(page, f"{base}/{version}/")

                # A real primary job/inventory transaction commits before the
                # secondary appointment step fails. Retry must not create a job twice.
                observations[f"{version}_postcommit_job_retry"] = page.evaluate("""async () => {
                  const tx=state.db.transaction('inventory','readwrite');
                  tx.objectStore('inventory').put({id:1,sku:'QA-PART',name:'QA part',category:'general',quantity:10,garageCost:10,customerPrice:20});
                  await transactionDone(tx); await refreshData(); renderAll();
                  openJobModal(); els.jobForm.elements.vehiclePlate.value='QA-RETRY';
                  state.draftParts=[{partId:1,skuSnapshot:'QA-PART',nameSnapshot:'QA part',categorySnapshot:'general',quantityUsed:1,garageCostSnapshot:10,customerPriceSnapshot:20}];
                  const original=syncFollowUpAppointment;
                  syncFollowUpAppointment=async()=>{throw new Error('QA secondary appointment failure')};
                  const event={preventDefault(){}};
                  await saveJobFromForm(event);
                  const afterFailure={jobs:(await getAll('jobs')).length,quantity:(await getAll('inventory'))[0].quantity,editingJobId:state.editingJobId,error:els.jobError.textContent};
                  syncFollowUpAppointment=original;
                  await saveJobFromForm(event);
                  return {afterFailure,afterRetry:{jobs:(await getAll('jobs')).length,quantity:(await getAll('inventory'))[0].quantity}};
                }""")
                if version == "baseline":
                    assert observations[f"{version}_postcommit_job_retry"]["afterRetry"]["jobs"] == 2

                if version == "current":
                    observations["current_settings_navigation_while_pending"] = page.evaluate("""async () => {
                      switchView('backup'); els.businessSettingsForm.elements.name.value='QA pending business';
                      const original=transactionDone;
                      let release;
                      transactionDone=async tx=>{const completed=original(tx); await new Promise(resolve=>release=resolve); return completed;};
                      els.businessSettingsForm.requestSubmit();
                      const originalConfirm=window.confirm;
                      window.confirm=()=>true;
                      switchView('jobs');
                      const pending=Boolean(els.businessSettingsForm.getAttribute('aria-busy'));
                      const viewDuringSave=state.activeView;
                      release(); await new Promise(resolve=>setTimeout(resolve,30));
                      transactionDone=original; window.confirm=originalConfirm;
                      switchView('backup');
                      return {pending,viewDuringSave,stored:(await getAll('settings'))[0].name,inMemory:state.business.name,displayed:els.businessSettingsForm.elements.name.value,dirty:hasUnsavedChanges()};
                    }""")

                    # Post-commit refresh failure on new expense, followed by retry.
                    observations["current_postcommit_expense_retry"] = page.evaluate("""async () => {
                      openExpenseModal(); els.expenseForm.elements.description.value='QA retry expense'; els.expenseForm.elements.amount.value='19.50';
                      const original=refreshData;
                      refreshData=async()=>{throw new Error('QA refresh failure')};
                      await runFormSave({preventDefault(){}},els.expenseForm,saveExpenseFromForm);
                      const afterFailure=(await getAll('expenses')).length;
                      refreshData=original;
                      await runFormSave({preventDefault(){}},els.expenseForm,saveExpenseFromForm);
                      return {afterFailure,afterRetry:(await getAll('expenses')).length};
                    }""")

                    observations["current_postcommit_appointment_retry"] = page.evaluate("""async () => {
                      openAppointmentModal(); els.appointmentForm.elements.customerName.value='QA retry appointment'; els.appointmentForm.elements.phoneNumber.value='0000000000';
                      const original=refreshData;
                      refreshData=async()=>{throw new Error('QA refresh failure')};
                      await runFormSave({preventDefault(){}},els.appointmentForm,saveAppointmentFromForm);
                      const afterFailure=(await getAll('appointments')).filter(item=>item.customerName==='QA retry appointment').length;
                      refreshData=original;
                      await runFormSave({preventDefault(){}},els.appointmentForm,saveAppointmentFromForm);
                      return {afterFailure,afterRetry:(await getAll('appointments')).filter(item=>item.customerName==='QA retry appointment').length};
                    }""")

                    observations["current_postcommit_part_retry"] = page.evaluate("""async () => {
                      openPartModal();
                      for(const [name,value] of Object.entries({sku:'QA-RETRY-PART',name:'QA retry part',quantity:'3',garageCost:'10',customerPrice:'20'})) els.partForm.elements[name].value=value;
                      const original=refreshData;
                      refreshData=async()=>{throw new Error('QA refresh failure')};
                      await runFormSave({preventDefault(){}},els.partForm,savePartFromForm);
                      const afterFailure=(await getAll('inventory')).filter(item=>item.sku==='QA-RETRY-PART').length;
                      refreshData=original;
                      await runFormSave({preventDefault(){}},els.partForm,savePartFromForm);
                      const result={afterFailure,afterRetry:(await getAll('inventory')).filter(item=>item.sku==='QA-RETRY-PART').length,modalHidden:els.partModal.classList.contains('hidden'),error:els.partError.textContent};
                      closeModal('partModal',{saved:true});
                      return result;
                    }""")

                    observations["current_postcommit_inline_retry"] = page.evaluate("""async () => {
                      openJobModal(); switchJobModalTab('parts'); showInlinePartPanel();
                      els.inlinePartSku.value='QA-RETRY-INLINE'; els.inlinePartName.value='QA retry inline'; els.inlinePartQuantity.value='3'; els.inlinePartGarageCost.value='10'; els.inlinePartCustomerPrice.value='20';
                      const original=refreshData;
                      refreshData=async()=>{throw new Error('QA refresh failure')};
                      await runFormSave({preventDefault(){}},els.inlinePartPanel,saveInlinePart);
                      const afterFailure=(await getAll('inventory')).filter(item=>item.sku==='QA-RETRY-INLINE').length;
                      refreshData=original;
                      await runFormSave({preventDefault(){}},els.inlinePartPanel,saveInlinePart);
                      const result={afterFailure,afterRetry:(await getAll('inventory')).filter(item=>item.sku==='QA-RETRY-INLINE').length,draftParts:state.draftParts.length,panelHidden:els.inlinePartPanel.classList.contains('hidden'),error:els.inlinePartError.textContent};
                      closeModal('jobModal',{saved:true});
                      return result;
                    }""")

                    # All fields, including checkbox/date/select/optional values,
                    # must survive disabling and restore original disabled state.
                    observations["current_full_form_capture"] = page.evaluate("""async () => {
                      openJobModal();
                      const values={jobDate:'2026-11-01',vehiclePlate:'QA-CAPTURE',vehicleModel:'QA Model',vehicleYear:'2020',engineDisplacement:'1600',ownerName:'QA Owner',phoneNumber:'0000000000',mileage:'12345',laborPrice:'12.34',deliveryDate:'2026-11-04',notes:'QA notes',followUpDate:'2026-12-01'};
                      for(const [name,value] of Object.entries(values)) els.jobForm.elements[name].value=value;
                      els.taxEnabled.checked=false; els.taxRate.value='17.5'; els.taxRate.disabled=true; els.isQuote.checked=true;
                      await runFormSave({preventDefault(){}},els.jobForm,saveJobFromForm);
                      const saved=(await getAll('jobs')).find(job=>job.vehiclePlate==='QA-CAPTURE');
                      return {saved,taxRateDisabled:els.taxRate.disabled,lockReleased:pendingSaves.size===0};
                    }""")
                    assert observations["current_full_form_capture"]["saved"]["laborPrice"] == 12.34
                    assert observations["current_full_form_capture"]["saved"]["taxEnabled"] is False
                    assert observations["current_full_form_capture"]["saved"]["isQuote"] is True
                    assert observations["current_full_form_capture"]["taxRateDisabled"] is True
                    assert observations["current_full_form_capture"]["lockReleased"] is True

                    observations["current_backup_cancel_race"] = page.evaluate("""async () => {
                      let finish;
                      const reading=checkBackupFile({target:{files:[{name:'slow-cancelled.json',text:()=>new Promise(resolve=>finish=resolve)}],value:'file'}});
                      await checkBackupFile({target:{files:[],value:''}});
                      finish(JSON.stringify({jobs:[],inventory:[]})); await reading;
                      return {hidden:els.backupCheckResult.classList.contains('hidden'),report:backupCheckReport};
                    }""")
                    assert observations["current_backup_cancel_race"] == {"hidden": True, "report": None}
                context.close()
            observations["historical_upgrade_and_rollback"] = check_history_preservation(browser, base)
            browser.close()
    finally:
        server.shutdown()
    suite.OUT.mkdir(parents=True, exist_ok=True)
    output = suite.OUT / "independent-edge-cases.json"
    output.write_text(json.dumps(observations, indent=2, ensure_ascii=False), encoding="utf-8")
    # Windows CI may redirect stdout using a legacy code page.
    print(json.dumps(observations, indent=2, ensure_ascii=True))
    print(f"Independent QA evidence: {output}")
    defects = []
    job = observations["current_postcommit_job_retry"]["afterRetry"]
    if job != {"jobs": 1, "quantity": 9}:
        defects.append("job retry duplicates primary commit/inventory usage")
    settings = observations["current_settings_navigation_while_pending"]
    if settings["viewDuringSave"] != "backup" or settings["displayed"] != settings["stored"]:
        defects.append("pending settings navigation resets fields and leaves stale clean form")
    for kind in ["expense", "appointment"]:
        if observations[f"current_postcommit_{kind}_retry"]["afterRetry"] != 1:
            defects.append(f"{kind} retry duplicates primary commit")
    part = observations["current_postcommit_part_retry"]
    if part["afterRetry"] != 1 or not part["modalHidden"]:
        defects.append("part retry cannot recover after primary commit")
    inline = observations["current_postcommit_inline_retry"]
    if inline["afterRetry"] != 1 or inline["draftParts"] != 1 or not inline["panelHidden"]:
        defects.append("inline retry cannot recover after primary commit")
    assert not defects, "; ".join(defects)


if __name__ == "__main__":
    main()
