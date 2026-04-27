'use strict';

/**
 * sabradou-scraper
 * ────────────────
 * Parcourt les pages journalières de sabradou.com (format page=YYMMDD),
 * collecte les liens vers chaque événement (braderie, brocante, vide-grenier …),
 * scrape la fiche détaillée de chaque événement et produit un fichier events.json.
 *
 * Utilisation :  node scraper.js
 * Reprise :      node scraper.js --resume   (repart du dernier état sauvegardé)
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const iconv   = require('iconv-lite');
const fs      = require('fs').promises;
const path    = require('path');

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────
const CONFIG = {
  baseUrl      : 'https://www.sabradou.com',
  startDate    : new Date(2026, 3, 15),   // 15 avril 2026  (YYMMDD → 260415)
  endDate      : new Date(2026, 11, 31),  // 31 décembre 2026
  delayMs      : 800,                     // délai poli entre deux requêtes
  outputFile   : path.resolve(__dirname, 'events.json'),
  progressFile : path.resolve(__dirname, '.scraper_progress.json'),
};

// Chemins/pages à ne PAS considérer comme des fiches d'événement
const IGNORE_PATHS = [
  'index.php', 'formulaire.php', 'annulation.php',
  'renseignement.php', 'feedback.php', 'wikipedia.org',
  'facebook.com', 'corbehem.fr',
];

// ─────────────────────────────────────────────────────────────
// HTTP client
// ─────────────────────────────────────────────────────────────
const http = axios.create({
  timeout      : 15_000,
  responseType : 'arraybuffer',
  headers : {
    'User-Agent'     : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5',
  },
});

/** Détecte le charset depuis le header Content-Type ou la balise <meta> */
function detectCharset(headers, rawBuffer) {
  const ct = headers['content-type'] || '';
  const ctMatch = ct.match(/charset=([\w-]+)/i);
  if (ctMatch) return ctMatch[1];
  // Fallback : lire les premiers 1024 octets en ASCII
  const head = rawBuffer.slice(0, 1024).toString('ascii');
  const metaMatch = head.match(/charset=["']?([\w-]+)/i);
  if (metaMatch) return metaMatch[1];
  return 'iso-8859-1'; // défaut pour vieux sites français
}

async function get(url) {
  try {
    const resp    = await http.get(url);
    const charset = detectCharset(resp.headers, resp.data);
    return iconv.decode(Buffer.from(resp.data), charset);
  } catch (err) {
    console.warn(`  ⚠  GET failed [${err.response?.status ?? err.code}]: ${url}`);
    return null;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/** Formate un objet Date en paramètre page YYMMDD */
function toPageParam(date) {
  const yy = String(date.getFullYear()).slice(2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

/** Convertit un code YYMMDD en Date JS */
function fromPageParam(code) {
  const yy = parseInt(code.slice(0, 2), 10) + 2000;
  const mm = parseInt(code.slice(2, 4), 10) - 1;
  const dd = parseInt(code.slice(4, 6), 10);
  return new Date(yy, mm, dd);
}

/** Renvoie true si le href pointe vers une fiche événement */
function isEventHref(href) {
  if (!href) return false;
  const full = href.startsWith('http') ? href : `https://www.sabradou.com${href}`;
  if (!full.includes('sabradou.com')) return false;
  if (!href.endsWith('.php')) return false;
  if (IGNORE_PATHS.some(p => href.includes(p))) return false;
  // Les fiches sont toujours sous un chemin .../c/commune/fichier.php
  return href.includes('/c/');
}

function absoluteUrl(href) {
  return href.startsWith('http') ? href : `${CONFIG.baseUrl}${href}`;
}

// ─────────────────────────────────────────────────────────────
// Phase 1 — extraire les dates disponibles depuis le calendrier
// ─────────────────────────────────────────────────────────────
function extractCalendarDates(html) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const dates = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/[?&]page=(\d{6})/);
    if (!m) return;
    const code = m[1];
    if (seen.has(code)) return;
    const d = fromPageParam(code);
    if (d >= CONFIG.startDate && d <= CONFIG.endDate) {
      seen.add(code);
      dates.push({ code, date: d });
    }
  });

  return dates.sort((a, b) => a.date - b.date);
}

// ─────────────────────────────────────────────────────────────
// Phase 2 — extraire les liens d'événements d'une page journée
// ─────────────────────────────────────────────────────────────
function extractEventLinks(html, isoDate) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const links = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!isEventHref(href)) return;
    const url = absoluteUrl(href);
    if (seen.has(url)) return;
    seen.add(url);

    // Contexte : département / secteur lisible dans le voisinage du lien
    const $row  = $(el).closest('tr');
    const rowTxt = $row.text().replace(/\s+/g, ' ').trim();

    links.push({
      url,
      label   : $(el).text().replace(/\s+/g, ' ').trim(),
      context : rowTxt.slice(0, 120),
      date    : isoDate,
    });
  });

  return links;
}

