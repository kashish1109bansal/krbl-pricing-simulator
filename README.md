# KRBL Pricing Simulator — Render Deployment

This is a single self-contained `index.html` (vanilla HTML/CSS/JS, no build step,
no external CDN dependencies) so it deploys to Render as a **Static Site**.

## Deploy steps
1. Push this folder (containing `index.html` and `render.yaml`) to a GitHub repo.
2. In the Render dashboard: New -> Static Site -> connect the repo.
3. Render will read `render.yaml` automatically:
   - Build Command: (none — nothing to build)
   - Publish Directory: `.`
4. Click Deploy. Render serves `index.html` directly with no server process,
   so cold starts and runtime costs are zero.

## Local preview
Just open `index.html` directly in a browser, or serve it locally:

    npx serve .
