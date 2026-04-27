#!/usr/bin/env node
/**
 * Brocabrac.fr scraper — braderies dans le 59, 62 et 74
 * Scrape les events de avril 2026 à décembre 2026
 * Les lat/lng sont directement dans le JSON-LD de chaque page, pas besoin de géocodage.
 *
 * Usage: node scraper_brocabrac.js
 */

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const OUT_JSON     = path.join(__dirname, 'events_brocabrac.json');
const OUT_JS       = path.join(__dirname, 'events_data_brocabrac.js');
const OUT_CHANGELOG = path.join(__dirname, 'scrape-changelog.json');

const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 heures
const FORCE      = process.argv.includes('--force');

const DEPTS      = ['59', '62', '74'];
const MONTHS     = ['avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];
const CATEGORIES = ['braderie', 'brocante', 'vide-grenier'];
const DELAY_MS   = 300;  // délai entre requêtes

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'fr-FR,fr;q=0.9',
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Extrait tous les JSON-LD @type:Event d'un HTML cheerio
 */
function extractEvents($) {
  const events = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text());
      if (data['@type'] === 'Event') {
        events.push(data);
      }
    } catch { /* ignore parse errors */ }
  });
  return events;
}

/**
 * Extrait l'ID numérique de l'event depuis l'URL
 * e.g. "https://brocabrac.fr/59/valenciennes/1362248-donnerie" → "1362248"
 */
function extractId(url) {
  const m = url.match(/\/(\d+)-/);
  return m ? m[1] : url;
}

/**
 * Normalise un event JSON-LD en objet plat pour notre carte
 */
function normalizeEvent(raw) {
  const loc  = raw.location || {};
  const addr = loc.address || {};
  const geo  = loc.geo || {};

  return {
    id:            extractId(raw.url || raw['@id'] || ''),
    name:          raw.name || '',
    url:           raw.url || '',
    description:   raw.description || '',
    startDate:     raw.startDate || '',
    endDate:       raw.endDate || '',
    eventStatus:   (raw.eventStatus || '').replace('https://schema.org/', ''),
    // Lieu
    placeName:     loc.name || '',
    streetAddress: addr.streetAddress || '',
    city:          addr.addressLocality || '',
    postalCode:    addr.postalCode || '',
    country:       addr.addressCountry || 'FR',
    // Coordonnées (déjà dans le JSON-LD!)
    lat:           geo.latitude  || null,
    lng:           geo.longitude || null,
    // Autres
    category:      raw._category || 'autre',
    organizer:     (raw.organizer || {}).name || '',
    freeEntry:     raw.isAccessibleForFree === true,
    image:         (raw.image || [])[0] || '',
    // Déduplication
    _rawId:        raw['@id'] || '',
  };
}

/**
 * Récupère tous les événements d'une URL (gère la pagination)
 * @param {string} url
 * @param {string} label
 * @param {string} category — catégorie connue (braderie / brocante / vide-grenier)
 */
async function fetchPage(url, label, category = 'autre') {
  const events = [];
  let page = 1;

  while (true) {
    const pageUrl = page === 1 ? url : `${url}?p=${page}`;
    // Certaines URLs ont déjà un ? donc on adapte
    const finalUrl = page === 1 ? url : (url.includes('?') ? `${url}&p=${page}` : `${url}?p=${page}`);

    process.stdout.write(`  [${label}] page ${page}... `);
    try {
      const resp = await axios.get(finalUrl, { headers: HEADERS, timeout: 15000 });
      const $ = cheerio.load(resp.data);
      const batch = extractEvents($);
      // Tag chaque event avec la catégorie (connue depuis l'URL de scraping)
      batch.forEach(ev => { ev._category = category; });
      process.stdout.write(`${batch.length} events\n`);

      if (batch.length === 0) break;
      events.push(...batch);

      // Cherche le numéro de dernière page dans la pagination
      const paginationLinks = [];
      $('.pagination [data-obf]').each((_, el) => {
        const obf = $(el).attr('data-obf') || '';
        if (obf.startsWith('|')) {
          try {
            const decoded = Buffer.from(obf.slice(1), 'base64').toString('utf8');
            const pMatch = decoded.match(/p=(\d+)/);
            if (pMatch) paginationLinks.push(parseInt(pMatch[1], 10));
          } catch { /* ignore */ }
        }
      });

      const maxPage = paginationLinks.length ? Math.max(...paginationLinks) : 1;
      if (page >= maxPage) break;
      page++;
    } catch (err) {
      console.error(`\n  ERREUR sur ${finalUrl}: ${err.message}`);
      break;
    }

    await sleep(DELAY_MS);
  }

  return events;
}

