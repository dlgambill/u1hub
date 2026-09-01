// test/affiliate-standalone.js — link-shaping rules for the Amazon associate
// tag (v2.19). Pure functions, no Hub, no network:
//
//   node test/affiliate-standalone.js
//
// The rules worth protecting are mostly about restraint. The tag goes on links
// this project generates and on the operator's own Amazon links; it never goes
// on a supplier link somebody typed in, and a search is never presented as a
// verified product listing.

"use strict";
const { buyLink, asinOf, isAmazonUrl, affiliateConf, DEFAULT_AMAZON_TAG } = require("../modules/resources.js");

let pass = 0, fail = 0;
const ok = (c, n, d) => { if (c) { pass++; console.log("  ok   " + n); }
  else { fail++; console.log("  FAIL " + n + (d === undefined ? "" : "  " + JSON.stringify(d))); } };

const ON  = { enabled: true,  amazon: "3dfil06-20" };
const OFF = { enabled: false, amazon: "3dfil06-20" };
const ROW = { brand: "Overture", material: "PLA", color_name: "Black" };

// --- ASIN extraction, across the URL shapes Amazon actually serves ----------
for (const [u, want] of [
  ["https://www.amazon.com/dp/B07PGY2L7N",                         "B07PGY2L7N"],
  ["https://www.amazon.com/dp/B07PGY2L7N/ref=sr_1_3?keywords=pla", "B07PGY2L7N"],
  ["https://www.amazon.com/gp/product/B07PGY2L7N",                 "B07PGY2L7N"],
  ["https://www.amazon.co.uk/Overture-PLA/dp/B07PGY2L7N?th=1",     "B07PGY2L7N"],
  ["https://www.amazon.com/s?k=pla+filament",                      null]
]) ok(asinOf(u) === want, "ASIN from " + u.slice(0, 58), { got: asinOf(u), want });

ok(isAmazonUrl("https://www.amazon.co.uk/x") === true, "amazon.co.uk is Amazon");
ok(isAmazonUrl("https://amazon.com/x") === true, "bare amazon.com is Amazon");
ok(isAmazonUrl("https://notamazon.com/x") === false, "notamazon.com is not");
ok(isAmazonUrl("https://amazon.com.evil.example/x") === false,
  "a lookalike host that merely CONTAINS amazon.com is not Amazon");

// --- a supplier link the user typed is never touched ------------------------
{
  const own = "https://www.matterhackers.com/store/l/pla-black/sk/M8V4KJ2L";
  const r = buyLink({ ...ROW, purchase_url: own }, ON);
  ok(r.url === own && r.kind === "supplier" && r.tagged === false,
    "a non-Amazon supplier link is returned untouched and untagged", r);
}

// --- the operator's own Amazon link gets normalised and tagged --------------
{
  const r = buyLink({ ...ROW, purchase_url: "https://www.amazon.com/Overture-PLA/dp/B07PGY2L7N/ref=sr_1_3?keywords=pla&qid=99" }, ON);
  ok(r.kind === "product", "an Amazon product link stays a product link", r.kind);
  ok(/^https:\/\/www\.amazon\.com\/dp\/B07PGY2L7N\?/.test(r.url),
    "…normalised to /dp/<ASIN>, dropping the tracking noise", r.url);
  ok(new URL(r.url).searchParams.get("tag") === ON.amazon, "…and carrying the tag", r.url);
  ok(r.tagged === true, "…and it says so, so the UI can disclose it");
}

// --- with the feature off, nothing is tagged --------------------------------
{
  const r = buyLink({ ...ROW, purchase_url: "https://www.amazon.com/dp/B07PGY2L7N?tag=someoneelse-20" }, OFF);
  ok(!new URL(r.url).searchParams.get("tag"),
    "off means the tag is REMOVED, not merely not added", r.url);
  ok(r.tagged === false, "…and the UI is told not to show a disclosure", r);
}

// --- no link on the spool: a search, honestly labelled ----------------------
{
  const r = buyLink({ ...ROW }, ON);
  ok(r.kind === "search", "a spool with no link falls back to a search", r.kind);
  const q = new URL(r.url).searchParams;
  ok(/Overture/.test(q.get("k")) && /PLA/.test(q.get("k")) && /Black/.test(q.get("k")),
    "…searching for the brand, material and colour of THAT spool", q.get("k"));
  ok(q.get("tag") === ON.amazon, "…tagged, since the link is ours to make", r.url);
  const off = buyLink({ ...ROW }, OFF);
  ok(!new URL(off.url).searchParams.get("tag"), "…and untagged when the feature is off", off.url);
}
{
  ok(buyLink({ purchase_url: "" }, ON) === null,
    "a spool with nothing to search for gets no button at all rather than a useless one");
}

// --- config resolution ------------------------------------------------------
ok(affiliateConf({}).amazon === DEFAULT_AMAZON_TAG,
  "an untouched config uses the project tag");
ok(affiliateConf({ affiliate: { amazon: "" } }).amazon === "",
  "an EXPLICITLY cleared tag stays cleared — 'never set' and 'turned off' are different");
ok(affiliateConf({ affiliate: { amazon: "not a valid tag!!" } }).amazon === "",
  "a malformed tag is dropped rather than pasted into URLs");
ok(affiliateConf({ affiliate: { enabled: false } }).enabled === false,
  "the off switch is respected");

console.log("\n" + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
