/**
 * Keyword Final URL Product-Presence Checker — Google Ads Script
 *
 * For each enabled keyword in your account, fetches the Final URL and
 * checks whether the landing page actually shows products. Finds pages
 * that return HTTP 200 but display zero results — the kind of problem
 * normal uptime monitoring misses.
 *
 * HOW TO USE
 * ----------
 * 1. In Google Ads: Tools & Settings → Bulk Actions → Scripts → + New script
 * 2. Paste this entire file
 * 3. Edit the CONFIG block below
 * 4. Click Preview to test (processes up to 30s worth of URLs)
 * 5. Save and set a schedule (daily or weekly recommended)
 *
 * OUTPUT
 * ------
 * A Google Sheet with columns:
 *   Campaign | Ad Group | Keyword | Match Type | Status | Final URL |
 *   URL_status | URL_products | URL_detail
 *
 * URL_status values:
 *   OK       — page has products
 *   EMPTY    — page loaded but shows zero products (active problem)
 *   BLOCKED  — site returned 403 or bot-protection page
 *   ERROR    — request failed (timeout, DNS error, 4xx/5xx)
 *   UNKNOWN  — no product signal found either way (check manually)
 *   NO_URL   — keyword has no Final URL set
 */

// =============================================================================
// CONFIG — edit this section
// =============================================================================
var CONFIG = {
  // Google Sheet to write results to.
  // Leave empty ('') to auto-create a new Sheet each run.
  // Or paste a Sheet ID (the long string in the Sheet URL) to always update the same one.
  SHEET_ID: '',

  // Name of the tab inside the Sheet
  SHEET_NAME: 'URL Check',

  // Max unique URLs to check per run. Raise if your account is large.
  // Google Ads scripts have a 30-minute execution limit.
  MAX_URLS: 500,

  // Seconds to wait for each URL to respond
  REQUEST_TIMEOUT: 20,

  // How many URLs to fetch in parallel (UrlFetchApp.fetchAll batch size)
  // Lower this (to 3-5) if the target site returns 429 Too Many Requests
  BATCH_SIZE: 3,

  // Filter: only check keywords in campaigns matching this label.
  // Leave empty ('') to check ALL enabled campaigns.
  CAMPAIGN_LABEL: '',

  // Include paused keywords? true = yes, false = enabled only
  INCLUDE_PAUSED: false,

  // Browser identity sent with each request
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',

  // Language preference sent with each request
  ACCEPT_LANGUAGE: 'lt,en;q=0.9',
};
// =============================================================================


// ---------- "no products" text patterns ----------

var NO_PRODUCTS_PATTERNS = [
  // Lithuanian
  'šioje kategorijoje prekių nėra',
  'prekių nėra',
  'nerasta prekių',
  'nebuvo rasta jokių jūsų kriterijus atitinkančių produktų.',
  // English
  'no products found',
  'no products available',
  'no results found',
  'no items found',
  '0 products',
  'your search returned no results',
  // Russian
  'товаров нет',
  'ничего не найдено',
  // German
  'keine produkte',
  'keine ergebnisse',
  // Spanish
  'no se encontraron productos',
  // French
  'aucun produit',
  'aucun résultat',
  // Italian
  'nessun prodotto',
  // Hungarian
  'nincs termék',
  // Latvian
  'šajā kategorijā nav preču',
  // Estonian
  'selles kategoorias ei ole tooteid',
  // Finnish
  'tässä kategoriassa ei ole tuotteita',
];


// ---------- CSS class patterns (string matching, no DOM) ----------

var PRODUCT_PATTERNS = [
  { pattern: 'class="product-miniature',  label: 'PrestaShop' },
  { pattern: "class='product-miniature",  label: 'PrestaShop' },
  { pattern: 'data-id-product',           label: 'PrestaShop data attr' },
  { pattern: 'class="product-item',       label: 'Magento/generic' },
  { pattern: "class='product-item",       label: 'Magento/generic' },
  { pattern: 'class="product-card',       label: 'Shopify/generic' },
  { pattern: "class='product-card",       label: 'Shopify/generic' },
  { pattern: '<li class="product',        label: 'WooCommerce' },
  { pattern: "<li class='product",        label: 'WooCommerce' },
];

// Containers that scope product card counting (avoids sidebar/related widgets)
var SCOPE_PATTERNS = ['id="products"', "id='products'", 'id="js-product-list"', "id='js-product-list'"];


// ---------- detection ----------