function loadChangelog() {
  try {
    if (fs.existsSync(OUT_CHANGELOG)) {
      return JSON.parse(fs.readFileSync(OUT_CHANGELOG, 'utf8'));
    }
  } catch { /* ignore */ }
  return { runs: [] };
}

function saveChangelog(changelog, stats) {
  const entry = {
    date:       new Date().toISOString(),
    depts:      DEPTS,
    totalEvents: stats.total,
    withCoords:  stats.withCoords,
    noCoords:    stats.noCoords,
    categories:  stats.categories,
  };
  changelog.runs.unshift(entry);          // plus récent en premier
  changelog.runs = changelog.runs.slice(0, 50); // garde les 50 derniers
  changelog.lastRun = entry.date;
  fs.writeFileSync(OUT_CHANGELOG, JSON.stringify(changelog, null, 2), 'utf8');
  return entry;
}

async function main() {
  console.log('=== Scraper Brocabrac.fr ===');
  console.log(`Depts: ${DEPTS.join(', ')} | Catégories: ${CATEGORIES.join(', ')} | Mois: ${MONTHS.join(', ')}`);
  console.log('');

  // ── Vérification changelog ──────────────────────────────────────────
  const changelog = loadChangelog();
  if (!FORCE && changelog.lastRun) {
    const age     = Date.now() - new Date(changelog.lastRun).getTime();
    const ageH    = (age / 3_600_000).toFixed(1);
    const nextRun = new Date(new Date(changelog.lastRun).getTime() + MAX_AGE_MS);
    const nextStr = nextRun.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

    if (age < MAX_AGE_MS) {
      console.log(`✅ Dataset déjà à jour (dernier scraping il y a ${ageH}h, prochain après ${nextStr}).`);
      console.log(`   Utilisez --force pour forcer le re-scraping.`);
      const last = changelog.runs[0];
      console.log(`   Dernier run : ${last.totalEvents} événements (${last.withCoords} avec coords) — depts ${last.depts.join(', ')}`);
      return;
    }

    console.log(`⏱  Dernier scraping il y a ${ageH}h → re-scraping…\n`);
  }

  const allRaw = [];

  for (const dept of DEPTS) {
    for (const cat of CATEGORIES) {
      for (const month of MONTHS) {
        const url = `https://brocabrac.fr/${dept}/${cat}/${month}/`;
        console.log(`Fetching ${url}`);
        const raw = await fetchPage(url, `${dept}/${cat}/${month}`, cat);
        allRaw.push(...raw);
        await sleep(DELAY_MS);
      }
    }
  }

  console.log(`\nTotal brut: ${allRaw.length} occurrences`);

  // Normalise et déduplique par ID (une entrée par événement, on prend la première occurrence)
  const seen = new Map();
  for (const raw of allRaw) {
    const id = extractId(raw.url || raw['@id'] || '');
    if (id && !seen.has(id)) {
      seen.set(id, normalizeEvent(raw));
    }
  }

  const events = [...seen.values()];
  console.log(`Après déduplication: ${events.length} événements uniques`);

  // Filtre les events sans coordonnées
  const withCoords = events.filter(e => e.lat && e.lng);
  const noCoords   = events.filter(e => !e.lat || !e.lng);
  console.log(`Avec coordonnées: ${withCoords.length} | Sans: ${noCoords.length}`);

  if (noCoords.length > 0) {
    console.log('Sans coordonnées:');
    noCoords.forEach(e => console.log(`  - ${e.name} (${e.city}, ${e.postalCode})`));
  }

  // JS wrapper pour la carte
  const catDistrib = {};
  events.forEach(e => { catDistrib[e.category] = (catDistrib[e.category] || 0) + 1; });
  console.log('Répartition par catégorie:', catDistrib);

  fs.writeFileSync(OUT_JSON, JSON.stringify(events, null, 2), 'utf8');
  console.log(`\nJSON sauvegardé: ${OUT_JSON}`);

  // ── Changelog ──────────────────────────────────────────────────────
  const entry = saveChangelog(changelog, {
    total:      events.length,
    withCoords: withCoords.length,
    noCoords:   noCoords.length,
    categories: catDistrib,
  });
  console.log(`Changelog mis à jour: ${OUT_CHANGELOG} (run #${changelog.runs.length})`);

  // JS wrapper pour la carte
  const jsContent = `// Généré par scraper_brocabrac.js le ${new Date().toISOString()}
// ${events.length} événements — brocabrac.fr — depts ${DEPTS.join(', ')}
const BROCABRAC_EVENTS = ${JSON.stringify(events, null, 2)};
`;
  fs.writeFileSync(OUT_JS, jsContent, 'utf8');
  console.log(`JS sauvegardé: ${OUT_JS}`);
}

main().catch(err => {
  console.error('Erreur fatale:', err);
  process.exit(1);
});
