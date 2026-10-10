'use strict';
// Reached only as `require('./entry.js').viaMember()`: a member access on the
// require call, three AST nodes deep. The bare-require branch records the edge;
// the member branch has to record the NAME or `viaMember` reads as unimported.
function viaMember() {
  return 6;
}

module.exports = { viaMember };