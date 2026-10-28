#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

// Node.js 18+ required because this script uses the built-in fetch().

const ACTUAL_URLS = [
  "https://devnew-sfas.etisalat.ae/content/dam/moi/fireproducts2.png",

  "https://devnew-smarthomesecurity.etisalat.ae/content/dam/shs/resources/img/home.jpg",

  "https://devnew.fivemobile.ae/content/dam/fivemobile/homebanner-fivemobile-18oct2018.jpg",

  "https://devnew.ewallet.ae/content/dam/emoney/img/financial-app-promo/first-section-mobile-1.png",

  "https://devnew.gochatapp.net/content/dam/gochat/new-revamp/resources/img/media/hero-banner-1.png"
];

const OUTPUT_FILE = path.join(__dirname, "url-test-results.csv");

const REQUEST_TIMEOUT = 15000;

// Maximum number of requests running at the same time.
// Keep this reasonably low so the servers are not overloaded.
const CONCURRENCY = 5;

/**
 * Generate 3 JSON patterns for a folder.
 *
 * Example:
 * /content/dam
 *
 * becomes:
 * /content/dam.json
 * /content/dam.1.json
 * /content/dam/1.json
 */
function generateFolderJsonUrls(origin, folderPath) {
  return [
    {
      type: "folder-json",
      testUrl: `${origin}${folderPath}.json`
    },
    {
      type: "folder-1-json",
      testUrl: `${origin}${folderPath}.1.json`
    },
    {
      type: "folder-child-1-json",
      testUrl: `${origin}${folderPath}/1.json`
    }
  ];
}

/**
 * Generates all required test URLs for one actual asset URL.
 */
function generateTestUrls(actualUrl) {
  const parsed = new URL(actualUrl);

  const origin = parsed.origin;
  const pathname = parsed.pathname;

  const segments = pathname.split("/").filter(Boolean);

  const results = [];

  // ---------------------------------------------------------
  // Generate tests for every folder.
  //
  // Example:
  // /content/dam/shs/resources/img/home.jpg
  //
  // Folder levels:
  // /content
  // /content/dam
  // /content/dam/shs
  // /content/dam/shs/resources
  // /content/dam/shs/resources/img
  // ---------------------------------------------------------

  let currentPath = "";

  for (let i = 0; i < segments.length - 1; i++) {
    currentPath += `/${segments[i]}`;

    const folderUrls = generateFolderJsonUrls(origin, currentPath);
    results.push(...folderUrls);
  }

  // ---------------------------------------------------------
  // Asset-specific tests
  // ---------------------------------------------------------

  const assetPath = pathname;

  results.push(
    {
      type: "asset-json",
      testUrl: `${origin}${assetPath}.json`
    },
    {
      type: "asset-1-json",
      testUrl: `${origin}${assetPath}.1.json`
    },
    {
      type: "asset-double-dot-1-json",
      testUrl: `${origin}${assetPath}..1.json`
    },
    {
      type: "asset-child-double-dot-1-json",
      testUrl: `${origin}${assetPath}/..1.json`
    },

    // JCR content tests
    {
      type: "jcr-renditions",
      testUrl: `${origin}${assetPath}/jcr:content/renditions.7.json`
    },
    {
      type: "jcr-related",
      testUrl: `${origin}${assetPath}/jcr:content/related.7.json`
    },
    {
      type: "jcr-metadata",
      testUrl: `${origin}${assetPath}/jcr:content/metadata.7.json`
    }
  );

  return results.map(item => ({
    actualUrl,
    ...item
  }));
}


/**
 * Test one URL.
 */
async function testUrl(item) {
  const start = Date.now();

  try {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT);

    const response = await fetch(item.testUrl, {
      method: "GET",

      // Follow redirect so we can identify where the URL finally lands.
      redirect: "follow",

      signal: controller.signal,

      headers: {
        "User-Agent": "URL-404-Test/1.0",
        Accept: "application/json,text/plain,*/*"
      }
    });

    clearTimeout(timeout);

    const responseTime = Date.now() - start;

    let status;

    if (response.status === 404) {
      status = "404";
    } else {
      status = "NOT_404";
    }

    return {
      actualUrl: item.actualUrl,
      type: item.type,
      testUrl: item.testUrl,
      httpStatus: response.status,
      statusText: response.statusText,
      result: status,
      redirected: response.redirected ? "YES" : "NO",
      finalUrl: response.url,
      contentType: response.headers.get("content-type") || "",
      responseTimeMs: responseTime,
      error: ""
    };

  } catch (error) {

    return {
      actualUrl: item.actualUrl,
      type: item.type,
      testUrl: item.testUrl,
      httpStatus: "",
      statusText: "",
      result: "ERROR",
      redirected: "",
      finalUrl: "",
      contentType: "",
      responseTimeMs: Date.now() - start,
      error:
        error.name === "AbortError"
          ? "Request timeout"
          : error.message
    };
  }
}


