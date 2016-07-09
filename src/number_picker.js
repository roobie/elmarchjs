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

export const model = 0;
export const init = () => model;
export const initWith = n => n;

export const Action = Type({
  Set: [Number]
});

export const update = (model, action) => {
  return Action.case({
    Set: n => n
  }, action);
};

export const view = (model, event) => {
  return h('div', [
    h('input', {
      props: {
        type: 'number',
        value: model
      },
      on: {
        input: e => {
          const v = parseFloat(e.target.value);
          if (!isNaN(v)) {
            event(Action.Set(v));
          }
        }
      }
    })
  ]);
};
