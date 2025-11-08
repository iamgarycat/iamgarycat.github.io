# Expression Enumerator — Web UI

This is a client-side port of the Python expression-enumerator to a single-page web UI suitable for GitHub Pages.

How to use
- Copy the files (index.html, style.css, app.js) to the root of your `iamgarycat/iamgarycat.github.io` repository (or a subfolder).
- Commit & push. GitHub Pages will serve the site automatically at `https://iamgarycat.github.io/` (or `https://iamgarycat.github.io/<subfolder>/`).
- Open the page, configure parameters and click "Run". Results show top-K candidates with errors.

Notes & warnings
- This runs entirely in the browser. Heavy enumeration (large max_cost) may freeze the page for some seconds. Start with small `max_cost` (<= 6) and `max_seconds` small when experimenting.
- For long-running runs you should consider migrating the heavy loop into a Web Worker to avoid blocking the UI (not implemented here).
