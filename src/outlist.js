require('./outlist.less');
const request = require('then-request');
const h = require('snabbdom/h');
const Type = require('union-type');
const mori = require('mori-fluent')(require('mori'), require('mori-fluent/extra'), {
  dissocIn: function (path) {
    const vec = vector();
    const basePath = path.pop();
    return this
      .assocIn(path, null)
      .updateIn(basePath, v => vec.into(v.filter(i => i !== null)));
  }
});
const {
  vector,
  hashMap,
} = mori;
const R = require('ramda');
const {
  is
} = require('./viewutils');

const { apiUrl } = require('./config');

const TreeNodeComponent = require('./tree_node_component');

export const model = hashMap(
  ':title', 'outlist',
  ':email', 'br@mailinator.com',
  ':loading', false,
  ':tree', TreeNodeComponent.model
);

export const init = (props) => !props ? model : model.assoc(...props || []);

export const Action = Type({
  TreeAction: [R.T],
  SetEmail: [String],
  InitLogin: [String],
  Login: [String],
  InitSave: [],
  Save: [],
});

const subActionHandler = (component, model, key) =>
        (action) => model.assoc(key, component.update(model.get(key), action));

export const update = (model, action) => {
  return Action.case({
    TreeAction: subActionHandler(TreeNodeComponent, model, ':tree'),

    SetEmail: (email) => model.assoc(':email', email),

    Login: (email) => request('POST', `${apiUrl}/login`, {
      json: {user: email}
    }).getBody()
      .then(res => model.assoc(
        ':token', res,
        ':message', 'logged in'
      ))
      .then(newmodel => {
        //return newmodel;
        return request('GET', `${apiUrl}/data`, {
          headers: {
            Authentication: newmodel.get(':token')
          }
        }).getBody()
          .then(res => {
            const data = JSON.parse(res);
            return newmodel.assoc(
              ':tree', mori.toClj(data),
              //':tree', TreeNodeComponent.init(),
              ':loading', false
            );
          });
      }),

    InitLogin: (email) => [
      Action.Login(email),
      model.assoc(':loading', true)
    ],

    InitSave: () => [
      Action.Save(),
      model.assoc(':loading', true)
    ],

    Save: () => request('PUT', `${apiUrl}/data`, {
      headers: {
        Authentication: model.get(':token')
      },
      json: model.get(':tree').toJs()
    }).getBody().then(res => {
      return model.assoc(
        ':loading', false,
        ':message', 'saved'
      );
    }),

  }, action);
};

const loggedIn = model => !!model.get(':token');

export const view = (model, event) => {
  return h('div.outlist', [
    h('header', [
      h('pre', JSON.stringify(mori.dissoc(model, ':tree').toJs(), null, 2)),
      h('div', model.get(':message')),
      h('h4', model.get(':title')),

      is(loggedIn(model), {
        yes: () => h('div', [
          h('button', {
            props: {
              type: 'button'
            },
            on: {
              click: e => event(Action.InitSave())
            }
          }, 'save')
        ]),
        no: () => h('div', [
          h('input', {
            props: {
              type: 'text',
              value: model.get(':email')
            },
            on: {
              input: e => event(Action.SetEmail(e.target.value))
            }
          }),
          h('button', {
            props: {
              type: 'button'
            },
            on: {
              click: e => event(Action.InitLogin(model.get(':email')))
            }
          }, 'log in'),
        ])
      }),
    ]),

    h('div.col.left', {
      class: {
        hide: !loggedIn(model)
      }
    }, [
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
