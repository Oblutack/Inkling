// Runs INSIDE the web page (the browser copies this function there), so it can use nothing from outside itself: no
// imports and no other helper. It reads, it changes nothing, and what it returns is plain data.
//
// Returns { title, url, selection, text }: the page's title and address, what is selected, and the readable text of
// the page (the main part of it, when the page marks one: not the menus, the footer or what is hidden).
export function readPage() {
  const LIMIT = 250000;
  const collapse = (s) =>
    String(s || "")
      .replace(/ /g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  let selection = "";
  try {
    selection = collapse(String(window.getSelection ? window.getSelection() : ""));
  } catch {
    selection = "";
  }

  // innerText gives what is shown: it leaves out scripts, styles and hidden things, and keeps line breaks.
  const textOf = (element) => (element && typeof element.innerText === "string" ? collapse(element.innerText) : "");
  const candidates = ["article", "main", "[role='main']", "#content", ".content"]
    .map((selector) => {
      try {
        return textOf(document.querySelector(selector));
      } catch {
        return "";
      }
    })
    .filter((text) => text.length >= 400);
  const whole = textOf(document.body);
  // The marked-up main part, when it holds most of the page; otherwise the whole page (some sites mark up very little).
  const main = candidates.sort((a, b) => b.length - a.length)[0] || "";
  const text = main && main.length >= whole.length * 0.4 ? main : whole;

  return {
    title: collapse(document.title).slice(0, 300),
    url: location.href,
    selection: selection.slice(0, LIMIT),
    text: text.slice(0, LIMIT),
  };
}
