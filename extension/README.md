# Inkling for the browser

A small extension, for **Chrome** (and other Chromium browsers) and for **Firefox**, that summarizes the page you are reading, or the text you have selected, with your own Inkling
account. Press the button, read the summary in the popup, copy it, or keep it in your Inkling library.

It has **no build step and no dependencies**: the code in this folder is what the browser runs.

## What it does

- **Summarize this page.** The extension reads the page's text in your browser (the article, not the menus, the footer or what
  is hidden) and sends it to your Inkling server. A page with no text of its own, such as a PDF in the browser's viewer, is handed to
  the server by its address instead.
- **Summarize the selection.** Select some text first and the button changes to summarize just that. Or right-click the selection and choose **Summarize the selection with Inkling**: a small window opens and goes straight to the summary.
- **Save for later.** Press **Save for later** to put the page on your Inkling reading list: your server reads it (the page's address is sent, not its text), keeps a short summary of it in your library, and it waits for you on the website, where you can mark it read or archive it. A page that is on the list already is not summarized again. It counts as one summary of your daily allowance.
- **Explain the selection.** Select a few words or sentences and press **Explain the selection** (or right-click and choose **Explain the selection with Inkling**): you get two to four short sentences in plain words, and **Explain more simply** gives a version in everyday words. The explanation is the AI's and can be wrong, which the window says. It counts as one chat question of your daily allowance and nothing is saved.
- **Watch it being written.** The summary appears as it is written (the API's streaming), with a **Stop** button that keeps what was written so far. A server that answers all at once works as well.
- **Your choices.** Length (about 100 to 500 words), style (standard, bullet points, brief, simple language, key takeaways),
  language (the 15 that Inkling writes in), and whether to keep the result in your library. They are remembered.
- **In your language.** The popup and the settings page come in English, Spanish, German, French and Bosnian, following the
  browser's language.
- **Light and dark**, following the browser, and usable with a keyboard and a screen reader.

## Trying it out in Chrome (developer mode)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Choose **Load unpacked** and pick this `extension/` folder.
3. On your Inkling account page, make an **API key** (an expiry and a daily limit are a good idea for a key that lives in a browser).
4. Click the extension's icon, then **Open settings**. Enter the address of your Inkling server (for the stack in this repository,
   `http://localhost:8080`) and the key, and press **Save**. The browser asks once whether the extension may talk to that one address.
5. Open any web page and press the extension's icon.

**Test the connection** on the settings page shows the key's name and how much of its daily limit is used.

## Trying it out in Firefox

Firefox needs its own manifest (an add-on id, and a statement of what data the add-on collects; Chrome's minimum version is dropped), so
build the Firefox version first and load that, not the folder itself:

```bash
python scripts/package_extension.py --firefox --unpacked dist/firefox
```

1. Open `about:debugging#/runtime/this-firefox` and choose **Load Temporary Add-on...**.
2. Pick `dist/firefox/manifest.json`. (A temporary add-on is removed when Firefox closes; for a permanent one, install the signed file
   from addons.mozilla.org, see below.)
3. Set it up exactly as for Chrome: make a key, open the add-on's settings (the add-on's **Preferences** in `about:addons`, or the gear
   in the popup), enter the address and the key, press **Save**, and allow access to that one address when Firefox asks.

It needs **Firefox 140 or newer** (140 is the extended-support release). Firefox for Android is declared as 142 or newer; it has not been tried.

What differs from Chrome, and is handled: Firefox runs the background file as an event page of scripts instead of a service worker (the Firefox manifest says so), the add-on has an id (`inkling-extension@oblutack.github.io`, set in `scripts/package_extension.py`;
change it if you publish under another name), Firefox sends no `Origin` on a plain `GET` (only on the `POST`, where it is `moz-extension://...`,
which the API allows for the `/v1` routes just as it allows `chrome-extension://...`), and a match pattern for a tab has no port.

## What it can access

| | |
| --- | --- |
| `activeTab` | Read the page you press the button on, and only then. Nothing is read in the background and no page is read until you ask. |
| `contextMenus` | Add the right-click entry for selected text. |
| `scripting` | Run the small reader function in that page. |
| `storage` | Keep your settings in this browser (never synced to other devices). |
| One server | When you save the settings the browser asks to let the extension talk to **the address you typed**, and to nothing else. |

The only background code is `background.js`, which adds the right-click entry and, when it is chosen, opens the popup's page in a small window: it reads no page, holds no key and makes no network request (a test checks that the file contains none of those). There is no content script that runs on every page, no analytics and no remote code. The key is sent only to
the address in the settings, as an `Authorization` header, and never together with your website cookie.
See [`docs/PRIVACY-EXTENSION.md`](../docs/PRIVACY-EXTENSION.md).

## How it talks to the server

It uses the API for programs (`docs/openapi.yaml`): `POST /v1/summarize-text` (or `/v1/summarize-url` for a page without text),
with `?save=true` when you ask to keep the result, `POST /v1/reading-list` for *Save for later*, `POST /v1/explain` for *Explain the selection*, and `GET /v1/usage` for the connection test. The server lets a request from a
browser extension through (and only for these `/v1` routes, and only with a key): see `ExtensionMayCallKeyRoutes` in
`go-api/middleware/security.go`. Pages of other websites are still refused, because a key does not belong in a web page.

## Layout

```text
manifest.json        Manifest V3: permissions, popup, settings page, icons, the background file
background.js        The right-click entry (adds it, opens the popup's page aimed at the tab)
popup.html/js/css    The popup: reads the page, asks for a summary, shows it
options.html/js/css  The settings page: address, key, defaults, test
ui.css               Colours and form styles shared by both (light and dark)
lib/settings.js      What is stored, and the checks on it (https only, except for this machine)
lib/api.js           The calls to the Inkling API (streamed, with a fallback to one reply) and what each failure is called
lib/stream.js        Reads the server-sent events of a streamed summary
lib/page.js          The function that runs inside the page to read it
lib/markdown.js      Draws the summary with DOM elements, never as HTML
lib/i18n.js          Words from _locales, and the sentence for each failure
_locales/            en, es, de, fr, bs
icons/               16, 32, 48 and 128 pixels
test/                Node's own test runner (no dependencies)
test/firefox/        Loads the Firefox build into a real Firefox (Selenium, a fake server)
```

## Tests

```bash
cd extension && npm test            # or: node --test "test/*.test.mjs"   (needs Node 22 or newer)
```

They check the settings rules, the API calls (with a fake `fetch`), the Markdown drawing (including that markup in a summary stays
text), and the package itself: the manifest asks for as little as possible, every language has every message, every message the
code asks for is written, and no page has an inline script or builds HTML from text.

The extension is also driven in a real Chromium by `frontend/e2e/extension.spec.ts` (settings, a page, a selection, the choices,
copying, a page with no text, a page the browser will not let extensions read, a wrong key, a key at its limit, a server that
cannot be reached, and accessibility). That test copies the extension and adds a fixed key and permission for localhost, which a
person gives in the browser's own prompt.

The Firefox build is loaded into a real Firefox by `test/firefox/run_firefox_test.py` (settings, a page, a selection, a wrong key, a server
that cannot be reached; 23 checks), against a small fake Inkling server that writes down what it is sent: that the key arrives, that the
server sees the add-on's own `moz-extension://` origin, and that no cookie goes with it. It also checks that the page text it reads is the
article and not the menu or the footer.

```bash
pip install selenium
python extension/test/firefox/run_firefox_test.py    # needs Firefox; Selenium fetches the driver itself
npx web-ext lint -s dist/firefox                     # Mozilla's own rules for add-ons (build dist/firefox first)
```

CI runs both on every push. Two things about driving Firefox that are not obvious: Selenium installs the add-on through WebDriver BiDi, by
path (its older `install_addon` hands Firefox a file that Firefox keeps open, which Windows then will not let the driver delete), and newer
Firefox no longer lets WebDriver navigate to a page of an add-on at all (`Navigation to "moz-extension://..." is not allowed in this
context`), so the test opens the settings page and the popup the way a link would, with `window.open` from an ordinary page. For that, the
test's copy of the manifest lists those two pages as web-accessible for localhost only; the real manifest does not.

## Packaging and publishing

```bash
python scripts/package_extension.py            # Chrome:  dist/inkling-extension-<version>.zip
python scripts/package_extension.py --firefox  # Firefox: dist/inkling-extension-<version>-firefox.zip
```

The zips hold only what runs (no tests, no README). CI builds both on every push and keeps them for two weeks.

To publish: raise `version` in `manifest.json`, build the zip, and upload it in the
[Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole) (a one-time registration fee applies).
The listing needs: the description from `_locales/en/messages.json`, at least one screenshot (1280×800), a link to the privacy note
above, and a short reason for each permission (the table above).

For Firefox, upload the `-firefox` zip at [addons.mozilla.org/developers](https://addons.mozilla.org/developers/). There is no build step,
so there is no separate source package to send. The add-on id and the data statement (`data_collection_permissions`: none, because
what the add-on sends goes only to the server the person chose) are in the Firefox manifest that the script writes.
