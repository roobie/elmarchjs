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

const fulfillsEffectProtocol = q => q && q.constructor == Array && q.length === 2;
const isEffectOf = (A, a) => A.prototype.isPrototypeOf(a);

// runs an elm arch based application, and also handles
// side/effects. It does so by allowing the update function to
// return an array which looks like this:
// [ effect, model ]
// where the effect is an instance of an action from the component.
// which will asynchronously trigger a recursive call to the
// event handler.
export function application(root, init, component) {
  const state$ = stream();

  const handleResult = function (result) {
    if (fulfillsEffectProtocol(result) && isEffectOf(component.Action, result[0])) {
      const [effect, model] = result;
      requestAnimationFrame(() => handleEvent(effect));
      state$(model);
    } else {
      // result is the model
      state$(result);
    }
  };

  const handleEvent = function (action) {
    const currentState = state$();
    const result = component.update(currentState, action);
    handleResult(result);
  };

  let vnode = root;

  let history = mori.vector();

  const handleSubResult = function (path, rootModel, subComponent, result) {
    if (fulfillsEffectProtocol(result) && isEffectOf(subComponent.Action, result[0])) {
      const [effect, model] = result;
      requestAnimationFrame(() => handleSubEvent(path, subComponent, effect));
      state$(rootModel.assocIn(path, model));
    } else {
      // result is the model
      state$(rootModel.assocIn(path, result));
    }
  };

  const handleSubEvent = function (path, subComponent, action) {
    const currentState = state$();
    const result = subComponent.update(currentState.getIn(path), action);
    handleSubResult(path, currentState, subComponent, result);
  };
  const subComponents = Object.create(null);
  const subComponentEventHandler = function (...path) {
    return function (subComponent) {
      return handleSubEvent.bind(null, [...path], subComponent);
    };
  };

  const render = (state) => {
    vnode = patch(vnode, component.view(state, handleEvent, subComponentEventHandler));
  };

  flyd.map(state => {
    history = mori.conj(history, state);
    render(state);
    return vnode;
  }, state$);

  handleResult(init());

  const historyNavigation$ = stream();
  flyd.map(nav => {
    // ...
    var lastState = history.peek();
    history = history.pop();
    render(lastState);
  }, historyNavigation$);
  window.H = historyNavigation$;

  return {
    state$,
    render,

    historyNavigation$
  };
};