// ─────────────────────────────────────────────────────────────
// Phase 3 — scraper la fiche détaillée d'un événement
// ─────────────────────────────────────────────────────────────
function scrapeEventDetail(html, url) {
  const $ = cheerio.load(html);
  const event = { url };

  // Texte brut du body (espaces normalisés) pour les regex
  const raw = $('body').text().replace(/\s+/g, ' ');

  // ── Département / région — extrait en priorité depuis l'URL elle-même ──
  const urlDepM = url.match(/\/([0-9]{2})-([^/]+)\//);
  if (urlDepM) {
    event.departmentCode = urlDepM[1];
    event.departmentSlug = urlDepM[2];
  }

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const txt  = $(el).text().trim();
    // Label département depuis lien type /62-pas-de-calais/index.php
    if (!event.departmentLabel) {
      const depM = href.match(/\/([0-9]{2})-([^/]+)\/index\.php/);
      if (depM && depM[1] === event.departmentCode) {
        event.departmentLabel = txt;
      }
    }
    // Code postal + commune  ex. "62112 Corbehem"
    if (!event.postalCode) {
      const pcM = txt.match(/^(\d{5})\s+(.+)/);
      if (pcM) {
        event.postalCode = pcM[1];
        event.city       = pcM[2];
        const cityHref   = $(el).attr('href') || '';
        if (cityHref.startsWith('http')) event.cityUrl = cityHref;
      }
    }
  });

  // ── Type d'événement ────────────────────────────────────────
  const TYPE_RX = /\b(Braderie|Brocante|Vide[- ]?[Gg]renier|March[eé] aux [Pp]uces|March[eé] de [Nn]o[eë]l|Bourse|Ch[ih]neur|Rederie|Red[eé]rie|Kermesse|Troc)/gi;
  const typeSet = new Set();
  for (const m of raw.matchAll(TYPE_RX)) typeSet.add(m[0].trim().toLowerCase());
  event.eventTypes = [...typeSet];

  // ── Catégories / thèmes ─────────────────────────────────────
  const CAT_RX = /\b(v[eê]tement[s]?|livre[s]?|disques?|jouets?|antiquit[eé]s?|meubles?|informatique|multi|divers|sport[s]?|vinyle[s]?|céramique|vaisselle|art[s]?|bijou[sx]?|jouet[s]?)/gi;
  const catSet = new Set();
  for (const m of raw.matchAll(CAT_RX)) catSet.add(m[0].toLowerCase().trim());
  event.categories = [...catSet];

  // ── Entrée gratuite / payante ────────────────────────────────
  event.freeEntry = /entr[eé]e gratuite/i.test(raw);
  const pricM = raw.match(/entr[eé]e\s*:?\s*(\d[\d,. €]*)/i);
  if (pricM) event.entryPrice = pricM[1].trim();

  // ── Accessibilité PMR ───────────────────────────────────────
  event.accessiblePMR = /P\.?M\.?R/i.test(raw);

  // ── Adresse de la manifestation ─────────────────────────────
  // On cherche des tokens de la forme "salle des fêtes", "rue …", "place …", etc.
  const addrM = raw.match(/(?:salle|rue|place|avenue|boulevard|chemin|allée|hall|espace|parc|esplanade|route)\s[^.]+?(\d{5}\s+\w[\w\s-]{2,40})/i);
  if (addrM) {
    event.address = addrM[0].replace(/\s+/g, ' ').trim().slice(0, 200);
  } else {
    // fallback : cherche directement code postal + commune
    const fallbackM = raw.match(/(\d{5})\s+([A-ZÀÂÄÉÈÊËÎÏÔÙÛÜ][A-Za-zÀ-ÿ\s-]{2,40})/);
    if (fallbackM) event.address = fallbackM[0].trim();
  }

  // ── Dates planifiées dans l'agenda 2026 ─────────────────────
  // On cible spécifiquement les liens de l'agenda (attribut href sur la même page)
  const agendaSet = new Set();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const txt  = $(el).text().trim();
    // Liens internes pointant vers la même fiche = dates agenda
    if (href.includes('/c/') && href.endsWith('.php') && !href.includes('index.php')) {
      const dateTxt = txt.match(/^((?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+\d{1,2}\s+\w+)/i);
      if (dateTxt) agendaSet.add(dateTxt[1].trim());
    }
  });
  event.scheduledDates = [...agendaSet];

  // ── Horaires (de Xh à Yh) ────────────────────────────────────
  const HOURS_RX = /de\s+(\d+h\d*)\s+à\s+(\d+h\d*)/gi;
  const hours = [];
  for (const m of raw.matchAll(HOURS_RX)) {
    hours.push(`${m[1]}–${m[2]}`);
  }
  event.openingHours = [...new Set(hours)];

  // ── Éditions passées (avec année) ───────────────────────────
  const PAST_DATE_RX = /(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+\d{1,2}\s+\w+\s+\d{4}[\s\S]{0,40}?de\s+\d+h\d*\s+à\s+\d+h\d*/gi;
  event.pastEditions = (raw.match(PAST_DATE_RX) || []).map(s => s.replace(/\s+/g, ' ').trim());

  // ── Organisateur ────────────────────────────────────────────
  const orgM = raw.match(/Organisateur\s+(.{4,200?}?)(?:\s+La gestion|\s+Exposant|\s+Chineur|\s*$)/i);
  if (orgM) {
    const orgRaw = orgM[1].replace(/\s+/g, ' ').trim();
    event.organizer = orgRaw.slice(0, 300);
    const phoneM = orgRaw.match(/(?:0|\+33)[.\s-]?[1-9](?:[.\s-]?\d{2}){4}/);
    if (phoneM) event.organizerPhone = phoneM[0].replace(/[.\s-]/g, '');
  }

  // ── Exposants ────────────────────────────────────────────────
  const expM = raw.match(/Exposant\s+(.{4,120}?)(?:\s+Organis|\s+Chineur|\s+La gestion|\s*$)/i);
  if (expM) event.exhibitors = expM[1].replace(/\s+/g, ' ').trim();

  // ── Réseaux sociaux ─────────────────────────────────────────
  const fbHref = $('a[href*="facebook.com"]').first().attr('href');
  if (fbHref) event.facebookUrl = fbHref;

  // ── Dates de mise à jour ─────────────────────────────────────
  const updM = raw.match(/mise à jour le\s+(\d{2}\/\d{2}\/\d{4})/i);
  if (updM) event.updatedAt = updM[1];
  const editM = raw.match(/[eé]dit[eé]e le\s+(\d{2}\/\d{2}\/\d{4})/i);
  if (editM) event.createdAt = editM[1];

  return event;
}

