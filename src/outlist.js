require('./outlist.less');
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

const TreeNodeComponent = require('./tree_node_component');

export const model = hashMap(
  ':title', 'outlist',
  ':tree', TreeNodeComponent.model
);

export const init = (props) => model.assoc(...props || []);

export const Action = Type({

  TreeAction: [R.T]
});

const subActionHandler = (component, model, key) =>
        (action) => model.assoc(key, component.update(model.get(key), action));

export const update = (model, action) => {
  return Action.case({
    // TreeAction: (a) => model.assoc(
    //   ':tree',
    //   TreeNodeComponent.update(model.get(':tree'), a))
    TreeAction: subActionHandler(TreeNodeComponent, model, ':tree')
  }, action);
};

export const view = (model, event) => {
  return h('div', [
    h('header', [
      h('h6', model.get(':title')),
    ]),
    h('div.col.left', [
      TreeNodeComponent.view(
        model.get(':tree'),
        treeAction => event(Action.TreeAction(treeAction)))
    ]),
    h('div.col.right', [
      h('pre', JSON.stringify(model.get(':tree').toJs(), null, 2))
    ]),
    h('footer', [

    ])
  ]);
};
