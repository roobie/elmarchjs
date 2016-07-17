const request = require('then-request');
const h = require('snabbdom/h');
const Type = require('union-type');
const flyd = require('flyd');
const { stream } = flyd;
const mori = require('mori-fluent')(require('mori'));
const {
  vector,
  hashMap,
} = mori;

const subComponent = (function () {
  const submodel = 1;
  const subinit = function () {
    return submodel;
  };
  const Subaction = Type({
    Inc: []
  });

  function subupdate(model, action) {
    return Subaction.case({
      Inc: () => model + 1
    }, action);
  };
  const subview = function (model, event, subEvent) {
    return h('div', {
      on: {
        click: e => event(Subaction.Inc())
      }
    }, model);
  };
  return {
    submodel,
    init: subinit,
    Action: Subaction,
    update: subupdate,
    view: subview
  };
})();

const {simple, rawSVG} = require('./throbber');

const { apiUrl } = require('./config');

const parse = json => JSON.parse(json);

export const model = hashMap(
  'loading', false,
  'data', [],
  'page', 1,
  'pageSize', 20,
  'subData', subComponent.init()
);

// init func with side effect.
export const init = (...props) => [
  Action.InitGet(),
  model.assoc(...props || [])
];

export const Action = Type({
  InitGet: [],
  Get: [],
  NextPage: [],
  PrevPage: []
});

export const update = (model, action) => {
  return Action.case({
    InitGet: () => {
      return [
        Action.Get(),
        model.assoc(
          'loading', true
        )
      ];
    },
    Get: () => request('GET', `${apiUrl}/data`).getBody()
      .then(d => {
        const res = parse(d);
        const words = res.split('\n');
        return model.assoc(
          'loading', false,
          'data', words
        );
      }),
    NextPage: () => model.updateIn(['page'], mori.inc),
    PrevPage: () => model.updateIn(['page'], mori.dec)
  }, action);
};

export const view = (model, event, subEvent) => {
  const {
    loading,
    data,
    page,
    pageSize
  } = model.toJs();

  const pg = data.slice((page - 1) * pageSize, page * pageSize);

  return h('div', [

    subComponent.view(
      model.getIn([ 'subData' ]),
      subEvent('subData')(subComponent),
      subEvent.bind(null, 'subData')),

    loading ?
      h('div.throbber', {
        style: {
          background: '#ddd',
          display: 'flex',
          height: '100%',
          alignItems: 'center',
          justifyContent: 'center'
        }
      }, [
        h('span', {
          props: {
            innerHTML: rawSVG(100)
          }
        })
      ])
    : h('div', {style: {color: '#eee', background: '#666'}}, [
      h('button', {
        props: {
          innerHTML: '&laquo;',
          type: 'button',
          disabled: page === 1
        },
        on: {
          click: e => event(Action.PrevPage())
        }
      }),
      h('span', {style: {fontWeight: 'bold', margin: '1rem 2rem'}}, page),
      h('button', {
        props: {
          innerHTML: '&raquo;',
          type: 'button',
          disabled: page * pageSize >= data.length
        },
        on: {
          click: e => event(Action.NextPage())
        }
      }),
    ]),
    h('div', pg.map(t => h('div', t)))
  ]);
};
