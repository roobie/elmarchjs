const h = require('snabbdom/h');
const Type = require('union-type');
const flyd = require('flyd');
const { stream } = flyd;
const mori = require('mori');
const {
  vector,
  map,
  assoc,
  nth,
  toJs
} = mori;

// Model definition and initial state
export const model = vector(0xfe, 0xfe, 0xfe);
// computation which returns immutable initial state;
export const init = () => model;

// All available actions
export const Action = Type({
  Add: [Number, Number],
  Sub: [Number, Number]
});

export const update = function (action, state) {
  const _update = (sign) =>
          (k, n) => assoc(state, k, Math.abs(nth(state, k) + (n * sign)));

  const model = Action.case({
    Add: _update(1),
    Sub: _update(-1)
  }, action);

  return model;
};

export function view(state, event) {
  // this should be an own component...
  const col = (v, key) => {
        return h('div', {
          style: {
            width: '33%',
            float: 'left',
            height: '100vh'
          },
          on: {
            mousewheel: e => event(Action.Add(key, e.deltaY)),
            click: () => event(Action.Sub(key, 0xf))
          }
        }, [
          h('span', v % 0xff)
        ]);
  };

  const [cr, cg, cb] = toJs(map(c => c % 0xff, state));
  const colorString = `rgb(${cr}, ${cg}, ${cb})`;
  return h('div', {
    style: {
      height: '100vh',
      backgroundColor: colorString
    }
  }, toJs(map(col, state, mori.iterate(mori.inc, 0))));
}
