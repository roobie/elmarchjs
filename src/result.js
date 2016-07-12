const Type = require('union-type');

const isAnything = a => a !== void 0;

const isError = e => !!e && Error.prototype.isPrototypeOf(e);

const Result = Type({
  Ok: [isAnything],
  Err: [isError]
});

module.exports = Result;
