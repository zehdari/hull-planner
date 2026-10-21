# Hull Planner

Lay out robot internals inside a hull in 3D: move and rotate parts, resize the hull (rounded box or cylinder), and see overlaps, parts poking outside, mass, centre of mass vs centre of buoyancy, and net buoyancy.

**Live:** https://zehdari.github.io/hull-planner/

- **Parts:** tap to select, drag the gizmo, or type exact sizes/positions. "Push until it touches" and Auto-place handle stacking. Keep-out zones mark space parts must avoid.
- **Paste list:** one part per line, `name, L x W x H, mass` (mm, kg), or CSV/TSV columns. `⌀D x L` makes a cylinder.
- **Share:** Layouts → Share link packs the whole layout into the URL. Export/Import JSON and a parts CSV are there too.
- Frame: X forward, Y port, Z up; origin at the hull centre.

## CAD import

The default layout is the Venus hull, converted from the SolidWorks assembly with real part meshes:

    python3 tools/import_sw.py "cad/Venus Hull Assembly.SLDASM" static/models/venus --name Venus

It reads SolidWorks 2015+ files directly (each part's saved display mesh, plus the component placements and hidden states from the assembly), so SolidWorks isn't needed. Parts must be saved with display data, which is the default. Masses aren't in the files, so set them in the app. The raw CAD files (`cad/`) aren't committed.

Then the off-the-shelf parts are swapped for manufacturer CAD (ZED X, ZED X Mini, VN-100 Rugged, Jetson AGX Thor and AGX Orin dev kits), placed where the team's placeholders were:

    ~/tools/cadvenv/bin/python tools/replace_parts.py static/models/venus

Sources and orientation choices are listed at the top of `tools/replace_parts.py`. The simplified vendor meshes it reads (`vendor/`) aren't committed. `tools/sw_flatten.py` flattens a SolidWorks assembly with embedded components (an imported STEP) into one mesh; that's how the Orin came out of the team's Talos CAD.

No build step: `static/` is the whole app (three.js r170 vendored in `static/vendor`). `python3 -m http.server -d static` is enough to run it locally.

`server.py` is an optional backend that adds named server-side saves (`/api/layouts`). The UI only shows that section when the backend is there.
