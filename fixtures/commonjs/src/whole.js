'use strict';
// Reached by a require that keeps the whole module object.
//
// `alsoExported` is named nowhere and is still kept alive: a whole-module
// binding means the namespace object is held, and without type information
// there is no way to tell `whole.value()` from `whole.alsoExported()`. A false
// positive costs more than a missed finding, so the conservative reading wins.
function value() {
  return 2;
}

function alsoExported() {
  return 3;
}

module.exports = { value, alsoExported };