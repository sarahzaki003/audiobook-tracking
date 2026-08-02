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
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
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
// Audible search URLs — fetch multiple pages
// ──────────────────────────────────────────────
function getSearchUrl(narrator, region, page) {
  const base = region === "US" ? "https://www.audible.com" : "https://www.audible.co.uk";
  return `${base}/search?searchNarrator=${encodeURIComponent(narrator)}&sort=pubdate-desc-rank&pageSize=20&page=${page}`;
}

// ──────────────────────────────────────────────
// Parse release date string into a Date object
// Handles formats: "MM-DD-YY", "MM-DD-YYYY",
// "DD Month YYYY", "Month DD, YYYY",
// "Release date: MM-DD-YY", etc.
// ──────────────────────────────────────────────
function parseReleaseDate(dateStr) {
  if (!dateStr) return null;

  // Strip "Release date:" / "Release Date:" prefix
  let cleaned = dateStr.replace(/release\s*date\s*:?\s*/i, "").trim();
  if (!cleaned) return null;

  // Try MM-DD-YY or MM/DD/YY (common US Audible format)
  const shortMatch = cleaned.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2})$/);
  if (shortMatch) {
    const month = parseInt(shortMatch[1], 10) - 1;
    const day = parseInt(shortMatch[2], 10);
    let year = parseInt(shortMatch[3], 10);
    // Convert 2-digit year: 00-49 = 2000s, 50-99 = 1900s
    year += year < 50 ? 2000 : 1900;
    const d = new Date(year, month, day);
    return isNaN(d.getTime()) ? null : d;
  }

  // Try MM-DD-YYYY or MM/DD/YYYY
  const longMatch = cleaned.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
  if (longMatch) {
    const month = parseInt(longMatch[1], 10) - 1;
    const day = parseInt(longMatch[2], 10);
    const year = parseInt(longMatch[3], 10);
    const d = new Date(year, month, day);
    return isNaN(d.getTime()) ? null : d;
  }

  // Try DD-MM-YYYY (UK format) — we'll try this if the above didn't match
  // and also try natural language: "14 July 2026", "July 14, 2026"
  const d = new Date(cleaned);
  return isNaN(d.getTime()) ? null : d;
}

// Format a Date to a clean display string
function formatDateDisplay(date) {
  if (!date) return "";
  return date.toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric"
  });
}

// ──────────────────────────────────────────────
// Check if narrator matches (case-insensitive,
// handles partial matches like "Nick J. Russo"
// matching "narrated by Nick J. Russo, Sarah Smith")
// ──────────────────────────────────────────────
function narratorMatches(foundNarrator, searchedNarrator) {
  if (!foundNarrator || !searchedNarrator) return false;
  const found = foundNarrator.toLowerCase().trim();
  const searched = searchedNarrator.toLowerCase().trim();

  // Exact match
  if (found === searched) return true;

  // Found narrator contains the searched name
  // (handles multi-narrator books like "Nick J. Russo, Sarah Smith")
  if (found.includes(searched)) return true;

  // Searched name contains the found name (less common but possible)
  if (searched.includes(found)) return true;

  return false;
}

