const h = require('snabbdom/h');
const Type = require('union-type');
const flyd = require('flyd');
const { stream } = flyd;
const mori = require('mori');
const {
  vector,
  hashMap,
  map,
  keys,
  vals,
  getIn,
  assoc,
  nth,
  toJs
} = mori;

const numberPicker = require('./number_picker');

// Model definition and initial state
export const model = hashMap(
  "R", 0xfe,
  "G", 0xfe,
  "B", 0xfe
);
// computation which returns immutable initial state;
export const init = () => model;

// All available actions
export const Action = Type({
  Add: [String, Number],
  Set: [String, Number]
});

export const update = function (action, model) {
  const newModel = Action.case({
    Add: (k, n) => assoc(model, k, Math.abs(getIn(model, k) + n) % 0xff),
    Set: (k, n) => assoc(model, k, n <= 0 ? 0xfe : n)
  }, action);

  return newModel;
};

const rgb = (r, g, b) => `rgb(${Number(r||0)},${Number(g||0)},${Number(b||0)})`;

export function view(model, event) {
  // this should be an own component...
  const singleColorPicker = key => {
    const value = getIn(model, key) % 0xff;
    const m = {
      [key]: value
    };

    return h('div', {
      style: {
        backgroundColor: rgb(m.R, m.G, m.B)
      },
      on: {
        mousewheel: e => event(Action.Add(key, e.deltaY))
      }
    }, [
      numberPicker.view(
        value,
        act => event(Action.Set(key, numberPicker.update(value, act))))
    ]);
  };

  const colorString = rgb(...toJs(map(c => c % 0xff, vals(model))));
  return h('div', [
    h('div', {
      style: {
        backgroundColor: colorString
      }
    }, 'selected color'),
    h('div', toJs(map(singleColorPicker, keys(model)))),
    h('div', [
      h('pre', JSON.stringify(toJs(model), null, 2))
    ])
  ]);
}
