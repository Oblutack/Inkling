import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const manifest = JSON.parse(read("manifest.json"));

function* files(dir) {
  for (const name of readdirSync(join(root, dir))) {
    const path = join(dir, name);
    if (statSync(join(root, path)).isDirectory()) yield* files(path);
    else yield path.replaceAll("\\", "/");
  }
}

test("the manifest is a Manifest V3 one that asks for as little as it can", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual([...manifest.permissions].sort(), ["activeTab", "scripting", "storage"]);
  assert.equal(manifest.host_permissions, undefined, "no host is allowed up front: the person allows one server when they set it up");
  assert.ok(manifest.optional_host_permissions.every((p) => /^(https:\/\/\*|http:\/\/(localhost|127\.0\.0\.1))\/\*$/.test(p)), "only https servers, and this machine");
  assert.equal(manifest.background, undefined, "nothing runs in the background");
  assert.equal(manifest.content_scripts, undefined, "no page is read until the person asks");
});

test("every file the manifest names is there, and every icon is the size it says", () => {
  const named = [manifest.action.default_popup, manifest.options_ui.page, ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
  for (const path of named) assert.ok(existsSync(join(root, path)), path);
  for (const [size, path] of Object.entries(manifest.icons)) {
    const png = readFileSync(join(root, path));
    assert.equal(png.readUInt32BE(16), Number(size), `${path} width`);
    assert.equal(png.readUInt32BE(20), Number(size), `${path} height`);
  }
});

const locales = readdirSync(join(root, "_locales"));
const messages = (lang) => JSON.parse(read(`_locales/${lang}/messages.json`));

test("there are the five languages of the website, and each has every message", () => {
  assert.deepEqual(locales.sort(), ["bs", "de", "en", "es", "fr"]);
  const english = Object.keys(messages("en")).sort();
  for (const lang of locales) assert.deepEqual(Object.keys(messages(lang)).sort(), english, lang);
});

test("a placeholder is in the message of every language, with the same $1, $2 order", () => {
  const english = messages("en");
  for (const lang of locales) {
    const m = messages(lang);
    for (const [key, entry] of Object.entries(m)) {
      assert.ok(entry.message.trim(), `${lang}.${key} is empty`);
      assert.deepEqual(entry.placeholders ?? {}, english[key].placeholders ?? {}, `${lang}.${key} placeholders`);
      for (const name of Object.keys(entry.placeholders ?? {})) assert.ok(entry.message.includes(`$${name.toUpperCase()}$`), `${lang}.${key} lacks $${name.toUpperCase()}$`);
      assert.equal((entry.message.match(/\$[A-Z]+\$/g) ?? []).length, Object.keys(entry.placeholders ?? {}).length, `${lang}.${key}`);
    }
  }
});

test("the store texts fit the store's limits", () => {
  for (const lang of locales) {
    const m = messages(lang);
    assert.ok(m.extName.message.length <= 45, lang);
    assert.ok(m.extDescription.message.length <= 132, `${lang} description is ${m.extDescription.message.length}`);
  }
});

test("every message the code or a page asks for exists", () => {
  const english = messages("en");
  const asked = new Set();
  for (const path of files(".")) {
    if (path.startsWith("test/") || path.startsWith("_locales/")) continue;
    const text = read(path);
    if (path.endsWith(".html")) {
      for (const m of text.matchAll(/data-i18n="(\w+)"/g)) asked.add(m[1]);
      for (const m of text.matchAll(/data-i18n-attr="([^"]+)"/g)) for (const pair of m[1].split(",")) asked.add(pair.split(":")[1].trim());
    }
    if (path.endsWith(".js")) {
      for (const m of text.matchAll(/\bt\("(\w+)"/g)) asked.add(m[1]);
      // a message chosen by a condition or a table is named in quotes too: t(hidden ? "hideKey" : "showKey")
      for (const m of text.matchAll(/"(\w+)"/g)) if (english[m[1]]) asked.add(m[1]);
      for (const m of text.matchAll(/"(err[A-Z]\w+)"/g)) asked.add(m[1]); // a message that is asked for must be written
    }
  }
  for (const m of JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)) asked.add(m[1]);
  for (const key of asked) assert.ok(english[key], `message "${key}" is asked for but not written`);
  for (const key of Object.keys(english)) assert.ok(asked.has(key), `message "${key}" is written but nothing asks for it`);
});

test("the pages run no inline script and load nothing from elsewhere", () => {
  for (const path of files(".")) {
    if (!path.endsWith(".html")) continue;
    const text = read(path);
    assert.ok(!/<script(?![^>]*\bsrc=)/i.test(text), `${path} has an inline script`);
    assert.ok(!/\son\w+\s*=/i.test(text), `${path} has an inline event handler`);
    assert.ok(!/(src|href)="https?:/i.test(text), `${path} loads something from the web`);
  }
});

test("the code never builds markup from text, and never runs text as code", () => {
  for (const path of files(".")) {
    if (!path.endsWith(".js") || path.startsWith("test/")) continue;
    const text = read(path);
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(text), `${path} writes HTML`);
    assert.ok(!/\beval\s*\(|new Function\s*\(/.test(text), `${path} runs text as code`);
  }
});
