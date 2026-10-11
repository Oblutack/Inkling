# Privacy: the Inkling browser extension

This note is the same for the Chrome and the Firefox version. The extension summarizes a web page, or text you have selected, with **your own Inkling account**. This note says what it does with
your data, in plain words.

## What is sent, and when

Only when you press **Summarize this page** or **Summarize the selection**, the extension sends this to the Inkling address
you typed in its settings:

- the text of the page (or of your selection), with the page's title in front of it; or, for a page that has no text of its own
  (such as a PDF in the browser's viewer), the page's address, so the server can read it;
- your summary choices (length, style, language, and whether to keep the result in your library);
- your API key, in an `Authorization` header, so the server knows whose account to use.

Nothing is sent to anyone else: not to the people who make the extension, and not to any analytics, advertising or tracking service.
There is none.

## What is read, and when

Nothing is read in the background. The extension has no script that runs on the pages you visit; its one background file only adds the right-click entry ("Summarize the selection with Inkling") and, when you choose it, opens a small window that works exactly like the toolbar button: it reads the selection at that moment, because you asked, and sends it as described above. The extension reads a page only at the moment
you press the button on it (the `activeTab` permission lasts for that page until you leave it), and it reads the text, the title and
the address of that page, and what is selected on it. It does not read cookies, saved passwords or your other tabs, and it takes only what the page shows as text.

## What is stored

Your settings (the server's address, your API key and your choices) are stored in this browser, in the extension's own local
storage. They are not synced to your other devices and not sent anywhere except as described above. Removing the extension removes
them.

Summaries are not stored by the extension. If you tick **Keep it in my Inkling library**, the Inkling server keeps that summary in
your library, as it does for any summary you save on the website. Otherwise the server does not keep it.

## Permissions, and why

| Permission | Why |
| --- | --- |
| `activeTab` and `scripting` | To read the page you pressed the button on, and only that page. |
| `contextMenus` | To add the right-click entry for selected text. |
| `storage` | To keep your settings in this browser. |
| One server address, asked for when you save the settings | To send the request to your Inkling server. The browser asks you; nothing else is allowed. |

## Control

You can see and change everything on the extension's settings page. Revoke the API key on your Inkling account page and the
extension stops working at once. Remove the extension and everything it stored goes with it.

## Contact

Questions about this note: open an issue at <https://github.com/Oblutack/Inkling/issues>.
