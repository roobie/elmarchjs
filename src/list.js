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

const {simple, rawSVG} = require('./throbber');

const { apiUrl } = require('./config');

const parse = json => JSON.parse(json);

export const model = hashMap(
  'loading', true,
  'data', [],
  'page', 1,
  'pageSize', 20
);

//export const init = () => update(model, Action.Get());
export const init = () => model;

export const Action = Type({
  Get: [],
  NextPage: [],
  PrevPage: [],
});

export const update = (model, action) => {
  return Action.case({
    Get: () => request('GET', `${apiUrl}/data`).getBody()
      .then(d => {
        const res = parse(d);
        const words = res.split('\n');
        let newModel = assoc(assoc(model, 'loading', false), 'data', words);
        return newModel;
      }),
    NextPage: () => assoc(model, 'page', get(model, 'page') + 1),
    PrevPage: () => assoc(model, 'page', get(model, 'page') - 1),
  }, action);
};

export const view = (model, event) => {
  if (get(model, 'loading')) {
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
    : h('div', {style: {background: '#aaa'}}, [
      h('button', {
        props: { type: 'button', disabled: page === 1 },
        on: {
          click: e => event(Action.PrevPage())
        }
      }, 'Prev page'),
      page,
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
