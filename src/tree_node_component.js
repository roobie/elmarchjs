const request = require('then-request');
const h = require('snabbdom/h');
const Type = require('union-type');
const mori = require('mori-fluent')(require('mori'), require('mori-fluent/extra'));
const {
  vector,
  hashMap,
  map,
  keys,
  vals,
  equals,
  getIn,
  get,
  assoc,
  updateIn,
  nth,
  toClj,
  toJs
} = mori;
const R = require('ramda');

export const model = hashMap(
  ':name', 'outlist',
  ':expanded', true,
  ':nodes', vector()
);

export const init = (...props) => model.assoc(...props || []);

export const Action = Type({
  Toggle: [],
  AddChild: [mori.isVector, mori.isMap, mori.isMap]
});

export const update = (model, action) => {
  return Action.case({
    Toggle: () => model.updateIn([':expanded'], R.not),
    AddChild: function(basePath, currentModel, childModel) {
      const path = basePath.into(vector(':nodes')).toJs();
      const newModel = model.updateIn(
        path,
        nodes => nodes.conj(childModel));
      return newModel;
    }
  }, action);
};

export const view = (model, event, path=vector()) => {
  return h('div.list', [
    h('div', [
      h('span', model.get(':name')),

      h('button', {
        props: {
          type: 'button'
        },
        on: {
          click: e => {
            const childModel = init();
            return event(Action.AddChild(
              path,
              model,
              childModel));
          }
        }
      }, 'Add child')

    ]),

    h('div',
      model.get(':nodes').mapKV(
        (i, node) => {
          const subTreePath = path.into(vector(':nodes', i));
          return view(node, event, subTreePath);
        },
        vector())
      .intoArray())
  ]);
};
