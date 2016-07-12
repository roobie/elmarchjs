'use strict';

const mori = require('mori-fluent')(require('mori'), require('mori-fluent/extra'));
const { start } = require('./core');

// the wrapper root component, which is used to facilitate
// keeping this module somewhat agnostic to changes in the
// underlying components, which helps to keep the logic
// regarding hot code simple.
const RootComponent = require('./root_component');

function init() {
  // this is the element in which our component is rendered
  const root = document.querySelector('#root');

  // start returns an object that contains the state stream
  // and a render function, which in turn accepts a model
  const {
    state$,
    render
  } = start(root, RootComponent.init(), RootComponent);


  // If hot module replacement is enabled
  if (module.hot) {
    // We accept updates to the top component
    module.hot.accept('./root_component', (comp) => {
      // Reload the component
      const component = require('./root_component');
      // Mutate the variable holding our component with the new code
      Object.assign(RootComponent, component);
      // Render view in the case that any view functions has changed
      render(state$());
    });
  }

  // expose the state stream to window, which allows for debugging,
  // e.g. window.state$(<model>) would trigger a render with the new data.
  window.state$ = state$;

  // since the state is a mori data structure, also expose mori
  window.mori = mori;
}

/// BOOTSTRAPPING
const readyStates = {interactive:1, complete:1};
if (document.readyState in readyStates) {
  init();
} else {
  document.addEventListener('DOMContentLoaded', init);
}
