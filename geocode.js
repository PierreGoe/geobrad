'use strict';

/**
 * geocode.js
 * ──────────
 * Lit events.json, géocode chaque événement via l'API publique geo.api.gouv.fr
 * (centroïde de commune par code postal), puis produit :
 *   - events_geo.json    → données complètes avec lat/lng
 *   - events_data.js     → variable JS globale pour map.html (sans serveur)
 *
 * Usage : node geocode.js
 */

const axios = require('axios');
const fs    = require('fs').promises;
const path  = require('path');

const GEO_API    = 'https://geo.api.gouv.fr/communes';
const DELAY_MS   = 150;  // API publique : soyons polis

const OUT_JSON   = path.resolve(__dirname, 'events_geo.json');
const OUT_JS     = path.resolve(__dirname, 'events_data.js');
const IN_JSON    = path.resolve(__dirname, 'events.json');

const http = axios.create({ timeout: 10_000 });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Cache code_postal → {lat, lng} pour ne pas requerir plusieurs fois le même */
const cache = new Map();

async function geocodePostal(postalCode, cityName) {
  if (!postalCode) return null;

  if (cache.has(postalCode)) return cache.get(postalCode);

  try {
    const { data } = await http.get(GEO_API, {
      params: {
        codePostal : postalCode,
        fields     : 'nom,code,centre',
        format     : 'json',
        geometry   : 'centre',
      },
    });

    if (!data || data.length === 0) {
      cache.set(postalCode, null);
      return null;
    }

    // Si plusieurs communes pour ce code postal, essayer de matcher le nom
    let match = data[0];
    if (data.length > 1 && cityName) {
      const norm = (s) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
      const cn   = norm(cityName);
      const found = data.find(c =>
        norm(c.nom).includes(cn) || cn.includes(norm(c.nom))
      );
      if (found) match = found;
    }

    const [lng, lat] = match.centre.coordinates;
    const result = { lat, lng, communeNom: match.nom, communeCode: match.code };
    cache.set(postalCode, result);
    return result;
  } catch (err) {
    console.warn(`  ⚠  GEO échec [${postalCode}]: ${err.message}`);
    cache.set(postalCode, null);
    return null;
  }
}

async function main() {
  console.log('═'.repeat(60));
  console.log('  Géocodage des événements Sabradou');
  console.log('═'.repeat(60));

  // Lecture des événements
  let raw;
  try {
    raw = await fs.readFile(IN_JSON, 'utf8');
  } catch {
    console.error(`Fichier introuvable : ${IN_JSON}`);
    console.error('Lance d\'abord : node scraper.js');
    process.exit(1);
  }

  const input  = JSON.parse(raw);
  const events = input.events || [];
  console.log(`  → ${events.length} événements à géocoder\n`);

  let ok = 0, fail = 0;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    process.stdout.write(`  [${i + 1}/${events.length}] ${ev.city ?? '?'} (${ev.postalCode ?? '?'}) … `);

    const geo = await geocodePostal(ev.postalCode, ev.city);
    if (geo) {
      ev.lat = geo.lat;
      ev.lng = geo.lng;
      if (!ev.communeNom) ev.communeNom = geo.communeNom;
      console.log(`${geo.lat.toFixed(4)}, ${geo.lng.toFixed(4)}`);
      ok++;
    } else {
      console.log('NON GEOCODÉ');
      fail++;
    }

    await sleep(DELAY_MS);
  }

  console.log(`\n  ✅  ${ok} géocodés, ${fail} en échec`);

  // ── Sauvegarde JSON ──────────────────────────────────────────
  const output = {
    geocoded_at  : new Date().toISOString(),
    total_events : events.length,
    geocoded     : ok,
    events,
  };
  await fs.writeFile(OUT_JSON, JSON.stringify(output, null, 2), 'utf8');
  console.log(`  → ${OUT_JSON}`);

  // ── Sauvegarde JS (var globale pour map.html en file://) ─────
  const js = `/* Auto-généré par geocode.js — ${new Date().toISOString()} */\n` +
             `var SABRADOU_EVENTS = ${JSON.stringify(events, null, 2)};\n`;
  await fs.writeFile(OUT_JS, js, 'utf8');
  console.log(`  → ${OUT_JS}`);
  console.log('\n  Ouvre maintenant map.html dans ton navigateur 🗺');
}

main().catch(err => {
  console.error('\nErreur fatale :', err.message);
  process.exit(1);
});
