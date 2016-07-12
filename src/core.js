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
// in order to simplify hot code replacement, the
// component parameter here is a reference to an object
// that has the two following properties: `update` and `view`
// this allows the consumer of this function to replace
// these function at will, and then call the `render` function
// which is a property on the object that is returned by `start`
export function start(root, model, component) {
  // this is the stream which acts as the run loop, which enables
  // updates to be triggered arbitrarily
  const state$ = stream(model);

  // this is the event handler which allows the view to trigger
  // an update. It expects an object of type Action, defined above
  // using the `union-type` library.
  const handleEvent = function (action) {
    const currentState = state$();
    state$(component.update(currentState, action, handleEvent));
  };

  // the initial vnode, which is not a virtual node, at first, but will be
  // after the first pass, where this binding will be rebinded to a virtual node.
  // I.e. the result of calling the view function with the initial state and
  // the event handler.
  let vnode = root;

  // maps over the state stream, and patches the vdom
  // with the result of calling the view function with
  // the current state and the event handler.
  let history = mori.vector();

  const render = (state) => {
    vnode = patch(vnode, component.view(state, handleEvent));
  };

  // the actual asynchronous run loop, which simply is a mapping over the
  // state stream.
  flyd.map(v => {
    history = mori.conj(history, v);
    render(v);
    return vnode;
  }, state$);

  // return the state stream, so that the consumer of this API may
  // expose the state stream to others, in order for them to interact
  // with the active component.
  return {
    state$,
    render
  };
};
