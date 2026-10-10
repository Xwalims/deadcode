'use strict';
// Reached only through a bare side-effect require: no binding, but an edge.
//
// `require.resolve` below is a PATH lookup. It names a real file in this
// repository and still must not make it reachable, because resolving a path
// does not execute the module.
const entryPath = require.resolve('./resolved-only.js');

require('./polyfill.js');

module.exports = { entryPath, loaded: true };