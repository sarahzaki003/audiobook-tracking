const fs = require("fs");
const path = require("path");
const https = require("https");
const cheerio = require("cheerio");

// ──────────────────────────────────────────────
// Paths
// ──────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, "config.json");
const DB_PATH = path.join(__dirname, "seen_books.json");
const LOG_PATH = path.join(__dirname, "tracker.log");

// ──────────────────────────────────────────────
// Logging
// ──────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + "\n");
}

// ──────────────────────────────────────────────
// Load / save seen books database
// ──────────────────────────────────────────────
function loadSeenBooks() {
  try {
    if (fs.existsSync(DB_PATH)) {
      return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
    }
  } catch (e) {
    log(`Warning: could not read ${DB_PATH}, starting fresh.`);
  }
  return {};
}

function saveSeenBooks(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ──────────────────────────────────────────────
// HTTP helpers
// ──────────────────────────────────────────────
function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsRequest(res.headers.location, options).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve({ statusCode: res.statusCode, body });
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

function fetchPage(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    };

    const req = https.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchPage(res.headers.location, retries).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        if (retries > 0) {
          log(`Got ${res.statusCode} for ${url}, retrying...`);
          setTimeout(() => fetchPage(url, retries - 1).then(resolve).catch(reject), 3000);
          res.resume();
          return;
        }
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    });

    req.on("error", (err) => {
      if (retries > 0) {
        log(`Request error: ${err.message}, retrying...`);
        setTimeout(() => fetchPage(url, retries - 1).then(resolve).catch(reject), 3000);
      } else reject(err);
    });

    req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Timeout for ${url}`)); });
  });
}

// ──────────────────────────────────────────────
// Audible search URLs
// ──────────────────────────────────────────────
const AUDIBLE_SEARCH = {
  US: (narrator) =>
    `https://www.audible.com/search?searchNarrator=${encodeURIComponent(narrator)}&sort=pubdate-desc-rank&pageSize=20`,
  UK: (narrator) =>
    `https://www.audible.co.uk/search?searchNarrator=${encodeURIComponent(narrator)}&sort=pubdate-desc-rank&pageSize=20`,
};

// ──────────────────────────────────────────────
// Parse Audible search results page
// ──────────────────────────────────────────────
function parseSearchResults(html, region, narratorQuery) {
  const $ = cheerio.load(html);
  const books = [];

  $(".productListItem, li[class*='productListItem']").each((i, el) => {
    try {
      const $el = $(el);

      const titleEl = $el.find("h3 a").first() || $el.find(".bc-heading a").first();
      const title = titleEl.text().trim();

      let url = titleEl.attr("href") || "";
      if (url && !url.startsWith("http")) {
        const base = region === "US" ? "https://www.audible.com" : "https://www.audible.co.uk";
        url = base + url;
      }

      const authorEl = $el.find(".authorLabel a, .bc-color-secondary a").first();
      const author = authorEl.text().trim() || "Unknown Author";

      const narratorEl = $el.find(".narratorLabel a").first();
      const narrator = narratorEl.text().trim() || narratorQuery;

      const releaseDateEl = $el
        .find(".releaseDateLabel span, .bc-color-secondary")
        .filter(function () {
          return $(this).text().includes("Release date") || $(this).text().includes("release");
        });
      let releaseDate = "";
      const rdText = releaseDateEl.text() || "";
      const dateMatch = rdText.match(
        /(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}|\d{1,2}\s+\w+\s+\d{4}|\w+\s+\d{1,2},?\s+\d{4})/
      );
      if (dateMatch) releaseDate = dateMatch[1];

      const asin =
        $el.attr("data-asin") ||
        (url.match(/\/([A-Z0-9]{10})(?:\?|$)/) || [])[1] ||
        "";

      if (title) {
        books.push({
          id: asin || `${region}-${title.substring(0, 50)}`,
          title, author, narrator, releaseDate, region, url, asin,
        });
      }
    } catch (e) {
      // Skip malformed entries
    }
  });

  return books;
}

// ──────────────────────────────────────────────
// Scrape one narrator in one region
// ──────────────────────────────────────────────
async function scrapeNarrator(narrator, region, maxResults) {
  const url = AUDIBLE_SEARCH[region](narrator);
  log(`Checking ${region}: "${narrator}"`);

  try {
    const html = await fetchPage(url);
    const books = parseSearchResults(html, region, narrator);
    log(`  Found ${books.length} results for "${narrator}" on ${region}`);
    return books.slice(0, maxResults);
  } catch (err) {
    log(`  ERROR scraping ${region} for "${narrator}": ${err.message}`);
    return [];
  }
}

