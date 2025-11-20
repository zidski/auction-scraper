import axios from "axios";
import cheerio from "cheerio";
import { google } from "googleapis";

// ===== CONFIGURATION =====
const SHEET_ID = process.env.SHEET_ID;
const SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

if (!SHEET_ID || !SERVICE_ACCOUNT_JSON) {
  console.error("❌ Missing Google credentials or Sheet ID in environment variables.");
  process.exit(1);
}

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(SERVICE_ACCOUNT_JSON),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const SITES = [
  {
    name: "Example Auctions",
    url: "https://example.com/auctions",
    selectors: {
      item: ".auction-item",
      title: ".auction-title",
      date: ".auction-date",
      location: ".auction-location",
      category: ".auction-category",
      description: ".auction-description",
      link: "a",
    },
    pagination: {
      next: ".next-page a",
      limit: 5
    },
  }
];
// =====================================

async function getExistingEntries() {
  const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Sheet1!A:F",
  });
  const rows = res.data.values || [];
  return new Set(rows.slice(1).map((r) => (r[0] || "") + "|" + (r[5] || "")));
}

async function appendToSheet(rows) {
  const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "Sheet1!A:F",
    valueInputOption: "RAW",
    resource: { values: rows },
  });
  console.log(`✅ Added ${rows.length} new auctions`);
}

function guessCategory(title, location, url) {
  const text = `${title} ${location} ${url}`.toLowerCase();
  if (text.includes("property") || text.includes("estate")) return "Property";
  if (text.includes("antique") || text.includes("collectible")) return "Antiques";
  if (text.includes("jewel") || text.includes("watch")) return "Jewellery";
  if (text.includes("car") || text.includes("vehicle")) return "Motors";
  if (text.includes("farm") || text.includes("tractor")) return "Agriculture";
  if (text.includes("art") || text.includes("painting")) return "Art";
  return "General";
}

async function scrapePage(site, url, page = 1) {
  console.log(`📄 Scraping page ${page}: ${url}`);
  const { data } = await axios.get(url);
  const $ = cheerio.load(data);
  const items = [];

  $(site.selectors.item).each((_, el) => {
    const title = $(el).find(site.selectors.title).text().trim() || "";
    const date = $(el).find(site.selectors.date).text().trim() || "";
    const location = $(el).find(site.selectors.location).text().trim() || "";
    const category =
      $(el).find(site.selectors.category).text().trim() ||
      guessCategory(title, location, site.url);
    const description = $(el).find(site.selectors.description).text().trim() || "";
    const relativeLink = $(el).find(site.selectors.link).attr("href");
    const link = relativeLink ? new URL(relativeLink, site.url).href : site.url;
    items.push([title, date, location, category, description, link]);
  });

  let nextPage = null;
  if (site.pagination?.next) {
    const next = $(site.pagination.next).attr("href");
    if (next && (!site.pagination.limit || page < site.pagination.limit)) {
      nextPage = new URL(next, site.url).href;
    }
  }
  return { items, nextPage };
}

async function scrapeSite(site) {
  console.log(`\n🔍 Starting: ${site.name}`);
  let pageUrl = site.url;
  let page = 1;
  const allItems = [];

  while (pageUrl && (!site.pagination.limit || page <= site.pagination.limit)) {
    try {
      const { items, nextPage } = await scrapePage(site, pageUrl, page);
      allItems.push(...items);
      pageUrl = nextPage;
      page++;
    } catch (err) {
      console.error(`⚠️ Error on ${pageUrl}: ${err.message}`);
      break;
    }
  }

  console.log(`→ Found ${allItems.length} items from ${site.name}`);
  return allItems;
}

(async () => {
  const existing = await getExistingEntries();
  const newRows = [];

  for (const site of SITES) {
    const items = await scrapeSite(site);
    for (const row of items) {
      const key = row[0] + "|" + row[5];
      if (!existing.has(key)) {
        newRows.push(row);
        existing.add(key);
      }
    }
  }

  if (newRows.length > 0) {
    await appendToSheet(newRows);
  } else {
    console.log("✅ No new auctions found.");
  }
})();
