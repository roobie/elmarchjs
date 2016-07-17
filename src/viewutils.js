const h = require('snabbdom/h');

const empty = h('span');
export const provided = (b, res) => b ? res() : empty;
export const ifElse = (b, res1, res2) => b ? res1() : res2();

export function is(b, dispatch) {
  if (b) {
    return dispatch.yes();
  } else {
    return dispatch.no();
  }
}
