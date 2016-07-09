const request = require('then-request');
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
  equals,
  getIn,
  get,
  assoc,
  nth,
  toClj,
  toJs
} = mori;

const model = hashMap(
  'loading', true,
  'component', null,
  'componentModel', null
);

const init = (component, model) => hashMap(
  'loading', true,
  'component', component,
  'componentModel', model
);

function SubAction(component, a) {
  return component.Action === a;
}
export const Action = Type({
  Wait: [],
  Done: [Object, SubAction]
});

export const update = (model, action) => {
  const component = get(model, 'component');
  const componentModel = get(model, 'componentModel');
  return Action.case({
    Wait: () => model,
    Done: (component, subaction) => hashMap(
      'loading', false,
      'component', component,
      'componentModel', component.update(componentModel, subaction)
    )
  }, action);
};

export const view = (model, event) => {
  const loading = get(model, 'loading');
  const component = get(model, 'component');
  const componentModel = get(model, 'component');

  const waiter = h('div', [
    'LOADING'
  ]);

  return h('div', [
    loading ? waiter : component.view(
      componentModel,
      // event
    )
  ]);
};
