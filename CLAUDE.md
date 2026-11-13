# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

NASA Space Apps 2026 — "Harmonization of MODIS and VIIRS Hot Spots". This repo is the **web map**:
- It shows NASA FIRMS fire detections, and later the team's harmonized data.
- Users filter by rectangle or country, get statistics, play a day-by-day timeline, and compare two periods (e.g. same dates in different years).

The backend is ASP.NET Core MVC + API controllers on **.NET 10**. The frontend is **vanilla JS ES modules, no build step**: Leaflet 1.9.4 + Leaflet-Geoman 2.20.4 from unpkg, with an OSM base map.

## Commands

```powershell
dotnet build                                                   # whole solution (Kelvin.slnx)
dotnet test                                                    # xUnit, tests/FireMap.Tests
dotnet test --filter "FullyQualifiedName~TimeRangePlannerTests" # one class
dotnet test --filter "FullyQualifiedName~GridTilingTests.World_has_648_tiles_of_10_degrees"  # one test
dotnet run --project src/FireMap.Web --launch-profile http     # http://localhost:5032 (Development)
cd src/FireMap.Web; dotnet user-secrets set Firms:MapKey <key> # FIRMS key (Development only)
```

- **Mode:** without `Firms:MapKey` the app runs in **sample mode**, serving real FIRMS extracts from `src/FireMap.Web/Data/sample/{layerId}.csv` (Europe, Oct/Nov 2026).
- **User-secrets load only in Development.** `dotnet run` without the launch profile runs as Production, which silently falls back to sample mode.
- **Restart after view changes.** Razor views and `asp-append-version` fingerprints are produced at build/startup, so `.cshtml` changes need a restart. Static JS/CSS changes need only a hard reload.
- **No JS tooling.** There is no npm or linter. Check syntax by copying a module to `.mjs` and running `node --check`.
- **Browser testing:** drive headless Edge (`msedge --headless=new --remote-debugging-port=…`) over CDP from a .NET file-based script (`dotnet run Script.cs`).
  - Node here is 20.9 and has no built-in WebSocket.
  - Pick the CDP target by URL; Edge opens extra page targets.
  - File-based .NET scripts need `#:property JsonSerializerIsReflectionEnabledByDefault=true` to use System.Text.Json.

## Backend architecture (src/FireMap.Web)

Request path:
`Controllers/Api/*` → `HotspotQueryService` (validates the range, applies exact area/date filtering) → `HotspotProviderRegistry` → `IHotspotProvider` (one per map layer).

- **Layers are providers.** `IHotspotProvider` (`Services/IHotspotProvider.cs`) is the extension point. Each provider is registered in `Program.cs`, and `/api/layers` lists them all, so the frontend needs no change to show a new layer.
  - Providers may return points *outside* the requested area or dates (whole cache tiles). Exact filtering happens centrally in `HotspotQueryService` with `QueryArea.Contains`.
  - Harmonized data from the team goes in as a new provider. Its records map onto `Models/Hotspot.cs`.
- **FIRMS provider pipeline** (`Services/Firms/`):
  - `FirmsHotspotProvider` asks `TimeRangePlanner` for fetch plans: 1-day chunks aligned to a 2000-01-01 epoch, using the SP (archive) source where available and NRT otherwise, according to `FirmsAvailabilityService`.
  - It asks `GridTiling` for 30° tiles. For countries, only tiles that intersect the polygon are used.
  - It fetches each plan × tile through `CachedFirmsClient` → HybridCache (L1 memory, L2 `Services/Caching/FileDistributedCache` writing gzip files in `App_Data/firms-cache/`) → `FirmsClient` (raw HTTP).
  - `FirmsCsvParser` normalizes MODIS and VIIRS columns and confidence.
- **Quota.** FIRMS allows 5,000 transactions per 10 minutes. **Measured cost: 2 transactions per day requested, independent of area or row count.** This is why tiles are large and chunks are 1 day.
  - `FirmsRateGuard` counts weighted cost (`Days × TransactionsPerDay`). `FirmsStatusPoller` re-syncs it with FIRMS `mapkey_status`.
  - Above `Firms:SoftLimit`, cache misses throw `FirmsQuotaException` inside the HybridCache factory (so nothing gets cached). The API then returns `partial: true` and lists the missing tiles.
- **Cache keys** include the tile size (`firms:{source}:{date}_{n}d:{size}deg_{x}_{y}`). If you change `TileSizeDeg` or `ChunkDays`, purge `App_Data/firms-cache/` (`DELETE /api/cache` in Development).
- **TTL:** SP data, and NRT data older than `NrtSettleDays`, are cached for 30 days. Recent NRT is cached for 20 minutes.
- **Errors → HTTP** via `Infrastructure/ApiExceptionFilter`: `ArgumentException`→400, `KeyNotFoundException`→404, `QueryTooLargeException`→422.
- **Settings:** all limits live in `appsettings.json` (`Firms:*`, `Api:*`). `/api/config` passes the ones the frontend needs (`tileSizeDeg`, `requestGridDeg`, `mapMaxTiles`, `maxRangeDays`, `transactionsPerDay`).

## Frontend architecture (src/FireMap.Web/wwwroot/js)

`app.js` owns the state and wires the modules together through callbacks. State is mirrored in the URL hash, e.g. `#d:A..A;b:B..B;l:layers;@lon,lat,zz;c:ISO3|r:w,s,e,n`.

- **`layers.js` `HotspotLayers`:**
  - Each layer holds one **slot per period**: one period normally, A and B in compare mode.
  - All markers draw on one shared `L.canvas` in the `hotspots` pane. Canvas draw order = insertion order; `_drawAll()` draws B then A so A stays on top.
  - Request URLs are snapped to `requestGridDeg`, so small pans hit the browser LRU.
  - A selection filter (`setFilter`) switches requests from the viewport to `bbox=`/`country=`.
  - Markers are built once per response and indexed by UTC day (`byDay`). The timeline (`setDays`) only swaps which markers are drawn, with no refetch.
- **`timeline.js`:** client-side playback over the loaded data. In compare mode, days are aligned by index (day *n* of A beside day *n* of B).
- **`selection.js` `AreaSelector`:**
  - Rectangle (Geoman) or country.
  - Only one is active at a time; pressing a tool button again removes its filter.
  - Country hit-testing is JS point-in-polygon on map events, because the points canvas would swallow events meant for country polygons.
- **`panel.js`:** sidebar rendering (layer badges, stats, A-vs-B comparison table).
- **Date inputs only validate while you edit; nothing loads until Apply/Enter.** Keep it that way: applying on each change made two-ended range edits impossible.
- **Colours:** layer colours come from `/api/layers`. Period colours are the CSS vars `--period-a` / `--period-b` in `site.css`, read by JS.

## Country boundaries — hard requirement

`wwwroot/data/countries.json` is shared by the map and the server-side stats. It comes from Natural Earth 1:10m **Ukraine point of view** (`ne_10m_admin_0_countries_ukr`), so **Crimea and all occupied territories are part of Ukraine**. In this dataset Kosovo is part of Serbia.
- Regenerate with `dotnet run tools/SlimCountries.cs -- <in.geojson> <out.json> 0.02`. The script checks that Simferopol, Sevastopol and Kerch fall inside UKR.
- Before adding any boundary, admin-1, geocoding or base-map source, check how it treats Crimea and raise it with the user if it differs.
