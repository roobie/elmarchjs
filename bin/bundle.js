(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
"use strict";

// rawAsap provides everything we need except exception management.
var rawAsap = require("./raw");
// RawTasks are recycled to reduce GC churn.
var freeTasks = [];
// We queue errors to ensure they are thrown in right order (FIFO).
// Array-as-queue is good enough here, since we are just dealing with exceptions.
var pendingErrors = [];
var requestErrorThrow = rawAsap.makeRequestCallFromTimer(throwFirstError);

function throwFirstError() {
    if (pendingErrors.length) {
        throw pendingErrors.shift();
    }
}

/**
 * Calls a task as soon as possible after returning, in its own event, with priority
 * over other events like animation, reflow, and repaint. An error thrown from an
 * event will not interrupt, nor even substantially slow down the processing of
 * other events, but will be rather postponed to a lower priority event.
 * @param {{call}} task A callable object, typically a function that takes no
 * arguments.
 */
module.exports = asap;
function asap(task) {
    var rawTask;
    if (freeTasks.length) {
        rawTask = freeTasks.pop();
    } else {
        rawTask = new RawTask();
    }
    rawTask.task = task;
    rawAsap(rawTask);
}

// We wrap tasks with recyclable task objects.  A task object implements
// `call`, just like a function.
function RawTask() {
    this.task = null;
}

// The sole purpose of wrapping the task is to catch the exception and recycle
// the task object after its single use.
RawTask.prototype.call = function () {
    try {
        this.task.call();
    } catch (error) {
        if (asap.onerror) {
            // This hook exists purely for testing purposes.
            // Its name will be periodically randomized to break any code that
            // depends on its existence.
            asap.onerror(error);
        } else {
            // In a web browser, exceptions are not fatal. However, to avoid
            // slowing down the queue of pending tasks, we rethrow the error in a
            // lower priority turn.
            pendingErrors.push(error);
            requestErrorThrow();
        }
    } finally {
        this.task = null;
        freeTasks[freeTasks.length] = this;
    }
};

},{"./raw":2}],2:[function(require,module,exports){
(function (global){
"use strict";

// Use the fastest means possible to execute a task in its own turn, with
// priority over other events including IO, animation, reflow, and redraw
// events in browsers.
//
// An exception thrown by a task will permanently interrupt the processing of
// subsequent tasks. The higher level `asap` function ensures that if an
// exception is thrown by a task, that the task queue will continue flushing as
// soon as possible, but if you use `rawAsap` directly, you are responsible to
// either ensure that no exceptions are thrown from your task, or to manually
// call `rawAsap.requestFlush` if an exception is thrown.
module.exports = rawAsap;
function rawAsap(task) {
    if (!queue.length) {
        requestFlush();
        flushing = true;
    }
    // Equivalent to push, but avoids a function call.
    queue[queue.length] = task;
}

var queue = [];
// Once a flush has been requested, no further calls to `requestFlush` are
// necessary until the next `flush` completes.
var flushing = false;
// `requestFlush` is an implementation-specific method that attempts to kick
// off a `flush` event as quickly as possible. `flush` will attempt to exhaust
// the event queue before yielding to the browser's own event loop.
var requestFlush;
// The position of the next task to execute in the task queue. This is
// preserved between calls to `flush` so that it can be resumed if
// a task throws an exception.
var index = 0;
// If a task schedules additional tasks recursively, the task queue can grow
// unbounded. To prevent memory exhaustion, the task queue will periodically
// truncate already-completed tasks.
var capacity = 1024;

// The flush function processes all tasks that have been scheduled with
// `rawAsap` unless and until one of those tasks throws an exception.
// If a task throws an exception, `flush` ensures that its state will remain
// consistent and will resume where it left off when called again.
// However, `flush` does not make any arrangements to be called again if an
// exception is thrown.
function flush() {
    while (index < queue.length) {
        var currentIndex = index;
        // Advance the index before calling the task. This ensures that we will
        // begin flushing on the next task the task throws an error.
        index = index + 1;
        queue[currentIndex].call();
        // Prevent leaking memory for long chains of recursive calls to `asap`.
        // If we call `asap` within tasks scheduled by `asap`, the queue will
        // grow, but to avoid an O(n) walk for every task we execute, we don't
        // shift tasks off the queue after they have been executed.
        // Instead, we periodically shift 1024 tasks off the queue.
        if (index > capacity) {
            // Manually shift all values starting at the index back to the
            // beginning of the queue.
            for (var scan = 0, newLength = queue.length - index; scan < newLength; scan++) {
                queue[scan] = queue[scan + index];
            }
            queue.length -= index;
            index = 0;
        }
    }
    queue.length = 0;
    index = 0;
    flushing = false;
}

// `requestFlush` is implemented using a strategy based on data collected from
// every available SauceLabs Selenium web driver worker at time of writing.
// https://docs.google.com/spreadsheets/d/1mG-5UYGup5qxGdEMWkhP6BWCz053NUb2E1QoUTU16uA/edit#gid=783724593

// Safari 6 and 6.1 for desktop, iPad, and iPhone are the only browsers that
// have WebKitMutationObserver but not un-prefixed MutationObserver.
// Must use `global` instead of `window` to work in both frames and web
// workers. `global` is a provision of Browserify, Mr, Mrs, or Mop.
var BrowserMutationObserver = global.MutationObserver || global.WebKitMutationObserver;

// MutationObservers are desirable because they have high priority and work
// reliably everywhere they are implemented.
// They are implemented in all modern browsers.
//
// - Android 4-4.3
// - Chrome 26-34
// - Firefox 14-29
// - Internet Explorer 11
// - iPad Safari 6-7.1
// - iPhone Safari 7-7.1
// - Safari 6-7
if (typeof BrowserMutationObserver === "function") {
    requestFlush = makeRequestCallFromMutationObserver(flush);

// MessageChannels are desirable because they give direct access to the HTML
// task queue, are implemented in Internet Explorer 10, Safari 5.0-1, and Opera
// 11-12, and in web workers in many engines.
// Although message channels yield to any queued rendering and IO tasks, they
// would be better than imposing the 4ms delay of timers.
// However, they do not work reliably in Internet Explorer or Safari.

// Internet Explorer 10 is the only browser that has setImmediate but does
// not have MutationObservers.
// Although setImmediate yields to the browser's renderer, it would be
// preferrable to falling back to setTimeout since it does not have
// the minimum 4ms penalty.
// Unfortunately there appears to be a bug in Internet Explorer 10 Mobile (and
// Desktop to a lesser extent) that renders both setImmediate and
// MessageChannel useless for the purposes of ASAP.
// https://github.com/kriskowal/q/issues/396

// Timers are implemented universally.
// We fall back to timers in workers in most engines, and in foreground
// contexts in the following browsers.
// However, note that even this simple case requires nuances to operate in a
// broad spectrum of browsers.
//
// - Firefox 3-13
// - Internet Explorer 6-9
// - iPad Safari 4.3
// - Lynx 2.8.7
} else {
    requestFlush = makeRequestCallFromTimer(flush);
}

// `requestFlush` requests that the high priority event queue be flushed as
// soon as possible.
// This is useful to prevent an error thrown in a task from stalling the event
// queue if the exception handled by Node.js’s
// `process.on("uncaughtException")` or by a domain.
rawAsap.requestFlush = requestFlush;

// To request a high priority event, we induce a mutation observer by toggling
// the text of a text node between "1" and "-1".
function makeRequestCallFromMutationObserver(callback) {
    var toggle = 1;
    var observer = new BrowserMutationObserver(callback);
    var node = document.createTextNode("");
    observer.observe(node, {characterData: true});
    return function requestCall() {
        toggle = -toggle;
        node.data = toggle;
    };
}

// The message channel technique was discovered by Malte Ubl and was the
// original foundation for this library.
// http://www.nonblocking.io/2011/06/windownexttick.html

// Safari 6.0.5 (at least) intermittently fails to create message ports on a
// page's first load. Thankfully, this version of Safari supports
// MutationObservers, so we don't need to fall back in that case.

// function makeRequestCallFromMessageChannel(callback) {
//     var channel = new MessageChannel();
//     channel.port1.onmessage = callback;
//     return function requestCall() {
//         channel.port2.postMessage(0);
//     };
// }

// For reasons explained above, we are also unable to use `setImmediate`
// under any circumstances.
// Even if we were, there is another bug in Internet Explorer 10.
// It is not sufficient to assign `setImmediate` to `requestFlush` because
// `setImmediate` must be called *by name* and therefore must be wrapped in a
// closure.
// Never forget.

// function makeRequestCallFromSetImmediate(callback) {
//     return function requestCall() {
//         setImmediate(callback);
//     };
// }

// Safari 6.0 has a problem where timers will get lost while the user is
// scrolling. This problem does not impact ASAP because Safari 6.0 supports
// mutation observers, so that implementation is used instead.
// However, if we ever elect to use timers in Safari, the prevalent work-around
// is to add a scroll event listener that calls for a flush.

// `setTimeout` does not call the passed callback if the delay is less than
// approximately 7 in web workers in Firefox 8 through 18, and sometimes not
// even then.

function makeRequestCallFromTimer(callback) {
    return function requestCall() {
        // We dispatch a timeout with a specified delay of 0 for engines that
        // can reliably accommodate that request. This will usually be snapped
        // to a 4 milisecond delay, but once we're flushing, there's no delay
        // between events.
        var timeoutHandle = setTimeout(handleTimer, 0);
        // However, since this timer gets frequently dropped in Firefox
        // workers, we enlist an interval handle that will try to fire
        // an event 20 times per second until it succeeds.
        var intervalHandle = setInterval(handleTimer, 50);

        function handleTimer() {
            // Whichever timer succeeds will cancel both timers and
            // execute the callback.
            clearTimeout(timeoutHandle);
            clearInterval(intervalHandle);
            callback();
        }
    };
}

// This is for `asap.js` only.
// Its name will be periodically randomized to break any code that depends on
// its existence.
rawAsap.makeRequestCallFromTimer = makeRequestCallFromTimer;

// ASAP was originally a nextTick shim included in Q. This was factored out
// into this ASAP package. It was later adapted to RSVP which made further
// amendments. These decisions, particularly to marginalize MessageChannel and
// to capture the MutationObserver implementation in a closure, were integrated
// back into ASAP proper.
// https://github.com/tildeio/rsvp.js/blob/cddf7232546a9cf858524b75cde6f9edf72620a7/lib/rsvp/asap.js

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{}],3:[function(require,module,exports){
'use strict';

var curryN = require('ramda/src/curryN');

// Utility
function isFunction(obj) {
  return !!(obj && obj.constructor && obj.call && obj.apply);
}
function trueFn() { return true; }

// Globals
var toUpdate = [];
var inStream;
var order = [];
var orderNextIdx = -1;
var flushing = false;

/** @namespace */
var flyd = {}

// /////////////////////////// API ///////////////////////////////// //

/**
 * Creates a new stream
 *
 * __Signature__: `a -> Stream a`
 *
 * @name flyd.stream
 * @param {*} initialValue - (Optional) the initial value of the stream
 * @return {stream} the stream
 *
 * @example
 * var n = flyd.stream(1); // Stream with initial value `1`
 * var s = flyd.stream(); // Stream with no initial value
 */
flyd.stream = function(initialValue) {
  var endStream = createDependentStream([], trueFn);
  var s = createStream();
  s.end = endStream;
  s.fnArgs = [];
  endStream.listeners.push(s);
  if (arguments.length > 0) s(initialValue);
  return s;
}

/**
 * Create a new dependent stream
 *
 * __Signature__: `(...Stream * -> Stream b -> b) -> [Stream *] -> Stream b`
 *
 * @name flyd.combine
 * @param {Function} fn - the function used to combine the streams
 * @param {Array<stream>} dependencies - the streams that this one depends on
 * @return {stream} the dependent stream
 *
 * @example
 * var n1 = flyd.stream(0);
 * var n2 = flyd.stream(0);
 * var max = flyd.combine(function(n1, n2, self, changed) {
 *   return n1() > n2() ? n1() : n2();
 * }, [n1, n2]);
 */
flyd.combine = curryN(2, combine);
function combine(fn, streams) {
  var i, s, deps, depEndStreams;
  var endStream = createDependentStream([], trueFn);
  deps = []; depEndStreams = [];
  for (i = 0; i < streams.length; ++i) {
    if (streams[i] !== undefined) {
      deps.push(streams[i]);
      if (streams[i].end !== undefined) depEndStreams.push(streams[i].end);
    }
  }
  s = createDependentStream(deps, fn);
  s.depsChanged = [];
  s.fnArgs = s.deps.concat([s, s.depsChanged]);
  s.end = endStream;
  endStream.listeners.push(s);
  addListeners(depEndStreams, endStream);
  endStream.deps = depEndStreams;
  updateStream(s);
  return s;
}

/**
 * Returns `true` if the supplied argument is a Flyd stream and `false` otherwise.
 *
 * __Signature__: `* -> Boolean`
 *
 * @name flyd.isStream
 * @param {*} value - the value to test
 * @return {Boolean} `true` if is a Flyd streamn, `false` otherwise
 *
 * @example
 * var s = flyd.stream(1);
 * var n = 1;
 * flyd.isStream(s); //=> true
 * flyd.isStream(n); //=> false
 */
flyd.isStream = function(stream) {
  return isFunction(stream) && 'hasVal' in stream;
}

/**
 * Invokes the body (the function to calculate the value) of a dependent stream
 *
 * By default the body of a dependent stream is only called when all the streams
 * upon which it depends has a value. `immediate` can circumvent this behaviour.
 * It immediately invokes the body of a dependent stream.
 *
 * __Signature__: `Stream a -> Stream a`
 *
 * @name flyd.immediate
 * @param {stream} stream - the dependent stream
 * @return {stream} the same stream
 *
 * @example
 * var s = flyd.stream();
 * var hasItems = flyd.immediate(flyd.combine(function(s) {
 *   return s() !== undefined && s().length > 0;
 * }, [s]);
 * console.log(hasItems()); // logs `false`. Had `immediate` not been
 *                          // used `hasItems()` would've returned `undefined`
 * s([1]);
 * console.log(hasItems()); // logs `true`.
 * s([]);
 * console.log(hasItems()); // logs `false`.
 */
flyd.immediate = function(s) {
  if (s.depsMet === false) {
    s.depsMet = true;
    updateStream(s);
  }
  return s;
}

/**
 * Changes which `endsStream` should trigger the ending of `s`.
 *
 * __Signature__: `Stream a -> Stream b -> Stream b`
 *
 * @name flyd.endsOn
 * @param {stream} endStream - the stream to trigger the ending
 * @param {stream} stream - the stream to be ended by the endStream
 * @param {stream} the stream modified to be ended by endStream
 *
 * @example
 * var n = flyd.stream(1);
 * var killer = flyd.stream();
 * // `double` ends when `n` ends or when `killer` emits any value
 * var double = flyd.endsOn(flyd.merge(n.end, killer), flyd.combine(function(n) {
 *   return 2 * n();
 * }, [n]);
*/
flyd.endsOn = function(endS, s) {
  detachDeps(s.end);
  endS.listeners.push(s.end);
  s.end.deps.push(endS);
  return s;
}

/**
 * Map a stream
 *
 * Returns a new stream consisting of every value from `s` passed through
 * `fn`. I.e. `map` creates a new stream that listens to `s` and
 * applies `fn` to every new value.
 * __Signature__: `(a -> result) -> Stream a -> Stream result`
 *
 * @name flyd.map
 * @param {Function} fn - the function that produces the elements of the new stream
 * @param {stream} stream - the stream to map
 * @return {stream} a new stream with the mapped values
 *
 * @example
 * var numbers = flyd.stream(0);
 * var squaredNumbers = flyd.map(function(n) { return n*n; }, numbers);
 */
// Library functions use self callback to accept (null, undefined) update triggers.
flyd.map = curryN(2, function(f, s) {
  return combine(function(s, self) { self(f(s.val)); }, [s]);
})

/**
 * Listen to stream events
 *
 * Similar to `map` except that the returned stream is empty. Use `on` for doing
 * side effects in reaction to stream changes. Use the returned stream only if you
 * need to manually end it.
 *
 * __Signature__: `(a -> result) -> Stream a -> Stream undefined`
 *
 * @name flyd.on
 * @param {Function} cb - the callback
 * @param {stream} stream - the stream
 * @return {stream} an empty stream (can be ended)
 */
flyd.on = curryN(2, function(f, s) {
  return combine(function(s) { f(s.val); }, [s]);
})

/**
 * Creates a new stream with the results of calling the function on every incoming
 * stream with and accumulator and the incoming value.
 *
 * __Signature__: `(a -> b -> a) -> a -> Stream b -> Stream a`
 *
 * @name flyd.scan
 * @param {Function} fn - the function to call
 * @param {*} val - the initial value of the accumulator
 * @param {stream} stream - the stream source
 * @return {stream} the new stream
 *
 * @example
 * var numbers = flyd.stream();
 * var sum = flyd.scan(function(sum, n) { return sum+n; }, 0, numbers);
 * numbers(2)(3)(5);
 * sum(); // 10
 */
flyd.scan = curryN(3, function(f, acc, s) {
  var ns = combine(function(s, self) {
    self(acc = f(acc, s.val));
  }, [s]);
  if (!ns.hasVal) ns(acc);
  return ns;
});

/**
 * Creates a new stream down which all values from both `stream1` and `stream2`
 * will be sent.
 *
 * __Signature__: `Stream a -> Stream a -> Stream a`
 *
 * @name flyd.merge
 * @param {stream} source1 - one stream to be merged
 * @param {stream} source2 - the other stream to be merged
 * @return {stream} a stream with the values from both sources
 *
 * @example
 * var btn1Clicks = flyd.stream();
 * button1Elm.addEventListener(btn1Clicks);
 * var btn2Clicks = flyd.stream();
 * button2Elm.addEventListener(btn2Clicks);
 * var allClicks = flyd.merge(btn1Clicks, btn2Clicks);
 */
flyd.merge = curryN(2, function(s1, s2) {
  var s = flyd.immediate(combine(function(s1, s2, self, changed) {
    if (changed[0]) {
      self(changed[0]());
    } else if (s1.hasVal) {
      self(s1.val);
    } else if (s2.hasVal) {
      self(s2.val);
    }
  }, [s1, s2]));
  flyd.endsOn(combine(function() {
    return true;
  }, [s1.end, s2.end]), s);
  return s;
});

/**
 * Creates a new stream resulting from applying `transducer` to `stream`.
 *
 * __Signature__: `Transducer -> Stream a -> Stream b`
 *
 * @name flyd.transduce
 * @param {Transducer} xform - the transducer transformation
 * @param {stream} source - the stream source
 * @return {stream} the new stream
 *
 * @example
 * var t = require('transducers.js');
 *
 * var results = [];
 * var s1 = flyd.stream();
 * var tx = t.compose(t.map(function(x) { return x * 2; }), t.dedupe());
 * var s2 = flyd.transduce(tx, s1);
 * flyd.combine(function(s2) { results.push(s2()); }, [s2]);
 * s1(1)(1)(2)(3)(3)(3)(4);
 * results; // => [2, 4, 6, 8]
 */
flyd.transduce = curryN(2, function(xform, source) {
  xform = xform(new StreamTransformer());
  return combine(function(source, self) {
    var res = xform['@@transducer/step'](undefined, source.val);
    if (res && res['@@transducer/reduced'] === true) {
      self.end(true);
      return res['@@transducer/value'];
    } else {
      return res;
    }
  }, [source]);
});

/**
 * Returns `fn` curried to `n`. Use this function to curry functions exposed by
 * modules for Flyd.
 *
 * @name flyd.curryN
 * @function
 * @param {Integer} arity - the function arity
 * @param {Function} fn - the function to curry
 * @return {Function} the curried function
 *
 * @example
 * function add(x, y) { return x + y; };
 * var a = flyd.curryN(2, add);
 * a(2)(4) // => 6
 */
flyd.curryN = curryN

/**
 * Returns a new stream identical to the original except every
 * value will be passed through `f`.
 *
 * _Note:_ This function is included in order to support the fantasy land
 * specification.
 *
 * __Signature__: Called bound to `Stream a`: `(a -> b) -> Stream b`
 *
 * @name stream.map
 * @param {Function} function - the function to apply
 * @return {stream} a new stream with the values mapped
 *
 * @example
 * var numbers = flyd.stream(0);
 * var squaredNumbers = numbers.map(function(n) { return n*n; });
 */
function boundMap(f) { return flyd.map(f, this); }

/**
 * Returns a new stream which is the result of applying the
 * functions from `this` stream to the values in `stream` parameter.
 *
 * `this` stream must be a stream of functions.
 *
 * _Note:_ This function is included in order to support the fantasy land
 * specification.
 *
 * __Signature__: Called bound to `Stream (a -> b)`: `a -> Stream b`
 *
 * @name stream.ap
 * @param {stream} stream - the values stream
 * @return {stream} a new stram with the functions applied to values
 *
 * @example
 * var add = flyd.curryN(2, function(x, y) { return x + y; });
 * var numbers1 = flyd.stream();
 * var numbers2 = flyd.stream();
 * var addToNumbers1 = flyd.map(add, numbers1);
 * var added = addToNumbers1.ap(numbers2);
 */
function ap(s2) {
  var s1 = this;
  return combine(function(s1, s2, self) { self(s1.val(s2.val)); }, [s1, s2]);
}

/**
 * Get a human readable view of a stream
 * @name stream.toString
 * @return {String} the stream string representation
 */
function streamToString() {
  return 'stream(' + this.val + ')';
}

/**
 * @name stream.end
 * @memberof stream
 * A stream that emits `true` when the stream ends. If `true` is pushed down the
 * stream the parent stream ends.
 */

/**
 * @name stream.of
 * @function
 * @memberof stream
 * Returns a new stream with `value` as its initial value. It is identical to
 * calling `flyd.stream` with one argument.
 *
 * __Signature__: Called bound to `Stream (a)`: `b -> Stream b`
 *
 * @param {*} value - the initial value
 * @return {stream} the new stream
 *
 * @example
 * var n = flyd.stream(1);
 * var m = n.of(1);
 */

// /////////////////////////// PRIVATE ///////////////////////////////// //
/**
 * @private
 * Create a stream with no dependencies and no value
 * @return {Function} a flyd stream
 */
function createStream() {
  function s(n) {
    if (arguments.length === 0) return s.val
    updateStreamValue(s, n)
    return s
  }
  s.hasVal = false;
  s.val = undefined;
  s.vals = [];
  s.listeners = [];
  s.queued = false;
  s.end = undefined;
  s.map = boundMap;
  s.ap = ap;
  s.of = flyd.stream;
  s.toString = streamToString;
  return s;
}

/**
 * @private
 * Create a dependent stream
 * @param {Array<stream>} dependencies - an array of the streams
 * @param {Function} fn - the function used to calculate the new stream value
 * from the dependencies
 * @return {stream} the created stream
 */
function createDependentStream(deps, fn) {
  var s = createStream();
  s.fn = fn;
  s.deps = deps;
  s.depsMet = false;
  s.depsChanged = deps.length > 0 ? [] : undefined;
  s.shouldUpdate = false;
  addListeners(deps, s);
  return s;
}

/**
 * @private
 * Check if all the dependencies have values
 * @param {stream} stream - the stream to check depencencies from
 * @return {Boolean} `true` if all dependencies have vales, `false` otherwise
 */
function initialDepsNotMet(stream) {
  stream.depsMet = stream.deps.every(function(s) {
    return s.hasVal;
  });
  return !stream.depsMet;
}

/**
 * @private
 * Update a dependent stream using its dependencies in an atomic way
 * @param {stream} stream - the stream to update
 */
function updateStream(s) {
  if ((s.depsMet !== true && initialDepsNotMet(s)) ||
      (s.end !== undefined && s.end.val === true)) return;
  if (inStream !== undefined) {
    toUpdate.push(s);
    return;
  }
  inStream = s;
  if (s.depsChanged) s.fnArgs[s.fnArgs.length - 1] = s.depsChanged;
  var returnVal = s.fn.apply(s.fn, s.fnArgs);
  if (returnVal !== undefined) {
    s(returnVal);
  }
  inStream = undefined;
  if (s.depsChanged !== undefined) s.depsChanged = [];
  s.shouldUpdate = false;
  if (flushing === false) flushUpdate();
}

/**
 * @private
 * Update the dependencies of a stream
 * @param {stream} stream
 */
function updateDeps(s) {
  var i, o, list
  var listeners = s.listeners;
  for (i = 0; i < listeners.length; ++i) {
    list = listeners[i];
    if (list.end === s) {
      endStream(list);
    } else {
      if (list.depsChanged !== undefined) list.depsChanged.push(s);
      list.shouldUpdate = true;
      findDeps(list);
    }
  }
  for (; orderNextIdx >= 0; --orderNextIdx) {
    o = order[orderNextIdx];
    if (o.shouldUpdate === true) updateStream(o);
    o.queued = false;
  }
}

/**
 * @private
 * Add stream dependencies to the global `order` queue.
 * @param {stream} stream
 * @see updateDeps
 */
function findDeps(s) {
  var i
  var listeners = s.listeners;
  if (s.queued === false) {
    s.queued = true;
    for (i = 0; i < listeners.length; ++i) {
      findDeps(listeners[i]);
    }
    order[++orderNextIdx] = s;
  }
}

/**
 * @private
 */
function flushUpdate() {
  flushing = true;
  while (toUpdate.length > 0) {
    var s = toUpdate.shift();
    if (s.vals.length > 0) s.val = s.vals.shift();
    updateDeps(s);
  }
  flushing = false;
}

/**
 * @private
 * Push down a value into a stream
 * @param {stream} stream
 * @param {*} value
 */
function updateStreamValue(s, n) {
  if (n !== undefined && n !== null && isFunction(n.then)) {
    n.then(s);
    return;
  }
  s.val = n;
  s.hasVal = true;
  if (inStream === undefined) {
    flushing = true;
    updateDeps(s);
    if (toUpdate.length > 0) flushUpdate(); else flushing = false;
  } else if (inStream === s) {
    markListeners(s, s.listeners);
  } else {
    s.vals.push(n);
    toUpdate.push(s);
  }
}

/**
 * @private
 */
function markListeners(s, lists) {
  var i, list;
  for (i = 0; i < lists.length; ++i) {
    list = lists[i];
    if (list.end !== s) {
      if (list.depsChanged !== undefined) {
        list.depsChanged.push(s);
      }
      list.shouldUpdate = true;
    } else {
      endStream(list);
    }
  }
}

/**
 * @private
 * Add dependencies to a stream
 * @param {Array<stream>} dependencies
 * @param {stream} stream
 */
function addListeners(deps, s) {
  for (var i = 0; i < deps.length; ++i) {
    deps[i].listeners.push(s);
  }
}

/**
 * @private
 * Removes an stream from a dependency array
 * @param {stream} stream
 * @param {Array<stream>} dependencies
 */
function removeListener(s, listeners) {
  var idx = listeners.indexOf(s);
  listeners[idx] = listeners[listeners.length - 1];
  listeners.length--;
}

/**
 * @private
 * Detach a stream from its dependencies
 * @param {stream} stream
 */
function detachDeps(s) {
  for (var i = 0; i < s.deps.length; ++i) {
    removeListener(s, s.deps[i].listeners);
  }
  s.deps.length = 0;
}

/**
 * @private
 * Ends a stream
 */
function endStream(s) {
  if (s.deps !== undefined) detachDeps(s);
  if (s.end !== undefined) detachDeps(s.end);
}

/**
 * @private
 * transducer stream transformer
 */
function StreamTransformer() { }
StreamTransformer.prototype['@@transducer/init'] = function() { };
StreamTransformer.prototype['@@transducer/result'] = function() { };
StreamTransformer.prototype['@@transducer/step'] = function(s, v) { return v; };

module.exports = flyd;

},{"ramda/src/curryN":18}],4:[function(require,module,exports){
'use strict';

module.exports = Response;

/**
 * A response from a web request
 *
 * @param {Number} statusCode
 * @param {Object} headers
 * @param {Buffer} body
 * @param {String} url
 */
function Response(statusCode, headers, body, url) {
  if (typeof statusCode !== 'number') {
    throw new TypeError('statusCode must be a number but was ' + (typeof statusCode));
  }
  if (headers === null) {
    throw new TypeError('headers cannot be null');
  }
  if (typeof headers !== 'object') {
    throw new TypeError('headers must be an object but was ' + (typeof headers));
  }
  this.statusCode = statusCode;
  this.headers = {};
  for (var key in headers) {
    this.headers[key.toLowerCase()] = headers[key];
  }
  this.body = body;
  this.url = url;
}

Response.prototype.getBody = function (encoding) {
  if (this.statusCode >= 300) {
    var err = new Error('Server responded with status code '
                    + this.statusCode + ':\n' + this.body.toString());
    err.statusCode = this.statusCode;
    err.headers = this.headers;
    err.body = this.body;
    err.url = this.url;
    throw err;
  }
  return encoding ? this.body.toString(encoding) : this.body;
};

},{}],5:[function(require,module,exports){
(function(definition){if(typeof exports==="object"){module.exports=definition();}else if(typeof define==="function"&&define.amd){define(definition);}else{mori=definition();}})(function(){return function(){
if(typeof Math.imul == "undefined" || (Math.imul(0xffffffff,5) == 0)) {
    Math.imul = function (a, b) {
        var ah  = (a >>> 16) & 0xffff;
        var al = a & 0xffff;
        var bh  = (b >>> 16) & 0xffff;
        var bl = b & 0xffff;
        // the shift by 0 fixes the sign on the high part
        // the final |0 converts the unsigned value into a signed value
        return ((al * bl) + (((ah * bl + al * bh) << 16) >>> 0)|0);
    }
}

var k,aa=this;
function n(a){var b=typeof a;if("object"==b)if(a){if(a instanceof Array)return"array";if(a instanceof Object)return b;var c=Object.prototype.toString.call(a);if("[object Window]"==c)return"object";if("[object Array]"==c||"number"==typeof a.length&&"undefined"!=typeof a.splice&&"undefined"!=typeof a.propertyIsEnumerable&&!a.propertyIsEnumerable("splice"))return"array";if("[object Function]"==c||"undefined"!=typeof a.call&&"undefined"!=typeof a.propertyIsEnumerable&&!a.propertyIsEnumerable("call"))return"function"}else return"null";else if("function"==
b&&"undefined"==typeof a.call)return"object";return b}var ba="closure_uid_"+(1E9*Math.random()>>>0),ca=0;function r(a,b){var c=a.split("."),d=aa;c[0]in d||!d.execScript||d.execScript("var "+c[0]);for(var e;c.length&&(e=c.shift());)c.length||void 0===b?d=d[e]?d[e]:d[e]={}:d[e]=b};function da(a){return Array.prototype.join.call(arguments,"")};function ea(a,b){for(var c in a)b.call(void 0,a[c],c,a)};function fa(a,b){null!=a&&this.append.apply(this,arguments)}fa.prototype.Za="";fa.prototype.append=function(a,b,c){this.Za+=a;if(null!=b)for(var d=1;d<arguments.length;d++)this.Za+=arguments[d];return this};fa.prototype.clear=function(){this.Za=""};fa.prototype.toString=function(){return this.Za};function ga(a,b){a.sort(b||ha)}function ia(a,b){for(var c=0;c<a.length;c++)a[c]={index:c,value:a[c]};var d=b||ha;ga(a,function(a,b){return d(a.value,b.value)||a.index-b.index});for(c=0;c<a.length;c++)a[c]=a[c].value}function ha(a,b){return a>b?1:a<b?-1:0};var ja;if("undefined"===typeof ka)var ka=function(){throw Error("No *print-fn* fn set for evaluation environment");};var la=null,ma=null;if("undefined"===typeof na)var na=null;function oa(){return new pa(null,5,[sa,!0,ua,!0,wa,!1,ya,!1,za,la],null)}function t(a){return null!=a&&!1!==a}function Aa(a){return t(a)?!1:!0}function w(a,b){return a[n(null==b?null:b)]?!0:a._?!0:!1}function Ba(a){return null==a?null:a.constructor}
function x(a,b){var c=Ba(b),c=t(t(c)?c.Yb:c)?c.Xb:n(b);return Error(["No protocol method ",a," defined for type ",c,": ",b].join(""))}function Da(a){var b=a.Xb;return t(b)?b:""+z(a)}var Ea="undefined"!==typeof Symbol&&"function"===n(Symbol)?Symbol.Cc:"@@iterator";function Fa(a){for(var b=a.length,c=Array(b),d=0;;)if(d<b)c[d]=a[d],d+=1;else break;return c}function Ha(a){for(var b=Array(arguments.length),c=0;;)if(c<b.length)b[c]=arguments[c],c+=1;else return b}
var Ia=function(){function a(a,b){function c(a,b){a.push(b);return a}var g=[];return A.c?A.c(c,g,b):A.call(null,c,g,b)}function b(a){return c.a(null,a)}var c=null,c=function(d,c){switch(arguments.length){case 1:return b.call(this,d);case 2:return a.call(this,0,c)}throw Error("Invalid arity: "+arguments.length);};c.b=b;c.a=a;return c}(),Ja={},La={};function Ma(a){if(a?a.L:a)return a.L(a);var b;b=Ma[n(null==a?null:a)];if(!b&&(b=Ma._,!b))throw x("ICounted.-count",a);return b.call(null,a)}
function Na(a){if(a?a.J:a)return a.J(a);var b;b=Na[n(null==a?null:a)];if(!b&&(b=Na._,!b))throw x("IEmptyableCollection.-empty",a);return b.call(null,a)}var Qa={};function Ra(a,b){if(a?a.G:a)return a.G(a,b);var c;c=Ra[n(null==a?null:a)];if(!c&&(c=Ra._,!c))throw x("ICollection.-conj",a);return c.call(null,a,b)}
var Ta={},C=function(){function a(a,b,c){if(a?a.$:a)return a.$(a,b,c);var g;g=C[n(null==a?null:a)];if(!g&&(g=C._,!g))throw x("IIndexed.-nth",a);return g.call(null,a,b,c)}function b(a,b){if(a?a.Q:a)return a.Q(a,b);var c;c=C[n(null==a?null:a)];if(!c&&(c=C._,!c))throw x("IIndexed.-nth",a);return c.call(null,a,b)}var c=null,c=function(d,c,f){switch(arguments.length){case 2:return b.call(this,d,c);case 3:return a.call(this,d,c,f)}throw Error("Invalid arity: "+arguments.length);};c.a=b;c.c=a;return c}(),
Ua={};function Va(a){if(a?a.N:a)return a.N(a);var b;b=Va[n(null==a?null:a)];if(!b&&(b=Va._,!b))throw x("ISeq.-first",a);return b.call(null,a)}function Wa(a){if(a?a.S:a)return a.S(a);var b;b=Wa[n(null==a?null:a)];if(!b&&(b=Wa._,!b))throw x("ISeq.-rest",a);return b.call(null,a)}
var Xa={},Za={},$a=function(){function a(a,b,c){if(a?a.s:a)return a.s(a,b,c);var g;g=$a[n(null==a?null:a)];if(!g&&(g=$a._,!g))throw x("ILookup.-lookup",a);return g.call(null,a,b,c)}function b(a,b){if(a?a.t:a)return a.t(a,b);var c;c=$a[n(null==a?null:a)];if(!c&&(c=$a._,!c))throw x("ILookup.-lookup",a);return c.call(null,a,b)}var c=null,c=function(c,e,f){switch(arguments.length){case 2:return b.call(this,c,e);case 3:return a.call(this,c,e,f)}throw Error("Invalid arity: "+arguments.length);};c.a=b;c.c=
a;return c}(),ab={};function bb(a,b){if(a?a.rb:a)return a.rb(a,b);var c;c=bb[n(null==a?null:a)];if(!c&&(c=bb._,!c))throw x("IAssociative.-contains-key?",a);return c.call(null,a,b)}function cb(a,b,c){if(a?a.Ka:a)return a.Ka(a,b,c);var d;d=cb[n(null==a?null:a)];if(!d&&(d=cb._,!d))throw x("IAssociative.-assoc",a);return d.call(null,a,b,c)}var db={};function eb(a,b){if(a?a.wb:a)return a.wb(a,b);var c;c=eb[n(null==a?null:a)];if(!c&&(c=eb._,!c))throw x("IMap.-dissoc",a);return c.call(null,a,b)}var fb={};
function hb(a){if(a?a.hb:a)return a.hb(a);var b;b=hb[n(null==a?null:a)];if(!b&&(b=hb._,!b))throw x("IMapEntry.-key",a);return b.call(null,a)}function ib(a){if(a?a.ib:a)return a.ib(a);var b;b=ib[n(null==a?null:a)];if(!b&&(b=ib._,!b))throw x("IMapEntry.-val",a);return b.call(null,a)}var jb={};function kb(a,b){if(a?a.Eb:a)return a.Eb(a,b);var c;c=kb[n(null==a?null:a)];if(!c&&(c=kb._,!c))throw x("ISet.-disjoin",a);return c.call(null,a,b)}
function lb(a){if(a?a.La:a)return a.La(a);var b;b=lb[n(null==a?null:a)];if(!b&&(b=lb._,!b))throw x("IStack.-peek",a);return b.call(null,a)}function mb(a){if(a?a.Ma:a)return a.Ma(a);var b;b=mb[n(null==a?null:a)];if(!b&&(b=mb._,!b))throw x("IStack.-pop",a);return b.call(null,a)}var nb={};function pb(a,b,c){if(a?a.Ua:a)return a.Ua(a,b,c);var d;d=pb[n(null==a?null:a)];if(!d&&(d=pb._,!d))throw x("IVector.-assoc-n",a);return d.call(null,a,b,c)}
function qb(a){if(a?a.Ra:a)return a.Ra(a);var b;b=qb[n(null==a?null:a)];if(!b&&(b=qb._,!b))throw x("IDeref.-deref",a);return b.call(null,a)}var rb={};function sb(a){if(a?a.H:a)return a.H(a);var b;b=sb[n(null==a?null:a)];if(!b&&(b=sb._,!b))throw x("IMeta.-meta",a);return b.call(null,a)}var tb={};function ub(a,b){if(a?a.F:a)return a.F(a,b);var c;c=ub[n(null==a?null:a)];if(!c&&(c=ub._,!c))throw x("IWithMeta.-with-meta",a);return c.call(null,a,b)}
var vb={},wb=function(){function a(a,b,c){if(a?a.O:a)return a.O(a,b,c);var g;g=wb[n(null==a?null:a)];if(!g&&(g=wb._,!g))throw x("IReduce.-reduce",a);return g.call(null,a,b,c)}function b(a,b){if(a?a.R:a)return a.R(a,b);var c;c=wb[n(null==a?null:a)];if(!c&&(c=wb._,!c))throw x("IReduce.-reduce",a);return c.call(null,a,b)}var c=null,c=function(c,e,f){switch(arguments.length){case 2:return b.call(this,c,e);case 3:return a.call(this,c,e,f)}throw Error("Invalid arity: "+arguments.length);};c.a=b;c.c=a;return c}();
function xb(a,b,c){if(a?a.gb:a)return a.gb(a,b,c);var d;d=xb[n(null==a?null:a)];if(!d&&(d=xb._,!d))throw x("IKVReduce.-kv-reduce",a);return d.call(null,a,b,c)}function yb(a,b){if(a?a.A:a)return a.A(a,b);var c;c=yb[n(null==a?null:a)];if(!c&&(c=yb._,!c))throw x("IEquiv.-equiv",a);return c.call(null,a,b)}function zb(a){if(a?a.B:a)return a.B(a);var b;b=zb[n(null==a?null:a)];if(!b&&(b=zb._,!b))throw x("IHash.-hash",a);return b.call(null,a)}var Bb={};
function Cb(a){if(a?a.D:a)return a.D(a);var b;b=Cb[n(null==a?null:a)];if(!b&&(b=Cb._,!b))throw x("ISeqable.-seq",a);return b.call(null,a)}var Db={},Eb={},Fb={};function Gb(a){if(a?a.ab:a)return a.ab(a);var b;b=Gb[n(null==a?null:a)];if(!b&&(b=Gb._,!b))throw x("IReversible.-rseq",a);return b.call(null,a)}function Hb(a,b){if(a?a.Hb:a)return a.Hb(a,b);var c;c=Hb[n(null==a?null:a)];if(!c&&(c=Hb._,!c))throw x("ISorted.-sorted-seq",a);return c.call(null,a,b)}
function Ib(a,b,c){if(a?a.Ib:a)return a.Ib(a,b,c);var d;d=Ib[n(null==a?null:a)];if(!d&&(d=Ib._,!d))throw x("ISorted.-sorted-seq-from",a);return d.call(null,a,b,c)}function Jb(a,b){if(a?a.Gb:a)return a.Gb(a,b);var c;c=Jb[n(null==a?null:a)];if(!c&&(c=Jb._,!c))throw x("ISorted.-entry-key",a);return c.call(null,a,b)}function Kb(a){if(a?a.Fb:a)return a.Fb(a);var b;b=Kb[n(null==a?null:a)];if(!b&&(b=Kb._,!b))throw x("ISorted.-comparator",a);return b.call(null,a)}
function Lb(a,b){if(a?a.Wb:a)return a.Wb(0,b);var c;c=Lb[n(null==a?null:a)];if(!c&&(c=Lb._,!c))throw x("IWriter.-write",a);return c.call(null,a,b)}var Mb={};function Nb(a,b,c){if(a?a.v:a)return a.v(a,b,c);var d;d=Nb[n(null==a?null:a)];if(!d&&(d=Nb._,!d))throw x("IPrintWithWriter.-pr-writer",a);return d.call(null,a,b,c)}function Ob(a){if(a?a.$a:a)return a.$a(a);var b;b=Ob[n(null==a?null:a)];if(!b&&(b=Ob._,!b))throw x("IEditableCollection.-as-transient",a);return b.call(null,a)}
function Pb(a,b){if(a?a.Sa:a)return a.Sa(a,b);var c;c=Pb[n(null==a?null:a)];if(!c&&(c=Pb._,!c))throw x("ITransientCollection.-conj!",a);return c.call(null,a,b)}function Qb(a){if(a?a.Ta:a)return a.Ta(a);var b;b=Qb[n(null==a?null:a)];if(!b&&(b=Qb._,!b))throw x("ITransientCollection.-persistent!",a);return b.call(null,a)}function Rb(a,b,c){if(a?a.kb:a)return a.kb(a,b,c);var d;d=Rb[n(null==a?null:a)];if(!d&&(d=Rb._,!d))throw x("ITransientAssociative.-assoc!",a);return d.call(null,a,b,c)}
function Sb(a,b){if(a?a.Jb:a)return a.Jb(a,b);var c;c=Sb[n(null==a?null:a)];if(!c&&(c=Sb._,!c))throw x("ITransientMap.-dissoc!",a);return c.call(null,a,b)}function Tb(a,b,c){if(a?a.Ub:a)return a.Ub(0,b,c);var d;d=Tb[n(null==a?null:a)];if(!d&&(d=Tb._,!d))throw x("ITransientVector.-assoc-n!",a);return d.call(null,a,b,c)}function Ub(a){if(a?a.Vb:a)return a.Vb();var b;b=Ub[n(null==a?null:a)];if(!b&&(b=Ub._,!b))throw x("ITransientVector.-pop!",a);return b.call(null,a)}
function Vb(a,b){if(a?a.Tb:a)return a.Tb(0,b);var c;c=Vb[n(null==a?null:a)];if(!c&&(c=Vb._,!c))throw x("ITransientSet.-disjoin!",a);return c.call(null,a,b)}function Xb(a){if(a?a.Pb:a)return a.Pb();var b;b=Xb[n(null==a?null:a)];if(!b&&(b=Xb._,!b))throw x("IChunk.-drop-first",a);return b.call(null,a)}function Yb(a){if(a?a.Cb:a)return a.Cb(a);var b;b=Yb[n(null==a?null:a)];if(!b&&(b=Yb._,!b))throw x("IChunkedSeq.-chunked-first",a);return b.call(null,a)}
function Zb(a){if(a?a.Db:a)return a.Db(a);var b;b=Zb[n(null==a?null:a)];if(!b&&(b=Zb._,!b))throw x("IChunkedSeq.-chunked-rest",a);return b.call(null,a)}function $b(a){if(a?a.Bb:a)return a.Bb(a);var b;b=$b[n(null==a?null:a)];if(!b&&(b=$b._,!b))throw x("IChunkedNext.-chunked-next",a);return b.call(null,a)}function ac(a,b){if(a?a.bb:a)return a.bb(0,b);var c;c=ac[n(null==a?null:a)];if(!c&&(c=ac._,!c))throw x("IVolatile.-vreset!",a);return c.call(null,a,b)}var bc={};
function cc(a){if(a?a.fb:a)return a.fb(a);var b;b=cc[n(null==a?null:a)];if(!b&&(b=cc._,!b))throw x("IIterable.-iterator",a);return b.call(null,a)}function dc(a){this.qc=a;this.q=0;this.j=1073741824}dc.prototype.Wb=function(a,b){return this.qc.append(b)};function ec(a){var b=new fa;a.v(null,new dc(b),oa());return""+z(b)}
var fc="undefined"!==typeof Math.imul&&0!==(Math.imul.a?Math.imul.a(4294967295,5):Math.imul.call(null,4294967295,5))?function(a,b){return Math.imul.a?Math.imul.a(a,b):Math.imul.call(null,a,b)}:function(a,b){var c=a&65535,d=b&65535;return c*d+((a>>>16&65535)*d+c*(b>>>16&65535)<<16>>>0)|0};function gc(a){a=fc(a,3432918353);return fc(a<<15|a>>>-15,461845907)}function hc(a,b){var c=a^b;return fc(c<<13|c>>>-13,5)+3864292196}
function ic(a,b){var c=a^b,c=fc(c^c>>>16,2246822507),c=fc(c^c>>>13,3266489909);return c^c>>>16}var kc={},lc=0;function mc(a){255<lc&&(kc={},lc=0);var b=kc[a];if("number"!==typeof b){a:if(null!=a)if(b=a.length,0<b){for(var c=0,d=0;;)if(c<b)var e=c+1,d=fc(31,d)+a.charCodeAt(c),c=e;else{b=d;break a}b=void 0}else b=0;else b=0;kc[a]=b;lc+=1}return a=b}
function nc(a){a&&(a.j&4194304||a.vc)?a=a.B(null):"number"===typeof a?a=(Math.floor.b?Math.floor.b(a):Math.floor.call(null,a))%2147483647:!0===a?a=1:!1===a?a=0:"string"===typeof a?(a=mc(a),0!==a&&(a=gc(a),a=hc(0,a),a=ic(a,4))):a=a instanceof Date?a.valueOf():null==a?0:zb(a);return a}
function oc(a){var b;b=a.name;var c;a:{c=1;for(var d=0;;)if(c<b.length){var e=c+2,d=hc(d,gc(b.charCodeAt(c-1)|b.charCodeAt(c)<<16));c=e}else{c=d;break a}c=void 0}c=1===(b.length&1)?c^gc(b.charCodeAt(b.length-1)):c;b=ic(c,fc(2,b.length));a=mc(a.ba);return b^a+2654435769+(b<<6)+(b>>2)}function pc(a,b){if(a.ta===b.ta)return 0;var c=Aa(a.ba);if(t(c?b.ba:c))return-1;if(t(a.ba)){if(Aa(b.ba))return 1;c=ha(a.ba,b.ba);return 0===c?ha(a.name,b.name):c}return ha(a.name,b.name)}
function qc(a,b,c,d,e){this.ba=a;this.name=b;this.ta=c;this.Ya=d;this.Z=e;this.j=2154168321;this.q=4096}k=qc.prototype;k.v=function(a,b){return Lb(b,this.ta)};k.B=function(){var a=this.Ya;return null!=a?a:this.Ya=a=oc(this)};k.F=function(a,b){return new qc(this.ba,this.name,this.ta,this.Ya,b)};k.H=function(){return this.Z};
k.call=function(){var a=null,a=function(a,c,d){switch(arguments.length){case 2:return $a.c(c,this,null);case 3:return $a.c(c,this,d)}throw Error("Invalid arity: "+arguments.length);};a.a=function(a,c){return $a.c(c,this,null)};a.c=function(a,c,d){return $a.c(c,this,d)};return a}();k.apply=function(a,b){return this.call.apply(this,[this].concat(Fa(b)))};k.b=function(a){return $a.c(a,this,null)};k.a=function(a,b){return $a.c(a,this,b)};k.A=function(a,b){return b instanceof qc?this.ta===b.ta:!1};
k.toString=function(){return this.ta};var rc=function(){function a(a,b){var c=null!=a?[z(a),z("/"),z(b)].join(""):b;return new qc(a,b,c,null,null)}function b(a){return a instanceof qc?a:c.a(null,a)}var c=null,c=function(c,e){switch(arguments.length){case 1:return b.call(this,c);case 2:return a.call(this,c,e)}throw Error("Invalid arity: "+arguments.length);};c.b=b;c.a=a;return c}();
function D(a){if(null==a)return null;if(a&&(a.j&8388608||a.mc))return a.D(null);if(a instanceof Array||"string"===typeof a)return 0===a.length?null:new F(a,0);if(w(Bb,a))return Cb(a);throw Error([z(a),z(" is not ISeqable")].join(""));}function G(a){if(null==a)return null;if(a&&(a.j&64||a.jb))return a.N(null);a=D(a);return null==a?null:Va(a)}function H(a){return null!=a?a&&(a.j&64||a.jb)?a.S(null):(a=D(a))?Wa(a):J:J}function K(a){return null==a?null:a&&(a.j&128||a.xb)?a.T(null):D(H(a))}
var sc=function(){function a(a,b){return null==a?null==b:a===b||yb(a,b)}var b=null,c=function(){function a(b,d,h){var l=null;if(2<arguments.length){for(var l=0,m=Array(arguments.length-2);l<m.length;)m[l]=arguments[l+2],++l;l=new F(m,0)}return c.call(this,b,d,l)}function c(a,d,e){for(;;)if(b.a(a,d))if(K(e))a=d,d=G(e),e=K(e);else return b.a(d,G(e));else return!1}a.i=2;a.f=function(a){var b=G(a);a=K(a);var d=G(a);a=H(a);return c(b,d,a)};a.d=c;return a}(),b=function(b,e,f){switch(arguments.length){case 1:return!0;
case 2:return a.call(this,b,e);default:var g=null;if(2<arguments.length){for(var g=0,h=Array(arguments.length-2);g<h.length;)h[g]=arguments[g+2],++g;g=new F(h,0)}return c.d(b,e,g)}throw Error("Invalid arity: "+arguments.length);};b.i=2;b.f=c.f;b.b=function(){return!0};b.a=a;b.d=c.d;return b}();function tc(a){this.C=a}tc.prototype.next=function(){if(null!=this.C){var a=G(this.C);this.C=K(this.C);return{done:!1,value:a}}return{done:!0,value:null}};function uc(a){return new tc(D(a))}
function vc(a,b){var c=gc(a),c=hc(0,c);return ic(c,b)}function wc(a){var b=0,c=1;for(a=D(a);;)if(null!=a)b+=1,c=fc(31,c)+nc(G(a))|0,a=K(a);else return vc(c,b)}function xc(a){var b=0,c=0;for(a=D(a);;)if(null!=a)b+=1,c=c+nc(G(a))|0,a=K(a);else return vc(c,b)}La["null"]=!0;Ma["null"]=function(){return 0};Date.prototype.A=function(a,b){return b instanceof Date&&this.toString()===b.toString()};yb.number=function(a,b){return a===b};rb["function"]=!0;sb["function"]=function(){return null};
Ja["function"]=!0;zb._=function(a){return a[ba]||(a[ba]=++ca)};function yc(a){this.o=a;this.q=0;this.j=32768}yc.prototype.Ra=function(){return this.o};function Ac(a){return a instanceof yc}function Bc(a){return Ac(a)?L.b?L.b(a):L.call(null,a):a}function L(a){return qb(a)}
var Cc=function(){function a(a,b,c,d){for(var l=Ma(a);;)if(d<l){var m=C.a(a,d);c=b.a?b.a(c,m):b.call(null,c,m);if(Ac(c))return qb(c);d+=1}else return c}function b(a,b,c){var d=Ma(a),l=c;for(c=0;;)if(c<d){var m=C.a(a,c),l=b.a?b.a(l,m):b.call(null,l,m);if(Ac(l))return qb(l);c+=1}else return l}function c(a,b){var c=Ma(a);if(0===c)return b.l?b.l():b.call(null);for(var d=C.a(a,0),l=1;;)if(l<c){var m=C.a(a,l),d=b.a?b.a(d,m):b.call(null,d,m);if(Ac(d))return qb(d);l+=1}else return d}var d=null,d=function(d,
f,g,h){switch(arguments.length){case 2:return c.call(this,d,f);case 3:return b.call(this,d,f,g);case 4:return a.call(this,d,f,g,h)}throw Error("Invalid arity: "+arguments.length);};d.a=c;d.c=b;d.n=a;return d}(),Dc=function(){function a(a,b,c,d){for(var l=a.length;;)if(d<l){var m=a[d];c=b.a?b.a(c,m):b.call(null,c,m);if(Ac(c))return qb(c);d+=1}else return c}function b(a,b,c){var d=a.length,l=c;for(c=0;;)if(c<d){var m=a[c],l=b.a?b.a(l,m):b.call(null,l,m);if(Ac(l))return qb(l);c+=1}else return l}function c(a,
b){var c=a.length;if(0===a.length)return b.l?b.l():b.call(null);for(var d=a[0],l=1;;)if(l<c){var m=a[l],d=b.a?b.a(d,m):b.call(null,d,m);if(Ac(d))return qb(d);l+=1}else return d}var d=null,d=function(d,f,g,h){switch(arguments.length){case 2:return c.call(this,d,f);case 3:return b.call(this,d,f,g);case 4:return a.call(this,d,f,g,h)}throw Error("Invalid arity: "+arguments.length);};d.a=c;d.c=b;d.n=a;return d}();function Ec(a){return a?a.j&2||a.cc?!0:a.j?!1:w(La,a):w(La,a)}
function Fc(a){return a?a.j&16||a.Qb?!0:a.j?!1:w(Ta,a):w(Ta,a)}function Gc(a,b){this.e=a;this.m=b}Gc.prototype.ga=function(){return this.m<this.e.length};Gc.prototype.next=function(){var a=this.e[this.m];this.m+=1;return a};function F(a,b){this.e=a;this.m=b;this.j=166199550;this.q=8192}k=F.prototype;k.toString=function(){return ec(this)};k.Q=function(a,b){var c=b+this.m;return c<this.e.length?this.e[c]:null};k.$=function(a,b,c){a=b+this.m;return a<this.e.length?this.e[a]:c};k.vb=!0;
k.fb=function(){return new Gc(this.e,this.m)};k.T=function(){return this.m+1<this.e.length?new F(this.e,this.m+1):null};k.L=function(){return this.e.length-this.m};k.ab=function(){var a=Ma(this);return 0<a?new Hc(this,a-1,null):null};k.B=function(){return wc(this)};k.A=function(a,b){return Ic.a?Ic.a(this,b):Ic.call(null,this,b)};k.J=function(){return J};k.R=function(a,b){return Dc.n(this.e,b,this.e[this.m],this.m+1)};k.O=function(a,b,c){return Dc.n(this.e,b,c,this.m)};k.N=function(){return this.e[this.m]};
k.S=function(){return this.m+1<this.e.length?new F(this.e,this.m+1):J};k.D=function(){return this};k.G=function(a,b){return M.a?M.a(b,this):M.call(null,b,this)};F.prototype[Ea]=function(){return uc(this)};
var Jc=function(){function a(a,b){return b<a.length?new F(a,b):null}function b(a){return c.a(a,0)}var c=null,c=function(c,e){switch(arguments.length){case 1:return b.call(this,c);case 2:return a.call(this,c,e)}throw Error("Invalid arity: "+arguments.length);};c.b=b;c.a=a;return c}(),Kc=function(){function a(a,b){return Jc.a(a,b)}function b(a){return Jc.a(a,0)}var c=null,c=function(c,e){switch(arguments.length){case 1:return b.call(this,c);case 2:return a.call(this,c,e)}throw Error("Invalid arity: "+
arguments.length);};c.b=b;c.a=a;return c}();function Hc(a,b,c){this.qb=a;this.m=b;this.k=c;this.j=32374990;this.q=8192}k=Hc.prototype;k.toString=function(){return ec(this)};k.H=function(){return this.k};k.T=function(){return 0<this.m?new Hc(this.qb,this.m-1,null):null};k.L=function(){return this.m+1};k.B=function(){return wc(this)};k.A=function(a,b){return Ic.a?Ic.a(this,b):Ic.call(null,this,b)};k.J=function(){var a=this.k;return O.a?O.a(J,a):O.call(null,J,a)};
k.R=function(a,b){return P.a?P.a(b,this):P.call(null,b,this)};k.O=function(a,b,c){return P.c?P.c(b,c,this):P.call(null,b,c,this)};k.N=function(){return C.a(this.qb,this.m)};k.S=function(){return 0<this.m?new Hc(this.qb,this.m-1,null):J};k.D=function(){return this};k.F=function(a,b){return new Hc(this.qb,this.m,b)};k.G=function(a,b){return M.a?M.a(b,this):M.call(null,b,this)};Hc.prototype[Ea]=function(){return uc(this)};function Lc(a){return G(K(a))}yb._=function(a,b){return a===b};
var Nc=function(){function a(a,b){return null!=a?Ra(a,b):Ra(J,b)}var b=null,c=function(){function a(b,d,h){var l=null;if(2<arguments.length){for(var l=0,m=Array(arguments.length-2);l<m.length;)m[l]=arguments[l+2],++l;l=new F(m,0)}return c.call(this,b,d,l)}function c(a,d,e){for(;;)if(t(e))a=b.a(a,d),d=G(e),e=K(e);else return b.a(a,d)}a.i=2;a.f=function(a){var b=G(a);a=K(a);var d=G(a);a=H(a);return c(b,d,a)};a.d=c;return a}(),b=function(b,e,f){switch(arguments.length){case 0:return Mc;case 1:return b;
case 2:return a.call(this,b,e);default:var g=null;if(2<arguments.length){for(var g=0,h=Array(arguments.length-2);g<h.length;)h[g]=arguments[g+2],++g;g=new F(h,0)}return c.d(b,e,g)}throw Error("Invalid arity: "+arguments.length);};b.i=2;b.f=c.f;b.l=function(){return Mc};b.b=function(a){return a};b.a=a;b.d=c.d;return b}();function Oc(a){return null==a?null:Na(a)}
function Q(a){if(null!=a)if(a&&(a.j&2||a.cc))a=a.L(null);else if(a instanceof Array)a=a.length;else if("string"===typeof a)a=a.length;else if(w(La,a))a=Ma(a);else a:{a=D(a);for(var b=0;;){if(Ec(a)){a=b+Ma(a);break a}a=K(a);b+=1}a=void 0}else a=0;return a}
var Pc=function(){function a(a,b,c){for(;;){if(null==a)return c;if(0===b)return D(a)?G(a):c;if(Fc(a))return C.c(a,b,c);if(D(a))a=K(a),b-=1;else return c}}function b(a,b){for(;;){if(null==a)throw Error("Index out of bounds");if(0===b){if(D(a))return G(a);throw Error("Index out of bounds");}if(Fc(a))return C.a(a,b);if(D(a)){var c=K(a),g=b-1;a=c;b=g}else throw Error("Index out of bounds");}}var c=null,c=function(c,e,f){switch(arguments.length){case 2:return b.call(this,c,e);case 3:return a.call(this,
c,e,f)}throw Error("Invalid arity: "+arguments.length);};c.a=b;c.c=a;return c}(),R=function(){function a(a,b,c){if("number"!==typeof b)throw Error("index argument to nth must be a number.");if(null==a)return c;if(a&&(a.j&16||a.Qb))return a.$(null,b,c);if(a instanceof Array||"string"===typeof a)return b<a.length?a[b]:c;if(w(Ta,a))return C.a(a,b);if(a?a.j&64||a.jb||(a.j?0:w(Ua,a)):w(Ua,a))return Pc.c(a,b,c);throw Error([z("nth not supported on this type "),z(Da(Ba(a)))].join(""));}function b(a,b){if("number"!==
typeof b)throw Error("index argument to nth must be a number");if(null==a)return a;if(a&&(a.j&16||a.Qb))return a.Q(null,b);if(a instanceof Array||"string"===typeof a)return b<a.length?a[b]:null;if(w(Ta,a))return C.a(a,b);if(a?a.j&64||a.jb||(a.j?0:w(Ua,a)):w(Ua,a))return Pc.a(a,b);throw Error([z("nth not supported on this type "),z(Da(Ba(a)))].join(""));}var c=null,c=function(c,e,f){switch(arguments.length){case 2:return b.call(this,c,e);case 3:return a.call(this,c,e,f)}throw Error("Invalid arity: "+
arguments.length);};c.a=b;c.c=a;return c}(),S=function(){function a(a,b,c){return null!=a?a&&(a.j&256||a.Rb)?a.s(null,b,c):a instanceof Array?b<a.length?a[b]:c:"string"===typeof a?b<a.length?a[b]:c:w(Za,a)?$a.c(a,b,c):c:c}function b(a,b){return null==a?null:a&&(a.j&256||a.Rb)?a.t(null,b):a instanceof Array?b<a.length?a[b]:null:"string"===typeof a?b<a.length?a[b]:null:w(Za,a)?$a.a(a,b):null}var c=null,c=function(c,e,f){switch(arguments.length){case 2:return b.call(this,c,e);case 3:return a.call(this,
c,e,f)}throw Error("Invalid arity: "+arguments.length);};c.a=b;c.c=a;return c}(),Rc=function(){function a(a,b,c){if(null!=a)a=cb(a,b,c);else a:{a=[b];c=[c];b=a.length;for(var g=0,h=Ob(Qc);;)if(g<b)var l=g+1,h=h.kb(null,a[g],c[g]),g=l;else{a=Qb(h);break a}a=void 0}return a}var b=null,c=function(){function a(b,d,h,l){var m=null;if(3<arguments.length){for(var m=0,p=Array(arguments.length-3);m<p.length;)p[m]=arguments[m+3],++m;m=new F(p,0)}return c.call(this,b,d,h,m)}function c(a,d,e,l){for(;;)if(a=b.c(a,
d,e),t(l))d=G(l),e=Lc(l),l=K(K(l));else return a}a.i=3;a.f=function(a){var b=G(a);a=K(a);var d=G(a);a=K(a);var l=G(a);a=H(a);return c(b,d,l,a)};a.d=c;return a}(),b=function(b,e,f,g){switch(arguments.length){case 3:return a.call(this,b,e,f);default:var h=null;if(3<arguments.length){for(var h=0,l=Array(arguments.length-3);h<l.length;)l[h]=arguments[h+3],++h;h=new F(l,0)}return c.d(b,e,f,h)}throw Error("Invalid arity: "+arguments.length);};b.i=3;b.f=c.f;b.c=a;b.d=c.d;return b}(),Sc=function(){function a(a,
b){return null==a?null:eb(a,b)}var b=null,c=function(){function a(b,d,h){var l=null;if(2<arguments.length){for(var l=0,m=Array(arguments.length-2);l<m.length;)m[l]=arguments[l+2],++l;l=new F(m,0)}return c.call(this,b,d,l)}function c(a,d,e){for(;;){if(null==a)return null;a=b.a(a,d);if(t(e))d=G(e),e=K(e);else return a}}a.i=2;a.f=function(a){var b=G(a);a=K(a);var d=G(a);a=H(a);return c(b,d,a)};a.d=c;return a}(),b=function(b,e,f){switch(arguments.length){case 1:return b;case 2:return a.call(this,b,e);
default:var g=null;if(2<arguments.length){for(var g=0,h=Array(arguments.length-2);g<h.length;)h[g]=arguments[g+2],++g;g=new F(h,0)}return c.d(b,e,g)}throw Error("Invalid arity: "+arguments.length);};b.i=2;b.f=c.f;b.b=function(a){return a};b.a=a;b.d=c.d;return b}();function Tc(a){var b="function"==n(a);return t(b)?b:a?t(t(null)?null:a.bc)?!0:a.yb?!1:w(Ja,a):w(Ja,a)}function Uc(a,b){this.h=a;this.k=b;this.q=0;this.j=393217}k=Uc.prototype;
k.call=function(){function a(a,b,c,d,e,f,g,h,l,m,p,q,u,s,v,y,B,E,N,Y,ra,I){a=this.h;return T.ub?T.ub(a,b,c,d,e,f,g,h,l,m,p,q,u,s,v,y,B,E,N,Y,ra,I):T.call(null,a,b,c,d,e,f,g,h,l,m,p,q,u,s,v,y,B,E,N,Y,ra,I)}function b(a,b,c,d,e,f,g,h,l,m,p,q,u,s,v,y,B,E,N,Y,ra){a=this;return a.h.Fa?a.h.Fa(b,c,d,e,f,g,h,l,m,p,q,u,s,v,y,B,E,N,Y,ra):a.h.call(null,b,c,d,e,f,g,h,l,m,p,q,u,s,v,y,B,E,N,Y,ra)}function c(a,b,c,d,e,f,g,h,l,m,p,q,u,s,v,y,B,E,N,Y){a=this;return a.h.Ea?a.h.Ea(b,c,d,e,f,g,h,l,m,p,q,u,s,v,y,B,E,N,
Y):a.h.call(null,b,c,d,e,f,g,h,l,m,p,q,u,s,v,y,B,E,N,Y)}function d(a,b,c,d,e,f,g,h,l,m,p,q,u,s,v,y,B,E,N){a=this;return a.h.Da?a.h.Da(b,c,d,e,f,g,h,l,m,p,q,u,s,v,y,B,E,N):a.h.call(null,b,c,d,e,f,g,h,l,m,p,q,u,s,v,y,B,E,N)}function e(a,b,c,d,e,f,g,h,l,m,p,q,u,s,v,y,B,E){a=this;return a.h.Ca?a.h.Ca(b,c,d,e,f,g,h,l,m,p,q,u,s,v,y,B,E):a.h.call(null,b,c,d,e,f,g,h,l,m,p,q,u,s,v,y,B,E)}function f(a,b,c,d,e,f,g,h,l,m,p,q,u,s,v,y,B){a=this;return a.h.Ba?a.h.Ba(b,c,d,e,f,g,h,l,m,p,q,u,s,v,y,B):a.h.call(null,
b,c,d,e,f,g,h,l,m,p,q,u,s,v,y,B)}function g(a,b,c,d,e,f,g,h,l,m,p,q,u,s,v,y){a=this;return a.h.Aa?a.h.Aa(b,c,d,e,f,g,h,l,m,p,q,u,s,v,y):a.h.call(null,b,c,d,e,f,g,h,l,m,p,q,u,s,v,y)}function h(a,b,c,d,e,f,g,h,l,m,p,q,u,s,v){a=this;return a.h.za?a.h.za(b,c,d,e,f,g,h,l,m,p,q,u,s,v):a.h.call(null,b,c,d,e,f,g,h,l,m,p,q,u,s,v)}function l(a,b,c,d,e,f,g,h,l,m,p,q,u,s){a=this;return a.h.ya?a.h.ya(b,c,d,e,f,g,h,l,m,p,q,u,s):a.h.call(null,b,c,d,e,f,g,h,l,m,p,q,u,s)}function m(a,b,c,d,e,f,g,h,l,m,p,q,u){a=this;
return a.h.xa?a.h.xa(b,c,d,e,f,g,h,l,m,p,q,u):a.h.call(null,b,c,d,e,f,g,h,l,m,p,q,u)}function p(a,b,c,d,e,f,g,h,l,m,p,q){a=this;return a.h.wa?a.h.wa(b,c,d,e,f,g,h,l,m,p,q):a.h.call(null,b,c,d,e,f,g,h,l,m,p,q)}function q(a,b,c,d,e,f,g,h,l,m,p){a=this;return a.h.va?a.h.va(b,c,d,e,f,g,h,l,m,p):a.h.call(null,b,c,d,e,f,g,h,l,m,p)}function s(a,b,c,d,e,f,g,h,l,m){a=this;return a.h.Ha?a.h.Ha(b,c,d,e,f,g,h,l,m):a.h.call(null,b,c,d,e,f,g,h,l,m)}function u(a,b,c,d,e,f,g,h,l){a=this;return a.h.Ga?a.h.Ga(b,c,
d,e,f,g,h,l):a.h.call(null,b,c,d,e,f,g,h,l)}function v(a,b,c,d,e,f,g,h){a=this;return a.h.ia?a.h.ia(b,c,d,e,f,g,h):a.h.call(null,b,c,d,e,f,g,h)}function y(a,b,c,d,e,f,g){a=this;return a.h.P?a.h.P(b,c,d,e,f,g):a.h.call(null,b,c,d,e,f,g)}function B(a,b,c,d,e,f){a=this;return a.h.r?a.h.r(b,c,d,e,f):a.h.call(null,b,c,d,e,f)}function E(a,b,c,d,e){a=this;return a.h.n?a.h.n(b,c,d,e):a.h.call(null,b,c,d,e)}function N(a,b,c,d){a=this;return a.h.c?a.h.c(b,c,d):a.h.call(null,b,c,d)}function Y(a,b,c){a=this;
return a.h.a?a.h.a(b,c):a.h.call(null,b,c)}function ra(a,b){a=this;return a.h.b?a.h.b(b):a.h.call(null,b)}function Pa(a){a=this;return a.h.l?a.h.l():a.h.call(null)}var I=null,I=function(I,qa,ta,va,xa,Ca,Ga,Ka,Oa,Sa,Ya,gb,ob,Ab,Wb,jc,zc,Zc,Gd,De,Wf,dh){switch(arguments.length){case 1:return Pa.call(this,I);case 2:return ra.call(this,I,qa);case 3:return Y.call(this,I,qa,ta);case 4:return N.call(this,I,qa,ta,va);case 5:return E.call(this,I,qa,ta,va,xa);case 6:return B.call(this,I,qa,ta,va,xa,Ca);case 7:return y.call(this,
I,qa,ta,va,xa,Ca,Ga);case 8:return v.call(this,I,qa,ta,va,xa,Ca,Ga,Ka);case 9:return u.call(this,I,qa,ta,va,xa,Ca,Ga,Ka,Oa);case 10:return s.call(this,I,qa,ta,va,xa,Ca,Ga,Ka,Oa,Sa);case 11:return q.call(this,I,qa,ta,va,xa,Ca,Ga,Ka,Oa,Sa,Ya);case 12:return p.call(this,I,qa,ta,va,xa,Ca,Ga,Ka,Oa,Sa,Ya,gb);case 13:return m.call(this,I,qa,ta,va,xa,Ca,Ga,Ka,Oa,Sa,Ya,gb,ob);case 14:return l.call(this,I,qa,ta,va,xa,Ca,Ga,Ka,Oa,Sa,Ya,gb,ob,Ab);case 15:return h.call(this,I,qa,ta,va,xa,Ca,Ga,Ka,Oa,Sa,Ya,gb,
ob,Ab,Wb);case 16:return g.call(this,I,qa,ta,va,xa,Ca,Ga,Ka,Oa,Sa,Ya,gb,ob,Ab,Wb,jc);case 17:return f.call(this,I,qa,ta,va,xa,Ca,Ga,Ka,Oa,Sa,Ya,gb,ob,Ab,Wb,jc,zc);case 18:return e.call(this,I,qa,ta,va,xa,Ca,Ga,Ka,Oa,Sa,Ya,gb,ob,Ab,Wb,jc,zc,Zc);case 19:return d.call(this,I,qa,ta,va,xa,Ca,Ga,Ka,Oa,Sa,Ya,gb,ob,Ab,Wb,jc,zc,Zc,Gd);case 20:return c.call(this,I,qa,ta,va,xa,Ca,Ga,Ka,Oa,Sa,Ya,gb,ob,Ab,Wb,jc,zc,Zc,Gd,De);case 21:return b.call(this,I,qa,ta,va,xa,Ca,Ga,Ka,Oa,Sa,Ya,gb,ob,Ab,Wb,jc,zc,Zc,Gd,De,
Wf);case 22:return a.call(this,I,qa,ta,va,xa,Ca,Ga,Ka,Oa,Sa,Ya,gb,ob,Ab,Wb,jc,zc,Zc,Gd,De,Wf,dh)}throw Error("Invalid arity: "+arguments.length);};I.b=Pa;I.a=ra;I.c=Y;I.n=N;I.r=E;I.P=B;I.ia=y;I.Ga=v;I.Ha=u;I.va=s;I.wa=q;I.xa=p;I.ya=m;I.za=l;I.Aa=h;I.Ba=g;I.Ca=f;I.Da=e;I.Ea=d;I.Fa=c;I.hc=b;I.ub=a;return I}();k.apply=function(a,b){return this.call.apply(this,[this].concat(Fa(b)))};k.l=function(){return this.h.l?this.h.l():this.h.call(null)};
k.b=function(a){return this.h.b?this.h.b(a):this.h.call(null,a)};k.a=function(a,b){return this.h.a?this.h.a(a,b):this.h.call(null,a,b)};k.c=function(a,b,c){return this.h.c?this.h.c(a,b,c):this.h.call(null,a,b,c)};k.n=function(a,b,c,d){return this.h.n?this.h.n(a,b,c,d):this.h.call(null,a,b,c,d)};k.r=function(a,b,c,d,e){return this.h.r?this.h.r(a,b,c,d,e):this.h.call(null,a,b,c,d,e)};k.P=function(a,b,c,d,e,f){return this.h.P?this.h.P(a,b,c,d,e,f):this.h.call(null,a,b,c,d,e,f)};
k.ia=function(a,b,c,d,e,f,g){return this.h.ia?this.h.ia(a,b,c,d,e,f,g):this.h.call(null,a,b,c,d,e,f,g)};k.Ga=function(a,b,c,d,e,f,g,h){return this.h.Ga?this.h.Ga(a,b,c,d,e,f,g,h):this.h.call(null,a,b,c,d,e,f,g,h)};k.Ha=function(a,b,c,d,e,f,g,h,l){return this.h.Ha?this.h.Ha(a,b,c,d,e,f,g,h,l):this.h.call(null,a,b,c,d,e,f,g,h,l)};k.va=function(a,b,c,d,e,f,g,h,l,m){return this.h.va?this.h.va(a,b,c,d,e,f,g,h,l,m):this.h.call(null,a,b,c,d,e,f,g,h,l,m)};
k.wa=function(a,b,c,d,e,f,g,h,l,m,p){return this.h.wa?this.h.wa(a,b,c,d,e,f,g,h,l,m,p):this.h.call(null,a,b,c,d,e,f,g,h,l,m,p)};k.xa=function(a,b,c,d,e,f,g,h,l,m,p,q){return this.h.xa?this.h.xa(a,b,c,d,e,f,g,h,l,m,p,q):this.h.call(null,a,b,c,d,e,f,g,h,l,m,p,q)};k.ya=function(a,b,c,d,e,f,g,h,l,m,p,q,s){return this.h.ya?this.h.ya(a,b,c,d,e,f,g,h,l,m,p,q,s):this.h.call(null,a,b,c,d,e,f,g,h,l,m,p,q,s)};
k.za=function(a,b,c,d,e,f,g,h,l,m,p,q,s,u){return this.h.za?this.h.za(a,b,c,d,e,f,g,h,l,m,p,q,s,u):this.h.call(null,a,b,c,d,e,f,g,h,l,m,p,q,s,u)};k.Aa=function(a,b,c,d,e,f,g,h,l,m,p,q,s,u,v){return this.h.Aa?this.h.Aa(a,b,c,d,e,f,g,h,l,m,p,q,s,u,v):this.h.call(null,a,b,c,d,e,f,g,h,l,m,p,q,s,u,v)};k.Ba=function(a,b,c,d,e,f,g,h,l,m,p,q,s,u,v,y){return this.h.Ba?this.h.Ba(a,b,c,d,e,f,g,h,l,m,p,q,s,u,v,y):this.h.call(null,a,b,c,d,e,f,g,h,l,m,p,q,s,u,v,y)};
k.Ca=function(a,b,c,d,e,f,g,h,l,m,p,q,s,u,v,y,B){return this.h.Ca?this.h.Ca(a,b,c,d,e,f,g,h,l,m,p,q,s,u,v,y,B):this.h.call(null,a,b,c,d,e,f,g,h,l,m,p,q,s,u,v,y,B)};k.Da=function(a,b,c,d,e,f,g,h,l,m,p,q,s,u,v,y,B,E){return this.h.Da?this.h.Da(a,b,c,d,e,f,g,h,l,m,p,q,s,u,v,y,B,E):this.h.call(null,a,b,c,d,e,f,g,h,l,m,p,q,s,u,v,y,B,E)};
k.Ea=function(a,b,c,d,e,f,g,h,l,m,p,q,s,u,v,y,B,E,N){return this.h.Ea?this.h.Ea(a,b,c,d,e,f,g,h,l,m,p,q,s,u,v,y,B,E,N):this.h.call(null,a,b,c,d,e,f,g,h,l,m,p,q,s,u,v,y,B,E,N)};k.Fa=function(a,b,c,d,e,f,g,h,l,m,p,q,s,u,v,y,B,E,N,Y){return this.h.Fa?this.h.Fa(a,b,c,d,e,f,g,h,l,m,p,q,s,u,v,y,B,E,N,Y):this.h.call(null,a,b,c,d,e,f,g,h,l,m,p,q,s,u,v,y,B,E,N,Y)};
k.hc=function(a,b,c,d,e,f,g,h,l,m,p,q,s,u,v,y,B,E,N,Y,ra){var Pa=this.h;return T.ub?T.ub(Pa,a,b,c,d,e,f,g,h,l,m,p,q,s,u,v,y,B,E,N,Y,ra):T.call(null,Pa,a,b,c,d,e,f,g,h,l,m,p,q,s,u,v,y,B,E,N,Y,ra)};k.bc=!0;k.F=function(a,b){return new Uc(this.h,b)};k.H=function(){return this.k};function O(a,b){return Tc(a)&&!(a?a.j&262144||a.Bc||(a.j?0:w(tb,a)):w(tb,a))?new Uc(a,b):null==a?null:ub(a,b)}function Vc(a){var b=null!=a;return(b?a?a.j&131072||a.kc||(a.j?0:w(rb,a)):w(rb,a):b)?sb(a):null}
function Wc(a){return null==a?null:lb(a)}
var Xc=function(){function a(a,b){return null==a?null:kb(a,b)}var b=null,c=function(){function a(b,d,h){var l=null;if(2<arguments.length){for(var l=0,m=Array(arguments.length-2);l<m.length;)m[l]=arguments[l+2],++l;l=new F(m,0)}return c.call(this,b,d,l)}function c(a,d,e){for(;;){if(null==a)return null;a=b.a(a,d);if(t(e))d=G(e),e=K(e);else return a}}a.i=2;a.f=function(a){var b=G(a);a=K(a);var d=G(a);a=H(a);return c(b,d,a)};a.d=c;return a}(),b=function(b,e,f){switch(arguments.length){case 1:return b;case 2:return a.call(this,
b,e);default:var g=null;if(2<arguments.length){for(var g=0,h=Array(arguments.length-2);g<h.length;)h[g]=arguments[g+2],++g;g=new F(h,0)}return c.d(b,e,g)}throw Error("Invalid arity: "+arguments.length);};b.i=2;b.f=c.f;b.b=function(a){return a};b.a=a;b.d=c.d;return b}();function Yc(a){return null==a||Aa(D(a))}function $c(a){return null==a?!1:a?a.j&8||a.tc?!0:a.j?!1:w(Qa,a):w(Qa,a)}function ad(a){return null==a?!1:a?a.j&4096||a.zc?!0:a.j?!1:w(jb,a):w(jb,a)}
function bd(a){return a?a.j&512||a.rc?!0:a.j?!1:w(ab,a):w(ab,a)}function cd(a){return a?a.j&16777216||a.yc?!0:a.j?!1:w(Db,a):w(Db,a)}function dd(a){return null==a?!1:a?a.j&1024||a.ic?!0:a.j?!1:w(db,a):w(db,a)}function ed(a){return a?a.j&16384||a.Ac?!0:a.j?!1:w(nb,a):w(nb,a)}function fd(a){return a?a.q&512||a.sc?!0:!1:!1}function gd(a){var b=[];ea(a,function(a,b){return function(a,c){return b.push(c)}}(a,b));return b}function hd(a,b,c,d,e){for(;0!==e;)c[d]=a[b],d+=1,e-=1,b+=1}
function id(a,b,c,d,e){b+=e-1;for(d+=e-1;0!==e;)c[d]=a[b],d-=1,e-=1,b-=1}var jd={};function kd(a){return null==a?!1:a?a.j&64||a.jb?!0:a.j?!1:w(Ua,a):w(Ua,a)}function ld(a){return a?a.j&8388608||a.mc?!0:a.j?!1:w(Bb,a):w(Bb,a)}function md(a){return t(a)?!0:!1}function nd(a,b){return S.c(a,b,jd)===jd?!1:!0}
function od(a,b){if(a===b)return 0;if(null==a)return-1;if(null==b)return 1;if(Ba(a)===Ba(b))return a&&(a.q&2048||a.sb)?a.tb(null,b):ha(a,b);throw Error("compare on non-nil objects of different types");}
var pd=function(){function a(a,b,c,g){for(;;){var h=od(R.a(a,g),R.a(b,g));if(0===h&&g+1<c)g+=1;else return h}}function b(a,b){var f=Q(a),g=Q(b);return f<g?-1:f>g?1:c.n(a,b,f,0)}var c=null,c=function(c,e,f,g){switch(arguments.length){case 2:return b.call(this,c,e);case 4:return a.call(this,c,e,f,g)}throw Error("Invalid arity: "+arguments.length);};c.a=b;c.n=a;return c}();
function qd(a){return sc.a(a,od)?od:function(b,c){var d=a.a?a.a(b,c):a.call(null,b,c);return"number"===typeof d?d:t(d)?-1:t(a.a?a.a(c,b):a.call(null,c,b))?1:0}}
var sd=function(){function a(a,b){if(D(b)){var c=rd.b?rd.b(b):rd.call(null,b),g=qd(a);ia(c,g);return D(c)}return J}function b(a){return c.a(od,a)}var c=null,c=function(c,e){switch(arguments.length){case 1:return b.call(this,c);case 2:return a.call(this,c,e)}throw Error("Invalid arity: "+arguments.length);};c.b=b;c.a=a;return c}(),td=function(){function a(a,b,c){return sd.a(function(c,f){return qd(b).call(null,a.b?a.b(c):a.call(null,c),a.b?a.b(f):a.call(null,f))},c)}function b(a,b){return c.c(a,od,
b)}var c=null,c=function(c,e,f){switch(arguments.length){case 2:return b.call(this,c,e);case 3:return a.call(this,c,e,f)}throw Error("Invalid arity: "+arguments.length);};c.a=b;c.c=a;return c}(),P=function(){function a(a,b,c){for(c=D(c);;)if(c){var g=G(c);b=a.a?a.a(b,g):a.call(null,b,g);if(Ac(b))return qb(b);c=K(c)}else return b}function b(a,b){var c=D(b);if(c){var g=G(c),c=K(c);return A.c?A.c(a,g,c):A.call(null,a,g,c)}return a.l?a.l():a.call(null)}var c=null,c=function(c,e,f){switch(arguments.length){case 2:return b.call(this,
c,e);case 3:return a.call(this,c,e,f)}throw Error("Invalid arity: "+arguments.length);};c.a=b;c.c=a;return c}(),A=function(){function a(a,b,c){return c&&(c.j&524288||c.Sb)?c.O(null,a,b):c instanceof Array?Dc.c(c,a,b):"string"===typeof c?Dc.c(c,a,b):w(vb,c)?wb.c(c,a,b):P.c(a,b,c)}function b(a,b){return b&&(b.j&524288||b.Sb)?b.R(null,a):b instanceof Array?Dc.a(b,a):"string"===typeof b?Dc.a(b,a):w(vb,b)?wb.a(b,a):P.a(a,b)}var c=null,c=function(c,e,f){switch(arguments.length){case 2:return b.call(this,
c,e);case 3:return a.call(this,c,e,f)}throw Error("Invalid arity: "+arguments.length);};c.a=b;c.c=a;return c}();function ud(a){return a}
var vd=function(){function a(a,b){return function(){function c(b,e){return a.a?a.a(b,e):a.call(null,b,e)}function g(a){return b.b?b.b(a):b.call(null,a)}function h(){return a.l?a.l():a.call(null)}var l=null,l=function(a,b){switch(arguments.length){case 0:return h.call(this);case 1:return g.call(this,a);case 2:return c.call(this,a,b)}throw Error("Invalid arity: "+arguments.length);};l.l=h;l.b=g;l.a=c;return l}()}function b(a){return c.a(a,ud)}var c=null,c=function(c,e){switch(arguments.length){case 1:return b.call(this,
c);case 2:return a.call(this,c,e)}throw Error("Invalid arity: "+arguments.length);};c.b=b;c.a=a;return c}(),wd=function(){function a(a,b,c,g){a=a.b?a.b(b):a.call(null,b);c=A.c(a,c,g);return a.b?a.b(c):a.call(null,c)}function b(a,b,f){return c.n(a,b,b.l?b.l():b.call(null),f)}var c=null,c=function(c,e,f,g){switch(arguments.length){case 3:return b.call(this,c,e,f);case 4:return a.call(this,c,e,f,g)}throw Error("Invalid arity: "+arguments.length);};c.c=b;c.n=a;return c}(),xd=function(){var a=null,b=function(){function b(a,
c,g){var h=null;if(2<arguments.length){for(var h=0,l=Array(arguments.length-2);h<l.length;)l[h]=arguments[h+2],++h;h=new F(l,0)}return d.call(this,a,c,h)}function d(b,c,d){return A.c(a,b+c,d)}b.i=2;b.f=function(a){var b=G(a);a=K(a);var c=G(a);a=H(a);return d(b,c,a)};b.d=d;return b}(),a=function(a,d,e){switch(arguments.length){case 0:return 0;case 1:return a;case 2:return a+d;default:var f=null;if(2<arguments.length){for(var f=0,g=Array(arguments.length-2);f<g.length;)g[f]=arguments[f+2],++f;f=new F(g,
0)}return b.d(a,d,f)}throw Error("Invalid arity: "+arguments.length);};a.i=2;a.f=b.f;a.l=function(){return 0};a.b=function(a){return a};a.a=function(a,b){return a+b};a.d=b.d;return a}(),yd=function(){var a=null,b=function(){function a(c,f,g){var h=null;if(2<arguments.length){for(var h=0,l=Array(arguments.length-2);h<l.length;)l[h]=arguments[h+2],++h;h=new F(l,0)}return b.call(this,c,f,h)}function b(a,c,d){for(;;)if(a<c)if(K(d))a=c,c=G(d),d=K(d);else return c<G(d);else return!1}a.i=2;a.f=function(a){var c=
G(a);a=K(a);var g=G(a);a=H(a);return b(c,g,a)};a.d=b;return a}(),a=function(a,d,e){switch(arguments.length){case 1:return!0;case 2:return a<d;default:var f=null;if(2<arguments.length){for(var f=0,g=Array(arguments.length-2);f<g.length;)g[f]=arguments[f+2],++f;f=new F(g,0)}return b.d(a,d,f)}throw Error("Invalid arity: "+arguments.length);};a.i=2;a.f=b.f;a.b=function(){return!0};a.a=function(a,b){return a<b};a.d=b.d;return a}(),zd=function(){var a=null,b=function(){function a(c,f,g){var h=null;if(2<
arguments.length){for(var h=0,l=Array(arguments.length-2);h<l.length;)l[h]=arguments[h+2],++h;h=new F(l,0)}return b.call(this,c,f,h)}function b(a,c,d){for(;;)if(a<=c)if(K(d))a=c,c=G(d),d=K(d);else return c<=G(d);else return!1}a.i=2;a.f=function(a){var c=G(a);a=K(a);var g=G(a);a=H(a);return b(c,g,a)};a.d=b;return a}(),a=function(a,d,e){switch(arguments.length){case 1:return!0;case 2:return a<=d;default:var f=null;if(2<arguments.length){for(var f=0,g=Array(arguments.length-2);f<g.length;)g[f]=arguments[f+
2],++f;f=new F(g,0)}return b.d(a,d,f)}throw Error("Invalid arity: "+arguments.length);};a.i=2;a.f=b.f;a.b=function(){return!0};a.a=function(a,b){return a<=b};a.d=b.d;return a}(),Ad=function(){var a=null,b=function(){function a(c,f,g){var h=null;if(2<arguments.length){for(var h=0,l=Array(arguments.length-2);h<l.length;)l[h]=arguments[h+2],++h;h=new F(l,0)}return b.call(this,c,f,h)}function b(a,c,d){for(;;)if(a>c)if(K(d))a=c,c=G(d),d=K(d);else return c>G(d);else return!1}a.i=2;a.f=function(a){var c=
G(a);a=K(a);var g=G(a);a=H(a);return b(c,g,a)};a.d=b;return a}(),a=function(a,d,e){switch(arguments.length){case 1:return!0;case 2:return a>d;default:var f=null;if(2<arguments.length){for(var f=0,g=Array(arguments.length-2);f<g.length;)g[f]=arguments[f+2],++f;f=new F(g,0)}return b.d(a,d,f)}throw Error("Invalid arity: "+arguments.length);};a.i=2;a.f=b.f;a.b=function(){return!0};a.a=function(a,b){return a>b};a.d=b.d;return a}(),Bd=function(){var a=null,b=function(){function a(c,f,g){var h=null;if(2<
arguments.length){for(var h=0,l=Array(arguments.length-2);h<l.length;)l[h]=arguments[h+2],++h;h=new F(l,0)}return b.call(this,c,f,h)}function b(a,c,d){for(;;)if(a>=c)if(K(d))a=c,c=G(d),d=K(d);else return c>=G(d);else return!1}a.i=2;a.f=function(a){var c=G(a);a=K(a);var g=G(a);a=H(a);return b(c,g,a)};a.d=b;return a}(),a=function(a,d,e){switch(arguments.length){case 1:return!0;case 2:return a>=d;default:var f=null;if(2<arguments.length){for(var f=0,g=Array(arguments.length-2);f<g.length;)g[f]=arguments[f+
2],++f;f=new F(g,0)}return b.d(a,d,f)}throw Error("Invalid arity: "+arguments.length);};a.i=2;a.f=b.f;a.b=function(){return!0};a.a=function(a,b){return a>=b};a.d=b.d;return a}();function Cd(a,b){var c=(a-a%b)/b;return 0<=c?Math.floor.b?Math.floor.b(c):Math.floor.call(null,c):Math.ceil.b?Math.ceil.b(c):Math.ceil.call(null,c)}function Dd(a){a-=a>>1&1431655765;a=(a&858993459)+(a>>2&858993459);return 16843009*(a+(a>>4)&252645135)>>24}
function Ed(a){var b=1;for(a=D(a);;)if(a&&0<b)b-=1,a=K(a);else return a}
var z=function(){function a(a){return null==a?"":da(a)}var b=null,c=function(){function a(b,d){var h=null;if(1<arguments.length){for(var h=0,l=Array(arguments.length-1);h<l.length;)l[h]=arguments[h+1],++h;h=new F(l,0)}return c.call(this,b,h)}function c(a,d){for(var e=new fa(b.b(a)),l=d;;)if(t(l))e=e.append(b.b(G(l))),l=K(l);else return e.toString()}a.i=1;a.f=function(a){var b=G(a);a=H(a);return c(b,a)};a.d=c;return a}(),b=function(b,e){switch(arguments.length){case 0:return"";case 1:return a.call(this,
b);default:var f=null;if(1<arguments.length){for(var f=0,g=Array(arguments.length-1);f<g.length;)g[f]=arguments[f+1],++f;f=new F(g,0)}return c.d(b,f)}throw Error("Invalid arity: "+arguments.length);};b.i=1;b.f=c.f;b.l=function(){return""};b.b=a;b.d=c.d;return b}();function Ic(a,b){var c;if(cd(b))if(Ec(a)&&Ec(b)&&Q(a)!==Q(b))c=!1;else a:{c=D(a);for(var d=D(b);;){if(null==c){c=null==d;break a}if(null!=d&&sc.a(G(c),G(d)))c=K(c),d=K(d);else{c=!1;break a}}c=void 0}else c=null;return md(c)}
function Fd(a,b,c,d,e){this.k=a;this.first=b;this.M=c;this.count=d;this.p=e;this.j=65937646;this.q=8192}k=Fd.prototype;k.toString=function(){return ec(this)};k.H=function(){return this.k};k.T=function(){return 1===this.count?null:this.M};k.L=function(){return this.count};k.La=function(){return this.first};k.Ma=function(){return Wa(this)};k.B=function(){var a=this.p;return null!=a?a:this.p=a=wc(this)};k.A=function(a,b){return Ic(this,b)};k.J=function(){return ub(J,this.k)};
k.R=function(a,b){return P.a(b,this)};k.O=function(a,b,c){return P.c(b,c,this)};k.N=function(){return this.first};k.S=function(){return 1===this.count?J:this.M};k.D=function(){return this};k.F=function(a,b){return new Fd(b,this.first,this.M,this.count,this.p)};k.G=function(a,b){return new Fd(this.k,b,this,this.count+1,null)};Fd.prototype[Ea]=function(){return uc(this)};function Hd(a){this.k=a;this.j=65937614;this.q=8192}k=Hd.prototype;k.toString=function(){return ec(this)};k.H=function(){return this.k};
k.T=function(){return null};k.L=function(){return 0};k.La=function(){return null};k.Ma=function(){throw Error("Can't pop empty list");};k.B=function(){return 0};k.A=function(a,b){return Ic(this,b)};k.J=function(){return this};k.R=function(a,b){return P.a(b,this)};k.O=function(a,b,c){return P.c(b,c,this)};k.N=function(){return null};k.S=function(){return J};k.D=function(){return null};k.F=function(a,b){return new Hd(b)};k.G=function(a,b){return new Fd(this.k,b,null,1,null)};var J=new Hd(null);
Hd.prototype[Ea]=function(){return uc(this)};function Id(a){return a?a.j&134217728||a.xc?!0:a.j?!1:w(Fb,a):w(Fb,a)}function Jd(a){return Id(a)?Gb(a):A.c(Nc,J,a)}
var Kd=function(){function a(a){var d=null;if(0<arguments.length){for(var d=0,e=Array(arguments.length-0);d<e.length;)e[d]=arguments[d+0],++d;d=new F(e,0)}return b.call(this,d)}function b(a){var b;if(a instanceof F&&0===a.m)b=a.e;else a:{for(b=[];;)if(null!=a)b.push(a.N(null)),a=a.T(null);else break a;b=void 0}a=b.length;for(var e=J;;)if(0<a){var f=a-1,e=e.G(null,b[a-1]);a=f}else return e}a.i=0;a.f=function(a){a=D(a);return b(a)};a.d=b;return a}();
function Ld(a,b,c,d){this.k=a;this.first=b;this.M=c;this.p=d;this.j=65929452;this.q=8192}k=Ld.prototype;k.toString=function(){return ec(this)};k.H=function(){return this.k};k.T=function(){return null==this.M?null:D(this.M)};k.B=function(){var a=this.p;return null!=a?a:this.p=a=wc(this)};k.A=function(a,b){return Ic(this,b)};k.J=function(){return O(J,this.k)};k.R=function(a,b){return P.a(b,this)};k.O=function(a,b,c){return P.c(b,c,this)};k.N=function(){return this.first};
k.S=function(){return null==this.M?J:this.M};k.D=function(){return this};k.F=function(a,b){return new Ld(b,this.first,this.M,this.p)};k.G=function(a,b){return new Ld(null,b,this,this.p)};Ld.prototype[Ea]=function(){return uc(this)};function M(a,b){var c=null==b;return(c?c:b&&(b.j&64||b.jb))?new Ld(null,a,b,null):new Ld(null,a,D(b),null)}
function Md(a,b){if(a.pa===b.pa)return 0;var c=Aa(a.ba);if(t(c?b.ba:c))return-1;if(t(a.ba)){if(Aa(b.ba))return 1;c=ha(a.ba,b.ba);return 0===c?ha(a.name,b.name):c}return ha(a.name,b.name)}function U(a,b,c,d){this.ba=a;this.name=b;this.pa=c;this.Ya=d;this.j=2153775105;this.q=4096}k=U.prototype;k.v=function(a,b){return Lb(b,[z(":"),z(this.pa)].join(""))};k.B=function(){var a=this.Ya;return null!=a?a:this.Ya=a=oc(this)+2654435769|0};
k.call=function(){var a=null,a=function(a,c,d){switch(arguments.length){case 2:return S.a(c,this);case 3:return S.c(c,this,d)}throw Error("Invalid arity: "+arguments.length);};a.a=function(a,c){return S.a(c,this)};a.c=function(a,c,d){return S.c(c,this,d)};return a}();k.apply=function(a,b){return this.call.apply(this,[this].concat(Fa(b)))};k.b=function(a){return S.a(a,this)};k.a=function(a,b){return S.c(a,this,b)};k.A=function(a,b){return b instanceof U?this.pa===b.pa:!1};
k.toString=function(){return[z(":"),z(this.pa)].join("")};function Nd(a,b){return a===b?!0:a instanceof U&&b instanceof U?a.pa===b.pa:!1}
var Pd=function(){function a(a,b){return new U(a,b,[z(t(a)?[z(a),z("/")].join(""):null),z(b)].join(""),null)}function b(a){if(a instanceof U)return a;if(a instanceof qc){var b;if(a&&(a.q&4096||a.lc))b=a.ba;else throw Error([z("Doesn't support namespace: "),z(a)].join(""));return new U(b,Od.b?Od.b(a):Od.call(null,a),a.ta,null)}return"string"===typeof a?(b=a.split("/"),2===b.length?new U(b[0],b[1],a,null):new U(null,b[0],a,null)):null}var c=null,c=function(c,e){switch(arguments.length){case 1:return b.call(this,
c);case 2:return a.call(this,c,e)}throw Error("Invalid arity: "+arguments.length);};c.b=b;c.a=a;return c}();function V(a,b,c,d){this.k=a;this.cb=b;this.C=c;this.p=d;this.q=0;this.j=32374988}k=V.prototype;k.toString=function(){return ec(this)};function Qd(a){null!=a.cb&&(a.C=a.cb.l?a.cb.l():a.cb.call(null),a.cb=null);return a.C}k.H=function(){return this.k};k.T=function(){Cb(this);return null==this.C?null:K(this.C)};k.B=function(){var a=this.p;return null!=a?a:this.p=a=wc(this)};
k.A=function(a,b){return Ic(this,b)};k.J=function(){return O(J,this.k)};k.R=function(a,b){return P.a(b,this)};k.O=function(a,b,c){return P.c(b,c,this)};k.N=function(){Cb(this);return null==this.C?null:G(this.C)};k.S=function(){Cb(this);return null!=this.C?H(this.C):J};k.D=function(){Qd(this);if(null==this.C)return null;for(var a=this.C;;)if(a instanceof V)a=Qd(a);else return this.C=a,D(this.C)};k.F=function(a,b){return new V(b,this.cb,this.C,this.p)};k.G=function(a,b){return M(b,this)};
V.prototype[Ea]=function(){return uc(this)};function Rd(a,b){this.Ab=a;this.end=b;this.q=0;this.j=2}Rd.prototype.L=function(){return this.end};Rd.prototype.add=function(a){this.Ab[this.end]=a;return this.end+=1};Rd.prototype.ca=function(){var a=new Sd(this.Ab,0,this.end);this.Ab=null;return a};function Td(a){return new Rd(Array(a),0)}function Sd(a,b,c){this.e=a;this.V=b;this.end=c;this.q=0;this.j=524306}k=Sd.prototype;k.R=function(a,b){return Dc.n(this.e,b,this.e[this.V],this.V+1)};
k.O=function(a,b,c){return Dc.n(this.e,b,c,this.V)};k.Pb=function(){if(this.V===this.end)throw Error("-drop-first of empty chunk");return new Sd(this.e,this.V+1,this.end)};k.Q=function(a,b){return this.e[this.V+b]};k.$=function(a,b,c){return 0<=b&&b<this.end-this.V?this.e[this.V+b]:c};k.L=function(){return this.end-this.V};
var Ud=function(){function a(a,b,c){return new Sd(a,b,c)}function b(a,b){return new Sd(a,b,a.length)}function c(a){return new Sd(a,0,a.length)}var d=null,d=function(d,f,g){switch(arguments.length){case 1:return c.call(this,d);case 2:return b.call(this,d,f);case 3:return a.call(this,d,f,g)}throw Error("Invalid arity: "+arguments.length);};d.b=c;d.a=b;d.c=a;return d}();function Vd(a,b,c,d){this.ca=a;this.ra=b;this.k=c;this.p=d;this.j=31850732;this.q=1536}k=Vd.prototype;k.toString=function(){return ec(this)};
k.H=function(){return this.k};k.T=function(){if(1<Ma(this.ca))return new Vd(Xb(this.ca),this.ra,this.k,null);var a=Cb(this.ra);return null==a?null:a};k.B=function(){var a=this.p;return null!=a?a:this.p=a=wc(this)};k.A=function(a,b){return Ic(this,b)};k.J=function(){return O(J,this.k)};k.N=function(){return C.a(this.ca,0)};k.S=function(){return 1<Ma(this.ca)?new Vd(Xb(this.ca),this.ra,this.k,null):null==this.ra?J:this.ra};k.D=function(){return this};k.Cb=function(){return this.ca};
k.Db=function(){return null==this.ra?J:this.ra};k.F=function(a,b){return new Vd(this.ca,this.ra,b,this.p)};k.G=function(a,b){return M(b,this)};k.Bb=function(){return null==this.ra?null:this.ra};Vd.prototype[Ea]=function(){return uc(this)};function Wd(a,b){return 0===Ma(a)?b:new Vd(a,b,null,null)}function Xd(a,b){a.add(b)}function rd(a){for(var b=[];;)if(D(a))b.push(G(a)),a=K(a);else return b}function Yd(a,b){if(Ec(a))return Q(a);for(var c=a,d=b,e=0;;)if(0<d&&D(c))c=K(c),d-=1,e+=1;else return e}
var $d=function Zd(b){return null==b?null:null==K(b)?D(G(b)):M(G(b),Zd(K(b)))},ae=function(){function a(a,b){return new V(null,function(){var c=D(a);return c?fd(c)?Wd(Yb(c),d.a(Zb(c),b)):M(G(c),d.a(H(c),b)):b},null,null)}function b(a){return new V(null,function(){return a},null,null)}function c(){return new V(null,function(){return null},null,null)}var d=null,e=function(){function a(c,d,e){var f=null;if(2<arguments.length){for(var f=0,q=Array(arguments.length-2);f<q.length;)q[f]=arguments[f+2],++f;
f=new F(q,0)}return b.call(this,c,d,f)}function b(a,c,e){return function q(a,b){return new V(null,function(){var c=D(a);return c?fd(c)?Wd(Yb(c),q(Zb(c),b)):M(G(c),q(H(c),b)):t(b)?q(G(b),K(b)):null},null,null)}(d.a(a,c),e)}a.i=2;a.f=function(a){var c=G(a);a=K(a);var d=G(a);a=H(a);return b(c,d,a)};a.d=b;return a}(),d=function(d,g,h){switch(arguments.length){case 0:return c.call(this);case 1:return b.call(this,d);case 2:return a.call(this,d,g);default:var l=null;if(2<arguments.length){for(var l=0,m=
Array(arguments.length-2);l<m.length;)m[l]=arguments[l+2],++l;l=new F(m,0)}return e.d(d,g,l)}throw Error("Invalid arity: "+arguments.length);};d.i=2;d.f=e.f;d.l=c;d.b=b;d.a=a;d.d=e.d;return d}(),be=function(){function a(a,b,c,d){return M(a,M(b,M(c,d)))}function b(a,b,c){return M(a,M(b,c))}var c=null,d=function(){function a(c,d,e,m,p){var q=null;if(4<arguments.length){for(var q=0,s=Array(arguments.length-4);q<s.length;)s[q]=arguments[q+4],++q;q=new F(s,0)}return b.call(this,c,d,e,m,q)}function b(a,
c,d,e,f){return M(a,M(c,M(d,M(e,$d(f)))))}a.i=4;a.f=function(a){var c=G(a);a=K(a);var d=G(a);a=K(a);var e=G(a);a=K(a);var p=G(a);a=H(a);return b(c,d,e,p,a)};a.d=b;return a}(),c=function(c,f,g,h,l){switch(arguments.length){case 1:return D(c);case 2:return M(c,f);case 3:return b.call(this,c,f,g);case 4:return a.call(this,c,f,g,h);default:var m=null;if(4<arguments.length){for(var m=0,p=Array(arguments.length-4);m<p.length;)p[m]=arguments[m+4],++m;m=new F(p,0)}return d.d(c,f,g,h,m)}throw Error("Invalid arity: "+
arguments.length);};c.i=4;c.f=d.f;c.b=function(a){return D(a)};c.a=function(a,b){return M(a,b)};c.c=b;c.n=a;c.d=d.d;return c}();function ce(a){return Qb(a)}
var de=function(){function a(){return Ob(Mc)}var b=null,c=function(){function a(c,d,h){var l=null;if(2<arguments.length){for(var l=0,m=Array(arguments.length-2);l<m.length;)m[l]=arguments[l+2],++l;l=new F(m,0)}return b.call(this,c,d,l)}function b(a,c,d){for(;;)if(a=Pb(a,c),t(d))c=G(d),d=K(d);else return a}a.i=2;a.f=function(a){var c=G(a);a=K(a);var d=G(a);a=H(a);return b(c,d,a)};a.d=b;return a}(),b=function(b,e,f){switch(arguments.length){case 0:return a.call(this);case 1:return b;case 2:return Pb(b,
e);default:var g=null;if(2<arguments.length){for(var g=0,h=Array(arguments.length-2);g<h.length;)h[g]=arguments[g+2],++g;g=new F(h,0)}return c.d(b,e,g)}throw Error("Invalid arity: "+arguments.length);};b.i=2;b.f=c.f;b.l=a;b.b=function(a){return a};b.a=function(a,b){return Pb(a,b)};b.d=c.d;return b}(),ee=function(){var a=null,b=function(){function a(c,f,g,h){var l=null;if(3<arguments.length){for(var l=0,m=Array(arguments.length-3);l<m.length;)m[l]=arguments[l+3],++l;l=new F(m,0)}return b.call(this,
c,f,g,l)}function b(a,c,d,h){for(;;)if(a=Rb(a,c,d),t(h))c=G(h),d=Lc(h),h=K(K(h));else return a}a.i=3;a.f=function(a){var c=G(a);a=K(a);var g=G(a);a=K(a);var h=G(a);a=H(a);return b(c,g,h,a)};a.d=b;return a}(),a=function(a,d,e,f){switch(arguments.length){case 3:return Rb(a,d,e);default:var g=null;if(3<arguments.length){for(var g=0,h=Array(arguments.length-3);g<h.length;)h[g]=arguments[g+3],++g;g=new F(h,0)}return b.d(a,d,e,g)}throw Error("Invalid arity: "+arguments.length);};a.i=3;a.f=b.f;a.c=function(a,
b,e){return Rb(a,b,e)};a.d=b.d;return a}(),fe=function(){var a=null,b=function(){function a(c,f,g){var h=null;if(2<arguments.length){for(var h=0,l=Array(arguments.length-2);h<l.length;)l[h]=arguments[h+2],++h;h=new F(l,0)}return b.call(this,c,f,h)}function b(a,c,d){for(;;)if(a=Sb(a,c),t(d))c=G(d),d=K(d);else return a}a.i=2;a.f=function(a){var c=G(a);a=K(a);var g=G(a);a=H(a);return b(c,g,a)};a.d=b;return a}(),a=function(a,d,e){switch(arguments.length){case 2:return Sb(a,d);default:var f=null;if(2<
arguments.length){for(var f=0,g=Array(arguments.length-2);f<g.length;)g[f]=arguments[f+2],++f;f=new F(g,0)}return b.d(a,d,f)}throw Error("Invalid arity: "+arguments.length);};a.i=2;a.f=b.f;a.a=function(a,b){return Sb(a,b)};a.d=b.d;return a}(),ge=function(){var a=null,b=function(){function a(c,f,g){var h=null;if(2<arguments.length){for(var h=0,l=Array(arguments.length-2);h<l.length;)l[h]=arguments[h+2],++h;h=new F(l,0)}return b.call(this,c,f,h)}function b(a,c,d){for(;;)if(a=Vb(a,c),t(d))c=G(d),d=K(d);
else return a}a.i=2;a.f=function(a){var c=G(a);a=K(a);var g=G(a);a=H(a);return b(c,g,a)};a.d=b;return a}(),a=function(a,d,e){switch(arguments.length){case 2:return Vb(a,d);default:var f=null;if(2<arguments.length){for(var f=0,g=Array(arguments.length-2);f<g.length;)g[f]=arguments[f+2],++f;f=new F(g,0)}return b.d(a,d,f)}throw Error("Invalid arity: "+arguments.length);};a.i=2;a.f=b.f;a.a=function(a,b){return Vb(a,b)};a.d=b.d;return a}();
function he(a,b,c){var d=D(c);if(0===b)return a.l?a.l():a.call(null);c=Va(d);var e=Wa(d);if(1===b)return a.b?a.b(c):a.b?a.b(c):a.call(null,c);var d=Va(e),f=Wa(e);if(2===b)return a.a?a.a(c,d):a.a?a.a(c,d):a.call(null,c,d);var e=Va(f),g=Wa(f);if(3===b)return a.c?a.c(c,d,e):a.c?a.c(c,d,e):a.call(null,c,d,e);var f=Va(g),h=Wa(g);if(4===b)return a.n?a.n(c,d,e,f):a.n?a.n(c,d,e,f):a.call(null,c,d,e,f);var g=Va(h),l=Wa(h);if(5===b)return a.r?a.r(c,d,e,f,g):a.r?a.r(c,d,e,f,g):a.call(null,c,d,e,f,g);var h=Va(l),
m=Wa(l);if(6===b)return a.P?a.P(c,d,e,f,g,h):a.P?a.P(c,d,e,f,g,h):a.call(null,c,d,e,f,g,h);var l=Va(m),p=Wa(m);if(7===b)return a.ia?a.ia(c,d,e,f,g,h,l):a.ia?a.ia(c,d,e,f,g,h,l):a.call(null,c,d,e,f,g,h,l);var m=Va(p),q=Wa(p);if(8===b)return a.Ga?a.Ga(c,d,e,f,g,h,l,m):a.Ga?a.Ga(c,d,e,f,g,h,l,m):a.call(null,c,d,e,f,g,h,l,m);var p=Va(q),s=Wa(q);if(9===b)return a.Ha?a.Ha(c,d,e,f,g,h,l,m,p):a.Ha?a.Ha(c,d,e,f,g,h,l,m,p):a.call(null,c,d,e,f,g,h,l,m,p);var q=Va(s),u=Wa(s);if(10===b)return a.va?a.va(c,d,e,
f,g,h,l,m,p,q):a.va?a.va(c,d,e,f,g,h,l,m,p,q):a.call(null,c,d,e,f,g,h,l,m,p,q);var s=Va(u),v=Wa(u);if(11===b)return a.wa?a.wa(c,d,e,f,g,h,l,m,p,q,s):a.wa?a.wa(c,d,e,f,g,h,l,m,p,q,s):a.call(null,c,d,e,f,g,h,l,m,p,q,s);var u=Va(v),y=Wa(v);if(12===b)return a.xa?a.xa(c,d,e,f,g,h,l,m,p,q,s,u):a.xa?a.xa(c,d,e,f,g,h,l,m,p,q,s,u):a.call(null,c,d,e,f,g,h,l,m,p,q,s,u);var v=Va(y),B=Wa(y);if(13===b)return a.ya?a.ya(c,d,e,f,g,h,l,m,p,q,s,u,v):a.ya?a.ya(c,d,e,f,g,h,l,m,p,q,s,u,v):a.call(null,c,d,e,f,g,h,l,m,p,
q,s,u,v);var y=Va(B),E=Wa(B);if(14===b)return a.za?a.za(c,d,e,f,g,h,l,m,p,q,s,u,v,y):a.za?a.za(c,d,e,f,g,h,l,m,p,q,s,u,v,y):a.call(null,c,d,e,f,g,h,l,m,p,q,s,u,v,y);var B=Va(E),N=Wa(E);if(15===b)return a.Aa?a.Aa(c,d,e,f,g,h,l,m,p,q,s,u,v,y,B):a.Aa?a.Aa(c,d,e,f,g,h,l,m,p,q,s,u,v,y,B):a.call(null,c,d,e,f,g,h,l,m,p,q,s,u,v,y,B);var E=Va(N),Y=Wa(N);if(16===b)return a.Ba?a.Ba(c,d,e,f,g,h,l,m,p,q,s,u,v,y,B,E):a.Ba?a.Ba(c,d,e,f,g,h,l,m,p,q,s,u,v,y,B,E):a.call(null,c,d,e,f,g,h,l,m,p,q,s,u,v,y,B,E);var N=
Va(Y),ra=Wa(Y);if(17===b)return a.Ca?a.Ca(c,d,e,f,g,h,l,m,p,q,s,u,v,y,B,E,N):a.Ca?a.Ca(c,d,e,f,g,h,l,m,p,q,s,u,v,y,B,E,N):a.call(null,c,d,e,f,g,h,l,m,p,q,s,u,v,y,B,E,N);var Y=Va(ra),Pa=Wa(ra);if(18===b)return a.Da?a.Da(c,d,e,f,g,h,l,m,p,q,s,u,v,y,B,E,N,Y):a.Da?a.Da(c,d,e,f,g,h,l,m,p,q,s,u,v,y,B,E,N,Y):a.call(null,c,d,e,f,g,h,l,m,p,q,s,u,v,y,B,E,N,Y);ra=Va(Pa);Pa=Wa(Pa);if(19===b)return a.Ea?a.Ea(c,d,e,f,g,h,l,m,p,q,s,u,v,y,B,E,N,Y,ra):a.Ea?a.Ea(c,d,e,f,g,h,l,m,p,q,s,u,v,y,B,E,N,Y,ra):a.call(null,
c,d,e,f,g,h,l,m,p,q,s,u,v,y,B,E,N,Y,ra);var I=Va(Pa);Wa(Pa);if(20===b)return a.Fa?a.Fa(c,d,e,f,g,h,l,m,p,q,s,u,v,y,B,E,N,Y,ra,I):a.Fa?a.Fa(c,d,e,f,g,h,l,m,p,q,s,u,v,y,B,E,N,Y,ra,I):a.call(null,c,d,e,f,g,h,l,m,p,q,s,u,v,y,B,E,N,Y,ra,I);throw Error("Only up to 20 arguments supported on functions");}
var T=function(){function a(a,b,c,d,e){b=be.n(b,c,d,e);c=a.i;return a.f?(d=Yd(b,c+1),d<=c?he(a,d,b):a.f(b)):a.apply(a,rd(b))}function b(a,b,c,d){b=be.c(b,c,d);c=a.i;return a.f?(d=Yd(b,c+1),d<=c?he(a,d,b):a.f(b)):a.apply(a,rd(b))}function c(a,b,c){b=be.a(b,c);c=a.i;if(a.f){var d=Yd(b,c+1);return d<=c?he(a,d,b):a.f(b)}return a.apply(a,rd(b))}function d(a,b){var c=a.i;if(a.f){var d=Yd(b,c+1);return d<=c?he(a,d,b):a.f(b)}return a.apply(a,rd(b))}var e=null,f=function(){function a(c,d,e,f,g,u){var v=null;
if(5<arguments.length){for(var v=0,y=Array(arguments.length-5);v<y.length;)y[v]=arguments[v+5],++v;v=new F(y,0)}return b.call(this,c,d,e,f,g,v)}function b(a,c,d,e,f,g){c=M(c,M(d,M(e,M(f,$d(g)))));d=a.i;return a.f?(e=Yd(c,d+1),e<=d?he(a,e,c):a.f(c)):a.apply(a,rd(c))}a.i=5;a.f=function(a){var c=G(a);a=K(a);var d=G(a);a=K(a);var e=G(a);a=K(a);var f=G(a);a=K(a);var g=G(a);a=H(a);return b(c,d,e,f,g,a)};a.d=b;return a}(),e=function(e,h,l,m,p,q){switch(arguments.length){case 2:return d.call(this,e,h);case 3:return c.call(this,
e,h,l);case 4:return b.call(this,e,h,l,m);case 5:return a.call(this,e,h,l,m,p);default:var s=null;if(5<arguments.length){for(var s=0,u=Array(arguments.length-5);s<u.length;)u[s]=arguments[s+5],++s;s=new F(u,0)}return f.d(e,h,l,m,p,s)}throw Error("Invalid arity: "+arguments.length);};e.i=5;e.f=f.f;e.a=d;e.c=c;e.n=b;e.r=a;e.d=f.d;return e}(),ie=function(){function a(a,b,c,d,e,f){var g=O,v=Vc(a);b=b.r?b.r(v,c,d,e,f):b.call(null,v,c,d,e,f);return g(a,b)}function b(a,b,c,d,e){var f=O,g=Vc(a);b=b.n?b.n(g,
c,d,e):b.call(null,g,c,d,e);return f(a,b)}function c(a,b,c,d){var e=O,f=Vc(a);b=b.c?b.c(f,c,d):b.call(null,f,c,d);return e(a,b)}function d(a,b,c){var d=O,e=Vc(a);b=b.a?b.a(e,c):b.call(null,e,c);return d(a,b)}function e(a,b){var c=O,d;d=Vc(a);d=b.b?b.b(d):b.call(null,d);return c(a,d)}var f=null,g=function(){function a(c,d,e,f,g,h,y){var B=null;if(6<arguments.length){for(var B=0,E=Array(arguments.length-6);B<E.length;)E[B]=arguments[B+6],++B;B=new F(E,0)}return b.call(this,c,d,e,f,g,h,B)}function b(a,
c,d,e,f,g,h){return O(a,T.d(c,Vc(a),d,e,f,Kc([g,h],0)))}a.i=6;a.f=function(a){var c=G(a);a=K(a);var d=G(a);a=K(a);var e=G(a);a=K(a);var f=G(a);a=K(a);var g=G(a);a=K(a);var h=G(a);a=H(a);return b(c,d,e,f,g,h,a)};a.d=b;return a}(),f=function(f,l,m,p,q,s,u){switch(arguments.length){case 2:return e.call(this,f,l);case 3:return d.call(this,f,l,m);case 4:return c.call(this,f,l,m,p);case 5:return b.call(this,f,l,m,p,q);case 6:return a.call(this,f,l,m,p,q,s);default:var v=null;if(6<arguments.length){for(var v=
0,y=Array(arguments.length-6);v<y.length;)y[v]=arguments[v+6],++v;v=new F(y,0)}return g.d(f,l,m,p,q,s,v)}throw Error("Invalid arity: "+arguments.length);};f.i=6;f.f=g.f;f.a=e;f.c=d;f.n=c;f.r=b;f.P=a;f.d=g.d;return f}(),je=function(){function a(a,b){return!sc.a(a,b)}var b=null,c=function(){function a(c,d,h){var l=null;if(2<arguments.length){for(var l=0,m=Array(arguments.length-2);l<m.length;)m[l]=arguments[l+2],++l;l=new F(m,0)}return b.call(this,c,d,l)}function b(a,c,d){return Aa(T.n(sc,a,c,d))}a.i=
2;a.f=function(a){var c=G(a);a=K(a);var d=G(a);a=H(a);return b(c,d,a)};a.d=b;return a}(),b=function(b,e,f){switch(arguments.length){case 1:return!1;case 2:return a.call(this,b,e);default:var g=null;if(2<arguments.length){for(var g=0,h=Array(arguments.length-2);g<h.length;)h[g]=arguments[g+2],++g;g=new F(h,0)}return c.d(b,e,g)}throw Error("Invalid arity: "+arguments.length);};b.i=2;b.f=c.f;b.b=function(){return!1};b.a=a;b.d=c.d;return b}(),qe=function ke(){"undefined"===typeof ja&&(ja=function(b,c){this.pc=
b;this.oc=c;this.q=0;this.j=393216},ja.prototype.ga=function(){return!1},ja.prototype.next=function(){return Error("No such element")},ja.prototype.H=function(){return this.oc},ja.prototype.F=function(b,c){return new ja(this.pc,c)},ja.Yb=!0,ja.Xb="cljs.core/t12660",ja.nc=function(b){return Lb(b,"cljs.core/t12660")});return new ja(ke,new pa(null,5,[le,54,me,2998,ne,3,oe,2994,pe,"/Users/davidnolen/development/clojure/mori/out-mori-adv/cljs/core.cljs"],null))};function re(a,b){this.C=a;this.m=b}
re.prototype.ga=function(){return this.m<this.C.length};re.prototype.next=function(){var a=this.C.charAt(this.m);this.m+=1;return a};function se(a,b){this.e=a;this.m=b}se.prototype.ga=function(){return this.m<this.e.length};se.prototype.next=function(){var a=this.e[this.m];this.m+=1;return a};var te={},ue={};function ve(a,b){this.eb=a;this.Qa=b}ve.prototype.ga=function(){this.eb===te?(this.eb=ue,this.Qa=D(this.Qa)):this.eb===this.Qa&&(this.Qa=K(this.eb));return null!=this.Qa};
ve.prototype.next=function(){if(Aa(this.ga()))throw Error("No such element");this.eb=this.Qa;return G(this.Qa)};function we(a){if(null==a)return qe();if("string"===typeof a)return new re(a,0);if(a instanceof Array)return new se(a,0);if(a?t(t(null)?null:a.vb)||(a.yb?0:w(bc,a)):w(bc,a))return cc(a);if(ld(a))return new ve(te,a);throw Error([z("Cannot create iterator from "),z(a)].join(""));}function xe(a,b){this.fa=a;this.$b=b}
xe.prototype.step=function(a){for(var b=this;;){if(t(function(){var c=null!=a.X;return c?b.$b.ga():c}()))if(Ac(function(){var c=b.$b.next();return b.fa.a?b.fa.a(a,c):b.fa.call(null,a,c)}()))null!=a.M&&(a.M.X=null);else continue;break}return null==a.X?null:b.fa.b?b.fa.b(a):b.fa.call(null,a)};
function ye(a,b){var c=function(){function a(b,c){b.first=c;b.M=new ze(b.X,null,null,null);b.X=null;return b.M}function b(a){(Ac(a)?qb(a):a).X=null;return a}var c=null,c=function(c,f){switch(arguments.length){case 1:return b.call(this,c);case 2:return a.call(this,c,f)}throw Error("Invalid arity: "+arguments.length);};c.b=b;c.a=a;return c}();return new xe(a.b?a.b(c):a.call(null,c),b)}function Ae(a,b,c){this.fa=a;this.Kb=b;this.ac=c}
Ae.prototype.ga=function(){for(var a=D(this.Kb);;)if(null!=a){var b=G(a);if(Aa(b.ga()))return!1;a=K(a)}else return!0};Ae.prototype.next=function(){for(var a=this.Kb.length,b=0;;)if(b<a)this.ac[b]=this.Kb[b].next(),b+=1;else break;return Jc.a(this.ac,0)};Ae.prototype.step=function(a){for(;;){var b;b=(b=null!=a.X)?this.ga():b;if(t(b))if(Ac(T.a(this.fa,M(a,this.next()))))null!=a.M&&(a.M.X=null);else continue;break}return null==a.X?null:this.fa.b?this.fa.b(a):this.fa.call(null,a)};
var Be=function(){function a(a,b,c){var g=function(){function a(b,c){b.first=c;b.M=new ze(b.X,null,null,null);b.X=null;return b.M}function b(a){a=Ac(a)?qb(a):a;a.X=null;return a}var c=null,c=function(c,d){switch(arguments.length){case 1:return b.call(this,c);case 2:return a.call(this,c,d)}throw Error("Invalid arity: "+arguments.length);};c.b=b;c.a=a;return c}();return new Ae(a.b?a.b(g):a.call(null,g),b,c)}function b(a,b){return c.c(a,b,Array(b.length))}var c=null,c=function(c,e,f){switch(arguments.length){case 2:return b.call(this,
c,e);case 3:return a.call(this,c,e,f)}throw Error("Invalid arity: "+arguments.length);};c.a=b;c.c=a;return c}();function ze(a,b,c,d){this.X=a;this.first=b;this.M=c;this.k=d;this.q=0;this.j=31719628}k=ze.prototype;k.T=function(){null!=this.X&&Cb(this);return null==this.M?null:Cb(this.M)};k.N=function(){null!=this.X&&Cb(this);return null==this.M?null:this.first};k.S=function(){null!=this.X&&Cb(this);return null==this.M?J:this.M};
k.D=function(){null!=this.X&&this.X.step(this);return null==this.M?null:this};k.B=function(){return wc(this)};k.A=function(a,b){return null!=Cb(this)?Ic(this,b):cd(b)&&null==D(b)};k.J=function(){return J};k.G=function(a,b){return M(b,Cb(this))};k.F=function(a,b){return new ze(this.X,this.first,this.M,b)};ze.prototype[Ea]=function(){return uc(this)};
var Ce=function(){function a(a){return kd(a)?a:(a=D(a))?a:J}var b=null,c=function(){function a(c,d,h){var l=null;if(2<arguments.length){for(var l=0,m=Array(arguments.length-2);l<m.length;)m[l]=arguments[l+2],++l;l=new F(m,0)}return b.call(this,c,d,l)}function b(a,c,d){d=rd(M(c,d));c=[];d=D(d);for(var e=null,m=0,p=0;;)if(p<m){var q=e.Q(null,p);c.push(we(q));p+=1}else if(d=D(d))e=d,fd(e)?(d=Yb(e),p=Zb(e),e=d,m=Q(d),d=p):(d=G(e),c.push(we(d)),d=K(e),e=null,m=0),p=0;else break;return new ze(Be.c(a,c,
Array(c.length)),null,null,null)}a.i=2;a.f=function(a){var c=G(a);a=K(a);var d=G(a);a=H(a);return b(c,d,a)};a.d=b;return a}(),b=function(b,e,f){switch(arguments.length){case 1:return a.call(this,b);case 2:return new ze(ye(b,we(e)),null,null,null);default:var g=null;if(2<arguments.length){for(var g=0,h=Array(arguments.length-2);g<h.length;)h[g]=arguments[g+2],++g;g=new F(h,0)}return c.d(b,e,g)}throw Error("Invalid arity: "+arguments.length);};b.i=2;b.f=c.f;b.b=a;b.a=function(a,b){return new ze(ye(a,
we(b)),null,null,null)};b.d=c.d;return b}();function Ee(a,b){for(;;){if(null==D(b))return!0;var c;c=G(b);c=a.b?a.b(c):a.call(null,c);if(t(c)){c=a;var d=K(b);a=c;b=d}else return!1}}function Fe(a,b){for(;;)if(D(b)){var c;c=G(b);c=a.b?a.b(c):a.call(null,c);if(t(c))return c;c=a;var d=K(b);a=c;b=d}else return null}function Ge(a){if("number"===typeof a&&Aa(isNaN(a))&&Infinity!==a&&parseFloat(a)===parseInt(a,10))return 0===(a&1);throw Error([z("Argument must be an integer: "),z(a)].join(""));}
function He(a){return function(){function b(b,c){return Aa(a.a?a.a(b,c):a.call(null,b,c))}function c(b){return Aa(a.b?a.b(b):a.call(null,b))}function d(){return Aa(a.l?a.l():a.call(null))}var e=null,f=function(){function b(a,d,e){var f=null;if(2<arguments.length){for(var f=0,g=Array(arguments.length-2);f<g.length;)g[f]=arguments[f+2],++f;f=new F(g,0)}return c.call(this,a,d,f)}function c(b,d,e){return Aa(T.n(a,b,d,e))}b.i=2;b.f=function(a){var b=G(a);a=K(a);var d=G(a);a=H(a);return c(b,d,a)};b.d=c;
return b}(),e=function(a,e,l){switch(arguments.length){case 0:return d.call(this);case 1:return c.call(this,a);case 2:return b.call(this,a,e);default:var m=null;if(2<arguments.length){for(var m=0,p=Array(arguments.length-2);m<p.length;)p[m]=arguments[m+2],++m;m=new F(p,0)}return f.d(a,e,m)}throw Error("Invalid arity: "+arguments.length);};e.i=2;e.f=f.f;e.l=d;e.b=c;e.a=b;e.d=f.d;return e}()}
var Ie=function(){function a(a,b,c){return function(){function d(h,l,m){h=c.c?c.c(h,l,m):c.call(null,h,l,m);h=b.b?b.b(h):b.call(null,h);return a.b?a.b(h):a.call(null,h)}function l(d,h){var l;l=c.a?c.a(d,h):c.call(null,d,h);l=b.b?b.b(l):b.call(null,l);return a.b?a.b(l):a.call(null,l)}function m(d){d=c.b?c.b(d):c.call(null,d);d=b.b?b.b(d):b.call(null,d);return a.b?a.b(d):a.call(null,d)}function p(){var d;d=c.l?c.l():c.call(null);d=b.b?b.b(d):b.call(null,d);return a.b?a.b(d):a.call(null,d)}var q=null,
s=function(){function d(a,b,c,e){var f=null;if(3<arguments.length){for(var f=0,g=Array(arguments.length-3);f<g.length;)g[f]=arguments[f+3],++f;f=new F(g,0)}return h.call(this,a,b,c,f)}function h(d,l,m,p){d=T.r(c,d,l,m,p);d=b.b?b.b(d):b.call(null,d);return a.b?a.b(d):a.call(null,d)}d.i=3;d.f=function(a){var b=G(a);a=K(a);var c=G(a);a=K(a);var d=G(a);a=H(a);return h(b,c,d,a)};d.d=h;return d}(),q=function(a,b,c,e){switch(arguments.length){case 0:return p.call(this);case 1:return m.call(this,a);case 2:return l.call(this,
a,b);case 3:return d.call(this,a,b,c);default:var f=null;if(3<arguments.length){for(var f=0,g=Array(arguments.length-3);f<g.length;)g[f]=arguments[f+3],++f;f=new F(g,0)}return s.d(a,b,c,f)}throw Error("Invalid arity: "+arguments.length);};q.i=3;q.f=s.f;q.l=p;q.b=m;q.a=l;q.c=d;q.d=s.d;return q}()}function b(a,b){return function(){function c(d,g,h){d=b.c?b.c(d,g,h):b.call(null,d,g,h);return a.b?a.b(d):a.call(null,d)}function d(c,g){var h=b.a?b.a(c,g):b.call(null,c,g);return a.b?a.b(h):a.call(null,h)}
function l(c){c=b.b?b.b(c):b.call(null,c);return a.b?a.b(c):a.call(null,c)}function m(){var c=b.l?b.l():b.call(null);return a.b?a.b(c):a.call(null,c)}var p=null,q=function(){function c(a,b,e,f){var g=null;if(3<arguments.length){for(var g=0,h=Array(arguments.length-3);g<h.length;)h[g]=arguments[g+3],++g;g=new F(h,0)}return d.call(this,a,b,e,g)}function d(c,g,h,l){c=T.r(b,c,g,h,l);return a.b?a.b(c):a.call(null,c)}c.i=3;c.f=function(a){var b=G(a);a=K(a);var c=G(a);a=K(a);var e=G(a);a=H(a);return d(b,
c,e,a)};c.d=d;return c}(),p=function(a,b,e,f){switch(arguments.length){case 0:return m.call(this);case 1:return l.call(this,a);case 2:return d.call(this,a,b);case 3:return c.call(this,a,b,e);default:var p=null;if(3<arguments.length){for(var p=0,E=Array(arguments.length-3);p<E.length;)E[p]=arguments[p+3],++p;p=new F(E,0)}return q.d(a,b,e,p)}throw Error("Invalid arity: "+arguments.length);};p.i=3;p.f=q.f;p.l=m;p.b=l;p.a=d;p.c=c;p.d=q.d;return p}()}var c=null,d=function(){function a(c,d,e,m){var p=null;
if(3<arguments.length){for(var p=0,q=Array(arguments.length-3);p<q.length;)q[p]=arguments[p+3],++p;p=new F(q,0)}return b.call(this,c,d,e,p)}function b(a,c,d,e){return function(a){return function(){function b(a){var d=null;if(0<arguments.length){for(var d=0,e=Array(arguments.length-0);d<e.length;)e[d]=arguments[d+0],++d;d=new F(e,0)}return c.call(this,d)}function c(b){b=T.a(G(a),b);for(var d=K(a);;)if(d)b=G(d).call(null,b),d=K(d);else return b}b.i=0;b.f=function(a){a=D(a);return c(a)};b.d=c;return b}()}(Jd(be.n(a,
c,d,e)))}a.i=3;a.f=function(a){var c=G(a);a=K(a);var d=G(a);a=K(a);var e=G(a);a=H(a);return b(c,d,e,a)};a.d=b;return a}(),c=function(c,f,g,h){switch(arguments.length){case 0:return ud;case 1:return c;case 2:return b.call(this,c,f);case 3:return a.call(this,c,f,g);default:var l=null;if(3<arguments.length){for(var l=0,m=Array(arguments.length-3);l<m.length;)m[l]=arguments[l+3],++l;l=new F(m,0)}return d.d(c,f,g,l)}throw Error("Invalid arity: "+arguments.length);};c.i=3;c.f=d.f;c.l=function(){return ud};
c.b=function(a){return a};c.a=b;c.c=a;c.d=d.d;return c}(),Je=function(){function a(a,b,c,d){return function(){function e(m,p,q){return a.P?a.P(b,c,d,m,p,q):a.call(null,b,c,d,m,p,q)}function p(e,m){return a.r?a.r(b,c,d,e,m):a.call(null,b,c,d,e,m)}function q(e){return a.n?a.n(b,c,d,e):a.call(null,b,c,d,e)}function s(){return a.c?a.c(b,c,d):a.call(null,b,c,d)}var u=null,v=function(){function e(a,b,c,d){var f=null;if(3<arguments.length){for(var f=0,g=Array(arguments.length-3);f<g.length;)g[f]=arguments[f+
3],++f;f=new F(g,0)}return m.call(this,a,b,c,f)}function m(e,p,q,s){return T.d(a,b,c,d,e,Kc([p,q,s],0))}e.i=3;e.f=function(a){var b=G(a);a=K(a);var c=G(a);a=K(a);var d=G(a);a=H(a);return m(b,c,d,a)};e.d=m;return e}(),u=function(a,b,c,d){switch(arguments.length){case 0:return s.call(this);case 1:return q.call(this,a);case 2:return p.call(this,a,b);case 3:return e.call(this,a,b,c);default:var f=null;if(3<arguments.length){for(var f=0,g=Array(arguments.length-3);f<g.length;)g[f]=arguments[f+3],++f;f=
new F(g,0)}return v.d(a,b,c,f)}throw Error("Invalid arity: "+arguments.length);};u.i=3;u.f=v.f;u.l=s;u.b=q;u.a=p;u.c=e;u.d=v.d;return u}()}function b(a,b,c){return function(){function d(e,l,m){return a.r?a.r(b,c,e,l,m):a.call(null,b,c,e,l,m)}function e(d,l){return a.n?a.n(b,c,d,l):a.call(null,b,c,d,l)}function p(d){return a.c?a.c(b,c,d):a.call(null,b,c,d)}function q(){return a.a?a.a(b,c):a.call(null,b,c)}var s=null,u=function(){function d(a,b,c,f){var g=null;if(3<arguments.length){for(var g=0,h=Array(arguments.length-
3);g<h.length;)h[g]=arguments[g+3],++g;g=new F(h,0)}return e.call(this,a,b,c,g)}function e(d,l,m,p){return T.d(a,b,c,d,l,Kc([m,p],0))}d.i=3;d.f=function(a){var b=G(a);a=K(a);var c=G(a);a=K(a);var d=G(a);a=H(a);return e(b,c,d,a)};d.d=e;return d}(),s=function(a,b,c,f){switch(arguments.length){case 0:return q.call(this);case 1:return p.call(this,a);case 2:return e.call(this,a,b);case 3:return d.call(this,a,b,c);default:var g=null;if(3<arguments.length){for(var g=0,h=Array(arguments.length-3);g<h.length;)h[g]=
arguments[g+3],++g;g=new F(h,0)}return u.d(a,b,c,g)}throw Error("Invalid arity: "+arguments.length);};s.i=3;s.f=u.f;s.l=q;s.b=p;s.a=e;s.c=d;s.d=u.d;return s}()}function c(a,b){return function(){function c(d,e,h){return a.n?a.n(b,d,e,h):a.call(null,b,d,e,h)}function d(c,e){return a.c?a.c(b,c,e):a.call(null,b,c,e)}function e(c){return a.a?a.a(b,c):a.call(null,b,c)}function p(){return a.b?a.b(b):a.call(null,b)}var q=null,s=function(){function c(a,b,e,f){var g=null;if(3<arguments.length){for(var g=0,
h=Array(arguments.length-3);g<h.length;)h[g]=arguments[g+3],++g;g=new F(h,0)}return d.call(this,a,b,e,g)}function d(c,e,h,l){return T.d(a,b,c,e,h,Kc([l],0))}c.i=3;c.f=function(a){var b=G(a);a=K(a);var c=G(a);a=K(a);var e=G(a);a=H(a);return d(b,c,e,a)};c.d=d;return c}(),q=function(a,b,f,g){switch(arguments.length){case 0:return p.call(this);case 1:return e.call(this,a);case 2:return d.call(this,a,b);case 3:return c.call(this,a,b,f);default:var q=null;if(3<arguments.length){for(var q=0,N=Array(arguments.length-
3);q<N.length;)N[q]=arguments[q+3],++q;q=new F(N,0)}return s.d(a,b,f,q)}throw Error("Invalid arity: "+arguments.length);};q.i=3;q.f=s.f;q.l=p;q.b=e;q.a=d;q.c=c;q.d=s.d;return q}()}var d=null,e=function(){function a(c,d,e,f,q){var s=null;if(4<arguments.length){for(var s=0,u=Array(arguments.length-4);s<u.length;)u[s]=arguments[s+4],++s;s=new F(u,0)}return b.call(this,c,d,e,f,s)}function b(a,c,d,e,f){return function(){function b(a){var c=null;if(0<arguments.length){for(var c=0,d=Array(arguments.length-
0);c<d.length;)d[c]=arguments[c+0],++c;c=new F(d,0)}return g.call(this,c)}function g(b){return T.r(a,c,d,e,ae.a(f,b))}b.i=0;b.f=function(a){a=D(a);return g(a)};b.d=g;return b}()}a.i=4;a.f=function(a){var c=G(a);a=K(a);var d=G(a);a=K(a);var e=G(a);a=K(a);var f=G(a);a=H(a);return b(c,d,e,f,a)};a.d=b;return a}(),d=function(d,g,h,l,m){switch(arguments.length){case 1:return d;case 2:return c.call(this,d,g);case 3:return b.call(this,d,g,h);case 4:return a.call(this,d,g,h,l);default:var p=null;if(4<arguments.length){for(var p=
0,q=Array(arguments.length-4);p<q.length;)q[p]=arguments[p+4],++p;p=new F(q,0)}return e.d(d,g,h,l,p)}throw Error("Invalid arity: "+arguments.length);};d.i=4;d.f=e.f;d.b=function(a){return a};d.a=c;d.c=b;d.n=a;d.d=e.d;return d}(),Ke=function(){function a(a,b,c,d){return function(){function l(l,m,p){l=null==l?b:l;m=null==m?c:m;p=null==p?d:p;return a.c?a.c(l,m,p):a.call(null,l,m,p)}function m(d,h){var l=null==d?b:d,m=null==h?c:h;return a.a?a.a(l,m):a.call(null,l,m)}var p=null,q=function(){function l(a,
b,c,d){var e=null;if(3<arguments.length){for(var e=0,f=Array(arguments.length-3);e<f.length;)f[e]=arguments[e+3],++e;e=new F(f,0)}return m.call(this,a,b,c,e)}function m(l,p,q,s){return T.r(a,null==l?b:l,null==p?c:p,null==q?d:q,s)}l.i=3;l.f=function(a){var b=G(a);a=K(a);var c=G(a);a=K(a);var d=G(a);a=H(a);return m(b,c,d,a)};l.d=m;return l}(),p=function(a,b,c,d){switch(arguments.length){case 2:return m.call(this,a,b);case 3:return l.call(this,a,b,c);default:var e=null;if(3<arguments.length){for(var e=
0,f=Array(arguments.length-3);e<f.length;)f[e]=arguments[e+3],++e;e=new F(f,0)}return q.d(a,b,c,e)}throw Error("Invalid arity: "+arguments.length);};p.i=3;p.f=q.f;p.a=m;p.c=l;p.d=q.d;return p}()}function b(a,b,c){return function(){function d(h,l,m){h=null==h?b:h;l=null==l?c:l;return a.c?a.c(h,l,m):a.call(null,h,l,m)}function l(d,h){var l=null==d?b:d,m=null==h?c:h;return a.a?a.a(l,m):a.call(null,l,m)}var m=null,p=function(){function d(a,b,c,e){var f=null;if(3<arguments.length){for(var f=0,g=Array(arguments.length-
3);f<g.length;)g[f]=arguments[f+3],++f;f=new F(g,0)}return h.call(this,a,b,c,f)}function h(d,l,m,p){return T.r(a,null==d?b:d,null==l?c:l,m,p)}d.i=3;d.f=function(a){var b=G(a);a=K(a);var c=G(a);a=K(a);var d=G(a);a=H(a);return h(b,c,d,a)};d.d=h;return d}(),m=function(a,b,c,e){switch(arguments.length){case 2:return l.call(this,a,b);case 3:return d.call(this,a,b,c);default:var f=null;if(3<arguments.length){for(var f=0,g=Array(arguments.length-3);f<g.length;)g[f]=arguments[f+3],++f;f=new F(g,0)}return p.d(a,
b,c,f)}throw Error("Invalid arity: "+arguments.length);};m.i=3;m.f=p.f;m.a=l;m.c=d;m.d=p.d;return m}()}function c(a,b){return function(){function c(d,g,h){d=null==d?b:d;return a.c?a.c(d,g,h):a.call(null,d,g,h)}function d(c,g){var h=null==c?b:c;return a.a?a.a(h,g):a.call(null,h,g)}function l(c){c=null==c?b:c;return a.b?a.b(c):a.call(null,c)}var m=null,p=function(){function c(a,b,e,f){var g=null;if(3<arguments.length){for(var g=0,h=Array(arguments.length-3);g<h.length;)h[g]=arguments[g+3],++g;g=new F(h,
0)}return d.call(this,a,b,e,g)}function d(c,g,h,l){return T.r(a,null==c?b:c,g,h,l)}c.i=3;c.f=function(a){var b=G(a);a=K(a);var c=G(a);a=K(a);var e=G(a);a=H(a);return d(b,c,e,a)};c.d=d;return c}(),m=function(a,b,e,f){switch(arguments.length){case 1:return l.call(this,a);case 2:return d.call(this,a,b);case 3:return c.call(this,a,b,e);default:var m=null;if(3<arguments.length){for(var m=0,B=Array(arguments.length-3);m<B.length;)B[m]=arguments[m+3],++m;m=new F(B,0)}return p.d(a,b,e,m)}throw Error("Invalid arity: "+
arguments.length);};m.i=3;m.f=p.f;m.b=l;m.a=d;m.c=c;m.d=p.d;return m}()}var d=null,d=function(d,f,g,h){switch(arguments.length){case 2:return c.call(this,d,f);case 3:return b.call(this,d,f,g);case 4:return a.call(this,d,f,g,h)}throw Error("Invalid arity: "+arguments.length);};d.a=c;d.c=b;d.n=a;return d}(),Le=function(){function a(a,b){return new V(null,function(){var f=D(b);if(f){if(fd(f)){for(var g=Yb(f),h=Q(g),l=Td(h),m=0;;)if(m<h){var p=function(){var b=C.a(g,m);return a.b?a.b(b):a.call(null,b)}();
null!=p&&l.add(p);m+=1}else break;return Wd(l.ca(),c.a(a,Zb(f)))}h=function(){var b=G(f);return a.b?a.b(b):a.call(null,b)}();return null==h?c.a(a,H(f)):M(h,c.a(a,H(f)))}return null},null,null)}function b(a){return function(b){return function(){function c(f,g){var h=a.b?a.b(g):a.call(null,g);return null==h?f:b.a?b.a(f,h):b.call(null,f,h)}function g(a){return b.b?b.b(a):b.call(null,a)}function h(){return b.l?b.l():b.call(null)}var l=null,l=function(a,b){switch(arguments.length){case 0:return h.call(this);
case 1:return g.call(this,a);case 2:return c.call(this,a,b)}throw Error("Invalid arity: "+arguments.length);};l.l=h;l.b=g;l.a=c;return l}()}}var c=null,c=function(c,e){switch(arguments.length){case 1:return b.call(this,c);case 2:return a.call(this,c,e)}throw Error("Invalid arity: "+arguments.length);};c.b=b;c.a=a;return c}();function Me(a){this.state=a;this.q=0;this.j=32768}Me.prototype.Ra=function(){return this.state};Me.prototype.bb=function(a,b){return this.state=b};
var Ne=function(){function a(a,b){return function g(b,c){return new V(null,function(){var e=D(c);if(e){if(fd(e)){for(var p=Yb(e),q=Q(p),s=Td(q),u=0;;)if(u<q){var v=function(){var c=b+u,e=C.a(p,u);return a.a?a.a(c,e):a.call(null,c,e)}();null!=v&&s.add(v);u+=1}else break;return Wd(s.ca(),g(b+q,Zb(e)))}q=function(){var c=G(e);return a.a?a.a(b,c):a.call(null,b,c)}();return null==q?g(b+1,H(e)):M(q,g(b+1,H(e)))}return null},null,null)}(0,b)}function b(a){return function(b){return function(c){return function(){function g(g,
h){var l=c.bb(0,c.Ra(null)+1),l=a.a?a.a(l,h):a.call(null,l,h);return null==l?g:b.a?b.a(g,l):b.call(null,g,l)}function h(a){return b.b?b.b(a):b.call(null,a)}function l(){return b.l?b.l():b.call(null)}var m=null,m=function(a,b){switch(arguments.length){case 0:return l.call(this);case 1:return h.call(this,a);case 2:return g.call(this,a,b)}throw Error("Invalid arity: "+arguments.length);};m.l=l;m.b=h;m.a=g;return m}()}(new Me(-1))}}var c=null,c=function(c,e){switch(arguments.length){case 1:return b.call(this,
c);case 2:return a.call(this,c,e)}throw Error("Invalid arity: "+arguments.length);};c.b=b;c.a=a;return c}(),Oe=function(){function a(a,b,c,d){return new V(null,function(){var f=D(b),q=D(c),s=D(d);if(f&&q&&s){var u=M,v;v=G(f);var y=G(q),B=G(s);v=a.c?a.c(v,y,B):a.call(null,v,y,B);f=u(v,e.n(a,H(f),H(q),H(s)))}else f=null;return f},null,null)}function b(a,b,c){return new V(null,function(){var d=D(b),f=D(c);if(d&&f){var q=M,s;s=G(d);var u=G(f);s=a.a?a.a(s,u):a.call(null,s,u);d=q(s,e.c(a,H(d),H(f)))}else d=
null;return d},null,null)}function c(a,b){return new V(null,function(){var c=D(b);if(c){if(fd(c)){for(var d=Yb(c),f=Q(d),q=Td(f),s=0;;)if(s<f)Xd(q,function(){var b=C.a(d,s);return a.b?a.b(b):a.call(null,b)}()),s+=1;else break;return Wd(q.ca(),e.a(a,Zb(c)))}return M(function(){var b=G(c);return a.b?a.b(b):a.call(null,b)}(),e.a(a,H(c)))}return null},null,null)}function d(a){return function(b){return function(){function c(d,e){var f=a.b?a.b(e):a.call(null,e);return b.a?b.a(d,f):b.call(null,d,f)}function d(a){return b.b?
b.b(a):b.call(null,a)}function e(){return b.l?b.l():b.call(null)}var f=null,s=function(){function c(a,b,e){var f=null;if(2<arguments.length){for(var f=0,g=Array(arguments.length-2);f<g.length;)g[f]=arguments[f+2],++f;f=new F(g,0)}return d.call(this,a,b,f)}function d(c,e,f){e=T.c(a,e,f);return b.a?b.a(c,e):b.call(null,c,e)}c.i=2;c.f=function(a){var b=G(a);a=K(a);var c=G(a);a=H(a);return d(b,c,a)};c.d=d;return c}(),f=function(a,b,f){switch(arguments.length){case 0:return e.call(this);case 1:return d.call(this,
a);case 2:return c.call(this,a,b);default:var g=null;if(2<arguments.length){for(var g=0,h=Array(arguments.length-2);g<h.length;)h[g]=arguments[g+2],++g;g=new F(h,0)}return s.d(a,b,g)}throw Error("Invalid arity: "+arguments.length);};f.i=2;f.f=s.f;f.l=e;f.b=d;f.a=c;f.d=s.d;return f}()}}var e=null,f=function(){function a(c,d,e,f,g){var u=null;if(4<arguments.length){for(var u=0,v=Array(arguments.length-4);u<v.length;)v[u]=arguments[u+4],++u;u=new F(v,0)}return b.call(this,c,d,e,f,u)}function b(a,c,d,
f,g){var h=function y(a){return new V(null,function(){var b=e.a(D,a);return Ee(ud,b)?M(e.a(G,b),y(e.a(H,b))):null},null,null)};return e.a(function(){return function(b){return T.a(a,b)}}(h),h(Nc.d(g,f,Kc([d,c],0))))}a.i=4;a.f=function(a){var c=G(a);a=K(a);var d=G(a);a=K(a);var e=G(a);a=K(a);var f=G(a);a=H(a);return b(c,d,e,f,a)};a.d=b;return a}(),e=function(e,h,l,m,p){switch(arguments.length){case 1:return d.call(this,e);case 2:return c.call(this,e,h);case 3:return b.call(this,e,h,l);case 4:return a.call(this,
e,h,l,m);default:var q=null;if(4<arguments.length){for(var q=0,s=Array(arguments.length-4);q<s.length;)s[q]=arguments[q+4],++q;q=new F(s,0)}return f.d(e,h,l,m,q)}throw Error("Invalid arity: "+arguments.length);};e.i=4;e.f=f.f;e.b=d;e.a=c;e.c=b;e.n=a;e.d=f.d;return e}(),Pe=function(){function a(a,b){return new V(null,function(){if(0<a){var f=D(b);return f?M(G(f),c.a(a-1,H(f))):null}return null},null,null)}function b(a){return function(b){return function(a){return function(){function c(d,g){var h=qb(a),
l=a.bb(0,a.Ra(null)-1),h=0<h?b.a?b.a(d,g):b.call(null,d,g):d;return 0<l?h:Ac(h)?h:new yc(h)}function d(a){return b.b?b.b(a):b.call(null,a)}function l(){return b.l?b.l():b.call(null)}var m=null,m=function(a,b){switch(arguments.length){case 0:return l.call(this);case 1:return d.call(this,a);case 2:return c.call(this,a,b)}throw Error("Invalid arity: "+arguments.length);};m.l=l;m.b=d;m.a=c;return m}()}(new Me(a))}}var c=null,c=function(c,e){switch(arguments.length){case 1:return b.call(this,c);case 2:return a.call(this,
c,e)}throw Error("Invalid arity: "+arguments.length);};c.b=b;c.a=a;return c}(),Qe=function(){function a(a,b){return new V(null,function(c){return function(){return c(a,b)}}(function(a,b){for(;;){var c=D(b);if(0<a&&c){var d=a-1,c=H(c);a=d;b=c}else return c}}),null,null)}function b(a){return function(b){return function(a){return function(){function c(d,g){var h=qb(a);a.bb(0,a.Ra(null)-1);return 0<h?d:b.a?b.a(d,g):b.call(null,d,g)}function d(a){return b.b?b.b(a):b.call(null,a)}function l(){return b.l?
b.l():b.call(null)}var m=null,m=function(a,b){switch(arguments.length){case 0:return l.call(this);case 1:return d.call(this,a);case 2:return c.call(this,a,b)}throw Error("Invalid arity: "+arguments.length);};m.l=l;m.b=d;m.a=c;return m}()}(new Me(a))}}var c=null,c=function(c,e){switch(arguments.length){case 1:return b.call(this,c);case 2:return a.call(this,c,e)}throw Error("Invalid arity: "+arguments.length);};c.b=b;c.a=a;return c}(),Re=function(){function a(a,b){return new V(null,function(c){return function(){return c(a,
b)}}(function(a,b){for(;;){var c=D(b),d;if(d=c)d=G(c),d=a.b?a.b(d):a.call(null,d);if(t(d))d=a,c=H(c),a=d,b=c;else return c}}),null,null)}function b(a){return function(b){return function(c){return function(){function g(g,h){var l=qb(c);if(t(t(l)?a.b?a.b(h):a.call(null,h):l))return g;ac(c,null);return b.a?b.a(g,h):b.call(null,g,h)}function h(a){return b.b?b.b(a):b.call(null,a)}function l(){return b.l?b.l():b.call(null)}var m=null,m=function(a,b){switch(arguments.length){case 0:return l.call(this);case 1:return h.call(this,
a);case 2:return g.call(this,a,b)}throw Error("Invalid arity: "+arguments.length);};m.l=l;m.b=h;m.a=g;return m}()}(new Me(!0))}}var c=null,c=function(c,e){switch(arguments.length){case 1:return b.call(this,c);case 2:return a.call(this,c,e)}throw Error("Invalid arity: "+arguments.length);};c.b=b;c.a=a;return c}(),Se=function(){function a(a,b){return Pe.a(a,c.b(b))}function b(a){return new V(null,function(){return M(a,c.b(a))},null,null)}var c=null,c=function(c,e){switch(arguments.length){case 1:return b.call(this,
c);case 2:return a.call(this,c,e)}throw Error("Invalid arity: "+arguments.length);};c.b=b;c.a=a;return c}(),Te=function(){function a(a,b){return Pe.a(a,c.b(b))}function b(a){return new V(null,function(){return M(a.l?a.l():a.call(null),c.b(a))},null,null)}var c=null,c=function(c,e){switch(arguments.length){case 1:return b.call(this,c);case 2:return a.call(this,c,e)}throw Error("Invalid arity: "+arguments.length);};c.b=b;c.a=a;return c}(),Ue=function(){function a(a,c){return new V(null,function(){var f=
D(a),g=D(c);return f&&g?M(G(f),M(G(g),b.a(H(f),H(g)))):null},null,null)}var b=null,c=function(){function a(b,d,h){var l=null;if(2<arguments.length){for(var l=0,m=Array(arguments.length-2);l<m.length;)m[l]=arguments[l+2],++l;l=new F(m,0)}return c.call(this,b,d,l)}function c(a,d,e){return new V(null,function(){var c=Oe.a(D,Nc.d(e,d,Kc([a],0)));return Ee(ud,c)?ae.a(Oe.a(G,c),T.a(b,Oe.a(H,c))):null},null,null)}a.i=2;a.f=function(a){var b=G(a);a=K(a);var d=G(a);a=H(a);return c(b,d,a)};a.d=c;return a}(),
b=function(b,e,f){switch(arguments.length){case 2:return a.call(this,b,e);default:var g=null;if(2<arguments.length){for(var g=0,h=Array(arguments.length-2);g<h.length;)h[g]=arguments[g+2],++g;g=new F(h,0)}return c.d(b,e,g)}throw Error("Invalid arity: "+arguments.length);};b.i=2;b.f=c.f;b.a=a;b.d=c.d;return b}(),We=function(){function a(a){return Ie.a(Oe.b(a),Ve)}var b=null,c=function(){function a(c,d){var h=null;if(1<arguments.length){for(var h=0,l=Array(arguments.length-1);h<l.length;)l[h]=arguments[h+
1],++h;h=new F(l,0)}return b.call(this,c,h)}function b(a,c){return T.a(ae,T.c(Oe,a,c))}a.i=1;a.f=function(a){var c=G(a);a=H(a);return b(c,a)};a.d=b;return a}(),b=function(b,e){switch(arguments.length){case 1:return a.call(this,b);default:var f=null;if(1<arguments.length){for(var f=0,g=Array(arguments.length-1);f<g.length;)g[f]=arguments[f+1],++f;f=new F(g,0)}return c.d(b,f)}throw Error("Invalid arity: "+arguments.length);};b.i=1;b.f=c.f;b.b=a;b.d=c.d;return b}(),Xe=function(){function a(a,b){return new V(null,
function(){var f=D(b);if(f){if(fd(f)){for(var g=Yb(f),h=Q(g),l=Td(h),m=0;;)if(m<h){var p;p=C.a(g,m);p=a.b?a.b(p):a.call(null,p);t(p)&&(p=C.a(g,m),l.add(p));m+=1}else break;return Wd(l.ca(),c.a(a,Zb(f)))}g=G(f);f=H(f);return t(a.b?a.b(g):a.call(null,g))?M(g,c.a(a,f)):c.a(a,f)}return null},null,null)}function b(a){return function(b){return function(){function c(f,g){return t(a.b?a.b(g):a.call(null,g))?b.a?b.a(f,g):b.call(null,f,g):f}function g(a){return b.b?b.b(a):b.call(null,a)}function h(){return b.l?
b.l():b.call(null)}var l=null,l=function(a,b){switch(arguments.length){case 0:return h.call(this);case 1:return g.call(this,a);case 2:return c.call(this,a,b)}throw Error("Invalid arity: "+arguments.length);};l.l=h;l.b=g;l.a=c;return l}()}}var c=null,c=function(c,e){switch(arguments.length){case 1:return b.call(this,c);case 2:return a.call(this,c,e)}throw Error("Invalid arity: "+arguments.length);};c.b=b;c.a=a;return c}(),Ye=function(){function a(a,b){return Xe.a(He(a),b)}function b(a){return Xe.b(He(a))}
var c=null,c=function(c,e){switch(arguments.length){case 1:return b.call(this,c);case 2:return a.call(this,c,e)}throw Error("Invalid arity: "+arguments.length);};c.b=b;c.a=a;return c}();function Ze(a){var b=$e;return function d(a){return new V(null,function(){return M(a,t(b.b?b.b(a):b.call(null,a))?We.d(d,Kc([D.b?D.b(a):D.call(null,a)],0)):null)},null,null)}(a)}
var af=function(){function a(a,b,c){return a&&(a.q&4||a.dc)?O(ce(wd.n(b,de,Ob(a),c)),Vc(a)):wd.n(b,Nc,a,c)}function b(a,b){return null!=a?a&&(a.q&4||a.dc)?O(ce(A.c(Pb,Ob(a),b)),Vc(a)):A.c(Ra,a,b):A.c(Nc,J,b)}var c=null,c=function(c,e,f){switch(arguments.length){case 2:return b.call(this,c,e);case 3:return a.call(this,c,e,f)}throw Error("Invalid arity: "+arguments.length);};c.a=b;c.c=a;return c}(),bf=function(){function a(a,b,c,h){return new V(null,function(){var l=D(h);if(l){var m=Pe.a(a,l);return a===
Q(m)?M(m,d.n(a,b,c,Qe.a(b,l))):Ra(J,Pe.a(a,ae.a(m,c)))}return null},null,null)}function b(a,b,c){return new V(null,function(){var h=D(c);if(h){var l=Pe.a(a,h);return a===Q(l)?M(l,d.c(a,b,Qe.a(b,h))):null}return null},null,null)}function c(a,b){return d.c(a,a,b)}var d=null,d=function(d,f,g,h){switch(arguments.length){case 2:return c.call(this,d,f);case 3:return b.call(this,d,f,g);case 4:return a.call(this,d,f,g,h)}throw Error("Invalid arity: "+arguments.length);};d.a=c;d.c=b;d.n=a;return d}(),cf=function(){function a(a,
b,c){var g=jd;for(b=D(b);;)if(b){var h=a;if(h?h.j&256||h.Rb||(h.j?0:w(Za,h)):w(Za,h)){a=S.c(a,G(b),g);if(g===a)return c;b=K(b)}else return c}else return a}function b(a,b){return c.c(a,b,null)}var c=null,c=function(c,e,f){switch(arguments.length){case 2:return b.call(this,c,e);case 3:return a.call(this,c,e,f)}throw Error("Invalid arity: "+arguments.length);};c.a=b;c.c=a;return c}(),df=function(){function a(a,b,c,d,f,q){var s=R.c(b,0,null);return(b=Ed(b))?Rc.c(a,s,e.P(S.a(a,s),b,c,d,f,q)):Rc.c(a,s,
function(){var b=S.a(a,s);return c.n?c.n(b,d,f,q):c.call(null,b,d,f,q)}())}function b(a,b,c,d,f){var q=R.c(b,0,null);return(b=Ed(b))?Rc.c(a,q,e.r(S.a(a,q),b,c,d,f)):Rc.c(a,q,function(){var b=S.a(a,q);return c.c?c.c(b,d,f):c.call(null,b,d,f)}())}function c(a,b,c,d){var f=R.c(b,0,null);return(b=Ed(b))?Rc.c(a,f,e.n(S.a(a,f),b,c,d)):Rc.c(a,f,function(){var b=S.a(a,f);return c.a?c.a(b,d):c.call(null,b,d)}())}function d(a,b,c){var d=R.c(b,0,null);return(b=Ed(b))?Rc.c(a,d,e.c(S.a(a,d),b,c)):Rc.c(a,d,function(){var b=
S.a(a,d);return c.b?c.b(b):c.call(null,b)}())}var e=null,f=function(){function a(c,d,e,f,g,u,v){var y=null;if(6<arguments.length){for(var y=0,B=Array(arguments.length-6);y<B.length;)B[y]=arguments[y+6],++y;y=new F(B,0)}return b.call(this,c,d,e,f,g,u,y)}function b(a,c,d,f,g,h,v){var y=R.c(c,0,null);return(c=Ed(c))?Rc.c(a,y,T.d(e,S.a(a,y),c,d,f,Kc([g,h,v],0))):Rc.c(a,y,T.d(d,S.a(a,y),f,g,h,Kc([v],0)))}a.i=6;a.f=function(a){var c=G(a);a=K(a);var d=G(a);a=K(a);var e=G(a);a=K(a);var f=G(a);a=K(a);var g=
G(a);a=K(a);var v=G(a);a=H(a);return b(c,d,e,f,g,v,a)};a.d=b;return a}(),e=function(e,h,l,m,p,q,s){switch(arguments.length){case 3:return d.call(this,e,h,l);case 4:return c.call(this,e,h,l,m);case 5:return b.call(this,e,h,l,m,p);case 6:return a.call(this,e,h,l,m,p,q);default:var u=null;if(6<arguments.length){for(var u=0,v=Array(arguments.length-6);u<v.length;)v[u]=arguments[u+6],++u;u=new F(v,0)}return f.d(e,h,l,m,p,q,u)}throw Error("Invalid arity: "+arguments.length);};e.i=6;e.f=f.f;e.c=d;e.n=c;
e.r=b;e.P=a;e.d=f.d;return e}();function ef(a,b){this.u=a;this.e=b}function ff(a){return new ef(a,[null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null])}function gf(a){return new ef(a.u,Fa(a.e))}function hf(a){a=a.g;return 32>a?0:a-1>>>5<<5}function jf(a,b,c){for(;;){if(0===b)return c;var d=ff(a);d.e[0]=c;c=d;b-=5}}
var lf=function kf(b,c,d,e){var f=gf(d),g=b.g-1>>>c&31;5===c?f.e[g]=e:(d=d.e[g],b=null!=d?kf(b,c-5,d,e):jf(null,c-5,e),f.e[g]=b);return f};function mf(a,b){throw Error([z("No item "),z(a),z(" in vector of length "),z(b)].join(""));}function nf(a,b){if(b>=hf(a))return a.W;for(var c=a.root,d=a.shift;;)if(0<d)var e=d-5,c=c.e[b>>>d&31],d=e;else return c.e}function of(a,b){return 0<=b&&b<a.g?nf(a,b):mf(b,a.g)}
var qf=function pf(b,c,d,e,f){var g=gf(d);if(0===c)g.e[e&31]=f;else{var h=e>>>c&31;b=pf(b,c-5,d.e[h],e,f);g.e[h]=b}return g},sf=function rf(b,c,d){var e=b.g-2>>>c&31;if(5<c){b=rf(b,c-5,d.e[e]);if(null==b&&0===e)return null;d=gf(d);d.e[e]=b;return d}if(0===e)return null;d=gf(d);d.e[e]=null;return d};function tf(a,b,c,d,e,f){this.m=a;this.zb=b;this.e=c;this.oa=d;this.start=e;this.end=f}tf.prototype.ga=function(){return this.m<this.end};
tf.prototype.next=function(){32===this.m-this.zb&&(this.e=nf(this.oa,this.m),this.zb+=32);var a=this.e[this.m&31];this.m+=1;return a};function W(a,b,c,d,e,f){this.k=a;this.g=b;this.shift=c;this.root=d;this.W=e;this.p=f;this.j=167668511;this.q=8196}k=W.prototype;k.toString=function(){return ec(this)};k.t=function(a,b){return $a.c(this,b,null)};k.s=function(a,b,c){return"number"===typeof b?C.c(this,b,c):c};
k.gb=function(a,b,c){a=0;for(var d=c;;)if(a<this.g){var e=nf(this,a);c=e.length;a:{for(var f=0;;)if(f<c){var g=f+a,h=e[f],d=b.c?b.c(d,g,h):b.call(null,d,g,h);if(Ac(d)){e=d;break a}f+=1}else{e=d;break a}e=void 0}if(Ac(e))return b=e,L.b?L.b(b):L.call(null,b);a+=c;d=e}else return d};k.Q=function(a,b){return of(this,b)[b&31]};k.$=function(a,b,c){return 0<=b&&b<this.g?nf(this,b)[b&31]:c};
k.Ua=function(a,b,c){if(0<=b&&b<this.g)return hf(this)<=b?(a=Fa(this.W),a[b&31]=c,new W(this.k,this.g,this.shift,this.root,a,null)):new W(this.k,this.g,this.shift,qf(this,this.shift,this.root,b,c),this.W,null);if(b===this.g)return Ra(this,c);throw Error([z("Index "),z(b),z(" out of bounds  [0,"),z(this.g),z("]")].join(""));};k.vb=!0;k.fb=function(){var a=this.g;return new tf(0,0,0<Q(this)?nf(this,0):null,this,0,a)};k.H=function(){return this.k};k.L=function(){return this.g};
k.hb=function(){return C.a(this,0)};k.ib=function(){return C.a(this,1)};k.La=function(){return 0<this.g?C.a(this,this.g-1):null};
k.Ma=function(){if(0===this.g)throw Error("Can't pop empty vector");if(1===this.g)return ub(Mc,this.k);if(1<this.g-hf(this))return new W(this.k,this.g-1,this.shift,this.root,this.W.slice(0,-1),null);var a=nf(this,this.g-2),b=sf(this,this.shift,this.root),b=null==b?uf:b,c=this.g-1;return 5<this.shift&&null==b.e[1]?new W(this.k,c,this.shift-5,b.e[0],a,null):new W(this.k,c,this.shift,b,a,null)};k.ab=function(){return 0<this.g?new Hc(this,this.g-1,null):null};
k.B=function(){var a=this.p;return null!=a?a:this.p=a=wc(this)};k.A=function(a,b){if(b instanceof W)if(this.g===Q(b))for(var c=cc(this),d=cc(b);;)if(t(c.ga())){var e=c.next(),f=d.next();if(!sc.a(e,f))return!1}else return!0;else return!1;else return Ic(this,b)};k.$a=function(){var a=this;return new vf(a.g,a.shift,function(){var b=a.root;return wf.b?wf.b(b):wf.call(null,b)}(),function(){var b=a.W;return xf.b?xf.b(b):xf.call(null,b)}())};k.J=function(){return O(Mc,this.k)};
k.R=function(a,b){return Cc.a(this,b)};k.O=function(a,b,c){a=0;for(var d=c;;)if(a<this.g){var e=nf(this,a);c=e.length;a:{for(var f=0;;)if(f<c){var g=e[f],d=b.a?b.a(d,g):b.call(null,d,g);if(Ac(d)){e=d;break a}f+=1}else{e=d;break a}e=void 0}if(Ac(e))return b=e,L.b?L.b(b):L.call(null,b);a+=c;d=e}else return d};k.Ka=function(a,b,c){if("number"===typeof b)return pb(this,b,c);throw Error("Vector's key for assoc must be a number.");};
k.D=function(){if(0===this.g)return null;if(32>=this.g)return new F(this.W,0);var a;a:{a=this.root;for(var b=this.shift;;)if(0<b)b-=5,a=a.e[0];else{a=a.e;break a}a=void 0}return yf.n?yf.n(this,a,0,0):yf.call(null,this,a,0,0)};k.F=function(a,b){return new W(b,this.g,this.shift,this.root,this.W,this.p)};
k.G=function(a,b){if(32>this.g-hf(this)){for(var c=this.W.length,d=Array(c+1),e=0;;)if(e<c)d[e]=this.W[e],e+=1;else break;d[c]=b;return new W(this.k,this.g+1,this.shift,this.root,d,null)}c=(d=this.g>>>5>1<<this.shift)?this.shift+5:this.shift;d?(d=ff(null),d.e[0]=this.root,e=jf(null,this.shift,new ef(null,this.W)),d.e[1]=e):d=lf(this,this.shift,this.root,new ef(null,this.W));return new W(this.k,this.g+1,c,d,[b],null)};
k.call=function(){var a=null,a=function(a,c,d){switch(arguments.length){case 2:return this.Q(null,c);case 3:return this.$(null,c,d)}throw Error("Invalid arity: "+arguments.length);};a.a=function(a,c){return this.Q(null,c)};a.c=function(a,c,d){return this.$(null,c,d)};return a}();k.apply=function(a,b){return this.call.apply(this,[this].concat(Fa(b)))};k.b=function(a){return this.Q(null,a)};k.a=function(a,b){return this.$(null,a,b)};
var uf=new ef(null,[null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null]),Mc=new W(null,0,5,uf,[],0);W.prototype[Ea]=function(){return uc(this)};function zf(a){return Qb(A.c(Pb,Ob(Mc),a))}
var Af=function(){function a(a){var d=null;if(0<arguments.length){for(var d=0,e=Array(arguments.length-0);d<e.length;)e[d]=arguments[d+0],++d;d=new F(e,0)}return b.call(this,d)}function b(a){if(a instanceof F&&0===a.m)a:{a=a.e;var b=a.length;if(32>b)a=new W(null,b,5,uf,a,null);else{for(var e=32,f=(new W(null,32,5,uf,a.slice(0,32),null)).$a(null);;)if(e<b)var g=e+1,f=de.a(f,a[e]),e=g;else{a=Qb(f);break a}a=void 0}}else a=zf(a);return a}a.i=0;a.f=function(a){a=D(a);return b(a)};a.d=b;return a}();
function Bf(a,b,c,d,e,f){this.ha=a;this.Ja=b;this.m=c;this.V=d;this.k=e;this.p=f;this.j=32375020;this.q=1536}k=Bf.prototype;k.toString=function(){return ec(this)};k.H=function(){return this.k};k.T=function(){if(this.V+1<this.Ja.length){var a;a=this.ha;var b=this.Ja,c=this.m,d=this.V+1;a=yf.n?yf.n(a,b,c,d):yf.call(null,a,b,c,d);return null==a?null:a}return $b(this)};k.B=function(){var a=this.p;return null!=a?a:this.p=a=wc(this)};k.A=function(a,b){return Ic(this,b)};k.J=function(){return O(Mc,this.k)};
k.R=function(a,b){var c=this;return Cc.a(function(){var a=c.ha,b=c.m+c.V,f=Q(c.ha);return Cf.c?Cf.c(a,b,f):Cf.call(null,a,b,f)}(),b)};k.O=function(a,b,c){var d=this;return Cc.c(function(){var a=d.ha,b=d.m+d.V,c=Q(d.ha);return Cf.c?Cf.c(a,b,c):Cf.call(null,a,b,c)}(),b,c)};k.N=function(){return this.Ja[this.V]};k.S=function(){if(this.V+1<this.Ja.length){var a;a=this.ha;var b=this.Ja,c=this.m,d=this.V+1;a=yf.n?yf.n(a,b,c,d):yf.call(null,a,b,c,d);return null==a?J:a}return Zb(this)};k.D=function(){return this};
k.Cb=function(){return Ud.a(this.Ja,this.V)};k.Db=function(){var a=this.m+this.Ja.length;if(a<Ma(this.ha)){var b=this.ha,c=nf(this.ha,a);return yf.n?yf.n(b,c,a,0):yf.call(null,b,c,a,0)}return J};k.F=function(a,b){var c=this.ha,d=this.Ja,e=this.m,f=this.V;return yf.r?yf.r(c,d,e,f,b):yf.call(null,c,d,e,f,b)};k.G=function(a,b){return M(b,this)};k.Bb=function(){var a=this.m+this.Ja.length;if(a<Ma(this.ha)){var b=this.ha,c=nf(this.ha,a);return yf.n?yf.n(b,c,a,0):yf.call(null,b,c,a,0)}return null};
Bf.prototype[Ea]=function(){return uc(this)};var yf=function(){function a(a,b,c,d,l){return new Bf(a,b,c,d,l,null)}function b(a,b,c,d){return new Bf(a,b,c,d,null,null)}function c(a,b,c){return new Bf(a,of(a,b),b,c,null,null)}var d=null,d=function(d,f,g,h,l){switch(arguments.length){case 3:return c.call(this,d,f,g);case 4:return b.call(this,d,f,g,h);case 5:return a.call(this,d,f,g,h,l)}throw Error("Invalid arity: "+arguments.length);};d.c=c;d.n=b;d.r=a;return d}();
function Df(a,b,c,d,e){this.k=a;this.oa=b;this.start=c;this.end=d;this.p=e;this.j=166617887;this.q=8192}k=Df.prototype;k.toString=function(){return ec(this)};k.t=function(a,b){return $a.c(this,b,null)};k.s=function(a,b,c){return"number"===typeof b?C.c(this,b,c):c};k.Q=function(a,b){return 0>b||this.end<=this.start+b?mf(b,this.end-this.start):C.a(this.oa,this.start+b)};k.$=function(a,b,c){return 0>b||this.end<=this.start+b?c:C.c(this.oa,this.start+b,c)};
k.Ua=function(a,b,c){var d=this.start+b;a=this.k;c=Rc.c(this.oa,d,c);b=this.start;var e=this.end,d=d+1,d=e>d?e:d;return Ef.r?Ef.r(a,c,b,d,null):Ef.call(null,a,c,b,d,null)};k.H=function(){return this.k};k.L=function(){return this.end-this.start};k.La=function(){return C.a(this.oa,this.end-1)};k.Ma=function(){if(this.start===this.end)throw Error("Can't pop empty vector");var a=this.k,b=this.oa,c=this.start,d=this.end-1;return Ef.r?Ef.r(a,b,c,d,null):Ef.call(null,a,b,c,d,null)};
k.ab=function(){return this.start!==this.end?new Hc(this,this.end-this.start-1,null):null};k.B=function(){var a=this.p;return null!=a?a:this.p=a=wc(this)};k.A=function(a,b){return Ic(this,b)};k.J=function(){return O(Mc,this.k)};k.R=function(a,b){return Cc.a(this,b)};k.O=function(a,b,c){return Cc.c(this,b,c)};k.Ka=function(a,b,c){if("number"===typeof b)return pb(this,b,c);throw Error("Subvec's key for assoc must be a number.");};
k.D=function(){var a=this;return function(b){return function d(e){return e===a.end?null:M(C.a(a.oa,e),new V(null,function(){return function(){return d(e+1)}}(b),null,null))}}(this)(a.start)};k.F=function(a,b){var c=this.oa,d=this.start,e=this.end,f=this.p;return Ef.r?Ef.r(b,c,d,e,f):Ef.call(null,b,c,d,e,f)};k.G=function(a,b){var c=this.k,d=pb(this.oa,this.end,b),e=this.start,f=this.end+1;return Ef.r?Ef.r(c,d,e,f,null):Ef.call(null,c,d,e,f,null)};
k.call=function(){var a=null,a=function(a,c,d){switch(arguments.length){case 2:return this.Q(null,c);case 3:return this.$(null,c,d)}throw Error("Invalid arity: "+arguments.length);};a.a=function(a,c){return this.Q(null,c)};a.c=function(a,c,d){return this.$(null,c,d)};return a}();k.apply=function(a,b){return this.call.apply(this,[this].concat(Fa(b)))};k.b=function(a){return this.Q(null,a)};k.a=function(a,b){return this.$(null,a,b)};Df.prototype[Ea]=function(){return uc(this)};
function Ef(a,b,c,d,e){for(;;)if(b instanceof Df)c=b.start+c,d=b.start+d,b=b.oa;else{var f=Q(b);if(0>c||0>d||c>f||d>f)throw Error("Index out of bounds");return new Df(a,b,c,d,e)}}var Cf=function(){function a(a,b,c){return Ef(null,a,b,c,null)}function b(a,b){return c.c(a,b,Q(a))}var c=null,c=function(c,e,f){switch(arguments.length){case 2:return b.call(this,c,e);case 3:return a.call(this,c,e,f)}throw Error("Invalid arity: "+arguments.length);};c.a=b;c.c=a;return c}();
function Ff(a,b){return a===b.u?b:new ef(a,Fa(b.e))}function wf(a){return new ef({},Fa(a.e))}function xf(a){var b=[null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null];hd(a,0,b,0,a.length);return b}
var Hf=function Gf(b,c,d,e){d=Ff(b.root.u,d);var f=b.g-1>>>c&31;if(5===c)b=e;else{var g=d.e[f];b=null!=g?Gf(b,c-5,g,e):jf(b.root.u,c-5,e)}d.e[f]=b;return d},Jf=function If(b,c,d){d=Ff(b.root.u,d);var e=b.g-2>>>c&31;if(5<c){b=If(b,c-5,d.e[e]);if(null==b&&0===e)return null;d.e[e]=b;return d}if(0===e)return null;d.e[e]=null;return d};function vf(a,b,c,d){this.g=a;this.shift=b;this.root=c;this.W=d;this.j=275;this.q=88}k=vf.prototype;
k.call=function(){var a=null,a=function(a,c,d){switch(arguments.length){case 2:return this.t(null,c);case 3:return this.s(null,c,d)}throw Error("Invalid arity: "+arguments.length);};a.a=function(a,c){return this.t(null,c)};a.c=function(a,c,d){return this.s(null,c,d)};return a}();k.apply=function(a,b){return this.call.apply(this,[this].concat(Fa(b)))};k.b=function(a){return this.t(null,a)};k.a=function(a,b){return this.s(null,a,b)};k.t=function(a,b){return $a.c(this,b,null)};
k.s=function(a,b,c){return"number"===typeof b?C.c(this,b,c):c};k.Q=function(a,b){if(this.root.u)return of(this,b)[b&31];throw Error("nth after persistent!");};k.$=function(a,b,c){return 0<=b&&b<this.g?C.a(this,b):c};k.L=function(){if(this.root.u)return this.g;throw Error("count after persistent!");};
k.Ub=function(a,b,c){var d=this;if(d.root.u){if(0<=b&&b<d.g)return hf(this)<=b?d.W[b&31]=c:(a=function(){return function f(a,h){var l=Ff(d.root.u,h);if(0===a)l.e[b&31]=c;else{var m=b>>>a&31,p=f(a-5,l.e[m]);l.e[m]=p}return l}}(this).call(null,d.shift,d.root),d.root=a),this;if(b===d.g)return Pb(this,c);throw Error([z("Index "),z(b),z(" out of bounds for TransientVector of length"),z(d.g)].join(""));}throw Error("assoc! after persistent!");};
k.Vb=function(){if(this.root.u){if(0===this.g)throw Error("Can't pop empty vector");if(1===this.g)this.g=0;else if(0<(this.g-1&31))this.g-=1;else{var a;a:if(a=this.g-2,a>=hf(this))a=this.W;else{for(var b=this.root,c=b,d=this.shift;;)if(0<d)c=Ff(b.u,c.e[a>>>d&31]),d-=5;else{a=c.e;break a}a=void 0}b=Jf(this,this.shift,this.root);b=null!=b?b:new ef(this.root.u,[null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,
null,null,null,null]);5<this.shift&&null==b.e[1]?(this.root=Ff(this.root.u,b.e[0]),this.shift-=5):this.root=b;this.g-=1;this.W=a}return this}throw Error("pop! after persistent!");};k.kb=function(a,b,c){if("number"===typeof b)return Tb(this,b,c);throw Error("TransientVector's key for assoc! must be a number.");};
k.Sa=function(a,b){if(this.root.u){if(32>this.g-hf(this))this.W[this.g&31]=b;else{var c=new ef(this.root.u,this.W),d=[null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null];d[0]=b;this.W=d;if(this.g>>>5>1<<this.shift){var d=[null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null],e=this.shift+
5;d[0]=this.root;d[1]=jf(this.root.u,this.shift,c);this.root=new ef(this.root.u,d);this.shift=e}else this.root=Hf(this,this.shift,this.root,c)}this.g+=1;return this}throw Error("conj! after persistent!");};k.Ta=function(){if(this.root.u){this.root.u=null;var a=this.g-hf(this),b=Array(a);hd(this.W,0,b,0,a);return new W(null,this.g,this.shift,this.root,b,null)}throw Error("persistent! called twice");};function Kf(a,b,c,d){this.k=a;this.ea=b;this.sa=c;this.p=d;this.q=0;this.j=31850572}k=Kf.prototype;
k.toString=function(){return ec(this)};k.H=function(){return this.k};k.B=function(){var a=this.p;return null!=a?a:this.p=a=wc(this)};k.A=function(a,b){return Ic(this,b)};k.J=function(){return O(J,this.k)};k.N=function(){return G(this.ea)};k.S=function(){var a=K(this.ea);return a?new Kf(this.k,a,this.sa,null):null==this.sa?Na(this):new Kf(this.k,this.sa,null,null)};k.D=function(){return this};k.F=function(a,b){return new Kf(b,this.ea,this.sa,this.p)};k.G=function(a,b){return M(b,this)};
Kf.prototype[Ea]=function(){return uc(this)};function Lf(a,b,c,d,e){this.k=a;this.count=b;this.ea=c;this.sa=d;this.p=e;this.j=31858766;this.q=8192}k=Lf.prototype;k.toString=function(){return ec(this)};k.H=function(){return this.k};k.L=function(){return this.count};k.La=function(){return G(this.ea)};k.Ma=function(){if(t(this.ea)){var a=K(this.ea);return a?new Lf(this.k,this.count-1,a,this.sa,null):new Lf(this.k,this.count-1,D(this.sa),Mc,null)}return this};
k.B=function(){var a=this.p;return null!=a?a:this.p=a=wc(this)};k.A=function(a,b){return Ic(this,b)};k.J=function(){return O(Mf,this.k)};k.N=function(){return G(this.ea)};k.S=function(){return H(D(this))};k.D=function(){var a=D(this.sa),b=this.ea;return t(t(b)?b:a)?new Kf(null,this.ea,D(a),null):null};k.F=function(a,b){return new Lf(b,this.count,this.ea,this.sa,this.p)};
k.G=function(a,b){var c;t(this.ea)?(c=this.sa,c=new Lf(this.k,this.count+1,this.ea,Nc.a(t(c)?c:Mc,b),null)):c=new Lf(this.k,this.count+1,Nc.a(this.ea,b),Mc,null);return c};var Mf=new Lf(null,0,null,Mc,0);Lf.prototype[Ea]=function(){return uc(this)};function Nf(){this.q=0;this.j=2097152}Nf.prototype.A=function(){return!1};var Of=new Nf;function Pf(a,b){return md(dd(b)?Q(a)===Q(b)?Ee(ud,Oe.a(function(a){return sc.a(S.c(b,G(a),Of),Lc(a))},a)):null:null)}
function Qf(a,b){var c=a.e;if(b instanceof U)a:{for(var d=c.length,e=b.pa,f=0;;){if(d<=f){c=-1;break a}var g=c[f];if(g instanceof U&&e===g.pa){c=f;break a}f+=2}c=void 0}else if(d="string"==typeof b,t(t(d)?d:"number"===typeof b))a:{d=c.length;for(e=0;;){if(d<=e){c=-1;break a}if(b===c[e]){c=e;break a}e+=2}c=void 0}else if(b instanceof qc)a:{d=c.length;e=b.ta;for(f=0;;){if(d<=f){c=-1;break a}g=c[f];if(g instanceof qc&&e===g.ta){c=f;break a}f+=2}c=void 0}else if(null==b)a:{d=c.length;for(e=0;;){if(d<=
e){c=-1;break a}if(null==c[e]){c=e;break a}e+=2}c=void 0}else a:{d=c.length;for(e=0;;){if(d<=e){c=-1;break a}if(sc.a(b,c[e])){c=e;break a}e+=2}c=void 0}return c}function Rf(a,b,c){this.e=a;this.m=b;this.Z=c;this.q=0;this.j=32374990}k=Rf.prototype;k.toString=function(){return ec(this)};k.H=function(){return this.Z};k.T=function(){return this.m<this.e.length-2?new Rf(this.e,this.m+2,this.Z):null};k.L=function(){return(this.e.length-this.m)/2};k.B=function(){return wc(this)};
k.A=function(a,b){return Ic(this,b)};k.J=function(){return O(J,this.Z)};k.R=function(a,b){return P.a(b,this)};k.O=function(a,b,c){return P.c(b,c,this)};k.N=function(){return new W(null,2,5,uf,[this.e[this.m],this.e[this.m+1]],null)};k.S=function(){return this.m<this.e.length-2?new Rf(this.e,this.m+2,this.Z):J};k.D=function(){return this};k.F=function(a,b){return new Rf(this.e,this.m,b)};k.G=function(a,b){return M(b,this)};Rf.prototype[Ea]=function(){return uc(this)};
function Sf(a,b,c){this.e=a;this.m=b;this.g=c}Sf.prototype.ga=function(){return this.m<this.g};Sf.prototype.next=function(){var a=new W(null,2,5,uf,[this.e[this.m],this.e[this.m+1]],null);this.m+=2;return a};function pa(a,b,c,d){this.k=a;this.g=b;this.e=c;this.p=d;this.j=16647951;this.q=8196}k=pa.prototype;k.toString=function(){return ec(this)};k.t=function(a,b){return $a.c(this,b,null)};k.s=function(a,b,c){a=Qf(this,b);return-1===a?c:this.e[a+1]};
k.gb=function(a,b,c){a=this.e.length;for(var d=0;;)if(d<a){var e=this.e[d],f=this.e[d+1];c=b.c?b.c(c,e,f):b.call(null,c,e,f);if(Ac(c))return b=c,L.b?L.b(b):L.call(null,b);d+=2}else return c};k.vb=!0;k.fb=function(){return new Sf(this.e,0,2*this.g)};k.H=function(){return this.k};k.L=function(){return this.g};k.B=function(){var a=this.p;return null!=a?a:this.p=a=xc(this)};
k.A=function(a,b){if(b&&(b.j&1024||b.ic)){var c=this.e.length;if(this.g===b.L(null))for(var d=0;;)if(d<c){var e=b.s(null,this.e[d],jd);if(e!==jd)if(sc.a(this.e[d+1],e))d+=2;else return!1;else return!1}else return!0;else return!1}else return Pf(this,b)};k.$a=function(){return new Tf({},this.e.length,Fa(this.e))};k.J=function(){return ub(Uf,this.k)};k.R=function(a,b){return P.a(b,this)};k.O=function(a,b,c){return P.c(b,c,this)};
k.wb=function(a,b){if(0<=Qf(this,b)){var c=this.e.length,d=c-2;if(0===d)return Na(this);for(var d=Array(d),e=0,f=0;;){if(e>=c)return new pa(this.k,this.g-1,d,null);sc.a(b,this.e[e])||(d[f]=this.e[e],d[f+1]=this.e[e+1],f+=2);e+=2}}else return this};
k.Ka=function(a,b,c){a=Qf(this,b);if(-1===a){if(this.g<Vf){a=this.e;for(var d=a.length,e=Array(d+2),f=0;;)if(f<d)e[f]=a[f],f+=1;else break;e[d]=b;e[d+1]=c;return new pa(this.k,this.g+1,e,null)}return ub(cb(af.a(Qc,this),b,c),this.k)}if(c===this.e[a+1])return this;b=Fa(this.e);b[a+1]=c;return new pa(this.k,this.g,b,null)};k.rb=function(a,b){return-1!==Qf(this,b)};k.D=function(){var a=this.e;return 0<=a.length-2?new Rf(a,0,null):null};k.F=function(a,b){return new pa(b,this.g,this.e,this.p)};
k.G=function(a,b){if(ed(b))return cb(this,C.a(b,0),C.a(b,1));for(var c=this,d=D(b);;){if(null==d)return c;var e=G(d);if(ed(e))c=cb(c,C.a(e,0),C.a(e,1)),d=K(d);else throw Error("conj on a map takes map entries or seqables of map entries");}};
k.call=function(){var a=null,a=function(a,c,d){switch(arguments.length){case 2:return this.t(null,c);case 3:return this.s(null,c,d)}throw Error("Invalid arity: "+arguments.length);};a.a=function(a,c){return this.t(null,c)};a.c=function(a,c,d){return this.s(null,c,d)};return a}();k.apply=function(a,b){return this.call.apply(this,[this].concat(Fa(b)))};k.b=function(a){return this.t(null,a)};k.a=function(a,b){return this.s(null,a,b)};var Uf=new pa(null,0,[],null),Vf=8;pa.prototype[Ea]=function(){return uc(this)};
function Tf(a,b,c){this.Va=a;this.qa=b;this.e=c;this.q=56;this.j=258}k=Tf.prototype;k.Jb=function(a,b){if(t(this.Va)){var c=Qf(this,b);0<=c&&(this.e[c]=this.e[this.qa-2],this.e[c+1]=this.e[this.qa-1],c=this.e,c.pop(),c.pop(),this.qa-=2);return this}throw Error("dissoc! after persistent!");};
k.kb=function(a,b,c){var d=this;if(t(d.Va)){a=Qf(this,b);if(-1===a)return d.qa+2<=2*Vf?(d.qa+=2,d.e.push(b),d.e.push(c),this):ee.c(function(){var a=d.qa,b=d.e;return Xf.a?Xf.a(a,b):Xf.call(null,a,b)}(),b,c);c!==d.e[a+1]&&(d.e[a+1]=c);return this}throw Error("assoc! after persistent!");};
k.Sa=function(a,b){if(t(this.Va)){if(b?b.j&2048||b.jc||(b.j?0:w(fb,b)):w(fb,b))return Rb(this,Yf.b?Yf.b(b):Yf.call(null,b),Zf.b?Zf.b(b):Zf.call(null,b));for(var c=D(b),d=this;;){var e=G(c);if(t(e))var f=e,c=K(c),d=Rb(d,function(){var a=f;return Yf.b?Yf.b(a):Yf.call(null,a)}(),function(){var a=f;return Zf.b?Zf.b(a):Zf.call(null,a)}());else return d}}else throw Error("conj! after persistent!");};
k.Ta=function(){if(t(this.Va))return this.Va=!1,new pa(null,Cd(this.qa,2),this.e,null);throw Error("persistent! called twice");};k.t=function(a,b){return $a.c(this,b,null)};k.s=function(a,b,c){if(t(this.Va))return a=Qf(this,b),-1===a?c:this.e[a+1];throw Error("lookup after persistent!");};k.L=function(){if(t(this.Va))return Cd(this.qa,2);throw Error("count after persistent!");};function Xf(a,b){for(var c=Ob(Qc),d=0;;)if(d<a)c=ee.c(c,b[d],b[d+1]),d+=2;else return c}function $f(){this.o=!1}
function ag(a,b){return a===b?!0:Nd(a,b)?!0:sc.a(a,b)}var bg=function(){function a(a,b,c,g,h){a=Fa(a);a[b]=c;a[g]=h;return a}function b(a,b,c){a=Fa(a);a[b]=c;return a}var c=null,c=function(c,e,f,g,h){switch(arguments.length){case 3:return b.call(this,c,e,f);case 5:return a.call(this,c,e,f,g,h)}throw Error("Invalid arity: "+arguments.length);};c.c=b;c.r=a;return c}();function cg(a,b){var c=Array(a.length-2);hd(a,0,c,0,2*b);hd(a,2*(b+1),c,2*b,c.length-2*b);return c}
var dg=function(){function a(a,b,c,g,h,l){a=a.Na(b);a.e[c]=g;a.e[h]=l;return a}function b(a,b,c,g){a=a.Na(b);a.e[c]=g;return a}var c=null,c=function(c,e,f,g,h,l){switch(arguments.length){case 4:return b.call(this,c,e,f,g);case 6:return a.call(this,c,e,f,g,h,l)}throw Error("Invalid arity: "+arguments.length);};c.n=b;c.P=a;return c}();
function eg(a,b,c){for(var d=a.length,e=0,f=c;;)if(e<d){c=a[e];if(null!=c){var g=a[e+1];c=b.c?b.c(f,c,g):b.call(null,f,c,g)}else c=a[e+1],c=null!=c?c.Xa(b,f):f;if(Ac(c))return a=c,L.b?L.b(a):L.call(null,a);e+=2;f=c}else return f}function fg(a,b,c){this.u=a;this.w=b;this.e=c}k=fg.prototype;k.Na=function(a){if(a===this.u)return this;var b=Dd(this.w),c=Array(0>b?4:2*(b+1));hd(this.e,0,c,0,2*b);return new fg(a,this.w,c)};
k.nb=function(a,b,c,d,e){var f=1<<(c>>>b&31);if(0===(this.w&f))return this;var g=Dd(this.w&f-1),h=this.e[2*g],l=this.e[2*g+1];return null==h?(b=l.nb(a,b+5,c,d,e),b===l?this:null!=b?dg.n(this,a,2*g+1,b):this.w===f?null:gg(this,a,f,g)):ag(d,h)?(e[0]=!0,gg(this,a,f,g)):this};function gg(a,b,c,d){if(a.w===c)return null;a=a.Na(b);b=a.e;var e=b.length;a.w^=c;hd(b,2*(d+1),b,2*d,e-2*(d+1));b[e-2]=null;b[e-1]=null;return a}k.lb=function(){var a=this.e;return hg.b?hg.b(a):hg.call(null,a)};
k.Xa=function(a,b){return eg(this.e,a,b)};k.Oa=function(a,b,c,d){var e=1<<(b>>>a&31);if(0===(this.w&e))return d;var f=Dd(this.w&e-1),e=this.e[2*f],f=this.e[2*f+1];return null==e?f.Oa(a+5,b,c,d):ag(c,e)?f:d};
k.la=function(a,b,c,d,e,f){var g=1<<(c>>>b&31),h=Dd(this.w&g-1);if(0===(this.w&g)){var l=Dd(this.w);if(2*l<this.e.length){var m=this.Na(a),p=m.e;f.o=!0;id(p,2*h,p,2*(h+1),2*(l-h));p[2*h]=d;p[2*h+1]=e;m.w|=g;return m}if(16<=l){g=[null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null];g[c>>>b&31]=ig.la(a,b+5,c,d,e,f);for(m=h=0;;)if(32>h)0!==(this.w>>>h&1)&&(g[h]=null!=this.e[m]?ig.la(a,b+5,nc(this.e[m]),
this.e[m],this.e[m+1],f):this.e[m+1],m+=2),h+=1;else break;return new jg(a,l+1,g)}p=Array(2*(l+4));hd(this.e,0,p,0,2*h);p[2*h]=d;p[2*h+1]=e;hd(this.e,2*h,p,2*(h+1),2*(l-h));f.o=!0;m=this.Na(a);m.e=p;m.w|=g;return m}var q=this.e[2*h],s=this.e[2*h+1];if(null==q)return l=s.la(a,b+5,c,d,e,f),l===s?this:dg.n(this,a,2*h+1,l);if(ag(d,q))return e===s?this:dg.n(this,a,2*h+1,e);f.o=!0;return dg.P(this,a,2*h,null,2*h+1,function(){var f=b+5;return kg.ia?kg.ia(a,f,q,s,c,d,e):kg.call(null,a,f,q,s,c,d,e)}())};
k.ka=function(a,b,c,d,e){var f=1<<(b>>>a&31),g=Dd(this.w&f-1);if(0===(this.w&f)){var h=Dd(this.w);if(16<=h){f=[null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null];f[b>>>a&31]=ig.ka(a+5,b,c,d,e);for(var l=g=0;;)if(32>g)0!==(this.w>>>g&1)&&(f[g]=null!=this.e[l]?ig.ka(a+5,nc(this.e[l]),this.e[l],this.e[l+1],e):this.e[l+1],l+=2),g+=1;else break;return new jg(null,h+1,f)}l=Array(2*(h+1));hd(this.e,
0,l,0,2*g);l[2*g]=c;l[2*g+1]=d;hd(this.e,2*g,l,2*(g+1),2*(h-g));e.o=!0;return new fg(null,this.w|f,l)}var m=this.e[2*g],p=this.e[2*g+1];if(null==m)return h=p.ka(a+5,b,c,d,e),h===p?this:new fg(null,this.w,bg.c(this.e,2*g+1,h));if(ag(c,m))return d===p?this:new fg(null,this.w,bg.c(this.e,2*g+1,d));e.o=!0;return new fg(null,this.w,bg.r(this.e,2*g,null,2*g+1,function(){var e=a+5;return kg.P?kg.P(e,m,p,b,c,d):kg.call(null,e,m,p,b,c,d)}()))};
k.mb=function(a,b,c){var d=1<<(b>>>a&31);if(0===(this.w&d))return this;var e=Dd(this.w&d-1),f=this.e[2*e],g=this.e[2*e+1];return null==f?(a=g.mb(a+5,b,c),a===g?this:null!=a?new fg(null,this.w,bg.c(this.e,2*e+1,a)):this.w===d?null:new fg(null,this.w^d,cg(this.e,e))):ag(c,f)?new fg(null,this.w^d,cg(this.e,e)):this};var ig=new fg(null,0,[]);
function lg(a,b,c){var d=a.e,e=d.length;a=Array(2*(a.g-1));for(var f=0,g=1,h=0;;)if(f<e)f!==c&&null!=d[f]&&(a[g]=d[f],g+=2,h|=1<<f),f+=1;else return new fg(b,h,a)}function jg(a,b,c){this.u=a;this.g=b;this.e=c}k=jg.prototype;k.Na=function(a){return a===this.u?this:new jg(a,this.g,Fa(this.e))};
k.nb=function(a,b,c,d,e){var f=c>>>b&31,g=this.e[f];if(null==g)return this;b=g.nb(a,b+5,c,d,e);if(b===g)return this;if(null==b){if(8>=this.g)return lg(this,a,f);a=dg.n(this,a,f,b);a.g-=1;return a}return dg.n(this,a,f,b)};k.lb=function(){var a=this.e;return mg.b?mg.b(a):mg.call(null,a)};k.Xa=function(a,b){for(var c=this.e.length,d=0,e=b;;)if(d<c){var f=this.e[d];if(null!=f&&(e=f.Xa(a,e),Ac(e)))return c=e,L.b?L.b(c):L.call(null,c);d+=1}else return e};
k.Oa=function(a,b,c,d){var e=this.e[b>>>a&31];return null!=e?e.Oa(a+5,b,c,d):d};k.la=function(a,b,c,d,e,f){var g=c>>>b&31,h=this.e[g];if(null==h)return a=dg.n(this,a,g,ig.la(a,b+5,c,d,e,f)),a.g+=1,a;b=h.la(a,b+5,c,d,e,f);return b===h?this:dg.n(this,a,g,b)};k.ka=function(a,b,c,d,e){var f=b>>>a&31,g=this.e[f];if(null==g)return new jg(null,this.g+1,bg.c(this.e,f,ig.ka(a+5,b,c,d,e)));a=g.ka(a+5,b,c,d,e);return a===g?this:new jg(null,this.g,bg.c(this.e,f,a))};
k.mb=function(a,b,c){var d=b>>>a&31,e=this.e[d];return null!=e?(a=e.mb(a+5,b,c),a===e?this:null==a?8>=this.g?lg(this,null,d):new jg(null,this.g-1,bg.c(this.e,d,a)):new jg(null,this.g,bg.c(this.e,d,a))):this};function ng(a,b,c){b*=2;for(var d=0;;)if(d<b){if(ag(c,a[d]))return d;d+=2}else return-1}function og(a,b,c,d){this.u=a;this.Ia=b;this.g=c;this.e=d}k=og.prototype;k.Na=function(a){if(a===this.u)return this;var b=Array(2*(this.g+1));hd(this.e,0,b,0,2*this.g);return new og(a,this.Ia,this.g,b)};
k.nb=function(a,b,c,d,e){b=ng(this.e,this.g,d);if(-1===b)return this;e[0]=!0;if(1===this.g)return null;a=this.Na(a);e=a.e;e[b]=e[2*this.g-2];e[b+1]=e[2*this.g-1];e[2*this.g-1]=null;e[2*this.g-2]=null;a.g-=1;return a};k.lb=function(){var a=this.e;return hg.b?hg.b(a):hg.call(null,a)};k.Xa=function(a,b){return eg(this.e,a,b)};k.Oa=function(a,b,c,d){a=ng(this.e,this.g,c);return 0>a?d:ag(c,this.e[a])?this.e[a+1]:d};
k.la=function(a,b,c,d,e,f){if(c===this.Ia){b=ng(this.e,this.g,d);if(-1===b){if(this.e.length>2*this.g)return a=dg.P(this,a,2*this.g,d,2*this.g+1,e),f.o=!0,a.g+=1,a;c=this.e.length;b=Array(c+2);hd(this.e,0,b,0,c);b[c]=d;b[c+1]=e;f.o=!0;f=this.g+1;a===this.u?(this.e=b,this.g=f,a=this):a=new og(this.u,this.Ia,f,b);return a}return this.e[b+1]===e?this:dg.n(this,a,b+1,e)}return(new fg(a,1<<(this.Ia>>>b&31),[null,this,null,null])).la(a,b,c,d,e,f)};
k.ka=function(a,b,c,d,e){return b===this.Ia?(a=ng(this.e,this.g,c),-1===a?(a=2*this.g,b=Array(a+2),hd(this.e,0,b,0,a),b[a]=c,b[a+1]=d,e.o=!0,new og(null,this.Ia,this.g+1,b)):sc.a(this.e[a],d)?this:new og(null,this.Ia,this.g,bg.c(this.e,a+1,d))):(new fg(null,1<<(this.Ia>>>a&31),[null,this])).ka(a,b,c,d,e)};k.mb=function(a,b,c){a=ng(this.e,this.g,c);return-1===a?this:1===this.g?null:new og(null,this.Ia,this.g-1,cg(this.e,Cd(a,2)))};
var kg=function(){function a(a,b,c,g,h,l,m){var p=nc(c);if(p===h)return new og(null,p,2,[c,g,l,m]);var q=new $f;return ig.la(a,b,p,c,g,q).la(a,b,h,l,m,q)}function b(a,b,c,g,h,l){var m=nc(b);if(m===g)return new og(null,m,2,[b,c,h,l]);var p=new $f;return ig.ka(a,m,b,c,p).ka(a,g,h,l,p)}var c=null,c=function(c,e,f,g,h,l,m){switch(arguments.length){case 6:return b.call(this,c,e,f,g,h,l);case 7:return a.call(this,c,e,f,g,h,l,m)}throw Error("Invalid arity: "+arguments.length);};c.P=b;c.ia=a;return c}();
function pg(a,b,c,d,e){this.k=a;this.Pa=b;this.m=c;this.C=d;this.p=e;this.q=0;this.j=32374860}k=pg.prototype;k.toString=function(){return ec(this)};k.H=function(){return this.k};k.B=function(){var a=this.p;return null!=a?a:this.p=a=wc(this)};k.A=function(a,b){return Ic(this,b)};k.J=function(){return O(J,this.k)};k.R=function(a,b){return P.a(b,this)};k.O=function(a,b,c){return P.c(b,c,this)};k.N=function(){return null==this.C?new W(null,2,5,uf,[this.Pa[this.m],this.Pa[this.m+1]],null):G(this.C)};
k.S=function(){if(null==this.C){var a=this.Pa,b=this.m+2;return hg.c?hg.c(a,b,null):hg.call(null,a,b,null)}var a=this.Pa,b=this.m,c=K(this.C);return hg.c?hg.c(a,b,c):hg.call(null,a,b,c)};k.D=function(){return this};k.F=function(a,b){return new pg(b,this.Pa,this.m,this.C,this.p)};k.G=function(a,b){return M(b,this)};pg.prototype[Ea]=function(){return uc(this)};
var hg=function(){function a(a,b,c){if(null==c)for(c=a.length;;)if(b<c){if(null!=a[b])return new pg(null,a,b,null,null);var g=a[b+1];if(t(g)&&(g=g.lb(),t(g)))return new pg(null,a,b+2,g,null);b+=2}else return null;else return new pg(null,a,b,c,null)}function b(a){return c.c(a,0,null)}var c=null,c=function(c,e,f){switch(arguments.length){case 1:return b.call(this,c);case 3:return a.call(this,c,e,f)}throw Error("Invalid arity: "+arguments.length);};c.b=b;c.c=a;return c}();
function qg(a,b,c,d,e){this.k=a;this.Pa=b;this.m=c;this.C=d;this.p=e;this.q=0;this.j=32374860}k=qg.prototype;k.toString=function(){return ec(this)};k.H=function(){return this.k};k.B=function(){var a=this.p;return null!=a?a:this.p=a=wc(this)};k.A=function(a,b){return Ic(this,b)};k.J=function(){return O(J,this.k)};k.R=function(a,b){return P.a(b,this)};k.O=function(a,b,c){return P.c(b,c,this)};k.N=function(){return G(this.C)};
k.S=function(){var a=this.Pa,b=this.m,c=K(this.C);return mg.n?mg.n(null,a,b,c):mg.call(null,null,a,b,c)};k.D=function(){return this};k.F=function(a,b){return new qg(b,this.Pa,this.m,this.C,this.p)};k.G=function(a,b){return M(b,this)};qg.prototype[Ea]=function(){return uc(this)};
var mg=function(){function a(a,b,c,g){if(null==g)for(g=b.length;;)if(c<g){var h=b[c];if(t(h)&&(h=h.lb(),t(h)))return new qg(a,b,c+1,h,null);c+=1}else return null;else return new qg(a,b,c,g,null)}function b(a){return c.n(null,a,0,null)}var c=null,c=function(c,e,f,g){switch(arguments.length){case 1:return b.call(this,c);case 4:return a.call(this,c,e,f,g)}throw Error("Invalid arity: "+arguments.length);};c.b=b;c.n=a;return c}();
function rg(a,b,c,d,e,f){this.k=a;this.g=b;this.root=c;this.U=d;this.da=e;this.p=f;this.j=16123663;this.q=8196}k=rg.prototype;k.toString=function(){return ec(this)};k.t=function(a,b){return $a.c(this,b,null)};k.s=function(a,b,c){return null==b?this.U?this.da:c:null==this.root?c:this.root.Oa(0,nc(b),b,c)};k.gb=function(a,b,c){this.U&&(a=this.da,c=b.c?b.c(c,null,a):b.call(null,c,null,a));return Ac(c)?L.b?L.b(c):L.call(null,c):null!=this.root?this.root.Xa(b,c):c};k.H=function(){return this.k};k.L=function(){return this.g};
k.B=function(){var a=this.p;return null!=a?a:this.p=a=xc(this)};k.A=function(a,b){return Pf(this,b)};k.$a=function(){return new sg({},this.root,this.g,this.U,this.da)};k.J=function(){return ub(Qc,this.k)};k.wb=function(a,b){if(null==b)return this.U?new rg(this.k,this.g-1,this.root,!1,null,null):this;if(null==this.root)return this;var c=this.root.mb(0,nc(b),b);return c===this.root?this:new rg(this.k,this.g-1,c,this.U,this.da,null)};
k.Ka=function(a,b,c){if(null==b)return this.U&&c===this.da?this:new rg(this.k,this.U?this.g:this.g+1,this.root,!0,c,null);a=new $f;b=(null==this.root?ig:this.root).ka(0,nc(b),b,c,a);return b===this.root?this:new rg(this.k,a.o?this.g+1:this.g,b,this.U,this.da,null)};k.rb=function(a,b){return null==b?this.U:null==this.root?!1:this.root.Oa(0,nc(b),b,jd)!==jd};k.D=function(){if(0<this.g){var a=null!=this.root?this.root.lb():null;return this.U?M(new W(null,2,5,uf,[null,this.da],null),a):a}return null};
k.F=function(a,b){return new rg(b,this.g,this.root,this.U,this.da,this.p)};k.G=function(a,b){if(ed(b))return cb(this,C.a(b,0),C.a(b,1));for(var c=this,d=D(b);;){if(null==d)return c;var e=G(d);if(ed(e))c=cb(c,C.a(e,0),C.a(e,1)),d=K(d);else throw Error("conj on a map takes map entries or seqables of map entries");}};
k.call=function(){var a=null,a=function(a,c,d){switch(arguments.length){case 2:return this.t(null,c);case 3:return this.s(null,c,d)}throw Error("Invalid arity: "+arguments.length);};a.a=function(a,c){return this.t(null,c)};a.c=function(a,c,d){return this.s(null,c,d)};return a}();k.apply=function(a,b){return this.call.apply(this,[this].concat(Fa(b)))};k.b=function(a){return this.t(null,a)};k.a=function(a,b){return this.s(null,a,b)};var Qc=new rg(null,0,null,!1,null,0);rg.prototype[Ea]=function(){return uc(this)};
function sg(a,b,c,d,e){this.u=a;this.root=b;this.count=c;this.U=d;this.da=e;this.q=56;this.j=258}k=sg.prototype;k.Jb=function(a,b){if(this.u)if(null==b)this.U&&(this.U=!1,this.da=null,this.count-=1);else{if(null!=this.root){var c=new $f,d=this.root.nb(this.u,0,nc(b),b,c);d!==this.root&&(this.root=d);t(c[0])&&(this.count-=1)}}else throw Error("dissoc! after persistent!");return this};k.kb=function(a,b,c){return tg(this,b,c)};k.Sa=function(a,b){return ug(this,b)};
k.Ta=function(){var a;if(this.u)this.u=null,a=new rg(null,this.count,this.root,this.U,this.da,null);else throw Error("persistent! called twice");return a};k.t=function(a,b){return null==b?this.U?this.da:null:null==this.root?null:this.root.Oa(0,nc(b),b)};k.s=function(a,b,c){return null==b?this.U?this.da:c:null==this.root?c:this.root.Oa(0,nc(b),b,c)};k.L=function(){if(this.u)return this.count;throw Error("count after persistent!");};
function ug(a,b){if(a.u){if(b?b.j&2048||b.jc||(b.j?0:w(fb,b)):w(fb,b))return tg(a,Yf.b?Yf.b(b):Yf.call(null,b),Zf.b?Zf.b(b):Zf.call(null,b));for(var c=D(b),d=a;;){var e=G(c);if(t(e))var f=e,c=K(c),d=tg(d,function(){var a=f;return Yf.b?Yf.b(a):Yf.call(null,a)}(),function(){var a=f;return Zf.b?Zf.b(a):Zf.call(null,a)}());else return d}}else throw Error("conj! after persistent");}
function tg(a,b,c){if(a.u){if(null==b)a.da!==c&&(a.da=c),a.U||(a.count+=1,a.U=!0);else{var d=new $f;b=(null==a.root?ig:a.root).la(a.u,0,nc(b),b,c,d);b!==a.root&&(a.root=b);d.o&&(a.count+=1)}return a}throw Error("assoc! after persistent!");}function vg(a,b,c){for(var d=b;;)if(null!=a)b=c?a.left:a.right,d=Nc.a(d,a),a=b;else return d}function wg(a,b,c,d,e){this.k=a;this.stack=b;this.pb=c;this.g=d;this.p=e;this.q=0;this.j=32374862}k=wg.prototype;k.toString=function(){return ec(this)};k.H=function(){return this.k};
k.L=function(){return 0>this.g?Q(K(this))+1:this.g};k.B=function(){var a=this.p;return null!=a?a:this.p=a=wc(this)};k.A=function(a,b){return Ic(this,b)};k.J=function(){return O(J,this.k)};k.R=function(a,b){return P.a(b,this)};k.O=function(a,b,c){return P.c(b,c,this)};k.N=function(){return Wc(this.stack)};k.S=function(){var a=G(this.stack),a=vg(this.pb?a.right:a.left,K(this.stack),this.pb);return null!=a?new wg(null,a,this.pb,this.g-1,null):J};k.D=function(){return this};
k.F=function(a,b){return new wg(b,this.stack,this.pb,this.g,this.p)};k.G=function(a,b){return M(b,this)};wg.prototype[Ea]=function(){return uc(this)};function xg(a,b,c){return new wg(null,vg(a,null,b),b,c,null)}
function yg(a,b,c,d){return c instanceof X?c.left instanceof X?new X(c.key,c.o,c.left.ua(),new Z(a,b,c.right,d,null),null):c.right instanceof X?new X(c.right.key,c.right.o,new Z(c.key,c.o,c.left,c.right.left,null),new Z(a,b,c.right.right,d,null),null):new Z(a,b,c,d,null):new Z(a,b,c,d,null)}
function zg(a,b,c,d){return d instanceof X?d.right instanceof X?new X(d.key,d.o,new Z(a,b,c,d.left,null),d.right.ua(),null):d.left instanceof X?new X(d.left.key,d.left.o,new Z(a,b,c,d.left.left,null),new Z(d.key,d.o,d.left.right,d.right,null),null):new Z(a,b,c,d,null):new Z(a,b,c,d,null)}
function Ag(a,b,c,d){if(c instanceof X)return new X(a,b,c.ua(),d,null);if(d instanceof Z)return zg(a,b,c,d.ob());if(d instanceof X&&d.left instanceof Z)return new X(d.left.key,d.left.o,new Z(a,b,c,d.left.left,null),zg(d.key,d.o,d.left.right,d.right.ob()),null);throw Error("red-black tree invariant violation");}
var Cg=function Bg(b,c,d){d=null!=b.left?Bg(b.left,c,d):d;if(Ac(d))return L.b?L.b(d):L.call(null,d);var e=b.key,f=b.o;d=c.c?c.c(d,e,f):c.call(null,d,e,f);if(Ac(d))return L.b?L.b(d):L.call(null,d);b=null!=b.right?Bg(b.right,c,d):d;return Ac(b)?L.b?L.b(b):L.call(null,b):b};function Z(a,b,c,d,e){this.key=a;this.o=b;this.left=c;this.right=d;this.p=e;this.q=0;this.j=32402207}k=Z.prototype;k.Mb=function(a){return a.Ob(this)};k.ob=function(){return new X(this.key,this.o,this.left,this.right,null)};
k.ua=function(){return this};k.Lb=function(a){return a.Nb(this)};k.replace=function(a,b,c,d){return new Z(a,b,c,d,null)};k.Nb=function(a){return new Z(a.key,a.o,this,a.right,null)};k.Ob=function(a){return new Z(a.key,a.o,a.left,this,null)};k.Xa=function(a,b){return Cg(this,a,b)};k.t=function(a,b){return C.c(this,b,null)};k.s=function(a,b,c){return C.c(this,b,c)};k.Q=function(a,b){return 0===b?this.key:1===b?this.o:null};k.$=function(a,b,c){return 0===b?this.key:1===b?this.o:c};
k.Ua=function(a,b,c){return(new W(null,2,5,uf,[this.key,this.o],null)).Ua(null,b,c)};k.H=function(){return null};k.L=function(){return 2};k.hb=function(){return this.key};k.ib=function(){return this.o};k.La=function(){return this.o};k.Ma=function(){return new W(null,1,5,uf,[this.key],null)};k.B=function(){var a=this.p;return null!=a?a:this.p=a=wc(this)};k.A=function(a,b){return Ic(this,b)};k.J=function(){return Mc};k.R=function(a,b){return Cc.a(this,b)};k.O=function(a,b,c){return Cc.c(this,b,c)};
k.Ka=function(a,b,c){return Rc.c(new W(null,2,5,uf,[this.key,this.o],null),b,c)};k.D=function(){return Ra(Ra(J,this.o),this.key)};k.F=function(a,b){return O(new W(null,2,5,uf,[this.key,this.o],null),b)};k.G=function(a,b){return new W(null,3,5,uf,[this.key,this.o,b],null)};
k.call=function(){var a=null,a=function(a,c,d){switch(arguments.length){case 2:return this.t(null,c);case 3:return this.s(null,c,d)}throw Error("Invalid arity: "+arguments.length);};a.a=function(a,c){return this.t(null,c)};a.c=function(a,c,d){return this.s(null,c,d)};return a}();k.apply=function(a,b){return this.call.apply(this,[this].concat(Fa(b)))};k.b=function(a){return this.t(null,a)};k.a=function(a,b){return this.s(null,a,b)};Z.prototype[Ea]=function(){return uc(this)};
function X(a,b,c,d,e){this.key=a;this.o=b;this.left=c;this.right=d;this.p=e;this.q=0;this.j=32402207}k=X.prototype;k.Mb=function(a){return new X(this.key,this.o,this.left,a,null)};k.ob=function(){throw Error("red-black tree invariant violation");};k.ua=function(){return new Z(this.key,this.o,this.left,this.right,null)};k.Lb=function(a){return new X(this.key,this.o,a,this.right,null)};k.replace=function(a,b,c,d){return new X(a,b,c,d,null)};
k.Nb=function(a){return this.left instanceof X?new X(this.key,this.o,this.left.ua(),new Z(a.key,a.o,this.right,a.right,null),null):this.right instanceof X?new X(this.right.key,this.right.o,new Z(this.key,this.o,this.left,this.right.left,null),new Z(a.key,a.o,this.right.right,a.right,null),null):new Z(a.key,a.o,this,a.right,null)};
k.Ob=function(a){return this.right instanceof X?new X(this.key,this.o,new Z(a.key,a.o,a.left,this.left,null),this.right.ua(),null):this.left instanceof X?new X(this.left.key,this.left.o,new Z(a.key,a.o,a.left,this.left.left,null),new Z(this.key,this.o,this.left.right,this.right,null),null):new Z(a.key,a.o,a.left,this,null)};k.Xa=function(a,b){return Cg(this,a,b)};k.t=function(a,b){return C.c(this,b,null)};k.s=function(a,b,c){return C.c(this,b,c)};
k.Q=function(a,b){return 0===b?this.key:1===b?this.o:null};k.$=function(a,b,c){return 0===b?this.key:1===b?this.o:c};k.Ua=function(a,b,c){return(new W(null,2,5,uf,[this.key,this.o],null)).Ua(null,b,c)};k.H=function(){return null};k.L=function(){return 2};k.hb=function(){return this.key};k.ib=function(){return this.o};k.La=function(){return this.o};k.Ma=function(){return new W(null,1,5,uf,[this.key],null)};k.B=function(){var a=this.p;return null!=a?a:this.p=a=wc(this)};
k.A=function(a,b){return Ic(this,b)};k.J=function(){return Mc};k.R=function(a,b){return Cc.a(this,b)};k.O=function(a,b,c){return Cc.c(this,b,c)};k.Ka=function(a,b,c){return Rc.c(new W(null,2,5,uf,[this.key,this.o],null),b,c)};k.D=function(){return Ra(Ra(J,this.o),this.key)};k.F=function(a,b){return O(new W(null,2,5,uf,[this.key,this.o],null),b)};k.G=function(a,b){return new W(null,3,5,uf,[this.key,this.o,b],null)};
k.call=function(){var a=null,a=function(a,c,d){switch(arguments.length){case 2:return this.t(null,c);case 3:return this.s(null,c,d)}throw Error("Invalid arity: "+arguments.length);};a.a=function(a,c){return this.t(null,c)};a.c=function(a,c,d){return this.s(null,c,d)};return a}();k.apply=function(a,b){return this.call.apply(this,[this].concat(Fa(b)))};k.b=function(a){return this.t(null,a)};k.a=function(a,b){return this.s(null,a,b)};X.prototype[Ea]=function(){return uc(this)};
var Eg=function Dg(b,c,d,e,f){if(null==c)return new X(d,e,null,null,null);var g;g=c.key;g=b.a?b.a(d,g):b.call(null,d,g);if(0===g)return f[0]=c,null;if(0>g)return b=Dg(b,c.left,d,e,f),null!=b?c.Lb(b):null;b=Dg(b,c.right,d,e,f);return null!=b?c.Mb(b):null},Gg=function Fg(b,c){if(null==b)return c;if(null==c)return b;if(b instanceof X){if(c instanceof X){var d=Fg(b.right,c.left);return d instanceof X?new X(d.key,d.o,new X(b.key,b.o,b.left,d.left,null),new X(c.key,c.o,d.right,c.right,null),null):new X(b.key,
b.o,b.left,new X(c.key,c.o,d,c.right,null),null)}return new X(b.key,b.o,b.left,Fg(b.right,c),null)}if(c instanceof X)return new X(c.key,c.o,Fg(b,c.left),c.right,null);d=Fg(b.right,c.left);return d instanceof X?new X(d.key,d.o,new Z(b.key,b.o,b.left,d.left,null),new Z(c.key,c.o,d.right,c.right,null),null):Ag(b.key,b.o,b.left,new Z(c.key,c.o,d,c.right,null))},Ig=function Hg(b,c,d,e){if(null!=c){var f;f=c.key;f=b.a?b.a(d,f):b.call(null,d,f);if(0===f)return e[0]=c,Gg(c.left,c.right);if(0>f)return b=Hg(b,
c.left,d,e),null!=b||null!=e[0]?c.left instanceof Z?Ag(c.key,c.o,b,c.right):new X(c.key,c.o,b,c.right,null):null;b=Hg(b,c.right,d,e);if(null!=b||null!=e[0])if(c.right instanceof Z)if(e=c.key,d=c.o,c=c.left,b instanceof X)c=new X(e,d,c,b.ua(),null);else if(c instanceof Z)c=yg(e,d,c.ob(),b);else if(c instanceof X&&c.right instanceof Z)c=new X(c.right.key,c.right.o,yg(c.key,c.o,c.left.ob(),c.right.left),new Z(e,d,c.right.right,b,null),null);else throw Error("red-black tree invariant violation");else c=
new X(c.key,c.o,c.left,b,null);else c=null;return c}return null},Kg=function Jg(b,c,d,e){var f=c.key,g=b.a?b.a(d,f):b.call(null,d,f);return 0===g?c.replace(f,e,c.left,c.right):0>g?c.replace(f,c.o,Jg(b,c.left,d,e),c.right):c.replace(f,c.o,c.left,Jg(b,c.right,d,e))};function Lg(a,b,c,d,e){this.aa=a;this.na=b;this.g=c;this.k=d;this.p=e;this.j=418776847;this.q=8192}k=Lg.prototype;k.toString=function(){return ec(this)};
function Mg(a,b){for(var c=a.na;;)if(null!=c){var d;d=c.key;d=a.aa.a?a.aa.a(b,d):a.aa.call(null,b,d);if(0===d)return c;c=0>d?c.left:c.right}else return null}k.t=function(a,b){return $a.c(this,b,null)};k.s=function(a,b,c){a=Mg(this,b);return null!=a?a.o:c};k.gb=function(a,b,c){return null!=this.na?Cg(this.na,b,c):c};k.H=function(){return this.k};k.L=function(){return this.g};k.ab=function(){return 0<this.g?xg(this.na,!1,this.g):null};k.B=function(){var a=this.p;return null!=a?a:this.p=a=xc(this)};
k.A=function(a,b){return Pf(this,b)};k.J=function(){return new Lg(this.aa,null,0,this.k,0)};k.wb=function(a,b){var c=[null],d=Ig(this.aa,this.na,b,c);return null==d?null==R.a(c,0)?this:new Lg(this.aa,null,0,this.k,null):new Lg(this.aa,d.ua(),this.g-1,this.k,null)};k.Ka=function(a,b,c){a=[null];var d=Eg(this.aa,this.na,b,c,a);return null==d?(a=R.a(a,0),sc.a(c,a.o)?this:new Lg(this.aa,Kg(this.aa,this.na,b,c),this.g,this.k,null)):new Lg(this.aa,d.ua(),this.g+1,this.k,null)};
k.rb=function(a,b){return null!=Mg(this,b)};k.D=function(){return 0<this.g?xg(this.na,!0,this.g):null};k.F=function(a,b){return new Lg(this.aa,this.na,this.g,b,this.p)};k.G=function(a,b){if(ed(b))return cb(this,C.a(b,0),C.a(b,1));for(var c=this,d=D(b);;){if(null==d)return c;var e=G(d);if(ed(e))c=cb(c,C.a(e,0),C.a(e,1)),d=K(d);else throw Error("conj on a map takes map entries or seqables of map entries");}};
k.call=function(){var a=null,a=function(a,c,d){switch(arguments.length){case 2:return this.t(null,c);case 3:return this.s(null,c,d)}throw Error("Invalid arity: "+arguments.length);};a.a=function(a,c){return this.t(null,c)};a.c=function(a,c,d){return this.s(null,c,d)};return a}();k.apply=function(a,b){return this.call.apply(this,[this].concat(Fa(b)))};k.b=function(a){return this.t(null,a)};k.a=function(a,b){return this.s(null,a,b)};k.Hb=function(a,b){return 0<this.g?xg(this.na,b,this.g):null};
k.Ib=function(a,b,c){if(0<this.g){a=null;for(var d=this.na;;)if(null!=d){var e;e=d.key;e=this.aa.a?this.aa.a(b,e):this.aa.call(null,b,e);if(0===e)return new wg(null,Nc.a(a,d),c,-1,null);t(c)?0>e?(a=Nc.a(a,d),d=d.left):d=d.right:0<e?(a=Nc.a(a,d),d=d.right):d=d.left}else return null==a?null:new wg(null,a,c,-1,null)}else return null};k.Gb=function(a,b){return Yf.b?Yf.b(b):Yf.call(null,b)};k.Fb=function(){return this.aa};var Ng=new Lg(od,null,0,null,0);Lg.prototype[Ea]=function(){return uc(this)};
var Og=function(){function a(a){var d=null;if(0<arguments.length){for(var d=0,e=Array(arguments.length-0);d<e.length;)e[d]=arguments[d+0],++d;d=new F(e,0)}return b.call(this,d)}function b(a){a=D(a);for(var b=Ob(Qc);;)if(a){var e=K(K(a)),b=ee.c(b,G(a),Lc(a));a=e}else return Qb(b)}a.i=0;a.f=function(a){a=D(a);return b(a)};a.d=b;return a}(),Pg=function(){function a(a){var d=null;if(0<arguments.length){for(var d=0,e=Array(arguments.length-0);d<e.length;)e[d]=arguments[d+0],++d;d=new F(e,0)}return b.call(this,
d)}function b(a){a:{a=T.a(Ha,a);for(var b=a.length,e=0,f=Ob(Uf);;)if(e<b)var g=e+2,f=Rb(f,a[e],a[e+1]),e=g;else{a=Qb(f);break a}a=void 0}return a}a.i=0;a.f=function(a){a=D(a);return b(a)};a.d=b;return a}(),Qg=function(){function a(a){var d=null;if(0<arguments.length){for(var d=0,e=Array(arguments.length-0);d<e.length;)e[d]=arguments[d+0],++d;d=new F(e,0)}return b.call(this,d)}function b(a){a=D(a);for(var b=Ng;;)if(a){var e=K(K(a)),b=Rc.c(b,G(a),Lc(a));a=e}else return b}a.i=0;a.f=function(a){a=D(a);
return b(a)};a.d=b;return a}(),Rg=function(){function a(a,d){var e=null;if(1<arguments.length){for(var e=0,f=Array(arguments.length-1);e<f.length;)f[e]=arguments[e+1],++e;e=new F(f,0)}return b.call(this,a,e)}function b(a,b){for(var e=D(b),f=new Lg(qd(a),null,0,null,0);;)if(e)var g=K(K(e)),f=Rc.c(f,G(e),Lc(e)),e=g;else return f}a.i=1;a.f=function(a){var d=G(a);a=H(a);return b(d,a)};a.d=b;return a}();function Sg(a,b){this.Y=a;this.Z=b;this.q=0;this.j=32374988}k=Sg.prototype;k.toString=function(){return ec(this)};
k.H=function(){return this.Z};k.T=function(){var a=this.Y,a=(a?a.j&128||a.xb||(a.j?0:w(Xa,a)):w(Xa,a))?this.Y.T(null):K(this.Y);return null==a?null:new Sg(a,this.Z)};k.B=function(){return wc(this)};k.A=function(a,b){return Ic(this,b)};k.J=function(){return O(J,this.Z)};k.R=function(a,b){return P.a(b,this)};k.O=function(a,b,c){return P.c(b,c,this)};k.N=function(){return this.Y.N(null).hb(null)};
k.S=function(){var a=this.Y,a=(a?a.j&128||a.xb||(a.j?0:w(Xa,a)):w(Xa,a))?this.Y.T(null):K(this.Y);return null!=a?new Sg(a,this.Z):J};k.D=function(){return this};k.F=function(a,b){return new Sg(this.Y,b)};k.G=function(a,b){return M(b,this)};Sg.prototype[Ea]=function(){return uc(this)};function Tg(a){return(a=D(a))?new Sg(a,null):null}function Yf(a){return hb(a)}function Ug(a,b){this.Y=a;this.Z=b;this.q=0;this.j=32374988}k=Ug.prototype;k.toString=function(){return ec(this)};k.H=function(){return this.Z};
k.T=function(){var a=this.Y,a=(a?a.j&128||a.xb||(a.j?0:w(Xa,a)):w(Xa,a))?this.Y.T(null):K(this.Y);return null==a?null:new Ug(a,this.Z)};k.B=function(){return wc(this)};k.A=function(a,b){return Ic(this,b)};k.J=function(){return O(J,this.Z)};k.R=function(a,b){return P.a(b,this)};k.O=function(a,b,c){return P.c(b,c,this)};k.N=function(){return this.Y.N(null).ib(null)};k.S=function(){var a=this.Y,a=(a?a.j&128||a.xb||(a.j?0:w(Xa,a)):w(Xa,a))?this.Y.T(null):K(this.Y);return null!=a?new Ug(a,this.Z):J};
k.D=function(){return this};k.F=function(a,b){return new Ug(this.Y,b)};k.G=function(a,b){return M(b,this)};Ug.prototype[Ea]=function(){return uc(this)};function Vg(a){return(a=D(a))?new Ug(a,null):null}function Zf(a){return ib(a)}
var Wg=function(){function a(a){var d=null;if(0<arguments.length){for(var d=0,e=Array(arguments.length-0);d<e.length;)e[d]=arguments[d+0],++d;d=new F(e,0)}return b.call(this,d)}function b(a){return t(Fe(ud,a))?A.a(function(a,b){return Nc.a(t(a)?a:Uf,b)},a):null}a.i=0;a.f=function(a){a=D(a);return b(a)};a.d=b;return a}(),Xg=function(){function a(a,d){var e=null;if(1<arguments.length){for(var e=0,f=Array(arguments.length-1);e<f.length;)f[e]=arguments[e+1],++e;e=new F(f,0)}return b.call(this,a,e)}function b(a,
b){return t(Fe(ud,b))?A.a(function(a){return function(b,c){return A.c(a,t(b)?b:Uf,D(c))}}(function(b,d){var g=G(d),h=Lc(d);return nd(b,g)?Rc.c(b,g,function(){var d=S.a(b,g);return a.a?a.a(d,h):a.call(null,d,h)}()):Rc.c(b,g,h)}),b):null}a.i=1;a.f=function(a){var d=G(a);a=H(a);return b(d,a)};a.d=b;return a}();function Yg(a,b){for(var c=Uf,d=D(b);;)if(d)var e=G(d),f=S.c(a,e,Zg),c=je.a(f,Zg)?Rc.c(c,e,f):c,d=K(d);else return O(c,Vc(a))}
function $g(a,b,c){this.k=a;this.Wa=b;this.p=c;this.j=15077647;this.q=8196}k=$g.prototype;k.toString=function(){return ec(this)};k.t=function(a,b){return $a.c(this,b,null)};k.s=function(a,b,c){return bb(this.Wa,b)?b:c};k.H=function(){return this.k};k.L=function(){return Ma(this.Wa)};k.B=function(){var a=this.p;return null!=a?a:this.p=a=xc(this)};k.A=function(a,b){return ad(b)&&Q(this)===Q(b)&&Ee(function(a){return function(b){return nd(a,b)}}(this),b)};k.$a=function(){return new ah(Ob(this.Wa))};
k.J=function(){return O(bh,this.k)};k.Eb=function(a,b){return new $g(this.k,eb(this.Wa,b),null)};k.D=function(){return Tg(this.Wa)};k.F=function(a,b){return new $g(b,this.Wa,this.p)};k.G=function(a,b){return new $g(this.k,Rc.c(this.Wa,b,null),null)};
k.call=function(){var a=null,a=function(a,c,d){switch(arguments.length){case 2:return this.t(null,c);case 3:return this.s(null,c,d)}throw Error("Invalid arity: "+arguments.length);};a.a=function(a,c){return this.t(null,c)};a.c=function(a,c,d){return this.s(null,c,d)};return a}();k.apply=function(a,b){return this.call.apply(this,[this].concat(Fa(b)))};k.b=function(a){return this.t(null,a)};k.a=function(a,b){return this.s(null,a,b)};var bh=new $g(null,Uf,0);$g.prototype[Ea]=function(){return uc(this)};
function ah(a){this.ma=a;this.j=259;this.q=136}k=ah.prototype;k.call=function(){function a(a,b,c){return $a.c(this.ma,b,jd)===jd?c:b}function b(a,b){return $a.c(this.ma,b,jd)===jd?null:b}var c=null,c=function(c,e,f){switch(arguments.length){case 2:return b.call(this,c,e);case 3:return a.call(this,c,e,f)}throw Error("Invalid arity: "+arguments.length);};c.a=b;c.c=a;return c}();k.apply=function(a,b){return this.call.apply(this,[this].concat(Fa(b)))};
k.b=function(a){return $a.c(this.ma,a,jd)===jd?null:a};k.a=function(a,b){return $a.c(this.ma,a,jd)===jd?b:a};k.t=function(a,b){return $a.c(this,b,null)};k.s=function(a,b,c){return $a.c(this.ma,b,jd)===jd?c:b};k.L=function(){return Q(this.ma)};k.Tb=function(a,b){this.ma=fe.a(this.ma,b);return this};k.Sa=function(a,b){this.ma=ee.c(this.ma,b,null);return this};k.Ta=function(){return new $g(null,Qb(this.ma),null)};function ch(a,b,c){this.k=a;this.ja=b;this.p=c;this.j=417730831;this.q=8192}k=ch.prototype;
k.toString=function(){return ec(this)};k.t=function(a,b){return $a.c(this,b,null)};k.s=function(a,b,c){a=Mg(this.ja,b);return null!=a?a.key:c};k.H=function(){return this.k};k.L=function(){return Q(this.ja)};k.ab=function(){return 0<Q(this.ja)?Oe.a(Yf,Gb(this.ja)):null};k.B=function(){var a=this.p;return null!=a?a:this.p=a=xc(this)};k.A=function(a,b){return ad(b)&&Q(this)===Q(b)&&Ee(function(a){return function(b){return nd(a,b)}}(this),b)};k.J=function(){return new ch(this.k,Na(this.ja),0)};
k.Eb=function(a,b){return new ch(this.k,Sc.a(this.ja,b),null)};k.D=function(){return Tg(this.ja)};k.F=function(a,b){return new ch(b,this.ja,this.p)};k.G=function(a,b){return new ch(this.k,Rc.c(this.ja,b,null),null)};k.call=function(){var a=null,a=function(a,c,d){switch(arguments.length){case 2:return this.t(null,c);case 3:return this.s(null,c,d)}throw Error("Invalid arity: "+arguments.length);};a.a=function(a,c){return this.t(null,c)};a.c=function(a,c,d){return this.s(null,c,d)};return a}();
k.apply=function(a,b){return this.call.apply(this,[this].concat(Fa(b)))};k.b=function(a){return this.t(null,a)};k.a=function(a,b){return this.s(null,a,b)};k.Hb=function(a,b){return Oe.a(Yf,Hb(this.ja,b))};k.Ib=function(a,b,c){return Oe.a(Yf,Ib(this.ja,b,c))};k.Gb=function(a,b){return b};k.Fb=function(){return Kb(this.ja)};var eh=new ch(null,Ng,0);ch.prototype[Ea]=function(){return uc(this)};
function fh(a){a=D(a);if(null==a)return bh;if(a instanceof F&&0===a.m){a=a.e;a:{for(var b=0,c=Ob(bh);;)if(b<a.length)var d=b+1,c=c.Sa(null,a[b]),b=d;else{a=c;break a}a=void 0}return a.Ta(null)}for(d=Ob(bh);;)if(null!=a)b=a.T(null),d=d.Sa(null,a.N(null)),a=b;else return d.Ta(null)}
var gh=function(){function a(a){var d=null;if(0<arguments.length){for(var d=0,e=Array(arguments.length-0);d<e.length;)e[d]=arguments[d+0],++d;d=new F(e,0)}return b.call(this,d)}function b(a){return A.c(Ra,eh,a)}a.i=0;a.f=function(a){a=D(a);return b(a)};a.d=b;return a}(),hh=function(){function a(a,d){var e=null;if(1<arguments.length){for(var e=0,f=Array(arguments.length-1);e<f.length;)f[e]=arguments[e+1],++e;e=new F(f,0)}return b.call(this,a,e)}function b(a,b){return A.c(Ra,new ch(null,Rg(a),0),b)}
a.i=1;a.f=function(a){var d=G(a);a=H(a);return b(d,a)};a.d=b;return a}();function Od(a){if(a&&(a.q&4096||a.lc))return a.name;if("string"===typeof a)return a;throw Error([z("Doesn't support name: "),z(a)].join(""));}
var ih=function(){function a(a,b,c){return(a.b?a.b(b):a.call(null,b))>(a.b?a.b(c):a.call(null,c))?b:c}var b=null,c=function(){function a(b,d,h,l){var m=null;if(3<arguments.length){for(var m=0,p=Array(arguments.length-3);m<p.length;)p[m]=arguments[m+3],++m;m=new F(p,0)}return c.call(this,b,d,h,m)}function c(a,d,e,l){return A.c(function(c,d){return b.c(a,c,d)},b.c(a,d,e),l)}a.i=3;a.f=function(a){var b=G(a);a=K(a);var d=G(a);a=K(a);var l=G(a);a=H(a);return c(b,d,l,a)};a.d=c;return a}(),b=function(b,
e,f,g){switch(arguments.length){case 2:return e;case 3:return a.call(this,b,e,f);default:var h=null;if(3<arguments.length){for(var h=0,l=Array(arguments.length-3);h<l.length;)l[h]=arguments[h+3],++h;h=new F(l,0)}return c.d(b,e,f,h)}throw Error("Invalid arity: "+arguments.length);};b.i=3;b.f=c.f;b.a=function(a,b){return b};b.c=a;b.d=c.d;return b}();function jh(a){this.e=a}jh.prototype.add=function(a){return this.e.push(a)};jh.prototype.size=function(){return this.e.length};
jh.prototype.clear=function(){return this.e=[]};
var kh=function(){function a(a,b,c){return new V(null,function(){var h=D(c);return h?M(Pe.a(a,h),d.c(a,b,Qe.a(b,h))):null},null,null)}function b(a,b){return d.c(a,a,b)}function c(a){return function(b){return function(c){return function(){function d(h,l){c.add(l);if(a===c.size()){var m=zf(c.e);c.clear();return b.a?b.a(h,m):b.call(null,h,m)}return h}function l(a){if(!t(0===c.e.length)){var d=zf(c.e);c.clear();a=Bc(b.a?b.a(a,d):b.call(null,a,d))}return b.b?b.b(a):b.call(null,a)}function m(){return b.l?
b.l():b.call(null)}var p=null,p=function(a,b){switch(arguments.length){case 0:return m.call(this);case 1:return l.call(this,a);case 2:return d.call(this,a,b)}throw Error("Invalid arity: "+arguments.length);};p.l=m;p.b=l;p.a=d;return p}()}(new jh([]))}}var d=null,d=function(d,f,g){switch(arguments.length){case 1:return c.call(this,d);case 2:return b.call(this,d,f);case 3:return a.call(this,d,f,g)}throw Error("Invalid arity: "+arguments.length);};d.b=c;d.a=b;d.c=a;return d}(),lh=function(){function a(a,
b){return new V(null,function(){var f=D(b);if(f){var g;g=G(f);g=a.b?a.b(g):a.call(null,g);f=t(g)?M(G(f),c.a(a,H(f))):null}else f=null;return f},null,null)}function b(a){return function(b){return function(){function c(f,g){return t(a.b?a.b(g):a.call(null,g))?b.a?b.a(f,g):b.call(null,f,g):new yc(f)}function g(a){return b.b?b.b(a):b.call(null,a)}function h(){return b.l?b.l():b.call(null)}var l=null,l=function(a,b){switch(arguments.length){case 0:return h.call(this);case 1:return g.call(this,a);case 2:return c.call(this,
a,b)}throw Error("Invalid arity: "+arguments.length);};l.l=h;l.b=g;l.a=c;return l}()}}var c=null,c=function(c,e){switch(arguments.length){case 1:return b.call(this,c);case 2:return a.call(this,c,e)}throw Error("Invalid arity: "+arguments.length);};c.b=b;c.a=a;return c}();function mh(a,b,c){return function(d){var e=Kb(a);d=Jb(a,d);e=e.a?e.a(d,c):e.call(null,d,c);return b.a?b.a(e,0):b.call(null,e,0)}}
var nh=function(){function a(a,b,c,g,h){var l=Ib(a,c,!0);if(t(l)){var m=R.c(l,0,null);return lh.a(mh(a,g,h),t(mh(a,b,c).call(null,m))?l:K(l))}return null}function b(a,b,c){var g=mh(a,b,c),h;a:{h=[Ad,Bd];var l=h.length;if(l<=Vf)for(var m=0,p=Ob(Uf);;)if(m<l)var q=m+1,p=Rb(p,h[m],null),m=q;else{h=new $g(null,Qb(p),null);break a}else for(m=0,p=Ob(bh);;)if(m<l)q=m+1,p=Pb(p,h[m]),m=q;else{h=Qb(p);break a}h=void 0}return t(h.call(null,b))?(a=Ib(a,c,!0),t(a)?(b=R.c(a,0,null),t(g.b?g.b(b):g.call(null,b))?
a:K(a)):null):lh.a(g,Hb(a,!0))}var c=null,c=function(c,e,f,g,h){switch(arguments.length){case 3:return b.call(this,c,e,f);case 5:return a.call(this,c,e,f,g,h)}throw Error("Invalid arity: "+arguments.length);};c.c=b;c.r=a;return c}();function oh(a,b,c){this.m=a;this.end=b;this.step=c}oh.prototype.ga=function(){return 0<this.step?this.m<this.end:this.m>this.end};oh.prototype.next=function(){var a=this.m;this.m+=this.step;return a};
function ph(a,b,c,d,e){this.k=a;this.start=b;this.end=c;this.step=d;this.p=e;this.j=32375006;this.q=8192}k=ph.prototype;k.toString=function(){return ec(this)};k.Q=function(a,b){if(b<Ma(this))return this.start+b*this.step;if(this.start>this.end&&0===this.step)return this.start;throw Error("Index out of bounds");};k.$=function(a,b,c){return b<Ma(this)?this.start+b*this.step:this.start>this.end&&0===this.step?this.start:c};k.vb=!0;k.fb=function(){return new oh(this.start,this.end,this.step)};k.H=function(){return this.k};
k.T=function(){return 0<this.step?this.start+this.step<this.end?new ph(this.k,this.start+this.step,this.end,this.step,null):null:this.start+this.step>this.end?new ph(this.k,this.start+this.step,this.end,this.step,null):null};k.L=function(){if(Aa(Cb(this)))return 0;var a=(this.end-this.start)/this.step;return Math.ceil.b?Math.ceil.b(a):Math.ceil.call(null,a)};k.B=function(){var a=this.p;return null!=a?a:this.p=a=wc(this)};k.A=function(a,b){return Ic(this,b)};k.J=function(){return O(J,this.k)};
k.R=function(a,b){return Cc.a(this,b)};k.O=function(a,b,c){for(a=this.start;;)if(0<this.step?a<this.end:a>this.end){var d=a;c=b.a?b.a(c,d):b.call(null,c,d);if(Ac(c))return b=c,L.b?L.b(b):L.call(null,b);a+=this.step}else return c};k.N=function(){return null==Cb(this)?null:this.start};k.S=function(){return null!=Cb(this)?new ph(this.k,this.start+this.step,this.end,this.step,null):J};k.D=function(){return 0<this.step?this.start<this.end?this:null:this.start>this.end?this:null};
k.F=function(a,b){return new ph(b,this.start,this.end,this.step,this.p)};k.G=function(a,b){return M(b,this)};ph.prototype[Ea]=function(){return uc(this)};
var qh=function(){function a(a,b,c){return new ph(null,a,b,c,null)}function b(a,b){return e.c(a,b,1)}function c(a){return e.c(0,a,1)}function d(){return e.c(0,Number.MAX_VALUE,1)}var e=null,e=function(e,g,h){switch(arguments.length){case 0:return d.call(this);case 1:return c.call(this,e);case 2:return b.call(this,e,g);case 3:return a.call(this,e,g,h)}throw Error("Invalid arity: "+arguments.length);};e.l=d;e.b=c;e.a=b;e.c=a;return e}(),rh=function(){function a(a,b){return new V(null,function(){var f=
D(b);return f?M(G(f),c.a(a,Qe.a(a,f))):null},null,null)}function b(a){return function(b){return function(c){return function(){function g(g,h){var l=c.bb(0,c.Ra(null)+1),m=Cd(l,a);return 0===l-a*m?b.a?b.a(g,h):b.call(null,g,h):g}function h(a){return b.b?b.b(a):b.call(null,a)}function l(){return b.l?b.l():b.call(null)}var m=null,m=function(a,b){switch(arguments.length){case 0:return l.call(this);case 1:return h.call(this,a);case 2:return g.call(this,a,b)}throw Error("Invalid arity: "+arguments.length);
};m.l=l;m.b=h;m.a=g;return m}()}(new Me(-1))}}var c=null,c=function(c,e){switch(arguments.length){case 1:return b.call(this,c);case 2:return a.call(this,c,e)}throw Error("Invalid arity: "+arguments.length);};c.b=b;c.a=a;return c}(),th=function(){function a(a,b){return new V(null,function(){var f=D(b);if(f){var g=G(f),h=a.b?a.b(g):a.call(null,g),g=M(g,lh.a(function(b,c){return function(b){return sc.a(c,a.b?a.b(b):a.call(null,b))}}(g,h,f,f),K(f)));return M(g,c.a(a,D(Qe.a(Q(g),f))))}return null},null,
null)}function b(a){return function(b){return function(c,g){return function(){function h(h,l){var m=L.b?L.b(g):L.call(null,g),p=a.b?a.b(l):a.call(null,l);ac(g,p);if(Nd(m,sh)||sc.a(p,m))return c.add(l),h;m=zf(c.e);c.clear();m=b.a?b.a(h,m):b.call(null,h,m);Ac(m)||c.add(l);return m}function l(a){if(!t(0===c.e.length)){var d=zf(c.e);c.clear();a=Bc(b.a?b.a(a,d):b.call(null,a,d))}return b.b?b.b(a):b.call(null,a)}function m(){return b.l?b.l():b.call(null)}var p=null,p=function(a,b){switch(arguments.length){case 0:return m.call(this);
case 1:return l.call(this,a);case 2:return h.call(this,a,b)}throw Error("Invalid arity: "+arguments.length);};p.l=m;p.b=l;p.a=h;return p}()}(new jh([]),new Me(sh))}}var c=null,c=function(c,e){switch(arguments.length){case 1:return b.call(this,c);case 2:return a.call(this,c,e)}throw Error("Invalid arity: "+arguments.length);};c.b=b;c.a=a;return c}(),uh=function(){function a(a,b){for(;;)if(D(b)&&0<a){var c=a-1,g=K(b);a=c;b=g}else return null}function b(a){for(;;)if(D(a))a=K(a);else return null}var c=
null,c=function(c,e){switch(arguments.length){case 1:return b.call(this,c);case 2:return a.call(this,c,e)}throw Error("Invalid arity: "+arguments.length);};c.b=b;c.a=a;return c}(),vh=function(){function a(a,b){uh.a(a,b);return b}function b(a){uh.b(a);return a}var c=null,c=function(c,e){switch(arguments.length){case 1:return b.call(this,c);case 2:return a.call(this,c,e)}throw Error("Invalid arity: "+arguments.length);};c.b=b;c.a=a;return c}();
function wh(a,b,c,d,e,f,g){var h=ma;try{ma=null==ma?null:ma-1;if(null!=ma&&0>ma)return Lb(a,"#");Lb(a,c);if(D(g)){var l=G(g);b.c?b.c(l,a,f):b.call(null,l,a,f)}for(var m=K(g),p=za.b(f)-1;;)if(!m||null!=p&&0===p){D(m)&&0===p&&(Lb(a,d),Lb(a,"..."));break}else{Lb(a,d);var q=G(m);c=a;g=f;b.c?b.c(q,c,g):b.call(null,q,c,g);var s=K(m);c=p-1;m=s;p=c}return Lb(a,e)}finally{ma=h}}
var xh=function(){function a(a,d){var e=null;if(1<arguments.length){for(var e=0,f=Array(arguments.length-1);e<f.length;)f[e]=arguments[e+1],++e;e=new F(f,0)}return b.call(this,a,e)}function b(a,b){for(var e=D(b),f=null,g=0,h=0;;)if(h<g){var l=f.Q(null,h);Lb(a,l);h+=1}else if(e=D(e))f=e,fd(f)?(e=Yb(f),g=Zb(f),f=e,l=Q(e),e=g,g=l):(l=G(f),Lb(a,l),e=K(f),f=null,g=0),h=0;else return null}a.i=1;a.f=function(a){var d=G(a);a=H(a);return b(d,a)};a.d=b;return a}(),yh={'"':'\\"',"\\":"\\\\","\b":"\\b","\f":"\\f",
"\n":"\\n","\r":"\\r","\t":"\\t"};function zh(a){return[z('"'),z(a.replace(RegExp('[\\\\"\b\f\n\r\t]',"g"),function(a){return yh[a]})),z('"')].join("")}
var $=function Ah(b,c,d){if(null==b)return Lb(c,"nil");if(void 0===b)return Lb(c,"#\x3cundefined\x3e");t(function(){var c=S.a(d,wa);return t(c)?(c=b?b.j&131072||b.kc?!0:b.j?!1:w(rb,b):w(rb,b))?Vc(b):c:c}())&&(Lb(c,"^"),Ah(Vc(b),c,d),Lb(c," "));if(null==b)return Lb(c,"nil");if(b.Yb)return b.nc(c);if(b&&(b.j&2147483648||b.I))return b.v(null,c,d);if(Ba(b)===Boolean||"number"===typeof b)return Lb(c,""+z(b));if(null!=b&&b.constructor===Object){Lb(c,"#js ");var e=Oe.a(function(c){return new W(null,2,5,
uf,[Pd.b(c),b[c]],null)},gd(b));return Bh.n?Bh.n(e,Ah,c,d):Bh.call(null,e,Ah,c,d)}return b instanceof Array?wh(c,Ah,"#js ["," ","]",d,b):t("string"==typeof b)?t(ua.b(d))?Lb(c,zh(b)):Lb(c,b):Tc(b)?xh.d(c,Kc(["#\x3c",""+z(b),"\x3e"],0)):b instanceof Date?(e=function(b,c){for(var d=""+z(b);;)if(Q(d)<c)d=[z("0"),z(d)].join("");else return d},xh.d(c,Kc(['#inst "',""+z(b.getUTCFullYear()),"-",e(b.getUTCMonth()+1,2),"-",e(b.getUTCDate(),2),"T",e(b.getUTCHours(),2),":",e(b.getUTCMinutes(),2),":",e(b.getUTCSeconds(),
2),".",e(b.getUTCMilliseconds(),3),"-",'00:00"'],0))):b instanceof RegExp?xh.d(c,Kc(['#"',b.source,'"'],0)):(b?b.j&2147483648||b.I||(b.j?0:w(Mb,b)):w(Mb,b))?Nb(b,c,d):xh.d(c,Kc(["#\x3c",""+z(b),"\x3e"],0))},Ch=function(){function a(a){var d=null;if(0<arguments.length){for(var d=0,e=Array(arguments.length-0);d<e.length;)e[d]=arguments[d+0],++d;d=new F(e,0)}return b.call(this,d)}function b(a){var b=oa();if(Yc(a))b="";else{var e=z,f=new fa;a:{var g=new dc(f);$(G(a),g,b);a=D(K(a));for(var h=null,l=0,
m=0;;)if(m<l){var p=h.Q(null,m);Lb(g," ");$(p,g,b);m+=1}else if(a=D(a))h=a,fd(h)?(a=Yb(h),l=Zb(h),h=a,p=Q(a),a=l,l=p):(p=G(h),Lb(g," "),$(p,g,b),a=K(h),h=null,l=0),m=0;else break a}b=""+e(f)}return b}a.i=0;a.f=function(a){a=D(a);return b(a)};a.d=b;return a}();function Bh(a,b,c,d){return wh(c,function(a,c,d){var h=hb(a);b.c?b.c(h,c,d):b.call(null,h,c,d);Lb(c," ");a=ib(a);return b.c?b.c(a,c,d):b.call(null,a,c,d)},"{",", ","}",d,D(a))}Me.prototype.I=!0;
Me.prototype.v=function(a,b,c){Lb(b,"#\x3cVolatile: ");$(this.state,b,c);return Lb(b,"\x3e")};F.prototype.I=!0;F.prototype.v=function(a,b,c){return wh(b,$,"("," ",")",c,this)};V.prototype.I=!0;V.prototype.v=function(a,b,c){return wh(b,$,"("," ",")",c,this)};wg.prototype.I=!0;wg.prototype.v=function(a,b,c){return wh(b,$,"("," ",")",c,this)};pg.prototype.I=!0;pg.prototype.v=function(a,b,c){return wh(b,$,"("," ",")",c,this)};Z.prototype.I=!0;
Z.prototype.v=function(a,b,c){return wh(b,$,"["," ","]",c,this)};Rf.prototype.I=!0;Rf.prototype.v=function(a,b,c){return wh(b,$,"("," ",")",c,this)};ch.prototype.I=!0;ch.prototype.v=function(a,b,c){return wh(b,$,"#{"," ","}",c,this)};Bf.prototype.I=!0;Bf.prototype.v=function(a,b,c){return wh(b,$,"("," ",")",c,this)};Ld.prototype.I=!0;Ld.prototype.v=function(a,b,c){return wh(b,$,"("," ",")",c,this)};Hc.prototype.I=!0;Hc.prototype.v=function(a,b,c){return wh(b,$,"("," ",")",c,this)};
rg.prototype.I=!0;rg.prototype.v=function(a,b,c){return Bh(this,$,b,c)};qg.prototype.I=!0;qg.prototype.v=function(a,b,c){return wh(b,$,"("," ",")",c,this)};Df.prototype.I=!0;Df.prototype.v=function(a,b,c){return wh(b,$,"["," ","]",c,this)};Lg.prototype.I=!0;Lg.prototype.v=function(a,b,c){return Bh(this,$,b,c)};$g.prototype.I=!0;$g.prototype.v=function(a,b,c){return wh(b,$,"#{"," ","}",c,this)};Vd.prototype.I=!0;Vd.prototype.v=function(a,b,c){return wh(b,$,"("," ",")",c,this)};Ug.prototype.I=!0;
Ug.prototype.v=function(a,b,c){return wh(b,$,"("," ",")",c,this)};X.prototype.I=!0;X.prototype.v=function(a,b,c){return wh(b,$,"["," ","]",c,this)};W.prototype.I=!0;W.prototype.v=function(a,b,c){return wh(b,$,"["," ","]",c,this)};Kf.prototype.I=!0;Kf.prototype.v=function(a,b,c){return wh(b,$,"("," ",")",c,this)};Hd.prototype.I=!0;Hd.prototype.v=function(a,b){return Lb(b,"()")};ze.prototype.I=!0;ze.prototype.v=function(a,b,c){return wh(b,$,"("," ",")",c,this)};Lf.prototype.I=!0;
Lf.prototype.v=function(a,b,c){return wh(b,$,"#queue ["," ","]",c,D(this))};pa.prototype.I=!0;pa.prototype.v=function(a,b,c){return Bh(this,$,b,c)};ph.prototype.I=!0;ph.prototype.v=function(a,b,c){return wh(b,$,"("," ",")",c,this)};Sg.prototype.I=!0;Sg.prototype.v=function(a,b,c){return wh(b,$,"("," ",")",c,this)};Fd.prototype.I=!0;Fd.prototype.v=function(a,b,c){return wh(b,$,"("," ",")",c,this)};W.prototype.sb=!0;W.prototype.tb=function(a,b){return pd.a(this,b)};Df.prototype.sb=!0;
Df.prototype.tb=function(a,b){return pd.a(this,b)};U.prototype.sb=!0;U.prototype.tb=function(a,b){return Md(this,b)};qc.prototype.sb=!0;qc.prototype.tb=function(a,b){return pc(this,b)};var Dh=function(){function a(a,d,e){var f=null;if(2<arguments.length){for(var f=0,g=Array(arguments.length-2);f<g.length;)g[f]=arguments[f+2],++f;f=new F(g,0)}return b.call(this,a,d,f)}function b(a,b,e){return a.k=T.c(b,a.k,e)}a.i=2;a.f=function(a){var d=G(a);a=K(a);var e=G(a);a=H(a);return b(d,e,a)};a.d=b;return a}();
function Eh(a){return function(b,c){var d=a.a?a.a(b,c):a.call(null,b,c);return Ac(d)?new yc(d):d}}
function Ve(a){return function(b){return function(){function c(a,c){return A.c(b,a,c)}function d(b){return a.b?a.b(b):a.call(null,b)}function e(){return a.l?a.l():a.call(null)}var f=null,f=function(a,b){switch(arguments.length){case 0:return e.call(this);case 1:return d.call(this,a);case 2:return c.call(this,a,b)}throw Error("Invalid arity: "+arguments.length);};f.l=e;f.b=d;f.a=c;return f}()}(Eh(a))}
var Fh=function(){function a(a){return Ce.a(c.l(),a)}function b(){return function(a){return function(b){return function(){function c(f,g){var h=L.b?L.b(b):L.call(null,b);ac(b,g);return sc.a(h,g)?f:a.a?a.a(f,g):a.call(null,f,g)}function g(b){return a.b?a.b(b):a.call(null,b)}function h(){return a.l?a.l():a.call(null)}var l=null,l=function(a,b){switch(arguments.length){case 0:return h.call(this);case 1:return g.call(this,a);case 2:return c.call(this,a,b)}throw Error("Invalid arity: "+arguments.length);
};l.l=h;l.b=g;l.a=c;return l}()}(new Me(sh))}}var c=null,c=function(c){switch(arguments.length){case 0:return b.call(this);case 1:return a.call(this,c)}throw Error("Invalid arity: "+arguments.length);};c.l=b;c.b=a;return c}();function Gh(a,b){this.fa=a;this.Zb=b;this.q=0;this.j=2173173760}Gh.prototype.v=function(a,b,c){return wh(b,$,"("," ",")",c,this)};Gh.prototype.O=function(a,b,c){return wd.n(this.fa,b,c,this.Zb)};Gh.prototype.D=function(){return D(Ce.a(this.fa,this.Zb))};Gh.prototype[Ea]=function(){return uc(this)};
var Hh={};function Ih(a){if(a?a.gc:a)return a.gc(a);var b;b=Ih[n(null==a?null:a)];if(!b&&(b=Ih._,!b))throw x("IEncodeJS.-clj-\x3ejs",a);return b.call(null,a)}function Jh(a){return(a?t(t(null)?null:a.fc)||(a.yb?0:w(Hh,a)):w(Hh,a))?Ih(a):"string"===typeof a||"number"===typeof a||a instanceof U||a instanceof qc?Kh.b?Kh.b(a):Kh.call(null,a):Ch.d(Kc([a],0))}
var Kh=function Lh(b){if(null==b)return null;if(b?t(t(null)?null:b.fc)||(b.yb?0:w(Hh,b)):w(Hh,b))return Ih(b);if(b instanceof U)return Od(b);if(b instanceof qc)return""+z(b);if(dd(b)){var c={};b=D(b);for(var d=null,e=0,f=0;;)if(f<e){var g=d.Q(null,f),h=R.c(g,0,null),g=R.c(g,1,null);c[Jh(h)]=Lh(g);f+=1}else if(b=D(b))fd(b)?(e=Yb(b),b=Zb(b),d=e,e=Q(e)):(e=G(b),d=R.c(e,0,null),e=R.c(e,1,null),c[Jh(d)]=Lh(e),b=K(b),d=null,e=0),f=0;else break;return c}if($c(b)){c=[];b=D(Oe.a(Lh,b));d=null;for(f=e=0;;)if(f<
e)h=d.Q(null,f),c.push(h),f+=1;else if(b=D(b))d=b,fd(d)?(b=Yb(d),f=Zb(d),d=b,e=Q(b),b=f):(b=G(d),c.push(b),b=K(d),d=null,e=0),f=0;else break;return c}return b},Mh={};function Nh(a,b){if(a?a.ec:a)return a.ec(a,b);var c;c=Nh[n(null==a?null:a)];if(!c&&(c=Nh._,!c))throw x("IEncodeClojure.-js-\x3eclj",a);return c.call(null,a,b)}
var Ph=function(){function a(a){return b.d(a,Kc([new pa(null,1,[Oh,!1],null)],0))}var b=null,c=function(){function a(c,d){var h=null;if(1<arguments.length){for(var h=0,l=Array(arguments.length-1);h<l.length;)l[h]=arguments[h+1],++h;h=new F(l,0)}return b.call(this,c,h)}function b(a,c){var d=kd(c)?T.a(Og,c):c,e=S.a(d,Oh);return function(a,b,d,e){return function v(f){return(f?t(t(null)?null:f.uc)||(f.yb?0:w(Mh,f)):w(Mh,f))?Nh(f,T.a(Pg,c)):kd(f)?vh.b(Oe.a(v,f)):$c(f)?af.a(Oc(f),Oe.a(v,f)):f instanceof
Array?zf(Oe.a(v,f)):Ba(f)===Object?af.a(Uf,function(){return function(a,b,c,d){return function Pa(e){return new V(null,function(a,b,c,d){return function(){for(;;){var a=D(e);if(a){if(fd(a)){var b=Yb(a),c=Q(b),g=Td(c);return function(){for(var a=0;;)if(a<c){var e=C.a(b,a),h=g,l=uf,m;m=e;m=d.b?d.b(m):d.call(null,m);e=new W(null,2,5,l,[m,v(f[e])],null);h.add(e);a+=1}else return!0}()?Wd(g.ca(),Pa(Zb(a))):Wd(g.ca(),null)}var h=G(a);return M(new W(null,2,5,uf,[function(){var a=h;return d.b?d.b(a):d.call(null,
a)}(),v(f[h])],null),Pa(H(a)))}return null}}}(a,b,c,d),null,null)}}(a,b,d,e)(gd(f))}()):f}}(c,d,e,t(e)?Pd:z)(a)}a.i=1;a.f=function(a){var c=G(a);a=H(a);return b(c,a)};a.d=b;return a}(),b=function(b,e){switch(arguments.length){case 1:return a.call(this,b);default:var f=null;if(1<arguments.length){for(var f=0,g=Array(arguments.length-1);f<g.length;)g[f]=arguments[f+1],++f;f=new F(g,0)}return c.d(b,f)}throw Error("Invalid arity: "+arguments.length);};b.i=1;b.f=c.f;b.b=a;b.d=c.d;return b}();var wa=new U(null,"meta","meta",1499536964),ya=new U(null,"dup","dup",556298533),sh=new U("cljs.core","none","cljs.core/none",926646439),pe=new U(null,"file","file",-1269645878),le=new U(null,"end-column","end-column",1425389514),sa=new U(null,"flush-on-newline","flush-on-newline",-151457939),ne=new U(null,"column","column",2078222095),ua=new U(null,"readably","readably",1129599760),oe=new U(null,"line","line",212345235),za=new U(null,"print-length","print-length",1931866356),me=new U(null,"end-line",
"end-line",1837326455),Oh=new U(null,"keywordize-keys","keywordize-keys",1310784252),Zg=new U("cljs.core","not-found","cljs.core/not-found",-1572889185);function Qh(a,b){var c=T.c(ih,a,b);return M(c,Ye.a(function(a){return function(b){return a===b}}(c),b))}
var Rh=function(){function a(a,b){return Q(a)<Q(b)?A.c(Nc,b,a):A.c(Nc,a,b)}var b=null,c=function(){function a(c,d,h){var l=null;if(2<arguments.length){for(var l=0,m=Array(arguments.length-2);l<m.length;)m[l]=arguments[l+2],++l;l=new F(m,0)}return b.call(this,c,d,l)}function b(a,c,d){a=Qh(Q,Nc.d(d,c,Kc([a],0)));return A.c(af,G(a),H(a))}a.i=2;a.f=function(a){var c=G(a);a=K(a);var d=G(a);a=H(a);return b(c,d,a)};a.d=b;return a}(),b=function(b,e,f){switch(arguments.length){case 0:return bh;case 1:return b;
case 2:return a.call(this,b,e);default:var g=null;if(2<arguments.length){for(var g=0,h=Array(arguments.length-2);g<h.length;)h[g]=arguments[g+2],++g;g=new F(h,0)}return c.d(b,e,g)}throw Error("Invalid arity: "+arguments.length);};b.i=2;b.f=c.f;b.l=function(){return bh};b.b=function(a){return a};b.a=a;b.d=c.d;return b}(),Sh=function(){function a(a,b){for(;;)if(Q(b)<Q(a)){var c=a;a=b;b=c}else return A.c(function(a,b){return function(a,c){return nd(b,c)?a:Xc.a(a,c)}}(a,b),a,a)}var b=null,c=function(){function a(b,
d,h){var l=null;if(2<arguments.length){for(var l=0,m=Array(arguments.length-2);l<m.length;)m[l]=arguments[l+2],++l;l=new F(m,0)}return c.call(this,b,d,l)}function c(a,d,e){a=Qh(function(a){return-Q(a)},Nc.d(e,d,Kc([a],0)));return A.c(b,G(a),H(a))}a.i=2;a.f=function(a){var b=G(a);a=K(a);var d=G(a);a=H(a);return c(b,d,a)};a.d=c;return a}(),b=function(b,e,f){switch(arguments.length){case 1:return b;case 2:return a.call(this,b,e);default:var g=null;if(2<arguments.length){for(var g=0,h=Array(arguments.length-
2);g<h.length;)h[g]=arguments[g+2],++g;g=new F(h,0)}return c.d(b,e,g)}throw Error("Invalid arity: "+arguments.length);};b.i=2;b.f=c.f;b.b=function(a){return a};b.a=a;b.d=c.d;return b}(),Th=function(){function a(a,b){return Q(a)<Q(b)?A.c(function(a,c){return nd(b,c)?Xc.a(a,c):a},a,a):A.c(Xc,a,b)}var b=null,c=function(){function a(b,d,h){var l=null;if(2<arguments.length){for(var l=0,m=Array(arguments.length-2);l<m.length;)m[l]=arguments[l+2],++l;l=new F(m,0)}return c.call(this,b,d,l)}function c(a,d,
e){return A.c(b,a,Nc.a(e,d))}a.i=2;a.f=function(a){var b=G(a);a=K(a);var d=G(a);a=H(a);return c(b,d,a)};a.d=c;return a}(),b=function(b,e,f){switch(arguments.length){case 1:return b;case 2:return a.call(this,b,e);default:var g=null;if(2<arguments.length){for(var g=0,h=Array(arguments.length-2);g<h.length;)h[g]=arguments[g+2],++g;g=new F(h,0)}return c.d(b,e,g)}throw Error("Invalid arity: "+arguments.length);};b.i=2;b.f=c.f;b.b=function(a){return a};b.a=a;b.d=c.d;return b}();
function Uh(a,b){return A.c(function(b,d){var e=R.c(d,0,null),f=R.c(d,1,null);return nd(a,e)?Rc.c(b,f,S.a(a,e)):b},T.c(Sc,a,Tg(b)),b)}function Vh(a,b){return A.c(function(a,d){var e=Yg(d,b);return Rc.c(a,e,Nc.a(S.c(a,e,bh),d))},Uf,a)}function Wh(a){return A.c(function(a,c){var d=R.c(c,0,null),e=R.c(c,1,null);return Rc.c(a,e,d)},Uf,a)}
var Xh=function(){function a(a,b,c){a=Q(a)<=Q(b)?new W(null,3,5,uf,[a,b,Wh(c)],null):new W(null,3,5,uf,[b,a,c],null);b=R.c(a,0,null);c=R.c(a,1,null);var g=R.c(a,2,null),h=Vh(b,Vg(g));return A.c(function(a,b,c,d,e){return function(f,g){var h=function(){var a=Uh(Yg(g,Tg(d)),d);return e.b?e.b(a):e.call(null,a)}();return t(h)?A.c(function(){return function(a,b){return Nc.a(a,Wg.d(Kc([b,g],0)))}}(h,a,b,c,d,e),f,h):f}}(a,b,c,g,h),bh,c)}function b(a,b){if(D(a)&&D(b)){var c=Sh.a(fh(Tg(G(a))),fh(Tg(G(b)))),
g=Q(a)<=Q(b)?new W(null,2,5,uf,[a,b],null):new W(null,2,5,uf,[b,a],null),h=R.c(g,0,null),l=R.c(g,1,null),m=Vh(h,c);return A.c(function(a,b,c,d,e){return function(f,g){var h=function(){var b=Yg(g,a);return e.b?e.b(b):e.call(null,b)}();return t(h)?A.c(function(){return function(a,b){return Nc.a(a,Wg.d(Kc([b,g],0)))}}(h,a,b,c,d,e),f,h):f}}(c,g,h,l,m),bh,l)}return bh}var c=null,c=function(c,e,f){switch(arguments.length){case 2:return b.call(this,c,e);case 3:return a.call(this,c,e,f)}throw Error("Invalid arity: "+
arguments.length);};c.a=b;c.c=a;return c}();r("mori.apply",T);r("mori.apply.f2",T.a);r("mori.apply.f3",T.c);r("mori.apply.f4",T.n);r("mori.apply.f5",T.r);r("mori.apply.fn",T.K);r("mori.count",Q);r("mori.distinct",function(a){return function c(a,e){return new V(null,function(){return function(a,d){for(;;){var e=a,l=R.c(e,0,null);if(e=D(e))if(nd(d,l))l=H(e),e=d,a=l,d=e;else return M(l,c(H(e),Nc.a(d,l)));else return null}}.call(null,a,e)},null,null)}(a,bh)});r("mori.empty",Oc);r("mori.first",G);r("mori.second",Lc);r("mori.next",K);
r("mori.rest",H);r("mori.seq",D);r("mori.conj",Nc);r("mori.conj.f0",Nc.l);r("mori.conj.f1",Nc.b);r("mori.conj.f2",Nc.a);r("mori.conj.fn",Nc.K);r("mori.cons",M);r("mori.find",function(a,b){return null!=a&&bd(a)&&nd(a,b)?new W(null,2,5,uf,[b,S.a(a,b)],null):null});r("mori.nth",R);r("mori.nth.f2",R.a);r("mori.nth.f3",R.c);r("mori.last",function(a){for(;;){var b=K(a);if(null!=b)a=b;else return G(a)}});r("mori.assoc",Rc);r("mori.assoc.f3",Rc.c);r("mori.assoc.fn",Rc.K);r("mori.dissoc",Sc);
r("mori.dissoc.f1",Sc.b);r("mori.dissoc.f2",Sc.a);r("mori.dissoc.fn",Sc.K);r("mori.getIn",cf);r("mori.getIn.f2",cf.a);r("mori.getIn.f3",cf.c);r("mori.updateIn",df);r("mori.updateIn.f3",df.c);r("mori.updateIn.f4",df.n);r("mori.updateIn.f5",df.r);r("mori.updateIn.f6",df.P);r("mori.updateIn.fn",df.K);r("mori.assocIn",function Yh(b,c,d){var e=R.c(c,0,null);return(c=Ed(c))?Rc.c(b,e,Yh(S.a(b,e),c,d)):Rc.c(b,e,d)});r("mori.fnil",Ke);r("mori.fnil.f2",Ke.a);r("mori.fnil.f3",Ke.c);r("mori.fnil.f4",Ke.n);
r("mori.disj",Xc);r("mori.disj.f1",Xc.b);r("mori.disj.f2",Xc.a);r("mori.disj.fn",Xc.K);r("mori.pop",function(a){return null==a?null:mb(a)});r("mori.peek",Wc);r("mori.hash",nc);r("mori.get",S);r("mori.get.f2",S.a);r("mori.get.f3",S.c);r("mori.hasKey",nd);r("mori.isEmpty",Yc);r("mori.reverse",Jd);r("mori.take",Pe);r("mori.take.f1",Pe.b);r("mori.take.f2",Pe.a);r("mori.drop",Qe);r("mori.drop.f1",Qe.b);r("mori.drop.f2",Qe.a);r("mori.takeNth",rh);r("mori.takeNth.f1",rh.b);r("mori.takeNth.f2",rh.a);
r("mori.partition",bf);r("mori.partition.f2",bf.a);r("mori.partition.f3",bf.c);r("mori.partition.f4",bf.n);r("mori.partitionAll",kh);r("mori.partitionAll.f1",kh.b);r("mori.partitionAll.f2",kh.a);r("mori.partitionAll.f3",kh.c);r("mori.partitionBy",th);r("mori.partitionBy.f1",th.b);r("mori.partitionBy.f2",th.a);r("mori.iterate",function Zh(b,c){return M(c,new V(null,function(){return Zh(b,b.b?b.b(c):b.call(null,c))},null,null))});r("mori.into",af);r("mori.into.f2",af.a);r("mori.into.f3",af.c);
r("mori.merge",Wg);r("mori.mergeWith",Xg);r("mori.subvec",Cf);r("mori.subvec.f2",Cf.a);r("mori.subvec.f3",Cf.c);r("mori.takeWhile",lh);r("mori.takeWhile.f1",lh.b);r("mori.takeWhile.f2",lh.a);r("mori.dropWhile",Re);r("mori.dropWhile.f1",Re.b);r("mori.dropWhile.f2",Re.a);r("mori.groupBy",function(a,b){return ce(A.c(function(b,d){var e=a.b?a.b(d):a.call(null,d);return ee.c(b,e,Nc.a(S.c(b,e,Mc),d))},Ob(Uf),b))});r("mori.interpose",function(a,b){return Qe.a(1,Ue.a(Se.b(a),b))});r("mori.interleave",Ue);
r("mori.interleave.f2",Ue.a);r("mori.interleave.fn",Ue.K);r("mori.concat",ae);r("mori.concat.f0",ae.l);r("mori.concat.f1",ae.b);r("mori.concat.f2",ae.a);r("mori.concat.fn",ae.K);function $e(a){return a instanceof Array||cd(a)}r("mori.flatten",function(a){return Xe.a(function(a){return!$e(a)},H(Ze(a)))});r("mori.lazySeq",function(a){return new V(null,a,null,null)});r("mori.keys",Tg);r("mori.selectKeys",Yg);r("mori.vals",Vg);r("mori.primSeq",Jc);r("mori.primSeq.f1",Jc.b);r("mori.primSeq.f2",Jc.a);
r("mori.map",Oe);r("mori.map.f1",Oe.b);r("mori.map.f2",Oe.a);r("mori.map.f3",Oe.c);r("mori.map.f4",Oe.n);r("mori.map.fn",Oe.K);
r("mori.mapIndexed",function(a,b){return function d(b,f){return new V(null,function(){var g=D(f);if(g){if(fd(g)){for(var h=Yb(g),l=Q(h),m=Td(l),p=0;;)if(p<l)Xd(m,function(){var d=b+p,f=C.a(h,p);return a.a?a.a(d,f):a.call(null,d,f)}()),p+=1;else break;return Wd(m.ca(),d(b+l,Zb(g)))}return M(function(){var d=G(g);return a.a?a.a(b,d):a.call(null,b,d)}(),d(b+1,H(g)))}return null},null,null)}(0,b)});r("mori.mapcat",We);r("mori.mapcat.f1",We.b);r("mori.mapcat.fn",We.K);r("mori.reduce",A);
r("mori.reduce.f2",A.a);r("mori.reduce.f3",A.c);r("mori.reduceKV",function(a,b,c){return null!=c?xb(c,a,b):b});r("mori.keep",Le);r("mori.keep.f1",Le.b);r("mori.keep.f2",Le.a);r("mori.keepIndexed",Ne);r("mori.keepIndexed.f1",Ne.b);r("mori.keepIndexed.f2",Ne.a);r("mori.filter",Xe);r("mori.filter.f1",Xe.b);r("mori.filter.f2",Xe.a);r("mori.remove",Ye);r("mori.remove.f1",Ye.b);r("mori.remove.f2",Ye.a);r("mori.some",Fe);r("mori.every",Ee);r("mori.equals",sc);r("mori.equals.f1",sc.b);
r("mori.equals.f2",sc.a);r("mori.equals.fn",sc.K);r("mori.range",qh);r("mori.range.f0",qh.l);r("mori.range.f1",qh.b);r("mori.range.f2",qh.a);r("mori.range.f3",qh.c);r("mori.repeat",Se);r("mori.repeat.f1",Se.b);r("mori.repeat.f2",Se.a);r("mori.repeatedly",Te);r("mori.repeatedly.f1",Te.b);r("mori.repeatedly.f2",Te.a);r("mori.sort",sd);r("mori.sort.f1",sd.b);r("mori.sort.f2",sd.a);r("mori.sortBy",td);r("mori.sortBy.f2",td.a);r("mori.sortBy.f3",td.c);r("mori.intoArray",Ia);r("mori.intoArray.f1",Ia.b);
r("mori.intoArray.f2",Ia.a);r("mori.subseq",nh);r("mori.subseq.f3",nh.c);r("mori.subseq.f5",nh.r);r("mori.dedupe",Fh);r("mori.dedupe.f0",Fh.l);r("mori.dedupe.f1",Fh.b);r("mori.transduce",wd);r("mori.transduce.f3",wd.c);r("mori.transduce.f4",wd.n);r("mori.eduction",function(a,b){return new Gh(a,b)});r("mori.sequence",Ce);r("mori.sequence.f1",Ce.b);r("mori.sequence.f2",Ce.a);r("mori.sequence.fn",Ce.K);r("mori.completing",vd);r("mori.completing.f1",vd.b);r("mori.completing.f2",vd.a);r("mori.list",Kd);
r("mori.vector",Af);r("mori.hashMap",Pg);r("mori.set",fh);r("mori.sortedSet",gh);r("mori.sortedSetBy",hh);r("mori.sortedMap",Qg);r("mori.sortedMapBy",Rg);r("mori.queue",function(){function a(a){var d=null;if(0<arguments.length){for(var d=0,e=Array(arguments.length-0);d<e.length;)e[d]=arguments[d+0],++d;d=new F(e,0)}return b.call(this,d)}function b(a){return af.a?af.a(Mf,a):af.call(null,Mf,a)}a.i=0;a.f=function(a){a=D(a);return b(a)};a.d=b;return a}());r("mori.keyword",Pd);r("mori.keyword.f1",Pd.b);
r("mori.keyword.f2",Pd.a);r("mori.symbol",rc);r("mori.symbol.f1",rc.b);r("mori.symbol.f2",rc.a);r("mori.zipmap",function(a,b){for(var c=Ob(Uf),d=D(a),e=D(b);;)if(d&&e)c=ee.c(c,G(d),G(e)),d=K(d),e=K(e);else return Qb(c)});r("mori.isList",function(a){return a?a.j&33554432||a.wc?!0:a.j?!1:w(Eb,a):w(Eb,a)});r("mori.isSeq",kd);r("mori.isVector",ed);r("mori.isMap",dd);r("mori.isSet",ad);r("mori.isKeyword",function(a){return a instanceof U});r("mori.isSymbol",function(a){return a instanceof qc});
r("mori.isCollection",$c);r("mori.isSequential",cd);r("mori.isAssociative",bd);r("mori.isCounted",Ec);r("mori.isIndexed",Fc);r("mori.isReduceable",function(a){return a?a.j&524288||a.Sb?!0:a.j?!1:w(vb,a):w(vb,a)});r("mori.isSeqable",ld);r("mori.isReversible",Id);r("mori.union",Rh);r("mori.union.f0",Rh.l);r("mori.union.f1",Rh.b);r("mori.union.f2",Rh.a);r("mori.union.fn",Rh.K);r("mori.intersection",Sh);r("mori.intersection.f1",Sh.b);r("mori.intersection.f2",Sh.a);r("mori.intersection.fn",Sh.K);
r("mori.difference",Th);r("mori.difference.f1",Th.b);r("mori.difference.f2",Th.a);r("mori.difference.fn",Th.K);r("mori.join",Xh);r("mori.join.f2",Xh.a);r("mori.join.f3",Xh.c);r("mori.index",Vh);r("mori.project",function(a,b){return fh(Oe.a(function(a){return Yg(a,b)},a))});r("mori.mapInvert",Wh);r("mori.rename",function(a,b){return fh(Oe.a(function(a){return Uh(a,b)},a))});r("mori.renameKeys",Uh);r("mori.isSubset",function(a,b){return Q(a)<=Q(b)&&Ee(function(a){return nd(b,a)},a)});
r("mori.isSuperset",function(a,b){return Q(a)>=Q(b)&&Ee(function(b){return nd(a,b)},b)});r("mori.notEquals",je);r("mori.notEquals.f1",je.b);r("mori.notEquals.f2",je.a);r("mori.notEquals.fn",je.K);r("mori.gt",Ad);r("mori.gt.f1",Ad.b);r("mori.gt.f2",Ad.a);r("mori.gt.fn",Ad.K);r("mori.gte",Bd);r("mori.gte.f1",Bd.b);r("mori.gte.f2",Bd.a);r("mori.gte.fn",Bd.K);r("mori.lt",yd);r("mori.lt.f1",yd.b);r("mori.lt.f2",yd.a);r("mori.lt.fn",yd.K);r("mori.lte",zd);r("mori.lte.f1",zd.b);r("mori.lte.f2",zd.a);
r("mori.lte.fn",zd.K);r("mori.compare",od);r("mori.partial",Je);r("mori.partial.f1",Je.b);r("mori.partial.f2",Je.a);r("mori.partial.f3",Je.c);r("mori.partial.f4",Je.n);r("mori.partial.fn",Je.K);r("mori.comp",Ie);r("mori.comp.f0",Ie.l);r("mori.comp.f1",Ie.b);r("mori.comp.f2",Ie.a);r("mori.comp.f3",Ie.c);r("mori.comp.fn",Ie.K);
r("mori.pipeline",function(){function a(a){var d=null;if(0<arguments.length){for(var d=0,e=Array(arguments.length-0);d<e.length;)e[d]=arguments[d+0],++d;d=new F(e,0)}return b.call(this,d)}function b(a){function b(a,c){return c.b?c.b(a):c.call(null,a)}return A.a?A.a(b,a):A.call(null,b,a)}a.i=0;a.f=function(a){a=D(a);return b(a)};a.d=b;return a}());
r("mori.curry",function(){function a(a,d){var e=null;if(1<arguments.length){for(var e=0,f=Array(arguments.length-1);e<f.length;)f[e]=arguments[e+1],++e;e=new F(f,0)}return b.call(this,a,e)}function b(a,b){return function(e){return T.a(a,M.a?M.a(e,b):M.call(null,e,b))}}a.i=1;a.f=function(a){var d=G(a);a=H(a);return b(d,a)};a.d=b;return a}());
r("mori.juxt",function(){function a(a){var d=null;if(0<arguments.length){for(var d=0,e=Array(arguments.length-0);d<e.length;)e[d]=arguments[d+0],++d;d=new F(e,0)}return b.call(this,d)}function b(a){return function(){function b(a){var c=null;if(0<arguments.length){for(var c=0,d=Array(arguments.length-0);c<d.length;)d[c]=arguments[c+0],++c;c=new F(d,0)}return e.call(this,c)}function e(b){var d=function(){function d(a){return T.a(a,b)}return Oe.a?Oe.a(d,a):Oe.call(null,d,a)}();return Ia.b?Ia.b(d):Ia.call(null,
d)}b.i=0;b.f=function(a){a=D(a);return e(a)};b.d=e;return b}()}a.i=0;a.f=function(a){a=D(a);return b(a)};a.d=b;return a}());
r("mori.knit",function(){function a(a){var d=null;if(0<arguments.length){for(var d=0,e=Array(arguments.length-0);d<e.length;)e[d]=arguments[d+0],++d;d=new F(e,0)}return b.call(this,d)}function b(a){return function(b){var e=function(){function e(a,b){return a.b?a.b(b):a.call(null,b)}return Oe.c?Oe.c(e,a,b):Oe.call(null,e,a,b)}();return Ia.b?Ia.b(e):Ia.call(null,e)}}a.i=0;a.f=function(a){a=D(a);return b(a)};a.d=b;return a}());r("mori.sum",xd);r("mori.sum.f0",xd.l);r("mori.sum.f1",xd.b);
r("mori.sum.f2",xd.a);r("mori.sum.fn",xd.K);r("mori.inc",function(a){return a+1});r("mori.dec",function(a){return a-1});r("mori.isEven",Ge);r("mori.isOdd",function(a){return!Ge(a)});r("mori.each",function(a,b){for(var c=D(a),d=null,e=0,f=0;;)if(f<e){var g=d.Q(null,f);b.b?b.b(g):b.call(null,g);f+=1}else if(c=D(c))fd(c)?(e=Yb(c),c=Zb(c),d=e,e=Q(e)):(d=g=G(c),b.b?b.b(d):b.call(null,d),c=K(c),d=null,e=0),f=0;else return null});r("mori.identity",ud);
r("mori.constantly",function(a){return function(){function b(b){if(0<arguments.length)for(var d=0,e=Array(arguments.length-0);d<e.length;)e[d]=arguments[d+0],++d;return a}b.i=0;b.f=function(b){D(b);return a};b.d=function(){return a};return b}()});r("mori.toJs",Kh);
r("mori.toClj",function(){function a(a,b){return Ph.d(a,Kc([Oh,b],0))}function b(a){return Ph.b(a)}var c=null,c=function(c,e){switch(arguments.length){case 1:return b.call(this,c);case 2:return a.call(this,c,e)}throw Error("Invalid arity: "+arguments.length);};c.b=b;c.a=a;return c}());r("mori.configure",function(a,b){switch(a){case "print-length":return la=b;case "print-level":return ma=b;default:throw Error([z("No matching clause: "),z(a)].join(""));}});r("mori.meta",Vc);r("mori.withMeta",O);
r("mori.varyMeta",ie);r("mori.varyMeta.f2",ie.a);r("mori.varyMeta.f3",ie.c);r("mori.varyMeta.f4",ie.n);r("mori.varyMeta.f5",ie.r);r("mori.varyMeta.f6",ie.P);r("mori.varyMeta.fn",ie.K);r("mori.alterMeta",Dh);r("mori.resetMeta",function(a,b){return a.k=b});V.prototype.inspect=function(){return this.toString()};F.prototype.inspect=function(){return this.toString()};Hc.prototype.inspect=function(){return this.toString()};wg.prototype.inspect=function(){return this.toString()};pg.prototype.inspect=function(){return this.toString()};
qg.prototype.inspect=function(){return this.toString()};Fd.prototype.inspect=function(){return this.toString()};Ld.prototype.inspect=function(){return this.toString()};Hd.prototype.inspect=function(){return this.toString()};W.prototype.inspect=function(){return this.toString()};Vd.prototype.inspect=function(){return this.toString()};Bf.prototype.inspect=function(){return this.toString()};Df.prototype.inspect=function(){return this.toString()};Z.prototype.inspect=function(){return this.toString()};
X.prototype.inspect=function(){return this.toString()};pa.prototype.inspect=function(){return this.toString()};rg.prototype.inspect=function(){return this.toString()};Lg.prototype.inspect=function(){return this.toString()};$g.prototype.inspect=function(){return this.toString()};ch.prototype.inspect=function(){return this.toString()};ph.prototype.inspect=function(){return this.toString()};U.prototype.inspect=function(){return this.toString()};qc.prototype.inspect=function(){return this.toString()};
Lf.prototype.inspect=function(){return this.toString()};Kf.prototype.inspect=function(){return this.toString()};r("mori.mutable.thaw",function(a){return Ob(a)});r("mori.mutable.freeze",ce);r("mori.mutable.conj",de);r("mori.mutable.conj.f0",de.l);r("mori.mutable.conj.f1",de.b);r("mori.mutable.conj.f2",de.a);r("mori.mutable.conj.fn",de.K);r("mori.mutable.assoc",ee);r("mori.mutable.assoc.f3",ee.c);r("mori.mutable.assoc.fn",ee.K);r("mori.mutable.dissoc",fe);r("mori.mutable.dissoc.f2",fe.a);r("mori.mutable.dissoc.fn",fe.K);r("mori.mutable.pop",function(a){return Ub(a)});r("mori.mutable.disj",ge);
r("mori.mutable.disj.f2",ge.a);r("mori.mutable.disj.fn",ge.K);;return this.mori;}.call({});});

},{}],6:[function(require,module,exports){
'use strict';

module.exports = require('./lib')

},{"./lib":11}],7:[function(require,module,exports){
'use strict';

var asap = require('asap/raw');

function noop() {}

// States:
//
// 0 - pending
// 1 - fulfilled with _value
// 2 - rejected with _value
// 3 - adopted the state of another promise, _value
//
// once the state is no longer pending (0) it is immutable

// All `_` prefixed properties will be reduced to `_{random number}`
// at build time to obfuscate them and discourage their use.
// We don't use symbols or Object.defineProperty to fully hide them
// because the performance isn't good enough.


// to avoid using try/catch inside critical functions, we
// extract them to here.
var LAST_ERROR = null;
var IS_ERROR = {};
function getThen(obj) {
  try {
    return obj.then;
  } catch (ex) {
    LAST_ERROR = ex;
    return IS_ERROR;
  }
}

function tryCallOne(fn, a) {
  try {
    return fn(a);
  } catch (ex) {
    LAST_ERROR = ex;
    return IS_ERROR;
  }
}
function tryCallTwo(fn, a, b) {
  try {
    fn(a, b);
  } catch (ex) {
    LAST_ERROR = ex;
    return IS_ERROR;
  }
}

module.exports = Promise;

function Promise(fn) {
  if (typeof this !== 'object') {
    throw new TypeError('Promises must be constructed via new');
  }
  if (typeof fn !== 'function') {
    throw new TypeError('not a function');
  }
  this._45 = 0;
  this._81 = 0;
  this._65 = null;
  this._54 = null;
  if (fn === noop) return;
  doResolve(fn, this);
}
Promise._10 = null;
Promise._97 = null;
Promise._61 = noop;

Promise.prototype.then = function(onFulfilled, onRejected) {
  if (this.constructor !== Promise) {
    return safeThen(this, onFulfilled, onRejected);
  }
  var res = new Promise(noop);
  handle(this, new Handler(onFulfilled, onRejected, res));
  return res;
};

function safeThen(self, onFulfilled, onRejected) {
  return new self.constructor(function (resolve, reject) {
    var res = new Promise(noop);
    res.then(resolve, reject);
    handle(self, new Handler(onFulfilled, onRejected, res));
  });
};
function handle(self, deferred) {
  while (self._81 === 3) {
    self = self._65;
  }
  if (Promise._10) {
    Promise._10(self);
  }
  if (self._81 === 0) {
    if (self._45 === 0) {
      self._45 = 1;
      self._54 = deferred;
      return;
    }
    if (self._45 === 1) {
      self._45 = 2;
      self._54 = [self._54, deferred];
      return;
    }
    self._54.push(deferred);
    return;
  }
  handleResolved(self, deferred);
}

function handleResolved(self, deferred) {
  asap(function() {
    var cb = self._81 === 1 ? deferred.onFulfilled : deferred.onRejected;
    if (cb === null) {
      if (self._81 === 1) {
        resolve(deferred.promise, self._65);
      } else {
        reject(deferred.promise, self._65);
      }
      return;
    }
    var ret = tryCallOne(cb, self._65);
    if (ret === IS_ERROR) {
      reject(deferred.promise, LAST_ERROR);
    } else {
      resolve(deferred.promise, ret);
    }
  });
}
function resolve(self, newValue) {
  // Promise Resolution Procedure: https://github.com/promises-aplus/promises-spec#the-promise-resolution-procedure
  if (newValue === self) {
    return reject(
      self,
      new TypeError('A promise cannot be resolved with itself.')
    );
  }
  if (
    newValue &&
    (typeof newValue === 'object' || typeof newValue === 'function')
  ) {
    var then = getThen(newValue);
    if (then === IS_ERROR) {
      return reject(self, LAST_ERROR);
    }
    if (
      then === self.then &&
      newValue instanceof Promise
    ) {
      self._81 = 3;
      self._65 = newValue;
      finale(self);
      return;
    } else if (typeof then === 'function') {
      doResolve(then.bind(newValue), self);
      return;
    }
  }
  self._81 = 1;
  self._65 = newValue;
  finale(self);
}

function reject(self, newValue) {
  self._81 = 2;
  self._65 = newValue;
  if (Promise._97) {
    Promise._97(self, newValue);
  }
  finale(self);
}
function finale(self) {
  if (self._45 === 1) {
    handle(self, self._54);
    self._54 = null;
  }
  if (self._45 === 2) {
    for (var i = 0; i < self._54.length; i++) {
      handle(self, self._54[i]);
    }
    self._54 = null;
  }
}

function Handler(onFulfilled, onRejected, promise){
  this.onFulfilled = typeof onFulfilled === 'function' ? onFulfilled : null;
  this.onRejected = typeof onRejected === 'function' ? onRejected : null;
  this.promise = promise;
}

/**
 * Take a potentially misbehaving resolver function and make sure
 * onFulfilled and onRejected are only called once.
 *
 * Makes no guarantees about asynchrony.
 */
function doResolve(fn, promise) {
  var done = false;
  var res = tryCallTwo(fn, function (value) {
    if (done) return;
    done = true;
    resolve(promise, value);
  }, function (reason) {
    if (done) return;
    done = true;
    reject(promise, reason);
  })
  if (!done && res === IS_ERROR) {
    done = true;
    reject(promise, LAST_ERROR);
  }
}

},{"asap/raw":2}],8:[function(require,module,exports){
'use strict';

var Promise = require('./core.js');

module.exports = Promise;
Promise.prototype.done = function (onFulfilled, onRejected) {
  var self = arguments.length ? this.then.apply(this, arguments) : this;
  self.then(null, function (err) {
    setTimeout(function () {
      throw err;
    }, 0);
  });
};

},{"./core.js":7}],9:[function(require,module,exports){
'use strict';

//This file contains the ES6 extensions to the core Promises/A+ API

var Promise = require('./core.js');

module.exports = Promise;

/* Static Functions */

var TRUE = valuePromise(true);
var FALSE = valuePromise(false);
var NULL = valuePromise(null);
var UNDEFINED = valuePromise(undefined);
var ZERO = valuePromise(0);
var EMPTYSTRING = valuePromise('');

function valuePromise(value) {
  var p = new Promise(Promise._61);
  p._81 = 1;
  p._65 = value;
  return p;
}
Promise.resolve = function (value) {
  if (value instanceof Promise) return value;

  if (value === null) return NULL;
  if (value === undefined) return UNDEFINED;
  if (value === true) return TRUE;
  if (value === false) return FALSE;
  if (value === 0) return ZERO;
  if (value === '') return EMPTYSTRING;

  if (typeof value === 'object' || typeof value === 'function') {
    try {
      var then = value.then;
      if (typeof then === 'function') {
        return new Promise(then.bind(value));
      }
    } catch (ex) {
      return new Promise(function (resolve, reject) {
        reject(ex);
      });
    }
  }
  return valuePromise(value);
};

Promise.all = function (arr) {
  var args = Array.prototype.slice.call(arr);

  return new Promise(function (resolve, reject) {
    if (args.length === 0) return resolve([]);
    var remaining = args.length;
    function res(i, val) {
      if (val && (typeof val === 'object' || typeof val === 'function')) {
        if (val instanceof Promise && val.then === Promise.prototype.then) {
          while (val._81 === 3) {
            val = val._65;
          }
          if (val._81 === 1) return res(i, val._65);
          if (val._81 === 2) reject(val._65);
          val.then(function (val) {
            res(i, val);
          }, reject);
          return;
        } else {
          var then = val.then;
          if (typeof then === 'function') {
            var p = new Promise(then.bind(val));
            p.then(function (val) {
              res(i, val);
            }, reject);
            return;
          }
        }
      }
      args[i] = val;
      if (--remaining === 0) {
        resolve(args);
      }
    }
    for (var i = 0; i < args.length; i++) {
      res(i, args[i]);
    }
  });
};

Promise.reject = function (value) {
  return new Promise(function (resolve, reject) {
    reject(value);
  });
};

Promise.race = function (values) {
  return new Promise(function (resolve, reject) {
    values.forEach(function(value){
      Promise.resolve(value).then(resolve, reject);
    });
  });
};

/* Prototype Methods */

Promise.prototype['catch'] = function (onRejected) {
  return this.then(null, onRejected);
};

},{"./core.js":7}],10:[function(require,module,exports){
'use strict';

var Promise = require('./core.js');

module.exports = Promise;
Promise.prototype['finally'] = function (f) {
  return this.then(function (value) {
    return Promise.resolve(f()).then(function () {
      return value;
    });
  }, function (err) {
    return Promise.resolve(f()).then(function () {
      throw err;
    });
  });
};

},{"./core.js":7}],11:[function(require,module,exports){
'use strict';

module.exports = require('./core.js');
require('./done.js');
require('./finally.js');
require('./es6-extensions.js');
require('./node-extensions.js');
require('./synchronous.js');

},{"./core.js":7,"./done.js":8,"./es6-extensions.js":9,"./finally.js":10,"./node-extensions.js":12,"./synchronous.js":13}],12:[function(require,module,exports){
'use strict';

// This file contains then/promise specific extensions that are only useful
// for node.js interop

var Promise = require('./core.js');
var asap = require('asap');

module.exports = Promise;

/* Static Functions */

Promise.denodeify = function (fn, argumentCount) {
  if (
    typeof argumentCount === 'number' && argumentCount !== Infinity
  ) {
    return denodeifyWithCount(fn, argumentCount);
  } else {
    return denodeifyWithoutCount(fn);
  }
}

var callbackFn = (
  'function (err, res) {' +
  'if (err) { rj(err); } else { rs(res); }' +
  '}'
);
function denodeifyWithCount(fn, argumentCount) {
  var args = [];
  for (var i = 0; i < argumentCount; i++) {
    args.push('a' + i);
  }
  var body = [
    'return function (' + args.join(',') + ') {',
    'var self = this;',
    'return new Promise(function (rs, rj) {',
    'var res = fn.call(',
    ['self'].concat(args).concat([callbackFn]).join(','),
    ');',
    'if (res &&',
    '(typeof res === "object" || typeof res === "function") &&',
    'typeof res.then === "function"',
    ') {rs(res);}',
    '});',
    '};'
  ].join('');
  return Function(['Promise', 'fn'], body)(Promise, fn);
}
function denodeifyWithoutCount(fn) {
  var fnLength = Math.max(fn.length - 1, 3);
  var args = [];
  for (var i = 0; i < fnLength; i++) {
    args.push('a' + i);
  }
  var body = [
    'return function (' + args.join(',') + ') {',
    'var self = this;',
    'var args;',
    'var argLength = arguments.length;',
    'if (arguments.length > ' + fnLength + ') {',
    'args = new Array(arguments.length + 1);',
    'for (var i = 0; i < arguments.length; i++) {',
    'args[i] = arguments[i];',
    '}',
    '}',
    'return new Promise(function (rs, rj) {',
    'var cb = ' + callbackFn + ';',
    'var res;',
    'switch (argLength) {',
    args.concat(['extra']).map(function (_, index) {
      return (
        'case ' + (index) + ':' +
        'res = fn.call(' + ['self'].concat(args.slice(0, index)).concat('cb').join(',') + ');' +
        'break;'
      );
    }).join(''),
    'default:',
    'args[argLength] = cb;',
    'res = fn.apply(self, args);',
    '}',
    
    'if (res &&',
    '(typeof res === "object" || typeof res === "function") &&',
    'typeof res.then === "function"',
    ') {rs(res);}',
    '});',
    '};'
  ].join('');

  return Function(
    ['Promise', 'fn'],
    body
  )(Promise, fn);
}

Promise.nodeify = function (fn) {
  return function () {
    var args = Array.prototype.slice.call(arguments);
    var callback =
      typeof args[args.length - 1] === 'function' ? args.pop() : null;
    var ctx = this;
    try {
      return fn.apply(this, arguments).nodeify(callback, ctx);
    } catch (ex) {
      if (callback === null || typeof callback == 'undefined') {
        return new Promise(function (resolve, reject) {
          reject(ex);
        });
      } else {
        asap(function () {
          callback.call(ctx, ex);
        })
      }
    }
  }
}

Promise.prototype.nodeify = function (callback, ctx) {
  if (typeof callback != 'function') return this;

  this.then(function (value) {
    asap(function () {
      callback.call(ctx, null, value);
    });
  }, function (err) {
    asap(function () {
      callback.call(ctx, err);
    });
  });
}

},{"./core.js":7,"asap":1}],13:[function(require,module,exports){
'use strict';

var Promise = require('./core.js');

module.exports = Promise;
Promise.enableSynchronous = function () {
  Promise.prototype.isPending = function() {
    return this.getState() == 0;
  };

  Promise.prototype.isFulfilled = function() {
    return this.getState() == 1;
  };

  Promise.prototype.isRejected = function() {
    return this.getState() == 2;
  };

  Promise.prototype.getValue = function () {
    if (this._81 === 3) {
      return this._65.getValue();
    }

    if (!this.isFulfilled()) {
      throw new Error('Cannot get a value of an unfulfilled promise.');
    }

    return this._65;
  };

  Promise.prototype.getReason = function () {
    if (this._81 === 3) {
      return this._65.getReason();
    }

    if (!this.isRejected()) {
      throw new Error('Cannot get a rejection reason of a non-rejected promise.');
    }

    return this._65;
  };

  Promise.prototype.getState = function () {
    if (this._81 === 3) {
      return this._65.getState();
    }
    if (this._81 === -1 || this._81 === -2) {
      return 0;
    }

    return this._81;
  };
};

Promise.disableSynchronous = function() {
  Promise.prototype.isPending = undefined;
  Promise.prototype.isFulfilled = undefined;
  Promise.prototype.isRejected = undefined;
  Promise.prototype.getValue = undefined;
  Promise.prototype.getReason = undefined;
  Promise.prototype.getState = undefined;
};

},{"./core.js":7}],14:[function(require,module,exports){
'use strict';

var Stringify = require('./stringify');
var Parse = require('./parse');

module.exports = {
    stringify: Stringify,
    parse: Parse
};

},{"./parse":15,"./stringify":16}],15:[function(require,module,exports){
'use strict';

var Utils = require('./utils');

var internals = {
    delimiter: '&',
    depth: 5,
    arrayLimit: 20,
    parameterLimit: 1000,
    strictNullHandling: false,
    plainObjects: false,
    allowPrototypes: false,
    allowDots: false
};

internals.parseValues = function (str, options) {
    var obj = {};
    var parts = str.split(options.delimiter, options.parameterLimit === Infinity ? undefined : options.parameterLimit);

    for (var i = 0; i < parts.length; ++i) {
        var part = parts[i];
        var pos = part.indexOf(']=') === -1 ? part.indexOf('=') : part.indexOf(']=') + 1;

        if (pos === -1) {
            obj[Utils.decode(part)] = '';

            if (options.strictNullHandling) {
                obj[Utils.decode(part)] = null;
            }
        } else {
            var key = Utils.decode(part.slice(0, pos));
            var val = Utils.decode(part.slice(pos + 1));

            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                obj[key] = [].concat(obj[key]).concat(val);
            } else {
                obj[key] = val;
            }
        }
    }

    return obj;
};

internals.parseObject = function (chain, val, options) {
    if (!chain.length) {
        return val;
    }

    var root = chain.shift();

    var obj;
    if (root === '[]') {
        obj = [];
        obj = obj.concat(internals.parseObject(chain, val, options));
    } else {
        obj = options.plainObjects ? Object.create(null) : {};
        var cleanRoot = root[0] === '[' && root[root.length - 1] === ']' ? root.slice(1, root.length - 1) : root;
        var index = parseInt(cleanRoot, 10);
        if (
            !isNaN(index) &&
            root !== cleanRoot &&
            String(index) === cleanRoot &&
            index >= 0 &&
            (options.parseArrays && index <= options.arrayLimit)
        ) {
            obj = [];
            obj[index] = internals.parseObject(chain, val, options);
        } else {
            obj[cleanRoot] = internals.parseObject(chain, val, options);
        }
    }

    return obj;
};

internals.parseKeys = function (givenKey, val, options) {
    if (!givenKey) {
        return;
    }

    // Transform dot notation to bracket notation
    var key = options.allowDots ? givenKey.replace(/\.([^\.\[]+)/g, '[$1]') : givenKey;

    // The regex chunks

    var parent = /^([^\[\]]*)/;
    var child = /(\[[^\[\]]*\])/g;

    // Get the parent

    var segment = parent.exec(key);

    // Stash the parent if it exists

    var keys = [];
    if (segment[1]) {
        // If we aren't using plain objects, optionally prefix keys
        // that would overwrite object prototype properties
        if (!options.plainObjects && Object.prototype.hasOwnProperty(segment[1])) {
            if (!options.allowPrototypes) {
                return;
            }
        }

        keys.push(segment[1]);
    }

    // Loop through children appending to the array until we hit depth

    var i = 0;
    while ((segment = child.exec(key)) !== null && i < options.depth) {
        i += 1;
        if (!options.plainObjects && Object.prototype.hasOwnProperty(segment[1].replace(/\[|\]/g, ''))) {
            if (!options.allowPrototypes) {
                continue;
            }
        }
        keys.push(segment[1]);
    }

    // If there's a remainder, just add whatever is left

    if (segment) {
        keys.push('[' + key.slice(segment.index) + ']');
    }

    return internals.parseObject(keys, val, options);
};

module.exports = function (str, opts) {
    var options = opts || {};
    options.delimiter = typeof options.delimiter === 'string' || Utils.isRegExp(options.delimiter) ? options.delimiter : internals.delimiter;
    options.depth = typeof options.depth === 'number' ? options.depth : internals.depth;
    options.arrayLimit = typeof options.arrayLimit === 'number' ? options.arrayLimit : internals.arrayLimit;
    options.parseArrays = options.parseArrays !== false;
    options.allowDots = typeof options.allowDots === 'boolean' ? options.allowDots : internals.allowDots;
    options.plainObjects = typeof options.plainObjects === 'boolean' ? options.plainObjects : internals.plainObjects;
    options.allowPrototypes = typeof options.allowPrototypes === 'boolean' ? options.allowPrototypes : internals.allowPrototypes;
    options.parameterLimit = typeof options.parameterLimit === 'number' ? options.parameterLimit : internals.parameterLimit;
    options.strictNullHandling = typeof options.strictNullHandling === 'boolean' ? options.strictNullHandling : internals.strictNullHandling;

    if (
        str === '' ||
        str === null ||
        typeof str === 'undefined'
    ) {
        return options.plainObjects ? Object.create(null) : {};
    }

    var tempObj = typeof str === 'string' ? internals.parseValues(str, options) : str;
    var obj = options.plainObjects ? Object.create(null) : {};

    // Iterate over the keys and setup the new object

    var keys = Object.keys(tempObj);
    for (var i = 0; i < keys.length; ++i) {
        var key = keys[i];
        var newObj = internals.parseKeys(key, tempObj[key], options);
        obj = Utils.merge(obj, newObj, options);
    }

    return Utils.compact(obj);
};

},{"./utils":17}],16:[function(require,module,exports){
'use strict';

var Utils = require('./utils');

var internals = {
    delimiter: '&',
    arrayPrefixGenerators: {
        brackets: function (prefix) {
            return prefix + '[]';
        },
        indices: function (prefix, key) {
            return prefix + '[' + key + ']';
        },
        repeat: function (prefix) {
            return prefix;
        }
    },
    strictNullHandling: false,
    skipNulls: false,
    encode: true
};

internals.stringify = function (object, prefix, generateArrayPrefix, strictNullHandling, skipNulls, encode, filter, sort, allowDots) {
    var obj = object;
    if (typeof filter === 'function') {
        obj = filter(prefix, obj);
    } else if (Utils.isBuffer(obj)) {
        obj = String(obj);
    } else if (obj instanceof Date) {
        obj = obj.toISOString();
    } else if (obj === null) {
        if (strictNullHandling) {
            return encode ? Utils.encode(prefix) : prefix;
        }

        obj = '';
    }

    if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') {
        if (encode) {
            return [Utils.encode(prefix) + '=' + Utils.encode(obj)];
        }
        return [prefix + '=' + obj];
    }

    var values = [];

    if (typeof obj === 'undefined') {
        return values;
    }

    var objKeys;
    if (Array.isArray(filter)) {
        objKeys = filter;
    } else {
        var keys = Object.keys(obj);
        objKeys = sort ? keys.sort(sort) : keys;
    }

    for (var i = 0; i < objKeys.length; ++i) {
        var key = objKeys[i];

        if (skipNulls && obj[key] === null) {
            continue;
        }

        if (Array.isArray(obj)) {
            values = values.concat(internals.stringify(obj[key], generateArrayPrefix(prefix, key), generateArrayPrefix, strictNullHandling, skipNulls, encode, filter, sort, allowDots));
        } else {
            values = values.concat(internals.stringify(obj[key], prefix + (allowDots ? '.' + key : '[' + key + ']'), generateArrayPrefix, strictNullHandling, skipNulls, encode, filter, sort, allowDots));
        }
    }

    return values;
};

module.exports = function (object, opts) {
    var obj = object;
    var options = opts || {};
    var delimiter = typeof options.delimiter === 'undefined' ? internals.delimiter : options.delimiter;
    var strictNullHandling = typeof options.strictNullHandling === 'boolean' ? options.strictNullHandling : internals.strictNullHandling;
    var skipNulls = typeof options.skipNulls === 'boolean' ? options.skipNulls : internals.skipNulls;
    var encode = typeof options.encode === 'boolean' ? options.encode : internals.encode;
    var sort = typeof options.sort === 'function' ? options.sort : null;
    var allowDots = typeof options.allowDots === 'undefined' ? false : options.allowDots;
    var objKeys;
    var filter;
    if (typeof options.filter === 'function') {
        filter = options.filter;
        obj = filter('', obj);
    } else if (Array.isArray(options.filter)) {
        objKeys = filter = options.filter;
    }

    var keys = [];

    if (typeof obj !== 'object' || obj === null) {
        return '';
    }

    var arrayFormat;
    if (options.arrayFormat in internals.arrayPrefixGenerators) {
        arrayFormat = options.arrayFormat;
    } else if ('indices' in options) {
        arrayFormat = options.indices ? 'indices' : 'repeat';
    } else {
        arrayFormat = 'indices';
    }

    var generateArrayPrefix = internals.arrayPrefixGenerators[arrayFormat];

    if (!objKeys) {
        objKeys = Object.keys(obj);
    }

    if (sort) {
        objKeys.sort(sort);
    }

    for (var i = 0; i < objKeys.length; ++i) {
        var key = objKeys[i];

        if (skipNulls && obj[key] === null) {
            continue;
        }

        keys = keys.concat(internals.stringify(obj[key], key, generateArrayPrefix, strictNullHandling, skipNulls, encode, filter, sort, allowDots));
    }

    return keys.join(delimiter);
};

},{"./utils":17}],17:[function(require,module,exports){
'use strict';

var hexTable = (function () {
    var array = new Array(256);
    for (var i = 0; i < 256; ++i) {
        array[i] = '%' + ((i < 16 ? '0' : '') + i.toString(16)).toUpperCase();
    }

    return array;
}());

exports.arrayToObject = function (source, options) {
    var obj = options.plainObjects ? Object.create(null) : {};
    for (var i = 0; i < source.length; ++i) {
        if (typeof source[i] !== 'undefined') {
            obj[i] = source[i];
        }
    }

    return obj;
};

exports.merge = function (target, source, options) {
    if (!source) {
        return target;
    }

    if (typeof source !== 'object') {
        if (Array.isArray(target)) {
            target.push(source);
        } else if (typeof target === 'object') {
            target[source] = true;
        } else {
            return [target, source];
        }

        return target;
    }

    if (typeof target !== 'object') {
        return [target].concat(source);
    }

    var mergeTarget = target;
    if (Array.isArray(target) && !Array.isArray(source)) {
        mergeTarget = exports.arrayToObject(target, options);
    }

	return Object.keys(source).reduce(function (acc, key) {
        var value = source[key];

        if (Object.prototype.hasOwnProperty.call(acc, key)) {
            acc[key] = exports.merge(acc[key], value, options);
        } else {
            acc[key] = value;
        }
		return acc;
    }, mergeTarget);
};

exports.decode = function (str) {
    try {
        return decodeURIComponent(str.replace(/\+/g, ' '));
    } catch (e) {
        return str;
    }
};

exports.encode = function (str) {
    // This code was originally written by Brian White (mscdex) for the io.js core querystring library.
    // It has been adapted here for stricter adherence to RFC 3986
    if (str.length === 0) {
        return str;
    }

    var string = typeof str === 'string' ? str : String(str);

    var out = '';
    for (var i = 0; i < string.length; ++i) {
        var c = string.charCodeAt(i);

        if (
            c === 0x2D || // -
            c === 0x2E || // .
            c === 0x5F || // _
            c === 0x7E || // ~
            (c >= 0x30 && c <= 0x39) || // 0-9
            (c >= 0x41 && c <= 0x5A) || // a-z
            (c >= 0x61 && c <= 0x7A) // A-Z
        ) {
            out += string.charAt(i);
            continue;
        }

        if (c < 0x80) {
            out = out + hexTable[c];
            continue;
        }

        if (c < 0x800) {
            out = out + (hexTable[0xC0 | (c >> 6)] + hexTable[0x80 | (c & 0x3F)]);
            continue;
        }

        if (c < 0xD800 || c >= 0xE000) {
            out = out + (hexTable[0xE0 | (c >> 12)] + hexTable[0x80 | ((c >> 6) & 0x3F)] + hexTable[0x80 | (c & 0x3F)]);
            continue;
        }

        i += 1;
        c = 0x10000 + (((c & 0x3FF) << 10) | (string.charCodeAt(i) & 0x3FF));
        out += (hexTable[0xF0 | (c >> 18)] + hexTable[0x80 | ((c >> 12) & 0x3F)] + hexTable[0x80 | ((c >> 6) & 0x3F)] + hexTable[0x80 | (c & 0x3F)]);
    }

    return out;
};

exports.compact = function (obj, references) {
    if (typeof obj !== 'object' || obj === null) {
        return obj;
    }

    var refs = references || [];
    var lookup = refs.indexOf(obj);
    if (lookup !== -1) {
        return refs[lookup];
    }

    refs.push(obj);

    if (Array.isArray(obj)) {
        var compacted = [];

        for (var i = 0; i < obj.length; ++i) {
            if (typeof obj[i] !== 'undefined') {
                compacted.push(obj[i]);
            }
        }

        return compacted;
    }

    var keys = Object.keys(obj);
    for (var j = 0; j < keys.length; ++j) {
        var key = keys[j];
        obj[key] = exports.compact(obj[key], refs);
    }

    return obj;
};

exports.isRegExp = function (obj) {
    return Object.prototype.toString.call(obj) === '[object RegExp]';
};

exports.isBuffer = function (obj) {
    if (obj === null || typeof obj === 'undefined') {
        return false;
    }

    return !!(obj.constructor && obj.constructor.isBuffer && obj.constructor.isBuffer(obj));
};

},{}],18:[function(require,module,exports){
var _arity = require('./internal/_arity');
var _curry1 = require('./internal/_curry1');
var _curry2 = require('./internal/_curry2');
var _curryN = require('./internal/_curryN');


/**
 * Returns a curried equivalent of the provided function, with the specified
 * arity. The curried function has two unusual capabilities. First, its
 * arguments needn't be provided one at a time. If `g` is `R.curryN(3, f)`, the
 * following are equivalent:
 *
 *   - `g(1)(2)(3)`
 *   - `g(1)(2, 3)`
 *   - `g(1, 2)(3)`
 *   - `g(1, 2, 3)`
 *
 * Secondly, the special placeholder value `R.__` may be used to specify
 * "gaps", allowing partial application of any combination of arguments,
 * regardless of their positions. If `g` is as above and `_` is `R.__`, the
 * following are equivalent:
 *
 *   - `g(1, 2, 3)`
 *   - `g(_, 2, 3)(1)`
 *   - `g(_, _, 3)(1)(2)`
 *   - `g(_, _, 3)(1, 2)`
 *   - `g(_, 2)(1)(3)`
 *   - `g(_, 2)(1, 3)`
 *   - `g(_, 2)(_, 3)(1)`
 *
 * @func
 * @memberOf R
 * @since v0.5.0
 * @category Function
 * @sig Number -> (* -> a) -> (* -> a)
 * @param {Number} length The arity for the returned function.
 * @param {Function} fn The function to curry.
 * @return {Function} A new, curried function.
 * @see R.curry
 * @example
 *
 *      var sumArgs = (...args) => R.sum(args);
 *
 *      var curriedAddFourNumbers = R.curryN(4, sumArgs);
 *      var f = curriedAddFourNumbers(1, 2);
 *      var g = f(3);
 *      g(4); //=> 10
 */
module.exports = _curry2(function curryN(length, fn) {
  if (length === 1) {
    return _curry1(fn);
  }
  return _arity(length, _curryN(length, [], fn));
});

},{"./internal/_arity":19,"./internal/_curry1":20,"./internal/_curry2":21,"./internal/_curryN":22}],19:[function(require,module,exports){
module.exports = function _arity(n, fn) {
  /* eslint-disable no-unused-vars */
  switch (n) {
    case 0: return function() { return fn.apply(this, arguments); };
    case 1: return function(a0) { return fn.apply(this, arguments); };
    case 2: return function(a0, a1) { return fn.apply(this, arguments); };
    case 3: return function(a0, a1, a2) { return fn.apply(this, arguments); };
    case 4: return function(a0, a1, a2, a3) { return fn.apply(this, arguments); };
    case 5: return function(a0, a1, a2, a3, a4) { return fn.apply(this, arguments); };
    case 6: return function(a0, a1, a2, a3, a4, a5) { return fn.apply(this, arguments); };
    case 7: return function(a0, a1, a2, a3, a4, a5, a6) { return fn.apply(this, arguments); };
    case 8: return function(a0, a1, a2, a3, a4, a5, a6, a7) { return fn.apply(this, arguments); };
    case 9: return function(a0, a1, a2, a3, a4, a5, a6, a7, a8) { return fn.apply(this, arguments); };
    case 10: return function(a0, a1, a2, a3, a4, a5, a6, a7, a8, a9) { return fn.apply(this, arguments); };
    default: throw new Error('First argument to _arity must be a non-negative integer no greater than ten');
  }
};

},{}],20:[function(require,module,exports){
var _isPlaceholder = require('./_isPlaceholder');


/**
 * Optimized internal one-arity curry function.
 *
 * @private
 * @category Function
 * @param {Function} fn The function to curry.
 * @return {Function} The curried function.
 */
module.exports = function _curry1(fn) {
  return function f1(a) {
    if (arguments.length === 0 || _isPlaceholder(a)) {
      return f1;
    } else {
      return fn.apply(this, arguments);
    }
  };
};

},{"./_isPlaceholder":23}],21:[function(require,module,exports){
var _curry1 = require('./_curry1');
var _isPlaceholder = require('./_isPlaceholder');


/**
 * Optimized internal two-arity curry function.
 *
 * @private
 * @category Function
 * @param {Function} fn The function to curry.
 * @return {Function} The curried function.
 */
module.exports = function _curry2(fn) {
  return function f2(a, b) {
    switch (arguments.length) {
      case 0:
        return f2;
      case 1:
        return _isPlaceholder(a) ? f2
             : _curry1(function(_b) { return fn(a, _b); });
      default:
        return _isPlaceholder(a) && _isPlaceholder(b) ? f2
             : _isPlaceholder(a) ? _curry1(function(_a) { return fn(_a, b); })
             : _isPlaceholder(b) ? _curry1(function(_b) { return fn(a, _b); })
             : fn(a, b);
    }
  };
};

},{"./_curry1":20,"./_isPlaceholder":23}],22:[function(require,module,exports){
var _arity = require('./_arity');
var _isPlaceholder = require('./_isPlaceholder');


/**
 * Internal curryN function.
 *
 * @private
 * @category Function
 * @param {Number} length The arity of the curried function.
 * @param {Array} received An array of arguments received thus far.
 * @param {Function} fn The function to curry.
 * @return {Function} The curried function.
 */
module.exports = function _curryN(length, received, fn) {
  return function() {
    var combined = [];
    var argsIdx = 0;
    var left = length;
    var combinedIdx = 0;
    while (combinedIdx < received.length || argsIdx < arguments.length) {
      var result;
      if (combinedIdx < received.length &&
          (!_isPlaceholder(received[combinedIdx]) ||
           argsIdx >= arguments.length)) {
        result = received[combinedIdx];
      } else {
        result = arguments[argsIdx];
        argsIdx += 1;
      }
      combined[combinedIdx] = result;
      if (!_isPlaceholder(result)) {
        left -= 1;
      }
      combinedIdx += 1;
    }
    return left <= 0 ? fn.apply(this, combined)
                     : _arity(left, _curryN(length, combined, fn));
  };
};

},{"./_arity":19,"./_isPlaceholder":23}],23:[function(require,module,exports){
module.exports = function _isPlaceholder(a) {
  return a != null &&
         typeof a === 'object' &&
         a['@@functional/placeholder'] === true;
};

},{}],24:[function(require,module,exports){
var VNode = require('./vnode');
var is = require('./is');

function addNS(data, children) {
  data.ns = 'http://www.w3.org/2000/svg';
  if (children !== undefined) {
    for (var i = 0; i < children.length; ++i) {
      addNS(children[i].data, children[i].children);
    }
  }
}

module.exports = function h(sel, b, c) {
  var data = {}, children, text, i;
  if (c !== undefined) {
    data = b;
    if (is.array(c)) { children = c; }
    else if (is.primitive(c)) { text = c; }
  } else if (b !== undefined) {
    if (is.array(b)) { children = b; }
    else if (is.primitive(b)) { text = b; }
    else { data = b; }
  }
  if (is.array(children)) {
    for (i = 0; i < children.length; ++i) {
      if (is.primitive(children[i])) children[i] = VNode(undefined, undefined, undefined, children[i]);
    }
  }
  if (sel[0] === 's' && sel[1] === 'v' && sel[2] === 'g') {
    addNS(data, children);
  }
  return VNode(sel, data, children, text, undefined);
};

},{"./is":26,"./vnode":33}],25:[function(require,module,exports){
function createElement(tagName){
  return document.createElement(tagName);
}

function createElementNS(namespaceURI, qualifiedName){
  return document.createElementNS(namespaceURI, qualifiedName);
}

function createTextNode(text){
  return document.createTextNode(text);
}


function insertBefore(parentNode, newNode, referenceNode){
  parentNode.insertBefore(newNode, referenceNode);
}


function removeChild(node, child){
  node.removeChild(child);
}

function appendChild(node, child){
  node.appendChild(child);
}

function parentNode(node){
  return node.parentElement;
}

function nextSibling(node){
  return node.nextSibling;
}

function tagName(node){
  return node.tagName;
}

function setTextContent(node, text){
  node.textContent = text;
}

module.exports = {
  createElement: createElement,
  createElementNS: createElementNS,
  createTextNode: createTextNode,
  appendChild: appendChild,
  removeChild: removeChild,
  insertBefore: insertBefore,
  parentNode: parentNode,
  nextSibling: nextSibling,
  tagName: tagName,
  setTextContent: setTextContent
};

},{}],26:[function(require,module,exports){
module.exports = {
  array: Array.isArray,
  primitive: function(s) { return typeof s === 'string' || typeof s === 'number'; },
};

},{}],27:[function(require,module,exports){
var booleanAttrs = ["allowfullscreen", "async", "autofocus", "autoplay", "checked", "compact", "controls", "declare", 
                "default", "defaultchecked", "defaultmuted", "defaultselected", "defer", "disabled", "draggable", 
                "enabled", "formnovalidate", "hidden", "indeterminate", "inert", "ismap", "itemscope", "loop", "multiple", 
                "muted", "nohref", "noresize", "noshade", "novalidate", "nowrap", "open", "pauseonexit", "readonly", 
                "required", "reversed", "scoped", "seamless", "selected", "sortable", "spellcheck", "translate", 
                "truespeed", "typemustmatch", "visible"];
    
var booleanAttrsDict = {};
for(var i=0, len = booleanAttrs.length; i < len; i++) {
  booleanAttrsDict[booleanAttrs[i]] = true;
}
    
function updateAttrs(oldVnode, vnode) {
  var key, cur, old, elm = vnode.elm,
      oldAttrs = oldVnode.data.attrs || {}, attrs = vnode.data.attrs || {};
  
  // update modified attributes, add new attributes
  for (key in attrs) {
    cur = attrs[key];
    old = oldAttrs[key];
    if (old !== cur) {
      // TODO: add support to namespaced attributes (setAttributeNS)
      if(!cur && booleanAttrsDict[key])
        elm.removeAttribute(key);
      else
        elm.setAttribute(key, cur);
    }
  }
  //remove removed attributes
  // use `in` operator since the previous `for` iteration uses it (.i.e. add even attributes with undefined value)
  // the other option is to remove all attributes with value == undefined
  for (key in oldAttrs) {
    if (!(key in attrs)) {
      elm.removeAttribute(key);
    }
  }
}

module.exports = {create: updateAttrs, update: updateAttrs};

},{}],28:[function(require,module,exports){
function updateClass(oldVnode, vnode) {
  var cur, name, elm = vnode.elm,
      oldClass = oldVnode.data.class || {},
      klass = vnode.data.class || {};
  for (name in oldClass) {
    if (!klass[name]) {
      elm.classList.remove(name);
    }
  }
  for (name in klass) {
    cur = klass[name];
    if (cur !== oldClass[name]) {
      elm.classList[cur ? 'add' : 'remove'](name);
    }
  }
}

module.exports = {create: updateClass, update: updateClass};

},{}],29:[function(require,module,exports){
var is = require('../is');

function arrInvoker(arr) {
  return function() {
    if (!arr.length) return;
    // Special case when length is two, for performance
    arr.length === 2 ? arr[0](arr[1]) : arr[0].apply(undefined, arr.slice(1));
  };
}

function fnInvoker(o) {
  return function(ev) { 
    if (o.fn === null) return;
    o.fn(ev); 
  };
}

function updateEventListeners(oldVnode, vnode) {
  var name, cur, old, elm = vnode.elm,
      oldOn = oldVnode.data.on || {}, on = vnode.data.on;
  if (!on) return;
  for (name in on) {
    cur = on[name];
    old = oldOn[name];
    if (old === undefined) {
      if (is.array(cur)) {
        elm.addEventListener(name, arrInvoker(cur));
      } else {
        cur = {fn: cur};
        on[name] = cur;
        elm.addEventListener(name, fnInvoker(cur));
      }
    } else if (is.array(old)) {
      // Deliberately modify old array since it's captured in closure created with `arrInvoker`
      old.length = cur.length;
      for (var i = 0; i < old.length; ++i) old[i] = cur[i];
      on[name]  = old;
    } else {
      old.fn = cur;
      on[name] = old;
    }
  }
  if (oldOn) {
    for (name in oldOn) {
      if (on[name] === undefined) {
        var old = oldOn[name];
        if (is.array(old)) {
          old.length = 0;
        }
        else {
          old.fn = null;
        }
      }
    }
  }
}

module.exports = {create: updateEventListeners, update: updateEventListeners};

},{"../is":26}],30:[function(require,module,exports){
function updateProps(oldVnode, vnode) {
  var key, cur, old, elm = vnode.elm,
      oldProps = oldVnode.data.props || {}, props = vnode.data.props || {};
  for (key in oldProps) {
    if (!props[key]) {
      delete elm[key];
    }
  }
  for (key in props) {
    cur = props[key];
    old = oldProps[key];
    if (old !== cur && (key !== 'value' || elm[key] !== cur)) {
      elm[key] = cur;
    }
  }
}

module.exports = {create: updateProps, update: updateProps};

},{}],31:[function(require,module,exports){
var raf = (typeof window !== 'undefined' && window.requestAnimationFrame) || setTimeout;
var nextFrame = function(fn) { raf(function() { raf(fn); }); };

function setNextFrame(obj, prop, val) {
  nextFrame(function() { obj[prop] = val; });
}

function updateStyle(oldVnode, vnode) {
  var cur, name, elm = vnode.elm,
      oldStyle = oldVnode.data.style || {},
      style = vnode.data.style || {},
      oldHasDel = 'delayed' in oldStyle;
  for (name in oldStyle) {
    if (!style[name]) {
      elm.style[name] = '';
    }
  }
  for (name in style) {
    cur = style[name];
    if (name === 'delayed') {
      for (name in style.delayed) {
        cur = style.delayed[name];
        if (!oldHasDel || cur !== oldStyle.delayed[name]) {
          setNextFrame(elm.style, name, cur);
        }
      }
    } else if (name !== 'remove' && cur !== oldStyle[name]) {
      elm.style[name] = cur;
    }
  }
}

function applyDestroyStyle(vnode) {
  var style, name, elm = vnode.elm, s = vnode.data.style;
  if (!s || !(style = s.destroy)) return;
  for (name in style) {
    elm.style[name] = style[name];
  }
}

function applyRemoveStyle(vnode, rm) {
  var s = vnode.data.style;
  if (!s || !s.remove) {
    rm();
    return;
  }
  var name, elm = vnode.elm, idx, i = 0, maxDur = 0,
      compStyle, style = s.remove, amount = 0, applied = [];
  for (name in style) {
    applied.push(name);
    elm.style[name] = style[name];
  }
  compStyle = getComputedStyle(elm);
  var props = compStyle['transition-property'].split(', ');
  for (; i < props.length; ++i) {
    if(applied.indexOf(props[i]) !== -1) amount++;
  }
  elm.addEventListener('transitionend', function(ev) {
    if (ev.target === elm) --amount;
    if (amount === 0) rm();
  });
}

module.exports = {create: updateStyle, update: updateStyle, destroy: applyDestroyStyle, remove: applyRemoveStyle};

},{}],32:[function(require,module,exports){
// jshint newcap: false
/* global require, module, document, Node */
'use strict';

var VNode = require('./vnode');
var is = require('./is');
var domApi = require('./htmldomapi');

function isUndef(s) { return s === undefined; }
function isDef(s) { return s !== undefined; }

var emptyNode = VNode('', {}, [], undefined, undefined);

function sameVnode(vnode1, vnode2) {
  return vnode1.key === vnode2.key && vnode1.sel === vnode2.sel;
}

function createKeyToOldIdx(children, beginIdx, endIdx) {
  var i, map = {}, key;
  for (i = beginIdx; i <= endIdx; ++i) {
    key = children[i].key;
    if (isDef(key)) map[key] = i;
  }
  return map;
}

var hooks = ['create', 'update', 'remove', 'destroy', 'pre', 'post'];

function init(modules, api) {
  var i, j, cbs = {};

  if (isUndef(api)) api = domApi;

  for (i = 0; i < hooks.length; ++i) {
    cbs[hooks[i]] = [];
    for (j = 0; j < modules.length; ++j) {
      if (modules[j][hooks[i]] !== undefined) cbs[hooks[i]].push(modules[j][hooks[i]]);
    }
  }

  function emptyNodeAt(elm) {
    return VNode(api.tagName(elm).toLowerCase(), {}, [], undefined, elm);
  }

  function createRmCb(childElm, listeners) {
    return function() {
      if (--listeners === 0) {
        var parent = api.parentNode(childElm);
        api.removeChild(parent, childElm);
      }
    };
  }

  function createElm(vnode, insertedVnodeQueue) {
    var i, data = vnode.data;
    if (isDef(data)) {
      if (isDef(i = data.hook) && isDef(i = i.init)) {
        i(vnode);
        data = vnode.data;
      }
    }
    var elm, children = vnode.children, sel = vnode.sel;
    if (isDef(sel)) {
      // Parse selector
      var hashIdx = sel.indexOf('#');
      var dotIdx = sel.indexOf('.', hashIdx);
      var hash = hashIdx > 0 ? hashIdx : sel.length;
      var dot = dotIdx > 0 ? dotIdx : sel.length;
      var tag = hashIdx !== -1 || dotIdx !== -1 ? sel.slice(0, Math.min(hash, dot)) : sel;
      elm = vnode.elm = isDef(data) && isDef(i = data.ns) ? api.createElementNS(i, tag)
                                                          : api.createElement(tag);
      if (hash < dot) elm.id = sel.slice(hash + 1, dot);
      if (dotIdx > 0) elm.className = sel.slice(dot+1).replace(/\./g, ' ');
      if (is.array(children)) {
        for (i = 0; i < children.length; ++i) {
          api.appendChild(elm, createElm(children[i], insertedVnodeQueue));
        }
      } else if (is.primitive(vnode.text)) {
        api.appendChild(elm, api.createTextNode(vnode.text));
      }
      for (i = 0; i < cbs.create.length; ++i) cbs.create[i](emptyNode, vnode);
      i = vnode.data.hook; // Reuse variable
      if (isDef(i)) {
        if (i.create) i.create(emptyNode, vnode);
        if (i.insert) insertedVnodeQueue.push(vnode);
      }
    } else {
      elm = vnode.elm = api.createTextNode(vnode.text);
    }
    return vnode.elm;
  }

  function addVnodes(parentElm, before, vnodes, startIdx, endIdx, insertedVnodeQueue) {
    for (; startIdx <= endIdx; ++startIdx) {
      api.insertBefore(parentElm, createElm(vnodes[startIdx], insertedVnodeQueue), before);
    }
  }

  function invokeDestroyHook(vnode) {
    var i, j, data = vnode.data;
    if (isDef(data)) {
      if (isDef(i = data.hook) && isDef(i = i.destroy)) i(vnode);
      for (i = 0; i < cbs.destroy.length; ++i) cbs.destroy[i](vnode);
      if (isDef(i = vnode.children)) {
        for (j = 0; j < vnode.children.length; ++j) {
          invokeDestroyHook(vnode.children[j]);
        }
      }
    }
  }

  function removeVnodes(parentElm, vnodes, startIdx, endIdx) {
    for (; startIdx <= endIdx; ++startIdx) {
      var i, listeners, rm, ch = vnodes[startIdx];
      if (isDef(ch)) {
        if (isDef(ch.sel)) {
          invokeDestroyHook(ch);
          listeners = cbs.remove.length + 1;
          rm = createRmCb(ch.elm, listeners);
          for (i = 0; i < cbs.remove.length; ++i) cbs.remove[i](ch, rm);
          if (isDef(i = ch.data) && isDef(i = i.hook) && isDef(i = i.remove)) {
            i(ch, rm);
          } else {
            rm();
          }
        } else { // Text node
          api.removeChild(parentElm, ch.elm);
        }
      }
    }
  }

  function updateChildren(parentElm, oldCh, newCh, insertedVnodeQueue) {
    var oldStartIdx = 0, newStartIdx = 0;
    var oldEndIdx = oldCh.length - 1;
    var oldStartVnode = oldCh[0];
    var oldEndVnode = oldCh[oldEndIdx];
    var newEndIdx = newCh.length - 1;
    var newStartVnode = newCh[0];
    var newEndVnode = newCh[newEndIdx];
    var oldKeyToIdx, idxInOld, elmToMove, before;

    while (oldStartIdx <= oldEndIdx && newStartIdx <= newEndIdx) {
      if (isUndef(oldStartVnode)) {
        oldStartVnode = oldCh[++oldStartIdx]; // Vnode has been moved left
      } else if (isUndef(oldEndVnode)) {
        oldEndVnode = oldCh[--oldEndIdx];
      } else if (sameVnode(oldStartVnode, newStartVnode)) {
        patchVnode(oldStartVnode, newStartVnode, insertedVnodeQueue);
        oldStartVnode = oldCh[++oldStartIdx];
        newStartVnode = newCh[++newStartIdx];
      } else if (sameVnode(oldEndVnode, newEndVnode)) {
        patchVnode(oldEndVnode, newEndVnode, insertedVnodeQueue);
        oldEndVnode = oldCh[--oldEndIdx];
        newEndVnode = newCh[--newEndIdx];
      } else if (sameVnode(oldStartVnode, newEndVnode)) { // Vnode moved right
        patchVnode(oldStartVnode, newEndVnode, insertedVnodeQueue);
        api.insertBefore(parentElm, oldStartVnode.elm, api.nextSibling(oldEndVnode.elm));
        oldStartVnode = oldCh[++oldStartIdx];
        newEndVnode = newCh[--newEndIdx];
      } else if (sameVnode(oldEndVnode, newStartVnode)) { // Vnode moved left
        patchVnode(oldEndVnode, newStartVnode, insertedVnodeQueue);
        api.insertBefore(parentElm, oldEndVnode.elm, oldStartVnode.elm);
        oldEndVnode = oldCh[--oldEndIdx];
        newStartVnode = newCh[++newStartIdx];
      } else {
        if (isUndef(oldKeyToIdx)) oldKeyToIdx = createKeyToOldIdx(oldCh, oldStartIdx, oldEndIdx);
        idxInOld = oldKeyToIdx[newStartVnode.key];
        if (isUndef(idxInOld)) { // New element
          api.insertBefore(parentElm, createElm(newStartVnode, insertedVnodeQueue), oldStartVnode.elm);
          newStartVnode = newCh[++newStartIdx];
        } else {
          elmToMove = oldCh[idxInOld];
          patchVnode(elmToMove, newStartVnode, insertedVnodeQueue);
          oldCh[idxInOld] = undefined;
          api.insertBefore(parentElm, elmToMove.elm, oldStartVnode.elm);
          newStartVnode = newCh[++newStartIdx];
        }
      }
    }
    if (oldStartIdx > oldEndIdx) {
      before = isUndef(newCh[newEndIdx+1]) ? null : newCh[newEndIdx+1].elm;
      addVnodes(parentElm, before, newCh, newStartIdx, newEndIdx, insertedVnodeQueue);
    } else if (newStartIdx > newEndIdx) {
      removeVnodes(parentElm, oldCh, oldStartIdx, oldEndIdx);
    }
  }

  function patchVnode(oldVnode, vnode, insertedVnodeQueue) {
    var i, hook;
    if (isDef(i = vnode.data) && isDef(hook = i.hook) && isDef(i = hook.prepatch)) {
      i(oldVnode, vnode);
    }
    var elm = vnode.elm = oldVnode.elm, oldCh = oldVnode.children, ch = vnode.children;
    if (oldVnode === vnode) return;
    if (!sameVnode(oldVnode, vnode)) {
      var parentElm = api.parentNode(oldVnode.elm);
      elm = createElm(vnode, insertedVnodeQueue);
      api.insertBefore(parentElm, elm, oldVnode.elm);
      removeVnodes(parentElm, [oldVnode], 0, 0);
      return;
    }
    if (isDef(vnode.data)) {
      for (i = 0; i < cbs.update.length; ++i) cbs.update[i](oldVnode, vnode);
      i = vnode.data.hook;
      if (isDef(i) && isDef(i = i.update)) i(oldVnode, vnode);
    }
    if (isUndef(vnode.text)) {
      if (isDef(oldCh) && isDef(ch)) {
        if (oldCh !== ch) updateChildren(elm, oldCh, ch, insertedVnodeQueue);
      } else if (isDef(ch)) {
        if (isDef(oldVnode.text)) api.setTextContent(elm, '');
        addVnodes(elm, null, ch, 0, ch.length - 1, insertedVnodeQueue);
      } else if (isDef(oldCh)) {
        removeVnodes(elm, oldCh, 0, oldCh.length - 1);
      } else if (isDef(oldVnode.text)) {
        api.setTextContent(elm, '');
      }
    } else if (oldVnode.text !== vnode.text) {
      api.setTextContent(elm, vnode.text);
    }
    if (isDef(hook) && isDef(i = hook.postpatch)) {
      i(oldVnode, vnode);
    }
  }

  return function(oldVnode, vnode) {
    var i, elm, parent;
    var insertedVnodeQueue = [];
    for (i = 0; i < cbs.pre.length; ++i) cbs.pre[i]();

    if (isUndef(oldVnode.sel)) {
      oldVnode = emptyNodeAt(oldVnode);
    }

    if (sameVnode(oldVnode, vnode)) {
      patchVnode(oldVnode, vnode, insertedVnodeQueue);
    } else {
      elm = oldVnode.elm;
      parent = api.parentNode(elm);

      createElm(vnode, insertedVnodeQueue);

      if (parent !== null) {
        api.insertBefore(parent, vnode.elm, api.nextSibling(elm));
        removeVnodes(parent, [oldVnode], 0, 0);
      }
    }

    for (i = 0; i < insertedVnodeQueue.length; ++i) {
      insertedVnodeQueue[i].data.hook.insert(insertedVnodeQueue[i]);
    }
    for (i = 0; i < cbs.post.length; ++i) cbs.post[i]();
    return vnode;
  };
}

module.exports = {init: init};

},{"./htmldomapi":25,"./is":26,"./vnode":33}],33:[function(require,module,exports){
module.exports = function(sel, data, children, text, elm) {
  var key = data === undefined ? undefined : data.key;
  return {sel: sel, data: data, children: children,
          text: text, elm: elm, key: key};
};

},{}],34:[function(require,module,exports){
'use strict';

var Promise = require('promise');
var Response = require('http-response-object');
var handleQs = require('./lib/handle-qs.js');

module.exports = doRequest;
function doRequest(method, url, options, callback) {
  var result = new Promise(function (resolve, reject) {
    var xhr = new window.XMLHttpRequest();

    // check types of arguments

    if (typeof method !== 'string') {
      throw new TypeError('The method must be a string.');
    }
    if (typeof url !== 'string') {
      throw new TypeError('The URL/path must be a string.');
    }
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    if (options === null || options === undefined) {
      options = {};
    }
    if (typeof options !== 'object') {
      throw new TypeError('Options must be an object (or null).');
    }
    if (typeof callback !== 'function') {
      callback = undefined;
    }

    method = method.toUpperCase();
    options.headers = options.headers || {};


    function attempt(n) {
      doRequest(method, url, {
        qs: options.qs,
        headers: options.headers,
        timeout: options.timeout
      }).nodeify(function (err, res) {
        var retry = err || res.statusCode >= 400;
        if (typeof options.retry === 'function') {
          retry = options.retry(err, res, n + 1);
        }
        if (n >= (options.maxRetries | 5)) {
          retry = false;
        }
        if (retry) {
          var delay = options.retryDelay;
          if (typeof options.retryDelay === 'function') {
            delay = options.retryDelay(err, res, n + 1);
          }
          delay = delay || 200;
          setTimeout(function () {
            attempt(n + 1);
          }, delay);
        } else {
          if (err) reject(err);
          else resolve(res);
        }
      });
    }
    if (options.retry && method === 'GET') {
      return attempt(0);
    }

    // handle cross domain

    var match;
    var crossDomain = !!((match = /^([\w-]+:)?\/\/([^\/]+)/.exec(url)) && (match[2] != window.location.host));
    if (!crossDomain) options.headers['X-Requested-With'] = 'XMLHttpRequest';

    // handle query string
    if (options.qs) {
      url = handleQs(url, options.qs);
    }

    // handle json body
    if (options.json) {
      options.body = JSON.stringify(options.json);
      options.headers['Content-Type'] = 'application/json';
    }

    if (options.timeout) {
      xhr.timeout = options.timeout;
      var start = Date.now();
      xhr.ontimeout = function () {
        var duration = Date.now() - start;
        var err = new Error('Request timed out after ' + duration + 'ms');
        err.timeout = true;
        err.duration = duration;
        reject(err);
      };
    }
    xhr.onreadystatechange = function () {
      if (xhr.readyState === 4) {
        var headers = {};
        xhr.getAllResponseHeaders().split('\r\n').forEach(function (header) {
          var h = header.split(':');
          if (h.length > 1) {
            headers[h[0].toLowerCase()] = h.slice(1).join(':').trim();
          }
        });
        var res = new Response(xhr.status, headers, xhr.responseText);
        res.url = url;
        resolve(res);
      }
    };

    // method, url, async
    xhr.open(method, url, true);

    for (var name in options.headers) {
      xhr.setRequestHeader(name, options.headers[name]);
    }

    // avoid sending empty string (#319)
    xhr.send(options.body ? options.body : null);
  });
  result.getBody = function () {
    return result.then(function (res) { return res.getBody(); });
  };
  return result.nodeify(callback);
}

},{"./lib/handle-qs.js":35,"http-response-object":4,"promise":6}],35:[function(require,module,exports){
'use strict';

var parse = require('qs').parse;
var stringify = require('qs').stringify;

module.exports = handleQs;
function handleQs(url, query) {
  url = url.split('?');
  var start = url[0];
  var qs = (url[1] || '').split('#')[0];
  var end = url[1] && url[1].split('#').length > 1 ? '#' + url[1].split('#')[1] : '';

  var baseQs = parse(qs);
  for (var i in query) {
    baseQs[i] = query[i];
  }
  qs = stringify(baseQs);
  if (qs !== '') {
    qs = '?' + qs;
  }
  return start + qs + end;
}

},{"qs":14}],36:[function(require,module,exports){
var curryN = require('ramda/src/curryN');

var isString = function(s) { return typeof s === 'string'; };
var isNumber = function(n) { return typeof n === 'number'; };
var isBoolean = function(b) { return typeof b === 'boolean'; };
var isObject = function(value) {
  var type = typeof value;
  return !!value && (type == 'object' || type == 'function');
};
var isFunction = function(f) { return typeof f === 'function'; };
var isArray = Array.isArray || function(a) { return 'length' in a; };

var mapConstrToFn = function(group, constr) {
  return constr === String    ? isString
       : constr === Number    ? isNumber
       : constr === Boolean   ? isBoolean
       : constr === Object    ? isObject
       : constr === Array     ? isArray
       : constr === Function  ? isFunction
       : constr === undefined ? group
                              : constr;
};

var numToStr = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

var validate = function(group, validators, name, args) {
  var validator, v, i;
  for (i = 0; i < args.length; ++i) {
    v = args[i];
    validator = mapConstrToFn(group, validators[i]);
    if (Type.check === true &&
        (validator.prototype === undefined || !validator.prototype.isPrototypeOf(v)) &&
        (typeof validator !== 'function' || !validator(v))) {
      throw new TypeError('wrong value ' + v + ' passed to location ' + numToStr[i] + ' in ' + name);
    }
  }
};

function valueToArray(value) {
  var i, arr = [];
  for (i = 0; i < value._keys.length; ++i) {
    arr.push(value[value._keys[i]]);
  }
  return arr;
}

function extractValues(keys, obj) {
  var arr = [], i;
  for (i = 0; i < keys.length; ++i) arr[i] = obj[keys[i]];
  return arr;
}

function constructor(group, name, fields) {
  var validators, keys = Object.keys(fields), i;
  if (isArray(fields)) {
    validators = fields;
  } else {
    validators = extractValues(keys, fields);
  }
  function construct() {
    var val = Object.create(group.prototype), i;
    val._keys = keys;
    val._name = name;
    if (Type.check === true) {
      validate(group, validators, name, arguments);
    }
    for (i = 0; i < arguments.length; ++i) {
      val[keys[i]] = arguments[i];
    }
    return val;
  }
  group[name] = curryN(keys.length, construct);
  if (keys !== undefined) {
    group[name+'Of'] = function(obj) {
      return construct.apply(undefined, extractValues(keys, obj));
    };
  }
}

function rawCase(type, cases, value, arg) {
  var wildcard = false;
  var handler = cases[value._name];
  if (handler === undefined) {
    handler = cases['_'];
    wildcard = true;
  }
  if (Type.check === true) {
    if (!type.prototype.isPrototypeOf(value)) {
      throw new TypeError('wrong type passed to case');
    } else if (handler === undefined) {
      throw new Error('non-exhaustive patterns in a function');
    }
  }
  var args = wildcard === true ? [arg]
           : arg !== undefined ? valueToArray(value).concat([arg])
           : valueToArray(value);
  return handler.apply(undefined, args);
}

var typeCase = curryN(3, rawCase);
var caseOn = curryN(4, rawCase);

function createIterator() {
  return {
    idx: 0,
    val: this,
    next: function() {
      var keys = this.val._keys;
      return this.idx === keys.length
        ? {done: true}
        : {value: this.val[keys[this.idx++]]};
    }
  };
}

function Type(desc) {
  var key, res, obj = {};
  obj.prototype = {};
  obj.prototype[Symbol ? Symbol.iterator : '@@iterator'] = createIterator;
  obj.case = typeCase(obj);
  obj.caseOn = caseOn(obj);
  for (key in desc) {
    res = constructor(obj, key, desc[key]);
  }
  return obj;
}

Type.check = true;

module.exports = Type;

},{"ramda/src/curryN":18}],37:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.view = view;

function _toConsumableArray(arr) { if (Array.isArray(arr)) { for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) { arr2[i] = arr[i]; } return arr2; } else { return Array.from(arr); } }

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

var h = require('snabbdom/h');
var Type = require('union-type');
var flyd = require('flyd');
var stream = flyd.stream;

var mori = require('mori');
var vector = mori.vector;
var hashMap = mori.hashMap;
var map = mori.map;
var keys = mori.keys;
var vals = mori.vals;
var getIn = mori.getIn;
var assoc = mori.assoc;
var nth = mori.nth;
var toJs = mori.toJs;


var numberPicker = require('./number_picker');

// Model definition and initial state
var model = exports.model = hashMap("R", 0xfe, "G", 0xfe, "B", 0xfe);
// computation which returns immutable initial state;
var init = exports.init = function init() {
  return model;
};

// All available actions
var Action = exports.Action = Type({
  Add: [String, Number],
  Set: [String, numberPicker.Action]
});

var update = exports.update = function update(model, action) {
  var get = function get(k) {
    return getIn(model, k);
  };
  var newModel = Action.case({
    Add: function Add(k, n) {
      return assoc(model, k, Math.abs(get(k) + n) % 0xff);
    },
    Set: function Set(k, act) {
      var n = numberPicker.update(get(k), act);
      return assoc(model, k, n <= 0 ? 0xfe : n);
    }
  }, action);

  return newModel;
};

var rgb = function rgb(r, g, b) {
  return 'rgb(' + Number(r || 0) + ',' + Number(g || 0) + ',' + Number(b || 0) + ')';
};

function view(model, event) {
  // this should be an own component...
  var singleColorPicker = function singleColorPicker(key) {
    var value = getIn(model, key) % 0xff;
    var m = _defineProperty({}, key, value);

    return h('div', {
      style: {
        backgroundColor: rgb(m.R, m.G, m.B)
      },
      on: {
        mousewheel: function mousewheel(e) {
          return event(Action.Add(key, e.deltaY));
        }
      }
    }, [numberPicker.view(value, function (a) {
      return event(Action.Set(key, a));
    })]);
  };

  var colorString = rgb.apply(undefined, _toConsumableArray(toJs(map(function (c) {
    return c % 0xff;
  }, vals(model)))));
  return h('div', [h('div', {
    style: {
      backgroundColor: colorString
    }
  }, 'selected color'), h('div', toJs(map(singleColorPicker, keys(model)))), h('div', [h('pre', JSON.stringify(toJs(model), null, 2))])]);
}

},{"./number_picker":42,"flyd":3,"mori":5,"snabbdom/h":24,"union-type":36}],38:[function(require,module,exports){
'use strict';

var apiPort = 9000;

var apiUrl = 'http://localhost:' + apiPort + '/api';

module.exports = {
  apiPort: apiPort,
  apiUrl: apiUrl
};

},{}],39:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.start = start;
var mori = require('mori');
var flyd = require('flyd');
var stream = flyd.stream;

var snabbdom = require('snabbdom');
var patch = snabbdom.init([require('snabbdom/modules/class'), require('snabbdom/modules/props'), require('snabbdom/modules/style'), require('snabbdom/modules/attributes'), require('snabbdom/modules/eventlisteners')]);

/// Runs an Elm architecture based application
function start(root, model, _ref) {
  var view = _ref.view;
  var update = _ref.update;

  // this is the stream which acts as the run loop, which enables
  // updates to be triggered arbitrarily
  var state$ = stream(model);

  // this is the event handler which allows the view to trigger
  // an update. It expects an object of type Action, defined above
  // using the `union-type` library.
  var handleEvent = function handleEvent(action) {
    var currentState = state$();
    state$(update(currentState, action));
  };

  // the initial vnode, which is created by patching the root node
  // with the result of calling the view function with the initial state and
  // the event handler.
  var vnode = null;

  // maps over the state stream, and patches the vdom
  // with the result of calling the view function with
  // the current state and the event handler.
  var history = mori.vector();
  flyd.map(function (v) {
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

},{"flyd":3,"mori":5,"snabbdom":32,"snabbdom/modules/attributes":27,"snabbdom/modules/class":28,"snabbdom/modules/eventlisteners":29,"snabbdom/modules/props":30,"snabbdom/modules/style":31}],40:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
var request = require('then-request');
var h = require('snabbdom/h');
var Type = require('union-type');
var flyd = require('flyd');
var stream = flyd.stream;

var mori = require('mori');
var vector = mori.vector;
var hashMap = mori.hashMap;
var map = mori.map;
var keys = mori.keys;
var vals = mori.vals;
var equals = mori.equals;
var getIn = mori.getIn;
var get = mori.get;
var assoc = mori.assoc;
var nth = mori.nth;
var toClj = mori.toClj;
var toJs = mori.toJs;

var _require = require('./throbber');

var simple = _require.simple;
var rawSVG = _require.rawSVG;

var _require2 = require('./config');

var apiUrl = _require2.apiUrl;


var parse = function parse(json) {
  return JSON.parse(json);
};

var model = exports.model = hashMap('loading', true, 'data', [], 'page', 1, 'pageSize', 20);

//export const init = () => update(model, Action.Get());
var init = exports.init = function init() {
  return model;
};

var Action = exports.Action = Type({
  Get: [],
  NextPage: [],
  PrevPage: []
});

var update = exports.update = function update(model, action) {
  return Action.case({
    Get: function Get() {
      return request('GET', apiUrl + '/data').getBody().then(function (d) {
        var res = parse(d);
        var words = res.split('\n');
        var newModel = assoc(assoc(model, 'loading', false), 'data', words);
        return newModel;
      });
    },
    NextPage: function NextPage() {
      return assoc(model, 'page', get(model, 'page') + 1);
    },
    PrevPage: function PrevPage() {
      return assoc(model, 'page', get(model, 'page') - 1);
    }
  }, action);
};

var view = exports.view = function view(model, event) {
  if (get(model, 'loading')) {
    event(Action.Get());
  }

  var _toJs = toJs(model || init());

  var loading = _toJs.loading;
  var data = _toJs.data;
  var page = _toJs.page;
  var pageSize = _toJs.pageSize;


  var pg = data.slice((page - 1) * pageSize, page * pageSize);

  return h('div', [loading ? h('div.throbber', {
    style: {
      background: '#ddd',
      display: 'flex',
      height: '100%',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, [h('span', {
    props: {
      innerHTML: rawSVG(100)
    }
  })]) : h('div', { style: { background: '#aaa' } }, [h('button', {
    props: { type: 'button', disabled: page === 1 },
    on: {
      click: function click(e) {
        return event(Action.PrevPage());
      }
    }
  }, 'Prev page'), page, h('button', {
    props: { type: 'button', disabled: page * pageSize >= data.length },
    on: {
      click: function click(e) {
        return event(Action.NextPage());
      }
    }
  }, 'Next page')]), h('div', toJs(map(function (t) {
    return h('div', t);
  }, pg)))]);
};

},{"./config":38,"./throbber":43,"flyd":3,"mori":5,"snabbdom/h":24,"then-request":34,"union-type":36}],41:[function(require,module,exports){
'use strict';

var mori = require('mori');

var _require = require('./core');

var start = _require.start;

var colorsComponent = require('./colors');
var list = require('./list');

function init() {
  // this is the element in which our component is rendered
  var root = document.querySelector('#root');

  // expose the state stream to window, which allows for debugging
  //window.s = start(root, colorsComponent.init(), colorsComponent);
  window.s = start(root, list.init(), list);

  // since the state is a mori data structure, also expose mori
  window.mori = mori;
}

/// BOOTSTRAP
var readyStates = { interactive: 1, complete: 1 };
if (document.readyState in readyStates) {
  init();
} else {
  document.addEventListener('DOMContentLoaded', init);
}

},{"./colors":37,"./core":39,"./list":40,"mori":5}],42:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
var h = require('snabbdom/h');
var Type = require('union-type');
var flyd = require('flyd');
var stream = flyd.stream;

var mori = require('mori');
var vector = mori.vector;
var map = mori.map;
var assoc = mori.assoc;
var nth = mori.nth;
var toJs = mori.toJs;
var model = exports.model = 0;
var init = exports.init = function init() {
  return model;
};
var initWith = exports.initWith = function initWith(n) {
  return n;
};

var Action = exports.Action = Type({
  Set: [Number]
});

var update = exports.update = function update(model, action) {
  return Action.case({
    Set: function Set(n) {
      return n;
    }
  }, action);
};

var view = exports.view = function view(model, event) {
  return h('div', [h('input', {
    props: {
      type: 'number',
      value: model
    },
    on: {
      input: function input(e) {
        var v = parseFloat(e.target.value);
        if (!isNaN(v)) {
          event(Action.Set(v));
        }
      }
    }
  })]);
};

},{"flyd":3,"mori":5,"snabbdom/h":24,"union-type":36}],43:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var h = require('snabbdom/h');

var defaultSize = 32;
var rawSVG = exports.rawSVG = function rawSVG(size) {
  return '\n    <svg width="' + (size || defaultSize) + '" height="' + (size || defaultSize) + '" viewBox="0 0 300 300"\n         xmlns="http://www.w3.org/2000/svg" version="1.1">\n      <path d="M 150,0\n               a 150,150 0 0,1 106.066,256.066\n               l -35.355,-35.355\n               a -100,-100 0 0,0 -70.711,-170.711 z"\n            fill="#14C964">\n      </path>\n    </svg>\n';
};

var simple = exports.simple = h('svg', {
  width: 16, height: 16,
  viewBox: '0 0 300 300'
}, [h('path', {
  attrs: {
    d: 'M 150,0\n      a 150,150 0 0,1 106.066,256.066\n      l -35.355,-35.355\n      a -100,-100 0 0,0 -70.711,-170.711 z',
    fill: '#14C964'
  }
}, [h('animateTransform', {
  attrs: {
    attributeName: 'transform',
    attributeType: 'XML',
    type: 'rotate',
    from: '0 150 150',
    to: '360 150 150',
    begin: '0s',
    dur: '1s',
    fill: 'freeze',
    repeatCount: 'indefinite'
  }
})])]);

},{"snabbdom/h":24}]},{},[41])
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL25vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCIuLi9ub2RlX21vZHVsZXMvYXNhcC9icm93c2VyLWFzYXAuanMiLCIuLi9ub2RlX21vZHVsZXMvYXNhcC9icm93c2VyLXJhdy5qcyIsIi4uL25vZGVfbW9kdWxlcy9mbHlkL2xpYi9pbmRleC5qcyIsIi4uL25vZGVfbW9kdWxlcy9odHRwLXJlc3BvbnNlLW9iamVjdC9pbmRleC5qcyIsIi4uL25vZGVfbW9kdWxlcy9tb3JpL21vcmkuanMiLCIuLi9ub2RlX21vZHVsZXMvcHJvbWlzZS9pbmRleC5qcyIsIi4uL25vZGVfbW9kdWxlcy9wcm9taXNlL2xpYi9jb3JlLmpzIiwiLi4vbm9kZV9tb2R1bGVzL3Byb21pc2UvbGliL2RvbmUuanMiLCIuLi9ub2RlX21vZHVsZXMvcHJvbWlzZS9saWIvZXM2LWV4dGVuc2lvbnMuanMiLCIuLi9ub2RlX21vZHVsZXMvcHJvbWlzZS9saWIvZmluYWxseS5qcyIsIi4uL25vZGVfbW9kdWxlcy9wcm9taXNlL2xpYi9pbmRleC5qcyIsIi4uL25vZGVfbW9kdWxlcy9wcm9taXNlL2xpYi9ub2RlLWV4dGVuc2lvbnMuanMiLCIuLi9ub2RlX21vZHVsZXMvcHJvbWlzZS9saWIvc3luY2hyb25vdXMuanMiLCIuLi9ub2RlX21vZHVsZXMvcXMvbGliL2luZGV4LmpzIiwiLi4vbm9kZV9tb2R1bGVzL3FzL2xpYi9wYXJzZS5qcyIsIi4uL25vZGVfbW9kdWxlcy9xcy9saWIvc3RyaW5naWZ5LmpzIiwiLi4vbm9kZV9tb2R1bGVzL3FzL2xpYi91dGlscy5qcyIsIi4uL25vZGVfbW9kdWxlcy9yYW1kYS9zcmMvY3VycnlOLmpzIiwiLi4vbm9kZV9tb2R1bGVzL3JhbWRhL3NyYy9pbnRlcm5hbC9fYXJpdHkuanMiLCIuLi9ub2RlX21vZHVsZXMvcmFtZGEvc3JjL2ludGVybmFsL19jdXJyeTEuanMiLCIuLi9ub2RlX21vZHVsZXMvcmFtZGEvc3JjL2ludGVybmFsL19jdXJyeTIuanMiLCIuLi9ub2RlX21vZHVsZXMvcmFtZGEvc3JjL2ludGVybmFsL19jdXJyeU4uanMiLCIuLi9ub2RlX21vZHVsZXMvcmFtZGEvc3JjL2ludGVybmFsL19pc1BsYWNlaG9sZGVyLmpzIiwiLi4vbm9kZV9tb2R1bGVzL3NuYWJiZG9tL2guanMiLCIuLi9ub2RlX21vZHVsZXMvc25hYmJkb20vaHRtbGRvbWFwaS5qcyIsIi4uL25vZGVfbW9kdWxlcy9zbmFiYmRvbS9pcy5qcyIsIi4uL25vZGVfbW9kdWxlcy9zbmFiYmRvbS9tb2R1bGVzL2F0dHJpYnV0ZXMuanMiLCIuLi9ub2RlX21vZHVsZXMvc25hYmJkb20vbW9kdWxlcy9jbGFzcy5qcyIsIi4uL25vZGVfbW9kdWxlcy9zbmFiYmRvbS9tb2R1bGVzL2V2ZW50bGlzdGVuZXJzLmpzIiwiLi4vbm9kZV9tb2R1bGVzL3NuYWJiZG9tL21vZHVsZXMvcHJvcHMuanMiLCIuLi9ub2RlX21vZHVsZXMvc25hYmJkb20vbW9kdWxlcy9zdHlsZS5qcyIsIi4uL25vZGVfbW9kdWxlcy9zbmFiYmRvbS9zbmFiYmRvbS5qcyIsIi4uL25vZGVfbW9kdWxlcy9zbmFiYmRvbS92bm9kZS5qcyIsIi4uL25vZGVfbW9kdWxlcy90aGVuLXJlcXVlc3QvYnJvd3Nlci5qcyIsIi4uL25vZGVfbW9kdWxlcy90aGVuLXJlcXVlc3QvbGliL2hhbmRsZS1xcy5qcyIsIi4uL25vZGVfbW9kdWxlcy91bmlvbi10eXBlL3VuaW9uLXR5cGUuanMiLCIuLi9zcmMvY29sb3JzLmpzIiwiLi4vc3JjL2NvbmZpZy5qcyIsIi4uL3NyYy9jb3JlLmpzIiwiLi4vc3JjL2xpc3QuanMiLCIuLi9zcmMvbWFpbi5qcyIsIi4uL3NyYy9udW1iZXJfcGlja2VyLmpzIiwiLi4vc3JjL3Rocm9iYmVyLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO0FDQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQ2xFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDNU5BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNsbkJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM0NBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM2FBO0FBQ0E7QUFDQTtBQUNBOztBQ0hBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3JOQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2JBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMzR0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNoQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1JBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbElBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM5REE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDVEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3BLQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbklBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2xLQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0REE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2pCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDNUJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDeENBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNMQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNqQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdERBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDSkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdkNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2xCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzFEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNsQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNoRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbFFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNMQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQy9IQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3RCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7Ozs7O1FDL0VnQixJLEdBQUEsSTs7Ozs7O0FBbkRoQixJQUFNLElBQUksUUFBUSxZQUFSLENBQVY7QUFDQSxJQUFNLE9BQU8sUUFBUSxZQUFSLENBQWI7QUFDQSxJQUFNLE9BQU8sUUFBUSxNQUFSLENBQWI7SUFDUSxNLEdBQVcsSSxDQUFYLE07O0FBQ1IsSUFBTSxPQUFPLFFBQVEsTUFBUixDQUFiO0lBRUUsTSxHQVNFLEksQ0FURixNO0lBQ0EsTyxHQVFFLEksQ0FSRixPO0lBQ0EsRyxHQU9FLEksQ0FQRixHO0lBQ0EsSSxHQU1FLEksQ0FORixJO0lBQ0EsSSxHQUtFLEksQ0FMRixJO0lBQ0EsSyxHQUlFLEksQ0FKRixLO0lBQ0EsSyxHQUdFLEksQ0FIRixLO0lBQ0EsRyxHQUVFLEksQ0FGRixHO0lBQ0EsSSxHQUNFLEksQ0FERixJOzs7QUFHRixJQUFNLGVBQWUsUUFBUSxpQkFBUixDQUFyQjs7O0FBR08sSUFBTSx3QkFBUSxRQUNuQixHQURtQixFQUNkLElBRGMsRUFFbkIsR0FGbUIsRUFFZCxJQUZjLEVBR25CLEdBSG1CLEVBR2QsSUFIYyxDQUFkOztBQU1BLElBQU0sc0JBQU8sU0FBUCxJQUFPO0FBQUEsU0FBTSxLQUFOO0FBQUEsQ0FBYjs7O0FBR0EsSUFBTSwwQkFBUyxLQUFLO0FBQ3pCLE9BQUssQ0FBQyxNQUFELEVBQVMsTUFBVCxDQURvQjtBQUV6QixPQUFLLENBQUMsTUFBRCxFQUFTLGFBQWEsTUFBdEI7QUFGb0IsQ0FBTCxDQUFmOztBQUtBLElBQU0sMEJBQVMsU0FBVCxNQUFTLENBQVUsS0FBVixFQUFpQixNQUFqQixFQUF5QjtBQUM3QyxNQUFNLE1BQU0sU0FBTixHQUFNO0FBQUEsV0FBSyxNQUFNLEtBQU4sRUFBYSxDQUFiLENBQUw7QUFBQSxHQUFaO0FBQ0EsTUFBTSxXQUFXLE9BQU8sSUFBUCxDQUFZO0FBQzNCLFNBQUssYUFBQyxDQUFELEVBQUksQ0FBSjtBQUFBLGFBQ0gsTUFBTSxLQUFOLEVBQWEsQ0FBYixFQUFnQixLQUFLLEdBQUwsQ0FBUyxJQUFJLENBQUosSUFBUyxDQUFsQixJQUF1QixJQUF2QyxDQURHO0FBQUEsS0FEc0I7QUFHM0IsU0FBSyxhQUFDLENBQUQsRUFBSSxHQUFKLEVBQVk7QUFDZixVQUFNLElBQUksYUFBYSxNQUFiLENBQW9CLElBQUksQ0FBSixDQUFwQixFQUE0QixHQUE1QixDQUFWO0FBQ0EsYUFBTyxNQUFNLEtBQU4sRUFBYSxDQUFiLEVBQWdCLEtBQUssQ0FBTCxHQUFTLElBQVQsR0FBZ0IsQ0FBaEMsQ0FBUDtBQUNEO0FBTjBCLEdBQVosRUFPZCxNQVBjLENBQWpCOztBQVNBLFNBQU8sUUFBUDtBQUNELENBWk07O0FBY1AsSUFBTSxNQUFNLFNBQU4sR0FBTSxDQUFDLENBQUQsRUFBSSxDQUFKLEVBQU8sQ0FBUDtBQUFBLGtCQUNHLE9BQU8sS0FBRyxDQUFWLENBREgsU0FDbUIsT0FBTyxLQUFHLENBQVYsQ0FEbkIsU0FDbUMsT0FBTyxLQUFHLENBQVYsQ0FEbkM7QUFBQSxDQUFaOztBQUdPLFNBQVMsSUFBVCxDQUFjLEtBQWQsRUFBcUIsS0FBckIsRUFBNEI7O0FBRWpDLE1BQU0sb0JBQW9CLFNBQXBCLGlCQUFvQixNQUFPO0FBQy9CLFFBQU0sUUFBUSxNQUFNLEtBQU4sRUFBYSxHQUFiLElBQW9CLElBQWxDO0FBQ0EsUUFBTSx3QkFDSCxHQURHLEVBQ0csS0FESCxDQUFOOztBQUlBLFdBQU8sRUFBRSxLQUFGLEVBQVM7QUFDZCxhQUFPO0FBQ0wseUJBQWlCLElBQUksRUFBRSxDQUFOLEVBQVMsRUFBRSxDQUFYLEVBQWMsRUFBRSxDQUFoQjtBQURaLE9BRE87QUFJZCxVQUFJO0FBQ0Ysb0JBQVk7QUFBQSxpQkFBSyxNQUFNLE9BQU8sR0FBUCxDQUFXLEdBQVgsRUFBZ0IsRUFBRSxNQUFsQixDQUFOLENBQUw7QUFBQTtBQURWO0FBSlUsS0FBVCxFQU9KLENBQ0QsYUFBYSxJQUFiLENBQ0UsS0FERixFQUVFO0FBQUEsYUFBSyxNQUFNLE9BQU8sR0FBUCxDQUFXLEdBQVgsRUFBZ0IsQ0FBaEIsQ0FBTixDQUFMO0FBQUEsS0FGRixDQURDLENBUEksQ0FBUDtBQVlELEdBbEJEOztBQW9CQSxNQUFNLGNBQWMsd0NBQU8sS0FBSyxJQUFJO0FBQUEsV0FBSyxJQUFJLElBQVQ7QUFBQSxHQUFKLEVBQW1CLEtBQUssS0FBTCxDQUFuQixDQUFMLENBQVAsRUFBcEI7QUFDQSxTQUFPLEVBQUUsS0FBRixFQUFTLENBQ2QsRUFBRSxLQUFGLEVBQVM7QUFDUCxXQUFPO0FBQ0wsdUJBQWlCO0FBRFo7QUFEQSxHQUFULEVBSUcsZ0JBSkgsQ0FEYyxFQU1kLEVBQUUsS0FBRixFQUFTLEtBQUssSUFBSSxpQkFBSixFQUF1QixLQUFLLEtBQUwsQ0FBdkIsQ0FBTCxDQUFULENBTmMsRUFPZCxFQUFFLEtBQUYsRUFBUyxDQUNQLEVBQUUsS0FBRixFQUFTLEtBQUssU0FBTCxDQUFlLEtBQUssS0FBTCxDQUFmLEVBQTRCLElBQTVCLEVBQWtDLENBQWxDLENBQVQsQ0FETyxDQUFULENBUGMsQ0FBVCxDQUFQO0FBV0Q7OztBQ3JGRDs7QUFFQSxJQUFNLFVBQVUsSUFBaEI7O0FBRUEsSUFBTSwrQkFBNkIsT0FBN0IsU0FBTjs7QUFFQSxPQUFPLE9BQVAsR0FBaUI7QUFDZixrQkFEZTtBQUVmO0FBRmUsQ0FBakI7Ozs7Ozs7O1FDT2dCLEssR0FBQSxLO0FBYmhCLElBQU0sT0FBTyxRQUFRLE1BQVIsQ0FBYjtBQUNBLElBQU0sT0FBTyxRQUFRLE1BQVIsQ0FBYjtJQUNRLE0sR0FBVyxJLENBQVgsTTs7QUFDUixJQUFNLFdBQVcsUUFBUSxVQUFSLENBQWpCO0FBQ0EsSUFBTSxRQUFRLFNBQVMsSUFBVCxDQUFjLENBQzFCLFFBQVEsd0JBQVIsQ0FEMEIsRUFFMUIsUUFBUSx3QkFBUixDQUYwQixFQUcxQixRQUFRLHdCQUFSLENBSDBCLEVBSTFCLFFBQVEsNkJBQVIsQ0FKMEIsRUFLMUIsUUFBUSxpQ0FBUixDQUwwQixDQUFkLENBQWQ7OztBQVNPLFNBQVMsS0FBVCxDQUFlLElBQWYsRUFBcUIsS0FBckIsUUFBNEM7QUFBQSxNQUFmLElBQWUsUUFBZixJQUFlO0FBQUEsTUFBVCxNQUFTLFFBQVQsTUFBUzs7OztBQUdqRCxNQUFNLFNBQVMsT0FBTyxLQUFQLENBQWY7Ozs7O0FBS0EsTUFBTSxjQUFjLFNBQWQsV0FBYyxDQUFVLE1BQVYsRUFBa0I7QUFDcEMsUUFBTSxlQUFlLFFBQXJCO0FBQ0EsV0FBTyxPQUFPLFlBQVAsRUFBcUIsTUFBckIsQ0FBUDtBQUNELEdBSEQ7Ozs7O0FBUUEsTUFBSSxRQUFRLElBQVo7Ozs7O0FBS0EsTUFBSSxVQUFVLEtBQUssTUFBTCxFQUFkO0FBQ0EsT0FBSyxHQUFMLENBQVMsYUFBSztBQUNaLGNBQVUsS0FBSyxJQUFMLENBQVUsT0FBVixFQUFtQixDQUFuQixDQUFWO0FBQ0EsUUFBSSxVQUFVLElBQWQsRUFBb0I7QUFDbEIsY0FBUSxNQUFNLElBQU4sRUFBWSxLQUFLLENBQUwsRUFBUSxXQUFSLENBQVosQ0FBUjtBQUNELEtBRkQsTUFFTztBQUNMLGNBQVEsTUFBTSxLQUFOLEVBQWEsS0FBSyxDQUFMLEVBQVEsV0FBUixDQUFiLENBQVI7QUFDRDs7QUFFRCxXQUFPLEtBQVA7QUFDRCxHQVRELEVBU0csTUFUSDs7QUFXQSxTQUFPLE1BQVA7QUFDRDs7Ozs7Ozs7QUMvQ0QsSUFBTSxVQUFVLFFBQVEsY0FBUixDQUFoQjtBQUNBLElBQU0sSUFBSSxRQUFRLFlBQVIsQ0FBVjtBQUNBLElBQU0sT0FBTyxRQUFRLFlBQVIsQ0FBYjtBQUNBLElBQU0sT0FBTyxRQUFRLE1BQVIsQ0FBYjtJQUNRLE0sR0FBVyxJLENBQVgsTTs7QUFDUixJQUFNLE9BQU8sUUFBUSxNQUFSLENBQWI7SUFFRSxNLEdBWUUsSSxDQVpGLE07SUFDQSxPLEdBV0UsSSxDQVhGLE87SUFDQSxHLEdBVUUsSSxDQVZGLEc7SUFDQSxJLEdBU0UsSSxDQVRGLEk7SUFDQSxJLEdBUUUsSSxDQVJGLEk7SUFDQSxNLEdBT0UsSSxDQVBGLE07SUFDQSxLLEdBTUUsSSxDQU5GLEs7SUFDQSxHLEdBS0UsSSxDQUxGLEc7SUFDQSxLLEdBSUUsSSxDQUpGLEs7SUFDQSxHLEdBR0UsSSxDQUhGLEc7SUFDQSxLLEdBRUUsSSxDQUZGLEs7SUFDQSxJLEdBQ0UsSSxDQURGLEk7O2VBR3VCLFFBQVEsWUFBUixDOztJQUFsQixNLFlBQUEsTTtJQUFRLE0sWUFBQSxNOztnQkFFSSxRQUFRLFVBQVIsQzs7SUFBWCxNLGFBQUEsTTs7O0FBRVIsSUFBTSxRQUFRLFNBQVIsS0FBUTtBQUFBLFNBQVEsS0FBSyxLQUFMLENBQVcsSUFBWCxDQUFSO0FBQUEsQ0FBZDs7QUFFTyxJQUFNLHdCQUFRLFFBQ25CLFNBRG1CLEVBQ1IsSUFEUSxFQUVuQixNQUZtQixFQUVYLEVBRlcsRUFHbkIsTUFIbUIsRUFHWCxDQUhXLEVBSW5CLFVBSm1CLEVBSVAsRUFKTyxDQUFkOzs7QUFRQSxJQUFNLHNCQUFPLFNBQVAsSUFBTztBQUFBLFNBQU0sS0FBTjtBQUFBLENBQWI7O0FBRUEsSUFBTSwwQkFBUyxLQUFLO0FBQ3pCLE9BQUssRUFEb0I7QUFFekIsWUFBVSxFQUZlO0FBR3pCLFlBQVU7QUFIZSxDQUFMLENBQWY7O0FBTUEsSUFBTSwwQkFBUyxTQUFULE1BQVMsQ0FBQyxLQUFELEVBQVEsTUFBUixFQUFtQjtBQUN2QyxTQUFPLE9BQU8sSUFBUCxDQUFZO0FBQ2pCLFNBQUs7QUFBQSxhQUFNLFFBQVEsS0FBUixFQUFrQixNQUFsQixZQUFpQyxPQUFqQyxHQUNSLElBRFEsQ0FDSCxhQUFLO0FBQ1QsWUFBTSxNQUFNLE1BQU0sQ0FBTixDQUFaO0FBQ0EsWUFBTSxRQUFRLElBQUksS0FBSixDQUFVLElBQVYsQ0FBZDtBQUNBLFlBQUksV0FBVyxNQUFNLE1BQU0sS0FBTixFQUFhLFNBQWIsRUFBd0IsS0FBeEIsQ0FBTixFQUFzQyxNQUF0QyxFQUE4QyxLQUE5QyxDQUFmO0FBQ0EsZUFBTyxRQUFQO0FBQ0QsT0FOUSxDQUFOO0FBQUEsS0FEWTtBQVFqQixjQUFVO0FBQUEsYUFBTSxNQUFNLEtBQU4sRUFBYSxNQUFiLEVBQXFCLElBQUksS0FBSixFQUFXLE1BQVgsSUFBcUIsQ0FBMUMsQ0FBTjtBQUFBLEtBUk87QUFTakIsY0FBVTtBQUFBLGFBQU0sTUFBTSxLQUFOLEVBQWEsTUFBYixFQUFxQixJQUFJLEtBQUosRUFBVyxNQUFYLElBQXFCLENBQTFDLENBQU47QUFBQTtBQVRPLEdBQVosRUFVSixNQVZJLENBQVA7QUFXRCxDQVpNOztBQWNBLElBQU0sc0JBQU8sU0FBUCxJQUFPLENBQUMsS0FBRCxFQUFRLEtBQVIsRUFBa0I7QUFDcEMsTUFBSSxJQUFJLEtBQUosRUFBVyxTQUFYLENBQUosRUFBMkI7QUFDekIsVUFBTSxPQUFPLEdBQVAsRUFBTjtBQUNEOztBQUhtQyxjQVNoQyxLQUFLLFNBQVMsTUFBZCxDQVRnQzs7QUFBQSxNQUtsQyxPQUxrQyxTQUtsQyxPQUxrQztBQUFBLE1BTWxDLElBTmtDLFNBTWxDLElBTmtDO0FBQUEsTUFPbEMsSUFQa0MsU0FPbEMsSUFQa0M7QUFBQSxNQVFsQyxRQVJrQyxTQVFsQyxRQVJrQzs7O0FBV3BDLE1BQU0sS0FBSyxLQUFLLEtBQUwsQ0FBVyxDQUFDLE9BQU8sQ0FBUixJQUFhLFFBQXhCLEVBQWtDLE9BQU8sUUFBekMsQ0FBWDs7QUFFQSxTQUFPLEVBQUUsS0FBRixFQUFTLENBQ2QsVUFDRSxFQUFFLGNBQUYsRUFBa0I7QUFDaEIsV0FBTztBQUNMLGtCQUFZLE1BRFA7QUFFTCxlQUFTLE1BRko7QUFHTCxjQUFRLE1BSEg7QUFJTCxrQkFBWSxRQUpQO0FBS0wsc0JBQWdCO0FBTFg7QUFEUyxHQUFsQixFQVFHLENBQ0QsRUFBRSxNQUFGLEVBQVU7QUFDUixXQUFPO0FBQ0wsaUJBQVcsT0FBTyxHQUFQO0FBRE47QUFEQyxHQUFWLENBREMsQ0FSSCxDQURGLEdBZ0JFLEVBQUUsS0FBRixFQUFTLEVBQUMsT0FBTyxFQUFDLFlBQVksTUFBYixFQUFSLEVBQVQsRUFBd0MsQ0FDeEMsRUFBRSxRQUFGLEVBQVk7QUFDVixXQUFPLEVBQUUsTUFBTSxRQUFSLEVBQWtCLFVBQVUsU0FBUyxDQUFyQyxFQURHO0FBRVYsUUFBSTtBQUNGLGFBQU87QUFBQSxlQUFLLE1BQU0sT0FBTyxRQUFQLEVBQU4sQ0FBTDtBQUFBO0FBREw7QUFGTSxHQUFaLEVBS0csV0FMSCxDQUR3QyxFQU94QyxJQVB3QyxFQVF4QyxFQUFFLFFBQUYsRUFBWTtBQUNWLFdBQU8sRUFBRSxNQUFNLFFBQVIsRUFBa0IsVUFBVSxPQUFPLFFBQVAsSUFBbUIsS0FBSyxNQUFwRCxFQURHO0FBRVYsUUFBSTtBQUNGLGFBQU87QUFBQSxlQUFLLE1BQU0sT0FBTyxRQUFQLEVBQU4sQ0FBTDtBQUFBO0FBREw7QUFGTSxHQUFaLEVBS0csV0FMSCxDQVJ3QyxDQUF4QyxDQWpCWSxFQWdDZCxFQUFFLEtBQUYsRUFBUyxLQUFLLElBQUk7QUFBQSxXQUFLLEVBQUUsS0FBRixFQUFTLENBQVQsQ0FBTDtBQUFBLEdBQUosRUFBc0IsRUFBdEIsQ0FBTCxDQUFULENBaENjLENBQVQsQ0FBUDtBQWtDRCxDQS9DTTs7O0FDekRQOztBQUVBLElBQU0sT0FBTyxRQUFRLE1BQVIsQ0FBYjs7ZUFDa0IsUUFBUSxRQUFSLEM7O0lBQVYsSyxZQUFBLEs7O0FBQ1IsSUFBTSxrQkFBa0IsUUFBUSxVQUFSLENBQXhCO0FBQ0EsSUFBTSxPQUFPLFFBQVEsUUFBUixDQUFiOztBQUVBLFNBQVMsSUFBVCxHQUFnQjs7QUFFZCxNQUFNLE9BQU8sU0FBUyxhQUFULENBQXVCLE9BQXZCLENBQWI7Ozs7QUFJQSxTQUFPLENBQVAsR0FBVyxNQUFNLElBQU4sRUFBWSxLQUFLLElBQUwsRUFBWixFQUF5QixJQUF6QixDQUFYOzs7QUFHQSxTQUFPLElBQVAsR0FBYyxJQUFkO0FBQ0Q7OztBQUdELElBQU0sY0FBYyxFQUFDLGFBQVksQ0FBYixFQUFnQixVQUFTLENBQXpCLEVBQXBCO0FBQ0EsSUFBSSxTQUFTLFVBQVQsSUFBdUIsV0FBM0IsRUFBd0M7QUFDdEM7QUFDRCxDQUZELE1BRU87QUFDTCxXQUFTLGdCQUFULENBQTBCLGtCQUExQixFQUE4QyxJQUE5QztBQUNEOzs7Ozs7OztBQ3pCRCxJQUFNLElBQUksUUFBUSxZQUFSLENBQVY7QUFDQSxJQUFNLE9BQU8sUUFBUSxZQUFSLENBQWI7QUFDQSxJQUFNLE9BQU8sUUFBUSxNQUFSLENBQWI7SUFDUSxNLEdBQVcsSSxDQUFYLE07O0FBQ1IsSUFBTSxPQUFPLFFBQVEsTUFBUixDQUFiO0lBRUUsTSxHQUtFLEksQ0FMRixNO0lBQ0EsRyxHQUlFLEksQ0FKRixHO0lBQ0EsSyxHQUdFLEksQ0FIRixLO0lBQ0EsRyxHQUVFLEksQ0FGRixHO0lBQ0EsSSxHQUNFLEksQ0FERixJO0FBR0ssSUFBTSx3QkFBUSxDQUFkO0FBQ0EsSUFBTSxzQkFBTyxTQUFQLElBQU87QUFBQSxTQUFNLEtBQU47QUFBQSxDQUFiO0FBQ0EsSUFBTSw4QkFBVyxTQUFYLFFBQVc7QUFBQSxTQUFLLENBQUw7QUFBQSxDQUFqQjs7QUFFQSxJQUFNLDBCQUFTLEtBQUs7QUFDekIsT0FBSyxDQUFDLE1BQUQ7QUFEb0IsQ0FBTCxDQUFmOztBQUlBLElBQU0sMEJBQVMsU0FBVCxNQUFTLENBQUMsS0FBRCxFQUFRLE1BQVIsRUFBbUI7QUFDdkMsU0FBTyxPQUFPLElBQVAsQ0FBWTtBQUNqQixTQUFLO0FBQUEsYUFBSyxDQUFMO0FBQUE7QUFEWSxHQUFaLEVBRUosTUFGSSxDQUFQO0FBR0QsQ0FKTTs7QUFNQSxJQUFNLHNCQUFPLFNBQVAsSUFBTyxDQUFDLEtBQUQsRUFBUSxLQUFSLEVBQWtCO0FBQ3BDLFNBQU8sRUFBRSxLQUFGLEVBQVMsQ0FDZCxFQUFFLE9BQUYsRUFBVztBQUNULFdBQU87QUFDTCxZQUFNLFFBREQ7QUFFTCxhQUFPO0FBRkYsS0FERTtBQUtULFFBQUk7QUFDRixhQUFPLGtCQUFLO0FBQ1YsWUFBTSxJQUFJLFdBQVcsRUFBRSxNQUFGLENBQVMsS0FBcEIsQ0FBVjtBQUNBLFlBQUksQ0FBQyxNQUFNLENBQU4sQ0FBTCxFQUFlO0FBQ2IsZ0JBQU0sT0FBTyxHQUFQLENBQVcsQ0FBWCxDQUFOO0FBQ0Q7QUFDRjtBQU5DO0FBTEssR0FBWCxDQURjLENBQVQsQ0FBUDtBQWdCRCxDQWpCTTs7Ozs7Ozs7O0FDMUJQLElBQU0sSUFBSSxRQUFRLFlBQVIsQ0FBVjs7QUFFQSxJQUFNLGNBQWMsRUFBcEI7QUFDTyxJQUFNLDBCQUFTLFNBQVQsTUFBUyxDQUFDLElBQUQ7QUFBQSxpQ0FDSixRQUFRLFdBREosb0JBQzRCLFFBQVEsV0FEcEM7QUFBQSxDQUFmOztBQVlBLElBQU0sMEJBQVMsRUFBRSxLQUFGLEVBQVM7QUFDN0IsU0FBTyxFQURzQixFQUNsQixRQUFRLEVBRFU7QUFFN0IsV0FBUztBQUZvQixDQUFULEVBR25CLENBQ0QsRUFBRSxNQUFGLEVBQVU7QUFDUixTQUFPO0FBQ0wsNEhBREs7QUFLTCxVQUFNO0FBTEQ7QUFEQyxDQUFWLEVBUUcsQ0FDRCxFQUFFLGtCQUFGLEVBQXNCO0FBQ3BCLFNBQU87QUFDTCxtQkFBYyxXQURUO0FBRUwsbUJBQWMsS0FGVDtBQUdMLFVBQUssUUFIQTtBQUlMLFVBQUssV0FKQTtBQUtMLFFBQUcsYUFMRTtBQU1MLFdBQU0sSUFORDtBQU9MLFNBQUksSUFQQztBQVFMLFVBQUssUUFSQTtBQVNMLGlCQUFZO0FBVFA7QUFEYSxDQUF0QixDQURDLENBUkgsQ0FEQyxDQUhtQixDQUFmIiwiZmlsZSI6ImdlbmVyYXRlZC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24gZSh0LG4scil7ZnVuY3Rpb24gcyhvLHUpe2lmKCFuW29dKXtpZighdFtvXSl7dmFyIGE9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtpZighdSYmYSlyZXR1cm4gYShvLCEwKTtpZihpKXJldHVybiBpKG8sITApO3ZhciBmPW5ldyBFcnJvcihcIkNhbm5vdCBmaW5kIG1vZHVsZSAnXCIrbytcIidcIik7dGhyb3cgZi5jb2RlPVwiTU9EVUxFX05PVF9GT1VORFwiLGZ9dmFyIGw9bltvXT17ZXhwb3J0czp7fX07dFtvXVswXS5jYWxsKGwuZXhwb3J0cyxmdW5jdGlvbihlKXt2YXIgbj10W29dWzFdW2VdO3JldHVybiBzKG4/bjplKX0sbCxsLmV4cG9ydHMsZSx0LG4scil9cmV0dXJuIG5bb10uZXhwb3J0c312YXIgaT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2Zvcih2YXIgbz0wO288ci5sZW5ndGg7bysrKXMocltvXSk7cmV0dXJuIHN9KSIsIlwidXNlIHN0cmljdFwiO1xuXG4vLyByYXdBc2FwIHByb3ZpZGVzIGV2ZXJ5dGhpbmcgd2UgbmVlZCBleGNlcHQgZXhjZXB0aW9uIG1hbmFnZW1lbnQuXG52YXIgcmF3QXNhcCA9IHJlcXVpcmUoXCIuL3Jhd1wiKTtcbi8vIFJhd1Rhc2tzIGFyZSByZWN5Y2xlZCB0byByZWR1Y2UgR0MgY2h1cm4uXG52YXIgZnJlZVRhc2tzID0gW107XG4vLyBXZSBxdWV1ZSBlcnJvcnMgdG8gZW5zdXJlIHRoZXkgYXJlIHRocm93biBpbiByaWdodCBvcmRlciAoRklGTykuXG4vLyBBcnJheS1hcy1xdWV1ZSBpcyBnb29kIGVub3VnaCBoZXJlLCBzaW5jZSB3ZSBhcmUganVzdCBkZWFsaW5nIHdpdGggZXhjZXB0aW9ucy5cbnZhciBwZW5kaW5nRXJyb3JzID0gW107XG52YXIgcmVxdWVzdEVycm9yVGhyb3cgPSByYXdBc2FwLm1ha2VSZXF1ZXN0Q2FsbEZyb21UaW1lcih0aHJvd0ZpcnN0RXJyb3IpO1xuXG5mdW5jdGlvbiB0aHJvd0ZpcnN0RXJyb3IoKSB7XG4gICAgaWYgKHBlbmRpbmdFcnJvcnMubGVuZ3RoKSB7XG4gICAgICAgIHRocm93IHBlbmRpbmdFcnJvcnMuc2hpZnQoKTtcbiAgICB9XG59XG5cbi8qKlxuICogQ2FsbHMgYSB0YXNrIGFzIHNvb24gYXMgcG9zc2libGUgYWZ0ZXIgcmV0dXJuaW5nLCBpbiBpdHMgb3duIGV2ZW50LCB3aXRoIHByaW9yaXR5XG4gKiBvdmVyIG90aGVyIGV2ZW50cyBsaWtlIGFuaW1hdGlvbiwgcmVmbG93LCBhbmQgcmVwYWludC4gQW4gZXJyb3IgdGhyb3duIGZyb20gYW5cbiAqIGV2ZW50IHdpbGwgbm90IGludGVycnVwdCwgbm9yIGV2ZW4gc3Vic3RhbnRpYWxseSBzbG93IGRvd24gdGhlIHByb2Nlc3Npbmcgb2ZcbiAqIG90aGVyIGV2ZW50cywgYnV0IHdpbGwgYmUgcmF0aGVyIHBvc3Rwb25lZCB0byBhIGxvd2VyIHByaW9yaXR5IGV2ZW50LlxuICogQHBhcmFtIHt7Y2FsbH19IHRhc2sgQSBjYWxsYWJsZSBvYmplY3QsIHR5cGljYWxseSBhIGZ1bmN0aW9uIHRoYXQgdGFrZXMgbm9cbiAqIGFyZ3VtZW50cy5cbiAqL1xubW9kdWxlLmV4cG9ydHMgPSBhc2FwO1xuZnVuY3Rpb24gYXNhcCh0YXNrKSB7XG4gICAgdmFyIHJhd1Rhc2s7XG4gICAgaWYgKGZyZWVUYXNrcy5sZW5ndGgpIHtcbiAgICAgICAgcmF3VGFzayA9IGZyZWVUYXNrcy5wb3AoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICByYXdUYXNrID0gbmV3IFJhd1Rhc2soKTtcbiAgICB9XG4gICAgcmF3VGFzay50YXNrID0gdGFzaztcbiAgICByYXdBc2FwKHJhd1Rhc2spO1xufVxuXG4vLyBXZSB3cmFwIHRhc2tzIHdpdGggcmVjeWNsYWJsZSB0YXNrIG9iamVjdHMuICBBIHRhc2sgb2JqZWN0IGltcGxlbWVudHNcbi8vIGBjYWxsYCwganVzdCBsaWtlIGEgZnVuY3Rpb24uXG5mdW5jdGlvbiBSYXdUYXNrKCkge1xuICAgIHRoaXMudGFzayA9IG51bGw7XG59XG5cbi8vIFRoZSBzb2xlIHB1cnBvc2Ugb2Ygd3JhcHBpbmcgdGhlIHRhc2sgaXMgdG8gY2F0Y2ggdGhlIGV4Y2VwdGlvbiBhbmQgcmVjeWNsZVxuLy8gdGhlIHRhc2sgb2JqZWN0IGFmdGVyIGl0cyBzaW5nbGUgdXNlLlxuUmF3VGFzay5wcm90b3R5cGUuY2FsbCA9IGZ1bmN0aW9uICgpIHtcbiAgICB0cnkge1xuICAgICAgICB0aGlzLnRhc2suY2FsbCgpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGlmIChhc2FwLm9uZXJyb3IpIHtcbiAgICAgICAgICAgIC8vIFRoaXMgaG9vayBleGlzdHMgcHVyZWx5IGZvciB0ZXN0aW5nIHB1cnBvc2VzLlxuICAgICAgICAgICAgLy8gSXRzIG5hbWUgd2lsbCBiZSBwZXJpb2RpY2FsbHkgcmFuZG9taXplZCB0byBicmVhayBhbnkgY29kZSB0aGF0XG4gICAgICAgICAgICAvLyBkZXBlbmRzIG9uIGl0cyBleGlzdGVuY2UuXG4gICAgICAgICAgICBhc2FwLm9uZXJyb3IoZXJyb3IpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gSW4gYSB3ZWIgYnJvd3NlciwgZXhjZXB0aW9ucyBhcmUgbm90IGZhdGFsLiBIb3dldmVyLCB0byBhdm9pZFxuICAgICAgICAgICAgLy8gc2xvd2luZyBkb3duIHRoZSBxdWV1ZSBvZiBwZW5kaW5nIHRhc2tzLCB3ZSByZXRocm93IHRoZSBlcnJvciBpbiBhXG4gICAgICAgICAgICAvLyBsb3dlciBwcmlvcml0eSB0dXJuLlxuICAgICAgICAgICAgcGVuZGluZ0Vycm9ycy5wdXNoKGVycm9yKTtcbiAgICAgICAgICAgIHJlcXVlc3RFcnJvclRocm93KCk7XG4gICAgICAgIH1cbiAgICB9IGZpbmFsbHkge1xuICAgICAgICB0aGlzLnRhc2sgPSBudWxsO1xuICAgICAgICBmcmVlVGFza3NbZnJlZVRhc2tzLmxlbmd0aF0gPSB0aGlzO1xuICAgIH1cbn07XG4iLCJcInVzZSBzdHJpY3RcIjtcblxuLy8gVXNlIHRoZSBmYXN0ZXN0IG1lYW5zIHBvc3NpYmxlIHRvIGV4ZWN1dGUgYSB0YXNrIGluIGl0cyBvd24gdHVybiwgd2l0aFxuLy8gcHJpb3JpdHkgb3ZlciBvdGhlciBldmVudHMgaW5jbHVkaW5nIElPLCBhbmltYXRpb24sIHJlZmxvdywgYW5kIHJlZHJhd1xuLy8gZXZlbnRzIGluIGJyb3dzZXJzLlxuLy9cbi8vIEFuIGV4Y2VwdGlvbiB0aHJvd24gYnkgYSB0YXNrIHdpbGwgcGVybWFuZW50bHkgaW50ZXJydXB0IHRoZSBwcm9jZXNzaW5nIG9mXG4vLyBzdWJzZXF1ZW50IHRhc2tzLiBUaGUgaGlnaGVyIGxldmVsIGBhc2FwYCBmdW5jdGlvbiBlbnN1cmVzIHRoYXQgaWYgYW5cbi8vIGV4Y2VwdGlvbiBpcyB0aHJvd24gYnkgYSB0YXNrLCB0aGF0IHRoZSB0YXNrIHF1ZXVlIHdpbGwgY29udGludWUgZmx1c2hpbmcgYXNcbi8vIHNvb24gYXMgcG9zc2libGUsIGJ1dCBpZiB5b3UgdXNlIGByYXdBc2FwYCBkaXJlY3RseSwgeW91IGFyZSByZXNwb25zaWJsZSB0b1xuLy8gZWl0aGVyIGVuc3VyZSB0aGF0IG5vIGV4Y2VwdGlvbnMgYXJlIHRocm93biBmcm9tIHlvdXIgdGFzaywgb3IgdG8gbWFudWFsbHlcbi8vIGNhbGwgYHJhd0FzYXAucmVxdWVzdEZsdXNoYCBpZiBhbiBleGNlcHRpb24gaXMgdGhyb3duLlxubW9kdWxlLmV4cG9ydHMgPSByYXdBc2FwO1xuZnVuY3Rpb24gcmF3QXNhcCh0YXNrKSB7XG4gICAgaWYgKCFxdWV1ZS5sZW5ndGgpIHtcbiAgICAgICAgcmVxdWVzdEZsdXNoKCk7XG4gICAgICAgIGZsdXNoaW5nID0gdHJ1ZTtcbiAgICB9XG4gICAgLy8gRXF1aXZhbGVudCB0byBwdXNoLCBidXQgYXZvaWRzIGEgZnVuY3Rpb24gY2FsbC5cbiAgICBxdWV1ZVtxdWV1ZS5sZW5ndGhdID0gdGFzaztcbn1cblxudmFyIHF1ZXVlID0gW107XG4vLyBPbmNlIGEgZmx1c2ggaGFzIGJlZW4gcmVxdWVzdGVkLCBubyBmdXJ0aGVyIGNhbGxzIHRvIGByZXF1ZXN0Rmx1c2hgIGFyZVxuLy8gbmVjZXNzYXJ5IHVudGlsIHRoZSBuZXh0IGBmbHVzaGAgY29tcGxldGVzLlxudmFyIGZsdXNoaW5nID0gZmFsc2U7XG4vLyBgcmVxdWVzdEZsdXNoYCBpcyBhbiBpbXBsZW1lbnRhdGlvbi1zcGVjaWZpYyBtZXRob2QgdGhhdCBhdHRlbXB0cyB0byBraWNrXG4vLyBvZmYgYSBgZmx1c2hgIGV2ZW50IGFzIHF1aWNrbHkgYXMgcG9zc2libGUuIGBmbHVzaGAgd2lsbCBhdHRlbXB0IHRvIGV4aGF1c3Rcbi8vIHRoZSBldmVudCBxdWV1ZSBiZWZvcmUgeWllbGRpbmcgdG8gdGhlIGJyb3dzZXIncyBvd24gZXZlbnQgbG9vcC5cbnZhciByZXF1ZXN0Rmx1c2g7XG4vLyBUaGUgcG9zaXRpb24gb2YgdGhlIG5leHQgdGFzayB0byBleGVjdXRlIGluIHRoZSB0YXNrIHF1ZXVlLiBUaGlzIGlzXG4vLyBwcmVzZXJ2ZWQgYmV0d2VlbiBjYWxscyB0byBgZmx1c2hgIHNvIHRoYXQgaXQgY2FuIGJlIHJlc3VtZWQgaWZcbi8vIGEgdGFzayB0aHJvd3MgYW4gZXhjZXB0aW9uLlxudmFyIGluZGV4ID0gMDtcbi8vIElmIGEgdGFzayBzY2hlZHVsZXMgYWRkaXRpb25hbCB0YXNrcyByZWN1cnNpdmVseSwgdGhlIHRhc2sgcXVldWUgY2FuIGdyb3dcbi8vIHVuYm91bmRlZC4gVG8gcHJldmVudCBtZW1vcnkgZXhoYXVzdGlvbiwgdGhlIHRhc2sgcXVldWUgd2lsbCBwZXJpb2RpY2FsbHlcbi8vIHRydW5jYXRlIGFscmVhZHktY29tcGxldGVkIHRhc2tzLlxudmFyIGNhcGFjaXR5ID0gMTAyNDtcblxuLy8gVGhlIGZsdXNoIGZ1bmN0aW9uIHByb2Nlc3NlcyBhbGwgdGFza3MgdGhhdCBoYXZlIGJlZW4gc2NoZWR1bGVkIHdpdGhcbi8vIGByYXdBc2FwYCB1bmxlc3MgYW5kIHVudGlsIG9uZSBvZiB0aG9zZSB0YXNrcyB0aHJvd3MgYW4gZXhjZXB0aW9uLlxuLy8gSWYgYSB0YXNrIHRocm93cyBhbiBleGNlcHRpb24sIGBmbHVzaGAgZW5zdXJlcyB0aGF0IGl0cyBzdGF0ZSB3aWxsIHJlbWFpblxuLy8gY29uc2lzdGVudCBhbmQgd2lsbCByZXN1bWUgd2hlcmUgaXQgbGVmdCBvZmYgd2hlbiBjYWxsZWQgYWdhaW4uXG4vLyBIb3dldmVyLCBgZmx1c2hgIGRvZXMgbm90IG1ha2UgYW55IGFycmFuZ2VtZW50cyB0byBiZSBjYWxsZWQgYWdhaW4gaWYgYW5cbi8vIGV4Y2VwdGlvbiBpcyB0aHJvd24uXG5mdW5jdGlvbiBmbHVzaCgpIHtcbiAgICB3aGlsZSAoaW5kZXggPCBxdWV1ZS5sZW5ndGgpIHtcbiAgICAgICAgdmFyIGN1cnJlbnRJbmRleCA9IGluZGV4O1xuICAgICAgICAvLyBBZHZhbmNlIHRoZSBpbmRleCBiZWZvcmUgY2FsbGluZyB0aGUgdGFzay4gVGhpcyBlbnN1cmVzIHRoYXQgd2Ugd2lsbFxuICAgICAgICAvLyBiZWdpbiBmbHVzaGluZyBvbiB0aGUgbmV4dCB0YXNrIHRoZSB0YXNrIHRocm93cyBhbiBlcnJvci5cbiAgICAgICAgaW5kZXggPSBpbmRleCArIDE7XG4gICAgICAgIHF1ZXVlW2N1cnJlbnRJbmRleF0uY2FsbCgpO1xuICAgICAgICAvLyBQcmV2ZW50IGxlYWtpbmcgbWVtb3J5IGZvciBsb25nIGNoYWlucyBvZiByZWN1cnNpdmUgY2FsbHMgdG8gYGFzYXBgLlxuICAgICAgICAvLyBJZiB3ZSBjYWxsIGBhc2FwYCB3aXRoaW4gdGFza3Mgc2NoZWR1bGVkIGJ5IGBhc2FwYCwgdGhlIHF1ZXVlIHdpbGxcbiAgICAgICAgLy8gZ3JvdywgYnV0IHRvIGF2b2lkIGFuIE8obikgd2FsayBmb3IgZXZlcnkgdGFzayB3ZSBleGVjdXRlLCB3ZSBkb24ndFxuICAgICAgICAvLyBzaGlmdCB0YXNrcyBvZmYgdGhlIHF1ZXVlIGFmdGVyIHRoZXkgaGF2ZSBiZWVuIGV4ZWN1dGVkLlxuICAgICAgICAvLyBJbnN0ZWFkLCB3ZSBwZXJpb2RpY2FsbHkgc2hpZnQgMTAyNCB0YXNrcyBvZmYgdGhlIHF1ZXVlLlxuICAgICAgICBpZiAoaW5kZXggPiBjYXBhY2l0eSkge1xuICAgICAgICAgICAgLy8gTWFudWFsbHkgc2hpZnQgYWxsIHZhbHVlcyBzdGFydGluZyBhdCB0aGUgaW5kZXggYmFjayB0byB0aGVcbiAgICAgICAgICAgIC8vIGJlZ2lubmluZyBvZiB0aGUgcXVldWUuXG4gICAgICAgICAgICBmb3IgKHZhciBzY2FuID0gMCwgbmV3TGVuZ3RoID0gcXVldWUubGVuZ3RoIC0gaW5kZXg7IHNjYW4gPCBuZXdMZW5ndGg7IHNjYW4rKykge1xuICAgICAgICAgICAgICAgIHF1ZXVlW3NjYW5dID0gcXVldWVbc2NhbiArIGluZGV4XTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHF1ZXVlLmxlbmd0aCAtPSBpbmRleDtcbiAgICAgICAgICAgIGluZGV4ID0gMDtcbiAgICAgICAgfVxuICAgIH1cbiAgICBxdWV1ZS5sZW5ndGggPSAwO1xuICAgIGluZGV4ID0gMDtcbiAgICBmbHVzaGluZyA9IGZhbHNlO1xufVxuXG4vLyBgcmVxdWVzdEZsdXNoYCBpcyBpbXBsZW1lbnRlZCB1c2luZyBhIHN0cmF0ZWd5IGJhc2VkIG9uIGRhdGEgY29sbGVjdGVkIGZyb21cbi8vIGV2ZXJ5IGF2YWlsYWJsZSBTYXVjZUxhYnMgU2VsZW5pdW0gd2ViIGRyaXZlciB3b3JrZXIgYXQgdGltZSBvZiB3cml0aW5nLlxuLy8gaHR0cHM6Ly9kb2NzLmdvb2dsZS5jb20vc3ByZWFkc2hlZXRzL2QvMW1HLTVVWUd1cDVxeEdkRU1Xa2hQNkJXQ3owNTNOVWIyRTFRb1VUVTE2dUEvZWRpdCNnaWQ9NzgzNzI0NTkzXG5cbi8vIFNhZmFyaSA2IGFuZCA2LjEgZm9yIGRlc2t0b3AsIGlQYWQsIGFuZCBpUGhvbmUgYXJlIHRoZSBvbmx5IGJyb3dzZXJzIHRoYXRcbi8vIGhhdmUgV2ViS2l0TXV0YXRpb25PYnNlcnZlciBidXQgbm90IHVuLXByZWZpeGVkIE11dGF0aW9uT2JzZXJ2ZXIuXG4vLyBNdXN0IHVzZSBgZ2xvYmFsYCBpbnN0ZWFkIG9mIGB3aW5kb3dgIHRvIHdvcmsgaW4gYm90aCBmcmFtZXMgYW5kIHdlYlxuLy8gd29ya2Vycy4gYGdsb2JhbGAgaXMgYSBwcm92aXNpb24gb2YgQnJvd3NlcmlmeSwgTXIsIE1ycywgb3IgTW9wLlxudmFyIEJyb3dzZXJNdXRhdGlvbk9ic2VydmVyID0gZ2xvYmFsLk11dGF0aW9uT2JzZXJ2ZXIgfHwgZ2xvYmFsLldlYktpdE11dGF0aW9uT2JzZXJ2ZXI7XG5cbi8vIE11dGF0aW9uT2JzZXJ2ZXJzIGFyZSBkZXNpcmFibGUgYmVjYXVzZSB0aGV5IGhhdmUgaGlnaCBwcmlvcml0eSBhbmQgd29ya1xuLy8gcmVsaWFibHkgZXZlcnl3aGVyZSB0aGV5IGFyZSBpbXBsZW1lbnRlZC5cbi8vIFRoZXkgYXJlIGltcGxlbWVudGVkIGluIGFsbCBtb2Rlcm4gYnJvd3NlcnMuXG4vL1xuLy8gLSBBbmRyb2lkIDQtNC4zXG4vLyAtIENocm9tZSAyNi0zNFxuLy8gLSBGaXJlZm94IDE0LTI5XG4vLyAtIEludGVybmV0IEV4cGxvcmVyIDExXG4vLyAtIGlQYWQgU2FmYXJpIDYtNy4xXG4vLyAtIGlQaG9uZSBTYWZhcmkgNy03LjFcbi8vIC0gU2FmYXJpIDYtN1xuaWYgKHR5cGVvZiBCcm93c2VyTXV0YXRpb25PYnNlcnZlciA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgcmVxdWVzdEZsdXNoID0gbWFrZVJlcXVlc3RDYWxsRnJvbU11dGF0aW9uT2JzZXJ2ZXIoZmx1c2gpO1xuXG4vLyBNZXNzYWdlQ2hhbm5lbHMgYXJlIGRlc2lyYWJsZSBiZWNhdXNlIHRoZXkgZ2l2ZSBkaXJlY3QgYWNjZXNzIHRvIHRoZSBIVE1MXG4vLyB0YXNrIHF1ZXVlLCBhcmUgaW1wbGVtZW50ZWQgaW4gSW50ZXJuZXQgRXhwbG9yZXIgMTAsIFNhZmFyaSA1LjAtMSwgYW5kIE9wZXJhXG4vLyAxMS0xMiwgYW5kIGluIHdlYiB3b3JrZXJzIGluIG1hbnkgZW5naW5lcy5cbi8vIEFsdGhvdWdoIG1lc3NhZ2UgY2hhbm5lbHMgeWllbGQgdG8gYW55IHF1ZXVlZCByZW5kZXJpbmcgYW5kIElPIHRhc2tzLCB0aGV5XG4vLyB3b3VsZCBiZSBiZXR0ZXIgdGhhbiBpbXBvc2luZyB0aGUgNG1zIGRlbGF5IG9mIHRpbWVycy5cbi8vIEhvd2V2ZXIsIHRoZXkgZG8gbm90IHdvcmsgcmVsaWFibHkgaW4gSW50ZXJuZXQgRXhwbG9yZXIgb3IgU2FmYXJpLlxuXG4vLyBJbnRlcm5ldCBFeHBsb3JlciAxMCBpcyB0aGUgb25seSBicm93c2VyIHRoYXQgaGFzIHNldEltbWVkaWF0ZSBidXQgZG9lc1xuLy8gbm90IGhhdmUgTXV0YXRpb25PYnNlcnZlcnMuXG4vLyBBbHRob3VnaCBzZXRJbW1lZGlhdGUgeWllbGRzIHRvIHRoZSBicm93c2VyJ3MgcmVuZGVyZXIsIGl0IHdvdWxkIGJlXG4vLyBwcmVmZXJyYWJsZSB0byBmYWxsaW5nIGJhY2sgdG8gc2V0VGltZW91dCBzaW5jZSBpdCBkb2VzIG5vdCBoYXZlXG4vLyB0aGUgbWluaW11bSA0bXMgcGVuYWx0eS5cbi8vIFVuZm9ydHVuYXRlbHkgdGhlcmUgYXBwZWFycyB0byBiZSBhIGJ1ZyBpbiBJbnRlcm5ldCBFeHBsb3JlciAxMCBNb2JpbGUgKGFuZFxuLy8gRGVza3RvcCB0byBhIGxlc3NlciBleHRlbnQpIHRoYXQgcmVuZGVycyBib3RoIHNldEltbWVkaWF0ZSBhbmRcbi8vIE1lc3NhZ2VDaGFubmVsIHVzZWxlc3MgZm9yIHRoZSBwdXJwb3NlcyBvZiBBU0FQLlxuLy8gaHR0cHM6Ly9naXRodWIuY29tL2tyaXNrb3dhbC9xL2lzc3Vlcy8zOTZcblxuLy8gVGltZXJzIGFyZSBpbXBsZW1lbnRlZCB1bml2ZXJzYWxseS5cbi8vIFdlIGZhbGwgYmFjayB0byB0aW1lcnMgaW4gd29ya2VycyBpbiBtb3N0IGVuZ2luZXMsIGFuZCBpbiBmb3JlZ3JvdW5kXG4vLyBjb250ZXh0cyBpbiB0aGUgZm9sbG93aW5nIGJyb3dzZXJzLlxuLy8gSG93ZXZlciwgbm90ZSB0aGF0IGV2ZW4gdGhpcyBzaW1wbGUgY2FzZSByZXF1aXJlcyBudWFuY2VzIHRvIG9wZXJhdGUgaW4gYVxuLy8gYnJvYWQgc3BlY3RydW0gb2YgYnJvd3NlcnMuXG4vL1xuLy8gLSBGaXJlZm94IDMtMTNcbi8vIC0gSW50ZXJuZXQgRXhwbG9yZXIgNi05XG4vLyAtIGlQYWQgU2FmYXJpIDQuM1xuLy8gLSBMeW54IDIuOC43XG59IGVsc2Uge1xuICAgIHJlcXVlc3RGbHVzaCA9IG1ha2VSZXF1ZXN0Q2FsbEZyb21UaW1lcihmbHVzaCk7XG59XG5cbi8vIGByZXF1ZXN0Rmx1c2hgIHJlcXVlc3RzIHRoYXQgdGhlIGhpZ2ggcHJpb3JpdHkgZXZlbnQgcXVldWUgYmUgZmx1c2hlZCBhc1xuLy8gc29vbiBhcyBwb3NzaWJsZS5cbi8vIFRoaXMgaXMgdXNlZnVsIHRvIHByZXZlbnQgYW4gZXJyb3IgdGhyb3duIGluIGEgdGFzayBmcm9tIHN0YWxsaW5nIHRoZSBldmVudFxuLy8gcXVldWUgaWYgdGhlIGV4Y2VwdGlvbiBoYW5kbGVkIGJ5IE5vZGUuanPigJlzXG4vLyBgcHJvY2Vzcy5vbihcInVuY2F1Z2h0RXhjZXB0aW9uXCIpYCBvciBieSBhIGRvbWFpbi5cbnJhd0FzYXAucmVxdWVzdEZsdXNoID0gcmVxdWVzdEZsdXNoO1xuXG4vLyBUbyByZXF1ZXN0IGEgaGlnaCBwcmlvcml0eSBldmVudCwgd2UgaW5kdWNlIGEgbXV0YXRpb24gb2JzZXJ2ZXIgYnkgdG9nZ2xpbmdcbi8vIHRoZSB0ZXh0IG9mIGEgdGV4dCBub2RlIGJldHdlZW4gXCIxXCIgYW5kIFwiLTFcIi5cbmZ1bmN0aW9uIG1ha2VSZXF1ZXN0Q2FsbEZyb21NdXRhdGlvbk9ic2VydmVyKGNhbGxiYWNrKSB7XG4gICAgdmFyIHRvZ2dsZSA9IDE7XG4gICAgdmFyIG9ic2VydmVyID0gbmV3IEJyb3dzZXJNdXRhdGlvbk9ic2VydmVyKGNhbGxiYWNrKTtcbiAgICB2YXIgbm9kZSA9IGRvY3VtZW50LmNyZWF0ZVRleHROb2RlKFwiXCIpO1xuICAgIG9ic2VydmVyLm9ic2VydmUobm9kZSwge2NoYXJhY3RlckRhdGE6IHRydWV9KTtcbiAgICByZXR1cm4gZnVuY3Rpb24gcmVxdWVzdENhbGwoKSB7XG4gICAgICAgIHRvZ2dsZSA9IC10b2dnbGU7XG4gICAgICAgIG5vZGUuZGF0YSA9IHRvZ2dsZTtcbiAgICB9O1xufVxuXG4vLyBUaGUgbWVzc2FnZSBjaGFubmVsIHRlY2huaXF1ZSB3YXMgZGlzY292ZXJlZCBieSBNYWx0ZSBVYmwgYW5kIHdhcyB0aGVcbi8vIG9yaWdpbmFsIGZvdW5kYXRpb24gZm9yIHRoaXMgbGlicmFyeS5cbi8vIGh0dHA6Ly93d3cubm9uYmxvY2tpbmcuaW8vMjAxMS8wNi93aW5kb3duZXh0dGljay5odG1sXG5cbi8vIFNhZmFyaSA2LjAuNSAoYXQgbGVhc3QpIGludGVybWl0dGVudGx5IGZhaWxzIHRvIGNyZWF0ZSBtZXNzYWdlIHBvcnRzIG9uIGFcbi8vIHBhZ2UncyBmaXJzdCBsb2FkLiBUaGFua2Z1bGx5LCB0aGlzIHZlcnNpb24gb2YgU2FmYXJpIHN1cHBvcnRzXG4vLyBNdXRhdGlvbk9ic2VydmVycywgc28gd2UgZG9uJ3QgbmVlZCB0byBmYWxsIGJhY2sgaW4gdGhhdCBjYXNlLlxuXG4vLyBmdW5jdGlvbiBtYWtlUmVxdWVzdENhbGxGcm9tTWVzc2FnZUNoYW5uZWwoY2FsbGJhY2spIHtcbi8vICAgICB2YXIgY2hhbm5lbCA9IG5ldyBNZXNzYWdlQ2hhbm5lbCgpO1xuLy8gICAgIGNoYW5uZWwucG9ydDEub25tZXNzYWdlID0gY2FsbGJhY2s7XG4vLyAgICAgcmV0dXJuIGZ1bmN0aW9uIHJlcXVlc3RDYWxsKCkge1xuLy8gICAgICAgICBjaGFubmVsLnBvcnQyLnBvc3RNZXNzYWdlKDApO1xuLy8gICAgIH07XG4vLyB9XG5cbi8vIEZvciByZWFzb25zIGV4cGxhaW5lZCBhYm92ZSwgd2UgYXJlIGFsc28gdW5hYmxlIHRvIHVzZSBgc2V0SW1tZWRpYXRlYFxuLy8gdW5kZXIgYW55IGNpcmN1bXN0YW5jZXMuXG4vLyBFdmVuIGlmIHdlIHdlcmUsIHRoZXJlIGlzIGFub3RoZXIgYnVnIGluIEludGVybmV0IEV4cGxvcmVyIDEwLlxuLy8gSXQgaXMgbm90IHN1ZmZpY2llbnQgdG8gYXNzaWduIGBzZXRJbW1lZGlhdGVgIHRvIGByZXF1ZXN0Rmx1c2hgIGJlY2F1c2Vcbi8vIGBzZXRJbW1lZGlhdGVgIG11c3QgYmUgY2FsbGVkICpieSBuYW1lKiBhbmQgdGhlcmVmb3JlIG11c3QgYmUgd3JhcHBlZCBpbiBhXG4vLyBjbG9zdXJlLlxuLy8gTmV2ZXIgZm9yZ2V0LlxuXG4vLyBmdW5jdGlvbiBtYWtlUmVxdWVzdENhbGxGcm9tU2V0SW1tZWRpYXRlKGNhbGxiYWNrKSB7XG4vLyAgICAgcmV0dXJuIGZ1bmN0aW9uIHJlcXVlc3RDYWxsKCkge1xuLy8gICAgICAgICBzZXRJbW1lZGlhdGUoY2FsbGJhY2spO1xuLy8gICAgIH07XG4vLyB9XG5cbi8vIFNhZmFyaSA2LjAgaGFzIGEgcHJvYmxlbSB3aGVyZSB0aW1lcnMgd2lsbCBnZXQgbG9zdCB3aGlsZSB0aGUgdXNlciBpc1xuLy8gc2Nyb2xsaW5nLiBUaGlzIHByb2JsZW0gZG9lcyBub3QgaW1wYWN0IEFTQVAgYmVjYXVzZSBTYWZhcmkgNi4wIHN1cHBvcnRzXG4vLyBtdXRhdGlvbiBvYnNlcnZlcnMsIHNvIHRoYXQgaW1wbGVtZW50YXRpb24gaXMgdXNlZCBpbnN0ZWFkLlxuLy8gSG93ZXZlciwgaWYgd2UgZXZlciBlbGVjdCB0byB1c2UgdGltZXJzIGluIFNhZmFyaSwgdGhlIHByZXZhbGVudCB3b3JrLWFyb3VuZFxuLy8gaXMgdG8gYWRkIGEgc2Nyb2xsIGV2ZW50IGxpc3RlbmVyIHRoYXQgY2FsbHMgZm9yIGEgZmx1c2guXG5cbi8vIGBzZXRUaW1lb3V0YCBkb2VzIG5vdCBjYWxsIHRoZSBwYXNzZWQgY2FsbGJhY2sgaWYgdGhlIGRlbGF5IGlzIGxlc3MgdGhhblxuLy8gYXBwcm94aW1hdGVseSA3IGluIHdlYiB3b3JrZXJzIGluIEZpcmVmb3ggOCB0aHJvdWdoIDE4LCBhbmQgc29tZXRpbWVzIG5vdFxuLy8gZXZlbiB0aGVuLlxuXG5mdW5jdGlvbiBtYWtlUmVxdWVzdENhbGxGcm9tVGltZXIoY2FsbGJhY2spIHtcbiAgICByZXR1cm4gZnVuY3Rpb24gcmVxdWVzdENhbGwoKSB7XG4gICAgICAgIC8vIFdlIGRpc3BhdGNoIGEgdGltZW91dCB3aXRoIGEgc3BlY2lmaWVkIGRlbGF5IG9mIDAgZm9yIGVuZ2luZXMgdGhhdFxuICAgICAgICAvLyBjYW4gcmVsaWFibHkgYWNjb21tb2RhdGUgdGhhdCByZXF1ZXN0LiBUaGlzIHdpbGwgdXN1YWxseSBiZSBzbmFwcGVkXG4gICAgICAgIC8vIHRvIGEgNCBtaWxpc2Vjb25kIGRlbGF5LCBidXQgb25jZSB3ZSdyZSBmbHVzaGluZywgdGhlcmUncyBubyBkZWxheVxuICAgICAgICAvLyBiZXR3ZWVuIGV2ZW50cy5cbiAgICAgICAgdmFyIHRpbWVvdXRIYW5kbGUgPSBzZXRUaW1lb3V0KGhhbmRsZVRpbWVyLCAwKTtcbiAgICAgICAgLy8gSG93ZXZlciwgc2luY2UgdGhpcyB0aW1lciBnZXRzIGZyZXF1ZW50bHkgZHJvcHBlZCBpbiBGaXJlZm94XG4gICAgICAgIC8vIHdvcmtlcnMsIHdlIGVubGlzdCBhbiBpbnRlcnZhbCBoYW5kbGUgdGhhdCB3aWxsIHRyeSB0byBmaXJlXG4gICAgICAgIC8vIGFuIGV2ZW50IDIwIHRpbWVzIHBlciBzZWNvbmQgdW50aWwgaXQgc3VjY2VlZHMuXG4gICAgICAgIHZhciBpbnRlcnZhbEhhbmRsZSA9IHNldEludGVydmFsKGhhbmRsZVRpbWVyLCA1MCk7XG5cbiAgICAgICAgZnVuY3Rpb24gaGFuZGxlVGltZXIoKSB7XG4gICAgICAgICAgICAvLyBXaGljaGV2ZXIgdGltZXIgc3VjY2VlZHMgd2lsbCBjYW5jZWwgYm90aCB0aW1lcnMgYW5kXG4gICAgICAgICAgICAvLyBleGVjdXRlIHRoZSBjYWxsYmFjay5cbiAgICAgICAgICAgIGNsZWFyVGltZW91dCh0aW1lb3V0SGFuZGxlKTtcbiAgICAgICAgICAgIGNsZWFySW50ZXJ2YWwoaW50ZXJ2YWxIYW5kbGUpO1xuICAgICAgICAgICAgY2FsbGJhY2soKTtcbiAgICAgICAgfVxuICAgIH07XG59XG5cbi8vIFRoaXMgaXMgZm9yIGBhc2FwLmpzYCBvbmx5LlxuLy8gSXRzIG5hbWUgd2lsbCBiZSBwZXJpb2RpY2FsbHkgcmFuZG9taXplZCB0byBicmVhayBhbnkgY29kZSB0aGF0IGRlcGVuZHMgb25cbi8vIGl0cyBleGlzdGVuY2UuXG5yYXdBc2FwLm1ha2VSZXF1ZXN0Q2FsbEZyb21UaW1lciA9IG1ha2VSZXF1ZXN0Q2FsbEZyb21UaW1lcjtcblxuLy8gQVNBUCB3YXMgb3JpZ2luYWxseSBhIG5leHRUaWNrIHNoaW0gaW5jbHVkZWQgaW4gUS4gVGhpcyB3YXMgZmFjdG9yZWQgb3V0XG4vLyBpbnRvIHRoaXMgQVNBUCBwYWNrYWdlLiBJdCB3YXMgbGF0ZXIgYWRhcHRlZCB0byBSU1ZQIHdoaWNoIG1hZGUgZnVydGhlclxuLy8gYW1lbmRtZW50cy4gVGhlc2UgZGVjaXNpb25zLCBwYXJ0aWN1bGFybHkgdG8gbWFyZ2luYWxpemUgTWVzc2FnZUNoYW5uZWwgYW5kXG4vLyB0byBjYXB0dXJlIHRoZSBNdXRhdGlvbk9ic2VydmVyIGltcGxlbWVudGF0aW9uIGluIGEgY2xvc3VyZSwgd2VyZSBpbnRlZ3JhdGVkXG4vLyBiYWNrIGludG8gQVNBUCBwcm9wZXIuXG4vLyBodHRwczovL2dpdGh1Yi5jb20vdGlsZGVpby9yc3ZwLmpzL2Jsb2IvY2RkZjcyMzI1NDZhOWNmODU4NTI0Yjc1Y2RlNmY5ZWRmNzI2MjBhNy9saWIvcnN2cC9hc2FwLmpzXG4iLCIndXNlIHN0cmljdCc7XG5cbnZhciBjdXJyeU4gPSByZXF1aXJlKCdyYW1kYS9zcmMvY3VycnlOJyk7XG5cbi8vIFV0aWxpdHlcbmZ1bmN0aW9uIGlzRnVuY3Rpb24ob2JqKSB7XG4gIHJldHVybiAhIShvYmogJiYgb2JqLmNvbnN0cnVjdG9yICYmIG9iai5jYWxsICYmIG9iai5hcHBseSk7XG59XG5mdW5jdGlvbiB0cnVlRm4oKSB7IHJldHVybiB0cnVlOyB9XG5cbi8vIEdsb2JhbHNcbnZhciB0b1VwZGF0ZSA9IFtdO1xudmFyIGluU3RyZWFtO1xudmFyIG9yZGVyID0gW107XG52YXIgb3JkZXJOZXh0SWR4ID0gLTE7XG52YXIgZmx1c2hpbmcgPSBmYWxzZTtcblxuLyoqIEBuYW1lc3BhY2UgKi9cbnZhciBmbHlkID0ge31cblxuLy8gLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vIEFQSSAvLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8gLy9cblxuLyoqXG4gKiBDcmVhdGVzIGEgbmV3IHN0cmVhbVxuICpcbiAqIF9fU2lnbmF0dXJlX186IGBhIC0+IFN0cmVhbSBhYFxuICpcbiAqIEBuYW1lIGZseWQuc3RyZWFtXG4gKiBAcGFyYW0geyp9IGluaXRpYWxWYWx1ZSAtIChPcHRpb25hbCkgdGhlIGluaXRpYWwgdmFsdWUgb2YgdGhlIHN0cmVhbVxuICogQHJldHVybiB7c3RyZWFtfSB0aGUgc3RyZWFtXG4gKlxuICogQGV4YW1wbGVcbiAqIHZhciBuID0gZmx5ZC5zdHJlYW0oMSk7IC8vIFN0cmVhbSB3aXRoIGluaXRpYWwgdmFsdWUgYDFgXG4gKiB2YXIgcyA9IGZseWQuc3RyZWFtKCk7IC8vIFN0cmVhbSB3aXRoIG5vIGluaXRpYWwgdmFsdWVcbiAqL1xuZmx5ZC5zdHJlYW0gPSBmdW5jdGlvbihpbml0aWFsVmFsdWUpIHtcbiAgdmFyIGVuZFN0cmVhbSA9IGNyZWF0ZURlcGVuZGVudFN0cmVhbShbXSwgdHJ1ZUZuKTtcbiAgdmFyIHMgPSBjcmVhdGVTdHJlYW0oKTtcbiAgcy5lbmQgPSBlbmRTdHJlYW07XG4gIHMuZm5BcmdzID0gW107XG4gIGVuZFN0cmVhbS5saXN0ZW5lcnMucHVzaChzKTtcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPiAwKSBzKGluaXRpYWxWYWx1ZSk7XG4gIHJldHVybiBzO1xufVxuXG4vKipcbiAqIENyZWF0ZSBhIG5ldyBkZXBlbmRlbnQgc3RyZWFtXG4gKlxuICogX19TaWduYXR1cmVfXzogYCguLi5TdHJlYW0gKiAtPiBTdHJlYW0gYiAtPiBiKSAtPiBbU3RyZWFtICpdIC0+IFN0cmVhbSBiYFxuICpcbiAqIEBuYW1lIGZseWQuY29tYmluZVxuICogQHBhcmFtIHtGdW5jdGlvbn0gZm4gLSB0aGUgZnVuY3Rpb24gdXNlZCB0byBjb21iaW5lIHRoZSBzdHJlYW1zXG4gKiBAcGFyYW0ge0FycmF5PHN0cmVhbT59IGRlcGVuZGVuY2llcyAtIHRoZSBzdHJlYW1zIHRoYXQgdGhpcyBvbmUgZGVwZW5kcyBvblxuICogQHJldHVybiB7c3RyZWFtfSB0aGUgZGVwZW5kZW50IHN0cmVhbVxuICpcbiAqIEBleGFtcGxlXG4gKiB2YXIgbjEgPSBmbHlkLnN0cmVhbSgwKTtcbiAqIHZhciBuMiA9IGZseWQuc3RyZWFtKDApO1xuICogdmFyIG1heCA9IGZseWQuY29tYmluZShmdW5jdGlvbihuMSwgbjIsIHNlbGYsIGNoYW5nZWQpIHtcbiAqICAgcmV0dXJuIG4xKCkgPiBuMigpID8gbjEoKSA6IG4yKCk7XG4gKiB9LCBbbjEsIG4yXSk7XG4gKi9cbmZseWQuY29tYmluZSA9IGN1cnJ5TigyLCBjb21iaW5lKTtcbmZ1bmN0aW9uIGNvbWJpbmUoZm4sIHN0cmVhbXMpIHtcbiAgdmFyIGksIHMsIGRlcHMsIGRlcEVuZFN0cmVhbXM7XG4gIHZhciBlbmRTdHJlYW0gPSBjcmVhdGVEZXBlbmRlbnRTdHJlYW0oW10sIHRydWVGbik7XG4gIGRlcHMgPSBbXTsgZGVwRW5kU3RyZWFtcyA9IFtdO1xuICBmb3IgKGkgPSAwOyBpIDwgc3RyZWFtcy5sZW5ndGg7ICsraSkge1xuICAgIGlmIChzdHJlYW1zW2ldICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGRlcHMucHVzaChzdHJlYW1zW2ldKTtcbiAgICAgIGlmIChzdHJlYW1zW2ldLmVuZCAhPT0gdW5kZWZpbmVkKSBkZXBFbmRTdHJlYW1zLnB1c2goc3RyZWFtc1tpXS5lbmQpO1xuICAgIH1cbiAgfVxuICBzID0gY3JlYXRlRGVwZW5kZW50U3RyZWFtKGRlcHMsIGZuKTtcbiAgcy5kZXBzQ2hhbmdlZCA9IFtdO1xuICBzLmZuQXJncyA9IHMuZGVwcy5jb25jYXQoW3MsIHMuZGVwc0NoYW5nZWRdKTtcbiAgcy5lbmQgPSBlbmRTdHJlYW07XG4gIGVuZFN0cmVhbS5saXN0ZW5lcnMucHVzaChzKTtcbiAgYWRkTGlzdGVuZXJzKGRlcEVuZFN0cmVhbXMsIGVuZFN0cmVhbSk7XG4gIGVuZFN0cmVhbS5kZXBzID0gZGVwRW5kU3RyZWFtcztcbiAgdXBkYXRlU3RyZWFtKHMpO1xuICByZXR1cm4gcztcbn1cblxuLyoqXG4gKiBSZXR1cm5zIGB0cnVlYCBpZiB0aGUgc3VwcGxpZWQgYXJndW1lbnQgaXMgYSBGbHlkIHN0cmVhbSBhbmQgYGZhbHNlYCBvdGhlcndpc2UuXG4gKlxuICogX19TaWduYXR1cmVfXzogYCogLT4gQm9vbGVhbmBcbiAqXG4gKiBAbmFtZSBmbHlkLmlzU3RyZWFtXG4gKiBAcGFyYW0geyp9IHZhbHVlIC0gdGhlIHZhbHVlIHRvIHRlc3RcbiAqIEByZXR1cm4ge0Jvb2xlYW59IGB0cnVlYCBpZiBpcyBhIEZseWQgc3RyZWFtbiwgYGZhbHNlYCBvdGhlcndpc2VcbiAqXG4gKiBAZXhhbXBsZVxuICogdmFyIHMgPSBmbHlkLnN0cmVhbSgxKTtcbiAqIHZhciBuID0gMTtcbiAqIGZseWQuaXNTdHJlYW0ocyk7IC8vPT4gdHJ1ZVxuICogZmx5ZC5pc1N0cmVhbShuKTsgLy89PiBmYWxzZVxuICovXG5mbHlkLmlzU3RyZWFtID0gZnVuY3Rpb24oc3RyZWFtKSB7XG4gIHJldHVybiBpc0Z1bmN0aW9uKHN0cmVhbSkgJiYgJ2hhc1ZhbCcgaW4gc3RyZWFtO1xufVxuXG4vKipcbiAqIEludm9rZXMgdGhlIGJvZHkgKHRoZSBmdW5jdGlvbiB0byBjYWxjdWxhdGUgdGhlIHZhbHVlKSBvZiBhIGRlcGVuZGVudCBzdHJlYW1cbiAqXG4gKiBCeSBkZWZhdWx0IHRoZSBib2R5IG9mIGEgZGVwZW5kZW50IHN0cmVhbSBpcyBvbmx5IGNhbGxlZCB3aGVuIGFsbCB0aGUgc3RyZWFtc1xuICogdXBvbiB3aGljaCBpdCBkZXBlbmRzIGhhcyBhIHZhbHVlLiBgaW1tZWRpYXRlYCBjYW4gY2lyY3VtdmVudCB0aGlzIGJlaGF2aW91ci5cbiAqIEl0IGltbWVkaWF0ZWx5IGludm9rZXMgdGhlIGJvZHkgb2YgYSBkZXBlbmRlbnQgc3RyZWFtLlxuICpcbiAqIF9fU2lnbmF0dXJlX186IGBTdHJlYW0gYSAtPiBTdHJlYW0gYWBcbiAqXG4gKiBAbmFtZSBmbHlkLmltbWVkaWF0ZVxuICogQHBhcmFtIHtzdHJlYW19IHN0cmVhbSAtIHRoZSBkZXBlbmRlbnQgc3RyZWFtXG4gKiBAcmV0dXJuIHtzdHJlYW19IHRoZSBzYW1lIHN0cmVhbVxuICpcbiAqIEBleGFtcGxlXG4gKiB2YXIgcyA9IGZseWQuc3RyZWFtKCk7XG4gKiB2YXIgaGFzSXRlbXMgPSBmbHlkLmltbWVkaWF0ZShmbHlkLmNvbWJpbmUoZnVuY3Rpb24ocykge1xuICogICByZXR1cm4gcygpICE9PSB1bmRlZmluZWQgJiYgcygpLmxlbmd0aCA+IDA7XG4gKiB9LCBbc10pO1xuICogY29uc29sZS5sb2coaGFzSXRlbXMoKSk7IC8vIGxvZ3MgYGZhbHNlYC4gSGFkIGBpbW1lZGlhdGVgIG5vdCBiZWVuXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gdXNlZCBgaGFzSXRlbXMoKWAgd291bGQndmUgcmV0dXJuZWQgYHVuZGVmaW5lZGBcbiAqIHMoWzFdKTtcbiAqIGNvbnNvbGUubG9nKGhhc0l0ZW1zKCkpOyAvLyBsb2dzIGB0cnVlYC5cbiAqIHMoW10pO1xuICogY29uc29sZS5sb2coaGFzSXRlbXMoKSk7IC8vIGxvZ3MgYGZhbHNlYC5cbiAqL1xuZmx5ZC5pbW1lZGlhdGUgPSBmdW5jdGlvbihzKSB7XG4gIGlmIChzLmRlcHNNZXQgPT09IGZhbHNlKSB7XG4gICAgcy5kZXBzTWV0ID0gdHJ1ZTtcbiAgICB1cGRhdGVTdHJlYW0ocyk7XG4gIH1cbiAgcmV0dXJuIHM7XG59XG5cbi8qKlxuICogQ2hhbmdlcyB3aGljaCBgZW5kc1N0cmVhbWAgc2hvdWxkIHRyaWdnZXIgdGhlIGVuZGluZyBvZiBgc2AuXG4gKlxuICogX19TaWduYXR1cmVfXzogYFN0cmVhbSBhIC0+IFN0cmVhbSBiIC0+IFN0cmVhbSBiYFxuICpcbiAqIEBuYW1lIGZseWQuZW5kc09uXG4gKiBAcGFyYW0ge3N0cmVhbX0gZW5kU3RyZWFtIC0gdGhlIHN0cmVhbSB0byB0cmlnZ2VyIHRoZSBlbmRpbmdcbiAqIEBwYXJhbSB7c3RyZWFtfSBzdHJlYW0gLSB0aGUgc3RyZWFtIHRvIGJlIGVuZGVkIGJ5IHRoZSBlbmRTdHJlYW1cbiAqIEBwYXJhbSB7c3RyZWFtfSB0aGUgc3RyZWFtIG1vZGlmaWVkIHRvIGJlIGVuZGVkIGJ5IGVuZFN0cmVhbVxuICpcbiAqIEBleGFtcGxlXG4gKiB2YXIgbiA9IGZseWQuc3RyZWFtKDEpO1xuICogdmFyIGtpbGxlciA9IGZseWQuc3RyZWFtKCk7XG4gKiAvLyBgZG91YmxlYCBlbmRzIHdoZW4gYG5gIGVuZHMgb3Igd2hlbiBga2lsbGVyYCBlbWl0cyBhbnkgdmFsdWVcbiAqIHZhciBkb3VibGUgPSBmbHlkLmVuZHNPbihmbHlkLm1lcmdlKG4uZW5kLCBraWxsZXIpLCBmbHlkLmNvbWJpbmUoZnVuY3Rpb24obikge1xuICogICByZXR1cm4gMiAqIG4oKTtcbiAqIH0sIFtuXSk7XG4qL1xuZmx5ZC5lbmRzT24gPSBmdW5jdGlvbihlbmRTLCBzKSB7XG4gIGRldGFjaERlcHMocy5lbmQpO1xuICBlbmRTLmxpc3RlbmVycy5wdXNoKHMuZW5kKTtcbiAgcy5lbmQuZGVwcy5wdXNoKGVuZFMpO1xuICByZXR1cm4gcztcbn1cblxuLyoqXG4gKiBNYXAgYSBzdHJlYW1cbiAqXG4gKiBSZXR1cm5zIGEgbmV3IHN0cmVhbSBjb25zaXN0aW5nIG9mIGV2ZXJ5IHZhbHVlIGZyb20gYHNgIHBhc3NlZCB0aHJvdWdoXG4gKiBgZm5gLiBJLmUuIGBtYXBgIGNyZWF0ZXMgYSBuZXcgc3RyZWFtIHRoYXQgbGlzdGVucyB0byBgc2AgYW5kXG4gKiBhcHBsaWVzIGBmbmAgdG8gZXZlcnkgbmV3IHZhbHVlLlxuICogX19TaWduYXR1cmVfXzogYChhIC0+IHJlc3VsdCkgLT4gU3RyZWFtIGEgLT4gU3RyZWFtIHJlc3VsdGBcbiAqXG4gKiBAbmFtZSBmbHlkLm1hcFxuICogQHBhcmFtIHtGdW5jdGlvbn0gZm4gLSB0aGUgZnVuY3Rpb24gdGhhdCBwcm9kdWNlcyB0aGUgZWxlbWVudHMgb2YgdGhlIG5ldyBzdHJlYW1cbiAqIEBwYXJhbSB7c3RyZWFtfSBzdHJlYW0gLSB0aGUgc3RyZWFtIHRvIG1hcFxuICogQHJldHVybiB7c3RyZWFtfSBhIG5ldyBzdHJlYW0gd2l0aCB0aGUgbWFwcGVkIHZhbHVlc1xuICpcbiAqIEBleGFtcGxlXG4gKiB2YXIgbnVtYmVycyA9IGZseWQuc3RyZWFtKDApO1xuICogdmFyIHNxdWFyZWROdW1iZXJzID0gZmx5ZC5tYXAoZnVuY3Rpb24obikgeyByZXR1cm4gbipuOyB9LCBudW1iZXJzKTtcbiAqL1xuLy8gTGlicmFyeSBmdW5jdGlvbnMgdXNlIHNlbGYgY2FsbGJhY2sgdG8gYWNjZXB0IChudWxsLCB1bmRlZmluZWQpIHVwZGF0ZSB0cmlnZ2Vycy5cbmZseWQubWFwID0gY3VycnlOKDIsIGZ1bmN0aW9uKGYsIHMpIHtcbiAgcmV0dXJuIGNvbWJpbmUoZnVuY3Rpb24ocywgc2VsZikgeyBzZWxmKGYocy52YWwpKTsgfSwgW3NdKTtcbn0pXG5cbi8qKlxuICogTGlzdGVuIHRvIHN0cmVhbSBldmVudHNcbiAqXG4gKiBTaW1pbGFyIHRvIGBtYXBgIGV4Y2VwdCB0aGF0IHRoZSByZXR1cm5lZCBzdHJlYW0gaXMgZW1wdHkuIFVzZSBgb25gIGZvciBkb2luZ1xuICogc2lkZSBlZmZlY3RzIGluIHJlYWN0aW9uIHRvIHN0cmVhbSBjaGFuZ2VzLiBVc2UgdGhlIHJldHVybmVkIHN0cmVhbSBvbmx5IGlmIHlvdVxuICogbmVlZCB0byBtYW51YWxseSBlbmQgaXQuXG4gKlxuICogX19TaWduYXR1cmVfXzogYChhIC0+IHJlc3VsdCkgLT4gU3RyZWFtIGEgLT4gU3RyZWFtIHVuZGVmaW5lZGBcbiAqXG4gKiBAbmFtZSBmbHlkLm9uXG4gKiBAcGFyYW0ge0Z1bmN0aW9ufSBjYiAtIHRoZSBjYWxsYmFja1xuICogQHBhcmFtIHtzdHJlYW19IHN0cmVhbSAtIHRoZSBzdHJlYW1cbiAqIEByZXR1cm4ge3N0cmVhbX0gYW4gZW1wdHkgc3RyZWFtIChjYW4gYmUgZW5kZWQpXG4gKi9cbmZseWQub24gPSBjdXJyeU4oMiwgZnVuY3Rpb24oZiwgcykge1xuICByZXR1cm4gY29tYmluZShmdW5jdGlvbihzKSB7IGYocy52YWwpOyB9LCBbc10pO1xufSlcblxuLyoqXG4gKiBDcmVhdGVzIGEgbmV3IHN0cmVhbSB3aXRoIHRoZSByZXN1bHRzIG9mIGNhbGxpbmcgdGhlIGZ1bmN0aW9uIG9uIGV2ZXJ5IGluY29taW5nXG4gKiBzdHJlYW0gd2l0aCBhbmQgYWNjdW11bGF0b3IgYW5kIHRoZSBpbmNvbWluZyB2YWx1ZS5cbiAqXG4gKiBfX1NpZ25hdHVyZV9fOiBgKGEgLT4gYiAtPiBhKSAtPiBhIC0+IFN0cmVhbSBiIC0+IFN0cmVhbSBhYFxuICpcbiAqIEBuYW1lIGZseWQuc2NhblxuICogQHBhcmFtIHtGdW5jdGlvbn0gZm4gLSB0aGUgZnVuY3Rpb24gdG8gY2FsbFxuICogQHBhcmFtIHsqfSB2YWwgLSB0aGUgaW5pdGlhbCB2YWx1ZSBvZiB0aGUgYWNjdW11bGF0b3JcbiAqIEBwYXJhbSB7c3RyZWFtfSBzdHJlYW0gLSB0aGUgc3RyZWFtIHNvdXJjZVxuICogQHJldHVybiB7c3RyZWFtfSB0aGUgbmV3IHN0cmVhbVxuICpcbiAqIEBleGFtcGxlXG4gKiB2YXIgbnVtYmVycyA9IGZseWQuc3RyZWFtKCk7XG4gKiB2YXIgc3VtID0gZmx5ZC5zY2FuKGZ1bmN0aW9uKHN1bSwgbikgeyByZXR1cm4gc3VtK247IH0sIDAsIG51bWJlcnMpO1xuICogbnVtYmVycygyKSgzKSg1KTtcbiAqIHN1bSgpOyAvLyAxMFxuICovXG5mbHlkLnNjYW4gPSBjdXJyeU4oMywgZnVuY3Rpb24oZiwgYWNjLCBzKSB7XG4gIHZhciBucyA9IGNvbWJpbmUoZnVuY3Rpb24ocywgc2VsZikge1xuICAgIHNlbGYoYWNjID0gZihhY2MsIHMudmFsKSk7XG4gIH0sIFtzXSk7XG4gIGlmICghbnMuaGFzVmFsKSBucyhhY2MpO1xuICByZXR1cm4gbnM7XG59KTtcblxuLyoqXG4gKiBDcmVhdGVzIGEgbmV3IHN0cmVhbSBkb3duIHdoaWNoIGFsbCB2YWx1ZXMgZnJvbSBib3RoIGBzdHJlYW0xYCBhbmQgYHN0cmVhbTJgXG4gKiB3aWxsIGJlIHNlbnQuXG4gKlxuICogX19TaWduYXR1cmVfXzogYFN0cmVhbSBhIC0+IFN0cmVhbSBhIC0+IFN0cmVhbSBhYFxuICpcbiAqIEBuYW1lIGZseWQubWVyZ2VcbiAqIEBwYXJhbSB7c3RyZWFtfSBzb3VyY2UxIC0gb25lIHN0cmVhbSB0byBiZSBtZXJnZWRcbiAqIEBwYXJhbSB7c3RyZWFtfSBzb3VyY2UyIC0gdGhlIG90aGVyIHN0cmVhbSB0byBiZSBtZXJnZWRcbiAqIEByZXR1cm4ge3N0cmVhbX0gYSBzdHJlYW0gd2l0aCB0aGUgdmFsdWVzIGZyb20gYm90aCBzb3VyY2VzXG4gKlxuICogQGV4YW1wbGVcbiAqIHZhciBidG4xQ2xpY2tzID0gZmx5ZC5zdHJlYW0oKTtcbiAqIGJ1dHRvbjFFbG0uYWRkRXZlbnRMaXN0ZW5lcihidG4xQ2xpY2tzKTtcbiAqIHZhciBidG4yQ2xpY2tzID0gZmx5ZC5zdHJlYW0oKTtcbiAqIGJ1dHRvbjJFbG0uYWRkRXZlbnRMaXN0ZW5lcihidG4yQ2xpY2tzKTtcbiAqIHZhciBhbGxDbGlja3MgPSBmbHlkLm1lcmdlKGJ0bjFDbGlja3MsIGJ0bjJDbGlja3MpO1xuICovXG5mbHlkLm1lcmdlID0gY3VycnlOKDIsIGZ1bmN0aW9uKHMxLCBzMikge1xuICB2YXIgcyA9IGZseWQuaW1tZWRpYXRlKGNvbWJpbmUoZnVuY3Rpb24oczEsIHMyLCBzZWxmLCBjaGFuZ2VkKSB7XG4gICAgaWYgKGNoYW5nZWRbMF0pIHtcbiAgICAgIHNlbGYoY2hhbmdlZFswXSgpKTtcbiAgICB9IGVsc2UgaWYgKHMxLmhhc1ZhbCkge1xuICAgICAgc2VsZihzMS52YWwpO1xuICAgIH0gZWxzZSBpZiAoczIuaGFzVmFsKSB7XG4gICAgICBzZWxmKHMyLnZhbCk7XG4gICAgfVxuICB9LCBbczEsIHMyXSkpO1xuICBmbHlkLmVuZHNPbihjb21iaW5lKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiB0cnVlO1xuICB9LCBbczEuZW5kLCBzMi5lbmRdKSwgcyk7XG4gIHJldHVybiBzO1xufSk7XG5cbi8qKlxuICogQ3JlYXRlcyBhIG5ldyBzdHJlYW0gcmVzdWx0aW5nIGZyb20gYXBwbHlpbmcgYHRyYW5zZHVjZXJgIHRvIGBzdHJlYW1gLlxuICpcbiAqIF9fU2lnbmF0dXJlX186IGBUcmFuc2R1Y2VyIC0+IFN0cmVhbSBhIC0+IFN0cmVhbSBiYFxuICpcbiAqIEBuYW1lIGZseWQudHJhbnNkdWNlXG4gKiBAcGFyYW0ge1RyYW5zZHVjZXJ9IHhmb3JtIC0gdGhlIHRyYW5zZHVjZXIgdHJhbnNmb3JtYXRpb25cbiAqIEBwYXJhbSB7c3RyZWFtfSBzb3VyY2UgLSB0aGUgc3RyZWFtIHNvdXJjZVxuICogQHJldHVybiB7c3RyZWFtfSB0aGUgbmV3IHN0cmVhbVxuICpcbiAqIEBleGFtcGxlXG4gKiB2YXIgdCA9IHJlcXVpcmUoJ3RyYW5zZHVjZXJzLmpzJyk7XG4gKlxuICogdmFyIHJlc3VsdHMgPSBbXTtcbiAqIHZhciBzMSA9IGZseWQuc3RyZWFtKCk7XG4gKiB2YXIgdHggPSB0LmNvbXBvc2UodC5tYXAoZnVuY3Rpb24oeCkgeyByZXR1cm4geCAqIDI7IH0pLCB0LmRlZHVwZSgpKTtcbiAqIHZhciBzMiA9IGZseWQudHJhbnNkdWNlKHR4LCBzMSk7XG4gKiBmbHlkLmNvbWJpbmUoZnVuY3Rpb24oczIpIHsgcmVzdWx0cy5wdXNoKHMyKCkpOyB9LCBbczJdKTtcbiAqIHMxKDEpKDEpKDIpKDMpKDMpKDMpKDQpO1xuICogcmVzdWx0czsgLy8gPT4gWzIsIDQsIDYsIDhdXG4gKi9cbmZseWQudHJhbnNkdWNlID0gY3VycnlOKDIsIGZ1bmN0aW9uKHhmb3JtLCBzb3VyY2UpIHtcbiAgeGZvcm0gPSB4Zm9ybShuZXcgU3RyZWFtVHJhbnNmb3JtZXIoKSk7XG4gIHJldHVybiBjb21iaW5lKGZ1bmN0aW9uKHNvdXJjZSwgc2VsZikge1xuICAgIHZhciByZXMgPSB4Zm9ybVsnQEB0cmFuc2R1Y2VyL3N0ZXAnXSh1bmRlZmluZWQsIHNvdXJjZS52YWwpO1xuICAgIGlmIChyZXMgJiYgcmVzWydAQHRyYW5zZHVjZXIvcmVkdWNlZCddID09PSB0cnVlKSB7XG4gICAgICBzZWxmLmVuZCh0cnVlKTtcbiAgICAgIHJldHVybiByZXNbJ0BAdHJhbnNkdWNlci92YWx1ZSddO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXR1cm4gcmVzO1xuICAgIH1cbiAgfSwgW3NvdXJjZV0pO1xufSk7XG5cbi8qKlxuICogUmV0dXJucyBgZm5gIGN1cnJpZWQgdG8gYG5gLiBVc2UgdGhpcyBmdW5jdGlvbiB0byBjdXJyeSBmdW5jdGlvbnMgZXhwb3NlZCBieVxuICogbW9kdWxlcyBmb3IgRmx5ZC5cbiAqXG4gKiBAbmFtZSBmbHlkLmN1cnJ5TlxuICogQGZ1bmN0aW9uXG4gKiBAcGFyYW0ge0ludGVnZXJ9IGFyaXR5IC0gdGhlIGZ1bmN0aW9uIGFyaXR5XG4gKiBAcGFyYW0ge0Z1bmN0aW9ufSBmbiAtIHRoZSBmdW5jdGlvbiB0byBjdXJyeVxuICogQHJldHVybiB7RnVuY3Rpb259IHRoZSBjdXJyaWVkIGZ1bmN0aW9uXG4gKlxuICogQGV4YW1wbGVcbiAqIGZ1bmN0aW9uIGFkZCh4LCB5KSB7IHJldHVybiB4ICsgeTsgfTtcbiAqIHZhciBhID0gZmx5ZC5jdXJyeU4oMiwgYWRkKTtcbiAqIGEoMikoNCkgLy8gPT4gNlxuICovXG5mbHlkLmN1cnJ5TiA9IGN1cnJ5TlxuXG4vKipcbiAqIFJldHVybnMgYSBuZXcgc3RyZWFtIGlkZW50aWNhbCB0byB0aGUgb3JpZ2luYWwgZXhjZXB0IGV2ZXJ5XG4gKiB2YWx1ZSB3aWxsIGJlIHBhc3NlZCB0aHJvdWdoIGBmYC5cbiAqXG4gKiBfTm90ZTpfIFRoaXMgZnVuY3Rpb24gaXMgaW5jbHVkZWQgaW4gb3JkZXIgdG8gc3VwcG9ydCB0aGUgZmFudGFzeSBsYW5kXG4gKiBzcGVjaWZpY2F0aW9uLlxuICpcbiAqIF9fU2lnbmF0dXJlX186IENhbGxlZCBib3VuZCB0byBgU3RyZWFtIGFgOiBgKGEgLT4gYikgLT4gU3RyZWFtIGJgXG4gKlxuICogQG5hbWUgc3RyZWFtLm1hcFxuICogQHBhcmFtIHtGdW5jdGlvbn0gZnVuY3Rpb24gLSB0aGUgZnVuY3Rpb24gdG8gYXBwbHlcbiAqIEByZXR1cm4ge3N0cmVhbX0gYSBuZXcgc3RyZWFtIHdpdGggdGhlIHZhbHVlcyBtYXBwZWRcbiAqXG4gKiBAZXhhbXBsZVxuICogdmFyIG51bWJlcnMgPSBmbHlkLnN0cmVhbSgwKTtcbiAqIHZhciBzcXVhcmVkTnVtYmVycyA9IG51bWJlcnMubWFwKGZ1bmN0aW9uKG4pIHsgcmV0dXJuIG4qbjsgfSk7XG4gKi9cbmZ1bmN0aW9uIGJvdW5kTWFwKGYpIHsgcmV0dXJuIGZseWQubWFwKGYsIHRoaXMpOyB9XG5cbi8qKlxuICogUmV0dXJucyBhIG5ldyBzdHJlYW0gd2hpY2ggaXMgdGhlIHJlc3VsdCBvZiBhcHBseWluZyB0aGVcbiAqIGZ1bmN0aW9ucyBmcm9tIGB0aGlzYCBzdHJlYW0gdG8gdGhlIHZhbHVlcyBpbiBgc3RyZWFtYCBwYXJhbWV0ZXIuXG4gKlxuICogYHRoaXNgIHN0cmVhbSBtdXN0IGJlIGEgc3RyZWFtIG9mIGZ1bmN0aW9ucy5cbiAqXG4gKiBfTm90ZTpfIFRoaXMgZnVuY3Rpb24gaXMgaW5jbHVkZWQgaW4gb3JkZXIgdG8gc3VwcG9ydCB0aGUgZmFudGFzeSBsYW5kXG4gKiBzcGVjaWZpY2F0aW9uLlxuICpcbiAqIF9fU2lnbmF0dXJlX186IENhbGxlZCBib3VuZCB0byBgU3RyZWFtIChhIC0+IGIpYDogYGEgLT4gU3RyZWFtIGJgXG4gKlxuICogQG5hbWUgc3RyZWFtLmFwXG4gKiBAcGFyYW0ge3N0cmVhbX0gc3RyZWFtIC0gdGhlIHZhbHVlcyBzdHJlYW1cbiAqIEByZXR1cm4ge3N0cmVhbX0gYSBuZXcgc3RyYW0gd2l0aCB0aGUgZnVuY3Rpb25zIGFwcGxpZWQgdG8gdmFsdWVzXG4gKlxuICogQGV4YW1wbGVcbiAqIHZhciBhZGQgPSBmbHlkLmN1cnJ5TigyLCBmdW5jdGlvbih4LCB5KSB7IHJldHVybiB4ICsgeTsgfSk7XG4gKiB2YXIgbnVtYmVyczEgPSBmbHlkLnN0cmVhbSgpO1xuICogdmFyIG51bWJlcnMyID0gZmx5ZC5zdHJlYW0oKTtcbiAqIHZhciBhZGRUb051bWJlcnMxID0gZmx5ZC5tYXAoYWRkLCBudW1iZXJzMSk7XG4gKiB2YXIgYWRkZWQgPSBhZGRUb051bWJlcnMxLmFwKG51bWJlcnMyKTtcbiAqL1xuZnVuY3Rpb24gYXAoczIpIHtcbiAgdmFyIHMxID0gdGhpcztcbiAgcmV0dXJuIGNvbWJpbmUoZnVuY3Rpb24oczEsIHMyLCBzZWxmKSB7IHNlbGYoczEudmFsKHMyLnZhbCkpOyB9LCBbczEsIHMyXSk7XG59XG5cbi8qKlxuICogR2V0IGEgaHVtYW4gcmVhZGFibGUgdmlldyBvZiBhIHN0cmVhbVxuICogQG5hbWUgc3RyZWFtLnRvU3RyaW5nXG4gKiBAcmV0dXJuIHtTdHJpbmd9IHRoZSBzdHJlYW0gc3RyaW5nIHJlcHJlc2VudGF0aW9uXG4gKi9cbmZ1bmN0aW9uIHN0cmVhbVRvU3RyaW5nKCkge1xuICByZXR1cm4gJ3N0cmVhbSgnICsgdGhpcy52YWwgKyAnKSc7XG59XG5cbi8qKlxuICogQG5hbWUgc3RyZWFtLmVuZFxuICogQG1lbWJlcm9mIHN0cmVhbVxuICogQSBzdHJlYW0gdGhhdCBlbWl0cyBgdHJ1ZWAgd2hlbiB0aGUgc3RyZWFtIGVuZHMuIElmIGB0cnVlYCBpcyBwdXNoZWQgZG93biB0aGVcbiAqIHN0cmVhbSB0aGUgcGFyZW50IHN0cmVhbSBlbmRzLlxuICovXG5cbi8qKlxuICogQG5hbWUgc3RyZWFtLm9mXG4gKiBAZnVuY3Rpb25cbiAqIEBtZW1iZXJvZiBzdHJlYW1cbiAqIFJldHVybnMgYSBuZXcgc3RyZWFtIHdpdGggYHZhbHVlYCBhcyBpdHMgaW5pdGlhbCB2YWx1ZS4gSXQgaXMgaWRlbnRpY2FsIHRvXG4gKiBjYWxsaW5nIGBmbHlkLnN0cmVhbWAgd2l0aCBvbmUgYXJndW1lbnQuXG4gKlxuICogX19TaWduYXR1cmVfXzogQ2FsbGVkIGJvdW5kIHRvIGBTdHJlYW0gKGEpYDogYGIgLT4gU3RyZWFtIGJgXG4gKlxuICogQHBhcmFtIHsqfSB2YWx1ZSAtIHRoZSBpbml0aWFsIHZhbHVlXG4gKiBAcmV0dXJuIHtzdHJlYW19IHRoZSBuZXcgc3RyZWFtXG4gKlxuICogQGV4YW1wbGVcbiAqIHZhciBuID0gZmx5ZC5zdHJlYW0oMSk7XG4gKiB2YXIgbSA9IG4ub2YoMSk7XG4gKi9cblxuLy8gLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vIFBSSVZBVEUgLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vIC8vXG4vKipcbiAqIEBwcml2YXRlXG4gKiBDcmVhdGUgYSBzdHJlYW0gd2l0aCBubyBkZXBlbmRlbmNpZXMgYW5kIG5vIHZhbHVlXG4gKiBAcmV0dXJuIHtGdW5jdGlvbn0gYSBmbHlkIHN0cmVhbVxuICovXG5mdW5jdGlvbiBjcmVhdGVTdHJlYW0oKSB7XG4gIGZ1bmN0aW9uIHMobikge1xuICAgIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAwKSByZXR1cm4gcy52YWxcbiAgICB1cGRhdGVTdHJlYW1WYWx1ZShzLCBuKVxuICAgIHJldHVybiBzXG4gIH1cbiAgcy5oYXNWYWwgPSBmYWxzZTtcbiAgcy52YWwgPSB1bmRlZmluZWQ7XG4gIHMudmFscyA9IFtdO1xuICBzLmxpc3RlbmVycyA9IFtdO1xuICBzLnF1ZXVlZCA9IGZhbHNlO1xuICBzLmVuZCA9IHVuZGVmaW5lZDtcbiAgcy5tYXAgPSBib3VuZE1hcDtcbiAgcy5hcCA9IGFwO1xuICBzLm9mID0gZmx5ZC5zdHJlYW07XG4gIHMudG9TdHJpbmcgPSBzdHJlYW1Ub1N0cmluZztcbiAgcmV0dXJuIHM7XG59XG5cbi8qKlxuICogQHByaXZhdGVcbiAqIENyZWF0ZSBhIGRlcGVuZGVudCBzdHJlYW1cbiAqIEBwYXJhbSB7QXJyYXk8c3RyZWFtPn0gZGVwZW5kZW5jaWVzIC0gYW4gYXJyYXkgb2YgdGhlIHN0cmVhbXNcbiAqIEBwYXJhbSB7RnVuY3Rpb259IGZuIC0gdGhlIGZ1bmN0aW9uIHVzZWQgdG8gY2FsY3VsYXRlIHRoZSBuZXcgc3RyZWFtIHZhbHVlXG4gKiBmcm9tIHRoZSBkZXBlbmRlbmNpZXNcbiAqIEByZXR1cm4ge3N0cmVhbX0gdGhlIGNyZWF0ZWQgc3RyZWFtXG4gKi9cbmZ1bmN0aW9uIGNyZWF0ZURlcGVuZGVudFN0cmVhbShkZXBzLCBmbikge1xuICB2YXIgcyA9IGNyZWF0ZVN0cmVhbSgpO1xuICBzLmZuID0gZm47XG4gIHMuZGVwcyA9IGRlcHM7XG4gIHMuZGVwc01ldCA9IGZhbHNlO1xuICBzLmRlcHNDaGFuZ2VkID0gZGVwcy5sZW5ndGggPiAwID8gW10gOiB1bmRlZmluZWQ7XG4gIHMuc2hvdWxkVXBkYXRlID0gZmFsc2U7XG4gIGFkZExpc3RlbmVycyhkZXBzLCBzKTtcbiAgcmV0dXJuIHM7XG59XG5cbi8qKlxuICogQHByaXZhdGVcbiAqIENoZWNrIGlmIGFsbCB0aGUgZGVwZW5kZW5jaWVzIGhhdmUgdmFsdWVzXG4gKiBAcGFyYW0ge3N0cmVhbX0gc3RyZWFtIC0gdGhlIHN0cmVhbSB0byBjaGVjayBkZXBlbmNlbmNpZXMgZnJvbVxuICogQHJldHVybiB7Qm9vbGVhbn0gYHRydWVgIGlmIGFsbCBkZXBlbmRlbmNpZXMgaGF2ZSB2YWxlcywgYGZhbHNlYCBvdGhlcndpc2VcbiAqL1xuZnVuY3Rpb24gaW5pdGlhbERlcHNOb3RNZXQoc3RyZWFtKSB7XG4gIHN0cmVhbS5kZXBzTWV0ID0gc3RyZWFtLmRlcHMuZXZlcnkoZnVuY3Rpb24ocykge1xuICAgIHJldHVybiBzLmhhc1ZhbDtcbiAgfSk7XG4gIHJldHVybiAhc3RyZWFtLmRlcHNNZXQ7XG59XG5cbi8qKlxuICogQHByaXZhdGVcbiAqIFVwZGF0ZSBhIGRlcGVuZGVudCBzdHJlYW0gdXNpbmcgaXRzIGRlcGVuZGVuY2llcyBpbiBhbiBhdG9taWMgd2F5XG4gKiBAcGFyYW0ge3N0cmVhbX0gc3RyZWFtIC0gdGhlIHN0cmVhbSB0byB1cGRhdGVcbiAqL1xuZnVuY3Rpb24gdXBkYXRlU3RyZWFtKHMpIHtcbiAgaWYgKChzLmRlcHNNZXQgIT09IHRydWUgJiYgaW5pdGlhbERlcHNOb3RNZXQocykpIHx8XG4gICAgICAocy5lbmQgIT09IHVuZGVmaW5lZCAmJiBzLmVuZC52YWwgPT09IHRydWUpKSByZXR1cm47XG4gIGlmIChpblN0cmVhbSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdG9VcGRhdGUucHVzaChzKTtcbiAgICByZXR1cm47XG4gIH1cbiAgaW5TdHJlYW0gPSBzO1xuICBpZiAocy5kZXBzQ2hhbmdlZCkgcy5mbkFyZ3Nbcy5mbkFyZ3MubGVuZ3RoIC0gMV0gPSBzLmRlcHNDaGFuZ2VkO1xuICB2YXIgcmV0dXJuVmFsID0gcy5mbi5hcHBseShzLmZuLCBzLmZuQXJncyk7XG4gIGlmIChyZXR1cm5WYWwgIT09IHVuZGVmaW5lZCkge1xuICAgIHMocmV0dXJuVmFsKTtcbiAgfVxuICBpblN0cmVhbSA9IHVuZGVmaW5lZDtcbiAgaWYgKHMuZGVwc0NoYW5nZWQgIT09IHVuZGVmaW5lZCkgcy5kZXBzQ2hhbmdlZCA9IFtdO1xuICBzLnNob3VsZFVwZGF0ZSA9IGZhbHNlO1xuICBpZiAoZmx1c2hpbmcgPT09IGZhbHNlKSBmbHVzaFVwZGF0ZSgpO1xufVxuXG4vKipcbiAqIEBwcml2YXRlXG4gKiBVcGRhdGUgdGhlIGRlcGVuZGVuY2llcyBvZiBhIHN0cmVhbVxuICogQHBhcmFtIHtzdHJlYW19IHN0cmVhbVxuICovXG5mdW5jdGlvbiB1cGRhdGVEZXBzKHMpIHtcbiAgdmFyIGksIG8sIGxpc3RcbiAgdmFyIGxpc3RlbmVycyA9IHMubGlzdGVuZXJzO1xuICBmb3IgKGkgPSAwOyBpIDwgbGlzdGVuZXJzLmxlbmd0aDsgKytpKSB7XG4gICAgbGlzdCA9IGxpc3RlbmVyc1tpXTtcbiAgICBpZiAobGlzdC5lbmQgPT09IHMpIHtcbiAgICAgIGVuZFN0cmVhbShsaXN0KTtcbiAgICB9IGVsc2Uge1xuICAgICAgaWYgKGxpc3QuZGVwc0NoYW5nZWQgIT09IHVuZGVmaW5lZCkgbGlzdC5kZXBzQ2hhbmdlZC5wdXNoKHMpO1xuICAgICAgbGlzdC5zaG91bGRVcGRhdGUgPSB0cnVlO1xuICAgICAgZmluZERlcHMobGlzdCk7XG4gICAgfVxuICB9XG4gIGZvciAoOyBvcmRlck5leHRJZHggPj0gMDsgLS1vcmRlck5leHRJZHgpIHtcbiAgICBvID0gb3JkZXJbb3JkZXJOZXh0SWR4XTtcbiAgICBpZiAoby5zaG91bGRVcGRhdGUgPT09IHRydWUpIHVwZGF0ZVN0cmVhbShvKTtcbiAgICBvLnF1ZXVlZCA9IGZhbHNlO1xuICB9XG59XG5cbi8qKlxuICogQHByaXZhdGVcbiAqIEFkZCBzdHJlYW0gZGVwZW5kZW5jaWVzIHRvIHRoZSBnbG9iYWwgYG9yZGVyYCBxdWV1ZS5cbiAqIEBwYXJhbSB7c3RyZWFtfSBzdHJlYW1cbiAqIEBzZWUgdXBkYXRlRGVwc1xuICovXG5mdW5jdGlvbiBmaW5kRGVwcyhzKSB7XG4gIHZhciBpXG4gIHZhciBsaXN0ZW5lcnMgPSBzLmxpc3RlbmVycztcbiAgaWYgKHMucXVldWVkID09PSBmYWxzZSkge1xuICAgIHMucXVldWVkID0gdHJ1ZTtcbiAgICBmb3IgKGkgPSAwOyBpIDwgbGlzdGVuZXJzLmxlbmd0aDsgKytpKSB7XG4gICAgICBmaW5kRGVwcyhsaXN0ZW5lcnNbaV0pO1xuICAgIH1cbiAgICBvcmRlclsrK29yZGVyTmV4dElkeF0gPSBzO1xuICB9XG59XG5cbi8qKlxuICogQHByaXZhdGVcbiAqL1xuZnVuY3Rpb24gZmx1c2hVcGRhdGUoKSB7XG4gIGZsdXNoaW5nID0gdHJ1ZTtcbiAgd2hpbGUgKHRvVXBkYXRlLmxlbmd0aCA+IDApIHtcbiAgICB2YXIgcyA9IHRvVXBkYXRlLnNoaWZ0KCk7XG4gICAgaWYgKHMudmFscy5sZW5ndGggPiAwKSBzLnZhbCA9IHMudmFscy5zaGlmdCgpO1xuICAgIHVwZGF0ZURlcHMocyk7XG4gIH1cbiAgZmx1c2hpbmcgPSBmYWxzZTtcbn1cblxuLyoqXG4gKiBAcHJpdmF0ZVxuICogUHVzaCBkb3duIGEgdmFsdWUgaW50byBhIHN0cmVhbVxuICogQHBhcmFtIHtzdHJlYW19IHN0cmVhbVxuICogQHBhcmFtIHsqfSB2YWx1ZVxuICovXG5mdW5jdGlvbiB1cGRhdGVTdHJlYW1WYWx1ZShzLCBuKSB7XG4gIGlmIChuICE9PSB1bmRlZmluZWQgJiYgbiAhPT0gbnVsbCAmJiBpc0Z1bmN0aW9uKG4udGhlbikpIHtcbiAgICBuLnRoZW4ocyk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHMudmFsID0gbjtcbiAgcy5oYXNWYWwgPSB0cnVlO1xuICBpZiAoaW5TdHJlYW0gPT09IHVuZGVmaW5lZCkge1xuICAgIGZsdXNoaW5nID0gdHJ1ZTtcbiAgICB1cGRhdGVEZXBzKHMpO1xuICAgIGlmICh0b1VwZGF0ZS5sZW5ndGggPiAwKSBmbHVzaFVwZGF0ZSgpOyBlbHNlIGZsdXNoaW5nID0gZmFsc2U7XG4gIH0gZWxzZSBpZiAoaW5TdHJlYW0gPT09IHMpIHtcbiAgICBtYXJrTGlzdGVuZXJzKHMsIHMubGlzdGVuZXJzKTtcbiAgfSBlbHNlIHtcbiAgICBzLnZhbHMucHVzaChuKTtcbiAgICB0b1VwZGF0ZS5wdXNoKHMpO1xuICB9XG59XG5cbi8qKlxuICogQHByaXZhdGVcbiAqL1xuZnVuY3Rpb24gbWFya0xpc3RlbmVycyhzLCBsaXN0cykge1xuICB2YXIgaSwgbGlzdDtcbiAgZm9yIChpID0gMDsgaSA8IGxpc3RzLmxlbmd0aDsgKytpKSB7XG4gICAgbGlzdCA9IGxpc3RzW2ldO1xuICAgIGlmIChsaXN0LmVuZCAhPT0gcykge1xuICAgICAgaWYgKGxpc3QuZGVwc0NoYW5nZWQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBsaXN0LmRlcHNDaGFuZ2VkLnB1c2gocyk7XG4gICAgICB9XG4gICAgICBsaXN0LnNob3VsZFVwZGF0ZSA9IHRydWU7XG4gICAgfSBlbHNlIHtcbiAgICAgIGVuZFN0cmVhbShsaXN0KTtcbiAgICB9XG4gIH1cbn1cblxuLyoqXG4gKiBAcHJpdmF0ZVxuICogQWRkIGRlcGVuZGVuY2llcyB0byBhIHN0cmVhbVxuICogQHBhcmFtIHtBcnJheTxzdHJlYW0+fSBkZXBlbmRlbmNpZXNcbiAqIEBwYXJhbSB7c3RyZWFtfSBzdHJlYW1cbiAqL1xuZnVuY3Rpb24gYWRkTGlzdGVuZXJzKGRlcHMsIHMpIHtcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBkZXBzLmxlbmd0aDsgKytpKSB7XG4gICAgZGVwc1tpXS5saXN0ZW5lcnMucHVzaChzKTtcbiAgfVxufVxuXG4vKipcbiAqIEBwcml2YXRlXG4gKiBSZW1vdmVzIGFuIHN0cmVhbSBmcm9tIGEgZGVwZW5kZW5jeSBhcnJheVxuICogQHBhcmFtIHtzdHJlYW19IHN0cmVhbVxuICogQHBhcmFtIHtBcnJheTxzdHJlYW0+fSBkZXBlbmRlbmNpZXNcbiAqL1xuZnVuY3Rpb24gcmVtb3ZlTGlzdGVuZXIocywgbGlzdGVuZXJzKSB7XG4gIHZhciBpZHggPSBsaXN0ZW5lcnMuaW5kZXhPZihzKTtcbiAgbGlzdGVuZXJzW2lkeF0gPSBsaXN0ZW5lcnNbbGlzdGVuZXJzLmxlbmd0aCAtIDFdO1xuICBsaXN0ZW5lcnMubGVuZ3RoLS07XG59XG5cbi8qKlxuICogQHByaXZhdGVcbiAqIERldGFjaCBhIHN0cmVhbSBmcm9tIGl0cyBkZXBlbmRlbmNpZXNcbiAqIEBwYXJhbSB7c3RyZWFtfSBzdHJlYW1cbiAqL1xuZnVuY3Rpb24gZGV0YWNoRGVwcyhzKSB7XG4gIGZvciAodmFyIGkgPSAwOyBpIDwgcy5kZXBzLmxlbmd0aDsgKytpKSB7XG4gICAgcmVtb3ZlTGlzdGVuZXIocywgcy5kZXBzW2ldLmxpc3RlbmVycyk7XG4gIH1cbiAgcy5kZXBzLmxlbmd0aCA9IDA7XG59XG5cbi8qKlxuICogQHByaXZhdGVcbiAqIEVuZHMgYSBzdHJlYW1cbiAqL1xuZnVuY3Rpb24gZW5kU3RyZWFtKHMpIHtcbiAgaWYgKHMuZGVwcyAhPT0gdW5kZWZpbmVkKSBkZXRhY2hEZXBzKHMpO1xuICBpZiAocy5lbmQgIT09IHVuZGVmaW5lZCkgZGV0YWNoRGVwcyhzLmVuZCk7XG59XG5cbi8qKlxuICogQHByaXZhdGVcbiAqIHRyYW5zZHVjZXIgc3RyZWFtIHRyYW5zZm9ybWVyXG4gKi9cbmZ1bmN0aW9uIFN0cmVhbVRyYW5zZm9ybWVyKCkgeyB9XG5TdHJlYW1UcmFuc2Zvcm1lci5wcm90b3R5cGVbJ0BAdHJhbnNkdWNlci9pbml0J10gPSBmdW5jdGlvbigpIHsgfTtcblN0cmVhbVRyYW5zZm9ybWVyLnByb3RvdHlwZVsnQEB0cmFuc2R1Y2VyL3Jlc3VsdCddID0gZnVuY3Rpb24oKSB7IH07XG5TdHJlYW1UcmFuc2Zvcm1lci5wcm90b3R5cGVbJ0BAdHJhbnNkdWNlci9zdGVwJ10gPSBmdW5jdGlvbihzLCB2KSB7IHJldHVybiB2OyB9O1xuXG5tb2R1bGUuZXhwb3J0cyA9IGZseWQ7XG4iLCIndXNlIHN0cmljdCc7XG5cbm1vZHVsZS5leHBvcnRzID0gUmVzcG9uc2U7XG5cbi8qKlxuICogQSByZXNwb25zZSBmcm9tIGEgd2ViIHJlcXVlc3RcbiAqXG4gKiBAcGFyYW0ge051bWJlcn0gc3RhdHVzQ29kZVxuICogQHBhcmFtIHtPYmplY3R9IGhlYWRlcnNcbiAqIEBwYXJhbSB7QnVmZmVyfSBib2R5XG4gKiBAcGFyYW0ge1N0cmluZ30gdXJsXG4gKi9cbmZ1bmN0aW9uIFJlc3BvbnNlKHN0YXR1c0NvZGUsIGhlYWRlcnMsIGJvZHksIHVybCkge1xuICBpZiAodHlwZW9mIHN0YXR1c0NvZGUgIT09ICdudW1iZXInKSB7XG4gICAgdGhyb3cgbmV3IFR5cGVFcnJvcignc3RhdHVzQ29kZSBtdXN0IGJlIGEgbnVtYmVyIGJ1dCB3YXMgJyArICh0eXBlb2Ygc3RhdHVzQ29kZSkpO1xuICB9XG4gIGlmIChoZWFkZXJzID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IFR5cGVFcnJvcignaGVhZGVycyBjYW5ub3QgYmUgbnVsbCcpO1xuICB9XG4gIGlmICh0eXBlb2YgaGVhZGVycyAhPT0gJ29iamVjdCcpIHtcbiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdoZWFkZXJzIG11c3QgYmUgYW4gb2JqZWN0IGJ1dCB3YXMgJyArICh0eXBlb2YgaGVhZGVycykpO1xuICB9XG4gIHRoaXMuc3RhdHVzQ29kZSA9IHN0YXR1c0NvZGU7XG4gIHRoaXMuaGVhZGVycyA9IHt9O1xuICBmb3IgKHZhciBrZXkgaW4gaGVhZGVycykge1xuICAgIHRoaXMuaGVhZGVyc1trZXkudG9Mb3dlckNhc2UoKV0gPSBoZWFkZXJzW2tleV07XG4gIH1cbiAgdGhpcy5ib2R5ID0gYm9keTtcbiAgdGhpcy51cmwgPSB1cmw7XG59XG5cblJlc3BvbnNlLnByb3RvdHlwZS5nZXRCb2R5ID0gZnVuY3Rpb24gKGVuY29kaW5nKSB7XG4gIGlmICh0aGlzLnN0YXR1c0NvZGUgPj0gMzAwKSB7XG4gICAgdmFyIGVyciA9IG5ldyBFcnJvcignU2VydmVyIHJlc3BvbmRlZCB3aXRoIHN0YXR1cyBjb2RlICdcbiAgICAgICAgICAgICAgICAgICAgKyB0aGlzLnN0YXR1c0NvZGUgKyAnOlxcbicgKyB0aGlzLmJvZHkudG9TdHJpbmcoKSk7XG4gICAgZXJyLnN0YXR1c0NvZGUgPSB0aGlzLnN0YXR1c0NvZGU7XG4gICAgZXJyLmhlYWRlcnMgPSB0aGlzLmhlYWRlcnM7XG4gICAgZXJyLmJvZHkgPSB0aGlzLmJvZHk7XG4gICAgZXJyLnVybCA9IHRoaXMudXJsO1xuICAgIHRocm93IGVycjtcbiAgfVxuICByZXR1cm4gZW5jb2RpbmcgPyB0aGlzLmJvZHkudG9TdHJpbmcoZW5jb2RpbmcpIDogdGhpcy5ib2R5O1xufTtcbiIsIihmdW5jdGlvbihkZWZpbml0aW9uKXtpZih0eXBlb2YgZXhwb3J0cz09PVwib2JqZWN0XCIpe21vZHVsZS5leHBvcnRzPWRlZmluaXRpb24oKTt9ZWxzZSBpZih0eXBlb2YgZGVmaW5lPT09XCJmdW5jdGlvblwiJiZkZWZpbmUuYW1kKXtkZWZpbmUoZGVmaW5pdGlvbik7fWVsc2V7bW9yaT1kZWZpbml0aW9uKCk7fX0pKGZ1bmN0aW9uKCl7cmV0dXJuIGZ1bmN0aW9uKCl7XG5pZih0eXBlb2YgTWF0aC5pbXVsID09IFwidW5kZWZpbmVkXCIgfHwgKE1hdGguaW11bCgweGZmZmZmZmZmLDUpID09IDApKSB7XG4gICAgTWF0aC5pbXVsID0gZnVuY3Rpb24gKGEsIGIpIHtcbiAgICAgICAgdmFyIGFoICA9IChhID4+PiAxNikgJiAweGZmZmY7XG4gICAgICAgIHZhciBhbCA9IGEgJiAweGZmZmY7XG4gICAgICAgIHZhciBiaCAgPSAoYiA+Pj4gMTYpICYgMHhmZmZmO1xuICAgICAgICB2YXIgYmwgPSBiICYgMHhmZmZmO1xuICAgICAgICAvLyB0aGUgc2hpZnQgYnkgMCBmaXhlcyB0aGUgc2lnbiBvbiB0aGUgaGlnaCBwYXJ0XG4gICAgICAgIC8vIHRoZSBmaW5hbCB8MCBjb252ZXJ0cyB0aGUgdW5zaWduZWQgdmFsdWUgaW50byBhIHNpZ25lZCB2YWx1ZVxuICAgICAgICByZXR1cm4gKChhbCAqIGJsKSArICgoKGFoICogYmwgKyBhbCAqIGJoKSA8PCAxNikgPj4+IDApfDApO1xuICAgIH1cbn1cblxudmFyIGssYWE9dGhpcztcbmZ1bmN0aW9uIG4oYSl7dmFyIGI9dHlwZW9mIGE7aWYoXCJvYmplY3RcIj09YilpZihhKXtpZihhIGluc3RhbmNlb2YgQXJyYXkpcmV0dXJuXCJhcnJheVwiO2lmKGEgaW5zdGFuY2VvZiBPYmplY3QpcmV0dXJuIGI7dmFyIGM9T2JqZWN0LnByb3RvdHlwZS50b1N0cmluZy5jYWxsKGEpO2lmKFwiW29iamVjdCBXaW5kb3ddXCI9PWMpcmV0dXJuXCJvYmplY3RcIjtpZihcIltvYmplY3QgQXJyYXldXCI9PWN8fFwibnVtYmVyXCI9PXR5cGVvZiBhLmxlbmd0aCYmXCJ1bmRlZmluZWRcIiE9dHlwZW9mIGEuc3BsaWNlJiZcInVuZGVmaW5lZFwiIT10eXBlb2YgYS5wcm9wZXJ0eUlzRW51bWVyYWJsZSYmIWEucHJvcGVydHlJc0VudW1lcmFibGUoXCJzcGxpY2VcIikpcmV0dXJuXCJhcnJheVwiO2lmKFwiW29iamVjdCBGdW5jdGlvbl1cIj09Y3x8XCJ1bmRlZmluZWRcIiE9dHlwZW9mIGEuY2FsbCYmXCJ1bmRlZmluZWRcIiE9dHlwZW9mIGEucHJvcGVydHlJc0VudW1lcmFibGUmJiFhLnByb3BlcnR5SXNFbnVtZXJhYmxlKFwiY2FsbFwiKSlyZXR1cm5cImZ1bmN0aW9uXCJ9ZWxzZSByZXR1cm5cIm51bGxcIjtlbHNlIGlmKFwiZnVuY3Rpb25cIj09XG5iJiZcInVuZGVmaW5lZFwiPT10eXBlb2YgYS5jYWxsKXJldHVyblwib2JqZWN0XCI7cmV0dXJuIGJ9dmFyIGJhPVwiY2xvc3VyZV91aWRfXCIrKDFFOSpNYXRoLnJhbmRvbSgpPj4+MCksY2E9MDtmdW5jdGlvbiByKGEsYil7dmFyIGM9YS5zcGxpdChcIi5cIiksZD1hYTtjWzBdaW4gZHx8IWQuZXhlY1NjcmlwdHx8ZC5leGVjU2NyaXB0KFwidmFyIFwiK2NbMF0pO2Zvcih2YXIgZTtjLmxlbmd0aCYmKGU9Yy5zaGlmdCgpKTspYy5sZW5ndGh8fHZvaWQgMD09PWI/ZD1kW2VdP2RbZV06ZFtlXT17fTpkW2VdPWJ9O2Z1bmN0aW9uIGRhKGEpe3JldHVybiBBcnJheS5wcm90b3R5cGUuam9pbi5jYWxsKGFyZ3VtZW50cyxcIlwiKX07ZnVuY3Rpb24gZWEoYSxiKXtmb3IodmFyIGMgaW4gYSliLmNhbGwodm9pZCAwLGFbY10sYyxhKX07ZnVuY3Rpb24gZmEoYSxiKXtudWxsIT1hJiZ0aGlzLmFwcGVuZC5hcHBseSh0aGlzLGFyZ3VtZW50cyl9ZmEucHJvdG90eXBlLlphPVwiXCI7ZmEucHJvdG90eXBlLmFwcGVuZD1mdW5jdGlvbihhLGIsYyl7dGhpcy5aYSs9YTtpZihudWxsIT1iKWZvcih2YXIgZD0xO2Q8YXJndW1lbnRzLmxlbmd0aDtkKyspdGhpcy5aYSs9YXJndW1lbnRzW2RdO3JldHVybiB0aGlzfTtmYS5wcm90b3R5cGUuY2xlYXI9ZnVuY3Rpb24oKXt0aGlzLlphPVwiXCJ9O2ZhLnByb3RvdHlwZS50b1N0cmluZz1mdW5jdGlvbigpe3JldHVybiB0aGlzLlphfTtmdW5jdGlvbiBnYShhLGIpe2Euc29ydChifHxoYSl9ZnVuY3Rpb24gaWEoYSxiKXtmb3IodmFyIGM9MDtjPGEubGVuZ3RoO2MrKylhW2NdPXtpbmRleDpjLHZhbHVlOmFbY119O3ZhciBkPWJ8fGhhO2dhKGEsZnVuY3Rpb24oYSxiKXtyZXR1cm4gZChhLnZhbHVlLGIudmFsdWUpfHxhLmluZGV4LWIuaW5kZXh9KTtmb3IoYz0wO2M8YS5sZW5ndGg7YysrKWFbY109YVtjXS52YWx1ZX1mdW5jdGlvbiBoYShhLGIpe3JldHVybiBhPmI/MTphPGI/LTE6MH07dmFyIGphO2lmKFwidW5kZWZpbmVkXCI9PT10eXBlb2Yga2EpdmFyIGthPWZ1bmN0aW9uKCl7dGhyb3cgRXJyb3IoXCJObyAqcHJpbnQtZm4qIGZuIHNldCBmb3IgZXZhbHVhdGlvbiBlbnZpcm9ubWVudFwiKTt9O3ZhciBsYT1udWxsLG1hPW51bGw7aWYoXCJ1bmRlZmluZWRcIj09PXR5cGVvZiBuYSl2YXIgbmE9bnVsbDtmdW5jdGlvbiBvYSgpe3JldHVybiBuZXcgcGEobnVsbCw1LFtzYSwhMCx1YSwhMCx3YSwhMSx5YSwhMSx6YSxsYV0sbnVsbCl9ZnVuY3Rpb24gdChhKXtyZXR1cm4gbnVsbCE9YSYmITEhPT1hfWZ1bmN0aW9uIEFhKGEpe3JldHVybiB0KGEpPyExOiEwfWZ1bmN0aW9uIHcoYSxiKXtyZXR1cm4gYVtuKG51bGw9PWI/bnVsbDpiKV0/ITA6YS5fPyEwOiExfWZ1bmN0aW9uIEJhKGEpe3JldHVybiBudWxsPT1hP251bGw6YS5jb25zdHJ1Y3Rvcn1cbmZ1bmN0aW9uIHgoYSxiKXt2YXIgYz1CYShiKSxjPXQodChjKT9jLlliOmMpP2MuWGI6bihiKTtyZXR1cm4gRXJyb3IoW1wiTm8gcHJvdG9jb2wgbWV0aG9kIFwiLGEsXCIgZGVmaW5lZCBmb3IgdHlwZSBcIixjLFwiOiBcIixiXS5qb2luKFwiXCIpKX1mdW5jdGlvbiBEYShhKXt2YXIgYj1hLlhiO3JldHVybiB0KGIpP2I6XCJcIit6KGEpfXZhciBFYT1cInVuZGVmaW5lZFwiIT09dHlwZW9mIFN5bWJvbCYmXCJmdW5jdGlvblwiPT09bihTeW1ib2wpP1N5bWJvbC5DYzpcIkBAaXRlcmF0b3JcIjtmdW5jdGlvbiBGYShhKXtmb3IodmFyIGI9YS5sZW5ndGgsYz1BcnJheShiKSxkPTA7OylpZihkPGIpY1tkXT1hW2RdLGQrPTE7ZWxzZSBicmVhaztyZXR1cm4gY31mdW5jdGlvbiBIYShhKXtmb3IodmFyIGI9QXJyYXkoYXJndW1lbnRzLmxlbmd0aCksYz0wOzspaWYoYzxiLmxlbmd0aCliW2NdPWFyZ3VtZW50c1tjXSxjKz0xO2Vsc2UgcmV0dXJuIGJ9XG52YXIgSWE9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYil7ZnVuY3Rpb24gYyhhLGIpe2EucHVzaChiKTtyZXR1cm4gYX12YXIgZz1bXTtyZXR1cm4gQS5jP0EuYyhjLGcsYik6QS5jYWxsKG51bGwsYyxnLGIpfWZ1bmN0aW9uIGIoYSl7cmV0dXJuIGMuYShudWxsLGEpfXZhciBjPW51bGwsYz1mdW5jdGlvbihkLGMpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGIuY2FsbCh0aGlzLGQpO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsMCxjKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5iPWI7Yy5hPWE7cmV0dXJuIGN9KCksSmE9e30sTGE9e307ZnVuY3Rpb24gTWEoYSl7aWYoYT9hLkw6YSlyZXR1cm4gYS5MKGEpO3ZhciBiO2I9TWFbbihudWxsPT1hP251bGw6YSldO2lmKCFiJiYoYj1NYS5fLCFiKSl0aHJvdyB4KFwiSUNvdW50ZWQuLWNvdW50XCIsYSk7cmV0dXJuIGIuY2FsbChudWxsLGEpfVxuZnVuY3Rpb24gTmEoYSl7aWYoYT9hLko6YSlyZXR1cm4gYS5KKGEpO3ZhciBiO2I9TmFbbihudWxsPT1hP251bGw6YSldO2lmKCFiJiYoYj1OYS5fLCFiKSl0aHJvdyB4KFwiSUVtcHR5YWJsZUNvbGxlY3Rpb24uLWVtcHR5XCIsYSk7cmV0dXJuIGIuY2FsbChudWxsLGEpfXZhciBRYT17fTtmdW5jdGlvbiBSYShhLGIpe2lmKGE/YS5HOmEpcmV0dXJuIGEuRyhhLGIpO3ZhciBjO2M9UmFbbihudWxsPT1hP251bGw6YSldO2lmKCFjJiYoYz1SYS5fLCFjKSl0aHJvdyB4KFwiSUNvbGxlY3Rpb24uLWNvbmpcIixhKTtyZXR1cm4gYy5jYWxsKG51bGwsYSxiKX1cbnZhciBUYT17fSxDPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyl7aWYoYT9hLiQ6YSlyZXR1cm4gYS4kKGEsYixjKTt2YXIgZztnPUNbbihudWxsPT1hP251bGw6YSldO2lmKCFnJiYoZz1DLl8sIWcpKXRocm93IHgoXCJJSW5kZXhlZC4tbnRoXCIsYSk7cmV0dXJuIGcuY2FsbChudWxsLGEsYixjKX1mdW5jdGlvbiBiKGEsYil7aWYoYT9hLlE6YSlyZXR1cm4gYS5RKGEsYik7dmFyIGM7Yz1DW24obnVsbD09YT9udWxsOmEpXTtpZighYyYmKGM9Qy5fLCFjKSl0aHJvdyB4KFwiSUluZGV4ZWQuLW50aFwiLGEpO3JldHVybiBjLmNhbGwobnVsbCxhLGIpfXZhciBjPW51bGwsYz1mdW5jdGlvbihkLGMsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gYi5jYWxsKHRoaXMsZCxjKTtjYXNlIDM6cmV0dXJuIGEuY2FsbCh0aGlzLGQsYyxmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5hPWI7Yy5jPWE7cmV0dXJuIGN9KCksXG5VYT17fTtmdW5jdGlvbiBWYShhKXtpZihhP2EuTjphKXJldHVybiBhLk4oYSk7dmFyIGI7Yj1WYVtuKG51bGw9PWE/bnVsbDphKV07aWYoIWImJihiPVZhLl8sIWIpKXRocm93IHgoXCJJU2VxLi1maXJzdFwiLGEpO3JldHVybiBiLmNhbGwobnVsbCxhKX1mdW5jdGlvbiBXYShhKXtpZihhP2EuUzphKXJldHVybiBhLlMoYSk7dmFyIGI7Yj1XYVtuKG51bGw9PWE/bnVsbDphKV07aWYoIWImJihiPVdhLl8sIWIpKXRocm93IHgoXCJJU2VxLi1yZXN0XCIsYSk7cmV0dXJuIGIuY2FsbChudWxsLGEpfVxudmFyIFhhPXt9LFphPXt9LCRhPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyl7aWYoYT9hLnM6YSlyZXR1cm4gYS5zKGEsYixjKTt2YXIgZztnPSRhW24obnVsbD09YT9udWxsOmEpXTtpZighZyYmKGc9JGEuXywhZykpdGhyb3cgeChcIklMb29rdXAuLWxvb2t1cFwiLGEpO3JldHVybiBnLmNhbGwobnVsbCxhLGIsYyl9ZnVuY3Rpb24gYihhLGIpe2lmKGE/YS50OmEpcmV0dXJuIGEudChhLGIpO3ZhciBjO2M9JGFbbihudWxsPT1hP251bGw6YSldO2lmKCFjJiYoYz0kYS5fLCFjKSl0aHJvdyB4KFwiSUxvb2t1cC4tbG9va3VwXCIsYSk7cmV0dXJuIGMuY2FsbChudWxsLGEsYil9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiBiLmNhbGwodGhpcyxjLGUpO2Nhc2UgMzpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmE9YjtjLmM9XG5hO3JldHVybiBjfSgpLGFiPXt9O2Z1bmN0aW9uIGJiKGEsYil7aWYoYT9hLnJiOmEpcmV0dXJuIGEucmIoYSxiKTt2YXIgYztjPWJiW24obnVsbD09YT9udWxsOmEpXTtpZighYyYmKGM9YmIuXywhYykpdGhyb3cgeChcIklBc3NvY2lhdGl2ZS4tY29udGFpbnMta2V5P1wiLGEpO3JldHVybiBjLmNhbGwobnVsbCxhLGIpfWZ1bmN0aW9uIGNiKGEsYixjKXtpZihhP2EuS2E6YSlyZXR1cm4gYS5LYShhLGIsYyk7dmFyIGQ7ZD1jYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWQmJihkPWNiLl8sIWQpKXRocm93IHgoXCJJQXNzb2NpYXRpdmUuLWFzc29jXCIsYSk7cmV0dXJuIGQuY2FsbChudWxsLGEsYixjKX12YXIgZGI9e307ZnVuY3Rpb24gZWIoYSxiKXtpZihhP2Eud2I6YSlyZXR1cm4gYS53YihhLGIpO3ZhciBjO2M9ZWJbbihudWxsPT1hP251bGw6YSldO2lmKCFjJiYoYz1lYi5fLCFjKSl0aHJvdyB4KFwiSU1hcC4tZGlzc29jXCIsYSk7cmV0dXJuIGMuY2FsbChudWxsLGEsYil9dmFyIGZiPXt9O1xuZnVuY3Rpb24gaGIoYSl7aWYoYT9hLmhiOmEpcmV0dXJuIGEuaGIoYSk7dmFyIGI7Yj1oYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWImJihiPWhiLl8sIWIpKXRocm93IHgoXCJJTWFwRW50cnkuLWtleVwiLGEpO3JldHVybiBiLmNhbGwobnVsbCxhKX1mdW5jdGlvbiBpYihhKXtpZihhP2EuaWI6YSlyZXR1cm4gYS5pYihhKTt2YXIgYjtiPWliW24obnVsbD09YT9udWxsOmEpXTtpZighYiYmKGI9aWIuXywhYikpdGhyb3cgeChcIklNYXBFbnRyeS4tdmFsXCIsYSk7cmV0dXJuIGIuY2FsbChudWxsLGEpfXZhciBqYj17fTtmdW5jdGlvbiBrYihhLGIpe2lmKGE/YS5FYjphKXJldHVybiBhLkViKGEsYik7dmFyIGM7Yz1rYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWMmJihjPWtiLl8sIWMpKXRocm93IHgoXCJJU2V0Li1kaXNqb2luXCIsYSk7cmV0dXJuIGMuY2FsbChudWxsLGEsYil9XG5mdW5jdGlvbiBsYihhKXtpZihhP2EuTGE6YSlyZXR1cm4gYS5MYShhKTt2YXIgYjtiPWxiW24obnVsbD09YT9udWxsOmEpXTtpZighYiYmKGI9bGIuXywhYikpdGhyb3cgeChcIklTdGFjay4tcGVla1wiLGEpO3JldHVybiBiLmNhbGwobnVsbCxhKX1mdW5jdGlvbiBtYihhKXtpZihhP2EuTWE6YSlyZXR1cm4gYS5NYShhKTt2YXIgYjtiPW1iW24obnVsbD09YT9udWxsOmEpXTtpZighYiYmKGI9bWIuXywhYikpdGhyb3cgeChcIklTdGFjay4tcG9wXCIsYSk7cmV0dXJuIGIuY2FsbChudWxsLGEpfXZhciBuYj17fTtmdW5jdGlvbiBwYihhLGIsYyl7aWYoYT9hLlVhOmEpcmV0dXJuIGEuVWEoYSxiLGMpO3ZhciBkO2Q9cGJbbihudWxsPT1hP251bGw6YSldO2lmKCFkJiYoZD1wYi5fLCFkKSl0aHJvdyB4KFwiSVZlY3Rvci4tYXNzb2MtblwiLGEpO3JldHVybiBkLmNhbGwobnVsbCxhLGIsYyl9XG5mdW5jdGlvbiBxYihhKXtpZihhP2EuUmE6YSlyZXR1cm4gYS5SYShhKTt2YXIgYjtiPXFiW24obnVsbD09YT9udWxsOmEpXTtpZighYiYmKGI9cWIuXywhYikpdGhyb3cgeChcIklEZXJlZi4tZGVyZWZcIixhKTtyZXR1cm4gYi5jYWxsKG51bGwsYSl9dmFyIHJiPXt9O2Z1bmN0aW9uIHNiKGEpe2lmKGE/YS5IOmEpcmV0dXJuIGEuSChhKTt2YXIgYjtiPXNiW24obnVsbD09YT9udWxsOmEpXTtpZighYiYmKGI9c2IuXywhYikpdGhyb3cgeChcIklNZXRhLi1tZXRhXCIsYSk7cmV0dXJuIGIuY2FsbChudWxsLGEpfXZhciB0Yj17fTtmdW5jdGlvbiB1YihhLGIpe2lmKGE/YS5GOmEpcmV0dXJuIGEuRihhLGIpO3ZhciBjO2M9dWJbbihudWxsPT1hP251bGw6YSldO2lmKCFjJiYoYz11Yi5fLCFjKSl0aHJvdyB4KFwiSVdpdGhNZXRhLi13aXRoLW1ldGFcIixhKTtyZXR1cm4gYy5jYWxsKG51bGwsYSxiKX1cbnZhciB2Yj17fSx3Yj1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMpe2lmKGE/YS5POmEpcmV0dXJuIGEuTyhhLGIsYyk7dmFyIGc7Zz13YltuKG51bGw9PWE/bnVsbDphKV07aWYoIWcmJihnPXdiLl8sIWcpKXRocm93IHgoXCJJUmVkdWNlLi1yZWR1Y2VcIixhKTtyZXR1cm4gZy5jYWxsKG51bGwsYSxiLGMpfWZ1bmN0aW9uIGIoYSxiKXtpZihhP2EuUjphKXJldHVybiBhLlIoYSxiKTt2YXIgYztjPXdiW24obnVsbD09YT9udWxsOmEpXTtpZighYyYmKGM9d2IuXywhYykpdGhyb3cgeChcIklSZWR1Y2UuLXJlZHVjZVwiLGEpO3JldHVybiBjLmNhbGwobnVsbCxhLGIpfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gYi5jYWxsKHRoaXMsYyxlKTtjYXNlIDM6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSxmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5hPWI7Yy5jPWE7cmV0dXJuIGN9KCk7XG5mdW5jdGlvbiB4YihhLGIsYyl7aWYoYT9hLmdiOmEpcmV0dXJuIGEuZ2IoYSxiLGMpO3ZhciBkO2Q9eGJbbihudWxsPT1hP251bGw6YSldO2lmKCFkJiYoZD14Yi5fLCFkKSl0aHJvdyB4KFwiSUtWUmVkdWNlLi1rdi1yZWR1Y2VcIixhKTtyZXR1cm4gZC5jYWxsKG51bGwsYSxiLGMpfWZ1bmN0aW9uIHliKGEsYil7aWYoYT9hLkE6YSlyZXR1cm4gYS5BKGEsYik7dmFyIGM7Yz15YltuKG51bGw9PWE/bnVsbDphKV07aWYoIWMmJihjPXliLl8sIWMpKXRocm93IHgoXCJJRXF1aXYuLWVxdWl2XCIsYSk7cmV0dXJuIGMuY2FsbChudWxsLGEsYil9ZnVuY3Rpb24gemIoYSl7aWYoYT9hLkI6YSlyZXR1cm4gYS5CKGEpO3ZhciBiO2I9emJbbihudWxsPT1hP251bGw6YSldO2lmKCFiJiYoYj16Yi5fLCFiKSl0aHJvdyB4KFwiSUhhc2guLWhhc2hcIixhKTtyZXR1cm4gYi5jYWxsKG51bGwsYSl9dmFyIEJiPXt9O1xuZnVuY3Rpb24gQ2IoYSl7aWYoYT9hLkQ6YSlyZXR1cm4gYS5EKGEpO3ZhciBiO2I9Q2JbbihudWxsPT1hP251bGw6YSldO2lmKCFiJiYoYj1DYi5fLCFiKSl0aHJvdyB4KFwiSVNlcWFibGUuLXNlcVwiLGEpO3JldHVybiBiLmNhbGwobnVsbCxhKX12YXIgRGI9e30sRWI9e30sRmI9e307ZnVuY3Rpb24gR2IoYSl7aWYoYT9hLmFiOmEpcmV0dXJuIGEuYWIoYSk7dmFyIGI7Yj1HYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWImJihiPUdiLl8sIWIpKXRocm93IHgoXCJJUmV2ZXJzaWJsZS4tcnNlcVwiLGEpO3JldHVybiBiLmNhbGwobnVsbCxhKX1mdW5jdGlvbiBIYihhLGIpe2lmKGE/YS5IYjphKXJldHVybiBhLkhiKGEsYik7dmFyIGM7Yz1IYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWMmJihjPUhiLl8sIWMpKXRocm93IHgoXCJJU29ydGVkLi1zb3J0ZWQtc2VxXCIsYSk7cmV0dXJuIGMuY2FsbChudWxsLGEsYil9XG5mdW5jdGlvbiBJYihhLGIsYyl7aWYoYT9hLkliOmEpcmV0dXJuIGEuSWIoYSxiLGMpO3ZhciBkO2Q9SWJbbihudWxsPT1hP251bGw6YSldO2lmKCFkJiYoZD1JYi5fLCFkKSl0aHJvdyB4KFwiSVNvcnRlZC4tc29ydGVkLXNlcS1mcm9tXCIsYSk7cmV0dXJuIGQuY2FsbChudWxsLGEsYixjKX1mdW5jdGlvbiBKYihhLGIpe2lmKGE/YS5HYjphKXJldHVybiBhLkdiKGEsYik7dmFyIGM7Yz1KYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWMmJihjPUpiLl8sIWMpKXRocm93IHgoXCJJU29ydGVkLi1lbnRyeS1rZXlcIixhKTtyZXR1cm4gYy5jYWxsKG51bGwsYSxiKX1mdW5jdGlvbiBLYihhKXtpZihhP2EuRmI6YSlyZXR1cm4gYS5GYihhKTt2YXIgYjtiPUtiW24obnVsbD09YT9udWxsOmEpXTtpZighYiYmKGI9S2IuXywhYikpdGhyb3cgeChcIklTb3J0ZWQuLWNvbXBhcmF0b3JcIixhKTtyZXR1cm4gYi5jYWxsKG51bGwsYSl9XG5mdW5jdGlvbiBMYihhLGIpe2lmKGE/YS5XYjphKXJldHVybiBhLldiKDAsYik7dmFyIGM7Yz1MYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWMmJihjPUxiLl8sIWMpKXRocm93IHgoXCJJV3JpdGVyLi13cml0ZVwiLGEpO3JldHVybiBjLmNhbGwobnVsbCxhLGIpfXZhciBNYj17fTtmdW5jdGlvbiBOYihhLGIsYyl7aWYoYT9hLnY6YSlyZXR1cm4gYS52KGEsYixjKTt2YXIgZDtkPU5iW24obnVsbD09YT9udWxsOmEpXTtpZighZCYmKGQ9TmIuXywhZCkpdGhyb3cgeChcIklQcmludFdpdGhXcml0ZXIuLXByLXdyaXRlclwiLGEpO3JldHVybiBkLmNhbGwobnVsbCxhLGIsYyl9ZnVuY3Rpb24gT2IoYSl7aWYoYT9hLiRhOmEpcmV0dXJuIGEuJGEoYSk7dmFyIGI7Yj1PYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWImJihiPU9iLl8sIWIpKXRocm93IHgoXCJJRWRpdGFibGVDb2xsZWN0aW9uLi1hcy10cmFuc2llbnRcIixhKTtyZXR1cm4gYi5jYWxsKG51bGwsYSl9XG5mdW5jdGlvbiBQYihhLGIpe2lmKGE/YS5TYTphKXJldHVybiBhLlNhKGEsYik7dmFyIGM7Yz1QYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWMmJihjPVBiLl8sIWMpKXRocm93IHgoXCJJVHJhbnNpZW50Q29sbGVjdGlvbi4tY29uaiFcIixhKTtyZXR1cm4gYy5jYWxsKG51bGwsYSxiKX1mdW5jdGlvbiBRYihhKXtpZihhP2EuVGE6YSlyZXR1cm4gYS5UYShhKTt2YXIgYjtiPVFiW24obnVsbD09YT9udWxsOmEpXTtpZighYiYmKGI9UWIuXywhYikpdGhyb3cgeChcIklUcmFuc2llbnRDb2xsZWN0aW9uLi1wZXJzaXN0ZW50IVwiLGEpO3JldHVybiBiLmNhbGwobnVsbCxhKX1mdW5jdGlvbiBSYihhLGIsYyl7aWYoYT9hLmtiOmEpcmV0dXJuIGEua2IoYSxiLGMpO3ZhciBkO2Q9UmJbbihudWxsPT1hP251bGw6YSldO2lmKCFkJiYoZD1SYi5fLCFkKSl0aHJvdyB4KFwiSVRyYW5zaWVudEFzc29jaWF0aXZlLi1hc3NvYyFcIixhKTtyZXR1cm4gZC5jYWxsKG51bGwsYSxiLGMpfVxuZnVuY3Rpb24gU2IoYSxiKXtpZihhP2EuSmI6YSlyZXR1cm4gYS5KYihhLGIpO3ZhciBjO2M9U2JbbihudWxsPT1hP251bGw6YSldO2lmKCFjJiYoYz1TYi5fLCFjKSl0aHJvdyB4KFwiSVRyYW5zaWVudE1hcC4tZGlzc29jIVwiLGEpO3JldHVybiBjLmNhbGwobnVsbCxhLGIpfWZ1bmN0aW9uIFRiKGEsYixjKXtpZihhP2EuVWI6YSlyZXR1cm4gYS5VYigwLGIsYyk7dmFyIGQ7ZD1UYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWQmJihkPVRiLl8sIWQpKXRocm93IHgoXCJJVHJhbnNpZW50VmVjdG9yLi1hc3NvYy1uIVwiLGEpO3JldHVybiBkLmNhbGwobnVsbCxhLGIsYyl9ZnVuY3Rpb24gVWIoYSl7aWYoYT9hLlZiOmEpcmV0dXJuIGEuVmIoKTt2YXIgYjtiPVViW24obnVsbD09YT9udWxsOmEpXTtpZighYiYmKGI9VWIuXywhYikpdGhyb3cgeChcIklUcmFuc2llbnRWZWN0b3IuLXBvcCFcIixhKTtyZXR1cm4gYi5jYWxsKG51bGwsYSl9XG5mdW5jdGlvbiBWYihhLGIpe2lmKGE/YS5UYjphKXJldHVybiBhLlRiKDAsYik7dmFyIGM7Yz1WYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWMmJihjPVZiLl8sIWMpKXRocm93IHgoXCJJVHJhbnNpZW50U2V0Li1kaXNqb2luIVwiLGEpO3JldHVybiBjLmNhbGwobnVsbCxhLGIpfWZ1bmN0aW9uIFhiKGEpe2lmKGE/YS5QYjphKXJldHVybiBhLlBiKCk7dmFyIGI7Yj1YYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWImJihiPVhiLl8sIWIpKXRocm93IHgoXCJJQ2h1bmsuLWRyb3AtZmlyc3RcIixhKTtyZXR1cm4gYi5jYWxsKG51bGwsYSl9ZnVuY3Rpb24gWWIoYSl7aWYoYT9hLkNiOmEpcmV0dXJuIGEuQ2IoYSk7dmFyIGI7Yj1ZYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWImJihiPVliLl8sIWIpKXRocm93IHgoXCJJQ2h1bmtlZFNlcS4tY2h1bmtlZC1maXJzdFwiLGEpO3JldHVybiBiLmNhbGwobnVsbCxhKX1cbmZ1bmN0aW9uIFpiKGEpe2lmKGE/YS5EYjphKXJldHVybiBhLkRiKGEpO3ZhciBiO2I9WmJbbihudWxsPT1hP251bGw6YSldO2lmKCFiJiYoYj1aYi5fLCFiKSl0aHJvdyB4KFwiSUNodW5rZWRTZXEuLWNodW5rZWQtcmVzdFwiLGEpO3JldHVybiBiLmNhbGwobnVsbCxhKX1mdW5jdGlvbiAkYihhKXtpZihhP2EuQmI6YSlyZXR1cm4gYS5CYihhKTt2YXIgYjtiPSRiW24obnVsbD09YT9udWxsOmEpXTtpZighYiYmKGI9JGIuXywhYikpdGhyb3cgeChcIklDaHVua2VkTmV4dC4tY2h1bmtlZC1uZXh0XCIsYSk7cmV0dXJuIGIuY2FsbChudWxsLGEpfWZ1bmN0aW9uIGFjKGEsYil7aWYoYT9hLmJiOmEpcmV0dXJuIGEuYmIoMCxiKTt2YXIgYztjPWFjW24obnVsbD09YT9udWxsOmEpXTtpZighYyYmKGM9YWMuXywhYykpdGhyb3cgeChcIklWb2xhdGlsZS4tdnJlc2V0IVwiLGEpO3JldHVybiBjLmNhbGwobnVsbCxhLGIpfXZhciBiYz17fTtcbmZ1bmN0aW9uIGNjKGEpe2lmKGE/YS5mYjphKXJldHVybiBhLmZiKGEpO3ZhciBiO2I9Y2NbbihudWxsPT1hP251bGw6YSldO2lmKCFiJiYoYj1jYy5fLCFiKSl0aHJvdyB4KFwiSUl0ZXJhYmxlLi1pdGVyYXRvclwiLGEpO3JldHVybiBiLmNhbGwobnVsbCxhKX1mdW5jdGlvbiBkYyhhKXt0aGlzLnFjPWE7dGhpcy5xPTA7dGhpcy5qPTEwNzM3NDE4MjR9ZGMucHJvdG90eXBlLldiPWZ1bmN0aW9uKGEsYil7cmV0dXJuIHRoaXMucWMuYXBwZW5kKGIpfTtmdW5jdGlvbiBlYyhhKXt2YXIgYj1uZXcgZmE7YS52KG51bGwsbmV3IGRjKGIpLG9hKCkpO3JldHVyblwiXCIreihiKX1cbnZhciBmYz1cInVuZGVmaW5lZFwiIT09dHlwZW9mIE1hdGguaW11bCYmMCE9PShNYXRoLmltdWwuYT9NYXRoLmltdWwuYSg0Mjk0OTY3Mjk1LDUpOk1hdGguaW11bC5jYWxsKG51bGwsNDI5NDk2NzI5NSw1KSk/ZnVuY3Rpb24oYSxiKXtyZXR1cm4gTWF0aC5pbXVsLmE/TWF0aC5pbXVsLmEoYSxiKTpNYXRoLmltdWwuY2FsbChudWxsLGEsYil9OmZ1bmN0aW9uKGEsYil7dmFyIGM9YSY2NTUzNSxkPWImNjU1MzU7cmV0dXJuIGMqZCsoKGE+Pj4xNiY2NTUzNSkqZCtjKihiPj4+MTYmNjU1MzUpPDwxNj4+PjApfDB9O2Z1bmN0aW9uIGdjKGEpe2E9ZmMoYSwzNDMyOTE4MzUzKTtyZXR1cm4gZmMoYTw8MTV8YT4+Pi0xNSw0NjE4NDU5MDcpfWZ1bmN0aW9uIGhjKGEsYil7dmFyIGM9YV5iO3JldHVybiBmYyhjPDwxM3xjPj4+LTEzLDUpKzM4NjQyOTIxOTZ9XG5mdW5jdGlvbiBpYyhhLGIpe3ZhciBjPWFeYixjPWZjKGNeYz4+PjE2LDIyNDY4MjI1MDcpLGM9ZmMoY15jPj4+MTMsMzI2NjQ4OTkwOSk7cmV0dXJuIGNeYz4+PjE2fXZhciBrYz17fSxsYz0wO2Z1bmN0aW9uIG1jKGEpezI1NTxsYyYmKGtjPXt9LGxjPTApO3ZhciBiPWtjW2FdO2lmKFwibnVtYmVyXCIhPT10eXBlb2YgYil7YTppZihudWxsIT1hKWlmKGI9YS5sZW5ndGgsMDxiKXtmb3IodmFyIGM9MCxkPTA7OylpZihjPGIpdmFyIGU9YysxLGQ9ZmMoMzEsZCkrYS5jaGFyQ29kZUF0KGMpLGM9ZTtlbHNle2I9ZDticmVhayBhfWI9dm9pZCAwfWVsc2UgYj0wO2Vsc2UgYj0wO2tjW2FdPWI7bGMrPTF9cmV0dXJuIGE9Yn1cbmZ1bmN0aW9uIG5jKGEpe2EmJihhLmomNDE5NDMwNHx8YS52Yyk/YT1hLkIobnVsbCk6XCJudW1iZXJcIj09PXR5cGVvZiBhP2E9KE1hdGguZmxvb3IuYj9NYXRoLmZsb29yLmIoYSk6TWF0aC5mbG9vci5jYWxsKG51bGwsYSkpJTIxNDc0ODM2NDc6ITA9PT1hP2E9MTohMT09PWE/YT0wOlwic3RyaW5nXCI9PT10eXBlb2YgYT8oYT1tYyhhKSwwIT09YSYmKGE9Z2MoYSksYT1oYygwLGEpLGE9aWMoYSw0KSkpOmE9YSBpbnN0YW5jZW9mIERhdGU/YS52YWx1ZU9mKCk6bnVsbD09YT8wOnpiKGEpO3JldHVybiBhfVxuZnVuY3Rpb24gb2MoYSl7dmFyIGI7Yj1hLm5hbWU7dmFyIGM7YTp7Yz0xO2Zvcih2YXIgZD0wOzspaWYoYzxiLmxlbmd0aCl7dmFyIGU9YysyLGQ9aGMoZCxnYyhiLmNoYXJDb2RlQXQoYy0xKXxiLmNoYXJDb2RlQXQoYyk8PDE2KSk7Yz1lfWVsc2V7Yz1kO2JyZWFrIGF9Yz12b2lkIDB9Yz0xPT09KGIubGVuZ3RoJjEpP2NeZ2MoYi5jaGFyQ29kZUF0KGIubGVuZ3RoLTEpKTpjO2I9aWMoYyxmYygyLGIubGVuZ3RoKSk7YT1tYyhhLmJhKTtyZXR1cm4gYl5hKzI2NTQ0MzU3NjkrKGI8PDYpKyhiPj4yKX1mdW5jdGlvbiBwYyhhLGIpe2lmKGEudGE9PT1iLnRhKXJldHVybiAwO3ZhciBjPUFhKGEuYmEpO2lmKHQoYz9iLmJhOmMpKXJldHVybi0xO2lmKHQoYS5iYSkpe2lmKEFhKGIuYmEpKXJldHVybiAxO2M9aGEoYS5iYSxiLmJhKTtyZXR1cm4gMD09PWM/aGEoYS5uYW1lLGIubmFtZSk6Y31yZXR1cm4gaGEoYS5uYW1lLGIubmFtZSl9XG5mdW5jdGlvbiBxYyhhLGIsYyxkLGUpe3RoaXMuYmE9YTt0aGlzLm5hbWU9Yjt0aGlzLnRhPWM7dGhpcy5ZYT1kO3RoaXMuWj1lO3RoaXMuaj0yMTU0MTY4MzIxO3RoaXMucT00MDk2fWs9cWMucHJvdG90eXBlO2sudj1mdW5jdGlvbihhLGIpe3JldHVybiBMYihiLHRoaXMudGEpfTtrLkI9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLllhO3JldHVybiBudWxsIT1hP2E6dGhpcy5ZYT1hPW9jKHRoaXMpfTtrLkY9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IHFjKHRoaXMuYmEsdGhpcy5uYW1lLHRoaXMudGEsdGhpcy5ZYSxiKX07ay5IPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuWn07XG5rLmNhbGw9ZnVuY3Rpb24oKXt2YXIgYT1udWxsLGE9ZnVuY3Rpb24oYSxjLGQpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuICRhLmMoYyx0aGlzLG51bGwpO2Nhc2UgMzpyZXR1cm4gJGEuYyhjLHRoaXMsZCl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2EuYT1mdW5jdGlvbihhLGMpe3JldHVybiAkYS5jKGMsdGhpcyxudWxsKX07YS5jPWZ1bmN0aW9uKGEsYyxkKXtyZXR1cm4gJGEuYyhjLHRoaXMsZCl9O3JldHVybiBhfSgpO2suYXBwbHk9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gdGhpcy5jYWxsLmFwcGx5KHRoaXMsW3RoaXNdLmNvbmNhdChGYShiKSkpfTtrLmI9ZnVuY3Rpb24oYSl7cmV0dXJuICRhLmMoYSx0aGlzLG51bGwpfTtrLmE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gJGEuYyhhLHRoaXMsYil9O2suQT1mdW5jdGlvbihhLGIpe3JldHVybiBiIGluc3RhbmNlb2YgcWM/dGhpcy50YT09PWIudGE6ITF9O1xuay50b1N0cmluZz1mdW5jdGlvbigpe3JldHVybiB0aGlzLnRhfTt2YXIgcmM9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYil7dmFyIGM9bnVsbCE9YT9beihhKSx6KFwiL1wiKSx6KGIpXS5qb2luKFwiXCIpOmI7cmV0dXJuIG5ldyBxYyhhLGIsYyxudWxsLG51bGwpfWZ1bmN0aW9uIGIoYSl7cmV0dXJuIGEgaW5zdGFuY2VvZiBxYz9hOmMuYShudWxsLGEpfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGIuY2FsbCh0aGlzLGMpO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5iPWI7Yy5hPWE7cmV0dXJuIGN9KCk7XG5mdW5jdGlvbiBEKGEpe2lmKG51bGw9PWEpcmV0dXJuIG51bGw7aWYoYSYmKGEuaiY4Mzg4NjA4fHxhLm1jKSlyZXR1cm4gYS5EKG51bGwpO2lmKGEgaW5zdGFuY2VvZiBBcnJheXx8XCJzdHJpbmdcIj09PXR5cGVvZiBhKXJldHVybiAwPT09YS5sZW5ndGg/bnVsbDpuZXcgRihhLDApO2lmKHcoQmIsYSkpcmV0dXJuIENiKGEpO3Rocm93IEVycm9yKFt6KGEpLHooXCIgaXMgbm90IElTZXFhYmxlXCIpXS5qb2luKFwiXCIpKTt9ZnVuY3Rpb24gRyhhKXtpZihudWxsPT1hKXJldHVybiBudWxsO2lmKGEmJihhLmomNjR8fGEuamIpKXJldHVybiBhLk4obnVsbCk7YT1EKGEpO3JldHVybiBudWxsPT1hP251bGw6VmEoYSl9ZnVuY3Rpb24gSChhKXtyZXR1cm4gbnVsbCE9YT9hJiYoYS5qJjY0fHxhLmpiKT9hLlMobnVsbCk6KGE9RChhKSk/V2EoYSk6SjpKfWZ1bmN0aW9uIEsoYSl7cmV0dXJuIG51bGw9PWE/bnVsbDphJiYoYS5qJjEyOHx8YS54Yik/YS5UKG51bGwpOkQoSChhKSl9XG52YXIgc2M9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYil7cmV0dXJuIG51bGw9PWE/bnVsbD09YjphPT09Ynx8eWIoYSxiKX12YXIgYj1udWxsLGM9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGIsZCxoKXt2YXIgbD1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBsPTAsbT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2w8bS5sZW5ndGg7KW1bbF09YXJndW1lbnRzW2wrMl0sKytsO2w9bmV3IEYobSwwKX1yZXR1cm4gYy5jYWxsKHRoaXMsYixkLGwpfWZ1bmN0aW9uIGMoYSxkLGUpe2Zvcig7OylpZihiLmEoYSxkKSlpZihLKGUpKWE9ZCxkPUcoZSksZT1LKGUpO2Vsc2UgcmV0dXJuIGIuYShkLEcoZSkpO2Vsc2UgcmV0dXJuITF9YS5pPTI7YS5mPWZ1bmN0aW9uKGEpe3ZhciBiPUcoYSk7YT1LKGEpO3ZhciBkPUcoYSk7YT1IKGEpO3JldHVybiBjKGIsZCxhKX07YS5kPWM7cmV0dXJuIGF9KCksYj1mdW5jdGlvbihiLGUsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4hMDtcbmNhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYixlKTtkZWZhdWx0OnZhciBnPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGc9MCxoPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7ZzxoLmxlbmd0aDspaFtnXT1hcmd1bWVudHNbZysyXSwrK2c7Zz1uZXcgRihoLDApfXJldHVybiBjLmQoYixlLGcpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtiLmk9MjtiLmY9Yy5mO2IuYj1mdW5jdGlvbigpe3JldHVybiEwfTtiLmE9YTtiLmQ9Yy5kO3JldHVybiBifSgpO2Z1bmN0aW9uIHRjKGEpe3RoaXMuQz1hfXRjLnByb3RvdHlwZS5uZXh0PWZ1bmN0aW9uKCl7aWYobnVsbCE9dGhpcy5DKXt2YXIgYT1HKHRoaXMuQyk7dGhpcy5DPUsodGhpcy5DKTtyZXR1cm57ZG9uZTohMSx2YWx1ZTphfX1yZXR1cm57ZG9uZTohMCx2YWx1ZTpudWxsfX07ZnVuY3Rpb24gdWMoYSl7cmV0dXJuIG5ldyB0YyhEKGEpKX1cbmZ1bmN0aW9uIHZjKGEsYil7dmFyIGM9Z2MoYSksYz1oYygwLGMpO3JldHVybiBpYyhjLGIpfWZ1bmN0aW9uIHdjKGEpe3ZhciBiPTAsYz0xO2ZvcihhPUQoYSk7OylpZihudWxsIT1hKWIrPTEsYz1mYygzMSxjKStuYyhHKGEpKXwwLGE9SyhhKTtlbHNlIHJldHVybiB2YyhjLGIpfWZ1bmN0aW9uIHhjKGEpe3ZhciBiPTAsYz0wO2ZvcihhPUQoYSk7OylpZihudWxsIT1hKWIrPTEsYz1jK25jKEcoYSkpfDAsYT1LKGEpO2Vsc2UgcmV0dXJuIHZjKGMsYil9TGFbXCJudWxsXCJdPSEwO01hW1wibnVsbFwiXT1mdW5jdGlvbigpe3JldHVybiAwfTtEYXRlLnByb3RvdHlwZS5BPWZ1bmN0aW9uKGEsYil7cmV0dXJuIGIgaW5zdGFuY2VvZiBEYXRlJiZ0aGlzLnRvU3RyaW5nKCk9PT1iLnRvU3RyaW5nKCl9O3liLm51bWJlcj1mdW5jdGlvbihhLGIpe3JldHVybiBhPT09Yn07cmJbXCJmdW5jdGlvblwiXT0hMDtzYltcImZ1bmN0aW9uXCJdPWZ1bmN0aW9uKCl7cmV0dXJuIG51bGx9O1xuSmFbXCJmdW5jdGlvblwiXT0hMDt6Yi5fPWZ1bmN0aW9uKGEpe3JldHVybiBhW2JhXXx8KGFbYmFdPSsrY2EpfTtmdW5jdGlvbiB5YyhhKXt0aGlzLm89YTt0aGlzLnE9MDt0aGlzLmo9MzI3Njh9eWMucHJvdG90eXBlLlJhPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMub307ZnVuY3Rpb24gQWMoYSl7cmV0dXJuIGEgaW5zdGFuY2VvZiB5Y31mdW5jdGlvbiBCYyhhKXtyZXR1cm4gQWMoYSk/TC5iP0wuYihhKTpMLmNhbGwobnVsbCxhKTphfWZ1bmN0aW9uIEwoYSl7cmV0dXJuIHFiKGEpfVxudmFyIENjPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyxkKXtmb3IodmFyIGw9TWEoYSk7OylpZihkPGwpe3ZhciBtPUMuYShhLGQpO2M9Yi5hP2IuYShjLG0pOmIuY2FsbChudWxsLGMsbSk7aWYoQWMoYykpcmV0dXJuIHFiKGMpO2QrPTF9ZWxzZSByZXR1cm4gY31mdW5jdGlvbiBiKGEsYixjKXt2YXIgZD1NYShhKSxsPWM7Zm9yKGM9MDs7KWlmKGM8ZCl7dmFyIG09Qy5hKGEsYyksbD1iLmE/Yi5hKGwsbSk6Yi5jYWxsKG51bGwsbCxtKTtpZihBYyhsKSlyZXR1cm4gcWIobCk7Yys9MX1lbHNlIHJldHVybiBsfWZ1bmN0aW9uIGMoYSxiKXt2YXIgYz1NYShhKTtpZigwPT09YylyZXR1cm4gYi5sP2IubCgpOmIuY2FsbChudWxsKTtmb3IodmFyIGQ9Qy5hKGEsMCksbD0xOzspaWYobDxjKXt2YXIgbT1DLmEoYSxsKSxkPWIuYT9iLmEoZCxtKTpiLmNhbGwobnVsbCxkLG0pO2lmKEFjKGQpKXJldHVybiBxYihkKTtsKz0xfWVsc2UgcmV0dXJuIGR9dmFyIGQ9bnVsbCxkPWZ1bmN0aW9uKGQsXG5mLGcsaCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gYy5jYWxsKHRoaXMsZCxmKTtjYXNlIDM6cmV0dXJuIGIuY2FsbCh0aGlzLGQsZixnKTtjYXNlIDQ6cmV0dXJuIGEuY2FsbCh0aGlzLGQsZixnLGgpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtkLmE9YztkLmM9YjtkLm49YTtyZXR1cm4gZH0oKSxEYz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMsZCl7Zm9yKHZhciBsPWEubGVuZ3RoOzspaWYoZDxsKXt2YXIgbT1hW2RdO2M9Yi5hP2IuYShjLG0pOmIuY2FsbChudWxsLGMsbSk7aWYoQWMoYykpcmV0dXJuIHFiKGMpO2QrPTF9ZWxzZSByZXR1cm4gY31mdW5jdGlvbiBiKGEsYixjKXt2YXIgZD1hLmxlbmd0aCxsPWM7Zm9yKGM9MDs7KWlmKGM8ZCl7dmFyIG09YVtjXSxsPWIuYT9iLmEobCxtKTpiLmNhbGwobnVsbCxsLG0pO2lmKEFjKGwpKXJldHVybiBxYihsKTtjKz0xfWVsc2UgcmV0dXJuIGx9ZnVuY3Rpb24gYyhhLFxuYil7dmFyIGM9YS5sZW5ndGg7aWYoMD09PWEubGVuZ3RoKXJldHVybiBiLmw/Yi5sKCk6Yi5jYWxsKG51bGwpO2Zvcih2YXIgZD1hWzBdLGw9MTs7KWlmKGw8Yyl7dmFyIG09YVtsXSxkPWIuYT9iLmEoZCxtKTpiLmNhbGwobnVsbCxkLG0pO2lmKEFjKGQpKXJldHVybiBxYihkKTtsKz0xfWVsc2UgcmV0dXJuIGR9dmFyIGQ9bnVsbCxkPWZ1bmN0aW9uKGQsZixnLGgpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIGMuY2FsbCh0aGlzLGQsZik7Y2FzZSAzOnJldHVybiBiLmNhbGwodGhpcyxkLGYsZyk7Y2FzZSA0OnJldHVybiBhLmNhbGwodGhpcyxkLGYsZyxoKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307ZC5hPWM7ZC5jPWI7ZC5uPWE7cmV0dXJuIGR9KCk7ZnVuY3Rpb24gRWMoYSl7cmV0dXJuIGE/YS5qJjJ8fGEuY2M/ITA6YS5qPyExOncoTGEsYSk6dyhMYSxhKX1cbmZ1bmN0aW9uIEZjKGEpe3JldHVybiBhP2EuaiYxNnx8YS5RYj8hMDphLmo/ITE6dyhUYSxhKTp3KFRhLGEpfWZ1bmN0aW9uIEdjKGEsYil7dGhpcy5lPWE7dGhpcy5tPWJ9R2MucHJvdG90eXBlLmdhPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMubTx0aGlzLmUubGVuZ3RofTtHYy5wcm90b3R5cGUubmV4dD1mdW5jdGlvbigpe3ZhciBhPXRoaXMuZVt0aGlzLm1dO3RoaXMubSs9MTtyZXR1cm4gYX07ZnVuY3Rpb24gRihhLGIpe3RoaXMuZT1hO3RoaXMubT1iO3RoaXMuaj0xNjYxOTk1NTA7dGhpcy5xPTgxOTJ9az1GLnByb3RvdHlwZTtrLnRvU3RyaW5nPWZ1bmN0aW9uKCl7cmV0dXJuIGVjKHRoaXMpfTtrLlE9ZnVuY3Rpb24oYSxiKXt2YXIgYz1iK3RoaXMubTtyZXR1cm4gYzx0aGlzLmUubGVuZ3RoP3RoaXMuZVtjXTpudWxsfTtrLiQ9ZnVuY3Rpb24oYSxiLGMpe2E9Yit0aGlzLm07cmV0dXJuIGE8dGhpcy5lLmxlbmd0aD90aGlzLmVbYV06Y307ay52Yj0hMDtcbmsuZmI9ZnVuY3Rpb24oKXtyZXR1cm4gbmV3IEdjKHRoaXMuZSx0aGlzLm0pfTtrLlQ9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5tKzE8dGhpcy5lLmxlbmd0aD9uZXcgRih0aGlzLmUsdGhpcy5tKzEpOm51bGx9O2suTD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmUubGVuZ3RoLXRoaXMubX07ay5hYj1mdW5jdGlvbigpe3ZhciBhPU1hKHRoaXMpO3JldHVybiAwPGE/bmV3IEhjKHRoaXMsYS0xLG51bGwpOm51bGx9O2suQj1mdW5jdGlvbigpe3JldHVybiB3Yyh0aGlzKX07ay5BPWZ1bmN0aW9uKGEsYil7cmV0dXJuIEljLmE/SWMuYSh0aGlzLGIpOkljLmNhbGwobnVsbCx0aGlzLGIpfTtrLko9ZnVuY3Rpb24oKXtyZXR1cm4gSn07ay5SPWZ1bmN0aW9uKGEsYil7cmV0dXJuIERjLm4odGhpcy5lLGIsdGhpcy5lW3RoaXMubV0sdGhpcy5tKzEpfTtrLk89ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBEYy5uKHRoaXMuZSxiLGMsdGhpcy5tKX07ay5OPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuZVt0aGlzLm1dfTtcbmsuUz1mdW5jdGlvbigpe3JldHVybiB0aGlzLm0rMTx0aGlzLmUubGVuZ3RoP25ldyBGKHRoaXMuZSx0aGlzLm0rMSk6Sn07ay5EPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXN9O2suRz1mdW5jdGlvbihhLGIpe3JldHVybiBNLmE/TS5hKGIsdGhpcyk6TS5jYWxsKG51bGwsYix0aGlzKX07Ri5wcm90b3R5cGVbRWFdPWZ1bmN0aW9uKCl7cmV0dXJuIHVjKHRoaXMpfTtcbnZhciBKYz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiKXtyZXR1cm4gYjxhLmxlbmd0aD9uZXcgRihhLGIpOm51bGx9ZnVuY3Rpb24gYihhKXtyZXR1cm4gYy5hKGEsMCl9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYi5jYWxsKHRoaXMsYyk7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxjLGUpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmI9YjtjLmE9YTtyZXR1cm4gY30oKSxLYz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiKXtyZXR1cm4gSmMuYShhLGIpfWZ1bmN0aW9uIGIoYSl7cmV0dXJuIEpjLmEoYSwwKX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiLmNhbGwodGhpcyxjKTtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIitcbmFyZ3VtZW50cy5sZW5ndGgpO307Yy5iPWI7Yy5hPWE7cmV0dXJuIGN9KCk7ZnVuY3Rpb24gSGMoYSxiLGMpe3RoaXMucWI9YTt0aGlzLm09Yjt0aGlzLms9Yzt0aGlzLmo9MzIzNzQ5OTA7dGhpcy5xPTgxOTJ9az1IYy5wcm90b3R5cGU7ay50b1N0cmluZz1mdW5jdGlvbigpe3JldHVybiBlYyh0aGlzKX07ay5IPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMua307ay5UPWZ1bmN0aW9uKCl7cmV0dXJuIDA8dGhpcy5tP25ldyBIYyh0aGlzLnFiLHRoaXMubS0xLG51bGwpOm51bGx9O2suTD1mdW5jdGlvbigpe3JldHVybiB0aGlzLm0rMX07ay5CPWZ1bmN0aW9uKCl7cmV0dXJuIHdjKHRoaXMpfTtrLkE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gSWMuYT9JYy5hKHRoaXMsYik6SWMuY2FsbChudWxsLHRoaXMsYil9O2suSj1mdW5jdGlvbigpe3ZhciBhPXRoaXMuaztyZXR1cm4gTy5hP08uYShKLGEpOk8uY2FsbChudWxsLEosYSl9O1xuay5SPWZ1bmN0aW9uKGEsYil7cmV0dXJuIFAuYT9QLmEoYix0aGlzKTpQLmNhbGwobnVsbCxiLHRoaXMpfTtrLk89ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBQLmM/UC5jKGIsYyx0aGlzKTpQLmNhbGwobnVsbCxiLGMsdGhpcyl9O2suTj1mdW5jdGlvbigpe3JldHVybiBDLmEodGhpcy5xYix0aGlzLm0pfTtrLlM9ZnVuY3Rpb24oKXtyZXR1cm4gMDx0aGlzLm0/bmV3IEhjKHRoaXMucWIsdGhpcy5tLTEsbnVsbCk6Sn07ay5EPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXN9O2suRj1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgSGModGhpcy5xYix0aGlzLm0sYil9O2suRz1mdW5jdGlvbihhLGIpe3JldHVybiBNLmE/TS5hKGIsdGhpcyk6TS5jYWxsKG51bGwsYix0aGlzKX07SGMucHJvdG90eXBlW0VhXT1mdW5jdGlvbigpe3JldHVybiB1Yyh0aGlzKX07ZnVuY3Rpb24gTGMoYSl7cmV0dXJuIEcoSyhhKSl9eWIuXz1mdW5jdGlvbihhLGIpe3JldHVybiBhPT09Yn07XG52YXIgTmM9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYil7cmV0dXJuIG51bGwhPWE/UmEoYSxiKTpSYShKLGIpfXZhciBiPW51bGwsYz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYixkLGgpe3ZhciBsPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGw9MCxtPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7bDxtLmxlbmd0aDspbVtsXT1hcmd1bWVudHNbbCsyXSwrK2w7bD1uZXcgRihtLDApfXJldHVybiBjLmNhbGwodGhpcyxiLGQsbCl9ZnVuY3Rpb24gYyhhLGQsZSl7Zm9yKDs7KWlmKHQoZSkpYT1iLmEoYSxkKSxkPUcoZSksZT1LKGUpO2Vsc2UgcmV0dXJuIGIuYShhLGQpfWEuaT0yO2EuZj1mdW5jdGlvbihhKXt2YXIgYj1HKGEpO2E9SyhhKTt2YXIgZD1HKGEpO2E9SChhKTtyZXR1cm4gYyhiLGQsYSl9O2EuZD1jO3JldHVybiBhfSgpLGI9ZnVuY3Rpb24oYixlLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDA6cmV0dXJuIE1jO2Nhc2UgMTpyZXR1cm4gYjtcbmNhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYixlKTtkZWZhdWx0OnZhciBnPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGc9MCxoPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7ZzxoLmxlbmd0aDspaFtnXT1hcmd1bWVudHNbZysyXSwrK2c7Zz1uZXcgRihoLDApfXJldHVybiBjLmQoYixlLGcpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtiLmk9MjtiLmY9Yy5mO2IubD1mdW5jdGlvbigpe3JldHVybiBNY307Yi5iPWZ1bmN0aW9uKGEpe3JldHVybiBhfTtiLmE9YTtiLmQ9Yy5kO3JldHVybiBifSgpO2Z1bmN0aW9uIE9jKGEpe3JldHVybiBudWxsPT1hP251bGw6TmEoYSl9XG5mdW5jdGlvbiBRKGEpe2lmKG51bGwhPWEpaWYoYSYmKGEuaiYyfHxhLmNjKSlhPWEuTChudWxsKTtlbHNlIGlmKGEgaW5zdGFuY2VvZiBBcnJheSlhPWEubGVuZ3RoO2Vsc2UgaWYoXCJzdHJpbmdcIj09PXR5cGVvZiBhKWE9YS5sZW5ndGg7ZWxzZSBpZih3KExhLGEpKWE9TWEoYSk7ZWxzZSBhOnthPUQoYSk7Zm9yKHZhciBiPTA7Oyl7aWYoRWMoYSkpe2E9YitNYShhKTticmVhayBhfWE9SyhhKTtiKz0xfWE9dm9pZCAwfWVsc2UgYT0wO3JldHVybiBhfVxudmFyIFBjPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyl7Zm9yKDs7KXtpZihudWxsPT1hKXJldHVybiBjO2lmKDA9PT1iKXJldHVybiBEKGEpP0coYSk6YztpZihGYyhhKSlyZXR1cm4gQy5jKGEsYixjKTtpZihEKGEpKWE9SyhhKSxiLT0xO2Vsc2UgcmV0dXJuIGN9fWZ1bmN0aW9uIGIoYSxiKXtmb3IoOzspe2lmKG51bGw9PWEpdGhyb3cgRXJyb3IoXCJJbmRleCBvdXQgb2YgYm91bmRzXCIpO2lmKDA9PT1iKXtpZihEKGEpKXJldHVybiBHKGEpO3Rocm93IEVycm9yKFwiSW5kZXggb3V0IG9mIGJvdW5kc1wiKTt9aWYoRmMoYSkpcmV0dXJuIEMuYShhLGIpO2lmKEQoYSkpe3ZhciBjPUsoYSksZz1iLTE7YT1jO2I9Z31lbHNlIHRocm93IEVycm9yKFwiSW5kZXggb3V0IG9mIGJvdW5kc1wiKTt9fXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gYi5jYWxsKHRoaXMsYyxlKTtjYXNlIDM6cmV0dXJuIGEuY2FsbCh0aGlzLFxuYyxlLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmE9YjtjLmM9YTtyZXR1cm4gY30oKSxSPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyl7aWYoXCJudW1iZXJcIiE9PXR5cGVvZiBiKXRocm93IEVycm9yKFwiaW5kZXggYXJndW1lbnQgdG8gbnRoIG11c3QgYmUgYSBudW1iZXIuXCIpO2lmKG51bGw9PWEpcmV0dXJuIGM7aWYoYSYmKGEuaiYxNnx8YS5RYikpcmV0dXJuIGEuJChudWxsLGIsYyk7aWYoYSBpbnN0YW5jZW9mIEFycmF5fHxcInN0cmluZ1wiPT09dHlwZW9mIGEpcmV0dXJuIGI8YS5sZW5ndGg/YVtiXTpjO2lmKHcoVGEsYSkpcmV0dXJuIEMuYShhLGIpO2lmKGE/YS5qJjY0fHxhLmpifHwoYS5qPzA6dyhVYSxhKSk6dyhVYSxhKSlyZXR1cm4gUGMuYyhhLGIsYyk7dGhyb3cgRXJyb3IoW3ooXCJudGggbm90IHN1cHBvcnRlZCBvbiB0aGlzIHR5cGUgXCIpLHooRGEoQmEoYSkpKV0uam9pbihcIlwiKSk7fWZ1bmN0aW9uIGIoYSxiKXtpZihcIm51bWJlclwiIT09XG50eXBlb2YgYil0aHJvdyBFcnJvcihcImluZGV4IGFyZ3VtZW50IHRvIG50aCBtdXN0IGJlIGEgbnVtYmVyXCIpO2lmKG51bGw9PWEpcmV0dXJuIGE7aWYoYSYmKGEuaiYxNnx8YS5RYikpcmV0dXJuIGEuUShudWxsLGIpO2lmKGEgaW5zdGFuY2VvZiBBcnJheXx8XCJzdHJpbmdcIj09PXR5cGVvZiBhKXJldHVybiBiPGEubGVuZ3RoP2FbYl06bnVsbDtpZih3KFRhLGEpKXJldHVybiBDLmEoYSxiKTtpZihhP2EuaiY2NHx8YS5qYnx8KGEuaj8wOncoVWEsYSkpOncoVWEsYSkpcmV0dXJuIFBjLmEoYSxiKTt0aHJvdyBFcnJvcihbeihcIm50aCBub3Qgc3VwcG9ydGVkIG9uIHRoaXMgdHlwZSBcIikseihEYShCYShhKSkpXS5qb2luKFwiXCIpKTt9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiBiLmNhbGwodGhpcyxjLGUpO2Nhc2UgMzpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrXG5hcmd1bWVudHMubGVuZ3RoKTt9O2MuYT1iO2MuYz1hO3JldHVybiBjfSgpLFM9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjKXtyZXR1cm4gbnVsbCE9YT9hJiYoYS5qJjI1Nnx8YS5SYik/YS5zKG51bGwsYixjKTphIGluc3RhbmNlb2YgQXJyYXk/YjxhLmxlbmd0aD9hW2JdOmM6XCJzdHJpbmdcIj09PXR5cGVvZiBhP2I8YS5sZW5ndGg/YVtiXTpjOncoWmEsYSk/JGEuYyhhLGIsYyk6YzpjfWZ1bmN0aW9uIGIoYSxiKXtyZXR1cm4gbnVsbD09YT9udWxsOmEmJihhLmomMjU2fHxhLlJiKT9hLnQobnVsbCxiKTphIGluc3RhbmNlb2YgQXJyYXk/YjxhLmxlbmd0aD9hW2JdOm51bGw6XCJzdHJpbmdcIj09PXR5cGVvZiBhP2I8YS5sZW5ndGg/YVtiXTpudWxsOncoWmEsYSk/JGEuYShhLGIpOm51bGx9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiBiLmNhbGwodGhpcyxjLGUpO2Nhc2UgMzpyZXR1cm4gYS5jYWxsKHRoaXMsXG5jLGUsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYT1iO2MuYz1hO3JldHVybiBjfSgpLFJjPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyl7aWYobnVsbCE9YSlhPWNiKGEsYixjKTtlbHNlIGE6e2E9W2JdO2M9W2NdO2I9YS5sZW5ndGg7Zm9yKHZhciBnPTAsaD1PYihRYyk7OylpZihnPGIpdmFyIGw9ZysxLGg9aC5rYihudWxsLGFbZ10sY1tnXSksZz1sO2Vsc2V7YT1RYihoKTticmVhayBhfWE9dm9pZCAwfXJldHVybiBhfXZhciBiPW51bGwsYz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYixkLGgsbCl7dmFyIG09bnVsbDtpZigzPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgbT0wLHA9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0zKTttPHAubGVuZ3RoOylwW21dPWFyZ3VtZW50c1ttKzNdLCsrbTttPW5ldyBGKHAsMCl9cmV0dXJuIGMuY2FsbCh0aGlzLGIsZCxoLG0pfWZ1bmN0aW9uIGMoYSxkLGUsbCl7Zm9yKDs7KWlmKGE9Yi5jKGEsXG5kLGUpLHQobCkpZD1HKGwpLGU9TGMobCksbD1LKEsobCkpO2Vsc2UgcmV0dXJuIGF9YS5pPTM7YS5mPWZ1bmN0aW9uKGEpe3ZhciBiPUcoYSk7YT1LKGEpO3ZhciBkPUcoYSk7YT1LKGEpO3ZhciBsPUcoYSk7YT1IKGEpO3JldHVybiBjKGIsZCxsLGEpfTthLmQ9YztyZXR1cm4gYX0oKSxiPWZ1bmN0aW9uKGIsZSxmLGcpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDM6cmV0dXJuIGEuY2FsbCh0aGlzLGIsZSxmKTtkZWZhdWx0OnZhciBoPW51bGw7aWYoMzxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGg9MCxsPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMyk7aDxsLmxlbmd0aDspbFtoXT1hcmd1bWVudHNbaCszXSwrK2g7aD1uZXcgRihsLDApfXJldHVybiBjLmQoYixlLGYsaCl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2IuaT0zO2IuZj1jLmY7Yi5jPWE7Yi5kPWMuZDtyZXR1cm4gYn0oKSxTYz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxcbmIpe3JldHVybiBudWxsPT1hP251bGw6ZWIoYSxiKX12YXIgYj1udWxsLGM9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGIsZCxoKXt2YXIgbD1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBsPTAsbT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2w8bS5sZW5ndGg7KW1bbF09YXJndW1lbnRzW2wrMl0sKytsO2w9bmV3IEYobSwwKX1yZXR1cm4gYy5jYWxsKHRoaXMsYixkLGwpfWZ1bmN0aW9uIGMoYSxkLGUpe2Zvcig7Oyl7aWYobnVsbD09YSlyZXR1cm4gbnVsbDthPWIuYShhLGQpO2lmKHQoZSkpZD1HKGUpLGU9SyhlKTtlbHNlIHJldHVybiBhfX1hLmk9MjthLmY9ZnVuY3Rpb24oYSl7dmFyIGI9RyhhKTthPUsoYSk7dmFyIGQ9RyhhKTthPUgoYSk7cmV0dXJuIGMoYixkLGEpfTthLmQ9YztyZXR1cm4gYX0oKSxiPWZ1bmN0aW9uKGIsZSxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYixlKTtcbmRlZmF1bHQ6dmFyIGc9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZz0wLGg9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtnPGgubGVuZ3RoOyloW2ddPWFyZ3VtZW50c1tnKzJdLCsrZztnPW5ldyBGKGgsMCl9cmV0dXJuIGMuZChiLGUsZyl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2IuaT0yO2IuZj1jLmY7Yi5iPWZ1bmN0aW9uKGEpe3JldHVybiBhfTtiLmE9YTtiLmQ9Yy5kO3JldHVybiBifSgpO2Z1bmN0aW9uIFRjKGEpe3ZhciBiPVwiZnVuY3Rpb25cIj09bihhKTtyZXR1cm4gdChiKT9iOmE/dCh0KG51bGwpP251bGw6YS5iYyk/ITA6YS55Yj8hMTp3KEphLGEpOncoSmEsYSl9ZnVuY3Rpb24gVWMoYSxiKXt0aGlzLmg9YTt0aGlzLms9Yjt0aGlzLnE9MDt0aGlzLmo9MzkzMjE3fWs9VWMucHJvdG90eXBlO1xuay5jYWxsPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyxkLGUsZixnLGgsbCxtLHAscSx1LHMsdix5LEIsRSxOLFkscmEsSSl7YT10aGlzLmg7cmV0dXJuIFQudWI/VC51YihhLGIsYyxkLGUsZixnLGgsbCxtLHAscSx1LHMsdix5LEIsRSxOLFkscmEsSSk6VC5jYWxsKG51bGwsYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSxzLHYseSxCLEUsTixZLHJhLEkpfWZ1bmN0aW9uIGIoYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSxzLHYseSxCLEUsTixZLHJhKXthPXRoaXM7cmV0dXJuIGEuaC5GYT9hLmguRmEoYixjLGQsZSxmLGcsaCxsLG0scCxxLHUscyx2LHksQixFLE4sWSxyYSk6YS5oLmNhbGwobnVsbCxiLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSxzLHYseSxCLEUsTixZLHJhKX1mdW5jdGlvbiBjKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHUscyx2LHksQixFLE4sWSl7YT10aGlzO3JldHVybiBhLmguRWE/YS5oLkVhKGIsYyxkLGUsZixnLGgsbCxtLHAscSx1LHMsdix5LEIsRSxOLFxuWSk6YS5oLmNhbGwobnVsbCxiLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSxzLHYseSxCLEUsTixZKX1mdW5jdGlvbiBkKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHUscyx2LHksQixFLE4pe2E9dGhpcztyZXR1cm4gYS5oLkRhP2EuaC5EYShiLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSxzLHYseSxCLEUsTik6YS5oLmNhbGwobnVsbCxiLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSxzLHYseSxCLEUsTil9ZnVuY3Rpb24gZShhLGIsYyxkLGUsZixnLGgsbCxtLHAscSx1LHMsdix5LEIsRSl7YT10aGlzO3JldHVybiBhLmguQ2E/YS5oLkNhKGIsYyxkLGUsZixnLGgsbCxtLHAscSx1LHMsdix5LEIsRSk6YS5oLmNhbGwobnVsbCxiLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSxzLHYseSxCLEUpfWZ1bmN0aW9uIGYoYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSxzLHYseSxCKXthPXRoaXM7cmV0dXJuIGEuaC5CYT9hLmguQmEoYixjLGQsZSxmLGcsaCxsLG0scCxxLHUscyx2LHksQik6YS5oLmNhbGwobnVsbCxcbmIsYyxkLGUsZixnLGgsbCxtLHAscSx1LHMsdix5LEIpfWZ1bmN0aW9uIGcoYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSxzLHYseSl7YT10aGlzO3JldHVybiBhLmguQWE/YS5oLkFhKGIsYyxkLGUsZixnLGgsbCxtLHAscSx1LHMsdix5KTphLmguY2FsbChudWxsLGIsYyxkLGUsZixnLGgsbCxtLHAscSx1LHMsdix5KX1mdW5jdGlvbiBoKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHUscyx2KXthPXRoaXM7cmV0dXJuIGEuaC56YT9hLmguemEoYixjLGQsZSxmLGcsaCxsLG0scCxxLHUscyx2KTphLmguY2FsbChudWxsLGIsYyxkLGUsZixnLGgsbCxtLHAscSx1LHMsdil9ZnVuY3Rpb24gbChhLGIsYyxkLGUsZixnLGgsbCxtLHAscSx1LHMpe2E9dGhpcztyZXR1cm4gYS5oLnlhP2EuaC55YShiLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSxzKTphLmguY2FsbChudWxsLGIsYyxkLGUsZixnLGgsbCxtLHAscSx1LHMpfWZ1bmN0aW9uIG0oYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSl7YT10aGlzO1xucmV0dXJuIGEuaC54YT9hLmgueGEoYixjLGQsZSxmLGcsaCxsLG0scCxxLHUpOmEuaC5jYWxsKG51bGwsYixjLGQsZSxmLGcsaCxsLG0scCxxLHUpfWZ1bmN0aW9uIHAoYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEpe2E9dGhpcztyZXR1cm4gYS5oLndhP2EuaC53YShiLGMsZCxlLGYsZyxoLGwsbSxwLHEpOmEuaC5jYWxsKG51bGwsYixjLGQsZSxmLGcsaCxsLG0scCxxKX1mdW5jdGlvbiBxKGEsYixjLGQsZSxmLGcsaCxsLG0scCl7YT10aGlzO3JldHVybiBhLmgudmE/YS5oLnZhKGIsYyxkLGUsZixnLGgsbCxtLHApOmEuaC5jYWxsKG51bGwsYixjLGQsZSxmLGcsaCxsLG0scCl9ZnVuY3Rpb24gcyhhLGIsYyxkLGUsZixnLGgsbCxtKXthPXRoaXM7cmV0dXJuIGEuaC5IYT9hLmguSGEoYixjLGQsZSxmLGcsaCxsLG0pOmEuaC5jYWxsKG51bGwsYixjLGQsZSxmLGcsaCxsLG0pfWZ1bmN0aW9uIHUoYSxiLGMsZCxlLGYsZyxoLGwpe2E9dGhpcztyZXR1cm4gYS5oLkdhP2EuaC5HYShiLGMsXG5kLGUsZixnLGgsbCk6YS5oLmNhbGwobnVsbCxiLGMsZCxlLGYsZyxoLGwpfWZ1bmN0aW9uIHYoYSxiLGMsZCxlLGYsZyxoKXthPXRoaXM7cmV0dXJuIGEuaC5pYT9hLmguaWEoYixjLGQsZSxmLGcsaCk6YS5oLmNhbGwobnVsbCxiLGMsZCxlLGYsZyxoKX1mdW5jdGlvbiB5KGEsYixjLGQsZSxmLGcpe2E9dGhpcztyZXR1cm4gYS5oLlA/YS5oLlAoYixjLGQsZSxmLGcpOmEuaC5jYWxsKG51bGwsYixjLGQsZSxmLGcpfWZ1bmN0aW9uIEIoYSxiLGMsZCxlLGYpe2E9dGhpcztyZXR1cm4gYS5oLnI/YS5oLnIoYixjLGQsZSxmKTphLmguY2FsbChudWxsLGIsYyxkLGUsZil9ZnVuY3Rpb24gRShhLGIsYyxkLGUpe2E9dGhpcztyZXR1cm4gYS5oLm4/YS5oLm4oYixjLGQsZSk6YS5oLmNhbGwobnVsbCxiLGMsZCxlKX1mdW5jdGlvbiBOKGEsYixjLGQpe2E9dGhpcztyZXR1cm4gYS5oLmM/YS5oLmMoYixjLGQpOmEuaC5jYWxsKG51bGwsYixjLGQpfWZ1bmN0aW9uIFkoYSxiLGMpe2E9dGhpcztcbnJldHVybiBhLmguYT9hLmguYShiLGMpOmEuaC5jYWxsKG51bGwsYixjKX1mdW5jdGlvbiByYShhLGIpe2E9dGhpcztyZXR1cm4gYS5oLmI/YS5oLmIoYik6YS5oLmNhbGwobnVsbCxiKX1mdW5jdGlvbiBQYShhKXthPXRoaXM7cmV0dXJuIGEuaC5sP2EuaC5sKCk6YS5oLmNhbGwobnVsbCl9dmFyIEk9bnVsbCxJPWZ1bmN0aW9uKEkscWEsdGEsdmEseGEsQ2EsR2EsS2EsT2EsU2EsWWEsZ2Isb2IsQWIsV2IsamMsemMsWmMsR2QsRGUsV2YsZGgpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIFBhLmNhbGwodGhpcyxJKTtjYXNlIDI6cmV0dXJuIHJhLmNhbGwodGhpcyxJLHFhKTtjYXNlIDM6cmV0dXJuIFkuY2FsbCh0aGlzLEkscWEsdGEpO2Nhc2UgNDpyZXR1cm4gTi5jYWxsKHRoaXMsSSxxYSx0YSx2YSk7Y2FzZSA1OnJldHVybiBFLmNhbGwodGhpcyxJLHFhLHRhLHZhLHhhKTtjYXNlIDY6cmV0dXJuIEIuY2FsbCh0aGlzLEkscWEsdGEsdmEseGEsQ2EpO2Nhc2UgNzpyZXR1cm4geS5jYWxsKHRoaXMsXG5JLHFhLHRhLHZhLHhhLENhLEdhKTtjYXNlIDg6cmV0dXJuIHYuY2FsbCh0aGlzLEkscWEsdGEsdmEseGEsQ2EsR2EsS2EpO2Nhc2UgOTpyZXR1cm4gdS5jYWxsKHRoaXMsSSxxYSx0YSx2YSx4YSxDYSxHYSxLYSxPYSk7Y2FzZSAxMDpyZXR1cm4gcy5jYWxsKHRoaXMsSSxxYSx0YSx2YSx4YSxDYSxHYSxLYSxPYSxTYSk7Y2FzZSAxMTpyZXR1cm4gcS5jYWxsKHRoaXMsSSxxYSx0YSx2YSx4YSxDYSxHYSxLYSxPYSxTYSxZYSk7Y2FzZSAxMjpyZXR1cm4gcC5jYWxsKHRoaXMsSSxxYSx0YSx2YSx4YSxDYSxHYSxLYSxPYSxTYSxZYSxnYik7Y2FzZSAxMzpyZXR1cm4gbS5jYWxsKHRoaXMsSSxxYSx0YSx2YSx4YSxDYSxHYSxLYSxPYSxTYSxZYSxnYixvYik7Y2FzZSAxNDpyZXR1cm4gbC5jYWxsKHRoaXMsSSxxYSx0YSx2YSx4YSxDYSxHYSxLYSxPYSxTYSxZYSxnYixvYixBYik7Y2FzZSAxNTpyZXR1cm4gaC5jYWxsKHRoaXMsSSxxYSx0YSx2YSx4YSxDYSxHYSxLYSxPYSxTYSxZYSxnYixcbm9iLEFiLFdiKTtjYXNlIDE2OnJldHVybiBnLmNhbGwodGhpcyxJLHFhLHRhLHZhLHhhLENhLEdhLEthLE9hLFNhLFlhLGdiLG9iLEFiLFdiLGpjKTtjYXNlIDE3OnJldHVybiBmLmNhbGwodGhpcyxJLHFhLHRhLHZhLHhhLENhLEdhLEthLE9hLFNhLFlhLGdiLG9iLEFiLFdiLGpjLHpjKTtjYXNlIDE4OnJldHVybiBlLmNhbGwodGhpcyxJLHFhLHRhLHZhLHhhLENhLEdhLEthLE9hLFNhLFlhLGdiLG9iLEFiLFdiLGpjLHpjLFpjKTtjYXNlIDE5OnJldHVybiBkLmNhbGwodGhpcyxJLHFhLHRhLHZhLHhhLENhLEdhLEthLE9hLFNhLFlhLGdiLG9iLEFiLFdiLGpjLHpjLFpjLEdkKTtjYXNlIDIwOnJldHVybiBjLmNhbGwodGhpcyxJLHFhLHRhLHZhLHhhLENhLEdhLEthLE9hLFNhLFlhLGdiLG9iLEFiLFdiLGpjLHpjLFpjLEdkLERlKTtjYXNlIDIxOnJldHVybiBiLmNhbGwodGhpcyxJLHFhLHRhLHZhLHhhLENhLEdhLEthLE9hLFNhLFlhLGdiLG9iLEFiLFdiLGpjLHpjLFpjLEdkLERlLFxuV2YpO2Nhc2UgMjI6cmV0dXJuIGEuY2FsbCh0aGlzLEkscWEsdGEsdmEseGEsQ2EsR2EsS2EsT2EsU2EsWWEsZ2Isb2IsQWIsV2IsamMsemMsWmMsR2QsRGUsV2YsZGgpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtJLmI9UGE7SS5hPXJhO0kuYz1ZO0kubj1OO0kucj1FO0kuUD1CO0kuaWE9eTtJLkdhPXY7SS5IYT11O0kudmE9cztJLndhPXE7SS54YT1wO0kueWE9bTtJLnphPWw7SS5BYT1oO0kuQmE9ZztJLkNhPWY7SS5EYT1lO0kuRWE9ZDtJLkZhPWM7SS5oYz1iO0kudWI9YTtyZXR1cm4gSX0oKTtrLmFwcGx5PWZ1bmN0aW9uKGEsYil7cmV0dXJuIHRoaXMuY2FsbC5hcHBseSh0aGlzLFt0aGlzXS5jb25jYXQoRmEoYikpKX07ay5sPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuaC5sP3RoaXMuaC5sKCk6dGhpcy5oLmNhbGwobnVsbCl9O1xuay5iPWZ1bmN0aW9uKGEpe3JldHVybiB0aGlzLmguYj90aGlzLmguYihhKTp0aGlzLmguY2FsbChudWxsLGEpfTtrLmE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gdGhpcy5oLmE/dGhpcy5oLmEoYSxiKTp0aGlzLmguY2FsbChudWxsLGEsYil9O2suYz1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIHRoaXMuaC5jP3RoaXMuaC5jKGEsYixjKTp0aGlzLmguY2FsbChudWxsLGEsYixjKX07ay5uPWZ1bmN0aW9uKGEsYixjLGQpe3JldHVybiB0aGlzLmgubj90aGlzLmgubihhLGIsYyxkKTp0aGlzLmguY2FsbChudWxsLGEsYixjLGQpfTtrLnI9ZnVuY3Rpb24oYSxiLGMsZCxlKXtyZXR1cm4gdGhpcy5oLnI/dGhpcy5oLnIoYSxiLGMsZCxlKTp0aGlzLmguY2FsbChudWxsLGEsYixjLGQsZSl9O2suUD1mdW5jdGlvbihhLGIsYyxkLGUsZil7cmV0dXJuIHRoaXMuaC5QP3RoaXMuaC5QKGEsYixjLGQsZSxmKTp0aGlzLmguY2FsbChudWxsLGEsYixjLGQsZSxmKX07XG5rLmlhPWZ1bmN0aW9uKGEsYixjLGQsZSxmLGcpe3JldHVybiB0aGlzLmguaWE/dGhpcy5oLmlhKGEsYixjLGQsZSxmLGcpOnRoaXMuaC5jYWxsKG51bGwsYSxiLGMsZCxlLGYsZyl9O2suR2E9ZnVuY3Rpb24oYSxiLGMsZCxlLGYsZyxoKXtyZXR1cm4gdGhpcy5oLkdhP3RoaXMuaC5HYShhLGIsYyxkLGUsZixnLGgpOnRoaXMuaC5jYWxsKG51bGwsYSxiLGMsZCxlLGYsZyxoKX07ay5IYT1mdW5jdGlvbihhLGIsYyxkLGUsZixnLGgsbCl7cmV0dXJuIHRoaXMuaC5IYT90aGlzLmguSGEoYSxiLGMsZCxlLGYsZyxoLGwpOnRoaXMuaC5jYWxsKG51bGwsYSxiLGMsZCxlLGYsZyxoLGwpfTtrLnZhPWZ1bmN0aW9uKGEsYixjLGQsZSxmLGcsaCxsLG0pe3JldHVybiB0aGlzLmgudmE/dGhpcy5oLnZhKGEsYixjLGQsZSxmLGcsaCxsLG0pOnRoaXMuaC5jYWxsKG51bGwsYSxiLGMsZCxlLGYsZyxoLGwsbSl9O1xuay53YT1mdW5jdGlvbihhLGIsYyxkLGUsZixnLGgsbCxtLHApe3JldHVybiB0aGlzLmgud2E/dGhpcy5oLndhKGEsYixjLGQsZSxmLGcsaCxsLG0scCk6dGhpcy5oLmNhbGwobnVsbCxhLGIsYyxkLGUsZixnLGgsbCxtLHApfTtrLnhhPWZ1bmN0aW9uKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxKXtyZXR1cm4gdGhpcy5oLnhhP3RoaXMuaC54YShhLGIsYyxkLGUsZixnLGgsbCxtLHAscSk6dGhpcy5oLmNhbGwobnVsbCxhLGIsYyxkLGUsZixnLGgsbCxtLHAscSl9O2sueWE9ZnVuY3Rpb24oYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEscyl7cmV0dXJuIHRoaXMuaC55YT90aGlzLmgueWEoYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEscyk6dGhpcy5oLmNhbGwobnVsbCxhLGIsYyxkLGUsZixnLGgsbCxtLHAscSxzKX07XG5rLnphPWZ1bmN0aW9uKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSl7cmV0dXJuIHRoaXMuaC56YT90aGlzLmguemEoYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1KTp0aGlzLmguY2FsbChudWxsLGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSl9O2suQWE9ZnVuY3Rpb24oYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYpe3JldHVybiB0aGlzLmguQWE/dGhpcy5oLkFhKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2KTp0aGlzLmguY2FsbChudWxsLGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2KX07ay5CYT1mdW5jdGlvbihhLGIsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5KXtyZXR1cm4gdGhpcy5oLkJhP3RoaXMuaC5CYShhLGIsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5KTp0aGlzLmguY2FsbChudWxsLGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHkpfTtcbmsuQ2E9ZnVuY3Rpb24oYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCKXtyZXR1cm4gdGhpcy5oLkNhP3RoaXMuaC5DYShhLGIsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIpOnRoaXMuaC5jYWxsKG51bGwsYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCKX07ay5EYT1mdW5jdGlvbihhLGIsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIsRSl7cmV0dXJuIHRoaXMuaC5EYT90aGlzLmguRGEoYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCLEUpOnRoaXMuaC5jYWxsKG51bGwsYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCLEUpfTtcbmsuRWE9ZnVuY3Rpb24oYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCLEUsTil7cmV0dXJuIHRoaXMuaC5FYT90aGlzLmguRWEoYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCLEUsTik6dGhpcy5oLmNhbGwobnVsbCxhLGIsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIsRSxOKX07ay5GYT1mdW5jdGlvbihhLGIsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIsRSxOLFkpe3JldHVybiB0aGlzLmguRmE/dGhpcy5oLkZhKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQixFLE4sWSk6dGhpcy5oLmNhbGwobnVsbCxhLGIsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIsRSxOLFkpfTtcbmsuaGM9ZnVuY3Rpb24oYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCLEUsTixZLHJhKXt2YXIgUGE9dGhpcy5oO3JldHVybiBULnViP1QudWIoUGEsYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCLEUsTixZLHJhKTpULmNhbGwobnVsbCxQYSxhLGIsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIsRSxOLFkscmEpfTtrLmJjPSEwO2suRj1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgVWModGhpcy5oLGIpfTtrLkg9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5rfTtmdW5jdGlvbiBPKGEsYil7cmV0dXJuIFRjKGEpJiYhKGE/YS5qJjI2MjE0NHx8YS5CY3x8KGEuaj8wOncodGIsYSkpOncodGIsYSkpP25ldyBVYyhhLGIpOm51bGw9PWE/bnVsbDp1YihhLGIpfWZ1bmN0aW9uIFZjKGEpe3ZhciBiPW51bGwhPWE7cmV0dXJuKGI/YT9hLmomMTMxMDcyfHxhLmtjfHwoYS5qPzA6dyhyYixhKSk6dyhyYixhKTpiKT9zYihhKTpudWxsfVxuZnVuY3Rpb24gV2MoYSl7cmV0dXJuIG51bGw9PWE/bnVsbDpsYihhKX1cbnZhciBYYz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiKXtyZXR1cm4gbnVsbD09YT9udWxsOmtiKGEsYil9dmFyIGI9bnVsbCxjPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShiLGQsaCl7dmFyIGw9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgbD0wLG09QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtsPG0ubGVuZ3RoOyltW2xdPWFyZ3VtZW50c1tsKzJdLCsrbDtsPW5ldyBGKG0sMCl9cmV0dXJuIGMuY2FsbCh0aGlzLGIsZCxsKX1mdW5jdGlvbiBjKGEsZCxlKXtmb3IoOzspe2lmKG51bGw9PWEpcmV0dXJuIG51bGw7YT1iLmEoYSxkKTtpZih0KGUpKWQ9RyhlKSxlPUsoZSk7ZWxzZSByZXR1cm4gYX19YS5pPTI7YS5mPWZ1bmN0aW9uKGEpe3ZhciBiPUcoYSk7YT1LKGEpO3ZhciBkPUcoYSk7YT1IKGEpO3JldHVybiBjKGIsZCxhKX07YS5kPWM7cmV0dXJuIGF9KCksYj1mdW5jdGlvbihiLGUsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYjtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLFxuYixlKTtkZWZhdWx0OnZhciBnPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGc9MCxoPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7ZzxoLmxlbmd0aDspaFtnXT1hcmd1bWVudHNbZysyXSwrK2c7Zz1uZXcgRihoLDApfXJldHVybiBjLmQoYixlLGcpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtiLmk9MjtiLmY9Yy5mO2IuYj1mdW5jdGlvbihhKXtyZXR1cm4gYX07Yi5hPWE7Yi5kPWMuZDtyZXR1cm4gYn0oKTtmdW5jdGlvbiBZYyhhKXtyZXR1cm4gbnVsbD09YXx8QWEoRChhKSl9ZnVuY3Rpb24gJGMoYSl7cmV0dXJuIG51bGw9PWE/ITE6YT9hLmomOHx8YS50Yz8hMDphLmo/ITE6dyhRYSxhKTp3KFFhLGEpfWZ1bmN0aW9uIGFkKGEpe3JldHVybiBudWxsPT1hPyExOmE/YS5qJjQwOTZ8fGEuemM/ITA6YS5qPyExOncoamIsYSk6dyhqYixhKX1cbmZ1bmN0aW9uIGJkKGEpe3JldHVybiBhP2EuaiY1MTJ8fGEucmM/ITA6YS5qPyExOncoYWIsYSk6dyhhYixhKX1mdW5jdGlvbiBjZChhKXtyZXR1cm4gYT9hLmomMTY3NzcyMTZ8fGEueWM/ITA6YS5qPyExOncoRGIsYSk6dyhEYixhKX1mdW5jdGlvbiBkZChhKXtyZXR1cm4gbnVsbD09YT8hMTphP2EuaiYxMDI0fHxhLmljPyEwOmEuaj8hMTp3KGRiLGEpOncoZGIsYSl9ZnVuY3Rpb24gZWQoYSl7cmV0dXJuIGE/YS5qJjE2Mzg0fHxhLkFjPyEwOmEuaj8hMTp3KG5iLGEpOncobmIsYSl9ZnVuY3Rpb24gZmQoYSl7cmV0dXJuIGE/YS5xJjUxMnx8YS5zYz8hMDohMTohMX1mdW5jdGlvbiBnZChhKXt2YXIgYj1bXTtlYShhLGZ1bmN0aW9uKGEsYil7cmV0dXJuIGZ1bmN0aW9uKGEsYyl7cmV0dXJuIGIucHVzaChjKX19KGEsYikpO3JldHVybiBifWZ1bmN0aW9uIGhkKGEsYixjLGQsZSl7Zm9yKDswIT09ZTspY1tkXT1hW2JdLGQrPTEsZS09MSxiKz0xfVxuZnVuY3Rpb24gaWQoYSxiLGMsZCxlKXtiKz1lLTE7Zm9yKGQrPWUtMTswIT09ZTspY1tkXT1hW2JdLGQtPTEsZS09MSxiLT0xfXZhciBqZD17fTtmdW5jdGlvbiBrZChhKXtyZXR1cm4gbnVsbD09YT8hMTphP2EuaiY2NHx8YS5qYj8hMDphLmo/ITE6dyhVYSxhKTp3KFVhLGEpfWZ1bmN0aW9uIGxkKGEpe3JldHVybiBhP2EuaiY4Mzg4NjA4fHxhLm1jPyEwOmEuaj8hMTp3KEJiLGEpOncoQmIsYSl9ZnVuY3Rpb24gbWQoYSl7cmV0dXJuIHQoYSk/ITA6ITF9ZnVuY3Rpb24gbmQoYSxiKXtyZXR1cm4gUy5jKGEsYixqZCk9PT1qZD8hMTohMH1cbmZ1bmN0aW9uIG9kKGEsYil7aWYoYT09PWIpcmV0dXJuIDA7aWYobnVsbD09YSlyZXR1cm4tMTtpZihudWxsPT1iKXJldHVybiAxO2lmKEJhKGEpPT09QmEoYikpcmV0dXJuIGEmJihhLnEmMjA0OHx8YS5zYik/YS50YihudWxsLGIpOmhhKGEsYik7dGhyb3cgRXJyb3IoXCJjb21wYXJlIG9uIG5vbi1uaWwgb2JqZWN0cyBvZiBkaWZmZXJlbnQgdHlwZXNcIik7fVxudmFyIHBkPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyxnKXtmb3IoOzspe3ZhciBoPW9kKFIuYShhLGcpLFIuYShiLGcpKTtpZigwPT09aCYmZysxPGMpZys9MTtlbHNlIHJldHVybiBofX1mdW5jdGlvbiBiKGEsYil7dmFyIGY9UShhKSxnPVEoYik7cmV0dXJuIGY8Zz8tMTpmPmc/MTpjLm4oYSxiLGYsMCl9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSxmLGcpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIGIuY2FsbCh0aGlzLGMsZSk7Y2FzZSA0OnJldHVybiBhLmNhbGwodGhpcyxjLGUsZixnKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5hPWI7Yy5uPWE7cmV0dXJuIGN9KCk7XG5mdW5jdGlvbiBxZChhKXtyZXR1cm4gc2MuYShhLG9kKT9vZDpmdW5jdGlvbihiLGMpe3ZhciBkPWEuYT9hLmEoYixjKTphLmNhbGwobnVsbCxiLGMpO3JldHVyblwibnVtYmVyXCI9PT10eXBlb2YgZD9kOnQoZCk/LTE6dChhLmE/YS5hKGMsYik6YS5jYWxsKG51bGwsYyxiKSk/MTowfX1cbnZhciBzZD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiKXtpZihEKGIpKXt2YXIgYz1yZC5iP3JkLmIoYik6cmQuY2FsbChudWxsLGIpLGc9cWQoYSk7aWEoYyxnKTtyZXR1cm4gRChjKX1yZXR1cm4gSn1mdW5jdGlvbiBiKGEpe3JldHVybiBjLmEob2QsYSl9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYi5jYWxsKHRoaXMsYyk7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxjLGUpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmI9YjtjLmE9YTtyZXR1cm4gY30oKSx0ZD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMpe3JldHVybiBzZC5hKGZ1bmN0aW9uKGMsZil7cmV0dXJuIHFkKGIpLmNhbGwobnVsbCxhLmI/YS5iKGMpOmEuY2FsbChudWxsLGMpLGEuYj9hLmIoZik6YS5jYWxsKG51bGwsZikpfSxjKX1mdW5jdGlvbiBiKGEsYil7cmV0dXJuIGMuYyhhLG9kLFxuYil9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiBiLmNhbGwodGhpcyxjLGUpO2Nhc2UgMzpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmE9YjtjLmM9YTtyZXR1cm4gY30oKSxQPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyl7Zm9yKGM9RChjKTs7KWlmKGMpe3ZhciBnPUcoYyk7Yj1hLmE/YS5hKGIsZyk6YS5jYWxsKG51bGwsYixnKTtpZihBYyhiKSlyZXR1cm4gcWIoYik7Yz1LKGMpfWVsc2UgcmV0dXJuIGJ9ZnVuY3Rpb24gYihhLGIpe3ZhciBjPUQoYik7aWYoYyl7dmFyIGc9RyhjKSxjPUsoYyk7cmV0dXJuIEEuYz9BLmMoYSxnLGMpOkEuY2FsbChudWxsLGEsZyxjKX1yZXR1cm4gYS5sP2EubCgpOmEuY2FsbChudWxsKX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIGIuY2FsbCh0aGlzLFxuYyxlKTtjYXNlIDM6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSxmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5hPWI7Yy5jPWE7cmV0dXJuIGN9KCksQT1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMpe3JldHVybiBjJiYoYy5qJjUyNDI4OHx8Yy5TYik/Yy5PKG51bGwsYSxiKTpjIGluc3RhbmNlb2YgQXJyYXk/RGMuYyhjLGEsYik6XCJzdHJpbmdcIj09PXR5cGVvZiBjP0RjLmMoYyxhLGIpOncodmIsYyk/d2IuYyhjLGEsYik6UC5jKGEsYixjKX1mdW5jdGlvbiBiKGEsYil7cmV0dXJuIGImJihiLmomNTI0Mjg4fHxiLlNiKT9iLlIobnVsbCxhKTpiIGluc3RhbmNlb2YgQXJyYXk/RGMuYShiLGEpOlwic3RyaW5nXCI9PT10eXBlb2YgYj9EYy5hKGIsYSk6dyh2YixiKT93Yi5hKGIsYSk6UC5hKGEsYil9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiBiLmNhbGwodGhpcyxcbmMsZSk7Y2FzZSAzOnJldHVybiBhLmNhbGwodGhpcyxjLGUsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYT1iO2MuYz1hO3JldHVybiBjfSgpO2Z1bmN0aW9uIHVkKGEpe3JldHVybiBhfVxudmFyIHZkPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIpe3JldHVybiBmdW5jdGlvbigpe2Z1bmN0aW9uIGMoYixlKXtyZXR1cm4gYS5hP2EuYShiLGUpOmEuY2FsbChudWxsLGIsZSl9ZnVuY3Rpb24gZyhhKXtyZXR1cm4gYi5iP2IuYihhKTpiLmNhbGwobnVsbCxhKX1mdW5jdGlvbiBoKCl7cmV0dXJuIGEubD9hLmwoKTphLmNhbGwobnVsbCl9dmFyIGw9bnVsbCxsPWZ1bmN0aW9uKGEsYil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMDpyZXR1cm4gaC5jYWxsKHRoaXMpO2Nhc2UgMTpyZXR1cm4gZy5jYWxsKHRoaXMsYSk7Y2FzZSAyOnJldHVybiBjLmNhbGwodGhpcyxhLGIpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtsLmw9aDtsLmI9ZztsLmE9YztyZXR1cm4gbH0oKX1mdW5jdGlvbiBiKGEpe3JldHVybiBjLmEoYSx1ZCl9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYi5jYWxsKHRoaXMsXG5jKTtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYj1iO2MuYT1hO3JldHVybiBjfSgpLHdkPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyxnKXthPWEuYj9hLmIoYik6YS5jYWxsKG51bGwsYik7Yz1BLmMoYSxjLGcpO3JldHVybiBhLmI/YS5iKGMpOmEuY2FsbChudWxsLGMpfWZ1bmN0aW9uIGIoYSxiLGYpe3JldHVybiBjLm4oYSxiLGIubD9iLmwoKTpiLmNhbGwobnVsbCksZil9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSxmLGcpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDM6cmV0dXJuIGIuY2FsbCh0aGlzLGMsZSxmKTtjYXNlIDQ6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSxmLGcpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmM9YjtjLm49YTtyZXR1cm4gY30oKSx4ZD1mdW5jdGlvbigpe3ZhciBhPW51bGwsYj1mdW5jdGlvbigpe2Z1bmN0aW9uIGIoYSxcbmMsZyl7dmFyIGg9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgaD0wLGw9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtoPGwubGVuZ3RoOylsW2hdPWFyZ3VtZW50c1toKzJdLCsraDtoPW5ldyBGKGwsMCl9cmV0dXJuIGQuY2FsbCh0aGlzLGEsYyxoKX1mdW5jdGlvbiBkKGIsYyxkKXtyZXR1cm4gQS5jKGEsYitjLGQpfWIuaT0yO2IuZj1mdW5jdGlvbihhKXt2YXIgYj1HKGEpO2E9SyhhKTt2YXIgYz1HKGEpO2E9SChhKTtyZXR1cm4gZChiLGMsYSl9O2IuZD1kO3JldHVybiBifSgpLGE9ZnVuY3Rpb24oYSxkLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDA6cmV0dXJuIDA7Y2FzZSAxOnJldHVybiBhO2Nhc2UgMjpyZXR1cm4gYStkO2RlZmF1bHQ6dmFyIGY9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZj0wLGc9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtmPGcubGVuZ3RoOylnW2ZdPWFyZ3VtZW50c1tmKzJdLCsrZjtmPW5ldyBGKGcsXG4wKX1yZXR1cm4gYi5kKGEsZCxmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307YS5pPTI7YS5mPWIuZjthLmw9ZnVuY3Rpb24oKXtyZXR1cm4gMH07YS5iPWZ1bmN0aW9uKGEpe3JldHVybiBhfTthLmE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gYStifTthLmQ9Yi5kO3JldHVybiBhfSgpLHlkPWZ1bmN0aW9uKCl7dmFyIGE9bnVsbCxiPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShjLGYsZyl7dmFyIGg9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgaD0wLGw9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtoPGwubGVuZ3RoOylsW2hdPWFyZ3VtZW50c1toKzJdLCsraDtoPW5ldyBGKGwsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGMsZixoKX1mdW5jdGlvbiBiKGEsYyxkKXtmb3IoOzspaWYoYTxjKWlmKEsoZCkpYT1jLGM9RyhkKSxkPUsoZCk7ZWxzZSByZXR1cm4gYzxHKGQpO2Vsc2UgcmV0dXJuITF9YS5pPTI7YS5mPWZ1bmN0aW9uKGEpe3ZhciBjPVxuRyhhKTthPUsoYSk7dmFyIGc9RyhhKTthPUgoYSk7cmV0dXJuIGIoYyxnLGEpfTthLmQ9YjtyZXR1cm4gYX0oKSxhPWZ1bmN0aW9uKGEsZCxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiEwO2Nhc2UgMjpyZXR1cm4gYTxkO2RlZmF1bHQ6dmFyIGY9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZj0wLGc9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtmPGcubGVuZ3RoOylnW2ZdPWFyZ3VtZW50c1tmKzJdLCsrZjtmPW5ldyBGKGcsMCl9cmV0dXJuIGIuZChhLGQsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2EuaT0yO2EuZj1iLmY7YS5iPWZ1bmN0aW9uKCl7cmV0dXJuITB9O2EuYT1mdW5jdGlvbihhLGIpe3JldHVybiBhPGJ9O2EuZD1iLmQ7cmV0dXJuIGF9KCksemQ9ZnVuY3Rpb24oKXt2YXIgYT1udWxsLGI9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGMsZixnKXt2YXIgaD1udWxsO2lmKDI8XG5hcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGg9MCxsPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7aDxsLmxlbmd0aDspbFtoXT1hcmd1bWVudHNbaCsyXSwrK2g7aD1uZXcgRihsLDApfXJldHVybiBiLmNhbGwodGhpcyxjLGYsaCl9ZnVuY3Rpb24gYihhLGMsZCl7Zm9yKDs7KWlmKGE8PWMpaWYoSyhkKSlhPWMsYz1HKGQpLGQ9SyhkKTtlbHNlIHJldHVybiBjPD1HKGQpO2Vsc2UgcmV0dXJuITF9YS5pPTI7YS5mPWZ1bmN0aW9uKGEpe3ZhciBjPUcoYSk7YT1LKGEpO3ZhciBnPUcoYSk7YT1IKGEpO3JldHVybiBiKGMsZyxhKX07YS5kPWI7cmV0dXJuIGF9KCksYT1mdW5jdGlvbihhLGQsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4hMDtjYXNlIDI6cmV0dXJuIGE8PWQ7ZGVmYXVsdDp2YXIgZj1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBmPTAsZz1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2Y8Zy5sZW5ndGg7KWdbZl09YXJndW1lbnRzW2YrXG4yXSwrK2Y7Zj1uZXcgRihnLDApfXJldHVybiBiLmQoYSxkLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTthLmk9MjthLmY9Yi5mO2EuYj1mdW5jdGlvbigpe3JldHVybiEwfTthLmE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gYTw9Yn07YS5kPWIuZDtyZXR1cm4gYX0oKSxBZD1mdW5jdGlvbigpe3ZhciBhPW51bGwsYj1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYyxmLGcpe3ZhciBoPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGg9MCxsPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7aDxsLmxlbmd0aDspbFtoXT1hcmd1bWVudHNbaCsyXSwrK2g7aD1uZXcgRihsLDApfXJldHVybiBiLmNhbGwodGhpcyxjLGYsaCl9ZnVuY3Rpb24gYihhLGMsZCl7Zm9yKDs7KWlmKGE+YylpZihLKGQpKWE9YyxjPUcoZCksZD1LKGQpO2Vsc2UgcmV0dXJuIGM+RyhkKTtlbHNlIHJldHVybiExfWEuaT0yO2EuZj1mdW5jdGlvbihhKXt2YXIgYz1cbkcoYSk7YT1LKGEpO3ZhciBnPUcoYSk7YT1IKGEpO3JldHVybiBiKGMsZyxhKX07YS5kPWI7cmV0dXJuIGF9KCksYT1mdW5jdGlvbihhLGQsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4hMDtjYXNlIDI6cmV0dXJuIGE+ZDtkZWZhdWx0OnZhciBmPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGY9MCxnPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7ZjxnLmxlbmd0aDspZ1tmXT1hcmd1bWVudHNbZisyXSwrK2Y7Zj1uZXcgRihnLDApfXJldHVybiBiLmQoYSxkLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTthLmk9MjthLmY9Yi5mO2EuYj1mdW5jdGlvbigpe3JldHVybiEwfTthLmE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gYT5ifTthLmQ9Yi5kO3JldHVybiBhfSgpLEJkPWZ1bmN0aW9uKCl7dmFyIGE9bnVsbCxiPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShjLGYsZyl7dmFyIGg9bnVsbDtpZigyPFxuYXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBoPTAsbD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2g8bC5sZW5ndGg7KWxbaF09YXJndW1lbnRzW2grMl0sKytoO2g9bmV3IEYobCwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsYyxmLGgpfWZ1bmN0aW9uIGIoYSxjLGQpe2Zvcig7OylpZihhPj1jKWlmKEsoZCkpYT1jLGM9RyhkKSxkPUsoZCk7ZWxzZSByZXR1cm4gYz49RyhkKTtlbHNlIHJldHVybiExfWEuaT0yO2EuZj1mdW5jdGlvbihhKXt2YXIgYz1HKGEpO2E9SyhhKTt2YXIgZz1HKGEpO2E9SChhKTtyZXR1cm4gYihjLGcsYSl9O2EuZD1iO3JldHVybiBhfSgpLGE9ZnVuY3Rpb24oYSxkLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuITA7Y2FzZSAyOnJldHVybiBhPj1kO2RlZmF1bHQ6dmFyIGY9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZj0wLGc9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtmPGcubGVuZ3RoOylnW2ZdPWFyZ3VtZW50c1tmK1xuMl0sKytmO2Y9bmV3IEYoZywwKX1yZXR1cm4gYi5kKGEsZCxmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307YS5pPTI7YS5mPWIuZjthLmI9ZnVuY3Rpb24oKXtyZXR1cm4hMH07YS5hPWZ1bmN0aW9uKGEsYil7cmV0dXJuIGE+PWJ9O2EuZD1iLmQ7cmV0dXJuIGF9KCk7ZnVuY3Rpb24gQ2QoYSxiKXt2YXIgYz0oYS1hJWIpL2I7cmV0dXJuIDA8PWM/TWF0aC5mbG9vci5iP01hdGguZmxvb3IuYihjKTpNYXRoLmZsb29yLmNhbGwobnVsbCxjKTpNYXRoLmNlaWwuYj9NYXRoLmNlaWwuYihjKTpNYXRoLmNlaWwuY2FsbChudWxsLGMpfWZ1bmN0aW9uIERkKGEpe2EtPWE+PjEmMTQzMTY1NTc2NTthPShhJjg1ODk5MzQ1OSkrKGE+PjImODU4OTkzNDU5KTtyZXR1cm4gMTY4NDMwMDkqKGErKGE+PjQpJjI1MjY0NTEzNSk+PjI0fVxuZnVuY3Rpb24gRWQoYSl7dmFyIGI9MTtmb3IoYT1EKGEpOzspaWYoYSYmMDxiKWItPTEsYT1LKGEpO2Vsc2UgcmV0dXJuIGF9XG52YXIgej1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSl7cmV0dXJuIG51bGw9PWE/XCJcIjpkYShhKX12YXIgYj1udWxsLGM9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGIsZCl7dmFyIGg9bnVsbDtpZigxPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgaD0wLGw9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0xKTtoPGwubGVuZ3RoOylsW2hdPWFyZ3VtZW50c1toKzFdLCsraDtoPW5ldyBGKGwsMCl9cmV0dXJuIGMuY2FsbCh0aGlzLGIsaCl9ZnVuY3Rpb24gYyhhLGQpe2Zvcih2YXIgZT1uZXcgZmEoYi5iKGEpKSxsPWQ7OylpZih0KGwpKWU9ZS5hcHBlbmQoYi5iKEcobCkpKSxsPUsobCk7ZWxzZSByZXR1cm4gZS50b1N0cmluZygpfWEuaT0xO2EuZj1mdW5jdGlvbihhKXt2YXIgYj1HKGEpO2E9SChhKTtyZXR1cm4gYyhiLGEpfTthLmQ9YztyZXR1cm4gYX0oKSxiPWZ1bmN0aW9uKGIsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMDpyZXR1cm5cIlwiO2Nhc2UgMTpyZXR1cm4gYS5jYWxsKHRoaXMsXG5iKTtkZWZhdWx0OnZhciBmPW51bGw7aWYoMTxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGY9MCxnPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMSk7ZjxnLmxlbmd0aDspZ1tmXT1hcmd1bWVudHNbZisxXSwrK2Y7Zj1uZXcgRihnLDApfXJldHVybiBjLmQoYixmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yi5pPTE7Yi5mPWMuZjtiLmw9ZnVuY3Rpb24oKXtyZXR1cm5cIlwifTtiLmI9YTtiLmQ9Yy5kO3JldHVybiBifSgpO2Z1bmN0aW9uIEljKGEsYil7dmFyIGM7aWYoY2QoYikpaWYoRWMoYSkmJkVjKGIpJiZRKGEpIT09UShiKSljPSExO2Vsc2UgYTp7Yz1EKGEpO2Zvcih2YXIgZD1EKGIpOzspe2lmKG51bGw9PWMpe2M9bnVsbD09ZDticmVhayBhfWlmKG51bGwhPWQmJnNjLmEoRyhjKSxHKGQpKSljPUsoYyksZD1LKGQpO2Vsc2V7Yz0hMTticmVhayBhfX1jPXZvaWQgMH1lbHNlIGM9bnVsbDtyZXR1cm4gbWQoYyl9XG5mdW5jdGlvbiBGZChhLGIsYyxkLGUpe3RoaXMuaz1hO3RoaXMuZmlyc3Q9Yjt0aGlzLk09Yzt0aGlzLmNvdW50PWQ7dGhpcy5wPWU7dGhpcy5qPTY1OTM3NjQ2O3RoaXMucT04MTkyfWs9RmQucHJvdG90eXBlO2sudG9TdHJpbmc9ZnVuY3Rpb24oKXtyZXR1cm4gZWModGhpcyl9O2suSD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmt9O2suVD1mdW5jdGlvbigpe3JldHVybiAxPT09dGhpcy5jb3VudD9udWxsOnRoaXMuTX07ay5MPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuY291bnR9O2suTGE9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5maXJzdH07ay5NYT1mdW5jdGlvbigpe3JldHVybiBXYSh0aGlzKX07ay5CPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5wO3JldHVybiBudWxsIT1hP2E6dGhpcy5wPWE9d2ModGhpcyl9O2suQT1mdW5jdGlvbihhLGIpe3JldHVybiBJYyh0aGlzLGIpfTtrLko9ZnVuY3Rpb24oKXtyZXR1cm4gdWIoSix0aGlzLmspfTtcbmsuUj1mdW5jdGlvbihhLGIpe3JldHVybiBQLmEoYix0aGlzKX07ay5PPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gUC5jKGIsYyx0aGlzKX07ay5OPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuZmlyc3R9O2suUz1mdW5jdGlvbigpe3JldHVybiAxPT09dGhpcy5jb3VudD9KOnRoaXMuTX07ay5EPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXN9O2suRj1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgRmQoYix0aGlzLmZpcnN0LHRoaXMuTSx0aGlzLmNvdW50LHRoaXMucCl9O2suRz1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgRmQodGhpcy5rLGIsdGhpcyx0aGlzLmNvdW50KzEsbnVsbCl9O0ZkLnByb3RvdHlwZVtFYV09ZnVuY3Rpb24oKXtyZXR1cm4gdWModGhpcyl9O2Z1bmN0aW9uIEhkKGEpe3RoaXMuaz1hO3RoaXMuaj02NTkzNzYxNDt0aGlzLnE9ODE5Mn1rPUhkLnByb3RvdHlwZTtrLnRvU3RyaW5nPWZ1bmN0aW9uKCl7cmV0dXJuIGVjKHRoaXMpfTtrLkg9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5rfTtcbmsuVD1mdW5jdGlvbigpe3JldHVybiBudWxsfTtrLkw9ZnVuY3Rpb24oKXtyZXR1cm4gMH07ay5MYT1mdW5jdGlvbigpe3JldHVybiBudWxsfTtrLk1hPWZ1bmN0aW9uKCl7dGhyb3cgRXJyb3IoXCJDYW4ndCBwb3AgZW1wdHkgbGlzdFwiKTt9O2suQj1mdW5jdGlvbigpe3JldHVybiAwfTtrLkE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gSWModGhpcyxiKX07ay5KPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXN9O2suUj1mdW5jdGlvbihhLGIpe3JldHVybiBQLmEoYix0aGlzKX07ay5PPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gUC5jKGIsYyx0aGlzKX07ay5OPWZ1bmN0aW9uKCl7cmV0dXJuIG51bGx9O2suUz1mdW5jdGlvbigpe3JldHVybiBKfTtrLkQ9ZnVuY3Rpb24oKXtyZXR1cm4gbnVsbH07ay5GPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyBIZChiKX07ay5HPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyBGZCh0aGlzLmssYixudWxsLDEsbnVsbCl9O3ZhciBKPW5ldyBIZChudWxsKTtcbkhkLnByb3RvdHlwZVtFYV09ZnVuY3Rpb24oKXtyZXR1cm4gdWModGhpcyl9O2Z1bmN0aW9uIElkKGEpe3JldHVybiBhP2EuaiYxMzQyMTc3Mjh8fGEueGM/ITA6YS5qPyExOncoRmIsYSk6dyhGYixhKX1mdW5jdGlvbiBKZChhKXtyZXR1cm4gSWQoYSk/R2IoYSk6QS5jKE5jLEosYSl9XG52YXIgS2Q9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEpe3ZhciBkPW51bGw7aWYoMDxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGQ9MCxlPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMCk7ZDxlLmxlbmd0aDspZVtkXT1hcmd1bWVudHNbZCswXSwrK2Q7ZD1uZXcgRihlLDApfXJldHVybiBiLmNhbGwodGhpcyxkKX1mdW5jdGlvbiBiKGEpe3ZhciBiO2lmKGEgaW5zdGFuY2VvZiBGJiYwPT09YS5tKWI9YS5lO2Vsc2UgYTp7Zm9yKGI9W107OylpZihudWxsIT1hKWIucHVzaChhLk4obnVsbCkpLGE9YS5UKG51bGwpO2Vsc2UgYnJlYWsgYTtiPXZvaWQgMH1hPWIubGVuZ3RoO2Zvcih2YXIgZT1KOzspaWYoMDxhKXt2YXIgZj1hLTEsZT1lLkcobnVsbCxiW2EtMV0pO2E9Zn1lbHNlIHJldHVybiBlfWEuaT0wO2EuZj1mdW5jdGlvbihhKXthPUQoYSk7cmV0dXJuIGIoYSl9O2EuZD1iO3JldHVybiBhfSgpO1xuZnVuY3Rpb24gTGQoYSxiLGMsZCl7dGhpcy5rPWE7dGhpcy5maXJzdD1iO3RoaXMuTT1jO3RoaXMucD1kO3RoaXMuaj02NTkyOTQ1Mjt0aGlzLnE9ODE5Mn1rPUxkLnByb3RvdHlwZTtrLnRvU3RyaW5nPWZ1bmN0aW9uKCl7cmV0dXJuIGVjKHRoaXMpfTtrLkg9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5rfTtrLlQ9ZnVuY3Rpb24oKXtyZXR1cm4gbnVsbD09dGhpcy5NP251bGw6RCh0aGlzLk0pfTtrLkI9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLnA7cmV0dXJuIG51bGwhPWE/YTp0aGlzLnA9YT13Yyh0aGlzKX07ay5BPWZ1bmN0aW9uKGEsYil7cmV0dXJuIEljKHRoaXMsYil9O2suSj1mdW5jdGlvbigpe3JldHVybiBPKEosdGhpcy5rKX07ay5SPWZ1bmN0aW9uKGEsYil7cmV0dXJuIFAuYShiLHRoaXMpfTtrLk89ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBQLmMoYixjLHRoaXMpfTtrLk49ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5maXJzdH07XG5rLlM9ZnVuY3Rpb24oKXtyZXR1cm4gbnVsbD09dGhpcy5NP0o6dGhpcy5NfTtrLkQ9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpc307ay5GPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyBMZChiLHRoaXMuZmlyc3QsdGhpcy5NLHRoaXMucCl9O2suRz1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgTGQobnVsbCxiLHRoaXMsdGhpcy5wKX07TGQucHJvdG90eXBlW0VhXT1mdW5jdGlvbigpe3JldHVybiB1Yyh0aGlzKX07ZnVuY3Rpb24gTShhLGIpe3ZhciBjPW51bGw9PWI7cmV0dXJuKGM/YzpiJiYoYi5qJjY0fHxiLmpiKSk/bmV3IExkKG51bGwsYSxiLG51bGwpOm5ldyBMZChudWxsLGEsRChiKSxudWxsKX1cbmZ1bmN0aW9uIE1kKGEsYil7aWYoYS5wYT09PWIucGEpcmV0dXJuIDA7dmFyIGM9QWEoYS5iYSk7aWYodChjP2IuYmE6YykpcmV0dXJuLTE7aWYodChhLmJhKSl7aWYoQWEoYi5iYSkpcmV0dXJuIDE7Yz1oYShhLmJhLGIuYmEpO3JldHVybiAwPT09Yz9oYShhLm5hbWUsYi5uYW1lKTpjfXJldHVybiBoYShhLm5hbWUsYi5uYW1lKX1mdW5jdGlvbiBVKGEsYixjLGQpe3RoaXMuYmE9YTt0aGlzLm5hbWU9Yjt0aGlzLnBhPWM7dGhpcy5ZYT1kO3RoaXMuaj0yMTUzNzc1MTA1O3RoaXMucT00MDk2fWs9VS5wcm90b3R5cGU7ay52PWZ1bmN0aW9uKGEsYil7cmV0dXJuIExiKGIsW3ooXCI6XCIpLHoodGhpcy5wYSldLmpvaW4oXCJcIikpfTtrLkI9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLllhO3JldHVybiBudWxsIT1hP2E6dGhpcy5ZYT1hPW9jKHRoaXMpKzI2NTQ0MzU3Njl8MH07XG5rLmNhbGw9ZnVuY3Rpb24oKXt2YXIgYT1udWxsLGE9ZnVuY3Rpb24oYSxjLGQpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIFMuYShjLHRoaXMpO2Nhc2UgMzpyZXR1cm4gUy5jKGMsdGhpcyxkKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307YS5hPWZ1bmN0aW9uKGEsYyl7cmV0dXJuIFMuYShjLHRoaXMpfTthLmM9ZnVuY3Rpb24oYSxjLGQpe3JldHVybiBTLmMoYyx0aGlzLGQpfTtyZXR1cm4gYX0oKTtrLmFwcGx5PWZ1bmN0aW9uKGEsYil7cmV0dXJuIHRoaXMuY2FsbC5hcHBseSh0aGlzLFt0aGlzXS5jb25jYXQoRmEoYikpKX07ay5iPWZ1bmN0aW9uKGEpe3JldHVybiBTLmEoYSx0aGlzKX07ay5hPWZ1bmN0aW9uKGEsYil7cmV0dXJuIFMuYyhhLHRoaXMsYil9O2suQT1mdW5jdGlvbihhLGIpe3JldHVybiBiIGluc3RhbmNlb2YgVT90aGlzLnBhPT09Yi5wYTohMX07XG5rLnRvU3RyaW5nPWZ1bmN0aW9uKCl7cmV0dXJuW3ooXCI6XCIpLHoodGhpcy5wYSldLmpvaW4oXCJcIil9O2Z1bmN0aW9uIE5kKGEsYil7cmV0dXJuIGE9PT1iPyEwOmEgaW5zdGFuY2VvZiBVJiZiIGluc3RhbmNlb2YgVT9hLnBhPT09Yi5wYTohMX1cbnZhciBQZD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiKXtyZXR1cm4gbmV3IFUoYSxiLFt6KHQoYSk/W3ooYSkseihcIi9cIildLmpvaW4oXCJcIik6bnVsbCkseihiKV0uam9pbihcIlwiKSxudWxsKX1mdW5jdGlvbiBiKGEpe2lmKGEgaW5zdGFuY2VvZiBVKXJldHVybiBhO2lmKGEgaW5zdGFuY2VvZiBxYyl7dmFyIGI7aWYoYSYmKGEucSY0MDk2fHxhLmxjKSliPWEuYmE7ZWxzZSB0aHJvdyBFcnJvcihbeihcIkRvZXNuJ3Qgc3VwcG9ydCBuYW1lc3BhY2U6IFwiKSx6KGEpXS5qb2luKFwiXCIpKTtyZXR1cm4gbmV3IFUoYixPZC5iP09kLmIoYSk6T2QuY2FsbChudWxsLGEpLGEudGEsbnVsbCl9cmV0dXJuXCJzdHJpbmdcIj09PXR5cGVvZiBhPyhiPWEuc3BsaXQoXCIvXCIpLDI9PT1iLmxlbmd0aD9uZXcgVShiWzBdLGJbMV0sYSxudWxsKTpuZXcgVShudWxsLGJbMF0sYSxudWxsKSk6bnVsbH12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiLmNhbGwodGhpcyxcbmMpO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5iPWI7Yy5hPWE7cmV0dXJuIGN9KCk7ZnVuY3Rpb24gVihhLGIsYyxkKXt0aGlzLms9YTt0aGlzLmNiPWI7dGhpcy5DPWM7dGhpcy5wPWQ7dGhpcy5xPTA7dGhpcy5qPTMyMzc0OTg4fWs9Vi5wcm90b3R5cGU7ay50b1N0cmluZz1mdW5jdGlvbigpe3JldHVybiBlYyh0aGlzKX07ZnVuY3Rpb24gUWQoYSl7bnVsbCE9YS5jYiYmKGEuQz1hLmNiLmw/YS5jYi5sKCk6YS5jYi5jYWxsKG51bGwpLGEuY2I9bnVsbCk7cmV0dXJuIGEuQ31rLkg9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5rfTtrLlQ9ZnVuY3Rpb24oKXtDYih0aGlzKTtyZXR1cm4gbnVsbD09dGhpcy5DP251bGw6Syh0aGlzLkMpfTtrLkI9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLnA7cmV0dXJuIG51bGwhPWE/YTp0aGlzLnA9YT13Yyh0aGlzKX07XG5rLkE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gSWModGhpcyxiKX07ay5KPWZ1bmN0aW9uKCl7cmV0dXJuIE8oSix0aGlzLmspfTtrLlI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gUC5hKGIsdGhpcyl9O2suTz1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIFAuYyhiLGMsdGhpcyl9O2suTj1mdW5jdGlvbigpe0NiKHRoaXMpO3JldHVybiBudWxsPT10aGlzLkM/bnVsbDpHKHRoaXMuQyl9O2suUz1mdW5jdGlvbigpe0NiKHRoaXMpO3JldHVybiBudWxsIT10aGlzLkM/SCh0aGlzLkMpOkp9O2suRD1mdW5jdGlvbigpe1FkKHRoaXMpO2lmKG51bGw9PXRoaXMuQylyZXR1cm4gbnVsbDtmb3IodmFyIGE9dGhpcy5DOzspaWYoYSBpbnN0YW5jZW9mIFYpYT1RZChhKTtlbHNlIHJldHVybiB0aGlzLkM9YSxEKHRoaXMuQyl9O2suRj1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgVihiLHRoaXMuY2IsdGhpcy5DLHRoaXMucCl9O2suRz1mdW5jdGlvbihhLGIpe3JldHVybiBNKGIsdGhpcyl9O1xuVi5wcm90b3R5cGVbRWFdPWZ1bmN0aW9uKCl7cmV0dXJuIHVjKHRoaXMpfTtmdW5jdGlvbiBSZChhLGIpe3RoaXMuQWI9YTt0aGlzLmVuZD1iO3RoaXMucT0wO3RoaXMuaj0yfVJkLnByb3RvdHlwZS5MPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuZW5kfTtSZC5wcm90b3R5cGUuYWRkPWZ1bmN0aW9uKGEpe3RoaXMuQWJbdGhpcy5lbmRdPWE7cmV0dXJuIHRoaXMuZW5kKz0xfTtSZC5wcm90b3R5cGUuY2E9ZnVuY3Rpb24oKXt2YXIgYT1uZXcgU2QodGhpcy5BYiwwLHRoaXMuZW5kKTt0aGlzLkFiPW51bGw7cmV0dXJuIGF9O2Z1bmN0aW9uIFRkKGEpe3JldHVybiBuZXcgUmQoQXJyYXkoYSksMCl9ZnVuY3Rpb24gU2QoYSxiLGMpe3RoaXMuZT1hO3RoaXMuVj1iO3RoaXMuZW5kPWM7dGhpcy5xPTA7dGhpcy5qPTUyNDMwNn1rPVNkLnByb3RvdHlwZTtrLlI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gRGMubih0aGlzLmUsYix0aGlzLmVbdGhpcy5WXSx0aGlzLlYrMSl9O1xuay5PPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gRGMubih0aGlzLmUsYixjLHRoaXMuVil9O2suUGI9ZnVuY3Rpb24oKXtpZih0aGlzLlY9PT10aGlzLmVuZCl0aHJvdyBFcnJvcihcIi1kcm9wLWZpcnN0IG9mIGVtcHR5IGNodW5rXCIpO3JldHVybiBuZXcgU2QodGhpcy5lLHRoaXMuVisxLHRoaXMuZW5kKX07ay5RPWZ1bmN0aW9uKGEsYil7cmV0dXJuIHRoaXMuZVt0aGlzLlYrYl19O2suJD1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIDA8PWImJmI8dGhpcy5lbmQtdGhpcy5WP3RoaXMuZVt0aGlzLlYrYl06Y307ay5MPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuZW5kLXRoaXMuVn07XG52YXIgVWQ9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjKXtyZXR1cm4gbmV3IFNkKGEsYixjKX1mdW5jdGlvbiBiKGEsYil7cmV0dXJuIG5ldyBTZChhLGIsYS5sZW5ndGgpfWZ1bmN0aW9uIGMoYSl7cmV0dXJuIG5ldyBTZChhLDAsYS5sZW5ndGgpfXZhciBkPW51bGwsZD1mdW5jdGlvbihkLGYsZyl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYy5jYWxsKHRoaXMsZCk7Y2FzZSAyOnJldHVybiBiLmNhbGwodGhpcyxkLGYpO2Nhc2UgMzpyZXR1cm4gYS5jYWxsKHRoaXMsZCxmLGcpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtkLmI9YztkLmE9YjtkLmM9YTtyZXR1cm4gZH0oKTtmdW5jdGlvbiBWZChhLGIsYyxkKXt0aGlzLmNhPWE7dGhpcy5yYT1iO3RoaXMuaz1jO3RoaXMucD1kO3RoaXMuaj0zMTg1MDczMjt0aGlzLnE9MTUzNn1rPVZkLnByb3RvdHlwZTtrLnRvU3RyaW5nPWZ1bmN0aW9uKCl7cmV0dXJuIGVjKHRoaXMpfTtcbmsuSD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmt9O2suVD1mdW5jdGlvbigpe2lmKDE8TWEodGhpcy5jYSkpcmV0dXJuIG5ldyBWZChYYih0aGlzLmNhKSx0aGlzLnJhLHRoaXMuayxudWxsKTt2YXIgYT1DYih0aGlzLnJhKTtyZXR1cm4gbnVsbD09YT9udWxsOmF9O2suQj1mdW5jdGlvbigpe3ZhciBhPXRoaXMucDtyZXR1cm4gbnVsbCE9YT9hOnRoaXMucD1hPXdjKHRoaXMpfTtrLkE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gSWModGhpcyxiKX07ay5KPWZ1bmN0aW9uKCl7cmV0dXJuIE8oSix0aGlzLmspfTtrLk49ZnVuY3Rpb24oKXtyZXR1cm4gQy5hKHRoaXMuY2EsMCl9O2suUz1mdW5jdGlvbigpe3JldHVybiAxPE1hKHRoaXMuY2EpP25ldyBWZChYYih0aGlzLmNhKSx0aGlzLnJhLHRoaXMuayxudWxsKTpudWxsPT10aGlzLnJhP0o6dGhpcy5yYX07ay5EPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXN9O2suQ2I9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5jYX07XG5rLkRiPWZ1bmN0aW9uKCl7cmV0dXJuIG51bGw9PXRoaXMucmE/Sjp0aGlzLnJhfTtrLkY9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IFZkKHRoaXMuY2EsdGhpcy5yYSxiLHRoaXMucCl9O2suRz1mdW5jdGlvbihhLGIpe3JldHVybiBNKGIsdGhpcyl9O2suQmI9ZnVuY3Rpb24oKXtyZXR1cm4gbnVsbD09dGhpcy5yYT9udWxsOnRoaXMucmF9O1ZkLnByb3RvdHlwZVtFYV09ZnVuY3Rpb24oKXtyZXR1cm4gdWModGhpcyl9O2Z1bmN0aW9uIFdkKGEsYil7cmV0dXJuIDA9PT1NYShhKT9iOm5ldyBWZChhLGIsbnVsbCxudWxsKX1mdW5jdGlvbiBYZChhLGIpe2EuYWRkKGIpfWZ1bmN0aW9uIHJkKGEpe2Zvcih2YXIgYj1bXTs7KWlmKEQoYSkpYi5wdXNoKEcoYSkpLGE9SyhhKTtlbHNlIHJldHVybiBifWZ1bmN0aW9uIFlkKGEsYil7aWYoRWMoYSkpcmV0dXJuIFEoYSk7Zm9yKHZhciBjPWEsZD1iLGU9MDs7KWlmKDA8ZCYmRChjKSljPUsoYyksZC09MSxlKz0xO2Vsc2UgcmV0dXJuIGV9XG52YXIgJGQ9ZnVuY3Rpb24gWmQoYil7cmV0dXJuIG51bGw9PWI/bnVsbDpudWxsPT1LKGIpP0QoRyhiKSk6TShHKGIpLFpkKEsoYikpKX0sYWU9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYil7cmV0dXJuIG5ldyBWKG51bGwsZnVuY3Rpb24oKXt2YXIgYz1EKGEpO3JldHVybiBjP2ZkKGMpP1dkKFliKGMpLGQuYShaYihjKSxiKSk6TShHKGMpLGQuYShIKGMpLGIpKTpifSxudWxsLG51bGwpfWZ1bmN0aW9uIGIoYSl7cmV0dXJuIG5ldyBWKG51bGwsZnVuY3Rpb24oKXtyZXR1cm4gYX0sbnVsbCxudWxsKX1mdW5jdGlvbiBjKCl7cmV0dXJuIG5ldyBWKG51bGwsZnVuY3Rpb24oKXtyZXR1cm4gbnVsbH0sbnVsbCxudWxsKX12YXIgZD1udWxsLGU9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGMsZCxlKXt2YXIgZj1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBmPTAscT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2Y8cS5sZW5ndGg7KXFbZl09YXJndW1lbnRzW2YrMl0sKytmO1xuZj1uZXcgRihxLDApfXJldHVybiBiLmNhbGwodGhpcyxjLGQsZil9ZnVuY3Rpb24gYihhLGMsZSl7cmV0dXJuIGZ1bmN0aW9uIHEoYSxiKXtyZXR1cm4gbmV3IFYobnVsbCxmdW5jdGlvbigpe3ZhciBjPUQoYSk7cmV0dXJuIGM/ZmQoYyk/V2QoWWIoYykscShaYihjKSxiKSk6TShHKGMpLHEoSChjKSxiKSk6dChiKT9xKEcoYiksSyhiKSk6bnVsbH0sbnVsbCxudWxsKX0oZC5hKGEsYyksZSl9YS5pPTI7YS5mPWZ1bmN0aW9uKGEpe3ZhciBjPUcoYSk7YT1LKGEpO3ZhciBkPUcoYSk7YT1IKGEpO3JldHVybiBiKGMsZCxhKX07YS5kPWI7cmV0dXJuIGF9KCksZD1mdW5jdGlvbihkLGcsaCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMDpyZXR1cm4gYy5jYWxsKHRoaXMpO2Nhc2UgMTpyZXR1cm4gYi5jYWxsKHRoaXMsZCk7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxkLGcpO2RlZmF1bHQ6dmFyIGw9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgbD0wLG09XG5BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2w8bS5sZW5ndGg7KW1bbF09YXJndW1lbnRzW2wrMl0sKytsO2w9bmV3IEYobSwwKX1yZXR1cm4gZS5kKGQsZyxsKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307ZC5pPTI7ZC5mPWUuZjtkLmw9YztkLmI9YjtkLmE9YTtkLmQ9ZS5kO3JldHVybiBkfSgpLGJlPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyxkKXtyZXR1cm4gTShhLE0oYixNKGMsZCkpKX1mdW5jdGlvbiBiKGEsYixjKXtyZXR1cm4gTShhLE0oYixjKSl9dmFyIGM9bnVsbCxkPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShjLGQsZSxtLHApe3ZhciBxPW51bGw7aWYoNDxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIHE9MCxzPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtNCk7cTxzLmxlbmd0aDspc1txXT1hcmd1bWVudHNbcSs0XSwrK3E7cT1uZXcgRihzLDApfXJldHVybiBiLmNhbGwodGhpcyxjLGQsZSxtLHEpfWZ1bmN0aW9uIGIoYSxcbmMsZCxlLGYpe3JldHVybiBNKGEsTShjLE0oZCxNKGUsJGQoZikpKSkpfWEuaT00O2EuZj1mdW5jdGlvbihhKXt2YXIgYz1HKGEpO2E9SyhhKTt2YXIgZD1HKGEpO2E9SyhhKTt2YXIgZT1HKGEpO2E9SyhhKTt2YXIgcD1HKGEpO2E9SChhKTtyZXR1cm4gYihjLGQsZSxwLGEpfTthLmQ9YjtyZXR1cm4gYX0oKSxjPWZ1bmN0aW9uKGMsZixnLGgsbCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gRChjKTtjYXNlIDI6cmV0dXJuIE0oYyxmKTtjYXNlIDM6cmV0dXJuIGIuY2FsbCh0aGlzLGMsZixnKTtjYXNlIDQ6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZixnLGgpO2RlZmF1bHQ6dmFyIG09bnVsbDtpZig0PGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgbT0wLHA9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC00KTttPHAubGVuZ3RoOylwW21dPWFyZ3VtZW50c1ttKzRdLCsrbTttPW5ldyBGKHAsMCl9cmV0dXJuIGQuZChjLGYsZyxoLG0pfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrXG5hcmd1bWVudHMubGVuZ3RoKTt9O2MuaT00O2MuZj1kLmY7Yy5iPWZ1bmN0aW9uKGEpe3JldHVybiBEKGEpfTtjLmE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gTShhLGIpfTtjLmM9YjtjLm49YTtjLmQ9ZC5kO3JldHVybiBjfSgpO2Z1bmN0aW9uIGNlKGEpe3JldHVybiBRYihhKX1cbnZhciBkZT1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoKXtyZXR1cm4gT2IoTWMpfXZhciBiPW51bGwsYz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYyxkLGgpe3ZhciBsPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGw9MCxtPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7bDxtLmxlbmd0aDspbVtsXT1hcmd1bWVudHNbbCsyXSwrK2w7bD1uZXcgRihtLDApfXJldHVybiBiLmNhbGwodGhpcyxjLGQsbCl9ZnVuY3Rpb24gYihhLGMsZCl7Zm9yKDs7KWlmKGE9UGIoYSxjKSx0KGQpKWM9RyhkKSxkPUsoZCk7ZWxzZSByZXR1cm4gYX1hLmk9MjthLmY9ZnVuY3Rpb24oYSl7dmFyIGM9RyhhKTthPUsoYSk7dmFyIGQ9RyhhKTthPUgoYSk7cmV0dXJuIGIoYyxkLGEpfTthLmQ9YjtyZXR1cm4gYX0oKSxiPWZ1bmN0aW9uKGIsZSxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAwOnJldHVybiBhLmNhbGwodGhpcyk7Y2FzZSAxOnJldHVybiBiO2Nhc2UgMjpyZXR1cm4gUGIoYixcbmUpO2RlZmF1bHQ6dmFyIGc9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZz0wLGg9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtnPGgubGVuZ3RoOyloW2ddPWFyZ3VtZW50c1tnKzJdLCsrZztnPW5ldyBGKGgsMCl9cmV0dXJuIGMuZChiLGUsZyl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2IuaT0yO2IuZj1jLmY7Yi5sPWE7Yi5iPWZ1bmN0aW9uKGEpe3JldHVybiBhfTtiLmE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gUGIoYSxiKX07Yi5kPWMuZDtyZXR1cm4gYn0oKSxlZT1mdW5jdGlvbigpe3ZhciBhPW51bGwsYj1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYyxmLGcsaCl7dmFyIGw9bnVsbDtpZigzPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgbD0wLG09QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0zKTtsPG0ubGVuZ3RoOyltW2xdPWFyZ3VtZW50c1tsKzNdLCsrbDtsPW5ldyBGKG0sMCl9cmV0dXJuIGIuY2FsbCh0aGlzLFxuYyxmLGcsbCl9ZnVuY3Rpb24gYihhLGMsZCxoKXtmb3IoOzspaWYoYT1SYihhLGMsZCksdChoKSljPUcoaCksZD1MYyhoKSxoPUsoSyhoKSk7ZWxzZSByZXR1cm4gYX1hLmk9MzthLmY9ZnVuY3Rpb24oYSl7dmFyIGM9RyhhKTthPUsoYSk7dmFyIGc9RyhhKTthPUsoYSk7dmFyIGg9RyhhKTthPUgoYSk7cmV0dXJuIGIoYyxnLGgsYSl9O2EuZD1iO3JldHVybiBhfSgpLGE9ZnVuY3Rpb24oYSxkLGUsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMzpyZXR1cm4gUmIoYSxkLGUpO2RlZmF1bHQ6dmFyIGc9bnVsbDtpZigzPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZz0wLGg9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0zKTtnPGgubGVuZ3RoOyloW2ddPWFyZ3VtZW50c1tnKzNdLCsrZztnPW5ldyBGKGgsMCl9cmV0dXJuIGIuZChhLGQsZSxnKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307YS5pPTM7YS5mPWIuZjthLmM9ZnVuY3Rpb24oYSxcbmIsZSl7cmV0dXJuIFJiKGEsYixlKX07YS5kPWIuZDtyZXR1cm4gYX0oKSxmZT1mdW5jdGlvbigpe3ZhciBhPW51bGwsYj1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYyxmLGcpe3ZhciBoPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGg9MCxsPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7aDxsLmxlbmd0aDspbFtoXT1hcmd1bWVudHNbaCsyXSwrK2g7aD1uZXcgRihsLDApfXJldHVybiBiLmNhbGwodGhpcyxjLGYsaCl9ZnVuY3Rpb24gYihhLGMsZCl7Zm9yKDs7KWlmKGE9U2IoYSxjKSx0KGQpKWM9RyhkKSxkPUsoZCk7ZWxzZSByZXR1cm4gYX1hLmk9MjthLmY9ZnVuY3Rpb24oYSl7dmFyIGM9RyhhKTthPUsoYSk7dmFyIGc9RyhhKTthPUgoYSk7cmV0dXJuIGIoYyxnLGEpfTthLmQ9YjtyZXR1cm4gYX0oKSxhPWZ1bmN0aW9uKGEsZCxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiBTYihhLGQpO2RlZmF1bHQ6dmFyIGY9bnVsbDtpZigyPFxuYXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBmPTAsZz1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2Y8Zy5sZW5ndGg7KWdbZl09YXJndW1lbnRzW2YrMl0sKytmO2Y9bmV3IEYoZywwKX1yZXR1cm4gYi5kKGEsZCxmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307YS5pPTI7YS5mPWIuZjthLmE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gU2IoYSxiKX07YS5kPWIuZDtyZXR1cm4gYX0oKSxnZT1mdW5jdGlvbigpe3ZhciBhPW51bGwsYj1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYyxmLGcpe3ZhciBoPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGg9MCxsPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7aDxsLmxlbmd0aDspbFtoXT1hcmd1bWVudHNbaCsyXSwrK2g7aD1uZXcgRihsLDApfXJldHVybiBiLmNhbGwodGhpcyxjLGYsaCl9ZnVuY3Rpb24gYihhLGMsZCl7Zm9yKDs7KWlmKGE9VmIoYSxjKSx0KGQpKWM9RyhkKSxkPUsoZCk7XG5lbHNlIHJldHVybiBhfWEuaT0yO2EuZj1mdW5jdGlvbihhKXt2YXIgYz1HKGEpO2E9SyhhKTt2YXIgZz1HKGEpO2E9SChhKTtyZXR1cm4gYihjLGcsYSl9O2EuZD1iO3JldHVybiBhfSgpLGE9ZnVuY3Rpb24oYSxkLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIFZiKGEsZCk7ZGVmYXVsdDp2YXIgZj1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBmPTAsZz1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2Y8Zy5sZW5ndGg7KWdbZl09YXJndW1lbnRzW2YrMl0sKytmO2Y9bmV3IEYoZywwKX1yZXR1cm4gYi5kKGEsZCxmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307YS5pPTI7YS5mPWIuZjthLmE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gVmIoYSxiKX07YS5kPWIuZDtyZXR1cm4gYX0oKTtcbmZ1bmN0aW9uIGhlKGEsYixjKXt2YXIgZD1EKGMpO2lmKDA9PT1iKXJldHVybiBhLmw/YS5sKCk6YS5jYWxsKG51bGwpO2M9VmEoZCk7dmFyIGU9V2EoZCk7aWYoMT09PWIpcmV0dXJuIGEuYj9hLmIoYyk6YS5iP2EuYihjKTphLmNhbGwobnVsbCxjKTt2YXIgZD1WYShlKSxmPVdhKGUpO2lmKDI9PT1iKXJldHVybiBhLmE/YS5hKGMsZCk6YS5hP2EuYShjLGQpOmEuY2FsbChudWxsLGMsZCk7dmFyIGU9VmEoZiksZz1XYShmKTtpZigzPT09YilyZXR1cm4gYS5jP2EuYyhjLGQsZSk6YS5jP2EuYyhjLGQsZSk6YS5jYWxsKG51bGwsYyxkLGUpO3ZhciBmPVZhKGcpLGg9V2EoZyk7aWYoND09PWIpcmV0dXJuIGEubj9hLm4oYyxkLGUsZik6YS5uP2EubihjLGQsZSxmKTphLmNhbGwobnVsbCxjLGQsZSxmKTt2YXIgZz1WYShoKSxsPVdhKGgpO2lmKDU9PT1iKXJldHVybiBhLnI/YS5yKGMsZCxlLGYsZyk6YS5yP2EucihjLGQsZSxmLGcpOmEuY2FsbChudWxsLGMsZCxlLGYsZyk7dmFyIGg9VmEobCksXG5tPVdhKGwpO2lmKDY9PT1iKXJldHVybiBhLlA/YS5QKGMsZCxlLGYsZyxoKTphLlA/YS5QKGMsZCxlLGYsZyxoKTphLmNhbGwobnVsbCxjLGQsZSxmLGcsaCk7dmFyIGw9VmEobSkscD1XYShtKTtpZig3PT09YilyZXR1cm4gYS5pYT9hLmlhKGMsZCxlLGYsZyxoLGwpOmEuaWE/YS5pYShjLGQsZSxmLGcsaCxsKTphLmNhbGwobnVsbCxjLGQsZSxmLGcsaCxsKTt2YXIgbT1WYShwKSxxPVdhKHApO2lmKDg9PT1iKXJldHVybiBhLkdhP2EuR2EoYyxkLGUsZixnLGgsbCxtKTphLkdhP2EuR2EoYyxkLGUsZixnLGgsbCxtKTphLmNhbGwobnVsbCxjLGQsZSxmLGcsaCxsLG0pO3ZhciBwPVZhKHEpLHM9V2EocSk7aWYoOT09PWIpcmV0dXJuIGEuSGE/YS5IYShjLGQsZSxmLGcsaCxsLG0scCk6YS5IYT9hLkhhKGMsZCxlLGYsZyxoLGwsbSxwKTphLmNhbGwobnVsbCxjLGQsZSxmLGcsaCxsLG0scCk7dmFyIHE9VmEocyksdT1XYShzKTtpZigxMD09PWIpcmV0dXJuIGEudmE/YS52YShjLGQsZSxcbmYsZyxoLGwsbSxwLHEpOmEudmE/YS52YShjLGQsZSxmLGcsaCxsLG0scCxxKTphLmNhbGwobnVsbCxjLGQsZSxmLGcsaCxsLG0scCxxKTt2YXIgcz1WYSh1KSx2PVdhKHUpO2lmKDExPT09YilyZXR1cm4gYS53YT9hLndhKGMsZCxlLGYsZyxoLGwsbSxwLHEscyk6YS53YT9hLndhKGMsZCxlLGYsZyxoLGwsbSxwLHEscyk6YS5jYWxsKG51bGwsYyxkLGUsZixnLGgsbCxtLHAscSxzKTt2YXIgdT1WYSh2KSx5PVdhKHYpO2lmKDEyPT09YilyZXR1cm4gYS54YT9hLnhhKGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1KTphLnhhP2EueGEoYyxkLGUsZixnLGgsbCxtLHAscSxzLHUpOmEuY2FsbChudWxsLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1KTt2YXIgdj1WYSh5KSxCPVdhKHkpO2lmKDEzPT09YilyZXR1cm4gYS55YT9hLnlhKGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYpOmEueWE/YS55YShjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2KTphLmNhbGwobnVsbCxjLGQsZSxmLGcsaCxsLG0scCxcbnEscyx1LHYpO3ZhciB5PVZhKEIpLEU9V2EoQik7aWYoMTQ9PT1iKXJldHVybiBhLnphP2EuemEoYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5KTphLnphP2EuemEoYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5KTphLmNhbGwobnVsbCxjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHkpO3ZhciBCPVZhKEUpLE49V2EoRSk7aWYoMTU9PT1iKXJldHVybiBhLkFhP2EuQWEoYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIpOmEuQWE/YS5BYShjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQik6YS5jYWxsKG51bGwsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIpO3ZhciBFPVZhKE4pLFk9V2EoTik7aWYoMTY9PT1iKXJldHVybiBhLkJhP2EuQmEoYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIsRSk6YS5CYT9hLkJhKGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCLEUpOmEuY2FsbChudWxsLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCLEUpO3ZhciBOPVxuVmEoWSkscmE9V2EoWSk7aWYoMTc9PT1iKXJldHVybiBhLkNhP2EuQ2EoYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIsRSxOKTphLkNhP2EuQ2EoYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIsRSxOKTphLmNhbGwobnVsbCxjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQixFLE4pO3ZhciBZPVZhKHJhKSxQYT1XYShyYSk7aWYoMTg9PT1iKXJldHVybiBhLkRhP2EuRGEoYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIsRSxOLFkpOmEuRGE/YS5EYShjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQixFLE4sWSk6YS5jYWxsKG51bGwsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIsRSxOLFkpO3JhPVZhKFBhKTtQYT1XYShQYSk7aWYoMTk9PT1iKXJldHVybiBhLkVhP2EuRWEoYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIsRSxOLFkscmEpOmEuRWE/YS5FYShjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQixFLE4sWSxyYSk6YS5jYWxsKG51bGwsXG5jLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQixFLE4sWSxyYSk7dmFyIEk9VmEoUGEpO1dhKFBhKTtpZigyMD09PWIpcmV0dXJuIGEuRmE/YS5GYShjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQixFLE4sWSxyYSxJKTphLkZhP2EuRmEoYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIsRSxOLFkscmEsSSk6YS5jYWxsKG51bGwsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIsRSxOLFkscmEsSSk7dGhyb3cgRXJyb3IoXCJPbmx5IHVwIHRvIDIwIGFyZ3VtZW50cyBzdXBwb3J0ZWQgb24gZnVuY3Rpb25zXCIpO31cbnZhciBUPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyxkLGUpe2I9YmUubihiLGMsZCxlKTtjPWEuaTtyZXR1cm4gYS5mPyhkPVlkKGIsYysxKSxkPD1jP2hlKGEsZCxiKTphLmYoYikpOmEuYXBwbHkoYSxyZChiKSl9ZnVuY3Rpb24gYihhLGIsYyxkKXtiPWJlLmMoYixjLGQpO2M9YS5pO3JldHVybiBhLmY/KGQ9WWQoYixjKzEpLGQ8PWM/aGUoYSxkLGIpOmEuZihiKSk6YS5hcHBseShhLHJkKGIpKX1mdW5jdGlvbiBjKGEsYixjKXtiPWJlLmEoYixjKTtjPWEuaTtpZihhLmYpe3ZhciBkPVlkKGIsYysxKTtyZXR1cm4gZDw9Yz9oZShhLGQsYik6YS5mKGIpfXJldHVybiBhLmFwcGx5KGEscmQoYikpfWZ1bmN0aW9uIGQoYSxiKXt2YXIgYz1hLmk7aWYoYS5mKXt2YXIgZD1ZZChiLGMrMSk7cmV0dXJuIGQ8PWM/aGUoYSxkLGIpOmEuZihiKX1yZXR1cm4gYS5hcHBseShhLHJkKGIpKX12YXIgZT1udWxsLGY9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGMsZCxlLGYsZyx1KXt2YXIgdj1udWxsO1xuaWYoNTxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIHY9MCx5PUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtNSk7djx5Lmxlbmd0aDspeVt2XT1hcmd1bWVudHNbdis1XSwrK3Y7dj1uZXcgRih5LDApfXJldHVybiBiLmNhbGwodGhpcyxjLGQsZSxmLGcsdil9ZnVuY3Rpb24gYihhLGMsZCxlLGYsZyl7Yz1NKGMsTShkLE0oZSxNKGYsJGQoZykpKSkpO2Q9YS5pO3JldHVybiBhLmY/KGU9WWQoYyxkKzEpLGU8PWQ/aGUoYSxlLGMpOmEuZihjKSk6YS5hcHBseShhLHJkKGMpKX1hLmk9NTthLmY9ZnVuY3Rpb24oYSl7dmFyIGM9RyhhKTthPUsoYSk7dmFyIGQ9RyhhKTthPUsoYSk7dmFyIGU9RyhhKTthPUsoYSk7dmFyIGY9RyhhKTthPUsoYSk7dmFyIGc9RyhhKTthPUgoYSk7cmV0dXJuIGIoYyxkLGUsZixnLGEpfTthLmQ9YjtyZXR1cm4gYX0oKSxlPWZ1bmN0aW9uKGUsaCxsLG0scCxxKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiBkLmNhbGwodGhpcyxlLGgpO2Nhc2UgMzpyZXR1cm4gYy5jYWxsKHRoaXMsXG5lLGgsbCk7Y2FzZSA0OnJldHVybiBiLmNhbGwodGhpcyxlLGgsbCxtKTtjYXNlIDU6cmV0dXJuIGEuY2FsbCh0aGlzLGUsaCxsLG0scCk7ZGVmYXVsdDp2YXIgcz1udWxsO2lmKDU8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBzPTAsdT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTUpO3M8dS5sZW5ndGg7KXVbc109YXJndW1lbnRzW3MrNV0sKytzO3M9bmV3IEYodSwwKX1yZXR1cm4gZi5kKGUsaCxsLG0scCxzKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307ZS5pPTU7ZS5mPWYuZjtlLmE9ZDtlLmM9YztlLm49YjtlLnI9YTtlLmQ9Zi5kO3JldHVybiBlfSgpLGllPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyxkLGUsZil7dmFyIGc9Tyx2PVZjKGEpO2I9Yi5yP2Iucih2LGMsZCxlLGYpOmIuY2FsbChudWxsLHYsYyxkLGUsZik7cmV0dXJuIGcoYSxiKX1mdW5jdGlvbiBiKGEsYixjLGQsZSl7dmFyIGY9TyxnPVZjKGEpO2I9Yi5uP2IubihnLFxuYyxkLGUpOmIuY2FsbChudWxsLGcsYyxkLGUpO3JldHVybiBmKGEsYil9ZnVuY3Rpb24gYyhhLGIsYyxkKXt2YXIgZT1PLGY9VmMoYSk7Yj1iLmM/Yi5jKGYsYyxkKTpiLmNhbGwobnVsbCxmLGMsZCk7cmV0dXJuIGUoYSxiKX1mdW5jdGlvbiBkKGEsYixjKXt2YXIgZD1PLGU9VmMoYSk7Yj1iLmE/Yi5hKGUsYyk6Yi5jYWxsKG51bGwsZSxjKTtyZXR1cm4gZChhLGIpfWZ1bmN0aW9uIGUoYSxiKXt2YXIgYz1PLGQ7ZD1WYyhhKTtkPWIuYj9iLmIoZCk6Yi5jYWxsKG51bGwsZCk7cmV0dXJuIGMoYSxkKX12YXIgZj1udWxsLGc9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGMsZCxlLGYsZyxoLHkpe3ZhciBCPW51bGw7aWYoNjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIEI9MCxFPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtNik7QjxFLmxlbmd0aDspRVtCXT1hcmd1bWVudHNbQis2XSwrK0I7Qj1uZXcgRihFLDApfXJldHVybiBiLmNhbGwodGhpcyxjLGQsZSxmLGcsaCxCKX1mdW5jdGlvbiBiKGEsXG5jLGQsZSxmLGcsaCl7cmV0dXJuIE8oYSxULmQoYyxWYyhhKSxkLGUsZixLYyhbZyxoXSwwKSkpfWEuaT02O2EuZj1mdW5jdGlvbihhKXt2YXIgYz1HKGEpO2E9SyhhKTt2YXIgZD1HKGEpO2E9SyhhKTt2YXIgZT1HKGEpO2E9SyhhKTt2YXIgZj1HKGEpO2E9SyhhKTt2YXIgZz1HKGEpO2E9SyhhKTt2YXIgaD1HKGEpO2E9SChhKTtyZXR1cm4gYihjLGQsZSxmLGcsaCxhKX07YS5kPWI7cmV0dXJuIGF9KCksZj1mdW5jdGlvbihmLGwsbSxwLHEscyx1KXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiBlLmNhbGwodGhpcyxmLGwpO2Nhc2UgMzpyZXR1cm4gZC5jYWxsKHRoaXMsZixsLG0pO2Nhc2UgNDpyZXR1cm4gYy5jYWxsKHRoaXMsZixsLG0scCk7Y2FzZSA1OnJldHVybiBiLmNhbGwodGhpcyxmLGwsbSxwLHEpO2Nhc2UgNjpyZXR1cm4gYS5jYWxsKHRoaXMsZixsLG0scCxxLHMpO2RlZmF1bHQ6dmFyIHY9bnVsbDtpZig2PGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgdj1cbjAseT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTYpO3Y8eS5sZW5ndGg7KXlbdl09YXJndW1lbnRzW3YrNl0sKyt2O3Y9bmV3IEYoeSwwKX1yZXR1cm4gZy5kKGYsbCxtLHAscSxzLHYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtmLmk9NjtmLmY9Zy5mO2YuYT1lO2YuYz1kO2Yubj1jO2Yucj1iO2YuUD1hO2YuZD1nLmQ7cmV0dXJuIGZ9KCksamU9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYil7cmV0dXJuIXNjLmEoYSxiKX12YXIgYj1udWxsLGM9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGMsZCxoKXt2YXIgbD1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBsPTAsbT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2w8bS5sZW5ndGg7KW1bbF09YXJndW1lbnRzW2wrMl0sKytsO2w9bmV3IEYobSwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsYyxkLGwpfWZ1bmN0aW9uIGIoYSxjLGQpe3JldHVybiBBYShULm4oc2MsYSxjLGQpKX1hLmk9XG4yO2EuZj1mdW5jdGlvbihhKXt2YXIgYz1HKGEpO2E9SyhhKTt2YXIgZD1HKGEpO2E9SChhKTtyZXR1cm4gYihjLGQsYSl9O2EuZD1iO3JldHVybiBhfSgpLGI9ZnVuY3Rpb24oYixlLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuITE7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxiLGUpO2RlZmF1bHQ6dmFyIGc9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZz0wLGg9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtnPGgubGVuZ3RoOyloW2ddPWFyZ3VtZW50c1tnKzJdLCsrZztnPW5ldyBGKGgsMCl9cmV0dXJuIGMuZChiLGUsZyl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2IuaT0yO2IuZj1jLmY7Yi5iPWZ1bmN0aW9uKCl7cmV0dXJuITF9O2IuYT1hO2IuZD1jLmQ7cmV0dXJuIGJ9KCkscWU9ZnVuY3Rpb24ga2UoKXtcInVuZGVmaW5lZFwiPT09dHlwZW9mIGphJiYoamE9ZnVuY3Rpb24oYixjKXt0aGlzLnBjPVxuYjt0aGlzLm9jPWM7dGhpcy5xPTA7dGhpcy5qPTM5MzIxNn0samEucHJvdG90eXBlLmdhPWZ1bmN0aW9uKCl7cmV0dXJuITF9LGphLnByb3RvdHlwZS5uZXh0PWZ1bmN0aW9uKCl7cmV0dXJuIEVycm9yKFwiTm8gc3VjaCBlbGVtZW50XCIpfSxqYS5wcm90b3R5cGUuSD1mdW5jdGlvbigpe3JldHVybiB0aGlzLm9jfSxqYS5wcm90b3R5cGUuRj1mdW5jdGlvbihiLGMpe3JldHVybiBuZXcgamEodGhpcy5wYyxjKX0samEuWWI9ITAsamEuWGI9XCJjbGpzLmNvcmUvdDEyNjYwXCIsamEubmM9ZnVuY3Rpb24oYil7cmV0dXJuIExiKGIsXCJjbGpzLmNvcmUvdDEyNjYwXCIpfSk7cmV0dXJuIG5ldyBqYShrZSxuZXcgcGEobnVsbCw1LFtsZSw1NCxtZSwyOTk4LG5lLDMsb2UsMjk5NCxwZSxcIi9Vc2Vycy9kYXZpZG5vbGVuL2RldmVsb3BtZW50L2Nsb2p1cmUvbW9yaS9vdXQtbW9yaS1hZHYvY2xqcy9jb3JlLmNsanNcIl0sbnVsbCkpfTtmdW5jdGlvbiByZShhLGIpe3RoaXMuQz1hO3RoaXMubT1ifVxucmUucHJvdG90eXBlLmdhPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMubTx0aGlzLkMubGVuZ3RofTtyZS5wcm90b3R5cGUubmV4dD1mdW5jdGlvbigpe3ZhciBhPXRoaXMuQy5jaGFyQXQodGhpcy5tKTt0aGlzLm0rPTE7cmV0dXJuIGF9O2Z1bmN0aW9uIHNlKGEsYil7dGhpcy5lPWE7dGhpcy5tPWJ9c2UucHJvdG90eXBlLmdhPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMubTx0aGlzLmUubGVuZ3RofTtzZS5wcm90b3R5cGUubmV4dD1mdW5jdGlvbigpe3ZhciBhPXRoaXMuZVt0aGlzLm1dO3RoaXMubSs9MTtyZXR1cm4gYX07dmFyIHRlPXt9LHVlPXt9O2Z1bmN0aW9uIHZlKGEsYil7dGhpcy5lYj1hO3RoaXMuUWE9Yn12ZS5wcm90b3R5cGUuZ2E9ZnVuY3Rpb24oKXt0aGlzLmViPT09dGU/KHRoaXMuZWI9dWUsdGhpcy5RYT1EKHRoaXMuUWEpKTp0aGlzLmViPT09dGhpcy5RYSYmKHRoaXMuUWE9Syh0aGlzLmViKSk7cmV0dXJuIG51bGwhPXRoaXMuUWF9O1xudmUucHJvdG90eXBlLm5leHQ9ZnVuY3Rpb24oKXtpZihBYSh0aGlzLmdhKCkpKXRocm93IEVycm9yKFwiTm8gc3VjaCBlbGVtZW50XCIpO3RoaXMuZWI9dGhpcy5RYTtyZXR1cm4gRyh0aGlzLlFhKX07ZnVuY3Rpb24gd2UoYSl7aWYobnVsbD09YSlyZXR1cm4gcWUoKTtpZihcInN0cmluZ1wiPT09dHlwZW9mIGEpcmV0dXJuIG5ldyByZShhLDApO2lmKGEgaW5zdGFuY2VvZiBBcnJheSlyZXR1cm4gbmV3IHNlKGEsMCk7aWYoYT90KHQobnVsbCk/bnVsbDphLnZiKXx8KGEueWI/MDp3KGJjLGEpKTp3KGJjLGEpKXJldHVybiBjYyhhKTtpZihsZChhKSlyZXR1cm4gbmV3IHZlKHRlLGEpO3Rocm93IEVycm9yKFt6KFwiQ2Fubm90IGNyZWF0ZSBpdGVyYXRvciBmcm9tIFwiKSx6KGEpXS5qb2luKFwiXCIpKTt9ZnVuY3Rpb24geGUoYSxiKXt0aGlzLmZhPWE7dGhpcy4kYj1ifVxueGUucHJvdG90eXBlLnN0ZXA9ZnVuY3Rpb24oYSl7Zm9yKHZhciBiPXRoaXM7Oyl7aWYodChmdW5jdGlvbigpe3ZhciBjPW51bGwhPWEuWDtyZXR1cm4gYz9iLiRiLmdhKCk6Y30oKSkpaWYoQWMoZnVuY3Rpb24oKXt2YXIgYz1iLiRiLm5leHQoKTtyZXR1cm4gYi5mYS5hP2IuZmEuYShhLGMpOmIuZmEuY2FsbChudWxsLGEsYyl9KCkpKW51bGwhPWEuTSYmKGEuTS5YPW51bGwpO2Vsc2UgY29udGludWU7YnJlYWt9cmV0dXJuIG51bGw9PWEuWD9udWxsOmIuZmEuYj9iLmZhLmIoYSk6Yi5mYS5jYWxsKG51bGwsYSl9O1xuZnVuY3Rpb24geWUoYSxiKXt2YXIgYz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYixjKXtiLmZpcnN0PWM7Yi5NPW5ldyB6ZShiLlgsbnVsbCxudWxsLG51bGwpO2IuWD1udWxsO3JldHVybiBiLk19ZnVuY3Rpb24gYihhKXsoQWMoYSk/cWIoYSk6YSkuWD1udWxsO3JldHVybiBhfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGIuY2FsbCh0aGlzLGMpO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYyxmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5iPWI7Yy5hPWE7cmV0dXJuIGN9KCk7cmV0dXJuIG5ldyB4ZShhLmI/YS5iKGMpOmEuY2FsbChudWxsLGMpLGIpfWZ1bmN0aW9uIEFlKGEsYixjKXt0aGlzLmZhPWE7dGhpcy5LYj1iO3RoaXMuYWM9Y31cbkFlLnByb3RvdHlwZS5nYT1mdW5jdGlvbigpe2Zvcih2YXIgYT1EKHRoaXMuS2IpOzspaWYobnVsbCE9YSl7dmFyIGI9RyhhKTtpZihBYShiLmdhKCkpKXJldHVybiExO2E9SyhhKX1lbHNlIHJldHVybiEwfTtBZS5wcm90b3R5cGUubmV4dD1mdW5jdGlvbigpe2Zvcih2YXIgYT10aGlzLktiLmxlbmd0aCxiPTA7OylpZihiPGEpdGhpcy5hY1tiXT10aGlzLktiW2JdLm5leHQoKSxiKz0xO2Vsc2UgYnJlYWs7cmV0dXJuIEpjLmEodGhpcy5hYywwKX07QWUucHJvdG90eXBlLnN0ZXA9ZnVuY3Rpb24oYSl7Zm9yKDs7KXt2YXIgYjtiPShiPW51bGwhPWEuWCk/dGhpcy5nYSgpOmI7aWYodChiKSlpZihBYyhULmEodGhpcy5mYSxNKGEsdGhpcy5uZXh0KCkpKSkpbnVsbCE9YS5NJiYoYS5NLlg9bnVsbCk7ZWxzZSBjb250aW51ZTticmVha31yZXR1cm4gbnVsbD09YS5YP251bGw6dGhpcy5mYS5iP3RoaXMuZmEuYihhKTp0aGlzLmZhLmNhbGwobnVsbCxhKX07XG52YXIgQmU9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjKXt2YXIgZz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYixjKXtiLmZpcnN0PWM7Yi5NPW5ldyB6ZShiLlgsbnVsbCxudWxsLG51bGwpO2IuWD1udWxsO3JldHVybiBiLk19ZnVuY3Rpb24gYihhKXthPUFjKGEpP3FiKGEpOmE7YS5YPW51bGw7cmV0dXJuIGF9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYi5jYWxsKHRoaXMsYyk7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxjLGQpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmI9YjtjLmE9YTtyZXR1cm4gY30oKTtyZXR1cm4gbmV3IEFlKGEuYj9hLmIoZyk6YS5jYWxsKG51bGwsZyksYixjKX1mdW5jdGlvbiBiKGEsYil7cmV0dXJuIGMuYyhhLGIsQXJyYXkoYi5sZW5ndGgpKX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIGIuY2FsbCh0aGlzLFxuYyxlKTtjYXNlIDM6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSxmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5hPWI7Yy5jPWE7cmV0dXJuIGN9KCk7ZnVuY3Rpb24gemUoYSxiLGMsZCl7dGhpcy5YPWE7dGhpcy5maXJzdD1iO3RoaXMuTT1jO3RoaXMuaz1kO3RoaXMucT0wO3RoaXMuaj0zMTcxOTYyOH1rPXplLnByb3RvdHlwZTtrLlQ9ZnVuY3Rpb24oKXtudWxsIT10aGlzLlgmJkNiKHRoaXMpO3JldHVybiBudWxsPT10aGlzLk0/bnVsbDpDYih0aGlzLk0pfTtrLk49ZnVuY3Rpb24oKXtudWxsIT10aGlzLlgmJkNiKHRoaXMpO3JldHVybiBudWxsPT10aGlzLk0/bnVsbDp0aGlzLmZpcnN0fTtrLlM9ZnVuY3Rpb24oKXtudWxsIT10aGlzLlgmJkNiKHRoaXMpO3JldHVybiBudWxsPT10aGlzLk0/Sjp0aGlzLk19O1xuay5EPWZ1bmN0aW9uKCl7bnVsbCE9dGhpcy5YJiZ0aGlzLlguc3RlcCh0aGlzKTtyZXR1cm4gbnVsbD09dGhpcy5NP251bGw6dGhpc307ay5CPWZ1bmN0aW9uKCl7cmV0dXJuIHdjKHRoaXMpfTtrLkE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbnVsbCE9Q2IodGhpcyk/SWModGhpcyxiKTpjZChiKSYmbnVsbD09RChiKX07ay5KPWZ1bmN0aW9uKCl7cmV0dXJuIEp9O2suRz1mdW5jdGlvbihhLGIpe3JldHVybiBNKGIsQ2IodGhpcykpfTtrLkY9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IHplKHRoaXMuWCx0aGlzLmZpcnN0LHRoaXMuTSxiKX07emUucHJvdG90eXBlW0VhXT1mdW5jdGlvbigpe3JldHVybiB1Yyh0aGlzKX07XG52YXIgQ2U9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEpe3JldHVybiBrZChhKT9hOihhPUQoYSkpP2E6Sn12YXIgYj1udWxsLGM9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGMsZCxoKXt2YXIgbD1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBsPTAsbT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2w8bS5sZW5ndGg7KW1bbF09YXJndW1lbnRzW2wrMl0sKytsO2w9bmV3IEYobSwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsYyxkLGwpfWZ1bmN0aW9uIGIoYSxjLGQpe2Q9cmQoTShjLGQpKTtjPVtdO2Q9RChkKTtmb3IodmFyIGU9bnVsbCxtPTAscD0wOzspaWYocDxtKXt2YXIgcT1lLlEobnVsbCxwKTtjLnB1c2god2UocSkpO3ArPTF9ZWxzZSBpZihkPUQoZCkpZT1kLGZkKGUpPyhkPVliKGUpLHA9WmIoZSksZT1kLG09UShkKSxkPXApOihkPUcoZSksYy5wdXNoKHdlKGQpKSxkPUsoZSksZT1udWxsLG09MCkscD0wO2Vsc2UgYnJlYWs7cmV0dXJuIG5ldyB6ZShCZS5jKGEsYyxcbkFycmF5KGMubGVuZ3RoKSksbnVsbCxudWxsLG51bGwpfWEuaT0yO2EuZj1mdW5jdGlvbihhKXt2YXIgYz1HKGEpO2E9SyhhKTt2YXIgZD1HKGEpO2E9SChhKTtyZXR1cm4gYihjLGQsYSl9O2EuZD1iO3JldHVybiBhfSgpLGI9ZnVuY3Rpb24oYixlLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGEuY2FsbCh0aGlzLGIpO2Nhc2UgMjpyZXR1cm4gbmV3IHplKHllKGIsd2UoZSkpLG51bGwsbnVsbCxudWxsKTtkZWZhdWx0OnZhciBnPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGc9MCxoPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7ZzxoLmxlbmd0aDspaFtnXT1hcmd1bWVudHNbZysyXSwrK2c7Zz1uZXcgRihoLDApfXJldHVybiBjLmQoYixlLGcpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtiLmk9MjtiLmY9Yy5mO2IuYj1hO2IuYT1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgemUoeWUoYSxcbndlKGIpKSxudWxsLG51bGwsbnVsbCl9O2IuZD1jLmQ7cmV0dXJuIGJ9KCk7ZnVuY3Rpb24gRWUoYSxiKXtmb3IoOzspe2lmKG51bGw9PUQoYikpcmV0dXJuITA7dmFyIGM7Yz1HKGIpO2M9YS5iP2EuYihjKTphLmNhbGwobnVsbCxjKTtpZih0KGMpKXtjPWE7dmFyIGQ9SyhiKTthPWM7Yj1kfWVsc2UgcmV0dXJuITF9fWZ1bmN0aW9uIEZlKGEsYil7Zm9yKDs7KWlmKEQoYikpe3ZhciBjO2M9RyhiKTtjPWEuYj9hLmIoYyk6YS5jYWxsKG51bGwsYyk7aWYodChjKSlyZXR1cm4gYztjPWE7dmFyIGQ9SyhiKTthPWM7Yj1kfWVsc2UgcmV0dXJuIG51bGx9ZnVuY3Rpb24gR2UoYSl7aWYoXCJudW1iZXJcIj09PXR5cGVvZiBhJiZBYShpc05hTihhKSkmJkluZmluaXR5IT09YSYmcGFyc2VGbG9hdChhKT09PXBhcnNlSW50KGEsMTApKXJldHVybiAwPT09KGEmMSk7dGhyb3cgRXJyb3IoW3ooXCJBcmd1bWVudCBtdXN0IGJlIGFuIGludGVnZXI6IFwiKSx6KGEpXS5qb2luKFwiXCIpKTt9XG5mdW5jdGlvbiBIZShhKXtyZXR1cm4gZnVuY3Rpb24oKXtmdW5jdGlvbiBiKGIsYyl7cmV0dXJuIEFhKGEuYT9hLmEoYixjKTphLmNhbGwobnVsbCxiLGMpKX1mdW5jdGlvbiBjKGIpe3JldHVybiBBYShhLmI/YS5iKGIpOmEuY2FsbChudWxsLGIpKX1mdW5jdGlvbiBkKCl7cmV0dXJuIEFhKGEubD9hLmwoKTphLmNhbGwobnVsbCkpfXZhciBlPW51bGwsZj1mdW5jdGlvbigpe2Z1bmN0aW9uIGIoYSxkLGUpe3ZhciBmPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGY9MCxnPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7ZjxnLmxlbmd0aDspZ1tmXT1hcmd1bWVudHNbZisyXSwrK2Y7Zj1uZXcgRihnLDApfXJldHVybiBjLmNhbGwodGhpcyxhLGQsZil9ZnVuY3Rpb24gYyhiLGQsZSl7cmV0dXJuIEFhKFQubihhLGIsZCxlKSl9Yi5pPTI7Yi5mPWZ1bmN0aW9uKGEpe3ZhciBiPUcoYSk7YT1LKGEpO3ZhciBkPUcoYSk7YT1IKGEpO3JldHVybiBjKGIsZCxhKX07Yi5kPWM7XG5yZXR1cm4gYn0oKSxlPWZ1bmN0aW9uKGEsZSxsKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAwOnJldHVybiBkLmNhbGwodGhpcyk7Y2FzZSAxOnJldHVybiBjLmNhbGwodGhpcyxhKTtjYXNlIDI6cmV0dXJuIGIuY2FsbCh0aGlzLGEsZSk7ZGVmYXVsdDp2YXIgbT1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBtPTAscD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO208cC5sZW5ndGg7KXBbbV09YXJndW1lbnRzW20rMl0sKyttO209bmV3IEYocCwwKX1yZXR1cm4gZi5kKGEsZSxtKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307ZS5pPTI7ZS5mPWYuZjtlLmw9ZDtlLmI9YztlLmE9YjtlLmQ9Zi5kO3JldHVybiBlfSgpfVxudmFyIEllPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyl7cmV0dXJuIGZ1bmN0aW9uKCl7ZnVuY3Rpb24gZChoLGwsbSl7aD1jLmM/Yy5jKGgsbCxtKTpjLmNhbGwobnVsbCxoLGwsbSk7aD1iLmI/Yi5iKGgpOmIuY2FsbChudWxsLGgpO3JldHVybiBhLmI/YS5iKGgpOmEuY2FsbChudWxsLGgpfWZ1bmN0aW9uIGwoZCxoKXt2YXIgbDtsPWMuYT9jLmEoZCxoKTpjLmNhbGwobnVsbCxkLGgpO2w9Yi5iP2IuYihsKTpiLmNhbGwobnVsbCxsKTtyZXR1cm4gYS5iP2EuYihsKTphLmNhbGwobnVsbCxsKX1mdW5jdGlvbiBtKGQpe2Q9Yy5iP2MuYihkKTpjLmNhbGwobnVsbCxkKTtkPWIuYj9iLmIoZCk6Yi5jYWxsKG51bGwsZCk7cmV0dXJuIGEuYj9hLmIoZCk6YS5jYWxsKG51bGwsZCl9ZnVuY3Rpb24gcCgpe3ZhciBkO2Q9Yy5sP2MubCgpOmMuY2FsbChudWxsKTtkPWIuYj9iLmIoZCk6Yi5jYWxsKG51bGwsZCk7cmV0dXJuIGEuYj9hLmIoZCk6YS5jYWxsKG51bGwsZCl9dmFyIHE9bnVsbCxcbnM9ZnVuY3Rpb24oKXtmdW5jdGlvbiBkKGEsYixjLGUpe3ZhciBmPW51bGw7aWYoMzxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGY9MCxnPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMyk7ZjxnLmxlbmd0aDspZ1tmXT1hcmd1bWVudHNbZiszXSwrK2Y7Zj1uZXcgRihnLDApfXJldHVybiBoLmNhbGwodGhpcyxhLGIsYyxmKX1mdW5jdGlvbiBoKGQsbCxtLHApe2Q9VC5yKGMsZCxsLG0scCk7ZD1iLmI/Yi5iKGQpOmIuY2FsbChudWxsLGQpO3JldHVybiBhLmI/YS5iKGQpOmEuY2FsbChudWxsLGQpfWQuaT0zO2QuZj1mdW5jdGlvbihhKXt2YXIgYj1HKGEpO2E9SyhhKTt2YXIgYz1HKGEpO2E9SyhhKTt2YXIgZD1HKGEpO2E9SChhKTtyZXR1cm4gaChiLGMsZCxhKX07ZC5kPWg7cmV0dXJuIGR9KCkscT1mdW5jdGlvbihhLGIsYyxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAwOnJldHVybiBwLmNhbGwodGhpcyk7Y2FzZSAxOnJldHVybiBtLmNhbGwodGhpcyxhKTtjYXNlIDI6cmV0dXJuIGwuY2FsbCh0aGlzLFxuYSxiKTtjYXNlIDM6cmV0dXJuIGQuY2FsbCh0aGlzLGEsYixjKTtkZWZhdWx0OnZhciBmPW51bGw7aWYoMzxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGY9MCxnPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMyk7ZjxnLmxlbmd0aDspZ1tmXT1hcmd1bWVudHNbZiszXSwrK2Y7Zj1uZXcgRihnLDApfXJldHVybiBzLmQoYSxiLGMsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O3EuaT0zO3EuZj1zLmY7cS5sPXA7cS5iPW07cS5hPWw7cS5jPWQ7cS5kPXMuZDtyZXR1cm4gcX0oKX1mdW5jdGlvbiBiKGEsYil7cmV0dXJuIGZ1bmN0aW9uKCl7ZnVuY3Rpb24gYyhkLGcsaCl7ZD1iLmM/Yi5jKGQsZyxoKTpiLmNhbGwobnVsbCxkLGcsaCk7cmV0dXJuIGEuYj9hLmIoZCk6YS5jYWxsKG51bGwsZCl9ZnVuY3Rpb24gZChjLGcpe3ZhciBoPWIuYT9iLmEoYyxnKTpiLmNhbGwobnVsbCxjLGcpO3JldHVybiBhLmI/YS5iKGgpOmEuY2FsbChudWxsLGgpfVxuZnVuY3Rpb24gbChjKXtjPWIuYj9iLmIoYyk6Yi5jYWxsKG51bGwsYyk7cmV0dXJuIGEuYj9hLmIoYyk6YS5jYWxsKG51bGwsYyl9ZnVuY3Rpb24gbSgpe3ZhciBjPWIubD9iLmwoKTpiLmNhbGwobnVsbCk7cmV0dXJuIGEuYj9hLmIoYyk6YS5jYWxsKG51bGwsYyl9dmFyIHA9bnVsbCxxPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYyhhLGIsZSxmKXt2YXIgZz1udWxsO2lmKDM8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBnPTAsaD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTMpO2c8aC5sZW5ndGg7KWhbZ109YXJndW1lbnRzW2crM10sKytnO2c9bmV3IEYoaCwwKX1yZXR1cm4gZC5jYWxsKHRoaXMsYSxiLGUsZyl9ZnVuY3Rpb24gZChjLGcsaCxsKXtjPVQucihiLGMsZyxoLGwpO3JldHVybiBhLmI/YS5iKGMpOmEuY2FsbChudWxsLGMpfWMuaT0zO2MuZj1mdW5jdGlvbihhKXt2YXIgYj1HKGEpO2E9SyhhKTt2YXIgYz1HKGEpO2E9SyhhKTt2YXIgZT1HKGEpO2E9SChhKTtyZXR1cm4gZChiLFxuYyxlLGEpfTtjLmQ9ZDtyZXR1cm4gY30oKSxwPWZ1bmN0aW9uKGEsYixlLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDA6cmV0dXJuIG0uY2FsbCh0aGlzKTtjYXNlIDE6cmV0dXJuIGwuY2FsbCh0aGlzLGEpO2Nhc2UgMjpyZXR1cm4gZC5jYWxsKHRoaXMsYSxiKTtjYXNlIDM6cmV0dXJuIGMuY2FsbCh0aGlzLGEsYixlKTtkZWZhdWx0OnZhciBwPW51bGw7aWYoMzxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIHA9MCxFPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMyk7cDxFLmxlbmd0aDspRVtwXT1hcmd1bWVudHNbcCszXSwrK3A7cD1uZXcgRihFLDApfXJldHVybiBxLmQoYSxiLGUscCl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O3AuaT0zO3AuZj1xLmY7cC5sPW07cC5iPWw7cC5hPWQ7cC5jPWM7cC5kPXEuZDtyZXR1cm4gcH0oKX12YXIgYz1udWxsLGQ9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGMsZCxlLG0pe3ZhciBwPW51bGw7XG5pZigzPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgcD0wLHE9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0zKTtwPHEubGVuZ3RoOylxW3BdPWFyZ3VtZW50c1twKzNdLCsrcDtwPW5ldyBGKHEsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGMsZCxlLHApfWZ1bmN0aW9uIGIoYSxjLGQsZSl7cmV0dXJuIGZ1bmN0aW9uKGEpe3JldHVybiBmdW5jdGlvbigpe2Z1bmN0aW9uIGIoYSl7dmFyIGQ9bnVsbDtpZigwPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZD0wLGU9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0wKTtkPGUubGVuZ3RoOyllW2RdPWFyZ3VtZW50c1tkKzBdLCsrZDtkPW5ldyBGKGUsMCl9cmV0dXJuIGMuY2FsbCh0aGlzLGQpfWZ1bmN0aW9uIGMoYil7Yj1ULmEoRyhhKSxiKTtmb3IodmFyIGQ9SyhhKTs7KWlmKGQpYj1HKGQpLmNhbGwobnVsbCxiKSxkPUsoZCk7ZWxzZSByZXR1cm4gYn1iLmk9MDtiLmY9ZnVuY3Rpb24oYSl7YT1EKGEpO3JldHVybiBjKGEpfTtiLmQ9YztyZXR1cm4gYn0oKX0oSmQoYmUubihhLFxuYyxkLGUpKSl9YS5pPTM7YS5mPWZ1bmN0aW9uKGEpe3ZhciBjPUcoYSk7YT1LKGEpO3ZhciBkPUcoYSk7YT1LKGEpO3ZhciBlPUcoYSk7YT1IKGEpO3JldHVybiBiKGMsZCxlLGEpfTthLmQ9YjtyZXR1cm4gYX0oKSxjPWZ1bmN0aW9uKGMsZixnLGgpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDA6cmV0dXJuIHVkO2Nhc2UgMTpyZXR1cm4gYztjYXNlIDI6cmV0dXJuIGIuY2FsbCh0aGlzLGMsZik7Y2FzZSAzOnJldHVybiBhLmNhbGwodGhpcyxjLGYsZyk7ZGVmYXVsdDp2YXIgbD1udWxsO2lmKDM8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBsPTAsbT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTMpO2w8bS5sZW5ndGg7KW1bbF09YXJndW1lbnRzW2wrM10sKytsO2w9bmV3IEYobSwwKX1yZXR1cm4gZC5kKGMsZixnLGwpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmk9MztjLmY9ZC5mO2MubD1mdW5jdGlvbigpe3JldHVybiB1ZH07XG5jLmI9ZnVuY3Rpb24oYSl7cmV0dXJuIGF9O2MuYT1iO2MuYz1hO2MuZD1kLmQ7cmV0dXJuIGN9KCksSmU9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjLGQpe3JldHVybiBmdW5jdGlvbigpe2Z1bmN0aW9uIGUobSxwLHEpe3JldHVybiBhLlA/YS5QKGIsYyxkLG0scCxxKTphLmNhbGwobnVsbCxiLGMsZCxtLHAscSl9ZnVuY3Rpb24gcChlLG0pe3JldHVybiBhLnI/YS5yKGIsYyxkLGUsbSk6YS5jYWxsKG51bGwsYixjLGQsZSxtKX1mdW5jdGlvbiBxKGUpe3JldHVybiBhLm4/YS5uKGIsYyxkLGUpOmEuY2FsbChudWxsLGIsYyxkLGUpfWZ1bmN0aW9uIHMoKXtyZXR1cm4gYS5jP2EuYyhiLGMsZCk6YS5jYWxsKG51bGwsYixjLGQpfXZhciB1PW51bGwsdj1mdW5jdGlvbigpe2Z1bmN0aW9uIGUoYSxiLGMsZCl7dmFyIGY9bnVsbDtpZigzPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZj0wLGc9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0zKTtmPGcubGVuZ3RoOylnW2ZdPWFyZ3VtZW50c1tmK1xuM10sKytmO2Y9bmV3IEYoZywwKX1yZXR1cm4gbS5jYWxsKHRoaXMsYSxiLGMsZil9ZnVuY3Rpb24gbShlLHAscSxzKXtyZXR1cm4gVC5kKGEsYixjLGQsZSxLYyhbcCxxLHNdLDApKX1lLmk9MztlLmY9ZnVuY3Rpb24oYSl7dmFyIGI9RyhhKTthPUsoYSk7dmFyIGM9RyhhKTthPUsoYSk7dmFyIGQ9RyhhKTthPUgoYSk7cmV0dXJuIG0oYixjLGQsYSl9O2UuZD1tO3JldHVybiBlfSgpLHU9ZnVuY3Rpb24oYSxiLGMsZCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMDpyZXR1cm4gcy5jYWxsKHRoaXMpO2Nhc2UgMTpyZXR1cm4gcS5jYWxsKHRoaXMsYSk7Y2FzZSAyOnJldHVybiBwLmNhbGwodGhpcyxhLGIpO2Nhc2UgMzpyZXR1cm4gZS5jYWxsKHRoaXMsYSxiLGMpO2RlZmF1bHQ6dmFyIGY9bnVsbDtpZigzPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZj0wLGc9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0zKTtmPGcubGVuZ3RoOylnW2ZdPWFyZ3VtZW50c1tmKzNdLCsrZjtmPVxubmV3IEYoZywwKX1yZXR1cm4gdi5kKGEsYixjLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTt1Lmk9Mzt1LmY9di5mO3UubD1zO3UuYj1xO3UuYT1wO3UuYz1lO3UuZD12LmQ7cmV0dXJuIHV9KCl9ZnVuY3Rpb24gYihhLGIsYyl7cmV0dXJuIGZ1bmN0aW9uKCl7ZnVuY3Rpb24gZChlLGwsbSl7cmV0dXJuIGEucj9hLnIoYixjLGUsbCxtKTphLmNhbGwobnVsbCxiLGMsZSxsLG0pfWZ1bmN0aW9uIGUoZCxsKXtyZXR1cm4gYS5uP2EubihiLGMsZCxsKTphLmNhbGwobnVsbCxiLGMsZCxsKX1mdW5jdGlvbiBwKGQpe3JldHVybiBhLmM/YS5jKGIsYyxkKTphLmNhbGwobnVsbCxiLGMsZCl9ZnVuY3Rpb24gcSgpe3JldHVybiBhLmE/YS5hKGIsYyk6YS5jYWxsKG51bGwsYixjKX12YXIgcz1udWxsLHU9ZnVuY3Rpb24oKXtmdW5jdGlvbiBkKGEsYixjLGYpe3ZhciBnPW51bGw7aWYoMzxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGc9MCxoPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtXG4zKTtnPGgubGVuZ3RoOyloW2ddPWFyZ3VtZW50c1tnKzNdLCsrZztnPW5ldyBGKGgsMCl9cmV0dXJuIGUuY2FsbCh0aGlzLGEsYixjLGcpfWZ1bmN0aW9uIGUoZCxsLG0scCl7cmV0dXJuIFQuZChhLGIsYyxkLGwsS2MoW20scF0sMCkpfWQuaT0zO2QuZj1mdW5jdGlvbihhKXt2YXIgYj1HKGEpO2E9SyhhKTt2YXIgYz1HKGEpO2E9SyhhKTt2YXIgZD1HKGEpO2E9SChhKTtyZXR1cm4gZShiLGMsZCxhKX07ZC5kPWU7cmV0dXJuIGR9KCkscz1mdW5jdGlvbihhLGIsYyxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAwOnJldHVybiBxLmNhbGwodGhpcyk7Y2FzZSAxOnJldHVybiBwLmNhbGwodGhpcyxhKTtjYXNlIDI6cmV0dXJuIGUuY2FsbCh0aGlzLGEsYik7Y2FzZSAzOnJldHVybiBkLmNhbGwodGhpcyxhLGIsYyk7ZGVmYXVsdDp2YXIgZz1udWxsO2lmKDM8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBnPTAsaD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTMpO2c8aC5sZW5ndGg7KWhbZ109XG5hcmd1bWVudHNbZyszXSwrK2c7Zz1uZXcgRihoLDApfXJldHVybiB1LmQoYSxiLGMsZyl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O3MuaT0zO3MuZj11LmY7cy5sPXE7cy5iPXA7cy5hPWU7cy5jPWQ7cy5kPXUuZDtyZXR1cm4gc30oKX1mdW5jdGlvbiBjKGEsYil7cmV0dXJuIGZ1bmN0aW9uKCl7ZnVuY3Rpb24gYyhkLGUsaCl7cmV0dXJuIGEubj9hLm4oYixkLGUsaCk6YS5jYWxsKG51bGwsYixkLGUsaCl9ZnVuY3Rpb24gZChjLGUpe3JldHVybiBhLmM/YS5jKGIsYyxlKTphLmNhbGwobnVsbCxiLGMsZSl9ZnVuY3Rpb24gZShjKXtyZXR1cm4gYS5hP2EuYShiLGMpOmEuY2FsbChudWxsLGIsYyl9ZnVuY3Rpb24gcCgpe3JldHVybiBhLmI/YS5iKGIpOmEuY2FsbChudWxsLGIpfXZhciBxPW51bGwscz1mdW5jdGlvbigpe2Z1bmN0aW9uIGMoYSxiLGUsZil7dmFyIGc9bnVsbDtpZigzPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZz0wLFxuaD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTMpO2c8aC5sZW5ndGg7KWhbZ109YXJndW1lbnRzW2crM10sKytnO2c9bmV3IEYoaCwwKX1yZXR1cm4gZC5jYWxsKHRoaXMsYSxiLGUsZyl9ZnVuY3Rpb24gZChjLGUsaCxsKXtyZXR1cm4gVC5kKGEsYixjLGUsaCxLYyhbbF0sMCkpfWMuaT0zO2MuZj1mdW5jdGlvbihhKXt2YXIgYj1HKGEpO2E9SyhhKTt2YXIgYz1HKGEpO2E9SyhhKTt2YXIgZT1HKGEpO2E9SChhKTtyZXR1cm4gZChiLGMsZSxhKX07Yy5kPWQ7cmV0dXJuIGN9KCkscT1mdW5jdGlvbihhLGIsZixnKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAwOnJldHVybiBwLmNhbGwodGhpcyk7Y2FzZSAxOnJldHVybiBlLmNhbGwodGhpcyxhKTtjYXNlIDI6cmV0dXJuIGQuY2FsbCh0aGlzLGEsYik7Y2FzZSAzOnJldHVybiBjLmNhbGwodGhpcyxhLGIsZik7ZGVmYXVsdDp2YXIgcT1udWxsO2lmKDM8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBxPTAsTj1BcnJheShhcmd1bWVudHMubGVuZ3RoLVxuMyk7cTxOLmxlbmd0aDspTltxXT1hcmd1bWVudHNbcSszXSwrK3E7cT1uZXcgRihOLDApfXJldHVybiBzLmQoYSxiLGYscSl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O3EuaT0zO3EuZj1zLmY7cS5sPXA7cS5iPWU7cS5hPWQ7cS5jPWM7cS5kPXMuZDtyZXR1cm4gcX0oKX12YXIgZD1udWxsLGU9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGMsZCxlLGYscSl7dmFyIHM9bnVsbDtpZig0PGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgcz0wLHU9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC00KTtzPHUubGVuZ3RoOyl1W3NdPWFyZ3VtZW50c1tzKzRdLCsrcztzPW5ldyBGKHUsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGMsZCxlLGYscyl9ZnVuY3Rpb24gYihhLGMsZCxlLGYpe3JldHVybiBmdW5jdGlvbigpe2Z1bmN0aW9uIGIoYSl7dmFyIGM9bnVsbDtpZigwPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgYz0wLGQ9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC1cbjApO2M8ZC5sZW5ndGg7KWRbY109YXJndW1lbnRzW2MrMF0sKytjO2M9bmV3IEYoZCwwKX1yZXR1cm4gZy5jYWxsKHRoaXMsYyl9ZnVuY3Rpb24gZyhiKXtyZXR1cm4gVC5yKGEsYyxkLGUsYWUuYShmLGIpKX1iLmk9MDtiLmY9ZnVuY3Rpb24oYSl7YT1EKGEpO3JldHVybiBnKGEpfTtiLmQ9ZztyZXR1cm4gYn0oKX1hLmk9NDthLmY9ZnVuY3Rpb24oYSl7dmFyIGM9RyhhKTthPUsoYSk7dmFyIGQ9RyhhKTthPUsoYSk7dmFyIGU9RyhhKTthPUsoYSk7dmFyIGY9RyhhKTthPUgoYSk7cmV0dXJuIGIoYyxkLGUsZixhKX07YS5kPWI7cmV0dXJuIGF9KCksZD1mdW5jdGlvbihkLGcsaCxsLG0pe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGQ7Y2FzZSAyOnJldHVybiBjLmNhbGwodGhpcyxkLGcpO2Nhc2UgMzpyZXR1cm4gYi5jYWxsKHRoaXMsZCxnLGgpO2Nhc2UgNDpyZXR1cm4gYS5jYWxsKHRoaXMsZCxnLGgsbCk7ZGVmYXVsdDp2YXIgcD1udWxsO2lmKDQ8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBwPVxuMCxxPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtNCk7cDxxLmxlbmd0aDspcVtwXT1hcmd1bWVudHNbcCs0XSwrK3A7cD1uZXcgRihxLDApfXJldHVybiBlLmQoZCxnLGgsbCxwKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307ZC5pPTQ7ZC5mPWUuZjtkLmI9ZnVuY3Rpb24oYSl7cmV0dXJuIGF9O2QuYT1jO2QuYz1iO2Qubj1hO2QuZD1lLmQ7cmV0dXJuIGR9KCksS2U9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjLGQpe3JldHVybiBmdW5jdGlvbigpe2Z1bmN0aW9uIGwobCxtLHApe2w9bnVsbD09bD9iOmw7bT1udWxsPT1tP2M6bTtwPW51bGw9PXA/ZDpwO3JldHVybiBhLmM/YS5jKGwsbSxwKTphLmNhbGwobnVsbCxsLG0scCl9ZnVuY3Rpb24gbShkLGgpe3ZhciBsPW51bGw9PWQ/YjpkLG09bnVsbD09aD9jOmg7cmV0dXJuIGEuYT9hLmEobCxtKTphLmNhbGwobnVsbCxsLG0pfXZhciBwPW51bGwscT1mdW5jdGlvbigpe2Z1bmN0aW9uIGwoYSxcbmIsYyxkKXt2YXIgZT1udWxsO2lmKDM8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBlPTAsZj1BcnJheShhcmd1bWVudHMubGVuZ3RoLTMpO2U8Zi5sZW5ndGg7KWZbZV09YXJndW1lbnRzW2UrM10sKytlO2U9bmV3IEYoZiwwKX1yZXR1cm4gbS5jYWxsKHRoaXMsYSxiLGMsZSl9ZnVuY3Rpb24gbShsLHAscSxzKXtyZXR1cm4gVC5yKGEsbnVsbD09bD9iOmwsbnVsbD09cD9jOnAsbnVsbD09cT9kOnEscyl9bC5pPTM7bC5mPWZ1bmN0aW9uKGEpe3ZhciBiPUcoYSk7YT1LKGEpO3ZhciBjPUcoYSk7YT1LKGEpO3ZhciBkPUcoYSk7YT1IKGEpO3JldHVybiBtKGIsYyxkLGEpfTtsLmQ9bTtyZXR1cm4gbH0oKSxwPWZ1bmN0aW9uKGEsYixjLGQpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIG0uY2FsbCh0aGlzLGEsYik7Y2FzZSAzOnJldHVybiBsLmNhbGwodGhpcyxhLGIsYyk7ZGVmYXVsdDp2YXIgZT1udWxsO2lmKDM8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBlPVxuMCxmPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMyk7ZTxmLmxlbmd0aDspZltlXT1hcmd1bWVudHNbZSszXSwrK2U7ZT1uZXcgRihmLDApfXJldHVybiBxLmQoYSxiLGMsZSl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O3AuaT0zO3AuZj1xLmY7cC5hPW07cC5jPWw7cC5kPXEuZDtyZXR1cm4gcH0oKX1mdW5jdGlvbiBiKGEsYixjKXtyZXR1cm4gZnVuY3Rpb24oKXtmdW5jdGlvbiBkKGgsbCxtKXtoPW51bGw9PWg/YjpoO2w9bnVsbD09bD9jOmw7cmV0dXJuIGEuYz9hLmMoaCxsLG0pOmEuY2FsbChudWxsLGgsbCxtKX1mdW5jdGlvbiBsKGQsaCl7dmFyIGw9bnVsbD09ZD9iOmQsbT1udWxsPT1oP2M6aDtyZXR1cm4gYS5hP2EuYShsLG0pOmEuY2FsbChudWxsLGwsbSl9dmFyIG09bnVsbCxwPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gZChhLGIsYyxlKXt2YXIgZj1udWxsO2lmKDM8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBmPTAsZz1BcnJheShhcmd1bWVudHMubGVuZ3RoLVxuMyk7ZjxnLmxlbmd0aDspZ1tmXT1hcmd1bWVudHNbZiszXSwrK2Y7Zj1uZXcgRihnLDApfXJldHVybiBoLmNhbGwodGhpcyxhLGIsYyxmKX1mdW5jdGlvbiBoKGQsbCxtLHApe3JldHVybiBULnIoYSxudWxsPT1kP2I6ZCxudWxsPT1sP2M6bCxtLHApfWQuaT0zO2QuZj1mdW5jdGlvbihhKXt2YXIgYj1HKGEpO2E9SyhhKTt2YXIgYz1HKGEpO2E9SyhhKTt2YXIgZD1HKGEpO2E9SChhKTtyZXR1cm4gaChiLGMsZCxhKX07ZC5kPWg7cmV0dXJuIGR9KCksbT1mdW5jdGlvbihhLGIsYyxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiBsLmNhbGwodGhpcyxhLGIpO2Nhc2UgMzpyZXR1cm4gZC5jYWxsKHRoaXMsYSxiLGMpO2RlZmF1bHQ6dmFyIGY9bnVsbDtpZigzPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZj0wLGc9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0zKTtmPGcubGVuZ3RoOylnW2ZdPWFyZ3VtZW50c1tmKzNdLCsrZjtmPW5ldyBGKGcsMCl9cmV0dXJuIHAuZChhLFxuYixjLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTttLmk9MzttLmY9cC5mO20uYT1sO20uYz1kO20uZD1wLmQ7cmV0dXJuIG19KCl9ZnVuY3Rpb24gYyhhLGIpe3JldHVybiBmdW5jdGlvbigpe2Z1bmN0aW9uIGMoZCxnLGgpe2Q9bnVsbD09ZD9iOmQ7cmV0dXJuIGEuYz9hLmMoZCxnLGgpOmEuY2FsbChudWxsLGQsZyxoKX1mdW5jdGlvbiBkKGMsZyl7dmFyIGg9bnVsbD09Yz9iOmM7cmV0dXJuIGEuYT9hLmEoaCxnKTphLmNhbGwobnVsbCxoLGcpfWZ1bmN0aW9uIGwoYyl7Yz1udWxsPT1jP2I6YztyZXR1cm4gYS5iP2EuYihjKTphLmNhbGwobnVsbCxjKX12YXIgbT1udWxsLHA9ZnVuY3Rpb24oKXtmdW5jdGlvbiBjKGEsYixlLGYpe3ZhciBnPW51bGw7aWYoMzxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGc9MCxoPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMyk7ZzxoLmxlbmd0aDspaFtnXT1hcmd1bWVudHNbZyszXSwrK2c7Zz1uZXcgRihoLFxuMCl9cmV0dXJuIGQuY2FsbCh0aGlzLGEsYixlLGcpfWZ1bmN0aW9uIGQoYyxnLGgsbCl7cmV0dXJuIFQucihhLG51bGw9PWM/YjpjLGcsaCxsKX1jLmk9MztjLmY9ZnVuY3Rpb24oYSl7dmFyIGI9RyhhKTthPUsoYSk7dmFyIGM9RyhhKTthPUsoYSk7dmFyIGU9RyhhKTthPUgoYSk7cmV0dXJuIGQoYixjLGUsYSl9O2MuZD1kO3JldHVybiBjfSgpLG09ZnVuY3Rpb24oYSxiLGUsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gbC5jYWxsKHRoaXMsYSk7Y2FzZSAyOnJldHVybiBkLmNhbGwodGhpcyxhLGIpO2Nhc2UgMzpyZXR1cm4gYy5jYWxsKHRoaXMsYSxiLGUpO2RlZmF1bHQ6dmFyIG09bnVsbDtpZigzPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgbT0wLEI9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0zKTttPEIubGVuZ3RoOylCW21dPWFyZ3VtZW50c1ttKzNdLCsrbTttPW5ldyBGKEIsMCl9cmV0dXJuIHAuZChhLGIsZSxtKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK1xuYXJndW1lbnRzLmxlbmd0aCk7fTttLmk9MzttLmY9cC5mO20uYj1sO20uYT1kO20uYz1jO20uZD1wLmQ7cmV0dXJuIG19KCl9dmFyIGQ9bnVsbCxkPWZ1bmN0aW9uKGQsZixnLGgpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIGMuY2FsbCh0aGlzLGQsZik7Y2FzZSAzOnJldHVybiBiLmNhbGwodGhpcyxkLGYsZyk7Y2FzZSA0OnJldHVybiBhLmNhbGwodGhpcyxkLGYsZyxoKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307ZC5hPWM7ZC5jPWI7ZC5uPWE7cmV0dXJuIGR9KCksTGU9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYil7cmV0dXJuIG5ldyBWKG51bGwsZnVuY3Rpb24oKXt2YXIgZj1EKGIpO2lmKGYpe2lmKGZkKGYpKXtmb3IodmFyIGc9WWIoZiksaD1RKGcpLGw9VGQoaCksbT0wOzspaWYobTxoKXt2YXIgcD1mdW5jdGlvbigpe3ZhciBiPUMuYShnLG0pO3JldHVybiBhLmI/YS5iKGIpOmEuY2FsbChudWxsLGIpfSgpO1xubnVsbCE9cCYmbC5hZGQocCk7bSs9MX1lbHNlIGJyZWFrO3JldHVybiBXZChsLmNhKCksYy5hKGEsWmIoZikpKX1oPWZ1bmN0aW9uKCl7dmFyIGI9RyhmKTtyZXR1cm4gYS5iP2EuYihiKTphLmNhbGwobnVsbCxiKX0oKTtyZXR1cm4gbnVsbD09aD9jLmEoYSxIKGYpKTpNKGgsYy5hKGEsSChmKSkpfXJldHVybiBudWxsfSxudWxsLG51bGwpfWZ1bmN0aW9uIGIoYSl7cmV0dXJuIGZ1bmN0aW9uKGIpe3JldHVybiBmdW5jdGlvbigpe2Z1bmN0aW9uIGMoZixnKXt2YXIgaD1hLmI/YS5iKGcpOmEuY2FsbChudWxsLGcpO3JldHVybiBudWxsPT1oP2Y6Yi5hP2IuYShmLGgpOmIuY2FsbChudWxsLGYsaCl9ZnVuY3Rpb24gZyhhKXtyZXR1cm4gYi5iP2IuYihhKTpiLmNhbGwobnVsbCxhKX1mdW5jdGlvbiBoKCl7cmV0dXJuIGIubD9iLmwoKTpiLmNhbGwobnVsbCl9dmFyIGw9bnVsbCxsPWZ1bmN0aW9uKGEsYil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMDpyZXR1cm4gaC5jYWxsKHRoaXMpO1xuY2FzZSAxOnJldHVybiBnLmNhbGwodGhpcyxhKTtjYXNlIDI6cmV0dXJuIGMuY2FsbCh0aGlzLGEsYil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2wubD1oO2wuYj1nO2wuYT1jO3JldHVybiBsfSgpfX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiLmNhbGwodGhpcyxjKTtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYj1iO2MuYT1hO3JldHVybiBjfSgpO2Z1bmN0aW9uIE1lKGEpe3RoaXMuc3RhdGU9YTt0aGlzLnE9MDt0aGlzLmo9MzI3Njh9TWUucHJvdG90eXBlLlJhPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuc3RhdGV9O01lLnByb3RvdHlwZS5iYj1mdW5jdGlvbihhLGIpe3JldHVybiB0aGlzLnN0YXRlPWJ9O1xudmFyIE5lPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIpe3JldHVybiBmdW5jdGlvbiBnKGIsYyl7cmV0dXJuIG5ldyBWKG51bGwsZnVuY3Rpb24oKXt2YXIgZT1EKGMpO2lmKGUpe2lmKGZkKGUpKXtmb3IodmFyIHA9WWIoZSkscT1RKHApLHM9VGQocSksdT0wOzspaWYodTxxKXt2YXIgdj1mdW5jdGlvbigpe3ZhciBjPWIrdSxlPUMuYShwLHUpO3JldHVybiBhLmE/YS5hKGMsZSk6YS5jYWxsKG51bGwsYyxlKX0oKTtudWxsIT12JiZzLmFkZCh2KTt1Kz0xfWVsc2UgYnJlYWs7cmV0dXJuIFdkKHMuY2EoKSxnKGIrcSxaYihlKSkpfXE9ZnVuY3Rpb24oKXt2YXIgYz1HKGUpO3JldHVybiBhLmE/YS5hKGIsYyk6YS5jYWxsKG51bGwsYixjKX0oKTtyZXR1cm4gbnVsbD09cT9nKGIrMSxIKGUpKTpNKHEsZyhiKzEsSChlKSkpfXJldHVybiBudWxsfSxudWxsLG51bGwpfSgwLGIpfWZ1bmN0aW9uIGIoYSl7cmV0dXJuIGZ1bmN0aW9uKGIpe3JldHVybiBmdW5jdGlvbihjKXtyZXR1cm4gZnVuY3Rpb24oKXtmdW5jdGlvbiBnKGcsXG5oKXt2YXIgbD1jLmJiKDAsYy5SYShudWxsKSsxKSxsPWEuYT9hLmEobCxoKTphLmNhbGwobnVsbCxsLGgpO3JldHVybiBudWxsPT1sP2c6Yi5hP2IuYShnLGwpOmIuY2FsbChudWxsLGcsbCl9ZnVuY3Rpb24gaChhKXtyZXR1cm4gYi5iP2IuYihhKTpiLmNhbGwobnVsbCxhKX1mdW5jdGlvbiBsKCl7cmV0dXJuIGIubD9iLmwoKTpiLmNhbGwobnVsbCl9dmFyIG09bnVsbCxtPWZ1bmN0aW9uKGEsYil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMDpyZXR1cm4gbC5jYWxsKHRoaXMpO2Nhc2UgMTpyZXR1cm4gaC5jYWxsKHRoaXMsYSk7Y2FzZSAyOnJldHVybiBnLmNhbGwodGhpcyxhLGIpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTttLmw9bDttLmI9aDttLmE9ZztyZXR1cm4gbX0oKX0obmV3IE1lKC0xKSl9fXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGIuY2FsbCh0aGlzLFxuYyk7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxjLGUpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmI9YjtjLmE9YTtyZXR1cm4gY30oKSxPZT1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMsZCl7cmV0dXJuIG5ldyBWKG51bGwsZnVuY3Rpb24oKXt2YXIgZj1EKGIpLHE9RChjKSxzPUQoZCk7aWYoZiYmcSYmcyl7dmFyIHU9TSx2O3Y9RyhmKTt2YXIgeT1HKHEpLEI9RyhzKTt2PWEuYz9hLmModix5LEIpOmEuY2FsbChudWxsLHYseSxCKTtmPXUodixlLm4oYSxIKGYpLEgocSksSChzKSkpfWVsc2UgZj1udWxsO3JldHVybiBmfSxudWxsLG51bGwpfWZ1bmN0aW9uIGIoYSxiLGMpe3JldHVybiBuZXcgVihudWxsLGZ1bmN0aW9uKCl7dmFyIGQ9RChiKSxmPUQoYyk7aWYoZCYmZil7dmFyIHE9TSxzO3M9RyhkKTt2YXIgdT1HKGYpO3M9YS5hP2EuYShzLHUpOmEuY2FsbChudWxsLHMsdSk7ZD1xKHMsZS5jKGEsSChkKSxIKGYpKSl9ZWxzZSBkPVxubnVsbDtyZXR1cm4gZH0sbnVsbCxudWxsKX1mdW5jdGlvbiBjKGEsYil7cmV0dXJuIG5ldyBWKG51bGwsZnVuY3Rpb24oKXt2YXIgYz1EKGIpO2lmKGMpe2lmKGZkKGMpKXtmb3IodmFyIGQ9WWIoYyksZj1RKGQpLHE9VGQoZikscz0wOzspaWYoczxmKVhkKHEsZnVuY3Rpb24oKXt2YXIgYj1DLmEoZCxzKTtyZXR1cm4gYS5iP2EuYihiKTphLmNhbGwobnVsbCxiKX0oKSkscys9MTtlbHNlIGJyZWFrO3JldHVybiBXZChxLmNhKCksZS5hKGEsWmIoYykpKX1yZXR1cm4gTShmdW5jdGlvbigpe3ZhciBiPUcoYyk7cmV0dXJuIGEuYj9hLmIoYik6YS5jYWxsKG51bGwsYil9KCksZS5hKGEsSChjKSkpfXJldHVybiBudWxsfSxudWxsLG51bGwpfWZ1bmN0aW9uIGQoYSl7cmV0dXJuIGZ1bmN0aW9uKGIpe3JldHVybiBmdW5jdGlvbigpe2Z1bmN0aW9uIGMoZCxlKXt2YXIgZj1hLmI/YS5iKGUpOmEuY2FsbChudWxsLGUpO3JldHVybiBiLmE/Yi5hKGQsZik6Yi5jYWxsKG51bGwsZCxmKX1mdW5jdGlvbiBkKGEpe3JldHVybiBiLmI/XG5iLmIoYSk6Yi5jYWxsKG51bGwsYSl9ZnVuY3Rpb24gZSgpe3JldHVybiBiLmw/Yi5sKCk6Yi5jYWxsKG51bGwpfXZhciBmPW51bGwscz1mdW5jdGlvbigpe2Z1bmN0aW9uIGMoYSxiLGUpe3ZhciBmPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGY9MCxnPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7ZjxnLmxlbmd0aDspZ1tmXT1hcmd1bWVudHNbZisyXSwrK2Y7Zj1uZXcgRihnLDApfXJldHVybiBkLmNhbGwodGhpcyxhLGIsZil9ZnVuY3Rpb24gZChjLGUsZil7ZT1ULmMoYSxlLGYpO3JldHVybiBiLmE/Yi5hKGMsZSk6Yi5jYWxsKG51bGwsYyxlKX1jLmk9MjtjLmY9ZnVuY3Rpb24oYSl7dmFyIGI9RyhhKTthPUsoYSk7dmFyIGM9RyhhKTthPUgoYSk7cmV0dXJuIGQoYixjLGEpfTtjLmQ9ZDtyZXR1cm4gY30oKSxmPWZ1bmN0aW9uKGEsYixmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAwOnJldHVybiBlLmNhbGwodGhpcyk7Y2FzZSAxOnJldHVybiBkLmNhbGwodGhpcyxcbmEpO2Nhc2UgMjpyZXR1cm4gYy5jYWxsKHRoaXMsYSxiKTtkZWZhdWx0OnZhciBnPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGc9MCxoPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7ZzxoLmxlbmd0aDspaFtnXT1hcmd1bWVudHNbZysyXSwrK2c7Zz1uZXcgRihoLDApfXJldHVybiBzLmQoYSxiLGcpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtmLmk9MjtmLmY9cy5mO2YubD1lO2YuYj1kO2YuYT1jO2YuZD1zLmQ7cmV0dXJuIGZ9KCl9fXZhciBlPW51bGwsZj1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYyxkLGUsZixnKXt2YXIgdT1udWxsO2lmKDQ8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciB1PTAsdj1BcnJheShhcmd1bWVudHMubGVuZ3RoLTQpO3U8di5sZW5ndGg7KXZbdV09YXJndW1lbnRzW3UrNF0sKyt1O3U9bmV3IEYodiwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsYyxkLGUsZix1KX1mdW5jdGlvbiBiKGEsYyxkLFxuZixnKXt2YXIgaD1mdW5jdGlvbiB5KGEpe3JldHVybiBuZXcgVihudWxsLGZ1bmN0aW9uKCl7dmFyIGI9ZS5hKEQsYSk7cmV0dXJuIEVlKHVkLGIpP00oZS5hKEcsYikseShlLmEoSCxiKSkpOm51bGx9LG51bGwsbnVsbCl9O3JldHVybiBlLmEoZnVuY3Rpb24oKXtyZXR1cm4gZnVuY3Rpb24oYil7cmV0dXJuIFQuYShhLGIpfX0oaCksaChOYy5kKGcsZixLYyhbZCxjXSwwKSkpKX1hLmk9NDthLmY9ZnVuY3Rpb24oYSl7dmFyIGM9RyhhKTthPUsoYSk7dmFyIGQ9RyhhKTthPUsoYSk7dmFyIGU9RyhhKTthPUsoYSk7dmFyIGY9RyhhKTthPUgoYSk7cmV0dXJuIGIoYyxkLGUsZixhKX07YS5kPWI7cmV0dXJuIGF9KCksZT1mdW5jdGlvbihlLGgsbCxtLHApe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGQuY2FsbCh0aGlzLGUpO2Nhc2UgMjpyZXR1cm4gYy5jYWxsKHRoaXMsZSxoKTtjYXNlIDM6cmV0dXJuIGIuY2FsbCh0aGlzLGUsaCxsKTtjYXNlIDQ6cmV0dXJuIGEuY2FsbCh0aGlzLFxuZSxoLGwsbSk7ZGVmYXVsdDp2YXIgcT1udWxsO2lmKDQ8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBxPTAscz1BcnJheShhcmd1bWVudHMubGVuZ3RoLTQpO3E8cy5sZW5ndGg7KXNbcV09YXJndW1lbnRzW3ErNF0sKytxO3E9bmV3IEYocywwKX1yZXR1cm4gZi5kKGUsaCxsLG0scSl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2UuaT00O2UuZj1mLmY7ZS5iPWQ7ZS5hPWM7ZS5jPWI7ZS5uPWE7ZS5kPWYuZDtyZXR1cm4gZX0oKSxQZT1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiKXtyZXR1cm4gbmV3IFYobnVsbCxmdW5jdGlvbigpe2lmKDA8YSl7dmFyIGY9RChiKTtyZXR1cm4gZj9NKEcoZiksYy5hKGEtMSxIKGYpKSk6bnVsbH1yZXR1cm4gbnVsbH0sbnVsbCxudWxsKX1mdW5jdGlvbiBiKGEpe3JldHVybiBmdW5jdGlvbihiKXtyZXR1cm4gZnVuY3Rpb24oYSl7cmV0dXJuIGZ1bmN0aW9uKCl7ZnVuY3Rpb24gYyhkLGcpe3ZhciBoPXFiKGEpLFxubD1hLmJiKDAsYS5SYShudWxsKS0xKSxoPTA8aD9iLmE/Yi5hKGQsZyk6Yi5jYWxsKG51bGwsZCxnKTpkO3JldHVybiAwPGw/aDpBYyhoKT9oOm5ldyB5YyhoKX1mdW5jdGlvbiBkKGEpe3JldHVybiBiLmI/Yi5iKGEpOmIuY2FsbChudWxsLGEpfWZ1bmN0aW9uIGwoKXtyZXR1cm4gYi5sP2IubCgpOmIuY2FsbChudWxsKX12YXIgbT1udWxsLG09ZnVuY3Rpb24oYSxiKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAwOnJldHVybiBsLmNhbGwodGhpcyk7Y2FzZSAxOnJldHVybiBkLmNhbGwodGhpcyxhKTtjYXNlIDI6cmV0dXJuIGMuY2FsbCh0aGlzLGEsYil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O20ubD1sO20uYj1kO20uYT1jO3JldHVybiBtfSgpfShuZXcgTWUoYSkpfX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiLmNhbGwodGhpcyxjKTtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLFxuYyxlKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5iPWI7Yy5hPWE7cmV0dXJuIGN9KCksUWU9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYil7cmV0dXJuIG5ldyBWKG51bGwsZnVuY3Rpb24oYyl7cmV0dXJuIGZ1bmN0aW9uKCl7cmV0dXJuIGMoYSxiKX19KGZ1bmN0aW9uKGEsYil7Zm9yKDs7KXt2YXIgYz1EKGIpO2lmKDA8YSYmYyl7dmFyIGQ9YS0xLGM9SChjKTthPWQ7Yj1jfWVsc2UgcmV0dXJuIGN9fSksbnVsbCxudWxsKX1mdW5jdGlvbiBiKGEpe3JldHVybiBmdW5jdGlvbihiKXtyZXR1cm4gZnVuY3Rpb24oYSl7cmV0dXJuIGZ1bmN0aW9uKCl7ZnVuY3Rpb24gYyhkLGcpe3ZhciBoPXFiKGEpO2EuYmIoMCxhLlJhKG51bGwpLTEpO3JldHVybiAwPGg/ZDpiLmE/Yi5hKGQsZyk6Yi5jYWxsKG51bGwsZCxnKX1mdW5jdGlvbiBkKGEpe3JldHVybiBiLmI/Yi5iKGEpOmIuY2FsbChudWxsLGEpfWZ1bmN0aW9uIGwoKXtyZXR1cm4gYi5sP1xuYi5sKCk6Yi5jYWxsKG51bGwpfXZhciBtPW51bGwsbT1mdW5jdGlvbihhLGIpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDA6cmV0dXJuIGwuY2FsbCh0aGlzKTtjYXNlIDE6cmV0dXJuIGQuY2FsbCh0aGlzLGEpO2Nhc2UgMjpyZXR1cm4gYy5jYWxsKHRoaXMsYSxiKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307bS5sPWw7bS5iPWQ7bS5hPWM7cmV0dXJuIG19KCl9KG5ldyBNZShhKSl9fXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGIuY2FsbCh0aGlzLGMpO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5iPWI7Yy5hPWE7cmV0dXJuIGN9KCksUmU9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYil7cmV0dXJuIG5ldyBWKG51bGwsZnVuY3Rpb24oYyl7cmV0dXJuIGZ1bmN0aW9uKCl7cmV0dXJuIGMoYSxcbmIpfX0oZnVuY3Rpb24oYSxiKXtmb3IoOzspe3ZhciBjPUQoYiksZDtpZihkPWMpZD1HKGMpLGQ9YS5iP2EuYihkKTphLmNhbGwobnVsbCxkKTtpZih0KGQpKWQ9YSxjPUgoYyksYT1kLGI9YztlbHNlIHJldHVybiBjfX0pLG51bGwsbnVsbCl9ZnVuY3Rpb24gYihhKXtyZXR1cm4gZnVuY3Rpb24oYil7cmV0dXJuIGZ1bmN0aW9uKGMpe3JldHVybiBmdW5jdGlvbigpe2Z1bmN0aW9uIGcoZyxoKXt2YXIgbD1xYihjKTtpZih0KHQobCk/YS5iP2EuYihoKTphLmNhbGwobnVsbCxoKTpsKSlyZXR1cm4gZzthYyhjLG51bGwpO3JldHVybiBiLmE/Yi5hKGcsaCk6Yi5jYWxsKG51bGwsZyxoKX1mdW5jdGlvbiBoKGEpe3JldHVybiBiLmI/Yi5iKGEpOmIuY2FsbChudWxsLGEpfWZ1bmN0aW9uIGwoKXtyZXR1cm4gYi5sP2IubCgpOmIuY2FsbChudWxsKX12YXIgbT1udWxsLG09ZnVuY3Rpb24oYSxiKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAwOnJldHVybiBsLmNhbGwodGhpcyk7Y2FzZSAxOnJldHVybiBoLmNhbGwodGhpcyxcbmEpO2Nhc2UgMjpyZXR1cm4gZy5jYWxsKHRoaXMsYSxiKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307bS5sPWw7bS5iPWg7bS5hPWc7cmV0dXJuIG19KCl9KG5ldyBNZSghMCkpfX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiLmNhbGwodGhpcyxjKTtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYj1iO2MuYT1hO3JldHVybiBjfSgpLFNlPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIpe3JldHVybiBQZS5hKGEsYy5iKGIpKX1mdW5jdGlvbiBiKGEpe3JldHVybiBuZXcgVihudWxsLGZ1bmN0aW9uKCl7cmV0dXJuIE0oYSxjLmIoYSkpfSxudWxsLG51bGwpfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGIuY2FsbCh0aGlzLFxuYyk7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxjLGUpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmI9YjtjLmE9YTtyZXR1cm4gY30oKSxUZT1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiKXtyZXR1cm4gUGUuYShhLGMuYihiKSl9ZnVuY3Rpb24gYihhKXtyZXR1cm4gbmV3IFYobnVsbCxmdW5jdGlvbigpe3JldHVybiBNKGEubD9hLmwoKTphLmNhbGwobnVsbCksYy5iKGEpKX0sbnVsbCxudWxsKX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiLmNhbGwodGhpcyxjKTtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYj1iO2MuYT1hO3JldHVybiBjfSgpLFVlPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGMpe3JldHVybiBuZXcgVihudWxsLGZ1bmN0aW9uKCl7dmFyIGY9XG5EKGEpLGc9RChjKTtyZXR1cm4gZiYmZz9NKEcoZiksTShHKGcpLGIuYShIKGYpLEgoZykpKSk6bnVsbH0sbnVsbCxudWxsKX12YXIgYj1udWxsLGM9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGIsZCxoKXt2YXIgbD1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBsPTAsbT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2w8bS5sZW5ndGg7KW1bbF09YXJndW1lbnRzW2wrMl0sKytsO2w9bmV3IEYobSwwKX1yZXR1cm4gYy5jYWxsKHRoaXMsYixkLGwpfWZ1bmN0aW9uIGMoYSxkLGUpe3JldHVybiBuZXcgVihudWxsLGZ1bmN0aW9uKCl7dmFyIGM9T2UuYShELE5jLmQoZSxkLEtjKFthXSwwKSkpO3JldHVybiBFZSh1ZCxjKT9hZS5hKE9lLmEoRyxjKSxULmEoYixPZS5hKEgsYykpKTpudWxsfSxudWxsLG51bGwpfWEuaT0yO2EuZj1mdW5jdGlvbihhKXt2YXIgYj1HKGEpO2E9SyhhKTt2YXIgZD1HKGEpO2E9SChhKTtyZXR1cm4gYyhiLGQsYSl9O2EuZD1jO3JldHVybiBhfSgpLFxuYj1mdW5jdGlvbihiLGUsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYixlKTtkZWZhdWx0OnZhciBnPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGc9MCxoPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7ZzxoLmxlbmd0aDspaFtnXT1hcmd1bWVudHNbZysyXSwrK2c7Zz1uZXcgRihoLDApfXJldHVybiBjLmQoYixlLGcpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtiLmk9MjtiLmY9Yy5mO2IuYT1hO2IuZD1jLmQ7cmV0dXJuIGJ9KCksV2U9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEpe3JldHVybiBJZS5hKE9lLmIoYSksVmUpfXZhciBiPW51bGwsYz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYyxkKXt2YXIgaD1udWxsO2lmKDE8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBoPTAsbD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTEpO2g8bC5sZW5ndGg7KWxbaF09YXJndW1lbnRzW2grXG4xXSwrK2g7aD1uZXcgRihsLDApfXJldHVybiBiLmNhbGwodGhpcyxjLGgpfWZ1bmN0aW9uIGIoYSxjKXtyZXR1cm4gVC5hKGFlLFQuYyhPZSxhLGMpKX1hLmk9MTthLmY9ZnVuY3Rpb24oYSl7dmFyIGM9RyhhKTthPUgoYSk7cmV0dXJuIGIoYyxhKX07YS5kPWI7cmV0dXJuIGF9KCksYj1mdW5jdGlvbihiLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGEuY2FsbCh0aGlzLGIpO2RlZmF1bHQ6dmFyIGY9bnVsbDtpZigxPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZj0wLGc9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0xKTtmPGcubGVuZ3RoOylnW2ZdPWFyZ3VtZW50c1tmKzFdLCsrZjtmPW5ldyBGKGcsMCl9cmV0dXJuIGMuZChiLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtiLmk9MTtiLmY9Yy5mO2IuYj1hO2IuZD1jLmQ7cmV0dXJuIGJ9KCksWGU9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYil7cmV0dXJuIG5ldyBWKG51bGwsXG5mdW5jdGlvbigpe3ZhciBmPUQoYik7aWYoZil7aWYoZmQoZikpe2Zvcih2YXIgZz1ZYihmKSxoPVEoZyksbD1UZChoKSxtPTA7OylpZihtPGgpe3ZhciBwO3A9Qy5hKGcsbSk7cD1hLmI/YS5iKHApOmEuY2FsbChudWxsLHApO3QocCkmJihwPUMuYShnLG0pLGwuYWRkKHApKTttKz0xfWVsc2UgYnJlYWs7cmV0dXJuIFdkKGwuY2EoKSxjLmEoYSxaYihmKSkpfWc9RyhmKTtmPUgoZik7cmV0dXJuIHQoYS5iP2EuYihnKTphLmNhbGwobnVsbCxnKSk/TShnLGMuYShhLGYpKTpjLmEoYSxmKX1yZXR1cm4gbnVsbH0sbnVsbCxudWxsKX1mdW5jdGlvbiBiKGEpe3JldHVybiBmdW5jdGlvbihiKXtyZXR1cm4gZnVuY3Rpb24oKXtmdW5jdGlvbiBjKGYsZyl7cmV0dXJuIHQoYS5iP2EuYihnKTphLmNhbGwobnVsbCxnKSk/Yi5hP2IuYShmLGcpOmIuY2FsbChudWxsLGYsZyk6Zn1mdW5jdGlvbiBnKGEpe3JldHVybiBiLmI/Yi5iKGEpOmIuY2FsbChudWxsLGEpfWZ1bmN0aW9uIGgoKXtyZXR1cm4gYi5sP1xuYi5sKCk6Yi5jYWxsKG51bGwpfXZhciBsPW51bGwsbD1mdW5jdGlvbihhLGIpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDA6cmV0dXJuIGguY2FsbCh0aGlzKTtjYXNlIDE6cmV0dXJuIGcuY2FsbCh0aGlzLGEpO2Nhc2UgMjpyZXR1cm4gYy5jYWxsKHRoaXMsYSxiKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307bC5sPWg7bC5iPWc7bC5hPWM7cmV0dXJuIGx9KCl9fXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGIuY2FsbCh0aGlzLGMpO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5iPWI7Yy5hPWE7cmV0dXJuIGN9KCksWWU9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYil7cmV0dXJuIFhlLmEoSGUoYSksYil9ZnVuY3Rpb24gYihhKXtyZXR1cm4gWGUuYihIZShhKSl9XG52YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiLmNhbGwodGhpcyxjKTtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYj1iO2MuYT1hO3JldHVybiBjfSgpO2Z1bmN0aW9uIFplKGEpe3ZhciBiPSRlO3JldHVybiBmdW5jdGlvbiBkKGEpe3JldHVybiBuZXcgVihudWxsLGZ1bmN0aW9uKCl7cmV0dXJuIE0oYSx0KGIuYj9iLmIoYSk6Yi5jYWxsKG51bGwsYSkpP1dlLmQoZCxLYyhbRC5iP0QuYihhKTpELmNhbGwobnVsbCxhKV0sMCkpOm51bGwpfSxudWxsLG51bGwpfShhKX1cbnZhciBhZj1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMpe3JldHVybiBhJiYoYS5xJjR8fGEuZGMpP08oY2Uod2QubihiLGRlLE9iKGEpLGMpKSxWYyhhKSk6d2QubihiLE5jLGEsYyl9ZnVuY3Rpb24gYihhLGIpe3JldHVybiBudWxsIT1hP2EmJihhLnEmNHx8YS5kYyk/TyhjZShBLmMoUGIsT2IoYSksYikpLFZjKGEpKTpBLmMoUmEsYSxiKTpBLmMoTmMsSixiKX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIGIuY2FsbCh0aGlzLGMsZSk7Y2FzZSAzOnJldHVybiBhLmNhbGwodGhpcyxjLGUsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYT1iO2MuYz1hO3JldHVybiBjfSgpLGJmPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyxoKXtyZXR1cm4gbmV3IFYobnVsbCxmdW5jdGlvbigpe3ZhciBsPUQoaCk7aWYobCl7dmFyIG09UGUuYShhLGwpO3JldHVybiBhPT09XG5RKG0pP00obSxkLm4oYSxiLGMsUWUuYShiLGwpKSk6UmEoSixQZS5hKGEsYWUuYShtLGMpKSl9cmV0dXJuIG51bGx9LG51bGwsbnVsbCl9ZnVuY3Rpb24gYihhLGIsYyl7cmV0dXJuIG5ldyBWKG51bGwsZnVuY3Rpb24oKXt2YXIgaD1EKGMpO2lmKGgpe3ZhciBsPVBlLmEoYSxoKTtyZXR1cm4gYT09PVEobCk/TShsLGQuYyhhLGIsUWUuYShiLGgpKSk6bnVsbH1yZXR1cm4gbnVsbH0sbnVsbCxudWxsKX1mdW5jdGlvbiBjKGEsYil7cmV0dXJuIGQuYyhhLGEsYil9dmFyIGQ9bnVsbCxkPWZ1bmN0aW9uKGQsZixnLGgpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIGMuY2FsbCh0aGlzLGQsZik7Y2FzZSAzOnJldHVybiBiLmNhbGwodGhpcyxkLGYsZyk7Y2FzZSA0OnJldHVybiBhLmNhbGwodGhpcyxkLGYsZyxoKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307ZC5hPWM7ZC5jPWI7ZC5uPWE7cmV0dXJuIGR9KCksY2Y9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsXG5iLGMpe3ZhciBnPWpkO2ZvcihiPUQoYik7OylpZihiKXt2YXIgaD1hO2lmKGg/aC5qJjI1Nnx8aC5SYnx8KGguaj8wOncoWmEsaCkpOncoWmEsaCkpe2E9Uy5jKGEsRyhiKSxnKTtpZihnPT09YSlyZXR1cm4gYztiPUsoYil9ZWxzZSByZXR1cm4gY31lbHNlIHJldHVybiBhfWZ1bmN0aW9uIGIoYSxiKXtyZXR1cm4gYy5jKGEsYixudWxsKX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIGIuY2FsbCh0aGlzLGMsZSk7Y2FzZSAzOnJldHVybiBhLmNhbGwodGhpcyxjLGUsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYT1iO2MuYz1hO3JldHVybiBjfSgpLGRmPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyxkLGYscSl7dmFyIHM9Ui5jKGIsMCxudWxsKTtyZXR1cm4oYj1FZChiKSk/UmMuYyhhLHMsZS5QKFMuYShhLHMpLGIsYyxkLGYscSkpOlJjLmMoYSxzLFxuZnVuY3Rpb24oKXt2YXIgYj1TLmEoYSxzKTtyZXR1cm4gYy5uP2MubihiLGQsZixxKTpjLmNhbGwobnVsbCxiLGQsZixxKX0oKSl9ZnVuY3Rpb24gYihhLGIsYyxkLGYpe3ZhciBxPVIuYyhiLDAsbnVsbCk7cmV0dXJuKGI9RWQoYikpP1JjLmMoYSxxLGUucihTLmEoYSxxKSxiLGMsZCxmKSk6UmMuYyhhLHEsZnVuY3Rpb24oKXt2YXIgYj1TLmEoYSxxKTtyZXR1cm4gYy5jP2MuYyhiLGQsZik6Yy5jYWxsKG51bGwsYixkLGYpfSgpKX1mdW5jdGlvbiBjKGEsYixjLGQpe3ZhciBmPVIuYyhiLDAsbnVsbCk7cmV0dXJuKGI9RWQoYikpP1JjLmMoYSxmLGUubihTLmEoYSxmKSxiLGMsZCkpOlJjLmMoYSxmLGZ1bmN0aW9uKCl7dmFyIGI9Uy5hKGEsZik7cmV0dXJuIGMuYT9jLmEoYixkKTpjLmNhbGwobnVsbCxiLGQpfSgpKX1mdW5jdGlvbiBkKGEsYixjKXt2YXIgZD1SLmMoYiwwLG51bGwpO3JldHVybihiPUVkKGIpKT9SYy5jKGEsZCxlLmMoUy5hKGEsZCksYixjKSk6UmMuYyhhLGQsZnVuY3Rpb24oKXt2YXIgYj1cblMuYShhLGQpO3JldHVybiBjLmI/Yy5iKGIpOmMuY2FsbChudWxsLGIpfSgpKX12YXIgZT1udWxsLGY9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGMsZCxlLGYsZyx1LHYpe3ZhciB5PW51bGw7aWYoNjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIHk9MCxCPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtNik7eTxCLmxlbmd0aDspQlt5XT1hcmd1bWVudHNbeSs2XSwrK3k7eT1uZXcgRihCLDApfXJldHVybiBiLmNhbGwodGhpcyxjLGQsZSxmLGcsdSx5KX1mdW5jdGlvbiBiKGEsYyxkLGYsZyxoLHYpe3ZhciB5PVIuYyhjLDAsbnVsbCk7cmV0dXJuKGM9RWQoYykpP1JjLmMoYSx5LFQuZChlLFMuYShhLHkpLGMsZCxmLEtjKFtnLGgsdl0sMCkpKTpSYy5jKGEseSxULmQoZCxTLmEoYSx5KSxmLGcsaCxLYyhbdl0sMCkpKX1hLmk9NjthLmY9ZnVuY3Rpb24oYSl7dmFyIGM9RyhhKTthPUsoYSk7dmFyIGQ9RyhhKTthPUsoYSk7dmFyIGU9RyhhKTthPUsoYSk7dmFyIGY9RyhhKTthPUsoYSk7dmFyIGc9XG5HKGEpO2E9SyhhKTt2YXIgdj1HKGEpO2E9SChhKTtyZXR1cm4gYihjLGQsZSxmLGcsdixhKX07YS5kPWI7cmV0dXJuIGF9KCksZT1mdW5jdGlvbihlLGgsbCxtLHAscSxzKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAzOnJldHVybiBkLmNhbGwodGhpcyxlLGgsbCk7Y2FzZSA0OnJldHVybiBjLmNhbGwodGhpcyxlLGgsbCxtKTtjYXNlIDU6cmV0dXJuIGIuY2FsbCh0aGlzLGUsaCxsLG0scCk7Y2FzZSA2OnJldHVybiBhLmNhbGwodGhpcyxlLGgsbCxtLHAscSk7ZGVmYXVsdDp2YXIgdT1udWxsO2lmKDY8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciB1PTAsdj1BcnJheShhcmd1bWVudHMubGVuZ3RoLTYpO3U8di5sZW5ndGg7KXZbdV09YXJndW1lbnRzW3UrNl0sKyt1O3U9bmV3IEYodiwwKX1yZXR1cm4gZi5kKGUsaCxsLG0scCxxLHUpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtlLmk9NjtlLmY9Zi5mO2UuYz1kO2Uubj1jO1xuZS5yPWI7ZS5QPWE7ZS5kPWYuZDtyZXR1cm4gZX0oKTtmdW5jdGlvbiBlZihhLGIpe3RoaXMudT1hO3RoaXMuZT1ifWZ1bmN0aW9uIGZmKGEpe3JldHVybiBuZXcgZWYoYSxbbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsXSl9ZnVuY3Rpb24gZ2YoYSl7cmV0dXJuIG5ldyBlZihhLnUsRmEoYS5lKSl9ZnVuY3Rpb24gaGYoYSl7YT1hLmc7cmV0dXJuIDMyPmE/MDphLTE+Pj41PDw1fWZ1bmN0aW9uIGpmKGEsYixjKXtmb3IoOzspe2lmKDA9PT1iKXJldHVybiBjO3ZhciBkPWZmKGEpO2QuZVswXT1jO2M9ZDtiLT01fX1cbnZhciBsZj1mdW5jdGlvbiBrZihiLGMsZCxlKXt2YXIgZj1nZihkKSxnPWIuZy0xPj4+YyYzMTs1PT09Yz9mLmVbZ109ZTooZD1kLmVbZ10sYj1udWxsIT1kP2tmKGIsYy01LGQsZSk6amYobnVsbCxjLTUsZSksZi5lW2ddPWIpO3JldHVybiBmfTtmdW5jdGlvbiBtZihhLGIpe3Rocm93IEVycm9yKFt6KFwiTm8gaXRlbSBcIikseihhKSx6KFwiIGluIHZlY3RvciBvZiBsZW5ndGggXCIpLHooYildLmpvaW4oXCJcIikpO31mdW5jdGlvbiBuZihhLGIpe2lmKGI+PWhmKGEpKXJldHVybiBhLlc7Zm9yKHZhciBjPWEucm9vdCxkPWEuc2hpZnQ7OylpZigwPGQpdmFyIGU9ZC01LGM9Yy5lW2I+Pj5kJjMxXSxkPWU7ZWxzZSByZXR1cm4gYy5lfWZ1bmN0aW9uIG9mKGEsYil7cmV0dXJuIDA8PWImJmI8YS5nP25mKGEsYik6bWYoYixhLmcpfVxudmFyIHFmPWZ1bmN0aW9uIHBmKGIsYyxkLGUsZil7dmFyIGc9Z2YoZCk7aWYoMD09PWMpZy5lW2UmMzFdPWY7ZWxzZXt2YXIgaD1lPj4+YyYzMTtiPXBmKGIsYy01LGQuZVtoXSxlLGYpO2cuZVtoXT1ifXJldHVybiBnfSxzZj1mdW5jdGlvbiByZihiLGMsZCl7dmFyIGU9Yi5nLTI+Pj5jJjMxO2lmKDU8Yyl7Yj1yZihiLGMtNSxkLmVbZV0pO2lmKG51bGw9PWImJjA9PT1lKXJldHVybiBudWxsO2Q9Z2YoZCk7ZC5lW2VdPWI7cmV0dXJuIGR9aWYoMD09PWUpcmV0dXJuIG51bGw7ZD1nZihkKTtkLmVbZV09bnVsbDtyZXR1cm4gZH07ZnVuY3Rpb24gdGYoYSxiLGMsZCxlLGYpe3RoaXMubT1hO3RoaXMuemI9Yjt0aGlzLmU9Yzt0aGlzLm9hPWQ7dGhpcy5zdGFydD1lO3RoaXMuZW5kPWZ9dGYucHJvdG90eXBlLmdhPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMubTx0aGlzLmVuZH07XG50Zi5wcm90b3R5cGUubmV4dD1mdW5jdGlvbigpezMyPT09dGhpcy5tLXRoaXMuemImJih0aGlzLmU9bmYodGhpcy5vYSx0aGlzLm0pLHRoaXMuemIrPTMyKTt2YXIgYT10aGlzLmVbdGhpcy5tJjMxXTt0aGlzLm0rPTE7cmV0dXJuIGF9O2Z1bmN0aW9uIFcoYSxiLGMsZCxlLGYpe3RoaXMuaz1hO3RoaXMuZz1iO3RoaXMuc2hpZnQ9Yzt0aGlzLnJvb3Q9ZDt0aGlzLlc9ZTt0aGlzLnA9Zjt0aGlzLmo9MTY3NjY4NTExO3RoaXMucT04MTk2fWs9Vy5wcm90b3R5cGU7ay50b1N0cmluZz1mdW5jdGlvbigpe3JldHVybiBlYyh0aGlzKX07ay50PWZ1bmN0aW9uKGEsYil7cmV0dXJuICRhLmModGhpcyxiLG51bGwpfTtrLnM9ZnVuY3Rpb24oYSxiLGMpe3JldHVyblwibnVtYmVyXCI9PT10eXBlb2YgYj9DLmModGhpcyxiLGMpOmN9O1xuay5nYj1mdW5jdGlvbihhLGIsYyl7YT0wO2Zvcih2YXIgZD1jOzspaWYoYTx0aGlzLmcpe3ZhciBlPW5mKHRoaXMsYSk7Yz1lLmxlbmd0aDthOntmb3IodmFyIGY9MDs7KWlmKGY8Yyl7dmFyIGc9ZithLGg9ZVtmXSxkPWIuYz9iLmMoZCxnLGgpOmIuY2FsbChudWxsLGQsZyxoKTtpZihBYyhkKSl7ZT1kO2JyZWFrIGF9Zis9MX1lbHNle2U9ZDticmVhayBhfWU9dm9pZCAwfWlmKEFjKGUpKXJldHVybiBiPWUsTC5iP0wuYihiKTpMLmNhbGwobnVsbCxiKTthKz1jO2Q9ZX1lbHNlIHJldHVybiBkfTtrLlE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gb2YodGhpcyxiKVtiJjMxXX07ay4kPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gMDw9YiYmYjx0aGlzLmc/bmYodGhpcyxiKVtiJjMxXTpjfTtcbmsuVWE9ZnVuY3Rpb24oYSxiLGMpe2lmKDA8PWImJmI8dGhpcy5nKXJldHVybiBoZih0aGlzKTw9Yj8oYT1GYSh0aGlzLlcpLGFbYiYzMV09YyxuZXcgVyh0aGlzLmssdGhpcy5nLHRoaXMuc2hpZnQsdGhpcy5yb290LGEsbnVsbCkpOm5ldyBXKHRoaXMuayx0aGlzLmcsdGhpcy5zaGlmdCxxZih0aGlzLHRoaXMuc2hpZnQsdGhpcy5yb290LGIsYyksdGhpcy5XLG51bGwpO2lmKGI9PT10aGlzLmcpcmV0dXJuIFJhKHRoaXMsYyk7dGhyb3cgRXJyb3IoW3ooXCJJbmRleCBcIikseihiKSx6KFwiIG91dCBvZiBib3VuZHMgIFswLFwiKSx6KHRoaXMuZykseihcIl1cIildLmpvaW4oXCJcIikpO307ay52Yj0hMDtrLmZiPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5nO3JldHVybiBuZXcgdGYoMCwwLDA8USh0aGlzKT9uZih0aGlzLDApOm51bGwsdGhpcywwLGEpfTtrLkg9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5rfTtrLkw9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5nfTtcbmsuaGI9ZnVuY3Rpb24oKXtyZXR1cm4gQy5hKHRoaXMsMCl9O2suaWI9ZnVuY3Rpb24oKXtyZXR1cm4gQy5hKHRoaXMsMSl9O2suTGE9ZnVuY3Rpb24oKXtyZXR1cm4gMDx0aGlzLmc/Qy5hKHRoaXMsdGhpcy5nLTEpOm51bGx9O1xuay5NYT1mdW5jdGlvbigpe2lmKDA9PT10aGlzLmcpdGhyb3cgRXJyb3IoXCJDYW4ndCBwb3AgZW1wdHkgdmVjdG9yXCIpO2lmKDE9PT10aGlzLmcpcmV0dXJuIHViKE1jLHRoaXMuayk7aWYoMTx0aGlzLmctaGYodGhpcykpcmV0dXJuIG5ldyBXKHRoaXMuayx0aGlzLmctMSx0aGlzLnNoaWZ0LHRoaXMucm9vdCx0aGlzLlcuc2xpY2UoMCwtMSksbnVsbCk7dmFyIGE9bmYodGhpcyx0aGlzLmctMiksYj1zZih0aGlzLHRoaXMuc2hpZnQsdGhpcy5yb290KSxiPW51bGw9PWI/dWY6YixjPXRoaXMuZy0xO3JldHVybiA1PHRoaXMuc2hpZnQmJm51bGw9PWIuZVsxXT9uZXcgVyh0aGlzLmssYyx0aGlzLnNoaWZ0LTUsYi5lWzBdLGEsbnVsbCk6bmV3IFcodGhpcy5rLGMsdGhpcy5zaGlmdCxiLGEsbnVsbCl9O2suYWI9ZnVuY3Rpb24oKXtyZXR1cm4gMDx0aGlzLmc/bmV3IEhjKHRoaXMsdGhpcy5nLTEsbnVsbCk6bnVsbH07XG5rLkI9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLnA7cmV0dXJuIG51bGwhPWE/YTp0aGlzLnA9YT13Yyh0aGlzKX07ay5BPWZ1bmN0aW9uKGEsYil7aWYoYiBpbnN0YW5jZW9mIFcpaWYodGhpcy5nPT09UShiKSlmb3IodmFyIGM9Y2ModGhpcyksZD1jYyhiKTs7KWlmKHQoYy5nYSgpKSl7dmFyIGU9Yy5uZXh0KCksZj1kLm5leHQoKTtpZighc2MuYShlLGYpKXJldHVybiExfWVsc2UgcmV0dXJuITA7ZWxzZSByZXR1cm4hMTtlbHNlIHJldHVybiBJYyh0aGlzLGIpfTtrLiRhPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcztyZXR1cm4gbmV3IHZmKGEuZyxhLnNoaWZ0LGZ1bmN0aW9uKCl7dmFyIGI9YS5yb290O3JldHVybiB3Zi5iP3dmLmIoYik6d2YuY2FsbChudWxsLGIpfSgpLGZ1bmN0aW9uKCl7dmFyIGI9YS5XO3JldHVybiB4Zi5iP3hmLmIoYik6eGYuY2FsbChudWxsLGIpfSgpKX07ay5KPWZ1bmN0aW9uKCl7cmV0dXJuIE8oTWMsdGhpcy5rKX07XG5rLlI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gQ2MuYSh0aGlzLGIpfTtrLk89ZnVuY3Rpb24oYSxiLGMpe2E9MDtmb3IodmFyIGQ9Yzs7KWlmKGE8dGhpcy5nKXt2YXIgZT1uZih0aGlzLGEpO2M9ZS5sZW5ndGg7YTp7Zm9yKHZhciBmPTA7OylpZihmPGMpe3ZhciBnPWVbZl0sZD1iLmE/Yi5hKGQsZyk6Yi5jYWxsKG51bGwsZCxnKTtpZihBYyhkKSl7ZT1kO2JyZWFrIGF9Zis9MX1lbHNle2U9ZDticmVhayBhfWU9dm9pZCAwfWlmKEFjKGUpKXJldHVybiBiPWUsTC5iP0wuYihiKTpMLmNhbGwobnVsbCxiKTthKz1jO2Q9ZX1lbHNlIHJldHVybiBkfTtrLkthPWZ1bmN0aW9uKGEsYixjKXtpZihcIm51bWJlclwiPT09dHlwZW9mIGIpcmV0dXJuIHBiKHRoaXMsYixjKTt0aHJvdyBFcnJvcihcIlZlY3RvcidzIGtleSBmb3IgYXNzb2MgbXVzdCBiZSBhIG51bWJlci5cIik7fTtcbmsuRD1mdW5jdGlvbigpe2lmKDA9PT10aGlzLmcpcmV0dXJuIG51bGw7aWYoMzI+PXRoaXMuZylyZXR1cm4gbmV3IEYodGhpcy5XLDApO3ZhciBhO2E6e2E9dGhpcy5yb290O2Zvcih2YXIgYj10aGlzLnNoaWZ0OzspaWYoMDxiKWItPTUsYT1hLmVbMF07ZWxzZXthPWEuZTticmVhayBhfWE9dm9pZCAwfXJldHVybiB5Zi5uP3lmLm4odGhpcyxhLDAsMCk6eWYuY2FsbChudWxsLHRoaXMsYSwwLDApfTtrLkY9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IFcoYix0aGlzLmcsdGhpcy5zaGlmdCx0aGlzLnJvb3QsdGhpcy5XLHRoaXMucCl9O1xuay5HPWZ1bmN0aW9uKGEsYil7aWYoMzI+dGhpcy5nLWhmKHRoaXMpKXtmb3IodmFyIGM9dGhpcy5XLmxlbmd0aCxkPUFycmF5KGMrMSksZT0wOzspaWYoZTxjKWRbZV09dGhpcy5XW2VdLGUrPTE7ZWxzZSBicmVhaztkW2NdPWI7cmV0dXJuIG5ldyBXKHRoaXMuayx0aGlzLmcrMSx0aGlzLnNoaWZ0LHRoaXMucm9vdCxkLG51bGwpfWM9KGQ9dGhpcy5nPj4+NT4xPDx0aGlzLnNoaWZ0KT90aGlzLnNoaWZ0KzU6dGhpcy5zaGlmdDtkPyhkPWZmKG51bGwpLGQuZVswXT10aGlzLnJvb3QsZT1qZihudWxsLHRoaXMuc2hpZnQsbmV3IGVmKG51bGwsdGhpcy5XKSksZC5lWzFdPWUpOmQ9bGYodGhpcyx0aGlzLnNoaWZ0LHRoaXMucm9vdCxuZXcgZWYobnVsbCx0aGlzLlcpKTtyZXR1cm4gbmV3IFcodGhpcy5rLHRoaXMuZysxLGMsZCxbYl0sbnVsbCl9O1xuay5jYWxsPWZ1bmN0aW9uKCl7dmFyIGE9bnVsbCxhPWZ1bmN0aW9uKGEsYyxkKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiB0aGlzLlEobnVsbCxjKTtjYXNlIDM6cmV0dXJuIHRoaXMuJChudWxsLGMsZCl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2EuYT1mdW5jdGlvbihhLGMpe3JldHVybiB0aGlzLlEobnVsbCxjKX07YS5jPWZ1bmN0aW9uKGEsYyxkKXtyZXR1cm4gdGhpcy4kKG51bGwsYyxkKX07cmV0dXJuIGF9KCk7ay5hcHBseT1mdW5jdGlvbihhLGIpe3JldHVybiB0aGlzLmNhbGwuYXBwbHkodGhpcyxbdGhpc10uY29uY2F0KEZhKGIpKSl9O2suYj1mdW5jdGlvbihhKXtyZXR1cm4gdGhpcy5RKG51bGwsYSl9O2suYT1mdW5jdGlvbihhLGIpe3JldHVybiB0aGlzLiQobnVsbCxhLGIpfTtcbnZhciB1Zj1uZXcgZWYobnVsbCxbbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsXSksTWM9bmV3IFcobnVsbCwwLDUsdWYsW10sMCk7Vy5wcm90b3R5cGVbRWFdPWZ1bmN0aW9uKCl7cmV0dXJuIHVjKHRoaXMpfTtmdW5jdGlvbiB6ZihhKXtyZXR1cm4gUWIoQS5jKFBiLE9iKE1jKSxhKSl9XG52YXIgQWY9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEpe3ZhciBkPW51bGw7aWYoMDxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGQ9MCxlPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMCk7ZDxlLmxlbmd0aDspZVtkXT1hcmd1bWVudHNbZCswXSwrK2Q7ZD1uZXcgRihlLDApfXJldHVybiBiLmNhbGwodGhpcyxkKX1mdW5jdGlvbiBiKGEpe2lmKGEgaW5zdGFuY2VvZiBGJiYwPT09YS5tKWE6e2E9YS5lO3ZhciBiPWEubGVuZ3RoO2lmKDMyPmIpYT1uZXcgVyhudWxsLGIsNSx1ZixhLG51bGwpO2Vsc2V7Zm9yKHZhciBlPTMyLGY9KG5ldyBXKG51bGwsMzIsNSx1ZixhLnNsaWNlKDAsMzIpLG51bGwpKS4kYShudWxsKTs7KWlmKGU8Yil2YXIgZz1lKzEsZj1kZS5hKGYsYVtlXSksZT1nO2Vsc2V7YT1RYihmKTticmVhayBhfWE9dm9pZCAwfX1lbHNlIGE9emYoYSk7cmV0dXJuIGF9YS5pPTA7YS5mPWZ1bmN0aW9uKGEpe2E9RChhKTtyZXR1cm4gYihhKX07YS5kPWI7cmV0dXJuIGF9KCk7XG5mdW5jdGlvbiBCZihhLGIsYyxkLGUsZil7dGhpcy5oYT1hO3RoaXMuSmE9Yjt0aGlzLm09Yzt0aGlzLlY9ZDt0aGlzLms9ZTt0aGlzLnA9Zjt0aGlzLmo9MzIzNzUwMjA7dGhpcy5xPTE1MzZ9az1CZi5wcm90b3R5cGU7ay50b1N0cmluZz1mdW5jdGlvbigpe3JldHVybiBlYyh0aGlzKX07ay5IPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMua307ay5UPWZ1bmN0aW9uKCl7aWYodGhpcy5WKzE8dGhpcy5KYS5sZW5ndGgpe3ZhciBhO2E9dGhpcy5oYTt2YXIgYj10aGlzLkphLGM9dGhpcy5tLGQ9dGhpcy5WKzE7YT15Zi5uP3lmLm4oYSxiLGMsZCk6eWYuY2FsbChudWxsLGEsYixjLGQpO3JldHVybiBudWxsPT1hP251bGw6YX1yZXR1cm4gJGIodGhpcyl9O2suQj1mdW5jdGlvbigpe3ZhciBhPXRoaXMucDtyZXR1cm4gbnVsbCE9YT9hOnRoaXMucD1hPXdjKHRoaXMpfTtrLkE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gSWModGhpcyxiKX07ay5KPWZ1bmN0aW9uKCl7cmV0dXJuIE8oTWMsdGhpcy5rKX07XG5rLlI9ZnVuY3Rpb24oYSxiKXt2YXIgYz10aGlzO3JldHVybiBDYy5hKGZ1bmN0aW9uKCl7dmFyIGE9Yy5oYSxiPWMubStjLlYsZj1RKGMuaGEpO3JldHVybiBDZi5jP0NmLmMoYSxiLGYpOkNmLmNhbGwobnVsbCxhLGIsZil9KCksYil9O2suTz1mdW5jdGlvbihhLGIsYyl7dmFyIGQ9dGhpcztyZXR1cm4gQ2MuYyhmdW5jdGlvbigpe3ZhciBhPWQuaGEsYj1kLm0rZC5WLGM9UShkLmhhKTtyZXR1cm4gQ2YuYz9DZi5jKGEsYixjKTpDZi5jYWxsKG51bGwsYSxiLGMpfSgpLGIsYyl9O2suTj1mdW5jdGlvbigpe3JldHVybiB0aGlzLkphW3RoaXMuVl19O2suUz1mdW5jdGlvbigpe2lmKHRoaXMuVisxPHRoaXMuSmEubGVuZ3RoKXt2YXIgYTthPXRoaXMuaGE7dmFyIGI9dGhpcy5KYSxjPXRoaXMubSxkPXRoaXMuVisxO2E9eWYubj95Zi5uKGEsYixjLGQpOnlmLmNhbGwobnVsbCxhLGIsYyxkKTtyZXR1cm4gbnVsbD09YT9KOmF9cmV0dXJuIFpiKHRoaXMpfTtrLkQ9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpc307XG5rLkNiPWZ1bmN0aW9uKCl7cmV0dXJuIFVkLmEodGhpcy5KYSx0aGlzLlYpfTtrLkRiPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5tK3RoaXMuSmEubGVuZ3RoO2lmKGE8TWEodGhpcy5oYSkpe3ZhciBiPXRoaXMuaGEsYz1uZih0aGlzLmhhLGEpO3JldHVybiB5Zi5uP3lmLm4oYixjLGEsMCk6eWYuY2FsbChudWxsLGIsYyxhLDApfXJldHVybiBKfTtrLkY9ZnVuY3Rpb24oYSxiKXt2YXIgYz10aGlzLmhhLGQ9dGhpcy5KYSxlPXRoaXMubSxmPXRoaXMuVjtyZXR1cm4geWYucj95Zi5yKGMsZCxlLGYsYik6eWYuY2FsbChudWxsLGMsZCxlLGYsYil9O2suRz1mdW5jdGlvbihhLGIpe3JldHVybiBNKGIsdGhpcyl9O2suQmI9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLm0rdGhpcy5KYS5sZW5ndGg7aWYoYTxNYSh0aGlzLmhhKSl7dmFyIGI9dGhpcy5oYSxjPW5mKHRoaXMuaGEsYSk7cmV0dXJuIHlmLm4/eWYubihiLGMsYSwwKTp5Zi5jYWxsKG51bGwsYixjLGEsMCl9cmV0dXJuIG51bGx9O1xuQmYucHJvdG90eXBlW0VhXT1mdW5jdGlvbigpe3JldHVybiB1Yyh0aGlzKX07dmFyIHlmPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyxkLGwpe3JldHVybiBuZXcgQmYoYSxiLGMsZCxsLG51bGwpfWZ1bmN0aW9uIGIoYSxiLGMsZCl7cmV0dXJuIG5ldyBCZihhLGIsYyxkLG51bGwsbnVsbCl9ZnVuY3Rpb24gYyhhLGIsYyl7cmV0dXJuIG5ldyBCZihhLG9mKGEsYiksYixjLG51bGwsbnVsbCl9dmFyIGQ9bnVsbCxkPWZ1bmN0aW9uKGQsZixnLGgsbCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMzpyZXR1cm4gYy5jYWxsKHRoaXMsZCxmLGcpO2Nhc2UgNDpyZXR1cm4gYi5jYWxsKHRoaXMsZCxmLGcsaCk7Y2FzZSA1OnJldHVybiBhLmNhbGwodGhpcyxkLGYsZyxoLGwpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtkLmM9YztkLm49YjtkLnI9YTtyZXR1cm4gZH0oKTtcbmZ1bmN0aW9uIERmKGEsYixjLGQsZSl7dGhpcy5rPWE7dGhpcy5vYT1iO3RoaXMuc3RhcnQ9Yzt0aGlzLmVuZD1kO3RoaXMucD1lO3RoaXMuaj0xNjY2MTc4ODc7dGhpcy5xPTgxOTJ9az1EZi5wcm90b3R5cGU7ay50b1N0cmluZz1mdW5jdGlvbigpe3JldHVybiBlYyh0aGlzKX07ay50PWZ1bmN0aW9uKGEsYil7cmV0dXJuICRhLmModGhpcyxiLG51bGwpfTtrLnM9ZnVuY3Rpb24oYSxiLGMpe3JldHVyblwibnVtYmVyXCI9PT10eXBlb2YgYj9DLmModGhpcyxiLGMpOmN9O2suUT1mdW5jdGlvbihhLGIpe3JldHVybiAwPmJ8fHRoaXMuZW5kPD10aGlzLnN0YXJ0K2I/bWYoYix0aGlzLmVuZC10aGlzLnN0YXJ0KTpDLmEodGhpcy5vYSx0aGlzLnN0YXJ0K2IpfTtrLiQ9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiAwPmJ8fHRoaXMuZW5kPD10aGlzLnN0YXJ0K2I/YzpDLmModGhpcy5vYSx0aGlzLnN0YXJ0K2IsYyl9O1xuay5VYT1mdW5jdGlvbihhLGIsYyl7dmFyIGQ9dGhpcy5zdGFydCtiO2E9dGhpcy5rO2M9UmMuYyh0aGlzLm9hLGQsYyk7Yj10aGlzLnN0YXJ0O3ZhciBlPXRoaXMuZW5kLGQ9ZCsxLGQ9ZT5kP2U6ZDtyZXR1cm4gRWYucj9FZi5yKGEsYyxiLGQsbnVsbCk6RWYuY2FsbChudWxsLGEsYyxiLGQsbnVsbCl9O2suSD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmt9O2suTD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmVuZC10aGlzLnN0YXJ0fTtrLkxhPWZ1bmN0aW9uKCl7cmV0dXJuIEMuYSh0aGlzLm9hLHRoaXMuZW5kLTEpfTtrLk1hPWZ1bmN0aW9uKCl7aWYodGhpcy5zdGFydD09PXRoaXMuZW5kKXRocm93IEVycm9yKFwiQ2FuJ3QgcG9wIGVtcHR5IHZlY3RvclwiKTt2YXIgYT10aGlzLmssYj10aGlzLm9hLGM9dGhpcy5zdGFydCxkPXRoaXMuZW5kLTE7cmV0dXJuIEVmLnI/RWYucihhLGIsYyxkLG51bGwpOkVmLmNhbGwobnVsbCxhLGIsYyxkLG51bGwpfTtcbmsuYWI9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5zdGFydCE9PXRoaXMuZW5kP25ldyBIYyh0aGlzLHRoaXMuZW5kLXRoaXMuc3RhcnQtMSxudWxsKTpudWxsfTtrLkI9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLnA7cmV0dXJuIG51bGwhPWE/YTp0aGlzLnA9YT13Yyh0aGlzKX07ay5BPWZ1bmN0aW9uKGEsYil7cmV0dXJuIEljKHRoaXMsYil9O2suSj1mdW5jdGlvbigpe3JldHVybiBPKE1jLHRoaXMuayl9O2suUj1mdW5jdGlvbihhLGIpe3JldHVybiBDYy5hKHRoaXMsYil9O2suTz1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIENjLmModGhpcyxiLGMpfTtrLkthPWZ1bmN0aW9uKGEsYixjKXtpZihcIm51bWJlclwiPT09dHlwZW9mIGIpcmV0dXJuIHBiKHRoaXMsYixjKTt0aHJvdyBFcnJvcihcIlN1YnZlYydzIGtleSBmb3IgYXNzb2MgbXVzdCBiZSBhIG51bWJlci5cIik7fTtcbmsuRD1mdW5jdGlvbigpe3ZhciBhPXRoaXM7cmV0dXJuIGZ1bmN0aW9uKGIpe3JldHVybiBmdW5jdGlvbiBkKGUpe3JldHVybiBlPT09YS5lbmQ/bnVsbDpNKEMuYShhLm9hLGUpLG5ldyBWKG51bGwsZnVuY3Rpb24oKXtyZXR1cm4gZnVuY3Rpb24oKXtyZXR1cm4gZChlKzEpfX0oYiksbnVsbCxudWxsKSl9fSh0aGlzKShhLnN0YXJ0KX07ay5GPWZ1bmN0aW9uKGEsYil7dmFyIGM9dGhpcy5vYSxkPXRoaXMuc3RhcnQsZT10aGlzLmVuZCxmPXRoaXMucDtyZXR1cm4gRWYucj9FZi5yKGIsYyxkLGUsZik6RWYuY2FsbChudWxsLGIsYyxkLGUsZil9O2suRz1mdW5jdGlvbihhLGIpe3ZhciBjPXRoaXMuayxkPXBiKHRoaXMub2EsdGhpcy5lbmQsYiksZT10aGlzLnN0YXJ0LGY9dGhpcy5lbmQrMTtyZXR1cm4gRWYucj9FZi5yKGMsZCxlLGYsbnVsbCk6RWYuY2FsbChudWxsLGMsZCxlLGYsbnVsbCl9O1xuay5jYWxsPWZ1bmN0aW9uKCl7dmFyIGE9bnVsbCxhPWZ1bmN0aW9uKGEsYyxkKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiB0aGlzLlEobnVsbCxjKTtjYXNlIDM6cmV0dXJuIHRoaXMuJChudWxsLGMsZCl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2EuYT1mdW5jdGlvbihhLGMpe3JldHVybiB0aGlzLlEobnVsbCxjKX07YS5jPWZ1bmN0aW9uKGEsYyxkKXtyZXR1cm4gdGhpcy4kKG51bGwsYyxkKX07cmV0dXJuIGF9KCk7ay5hcHBseT1mdW5jdGlvbihhLGIpe3JldHVybiB0aGlzLmNhbGwuYXBwbHkodGhpcyxbdGhpc10uY29uY2F0KEZhKGIpKSl9O2suYj1mdW5jdGlvbihhKXtyZXR1cm4gdGhpcy5RKG51bGwsYSl9O2suYT1mdW5jdGlvbihhLGIpe3JldHVybiB0aGlzLiQobnVsbCxhLGIpfTtEZi5wcm90b3R5cGVbRWFdPWZ1bmN0aW9uKCl7cmV0dXJuIHVjKHRoaXMpfTtcbmZ1bmN0aW9uIEVmKGEsYixjLGQsZSl7Zm9yKDs7KWlmKGIgaW5zdGFuY2VvZiBEZiljPWIuc3RhcnQrYyxkPWIuc3RhcnQrZCxiPWIub2E7ZWxzZXt2YXIgZj1RKGIpO2lmKDA+Y3x8MD5kfHxjPmZ8fGQ+Zil0aHJvdyBFcnJvcihcIkluZGV4IG91dCBvZiBib3VuZHNcIik7cmV0dXJuIG5ldyBEZihhLGIsYyxkLGUpfX12YXIgQ2Y9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjKXtyZXR1cm4gRWYobnVsbCxhLGIsYyxudWxsKX1mdW5jdGlvbiBiKGEsYil7cmV0dXJuIGMuYyhhLGIsUShhKSl9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiBiLmNhbGwodGhpcyxjLGUpO2Nhc2UgMzpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmE9YjtjLmM9YTtyZXR1cm4gY30oKTtcbmZ1bmN0aW9uIEZmKGEsYil7cmV0dXJuIGE9PT1iLnU/YjpuZXcgZWYoYSxGYShiLmUpKX1mdW5jdGlvbiB3ZihhKXtyZXR1cm4gbmV3IGVmKHt9LEZhKGEuZSkpfWZ1bmN0aW9uIHhmKGEpe3ZhciBiPVtudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGxdO2hkKGEsMCxiLDAsYS5sZW5ndGgpO3JldHVybiBifVxudmFyIEhmPWZ1bmN0aW9uIEdmKGIsYyxkLGUpe2Q9RmYoYi5yb290LnUsZCk7dmFyIGY9Yi5nLTE+Pj5jJjMxO2lmKDU9PT1jKWI9ZTtlbHNle3ZhciBnPWQuZVtmXTtiPW51bGwhPWc/R2YoYixjLTUsZyxlKTpqZihiLnJvb3QudSxjLTUsZSl9ZC5lW2ZdPWI7cmV0dXJuIGR9LEpmPWZ1bmN0aW9uIElmKGIsYyxkKXtkPUZmKGIucm9vdC51LGQpO3ZhciBlPWIuZy0yPj4+YyYzMTtpZig1PGMpe2I9SWYoYixjLTUsZC5lW2VdKTtpZihudWxsPT1iJiYwPT09ZSlyZXR1cm4gbnVsbDtkLmVbZV09YjtyZXR1cm4gZH1pZigwPT09ZSlyZXR1cm4gbnVsbDtkLmVbZV09bnVsbDtyZXR1cm4gZH07ZnVuY3Rpb24gdmYoYSxiLGMsZCl7dGhpcy5nPWE7dGhpcy5zaGlmdD1iO3RoaXMucm9vdD1jO3RoaXMuVz1kO3RoaXMuaj0yNzU7dGhpcy5xPTg4fWs9dmYucHJvdG90eXBlO1xuay5jYWxsPWZ1bmN0aW9uKCl7dmFyIGE9bnVsbCxhPWZ1bmN0aW9uKGEsYyxkKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiB0aGlzLnQobnVsbCxjKTtjYXNlIDM6cmV0dXJuIHRoaXMucyhudWxsLGMsZCl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2EuYT1mdW5jdGlvbihhLGMpe3JldHVybiB0aGlzLnQobnVsbCxjKX07YS5jPWZ1bmN0aW9uKGEsYyxkKXtyZXR1cm4gdGhpcy5zKG51bGwsYyxkKX07cmV0dXJuIGF9KCk7ay5hcHBseT1mdW5jdGlvbihhLGIpe3JldHVybiB0aGlzLmNhbGwuYXBwbHkodGhpcyxbdGhpc10uY29uY2F0KEZhKGIpKSl9O2suYj1mdW5jdGlvbihhKXtyZXR1cm4gdGhpcy50KG51bGwsYSl9O2suYT1mdW5jdGlvbihhLGIpe3JldHVybiB0aGlzLnMobnVsbCxhLGIpfTtrLnQ9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gJGEuYyh0aGlzLGIsbnVsbCl9O1xuay5zPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm5cIm51bWJlclwiPT09dHlwZW9mIGI/Qy5jKHRoaXMsYixjKTpjfTtrLlE9ZnVuY3Rpb24oYSxiKXtpZih0aGlzLnJvb3QudSlyZXR1cm4gb2YodGhpcyxiKVtiJjMxXTt0aHJvdyBFcnJvcihcIm50aCBhZnRlciBwZXJzaXN0ZW50IVwiKTt9O2suJD1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIDA8PWImJmI8dGhpcy5nP0MuYSh0aGlzLGIpOmN9O2suTD1mdW5jdGlvbigpe2lmKHRoaXMucm9vdC51KXJldHVybiB0aGlzLmc7dGhyb3cgRXJyb3IoXCJjb3VudCBhZnRlciBwZXJzaXN0ZW50IVwiKTt9O1xuay5VYj1mdW5jdGlvbihhLGIsYyl7dmFyIGQ9dGhpcztpZihkLnJvb3QudSl7aWYoMDw9YiYmYjxkLmcpcmV0dXJuIGhmKHRoaXMpPD1iP2QuV1tiJjMxXT1jOihhPWZ1bmN0aW9uKCl7cmV0dXJuIGZ1bmN0aW9uIGYoYSxoKXt2YXIgbD1GZihkLnJvb3QudSxoKTtpZigwPT09YSlsLmVbYiYzMV09YztlbHNle3ZhciBtPWI+Pj5hJjMxLHA9ZihhLTUsbC5lW21dKTtsLmVbbV09cH1yZXR1cm4gbH19KHRoaXMpLmNhbGwobnVsbCxkLnNoaWZ0LGQucm9vdCksZC5yb290PWEpLHRoaXM7aWYoYj09PWQuZylyZXR1cm4gUGIodGhpcyxjKTt0aHJvdyBFcnJvcihbeihcIkluZGV4IFwiKSx6KGIpLHooXCIgb3V0IG9mIGJvdW5kcyBmb3IgVHJhbnNpZW50VmVjdG9yIG9mIGxlbmd0aFwiKSx6KGQuZyldLmpvaW4oXCJcIikpO310aHJvdyBFcnJvcihcImFzc29jISBhZnRlciBwZXJzaXN0ZW50IVwiKTt9O1xuay5WYj1mdW5jdGlvbigpe2lmKHRoaXMucm9vdC51KXtpZigwPT09dGhpcy5nKXRocm93IEVycm9yKFwiQ2FuJ3QgcG9wIGVtcHR5IHZlY3RvclwiKTtpZigxPT09dGhpcy5nKXRoaXMuZz0wO2Vsc2UgaWYoMDwodGhpcy5nLTEmMzEpKXRoaXMuZy09MTtlbHNle3ZhciBhO2E6aWYoYT10aGlzLmctMixhPj1oZih0aGlzKSlhPXRoaXMuVztlbHNle2Zvcih2YXIgYj10aGlzLnJvb3QsYz1iLGQ9dGhpcy5zaGlmdDs7KWlmKDA8ZCljPUZmKGIudSxjLmVbYT4+PmQmMzFdKSxkLT01O2Vsc2V7YT1jLmU7YnJlYWsgYX1hPXZvaWQgMH1iPUpmKHRoaXMsdGhpcy5zaGlmdCx0aGlzLnJvb3QpO2I9bnVsbCE9Yj9iOm5ldyBlZih0aGlzLnJvb3QudSxbbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxcbm51bGwsbnVsbCxudWxsLG51bGxdKTs1PHRoaXMuc2hpZnQmJm51bGw9PWIuZVsxXT8odGhpcy5yb290PUZmKHRoaXMucm9vdC51LGIuZVswXSksdGhpcy5zaGlmdC09NSk6dGhpcy5yb290PWI7dGhpcy5nLT0xO3RoaXMuVz1hfXJldHVybiB0aGlzfXRocm93IEVycm9yKFwicG9wISBhZnRlciBwZXJzaXN0ZW50IVwiKTt9O2sua2I9ZnVuY3Rpb24oYSxiLGMpe2lmKFwibnVtYmVyXCI9PT10eXBlb2YgYilyZXR1cm4gVGIodGhpcyxiLGMpO3Rocm93IEVycm9yKFwiVHJhbnNpZW50VmVjdG9yJ3Mga2V5IGZvciBhc3NvYyEgbXVzdCBiZSBhIG51bWJlci5cIik7fTtcbmsuU2E9ZnVuY3Rpb24oYSxiKXtpZih0aGlzLnJvb3QudSl7aWYoMzI+dGhpcy5nLWhmKHRoaXMpKXRoaXMuV1t0aGlzLmcmMzFdPWI7ZWxzZXt2YXIgYz1uZXcgZWYodGhpcy5yb290LnUsdGhpcy5XKSxkPVtudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGxdO2RbMF09Yjt0aGlzLlc9ZDtpZih0aGlzLmc+Pj41PjE8PHRoaXMuc2hpZnQpe3ZhciBkPVtudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGxdLGU9dGhpcy5zaGlmdCtcbjU7ZFswXT10aGlzLnJvb3Q7ZFsxXT1qZih0aGlzLnJvb3QudSx0aGlzLnNoaWZ0LGMpO3RoaXMucm9vdD1uZXcgZWYodGhpcy5yb290LnUsZCk7dGhpcy5zaGlmdD1lfWVsc2UgdGhpcy5yb290PUhmKHRoaXMsdGhpcy5zaGlmdCx0aGlzLnJvb3QsYyl9dGhpcy5nKz0xO3JldHVybiB0aGlzfXRocm93IEVycm9yKFwiY29uaiEgYWZ0ZXIgcGVyc2lzdGVudCFcIik7fTtrLlRhPWZ1bmN0aW9uKCl7aWYodGhpcy5yb290LnUpe3RoaXMucm9vdC51PW51bGw7dmFyIGE9dGhpcy5nLWhmKHRoaXMpLGI9QXJyYXkoYSk7aGQodGhpcy5XLDAsYiwwLGEpO3JldHVybiBuZXcgVyhudWxsLHRoaXMuZyx0aGlzLnNoaWZ0LHRoaXMucm9vdCxiLG51bGwpfXRocm93IEVycm9yKFwicGVyc2lzdGVudCEgY2FsbGVkIHR3aWNlXCIpO307ZnVuY3Rpb24gS2YoYSxiLGMsZCl7dGhpcy5rPWE7dGhpcy5lYT1iO3RoaXMuc2E9Yzt0aGlzLnA9ZDt0aGlzLnE9MDt0aGlzLmo9MzE4NTA1NzJ9az1LZi5wcm90b3R5cGU7XG5rLnRvU3RyaW5nPWZ1bmN0aW9uKCl7cmV0dXJuIGVjKHRoaXMpfTtrLkg9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5rfTtrLkI9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLnA7cmV0dXJuIG51bGwhPWE/YTp0aGlzLnA9YT13Yyh0aGlzKX07ay5BPWZ1bmN0aW9uKGEsYil7cmV0dXJuIEljKHRoaXMsYil9O2suSj1mdW5jdGlvbigpe3JldHVybiBPKEosdGhpcy5rKX07ay5OPWZ1bmN0aW9uKCl7cmV0dXJuIEcodGhpcy5lYSl9O2suUz1mdW5jdGlvbigpe3ZhciBhPUsodGhpcy5lYSk7cmV0dXJuIGE/bmV3IEtmKHRoaXMuayxhLHRoaXMuc2EsbnVsbCk6bnVsbD09dGhpcy5zYT9OYSh0aGlzKTpuZXcgS2YodGhpcy5rLHRoaXMuc2EsbnVsbCxudWxsKX07ay5EPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXN9O2suRj1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgS2YoYix0aGlzLmVhLHRoaXMuc2EsdGhpcy5wKX07ay5HPWZ1bmN0aW9uKGEsYil7cmV0dXJuIE0oYix0aGlzKX07XG5LZi5wcm90b3R5cGVbRWFdPWZ1bmN0aW9uKCl7cmV0dXJuIHVjKHRoaXMpfTtmdW5jdGlvbiBMZihhLGIsYyxkLGUpe3RoaXMuaz1hO3RoaXMuY291bnQ9Yjt0aGlzLmVhPWM7dGhpcy5zYT1kO3RoaXMucD1lO3RoaXMuaj0zMTg1ODc2Njt0aGlzLnE9ODE5Mn1rPUxmLnByb3RvdHlwZTtrLnRvU3RyaW5nPWZ1bmN0aW9uKCl7cmV0dXJuIGVjKHRoaXMpfTtrLkg9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5rfTtrLkw9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5jb3VudH07ay5MYT1mdW5jdGlvbigpe3JldHVybiBHKHRoaXMuZWEpfTtrLk1hPWZ1bmN0aW9uKCl7aWYodCh0aGlzLmVhKSl7dmFyIGE9Syh0aGlzLmVhKTtyZXR1cm4gYT9uZXcgTGYodGhpcy5rLHRoaXMuY291bnQtMSxhLHRoaXMuc2EsbnVsbCk6bmV3IExmKHRoaXMuayx0aGlzLmNvdW50LTEsRCh0aGlzLnNhKSxNYyxudWxsKX1yZXR1cm4gdGhpc307XG5rLkI9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLnA7cmV0dXJuIG51bGwhPWE/YTp0aGlzLnA9YT13Yyh0aGlzKX07ay5BPWZ1bmN0aW9uKGEsYil7cmV0dXJuIEljKHRoaXMsYil9O2suSj1mdW5jdGlvbigpe3JldHVybiBPKE1mLHRoaXMuayl9O2suTj1mdW5jdGlvbigpe3JldHVybiBHKHRoaXMuZWEpfTtrLlM9ZnVuY3Rpb24oKXtyZXR1cm4gSChEKHRoaXMpKX07ay5EPWZ1bmN0aW9uKCl7dmFyIGE9RCh0aGlzLnNhKSxiPXRoaXMuZWE7cmV0dXJuIHQodChiKT9iOmEpP25ldyBLZihudWxsLHRoaXMuZWEsRChhKSxudWxsKTpudWxsfTtrLkY9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IExmKGIsdGhpcy5jb3VudCx0aGlzLmVhLHRoaXMuc2EsdGhpcy5wKX07XG5rLkc9ZnVuY3Rpb24oYSxiKXt2YXIgYzt0KHRoaXMuZWEpPyhjPXRoaXMuc2EsYz1uZXcgTGYodGhpcy5rLHRoaXMuY291bnQrMSx0aGlzLmVhLE5jLmEodChjKT9jOk1jLGIpLG51bGwpKTpjPW5ldyBMZih0aGlzLmssdGhpcy5jb3VudCsxLE5jLmEodGhpcy5lYSxiKSxNYyxudWxsKTtyZXR1cm4gY307dmFyIE1mPW5ldyBMZihudWxsLDAsbnVsbCxNYywwKTtMZi5wcm90b3R5cGVbRWFdPWZ1bmN0aW9uKCl7cmV0dXJuIHVjKHRoaXMpfTtmdW5jdGlvbiBOZigpe3RoaXMucT0wO3RoaXMuaj0yMDk3MTUyfU5mLnByb3RvdHlwZS5BPWZ1bmN0aW9uKCl7cmV0dXJuITF9O3ZhciBPZj1uZXcgTmY7ZnVuY3Rpb24gUGYoYSxiKXtyZXR1cm4gbWQoZGQoYik/UShhKT09PVEoYik/RWUodWQsT2UuYShmdW5jdGlvbihhKXtyZXR1cm4gc2MuYShTLmMoYixHKGEpLE9mKSxMYyhhKSl9LGEpKTpudWxsOm51bGwpfVxuZnVuY3Rpb24gUWYoYSxiKXt2YXIgYz1hLmU7aWYoYiBpbnN0YW5jZW9mIFUpYTp7Zm9yKHZhciBkPWMubGVuZ3RoLGU9Yi5wYSxmPTA7Oyl7aWYoZDw9Zil7Yz0tMTticmVhayBhfXZhciBnPWNbZl07aWYoZyBpbnN0YW5jZW9mIFUmJmU9PT1nLnBhKXtjPWY7YnJlYWsgYX1mKz0yfWM9dm9pZCAwfWVsc2UgaWYoZD1cInN0cmluZ1wiPT10eXBlb2YgYix0KHQoZCk/ZDpcIm51bWJlclwiPT09dHlwZW9mIGIpKWE6e2Q9Yy5sZW5ndGg7Zm9yKGU9MDs7KXtpZihkPD1lKXtjPS0xO2JyZWFrIGF9aWYoYj09PWNbZV0pe2M9ZTticmVhayBhfWUrPTJ9Yz12b2lkIDB9ZWxzZSBpZihiIGluc3RhbmNlb2YgcWMpYTp7ZD1jLmxlbmd0aDtlPWIudGE7Zm9yKGY9MDs7KXtpZihkPD1mKXtjPS0xO2JyZWFrIGF9Zz1jW2ZdO2lmKGcgaW5zdGFuY2VvZiBxYyYmZT09PWcudGEpe2M9ZjticmVhayBhfWYrPTJ9Yz12b2lkIDB9ZWxzZSBpZihudWxsPT1iKWE6e2Q9Yy5sZW5ndGg7Zm9yKGU9MDs7KXtpZihkPD1cbmUpe2M9LTE7YnJlYWsgYX1pZihudWxsPT1jW2VdKXtjPWU7YnJlYWsgYX1lKz0yfWM9dm9pZCAwfWVsc2UgYTp7ZD1jLmxlbmd0aDtmb3IoZT0wOzspe2lmKGQ8PWUpe2M9LTE7YnJlYWsgYX1pZihzYy5hKGIsY1tlXSkpe2M9ZTticmVhayBhfWUrPTJ9Yz12b2lkIDB9cmV0dXJuIGN9ZnVuY3Rpb24gUmYoYSxiLGMpe3RoaXMuZT1hO3RoaXMubT1iO3RoaXMuWj1jO3RoaXMucT0wO3RoaXMuaj0zMjM3NDk5MH1rPVJmLnByb3RvdHlwZTtrLnRvU3RyaW5nPWZ1bmN0aW9uKCl7cmV0dXJuIGVjKHRoaXMpfTtrLkg9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5afTtrLlQ9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5tPHRoaXMuZS5sZW5ndGgtMj9uZXcgUmYodGhpcy5lLHRoaXMubSsyLHRoaXMuWik6bnVsbH07ay5MPWZ1bmN0aW9uKCl7cmV0dXJuKHRoaXMuZS5sZW5ndGgtdGhpcy5tKS8yfTtrLkI9ZnVuY3Rpb24oKXtyZXR1cm4gd2ModGhpcyl9O1xuay5BPWZ1bmN0aW9uKGEsYil7cmV0dXJuIEljKHRoaXMsYil9O2suSj1mdW5jdGlvbigpe3JldHVybiBPKEosdGhpcy5aKX07ay5SPWZ1bmN0aW9uKGEsYil7cmV0dXJuIFAuYShiLHRoaXMpfTtrLk89ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBQLmMoYixjLHRoaXMpfTtrLk49ZnVuY3Rpb24oKXtyZXR1cm4gbmV3IFcobnVsbCwyLDUsdWYsW3RoaXMuZVt0aGlzLm1dLHRoaXMuZVt0aGlzLm0rMV1dLG51bGwpfTtrLlM9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5tPHRoaXMuZS5sZW5ndGgtMj9uZXcgUmYodGhpcy5lLHRoaXMubSsyLHRoaXMuWik6Sn07ay5EPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXN9O2suRj1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgUmYodGhpcy5lLHRoaXMubSxiKX07ay5HPWZ1bmN0aW9uKGEsYil7cmV0dXJuIE0oYix0aGlzKX07UmYucHJvdG90eXBlW0VhXT1mdW5jdGlvbigpe3JldHVybiB1Yyh0aGlzKX07XG5mdW5jdGlvbiBTZihhLGIsYyl7dGhpcy5lPWE7dGhpcy5tPWI7dGhpcy5nPWN9U2YucHJvdG90eXBlLmdhPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMubTx0aGlzLmd9O1NmLnByb3RvdHlwZS5uZXh0PWZ1bmN0aW9uKCl7dmFyIGE9bmV3IFcobnVsbCwyLDUsdWYsW3RoaXMuZVt0aGlzLm1dLHRoaXMuZVt0aGlzLm0rMV1dLG51bGwpO3RoaXMubSs9MjtyZXR1cm4gYX07ZnVuY3Rpb24gcGEoYSxiLGMsZCl7dGhpcy5rPWE7dGhpcy5nPWI7dGhpcy5lPWM7dGhpcy5wPWQ7dGhpcy5qPTE2NjQ3OTUxO3RoaXMucT04MTk2fWs9cGEucHJvdG90eXBlO2sudG9TdHJpbmc9ZnVuY3Rpb24oKXtyZXR1cm4gZWModGhpcyl9O2sudD1mdW5jdGlvbihhLGIpe3JldHVybiAkYS5jKHRoaXMsYixudWxsKX07ay5zPWZ1bmN0aW9uKGEsYixjKXthPVFmKHRoaXMsYik7cmV0dXJuLTE9PT1hP2M6dGhpcy5lW2ErMV19O1xuay5nYj1mdW5jdGlvbihhLGIsYyl7YT10aGlzLmUubGVuZ3RoO2Zvcih2YXIgZD0wOzspaWYoZDxhKXt2YXIgZT10aGlzLmVbZF0sZj10aGlzLmVbZCsxXTtjPWIuYz9iLmMoYyxlLGYpOmIuY2FsbChudWxsLGMsZSxmKTtpZihBYyhjKSlyZXR1cm4gYj1jLEwuYj9MLmIoYik6TC5jYWxsKG51bGwsYik7ZCs9Mn1lbHNlIHJldHVybiBjfTtrLnZiPSEwO2suZmI9ZnVuY3Rpb24oKXtyZXR1cm4gbmV3IFNmKHRoaXMuZSwwLDIqdGhpcy5nKX07ay5IPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMua307ay5MPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuZ307ay5CPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5wO3JldHVybiBudWxsIT1hP2E6dGhpcy5wPWE9eGModGhpcyl9O1xuay5BPWZ1bmN0aW9uKGEsYil7aWYoYiYmKGIuaiYxMDI0fHxiLmljKSl7dmFyIGM9dGhpcy5lLmxlbmd0aDtpZih0aGlzLmc9PT1iLkwobnVsbCkpZm9yKHZhciBkPTA7OylpZihkPGMpe3ZhciBlPWIucyhudWxsLHRoaXMuZVtkXSxqZCk7aWYoZSE9PWpkKWlmKHNjLmEodGhpcy5lW2QrMV0sZSkpZCs9MjtlbHNlIHJldHVybiExO2Vsc2UgcmV0dXJuITF9ZWxzZSByZXR1cm4hMDtlbHNlIHJldHVybiExfWVsc2UgcmV0dXJuIFBmKHRoaXMsYil9O2suJGE9ZnVuY3Rpb24oKXtyZXR1cm4gbmV3IFRmKHt9LHRoaXMuZS5sZW5ndGgsRmEodGhpcy5lKSl9O2suSj1mdW5jdGlvbigpe3JldHVybiB1YihVZix0aGlzLmspfTtrLlI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gUC5hKGIsdGhpcyl9O2suTz1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIFAuYyhiLGMsdGhpcyl9O1xuay53Yj1mdW5jdGlvbihhLGIpe2lmKDA8PVFmKHRoaXMsYikpe3ZhciBjPXRoaXMuZS5sZW5ndGgsZD1jLTI7aWYoMD09PWQpcmV0dXJuIE5hKHRoaXMpO2Zvcih2YXIgZD1BcnJheShkKSxlPTAsZj0wOzspe2lmKGU+PWMpcmV0dXJuIG5ldyBwYSh0aGlzLmssdGhpcy5nLTEsZCxudWxsKTtzYy5hKGIsdGhpcy5lW2VdKXx8KGRbZl09dGhpcy5lW2VdLGRbZisxXT10aGlzLmVbZSsxXSxmKz0yKTtlKz0yfX1lbHNlIHJldHVybiB0aGlzfTtcbmsuS2E9ZnVuY3Rpb24oYSxiLGMpe2E9UWYodGhpcyxiKTtpZigtMT09PWEpe2lmKHRoaXMuZzxWZil7YT10aGlzLmU7Zm9yKHZhciBkPWEubGVuZ3RoLGU9QXJyYXkoZCsyKSxmPTA7OylpZihmPGQpZVtmXT1hW2ZdLGYrPTE7ZWxzZSBicmVhaztlW2RdPWI7ZVtkKzFdPWM7cmV0dXJuIG5ldyBwYSh0aGlzLmssdGhpcy5nKzEsZSxudWxsKX1yZXR1cm4gdWIoY2IoYWYuYShRYyx0aGlzKSxiLGMpLHRoaXMuayl9aWYoYz09PXRoaXMuZVthKzFdKXJldHVybiB0aGlzO2I9RmEodGhpcy5lKTtiW2ErMV09YztyZXR1cm4gbmV3IHBhKHRoaXMuayx0aGlzLmcsYixudWxsKX07ay5yYj1mdW5jdGlvbihhLGIpe3JldHVybi0xIT09UWYodGhpcyxiKX07ay5EPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5lO3JldHVybiAwPD1hLmxlbmd0aC0yP25ldyBSZihhLDAsbnVsbCk6bnVsbH07ay5GPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyBwYShiLHRoaXMuZyx0aGlzLmUsdGhpcy5wKX07XG5rLkc9ZnVuY3Rpb24oYSxiKXtpZihlZChiKSlyZXR1cm4gY2IodGhpcyxDLmEoYiwwKSxDLmEoYiwxKSk7Zm9yKHZhciBjPXRoaXMsZD1EKGIpOzspe2lmKG51bGw9PWQpcmV0dXJuIGM7dmFyIGU9RyhkKTtpZihlZChlKSljPWNiKGMsQy5hKGUsMCksQy5hKGUsMSkpLGQ9SyhkKTtlbHNlIHRocm93IEVycm9yKFwiY29uaiBvbiBhIG1hcCB0YWtlcyBtYXAgZW50cmllcyBvciBzZXFhYmxlcyBvZiBtYXAgZW50cmllc1wiKTt9fTtcbmsuY2FsbD1mdW5jdGlvbigpe3ZhciBhPW51bGwsYT1mdW5jdGlvbihhLGMsZCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gdGhpcy50KG51bGwsYyk7Y2FzZSAzOnJldHVybiB0aGlzLnMobnVsbCxjLGQpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTthLmE9ZnVuY3Rpb24oYSxjKXtyZXR1cm4gdGhpcy50KG51bGwsYyl9O2EuYz1mdW5jdGlvbihhLGMsZCl7cmV0dXJuIHRoaXMucyhudWxsLGMsZCl9O3JldHVybiBhfSgpO2suYXBwbHk9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gdGhpcy5jYWxsLmFwcGx5KHRoaXMsW3RoaXNdLmNvbmNhdChGYShiKSkpfTtrLmI9ZnVuY3Rpb24oYSl7cmV0dXJuIHRoaXMudChudWxsLGEpfTtrLmE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gdGhpcy5zKG51bGwsYSxiKX07dmFyIFVmPW5ldyBwYShudWxsLDAsW10sbnVsbCksVmY9ODtwYS5wcm90b3R5cGVbRWFdPWZ1bmN0aW9uKCl7cmV0dXJuIHVjKHRoaXMpfTtcbmZ1bmN0aW9uIFRmKGEsYixjKXt0aGlzLlZhPWE7dGhpcy5xYT1iO3RoaXMuZT1jO3RoaXMucT01Njt0aGlzLmo9MjU4fWs9VGYucHJvdG90eXBlO2suSmI9ZnVuY3Rpb24oYSxiKXtpZih0KHRoaXMuVmEpKXt2YXIgYz1RZih0aGlzLGIpOzA8PWMmJih0aGlzLmVbY109dGhpcy5lW3RoaXMucWEtMl0sdGhpcy5lW2MrMV09dGhpcy5lW3RoaXMucWEtMV0sYz10aGlzLmUsYy5wb3AoKSxjLnBvcCgpLHRoaXMucWEtPTIpO3JldHVybiB0aGlzfXRocm93IEVycm9yKFwiZGlzc29jISBhZnRlciBwZXJzaXN0ZW50IVwiKTt9O1xuay5rYj1mdW5jdGlvbihhLGIsYyl7dmFyIGQ9dGhpcztpZih0KGQuVmEpKXthPVFmKHRoaXMsYik7aWYoLTE9PT1hKXJldHVybiBkLnFhKzI8PTIqVmY/KGQucWErPTIsZC5lLnB1c2goYiksZC5lLnB1c2goYyksdGhpcyk6ZWUuYyhmdW5jdGlvbigpe3ZhciBhPWQucWEsYj1kLmU7cmV0dXJuIFhmLmE/WGYuYShhLGIpOlhmLmNhbGwobnVsbCxhLGIpfSgpLGIsYyk7YyE9PWQuZVthKzFdJiYoZC5lW2ErMV09Yyk7cmV0dXJuIHRoaXN9dGhyb3cgRXJyb3IoXCJhc3NvYyEgYWZ0ZXIgcGVyc2lzdGVudCFcIik7fTtcbmsuU2E9ZnVuY3Rpb24oYSxiKXtpZih0KHRoaXMuVmEpKXtpZihiP2IuaiYyMDQ4fHxiLmpjfHwoYi5qPzA6dyhmYixiKSk6dyhmYixiKSlyZXR1cm4gUmIodGhpcyxZZi5iP1lmLmIoYik6WWYuY2FsbChudWxsLGIpLFpmLmI/WmYuYihiKTpaZi5jYWxsKG51bGwsYikpO2Zvcih2YXIgYz1EKGIpLGQ9dGhpczs7KXt2YXIgZT1HKGMpO2lmKHQoZSkpdmFyIGY9ZSxjPUsoYyksZD1SYihkLGZ1bmN0aW9uKCl7dmFyIGE9ZjtyZXR1cm4gWWYuYj9ZZi5iKGEpOllmLmNhbGwobnVsbCxhKX0oKSxmdW5jdGlvbigpe3ZhciBhPWY7cmV0dXJuIFpmLmI/WmYuYihhKTpaZi5jYWxsKG51bGwsYSl9KCkpO2Vsc2UgcmV0dXJuIGR9fWVsc2UgdGhyb3cgRXJyb3IoXCJjb25qISBhZnRlciBwZXJzaXN0ZW50IVwiKTt9O1xuay5UYT1mdW5jdGlvbigpe2lmKHQodGhpcy5WYSkpcmV0dXJuIHRoaXMuVmE9ITEsbmV3IHBhKG51bGwsQ2QodGhpcy5xYSwyKSx0aGlzLmUsbnVsbCk7dGhyb3cgRXJyb3IoXCJwZXJzaXN0ZW50ISBjYWxsZWQgdHdpY2VcIik7fTtrLnQ9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gJGEuYyh0aGlzLGIsbnVsbCl9O2sucz1mdW5jdGlvbihhLGIsYyl7aWYodCh0aGlzLlZhKSlyZXR1cm4gYT1RZih0aGlzLGIpLC0xPT09YT9jOnRoaXMuZVthKzFdO3Rocm93IEVycm9yKFwibG9va3VwIGFmdGVyIHBlcnNpc3RlbnQhXCIpO307ay5MPWZ1bmN0aW9uKCl7aWYodCh0aGlzLlZhKSlyZXR1cm4gQ2QodGhpcy5xYSwyKTt0aHJvdyBFcnJvcihcImNvdW50IGFmdGVyIHBlcnNpc3RlbnQhXCIpO307ZnVuY3Rpb24gWGYoYSxiKXtmb3IodmFyIGM9T2IoUWMpLGQ9MDs7KWlmKGQ8YSljPWVlLmMoYyxiW2RdLGJbZCsxXSksZCs9MjtlbHNlIHJldHVybiBjfWZ1bmN0aW9uICRmKCl7dGhpcy5vPSExfVxuZnVuY3Rpb24gYWcoYSxiKXtyZXR1cm4gYT09PWI/ITA6TmQoYSxiKT8hMDpzYy5hKGEsYil9dmFyIGJnPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyxnLGgpe2E9RmEoYSk7YVtiXT1jO2FbZ109aDtyZXR1cm4gYX1mdW5jdGlvbiBiKGEsYixjKXthPUZhKGEpO2FbYl09YztyZXR1cm4gYX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlLGYsZyxoKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAzOnJldHVybiBiLmNhbGwodGhpcyxjLGUsZik7Y2FzZSA1OnJldHVybiBhLmNhbGwodGhpcyxjLGUsZixnLGgpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmM9YjtjLnI9YTtyZXR1cm4gY30oKTtmdW5jdGlvbiBjZyhhLGIpe3ZhciBjPUFycmF5KGEubGVuZ3RoLTIpO2hkKGEsMCxjLDAsMipiKTtoZChhLDIqKGIrMSksYywyKmIsYy5sZW5ndGgtMipiKTtyZXR1cm4gY31cbnZhciBkZz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMsZyxoLGwpe2E9YS5OYShiKTthLmVbY109ZzthLmVbaF09bDtyZXR1cm4gYX1mdW5jdGlvbiBiKGEsYixjLGcpe2E9YS5OYShiKTthLmVbY109ZztyZXR1cm4gYX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlLGYsZyxoLGwpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDQ6cmV0dXJuIGIuY2FsbCh0aGlzLGMsZSxmLGcpO2Nhc2UgNjpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlLGYsZyxoLGwpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLm49YjtjLlA9YTtyZXR1cm4gY30oKTtcbmZ1bmN0aW9uIGVnKGEsYixjKXtmb3IodmFyIGQ9YS5sZW5ndGgsZT0wLGY9Yzs7KWlmKGU8ZCl7Yz1hW2VdO2lmKG51bGwhPWMpe3ZhciBnPWFbZSsxXTtjPWIuYz9iLmMoZixjLGcpOmIuY2FsbChudWxsLGYsYyxnKX1lbHNlIGM9YVtlKzFdLGM9bnVsbCE9Yz9jLlhhKGIsZik6ZjtpZihBYyhjKSlyZXR1cm4gYT1jLEwuYj9MLmIoYSk6TC5jYWxsKG51bGwsYSk7ZSs9MjtmPWN9ZWxzZSByZXR1cm4gZn1mdW5jdGlvbiBmZyhhLGIsYyl7dGhpcy51PWE7dGhpcy53PWI7dGhpcy5lPWN9az1mZy5wcm90b3R5cGU7ay5OYT1mdW5jdGlvbihhKXtpZihhPT09dGhpcy51KXJldHVybiB0aGlzO3ZhciBiPURkKHRoaXMudyksYz1BcnJheSgwPmI/NDoyKihiKzEpKTtoZCh0aGlzLmUsMCxjLDAsMipiKTtyZXR1cm4gbmV3IGZnKGEsdGhpcy53LGMpfTtcbmsubmI9ZnVuY3Rpb24oYSxiLGMsZCxlKXt2YXIgZj0xPDwoYz4+PmImMzEpO2lmKDA9PT0odGhpcy53JmYpKXJldHVybiB0aGlzO3ZhciBnPURkKHRoaXMudyZmLTEpLGg9dGhpcy5lWzIqZ10sbD10aGlzLmVbMipnKzFdO3JldHVybiBudWxsPT1oPyhiPWwubmIoYSxiKzUsYyxkLGUpLGI9PT1sP3RoaXM6bnVsbCE9Yj9kZy5uKHRoaXMsYSwyKmcrMSxiKTp0aGlzLnc9PT1mP251bGw6Z2codGhpcyxhLGYsZykpOmFnKGQsaCk/KGVbMF09ITAsZ2codGhpcyxhLGYsZykpOnRoaXN9O2Z1bmN0aW9uIGdnKGEsYixjLGQpe2lmKGEudz09PWMpcmV0dXJuIG51bGw7YT1hLk5hKGIpO2I9YS5lO3ZhciBlPWIubGVuZ3RoO2Eud149YztoZChiLDIqKGQrMSksYiwyKmQsZS0yKihkKzEpKTtiW2UtMl09bnVsbDtiW2UtMV09bnVsbDtyZXR1cm4gYX1rLmxiPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5lO3JldHVybiBoZy5iP2hnLmIoYSk6aGcuY2FsbChudWxsLGEpfTtcbmsuWGE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gZWcodGhpcy5lLGEsYil9O2suT2E9ZnVuY3Rpb24oYSxiLGMsZCl7dmFyIGU9MTw8KGI+Pj5hJjMxKTtpZigwPT09KHRoaXMudyZlKSlyZXR1cm4gZDt2YXIgZj1EZCh0aGlzLncmZS0xKSxlPXRoaXMuZVsyKmZdLGY9dGhpcy5lWzIqZisxXTtyZXR1cm4gbnVsbD09ZT9mLk9hKGErNSxiLGMsZCk6YWcoYyxlKT9mOmR9O1xuay5sYT1mdW5jdGlvbihhLGIsYyxkLGUsZil7dmFyIGc9MTw8KGM+Pj5iJjMxKSxoPURkKHRoaXMudyZnLTEpO2lmKDA9PT0odGhpcy53JmcpKXt2YXIgbD1EZCh0aGlzLncpO2lmKDIqbDx0aGlzLmUubGVuZ3RoKXt2YXIgbT10aGlzLk5hKGEpLHA9bS5lO2Yubz0hMDtpZChwLDIqaCxwLDIqKGgrMSksMioobC1oKSk7cFsyKmhdPWQ7cFsyKmgrMV09ZTttLnd8PWc7cmV0dXJuIG19aWYoMTY8PWwpe2c9W251bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbF07Z1tjPj4+YiYzMV09aWcubGEoYSxiKzUsYyxkLGUsZik7Zm9yKG09aD0wOzspaWYoMzI+aCkwIT09KHRoaXMudz4+PmgmMSkmJihnW2hdPW51bGwhPXRoaXMuZVttXT9pZy5sYShhLGIrNSxuYyh0aGlzLmVbbV0pLFxudGhpcy5lW21dLHRoaXMuZVttKzFdLGYpOnRoaXMuZVttKzFdLG0rPTIpLGgrPTE7ZWxzZSBicmVhaztyZXR1cm4gbmV3IGpnKGEsbCsxLGcpfXA9QXJyYXkoMioobCs0KSk7aGQodGhpcy5lLDAscCwwLDIqaCk7cFsyKmhdPWQ7cFsyKmgrMV09ZTtoZCh0aGlzLmUsMipoLHAsMiooaCsxKSwyKihsLWgpKTtmLm89ITA7bT10aGlzLk5hKGEpO20uZT1wO20ud3w9ZztyZXR1cm4gbX12YXIgcT10aGlzLmVbMipoXSxzPXRoaXMuZVsyKmgrMV07aWYobnVsbD09cSlyZXR1cm4gbD1zLmxhKGEsYis1LGMsZCxlLGYpLGw9PT1zP3RoaXM6ZGcubih0aGlzLGEsMipoKzEsbCk7aWYoYWcoZCxxKSlyZXR1cm4gZT09PXM/dGhpczpkZy5uKHRoaXMsYSwyKmgrMSxlKTtmLm89ITA7cmV0dXJuIGRnLlAodGhpcyxhLDIqaCxudWxsLDIqaCsxLGZ1bmN0aW9uKCl7dmFyIGY9Yis1O3JldHVybiBrZy5pYT9rZy5pYShhLGYscSxzLGMsZCxlKTprZy5jYWxsKG51bGwsYSxmLHEscyxjLGQsZSl9KCkpfTtcbmsua2E9ZnVuY3Rpb24oYSxiLGMsZCxlKXt2YXIgZj0xPDwoYj4+PmEmMzEpLGc9RGQodGhpcy53JmYtMSk7aWYoMD09PSh0aGlzLncmZikpe3ZhciBoPURkKHRoaXMudyk7aWYoMTY8PWgpe2Y9W251bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbF07ZltiPj4+YSYzMV09aWcua2EoYSs1LGIsYyxkLGUpO2Zvcih2YXIgbD1nPTA7OylpZigzMj5nKTAhPT0odGhpcy53Pj4+ZyYxKSYmKGZbZ109bnVsbCE9dGhpcy5lW2xdP2lnLmthKGErNSxuYyh0aGlzLmVbbF0pLHRoaXMuZVtsXSx0aGlzLmVbbCsxXSxlKTp0aGlzLmVbbCsxXSxsKz0yKSxnKz0xO2Vsc2UgYnJlYWs7cmV0dXJuIG5ldyBqZyhudWxsLGgrMSxmKX1sPUFycmF5KDIqKGgrMSkpO2hkKHRoaXMuZSxcbjAsbCwwLDIqZyk7bFsyKmddPWM7bFsyKmcrMV09ZDtoZCh0aGlzLmUsMipnLGwsMiooZysxKSwyKihoLWcpKTtlLm89ITA7cmV0dXJuIG5ldyBmZyhudWxsLHRoaXMud3xmLGwpfXZhciBtPXRoaXMuZVsyKmddLHA9dGhpcy5lWzIqZysxXTtpZihudWxsPT1tKXJldHVybiBoPXAua2EoYSs1LGIsYyxkLGUpLGg9PT1wP3RoaXM6bmV3IGZnKG51bGwsdGhpcy53LGJnLmModGhpcy5lLDIqZysxLGgpKTtpZihhZyhjLG0pKXJldHVybiBkPT09cD90aGlzOm5ldyBmZyhudWxsLHRoaXMudyxiZy5jKHRoaXMuZSwyKmcrMSxkKSk7ZS5vPSEwO3JldHVybiBuZXcgZmcobnVsbCx0aGlzLncsYmcucih0aGlzLmUsMipnLG51bGwsMipnKzEsZnVuY3Rpb24oKXt2YXIgZT1hKzU7cmV0dXJuIGtnLlA/a2cuUChlLG0scCxiLGMsZCk6a2cuY2FsbChudWxsLGUsbSxwLGIsYyxkKX0oKSkpfTtcbmsubWI9ZnVuY3Rpb24oYSxiLGMpe3ZhciBkPTE8PChiPj4+YSYzMSk7aWYoMD09PSh0aGlzLncmZCkpcmV0dXJuIHRoaXM7dmFyIGU9RGQodGhpcy53JmQtMSksZj10aGlzLmVbMiplXSxnPXRoaXMuZVsyKmUrMV07cmV0dXJuIG51bGw9PWY/KGE9Zy5tYihhKzUsYixjKSxhPT09Zz90aGlzOm51bGwhPWE/bmV3IGZnKG51bGwsdGhpcy53LGJnLmModGhpcy5lLDIqZSsxLGEpKTp0aGlzLnc9PT1kP251bGw6bmV3IGZnKG51bGwsdGhpcy53XmQsY2codGhpcy5lLGUpKSk6YWcoYyxmKT9uZXcgZmcobnVsbCx0aGlzLndeZCxjZyh0aGlzLmUsZSkpOnRoaXN9O3ZhciBpZz1uZXcgZmcobnVsbCwwLFtdKTtcbmZ1bmN0aW9uIGxnKGEsYixjKXt2YXIgZD1hLmUsZT1kLmxlbmd0aDthPUFycmF5KDIqKGEuZy0xKSk7Zm9yKHZhciBmPTAsZz0xLGg9MDs7KWlmKGY8ZSlmIT09YyYmbnVsbCE9ZFtmXSYmKGFbZ109ZFtmXSxnKz0yLGh8PTE8PGYpLGYrPTE7ZWxzZSByZXR1cm4gbmV3IGZnKGIsaCxhKX1mdW5jdGlvbiBqZyhhLGIsYyl7dGhpcy51PWE7dGhpcy5nPWI7dGhpcy5lPWN9az1qZy5wcm90b3R5cGU7ay5OYT1mdW5jdGlvbihhKXtyZXR1cm4gYT09PXRoaXMudT90aGlzOm5ldyBqZyhhLHRoaXMuZyxGYSh0aGlzLmUpKX07XG5rLm5iPWZ1bmN0aW9uKGEsYixjLGQsZSl7dmFyIGY9Yz4+PmImMzEsZz10aGlzLmVbZl07aWYobnVsbD09ZylyZXR1cm4gdGhpcztiPWcubmIoYSxiKzUsYyxkLGUpO2lmKGI9PT1nKXJldHVybiB0aGlzO2lmKG51bGw9PWIpe2lmKDg+PXRoaXMuZylyZXR1cm4gbGcodGhpcyxhLGYpO2E9ZGcubih0aGlzLGEsZixiKTthLmctPTE7cmV0dXJuIGF9cmV0dXJuIGRnLm4odGhpcyxhLGYsYil9O2subGI9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLmU7cmV0dXJuIG1nLmI/bWcuYihhKTptZy5jYWxsKG51bGwsYSl9O2suWGE9ZnVuY3Rpb24oYSxiKXtmb3IodmFyIGM9dGhpcy5lLmxlbmd0aCxkPTAsZT1iOzspaWYoZDxjKXt2YXIgZj10aGlzLmVbZF07aWYobnVsbCE9ZiYmKGU9Zi5YYShhLGUpLEFjKGUpKSlyZXR1cm4gYz1lLEwuYj9MLmIoYyk6TC5jYWxsKG51bGwsYyk7ZCs9MX1lbHNlIHJldHVybiBlfTtcbmsuT2E9ZnVuY3Rpb24oYSxiLGMsZCl7dmFyIGU9dGhpcy5lW2I+Pj5hJjMxXTtyZXR1cm4gbnVsbCE9ZT9lLk9hKGErNSxiLGMsZCk6ZH07ay5sYT1mdW5jdGlvbihhLGIsYyxkLGUsZil7dmFyIGc9Yz4+PmImMzEsaD10aGlzLmVbZ107aWYobnVsbD09aClyZXR1cm4gYT1kZy5uKHRoaXMsYSxnLGlnLmxhKGEsYis1LGMsZCxlLGYpKSxhLmcrPTEsYTtiPWgubGEoYSxiKzUsYyxkLGUsZik7cmV0dXJuIGI9PT1oP3RoaXM6ZGcubih0aGlzLGEsZyxiKX07ay5rYT1mdW5jdGlvbihhLGIsYyxkLGUpe3ZhciBmPWI+Pj5hJjMxLGc9dGhpcy5lW2ZdO2lmKG51bGw9PWcpcmV0dXJuIG5ldyBqZyhudWxsLHRoaXMuZysxLGJnLmModGhpcy5lLGYsaWcua2EoYSs1LGIsYyxkLGUpKSk7YT1nLmthKGErNSxiLGMsZCxlKTtyZXR1cm4gYT09PWc/dGhpczpuZXcgamcobnVsbCx0aGlzLmcsYmcuYyh0aGlzLmUsZixhKSl9O1xuay5tYj1mdW5jdGlvbihhLGIsYyl7dmFyIGQ9Yj4+PmEmMzEsZT10aGlzLmVbZF07cmV0dXJuIG51bGwhPWU/KGE9ZS5tYihhKzUsYixjKSxhPT09ZT90aGlzOm51bGw9PWE/OD49dGhpcy5nP2xnKHRoaXMsbnVsbCxkKTpuZXcgamcobnVsbCx0aGlzLmctMSxiZy5jKHRoaXMuZSxkLGEpKTpuZXcgamcobnVsbCx0aGlzLmcsYmcuYyh0aGlzLmUsZCxhKSkpOnRoaXN9O2Z1bmN0aW9uIG5nKGEsYixjKXtiKj0yO2Zvcih2YXIgZD0wOzspaWYoZDxiKXtpZihhZyhjLGFbZF0pKXJldHVybiBkO2QrPTJ9ZWxzZSByZXR1cm4tMX1mdW5jdGlvbiBvZyhhLGIsYyxkKXt0aGlzLnU9YTt0aGlzLklhPWI7dGhpcy5nPWM7dGhpcy5lPWR9az1vZy5wcm90b3R5cGU7ay5OYT1mdW5jdGlvbihhKXtpZihhPT09dGhpcy51KXJldHVybiB0aGlzO3ZhciBiPUFycmF5KDIqKHRoaXMuZysxKSk7aGQodGhpcy5lLDAsYiwwLDIqdGhpcy5nKTtyZXR1cm4gbmV3IG9nKGEsdGhpcy5JYSx0aGlzLmcsYil9O1xuay5uYj1mdW5jdGlvbihhLGIsYyxkLGUpe2I9bmcodGhpcy5lLHRoaXMuZyxkKTtpZigtMT09PWIpcmV0dXJuIHRoaXM7ZVswXT0hMDtpZigxPT09dGhpcy5nKXJldHVybiBudWxsO2E9dGhpcy5OYShhKTtlPWEuZTtlW2JdPWVbMip0aGlzLmctMl07ZVtiKzFdPWVbMip0aGlzLmctMV07ZVsyKnRoaXMuZy0xXT1udWxsO2VbMip0aGlzLmctMl09bnVsbDthLmctPTE7cmV0dXJuIGF9O2subGI9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLmU7cmV0dXJuIGhnLmI/aGcuYihhKTpoZy5jYWxsKG51bGwsYSl9O2suWGE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gZWcodGhpcy5lLGEsYil9O2suT2E9ZnVuY3Rpb24oYSxiLGMsZCl7YT1uZyh0aGlzLmUsdGhpcy5nLGMpO3JldHVybiAwPmE/ZDphZyhjLHRoaXMuZVthXSk/dGhpcy5lW2ErMV06ZH07XG5rLmxhPWZ1bmN0aW9uKGEsYixjLGQsZSxmKXtpZihjPT09dGhpcy5JYSl7Yj1uZyh0aGlzLmUsdGhpcy5nLGQpO2lmKC0xPT09Yil7aWYodGhpcy5lLmxlbmd0aD4yKnRoaXMuZylyZXR1cm4gYT1kZy5QKHRoaXMsYSwyKnRoaXMuZyxkLDIqdGhpcy5nKzEsZSksZi5vPSEwLGEuZys9MSxhO2M9dGhpcy5lLmxlbmd0aDtiPUFycmF5KGMrMik7aGQodGhpcy5lLDAsYiwwLGMpO2JbY109ZDtiW2MrMV09ZTtmLm89ITA7Zj10aGlzLmcrMTthPT09dGhpcy51Pyh0aGlzLmU9Yix0aGlzLmc9ZixhPXRoaXMpOmE9bmV3IG9nKHRoaXMudSx0aGlzLklhLGYsYik7cmV0dXJuIGF9cmV0dXJuIHRoaXMuZVtiKzFdPT09ZT90aGlzOmRnLm4odGhpcyxhLGIrMSxlKX1yZXR1cm4obmV3IGZnKGEsMTw8KHRoaXMuSWE+Pj5iJjMxKSxbbnVsbCx0aGlzLG51bGwsbnVsbF0pKS5sYShhLGIsYyxkLGUsZil9O1xuay5rYT1mdW5jdGlvbihhLGIsYyxkLGUpe3JldHVybiBiPT09dGhpcy5JYT8oYT1uZyh0aGlzLmUsdGhpcy5nLGMpLC0xPT09YT8oYT0yKnRoaXMuZyxiPUFycmF5KGErMiksaGQodGhpcy5lLDAsYiwwLGEpLGJbYV09YyxiW2ErMV09ZCxlLm89ITAsbmV3IG9nKG51bGwsdGhpcy5JYSx0aGlzLmcrMSxiKSk6c2MuYSh0aGlzLmVbYV0sZCk/dGhpczpuZXcgb2cobnVsbCx0aGlzLklhLHRoaXMuZyxiZy5jKHRoaXMuZSxhKzEsZCkpKToobmV3IGZnKG51bGwsMTw8KHRoaXMuSWE+Pj5hJjMxKSxbbnVsbCx0aGlzXSkpLmthKGEsYixjLGQsZSl9O2subWI9ZnVuY3Rpb24oYSxiLGMpe2E9bmcodGhpcy5lLHRoaXMuZyxjKTtyZXR1cm4tMT09PWE/dGhpczoxPT09dGhpcy5nP251bGw6bmV3IG9nKG51bGwsdGhpcy5JYSx0aGlzLmctMSxjZyh0aGlzLmUsQ2QoYSwyKSkpfTtcbnZhciBrZz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMsZyxoLGwsbSl7dmFyIHA9bmMoYyk7aWYocD09PWgpcmV0dXJuIG5ldyBvZyhudWxsLHAsMixbYyxnLGwsbV0pO3ZhciBxPW5ldyAkZjtyZXR1cm4gaWcubGEoYSxiLHAsYyxnLHEpLmxhKGEsYixoLGwsbSxxKX1mdW5jdGlvbiBiKGEsYixjLGcsaCxsKXt2YXIgbT1uYyhiKTtpZihtPT09ZylyZXR1cm4gbmV3IG9nKG51bGwsbSwyLFtiLGMsaCxsXSk7dmFyIHA9bmV3ICRmO3JldHVybiBpZy5rYShhLG0sYixjLHApLmthKGEsZyxoLGwscCl9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSxmLGcsaCxsLG0pe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDY6cmV0dXJuIGIuY2FsbCh0aGlzLGMsZSxmLGcsaCxsKTtjYXNlIDc6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSxmLGcsaCxsLG0pfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLlA9YjtjLmlhPWE7cmV0dXJuIGN9KCk7XG5mdW5jdGlvbiBwZyhhLGIsYyxkLGUpe3RoaXMuaz1hO3RoaXMuUGE9Yjt0aGlzLm09Yzt0aGlzLkM9ZDt0aGlzLnA9ZTt0aGlzLnE9MDt0aGlzLmo9MzIzNzQ4NjB9az1wZy5wcm90b3R5cGU7ay50b1N0cmluZz1mdW5jdGlvbigpe3JldHVybiBlYyh0aGlzKX07ay5IPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMua307ay5CPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5wO3JldHVybiBudWxsIT1hP2E6dGhpcy5wPWE9d2ModGhpcyl9O2suQT1mdW5jdGlvbihhLGIpe3JldHVybiBJYyh0aGlzLGIpfTtrLko9ZnVuY3Rpb24oKXtyZXR1cm4gTyhKLHRoaXMuayl9O2suUj1mdW5jdGlvbihhLGIpe3JldHVybiBQLmEoYix0aGlzKX07ay5PPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gUC5jKGIsYyx0aGlzKX07ay5OPWZ1bmN0aW9uKCl7cmV0dXJuIG51bGw9PXRoaXMuQz9uZXcgVyhudWxsLDIsNSx1ZixbdGhpcy5QYVt0aGlzLm1dLHRoaXMuUGFbdGhpcy5tKzFdXSxudWxsKTpHKHRoaXMuQyl9O1xuay5TPWZ1bmN0aW9uKCl7aWYobnVsbD09dGhpcy5DKXt2YXIgYT10aGlzLlBhLGI9dGhpcy5tKzI7cmV0dXJuIGhnLmM/aGcuYyhhLGIsbnVsbCk6aGcuY2FsbChudWxsLGEsYixudWxsKX12YXIgYT10aGlzLlBhLGI9dGhpcy5tLGM9Syh0aGlzLkMpO3JldHVybiBoZy5jP2hnLmMoYSxiLGMpOmhnLmNhbGwobnVsbCxhLGIsYyl9O2suRD1mdW5jdGlvbigpe3JldHVybiB0aGlzfTtrLkY9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IHBnKGIsdGhpcy5QYSx0aGlzLm0sdGhpcy5DLHRoaXMucCl9O2suRz1mdW5jdGlvbihhLGIpe3JldHVybiBNKGIsdGhpcyl9O3BnLnByb3RvdHlwZVtFYV09ZnVuY3Rpb24oKXtyZXR1cm4gdWModGhpcyl9O1xudmFyIGhnPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyl7aWYobnVsbD09Yylmb3IoYz1hLmxlbmd0aDs7KWlmKGI8Yyl7aWYobnVsbCE9YVtiXSlyZXR1cm4gbmV3IHBnKG51bGwsYSxiLG51bGwsbnVsbCk7dmFyIGc9YVtiKzFdO2lmKHQoZykmJihnPWcubGIoKSx0KGcpKSlyZXR1cm4gbmV3IHBnKG51bGwsYSxiKzIsZyxudWxsKTtiKz0yfWVsc2UgcmV0dXJuIG51bGw7ZWxzZSByZXR1cm4gbmV3IHBnKG51bGwsYSxiLGMsbnVsbCl9ZnVuY3Rpb24gYihhKXtyZXR1cm4gYy5jKGEsMCxudWxsKX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGIuY2FsbCh0aGlzLGMpO2Nhc2UgMzpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmI9YjtjLmM9YTtyZXR1cm4gY30oKTtcbmZ1bmN0aW9uIHFnKGEsYixjLGQsZSl7dGhpcy5rPWE7dGhpcy5QYT1iO3RoaXMubT1jO3RoaXMuQz1kO3RoaXMucD1lO3RoaXMucT0wO3RoaXMuaj0zMjM3NDg2MH1rPXFnLnByb3RvdHlwZTtrLnRvU3RyaW5nPWZ1bmN0aW9uKCl7cmV0dXJuIGVjKHRoaXMpfTtrLkg9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5rfTtrLkI9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLnA7cmV0dXJuIG51bGwhPWE/YTp0aGlzLnA9YT13Yyh0aGlzKX07ay5BPWZ1bmN0aW9uKGEsYil7cmV0dXJuIEljKHRoaXMsYil9O2suSj1mdW5jdGlvbigpe3JldHVybiBPKEosdGhpcy5rKX07ay5SPWZ1bmN0aW9uKGEsYil7cmV0dXJuIFAuYShiLHRoaXMpfTtrLk89ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBQLmMoYixjLHRoaXMpfTtrLk49ZnVuY3Rpb24oKXtyZXR1cm4gRyh0aGlzLkMpfTtcbmsuUz1mdW5jdGlvbigpe3ZhciBhPXRoaXMuUGEsYj10aGlzLm0sYz1LKHRoaXMuQyk7cmV0dXJuIG1nLm4/bWcubihudWxsLGEsYixjKTptZy5jYWxsKG51bGwsbnVsbCxhLGIsYyl9O2suRD1mdW5jdGlvbigpe3JldHVybiB0aGlzfTtrLkY9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IHFnKGIsdGhpcy5QYSx0aGlzLm0sdGhpcy5DLHRoaXMucCl9O2suRz1mdW5jdGlvbihhLGIpe3JldHVybiBNKGIsdGhpcyl9O3FnLnByb3RvdHlwZVtFYV09ZnVuY3Rpb24oKXtyZXR1cm4gdWModGhpcyl9O1xudmFyIG1nPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyxnKXtpZihudWxsPT1nKWZvcihnPWIubGVuZ3RoOzspaWYoYzxnKXt2YXIgaD1iW2NdO2lmKHQoaCkmJihoPWgubGIoKSx0KGgpKSlyZXR1cm4gbmV3IHFnKGEsYixjKzEsaCxudWxsKTtjKz0xfWVsc2UgcmV0dXJuIG51bGw7ZWxzZSByZXR1cm4gbmV3IHFnKGEsYixjLGcsbnVsbCl9ZnVuY3Rpb24gYihhKXtyZXR1cm4gYy5uKG51bGwsYSwwLG51bGwpfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUsZixnKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiLmNhbGwodGhpcyxjKTtjYXNlIDQ6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSxmLGcpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmI9YjtjLm49YTtyZXR1cm4gY30oKTtcbmZ1bmN0aW9uIHJnKGEsYixjLGQsZSxmKXt0aGlzLms9YTt0aGlzLmc9Yjt0aGlzLnJvb3Q9Yzt0aGlzLlU9ZDt0aGlzLmRhPWU7dGhpcy5wPWY7dGhpcy5qPTE2MTIzNjYzO3RoaXMucT04MTk2fWs9cmcucHJvdG90eXBlO2sudG9TdHJpbmc9ZnVuY3Rpb24oKXtyZXR1cm4gZWModGhpcyl9O2sudD1mdW5jdGlvbihhLGIpe3JldHVybiAkYS5jKHRoaXMsYixudWxsKX07ay5zPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gbnVsbD09Yj90aGlzLlU/dGhpcy5kYTpjOm51bGw9PXRoaXMucm9vdD9jOnRoaXMucm9vdC5PYSgwLG5jKGIpLGIsYyl9O2suZ2I9ZnVuY3Rpb24oYSxiLGMpe3RoaXMuVSYmKGE9dGhpcy5kYSxjPWIuYz9iLmMoYyxudWxsLGEpOmIuY2FsbChudWxsLGMsbnVsbCxhKSk7cmV0dXJuIEFjKGMpP0wuYj9MLmIoYyk6TC5jYWxsKG51bGwsYyk6bnVsbCE9dGhpcy5yb290P3RoaXMucm9vdC5YYShiLGMpOmN9O2suSD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmt9O2suTD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmd9O1xuay5CPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5wO3JldHVybiBudWxsIT1hP2E6dGhpcy5wPWE9eGModGhpcyl9O2suQT1mdW5jdGlvbihhLGIpe3JldHVybiBQZih0aGlzLGIpfTtrLiRhPWZ1bmN0aW9uKCl7cmV0dXJuIG5ldyBzZyh7fSx0aGlzLnJvb3QsdGhpcy5nLHRoaXMuVSx0aGlzLmRhKX07ay5KPWZ1bmN0aW9uKCl7cmV0dXJuIHViKFFjLHRoaXMuayl9O2sud2I9ZnVuY3Rpb24oYSxiKXtpZihudWxsPT1iKXJldHVybiB0aGlzLlU/bmV3IHJnKHRoaXMuayx0aGlzLmctMSx0aGlzLnJvb3QsITEsbnVsbCxudWxsKTp0aGlzO2lmKG51bGw9PXRoaXMucm9vdClyZXR1cm4gdGhpczt2YXIgYz10aGlzLnJvb3QubWIoMCxuYyhiKSxiKTtyZXR1cm4gYz09PXRoaXMucm9vdD90aGlzOm5ldyByZyh0aGlzLmssdGhpcy5nLTEsYyx0aGlzLlUsdGhpcy5kYSxudWxsKX07XG5rLkthPWZ1bmN0aW9uKGEsYixjKXtpZihudWxsPT1iKXJldHVybiB0aGlzLlUmJmM9PT10aGlzLmRhP3RoaXM6bmV3IHJnKHRoaXMuayx0aGlzLlU/dGhpcy5nOnRoaXMuZysxLHRoaXMucm9vdCwhMCxjLG51bGwpO2E9bmV3ICRmO2I9KG51bGw9PXRoaXMucm9vdD9pZzp0aGlzLnJvb3QpLmthKDAsbmMoYiksYixjLGEpO3JldHVybiBiPT09dGhpcy5yb290P3RoaXM6bmV3IHJnKHRoaXMuayxhLm8/dGhpcy5nKzE6dGhpcy5nLGIsdGhpcy5VLHRoaXMuZGEsbnVsbCl9O2sucmI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbnVsbD09Yj90aGlzLlU6bnVsbD09dGhpcy5yb290PyExOnRoaXMucm9vdC5PYSgwLG5jKGIpLGIsamQpIT09amR9O2suRD1mdW5jdGlvbigpe2lmKDA8dGhpcy5nKXt2YXIgYT1udWxsIT10aGlzLnJvb3Q/dGhpcy5yb290LmxiKCk6bnVsbDtyZXR1cm4gdGhpcy5VP00obmV3IFcobnVsbCwyLDUsdWYsW251bGwsdGhpcy5kYV0sbnVsbCksYSk6YX1yZXR1cm4gbnVsbH07XG5rLkY9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IHJnKGIsdGhpcy5nLHRoaXMucm9vdCx0aGlzLlUsdGhpcy5kYSx0aGlzLnApfTtrLkc9ZnVuY3Rpb24oYSxiKXtpZihlZChiKSlyZXR1cm4gY2IodGhpcyxDLmEoYiwwKSxDLmEoYiwxKSk7Zm9yKHZhciBjPXRoaXMsZD1EKGIpOzspe2lmKG51bGw9PWQpcmV0dXJuIGM7dmFyIGU9RyhkKTtpZihlZChlKSljPWNiKGMsQy5hKGUsMCksQy5hKGUsMSkpLGQ9SyhkKTtlbHNlIHRocm93IEVycm9yKFwiY29uaiBvbiBhIG1hcCB0YWtlcyBtYXAgZW50cmllcyBvciBzZXFhYmxlcyBvZiBtYXAgZW50cmllc1wiKTt9fTtcbmsuY2FsbD1mdW5jdGlvbigpe3ZhciBhPW51bGwsYT1mdW5jdGlvbihhLGMsZCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gdGhpcy50KG51bGwsYyk7Y2FzZSAzOnJldHVybiB0aGlzLnMobnVsbCxjLGQpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTthLmE9ZnVuY3Rpb24oYSxjKXtyZXR1cm4gdGhpcy50KG51bGwsYyl9O2EuYz1mdW5jdGlvbihhLGMsZCl7cmV0dXJuIHRoaXMucyhudWxsLGMsZCl9O3JldHVybiBhfSgpO2suYXBwbHk9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gdGhpcy5jYWxsLmFwcGx5KHRoaXMsW3RoaXNdLmNvbmNhdChGYShiKSkpfTtrLmI9ZnVuY3Rpb24oYSl7cmV0dXJuIHRoaXMudChudWxsLGEpfTtrLmE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gdGhpcy5zKG51bGwsYSxiKX07dmFyIFFjPW5ldyByZyhudWxsLDAsbnVsbCwhMSxudWxsLDApO3JnLnByb3RvdHlwZVtFYV09ZnVuY3Rpb24oKXtyZXR1cm4gdWModGhpcyl9O1xuZnVuY3Rpb24gc2coYSxiLGMsZCxlKXt0aGlzLnU9YTt0aGlzLnJvb3Q9Yjt0aGlzLmNvdW50PWM7dGhpcy5VPWQ7dGhpcy5kYT1lO3RoaXMucT01Njt0aGlzLmo9MjU4fWs9c2cucHJvdG90eXBlO2suSmI9ZnVuY3Rpb24oYSxiKXtpZih0aGlzLnUpaWYobnVsbD09Yil0aGlzLlUmJih0aGlzLlU9ITEsdGhpcy5kYT1udWxsLHRoaXMuY291bnQtPTEpO2Vsc2V7aWYobnVsbCE9dGhpcy5yb290KXt2YXIgYz1uZXcgJGYsZD10aGlzLnJvb3QubmIodGhpcy51LDAsbmMoYiksYixjKTtkIT09dGhpcy5yb290JiYodGhpcy5yb290PWQpO3QoY1swXSkmJih0aGlzLmNvdW50LT0xKX19ZWxzZSB0aHJvdyBFcnJvcihcImRpc3NvYyEgYWZ0ZXIgcGVyc2lzdGVudCFcIik7cmV0dXJuIHRoaXN9O2sua2I9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiB0Zyh0aGlzLGIsYyl9O2suU2E9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gdWcodGhpcyxiKX07XG5rLlRhPWZ1bmN0aW9uKCl7dmFyIGE7aWYodGhpcy51KXRoaXMudT1udWxsLGE9bmV3IHJnKG51bGwsdGhpcy5jb3VudCx0aGlzLnJvb3QsdGhpcy5VLHRoaXMuZGEsbnVsbCk7ZWxzZSB0aHJvdyBFcnJvcihcInBlcnNpc3RlbnQhIGNhbGxlZCB0d2ljZVwiKTtyZXR1cm4gYX07ay50PWZ1bmN0aW9uKGEsYil7cmV0dXJuIG51bGw9PWI/dGhpcy5VP3RoaXMuZGE6bnVsbDpudWxsPT10aGlzLnJvb3Q/bnVsbDp0aGlzLnJvb3QuT2EoMCxuYyhiKSxiKX07ay5zPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gbnVsbD09Yj90aGlzLlU/dGhpcy5kYTpjOm51bGw9PXRoaXMucm9vdD9jOnRoaXMucm9vdC5PYSgwLG5jKGIpLGIsYyl9O2suTD1mdW5jdGlvbigpe2lmKHRoaXMudSlyZXR1cm4gdGhpcy5jb3VudDt0aHJvdyBFcnJvcihcImNvdW50IGFmdGVyIHBlcnNpc3RlbnQhXCIpO307XG5mdW5jdGlvbiB1ZyhhLGIpe2lmKGEudSl7aWYoYj9iLmomMjA0OHx8Yi5qY3x8KGIuaj8wOncoZmIsYikpOncoZmIsYikpcmV0dXJuIHRnKGEsWWYuYj9ZZi5iKGIpOllmLmNhbGwobnVsbCxiKSxaZi5iP1pmLmIoYik6WmYuY2FsbChudWxsLGIpKTtmb3IodmFyIGM9RChiKSxkPWE7Oyl7dmFyIGU9RyhjKTtpZih0KGUpKXZhciBmPWUsYz1LKGMpLGQ9dGcoZCxmdW5jdGlvbigpe3ZhciBhPWY7cmV0dXJuIFlmLmI/WWYuYihhKTpZZi5jYWxsKG51bGwsYSl9KCksZnVuY3Rpb24oKXt2YXIgYT1mO3JldHVybiBaZi5iP1pmLmIoYSk6WmYuY2FsbChudWxsLGEpfSgpKTtlbHNlIHJldHVybiBkfX1lbHNlIHRocm93IEVycm9yKFwiY29uaiEgYWZ0ZXIgcGVyc2lzdGVudFwiKTt9XG5mdW5jdGlvbiB0ZyhhLGIsYyl7aWYoYS51KXtpZihudWxsPT1iKWEuZGEhPT1jJiYoYS5kYT1jKSxhLlV8fChhLmNvdW50Kz0xLGEuVT0hMCk7ZWxzZXt2YXIgZD1uZXcgJGY7Yj0obnVsbD09YS5yb290P2lnOmEucm9vdCkubGEoYS51LDAsbmMoYiksYixjLGQpO2IhPT1hLnJvb3QmJihhLnJvb3Q9Yik7ZC5vJiYoYS5jb3VudCs9MSl9cmV0dXJuIGF9dGhyb3cgRXJyb3IoXCJhc3NvYyEgYWZ0ZXIgcGVyc2lzdGVudCFcIik7fWZ1bmN0aW9uIHZnKGEsYixjKXtmb3IodmFyIGQ9Yjs7KWlmKG51bGwhPWEpYj1jP2EubGVmdDphLnJpZ2h0LGQ9TmMuYShkLGEpLGE9YjtlbHNlIHJldHVybiBkfWZ1bmN0aW9uIHdnKGEsYixjLGQsZSl7dGhpcy5rPWE7dGhpcy5zdGFjaz1iO3RoaXMucGI9Yzt0aGlzLmc9ZDt0aGlzLnA9ZTt0aGlzLnE9MDt0aGlzLmo9MzIzNzQ4NjJ9az13Zy5wcm90b3R5cGU7ay50b1N0cmluZz1mdW5jdGlvbigpe3JldHVybiBlYyh0aGlzKX07ay5IPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMua307XG5rLkw9ZnVuY3Rpb24oKXtyZXR1cm4gMD50aGlzLmc/UShLKHRoaXMpKSsxOnRoaXMuZ307ay5CPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5wO3JldHVybiBudWxsIT1hP2E6dGhpcy5wPWE9d2ModGhpcyl9O2suQT1mdW5jdGlvbihhLGIpe3JldHVybiBJYyh0aGlzLGIpfTtrLko9ZnVuY3Rpb24oKXtyZXR1cm4gTyhKLHRoaXMuayl9O2suUj1mdW5jdGlvbihhLGIpe3JldHVybiBQLmEoYix0aGlzKX07ay5PPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gUC5jKGIsYyx0aGlzKX07ay5OPWZ1bmN0aW9uKCl7cmV0dXJuIFdjKHRoaXMuc3RhY2spfTtrLlM9ZnVuY3Rpb24oKXt2YXIgYT1HKHRoaXMuc3RhY2spLGE9dmcodGhpcy5wYj9hLnJpZ2h0OmEubGVmdCxLKHRoaXMuc3RhY2spLHRoaXMucGIpO3JldHVybiBudWxsIT1hP25ldyB3ZyhudWxsLGEsdGhpcy5wYix0aGlzLmctMSxudWxsKTpKfTtrLkQ9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpc307XG5rLkY9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IHdnKGIsdGhpcy5zdGFjayx0aGlzLnBiLHRoaXMuZyx0aGlzLnApfTtrLkc9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gTShiLHRoaXMpfTt3Zy5wcm90b3R5cGVbRWFdPWZ1bmN0aW9uKCl7cmV0dXJuIHVjKHRoaXMpfTtmdW5jdGlvbiB4ZyhhLGIsYyl7cmV0dXJuIG5ldyB3ZyhudWxsLHZnKGEsbnVsbCxiKSxiLGMsbnVsbCl9XG5mdW5jdGlvbiB5ZyhhLGIsYyxkKXtyZXR1cm4gYyBpbnN0YW5jZW9mIFg/Yy5sZWZ0IGluc3RhbmNlb2YgWD9uZXcgWChjLmtleSxjLm8sYy5sZWZ0LnVhKCksbmV3IFooYSxiLGMucmlnaHQsZCxudWxsKSxudWxsKTpjLnJpZ2h0IGluc3RhbmNlb2YgWD9uZXcgWChjLnJpZ2h0LmtleSxjLnJpZ2h0Lm8sbmV3IFooYy5rZXksYy5vLGMubGVmdCxjLnJpZ2h0LmxlZnQsbnVsbCksbmV3IFooYSxiLGMucmlnaHQucmlnaHQsZCxudWxsKSxudWxsKTpuZXcgWihhLGIsYyxkLG51bGwpOm5ldyBaKGEsYixjLGQsbnVsbCl9XG5mdW5jdGlvbiB6ZyhhLGIsYyxkKXtyZXR1cm4gZCBpbnN0YW5jZW9mIFg/ZC5yaWdodCBpbnN0YW5jZW9mIFg/bmV3IFgoZC5rZXksZC5vLG5ldyBaKGEsYixjLGQubGVmdCxudWxsKSxkLnJpZ2h0LnVhKCksbnVsbCk6ZC5sZWZ0IGluc3RhbmNlb2YgWD9uZXcgWChkLmxlZnQua2V5LGQubGVmdC5vLG5ldyBaKGEsYixjLGQubGVmdC5sZWZ0LG51bGwpLG5ldyBaKGQua2V5LGQubyxkLmxlZnQucmlnaHQsZC5yaWdodCxudWxsKSxudWxsKTpuZXcgWihhLGIsYyxkLG51bGwpOm5ldyBaKGEsYixjLGQsbnVsbCl9XG5mdW5jdGlvbiBBZyhhLGIsYyxkKXtpZihjIGluc3RhbmNlb2YgWClyZXR1cm4gbmV3IFgoYSxiLGMudWEoKSxkLG51bGwpO2lmKGQgaW5zdGFuY2VvZiBaKXJldHVybiB6ZyhhLGIsYyxkLm9iKCkpO2lmKGQgaW5zdGFuY2VvZiBYJiZkLmxlZnQgaW5zdGFuY2VvZiBaKXJldHVybiBuZXcgWChkLmxlZnQua2V5LGQubGVmdC5vLG5ldyBaKGEsYixjLGQubGVmdC5sZWZ0LG51bGwpLHpnKGQua2V5LGQubyxkLmxlZnQucmlnaHQsZC5yaWdodC5vYigpKSxudWxsKTt0aHJvdyBFcnJvcihcInJlZC1ibGFjayB0cmVlIGludmFyaWFudCB2aW9sYXRpb25cIik7fVxudmFyIENnPWZ1bmN0aW9uIEJnKGIsYyxkKXtkPW51bGwhPWIubGVmdD9CZyhiLmxlZnQsYyxkKTpkO2lmKEFjKGQpKXJldHVybiBMLmI/TC5iKGQpOkwuY2FsbChudWxsLGQpO3ZhciBlPWIua2V5LGY9Yi5vO2Q9Yy5jP2MuYyhkLGUsZik6Yy5jYWxsKG51bGwsZCxlLGYpO2lmKEFjKGQpKXJldHVybiBMLmI/TC5iKGQpOkwuY2FsbChudWxsLGQpO2I9bnVsbCE9Yi5yaWdodD9CZyhiLnJpZ2h0LGMsZCk6ZDtyZXR1cm4gQWMoYik/TC5iP0wuYihiKTpMLmNhbGwobnVsbCxiKTpifTtmdW5jdGlvbiBaKGEsYixjLGQsZSl7dGhpcy5rZXk9YTt0aGlzLm89Yjt0aGlzLmxlZnQ9Yzt0aGlzLnJpZ2h0PWQ7dGhpcy5wPWU7dGhpcy5xPTA7dGhpcy5qPTMyNDAyMjA3fWs9Wi5wcm90b3R5cGU7ay5NYj1mdW5jdGlvbihhKXtyZXR1cm4gYS5PYih0aGlzKX07ay5vYj1mdW5jdGlvbigpe3JldHVybiBuZXcgWCh0aGlzLmtleSx0aGlzLm8sdGhpcy5sZWZ0LHRoaXMucmlnaHQsbnVsbCl9O1xuay51YT1mdW5jdGlvbigpe3JldHVybiB0aGlzfTtrLkxiPWZ1bmN0aW9uKGEpe3JldHVybiBhLk5iKHRoaXMpfTtrLnJlcGxhY2U9ZnVuY3Rpb24oYSxiLGMsZCl7cmV0dXJuIG5ldyBaKGEsYixjLGQsbnVsbCl9O2suTmI9ZnVuY3Rpb24oYSl7cmV0dXJuIG5ldyBaKGEua2V5LGEubyx0aGlzLGEucmlnaHQsbnVsbCl9O2suT2I9ZnVuY3Rpb24oYSl7cmV0dXJuIG5ldyBaKGEua2V5LGEubyxhLmxlZnQsdGhpcyxudWxsKX07ay5YYT1mdW5jdGlvbihhLGIpe3JldHVybiBDZyh0aGlzLGEsYil9O2sudD1mdW5jdGlvbihhLGIpe3JldHVybiBDLmModGhpcyxiLG51bGwpfTtrLnM9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBDLmModGhpcyxiLGMpfTtrLlE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gMD09PWI/dGhpcy5rZXk6MT09PWI/dGhpcy5vOm51bGx9O2suJD1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIDA9PT1iP3RoaXMua2V5OjE9PT1iP3RoaXMubzpjfTtcbmsuVWE9ZnVuY3Rpb24oYSxiLGMpe3JldHVybihuZXcgVyhudWxsLDIsNSx1ZixbdGhpcy5rZXksdGhpcy5vXSxudWxsKSkuVWEobnVsbCxiLGMpfTtrLkg9ZnVuY3Rpb24oKXtyZXR1cm4gbnVsbH07ay5MPWZ1bmN0aW9uKCl7cmV0dXJuIDJ9O2suaGI9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5rZXl9O2suaWI9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5vfTtrLkxhPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMub307ay5NYT1mdW5jdGlvbigpe3JldHVybiBuZXcgVyhudWxsLDEsNSx1ZixbdGhpcy5rZXldLG51bGwpfTtrLkI9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLnA7cmV0dXJuIG51bGwhPWE/YTp0aGlzLnA9YT13Yyh0aGlzKX07ay5BPWZ1bmN0aW9uKGEsYil7cmV0dXJuIEljKHRoaXMsYil9O2suSj1mdW5jdGlvbigpe3JldHVybiBNY307ay5SPWZ1bmN0aW9uKGEsYil7cmV0dXJuIENjLmEodGhpcyxiKX07ay5PPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gQ2MuYyh0aGlzLGIsYyl9O1xuay5LYT1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIFJjLmMobmV3IFcobnVsbCwyLDUsdWYsW3RoaXMua2V5LHRoaXMub10sbnVsbCksYixjKX07ay5EPWZ1bmN0aW9uKCl7cmV0dXJuIFJhKFJhKEosdGhpcy5vKSx0aGlzLmtleSl9O2suRj1mdW5jdGlvbihhLGIpe3JldHVybiBPKG5ldyBXKG51bGwsMiw1LHVmLFt0aGlzLmtleSx0aGlzLm9dLG51bGwpLGIpfTtrLkc9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IFcobnVsbCwzLDUsdWYsW3RoaXMua2V5LHRoaXMubyxiXSxudWxsKX07XG5rLmNhbGw9ZnVuY3Rpb24oKXt2YXIgYT1udWxsLGE9ZnVuY3Rpb24oYSxjLGQpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIHRoaXMudChudWxsLGMpO2Nhc2UgMzpyZXR1cm4gdGhpcy5zKG51bGwsYyxkKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307YS5hPWZ1bmN0aW9uKGEsYyl7cmV0dXJuIHRoaXMudChudWxsLGMpfTthLmM9ZnVuY3Rpb24oYSxjLGQpe3JldHVybiB0aGlzLnMobnVsbCxjLGQpfTtyZXR1cm4gYX0oKTtrLmFwcGx5PWZ1bmN0aW9uKGEsYil7cmV0dXJuIHRoaXMuY2FsbC5hcHBseSh0aGlzLFt0aGlzXS5jb25jYXQoRmEoYikpKX07ay5iPWZ1bmN0aW9uKGEpe3JldHVybiB0aGlzLnQobnVsbCxhKX07ay5hPWZ1bmN0aW9uKGEsYil7cmV0dXJuIHRoaXMucyhudWxsLGEsYil9O1oucHJvdG90eXBlW0VhXT1mdW5jdGlvbigpe3JldHVybiB1Yyh0aGlzKX07XG5mdW5jdGlvbiBYKGEsYixjLGQsZSl7dGhpcy5rZXk9YTt0aGlzLm89Yjt0aGlzLmxlZnQ9Yzt0aGlzLnJpZ2h0PWQ7dGhpcy5wPWU7dGhpcy5xPTA7dGhpcy5qPTMyNDAyMjA3fWs9WC5wcm90b3R5cGU7ay5NYj1mdW5jdGlvbihhKXtyZXR1cm4gbmV3IFgodGhpcy5rZXksdGhpcy5vLHRoaXMubGVmdCxhLG51bGwpfTtrLm9iPWZ1bmN0aW9uKCl7dGhyb3cgRXJyb3IoXCJyZWQtYmxhY2sgdHJlZSBpbnZhcmlhbnQgdmlvbGF0aW9uXCIpO307ay51YT1mdW5jdGlvbigpe3JldHVybiBuZXcgWih0aGlzLmtleSx0aGlzLm8sdGhpcy5sZWZ0LHRoaXMucmlnaHQsbnVsbCl9O2suTGI9ZnVuY3Rpb24oYSl7cmV0dXJuIG5ldyBYKHRoaXMua2V5LHRoaXMubyxhLHRoaXMucmlnaHQsbnVsbCl9O2sucmVwbGFjZT1mdW5jdGlvbihhLGIsYyxkKXtyZXR1cm4gbmV3IFgoYSxiLGMsZCxudWxsKX07XG5rLk5iPWZ1bmN0aW9uKGEpe3JldHVybiB0aGlzLmxlZnQgaW5zdGFuY2VvZiBYP25ldyBYKHRoaXMua2V5LHRoaXMubyx0aGlzLmxlZnQudWEoKSxuZXcgWihhLmtleSxhLm8sdGhpcy5yaWdodCxhLnJpZ2h0LG51bGwpLG51bGwpOnRoaXMucmlnaHQgaW5zdGFuY2VvZiBYP25ldyBYKHRoaXMucmlnaHQua2V5LHRoaXMucmlnaHQubyxuZXcgWih0aGlzLmtleSx0aGlzLm8sdGhpcy5sZWZ0LHRoaXMucmlnaHQubGVmdCxudWxsKSxuZXcgWihhLmtleSxhLm8sdGhpcy5yaWdodC5yaWdodCxhLnJpZ2h0LG51bGwpLG51bGwpOm5ldyBaKGEua2V5LGEubyx0aGlzLGEucmlnaHQsbnVsbCl9O1xuay5PYj1mdW5jdGlvbihhKXtyZXR1cm4gdGhpcy5yaWdodCBpbnN0YW5jZW9mIFg/bmV3IFgodGhpcy5rZXksdGhpcy5vLG5ldyBaKGEua2V5LGEubyxhLmxlZnQsdGhpcy5sZWZ0LG51bGwpLHRoaXMucmlnaHQudWEoKSxudWxsKTp0aGlzLmxlZnQgaW5zdGFuY2VvZiBYP25ldyBYKHRoaXMubGVmdC5rZXksdGhpcy5sZWZ0Lm8sbmV3IFooYS5rZXksYS5vLGEubGVmdCx0aGlzLmxlZnQubGVmdCxudWxsKSxuZXcgWih0aGlzLmtleSx0aGlzLm8sdGhpcy5sZWZ0LnJpZ2h0LHRoaXMucmlnaHQsbnVsbCksbnVsbCk6bmV3IFooYS5rZXksYS5vLGEubGVmdCx0aGlzLG51bGwpfTtrLlhhPWZ1bmN0aW9uKGEsYil7cmV0dXJuIENnKHRoaXMsYSxiKX07ay50PWZ1bmN0aW9uKGEsYil7cmV0dXJuIEMuYyh0aGlzLGIsbnVsbCl9O2sucz1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIEMuYyh0aGlzLGIsYyl9O1xuay5RPWZ1bmN0aW9uKGEsYil7cmV0dXJuIDA9PT1iP3RoaXMua2V5OjE9PT1iP3RoaXMubzpudWxsfTtrLiQ9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiAwPT09Yj90aGlzLmtleToxPT09Yj90aGlzLm86Y307ay5VYT1mdW5jdGlvbihhLGIsYyl7cmV0dXJuKG5ldyBXKG51bGwsMiw1LHVmLFt0aGlzLmtleSx0aGlzLm9dLG51bGwpKS5VYShudWxsLGIsYyl9O2suSD1mdW5jdGlvbigpe3JldHVybiBudWxsfTtrLkw9ZnVuY3Rpb24oKXtyZXR1cm4gMn07ay5oYj1mdW5jdGlvbigpe3JldHVybiB0aGlzLmtleX07ay5pYj1mdW5jdGlvbigpe3JldHVybiB0aGlzLm99O2suTGE9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5vfTtrLk1hPWZ1bmN0aW9uKCl7cmV0dXJuIG5ldyBXKG51bGwsMSw1LHVmLFt0aGlzLmtleV0sbnVsbCl9O2suQj1mdW5jdGlvbigpe3ZhciBhPXRoaXMucDtyZXR1cm4gbnVsbCE9YT9hOnRoaXMucD1hPXdjKHRoaXMpfTtcbmsuQT1mdW5jdGlvbihhLGIpe3JldHVybiBJYyh0aGlzLGIpfTtrLko9ZnVuY3Rpb24oKXtyZXR1cm4gTWN9O2suUj1mdW5jdGlvbihhLGIpe3JldHVybiBDYy5hKHRoaXMsYil9O2suTz1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIENjLmModGhpcyxiLGMpfTtrLkthPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gUmMuYyhuZXcgVyhudWxsLDIsNSx1ZixbdGhpcy5rZXksdGhpcy5vXSxudWxsKSxiLGMpfTtrLkQ9ZnVuY3Rpb24oKXtyZXR1cm4gUmEoUmEoSix0aGlzLm8pLHRoaXMua2V5KX07ay5GPWZ1bmN0aW9uKGEsYil7cmV0dXJuIE8obmV3IFcobnVsbCwyLDUsdWYsW3RoaXMua2V5LHRoaXMub10sbnVsbCksYil9O2suRz1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgVyhudWxsLDMsNSx1ZixbdGhpcy5rZXksdGhpcy5vLGJdLG51bGwpfTtcbmsuY2FsbD1mdW5jdGlvbigpe3ZhciBhPW51bGwsYT1mdW5jdGlvbihhLGMsZCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gdGhpcy50KG51bGwsYyk7Y2FzZSAzOnJldHVybiB0aGlzLnMobnVsbCxjLGQpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTthLmE9ZnVuY3Rpb24oYSxjKXtyZXR1cm4gdGhpcy50KG51bGwsYyl9O2EuYz1mdW5jdGlvbihhLGMsZCl7cmV0dXJuIHRoaXMucyhudWxsLGMsZCl9O3JldHVybiBhfSgpO2suYXBwbHk9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gdGhpcy5jYWxsLmFwcGx5KHRoaXMsW3RoaXNdLmNvbmNhdChGYShiKSkpfTtrLmI9ZnVuY3Rpb24oYSl7cmV0dXJuIHRoaXMudChudWxsLGEpfTtrLmE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gdGhpcy5zKG51bGwsYSxiKX07WC5wcm90b3R5cGVbRWFdPWZ1bmN0aW9uKCl7cmV0dXJuIHVjKHRoaXMpfTtcbnZhciBFZz1mdW5jdGlvbiBEZyhiLGMsZCxlLGYpe2lmKG51bGw9PWMpcmV0dXJuIG5ldyBYKGQsZSxudWxsLG51bGwsbnVsbCk7dmFyIGc7Zz1jLmtleTtnPWIuYT9iLmEoZCxnKTpiLmNhbGwobnVsbCxkLGcpO2lmKDA9PT1nKXJldHVybiBmWzBdPWMsbnVsbDtpZigwPmcpcmV0dXJuIGI9RGcoYixjLmxlZnQsZCxlLGYpLG51bGwhPWI/Yy5MYihiKTpudWxsO2I9RGcoYixjLnJpZ2h0LGQsZSxmKTtyZXR1cm4gbnVsbCE9Yj9jLk1iKGIpOm51bGx9LEdnPWZ1bmN0aW9uIEZnKGIsYyl7aWYobnVsbD09YilyZXR1cm4gYztpZihudWxsPT1jKXJldHVybiBiO2lmKGIgaW5zdGFuY2VvZiBYKXtpZihjIGluc3RhbmNlb2YgWCl7dmFyIGQ9RmcoYi5yaWdodCxjLmxlZnQpO3JldHVybiBkIGluc3RhbmNlb2YgWD9uZXcgWChkLmtleSxkLm8sbmV3IFgoYi5rZXksYi5vLGIubGVmdCxkLmxlZnQsbnVsbCksbmV3IFgoYy5rZXksYy5vLGQucmlnaHQsYy5yaWdodCxudWxsKSxudWxsKTpuZXcgWChiLmtleSxcbmIubyxiLmxlZnQsbmV3IFgoYy5rZXksYy5vLGQsYy5yaWdodCxudWxsKSxudWxsKX1yZXR1cm4gbmV3IFgoYi5rZXksYi5vLGIubGVmdCxGZyhiLnJpZ2h0LGMpLG51bGwpfWlmKGMgaW5zdGFuY2VvZiBYKXJldHVybiBuZXcgWChjLmtleSxjLm8sRmcoYixjLmxlZnQpLGMucmlnaHQsbnVsbCk7ZD1GZyhiLnJpZ2h0LGMubGVmdCk7cmV0dXJuIGQgaW5zdGFuY2VvZiBYP25ldyBYKGQua2V5LGQubyxuZXcgWihiLmtleSxiLm8sYi5sZWZ0LGQubGVmdCxudWxsKSxuZXcgWihjLmtleSxjLm8sZC5yaWdodCxjLnJpZ2h0LG51bGwpLG51bGwpOkFnKGIua2V5LGIubyxiLmxlZnQsbmV3IFooYy5rZXksYy5vLGQsYy5yaWdodCxudWxsKSl9LElnPWZ1bmN0aW9uIEhnKGIsYyxkLGUpe2lmKG51bGwhPWMpe3ZhciBmO2Y9Yy5rZXk7Zj1iLmE/Yi5hKGQsZik6Yi5jYWxsKG51bGwsZCxmKTtpZigwPT09ZilyZXR1cm4gZVswXT1jLEdnKGMubGVmdCxjLnJpZ2h0KTtpZigwPmYpcmV0dXJuIGI9SGcoYixcbmMubGVmdCxkLGUpLG51bGwhPWJ8fG51bGwhPWVbMF0/Yy5sZWZ0IGluc3RhbmNlb2YgWj9BZyhjLmtleSxjLm8sYixjLnJpZ2h0KTpuZXcgWChjLmtleSxjLm8sYixjLnJpZ2h0LG51bGwpOm51bGw7Yj1IZyhiLGMucmlnaHQsZCxlKTtpZihudWxsIT1ifHxudWxsIT1lWzBdKWlmKGMucmlnaHQgaW5zdGFuY2VvZiBaKWlmKGU9Yy5rZXksZD1jLm8sYz1jLmxlZnQsYiBpbnN0YW5jZW9mIFgpYz1uZXcgWChlLGQsYyxiLnVhKCksbnVsbCk7ZWxzZSBpZihjIGluc3RhbmNlb2YgWiljPXlnKGUsZCxjLm9iKCksYik7ZWxzZSBpZihjIGluc3RhbmNlb2YgWCYmYy5yaWdodCBpbnN0YW5jZW9mIFopYz1uZXcgWChjLnJpZ2h0LmtleSxjLnJpZ2h0Lm8seWcoYy5rZXksYy5vLGMubGVmdC5vYigpLGMucmlnaHQubGVmdCksbmV3IFooZSxkLGMucmlnaHQucmlnaHQsYixudWxsKSxudWxsKTtlbHNlIHRocm93IEVycm9yKFwicmVkLWJsYWNrIHRyZWUgaW52YXJpYW50IHZpb2xhdGlvblwiKTtlbHNlIGM9XG5uZXcgWChjLmtleSxjLm8sYy5sZWZ0LGIsbnVsbCk7ZWxzZSBjPW51bGw7cmV0dXJuIGN9cmV0dXJuIG51bGx9LEtnPWZ1bmN0aW9uIEpnKGIsYyxkLGUpe3ZhciBmPWMua2V5LGc9Yi5hP2IuYShkLGYpOmIuY2FsbChudWxsLGQsZik7cmV0dXJuIDA9PT1nP2MucmVwbGFjZShmLGUsYy5sZWZ0LGMucmlnaHQpOjA+Zz9jLnJlcGxhY2UoZixjLm8sSmcoYixjLmxlZnQsZCxlKSxjLnJpZ2h0KTpjLnJlcGxhY2UoZixjLm8sYy5sZWZ0LEpnKGIsYy5yaWdodCxkLGUpKX07ZnVuY3Rpb24gTGcoYSxiLGMsZCxlKXt0aGlzLmFhPWE7dGhpcy5uYT1iO3RoaXMuZz1jO3RoaXMuaz1kO3RoaXMucD1lO3RoaXMuaj00MTg3NzY4NDc7dGhpcy5xPTgxOTJ9az1MZy5wcm90b3R5cGU7ay50b1N0cmluZz1mdW5jdGlvbigpe3JldHVybiBlYyh0aGlzKX07XG5mdW5jdGlvbiBNZyhhLGIpe2Zvcih2YXIgYz1hLm5hOzspaWYobnVsbCE9Yyl7dmFyIGQ7ZD1jLmtleTtkPWEuYWEuYT9hLmFhLmEoYixkKTphLmFhLmNhbGwobnVsbCxiLGQpO2lmKDA9PT1kKXJldHVybiBjO2M9MD5kP2MubGVmdDpjLnJpZ2h0fWVsc2UgcmV0dXJuIG51bGx9ay50PWZ1bmN0aW9uKGEsYil7cmV0dXJuICRhLmModGhpcyxiLG51bGwpfTtrLnM9ZnVuY3Rpb24oYSxiLGMpe2E9TWcodGhpcyxiKTtyZXR1cm4gbnVsbCE9YT9hLm86Y307ay5nYj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIG51bGwhPXRoaXMubmE/Q2codGhpcy5uYSxiLGMpOmN9O2suSD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmt9O2suTD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmd9O2suYWI9ZnVuY3Rpb24oKXtyZXR1cm4gMDx0aGlzLmc/eGcodGhpcy5uYSwhMSx0aGlzLmcpOm51bGx9O2suQj1mdW5jdGlvbigpe3ZhciBhPXRoaXMucDtyZXR1cm4gbnVsbCE9YT9hOnRoaXMucD1hPXhjKHRoaXMpfTtcbmsuQT1mdW5jdGlvbihhLGIpe3JldHVybiBQZih0aGlzLGIpfTtrLko9ZnVuY3Rpb24oKXtyZXR1cm4gbmV3IExnKHRoaXMuYWEsbnVsbCwwLHRoaXMuaywwKX07ay53Yj1mdW5jdGlvbihhLGIpe3ZhciBjPVtudWxsXSxkPUlnKHRoaXMuYWEsdGhpcy5uYSxiLGMpO3JldHVybiBudWxsPT1kP251bGw9PVIuYShjLDApP3RoaXM6bmV3IExnKHRoaXMuYWEsbnVsbCwwLHRoaXMuayxudWxsKTpuZXcgTGcodGhpcy5hYSxkLnVhKCksdGhpcy5nLTEsdGhpcy5rLG51bGwpfTtrLkthPWZ1bmN0aW9uKGEsYixjKXthPVtudWxsXTt2YXIgZD1FZyh0aGlzLmFhLHRoaXMubmEsYixjLGEpO3JldHVybiBudWxsPT1kPyhhPVIuYShhLDApLHNjLmEoYyxhLm8pP3RoaXM6bmV3IExnKHRoaXMuYWEsS2codGhpcy5hYSx0aGlzLm5hLGIsYyksdGhpcy5nLHRoaXMuayxudWxsKSk6bmV3IExnKHRoaXMuYWEsZC51YSgpLHRoaXMuZysxLHRoaXMuayxudWxsKX07XG5rLnJiPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG51bGwhPU1nKHRoaXMsYil9O2suRD1mdW5jdGlvbigpe3JldHVybiAwPHRoaXMuZz94Zyh0aGlzLm5hLCEwLHRoaXMuZyk6bnVsbH07ay5GPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyBMZyh0aGlzLmFhLHRoaXMubmEsdGhpcy5nLGIsdGhpcy5wKX07ay5HPWZ1bmN0aW9uKGEsYil7aWYoZWQoYikpcmV0dXJuIGNiKHRoaXMsQy5hKGIsMCksQy5hKGIsMSkpO2Zvcih2YXIgYz10aGlzLGQ9RChiKTs7KXtpZihudWxsPT1kKXJldHVybiBjO3ZhciBlPUcoZCk7aWYoZWQoZSkpYz1jYihjLEMuYShlLDApLEMuYShlLDEpKSxkPUsoZCk7ZWxzZSB0aHJvdyBFcnJvcihcImNvbmogb24gYSBtYXAgdGFrZXMgbWFwIGVudHJpZXMgb3Igc2VxYWJsZXMgb2YgbWFwIGVudHJpZXNcIik7fX07XG5rLmNhbGw9ZnVuY3Rpb24oKXt2YXIgYT1udWxsLGE9ZnVuY3Rpb24oYSxjLGQpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIHRoaXMudChudWxsLGMpO2Nhc2UgMzpyZXR1cm4gdGhpcy5zKG51bGwsYyxkKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307YS5hPWZ1bmN0aW9uKGEsYyl7cmV0dXJuIHRoaXMudChudWxsLGMpfTthLmM9ZnVuY3Rpb24oYSxjLGQpe3JldHVybiB0aGlzLnMobnVsbCxjLGQpfTtyZXR1cm4gYX0oKTtrLmFwcGx5PWZ1bmN0aW9uKGEsYil7cmV0dXJuIHRoaXMuY2FsbC5hcHBseSh0aGlzLFt0aGlzXS5jb25jYXQoRmEoYikpKX07ay5iPWZ1bmN0aW9uKGEpe3JldHVybiB0aGlzLnQobnVsbCxhKX07ay5hPWZ1bmN0aW9uKGEsYil7cmV0dXJuIHRoaXMucyhudWxsLGEsYil9O2suSGI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gMDx0aGlzLmc/eGcodGhpcy5uYSxiLHRoaXMuZyk6bnVsbH07XG5rLkliPWZ1bmN0aW9uKGEsYixjKXtpZigwPHRoaXMuZyl7YT1udWxsO2Zvcih2YXIgZD10aGlzLm5hOzspaWYobnVsbCE9ZCl7dmFyIGU7ZT1kLmtleTtlPXRoaXMuYWEuYT90aGlzLmFhLmEoYixlKTp0aGlzLmFhLmNhbGwobnVsbCxiLGUpO2lmKDA9PT1lKXJldHVybiBuZXcgd2cobnVsbCxOYy5hKGEsZCksYywtMSxudWxsKTt0KGMpPzA+ZT8oYT1OYy5hKGEsZCksZD1kLmxlZnQpOmQ9ZC5yaWdodDowPGU/KGE9TmMuYShhLGQpLGQ9ZC5yaWdodCk6ZD1kLmxlZnR9ZWxzZSByZXR1cm4gbnVsbD09YT9udWxsOm5ldyB3ZyhudWxsLGEsYywtMSxudWxsKX1lbHNlIHJldHVybiBudWxsfTtrLkdiPWZ1bmN0aW9uKGEsYil7cmV0dXJuIFlmLmI/WWYuYihiKTpZZi5jYWxsKG51bGwsYil9O2suRmI9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5hYX07dmFyIE5nPW5ldyBMZyhvZCxudWxsLDAsbnVsbCwwKTtMZy5wcm90b3R5cGVbRWFdPWZ1bmN0aW9uKCl7cmV0dXJuIHVjKHRoaXMpfTtcbnZhciBPZz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSl7dmFyIGQ9bnVsbDtpZigwPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZD0wLGU9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0wKTtkPGUubGVuZ3RoOyllW2RdPWFyZ3VtZW50c1tkKzBdLCsrZDtkPW5ldyBGKGUsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGQpfWZ1bmN0aW9uIGIoYSl7YT1EKGEpO2Zvcih2YXIgYj1PYihRYyk7OylpZihhKXt2YXIgZT1LKEsoYSkpLGI9ZWUuYyhiLEcoYSksTGMoYSkpO2E9ZX1lbHNlIHJldHVybiBRYihiKX1hLmk9MDthLmY9ZnVuY3Rpb24oYSl7YT1EKGEpO3JldHVybiBiKGEpfTthLmQ9YjtyZXR1cm4gYX0oKSxQZz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSl7dmFyIGQ9bnVsbDtpZigwPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZD0wLGU9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0wKTtkPGUubGVuZ3RoOyllW2RdPWFyZ3VtZW50c1tkKzBdLCsrZDtkPW5ldyBGKGUsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLFxuZCl9ZnVuY3Rpb24gYihhKXthOnthPVQuYShIYSxhKTtmb3IodmFyIGI9YS5sZW5ndGgsZT0wLGY9T2IoVWYpOzspaWYoZTxiKXZhciBnPWUrMixmPVJiKGYsYVtlXSxhW2UrMV0pLGU9ZztlbHNle2E9UWIoZik7YnJlYWsgYX1hPXZvaWQgMH1yZXR1cm4gYX1hLmk9MDthLmY9ZnVuY3Rpb24oYSl7YT1EKGEpO3JldHVybiBiKGEpfTthLmQ9YjtyZXR1cm4gYX0oKSxRZz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSl7dmFyIGQ9bnVsbDtpZigwPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZD0wLGU9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0wKTtkPGUubGVuZ3RoOyllW2RdPWFyZ3VtZW50c1tkKzBdLCsrZDtkPW5ldyBGKGUsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGQpfWZ1bmN0aW9uIGIoYSl7YT1EKGEpO2Zvcih2YXIgYj1OZzs7KWlmKGEpe3ZhciBlPUsoSyhhKSksYj1SYy5jKGIsRyhhKSxMYyhhKSk7YT1lfWVsc2UgcmV0dXJuIGJ9YS5pPTA7YS5mPWZ1bmN0aW9uKGEpe2E9RChhKTtcbnJldHVybiBiKGEpfTthLmQ9YjtyZXR1cm4gYX0oKSxSZz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxkKXt2YXIgZT1udWxsO2lmKDE8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBlPTAsZj1BcnJheShhcmd1bWVudHMubGVuZ3RoLTEpO2U8Zi5sZW5ndGg7KWZbZV09YXJndW1lbnRzW2UrMV0sKytlO2U9bmV3IEYoZiwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsYSxlKX1mdW5jdGlvbiBiKGEsYil7Zm9yKHZhciBlPUQoYiksZj1uZXcgTGcocWQoYSksbnVsbCwwLG51bGwsMCk7OylpZihlKXZhciBnPUsoSyhlKSksZj1SYy5jKGYsRyhlKSxMYyhlKSksZT1nO2Vsc2UgcmV0dXJuIGZ9YS5pPTE7YS5mPWZ1bmN0aW9uKGEpe3ZhciBkPUcoYSk7YT1IKGEpO3JldHVybiBiKGQsYSl9O2EuZD1iO3JldHVybiBhfSgpO2Z1bmN0aW9uIFNnKGEsYil7dGhpcy5ZPWE7dGhpcy5aPWI7dGhpcy5xPTA7dGhpcy5qPTMyMzc0OTg4fWs9U2cucHJvdG90eXBlO2sudG9TdHJpbmc9ZnVuY3Rpb24oKXtyZXR1cm4gZWModGhpcyl9O1xuay5IPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuWn07ay5UPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5ZLGE9KGE/YS5qJjEyOHx8YS54Ynx8KGEuaj8wOncoWGEsYSkpOncoWGEsYSkpP3RoaXMuWS5UKG51bGwpOksodGhpcy5ZKTtyZXR1cm4gbnVsbD09YT9udWxsOm5ldyBTZyhhLHRoaXMuWil9O2suQj1mdW5jdGlvbigpe3JldHVybiB3Yyh0aGlzKX07ay5BPWZ1bmN0aW9uKGEsYil7cmV0dXJuIEljKHRoaXMsYil9O2suSj1mdW5jdGlvbigpe3JldHVybiBPKEosdGhpcy5aKX07ay5SPWZ1bmN0aW9uKGEsYil7cmV0dXJuIFAuYShiLHRoaXMpfTtrLk89ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBQLmMoYixjLHRoaXMpfTtrLk49ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5ZLk4obnVsbCkuaGIobnVsbCl9O1xuay5TPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5ZLGE9KGE/YS5qJjEyOHx8YS54Ynx8KGEuaj8wOncoWGEsYSkpOncoWGEsYSkpP3RoaXMuWS5UKG51bGwpOksodGhpcy5ZKTtyZXR1cm4gbnVsbCE9YT9uZXcgU2coYSx0aGlzLlopOkp9O2suRD1mdW5jdGlvbigpe3JldHVybiB0aGlzfTtrLkY9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IFNnKHRoaXMuWSxiKX07ay5HPWZ1bmN0aW9uKGEsYil7cmV0dXJuIE0oYix0aGlzKX07U2cucHJvdG90eXBlW0VhXT1mdW5jdGlvbigpe3JldHVybiB1Yyh0aGlzKX07ZnVuY3Rpb24gVGcoYSl7cmV0dXJuKGE9RChhKSk/bmV3IFNnKGEsbnVsbCk6bnVsbH1mdW5jdGlvbiBZZihhKXtyZXR1cm4gaGIoYSl9ZnVuY3Rpb24gVWcoYSxiKXt0aGlzLlk9YTt0aGlzLlo9Yjt0aGlzLnE9MDt0aGlzLmo9MzIzNzQ5ODh9az1VZy5wcm90b3R5cGU7ay50b1N0cmluZz1mdW5jdGlvbigpe3JldHVybiBlYyh0aGlzKX07ay5IPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuWn07XG5rLlQ9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLlksYT0oYT9hLmomMTI4fHxhLnhifHwoYS5qPzA6dyhYYSxhKSk6dyhYYSxhKSk/dGhpcy5ZLlQobnVsbCk6Syh0aGlzLlkpO3JldHVybiBudWxsPT1hP251bGw6bmV3IFVnKGEsdGhpcy5aKX07ay5CPWZ1bmN0aW9uKCl7cmV0dXJuIHdjKHRoaXMpfTtrLkE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gSWModGhpcyxiKX07ay5KPWZ1bmN0aW9uKCl7cmV0dXJuIE8oSix0aGlzLlopfTtrLlI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gUC5hKGIsdGhpcyl9O2suTz1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIFAuYyhiLGMsdGhpcyl9O2suTj1mdW5jdGlvbigpe3JldHVybiB0aGlzLlkuTihudWxsKS5pYihudWxsKX07ay5TPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5ZLGE9KGE/YS5qJjEyOHx8YS54Ynx8KGEuaj8wOncoWGEsYSkpOncoWGEsYSkpP3RoaXMuWS5UKG51bGwpOksodGhpcy5ZKTtyZXR1cm4gbnVsbCE9YT9uZXcgVWcoYSx0aGlzLlopOkp9O1xuay5EPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXN9O2suRj1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgVWcodGhpcy5ZLGIpfTtrLkc9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gTShiLHRoaXMpfTtVZy5wcm90b3R5cGVbRWFdPWZ1bmN0aW9uKCl7cmV0dXJuIHVjKHRoaXMpfTtmdW5jdGlvbiBWZyhhKXtyZXR1cm4oYT1EKGEpKT9uZXcgVWcoYSxudWxsKTpudWxsfWZ1bmN0aW9uIFpmKGEpe3JldHVybiBpYihhKX1cbnZhciBXZz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSl7dmFyIGQ9bnVsbDtpZigwPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZD0wLGU9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0wKTtkPGUubGVuZ3RoOyllW2RdPWFyZ3VtZW50c1tkKzBdLCsrZDtkPW5ldyBGKGUsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGQpfWZ1bmN0aW9uIGIoYSl7cmV0dXJuIHQoRmUodWQsYSkpP0EuYShmdW5jdGlvbihhLGIpe3JldHVybiBOYy5hKHQoYSk/YTpVZixiKX0sYSk6bnVsbH1hLmk9MDthLmY9ZnVuY3Rpb24oYSl7YT1EKGEpO3JldHVybiBiKGEpfTthLmQ9YjtyZXR1cm4gYX0oKSxYZz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxkKXt2YXIgZT1udWxsO2lmKDE8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBlPTAsZj1BcnJheShhcmd1bWVudHMubGVuZ3RoLTEpO2U8Zi5sZW5ndGg7KWZbZV09YXJndW1lbnRzW2UrMV0sKytlO2U9bmV3IEYoZiwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsYSxlKX1mdW5jdGlvbiBiKGEsXG5iKXtyZXR1cm4gdChGZSh1ZCxiKSk/QS5hKGZ1bmN0aW9uKGEpe3JldHVybiBmdW5jdGlvbihiLGMpe3JldHVybiBBLmMoYSx0KGIpP2I6VWYsRChjKSl9fShmdW5jdGlvbihiLGQpe3ZhciBnPUcoZCksaD1MYyhkKTtyZXR1cm4gbmQoYixnKT9SYy5jKGIsZyxmdW5jdGlvbigpe3ZhciBkPVMuYShiLGcpO3JldHVybiBhLmE/YS5hKGQsaCk6YS5jYWxsKG51bGwsZCxoKX0oKSk6UmMuYyhiLGcsaCl9KSxiKTpudWxsfWEuaT0xO2EuZj1mdW5jdGlvbihhKXt2YXIgZD1HKGEpO2E9SChhKTtyZXR1cm4gYihkLGEpfTthLmQ9YjtyZXR1cm4gYX0oKTtmdW5jdGlvbiBZZyhhLGIpe2Zvcih2YXIgYz1VZixkPUQoYik7OylpZihkKXZhciBlPUcoZCksZj1TLmMoYSxlLFpnKSxjPWplLmEoZixaZyk/UmMuYyhjLGUsZik6YyxkPUsoZCk7ZWxzZSByZXR1cm4gTyhjLFZjKGEpKX1cbmZ1bmN0aW9uICRnKGEsYixjKXt0aGlzLms9YTt0aGlzLldhPWI7dGhpcy5wPWM7dGhpcy5qPTE1MDc3NjQ3O3RoaXMucT04MTk2fWs9JGcucHJvdG90eXBlO2sudG9TdHJpbmc9ZnVuY3Rpb24oKXtyZXR1cm4gZWModGhpcyl9O2sudD1mdW5jdGlvbihhLGIpe3JldHVybiAkYS5jKHRoaXMsYixudWxsKX07ay5zPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gYmIodGhpcy5XYSxiKT9iOmN9O2suSD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmt9O2suTD1mdW5jdGlvbigpe3JldHVybiBNYSh0aGlzLldhKX07ay5CPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5wO3JldHVybiBudWxsIT1hP2E6dGhpcy5wPWE9eGModGhpcyl9O2suQT1mdW5jdGlvbihhLGIpe3JldHVybiBhZChiKSYmUSh0aGlzKT09PVEoYikmJkVlKGZ1bmN0aW9uKGEpe3JldHVybiBmdW5jdGlvbihiKXtyZXR1cm4gbmQoYSxiKX19KHRoaXMpLGIpfTtrLiRhPWZ1bmN0aW9uKCl7cmV0dXJuIG5ldyBhaChPYih0aGlzLldhKSl9O1xuay5KPWZ1bmN0aW9uKCl7cmV0dXJuIE8oYmgsdGhpcy5rKX07ay5FYj1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgJGcodGhpcy5rLGViKHRoaXMuV2EsYiksbnVsbCl9O2suRD1mdW5jdGlvbigpe3JldHVybiBUZyh0aGlzLldhKX07ay5GPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyAkZyhiLHRoaXMuV2EsdGhpcy5wKX07ay5HPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyAkZyh0aGlzLmssUmMuYyh0aGlzLldhLGIsbnVsbCksbnVsbCl9O1xuay5jYWxsPWZ1bmN0aW9uKCl7dmFyIGE9bnVsbCxhPWZ1bmN0aW9uKGEsYyxkKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiB0aGlzLnQobnVsbCxjKTtjYXNlIDM6cmV0dXJuIHRoaXMucyhudWxsLGMsZCl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2EuYT1mdW5jdGlvbihhLGMpe3JldHVybiB0aGlzLnQobnVsbCxjKX07YS5jPWZ1bmN0aW9uKGEsYyxkKXtyZXR1cm4gdGhpcy5zKG51bGwsYyxkKX07cmV0dXJuIGF9KCk7ay5hcHBseT1mdW5jdGlvbihhLGIpe3JldHVybiB0aGlzLmNhbGwuYXBwbHkodGhpcyxbdGhpc10uY29uY2F0KEZhKGIpKSl9O2suYj1mdW5jdGlvbihhKXtyZXR1cm4gdGhpcy50KG51bGwsYSl9O2suYT1mdW5jdGlvbihhLGIpe3JldHVybiB0aGlzLnMobnVsbCxhLGIpfTt2YXIgYmg9bmV3ICRnKG51bGwsVWYsMCk7JGcucHJvdG90eXBlW0VhXT1mdW5jdGlvbigpe3JldHVybiB1Yyh0aGlzKX07XG5mdW5jdGlvbiBhaChhKXt0aGlzLm1hPWE7dGhpcy5qPTI1OTt0aGlzLnE9MTM2fWs9YWgucHJvdG90eXBlO2suY2FsbD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMpe3JldHVybiAkYS5jKHRoaXMubWEsYixqZCk9PT1qZD9jOmJ9ZnVuY3Rpb24gYihhLGIpe3JldHVybiAkYS5jKHRoaXMubWEsYixqZCk9PT1qZD9udWxsOmJ9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiBiLmNhbGwodGhpcyxjLGUpO2Nhc2UgMzpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmE9YjtjLmM9YTtyZXR1cm4gY30oKTtrLmFwcGx5PWZ1bmN0aW9uKGEsYil7cmV0dXJuIHRoaXMuY2FsbC5hcHBseSh0aGlzLFt0aGlzXS5jb25jYXQoRmEoYikpKX07XG5rLmI9ZnVuY3Rpb24oYSl7cmV0dXJuICRhLmModGhpcy5tYSxhLGpkKT09PWpkP251bGw6YX07ay5hPWZ1bmN0aW9uKGEsYil7cmV0dXJuICRhLmModGhpcy5tYSxhLGpkKT09PWpkP2I6YX07ay50PWZ1bmN0aW9uKGEsYil7cmV0dXJuICRhLmModGhpcyxiLG51bGwpfTtrLnM9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiAkYS5jKHRoaXMubWEsYixqZCk9PT1qZD9jOmJ9O2suTD1mdW5jdGlvbigpe3JldHVybiBRKHRoaXMubWEpfTtrLlRiPWZ1bmN0aW9uKGEsYil7dGhpcy5tYT1mZS5hKHRoaXMubWEsYik7cmV0dXJuIHRoaXN9O2suU2E9ZnVuY3Rpb24oYSxiKXt0aGlzLm1hPWVlLmModGhpcy5tYSxiLG51bGwpO3JldHVybiB0aGlzfTtrLlRhPWZ1bmN0aW9uKCl7cmV0dXJuIG5ldyAkZyhudWxsLFFiKHRoaXMubWEpLG51bGwpfTtmdW5jdGlvbiBjaChhLGIsYyl7dGhpcy5rPWE7dGhpcy5qYT1iO3RoaXMucD1jO3RoaXMuaj00MTc3MzA4MzE7dGhpcy5xPTgxOTJ9az1jaC5wcm90b3R5cGU7XG5rLnRvU3RyaW5nPWZ1bmN0aW9uKCl7cmV0dXJuIGVjKHRoaXMpfTtrLnQ9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gJGEuYyh0aGlzLGIsbnVsbCl9O2sucz1mdW5jdGlvbihhLGIsYyl7YT1NZyh0aGlzLmphLGIpO3JldHVybiBudWxsIT1hP2Eua2V5OmN9O2suSD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmt9O2suTD1mdW5jdGlvbigpe3JldHVybiBRKHRoaXMuamEpfTtrLmFiPWZ1bmN0aW9uKCl7cmV0dXJuIDA8USh0aGlzLmphKT9PZS5hKFlmLEdiKHRoaXMuamEpKTpudWxsfTtrLkI9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLnA7cmV0dXJuIG51bGwhPWE/YTp0aGlzLnA9YT14Yyh0aGlzKX07ay5BPWZ1bmN0aW9uKGEsYil7cmV0dXJuIGFkKGIpJiZRKHRoaXMpPT09UShiKSYmRWUoZnVuY3Rpb24oYSl7cmV0dXJuIGZ1bmN0aW9uKGIpe3JldHVybiBuZChhLGIpfX0odGhpcyksYil9O2suSj1mdW5jdGlvbigpe3JldHVybiBuZXcgY2godGhpcy5rLE5hKHRoaXMuamEpLDApfTtcbmsuRWI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IGNoKHRoaXMuayxTYy5hKHRoaXMuamEsYiksbnVsbCl9O2suRD1mdW5jdGlvbigpe3JldHVybiBUZyh0aGlzLmphKX07ay5GPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyBjaChiLHRoaXMuamEsdGhpcy5wKX07ay5HPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyBjaCh0aGlzLmssUmMuYyh0aGlzLmphLGIsbnVsbCksbnVsbCl9O2suY2FsbD1mdW5jdGlvbigpe3ZhciBhPW51bGwsYT1mdW5jdGlvbihhLGMsZCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gdGhpcy50KG51bGwsYyk7Y2FzZSAzOnJldHVybiB0aGlzLnMobnVsbCxjLGQpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTthLmE9ZnVuY3Rpb24oYSxjKXtyZXR1cm4gdGhpcy50KG51bGwsYyl9O2EuYz1mdW5jdGlvbihhLGMsZCl7cmV0dXJuIHRoaXMucyhudWxsLGMsZCl9O3JldHVybiBhfSgpO1xuay5hcHBseT1mdW5jdGlvbihhLGIpe3JldHVybiB0aGlzLmNhbGwuYXBwbHkodGhpcyxbdGhpc10uY29uY2F0KEZhKGIpKSl9O2suYj1mdW5jdGlvbihhKXtyZXR1cm4gdGhpcy50KG51bGwsYSl9O2suYT1mdW5jdGlvbihhLGIpe3JldHVybiB0aGlzLnMobnVsbCxhLGIpfTtrLkhiPWZ1bmN0aW9uKGEsYil7cmV0dXJuIE9lLmEoWWYsSGIodGhpcy5qYSxiKSl9O2suSWI9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBPZS5hKFlmLEliKHRoaXMuamEsYixjKSl9O2suR2I9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gYn07ay5GYj1mdW5jdGlvbigpe3JldHVybiBLYih0aGlzLmphKX07dmFyIGVoPW5ldyBjaChudWxsLE5nLDApO2NoLnByb3RvdHlwZVtFYV09ZnVuY3Rpb24oKXtyZXR1cm4gdWModGhpcyl9O1xuZnVuY3Rpb24gZmgoYSl7YT1EKGEpO2lmKG51bGw9PWEpcmV0dXJuIGJoO2lmKGEgaW5zdGFuY2VvZiBGJiYwPT09YS5tKXthPWEuZTthOntmb3IodmFyIGI9MCxjPU9iKGJoKTs7KWlmKGI8YS5sZW5ndGgpdmFyIGQ9YisxLGM9Yy5TYShudWxsLGFbYl0pLGI9ZDtlbHNle2E9YzticmVhayBhfWE9dm9pZCAwfXJldHVybiBhLlRhKG51bGwpfWZvcihkPU9iKGJoKTs7KWlmKG51bGwhPWEpYj1hLlQobnVsbCksZD1kLlNhKG51bGwsYS5OKG51bGwpKSxhPWI7ZWxzZSByZXR1cm4gZC5UYShudWxsKX1cbnZhciBnaD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSl7dmFyIGQ9bnVsbDtpZigwPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZD0wLGU9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0wKTtkPGUubGVuZ3RoOyllW2RdPWFyZ3VtZW50c1tkKzBdLCsrZDtkPW5ldyBGKGUsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGQpfWZ1bmN0aW9uIGIoYSl7cmV0dXJuIEEuYyhSYSxlaCxhKX1hLmk9MDthLmY9ZnVuY3Rpb24oYSl7YT1EKGEpO3JldHVybiBiKGEpfTthLmQ9YjtyZXR1cm4gYX0oKSxoaD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxkKXt2YXIgZT1udWxsO2lmKDE8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBlPTAsZj1BcnJheShhcmd1bWVudHMubGVuZ3RoLTEpO2U8Zi5sZW5ndGg7KWZbZV09YXJndW1lbnRzW2UrMV0sKytlO2U9bmV3IEYoZiwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsYSxlKX1mdW5jdGlvbiBiKGEsYil7cmV0dXJuIEEuYyhSYSxuZXcgY2gobnVsbCxSZyhhKSwwKSxiKX1cbmEuaT0xO2EuZj1mdW5jdGlvbihhKXt2YXIgZD1HKGEpO2E9SChhKTtyZXR1cm4gYihkLGEpfTthLmQ9YjtyZXR1cm4gYX0oKTtmdW5jdGlvbiBPZChhKXtpZihhJiYoYS5xJjQwOTZ8fGEubGMpKXJldHVybiBhLm5hbWU7aWYoXCJzdHJpbmdcIj09PXR5cGVvZiBhKXJldHVybiBhO3Rocm93IEVycm9yKFt6KFwiRG9lc24ndCBzdXBwb3J0IG5hbWU6IFwiKSx6KGEpXS5qb2luKFwiXCIpKTt9XG52YXIgaWg9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjKXtyZXR1cm4oYS5iP2EuYihiKTphLmNhbGwobnVsbCxiKSk+KGEuYj9hLmIoYyk6YS5jYWxsKG51bGwsYykpP2I6Y312YXIgYj1udWxsLGM9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGIsZCxoLGwpe3ZhciBtPW51bGw7aWYoMzxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIG09MCxwPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMyk7bTxwLmxlbmd0aDspcFttXT1hcmd1bWVudHNbbSszXSwrK207bT1uZXcgRihwLDApfXJldHVybiBjLmNhbGwodGhpcyxiLGQsaCxtKX1mdW5jdGlvbiBjKGEsZCxlLGwpe3JldHVybiBBLmMoZnVuY3Rpb24oYyxkKXtyZXR1cm4gYi5jKGEsYyxkKX0sYi5jKGEsZCxlKSxsKX1hLmk9MzthLmY9ZnVuY3Rpb24oYSl7dmFyIGI9RyhhKTthPUsoYSk7dmFyIGQ9RyhhKTthPUsoYSk7dmFyIGw9RyhhKTthPUgoYSk7cmV0dXJuIGMoYixkLGwsYSl9O2EuZD1jO3JldHVybiBhfSgpLGI9ZnVuY3Rpb24oYixcbmUsZixnKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiBlO2Nhc2UgMzpyZXR1cm4gYS5jYWxsKHRoaXMsYixlLGYpO2RlZmF1bHQ6dmFyIGg9bnVsbDtpZigzPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgaD0wLGw9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0zKTtoPGwubGVuZ3RoOylsW2hdPWFyZ3VtZW50c1toKzNdLCsraDtoPW5ldyBGKGwsMCl9cmV0dXJuIGMuZChiLGUsZixoKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yi5pPTM7Yi5mPWMuZjtiLmE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gYn07Yi5jPWE7Yi5kPWMuZDtyZXR1cm4gYn0oKTtmdW5jdGlvbiBqaChhKXt0aGlzLmU9YX1qaC5wcm90b3R5cGUuYWRkPWZ1bmN0aW9uKGEpe3JldHVybiB0aGlzLmUucHVzaChhKX07amgucHJvdG90eXBlLnNpemU9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5lLmxlbmd0aH07XG5qaC5wcm90b3R5cGUuY2xlYXI9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5lPVtdfTtcbnZhciBraD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMpe3JldHVybiBuZXcgVihudWxsLGZ1bmN0aW9uKCl7dmFyIGg9RChjKTtyZXR1cm4gaD9NKFBlLmEoYSxoKSxkLmMoYSxiLFFlLmEoYixoKSkpOm51bGx9LG51bGwsbnVsbCl9ZnVuY3Rpb24gYihhLGIpe3JldHVybiBkLmMoYSxhLGIpfWZ1bmN0aW9uIGMoYSl7cmV0dXJuIGZ1bmN0aW9uKGIpe3JldHVybiBmdW5jdGlvbihjKXtyZXR1cm4gZnVuY3Rpb24oKXtmdW5jdGlvbiBkKGgsbCl7Yy5hZGQobCk7aWYoYT09PWMuc2l6ZSgpKXt2YXIgbT16ZihjLmUpO2MuY2xlYXIoKTtyZXR1cm4gYi5hP2IuYShoLG0pOmIuY2FsbChudWxsLGgsbSl9cmV0dXJuIGh9ZnVuY3Rpb24gbChhKXtpZighdCgwPT09Yy5lLmxlbmd0aCkpe3ZhciBkPXpmKGMuZSk7Yy5jbGVhcigpO2E9QmMoYi5hP2IuYShhLGQpOmIuY2FsbChudWxsLGEsZCkpfXJldHVybiBiLmI/Yi5iKGEpOmIuY2FsbChudWxsLGEpfWZ1bmN0aW9uIG0oKXtyZXR1cm4gYi5sP1xuYi5sKCk6Yi5jYWxsKG51bGwpfXZhciBwPW51bGwscD1mdW5jdGlvbihhLGIpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDA6cmV0dXJuIG0uY2FsbCh0aGlzKTtjYXNlIDE6cmV0dXJuIGwuY2FsbCh0aGlzLGEpO2Nhc2UgMjpyZXR1cm4gZC5jYWxsKHRoaXMsYSxiKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307cC5sPW07cC5iPWw7cC5hPWQ7cmV0dXJuIHB9KCl9KG5ldyBqaChbXSkpfX12YXIgZD1udWxsLGQ9ZnVuY3Rpb24oZCxmLGcpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGMuY2FsbCh0aGlzLGQpO2Nhc2UgMjpyZXR1cm4gYi5jYWxsKHRoaXMsZCxmKTtjYXNlIDM6cmV0dXJuIGEuY2FsbCh0aGlzLGQsZixnKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307ZC5iPWM7ZC5hPWI7ZC5jPWE7cmV0dXJuIGR9KCksbGg9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsXG5iKXtyZXR1cm4gbmV3IFYobnVsbCxmdW5jdGlvbigpe3ZhciBmPUQoYik7aWYoZil7dmFyIGc7Zz1HKGYpO2c9YS5iP2EuYihnKTphLmNhbGwobnVsbCxnKTtmPXQoZyk/TShHKGYpLGMuYShhLEgoZikpKTpudWxsfWVsc2UgZj1udWxsO3JldHVybiBmfSxudWxsLG51bGwpfWZ1bmN0aW9uIGIoYSl7cmV0dXJuIGZ1bmN0aW9uKGIpe3JldHVybiBmdW5jdGlvbigpe2Z1bmN0aW9uIGMoZixnKXtyZXR1cm4gdChhLmI/YS5iKGcpOmEuY2FsbChudWxsLGcpKT9iLmE/Yi5hKGYsZyk6Yi5jYWxsKG51bGwsZixnKTpuZXcgeWMoZil9ZnVuY3Rpb24gZyhhKXtyZXR1cm4gYi5iP2IuYihhKTpiLmNhbGwobnVsbCxhKX1mdW5jdGlvbiBoKCl7cmV0dXJuIGIubD9iLmwoKTpiLmNhbGwobnVsbCl9dmFyIGw9bnVsbCxsPWZ1bmN0aW9uKGEsYil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMDpyZXR1cm4gaC5jYWxsKHRoaXMpO2Nhc2UgMTpyZXR1cm4gZy5jYWxsKHRoaXMsYSk7Y2FzZSAyOnJldHVybiBjLmNhbGwodGhpcyxcbmEsYil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2wubD1oO2wuYj1nO2wuYT1jO3JldHVybiBsfSgpfX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiLmNhbGwodGhpcyxjKTtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYj1iO2MuYT1hO3JldHVybiBjfSgpO2Z1bmN0aW9uIG1oKGEsYixjKXtyZXR1cm4gZnVuY3Rpb24oZCl7dmFyIGU9S2IoYSk7ZD1KYihhLGQpO2U9ZS5hP2UuYShkLGMpOmUuY2FsbChudWxsLGQsYyk7cmV0dXJuIGIuYT9iLmEoZSwwKTpiLmNhbGwobnVsbCxlLDApfX1cbnZhciBuaD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMsZyxoKXt2YXIgbD1JYihhLGMsITApO2lmKHQobCkpe3ZhciBtPVIuYyhsLDAsbnVsbCk7cmV0dXJuIGxoLmEobWgoYSxnLGgpLHQobWgoYSxiLGMpLmNhbGwobnVsbCxtKSk/bDpLKGwpKX1yZXR1cm4gbnVsbH1mdW5jdGlvbiBiKGEsYixjKXt2YXIgZz1taChhLGIsYyksaDthOntoPVtBZCxCZF07dmFyIGw9aC5sZW5ndGg7aWYobDw9VmYpZm9yKHZhciBtPTAscD1PYihVZik7OylpZihtPGwpdmFyIHE9bSsxLHA9UmIocCxoW21dLG51bGwpLG09cTtlbHNle2g9bmV3ICRnKG51bGwsUWIocCksbnVsbCk7YnJlYWsgYX1lbHNlIGZvcihtPTAscD1PYihiaCk7OylpZihtPGwpcT1tKzEscD1QYihwLGhbbV0pLG09cTtlbHNle2g9UWIocCk7YnJlYWsgYX1oPXZvaWQgMH1yZXR1cm4gdChoLmNhbGwobnVsbCxiKSk/KGE9SWIoYSxjLCEwKSx0KGEpPyhiPVIuYyhhLDAsbnVsbCksdChnLmI/Zy5iKGIpOmcuY2FsbChudWxsLGIpKT9cbmE6SyhhKSk6bnVsbCk6bGguYShnLEhiKGEsITApKX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlLGYsZyxoKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAzOnJldHVybiBiLmNhbGwodGhpcyxjLGUsZik7Y2FzZSA1OnJldHVybiBhLmNhbGwodGhpcyxjLGUsZixnLGgpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmM9YjtjLnI9YTtyZXR1cm4gY30oKTtmdW5jdGlvbiBvaChhLGIsYyl7dGhpcy5tPWE7dGhpcy5lbmQ9Yjt0aGlzLnN0ZXA9Y31vaC5wcm90b3R5cGUuZ2E9ZnVuY3Rpb24oKXtyZXR1cm4gMDx0aGlzLnN0ZXA/dGhpcy5tPHRoaXMuZW5kOnRoaXMubT50aGlzLmVuZH07b2gucHJvdG90eXBlLm5leHQ9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLm07dGhpcy5tKz10aGlzLnN0ZXA7cmV0dXJuIGF9O1xuZnVuY3Rpb24gcGgoYSxiLGMsZCxlKXt0aGlzLms9YTt0aGlzLnN0YXJ0PWI7dGhpcy5lbmQ9Yzt0aGlzLnN0ZXA9ZDt0aGlzLnA9ZTt0aGlzLmo9MzIzNzUwMDY7dGhpcy5xPTgxOTJ9az1waC5wcm90b3R5cGU7ay50b1N0cmluZz1mdW5jdGlvbigpe3JldHVybiBlYyh0aGlzKX07ay5RPWZ1bmN0aW9uKGEsYil7aWYoYjxNYSh0aGlzKSlyZXR1cm4gdGhpcy5zdGFydCtiKnRoaXMuc3RlcDtpZih0aGlzLnN0YXJ0PnRoaXMuZW5kJiYwPT09dGhpcy5zdGVwKXJldHVybiB0aGlzLnN0YXJ0O3Rocm93IEVycm9yKFwiSW5kZXggb3V0IG9mIGJvdW5kc1wiKTt9O2suJD1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIGI8TWEodGhpcyk/dGhpcy5zdGFydCtiKnRoaXMuc3RlcDp0aGlzLnN0YXJ0PnRoaXMuZW5kJiYwPT09dGhpcy5zdGVwP3RoaXMuc3RhcnQ6Y307ay52Yj0hMDtrLmZiPWZ1bmN0aW9uKCl7cmV0dXJuIG5ldyBvaCh0aGlzLnN0YXJ0LHRoaXMuZW5kLHRoaXMuc3RlcCl9O2suSD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmt9O1xuay5UPWZ1bmN0aW9uKCl7cmV0dXJuIDA8dGhpcy5zdGVwP3RoaXMuc3RhcnQrdGhpcy5zdGVwPHRoaXMuZW5kP25ldyBwaCh0aGlzLmssdGhpcy5zdGFydCt0aGlzLnN0ZXAsdGhpcy5lbmQsdGhpcy5zdGVwLG51bGwpOm51bGw6dGhpcy5zdGFydCt0aGlzLnN0ZXA+dGhpcy5lbmQ/bmV3IHBoKHRoaXMuayx0aGlzLnN0YXJ0K3RoaXMuc3RlcCx0aGlzLmVuZCx0aGlzLnN0ZXAsbnVsbCk6bnVsbH07ay5MPWZ1bmN0aW9uKCl7aWYoQWEoQ2IodGhpcykpKXJldHVybiAwO3ZhciBhPSh0aGlzLmVuZC10aGlzLnN0YXJ0KS90aGlzLnN0ZXA7cmV0dXJuIE1hdGguY2VpbC5iP01hdGguY2VpbC5iKGEpOk1hdGguY2VpbC5jYWxsKG51bGwsYSl9O2suQj1mdW5jdGlvbigpe3ZhciBhPXRoaXMucDtyZXR1cm4gbnVsbCE9YT9hOnRoaXMucD1hPXdjKHRoaXMpfTtrLkE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gSWModGhpcyxiKX07ay5KPWZ1bmN0aW9uKCl7cmV0dXJuIE8oSix0aGlzLmspfTtcbmsuUj1mdW5jdGlvbihhLGIpe3JldHVybiBDYy5hKHRoaXMsYil9O2suTz1mdW5jdGlvbihhLGIsYyl7Zm9yKGE9dGhpcy5zdGFydDs7KWlmKDA8dGhpcy5zdGVwP2E8dGhpcy5lbmQ6YT50aGlzLmVuZCl7dmFyIGQ9YTtjPWIuYT9iLmEoYyxkKTpiLmNhbGwobnVsbCxjLGQpO2lmKEFjKGMpKXJldHVybiBiPWMsTC5iP0wuYihiKTpMLmNhbGwobnVsbCxiKTthKz10aGlzLnN0ZXB9ZWxzZSByZXR1cm4gY307ay5OPWZ1bmN0aW9uKCl7cmV0dXJuIG51bGw9PUNiKHRoaXMpP251bGw6dGhpcy5zdGFydH07ay5TPWZ1bmN0aW9uKCl7cmV0dXJuIG51bGwhPUNiKHRoaXMpP25ldyBwaCh0aGlzLmssdGhpcy5zdGFydCt0aGlzLnN0ZXAsdGhpcy5lbmQsdGhpcy5zdGVwLG51bGwpOkp9O2suRD1mdW5jdGlvbigpe3JldHVybiAwPHRoaXMuc3RlcD90aGlzLnN0YXJ0PHRoaXMuZW5kP3RoaXM6bnVsbDp0aGlzLnN0YXJ0PnRoaXMuZW5kP3RoaXM6bnVsbH07XG5rLkY9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IHBoKGIsdGhpcy5zdGFydCx0aGlzLmVuZCx0aGlzLnN0ZXAsdGhpcy5wKX07ay5HPWZ1bmN0aW9uKGEsYil7cmV0dXJuIE0oYix0aGlzKX07cGgucHJvdG90eXBlW0VhXT1mdW5jdGlvbigpe3JldHVybiB1Yyh0aGlzKX07XG52YXIgcWg9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjKXtyZXR1cm4gbmV3IHBoKG51bGwsYSxiLGMsbnVsbCl9ZnVuY3Rpb24gYihhLGIpe3JldHVybiBlLmMoYSxiLDEpfWZ1bmN0aW9uIGMoYSl7cmV0dXJuIGUuYygwLGEsMSl9ZnVuY3Rpb24gZCgpe3JldHVybiBlLmMoMCxOdW1iZXIuTUFYX1ZBTFVFLDEpfXZhciBlPW51bGwsZT1mdW5jdGlvbihlLGcsaCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMDpyZXR1cm4gZC5jYWxsKHRoaXMpO2Nhc2UgMTpyZXR1cm4gYy5jYWxsKHRoaXMsZSk7Y2FzZSAyOnJldHVybiBiLmNhbGwodGhpcyxlLGcpO2Nhc2UgMzpyZXR1cm4gYS5jYWxsKHRoaXMsZSxnLGgpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtlLmw9ZDtlLmI9YztlLmE9YjtlLmM9YTtyZXR1cm4gZX0oKSxyaD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiKXtyZXR1cm4gbmV3IFYobnVsbCxmdW5jdGlvbigpe3ZhciBmPVxuRChiKTtyZXR1cm4gZj9NKEcoZiksYy5hKGEsUWUuYShhLGYpKSk6bnVsbH0sbnVsbCxudWxsKX1mdW5jdGlvbiBiKGEpe3JldHVybiBmdW5jdGlvbihiKXtyZXR1cm4gZnVuY3Rpb24oYyl7cmV0dXJuIGZ1bmN0aW9uKCl7ZnVuY3Rpb24gZyhnLGgpe3ZhciBsPWMuYmIoMCxjLlJhKG51bGwpKzEpLG09Q2QobCxhKTtyZXR1cm4gMD09PWwtYSptP2IuYT9iLmEoZyxoKTpiLmNhbGwobnVsbCxnLGgpOmd9ZnVuY3Rpb24gaChhKXtyZXR1cm4gYi5iP2IuYihhKTpiLmNhbGwobnVsbCxhKX1mdW5jdGlvbiBsKCl7cmV0dXJuIGIubD9iLmwoKTpiLmNhbGwobnVsbCl9dmFyIG09bnVsbCxtPWZ1bmN0aW9uKGEsYil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMDpyZXR1cm4gbC5jYWxsKHRoaXMpO2Nhc2UgMTpyZXR1cm4gaC5jYWxsKHRoaXMsYSk7Y2FzZSAyOnJldHVybiBnLmNhbGwodGhpcyxhLGIpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7XG59O20ubD1sO20uYj1oO20uYT1nO3JldHVybiBtfSgpfShuZXcgTWUoLTEpKX19dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYi5jYWxsKHRoaXMsYyk7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxjLGUpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmI9YjtjLmE9YTtyZXR1cm4gY30oKSx0aD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiKXtyZXR1cm4gbmV3IFYobnVsbCxmdW5jdGlvbigpe3ZhciBmPUQoYik7aWYoZil7dmFyIGc9RyhmKSxoPWEuYj9hLmIoZyk6YS5jYWxsKG51bGwsZyksZz1NKGcsbGguYShmdW5jdGlvbihiLGMpe3JldHVybiBmdW5jdGlvbihiKXtyZXR1cm4gc2MuYShjLGEuYj9hLmIoYik6YS5jYWxsKG51bGwsYikpfX0oZyxoLGYsZiksSyhmKSkpO3JldHVybiBNKGcsYy5hKGEsRChRZS5hKFEoZyksZikpKSl9cmV0dXJuIG51bGx9LG51bGwsXG5udWxsKX1mdW5jdGlvbiBiKGEpe3JldHVybiBmdW5jdGlvbihiKXtyZXR1cm4gZnVuY3Rpb24oYyxnKXtyZXR1cm4gZnVuY3Rpb24oKXtmdW5jdGlvbiBoKGgsbCl7dmFyIG09TC5iP0wuYihnKTpMLmNhbGwobnVsbCxnKSxwPWEuYj9hLmIobCk6YS5jYWxsKG51bGwsbCk7YWMoZyxwKTtpZihOZChtLHNoKXx8c2MuYShwLG0pKXJldHVybiBjLmFkZChsKSxoO209emYoYy5lKTtjLmNsZWFyKCk7bT1iLmE/Yi5hKGgsbSk6Yi5jYWxsKG51bGwsaCxtKTtBYyhtKXx8Yy5hZGQobCk7cmV0dXJuIG19ZnVuY3Rpb24gbChhKXtpZighdCgwPT09Yy5lLmxlbmd0aCkpe3ZhciBkPXpmKGMuZSk7Yy5jbGVhcigpO2E9QmMoYi5hP2IuYShhLGQpOmIuY2FsbChudWxsLGEsZCkpfXJldHVybiBiLmI/Yi5iKGEpOmIuY2FsbChudWxsLGEpfWZ1bmN0aW9uIG0oKXtyZXR1cm4gYi5sP2IubCgpOmIuY2FsbChudWxsKX12YXIgcD1udWxsLHA9ZnVuY3Rpb24oYSxiKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAwOnJldHVybiBtLmNhbGwodGhpcyk7XG5jYXNlIDE6cmV0dXJuIGwuY2FsbCh0aGlzLGEpO2Nhc2UgMjpyZXR1cm4gaC5jYWxsKHRoaXMsYSxiKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307cC5sPW07cC5iPWw7cC5hPWg7cmV0dXJuIHB9KCl9KG5ldyBqaChbXSksbmV3IE1lKHNoKSl9fXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGIuY2FsbCh0aGlzLGMpO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5iPWI7Yy5hPWE7cmV0dXJuIGN9KCksdWg9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYil7Zm9yKDs7KWlmKEQoYikmJjA8YSl7dmFyIGM9YS0xLGc9SyhiKTthPWM7Yj1nfWVsc2UgcmV0dXJuIG51bGx9ZnVuY3Rpb24gYihhKXtmb3IoOzspaWYoRChhKSlhPUsoYSk7ZWxzZSByZXR1cm4gbnVsbH12YXIgYz1cbm51bGwsYz1mdW5jdGlvbihjLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGIuY2FsbCh0aGlzLGMpO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5iPWI7Yy5hPWE7cmV0dXJuIGN9KCksdmg9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYil7dWguYShhLGIpO3JldHVybiBifWZ1bmN0aW9uIGIoYSl7dWguYihhKTtyZXR1cm4gYX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiLmNhbGwodGhpcyxjKTtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYj1iO2MuYT1hO3JldHVybiBjfSgpO1xuZnVuY3Rpb24gd2goYSxiLGMsZCxlLGYsZyl7dmFyIGg9bWE7dHJ5e21hPW51bGw9PW1hP251bGw6bWEtMTtpZihudWxsIT1tYSYmMD5tYSlyZXR1cm4gTGIoYSxcIiNcIik7TGIoYSxjKTtpZihEKGcpKXt2YXIgbD1HKGcpO2IuYz9iLmMobCxhLGYpOmIuY2FsbChudWxsLGwsYSxmKX1mb3IodmFyIG09SyhnKSxwPXphLmIoZiktMTs7KWlmKCFtfHxudWxsIT1wJiYwPT09cCl7RChtKSYmMD09PXAmJihMYihhLGQpLExiKGEsXCIuLi5cIikpO2JyZWFrfWVsc2V7TGIoYSxkKTt2YXIgcT1HKG0pO2M9YTtnPWY7Yi5jP2IuYyhxLGMsZyk6Yi5jYWxsKG51bGwscSxjLGcpO3ZhciBzPUsobSk7Yz1wLTE7bT1zO3A9Y31yZXR1cm4gTGIoYSxlKX1maW5hbGx5e21hPWh9fVxudmFyIHhoPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGQpe3ZhciBlPW51bGw7aWYoMTxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGU9MCxmPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMSk7ZTxmLmxlbmd0aDspZltlXT1hcmd1bWVudHNbZSsxXSwrK2U7ZT1uZXcgRihmLDApfXJldHVybiBiLmNhbGwodGhpcyxhLGUpfWZ1bmN0aW9uIGIoYSxiKXtmb3IodmFyIGU9RChiKSxmPW51bGwsZz0wLGg9MDs7KWlmKGg8Zyl7dmFyIGw9Zi5RKG51bGwsaCk7TGIoYSxsKTtoKz0xfWVsc2UgaWYoZT1EKGUpKWY9ZSxmZChmKT8oZT1ZYihmKSxnPVpiKGYpLGY9ZSxsPVEoZSksZT1nLGc9bCk6KGw9RyhmKSxMYihhLGwpLGU9SyhmKSxmPW51bGwsZz0wKSxoPTA7ZWxzZSByZXR1cm4gbnVsbH1hLmk9MTthLmY9ZnVuY3Rpb24oYSl7dmFyIGQ9RyhhKTthPUgoYSk7cmV0dXJuIGIoZCxhKX07YS5kPWI7cmV0dXJuIGF9KCkseWg9eydcIic6J1xcXFxcIicsXCJcXFxcXCI6XCJcXFxcXFxcXFwiLFwiXFxiXCI6XCJcXFxcYlwiLFwiXFxmXCI6XCJcXFxcZlwiLFxuXCJcXG5cIjpcIlxcXFxuXCIsXCJcXHJcIjpcIlxcXFxyXCIsXCJcXHRcIjpcIlxcXFx0XCJ9O2Z1bmN0aW9uIHpoKGEpe3JldHVyblt6KCdcIicpLHooYS5yZXBsYWNlKFJlZ0V4cCgnW1xcXFxcXFxcXCJcXGJcXGZcXG5cXHJcXHRdJyxcImdcIiksZnVuY3Rpb24oYSl7cmV0dXJuIHloW2FdfSkpLHooJ1wiJyldLmpvaW4oXCJcIil9XG52YXIgJD1mdW5jdGlvbiBBaChiLGMsZCl7aWYobnVsbD09YilyZXR1cm4gTGIoYyxcIm5pbFwiKTtpZih2b2lkIDA9PT1iKXJldHVybiBMYihjLFwiI1xceDNjdW5kZWZpbmVkXFx4M2VcIik7dChmdW5jdGlvbigpe3ZhciBjPVMuYShkLHdhKTtyZXR1cm4gdChjKT8oYz1iP2IuaiYxMzEwNzJ8fGIua2M/ITA6Yi5qPyExOncocmIsYik6dyhyYixiKSk/VmMoYik6YzpjfSgpKSYmKExiKGMsXCJeXCIpLEFoKFZjKGIpLGMsZCksTGIoYyxcIiBcIikpO2lmKG51bGw9PWIpcmV0dXJuIExiKGMsXCJuaWxcIik7aWYoYi5ZYilyZXR1cm4gYi5uYyhjKTtpZihiJiYoYi5qJjIxNDc0ODM2NDh8fGIuSSkpcmV0dXJuIGIudihudWxsLGMsZCk7aWYoQmEoYik9PT1Cb29sZWFufHxcIm51bWJlclwiPT09dHlwZW9mIGIpcmV0dXJuIExiKGMsXCJcIit6KGIpKTtpZihudWxsIT1iJiZiLmNvbnN0cnVjdG9yPT09T2JqZWN0KXtMYihjLFwiI2pzIFwiKTt2YXIgZT1PZS5hKGZ1bmN0aW9uKGMpe3JldHVybiBuZXcgVyhudWxsLDIsNSxcbnVmLFtQZC5iKGMpLGJbY11dLG51bGwpfSxnZChiKSk7cmV0dXJuIEJoLm4/QmgubihlLEFoLGMsZCk6QmguY2FsbChudWxsLGUsQWgsYyxkKX1yZXR1cm4gYiBpbnN0YW5jZW9mIEFycmF5P3doKGMsQWgsXCIjanMgW1wiLFwiIFwiLFwiXVwiLGQsYik6dChcInN0cmluZ1wiPT10eXBlb2YgYik/dCh1YS5iKGQpKT9MYihjLHpoKGIpKTpMYihjLGIpOlRjKGIpP3hoLmQoYyxLYyhbXCIjXFx4M2NcIixcIlwiK3ooYiksXCJcXHgzZVwiXSwwKSk6YiBpbnN0YW5jZW9mIERhdGU/KGU9ZnVuY3Rpb24oYixjKXtmb3IodmFyIGQ9XCJcIit6KGIpOzspaWYoUShkKTxjKWQ9W3ooXCIwXCIpLHooZCldLmpvaW4oXCJcIik7ZWxzZSByZXR1cm4gZH0seGguZChjLEtjKFsnI2luc3QgXCInLFwiXCIreihiLmdldFVUQ0Z1bGxZZWFyKCkpLFwiLVwiLGUoYi5nZXRVVENNb250aCgpKzEsMiksXCItXCIsZShiLmdldFVUQ0RhdGUoKSwyKSxcIlRcIixlKGIuZ2V0VVRDSG91cnMoKSwyKSxcIjpcIixlKGIuZ2V0VVRDTWludXRlcygpLDIpLFwiOlwiLGUoYi5nZXRVVENTZWNvbmRzKCksXG4yKSxcIi5cIixlKGIuZ2V0VVRDTWlsbGlzZWNvbmRzKCksMyksXCItXCIsJzAwOjAwXCInXSwwKSkpOmIgaW5zdGFuY2VvZiBSZWdFeHA/eGguZChjLEtjKFsnI1wiJyxiLnNvdXJjZSwnXCInXSwwKSk6KGI/Yi5qJjIxNDc0ODM2NDh8fGIuSXx8KGIuaj8wOncoTWIsYikpOncoTWIsYikpP05iKGIsYyxkKTp4aC5kKGMsS2MoW1wiI1xceDNjXCIsXCJcIit6KGIpLFwiXFx4M2VcIl0sMCkpfSxDaD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSl7dmFyIGQ9bnVsbDtpZigwPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZD0wLGU9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0wKTtkPGUubGVuZ3RoOyllW2RdPWFyZ3VtZW50c1tkKzBdLCsrZDtkPW5ldyBGKGUsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGQpfWZ1bmN0aW9uIGIoYSl7dmFyIGI9b2EoKTtpZihZYyhhKSliPVwiXCI7ZWxzZXt2YXIgZT16LGY9bmV3IGZhO2E6e3ZhciBnPW5ldyBkYyhmKTskKEcoYSksZyxiKTthPUQoSyhhKSk7Zm9yKHZhciBoPW51bGwsbD0wLFxubT0wOzspaWYobTxsKXt2YXIgcD1oLlEobnVsbCxtKTtMYihnLFwiIFwiKTskKHAsZyxiKTttKz0xfWVsc2UgaWYoYT1EKGEpKWg9YSxmZChoKT8oYT1ZYihoKSxsPVpiKGgpLGg9YSxwPVEoYSksYT1sLGw9cCk6KHA9RyhoKSxMYihnLFwiIFwiKSwkKHAsZyxiKSxhPUsoaCksaD1udWxsLGw9MCksbT0wO2Vsc2UgYnJlYWsgYX1iPVwiXCIrZShmKX1yZXR1cm4gYn1hLmk9MDthLmY9ZnVuY3Rpb24oYSl7YT1EKGEpO3JldHVybiBiKGEpfTthLmQ9YjtyZXR1cm4gYX0oKTtmdW5jdGlvbiBCaChhLGIsYyxkKXtyZXR1cm4gd2goYyxmdW5jdGlvbihhLGMsZCl7dmFyIGg9aGIoYSk7Yi5jP2IuYyhoLGMsZCk6Yi5jYWxsKG51bGwsaCxjLGQpO0xiKGMsXCIgXCIpO2E9aWIoYSk7cmV0dXJuIGIuYz9iLmMoYSxjLGQpOmIuY2FsbChudWxsLGEsYyxkKX0sXCJ7XCIsXCIsIFwiLFwifVwiLGQsRChhKSl9TWUucHJvdG90eXBlLkk9ITA7XG5NZS5wcm90b3R5cGUudj1mdW5jdGlvbihhLGIsYyl7TGIoYixcIiNcXHgzY1ZvbGF0aWxlOiBcIik7JCh0aGlzLnN0YXRlLGIsYyk7cmV0dXJuIExiKGIsXCJcXHgzZVwiKX07Ri5wcm90b3R5cGUuST0hMDtGLnByb3RvdHlwZS52PWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gd2goYiwkLFwiKFwiLFwiIFwiLFwiKVwiLGMsdGhpcyl9O1YucHJvdG90eXBlLkk9ITA7Vi5wcm90b3R5cGUudj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIHdoKGIsJCxcIihcIixcIiBcIixcIilcIixjLHRoaXMpfTt3Zy5wcm90b3R5cGUuST0hMDt3Zy5wcm90b3R5cGUudj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIHdoKGIsJCxcIihcIixcIiBcIixcIilcIixjLHRoaXMpfTtwZy5wcm90b3R5cGUuST0hMDtwZy5wcm90b3R5cGUudj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIHdoKGIsJCxcIihcIixcIiBcIixcIilcIixjLHRoaXMpfTtaLnByb3RvdHlwZS5JPSEwO1xuWi5wcm90b3R5cGUudj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIHdoKGIsJCxcIltcIixcIiBcIixcIl1cIixjLHRoaXMpfTtSZi5wcm90b3R5cGUuST0hMDtSZi5wcm90b3R5cGUudj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIHdoKGIsJCxcIihcIixcIiBcIixcIilcIixjLHRoaXMpfTtjaC5wcm90b3R5cGUuST0hMDtjaC5wcm90b3R5cGUudj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIHdoKGIsJCxcIiN7XCIsXCIgXCIsXCJ9XCIsYyx0aGlzKX07QmYucHJvdG90eXBlLkk9ITA7QmYucHJvdG90eXBlLnY9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiB3aChiLCQsXCIoXCIsXCIgXCIsXCIpXCIsYyx0aGlzKX07TGQucHJvdG90eXBlLkk9ITA7TGQucHJvdG90eXBlLnY9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiB3aChiLCQsXCIoXCIsXCIgXCIsXCIpXCIsYyx0aGlzKX07SGMucHJvdG90eXBlLkk9ITA7SGMucHJvdG90eXBlLnY9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiB3aChiLCQsXCIoXCIsXCIgXCIsXCIpXCIsYyx0aGlzKX07XG5yZy5wcm90b3R5cGUuST0hMDtyZy5wcm90b3R5cGUudj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIEJoKHRoaXMsJCxiLGMpfTtxZy5wcm90b3R5cGUuST0hMDtxZy5wcm90b3R5cGUudj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIHdoKGIsJCxcIihcIixcIiBcIixcIilcIixjLHRoaXMpfTtEZi5wcm90b3R5cGUuST0hMDtEZi5wcm90b3R5cGUudj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIHdoKGIsJCxcIltcIixcIiBcIixcIl1cIixjLHRoaXMpfTtMZy5wcm90b3R5cGUuST0hMDtMZy5wcm90b3R5cGUudj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIEJoKHRoaXMsJCxiLGMpfTskZy5wcm90b3R5cGUuST0hMDskZy5wcm90b3R5cGUudj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIHdoKGIsJCxcIiN7XCIsXCIgXCIsXCJ9XCIsYyx0aGlzKX07VmQucHJvdG90eXBlLkk9ITA7VmQucHJvdG90eXBlLnY9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiB3aChiLCQsXCIoXCIsXCIgXCIsXCIpXCIsYyx0aGlzKX07VWcucHJvdG90eXBlLkk9ITA7XG5VZy5wcm90b3R5cGUudj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIHdoKGIsJCxcIihcIixcIiBcIixcIilcIixjLHRoaXMpfTtYLnByb3RvdHlwZS5JPSEwO1gucHJvdG90eXBlLnY9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiB3aChiLCQsXCJbXCIsXCIgXCIsXCJdXCIsYyx0aGlzKX07Vy5wcm90b3R5cGUuST0hMDtXLnByb3RvdHlwZS52PWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gd2goYiwkLFwiW1wiLFwiIFwiLFwiXVwiLGMsdGhpcyl9O0tmLnByb3RvdHlwZS5JPSEwO0tmLnByb3RvdHlwZS52PWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gd2goYiwkLFwiKFwiLFwiIFwiLFwiKVwiLGMsdGhpcyl9O0hkLnByb3RvdHlwZS5JPSEwO0hkLnByb3RvdHlwZS52PWZ1bmN0aW9uKGEsYil7cmV0dXJuIExiKGIsXCIoKVwiKX07emUucHJvdG90eXBlLkk9ITA7emUucHJvdG90eXBlLnY9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiB3aChiLCQsXCIoXCIsXCIgXCIsXCIpXCIsYyx0aGlzKX07TGYucHJvdG90eXBlLkk9ITA7XG5MZi5wcm90b3R5cGUudj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIHdoKGIsJCxcIiNxdWV1ZSBbXCIsXCIgXCIsXCJdXCIsYyxEKHRoaXMpKX07cGEucHJvdG90eXBlLkk9ITA7cGEucHJvdG90eXBlLnY9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBCaCh0aGlzLCQsYixjKX07cGgucHJvdG90eXBlLkk9ITA7cGgucHJvdG90eXBlLnY9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiB3aChiLCQsXCIoXCIsXCIgXCIsXCIpXCIsYyx0aGlzKX07U2cucHJvdG90eXBlLkk9ITA7U2cucHJvdG90eXBlLnY9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiB3aChiLCQsXCIoXCIsXCIgXCIsXCIpXCIsYyx0aGlzKX07RmQucHJvdG90eXBlLkk9ITA7RmQucHJvdG90eXBlLnY9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiB3aChiLCQsXCIoXCIsXCIgXCIsXCIpXCIsYyx0aGlzKX07Vy5wcm90b3R5cGUuc2I9ITA7Vy5wcm90b3R5cGUudGI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gcGQuYSh0aGlzLGIpfTtEZi5wcm90b3R5cGUuc2I9ITA7XG5EZi5wcm90b3R5cGUudGI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gcGQuYSh0aGlzLGIpfTtVLnByb3RvdHlwZS5zYj0hMDtVLnByb3RvdHlwZS50Yj1mdW5jdGlvbihhLGIpe3JldHVybiBNZCh0aGlzLGIpfTtxYy5wcm90b3R5cGUuc2I9ITA7cWMucHJvdG90eXBlLnRiPWZ1bmN0aW9uKGEsYil7cmV0dXJuIHBjKHRoaXMsYil9O3ZhciBEaD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxkLGUpe3ZhciBmPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGY9MCxnPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7ZjxnLmxlbmd0aDspZ1tmXT1hcmd1bWVudHNbZisyXSwrK2Y7Zj1uZXcgRihnLDApfXJldHVybiBiLmNhbGwodGhpcyxhLGQsZil9ZnVuY3Rpb24gYihhLGIsZSl7cmV0dXJuIGEuaz1ULmMoYixhLmssZSl9YS5pPTI7YS5mPWZ1bmN0aW9uKGEpe3ZhciBkPUcoYSk7YT1LKGEpO3ZhciBlPUcoYSk7YT1IKGEpO3JldHVybiBiKGQsZSxhKX07YS5kPWI7cmV0dXJuIGF9KCk7XG5mdW5jdGlvbiBFaChhKXtyZXR1cm4gZnVuY3Rpb24oYixjKXt2YXIgZD1hLmE/YS5hKGIsYyk6YS5jYWxsKG51bGwsYixjKTtyZXR1cm4gQWMoZCk/bmV3IHljKGQpOmR9fVxuZnVuY3Rpb24gVmUoYSl7cmV0dXJuIGZ1bmN0aW9uKGIpe3JldHVybiBmdW5jdGlvbigpe2Z1bmN0aW9uIGMoYSxjKXtyZXR1cm4gQS5jKGIsYSxjKX1mdW5jdGlvbiBkKGIpe3JldHVybiBhLmI/YS5iKGIpOmEuY2FsbChudWxsLGIpfWZ1bmN0aW9uIGUoKXtyZXR1cm4gYS5sP2EubCgpOmEuY2FsbChudWxsKX12YXIgZj1udWxsLGY9ZnVuY3Rpb24oYSxiKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAwOnJldHVybiBlLmNhbGwodGhpcyk7Y2FzZSAxOnJldHVybiBkLmNhbGwodGhpcyxhKTtjYXNlIDI6cmV0dXJuIGMuY2FsbCh0aGlzLGEsYil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2YubD1lO2YuYj1kO2YuYT1jO3JldHVybiBmfSgpfShFaChhKSl9XG52YXIgRmg9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEpe3JldHVybiBDZS5hKGMubCgpLGEpfWZ1bmN0aW9uIGIoKXtyZXR1cm4gZnVuY3Rpb24oYSl7cmV0dXJuIGZ1bmN0aW9uKGIpe3JldHVybiBmdW5jdGlvbigpe2Z1bmN0aW9uIGMoZixnKXt2YXIgaD1MLmI/TC5iKGIpOkwuY2FsbChudWxsLGIpO2FjKGIsZyk7cmV0dXJuIHNjLmEoaCxnKT9mOmEuYT9hLmEoZixnKTphLmNhbGwobnVsbCxmLGcpfWZ1bmN0aW9uIGcoYil7cmV0dXJuIGEuYj9hLmIoYik6YS5jYWxsKG51bGwsYil9ZnVuY3Rpb24gaCgpe3JldHVybiBhLmw/YS5sKCk6YS5jYWxsKG51bGwpfXZhciBsPW51bGwsbD1mdW5jdGlvbihhLGIpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDA6cmV0dXJuIGguY2FsbCh0aGlzKTtjYXNlIDE6cmV0dXJuIGcuY2FsbCh0aGlzLGEpO2Nhc2UgMjpyZXR1cm4gYy5jYWxsKHRoaXMsYSxiKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO1xufTtsLmw9aDtsLmI9ZztsLmE9YztyZXR1cm4gbH0oKX0obmV3IE1lKHNoKSl9fXZhciBjPW51bGwsYz1mdW5jdGlvbihjKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAwOnJldHVybiBiLmNhbGwodGhpcyk7Y2FzZSAxOnJldHVybiBhLmNhbGwodGhpcyxjKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5sPWI7Yy5iPWE7cmV0dXJuIGN9KCk7ZnVuY3Rpb24gR2goYSxiKXt0aGlzLmZhPWE7dGhpcy5aYj1iO3RoaXMucT0wO3RoaXMuaj0yMTczMTczNzYwfUdoLnByb3RvdHlwZS52PWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gd2goYiwkLFwiKFwiLFwiIFwiLFwiKVwiLGMsdGhpcyl9O0doLnByb3RvdHlwZS5PPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gd2Qubih0aGlzLmZhLGIsYyx0aGlzLlpiKX07R2gucHJvdG90eXBlLkQ9ZnVuY3Rpb24oKXtyZXR1cm4gRChDZS5hKHRoaXMuZmEsdGhpcy5aYikpfTtHaC5wcm90b3R5cGVbRWFdPWZ1bmN0aW9uKCl7cmV0dXJuIHVjKHRoaXMpfTtcbnZhciBIaD17fTtmdW5jdGlvbiBJaChhKXtpZihhP2EuZ2M6YSlyZXR1cm4gYS5nYyhhKTt2YXIgYjtiPUloW24obnVsbD09YT9udWxsOmEpXTtpZighYiYmKGI9SWguXywhYikpdGhyb3cgeChcIklFbmNvZGVKUy4tY2xqLVxceDNlanNcIixhKTtyZXR1cm4gYi5jYWxsKG51bGwsYSl9ZnVuY3Rpb24gSmgoYSl7cmV0dXJuKGE/dCh0KG51bGwpP251bGw6YS5mYyl8fChhLnliPzA6dyhIaCxhKSk6dyhIaCxhKSk/SWgoYSk6XCJzdHJpbmdcIj09PXR5cGVvZiBhfHxcIm51bWJlclwiPT09dHlwZW9mIGF8fGEgaW5zdGFuY2VvZiBVfHxhIGluc3RhbmNlb2YgcWM/S2guYj9LaC5iKGEpOktoLmNhbGwobnVsbCxhKTpDaC5kKEtjKFthXSwwKSl9XG52YXIgS2g9ZnVuY3Rpb24gTGgoYil7aWYobnVsbD09YilyZXR1cm4gbnVsbDtpZihiP3QodChudWxsKT9udWxsOmIuZmMpfHwoYi55Yj8wOncoSGgsYikpOncoSGgsYikpcmV0dXJuIEloKGIpO2lmKGIgaW5zdGFuY2VvZiBVKXJldHVybiBPZChiKTtpZihiIGluc3RhbmNlb2YgcWMpcmV0dXJuXCJcIit6KGIpO2lmKGRkKGIpKXt2YXIgYz17fTtiPUQoYik7Zm9yKHZhciBkPW51bGwsZT0wLGY9MDs7KWlmKGY8ZSl7dmFyIGc9ZC5RKG51bGwsZiksaD1SLmMoZywwLG51bGwpLGc9Ui5jKGcsMSxudWxsKTtjW0poKGgpXT1MaChnKTtmKz0xfWVsc2UgaWYoYj1EKGIpKWZkKGIpPyhlPVliKGIpLGI9WmIoYiksZD1lLGU9UShlKSk6KGU9RyhiKSxkPVIuYyhlLDAsbnVsbCksZT1SLmMoZSwxLG51bGwpLGNbSmgoZCldPUxoKGUpLGI9SyhiKSxkPW51bGwsZT0wKSxmPTA7ZWxzZSBicmVhaztyZXR1cm4gY31pZigkYyhiKSl7Yz1bXTtiPUQoT2UuYShMaCxiKSk7ZD1udWxsO2ZvcihmPWU9MDs7KWlmKGY8XG5lKWg9ZC5RKG51bGwsZiksYy5wdXNoKGgpLGYrPTE7ZWxzZSBpZihiPUQoYikpZD1iLGZkKGQpPyhiPVliKGQpLGY9WmIoZCksZD1iLGU9UShiKSxiPWYpOihiPUcoZCksYy5wdXNoKGIpLGI9SyhkKSxkPW51bGwsZT0wKSxmPTA7ZWxzZSBicmVhaztyZXR1cm4gY31yZXR1cm4gYn0sTWg9e307ZnVuY3Rpb24gTmgoYSxiKXtpZihhP2EuZWM6YSlyZXR1cm4gYS5lYyhhLGIpO3ZhciBjO2M9TmhbbihudWxsPT1hP251bGw6YSldO2lmKCFjJiYoYz1OaC5fLCFjKSl0aHJvdyB4KFwiSUVuY29kZUNsb2p1cmUuLWpzLVxceDNlY2xqXCIsYSk7cmV0dXJuIGMuY2FsbChudWxsLGEsYil9XG52YXIgUGg9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEpe3JldHVybiBiLmQoYSxLYyhbbmV3IHBhKG51bGwsMSxbT2gsITFdLG51bGwpXSwwKSl9dmFyIGI9bnVsbCxjPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShjLGQpe3ZhciBoPW51bGw7aWYoMTxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGg9MCxsPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMSk7aDxsLmxlbmd0aDspbFtoXT1hcmd1bWVudHNbaCsxXSwrK2g7aD1uZXcgRihsLDApfXJldHVybiBiLmNhbGwodGhpcyxjLGgpfWZ1bmN0aW9uIGIoYSxjKXt2YXIgZD1rZChjKT9ULmEoT2csYyk6YyxlPVMuYShkLE9oKTtyZXR1cm4gZnVuY3Rpb24oYSxiLGQsZSl7cmV0dXJuIGZ1bmN0aW9uIHYoZil7cmV0dXJuKGY/dCh0KG51bGwpP251bGw6Zi51Yyl8fChmLnliPzA6dyhNaCxmKSk6dyhNaCxmKSk/TmgoZixULmEoUGcsYykpOmtkKGYpP3ZoLmIoT2UuYSh2LGYpKTokYyhmKT9hZi5hKE9jKGYpLE9lLmEodixmKSk6ZiBpbnN0YW5jZW9mXG5BcnJheT96ZihPZS5hKHYsZikpOkJhKGYpPT09T2JqZWN0P2FmLmEoVWYsZnVuY3Rpb24oKXtyZXR1cm4gZnVuY3Rpb24oYSxiLGMsZCl7cmV0dXJuIGZ1bmN0aW9uIFBhKGUpe3JldHVybiBuZXcgVihudWxsLGZ1bmN0aW9uKGEsYixjLGQpe3JldHVybiBmdW5jdGlvbigpe2Zvcig7Oyl7dmFyIGE9RChlKTtpZihhKXtpZihmZChhKSl7dmFyIGI9WWIoYSksYz1RKGIpLGc9VGQoYyk7cmV0dXJuIGZ1bmN0aW9uKCl7Zm9yKHZhciBhPTA7OylpZihhPGMpe3ZhciBlPUMuYShiLGEpLGg9ZyxsPXVmLG07bT1lO209ZC5iP2QuYihtKTpkLmNhbGwobnVsbCxtKTtlPW5ldyBXKG51bGwsMiw1LGwsW20sdihmW2VdKV0sbnVsbCk7aC5hZGQoZSk7YSs9MX1lbHNlIHJldHVybiEwfSgpP1dkKGcuY2EoKSxQYShaYihhKSkpOldkKGcuY2EoKSxudWxsKX12YXIgaD1HKGEpO3JldHVybiBNKG5ldyBXKG51bGwsMiw1LHVmLFtmdW5jdGlvbigpe3ZhciBhPWg7cmV0dXJuIGQuYj9kLmIoYSk6ZC5jYWxsKG51bGwsXG5hKX0oKSx2KGZbaF0pXSxudWxsKSxQYShIKGEpKSl9cmV0dXJuIG51bGx9fX0oYSxiLGMsZCksbnVsbCxudWxsKX19KGEsYixkLGUpKGdkKGYpKX0oKSk6Zn19KGMsZCxlLHQoZSk/UGQ6eikoYSl9YS5pPTE7YS5mPWZ1bmN0aW9uKGEpe3ZhciBjPUcoYSk7YT1IKGEpO3JldHVybiBiKGMsYSl9O2EuZD1iO3JldHVybiBhfSgpLGI9ZnVuY3Rpb24oYixlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBhLmNhbGwodGhpcyxiKTtkZWZhdWx0OnZhciBmPW51bGw7aWYoMTxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGY9MCxnPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMSk7ZjxnLmxlbmd0aDspZ1tmXT1hcmd1bWVudHNbZisxXSwrK2Y7Zj1uZXcgRihnLDApfXJldHVybiBjLmQoYixmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yi5pPTE7Yi5mPWMuZjtiLmI9YTtiLmQ9Yy5kO3JldHVybiBifSgpO3ZhciB3YT1uZXcgVShudWxsLFwibWV0YVwiLFwibWV0YVwiLDE0OTk1MzY5NjQpLHlhPW5ldyBVKG51bGwsXCJkdXBcIixcImR1cFwiLDU1NjI5ODUzMyksc2g9bmV3IFUoXCJjbGpzLmNvcmVcIixcIm5vbmVcIixcImNsanMuY29yZS9ub25lXCIsOTI2NjQ2NDM5KSxwZT1uZXcgVShudWxsLFwiZmlsZVwiLFwiZmlsZVwiLC0xMjY5NjQ1ODc4KSxsZT1uZXcgVShudWxsLFwiZW5kLWNvbHVtblwiLFwiZW5kLWNvbHVtblwiLDE0MjUzODk1MTQpLHNhPW5ldyBVKG51bGwsXCJmbHVzaC1vbi1uZXdsaW5lXCIsXCJmbHVzaC1vbi1uZXdsaW5lXCIsLTE1MTQ1NzkzOSksbmU9bmV3IFUobnVsbCxcImNvbHVtblwiLFwiY29sdW1uXCIsMjA3ODIyMjA5NSksdWE9bmV3IFUobnVsbCxcInJlYWRhYmx5XCIsXCJyZWFkYWJseVwiLDExMjk1OTk3NjApLG9lPW5ldyBVKG51bGwsXCJsaW5lXCIsXCJsaW5lXCIsMjEyMzQ1MjM1KSx6YT1uZXcgVShudWxsLFwicHJpbnQtbGVuZ3RoXCIsXCJwcmludC1sZW5ndGhcIiwxOTMxODY2MzU2KSxtZT1uZXcgVShudWxsLFwiZW5kLWxpbmVcIixcblwiZW5kLWxpbmVcIiwxODM3MzI2NDU1KSxPaD1uZXcgVShudWxsLFwia2V5d29yZGl6ZS1rZXlzXCIsXCJrZXl3b3JkaXplLWtleXNcIiwxMzEwNzg0MjUyKSxaZz1uZXcgVShcImNsanMuY29yZVwiLFwibm90LWZvdW5kXCIsXCJjbGpzLmNvcmUvbm90LWZvdW5kXCIsLTE1NzI4ODkxODUpO2Z1bmN0aW9uIFFoKGEsYil7dmFyIGM9VC5jKGloLGEsYik7cmV0dXJuIE0oYyxZZS5hKGZ1bmN0aW9uKGEpe3JldHVybiBmdW5jdGlvbihiKXtyZXR1cm4gYT09PWJ9fShjKSxiKSl9XG52YXIgUmg9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYil7cmV0dXJuIFEoYSk8UShiKT9BLmMoTmMsYixhKTpBLmMoTmMsYSxiKX12YXIgYj1udWxsLGM9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGMsZCxoKXt2YXIgbD1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBsPTAsbT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2w8bS5sZW5ndGg7KW1bbF09YXJndW1lbnRzW2wrMl0sKytsO2w9bmV3IEYobSwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsYyxkLGwpfWZ1bmN0aW9uIGIoYSxjLGQpe2E9UWgoUSxOYy5kKGQsYyxLYyhbYV0sMCkpKTtyZXR1cm4gQS5jKGFmLEcoYSksSChhKSl9YS5pPTI7YS5mPWZ1bmN0aW9uKGEpe3ZhciBjPUcoYSk7YT1LKGEpO3ZhciBkPUcoYSk7YT1IKGEpO3JldHVybiBiKGMsZCxhKX07YS5kPWI7cmV0dXJuIGF9KCksYj1mdW5jdGlvbihiLGUsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMDpyZXR1cm4gYmg7Y2FzZSAxOnJldHVybiBiO1xuY2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxiLGUpO2RlZmF1bHQ6dmFyIGc9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZz0wLGg9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtnPGgubGVuZ3RoOyloW2ddPWFyZ3VtZW50c1tnKzJdLCsrZztnPW5ldyBGKGgsMCl9cmV0dXJuIGMuZChiLGUsZyl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2IuaT0yO2IuZj1jLmY7Yi5sPWZ1bmN0aW9uKCl7cmV0dXJuIGJofTtiLmI9ZnVuY3Rpb24oYSl7cmV0dXJuIGF9O2IuYT1hO2IuZD1jLmQ7cmV0dXJuIGJ9KCksU2g9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYil7Zm9yKDs7KWlmKFEoYik8UShhKSl7dmFyIGM9YTthPWI7Yj1jfWVsc2UgcmV0dXJuIEEuYyhmdW5jdGlvbihhLGIpe3JldHVybiBmdW5jdGlvbihhLGMpe3JldHVybiBuZChiLGMpP2E6WGMuYShhLGMpfX0oYSxiKSxhLGEpfXZhciBiPW51bGwsYz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYixcbmQsaCl7dmFyIGw9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgbD0wLG09QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtsPG0ubGVuZ3RoOyltW2xdPWFyZ3VtZW50c1tsKzJdLCsrbDtsPW5ldyBGKG0sMCl9cmV0dXJuIGMuY2FsbCh0aGlzLGIsZCxsKX1mdW5jdGlvbiBjKGEsZCxlKXthPVFoKGZ1bmN0aW9uKGEpe3JldHVybi1RKGEpfSxOYy5kKGUsZCxLYyhbYV0sMCkpKTtyZXR1cm4gQS5jKGIsRyhhKSxIKGEpKX1hLmk9MjthLmY9ZnVuY3Rpb24oYSl7dmFyIGI9RyhhKTthPUsoYSk7dmFyIGQ9RyhhKTthPUgoYSk7cmV0dXJuIGMoYixkLGEpfTthLmQ9YztyZXR1cm4gYX0oKSxiPWZ1bmN0aW9uKGIsZSxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYixlKTtkZWZhdWx0OnZhciBnPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGc9MCxoPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtXG4yKTtnPGgubGVuZ3RoOyloW2ddPWFyZ3VtZW50c1tnKzJdLCsrZztnPW5ldyBGKGgsMCl9cmV0dXJuIGMuZChiLGUsZyl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2IuaT0yO2IuZj1jLmY7Yi5iPWZ1bmN0aW9uKGEpe3JldHVybiBhfTtiLmE9YTtiLmQ9Yy5kO3JldHVybiBifSgpLFRoPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIpe3JldHVybiBRKGEpPFEoYik/QS5jKGZ1bmN0aW9uKGEsYyl7cmV0dXJuIG5kKGIsYyk/WGMuYShhLGMpOmF9LGEsYSk6QS5jKFhjLGEsYil9dmFyIGI9bnVsbCxjPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShiLGQsaCl7dmFyIGw9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgbD0wLG09QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtsPG0ubGVuZ3RoOyltW2xdPWFyZ3VtZW50c1tsKzJdLCsrbDtsPW5ldyBGKG0sMCl9cmV0dXJuIGMuY2FsbCh0aGlzLGIsZCxsKX1mdW5jdGlvbiBjKGEsZCxcbmUpe3JldHVybiBBLmMoYixhLE5jLmEoZSxkKSl9YS5pPTI7YS5mPWZ1bmN0aW9uKGEpe3ZhciBiPUcoYSk7YT1LKGEpO3ZhciBkPUcoYSk7YT1IKGEpO3JldHVybiBjKGIsZCxhKX07YS5kPWM7cmV0dXJuIGF9KCksYj1mdW5jdGlvbihiLGUsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYjtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGIsZSk7ZGVmYXVsdDp2YXIgZz1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBnPTAsaD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2c8aC5sZW5ndGg7KWhbZ109YXJndW1lbnRzW2crMl0sKytnO2c9bmV3IEYoaCwwKX1yZXR1cm4gYy5kKGIsZSxnKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yi5pPTI7Yi5mPWMuZjtiLmI9ZnVuY3Rpb24oYSl7cmV0dXJuIGF9O2IuYT1hO2IuZD1jLmQ7cmV0dXJuIGJ9KCk7XG5mdW5jdGlvbiBVaChhLGIpe3JldHVybiBBLmMoZnVuY3Rpb24oYixkKXt2YXIgZT1SLmMoZCwwLG51bGwpLGY9Ui5jKGQsMSxudWxsKTtyZXR1cm4gbmQoYSxlKT9SYy5jKGIsZixTLmEoYSxlKSk6Yn0sVC5jKFNjLGEsVGcoYikpLGIpfWZ1bmN0aW9uIFZoKGEsYil7cmV0dXJuIEEuYyhmdW5jdGlvbihhLGQpe3ZhciBlPVlnKGQsYik7cmV0dXJuIFJjLmMoYSxlLE5jLmEoUy5jKGEsZSxiaCksZCkpfSxVZixhKX1mdW5jdGlvbiBXaChhKXtyZXR1cm4gQS5jKGZ1bmN0aW9uKGEsYyl7dmFyIGQ9Ui5jKGMsMCxudWxsKSxlPVIuYyhjLDEsbnVsbCk7cmV0dXJuIFJjLmMoYSxlLGQpfSxVZixhKX1cbnZhciBYaD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMpe2E9UShhKTw9UShiKT9uZXcgVyhudWxsLDMsNSx1ZixbYSxiLFdoKGMpXSxudWxsKTpuZXcgVyhudWxsLDMsNSx1ZixbYixhLGNdLG51bGwpO2I9Ui5jKGEsMCxudWxsKTtjPVIuYyhhLDEsbnVsbCk7dmFyIGc9Ui5jKGEsMixudWxsKSxoPVZoKGIsVmcoZykpO3JldHVybiBBLmMoZnVuY3Rpb24oYSxiLGMsZCxlKXtyZXR1cm4gZnVuY3Rpb24oZixnKXt2YXIgaD1mdW5jdGlvbigpe3ZhciBhPVVoKFlnKGcsVGcoZCkpLGQpO3JldHVybiBlLmI/ZS5iKGEpOmUuY2FsbChudWxsLGEpfSgpO3JldHVybiB0KGgpP0EuYyhmdW5jdGlvbigpe3JldHVybiBmdW5jdGlvbihhLGIpe3JldHVybiBOYy5hKGEsV2cuZChLYyhbYixnXSwwKSkpfX0oaCxhLGIsYyxkLGUpLGYsaCk6Zn19KGEsYixjLGcsaCksYmgsYyl9ZnVuY3Rpb24gYihhLGIpe2lmKEQoYSkmJkQoYikpe3ZhciBjPVNoLmEoZmgoVGcoRyhhKSkpLGZoKFRnKEcoYikpKSksXG5nPVEoYSk8PVEoYik/bmV3IFcobnVsbCwyLDUsdWYsW2EsYl0sbnVsbCk6bmV3IFcobnVsbCwyLDUsdWYsW2IsYV0sbnVsbCksaD1SLmMoZywwLG51bGwpLGw9Ui5jKGcsMSxudWxsKSxtPVZoKGgsYyk7cmV0dXJuIEEuYyhmdW5jdGlvbihhLGIsYyxkLGUpe3JldHVybiBmdW5jdGlvbihmLGcpe3ZhciBoPWZ1bmN0aW9uKCl7dmFyIGI9WWcoZyxhKTtyZXR1cm4gZS5iP2UuYihiKTplLmNhbGwobnVsbCxiKX0oKTtyZXR1cm4gdChoKT9BLmMoZnVuY3Rpb24oKXtyZXR1cm4gZnVuY3Rpb24oYSxiKXtyZXR1cm4gTmMuYShhLFdnLmQoS2MoW2IsZ10sMCkpKX19KGgsYSxiLGMsZCxlKSxmLGgpOmZ9fShjLGcsaCxsLG0pLGJoLGwpfXJldHVybiBiaH12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIGIuY2FsbCh0aGlzLGMsZSk7Y2FzZSAzOnJldHVybiBhLmNhbGwodGhpcyxjLGUsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIitcbmFyZ3VtZW50cy5sZW5ndGgpO307Yy5hPWI7Yy5jPWE7cmV0dXJuIGN9KCk7cihcIm1vcmkuYXBwbHlcIixUKTtyKFwibW9yaS5hcHBseS5mMlwiLFQuYSk7cihcIm1vcmkuYXBwbHkuZjNcIixULmMpO3IoXCJtb3JpLmFwcGx5LmY0XCIsVC5uKTtyKFwibW9yaS5hcHBseS5mNVwiLFQucik7cihcIm1vcmkuYXBwbHkuZm5cIixULkspO3IoXCJtb3JpLmNvdW50XCIsUSk7cihcIm1vcmkuZGlzdGluY3RcIixmdW5jdGlvbihhKXtyZXR1cm4gZnVuY3Rpb24gYyhhLGUpe3JldHVybiBuZXcgVihudWxsLGZ1bmN0aW9uKCl7cmV0dXJuIGZ1bmN0aW9uKGEsZCl7Zm9yKDs7KXt2YXIgZT1hLGw9Ui5jKGUsMCxudWxsKTtpZihlPUQoZSkpaWYobmQoZCxsKSlsPUgoZSksZT1kLGE9bCxkPWU7ZWxzZSByZXR1cm4gTShsLGMoSChlKSxOYy5hKGQsbCkpKTtlbHNlIHJldHVybiBudWxsfX0uY2FsbChudWxsLGEsZSl9LG51bGwsbnVsbCl9KGEsYmgpfSk7cihcIm1vcmkuZW1wdHlcIixPYyk7cihcIm1vcmkuZmlyc3RcIixHKTtyKFwibW9yaS5zZWNvbmRcIixMYyk7cihcIm1vcmkubmV4dFwiLEspO1xucihcIm1vcmkucmVzdFwiLEgpO3IoXCJtb3JpLnNlcVwiLEQpO3IoXCJtb3JpLmNvbmpcIixOYyk7cihcIm1vcmkuY29uai5mMFwiLE5jLmwpO3IoXCJtb3JpLmNvbmouZjFcIixOYy5iKTtyKFwibW9yaS5jb25qLmYyXCIsTmMuYSk7cihcIm1vcmkuY29uai5mblwiLE5jLkspO3IoXCJtb3JpLmNvbnNcIixNKTtyKFwibW9yaS5maW5kXCIsZnVuY3Rpb24oYSxiKXtyZXR1cm4gbnVsbCE9YSYmYmQoYSkmJm5kKGEsYik/bmV3IFcobnVsbCwyLDUsdWYsW2IsUy5hKGEsYildLG51bGwpOm51bGx9KTtyKFwibW9yaS5udGhcIixSKTtyKFwibW9yaS5udGguZjJcIixSLmEpO3IoXCJtb3JpLm50aC5mM1wiLFIuYyk7cihcIm1vcmkubGFzdFwiLGZ1bmN0aW9uKGEpe2Zvcig7Oyl7dmFyIGI9SyhhKTtpZihudWxsIT1iKWE9YjtlbHNlIHJldHVybiBHKGEpfX0pO3IoXCJtb3JpLmFzc29jXCIsUmMpO3IoXCJtb3JpLmFzc29jLmYzXCIsUmMuYyk7cihcIm1vcmkuYXNzb2MuZm5cIixSYy5LKTtyKFwibW9yaS5kaXNzb2NcIixTYyk7XG5yKFwibW9yaS5kaXNzb2MuZjFcIixTYy5iKTtyKFwibW9yaS5kaXNzb2MuZjJcIixTYy5hKTtyKFwibW9yaS5kaXNzb2MuZm5cIixTYy5LKTtyKFwibW9yaS5nZXRJblwiLGNmKTtyKFwibW9yaS5nZXRJbi5mMlwiLGNmLmEpO3IoXCJtb3JpLmdldEluLmYzXCIsY2YuYyk7cihcIm1vcmkudXBkYXRlSW5cIixkZik7cihcIm1vcmkudXBkYXRlSW4uZjNcIixkZi5jKTtyKFwibW9yaS51cGRhdGVJbi5mNFwiLGRmLm4pO3IoXCJtb3JpLnVwZGF0ZUluLmY1XCIsZGYucik7cihcIm1vcmkudXBkYXRlSW4uZjZcIixkZi5QKTtyKFwibW9yaS51cGRhdGVJbi5mblwiLGRmLkspO3IoXCJtb3JpLmFzc29jSW5cIixmdW5jdGlvbiBZaChiLGMsZCl7dmFyIGU9Ui5jKGMsMCxudWxsKTtyZXR1cm4oYz1FZChjKSk/UmMuYyhiLGUsWWgoUy5hKGIsZSksYyxkKSk6UmMuYyhiLGUsZCl9KTtyKFwibW9yaS5mbmlsXCIsS2UpO3IoXCJtb3JpLmZuaWwuZjJcIixLZS5hKTtyKFwibW9yaS5mbmlsLmYzXCIsS2UuYyk7cihcIm1vcmkuZm5pbC5mNFwiLEtlLm4pO1xucihcIm1vcmkuZGlzalwiLFhjKTtyKFwibW9yaS5kaXNqLmYxXCIsWGMuYik7cihcIm1vcmkuZGlzai5mMlwiLFhjLmEpO3IoXCJtb3JpLmRpc2ouZm5cIixYYy5LKTtyKFwibW9yaS5wb3BcIixmdW5jdGlvbihhKXtyZXR1cm4gbnVsbD09YT9udWxsOm1iKGEpfSk7cihcIm1vcmkucGVla1wiLFdjKTtyKFwibW9yaS5oYXNoXCIsbmMpO3IoXCJtb3JpLmdldFwiLFMpO3IoXCJtb3JpLmdldC5mMlwiLFMuYSk7cihcIm1vcmkuZ2V0LmYzXCIsUy5jKTtyKFwibW9yaS5oYXNLZXlcIixuZCk7cihcIm1vcmkuaXNFbXB0eVwiLFljKTtyKFwibW9yaS5yZXZlcnNlXCIsSmQpO3IoXCJtb3JpLnRha2VcIixQZSk7cihcIm1vcmkudGFrZS5mMVwiLFBlLmIpO3IoXCJtb3JpLnRha2UuZjJcIixQZS5hKTtyKFwibW9yaS5kcm9wXCIsUWUpO3IoXCJtb3JpLmRyb3AuZjFcIixRZS5iKTtyKFwibW9yaS5kcm9wLmYyXCIsUWUuYSk7cihcIm1vcmkudGFrZU50aFwiLHJoKTtyKFwibW9yaS50YWtlTnRoLmYxXCIscmguYik7cihcIm1vcmkudGFrZU50aC5mMlwiLHJoLmEpO1xucihcIm1vcmkucGFydGl0aW9uXCIsYmYpO3IoXCJtb3JpLnBhcnRpdGlvbi5mMlwiLGJmLmEpO3IoXCJtb3JpLnBhcnRpdGlvbi5mM1wiLGJmLmMpO3IoXCJtb3JpLnBhcnRpdGlvbi5mNFwiLGJmLm4pO3IoXCJtb3JpLnBhcnRpdGlvbkFsbFwiLGtoKTtyKFwibW9yaS5wYXJ0aXRpb25BbGwuZjFcIixraC5iKTtyKFwibW9yaS5wYXJ0aXRpb25BbGwuZjJcIixraC5hKTtyKFwibW9yaS5wYXJ0aXRpb25BbGwuZjNcIixraC5jKTtyKFwibW9yaS5wYXJ0aXRpb25CeVwiLHRoKTtyKFwibW9yaS5wYXJ0aXRpb25CeS5mMVwiLHRoLmIpO3IoXCJtb3JpLnBhcnRpdGlvbkJ5LmYyXCIsdGguYSk7cihcIm1vcmkuaXRlcmF0ZVwiLGZ1bmN0aW9uIFpoKGIsYyl7cmV0dXJuIE0oYyxuZXcgVihudWxsLGZ1bmN0aW9uKCl7cmV0dXJuIFpoKGIsYi5iP2IuYihjKTpiLmNhbGwobnVsbCxjKSl9LG51bGwsbnVsbCkpfSk7cihcIm1vcmkuaW50b1wiLGFmKTtyKFwibW9yaS5pbnRvLmYyXCIsYWYuYSk7cihcIm1vcmkuaW50by5mM1wiLGFmLmMpO1xucihcIm1vcmkubWVyZ2VcIixXZyk7cihcIm1vcmkubWVyZ2VXaXRoXCIsWGcpO3IoXCJtb3JpLnN1YnZlY1wiLENmKTtyKFwibW9yaS5zdWJ2ZWMuZjJcIixDZi5hKTtyKFwibW9yaS5zdWJ2ZWMuZjNcIixDZi5jKTtyKFwibW9yaS50YWtlV2hpbGVcIixsaCk7cihcIm1vcmkudGFrZVdoaWxlLmYxXCIsbGguYik7cihcIm1vcmkudGFrZVdoaWxlLmYyXCIsbGguYSk7cihcIm1vcmkuZHJvcFdoaWxlXCIsUmUpO3IoXCJtb3JpLmRyb3BXaGlsZS5mMVwiLFJlLmIpO3IoXCJtb3JpLmRyb3BXaGlsZS5mMlwiLFJlLmEpO3IoXCJtb3JpLmdyb3VwQnlcIixmdW5jdGlvbihhLGIpe3JldHVybiBjZShBLmMoZnVuY3Rpb24oYixkKXt2YXIgZT1hLmI/YS5iKGQpOmEuY2FsbChudWxsLGQpO3JldHVybiBlZS5jKGIsZSxOYy5hKFMuYyhiLGUsTWMpLGQpKX0sT2IoVWYpLGIpKX0pO3IoXCJtb3JpLmludGVycG9zZVwiLGZ1bmN0aW9uKGEsYil7cmV0dXJuIFFlLmEoMSxVZS5hKFNlLmIoYSksYikpfSk7cihcIm1vcmkuaW50ZXJsZWF2ZVwiLFVlKTtcbnIoXCJtb3JpLmludGVybGVhdmUuZjJcIixVZS5hKTtyKFwibW9yaS5pbnRlcmxlYXZlLmZuXCIsVWUuSyk7cihcIm1vcmkuY29uY2F0XCIsYWUpO3IoXCJtb3JpLmNvbmNhdC5mMFwiLGFlLmwpO3IoXCJtb3JpLmNvbmNhdC5mMVwiLGFlLmIpO3IoXCJtb3JpLmNvbmNhdC5mMlwiLGFlLmEpO3IoXCJtb3JpLmNvbmNhdC5mblwiLGFlLkspO2Z1bmN0aW9uICRlKGEpe3JldHVybiBhIGluc3RhbmNlb2YgQXJyYXl8fGNkKGEpfXIoXCJtb3JpLmZsYXR0ZW5cIixmdW5jdGlvbihhKXtyZXR1cm4gWGUuYShmdW5jdGlvbihhKXtyZXR1cm4hJGUoYSl9LEgoWmUoYSkpKX0pO3IoXCJtb3JpLmxhenlTZXFcIixmdW5jdGlvbihhKXtyZXR1cm4gbmV3IFYobnVsbCxhLG51bGwsbnVsbCl9KTtyKFwibW9yaS5rZXlzXCIsVGcpO3IoXCJtb3JpLnNlbGVjdEtleXNcIixZZyk7cihcIm1vcmkudmFsc1wiLFZnKTtyKFwibW9yaS5wcmltU2VxXCIsSmMpO3IoXCJtb3JpLnByaW1TZXEuZjFcIixKYy5iKTtyKFwibW9yaS5wcmltU2VxLmYyXCIsSmMuYSk7XG5yKFwibW9yaS5tYXBcIixPZSk7cihcIm1vcmkubWFwLmYxXCIsT2UuYik7cihcIm1vcmkubWFwLmYyXCIsT2UuYSk7cihcIm1vcmkubWFwLmYzXCIsT2UuYyk7cihcIm1vcmkubWFwLmY0XCIsT2Uubik7cihcIm1vcmkubWFwLmZuXCIsT2UuSyk7XG5yKFwibW9yaS5tYXBJbmRleGVkXCIsZnVuY3Rpb24oYSxiKXtyZXR1cm4gZnVuY3Rpb24gZChiLGYpe3JldHVybiBuZXcgVihudWxsLGZ1bmN0aW9uKCl7dmFyIGc9RChmKTtpZihnKXtpZihmZChnKSl7Zm9yKHZhciBoPVliKGcpLGw9UShoKSxtPVRkKGwpLHA9MDs7KWlmKHA8bClYZChtLGZ1bmN0aW9uKCl7dmFyIGQ9YitwLGY9Qy5hKGgscCk7cmV0dXJuIGEuYT9hLmEoZCxmKTphLmNhbGwobnVsbCxkLGYpfSgpKSxwKz0xO2Vsc2UgYnJlYWs7cmV0dXJuIFdkKG0uY2EoKSxkKGIrbCxaYihnKSkpfXJldHVybiBNKGZ1bmN0aW9uKCl7dmFyIGQ9RyhnKTtyZXR1cm4gYS5hP2EuYShiLGQpOmEuY2FsbChudWxsLGIsZCl9KCksZChiKzEsSChnKSkpfXJldHVybiBudWxsfSxudWxsLG51bGwpfSgwLGIpfSk7cihcIm1vcmkubWFwY2F0XCIsV2UpO3IoXCJtb3JpLm1hcGNhdC5mMVwiLFdlLmIpO3IoXCJtb3JpLm1hcGNhdC5mblwiLFdlLkspO3IoXCJtb3JpLnJlZHVjZVwiLEEpO1xucihcIm1vcmkucmVkdWNlLmYyXCIsQS5hKTtyKFwibW9yaS5yZWR1Y2UuZjNcIixBLmMpO3IoXCJtb3JpLnJlZHVjZUtWXCIsZnVuY3Rpb24oYSxiLGMpe3JldHVybiBudWxsIT1jP3hiKGMsYSxiKTpifSk7cihcIm1vcmkua2VlcFwiLExlKTtyKFwibW9yaS5rZWVwLmYxXCIsTGUuYik7cihcIm1vcmkua2VlcC5mMlwiLExlLmEpO3IoXCJtb3JpLmtlZXBJbmRleGVkXCIsTmUpO3IoXCJtb3JpLmtlZXBJbmRleGVkLmYxXCIsTmUuYik7cihcIm1vcmkua2VlcEluZGV4ZWQuZjJcIixOZS5hKTtyKFwibW9yaS5maWx0ZXJcIixYZSk7cihcIm1vcmkuZmlsdGVyLmYxXCIsWGUuYik7cihcIm1vcmkuZmlsdGVyLmYyXCIsWGUuYSk7cihcIm1vcmkucmVtb3ZlXCIsWWUpO3IoXCJtb3JpLnJlbW92ZS5mMVwiLFllLmIpO3IoXCJtb3JpLnJlbW92ZS5mMlwiLFllLmEpO3IoXCJtb3JpLnNvbWVcIixGZSk7cihcIm1vcmkuZXZlcnlcIixFZSk7cihcIm1vcmkuZXF1YWxzXCIsc2MpO3IoXCJtb3JpLmVxdWFscy5mMVwiLHNjLmIpO1xucihcIm1vcmkuZXF1YWxzLmYyXCIsc2MuYSk7cihcIm1vcmkuZXF1YWxzLmZuXCIsc2MuSyk7cihcIm1vcmkucmFuZ2VcIixxaCk7cihcIm1vcmkucmFuZ2UuZjBcIixxaC5sKTtyKFwibW9yaS5yYW5nZS5mMVwiLHFoLmIpO3IoXCJtb3JpLnJhbmdlLmYyXCIscWguYSk7cihcIm1vcmkucmFuZ2UuZjNcIixxaC5jKTtyKFwibW9yaS5yZXBlYXRcIixTZSk7cihcIm1vcmkucmVwZWF0LmYxXCIsU2UuYik7cihcIm1vcmkucmVwZWF0LmYyXCIsU2UuYSk7cihcIm1vcmkucmVwZWF0ZWRseVwiLFRlKTtyKFwibW9yaS5yZXBlYXRlZGx5LmYxXCIsVGUuYik7cihcIm1vcmkucmVwZWF0ZWRseS5mMlwiLFRlLmEpO3IoXCJtb3JpLnNvcnRcIixzZCk7cihcIm1vcmkuc29ydC5mMVwiLHNkLmIpO3IoXCJtb3JpLnNvcnQuZjJcIixzZC5hKTtyKFwibW9yaS5zb3J0QnlcIix0ZCk7cihcIm1vcmkuc29ydEJ5LmYyXCIsdGQuYSk7cihcIm1vcmkuc29ydEJ5LmYzXCIsdGQuYyk7cihcIm1vcmkuaW50b0FycmF5XCIsSWEpO3IoXCJtb3JpLmludG9BcnJheS5mMVwiLElhLmIpO1xucihcIm1vcmkuaW50b0FycmF5LmYyXCIsSWEuYSk7cihcIm1vcmkuc3Vic2VxXCIsbmgpO3IoXCJtb3JpLnN1YnNlcS5mM1wiLG5oLmMpO3IoXCJtb3JpLnN1YnNlcS5mNVwiLG5oLnIpO3IoXCJtb3JpLmRlZHVwZVwiLEZoKTtyKFwibW9yaS5kZWR1cGUuZjBcIixGaC5sKTtyKFwibW9yaS5kZWR1cGUuZjFcIixGaC5iKTtyKFwibW9yaS50cmFuc2R1Y2VcIix3ZCk7cihcIm1vcmkudHJhbnNkdWNlLmYzXCIsd2QuYyk7cihcIm1vcmkudHJhbnNkdWNlLmY0XCIsd2Qubik7cihcIm1vcmkuZWR1Y3Rpb25cIixmdW5jdGlvbihhLGIpe3JldHVybiBuZXcgR2goYSxiKX0pO3IoXCJtb3JpLnNlcXVlbmNlXCIsQ2UpO3IoXCJtb3JpLnNlcXVlbmNlLmYxXCIsQ2UuYik7cihcIm1vcmkuc2VxdWVuY2UuZjJcIixDZS5hKTtyKFwibW9yaS5zZXF1ZW5jZS5mblwiLENlLkspO3IoXCJtb3JpLmNvbXBsZXRpbmdcIix2ZCk7cihcIm1vcmkuY29tcGxldGluZy5mMVwiLHZkLmIpO3IoXCJtb3JpLmNvbXBsZXRpbmcuZjJcIix2ZC5hKTtyKFwibW9yaS5saXN0XCIsS2QpO1xucihcIm1vcmkudmVjdG9yXCIsQWYpO3IoXCJtb3JpLmhhc2hNYXBcIixQZyk7cihcIm1vcmkuc2V0XCIsZmgpO3IoXCJtb3JpLnNvcnRlZFNldFwiLGdoKTtyKFwibW9yaS5zb3J0ZWRTZXRCeVwiLGhoKTtyKFwibW9yaS5zb3J0ZWRNYXBcIixRZyk7cihcIm1vcmkuc29ydGVkTWFwQnlcIixSZyk7cihcIm1vcmkucXVldWVcIixmdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSl7dmFyIGQ9bnVsbDtpZigwPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZD0wLGU9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0wKTtkPGUubGVuZ3RoOyllW2RdPWFyZ3VtZW50c1tkKzBdLCsrZDtkPW5ldyBGKGUsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGQpfWZ1bmN0aW9uIGIoYSl7cmV0dXJuIGFmLmE/YWYuYShNZixhKTphZi5jYWxsKG51bGwsTWYsYSl9YS5pPTA7YS5mPWZ1bmN0aW9uKGEpe2E9RChhKTtyZXR1cm4gYihhKX07YS5kPWI7cmV0dXJuIGF9KCkpO3IoXCJtb3JpLmtleXdvcmRcIixQZCk7cihcIm1vcmkua2V5d29yZC5mMVwiLFBkLmIpO1xucihcIm1vcmkua2V5d29yZC5mMlwiLFBkLmEpO3IoXCJtb3JpLnN5bWJvbFwiLHJjKTtyKFwibW9yaS5zeW1ib2wuZjFcIixyYy5iKTtyKFwibW9yaS5zeW1ib2wuZjJcIixyYy5hKTtyKFwibW9yaS56aXBtYXBcIixmdW5jdGlvbihhLGIpe2Zvcih2YXIgYz1PYihVZiksZD1EKGEpLGU9RChiKTs7KWlmKGQmJmUpYz1lZS5jKGMsRyhkKSxHKGUpKSxkPUsoZCksZT1LKGUpO2Vsc2UgcmV0dXJuIFFiKGMpfSk7cihcIm1vcmkuaXNMaXN0XCIsZnVuY3Rpb24oYSl7cmV0dXJuIGE/YS5qJjMzNTU0NDMyfHxhLndjPyEwOmEuaj8hMTp3KEViLGEpOncoRWIsYSl9KTtyKFwibW9yaS5pc1NlcVwiLGtkKTtyKFwibW9yaS5pc1ZlY3RvclwiLGVkKTtyKFwibW9yaS5pc01hcFwiLGRkKTtyKFwibW9yaS5pc1NldFwiLGFkKTtyKFwibW9yaS5pc0tleXdvcmRcIixmdW5jdGlvbihhKXtyZXR1cm4gYSBpbnN0YW5jZW9mIFV9KTtyKFwibW9yaS5pc1N5bWJvbFwiLGZ1bmN0aW9uKGEpe3JldHVybiBhIGluc3RhbmNlb2YgcWN9KTtcbnIoXCJtb3JpLmlzQ29sbGVjdGlvblwiLCRjKTtyKFwibW9yaS5pc1NlcXVlbnRpYWxcIixjZCk7cihcIm1vcmkuaXNBc3NvY2lhdGl2ZVwiLGJkKTtyKFwibW9yaS5pc0NvdW50ZWRcIixFYyk7cihcIm1vcmkuaXNJbmRleGVkXCIsRmMpO3IoXCJtb3JpLmlzUmVkdWNlYWJsZVwiLGZ1bmN0aW9uKGEpe3JldHVybiBhP2EuaiY1MjQyODh8fGEuU2I/ITA6YS5qPyExOncodmIsYSk6dyh2YixhKX0pO3IoXCJtb3JpLmlzU2VxYWJsZVwiLGxkKTtyKFwibW9yaS5pc1JldmVyc2libGVcIixJZCk7cihcIm1vcmkudW5pb25cIixSaCk7cihcIm1vcmkudW5pb24uZjBcIixSaC5sKTtyKFwibW9yaS51bmlvbi5mMVwiLFJoLmIpO3IoXCJtb3JpLnVuaW9uLmYyXCIsUmguYSk7cihcIm1vcmkudW5pb24uZm5cIixSaC5LKTtyKFwibW9yaS5pbnRlcnNlY3Rpb25cIixTaCk7cihcIm1vcmkuaW50ZXJzZWN0aW9uLmYxXCIsU2guYik7cihcIm1vcmkuaW50ZXJzZWN0aW9uLmYyXCIsU2guYSk7cihcIm1vcmkuaW50ZXJzZWN0aW9uLmZuXCIsU2guSyk7XG5yKFwibW9yaS5kaWZmZXJlbmNlXCIsVGgpO3IoXCJtb3JpLmRpZmZlcmVuY2UuZjFcIixUaC5iKTtyKFwibW9yaS5kaWZmZXJlbmNlLmYyXCIsVGguYSk7cihcIm1vcmkuZGlmZmVyZW5jZS5mblwiLFRoLkspO3IoXCJtb3JpLmpvaW5cIixYaCk7cihcIm1vcmkuam9pbi5mMlwiLFhoLmEpO3IoXCJtb3JpLmpvaW4uZjNcIixYaC5jKTtyKFwibW9yaS5pbmRleFwiLFZoKTtyKFwibW9yaS5wcm9qZWN0XCIsZnVuY3Rpb24oYSxiKXtyZXR1cm4gZmgoT2UuYShmdW5jdGlvbihhKXtyZXR1cm4gWWcoYSxiKX0sYSkpfSk7cihcIm1vcmkubWFwSW52ZXJ0XCIsV2gpO3IoXCJtb3JpLnJlbmFtZVwiLGZ1bmN0aW9uKGEsYil7cmV0dXJuIGZoKE9lLmEoZnVuY3Rpb24oYSl7cmV0dXJuIFVoKGEsYil9LGEpKX0pO3IoXCJtb3JpLnJlbmFtZUtleXNcIixVaCk7cihcIm1vcmkuaXNTdWJzZXRcIixmdW5jdGlvbihhLGIpe3JldHVybiBRKGEpPD1RKGIpJiZFZShmdW5jdGlvbihhKXtyZXR1cm4gbmQoYixhKX0sYSl9KTtcbnIoXCJtb3JpLmlzU3VwZXJzZXRcIixmdW5jdGlvbihhLGIpe3JldHVybiBRKGEpPj1RKGIpJiZFZShmdW5jdGlvbihiKXtyZXR1cm4gbmQoYSxiKX0sYil9KTtyKFwibW9yaS5ub3RFcXVhbHNcIixqZSk7cihcIm1vcmkubm90RXF1YWxzLmYxXCIsamUuYik7cihcIm1vcmkubm90RXF1YWxzLmYyXCIsamUuYSk7cihcIm1vcmkubm90RXF1YWxzLmZuXCIsamUuSyk7cihcIm1vcmkuZ3RcIixBZCk7cihcIm1vcmkuZ3QuZjFcIixBZC5iKTtyKFwibW9yaS5ndC5mMlwiLEFkLmEpO3IoXCJtb3JpLmd0LmZuXCIsQWQuSyk7cihcIm1vcmkuZ3RlXCIsQmQpO3IoXCJtb3JpLmd0ZS5mMVwiLEJkLmIpO3IoXCJtb3JpLmd0ZS5mMlwiLEJkLmEpO3IoXCJtb3JpLmd0ZS5mblwiLEJkLkspO3IoXCJtb3JpLmx0XCIseWQpO3IoXCJtb3JpLmx0LmYxXCIseWQuYik7cihcIm1vcmkubHQuZjJcIix5ZC5hKTtyKFwibW9yaS5sdC5mblwiLHlkLkspO3IoXCJtb3JpLmx0ZVwiLHpkKTtyKFwibW9yaS5sdGUuZjFcIix6ZC5iKTtyKFwibW9yaS5sdGUuZjJcIix6ZC5hKTtcbnIoXCJtb3JpLmx0ZS5mblwiLHpkLkspO3IoXCJtb3JpLmNvbXBhcmVcIixvZCk7cihcIm1vcmkucGFydGlhbFwiLEplKTtyKFwibW9yaS5wYXJ0aWFsLmYxXCIsSmUuYik7cihcIm1vcmkucGFydGlhbC5mMlwiLEplLmEpO3IoXCJtb3JpLnBhcnRpYWwuZjNcIixKZS5jKTtyKFwibW9yaS5wYXJ0aWFsLmY0XCIsSmUubik7cihcIm1vcmkucGFydGlhbC5mblwiLEplLkspO3IoXCJtb3JpLmNvbXBcIixJZSk7cihcIm1vcmkuY29tcC5mMFwiLEllLmwpO3IoXCJtb3JpLmNvbXAuZjFcIixJZS5iKTtyKFwibW9yaS5jb21wLmYyXCIsSWUuYSk7cihcIm1vcmkuY29tcC5mM1wiLEllLmMpO3IoXCJtb3JpLmNvbXAuZm5cIixJZS5LKTtcbnIoXCJtb3JpLnBpcGVsaW5lXCIsZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEpe3ZhciBkPW51bGw7aWYoMDxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGQ9MCxlPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMCk7ZDxlLmxlbmd0aDspZVtkXT1hcmd1bWVudHNbZCswXSwrK2Q7ZD1uZXcgRihlLDApfXJldHVybiBiLmNhbGwodGhpcyxkKX1mdW5jdGlvbiBiKGEpe2Z1bmN0aW9uIGIoYSxjKXtyZXR1cm4gYy5iP2MuYihhKTpjLmNhbGwobnVsbCxhKX1yZXR1cm4gQS5hP0EuYShiLGEpOkEuY2FsbChudWxsLGIsYSl9YS5pPTA7YS5mPWZ1bmN0aW9uKGEpe2E9RChhKTtyZXR1cm4gYihhKX07YS5kPWI7cmV0dXJuIGF9KCkpO1xucihcIm1vcmkuY3VycnlcIixmdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxkKXt2YXIgZT1udWxsO2lmKDE8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBlPTAsZj1BcnJheShhcmd1bWVudHMubGVuZ3RoLTEpO2U8Zi5sZW5ndGg7KWZbZV09YXJndW1lbnRzW2UrMV0sKytlO2U9bmV3IEYoZiwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsYSxlKX1mdW5jdGlvbiBiKGEsYil7cmV0dXJuIGZ1bmN0aW9uKGUpe3JldHVybiBULmEoYSxNLmE/TS5hKGUsYik6TS5jYWxsKG51bGwsZSxiKSl9fWEuaT0xO2EuZj1mdW5jdGlvbihhKXt2YXIgZD1HKGEpO2E9SChhKTtyZXR1cm4gYihkLGEpfTthLmQ9YjtyZXR1cm4gYX0oKSk7XG5yKFwibW9yaS5qdXh0XCIsZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEpe3ZhciBkPW51bGw7aWYoMDxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGQ9MCxlPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMCk7ZDxlLmxlbmd0aDspZVtkXT1hcmd1bWVudHNbZCswXSwrK2Q7ZD1uZXcgRihlLDApfXJldHVybiBiLmNhbGwodGhpcyxkKX1mdW5jdGlvbiBiKGEpe3JldHVybiBmdW5jdGlvbigpe2Z1bmN0aW9uIGIoYSl7dmFyIGM9bnVsbDtpZigwPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgYz0wLGQ9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0wKTtjPGQubGVuZ3RoOylkW2NdPWFyZ3VtZW50c1tjKzBdLCsrYztjPW5ldyBGKGQsMCl9cmV0dXJuIGUuY2FsbCh0aGlzLGMpfWZ1bmN0aW9uIGUoYil7dmFyIGQ9ZnVuY3Rpb24oKXtmdW5jdGlvbiBkKGEpe3JldHVybiBULmEoYSxiKX1yZXR1cm4gT2UuYT9PZS5hKGQsYSk6T2UuY2FsbChudWxsLGQsYSl9KCk7cmV0dXJuIElhLmI/SWEuYihkKTpJYS5jYWxsKG51bGwsXG5kKX1iLmk9MDtiLmY9ZnVuY3Rpb24oYSl7YT1EKGEpO3JldHVybiBlKGEpfTtiLmQ9ZTtyZXR1cm4gYn0oKX1hLmk9MDthLmY9ZnVuY3Rpb24oYSl7YT1EKGEpO3JldHVybiBiKGEpfTthLmQ9YjtyZXR1cm4gYX0oKSk7XG5yKFwibW9yaS5rbml0XCIsZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEpe3ZhciBkPW51bGw7aWYoMDxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGQ9MCxlPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMCk7ZDxlLmxlbmd0aDspZVtkXT1hcmd1bWVudHNbZCswXSwrK2Q7ZD1uZXcgRihlLDApfXJldHVybiBiLmNhbGwodGhpcyxkKX1mdW5jdGlvbiBiKGEpe3JldHVybiBmdW5jdGlvbihiKXt2YXIgZT1mdW5jdGlvbigpe2Z1bmN0aW9uIGUoYSxiKXtyZXR1cm4gYS5iP2EuYihiKTphLmNhbGwobnVsbCxiKX1yZXR1cm4gT2UuYz9PZS5jKGUsYSxiKTpPZS5jYWxsKG51bGwsZSxhLGIpfSgpO3JldHVybiBJYS5iP0lhLmIoZSk6SWEuY2FsbChudWxsLGUpfX1hLmk9MDthLmY9ZnVuY3Rpb24oYSl7YT1EKGEpO3JldHVybiBiKGEpfTthLmQ9YjtyZXR1cm4gYX0oKSk7cihcIm1vcmkuc3VtXCIseGQpO3IoXCJtb3JpLnN1bS5mMFwiLHhkLmwpO3IoXCJtb3JpLnN1bS5mMVwiLHhkLmIpO1xucihcIm1vcmkuc3VtLmYyXCIseGQuYSk7cihcIm1vcmkuc3VtLmZuXCIseGQuSyk7cihcIm1vcmkuaW5jXCIsZnVuY3Rpb24oYSl7cmV0dXJuIGErMX0pO3IoXCJtb3JpLmRlY1wiLGZ1bmN0aW9uKGEpe3JldHVybiBhLTF9KTtyKFwibW9yaS5pc0V2ZW5cIixHZSk7cihcIm1vcmkuaXNPZGRcIixmdW5jdGlvbihhKXtyZXR1cm4hR2UoYSl9KTtyKFwibW9yaS5lYWNoXCIsZnVuY3Rpb24oYSxiKXtmb3IodmFyIGM9RChhKSxkPW51bGwsZT0wLGY9MDs7KWlmKGY8ZSl7dmFyIGc9ZC5RKG51bGwsZik7Yi5iP2IuYihnKTpiLmNhbGwobnVsbCxnKTtmKz0xfWVsc2UgaWYoYz1EKGMpKWZkKGMpPyhlPVliKGMpLGM9WmIoYyksZD1lLGU9UShlKSk6KGQ9Zz1HKGMpLGIuYj9iLmIoZCk6Yi5jYWxsKG51bGwsZCksYz1LKGMpLGQ9bnVsbCxlPTApLGY9MDtlbHNlIHJldHVybiBudWxsfSk7cihcIm1vcmkuaWRlbnRpdHlcIix1ZCk7XG5yKFwibW9yaS5jb25zdGFudGx5XCIsZnVuY3Rpb24oYSl7cmV0dXJuIGZ1bmN0aW9uKCl7ZnVuY3Rpb24gYihiKXtpZigwPGFyZ3VtZW50cy5sZW5ndGgpZm9yKHZhciBkPTAsZT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTApO2Q8ZS5sZW5ndGg7KWVbZF09YXJndW1lbnRzW2QrMF0sKytkO3JldHVybiBhfWIuaT0wO2IuZj1mdW5jdGlvbihiKXtEKGIpO3JldHVybiBhfTtiLmQ9ZnVuY3Rpb24oKXtyZXR1cm4gYX07cmV0dXJuIGJ9KCl9KTtyKFwibW9yaS50b0pzXCIsS2gpO1xucihcIm1vcmkudG9DbGpcIixmdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiKXtyZXR1cm4gUGguZChhLEtjKFtPaCxiXSwwKSl9ZnVuY3Rpb24gYihhKXtyZXR1cm4gUGguYihhKX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiLmNhbGwodGhpcyxjKTtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYj1iO2MuYT1hO3JldHVybiBjfSgpKTtyKFwibW9yaS5jb25maWd1cmVcIixmdW5jdGlvbihhLGIpe3N3aXRjaChhKXtjYXNlIFwicHJpbnQtbGVuZ3RoXCI6cmV0dXJuIGxhPWI7Y2FzZSBcInByaW50LWxldmVsXCI6cmV0dXJuIG1hPWI7ZGVmYXVsdDp0aHJvdyBFcnJvcihbeihcIk5vIG1hdGNoaW5nIGNsYXVzZTogXCIpLHooYSldLmpvaW4oXCJcIikpO319KTtyKFwibW9yaS5tZXRhXCIsVmMpO3IoXCJtb3JpLndpdGhNZXRhXCIsTyk7XG5yKFwibW9yaS52YXJ5TWV0YVwiLGllKTtyKFwibW9yaS52YXJ5TWV0YS5mMlwiLGllLmEpO3IoXCJtb3JpLnZhcnlNZXRhLmYzXCIsaWUuYyk7cihcIm1vcmkudmFyeU1ldGEuZjRcIixpZS5uKTtyKFwibW9yaS52YXJ5TWV0YS5mNVwiLGllLnIpO3IoXCJtb3JpLnZhcnlNZXRhLmY2XCIsaWUuUCk7cihcIm1vcmkudmFyeU1ldGEuZm5cIixpZS5LKTtyKFwibW9yaS5hbHRlck1ldGFcIixEaCk7cihcIm1vcmkucmVzZXRNZXRhXCIsZnVuY3Rpb24oYSxiKXtyZXR1cm4gYS5rPWJ9KTtWLnByb3RvdHlwZS5pbnNwZWN0PWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudG9TdHJpbmcoKX07Ri5wcm90b3R5cGUuaW5zcGVjdD1mdW5jdGlvbigpe3JldHVybiB0aGlzLnRvU3RyaW5nKCl9O0hjLnByb3RvdHlwZS5pbnNwZWN0PWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudG9TdHJpbmcoKX07d2cucHJvdG90eXBlLmluc3BlY3Q9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy50b1N0cmluZygpfTtwZy5wcm90b3R5cGUuaW5zcGVjdD1mdW5jdGlvbigpe3JldHVybiB0aGlzLnRvU3RyaW5nKCl9O1xucWcucHJvdG90eXBlLmluc3BlY3Q9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy50b1N0cmluZygpfTtGZC5wcm90b3R5cGUuaW5zcGVjdD1mdW5jdGlvbigpe3JldHVybiB0aGlzLnRvU3RyaW5nKCl9O0xkLnByb3RvdHlwZS5pbnNwZWN0PWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudG9TdHJpbmcoKX07SGQucHJvdG90eXBlLmluc3BlY3Q9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy50b1N0cmluZygpfTtXLnByb3RvdHlwZS5pbnNwZWN0PWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudG9TdHJpbmcoKX07VmQucHJvdG90eXBlLmluc3BlY3Q9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy50b1N0cmluZygpfTtCZi5wcm90b3R5cGUuaW5zcGVjdD1mdW5jdGlvbigpe3JldHVybiB0aGlzLnRvU3RyaW5nKCl9O0RmLnByb3RvdHlwZS5pbnNwZWN0PWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudG9TdHJpbmcoKX07Wi5wcm90b3R5cGUuaW5zcGVjdD1mdW5jdGlvbigpe3JldHVybiB0aGlzLnRvU3RyaW5nKCl9O1xuWC5wcm90b3R5cGUuaW5zcGVjdD1mdW5jdGlvbigpe3JldHVybiB0aGlzLnRvU3RyaW5nKCl9O3BhLnByb3RvdHlwZS5pbnNwZWN0PWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudG9TdHJpbmcoKX07cmcucHJvdG90eXBlLmluc3BlY3Q9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy50b1N0cmluZygpfTtMZy5wcm90b3R5cGUuaW5zcGVjdD1mdW5jdGlvbigpe3JldHVybiB0aGlzLnRvU3RyaW5nKCl9OyRnLnByb3RvdHlwZS5pbnNwZWN0PWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudG9TdHJpbmcoKX07Y2gucHJvdG90eXBlLmluc3BlY3Q9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy50b1N0cmluZygpfTtwaC5wcm90b3R5cGUuaW5zcGVjdD1mdW5jdGlvbigpe3JldHVybiB0aGlzLnRvU3RyaW5nKCl9O1UucHJvdG90eXBlLmluc3BlY3Q9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy50b1N0cmluZygpfTtxYy5wcm90b3R5cGUuaW5zcGVjdD1mdW5jdGlvbigpe3JldHVybiB0aGlzLnRvU3RyaW5nKCl9O1xuTGYucHJvdG90eXBlLmluc3BlY3Q9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy50b1N0cmluZygpfTtLZi5wcm90b3R5cGUuaW5zcGVjdD1mdW5jdGlvbigpe3JldHVybiB0aGlzLnRvU3RyaW5nKCl9O3IoXCJtb3JpLm11dGFibGUudGhhd1wiLGZ1bmN0aW9uKGEpe3JldHVybiBPYihhKX0pO3IoXCJtb3JpLm11dGFibGUuZnJlZXplXCIsY2UpO3IoXCJtb3JpLm11dGFibGUuY29ualwiLGRlKTtyKFwibW9yaS5tdXRhYmxlLmNvbmouZjBcIixkZS5sKTtyKFwibW9yaS5tdXRhYmxlLmNvbmouZjFcIixkZS5iKTtyKFwibW9yaS5tdXRhYmxlLmNvbmouZjJcIixkZS5hKTtyKFwibW9yaS5tdXRhYmxlLmNvbmouZm5cIixkZS5LKTtyKFwibW9yaS5tdXRhYmxlLmFzc29jXCIsZWUpO3IoXCJtb3JpLm11dGFibGUuYXNzb2MuZjNcIixlZS5jKTtyKFwibW9yaS5tdXRhYmxlLmFzc29jLmZuXCIsZWUuSyk7cihcIm1vcmkubXV0YWJsZS5kaXNzb2NcIixmZSk7cihcIm1vcmkubXV0YWJsZS5kaXNzb2MuZjJcIixmZS5hKTtyKFwibW9yaS5tdXRhYmxlLmRpc3NvYy5mblwiLGZlLkspO3IoXCJtb3JpLm11dGFibGUucG9wXCIsZnVuY3Rpb24oYSl7cmV0dXJuIFViKGEpfSk7cihcIm1vcmkubXV0YWJsZS5kaXNqXCIsZ2UpO1xucihcIm1vcmkubXV0YWJsZS5kaXNqLmYyXCIsZ2UuYSk7cihcIm1vcmkubXV0YWJsZS5kaXNqLmZuXCIsZ2UuSyk7O3JldHVybiB0aGlzLm1vcmk7fS5jYWxsKHt9KTt9KTtcbiIsIid1c2Ugc3RyaWN0JztcblxubW9kdWxlLmV4cG9ydHMgPSByZXF1aXJlKCcuL2xpYicpXG4iLCIndXNlIHN0cmljdCc7XG5cbnZhciBhc2FwID0gcmVxdWlyZSgnYXNhcC9yYXcnKTtcblxuZnVuY3Rpb24gbm9vcCgpIHt9XG5cbi8vIFN0YXRlczpcbi8vXG4vLyAwIC0gcGVuZGluZ1xuLy8gMSAtIGZ1bGZpbGxlZCB3aXRoIF92YWx1ZVxuLy8gMiAtIHJlamVjdGVkIHdpdGggX3ZhbHVlXG4vLyAzIC0gYWRvcHRlZCB0aGUgc3RhdGUgb2YgYW5vdGhlciBwcm9taXNlLCBfdmFsdWVcbi8vXG4vLyBvbmNlIHRoZSBzdGF0ZSBpcyBubyBsb25nZXIgcGVuZGluZyAoMCkgaXQgaXMgaW1tdXRhYmxlXG5cbi8vIEFsbCBgX2AgcHJlZml4ZWQgcHJvcGVydGllcyB3aWxsIGJlIHJlZHVjZWQgdG8gYF97cmFuZG9tIG51bWJlcn1gXG4vLyBhdCBidWlsZCB0aW1lIHRvIG9iZnVzY2F0ZSB0aGVtIGFuZCBkaXNjb3VyYWdlIHRoZWlyIHVzZS5cbi8vIFdlIGRvbid0IHVzZSBzeW1ib2xzIG9yIE9iamVjdC5kZWZpbmVQcm9wZXJ0eSB0byBmdWxseSBoaWRlIHRoZW1cbi8vIGJlY2F1c2UgdGhlIHBlcmZvcm1hbmNlIGlzbid0IGdvb2QgZW5vdWdoLlxuXG5cbi8vIHRvIGF2b2lkIHVzaW5nIHRyeS9jYXRjaCBpbnNpZGUgY3JpdGljYWwgZnVuY3Rpb25zLCB3ZVxuLy8gZXh0cmFjdCB0aGVtIHRvIGhlcmUuXG52YXIgTEFTVF9FUlJPUiA9IG51bGw7XG52YXIgSVNfRVJST1IgPSB7fTtcbmZ1bmN0aW9uIGdldFRoZW4ob2JqKSB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIG9iai50aGVuO1xuICB9IGNhdGNoIChleCkge1xuICAgIExBU1RfRVJST1IgPSBleDtcbiAgICByZXR1cm4gSVNfRVJST1I7XG4gIH1cbn1cblxuZnVuY3Rpb24gdHJ5Q2FsbE9uZShmbiwgYSkge1xuICB0cnkge1xuICAgIHJldHVybiBmbihhKTtcbiAgfSBjYXRjaCAoZXgpIHtcbiAgICBMQVNUX0VSUk9SID0gZXg7XG4gICAgcmV0dXJuIElTX0VSUk9SO1xuICB9XG59XG5mdW5jdGlvbiB0cnlDYWxsVHdvKGZuLCBhLCBiKSB7XG4gIHRyeSB7XG4gICAgZm4oYSwgYik7XG4gIH0gY2F0Y2ggKGV4KSB7XG4gICAgTEFTVF9FUlJPUiA9IGV4O1xuICAgIHJldHVybiBJU19FUlJPUjtcbiAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IFByb21pc2U7XG5cbmZ1bmN0aW9uIFByb21pc2UoZm4pIHtcbiAgaWYgKHR5cGVvZiB0aGlzICE9PSAnb2JqZWN0Jykge1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ1Byb21pc2VzIG11c3QgYmUgY29uc3RydWN0ZWQgdmlhIG5ldycpO1xuICB9XG4gIGlmICh0eXBlb2YgZm4gIT09ICdmdW5jdGlvbicpIHtcbiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdub3QgYSBmdW5jdGlvbicpO1xuICB9XG4gIHRoaXMuXzQ1ID0gMDtcbiAgdGhpcy5fODEgPSAwO1xuICB0aGlzLl82NSA9IG51bGw7XG4gIHRoaXMuXzU0ID0gbnVsbDtcbiAgaWYgKGZuID09PSBub29wKSByZXR1cm47XG4gIGRvUmVzb2x2ZShmbiwgdGhpcyk7XG59XG5Qcm9taXNlLl8xMCA9IG51bGw7XG5Qcm9taXNlLl85NyA9IG51bGw7XG5Qcm9taXNlLl82MSA9IG5vb3A7XG5cblByb21pc2UucHJvdG90eXBlLnRoZW4gPSBmdW5jdGlvbihvbkZ1bGZpbGxlZCwgb25SZWplY3RlZCkge1xuICBpZiAodGhpcy5jb25zdHJ1Y3RvciAhPT0gUHJvbWlzZSkge1xuICAgIHJldHVybiBzYWZlVGhlbih0aGlzLCBvbkZ1bGZpbGxlZCwgb25SZWplY3RlZCk7XG4gIH1cbiAgdmFyIHJlcyA9IG5ldyBQcm9taXNlKG5vb3ApO1xuICBoYW5kbGUodGhpcywgbmV3IEhhbmRsZXIob25GdWxmaWxsZWQsIG9uUmVqZWN0ZWQsIHJlcykpO1xuICByZXR1cm4gcmVzO1xufTtcblxuZnVuY3Rpb24gc2FmZVRoZW4oc2VsZiwgb25GdWxmaWxsZWQsIG9uUmVqZWN0ZWQpIHtcbiAgcmV0dXJuIG5ldyBzZWxmLmNvbnN0cnVjdG9yKGZ1bmN0aW9uIChyZXNvbHZlLCByZWplY3QpIHtcbiAgICB2YXIgcmVzID0gbmV3IFByb21pc2Uobm9vcCk7XG4gICAgcmVzLnRoZW4ocmVzb2x2ZSwgcmVqZWN0KTtcbiAgICBoYW5kbGUoc2VsZiwgbmV3IEhhbmRsZXIob25GdWxmaWxsZWQsIG9uUmVqZWN0ZWQsIHJlcykpO1xuICB9KTtcbn07XG5mdW5jdGlvbiBoYW5kbGUoc2VsZiwgZGVmZXJyZWQpIHtcbiAgd2hpbGUgKHNlbGYuXzgxID09PSAzKSB7XG4gICAgc2VsZiA9IHNlbGYuXzY1O1xuICB9XG4gIGlmIChQcm9taXNlLl8xMCkge1xuICAgIFByb21pc2UuXzEwKHNlbGYpO1xuICB9XG4gIGlmIChzZWxmLl84MSA9PT0gMCkge1xuICAgIGlmIChzZWxmLl80NSA9PT0gMCkge1xuICAgICAgc2VsZi5fNDUgPSAxO1xuICAgICAgc2VsZi5fNTQgPSBkZWZlcnJlZDtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHNlbGYuXzQ1ID09PSAxKSB7XG4gICAgICBzZWxmLl80NSA9IDI7XG4gICAgICBzZWxmLl81NCA9IFtzZWxmLl81NCwgZGVmZXJyZWRdO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBzZWxmLl81NC5wdXNoKGRlZmVycmVkKTtcbiAgICByZXR1cm47XG4gIH1cbiAgaGFuZGxlUmVzb2x2ZWQoc2VsZiwgZGVmZXJyZWQpO1xufVxuXG5mdW5jdGlvbiBoYW5kbGVSZXNvbHZlZChzZWxmLCBkZWZlcnJlZCkge1xuICBhc2FwKGZ1bmN0aW9uKCkge1xuICAgIHZhciBjYiA9IHNlbGYuXzgxID09PSAxID8gZGVmZXJyZWQub25GdWxmaWxsZWQgOiBkZWZlcnJlZC5vblJlamVjdGVkO1xuICAgIGlmIChjYiA9PT0gbnVsbCkge1xuICAgICAgaWYgKHNlbGYuXzgxID09PSAxKSB7XG4gICAgICAgIHJlc29sdmUoZGVmZXJyZWQucHJvbWlzZSwgc2VsZi5fNjUpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmVqZWN0KGRlZmVycmVkLnByb21pc2UsIHNlbGYuXzY1KTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdmFyIHJldCA9IHRyeUNhbGxPbmUoY2IsIHNlbGYuXzY1KTtcbiAgICBpZiAocmV0ID09PSBJU19FUlJPUikge1xuICAgICAgcmVqZWN0KGRlZmVycmVkLnByb21pc2UsIExBU1RfRVJST1IpO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXNvbHZlKGRlZmVycmVkLnByb21pc2UsIHJldCk7XG4gICAgfVxuICB9KTtcbn1cbmZ1bmN0aW9uIHJlc29sdmUoc2VsZiwgbmV3VmFsdWUpIHtcbiAgLy8gUHJvbWlzZSBSZXNvbHV0aW9uIFByb2NlZHVyZTogaHR0cHM6Ly9naXRodWIuY29tL3Byb21pc2VzLWFwbHVzL3Byb21pc2VzLXNwZWMjdGhlLXByb21pc2UtcmVzb2x1dGlvbi1wcm9jZWR1cmVcbiAgaWYgKG5ld1ZhbHVlID09PSBzZWxmKSB7XG4gICAgcmV0dXJuIHJlamVjdChcbiAgICAgIHNlbGYsXG4gICAgICBuZXcgVHlwZUVycm9yKCdBIHByb21pc2UgY2Fubm90IGJlIHJlc29sdmVkIHdpdGggaXRzZWxmLicpXG4gICAgKTtcbiAgfVxuICBpZiAoXG4gICAgbmV3VmFsdWUgJiZcbiAgICAodHlwZW9mIG5ld1ZhbHVlID09PSAnb2JqZWN0JyB8fCB0eXBlb2YgbmV3VmFsdWUgPT09ICdmdW5jdGlvbicpXG4gICkge1xuICAgIHZhciB0aGVuID0gZ2V0VGhlbihuZXdWYWx1ZSk7XG4gICAgaWYgKHRoZW4gPT09IElTX0VSUk9SKSB7XG4gICAgICByZXR1cm4gcmVqZWN0KHNlbGYsIExBU1RfRVJST1IpO1xuICAgIH1cbiAgICBpZiAoXG4gICAgICB0aGVuID09PSBzZWxmLnRoZW4gJiZcbiAgICAgIG5ld1ZhbHVlIGluc3RhbmNlb2YgUHJvbWlzZVxuICAgICkge1xuICAgICAgc2VsZi5fODEgPSAzO1xuICAgICAgc2VsZi5fNjUgPSBuZXdWYWx1ZTtcbiAgICAgIGZpbmFsZShzZWxmKTtcbiAgICAgIHJldHVybjtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiB0aGVuID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICBkb1Jlc29sdmUodGhlbi5iaW5kKG5ld1ZhbHVlKSwgc2VsZik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICB9XG4gIHNlbGYuXzgxID0gMTtcbiAgc2VsZi5fNjUgPSBuZXdWYWx1ZTtcbiAgZmluYWxlKHNlbGYpO1xufVxuXG5mdW5jdGlvbiByZWplY3Qoc2VsZiwgbmV3VmFsdWUpIHtcbiAgc2VsZi5fODEgPSAyO1xuICBzZWxmLl82NSA9IG5ld1ZhbHVlO1xuICBpZiAoUHJvbWlzZS5fOTcpIHtcbiAgICBQcm9taXNlLl85NyhzZWxmLCBuZXdWYWx1ZSk7XG4gIH1cbiAgZmluYWxlKHNlbGYpO1xufVxuZnVuY3Rpb24gZmluYWxlKHNlbGYpIHtcbiAgaWYgKHNlbGYuXzQ1ID09PSAxKSB7XG4gICAgaGFuZGxlKHNlbGYsIHNlbGYuXzU0KTtcbiAgICBzZWxmLl81NCA9IG51bGw7XG4gIH1cbiAgaWYgKHNlbGYuXzQ1ID09PSAyKSB7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBzZWxmLl81NC5sZW5ndGg7IGkrKykge1xuICAgICAgaGFuZGxlKHNlbGYsIHNlbGYuXzU0W2ldKTtcbiAgICB9XG4gICAgc2VsZi5fNTQgPSBudWxsO1xuICB9XG59XG5cbmZ1bmN0aW9uIEhhbmRsZXIob25GdWxmaWxsZWQsIG9uUmVqZWN0ZWQsIHByb21pc2Upe1xuICB0aGlzLm9uRnVsZmlsbGVkID0gdHlwZW9mIG9uRnVsZmlsbGVkID09PSAnZnVuY3Rpb24nID8gb25GdWxmaWxsZWQgOiBudWxsO1xuICB0aGlzLm9uUmVqZWN0ZWQgPSB0eXBlb2Ygb25SZWplY3RlZCA9PT0gJ2Z1bmN0aW9uJyA/IG9uUmVqZWN0ZWQgOiBudWxsO1xuICB0aGlzLnByb21pc2UgPSBwcm9taXNlO1xufVxuXG4vKipcbiAqIFRha2UgYSBwb3RlbnRpYWxseSBtaXNiZWhhdmluZyByZXNvbHZlciBmdW5jdGlvbiBhbmQgbWFrZSBzdXJlXG4gKiBvbkZ1bGZpbGxlZCBhbmQgb25SZWplY3RlZCBhcmUgb25seSBjYWxsZWQgb25jZS5cbiAqXG4gKiBNYWtlcyBubyBndWFyYW50ZWVzIGFib3V0IGFzeW5jaHJvbnkuXG4gKi9cbmZ1bmN0aW9uIGRvUmVzb2x2ZShmbiwgcHJvbWlzZSkge1xuICB2YXIgZG9uZSA9IGZhbHNlO1xuICB2YXIgcmVzID0gdHJ5Q2FsbFR3byhmbiwgZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgaWYgKGRvbmUpIHJldHVybjtcbiAgICBkb25lID0gdHJ1ZTtcbiAgICByZXNvbHZlKHByb21pc2UsIHZhbHVlKTtcbiAgfSwgZnVuY3Rpb24gKHJlYXNvbikge1xuICAgIGlmIChkb25lKSByZXR1cm47XG4gICAgZG9uZSA9IHRydWU7XG4gICAgcmVqZWN0KHByb21pc2UsIHJlYXNvbik7XG4gIH0pXG4gIGlmICghZG9uZSAmJiByZXMgPT09IElTX0VSUk9SKSB7XG4gICAgZG9uZSA9IHRydWU7XG4gICAgcmVqZWN0KHByb21pc2UsIExBU1RfRVJST1IpO1xuICB9XG59XG4iLCIndXNlIHN0cmljdCc7XG5cbnZhciBQcm9taXNlID0gcmVxdWlyZSgnLi9jb3JlLmpzJyk7XG5cbm1vZHVsZS5leHBvcnRzID0gUHJvbWlzZTtcblByb21pc2UucHJvdG90eXBlLmRvbmUgPSBmdW5jdGlvbiAob25GdWxmaWxsZWQsIG9uUmVqZWN0ZWQpIHtcbiAgdmFyIHNlbGYgPSBhcmd1bWVudHMubGVuZ3RoID8gdGhpcy50aGVuLmFwcGx5KHRoaXMsIGFyZ3VtZW50cykgOiB0aGlzO1xuICBzZWxmLnRoZW4obnVsbCwgZnVuY3Rpb24gKGVycikge1xuICAgIHNldFRpbWVvdXQoZnVuY3Rpb24gKCkge1xuICAgICAgdGhyb3cgZXJyO1xuICAgIH0sIDApO1xuICB9KTtcbn07XG4iLCIndXNlIHN0cmljdCc7XG5cbi8vVGhpcyBmaWxlIGNvbnRhaW5zIHRoZSBFUzYgZXh0ZW5zaW9ucyB0byB0aGUgY29yZSBQcm9taXNlcy9BKyBBUElcblxudmFyIFByb21pc2UgPSByZXF1aXJlKCcuL2NvcmUuanMnKTtcblxubW9kdWxlLmV4cG9ydHMgPSBQcm9taXNlO1xuXG4vKiBTdGF0aWMgRnVuY3Rpb25zICovXG5cbnZhciBUUlVFID0gdmFsdWVQcm9taXNlKHRydWUpO1xudmFyIEZBTFNFID0gdmFsdWVQcm9taXNlKGZhbHNlKTtcbnZhciBOVUxMID0gdmFsdWVQcm9taXNlKG51bGwpO1xudmFyIFVOREVGSU5FRCA9IHZhbHVlUHJvbWlzZSh1bmRlZmluZWQpO1xudmFyIFpFUk8gPSB2YWx1ZVByb21pc2UoMCk7XG52YXIgRU1QVFlTVFJJTkcgPSB2YWx1ZVByb21pc2UoJycpO1xuXG5mdW5jdGlvbiB2YWx1ZVByb21pc2UodmFsdWUpIHtcbiAgdmFyIHAgPSBuZXcgUHJvbWlzZShQcm9taXNlLl82MSk7XG4gIHAuXzgxID0gMTtcbiAgcC5fNjUgPSB2YWx1ZTtcbiAgcmV0dXJuIHA7XG59XG5Qcm9taXNlLnJlc29sdmUgPSBmdW5jdGlvbiAodmFsdWUpIHtcbiAgaWYgKHZhbHVlIGluc3RhbmNlb2YgUHJvbWlzZSkgcmV0dXJuIHZhbHVlO1xuXG4gIGlmICh2YWx1ZSA9PT0gbnVsbCkgcmV0dXJuIE5VTEw7XG4gIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gVU5ERUZJTkVEO1xuICBpZiAodmFsdWUgPT09IHRydWUpIHJldHVybiBUUlVFO1xuICBpZiAodmFsdWUgPT09IGZhbHNlKSByZXR1cm4gRkFMU0U7XG4gIGlmICh2YWx1ZSA9PT0gMCkgcmV0dXJuIFpFUk87XG4gIGlmICh2YWx1ZSA9PT0gJycpIHJldHVybiBFTVBUWVNUUklORztcblxuICBpZiAodHlwZW9mIHZhbHVlID09PSAnb2JqZWN0JyB8fCB0eXBlb2YgdmFsdWUgPT09ICdmdW5jdGlvbicpIHtcbiAgICB0cnkge1xuICAgICAgdmFyIHRoZW4gPSB2YWx1ZS50aGVuO1xuICAgICAgaWYgKHR5cGVvZiB0aGVuID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIHJldHVybiBuZXcgUHJvbWlzZSh0aGVuLmJpbmQodmFsdWUpKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChleCkge1xuICAgICAgcmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uIChyZXNvbHZlLCByZWplY3QpIHtcbiAgICAgICAgcmVqZWN0KGV4KTtcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuICByZXR1cm4gdmFsdWVQcm9taXNlKHZhbHVlKTtcbn07XG5cblByb21pc2UuYWxsID0gZnVuY3Rpb24gKGFycikge1xuICB2YXIgYXJncyA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFycik7XG5cbiAgcmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uIChyZXNvbHZlLCByZWplY3QpIHtcbiAgICBpZiAoYXJncy5sZW5ndGggPT09IDApIHJldHVybiByZXNvbHZlKFtdKTtcbiAgICB2YXIgcmVtYWluaW5nID0gYXJncy5sZW5ndGg7XG4gICAgZnVuY3Rpb24gcmVzKGksIHZhbCkge1xuICAgICAgaWYgKHZhbCAmJiAodHlwZW9mIHZhbCA9PT0gJ29iamVjdCcgfHwgdHlwZW9mIHZhbCA9PT0gJ2Z1bmN0aW9uJykpIHtcbiAgICAgICAgaWYgKHZhbCBpbnN0YW5jZW9mIFByb21pc2UgJiYgdmFsLnRoZW4gPT09IFByb21pc2UucHJvdG90eXBlLnRoZW4pIHtcbiAgICAgICAgICB3aGlsZSAodmFsLl84MSA9PT0gMykge1xuICAgICAgICAgICAgdmFsID0gdmFsLl82NTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHZhbC5fODEgPT09IDEpIHJldHVybiByZXMoaSwgdmFsLl82NSk7XG4gICAgICAgICAgaWYgKHZhbC5fODEgPT09IDIpIHJlamVjdCh2YWwuXzY1KTtcbiAgICAgICAgICB2YWwudGhlbihmdW5jdGlvbiAodmFsKSB7XG4gICAgICAgICAgICByZXMoaSwgdmFsKTtcbiAgICAgICAgICB9LCByZWplY3QpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB2YXIgdGhlbiA9IHZhbC50aGVuO1xuICAgICAgICAgIGlmICh0eXBlb2YgdGhlbiA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgdmFyIHAgPSBuZXcgUHJvbWlzZSh0aGVuLmJpbmQodmFsKSk7XG4gICAgICAgICAgICBwLnRoZW4oZnVuY3Rpb24gKHZhbCkge1xuICAgICAgICAgICAgICByZXMoaSwgdmFsKTtcbiAgICAgICAgICAgIH0sIHJlamVjdCk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgICBhcmdzW2ldID0gdmFsO1xuICAgICAgaWYgKC0tcmVtYWluaW5nID09PSAwKSB7XG4gICAgICAgIHJlc29sdmUoYXJncyk7XG4gICAgICB9XG4gICAgfVxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgYXJncy5sZW5ndGg7IGkrKykge1xuICAgICAgcmVzKGksIGFyZ3NbaV0pO1xuICAgIH1cbiAgfSk7XG59O1xuXG5Qcm9taXNlLnJlamVjdCA9IGZ1bmN0aW9uICh2YWx1ZSkge1xuICByZXR1cm4gbmV3IFByb21pc2UoZnVuY3Rpb24gKHJlc29sdmUsIHJlamVjdCkge1xuICAgIHJlamVjdCh2YWx1ZSk7XG4gIH0pO1xufTtcblxuUHJvbWlzZS5yYWNlID0gZnVuY3Rpb24gKHZhbHVlcykge1xuICByZXR1cm4gbmV3IFByb21pc2UoZnVuY3Rpb24gKHJlc29sdmUsIHJlamVjdCkge1xuICAgIHZhbHVlcy5mb3JFYWNoKGZ1bmN0aW9uKHZhbHVlKXtcbiAgICAgIFByb21pc2UucmVzb2x2ZSh2YWx1ZSkudGhlbihyZXNvbHZlLCByZWplY3QpO1xuICAgIH0pO1xuICB9KTtcbn07XG5cbi8qIFByb3RvdHlwZSBNZXRob2RzICovXG5cblByb21pc2UucHJvdG90eXBlWydjYXRjaCddID0gZnVuY3Rpb24gKG9uUmVqZWN0ZWQpIHtcbiAgcmV0dXJuIHRoaXMudGhlbihudWxsLCBvblJlamVjdGVkKTtcbn07XG4iLCIndXNlIHN0cmljdCc7XG5cbnZhciBQcm9taXNlID0gcmVxdWlyZSgnLi9jb3JlLmpzJyk7XG5cbm1vZHVsZS5leHBvcnRzID0gUHJvbWlzZTtcblByb21pc2UucHJvdG90eXBlWydmaW5hbGx5J10gPSBmdW5jdGlvbiAoZikge1xuICByZXR1cm4gdGhpcy50aGVuKGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoZigpKS50aGVuKGZ1bmN0aW9uICgpIHtcbiAgICAgIHJldHVybiB2YWx1ZTtcbiAgICB9KTtcbiAgfSwgZnVuY3Rpb24gKGVycikge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoZigpKS50aGVuKGZ1bmN0aW9uICgpIHtcbiAgICAgIHRocm93IGVycjtcbiAgICB9KTtcbiAgfSk7XG59O1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG5tb2R1bGUuZXhwb3J0cyA9IHJlcXVpcmUoJy4vY29yZS5qcycpO1xucmVxdWlyZSgnLi9kb25lLmpzJyk7XG5yZXF1aXJlKCcuL2ZpbmFsbHkuanMnKTtcbnJlcXVpcmUoJy4vZXM2LWV4dGVuc2lvbnMuanMnKTtcbnJlcXVpcmUoJy4vbm9kZS1leHRlbnNpb25zLmpzJyk7XG5yZXF1aXJlKCcuL3N5bmNocm9ub3VzLmpzJyk7XG4iLCIndXNlIHN0cmljdCc7XG5cbi8vIFRoaXMgZmlsZSBjb250YWlucyB0aGVuL3Byb21pc2Ugc3BlY2lmaWMgZXh0ZW5zaW9ucyB0aGF0IGFyZSBvbmx5IHVzZWZ1bFxuLy8gZm9yIG5vZGUuanMgaW50ZXJvcFxuXG52YXIgUHJvbWlzZSA9IHJlcXVpcmUoJy4vY29yZS5qcycpO1xudmFyIGFzYXAgPSByZXF1aXJlKCdhc2FwJyk7XG5cbm1vZHVsZS5leHBvcnRzID0gUHJvbWlzZTtcblxuLyogU3RhdGljIEZ1bmN0aW9ucyAqL1xuXG5Qcm9taXNlLmRlbm9kZWlmeSA9IGZ1bmN0aW9uIChmbiwgYXJndW1lbnRDb3VudCkge1xuICBpZiAoXG4gICAgdHlwZW9mIGFyZ3VtZW50Q291bnQgPT09ICdudW1iZXInICYmIGFyZ3VtZW50Q291bnQgIT09IEluZmluaXR5XG4gICkge1xuICAgIHJldHVybiBkZW5vZGVpZnlXaXRoQ291bnQoZm4sIGFyZ3VtZW50Q291bnQpO1xuICB9IGVsc2Uge1xuICAgIHJldHVybiBkZW5vZGVpZnlXaXRob3V0Q291bnQoZm4pO1xuICB9XG59XG5cbnZhciBjYWxsYmFja0ZuID0gKFxuICAnZnVuY3Rpb24gKGVyciwgcmVzKSB7JyArXG4gICdpZiAoZXJyKSB7IHJqKGVycik7IH0gZWxzZSB7IHJzKHJlcyk7IH0nICtcbiAgJ30nXG4pO1xuZnVuY3Rpb24gZGVub2RlaWZ5V2l0aENvdW50KGZuLCBhcmd1bWVudENvdW50KSB7XG4gIHZhciBhcmdzID0gW107XG4gIGZvciAodmFyIGkgPSAwOyBpIDwgYXJndW1lbnRDb3VudDsgaSsrKSB7XG4gICAgYXJncy5wdXNoKCdhJyArIGkpO1xuICB9XG4gIHZhciBib2R5ID0gW1xuICAgICdyZXR1cm4gZnVuY3Rpb24gKCcgKyBhcmdzLmpvaW4oJywnKSArICcpIHsnLFxuICAgICd2YXIgc2VsZiA9IHRoaXM7JyxcbiAgICAncmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uIChycywgcmopIHsnLFxuICAgICd2YXIgcmVzID0gZm4uY2FsbCgnLFxuICAgIFsnc2VsZiddLmNvbmNhdChhcmdzKS5jb25jYXQoW2NhbGxiYWNrRm5dKS5qb2luKCcsJyksXG4gICAgJyk7JyxcbiAgICAnaWYgKHJlcyAmJicsXG4gICAgJyh0eXBlb2YgcmVzID09PSBcIm9iamVjdFwiIHx8IHR5cGVvZiByZXMgPT09IFwiZnVuY3Rpb25cIikgJiYnLFxuICAgICd0eXBlb2YgcmVzLnRoZW4gPT09IFwiZnVuY3Rpb25cIicsXG4gICAgJykge3JzKHJlcyk7fScsXG4gICAgJ30pOycsXG4gICAgJ307J1xuICBdLmpvaW4oJycpO1xuICByZXR1cm4gRnVuY3Rpb24oWydQcm9taXNlJywgJ2ZuJ10sIGJvZHkpKFByb21pc2UsIGZuKTtcbn1cbmZ1bmN0aW9uIGRlbm9kZWlmeVdpdGhvdXRDb3VudChmbikge1xuICB2YXIgZm5MZW5ndGggPSBNYXRoLm1heChmbi5sZW5ndGggLSAxLCAzKTtcbiAgdmFyIGFyZ3MgPSBbXTtcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBmbkxlbmd0aDsgaSsrKSB7XG4gICAgYXJncy5wdXNoKCdhJyArIGkpO1xuICB9XG4gIHZhciBib2R5ID0gW1xuICAgICdyZXR1cm4gZnVuY3Rpb24gKCcgKyBhcmdzLmpvaW4oJywnKSArICcpIHsnLFxuICAgICd2YXIgc2VsZiA9IHRoaXM7JyxcbiAgICAndmFyIGFyZ3M7JyxcbiAgICAndmFyIGFyZ0xlbmd0aCA9IGFyZ3VtZW50cy5sZW5ndGg7JyxcbiAgICAnaWYgKGFyZ3VtZW50cy5sZW5ndGggPiAnICsgZm5MZW5ndGggKyAnKSB7JyxcbiAgICAnYXJncyA9IG5ldyBBcnJheShhcmd1bWVudHMubGVuZ3RoICsgMSk7JyxcbiAgICAnZm9yICh2YXIgaSA9IDA7IGkgPCBhcmd1bWVudHMubGVuZ3RoOyBpKyspIHsnLFxuICAgICdhcmdzW2ldID0gYXJndW1lbnRzW2ldOycsXG4gICAgJ30nLFxuICAgICd9JyxcbiAgICAncmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uIChycywgcmopIHsnLFxuICAgICd2YXIgY2IgPSAnICsgY2FsbGJhY2tGbiArICc7JyxcbiAgICAndmFyIHJlczsnLFxuICAgICdzd2l0Y2ggKGFyZ0xlbmd0aCkgeycsXG4gICAgYXJncy5jb25jYXQoWydleHRyYSddKS5tYXAoZnVuY3Rpb24gKF8sIGluZGV4KSB7XG4gICAgICByZXR1cm4gKFxuICAgICAgICAnY2FzZSAnICsgKGluZGV4KSArICc6JyArXG4gICAgICAgICdyZXMgPSBmbi5jYWxsKCcgKyBbJ3NlbGYnXS5jb25jYXQoYXJncy5zbGljZSgwLCBpbmRleCkpLmNvbmNhdCgnY2InKS5qb2luKCcsJykgKyAnKTsnICtcbiAgICAgICAgJ2JyZWFrOydcbiAgICAgICk7XG4gICAgfSkuam9pbignJyksXG4gICAgJ2RlZmF1bHQ6JyxcbiAgICAnYXJnc1thcmdMZW5ndGhdID0gY2I7JyxcbiAgICAncmVzID0gZm4uYXBwbHkoc2VsZiwgYXJncyk7JyxcbiAgICAnfScsXG4gICAgXG4gICAgJ2lmIChyZXMgJiYnLFxuICAgICcodHlwZW9mIHJlcyA9PT0gXCJvYmplY3RcIiB8fCB0eXBlb2YgcmVzID09PSBcImZ1bmN0aW9uXCIpICYmJyxcbiAgICAndHlwZW9mIHJlcy50aGVuID09PSBcImZ1bmN0aW9uXCInLFxuICAgICcpIHtycyhyZXMpO30nLFxuICAgICd9KTsnLFxuICAgICd9OydcbiAgXS5qb2luKCcnKTtcblxuICByZXR1cm4gRnVuY3Rpb24oXG4gICAgWydQcm9taXNlJywgJ2ZuJ10sXG4gICAgYm9keVxuICApKFByb21pc2UsIGZuKTtcbn1cblxuUHJvbWlzZS5ub2RlaWZ5ID0gZnVuY3Rpb24gKGZuKSB7XG4gIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIGFyZ3MgPSBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChhcmd1bWVudHMpO1xuICAgIHZhciBjYWxsYmFjayA9XG4gICAgICB0eXBlb2YgYXJnc1thcmdzLmxlbmd0aCAtIDFdID09PSAnZnVuY3Rpb24nID8gYXJncy5wb3AoKSA6IG51bGw7XG4gICAgdmFyIGN0eCA9IHRoaXM7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiBmbi5hcHBseSh0aGlzLCBhcmd1bWVudHMpLm5vZGVpZnkoY2FsbGJhY2ssIGN0eCk7XG4gICAgfSBjYXRjaCAoZXgpIHtcbiAgICAgIGlmIChjYWxsYmFjayA9PT0gbnVsbCB8fCB0eXBlb2YgY2FsbGJhY2sgPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgcmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uIChyZXNvbHZlLCByZWplY3QpIHtcbiAgICAgICAgICByZWplY3QoZXgpO1xuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGFzYXAoZnVuY3Rpb24gKCkge1xuICAgICAgICAgIGNhbGxiYWNrLmNhbGwoY3R4LCBleCk7XG4gICAgICAgIH0pXG4gICAgICB9XG4gICAgfVxuICB9XG59XG5cblByb21pc2UucHJvdG90eXBlLm5vZGVpZnkgPSBmdW5jdGlvbiAoY2FsbGJhY2ssIGN0eCkge1xuICBpZiAodHlwZW9mIGNhbGxiYWNrICE9ICdmdW5jdGlvbicpIHJldHVybiB0aGlzO1xuXG4gIHRoaXMudGhlbihmdW5jdGlvbiAodmFsdWUpIHtcbiAgICBhc2FwKGZ1bmN0aW9uICgpIHtcbiAgICAgIGNhbGxiYWNrLmNhbGwoY3R4LCBudWxsLCB2YWx1ZSk7XG4gICAgfSk7XG4gIH0sIGZ1bmN0aW9uIChlcnIpIHtcbiAgICBhc2FwKGZ1bmN0aW9uICgpIHtcbiAgICAgIGNhbGxiYWNrLmNhbGwoY3R4LCBlcnIpO1xuICAgIH0pO1xuICB9KTtcbn1cbiIsIid1c2Ugc3RyaWN0JztcblxudmFyIFByb21pc2UgPSByZXF1aXJlKCcuL2NvcmUuanMnKTtcblxubW9kdWxlLmV4cG9ydHMgPSBQcm9taXNlO1xuUHJvbWlzZS5lbmFibGVTeW5jaHJvbm91cyA9IGZ1bmN0aW9uICgpIHtcbiAgUHJvbWlzZS5wcm90b3R5cGUuaXNQZW5kaW5nID0gZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIHRoaXMuZ2V0U3RhdGUoKSA9PSAwO1xuICB9O1xuXG4gIFByb21pc2UucHJvdG90eXBlLmlzRnVsZmlsbGVkID0gZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIHRoaXMuZ2V0U3RhdGUoKSA9PSAxO1xuICB9O1xuXG4gIFByb21pc2UucHJvdG90eXBlLmlzUmVqZWN0ZWQgPSBmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gdGhpcy5nZXRTdGF0ZSgpID09IDI7XG4gIH07XG5cbiAgUHJvbWlzZS5wcm90b3R5cGUuZ2V0VmFsdWUgPSBmdW5jdGlvbiAoKSB7XG4gICAgaWYgKHRoaXMuXzgxID09PSAzKSB7XG4gICAgICByZXR1cm4gdGhpcy5fNjUuZ2V0VmFsdWUoKTtcbiAgICB9XG5cbiAgICBpZiAoIXRoaXMuaXNGdWxmaWxsZWQoKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdDYW5ub3QgZ2V0IGEgdmFsdWUgb2YgYW4gdW5mdWxmaWxsZWQgcHJvbWlzZS4nKTtcbiAgICB9XG5cbiAgICByZXR1cm4gdGhpcy5fNjU7XG4gIH07XG5cbiAgUHJvbWlzZS5wcm90b3R5cGUuZ2V0UmVhc29uID0gZnVuY3Rpb24gKCkge1xuICAgIGlmICh0aGlzLl84MSA9PT0gMykge1xuICAgICAgcmV0dXJuIHRoaXMuXzY1LmdldFJlYXNvbigpO1xuICAgIH1cblxuICAgIGlmICghdGhpcy5pc1JlamVjdGVkKCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignQ2Fubm90IGdldCBhIHJlamVjdGlvbiByZWFzb24gb2YgYSBub24tcmVqZWN0ZWQgcHJvbWlzZS4nKTtcbiAgICB9XG5cbiAgICByZXR1cm4gdGhpcy5fNjU7XG4gIH07XG5cbiAgUHJvbWlzZS5wcm90b3R5cGUuZ2V0U3RhdGUgPSBmdW5jdGlvbiAoKSB7XG4gICAgaWYgKHRoaXMuXzgxID09PSAzKSB7XG4gICAgICByZXR1cm4gdGhpcy5fNjUuZ2V0U3RhdGUoKTtcbiAgICB9XG4gICAgaWYgKHRoaXMuXzgxID09PSAtMSB8fCB0aGlzLl84MSA9PT0gLTIpIHtcbiAgICAgIHJldHVybiAwO1xuICAgIH1cblxuICAgIHJldHVybiB0aGlzLl84MTtcbiAgfTtcbn07XG5cblByb21pc2UuZGlzYWJsZVN5bmNocm9ub3VzID0gZnVuY3Rpb24oKSB7XG4gIFByb21pc2UucHJvdG90eXBlLmlzUGVuZGluZyA9IHVuZGVmaW5lZDtcbiAgUHJvbWlzZS5wcm90b3R5cGUuaXNGdWxmaWxsZWQgPSB1bmRlZmluZWQ7XG4gIFByb21pc2UucHJvdG90eXBlLmlzUmVqZWN0ZWQgPSB1bmRlZmluZWQ7XG4gIFByb21pc2UucHJvdG90eXBlLmdldFZhbHVlID0gdW5kZWZpbmVkO1xuICBQcm9taXNlLnByb3RvdHlwZS5nZXRSZWFzb24gPSB1bmRlZmluZWQ7XG4gIFByb21pc2UucHJvdG90eXBlLmdldFN0YXRlID0gdW5kZWZpbmVkO1xufTtcbiIsIid1c2Ugc3RyaWN0JztcblxudmFyIFN0cmluZ2lmeSA9IHJlcXVpcmUoJy4vc3RyaW5naWZ5Jyk7XG52YXIgUGFyc2UgPSByZXF1aXJlKCcuL3BhcnNlJyk7XG5cbm1vZHVsZS5leHBvcnRzID0ge1xuICAgIHN0cmluZ2lmeTogU3RyaW5naWZ5LFxuICAgIHBhcnNlOiBQYXJzZVxufTtcbiIsIid1c2Ugc3RyaWN0JztcblxudmFyIFV0aWxzID0gcmVxdWlyZSgnLi91dGlscycpO1xuXG52YXIgaW50ZXJuYWxzID0ge1xuICAgIGRlbGltaXRlcjogJyYnLFxuICAgIGRlcHRoOiA1LFxuICAgIGFycmF5TGltaXQ6IDIwLFxuICAgIHBhcmFtZXRlckxpbWl0OiAxMDAwLFxuICAgIHN0cmljdE51bGxIYW5kbGluZzogZmFsc2UsXG4gICAgcGxhaW5PYmplY3RzOiBmYWxzZSxcbiAgICBhbGxvd1Byb3RvdHlwZXM6IGZhbHNlLFxuICAgIGFsbG93RG90czogZmFsc2Vcbn07XG5cbmludGVybmFscy5wYXJzZVZhbHVlcyA9IGZ1bmN0aW9uIChzdHIsIG9wdGlvbnMpIHtcbiAgICB2YXIgb2JqID0ge307XG4gICAgdmFyIHBhcnRzID0gc3RyLnNwbGl0KG9wdGlvbnMuZGVsaW1pdGVyLCBvcHRpb25zLnBhcmFtZXRlckxpbWl0ID09PSBJbmZpbml0eSA/IHVuZGVmaW5lZCA6IG9wdGlvbnMucGFyYW1ldGVyTGltaXQpO1xuXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBwYXJ0cy5sZW5ndGg7ICsraSkge1xuICAgICAgICB2YXIgcGFydCA9IHBhcnRzW2ldO1xuICAgICAgICB2YXIgcG9zID0gcGFydC5pbmRleE9mKCddPScpID09PSAtMSA/IHBhcnQuaW5kZXhPZignPScpIDogcGFydC5pbmRleE9mKCddPScpICsgMTtcblxuICAgICAgICBpZiAocG9zID09PSAtMSkge1xuICAgICAgICAgICAgb2JqW1V0aWxzLmRlY29kZShwYXJ0KV0gPSAnJztcblxuICAgICAgICAgICAgaWYgKG9wdGlvbnMuc3RyaWN0TnVsbEhhbmRsaW5nKSB7XG4gICAgICAgICAgICAgICAgb2JqW1V0aWxzLmRlY29kZShwYXJ0KV0gPSBudWxsO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdmFyIGtleSA9IFV0aWxzLmRlY29kZShwYXJ0LnNsaWNlKDAsIHBvcykpO1xuICAgICAgICAgICAgdmFyIHZhbCA9IFV0aWxzLmRlY29kZShwYXJ0LnNsaWNlKHBvcyArIDEpKTtcblxuICAgICAgICAgICAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChvYmosIGtleSkpIHtcbiAgICAgICAgICAgICAgICBvYmpba2V5XSA9IFtdLmNvbmNhdChvYmpba2V5XSkuY29uY2F0KHZhbCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIG9ialtrZXldID0gdmFsO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIG9iajtcbn07XG5cbmludGVybmFscy5wYXJzZU9iamVjdCA9IGZ1bmN0aW9uIChjaGFpbiwgdmFsLCBvcHRpb25zKSB7XG4gICAgaWYgKCFjaGFpbi5sZW5ndGgpIHtcbiAgICAgICAgcmV0dXJuIHZhbDtcbiAgICB9XG5cbiAgICB2YXIgcm9vdCA9IGNoYWluLnNoaWZ0KCk7XG5cbiAgICB2YXIgb2JqO1xuICAgIGlmIChyb290ID09PSAnW10nKSB7XG4gICAgICAgIG9iaiA9IFtdO1xuICAgICAgICBvYmogPSBvYmouY29uY2F0KGludGVybmFscy5wYXJzZU9iamVjdChjaGFpbiwgdmFsLCBvcHRpb25zKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgb2JqID0gb3B0aW9ucy5wbGFpbk9iamVjdHMgPyBPYmplY3QuY3JlYXRlKG51bGwpIDoge307XG4gICAgICAgIHZhciBjbGVhblJvb3QgPSByb290WzBdID09PSAnWycgJiYgcm9vdFtyb290Lmxlbmd0aCAtIDFdID09PSAnXScgPyByb290LnNsaWNlKDEsIHJvb3QubGVuZ3RoIC0gMSkgOiByb290O1xuICAgICAgICB2YXIgaW5kZXggPSBwYXJzZUludChjbGVhblJvb3QsIDEwKTtcbiAgICAgICAgaWYgKFxuICAgICAgICAgICAgIWlzTmFOKGluZGV4KSAmJlxuICAgICAgICAgICAgcm9vdCAhPT0gY2xlYW5Sb290ICYmXG4gICAgICAgICAgICBTdHJpbmcoaW5kZXgpID09PSBjbGVhblJvb3QgJiZcbiAgICAgICAgICAgIGluZGV4ID49IDAgJiZcbiAgICAgICAgICAgIChvcHRpb25zLnBhcnNlQXJyYXlzICYmIGluZGV4IDw9IG9wdGlvbnMuYXJyYXlMaW1pdClcbiAgICAgICAgKSB7XG4gICAgICAgICAgICBvYmogPSBbXTtcbiAgICAgICAgICAgIG9ialtpbmRleF0gPSBpbnRlcm5hbHMucGFyc2VPYmplY3QoY2hhaW4sIHZhbCwgb3B0aW9ucyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBvYmpbY2xlYW5Sb290XSA9IGludGVybmFscy5wYXJzZU9iamVjdChjaGFpbiwgdmFsLCBvcHRpb25zKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBvYmo7XG59O1xuXG5pbnRlcm5hbHMucGFyc2VLZXlzID0gZnVuY3Rpb24gKGdpdmVuS2V5LCB2YWwsIG9wdGlvbnMpIHtcbiAgICBpZiAoIWdpdmVuS2V5KSB7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBUcmFuc2Zvcm0gZG90IG5vdGF0aW9uIHRvIGJyYWNrZXQgbm90YXRpb25cbiAgICB2YXIga2V5ID0gb3B0aW9ucy5hbGxvd0RvdHMgPyBnaXZlbktleS5yZXBsYWNlKC9cXC4oW15cXC5cXFtdKykvZywgJ1skMV0nKSA6IGdpdmVuS2V5O1xuXG4gICAgLy8gVGhlIHJlZ2V4IGNodW5rc1xuXG4gICAgdmFyIHBhcmVudCA9IC9eKFteXFxbXFxdXSopLztcbiAgICB2YXIgY2hpbGQgPSAvKFxcW1teXFxbXFxdXSpcXF0pL2c7XG5cbiAgICAvLyBHZXQgdGhlIHBhcmVudFxuXG4gICAgdmFyIHNlZ21lbnQgPSBwYXJlbnQuZXhlYyhrZXkpO1xuXG4gICAgLy8gU3Rhc2ggdGhlIHBhcmVudCBpZiBpdCBleGlzdHNcblxuICAgIHZhciBrZXlzID0gW107XG4gICAgaWYgKHNlZ21lbnRbMV0pIHtcbiAgICAgICAgLy8gSWYgd2UgYXJlbid0IHVzaW5nIHBsYWluIG9iamVjdHMsIG9wdGlvbmFsbHkgcHJlZml4IGtleXNcbiAgICAgICAgLy8gdGhhdCB3b3VsZCBvdmVyd3JpdGUgb2JqZWN0IHByb3RvdHlwZSBwcm9wZXJ0aWVzXG4gICAgICAgIGlmICghb3B0aW9ucy5wbGFpbk9iamVjdHMgJiYgT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eShzZWdtZW50WzFdKSkge1xuICAgICAgICAgICAgaWYgKCFvcHRpb25zLmFsbG93UHJvdG90eXBlcykge1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGtleXMucHVzaChzZWdtZW50WzFdKTtcbiAgICB9XG5cbiAgICAvLyBMb29wIHRocm91Z2ggY2hpbGRyZW4gYXBwZW5kaW5nIHRvIHRoZSBhcnJheSB1bnRpbCB3ZSBoaXQgZGVwdGhcblxuICAgIHZhciBpID0gMDtcbiAgICB3aGlsZSAoKHNlZ21lbnQgPSBjaGlsZC5leGVjKGtleSkpICE9PSBudWxsICYmIGkgPCBvcHRpb25zLmRlcHRoKSB7XG4gICAgICAgIGkgKz0gMTtcbiAgICAgICAgaWYgKCFvcHRpb25zLnBsYWluT2JqZWN0cyAmJiBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5KHNlZ21lbnRbMV0ucmVwbGFjZSgvXFxbfFxcXS9nLCAnJykpKSB7XG4gICAgICAgICAgICBpZiAoIW9wdGlvbnMuYWxsb3dQcm90b3R5cGVzKSB7XG4gICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAga2V5cy5wdXNoKHNlZ21lbnRbMV0pO1xuICAgIH1cblxuICAgIC8vIElmIHRoZXJlJ3MgYSByZW1haW5kZXIsIGp1c3QgYWRkIHdoYXRldmVyIGlzIGxlZnRcblxuICAgIGlmIChzZWdtZW50KSB7XG4gICAgICAgIGtleXMucHVzaCgnWycgKyBrZXkuc2xpY2Uoc2VnbWVudC5pbmRleCkgKyAnXScpO1xuICAgIH1cblxuICAgIHJldHVybiBpbnRlcm5hbHMucGFyc2VPYmplY3Qoa2V5cywgdmFsLCBvcHRpb25zKTtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gKHN0ciwgb3B0cykge1xuICAgIHZhciBvcHRpb25zID0gb3B0cyB8fCB7fTtcbiAgICBvcHRpb25zLmRlbGltaXRlciA9IHR5cGVvZiBvcHRpb25zLmRlbGltaXRlciA9PT0gJ3N0cmluZycgfHwgVXRpbHMuaXNSZWdFeHAob3B0aW9ucy5kZWxpbWl0ZXIpID8gb3B0aW9ucy5kZWxpbWl0ZXIgOiBpbnRlcm5hbHMuZGVsaW1pdGVyO1xuICAgIG9wdGlvbnMuZGVwdGggPSB0eXBlb2Ygb3B0aW9ucy5kZXB0aCA9PT0gJ251bWJlcicgPyBvcHRpb25zLmRlcHRoIDogaW50ZXJuYWxzLmRlcHRoO1xuICAgIG9wdGlvbnMuYXJyYXlMaW1pdCA9IHR5cGVvZiBvcHRpb25zLmFycmF5TGltaXQgPT09ICdudW1iZXInID8gb3B0aW9ucy5hcnJheUxpbWl0IDogaW50ZXJuYWxzLmFycmF5TGltaXQ7XG4gICAgb3B0aW9ucy5wYXJzZUFycmF5cyA9IG9wdGlvbnMucGFyc2VBcnJheXMgIT09IGZhbHNlO1xuICAgIG9wdGlvbnMuYWxsb3dEb3RzID0gdHlwZW9mIG9wdGlvbnMuYWxsb3dEb3RzID09PSAnYm9vbGVhbicgPyBvcHRpb25zLmFsbG93RG90cyA6IGludGVybmFscy5hbGxvd0RvdHM7XG4gICAgb3B0aW9ucy5wbGFpbk9iamVjdHMgPSB0eXBlb2Ygb3B0aW9ucy5wbGFpbk9iamVjdHMgPT09ICdib29sZWFuJyA/IG9wdGlvbnMucGxhaW5PYmplY3RzIDogaW50ZXJuYWxzLnBsYWluT2JqZWN0cztcbiAgICBvcHRpb25zLmFsbG93UHJvdG90eXBlcyA9IHR5cGVvZiBvcHRpb25zLmFsbG93UHJvdG90eXBlcyA9PT0gJ2Jvb2xlYW4nID8gb3B0aW9ucy5hbGxvd1Byb3RvdHlwZXMgOiBpbnRlcm5hbHMuYWxsb3dQcm90b3R5cGVzO1xuICAgIG9wdGlvbnMucGFyYW1ldGVyTGltaXQgPSB0eXBlb2Ygb3B0aW9ucy5wYXJhbWV0ZXJMaW1pdCA9PT0gJ251bWJlcicgPyBvcHRpb25zLnBhcmFtZXRlckxpbWl0IDogaW50ZXJuYWxzLnBhcmFtZXRlckxpbWl0O1xuICAgIG9wdGlvbnMuc3RyaWN0TnVsbEhhbmRsaW5nID0gdHlwZW9mIG9wdGlvbnMuc3RyaWN0TnVsbEhhbmRsaW5nID09PSAnYm9vbGVhbicgPyBvcHRpb25zLnN0cmljdE51bGxIYW5kbGluZyA6IGludGVybmFscy5zdHJpY3ROdWxsSGFuZGxpbmc7XG5cbiAgICBpZiAoXG4gICAgICAgIHN0ciA9PT0gJycgfHxcbiAgICAgICAgc3RyID09PSBudWxsIHx8XG4gICAgICAgIHR5cGVvZiBzdHIgPT09ICd1bmRlZmluZWQnXG4gICAgKSB7XG4gICAgICAgIHJldHVybiBvcHRpb25zLnBsYWluT2JqZWN0cyA/IE9iamVjdC5jcmVhdGUobnVsbCkgOiB7fTtcbiAgICB9XG5cbiAgICB2YXIgdGVtcE9iaiA9IHR5cGVvZiBzdHIgPT09ICdzdHJpbmcnID8gaW50ZXJuYWxzLnBhcnNlVmFsdWVzKHN0ciwgb3B0aW9ucykgOiBzdHI7XG4gICAgdmFyIG9iaiA9IG9wdGlvbnMucGxhaW5PYmplY3RzID8gT2JqZWN0LmNyZWF0ZShudWxsKSA6IHt9O1xuXG4gICAgLy8gSXRlcmF0ZSBvdmVyIHRoZSBrZXlzIGFuZCBzZXR1cCB0aGUgbmV3IG9iamVjdFxuXG4gICAgdmFyIGtleXMgPSBPYmplY3Qua2V5cyh0ZW1wT2JqKTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGtleXMubGVuZ3RoOyArK2kpIHtcbiAgICAgICAgdmFyIGtleSA9IGtleXNbaV07XG4gICAgICAgIHZhciBuZXdPYmogPSBpbnRlcm5hbHMucGFyc2VLZXlzKGtleSwgdGVtcE9ialtrZXldLCBvcHRpb25zKTtcbiAgICAgICAgb2JqID0gVXRpbHMubWVyZ2Uob2JqLCBuZXdPYmosIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIHJldHVybiBVdGlscy5jb21wYWN0KG9iaik7XG59O1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG52YXIgVXRpbHMgPSByZXF1aXJlKCcuL3V0aWxzJyk7XG5cbnZhciBpbnRlcm5hbHMgPSB7XG4gICAgZGVsaW1pdGVyOiAnJicsXG4gICAgYXJyYXlQcmVmaXhHZW5lcmF0b3JzOiB7XG4gICAgICAgIGJyYWNrZXRzOiBmdW5jdGlvbiAocHJlZml4KSB7XG4gICAgICAgICAgICByZXR1cm4gcHJlZml4ICsgJ1tdJztcbiAgICAgICAgfSxcbiAgICAgICAgaW5kaWNlczogZnVuY3Rpb24gKHByZWZpeCwga2V5KSB7XG4gICAgICAgICAgICByZXR1cm4gcHJlZml4ICsgJ1snICsga2V5ICsgJ10nO1xuICAgICAgICB9LFxuICAgICAgICByZXBlYXQ6IGZ1bmN0aW9uIChwcmVmaXgpIHtcbiAgICAgICAgICAgIHJldHVybiBwcmVmaXg7XG4gICAgICAgIH1cbiAgICB9LFxuICAgIHN0cmljdE51bGxIYW5kbGluZzogZmFsc2UsXG4gICAgc2tpcE51bGxzOiBmYWxzZSxcbiAgICBlbmNvZGU6IHRydWVcbn07XG5cbmludGVybmFscy5zdHJpbmdpZnkgPSBmdW5jdGlvbiAob2JqZWN0LCBwcmVmaXgsIGdlbmVyYXRlQXJyYXlQcmVmaXgsIHN0cmljdE51bGxIYW5kbGluZywgc2tpcE51bGxzLCBlbmNvZGUsIGZpbHRlciwgc29ydCwgYWxsb3dEb3RzKSB7XG4gICAgdmFyIG9iaiA9IG9iamVjdDtcbiAgICBpZiAodHlwZW9mIGZpbHRlciA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICBvYmogPSBmaWx0ZXIocHJlZml4LCBvYmopO1xuICAgIH0gZWxzZSBpZiAoVXRpbHMuaXNCdWZmZXIob2JqKSkge1xuICAgICAgICBvYmogPSBTdHJpbmcob2JqKTtcbiAgICB9IGVsc2UgaWYgKG9iaiBpbnN0YW5jZW9mIERhdGUpIHtcbiAgICAgICAgb2JqID0gb2JqLnRvSVNPU3RyaW5nKCk7XG4gICAgfSBlbHNlIGlmIChvYmogPT09IG51bGwpIHtcbiAgICAgICAgaWYgKHN0cmljdE51bGxIYW5kbGluZykge1xuICAgICAgICAgICAgcmV0dXJuIGVuY29kZSA/IFV0aWxzLmVuY29kZShwcmVmaXgpIDogcHJlZml4O1xuICAgICAgICB9XG5cbiAgICAgICAgb2JqID0gJyc7XG4gICAgfVxuXG4gICAgaWYgKHR5cGVvZiBvYmogPT09ICdzdHJpbmcnIHx8IHR5cGVvZiBvYmogPT09ICdudW1iZXInIHx8IHR5cGVvZiBvYmogPT09ICdib29sZWFuJykge1xuICAgICAgICBpZiAoZW5jb2RlKSB7XG4gICAgICAgICAgICByZXR1cm4gW1V0aWxzLmVuY29kZShwcmVmaXgpICsgJz0nICsgVXRpbHMuZW5jb2RlKG9iaildO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBbcHJlZml4ICsgJz0nICsgb2JqXTtcbiAgICB9XG5cbiAgICB2YXIgdmFsdWVzID0gW107XG5cbiAgICBpZiAodHlwZW9mIG9iaiA9PT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgcmV0dXJuIHZhbHVlcztcbiAgICB9XG5cbiAgICB2YXIgb2JqS2V5cztcbiAgICBpZiAoQXJyYXkuaXNBcnJheShmaWx0ZXIpKSB7XG4gICAgICAgIG9iaktleXMgPSBmaWx0ZXI7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgdmFyIGtleXMgPSBPYmplY3Qua2V5cyhvYmopO1xuICAgICAgICBvYmpLZXlzID0gc29ydCA/IGtleXMuc29ydChzb3J0KSA6IGtleXM7XG4gICAgfVxuXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBvYmpLZXlzLmxlbmd0aDsgKytpKSB7XG4gICAgICAgIHZhciBrZXkgPSBvYmpLZXlzW2ldO1xuXG4gICAgICAgIGlmIChza2lwTnVsbHMgJiYgb2JqW2tleV0gPT09IG51bGwpIHtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkob2JqKSkge1xuICAgICAgICAgICAgdmFsdWVzID0gdmFsdWVzLmNvbmNhdChpbnRlcm5hbHMuc3RyaW5naWZ5KG9ialtrZXldLCBnZW5lcmF0ZUFycmF5UHJlZml4KHByZWZpeCwga2V5KSwgZ2VuZXJhdGVBcnJheVByZWZpeCwgc3RyaWN0TnVsbEhhbmRsaW5nLCBza2lwTnVsbHMsIGVuY29kZSwgZmlsdGVyLCBzb3J0LCBhbGxvd0RvdHMpKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHZhbHVlcyA9IHZhbHVlcy5jb25jYXQoaW50ZXJuYWxzLnN0cmluZ2lmeShvYmpba2V5XSwgcHJlZml4ICsgKGFsbG93RG90cyA/ICcuJyArIGtleSA6ICdbJyArIGtleSArICddJyksIGdlbmVyYXRlQXJyYXlQcmVmaXgsIHN0cmljdE51bGxIYW5kbGluZywgc2tpcE51bGxzLCBlbmNvZGUsIGZpbHRlciwgc29ydCwgYWxsb3dEb3RzKSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gdmFsdWVzO1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAob2JqZWN0LCBvcHRzKSB7XG4gICAgdmFyIG9iaiA9IG9iamVjdDtcbiAgICB2YXIgb3B0aW9ucyA9IG9wdHMgfHwge307XG4gICAgdmFyIGRlbGltaXRlciA9IHR5cGVvZiBvcHRpb25zLmRlbGltaXRlciA9PT0gJ3VuZGVmaW5lZCcgPyBpbnRlcm5hbHMuZGVsaW1pdGVyIDogb3B0aW9ucy5kZWxpbWl0ZXI7XG4gICAgdmFyIHN0cmljdE51bGxIYW5kbGluZyA9IHR5cGVvZiBvcHRpb25zLnN0cmljdE51bGxIYW5kbGluZyA9PT0gJ2Jvb2xlYW4nID8gb3B0aW9ucy5zdHJpY3ROdWxsSGFuZGxpbmcgOiBpbnRlcm5hbHMuc3RyaWN0TnVsbEhhbmRsaW5nO1xuICAgIHZhciBza2lwTnVsbHMgPSB0eXBlb2Ygb3B0aW9ucy5za2lwTnVsbHMgPT09ICdib29sZWFuJyA/IG9wdGlvbnMuc2tpcE51bGxzIDogaW50ZXJuYWxzLnNraXBOdWxscztcbiAgICB2YXIgZW5jb2RlID0gdHlwZW9mIG9wdGlvbnMuZW5jb2RlID09PSAnYm9vbGVhbicgPyBvcHRpb25zLmVuY29kZSA6IGludGVybmFscy5lbmNvZGU7XG4gICAgdmFyIHNvcnQgPSB0eXBlb2Ygb3B0aW9ucy5zb3J0ID09PSAnZnVuY3Rpb24nID8gb3B0aW9ucy5zb3J0IDogbnVsbDtcbiAgICB2YXIgYWxsb3dEb3RzID0gdHlwZW9mIG9wdGlvbnMuYWxsb3dEb3RzID09PSAndW5kZWZpbmVkJyA/IGZhbHNlIDogb3B0aW9ucy5hbGxvd0RvdHM7XG4gICAgdmFyIG9iaktleXM7XG4gICAgdmFyIGZpbHRlcjtcbiAgICBpZiAodHlwZW9mIG9wdGlvbnMuZmlsdGVyID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIGZpbHRlciA9IG9wdGlvbnMuZmlsdGVyO1xuICAgICAgICBvYmogPSBmaWx0ZXIoJycsIG9iaik7XG4gICAgfSBlbHNlIGlmIChBcnJheS5pc0FycmF5KG9wdGlvbnMuZmlsdGVyKSkge1xuICAgICAgICBvYmpLZXlzID0gZmlsdGVyID0gb3B0aW9ucy5maWx0ZXI7XG4gICAgfVxuXG4gICAgdmFyIGtleXMgPSBbXTtcblxuICAgIGlmICh0eXBlb2Ygb2JqICE9PSAnb2JqZWN0JyB8fCBvYmogPT09IG51bGwpIHtcbiAgICAgICAgcmV0dXJuICcnO1xuICAgIH1cblxuICAgIHZhciBhcnJheUZvcm1hdDtcbiAgICBpZiAob3B0aW9ucy5hcnJheUZvcm1hdCBpbiBpbnRlcm5hbHMuYXJyYXlQcmVmaXhHZW5lcmF0b3JzKSB7XG4gICAgICAgIGFycmF5Rm9ybWF0ID0gb3B0aW9ucy5hcnJheUZvcm1hdDtcbiAgICB9IGVsc2UgaWYgKCdpbmRpY2VzJyBpbiBvcHRpb25zKSB7XG4gICAgICAgIGFycmF5Rm9ybWF0ID0gb3B0aW9ucy5pbmRpY2VzID8gJ2luZGljZXMnIDogJ3JlcGVhdCc7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgYXJyYXlGb3JtYXQgPSAnaW5kaWNlcyc7XG4gICAgfVxuXG4gICAgdmFyIGdlbmVyYXRlQXJyYXlQcmVmaXggPSBpbnRlcm5hbHMuYXJyYXlQcmVmaXhHZW5lcmF0b3JzW2FycmF5Rm9ybWF0XTtcblxuICAgIGlmICghb2JqS2V5cykge1xuICAgICAgICBvYmpLZXlzID0gT2JqZWN0LmtleXMob2JqKTtcbiAgICB9XG5cbiAgICBpZiAoc29ydCkge1xuICAgICAgICBvYmpLZXlzLnNvcnQoc29ydCk7XG4gICAgfVxuXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBvYmpLZXlzLmxlbmd0aDsgKytpKSB7XG4gICAgICAgIHZhciBrZXkgPSBvYmpLZXlzW2ldO1xuXG4gICAgICAgIGlmIChza2lwTnVsbHMgJiYgb2JqW2tleV0gPT09IG51bGwpIHtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAga2V5cyA9IGtleXMuY29uY2F0KGludGVybmFscy5zdHJpbmdpZnkob2JqW2tleV0sIGtleSwgZ2VuZXJhdGVBcnJheVByZWZpeCwgc3RyaWN0TnVsbEhhbmRsaW5nLCBza2lwTnVsbHMsIGVuY29kZSwgZmlsdGVyLCBzb3J0LCBhbGxvd0RvdHMpKTtcbiAgICB9XG5cbiAgICByZXR1cm4ga2V5cy5qb2luKGRlbGltaXRlcik7XG59O1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG52YXIgaGV4VGFibGUgPSAoZnVuY3Rpb24gKCkge1xuICAgIHZhciBhcnJheSA9IG5ldyBBcnJheSgyNTYpO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgMjU2OyArK2kpIHtcbiAgICAgICAgYXJyYXlbaV0gPSAnJScgKyAoKGkgPCAxNiA/ICcwJyA6ICcnKSArIGkudG9TdHJpbmcoMTYpKS50b1VwcGVyQ2FzZSgpO1xuICAgIH1cblxuICAgIHJldHVybiBhcnJheTtcbn0oKSk7XG5cbmV4cG9ydHMuYXJyYXlUb09iamVjdCA9IGZ1bmN0aW9uIChzb3VyY2UsIG9wdGlvbnMpIHtcbiAgICB2YXIgb2JqID0gb3B0aW9ucy5wbGFpbk9iamVjdHMgPyBPYmplY3QuY3JlYXRlKG51bGwpIDoge307XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBzb3VyY2UubGVuZ3RoOyArK2kpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBzb3VyY2VbaV0gIT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgICAgICBvYmpbaV0gPSBzb3VyY2VbaV07XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gb2JqO1xufTtcblxuZXhwb3J0cy5tZXJnZSA9IGZ1bmN0aW9uICh0YXJnZXQsIHNvdXJjZSwgb3B0aW9ucykge1xuICAgIGlmICghc291cmNlKSB7XG4gICAgICAgIHJldHVybiB0YXJnZXQ7XG4gICAgfVxuXG4gICAgaWYgKHR5cGVvZiBzb3VyY2UgIT09ICdvYmplY3QnKSB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHRhcmdldCkpIHtcbiAgICAgICAgICAgIHRhcmdldC5wdXNoKHNvdXJjZSk7XG4gICAgICAgIH0gZWxzZSBpZiAodHlwZW9mIHRhcmdldCA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgIHRhcmdldFtzb3VyY2VdID0gdHJ1ZTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJldHVybiBbdGFyZ2V0LCBzb3VyY2VdO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRhcmdldDtcbiAgICB9XG5cbiAgICBpZiAodHlwZW9mIHRhcmdldCAhPT0gJ29iamVjdCcpIHtcbiAgICAgICAgcmV0dXJuIFt0YXJnZXRdLmNvbmNhdChzb3VyY2UpO1xuICAgIH1cblxuICAgIHZhciBtZXJnZVRhcmdldCA9IHRhcmdldDtcbiAgICBpZiAoQXJyYXkuaXNBcnJheSh0YXJnZXQpICYmICFBcnJheS5pc0FycmF5KHNvdXJjZSkpIHtcbiAgICAgICAgbWVyZ2VUYXJnZXQgPSBleHBvcnRzLmFycmF5VG9PYmplY3QodGFyZ2V0LCBvcHRpb25zKTtcbiAgICB9XG5cblx0cmV0dXJuIE9iamVjdC5rZXlzKHNvdXJjZSkucmVkdWNlKGZ1bmN0aW9uIChhY2MsIGtleSkge1xuICAgICAgICB2YXIgdmFsdWUgPSBzb3VyY2Vba2V5XTtcblxuICAgICAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGFjYywga2V5KSkge1xuICAgICAgICAgICAgYWNjW2tleV0gPSBleHBvcnRzLm1lcmdlKGFjY1trZXldLCB2YWx1ZSwgb3B0aW9ucyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBhY2Nba2V5XSA9IHZhbHVlO1xuICAgICAgICB9XG5cdFx0cmV0dXJuIGFjYztcbiAgICB9LCBtZXJnZVRhcmdldCk7XG59O1xuXG5leHBvcnRzLmRlY29kZSA9IGZ1bmN0aW9uIChzdHIpIHtcbiAgICB0cnkge1xuICAgICAgICByZXR1cm4gZGVjb2RlVVJJQ29tcG9uZW50KHN0ci5yZXBsYWNlKC9cXCsvZywgJyAnKSk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgICByZXR1cm4gc3RyO1xuICAgIH1cbn07XG5cbmV4cG9ydHMuZW5jb2RlID0gZnVuY3Rpb24gKHN0cikge1xuICAgIC8vIFRoaXMgY29kZSB3YXMgb3JpZ2luYWxseSB3cml0dGVuIGJ5IEJyaWFuIFdoaXRlIChtc2NkZXgpIGZvciB0aGUgaW8uanMgY29yZSBxdWVyeXN0cmluZyBsaWJyYXJ5LlxuICAgIC8vIEl0IGhhcyBiZWVuIGFkYXB0ZWQgaGVyZSBmb3Igc3RyaWN0ZXIgYWRoZXJlbmNlIHRvIFJGQyAzOTg2XG4gICAgaWYgKHN0ci5sZW5ndGggPT09IDApIHtcbiAgICAgICAgcmV0dXJuIHN0cjtcbiAgICB9XG5cbiAgICB2YXIgc3RyaW5nID0gdHlwZW9mIHN0ciA9PT0gJ3N0cmluZycgPyBzdHIgOiBTdHJpbmcoc3RyKTtcblxuICAgIHZhciBvdXQgPSAnJztcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHN0cmluZy5sZW5ndGg7ICsraSkge1xuICAgICAgICB2YXIgYyA9IHN0cmluZy5jaGFyQ29kZUF0KGkpO1xuXG4gICAgICAgIGlmIChcbiAgICAgICAgICAgIGMgPT09IDB4MkQgfHwgLy8gLVxuICAgICAgICAgICAgYyA9PT0gMHgyRSB8fCAvLyAuXG4gICAgICAgICAgICBjID09PSAweDVGIHx8IC8vIF9cbiAgICAgICAgICAgIGMgPT09IDB4N0UgfHwgLy8gflxuICAgICAgICAgICAgKGMgPj0gMHgzMCAmJiBjIDw9IDB4MzkpIHx8IC8vIDAtOVxuICAgICAgICAgICAgKGMgPj0gMHg0MSAmJiBjIDw9IDB4NUEpIHx8IC8vIGEtelxuICAgICAgICAgICAgKGMgPj0gMHg2MSAmJiBjIDw9IDB4N0EpIC8vIEEtWlxuICAgICAgICApIHtcbiAgICAgICAgICAgIG91dCArPSBzdHJpbmcuY2hhckF0KGkpO1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoYyA8IDB4ODApIHtcbiAgICAgICAgICAgIG91dCA9IG91dCArIGhleFRhYmxlW2NdO1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoYyA8IDB4ODAwKSB7XG4gICAgICAgICAgICBvdXQgPSBvdXQgKyAoaGV4VGFibGVbMHhDMCB8IChjID4+IDYpXSArIGhleFRhYmxlWzB4ODAgfCAoYyAmIDB4M0YpXSk7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChjIDwgMHhEODAwIHx8IGMgPj0gMHhFMDAwKSB7XG4gICAgICAgICAgICBvdXQgPSBvdXQgKyAoaGV4VGFibGVbMHhFMCB8IChjID4+IDEyKV0gKyBoZXhUYWJsZVsweDgwIHwgKChjID4+IDYpICYgMHgzRildICsgaGV4VGFibGVbMHg4MCB8IChjICYgMHgzRildKTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgaSArPSAxO1xuICAgICAgICBjID0gMHgxMDAwMCArICgoKGMgJiAweDNGRikgPDwgMTApIHwgKHN0cmluZy5jaGFyQ29kZUF0KGkpICYgMHgzRkYpKTtcbiAgICAgICAgb3V0ICs9IChoZXhUYWJsZVsweEYwIHwgKGMgPj4gMTgpXSArIGhleFRhYmxlWzB4ODAgfCAoKGMgPj4gMTIpICYgMHgzRildICsgaGV4VGFibGVbMHg4MCB8ICgoYyA+PiA2KSAmIDB4M0YpXSArIGhleFRhYmxlWzB4ODAgfCAoYyAmIDB4M0YpXSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIG91dDtcbn07XG5cbmV4cG9ydHMuY29tcGFjdCA9IGZ1bmN0aW9uIChvYmosIHJlZmVyZW5jZXMpIHtcbiAgICBpZiAodHlwZW9mIG9iaiAhPT0gJ29iamVjdCcgfHwgb2JqID09PSBudWxsKSB7XG4gICAgICAgIHJldHVybiBvYmo7XG4gICAgfVxuXG4gICAgdmFyIHJlZnMgPSByZWZlcmVuY2VzIHx8IFtdO1xuICAgIHZhciBsb29rdXAgPSByZWZzLmluZGV4T2Yob2JqKTtcbiAgICBpZiAobG9va3VwICE9PSAtMSkge1xuICAgICAgICByZXR1cm4gcmVmc1tsb29rdXBdO1xuICAgIH1cblxuICAgIHJlZnMucHVzaChvYmopO1xuXG4gICAgaWYgKEFycmF5LmlzQXJyYXkob2JqKSkge1xuICAgICAgICB2YXIgY29tcGFjdGVkID0gW107XG5cbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBvYmoubGVuZ3RoOyArK2kpIHtcbiAgICAgICAgICAgIGlmICh0eXBlb2Ygb2JqW2ldICE9PSAndW5kZWZpbmVkJykge1xuICAgICAgICAgICAgICAgIGNvbXBhY3RlZC5wdXNoKG9ialtpXSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gY29tcGFjdGVkO1xuICAgIH1cblxuICAgIHZhciBrZXlzID0gT2JqZWN0LmtleXMob2JqKTtcbiAgICBmb3IgKHZhciBqID0gMDsgaiA8IGtleXMubGVuZ3RoOyArK2opIHtcbiAgICAgICAgdmFyIGtleSA9IGtleXNbal07XG4gICAgICAgIG9ialtrZXldID0gZXhwb3J0cy5jb21wYWN0KG9ialtrZXldLCByZWZzKTtcbiAgICB9XG5cbiAgICByZXR1cm4gb2JqO1xufTtcblxuZXhwb3J0cy5pc1JlZ0V4cCA9IGZ1bmN0aW9uIChvYmopIHtcbiAgICByZXR1cm4gT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZy5jYWxsKG9iaikgPT09ICdbb2JqZWN0IFJlZ0V4cF0nO1xufTtcblxuZXhwb3J0cy5pc0J1ZmZlciA9IGZ1bmN0aW9uIChvYmopIHtcbiAgICBpZiAob2JqID09PSBudWxsIHx8IHR5cGVvZiBvYmogPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICByZXR1cm4gISEob2JqLmNvbnN0cnVjdG9yICYmIG9iai5jb25zdHJ1Y3Rvci5pc0J1ZmZlciAmJiBvYmouY29uc3RydWN0b3IuaXNCdWZmZXIob2JqKSk7XG59O1xuIiwidmFyIF9hcml0eSA9IHJlcXVpcmUoJy4vaW50ZXJuYWwvX2FyaXR5Jyk7XG52YXIgX2N1cnJ5MSA9IHJlcXVpcmUoJy4vaW50ZXJuYWwvX2N1cnJ5MScpO1xudmFyIF9jdXJyeTIgPSByZXF1aXJlKCcuL2ludGVybmFsL19jdXJyeTInKTtcbnZhciBfY3VycnlOID0gcmVxdWlyZSgnLi9pbnRlcm5hbC9fY3VycnlOJyk7XG5cblxuLyoqXG4gKiBSZXR1cm5zIGEgY3VycmllZCBlcXVpdmFsZW50IG9mIHRoZSBwcm92aWRlZCBmdW5jdGlvbiwgd2l0aCB0aGUgc3BlY2lmaWVkXG4gKiBhcml0eS4gVGhlIGN1cnJpZWQgZnVuY3Rpb24gaGFzIHR3byB1bnVzdWFsIGNhcGFiaWxpdGllcy4gRmlyc3QsIGl0c1xuICogYXJndW1lbnRzIG5lZWRuJ3QgYmUgcHJvdmlkZWQgb25lIGF0IGEgdGltZS4gSWYgYGdgIGlzIGBSLmN1cnJ5TigzLCBmKWAsIHRoZVxuICogZm9sbG93aW5nIGFyZSBlcXVpdmFsZW50OlxuICpcbiAqICAgLSBgZygxKSgyKSgzKWBcbiAqICAgLSBgZygxKSgyLCAzKWBcbiAqICAgLSBgZygxLCAyKSgzKWBcbiAqICAgLSBgZygxLCAyLCAzKWBcbiAqXG4gKiBTZWNvbmRseSwgdGhlIHNwZWNpYWwgcGxhY2Vob2xkZXIgdmFsdWUgYFIuX19gIG1heSBiZSB1c2VkIHRvIHNwZWNpZnlcbiAqIFwiZ2Fwc1wiLCBhbGxvd2luZyBwYXJ0aWFsIGFwcGxpY2F0aW9uIG9mIGFueSBjb21iaW5hdGlvbiBvZiBhcmd1bWVudHMsXG4gKiByZWdhcmRsZXNzIG9mIHRoZWlyIHBvc2l0aW9ucy4gSWYgYGdgIGlzIGFzIGFib3ZlIGFuZCBgX2AgaXMgYFIuX19gLCB0aGVcbiAqIGZvbGxvd2luZyBhcmUgZXF1aXZhbGVudDpcbiAqXG4gKiAgIC0gYGcoMSwgMiwgMylgXG4gKiAgIC0gYGcoXywgMiwgMykoMSlgXG4gKiAgIC0gYGcoXywgXywgMykoMSkoMilgXG4gKiAgIC0gYGcoXywgXywgMykoMSwgMilgXG4gKiAgIC0gYGcoXywgMikoMSkoMylgXG4gKiAgIC0gYGcoXywgMikoMSwgMylgXG4gKiAgIC0gYGcoXywgMikoXywgMykoMSlgXG4gKlxuICogQGZ1bmNcbiAqIEBtZW1iZXJPZiBSXG4gKiBAc2luY2UgdjAuNS4wXG4gKiBAY2F0ZWdvcnkgRnVuY3Rpb25cbiAqIEBzaWcgTnVtYmVyIC0+ICgqIC0+IGEpIC0+ICgqIC0+IGEpXG4gKiBAcGFyYW0ge051bWJlcn0gbGVuZ3RoIFRoZSBhcml0eSBmb3IgdGhlIHJldHVybmVkIGZ1bmN0aW9uLlxuICogQHBhcmFtIHtGdW5jdGlvbn0gZm4gVGhlIGZ1bmN0aW9uIHRvIGN1cnJ5LlxuICogQHJldHVybiB7RnVuY3Rpb259IEEgbmV3LCBjdXJyaWVkIGZ1bmN0aW9uLlxuICogQHNlZSBSLmN1cnJ5XG4gKiBAZXhhbXBsZVxuICpcbiAqICAgICAgdmFyIHN1bUFyZ3MgPSAoLi4uYXJncykgPT4gUi5zdW0oYXJncyk7XG4gKlxuICogICAgICB2YXIgY3VycmllZEFkZEZvdXJOdW1iZXJzID0gUi5jdXJyeU4oNCwgc3VtQXJncyk7XG4gKiAgICAgIHZhciBmID0gY3VycmllZEFkZEZvdXJOdW1iZXJzKDEsIDIpO1xuICogICAgICB2YXIgZyA9IGYoMyk7XG4gKiAgICAgIGcoNCk7IC8vPT4gMTBcbiAqL1xubW9kdWxlLmV4cG9ydHMgPSBfY3VycnkyKGZ1bmN0aW9uIGN1cnJ5TihsZW5ndGgsIGZuKSB7XG4gIGlmIChsZW5ndGggPT09IDEpIHtcbiAgICByZXR1cm4gX2N1cnJ5MShmbik7XG4gIH1cbiAgcmV0dXJuIF9hcml0eShsZW5ndGgsIF9jdXJyeU4obGVuZ3RoLCBbXSwgZm4pKTtcbn0pO1xuIiwibW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiBfYXJpdHkobiwgZm4pIHtcbiAgLyogZXNsaW50LWRpc2FibGUgbm8tdW51c2VkLXZhcnMgKi9cbiAgc3dpdGNoIChuKSB7XG4gICAgY2FzZSAwOiByZXR1cm4gZnVuY3Rpb24oKSB7IHJldHVybiBmbi5hcHBseSh0aGlzLCBhcmd1bWVudHMpOyB9O1xuICAgIGNhc2UgMTogcmV0dXJuIGZ1bmN0aW9uKGEwKSB7IHJldHVybiBmbi5hcHBseSh0aGlzLCBhcmd1bWVudHMpOyB9O1xuICAgIGNhc2UgMjogcmV0dXJuIGZ1bmN0aW9uKGEwLCBhMSkgeyByZXR1cm4gZm4uYXBwbHkodGhpcywgYXJndW1lbnRzKTsgfTtcbiAgICBjYXNlIDM6IHJldHVybiBmdW5jdGlvbihhMCwgYTEsIGEyKSB7IHJldHVybiBmbi5hcHBseSh0aGlzLCBhcmd1bWVudHMpOyB9O1xuICAgIGNhc2UgNDogcmV0dXJuIGZ1bmN0aW9uKGEwLCBhMSwgYTIsIGEzKSB7IHJldHVybiBmbi5hcHBseSh0aGlzLCBhcmd1bWVudHMpOyB9O1xuICAgIGNhc2UgNTogcmV0dXJuIGZ1bmN0aW9uKGEwLCBhMSwgYTIsIGEzLCBhNCkgeyByZXR1cm4gZm4uYXBwbHkodGhpcywgYXJndW1lbnRzKTsgfTtcbiAgICBjYXNlIDY6IHJldHVybiBmdW5jdGlvbihhMCwgYTEsIGEyLCBhMywgYTQsIGE1KSB7IHJldHVybiBmbi5hcHBseSh0aGlzLCBhcmd1bWVudHMpOyB9O1xuICAgIGNhc2UgNzogcmV0dXJuIGZ1bmN0aW9uKGEwLCBhMSwgYTIsIGEzLCBhNCwgYTUsIGE2KSB7IHJldHVybiBmbi5hcHBseSh0aGlzLCBhcmd1bWVudHMpOyB9O1xuICAgIGNhc2UgODogcmV0dXJuIGZ1bmN0aW9uKGEwLCBhMSwgYTIsIGEzLCBhNCwgYTUsIGE2LCBhNykgeyByZXR1cm4gZm4uYXBwbHkodGhpcywgYXJndW1lbnRzKTsgfTtcbiAgICBjYXNlIDk6IHJldHVybiBmdW5jdGlvbihhMCwgYTEsIGEyLCBhMywgYTQsIGE1LCBhNiwgYTcsIGE4KSB7IHJldHVybiBmbi5hcHBseSh0aGlzLCBhcmd1bWVudHMpOyB9O1xuICAgIGNhc2UgMTA6IHJldHVybiBmdW5jdGlvbihhMCwgYTEsIGEyLCBhMywgYTQsIGE1LCBhNiwgYTcsIGE4LCBhOSkgeyByZXR1cm4gZm4uYXBwbHkodGhpcywgYXJndW1lbnRzKTsgfTtcbiAgICBkZWZhdWx0OiB0aHJvdyBuZXcgRXJyb3IoJ0ZpcnN0IGFyZ3VtZW50IHRvIF9hcml0eSBtdXN0IGJlIGEgbm9uLW5lZ2F0aXZlIGludGVnZXIgbm8gZ3JlYXRlciB0aGFuIHRlbicpO1xuICB9XG59O1xuIiwidmFyIF9pc1BsYWNlaG9sZGVyID0gcmVxdWlyZSgnLi9faXNQbGFjZWhvbGRlcicpO1xuXG5cbi8qKlxuICogT3B0aW1pemVkIGludGVybmFsIG9uZS1hcml0eSBjdXJyeSBmdW5jdGlvbi5cbiAqXG4gKiBAcHJpdmF0ZVxuICogQGNhdGVnb3J5IEZ1bmN0aW9uXG4gKiBAcGFyYW0ge0Z1bmN0aW9ufSBmbiBUaGUgZnVuY3Rpb24gdG8gY3VycnkuXG4gKiBAcmV0dXJuIHtGdW5jdGlvbn0gVGhlIGN1cnJpZWQgZnVuY3Rpb24uXG4gKi9cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gX2N1cnJ5MShmbikge1xuICByZXR1cm4gZnVuY3Rpb24gZjEoYSkge1xuICAgIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAwIHx8IF9pc1BsYWNlaG9sZGVyKGEpKSB7XG4gICAgICByZXR1cm4gZjE7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiBmbi5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xuICAgIH1cbiAgfTtcbn07XG4iLCJ2YXIgX2N1cnJ5MSA9IHJlcXVpcmUoJy4vX2N1cnJ5MScpO1xudmFyIF9pc1BsYWNlaG9sZGVyID0gcmVxdWlyZSgnLi9faXNQbGFjZWhvbGRlcicpO1xuXG5cbi8qKlxuICogT3B0aW1pemVkIGludGVybmFsIHR3by1hcml0eSBjdXJyeSBmdW5jdGlvbi5cbiAqXG4gKiBAcHJpdmF0ZVxuICogQGNhdGVnb3J5IEZ1bmN0aW9uXG4gKiBAcGFyYW0ge0Z1bmN0aW9ufSBmbiBUaGUgZnVuY3Rpb24gdG8gY3VycnkuXG4gKiBAcmV0dXJuIHtGdW5jdGlvbn0gVGhlIGN1cnJpZWQgZnVuY3Rpb24uXG4gKi9cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gX2N1cnJ5Mihmbikge1xuICByZXR1cm4gZnVuY3Rpb24gZjIoYSwgYikge1xuICAgIHN3aXRjaCAoYXJndW1lbnRzLmxlbmd0aCkge1xuICAgICAgY2FzZSAwOlxuICAgICAgICByZXR1cm4gZjI7XG4gICAgICBjYXNlIDE6XG4gICAgICAgIHJldHVybiBfaXNQbGFjZWhvbGRlcihhKSA/IGYyXG4gICAgICAgICAgICAgOiBfY3VycnkxKGZ1bmN0aW9uKF9iKSB7IHJldHVybiBmbihhLCBfYik7IH0pO1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgcmV0dXJuIF9pc1BsYWNlaG9sZGVyKGEpICYmIF9pc1BsYWNlaG9sZGVyKGIpID8gZjJcbiAgICAgICAgICAgICA6IF9pc1BsYWNlaG9sZGVyKGEpID8gX2N1cnJ5MShmdW5jdGlvbihfYSkgeyByZXR1cm4gZm4oX2EsIGIpOyB9KVxuICAgICAgICAgICAgIDogX2lzUGxhY2Vob2xkZXIoYikgPyBfY3VycnkxKGZ1bmN0aW9uKF9iKSB7IHJldHVybiBmbihhLCBfYik7IH0pXG4gICAgICAgICAgICAgOiBmbihhLCBiKTtcbiAgICB9XG4gIH07XG59O1xuIiwidmFyIF9hcml0eSA9IHJlcXVpcmUoJy4vX2FyaXR5Jyk7XG52YXIgX2lzUGxhY2Vob2xkZXIgPSByZXF1aXJlKCcuL19pc1BsYWNlaG9sZGVyJyk7XG5cblxuLyoqXG4gKiBJbnRlcm5hbCBjdXJyeU4gZnVuY3Rpb24uXG4gKlxuICogQHByaXZhdGVcbiAqIEBjYXRlZ29yeSBGdW5jdGlvblxuICogQHBhcmFtIHtOdW1iZXJ9IGxlbmd0aCBUaGUgYXJpdHkgb2YgdGhlIGN1cnJpZWQgZnVuY3Rpb24uXG4gKiBAcGFyYW0ge0FycmF5fSByZWNlaXZlZCBBbiBhcnJheSBvZiBhcmd1bWVudHMgcmVjZWl2ZWQgdGh1cyBmYXIuXG4gKiBAcGFyYW0ge0Z1bmN0aW9ufSBmbiBUaGUgZnVuY3Rpb24gdG8gY3VycnkuXG4gKiBAcmV0dXJuIHtGdW5jdGlvbn0gVGhlIGN1cnJpZWQgZnVuY3Rpb24uXG4gKi9cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gX2N1cnJ5TihsZW5ndGgsIHJlY2VpdmVkLCBmbikge1xuICByZXR1cm4gZnVuY3Rpb24oKSB7XG4gICAgdmFyIGNvbWJpbmVkID0gW107XG4gICAgdmFyIGFyZ3NJZHggPSAwO1xuICAgIHZhciBsZWZ0ID0gbGVuZ3RoO1xuICAgIHZhciBjb21iaW5lZElkeCA9IDA7XG4gICAgd2hpbGUgKGNvbWJpbmVkSWR4IDwgcmVjZWl2ZWQubGVuZ3RoIHx8IGFyZ3NJZHggPCBhcmd1bWVudHMubGVuZ3RoKSB7XG4gICAgICB2YXIgcmVzdWx0O1xuICAgICAgaWYgKGNvbWJpbmVkSWR4IDwgcmVjZWl2ZWQubGVuZ3RoICYmXG4gICAgICAgICAgKCFfaXNQbGFjZWhvbGRlcihyZWNlaXZlZFtjb21iaW5lZElkeF0pIHx8XG4gICAgICAgICAgIGFyZ3NJZHggPj0gYXJndW1lbnRzLmxlbmd0aCkpIHtcbiAgICAgICAgcmVzdWx0ID0gcmVjZWl2ZWRbY29tYmluZWRJZHhdO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmVzdWx0ID0gYXJndW1lbnRzW2FyZ3NJZHhdO1xuICAgICAgICBhcmdzSWR4ICs9IDE7XG4gICAgICB9XG4gICAgICBjb21iaW5lZFtjb21iaW5lZElkeF0gPSByZXN1bHQ7XG4gICAgICBpZiAoIV9pc1BsYWNlaG9sZGVyKHJlc3VsdCkpIHtcbiAgICAgICAgbGVmdCAtPSAxO1xuICAgICAgfVxuICAgICAgY29tYmluZWRJZHggKz0gMTtcbiAgICB9XG4gICAgcmV0dXJuIGxlZnQgPD0gMCA/IGZuLmFwcGx5KHRoaXMsIGNvbWJpbmVkKVxuICAgICAgICAgICAgICAgICAgICAgOiBfYXJpdHkobGVmdCwgX2N1cnJ5TihsZW5ndGgsIGNvbWJpbmVkLCBmbikpO1xuICB9O1xufTtcbiIsIm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gX2lzUGxhY2Vob2xkZXIoYSkge1xuICByZXR1cm4gYSAhPSBudWxsICYmXG4gICAgICAgICB0eXBlb2YgYSA9PT0gJ29iamVjdCcgJiZcbiAgICAgICAgIGFbJ0BAZnVuY3Rpb25hbC9wbGFjZWhvbGRlciddID09PSB0cnVlO1xufTtcbiIsInZhciBWTm9kZSA9IHJlcXVpcmUoJy4vdm5vZGUnKTtcbnZhciBpcyA9IHJlcXVpcmUoJy4vaXMnKTtcblxuZnVuY3Rpb24gYWRkTlMoZGF0YSwgY2hpbGRyZW4pIHtcbiAgZGF0YS5ucyA9ICdodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Zyc7XG4gIGlmIChjaGlsZHJlbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBjaGlsZHJlbi5sZW5ndGg7ICsraSkge1xuICAgICAgYWRkTlMoY2hpbGRyZW5baV0uZGF0YSwgY2hpbGRyZW5baV0uY2hpbGRyZW4pO1xuICAgIH1cbiAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIGgoc2VsLCBiLCBjKSB7XG4gIHZhciBkYXRhID0ge30sIGNoaWxkcmVuLCB0ZXh0LCBpO1xuICBpZiAoYyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgZGF0YSA9IGI7XG4gICAgaWYgKGlzLmFycmF5KGMpKSB7IGNoaWxkcmVuID0gYzsgfVxuICAgIGVsc2UgaWYgKGlzLnByaW1pdGl2ZShjKSkgeyB0ZXh0ID0gYzsgfVxuICB9IGVsc2UgaWYgKGIgIT09IHVuZGVmaW5lZCkge1xuICAgIGlmIChpcy5hcnJheShiKSkgeyBjaGlsZHJlbiA9IGI7IH1cbiAgICBlbHNlIGlmIChpcy5wcmltaXRpdmUoYikpIHsgdGV4dCA9IGI7IH1cbiAgICBlbHNlIHsgZGF0YSA9IGI7IH1cbiAgfVxuICBpZiAoaXMuYXJyYXkoY2hpbGRyZW4pKSB7XG4gICAgZm9yIChpID0gMDsgaSA8IGNoaWxkcmVuLmxlbmd0aDsgKytpKSB7XG4gICAgICBpZiAoaXMucHJpbWl0aXZlKGNoaWxkcmVuW2ldKSkgY2hpbGRyZW5baV0gPSBWTm9kZSh1bmRlZmluZWQsIHVuZGVmaW5lZCwgdW5kZWZpbmVkLCBjaGlsZHJlbltpXSk7XG4gICAgfVxuICB9XG4gIGlmIChzZWxbMF0gPT09ICdzJyAmJiBzZWxbMV0gPT09ICd2JyAmJiBzZWxbMl0gPT09ICdnJykge1xuICAgIGFkZE5TKGRhdGEsIGNoaWxkcmVuKTtcbiAgfVxuICByZXR1cm4gVk5vZGUoc2VsLCBkYXRhLCBjaGlsZHJlbiwgdGV4dCwgdW5kZWZpbmVkKTtcbn07XG4iLCJmdW5jdGlvbiBjcmVhdGVFbGVtZW50KHRhZ05hbWUpe1xuICByZXR1cm4gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCh0YWdOYW1lKTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlRWxlbWVudE5TKG5hbWVzcGFjZVVSSSwgcXVhbGlmaWVkTmFtZSl7XG4gIHJldHVybiBkb2N1bWVudC5jcmVhdGVFbGVtZW50TlMobmFtZXNwYWNlVVJJLCBxdWFsaWZpZWROYW1lKTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlVGV4dE5vZGUodGV4dCl7XG4gIHJldHVybiBkb2N1bWVudC5jcmVhdGVUZXh0Tm9kZSh0ZXh0KTtcbn1cblxuXG5mdW5jdGlvbiBpbnNlcnRCZWZvcmUocGFyZW50Tm9kZSwgbmV3Tm9kZSwgcmVmZXJlbmNlTm9kZSl7XG4gIHBhcmVudE5vZGUuaW5zZXJ0QmVmb3JlKG5ld05vZGUsIHJlZmVyZW5jZU5vZGUpO1xufVxuXG5cbmZ1bmN0aW9uIHJlbW92ZUNoaWxkKG5vZGUsIGNoaWxkKXtcbiAgbm9kZS5yZW1vdmVDaGlsZChjaGlsZCk7XG59XG5cbmZ1bmN0aW9uIGFwcGVuZENoaWxkKG5vZGUsIGNoaWxkKXtcbiAgbm9kZS5hcHBlbmRDaGlsZChjaGlsZCk7XG59XG5cbmZ1bmN0aW9uIHBhcmVudE5vZGUobm9kZSl7XG4gIHJldHVybiBub2RlLnBhcmVudEVsZW1lbnQ7XG59XG5cbmZ1bmN0aW9uIG5leHRTaWJsaW5nKG5vZGUpe1xuICByZXR1cm4gbm9kZS5uZXh0U2libGluZztcbn1cblxuZnVuY3Rpb24gdGFnTmFtZShub2RlKXtcbiAgcmV0dXJuIG5vZGUudGFnTmFtZTtcbn1cblxuZnVuY3Rpb24gc2V0VGV4dENvbnRlbnQobm9kZSwgdGV4dCl7XG4gIG5vZGUudGV4dENvbnRlbnQgPSB0ZXh0O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IHtcbiAgY3JlYXRlRWxlbWVudDogY3JlYXRlRWxlbWVudCxcbiAgY3JlYXRlRWxlbWVudE5TOiBjcmVhdGVFbGVtZW50TlMsXG4gIGNyZWF0ZVRleHROb2RlOiBjcmVhdGVUZXh0Tm9kZSxcbiAgYXBwZW5kQ2hpbGQ6IGFwcGVuZENoaWxkLFxuICByZW1vdmVDaGlsZDogcmVtb3ZlQ2hpbGQsXG4gIGluc2VydEJlZm9yZTogaW5zZXJ0QmVmb3JlLFxuICBwYXJlbnROb2RlOiBwYXJlbnROb2RlLFxuICBuZXh0U2libGluZzogbmV4dFNpYmxpbmcsXG4gIHRhZ05hbWU6IHRhZ05hbWUsXG4gIHNldFRleHRDb250ZW50OiBzZXRUZXh0Q29udGVudFxufTtcbiIsIm1vZHVsZS5leHBvcnRzID0ge1xuICBhcnJheTogQXJyYXkuaXNBcnJheSxcbiAgcHJpbWl0aXZlOiBmdW5jdGlvbihzKSB7IHJldHVybiB0eXBlb2YgcyA9PT0gJ3N0cmluZycgfHwgdHlwZW9mIHMgPT09ICdudW1iZXInOyB9LFxufTtcbiIsInZhciBib29sZWFuQXR0cnMgPSBbXCJhbGxvd2Z1bGxzY3JlZW5cIiwgXCJhc3luY1wiLCBcImF1dG9mb2N1c1wiLCBcImF1dG9wbGF5XCIsIFwiY2hlY2tlZFwiLCBcImNvbXBhY3RcIiwgXCJjb250cm9sc1wiLCBcImRlY2xhcmVcIiwgXG4gICAgICAgICAgICAgICAgXCJkZWZhdWx0XCIsIFwiZGVmYXVsdGNoZWNrZWRcIiwgXCJkZWZhdWx0bXV0ZWRcIiwgXCJkZWZhdWx0c2VsZWN0ZWRcIiwgXCJkZWZlclwiLCBcImRpc2FibGVkXCIsIFwiZHJhZ2dhYmxlXCIsIFxuICAgICAgICAgICAgICAgIFwiZW5hYmxlZFwiLCBcImZvcm1ub3ZhbGlkYXRlXCIsIFwiaGlkZGVuXCIsIFwiaW5kZXRlcm1pbmF0ZVwiLCBcImluZXJ0XCIsIFwiaXNtYXBcIiwgXCJpdGVtc2NvcGVcIiwgXCJsb29wXCIsIFwibXVsdGlwbGVcIiwgXG4gICAgICAgICAgICAgICAgXCJtdXRlZFwiLCBcIm5vaHJlZlwiLCBcIm5vcmVzaXplXCIsIFwibm9zaGFkZVwiLCBcIm5vdmFsaWRhdGVcIiwgXCJub3dyYXBcIiwgXCJvcGVuXCIsIFwicGF1c2VvbmV4aXRcIiwgXCJyZWFkb25seVwiLCBcbiAgICAgICAgICAgICAgICBcInJlcXVpcmVkXCIsIFwicmV2ZXJzZWRcIiwgXCJzY29wZWRcIiwgXCJzZWFtbGVzc1wiLCBcInNlbGVjdGVkXCIsIFwic29ydGFibGVcIiwgXCJzcGVsbGNoZWNrXCIsIFwidHJhbnNsYXRlXCIsIFxuICAgICAgICAgICAgICAgIFwidHJ1ZXNwZWVkXCIsIFwidHlwZW11c3RtYXRjaFwiLCBcInZpc2libGVcIl07XG4gICAgXG52YXIgYm9vbGVhbkF0dHJzRGljdCA9IHt9O1xuZm9yKHZhciBpPTAsIGxlbiA9IGJvb2xlYW5BdHRycy5sZW5ndGg7IGkgPCBsZW47IGkrKykge1xuICBib29sZWFuQXR0cnNEaWN0W2Jvb2xlYW5BdHRyc1tpXV0gPSB0cnVlO1xufVxuICAgIFxuZnVuY3Rpb24gdXBkYXRlQXR0cnMob2xkVm5vZGUsIHZub2RlKSB7XG4gIHZhciBrZXksIGN1ciwgb2xkLCBlbG0gPSB2bm9kZS5lbG0sXG4gICAgICBvbGRBdHRycyA9IG9sZFZub2RlLmRhdGEuYXR0cnMgfHwge30sIGF0dHJzID0gdm5vZGUuZGF0YS5hdHRycyB8fCB7fTtcbiAgXG4gIC8vIHVwZGF0ZSBtb2RpZmllZCBhdHRyaWJ1dGVzLCBhZGQgbmV3IGF0dHJpYnV0ZXNcbiAgZm9yIChrZXkgaW4gYXR0cnMpIHtcbiAgICBjdXIgPSBhdHRyc1trZXldO1xuICAgIG9sZCA9IG9sZEF0dHJzW2tleV07XG4gICAgaWYgKG9sZCAhPT0gY3VyKSB7XG4gICAgICAvLyBUT0RPOiBhZGQgc3VwcG9ydCB0byBuYW1lc3BhY2VkIGF0dHJpYnV0ZXMgKHNldEF0dHJpYnV0ZU5TKVxuICAgICAgaWYoIWN1ciAmJiBib29sZWFuQXR0cnNEaWN0W2tleV0pXG4gICAgICAgIGVsbS5yZW1vdmVBdHRyaWJ1dGUoa2V5KTtcbiAgICAgIGVsc2VcbiAgICAgICAgZWxtLnNldEF0dHJpYnV0ZShrZXksIGN1cik7XG4gICAgfVxuICB9XG4gIC8vcmVtb3ZlIHJlbW92ZWQgYXR0cmlidXRlc1xuICAvLyB1c2UgYGluYCBvcGVyYXRvciBzaW5jZSB0aGUgcHJldmlvdXMgYGZvcmAgaXRlcmF0aW9uIHVzZXMgaXQgKC5pLmUuIGFkZCBldmVuIGF0dHJpYnV0ZXMgd2l0aCB1bmRlZmluZWQgdmFsdWUpXG4gIC8vIHRoZSBvdGhlciBvcHRpb24gaXMgdG8gcmVtb3ZlIGFsbCBhdHRyaWJ1dGVzIHdpdGggdmFsdWUgPT0gdW5kZWZpbmVkXG4gIGZvciAoa2V5IGluIG9sZEF0dHJzKSB7XG4gICAgaWYgKCEoa2V5IGluIGF0dHJzKSkge1xuICAgICAgZWxtLnJlbW92ZUF0dHJpYnV0ZShrZXkpO1xuICAgIH1cbiAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IHtjcmVhdGU6IHVwZGF0ZUF0dHJzLCB1cGRhdGU6IHVwZGF0ZUF0dHJzfTtcbiIsImZ1bmN0aW9uIHVwZGF0ZUNsYXNzKG9sZFZub2RlLCB2bm9kZSkge1xuICB2YXIgY3VyLCBuYW1lLCBlbG0gPSB2bm9kZS5lbG0sXG4gICAgICBvbGRDbGFzcyA9IG9sZFZub2RlLmRhdGEuY2xhc3MgfHwge30sXG4gICAgICBrbGFzcyA9IHZub2RlLmRhdGEuY2xhc3MgfHwge307XG4gIGZvciAobmFtZSBpbiBvbGRDbGFzcykge1xuICAgIGlmICgha2xhc3NbbmFtZV0pIHtcbiAgICAgIGVsbS5jbGFzc0xpc3QucmVtb3ZlKG5hbWUpO1xuICAgIH1cbiAgfVxuICBmb3IgKG5hbWUgaW4ga2xhc3MpIHtcbiAgICBjdXIgPSBrbGFzc1tuYW1lXTtcbiAgICBpZiAoY3VyICE9PSBvbGRDbGFzc1tuYW1lXSkge1xuICAgICAgZWxtLmNsYXNzTGlzdFtjdXIgPyAnYWRkJyA6ICdyZW1vdmUnXShuYW1lKTtcbiAgICB9XG4gIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSB7Y3JlYXRlOiB1cGRhdGVDbGFzcywgdXBkYXRlOiB1cGRhdGVDbGFzc307XG4iLCJ2YXIgaXMgPSByZXF1aXJlKCcuLi9pcycpO1xuXG5mdW5jdGlvbiBhcnJJbnZva2VyKGFycikge1xuICByZXR1cm4gZnVuY3Rpb24oKSB7XG4gICAgaWYgKCFhcnIubGVuZ3RoKSByZXR1cm47XG4gICAgLy8gU3BlY2lhbCBjYXNlIHdoZW4gbGVuZ3RoIGlzIHR3bywgZm9yIHBlcmZvcm1hbmNlXG4gICAgYXJyLmxlbmd0aCA9PT0gMiA/IGFyclswXShhcnJbMV0pIDogYXJyWzBdLmFwcGx5KHVuZGVmaW5lZCwgYXJyLnNsaWNlKDEpKTtcbiAgfTtcbn1cblxuZnVuY3Rpb24gZm5JbnZva2VyKG8pIHtcbiAgcmV0dXJuIGZ1bmN0aW9uKGV2KSB7IFxuICAgIGlmIChvLmZuID09PSBudWxsKSByZXR1cm47XG4gICAgby5mbihldik7IFxuICB9O1xufVxuXG5mdW5jdGlvbiB1cGRhdGVFdmVudExpc3RlbmVycyhvbGRWbm9kZSwgdm5vZGUpIHtcbiAgdmFyIG5hbWUsIGN1ciwgb2xkLCBlbG0gPSB2bm9kZS5lbG0sXG4gICAgICBvbGRPbiA9IG9sZFZub2RlLmRhdGEub24gfHwge30sIG9uID0gdm5vZGUuZGF0YS5vbjtcbiAgaWYgKCFvbikgcmV0dXJuO1xuICBmb3IgKG5hbWUgaW4gb24pIHtcbiAgICBjdXIgPSBvbltuYW1lXTtcbiAgICBvbGQgPSBvbGRPbltuYW1lXTtcbiAgICBpZiAob2xkID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGlmIChpcy5hcnJheShjdXIpKSB7XG4gICAgICAgIGVsbS5hZGRFdmVudExpc3RlbmVyKG5hbWUsIGFyckludm9rZXIoY3VyKSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjdXIgPSB7Zm46IGN1cn07XG4gICAgICAgIG9uW25hbWVdID0gY3VyO1xuICAgICAgICBlbG0uYWRkRXZlbnRMaXN0ZW5lcihuYW1lLCBmbkludm9rZXIoY3VyKSk7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmIChpcy5hcnJheShvbGQpKSB7XG4gICAgICAvLyBEZWxpYmVyYXRlbHkgbW9kaWZ5IG9sZCBhcnJheSBzaW5jZSBpdCdzIGNhcHR1cmVkIGluIGNsb3N1cmUgY3JlYXRlZCB3aXRoIGBhcnJJbnZva2VyYFxuICAgICAgb2xkLmxlbmd0aCA9IGN1ci5sZW5ndGg7XG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IG9sZC5sZW5ndGg7ICsraSkgb2xkW2ldID0gY3VyW2ldO1xuICAgICAgb25bbmFtZV0gID0gb2xkO1xuICAgIH0gZWxzZSB7XG4gICAgICBvbGQuZm4gPSBjdXI7XG4gICAgICBvbltuYW1lXSA9IG9sZDtcbiAgICB9XG4gIH1cbiAgaWYgKG9sZE9uKSB7XG4gICAgZm9yIChuYW1lIGluIG9sZE9uKSB7XG4gICAgICBpZiAob25bbmFtZV0gPT09IHVuZGVmaW5lZCkge1xuICAgICAgICB2YXIgb2xkID0gb2xkT25bbmFtZV07XG4gICAgICAgIGlmIChpcy5hcnJheShvbGQpKSB7XG4gICAgICAgICAgb2xkLmxlbmd0aCA9IDA7XG4gICAgICAgIH1cbiAgICAgICAgZWxzZSB7XG4gICAgICAgICAgb2xkLmZuID0gbnVsbDtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IHtjcmVhdGU6IHVwZGF0ZUV2ZW50TGlzdGVuZXJzLCB1cGRhdGU6IHVwZGF0ZUV2ZW50TGlzdGVuZXJzfTtcbiIsImZ1bmN0aW9uIHVwZGF0ZVByb3BzKG9sZFZub2RlLCB2bm9kZSkge1xuICB2YXIga2V5LCBjdXIsIG9sZCwgZWxtID0gdm5vZGUuZWxtLFxuICAgICAgb2xkUHJvcHMgPSBvbGRWbm9kZS5kYXRhLnByb3BzIHx8IHt9LCBwcm9wcyA9IHZub2RlLmRhdGEucHJvcHMgfHwge307XG4gIGZvciAoa2V5IGluIG9sZFByb3BzKSB7XG4gICAgaWYgKCFwcm9wc1trZXldKSB7XG4gICAgICBkZWxldGUgZWxtW2tleV07XG4gICAgfVxuICB9XG4gIGZvciAoa2V5IGluIHByb3BzKSB7XG4gICAgY3VyID0gcHJvcHNba2V5XTtcbiAgICBvbGQgPSBvbGRQcm9wc1trZXldO1xuICAgIGlmIChvbGQgIT09IGN1ciAmJiAoa2V5ICE9PSAndmFsdWUnIHx8IGVsbVtrZXldICE9PSBjdXIpKSB7XG4gICAgICBlbG1ba2V5XSA9IGN1cjtcbiAgICB9XG4gIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSB7Y3JlYXRlOiB1cGRhdGVQcm9wcywgdXBkYXRlOiB1cGRhdGVQcm9wc307XG4iLCJ2YXIgcmFmID0gKHR5cGVvZiB3aW5kb3cgIT09ICd1bmRlZmluZWQnICYmIHdpbmRvdy5yZXF1ZXN0QW5pbWF0aW9uRnJhbWUpIHx8IHNldFRpbWVvdXQ7XG52YXIgbmV4dEZyYW1lID0gZnVuY3Rpb24oZm4pIHsgcmFmKGZ1bmN0aW9uKCkgeyByYWYoZm4pOyB9KTsgfTtcblxuZnVuY3Rpb24gc2V0TmV4dEZyYW1lKG9iaiwgcHJvcCwgdmFsKSB7XG4gIG5leHRGcmFtZShmdW5jdGlvbigpIHsgb2JqW3Byb3BdID0gdmFsOyB9KTtcbn1cblxuZnVuY3Rpb24gdXBkYXRlU3R5bGUob2xkVm5vZGUsIHZub2RlKSB7XG4gIHZhciBjdXIsIG5hbWUsIGVsbSA9IHZub2RlLmVsbSxcbiAgICAgIG9sZFN0eWxlID0gb2xkVm5vZGUuZGF0YS5zdHlsZSB8fCB7fSxcbiAgICAgIHN0eWxlID0gdm5vZGUuZGF0YS5zdHlsZSB8fCB7fSxcbiAgICAgIG9sZEhhc0RlbCA9ICdkZWxheWVkJyBpbiBvbGRTdHlsZTtcbiAgZm9yIChuYW1lIGluIG9sZFN0eWxlKSB7XG4gICAgaWYgKCFzdHlsZVtuYW1lXSkge1xuICAgICAgZWxtLnN0eWxlW25hbWVdID0gJyc7XG4gICAgfVxuICB9XG4gIGZvciAobmFtZSBpbiBzdHlsZSkge1xuICAgIGN1ciA9IHN0eWxlW25hbWVdO1xuICAgIGlmIChuYW1lID09PSAnZGVsYXllZCcpIHtcbiAgICAgIGZvciAobmFtZSBpbiBzdHlsZS5kZWxheWVkKSB7XG4gICAgICAgIGN1ciA9IHN0eWxlLmRlbGF5ZWRbbmFtZV07XG4gICAgICAgIGlmICghb2xkSGFzRGVsIHx8IGN1ciAhPT0gb2xkU3R5bGUuZGVsYXllZFtuYW1lXSkge1xuICAgICAgICAgIHNldE5leHRGcmFtZShlbG0uc3R5bGUsIG5hbWUsIGN1cik7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKG5hbWUgIT09ICdyZW1vdmUnICYmIGN1ciAhPT0gb2xkU3R5bGVbbmFtZV0pIHtcbiAgICAgIGVsbS5zdHlsZVtuYW1lXSA9IGN1cjtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gYXBwbHlEZXN0cm95U3R5bGUodm5vZGUpIHtcbiAgdmFyIHN0eWxlLCBuYW1lLCBlbG0gPSB2bm9kZS5lbG0sIHMgPSB2bm9kZS5kYXRhLnN0eWxlO1xuICBpZiAoIXMgfHwgIShzdHlsZSA9IHMuZGVzdHJveSkpIHJldHVybjtcbiAgZm9yIChuYW1lIGluIHN0eWxlKSB7XG4gICAgZWxtLnN0eWxlW25hbWVdID0gc3R5bGVbbmFtZV07XG4gIH1cbn1cblxuZnVuY3Rpb24gYXBwbHlSZW1vdmVTdHlsZSh2bm9kZSwgcm0pIHtcbiAgdmFyIHMgPSB2bm9kZS5kYXRhLnN0eWxlO1xuICBpZiAoIXMgfHwgIXMucmVtb3ZlKSB7XG4gICAgcm0oKTtcbiAgICByZXR1cm47XG4gIH1cbiAgdmFyIG5hbWUsIGVsbSA9IHZub2RlLmVsbSwgaWR4LCBpID0gMCwgbWF4RHVyID0gMCxcbiAgICAgIGNvbXBTdHlsZSwgc3R5bGUgPSBzLnJlbW92ZSwgYW1vdW50ID0gMCwgYXBwbGllZCA9IFtdO1xuICBmb3IgKG5hbWUgaW4gc3R5bGUpIHtcbiAgICBhcHBsaWVkLnB1c2gobmFtZSk7XG4gICAgZWxtLnN0eWxlW25hbWVdID0gc3R5bGVbbmFtZV07XG4gIH1cbiAgY29tcFN0eWxlID0gZ2V0Q29tcHV0ZWRTdHlsZShlbG0pO1xuICB2YXIgcHJvcHMgPSBjb21wU3R5bGVbJ3RyYW5zaXRpb24tcHJvcGVydHknXS5zcGxpdCgnLCAnKTtcbiAgZm9yICg7IGkgPCBwcm9wcy5sZW5ndGg7ICsraSkge1xuICAgIGlmKGFwcGxpZWQuaW5kZXhPZihwcm9wc1tpXSkgIT09IC0xKSBhbW91bnQrKztcbiAgfVxuICBlbG0uYWRkRXZlbnRMaXN0ZW5lcigndHJhbnNpdGlvbmVuZCcsIGZ1bmN0aW9uKGV2KSB7XG4gICAgaWYgKGV2LnRhcmdldCA9PT0gZWxtKSAtLWFtb3VudDtcbiAgICBpZiAoYW1vdW50ID09PSAwKSBybSgpO1xuICB9KTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSB7Y3JlYXRlOiB1cGRhdGVTdHlsZSwgdXBkYXRlOiB1cGRhdGVTdHlsZSwgZGVzdHJveTogYXBwbHlEZXN0cm95U3R5bGUsIHJlbW92ZTogYXBwbHlSZW1vdmVTdHlsZX07XG4iLCIvLyBqc2hpbnQgbmV3Y2FwOiBmYWxzZVxuLyogZ2xvYmFsIHJlcXVpcmUsIG1vZHVsZSwgZG9jdW1lbnQsIE5vZGUgKi9cbid1c2Ugc3RyaWN0JztcblxudmFyIFZOb2RlID0gcmVxdWlyZSgnLi92bm9kZScpO1xudmFyIGlzID0gcmVxdWlyZSgnLi9pcycpO1xudmFyIGRvbUFwaSA9IHJlcXVpcmUoJy4vaHRtbGRvbWFwaScpO1xuXG5mdW5jdGlvbiBpc1VuZGVmKHMpIHsgcmV0dXJuIHMgPT09IHVuZGVmaW5lZDsgfVxuZnVuY3Rpb24gaXNEZWYocykgeyByZXR1cm4gcyAhPT0gdW5kZWZpbmVkOyB9XG5cbnZhciBlbXB0eU5vZGUgPSBWTm9kZSgnJywge30sIFtdLCB1bmRlZmluZWQsIHVuZGVmaW5lZCk7XG5cbmZ1bmN0aW9uIHNhbWVWbm9kZSh2bm9kZTEsIHZub2RlMikge1xuICByZXR1cm4gdm5vZGUxLmtleSA9PT0gdm5vZGUyLmtleSAmJiB2bm9kZTEuc2VsID09PSB2bm9kZTIuc2VsO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVLZXlUb09sZElkeChjaGlsZHJlbiwgYmVnaW5JZHgsIGVuZElkeCkge1xuICB2YXIgaSwgbWFwID0ge30sIGtleTtcbiAgZm9yIChpID0gYmVnaW5JZHg7IGkgPD0gZW5kSWR4OyArK2kpIHtcbiAgICBrZXkgPSBjaGlsZHJlbltpXS5rZXk7XG4gICAgaWYgKGlzRGVmKGtleSkpIG1hcFtrZXldID0gaTtcbiAgfVxuICByZXR1cm4gbWFwO1xufVxuXG52YXIgaG9va3MgPSBbJ2NyZWF0ZScsICd1cGRhdGUnLCAncmVtb3ZlJywgJ2Rlc3Ryb3knLCAncHJlJywgJ3Bvc3QnXTtcblxuZnVuY3Rpb24gaW5pdChtb2R1bGVzLCBhcGkpIHtcbiAgdmFyIGksIGosIGNicyA9IHt9O1xuXG4gIGlmIChpc1VuZGVmKGFwaSkpIGFwaSA9IGRvbUFwaTtcblxuICBmb3IgKGkgPSAwOyBpIDwgaG9va3MubGVuZ3RoOyArK2kpIHtcbiAgICBjYnNbaG9va3NbaV1dID0gW107XG4gICAgZm9yIChqID0gMDsgaiA8IG1vZHVsZXMubGVuZ3RoOyArK2opIHtcbiAgICAgIGlmIChtb2R1bGVzW2pdW2hvb2tzW2ldXSAhPT0gdW5kZWZpbmVkKSBjYnNbaG9va3NbaV1dLnB1c2gobW9kdWxlc1tqXVtob29rc1tpXV0pO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIGVtcHR5Tm9kZUF0KGVsbSkge1xuICAgIHJldHVybiBWTm9kZShhcGkudGFnTmFtZShlbG0pLnRvTG93ZXJDYXNlKCksIHt9LCBbXSwgdW5kZWZpbmVkLCBlbG0pO1xuICB9XG5cbiAgZnVuY3Rpb24gY3JlYXRlUm1DYihjaGlsZEVsbSwgbGlzdGVuZXJzKSB7XG4gICAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgICAgaWYgKC0tbGlzdGVuZXJzID09PSAwKSB7XG4gICAgICAgIHZhciBwYXJlbnQgPSBhcGkucGFyZW50Tm9kZShjaGlsZEVsbSk7XG4gICAgICAgIGFwaS5yZW1vdmVDaGlsZChwYXJlbnQsIGNoaWxkRWxtKTtcbiAgICAgIH1cbiAgICB9O1xuICB9XG5cbiAgZnVuY3Rpb24gY3JlYXRlRWxtKHZub2RlLCBpbnNlcnRlZFZub2RlUXVldWUpIHtcbiAgICB2YXIgaSwgZGF0YSA9IHZub2RlLmRhdGE7XG4gICAgaWYgKGlzRGVmKGRhdGEpKSB7XG4gICAgICBpZiAoaXNEZWYoaSA9IGRhdGEuaG9vaykgJiYgaXNEZWYoaSA9IGkuaW5pdCkpIHtcbiAgICAgICAgaSh2bm9kZSk7XG4gICAgICAgIGRhdGEgPSB2bm9kZS5kYXRhO1xuICAgICAgfVxuICAgIH1cbiAgICB2YXIgZWxtLCBjaGlsZHJlbiA9IHZub2RlLmNoaWxkcmVuLCBzZWwgPSB2bm9kZS5zZWw7XG4gICAgaWYgKGlzRGVmKHNlbCkpIHtcbiAgICAgIC8vIFBhcnNlIHNlbGVjdG9yXG4gICAgICB2YXIgaGFzaElkeCA9IHNlbC5pbmRleE9mKCcjJyk7XG4gICAgICB2YXIgZG90SWR4ID0gc2VsLmluZGV4T2YoJy4nLCBoYXNoSWR4KTtcbiAgICAgIHZhciBoYXNoID0gaGFzaElkeCA+IDAgPyBoYXNoSWR4IDogc2VsLmxlbmd0aDtcbiAgICAgIHZhciBkb3QgPSBkb3RJZHggPiAwID8gZG90SWR4IDogc2VsLmxlbmd0aDtcbiAgICAgIHZhciB0YWcgPSBoYXNoSWR4ICE9PSAtMSB8fCBkb3RJZHggIT09IC0xID8gc2VsLnNsaWNlKDAsIE1hdGgubWluKGhhc2gsIGRvdCkpIDogc2VsO1xuICAgICAgZWxtID0gdm5vZGUuZWxtID0gaXNEZWYoZGF0YSkgJiYgaXNEZWYoaSA9IGRhdGEubnMpID8gYXBpLmNyZWF0ZUVsZW1lbnROUyhpLCB0YWcpXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgOiBhcGkuY3JlYXRlRWxlbWVudCh0YWcpO1xuICAgICAgaWYgKGhhc2ggPCBkb3QpIGVsbS5pZCA9IHNlbC5zbGljZShoYXNoICsgMSwgZG90KTtcbiAgICAgIGlmIChkb3RJZHggPiAwKSBlbG0uY2xhc3NOYW1lID0gc2VsLnNsaWNlKGRvdCsxKS5yZXBsYWNlKC9cXC4vZywgJyAnKTtcbiAgICAgIGlmIChpcy5hcnJheShjaGlsZHJlbikpIHtcbiAgICAgICAgZm9yIChpID0gMDsgaSA8IGNoaWxkcmVuLmxlbmd0aDsgKytpKSB7XG4gICAgICAgICAgYXBpLmFwcGVuZENoaWxkKGVsbSwgY3JlYXRlRWxtKGNoaWxkcmVuW2ldLCBpbnNlcnRlZFZub2RlUXVldWUpKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmIChpcy5wcmltaXRpdmUodm5vZGUudGV4dCkpIHtcbiAgICAgICAgYXBpLmFwcGVuZENoaWxkKGVsbSwgYXBpLmNyZWF0ZVRleHROb2RlKHZub2RlLnRleHQpKTtcbiAgICAgIH1cbiAgICAgIGZvciAoaSA9IDA7IGkgPCBjYnMuY3JlYXRlLmxlbmd0aDsgKytpKSBjYnMuY3JlYXRlW2ldKGVtcHR5Tm9kZSwgdm5vZGUpO1xuICAgICAgaSA9IHZub2RlLmRhdGEuaG9vazsgLy8gUmV1c2UgdmFyaWFibGVcbiAgICAgIGlmIChpc0RlZihpKSkge1xuICAgICAgICBpZiAoaS5jcmVhdGUpIGkuY3JlYXRlKGVtcHR5Tm9kZSwgdm5vZGUpO1xuICAgICAgICBpZiAoaS5pbnNlcnQpIGluc2VydGVkVm5vZGVRdWV1ZS5wdXNoKHZub2RlKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgZWxtID0gdm5vZGUuZWxtID0gYXBpLmNyZWF0ZVRleHROb2RlKHZub2RlLnRleHQpO1xuICAgIH1cbiAgICByZXR1cm4gdm5vZGUuZWxtO1xuICB9XG5cbiAgZnVuY3Rpb24gYWRkVm5vZGVzKHBhcmVudEVsbSwgYmVmb3JlLCB2bm9kZXMsIHN0YXJ0SWR4LCBlbmRJZHgsIGluc2VydGVkVm5vZGVRdWV1ZSkge1xuICAgIGZvciAoOyBzdGFydElkeCA8PSBlbmRJZHg7ICsrc3RhcnRJZHgpIHtcbiAgICAgIGFwaS5pbnNlcnRCZWZvcmUocGFyZW50RWxtLCBjcmVhdGVFbG0odm5vZGVzW3N0YXJ0SWR4XSwgaW5zZXJ0ZWRWbm9kZVF1ZXVlKSwgYmVmb3JlKTtcbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBpbnZva2VEZXN0cm95SG9vayh2bm9kZSkge1xuICAgIHZhciBpLCBqLCBkYXRhID0gdm5vZGUuZGF0YTtcbiAgICBpZiAoaXNEZWYoZGF0YSkpIHtcbiAgICAgIGlmIChpc0RlZihpID0gZGF0YS5ob29rKSAmJiBpc0RlZihpID0gaS5kZXN0cm95KSkgaSh2bm9kZSk7XG4gICAgICBmb3IgKGkgPSAwOyBpIDwgY2JzLmRlc3Ryb3kubGVuZ3RoOyArK2kpIGNicy5kZXN0cm95W2ldKHZub2RlKTtcbiAgICAgIGlmIChpc0RlZihpID0gdm5vZGUuY2hpbGRyZW4pKSB7XG4gICAgICAgIGZvciAoaiA9IDA7IGogPCB2bm9kZS5jaGlsZHJlbi5sZW5ndGg7ICsraikge1xuICAgICAgICAgIGludm9rZURlc3Ryb3lIb29rKHZub2RlLmNoaWxkcmVuW2pdKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIHJlbW92ZVZub2RlcyhwYXJlbnRFbG0sIHZub2Rlcywgc3RhcnRJZHgsIGVuZElkeCkge1xuICAgIGZvciAoOyBzdGFydElkeCA8PSBlbmRJZHg7ICsrc3RhcnRJZHgpIHtcbiAgICAgIHZhciBpLCBsaXN0ZW5lcnMsIHJtLCBjaCA9IHZub2Rlc1tzdGFydElkeF07XG4gICAgICBpZiAoaXNEZWYoY2gpKSB7XG4gICAgICAgIGlmIChpc0RlZihjaC5zZWwpKSB7XG4gICAgICAgICAgaW52b2tlRGVzdHJveUhvb2soY2gpO1xuICAgICAgICAgIGxpc3RlbmVycyA9IGNicy5yZW1vdmUubGVuZ3RoICsgMTtcbiAgICAgICAgICBybSA9IGNyZWF0ZVJtQ2IoY2guZWxtLCBsaXN0ZW5lcnMpO1xuICAgICAgICAgIGZvciAoaSA9IDA7IGkgPCBjYnMucmVtb3ZlLmxlbmd0aDsgKytpKSBjYnMucmVtb3ZlW2ldKGNoLCBybSk7XG4gICAgICAgICAgaWYgKGlzRGVmKGkgPSBjaC5kYXRhKSAmJiBpc0RlZihpID0gaS5ob29rKSAmJiBpc0RlZihpID0gaS5yZW1vdmUpKSB7XG4gICAgICAgICAgICBpKGNoLCBybSk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJtKCk7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgeyAvLyBUZXh0IG5vZGVcbiAgICAgICAgICBhcGkucmVtb3ZlQ2hpbGQocGFyZW50RWxtLCBjaC5lbG0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gdXBkYXRlQ2hpbGRyZW4ocGFyZW50RWxtLCBvbGRDaCwgbmV3Q2gsIGluc2VydGVkVm5vZGVRdWV1ZSkge1xuICAgIHZhciBvbGRTdGFydElkeCA9IDAsIG5ld1N0YXJ0SWR4ID0gMDtcbiAgICB2YXIgb2xkRW5kSWR4ID0gb2xkQ2gubGVuZ3RoIC0gMTtcbiAgICB2YXIgb2xkU3RhcnRWbm9kZSA9IG9sZENoWzBdO1xuICAgIHZhciBvbGRFbmRWbm9kZSA9IG9sZENoW29sZEVuZElkeF07XG4gICAgdmFyIG5ld0VuZElkeCA9IG5ld0NoLmxlbmd0aCAtIDE7XG4gICAgdmFyIG5ld1N0YXJ0Vm5vZGUgPSBuZXdDaFswXTtcbiAgICB2YXIgbmV3RW5kVm5vZGUgPSBuZXdDaFtuZXdFbmRJZHhdO1xuICAgIHZhciBvbGRLZXlUb0lkeCwgaWR4SW5PbGQsIGVsbVRvTW92ZSwgYmVmb3JlO1xuXG4gICAgd2hpbGUgKG9sZFN0YXJ0SWR4IDw9IG9sZEVuZElkeCAmJiBuZXdTdGFydElkeCA8PSBuZXdFbmRJZHgpIHtcbiAgICAgIGlmIChpc1VuZGVmKG9sZFN0YXJ0Vm5vZGUpKSB7XG4gICAgICAgIG9sZFN0YXJ0Vm5vZGUgPSBvbGRDaFsrK29sZFN0YXJ0SWR4XTsgLy8gVm5vZGUgaGFzIGJlZW4gbW92ZWQgbGVmdFxuICAgICAgfSBlbHNlIGlmIChpc1VuZGVmKG9sZEVuZFZub2RlKSkge1xuICAgICAgICBvbGRFbmRWbm9kZSA9IG9sZENoWy0tb2xkRW5kSWR4XTtcbiAgICAgIH0gZWxzZSBpZiAoc2FtZVZub2RlKG9sZFN0YXJ0Vm5vZGUsIG5ld1N0YXJ0Vm5vZGUpKSB7XG4gICAgICAgIHBhdGNoVm5vZGUob2xkU3RhcnRWbm9kZSwgbmV3U3RhcnRWbm9kZSwgaW5zZXJ0ZWRWbm9kZVF1ZXVlKTtcbiAgICAgICAgb2xkU3RhcnRWbm9kZSA9IG9sZENoWysrb2xkU3RhcnRJZHhdO1xuICAgICAgICBuZXdTdGFydFZub2RlID0gbmV3Q2hbKytuZXdTdGFydElkeF07XG4gICAgICB9IGVsc2UgaWYgKHNhbWVWbm9kZShvbGRFbmRWbm9kZSwgbmV3RW5kVm5vZGUpKSB7XG4gICAgICAgIHBhdGNoVm5vZGUob2xkRW5kVm5vZGUsIG5ld0VuZFZub2RlLCBpbnNlcnRlZFZub2RlUXVldWUpO1xuICAgICAgICBvbGRFbmRWbm9kZSA9IG9sZENoWy0tb2xkRW5kSWR4XTtcbiAgICAgICAgbmV3RW5kVm5vZGUgPSBuZXdDaFstLW5ld0VuZElkeF07XG4gICAgICB9IGVsc2UgaWYgKHNhbWVWbm9kZShvbGRTdGFydFZub2RlLCBuZXdFbmRWbm9kZSkpIHsgLy8gVm5vZGUgbW92ZWQgcmlnaHRcbiAgICAgICAgcGF0Y2hWbm9kZShvbGRTdGFydFZub2RlLCBuZXdFbmRWbm9kZSwgaW5zZXJ0ZWRWbm9kZVF1ZXVlKTtcbiAgICAgICAgYXBpLmluc2VydEJlZm9yZShwYXJlbnRFbG0sIG9sZFN0YXJ0Vm5vZGUuZWxtLCBhcGkubmV4dFNpYmxpbmcob2xkRW5kVm5vZGUuZWxtKSk7XG4gICAgICAgIG9sZFN0YXJ0Vm5vZGUgPSBvbGRDaFsrK29sZFN0YXJ0SWR4XTtcbiAgICAgICAgbmV3RW5kVm5vZGUgPSBuZXdDaFstLW5ld0VuZElkeF07XG4gICAgICB9IGVsc2UgaWYgKHNhbWVWbm9kZShvbGRFbmRWbm9kZSwgbmV3U3RhcnRWbm9kZSkpIHsgLy8gVm5vZGUgbW92ZWQgbGVmdFxuICAgICAgICBwYXRjaFZub2RlKG9sZEVuZFZub2RlLCBuZXdTdGFydFZub2RlLCBpbnNlcnRlZFZub2RlUXVldWUpO1xuICAgICAgICBhcGkuaW5zZXJ0QmVmb3JlKHBhcmVudEVsbSwgb2xkRW5kVm5vZGUuZWxtLCBvbGRTdGFydFZub2RlLmVsbSk7XG4gICAgICAgIG9sZEVuZFZub2RlID0gb2xkQ2hbLS1vbGRFbmRJZHhdO1xuICAgICAgICBuZXdTdGFydFZub2RlID0gbmV3Q2hbKytuZXdTdGFydElkeF07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBpZiAoaXNVbmRlZihvbGRLZXlUb0lkeCkpIG9sZEtleVRvSWR4ID0gY3JlYXRlS2V5VG9PbGRJZHgob2xkQ2gsIG9sZFN0YXJ0SWR4LCBvbGRFbmRJZHgpO1xuICAgICAgICBpZHhJbk9sZCA9IG9sZEtleVRvSWR4W25ld1N0YXJ0Vm5vZGUua2V5XTtcbiAgICAgICAgaWYgKGlzVW5kZWYoaWR4SW5PbGQpKSB7IC8vIE5ldyBlbGVtZW50XG4gICAgICAgICAgYXBpLmluc2VydEJlZm9yZShwYXJlbnRFbG0sIGNyZWF0ZUVsbShuZXdTdGFydFZub2RlLCBpbnNlcnRlZFZub2RlUXVldWUpLCBvbGRTdGFydFZub2RlLmVsbSk7XG4gICAgICAgICAgbmV3U3RhcnRWbm9kZSA9IG5ld0NoWysrbmV3U3RhcnRJZHhdO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGVsbVRvTW92ZSA9IG9sZENoW2lkeEluT2xkXTtcbiAgICAgICAgICBwYXRjaFZub2RlKGVsbVRvTW92ZSwgbmV3U3RhcnRWbm9kZSwgaW5zZXJ0ZWRWbm9kZVF1ZXVlKTtcbiAgICAgICAgICBvbGRDaFtpZHhJbk9sZF0gPSB1bmRlZmluZWQ7XG4gICAgICAgICAgYXBpLmluc2VydEJlZm9yZShwYXJlbnRFbG0sIGVsbVRvTW92ZS5lbG0sIG9sZFN0YXJ0Vm5vZGUuZWxtKTtcbiAgICAgICAgICBuZXdTdGFydFZub2RlID0gbmV3Q2hbKytuZXdTdGFydElkeF07XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKG9sZFN0YXJ0SWR4ID4gb2xkRW5kSWR4KSB7XG4gICAgICBiZWZvcmUgPSBpc1VuZGVmKG5ld0NoW25ld0VuZElkeCsxXSkgPyBudWxsIDogbmV3Q2hbbmV3RW5kSWR4KzFdLmVsbTtcbiAgICAgIGFkZFZub2RlcyhwYXJlbnRFbG0sIGJlZm9yZSwgbmV3Q2gsIG5ld1N0YXJ0SWR4LCBuZXdFbmRJZHgsIGluc2VydGVkVm5vZGVRdWV1ZSk7XG4gICAgfSBlbHNlIGlmIChuZXdTdGFydElkeCA+IG5ld0VuZElkeCkge1xuICAgICAgcmVtb3ZlVm5vZGVzKHBhcmVudEVsbSwgb2xkQ2gsIG9sZFN0YXJ0SWR4LCBvbGRFbmRJZHgpO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIHBhdGNoVm5vZGUob2xkVm5vZGUsIHZub2RlLCBpbnNlcnRlZFZub2RlUXVldWUpIHtcbiAgICB2YXIgaSwgaG9vaztcbiAgICBpZiAoaXNEZWYoaSA9IHZub2RlLmRhdGEpICYmIGlzRGVmKGhvb2sgPSBpLmhvb2spICYmIGlzRGVmKGkgPSBob29rLnByZXBhdGNoKSkge1xuICAgICAgaShvbGRWbm9kZSwgdm5vZGUpO1xuICAgIH1cbiAgICB2YXIgZWxtID0gdm5vZGUuZWxtID0gb2xkVm5vZGUuZWxtLCBvbGRDaCA9IG9sZFZub2RlLmNoaWxkcmVuLCBjaCA9IHZub2RlLmNoaWxkcmVuO1xuICAgIGlmIChvbGRWbm9kZSA9PT0gdm5vZGUpIHJldHVybjtcbiAgICBpZiAoIXNhbWVWbm9kZShvbGRWbm9kZSwgdm5vZGUpKSB7XG4gICAgICB2YXIgcGFyZW50RWxtID0gYXBpLnBhcmVudE5vZGUob2xkVm5vZGUuZWxtKTtcbiAgICAgIGVsbSA9IGNyZWF0ZUVsbSh2bm9kZSwgaW5zZXJ0ZWRWbm9kZVF1ZXVlKTtcbiAgICAgIGFwaS5pbnNlcnRCZWZvcmUocGFyZW50RWxtLCBlbG0sIG9sZFZub2RlLmVsbSk7XG4gICAgICByZW1vdmVWbm9kZXMocGFyZW50RWxtLCBbb2xkVm5vZGVdLCAwLCAwKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKGlzRGVmKHZub2RlLmRhdGEpKSB7XG4gICAgICBmb3IgKGkgPSAwOyBpIDwgY2JzLnVwZGF0ZS5sZW5ndGg7ICsraSkgY2JzLnVwZGF0ZVtpXShvbGRWbm9kZSwgdm5vZGUpO1xuICAgICAgaSA9IHZub2RlLmRhdGEuaG9vaztcbiAgICAgIGlmIChpc0RlZihpKSAmJiBpc0RlZihpID0gaS51cGRhdGUpKSBpKG9sZFZub2RlLCB2bm9kZSk7XG4gICAgfVxuICAgIGlmIChpc1VuZGVmKHZub2RlLnRleHQpKSB7XG4gICAgICBpZiAoaXNEZWYob2xkQ2gpICYmIGlzRGVmKGNoKSkge1xuICAgICAgICBpZiAob2xkQ2ggIT09IGNoKSB1cGRhdGVDaGlsZHJlbihlbG0sIG9sZENoLCBjaCwgaW5zZXJ0ZWRWbm9kZVF1ZXVlKTtcbiAgICAgIH0gZWxzZSBpZiAoaXNEZWYoY2gpKSB7XG4gICAgICAgIGlmIChpc0RlZihvbGRWbm9kZS50ZXh0KSkgYXBpLnNldFRleHRDb250ZW50KGVsbSwgJycpO1xuICAgICAgICBhZGRWbm9kZXMoZWxtLCBudWxsLCBjaCwgMCwgY2gubGVuZ3RoIC0gMSwgaW5zZXJ0ZWRWbm9kZVF1ZXVlKTtcbiAgICAgIH0gZWxzZSBpZiAoaXNEZWYob2xkQ2gpKSB7XG4gICAgICAgIHJlbW92ZVZub2RlcyhlbG0sIG9sZENoLCAwLCBvbGRDaC5sZW5ndGggLSAxKTtcbiAgICAgIH0gZWxzZSBpZiAoaXNEZWYob2xkVm5vZGUudGV4dCkpIHtcbiAgICAgICAgYXBpLnNldFRleHRDb250ZW50KGVsbSwgJycpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAob2xkVm5vZGUudGV4dCAhPT0gdm5vZGUudGV4dCkge1xuICAgICAgYXBpLnNldFRleHRDb250ZW50KGVsbSwgdm5vZGUudGV4dCk7XG4gICAgfVxuICAgIGlmIChpc0RlZihob29rKSAmJiBpc0RlZihpID0gaG9vay5wb3N0cGF0Y2gpKSB7XG4gICAgICBpKG9sZFZub2RlLCB2bm9kZSk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGZ1bmN0aW9uKG9sZFZub2RlLCB2bm9kZSkge1xuICAgIHZhciBpLCBlbG0sIHBhcmVudDtcbiAgICB2YXIgaW5zZXJ0ZWRWbm9kZVF1ZXVlID0gW107XG4gICAgZm9yIChpID0gMDsgaSA8IGNicy5wcmUubGVuZ3RoOyArK2kpIGNicy5wcmVbaV0oKTtcblxuICAgIGlmIChpc1VuZGVmKG9sZFZub2RlLnNlbCkpIHtcbiAgICAgIG9sZFZub2RlID0gZW1wdHlOb2RlQXQob2xkVm5vZGUpO1xuICAgIH1cblxuICAgIGlmIChzYW1lVm5vZGUob2xkVm5vZGUsIHZub2RlKSkge1xuICAgICAgcGF0Y2hWbm9kZShvbGRWbm9kZSwgdm5vZGUsIGluc2VydGVkVm5vZGVRdWV1ZSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGVsbSA9IG9sZFZub2RlLmVsbTtcbiAgICAgIHBhcmVudCA9IGFwaS5wYXJlbnROb2RlKGVsbSk7XG5cbiAgICAgIGNyZWF0ZUVsbSh2bm9kZSwgaW5zZXJ0ZWRWbm9kZVF1ZXVlKTtcblxuICAgICAgaWYgKHBhcmVudCAhPT0gbnVsbCkge1xuICAgICAgICBhcGkuaW5zZXJ0QmVmb3JlKHBhcmVudCwgdm5vZGUuZWxtLCBhcGkubmV4dFNpYmxpbmcoZWxtKSk7XG4gICAgICAgIHJlbW92ZVZub2RlcyhwYXJlbnQsIFtvbGRWbm9kZV0sIDAsIDApO1xuICAgICAgfVxuICAgIH1cblxuICAgIGZvciAoaSA9IDA7IGkgPCBpbnNlcnRlZFZub2RlUXVldWUubGVuZ3RoOyArK2kpIHtcbiAgICAgIGluc2VydGVkVm5vZGVRdWV1ZVtpXS5kYXRhLmhvb2suaW5zZXJ0KGluc2VydGVkVm5vZGVRdWV1ZVtpXSk7XG4gICAgfVxuICAgIGZvciAoaSA9IDA7IGkgPCBjYnMucG9zdC5sZW5ndGg7ICsraSkgY2JzLnBvc3RbaV0oKTtcbiAgICByZXR1cm4gdm5vZGU7XG4gIH07XG59XG5cbm1vZHVsZS5leHBvcnRzID0ge2luaXQ6IGluaXR9O1xuIiwibW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihzZWwsIGRhdGEsIGNoaWxkcmVuLCB0ZXh0LCBlbG0pIHtcbiAgdmFyIGtleSA9IGRhdGEgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IGRhdGEua2V5O1xuICByZXR1cm4ge3NlbDogc2VsLCBkYXRhOiBkYXRhLCBjaGlsZHJlbjogY2hpbGRyZW4sXG4gICAgICAgICAgdGV4dDogdGV4dCwgZWxtOiBlbG0sIGtleToga2V5fTtcbn07XG4iLCIndXNlIHN0cmljdCc7XG5cbnZhciBQcm9taXNlID0gcmVxdWlyZSgncHJvbWlzZScpO1xudmFyIFJlc3BvbnNlID0gcmVxdWlyZSgnaHR0cC1yZXNwb25zZS1vYmplY3QnKTtcbnZhciBoYW5kbGVRcyA9IHJlcXVpcmUoJy4vbGliL2hhbmRsZS1xcy5qcycpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IGRvUmVxdWVzdDtcbmZ1bmN0aW9uIGRvUmVxdWVzdChtZXRob2QsIHVybCwgb3B0aW9ucywgY2FsbGJhY2spIHtcbiAgdmFyIHJlc3VsdCA9IG5ldyBQcm9taXNlKGZ1bmN0aW9uIChyZXNvbHZlLCByZWplY3QpIHtcbiAgICB2YXIgeGhyID0gbmV3IHdpbmRvdy5YTUxIdHRwUmVxdWVzdCgpO1xuXG4gICAgLy8gY2hlY2sgdHlwZXMgb2YgYXJndW1lbnRzXG5cbiAgICBpZiAodHlwZW9mIG1ldGhvZCAhPT0gJ3N0cmluZycpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ1RoZSBtZXRob2QgbXVzdCBiZSBhIHN0cmluZy4nKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiB1cmwgIT09ICdzdHJpbmcnKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdUaGUgVVJML3BhdGggbXVzdCBiZSBhIHN0cmluZy4nKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBvcHRpb25zID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICBjYWxsYmFjayA9IG9wdGlvbnM7XG4gICAgICBvcHRpb25zID0ge307XG4gICAgfVxuICAgIGlmIChvcHRpb25zID09PSBudWxsIHx8IG9wdGlvbnMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgb3B0aW9ucyA9IHt9O1xuICAgIH1cbiAgICBpZiAodHlwZW9mIG9wdGlvbnMgIT09ICdvYmplY3QnKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdPcHRpb25zIG11c3QgYmUgYW4gb2JqZWN0IChvciBudWxsKS4nKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBjYWxsYmFjayAhPT0gJ2Z1bmN0aW9uJykge1xuICAgICAgY2FsbGJhY2sgPSB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgbWV0aG9kID0gbWV0aG9kLnRvVXBwZXJDYXNlKCk7XG4gICAgb3B0aW9ucy5oZWFkZXJzID0gb3B0aW9ucy5oZWFkZXJzIHx8IHt9O1xuXG5cbiAgICBmdW5jdGlvbiBhdHRlbXB0KG4pIHtcbiAgICAgIGRvUmVxdWVzdChtZXRob2QsIHVybCwge1xuICAgICAgICBxczogb3B0aW9ucy5xcyxcbiAgICAgICAgaGVhZGVyczogb3B0aW9ucy5oZWFkZXJzLFxuICAgICAgICB0aW1lb3V0OiBvcHRpb25zLnRpbWVvdXRcbiAgICAgIH0pLm5vZGVpZnkoZnVuY3Rpb24gKGVyciwgcmVzKSB7XG4gICAgICAgIHZhciByZXRyeSA9IGVyciB8fCByZXMuc3RhdHVzQ29kZSA+PSA0MDA7XG4gICAgICAgIGlmICh0eXBlb2Ygb3B0aW9ucy5yZXRyeSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgIHJldHJ5ID0gb3B0aW9ucy5yZXRyeShlcnIsIHJlcywgbiArIDEpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChuID49IChvcHRpb25zLm1heFJldHJpZXMgfCA1KSkge1xuICAgICAgICAgIHJldHJ5ID0gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJldHJ5KSB7XG4gICAgICAgICAgdmFyIGRlbGF5ID0gb3B0aW9ucy5yZXRyeURlbGF5O1xuICAgICAgICAgIGlmICh0eXBlb2Ygb3B0aW9ucy5yZXRyeURlbGF5ID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICBkZWxheSA9IG9wdGlvbnMucmV0cnlEZWxheShlcnIsIHJlcywgbiArIDEpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBkZWxheSA9IGRlbGF5IHx8IDIwMDtcbiAgICAgICAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIGF0dGVtcHQobiArIDEpO1xuICAgICAgICAgIH0sIGRlbGF5KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBpZiAoZXJyKSByZWplY3QoZXJyKTtcbiAgICAgICAgICBlbHNlIHJlc29sdmUocmVzKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfVxuICAgIGlmIChvcHRpb25zLnJldHJ5ICYmIG1ldGhvZCA9PT0gJ0dFVCcpIHtcbiAgICAgIHJldHVybiBhdHRlbXB0KDApO1xuICAgIH1cblxuICAgIC8vIGhhbmRsZSBjcm9zcyBkb21haW5cblxuICAgIHZhciBtYXRjaDtcbiAgICB2YXIgY3Jvc3NEb21haW4gPSAhISgobWF0Y2ggPSAvXihbXFx3LV0rOik/XFwvXFwvKFteXFwvXSspLy5leGVjKHVybCkpICYmIChtYXRjaFsyXSAhPSB3aW5kb3cubG9jYXRpb24uaG9zdCkpO1xuICAgIGlmICghY3Jvc3NEb21haW4pIG9wdGlvbnMuaGVhZGVyc1snWC1SZXF1ZXN0ZWQtV2l0aCddID0gJ1hNTEh0dHBSZXF1ZXN0JztcblxuICAgIC8vIGhhbmRsZSBxdWVyeSBzdHJpbmdcbiAgICBpZiAob3B0aW9ucy5xcykge1xuICAgICAgdXJsID0gaGFuZGxlUXModXJsLCBvcHRpb25zLnFzKTtcbiAgICB9XG5cbiAgICAvLyBoYW5kbGUganNvbiBib2R5XG4gICAgaWYgKG9wdGlvbnMuanNvbikge1xuICAgICAgb3B0aW9ucy5ib2R5ID0gSlNPTi5zdHJpbmdpZnkob3B0aW9ucy5qc29uKTtcbiAgICAgIG9wdGlvbnMuaGVhZGVyc1snQ29udGVudC1UeXBlJ10gPSAnYXBwbGljYXRpb24vanNvbic7XG4gICAgfVxuXG4gICAgaWYgKG9wdGlvbnMudGltZW91dCkge1xuICAgICAgeGhyLnRpbWVvdXQgPSBvcHRpb25zLnRpbWVvdXQ7XG4gICAgICB2YXIgc3RhcnQgPSBEYXRlLm5vdygpO1xuICAgICAgeGhyLm9udGltZW91dCA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgdmFyIGR1cmF0aW9uID0gRGF0ZS5ub3coKSAtIHN0YXJ0O1xuICAgICAgICB2YXIgZXJyID0gbmV3IEVycm9yKCdSZXF1ZXN0IHRpbWVkIG91dCBhZnRlciAnICsgZHVyYXRpb24gKyAnbXMnKTtcbiAgICAgICAgZXJyLnRpbWVvdXQgPSB0cnVlO1xuICAgICAgICBlcnIuZHVyYXRpb24gPSBkdXJhdGlvbjtcbiAgICAgICAgcmVqZWN0KGVycik7XG4gICAgICB9O1xuICAgIH1cbiAgICB4aHIub25yZWFkeXN0YXRlY2hhbmdlID0gZnVuY3Rpb24gKCkge1xuICAgICAgaWYgKHhoci5yZWFkeVN0YXRlID09PSA0KSB7XG4gICAgICAgIHZhciBoZWFkZXJzID0ge307XG4gICAgICAgIHhoci5nZXRBbGxSZXNwb25zZUhlYWRlcnMoKS5zcGxpdCgnXFxyXFxuJykuZm9yRWFjaChmdW5jdGlvbiAoaGVhZGVyKSB7XG4gICAgICAgICAgdmFyIGggPSBoZWFkZXIuc3BsaXQoJzonKTtcbiAgICAgICAgICBpZiAoaC5sZW5ndGggPiAxKSB7XG4gICAgICAgICAgICBoZWFkZXJzW2hbMF0udG9Mb3dlckNhc2UoKV0gPSBoLnNsaWNlKDEpLmpvaW4oJzonKS50cmltKCk7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgICAgdmFyIHJlcyA9IG5ldyBSZXNwb25zZSh4aHIuc3RhdHVzLCBoZWFkZXJzLCB4aHIucmVzcG9uc2VUZXh0KTtcbiAgICAgICAgcmVzLnVybCA9IHVybDtcbiAgICAgICAgcmVzb2x2ZShyZXMpO1xuICAgICAgfVxuICAgIH07XG5cbiAgICAvLyBtZXRob2QsIHVybCwgYXN5bmNcbiAgICB4aHIub3BlbihtZXRob2QsIHVybCwgdHJ1ZSk7XG5cbiAgICBmb3IgKHZhciBuYW1lIGluIG9wdGlvbnMuaGVhZGVycykge1xuICAgICAgeGhyLnNldFJlcXVlc3RIZWFkZXIobmFtZSwgb3B0aW9ucy5oZWFkZXJzW25hbWVdKTtcbiAgICB9XG5cbiAgICAvLyBhdm9pZCBzZW5kaW5nIGVtcHR5IHN0cmluZyAoIzMxOSlcbiAgICB4aHIuc2VuZChvcHRpb25zLmJvZHkgPyBvcHRpb25zLmJvZHkgOiBudWxsKTtcbiAgfSk7XG4gIHJlc3VsdC5nZXRCb2R5ID0gZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiByZXN1bHQudGhlbihmdW5jdGlvbiAocmVzKSB7IHJldHVybiByZXMuZ2V0Qm9keSgpOyB9KTtcbiAgfTtcbiAgcmV0dXJuIHJlc3VsdC5ub2RlaWZ5KGNhbGxiYWNrKTtcbn1cbiIsIid1c2Ugc3RyaWN0JztcblxudmFyIHBhcnNlID0gcmVxdWlyZSgncXMnKS5wYXJzZTtcbnZhciBzdHJpbmdpZnkgPSByZXF1aXJlKCdxcycpLnN0cmluZ2lmeTtcblxubW9kdWxlLmV4cG9ydHMgPSBoYW5kbGVRcztcbmZ1bmN0aW9uIGhhbmRsZVFzKHVybCwgcXVlcnkpIHtcbiAgdXJsID0gdXJsLnNwbGl0KCc/Jyk7XG4gIHZhciBzdGFydCA9IHVybFswXTtcbiAgdmFyIHFzID0gKHVybFsxXSB8fCAnJykuc3BsaXQoJyMnKVswXTtcbiAgdmFyIGVuZCA9IHVybFsxXSAmJiB1cmxbMV0uc3BsaXQoJyMnKS5sZW5ndGggPiAxID8gJyMnICsgdXJsWzFdLnNwbGl0KCcjJylbMV0gOiAnJztcblxuICB2YXIgYmFzZVFzID0gcGFyc2UocXMpO1xuICBmb3IgKHZhciBpIGluIHF1ZXJ5KSB7XG4gICAgYmFzZVFzW2ldID0gcXVlcnlbaV07XG4gIH1cbiAgcXMgPSBzdHJpbmdpZnkoYmFzZVFzKTtcbiAgaWYgKHFzICE9PSAnJykge1xuICAgIHFzID0gJz8nICsgcXM7XG4gIH1cbiAgcmV0dXJuIHN0YXJ0ICsgcXMgKyBlbmQ7XG59XG4iLCJ2YXIgY3VycnlOID0gcmVxdWlyZSgncmFtZGEvc3JjL2N1cnJ5TicpO1xuXG52YXIgaXNTdHJpbmcgPSBmdW5jdGlvbihzKSB7IHJldHVybiB0eXBlb2YgcyA9PT0gJ3N0cmluZyc7IH07XG52YXIgaXNOdW1iZXIgPSBmdW5jdGlvbihuKSB7IHJldHVybiB0eXBlb2YgbiA9PT0gJ251bWJlcic7IH07XG52YXIgaXNCb29sZWFuID0gZnVuY3Rpb24oYikgeyByZXR1cm4gdHlwZW9mIGIgPT09ICdib29sZWFuJzsgfTtcbnZhciBpc09iamVjdCA9IGZ1bmN0aW9uKHZhbHVlKSB7XG4gIHZhciB0eXBlID0gdHlwZW9mIHZhbHVlO1xuICByZXR1cm4gISF2YWx1ZSAmJiAodHlwZSA9PSAnb2JqZWN0JyB8fCB0eXBlID09ICdmdW5jdGlvbicpO1xufTtcbnZhciBpc0Z1bmN0aW9uID0gZnVuY3Rpb24oZikgeyByZXR1cm4gdHlwZW9mIGYgPT09ICdmdW5jdGlvbic7IH07XG52YXIgaXNBcnJheSA9IEFycmF5LmlzQXJyYXkgfHwgZnVuY3Rpb24oYSkgeyByZXR1cm4gJ2xlbmd0aCcgaW4gYTsgfTtcblxudmFyIG1hcENvbnN0clRvRm4gPSBmdW5jdGlvbihncm91cCwgY29uc3RyKSB7XG4gIHJldHVybiBjb25zdHIgPT09IFN0cmluZyAgICA/IGlzU3RyaW5nXG4gICAgICAgOiBjb25zdHIgPT09IE51bWJlciAgICA/IGlzTnVtYmVyXG4gICAgICAgOiBjb25zdHIgPT09IEJvb2xlYW4gICA/IGlzQm9vbGVhblxuICAgICAgIDogY29uc3RyID09PSBPYmplY3QgICAgPyBpc09iamVjdFxuICAgICAgIDogY29uc3RyID09PSBBcnJheSAgICAgPyBpc0FycmF5XG4gICAgICAgOiBjb25zdHIgPT09IEZ1bmN0aW9uICA/IGlzRnVuY3Rpb25cbiAgICAgICA6IGNvbnN0ciA9PT0gdW5kZWZpbmVkID8gZ3JvdXBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDogY29uc3RyO1xufTtcblxudmFyIG51bVRvU3RyID0gWydmaXJzdCcsICdzZWNvbmQnLCAndGhpcmQnLCAnZm91cnRoJywgJ2ZpZnRoJywgJ3NpeHRoJywgJ3NldmVudGgnLCAnZWlnaHRoJywgJ25pbnRoJywgJ3RlbnRoJ107XG5cbnZhciB2YWxpZGF0ZSA9IGZ1bmN0aW9uKGdyb3VwLCB2YWxpZGF0b3JzLCBuYW1lLCBhcmdzKSB7XG4gIHZhciB2YWxpZGF0b3IsIHYsIGk7XG4gIGZvciAoaSA9IDA7IGkgPCBhcmdzLmxlbmd0aDsgKytpKSB7XG4gICAgdiA9IGFyZ3NbaV07XG4gICAgdmFsaWRhdG9yID0gbWFwQ29uc3RyVG9Gbihncm91cCwgdmFsaWRhdG9yc1tpXSk7XG4gICAgaWYgKFR5cGUuY2hlY2sgPT09IHRydWUgJiZcbiAgICAgICAgKHZhbGlkYXRvci5wcm90b3R5cGUgPT09IHVuZGVmaW5lZCB8fCAhdmFsaWRhdG9yLnByb3RvdHlwZS5pc1Byb3RvdHlwZU9mKHYpKSAmJlxuICAgICAgICAodHlwZW9mIHZhbGlkYXRvciAhPT0gJ2Z1bmN0aW9uJyB8fCAhdmFsaWRhdG9yKHYpKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignd3JvbmcgdmFsdWUgJyArIHYgKyAnIHBhc3NlZCB0byBsb2NhdGlvbiAnICsgbnVtVG9TdHJbaV0gKyAnIGluICcgKyBuYW1lKTtcbiAgICB9XG4gIH1cbn07XG5cbmZ1bmN0aW9uIHZhbHVlVG9BcnJheSh2YWx1ZSkge1xuICB2YXIgaSwgYXJyID0gW107XG4gIGZvciAoaSA9IDA7IGkgPCB2YWx1ZS5fa2V5cy5sZW5ndGg7ICsraSkge1xuICAgIGFyci5wdXNoKHZhbHVlW3ZhbHVlLl9rZXlzW2ldXSk7XG4gIH1cbiAgcmV0dXJuIGFycjtcbn1cblxuZnVuY3Rpb24gZXh0cmFjdFZhbHVlcyhrZXlzLCBvYmopIHtcbiAgdmFyIGFyciA9IFtdLCBpO1xuICBmb3IgKGkgPSAwOyBpIDwga2V5cy5sZW5ndGg7ICsraSkgYXJyW2ldID0gb2JqW2tleXNbaV1dO1xuICByZXR1cm4gYXJyO1xufVxuXG5mdW5jdGlvbiBjb25zdHJ1Y3Rvcihncm91cCwgbmFtZSwgZmllbGRzKSB7XG4gIHZhciB2YWxpZGF0b3JzLCBrZXlzID0gT2JqZWN0LmtleXMoZmllbGRzKSwgaTtcbiAgaWYgKGlzQXJyYXkoZmllbGRzKSkge1xuICAgIHZhbGlkYXRvcnMgPSBmaWVsZHM7XG4gIH0gZWxzZSB7XG4gICAgdmFsaWRhdG9ycyA9IGV4dHJhY3RWYWx1ZXMoa2V5cywgZmllbGRzKTtcbiAgfVxuICBmdW5jdGlvbiBjb25zdHJ1Y3QoKSB7XG4gICAgdmFyIHZhbCA9IE9iamVjdC5jcmVhdGUoZ3JvdXAucHJvdG90eXBlKSwgaTtcbiAgICB2YWwuX2tleXMgPSBrZXlzO1xuICAgIHZhbC5fbmFtZSA9IG5hbWU7XG4gICAgaWYgKFR5cGUuY2hlY2sgPT09IHRydWUpIHtcbiAgICAgIHZhbGlkYXRlKGdyb3VwLCB2YWxpZGF0b3JzLCBuYW1lLCBhcmd1bWVudHMpO1xuICAgIH1cbiAgICBmb3IgKGkgPSAwOyBpIDwgYXJndW1lbnRzLmxlbmd0aDsgKytpKSB7XG4gICAgICB2YWxba2V5c1tpXV0gPSBhcmd1bWVudHNbaV07XG4gICAgfVxuICAgIHJldHVybiB2YWw7XG4gIH1cbiAgZ3JvdXBbbmFtZV0gPSBjdXJyeU4oa2V5cy5sZW5ndGgsIGNvbnN0cnVjdCk7XG4gIGlmIChrZXlzICE9PSB1bmRlZmluZWQpIHtcbiAgICBncm91cFtuYW1lKydPZiddID0gZnVuY3Rpb24ob2JqKSB7XG4gICAgICByZXR1cm4gY29uc3RydWN0LmFwcGx5KHVuZGVmaW5lZCwgZXh0cmFjdFZhbHVlcyhrZXlzLCBvYmopKTtcbiAgICB9O1xuICB9XG59XG5cbmZ1bmN0aW9uIHJhd0Nhc2UodHlwZSwgY2FzZXMsIHZhbHVlLCBhcmcpIHtcbiAgdmFyIHdpbGRjYXJkID0gZmFsc2U7XG4gIHZhciBoYW5kbGVyID0gY2FzZXNbdmFsdWUuX25hbWVdO1xuICBpZiAoaGFuZGxlciA9PT0gdW5kZWZpbmVkKSB7XG4gICAgaGFuZGxlciA9IGNhc2VzWydfJ107XG4gICAgd2lsZGNhcmQgPSB0cnVlO1xuICB9XG4gIGlmIChUeXBlLmNoZWNrID09PSB0cnVlKSB7XG4gICAgaWYgKCF0eXBlLnByb3RvdHlwZS5pc1Byb3RvdHlwZU9mKHZhbHVlKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignd3JvbmcgdHlwZSBwYXNzZWQgdG8gY2FzZScpO1xuICAgIH0gZWxzZSBpZiAoaGFuZGxlciA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ25vbi1leGhhdXN0aXZlIHBhdHRlcm5zIGluIGEgZnVuY3Rpb24nKTtcbiAgICB9XG4gIH1cbiAgdmFyIGFyZ3MgPSB3aWxkY2FyZCA9PT0gdHJ1ZSA/IFthcmddXG4gICAgICAgICAgIDogYXJnICE9PSB1bmRlZmluZWQgPyB2YWx1ZVRvQXJyYXkodmFsdWUpLmNvbmNhdChbYXJnXSlcbiAgICAgICAgICAgOiB2YWx1ZVRvQXJyYXkodmFsdWUpO1xuICByZXR1cm4gaGFuZGxlci5hcHBseSh1bmRlZmluZWQsIGFyZ3MpO1xufVxuXG52YXIgdHlwZUNhc2UgPSBjdXJyeU4oMywgcmF3Q2FzZSk7XG52YXIgY2FzZU9uID0gY3VycnlOKDQsIHJhd0Nhc2UpO1xuXG5mdW5jdGlvbiBjcmVhdGVJdGVyYXRvcigpIHtcbiAgcmV0dXJuIHtcbiAgICBpZHg6IDAsXG4gICAgdmFsOiB0aGlzLFxuICAgIG5leHQ6IGZ1bmN0aW9uKCkge1xuICAgICAgdmFyIGtleXMgPSB0aGlzLnZhbC5fa2V5cztcbiAgICAgIHJldHVybiB0aGlzLmlkeCA9PT0ga2V5cy5sZW5ndGhcbiAgICAgICAgPyB7ZG9uZTogdHJ1ZX1cbiAgICAgICAgOiB7dmFsdWU6IHRoaXMudmFsW2tleXNbdGhpcy5pZHgrK11dfTtcbiAgICB9XG4gIH07XG59XG5cbmZ1bmN0aW9uIFR5cGUoZGVzYykge1xuICB2YXIga2V5LCByZXMsIG9iaiA9IHt9O1xuICBvYmoucHJvdG90eXBlID0ge307XG4gIG9iai5wcm90b3R5cGVbU3ltYm9sID8gU3ltYm9sLml0ZXJhdG9yIDogJ0BAaXRlcmF0b3InXSA9IGNyZWF0ZUl0ZXJhdG9yO1xuICBvYmouY2FzZSA9IHR5cGVDYXNlKG9iaik7XG4gIG9iai5jYXNlT24gPSBjYXNlT24ob2JqKTtcbiAgZm9yIChrZXkgaW4gZGVzYykge1xuICAgIHJlcyA9IGNvbnN0cnVjdG9yKG9iaiwga2V5LCBkZXNjW2tleV0pO1xuICB9XG4gIHJldHVybiBvYmo7XG59XG5cblR5cGUuY2hlY2sgPSB0cnVlO1xuXG5tb2R1bGUuZXhwb3J0cyA9IFR5cGU7XG4iLCJjb25zdCBoID0gcmVxdWlyZSgnc25hYmJkb20vaCcpO1xuY29uc3QgVHlwZSA9IHJlcXVpcmUoJ3VuaW9uLXR5cGUnKTtcbmNvbnN0IGZseWQgPSByZXF1aXJlKCdmbHlkJyk7XG5jb25zdCB7IHN0cmVhbSB9ID0gZmx5ZDtcbmNvbnN0IG1vcmkgPSByZXF1aXJlKCdtb3JpJyk7XG5jb25zdCB7XG4gIHZlY3RvcixcbiAgaGFzaE1hcCxcbiAgbWFwLFxuICBrZXlzLFxuICB2YWxzLFxuICBnZXRJbixcbiAgYXNzb2MsXG4gIG50aCxcbiAgdG9Kc1xufSA9IG1vcmk7XG5cbmNvbnN0IG51bWJlclBpY2tlciA9IHJlcXVpcmUoJy4vbnVtYmVyX3BpY2tlcicpO1xuXG4vLyBNb2RlbCBkZWZpbml0aW9uIGFuZCBpbml0aWFsIHN0YXRlXG5leHBvcnQgY29uc3QgbW9kZWwgPSBoYXNoTWFwKFxuICBcIlJcIiwgMHhmZSxcbiAgXCJHXCIsIDB4ZmUsXG4gIFwiQlwiLCAweGZlXG4pO1xuLy8gY29tcHV0YXRpb24gd2hpY2ggcmV0dXJucyBpbW11dGFibGUgaW5pdGlhbCBzdGF0ZTtcbmV4cG9ydCBjb25zdCBpbml0ID0gKCkgPT4gbW9kZWw7XG5cbi8vIEFsbCBhdmFpbGFibGUgYWN0aW9uc1xuZXhwb3J0IGNvbnN0IEFjdGlvbiA9IFR5cGUoe1xuICBBZGQ6IFtTdHJpbmcsIE51bWJlcl0sXG4gIFNldDogW1N0cmluZywgbnVtYmVyUGlja2VyLkFjdGlvbl1cbn0pO1xuXG5leHBvcnQgY29uc3QgdXBkYXRlID0gZnVuY3Rpb24gKG1vZGVsLCBhY3Rpb24pIHtcbiAgY29uc3QgZ2V0ID0gayA9PiBnZXRJbihtb2RlbCwgayk7XG4gIGNvbnN0IG5ld01vZGVsID0gQWN0aW9uLmNhc2Uoe1xuICAgIEFkZDogKGssIG4pID0+XG4gICAgICBhc3NvYyhtb2RlbCwgaywgTWF0aC5hYnMoZ2V0KGspICsgbikgJSAweGZmKSxcbiAgICBTZXQ6IChrLCBhY3QpID0+IHtcbiAgICAgIGNvbnN0IG4gPSBudW1iZXJQaWNrZXIudXBkYXRlKGdldChrKSwgYWN0KTtcbiAgICAgIHJldHVybiBhc3NvYyhtb2RlbCwgaywgbiA8PSAwID8gMHhmZSA6IG4pO1xuICAgIH1cbiAgfSwgYWN0aW9uKTtcblxuICByZXR1cm4gbmV3TW9kZWw7XG59O1xuXG5jb25zdCByZ2IgPSAociwgZywgYikgPT5cbiAgICAgICAgYHJnYigke051bWJlcihyfHwwKX0sJHtOdW1iZXIoZ3x8MCl9LCR7TnVtYmVyKGJ8fDApfSlgO1xuXG5leHBvcnQgZnVuY3Rpb24gdmlldyhtb2RlbCwgZXZlbnQpIHtcbiAgLy8gdGhpcyBzaG91bGQgYmUgYW4gb3duIGNvbXBvbmVudC4uLlxuICBjb25zdCBzaW5nbGVDb2xvclBpY2tlciA9IGtleSA9PiB7XG4gICAgY29uc3QgdmFsdWUgPSBnZXRJbihtb2RlbCwga2V5KSAlIDB4ZmY7XG4gICAgY29uc3QgbSA9IHtcbiAgICAgIFtrZXldOiB2YWx1ZVxuICAgIH07XG5cbiAgICByZXR1cm4gaCgnZGl2Jywge1xuICAgICAgc3R5bGU6IHtcbiAgICAgICAgYmFja2dyb3VuZENvbG9yOiByZ2IobS5SLCBtLkcsIG0uQilcbiAgICAgIH0sXG4gICAgICBvbjoge1xuICAgICAgICBtb3VzZXdoZWVsOiBlID0+IGV2ZW50KEFjdGlvbi5BZGQoa2V5LCBlLmRlbHRhWSkpXG4gICAgICB9XG4gICAgfSwgW1xuICAgICAgbnVtYmVyUGlja2VyLnZpZXcoXG4gICAgICAgIHZhbHVlLFxuICAgICAgICBhID0+IGV2ZW50KEFjdGlvbi5TZXQoa2V5LCBhKSkpXG4gICAgXSk7XG4gIH07XG5cbiAgY29uc3QgY29sb3JTdHJpbmcgPSByZ2IoLi4udG9KcyhtYXAoYyA9PiBjICUgMHhmZiwgdmFscyhtb2RlbCkpKSk7XG4gIHJldHVybiBoKCdkaXYnLCBbXG4gICAgaCgnZGl2Jywge1xuICAgICAgc3R5bGU6IHtcbiAgICAgICAgYmFja2dyb3VuZENvbG9yOiBjb2xvclN0cmluZ1xuICAgICAgfVxuICAgIH0sICdzZWxlY3RlZCBjb2xvcicpLFxuICAgIGgoJ2RpdicsIHRvSnMobWFwKHNpbmdsZUNvbG9yUGlja2VyLCBrZXlzKG1vZGVsKSkpKSxcbiAgICBoKCdkaXYnLCBbXG4gICAgICBoKCdwcmUnLCBKU09OLnN0cmluZ2lmeSh0b0pzKG1vZGVsKSwgbnVsbCwgMikpXG4gICAgXSlcbiAgXSk7XG59XG4iLCIndXNlIHN0cmljdCc7XG5cbmNvbnN0IGFwaVBvcnQgPSA5MDAwO1xuXG5jb25zdCBhcGlVcmwgPSBgaHR0cDovL2xvY2FsaG9zdDoke2FwaVBvcnR9L2FwaWA7XG5cbm1vZHVsZS5leHBvcnRzID0ge1xuICBhcGlQb3J0LFxuICBhcGlVcmxcbn07XG4iLCJjb25zdCBtb3JpID0gcmVxdWlyZSgnbW9yaScpO1xuY29uc3QgZmx5ZCA9IHJlcXVpcmUoJ2ZseWQnKTtcbmNvbnN0IHsgc3RyZWFtIH0gPSBmbHlkO1xuY29uc3Qgc25hYmJkb20gPSByZXF1aXJlKCdzbmFiYmRvbScpO1xuY29uc3QgcGF0Y2ggPSBzbmFiYmRvbS5pbml0KFtcbiAgcmVxdWlyZSgnc25hYmJkb20vbW9kdWxlcy9jbGFzcycpLFxuICByZXF1aXJlKCdzbmFiYmRvbS9tb2R1bGVzL3Byb3BzJyksXG4gIHJlcXVpcmUoJ3NuYWJiZG9tL21vZHVsZXMvc3R5bGUnKSxcbiAgcmVxdWlyZSgnc25hYmJkb20vbW9kdWxlcy9hdHRyaWJ1dGVzJyksXG4gIHJlcXVpcmUoJ3NuYWJiZG9tL21vZHVsZXMvZXZlbnRsaXN0ZW5lcnMnKVxuXSk7XG5cbi8vLyBSdW5zIGFuIEVsbSBhcmNoaXRlY3R1cmUgYmFzZWQgYXBwbGljYXRpb25cbmV4cG9ydCBmdW5jdGlvbiBzdGFydChyb290LCBtb2RlbCwge3ZpZXcsIHVwZGF0ZX0pIHtcbiAgLy8gdGhpcyBpcyB0aGUgc3RyZWFtIHdoaWNoIGFjdHMgYXMgdGhlIHJ1biBsb29wLCB3aGljaCBlbmFibGVzXG4gIC8vIHVwZGF0ZXMgdG8gYmUgdHJpZ2dlcmVkIGFyYml0cmFyaWx5XG4gIGNvbnN0IHN0YXRlJCA9IHN0cmVhbShtb2RlbCk7XG5cbiAgLy8gdGhpcyBpcyB0aGUgZXZlbnQgaGFuZGxlciB3aGljaCBhbGxvd3MgdGhlIHZpZXcgdG8gdHJpZ2dlclxuICAvLyBhbiB1cGRhdGUuIEl0IGV4cGVjdHMgYW4gb2JqZWN0IG9mIHR5cGUgQWN0aW9uLCBkZWZpbmVkIGFib3ZlXG4gIC8vIHVzaW5nIHRoZSBgdW5pb24tdHlwZWAgbGlicmFyeS5cbiAgY29uc3QgaGFuZGxlRXZlbnQgPSBmdW5jdGlvbiAoYWN0aW9uKSB7XG4gICAgY29uc3QgY3VycmVudFN0YXRlID0gc3RhdGUkKCk7XG4gICAgc3RhdGUkKHVwZGF0ZShjdXJyZW50U3RhdGUsIGFjdGlvbikpO1xuICB9O1xuXG4gIC8vIHRoZSBpbml0aWFsIHZub2RlLCB3aGljaCBpcyBjcmVhdGVkIGJ5IHBhdGNoaW5nIHRoZSByb290IG5vZGVcbiAgLy8gd2l0aCB0aGUgcmVzdWx0IG9mIGNhbGxpbmcgdGhlIHZpZXcgZnVuY3Rpb24gd2l0aCB0aGUgaW5pdGlhbCBzdGF0ZSBhbmRcbiAgLy8gdGhlIGV2ZW50IGhhbmRsZXIuXG4gIGxldCB2bm9kZSA9IG51bGw7XG5cbiAgLy8gbWFwcyBvdmVyIHRoZSBzdGF0ZSBzdHJlYW0sIGFuZCBwYXRjaGVzIHRoZSB2ZG9tXG4gIC8vIHdpdGggdGhlIHJlc3VsdCBvZiBjYWxsaW5nIHRoZSB2aWV3IGZ1bmN0aW9uIHdpdGhcbiAgLy8gdGhlIGN1cnJlbnQgc3RhdGUgYW5kIHRoZSBldmVudCBoYW5kbGVyLlxuICBsZXQgaGlzdG9yeSA9IG1vcmkudmVjdG9yKCk7XG4gIGZseWQubWFwKHYgPT4ge1xuICAgIGhpc3RvcnkgPSBtb3JpLmNvbmooaGlzdG9yeSwgdik7XG4gICAgaWYgKHZub2RlID09PSBudWxsKSB7XG4gICAgICB2bm9kZSA9IHBhdGNoKHJvb3QsIHZpZXcodiwgaGFuZGxlRXZlbnQpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdm5vZGUgPSBwYXRjaCh2bm9kZSwgdmlldyh2LCBoYW5kbGVFdmVudCkpO1xuICAgIH1cblxuICAgIHJldHVybiB2bm9kZTtcbiAgfSwgc3RhdGUkKTtcblxuICByZXR1cm4gc3RhdGUkO1xufTtcbiIsImNvbnN0IHJlcXVlc3QgPSByZXF1aXJlKCd0aGVuLXJlcXVlc3QnKTtcbmNvbnN0IGggPSByZXF1aXJlKCdzbmFiYmRvbS9oJyk7XG5jb25zdCBUeXBlID0gcmVxdWlyZSgndW5pb24tdHlwZScpO1xuY29uc3QgZmx5ZCA9IHJlcXVpcmUoJ2ZseWQnKTtcbmNvbnN0IHsgc3RyZWFtIH0gPSBmbHlkO1xuY29uc3QgbW9yaSA9IHJlcXVpcmUoJ21vcmknKTtcbmNvbnN0IHtcbiAgdmVjdG9yLFxuICBoYXNoTWFwLFxuICBtYXAsXG4gIGtleXMsXG4gIHZhbHMsXG4gIGVxdWFscyxcbiAgZ2V0SW4sXG4gIGdldCxcbiAgYXNzb2MsXG4gIG50aCxcbiAgdG9DbGosXG4gIHRvSnNcbn0gPSBtb3JpO1xuXG5jb25zdCB7c2ltcGxlLCByYXdTVkd9ID0gcmVxdWlyZSgnLi90aHJvYmJlcicpO1xuXG5jb25zdCB7IGFwaVVybCB9ID0gcmVxdWlyZSgnLi9jb25maWcnKTtcblxuY29uc3QgcGFyc2UgPSBqc29uID0+IEpTT04ucGFyc2UoanNvbik7XG5cbmV4cG9ydCBjb25zdCBtb2RlbCA9IGhhc2hNYXAoXG4gICdsb2FkaW5nJywgdHJ1ZSxcbiAgJ2RhdGEnLCBbXSxcbiAgJ3BhZ2UnLCAxLFxuICAncGFnZVNpemUnLCAyMFxuKTtcblxuLy9leHBvcnQgY29uc3QgaW5pdCA9ICgpID0+IHVwZGF0ZShtb2RlbCwgQWN0aW9uLkdldCgpKTtcbmV4cG9ydCBjb25zdCBpbml0ID0gKCkgPT4gbW9kZWw7XG5cbmV4cG9ydCBjb25zdCBBY3Rpb24gPSBUeXBlKHtcbiAgR2V0OiBbXSxcbiAgTmV4dFBhZ2U6IFtdLFxuICBQcmV2UGFnZTogW10sXG59KTtcblxuZXhwb3J0IGNvbnN0IHVwZGF0ZSA9IChtb2RlbCwgYWN0aW9uKSA9PiB7XG4gIHJldHVybiBBY3Rpb24uY2FzZSh7XG4gICAgR2V0OiAoKSA9PiByZXF1ZXN0KCdHRVQnLCBgJHthcGlVcmx9L2RhdGFgKS5nZXRCb2R5KClcbiAgICAgIC50aGVuKGQgPT4ge1xuICAgICAgICBjb25zdCByZXMgPSBwYXJzZShkKTtcbiAgICAgICAgY29uc3Qgd29yZHMgPSByZXMuc3BsaXQoJ1xcbicpO1xuICAgICAgICBsZXQgbmV3TW9kZWwgPSBhc3NvYyhhc3NvYyhtb2RlbCwgJ2xvYWRpbmcnLCBmYWxzZSksICdkYXRhJywgd29yZHMpO1xuICAgICAgICByZXR1cm4gbmV3TW9kZWw7XG4gICAgICB9KSxcbiAgICBOZXh0UGFnZTogKCkgPT4gYXNzb2MobW9kZWwsICdwYWdlJywgZ2V0KG1vZGVsLCAncGFnZScpICsgMSksXG4gICAgUHJldlBhZ2U6ICgpID0+IGFzc29jKG1vZGVsLCAncGFnZScsIGdldChtb2RlbCwgJ3BhZ2UnKSAtIDEpLFxuICB9LCBhY3Rpb24pO1xufTtcblxuZXhwb3J0IGNvbnN0IHZpZXcgPSAobW9kZWwsIGV2ZW50KSA9PiB7XG4gIGlmIChnZXQobW9kZWwsICdsb2FkaW5nJykpIHtcbiAgICBldmVudChBY3Rpb24uR2V0KCkpO1xuICB9XG4gIGNvbnN0IHtcbiAgICBsb2FkaW5nLFxuICAgIGRhdGEsXG4gICAgcGFnZSxcbiAgICBwYWdlU2l6ZVxuICB9ID0gdG9Kcyhtb2RlbCB8fCBpbml0KCkpO1xuXG4gIGNvbnN0IHBnID0gZGF0YS5zbGljZSgocGFnZSAtIDEpICogcGFnZVNpemUsIHBhZ2UgKiBwYWdlU2l6ZSk7XG5cbiAgcmV0dXJuIGgoJ2RpdicsIFtcbiAgICBsb2FkaW5nID9cbiAgICAgIGgoJ2Rpdi50aHJvYmJlcicsIHtcbiAgICAgICAgc3R5bGU6IHtcbiAgICAgICAgICBiYWNrZ3JvdW5kOiAnI2RkZCcsXG4gICAgICAgICAgZGlzcGxheTogJ2ZsZXgnLFxuICAgICAgICAgIGhlaWdodDogJzEwMCUnLFxuICAgICAgICAgIGFsaWduSXRlbXM6ICdjZW50ZXInLFxuICAgICAgICAgIGp1c3RpZnlDb250ZW50OiAnY2VudGVyJ1xuICAgICAgICB9XG4gICAgICB9LCBbXG4gICAgICAgIGgoJ3NwYW4nLCB7XG4gICAgICAgICAgcHJvcHM6IHtcbiAgICAgICAgICAgIGlubmVySFRNTDogcmF3U1ZHKDEwMClcbiAgICAgICAgICB9XG4gICAgICAgIH0pXG4gICAgICBdKVxuICAgIDogaCgnZGl2Jywge3N0eWxlOiB7YmFja2dyb3VuZDogJyNhYWEnfX0sIFtcbiAgICAgIGgoJ2J1dHRvbicsIHtcbiAgICAgICAgcHJvcHM6IHsgdHlwZTogJ2J1dHRvbicsIGRpc2FibGVkOiBwYWdlID09PSAxIH0sXG4gICAgICAgIG9uOiB7XG4gICAgICAgICAgY2xpY2s6IGUgPT4gZXZlbnQoQWN0aW9uLlByZXZQYWdlKCkpXG4gICAgICAgIH1cbiAgICAgIH0sICdQcmV2IHBhZ2UnKSxcbiAgICAgIHBhZ2UsXG4gICAgICBoKCdidXR0b24nLCB7XG4gICAgICAgIHByb3BzOiB7IHR5cGU6ICdidXR0b24nLCBkaXNhYmxlZDogcGFnZSAqIHBhZ2VTaXplID49IGRhdGEubGVuZ3RoIH0sXG4gICAgICAgIG9uOiB7XG4gICAgICAgICAgY2xpY2s6IGUgPT4gZXZlbnQoQWN0aW9uLk5leHRQYWdlKCkpXG4gICAgICAgIH1cbiAgICAgIH0sICdOZXh0IHBhZ2UnKSxcbiAgICBdKSxcbiAgICBoKCdkaXYnLCB0b0pzKG1hcCh0ID0+IGgoJ2RpdicsIHQpLCBwZykpKVxuICBdKTtcbn07XG4iLCIndXNlIHN0cmljdCc7XG5cbmNvbnN0IG1vcmkgPSByZXF1aXJlKCdtb3JpJyk7XG5jb25zdCB7IHN0YXJ0IH0gPSByZXF1aXJlKCcuL2NvcmUnKTtcbmNvbnN0IGNvbG9yc0NvbXBvbmVudCA9IHJlcXVpcmUoJy4vY29sb3JzJyk7XG5jb25zdCBsaXN0ID0gcmVxdWlyZSgnLi9saXN0Jyk7XG5cbmZ1bmN0aW9uIGluaXQoKSB7XG4gIC8vIHRoaXMgaXMgdGhlIGVsZW1lbnQgaW4gd2hpY2ggb3VyIGNvbXBvbmVudCBpcyByZW5kZXJlZFxuICBjb25zdCByb290ID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignI3Jvb3QnKTtcblxuICAvLyBleHBvc2UgdGhlIHN0YXRlIHN0cmVhbSB0byB3aW5kb3csIHdoaWNoIGFsbG93cyBmb3IgZGVidWdnaW5nXG4gIC8vd2luZG93LnMgPSBzdGFydChyb290LCBjb2xvcnNDb21wb25lbnQuaW5pdCgpLCBjb2xvcnNDb21wb25lbnQpO1xuICB3aW5kb3cucyA9IHN0YXJ0KHJvb3QsIGxpc3QuaW5pdCgpLCBsaXN0KTtcblxuICAvLyBzaW5jZSB0aGUgc3RhdGUgaXMgYSBtb3JpIGRhdGEgc3RydWN0dXJlLCBhbHNvIGV4cG9zZSBtb3JpXG4gIHdpbmRvdy5tb3JpID0gbW9yaTtcbn1cblxuLy8vIEJPT1RTVFJBUFxuY29uc3QgcmVhZHlTdGF0ZXMgPSB7aW50ZXJhY3RpdmU6MSwgY29tcGxldGU6MX07XG5pZiAoZG9jdW1lbnQucmVhZHlTdGF0ZSBpbiByZWFkeVN0YXRlcykge1xuICBpbml0KCk7XG59IGVsc2Uge1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdET01Db250ZW50TG9hZGVkJywgaW5pdCk7XG59XG4iLCJjb25zdCBoID0gcmVxdWlyZSgnc25hYmJkb20vaCcpO1xuY29uc3QgVHlwZSA9IHJlcXVpcmUoJ3VuaW9uLXR5cGUnKTtcbmNvbnN0IGZseWQgPSByZXF1aXJlKCdmbHlkJyk7XG5jb25zdCB7IHN0cmVhbSB9ID0gZmx5ZDtcbmNvbnN0IG1vcmkgPSByZXF1aXJlKCdtb3JpJyk7XG5jb25zdCB7XG4gIHZlY3RvcixcbiAgbWFwLFxuICBhc3NvYyxcbiAgbnRoLFxuICB0b0pzXG59ID0gbW9yaTtcblxuZXhwb3J0IGNvbnN0IG1vZGVsID0gMDtcbmV4cG9ydCBjb25zdCBpbml0ID0gKCkgPT4gbW9kZWw7XG5leHBvcnQgY29uc3QgaW5pdFdpdGggPSBuID0+IG47XG5cbmV4cG9ydCBjb25zdCBBY3Rpb24gPSBUeXBlKHtcbiAgU2V0OiBbTnVtYmVyXVxufSk7XG5cbmV4cG9ydCBjb25zdCB1cGRhdGUgPSAobW9kZWwsIGFjdGlvbikgPT4ge1xuICByZXR1cm4gQWN0aW9uLmNhc2Uoe1xuICAgIFNldDogbiA9PiBuXG4gIH0sIGFjdGlvbik7XG59O1xuXG5leHBvcnQgY29uc3QgdmlldyA9IChtb2RlbCwgZXZlbnQpID0+IHtcbiAgcmV0dXJuIGgoJ2RpdicsIFtcbiAgICBoKCdpbnB1dCcsIHtcbiAgICAgIHByb3BzOiB7XG4gICAgICAgIHR5cGU6ICdudW1iZXInLFxuICAgICAgICB2YWx1ZTogbW9kZWxcbiAgICAgIH0sXG4gICAgICBvbjoge1xuICAgICAgICBpbnB1dDogZSA9PiB7XG4gICAgICAgICAgY29uc3QgdiA9IHBhcnNlRmxvYXQoZS50YXJnZXQudmFsdWUpO1xuICAgICAgICAgIGlmICghaXNOYU4odikpIHtcbiAgICAgICAgICAgIGV2ZW50KEFjdGlvbi5TZXQodikpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0pXG4gIF0pO1xufTtcbiIsIlxuY29uc3QgaCA9IHJlcXVpcmUoJ3NuYWJiZG9tL2gnKTtcblxuY29uc3QgZGVmYXVsdFNpemUgPSAzMjtcbmV4cG9ydCBjb25zdCByYXdTVkcgPSAoc2l6ZSkgPT4gYFxuICAgIDxzdmcgd2lkdGg9XCIke3NpemUgfHwgZGVmYXVsdFNpemV9XCIgaGVpZ2h0PVwiJHtzaXplIHx8IGRlZmF1bHRTaXplfVwiIHZpZXdCb3g9XCIwIDAgMzAwIDMwMFwiXG4gICAgICAgICB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCIgdmVyc2lvbj1cIjEuMVwiPlxuICAgICAgPHBhdGggZD1cIk0gMTUwLDBcbiAgICAgICAgICAgICAgIGEgMTUwLDE1MCAwIDAsMSAxMDYuMDY2LDI1Ni4wNjZcbiAgICAgICAgICAgICAgIGwgLTM1LjM1NSwtMzUuMzU1XG4gICAgICAgICAgICAgICBhIC0xMDAsLTEwMCAwIDAsMCAtNzAuNzExLC0xNzAuNzExIHpcIlxuICAgICAgICAgICAgZmlsbD1cIiMxNEM5NjRcIj5cbiAgICAgIDwvcGF0aD5cbiAgICA8L3N2Zz5cbmA7XG5cbmV4cG9ydCBjb25zdCBzaW1wbGUgPSBoKCdzdmcnLCB7XG4gIHdpZHRoOiAxNiwgaGVpZ2h0OiAxNixcbiAgdmlld0JveDogJzAgMCAzMDAgMzAwJ1xufSwgW1xuICBoKCdwYXRoJywge1xuICAgIGF0dHJzOiB7XG4gICAgICBkOiBgTSAxNTAsMFxuICAgICAgYSAxNTAsMTUwIDAgMCwxIDEwNi4wNjYsMjU2LjA2NlxuICAgICAgbCAtMzUuMzU1LC0zNS4zNTVcbiAgICAgIGEgLTEwMCwtMTAwIDAgMCwwIC03MC43MTEsLTE3MC43MTEgemAsXG4gICAgICBmaWxsOiAnIzE0Qzk2NCdcbiAgICB9XG4gIH0sIFtcbiAgICBoKCdhbmltYXRlVHJhbnNmb3JtJywge1xuICAgICAgYXR0cnM6IHtcbiAgICAgICAgYXR0cmlidXRlTmFtZTondHJhbnNmb3JtJyxcbiAgICAgICAgYXR0cmlidXRlVHlwZTonWE1MJyxcbiAgICAgICAgdHlwZToncm90YXRlJyxcbiAgICAgICAgZnJvbTonMCAxNTAgMTUwJyxcbiAgICAgICAgdG86JzM2MCAxNTAgMTUwJyxcbiAgICAgICAgYmVnaW46JzBzJyxcbiAgICAgICAgZHVyOicxcycsXG4gICAgICAgIGZpbGw6J2ZyZWV6ZScsXG4gICAgICAgIHJlcGVhdENvdW50OidpbmRlZmluaXRlJ1xuICAgICAgfVxuICAgIH0pXG4gIF0pXG5dKTtcbiJdfQ==