// ──────────────────────────────────────────────
// Parse Audible search results page
// ──────────────────────────────────────────────
function parseSearchResults(html, region, narratorQuery) {
  const $ = cheerio.load(html);
  const books = [];

  const productEls = $(".productListItem, li[class*='productListItem'], .bc-list-item");

  productEls.each((i, el) => {
    try {
      const $el = $(el);
      const elText = $el.text();

      // Skip if this doesn't look like a product
      const titleLink = $el.find("h3 a, h2 a, .bc-heading a").first();
      if (!titleLink.length) return;

      const title = titleLink.text().trim();
      if (!title) return;

      // URL
      let url = titleLink.attr("href") || "";
      if (url && !url.startsWith("http")) {
        const base = region === "US" ? "https://www.audible.com" : "https://www.audible.co.uk";
        url = base + url;
      }

      // Author
      let author = "";
      const authorEl = $el.find(".authorLabel a").first();
      if (authorEl.length) {
        author = authorEl.text().trim();
      } else {
        const byMatch = elText.match(/(?:By|Written by)[:\s]+([^\n]+)/i);
        if (byMatch) author = byMatch[1].trim().split("\n")[0].trim();
      }
      author = author || "Unknown Author";

      // Narrator — collect ALL narrator links (for multi-narrator books)
      let narrator = "";
      const narratorEls = $el.find(".narratorLabel a");
      if (narratorEls.length) {
        const names = [];
        narratorEls.each((_, nel) => {
          const n = $(nel).text().trim();
          if (n) names.push(n);
        });
        narrator = names.join(", ");
      }
      if (!narrator) {
        const narMatch = elText.match(/(?:Narrated by)[:\s]+([^\n]+)/i);
        if (narMatch) narrator = narMatch[1].trim().split("\n")[0].trim();
      }
      narrator = narrator || narratorQuery;

      // Release date — extract just the date part, not the label
      let releaseDateStr = "";
      const rdEl = $el.find(".releaseDateLabel span").first();
      if (rdEl.length) {
        releaseDateStr = rdEl.text().trim();
      } else {
        const rdMatch = elText.match(/(?:Release date)[:\s]+([^\n]+)/i);
        if (rdMatch) releaseDateStr = rdMatch[1].trim();
      }

      // Parse the date
      const releaseDate = parseReleaseDate(releaseDateStr);

      // Clean display string (strip "Release date:" prefix if present)
      const cleanDateStr = releaseDateStr
        .replace(/release\s*date\s*:?\s*/i, "")
        .trim();

      // ASIN
      const asin =
        $el.attr("data-asin") ||
        (url.match(/\/([A-Z0-9]{10})(?:[?\/#]|$)/) || [])[1] ||
        "";

      const id = asin || `${region}-${title.substring(0, 60).replace(/\s+/g, "-")}`;

      books.push({
        id,
        title,
        author,
        narrator,
        releaseDateStr: cleanDateStr,
        releaseDate,
        region,
        url,
        asin,
      });
    } catch (e) {
      // Skip malformed entries
    }
  });

  return books;
}

// ──────────────────────────────────────────────
// Scrape one narrator in one region (multiple pages)
// ──────────────────────────────────────────────
async function scrapeNarrator(narrator, region, maxResults) {
  const pagesToFetch = Math.ceil(maxResults / 20);
  let allBooks = [];

  for (let page = 1; page <= pagesToFetch; page++) {
    const url = getSearchUrl(narrator, region, page);
    log(`Checking ${region} page ${page}: "${narrator}"`);

    try {
      const html = await fetchPage(url);
      const books = parseSearchResults(html, region, narrator);
      log(`  Page ${page}: found ${books.length} results`);
      allBooks.push(...books);

      if (books.length < 20) break;

      if (page < pagesToFetch) {
        await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1000));
      }
    } catch (err) {
      log(`  ERROR scraping ${region} page ${page} for "${narrator}": ${err.message}`);
      break;
    }
  }

  // FILTER: only keep books where the narrator actually matches
  const before = allBooks.length;
  allBooks = allBooks.filter((book) => narratorMatches(book.narrator, narrator));
  const filtered = before - allBooks.length;
  if (filtered > 0) {
    log(`  Filtered out ${filtered} results with non-matching narrators`);
  }

  // Sort by release date (newest first) — our own sort, not Audible's
  allBooks.sort((a, b) => {
    if (a.releaseDate && b.releaseDate) return b.releaseDate - a.releaseDate;
    if (a.releaseDate) return -1;
    if (b.releaseDate) return 1;
    return 0;
  });

  log(`  Total for "${narrator}" on ${region}: ${allBooks.length} (keeping ${Math.min(allBooks.length, maxResults)})`);
  return allBooks.slice(0, maxResults);
}

// ──────────────────────────────────────────────
// Send email via Resend API
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
    // Use the searched narrator name as the group key
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
    // Sort within each narrator group by date descending
    books.sort((a, b) => {
      if (a.releaseDate && b.releaseDate) return b.releaseDate - a.releaseDate;
      if (a.releaseDate) return -1;
      if (b.releaseDate) return 1;
      return 0;
    });

    html += `<h3 style="color: #333; margin-top: 24px;">🎙️ ${narrator}</h3>`;
    for (const book of books) {
      const isPreorder = book.releaseDate && book.releaseDate > new Date();
      const displayDate = book.releaseDate
        ? formatDateDisplay(book.releaseDate)
        : book.releaseDateStr || "";

      html += `
        <div style="border-left: 3px solid ${isPreorder ? "#7C6AE8" : "#E0652B"}; padding: 8px 12px; margin: 8px 0; background: #f9f9f9; border-radius: 0 6px 6px 0;">
          <strong>${book.title}</strong>
          ${isPreorder ? '<span style="background: #7C6AE8; color: white; font-size: 10px; padding: 2px 6px; border-radius: 8px; margin-left: 6px;">PRE-ORDER</span>' : ""}
          <br/>
          <span style="color: #666; font-size: 13px;">by ${book.author} · ${book.region}</span>
          ${displayDate ? `<br/><span style="color: #999; font-size: 12px;">${displayDate}</span>` : ""}
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

  const { narrators, regions, maxResultsPerNarrator = 40 } = config;

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
      // Polite delay between narrator+region combos
      await new Promise((r) => setTimeout(r, 2000 + Math.random() * 2000));
    }
  }

  log(`Total results scraped: ${allBooks.length}`);

  const newBooks = allBooks.filter((book) => !seenBooks[book.id]);
  log(`New books found: ${newBooks.length}`);

  if (newBooks.length > 0) {
    for (const book of newBooks) {
      const dateStr = book.releaseDate ? formatDateDisplay(book.releaseDate) : book.releaseDateStr;
      log(`  NEW: "${book.title}" by ${book.author} — narrated by ${book.narrator} [${book.region}] ${dateStr || ""}`);
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
      releaseDate: book.releaseDateStr || "",
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
