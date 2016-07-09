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
  window.s = start(root, list.init(), list);

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
