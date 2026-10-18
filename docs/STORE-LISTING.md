# Store listing text for the browser extension

Ready to paste into the Chrome Web Store dashboard and into addons.mozilla.org. The extension's name and short description are
the ones in `extension/_locales/en/messages.json`; the rest is below. Build the packages first
(`python scripts/package_extension.py` and `python scripts/package_extension.py --firefox`).

## Name and short description

**Inkling**

Summarize the page you are reading, or the text you have selected, with your Inkling account.

## Full description

Inkling for the browser turns any web page, or any text you select, into a short summary you can read in a small popup.

- **One press.** Click the toolbar button to summarize the page, or select some text and click it (or right-click and choose
  "Summarize the selection with Inkling") to summarize just that.
- **Watch it being written.** The summary appears as it is written. Press Stop to keep what is there so far.
- **Your choices.** Length (about 100 to 500 words), style (standard, bullet points, brief, simple language, key takeaways) and
  language (15 languages). They are remembered.
- **Keep or copy.** Copy the summary, or keep it in your Inkling library.
- **Save for later.** Put the page on your Inkling reading list with a short summary, and read it when you have time.
- **Private by design.** Nothing is read until you press the button, nothing is sent to anyone but your own Inkling server, and
  there is no analytics, advertising or tracking. The extension can reach only the one server address you give it.
- **In your language.** The extension speaks English, Spanish, German, French and Bosnian, and follows your browser's light or
  dark theme. It works with a keyboard and a screen reader.

This extension needs an Inkling account and an API key (made on the account page of the Inkling site you use). It does nothing
until you have entered the address of your Inkling server and your key in its settings.

## Single purpose (Chrome asks for this)

Summarize the web page or selected text the person is looking at, using their own Inkling account.

## Why each permission (Chrome and Firefox both ask)

| Permission | Reason to give |
| --- | --- |
| `activeTab` | Reads the text of the page the person pressed the button on, only at that moment. No page is read in the background and no other tab is touched. |
| `scripting` | Runs one small function in that page, once, to collect its text and the selected text. There is no content script on every page. |
| `contextMenus` | Adds the right-click entry "Summarize the selection with Inkling" for selected text. |
| `storage` | Keeps the person's settings (server address, API key, summary choices) in this browser only. They are not synced. |
| Optional host permission for one address | When the person saves the settings, the browser asks to let the extension talk to the one Inkling server address they typed, and nothing else. It is how the page text and the API key reach their own server. |

## Remote code

None. All the code is in the package; nothing is downloaded or run from elsewhere.

## Data the extension handles (the privacy questionnaires)

- **What is collected, and by whom:** nothing is collected by the publisher. At the person's request the text of the page or
  selection, their summary choices and their API key are sent to the Inkling server address they entered themselves. That is
  their own service; it is not shared with the publisher or any third party.
- **Sold, used for unrelated purposes, or used for creditworthiness:** no.
- **Firefox data-collection declaration:** none (`data_collection_permissions: none` in the manifest).
- **Privacy policy link:** `https://github.com/Oblutack/Inkling/blob/main/docs/PRIVACY-EXTENSION.md`

## Categories and support

- Category: Productivity (Chrome); Other or Productivity (Firefox).
- Support link: `https://github.com/Oblutack/Inkling/issues`
- Home page: `https://github.com/Oblutack/Inkling`

## Screenshots (Chrome wants 1280x800 or 640x400; Firefox accepts any size)

Take these against a running stack, in the order they tell the story:

1. The popup on an article, before pressing the button (shows the length, style and language choices).
2. The summary being written, with the Stop button.
3. The finished summary with Copy and "Summarize again".
4. The settings page with the address and key filled in (blur the key).
5. The right-click menu entry on selected text.

## Before submitting

- The developer account is the owner's: a one-time fee for Chrome, free for Firefox.
- Raise `version` in `extension/manifest.json` for every upload after the first.
- If the add-on id `inkling-extension@oblutack.github.io` is not the one to publish under, change it in `scripts/package_extension.py`
  before the first Firefox upload: the id cannot change afterwards.
