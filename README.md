# Hull Planner

Lay out robot internals inside a hull in 3D: move and rotate parts, resize the hull (rounded box or cylinder), and see overlaps, parts poking outside, mass, centre of mass vs centre of buoyancy, and net buoyancy.

**Live:** https://zehdari.github.io/hull-planner/

- **Parts:** tap to select, drag the gizmo, or type exact sizes/positions. "Push until it touches" and Auto-place handle stacking. Keep-out zones mark space parts must avoid.
- **Paste list:** one part per line, `name, L x W x H, mass` (mm, kg), or CSV/TSV columns. `⌀D x L` makes a cylinder.
- **Share:** Layouts → Share link packs the whole layout into the URL. Export/Import JSON and a parts CSV are there too.
- Frame: X forward, Y port, Z up; origin at the hull centre.

No build step: `static/` is the whole app (three.js r170 vendored in `static/vendor`). `python3 -m http.server -d static` is enough to run it locally.

`server.py` is an optional backend that adds named server-side saves (`/api/layouts`). The UI only shows that section when the backend is there.