function checkJsonLd(html) {
  var re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  var match;
  while ((match = re.exec(html)) !== null) {
    try {
      var data = JSON.parse(match[1].trim());
    } catch (e) { continue; }

    var nodes = Array.isArray(data) ? data : [data];
    var flat = [];
    for (var i = 0; i < nodes.length; i++) {
      if (!nodes[i] || typeof nodes[i] !== 'object') continue;
      var graph = nodes[i]['@graph'];
      if (Array.isArray(graph)) {
        for (var g = 0; g < graph.length; g++) flat.push(graph[g]);
      } else {
        flat.push(nodes[i]);
      }
    }

    for (var j = 0; j < flat.length; j++) {
      var node = flat[j];
      if (!node || typeof node !== 'object') continue;
      var type = node['@type'];
      var types = Array.isArray(type) ? type : [type];

      if (types.indexOf('ItemList') !== -1) {
        var nItems = node['numberOfItems'];
        if (typeof nItems === 'number') {
          return { status: nItems > 0 ? 'OK' : 'EMPTY', count: nItems, detail: 'JSON-LD ItemList numberOfItems' };
        }
        var items = node['itemListElement'] || [];
        if (Array.isArray(items)) {
          return { status: items.length > 0 ? 'OK' : 'EMPTY', count: items.length, detail: 'JSON-LD ItemList elements' };
        }
      }
      if (types.indexOf('Product') !== -1) {
        return { status: 'OK', count: 1, detail: 'JSON-LD Product' };
      }
    }
  }
  return null;
}

function detectProducts(html) {
  // 1. JSON-LD schema (most reliable)
  var jsonld = checkJsonLd(html);
  if (jsonld) return jsonld;

  // 2. Localized "no products" text — checked before CSS selectors because
  // sidebars can contain product cards even on empty search result pages.
  var lower = html.toLowerCase();
  for (var i = 0; i < NO_PRODUCTS_PATTERNS.length; i++) {
    if (lower.indexOf(NO_PRODUCTS_PATTERNS[i]) !== -1) {
      return { status: 'EMPTY', count: 0, detail: 'matched: "' + NO_PRODUCTS_PATTERNS[i] + '"' };
    }
  }

  // 3. Schema.org microdata
  if (html.indexOf('schema.org/Product') !== -1) {
    return { status: 'OK', count: 1, detail: 'schema.org Product microdata' };
  }

  // 4. Product card class patterns — scoped to main container if present
  var scopedHtml = html;
  for (var s = 0; s < SCOPE_PATTERNS.length; s++) {
    var scopeIdx = html.indexOf(SCOPE_PATTERNS[s]);
    if (scopeIdx !== -1) {
      scopedHtml = html.slice(scopeIdx, scopeIdx + 200000);
      break;
    }
  }

  for (var p = 0; p < PRODUCT_PATTERNS.length; p++) {
    var pat = PRODUCT_PATTERNS[p];
    var idx = scopedHtml.indexOf(pat.pattern);
    if (idx !== -1) {
      var count = scopedHtml.split(pat.pattern).length - 1;
      return { status: 'OK', count: count, detail: 'selector: ' + pat.pattern + ' (' + pat.label + ')' };
    }
  }

  return { status: 'UNKNOWN', count: null, detail: 'no product or empty-state signal' };
}


// ---------- URL validation (SSRF prevention) ----------

function isUrlSafe(url) {
  if (!url) return false;
  var lower = url.toLowerCase().trim();
  if (lower.indexOf('http://') !== 0 && lower.indexOf('https://') !== 0) return false;
  // Block private/internal/metadata targets
  // Includes RFC-1918, loopback, link-local, IPv6 private, cloud metadata hostnames,
  // and non-standard IP encodings (hex, octal, decimal).
  var blocked = [
    'localhost', '127.', '0.0.0.0', 'file://',
    '192.168.', '10.', '100.64.', '100.65.', '100.66.', '100.67.', '100.68.',
    '100.69.', '100.70.', '100.71.', '100.72.', '100.73.', '100.74.', '100.75.',
    '100.76.', '100.77.', '100.78.', '100.79.', '100.80.', '100.81.', '100.82.',
    '100.83.', '100.84.', '100.85.', '100.86.', '100.87.', '100.88.', '100.89.',
    '100.90.', '100.91.', '100.92.', '100.93.', '100.94.', '100.95.', '100.96.',
    '100.97.', '100.98.', '100.99.', '100.100.', '100.101.', '100.102.',
    '100.103.', '100.104.', '100.105.', '100.106.', '100.107.', '100.108.',
    '100.109.', '100.110.', '100.111.', '100.112.', '100.113.', '100.114.',
    '100.115.', '100.116.', '100.117.', '100.118.', '100.119.', '100.120.',
    '100.121.', '100.122.', '100.123.', '100.124.', '100.125.', '100.126.',
    '100.127.',
    '172.16.', '172.17.', '172.18.', '172.19.', '172.20.', '172.21.', '172.22.',
    '172.23.', '172.24.', '172.25.', '172.26.', '172.27.', '172.28.', '172.29.',
    '172.30.', '172.31.',
    '169.254.',
    // IPv6 private/loopback/link-local
    '[::1]', '[::ffff:', '[fc', '[fd', '[fe8', '[fe9', '[fea', '[feb',
    // Cloud metadata hostnames
    'metadata.google.internal', 'metadata.internal',
    // Hex/octal/decimal IP encoding
    '0x', '0177.',
  ];
  for (var i = 0; i < blocked.length; i++) {
    if (lower.indexOf(blocked[i]) !== -1) return false;
  }
  return true;
}


