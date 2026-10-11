import { InklingError, summarizeText, summarizeUrl } from "./lib/api.js";
import { errorText, t, translatePage } from "./lib/i18n.js";
import { renderMarkdown } from "./lib/markdown.js";
import { readPage } from "./lib/page.js";
import { LENGTHS, STYLES, hostOf, isConfigured, loadSettings, normalizeBaseUrl, permissionPattern, saveSettings } from "./lib/settings.js";

// Below this much readable text a page is probably not a web page of text (the browser's own PDF viewer, a picture):
// the server is asked to read its address instead.
const TOO_LITTLE_TEXT = 200;

const $ = (id) => document.getElementById(id);
const sections = ["setup", "access", "ready", "working", "result"];

let settings;
let tab = null; // { id, title, url } of the page being read
let page = null; // what readPage returned
let markdown = "";
let controller = null;

function show(name) {
  for (const id of sections) $(id).hidden = id !== name;
}

function showError(message) {
  $("error").textContent = message;
  $("error").hidden = !message;
}

async function targetTab() {
  const wanted = Number(new URLSearchParams(location.search).get("tab"));
  if (Number.isInteger(wanted) && wanted > 0) return chrome.tabs.get(wanted);
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  return active ?? null;
}

async function read() {
  try {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPage });
    return injection?.result ?? null;
  } catch {
    return null; // a page the browser does not let extensions read (its own settings pages, the web store)
  }
}

function fillChoices() {
  const length = $("length");
  length.replaceChildren(
    ...LENGTHS.map(({ words, label }) => Object.assign(document.createElement("option"), { value: String(words), textContent: t(label) })),
  );
  const style = $("style");
  const names = { default: "styleDefault", bullets: "styleBullets", brief: "styleBrief", simple: "styleSimple", takeaways: "styleTakeaways" };
  style.replaceChildren(...STYLES.map((s) => Object.assign(document.createElement("option"), { value: s, textContent: t(names[s]) })));
  length.value = String(settings.wordCount);
  style.value = settings.style;
  $("keep").checked = settings.save;
}

function wordsIn(text) {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

async function showReady() {
  showError("");
  const pattern = permissionPattern(normalizeBaseUrl(settings.baseUrl).url);
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
    $("access-text").textContent = t("allowText", hostOf(settings.baseUrl));
    show("access");
    return;
  }
  page = await read();
  if (!page) {
    show("ready");
    $("page-title").textContent = tab?.title || t("untitledPage");
    $("page-host").textContent = "";
    $("summarize-page").disabled = true;
    $("summarize-selection").hidden = true;
    showError(t("cannotRead"));
    return;
  }
  $("summarize-page").disabled = false;
  $("page-title").textContent = page.title || t("untitledPage");
  $("page-host").textContent = hostOf(page.url);
  const selected = wordsIn(page.selection);
  $("selection-info").hidden = selected === 0;
  $("selection-info").textContent = selected ? t("selectionInfo", selected) : "";
  $("summarize-selection").hidden = selected === 0;
  $("summarize-page").classList.toggle("secondary", selected > 0); // with a selection offered, the page is the quieter choice
  show("ready");
  (selected ? $("summarize-selection") : $("summarize-page")).focus();
}

async function run(useSelection) {
  showError("");
  controller = new AbortController();
  show("working");
  $("working-text").textContent = t("working");
  const choices = { language: settings.language, wordCount: settings.wordCount, style: settings.style, save: settings.save };
  const common = { baseUrl: normalizeBaseUrl(settings.baseUrl).url, apiKey: settings.apiKey.trim(), signal: controller.signal, ...choices };
  try {
    let result;
    if (useSelection) {
      result = await summarizeText({ ...common, text: page.selection });
    } else if (page.text.length < TOO_LITTLE_TEXT && /^https?:/i.test(page.url)) {
      result = await summarizeUrl({ ...common, url: page.url });
    } else if (page.text.trim()) {
      result = await summarizeText({ ...common, text: page.title ? `${page.title}\n\n${page.text}` : page.text });
    } else {
      throw new InklingError("no_text");
    }
    markdown = result.summary;
    renderMarkdown(markdown, $("summary"));
    const notes = [];
    if (result.id) notes.push(t("savedNote"));
    if (result.quotaRemaining !== null) notes.push(t("quotaLeft", result.quotaRemaining));
    $("result-note").textContent = notes.join(" ");
    show("result");
    $("summary").focus();
  } catch (error) {
    if (error && error.name === "AbortError") {
      await showReady();
      return;
    }
    show("ready");
    showError(error instanceof InklingError ? (error.code === "no_text" ? t("noText") : errorText(error, hostOf(settings.baseUrl))) : t("errUnknown", "?"));
  } finally {
    controller = null;
  }
}

async function init() {
  translatePage();
  settings = await loadSettings();
  $("open-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("setup-button").addEventListener("click", () => chrome.runtime.openOptionsPage());
  if (!isConfigured(settings)) {
    show("setup");
    return;
  }
  fillChoices();
  tab = await targetTab();
  if (!tab || typeof tab.id !== "number") {
    show("ready");
    $("summarize-page").disabled = true;
    showError(t("cannotRead"));
    return;
  }

  $("length").addEventListener("change", async () => {
    settings = await saveSettings({ wordCount: Number($("length").value) });
  });
  $("style").addEventListener("change", async () => {
    settings = await saveSettings({ style: $("style").value });
  });
  $("keep").addEventListener("change", async () => {
    settings = await saveSettings({ save: $("keep").checked });
  });
  $("summarize-page").addEventListener("click", () => run(false));
  $("summarize-selection").addEventListener("click", () => run(true));
  $("cancel").addEventListener("click", () => controller?.abort());
  $("again").addEventListener("click", () => showReady());
  $("allow-button").addEventListener("click", async () => {
    const granted = await chrome.permissions.request({ origins: [permissionPattern(normalizeBaseUrl(settings.baseUrl).url)] });
    if (granted) await showReady();
    else showError(t("permissionDenied"));
  });
  $("copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      $("copy").textContent = t("copied");
      setTimeout(() => ($("copy").textContent = t("copy")), 1500);
    } catch {
      // the clipboard is not available: the text is still there to select
    }
  });

  await showReady();
}

init().catch(() => showError(t("errUnknown", "?")));
