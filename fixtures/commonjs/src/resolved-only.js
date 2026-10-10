'use strict';
// Named only by `require.resolve()` in side-effect.js, which returns a PATH
// and does not load the module. It must stay unreachable.
function neverRuns() {
  return 'this module is never loaded';
}

module.exports = { neverRuns };