// ---------- response processing ----------

function processResponse(url, response) {
  try {
    var code = response.getResponseCode();
    var html = response.getContentText();
    var sample = html.substring(0, 3000).toLowerCase();

    if (code === 403 || sample.indexOf('just a moment') !== -1 ||
        sample.indexOf('cf-challenge') !== -1 ||
        sample.indexOf('checking your browser') !== -1) {
      return { status: 'BLOCKED', count: null, detail: 'HTTP ' + code + ' (bot protection)' };
    }
    if (code >= 400) {
      return { status: 'ERROR', count: null, detail: 'HTTP ' + code };
    }
    return detectProducts(html);
  } catch (e) {
    return { status: 'ERROR', count: null, detail: 'Processing error' };
  }
}


// ---------- data fetching ----------

function getKeywords() {
  var keywords = [];
  var selector = AdsApp.keywords()
    .withCondition('CampaignStatus = ENABLED')
    .withCondition('AdGroupStatus = ENABLED')
    .orderBy('CampaignName ASC')
    .withLimit(100000);

  if (!CONFIG.INCLUDE_PAUSED) {
    selector = selector.withCondition('Status = ENABLED');
  }

  if (CONFIG.CAMPAIGN_LABEL) {
    if (CONFIG.CAMPAIGN_LABEL.indexOf("'") !== -1) {
      throw new Error('CAMPAIGN_LABEL must not contain single quotes. Got: ' + CONFIG.CAMPAIGN_LABEL);
    }
    selector = selector.withCondition("LabelNames CONTAINS_ANY ['" + CONFIG.CAMPAIGN_LABEL + "']");
  }

  var iterator = selector.get();
  while (iterator.hasNext()) {
    var kw = iterator.next();
    var url = kw.urls().getFinalUrl() || '';
    keywords.push({
      campaign:  kw.getCampaign().getName(),
      adGroup:   kw.getAdGroup().getName(),
      keyword:   kw.getText(),
      matchType: kw.getMatchType(),
      status:    kw.isEnabled() ? 'Enabled' : 'Paused',
      finalUrl:  url.trim(),
    });
  }

  Logger.log('Loaded ' + keywords.length + ' keywords from account');
  return keywords;
}

function fetchUrls(uniqueUrls) {
  var results = {};
  var total = uniqueUrls.length;

  for (var i = 0; i < total; i += CONFIG.BATCH_SIZE) {
    var batch = uniqueUrls.slice(i, Math.min(i + CONFIG.BATCH_SIZE, total));
    var requests = [];

    for (var b = 0; b < batch.length; b++) {
      requests.push({
        url:              batch[b],
        method:           'get',
        muteHttpExceptions: true,
        followRedirects:  true,
        headers: {
          'User-Agent':                CONFIG.USER_AGENT,
          'Accept-Language':           CONFIG.ACCEPT_LANGUAGE,
          'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Upgrade-Insecure-Requests': '1',
          'Cache-Control':             'max-age=0',
          'Sec-Fetch-Dest':            'document',
          'Sec-Fetch-Mode':            'navigate',
          'Sec-Fetch-Site':            'none',
          'Sec-Fetch-User':            '?1',
        },
      });
    }

    try {
      var responses = UrlFetchApp.fetchAll(requests);
      for (var r = 0; r < responses.length; r++) {
        results[batch[r]] = processResponse(batch[r], responses[r]);
      }
    } catch (e) {
      Logger.log('Batch error at index ' + i + ': ' + e);
      for (var k = 0; k < batch.length; k++) {
        results[batch[k]] = { status: 'ERROR', count: null, detail: 'Request failed' };
      }
    }

    Logger.log('Checked ' + Math.min(i + CONFIG.BATCH_SIZE, total) + ' / ' + total + ' URLs');
    if (i + CONFIG.BATCH_SIZE < total) Utilities.sleep(2000);
  }

  return results;
}


// ---------- Sheets output ----------

function sheetSafe(v) {
  if (typeof v === 'string' && v.length > 0 && '=+-@|'.indexOf(v[0]) !== -1) return "'" + v;
  return v !== null && v !== undefined ? v : '';
}

