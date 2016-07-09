const mori = require('mori');
const flyd = require('flyd');
const { stream } = flyd;
const snabbdom = require('snabbdom');
const patch = snabbdom.init([
  require('snabbdom/modules/class'),
  require('snabbdom/modules/props'),
  require('snabbdom/modules/style'),
  require('snabbdom/modules/attributes'),
  require('snabbdom/modules/eventlisteners')
]);

/// Runs an Elm architecture based application
export function start(root, model, {view, update}) {
  // this is the stream which acts as the run loop, which enables
  // updates to be triggered arbitrarily
  const state$ = stream(model);

  // this is the event handler which allows the view to trigger
  // an update. It expects an object of type Action, defined above
  // using the `union-type` library.
  const handleEvent = function (action) {
    const currentState = state$();
    state$(update(currentState, action));
  };

  // the initial vnode, which is created by patching the root node
  // with the result of calling the view function with the initial state and
  // the event handler.
  let vnode = null;

  // maps over the state stream, and patches the vdom
  // with the result of calling the view function with
  // the current state and the event handler.
  let history = mori.vector();
  flyd.map(v => {
    history = mori.conj(history, v);
    if (vnode === null) {
      vnode = patch(root, view(v, handleEvent));
    } else {
      vnode = patch(vnode, view(v, handleEvent));
    }

    return vnode;
  }, state$);

  return state$;
};