/**
 * Simple concurrency-controlled runner.
 */
async function runWithConcurrency(items, limit) {
  const results = [];

  let nextIndex = 0;

  async function worker(workerId) {

    while (true) {

      const index = nextIndex++;

      if (index >= items.length) {
        return;
      }

      const item = items[index];

      console.log(
        `[${index + 1}/${items.length}] Testing: ${item.testUrl}`
      );

      const result = await testUrl(item);

      results[index] = result;

      console.log(
        `    -> HTTP ${result.httpStatus || "ERROR"} | ${result.result}` +
        (result.redirected === "YES"
          ? ` | redirected to ${result.finalUrl}`
          : "")
      );
    }
  }

  const workerCount = Math.min(limit, items.length);

  await Promise.all(
    Array.from(
      { length: workerCount },
      (_, i) => worker(i + 1)
    )
  );

  return results;
}


/**
 * Escape values correctly for CSV.
 */
function csvEscape(value) {
  if (value === null || value === undefined) {
    return "";
  }

  const str = String(value);

  if (
    str.includes(",") ||
    str.includes('"') ||
    str.includes("\n") ||
    str.includes("\r")
  ) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}


/**
 * Write final result to CSV.
 */
function writeCsv(results) {

  const headers = [
    "Actual URL",
    "Test Type",
    "Test URL",
    "HTTP Status",
    "Status Text",
    "404 Result",
    "Redirected",
    "Final URL",
    "Content Type",
    "Response Time (ms)",
    "Error"
  ];

  const rows = results.map(result => [
    result.actualUrl,
    result.type,
    result.testUrl,
    result.httpStatus,
    result.statusText,
    result.result,
    result.redirected,
    result.finalUrl,
    result.contentType,
    result.responseTimeMs,
    result.error
  ]);

  const csv = [
    headers.map(csvEscape).join(","),
    ...rows.map(row =>
      row.map(csvEscape).join(",")
    )
  ].join("\n");

  fs.writeFileSync(
    OUTPUT_FILE,
    "\uFEFF" + csv,
    "utf8"
  );
}


/**
 * Main
 */
async function main() {

  console.log("\n========================================");
  console.log(" URL JSON / 404 Tester");
  console.log("========================================\n");

  const allTestUrls = [];

  for (const actualUrl of ACTUAL_URLS) {

    const generated = generateTestUrls(actualUrl);

    console.log(`Actual URL: ${actualUrl}`);
    console.log(`Generated   : ${generated.length} test URLs\n`);

    allTestUrls.push(...generated);
  }

  // Remove duplicates while preserving tests belonging
  // to different actual URLs.
  const unique = [];

  const seen = new Set();

  for (const item of allTestUrls) {

    const key = `${item.actualUrl}|${item.testUrl}`;

    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }

  console.log("----------------------------------------");
  console.log(`Total URLs to test: ${unique.length}`);
  console.log("----------------------------------------\n");

  const results = await runWithConcurrency(
    unique,
    CONCURRENCY
  );

  writeCsv(results);

  // Summary
  const count404 =
    results.filter(r => r.result === "404").length;

  const countNot404 =
    results.filter(r => r.result === "NOT_404").length;

  const countErrors =
    results.filter(r => r.result === "ERROR").length;

  const redirected =
    results.filter(r => r.redirected === "YES").length;

  console.log("\n========================================");
  console.log(" SUMMARY");
  console.log("========================================");
  console.log(`Total tested : ${results.length}`);
  console.log(`404          : ${count404}`);
  console.log(`Not 404      : ${countNot404}`);
  console.log(`Errors       : ${countErrors}`);
  console.log(`Redirected   : ${redirected}`);
  console.log("----------------------------------------");
  console.log(`CSV created  : ${OUTPUT_FILE}`);
  console.log("========================================\n");
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});