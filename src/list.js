const request = require('then-request');
const h = require('snabbdom/h');
const Type = require('union-type');
const flyd = require('flyd');
const { stream } = flyd;
const mori = require('mori-fluent')(require('mori'));
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

const {simple, rawSVG} = require('./throbber');

const { apiUrl } = require('./config');

const parse = json => JSON.parse(json);

export const model = hashMap(
  'loading', false,
  'data', [],
  'page', 1,
  'pageSize', 20
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
    NextPage: () => updateIn(model, [ 'page' ], mori.inc),
    PrevPage: () => updateIn(model, [ 'page' ], mori.dec)
  }, action);
};

export const view = (model, event) => {
  const {
    loading,
    data,
    page,
    pageSize
  } = model.toJs();

  const pg = data.slice((page - 1) * pageSize, page * pageSize);

  return h('div', [
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
        props: { type: 'button', disabled: page === 1 },
        on: {
          click: e => event(Action.PrevPage())
        }
      }, 'Prev page'),
      h('span', {style: {fontWeight: 'bold', margin: '1rem 2rem'}}, page),
      h('button', {
        props: { type: 'button', disabled: page * pageSize >= data.length },
        on: {
          click: e => event(Action.NextPage())
        }
      }, 'Next page'),
    ]),
    h('div', toJs(map(t => h('div', t), pg)))
  ]);
};
