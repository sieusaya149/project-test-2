import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const publicDir = fileURLToPath(new URL("../public", import.meta.url));

// Every HTML page under public/ (not the JS/CSS assets).
const pages = readdirSync(publicDir)
  .filter((name) => name.endsWith(".html"))
  .sort();

assert.ok(pages.length > 0, "public/ should contain at least one HTML page");

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extracts an attribute's value from an opening tag, supporting either quote. */
function attribute(tag, name) {
  const match = tag.match(
    new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`, "i"),
  );
  return match ? match[1] : null;
}

function hasLang(html) {
  const tag = html.match(/<html\b[^>]*>/i)?.[0];
  return Boolean(tag && /\slang\s*=\s*["'][^"']+["']/i.test(tag));
}

function hasTitle(html) {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return Boolean(match && match[1].trim() !== "");
}

function hasMain(html) {
  return /<main\b/i.test(html);
}

function inputTags(html) {
  return html.match(/<input\b[^>]*>/gi) ?? [];
}

function imgTags(html) {
  return html.match(/<img\b[^>]*>/gi) ?? [];
}

/** An input is labeled by a `<label for>`, `aria-label`, `aria-labelledby`, or `title`. */
function inputIsLabeled(inputTag, html) {
  if (/\baria-label\s*=\s*["'][^"']+["']/i.test(inputTag)) return true;
  if (/\baria-labelledby\s*=\s*["'][^"']+["']/i.test(inputTag)) return true;
  if (/\btitle\s*=\s*["'][^"']+["']/i.test(inputTag)) return true;
  const id = attribute(inputTag, "id");
  if (id) {
    const labelFor = new RegExp(
      `<label\\b[^>]*\\sfor\\s*=\\s*["']${escapeRegExp(id)}["']`,
      "i",
    );
    if (labelFor.test(html)) return true;
  }
  return false;
}

function imgHasAlt(imgTag) {
  const alt = attribute(imgTag, "alt");
  return alt !== null && alt.trim() !== "";
}

test("every page under public/ is accessible", () => {
  for (const page of pages) {
    const html = readFileSync(join(publicDir, page), "utf8");
    assert.ok(hasLang(html), `${page}: <html> must have a lang attribute`);
    assert.ok(hasTitle(html), `${page}: must have a non-empty <title>`);
    assert.ok(hasMain(html), `${page}: must have a <main> element`);
    for (const input of inputTags(html)) {
      assert.ok(
        inputIsLabeled(input, html),
        `${page}: every <input> must have a label — unlabeled: ${input}`,
      );
    }
    for (const img of imgTags(html)) {
      assert.ok(
        imgHasAlt(img),
        `${page}: every <img> must have alt text — missing alt: ${img}`,
      );
    }
  }
});
