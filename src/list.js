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
  updateIn,
  nth,
  toClj,
  toJs
} = mori;

const {simple, rawSVG} = require('./throbber');

const { apiUrl } = require('./config');

const parse = json => JSON.parse(json);

const assocMany = (coll, pairs) => {
  return pairs.reduce((acc, next) => {
    return assoc(acc, ...next);
  }, coll);
};

export const model = hashMap(
  'fetch', false,
  'loading', false,
  'data', [],
  'page', 1,
  'pageSize', 20
);

export const init = () => model;
export const initAndFetch = () => assocMany(model, [
  [ 'fetch', true ],
]);

export const Action = Type({
  InitGet: [],
  Get: [],
  NextPage: [],
  PrevPage: []
});

export const update = (model, action, event) => {
  return Action.case({
    InitGet: () => {
      return assocMany(model, [
        [ 'fetch', false ],
        [ 'loading', true ],
      ]);
    },
    Get: () => request('GET', `${apiUrl}/data`).getBody()
      .then(d => {
        const res = parse(d);
        const words = res.split('\n');
        return assocMany(model, [
          ['loading', false],
          ['data', words]
        ]);
      }),
    NextPage: () => updateIn(model, [ 'page' ], mori.inc),
    PrevPage: () => updateIn(model, [ 'page' ], mori.dec)
  }, action);
};

export const view = (model, event) => {
  if (get(model, 'fetch')) {
    event(Action.InitGet());
    event(Action.Get());
  }

  const {
    loading,
    data,
    page,
    pageSize
  } = toJs(model || init());

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
