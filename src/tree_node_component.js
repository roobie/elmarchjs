const request = require('then-request');
const h = require('snabbdom/h');
const Type = require('union-type');
const mori = require('mori-fluent')(require('mori'), require('mori-fluent/extra'));
const {
  vector,
  hashMap,
  isVector,
  isMap,
  toClj
} = mori;
const R = require('ramda');

const {
  provided,
  is
} = require('./viewutils');

export const model = hashMap(
  ':name', 'LIST',
  ':expanded', true,
  ':hovering', false,
  ':nodes', vector(),
  ':field', null
);

export const init = (props) => !props ? model : model.assoc(...props || []);

export const Action = Type({
  ToggleExpanded: [isVector],
  SetHover: [isVector, Boolean],
  AddChild: [isVector, isMap, isMap],
  RemoveThis: [isVector],
  UpdateName: [String],
  AddField: [isVector],
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
    },
    RemoveThis: function remThis(path) {
      return confirm('sure you want to delete this?')
        ? model.dissocIn(path)
        : model;
    },
    UpdateName: (name) => model.assoc(':name', name),
    AddField: (path) => model.assocIn(
      path.conj(':field').intoArray(), hashMap(':value', 'TEST')),
  }, action);
};

export const view = (model, event, path=vector()) => {
  return h('div.list', {
    class: {
      'hover-active': model.get(':hovering')
    },
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

      h('span', {
        props: {
          title: model.get(':name')
        }
      }, '⋮'),

      h('button', {
        class: {
          hide: model.get(':nodes').isEmpty(),
          mono: true
        },
        props: {
          type: 'button'
        },
        on: {
          click: e => event(Action.ToggleExpanded(path))
        }
      }, model.get(':expanded')
        ? '[-]'
        : '[+]'),

      h('input', {
        props: {
          type: 'text',
          value: model.get(':name')
        },
        on: {
          input: e => event(Action.UpdateName(e.target.value))
        }
      }),

      h('button', {
        class: {
        },
        props: {
          type: 'button'
        },
        on: {
          click: e => event(Action.AddField(path))
        }
      }, 'add field'),

      h('button', {
        class: {
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

      path.isEmpty() ?
        h('span')
      : h('button', {
        props: {
          type: 'button',
          innerHTML: '&times;'
        },
        on: {
          click: e => event(Action.RemoveThis(path))
        }
      }),
    ]),

    h('div', [
      model.get(':field') ?
        h('textarea', {
          props: {
            value: model.getIn([':field', ':value'])
          }
        })
      : h('span')
    ]),

    h('div', is(model.get(':expanded'), {
      yes: () => model.get(':nodes').mapKV(
        (i, node) => {
          const subTreePath = path.into(vector(':nodes', i));
          return view(node, event, subTreePath);
        }, vector()).intoArray(),
      no: () => [h('span', '…')]
    }))
  ]);
};
