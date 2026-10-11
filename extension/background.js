// The right-click entry "Summarize the selection with Inkling". This is all the background code does: it adds the entry, and
// when it is chosen it opens the popup's own page in a small window aimed at the tab (popup.html?tab=...&selection=1), which
// reads the selection and asks for the summary exactly as the toolbar button does. This code reads no page, holds no key and
// makes no network request: everything that touches the page or the server stays in popup.js, after a person has asked.

const MENU_ID = "inkling-summarize-selection";
const WINDOW = { type: "popup", width: 440, height: 700 };

function addMenu() {
  // removing first means a restart or an update never leaves two entries (or an error about an entry that exists)
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: chrome.i18n.getMessage("menuSummarizeSelection"),
      contexts: ["selection"],
    });
  });
}

function openForSelection(tab) {
  if (!tab || typeof tab.id !== "number") return Promise.resolve();
  return chrome.windows.create({ url: chrome.runtime.getURL(`popup.html?tab=${tab.id}&selection=1`), ...WINDOW });
}

chrome.runtime.onInstalled.addListener(addMenu);
chrome.runtime.onStartup?.addListener(addMenu);
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) openForSelection(tab);
});

// The tests choose the entry without a mouse (a native menu cannot be clicked from a test).
globalThis.inklingBackground = { openForSelection };
