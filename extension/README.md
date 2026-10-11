# Inkling for the browser

A small extension that summarizes the page you are reading, or the text you have selected, with your own Inkling
account. Press the button, read the summary in the popup, copy it, or keep it in your Inkling library.

It has **no build step and no dependencies**: the code in this folder is what the browser runs.

## What it does

- **Summarize this page.** The extension reads the page's text in your browser (the article, not the menus, the footer or what
  is hidden) and sends it to your Inkling server. A page with no text of its own, such as a PDF in the browser's viewer, is handed to
  the server by its address instead.
- **Summarize the selection.** Select some text first and the button changes to summarize just that.
- **Your choices.** Length (about 100 to 500 words), style (standard, bullet points, brief, simple language, key takeaways),
  language (the 15 that Inkling writes in), and whether to keep the result in your library. They are remembered.
- **In your language.** The popup and the settings page come in English, Spanish, German, French and Bosnian, following the
  browser's language.
- **Light and dark**, following the browser, and usable with a keyboard and a screen reader.

## Trying it out (developer mode)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Choose **Load unpacked** and pick this `extension/` folder.
3. On your Inkling account page, make an **API key** (an expiry and a daily limit are a good idea for a key that lives in a browser).
4. Click the extension's icon, then **Open settings**. Enter the address of your Inkling server (for the stack in this repository,
   `http://localhost:8080`) and the key, and press **Save**. The browser asks once whether the extension may talk to that one address.
5. Open any web page and press the extension's icon.

**Test the connection** on the settings page shows the key's name and how much of its daily limit is used.

## What it can access

| | |
| --- | --- |
| `activeTab` | Read the page you press the button on, and only then. Nothing is read in the background and no page is read until you ask. |
| `scripting` | Run the small reader function in that page. |
| `storage` | Keep your settings in this browser (never synced to other devices). |
| One server | When you save the settings the browser asks to let the extension talk to **the address you typed**, and to nothing else. |

There is no background script, no content script that runs on every page, no analytics and no remote code. The key is sent only to
the address in the settings, as an `Authorization` header, and never together with your website cookie.
See [`docs/PRIVACY-EXTENSION.md`](../docs/PRIVACY-EXTENSION.md).

## How it talks to the server

It uses the API for programs (`docs/openapi.yaml`): `POST /v1/summarize-text` (or `/v1/summarize-url` for a page without text),
with `?save=true` when you ask to keep the result, and `GET /v1/usage` for the connection test. The server lets a request from a
browser extension through (and only for these `/v1` routes, and only with a key): see `ExtensionMayCallKeyRoutes` in
`go-api/middleware/security.go`. Pages of other websites are still refused, because a key does not belong in a web page.

## Layout

```text
manifest.json        Manifest V3: permissions, popup, settings page, icons
popup.html/js/css    The popup: reads the page, asks for a summary, shows it
options.html/js/css  The settings page: address, key, defaults, test
ui.css               Colours and form styles shared by both (light and dark)
lib/settings.js      What is stored, and the checks on it (https only, except for this machine)
lib/api.js           The calls to the Inkling API and what each failure is called
lib/page.js          The function that runs inside the page to read it
lib/markdown.js      Draws the summary with DOM elements, never as HTML
lib/i18n.js          Words from _locales, and the sentence for each failure
_locales/            en, es, de, fr, bs
icons/               16, 32, 48 and 128 pixels
test/                Node's own test runner (no dependencies)
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

## Packaging and publishing

```bash
python scripts/package_extension.py        # -> dist/inkling-extension-<version>.zip
```

The zip holds only what runs (no tests, no README). CI builds the same zip on every push and keeps it for two weeks.

To publish: raise `version` in `manifest.json`, build the zip, and upload it in the
[Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole) (a one-time registration fee applies).
The listing needs: the description from `_locales/en/messages.json`, at least one screenshot (1280×800), a link to the privacy note
above, and a short reason for each permission (the table above). Firefox was not tried: it would need at least a `browser_specific_settings` entry in the manifest.
