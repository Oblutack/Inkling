// Words for the screen come from _locales (the browser picks the language), never from the page.

const api = () => (typeof chrome !== "undefined" && chrome.i18n ? chrome.i18n : null);

// t("quotaLeft", 5) -> "5 summaries left today." (substitutions are numbers or text, in the order of the message).
export function t(key, ...substitutions) {
  const text = api()?.getMessage(key, substitutions.map(String));
  return text || key;
}

// Fills every element that says what it needs: data-i18n="key" for its text, data-i18n-attr="aria-label:key,title:key"
// for attributes.
export function translatePage(root = document) {
  for (const element of root.querySelectorAll("[data-i18n]")) element.textContent = t(element.dataset.i18n);
  for (const element of root.querySelectorAll("[data-i18n-attr]")) {
    for (const pair of element.dataset.i18nAttr.split(",")) {
      const [attribute, key] = pair.split(":").map((s) => s.trim());
      if (attribute && key) element.setAttribute(attribute, t(key));
    }
  }
  const lang = api()?.getUILanguage?.();
  if (lang) document.documentElement.lang = lang;
}

// The sentence for a failure (see InklingError in api.js).
export function errorText(error, host) {
  switch (error.code) {
    case "network":
      return t("errNetwork", host);
    case "invalid_key":
      return t("errInvalidKey");
    case "expired_key":
      return t("errExpiredKey");
    case "key_limit":
      return t("errKeyLimit");
    case "quota":
      return t("errQuota");
    case "rate_limited":
      return error.retryAfter > 0 ? t("errRateLimit", error.retryAfter) : t("errRateLimitSoon");
    case "list_full":
      return t("errListFull");
    case "too_large":
      return t("errTooLarge");
    case "paused":
      return t("errPaused");
    case "ai_failed":
      return t("errAi");
    case "bad_request":
      return t("errBadRequest", error.detail || String(error.status));
    default:
      return t("errUnknown", error.status || "?");
  }
}
