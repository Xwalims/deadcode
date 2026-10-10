'use strict';
// Reached by a destructured require.
//
// `neverDestructured` is the negative control: destructuring pulls `renamed` out
// by name, so nothing reaches the other export and it must still be reported.
function renamed() {
  return 4;
}

function neverDestructured() {
  return 5;
}

module.exports = { renamed, neverDestructured };