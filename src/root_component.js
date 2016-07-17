//const app = require('./list2');
const app = require('./outlist');

//export const init = app.initAndFetch;
export const init = app.init;
export const update = app.update;
export const view = app.view;
export const Action = app.Action;

(() => {
  const Type = require('union-type');
  const mori = require('mori-fluent')(require('mori'));
  const {vector, hashMap} = mori;

  const isComponent = val => val && typeof val.init === 'function';

  const model = hashMap();
  const init = () => model;
  const Action = Type({
    AddComponent: [isComponent, String]
  });
  const update = (model, action) => {
    return Action.case({
      AddComponent: (component, name) => {
        return model.assoc(name, component);
      }
    }, action);
  };
  const view = (model, event) => {
    return null;
  };
});
