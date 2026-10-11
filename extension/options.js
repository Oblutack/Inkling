import { InklingError, keyUsage } from "./lib/api.js";
import { errorText, t, translatePage } from "./lib/i18n.js";
import { LANGUAGES, LENGTHS, STYLES, hostOf, loadSettings, looksLikeKey, normalizeBaseUrl, permissionPattern, saveSettings } from "./lib/settings.js";

const $ = (id) => document.getElementById(id);

function option(value, text) {
  return Object.assign(document.createElement("option"), { value, textContent: text });
}

function fillChoices(settings) {
  const names = new Intl.DisplayNames([chrome.i18n.getUILanguage()], { type: "language" });
  $("language").replaceChildren(
    ...LANGUAGES.map(([name, code]) => {
      let label = name;
      try {
        label = names.of(code) || name;
      } catch {
        // a language the browser has no name for: the English name stays
      }
      return option(name, label);
    }),
  );
  $("length").replaceChildren(...LENGTHS.map(({ words, label }) => option(String(words), t(label))));
  const styleLabels = { default: "styleDefault", bullets: "styleBullets", brief: "styleBrief", simple: "styleSimple", takeaways: "styleTakeaways" };
  $("style").replaceChildren(...STYLES.map((s) => option(s, t(styleLabels[s]))));
  $("language").value = settings.language;
  $("length").value = String(settings.wordCount);
  $("style").value = settings.style;
  $("keep").checked = settings.save;
  $("address").value = settings.baseUrl;
  $("key").value = settings.apiKey;
}

function say(message, ok = false) {
  $("status").textContent = message;
  $("status").className = ok ? "ok" : "";
}

function problem(field, message) {
  const error = $(`${field}-error`);
  error.textContent = message;
  error.hidden = !message;
  $(field).setAttribute("aria-invalid", message ? "true" : "false");
}

// What was typed, checked. Returns { baseUrl, apiKey } or null (with the problems shown).
function readForm() {
  const address = normalizeBaseUrl($("address").value);
  const key = $("key").value.trim();
  problem("address", address.ok ? "" : t("errAddress"));
  problem("key", looksLikeKey(key) ? "" : t("errKeyFormat"));
  if (!address.ok) {
    $("address").focus();
    return null;
  }
  if (!looksLikeKey(key)) {
    $("key").focus();
    return null;
  }
  return { baseUrl: address.url, apiKey: key };
}

// The browser is asked, once, to let this extension talk to that one server (and to nothing else).
async function allowServer(baseUrl) {
  const origins = [permissionPattern(baseUrl)];
  return (await chrome.permissions.contains({ origins })) || chrome.permissions.request({ origins });
}

async function save() {
  say("");
  const form = readForm();
  if (!form) return null;
  if (!(await allowServer(form.baseUrl))) {
    say(t("permissionDenied"));
    return null;
  }
  const saved = await saveSettings({
    ...form,
    language: $("language").value,
    wordCount: Number($("length").value),
    style: $("style").value,
    save: $("keep").checked,
  });
  $("address").value = saved.baseUrl;
  say(t("saved"), true);
  return saved;
}

async function test() {
  const saved = await save();
  if (!saved) return;
  try {
    const usage = await keyUsage({ baseUrl: saved.baseUrl, apiKey: saved.apiKey });
    say(
      usage.dailyLimit === null
        ? t("testOkNoLimit", usage.name, usage.usedToday)
        : t("testOk", usage.name, usage.usedToday, usage.dailyLimit),
      true,
    );
  } catch (error) {
    say(error instanceof InklingError ? errorText(error, hostOf(saved.baseUrl)) : t("errUnknown", "?"));
  }
}

async function init() {
  translatePage();
  fillChoices(await loadSettings());
  $("form").addEventListener("submit", (event) => {
    event.preventDefault();
    save();
  });
  $("test").addEventListener("click", test);
  $("toggle-key").addEventListener("click", () => {
    const hidden = $("key").type === "password";
    $("key").type = hidden ? "text" : "password";
    $("toggle-key").textContent = t(hidden ? "hideKey" : "showKey");
    $("toggle-key").setAttribute("aria-pressed", String(hidden));
  });
}

init();
