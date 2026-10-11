#!/usr/bin/env python3
"""Loads the Firefox build of the extension into a real Firefox and drives its settings page and popup.

    pip install selenium
    python extension/test/firefox/run_firefox_test.py            # needs Firefox (Selenium finds the driver itself)
    FIREFOX_BIN="C:/Program Files/Mozilla Firefox/firefox.exe" python extension/test/firefox/run_firefox_test.py

There is no Inkling stack here: a small fake server answers the two routes the extension uses and writes down what it was
sent, which is what matters most in a browser that is not Chrome: the key arrives, the extension's own origin
(`moz-extension://...`) is what the server sees, and no cookie goes with it.

Like the Chromium test (frontend/e2e/extension.spec.ts), this copies the extension and gives it permission for the machine
itself before loading, because a test cannot answer the browser's own permission prompt.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import traceback
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import Select, WebDriverWait

ROOT = Path(__file__).resolve().parents[3]
KEY = "ink_" + "f" * 40
ADD_ON_ID = "inkling-extension@oblutack.github.io"
FIXED_UUID = str(uuid.uuid4())  # so the pages of the add-on have an address that is known: moz-extension://<uuid>/

TITLE = "Heat pumps in cold climates"
PARAGRAPHS = [
    "Heat pumps move heat from the outside air into a building instead of burning fuel to make it, which is why they use far less energy than a boiler.",
    "Modern models keep working well below freezing, and sales in the coldest parts of Europe have risen every year since 2019.",
    "The main cost is the installation, which can take a few days and may need new radiators, but running costs fall as soon as the work is done.",
]
ARTICLE = (
    f"<!doctype html><html><head><title>{TITLE}</title></head><body><nav>Home | News | Sport</nav>"
    f"<article><h1>{TITLE}</h1>{''.join(f'<p>{p}</p>' for p in PARAGRAPHS)}</article>"
    "<footer>Footer words and a cookie notice</footer></body></html>"
)

seen = []  # what the fake server was sent


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # quiet
        pass

    def _send(self, status, body, content_type="application/json", extra=None):
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/article":
            return self._send(200, ARTICLE, "text/html; charset=utf-8")
        if path == "/v1/usage":
            if self.headers.get("Authorization") != f"Bearer {KEY}":
                return self._send(401, json.dumps({"code": "invalid_api_key", "error": "bad key"}))
            seen.append({"route": path, "origin": self.headers.get("Origin"), "cookie": self.headers.get("Cookie")})
            return self._send(200, json.dumps({"key": {"name": "firefox test", "usedToday": 2, "dailyLimit": 50, "expiresAt": None}}))
        self._send(404, "{}")

    def do_POST(self):
        url = urlparse(self.path)
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        if self.headers.get("Authorization") != f"Bearer {KEY}":
            return self._send(401, json.dumps({"code": "invalid_api_key", "error": "bad key"}))
        seen.append(
            {
                "route": url.path,
                "query": {k: v[0] for k, v in parse_qs(url.query).items()},
                "origin": self.headers.get("Origin"),
                "cookie": self.headers.get("Cookie"),
                "body": body,
            }
        )
        text = body.get("text", "")
        summary = f"## Fake summary\n\n- Words in source: {len(text.split())}\n- Opening: {' '.join(text.split()[:6])}\n- **Options**: {url.query}"
        self._send(200, json.dumps({"summary": summary, "filename": "Pasted Text"}), extra={"X-Quota-Remaining": "41"})


def build_extension(target: Path, host: str) -> Path:
    subprocess.run([sys.executable, str(ROOT / "scripts" / "package_extension.py"), "--firefox", "--unpacked", str(target)], check=True, stdout=subprocess.DEVNULL)
    manifest_path = target / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["host_permissions"] = [f"http://{host}/*"]
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return target


def start_firefox() -> webdriver.Firefox:
    options = Options()
    options.add_argument("-headless")
    options.enable_bidi = True
    binary = os.environ.get("FIREFOX_BIN")
    if binary:
        options.binary_location = binary
    options.set_preference("extensions.webextensions.uuids", json.dumps({ADD_ON_ID: FIXED_UUID}))
    options.set_preference("intl.accept_languages", "en-US")
    driver = webdriver.Firefox(options=options, service=Service())
    driver.set_window_size(1000, 800)
    return driver


class Check:
    def __init__(self):
        self.failures = []
        self.passed = 0

    def __call__(self, name, ok, detail=""):
        if ok:
            self.passed += 1
            print(f"  ok    {name}")
        else:
            self.failures.append(name)
            print(f"  FAIL  {name} {detail}")


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")  # the page texts have quotation marks and symbols a console may not know
    check = Check()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    work = Path(tempfile.mkdtemp(prefix="inkling-firefox-"))
    driver = None
    try:
        package = build_extension(work / "extension", "127.0.0.1")
        driver = start_firefox()
        # By path, through WebDriver BiDi: Firefox opens the folder itself. (Selenium's install_addon sends the add-on as
        # a file that Firefox keeps open, and on Windows the driver then cannot delete it.)
        driver.webextension.install(path=str(package))
        extension = f"moz-extension://{FIXED_UUID}"
        wait = WebDriverWait(driver, 15)

        def text_of(selector):
            return driver.find_element(By.CSS_SELECTOR, selector).text

        def open_options():
            driver.get(f"{extension}/options.html")
            # the page fills in its choices (and starts listening to the form) after it has read the stored settings
            wait.until(lambda d: d.execute_script("return document.querySelectorAll('#language option').length") > 0)

        # ---- the settings page -------------------------------------------------------------------------------
        print("settings page")
        open_options()
        check("the page is in English and has its title", driver.find_element(By.TAG_NAME, "h1").text == "Inkling settings")
        driver.find_element(By.ID, "address").send_keys("http://example.com")
        driver.find_element(By.ID, "key").send_keys("not a key")
        driver.find_element(By.ID, "save").click()
        wait.until(lambda d: "Enter a valid address" in text_of("#address-error"))
        check("a bad address is refused, with the reason", True)
        check("the key is hidden as it is typed", driver.find_element(By.ID, "key").get_attribute("type") == "password")

        for field, value in (("address", base), ("key", KEY)):
            element = driver.find_element(By.ID, field)
            element.clear()
            element.send_keys(value)
        Select(driver.find_element(By.ID, "length")).select_by_value("300")
        driver.find_element(By.ID, "save").click()
        wait.until(lambda d: text_of("#status") == "Settings saved.")
        check("good settings are saved", True)

        driver.find_element(By.ID, "test").click()
        wait.until(lambda d: "Connected." in text_of("#status"))
        check("the connection test names the key and its use", "Key “firefox test”: 2 of 50 requests used today." in text_of("#status"), text_of("#status"))
        usage = [s for s in seen if s["route"] == "/v1/usage"][-1]
        # (a plain GET carries no Origin in Firefox; the POST below shows the extension's origin)
        check("no cookie goes with the key", not usage["cookie"], str(usage["cookie"]))

        open_options()
        check("the settings are still there after a reload", driver.find_element(By.ID, "address").get_attribute("value") == base)
        check("including the choices", driver.find_element(By.ID, "length").get_attribute("value") == "300")

        # ---- a page, in a tab of its own ---------------------------------------------------------------------------
        options_handle = driver.current_window_handle
        driver.switch_to.new_window("tab")
        article_handle = driver.current_window_handle
        driver.get(f"{base}/article")
        driver.switch_to.window(options_handle)
        tab_id = driver.execute_async_script(
            """const done = arguments[arguments.length - 1];
               browser.tabs.query({ url: arguments[0] }).then((tabs) => done(tabs[0] && tabs[0].id), () => done(null));""",
            f"http://127.0.0.1/*",  # a match pattern has no port
        )
        check("the extension can see the page's tab", isinstance(tab_id, int), str(tab_id))

        def open_popup():
            driver.switch_to.new_window("tab")
            driver.get(f"{extension}/popup.html?tab={tab_id}")
            wait.until(EC.visibility_of_element_located((By.ID, "page-title")))

        print("popup, whole page")
        open_popup()
        check("the page's title and host are shown", text_of("#page-title") == TITLE and text_of("#page-host") == f"127.0.0.1:{port}")
        check("with no selection there is only the page button", not driver.find_element(By.ID, "summarize-selection").is_displayed())
        check("the saved length is chosen", driver.find_element(By.ID, "length").get_attribute("value") == "300")
        driver.find_element(By.ID, "summarize-page").click()
        wait.until(EC.visibility_of_element_located((By.CSS_SELECTOR, "#summary h3")))
        check("the summary is shown with its heading", text_of("#summary h3") == "Fake summary")
        items = driver.find_elements(By.CSS_SELECTOR, "#summary li")
        check("and as a list", len(items) == 3, str(len(items)))
        words = len((TITLE + " " + TITLE + " " + " ".join(PARAGRAPHS)).split())
        check("the article was what was read, not the menu or the footer", f"Words in source: {words}" in text_of("#summary"), text_of("#summary"))
        check("the quota is shown", "41 summaries left today." in text_of("#result-note"), text_of("#result-note"))
        call = [s for s in seen if s["route"] == "/v1/summarize-text"][-1]
        check("the request went to the summarize route with the choices", call["query"].get("wordCount") == "300" and call["query"].get("language") == "English", str(call["query"]))
        check("from the extension's own origin, with no cookie", str(call["origin"]).startswith("moz-extension://") and not call["cookie"], f"{call['origin']} {call['cookie']}")
        check("the page's title leads the text that was sent", call["body"]["text"].startswith(TITLE), call["body"]["text"][:60])
        popup_handle = driver.current_window_handle

        # ---- a selection -------------------------------------------------------------------------------------------------
        print("popup, a selection")
        driver.switch_to.window(article_handle)
        driver.execute_script(
            """const range = document.createRange();
               range.selectNodeContents(document.querySelectorAll('article p')[1]);
               const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);"""
        )
        driver.switch_to.window(popup_handle)
        driver.refresh()
        wait.until(EC.visibility_of_element_located((By.ID, "selection-info")))
        count = len(PARAGRAPHS[1].split())
        check("the selection is counted", text_of("#selection-info") == f"{count} words selected", text_of("#selection-info"))
        driver.find_element(By.ID, "summarize-selection").click()
        wait.until(EC.visibility_of_element_located((By.CSS_SELECTOR, "#summary h3")))
        check("only the selection was summarized", f"Words in source: {count}" in text_of("#summary"), text_of("#summary"))

        # ---- a wrong key -----------------------------------------------------------------------------------------------------
        print("a wrong key")
        open_options()
        key_field = driver.find_element(By.ID, "key")
        key_field.clear()
        key_field.send_keys("ink_" + "x" * 40)
        driver.find_element(By.ID, "save").click()
        wait.until(lambda d: text_of("#status") == "Settings saved.")
        driver.get(f"{extension}/popup.html?tab={tab_id}")
        wait.until(EC.element_to_be_clickable((By.ID, "summarize-page")))
        driver.find_element(By.ID, "summarize-page").click()
        wait.until(lambda d: "was not accepted" in text_of("#error"))
        check("a wrong key is explained, and the button is there to try again", driver.find_element(By.ID, "summarize-page").is_displayed(), text_of("#error"))

        # ---- a server that is not there ----------------------------------------------------------------------------------------
        print("a server that cannot be reached")
        open_options()
        for field, value in (("address", "http://127.0.0.1:9"), ("key", KEY)):
            element = driver.find_element(By.ID, field)
            element.clear()
            element.send_keys(value)
        driver.find_element(By.ID, "save").click()
        wait.until(lambda d: text_of("#status") in ("Settings saved.", ""))
        driver.get(f"{extension}/popup.html?tab={tab_id}")
        wait.until(EC.element_to_be_clickable((By.ID, "summarize-page")))
        driver.find_element(By.ID, "summarize-page").click()
        wait.until(lambda d: "Could not reach 127.0.0.1:9." in text_of("#error"))
        check("an unreachable server is named", True)
    except Exception as error:  # a failure of the test itself is a failure
        traceback.print_exc()
        check("the test ran to the end", False, repr(error))
    finally:
        if driver:
            driver.quit()
        server.shutdown()
        shutil.rmtree(work, ignore_errors=True)

    print(f"\n{check.passed} checks passed, {len(check.failures)} failed")
    for name in check.failures:
        print("  failed:", name)
    return 1 if check.failures else 0


if __name__ == "__main__":
    sys.exit(main())
