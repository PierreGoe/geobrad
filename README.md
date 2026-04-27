# Geobrad 🗺

**Geobrad** est un outil personnel de visualisation des braderies, brocantes et vide-greniers dans le Nord, le Pas-de-Calais et la Haute-Savoie (depts 59, 62, 74).

## Pages

| Page | Description |
|---|---|
| `map_brocabrac.html` | Carte interactive de tous les événements (cluster, filtres mois/catégorie/ville/date) |
| `nearby.html` | Événements dans un rayon autour de villes de référence (tableau + carte) |

## Données

- **brocabrac.fr** — scrapé via `scraper_brocabrac.js`, génère `events_data_brocabrac.js`
- **sabradou.com** — données inline dans `nearby.html`

### Lancer le scraper

```bash
node scraper_brocabrac.js          # scrape si données > 24h
node scraper_brocabrac.js --force  # force le scraping
```

## ⚠ Avertissement légal

> **Geobrad est un projet à but strictement non lucratif.**
> Il ne collecte aucune donnée personnelle, n'affiche aucune publicité, et n'a aucune finalité commerciale.
> Les données affichées proviennent de [brocabrac.fr](https://brocabrac.fr) et [sabradou.com](http://www.sabradou.com) et sont utilisées à titre informatif et personnel uniquement.
> Ce projet n'est pas affilié à ces sites et ne prétend pas les représenter.

## Stack

- [Leaflet.js](https://leafletjs.com/) 1.9.4 — carte interactive
- [Leaflet.markercluster](https://github.com/Leaflet/Leaflet.markercluster) 1.5.3 — clustering
- Node.js + axios + cheerio — scraping
