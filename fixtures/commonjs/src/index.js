'use strict';
// The package entry, per package.json `main`.
//
// Three CommonJS load forms, all of which must build an edge:
//   - destructured:  const { helper } = require('./helper.js')
//   - whole module:  const whole = require('./whole.js')
//   - member access: require('./entry.js').viaMember()

const { helper } = require('./helper.js');
const whole = require('./whole.js');
const { renamed } = require('./renamed.js');

module.exports = {
  result: helper() + whole.value() + renamed() + require('./entry.js').viaMember(),
};