// ─────────────────────────────────────────────────────────────
// Sauvegarde JSON (intermédiaire + finale)
// ─────────────────────────────────────────────────────────────
async function save(data, final = false) {
  const output = {
    scraped_at   : new Date().toISOString(),
    total_events : data.length,
    events       : data,
  };
  await fs.writeFile(CONFIG.outputFile, JSON.stringify(output, null, 2), 'utf8');
  if (final) {
    console.log(`\n✅  Terminé ! ${data.length} événements sauvegardés → ${CONFIG.outputFile}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Orchestration principale
// ─────────────────────────────────────────────────────────────
async function main() {
  const resume = process.argv.includes('--resume');

  console.log('═'.repeat(64));
  console.log('  Sabradou.com scraper — braderies / brocantes / vide-greniers');
  console.log('═'.repeat(64));
  console.log(`  Période   : ${CONFIG.startDate.toLocaleDateString('fr-FR')} → ${CONFIG.endDate.toLocaleDateString('fr-FR')}`);
  console.log(`  Délai     : ${CONFIG.delayMs} ms entre requêtes`);
  console.log(`  Sortie    : ${CONFIG.outputFile}`);
  if (resume) console.log('  Mode      : REPRISE (--resume)');
  console.log('');

  // ── Phase 1 : récupérer la liste des dates avec des événements ──
  console.log('[Phase 1] Chargement du calendrier…');
  const calHtml = await get(`${CONFIG.baseUrl}/index.php?page=${toPageParam(CONFIG.startDate)}`);
  if (!calHtml) {
    console.error('Impossible de charger le calendrier. Abandon.');
    process.exit(1);
  }

  let eventDates = extractCalendarDates(calHtml);
  console.log(`  → ${eventDates.length} dates avec événements trouvées dans le calendrier.`);

  // Si le parsing calendrier a raté (structure inattendue), fallback jour par jour
  if (eventDates.length < 5) {
    console.log('  → Peu de résultats depuis le calendrier, itération jour par jour…');
    eventDates = [];
    let cur = new Date(CONFIG.startDate);
    while (cur <= CONFIG.endDate) {
      eventDates.push({ code: toPageParam(cur), date: new Date(cur) });
      cur.setDate(cur.getDate() + 1);
    }
    console.log(`  → ${eventDates.length} jours à parcourir.`);
  }

  // ── Phase 2 : collecter les URLs d'événements par page de date ──
  console.log('\n[Phase 2] Collecte des fiches événements…');

  // Chargement éventuel de la progression
  let visitedDates = new Set();
  const eventMap   = new Map(); // url → { url, appearances[] }

  if (resume) {
    try {
      const raw = await fs.readFile(CONFIG.progressFile, 'utf8');
      const saved = JSON.parse(raw);
      visitedDates = new Set(saved.visitedDates || []);
      for (const [k, v] of Object.entries(saved.eventMap || {})) eventMap.set(k, v);
      console.log(`  → Reprise : ${visitedDates.size} dates déjà traitées, ${eventMap.size} URLs d'événements.`);
    } catch {
      console.log('  → Pas de fichier de progression trouvé, on repart de zéro.');
    }
  }

  for (let i = 0; i < eventDates.length; i++) {
    const { code, date } = eventDates[i];
    if (visitedDates.has(code)) continue;

    const label = date.toLocaleDateString('fr-FR', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
    process.stdout.write(`  [${i + 1}/${eventDates.length}] ${label} (${code}) … `);

    const html  = await get(`${CONFIG.baseUrl}/index.php?page=${code}`);
    if (!html) {
      console.log('ÉCHEC');
      await sleep(CONFIG.delayMs);
      continue;
    }

    const links = extractEventLinks(html, date.toISOString().split('T')[0]);
    console.log(`${links.length} événements`);

    for (const { url, label: lbl, context, date: d } of links) {
      if (!eventMap.has(url)) eventMap.set(url, { url, appearances: [] });
      eventMap.get(url).appearances.push({ date: d, label: lbl, context });
    }

    visitedDates.add(code);
    await sleep(CONFIG.delayMs);

    // Sauvegarde de la progression toutes les 20 dates
    if (i % 20 === 0) {
      await fs.writeFile(CONFIG.progressFile, JSON.stringify({
        visitedDates : [...visitedDates],
        eventMap     : Object.fromEntries(eventMap),
      }), 'utf8');
    }
  }

  console.log(`\n  → ${eventMap.size} URLs d'événements uniques collectées.`);

  // ── Phase 3 : scraper chaque fiche d'événement ──────────────
  console.log('\n[Phase 3] Scraping des fiches détaillées…');

  let results = [];

  // Chargement partiel éventuel lors d'une reprise
  if (resume) {
    try {
      const raw    = await fs.readFile(CONFIG.outputFile, 'utf8');
      const saved  = JSON.parse(raw);
      results      = saved.events || [];
      console.log(`  → Reprise : ${results.length} fiches déjà scrapées.`);
    } catch { /* pas encore de fichier */ }
  }

  const scrapedUrls = new Set(results.map(e => e.url));
  const pending     = [...eventMap.values()].filter(e => !scrapedUrls.has(e.url));
  console.log(`  → ${pending.length} fiches restant à scraper.`);

  for (let i = 0; i < pending.length; i++) {
    const { url, appearances } = pending[i];
    process.stdout.write(`  [${i + 1}/${pending.length}] ${url.split('/').slice(-2).join('/')} … `);

    const html = await get(url);
    if (!html) {
      console.log('ÉCHEC');
      await sleep(CONFIG.delayMs);
      continue;
    }

    const detail       = scrapeEventDetail(html, url);
    detail.appearances = appearances;
    results.push(detail);
    console.log('OK');

    await sleep(CONFIG.delayMs);

    // Sauvegarde intermédiaire toutes les 50 fiches
    if (i % 50 === 0) await save(results, false);
  }

  // ── Sauvegarde finale ────────────────────────────────────────
  await save(results, true);

  // Nettoyage du fichier de progression
  try { await fs.unlink(CONFIG.progressFile); } catch { /* n'existe pas */ }
}

main().catch(err => {
  console.error('\nErreur fatale :', err.message);
  process.exit(1);
});
