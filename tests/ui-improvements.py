"""Isolated browser regression and v0.1.18 upgrade/rollback check.

Requires Python, playwright (with Chromium), pypdf and pymupdf.
Uses synthetic data in a fresh browser context; never uses an installed profile.
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import mimetypes
import subprocess
import threading
from urllib.parse import unquote, urlparse

import fitz
from playwright.sync_api import expect, sync_playwright
from pypdf import PdfReader


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "tmp" / "ui-qa"
STORES = ["jobs", "inventory", "categories", "appointments", "settings", "expenses"]
BASELINE = {
    name: subprocess.check_output(["git", "show", f"v0.1.18:{name}"], cwd=ROOT)
    for name in ["index.html", "app.js", "styles.css"]
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        version, _, relative = path.lstrip("/").partition("/")
        relative = relative or "index.html"
        resolved = (ROOT / relative).resolve()
        if not resolved.is_relative_to(ROOT) or version not in ["baseline", "current"]:
            self.send_error(404)
            return
        if version == "baseline" and relative in BASELINE:
            data = BASELINE[relative]
        elif resolved.is_file():
            data = resolved.read_bytes()
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(relative)[0] or "application/octet-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


def snapshot(page):
    return page.evaluate("""async (names) => {
      const records = {};
      for (const name of names) records[name] = await getAll(name);
      return records;
    }""", STORES)


def loaded(page, url):
    page.goto(url, wait_until="networkidle")
    page.wait_for_function("state.db !== null && document.querySelector('#toast').textContent.includes('בהצלחה')")


def click_with_confirmation(page, selector, accept=False):
    page.once("dialog", lambda dialog: dialog.accept() if accept else dialog.dismiss())
    page.locator(selector).first.click()


def check(page, condition, message):
    assert page.evaluate(condition), message
    print(f"PASS: {message}", flush=True)


def check_save_and_backup(page):
    before_validation = snapshot(page)
    assert page.evaluate("async () => { openPartModal(); const field=els.partForm.elements.name; field.focus(); field.value='Already editing'; await new Promise(requestAnimationFrame); const kept=document.activeElement===field; closeModal('partModal',{saved:true}); return kept; }")
    page.evaluate("async () => { openJobModal(); await new Promise(requestAnimationFrame); els.jobForm.elements.vehiclePlate.value='FIELD-CHECK'; els.jobForm.elements.laborPrice.value='-1'; els.jobForm.requestSubmit(); }")
    expect(page.locator('#jobForm [name="laborPrice"]')).to_be_focused()
    expect(page.locator('#jobForm [name="laborPrice"]')).to_have_attribute("aria-invalid", "true")
    expect(page.locator('#jobModal [data-modal-pane="parts"]')).to_be_visible()
    expect(page.locator('#jobModal [data-modal-tab="parts"]')).to_have_attribute("aria-selected", "true")
    page.screenshot(path=str(OUT / "field-errors.png"), full_page=True)
    page.locator('#jobForm [name="laborPrice"]').fill("10")
    expect(page.locator('#jobForm [name="laborPrice"]')).not_to_have_attribute("aria-invalid", "true")
    page.evaluate("async () => { closeModal('jobModal',{saved:true}); openAppointmentModal(); await new Promise(requestAnimationFrame); els.appointmentForm.elements.customerName.value='   '; els.appointmentForm.requestSubmit(); }")
    expect(page.locator('#appointmentForm [name="customerName"]')).to_be_focused()
    expect(page.locator('#appointmentForm [name="customerName"]')).to_have_attribute("aria-invalid", "true")
    page.evaluate("async () => { closeModal('appointmentModal',{saved:true}); openExpenseModal(); await new Promise(requestAnimationFrame); els.expenseForm.elements.amount.value='0'; els.expenseForm.requestSubmit(); }")
    expect(page.locator('#expenseForm [name="amount"]')).to_have_attribute("aria-invalid", "true")
    expect(page.locator('#expenseForm [name="amount"]')).to_be_focused()
    page.evaluate("closeModal('expenseModal',{saved:true})")
    assert snapshot(page) == before_validation
    print("PASS: field errors reveal hidden tabs, focus the first error, clear on correction and never save invalid forms", flush=True)

    page.evaluate("openPartModal()")
    for name, value in {"sku":"FAIL-RETRY", "name":"Retry fixture", "quantity":"1", "garageCost":"10", "customerPrice":"20"}.items():
        page.locator(f'#partForm [name="{name}"]').fill(value)
    page.evaluate("window.testOriginalSavePart=savePart; savePart=async()=>{throw new Error('Fixture save failure')}; els.partForm.requestSubmit()")
    expect(page.locator("#partError")).to_contain_text("Fixture save failure")
    expect(page.locator('#partForm button[type="submit"]')).to_be_enabled()
    expect(page.locator('#partForm [name="name"]')).to_have_value("Retry fixture")
    page.evaluate("savePart=window.testOriginalSavePart; delete window.testOriginalSavePart; closeModal('partModal',{saved:true})")
    print("PASS: a failed save releases controls and keeps the user's input for retry", flush=True)

    cases = [
        ("partForm", "partModal", "openPartModal", {"sku":"ONCE-PART", "name":"Saved once part", "quantity":"4", "garageCost":"11", "customerPrice":"23"}, "state.inventory.filter(item=>item.sku==='ONCE-PART').length===1"),
        ("jobForm", "jobModal", "openJobModal", {"vehiclePlate":"ONCE-JOB", "ownerName":"Saved once job", "laborPrice":"35"}, "state.jobs.filter(item=>item.vehiclePlate==='ONCE-JOB' && item.laborPrice===35).length===1"),
        ("appointmentForm", "appointmentModal", "openAppointmentModal", {"customerName":"Saved once appointment", "phoneNumber":"0000000000"}, "state.appointments.filter(item=>item.customerName==='Saved once appointment').length===1"),
        ("expenseForm", "expenseModal", "openExpenseModal", {"description":"Saved once expense", "amount":"17.50"}, "state.expenses.filter(item=>item.description==='Saved once expense' && item.amount===17.5).length===1"),
        ("businessSettingsForm", None, None, {"name":"Saved once business"}, "state.business.name==='Saved once business'")
    ]
    for form_id, modal_id, opener, fields, condition in cases:
        if opener:
            page.evaluate(f"async () => {{ {opener}(); await new Promise(requestAnimationFrame); }}")
        else:
            page.evaluate("switchView('backup')")
        for name, value in fields.items():
            if form_id == "jobForm" and name == "laborPrice":
                page.locator('#jobModal [data-modal-tab="parts"]').click()
            page.locator(f'#{form_id} [name="{name}"]').fill(value)
        page.evaluate("""() => {
          window.testSaveGate={original:transactionDone,calls:0};
          transactionDone=async (...args)=>{
            const completion=window.testSaveGate.original(...args);
            window.testSaveGate.calls++;
            if(window.testSaveGate.calls===1) await new Promise(resolve=>{window.testSaveGate.release=resolve});
            return await completion;
          };
        }""")
        page.evaluate("id=>document.getElementById(id).requestSubmit()", form_id)
        page.wait_for_function("typeof window.testSaveGate.release==='function'")
        expect(page.locator(f'#{form_id} button[type="submit"]')).to_be_disabled()
        expect(page.locator(f'#{form_id} button[type="submit"]')).to_have_text("שומר…")
        page.evaluate("id=>document.getElementById(id).dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))", form_id)
        assert page.evaluate("window.testSaveGate.calls") == 1
        assert page.evaluate("confirmDiscardChanges()") is False
        if modal_id:
            assert page.evaluate("id=>closeModal(id)", modal_id) is False
        page.evaluate("window.testSaveGate.release()")
        expect(page.locator(f'#{form_id} button[type="submit"]')).to_be_enabled()
        if modal_id:
            expect(page.locator(f"#{modal_id}")).to_be_hidden()
        check(page, condition, f"{form_id} saves once under rapid repeated submission, with all values intact")
        page.evaluate("transactionDone=window.testSaveGate.original; delete window.testSaveGate")

    # Inline part creation shares the parent modal's save lock.
    page.evaluate("openJobModal(); switchJobModalTab('parts'); showInlinePartPanel()")
    for element_id, value in {"inlinePartSku":"ONCE-INLINE", "inlinePartName":"Saved once inline part", "inlinePartQuantity":"1", "inlinePartGarageCost":"10", "inlinePartCustomerPrice":"20"}.items():
        page.locator(f"#{element_id}").fill(value)
    page.evaluate("""() => {
      window.testSaveGate={original:transactionDone,calls:0};
      transactionDone=async(...args)=>{const completion=window.testSaveGate.original(...args); window.testSaveGate.calls++; if(window.testSaveGate.calls===1) await new Promise(resolve=>{window.testSaveGate.release=resolve}); return await completion;};
      els.saveInlinePartButton.click(); els.saveInlinePartButton.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); els.jobForm.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    }""")
    page.wait_for_function("typeof window.testSaveGate.release==='function'")
    assert page.evaluate("window.testSaveGate.calls") == 1
    expect(page.locator('#jobForm button[type="submit"]')).to_be_disabled()
    page.evaluate("window.testSaveGate.release()")
    expect(page.locator("#inlinePartPanel")).to_be_hidden()
    expect(page.locator('#jobForm button[type="submit"]')).to_be_enabled()
    check(page, "state.inventory.filter(item=>item.sku==='ONCE-INLINE').length===1 && state.draftParts.length===1", "inline part creation blocks duplicate and parent saves while pending")
    page.evaluate("transactionDone=window.testSaveGate.original; delete window.testSaveGate; closeModal('jobModal',{saved:true})")

    # Existing SKU constraints report at the field and restore the form after failure.
    before_duplicate = snapshot(page)
    page.evaluate("openPartModal()")
    for name, value in {"sku":"SKU-1", "name":"Duplicate fixture", "quantity":"1", "garageCost":"10", "customerPrice":"20"}.items():
        page.locator(f'#partForm [name="{name}"]').fill(value)
    page.locator('#partForm button[type="submit"]').click()
    expect(page.locator('#partForm [name="sku"]')).to_have_attribute("aria-invalid", "true")
    expect(page.locator('#partForm [name="sku"]')).to_be_focused()
    expect(page.locator('#partForm button[type="submit"]')).to_be_enabled()
    assert snapshot(page) == before_duplicate
    page.evaluate("closeModal('partModal',{saved:true}); switchView('backup')")
    print("PASS: duplicate SKU errors point to the field without changing existing records", flush=True)

    records = snapshot(page)
    payload = {"app":"TopGear", "version":5, "exportedAt":"2026-11-02T12:00:00Z", "jobs":records["jobs"], "inventory":records["inventory"], "customCategories":records["categories"], "appointments":records["appointments"], "expenses":records["expenses"], "business":records["settings"][0]}
    page.evaluate("""() => {
      window.testOriginalTransaction=state.db.transaction.bind(state.db);
      window.testBackupWrites=0;
      state.db.transaction=(names,mode,...args)=>{if(mode==='readwrite') window.testBackupWrites++; return window.testOriginalTransaction(names,mode,...args);};
    }""")
    page.locator("#backupCheckInput").set_input_files({"name":"current-backup.json", "mimeType":"application/json", "buffer":json.dumps(payload).encode()})
    expect(page.locator("#backupCheckResult")).to_have_class("backup-check-result is-valid")
    assert page.locator("#backupCheckResult dd").all_text_contents() == [str(len(records[name])) for name in ["jobs","inventory","categories","appointments","expenses","settings"]]
    page.screenshot(path=str(OUT / "backup-check.png"), full_page=True)
    page.locator("#backupCheckInput").set_input_files({"name":"broken.json", "mimeType":"application/json", "buffer":b'{broken'})
    expect(page.locator("#backupCheckResult")).to_have_class("backup-check-result is-invalid")
    page.locator("#backupCheckInput").set_input_files({"name":"old-backup.json", "mimeType":"application/json", "buffer":b'{"app":"TopGear","version":1,"jobs":[],"inventory":[]}'})
    expect(page.locator("#backupCheckResult")).to_have_class("backup-check-result is-valid")
    expect(page.locator("#backupCheckResult")).to_contain_text("הערות לבדיקה")
    page.locator("#backupCheckInput").set_input_files({"name":"<img src=x onerror=alert(1)>.json", "mimeType":"application/json", "buffer":json.dumps(payload).encode()})
    expect(page.locator("#backupCheckResult")).to_have_class("backup-check-result is-valid")
    assert page.locator("#backupCheckResult img").count() == 0
    # A late file read must not replace the result for a more recent selection.
    page.evaluate("""() => {
      window.originalFileText=File.prototype.text;
      File.prototype.text=function(){if(this.name==='slow.json') return new Promise(resolve=>{window.resolveSlowBackup=resolve}); return window.originalFileText.call(this);};
    }""")
    page.locator("#backupCheckInput").set_input_files({"name":"slow.json", "mimeType":"application/json", "buffer":b'{}'})
    page.wait_for_function("typeof window.resolveSlowBackup==='function'")
    page.locator("#backupCheckInput").set_input_files({"name":"newest.json", "mimeType":"application/json", "buffer":json.dumps(payload).encode()})
    expect(page.locator("#backupCheckResult")).to_have_class("backup-check-result is-valid")
    page.evaluate("window.resolveSlowBackup('{}')")
    expect(page.locator("#backupCheckResult")).to_contain_text("newest.json")
    assert page.evaluate("window.testBackupWrites") == 0
    assert snapshot(page) == records
    page.evaluate("() => { File.prototype.text=window.originalFileText; state.db.transaction=window.testOriginalTransaction; }")
    print("PASS: backup inspection handles current/legacy/malformed files and late reads with zero database writes", flush=True)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1440, "height": 1000})
            # Keep tests offline and avoid sending even synthetic plate searches.
            context.route("**/*", lambda route: route.continue_() if urlparse(route.request.url).hostname == "127.0.0.1" else route.abort())
            context.add_init_script("window.print = () => { window.__printed = true; };")
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            loaded(page, base + "/baseline/")
            page.evaluate("""async () => {
              const date = toIsoDate(new Date());
              const tx = state.db.transaction(['jobs','inventory','categories','appointments','settings','expenses'], 'readwrite');
              for (let i = 1; i <= 121; i++) {
                tx.objectStore('inventory').put({ id:i, sku:`SKU-${i}`, name:`Fixture part ${i}`, category:'general', quantity:i <= 3 ? i-1 : 3, garageCost:10, customerPrice:20 });
                tx.objectStore('jobs').put({ id:i, jobDate:date, vehiclePlate:`TEST-${i}`, ownerName:`Fixture owner ${i}`, vehicleModel:'Fixture model', vehicleYear:2020, phoneNumber:'0000000000', laborPrice:100, taxEnabled:true, taxRate:18, parts:[], deliveryDate:date, ...(i%2===0 ? {deliveredAt:new Date().toISOString()} : {}) });
                tx.objectStore('appointments').put({ id:i, appointmentDate:date, appointmentTime:'10:00', customerName:`Fixture appointment ${i}`, phoneNumber:'0000000000', vehiclePlate:`TEST-${i}`, vehicleModel:'Fixture model' });
                tx.objectStore('expenses').put({ id:i, date, category:'rent', description:`Fixture expense ${i}`, amount:10 });
              }
              tx.objectStore('categories').put({id:'custom_fixture', label:'Fixture category', custom:true});
              tx.objectStore('settings').put({id:'business',name:'Fixture Garage',taxId:'000000000',licenseNumber:'Fixture',address:'Fixture address',phone:'0000000000',defaultTaxRate:18});
              await transactionDone(tx);
              await refreshData();
              renderAll();
            }""")
            original = snapshot(page)
            baseline_totals = page.evaluate("({revenue:els.revenueMetric.textContent, profit:els.profitMetric.textContent, expenses:els.expenseTotalMetric.textContent})")
            loaded(page, base + "/current/")
            assert snapshot(page) == original, "upgrade changed stored records"
            assert page.evaluate("({revenue:els.revenueMetric.textContent, profit:els.profitMetric.textContent, expenses:els.expenseTotalMetric.textContent})") == baseline_totals
            print("PASS: upgrade preserves all six stores and financial totals", flush=True)

            page.evaluate("state.activeRange='all'; renderJobs(); switchView('jobs')")
            expect(page.locator("#jobsBody tr.job-row")).to_have_count(50)
            page.locator('#jobsPagination [data-page="2"]').click()
            check(page, "tablePages.jobs.page === 2 && els.jobsBody.querySelector('tr.job-row').dataset.jobRow !== '121'", "job pagination moves between pages")
            page.evaluate("els.jobSearch.value='Fixture owner 121'; els.jobSearch.dispatchEvent(new Event('input'))")
            assert page.locator("#jobsBody tr.job-row").count() == 50, "search was not debounced"
            expect(page.locator("#jobsBody tr.job-row")).to_have_count(1)
            check(page, "tablePages.jobs.page === 1", "search resets pagination and is debounced")
            page.locator("#jobSearch").fill("")
            expect(page.locator("#jobsBody tr.job-row")).to_have_count(50)

            page.evaluate("switchView('inventory')")
            expect(page.locator("#inventoryBody > tr")).to_have_count(50)
            expect(page.locator("#lowStockCount")).to_have_text("2")
            expect(page.locator("#outOfStockCount")).to_have_text("1")
            total_units = page.locator("#inventoryTotalUnits").text_content()
            page.locator('#inventoryPagination [data-page="2"]').click()
            assert page.locator("#inventoryTotalUnits").text_content() == total_units
            page.locator("#lowStockOnlyButton").click()
            expect(page.locator("#inventoryBody > tr")).to_have_count(3)
            expect(page.locator("#inventoryTotalUnits")).to_have_text("3")
            page.screenshot(path=str(OUT / "inventory.png"), full_page=True)
            page.locator("#lowStockOnlyButton").click()
            print("PASS: low-stock filter and paged inventory preserve whole-result totals", flush=True)

            for view, body in [("deliveries", "deliveriesBody"), ("appointments", "appointmentsBody"), ("expenses", "expensesBody")]:
                page.evaluate("(view) => switchView(view)", view)
                selector = f"#{body} > tr:not(.row-detail)"
                expect(page.locator(selector)).to_have_count(50)
                page.locator(f'#{view}Pagination [data-page="2"]').click()
                check(page, f"tablePages.{view}.page === 2", f"{view} pagination works")
            assert page.locator("#expenseTotalMetric").text_content() == baseline_totals["expenses"]

            for modal, opener, field in [("jobModal", "openJobModal", "ownerName"), ("partModal", "openPartModal", "name"), ("appointmentModal", "openAppointmentModal", "customerName"), ("expenseModal", "openExpenseModal", "description")]:
                page.evaluate(f"{opener}()")
                page.locator(f'#{modal} [name="{field}"]').fill("Unsaved fixture")
                click_with_confirmation(page, f'#{modal} [data-close-modal="{modal}"]')
                expect(page.locator(f"#{modal}")).to_be_visible()
                click_with_confirmation(page, f'#{modal} [data-close-modal="{modal}"]', accept=True)
                expect(page.locator(f"#{modal}")).to_be_hidden()
            print("PASS: all four edit dialogs protect unsaved inputs", flush=True)

            page.evaluate("openJobModal(); state.draftParts.push({nameSnapshot:'Unsaved part',quantityUsed:1,garageCostSnapshot:10,customerPriceSnapshot:20,temporary:true}); renderDraftParts()")
            page.once("dialog", lambda dialog: dialog.dismiss())
            page.keyboard.press("Escape")
            expect(page.locator("#jobModal")).to_be_visible()
            click_with_confirmation(page, '#jobModal [data-close-modal="jobModal"]', accept=True)
            print("PASS: Escape protects unsaved job parts", flush=True)

            page.evaluate("switchView('backup')")
            expect(page.locator("#appVersion")).to_have_text("תצוגה מקדימה בדפדפן")
            page.locator('#businessSettingsForm [name="name"]').fill("Unsaved business name")
            page.evaluate("renderAll()")
            expect(page.locator('#businessSettingsForm [name="name"]')).to_have_value("Unsaved business name")
            check(page, "(() => { const event=new Event('beforeunload',{cancelable:true}); window.dispatchEvent(event); return event.defaultPrevented; })()", "closing the browser detects unsaved settings")
            click_with_confirmation(page, '.nav-button[data-view="jobs"]')
            check(page, "state.activeView === 'backup'", "canceling navigation keeps unsaved settings")
            click_with_confirmation(page, '.nav-button[data-view="jobs"]', accept=True)
            expect(page.locator('#businessSettingsForm [name="name"]')).to_have_value("Fixture Garage")

            page.evaluate("""async () => {
              window.__TAURI__={app:{getVersion:async ()=>'0.1.19'},window:{getCurrentWindow:()=>({onCloseRequested:async callback=>{window.testCloseCallback=callback; return ()=>{};}})}};
              await loadAppVersion(); await registerWindowCloseGuard();
            }""")
            expect(page.locator("#appVersion")).to_have_text("v0.1.19")
            page.evaluate("openPartModal(); els.partForm.elements.name.value='Native close fixture'")
            page.once("dialog", lambda dialog: dialog.dismiss())
            check(page, "(() => { let prevented=false; window.testCloseCallback({preventDefault:()=>{prevented=true}}); return prevented; })()", "desktop close callback protects unsaved edits")
            click_with_confirmation(page, '#partModal [data-close-modal="partModal"]', accept=True)
            page.evaluate("delete window.__TAURI__")

            # Exercise a real save, not only the force-close helper.
            page.evaluate("openPartModal()")
            for name, value in {"sku":"AFTER-UPGRADE", "name":"Part added after upgrade", "quantity":"4", "garageCost":"10", "customerPrice":"20"}.items():
                page.locator(f'#partForm [name="{name}"]').fill(value)
            page.locator('#partForm button[type="submit"]').click()
            expect(page.locator("#partModal")).to_be_hidden()
            check(page, "!hasUnsavedChanges() && state.inventory.length === 122 && state.inventory.some(part=>part.sku==='AFTER-UPGRADE' && part.name==='Part added after upgrade')", "successful save closes cleanly and retains the record")

            page.evaluate("switchView('backup')")
            page.screenshot(path=str(OUT / "settings.png"), full_page=True)
            for count, name in [(1, "invoice-short"), (80, "invoice-long")]:
                page.evaluate("""count => {
                  const job={...state.jobs[0],notes:'הערות לדוגמה\\nשורה שנייה',parts:Array.from({length:count},(_,i)=>({nameSnapshot:`PART-${String(i+1).padStart(3,'0')} תיאור חלק ארוך לבדיקת פריסת הדפסה`,skuSnapshot:`SKU-${i+1}`,quantityUsed:1,garageCostSnapshot:10,customerPriceSnapshot:20}))};
                  els.invoiceSheet.innerHTML=renderInvoiceHtml(job);
                  els.invoiceSheet.dataset.invoiceTitle=buildInvoiceFilename(job);
                  openModal('invoiceModal'); printInvoiceWithFilename();
                }""", count)
                page.wait_for_function("document.getElementById('__topgear_print_frame__')?.contentWindow?.__printed === true")
                document = page.locator("#__topgear_print_frame__").get_attribute("srcdoc")
                document = document.replace("<head>", f'<head><base href="{base}/current/">', 1)
                printed = context.new_page()
                printed.set_content(document, wait_until="networkidle")
                printed.pdf(path=str(OUT / f"{name}.pdf"), prefer_css_page_size=True, print_background=True)
                reader = PdfReader(OUT / f"{name}.pdf")
                assert len(reader.pages) == 1 if count == 1 else len(reader.pages) >= 2
                text = "\n".join(sheet.extract_text() for sheet in reader.pages)
                assert f"PART-{count:03}" in text, "last invoice row was clipped"
                # The last page must carry totals with the signatures, not an orphaned footer.
                assert "18%" in reader.pages[-1].extract_text()
                pdf = fitz.open(OUT / f"{name}.pdf")
                for index in sorted({0, len(pdf)-1}):
                    pdf[index].get_pixmap(matrix=fitz.Matrix(1.2,1.2)).save(str(OUT / f"{name}-{index+1}.png"))
                pdf.close()
                printed.close()
                page.evaluate("closeModal('invoiceModal')")
                print(f"PASS: {name} PDF has {len(reader.pages)} page(s), all final rows present", flush=True)

            check_save_and_backup(page)
            after_user_work = snapshot(page)
            loaded(page, base + "/baseline/")
            assert snapshot(page) == after_user_work, "rollback changed stored records"
            assert any(part["sku"] == "AFTER-UPGRADE" for part in after_user_work["inventory"])
            assert not errors, errors
            print("PASS: rollback to v0.1.18 preserves all stores, including new work entered after upgrade", flush=True)
            print(f"Browser QA artifacts: {OUT}", flush=True)
            browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
