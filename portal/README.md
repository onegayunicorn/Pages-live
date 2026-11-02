# Portal assets

The GitHub Pages entry point remains the repository-root `index.html`. It stays a
single-file app so the portal can be exported to another Pages repository by the
built-in publisher. This directory contains only small, shared static assets:

- `favicon.svg` — sandboxd mark
- `site.webmanifest` — install metadata; its scope and start URL resolve to the
  repository-root page, including GitHub project-site paths such as
  `/Pages-live/`

The Pages build copies these assets into the site artifact. The in-app publisher
also commits them alongside `index.html` so its generated site does not lose its
manifest or favicon.
