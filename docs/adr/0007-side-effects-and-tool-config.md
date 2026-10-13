# 0007: Classic worker side effects

`package.json` lists `./sw/convex-web-push-sw.js` in `sideEffects` so bundlers retain its listener registration. All other package modules can be tree-shaken. Knip includes `bin/*.js` and `sw/*.js` as entry points.