var STATUS_COLORS = {
  'OK':      '#C6EFCE',
  'EMPTY':   '#FFC7CE',
  'BLOCKED': '#FFEB9C',
  'ERROR':   '#FFEB9C',
  'UNKNOWN': '#DDDDDD',
  'NO_URL':  '#BDD7EE',
};

function writeResults(keywords, urlResults) {
  var ss;
  if (CONFIG.SHEET_ID) {
    ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  } else {
    var title = 'Keyword URL Check ' + Utilities.formatDate(new Date(), AdsApp.currentAccount().getTimeZone(), 'yyyy-MM-dd');
    ss = SpreadsheetApp.create(title);
    Logger.log('Created new sheet: ' + ss.getUrl());
  }

  var sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(CONFIG.SHEET_NAME);
  sheet.clearContents();
  sheet.clearFormats();

  var headers = ['Campaign', 'Ad Group', 'Keyword', 'Match Type', 'KW Status',
                 'Final URL', 'URL_status', 'URL_products', 'URL_detail'];
  sheet.getRange(1, 1, 1, headers.length)
    .setValues([headers])
    .setFontWeight('bold')
    .setBackground('#333333')
    .setFontColor('#ffffff');

  // Build rows
  var rows = [];
  for (var i = 0; i < keywords.length; i++) {
    var kw = keywords[i];
    var res;
    if (!kw.finalUrl) {
      res = { status: 'NO_URL', count: null, detail: '' };
    } else {
      res = urlResults[kw.finalUrl] || { status: 'ERROR', count: null, detail: 'Not checked' };
    }
    rows.push([
      sheetSafe(kw.campaign), sheetSafe(kw.adGroup), sheetSafe(kw.keyword),
      sheetSafe(kw.matchType), sheetSafe(kw.status), sheetSafe(kw.finalUrl),
      res.status,
      res.count !== null && res.count !== undefined ? res.count : '',
      sheetSafe(res.detail || ''),
    ]);
  }

  // Sort: EMPTY first (active problems), then by product count ascending, NO_URL last
  var ORDER = { 'EMPTY': 0, 'BLOCKED': 1, 'ERROR': 2, 'UNKNOWN': 3, 'OK': 4, 'NO_URL': 5 };
  rows.sort(function (a, b) {
    var oa = ORDER[a[6]] !== undefined ? ORDER[a[6]] : 3;
    var ob = ORDER[b[6]] !== undefined ? ORDER[b[6]] : 3;
    if (oa !== ob) return oa - ob;
    var ca = a[7] === '' ? 9999 : parseInt(a[7]);
    var cb = b[7] === '' ? 9999 : parseInt(b[7]);
    return ca - cb;
  });

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);

    // Color rows by status
    for (var r = 0; r < rows.length; r++) {
      var color = STATUS_COLORS[rows[r][6]];
      if (color) sheet.getRange(r + 2, 1, 1, headers.length).setBackground(color);
    }
  }

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);

  // Summary in Logger
  var counts = {};
  for (var s = 0; s < rows.length; s++) {
    var st = rows[s][6];
    counts[st] = (counts[st] || 0) + 1;
  }
  Logger.log('--- Summary ---');
  var order = ['OK', 'EMPTY', 'BLOCKED', 'ERROR', 'UNKNOWN', 'NO_URL'];
  for (var o = 0; o < order.length; o++) {
    if (counts[order[o]]) Logger.log(order[o] + ': ' + counts[order[o]]);
  }
  Logger.log('Sheet: ' + ss.getUrl());

  return ss.getUrl();
}


// ---------- main ----------

function main() {
  Logger.log('Starting Keyword URL Checker');
  Logger.log('Account: ' + AdsApp.currentAccount().getName());

  var keywords = getKeywords();

  // Collect unique, safe URLs
  var seen = {};
  var uniqueUrls = [];
  for (var i = 0; i < keywords.length; i++) {
    var url = keywords[i].finalUrl;
    if (url && !seen[url]) {
      if (isUrlSafe(url)) {
        seen[url] = true;
        uniqueUrls.push(url);
        if (uniqueUrls.length >= CONFIG.MAX_URLS) break;
      }
    }
  }

  var noUrlCount = keywords.filter(function (k) { return !k.finalUrl; }).length;
  Logger.log(uniqueUrls.length + ' unique URLs to check (' + noUrlCount + ' keywords have no URL)');

  if (uniqueUrls.length === 0) {
    Logger.log('No URLs to check. Done.');
    return;
  }

  var urlResults = fetchUrls(uniqueUrls);
  var sheetUrl = writeResults(keywords, urlResults);

  Logger.log('Done. Results: ' + sheetUrl);
}