// ──────────────────────────────────────────────
// Send email via Resend API (no 2FA needed)
// ──────────────────────────────────────────────
async function sendEmailDigest(newBooks) {
  const apiKey = process.env.RESEND_API_KEY;
  const sendTo = process.env.SEND_TO;

  if (!apiKey || !sendTo) {
    log("RESEND_API_KEY or SEND_TO not set — skipping email.");
    return;
  }

  // Group by narrator
  const byNarrator = {};
  for (const book of newBooks) {
    if (!byNarrator[book.narrator]) byNarrator[book.narrator] = [];
    byNarrator[book.narrator].push(book);
  }

  let html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #E0652B; border-bottom: 2px solid #E0652B; padding-bottom: 8px;">
        🎧 Narrator Watch — ${newBooks.length} New Release${newBooks.length !== 1 ? "s" : ""}
      </h2>
      <p style="color: #666; font-size: 14px;">
        Found on ${new Date().toLocaleDateString("en-GB", {
          weekday: "long", year: "numeric", month: "long", day: "numeric",
        })}
      </p>
  `;

  for (const [narrator, books] of Object.entries(byNarrator)) {
    html += `<h3 style="color: #333; margin-top: 24px;">🎙️ ${narrator}</h3>`;
    for (const book of books) {
      const isPreorder = book.releaseDate && new Date(book.releaseDate) > new Date();
      html += `
        <div style="border-left: 3px solid ${isPreorder ? "#7C6AE8" : "#E0652B"}; padding: 8px 12px; margin: 8px 0; background: #f9f9f9; border-radius: 0 6px 6px 0;">
          <strong>${book.title}</strong>
          ${isPreorder ? '<span style="background: #7C6AE8; color: white; font-size: 10px; padding: 2px 6px; border-radius: 8px; margin-left: 6px;">PRE-ORDER</span>' : ""}
          <br/>
          <span style="color: #666; font-size: 13px;">by ${book.author} · ${book.region}</span>
          ${book.releaseDate ? `<br/><span style="color: #999; font-size: 12px;">Release: ${book.releaseDate}</span>` : ""}
          ${book.url ? `<br/><a href="${book.url}" style="color: #E0652B; font-size: 12px;">View on Audible ↗</a>` : ""}
        </div>
      `;
    }
  }

  html += `
      <p style="color: #999; font-size: 11px; margin-top: 32px; border-top: 1px solid #eee; padding-top: 12px;">
        Sent by Audible Narrator Tracker · Edit config.json in your repo to update narrators
      </p>
    </div>
  `;

  const payload = JSON.stringify({
    from: "Narrator Watch <onboarding@resend.dev>",
    to: [sendTo],
    subject: `🎧 ${newBooks.length} new Audible release${newBooks.length !== 1 ? "s" : ""} from your narrators`,
    html,
  });

  const res = await httpsRequest("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "Content-Length": Buffer.byteLength(payload),
    },
    body: payload,
  });

  if (res.statusCode >= 200 && res.statusCode < 300) {
    log(`Email sent to ${sendTo} with ${newBooks.length} new books.`);
  } else {
    log(`EMAIL ERROR: HTTP ${res.statusCode} — ${res.body}`);
  }
}

// ──────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────
async function main() {
  log("═══════════════════════════════════════");
  log("Starting narrator check...");

  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch (e) {
    log(`FATAL: Cannot read config.json: ${e.message}`);
    process.exit(1);
  }

  const { narrators, regions, maxResultsPerNarrator = 10 } = config;

  if (!narrators || narrators.length === 0) {
    log("No narrators configured. Edit config.json.");
    return;
  }

  const seenBooks = loadSeenBooks();

  const allBooks = [];
  const activeRegions = Object.entries(regions)
    .filter(([, enabled]) => enabled)
    .map(([region]) => region);

  for (const narrator of narrators) {
    for (const region of activeRegions) {
      const books = await scrapeNarrator(narrator, region, maxResultsPerNarrator);
      allBooks.push(...books);
      // Polite delay between requests
      await new Promise((r) => setTimeout(r, 2000 + Math.random() * 2000));
    }
  }

  log(`Total results scraped: ${allBooks.length}`);

  const newBooks = allBooks.filter((book) => !seenBooks[book.id]);
  log(`New books found: ${newBooks.length}`);

  if (newBooks.length > 0) {
    for (const book of newBooks) {
      log(`  NEW: "${book.title}" by ${book.author} — narrated by ${book.narrator} [${book.region}]`);
    }

    try {
      await sendEmailDigest(newBooks);
    } catch (err) {
      log(`EMAIL ERROR: ${err.message}`);
    }
  } else {
    log("No new releases found. You're up to date!");
  }

  // Mark all scraped books as seen
  for (const book of allBooks) {
    seenBooks[book.id] = {
      title: book.title,
      narrator: book.narrator,
      region: book.region,
      firstSeen: new Date().toISOString(),
    };
  }
  saveSeenBooks(seenBooks);

  log("Check complete.");
  log("═══════════════════════════════════════\n");
}

main().catch((err) => {
  log(`FATAL ERROR: ${err.message}`);
  process.exit(1);
});
