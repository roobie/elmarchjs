'use strict';

const mori = require('mori');
const { start } = require('./core');
const colorsComponent = require('./colors');
const list = require('./list');

function init() {
  // this is the element in which our component is rendered
  const root = document.querySelector('#root');

  // expose the state stream to window, which allows for debugging
  //window.s = start(root, colorsComponent.init(), colorsComponent);
  //window.s = start(root, list.initAndFetch(), list, './list');
  const {
    state$,
    render
  } = start(root, list.initAndFetch(), list);



  // If hot module replacement is enabled
  if (module.hot) {
    // We accept updates to the top component
    module.hot.accept('./list.js', (comp) => {
      // Mutate the variable holding our component
      const component = require('./list.js');
      Object.assign(list, component);
      // Render view in the case that any view functions has changed
      render(state$());
    });
  }


  // since the state is a mori data structure, also expose mori
  window.mori = mori;
}

/// BOOTSTRAP
const readyStates = {interactive:1, complete:1};
if (document.readyState in readyStates) {
  init();
} else {
  document.addEventListener('DOMContentLoaded', init);
}
