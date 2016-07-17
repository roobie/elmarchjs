const request = require('then-request');
const h = require('snabbdom/h');
const Type = require('union-type');
const mori = require('mori-fluent')(require('mori'), require('mori-fluent/extra'));
const {
  vector,
  hashMap,
  isVector,
  isMap,
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

const provided = (b, res) => b ? res() : h('span');
const ifElse = (b, res1, res2) => b ? res1() : res2();

export const model = hashMap(
  ':name', 'LIST',
  ':expanded', true,
  ':hovering', false,
  ':nodes', vector()
);

export const init = (...props) => model.assoc(...props || []);

export const Action = Type({
  ToggleExpanded: [isVector],
  SetHover: [isVector, Boolean],
  AddChild: [isVector, isMap, isMap]
});

export const update = (model, action) => {
  return Action.case({
    ToggleExpanded: (basePath) =>
      model.updateIn(basePath.conj(':expanded').intoArray(), R.not),
    SetHover: (basePath, hovering) =>
      model.updateIn(basePath.conj(':hovering').intoArray(), mori.constantly(hovering)),
    AddChild: function(basePath, currentModel, childModel) {
      const path = basePath.into(vector(':nodes')).intoArray();
      const newModel = model.updateIn(
        path,
        nodes => nodes.conj(childModel));
      return newModel;
    }
  }, action);
};

export const view = (model, event, path=vector()) => {
  return h('div.list', {
    on: {
      mouseover: e => {
        event(Action.SetHover(path, true));
        e.stopPropagation();
        return false;
      },
      mouseout: e => {
        event(Action.SetHover(path, false));
        e.stopPropagation();
        return false;
      },
    }
  }, [
    h('div', [

      h('span', model.get(':name')),

      h('button', {
        class: {
          mono: true
        },
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
      }, 'add list'),

      provided(!model.get(':nodes').isEmpty(),
               () => h('button', {
                 class: {
                   mono: true
                 },
                 props: {
                   type: 'button'
                 },
                 on: {
                   click: e => event(Action.ToggleExpanded(path))
                 }
               }, ifElse(model.get(':expanded'),
                         () => '[-]',
                         () => '[+]')))

    ]),

    h('div',
      ifElse(model.get(':expanded'),
             () => model.get(':nodes').mapKV(
               (i, node) => {
                 const subTreePath = path.into(vector(':nodes', i));
                 return view(node, event, subTreePath);
               }, vector()).intoArray(),
             () => '…'))
  ]);
};
