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

},{"ramda/src/curryN":4}],4:[function(require,module,exports){
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

},{"./internal/_arity":5,"./internal/_curry1":6,"./internal/_curry2":7,"./internal/_curryN":8}],5:[function(require,module,exports){
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

},{}],6:[function(require,module,exports){
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

},{"./_isPlaceholder":9}],7:[function(require,module,exports){
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

},{"./_curry1":6,"./_isPlaceholder":9}],8:[function(require,module,exports){
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

},{"./_arity":5,"./_isPlaceholder":9}],9:[function(require,module,exports){
module.exports = function _isPlaceholder(a) {
  return a != null &&
         typeof a === 'object' &&
         a['@@functional/placeholder'] === true;
};

},{}],10:[function(require,module,exports){
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

},{}],11:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.toJs = exports.toClj = exports.fnil = exports.curry = exports.partial = exports.pipeline = exports.knit = exports.juxt = exports.comp = exports.isOdd = exports.isEven = exports.sum = exports.dec = exports.inc = exports.constantly = exports.identity = exports.primSeq = exports.groupBy = exports.partitionBy = exports.partition = exports.repeatedly = exports.repeat = exports.iterate = exports.interleave = exports.interpose = exports.sortBy = exports.sort = exports.every = exports.some = exports.dropWhile = exports.drop = exports.takeWhile = exports.take = exports.reduceKV = exports.reduce = exports.remove = exports.filter = exports.mapcat = exports.map = exports.each = exports.intoArray = exports.flatten = exports.concat = exports.cons = exports.seq = exports.rest = exports.first = exports.isSuperset = exports.isSubset = exports.difference = exports.intersection = exports.union = exports.disj = exports.merge = exports.vals = exports.keys = exports.subvec = exports.reverse = exports.zipmap = exports.pop = exports.peek = exports.isEmpty = exports.count = exports.updateIn = exports.assocIn = exports.last = exports.nth = exports.find = exports.hasKey = exports.getIn = exports.get = exports.empty = exports.distinct = exports.dissoc = exports.assoc = exports.into = exports.conj = exports.isReversible = exports.isSeqable = exports.isReduceable = exports.isIndexed = exports.isCounted = exports.isAssociative = exports.isSequential = exports.isCollection = exports.isSet = exports.isMap = exports.isVector = exports.isSeq = exports.isList = exports.hash = exports.equals = undefined;

var _mori = require('mori');

var _mori2 = _interopRequireDefault(_mori);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

// Internal Helpers
var unaryFunc = function unaryFunc(name) {
  return function _unary() {
    return _mori2.default[name](this);
  };
};
var binaryFunc = function binaryFunc(name, rev) {
  return rev ? function _binaryRev(p) {
    return _mori2.default[name](p, this);
  } : function _binary(p) {
    return _mori2.default[name](this, p);
  };
};
var ternaryFunc = function ternaryFunc(name, rev) {
  return rev ? function _ternaryRev(a, b) {
    return _mori2.default[name](a, b, this);
  } : function _ternary(a, b) {
    return _mori2.default[name](this, a, b);
  };
};

var variadicFunc = function variadicFunc(name, rev) {
  return rev ? function _variadicRev() {
    return _mori2.default[name].apply(_mori2.default, Array.prototype.slice.call(arguments).concat([this]));
  } : function _variadic() {
    return _mori2.default[name].apply(_mori2.default, [this].concat(Array.prototype.slice.call(arguments)));
  };
};

// Fundamentals
var equals = exports.equals = binaryFunc('equals');
var hash = exports.hash = unaryFunc('hash');
// --

// Type Predicates
var isList = exports.isList = unaryFunc('isList');
var isSeq = exports.isSeq = unaryFunc('isSeq');
var isVector = exports.isVector = unaryFunc('isVector');
var isMap = exports.isMap = unaryFunc('isMap');
var isSet = exports.isSet = unaryFunc('isSet');
var isCollection = exports.isCollection = unaryFunc('isCollection');
var isSequential = exports.isSequential = unaryFunc('isSequential');
var isAssociative = exports.isAssociative = unaryFunc('isAssociative');
var isCounted = exports.isCounted = unaryFunc('isCounted');
var isIndexed = exports.isIndexed = unaryFunc('isIndexed');
var isReduceable = exports.isReduceable = unaryFunc('isReduceable');
var isSeqable = exports.isSeqable = unaryFunc('isSeqable');
var isReversible = exports.isReversible = unaryFunc('isReversible');
// --

// Collections
// --

// Collection Operations
var conj = exports.conj = variadicFunc('conj');
var into = exports.into = binaryFunc('into');
var assoc = exports.assoc = variadicFunc('assoc');
var dissoc = exports.dissoc = variadicFunc('dissoc');
var distinct = exports.distinct = unaryFunc('distinct');
var empty = exports.empty = unaryFunc('empty');
var get = exports.get = ternaryFunc('get');
var getIn = exports.getIn = ternaryFunc('getIn');
var hasKey = exports.hasKey = binaryFunc('hasKey');
var find = exports.find = binaryFunc('find');
var nth = exports.nth = binaryFunc('nth');
var last = exports.last = unaryFunc('last');
var assocIn = exports.assocIn = ternaryFunc('assocIn');
var updateIn = exports.updateIn = ternaryFunc('updateIn');
var count = exports.count = unaryFunc('count');
var isEmpty = exports.isEmpty = unaryFunc('isEmpty');
var peek = exports.peek = unaryFunc('peek');
var pop = exports.pop = unaryFunc('pop');
var zipmap = exports.zipmap = binaryFunc('zipmap');
var reverse = exports.reverse = unaryFunc('reverse');
// --

// Vector Operations
var subvec = exports.subvec = ternaryFunc('subvec');
// --

// Hash Map Operations
var keys = exports.keys = unaryFunc('keys');
var vals = exports.vals = unaryFunc('vals');
var merge = exports.merge = variadicFunc('merge');
// --

// Set Operations
var disj = exports.disj = binaryFunc('disj');
var union = exports.union = variadicFunc('union');
var intersection = exports.intersection = variadicFunc('intersection');
var difference = exports.difference = variadicFunc('difference');
var isSubset = exports.isSubset = binaryFunc('isSubset');
var isSuperset = exports.isSuperset = binaryFunc('isSuperset');
// --

// Sequences
var first = exports.first = unaryFunc('first');
var rest = exports.rest = unaryFunc('rest');
var seq = exports.seq = unaryFunc('seq');

// val first
// 1::cons(mori.vector(2, 3))
var cons = exports.cons = binaryFunc('cons');

// function first
// mori.range(3)::concat([3, 4, 5])
var concat = exports.concat = variadicFunc('concat');

var flatten = exports.flatten = unaryFunc('flatten');
var intoArray = exports.intoArray = unaryFunc('intoArray');
var each = exports.each = binaryFunc('each');

// function first
// mori.inc::map([0, 1, 2]) // => (1, 2, 3)
var map = exports.map = variadicFunc('map');

// function first
// ((x, y) => mori.list(x, x + y))::mapcat(mori.seq('abc'), mori.seq('123'));
var mapcat = exports.mapcat = variadicFunc('mapcat');

var filter = exports.filter = binaryFunc('filter', true);
var remove = exports.remove = binaryFunc('remove', true);

// function first -> special
var reduce = exports.reduce = function reduce(func, initial) {
  return _mori2.default.reduce(func, initial, this);
};

// function first
var reduceKV = exports.reduceKV = function reduceKV(func, initial) {
  return _mori2.default.reduceKV(func, initial, this);
};

var take = exports.take = binaryFunc('take', true);
var takeWhile = exports.takeWhile = binaryFunc('takeWhile', true);
var drop = exports.drop = binaryFunc('drop', true);
var dropWhile = exports.dropWhile = binaryFunc('dropWhile', true);
var some = exports.some = binaryFunc('some', true);
var every = exports.every = binaryFunc('every', true);

// optional function first
var sort = exports.sort = function sort(cmp) {
  return cmp ? _mori2.default.sort(cmp, this) : _mori2.default.sort(this);
};

// function first, optional second parameter, coll
var sortBy = exports.sortBy = function sortBy(keyFn, cmp) {
  return cmp ? _mori2.default.sortBy(keyFn, cmp, this) : _mori2.default.sortBy(keyFn, this);
};
var interpose = exports.interpose = binaryFunc('interpose', true);
var interleave = exports.interleave = variadicFunc('interleave');

// function first
var iterate = exports.iterate = binaryFunc('iterate');

// val first, first param optional
// since first param is optional, we have to do it differently
// 'foo'::repeat() // mori.repeat('foo', void)
// 'foo'::repeat(5) // mori.repeat(5, 'foo')
var repeat = exports.repeat = function mrepeat(p) {
  return p ? _mori2.default.repeat(p, this) : _mori2.default.repeat(this);
};

// function first, first param optional
// since first param is optional, we have to do it differently
var repeatedly = exports.repeatedly = function mrepeatedly(p) {
  return p ? _mori2.default.repeatedly(p, this) : _mori2.default.repeatedly(this);
};

var partition = exports.partition = variadicFunc('partition', true);
var partitionBy = exports.partitionBy = binaryFunc('partitionBy', true);
var groupBy = exports.groupBy = binaryFunc('groupBy', true);
// --

// Helpers
var primSeq = exports.primSeq = variadicFunc('primSeq');
var identity = exports.identity = unaryFunc('identity');
var constantly = exports.constantly = unaryFunc('constantly');
var inc = exports.inc = unaryFunc('inc');
var dec = exports.dec = unaryFunc('dec');
var sum = exports.sum = binaryFunc('sum');
var isEven = exports.isEven = unaryFunc('isEven');
var isOdd = exports.isOdd = unaryFunc('isOdd');
var comp = exports.comp = binaryFunc('comp');
var juxt = exports.juxt = variadicFunc('juxt');
var knit = exports.knit = variadicFunc('knit');
var pipeline = exports.pipeline = variadicFunc('pipeline');
var partial = exports.partial = variadicFunc('partial');
var curry = exports.curry = variadicFunc('curry');
var fnil = exports.fnil = ternaryFunc('fnil');
var toClj = exports.toClj = unaryFunc('toClj');
var toJs = exports.toJs = unaryFunc('toJs');
// --
},{"mori":14}],12:[function(require,module,exports){
const extra = {
};

module.exports = extra;

},{}],13:[function(require,module,exports){
/**
 Mixes in mori-ext into the prototypes of all of the collections
 that mori exposes.

 This is kind of bad, since it goes against one of the fundamental
 dogmas in mori, but it makes for a different coding style, which
 may appeal to some.
 */
const ext = require('mori-ext');

// compatibility with method type invocations,
// e.g. `map` which in mori-ext expects `this`
// to be a `function`, whereas in mori-fluent
// `this` in `map` should be a collection
// `map`, `cons`
const compat = function (mori) {
  return {
    /**
     @example
     `mori.vector(1, 2, 3).map(mori.inc); // => (2 3 4)`
     */
    map: function moriFluent_map(fn) {
      return mori.map(fn, this);
    },
    /**
     @example
     `mori.vector(1, 2).mapKV(mori.vector); // => ([0 1] [1 2])`
     */
    mapKV: function moriFluent_mapKV(fn) {
      return this
        .reduceKV((acc, k, v) => acc.conj(fn(k, v)),
                  mori.vector())
        .take(this.count());
    },
    reduce: function moriFluent_reduce(fn, initial) {
      return initial ?
        mori.reduce(fn, initial, this) :
        mori.reduce(fn, this);
    },
    reduceKV: function moriFluent_reduceKV(fn, initial) {
      return initial ?
        mori.reduceKV(fn, initial, this) :
        mori.reduceKV(fn, this);
    },
    /**
     @example
     `mori.vector(2, 3).cons(1); // => [1 2 3]`
     */
    cons: function moriFluent_cons(value) {
      mori.cons(value, this);
    }
  };
};

module.exports = function (mori, ...extraMixins) {
  const protos = [
    // basic collections
    mori.list(),
    mori.vector(),
    mori.hashMap(),
    mori.set(),
    mori.sortedSet(),
    mori.range(),
    mori.queue(),

    // special cases
    mori.seq([0]),
    mori.primSeq([0]),
    mori.map(mori.identity, [0]),
  ].map(coll => coll.constructor.prototype);

  protos.forEach(proto => {
    Object.keys(ext).forEach(k => {
      proto[k] = ext[k];
    });

    // update the prototypes with the compat layer.
    const compatLayer = compat(mori);
    Object.keys(compatLayer).forEach(k => {
      proto[k] = compatLayer[k];
    });

    // update the prototypes with extras
    extraMixins.forEach(mixin => {
      Object.keys(mixin).forEach(k => {
        proto[k] = mixin[k];
      });
    });
  });

  return mori;
};

},{"mori-ext":11}],14:[function(require,module,exports){
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

},{}],15:[function(require,module,exports){
'use strict';

module.exports = require('./lib')

},{"./lib":20}],16:[function(require,module,exports){
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

},{"asap/raw":2}],17:[function(require,module,exports){
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

},{"./core.js":16}],18:[function(require,module,exports){
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

},{"./core.js":16}],19:[function(require,module,exports){
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

},{"./core.js":16}],20:[function(require,module,exports){
'use strict';

module.exports = require('./core.js');
require('./done.js');
require('./finally.js');
require('./es6-extensions.js');
require('./node-extensions.js');
require('./synchronous.js');

},{"./core.js":16,"./done.js":17,"./es6-extensions.js":18,"./finally.js":19,"./node-extensions.js":21,"./synchronous.js":22}],21:[function(require,module,exports){
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

},{"./core.js":16,"asap":1}],22:[function(require,module,exports){
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

},{"./core.js":16}],23:[function(require,module,exports){
'use strict';

var Stringify = require('./stringify');
var Parse = require('./parse');

module.exports = {
    stringify: Stringify,
    parse: Parse
};

},{"./parse":24,"./stringify":25}],24:[function(require,module,exports){
'use strict';

var Utils = require('./utils');

var defaults = {
    delimiter: '&',
    depth: 5,
    arrayLimit: 20,
    parameterLimit: 1000,
    strictNullHandling: false,
    plainObjects: false,
    allowPrototypes: false,
    allowDots: false,
    decoder: Utils.decode
};

var parseValues = function parseValues(str, options) {
    var obj = {};
    var parts = str.split(options.delimiter, options.parameterLimit === Infinity ? undefined : options.parameterLimit);

    for (var i = 0; i < parts.length; ++i) {
        var part = parts[i];
        var pos = part.indexOf(']=') === -1 ? part.indexOf('=') : part.indexOf(']=') + 1;

        if (pos === -1) {
            obj[options.decoder(part)] = '';

            if (options.strictNullHandling) {
                obj[options.decoder(part)] = null;
            }
        } else {
            var key = options.decoder(part.slice(0, pos));
            var val = options.decoder(part.slice(pos + 1));

            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                obj[key] = [].concat(obj[key]).concat(val);
            } else {
                obj[key] = val;
            }
        }
    }

    return obj;
};

var parseObject = function parseObject(chain, val, options) {
    if (!chain.length) {
        return val;
    }

    var root = chain.shift();

    var obj;
    if (root === '[]') {
        obj = [];
        obj = obj.concat(parseObject(chain, val, options));
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
            obj[index] = parseObject(chain, val, options);
        } else {
            obj[cleanRoot] = parseObject(chain, val, options);
        }
    }

    return obj;
};

var parseKeys = function parseKeys(givenKey, val, options) {
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

    return parseObject(keys, val, options);
};

module.exports = function (str, opts) {
    var options = opts || {};

    if (options.decoder !== null && options.decoder !== undefined && typeof options.decoder !== 'function') {
        throw new TypeError('Decoder has to be a function.');
    }

    options.delimiter = typeof options.delimiter === 'string' || Utils.isRegExp(options.delimiter) ? options.delimiter : defaults.delimiter;
    options.depth = typeof options.depth === 'number' ? options.depth : defaults.depth;
    options.arrayLimit = typeof options.arrayLimit === 'number' ? options.arrayLimit : defaults.arrayLimit;
    options.parseArrays = options.parseArrays !== false;
    options.decoder = typeof options.decoder === 'function' ? options.decoder : defaults.decoder;
    options.allowDots = typeof options.allowDots === 'boolean' ? options.allowDots : defaults.allowDots;
    options.plainObjects = typeof options.plainObjects === 'boolean' ? options.plainObjects : defaults.plainObjects;
    options.allowPrototypes = typeof options.allowPrototypes === 'boolean' ? options.allowPrototypes : defaults.allowPrototypes;
    options.parameterLimit = typeof options.parameterLimit === 'number' ? options.parameterLimit : defaults.parameterLimit;
    options.strictNullHandling = typeof options.strictNullHandling === 'boolean' ? options.strictNullHandling : defaults.strictNullHandling;

    if (str === '' || str === null || typeof str === 'undefined') {
        return options.plainObjects ? Object.create(null) : {};
    }

    var tempObj = typeof str === 'string' ? parseValues(str, options) : str;
    var obj = options.plainObjects ? Object.create(null) : {};

    // Iterate over the keys and setup the new object

    var keys = Object.keys(tempObj);
    for (var i = 0; i < keys.length; ++i) {
        var key = keys[i];
        var newObj = parseKeys(key, tempObj[key], options);
        obj = Utils.merge(obj, newObj, options);
    }

    return Utils.compact(obj);
};

},{"./utils":26}],25:[function(require,module,exports){
'use strict';

var Utils = require('./utils');

var arrayPrefixGenerators = {
    brackets: function brackets(prefix) {
        return prefix + '[]';
    },
    indices: function indices(prefix, key) {
        return prefix + '[' + key + ']';
    },
    repeat: function repeat(prefix) {
        return prefix;
    }
};

var defaults = {
    delimiter: '&',
    strictNullHandling: false,
    skipNulls: false,
    encode: true,
    encoder: Utils.encode
};

var stringify = function stringify(object, prefix, generateArrayPrefix, strictNullHandling, skipNulls, encoder, filter, sort, allowDots) {
    var obj = object;
    if (typeof filter === 'function') {
        obj = filter(prefix, obj);
    } else if (obj instanceof Date) {
        obj = obj.toISOString();
    } else if (obj === null) {
        if (strictNullHandling) {
            return encoder ? encoder(prefix) : prefix;
        }

        obj = '';
    }

    if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean' || Utils.isBuffer(obj)) {
        if (encoder) {
            return [encoder(prefix) + '=' + encoder(obj)];
        }
        return [prefix + '=' + String(obj)];
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
            values = values.concat(stringify(obj[key], generateArrayPrefix(prefix, key), generateArrayPrefix, strictNullHandling, skipNulls, encoder, filter, sort, allowDots));
        } else {
            values = values.concat(stringify(obj[key], prefix + (allowDots ? '.' + key : '[' + key + ']'), generateArrayPrefix, strictNullHandling, skipNulls, encoder, filter, sort, allowDots));
        }
    }

    return values;
};

module.exports = function (object, opts) {
    var obj = object;
    var options = opts || {};
    var delimiter = typeof options.delimiter === 'undefined' ? defaults.delimiter : options.delimiter;
    var strictNullHandling = typeof options.strictNullHandling === 'boolean' ? options.strictNullHandling : defaults.strictNullHandling;
    var skipNulls = typeof options.skipNulls === 'boolean' ? options.skipNulls : defaults.skipNulls;
    var encode = typeof options.encode === 'boolean' ? options.encode : defaults.encode;
    var encoder = encode ? (typeof options.encoder === 'function' ? options.encoder : defaults.encoder) : null;
    var sort = typeof options.sort === 'function' ? options.sort : null;
    var allowDots = typeof options.allowDots === 'undefined' ? false : options.allowDots;
    var objKeys;
    var filter;

    if (options.encoder !== null && options.encoder !== undefined && typeof options.encoder !== 'function') {
        throw new TypeError('Encoder has to be a function.');
    }

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
    if (options.arrayFormat in arrayPrefixGenerators) {
        arrayFormat = options.arrayFormat;
    } else if ('indices' in options) {
        arrayFormat = options.indices ? 'indices' : 'repeat';
    } else {
        arrayFormat = 'indices';
    }

    var generateArrayPrefix = arrayPrefixGenerators[arrayFormat];

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

        keys = keys.concat(stringify(obj[key], key, generateArrayPrefix, strictNullHandling, skipNulls, encoder, filter, sort, allowDots));
    }

    return keys.join(delimiter);
};

},{"./utils":26}],26:[function(require,module,exports){
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
        out += hexTable[0xF0 | (c >> 18)] + hexTable[0x80 | ((c >> 12) & 0x3F)] + hexTable[0x80 | ((c >> 6) & 0x3F)] + hexTable[0x80 | (c & 0x3F)];
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
            if (obj[i] && typeof obj[i] === 'object') {
                compacted.push(exports.compact(obj[i], refs));
            } else if (typeof obj[i] !== 'undefined') {
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

},{}],27:[function(require,module,exports){
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

},{"./is":29,"./vnode":36}],28:[function(require,module,exports){
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

},{}],29:[function(require,module,exports){
module.exports = {
  array: Array.isArray,
  primitive: function(s) { return typeof s === 'string' || typeof s === 'number'; },
};

},{}],30:[function(require,module,exports){
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

},{}],31:[function(require,module,exports){
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

},{}],32:[function(require,module,exports){
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

},{"../is":29}],33:[function(require,module,exports){
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

},{}],34:[function(require,module,exports){
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

},{}],35:[function(require,module,exports){
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

},{"./htmldomapi":28,"./is":29,"./vnode":36}],36:[function(require,module,exports){
module.exports = function(sel, data, children, text, elm) {
  var key = data === undefined ? undefined : data.key;
  return {sel: sel, data: data, children: children,
          text: text, elm: elm, key: key};
};

},{}],37:[function(require,module,exports){
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

},{"./lib/handle-qs.js":38,"http-response-object":10,"promise":15}],38:[function(require,module,exports){
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

},{"qs":23}],39:[function(require,module,exports){
arguments[4][4][0].apply(exports,arguments)
},{"./internal/_arity":40,"./internal/_curry1":41,"./internal/_curry2":42,"./internal/_curryN":43,"dup":4}],40:[function(require,module,exports){
arguments[4][5][0].apply(exports,arguments)
},{"dup":5}],41:[function(require,module,exports){
arguments[4][6][0].apply(exports,arguments)
},{"./_isPlaceholder":44,"dup":6}],42:[function(require,module,exports){
arguments[4][7][0].apply(exports,arguments)
},{"./_curry1":41,"./_isPlaceholder":44,"dup":7}],43:[function(require,module,exports){
arguments[4][8][0].apply(exports,arguments)
},{"./_arity":40,"./_isPlaceholder":44,"dup":8}],44:[function(require,module,exports){
arguments[4][9][0].apply(exports,arguments)
},{"dup":9}],45:[function(require,module,exports){
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

},{"ramda/src/curryN":39}],46:[function(require,module,exports){
'use strict';

var apiPort = 9000;

var apiUrl = 'http://localhost:' + apiPort + '/api';

module.exports = {
  apiPort: apiPort,
  apiUrl: apiUrl
};

},{}],47:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _slicedToArray = function () { function sliceIterator(arr, i) { var _arr = []; var _n = true; var _d = false; var _e = undefined; try { for (var _i = arr[Symbol.iterator](), _s; !(_n = (_s = _i.next()).done); _n = true) { _arr.push(_s.value); if (i && _arr.length === i) break; } } catch (err) { _d = true; _e = err; } finally { try { if (!_n && _i["return"]) _i["return"](); } finally { if (_d) throw _e; } } return _arr; } return function (arr, i) { if (Array.isArray(arr)) { return arr; } else if (Symbol.iterator in Object(arr)) { return sliceIterator(arr, i); } else { throw new TypeError("Invalid attempt to destructure non-iterable instance"); } }; }();

exports.start = start;
exports.application = application;
var mori = require('mori');
var flyd = require('flyd');
var stream = flyd.stream;

var snabbdom = require('snabbdom');
var patch = snabbdom.init([require('snabbdom/modules/class'), require('snabbdom/modules/props'), require('snabbdom/modules/style'), require('snabbdom/modules/attributes'), require('snabbdom/modules/eventlisteners')]);

/// Runs an Elm architecture based application
// in order to simplify hot code replacement, the
// component parameter here is a reference to an object
// that has the two following properties: `update` and `view`
// this allows the consumer of this function to replace
// these function at will, and then call the `render` function
// which is a property on the object that is returned by `start`
function start(root, model, component) {
  // this is the stream which acts as the run loop, which enables
  // updates to be triggered arbitrarily.
  // flyd handles Promises transparently, so model could as well
  // be a Promise, which resolves to a model value.
  var state$ = stream(model);

  // this is the event handler which allows the view to trigger
  // an update. It expects an object of type Action, defined above
  // using the `union-type` library.
  var handleEvent = function handleEvent(action) {
    var currentState = state$();
    state$(component.update(currentState, action));
  };

  // the initial vnode, which is not a virtual node, at first, but will be
  // after the first pass, where this binding will be rebinded to a virtual node.
  // I.e. the result of calling the view function with the initial state and
  // the event handler.
  var vnode = root;

  // maps over the state stream, and patches the vdom
  // with the result of calling the view function with
  // the current state and the event handler.
  var history = mori.vector();

  var render = function render(state) {
    vnode = patch(vnode, component.view(state, handleEvent));
  };

  // the actual asynchronous run loop, which simply is a mapping over the
  // state stream.
  flyd.map(function (state) {
    history = mori.conj(history, state);
    render(state);
    return vnode;
  }, state$);

  // return the state stream, so that the consumer of this API may
  // expose the state stream to others, in order for them to interact
  // with the active component.
  return {
    state$: state$,
    render: render
  };
};

var fulfillsEffectProtocol = function fulfillsEffectProtocol(q) {
  return q && q.constructor == Array && q.length === 2;
};
var isEffectOf = function isEffectOf(A, a) {
  return A.prototype.isPrototypeOf(a);
};

// runs an elm arch based application, and also handles
// side/effects. It does so by allowing the update function to
// return an array which looks like this:
// [ effect, model ]
// where the effect is an instance of an action from the component.
// which will asynchronously trigger a recursive call to the
// event handler.
function application(root, init, component) {
  var state$ = stream();

  var handleResult = function handleResult(result) {
    if (fulfillsEffectProtocol(result) && isEffectOf(component.Action, result[0])) {
      (function () {
        var _result = _slicedToArray(result, 2);

        var effect = _result[0];
        var model = _result[1];

        requestAnimationFrame(function () {
          return handleEvent(effect);
        });
        state$(model);
      })();
    } else {
      // result is the model
      state$(result);
    }
  };

  var handleEvent = function handleEvent(action) {
    var currentState = state$();
    var result = component.update(currentState, action);
    handleResult(result);
  };

  var vnode = root;

  var history = mori.vector();

  var handleSubResult = function handleSubResult(path, rootModel, subComponent, result) {
    if (fulfillsEffectProtocol(result) && isEffectOf(subComponent.Action, result[0])) {
      (function () {
        var _result2 = _slicedToArray(result, 2);

        var effect = _result2[0];
        var model = _result2[1];

        requestAnimationFrame(function () {
          return handleSubEvent(path, subComponent, effect);
        });
        state$(rootModel.assocIn(path, model));
      })();
    } else {
      // result is the model
      state$(rootModel.assocIn(path, result));
    }
  };

  var handleSubEvent = function handleSubEvent(path, subComponent, action) {
    var currentState = state$();
    var result = subComponent.update(currentState.getIn(path), action);
    handleSubResult(path, currentState, subComponent, result);
  };
  var subComponents = Object.create(null);
  var subComponentEventHandler = function subComponentEventHandler(path, subComponent) {
    return handleSubEvent.bind(null, path, subComponent);
  };

  var render = function render(state) {
    vnode = patch(vnode, component.view(state, handleEvent, subComponentEventHandler));
  };

  flyd.map(function (state) {
    history = mori.conj(history, state);
    render(state);
    return vnode;
  }, state$);

  handleResult(init());

  var historyNavigation$ = stream();
  flyd.map(function (nav) {
    // ...
    var lastState = history.peek();
    history = history.pop();
    render(lastState);
  }, historyNavigation$);
  window.H = historyNavigation$;

  return {
    state$: state$,
    render: render,

    historyNavigation$: historyNavigation$
  };
};

},{"flyd":3,"mori":14,"snabbdom":35,"snabbdom/modules/attributes":30,"snabbdom/modules/class":31,"snabbdom/modules/eventlisteners":32,"snabbdom/modules/props":33,"snabbdom/modules/style":34}],48:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

function _toConsumableArray(arr) { if (Array.isArray(arr)) { for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) { arr2[i] = arr[i]; } return arr2; } else { return Array.from(arr); } }

var request = require('then-request');
var h = require('snabbdom/h');
var Type = require('union-type');
var flyd = require('flyd');
var stream = flyd.stream;

var mori = require('mori-fluent')(require('mori'));
var vector = mori.vector;
var hashMap = mori.hashMap;


var subComponent = function () {
  var submodel = 1;
  var subinit = function subinit() {
    return submodel;
  };
  var Subaction = Type({
    Inc: []
  });

  function subupdate(model, action) {
    return Subaction.case({
      Inc: function Inc() {
        return model + 1;
      }
    }, action);
  };
  var subview = function subview(model, event, subEvent) {
    return h('div', {
      on: {
        click: function click(e) {
          return event(Subaction.Inc());
        }
      }
    }, model);
  };
  return {
    submodel: submodel,
    init: subinit,
    Action: Subaction,
    update: subupdate,
    view: subview
  };
}();

var _require = require('./throbber');

var simple = _require.simple;
var rawSVG = _require.rawSVG;

var _require2 = require('./config');

var apiUrl = _require2.apiUrl;


var parse = function parse(json) {
  return JSON.parse(json);
};

var model = exports.model = hashMap('loading', false, 'data', [], 'page', 1, 'pageSize', 20, 'subData', subComponent.init());

// init func with side effect.
var init = exports.init = function init() {
  var _model;

  for (var _len = arguments.length, props = Array(_len), _key = 0; _key < _len; _key++) {
    props[_key] = arguments[_key];
  }

  return [Action.InitGet(), (_model = model).assoc.apply(_model, _toConsumableArray(props || []))];
};

var Action = exports.Action = Type({
  InitGet: [],
  Get: [],
  NextPage: [],
  PrevPage: []
});

var update = exports.update = function update(model, action) {
  return Action.case({
    InitGet: function InitGet() {
      return [Action.Get(), model.assoc('loading', true)];
    },
    Get: function Get() {
      return request('GET', apiUrl + '/data').getBody().then(function (d) {
        var res = parse(d);
        var words = res.split('\n');
        return model.assoc('loading', false, 'data', words);
      });
    },
    NextPage: function NextPage() {
      return model.updateIn(['page'], mori.inc);
    },
    PrevPage: function PrevPage() {
      return model.updateIn(['page'], mori.dec);
    }
  }, action);
};

var view = exports.view = function view(model, event, subEvent) {
  var _model$toJs = model.toJs();

  var loading = _model$toJs.loading;
  var data = _model$toJs.data;
  var page = _model$toJs.page;
  var pageSize = _model$toJs.pageSize;


  var pg = data.slice((page - 1) * pageSize, page * pageSize);

  return h('div', [subComponent.view(model.getIn(['subData']), subEvent(['subData'], subComponent)), loading ? h('div.throbber', {
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
  })]) : h('div', { style: { color: '#eee', background: '#666' } }, [h('button', {
    props: {
      innerHTML: '&laquo;',
      type: 'button',
      disabled: page === 1
    },
    on: {
      click: function click(e) {
        return event(Action.PrevPage());
      }
    }
  }), h('span', { style: { fontWeight: 'bold', margin: '1rem 2rem' } }, page), h('button', {
    props: {
      innerHTML: '&raquo;',
      type: 'button',
      disabled: page * pageSize >= data.length
    },
    on: {
      click: function click(e) {
        return event(Action.NextPage());
      }
    }
  })]), h('div', pg.map(function (t) {
    return h('div', t);
  }))]);
};

},{"./config":46,"./throbber":51,"flyd":3,"mori":14,"mori-fluent":13,"snabbdom/h":27,"then-request":37,"union-type":45}],49:[function(require,module,exports){
'use strict';

var mori = require('mori-fluent')(require('mori'), require('mori-fluent/extra'));

var _require = require('./core');

var start = _require.start;
var application = _require.application;

// the wrapper root component, which is used to facilitate
// keeping this module somewhat agnostic to changes in the
// underlying components, which helps to keep the logic
// regarding hot code simple.

var RootComponent = require('./root_component');

function init() {
  // this is the element in which our component is rendered
  var root = document.querySelector('#root');

  // start returns an object that contains the state stream
  // and a render function, which in turn accepts a model

  var _application = application(root, RootComponent.init, RootComponent);

  var state$ = _application.state$;
  var render = _application.render;

  // If hot module replacement is enabled

  if (module.hot) {
    // We accept updates to the top component
    module.hot.accept('./root_component', function (comp) {
      // Reload the component
      var component = require('./root_component');
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
var readyStates = { interactive: 1, complete: 1 };
if (document.readyState in readyStates) {
  init();
} else {
  document.addEventListener('DOMContentLoaded', init);
}

},{"./core":47,"./root_component":50,"mori":14,"mori-fluent":13,"mori-fluent/extra":12}],50:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
var app = require('./list2');
//const app = require('./outlist');

//export const init = app.initAndFetch;
var init = exports.init = app.init;
var update = exports.update = app.update;
var view = exports.view = app.view;
var Action = exports.Action = app.Action;

(function () {
  var Type = require('union-type');
  var mori = require('mori-fluent')(require('mori'));
  var vector = mori.vector;
  var hashMap = mori.hashMap;


  var isComponent = function isComponent(val) {
    return val && typeof val.init === 'function';
  };

  var model = hashMap();
  var init = function init() {
    return model;
  };
  var Action = Type({
    AddComponent: [isComponent, String]
  });
  var update = function update(model, action) {
    return Action.case({
      AddComponent: function AddComponent(component, name) {
        return model.assoc(name, component);
      }
    }, action);
  };
  var view = function view(model, event) {
    return null;
  };
});

},{"./list2":48,"mori":14,"mori-fluent":13,"union-type":45}],51:[function(require,module,exports){
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

},{"snabbdom/h":27}]},{},[49])
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL25vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCIuLi9ub2RlX21vZHVsZXMvYXNhcC9icm93c2VyLWFzYXAuanMiLCIuLi9ub2RlX21vZHVsZXMvYXNhcC9icm93c2VyLXJhdy5qcyIsIi4uL25vZGVfbW9kdWxlcy9mbHlkL2xpYi9pbmRleC5qcyIsIi4uL25vZGVfbW9kdWxlcy9mbHlkL25vZGVfbW9kdWxlcy9yYW1kYS9zcmMvY3VycnlOLmpzIiwiLi4vbm9kZV9tb2R1bGVzL2ZseWQvbm9kZV9tb2R1bGVzL3JhbWRhL3NyYy9pbnRlcm5hbC9fYXJpdHkuanMiLCIuLi9ub2RlX21vZHVsZXMvZmx5ZC9ub2RlX21vZHVsZXMvcmFtZGEvc3JjL2ludGVybmFsL19jdXJyeTEuanMiLCIuLi9ub2RlX21vZHVsZXMvZmx5ZC9ub2RlX21vZHVsZXMvcmFtZGEvc3JjL2ludGVybmFsL19jdXJyeTIuanMiLCIuLi9ub2RlX21vZHVsZXMvZmx5ZC9ub2RlX21vZHVsZXMvcmFtZGEvc3JjL2ludGVybmFsL19jdXJyeU4uanMiLCIuLi9ub2RlX21vZHVsZXMvZmx5ZC9ub2RlX21vZHVsZXMvcmFtZGEvc3JjL2ludGVybmFsL19pc1BsYWNlaG9sZGVyLmpzIiwiLi4vbm9kZV9tb2R1bGVzL2h0dHAtcmVzcG9uc2Utb2JqZWN0L2luZGV4LmpzIiwiLi4vbm9kZV9tb2R1bGVzL21vcmktZXh0L3BrZy9tb3JpLWV4dC5qcyIsIi4uL25vZGVfbW9kdWxlcy9tb3JpLWZsdWVudC9leHRyYS9pbmRleC5qcyIsIi4uL25vZGVfbW9kdWxlcy9tb3JpLWZsdWVudC9tb3JpLWZsdWVudC5qcyIsIi4uL25vZGVfbW9kdWxlcy9tb3JpL21vcmkuanMiLCIuLi9ub2RlX21vZHVsZXMvcHJvbWlzZS9pbmRleC5qcyIsIi4uL25vZGVfbW9kdWxlcy9wcm9taXNlL2xpYi9jb3JlLmpzIiwiLi4vbm9kZV9tb2R1bGVzL3Byb21pc2UvbGliL2RvbmUuanMiLCIuLi9ub2RlX21vZHVsZXMvcHJvbWlzZS9saWIvZXM2LWV4dGVuc2lvbnMuanMiLCIuLi9ub2RlX21vZHVsZXMvcHJvbWlzZS9saWIvZmluYWxseS5qcyIsIi4uL25vZGVfbW9kdWxlcy9wcm9taXNlL2xpYi9pbmRleC5qcyIsIi4uL25vZGVfbW9kdWxlcy9wcm9taXNlL2xpYi9ub2RlLWV4dGVuc2lvbnMuanMiLCIuLi9ub2RlX21vZHVsZXMvcHJvbWlzZS9saWIvc3luY2hyb25vdXMuanMiLCIuLi9ub2RlX21vZHVsZXMvcXMvbGliL2luZGV4LmpzIiwiLi4vbm9kZV9tb2R1bGVzL3FzL2xpYi9wYXJzZS5qcyIsIi4uL25vZGVfbW9kdWxlcy9xcy9saWIvc3RyaW5naWZ5LmpzIiwiLi4vbm9kZV9tb2R1bGVzL3FzL2xpYi91dGlscy5qcyIsIi4uL25vZGVfbW9kdWxlcy9zbmFiYmRvbS9oLmpzIiwiLi4vbm9kZV9tb2R1bGVzL3NuYWJiZG9tL2h0bWxkb21hcGkuanMiLCIuLi9ub2RlX21vZHVsZXMvc25hYmJkb20vaXMuanMiLCIuLi9ub2RlX21vZHVsZXMvc25hYmJkb20vbW9kdWxlcy9hdHRyaWJ1dGVzLmpzIiwiLi4vbm9kZV9tb2R1bGVzL3NuYWJiZG9tL21vZHVsZXMvY2xhc3MuanMiLCIuLi9ub2RlX21vZHVsZXMvc25hYmJkb20vbW9kdWxlcy9ldmVudGxpc3RlbmVycy5qcyIsIi4uL25vZGVfbW9kdWxlcy9zbmFiYmRvbS9tb2R1bGVzL3Byb3BzLmpzIiwiLi4vbm9kZV9tb2R1bGVzL3NuYWJiZG9tL21vZHVsZXMvc3R5bGUuanMiLCIuLi9ub2RlX21vZHVsZXMvc25hYmJkb20vc25hYmJkb20uanMiLCIuLi9ub2RlX21vZHVsZXMvc25hYmJkb20vdm5vZGUuanMiLCIuLi9ub2RlX21vZHVsZXMvdGhlbi1yZXF1ZXN0L2Jyb3dzZXIuanMiLCIuLi9ub2RlX21vZHVsZXMvdGhlbi1yZXF1ZXN0L2xpYi9oYW5kbGUtcXMuanMiLCIuLi9ub2RlX21vZHVsZXMvdW5pb24tdHlwZS91bmlvbi10eXBlLmpzIiwiLi4vc3JjL2NvbmZpZy5qcyIsIi4uL3NyYy9jb3JlLmpzIiwiLi4vc3JjL2xpc3QyLmpzIiwiLi4vc3JjL21haW4uanMiLCIuLi9zcmMvcm9vdF9jb21wb25lbnQuanMiLCIuLi9zcmMvdGhyb2JiZXIuanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FDbEVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUM1TkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2xuQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdERBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNqQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3BCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzVCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3hDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDTEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMzQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM3TUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNKQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDNUZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM2FBO0FBQ0E7QUFDQTtBQUNBOztBQ0hBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3JOQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2JBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMzR0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNoQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1JBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbElBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM5REE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDVEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZLQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDeklBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNwS0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDakNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3REQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ0pBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNsQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMxREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDaEVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2xRQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDTEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMvSEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7Ozs7Ozs7Ozs7Ozs7QUN0QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNsSUE7O0FBRUEsSUFBTSxVQUFVLElBQWhCOztBQUVBLElBQU0sK0JBQTZCLE9BQTdCLFNBQU47O0FBRUEsT0FBTyxPQUFQLEdBQWlCO0FBQ2Ysa0JBRGU7QUFFZjtBQUZlLENBQWpCOzs7Ozs7Ozs7OztRQ2FnQixLLEdBQUEsSztRQTBEQSxXLEdBQUEsVztBQTdFaEIsSUFBTSxPQUFPLFFBQVEsTUFBUixDQUFiO0FBQ0EsSUFBTSxPQUFPLFFBQVEsTUFBUixDQUFiO0lBQ1EsTSxHQUFXLEksQ0FBWCxNOztBQUNSLElBQU0sV0FBVyxRQUFRLFVBQVIsQ0FBakI7QUFDQSxJQUFNLFFBQVEsU0FBUyxJQUFULENBQWMsQ0FDMUIsUUFBUSx3QkFBUixDQUQwQixFQUUxQixRQUFRLHdCQUFSLENBRjBCLEVBRzFCLFFBQVEsd0JBQVIsQ0FIMEIsRUFJMUIsUUFBUSw2QkFBUixDQUowQixFQUsxQixRQUFRLGlDQUFSLENBTDBCLENBQWQsQ0FBZDs7Ozs7Ozs7O0FBZU8sU0FBUyxLQUFULENBQWUsSUFBZixFQUFxQixLQUFyQixFQUE0QixTQUE1QixFQUF1Qzs7Ozs7QUFLNUMsTUFBTSxTQUFTLE9BQU8sS0FBUCxDQUFmOzs7OztBQUtBLE1BQU0sY0FBYyxTQUFkLFdBQWMsQ0FBVSxNQUFWLEVBQWtCO0FBQ3BDLFFBQU0sZUFBZSxRQUFyQjtBQUNBLFdBQU8sVUFBVSxNQUFWLENBQWlCLFlBQWpCLEVBQStCLE1BQS9CLENBQVA7QUFDRCxHQUhEOzs7Ozs7QUFTQSxNQUFJLFFBQVEsSUFBWjs7Ozs7QUFLQSxNQUFJLFVBQVUsS0FBSyxNQUFMLEVBQWQ7O0FBRUEsTUFBTSxTQUFTLFNBQVQsTUFBUyxDQUFDLEtBQUQsRUFBVztBQUN4QixZQUFRLE1BQU0sS0FBTixFQUFhLFVBQVUsSUFBVixDQUFlLEtBQWYsRUFBc0IsV0FBdEIsQ0FBYixDQUFSO0FBQ0QsR0FGRDs7OztBQU1BLE9BQUssR0FBTCxDQUFTLGlCQUFTO0FBQ2hCLGNBQVUsS0FBSyxJQUFMLENBQVUsT0FBVixFQUFtQixLQUFuQixDQUFWO0FBQ0EsV0FBTyxLQUFQO0FBQ0EsV0FBTyxLQUFQO0FBQ0QsR0FKRCxFQUlHLE1BSkg7Ozs7O0FBU0EsU0FBTztBQUNMLGtCQURLO0FBRUw7QUFGSyxHQUFQO0FBSUQ7O0FBR0QsSUFBTSx5QkFBeUIsU0FBekIsc0JBQXlCO0FBQUEsU0FBSyxLQUFLLEVBQUUsV0FBRixJQUFpQixLQUF0QixJQUErQixFQUFFLE1BQUYsS0FBYSxDQUFqRDtBQUFBLENBQS9CO0FBQ0EsSUFBTSxhQUFhLFNBQWIsVUFBYSxDQUFDLENBQUQsRUFBSSxDQUFKO0FBQUEsU0FBVSxFQUFFLFNBQUYsQ0FBWSxhQUFaLENBQTBCLENBQTFCLENBQVY7QUFBQSxDQUFuQjs7Ozs7Ozs7O0FBU08sU0FBUyxXQUFULENBQXFCLElBQXJCLEVBQTJCLElBQTNCLEVBQWlDLFNBQWpDLEVBQTRDO0FBQ2pELE1BQU0sU0FBUyxRQUFmOztBQUVBLE1BQU0sZUFBZSxTQUFmLFlBQWUsQ0FBVSxNQUFWLEVBQWtCO0FBQ3JDLFFBQUksdUJBQXVCLE1BQXZCLEtBQWtDLFdBQVcsVUFBVSxNQUFyQixFQUE2QixPQUFPLENBQVAsQ0FBN0IsQ0FBdEMsRUFBK0U7QUFBQTtBQUFBLHFDQUNyRCxNQURxRDs7QUFBQSxZQUN0RSxNQURzRTtBQUFBLFlBQzlELEtBRDhEOztBQUU3RSw4QkFBc0I7QUFBQSxpQkFBTSxZQUFZLE1BQVosQ0FBTjtBQUFBLFNBQXRCO0FBQ0EsZUFBTyxLQUFQO0FBSDZFO0FBSTlFLEtBSkQsTUFJTzs7QUFFTCxhQUFPLE1BQVA7QUFDRDtBQUNGLEdBVEQ7O0FBV0EsTUFBTSxjQUFjLFNBQWQsV0FBYyxDQUFVLE1BQVYsRUFBa0I7QUFDcEMsUUFBTSxlQUFlLFFBQXJCO0FBQ0EsUUFBTSxTQUFTLFVBQVUsTUFBVixDQUFpQixZQUFqQixFQUErQixNQUEvQixDQUFmO0FBQ0EsaUJBQWEsTUFBYjtBQUNELEdBSkQ7O0FBTUEsTUFBSSxRQUFRLElBQVo7O0FBRUEsTUFBSSxVQUFVLEtBQUssTUFBTCxFQUFkOztBQUVBLE1BQU0sa0JBQWtCLFNBQWxCLGVBQWtCLENBQVUsSUFBVixFQUFnQixTQUFoQixFQUEyQixZQUEzQixFQUF5QyxNQUF6QyxFQUFpRDtBQUN2RSxRQUFJLHVCQUF1QixNQUF2QixLQUFrQyxXQUFXLGFBQWEsTUFBeEIsRUFBZ0MsT0FBTyxDQUFQLENBQWhDLENBQXRDLEVBQWtGO0FBQUE7QUFBQSxzQ0FDeEQsTUFEd0Q7O0FBQUEsWUFDekUsTUFEeUU7QUFBQSxZQUNqRSxLQURpRTs7QUFFaEYsOEJBQXNCO0FBQUEsaUJBQU0sZUFBZSxJQUFmLEVBQXFCLFlBQXJCLEVBQW1DLE1BQW5DLENBQU47QUFBQSxTQUF0QjtBQUNBLGVBQU8sVUFBVSxPQUFWLENBQWtCLElBQWxCLEVBQXdCLEtBQXhCLENBQVA7QUFIZ0Y7QUFJakYsS0FKRCxNQUlPOztBQUVMLGFBQU8sVUFBVSxPQUFWLENBQWtCLElBQWxCLEVBQXdCLE1BQXhCLENBQVA7QUFDRDtBQUNGLEdBVEQ7O0FBV0EsTUFBTSxpQkFBaUIsU0FBakIsY0FBaUIsQ0FBVSxJQUFWLEVBQWdCLFlBQWhCLEVBQThCLE1BQTlCLEVBQXNDO0FBQzNELFFBQU0sZUFBZSxRQUFyQjtBQUNBLFFBQU0sU0FBUyxhQUFhLE1BQWIsQ0FBb0IsYUFBYSxLQUFiLENBQW1CLElBQW5CLENBQXBCLEVBQThDLE1BQTlDLENBQWY7QUFDQSxvQkFBZ0IsSUFBaEIsRUFBc0IsWUFBdEIsRUFBb0MsWUFBcEMsRUFBa0QsTUFBbEQ7QUFDRCxHQUpEO0FBS0EsTUFBTSxnQkFBZ0IsT0FBTyxNQUFQLENBQWMsSUFBZCxDQUF0QjtBQUNBLE1BQU0sMkJBQTJCLFNBQTNCLHdCQUEyQixDQUFVLElBQVYsRUFBZ0IsWUFBaEIsRUFBOEI7QUFDN0QsV0FBTyxlQUFlLElBQWYsQ0FBb0IsSUFBcEIsRUFBMEIsSUFBMUIsRUFBZ0MsWUFBaEMsQ0FBUDtBQUNELEdBRkQ7O0FBSUEsTUFBTSxTQUFTLFNBQVQsTUFBUyxDQUFDLEtBQUQsRUFBVztBQUN4QixZQUFRLE1BQU0sS0FBTixFQUFhLFVBQVUsSUFBVixDQUFlLEtBQWYsRUFBc0IsV0FBdEIsRUFBbUMsd0JBQW5DLENBQWIsQ0FBUjtBQUNELEdBRkQ7O0FBSUEsT0FBSyxHQUFMLENBQVMsaUJBQVM7QUFDaEIsY0FBVSxLQUFLLElBQUwsQ0FBVSxPQUFWLEVBQW1CLEtBQW5CLENBQVY7QUFDQSxXQUFPLEtBQVA7QUFDQSxXQUFPLEtBQVA7QUFDRCxHQUpELEVBSUcsTUFKSDs7QUFNQSxlQUFhLE1BQWI7O0FBRUEsTUFBTSxxQkFBcUIsUUFBM0I7QUFDQSxPQUFLLEdBQUwsQ0FBUyxlQUFPOztBQUVkLFFBQUksWUFBWSxRQUFRLElBQVIsRUFBaEI7QUFDQSxjQUFVLFFBQVEsR0FBUixFQUFWO0FBQ0EsV0FBTyxTQUFQO0FBQ0QsR0FMRCxFQUtHLGtCQUxIO0FBTUEsU0FBTyxDQUFQLEdBQVcsa0JBQVg7O0FBRUEsU0FBTztBQUNMLGtCQURLO0FBRUwsa0JBRks7O0FBSUw7QUFKSyxHQUFQO0FBTUQ7Ozs7Ozs7Ozs7O0FDckpELElBQU0sVUFBVSxRQUFRLGNBQVIsQ0FBaEI7QUFDQSxJQUFNLElBQUksUUFBUSxZQUFSLENBQVY7QUFDQSxJQUFNLE9BQU8sUUFBUSxZQUFSLENBQWI7QUFDQSxJQUFNLE9BQU8sUUFBUSxNQUFSLENBQWI7SUFDUSxNLEdBQVcsSSxDQUFYLE07O0FBQ1IsSUFBTSxPQUFPLFFBQVEsYUFBUixFQUF1QixRQUFRLE1BQVIsQ0FBdkIsQ0FBYjtJQUVFLE0sR0FFRSxJLENBRkYsTTtJQUNBLE8sR0FDRSxJLENBREYsTzs7O0FBR0YsSUFBTSxlQUFnQixZQUFZO0FBQ2hDLE1BQU0sV0FBVyxDQUFqQjtBQUNBLE1BQU0sVUFBVSxTQUFWLE9BQVUsR0FBWTtBQUMxQixXQUFPLFFBQVA7QUFDRCxHQUZEO0FBR0EsTUFBTSxZQUFZLEtBQUs7QUFDckIsU0FBSztBQURnQixHQUFMLENBQWxCOztBQUlBLFdBQVMsU0FBVCxDQUFtQixLQUFuQixFQUEwQixNQUExQixFQUFrQztBQUNoQyxXQUFPLFVBQVUsSUFBVixDQUFlO0FBQ3BCLFdBQUs7QUFBQSxlQUFNLFFBQVEsQ0FBZDtBQUFBO0FBRGUsS0FBZixFQUVKLE1BRkksQ0FBUDtBQUdEO0FBQ0QsTUFBTSxVQUFVLFNBQVYsT0FBVSxDQUFVLEtBQVYsRUFBaUIsS0FBakIsRUFBd0IsUUFBeEIsRUFBa0M7QUFDaEQsV0FBTyxFQUFFLEtBQUYsRUFBUztBQUNkLFVBQUk7QUFDRixlQUFPO0FBQUEsaUJBQUssTUFBTSxVQUFVLEdBQVYsRUFBTixDQUFMO0FBQUE7QUFETDtBQURVLEtBQVQsRUFJSixLQUpJLENBQVA7QUFLRCxHQU5EO0FBT0EsU0FBTztBQUNMLHNCQURLO0FBRUwsVUFBTSxPQUZEO0FBR0wsWUFBUSxTQUhIO0FBSUwsWUFBUSxTQUpIO0FBS0wsVUFBTTtBQUxELEdBQVA7QUFPRCxDQTVCb0IsRUFBckI7O2VBOEJ5QixRQUFRLFlBQVIsQzs7SUFBbEIsTSxZQUFBLE07SUFBUSxNLFlBQUEsTTs7Z0JBRUksUUFBUSxVQUFSLEM7O0lBQVgsTSxhQUFBLE07OztBQUVSLElBQU0sUUFBUSxTQUFSLEtBQVE7QUFBQSxTQUFRLEtBQUssS0FBTCxDQUFXLElBQVgsQ0FBUjtBQUFBLENBQWQ7O0FBRU8sSUFBTSx3QkFBUSxRQUNuQixTQURtQixFQUNSLEtBRFEsRUFFbkIsTUFGbUIsRUFFWCxFQUZXLEVBR25CLE1BSG1CLEVBR1gsQ0FIVyxFQUluQixVQUptQixFQUlQLEVBSk8sRUFLbkIsU0FMbUIsRUFLUixhQUFhLElBQWIsRUFMUSxDQUFkOzs7QUFTQSxJQUFNLHNCQUFPLFNBQVAsSUFBTztBQUFBOztBQUFBLG9DQUFJLEtBQUo7QUFBSSxTQUFKO0FBQUE7O0FBQUEsU0FBYyxDQUNoQyxPQUFPLE9BQVAsRUFEZ0MsRUFFaEMsaUJBQU0sS0FBTixrQ0FBZSxTQUFTLEVBQXhCLEVBRmdDLENBQWQ7QUFBQSxDQUFiOztBQUtBLElBQU0sMEJBQVMsS0FBSztBQUN6QixXQUFTLEVBRGdCO0FBRXpCLE9BQUssRUFGb0I7QUFHekIsWUFBVSxFQUhlO0FBSXpCLFlBQVU7QUFKZSxDQUFMLENBQWY7O0FBT0EsSUFBTSwwQkFBUyxTQUFULE1BQVMsQ0FBQyxLQUFELEVBQVEsTUFBUixFQUFtQjtBQUN2QyxTQUFPLE9BQU8sSUFBUCxDQUFZO0FBQ2pCLGFBQVMsbUJBQU07QUFDYixhQUFPLENBQ0wsT0FBTyxHQUFQLEVBREssRUFFTCxNQUFNLEtBQU4sQ0FDRSxTQURGLEVBQ2EsSUFEYixDQUZLLENBQVA7QUFNRCxLQVJnQjtBQVNqQixTQUFLO0FBQUEsYUFBTSxRQUFRLEtBQVIsRUFBa0IsTUFBbEIsWUFBaUMsT0FBakMsR0FDUixJQURRLENBQ0gsYUFBSztBQUNULFlBQU0sTUFBTSxNQUFNLENBQU4sQ0FBWjtBQUNBLFlBQU0sUUFBUSxJQUFJLEtBQUosQ0FBVSxJQUFWLENBQWQ7QUFDQSxlQUFPLE1BQU0sS0FBTixDQUNMLFNBREssRUFDTSxLQUROLEVBRUwsTUFGSyxFQUVHLEtBRkgsQ0FBUDtBQUlELE9BUlEsQ0FBTjtBQUFBLEtBVFk7QUFrQmpCLGNBQVU7QUFBQSxhQUFNLE1BQU0sUUFBTixDQUFlLENBQUMsTUFBRCxDQUFmLEVBQXlCLEtBQUssR0FBOUIsQ0FBTjtBQUFBLEtBbEJPO0FBbUJqQixjQUFVO0FBQUEsYUFBTSxNQUFNLFFBQU4sQ0FBZSxDQUFDLE1BQUQsQ0FBZixFQUF5QixLQUFLLEdBQTlCLENBQU47QUFBQTtBQW5CTyxHQUFaLEVBb0JKLE1BcEJJLENBQVA7QUFxQkQsQ0F0Qk07O0FBd0JBLElBQU0sc0JBQU8sU0FBUCxJQUFPLENBQUMsS0FBRCxFQUFRLEtBQVIsRUFBZSxRQUFmLEVBQTRCO0FBQUEsb0JBTTFDLE1BQU0sSUFBTixFQU4wQzs7QUFBQSxNQUU1QyxPQUY0QyxlQUU1QyxPQUY0QztBQUFBLE1BRzVDLElBSDRDLGVBRzVDLElBSDRDO0FBQUEsTUFJNUMsSUFKNEMsZUFJNUMsSUFKNEM7QUFBQSxNQUs1QyxRQUw0QyxlQUs1QyxRQUw0Qzs7O0FBUTlDLE1BQU0sS0FBSyxLQUFLLEtBQUwsQ0FBVyxDQUFDLE9BQU8sQ0FBUixJQUFhLFFBQXhCLEVBQWtDLE9BQU8sUUFBekMsQ0FBWDs7QUFFQSxTQUFPLEVBQUUsS0FBRixFQUFTLENBRWQsYUFBYSxJQUFiLENBQWtCLE1BQU0sS0FBTixDQUFZLENBQUUsU0FBRixDQUFaLENBQWxCLEVBQThDLFNBQVMsQ0FBRSxTQUFGLENBQVQsRUFBd0IsWUFBeEIsQ0FBOUMsQ0FGYyxFQUlkLFVBQ0UsRUFBRSxjQUFGLEVBQWtCO0FBQ2hCLFdBQU87QUFDTCxrQkFBWSxNQURQO0FBRUwsZUFBUyxNQUZKO0FBR0wsY0FBUSxNQUhIO0FBSUwsa0JBQVksUUFKUDtBQUtMLHNCQUFnQjtBQUxYO0FBRFMsR0FBbEIsRUFRRyxDQUNELEVBQUUsTUFBRixFQUFVO0FBQ1IsV0FBTztBQUNMLGlCQUFXLE9BQU8sR0FBUDtBQUROO0FBREMsR0FBVixDQURDLENBUkgsQ0FERixHQWdCRSxFQUFFLEtBQUYsRUFBUyxFQUFDLE9BQU8sRUFBQyxPQUFPLE1BQVIsRUFBZ0IsWUFBWSxNQUE1QixFQUFSLEVBQVQsRUFBdUQsQ0FDdkQsRUFBRSxRQUFGLEVBQVk7QUFDVixXQUFPO0FBQ0wsaUJBQVcsU0FETjtBQUVMLFlBQU0sUUFGRDtBQUdMLGdCQUFVLFNBQVM7QUFIZCxLQURHO0FBTVYsUUFBSTtBQUNGLGFBQU87QUFBQSxlQUFLLE1BQU0sT0FBTyxRQUFQLEVBQU4sQ0FBTDtBQUFBO0FBREw7QUFOTSxHQUFaLENBRHVELEVBV3ZELEVBQUUsTUFBRixFQUFVLEVBQUMsT0FBTyxFQUFDLFlBQVksTUFBYixFQUFxQixRQUFRLFdBQTdCLEVBQVIsRUFBVixFQUE4RCxJQUE5RCxDQVh1RCxFQVl2RCxFQUFFLFFBQUYsRUFBWTtBQUNWLFdBQU87QUFDTCxpQkFBVyxTQUROO0FBRUwsWUFBTSxRQUZEO0FBR0wsZ0JBQVUsT0FBTyxRQUFQLElBQW1CLEtBQUs7QUFIN0IsS0FERztBQU1WLFFBQUk7QUFDRixhQUFPO0FBQUEsZUFBSyxNQUFNLE9BQU8sUUFBUCxFQUFOLENBQUw7QUFBQTtBQURMO0FBTk0sR0FBWixDQVp1RCxDQUF2RCxDQXBCWSxFQTJDZCxFQUFFLEtBQUYsRUFBUyxHQUFHLEdBQUgsQ0FBTztBQUFBLFdBQUssRUFBRSxLQUFGLEVBQVMsQ0FBVCxDQUFMO0FBQUEsR0FBUCxDQUFULENBM0NjLENBQVQsQ0FBUDtBQTZDRCxDQXZETTs7O0FDNUZQOztBQUVBLElBQU0sT0FBTyxRQUFRLGFBQVIsRUFBdUIsUUFBUSxNQUFSLENBQXZCLEVBQXdDLFFBQVEsbUJBQVIsQ0FBeEMsQ0FBYjs7ZUFDK0IsUUFBUSxRQUFSLEM7O0lBQXZCLEssWUFBQSxLO0lBQU8sVyxZQUFBLFc7Ozs7Ozs7QUFNZixJQUFNLGdCQUFnQixRQUFRLGtCQUFSLENBQXRCOztBQUVBLFNBQVMsSUFBVCxHQUFnQjs7QUFFZCxNQUFNLE9BQU8sU0FBUyxhQUFULENBQXVCLE9BQXZCLENBQWI7Ozs7O0FBRmMscUJBVVYsWUFBWSxJQUFaLEVBQWtCLGNBQWMsSUFBaEMsRUFBc0MsYUFBdEMsQ0FWVTs7QUFBQSxNQU9aLE1BUFksZ0JBT1osTUFQWTtBQUFBLE1BUVosTUFSWSxnQkFRWixNQVJZOzs7O0FBY2QsTUFBSSxPQUFPLEdBQVgsRUFBZ0I7O0FBRWQsV0FBTyxHQUFQLENBQVcsTUFBWCxDQUFrQixrQkFBbEIsRUFBc0MsVUFBQyxJQUFELEVBQVU7O0FBRTlDLFVBQU0sWUFBWSxRQUFRLGtCQUFSLENBQWxCOztBQUVBLGFBQU8sTUFBUCxDQUFjLGFBQWQsRUFBNkIsU0FBN0I7O0FBRUEsYUFBTyxRQUFQO0FBQ0QsS0FQRDtBQVFEOzs7O0FBSUQsU0FBTyxNQUFQLEdBQWdCLE1BQWhCOzs7QUFHQSxTQUFPLElBQVAsR0FBYyxJQUFkO0FBQ0Q7OztBQUdELElBQU0sY0FBYyxFQUFDLGFBQVksQ0FBYixFQUFnQixVQUFTLENBQXpCLEVBQXBCO0FBQ0EsSUFBSSxTQUFTLFVBQVQsSUFBdUIsV0FBM0IsRUFBd0M7QUFDdEM7QUFDRCxDQUZELE1BRU87QUFDTCxXQUFTLGdCQUFULENBQTBCLGtCQUExQixFQUE4QyxJQUE5QztBQUNEOzs7Ozs7OztBQ25ERCxJQUFNLE1BQU0sUUFBUSxTQUFSLENBQVo7Ozs7QUFJTyxJQUFNLHNCQUFPLElBQUksSUFBakI7QUFDQSxJQUFNLDBCQUFTLElBQUksTUFBbkI7QUFDQSxJQUFNLHNCQUFPLElBQUksSUFBakI7QUFDQSxJQUFNLDBCQUFTLElBQUksTUFBbkI7O0FBRVAsQ0FBQyxZQUFNO0FBQ0wsTUFBTSxPQUFPLFFBQVEsWUFBUixDQUFiO0FBQ0EsTUFBTSxPQUFPLFFBQVEsYUFBUixFQUF1QixRQUFRLE1BQVIsQ0FBdkIsQ0FBYjtBQUZLLE1BR0UsTUFIRixHQUdxQixJQUhyQixDQUdFLE1BSEY7QUFBQSxNQUdVLE9BSFYsR0FHcUIsSUFIckIsQ0FHVSxPQUhWOzs7QUFLTCxNQUFNLGNBQWMsU0FBZCxXQUFjO0FBQUEsV0FBTyxPQUFPLE9BQU8sSUFBSSxJQUFYLEtBQW9CLFVBQWxDO0FBQUEsR0FBcEI7O0FBRUEsTUFBTSxRQUFRLFNBQWQ7QUFDQSxNQUFNLE9BQU8sU0FBUCxJQUFPO0FBQUEsV0FBTSxLQUFOO0FBQUEsR0FBYjtBQUNBLE1BQU0sU0FBUyxLQUFLO0FBQ2xCLGtCQUFjLENBQUMsV0FBRCxFQUFjLE1BQWQ7QUFESSxHQUFMLENBQWY7QUFHQSxNQUFNLFNBQVMsU0FBVCxNQUFTLENBQUMsS0FBRCxFQUFRLE1BQVIsRUFBbUI7QUFDaEMsV0FBTyxPQUFPLElBQVAsQ0FBWTtBQUNqQixvQkFBYyxzQkFBQyxTQUFELEVBQVksSUFBWixFQUFxQjtBQUNqQyxlQUFPLE1BQU0sS0FBTixDQUFZLElBQVosRUFBa0IsU0FBbEIsQ0FBUDtBQUNEO0FBSGdCLEtBQVosRUFJSixNQUpJLENBQVA7QUFLRCxHQU5EO0FBT0EsTUFBTSxPQUFPLFNBQVAsSUFBTyxDQUFDLEtBQUQsRUFBUSxLQUFSLEVBQWtCO0FBQzdCLFdBQU8sSUFBUDtBQUNELEdBRkQ7QUFHRCxDQXRCRDs7Ozs7Ozs7O0FDUkEsSUFBTSxJQUFJLFFBQVEsWUFBUixDQUFWOztBQUVBLElBQU0sY0FBYyxFQUFwQjtBQUNPLElBQU0sMEJBQVMsU0FBVCxNQUFTLENBQUMsSUFBRDtBQUFBLGlDQUNKLFFBQVEsV0FESixvQkFDNEIsUUFBUSxXQURwQztBQUFBLENBQWY7O0FBWUEsSUFBTSwwQkFBUyxFQUFFLEtBQUYsRUFBUztBQUM3QixTQUFPLEVBRHNCLEVBQ2xCLFFBQVEsRUFEVTtBQUU3QixXQUFTO0FBRm9CLENBQVQsRUFHbkIsQ0FDRCxFQUFFLE1BQUYsRUFBVTtBQUNSLFNBQU87QUFDTCw0SEFESztBQUtMLFVBQU07QUFMRDtBQURDLENBQVYsRUFRRyxDQUNELEVBQUUsa0JBQUYsRUFBc0I7QUFDcEIsU0FBTztBQUNMLG1CQUFjLFdBRFQ7QUFFTCxtQkFBYyxLQUZUO0FBR0wsVUFBSyxRQUhBO0FBSUwsVUFBSyxXQUpBO0FBS0wsUUFBRyxhQUxFO0FBTUwsV0FBTSxJQU5EO0FBT0wsU0FBSSxJQVBDO0FBUUwsVUFBSyxRQVJBO0FBU0wsaUJBQVk7QUFUUDtBQURhLENBQXRCLENBREMsQ0FSSCxDQURDLENBSG1CLENBQWYiLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbiBlKHQsbixyKXtmdW5jdGlvbiBzKG8sdSl7aWYoIW5bb10pe2lmKCF0W29dKXt2YXIgYT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2lmKCF1JiZhKXJldHVybiBhKG8sITApO2lmKGkpcmV0dXJuIGkobywhMCk7dmFyIGY9bmV3IEVycm9yKFwiQ2Fubm90IGZpbmQgbW9kdWxlICdcIitvK1wiJ1wiKTt0aHJvdyBmLmNvZGU9XCJNT0RVTEVfTk9UX0ZPVU5EXCIsZn12YXIgbD1uW29dPXtleHBvcnRzOnt9fTt0W29dWzBdLmNhbGwobC5leHBvcnRzLGZ1bmN0aW9uKGUpe3ZhciBuPXRbb11bMV1bZV07cmV0dXJuIHMobj9uOmUpfSxsLGwuZXhwb3J0cyxlLHQsbixyKX1yZXR1cm4gbltvXS5leHBvcnRzfXZhciBpPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7Zm9yKHZhciBvPTA7bzxyLmxlbmd0aDtvKyspcyhyW29dKTtyZXR1cm4gc30pIiwiXCJ1c2Ugc3RyaWN0XCI7XG5cbi8vIHJhd0FzYXAgcHJvdmlkZXMgZXZlcnl0aGluZyB3ZSBuZWVkIGV4Y2VwdCBleGNlcHRpb24gbWFuYWdlbWVudC5cbnZhciByYXdBc2FwID0gcmVxdWlyZShcIi4vcmF3XCIpO1xuLy8gUmF3VGFza3MgYXJlIHJlY3ljbGVkIHRvIHJlZHVjZSBHQyBjaHVybi5cbnZhciBmcmVlVGFza3MgPSBbXTtcbi8vIFdlIHF1ZXVlIGVycm9ycyB0byBlbnN1cmUgdGhleSBhcmUgdGhyb3duIGluIHJpZ2h0IG9yZGVyIChGSUZPKS5cbi8vIEFycmF5LWFzLXF1ZXVlIGlzIGdvb2QgZW5vdWdoIGhlcmUsIHNpbmNlIHdlIGFyZSBqdXN0IGRlYWxpbmcgd2l0aCBleGNlcHRpb25zLlxudmFyIHBlbmRpbmdFcnJvcnMgPSBbXTtcbnZhciByZXF1ZXN0RXJyb3JUaHJvdyA9IHJhd0FzYXAubWFrZVJlcXVlc3RDYWxsRnJvbVRpbWVyKHRocm93Rmlyc3RFcnJvcik7XG5cbmZ1bmN0aW9uIHRocm93Rmlyc3RFcnJvcigpIHtcbiAgICBpZiAocGVuZGluZ0Vycm9ycy5sZW5ndGgpIHtcbiAgICAgICAgdGhyb3cgcGVuZGluZ0Vycm9ycy5zaGlmdCgpO1xuICAgIH1cbn1cblxuLyoqXG4gKiBDYWxscyBhIHRhc2sgYXMgc29vbiBhcyBwb3NzaWJsZSBhZnRlciByZXR1cm5pbmcsIGluIGl0cyBvd24gZXZlbnQsIHdpdGggcHJpb3JpdHlcbiAqIG92ZXIgb3RoZXIgZXZlbnRzIGxpa2UgYW5pbWF0aW9uLCByZWZsb3csIGFuZCByZXBhaW50LiBBbiBlcnJvciB0aHJvd24gZnJvbSBhblxuICogZXZlbnQgd2lsbCBub3QgaW50ZXJydXB0LCBub3IgZXZlbiBzdWJzdGFudGlhbGx5IHNsb3cgZG93biB0aGUgcHJvY2Vzc2luZyBvZlxuICogb3RoZXIgZXZlbnRzLCBidXQgd2lsbCBiZSByYXRoZXIgcG9zdHBvbmVkIHRvIGEgbG93ZXIgcHJpb3JpdHkgZXZlbnQuXG4gKiBAcGFyYW0ge3tjYWxsfX0gdGFzayBBIGNhbGxhYmxlIG9iamVjdCwgdHlwaWNhbGx5IGEgZnVuY3Rpb24gdGhhdCB0YWtlcyBub1xuICogYXJndW1lbnRzLlxuICovXG5tb2R1bGUuZXhwb3J0cyA9IGFzYXA7XG5mdW5jdGlvbiBhc2FwKHRhc2spIHtcbiAgICB2YXIgcmF3VGFzaztcbiAgICBpZiAoZnJlZVRhc2tzLmxlbmd0aCkge1xuICAgICAgICByYXdUYXNrID0gZnJlZVRhc2tzLnBvcCgpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHJhd1Rhc2sgPSBuZXcgUmF3VGFzaygpO1xuICAgIH1cbiAgICByYXdUYXNrLnRhc2sgPSB0YXNrO1xuICAgIHJhd0FzYXAocmF3VGFzayk7XG59XG5cbi8vIFdlIHdyYXAgdGFza3Mgd2l0aCByZWN5Y2xhYmxlIHRhc2sgb2JqZWN0cy4gIEEgdGFzayBvYmplY3QgaW1wbGVtZW50c1xuLy8gYGNhbGxgLCBqdXN0IGxpa2UgYSBmdW5jdGlvbi5cbmZ1bmN0aW9uIFJhd1Rhc2soKSB7XG4gICAgdGhpcy50YXNrID0gbnVsbDtcbn1cblxuLy8gVGhlIHNvbGUgcHVycG9zZSBvZiB3cmFwcGluZyB0aGUgdGFzayBpcyB0byBjYXRjaCB0aGUgZXhjZXB0aW9uIGFuZCByZWN5Y2xlXG4vLyB0aGUgdGFzayBvYmplY3QgYWZ0ZXIgaXRzIHNpbmdsZSB1c2UuXG5SYXdUYXNrLnByb3RvdHlwZS5jYWxsID0gZnVuY3Rpb24gKCkge1xuICAgIHRyeSB7XG4gICAgICAgIHRoaXMudGFzay5jYWxsKCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgaWYgKGFzYXAub25lcnJvcikge1xuICAgICAgICAgICAgLy8gVGhpcyBob29rIGV4aXN0cyBwdXJlbHkgZm9yIHRlc3RpbmcgcHVycG9zZXMuXG4gICAgICAgICAgICAvLyBJdHMgbmFtZSB3aWxsIGJlIHBlcmlvZGljYWxseSByYW5kb21pemVkIHRvIGJyZWFrIGFueSBjb2RlIHRoYXRcbiAgICAgICAgICAgIC8vIGRlcGVuZHMgb24gaXRzIGV4aXN0ZW5jZS5cbiAgICAgICAgICAgIGFzYXAub25lcnJvcihlcnJvcik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyBJbiBhIHdlYiBicm93c2VyLCBleGNlcHRpb25zIGFyZSBub3QgZmF0YWwuIEhvd2V2ZXIsIHRvIGF2b2lkXG4gICAgICAgICAgICAvLyBzbG93aW5nIGRvd24gdGhlIHF1ZXVlIG9mIHBlbmRpbmcgdGFza3MsIHdlIHJldGhyb3cgdGhlIGVycm9yIGluIGFcbiAgICAgICAgICAgIC8vIGxvd2VyIHByaW9yaXR5IHR1cm4uXG4gICAgICAgICAgICBwZW5kaW5nRXJyb3JzLnB1c2goZXJyb3IpO1xuICAgICAgICAgICAgcmVxdWVzdEVycm9yVGhyb3coKTtcbiAgICAgICAgfVxuICAgIH0gZmluYWxseSB7XG4gICAgICAgIHRoaXMudGFzayA9IG51bGw7XG4gICAgICAgIGZyZWVUYXNrc1tmcmVlVGFza3MubGVuZ3RoXSA9IHRoaXM7XG4gICAgfVxufTtcbiIsIlwidXNlIHN0cmljdFwiO1xuXG4vLyBVc2UgdGhlIGZhc3Rlc3QgbWVhbnMgcG9zc2libGUgdG8gZXhlY3V0ZSBhIHRhc2sgaW4gaXRzIG93biB0dXJuLCB3aXRoXG4vLyBwcmlvcml0eSBvdmVyIG90aGVyIGV2ZW50cyBpbmNsdWRpbmcgSU8sIGFuaW1hdGlvbiwgcmVmbG93LCBhbmQgcmVkcmF3XG4vLyBldmVudHMgaW4gYnJvd3NlcnMuXG4vL1xuLy8gQW4gZXhjZXB0aW9uIHRocm93biBieSBhIHRhc2sgd2lsbCBwZXJtYW5lbnRseSBpbnRlcnJ1cHQgdGhlIHByb2Nlc3Npbmcgb2Zcbi8vIHN1YnNlcXVlbnQgdGFza3MuIFRoZSBoaWdoZXIgbGV2ZWwgYGFzYXBgIGZ1bmN0aW9uIGVuc3VyZXMgdGhhdCBpZiBhblxuLy8gZXhjZXB0aW9uIGlzIHRocm93biBieSBhIHRhc2ssIHRoYXQgdGhlIHRhc2sgcXVldWUgd2lsbCBjb250aW51ZSBmbHVzaGluZyBhc1xuLy8gc29vbiBhcyBwb3NzaWJsZSwgYnV0IGlmIHlvdSB1c2UgYHJhd0FzYXBgIGRpcmVjdGx5LCB5b3UgYXJlIHJlc3BvbnNpYmxlIHRvXG4vLyBlaXRoZXIgZW5zdXJlIHRoYXQgbm8gZXhjZXB0aW9ucyBhcmUgdGhyb3duIGZyb20geW91ciB0YXNrLCBvciB0byBtYW51YWxseVxuLy8gY2FsbCBgcmF3QXNhcC5yZXF1ZXN0Rmx1c2hgIGlmIGFuIGV4Y2VwdGlvbiBpcyB0aHJvd24uXG5tb2R1bGUuZXhwb3J0cyA9IHJhd0FzYXA7XG5mdW5jdGlvbiByYXdBc2FwKHRhc2spIHtcbiAgICBpZiAoIXF1ZXVlLmxlbmd0aCkge1xuICAgICAgICByZXF1ZXN0Rmx1c2goKTtcbiAgICAgICAgZmx1c2hpbmcgPSB0cnVlO1xuICAgIH1cbiAgICAvLyBFcXVpdmFsZW50IHRvIHB1c2gsIGJ1dCBhdm9pZHMgYSBmdW5jdGlvbiBjYWxsLlxuICAgIHF1ZXVlW3F1ZXVlLmxlbmd0aF0gPSB0YXNrO1xufVxuXG52YXIgcXVldWUgPSBbXTtcbi8vIE9uY2UgYSBmbHVzaCBoYXMgYmVlbiByZXF1ZXN0ZWQsIG5vIGZ1cnRoZXIgY2FsbHMgdG8gYHJlcXVlc3RGbHVzaGAgYXJlXG4vLyBuZWNlc3NhcnkgdW50aWwgdGhlIG5leHQgYGZsdXNoYCBjb21wbGV0ZXMuXG52YXIgZmx1c2hpbmcgPSBmYWxzZTtcbi8vIGByZXF1ZXN0Rmx1c2hgIGlzIGFuIGltcGxlbWVudGF0aW9uLXNwZWNpZmljIG1ldGhvZCB0aGF0IGF0dGVtcHRzIHRvIGtpY2tcbi8vIG9mZiBhIGBmbHVzaGAgZXZlbnQgYXMgcXVpY2tseSBhcyBwb3NzaWJsZS4gYGZsdXNoYCB3aWxsIGF0dGVtcHQgdG8gZXhoYXVzdFxuLy8gdGhlIGV2ZW50IHF1ZXVlIGJlZm9yZSB5aWVsZGluZyB0byB0aGUgYnJvd3NlcidzIG93biBldmVudCBsb29wLlxudmFyIHJlcXVlc3RGbHVzaDtcbi8vIFRoZSBwb3NpdGlvbiBvZiB0aGUgbmV4dCB0YXNrIHRvIGV4ZWN1dGUgaW4gdGhlIHRhc2sgcXVldWUuIFRoaXMgaXNcbi8vIHByZXNlcnZlZCBiZXR3ZWVuIGNhbGxzIHRvIGBmbHVzaGAgc28gdGhhdCBpdCBjYW4gYmUgcmVzdW1lZCBpZlxuLy8gYSB0YXNrIHRocm93cyBhbiBleGNlcHRpb24uXG52YXIgaW5kZXggPSAwO1xuLy8gSWYgYSB0YXNrIHNjaGVkdWxlcyBhZGRpdGlvbmFsIHRhc2tzIHJlY3Vyc2l2ZWx5LCB0aGUgdGFzayBxdWV1ZSBjYW4gZ3Jvd1xuLy8gdW5ib3VuZGVkLiBUbyBwcmV2ZW50IG1lbW9yeSBleGhhdXN0aW9uLCB0aGUgdGFzayBxdWV1ZSB3aWxsIHBlcmlvZGljYWxseVxuLy8gdHJ1bmNhdGUgYWxyZWFkeS1jb21wbGV0ZWQgdGFza3MuXG52YXIgY2FwYWNpdHkgPSAxMDI0O1xuXG4vLyBUaGUgZmx1c2ggZnVuY3Rpb24gcHJvY2Vzc2VzIGFsbCB0YXNrcyB0aGF0IGhhdmUgYmVlbiBzY2hlZHVsZWQgd2l0aFxuLy8gYHJhd0FzYXBgIHVubGVzcyBhbmQgdW50aWwgb25lIG9mIHRob3NlIHRhc2tzIHRocm93cyBhbiBleGNlcHRpb24uXG4vLyBJZiBhIHRhc2sgdGhyb3dzIGFuIGV4Y2VwdGlvbiwgYGZsdXNoYCBlbnN1cmVzIHRoYXQgaXRzIHN0YXRlIHdpbGwgcmVtYWluXG4vLyBjb25zaXN0ZW50IGFuZCB3aWxsIHJlc3VtZSB3aGVyZSBpdCBsZWZ0IG9mZiB3aGVuIGNhbGxlZCBhZ2Fpbi5cbi8vIEhvd2V2ZXIsIGBmbHVzaGAgZG9lcyBub3QgbWFrZSBhbnkgYXJyYW5nZW1lbnRzIHRvIGJlIGNhbGxlZCBhZ2FpbiBpZiBhblxuLy8gZXhjZXB0aW9uIGlzIHRocm93bi5cbmZ1bmN0aW9uIGZsdXNoKCkge1xuICAgIHdoaWxlIChpbmRleCA8IHF1ZXVlLmxlbmd0aCkge1xuICAgICAgICB2YXIgY3VycmVudEluZGV4ID0gaW5kZXg7XG4gICAgICAgIC8vIEFkdmFuY2UgdGhlIGluZGV4IGJlZm9yZSBjYWxsaW5nIHRoZSB0YXNrLiBUaGlzIGVuc3VyZXMgdGhhdCB3ZSB3aWxsXG4gICAgICAgIC8vIGJlZ2luIGZsdXNoaW5nIG9uIHRoZSBuZXh0IHRhc2sgdGhlIHRhc2sgdGhyb3dzIGFuIGVycm9yLlxuICAgICAgICBpbmRleCA9IGluZGV4ICsgMTtcbiAgICAgICAgcXVldWVbY3VycmVudEluZGV4XS5jYWxsKCk7XG4gICAgICAgIC8vIFByZXZlbnQgbGVha2luZyBtZW1vcnkgZm9yIGxvbmcgY2hhaW5zIG9mIHJlY3Vyc2l2ZSBjYWxscyB0byBgYXNhcGAuXG4gICAgICAgIC8vIElmIHdlIGNhbGwgYGFzYXBgIHdpdGhpbiB0YXNrcyBzY2hlZHVsZWQgYnkgYGFzYXBgLCB0aGUgcXVldWUgd2lsbFxuICAgICAgICAvLyBncm93LCBidXQgdG8gYXZvaWQgYW4gTyhuKSB3YWxrIGZvciBldmVyeSB0YXNrIHdlIGV4ZWN1dGUsIHdlIGRvbid0XG4gICAgICAgIC8vIHNoaWZ0IHRhc2tzIG9mZiB0aGUgcXVldWUgYWZ0ZXIgdGhleSBoYXZlIGJlZW4gZXhlY3V0ZWQuXG4gICAgICAgIC8vIEluc3RlYWQsIHdlIHBlcmlvZGljYWxseSBzaGlmdCAxMDI0IHRhc2tzIG9mZiB0aGUgcXVldWUuXG4gICAgICAgIGlmIChpbmRleCA+IGNhcGFjaXR5KSB7XG4gICAgICAgICAgICAvLyBNYW51YWxseSBzaGlmdCBhbGwgdmFsdWVzIHN0YXJ0aW5nIGF0IHRoZSBpbmRleCBiYWNrIHRvIHRoZVxuICAgICAgICAgICAgLy8gYmVnaW5uaW5nIG9mIHRoZSBxdWV1ZS5cbiAgICAgICAgICAgIGZvciAodmFyIHNjYW4gPSAwLCBuZXdMZW5ndGggPSBxdWV1ZS5sZW5ndGggLSBpbmRleDsgc2NhbiA8IG5ld0xlbmd0aDsgc2NhbisrKSB7XG4gICAgICAgICAgICAgICAgcXVldWVbc2Nhbl0gPSBxdWV1ZVtzY2FuICsgaW5kZXhdO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcXVldWUubGVuZ3RoIC09IGluZGV4O1xuICAgICAgICAgICAgaW5kZXggPSAwO1xuICAgICAgICB9XG4gICAgfVxuICAgIHF1ZXVlLmxlbmd0aCA9IDA7XG4gICAgaW5kZXggPSAwO1xuICAgIGZsdXNoaW5nID0gZmFsc2U7XG59XG5cbi8vIGByZXF1ZXN0Rmx1c2hgIGlzIGltcGxlbWVudGVkIHVzaW5nIGEgc3RyYXRlZ3kgYmFzZWQgb24gZGF0YSBjb2xsZWN0ZWQgZnJvbVxuLy8gZXZlcnkgYXZhaWxhYmxlIFNhdWNlTGFicyBTZWxlbml1bSB3ZWIgZHJpdmVyIHdvcmtlciBhdCB0aW1lIG9mIHdyaXRpbmcuXG4vLyBodHRwczovL2RvY3MuZ29vZ2xlLmNvbS9zcHJlYWRzaGVldHMvZC8xbUctNVVZR3VwNXF4R2RFTVdraFA2QldDejA1M05VYjJFMVFvVVRVMTZ1QS9lZGl0I2dpZD03ODM3MjQ1OTNcblxuLy8gU2FmYXJpIDYgYW5kIDYuMSBmb3IgZGVza3RvcCwgaVBhZCwgYW5kIGlQaG9uZSBhcmUgdGhlIG9ubHkgYnJvd3NlcnMgdGhhdFxuLy8gaGF2ZSBXZWJLaXRNdXRhdGlvbk9ic2VydmVyIGJ1dCBub3QgdW4tcHJlZml4ZWQgTXV0YXRpb25PYnNlcnZlci5cbi8vIE11c3QgdXNlIGBnbG9iYWxgIGluc3RlYWQgb2YgYHdpbmRvd2AgdG8gd29yayBpbiBib3RoIGZyYW1lcyBhbmQgd2ViXG4vLyB3b3JrZXJzLiBgZ2xvYmFsYCBpcyBhIHByb3Zpc2lvbiBvZiBCcm93c2VyaWZ5LCBNciwgTXJzLCBvciBNb3AuXG52YXIgQnJvd3Nlck11dGF0aW9uT2JzZXJ2ZXIgPSBnbG9iYWwuTXV0YXRpb25PYnNlcnZlciB8fCBnbG9iYWwuV2ViS2l0TXV0YXRpb25PYnNlcnZlcjtcblxuLy8gTXV0YXRpb25PYnNlcnZlcnMgYXJlIGRlc2lyYWJsZSBiZWNhdXNlIHRoZXkgaGF2ZSBoaWdoIHByaW9yaXR5IGFuZCB3b3JrXG4vLyByZWxpYWJseSBldmVyeXdoZXJlIHRoZXkgYXJlIGltcGxlbWVudGVkLlxuLy8gVGhleSBhcmUgaW1wbGVtZW50ZWQgaW4gYWxsIG1vZGVybiBicm93c2Vycy5cbi8vXG4vLyAtIEFuZHJvaWQgNC00LjNcbi8vIC0gQ2hyb21lIDI2LTM0XG4vLyAtIEZpcmVmb3ggMTQtMjlcbi8vIC0gSW50ZXJuZXQgRXhwbG9yZXIgMTFcbi8vIC0gaVBhZCBTYWZhcmkgNi03LjFcbi8vIC0gaVBob25lIFNhZmFyaSA3LTcuMVxuLy8gLSBTYWZhcmkgNi03XG5pZiAodHlwZW9mIEJyb3dzZXJNdXRhdGlvbk9ic2VydmVyID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICByZXF1ZXN0Rmx1c2ggPSBtYWtlUmVxdWVzdENhbGxGcm9tTXV0YXRpb25PYnNlcnZlcihmbHVzaCk7XG5cbi8vIE1lc3NhZ2VDaGFubmVscyBhcmUgZGVzaXJhYmxlIGJlY2F1c2UgdGhleSBnaXZlIGRpcmVjdCBhY2Nlc3MgdG8gdGhlIEhUTUxcbi8vIHRhc2sgcXVldWUsIGFyZSBpbXBsZW1lbnRlZCBpbiBJbnRlcm5ldCBFeHBsb3JlciAxMCwgU2FmYXJpIDUuMC0xLCBhbmQgT3BlcmFcbi8vIDExLTEyLCBhbmQgaW4gd2ViIHdvcmtlcnMgaW4gbWFueSBlbmdpbmVzLlxuLy8gQWx0aG91Z2ggbWVzc2FnZSBjaGFubmVscyB5aWVsZCB0byBhbnkgcXVldWVkIHJlbmRlcmluZyBhbmQgSU8gdGFza3MsIHRoZXlcbi8vIHdvdWxkIGJlIGJldHRlciB0aGFuIGltcG9zaW5nIHRoZSA0bXMgZGVsYXkgb2YgdGltZXJzLlxuLy8gSG93ZXZlciwgdGhleSBkbyBub3Qgd29yayByZWxpYWJseSBpbiBJbnRlcm5ldCBFeHBsb3JlciBvciBTYWZhcmkuXG5cbi8vIEludGVybmV0IEV4cGxvcmVyIDEwIGlzIHRoZSBvbmx5IGJyb3dzZXIgdGhhdCBoYXMgc2V0SW1tZWRpYXRlIGJ1dCBkb2VzXG4vLyBub3QgaGF2ZSBNdXRhdGlvbk9ic2VydmVycy5cbi8vIEFsdGhvdWdoIHNldEltbWVkaWF0ZSB5aWVsZHMgdG8gdGhlIGJyb3dzZXIncyByZW5kZXJlciwgaXQgd291bGQgYmVcbi8vIHByZWZlcnJhYmxlIHRvIGZhbGxpbmcgYmFjayB0byBzZXRUaW1lb3V0IHNpbmNlIGl0IGRvZXMgbm90IGhhdmVcbi8vIHRoZSBtaW5pbXVtIDRtcyBwZW5hbHR5LlxuLy8gVW5mb3J0dW5hdGVseSB0aGVyZSBhcHBlYXJzIHRvIGJlIGEgYnVnIGluIEludGVybmV0IEV4cGxvcmVyIDEwIE1vYmlsZSAoYW5kXG4vLyBEZXNrdG9wIHRvIGEgbGVzc2VyIGV4dGVudCkgdGhhdCByZW5kZXJzIGJvdGggc2V0SW1tZWRpYXRlIGFuZFxuLy8gTWVzc2FnZUNoYW5uZWwgdXNlbGVzcyBmb3IgdGhlIHB1cnBvc2VzIG9mIEFTQVAuXG4vLyBodHRwczovL2dpdGh1Yi5jb20va3Jpc2tvd2FsL3EvaXNzdWVzLzM5NlxuXG4vLyBUaW1lcnMgYXJlIGltcGxlbWVudGVkIHVuaXZlcnNhbGx5LlxuLy8gV2UgZmFsbCBiYWNrIHRvIHRpbWVycyBpbiB3b3JrZXJzIGluIG1vc3QgZW5naW5lcywgYW5kIGluIGZvcmVncm91bmRcbi8vIGNvbnRleHRzIGluIHRoZSBmb2xsb3dpbmcgYnJvd3NlcnMuXG4vLyBIb3dldmVyLCBub3RlIHRoYXQgZXZlbiB0aGlzIHNpbXBsZSBjYXNlIHJlcXVpcmVzIG51YW5jZXMgdG8gb3BlcmF0ZSBpbiBhXG4vLyBicm9hZCBzcGVjdHJ1bSBvZiBicm93c2Vycy5cbi8vXG4vLyAtIEZpcmVmb3ggMy0xM1xuLy8gLSBJbnRlcm5ldCBFeHBsb3JlciA2LTlcbi8vIC0gaVBhZCBTYWZhcmkgNC4zXG4vLyAtIEx5bnggMi44Ljdcbn0gZWxzZSB7XG4gICAgcmVxdWVzdEZsdXNoID0gbWFrZVJlcXVlc3RDYWxsRnJvbVRpbWVyKGZsdXNoKTtcbn1cblxuLy8gYHJlcXVlc3RGbHVzaGAgcmVxdWVzdHMgdGhhdCB0aGUgaGlnaCBwcmlvcml0eSBldmVudCBxdWV1ZSBiZSBmbHVzaGVkIGFzXG4vLyBzb29uIGFzIHBvc3NpYmxlLlxuLy8gVGhpcyBpcyB1c2VmdWwgdG8gcHJldmVudCBhbiBlcnJvciB0aHJvd24gaW4gYSB0YXNrIGZyb20gc3RhbGxpbmcgdGhlIGV2ZW50XG4vLyBxdWV1ZSBpZiB0aGUgZXhjZXB0aW9uIGhhbmRsZWQgYnkgTm9kZS5qc+KAmXNcbi8vIGBwcm9jZXNzLm9uKFwidW5jYXVnaHRFeGNlcHRpb25cIilgIG9yIGJ5IGEgZG9tYWluLlxucmF3QXNhcC5yZXF1ZXN0Rmx1c2ggPSByZXF1ZXN0Rmx1c2g7XG5cbi8vIFRvIHJlcXVlc3QgYSBoaWdoIHByaW9yaXR5IGV2ZW50LCB3ZSBpbmR1Y2UgYSBtdXRhdGlvbiBvYnNlcnZlciBieSB0b2dnbGluZ1xuLy8gdGhlIHRleHQgb2YgYSB0ZXh0IG5vZGUgYmV0d2VlbiBcIjFcIiBhbmQgXCItMVwiLlxuZnVuY3Rpb24gbWFrZVJlcXVlc3RDYWxsRnJvbU11dGF0aW9uT2JzZXJ2ZXIoY2FsbGJhY2spIHtcbiAgICB2YXIgdG9nZ2xlID0gMTtcbiAgICB2YXIgb2JzZXJ2ZXIgPSBuZXcgQnJvd3Nlck11dGF0aW9uT2JzZXJ2ZXIoY2FsbGJhY2spO1xuICAgIHZhciBub2RlID0gZG9jdW1lbnQuY3JlYXRlVGV4dE5vZGUoXCJcIik7XG4gICAgb2JzZXJ2ZXIub2JzZXJ2ZShub2RlLCB7Y2hhcmFjdGVyRGF0YTogdHJ1ZX0pO1xuICAgIHJldHVybiBmdW5jdGlvbiByZXF1ZXN0Q2FsbCgpIHtcbiAgICAgICAgdG9nZ2xlID0gLXRvZ2dsZTtcbiAgICAgICAgbm9kZS5kYXRhID0gdG9nZ2xlO1xuICAgIH07XG59XG5cbi8vIFRoZSBtZXNzYWdlIGNoYW5uZWwgdGVjaG5pcXVlIHdhcyBkaXNjb3ZlcmVkIGJ5IE1hbHRlIFVibCBhbmQgd2FzIHRoZVxuLy8gb3JpZ2luYWwgZm91bmRhdGlvbiBmb3IgdGhpcyBsaWJyYXJ5LlxuLy8gaHR0cDovL3d3dy5ub25ibG9ja2luZy5pby8yMDExLzA2L3dpbmRvd25leHR0aWNrLmh0bWxcblxuLy8gU2FmYXJpIDYuMC41IChhdCBsZWFzdCkgaW50ZXJtaXR0ZW50bHkgZmFpbHMgdG8gY3JlYXRlIG1lc3NhZ2UgcG9ydHMgb24gYVxuLy8gcGFnZSdzIGZpcnN0IGxvYWQuIFRoYW5rZnVsbHksIHRoaXMgdmVyc2lvbiBvZiBTYWZhcmkgc3VwcG9ydHNcbi8vIE11dGF0aW9uT2JzZXJ2ZXJzLCBzbyB3ZSBkb24ndCBuZWVkIHRvIGZhbGwgYmFjayBpbiB0aGF0IGNhc2UuXG5cbi8vIGZ1bmN0aW9uIG1ha2VSZXF1ZXN0Q2FsbEZyb21NZXNzYWdlQ2hhbm5lbChjYWxsYmFjaykge1xuLy8gICAgIHZhciBjaGFubmVsID0gbmV3IE1lc3NhZ2VDaGFubmVsKCk7XG4vLyAgICAgY2hhbm5lbC5wb3J0MS5vbm1lc3NhZ2UgPSBjYWxsYmFjaztcbi8vICAgICByZXR1cm4gZnVuY3Rpb24gcmVxdWVzdENhbGwoKSB7XG4vLyAgICAgICAgIGNoYW5uZWwucG9ydDIucG9zdE1lc3NhZ2UoMCk7XG4vLyAgICAgfTtcbi8vIH1cblxuLy8gRm9yIHJlYXNvbnMgZXhwbGFpbmVkIGFib3ZlLCB3ZSBhcmUgYWxzbyB1bmFibGUgdG8gdXNlIGBzZXRJbW1lZGlhdGVgXG4vLyB1bmRlciBhbnkgY2lyY3Vtc3RhbmNlcy5cbi8vIEV2ZW4gaWYgd2Ugd2VyZSwgdGhlcmUgaXMgYW5vdGhlciBidWcgaW4gSW50ZXJuZXQgRXhwbG9yZXIgMTAuXG4vLyBJdCBpcyBub3Qgc3VmZmljaWVudCB0byBhc3NpZ24gYHNldEltbWVkaWF0ZWAgdG8gYHJlcXVlc3RGbHVzaGAgYmVjYXVzZVxuLy8gYHNldEltbWVkaWF0ZWAgbXVzdCBiZSBjYWxsZWQgKmJ5IG5hbWUqIGFuZCB0aGVyZWZvcmUgbXVzdCBiZSB3cmFwcGVkIGluIGFcbi8vIGNsb3N1cmUuXG4vLyBOZXZlciBmb3JnZXQuXG5cbi8vIGZ1bmN0aW9uIG1ha2VSZXF1ZXN0Q2FsbEZyb21TZXRJbW1lZGlhdGUoY2FsbGJhY2spIHtcbi8vICAgICByZXR1cm4gZnVuY3Rpb24gcmVxdWVzdENhbGwoKSB7XG4vLyAgICAgICAgIHNldEltbWVkaWF0ZShjYWxsYmFjayk7XG4vLyAgICAgfTtcbi8vIH1cblxuLy8gU2FmYXJpIDYuMCBoYXMgYSBwcm9ibGVtIHdoZXJlIHRpbWVycyB3aWxsIGdldCBsb3N0IHdoaWxlIHRoZSB1c2VyIGlzXG4vLyBzY3JvbGxpbmcuIFRoaXMgcHJvYmxlbSBkb2VzIG5vdCBpbXBhY3QgQVNBUCBiZWNhdXNlIFNhZmFyaSA2LjAgc3VwcG9ydHNcbi8vIG11dGF0aW9uIG9ic2VydmVycywgc28gdGhhdCBpbXBsZW1lbnRhdGlvbiBpcyB1c2VkIGluc3RlYWQuXG4vLyBIb3dldmVyLCBpZiB3ZSBldmVyIGVsZWN0IHRvIHVzZSB0aW1lcnMgaW4gU2FmYXJpLCB0aGUgcHJldmFsZW50IHdvcmstYXJvdW5kXG4vLyBpcyB0byBhZGQgYSBzY3JvbGwgZXZlbnQgbGlzdGVuZXIgdGhhdCBjYWxscyBmb3IgYSBmbHVzaC5cblxuLy8gYHNldFRpbWVvdXRgIGRvZXMgbm90IGNhbGwgdGhlIHBhc3NlZCBjYWxsYmFjayBpZiB0aGUgZGVsYXkgaXMgbGVzcyB0aGFuXG4vLyBhcHByb3hpbWF0ZWx5IDcgaW4gd2ViIHdvcmtlcnMgaW4gRmlyZWZveCA4IHRocm91Z2ggMTgsIGFuZCBzb21ldGltZXMgbm90XG4vLyBldmVuIHRoZW4uXG5cbmZ1bmN0aW9uIG1ha2VSZXF1ZXN0Q2FsbEZyb21UaW1lcihjYWxsYmFjaykge1xuICAgIHJldHVybiBmdW5jdGlvbiByZXF1ZXN0Q2FsbCgpIHtcbiAgICAgICAgLy8gV2UgZGlzcGF0Y2ggYSB0aW1lb3V0IHdpdGggYSBzcGVjaWZpZWQgZGVsYXkgb2YgMCBmb3IgZW5naW5lcyB0aGF0XG4gICAgICAgIC8vIGNhbiByZWxpYWJseSBhY2NvbW1vZGF0ZSB0aGF0IHJlcXVlc3QuIFRoaXMgd2lsbCB1c3VhbGx5IGJlIHNuYXBwZWRcbiAgICAgICAgLy8gdG8gYSA0IG1pbGlzZWNvbmQgZGVsYXksIGJ1dCBvbmNlIHdlJ3JlIGZsdXNoaW5nLCB0aGVyZSdzIG5vIGRlbGF5XG4gICAgICAgIC8vIGJldHdlZW4gZXZlbnRzLlxuICAgICAgICB2YXIgdGltZW91dEhhbmRsZSA9IHNldFRpbWVvdXQoaGFuZGxlVGltZXIsIDApO1xuICAgICAgICAvLyBIb3dldmVyLCBzaW5jZSB0aGlzIHRpbWVyIGdldHMgZnJlcXVlbnRseSBkcm9wcGVkIGluIEZpcmVmb3hcbiAgICAgICAgLy8gd29ya2Vycywgd2UgZW5saXN0IGFuIGludGVydmFsIGhhbmRsZSB0aGF0IHdpbGwgdHJ5IHRvIGZpcmVcbiAgICAgICAgLy8gYW4gZXZlbnQgMjAgdGltZXMgcGVyIHNlY29uZCB1bnRpbCBpdCBzdWNjZWVkcy5cbiAgICAgICAgdmFyIGludGVydmFsSGFuZGxlID0gc2V0SW50ZXJ2YWwoaGFuZGxlVGltZXIsIDUwKTtcblxuICAgICAgICBmdW5jdGlvbiBoYW5kbGVUaW1lcigpIHtcbiAgICAgICAgICAgIC8vIFdoaWNoZXZlciB0aW1lciBzdWNjZWVkcyB3aWxsIGNhbmNlbCBib3RoIHRpbWVycyBhbmRcbiAgICAgICAgICAgIC8vIGV4ZWN1dGUgdGhlIGNhbGxiYWNrLlxuICAgICAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVvdXRIYW5kbGUpO1xuICAgICAgICAgICAgY2xlYXJJbnRlcnZhbChpbnRlcnZhbEhhbmRsZSk7XG4gICAgICAgICAgICBjYWxsYmFjaygpO1xuICAgICAgICB9XG4gICAgfTtcbn1cblxuLy8gVGhpcyBpcyBmb3IgYGFzYXAuanNgIG9ubHkuXG4vLyBJdHMgbmFtZSB3aWxsIGJlIHBlcmlvZGljYWxseSByYW5kb21pemVkIHRvIGJyZWFrIGFueSBjb2RlIHRoYXQgZGVwZW5kcyBvblxuLy8gaXRzIGV4aXN0ZW5jZS5cbnJhd0FzYXAubWFrZVJlcXVlc3RDYWxsRnJvbVRpbWVyID0gbWFrZVJlcXVlc3RDYWxsRnJvbVRpbWVyO1xuXG4vLyBBU0FQIHdhcyBvcmlnaW5hbGx5IGEgbmV4dFRpY2sgc2hpbSBpbmNsdWRlZCBpbiBRLiBUaGlzIHdhcyBmYWN0b3JlZCBvdXRcbi8vIGludG8gdGhpcyBBU0FQIHBhY2thZ2UuIEl0IHdhcyBsYXRlciBhZGFwdGVkIHRvIFJTVlAgd2hpY2ggbWFkZSBmdXJ0aGVyXG4vLyBhbWVuZG1lbnRzLiBUaGVzZSBkZWNpc2lvbnMsIHBhcnRpY3VsYXJseSB0byBtYXJnaW5hbGl6ZSBNZXNzYWdlQ2hhbm5lbCBhbmRcbi8vIHRvIGNhcHR1cmUgdGhlIE11dGF0aW9uT2JzZXJ2ZXIgaW1wbGVtZW50YXRpb24gaW4gYSBjbG9zdXJlLCB3ZXJlIGludGVncmF0ZWRcbi8vIGJhY2sgaW50byBBU0FQIHByb3Blci5cbi8vIGh0dHBzOi8vZ2l0aHViLmNvbS90aWxkZWlvL3JzdnAuanMvYmxvYi9jZGRmNzIzMjU0NmE5Y2Y4NTg1MjRiNzVjZGU2ZjllZGY3MjYyMGE3L2xpYi9yc3ZwL2FzYXAuanNcbiIsIid1c2Ugc3RyaWN0JztcblxudmFyIGN1cnJ5TiA9IHJlcXVpcmUoJ3JhbWRhL3NyYy9jdXJyeU4nKTtcblxuLy8gVXRpbGl0eVxuZnVuY3Rpb24gaXNGdW5jdGlvbihvYmopIHtcbiAgcmV0dXJuICEhKG9iaiAmJiBvYmouY29uc3RydWN0b3IgJiYgb2JqLmNhbGwgJiYgb2JqLmFwcGx5KTtcbn1cbmZ1bmN0aW9uIHRydWVGbigpIHsgcmV0dXJuIHRydWU7IH1cblxuLy8gR2xvYmFsc1xudmFyIHRvVXBkYXRlID0gW107XG52YXIgaW5TdHJlYW07XG52YXIgb3JkZXIgPSBbXTtcbnZhciBvcmRlck5leHRJZHggPSAtMTtcbnZhciBmbHVzaGluZyA9IGZhbHNlO1xuXG4vKiogQG5hbWVzcGFjZSAqL1xudmFyIGZseWQgPSB7fVxuXG4vLyAvLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8gQVBJIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLyAvL1xuXG4vKipcbiAqIENyZWF0ZXMgYSBuZXcgc3RyZWFtXG4gKlxuICogX19TaWduYXR1cmVfXzogYGEgLT4gU3RyZWFtIGFgXG4gKlxuICogQG5hbWUgZmx5ZC5zdHJlYW1cbiAqIEBwYXJhbSB7Kn0gaW5pdGlhbFZhbHVlIC0gKE9wdGlvbmFsKSB0aGUgaW5pdGlhbCB2YWx1ZSBvZiB0aGUgc3RyZWFtXG4gKiBAcmV0dXJuIHtzdHJlYW19IHRoZSBzdHJlYW1cbiAqXG4gKiBAZXhhbXBsZVxuICogdmFyIG4gPSBmbHlkLnN0cmVhbSgxKTsgLy8gU3RyZWFtIHdpdGggaW5pdGlhbCB2YWx1ZSBgMWBcbiAqIHZhciBzID0gZmx5ZC5zdHJlYW0oKTsgLy8gU3RyZWFtIHdpdGggbm8gaW5pdGlhbCB2YWx1ZVxuICovXG5mbHlkLnN0cmVhbSA9IGZ1bmN0aW9uKGluaXRpYWxWYWx1ZSkge1xuICB2YXIgZW5kU3RyZWFtID0gY3JlYXRlRGVwZW5kZW50U3RyZWFtKFtdLCB0cnVlRm4pO1xuICB2YXIgcyA9IGNyZWF0ZVN0cmVhbSgpO1xuICBzLmVuZCA9IGVuZFN0cmVhbTtcbiAgcy5mbkFyZ3MgPSBbXTtcbiAgZW5kU3RyZWFtLmxpc3RlbmVycy5wdXNoKHMpO1xuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA+IDApIHMoaW5pdGlhbFZhbHVlKTtcbiAgcmV0dXJuIHM7XG59XG5cbi8qKlxuICogQ3JlYXRlIGEgbmV3IGRlcGVuZGVudCBzdHJlYW1cbiAqXG4gKiBfX1NpZ25hdHVyZV9fOiBgKC4uLlN0cmVhbSAqIC0+IFN0cmVhbSBiIC0+IGIpIC0+IFtTdHJlYW0gKl0gLT4gU3RyZWFtIGJgXG4gKlxuICogQG5hbWUgZmx5ZC5jb21iaW5lXG4gKiBAcGFyYW0ge0Z1bmN0aW9ufSBmbiAtIHRoZSBmdW5jdGlvbiB1c2VkIHRvIGNvbWJpbmUgdGhlIHN0cmVhbXNcbiAqIEBwYXJhbSB7QXJyYXk8c3RyZWFtPn0gZGVwZW5kZW5jaWVzIC0gdGhlIHN0cmVhbXMgdGhhdCB0aGlzIG9uZSBkZXBlbmRzIG9uXG4gKiBAcmV0dXJuIHtzdHJlYW19IHRoZSBkZXBlbmRlbnQgc3RyZWFtXG4gKlxuICogQGV4YW1wbGVcbiAqIHZhciBuMSA9IGZseWQuc3RyZWFtKDApO1xuICogdmFyIG4yID0gZmx5ZC5zdHJlYW0oMCk7XG4gKiB2YXIgbWF4ID0gZmx5ZC5jb21iaW5lKGZ1bmN0aW9uKG4xLCBuMiwgc2VsZiwgY2hhbmdlZCkge1xuICogICByZXR1cm4gbjEoKSA+IG4yKCkgPyBuMSgpIDogbjIoKTtcbiAqIH0sIFtuMSwgbjJdKTtcbiAqL1xuZmx5ZC5jb21iaW5lID0gY3VycnlOKDIsIGNvbWJpbmUpO1xuZnVuY3Rpb24gY29tYmluZShmbiwgc3RyZWFtcykge1xuICB2YXIgaSwgcywgZGVwcywgZGVwRW5kU3RyZWFtcztcbiAgdmFyIGVuZFN0cmVhbSA9IGNyZWF0ZURlcGVuZGVudFN0cmVhbShbXSwgdHJ1ZUZuKTtcbiAgZGVwcyA9IFtdOyBkZXBFbmRTdHJlYW1zID0gW107XG4gIGZvciAoaSA9IDA7IGkgPCBzdHJlYW1zLmxlbmd0aDsgKytpKSB7XG4gICAgaWYgKHN0cmVhbXNbaV0gIT09IHVuZGVmaW5lZCkge1xuICAgICAgZGVwcy5wdXNoKHN0cmVhbXNbaV0pO1xuICAgICAgaWYgKHN0cmVhbXNbaV0uZW5kICE9PSB1bmRlZmluZWQpIGRlcEVuZFN0cmVhbXMucHVzaChzdHJlYW1zW2ldLmVuZCk7XG4gICAgfVxuICB9XG4gIHMgPSBjcmVhdGVEZXBlbmRlbnRTdHJlYW0oZGVwcywgZm4pO1xuICBzLmRlcHNDaGFuZ2VkID0gW107XG4gIHMuZm5BcmdzID0gcy5kZXBzLmNvbmNhdChbcywgcy5kZXBzQ2hhbmdlZF0pO1xuICBzLmVuZCA9IGVuZFN0cmVhbTtcbiAgZW5kU3RyZWFtLmxpc3RlbmVycy5wdXNoKHMpO1xuICBhZGRMaXN0ZW5lcnMoZGVwRW5kU3RyZWFtcywgZW5kU3RyZWFtKTtcbiAgZW5kU3RyZWFtLmRlcHMgPSBkZXBFbmRTdHJlYW1zO1xuICB1cGRhdGVTdHJlYW0ocyk7XG4gIHJldHVybiBzO1xufVxuXG4vKipcbiAqIFJldHVybnMgYHRydWVgIGlmIHRoZSBzdXBwbGllZCBhcmd1bWVudCBpcyBhIEZseWQgc3RyZWFtIGFuZCBgZmFsc2VgIG90aGVyd2lzZS5cbiAqXG4gKiBfX1NpZ25hdHVyZV9fOiBgKiAtPiBCb29sZWFuYFxuICpcbiAqIEBuYW1lIGZseWQuaXNTdHJlYW1cbiAqIEBwYXJhbSB7Kn0gdmFsdWUgLSB0aGUgdmFsdWUgdG8gdGVzdFxuICogQHJldHVybiB7Qm9vbGVhbn0gYHRydWVgIGlmIGlzIGEgRmx5ZCBzdHJlYW1uLCBgZmFsc2VgIG90aGVyd2lzZVxuICpcbiAqIEBleGFtcGxlXG4gKiB2YXIgcyA9IGZseWQuc3RyZWFtKDEpO1xuICogdmFyIG4gPSAxO1xuICogZmx5ZC5pc1N0cmVhbShzKTsgLy89PiB0cnVlXG4gKiBmbHlkLmlzU3RyZWFtKG4pOyAvLz0+IGZhbHNlXG4gKi9cbmZseWQuaXNTdHJlYW0gPSBmdW5jdGlvbihzdHJlYW0pIHtcbiAgcmV0dXJuIGlzRnVuY3Rpb24oc3RyZWFtKSAmJiAnaGFzVmFsJyBpbiBzdHJlYW07XG59XG5cbi8qKlxuICogSW52b2tlcyB0aGUgYm9keSAodGhlIGZ1bmN0aW9uIHRvIGNhbGN1bGF0ZSB0aGUgdmFsdWUpIG9mIGEgZGVwZW5kZW50IHN0cmVhbVxuICpcbiAqIEJ5IGRlZmF1bHQgdGhlIGJvZHkgb2YgYSBkZXBlbmRlbnQgc3RyZWFtIGlzIG9ubHkgY2FsbGVkIHdoZW4gYWxsIHRoZSBzdHJlYW1zXG4gKiB1cG9uIHdoaWNoIGl0IGRlcGVuZHMgaGFzIGEgdmFsdWUuIGBpbW1lZGlhdGVgIGNhbiBjaXJjdW12ZW50IHRoaXMgYmVoYXZpb3VyLlxuICogSXQgaW1tZWRpYXRlbHkgaW52b2tlcyB0aGUgYm9keSBvZiBhIGRlcGVuZGVudCBzdHJlYW0uXG4gKlxuICogX19TaWduYXR1cmVfXzogYFN0cmVhbSBhIC0+IFN0cmVhbSBhYFxuICpcbiAqIEBuYW1lIGZseWQuaW1tZWRpYXRlXG4gKiBAcGFyYW0ge3N0cmVhbX0gc3RyZWFtIC0gdGhlIGRlcGVuZGVudCBzdHJlYW1cbiAqIEByZXR1cm4ge3N0cmVhbX0gdGhlIHNhbWUgc3RyZWFtXG4gKlxuICogQGV4YW1wbGVcbiAqIHZhciBzID0gZmx5ZC5zdHJlYW0oKTtcbiAqIHZhciBoYXNJdGVtcyA9IGZseWQuaW1tZWRpYXRlKGZseWQuY29tYmluZShmdW5jdGlvbihzKSB7XG4gKiAgIHJldHVybiBzKCkgIT09IHVuZGVmaW5lZCAmJiBzKCkubGVuZ3RoID4gMDtcbiAqIH0sIFtzXSk7XG4gKiBjb25zb2xlLmxvZyhoYXNJdGVtcygpKTsgLy8gbG9ncyBgZmFsc2VgLiBIYWQgYGltbWVkaWF0ZWAgbm90IGJlZW5cbiAqICAgICAgICAgICAgICAgICAgICAgICAgICAvLyB1c2VkIGBoYXNJdGVtcygpYCB3b3VsZCd2ZSByZXR1cm5lZCBgdW5kZWZpbmVkYFxuICogcyhbMV0pO1xuICogY29uc29sZS5sb2coaGFzSXRlbXMoKSk7IC8vIGxvZ3MgYHRydWVgLlxuICogcyhbXSk7XG4gKiBjb25zb2xlLmxvZyhoYXNJdGVtcygpKTsgLy8gbG9ncyBgZmFsc2VgLlxuICovXG5mbHlkLmltbWVkaWF0ZSA9IGZ1bmN0aW9uKHMpIHtcbiAgaWYgKHMuZGVwc01ldCA9PT0gZmFsc2UpIHtcbiAgICBzLmRlcHNNZXQgPSB0cnVlO1xuICAgIHVwZGF0ZVN0cmVhbShzKTtcbiAgfVxuICByZXR1cm4gcztcbn1cblxuLyoqXG4gKiBDaGFuZ2VzIHdoaWNoIGBlbmRzU3RyZWFtYCBzaG91bGQgdHJpZ2dlciB0aGUgZW5kaW5nIG9mIGBzYC5cbiAqXG4gKiBfX1NpZ25hdHVyZV9fOiBgU3RyZWFtIGEgLT4gU3RyZWFtIGIgLT4gU3RyZWFtIGJgXG4gKlxuICogQG5hbWUgZmx5ZC5lbmRzT25cbiAqIEBwYXJhbSB7c3RyZWFtfSBlbmRTdHJlYW0gLSB0aGUgc3RyZWFtIHRvIHRyaWdnZXIgdGhlIGVuZGluZ1xuICogQHBhcmFtIHtzdHJlYW19IHN0cmVhbSAtIHRoZSBzdHJlYW0gdG8gYmUgZW5kZWQgYnkgdGhlIGVuZFN0cmVhbVxuICogQHBhcmFtIHtzdHJlYW19IHRoZSBzdHJlYW0gbW9kaWZpZWQgdG8gYmUgZW5kZWQgYnkgZW5kU3RyZWFtXG4gKlxuICogQGV4YW1wbGVcbiAqIHZhciBuID0gZmx5ZC5zdHJlYW0oMSk7XG4gKiB2YXIga2lsbGVyID0gZmx5ZC5zdHJlYW0oKTtcbiAqIC8vIGBkb3VibGVgIGVuZHMgd2hlbiBgbmAgZW5kcyBvciB3aGVuIGBraWxsZXJgIGVtaXRzIGFueSB2YWx1ZVxuICogdmFyIGRvdWJsZSA9IGZseWQuZW5kc09uKGZseWQubWVyZ2Uobi5lbmQsIGtpbGxlciksIGZseWQuY29tYmluZShmdW5jdGlvbihuKSB7XG4gKiAgIHJldHVybiAyICogbigpO1xuICogfSwgW25dKTtcbiovXG5mbHlkLmVuZHNPbiA9IGZ1bmN0aW9uKGVuZFMsIHMpIHtcbiAgZGV0YWNoRGVwcyhzLmVuZCk7XG4gIGVuZFMubGlzdGVuZXJzLnB1c2gocy5lbmQpO1xuICBzLmVuZC5kZXBzLnB1c2goZW5kUyk7XG4gIHJldHVybiBzO1xufVxuXG4vKipcbiAqIE1hcCBhIHN0cmVhbVxuICpcbiAqIFJldHVybnMgYSBuZXcgc3RyZWFtIGNvbnNpc3Rpbmcgb2YgZXZlcnkgdmFsdWUgZnJvbSBgc2AgcGFzc2VkIHRocm91Z2hcbiAqIGBmbmAuIEkuZS4gYG1hcGAgY3JlYXRlcyBhIG5ldyBzdHJlYW0gdGhhdCBsaXN0ZW5zIHRvIGBzYCBhbmRcbiAqIGFwcGxpZXMgYGZuYCB0byBldmVyeSBuZXcgdmFsdWUuXG4gKiBfX1NpZ25hdHVyZV9fOiBgKGEgLT4gcmVzdWx0KSAtPiBTdHJlYW0gYSAtPiBTdHJlYW0gcmVzdWx0YFxuICpcbiAqIEBuYW1lIGZseWQubWFwXG4gKiBAcGFyYW0ge0Z1bmN0aW9ufSBmbiAtIHRoZSBmdW5jdGlvbiB0aGF0IHByb2R1Y2VzIHRoZSBlbGVtZW50cyBvZiB0aGUgbmV3IHN0cmVhbVxuICogQHBhcmFtIHtzdHJlYW19IHN0cmVhbSAtIHRoZSBzdHJlYW0gdG8gbWFwXG4gKiBAcmV0dXJuIHtzdHJlYW19IGEgbmV3IHN0cmVhbSB3aXRoIHRoZSBtYXBwZWQgdmFsdWVzXG4gKlxuICogQGV4YW1wbGVcbiAqIHZhciBudW1iZXJzID0gZmx5ZC5zdHJlYW0oMCk7XG4gKiB2YXIgc3F1YXJlZE51bWJlcnMgPSBmbHlkLm1hcChmdW5jdGlvbihuKSB7IHJldHVybiBuKm47IH0sIG51bWJlcnMpO1xuICovXG4vLyBMaWJyYXJ5IGZ1bmN0aW9ucyB1c2Ugc2VsZiBjYWxsYmFjayB0byBhY2NlcHQgKG51bGwsIHVuZGVmaW5lZCkgdXBkYXRlIHRyaWdnZXJzLlxuZmx5ZC5tYXAgPSBjdXJyeU4oMiwgZnVuY3Rpb24oZiwgcykge1xuICByZXR1cm4gY29tYmluZShmdW5jdGlvbihzLCBzZWxmKSB7IHNlbGYoZihzLnZhbCkpOyB9LCBbc10pO1xufSlcblxuLyoqXG4gKiBMaXN0ZW4gdG8gc3RyZWFtIGV2ZW50c1xuICpcbiAqIFNpbWlsYXIgdG8gYG1hcGAgZXhjZXB0IHRoYXQgdGhlIHJldHVybmVkIHN0cmVhbSBpcyBlbXB0eS4gVXNlIGBvbmAgZm9yIGRvaW5nXG4gKiBzaWRlIGVmZmVjdHMgaW4gcmVhY3Rpb24gdG8gc3RyZWFtIGNoYW5nZXMuIFVzZSB0aGUgcmV0dXJuZWQgc3RyZWFtIG9ubHkgaWYgeW91XG4gKiBuZWVkIHRvIG1hbnVhbGx5IGVuZCBpdC5cbiAqXG4gKiBfX1NpZ25hdHVyZV9fOiBgKGEgLT4gcmVzdWx0KSAtPiBTdHJlYW0gYSAtPiBTdHJlYW0gdW5kZWZpbmVkYFxuICpcbiAqIEBuYW1lIGZseWQub25cbiAqIEBwYXJhbSB7RnVuY3Rpb259IGNiIC0gdGhlIGNhbGxiYWNrXG4gKiBAcGFyYW0ge3N0cmVhbX0gc3RyZWFtIC0gdGhlIHN0cmVhbVxuICogQHJldHVybiB7c3RyZWFtfSBhbiBlbXB0eSBzdHJlYW0gKGNhbiBiZSBlbmRlZClcbiAqL1xuZmx5ZC5vbiA9IGN1cnJ5TigyLCBmdW5jdGlvbihmLCBzKSB7XG4gIHJldHVybiBjb21iaW5lKGZ1bmN0aW9uKHMpIHsgZihzLnZhbCk7IH0sIFtzXSk7XG59KVxuXG4vKipcbiAqIENyZWF0ZXMgYSBuZXcgc3RyZWFtIHdpdGggdGhlIHJlc3VsdHMgb2YgY2FsbGluZyB0aGUgZnVuY3Rpb24gb24gZXZlcnkgaW5jb21pbmdcbiAqIHN0cmVhbSB3aXRoIGFuZCBhY2N1bXVsYXRvciBhbmQgdGhlIGluY29taW5nIHZhbHVlLlxuICpcbiAqIF9fU2lnbmF0dXJlX186IGAoYSAtPiBiIC0+IGEpIC0+IGEgLT4gU3RyZWFtIGIgLT4gU3RyZWFtIGFgXG4gKlxuICogQG5hbWUgZmx5ZC5zY2FuXG4gKiBAcGFyYW0ge0Z1bmN0aW9ufSBmbiAtIHRoZSBmdW5jdGlvbiB0byBjYWxsXG4gKiBAcGFyYW0geyp9IHZhbCAtIHRoZSBpbml0aWFsIHZhbHVlIG9mIHRoZSBhY2N1bXVsYXRvclxuICogQHBhcmFtIHtzdHJlYW19IHN0cmVhbSAtIHRoZSBzdHJlYW0gc291cmNlXG4gKiBAcmV0dXJuIHtzdHJlYW19IHRoZSBuZXcgc3RyZWFtXG4gKlxuICogQGV4YW1wbGVcbiAqIHZhciBudW1iZXJzID0gZmx5ZC5zdHJlYW0oKTtcbiAqIHZhciBzdW0gPSBmbHlkLnNjYW4oZnVuY3Rpb24oc3VtLCBuKSB7IHJldHVybiBzdW0rbjsgfSwgMCwgbnVtYmVycyk7XG4gKiBudW1iZXJzKDIpKDMpKDUpO1xuICogc3VtKCk7IC8vIDEwXG4gKi9cbmZseWQuc2NhbiA9IGN1cnJ5TigzLCBmdW5jdGlvbihmLCBhY2MsIHMpIHtcbiAgdmFyIG5zID0gY29tYmluZShmdW5jdGlvbihzLCBzZWxmKSB7XG4gICAgc2VsZihhY2MgPSBmKGFjYywgcy52YWwpKTtcbiAgfSwgW3NdKTtcbiAgaWYgKCFucy5oYXNWYWwpIG5zKGFjYyk7XG4gIHJldHVybiBucztcbn0pO1xuXG4vKipcbiAqIENyZWF0ZXMgYSBuZXcgc3RyZWFtIGRvd24gd2hpY2ggYWxsIHZhbHVlcyBmcm9tIGJvdGggYHN0cmVhbTFgIGFuZCBgc3RyZWFtMmBcbiAqIHdpbGwgYmUgc2VudC5cbiAqXG4gKiBfX1NpZ25hdHVyZV9fOiBgU3RyZWFtIGEgLT4gU3RyZWFtIGEgLT4gU3RyZWFtIGFgXG4gKlxuICogQG5hbWUgZmx5ZC5tZXJnZVxuICogQHBhcmFtIHtzdHJlYW19IHNvdXJjZTEgLSBvbmUgc3RyZWFtIHRvIGJlIG1lcmdlZFxuICogQHBhcmFtIHtzdHJlYW19IHNvdXJjZTIgLSB0aGUgb3RoZXIgc3RyZWFtIHRvIGJlIG1lcmdlZFxuICogQHJldHVybiB7c3RyZWFtfSBhIHN0cmVhbSB3aXRoIHRoZSB2YWx1ZXMgZnJvbSBib3RoIHNvdXJjZXNcbiAqXG4gKiBAZXhhbXBsZVxuICogdmFyIGJ0bjFDbGlja3MgPSBmbHlkLnN0cmVhbSgpO1xuICogYnV0dG9uMUVsbS5hZGRFdmVudExpc3RlbmVyKGJ0bjFDbGlja3MpO1xuICogdmFyIGJ0bjJDbGlja3MgPSBmbHlkLnN0cmVhbSgpO1xuICogYnV0dG9uMkVsbS5hZGRFdmVudExpc3RlbmVyKGJ0bjJDbGlja3MpO1xuICogdmFyIGFsbENsaWNrcyA9IGZseWQubWVyZ2UoYnRuMUNsaWNrcywgYnRuMkNsaWNrcyk7XG4gKi9cbmZseWQubWVyZ2UgPSBjdXJyeU4oMiwgZnVuY3Rpb24oczEsIHMyKSB7XG4gIHZhciBzID0gZmx5ZC5pbW1lZGlhdGUoY29tYmluZShmdW5jdGlvbihzMSwgczIsIHNlbGYsIGNoYW5nZWQpIHtcbiAgICBpZiAoY2hhbmdlZFswXSkge1xuICAgICAgc2VsZihjaGFuZ2VkWzBdKCkpO1xuICAgIH0gZWxzZSBpZiAoczEuaGFzVmFsKSB7XG4gICAgICBzZWxmKHMxLnZhbCk7XG4gICAgfSBlbHNlIGlmIChzMi5oYXNWYWwpIHtcbiAgICAgIHNlbGYoczIudmFsKTtcbiAgICB9XG4gIH0sIFtzMSwgczJdKSk7XG4gIGZseWQuZW5kc09uKGNvbWJpbmUoZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0sIFtzMS5lbmQsIHMyLmVuZF0pLCBzKTtcbiAgcmV0dXJuIHM7XG59KTtcblxuLyoqXG4gKiBDcmVhdGVzIGEgbmV3IHN0cmVhbSByZXN1bHRpbmcgZnJvbSBhcHBseWluZyBgdHJhbnNkdWNlcmAgdG8gYHN0cmVhbWAuXG4gKlxuICogX19TaWduYXR1cmVfXzogYFRyYW5zZHVjZXIgLT4gU3RyZWFtIGEgLT4gU3RyZWFtIGJgXG4gKlxuICogQG5hbWUgZmx5ZC50cmFuc2R1Y2VcbiAqIEBwYXJhbSB7VHJhbnNkdWNlcn0geGZvcm0gLSB0aGUgdHJhbnNkdWNlciB0cmFuc2Zvcm1hdGlvblxuICogQHBhcmFtIHtzdHJlYW19IHNvdXJjZSAtIHRoZSBzdHJlYW0gc291cmNlXG4gKiBAcmV0dXJuIHtzdHJlYW19IHRoZSBuZXcgc3RyZWFtXG4gKlxuICogQGV4YW1wbGVcbiAqIHZhciB0ID0gcmVxdWlyZSgndHJhbnNkdWNlcnMuanMnKTtcbiAqXG4gKiB2YXIgcmVzdWx0cyA9IFtdO1xuICogdmFyIHMxID0gZmx5ZC5zdHJlYW0oKTtcbiAqIHZhciB0eCA9IHQuY29tcG9zZSh0Lm1hcChmdW5jdGlvbih4KSB7IHJldHVybiB4ICogMjsgfSksIHQuZGVkdXBlKCkpO1xuICogdmFyIHMyID0gZmx5ZC50cmFuc2R1Y2UodHgsIHMxKTtcbiAqIGZseWQuY29tYmluZShmdW5jdGlvbihzMikgeyByZXN1bHRzLnB1c2goczIoKSk7IH0sIFtzMl0pO1xuICogczEoMSkoMSkoMikoMykoMykoMykoNCk7XG4gKiByZXN1bHRzOyAvLyA9PiBbMiwgNCwgNiwgOF1cbiAqL1xuZmx5ZC50cmFuc2R1Y2UgPSBjdXJyeU4oMiwgZnVuY3Rpb24oeGZvcm0sIHNvdXJjZSkge1xuICB4Zm9ybSA9IHhmb3JtKG5ldyBTdHJlYW1UcmFuc2Zvcm1lcigpKTtcbiAgcmV0dXJuIGNvbWJpbmUoZnVuY3Rpb24oc291cmNlLCBzZWxmKSB7XG4gICAgdmFyIHJlcyA9IHhmb3JtWydAQHRyYW5zZHVjZXIvc3RlcCddKHVuZGVmaW5lZCwgc291cmNlLnZhbCk7XG4gICAgaWYgKHJlcyAmJiByZXNbJ0BAdHJhbnNkdWNlci9yZWR1Y2VkJ10gPT09IHRydWUpIHtcbiAgICAgIHNlbGYuZW5kKHRydWUpO1xuICAgICAgcmV0dXJuIHJlc1snQEB0cmFuc2R1Y2VyL3ZhbHVlJ107XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiByZXM7XG4gICAgfVxuICB9LCBbc291cmNlXSk7XG59KTtcblxuLyoqXG4gKiBSZXR1cm5zIGBmbmAgY3VycmllZCB0byBgbmAuIFVzZSB0aGlzIGZ1bmN0aW9uIHRvIGN1cnJ5IGZ1bmN0aW9ucyBleHBvc2VkIGJ5XG4gKiBtb2R1bGVzIGZvciBGbHlkLlxuICpcbiAqIEBuYW1lIGZseWQuY3VycnlOXG4gKiBAZnVuY3Rpb25cbiAqIEBwYXJhbSB7SW50ZWdlcn0gYXJpdHkgLSB0aGUgZnVuY3Rpb24gYXJpdHlcbiAqIEBwYXJhbSB7RnVuY3Rpb259IGZuIC0gdGhlIGZ1bmN0aW9uIHRvIGN1cnJ5XG4gKiBAcmV0dXJuIHtGdW5jdGlvbn0gdGhlIGN1cnJpZWQgZnVuY3Rpb25cbiAqXG4gKiBAZXhhbXBsZVxuICogZnVuY3Rpb24gYWRkKHgsIHkpIHsgcmV0dXJuIHggKyB5OyB9O1xuICogdmFyIGEgPSBmbHlkLmN1cnJ5TigyLCBhZGQpO1xuICogYSgyKSg0KSAvLyA9PiA2XG4gKi9cbmZseWQuY3VycnlOID0gY3VycnlOXG5cbi8qKlxuICogUmV0dXJucyBhIG5ldyBzdHJlYW0gaWRlbnRpY2FsIHRvIHRoZSBvcmlnaW5hbCBleGNlcHQgZXZlcnlcbiAqIHZhbHVlIHdpbGwgYmUgcGFzc2VkIHRocm91Z2ggYGZgLlxuICpcbiAqIF9Ob3RlOl8gVGhpcyBmdW5jdGlvbiBpcyBpbmNsdWRlZCBpbiBvcmRlciB0byBzdXBwb3J0IHRoZSBmYW50YXN5IGxhbmRcbiAqIHNwZWNpZmljYXRpb24uXG4gKlxuICogX19TaWduYXR1cmVfXzogQ2FsbGVkIGJvdW5kIHRvIGBTdHJlYW0gYWA6IGAoYSAtPiBiKSAtPiBTdHJlYW0gYmBcbiAqXG4gKiBAbmFtZSBzdHJlYW0ubWFwXG4gKiBAcGFyYW0ge0Z1bmN0aW9ufSBmdW5jdGlvbiAtIHRoZSBmdW5jdGlvbiB0byBhcHBseVxuICogQHJldHVybiB7c3RyZWFtfSBhIG5ldyBzdHJlYW0gd2l0aCB0aGUgdmFsdWVzIG1hcHBlZFxuICpcbiAqIEBleGFtcGxlXG4gKiB2YXIgbnVtYmVycyA9IGZseWQuc3RyZWFtKDApO1xuICogdmFyIHNxdWFyZWROdW1iZXJzID0gbnVtYmVycy5tYXAoZnVuY3Rpb24obikgeyByZXR1cm4gbipuOyB9KTtcbiAqL1xuZnVuY3Rpb24gYm91bmRNYXAoZikgeyByZXR1cm4gZmx5ZC5tYXAoZiwgdGhpcyk7IH1cblxuLyoqXG4gKiBSZXR1cm5zIGEgbmV3IHN0cmVhbSB3aGljaCBpcyB0aGUgcmVzdWx0IG9mIGFwcGx5aW5nIHRoZVxuICogZnVuY3Rpb25zIGZyb20gYHRoaXNgIHN0cmVhbSB0byB0aGUgdmFsdWVzIGluIGBzdHJlYW1gIHBhcmFtZXRlci5cbiAqXG4gKiBgdGhpc2Agc3RyZWFtIG11c3QgYmUgYSBzdHJlYW0gb2YgZnVuY3Rpb25zLlxuICpcbiAqIF9Ob3RlOl8gVGhpcyBmdW5jdGlvbiBpcyBpbmNsdWRlZCBpbiBvcmRlciB0byBzdXBwb3J0IHRoZSBmYW50YXN5IGxhbmRcbiAqIHNwZWNpZmljYXRpb24uXG4gKlxuICogX19TaWduYXR1cmVfXzogQ2FsbGVkIGJvdW5kIHRvIGBTdHJlYW0gKGEgLT4gYilgOiBgYSAtPiBTdHJlYW0gYmBcbiAqXG4gKiBAbmFtZSBzdHJlYW0uYXBcbiAqIEBwYXJhbSB7c3RyZWFtfSBzdHJlYW0gLSB0aGUgdmFsdWVzIHN0cmVhbVxuICogQHJldHVybiB7c3RyZWFtfSBhIG5ldyBzdHJhbSB3aXRoIHRoZSBmdW5jdGlvbnMgYXBwbGllZCB0byB2YWx1ZXNcbiAqXG4gKiBAZXhhbXBsZVxuICogdmFyIGFkZCA9IGZseWQuY3VycnlOKDIsIGZ1bmN0aW9uKHgsIHkpIHsgcmV0dXJuIHggKyB5OyB9KTtcbiAqIHZhciBudW1iZXJzMSA9IGZseWQuc3RyZWFtKCk7XG4gKiB2YXIgbnVtYmVyczIgPSBmbHlkLnN0cmVhbSgpO1xuICogdmFyIGFkZFRvTnVtYmVyczEgPSBmbHlkLm1hcChhZGQsIG51bWJlcnMxKTtcbiAqIHZhciBhZGRlZCA9IGFkZFRvTnVtYmVyczEuYXAobnVtYmVyczIpO1xuICovXG5mdW5jdGlvbiBhcChzMikge1xuICB2YXIgczEgPSB0aGlzO1xuICByZXR1cm4gY29tYmluZShmdW5jdGlvbihzMSwgczIsIHNlbGYpIHsgc2VsZihzMS52YWwoczIudmFsKSk7IH0sIFtzMSwgczJdKTtcbn1cblxuLyoqXG4gKiBHZXQgYSBodW1hbiByZWFkYWJsZSB2aWV3IG9mIGEgc3RyZWFtXG4gKiBAbmFtZSBzdHJlYW0udG9TdHJpbmdcbiAqIEByZXR1cm4ge1N0cmluZ30gdGhlIHN0cmVhbSBzdHJpbmcgcmVwcmVzZW50YXRpb25cbiAqL1xuZnVuY3Rpb24gc3RyZWFtVG9TdHJpbmcoKSB7XG4gIHJldHVybiAnc3RyZWFtKCcgKyB0aGlzLnZhbCArICcpJztcbn1cblxuLyoqXG4gKiBAbmFtZSBzdHJlYW0uZW5kXG4gKiBAbWVtYmVyb2Ygc3RyZWFtXG4gKiBBIHN0cmVhbSB0aGF0IGVtaXRzIGB0cnVlYCB3aGVuIHRoZSBzdHJlYW0gZW5kcy4gSWYgYHRydWVgIGlzIHB1c2hlZCBkb3duIHRoZVxuICogc3RyZWFtIHRoZSBwYXJlbnQgc3RyZWFtIGVuZHMuXG4gKi9cblxuLyoqXG4gKiBAbmFtZSBzdHJlYW0ub2ZcbiAqIEBmdW5jdGlvblxuICogQG1lbWJlcm9mIHN0cmVhbVxuICogUmV0dXJucyBhIG5ldyBzdHJlYW0gd2l0aCBgdmFsdWVgIGFzIGl0cyBpbml0aWFsIHZhbHVlLiBJdCBpcyBpZGVudGljYWwgdG9cbiAqIGNhbGxpbmcgYGZseWQuc3RyZWFtYCB3aXRoIG9uZSBhcmd1bWVudC5cbiAqXG4gKiBfX1NpZ25hdHVyZV9fOiBDYWxsZWQgYm91bmQgdG8gYFN0cmVhbSAoYSlgOiBgYiAtPiBTdHJlYW0gYmBcbiAqXG4gKiBAcGFyYW0geyp9IHZhbHVlIC0gdGhlIGluaXRpYWwgdmFsdWVcbiAqIEByZXR1cm4ge3N0cmVhbX0gdGhlIG5ldyBzdHJlYW1cbiAqXG4gKiBAZXhhbXBsZVxuICogdmFyIG4gPSBmbHlkLnN0cmVhbSgxKTtcbiAqIHZhciBtID0gbi5vZigxKTtcbiAqL1xuXG4vLyAvLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8gUFJJVkFURSAvLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8gLy9cbi8qKlxuICogQHByaXZhdGVcbiAqIENyZWF0ZSBhIHN0cmVhbSB3aXRoIG5vIGRlcGVuZGVuY2llcyBhbmQgbm8gdmFsdWVcbiAqIEByZXR1cm4ge0Z1bmN0aW9ufSBhIGZseWQgc3RyZWFtXG4gKi9cbmZ1bmN0aW9uIGNyZWF0ZVN0cmVhbSgpIHtcbiAgZnVuY3Rpb24gcyhuKSB7XG4gICAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDApIHJldHVybiBzLnZhbFxuICAgIHVwZGF0ZVN0cmVhbVZhbHVlKHMsIG4pXG4gICAgcmV0dXJuIHNcbiAgfVxuICBzLmhhc1ZhbCA9IGZhbHNlO1xuICBzLnZhbCA9IHVuZGVmaW5lZDtcbiAgcy52YWxzID0gW107XG4gIHMubGlzdGVuZXJzID0gW107XG4gIHMucXVldWVkID0gZmFsc2U7XG4gIHMuZW5kID0gdW5kZWZpbmVkO1xuICBzLm1hcCA9IGJvdW5kTWFwO1xuICBzLmFwID0gYXA7XG4gIHMub2YgPSBmbHlkLnN0cmVhbTtcbiAgcy50b1N0cmluZyA9IHN0cmVhbVRvU3RyaW5nO1xuICByZXR1cm4gcztcbn1cblxuLyoqXG4gKiBAcHJpdmF0ZVxuICogQ3JlYXRlIGEgZGVwZW5kZW50IHN0cmVhbVxuICogQHBhcmFtIHtBcnJheTxzdHJlYW0+fSBkZXBlbmRlbmNpZXMgLSBhbiBhcnJheSBvZiB0aGUgc3RyZWFtc1xuICogQHBhcmFtIHtGdW5jdGlvbn0gZm4gLSB0aGUgZnVuY3Rpb24gdXNlZCB0byBjYWxjdWxhdGUgdGhlIG5ldyBzdHJlYW0gdmFsdWVcbiAqIGZyb20gdGhlIGRlcGVuZGVuY2llc1xuICogQHJldHVybiB7c3RyZWFtfSB0aGUgY3JlYXRlZCBzdHJlYW1cbiAqL1xuZnVuY3Rpb24gY3JlYXRlRGVwZW5kZW50U3RyZWFtKGRlcHMsIGZuKSB7XG4gIHZhciBzID0gY3JlYXRlU3RyZWFtKCk7XG4gIHMuZm4gPSBmbjtcbiAgcy5kZXBzID0gZGVwcztcbiAgcy5kZXBzTWV0ID0gZmFsc2U7XG4gIHMuZGVwc0NoYW5nZWQgPSBkZXBzLmxlbmd0aCA+IDAgPyBbXSA6IHVuZGVmaW5lZDtcbiAgcy5zaG91bGRVcGRhdGUgPSBmYWxzZTtcbiAgYWRkTGlzdGVuZXJzKGRlcHMsIHMpO1xuICByZXR1cm4gcztcbn1cblxuLyoqXG4gKiBAcHJpdmF0ZVxuICogQ2hlY2sgaWYgYWxsIHRoZSBkZXBlbmRlbmNpZXMgaGF2ZSB2YWx1ZXNcbiAqIEBwYXJhbSB7c3RyZWFtfSBzdHJlYW0gLSB0aGUgc3RyZWFtIHRvIGNoZWNrIGRlcGVuY2VuY2llcyBmcm9tXG4gKiBAcmV0dXJuIHtCb29sZWFufSBgdHJ1ZWAgaWYgYWxsIGRlcGVuZGVuY2llcyBoYXZlIHZhbGVzLCBgZmFsc2VgIG90aGVyd2lzZVxuICovXG5mdW5jdGlvbiBpbml0aWFsRGVwc05vdE1ldChzdHJlYW0pIHtcbiAgc3RyZWFtLmRlcHNNZXQgPSBzdHJlYW0uZGVwcy5ldmVyeShmdW5jdGlvbihzKSB7XG4gICAgcmV0dXJuIHMuaGFzVmFsO1xuICB9KTtcbiAgcmV0dXJuICFzdHJlYW0uZGVwc01ldDtcbn1cblxuLyoqXG4gKiBAcHJpdmF0ZVxuICogVXBkYXRlIGEgZGVwZW5kZW50IHN0cmVhbSB1c2luZyBpdHMgZGVwZW5kZW5jaWVzIGluIGFuIGF0b21pYyB3YXlcbiAqIEBwYXJhbSB7c3RyZWFtfSBzdHJlYW0gLSB0aGUgc3RyZWFtIHRvIHVwZGF0ZVxuICovXG5mdW5jdGlvbiB1cGRhdGVTdHJlYW0ocykge1xuICBpZiAoKHMuZGVwc01ldCAhPT0gdHJ1ZSAmJiBpbml0aWFsRGVwc05vdE1ldChzKSkgfHxcbiAgICAgIChzLmVuZCAhPT0gdW5kZWZpbmVkICYmIHMuZW5kLnZhbCA9PT0gdHJ1ZSkpIHJldHVybjtcbiAgaWYgKGluU3RyZWFtICE9PSB1bmRlZmluZWQpIHtcbiAgICB0b1VwZGF0ZS5wdXNoKHMpO1xuICAgIHJldHVybjtcbiAgfVxuICBpblN0cmVhbSA9IHM7XG4gIGlmIChzLmRlcHNDaGFuZ2VkKSBzLmZuQXJnc1tzLmZuQXJncy5sZW5ndGggLSAxXSA9IHMuZGVwc0NoYW5nZWQ7XG4gIHZhciByZXR1cm5WYWwgPSBzLmZuLmFwcGx5KHMuZm4sIHMuZm5BcmdzKTtcbiAgaWYgKHJldHVyblZhbCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcyhyZXR1cm5WYWwpO1xuICB9XG4gIGluU3RyZWFtID0gdW5kZWZpbmVkO1xuICBpZiAocy5kZXBzQ2hhbmdlZCAhPT0gdW5kZWZpbmVkKSBzLmRlcHNDaGFuZ2VkID0gW107XG4gIHMuc2hvdWxkVXBkYXRlID0gZmFsc2U7XG4gIGlmIChmbHVzaGluZyA9PT0gZmFsc2UpIGZsdXNoVXBkYXRlKCk7XG59XG5cbi8qKlxuICogQHByaXZhdGVcbiAqIFVwZGF0ZSB0aGUgZGVwZW5kZW5jaWVzIG9mIGEgc3RyZWFtXG4gKiBAcGFyYW0ge3N0cmVhbX0gc3RyZWFtXG4gKi9cbmZ1bmN0aW9uIHVwZGF0ZURlcHMocykge1xuICB2YXIgaSwgbywgbGlzdFxuICB2YXIgbGlzdGVuZXJzID0gcy5saXN0ZW5lcnM7XG4gIGZvciAoaSA9IDA7IGkgPCBsaXN0ZW5lcnMubGVuZ3RoOyArK2kpIHtcbiAgICBsaXN0ID0gbGlzdGVuZXJzW2ldO1xuICAgIGlmIChsaXN0LmVuZCA9PT0gcykge1xuICAgICAgZW5kU3RyZWFtKGxpc3QpO1xuICAgIH0gZWxzZSB7XG4gICAgICBpZiAobGlzdC5kZXBzQ2hhbmdlZCAhPT0gdW5kZWZpbmVkKSBsaXN0LmRlcHNDaGFuZ2VkLnB1c2gocyk7XG4gICAgICBsaXN0LnNob3VsZFVwZGF0ZSA9IHRydWU7XG4gICAgICBmaW5kRGVwcyhsaXN0KTtcbiAgICB9XG4gIH1cbiAgZm9yICg7IG9yZGVyTmV4dElkeCA+PSAwOyAtLW9yZGVyTmV4dElkeCkge1xuICAgIG8gPSBvcmRlcltvcmRlck5leHRJZHhdO1xuICAgIGlmIChvLnNob3VsZFVwZGF0ZSA9PT0gdHJ1ZSkgdXBkYXRlU3RyZWFtKG8pO1xuICAgIG8ucXVldWVkID0gZmFsc2U7XG4gIH1cbn1cblxuLyoqXG4gKiBAcHJpdmF0ZVxuICogQWRkIHN0cmVhbSBkZXBlbmRlbmNpZXMgdG8gdGhlIGdsb2JhbCBgb3JkZXJgIHF1ZXVlLlxuICogQHBhcmFtIHtzdHJlYW19IHN0cmVhbVxuICogQHNlZSB1cGRhdGVEZXBzXG4gKi9cbmZ1bmN0aW9uIGZpbmREZXBzKHMpIHtcbiAgdmFyIGlcbiAgdmFyIGxpc3RlbmVycyA9IHMubGlzdGVuZXJzO1xuICBpZiAocy5xdWV1ZWQgPT09IGZhbHNlKSB7XG4gICAgcy5xdWV1ZWQgPSB0cnVlO1xuICAgIGZvciAoaSA9IDA7IGkgPCBsaXN0ZW5lcnMubGVuZ3RoOyArK2kpIHtcbiAgICAgIGZpbmREZXBzKGxpc3RlbmVyc1tpXSk7XG4gICAgfVxuICAgIG9yZGVyWysrb3JkZXJOZXh0SWR4XSA9IHM7XG4gIH1cbn1cblxuLyoqXG4gKiBAcHJpdmF0ZVxuICovXG5mdW5jdGlvbiBmbHVzaFVwZGF0ZSgpIHtcbiAgZmx1c2hpbmcgPSB0cnVlO1xuICB3aGlsZSAodG9VcGRhdGUubGVuZ3RoID4gMCkge1xuICAgIHZhciBzID0gdG9VcGRhdGUuc2hpZnQoKTtcbiAgICBpZiAocy52YWxzLmxlbmd0aCA+IDApIHMudmFsID0gcy52YWxzLnNoaWZ0KCk7XG4gICAgdXBkYXRlRGVwcyhzKTtcbiAgfVxuICBmbHVzaGluZyA9IGZhbHNlO1xufVxuXG4vKipcbiAqIEBwcml2YXRlXG4gKiBQdXNoIGRvd24gYSB2YWx1ZSBpbnRvIGEgc3RyZWFtXG4gKiBAcGFyYW0ge3N0cmVhbX0gc3RyZWFtXG4gKiBAcGFyYW0geyp9IHZhbHVlXG4gKi9cbmZ1bmN0aW9uIHVwZGF0ZVN0cmVhbVZhbHVlKHMsIG4pIHtcbiAgaWYgKG4gIT09IHVuZGVmaW5lZCAmJiBuICE9PSBudWxsICYmIGlzRnVuY3Rpb24obi50aGVuKSkge1xuICAgIG4udGhlbihzKTtcbiAgICByZXR1cm47XG4gIH1cbiAgcy52YWwgPSBuO1xuICBzLmhhc1ZhbCA9IHRydWU7XG4gIGlmIChpblN0cmVhbSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgZmx1c2hpbmcgPSB0cnVlO1xuICAgIHVwZGF0ZURlcHMocyk7XG4gICAgaWYgKHRvVXBkYXRlLmxlbmd0aCA+IDApIGZsdXNoVXBkYXRlKCk7IGVsc2UgZmx1c2hpbmcgPSBmYWxzZTtcbiAgfSBlbHNlIGlmIChpblN0cmVhbSA9PT0gcykge1xuICAgIG1hcmtMaXN0ZW5lcnMocywgcy5saXN0ZW5lcnMpO1xuICB9IGVsc2Uge1xuICAgIHMudmFscy5wdXNoKG4pO1xuICAgIHRvVXBkYXRlLnB1c2gocyk7XG4gIH1cbn1cblxuLyoqXG4gKiBAcHJpdmF0ZVxuICovXG5mdW5jdGlvbiBtYXJrTGlzdGVuZXJzKHMsIGxpc3RzKSB7XG4gIHZhciBpLCBsaXN0O1xuICBmb3IgKGkgPSAwOyBpIDwgbGlzdHMubGVuZ3RoOyArK2kpIHtcbiAgICBsaXN0ID0gbGlzdHNbaV07XG4gICAgaWYgKGxpc3QuZW5kICE9PSBzKSB7XG4gICAgICBpZiAobGlzdC5kZXBzQ2hhbmdlZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGxpc3QuZGVwc0NoYW5nZWQucHVzaChzKTtcbiAgICAgIH1cbiAgICAgIGxpc3Quc2hvdWxkVXBkYXRlID0gdHJ1ZTtcbiAgICB9IGVsc2Uge1xuICAgICAgZW5kU3RyZWFtKGxpc3QpO1xuICAgIH1cbiAgfVxufVxuXG4vKipcbiAqIEBwcml2YXRlXG4gKiBBZGQgZGVwZW5kZW5jaWVzIHRvIGEgc3RyZWFtXG4gKiBAcGFyYW0ge0FycmF5PHN0cmVhbT59IGRlcGVuZGVuY2llc1xuICogQHBhcmFtIHtzdHJlYW19IHN0cmVhbVxuICovXG5mdW5jdGlvbiBhZGRMaXN0ZW5lcnMoZGVwcywgcykge1xuICBmb3IgKHZhciBpID0gMDsgaSA8IGRlcHMubGVuZ3RoOyArK2kpIHtcbiAgICBkZXBzW2ldLmxpc3RlbmVycy5wdXNoKHMpO1xuICB9XG59XG5cbi8qKlxuICogQHByaXZhdGVcbiAqIFJlbW92ZXMgYW4gc3RyZWFtIGZyb20gYSBkZXBlbmRlbmN5IGFycmF5XG4gKiBAcGFyYW0ge3N0cmVhbX0gc3RyZWFtXG4gKiBAcGFyYW0ge0FycmF5PHN0cmVhbT59IGRlcGVuZGVuY2llc1xuICovXG5mdW5jdGlvbiByZW1vdmVMaXN0ZW5lcihzLCBsaXN0ZW5lcnMpIHtcbiAgdmFyIGlkeCA9IGxpc3RlbmVycy5pbmRleE9mKHMpO1xuICBsaXN0ZW5lcnNbaWR4XSA9IGxpc3RlbmVyc1tsaXN0ZW5lcnMubGVuZ3RoIC0gMV07XG4gIGxpc3RlbmVycy5sZW5ndGgtLTtcbn1cblxuLyoqXG4gKiBAcHJpdmF0ZVxuICogRGV0YWNoIGEgc3RyZWFtIGZyb20gaXRzIGRlcGVuZGVuY2llc1xuICogQHBhcmFtIHtzdHJlYW19IHN0cmVhbVxuICovXG5mdW5jdGlvbiBkZXRhY2hEZXBzKHMpIHtcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBzLmRlcHMubGVuZ3RoOyArK2kpIHtcbiAgICByZW1vdmVMaXN0ZW5lcihzLCBzLmRlcHNbaV0ubGlzdGVuZXJzKTtcbiAgfVxuICBzLmRlcHMubGVuZ3RoID0gMDtcbn1cblxuLyoqXG4gKiBAcHJpdmF0ZVxuICogRW5kcyBhIHN0cmVhbVxuICovXG5mdW5jdGlvbiBlbmRTdHJlYW0ocykge1xuICBpZiAocy5kZXBzICE9PSB1bmRlZmluZWQpIGRldGFjaERlcHMocyk7XG4gIGlmIChzLmVuZCAhPT0gdW5kZWZpbmVkKSBkZXRhY2hEZXBzKHMuZW5kKTtcbn1cblxuLyoqXG4gKiBAcHJpdmF0ZVxuICogdHJhbnNkdWNlciBzdHJlYW0gdHJhbnNmb3JtZXJcbiAqL1xuZnVuY3Rpb24gU3RyZWFtVHJhbnNmb3JtZXIoKSB7IH1cblN0cmVhbVRyYW5zZm9ybWVyLnByb3RvdHlwZVsnQEB0cmFuc2R1Y2VyL2luaXQnXSA9IGZ1bmN0aW9uKCkgeyB9O1xuU3RyZWFtVHJhbnNmb3JtZXIucHJvdG90eXBlWydAQHRyYW5zZHVjZXIvcmVzdWx0J10gPSBmdW5jdGlvbigpIHsgfTtcblN0cmVhbVRyYW5zZm9ybWVyLnByb3RvdHlwZVsnQEB0cmFuc2R1Y2VyL3N0ZXAnXSA9IGZ1bmN0aW9uKHMsIHYpIHsgcmV0dXJuIHY7IH07XG5cbm1vZHVsZS5leHBvcnRzID0gZmx5ZDtcbiIsInZhciBfYXJpdHkgPSByZXF1aXJlKCcuL2ludGVybmFsL19hcml0eScpO1xudmFyIF9jdXJyeTEgPSByZXF1aXJlKCcuL2ludGVybmFsL19jdXJyeTEnKTtcbnZhciBfY3VycnkyID0gcmVxdWlyZSgnLi9pbnRlcm5hbC9fY3VycnkyJyk7XG52YXIgX2N1cnJ5TiA9IHJlcXVpcmUoJy4vaW50ZXJuYWwvX2N1cnJ5TicpO1xuXG5cbi8qKlxuICogUmV0dXJucyBhIGN1cnJpZWQgZXF1aXZhbGVudCBvZiB0aGUgcHJvdmlkZWQgZnVuY3Rpb24sIHdpdGggdGhlIHNwZWNpZmllZFxuICogYXJpdHkuIFRoZSBjdXJyaWVkIGZ1bmN0aW9uIGhhcyB0d28gdW51c3VhbCBjYXBhYmlsaXRpZXMuIEZpcnN0LCBpdHNcbiAqIGFyZ3VtZW50cyBuZWVkbid0IGJlIHByb3ZpZGVkIG9uZSBhdCBhIHRpbWUuIElmIGBnYCBpcyBgUi5jdXJyeU4oMywgZilgLCB0aGVcbiAqIGZvbGxvd2luZyBhcmUgZXF1aXZhbGVudDpcbiAqXG4gKiAgIC0gYGcoMSkoMikoMylgXG4gKiAgIC0gYGcoMSkoMiwgMylgXG4gKiAgIC0gYGcoMSwgMikoMylgXG4gKiAgIC0gYGcoMSwgMiwgMylgXG4gKlxuICogU2Vjb25kbHksIHRoZSBzcGVjaWFsIHBsYWNlaG9sZGVyIHZhbHVlIGBSLl9fYCBtYXkgYmUgdXNlZCB0byBzcGVjaWZ5XG4gKiBcImdhcHNcIiwgYWxsb3dpbmcgcGFydGlhbCBhcHBsaWNhdGlvbiBvZiBhbnkgY29tYmluYXRpb24gb2YgYXJndW1lbnRzLFxuICogcmVnYXJkbGVzcyBvZiB0aGVpciBwb3NpdGlvbnMuIElmIGBnYCBpcyBhcyBhYm92ZSBhbmQgYF9gIGlzIGBSLl9fYCwgdGhlXG4gKiBmb2xsb3dpbmcgYXJlIGVxdWl2YWxlbnQ6XG4gKlxuICogICAtIGBnKDEsIDIsIDMpYFxuICogICAtIGBnKF8sIDIsIDMpKDEpYFxuICogICAtIGBnKF8sIF8sIDMpKDEpKDIpYFxuICogICAtIGBnKF8sIF8sIDMpKDEsIDIpYFxuICogICAtIGBnKF8sIDIpKDEpKDMpYFxuICogICAtIGBnKF8sIDIpKDEsIDMpYFxuICogICAtIGBnKF8sIDIpKF8sIDMpKDEpYFxuICpcbiAqIEBmdW5jXG4gKiBAbWVtYmVyT2YgUlxuICogQHNpbmNlIHYwLjUuMFxuICogQGNhdGVnb3J5IEZ1bmN0aW9uXG4gKiBAc2lnIE51bWJlciAtPiAoKiAtPiBhKSAtPiAoKiAtPiBhKVxuICogQHBhcmFtIHtOdW1iZXJ9IGxlbmd0aCBUaGUgYXJpdHkgZm9yIHRoZSByZXR1cm5lZCBmdW5jdGlvbi5cbiAqIEBwYXJhbSB7RnVuY3Rpb259IGZuIFRoZSBmdW5jdGlvbiB0byBjdXJyeS5cbiAqIEByZXR1cm4ge0Z1bmN0aW9ufSBBIG5ldywgY3VycmllZCBmdW5jdGlvbi5cbiAqIEBzZWUgUi5jdXJyeVxuICogQGV4YW1wbGVcbiAqXG4gKiAgICAgIHZhciBzdW1BcmdzID0gKC4uLmFyZ3MpID0+IFIuc3VtKGFyZ3MpO1xuICpcbiAqICAgICAgdmFyIGN1cnJpZWRBZGRGb3VyTnVtYmVycyA9IFIuY3VycnlOKDQsIHN1bUFyZ3MpO1xuICogICAgICB2YXIgZiA9IGN1cnJpZWRBZGRGb3VyTnVtYmVycygxLCAyKTtcbiAqICAgICAgdmFyIGcgPSBmKDMpO1xuICogICAgICBnKDQpOyAvLz0+IDEwXG4gKi9cbm1vZHVsZS5leHBvcnRzID0gX2N1cnJ5MihmdW5jdGlvbiBjdXJyeU4obGVuZ3RoLCBmbikge1xuICBpZiAobGVuZ3RoID09PSAxKSB7XG4gICAgcmV0dXJuIF9jdXJyeTEoZm4pO1xuICB9XG4gIHJldHVybiBfYXJpdHkobGVuZ3RoLCBfY3VycnlOKGxlbmd0aCwgW10sIGZuKSk7XG59KTtcbiIsIm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gX2FyaXR5KG4sIGZuKSB7XG4gIC8qIGVzbGludC1kaXNhYmxlIG5vLXVudXNlZC12YXJzICovXG4gIHN3aXRjaCAobikge1xuICAgIGNhc2UgMDogcmV0dXJuIGZ1bmN0aW9uKCkgeyByZXR1cm4gZm4uYXBwbHkodGhpcywgYXJndW1lbnRzKTsgfTtcbiAgICBjYXNlIDE6IHJldHVybiBmdW5jdGlvbihhMCkgeyByZXR1cm4gZm4uYXBwbHkodGhpcywgYXJndW1lbnRzKTsgfTtcbiAgICBjYXNlIDI6IHJldHVybiBmdW5jdGlvbihhMCwgYTEpIHsgcmV0dXJuIGZuLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7IH07XG4gICAgY2FzZSAzOiByZXR1cm4gZnVuY3Rpb24oYTAsIGExLCBhMikgeyByZXR1cm4gZm4uYXBwbHkodGhpcywgYXJndW1lbnRzKTsgfTtcbiAgICBjYXNlIDQ6IHJldHVybiBmdW5jdGlvbihhMCwgYTEsIGEyLCBhMykgeyByZXR1cm4gZm4uYXBwbHkodGhpcywgYXJndW1lbnRzKTsgfTtcbiAgICBjYXNlIDU6IHJldHVybiBmdW5jdGlvbihhMCwgYTEsIGEyLCBhMywgYTQpIHsgcmV0dXJuIGZuLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7IH07XG4gICAgY2FzZSA2OiByZXR1cm4gZnVuY3Rpb24oYTAsIGExLCBhMiwgYTMsIGE0LCBhNSkgeyByZXR1cm4gZm4uYXBwbHkodGhpcywgYXJndW1lbnRzKTsgfTtcbiAgICBjYXNlIDc6IHJldHVybiBmdW5jdGlvbihhMCwgYTEsIGEyLCBhMywgYTQsIGE1LCBhNikgeyByZXR1cm4gZm4uYXBwbHkodGhpcywgYXJndW1lbnRzKTsgfTtcbiAgICBjYXNlIDg6IHJldHVybiBmdW5jdGlvbihhMCwgYTEsIGEyLCBhMywgYTQsIGE1LCBhNiwgYTcpIHsgcmV0dXJuIGZuLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7IH07XG4gICAgY2FzZSA5OiByZXR1cm4gZnVuY3Rpb24oYTAsIGExLCBhMiwgYTMsIGE0LCBhNSwgYTYsIGE3LCBhOCkgeyByZXR1cm4gZm4uYXBwbHkodGhpcywgYXJndW1lbnRzKTsgfTtcbiAgICBjYXNlIDEwOiByZXR1cm4gZnVuY3Rpb24oYTAsIGExLCBhMiwgYTMsIGE0LCBhNSwgYTYsIGE3LCBhOCwgYTkpIHsgcmV0dXJuIGZuLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7IH07XG4gICAgZGVmYXVsdDogdGhyb3cgbmV3IEVycm9yKCdGaXJzdCBhcmd1bWVudCB0byBfYXJpdHkgbXVzdCBiZSBhIG5vbi1uZWdhdGl2ZSBpbnRlZ2VyIG5vIGdyZWF0ZXIgdGhhbiB0ZW4nKTtcbiAgfVxufTtcbiIsInZhciBfaXNQbGFjZWhvbGRlciA9IHJlcXVpcmUoJy4vX2lzUGxhY2Vob2xkZXInKTtcblxuXG4vKipcbiAqIE9wdGltaXplZCBpbnRlcm5hbCBvbmUtYXJpdHkgY3VycnkgZnVuY3Rpb24uXG4gKlxuICogQHByaXZhdGVcbiAqIEBjYXRlZ29yeSBGdW5jdGlvblxuICogQHBhcmFtIHtGdW5jdGlvbn0gZm4gVGhlIGZ1bmN0aW9uIHRvIGN1cnJ5LlxuICogQHJldHVybiB7RnVuY3Rpb259IFRoZSBjdXJyaWVkIGZ1bmN0aW9uLlxuICovXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIF9jdXJyeTEoZm4pIHtcbiAgcmV0dXJuIGZ1bmN0aW9uIGYxKGEpIHtcbiAgICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMCB8fCBfaXNQbGFjZWhvbGRlcihhKSkge1xuICAgICAgcmV0dXJuIGYxO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXR1cm4gZm4uYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgICB9XG4gIH07XG59O1xuIiwidmFyIF9jdXJyeTEgPSByZXF1aXJlKCcuL19jdXJyeTEnKTtcbnZhciBfaXNQbGFjZWhvbGRlciA9IHJlcXVpcmUoJy4vX2lzUGxhY2Vob2xkZXInKTtcblxuXG4vKipcbiAqIE9wdGltaXplZCBpbnRlcm5hbCB0d28tYXJpdHkgY3VycnkgZnVuY3Rpb24uXG4gKlxuICogQHByaXZhdGVcbiAqIEBjYXRlZ29yeSBGdW5jdGlvblxuICogQHBhcmFtIHtGdW5jdGlvbn0gZm4gVGhlIGZ1bmN0aW9uIHRvIGN1cnJ5LlxuICogQHJldHVybiB7RnVuY3Rpb259IFRoZSBjdXJyaWVkIGZ1bmN0aW9uLlxuICovXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIF9jdXJyeTIoZm4pIHtcbiAgcmV0dXJuIGZ1bmN0aW9uIGYyKGEsIGIpIHtcbiAgICBzd2l0Y2ggKGFyZ3VtZW50cy5sZW5ndGgpIHtcbiAgICAgIGNhc2UgMDpcbiAgICAgICAgcmV0dXJuIGYyO1xuICAgICAgY2FzZSAxOlxuICAgICAgICByZXR1cm4gX2lzUGxhY2Vob2xkZXIoYSkgPyBmMlxuICAgICAgICAgICAgIDogX2N1cnJ5MShmdW5jdGlvbihfYikgeyByZXR1cm4gZm4oYSwgX2IpOyB9KTtcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHJldHVybiBfaXNQbGFjZWhvbGRlcihhKSAmJiBfaXNQbGFjZWhvbGRlcihiKSA/IGYyXG4gICAgICAgICAgICAgOiBfaXNQbGFjZWhvbGRlcihhKSA/IF9jdXJyeTEoZnVuY3Rpb24oX2EpIHsgcmV0dXJuIGZuKF9hLCBiKTsgfSlcbiAgICAgICAgICAgICA6IF9pc1BsYWNlaG9sZGVyKGIpID8gX2N1cnJ5MShmdW5jdGlvbihfYikgeyByZXR1cm4gZm4oYSwgX2IpOyB9KVxuICAgICAgICAgICAgIDogZm4oYSwgYik7XG4gICAgfVxuICB9O1xufTtcbiIsInZhciBfYXJpdHkgPSByZXF1aXJlKCcuL19hcml0eScpO1xudmFyIF9pc1BsYWNlaG9sZGVyID0gcmVxdWlyZSgnLi9faXNQbGFjZWhvbGRlcicpO1xuXG5cbi8qKlxuICogSW50ZXJuYWwgY3VycnlOIGZ1bmN0aW9uLlxuICpcbiAqIEBwcml2YXRlXG4gKiBAY2F0ZWdvcnkgRnVuY3Rpb25cbiAqIEBwYXJhbSB7TnVtYmVyfSBsZW5ndGggVGhlIGFyaXR5IG9mIHRoZSBjdXJyaWVkIGZ1bmN0aW9uLlxuICogQHBhcmFtIHtBcnJheX0gcmVjZWl2ZWQgQW4gYXJyYXkgb2YgYXJndW1lbnRzIHJlY2VpdmVkIHRodXMgZmFyLlxuICogQHBhcmFtIHtGdW5jdGlvbn0gZm4gVGhlIGZ1bmN0aW9uIHRvIGN1cnJ5LlxuICogQHJldHVybiB7RnVuY3Rpb259IFRoZSBjdXJyaWVkIGZ1bmN0aW9uLlxuICovXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIF9jdXJyeU4obGVuZ3RoLCByZWNlaXZlZCwgZm4pIHtcbiAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgIHZhciBjb21iaW5lZCA9IFtdO1xuICAgIHZhciBhcmdzSWR4ID0gMDtcbiAgICB2YXIgbGVmdCA9IGxlbmd0aDtcbiAgICB2YXIgY29tYmluZWRJZHggPSAwO1xuICAgIHdoaWxlIChjb21iaW5lZElkeCA8IHJlY2VpdmVkLmxlbmd0aCB8fCBhcmdzSWR4IDwgYXJndW1lbnRzLmxlbmd0aCkge1xuICAgICAgdmFyIHJlc3VsdDtcbiAgICAgIGlmIChjb21iaW5lZElkeCA8IHJlY2VpdmVkLmxlbmd0aCAmJlxuICAgICAgICAgICghX2lzUGxhY2Vob2xkZXIocmVjZWl2ZWRbY29tYmluZWRJZHhdKSB8fFxuICAgICAgICAgICBhcmdzSWR4ID49IGFyZ3VtZW50cy5sZW5ndGgpKSB7XG4gICAgICAgIHJlc3VsdCA9IHJlY2VpdmVkW2NvbWJpbmVkSWR4XTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJlc3VsdCA9IGFyZ3VtZW50c1thcmdzSWR4XTtcbiAgICAgICAgYXJnc0lkeCArPSAxO1xuICAgICAgfVxuICAgICAgY29tYmluZWRbY29tYmluZWRJZHhdID0gcmVzdWx0O1xuICAgICAgaWYgKCFfaXNQbGFjZWhvbGRlcihyZXN1bHQpKSB7XG4gICAgICAgIGxlZnQgLT0gMTtcbiAgICAgIH1cbiAgICAgIGNvbWJpbmVkSWR4ICs9IDE7XG4gICAgfVxuICAgIHJldHVybiBsZWZ0IDw9IDAgPyBmbi5hcHBseSh0aGlzLCBjb21iaW5lZClcbiAgICAgICAgICAgICAgICAgICAgIDogX2FyaXR5KGxlZnQsIF9jdXJyeU4obGVuZ3RoLCBjb21iaW5lZCwgZm4pKTtcbiAgfTtcbn07XG4iLCJtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIF9pc1BsYWNlaG9sZGVyKGEpIHtcbiAgcmV0dXJuIGEgIT0gbnVsbCAmJlxuICAgICAgICAgdHlwZW9mIGEgPT09ICdvYmplY3QnICYmXG4gICAgICAgICBhWydAQGZ1bmN0aW9uYWwvcGxhY2Vob2xkZXInXSA9PT0gdHJ1ZTtcbn07XG4iLCIndXNlIHN0cmljdCc7XG5cbm1vZHVsZS5leHBvcnRzID0gUmVzcG9uc2U7XG5cbi8qKlxuICogQSByZXNwb25zZSBmcm9tIGEgd2ViIHJlcXVlc3RcbiAqXG4gKiBAcGFyYW0ge051bWJlcn0gc3RhdHVzQ29kZVxuICogQHBhcmFtIHtPYmplY3R9IGhlYWRlcnNcbiAqIEBwYXJhbSB7QnVmZmVyfSBib2R5XG4gKiBAcGFyYW0ge1N0cmluZ30gdXJsXG4gKi9cbmZ1bmN0aW9uIFJlc3BvbnNlKHN0YXR1c0NvZGUsIGhlYWRlcnMsIGJvZHksIHVybCkge1xuICBpZiAodHlwZW9mIHN0YXR1c0NvZGUgIT09ICdudW1iZXInKSB7XG4gICAgdGhyb3cgbmV3IFR5cGVFcnJvcignc3RhdHVzQ29kZSBtdXN0IGJlIGEgbnVtYmVyIGJ1dCB3YXMgJyArICh0eXBlb2Ygc3RhdHVzQ29kZSkpO1xuICB9XG4gIGlmIChoZWFkZXJzID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IFR5cGVFcnJvcignaGVhZGVycyBjYW5ub3QgYmUgbnVsbCcpO1xuICB9XG4gIGlmICh0eXBlb2YgaGVhZGVycyAhPT0gJ29iamVjdCcpIHtcbiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdoZWFkZXJzIG11c3QgYmUgYW4gb2JqZWN0IGJ1dCB3YXMgJyArICh0eXBlb2YgaGVhZGVycykpO1xuICB9XG4gIHRoaXMuc3RhdHVzQ29kZSA9IHN0YXR1c0NvZGU7XG4gIHRoaXMuaGVhZGVycyA9IHt9O1xuICBmb3IgKHZhciBrZXkgaW4gaGVhZGVycykge1xuICAgIHRoaXMuaGVhZGVyc1trZXkudG9Mb3dlckNhc2UoKV0gPSBoZWFkZXJzW2tleV07XG4gIH1cbiAgdGhpcy5ib2R5ID0gYm9keTtcbiAgdGhpcy51cmwgPSB1cmw7XG59XG5cblJlc3BvbnNlLnByb3RvdHlwZS5nZXRCb2R5ID0gZnVuY3Rpb24gKGVuY29kaW5nKSB7XG4gIGlmICh0aGlzLnN0YXR1c0NvZGUgPj0gMzAwKSB7XG4gICAgdmFyIGVyciA9IG5ldyBFcnJvcignU2VydmVyIHJlc3BvbmRlZCB3aXRoIHN0YXR1cyBjb2RlICdcbiAgICAgICAgICAgICAgICAgICAgKyB0aGlzLnN0YXR1c0NvZGUgKyAnOlxcbicgKyB0aGlzLmJvZHkudG9TdHJpbmcoKSk7XG4gICAgZXJyLnN0YXR1c0NvZGUgPSB0aGlzLnN0YXR1c0NvZGU7XG4gICAgZXJyLmhlYWRlcnMgPSB0aGlzLmhlYWRlcnM7XG4gICAgZXJyLmJvZHkgPSB0aGlzLmJvZHk7XG4gICAgZXJyLnVybCA9IHRoaXMudXJsO1xuICAgIHRocm93IGVycjtcbiAgfVxuICByZXR1cm4gZW5jb2RpbmcgPyB0aGlzLmJvZHkudG9TdHJpbmcoZW5jb2RpbmcpIDogdGhpcy5ib2R5O1xufTtcbiIsIid1c2Ugc3RyaWN0JztcblxuT2JqZWN0LmRlZmluZVByb3BlcnR5KGV4cG9ydHMsIFwiX19lc01vZHVsZVwiLCB7XG4gIHZhbHVlOiB0cnVlXG59KTtcbmV4cG9ydHMudG9KcyA9IGV4cG9ydHMudG9DbGogPSBleHBvcnRzLmZuaWwgPSBleHBvcnRzLmN1cnJ5ID0gZXhwb3J0cy5wYXJ0aWFsID0gZXhwb3J0cy5waXBlbGluZSA9IGV4cG9ydHMua25pdCA9IGV4cG9ydHMuanV4dCA9IGV4cG9ydHMuY29tcCA9IGV4cG9ydHMuaXNPZGQgPSBleHBvcnRzLmlzRXZlbiA9IGV4cG9ydHMuc3VtID0gZXhwb3J0cy5kZWMgPSBleHBvcnRzLmluYyA9IGV4cG9ydHMuY29uc3RhbnRseSA9IGV4cG9ydHMuaWRlbnRpdHkgPSBleHBvcnRzLnByaW1TZXEgPSBleHBvcnRzLmdyb3VwQnkgPSBleHBvcnRzLnBhcnRpdGlvbkJ5ID0gZXhwb3J0cy5wYXJ0aXRpb24gPSBleHBvcnRzLnJlcGVhdGVkbHkgPSBleHBvcnRzLnJlcGVhdCA9IGV4cG9ydHMuaXRlcmF0ZSA9IGV4cG9ydHMuaW50ZXJsZWF2ZSA9IGV4cG9ydHMuaW50ZXJwb3NlID0gZXhwb3J0cy5zb3J0QnkgPSBleHBvcnRzLnNvcnQgPSBleHBvcnRzLmV2ZXJ5ID0gZXhwb3J0cy5zb21lID0gZXhwb3J0cy5kcm9wV2hpbGUgPSBleHBvcnRzLmRyb3AgPSBleHBvcnRzLnRha2VXaGlsZSA9IGV4cG9ydHMudGFrZSA9IGV4cG9ydHMucmVkdWNlS1YgPSBleHBvcnRzLnJlZHVjZSA9IGV4cG9ydHMucmVtb3ZlID0gZXhwb3J0cy5maWx0ZXIgPSBleHBvcnRzLm1hcGNhdCA9IGV4cG9ydHMubWFwID0gZXhwb3J0cy5lYWNoID0gZXhwb3J0cy5pbnRvQXJyYXkgPSBleHBvcnRzLmZsYXR0ZW4gPSBleHBvcnRzLmNvbmNhdCA9IGV4cG9ydHMuY29ucyA9IGV4cG9ydHMuc2VxID0gZXhwb3J0cy5yZXN0ID0gZXhwb3J0cy5maXJzdCA9IGV4cG9ydHMuaXNTdXBlcnNldCA9IGV4cG9ydHMuaXNTdWJzZXQgPSBleHBvcnRzLmRpZmZlcmVuY2UgPSBleHBvcnRzLmludGVyc2VjdGlvbiA9IGV4cG9ydHMudW5pb24gPSBleHBvcnRzLmRpc2ogPSBleHBvcnRzLm1lcmdlID0gZXhwb3J0cy52YWxzID0gZXhwb3J0cy5rZXlzID0gZXhwb3J0cy5zdWJ2ZWMgPSBleHBvcnRzLnJldmVyc2UgPSBleHBvcnRzLnppcG1hcCA9IGV4cG9ydHMucG9wID0gZXhwb3J0cy5wZWVrID0gZXhwb3J0cy5pc0VtcHR5ID0gZXhwb3J0cy5jb3VudCA9IGV4cG9ydHMudXBkYXRlSW4gPSBleHBvcnRzLmFzc29jSW4gPSBleHBvcnRzLmxhc3QgPSBleHBvcnRzLm50aCA9IGV4cG9ydHMuZmluZCA9IGV4cG9ydHMuaGFzS2V5ID0gZXhwb3J0cy5nZXRJbiA9IGV4cG9ydHMuZ2V0ID0gZXhwb3J0cy5lbXB0eSA9IGV4cG9ydHMuZGlzdGluY3QgPSBleHBvcnRzLmRpc3NvYyA9IGV4cG9ydHMuYXNzb2MgPSBleHBvcnRzLmludG8gPSBleHBvcnRzLmNvbmogPSBleHBvcnRzLmlzUmV2ZXJzaWJsZSA9IGV4cG9ydHMuaXNTZXFhYmxlID0gZXhwb3J0cy5pc1JlZHVjZWFibGUgPSBleHBvcnRzLmlzSW5kZXhlZCA9IGV4cG9ydHMuaXNDb3VudGVkID0gZXhwb3J0cy5pc0Fzc29jaWF0aXZlID0gZXhwb3J0cy5pc1NlcXVlbnRpYWwgPSBleHBvcnRzLmlzQ29sbGVjdGlvbiA9IGV4cG9ydHMuaXNTZXQgPSBleHBvcnRzLmlzTWFwID0gZXhwb3J0cy5pc1ZlY3RvciA9IGV4cG9ydHMuaXNTZXEgPSBleHBvcnRzLmlzTGlzdCA9IGV4cG9ydHMuaGFzaCA9IGV4cG9ydHMuZXF1YWxzID0gdW5kZWZpbmVkO1xuXG52YXIgX21vcmkgPSByZXF1aXJlKCdtb3JpJyk7XG5cbnZhciBfbW9yaTIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF9tb3JpKTtcblxuZnVuY3Rpb24gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChvYmopIHsgcmV0dXJuIG9iaiAmJiBvYmouX19lc01vZHVsZSA/IG9iaiA6IHsgZGVmYXVsdDogb2JqIH07IH1cblxuLy8gSW50ZXJuYWwgSGVscGVyc1xudmFyIHVuYXJ5RnVuYyA9IGZ1bmN0aW9uIHVuYXJ5RnVuYyhuYW1lKSB7XG4gIHJldHVybiBmdW5jdGlvbiBfdW5hcnkoKSB7XG4gICAgcmV0dXJuIF9tb3JpMi5kZWZhdWx0W25hbWVdKHRoaXMpO1xuICB9O1xufTtcbnZhciBiaW5hcnlGdW5jID0gZnVuY3Rpb24gYmluYXJ5RnVuYyhuYW1lLCByZXYpIHtcbiAgcmV0dXJuIHJldiA/IGZ1bmN0aW9uIF9iaW5hcnlSZXYocCkge1xuICAgIHJldHVybiBfbW9yaTIuZGVmYXVsdFtuYW1lXShwLCB0aGlzKTtcbiAgfSA6IGZ1bmN0aW9uIF9iaW5hcnkocCkge1xuICAgIHJldHVybiBfbW9yaTIuZGVmYXVsdFtuYW1lXSh0aGlzLCBwKTtcbiAgfTtcbn07XG52YXIgdGVybmFyeUZ1bmMgPSBmdW5jdGlvbiB0ZXJuYXJ5RnVuYyhuYW1lLCByZXYpIHtcbiAgcmV0dXJuIHJldiA/IGZ1bmN0aW9uIF90ZXJuYXJ5UmV2KGEsIGIpIHtcbiAgICByZXR1cm4gX21vcmkyLmRlZmF1bHRbbmFtZV0oYSwgYiwgdGhpcyk7XG4gIH0gOiBmdW5jdGlvbiBfdGVybmFyeShhLCBiKSB7XG4gICAgcmV0dXJuIF9tb3JpMi5kZWZhdWx0W25hbWVdKHRoaXMsIGEsIGIpO1xuICB9O1xufTtcblxudmFyIHZhcmlhZGljRnVuYyA9IGZ1bmN0aW9uIHZhcmlhZGljRnVuYyhuYW1lLCByZXYpIHtcbiAgcmV0dXJuIHJldiA/IGZ1bmN0aW9uIF92YXJpYWRpY1JldigpIHtcbiAgICByZXR1cm4gX21vcmkyLmRlZmF1bHRbbmFtZV0uYXBwbHkoX21vcmkyLmRlZmF1bHQsIEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cykuY29uY2F0KFt0aGlzXSkpO1xuICB9IDogZnVuY3Rpb24gX3ZhcmlhZGljKCkge1xuICAgIHJldHVybiBfbW9yaTIuZGVmYXVsdFtuYW1lXS5hcHBseShfbW9yaTIuZGVmYXVsdCwgW3RoaXNdLmNvbmNhdChBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChhcmd1bWVudHMpKSk7XG4gIH07XG59O1xuXG4vLyBGdW5kYW1lbnRhbHNcbnZhciBlcXVhbHMgPSBleHBvcnRzLmVxdWFscyA9IGJpbmFyeUZ1bmMoJ2VxdWFscycpO1xudmFyIGhhc2ggPSBleHBvcnRzLmhhc2ggPSB1bmFyeUZ1bmMoJ2hhc2gnKTtcbi8vIC0tXG5cbi8vIFR5cGUgUHJlZGljYXRlc1xudmFyIGlzTGlzdCA9IGV4cG9ydHMuaXNMaXN0ID0gdW5hcnlGdW5jKCdpc0xpc3QnKTtcbnZhciBpc1NlcSA9IGV4cG9ydHMuaXNTZXEgPSB1bmFyeUZ1bmMoJ2lzU2VxJyk7XG52YXIgaXNWZWN0b3IgPSBleHBvcnRzLmlzVmVjdG9yID0gdW5hcnlGdW5jKCdpc1ZlY3RvcicpO1xudmFyIGlzTWFwID0gZXhwb3J0cy5pc01hcCA9IHVuYXJ5RnVuYygnaXNNYXAnKTtcbnZhciBpc1NldCA9IGV4cG9ydHMuaXNTZXQgPSB1bmFyeUZ1bmMoJ2lzU2V0Jyk7XG52YXIgaXNDb2xsZWN0aW9uID0gZXhwb3J0cy5pc0NvbGxlY3Rpb24gPSB1bmFyeUZ1bmMoJ2lzQ29sbGVjdGlvbicpO1xudmFyIGlzU2VxdWVudGlhbCA9IGV4cG9ydHMuaXNTZXF1ZW50aWFsID0gdW5hcnlGdW5jKCdpc1NlcXVlbnRpYWwnKTtcbnZhciBpc0Fzc29jaWF0aXZlID0gZXhwb3J0cy5pc0Fzc29jaWF0aXZlID0gdW5hcnlGdW5jKCdpc0Fzc29jaWF0aXZlJyk7XG52YXIgaXNDb3VudGVkID0gZXhwb3J0cy5pc0NvdW50ZWQgPSB1bmFyeUZ1bmMoJ2lzQ291bnRlZCcpO1xudmFyIGlzSW5kZXhlZCA9IGV4cG9ydHMuaXNJbmRleGVkID0gdW5hcnlGdW5jKCdpc0luZGV4ZWQnKTtcbnZhciBpc1JlZHVjZWFibGUgPSBleHBvcnRzLmlzUmVkdWNlYWJsZSA9IHVuYXJ5RnVuYygnaXNSZWR1Y2VhYmxlJyk7XG52YXIgaXNTZXFhYmxlID0gZXhwb3J0cy5pc1NlcWFibGUgPSB1bmFyeUZ1bmMoJ2lzU2VxYWJsZScpO1xudmFyIGlzUmV2ZXJzaWJsZSA9IGV4cG9ydHMuaXNSZXZlcnNpYmxlID0gdW5hcnlGdW5jKCdpc1JldmVyc2libGUnKTtcbi8vIC0tXG5cbi8vIENvbGxlY3Rpb25zXG4vLyAtLVxuXG4vLyBDb2xsZWN0aW9uIE9wZXJhdGlvbnNcbnZhciBjb25qID0gZXhwb3J0cy5jb25qID0gdmFyaWFkaWNGdW5jKCdjb25qJyk7XG52YXIgaW50byA9IGV4cG9ydHMuaW50byA9IGJpbmFyeUZ1bmMoJ2ludG8nKTtcbnZhciBhc3NvYyA9IGV4cG9ydHMuYXNzb2MgPSB2YXJpYWRpY0Z1bmMoJ2Fzc29jJyk7XG52YXIgZGlzc29jID0gZXhwb3J0cy5kaXNzb2MgPSB2YXJpYWRpY0Z1bmMoJ2Rpc3NvYycpO1xudmFyIGRpc3RpbmN0ID0gZXhwb3J0cy5kaXN0aW5jdCA9IHVuYXJ5RnVuYygnZGlzdGluY3QnKTtcbnZhciBlbXB0eSA9IGV4cG9ydHMuZW1wdHkgPSB1bmFyeUZ1bmMoJ2VtcHR5Jyk7XG52YXIgZ2V0ID0gZXhwb3J0cy5nZXQgPSB0ZXJuYXJ5RnVuYygnZ2V0Jyk7XG52YXIgZ2V0SW4gPSBleHBvcnRzLmdldEluID0gdGVybmFyeUZ1bmMoJ2dldEluJyk7XG52YXIgaGFzS2V5ID0gZXhwb3J0cy5oYXNLZXkgPSBiaW5hcnlGdW5jKCdoYXNLZXknKTtcbnZhciBmaW5kID0gZXhwb3J0cy5maW5kID0gYmluYXJ5RnVuYygnZmluZCcpO1xudmFyIG50aCA9IGV4cG9ydHMubnRoID0gYmluYXJ5RnVuYygnbnRoJyk7XG52YXIgbGFzdCA9IGV4cG9ydHMubGFzdCA9IHVuYXJ5RnVuYygnbGFzdCcpO1xudmFyIGFzc29jSW4gPSBleHBvcnRzLmFzc29jSW4gPSB0ZXJuYXJ5RnVuYygnYXNzb2NJbicpO1xudmFyIHVwZGF0ZUluID0gZXhwb3J0cy51cGRhdGVJbiA9IHRlcm5hcnlGdW5jKCd1cGRhdGVJbicpO1xudmFyIGNvdW50ID0gZXhwb3J0cy5jb3VudCA9IHVuYXJ5RnVuYygnY291bnQnKTtcbnZhciBpc0VtcHR5ID0gZXhwb3J0cy5pc0VtcHR5ID0gdW5hcnlGdW5jKCdpc0VtcHR5Jyk7XG52YXIgcGVlayA9IGV4cG9ydHMucGVlayA9IHVuYXJ5RnVuYygncGVlaycpO1xudmFyIHBvcCA9IGV4cG9ydHMucG9wID0gdW5hcnlGdW5jKCdwb3AnKTtcbnZhciB6aXBtYXAgPSBleHBvcnRzLnppcG1hcCA9IGJpbmFyeUZ1bmMoJ3ppcG1hcCcpO1xudmFyIHJldmVyc2UgPSBleHBvcnRzLnJldmVyc2UgPSB1bmFyeUZ1bmMoJ3JldmVyc2UnKTtcbi8vIC0tXG5cbi8vIFZlY3RvciBPcGVyYXRpb25zXG52YXIgc3VidmVjID0gZXhwb3J0cy5zdWJ2ZWMgPSB0ZXJuYXJ5RnVuYygnc3VidmVjJyk7XG4vLyAtLVxuXG4vLyBIYXNoIE1hcCBPcGVyYXRpb25zXG52YXIga2V5cyA9IGV4cG9ydHMua2V5cyA9IHVuYXJ5RnVuYygna2V5cycpO1xudmFyIHZhbHMgPSBleHBvcnRzLnZhbHMgPSB1bmFyeUZ1bmMoJ3ZhbHMnKTtcbnZhciBtZXJnZSA9IGV4cG9ydHMubWVyZ2UgPSB2YXJpYWRpY0Z1bmMoJ21lcmdlJyk7XG4vLyAtLVxuXG4vLyBTZXQgT3BlcmF0aW9uc1xudmFyIGRpc2ogPSBleHBvcnRzLmRpc2ogPSBiaW5hcnlGdW5jKCdkaXNqJyk7XG52YXIgdW5pb24gPSBleHBvcnRzLnVuaW9uID0gdmFyaWFkaWNGdW5jKCd1bmlvbicpO1xudmFyIGludGVyc2VjdGlvbiA9IGV4cG9ydHMuaW50ZXJzZWN0aW9uID0gdmFyaWFkaWNGdW5jKCdpbnRlcnNlY3Rpb24nKTtcbnZhciBkaWZmZXJlbmNlID0gZXhwb3J0cy5kaWZmZXJlbmNlID0gdmFyaWFkaWNGdW5jKCdkaWZmZXJlbmNlJyk7XG52YXIgaXNTdWJzZXQgPSBleHBvcnRzLmlzU3Vic2V0ID0gYmluYXJ5RnVuYygnaXNTdWJzZXQnKTtcbnZhciBpc1N1cGVyc2V0ID0gZXhwb3J0cy5pc1N1cGVyc2V0ID0gYmluYXJ5RnVuYygnaXNTdXBlcnNldCcpO1xuLy8gLS1cblxuLy8gU2VxdWVuY2VzXG52YXIgZmlyc3QgPSBleHBvcnRzLmZpcnN0ID0gdW5hcnlGdW5jKCdmaXJzdCcpO1xudmFyIHJlc3QgPSBleHBvcnRzLnJlc3QgPSB1bmFyeUZ1bmMoJ3Jlc3QnKTtcbnZhciBzZXEgPSBleHBvcnRzLnNlcSA9IHVuYXJ5RnVuYygnc2VxJyk7XG5cbi8vIHZhbCBmaXJzdFxuLy8gMTo6Y29ucyhtb3JpLnZlY3RvcigyLCAzKSlcbnZhciBjb25zID0gZXhwb3J0cy5jb25zID0gYmluYXJ5RnVuYygnY29ucycpO1xuXG4vLyBmdW5jdGlvbiBmaXJzdFxuLy8gbW9yaS5yYW5nZSgzKTo6Y29uY2F0KFszLCA0LCA1XSlcbnZhciBjb25jYXQgPSBleHBvcnRzLmNvbmNhdCA9IHZhcmlhZGljRnVuYygnY29uY2F0Jyk7XG5cbnZhciBmbGF0dGVuID0gZXhwb3J0cy5mbGF0dGVuID0gdW5hcnlGdW5jKCdmbGF0dGVuJyk7XG52YXIgaW50b0FycmF5ID0gZXhwb3J0cy5pbnRvQXJyYXkgPSB1bmFyeUZ1bmMoJ2ludG9BcnJheScpO1xudmFyIGVhY2ggPSBleHBvcnRzLmVhY2ggPSBiaW5hcnlGdW5jKCdlYWNoJyk7XG5cbi8vIGZ1bmN0aW9uIGZpcnN0XG4vLyBtb3JpLmluYzo6bWFwKFswLCAxLCAyXSkgLy8gPT4gKDEsIDIsIDMpXG52YXIgbWFwID0gZXhwb3J0cy5tYXAgPSB2YXJpYWRpY0Z1bmMoJ21hcCcpO1xuXG4vLyBmdW5jdGlvbiBmaXJzdFxuLy8gKCh4LCB5KSA9PiBtb3JpLmxpc3QoeCwgeCArIHkpKTo6bWFwY2F0KG1vcmkuc2VxKCdhYmMnKSwgbW9yaS5zZXEoJzEyMycpKTtcbnZhciBtYXBjYXQgPSBleHBvcnRzLm1hcGNhdCA9IHZhcmlhZGljRnVuYygnbWFwY2F0Jyk7XG5cbnZhciBmaWx0ZXIgPSBleHBvcnRzLmZpbHRlciA9IGJpbmFyeUZ1bmMoJ2ZpbHRlcicsIHRydWUpO1xudmFyIHJlbW92ZSA9IGV4cG9ydHMucmVtb3ZlID0gYmluYXJ5RnVuYygncmVtb3ZlJywgdHJ1ZSk7XG5cbi8vIGZ1bmN0aW9uIGZpcnN0IC0+IHNwZWNpYWxcbnZhciByZWR1Y2UgPSBleHBvcnRzLnJlZHVjZSA9IGZ1bmN0aW9uIHJlZHVjZShmdW5jLCBpbml0aWFsKSB7XG4gIHJldHVybiBfbW9yaTIuZGVmYXVsdC5yZWR1Y2UoZnVuYywgaW5pdGlhbCwgdGhpcyk7XG59O1xuXG4vLyBmdW5jdGlvbiBmaXJzdFxudmFyIHJlZHVjZUtWID0gZXhwb3J0cy5yZWR1Y2VLViA9IGZ1bmN0aW9uIHJlZHVjZUtWKGZ1bmMsIGluaXRpYWwpIHtcbiAgcmV0dXJuIF9tb3JpMi5kZWZhdWx0LnJlZHVjZUtWKGZ1bmMsIGluaXRpYWwsIHRoaXMpO1xufTtcblxudmFyIHRha2UgPSBleHBvcnRzLnRha2UgPSBiaW5hcnlGdW5jKCd0YWtlJywgdHJ1ZSk7XG52YXIgdGFrZVdoaWxlID0gZXhwb3J0cy50YWtlV2hpbGUgPSBiaW5hcnlGdW5jKCd0YWtlV2hpbGUnLCB0cnVlKTtcbnZhciBkcm9wID0gZXhwb3J0cy5kcm9wID0gYmluYXJ5RnVuYygnZHJvcCcsIHRydWUpO1xudmFyIGRyb3BXaGlsZSA9IGV4cG9ydHMuZHJvcFdoaWxlID0gYmluYXJ5RnVuYygnZHJvcFdoaWxlJywgdHJ1ZSk7XG52YXIgc29tZSA9IGV4cG9ydHMuc29tZSA9IGJpbmFyeUZ1bmMoJ3NvbWUnLCB0cnVlKTtcbnZhciBldmVyeSA9IGV4cG9ydHMuZXZlcnkgPSBiaW5hcnlGdW5jKCdldmVyeScsIHRydWUpO1xuXG4vLyBvcHRpb25hbCBmdW5jdGlvbiBmaXJzdFxudmFyIHNvcnQgPSBleHBvcnRzLnNvcnQgPSBmdW5jdGlvbiBzb3J0KGNtcCkge1xuICByZXR1cm4gY21wID8gX21vcmkyLmRlZmF1bHQuc29ydChjbXAsIHRoaXMpIDogX21vcmkyLmRlZmF1bHQuc29ydCh0aGlzKTtcbn07XG5cbi8vIGZ1bmN0aW9uIGZpcnN0LCBvcHRpb25hbCBzZWNvbmQgcGFyYW1ldGVyLCBjb2xsXG52YXIgc29ydEJ5ID0gZXhwb3J0cy5zb3J0QnkgPSBmdW5jdGlvbiBzb3J0Qnkoa2V5Rm4sIGNtcCkge1xuICByZXR1cm4gY21wID8gX21vcmkyLmRlZmF1bHQuc29ydEJ5KGtleUZuLCBjbXAsIHRoaXMpIDogX21vcmkyLmRlZmF1bHQuc29ydEJ5KGtleUZuLCB0aGlzKTtcbn07XG52YXIgaW50ZXJwb3NlID0gZXhwb3J0cy5pbnRlcnBvc2UgPSBiaW5hcnlGdW5jKCdpbnRlcnBvc2UnLCB0cnVlKTtcbnZhciBpbnRlcmxlYXZlID0gZXhwb3J0cy5pbnRlcmxlYXZlID0gdmFyaWFkaWNGdW5jKCdpbnRlcmxlYXZlJyk7XG5cbi8vIGZ1bmN0aW9uIGZpcnN0XG52YXIgaXRlcmF0ZSA9IGV4cG9ydHMuaXRlcmF0ZSA9IGJpbmFyeUZ1bmMoJ2l0ZXJhdGUnKTtcblxuLy8gdmFsIGZpcnN0LCBmaXJzdCBwYXJhbSBvcHRpb25hbFxuLy8gc2luY2UgZmlyc3QgcGFyYW0gaXMgb3B0aW9uYWwsIHdlIGhhdmUgdG8gZG8gaXQgZGlmZmVyZW50bHlcbi8vICdmb28nOjpyZXBlYXQoKSAvLyBtb3JpLnJlcGVhdCgnZm9vJywgdm9pZClcbi8vICdmb28nOjpyZXBlYXQoNSkgLy8gbW9yaS5yZXBlYXQoNSwgJ2ZvbycpXG52YXIgcmVwZWF0ID0gZXhwb3J0cy5yZXBlYXQgPSBmdW5jdGlvbiBtcmVwZWF0KHApIHtcbiAgcmV0dXJuIHAgPyBfbW9yaTIuZGVmYXVsdC5yZXBlYXQocCwgdGhpcykgOiBfbW9yaTIuZGVmYXVsdC5yZXBlYXQodGhpcyk7XG59O1xuXG4vLyBmdW5jdGlvbiBmaXJzdCwgZmlyc3QgcGFyYW0gb3B0aW9uYWxcbi8vIHNpbmNlIGZpcnN0IHBhcmFtIGlzIG9wdGlvbmFsLCB3ZSBoYXZlIHRvIGRvIGl0IGRpZmZlcmVudGx5XG52YXIgcmVwZWF0ZWRseSA9IGV4cG9ydHMucmVwZWF0ZWRseSA9IGZ1bmN0aW9uIG1yZXBlYXRlZGx5KHApIHtcbiAgcmV0dXJuIHAgPyBfbW9yaTIuZGVmYXVsdC5yZXBlYXRlZGx5KHAsIHRoaXMpIDogX21vcmkyLmRlZmF1bHQucmVwZWF0ZWRseSh0aGlzKTtcbn07XG5cbnZhciBwYXJ0aXRpb24gPSBleHBvcnRzLnBhcnRpdGlvbiA9IHZhcmlhZGljRnVuYygncGFydGl0aW9uJywgdHJ1ZSk7XG52YXIgcGFydGl0aW9uQnkgPSBleHBvcnRzLnBhcnRpdGlvbkJ5ID0gYmluYXJ5RnVuYygncGFydGl0aW9uQnknLCB0cnVlKTtcbnZhciBncm91cEJ5ID0gZXhwb3J0cy5ncm91cEJ5ID0gYmluYXJ5RnVuYygnZ3JvdXBCeScsIHRydWUpO1xuLy8gLS1cblxuLy8gSGVscGVyc1xudmFyIHByaW1TZXEgPSBleHBvcnRzLnByaW1TZXEgPSB2YXJpYWRpY0Z1bmMoJ3ByaW1TZXEnKTtcbnZhciBpZGVudGl0eSA9IGV4cG9ydHMuaWRlbnRpdHkgPSB1bmFyeUZ1bmMoJ2lkZW50aXR5Jyk7XG52YXIgY29uc3RhbnRseSA9IGV4cG9ydHMuY29uc3RhbnRseSA9IHVuYXJ5RnVuYygnY29uc3RhbnRseScpO1xudmFyIGluYyA9IGV4cG9ydHMuaW5jID0gdW5hcnlGdW5jKCdpbmMnKTtcbnZhciBkZWMgPSBleHBvcnRzLmRlYyA9IHVuYXJ5RnVuYygnZGVjJyk7XG52YXIgc3VtID0gZXhwb3J0cy5zdW0gPSBiaW5hcnlGdW5jKCdzdW0nKTtcbnZhciBpc0V2ZW4gPSBleHBvcnRzLmlzRXZlbiA9IHVuYXJ5RnVuYygnaXNFdmVuJyk7XG52YXIgaXNPZGQgPSBleHBvcnRzLmlzT2RkID0gdW5hcnlGdW5jKCdpc09kZCcpO1xudmFyIGNvbXAgPSBleHBvcnRzLmNvbXAgPSBiaW5hcnlGdW5jKCdjb21wJyk7XG52YXIganV4dCA9IGV4cG9ydHMuanV4dCA9IHZhcmlhZGljRnVuYygnanV4dCcpO1xudmFyIGtuaXQgPSBleHBvcnRzLmtuaXQgPSB2YXJpYWRpY0Z1bmMoJ2tuaXQnKTtcbnZhciBwaXBlbGluZSA9IGV4cG9ydHMucGlwZWxpbmUgPSB2YXJpYWRpY0Z1bmMoJ3BpcGVsaW5lJyk7XG52YXIgcGFydGlhbCA9IGV4cG9ydHMucGFydGlhbCA9IHZhcmlhZGljRnVuYygncGFydGlhbCcpO1xudmFyIGN1cnJ5ID0gZXhwb3J0cy5jdXJyeSA9IHZhcmlhZGljRnVuYygnY3VycnknKTtcbnZhciBmbmlsID0gZXhwb3J0cy5mbmlsID0gdGVybmFyeUZ1bmMoJ2ZuaWwnKTtcbnZhciB0b0NsaiA9IGV4cG9ydHMudG9DbGogPSB1bmFyeUZ1bmMoJ3RvQ2xqJyk7XG52YXIgdG9KcyA9IGV4cG9ydHMudG9KcyA9IHVuYXJ5RnVuYygndG9KcycpO1xuLy8gLS0iLCJjb25zdCBleHRyYSA9IHtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gZXh0cmE7XG4iLCIvKipcbiBNaXhlcyBpbiBtb3JpLWV4dCBpbnRvIHRoZSBwcm90b3R5cGVzIG9mIGFsbCBvZiB0aGUgY29sbGVjdGlvbnNcbiB0aGF0IG1vcmkgZXhwb3Nlcy5cblxuIFRoaXMgaXMga2luZCBvZiBiYWQsIHNpbmNlIGl0IGdvZXMgYWdhaW5zdCBvbmUgb2YgdGhlIGZ1bmRhbWVudGFsXG4gZG9nbWFzIGluIG1vcmksIGJ1dCBpdCBtYWtlcyBmb3IgYSBkaWZmZXJlbnQgY29kaW5nIHN0eWxlLCB3aGljaFxuIG1heSBhcHBlYWwgdG8gc29tZS5cbiAqL1xuY29uc3QgZXh0ID0gcmVxdWlyZSgnbW9yaS1leHQnKTtcblxuLy8gY29tcGF0aWJpbGl0eSB3aXRoIG1ldGhvZCB0eXBlIGludm9jYXRpb25zLFxuLy8gZS5nLiBgbWFwYCB3aGljaCBpbiBtb3JpLWV4dCBleHBlY3RzIGB0aGlzYFxuLy8gdG8gYmUgYSBgZnVuY3Rpb25gLCB3aGVyZWFzIGluIG1vcmktZmx1ZW50XG4vLyBgdGhpc2AgaW4gYG1hcGAgc2hvdWxkIGJlIGEgY29sbGVjdGlvblxuLy8gYG1hcGAsIGBjb25zYFxuY29uc3QgY29tcGF0ID0gZnVuY3Rpb24gKG1vcmkpIHtcbiAgcmV0dXJuIHtcbiAgICAvKipcbiAgICAgQGV4YW1wbGVcbiAgICAgYG1vcmkudmVjdG9yKDEsIDIsIDMpLm1hcChtb3JpLmluYyk7IC8vID0+ICgyIDMgNClgXG4gICAgICovXG4gICAgbWFwOiBmdW5jdGlvbiBtb3JpRmx1ZW50X21hcChmbikge1xuICAgICAgcmV0dXJuIG1vcmkubWFwKGZuLCB0aGlzKTtcbiAgICB9LFxuICAgIC8qKlxuICAgICBAZXhhbXBsZVxuICAgICBgbW9yaS52ZWN0b3IoMSwgMikubWFwS1YobW9yaS52ZWN0b3IpOyAvLyA9PiAoWzAgMV0gWzEgMl0pYFxuICAgICAqL1xuICAgIG1hcEtWOiBmdW5jdGlvbiBtb3JpRmx1ZW50X21hcEtWKGZuKSB7XG4gICAgICByZXR1cm4gdGhpc1xuICAgICAgICAucmVkdWNlS1YoKGFjYywgaywgdikgPT4gYWNjLmNvbmooZm4oaywgdikpLFxuICAgICAgICAgICAgICAgICAgbW9yaS52ZWN0b3IoKSlcbiAgICAgICAgLnRha2UodGhpcy5jb3VudCgpKTtcbiAgICB9LFxuICAgIHJlZHVjZTogZnVuY3Rpb24gbW9yaUZsdWVudF9yZWR1Y2UoZm4sIGluaXRpYWwpIHtcbiAgICAgIHJldHVybiBpbml0aWFsID9cbiAgICAgICAgbW9yaS5yZWR1Y2UoZm4sIGluaXRpYWwsIHRoaXMpIDpcbiAgICAgICAgbW9yaS5yZWR1Y2UoZm4sIHRoaXMpO1xuICAgIH0sXG4gICAgcmVkdWNlS1Y6IGZ1bmN0aW9uIG1vcmlGbHVlbnRfcmVkdWNlS1YoZm4sIGluaXRpYWwpIHtcbiAgICAgIHJldHVybiBpbml0aWFsID9cbiAgICAgICAgbW9yaS5yZWR1Y2VLVihmbiwgaW5pdGlhbCwgdGhpcykgOlxuICAgICAgICBtb3JpLnJlZHVjZUtWKGZuLCB0aGlzKTtcbiAgICB9LFxuICAgIC8qKlxuICAgICBAZXhhbXBsZVxuICAgICBgbW9yaS52ZWN0b3IoMiwgMykuY29ucygxKTsgLy8gPT4gWzEgMiAzXWBcbiAgICAgKi9cbiAgICBjb25zOiBmdW5jdGlvbiBtb3JpRmx1ZW50X2NvbnModmFsdWUpIHtcbiAgICAgIG1vcmkuY29ucyh2YWx1ZSwgdGhpcyk7XG4gICAgfVxuICB9O1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAobW9yaSwgLi4uZXh0cmFNaXhpbnMpIHtcbiAgY29uc3QgcHJvdG9zID0gW1xuICAgIC8vIGJhc2ljIGNvbGxlY3Rpb25zXG4gICAgbW9yaS5saXN0KCksXG4gICAgbW9yaS52ZWN0b3IoKSxcbiAgICBtb3JpLmhhc2hNYXAoKSxcbiAgICBtb3JpLnNldCgpLFxuICAgIG1vcmkuc29ydGVkU2V0KCksXG4gICAgbW9yaS5yYW5nZSgpLFxuICAgIG1vcmkucXVldWUoKSxcblxuICAgIC8vIHNwZWNpYWwgY2FzZXNcbiAgICBtb3JpLnNlcShbMF0pLFxuICAgIG1vcmkucHJpbVNlcShbMF0pLFxuICAgIG1vcmkubWFwKG1vcmkuaWRlbnRpdHksIFswXSksXG4gIF0ubWFwKGNvbGwgPT4gY29sbC5jb25zdHJ1Y3Rvci5wcm90b3R5cGUpO1xuXG4gIHByb3Rvcy5mb3JFYWNoKHByb3RvID0+IHtcbiAgICBPYmplY3Qua2V5cyhleHQpLmZvckVhY2goayA9PiB7XG4gICAgICBwcm90b1trXSA9IGV4dFtrXTtcbiAgICB9KTtcblxuICAgIC8vIHVwZGF0ZSB0aGUgcHJvdG90eXBlcyB3aXRoIHRoZSBjb21wYXQgbGF5ZXIuXG4gICAgY29uc3QgY29tcGF0TGF5ZXIgPSBjb21wYXQobW9yaSk7XG4gICAgT2JqZWN0LmtleXMoY29tcGF0TGF5ZXIpLmZvckVhY2goayA9PiB7XG4gICAgICBwcm90b1trXSA9IGNvbXBhdExheWVyW2tdO1xuICAgIH0pO1xuXG4gICAgLy8gdXBkYXRlIHRoZSBwcm90b3R5cGVzIHdpdGggZXh0cmFzXG4gICAgZXh0cmFNaXhpbnMuZm9yRWFjaChtaXhpbiA9PiB7XG4gICAgICBPYmplY3Qua2V5cyhtaXhpbikuZm9yRWFjaChrID0+IHtcbiAgICAgICAgcHJvdG9ba10gPSBtaXhpbltrXTtcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcblxuICByZXR1cm4gbW9yaTtcbn07XG4iLCIoZnVuY3Rpb24oZGVmaW5pdGlvbil7aWYodHlwZW9mIGV4cG9ydHM9PT1cIm9iamVjdFwiKXttb2R1bGUuZXhwb3J0cz1kZWZpbml0aW9uKCk7fWVsc2UgaWYodHlwZW9mIGRlZmluZT09PVwiZnVuY3Rpb25cIiYmZGVmaW5lLmFtZCl7ZGVmaW5lKGRlZmluaXRpb24pO31lbHNle21vcmk9ZGVmaW5pdGlvbigpO319KShmdW5jdGlvbigpe3JldHVybiBmdW5jdGlvbigpe1xuaWYodHlwZW9mIE1hdGguaW11bCA9PSBcInVuZGVmaW5lZFwiIHx8IChNYXRoLmltdWwoMHhmZmZmZmZmZiw1KSA9PSAwKSkge1xuICAgIE1hdGguaW11bCA9IGZ1bmN0aW9uIChhLCBiKSB7XG4gICAgICAgIHZhciBhaCAgPSAoYSA+Pj4gMTYpICYgMHhmZmZmO1xuICAgICAgICB2YXIgYWwgPSBhICYgMHhmZmZmO1xuICAgICAgICB2YXIgYmggID0gKGIgPj4+IDE2KSAmIDB4ZmZmZjtcbiAgICAgICAgdmFyIGJsID0gYiAmIDB4ZmZmZjtcbiAgICAgICAgLy8gdGhlIHNoaWZ0IGJ5IDAgZml4ZXMgdGhlIHNpZ24gb24gdGhlIGhpZ2ggcGFydFxuICAgICAgICAvLyB0aGUgZmluYWwgfDAgY29udmVydHMgdGhlIHVuc2lnbmVkIHZhbHVlIGludG8gYSBzaWduZWQgdmFsdWVcbiAgICAgICAgcmV0dXJuICgoYWwgKiBibCkgKyAoKChhaCAqIGJsICsgYWwgKiBiaCkgPDwgMTYpID4+PiAwKXwwKTtcbiAgICB9XG59XG5cbnZhciBrLGFhPXRoaXM7XG5mdW5jdGlvbiBuKGEpe3ZhciBiPXR5cGVvZiBhO2lmKFwib2JqZWN0XCI9PWIpaWYoYSl7aWYoYSBpbnN0YW5jZW9mIEFycmF5KXJldHVyblwiYXJyYXlcIjtpZihhIGluc3RhbmNlb2YgT2JqZWN0KXJldHVybiBiO3ZhciBjPU9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbChhKTtpZihcIltvYmplY3QgV2luZG93XVwiPT1jKXJldHVyblwib2JqZWN0XCI7aWYoXCJbb2JqZWN0IEFycmF5XVwiPT1jfHxcIm51bWJlclwiPT10eXBlb2YgYS5sZW5ndGgmJlwidW5kZWZpbmVkXCIhPXR5cGVvZiBhLnNwbGljZSYmXCJ1bmRlZmluZWRcIiE9dHlwZW9mIGEucHJvcGVydHlJc0VudW1lcmFibGUmJiFhLnByb3BlcnR5SXNFbnVtZXJhYmxlKFwic3BsaWNlXCIpKXJldHVyblwiYXJyYXlcIjtpZihcIltvYmplY3QgRnVuY3Rpb25dXCI9PWN8fFwidW5kZWZpbmVkXCIhPXR5cGVvZiBhLmNhbGwmJlwidW5kZWZpbmVkXCIhPXR5cGVvZiBhLnByb3BlcnR5SXNFbnVtZXJhYmxlJiYhYS5wcm9wZXJ0eUlzRW51bWVyYWJsZShcImNhbGxcIikpcmV0dXJuXCJmdW5jdGlvblwifWVsc2UgcmV0dXJuXCJudWxsXCI7ZWxzZSBpZihcImZ1bmN0aW9uXCI9PVxuYiYmXCJ1bmRlZmluZWRcIj09dHlwZW9mIGEuY2FsbClyZXR1cm5cIm9iamVjdFwiO3JldHVybiBifXZhciBiYT1cImNsb3N1cmVfdWlkX1wiKygxRTkqTWF0aC5yYW5kb20oKT4+PjApLGNhPTA7ZnVuY3Rpb24gcihhLGIpe3ZhciBjPWEuc3BsaXQoXCIuXCIpLGQ9YWE7Y1swXWluIGR8fCFkLmV4ZWNTY3JpcHR8fGQuZXhlY1NjcmlwdChcInZhciBcIitjWzBdKTtmb3IodmFyIGU7Yy5sZW5ndGgmJihlPWMuc2hpZnQoKSk7KWMubGVuZ3RofHx2b2lkIDA9PT1iP2Q9ZFtlXT9kW2VdOmRbZV09e306ZFtlXT1ifTtmdW5jdGlvbiBkYShhKXtyZXR1cm4gQXJyYXkucHJvdG90eXBlLmpvaW4uY2FsbChhcmd1bWVudHMsXCJcIil9O2Z1bmN0aW9uIGVhKGEsYil7Zm9yKHZhciBjIGluIGEpYi5jYWxsKHZvaWQgMCxhW2NdLGMsYSl9O2Z1bmN0aW9uIGZhKGEsYil7bnVsbCE9YSYmdGhpcy5hcHBlbmQuYXBwbHkodGhpcyxhcmd1bWVudHMpfWZhLnByb3RvdHlwZS5aYT1cIlwiO2ZhLnByb3RvdHlwZS5hcHBlbmQ9ZnVuY3Rpb24oYSxiLGMpe3RoaXMuWmErPWE7aWYobnVsbCE9Yilmb3IodmFyIGQ9MTtkPGFyZ3VtZW50cy5sZW5ndGg7ZCsrKXRoaXMuWmErPWFyZ3VtZW50c1tkXTtyZXR1cm4gdGhpc307ZmEucHJvdG90eXBlLmNsZWFyPWZ1bmN0aW9uKCl7dGhpcy5aYT1cIlwifTtmYS5wcm90b3R5cGUudG9TdHJpbmc9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5aYX07ZnVuY3Rpb24gZ2EoYSxiKXthLnNvcnQoYnx8aGEpfWZ1bmN0aW9uIGlhKGEsYil7Zm9yKHZhciBjPTA7YzxhLmxlbmd0aDtjKyspYVtjXT17aW5kZXg6Yyx2YWx1ZTphW2NdfTt2YXIgZD1ifHxoYTtnYShhLGZ1bmN0aW9uKGEsYil7cmV0dXJuIGQoYS52YWx1ZSxiLnZhbHVlKXx8YS5pbmRleC1iLmluZGV4fSk7Zm9yKGM9MDtjPGEubGVuZ3RoO2MrKylhW2NdPWFbY10udmFsdWV9ZnVuY3Rpb24gaGEoYSxiKXtyZXR1cm4gYT5iPzE6YTxiPy0xOjB9O3ZhciBqYTtpZihcInVuZGVmaW5lZFwiPT09dHlwZW9mIGthKXZhciBrYT1mdW5jdGlvbigpe3Rocm93IEVycm9yKFwiTm8gKnByaW50LWZuKiBmbiBzZXQgZm9yIGV2YWx1YXRpb24gZW52aXJvbm1lbnRcIik7fTt2YXIgbGE9bnVsbCxtYT1udWxsO2lmKFwidW5kZWZpbmVkXCI9PT10eXBlb2YgbmEpdmFyIG5hPW51bGw7ZnVuY3Rpb24gb2EoKXtyZXR1cm4gbmV3IHBhKG51bGwsNSxbc2EsITAsdWEsITAsd2EsITEseWEsITEsemEsbGFdLG51bGwpfWZ1bmN0aW9uIHQoYSl7cmV0dXJuIG51bGwhPWEmJiExIT09YX1mdW5jdGlvbiBBYShhKXtyZXR1cm4gdChhKT8hMTohMH1mdW5jdGlvbiB3KGEsYil7cmV0dXJuIGFbbihudWxsPT1iP251bGw6YildPyEwOmEuXz8hMDohMX1mdW5jdGlvbiBCYShhKXtyZXR1cm4gbnVsbD09YT9udWxsOmEuY29uc3RydWN0b3J9XG5mdW5jdGlvbiB4KGEsYil7dmFyIGM9QmEoYiksYz10KHQoYyk/Yy5ZYjpjKT9jLlhiOm4oYik7cmV0dXJuIEVycm9yKFtcIk5vIHByb3RvY29sIG1ldGhvZCBcIixhLFwiIGRlZmluZWQgZm9yIHR5cGUgXCIsYyxcIjogXCIsYl0uam9pbihcIlwiKSl9ZnVuY3Rpb24gRGEoYSl7dmFyIGI9YS5YYjtyZXR1cm4gdChiKT9iOlwiXCIreihhKX12YXIgRWE9XCJ1bmRlZmluZWRcIiE9PXR5cGVvZiBTeW1ib2wmJlwiZnVuY3Rpb25cIj09PW4oU3ltYm9sKT9TeW1ib2wuQ2M6XCJAQGl0ZXJhdG9yXCI7ZnVuY3Rpb24gRmEoYSl7Zm9yKHZhciBiPWEubGVuZ3RoLGM9QXJyYXkoYiksZD0wOzspaWYoZDxiKWNbZF09YVtkXSxkKz0xO2Vsc2UgYnJlYWs7cmV0dXJuIGN9ZnVuY3Rpb24gSGEoYSl7Zm9yKHZhciBiPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgpLGM9MDs7KWlmKGM8Yi5sZW5ndGgpYltjXT1hcmd1bWVudHNbY10sYys9MTtlbHNlIHJldHVybiBifVxudmFyIElhPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIpe2Z1bmN0aW9uIGMoYSxiKXthLnB1c2goYik7cmV0dXJuIGF9dmFyIGc9W107cmV0dXJuIEEuYz9BLmMoYyxnLGIpOkEuY2FsbChudWxsLGMsZyxiKX1mdW5jdGlvbiBiKGEpe3JldHVybiBjLmEobnVsbCxhKX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oZCxjKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiLmNhbGwodGhpcyxkKTtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLDAsYyl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYj1iO2MuYT1hO3JldHVybiBjfSgpLEphPXt9LExhPXt9O2Z1bmN0aW9uIE1hKGEpe2lmKGE/YS5MOmEpcmV0dXJuIGEuTChhKTt2YXIgYjtiPU1hW24obnVsbD09YT9udWxsOmEpXTtpZighYiYmKGI9TWEuXywhYikpdGhyb3cgeChcIklDb3VudGVkLi1jb3VudFwiLGEpO3JldHVybiBiLmNhbGwobnVsbCxhKX1cbmZ1bmN0aW9uIE5hKGEpe2lmKGE/YS5KOmEpcmV0dXJuIGEuSihhKTt2YXIgYjtiPU5hW24obnVsbD09YT9udWxsOmEpXTtpZighYiYmKGI9TmEuXywhYikpdGhyb3cgeChcIklFbXB0eWFibGVDb2xsZWN0aW9uLi1lbXB0eVwiLGEpO3JldHVybiBiLmNhbGwobnVsbCxhKX12YXIgUWE9e307ZnVuY3Rpb24gUmEoYSxiKXtpZihhP2EuRzphKXJldHVybiBhLkcoYSxiKTt2YXIgYztjPVJhW24obnVsbD09YT9udWxsOmEpXTtpZighYyYmKGM9UmEuXywhYykpdGhyb3cgeChcIklDb2xsZWN0aW9uLi1jb25qXCIsYSk7cmV0dXJuIGMuY2FsbChudWxsLGEsYil9XG52YXIgVGE9e30sQz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMpe2lmKGE/YS4kOmEpcmV0dXJuIGEuJChhLGIsYyk7dmFyIGc7Zz1DW24obnVsbD09YT9udWxsOmEpXTtpZighZyYmKGc9Qy5fLCFnKSl0aHJvdyB4KFwiSUluZGV4ZWQuLW50aFwiLGEpO3JldHVybiBnLmNhbGwobnVsbCxhLGIsYyl9ZnVuY3Rpb24gYihhLGIpe2lmKGE/YS5ROmEpcmV0dXJuIGEuUShhLGIpO3ZhciBjO2M9Q1tuKG51bGw9PWE/bnVsbDphKV07aWYoIWMmJihjPUMuXywhYykpdGhyb3cgeChcIklJbmRleGVkLi1udGhcIixhKTtyZXR1cm4gYy5jYWxsKG51bGwsYSxiKX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oZCxjLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIGIuY2FsbCh0aGlzLGQsYyk7Y2FzZSAzOnJldHVybiBhLmNhbGwodGhpcyxkLGMsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYT1iO2MuYz1hO3JldHVybiBjfSgpLFxuVWE9e307ZnVuY3Rpb24gVmEoYSl7aWYoYT9hLk46YSlyZXR1cm4gYS5OKGEpO3ZhciBiO2I9VmFbbihudWxsPT1hP251bGw6YSldO2lmKCFiJiYoYj1WYS5fLCFiKSl0aHJvdyB4KFwiSVNlcS4tZmlyc3RcIixhKTtyZXR1cm4gYi5jYWxsKG51bGwsYSl9ZnVuY3Rpb24gV2EoYSl7aWYoYT9hLlM6YSlyZXR1cm4gYS5TKGEpO3ZhciBiO2I9V2FbbihudWxsPT1hP251bGw6YSldO2lmKCFiJiYoYj1XYS5fLCFiKSl0aHJvdyB4KFwiSVNlcS4tcmVzdFwiLGEpO3JldHVybiBiLmNhbGwobnVsbCxhKX1cbnZhciBYYT17fSxaYT17fSwkYT1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMpe2lmKGE/YS5zOmEpcmV0dXJuIGEucyhhLGIsYyk7dmFyIGc7Zz0kYVtuKG51bGw9PWE/bnVsbDphKV07aWYoIWcmJihnPSRhLl8sIWcpKXRocm93IHgoXCJJTG9va3VwLi1sb29rdXBcIixhKTtyZXR1cm4gZy5jYWxsKG51bGwsYSxiLGMpfWZ1bmN0aW9uIGIoYSxiKXtpZihhP2EudDphKXJldHVybiBhLnQoYSxiKTt2YXIgYztjPSRhW24obnVsbD09YT9udWxsOmEpXTtpZighYyYmKGM9JGEuXywhYykpdGhyb3cgeChcIklMb29rdXAuLWxvb2t1cFwiLGEpO3JldHVybiBjLmNhbGwobnVsbCxhLGIpfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gYi5jYWxsKHRoaXMsYyxlKTtjYXNlIDM6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSxmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5hPWI7Yy5jPVxuYTtyZXR1cm4gY30oKSxhYj17fTtmdW5jdGlvbiBiYihhLGIpe2lmKGE/YS5yYjphKXJldHVybiBhLnJiKGEsYik7dmFyIGM7Yz1iYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWMmJihjPWJiLl8sIWMpKXRocm93IHgoXCJJQXNzb2NpYXRpdmUuLWNvbnRhaW5zLWtleT9cIixhKTtyZXR1cm4gYy5jYWxsKG51bGwsYSxiKX1mdW5jdGlvbiBjYihhLGIsYyl7aWYoYT9hLkthOmEpcmV0dXJuIGEuS2EoYSxiLGMpO3ZhciBkO2Q9Y2JbbihudWxsPT1hP251bGw6YSldO2lmKCFkJiYoZD1jYi5fLCFkKSl0aHJvdyB4KFwiSUFzc29jaWF0aXZlLi1hc3NvY1wiLGEpO3JldHVybiBkLmNhbGwobnVsbCxhLGIsYyl9dmFyIGRiPXt9O2Z1bmN0aW9uIGViKGEsYil7aWYoYT9hLndiOmEpcmV0dXJuIGEud2IoYSxiKTt2YXIgYztjPWViW24obnVsbD09YT9udWxsOmEpXTtpZighYyYmKGM9ZWIuXywhYykpdGhyb3cgeChcIklNYXAuLWRpc3NvY1wiLGEpO3JldHVybiBjLmNhbGwobnVsbCxhLGIpfXZhciBmYj17fTtcbmZ1bmN0aW9uIGhiKGEpe2lmKGE/YS5oYjphKXJldHVybiBhLmhiKGEpO3ZhciBiO2I9aGJbbihudWxsPT1hP251bGw6YSldO2lmKCFiJiYoYj1oYi5fLCFiKSl0aHJvdyB4KFwiSU1hcEVudHJ5Li1rZXlcIixhKTtyZXR1cm4gYi5jYWxsKG51bGwsYSl9ZnVuY3Rpb24gaWIoYSl7aWYoYT9hLmliOmEpcmV0dXJuIGEuaWIoYSk7dmFyIGI7Yj1pYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWImJihiPWliLl8sIWIpKXRocm93IHgoXCJJTWFwRW50cnkuLXZhbFwiLGEpO3JldHVybiBiLmNhbGwobnVsbCxhKX12YXIgamI9e307ZnVuY3Rpb24ga2IoYSxiKXtpZihhP2EuRWI6YSlyZXR1cm4gYS5FYihhLGIpO3ZhciBjO2M9a2JbbihudWxsPT1hP251bGw6YSldO2lmKCFjJiYoYz1rYi5fLCFjKSl0aHJvdyB4KFwiSVNldC4tZGlzam9pblwiLGEpO3JldHVybiBjLmNhbGwobnVsbCxhLGIpfVxuZnVuY3Rpb24gbGIoYSl7aWYoYT9hLkxhOmEpcmV0dXJuIGEuTGEoYSk7dmFyIGI7Yj1sYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWImJihiPWxiLl8sIWIpKXRocm93IHgoXCJJU3RhY2suLXBlZWtcIixhKTtyZXR1cm4gYi5jYWxsKG51bGwsYSl9ZnVuY3Rpb24gbWIoYSl7aWYoYT9hLk1hOmEpcmV0dXJuIGEuTWEoYSk7dmFyIGI7Yj1tYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWImJihiPW1iLl8sIWIpKXRocm93IHgoXCJJU3RhY2suLXBvcFwiLGEpO3JldHVybiBiLmNhbGwobnVsbCxhKX12YXIgbmI9e307ZnVuY3Rpb24gcGIoYSxiLGMpe2lmKGE/YS5VYTphKXJldHVybiBhLlVhKGEsYixjKTt2YXIgZDtkPXBiW24obnVsbD09YT9udWxsOmEpXTtpZighZCYmKGQ9cGIuXywhZCkpdGhyb3cgeChcIklWZWN0b3IuLWFzc29jLW5cIixhKTtyZXR1cm4gZC5jYWxsKG51bGwsYSxiLGMpfVxuZnVuY3Rpb24gcWIoYSl7aWYoYT9hLlJhOmEpcmV0dXJuIGEuUmEoYSk7dmFyIGI7Yj1xYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWImJihiPXFiLl8sIWIpKXRocm93IHgoXCJJRGVyZWYuLWRlcmVmXCIsYSk7cmV0dXJuIGIuY2FsbChudWxsLGEpfXZhciByYj17fTtmdW5jdGlvbiBzYihhKXtpZihhP2EuSDphKXJldHVybiBhLkgoYSk7dmFyIGI7Yj1zYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWImJihiPXNiLl8sIWIpKXRocm93IHgoXCJJTWV0YS4tbWV0YVwiLGEpO3JldHVybiBiLmNhbGwobnVsbCxhKX12YXIgdGI9e307ZnVuY3Rpb24gdWIoYSxiKXtpZihhP2EuRjphKXJldHVybiBhLkYoYSxiKTt2YXIgYztjPXViW24obnVsbD09YT9udWxsOmEpXTtpZighYyYmKGM9dWIuXywhYykpdGhyb3cgeChcIklXaXRoTWV0YS4td2l0aC1tZXRhXCIsYSk7cmV0dXJuIGMuY2FsbChudWxsLGEsYil9XG52YXIgdmI9e30sd2I9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjKXtpZihhP2EuTzphKXJldHVybiBhLk8oYSxiLGMpO3ZhciBnO2c9d2JbbihudWxsPT1hP251bGw6YSldO2lmKCFnJiYoZz13Yi5fLCFnKSl0aHJvdyB4KFwiSVJlZHVjZS4tcmVkdWNlXCIsYSk7cmV0dXJuIGcuY2FsbChudWxsLGEsYixjKX1mdW5jdGlvbiBiKGEsYil7aWYoYT9hLlI6YSlyZXR1cm4gYS5SKGEsYik7dmFyIGM7Yz13YltuKG51bGw9PWE/bnVsbDphKV07aWYoIWMmJihjPXdiLl8sIWMpKXRocm93IHgoXCJJUmVkdWNlLi1yZWR1Y2VcIixhKTtyZXR1cm4gYy5jYWxsKG51bGwsYSxiKX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIGIuY2FsbCh0aGlzLGMsZSk7Y2FzZSAzOnJldHVybiBhLmNhbGwodGhpcyxjLGUsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYT1iO2MuYz1hO3JldHVybiBjfSgpO1xuZnVuY3Rpb24geGIoYSxiLGMpe2lmKGE/YS5nYjphKXJldHVybiBhLmdiKGEsYixjKTt2YXIgZDtkPXhiW24obnVsbD09YT9udWxsOmEpXTtpZighZCYmKGQ9eGIuXywhZCkpdGhyb3cgeChcIklLVlJlZHVjZS4ta3YtcmVkdWNlXCIsYSk7cmV0dXJuIGQuY2FsbChudWxsLGEsYixjKX1mdW5jdGlvbiB5YihhLGIpe2lmKGE/YS5BOmEpcmV0dXJuIGEuQShhLGIpO3ZhciBjO2M9eWJbbihudWxsPT1hP251bGw6YSldO2lmKCFjJiYoYz15Yi5fLCFjKSl0aHJvdyB4KFwiSUVxdWl2Li1lcXVpdlwiLGEpO3JldHVybiBjLmNhbGwobnVsbCxhLGIpfWZ1bmN0aW9uIHpiKGEpe2lmKGE/YS5COmEpcmV0dXJuIGEuQihhKTt2YXIgYjtiPXpiW24obnVsbD09YT9udWxsOmEpXTtpZighYiYmKGI9emIuXywhYikpdGhyb3cgeChcIklIYXNoLi1oYXNoXCIsYSk7cmV0dXJuIGIuY2FsbChudWxsLGEpfXZhciBCYj17fTtcbmZ1bmN0aW9uIENiKGEpe2lmKGE/YS5EOmEpcmV0dXJuIGEuRChhKTt2YXIgYjtiPUNiW24obnVsbD09YT9udWxsOmEpXTtpZighYiYmKGI9Q2IuXywhYikpdGhyb3cgeChcIklTZXFhYmxlLi1zZXFcIixhKTtyZXR1cm4gYi5jYWxsKG51bGwsYSl9dmFyIERiPXt9LEViPXt9LEZiPXt9O2Z1bmN0aW9uIEdiKGEpe2lmKGE/YS5hYjphKXJldHVybiBhLmFiKGEpO3ZhciBiO2I9R2JbbihudWxsPT1hP251bGw6YSldO2lmKCFiJiYoYj1HYi5fLCFiKSl0aHJvdyB4KFwiSVJldmVyc2libGUuLXJzZXFcIixhKTtyZXR1cm4gYi5jYWxsKG51bGwsYSl9ZnVuY3Rpb24gSGIoYSxiKXtpZihhP2EuSGI6YSlyZXR1cm4gYS5IYihhLGIpO3ZhciBjO2M9SGJbbihudWxsPT1hP251bGw6YSldO2lmKCFjJiYoYz1IYi5fLCFjKSl0aHJvdyB4KFwiSVNvcnRlZC4tc29ydGVkLXNlcVwiLGEpO3JldHVybiBjLmNhbGwobnVsbCxhLGIpfVxuZnVuY3Rpb24gSWIoYSxiLGMpe2lmKGE/YS5JYjphKXJldHVybiBhLkliKGEsYixjKTt2YXIgZDtkPUliW24obnVsbD09YT9udWxsOmEpXTtpZighZCYmKGQ9SWIuXywhZCkpdGhyb3cgeChcIklTb3J0ZWQuLXNvcnRlZC1zZXEtZnJvbVwiLGEpO3JldHVybiBkLmNhbGwobnVsbCxhLGIsYyl9ZnVuY3Rpb24gSmIoYSxiKXtpZihhP2EuR2I6YSlyZXR1cm4gYS5HYihhLGIpO3ZhciBjO2M9SmJbbihudWxsPT1hP251bGw6YSldO2lmKCFjJiYoYz1KYi5fLCFjKSl0aHJvdyB4KFwiSVNvcnRlZC4tZW50cnkta2V5XCIsYSk7cmV0dXJuIGMuY2FsbChudWxsLGEsYil9ZnVuY3Rpb24gS2IoYSl7aWYoYT9hLkZiOmEpcmV0dXJuIGEuRmIoYSk7dmFyIGI7Yj1LYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWImJihiPUtiLl8sIWIpKXRocm93IHgoXCJJU29ydGVkLi1jb21wYXJhdG9yXCIsYSk7cmV0dXJuIGIuY2FsbChudWxsLGEpfVxuZnVuY3Rpb24gTGIoYSxiKXtpZihhP2EuV2I6YSlyZXR1cm4gYS5XYigwLGIpO3ZhciBjO2M9TGJbbihudWxsPT1hP251bGw6YSldO2lmKCFjJiYoYz1MYi5fLCFjKSl0aHJvdyB4KFwiSVdyaXRlci4td3JpdGVcIixhKTtyZXR1cm4gYy5jYWxsKG51bGwsYSxiKX12YXIgTWI9e307ZnVuY3Rpb24gTmIoYSxiLGMpe2lmKGE/YS52OmEpcmV0dXJuIGEudihhLGIsYyk7dmFyIGQ7ZD1OYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWQmJihkPU5iLl8sIWQpKXRocm93IHgoXCJJUHJpbnRXaXRoV3JpdGVyLi1wci13cml0ZXJcIixhKTtyZXR1cm4gZC5jYWxsKG51bGwsYSxiLGMpfWZ1bmN0aW9uIE9iKGEpe2lmKGE/YS4kYTphKXJldHVybiBhLiRhKGEpO3ZhciBiO2I9T2JbbihudWxsPT1hP251bGw6YSldO2lmKCFiJiYoYj1PYi5fLCFiKSl0aHJvdyB4KFwiSUVkaXRhYmxlQ29sbGVjdGlvbi4tYXMtdHJhbnNpZW50XCIsYSk7cmV0dXJuIGIuY2FsbChudWxsLGEpfVxuZnVuY3Rpb24gUGIoYSxiKXtpZihhP2EuU2E6YSlyZXR1cm4gYS5TYShhLGIpO3ZhciBjO2M9UGJbbihudWxsPT1hP251bGw6YSldO2lmKCFjJiYoYz1QYi5fLCFjKSl0aHJvdyB4KFwiSVRyYW5zaWVudENvbGxlY3Rpb24uLWNvbmohXCIsYSk7cmV0dXJuIGMuY2FsbChudWxsLGEsYil9ZnVuY3Rpb24gUWIoYSl7aWYoYT9hLlRhOmEpcmV0dXJuIGEuVGEoYSk7dmFyIGI7Yj1RYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWImJihiPVFiLl8sIWIpKXRocm93IHgoXCJJVHJhbnNpZW50Q29sbGVjdGlvbi4tcGVyc2lzdGVudCFcIixhKTtyZXR1cm4gYi5jYWxsKG51bGwsYSl9ZnVuY3Rpb24gUmIoYSxiLGMpe2lmKGE/YS5rYjphKXJldHVybiBhLmtiKGEsYixjKTt2YXIgZDtkPVJiW24obnVsbD09YT9udWxsOmEpXTtpZighZCYmKGQ9UmIuXywhZCkpdGhyb3cgeChcIklUcmFuc2llbnRBc3NvY2lhdGl2ZS4tYXNzb2MhXCIsYSk7cmV0dXJuIGQuY2FsbChudWxsLGEsYixjKX1cbmZ1bmN0aW9uIFNiKGEsYil7aWYoYT9hLkpiOmEpcmV0dXJuIGEuSmIoYSxiKTt2YXIgYztjPVNiW24obnVsbD09YT9udWxsOmEpXTtpZighYyYmKGM9U2IuXywhYykpdGhyb3cgeChcIklUcmFuc2llbnRNYXAuLWRpc3NvYyFcIixhKTtyZXR1cm4gYy5jYWxsKG51bGwsYSxiKX1mdW5jdGlvbiBUYihhLGIsYyl7aWYoYT9hLlViOmEpcmV0dXJuIGEuVWIoMCxiLGMpO3ZhciBkO2Q9VGJbbihudWxsPT1hP251bGw6YSldO2lmKCFkJiYoZD1UYi5fLCFkKSl0aHJvdyB4KFwiSVRyYW5zaWVudFZlY3Rvci4tYXNzb2MtbiFcIixhKTtyZXR1cm4gZC5jYWxsKG51bGwsYSxiLGMpfWZ1bmN0aW9uIFViKGEpe2lmKGE/YS5WYjphKXJldHVybiBhLlZiKCk7dmFyIGI7Yj1VYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWImJihiPVViLl8sIWIpKXRocm93IHgoXCJJVHJhbnNpZW50VmVjdG9yLi1wb3AhXCIsYSk7cmV0dXJuIGIuY2FsbChudWxsLGEpfVxuZnVuY3Rpb24gVmIoYSxiKXtpZihhP2EuVGI6YSlyZXR1cm4gYS5UYigwLGIpO3ZhciBjO2M9VmJbbihudWxsPT1hP251bGw6YSldO2lmKCFjJiYoYz1WYi5fLCFjKSl0aHJvdyB4KFwiSVRyYW5zaWVudFNldC4tZGlzam9pbiFcIixhKTtyZXR1cm4gYy5jYWxsKG51bGwsYSxiKX1mdW5jdGlvbiBYYihhKXtpZihhP2EuUGI6YSlyZXR1cm4gYS5QYigpO3ZhciBiO2I9WGJbbihudWxsPT1hP251bGw6YSldO2lmKCFiJiYoYj1YYi5fLCFiKSl0aHJvdyB4KFwiSUNodW5rLi1kcm9wLWZpcnN0XCIsYSk7cmV0dXJuIGIuY2FsbChudWxsLGEpfWZ1bmN0aW9uIFliKGEpe2lmKGE/YS5DYjphKXJldHVybiBhLkNiKGEpO3ZhciBiO2I9WWJbbihudWxsPT1hP251bGw6YSldO2lmKCFiJiYoYj1ZYi5fLCFiKSl0aHJvdyB4KFwiSUNodW5rZWRTZXEuLWNodW5rZWQtZmlyc3RcIixhKTtyZXR1cm4gYi5jYWxsKG51bGwsYSl9XG5mdW5jdGlvbiBaYihhKXtpZihhP2EuRGI6YSlyZXR1cm4gYS5EYihhKTt2YXIgYjtiPVpiW24obnVsbD09YT9udWxsOmEpXTtpZighYiYmKGI9WmIuXywhYikpdGhyb3cgeChcIklDaHVua2VkU2VxLi1jaHVua2VkLXJlc3RcIixhKTtyZXR1cm4gYi5jYWxsKG51bGwsYSl9ZnVuY3Rpb24gJGIoYSl7aWYoYT9hLkJiOmEpcmV0dXJuIGEuQmIoYSk7dmFyIGI7Yj0kYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWImJihiPSRiLl8sIWIpKXRocm93IHgoXCJJQ2h1bmtlZE5leHQuLWNodW5rZWQtbmV4dFwiLGEpO3JldHVybiBiLmNhbGwobnVsbCxhKX1mdW5jdGlvbiBhYyhhLGIpe2lmKGE/YS5iYjphKXJldHVybiBhLmJiKDAsYik7dmFyIGM7Yz1hY1tuKG51bGw9PWE/bnVsbDphKV07aWYoIWMmJihjPWFjLl8sIWMpKXRocm93IHgoXCJJVm9sYXRpbGUuLXZyZXNldCFcIixhKTtyZXR1cm4gYy5jYWxsKG51bGwsYSxiKX12YXIgYmM9e307XG5mdW5jdGlvbiBjYyhhKXtpZihhP2EuZmI6YSlyZXR1cm4gYS5mYihhKTt2YXIgYjtiPWNjW24obnVsbD09YT9udWxsOmEpXTtpZighYiYmKGI9Y2MuXywhYikpdGhyb3cgeChcIklJdGVyYWJsZS4taXRlcmF0b3JcIixhKTtyZXR1cm4gYi5jYWxsKG51bGwsYSl9ZnVuY3Rpb24gZGMoYSl7dGhpcy5xYz1hO3RoaXMucT0wO3RoaXMuaj0xMDczNzQxODI0fWRjLnByb3RvdHlwZS5XYj1mdW5jdGlvbihhLGIpe3JldHVybiB0aGlzLnFjLmFwcGVuZChiKX07ZnVuY3Rpb24gZWMoYSl7dmFyIGI9bmV3IGZhO2EudihudWxsLG5ldyBkYyhiKSxvYSgpKTtyZXR1cm5cIlwiK3ooYil9XG52YXIgZmM9XCJ1bmRlZmluZWRcIiE9PXR5cGVvZiBNYXRoLmltdWwmJjAhPT0oTWF0aC5pbXVsLmE/TWF0aC5pbXVsLmEoNDI5NDk2NzI5NSw1KTpNYXRoLmltdWwuY2FsbChudWxsLDQyOTQ5NjcyOTUsNSkpP2Z1bmN0aW9uKGEsYil7cmV0dXJuIE1hdGguaW11bC5hP01hdGguaW11bC5hKGEsYik6TWF0aC5pbXVsLmNhbGwobnVsbCxhLGIpfTpmdW5jdGlvbihhLGIpe3ZhciBjPWEmNjU1MzUsZD1iJjY1NTM1O3JldHVybiBjKmQrKChhPj4+MTYmNjU1MzUpKmQrYyooYj4+PjE2JjY1NTM1KTw8MTY+Pj4wKXwwfTtmdW5jdGlvbiBnYyhhKXthPWZjKGEsMzQzMjkxODM1Myk7cmV0dXJuIGZjKGE8PDE1fGE+Pj4tMTUsNDYxODQ1OTA3KX1mdW5jdGlvbiBoYyhhLGIpe3ZhciBjPWFeYjtyZXR1cm4gZmMoYzw8MTN8Yz4+Pi0xMyw1KSszODY0MjkyMTk2fVxuZnVuY3Rpb24gaWMoYSxiKXt2YXIgYz1hXmIsYz1mYyhjXmM+Pj4xNiwyMjQ2ODIyNTA3KSxjPWZjKGNeYz4+PjEzLDMyNjY0ODk5MDkpO3JldHVybiBjXmM+Pj4xNn12YXIga2M9e30sbGM9MDtmdW5jdGlvbiBtYyhhKXsyNTU8bGMmJihrYz17fSxsYz0wKTt2YXIgYj1rY1thXTtpZihcIm51bWJlclwiIT09dHlwZW9mIGIpe2E6aWYobnVsbCE9YSlpZihiPWEubGVuZ3RoLDA8Yil7Zm9yKHZhciBjPTAsZD0wOzspaWYoYzxiKXZhciBlPWMrMSxkPWZjKDMxLGQpK2EuY2hhckNvZGVBdChjKSxjPWU7ZWxzZXtiPWQ7YnJlYWsgYX1iPXZvaWQgMH1lbHNlIGI9MDtlbHNlIGI9MDtrY1thXT1iO2xjKz0xfXJldHVybiBhPWJ9XG5mdW5jdGlvbiBuYyhhKXthJiYoYS5qJjQxOTQzMDR8fGEudmMpP2E9YS5CKG51bGwpOlwibnVtYmVyXCI9PT10eXBlb2YgYT9hPShNYXRoLmZsb29yLmI/TWF0aC5mbG9vci5iKGEpOk1hdGguZmxvb3IuY2FsbChudWxsLGEpKSUyMTQ3NDgzNjQ3OiEwPT09YT9hPTE6ITE9PT1hP2E9MDpcInN0cmluZ1wiPT09dHlwZW9mIGE/KGE9bWMoYSksMCE9PWEmJihhPWdjKGEpLGE9aGMoMCxhKSxhPWljKGEsNCkpKTphPWEgaW5zdGFuY2VvZiBEYXRlP2EudmFsdWVPZigpOm51bGw9PWE/MDp6YihhKTtyZXR1cm4gYX1cbmZ1bmN0aW9uIG9jKGEpe3ZhciBiO2I9YS5uYW1lO3ZhciBjO2E6e2M9MTtmb3IodmFyIGQ9MDs7KWlmKGM8Yi5sZW5ndGgpe3ZhciBlPWMrMixkPWhjKGQsZ2MoYi5jaGFyQ29kZUF0KGMtMSl8Yi5jaGFyQ29kZUF0KGMpPDwxNikpO2M9ZX1lbHNle2M9ZDticmVhayBhfWM9dm9pZCAwfWM9MT09PShiLmxlbmd0aCYxKT9jXmdjKGIuY2hhckNvZGVBdChiLmxlbmd0aC0xKSk6YztiPWljKGMsZmMoMixiLmxlbmd0aCkpO2E9bWMoYS5iYSk7cmV0dXJuIGJeYSsyNjU0NDM1NzY5KyhiPDw2KSsoYj4+Mil9ZnVuY3Rpb24gcGMoYSxiKXtpZihhLnRhPT09Yi50YSlyZXR1cm4gMDt2YXIgYz1BYShhLmJhKTtpZih0KGM/Yi5iYTpjKSlyZXR1cm4tMTtpZih0KGEuYmEpKXtpZihBYShiLmJhKSlyZXR1cm4gMTtjPWhhKGEuYmEsYi5iYSk7cmV0dXJuIDA9PT1jP2hhKGEubmFtZSxiLm5hbWUpOmN9cmV0dXJuIGhhKGEubmFtZSxiLm5hbWUpfVxuZnVuY3Rpb24gcWMoYSxiLGMsZCxlKXt0aGlzLmJhPWE7dGhpcy5uYW1lPWI7dGhpcy50YT1jO3RoaXMuWWE9ZDt0aGlzLlo9ZTt0aGlzLmo9MjE1NDE2ODMyMTt0aGlzLnE9NDA5Nn1rPXFjLnByb3RvdHlwZTtrLnY9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gTGIoYix0aGlzLnRhKX07ay5CPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5ZYTtyZXR1cm4gbnVsbCE9YT9hOnRoaXMuWWE9YT1vYyh0aGlzKX07ay5GPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyBxYyh0aGlzLmJhLHRoaXMubmFtZSx0aGlzLnRhLHRoaXMuWWEsYil9O2suSD1mdW5jdGlvbigpe3JldHVybiB0aGlzLlp9O1xuay5jYWxsPWZ1bmN0aW9uKCl7dmFyIGE9bnVsbCxhPWZ1bmN0aW9uKGEsYyxkKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiAkYS5jKGMsdGhpcyxudWxsKTtjYXNlIDM6cmV0dXJuICRhLmMoYyx0aGlzLGQpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTthLmE9ZnVuY3Rpb24oYSxjKXtyZXR1cm4gJGEuYyhjLHRoaXMsbnVsbCl9O2EuYz1mdW5jdGlvbihhLGMsZCl7cmV0dXJuICRhLmMoYyx0aGlzLGQpfTtyZXR1cm4gYX0oKTtrLmFwcGx5PWZ1bmN0aW9uKGEsYil7cmV0dXJuIHRoaXMuY2FsbC5hcHBseSh0aGlzLFt0aGlzXS5jb25jYXQoRmEoYikpKX07ay5iPWZ1bmN0aW9uKGEpe3JldHVybiAkYS5jKGEsdGhpcyxudWxsKX07ay5hPWZ1bmN0aW9uKGEsYil7cmV0dXJuICRhLmMoYSx0aGlzLGIpfTtrLkE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gYiBpbnN0YW5jZW9mIHFjP3RoaXMudGE9PT1iLnRhOiExfTtcbmsudG9TdHJpbmc9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy50YX07dmFyIHJjPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIpe3ZhciBjPW51bGwhPWE/W3ooYSkseihcIi9cIikseihiKV0uam9pbihcIlwiKTpiO3JldHVybiBuZXcgcWMoYSxiLGMsbnVsbCxudWxsKX1mdW5jdGlvbiBiKGEpe3JldHVybiBhIGluc3RhbmNlb2YgcWM/YTpjLmEobnVsbCxhKX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiLmNhbGwodGhpcyxjKTtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYj1iO2MuYT1hO3JldHVybiBjfSgpO1xuZnVuY3Rpb24gRChhKXtpZihudWxsPT1hKXJldHVybiBudWxsO2lmKGEmJihhLmomODM4ODYwOHx8YS5tYykpcmV0dXJuIGEuRChudWxsKTtpZihhIGluc3RhbmNlb2YgQXJyYXl8fFwic3RyaW5nXCI9PT10eXBlb2YgYSlyZXR1cm4gMD09PWEubGVuZ3RoP251bGw6bmV3IEYoYSwwKTtpZih3KEJiLGEpKXJldHVybiBDYihhKTt0aHJvdyBFcnJvcihbeihhKSx6KFwiIGlzIG5vdCBJU2VxYWJsZVwiKV0uam9pbihcIlwiKSk7fWZ1bmN0aW9uIEcoYSl7aWYobnVsbD09YSlyZXR1cm4gbnVsbDtpZihhJiYoYS5qJjY0fHxhLmpiKSlyZXR1cm4gYS5OKG51bGwpO2E9RChhKTtyZXR1cm4gbnVsbD09YT9udWxsOlZhKGEpfWZ1bmN0aW9uIEgoYSl7cmV0dXJuIG51bGwhPWE/YSYmKGEuaiY2NHx8YS5qYik/YS5TKG51bGwpOihhPUQoYSkpP1dhKGEpOko6Sn1mdW5jdGlvbiBLKGEpe3JldHVybiBudWxsPT1hP251bGw6YSYmKGEuaiYxMjh8fGEueGIpP2EuVChudWxsKTpEKEgoYSkpfVxudmFyIHNjPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIpe3JldHVybiBudWxsPT1hP251bGw9PWI6YT09PWJ8fHliKGEsYil9dmFyIGI9bnVsbCxjPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShiLGQsaCl7dmFyIGw9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgbD0wLG09QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtsPG0ubGVuZ3RoOyltW2xdPWFyZ3VtZW50c1tsKzJdLCsrbDtsPW5ldyBGKG0sMCl9cmV0dXJuIGMuY2FsbCh0aGlzLGIsZCxsKX1mdW5jdGlvbiBjKGEsZCxlKXtmb3IoOzspaWYoYi5hKGEsZCkpaWYoSyhlKSlhPWQsZD1HKGUpLGU9SyhlKTtlbHNlIHJldHVybiBiLmEoZCxHKGUpKTtlbHNlIHJldHVybiExfWEuaT0yO2EuZj1mdW5jdGlvbihhKXt2YXIgYj1HKGEpO2E9SyhhKTt2YXIgZD1HKGEpO2E9SChhKTtyZXR1cm4gYyhiLGQsYSl9O2EuZD1jO3JldHVybiBhfSgpLGI9ZnVuY3Rpb24oYixlLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuITA7XG5jYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGIsZSk7ZGVmYXVsdDp2YXIgZz1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBnPTAsaD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2c8aC5sZW5ndGg7KWhbZ109YXJndW1lbnRzW2crMl0sKytnO2c9bmV3IEYoaCwwKX1yZXR1cm4gYy5kKGIsZSxnKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yi5pPTI7Yi5mPWMuZjtiLmI9ZnVuY3Rpb24oKXtyZXR1cm4hMH07Yi5hPWE7Yi5kPWMuZDtyZXR1cm4gYn0oKTtmdW5jdGlvbiB0YyhhKXt0aGlzLkM9YX10Yy5wcm90b3R5cGUubmV4dD1mdW5jdGlvbigpe2lmKG51bGwhPXRoaXMuQyl7dmFyIGE9Ryh0aGlzLkMpO3RoaXMuQz1LKHRoaXMuQyk7cmV0dXJue2RvbmU6ITEsdmFsdWU6YX19cmV0dXJue2RvbmU6ITAsdmFsdWU6bnVsbH19O2Z1bmN0aW9uIHVjKGEpe3JldHVybiBuZXcgdGMoRChhKSl9XG5mdW5jdGlvbiB2YyhhLGIpe3ZhciBjPWdjKGEpLGM9aGMoMCxjKTtyZXR1cm4gaWMoYyxiKX1mdW5jdGlvbiB3YyhhKXt2YXIgYj0wLGM9MTtmb3IoYT1EKGEpOzspaWYobnVsbCE9YSliKz0xLGM9ZmMoMzEsYykrbmMoRyhhKSl8MCxhPUsoYSk7ZWxzZSByZXR1cm4gdmMoYyxiKX1mdW5jdGlvbiB4YyhhKXt2YXIgYj0wLGM9MDtmb3IoYT1EKGEpOzspaWYobnVsbCE9YSliKz0xLGM9YytuYyhHKGEpKXwwLGE9SyhhKTtlbHNlIHJldHVybiB2YyhjLGIpfUxhW1wibnVsbFwiXT0hMDtNYVtcIm51bGxcIl09ZnVuY3Rpb24oKXtyZXR1cm4gMH07RGF0ZS5wcm90b3R5cGUuQT1mdW5jdGlvbihhLGIpe3JldHVybiBiIGluc3RhbmNlb2YgRGF0ZSYmdGhpcy50b1N0cmluZygpPT09Yi50b1N0cmluZygpfTt5Yi5udW1iZXI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gYT09PWJ9O3JiW1wiZnVuY3Rpb25cIl09ITA7c2JbXCJmdW5jdGlvblwiXT1mdW5jdGlvbigpe3JldHVybiBudWxsfTtcbkphW1wiZnVuY3Rpb25cIl09ITA7emIuXz1mdW5jdGlvbihhKXtyZXR1cm4gYVtiYV18fChhW2JhXT0rK2NhKX07ZnVuY3Rpb24geWMoYSl7dGhpcy5vPWE7dGhpcy5xPTA7dGhpcy5qPTMyNzY4fXljLnByb3RvdHlwZS5SYT1mdW5jdGlvbigpe3JldHVybiB0aGlzLm99O2Z1bmN0aW9uIEFjKGEpe3JldHVybiBhIGluc3RhbmNlb2YgeWN9ZnVuY3Rpb24gQmMoYSl7cmV0dXJuIEFjKGEpP0wuYj9MLmIoYSk6TC5jYWxsKG51bGwsYSk6YX1mdW5jdGlvbiBMKGEpe3JldHVybiBxYihhKX1cbnZhciBDYz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMsZCl7Zm9yKHZhciBsPU1hKGEpOzspaWYoZDxsKXt2YXIgbT1DLmEoYSxkKTtjPWIuYT9iLmEoYyxtKTpiLmNhbGwobnVsbCxjLG0pO2lmKEFjKGMpKXJldHVybiBxYihjKTtkKz0xfWVsc2UgcmV0dXJuIGN9ZnVuY3Rpb24gYihhLGIsYyl7dmFyIGQ9TWEoYSksbD1jO2ZvcihjPTA7OylpZihjPGQpe3ZhciBtPUMuYShhLGMpLGw9Yi5hP2IuYShsLG0pOmIuY2FsbChudWxsLGwsbSk7aWYoQWMobCkpcmV0dXJuIHFiKGwpO2MrPTF9ZWxzZSByZXR1cm4gbH1mdW5jdGlvbiBjKGEsYil7dmFyIGM9TWEoYSk7aWYoMD09PWMpcmV0dXJuIGIubD9iLmwoKTpiLmNhbGwobnVsbCk7Zm9yKHZhciBkPUMuYShhLDApLGw9MTs7KWlmKGw8Yyl7dmFyIG09Qy5hKGEsbCksZD1iLmE/Yi5hKGQsbSk6Yi5jYWxsKG51bGwsZCxtKTtpZihBYyhkKSlyZXR1cm4gcWIoZCk7bCs9MX1lbHNlIHJldHVybiBkfXZhciBkPW51bGwsZD1mdW5jdGlvbihkLFxuZixnLGgpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIGMuY2FsbCh0aGlzLGQsZik7Y2FzZSAzOnJldHVybiBiLmNhbGwodGhpcyxkLGYsZyk7Y2FzZSA0OnJldHVybiBhLmNhbGwodGhpcyxkLGYsZyxoKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307ZC5hPWM7ZC5jPWI7ZC5uPWE7cmV0dXJuIGR9KCksRGM9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjLGQpe2Zvcih2YXIgbD1hLmxlbmd0aDs7KWlmKGQ8bCl7dmFyIG09YVtkXTtjPWIuYT9iLmEoYyxtKTpiLmNhbGwobnVsbCxjLG0pO2lmKEFjKGMpKXJldHVybiBxYihjKTtkKz0xfWVsc2UgcmV0dXJuIGN9ZnVuY3Rpb24gYihhLGIsYyl7dmFyIGQ9YS5sZW5ndGgsbD1jO2ZvcihjPTA7OylpZihjPGQpe3ZhciBtPWFbY10sbD1iLmE/Yi5hKGwsbSk6Yi5jYWxsKG51bGwsbCxtKTtpZihBYyhsKSlyZXR1cm4gcWIobCk7Yys9MX1lbHNlIHJldHVybiBsfWZ1bmN0aW9uIGMoYSxcbmIpe3ZhciBjPWEubGVuZ3RoO2lmKDA9PT1hLmxlbmd0aClyZXR1cm4gYi5sP2IubCgpOmIuY2FsbChudWxsKTtmb3IodmFyIGQ9YVswXSxsPTE7OylpZihsPGMpe3ZhciBtPWFbbF0sZD1iLmE/Yi5hKGQsbSk6Yi5jYWxsKG51bGwsZCxtKTtpZihBYyhkKSlyZXR1cm4gcWIoZCk7bCs9MX1lbHNlIHJldHVybiBkfXZhciBkPW51bGwsZD1mdW5jdGlvbihkLGYsZyxoKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiBjLmNhbGwodGhpcyxkLGYpO2Nhc2UgMzpyZXR1cm4gYi5jYWxsKHRoaXMsZCxmLGcpO2Nhc2UgNDpyZXR1cm4gYS5jYWxsKHRoaXMsZCxmLGcsaCl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2QuYT1jO2QuYz1iO2Qubj1hO3JldHVybiBkfSgpO2Z1bmN0aW9uIEVjKGEpe3JldHVybiBhP2EuaiYyfHxhLmNjPyEwOmEuaj8hMTp3KExhLGEpOncoTGEsYSl9XG5mdW5jdGlvbiBGYyhhKXtyZXR1cm4gYT9hLmomMTZ8fGEuUWI/ITA6YS5qPyExOncoVGEsYSk6dyhUYSxhKX1mdW5jdGlvbiBHYyhhLGIpe3RoaXMuZT1hO3RoaXMubT1ifUdjLnByb3RvdHlwZS5nYT1mdW5jdGlvbigpe3JldHVybiB0aGlzLm08dGhpcy5lLmxlbmd0aH07R2MucHJvdG90eXBlLm5leHQ9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLmVbdGhpcy5tXTt0aGlzLm0rPTE7cmV0dXJuIGF9O2Z1bmN0aW9uIEYoYSxiKXt0aGlzLmU9YTt0aGlzLm09Yjt0aGlzLmo9MTY2MTk5NTUwO3RoaXMucT04MTkyfWs9Ri5wcm90b3R5cGU7ay50b1N0cmluZz1mdW5jdGlvbigpe3JldHVybiBlYyh0aGlzKX07ay5RPWZ1bmN0aW9uKGEsYil7dmFyIGM9Yit0aGlzLm07cmV0dXJuIGM8dGhpcy5lLmxlbmd0aD90aGlzLmVbY106bnVsbH07ay4kPWZ1bmN0aW9uKGEsYixjKXthPWIrdGhpcy5tO3JldHVybiBhPHRoaXMuZS5sZW5ndGg/dGhpcy5lW2FdOmN9O2sudmI9ITA7XG5rLmZiPWZ1bmN0aW9uKCl7cmV0dXJuIG5ldyBHYyh0aGlzLmUsdGhpcy5tKX07ay5UPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMubSsxPHRoaXMuZS5sZW5ndGg/bmV3IEYodGhpcy5lLHRoaXMubSsxKTpudWxsfTtrLkw9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5lLmxlbmd0aC10aGlzLm19O2suYWI9ZnVuY3Rpb24oKXt2YXIgYT1NYSh0aGlzKTtyZXR1cm4gMDxhP25ldyBIYyh0aGlzLGEtMSxudWxsKTpudWxsfTtrLkI9ZnVuY3Rpb24oKXtyZXR1cm4gd2ModGhpcyl9O2suQT1mdW5jdGlvbihhLGIpe3JldHVybiBJYy5hP0ljLmEodGhpcyxiKTpJYy5jYWxsKG51bGwsdGhpcyxiKX07ay5KPWZ1bmN0aW9uKCl7cmV0dXJuIEp9O2suUj1mdW5jdGlvbihhLGIpe3JldHVybiBEYy5uKHRoaXMuZSxiLHRoaXMuZVt0aGlzLm1dLHRoaXMubSsxKX07ay5PPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gRGMubih0aGlzLmUsYixjLHRoaXMubSl9O2suTj1mdW5jdGlvbigpe3JldHVybiB0aGlzLmVbdGhpcy5tXX07XG5rLlM9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5tKzE8dGhpcy5lLmxlbmd0aD9uZXcgRih0aGlzLmUsdGhpcy5tKzEpOkp9O2suRD1mdW5jdGlvbigpe3JldHVybiB0aGlzfTtrLkc9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gTS5hP00uYShiLHRoaXMpOk0uY2FsbChudWxsLGIsdGhpcyl9O0YucHJvdG90eXBlW0VhXT1mdW5jdGlvbigpe3JldHVybiB1Yyh0aGlzKX07XG52YXIgSmM9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYil7cmV0dXJuIGI8YS5sZW5ndGg/bmV3IEYoYSxiKTpudWxsfWZ1bmN0aW9uIGIoYSl7cmV0dXJuIGMuYShhLDApfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGIuY2FsbCh0aGlzLGMpO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5iPWI7Yy5hPWE7cmV0dXJuIGN9KCksS2M9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYil7cmV0dXJuIEpjLmEoYSxiKX1mdW5jdGlvbiBiKGEpe3JldHVybiBKYy5hKGEsMCl9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYi5jYWxsKHRoaXMsYyk7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxjLGUpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrXG5hcmd1bWVudHMubGVuZ3RoKTt9O2MuYj1iO2MuYT1hO3JldHVybiBjfSgpO2Z1bmN0aW9uIEhjKGEsYixjKXt0aGlzLnFiPWE7dGhpcy5tPWI7dGhpcy5rPWM7dGhpcy5qPTMyMzc0OTkwO3RoaXMucT04MTkyfWs9SGMucHJvdG90eXBlO2sudG9TdHJpbmc9ZnVuY3Rpb24oKXtyZXR1cm4gZWModGhpcyl9O2suSD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmt9O2suVD1mdW5jdGlvbigpe3JldHVybiAwPHRoaXMubT9uZXcgSGModGhpcy5xYix0aGlzLm0tMSxudWxsKTpudWxsfTtrLkw9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5tKzF9O2suQj1mdW5jdGlvbigpe3JldHVybiB3Yyh0aGlzKX07ay5BPWZ1bmN0aW9uKGEsYil7cmV0dXJuIEljLmE/SWMuYSh0aGlzLGIpOkljLmNhbGwobnVsbCx0aGlzLGIpfTtrLko9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLms7cmV0dXJuIE8uYT9PLmEoSixhKTpPLmNhbGwobnVsbCxKLGEpfTtcbmsuUj1mdW5jdGlvbihhLGIpe3JldHVybiBQLmE/UC5hKGIsdGhpcyk6UC5jYWxsKG51bGwsYix0aGlzKX07ay5PPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gUC5jP1AuYyhiLGMsdGhpcyk6UC5jYWxsKG51bGwsYixjLHRoaXMpfTtrLk49ZnVuY3Rpb24oKXtyZXR1cm4gQy5hKHRoaXMucWIsdGhpcy5tKX07ay5TPWZ1bmN0aW9uKCl7cmV0dXJuIDA8dGhpcy5tP25ldyBIYyh0aGlzLnFiLHRoaXMubS0xLG51bGwpOkp9O2suRD1mdW5jdGlvbigpe3JldHVybiB0aGlzfTtrLkY9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IEhjKHRoaXMucWIsdGhpcy5tLGIpfTtrLkc9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gTS5hP00uYShiLHRoaXMpOk0uY2FsbChudWxsLGIsdGhpcyl9O0hjLnByb3RvdHlwZVtFYV09ZnVuY3Rpb24oKXtyZXR1cm4gdWModGhpcyl9O2Z1bmN0aW9uIExjKGEpe3JldHVybiBHKEsoYSkpfXliLl89ZnVuY3Rpb24oYSxiKXtyZXR1cm4gYT09PWJ9O1xudmFyIE5jPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIpe3JldHVybiBudWxsIT1hP1JhKGEsYik6UmEoSixiKX12YXIgYj1udWxsLGM9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGIsZCxoKXt2YXIgbD1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBsPTAsbT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2w8bS5sZW5ndGg7KW1bbF09YXJndW1lbnRzW2wrMl0sKytsO2w9bmV3IEYobSwwKX1yZXR1cm4gYy5jYWxsKHRoaXMsYixkLGwpfWZ1bmN0aW9uIGMoYSxkLGUpe2Zvcig7OylpZih0KGUpKWE9Yi5hKGEsZCksZD1HKGUpLGU9SyhlKTtlbHNlIHJldHVybiBiLmEoYSxkKX1hLmk9MjthLmY9ZnVuY3Rpb24oYSl7dmFyIGI9RyhhKTthPUsoYSk7dmFyIGQ9RyhhKTthPUgoYSk7cmV0dXJuIGMoYixkLGEpfTthLmQ9YztyZXR1cm4gYX0oKSxiPWZ1bmN0aW9uKGIsZSxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAwOnJldHVybiBNYztjYXNlIDE6cmV0dXJuIGI7XG5jYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGIsZSk7ZGVmYXVsdDp2YXIgZz1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBnPTAsaD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2c8aC5sZW5ndGg7KWhbZ109YXJndW1lbnRzW2crMl0sKytnO2c9bmV3IEYoaCwwKX1yZXR1cm4gYy5kKGIsZSxnKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yi5pPTI7Yi5mPWMuZjtiLmw9ZnVuY3Rpb24oKXtyZXR1cm4gTWN9O2IuYj1mdW5jdGlvbihhKXtyZXR1cm4gYX07Yi5hPWE7Yi5kPWMuZDtyZXR1cm4gYn0oKTtmdW5jdGlvbiBPYyhhKXtyZXR1cm4gbnVsbD09YT9udWxsOk5hKGEpfVxuZnVuY3Rpb24gUShhKXtpZihudWxsIT1hKWlmKGEmJihhLmomMnx8YS5jYykpYT1hLkwobnVsbCk7ZWxzZSBpZihhIGluc3RhbmNlb2YgQXJyYXkpYT1hLmxlbmd0aDtlbHNlIGlmKFwic3RyaW5nXCI9PT10eXBlb2YgYSlhPWEubGVuZ3RoO2Vsc2UgaWYodyhMYSxhKSlhPU1hKGEpO2Vsc2UgYTp7YT1EKGEpO2Zvcih2YXIgYj0wOzspe2lmKEVjKGEpKXthPWIrTWEoYSk7YnJlYWsgYX1hPUsoYSk7Yis9MX1hPXZvaWQgMH1lbHNlIGE9MDtyZXR1cm4gYX1cbnZhciBQYz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMpe2Zvcig7Oyl7aWYobnVsbD09YSlyZXR1cm4gYztpZigwPT09YilyZXR1cm4gRChhKT9HKGEpOmM7aWYoRmMoYSkpcmV0dXJuIEMuYyhhLGIsYyk7aWYoRChhKSlhPUsoYSksYi09MTtlbHNlIHJldHVybiBjfX1mdW5jdGlvbiBiKGEsYil7Zm9yKDs7KXtpZihudWxsPT1hKXRocm93IEVycm9yKFwiSW5kZXggb3V0IG9mIGJvdW5kc1wiKTtpZigwPT09Yil7aWYoRChhKSlyZXR1cm4gRyhhKTt0aHJvdyBFcnJvcihcIkluZGV4IG91dCBvZiBib3VuZHNcIik7fWlmKEZjKGEpKXJldHVybiBDLmEoYSxiKTtpZihEKGEpKXt2YXIgYz1LKGEpLGc9Yi0xO2E9YztiPWd9ZWxzZSB0aHJvdyBFcnJvcihcIkluZGV4IG91dCBvZiBib3VuZHNcIik7fX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIGIuY2FsbCh0aGlzLGMsZSk7Y2FzZSAzOnJldHVybiBhLmNhbGwodGhpcyxcbmMsZSxmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5hPWI7Yy5jPWE7cmV0dXJuIGN9KCksUj1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMpe2lmKFwibnVtYmVyXCIhPT10eXBlb2YgYil0aHJvdyBFcnJvcihcImluZGV4IGFyZ3VtZW50IHRvIG50aCBtdXN0IGJlIGEgbnVtYmVyLlwiKTtpZihudWxsPT1hKXJldHVybiBjO2lmKGEmJihhLmomMTZ8fGEuUWIpKXJldHVybiBhLiQobnVsbCxiLGMpO2lmKGEgaW5zdGFuY2VvZiBBcnJheXx8XCJzdHJpbmdcIj09PXR5cGVvZiBhKXJldHVybiBiPGEubGVuZ3RoP2FbYl06YztpZih3KFRhLGEpKXJldHVybiBDLmEoYSxiKTtpZihhP2EuaiY2NHx8YS5qYnx8KGEuaj8wOncoVWEsYSkpOncoVWEsYSkpcmV0dXJuIFBjLmMoYSxiLGMpO3Rocm93IEVycm9yKFt6KFwibnRoIG5vdCBzdXBwb3J0ZWQgb24gdGhpcyB0eXBlIFwiKSx6KERhKEJhKGEpKSldLmpvaW4oXCJcIikpO31mdW5jdGlvbiBiKGEsYil7aWYoXCJudW1iZXJcIiE9PVxudHlwZW9mIGIpdGhyb3cgRXJyb3IoXCJpbmRleCBhcmd1bWVudCB0byBudGggbXVzdCBiZSBhIG51bWJlclwiKTtpZihudWxsPT1hKXJldHVybiBhO2lmKGEmJihhLmomMTZ8fGEuUWIpKXJldHVybiBhLlEobnVsbCxiKTtpZihhIGluc3RhbmNlb2YgQXJyYXl8fFwic3RyaW5nXCI9PT10eXBlb2YgYSlyZXR1cm4gYjxhLmxlbmd0aD9hW2JdOm51bGw7aWYodyhUYSxhKSlyZXR1cm4gQy5hKGEsYik7aWYoYT9hLmomNjR8fGEuamJ8fChhLmo/MDp3KFVhLGEpKTp3KFVhLGEpKXJldHVybiBQYy5hKGEsYik7dGhyb3cgRXJyb3IoW3ooXCJudGggbm90IHN1cHBvcnRlZCBvbiB0aGlzIHR5cGUgXCIpLHooRGEoQmEoYSkpKV0uam9pbihcIlwiKSk7fXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gYi5jYWxsKHRoaXMsYyxlKTtjYXNlIDM6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSxmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK1xuYXJndW1lbnRzLmxlbmd0aCk7fTtjLmE9YjtjLmM9YTtyZXR1cm4gY30oKSxTPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyl7cmV0dXJuIG51bGwhPWE/YSYmKGEuaiYyNTZ8fGEuUmIpP2EucyhudWxsLGIsYyk6YSBpbnN0YW5jZW9mIEFycmF5P2I8YS5sZW5ndGg/YVtiXTpjOlwic3RyaW5nXCI9PT10eXBlb2YgYT9iPGEubGVuZ3RoP2FbYl06Yzp3KFphLGEpPyRhLmMoYSxiLGMpOmM6Y31mdW5jdGlvbiBiKGEsYil7cmV0dXJuIG51bGw9PWE/bnVsbDphJiYoYS5qJjI1Nnx8YS5SYik/YS50KG51bGwsYik6YSBpbnN0YW5jZW9mIEFycmF5P2I8YS5sZW5ndGg/YVtiXTpudWxsOlwic3RyaW5nXCI9PT10eXBlb2YgYT9iPGEubGVuZ3RoP2FbYl06bnVsbDp3KFphLGEpPyRhLmEoYSxiKTpudWxsfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gYi5jYWxsKHRoaXMsYyxlKTtjYXNlIDM6cmV0dXJuIGEuY2FsbCh0aGlzLFxuYyxlLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmE9YjtjLmM9YTtyZXR1cm4gY30oKSxSYz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMpe2lmKG51bGwhPWEpYT1jYihhLGIsYyk7ZWxzZSBhOnthPVtiXTtjPVtjXTtiPWEubGVuZ3RoO2Zvcih2YXIgZz0wLGg9T2IoUWMpOzspaWYoZzxiKXZhciBsPWcrMSxoPWgua2IobnVsbCxhW2ddLGNbZ10pLGc9bDtlbHNle2E9UWIoaCk7YnJlYWsgYX1hPXZvaWQgMH1yZXR1cm4gYX12YXIgYj1udWxsLGM9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGIsZCxoLGwpe3ZhciBtPW51bGw7aWYoMzxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIG09MCxwPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMyk7bTxwLmxlbmd0aDspcFttXT1hcmd1bWVudHNbbSszXSwrK207bT1uZXcgRihwLDApfXJldHVybiBjLmNhbGwodGhpcyxiLGQsaCxtKX1mdW5jdGlvbiBjKGEsZCxlLGwpe2Zvcig7OylpZihhPWIuYyhhLFxuZCxlKSx0KGwpKWQ9RyhsKSxlPUxjKGwpLGw9SyhLKGwpKTtlbHNlIHJldHVybiBhfWEuaT0zO2EuZj1mdW5jdGlvbihhKXt2YXIgYj1HKGEpO2E9SyhhKTt2YXIgZD1HKGEpO2E9SyhhKTt2YXIgbD1HKGEpO2E9SChhKTtyZXR1cm4gYyhiLGQsbCxhKX07YS5kPWM7cmV0dXJuIGF9KCksYj1mdW5jdGlvbihiLGUsZixnKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAzOnJldHVybiBhLmNhbGwodGhpcyxiLGUsZik7ZGVmYXVsdDp2YXIgaD1udWxsO2lmKDM8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBoPTAsbD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTMpO2g8bC5sZW5ndGg7KWxbaF09YXJndW1lbnRzW2grM10sKytoO2g9bmV3IEYobCwwKX1yZXR1cm4gYy5kKGIsZSxmLGgpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtiLmk9MztiLmY9Yy5mO2IuYz1hO2IuZD1jLmQ7cmV0dXJuIGJ9KCksU2M9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsXG5iKXtyZXR1cm4gbnVsbD09YT9udWxsOmViKGEsYil9dmFyIGI9bnVsbCxjPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShiLGQsaCl7dmFyIGw9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgbD0wLG09QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtsPG0ubGVuZ3RoOyltW2xdPWFyZ3VtZW50c1tsKzJdLCsrbDtsPW5ldyBGKG0sMCl9cmV0dXJuIGMuY2FsbCh0aGlzLGIsZCxsKX1mdW5jdGlvbiBjKGEsZCxlKXtmb3IoOzspe2lmKG51bGw9PWEpcmV0dXJuIG51bGw7YT1iLmEoYSxkKTtpZih0KGUpKWQ9RyhlKSxlPUsoZSk7ZWxzZSByZXR1cm4gYX19YS5pPTI7YS5mPWZ1bmN0aW9uKGEpe3ZhciBiPUcoYSk7YT1LKGEpO3ZhciBkPUcoYSk7YT1IKGEpO3JldHVybiBjKGIsZCxhKX07YS5kPWM7cmV0dXJuIGF9KCksYj1mdW5jdGlvbihiLGUsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYjtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGIsZSk7XG5kZWZhdWx0OnZhciBnPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGc9MCxoPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7ZzxoLmxlbmd0aDspaFtnXT1hcmd1bWVudHNbZysyXSwrK2c7Zz1uZXcgRihoLDApfXJldHVybiBjLmQoYixlLGcpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtiLmk9MjtiLmY9Yy5mO2IuYj1mdW5jdGlvbihhKXtyZXR1cm4gYX07Yi5hPWE7Yi5kPWMuZDtyZXR1cm4gYn0oKTtmdW5jdGlvbiBUYyhhKXt2YXIgYj1cImZ1bmN0aW9uXCI9PW4oYSk7cmV0dXJuIHQoYik/YjphP3QodChudWxsKT9udWxsOmEuYmMpPyEwOmEueWI/ITE6dyhKYSxhKTp3KEphLGEpfWZ1bmN0aW9uIFVjKGEsYil7dGhpcy5oPWE7dGhpcy5rPWI7dGhpcy5xPTA7dGhpcy5qPTM5MzIxN31rPVVjLnByb3RvdHlwZTtcbmsuY2FsbD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSxzLHYseSxCLEUsTixZLHJhLEkpe2E9dGhpcy5oO3JldHVybiBULnViP1QudWIoYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSxzLHYseSxCLEUsTixZLHJhLEkpOlQuY2FsbChudWxsLGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHUscyx2LHksQixFLE4sWSxyYSxJKX1mdW5jdGlvbiBiKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHUscyx2LHksQixFLE4sWSxyYSl7YT10aGlzO3JldHVybiBhLmguRmE/YS5oLkZhKGIsYyxkLGUsZixnLGgsbCxtLHAscSx1LHMsdix5LEIsRSxOLFkscmEpOmEuaC5jYWxsKG51bGwsYixjLGQsZSxmLGcsaCxsLG0scCxxLHUscyx2LHksQixFLE4sWSxyYSl9ZnVuY3Rpb24gYyhhLGIsYyxkLGUsZixnLGgsbCxtLHAscSx1LHMsdix5LEIsRSxOLFkpe2E9dGhpcztyZXR1cm4gYS5oLkVhP2EuaC5FYShiLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSxzLHYseSxCLEUsTixcblkpOmEuaC5jYWxsKG51bGwsYixjLGQsZSxmLGcsaCxsLG0scCxxLHUscyx2LHksQixFLE4sWSl9ZnVuY3Rpb24gZChhLGIsYyxkLGUsZixnLGgsbCxtLHAscSx1LHMsdix5LEIsRSxOKXthPXRoaXM7cmV0dXJuIGEuaC5EYT9hLmguRGEoYixjLGQsZSxmLGcsaCxsLG0scCxxLHUscyx2LHksQixFLE4pOmEuaC5jYWxsKG51bGwsYixjLGQsZSxmLGcsaCxsLG0scCxxLHUscyx2LHksQixFLE4pfWZ1bmN0aW9uIGUoYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSxzLHYseSxCLEUpe2E9dGhpcztyZXR1cm4gYS5oLkNhP2EuaC5DYShiLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSxzLHYseSxCLEUpOmEuaC5jYWxsKG51bGwsYixjLGQsZSxmLGcsaCxsLG0scCxxLHUscyx2LHksQixFKX1mdW5jdGlvbiBmKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHUscyx2LHksQil7YT10aGlzO3JldHVybiBhLmguQmE/YS5oLkJhKGIsYyxkLGUsZixnLGgsbCxtLHAscSx1LHMsdix5LEIpOmEuaC5jYWxsKG51bGwsXG5iLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSxzLHYseSxCKX1mdW5jdGlvbiBnKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHUscyx2LHkpe2E9dGhpcztyZXR1cm4gYS5oLkFhP2EuaC5BYShiLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSxzLHYseSk6YS5oLmNhbGwobnVsbCxiLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSxzLHYseSl9ZnVuY3Rpb24gaChhLGIsYyxkLGUsZixnLGgsbCxtLHAscSx1LHMsdil7YT10aGlzO3JldHVybiBhLmguemE/YS5oLnphKGIsYyxkLGUsZixnLGgsbCxtLHAscSx1LHMsdik6YS5oLmNhbGwobnVsbCxiLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSxzLHYpfWZ1bmN0aW9uIGwoYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSxzKXthPXRoaXM7cmV0dXJuIGEuaC55YT9hLmgueWEoYixjLGQsZSxmLGcsaCxsLG0scCxxLHUscyk6YS5oLmNhbGwobnVsbCxiLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSxzKX1mdW5jdGlvbiBtKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHUpe2E9dGhpcztcbnJldHVybiBhLmgueGE/YS5oLnhhKGIsYyxkLGUsZixnLGgsbCxtLHAscSx1KTphLmguY2FsbChudWxsLGIsYyxkLGUsZixnLGgsbCxtLHAscSx1KX1mdW5jdGlvbiBwKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxKXthPXRoaXM7cmV0dXJuIGEuaC53YT9hLmgud2EoYixjLGQsZSxmLGcsaCxsLG0scCxxKTphLmguY2FsbChudWxsLGIsYyxkLGUsZixnLGgsbCxtLHAscSl9ZnVuY3Rpb24gcShhLGIsYyxkLGUsZixnLGgsbCxtLHApe2E9dGhpcztyZXR1cm4gYS5oLnZhP2EuaC52YShiLGMsZCxlLGYsZyxoLGwsbSxwKTphLmguY2FsbChudWxsLGIsYyxkLGUsZixnLGgsbCxtLHApfWZ1bmN0aW9uIHMoYSxiLGMsZCxlLGYsZyxoLGwsbSl7YT10aGlzO3JldHVybiBhLmguSGE/YS5oLkhhKGIsYyxkLGUsZixnLGgsbCxtKTphLmguY2FsbChudWxsLGIsYyxkLGUsZixnLGgsbCxtKX1mdW5jdGlvbiB1KGEsYixjLGQsZSxmLGcsaCxsKXthPXRoaXM7cmV0dXJuIGEuaC5HYT9hLmguR2EoYixjLFxuZCxlLGYsZyxoLGwpOmEuaC5jYWxsKG51bGwsYixjLGQsZSxmLGcsaCxsKX1mdW5jdGlvbiB2KGEsYixjLGQsZSxmLGcsaCl7YT10aGlzO3JldHVybiBhLmguaWE/YS5oLmlhKGIsYyxkLGUsZixnLGgpOmEuaC5jYWxsKG51bGwsYixjLGQsZSxmLGcsaCl9ZnVuY3Rpb24geShhLGIsYyxkLGUsZixnKXthPXRoaXM7cmV0dXJuIGEuaC5QP2EuaC5QKGIsYyxkLGUsZixnKTphLmguY2FsbChudWxsLGIsYyxkLGUsZixnKX1mdW5jdGlvbiBCKGEsYixjLGQsZSxmKXthPXRoaXM7cmV0dXJuIGEuaC5yP2EuaC5yKGIsYyxkLGUsZik6YS5oLmNhbGwobnVsbCxiLGMsZCxlLGYpfWZ1bmN0aW9uIEUoYSxiLGMsZCxlKXthPXRoaXM7cmV0dXJuIGEuaC5uP2EuaC5uKGIsYyxkLGUpOmEuaC5jYWxsKG51bGwsYixjLGQsZSl9ZnVuY3Rpb24gTihhLGIsYyxkKXthPXRoaXM7cmV0dXJuIGEuaC5jP2EuaC5jKGIsYyxkKTphLmguY2FsbChudWxsLGIsYyxkKX1mdW5jdGlvbiBZKGEsYixjKXthPXRoaXM7XG5yZXR1cm4gYS5oLmE/YS5oLmEoYixjKTphLmguY2FsbChudWxsLGIsYyl9ZnVuY3Rpb24gcmEoYSxiKXthPXRoaXM7cmV0dXJuIGEuaC5iP2EuaC5iKGIpOmEuaC5jYWxsKG51bGwsYil9ZnVuY3Rpb24gUGEoYSl7YT10aGlzO3JldHVybiBhLmgubD9hLmgubCgpOmEuaC5jYWxsKG51bGwpfXZhciBJPW51bGwsST1mdW5jdGlvbihJLHFhLHRhLHZhLHhhLENhLEdhLEthLE9hLFNhLFlhLGdiLG9iLEFiLFdiLGpjLHpjLFpjLEdkLERlLFdmLGRoKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBQYS5jYWxsKHRoaXMsSSk7Y2FzZSAyOnJldHVybiByYS5jYWxsKHRoaXMsSSxxYSk7Y2FzZSAzOnJldHVybiBZLmNhbGwodGhpcyxJLHFhLHRhKTtjYXNlIDQ6cmV0dXJuIE4uY2FsbCh0aGlzLEkscWEsdGEsdmEpO2Nhc2UgNTpyZXR1cm4gRS5jYWxsKHRoaXMsSSxxYSx0YSx2YSx4YSk7Y2FzZSA2OnJldHVybiBCLmNhbGwodGhpcyxJLHFhLHRhLHZhLHhhLENhKTtjYXNlIDc6cmV0dXJuIHkuY2FsbCh0aGlzLFxuSSxxYSx0YSx2YSx4YSxDYSxHYSk7Y2FzZSA4OnJldHVybiB2LmNhbGwodGhpcyxJLHFhLHRhLHZhLHhhLENhLEdhLEthKTtjYXNlIDk6cmV0dXJuIHUuY2FsbCh0aGlzLEkscWEsdGEsdmEseGEsQ2EsR2EsS2EsT2EpO2Nhc2UgMTA6cmV0dXJuIHMuY2FsbCh0aGlzLEkscWEsdGEsdmEseGEsQ2EsR2EsS2EsT2EsU2EpO2Nhc2UgMTE6cmV0dXJuIHEuY2FsbCh0aGlzLEkscWEsdGEsdmEseGEsQ2EsR2EsS2EsT2EsU2EsWWEpO2Nhc2UgMTI6cmV0dXJuIHAuY2FsbCh0aGlzLEkscWEsdGEsdmEseGEsQ2EsR2EsS2EsT2EsU2EsWWEsZ2IpO2Nhc2UgMTM6cmV0dXJuIG0uY2FsbCh0aGlzLEkscWEsdGEsdmEseGEsQ2EsR2EsS2EsT2EsU2EsWWEsZ2Isb2IpO2Nhc2UgMTQ6cmV0dXJuIGwuY2FsbCh0aGlzLEkscWEsdGEsdmEseGEsQ2EsR2EsS2EsT2EsU2EsWWEsZ2Isb2IsQWIpO2Nhc2UgMTU6cmV0dXJuIGguY2FsbCh0aGlzLEkscWEsdGEsdmEseGEsQ2EsR2EsS2EsT2EsU2EsWWEsZ2IsXG5vYixBYixXYik7Y2FzZSAxNjpyZXR1cm4gZy5jYWxsKHRoaXMsSSxxYSx0YSx2YSx4YSxDYSxHYSxLYSxPYSxTYSxZYSxnYixvYixBYixXYixqYyk7Y2FzZSAxNzpyZXR1cm4gZi5jYWxsKHRoaXMsSSxxYSx0YSx2YSx4YSxDYSxHYSxLYSxPYSxTYSxZYSxnYixvYixBYixXYixqYyx6Yyk7Y2FzZSAxODpyZXR1cm4gZS5jYWxsKHRoaXMsSSxxYSx0YSx2YSx4YSxDYSxHYSxLYSxPYSxTYSxZYSxnYixvYixBYixXYixqYyx6YyxaYyk7Y2FzZSAxOTpyZXR1cm4gZC5jYWxsKHRoaXMsSSxxYSx0YSx2YSx4YSxDYSxHYSxLYSxPYSxTYSxZYSxnYixvYixBYixXYixqYyx6YyxaYyxHZCk7Y2FzZSAyMDpyZXR1cm4gYy5jYWxsKHRoaXMsSSxxYSx0YSx2YSx4YSxDYSxHYSxLYSxPYSxTYSxZYSxnYixvYixBYixXYixqYyx6YyxaYyxHZCxEZSk7Y2FzZSAyMTpyZXR1cm4gYi5jYWxsKHRoaXMsSSxxYSx0YSx2YSx4YSxDYSxHYSxLYSxPYSxTYSxZYSxnYixvYixBYixXYixqYyx6YyxaYyxHZCxEZSxcbldmKTtjYXNlIDIyOnJldHVybiBhLmNhbGwodGhpcyxJLHFhLHRhLHZhLHhhLENhLEdhLEthLE9hLFNhLFlhLGdiLG9iLEFiLFdiLGpjLHpjLFpjLEdkLERlLFdmLGRoKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307SS5iPVBhO0kuYT1yYTtJLmM9WTtJLm49TjtJLnI9RTtJLlA9QjtJLmlhPXk7SS5HYT12O0kuSGE9dTtJLnZhPXM7SS53YT1xO0kueGE9cDtJLnlhPW07SS56YT1sO0kuQWE9aDtJLkJhPWc7SS5DYT1mO0kuRGE9ZTtJLkVhPWQ7SS5GYT1jO0kuaGM9YjtJLnViPWE7cmV0dXJuIEl9KCk7ay5hcHBseT1mdW5jdGlvbihhLGIpe3JldHVybiB0aGlzLmNhbGwuYXBwbHkodGhpcyxbdGhpc10uY29uY2F0KEZhKGIpKSl9O2subD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmgubD90aGlzLmgubCgpOnRoaXMuaC5jYWxsKG51bGwpfTtcbmsuYj1mdW5jdGlvbihhKXtyZXR1cm4gdGhpcy5oLmI/dGhpcy5oLmIoYSk6dGhpcy5oLmNhbGwobnVsbCxhKX07ay5hPWZ1bmN0aW9uKGEsYil7cmV0dXJuIHRoaXMuaC5hP3RoaXMuaC5hKGEsYik6dGhpcy5oLmNhbGwobnVsbCxhLGIpfTtrLmM9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiB0aGlzLmguYz90aGlzLmguYyhhLGIsYyk6dGhpcy5oLmNhbGwobnVsbCxhLGIsYyl9O2subj1mdW5jdGlvbihhLGIsYyxkKXtyZXR1cm4gdGhpcy5oLm4/dGhpcy5oLm4oYSxiLGMsZCk6dGhpcy5oLmNhbGwobnVsbCxhLGIsYyxkKX07ay5yPWZ1bmN0aW9uKGEsYixjLGQsZSl7cmV0dXJuIHRoaXMuaC5yP3RoaXMuaC5yKGEsYixjLGQsZSk6dGhpcy5oLmNhbGwobnVsbCxhLGIsYyxkLGUpfTtrLlA9ZnVuY3Rpb24oYSxiLGMsZCxlLGYpe3JldHVybiB0aGlzLmguUD90aGlzLmguUChhLGIsYyxkLGUsZik6dGhpcy5oLmNhbGwobnVsbCxhLGIsYyxkLGUsZil9O1xuay5pYT1mdW5jdGlvbihhLGIsYyxkLGUsZixnKXtyZXR1cm4gdGhpcy5oLmlhP3RoaXMuaC5pYShhLGIsYyxkLGUsZixnKTp0aGlzLmguY2FsbChudWxsLGEsYixjLGQsZSxmLGcpfTtrLkdhPWZ1bmN0aW9uKGEsYixjLGQsZSxmLGcsaCl7cmV0dXJuIHRoaXMuaC5HYT90aGlzLmguR2EoYSxiLGMsZCxlLGYsZyxoKTp0aGlzLmguY2FsbChudWxsLGEsYixjLGQsZSxmLGcsaCl9O2suSGE9ZnVuY3Rpb24oYSxiLGMsZCxlLGYsZyxoLGwpe3JldHVybiB0aGlzLmguSGE/dGhpcy5oLkhhKGEsYixjLGQsZSxmLGcsaCxsKTp0aGlzLmguY2FsbChudWxsLGEsYixjLGQsZSxmLGcsaCxsKX07ay52YT1mdW5jdGlvbihhLGIsYyxkLGUsZixnLGgsbCxtKXtyZXR1cm4gdGhpcy5oLnZhP3RoaXMuaC52YShhLGIsYyxkLGUsZixnLGgsbCxtKTp0aGlzLmguY2FsbChudWxsLGEsYixjLGQsZSxmLGcsaCxsLG0pfTtcbmsud2E9ZnVuY3Rpb24oYSxiLGMsZCxlLGYsZyxoLGwsbSxwKXtyZXR1cm4gdGhpcy5oLndhP3RoaXMuaC53YShhLGIsYyxkLGUsZixnLGgsbCxtLHApOnRoaXMuaC5jYWxsKG51bGwsYSxiLGMsZCxlLGYsZyxoLGwsbSxwKX07ay54YT1mdW5jdGlvbihhLGIsYyxkLGUsZixnLGgsbCxtLHAscSl7cmV0dXJuIHRoaXMuaC54YT90aGlzLmgueGEoYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEpOnRoaXMuaC5jYWxsKG51bGwsYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEpfTtrLnlhPWZ1bmN0aW9uKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHMpe3JldHVybiB0aGlzLmgueWE/dGhpcy5oLnlhKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHMpOnRoaXMuaC5jYWxsKG51bGwsYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEscyl9O1xuay56YT1mdW5jdGlvbihhLGIsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUpe3JldHVybiB0aGlzLmguemE/dGhpcy5oLnphKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSk6dGhpcy5oLmNhbGwobnVsbCxhLGIsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUpfTtrLkFhPWZ1bmN0aW9uKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2KXtyZXR1cm4gdGhpcy5oLkFhP3RoaXMuaC5BYShhLGIsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdik6dGhpcy5oLmNhbGwobnVsbCxhLGIsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdil9O2suQmE9ZnVuY3Rpb24oYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSl7cmV0dXJuIHRoaXMuaC5CYT90aGlzLmguQmEoYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSk6dGhpcy5oLmNhbGwobnVsbCxhLGIsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5KX07XG5rLkNhPWZ1bmN0aW9uKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQil7cmV0dXJuIHRoaXMuaC5DYT90aGlzLmguQ2EoYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCKTp0aGlzLmguY2FsbChudWxsLGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQil9O2suRGE9ZnVuY3Rpb24oYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCLEUpe3JldHVybiB0aGlzLmguRGE/dGhpcy5oLkRhKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQixFKTp0aGlzLmguY2FsbChudWxsLGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQixFKX07XG5rLkVhPWZ1bmN0aW9uKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQixFLE4pe3JldHVybiB0aGlzLmguRWE/dGhpcy5oLkVhKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQixFLE4pOnRoaXMuaC5jYWxsKG51bGwsYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCLEUsTil9O2suRmE9ZnVuY3Rpb24oYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCLEUsTixZKXtyZXR1cm4gdGhpcy5oLkZhP3RoaXMuaC5GYShhLGIsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIsRSxOLFkpOnRoaXMuaC5jYWxsKG51bGwsYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCLEUsTixZKX07XG5rLmhjPWZ1bmN0aW9uKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQixFLE4sWSxyYSl7dmFyIFBhPXRoaXMuaDtyZXR1cm4gVC51Yj9ULnViKFBhLGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQixFLE4sWSxyYSk6VC5jYWxsKG51bGwsUGEsYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCLEUsTixZLHJhKX07ay5iYz0hMDtrLkY9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IFVjKHRoaXMuaCxiKX07ay5IPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMua307ZnVuY3Rpb24gTyhhLGIpe3JldHVybiBUYyhhKSYmIShhP2EuaiYyNjIxNDR8fGEuQmN8fChhLmo/MDp3KHRiLGEpKTp3KHRiLGEpKT9uZXcgVWMoYSxiKTpudWxsPT1hP251bGw6dWIoYSxiKX1mdW5jdGlvbiBWYyhhKXt2YXIgYj1udWxsIT1hO3JldHVybihiP2E/YS5qJjEzMTA3Mnx8YS5rY3x8KGEuaj8wOncocmIsYSkpOncocmIsYSk6Yik/c2IoYSk6bnVsbH1cbmZ1bmN0aW9uIFdjKGEpe3JldHVybiBudWxsPT1hP251bGw6bGIoYSl9XG52YXIgWGM9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYil7cmV0dXJuIG51bGw9PWE/bnVsbDprYihhLGIpfXZhciBiPW51bGwsYz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYixkLGgpe3ZhciBsPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGw9MCxtPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7bDxtLmxlbmd0aDspbVtsXT1hcmd1bWVudHNbbCsyXSwrK2w7bD1uZXcgRihtLDApfXJldHVybiBjLmNhbGwodGhpcyxiLGQsbCl9ZnVuY3Rpb24gYyhhLGQsZSl7Zm9yKDs7KXtpZihudWxsPT1hKXJldHVybiBudWxsO2E9Yi5hKGEsZCk7aWYodChlKSlkPUcoZSksZT1LKGUpO2Vsc2UgcmV0dXJuIGF9fWEuaT0yO2EuZj1mdW5jdGlvbihhKXt2YXIgYj1HKGEpO2E9SyhhKTt2YXIgZD1HKGEpO2E9SChhKTtyZXR1cm4gYyhiLGQsYSl9O2EuZD1jO3JldHVybiBhfSgpLGI9ZnVuY3Rpb24oYixlLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGI7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxcbmIsZSk7ZGVmYXVsdDp2YXIgZz1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBnPTAsaD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2c8aC5sZW5ndGg7KWhbZ109YXJndW1lbnRzW2crMl0sKytnO2c9bmV3IEYoaCwwKX1yZXR1cm4gYy5kKGIsZSxnKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yi5pPTI7Yi5mPWMuZjtiLmI9ZnVuY3Rpb24oYSl7cmV0dXJuIGF9O2IuYT1hO2IuZD1jLmQ7cmV0dXJuIGJ9KCk7ZnVuY3Rpb24gWWMoYSl7cmV0dXJuIG51bGw9PWF8fEFhKEQoYSkpfWZ1bmN0aW9uICRjKGEpe3JldHVybiBudWxsPT1hPyExOmE/YS5qJjh8fGEudGM/ITA6YS5qPyExOncoUWEsYSk6dyhRYSxhKX1mdW5jdGlvbiBhZChhKXtyZXR1cm4gbnVsbD09YT8hMTphP2EuaiY0MDk2fHxhLnpjPyEwOmEuaj8hMTp3KGpiLGEpOncoamIsYSl9XG5mdW5jdGlvbiBiZChhKXtyZXR1cm4gYT9hLmomNTEyfHxhLnJjPyEwOmEuaj8hMTp3KGFiLGEpOncoYWIsYSl9ZnVuY3Rpb24gY2QoYSl7cmV0dXJuIGE/YS5qJjE2Nzc3MjE2fHxhLnljPyEwOmEuaj8hMTp3KERiLGEpOncoRGIsYSl9ZnVuY3Rpb24gZGQoYSl7cmV0dXJuIG51bGw9PWE/ITE6YT9hLmomMTAyNHx8YS5pYz8hMDphLmo/ITE6dyhkYixhKTp3KGRiLGEpfWZ1bmN0aW9uIGVkKGEpe3JldHVybiBhP2EuaiYxNjM4NHx8YS5BYz8hMDphLmo/ITE6dyhuYixhKTp3KG5iLGEpfWZ1bmN0aW9uIGZkKGEpe3JldHVybiBhP2EucSY1MTJ8fGEuc2M/ITA6ITE6ITF9ZnVuY3Rpb24gZ2QoYSl7dmFyIGI9W107ZWEoYSxmdW5jdGlvbihhLGIpe3JldHVybiBmdW5jdGlvbihhLGMpe3JldHVybiBiLnB1c2goYyl9fShhLGIpKTtyZXR1cm4gYn1mdW5jdGlvbiBoZChhLGIsYyxkLGUpe2Zvcig7MCE9PWU7KWNbZF09YVtiXSxkKz0xLGUtPTEsYis9MX1cbmZ1bmN0aW9uIGlkKGEsYixjLGQsZSl7Yis9ZS0xO2ZvcihkKz1lLTE7MCE9PWU7KWNbZF09YVtiXSxkLT0xLGUtPTEsYi09MX12YXIgamQ9e307ZnVuY3Rpb24ga2QoYSl7cmV0dXJuIG51bGw9PWE/ITE6YT9hLmomNjR8fGEuamI/ITA6YS5qPyExOncoVWEsYSk6dyhVYSxhKX1mdW5jdGlvbiBsZChhKXtyZXR1cm4gYT9hLmomODM4ODYwOHx8YS5tYz8hMDphLmo/ITE6dyhCYixhKTp3KEJiLGEpfWZ1bmN0aW9uIG1kKGEpe3JldHVybiB0KGEpPyEwOiExfWZ1bmN0aW9uIG5kKGEsYil7cmV0dXJuIFMuYyhhLGIsamQpPT09amQ/ITE6ITB9XG5mdW5jdGlvbiBvZChhLGIpe2lmKGE9PT1iKXJldHVybiAwO2lmKG51bGw9PWEpcmV0dXJuLTE7aWYobnVsbD09YilyZXR1cm4gMTtpZihCYShhKT09PUJhKGIpKXJldHVybiBhJiYoYS5xJjIwNDh8fGEuc2IpP2EudGIobnVsbCxiKTpoYShhLGIpO3Rocm93IEVycm9yKFwiY29tcGFyZSBvbiBub24tbmlsIG9iamVjdHMgb2YgZGlmZmVyZW50IHR5cGVzXCIpO31cbnZhciBwZD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMsZyl7Zm9yKDs7KXt2YXIgaD1vZChSLmEoYSxnKSxSLmEoYixnKSk7aWYoMD09PWgmJmcrMTxjKWcrPTE7ZWxzZSByZXR1cm4gaH19ZnVuY3Rpb24gYihhLGIpe3ZhciBmPVEoYSksZz1RKGIpO3JldHVybiBmPGc/LTE6Zj5nPzE6Yy5uKGEsYixmLDApfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUsZixnKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiBiLmNhbGwodGhpcyxjLGUpO2Nhc2UgNDpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlLGYsZyl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYT1iO2Mubj1hO3JldHVybiBjfSgpO1xuZnVuY3Rpb24gcWQoYSl7cmV0dXJuIHNjLmEoYSxvZCk/b2Q6ZnVuY3Rpb24oYixjKXt2YXIgZD1hLmE/YS5hKGIsYyk6YS5jYWxsKG51bGwsYixjKTtyZXR1cm5cIm51bWJlclwiPT09dHlwZW9mIGQ/ZDp0KGQpPy0xOnQoYS5hP2EuYShjLGIpOmEuY2FsbChudWxsLGMsYikpPzE6MH19XG52YXIgc2Q9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYil7aWYoRChiKSl7dmFyIGM9cmQuYj9yZC5iKGIpOnJkLmNhbGwobnVsbCxiKSxnPXFkKGEpO2lhKGMsZyk7cmV0dXJuIEQoYyl9cmV0dXJuIEp9ZnVuY3Rpb24gYihhKXtyZXR1cm4gYy5hKG9kLGEpfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGIuY2FsbCh0aGlzLGMpO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5iPWI7Yy5hPWE7cmV0dXJuIGN9KCksdGQ9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjKXtyZXR1cm4gc2QuYShmdW5jdGlvbihjLGYpe3JldHVybiBxZChiKS5jYWxsKG51bGwsYS5iP2EuYihjKTphLmNhbGwobnVsbCxjKSxhLmI/YS5iKGYpOmEuY2FsbChudWxsLGYpKX0sYyl9ZnVuY3Rpb24gYihhLGIpe3JldHVybiBjLmMoYSxvZCxcbmIpfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gYi5jYWxsKHRoaXMsYyxlKTtjYXNlIDM6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSxmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5hPWI7Yy5jPWE7cmV0dXJuIGN9KCksUD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMpe2ZvcihjPUQoYyk7OylpZihjKXt2YXIgZz1HKGMpO2I9YS5hP2EuYShiLGcpOmEuY2FsbChudWxsLGIsZyk7aWYoQWMoYikpcmV0dXJuIHFiKGIpO2M9SyhjKX1lbHNlIHJldHVybiBifWZ1bmN0aW9uIGIoYSxiKXt2YXIgYz1EKGIpO2lmKGMpe3ZhciBnPUcoYyksYz1LKGMpO3JldHVybiBBLmM/QS5jKGEsZyxjKTpBLmNhbGwobnVsbCxhLGcsYyl9cmV0dXJuIGEubD9hLmwoKTphLmNhbGwobnVsbCl9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiBiLmNhbGwodGhpcyxcbmMsZSk7Y2FzZSAzOnJldHVybiBhLmNhbGwodGhpcyxjLGUsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYT1iO2MuYz1hO3JldHVybiBjfSgpLEE9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjKXtyZXR1cm4gYyYmKGMuaiY1MjQyODh8fGMuU2IpP2MuTyhudWxsLGEsYik6YyBpbnN0YW5jZW9mIEFycmF5P0RjLmMoYyxhLGIpOlwic3RyaW5nXCI9PT10eXBlb2YgYz9EYy5jKGMsYSxiKTp3KHZiLGMpP3diLmMoYyxhLGIpOlAuYyhhLGIsYyl9ZnVuY3Rpb24gYihhLGIpe3JldHVybiBiJiYoYi5qJjUyNDI4OHx8Yi5TYik/Yi5SKG51bGwsYSk6YiBpbnN0YW5jZW9mIEFycmF5P0RjLmEoYixhKTpcInN0cmluZ1wiPT09dHlwZW9mIGI/RGMuYShiLGEpOncodmIsYik/d2IuYShiLGEpOlAuYShhLGIpfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gYi5jYWxsKHRoaXMsXG5jLGUpO2Nhc2UgMzpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmE9YjtjLmM9YTtyZXR1cm4gY30oKTtmdW5jdGlvbiB1ZChhKXtyZXR1cm4gYX1cbnZhciB2ZD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiKXtyZXR1cm4gZnVuY3Rpb24oKXtmdW5jdGlvbiBjKGIsZSl7cmV0dXJuIGEuYT9hLmEoYixlKTphLmNhbGwobnVsbCxiLGUpfWZ1bmN0aW9uIGcoYSl7cmV0dXJuIGIuYj9iLmIoYSk6Yi5jYWxsKG51bGwsYSl9ZnVuY3Rpb24gaCgpe3JldHVybiBhLmw/YS5sKCk6YS5jYWxsKG51bGwpfXZhciBsPW51bGwsbD1mdW5jdGlvbihhLGIpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDA6cmV0dXJuIGguY2FsbCh0aGlzKTtjYXNlIDE6cmV0dXJuIGcuY2FsbCh0aGlzLGEpO2Nhc2UgMjpyZXR1cm4gYy5jYWxsKHRoaXMsYSxiKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307bC5sPWg7bC5iPWc7bC5hPWM7cmV0dXJuIGx9KCl9ZnVuY3Rpb24gYihhKXtyZXR1cm4gYy5hKGEsdWQpfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGIuY2FsbCh0aGlzLFxuYyk7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxjLGUpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmI9YjtjLmE9YTtyZXR1cm4gY30oKSx3ZD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMsZyl7YT1hLmI/YS5iKGIpOmEuY2FsbChudWxsLGIpO2M9QS5jKGEsYyxnKTtyZXR1cm4gYS5iP2EuYihjKTphLmNhbGwobnVsbCxjKX1mdW5jdGlvbiBiKGEsYixmKXtyZXR1cm4gYy5uKGEsYixiLmw/Yi5sKCk6Yi5jYWxsKG51bGwpLGYpfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUsZixnKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAzOnJldHVybiBiLmNhbGwodGhpcyxjLGUsZik7Y2FzZSA0OnJldHVybiBhLmNhbGwodGhpcyxjLGUsZixnKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5jPWI7Yy5uPWE7cmV0dXJuIGN9KCkseGQ9ZnVuY3Rpb24oKXt2YXIgYT1udWxsLGI9ZnVuY3Rpb24oKXtmdW5jdGlvbiBiKGEsXG5jLGcpe3ZhciBoPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGg9MCxsPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7aDxsLmxlbmd0aDspbFtoXT1hcmd1bWVudHNbaCsyXSwrK2g7aD1uZXcgRihsLDApfXJldHVybiBkLmNhbGwodGhpcyxhLGMsaCl9ZnVuY3Rpb24gZChiLGMsZCl7cmV0dXJuIEEuYyhhLGIrYyxkKX1iLmk9MjtiLmY9ZnVuY3Rpb24oYSl7dmFyIGI9RyhhKTthPUsoYSk7dmFyIGM9RyhhKTthPUgoYSk7cmV0dXJuIGQoYixjLGEpfTtiLmQ9ZDtyZXR1cm4gYn0oKSxhPWZ1bmN0aW9uKGEsZCxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAwOnJldHVybiAwO2Nhc2UgMTpyZXR1cm4gYTtjYXNlIDI6cmV0dXJuIGErZDtkZWZhdWx0OnZhciBmPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGY9MCxnPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7ZjxnLmxlbmd0aDspZ1tmXT1hcmd1bWVudHNbZisyXSwrK2Y7Zj1uZXcgRihnLFxuMCl9cmV0dXJuIGIuZChhLGQsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2EuaT0yO2EuZj1iLmY7YS5sPWZ1bmN0aW9uKCl7cmV0dXJuIDB9O2EuYj1mdW5jdGlvbihhKXtyZXR1cm4gYX07YS5hPWZ1bmN0aW9uKGEsYil7cmV0dXJuIGErYn07YS5kPWIuZDtyZXR1cm4gYX0oKSx5ZD1mdW5jdGlvbigpe3ZhciBhPW51bGwsYj1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYyxmLGcpe3ZhciBoPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGg9MCxsPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7aDxsLmxlbmd0aDspbFtoXT1hcmd1bWVudHNbaCsyXSwrK2g7aD1uZXcgRihsLDApfXJldHVybiBiLmNhbGwodGhpcyxjLGYsaCl9ZnVuY3Rpb24gYihhLGMsZCl7Zm9yKDs7KWlmKGE8YylpZihLKGQpKWE9YyxjPUcoZCksZD1LKGQpO2Vsc2UgcmV0dXJuIGM8RyhkKTtlbHNlIHJldHVybiExfWEuaT0yO2EuZj1mdW5jdGlvbihhKXt2YXIgYz1cbkcoYSk7YT1LKGEpO3ZhciBnPUcoYSk7YT1IKGEpO3JldHVybiBiKGMsZyxhKX07YS5kPWI7cmV0dXJuIGF9KCksYT1mdW5jdGlvbihhLGQsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4hMDtjYXNlIDI6cmV0dXJuIGE8ZDtkZWZhdWx0OnZhciBmPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGY9MCxnPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7ZjxnLmxlbmd0aDspZ1tmXT1hcmd1bWVudHNbZisyXSwrK2Y7Zj1uZXcgRihnLDApfXJldHVybiBiLmQoYSxkLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTthLmk9MjthLmY9Yi5mO2EuYj1mdW5jdGlvbigpe3JldHVybiEwfTthLmE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gYTxifTthLmQ9Yi5kO3JldHVybiBhfSgpLHpkPWZ1bmN0aW9uKCl7dmFyIGE9bnVsbCxiPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShjLGYsZyl7dmFyIGg9bnVsbDtpZigyPFxuYXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBoPTAsbD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2g8bC5sZW5ndGg7KWxbaF09YXJndW1lbnRzW2grMl0sKytoO2g9bmV3IEYobCwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsYyxmLGgpfWZ1bmN0aW9uIGIoYSxjLGQpe2Zvcig7OylpZihhPD1jKWlmKEsoZCkpYT1jLGM9RyhkKSxkPUsoZCk7ZWxzZSByZXR1cm4gYzw9RyhkKTtlbHNlIHJldHVybiExfWEuaT0yO2EuZj1mdW5jdGlvbihhKXt2YXIgYz1HKGEpO2E9SyhhKTt2YXIgZz1HKGEpO2E9SChhKTtyZXR1cm4gYihjLGcsYSl9O2EuZD1iO3JldHVybiBhfSgpLGE9ZnVuY3Rpb24oYSxkLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuITA7Y2FzZSAyOnJldHVybiBhPD1kO2RlZmF1bHQ6dmFyIGY9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZj0wLGc9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtmPGcubGVuZ3RoOylnW2ZdPWFyZ3VtZW50c1tmK1xuMl0sKytmO2Y9bmV3IEYoZywwKX1yZXR1cm4gYi5kKGEsZCxmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307YS5pPTI7YS5mPWIuZjthLmI9ZnVuY3Rpb24oKXtyZXR1cm4hMH07YS5hPWZ1bmN0aW9uKGEsYil7cmV0dXJuIGE8PWJ9O2EuZD1iLmQ7cmV0dXJuIGF9KCksQWQ9ZnVuY3Rpb24oKXt2YXIgYT1udWxsLGI9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGMsZixnKXt2YXIgaD1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBoPTAsbD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2g8bC5sZW5ndGg7KWxbaF09YXJndW1lbnRzW2grMl0sKytoO2g9bmV3IEYobCwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsYyxmLGgpfWZ1bmN0aW9uIGIoYSxjLGQpe2Zvcig7OylpZihhPmMpaWYoSyhkKSlhPWMsYz1HKGQpLGQ9SyhkKTtlbHNlIHJldHVybiBjPkcoZCk7ZWxzZSByZXR1cm4hMX1hLmk9MjthLmY9ZnVuY3Rpb24oYSl7dmFyIGM9XG5HKGEpO2E9SyhhKTt2YXIgZz1HKGEpO2E9SChhKTtyZXR1cm4gYihjLGcsYSl9O2EuZD1iO3JldHVybiBhfSgpLGE9ZnVuY3Rpb24oYSxkLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuITA7Y2FzZSAyOnJldHVybiBhPmQ7ZGVmYXVsdDp2YXIgZj1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBmPTAsZz1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2Y8Zy5sZW5ndGg7KWdbZl09YXJndW1lbnRzW2YrMl0sKytmO2Y9bmV3IEYoZywwKX1yZXR1cm4gYi5kKGEsZCxmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307YS5pPTI7YS5mPWIuZjthLmI9ZnVuY3Rpb24oKXtyZXR1cm4hMH07YS5hPWZ1bmN0aW9uKGEsYil7cmV0dXJuIGE+Yn07YS5kPWIuZDtyZXR1cm4gYX0oKSxCZD1mdW5jdGlvbigpe3ZhciBhPW51bGwsYj1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYyxmLGcpe3ZhciBoPW51bGw7aWYoMjxcbmFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgaD0wLGw9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtoPGwubGVuZ3RoOylsW2hdPWFyZ3VtZW50c1toKzJdLCsraDtoPW5ldyBGKGwsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGMsZixoKX1mdW5jdGlvbiBiKGEsYyxkKXtmb3IoOzspaWYoYT49YylpZihLKGQpKWE9YyxjPUcoZCksZD1LKGQpO2Vsc2UgcmV0dXJuIGM+PUcoZCk7ZWxzZSByZXR1cm4hMX1hLmk9MjthLmY9ZnVuY3Rpb24oYSl7dmFyIGM9RyhhKTthPUsoYSk7dmFyIGc9RyhhKTthPUgoYSk7cmV0dXJuIGIoYyxnLGEpfTthLmQ9YjtyZXR1cm4gYX0oKSxhPWZ1bmN0aW9uKGEsZCxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiEwO2Nhc2UgMjpyZXR1cm4gYT49ZDtkZWZhdWx0OnZhciBmPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGY9MCxnPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7ZjxnLmxlbmd0aDspZ1tmXT1hcmd1bWVudHNbZitcbjJdLCsrZjtmPW5ldyBGKGcsMCl9cmV0dXJuIGIuZChhLGQsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2EuaT0yO2EuZj1iLmY7YS5iPWZ1bmN0aW9uKCl7cmV0dXJuITB9O2EuYT1mdW5jdGlvbihhLGIpe3JldHVybiBhPj1ifTthLmQ9Yi5kO3JldHVybiBhfSgpO2Z1bmN0aW9uIENkKGEsYil7dmFyIGM9KGEtYSViKS9iO3JldHVybiAwPD1jP01hdGguZmxvb3IuYj9NYXRoLmZsb29yLmIoYyk6TWF0aC5mbG9vci5jYWxsKG51bGwsYyk6TWF0aC5jZWlsLmI/TWF0aC5jZWlsLmIoYyk6TWF0aC5jZWlsLmNhbGwobnVsbCxjKX1mdW5jdGlvbiBEZChhKXthLT1hPj4xJjE0MzE2NTU3NjU7YT0oYSY4NTg5OTM0NTkpKyhhPj4yJjg1ODk5MzQ1OSk7cmV0dXJuIDE2ODQzMDA5KihhKyhhPj40KSYyNTI2NDUxMzUpPj4yNH1cbmZ1bmN0aW9uIEVkKGEpe3ZhciBiPTE7Zm9yKGE9RChhKTs7KWlmKGEmJjA8YiliLT0xLGE9SyhhKTtlbHNlIHJldHVybiBhfVxudmFyIHo9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEpe3JldHVybiBudWxsPT1hP1wiXCI6ZGEoYSl9dmFyIGI9bnVsbCxjPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShiLGQpe3ZhciBoPW51bGw7aWYoMTxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGg9MCxsPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMSk7aDxsLmxlbmd0aDspbFtoXT1hcmd1bWVudHNbaCsxXSwrK2g7aD1uZXcgRihsLDApfXJldHVybiBjLmNhbGwodGhpcyxiLGgpfWZ1bmN0aW9uIGMoYSxkKXtmb3IodmFyIGU9bmV3IGZhKGIuYihhKSksbD1kOzspaWYodChsKSllPWUuYXBwZW5kKGIuYihHKGwpKSksbD1LKGwpO2Vsc2UgcmV0dXJuIGUudG9TdHJpbmcoKX1hLmk9MTthLmY9ZnVuY3Rpb24oYSl7dmFyIGI9RyhhKTthPUgoYSk7cmV0dXJuIGMoYixhKX07YS5kPWM7cmV0dXJuIGF9KCksYj1mdW5jdGlvbihiLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDA6cmV0dXJuXCJcIjtjYXNlIDE6cmV0dXJuIGEuY2FsbCh0aGlzLFxuYik7ZGVmYXVsdDp2YXIgZj1udWxsO2lmKDE8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBmPTAsZz1BcnJheShhcmd1bWVudHMubGVuZ3RoLTEpO2Y8Zy5sZW5ndGg7KWdbZl09YXJndW1lbnRzW2YrMV0sKytmO2Y9bmV3IEYoZywwKX1yZXR1cm4gYy5kKGIsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2IuaT0xO2IuZj1jLmY7Yi5sPWZ1bmN0aW9uKCl7cmV0dXJuXCJcIn07Yi5iPWE7Yi5kPWMuZDtyZXR1cm4gYn0oKTtmdW5jdGlvbiBJYyhhLGIpe3ZhciBjO2lmKGNkKGIpKWlmKEVjKGEpJiZFYyhiKSYmUShhKSE9PVEoYikpYz0hMTtlbHNlIGE6e2M9RChhKTtmb3IodmFyIGQ9RChiKTs7KXtpZihudWxsPT1jKXtjPW51bGw9PWQ7YnJlYWsgYX1pZihudWxsIT1kJiZzYy5hKEcoYyksRyhkKSkpYz1LKGMpLGQ9SyhkKTtlbHNle2M9ITE7YnJlYWsgYX19Yz12b2lkIDB9ZWxzZSBjPW51bGw7cmV0dXJuIG1kKGMpfVxuZnVuY3Rpb24gRmQoYSxiLGMsZCxlKXt0aGlzLms9YTt0aGlzLmZpcnN0PWI7dGhpcy5NPWM7dGhpcy5jb3VudD1kO3RoaXMucD1lO3RoaXMuaj02NTkzNzY0Njt0aGlzLnE9ODE5Mn1rPUZkLnByb3RvdHlwZTtrLnRvU3RyaW5nPWZ1bmN0aW9uKCl7cmV0dXJuIGVjKHRoaXMpfTtrLkg9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5rfTtrLlQ9ZnVuY3Rpb24oKXtyZXR1cm4gMT09PXRoaXMuY291bnQ/bnVsbDp0aGlzLk19O2suTD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmNvdW50fTtrLkxhPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuZmlyc3R9O2suTWE9ZnVuY3Rpb24oKXtyZXR1cm4gV2EodGhpcyl9O2suQj1mdW5jdGlvbigpe3ZhciBhPXRoaXMucDtyZXR1cm4gbnVsbCE9YT9hOnRoaXMucD1hPXdjKHRoaXMpfTtrLkE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gSWModGhpcyxiKX07ay5KPWZ1bmN0aW9uKCl7cmV0dXJuIHViKEosdGhpcy5rKX07XG5rLlI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gUC5hKGIsdGhpcyl9O2suTz1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIFAuYyhiLGMsdGhpcyl9O2suTj1mdW5jdGlvbigpe3JldHVybiB0aGlzLmZpcnN0fTtrLlM9ZnVuY3Rpb24oKXtyZXR1cm4gMT09PXRoaXMuY291bnQ/Sjp0aGlzLk19O2suRD1mdW5jdGlvbigpe3JldHVybiB0aGlzfTtrLkY9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IEZkKGIsdGhpcy5maXJzdCx0aGlzLk0sdGhpcy5jb3VudCx0aGlzLnApfTtrLkc9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IEZkKHRoaXMuayxiLHRoaXMsdGhpcy5jb3VudCsxLG51bGwpfTtGZC5wcm90b3R5cGVbRWFdPWZ1bmN0aW9uKCl7cmV0dXJuIHVjKHRoaXMpfTtmdW5jdGlvbiBIZChhKXt0aGlzLms9YTt0aGlzLmo9NjU5Mzc2MTQ7dGhpcy5xPTgxOTJ9az1IZC5wcm90b3R5cGU7ay50b1N0cmluZz1mdW5jdGlvbigpe3JldHVybiBlYyh0aGlzKX07ay5IPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMua307XG5rLlQ9ZnVuY3Rpb24oKXtyZXR1cm4gbnVsbH07ay5MPWZ1bmN0aW9uKCl7cmV0dXJuIDB9O2suTGE9ZnVuY3Rpb24oKXtyZXR1cm4gbnVsbH07ay5NYT1mdW5jdGlvbigpe3Rocm93IEVycm9yKFwiQ2FuJ3QgcG9wIGVtcHR5IGxpc3RcIik7fTtrLkI9ZnVuY3Rpb24oKXtyZXR1cm4gMH07ay5BPWZ1bmN0aW9uKGEsYil7cmV0dXJuIEljKHRoaXMsYil9O2suSj1mdW5jdGlvbigpe3JldHVybiB0aGlzfTtrLlI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gUC5hKGIsdGhpcyl9O2suTz1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIFAuYyhiLGMsdGhpcyl9O2suTj1mdW5jdGlvbigpe3JldHVybiBudWxsfTtrLlM9ZnVuY3Rpb24oKXtyZXR1cm4gSn07ay5EPWZ1bmN0aW9uKCl7cmV0dXJuIG51bGx9O2suRj1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgSGQoYil9O2suRz1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgRmQodGhpcy5rLGIsbnVsbCwxLG51bGwpfTt2YXIgSj1uZXcgSGQobnVsbCk7XG5IZC5wcm90b3R5cGVbRWFdPWZ1bmN0aW9uKCl7cmV0dXJuIHVjKHRoaXMpfTtmdW5jdGlvbiBJZChhKXtyZXR1cm4gYT9hLmomMTM0MjE3NzI4fHxhLnhjPyEwOmEuaj8hMTp3KEZiLGEpOncoRmIsYSl9ZnVuY3Rpb24gSmQoYSl7cmV0dXJuIElkKGEpP0diKGEpOkEuYyhOYyxKLGEpfVxudmFyIEtkPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhKXt2YXIgZD1udWxsO2lmKDA8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBkPTAsZT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTApO2Q8ZS5sZW5ndGg7KWVbZF09YXJndW1lbnRzW2QrMF0sKytkO2Q9bmV3IEYoZSwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsZCl9ZnVuY3Rpb24gYihhKXt2YXIgYjtpZihhIGluc3RhbmNlb2YgRiYmMD09PWEubSliPWEuZTtlbHNlIGE6e2ZvcihiPVtdOzspaWYobnVsbCE9YSliLnB1c2goYS5OKG51bGwpKSxhPWEuVChudWxsKTtlbHNlIGJyZWFrIGE7Yj12b2lkIDB9YT1iLmxlbmd0aDtmb3IodmFyIGU9Sjs7KWlmKDA8YSl7dmFyIGY9YS0xLGU9ZS5HKG51bGwsYlthLTFdKTthPWZ9ZWxzZSByZXR1cm4gZX1hLmk9MDthLmY9ZnVuY3Rpb24oYSl7YT1EKGEpO3JldHVybiBiKGEpfTthLmQ9YjtyZXR1cm4gYX0oKTtcbmZ1bmN0aW9uIExkKGEsYixjLGQpe3RoaXMuaz1hO3RoaXMuZmlyc3Q9Yjt0aGlzLk09Yzt0aGlzLnA9ZDt0aGlzLmo9NjU5Mjk0NTI7dGhpcy5xPTgxOTJ9az1MZC5wcm90b3R5cGU7ay50b1N0cmluZz1mdW5jdGlvbigpe3JldHVybiBlYyh0aGlzKX07ay5IPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMua307ay5UPWZ1bmN0aW9uKCl7cmV0dXJuIG51bGw9PXRoaXMuTT9udWxsOkQodGhpcy5NKX07ay5CPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5wO3JldHVybiBudWxsIT1hP2E6dGhpcy5wPWE9d2ModGhpcyl9O2suQT1mdW5jdGlvbihhLGIpe3JldHVybiBJYyh0aGlzLGIpfTtrLko9ZnVuY3Rpb24oKXtyZXR1cm4gTyhKLHRoaXMuayl9O2suUj1mdW5jdGlvbihhLGIpe3JldHVybiBQLmEoYix0aGlzKX07ay5PPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gUC5jKGIsYyx0aGlzKX07ay5OPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuZmlyc3R9O1xuay5TPWZ1bmN0aW9uKCl7cmV0dXJuIG51bGw9PXRoaXMuTT9KOnRoaXMuTX07ay5EPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXN9O2suRj1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgTGQoYix0aGlzLmZpcnN0LHRoaXMuTSx0aGlzLnApfTtrLkc9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IExkKG51bGwsYix0aGlzLHRoaXMucCl9O0xkLnByb3RvdHlwZVtFYV09ZnVuY3Rpb24oKXtyZXR1cm4gdWModGhpcyl9O2Z1bmN0aW9uIE0oYSxiKXt2YXIgYz1udWxsPT1iO3JldHVybihjP2M6YiYmKGIuaiY2NHx8Yi5qYikpP25ldyBMZChudWxsLGEsYixudWxsKTpuZXcgTGQobnVsbCxhLEQoYiksbnVsbCl9XG5mdW5jdGlvbiBNZChhLGIpe2lmKGEucGE9PT1iLnBhKXJldHVybiAwO3ZhciBjPUFhKGEuYmEpO2lmKHQoYz9iLmJhOmMpKXJldHVybi0xO2lmKHQoYS5iYSkpe2lmKEFhKGIuYmEpKXJldHVybiAxO2M9aGEoYS5iYSxiLmJhKTtyZXR1cm4gMD09PWM/aGEoYS5uYW1lLGIubmFtZSk6Y31yZXR1cm4gaGEoYS5uYW1lLGIubmFtZSl9ZnVuY3Rpb24gVShhLGIsYyxkKXt0aGlzLmJhPWE7dGhpcy5uYW1lPWI7dGhpcy5wYT1jO3RoaXMuWWE9ZDt0aGlzLmo9MjE1Mzc3NTEwNTt0aGlzLnE9NDA5Nn1rPVUucHJvdG90eXBlO2sudj1mdW5jdGlvbihhLGIpe3JldHVybiBMYihiLFt6KFwiOlwiKSx6KHRoaXMucGEpXS5qb2luKFwiXCIpKX07ay5CPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5ZYTtyZXR1cm4gbnVsbCE9YT9hOnRoaXMuWWE9YT1vYyh0aGlzKSsyNjU0NDM1NzY5fDB9O1xuay5jYWxsPWZ1bmN0aW9uKCl7dmFyIGE9bnVsbCxhPWZ1bmN0aW9uKGEsYyxkKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiBTLmEoYyx0aGlzKTtjYXNlIDM6cmV0dXJuIFMuYyhjLHRoaXMsZCl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2EuYT1mdW5jdGlvbihhLGMpe3JldHVybiBTLmEoYyx0aGlzKX07YS5jPWZ1bmN0aW9uKGEsYyxkKXtyZXR1cm4gUy5jKGMsdGhpcyxkKX07cmV0dXJuIGF9KCk7ay5hcHBseT1mdW5jdGlvbihhLGIpe3JldHVybiB0aGlzLmNhbGwuYXBwbHkodGhpcyxbdGhpc10uY29uY2F0KEZhKGIpKSl9O2suYj1mdW5jdGlvbihhKXtyZXR1cm4gUy5hKGEsdGhpcyl9O2suYT1mdW5jdGlvbihhLGIpe3JldHVybiBTLmMoYSx0aGlzLGIpfTtrLkE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gYiBpbnN0YW5jZW9mIFU/dGhpcy5wYT09PWIucGE6ITF9O1xuay50b1N0cmluZz1mdW5jdGlvbigpe3JldHVyblt6KFwiOlwiKSx6KHRoaXMucGEpXS5qb2luKFwiXCIpfTtmdW5jdGlvbiBOZChhLGIpe3JldHVybiBhPT09Yj8hMDphIGluc3RhbmNlb2YgVSYmYiBpbnN0YW5jZW9mIFU/YS5wYT09PWIucGE6ITF9XG52YXIgUGQ9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYil7cmV0dXJuIG5ldyBVKGEsYixbeih0KGEpP1t6KGEpLHooXCIvXCIpXS5qb2luKFwiXCIpOm51bGwpLHooYildLmpvaW4oXCJcIiksbnVsbCl9ZnVuY3Rpb24gYihhKXtpZihhIGluc3RhbmNlb2YgVSlyZXR1cm4gYTtpZihhIGluc3RhbmNlb2YgcWMpe3ZhciBiO2lmKGEmJihhLnEmNDA5Nnx8YS5sYykpYj1hLmJhO2Vsc2UgdGhyb3cgRXJyb3IoW3ooXCJEb2Vzbid0IHN1cHBvcnQgbmFtZXNwYWNlOiBcIikseihhKV0uam9pbihcIlwiKSk7cmV0dXJuIG5ldyBVKGIsT2QuYj9PZC5iKGEpOk9kLmNhbGwobnVsbCxhKSxhLnRhLG51bGwpfXJldHVyblwic3RyaW5nXCI9PT10eXBlb2YgYT8oYj1hLnNwbGl0KFwiL1wiKSwyPT09Yi5sZW5ndGg/bmV3IFUoYlswXSxiWzFdLGEsbnVsbCk6bmV3IFUobnVsbCxiWzBdLGEsbnVsbCkpOm51bGx9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYi5jYWxsKHRoaXMsXG5jKTtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYj1iO2MuYT1hO3JldHVybiBjfSgpO2Z1bmN0aW9uIFYoYSxiLGMsZCl7dGhpcy5rPWE7dGhpcy5jYj1iO3RoaXMuQz1jO3RoaXMucD1kO3RoaXMucT0wO3RoaXMuaj0zMjM3NDk4OH1rPVYucHJvdG90eXBlO2sudG9TdHJpbmc9ZnVuY3Rpb24oKXtyZXR1cm4gZWModGhpcyl9O2Z1bmN0aW9uIFFkKGEpe251bGwhPWEuY2ImJihhLkM9YS5jYi5sP2EuY2IubCgpOmEuY2IuY2FsbChudWxsKSxhLmNiPW51bGwpO3JldHVybiBhLkN9ay5IPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMua307ay5UPWZ1bmN0aW9uKCl7Q2IodGhpcyk7cmV0dXJuIG51bGw9PXRoaXMuQz9udWxsOksodGhpcy5DKX07ay5CPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5wO3JldHVybiBudWxsIT1hP2E6dGhpcy5wPWE9d2ModGhpcyl9O1xuay5BPWZ1bmN0aW9uKGEsYil7cmV0dXJuIEljKHRoaXMsYil9O2suSj1mdW5jdGlvbigpe3JldHVybiBPKEosdGhpcy5rKX07ay5SPWZ1bmN0aW9uKGEsYil7cmV0dXJuIFAuYShiLHRoaXMpfTtrLk89ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBQLmMoYixjLHRoaXMpfTtrLk49ZnVuY3Rpb24oKXtDYih0aGlzKTtyZXR1cm4gbnVsbD09dGhpcy5DP251bGw6Ryh0aGlzLkMpfTtrLlM9ZnVuY3Rpb24oKXtDYih0aGlzKTtyZXR1cm4gbnVsbCE9dGhpcy5DP0godGhpcy5DKTpKfTtrLkQ9ZnVuY3Rpb24oKXtRZCh0aGlzKTtpZihudWxsPT10aGlzLkMpcmV0dXJuIG51bGw7Zm9yKHZhciBhPXRoaXMuQzs7KWlmKGEgaW5zdGFuY2VvZiBWKWE9UWQoYSk7ZWxzZSByZXR1cm4gdGhpcy5DPWEsRCh0aGlzLkMpfTtrLkY9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IFYoYix0aGlzLmNiLHRoaXMuQyx0aGlzLnApfTtrLkc9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gTShiLHRoaXMpfTtcblYucHJvdG90eXBlW0VhXT1mdW5jdGlvbigpe3JldHVybiB1Yyh0aGlzKX07ZnVuY3Rpb24gUmQoYSxiKXt0aGlzLkFiPWE7dGhpcy5lbmQ9Yjt0aGlzLnE9MDt0aGlzLmo9Mn1SZC5wcm90b3R5cGUuTD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmVuZH07UmQucHJvdG90eXBlLmFkZD1mdW5jdGlvbihhKXt0aGlzLkFiW3RoaXMuZW5kXT1hO3JldHVybiB0aGlzLmVuZCs9MX07UmQucHJvdG90eXBlLmNhPWZ1bmN0aW9uKCl7dmFyIGE9bmV3IFNkKHRoaXMuQWIsMCx0aGlzLmVuZCk7dGhpcy5BYj1udWxsO3JldHVybiBhfTtmdW5jdGlvbiBUZChhKXtyZXR1cm4gbmV3IFJkKEFycmF5KGEpLDApfWZ1bmN0aW9uIFNkKGEsYixjKXt0aGlzLmU9YTt0aGlzLlY9Yjt0aGlzLmVuZD1jO3RoaXMucT0wO3RoaXMuaj01MjQzMDZ9az1TZC5wcm90b3R5cGU7ay5SPWZ1bmN0aW9uKGEsYil7cmV0dXJuIERjLm4odGhpcy5lLGIsdGhpcy5lW3RoaXMuVl0sdGhpcy5WKzEpfTtcbmsuTz1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIERjLm4odGhpcy5lLGIsYyx0aGlzLlYpfTtrLlBiPWZ1bmN0aW9uKCl7aWYodGhpcy5WPT09dGhpcy5lbmQpdGhyb3cgRXJyb3IoXCItZHJvcC1maXJzdCBvZiBlbXB0eSBjaHVua1wiKTtyZXR1cm4gbmV3IFNkKHRoaXMuZSx0aGlzLlYrMSx0aGlzLmVuZCl9O2suUT1mdW5jdGlvbihhLGIpe3JldHVybiB0aGlzLmVbdGhpcy5WK2JdfTtrLiQ9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiAwPD1iJiZiPHRoaXMuZW5kLXRoaXMuVj90aGlzLmVbdGhpcy5WK2JdOmN9O2suTD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmVuZC10aGlzLlZ9O1xudmFyIFVkPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyl7cmV0dXJuIG5ldyBTZChhLGIsYyl9ZnVuY3Rpb24gYihhLGIpe3JldHVybiBuZXcgU2QoYSxiLGEubGVuZ3RoKX1mdW5jdGlvbiBjKGEpe3JldHVybiBuZXcgU2QoYSwwLGEubGVuZ3RoKX12YXIgZD1udWxsLGQ9ZnVuY3Rpb24oZCxmLGcpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGMuY2FsbCh0aGlzLGQpO2Nhc2UgMjpyZXR1cm4gYi5jYWxsKHRoaXMsZCxmKTtjYXNlIDM6cmV0dXJuIGEuY2FsbCh0aGlzLGQsZixnKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307ZC5iPWM7ZC5hPWI7ZC5jPWE7cmV0dXJuIGR9KCk7ZnVuY3Rpb24gVmQoYSxiLGMsZCl7dGhpcy5jYT1hO3RoaXMucmE9Yjt0aGlzLms9Yzt0aGlzLnA9ZDt0aGlzLmo9MzE4NTA3MzI7dGhpcy5xPTE1MzZ9az1WZC5wcm90b3R5cGU7ay50b1N0cmluZz1mdW5jdGlvbigpe3JldHVybiBlYyh0aGlzKX07XG5rLkg9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5rfTtrLlQ9ZnVuY3Rpb24oKXtpZigxPE1hKHRoaXMuY2EpKXJldHVybiBuZXcgVmQoWGIodGhpcy5jYSksdGhpcy5yYSx0aGlzLmssbnVsbCk7dmFyIGE9Q2IodGhpcy5yYSk7cmV0dXJuIG51bGw9PWE/bnVsbDphfTtrLkI9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLnA7cmV0dXJuIG51bGwhPWE/YTp0aGlzLnA9YT13Yyh0aGlzKX07ay5BPWZ1bmN0aW9uKGEsYil7cmV0dXJuIEljKHRoaXMsYil9O2suSj1mdW5jdGlvbigpe3JldHVybiBPKEosdGhpcy5rKX07ay5OPWZ1bmN0aW9uKCl7cmV0dXJuIEMuYSh0aGlzLmNhLDApfTtrLlM9ZnVuY3Rpb24oKXtyZXR1cm4gMTxNYSh0aGlzLmNhKT9uZXcgVmQoWGIodGhpcy5jYSksdGhpcy5yYSx0aGlzLmssbnVsbCk6bnVsbD09dGhpcy5yYT9KOnRoaXMucmF9O2suRD1mdW5jdGlvbigpe3JldHVybiB0aGlzfTtrLkNiPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuY2F9O1xuay5EYj1mdW5jdGlvbigpe3JldHVybiBudWxsPT10aGlzLnJhP0o6dGhpcy5yYX07ay5GPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyBWZCh0aGlzLmNhLHRoaXMucmEsYix0aGlzLnApfTtrLkc9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gTShiLHRoaXMpfTtrLkJiPWZ1bmN0aW9uKCl7cmV0dXJuIG51bGw9PXRoaXMucmE/bnVsbDp0aGlzLnJhfTtWZC5wcm90b3R5cGVbRWFdPWZ1bmN0aW9uKCl7cmV0dXJuIHVjKHRoaXMpfTtmdW5jdGlvbiBXZChhLGIpe3JldHVybiAwPT09TWEoYSk/YjpuZXcgVmQoYSxiLG51bGwsbnVsbCl9ZnVuY3Rpb24gWGQoYSxiKXthLmFkZChiKX1mdW5jdGlvbiByZChhKXtmb3IodmFyIGI9W107OylpZihEKGEpKWIucHVzaChHKGEpKSxhPUsoYSk7ZWxzZSByZXR1cm4gYn1mdW5jdGlvbiBZZChhLGIpe2lmKEVjKGEpKXJldHVybiBRKGEpO2Zvcih2YXIgYz1hLGQ9YixlPTA7OylpZigwPGQmJkQoYykpYz1LKGMpLGQtPTEsZSs9MTtlbHNlIHJldHVybiBlfVxudmFyICRkPWZ1bmN0aW9uIFpkKGIpe3JldHVybiBudWxsPT1iP251bGw6bnVsbD09SyhiKT9EKEcoYikpOk0oRyhiKSxaZChLKGIpKSl9LGFlPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIpe3JldHVybiBuZXcgVihudWxsLGZ1bmN0aW9uKCl7dmFyIGM9RChhKTtyZXR1cm4gYz9mZChjKT9XZChZYihjKSxkLmEoWmIoYyksYikpOk0oRyhjKSxkLmEoSChjKSxiKSk6Yn0sbnVsbCxudWxsKX1mdW5jdGlvbiBiKGEpe3JldHVybiBuZXcgVihudWxsLGZ1bmN0aW9uKCl7cmV0dXJuIGF9LG51bGwsbnVsbCl9ZnVuY3Rpb24gYygpe3JldHVybiBuZXcgVihudWxsLGZ1bmN0aW9uKCl7cmV0dXJuIG51bGx9LG51bGwsbnVsbCl9dmFyIGQ9bnVsbCxlPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShjLGQsZSl7dmFyIGY9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZj0wLHE9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtmPHEubGVuZ3RoOylxW2ZdPWFyZ3VtZW50c1tmKzJdLCsrZjtcbmY9bmV3IEYocSwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsYyxkLGYpfWZ1bmN0aW9uIGIoYSxjLGUpe3JldHVybiBmdW5jdGlvbiBxKGEsYil7cmV0dXJuIG5ldyBWKG51bGwsZnVuY3Rpb24oKXt2YXIgYz1EKGEpO3JldHVybiBjP2ZkKGMpP1dkKFliKGMpLHEoWmIoYyksYikpOk0oRyhjKSxxKEgoYyksYikpOnQoYik/cShHKGIpLEsoYikpOm51bGx9LG51bGwsbnVsbCl9KGQuYShhLGMpLGUpfWEuaT0yO2EuZj1mdW5jdGlvbihhKXt2YXIgYz1HKGEpO2E9SyhhKTt2YXIgZD1HKGEpO2E9SChhKTtyZXR1cm4gYihjLGQsYSl9O2EuZD1iO3JldHVybiBhfSgpLGQ9ZnVuY3Rpb24oZCxnLGgpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDA6cmV0dXJuIGMuY2FsbCh0aGlzKTtjYXNlIDE6cmV0dXJuIGIuY2FsbCh0aGlzLGQpO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsZCxnKTtkZWZhdWx0OnZhciBsPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGw9MCxtPVxuQXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtsPG0ubGVuZ3RoOyltW2xdPWFyZ3VtZW50c1tsKzJdLCsrbDtsPW5ldyBGKG0sMCl9cmV0dXJuIGUuZChkLGcsbCl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2QuaT0yO2QuZj1lLmY7ZC5sPWM7ZC5iPWI7ZC5hPWE7ZC5kPWUuZDtyZXR1cm4gZH0oKSxiZT1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMsZCl7cmV0dXJuIE0oYSxNKGIsTShjLGQpKSl9ZnVuY3Rpb24gYihhLGIsYyl7cmV0dXJuIE0oYSxNKGIsYykpfXZhciBjPW51bGwsZD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYyxkLGUsbSxwKXt2YXIgcT1udWxsO2lmKDQ8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBxPTAscz1BcnJheShhcmd1bWVudHMubGVuZ3RoLTQpO3E8cy5sZW5ndGg7KXNbcV09YXJndW1lbnRzW3ErNF0sKytxO3E9bmV3IEYocywwKX1yZXR1cm4gYi5jYWxsKHRoaXMsYyxkLGUsbSxxKX1mdW5jdGlvbiBiKGEsXG5jLGQsZSxmKXtyZXR1cm4gTShhLE0oYyxNKGQsTShlLCRkKGYpKSkpKX1hLmk9NDthLmY9ZnVuY3Rpb24oYSl7dmFyIGM9RyhhKTthPUsoYSk7dmFyIGQ9RyhhKTthPUsoYSk7dmFyIGU9RyhhKTthPUsoYSk7dmFyIHA9RyhhKTthPUgoYSk7cmV0dXJuIGIoYyxkLGUscCxhKX07YS5kPWI7cmV0dXJuIGF9KCksYz1mdW5jdGlvbihjLGYsZyxoLGwpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIEQoYyk7Y2FzZSAyOnJldHVybiBNKGMsZik7Y2FzZSAzOnJldHVybiBiLmNhbGwodGhpcyxjLGYsZyk7Y2FzZSA0OnJldHVybiBhLmNhbGwodGhpcyxjLGYsZyxoKTtkZWZhdWx0OnZhciBtPW51bGw7aWYoNDxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIG09MCxwPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtNCk7bTxwLmxlbmd0aDspcFttXT1hcmd1bWVudHNbbSs0XSwrK207bT1uZXcgRihwLDApfXJldHVybiBkLmQoYyxmLGcsaCxtKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK1xuYXJndW1lbnRzLmxlbmd0aCk7fTtjLmk9NDtjLmY9ZC5mO2MuYj1mdW5jdGlvbihhKXtyZXR1cm4gRChhKX07Yy5hPWZ1bmN0aW9uKGEsYil7cmV0dXJuIE0oYSxiKX07Yy5jPWI7Yy5uPWE7Yy5kPWQuZDtyZXR1cm4gY30oKTtmdW5jdGlvbiBjZShhKXtyZXR1cm4gUWIoYSl9XG52YXIgZGU9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKCl7cmV0dXJuIE9iKE1jKX12YXIgYj1udWxsLGM9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGMsZCxoKXt2YXIgbD1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBsPTAsbT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2w8bS5sZW5ndGg7KW1bbF09YXJndW1lbnRzW2wrMl0sKytsO2w9bmV3IEYobSwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsYyxkLGwpfWZ1bmN0aW9uIGIoYSxjLGQpe2Zvcig7OylpZihhPVBiKGEsYyksdChkKSljPUcoZCksZD1LKGQpO2Vsc2UgcmV0dXJuIGF9YS5pPTI7YS5mPWZ1bmN0aW9uKGEpe3ZhciBjPUcoYSk7YT1LKGEpO3ZhciBkPUcoYSk7YT1IKGEpO3JldHVybiBiKGMsZCxhKX07YS5kPWI7cmV0dXJuIGF9KCksYj1mdW5jdGlvbihiLGUsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMDpyZXR1cm4gYS5jYWxsKHRoaXMpO2Nhc2UgMTpyZXR1cm4gYjtjYXNlIDI6cmV0dXJuIFBiKGIsXG5lKTtkZWZhdWx0OnZhciBnPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGc9MCxoPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7ZzxoLmxlbmd0aDspaFtnXT1hcmd1bWVudHNbZysyXSwrK2c7Zz1uZXcgRihoLDApfXJldHVybiBjLmQoYixlLGcpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtiLmk9MjtiLmY9Yy5mO2IubD1hO2IuYj1mdW5jdGlvbihhKXtyZXR1cm4gYX07Yi5hPWZ1bmN0aW9uKGEsYil7cmV0dXJuIFBiKGEsYil9O2IuZD1jLmQ7cmV0dXJuIGJ9KCksZWU9ZnVuY3Rpb24oKXt2YXIgYT1udWxsLGI9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGMsZixnLGgpe3ZhciBsPW51bGw7aWYoMzxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGw9MCxtPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMyk7bDxtLmxlbmd0aDspbVtsXT1hcmd1bWVudHNbbCszXSwrK2w7bD1uZXcgRihtLDApfXJldHVybiBiLmNhbGwodGhpcyxcbmMsZixnLGwpfWZ1bmN0aW9uIGIoYSxjLGQsaCl7Zm9yKDs7KWlmKGE9UmIoYSxjLGQpLHQoaCkpYz1HKGgpLGQ9TGMoaCksaD1LKEsoaCkpO2Vsc2UgcmV0dXJuIGF9YS5pPTM7YS5mPWZ1bmN0aW9uKGEpe3ZhciBjPUcoYSk7YT1LKGEpO3ZhciBnPUcoYSk7YT1LKGEpO3ZhciBoPUcoYSk7YT1IKGEpO3JldHVybiBiKGMsZyxoLGEpfTthLmQ9YjtyZXR1cm4gYX0oKSxhPWZ1bmN0aW9uKGEsZCxlLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDM6cmV0dXJuIFJiKGEsZCxlKTtkZWZhdWx0OnZhciBnPW51bGw7aWYoMzxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGc9MCxoPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMyk7ZzxoLmxlbmd0aDspaFtnXT1hcmd1bWVudHNbZyszXSwrK2c7Zz1uZXcgRihoLDApfXJldHVybiBiLmQoYSxkLGUsZyl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2EuaT0zO2EuZj1iLmY7YS5jPWZ1bmN0aW9uKGEsXG5iLGUpe3JldHVybiBSYihhLGIsZSl9O2EuZD1iLmQ7cmV0dXJuIGF9KCksZmU9ZnVuY3Rpb24oKXt2YXIgYT1udWxsLGI9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGMsZixnKXt2YXIgaD1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBoPTAsbD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2g8bC5sZW5ndGg7KWxbaF09YXJndW1lbnRzW2grMl0sKytoO2g9bmV3IEYobCwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsYyxmLGgpfWZ1bmN0aW9uIGIoYSxjLGQpe2Zvcig7OylpZihhPVNiKGEsYyksdChkKSljPUcoZCksZD1LKGQpO2Vsc2UgcmV0dXJuIGF9YS5pPTI7YS5mPWZ1bmN0aW9uKGEpe3ZhciBjPUcoYSk7YT1LKGEpO3ZhciBnPUcoYSk7YT1IKGEpO3JldHVybiBiKGMsZyxhKX07YS5kPWI7cmV0dXJuIGF9KCksYT1mdW5jdGlvbihhLGQsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gU2IoYSxkKTtkZWZhdWx0OnZhciBmPW51bGw7aWYoMjxcbmFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZj0wLGc9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtmPGcubGVuZ3RoOylnW2ZdPWFyZ3VtZW50c1tmKzJdLCsrZjtmPW5ldyBGKGcsMCl9cmV0dXJuIGIuZChhLGQsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2EuaT0yO2EuZj1iLmY7YS5hPWZ1bmN0aW9uKGEsYil7cmV0dXJuIFNiKGEsYil9O2EuZD1iLmQ7cmV0dXJuIGF9KCksZ2U9ZnVuY3Rpb24oKXt2YXIgYT1udWxsLGI9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGMsZixnKXt2YXIgaD1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBoPTAsbD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2g8bC5sZW5ndGg7KWxbaF09YXJndW1lbnRzW2grMl0sKytoO2g9bmV3IEYobCwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsYyxmLGgpfWZ1bmN0aW9uIGIoYSxjLGQpe2Zvcig7OylpZihhPVZiKGEsYyksdChkKSljPUcoZCksZD1LKGQpO1xuZWxzZSByZXR1cm4gYX1hLmk9MjthLmY9ZnVuY3Rpb24oYSl7dmFyIGM9RyhhKTthPUsoYSk7dmFyIGc9RyhhKTthPUgoYSk7cmV0dXJuIGIoYyxnLGEpfTthLmQ9YjtyZXR1cm4gYX0oKSxhPWZ1bmN0aW9uKGEsZCxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiBWYihhLGQpO2RlZmF1bHQ6dmFyIGY9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZj0wLGc9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtmPGcubGVuZ3RoOylnW2ZdPWFyZ3VtZW50c1tmKzJdLCsrZjtmPW5ldyBGKGcsMCl9cmV0dXJuIGIuZChhLGQsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2EuaT0yO2EuZj1iLmY7YS5hPWZ1bmN0aW9uKGEsYil7cmV0dXJuIFZiKGEsYil9O2EuZD1iLmQ7cmV0dXJuIGF9KCk7XG5mdW5jdGlvbiBoZShhLGIsYyl7dmFyIGQ9RChjKTtpZigwPT09YilyZXR1cm4gYS5sP2EubCgpOmEuY2FsbChudWxsKTtjPVZhKGQpO3ZhciBlPVdhKGQpO2lmKDE9PT1iKXJldHVybiBhLmI/YS5iKGMpOmEuYj9hLmIoYyk6YS5jYWxsKG51bGwsYyk7dmFyIGQ9VmEoZSksZj1XYShlKTtpZigyPT09YilyZXR1cm4gYS5hP2EuYShjLGQpOmEuYT9hLmEoYyxkKTphLmNhbGwobnVsbCxjLGQpO3ZhciBlPVZhKGYpLGc9V2EoZik7aWYoMz09PWIpcmV0dXJuIGEuYz9hLmMoYyxkLGUpOmEuYz9hLmMoYyxkLGUpOmEuY2FsbChudWxsLGMsZCxlKTt2YXIgZj1WYShnKSxoPVdhKGcpO2lmKDQ9PT1iKXJldHVybiBhLm4/YS5uKGMsZCxlLGYpOmEubj9hLm4oYyxkLGUsZik6YS5jYWxsKG51bGwsYyxkLGUsZik7dmFyIGc9VmEoaCksbD1XYShoKTtpZig1PT09YilyZXR1cm4gYS5yP2EucihjLGQsZSxmLGcpOmEucj9hLnIoYyxkLGUsZixnKTphLmNhbGwobnVsbCxjLGQsZSxmLGcpO3ZhciBoPVZhKGwpLFxubT1XYShsKTtpZig2PT09YilyZXR1cm4gYS5QP2EuUChjLGQsZSxmLGcsaCk6YS5QP2EuUChjLGQsZSxmLGcsaCk6YS5jYWxsKG51bGwsYyxkLGUsZixnLGgpO3ZhciBsPVZhKG0pLHA9V2EobSk7aWYoNz09PWIpcmV0dXJuIGEuaWE/YS5pYShjLGQsZSxmLGcsaCxsKTphLmlhP2EuaWEoYyxkLGUsZixnLGgsbCk6YS5jYWxsKG51bGwsYyxkLGUsZixnLGgsbCk7dmFyIG09VmEocCkscT1XYShwKTtpZig4PT09YilyZXR1cm4gYS5HYT9hLkdhKGMsZCxlLGYsZyxoLGwsbSk6YS5HYT9hLkdhKGMsZCxlLGYsZyxoLGwsbSk6YS5jYWxsKG51bGwsYyxkLGUsZixnLGgsbCxtKTt2YXIgcD1WYShxKSxzPVdhKHEpO2lmKDk9PT1iKXJldHVybiBhLkhhP2EuSGEoYyxkLGUsZixnLGgsbCxtLHApOmEuSGE/YS5IYShjLGQsZSxmLGcsaCxsLG0scCk6YS5jYWxsKG51bGwsYyxkLGUsZixnLGgsbCxtLHApO3ZhciBxPVZhKHMpLHU9V2Eocyk7aWYoMTA9PT1iKXJldHVybiBhLnZhP2EudmEoYyxkLGUsXG5mLGcsaCxsLG0scCxxKTphLnZhP2EudmEoYyxkLGUsZixnLGgsbCxtLHAscSk6YS5jYWxsKG51bGwsYyxkLGUsZixnLGgsbCxtLHAscSk7dmFyIHM9VmEodSksdj1XYSh1KTtpZigxMT09PWIpcmV0dXJuIGEud2E/YS53YShjLGQsZSxmLGcsaCxsLG0scCxxLHMpOmEud2E/YS53YShjLGQsZSxmLGcsaCxsLG0scCxxLHMpOmEuY2FsbChudWxsLGMsZCxlLGYsZyxoLGwsbSxwLHEscyk7dmFyIHU9VmEodikseT1XYSh2KTtpZigxMj09PWIpcmV0dXJuIGEueGE/YS54YShjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSk6YS54YT9hLnhhKGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1KTphLmNhbGwobnVsbCxjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSk7dmFyIHY9VmEoeSksQj1XYSh5KTtpZigxMz09PWIpcmV0dXJuIGEueWE/YS55YShjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2KTphLnlhP2EueWEoYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdik6YS5jYWxsKG51bGwsYyxkLGUsZixnLGgsbCxtLHAsXG5xLHMsdSx2KTt2YXIgeT1WYShCKSxFPVdhKEIpO2lmKDE0PT09YilyZXR1cm4gYS56YT9hLnphKGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSk6YS56YT9hLnphKGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSk6YS5jYWxsKG51bGwsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5KTt2YXIgQj1WYShFKSxOPVdhKEUpO2lmKDE1PT09YilyZXR1cm4gYS5BYT9hLkFhKGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCKTphLkFhP2EuQWEoYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIpOmEuY2FsbChudWxsLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCKTt2YXIgRT1WYShOKSxZPVdhKE4pO2lmKDE2PT09YilyZXR1cm4gYS5CYT9hLkJhKGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCLEUpOmEuQmE/YS5CYShjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQixFKTphLmNhbGwobnVsbCxjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQixFKTt2YXIgTj1cblZhKFkpLHJhPVdhKFkpO2lmKDE3PT09YilyZXR1cm4gYS5DYT9hLkNhKGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCLEUsTik6YS5DYT9hLkNhKGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCLEUsTik6YS5jYWxsKG51bGwsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIsRSxOKTt2YXIgWT1WYShyYSksUGE9V2EocmEpO2lmKDE4PT09YilyZXR1cm4gYS5EYT9hLkRhKGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCLEUsTixZKTphLkRhP2EuRGEoYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIsRSxOLFkpOmEuY2FsbChudWxsLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCLEUsTixZKTtyYT1WYShQYSk7UGE9V2EoUGEpO2lmKDE5PT09YilyZXR1cm4gYS5FYT9hLkVhKGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCLEUsTixZLHJhKTphLkVhP2EuRWEoYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIsRSxOLFkscmEpOmEuY2FsbChudWxsLFxuYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIsRSxOLFkscmEpO3ZhciBJPVZhKFBhKTtXYShQYSk7aWYoMjA9PT1iKXJldHVybiBhLkZhP2EuRmEoYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIsRSxOLFkscmEsSSk6YS5GYT9hLkZhKGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCLEUsTixZLHJhLEkpOmEuY2FsbChudWxsLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCLEUsTixZLHJhLEkpO3Rocm93IEVycm9yKFwiT25seSB1cCB0byAyMCBhcmd1bWVudHMgc3VwcG9ydGVkIG9uIGZ1bmN0aW9uc1wiKTt9XG52YXIgVD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMsZCxlKXtiPWJlLm4oYixjLGQsZSk7Yz1hLmk7cmV0dXJuIGEuZj8oZD1ZZChiLGMrMSksZDw9Yz9oZShhLGQsYik6YS5mKGIpKTphLmFwcGx5KGEscmQoYikpfWZ1bmN0aW9uIGIoYSxiLGMsZCl7Yj1iZS5jKGIsYyxkKTtjPWEuaTtyZXR1cm4gYS5mPyhkPVlkKGIsYysxKSxkPD1jP2hlKGEsZCxiKTphLmYoYikpOmEuYXBwbHkoYSxyZChiKSl9ZnVuY3Rpb24gYyhhLGIsYyl7Yj1iZS5hKGIsYyk7Yz1hLmk7aWYoYS5mKXt2YXIgZD1ZZChiLGMrMSk7cmV0dXJuIGQ8PWM/aGUoYSxkLGIpOmEuZihiKX1yZXR1cm4gYS5hcHBseShhLHJkKGIpKX1mdW5jdGlvbiBkKGEsYil7dmFyIGM9YS5pO2lmKGEuZil7dmFyIGQ9WWQoYixjKzEpO3JldHVybiBkPD1jP2hlKGEsZCxiKTphLmYoYil9cmV0dXJuIGEuYXBwbHkoYSxyZChiKSl9dmFyIGU9bnVsbCxmPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShjLGQsZSxmLGcsdSl7dmFyIHY9bnVsbDtcbmlmKDU8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciB2PTAseT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTUpO3Y8eS5sZW5ndGg7KXlbdl09YXJndW1lbnRzW3YrNV0sKyt2O3Y9bmV3IEYoeSwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsYyxkLGUsZixnLHYpfWZ1bmN0aW9uIGIoYSxjLGQsZSxmLGcpe2M9TShjLE0oZCxNKGUsTShmLCRkKGcpKSkpKTtkPWEuaTtyZXR1cm4gYS5mPyhlPVlkKGMsZCsxKSxlPD1kP2hlKGEsZSxjKTphLmYoYykpOmEuYXBwbHkoYSxyZChjKSl9YS5pPTU7YS5mPWZ1bmN0aW9uKGEpe3ZhciBjPUcoYSk7YT1LKGEpO3ZhciBkPUcoYSk7YT1LKGEpO3ZhciBlPUcoYSk7YT1LKGEpO3ZhciBmPUcoYSk7YT1LKGEpO3ZhciBnPUcoYSk7YT1IKGEpO3JldHVybiBiKGMsZCxlLGYsZyxhKX07YS5kPWI7cmV0dXJuIGF9KCksZT1mdW5jdGlvbihlLGgsbCxtLHAscSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gZC5jYWxsKHRoaXMsZSxoKTtjYXNlIDM6cmV0dXJuIGMuY2FsbCh0aGlzLFxuZSxoLGwpO2Nhc2UgNDpyZXR1cm4gYi5jYWxsKHRoaXMsZSxoLGwsbSk7Y2FzZSA1OnJldHVybiBhLmNhbGwodGhpcyxlLGgsbCxtLHApO2RlZmF1bHQ6dmFyIHM9bnVsbDtpZig1PGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgcz0wLHU9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC01KTtzPHUubGVuZ3RoOyl1W3NdPWFyZ3VtZW50c1tzKzVdLCsrcztzPW5ldyBGKHUsMCl9cmV0dXJuIGYuZChlLGgsbCxtLHAscyl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2UuaT01O2UuZj1mLmY7ZS5hPWQ7ZS5jPWM7ZS5uPWI7ZS5yPWE7ZS5kPWYuZDtyZXR1cm4gZX0oKSxpZT1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMsZCxlLGYpe3ZhciBnPU8sdj1WYyhhKTtiPWIucj9iLnIodixjLGQsZSxmKTpiLmNhbGwobnVsbCx2LGMsZCxlLGYpO3JldHVybiBnKGEsYil9ZnVuY3Rpb24gYihhLGIsYyxkLGUpe3ZhciBmPU8sZz1WYyhhKTtiPWIubj9iLm4oZyxcbmMsZCxlKTpiLmNhbGwobnVsbCxnLGMsZCxlKTtyZXR1cm4gZihhLGIpfWZ1bmN0aW9uIGMoYSxiLGMsZCl7dmFyIGU9TyxmPVZjKGEpO2I9Yi5jP2IuYyhmLGMsZCk6Yi5jYWxsKG51bGwsZixjLGQpO3JldHVybiBlKGEsYil9ZnVuY3Rpb24gZChhLGIsYyl7dmFyIGQ9TyxlPVZjKGEpO2I9Yi5hP2IuYShlLGMpOmIuY2FsbChudWxsLGUsYyk7cmV0dXJuIGQoYSxiKX1mdW5jdGlvbiBlKGEsYil7dmFyIGM9TyxkO2Q9VmMoYSk7ZD1iLmI/Yi5iKGQpOmIuY2FsbChudWxsLGQpO3JldHVybiBjKGEsZCl9dmFyIGY9bnVsbCxnPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShjLGQsZSxmLGcsaCx5KXt2YXIgQj1udWxsO2lmKDY8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBCPTAsRT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTYpO0I8RS5sZW5ndGg7KUVbQl09YXJndW1lbnRzW0IrNl0sKytCO0I9bmV3IEYoRSwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsYyxkLGUsZixnLGgsQil9ZnVuY3Rpb24gYihhLFxuYyxkLGUsZixnLGgpe3JldHVybiBPKGEsVC5kKGMsVmMoYSksZCxlLGYsS2MoW2csaF0sMCkpKX1hLmk9NjthLmY9ZnVuY3Rpb24oYSl7dmFyIGM9RyhhKTthPUsoYSk7dmFyIGQ9RyhhKTthPUsoYSk7dmFyIGU9RyhhKTthPUsoYSk7dmFyIGY9RyhhKTthPUsoYSk7dmFyIGc9RyhhKTthPUsoYSk7dmFyIGg9RyhhKTthPUgoYSk7cmV0dXJuIGIoYyxkLGUsZixnLGgsYSl9O2EuZD1iO3JldHVybiBhfSgpLGY9ZnVuY3Rpb24oZixsLG0scCxxLHMsdSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gZS5jYWxsKHRoaXMsZixsKTtjYXNlIDM6cmV0dXJuIGQuY2FsbCh0aGlzLGYsbCxtKTtjYXNlIDQ6cmV0dXJuIGMuY2FsbCh0aGlzLGYsbCxtLHApO2Nhc2UgNTpyZXR1cm4gYi5jYWxsKHRoaXMsZixsLG0scCxxKTtjYXNlIDY6cmV0dXJuIGEuY2FsbCh0aGlzLGYsbCxtLHAscSxzKTtkZWZhdWx0OnZhciB2PW51bGw7aWYoNjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIHY9XG4wLHk9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC02KTt2PHkubGVuZ3RoOyl5W3ZdPWFyZ3VtZW50c1t2KzZdLCsrdjt2PW5ldyBGKHksMCl9cmV0dXJuIGcuZChmLGwsbSxwLHEscyx2KX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Zi5pPTY7Zi5mPWcuZjtmLmE9ZTtmLmM9ZDtmLm49YztmLnI9YjtmLlA9YTtmLmQ9Zy5kO3JldHVybiBmfSgpLGplPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIpe3JldHVybiFzYy5hKGEsYil9dmFyIGI9bnVsbCxjPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShjLGQsaCl7dmFyIGw9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgbD0wLG09QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtsPG0ubGVuZ3RoOyltW2xdPWFyZ3VtZW50c1tsKzJdLCsrbDtsPW5ldyBGKG0sMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGMsZCxsKX1mdW5jdGlvbiBiKGEsYyxkKXtyZXR1cm4gQWEoVC5uKHNjLGEsYyxkKSl9YS5pPVxuMjthLmY9ZnVuY3Rpb24oYSl7dmFyIGM9RyhhKTthPUsoYSk7dmFyIGQ9RyhhKTthPUgoYSk7cmV0dXJuIGIoYyxkLGEpfTthLmQ9YjtyZXR1cm4gYX0oKSxiPWZ1bmN0aW9uKGIsZSxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiExO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYixlKTtkZWZhdWx0OnZhciBnPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGc9MCxoPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7ZzxoLmxlbmd0aDspaFtnXT1hcmd1bWVudHNbZysyXSwrK2c7Zz1uZXcgRihoLDApfXJldHVybiBjLmQoYixlLGcpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtiLmk9MjtiLmY9Yy5mO2IuYj1mdW5jdGlvbigpe3JldHVybiExfTtiLmE9YTtiLmQ9Yy5kO3JldHVybiBifSgpLHFlPWZ1bmN0aW9uIGtlKCl7XCJ1bmRlZmluZWRcIj09PXR5cGVvZiBqYSYmKGphPWZ1bmN0aW9uKGIsYyl7dGhpcy5wYz1cbmI7dGhpcy5vYz1jO3RoaXMucT0wO3RoaXMuaj0zOTMyMTZ9LGphLnByb3RvdHlwZS5nYT1mdW5jdGlvbigpe3JldHVybiExfSxqYS5wcm90b3R5cGUubmV4dD1mdW5jdGlvbigpe3JldHVybiBFcnJvcihcIk5vIHN1Y2ggZWxlbWVudFwiKX0samEucHJvdG90eXBlLkg9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5vY30samEucHJvdG90eXBlLkY9ZnVuY3Rpb24oYixjKXtyZXR1cm4gbmV3IGphKHRoaXMucGMsYyl9LGphLlliPSEwLGphLlhiPVwiY2xqcy5jb3JlL3QxMjY2MFwiLGphLm5jPWZ1bmN0aW9uKGIpe3JldHVybiBMYihiLFwiY2xqcy5jb3JlL3QxMjY2MFwiKX0pO3JldHVybiBuZXcgamEoa2UsbmV3IHBhKG51bGwsNSxbbGUsNTQsbWUsMjk5OCxuZSwzLG9lLDI5OTQscGUsXCIvVXNlcnMvZGF2aWRub2xlbi9kZXZlbG9wbWVudC9jbG9qdXJlL21vcmkvb3V0LW1vcmktYWR2L2NsanMvY29yZS5jbGpzXCJdLG51bGwpKX07ZnVuY3Rpb24gcmUoYSxiKXt0aGlzLkM9YTt0aGlzLm09Yn1cbnJlLnByb3RvdHlwZS5nYT1mdW5jdGlvbigpe3JldHVybiB0aGlzLm08dGhpcy5DLmxlbmd0aH07cmUucHJvdG90eXBlLm5leHQ9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLkMuY2hhckF0KHRoaXMubSk7dGhpcy5tKz0xO3JldHVybiBhfTtmdW5jdGlvbiBzZShhLGIpe3RoaXMuZT1hO3RoaXMubT1ifXNlLnByb3RvdHlwZS5nYT1mdW5jdGlvbigpe3JldHVybiB0aGlzLm08dGhpcy5lLmxlbmd0aH07c2UucHJvdG90eXBlLm5leHQ9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLmVbdGhpcy5tXTt0aGlzLm0rPTE7cmV0dXJuIGF9O3ZhciB0ZT17fSx1ZT17fTtmdW5jdGlvbiB2ZShhLGIpe3RoaXMuZWI9YTt0aGlzLlFhPWJ9dmUucHJvdG90eXBlLmdhPWZ1bmN0aW9uKCl7dGhpcy5lYj09PXRlPyh0aGlzLmViPXVlLHRoaXMuUWE9RCh0aGlzLlFhKSk6dGhpcy5lYj09PXRoaXMuUWEmJih0aGlzLlFhPUsodGhpcy5lYikpO3JldHVybiBudWxsIT10aGlzLlFhfTtcbnZlLnByb3RvdHlwZS5uZXh0PWZ1bmN0aW9uKCl7aWYoQWEodGhpcy5nYSgpKSl0aHJvdyBFcnJvcihcIk5vIHN1Y2ggZWxlbWVudFwiKTt0aGlzLmViPXRoaXMuUWE7cmV0dXJuIEcodGhpcy5RYSl9O2Z1bmN0aW9uIHdlKGEpe2lmKG51bGw9PWEpcmV0dXJuIHFlKCk7aWYoXCJzdHJpbmdcIj09PXR5cGVvZiBhKXJldHVybiBuZXcgcmUoYSwwKTtpZihhIGluc3RhbmNlb2YgQXJyYXkpcmV0dXJuIG5ldyBzZShhLDApO2lmKGE/dCh0KG51bGwpP251bGw6YS52Yil8fChhLnliPzA6dyhiYyxhKSk6dyhiYyxhKSlyZXR1cm4gY2MoYSk7aWYobGQoYSkpcmV0dXJuIG5ldyB2ZSh0ZSxhKTt0aHJvdyBFcnJvcihbeihcIkNhbm5vdCBjcmVhdGUgaXRlcmF0b3IgZnJvbSBcIikseihhKV0uam9pbihcIlwiKSk7fWZ1bmN0aW9uIHhlKGEsYil7dGhpcy5mYT1hO3RoaXMuJGI9Yn1cbnhlLnByb3RvdHlwZS5zdGVwPWZ1bmN0aW9uKGEpe2Zvcih2YXIgYj10aGlzOzspe2lmKHQoZnVuY3Rpb24oKXt2YXIgYz1udWxsIT1hLlg7cmV0dXJuIGM/Yi4kYi5nYSgpOmN9KCkpKWlmKEFjKGZ1bmN0aW9uKCl7dmFyIGM9Yi4kYi5uZXh0KCk7cmV0dXJuIGIuZmEuYT9iLmZhLmEoYSxjKTpiLmZhLmNhbGwobnVsbCxhLGMpfSgpKSludWxsIT1hLk0mJihhLk0uWD1udWxsKTtlbHNlIGNvbnRpbnVlO2JyZWFrfXJldHVybiBudWxsPT1hLlg/bnVsbDpiLmZhLmI/Yi5mYS5iKGEpOmIuZmEuY2FsbChudWxsLGEpfTtcbmZ1bmN0aW9uIHllKGEsYil7dmFyIGM9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGIsYyl7Yi5maXJzdD1jO2IuTT1uZXcgemUoYi5YLG51bGwsbnVsbCxudWxsKTtiLlg9bnVsbDtyZXR1cm4gYi5NfWZ1bmN0aW9uIGIoYSl7KEFjKGEpP3FiKGEpOmEpLlg9bnVsbDtyZXR1cm4gYX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiLmNhbGwodGhpcyxjKTtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYj1iO2MuYT1hO3JldHVybiBjfSgpO3JldHVybiBuZXcgeGUoYS5iP2EuYihjKTphLmNhbGwobnVsbCxjKSxiKX1mdW5jdGlvbiBBZShhLGIsYyl7dGhpcy5mYT1hO3RoaXMuS2I9Yjt0aGlzLmFjPWN9XG5BZS5wcm90b3R5cGUuZ2E9ZnVuY3Rpb24oKXtmb3IodmFyIGE9RCh0aGlzLktiKTs7KWlmKG51bGwhPWEpe3ZhciBiPUcoYSk7aWYoQWEoYi5nYSgpKSlyZXR1cm4hMTthPUsoYSl9ZWxzZSByZXR1cm4hMH07QWUucHJvdG90eXBlLm5leHQ9ZnVuY3Rpb24oKXtmb3IodmFyIGE9dGhpcy5LYi5sZW5ndGgsYj0wOzspaWYoYjxhKXRoaXMuYWNbYl09dGhpcy5LYltiXS5uZXh0KCksYis9MTtlbHNlIGJyZWFrO3JldHVybiBKYy5hKHRoaXMuYWMsMCl9O0FlLnByb3RvdHlwZS5zdGVwPWZ1bmN0aW9uKGEpe2Zvcig7Oyl7dmFyIGI7Yj0oYj1udWxsIT1hLlgpP3RoaXMuZ2EoKTpiO2lmKHQoYikpaWYoQWMoVC5hKHRoaXMuZmEsTShhLHRoaXMubmV4dCgpKSkpKW51bGwhPWEuTSYmKGEuTS5YPW51bGwpO2Vsc2UgY29udGludWU7YnJlYWt9cmV0dXJuIG51bGw9PWEuWD9udWxsOnRoaXMuZmEuYj90aGlzLmZhLmIoYSk6dGhpcy5mYS5jYWxsKG51bGwsYSl9O1xudmFyIEJlPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyl7dmFyIGc9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGIsYyl7Yi5maXJzdD1jO2IuTT1uZXcgemUoYi5YLG51bGwsbnVsbCxudWxsKTtiLlg9bnVsbDtyZXR1cm4gYi5NfWZ1bmN0aW9uIGIoYSl7YT1BYyhhKT9xYihhKTphO2EuWD1udWxsO3JldHVybiBhfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGQpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGIuY2FsbCh0aGlzLGMpO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYyxkKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5iPWI7Yy5hPWE7cmV0dXJuIGN9KCk7cmV0dXJuIG5ldyBBZShhLmI/YS5iKGcpOmEuY2FsbChudWxsLGcpLGIsYyl9ZnVuY3Rpb24gYihhLGIpe3JldHVybiBjLmMoYSxiLEFycmF5KGIubGVuZ3RoKSl9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiBiLmNhbGwodGhpcyxcbmMsZSk7Y2FzZSAzOnJldHVybiBhLmNhbGwodGhpcyxjLGUsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYT1iO2MuYz1hO3JldHVybiBjfSgpO2Z1bmN0aW9uIHplKGEsYixjLGQpe3RoaXMuWD1hO3RoaXMuZmlyc3Q9Yjt0aGlzLk09Yzt0aGlzLms9ZDt0aGlzLnE9MDt0aGlzLmo9MzE3MTk2Mjh9az16ZS5wcm90b3R5cGU7ay5UPWZ1bmN0aW9uKCl7bnVsbCE9dGhpcy5YJiZDYih0aGlzKTtyZXR1cm4gbnVsbD09dGhpcy5NP251bGw6Q2IodGhpcy5NKX07ay5OPWZ1bmN0aW9uKCl7bnVsbCE9dGhpcy5YJiZDYih0aGlzKTtyZXR1cm4gbnVsbD09dGhpcy5NP251bGw6dGhpcy5maXJzdH07ay5TPWZ1bmN0aW9uKCl7bnVsbCE9dGhpcy5YJiZDYih0aGlzKTtyZXR1cm4gbnVsbD09dGhpcy5NP0o6dGhpcy5NfTtcbmsuRD1mdW5jdGlvbigpe251bGwhPXRoaXMuWCYmdGhpcy5YLnN0ZXAodGhpcyk7cmV0dXJuIG51bGw9PXRoaXMuTT9udWxsOnRoaXN9O2suQj1mdW5jdGlvbigpe3JldHVybiB3Yyh0aGlzKX07ay5BPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG51bGwhPUNiKHRoaXMpP0ljKHRoaXMsYik6Y2QoYikmJm51bGw9PUQoYil9O2suSj1mdW5jdGlvbigpe3JldHVybiBKfTtrLkc9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gTShiLENiKHRoaXMpKX07ay5GPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyB6ZSh0aGlzLlgsdGhpcy5maXJzdCx0aGlzLk0sYil9O3plLnByb3RvdHlwZVtFYV09ZnVuY3Rpb24oKXtyZXR1cm4gdWModGhpcyl9O1xudmFyIENlPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhKXtyZXR1cm4ga2QoYSk/YTooYT1EKGEpKT9hOkp9dmFyIGI9bnVsbCxjPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShjLGQsaCl7dmFyIGw9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgbD0wLG09QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtsPG0ubGVuZ3RoOyltW2xdPWFyZ3VtZW50c1tsKzJdLCsrbDtsPW5ldyBGKG0sMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGMsZCxsKX1mdW5jdGlvbiBiKGEsYyxkKXtkPXJkKE0oYyxkKSk7Yz1bXTtkPUQoZCk7Zm9yKHZhciBlPW51bGwsbT0wLHA9MDs7KWlmKHA8bSl7dmFyIHE9ZS5RKG51bGwscCk7Yy5wdXNoKHdlKHEpKTtwKz0xfWVsc2UgaWYoZD1EKGQpKWU9ZCxmZChlKT8oZD1ZYihlKSxwPVpiKGUpLGU9ZCxtPVEoZCksZD1wKTooZD1HKGUpLGMucHVzaCh3ZShkKSksZD1LKGUpLGU9bnVsbCxtPTApLHA9MDtlbHNlIGJyZWFrO3JldHVybiBuZXcgemUoQmUuYyhhLGMsXG5BcnJheShjLmxlbmd0aCkpLG51bGwsbnVsbCxudWxsKX1hLmk9MjthLmY9ZnVuY3Rpb24oYSl7dmFyIGM9RyhhKTthPUsoYSk7dmFyIGQ9RyhhKTthPUgoYSk7cmV0dXJuIGIoYyxkLGEpfTthLmQ9YjtyZXR1cm4gYX0oKSxiPWZ1bmN0aW9uKGIsZSxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBhLmNhbGwodGhpcyxiKTtjYXNlIDI6cmV0dXJuIG5ldyB6ZSh5ZShiLHdlKGUpKSxudWxsLG51bGwsbnVsbCk7ZGVmYXVsdDp2YXIgZz1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBnPTAsaD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2c8aC5sZW5ndGg7KWhbZ109YXJndW1lbnRzW2crMl0sKytnO2c9bmV3IEYoaCwwKX1yZXR1cm4gYy5kKGIsZSxnKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yi5pPTI7Yi5mPWMuZjtiLmI9YTtiLmE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IHplKHllKGEsXG53ZShiKSksbnVsbCxudWxsLG51bGwpfTtiLmQ9Yy5kO3JldHVybiBifSgpO2Z1bmN0aW9uIEVlKGEsYil7Zm9yKDs7KXtpZihudWxsPT1EKGIpKXJldHVybiEwO3ZhciBjO2M9RyhiKTtjPWEuYj9hLmIoYyk6YS5jYWxsKG51bGwsYyk7aWYodChjKSl7Yz1hO3ZhciBkPUsoYik7YT1jO2I9ZH1lbHNlIHJldHVybiExfX1mdW5jdGlvbiBGZShhLGIpe2Zvcig7OylpZihEKGIpKXt2YXIgYztjPUcoYik7Yz1hLmI/YS5iKGMpOmEuY2FsbChudWxsLGMpO2lmKHQoYykpcmV0dXJuIGM7Yz1hO3ZhciBkPUsoYik7YT1jO2I9ZH1lbHNlIHJldHVybiBudWxsfWZ1bmN0aW9uIEdlKGEpe2lmKFwibnVtYmVyXCI9PT10eXBlb2YgYSYmQWEoaXNOYU4oYSkpJiZJbmZpbml0eSE9PWEmJnBhcnNlRmxvYXQoYSk9PT1wYXJzZUludChhLDEwKSlyZXR1cm4gMD09PShhJjEpO3Rocm93IEVycm9yKFt6KFwiQXJndW1lbnQgbXVzdCBiZSBhbiBpbnRlZ2VyOiBcIikseihhKV0uam9pbihcIlwiKSk7fVxuZnVuY3Rpb24gSGUoYSl7cmV0dXJuIGZ1bmN0aW9uKCl7ZnVuY3Rpb24gYihiLGMpe3JldHVybiBBYShhLmE/YS5hKGIsYyk6YS5jYWxsKG51bGwsYixjKSl9ZnVuY3Rpb24gYyhiKXtyZXR1cm4gQWEoYS5iP2EuYihiKTphLmNhbGwobnVsbCxiKSl9ZnVuY3Rpb24gZCgpe3JldHVybiBBYShhLmw/YS5sKCk6YS5jYWxsKG51bGwpKX12YXIgZT1udWxsLGY9ZnVuY3Rpb24oKXtmdW5jdGlvbiBiKGEsZCxlKXt2YXIgZj1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBmPTAsZz1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2Y8Zy5sZW5ndGg7KWdbZl09YXJndW1lbnRzW2YrMl0sKytmO2Y9bmV3IEYoZywwKX1yZXR1cm4gYy5jYWxsKHRoaXMsYSxkLGYpfWZ1bmN0aW9uIGMoYixkLGUpe3JldHVybiBBYShULm4oYSxiLGQsZSkpfWIuaT0yO2IuZj1mdW5jdGlvbihhKXt2YXIgYj1HKGEpO2E9SyhhKTt2YXIgZD1HKGEpO2E9SChhKTtyZXR1cm4gYyhiLGQsYSl9O2IuZD1jO1xucmV0dXJuIGJ9KCksZT1mdW5jdGlvbihhLGUsbCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMDpyZXR1cm4gZC5jYWxsKHRoaXMpO2Nhc2UgMTpyZXR1cm4gYy5jYWxsKHRoaXMsYSk7Y2FzZSAyOnJldHVybiBiLmNhbGwodGhpcyxhLGUpO2RlZmF1bHQ6dmFyIG09bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgbT0wLHA9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTttPHAubGVuZ3RoOylwW21dPWFyZ3VtZW50c1ttKzJdLCsrbTttPW5ldyBGKHAsMCl9cmV0dXJuIGYuZChhLGUsbSl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2UuaT0yO2UuZj1mLmY7ZS5sPWQ7ZS5iPWM7ZS5hPWI7ZS5kPWYuZDtyZXR1cm4gZX0oKX1cbnZhciBJZT1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMpe3JldHVybiBmdW5jdGlvbigpe2Z1bmN0aW9uIGQoaCxsLG0pe2g9Yy5jP2MuYyhoLGwsbSk6Yy5jYWxsKG51bGwsaCxsLG0pO2g9Yi5iP2IuYihoKTpiLmNhbGwobnVsbCxoKTtyZXR1cm4gYS5iP2EuYihoKTphLmNhbGwobnVsbCxoKX1mdW5jdGlvbiBsKGQsaCl7dmFyIGw7bD1jLmE/Yy5hKGQsaCk6Yy5jYWxsKG51bGwsZCxoKTtsPWIuYj9iLmIobCk6Yi5jYWxsKG51bGwsbCk7cmV0dXJuIGEuYj9hLmIobCk6YS5jYWxsKG51bGwsbCl9ZnVuY3Rpb24gbShkKXtkPWMuYj9jLmIoZCk6Yy5jYWxsKG51bGwsZCk7ZD1iLmI/Yi5iKGQpOmIuY2FsbChudWxsLGQpO3JldHVybiBhLmI/YS5iKGQpOmEuY2FsbChudWxsLGQpfWZ1bmN0aW9uIHAoKXt2YXIgZDtkPWMubD9jLmwoKTpjLmNhbGwobnVsbCk7ZD1iLmI/Yi5iKGQpOmIuY2FsbChudWxsLGQpO3JldHVybiBhLmI/YS5iKGQpOmEuY2FsbChudWxsLGQpfXZhciBxPW51bGwsXG5zPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gZChhLGIsYyxlKXt2YXIgZj1udWxsO2lmKDM8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBmPTAsZz1BcnJheShhcmd1bWVudHMubGVuZ3RoLTMpO2Y8Zy5sZW5ndGg7KWdbZl09YXJndW1lbnRzW2YrM10sKytmO2Y9bmV3IEYoZywwKX1yZXR1cm4gaC5jYWxsKHRoaXMsYSxiLGMsZil9ZnVuY3Rpb24gaChkLGwsbSxwKXtkPVQucihjLGQsbCxtLHApO2Q9Yi5iP2IuYihkKTpiLmNhbGwobnVsbCxkKTtyZXR1cm4gYS5iP2EuYihkKTphLmNhbGwobnVsbCxkKX1kLmk9MztkLmY9ZnVuY3Rpb24oYSl7dmFyIGI9RyhhKTthPUsoYSk7dmFyIGM9RyhhKTthPUsoYSk7dmFyIGQ9RyhhKTthPUgoYSk7cmV0dXJuIGgoYixjLGQsYSl9O2QuZD1oO3JldHVybiBkfSgpLHE9ZnVuY3Rpb24oYSxiLGMsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMDpyZXR1cm4gcC5jYWxsKHRoaXMpO2Nhc2UgMTpyZXR1cm4gbS5jYWxsKHRoaXMsYSk7Y2FzZSAyOnJldHVybiBsLmNhbGwodGhpcyxcbmEsYik7Y2FzZSAzOnJldHVybiBkLmNhbGwodGhpcyxhLGIsYyk7ZGVmYXVsdDp2YXIgZj1udWxsO2lmKDM8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBmPTAsZz1BcnJheShhcmd1bWVudHMubGVuZ3RoLTMpO2Y8Zy5sZW5ndGg7KWdbZl09YXJndW1lbnRzW2YrM10sKytmO2Y9bmV3IEYoZywwKX1yZXR1cm4gcy5kKGEsYixjLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtxLmk9MztxLmY9cy5mO3EubD1wO3EuYj1tO3EuYT1sO3EuYz1kO3EuZD1zLmQ7cmV0dXJuIHF9KCl9ZnVuY3Rpb24gYihhLGIpe3JldHVybiBmdW5jdGlvbigpe2Z1bmN0aW9uIGMoZCxnLGgpe2Q9Yi5jP2IuYyhkLGcsaCk6Yi5jYWxsKG51bGwsZCxnLGgpO3JldHVybiBhLmI/YS5iKGQpOmEuY2FsbChudWxsLGQpfWZ1bmN0aW9uIGQoYyxnKXt2YXIgaD1iLmE/Yi5hKGMsZyk6Yi5jYWxsKG51bGwsYyxnKTtyZXR1cm4gYS5iP2EuYihoKTphLmNhbGwobnVsbCxoKX1cbmZ1bmN0aW9uIGwoYyl7Yz1iLmI/Yi5iKGMpOmIuY2FsbChudWxsLGMpO3JldHVybiBhLmI/YS5iKGMpOmEuY2FsbChudWxsLGMpfWZ1bmN0aW9uIG0oKXt2YXIgYz1iLmw/Yi5sKCk6Yi5jYWxsKG51bGwpO3JldHVybiBhLmI/YS5iKGMpOmEuY2FsbChudWxsLGMpfXZhciBwPW51bGwscT1mdW5jdGlvbigpe2Z1bmN0aW9uIGMoYSxiLGUsZil7dmFyIGc9bnVsbDtpZigzPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZz0wLGg9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0zKTtnPGgubGVuZ3RoOyloW2ddPWFyZ3VtZW50c1tnKzNdLCsrZztnPW5ldyBGKGgsMCl9cmV0dXJuIGQuY2FsbCh0aGlzLGEsYixlLGcpfWZ1bmN0aW9uIGQoYyxnLGgsbCl7Yz1ULnIoYixjLGcsaCxsKTtyZXR1cm4gYS5iP2EuYihjKTphLmNhbGwobnVsbCxjKX1jLmk9MztjLmY9ZnVuY3Rpb24oYSl7dmFyIGI9RyhhKTthPUsoYSk7dmFyIGM9RyhhKTthPUsoYSk7dmFyIGU9RyhhKTthPUgoYSk7cmV0dXJuIGQoYixcbmMsZSxhKX07Yy5kPWQ7cmV0dXJuIGN9KCkscD1mdW5jdGlvbihhLGIsZSxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAwOnJldHVybiBtLmNhbGwodGhpcyk7Y2FzZSAxOnJldHVybiBsLmNhbGwodGhpcyxhKTtjYXNlIDI6cmV0dXJuIGQuY2FsbCh0aGlzLGEsYik7Y2FzZSAzOnJldHVybiBjLmNhbGwodGhpcyxhLGIsZSk7ZGVmYXVsdDp2YXIgcD1udWxsO2lmKDM8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBwPTAsRT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTMpO3A8RS5sZW5ndGg7KUVbcF09YXJndW1lbnRzW3ArM10sKytwO3A9bmV3IEYoRSwwKX1yZXR1cm4gcS5kKGEsYixlLHApfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtwLmk9MztwLmY9cS5mO3AubD1tO3AuYj1sO3AuYT1kO3AuYz1jO3AuZD1xLmQ7cmV0dXJuIHB9KCl9dmFyIGM9bnVsbCxkPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShjLGQsZSxtKXt2YXIgcD1udWxsO1xuaWYoMzxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIHA9MCxxPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMyk7cDxxLmxlbmd0aDspcVtwXT1hcmd1bWVudHNbcCszXSwrK3A7cD1uZXcgRihxLDApfXJldHVybiBiLmNhbGwodGhpcyxjLGQsZSxwKX1mdW5jdGlvbiBiKGEsYyxkLGUpe3JldHVybiBmdW5jdGlvbihhKXtyZXR1cm4gZnVuY3Rpb24oKXtmdW5jdGlvbiBiKGEpe3ZhciBkPW51bGw7aWYoMDxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGQ9MCxlPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMCk7ZDxlLmxlbmd0aDspZVtkXT1hcmd1bWVudHNbZCswXSwrK2Q7ZD1uZXcgRihlLDApfXJldHVybiBjLmNhbGwodGhpcyxkKX1mdW5jdGlvbiBjKGIpe2I9VC5hKEcoYSksYik7Zm9yKHZhciBkPUsoYSk7OylpZihkKWI9RyhkKS5jYWxsKG51bGwsYiksZD1LKGQpO2Vsc2UgcmV0dXJuIGJ9Yi5pPTA7Yi5mPWZ1bmN0aW9uKGEpe2E9RChhKTtyZXR1cm4gYyhhKX07Yi5kPWM7cmV0dXJuIGJ9KCl9KEpkKGJlLm4oYSxcbmMsZCxlKSkpfWEuaT0zO2EuZj1mdW5jdGlvbihhKXt2YXIgYz1HKGEpO2E9SyhhKTt2YXIgZD1HKGEpO2E9SyhhKTt2YXIgZT1HKGEpO2E9SChhKTtyZXR1cm4gYihjLGQsZSxhKX07YS5kPWI7cmV0dXJuIGF9KCksYz1mdW5jdGlvbihjLGYsZyxoKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAwOnJldHVybiB1ZDtjYXNlIDE6cmV0dXJuIGM7Y2FzZSAyOnJldHVybiBiLmNhbGwodGhpcyxjLGYpO2Nhc2UgMzpyZXR1cm4gYS5jYWxsKHRoaXMsYyxmLGcpO2RlZmF1bHQ6dmFyIGw9bnVsbDtpZigzPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgbD0wLG09QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0zKTtsPG0ubGVuZ3RoOyltW2xdPWFyZ3VtZW50c1tsKzNdLCsrbDtsPW5ldyBGKG0sMCl9cmV0dXJuIGQuZChjLGYsZyxsKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5pPTM7Yy5mPWQuZjtjLmw9ZnVuY3Rpb24oKXtyZXR1cm4gdWR9O1xuYy5iPWZ1bmN0aW9uKGEpe3JldHVybiBhfTtjLmE9YjtjLmM9YTtjLmQ9ZC5kO3JldHVybiBjfSgpLEplPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyxkKXtyZXR1cm4gZnVuY3Rpb24oKXtmdW5jdGlvbiBlKG0scCxxKXtyZXR1cm4gYS5QP2EuUChiLGMsZCxtLHAscSk6YS5jYWxsKG51bGwsYixjLGQsbSxwLHEpfWZ1bmN0aW9uIHAoZSxtKXtyZXR1cm4gYS5yP2EucihiLGMsZCxlLG0pOmEuY2FsbChudWxsLGIsYyxkLGUsbSl9ZnVuY3Rpb24gcShlKXtyZXR1cm4gYS5uP2EubihiLGMsZCxlKTphLmNhbGwobnVsbCxiLGMsZCxlKX1mdW5jdGlvbiBzKCl7cmV0dXJuIGEuYz9hLmMoYixjLGQpOmEuY2FsbChudWxsLGIsYyxkKX12YXIgdT1udWxsLHY9ZnVuY3Rpb24oKXtmdW5jdGlvbiBlKGEsYixjLGQpe3ZhciBmPW51bGw7aWYoMzxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGY9MCxnPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMyk7ZjxnLmxlbmd0aDspZ1tmXT1hcmd1bWVudHNbZitcbjNdLCsrZjtmPW5ldyBGKGcsMCl9cmV0dXJuIG0uY2FsbCh0aGlzLGEsYixjLGYpfWZ1bmN0aW9uIG0oZSxwLHEscyl7cmV0dXJuIFQuZChhLGIsYyxkLGUsS2MoW3AscSxzXSwwKSl9ZS5pPTM7ZS5mPWZ1bmN0aW9uKGEpe3ZhciBiPUcoYSk7YT1LKGEpO3ZhciBjPUcoYSk7YT1LKGEpO3ZhciBkPUcoYSk7YT1IKGEpO3JldHVybiBtKGIsYyxkLGEpfTtlLmQ9bTtyZXR1cm4gZX0oKSx1PWZ1bmN0aW9uKGEsYixjLGQpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDA6cmV0dXJuIHMuY2FsbCh0aGlzKTtjYXNlIDE6cmV0dXJuIHEuY2FsbCh0aGlzLGEpO2Nhc2UgMjpyZXR1cm4gcC5jYWxsKHRoaXMsYSxiKTtjYXNlIDM6cmV0dXJuIGUuY2FsbCh0aGlzLGEsYixjKTtkZWZhdWx0OnZhciBmPW51bGw7aWYoMzxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGY9MCxnPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMyk7ZjxnLmxlbmd0aDspZ1tmXT1hcmd1bWVudHNbZiszXSwrK2Y7Zj1cbm5ldyBGKGcsMCl9cmV0dXJuIHYuZChhLGIsYyxmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307dS5pPTM7dS5mPXYuZjt1Lmw9czt1LmI9cTt1LmE9cDt1LmM9ZTt1LmQ9di5kO3JldHVybiB1fSgpfWZ1bmN0aW9uIGIoYSxiLGMpe3JldHVybiBmdW5jdGlvbigpe2Z1bmN0aW9uIGQoZSxsLG0pe3JldHVybiBhLnI/YS5yKGIsYyxlLGwsbSk6YS5jYWxsKG51bGwsYixjLGUsbCxtKX1mdW5jdGlvbiBlKGQsbCl7cmV0dXJuIGEubj9hLm4oYixjLGQsbCk6YS5jYWxsKG51bGwsYixjLGQsbCl9ZnVuY3Rpb24gcChkKXtyZXR1cm4gYS5jP2EuYyhiLGMsZCk6YS5jYWxsKG51bGwsYixjLGQpfWZ1bmN0aW9uIHEoKXtyZXR1cm4gYS5hP2EuYShiLGMpOmEuY2FsbChudWxsLGIsYyl9dmFyIHM9bnVsbCx1PWZ1bmN0aW9uKCl7ZnVuY3Rpb24gZChhLGIsYyxmKXt2YXIgZz1udWxsO2lmKDM8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBnPTAsaD1BcnJheShhcmd1bWVudHMubGVuZ3RoLVxuMyk7ZzxoLmxlbmd0aDspaFtnXT1hcmd1bWVudHNbZyszXSwrK2c7Zz1uZXcgRihoLDApfXJldHVybiBlLmNhbGwodGhpcyxhLGIsYyxnKX1mdW5jdGlvbiBlKGQsbCxtLHApe3JldHVybiBULmQoYSxiLGMsZCxsLEtjKFttLHBdLDApKX1kLmk9MztkLmY9ZnVuY3Rpb24oYSl7dmFyIGI9RyhhKTthPUsoYSk7dmFyIGM9RyhhKTthPUsoYSk7dmFyIGQ9RyhhKTthPUgoYSk7cmV0dXJuIGUoYixjLGQsYSl9O2QuZD1lO3JldHVybiBkfSgpLHM9ZnVuY3Rpb24oYSxiLGMsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMDpyZXR1cm4gcS5jYWxsKHRoaXMpO2Nhc2UgMTpyZXR1cm4gcC5jYWxsKHRoaXMsYSk7Y2FzZSAyOnJldHVybiBlLmNhbGwodGhpcyxhLGIpO2Nhc2UgMzpyZXR1cm4gZC5jYWxsKHRoaXMsYSxiLGMpO2RlZmF1bHQ6dmFyIGc9bnVsbDtpZigzPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZz0wLGg9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0zKTtnPGgubGVuZ3RoOyloW2ddPVxuYXJndW1lbnRzW2crM10sKytnO2c9bmV3IEYoaCwwKX1yZXR1cm4gdS5kKGEsYixjLGcpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtzLmk9MztzLmY9dS5mO3MubD1xO3MuYj1wO3MuYT1lO3MuYz1kO3MuZD11LmQ7cmV0dXJuIHN9KCl9ZnVuY3Rpb24gYyhhLGIpe3JldHVybiBmdW5jdGlvbigpe2Z1bmN0aW9uIGMoZCxlLGgpe3JldHVybiBhLm4/YS5uKGIsZCxlLGgpOmEuY2FsbChudWxsLGIsZCxlLGgpfWZ1bmN0aW9uIGQoYyxlKXtyZXR1cm4gYS5jP2EuYyhiLGMsZSk6YS5jYWxsKG51bGwsYixjLGUpfWZ1bmN0aW9uIGUoYyl7cmV0dXJuIGEuYT9hLmEoYixjKTphLmNhbGwobnVsbCxiLGMpfWZ1bmN0aW9uIHAoKXtyZXR1cm4gYS5iP2EuYihiKTphLmNhbGwobnVsbCxiKX12YXIgcT1udWxsLHM9ZnVuY3Rpb24oKXtmdW5jdGlvbiBjKGEsYixlLGYpe3ZhciBnPW51bGw7aWYoMzxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGc9MCxcbmg9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0zKTtnPGgubGVuZ3RoOyloW2ddPWFyZ3VtZW50c1tnKzNdLCsrZztnPW5ldyBGKGgsMCl9cmV0dXJuIGQuY2FsbCh0aGlzLGEsYixlLGcpfWZ1bmN0aW9uIGQoYyxlLGgsbCl7cmV0dXJuIFQuZChhLGIsYyxlLGgsS2MoW2xdLDApKX1jLmk9MztjLmY9ZnVuY3Rpb24oYSl7dmFyIGI9RyhhKTthPUsoYSk7dmFyIGM9RyhhKTthPUsoYSk7dmFyIGU9RyhhKTthPUgoYSk7cmV0dXJuIGQoYixjLGUsYSl9O2MuZD1kO3JldHVybiBjfSgpLHE9ZnVuY3Rpb24oYSxiLGYsZyl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMDpyZXR1cm4gcC5jYWxsKHRoaXMpO2Nhc2UgMTpyZXR1cm4gZS5jYWxsKHRoaXMsYSk7Y2FzZSAyOnJldHVybiBkLmNhbGwodGhpcyxhLGIpO2Nhc2UgMzpyZXR1cm4gYy5jYWxsKHRoaXMsYSxiLGYpO2RlZmF1bHQ6dmFyIHE9bnVsbDtpZigzPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgcT0wLE49QXJyYXkoYXJndW1lbnRzLmxlbmd0aC1cbjMpO3E8Ti5sZW5ndGg7KU5bcV09YXJndW1lbnRzW3ErM10sKytxO3E9bmV3IEYoTiwwKX1yZXR1cm4gcy5kKGEsYixmLHEpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtxLmk9MztxLmY9cy5mO3EubD1wO3EuYj1lO3EuYT1kO3EuYz1jO3EuZD1zLmQ7cmV0dXJuIHF9KCl9dmFyIGQ9bnVsbCxlPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShjLGQsZSxmLHEpe3ZhciBzPW51bGw7aWYoNDxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIHM9MCx1PUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtNCk7czx1Lmxlbmd0aDspdVtzXT1hcmd1bWVudHNbcys0XSwrK3M7cz1uZXcgRih1LDApfXJldHVybiBiLmNhbGwodGhpcyxjLGQsZSxmLHMpfWZ1bmN0aW9uIGIoYSxjLGQsZSxmKXtyZXR1cm4gZnVuY3Rpb24oKXtmdW5jdGlvbiBiKGEpe3ZhciBjPW51bGw7aWYoMDxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGM9MCxkPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtXG4wKTtjPGQubGVuZ3RoOylkW2NdPWFyZ3VtZW50c1tjKzBdLCsrYztjPW5ldyBGKGQsMCl9cmV0dXJuIGcuY2FsbCh0aGlzLGMpfWZ1bmN0aW9uIGcoYil7cmV0dXJuIFQucihhLGMsZCxlLGFlLmEoZixiKSl9Yi5pPTA7Yi5mPWZ1bmN0aW9uKGEpe2E9RChhKTtyZXR1cm4gZyhhKX07Yi5kPWc7cmV0dXJuIGJ9KCl9YS5pPTQ7YS5mPWZ1bmN0aW9uKGEpe3ZhciBjPUcoYSk7YT1LKGEpO3ZhciBkPUcoYSk7YT1LKGEpO3ZhciBlPUcoYSk7YT1LKGEpO3ZhciBmPUcoYSk7YT1IKGEpO3JldHVybiBiKGMsZCxlLGYsYSl9O2EuZD1iO3JldHVybiBhfSgpLGQ9ZnVuY3Rpb24oZCxnLGgsbCxtKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBkO2Nhc2UgMjpyZXR1cm4gYy5jYWxsKHRoaXMsZCxnKTtjYXNlIDM6cmV0dXJuIGIuY2FsbCh0aGlzLGQsZyxoKTtjYXNlIDQ6cmV0dXJuIGEuY2FsbCh0aGlzLGQsZyxoLGwpO2RlZmF1bHQ6dmFyIHA9bnVsbDtpZig0PGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgcD1cbjAscT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTQpO3A8cS5sZW5ndGg7KXFbcF09YXJndW1lbnRzW3ArNF0sKytwO3A9bmV3IEYocSwwKX1yZXR1cm4gZS5kKGQsZyxoLGwscCl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2QuaT00O2QuZj1lLmY7ZC5iPWZ1bmN0aW9uKGEpe3JldHVybiBhfTtkLmE9YztkLmM9YjtkLm49YTtkLmQ9ZS5kO3JldHVybiBkfSgpLEtlPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyxkKXtyZXR1cm4gZnVuY3Rpb24oKXtmdW5jdGlvbiBsKGwsbSxwKXtsPW51bGw9PWw/YjpsO209bnVsbD09bT9jOm07cD1udWxsPT1wP2Q6cDtyZXR1cm4gYS5jP2EuYyhsLG0scCk6YS5jYWxsKG51bGwsbCxtLHApfWZ1bmN0aW9uIG0oZCxoKXt2YXIgbD1udWxsPT1kP2I6ZCxtPW51bGw9PWg/YzpoO3JldHVybiBhLmE/YS5hKGwsbSk6YS5jYWxsKG51bGwsbCxtKX12YXIgcD1udWxsLHE9ZnVuY3Rpb24oKXtmdW5jdGlvbiBsKGEsXG5iLGMsZCl7dmFyIGU9bnVsbDtpZigzPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZT0wLGY9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0zKTtlPGYubGVuZ3RoOylmW2VdPWFyZ3VtZW50c1tlKzNdLCsrZTtlPW5ldyBGKGYsMCl9cmV0dXJuIG0uY2FsbCh0aGlzLGEsYixjLGUpfWZ1bmN0aW9uIG0obCxwLHEscyl7cmV0dXJuIFQucihhLG51bGw9PWw/YjpsLG51bGw9PXA/YzpwLG51bGw9PXE/ZDpxLHMpfWwuaT0zO2wuZj1mdW5jdGlvbihhKXt2YXIgYj1HKGEpO2E9SyhhKTt2YXIgYz1HKGEpO2E9SyhhKTt2YXIgZD1HKGEpO2E9SChhKTtyZXR1cm4gbShiLGMsZCxhKX07bC5kPW07cmV0dXJuIGx9KCkscD1mdW5jdGlvbihhLGIsYyxkKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiBtLmNhbGwodGhpcyxhLGIpO2Nhc2UgMzpyZXR1cm4gbC5jYWxsKHRoaXMsYSxiLGMpO2RlZmF1bHQ6dmFyIGU9bnVsbDtpZigzPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZT1cbjAsZj1BcnJheShhcmd1bWVudHMubGVuZ3RoLTMpO2U8Zi5sZW5ndGg7KWZbZV09YXJndW1lbnRzW2UrM10sKytlO2U9bmV3IEYoZiwwKX1yZXR1cm4gcS5kKGEsYixjLGUpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtwLmk9MztwLmY9cS5mO3AuYT1tO3AuYz1sO3AuZD1xLmQ7cmV0dXJuIHB9KCl9ZnVuY3Rpb24gYihhLGIsYyl7cmV0dXJuIGZ1bmN0aW9uKCl7ZnVuY3Rpb24gZChoLGwsbSl7aD1udWxsPT1oP2I6aDtsPW51bGw9PWw/YzpsO3JldHVybiBhLmM/YS5jKGgsbCxtKTphLmNhbGwobnVsbCxoLGwsbSl9ZnVuY3Rpb24gbChkLGgpe3ZhciBsPW51bGw9PWQ/YjpkLG09bnVsbD09aD9jOmg7cmV0dXJuIGEuYT9hLmEobCxtKTphLmNhbGwobnVsbCxsLG0pfXZhciBtPW51bGwscD1mdW5jdGlvbigpe2Z1bmN0aW9uIGQoYSxiLGMsZSl7dmFyIGY9bnVsbDtpZigzPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZj0wLGc9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC1cbjMpO2Y8Zy5sZW5ndGg7KWdbZl09YXJndW1lbnRzW2YrM10sKytmO2Y9bmV3IEYoZywwKX1yZXR1cm4gaC5jYWxsKHRoaXMsYSxiLGMsZil9ZnVuY3Rpb24gaChkLGwsbSxwKXtyZXR1cm4gVC5yKGEsbnVsbD09ZD9iOmQsbnVsbD09bD9jOmwsbSxwKX1kLmk9MztkLmY9ZnVuY3Rpb24oYSl7dmFyIGI9RyhhKTthPUsoYSk7dmFyIGM9RyhhKTthPUsoYSk7dmFyIGQ9RyhhKTthPUgoYSk7cmV0dXJuIGgoYixjLGQsYSl9O2QuZD1oO3JldHVybiBkfSgpLG09ZnVuY3Rpb24oYSxiLGMsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gbC5jYWxsKHRoaXMsYSxiKTtjYXNlIDM6cmV0dXJuIGQuY2FsbCh0aGlzLGEsYixjKTtkZWZhdWx0OnZhciBmPW51bGw7aWYoMzxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGY9MCxnPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMyk7ZjxnLmxlbmd0aDspZ1tmXT1hcmd1bWVudHNbZiszXSwrK2Y7Zj1uZXcgRihnLDApfXJldHVybiBwLmQoYSxcbmIsYyxmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307bS5pPTM7bS5mPXAuZjttLmE9bDttLmM9ZDttLmQ9cC5kO3JldHVybiBtfSgpfWZ1bmN0aW9uIGMoYSxiKXtyZXR1cm4gZnVuY3Rpb24oKXtmdW5jdGlvbiBjKGQsZyxoKXtkPW51bGw9PWQ/YjpkO3JldHVybiBhLmM/YS5jKGQsZyxoKTphLmNhbGwobnVsbCxkLGcsaCl9ZnVuY3Rpb24gZChjLGcpe3ZhciBoPW51bGw9PWM/YjpjO3JldHVybiBhLmE/YS5hKGgsZyk6YS5jYWxsKG51bGwsaCxnKX1mdW5jdGlvbiBsKGMpe2M9bnVsbD09Yz9iOmM7cmV0dXJuIGEuYj9hLmIoYyk6YS5jYWxsKG51bGwsYyl9dmFyIG09bnVsbCxwPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYyhhLGIsZSxmKXt2YXIgZz1udWxsO2lmKDM8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBnPTAsaD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTMpO2c8aC5sZW5ndGg7KWhbZ109YXJndW1lbnRzW2crM10sKytnO2c9bmV3IEYoaCxcbjApfXJldHVybiBkLmNhbGwodGhpcyxhLGIsZSxnKX1mdW5jdGlvbiBkKGMsZyxoLGwpe3JldHVybiBULnIoYSxudWxsPT1jP2I6YyxnLGgsbCl9Yy5pPTM7Yy5mPWZ1bmN0aW9uKGEpe3ZhciBiPUcoYSk7YT1LKGEpO3ZhciBjPUcoYSk7YT1LKGEpO3ZhciBlPUcoYSk7YT1IKGEpO3JldHVybiBkKGIsYyxlLGEpfTtjLmQ9ZDtyZXR1cm4gY30oKSxtPWZ1bmN0aW9uKGEsYixlLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGwuY2FsbCh0aGlzLGEpO2Nhc2UgMjpyZXR1cm4gZC5jYWxsKHRoaXMsYSxiKTtjYXNlIDM6cmV0dXJuIGMuY2FsbCh0aGlzLGEsYixlKTtkZWZhdWx0OnZhciBtPW51bGw7aWYoMzxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIG09MCxCPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMyk7bTxCLmxlbmd0aDspQlttXT1hcmd1bWVudHNbbSszXSwrK207bT1uZXcgRihCLDApfXJldHVybiBwLmQoYSxiLGUsbSl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIitcbmFyZ3VtZW50cy5sZW5ndGgpO307bS5pPTM7bS5mPXAuZjttLmI9bDttLmE9ZDttLmM9YzttLmQ9cC5kO3JldHVybiBtfSgpfXZhciBkPW51bGwsZD1mdW5jdGlvbihkLGYsZyxoKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiBjLmNhbGwodGhpcyxkLGYpO2Nhc2UgMzpyZXR1cm4gYi5jYWxsKHRoaXMsZCxmLGcpO2Nhc2UgNDpyZXR1cm4gYS5jYWxsKHRoaXMsZCxmLGcsaCl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2QuYT1jO2QuYz1iO2Qubj1hO3JldHVybiBkfSgpLExlPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIpe3JldHVybiBuZXcgVihudWxsLGZ1bmN0aW9uKCl7dmFyIGY9RChiKTtpZihmKXtpZihmZChmKSl7Zm9yKHZhciBnPVliKGYpLGg9UShnKSxsPVRkKGgpLG09MDs7KWlmKG08aCl7dmFyIHA9ZnVuY3Rpb24oKXt2YXIgYj1DLmEoZyxtKTtyZXR1cm4gYS5iP2EuYihiKTphLmNhbGwobnVsbCxiKX0oKTtcbm51bGwhPXAmJmwuYWRkKHApO20rPTF9ZWxzZSBicmVhaztyZXR1cm4gV2QobC5jYSgpLGMuYShhLFpiKGYpKSl9aD1mdW5jdGlvbigpe3ZhciBiPUcoZik7cmV0dXJuIGEuYj9hLmIoYik6YS5jYWxsKG51bGwsYil9KCk7cmV0dXJuIG51bGw9PWg/Yy5hKGEsSChmKSk6TShoLGMuYShhLEgoZikpKX1yZXR1cm4gbnVsbH0sbnVsbCxudWxsKX1mdW5jdGlvbiBiKGEpe3JldHVybiBmdW5jdGlvbihiKXtyZXR1cm4gZnVuY3Rpb24oKXtmdW5jdGlvbiBjKGYsZyl7dmFyIGg9YS5iP2EuYihnKTphLmNhbGwobnVsbCxnKTtyZXR1cm4gbnVsbD09aD9mOmIuYT9iLmEoZixoKTpiLmNhbGwobnVsbCxmLGgpfWZ1bmN0aW9uIGcoYSl7cmV0dXJuIGIuYj9iLmIoYSk6Yi5jYWxsKG51bGwsYSl9ZnVuY3Rpb24gaCgpe3JldHVybiBiLmw/Yi5sKCk6Yi5jYWxsKG51bGwpfXZhciBsPW51bGwsbD1mdW5jdGlvbihhLGIpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDA6cmV0dXJuIGguY2FsbCh0aGlzKTtcbmNhc2UgMTpyZXR1cm4gZy5jYWxsKHRoaXMsYSk7Y2FzZSAyOnJldHVybiBjLmNhbGwodGhpcyxhLGIpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtsLmw9aDtsLmI9ZztsLmE9YztyZXR1cm4gbH0oKX19dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYi5jYWxsKHRoaXMsYyk7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxjLGUpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmI9YjtjLmE9YTtyZXR1cm4gY30oKTtmdW5jdGlvbiBNZShhKXt0aGlzLnN0YXRlPWE7dGhpcy5xPTA7dGhpcy5qPTMyNzY4fU1lLnByb3RvdHlwZS5SYT1mdW5jdGlvbigpe3JldHVybiB0aGlzLnN0YXRlfTtNZS5wcm90b3R5cGUuYmI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gdGhpcy5zdGF0ZT1ifTtcbnZhciBOZT1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiKXtyZXR1cm4gZnVuY3Rpb24gZyhiLGMpe3JldHVybiBuZXcgVihudWxsLGZ1bmN0aW9uKCl7dmFyIGU9RChjKTtpZihlKXtpZihmZChlKSl7Zm9yKHZhciBwPVliKGUpLHE9UShwKSxzPVRkKHEpLHU9MDs7KWlmKHU8cSl7dmFyIHY9ZnVuY3Rpb24oKXt2YXIgYz1iK3UsZT1DLmEocCx1KTtyZXR1cm4gYS5hP2EuYShjLGUpOmEuY2FsbChudWxsLGMsZSl9KCk7bnVsbCE9diYmcy5hZGQodik7dSs9MX1lbHNlIGJyZWFrO3JldHVybiBXZChzLmNhKCksZyhiK3EsWmIoZSkpKX1xPWZ1bmN0aW9uKCl7dmFyIGM9RyhlKTtyZXR1cm4gYS5hP2EuYShiLGMpOmEuY2FsbChudWxsLGIsYyl9KCk7cmV0dXJuIG51bGw9PXE/ZyhiKzEsSChlKSk6TShxLGcoYisxLEgoZSkpKX1yZXR1cm4gbnVsbH0sbnVsbCxudWxsKX0oMCxiKX1mdW5jdGlvbiBiKGEpe3JldHVybiBmdW5jdGlvbihiKXtyZXR1cm4gZnVuY3Rpb24oYyl7cmV0dXJuIGZ1bmN0aW9uKCl7ZnVuY3Rpb24gZyhnLFxuaCl7dmFyIGw9Yy5iYigwLGMuUmEobnVsbCkrMSksbD1hLmE/YS5hKGwsaCk6YS5jYWxsKG51bGwsbCxoKTtyZXR1cm4gbnVsbD09bD9nOmIuYT9iLmEoZyxsKTpiLmNhbGwobnVsbCxnLGwpfWZ1bmN0aW9uIGgoYSl7cmV0dXJuIGIuYj9iLmIoYSk6Yi5jYWxsKG51bGwsYSl9ZnVuY3Rpb24gbCgpe3JldHVybiBiLmw/Yi5sKCk6Yi5jYWxsKG51bGwpfXZhciBtPW51bGwsbT1mdW5jdGlvbihhLGIpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDA6cmV0dXJuIGwuY2FsbCh0aGlzKTtjYXNlIDE6cmV0dXJuIGguY2FsbCh0aGlzLGEpO2Nhc2UgMjpyZXR1cm4gZy5jYWxsKHRoaXMsYSxiKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307bS5sPWw7bS5iPWg7bS5hPWc7cmV0dXJuIG19KCl9KG5ldyBNZSgtMSkpfX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiLmNhbGwodGhpcyxcbmMpO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5iPWI7Yy5hPWE7cmV0dXJuIGN9KCksT2U9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjLGQpe3JldHVybiBuZXcgVihudWxsLGZ1bmN0aW9uKCl7dmFyIGY9RChiKSxxPUQoYykscz1EKGQpO2lmKGYmJnEmJnMpe3ZhciB1PU0sdjt2PUcoZik7dmFyIHk9RyhxKSxCPUcocyk7dj1hLmM/YS5jKHYseSxCKTphLmNhbGwobnVsbCx2LHksQik7Zj11KHYsZS5uKGEsSChmKSxIKHEpLEgocykpKX1lbHNlIGY9bnVsbDtyZXR1cm4gZn0sbnVsbCxudWxsKX1mdW5jdGlvbiBiKGEsYixjKXtyZXR1cm4gbmV3IFYobnVsbCxmdW5jdGlvbigpe3ZhciBkPUQoYiksZj1EKGMpO2lmKGQmJmYpe3ZhciBxPU0scztzPUcoZCk7dmFyIHU9RyhmKTtzPWEuYT9hLmEocyx1KTphLmNhbGwobnVsbCxzLHUpO2Q9cShzLGUuYyhhLEgoZCksSChmKSkpfWVsc2UgZD1cbm51bGw7cmV0dXJuIGR9LG51bGwsbnVsbCl9ZnVuY3Rpb24gYyhhLGIpe3JldHVybiBuZXcgVihudWxsLGZ1bmN0aW9uKCl7dmFyIGM9RChiKTtpZihjKXtpZihmZChjKSl7Zm9yKHZhciBkPVliKGMpLGY9UShkKSxxPVRkKGYpLHM9MDs7KWlmKHM8ZilYZChxLGZ1bmN0aW9uKCl7dmFyIGI9Qy5hKGQscyk7cmV0dXJuIGEuYj9hLmIoYik6YS5jYWxsKG51bGwsYil9KCkpLHMrPTE7ZWxzZSBicmVhaztyZXR1cm4gV2QocS5jYSgpLGUuYShhLFpiKGMpKSl9cmV0dXJuIE0oZnVuY3Rpb24oKXt2YXIgYj1HKGMpO3JldHVybiBhLmI/YS5iKGIpOmEuY2FsbChudWxsLGIpfSgpLGUuYShhLEgoYykpKX1yZXR1cm4gbnVsbH0sbnVsbCxudWxsKX1mdW5jdGlvbiBkKGEpe3JldHVybiBmdW5jdGlvbihiKXtyZXR1cm4gZnVuY3Rpb24oKXtmdW5jdGlvbiBjKGQsZSl7dmFyIGY9YS5iP2EuYihlKTphLmNhbGwobnVsbCxlKTtyZXR1cm4gYi5hP2IuYShkLGYpOmIuY2FsbChudWxsLGQsZil9ZnVuY3Rpb24gZChhKXtyZXR1cm4gYi5iP1xuYi5iKGEpOmIuY2FsbChudWxsLGEpfWZ1bmN0aW9uIGUoKXtyZXR1cm4gYi5sP2IubCgpOmIuY2FsbChudWxsKX12YXIgZj1udWxsLHM9ZnVuY3Rpb24oKXtmdW5jdGlvbiBjKGEsYixlKXt2YXIgZj1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBmPTAsZz1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2Y8Zy5sZW5ndGg7KWdbZl09YXJndW1lbnRzW2YrMl0sKytmO2Y9bmV3IEYoZywwKX1yZXR1cm4gZC5jYWxsKHRoaXMsYSxiLGYpfWZ1bmN0aW9uIGQoYyxlLGYpe2U9VC5jKGEsZSxmKTtyZXR1cm4gYi5hP2IuYShjLGUpOmIuY2FsbChudWxsLGMsZSl9Yy5pPTI7Yy5mPWZ1bmN0aW9uKGEpe3ZhciBiPUcoYSk7YT1LKGEpO3ZhciBjPUcoYSk7YT1IKGEpO3JldHVybiBkKGIsYyxhKX07Yy5kPWQ7cmV0dXJuIGN9KCksZj1mdW5jdGlvbihhLGIsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMDpyZXR1cm4gZS5jYWxsKHRoaXMpO2Nhc2UgMTpyZXR1cm4gZC5jYWxsKHRoaXMsXG5hKTtjYXNlIDI6cmV0dXJuIGMuY2FsbCh0aGlzLGEsYik7ZGVmYXVsdDp2YXIgZz1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBnPTAsaD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2c8aC5sZW5ndGg7KWhbZ109YXJndW1lbnRzW2crMl0sKytnO2c9bmV3IEYoaCwwKX1yZXR1cm4gcy5kKGEsYixnKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Zi5pPTI7Zi5mPXMuZjtmLmw9ZTtmLmI9ZDtmLmE9YztmLmQ9cy5kO3JldHVybiBmfSgpfX12YXIgZT1udWxsLGY9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGMsZCxlLGYsZyl7dmFyIHU9bnVsbDtpZig0PGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgdT0wLHY9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC00KTt1PHYubGVuZ3RoOyl2W3VdPWFyZ3VtZW50c1t1KzRdLCsrdTt1PW5ldyBGKHYsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGMsZCxlLGYsdSl9ZnVuY3Rpb24gYihhLGMsZCxcbmYsZyl7dmFyIGg9ZnVuY3Rpb24geShhKXtyZXR1cm4gbmV3IFYobnVsbCxmdW5jdGlvbigpe3ZhciBiPWUuYShELGEpO3JldHVybiBFZSh1ZCxiKT9NKGUuYShHLGIpLHkoZS5hKEgsYikpKTpudWxsfSxudWxsLG51bGwpfTtyZXR1cm4gZS5hKGZ1bmN0aW9uKCl7cmV0dXJuIGZ1bmN0aW9uKGIpe3JldHVybiBULmEoYSxiKX19KGgpLGgoTmMuZChnLGYsS2MoW2QsY10sMCkpKSl9YS5pPTQ7YS5mPWZ1bmN0aW9uKGEpe3ZhciBjPUcoYSk7YT1LKGEpO3ZhciBkPUcoYSk7YT1LKGEpO3ZhciBlPUcoYSk7YT1LKGEpO3ZhciBmPUcoYSk7YT1IKGEpO3JldHVybiBiKGMsZCxlLGYsYSl9O2EuZD1iO3JldHVybiBhfSgpLGU9ZnVuY3Rpb24oZSxoLGwsbSxwKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBkLmNhbGwodGhpcyxlKTtjYXNlIDI6cmV0dXJuIGMuY2FsbCh0aGlzLGUsaCk7Y2FzZSAzOnJldHVybiBiLmNhbGwodGhpcyxlLGgsbCk7Y2FzZSA0OnJldHVybiBhLmNhbGwodGhpcyxcbmUsaCxsLG0pO2RlZmF1bHQ6dmFyIHE9bnVsbDtpZig0PGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgcT0wLHM9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC00KTtxPHMubGVuZ3RoOylzW3FdPWFyZ3VtZW50c1txKzRdLCsrcTtxPW5ldyBGKHMsMCl9cmV0dXJuIGYuZChlLGgsbCxtLHEpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtlLmk9NDtlLmY9Zi5mO2UuYj1kO2UuYT1jO2UuYz1iO2Uubj1hO2UuZD1mLmQ7cmV0dXJuIGV9KCksUGU9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYil7cmV0dXJuIG5ldyBWKG51bGwsZnVuY3Rpb24oKXtpZigwPGEpe3ZhciBmPUQoYik7cmV0dXJuIGY/TShHKGYpLGMuYShhLTEsSChmKSkpOm51bGx9cmV0dXJuIG51bGx9LG51bGwsbnVsbCl9ZnVuY3Rpb24gYihhKXtyZXR1cm4gZnVuY3Rpb24oYil7cmV0dXJuIGZ1bmN0aW9uKGEpe3JldHVybiBmdW5jdGlvbigpe2Z1bmN0aW9uIGMoZCxnKXt2YXIgaD1xYihhKSxcbmw9YS5iYigwLGEuUmEobnVsbCktMSksaD0wPGg/Yi5hP2IuYShkLGcpOmIuY2FsbChudWxsLGQsZyk6ZDtyZXR1cm4gMDxsP2g6QWMoaCk/aDpuZXcgeWMoaCl9ZnVuY3Rpb24gZChhKXtyZXR1cm4gYi5iP2IuYihhKTpiLmNhbGwobnVsbCxhKX1mdW5jdGlvbiBsKCl7cmV0dXJuIGIubD9iLmwoKTpiLmNhbGwobnVsbCl9dmFyIG09bnVsbCxtPWZ1bmN0aW9uKGEsYil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMDpyZXR1cm4gbC5jYWxsKHRoaXMpO2Nhc2UgMTpyZXR1cm4gZC5jYWxsKHRoaXMsYSk7Y2FzZSAyOnJldHVybiBjLmNhbGwodGhpcyxhLGIpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTttLmw9bDttLmI9ZDttLmE9YztyZXR1cm4gbX0oKX0obmV3IE1lKGEpKX19dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYi5jYWxsKHRoaXMsYyk7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxcbmMsZSl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYj1iO2MuYT1hO3JldHVybiBjfSgpLFFlPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIpe3JldHVybiBuZXcgVihudWxsLGZ1bmN0aW9uKGMpe3JldHVybiBmdW5jdGlvbigpe3JldHVybiBjKGEsYil9fShmdW5jdGlvbihhLGIpe2Zvcig7Oyl7dmFyIGM9RChiKTtpZigwPGEmJmMpe3ZhciBkPWEtMSxjPUgoYyk7YT1kO2I9Y31lbHNlIHJldHVybiBjfX0pLG51bGwsbnVsbCl9ZnVuY3Rpb24gYihhKXtyZXR1cm4gZnVuY3Rpb24oYil7cmV0dXJuIGZ1bmN0aW9uKGEpe3JldHVybiBmdW5jdGlvbigpe2Z1bmN0aW9uIGMoZCxnKXt2YXIgaD1xYihhKTthLmJiKDAsYS5SYShudWxsKS0xKTtyZXR1cm4gMDxoP2Q6Yi5hP2IuYShkLGcpOmIuY2FsbChudWxsLGQsZyl9ZnVuY3Rpb24gZChhKXtyZXR1cm4gYi5iP2IuYihhKTpiLmNhbGwobnVsbCxhKX1mdW5jdGlvbiBsKCl7cmV0dXJuIGIubD9cbmIubCgpOmIuY2FsbChudWxsKX12YXIgbT1udWxsLG09ZnVuY3Rpb24oYSxiKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAwOnJldHVybiBsLmNhbGwodGhpcyk7Y2FzZSAxOnJldHVybiBkLmNhbGwodGhpcyxhKTtjYXNlIDI6cmV0dXJuIGMuY2FsbCh0aGlzLGEsYil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O20ubD1sO20uYj1kO20uYT1jO3JldHVybiBtfSgpfShuZXcgTWUoYSkpfX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiLmNhbGwodGhpcyxjKTtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYj1iO2MuYT1hO3JldHVybiBjfSgpLFJlPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIpe3JldHVybiBuZXcgVihudWxsLGZ1bmN0aW9uKGMpe3JldHVybiBmdW5jdGlvbigpe3JldHVybiBjKGEsXG5iKX19KGZ1bmN0aW9uKGEsYil7Zm9yKDs7KXt2YXIgYz1EKGIpLGQ7aWYoZD1jKWQ9RyhjKSxkPWEuYj9hLmIoZCk6YS5jYWxsKG51bGwsZCk7aWYodChkKSlkPWEsYz1IKGMpLGE9ZCxiPWM7ZWxzZSByZXR1cm4gY319KSxudWxsLG51bGwpfWZ1bmN0aW9uIGIoYSl7cmV0dXJuIGZ1bmN0aW9uKGIpe3JldHVybiBmdW5jdGlvbihjKXtyZXR1cm4gZnVuY3Rpb24oKXtmdW5jdGlvbiBnKGcsaCl7dmFyIGw9cWIoYyk7aWYodCh0KGwpP2EuYj9hLmIoaCk6YS5jYWxsKG51bGwsaCk6bCkpcmV0dXJuIGc7YWMoYyxudWxsKTtyZXR1cm4gYi5hP2IuYShnLGgpOmIuY2FsbChudWxsLGcsaCl9ZnVuY3Rpb24gaChhKXtyZXR1cm4gYi5iP2IuYihhKTpiLmNhbGwobnVsbCxhKX1mdW5jdGlvbiBsKCl7cmV0dXJuIGIubD9iLmwoKTpiLmNhbGwobnVsbCl9dmFyIG09bnVsbCxtPWZ1bmN0aW9uKGEsYil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMDpyZXR1cm4gbC5jYWxsKHRoaXMpO2Nhc2UgMTpyZXR1cm4gaC5jYWxsKHRoaXMsXG5hKTtjYXNlIDI6cmV0dXJuIGcuY2FsbCh0aGlzLGEsYil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O20ubD1sO20uYj1oO20uYT1nO3JldHVybiBtfSgpfShuZXcgTWUoITApKX19dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYi5jYWxsKHRoaXMsYyk7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxjLGUpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmI9YjtjLmE9YTtyZXR1cm4gY30oKSxTZT1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiKXtyZXR1cm4gUGUuYShhLGMuYihiKSl9ZnVuY3Rpb24gYihhKXtyZXR1cm4gbmV3IFYobnVsbCxmdW5jdGlvbigpe3JldHVybiBNKGEsYy5iKGEpKX0sbnVsbCxudWxsKX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiLmNhbGwodGhpcyxcbmMpO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5iPWI7Yy5hPWE7cmV0dXJuIGN9KCksVGU9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYil7cmV0dXJuIFBlLmEoYSxjLmIoYikpfWZ1bmN0aW9uIGIoYSl7cmV0dXJuIG5ldyBWKG51bGwsZnVuY3Rpb24oKXtyZXR1cm4gTShhLmw/YS5sKCk6YS5jYWxsKG51bGwpLGMuYihhKSl9LG51bGwsbnVsbCl9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYi5jYWxsKHRoaXMsYyk7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxjLGUpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmI9YjtjLmE9YTtyZXR1cm4gY30oKSxVZT1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxjKXtyZXR1cm4gbmV3IFYobnVsbCxmdW5jdGlvbigpe3ZhciBmPVxuRChhKSxnPUQoYyk7cmV0dXJuIGYmJmc/TShHKGYpLE0oRyhnKSxiLmEoSChmKSxIKGcpKSkpOm51bGx9LG51bGwsbnVsbCl9dmFyIGI9bnVsbCxjPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShiLGQsaCl7dmFyIGw9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgbD0wLG09QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtsPG0ubGVuZ3RoOyltW2xdPWFyZ3VtZW50c1tsKzJdLCsrbDtsPW5ldyBGKG0sMCl9cmV0dXJuIGMuY2FsbCh0aGlzLGIsZCxsKX1mdW5jdGlvbiBjKGEsZCxlKXtyZXR1cm4gbmV3IFYobnVsbCxmdW5jdGlvbigpe3ZhciBjPU9lLmEoRCxOYy5kKGUsZCxLYyhbYV0sMCkpKTtyZXR1cm4gRWUodWQsYyk/YWUuYShPZS5hKEcsYyksVC5hKGIsT2UuYShILGMpKSk6bnVsbH0sbnVsbCxudWxsKX1hLmk9MjthLmY9ZnVuY3Rpb24oYSl7dmFyIGI9RyhhKTthPUsoYSk7dmFyIGQ9RyhhKTthPUgoYSk7cmV0dXJuIGMoYixkLGEpfTthLmQ9YztyZXR1cm4gYX0oKSxcbmI9ZnVuY3Rpb24oYixlLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGIsZSk7ZGVmYXVsdDp2YXIgZz1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBnPTAsaD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2c8aC5sZW5ndGg7KWhbZ109YXJndW1lbnRzW2crMl0sKytnO2c9bmV3IEYoaCwwKX1yZXR1cm4gYy5kKGIsZSxnKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yi5pPTI7Yi5mPWMuZjtiLmE9YTtiLmQ9Yy5kO3JldHVybiBifSgpLFdlPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhKXtyZXR1cm4gSWUuYShPZS5iKGEpLFZlKX12YXIgYj1udWxsLGM9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGMsZCl7dmFyIGg9bnVsbDtpZigxPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgaD0wLGw9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0xKTtoPGwubGVuZ3RoOylsW2hdPWFyZ3VtZW50c1toK1xuMV0sKytoO2g9bmV3IEYobCwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsYyxoKX1mdW5jdGlvbiBiKGEsYyl7cmV0dXJuIFQuYShhZSxULmMoT2UsYSxjKSl9YS5pPTE7YS5mPWZ1bmN0aW9uKGEpe3ZhciBjPUcoYSk7YT1IKGEpO3JldHVybiBiKGMsYSl9O2EuZD1iO3JldHVybiBhfSgpLGI9ZnVuY3Rpb24oYixlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBhLmNhbGwodGhpcyxiKTtkZWZhdWx0OnZhciBmPW51bGw7aWYoMTxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGY9MCxnPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMSk7ZjxnLmxlbmd0aDspZ1tmXT1hcmd1bWVudHNbZisxXSwrK2Y7Zj1uZXcgRihnLDApfXJldHVybiBjLmQoYixmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yi5pPTE7Yi5mPWMuZjtiLmI9YTtiLmQ9Yy5kO3JldHVybiBifSgpLFhlPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIpe3JldHVybiBuZXcgVihudWxsLFxuZnVuY3Rpb24oKXt2YXIgZj1EKGIpO2lmKGYpe2lmKGZkKGYpKXtmb3IodmFyIGc9WWIoZiksaD1RKGcpLGw9VGQoaCksbT0wOzspaWYobTxoKXt2YXIgcDtwPUMuYShnLG0pO3A9YS5iP2EuYihwKTphLmNhbGwobnVsbCxwKTt0KHApJiYocD1DLmEoZyxtKSxsLmFkZChwKSk7bSs9MX1lbHNlIGJyZWFrO3JldHVybiBXZChsLmNhKCksYy5hKGEsWmIoZikpKX1nPUcoZik7Zj1IKGYpO3JldHVybiB0KGEuYj9hLmIoZyk6YS5jYWxsKG51bGwsZykpP00oZyxjLmEoYSxmKSk6Yy5hKGEsZil9cmV0dXJuIG51bGx9LG51bGwsbnVsbCl9ZnVuY3Rpb24gYihhKXtyZXR1cm4gZnVuY3Rpb24oYil7cmV0dXJuIGZ1bmN0aW9uKCl7ZnVuY3Rpb24gYyhmLGcpe3JldHVybiB0KGEuYj9hLmIoZyk6YS5jYWxsKG51bGwsZykpP2IuYT9iLmEoZixnKTpiLmNhbGwobnVsbCxmLGcpOmZ9ZnVuY3Rpb24gZyhhKXtyZXR1cm4gYi5iP2IuYihhKTpiLmNhbGwobnVsbCxhKX1mdW5jdGlvbiBoKCl7cmV0dXJuIGIubD9cbmIubCgpOmIuY2FsbChudWxsKX12YXIgbD1udWxsLGw9ZnVuY3Rpb24oYSxiKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAwOnJldHVybiBoLmNhbGwodGhpcyk7Y2FzZSAxOnJldHVybiBnLmNhbGwodGhpcyxhKTtjYXNlIDI6cmV0dXJuIGMuY2FsbCh0aGlzLGEsYil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2wubD1oO2wuYj1nO2wuYT1jO3JldHVybiBsfSgpfX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiLmNhbGwodGhpcyxjKTtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYj1iO2MuYT1hO3JldHVybiBjfSgpLFllPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIpe3JldHVybiBYZS5hKEhlKGEpLGIpfWZ1bmN0aW9uIGIoYSl7cmV0dXJuIFhlLmIoSGUoYSkpfVxudmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYi5jYWxsKHRoaXMsYyk7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxjLGUpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmI9YjtjLmE9YTtyZXR1cm4gY30oKTtmdW5jdGlvbiBaZShhKXt2YXIgYj0kZTtyZXR1cm4gZnVuY3Rpb24gZChhKXtyZXR1cm4gbmV3IFYobnVsbCxmdW5jdGlvbigpe3JldHVybiBNKGEsdChiLmI/Yi5iKGEpOmIuY2FsbChudWxsLGEpKT9XZS5kKGQsS2MoW0QuYj9ELmIoYSk6RC5jYWxsKG51bGwsYSldLDApKTpudWxsKX0sbnVsbCxudWxsKX0oYSl9XG52YXIgYWY9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjKXtyZXR1cm4gYSYmKGEucSY0fHxhLmRjKT9PKGNlKHdkLm4oYixkZSxPYihhKSxjKSksVmMoYSkpOndkLm4oYixOYyxhLGMpfWZ1bmN0aW9uIGIoYSxiKXtyZXR1cm4gbnVsbCE9YT9hJiYoYS5xJjR8fGEuZGMpP08oY2UoQS5jKFBiLE9iKGEpLGIpKSxWYyhhKSk6QS5jKFJhLGEsYik6QS5jKE5jLEosYil9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiBiLmNhbGwodGhpcyxjLGUpO2Nhc2UgMzpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmE9YjtjLmM9YTtyZXR1cm4gY30oKSxiZj1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMsaCl7cmV0dXJuIG5ldyBWKG51bGwsZnVuY3Rpb24oKXt2YXIgbD1EKGgpO2lmKGwpe3ZhciBtPVBlLmEoYSxsKTtyZXR1cm4gYT09PVxuUShtKT9NKG0sZC5uKGEsYixjLFFlLmEoYixsKSkpOlJhKEosUGUuYShhLGFlLmEobSxjKSkpfXJldHVybiBudWxsfSxudWxsLG51bGwpfWZ1bmN0aW9uIGIoYSxiLGMpe3JldHVybiBuZXcgVihudWxsLGZ1bmN0aW9uKCl7dmFyIGg9RChjKTtpZihoKXt2YXIgbD1QZS5hKGEsaCk7cmV0dXJuIGE9PT1RKGwpP00obCxkLmMoYSxiLFFlLmEoYixoKSkpOm51bGx9cmV0dXJuIG51bGx9LG51bGwsbnVsbCl9ZnVuY3Rpb24gYyhhLGIpe3JldHVybiBkLmMoYSxhLGIpfXZhciBkPW51bGwsZD1mdW5jdGlvbihkLGYsZyxoKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiBjLmNhbGwodGhpcyxkLGYpO2Nhc2UgMzpyZXR1cm4gYi5jYWxsKHRoaXMsZCxmLGcpO2Nhc2UgNDpyZXR1cm4gYS5jYWxsKHRoaXMsZCxmLGcsaCl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2QuYT1jO2QuYz1iO2Qubj1hO3JldHVybiBkfSgpLGNmPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLFxuYixjKXt2YXIgZz1qZDtmb3IoYj1EKGIpOzspaWYoYil7dmFyIGg9YTtpZihoP2guaiYyNTZ8fGguUmJ8fChoLmo/MDp3KFphLGgpKTp3KFphLGgpKXthPVMuYyhhLEcoYiksZyk7aWYoZz09PWEpcmV0dXJuIGM7Yj1LKGIpfWVsc2UgcmV0dXJuIGN9ZWxzZSByZXR1cm4gYX1mdW5jdGlvbiBiKGEsYil7cmV0dXJuIGMuYyhhLGIsbnVsbCl9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiBiLmNhbGwodGhpcyxjLGUpO2Nhc2UgMzpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmE9YjtjLmM9YTtyZXR1cm4gY30oKSxkZj1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMsZCxmLHEpe3ZhciBzPVIuYyhiLDAsbnVsbCk7cmV0dXJuKGI9RWQoYikpP1JjLmMoYSxzLGUuUChTLmEoYSxzKSxiLGMsZCxmLHEpKTpSYy5jKGEscyxcbmZ1bmN0aW9uKCl7dmFyIGI9Uy5hKGEscyk7cmV0dXJuIGMubj9jLm4oYixkLGYscSk6Yy5jYWxsKG51bGwsYixkLGYscSl9KCkpfWZ1bmN0aW9uIGIoYSxiLGMsZCxmKXt2YXIgcT1SLmMoYiwwLG51bGwpO3JldHVybihiPUVkKGIpKT9SYy5jKGEscSxlLnIoUy5hKGEscSksYixjLGQsZikpOlJjLmMoYSxxLGZ1bmN0aW9uKCl7dmFyIGI9Uy5hKGEscSk7cmV0dXJuIGMuYz9jLmMoYixkLGYpOmMuY2FsbChudWxsLGIsZCxmKX0oKSl9ZnVuY3Rpb24gYyhhLGIsYyxkKXt2YXIgZj1SLmMoYiwwLG51bGwpO3JldHVybihiPUVkKGIpKT9SYy5jKGEsZixlLm4oUy5hKGEsZiksYixjLGQpKTpSYy5jKGEsZixmdW5jdGlvbigpe3ZhciBiPVMuYShhLGYpO3JldHVybiBjLmE/Yy5hKGIsZCk6Yy5jYWxsKG51bGwsYixkKX0oKSl9ZnVuY3Rpb24gZChhLGIsYyl7dmFyIGQ9Ui5jKGIsMCxudWxsKTtyZXR1cm4oYj1FZChiKSk/UmMuYyhhLGQsZS5jKFMuYShhLGQpLGIsYykpOlJjLmMoYSxkLGZ1bmN0aW9uKCl7dmFyIGI9XG5TLmEoYSxkKTtyZXR1cm4gYy5iP2MuYihiKTpjLmNhbGwobnVsbCxiKX0oKSl9dmFyIGU9bnVsbCxmPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShjLGQsZSxmLGcsdSx2KXt2YXIgeT1udWxsO2lmKDY8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciB5PTAsQj1BcnJheShhcmd1bWVudHMubGVuZ3RoLTYpO3k8Qi5sZW5ndGg7KUJbeV09YXJndW1lbnRzW3krNl0sKyt5O3k9bmV3IEYoQiwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsYyxkLGUsZixnLHUseSl9ZnVuY3Rpb24gYihhLGMsZCxmLGcsaCx2KXt2YXIgeT1SLmMoYywwLG51bGwpO3JldHVybihjPUVkKGMpKT9SYy5jKGEseSxULmQoZSxTLmEoYSx5KSxjLGQsZixLYyhbZyxoLHZdLDApKSk6UmMuYyhhLHksVC5kKGQsUy5hKGEseSksZixnLGgsS2MoW3ZdLDApKSl9YS5pPTY7YS5mPWZ1bmN0aW9uKGEpe3ZhciBjPUcoYSk7YT1LKGEpO3ZhciBkPUcoYSk7YT1LKGEpO3ZhciBlPUcoYSk7YT1LKGEpO3ZhciBmPUcoYSk7YT1LKGEpO3ZhciBnPVxuRyhhKTthPUsoYSk7dmFyIHY9RyhhKTthPUgoYSk7cmV0dXJuIGIoYyxkLGUsZixnLHYsYSl9O2EuZD1iO3JldHVybiBhfSgpLGU9ZnVuY3Rpb24oZSxoLGwsbSxwLHEscyl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMzpyZXR1cm4gZC5jYWxsKHRoaXMsZSxoLGwpO2Nhc2UgNDpyZXR1cm4gYy5jYWxsKHRoaXMsZSxoLGwsbSk7Y2FzZSA1OnJldHVybiBiLmNhbGwodGhpcyxlLGgsbCxtLHApO2Nhc2UgNjpyZXR1cm4gYS5jYWxsKHRoaXMsZSxoLGwsbSxwLHEpO2RlZmF1bHQ6dmFyIHU9bnVsbDtpZig2PGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgdT0wLHY9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC02KTt1PHYubGVuZ3RoOyl2W3VdPWFyZ3VtZW50c1t1KzZdLCsrdTt1PW5ldyBGKHYsMCl9cmV0dXJuIGYuZChlLGgsbCxtLHAscSx1KX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307ZS5pPTY7ZS5mPWYuZjtlLmM9ZDtlLm49YztcbmUucj1iO2UuUD1hO2UuZD1mLmQ7cmV0dXJuIGV9KCk7ZnVuY3Rpb24gZWYoYSxiKXt0aGlzLnU9YTt0aGlzLmU9Yn1mdW5jdGlvbiBmZihhKXtyZXR1cm4gbmV3IGVmKGEsW251bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbF0pfWZ1bmN0aW9uIGdmKGEpe3JldHVybiBuZXcgZWYoYS51LEZhKGEuZSkpfWZ1bmN0aW9uIGhmKGEpe2E9YS5nO3JldHVybiAzMj5hPzA6YS0xPj4+NTw8NX1mdW5jdGlvbiBqZihhLGIsYyl7Zm9yKDs7KXtpZigwPT09YilyZXR1cm4gYzt2YXIgZD1mZihhKTtkLmVbMF09YztjPWQ7Yi09NX19XG52YXIgbGY9ZnVuY3Rpb24ga2YoYixjLGQsZSl7dmFyIGY9Z2YoZCksZz1iLmctMT4+PmMmMzE7NT09PWM/Zi5lW2ddPWU6KGQ9ZC5lW2ddLGI9bnVsbCE9ZD9rZihiLGMtNSxkLGUpOmpmKG51bGwsYy01LGUpLGYuZVtnXT1iKTtyZXR1cm4gZn07ZnVuY3Rpb24gbWYoYSxiKXt0aHJvdyBFcnJvcihbeihcIk5vIGl0ZW0gXCIpLHooYSkseihcIiBpbiB2ZWN0b3Igb2YgbGVuZ3RoIFwiKSx6KGIpXS5qb2luKFwiXCIpKTt9ZnVuY3Rpb24gbmYoYSxiKXtpZihiPj1oZihhKSlyZXR1cm4gYS5XO2Zvcih2YXIgYz1hLnJvb3QsZD1hLnNoaWZ0OzspaWYoMDxkKXZhciBlPWQtNSxjPWMuZVtiPj4+ZCYzMV0sZD1lO2Vsc2UgcmV0dXJuIGMuZX1mdW5jdGlvbiBvZihhLGIpe3JldHVybiAwPD1iJiZiPGEuZz9uZihhLGIpOm1mKGIsYS5nKX1cbnZhciBxZj1mdW5jdGlvbiBwZihiLGMsZCxlLGYpe3ZhciBnPWdmKGQpO2lmKDA9PT1jKWcuZVtlJjMxXT1mO2Vsc2V7dmFyIGg9ZT4+PmMmMzE7Yj1wZihiLGMtNSxkLmVbaF0sZSxmKTtnLmVbaF09Yn1yZXR1cm4gZ30sc2Y9ZnVuY3Rpb24gcmYoYixjLGQpe3ZhciBlPWIuZy0yPj4+YyYzMTtpZig1PGMpe2I9cmYoYixjLTUsZC5lW2VdKTtpZihudWxsPT1iJiYwPT09ZSlyZXR1cm4gbnVsbDtkPWdmKGQpO2QuZVtlXT1iO3JldHVybiBkfWlmKDA9PT1lKXJldHVybiBudWxsO2Q9Z2YoZCk7ZC5lW2VdPW51bGw7cmV0dXJuIGR9O2Z1bmN0aW9uIHRmKGEsYixjLGQsZSxmKXt0aGlzLm09YTt0aGlzLnpiPWI7dGhpcy5lPWM7dGhpcy5vYT1kO3RoaXMuc3RhcnQ9ZTt0aGlzLmVuZD1mfXRmLnByb3RvdHlwZS5nYT1mdW5jdGlvbigpe3JldHVybiB0aGlzLm08dGhpcy5lbmR9O1xudGYucHJvdG90eXBlLm5leHQ9ZnVuY3Rpb24oKXszMj09PXRoaXMubS10aGlzLnpiJiYodGhpcy5lPW5mKHRoaXMub2EsdGhpcy5tKSx0aGlzLnpiKz0zMik7dmFyIGE9dGhpcy5lW3RoaXMubSYzMV07dGhpcy5tKz0xO3JldHVybiBhfTtmdW5jdGlvbiBXKGEsYixjLGQsZSxmKXt0aGlzLms9YTt0aGlzLmc9Yjt0aGlzLnNoaWZ0PWM7dGhpcy5yb290PWQ7dGhpcy5XPWU7dGhpcy5wPWY7dGhpcy5qPTE2NzY2ODUxMTt0aGlzLnE9ODE5Nn1rPVcucHJvdG90eXBlO2sudG9TdHJpbmc9ZnVuY3Rpb24oKXtyZXR1cm4gZWModGhpcyl9O2sudD1mdW5jdGlvbihhLGIpe3JldHVybiAkYS5jKHRoaXMsYixudWxsKX07ay5zPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm5cIm51bWJlclwiPT09dHlwZW9mIGI/Qy5jKHRoaXMsYixjKTpjfTtcbmsuZ2I9ZnVuY3Rpb24oYSxiLGMpe2E9MDtmb3IodmFyIGQ9Yzs7KWlmKGE8dGhpcy5nKXt2YXIgZT1uZih0aGlzLGEpO2M9ZS5sZW5ndGg7YTp7Zm9yKHZhciBmPTA7OylpZihmPGMpe3ZhciBnPWYrYSxoPWVbZl0sZD1iLmM/Yi5jKGQsZyxoKTpiLmNhbGwobnVsbCxkLGcsaCk7aWYoQWMoZCkpe2U9ZDticmVhayBhfWYrPTF9ZWxzZXtlPWQ7YnJlYWsgYX1lPXZvaWQgMH1pZihBYyhlKSlyZXR1cm4gYj1lLEwuYj9MLmIoYik6TC5jYWxsKG51bGwsYik7YSs9YztkPWV9ZWxzZSByZXR1cm4gZH07ay5RPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG9mKHRoaXMsYilbYiYzMV19O2suJD1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIDA8PWImJmI8dGhpcy5nP25mKHRoaXMsYilbYiYzMV06Y307XG5rLlVhPWZ1bmN0aW9uKGEsYixjKXtpZigwPD1iJiZiPHRoaXMuZylyZXR1cm4gaGYodGhpcyk8PWI/KGE9RmEodGhpcy5XKSxhW2ImMzFdPWMsbmV3IFcodGhpcy5rLHRoaXMuZyx0aGlzLnNoaWZ0LHRoaXMucm9vdCxhLG51bGwpKTpuZXcgVyh0aGlzLmssdGhpcy5nLHRoaXMuc2hpZnQscWYodGhpcyx0aGlzLnNoaWZ0LHRoaXMucm9vdCxiLGMpLHRoaXMuVyxudWxsKTtpZihiPT09dGhpcy5nKXJldHVybiBSYSh0aGlzLGMpO3Rocm93IEVycm9yKFt6KFwiSW5kZXggXCIpLHooYikseihcIiBvdXQgb2YgYm91bmRzICBbMCxcIikseih0aGlzLmcpLHooXCJdXCIpXS5qb2luKFwiXCIpKTt9O2sudmI9ITA7ay5mYj1mdW5jdGlvbigpe3ZhciBhPXRoaXMuZztyZXR1cm4gbmV3IHRmKDAsMCwwPFEodGhpcyk/bmYodGhpcywwKTpudWxsLHRoaXMsMCxhKX07ay5IPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMua307ay5MPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuZ307XG5rLmhiPWZ1bmN0aW9uKCl7cmV0dXJuIEMuYSh0aGlzLDApfTtrLmliPWZ1bmN0aW9uKCl7cmV0dXJuIEMuYSh0aGlzLDEpfTtrLkxhPWZ1bmN0aW9uKCl7cmV0dXJuIDA8dGhpcy5nP0MuYSh0aGlzLHRoaXMuZy0xKTpudWxsfTtcbmsuTWE9ZnVuY3Rpb24oKXtpZigwPT09dGhpcy5nKXRocm93IEVycm9yKFwiQ2FuJ3QgcG9wIGVtcHR5IHZlY3RvclwiKTtpZigxPT09dGhpcy5nKXJldHVybiB1YihNYyx0aGlzLmspO2lmKDE8dGhpcy5nLWhmKHRoaXMpKXJldHVybiBuZXcgVyh0aGlzLmssdGhpcy5nLTEsdGhpcy5zaGlmdCx0aGlzLnJvb3QsdGhpcy5XLnNsaWNlKDAsLTEpLG51bGwpO3ZhciBhPW5mKHRoaXMsdGhpcy5nLTIpLGI9c2YodGhpcyx0aGlzLnNoaWZ0LHRoaXMucm9vdCksYj1udWxsPT1iP3VmOmIsYz10aGlzLmctMTtyZXR1cm4gNTx0aGlzLnNoaWZ0JiZudWxsPT1iLmVbMV0/bmV3IFcodGhpcy5rLGMsdGhpcy5zaGlmdC01LGIuZVswXSxhLG51bGwpOm5ldyBXKHRoaXMuayxjLHRoaXMuc2hpZnQsYixhLG51bGwpfTtrLmFiPWZ1bmN0aW9uKCl7cmV0dXJuIDA8dGhpcy5nP25ldyBIYyh0aGlzLHRoaXMuZy0xLG51bGwpOm51bGx9O1xuay5CPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5wO3JldHVybiBudWxsIT1hP2E6dGhpcy5wPWE9d2ModGhpcyl9O2suQT1mdW5jdGlvbihhLGIpe2lmKGIgaW5zdGFuY2VvZiBXKWlmKHRoaXMuZz09PVEoYikpZm9yKHZhciBjPWNjKHRoaXMpLGQ9Y2MoYik7OylpZih0KGMuZ2EoKSkpe3ZhciBlPWMubmV4dCgpLGY9ZC5uZXh0KCk7aWYoIXNjLmEoZSxmKSlyZXR1cm4hMX1lbHNlIHJldHVybiEwO2Vsc2UgcmV0dXJuITE7ZWxzZSByZXR1cm4gSWModGhpcyxiKX07ay4kYT1mdW5jdGlvbigpe3ZhciBhPXRoaXM7cmV0dXJuIG5ldyB2ZihhLmcsYS5zaGlmdCxmdW5jdGlvbigpe3ZhciBiPWEucm9vdDtyZXR1cm4gd2YuYj93Zi5iKGIpOndmLmNhbGwobnVsbCxiKX0oKSxmdW5jdGlvbigpe3ZhciBiPWEuVztyZXR1cm4geGYuYj94Zi5iKGIpOnhmLmNhbGwobnVsbCxiKX0oKSl9O2suSj1mdW5jdGlvbigpe3JldHVybiBPKE1jLHRoaXMuayl9O1xuay5SPWZ1bmN0aW9uKGEsYil7cmV0dXJuIENjLmEodGhpcyxiKX07ay5PPWZ1bmN0aW9uKGEsYixjKXthPTA7Zm9yKHZhciBkPWM7OylpZihhPHRoaXMuZyl7dmFyIGU9bmYodGhpcyxhKTtjPWUubGVuZ3RoO2E6e2Zvcih2YXIgZj0wOzspaWYoZjxjKXt2YXIgZz1lW2ZdLGQ9Yi5hP2IuYShkLGcpOmIuY2FsbChudWxsLGQsZyk7aWYoQWMoZCkpe2U9ZDticmVhayBhfWYrPTF9ZWxzZXtlPWQ7YnJlYWsgYX1lPXZvaWQgMH1pZihBYyhlKSlyZXR1cm4gYj1lLEwuYj9MLmIoYik6TC5jYWxsKG51bGwsYik7YSs9YztkPWV9ZWxzZSByZXR1cm4gZH07ay5LYT1mdW5jdGlvbihhLGIsYyl7aWYoXCJudW1iZXJcIj09PXR5cGVvZiBiKXJldHVybiBwYih0aGlzLGIsYyk7dGhyb3cgRXJyb3IoXCJWZWN0b3IncyBrZXkgZm9yIGFzc29jIG11c3QgYmUgYSBudW1iZXIuXCIpO307XG5rLkQ9ZnVuY3Rpb24oKXtpZigwPT09dGhpcy5nKXJldHVybiBudWxsO2lmKDMyPj10aGlzLmcpcmV0dXJuIG5ldyBGKHRoaXMuVywwKTt2YXIgYTthOnthPXRoaXMucm9vdDtmb3IodmFyIGI9dGhpcy5zaGlmdDs7KWlmKDA8YiliLT01LGE9YS5lWzBdO2Vsc2V7YT1hLmU7YnJlYWsgYX1hPXZvaWQgMH1yZXR1cm4geWYubj95Zi5uKHRoaXMsYSwwLDApOnlmLmNhbGwobnVsbCx0aGlzLGEsMCwwKX07ay5GPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyBXKGIsdGhpcy5nLHRoaXMuc2hpZnQsdGhpcy5yb290LHRoaXMuVyx0aGlzLnApfTtcbmsuRz1mdW5jdGlvbihhLGIpe2lmKDMyPnRoaXMuZy1oZih0aGlzKSl7Zm9yKHZhciBjPXRoaXMuVy5sZW5ndGgsZD1BcnJheShjKzEpLGU9MDs7KWlmKGU8YylkW2VdPXRoaXMuV1tlXSxlKz0xO2Vsc2UgYnJlYWs7ZFtjXT1iO3JldHVybiBuZXcgVyh0aGlzLmssdGhpcy5nKzEsdGhpcy5zaGlmdCx0aGlzLnJvb3QsZCxudWxsKX1jPShkPXRoaXMuZz4+PjU+MTw8dGhpcy5zaGlmdCk/dGhpcy5zaGlmdCs1OnRoaXMuc2hpZnQ7ZD8oZD1mZihudWxsKSxkLmVbMF09dGhpcy5yb290LGU9amYobnVsbCx0aGlzLnNoaWZ0LG5ldyBlZihudWxsLHRoaXMuVykpLGQuZVsxXT1lKTpkPWxmKHRoaXMsdGhpcy5zaGlmdCx0aGlzLnJvb3QsbmV3IGVmKG51bGwsdGhpcy5XKSk7cmV0dXJuIG5ldyBXKHRoaXMuayx0aGlzLmcrMSxjLGQsW2JdLG51bGwpfTtcbmsuY2FsbD1mdW5jdGlvbigpe3ZhciBhPW51bGwsYT1mdW5jdGlvbihhLGMsZCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gdGhpcy5RKG51bGwsYyk7Y2FzZSAzOnJldHVybiB0aGlzLiQobnVsbCxjLGQpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTthLmE9ZnVuY3Rpb24oYSxjKXtyZXR1cm4gdGhpcy5RKG51bGwsYyl9O2EuYz1mdW5jdGlvbihhLGMsZCl7cmV0dXJuIHRoaXMuJChudWxsLGMsZCl9O3JldHVybiBhfSgpO2suYXBwbHk9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gdGhpcy5jYWxsLmFwcGx5KHRoaXMsW3RoaXNdLmNvbmNhdChGYShiKSkpfTtrLmI9ZnVuY3Rpb24oYSl7cmV0dXJuIHRoaXMuUShudWxsLGEpfTtrLmE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gdGhpcy4kKG51bGwsYSxiKX07XG52YXIgdWY9bmV3IGVmKG51bGwsW251bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbF0pLE1jPW5ldyBXKG51bGwsMCw1LHVmLFtdLDApO1cucHJvdG90eXBlW0VhXT1mdW5jdGlvbigpe3JldHVybiB1Yyh0aGlzKX07ZnVuY3Rpb24gemYoYSl7cmV0dXJuIFFiKEEuYyhQYixPYihNYyksYSkpfVxudmFyIEFmPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhKXt2YXIgZD1udWxsO2lmKDA8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBkPTAsZT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTApO2Q8ZS5sZW5ndGg7KWVbZF09YXJndW1lbnRzW2QrMF0sKytkO2Q9bmV3IEYoZSwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsZCl9ZnVuY3Rpb24gYihhKXtpZihhIGluc3RhbmNlb2YgRiYmMD09PWEubSlhOnthPWEuZTt2YXIgYj1hLmxlbmd0aDtpZigzMj5iKWE9bmV3IFcobnVsbCxiLDUsdWYsYSxudWxsKTtlbHNle2Zvcih2YXIgZT0zMixmPShuZXcgVyhudWxsLDMyLDUsdWYsYS5zbGljZSgwLDMyKSxudWxsKSkuJGEobnVsbCk7OylpZihlPGIpdmFyIGc9ZSsxLGY9ZGUuYShmLGFbZV0pLGU9ZztlbHNle2E9UWIoZik7YnJlYWsgYX1hPXZvaWQgMH19ZWxzZSBhPXpmKGEpO3JldHVybiBhfWEuaT0wO2EuZj1mdW5jdGlvbihhKXthPUQoYSk7cmV0dXJuIGIoYSl9O2EuZD1iO3JldHVybiBhfSgpO1xuZnVuY3Rpb24gQmYoYSxiLGMsZCxlLGYpe3RoaXMuaGE9YTt0aGlzLkphPWI7dGhpcy5tPWM7dGhpcy5WPWQ7dGhpcy5rPWU7dGhpcy5wPWY7dGhpcy5qPTMyMzc1MDIwO3RoaXMucT0xNTM2fWs9QmYucHJvdG90eXBlO2sudG9TdHJpbmc9ZnVuY3Rpb24oKXtyZXR1cm4gZWModGhpcyl9O2suSD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmt9O2suVD1mdW5jdGlvbigpe2lmKHRoaXMuVisxPHRoaXMuSmEubGVuZ3RoKXt2YXIgYTthPXRoaXMuaGE7dmFyIGI9dGhpcy5KYSxjPXRoaXMubSxkPXRoaXMuVisxO2E9eWYubj95Zi5uKGEsYixjLGQpOnlmLmNhbGwobnVsbCxhLGIsYyxkKTtyZXR1cm4gbnVsbD09YT9udWxsOmF9cmV0dXJuICRiKHRoaXMpfTtrLkI9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLnA7cmV0dXJuIG51bGwhPWE/YTp0aGlzLnA9YT13Yyh0aGlzKX07ay5BPWZ1bmN0aW9uKGEsYil7cmV0dXJuIEljKHRoaXMsYil9O2suSj1mdW5jdGlvbigpe3JldHVybiBPKE1jLHRoaXMuayl9O1xuay5SPWZ1bmN0aW9uKGEsYil7dmFyIGM9dGhpcztyZXR1cm4gQ2MuYShmdW5jdGlvbigpe3ZhciBhPWMuaGEsYj1jLm0rYy5WLGY9UShjLmhhKTtyZXR1cm4gQ2YuYz9DZi5jKGEsYixmKTpDZi5jYWxsKG51bGwsYSxiLGYpfSgpLGIpfTtrLk89ZnVuY3Rpb24oYSxiLGMpe3ZhciBkPXRoaXM7cmV0dXJuIENjLmMoZnVuY3Rpb24oKXt2YXIgYT1kLmhhLGI9ZC5tK2QuVixjPVEoZC5oYSk7cmV0dXJuIENmLmM/Q2YuYyhhLGIsYyk6Q2YuY2FsbChudWxsLGEsYixjKX0oKSxiLGMpfTtrLk49ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5KYVt0aGlzLlZdfTtrLlM9ZnVuY3Rpb24oKXtpZih0aGlzLlYrMTx0aGlzLkphLmxlbmd0aCl7dmFyIGE7YT10aGlzLmhhO3ZhciBiPXRoaXMuSmEsYz10aGlzLm0sZD10aGlzLlYrMTthPXlmLm4/eWYubihhLGIsYyxkKTp5Zi5jYWxsKG51bGwsYSxiLGMsZCk7cmV0dXJuIG51bGw9PWE/SjphfXJldHVybiBaYih0aGlzKX07ay5EPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXN9O1xuay5DYj1mdW5jdGlvbigpe3JldHVybiBVZC5hKHRoaXMuSmEsdGhpcy5WKX07ay5EYj1mdW5jdGlvbigpe3ZhciBhPXRoaXMubSt0aGlzLkphLmxlbmd0aDtpZihhPE1hKHRoaXMuaGEpKXt2YXIgYj10aGlzLmhhLGM9bmYodGhpcy5oYSxhKTtyZXR1cm4geWYubj95Zi5uKGIsYyxhLDApOnlmLmNhbGwobnVsbCxiLGMsYSwwKX1yZXR1cm4gSn07ay5GPWZ1bmN0aW9uKGEsYil7dmFyIGM9dGhpcy5oYSxkPXRoaXMuSmEsZT10aGlzLm0sZj10aGlzLlY7cmV0dXJuIHlmLnI/eWYucihjLGQsZSxmLGIpOnlmLmNhbGwobnVsbCxjLGQsZSxmLGIpfTtrLkc9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gTShiLHRoaXMpfTtrLkJiPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5tK3RoaXMuSmEubGVuZ3RoO2lmKGE8TWEodGhpcy5oYSkpe3ZhciBiPXRoaXMuaGEsYz1uZih0aGlzLmhhLGEpO3JldHVybiB5Zi5uP3lmLm4oYixjLGEsMCk6eWYuY2FsbChudWxsLGIsYyxhLDApfXJldHVybiBudWxsfTtcbkJmLnByb3RvdHlwZVtFYV09ZnVuY3Rpb24oKXtyZXR1cm4gdWModGhpcyl9O3ZhciB5Zj1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMsZCxsKXtyZXR1cm4gbmV3IEJmKGEsYixjLGQsbCxudWxsKX1mdW5jdGlvbiBiKGEsYixjLGQpe3JldHVybiBuZXcgQmYoYSxiLGMsZCxudWxsLG51bGwpfWZ1bmN0aW9uIGMoYSxiLGMpe3JldHVybiBuZXcgQmYoYSxvZihhLGIpLGIsYyxudWxsLG51bGwpfXZhciBkPW51bGwsZD1mdW5jdGlvbihkLGYsZyxoLGwpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDM6cmV0dXJuIGMuY2FsbCh0aGlzLGQsZixnKTtjYXNlIDQ6cmV0dXJuIGIuY2FsbCh0aGlzLGQsZixnLGgpO2Nhc2UgNTpyZXR1cm4gYS5jYWxsKHRoaXMsZCxmLGcsaCxsKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307ZC5jPWM7ZC5uPWI7ZC5yPWE7cmV0dXJuIGR9KCk7XG5mdW5jdGlvbiBEZihhLGIsYyxkLGUpe3RoaXMuaz1hO3RoaXMub2E9Yjt0aGlzLnN0YXJ0PWM7dGhpcy5lbmQ9ZDt0aGlzLnA9ZTt0aGlzLmo9MTY2NjE3ODg3O3RoaXMucT04MTkyfWs9RGYucHJvdG90eXBlO2sudG9TdHJpbmc9ZnVuY3Rpb24oKXtyZXR1cm4gZWModGhpcyl9O2sudD1mdW5jdGlvbihhLGIpe3JldHVybiAkYS5jKHRoaXMsYixudWxsKX07ay5zPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm5cIm51bWJlclwiPT09dHlwZW9mIGI/Qy5jKHRoaXMsYixjKTpjfTtrLlE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gMD5ifHx0aGlzLmVuZDw9dGhpcy5zdGFydCtiP21mKGIsdGhpcy5lbmQtdGhpcy5zdGFydCk6Qy5hKHRoaXMub2EsdGhpcy5zdGFydCtiKX07ay4kPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gMD5ifHx0aGlzLmVuZDw9dGhpcy5zdGFydCtiP2M6Qy5jKHRoaXMub2EsdGhpcy5zdGFydCtiLGMpfTtcbmsuVWE9ZnVuY3Rpb24oYSxiLGMpe3ZhciBkPXRoaXMuc3RhcnQrYjthPXRoaXMuaztjPVJjLmModGhpcy5vYSxkLGMpO2I9dGhpcy5zdGFydDt2YXIgZT10aGlzLmVuZCxkPWQrMSxkPWU+ZD9lOmQ7cmV0dXJuIEVmLnI/RWYucihhLGMsYixkLG51bGwpOkVmLmNhbGwobnVsbCxhLGMsYixkLG51bGwpfTtrLkg9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5rfTtrLkw9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5lbmQtdGhpcy5zdGFydH07ay5MYT1mdW5jdGlvbigpe3JldHVybiBDLmEodGhpcy5vYSx0aGlzLmVuZC0xKX07ay5NYT1mdW5jdGlvbigpe2lmKHRoaXMuc3RhcnQ9PT10aGlzLmVuZCl0aHJvdyBFcnJvcihcIkNhbid0IHBvcCBlbXB0eSB2ZWN0b3JcIik7dmFyIGE9dGhpcy5rLGI9dGhpcy5vYSxjPXRoaXMuc3RhcnQsZD10aGlzLmVuZC0xO3JldHVybiBFZi5yP0VmLnIoYSxiLGMsZCxudWxsKTpFZi5jYWxsKG51bGwsYSxiLGMsZCxudWxsKX07XG5rLmFiPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuc3RhcnQhPT10aGlzLmVuZD9uZXcgSGModGhpcyx0aGlzLmVuZC10aGlzLnN0YXJ0LTEsbnVsbCk6bnVsbH07ay5CPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5wO3JldHVybiBudWxsIT1hP2E6dGhpcy5wPWE9d2ModGhpcyl9O2suQT1mdW5jdGlvbihhLGIpe3JldHVybiBJYyh0aGlzLGIpfTtrLko9ZnVuY3Rpb24oKXtyZXR1cm4gTyhNYyx0aGlzLmspfTtrLlI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gQ2MuYSh0aGlzLGIpfTtrLk89ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBDYy5jKHRoaXMsYixjKX07ay5LYT1mdW5jdGlvbihhLGIsYyl7aWYoXCJudW1iZXJcIj09PXR5cGVvZiBiKXJldHVybiBwYih0aGlzLGIsYyk7dGhyb3cgRXJyb3IoXCJTdWJ2ZWMncyBrZXkgZm9yIGFzc29jIG11c3QgYmUgYSBudW1iZXIuXCIpO307XG5rLkQ9ZnVuY3Rpb24oKXt2YXIgYT10aGlzO3JldHVybiBmdW5jdGlvbihiKXtyZXR1cm4gZnVuY3Rpb24gZChlKXtyZXR1cm4gZT09PWEuZW5kP251bGw6TShDLmEoYS5vYSxlKSxuZXcgVihudWxsLGZ1bmN0aW9uKCl7cmV0dXJuIGZ1bmN0aW9uKCl7cmV0dXJuIGQoZSsxKX19KGIpLG51bGwsbnVsbCkpfX0odGhpcykoYS5zdGFydCl9O2suRj1mdW5jdGlvbihhLGIpe3ZhciBjPXRoaXMub2EsZD10aGlzLnN0YXJ0LGU9dGhpcy5lbmQsZj10aGlzLnA7cmV0dXJuIEVmLnI/RWYucihiLGMsZCxlLGYpOkVmLmNhbGwobnVsbCxiLGMsZCxlLGYpfTtrLkc9ZnVuY3Rpb24oYSxiKXt2YXIgYz10aGlzLmssZD1wYih0aGlzLm9hLHRoaXMuZW5kLGIpLGU9dGhpcy5zdGFydCxmPXRoaXMuZW5kKzE7cmV0dXJuIEVmLnI/RWYucihjLGQsZSxmLG51bGwpOkVmLmNhbGwobnVsbCxjLGQsZSxmLG51bGwpfTtcbmsuY2FsbD1mdW5jdGlvbigpe3ZhciBhPW51bGwsYT1mdW5jdGlvbihhLGMsZCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gdGhpcy5RKG51bGwsYyk7Y2FzZSAzOnJldHVybiB0aGlzLiQobnVsbCxjLGQpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTthLmE9ZnVuY3Rpb24oYSxjKXtyZXR1cm4gdGhpcy5RKG51bGwsYyl9O2EuYz1mdW5jdGlvbihhLGMsZCl7cmV0dXJuIHRoaXMuJChudWxsLGMsZCl9O3JldHVybiBhfSgpO2suYXBwbHk9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gdGhpcy5jYWxsLmFwcGx5KHRoaXMsW3RoaXNdLmNvbmNhdChGYShiKSkpfTtrLmI9ZnVuY3Rpb24oYSl7cmV0dXJuIHRoaXMuUShudWxsLGEpfTtrLmE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gdGhpcy4kKG51bGwsYSxiKX07RGYucHJvdG90eXBlW0VhXT1mdW5jdGlvbigpe3JldHVybiB1Yyh0aGlzKX07XG5mdW5jdGlvbiBFZihhLGIsYyxkLGUpe2Zvcig7OylpZihiIGluc3RhbmNlb2YgRGYpYz1iLnN0YXJ0K2MsZD1iLnN0YXJ0K2QsYj1iLm9hO2Vsc2V7dmFyIGY9UShiKTtpZigwPmN8fDA+ZHx8Yz5mfHxkPmYpdGhyb3cgRXJyb3IoXCJJbmRleCBvdXQgb2YgYm91bmRzXCIpO3JldHVybiBuZXcgRGYoYSxiLGMsZCxlKX19dmFyIENmPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyl7cmV0dXJuIEVmKG51bGwsYSxiLGMsbnVsbCl9ZnVuY3Rpb24gYihhLGIpe3JldHVybiBjLmMoYSxiLFEoYSkpfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gYi5jYWxsKHRoaXMsYyxlKTtjYXNlIDM6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSxmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5hPWI7Yy5jPWE7cmV0dXJuIGN9KCk7XG5mdW5jdGlvbiBGZihhLGIpe3JldHVybiBhPT09Yi51P2I6bmV3IGVmKGEsRmEoYi5lKSl9ZnVuY3Rpb24gd2YoYSl7cmV0dXJuIG5ldyBlZih7fSxGYShhLmUpKX1mdW5jdGlvbiB4ZihhKXt2YXIgYj1bbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsXTtoZChhLDAsYiwwLGEubGVuZ3RoKTtyZXR1cm4gYn1cbnZhciBIZj1mdW5jdGlvbiBHZihiLGMsZCxlKXtkPUZmKGIucm9vdC51LGQpO3ZhciBmPWIuZy0xPj4+YyYzMTtpZig1PT09YyliPWU7ZWxzZXt2YXIgZz1kLmVbZl07Yj1udWxsIT1nP0dmKGIsYy01LGcsZSk6amYoYi5yb290LnUsYy01LGUpfWQuZVtmXT1iO3JldHVybiBkfSxKZj1mdW5jdGlvbiBJZihiLGMsZCl7ZD1GZihiLnJvb3QudSxkKTt2YXIgZT1iLmctMj4+PmMmMzE7aWYoNTxjKXtiPUlmKGIsYy01LGQuZVtlXSk7aWYobnVsbD09YiYmMD09PWUpcmV0dXJuIG51bGw7ZC5lW2VdPWI7cmV0dXJuIGR9aWYoMD09PWUpcmV0dXJuIG51bGw7ZC5lW2VdPW51bGw7cmV0dXJuIGR9O2Z1bmN0aW9uIHZmKGEsYixjLGQpe3RoaXMuZz1hO3RoaXMuc2hpZnQ9Yjt0aGlzLnJvb3Q9Yzt0aGlzLlc9ZDt0aGlzLmo9Mjc1O3RoaXMucT04OH1rPXZmLnByb3RvdHlwZTtcbmsuY2FsbD1mdW5jdGlvbigpe3ZhciBhPW51bGwsYT1mdW5jdGlvbihhLGMsZCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gdGhpcy50KG51bGwsYyk7Y2FzZSAzOnJldHVybiB0aGlzLnMobnVsbCxjLGQpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTthLmE9ZnVuY3Rpb24oYSxjKXtyZXR1cm4gdGhpcy50KG51bGwsYyl9O2EuYz1mdW5jdGlvbihhLGMsZCl7cmV0dXJuIHRoaXMucyhudWxsLGMsZCl9O3JldHVybiBhfSgpO2suYXBwbHk9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gdGhpcy5jYWxsLmFwcGx5KHRoaXMsW3RoaXNdLmNvbmNhdChGYShiKSkpfTtrLmI9ZnVuY3Rpb24oYSl7cmV0dXJuIHRoaXMudChudWxsLGEpfTtrLmE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gdGhpcy5zKG51bGwsYSxiKX07ay50PWZ1bmN0aW9uKGEsYil7cmV0dXJuICRhLmModGhpcyxiLG51bGwpfTtcbmsucz1mdW5jdGlvbihhLGIsYyl7cmV0dXJuXCJudW1iZXJcIj09PXR5cGVvZiBiP0MuYyh0aGlzLGIsYyk6Y307ay5RPWZ1bmN0aW9uKGEsYil7aWYodGhpcy5yb290LnUpcmV0dXJuIG9mKHRoaXMsYilbYiYzMV07dGhyb3cgRXJyb3IoXCJudGggYWZ0ZXIgcGVyc2lzdGVudCFcIik7fTtrLiQ9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiAwPD1iJiZiPHRoaXMuZz9DLmEodGhpcyxiKTpjfTtrLkw9ZnVuY3Rpb24oKXtpZih0aGlzLnJvb3QudSlyZXR1cm4gdGhpcy5nO3Rocm93IEVycm9yKFwiY291bnQgYWZ0ZXIgcGVyc2lzdGVudCFcIik7fTtcbmsuVWI9ZnVuY3Rpb24oYSxiLGMpe3ZhciBkPXRoaXM7aWYoZC5yb290LnUpe2lmKDA8PWImJmI8ZC5nKXJldHVybiBoZih0aGlzKTw9Yj9kLldbYiYzMV09YzooYT1mdW5jdGlvbigpe3JldHVybiBmdW5jdGlvbiBmKGEsaCl7dmFyIGw9RmYoZC5yb290LnUsaCk7aWYoMD09PWEpbC5lW2ImMzFdPWM7ZWxzZXt2YXIgbT1iPj4+YSYzMSxwPWYoYS01LGwuZVttXSk7bC5lW21dPXB9cmV0dXJuIGx9fSh0aGlzKS5jYWxsKG51bGwsZC5zaGlmdCxkLnJvb3QpLGQucm9vdD1hKSx0aGlzO2lmKGI9PT1kLmcpcmV0dXJuIFBiKHRoaXMsYyk7dGhyb3cgRXJyb3IoW3ooXCJJbmRleCBcIikseihiKSx6KFwiIG91dCBvZiBib3VuZHMgZm9yIFRyYW5zaWVudFZlY3RvciBvZiBsZW5ndGhcIikseihkLmcpXS5qb2luKFwiXCIpKTt9dGhyb3cgRXJyb3IoXCJhc3NvYyEgYWZ0ZXIgcGVyc2lzdGVudCFcIik7fTtcbmsuVmI9ZnVuY3Rpb24oKXtpZih0aGlzLnJvb3QudSl7aWYoMD09PXRoaXMuZyl0aHJvdyBFcnJvcihcIkNhbid0IHBvcCBlbXB0eSB2ZWN0b3JcIik7aWYoMT09PXRoaXMuZyl0aGlzLmc9MDtlbHNlIGlmKDA8KHRoaXMuZy0xJjMxKSl0aGlzLmctPTE7ZWxzZXt2YXIgYTthOmlmKGE9dGhpcy5nLTIsYT49aGYodGhpcykpYT10aGlzLlc7ZWxzZXtmb3IodmFyIGI9dGhpcy5yb290LGM9YixkPXRoaXMuc2hpZnQ7OylpZigwPGQpYz1GZihiLnUsYy5lW2E+Pj5kJjMxXSksZC09NTtlbHNle2E9Yy5lO2JyZWFrIGF9YT12b2lkIDB9Yj1KZih0aGlzLHRoaXMuc2hpZnQsdGhpcy5yb290KTtiPW51bGwhPWI/YjpuZXcgZWYodGhpcy5yb290LnUsW251bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsXG5udWxsLG51bGwsbnVsbCxudWxsXSk7NTx0aGlzLnNoaWZ0JiZudWxsPT1iLmVbMV0/KHRoaXMucm9vdD1GZih0aGlzLnJvb3QudSxiLmVbMF0pLHRoaXMuc2hpZnQtPTUpOnRoaXMucm9vdD1iO3RoaXMuZy09MTt0aGlzLlc9YX1yZXR1cm4gdGhpc310aHJvdyBFcnJvcihcInBvcCEgYWZ0ZXIgcGVyc2lzdGVudCFcIik7fTtrLmtiPWZ1bmN0aW9uKGEsYixjKXtpZihcIm51bWJlclwiPT09dHlwZW9mIGIpcmV0dXJuIFRiKHRoaXMsYixjKTt0aHJvdyBFcnJvcihcIlRyYW5zaWVudFZlY3RvcidzIGtleSBmb3IgYXNzb2MhIG11c3QgYmUgYSBudW1iZXIuXCIpO307XG5rLlNhPWZ1bmN0aW9uKGEsYil7aWYodGhpcy5yb290LnUpe2lmKDMyPnRoaXMuZy1oZih0aGlzKSl0aGlzLldbdGhpcy5nJjMxXT1iO2Vsc2V7dmFyIGM9bmV3IGVmKHRoaXMucm9vdC51LHRoaXMuVyksZD1bbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsXTtkWzBdPWI7dGhpcy5XPWQ7aWYodGhpcy5nPj4+NT4xPDx0aGlzLnNoaWZ0KXt2YXIgZD1bbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsXSxlPXRoaXMuc2hpZnQrXG41O2RbMF09dGhpcy5yb290O2RbMV09amYodGhpcy5yb290LnUsdGhpcy5zaGlmdCxjKTt0aGlzLnJvb3Q9bmV3IGVmKHRoaXMucm9vdC51LGQpO3RoaXMuc2hpZnQ9ZX1lbHNlIHRoaXMucm9vdD1IZih0aGlzLHRoaXMuc2hpZnQsdGhpcy5yb290LGMpfXRoaXMuZys9MTtyZXR1cm4gdGhpc310aHJvdyBFcnJvcihcImNvbmohIGFmdGVyIHBlcnNpc3RlbnQhXCIpO307ay5UYT1mdW5jdGlvbigpe2lmKHRoaXMucm9vdC51KXt0aGlzLnJvb3QudT1udWxsO3ZhciBhPXRoaXMuZy1oZih0aGlzKSxiPUFycmF5KGEpO2hkKHRoaXMuVywwLGIsMCxhKTtyZXR1cm4gbmV3IFcobnVsbCx0aGlzLmcsdGhpcy5zaGlmdCx0aGlzLnJvb3QsYixudWxsKX10aHJvdyBFcnJvcihcInBlcnNpc3RlbnQhIGNhbGxlZCB0d2ljZVwiKTt9O2Z1bmN0aW9uIEtmKGEsYixjLGQpe3RoaXMuaz1hO3RoaXMuZWE9Yjt0aGlzLnNhPWM7dGhpcy5wPWQ7dGhpcy5xPTA7dGhpcy5qPTMxODUwNTcyfWs9S2YucHJvdG90eXBlO1xuay50b1N0cmluZz1mdW5jdGlvbigpe3JldHVybiBlYyh0aGlzKX07ay5IPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMua307ay5CPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5wO3JldHVybiBudWxsIT1hP2E6dGhpcy5wPWE9d2ModGhpcyl9O2suQT1mdW5jdGlvbihhLGIpe3JldHVybiBJYyh0aGlzLGIpfTtrLko9ZnVuY3Rpb24oKXtyZXR1cm4gTyhKLHRoaXMuayl9O2suTj1mdW5jdGlvbigpe3JldHVybiBHKHRoaXMuZWEpfTtrLlM9ZnVuY3Rpb24oKXt2YXIgYT1LKHRoaXMuZWEpO3JldHVybiBhP25ldyBLZih0aGlzLmssYSx0aGlzLnNhLG51bGwpOm51bGw9PXRoaXMuc2E/TmEodGhpcyk6bmV3IEtmKHRoaXMuayx0aGlzLnNhLG51bGwsbnVsbCl9O2suRD1mdW5jdGlvbigpe3JldHVybiB0aGlzfTtrLkY9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IEtmKGIsdGhpcy5lYSx0aGlzLnNhLHRoaXMucCl9O2suRz1mdW5jdGlvbihhLGIpe3JldHVybiBNKGIsdGhpcyl9O1xuS2YucHJvdG90eXBlW0VhXT1mdW5jdGlvbigpe3JldHVybiB1Yyh0aGlzKX07ZnVuY3Rpb24gTGYoYSxiLGMsZCxlKXt0aGlzLms9YTt0aGlzLmNvdW50PWI7dGhpcy5lYT1jO3RoaXMuc2E9ZDt0aGlzLnA9ZTt0aGlzLmo9MzE4NTg3NjY7dGhpcy5xPTgxOTJ9az1MZi5wcm90b3R5cGU7ay50b1N0cmluZz1mdW5jdGlvbigpe3JldHVybiBlYyh0aGlzKX07ay5IPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMua307ay5MPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuY291bnR9O2suTGE9ZnVuY3Rpb24oKXtyZXR1cm4gRyh0aGlzLmVhKX07ay5NYT1mdW5jdGlvbigpe2lmKHQodGhpcy5lYSkpe3ZhciBhPUsodGhpcy5lYSk7cmV0dXJuIGE/bmV3IExmKHRoaXMuayx0aGlzLmNvdW50LTEsYSx0aGlzLnNhLG51bGwpOm5ldyBMZih0aGlzLmssdGhpcy5jb3VudC0xLEQodGhpcy5zYSksTWMsbnVsbCl9cmV0dXJuIHRoaXN9O1xuay5CPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5wO3JldHVybiBudWxsIT1hP2E6dGhpcy5wPWE9d2ModGhpcyl9O2suQT1mdW5jdGlvbihhLGIpe3JldHVybiBJYyh0aGlzLGIpfTtrLko9ZnVuY3Rpb24oKXtyZXR1cm4gTyhNZix0aGlzLmspfTtrLk49ZnVuY3Rpb24oKXtyZXR1cm4gRyh0aGlzLmVhKX07ay5TPWZ1bmN0aW9uKCl7cmV0dXJuIEgoRCh0aGlzKSl9O2suRD1mdW5jdGlvbigpe3ZhciBhPUQodGhpcy5zYSksYj10aGlzLmVhO3JldHVybiB0KHQoYik/YjphKT9uZXcgS2YobnVsbCx0aGlzLmVhLEQoYSksbnVsbCk6bnVsbH07ay5GPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyBMZihiLHRoaXMuY291bnQsdGhpcy5lYSx0aGlzLnNhLHRoaXMucCl9O1xuay5HPWZ1bmN0aW9uKGEsYil7dmFyIGM7dCh0aGlzLmVhKT8oYz10aGlzLnNhLGM9bmV3IExmKHRoaXMuayx0aGlzLmNvdW50KzEsdGhpcy5lYSxOYy5hKHQoYyk/YzpNYyxiKSxudWxsKSk6Yz1uZXcgTGYodGhpcy5rLHRoaXMuY291bnQrMSxOYy5hKHRoaXMuZWEsYiksTWMsbnVsbCk7cmV0dXJuIGN9O3ZhciBNZj1uZXcgTGYobnVsbCwwLG51bGwsTWMsMCk7TGYucHJvdG90eXBlW0VhXT1mdW5jdGlvbigpe3JldHVybiB1Yyh0aGlzKX07ZnVuY3Rpb24gTmYoKXt0aGlzLnE9MDt0aGlzLmo9MjA5NzE1Mn1OZi5wcm90b3R5cGUuQT1mdW5jdGlvbigpe3JldHVybiExfTt2YXIgT2Y9bmV3IE5mO2Z1bmN0aW9uIFBmKGEsYil7cmV0dXJuIG1kKGRkKGIpP1EoYSk9PT1RKGIpP0VlKHVkLE9lLmEoZnVuY3Rpb24oYSl7cmV0dXJuIHNjLmEoUy5jKGIsRyhhKSxPZiksTGMoYSkpfSxhKSk6bnVsbDpudWxsKX1cbmZ1bmN0aW9uIFFmKGEsYil7dmFyIGM9YS5lO2lmKGIgaW5zdGFuY2VvZiBVKWE6e2Zvcih2YXIgZD1jLmxlbmd0aCxlPWIucGEsZj0wOzspe2lmKGQ8PWYpe2M9LTE7YnJlYWsgYX12YXIgZz1jW2ZdO2lmKGcgaW5zdGFuY2VvZiBVJiZlPT09Zy5wYSl7Yz1mO2JyZWFrIGF9Zis9Mn1jPXZvaWQgMH1lbHNlIGlmKGQ9XCJzdHJpbmdcIj09dHlwZW9mIGIsdCh0KGQpP2Q6XCJudW1iZXJcIj09PXR5cGVvZiBiKSlhOntkPWMubGVuZ3RoO2ZvcihlPTA7Oyl7aWYoZDw9ZSl7Yz0tMTticmVhayBhfWlmKGI9PT1jW2VdKXtjPWU7YnJlYWsgYX1lKz0yfWM9dm9pZCAwfWVsc2UgaWYoYiBpbnN0YW5jZW9mIHFjKWE6e2Q9Yy5sZW5ndGg7ZT1iLnRhO2ZvcihmPTA7Oyl7aWYoZDw9Zil7Yz0tMTticmVhayBhfWc9Y1tmXTtpZihnIGluc3RhbmNlb2YgcWMmJmU9PT1nLnRhKXtjPWY7YnJlYWsgYX1mKz0yfWM9dm9pZCAwfWVsc2UgaWYobnVsbD09YilhOntkPWMubGVuZ3RoO2ZvcihlPTA7Oyl7aWYoZDw9XG5lKXtjPS0xO2JyZWFrIGF9aWYobnVsbD09Y1tlXSl7Yz1lO2JyZWFrIGF9ZSs9Mn1jPXZvaWQgMH1lbHNlIGE6e2Q9Yy5sZW5ndGg7Zm9yKGU9MDs7KXtpZihkPD1lKXtjPS0xO2JyZWFrIGF9aWYoc2MuYShiLGNbZV0pKXtjPWU7YnJlYWsgYX1lKz0yfWM9dm9pZCAwfXJldHVybiBjfWZ1bmN0aW9uIFJmKGEsYixjKXt0aGlzLmU9YTt0aGlzLm09Yjt0aGlzLlo9Yzt0aGlzLnE9MDt0aGlzLmo9MzIzNzQ5OTB9az1SZi5wcm90b3R5cGU7ay50b1N0cmluZz1mdW5jdGlvbigpe3JldHVybiBlYyh0aGlzKX07ay5IPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuWn07ay5UPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMubTx0aGlzLmUubGVuZ3RoLTI/bmV3IFJmKHRoaXMuZSx0aGlzLm0rMix0aGlzLlopOm51bGx9O2suTD1mdW5jdGlvbigpe3JldHVybih0aGlzLmUubGVuZ3RoLXRoaXMubSkvMn07ay5CPWZ1bmN0aW9uKCl7cmV0dXJuIHdjKHRoaXMpfTtcbmsuQT1mdW5jdGlvbihhLGIpe3JldHVybiBJYyh0aGlzLGIpfTtrLko9ZnVuY3Rpb24oKXtyZXR1cm4gTyhKLHRoaXMuWil9O2suUj1mdW5jdGlvbihhLGIpe3JldHVybiBQLmEoYix0aGlzKX07ay5PPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gUC5jKGIsYyx0aGlzKX07ay5OPWZ1bmN0aW9uKCl7cmV0dXJuIG5ldyBXKG51bGwsMiw1LHVmLFt0aGlzLmVbdGhpcy5tXSx0aGlzLmVbdGhpcy5tKzFdXSxudWxsKX07ay5TPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMubTx0aGlzLmUubGVuZ3RoLTI/bmV3IFJmKHRoaXMuZSx0aGlzLm0rMix0aGlzLlopOkp9O2suRD1mdW5jdGlvbigpe3JldHVybiB0aGlzfTtrLkY9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IFJmKHRoaXMuZSx0aGlzLm0sYil9O2suRz1mdW5jdGlvbihhLGIpe3JldHVybiBNKGIsdGhpcyl9O1JmLnByb3RvdHlwZVtFYV09ZnVuY3Rpb24oKXtyZXR1cm4gdWModGhpcyl9O1xuZnVuY3Rpb24gU2YoYSxiLGMpe3RoaXMuZT1hO3RoaXMubT1iO3RoaXMuZz1jfVNmLnByb3RvdHlwZS5nYT1mdW5jdGlvbigpe3JldHVybiB0aGlzLm08dGhpcy5nfTtTZi5wcm90b3R5cGUubmV4dD1mdW5jdGlvbigpe3ZhciBhPW5ldyBXKG51bGwsMiw1LHVmLFt0aGlzLmVbdGhpcy5tXSx0aGlzLmVbdGhpcy5tKzFdXSxudWxsKTt0aGlzLm0rPTI7cmV0dXJuIGF9O2Z1bmN0aW9uIHBhKGEsYixjLGQpe3RoaXMuaz1hO3RoaXMuZz1iO3RoaXMuZT1jO3RoaXMucD1kO3RoaXMuaj0xNjY0Nzk1MTt0aGlzLnE9ODE5Nn1rPXBhLnByb3RvdHlwZTtrLnRvU3RyaW5nPWZ1bmN0aW9uKCl7cmV0dXJuIGVjKHRoaXMpfTtrLnQ9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gJGEuYyh0aGlzLGIsbnVsbCl9O2sucz1mdW5jdGlvbihhLGIsYyl7YT1RZih0aGlzLGIpO3JldHVybi0xPT09YT9jOnRoaXMuZVthKzFdfTtcbmsuZ2I9ZnVuY3Rpb24oYSxiLGMpe2E9dGhpcy5lLmxlbmd0aDtmb3IodmFyIGQ9MDs7KWlmKGQ8YSl7dmFyIGU9dGhpcy5lW2RdLGY9dGhpcy5lW2QrMV07Yz1iLmM/Yi5jKGMsZSxmKTpiLmNhbGwobnVsbCxjLGUsZik7aWYoQWMoYykpcmV0dXJuIGI9YyxMLmI/TC5iKGIpOkwuY2FsbChudWxsLGIpO2QrPTJ9ZWxzZSByZXR1cm4gY307ay52Yj0hMDtrLmZiPWZ1bmN0aW9uKCl7cmV0dXJuIG5ldyBTZih0aGlzLmUsMCwyKnRoaXMuZyl9O2suSD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmt9O2suTD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmd9O2suQj1mdW5jdGlvbigpe3ZhciBhPXRoaXMucDtyZXR1cm4gbnVsbCE9YT9hOnRoaXMucD1hPXhjKHRoaXMpfTtcbmsuQT1mdW5jdGlvbihhLGIpe2lmKGImJihiLmomMTAyNHx8Yi5pYykpe3ZhciBjPXRoaXMuZS5sZW5ndGg7aWYodGhpcy5nPT09Yi5MKG51bGwpKWZvcih2YXIgZD0wOzspaWYoZDxjKXt2YXIgZT1iLnMobnVsbCx0aGlzLmVbZF0samQpO2lmKGUhPT1qZClpZihzYy5hKHRoaXMuZVtkKzFdLGUpKWQrPTI7ZWxzZSByZXR1cm4hMTtlbHNlIHJldHVybiExfWVsc2UgcmV0dXJuITA7ZWxzZSByZXR1cm4hMX1lbHNlIHJldHVybiBQZih0aGlzLGIpfTtrLiRhPWZ1bmN0aW9uKCl7cmV0dXJuIG5ldyBUZih7fSx0aGlzLmUubGVuZ3RoLEZhKHRoaXMuZSkpfTtrLko9ZnVuY3Rpb24oKXtyZXR1cm4gdWIoVWYsdGhpcy5rKX07ay5SPWZ1bmN0aW9uKGEsYil7cmV0dXJuIFAuYShiLHRoaXMpfTtrLk89ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBQLmMoYixjLHRoaXMpfTtcbmsud2I9ZnVuY3Rpb24oYSxiKXtpZigwPD1RZih0aGlzLGIpKXt2YXIgYz10aGlzLmUubGVuZ3RoLGQ9Yy0yO2lmKDA9PT1kKXJldHVybiBOYSh0aGlzKTtmb3IodmFyIGQ9QXJyYXkoZCksZT0wLGY9MDs7KXtpZihlPj1jKXJldHVybiBuZXcgcGEodGhpcy5rLHRoaXMuZy0xLGQsbnVsbCk7c2MuYShiLHRoaXMuZVtlXSl8fChkW2ZdPXRoaXMuZVtlXSxkW2YrMV09dGhpcy5lW2UrMV0sZis9Mik7ZSs9Mn19ZWxzZSByZXR1cm4gdGhpc307XG5rLkthPWZ1bmN0aW9uKGEsYixjKXthPVFmKHRoaXMsYik7aWYoLTE9PT1hKXtpZih0aGlzLmc8VmYpe2E9dGhpcy5lO2Zvcih2YXIgZD1hLmxlbmd0aCxlPUFycmF5KGQrMiksZj0wOzspaWYoZjxkKWVbZl09YVtmXSxmKz0xO2Vsc2UgYnJlYWs7ZVtkXT1iO2VbZCsxXT1jO3JldHVybiBuZXcgcGEodGhpcy5rLHRoaXMuZysxLGUsbnVsbCl9cmV0dXJuIHViKGNiKGFmLmEoUWMsdGhpcyksYixjKSx0aGlzLmspfWlmKGM9PT10aGlzLmVbYSsxXSlyZXR1cm4gdGhpcztiPUZhKHRoaXMuZSk7YlthKzFdPWM7cmV0dXJuIG5ldyBwYSh0aGlzLmssdGhpcy5nLGIsbnVsbCl9O2sucmI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4tMSE9PVFmKHRoaXMsYil9O2suRD1mdW5jdGlvbigpe3ZhciBhPXRoaXMuZTtyZXR1cm4gMDw9YS5sZW5ndGgtMj9uZXcgUmYoYSwwLG51bGwpOm51bGx9O2suRj1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgcGEoYix0aGlzLmcsdGhpcy5lLHRoaXMucCl9O1xuay5HPWZ1bmN0aW9uKGEsYil7aWYoZWQoYikpcmV0dXJuIGNiKHRoaXMsQy5hKGIsMCksQy5hKGIsMSkpO2Zvcih2YXIgYz10aGlzLGQ9RChiKTs7KXtpZihudWxsPT1kKXJldHVybiBjO3ZhciBlPUcoZCk7aWYoZWQoZSkpYz1jYihjLEMuYShlLDApLEMuYShlLDEpKSxkPUsoZCk7ZWxzZSB0aHJvdyBFcnJvcihcImNvbmogb24gYSBtYXAgdGFrZXMgbWFwIGVudHJpZXMgb3Igc2VxYWJsZXMgb2YgbWFwIGVudHJpZXNcIik7fX07XG5rLmNhbGw9ZnVuY3Rpb24oKXt2YXIgYT1udWxsLGE9ZnVuY3Rpb24oYSxjLGQpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIHRoaXMudChudWxsLGMpO2Nhc2UgMzpyZXR1cm4gdGhpcy5zKG51bGwsYyxkKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307YS5hPWZ1bmN0aW9uKGEsYyl7cmV0dXJuIHRoaXMudChudWxsLGMpfTthLmM9ZnVuY3Rpb24oYSxjLGQpe3JldHVybiB0aGlzLnMobnVsbCxjLGQpfTtyZXR1cm4gYX0oKTtrLmFwcGx5PWZ1bmN0aW9uKGEsYil7cmV0dXJuIHRoaXMuY2FsbC5hcHBseSh0aGlzLFt0aGlzXS5jb25jYXQoRmEoYikpKX07ay5iPWZ1bmN0aW9uKGEpe3JldHVybiB0aGlzLnQobnVsbCxhKX07ay5hPWZ1bmN0aW9uKGEsYil7cmV0dXJuIHRoaXMucyhudWxsLGEsYil9O3ZhciBVZj1uZXcgcGEobnVsbCwwLFtdLG51bGwpLFZmPTg7cGEucHJvdG90eXBlW0VhXT1mdW5jdGlvbigpe3JldHVybiB1Yyh0aGlzKX07XG5mdW5jdGlvbiBUZihhLGIsYyl7dGhpcy5WYT1hO3RoaXMucWE9Yjt0aGlzLmU9Yzt0aGlzLnE9NTY7dGhpcy5qPTI1OH1rPVRmLnByb3RvdHlwZTtrLkpiPWZ1bmN0aW9uKGEsYil7aWYodCh0aGlzLlZhKSl7dmFyIGM9UWYodGhpcyxiKTswPD1jJiYodGhpcy5lW2NdPXRoaXMuZVt0aGlzLnFhLTJdLHRoaXMuZVtjKzFdPXRoaXMuZVt0aGlzLnFhLTFdLGM9dGhpcy5lLGMucG9wKCksYy5wb3AoKSx0aGlzLnFhLT0yKTtyZXR1cm4gdGhpc310aHJvdyBFcnJvcihcImRpc3NvYyEgYWZ0ZXIgcGVyc2lzdGVudCFcIik7fTtcbmsua2I9ZnVuY3Rpb24oYSxiLGMpe3ZhciBkPXRoaXM7aWYodChkLlZhKSl7YT1RZih0aGlzLGIpO2lmKC0xPT09YSlyZXR1cm4gZC5xYSsyPD0yKlZmPyhkLnFhKz0yLGQuZS5wdXNoKGIpLGQuZS5wdXNoKGMpLHRoaXMpOmVlLmMoZnVuY3Rpb24oKXt2YXIgYT1kLnFhLGI9ZC5lO3JldHVybiBYZi5hP1hmLmEoYSxiKTpYZi5jYWxsKG51bGwsYSxiKX0oKSxiLGMpO2MhPT1kLmVbYSsxXSYmKGQuZVthKzFdPWMpO3JldHVybiB0aGlzfXRocm93IEVycm9yKFwiYXNzb2MhIGFmdGVyIHBlcnNpc3RlbnQhXCIpO307XG5rLlNhPWZ1bmN0aW9uKGEsYil7aWYodCh0aGlzLlZhKSl7aWYoYj9iLmomMjA0OHx8Yi5qY3x8KGIuaj8wOncoZmIsYikpOncoZmIsYikpcmV0dXJuIFJiKHRoaXMsWWYuYj9ZZi5iKGIpOllmLmNhbGwobnVsbCxiKSxaZi5iP1pmLmIoYik6WmYuY2FsbChudWxsLGIpKTtmb3IodmFyIGM9RChiKSxkPXRoaXM7Oyl7dmFyIGU9RyhjKTtpZih0KGUpKXZhciBmPWUsYz1LKGMpLGQ9UmIoZCxmdW5jdGlvbigpe3ZhciBhPWY7cmV0dXJuIFlmLmI/WWYuYihhKTpZZi5jYWxsKG51bGwsYSl9KCksZnVuY3Rpb24oKXt2YXIgYT1mO3JldHVybiBaZi5iP1pmLmIoYSk6WmYuY2FsbChudWxsLGEpfSgpKTtlbHNlIHJldHVybiBkfX1lbHNlIHRocm93IEVycm9yKFwiY29uaiEgYWZ0ZXIgcGVyc2lzdGVudCFcIik7fTtcbmsuVGE9ZnVuY3Rpb24oKXtpZih0KHRoaXMuVmEpKXJldHVybiB0aGlzLlZhPSExLG5ldyBwYShudWxsLENkKHRoaXMucWEsMiksdGhpcy5lLG51bGwpO3Rocm93IEVycm9yKFwicGVyc2lzdGVudCEgY2FsbGVkIHR3aWNlXCIpO307ay50PWZ1bmN0aW9uKGEsYil7cmV0dXJuICRhLmModGhpcyxiLG51bGwpfTtrLnM9ZnVuY3Rpb24oYSxiLGMpe2lmKHQodGhpcy5WYSkpcmV0dXJuIGE9UWYodGhpcyxiKSwtMT09PWE/Yzp0aGlzLmVbYSsxXTt0aHJvdyBFcnJvcihcImxvb2t1cCBhZnRlciBwZXJzaXN0ZW50IVwiKTt9O2suTD1mdW5jdGlvbigpe2lmKHQodGhpcy5WYSkpcmV0dXJuIENkKHRoaXMucWEsMik7dGhyb3cgRXJyb3IoXCJjb3VudCBhZnRlciBwZXJzaXN0ZW50IVwiKTt9O2Z1bmN0aW9uIFhmKGEsYil7Zm9yKHZhciBjPU9iKFFjKSxkPTA7OylpZihkPGEpYz1lZS5jKGMsYltkXSxiW2QrMV0pLGQrPTI7ZWxzZSByZXR1cm4gY31mdW5jdGlvbiAkZigpe3RoaXMubz0hMX1cbmZ1bmN0aW9uIGFnKGEsYil7cmV0dXJuIGE9PT1iPyEwOk5kKGEsYik/ITA6c2MuYShhLGIpfXZhciBiZz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMsZyxoKXthPUZhKGEpO2FbYl09YzthW2ddPWg7cmV0dXJuIGF9ZnVuY3Rpb24gYihhLGIsYyl7YT1GYShhKTthW2JdPWM7cmV0dXJuIGF9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSxmLGcsaCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMzpyZXR1cm4gYi5jYWxsKHRoaXMsYyxlLGYpO2Nhc2UgNTpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlLGYsZyxoKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5jPWI7Yy5yPWE7cmV0dXJuIGN9KCk7ZnVuY3Rpb24gY2coYSxiKXt2YXIgYz1BcnJheShhLmxlbmd0aC0yKTtoZChhLDAsYywwLDIqYik7aGQoYSwyKihiKzEpLGMsMipiLGMubGVuZ3RoLTIqYik7cmV0dXJuIGN9XG52YXIgZGc9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjLGcsaCxsKXthPWEuTmEoYik7YS5lW2NdPWc7YS5lW2hdPWw7cmV0dXJuIGF9ZnVuY3Rpb24gYihhLGIsYyxnKXthPWEuTmEoYik7YS5lW2NdPWc7cmV0dXJuIGF9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSxmLGcsaCxsKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSA0OnJldHVybiBiLmNhbGwodGhpcyxjLGUsZixnKTtjYXNlIDY6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSxmLGcsaCxsKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5uPWI7Yy5QPWE7cmV0dXJuIGN9KCk7XG5mdW5jdGlvbiBlZyhhLGIsYyl7Zm9yKHZhciBkPWEubGVuZ3RoLGU9MCxmPWM7OylpZihlPGQpe2M9YVtlXTtpZihudWxsIT1jKXt2YXIgZz1hW2UrMV07Yz1iLmM/Yi5jKGYsYyxnKTpiLmNhbGwobnVsbCxmLGMsZyl9ZWxzZSBjPWFbZSsxXSxjPW51bGwhPWM/Yy5YYShiLGYpOmY7aWYoQWMoYykpcmV0dXJuIGE9YyxMLmI/TC5iKGEpOkwuY2FsbChudWxsLGEpO2UrPTI7Zj1jfWVsc2UgcmV0dXJuIGZ9ZnVuY3Rpb24gZmcoYSxiLGMpe3RoaXMudT1hO3RoaXMudz1iO3RoaXMuZT1jfWs9ZmcucHJvdG90eXBlO2suTmE9ZnVuY3Rpb24oYSl7aWYoYT09PXRoaXMudSlyZXR1cm4gdGhpczt2YXIgYj1EZCh0aGlzLncpLGM9QXJyYXkoMD5iPzQ6MiooYisxKSk7aGQodGhpcy5lLDAsYywwLDIqYik7cmV0dXJuIG5ldyBmZyhhLHRoaXMudyxjKX07XG5rLm5iPWZ1bmN0aW9uKGEsYixjLGQsZSl7dmFyIGY9MTw8KGM+Pj5iJjMxKTtpZigwPT09KHRoaXMudyZmKSlyZXR1cm4gdGhpczt2YXIgZz1EZCh0aGlzLncmZi0xKSxoPXRoaXMuZVsyKmddLGw9dGhpcy5lWzIqZysxXTtyZXR1cm4gbnVsbD09aD8oYj1sLm5iKGEsYis1LGMsZCxlKSxiPT09bD90aGlzOm51bGwhPWI/ZGcubih0aGlzLGEsMipnKzEsYik6dGhpcy53PT09Zj9udWxsOmdnKHRoaXMsYSxmLGcpKTphZyhkLGgpPyhlWzBdPSEwLGdnKHRoaXMsYSxmLGcpKTp0aGlzfTtmdW5jdGlvbiBnZyhhLGIsYyxkKXtpZihhLnc9PT1jKXJldHVybiBudWxsO2E9YS5OYShiKTtiPWEuZTt2YXIgZT1iLmxlbmd0aDthLndePWM7aGQoYiwyKihkKzEpLGIsMipkLGUtMiooZCsxKSk7YltlLTJdPW51bGw7YltlLTFdPW51bGw7cmV0dXJuIGF9ay5sYj1mdW5jdGlvbigpe3ZhciBhPXRoaXMuZTtyZXR1cm4gaGcuYj9oZy5iKGEpOmhnLmNhbGwobnVsbCxhKX07XG5rLlhhPWZ1bmN0aW9uKGEsYil7cmV0dXJuIGVnKHRoaXMuZSxhLGIpfTtrLk9hPWZ1bmN0aW9uKGEsYixjLGQpe3ZhciBlPTE8PChiPj4+YSYzMSk7aWYoMD09PSh0aGlzLncmZSkpcmV0dXJuIGQ7dmFyIGY9RGQodGhpcy53JmUtMSksZT10aGlzLmVbMipmXSxmPXRoaXMuZVsyKmYrMV07cmV0dXJuIG51bGw9PWU/Zi5PYShhKzUsYixjLGQpOmFnKGMsZSk/ZjpkfTtcbmsubGE9ZnVuY3Rpb24oYSxiLGMsZCxlLGYpe3ZhciBnPTE8PChjPj4+YiYzMSksaD1EZCh0aGlzLncmZy0xKTtpZigwPT09KHRoaXMudyZnKSl7dmFyIGw9RGQodGhpcy53KTtpZigyKmw8dGhpcy5lLmxlbmd0aCl7dmFyIG09dGhpcy5OYShhKSxwPW0uZTtmLm89ITA7aWQocCwyKmgscCwyKihoKzEpLDIqKGwtaCkpO3BbMipoXT1kO3BbMipoKzFdPWU7bS53fD1nO3JldHVybiBtfWlmKDE2PD1sKXtnPVtudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGxdO2dbYz4+PmImMzFdPWlnLmxhKGEsYis1LGMsZCxlLGYpO2ZvcihtPWg9MDs7KWlmKDMyPmgpMCE9PSh0aGlzLnc+Pj5oJjEpJiYoZ1toXT1udWxsIT10aGlzLmVbbV0/aWcubGEoYSxiKzUsbmModGhpcy5lW21dKSxcbnRoaXMuZVttXSx0aGlzLmVbbSsxXSxmKTp0aGlzLmVbbSsxXSxtKz0yKSxoKz0xO2Vsc2UgYnJlYWs7cmV0dXJuIG5ldyBqZyhhLGwrMSxnKX1wPUFycmF5KDIqKGwrNCkpO2hkKHRoaXMuZSwwLHAsMCwyKmgpO3BbMipoXT1kO3BbMipoKzFdPWU7aGQodGhpcy5lLDIqaCxwLDIqKGgrMSksMioobC1oKSk7Zi5vPSEwO209dGhpcy5OYShhKTttLmU9cDttLnd8PWc7cmV0dXJuIG19dmFyIHE9dGhpcy5lWzIqaF0scz10aGlzLmVbMipoKzFdO2lmKG51bGw9PXEpcmV0dXJuIGw9cy5sYShhLGIrNSxjLGQsZSxmKSxsPT09cz90aGlzOmRnLm4odGhpcyxhLDIqaCsxLGwpO2lmKGFnKGQscSkpcmV0dXJuIGU9PT1zP3RoaXM6ZGcubih0aGlzLGEsMipoKzEsZSk7Zi5vPSEwO3JldHVybiBkZy5QKHRoaXMsYSwyKmgsbnVsbCwyKmgrMSxmdW5jdGlvbigpe3ZhciBmPWIrNTtyZXR1cm4ga2cuaWE/a2cuaWEoYSxmLHEscyxjLGQsZSk6a2cuY2FsbChudWxsLGEsZixxLHMsYyxkLGUpfSgpKX07XG5rLmthPWZ1bmN0aW9uKGEsYixjLGQsZSl7dmFyIGY9MTw8KGI+Pj5hJjMxKSxnPURkKHRoaXMudyZmLTEpO2lmKDA9PT0odGhpcy53JmYpKXt2YXIgaD1EZCh0aGlzLncpO2lmKDE2PD1oKXtmPVtudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGxdO2ZbYj4+PmEmMzFdPWlnLmthKGErNSxiLGMsZCxlKTtmb3IodmFyIGw9Zz0wOzspaWYoMzI+ZykwIT09KHRoaXMudz4+PmcmMSkmJihmW2ddPW51bGwhPXRoaXMuZVtsXT9pZy5rYShhKzUsbmModGhpcy5lW2xdKSx0aGlzLmVbbF0sdGhpcy5lW2wrMV0sZSk6dGhpcy5lW2wrMV0sbCs9MiksZys9MTtlbHNlIGJyZWFrO3JldHVybiBuZXcgamcobnVsbCxoKzEsZil9bD1BcnJheSgyKihoKzEpKTtoZCh0aGlzLmUsXG4wLGwsMCwyKmcpO2xbMipnXT1jO2xbMipnKzFdPWQ7aGQodGhpcy5lLDIqZyxsLDIqKGcrMSksMiooaC1nKSk7ZS5vPSEwO3JldHVybiBuZXcgZmcobnVsbCx0aGlzLnd8ZixsKX12YXIgbT10aGlzLmVbMipnXSxwPXRoaXMuZVsyKmcrMV07aWYobnVsbD09bSlyZXR1cm4gaD1wLmthKGErNSxiLGMsZCxlKSxoPT09cD90aGlzOm5ldyBmZyhudWxsLHRoaXMudyxiZy5jKHRoaXMuZSwyKmcrMSxoKSk7aWYoYWcoYyxtKSlyZXR1cm4gZD09PXA/dGhpczpuZXcgZmcobnVsbCx0aGlzLncsYmcuYyh0aGlzLmUsMipnKzEsZCkpO2Uubz0hMDtyZXR1cm4gbmV3IGZnKG51bGwsdGhpcy53LGJnLnIodGhpcy5lLDIqZyxudWxsLDIqZysxLGZ1bmN0aW9uKCl7dmFyIGU9YSs1O3JldHVybiBrZy5QP2tnLlAoZSxtLHAsYixjLGQpOmtnLmNhbGwobnVsbCxlLG0scCxiLGMsZCl9KCkpKX07XG5rLm1iPWZ1bmN0aW9uKGEsYixjKXt2YXIgZD0xPDwoYj4+PmEmMzEpO2lmKDA9PT0odGhpcy53JmQpKXJldHVybiB0aGlzO3ZhciBlPURkKHRoaXMudyZkLTEpLGY9dGhpcy5lWzIqZV0sZz10aGlzLmVbMiplKzFdO3JldHVybiBudWxsPT1mPyhhPWcubWIoYSs1LGIsYyksYT09PWc/dGhpczpudWxsIT1hP25ldyBmZyhudWxsLHRoaXMudyxiZy5jKHRoaXMuZSwyKmUrMSxhKSk6dGhpcy53PT09ZD9udWxsOm5ldyBmZyhudWxsLHRoaXMud15kLGNnKHRoaXMuZSxlKSkpOmFnKGMsZik/bmV3IGZnKG51bGwsdGhpcy53XmQsY2codGhpcy5lLGUpKTp0aGlzfTt2YXIgaWc9bmV3IGZnKG51bGwsMCxbXSk7XG5mdW5jdGlvbiBsZyhhLGIsYyl7dmFyIGQ9YS5lLGU9ZC5sZW5ndGg7YT1BcnJheSgyKihhLmctMSkpO2Zvcih2YXIgZj0wLGc9MSxoPTA7OylpZihmPGUpZiE9PWMmJm51bGwhPWRbZl0mJihhW2ddPWRbZl0sZys9MixofD0xPDxmKSxmKz0xO2Vsc2UgcmV0dXJuIG5ldyBmZyhiLGgsYSl9ZnVuY3Rpb24gamcoYSxiLGMpe3RoaXMudT1hO3RoaXMuZz1iO3RoaXMuZT1jfWs9amcucHJvdG90eXBlO2suTmE9ZnVuY3Rpb24oYSl7cmV0dXJuIGE9PT10aGlzLnU/dGhpczpuZXcgamcoYSx0aGlzLmcsRmEodGhpcy5lKSl9O1xuay5uYj1mdW5jdGlvbihhLGIsYyxkLGUpe3ZhciBmPWM+Pj5iJjMxLGc9dGhpcy5lW2ZdO2lmKG51bGw9PWcpcmV0dXJuIHRoaXM7Yj1nLm5iKGEsYis1LGMsZCxlKTtpZihiPT09ZylyZXR1cm4gdGhpcztpZihudWxsPT1iKXtpZig4Pj10aGlzLmcpcmV0dXJuIGxnKHRoaXMsYSxmKTthPWRnLm4odGhpcyxhLGYsYik7YS5nLT0xO3JldHVybiBhfXJldHVybiBkZy5uKHRoaXMsYSxmLGIpfTtrLmxiPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5lO3JldHVybiBtZy5iP21nLmIoYSk6bWcuY2FsbChudWxsLGEpfTtrLlhhPWZ1bmN0aW9uKGEsYil7Zm9yKHZhciBjPXRoaXMuZS5sZW5ndGgsZD0wLGU9Yjs7KWlmKGQ8Yyl7dmFyIGY9dGhpcy5lW2RdO2lmKG51bGwhPWYmJihlPWYuWGEoYSxlKSxBYyhlKSkpcmV0dXJuIGM9ZSxMLmI/TC5iKGMpOkwuY2FsbChudWxsLGMpO2QrPTF9ZWxzZSByZXR1cm4gZX07XG5rLk9hPWZ1bmN0aW9uKGEsYixjLGQpe3ZhciBlPXRoaXMuZVtiPj4+YSYzMV07cmV0dXJuIG51bGwhPWU/ZS5PYShhKzUsYixjLGQpOmR9O2subGE9ZnVuY3Rpb24oYSxiLGMsZCxlLGYpe3ZhciBnPWM+Pj5iJjMxLGg9dGhpcy5lW2ddO2lmKG51bGw9PWgpcmV0dXJuIGE9ZGcubih0aGlzLGEsZyxpZy5sYShhLGIrNSxjLGQsZSxmKSksYS5nKz0xLGE7Yj1oLmxhKGEsYis1LGMsZCxlLGYpO3JldHVybiBiPT09aD90aGlzOmRnLm4odGhpcyxhLGcsYil9O2sua2E9ZnVuY3Rpb24oYSxiLGMsZCxlKXt2YXIgZj1iPj4+YSYzMSxnPXRoaXMuZVtmXTtpZihudWxsPT1nKXJldHVybiBuZXcgamcobnVsbCx0aGlzLmcrMSxiZy5jKHRoaXMuZSxmLGlnLmthKGErNSxiLGMsZCxlKSkpO2E9Zy5rYShhKzUsYixjLGQsZSk7cmV0dXJuIGE9PT1nP3RoaXM6bmV3IGpnKG51bGwsdGhpcy5nLGJnLmModGhpcy5lLGYsYSkpfTtcbmsubWI9ZnVuY3Rpb24oYSxiLGMpe3ZhciBkPWI+Pj5hJjMxLGU9dGhpcy5lW2RdO3JldHVybiBudWxsIT1lPyhhPWUubWIoYSs1LGIsYyksYT09PWU/dGhpczpudWxsPT1hPzg+PXRoaXMuZz9sZyh0aGlzLG51bGwsZCk6bmV3IGpnKG51bGwsdGhpcy5nLTEsYmcuYyh0aGlzLmUsZCxhKSk6bmV3IGpnKG51bGwsdGhpcy5nLGJnLmModGhpcy5lLGQsYSkpKTp0aGlzfTtmdW5jdGlvbiBuZyhhLGIsYyl7Yio9Mjtmb3IodmFyIGQ9MDs7KWlmKGQ8Yil7aWYoYWcoYyxhW2RdKSlyZXR1cm4gZDtkKz0yfWVsc2UgcmV0dXJuLTF9ZnVuY3Rpb24gb2coYSxiLGMsZCl7dGhpcy51PWE7dGhpcy5JYT1iO3RoaXMuZz1jO3RoaXMuZT1kfWs9b2cucHJvdG90eXBlO2suTmE9ZnVuY3Rpb24oYSl7aWYoYT09PXRoaXMudSlyZXR1cm4gdGhpczt2YXIgYj1BcnJheSgyKih0aGlzLmcrMSkpO2hkKHRoaXMuZSwwLGIsMCwyKnRoaXMuZyk7cmV0dXJuIG5ldyBvZyhhLHRoaXMuSWEsdGhpcy5nLGIpfTtcbmsubmI9ZnVuY3Rpb24oYSxiLGMsZCxlKXtiPW5nKHRoaXMuZSx0aGlzLmcsZCk7aWYoLTE9PT1iKXJldHVybiB0aGlzO2VbMF09ITA7aWYoMT09PXRoaXMuZylyZXR1cm4gbnVsbDthPXRoaXMuTmEoYSk7ZT1hLmU7ZVtiXT1lWzIqdGhpcy5nLTJdO2VbYisxXT1lWzIqdGhpcy5nLTFdO2VbMip0aGlzLmctMV09bnVsbDtlWzIqdGhpcy5nLTJdPW51bGw7YS5nLT0xO3JldHVybiBhfTtrLmxiPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5lO3JldHVybiBoZy5iP2hnLmIoYSk6aGcuY2FsbChudWxsLGEpfTtrLlhhPWZ1bmN0aW9uKGEsYil7cmV0dXJuIGVnKHRoaXMuZSxhLGIpfTtrLk9hPWZ1bmN0aW9uKGEsYixjLGQpe2E9bmcodGhpcy5lLHRoaXMuZyxjKTtyZXR1cm4gMD5hP2Q6YWcoYyx0aGlzLmVbYV0pP3RoaXMuZVthKzFdOmR9O1xuay5sYT1mdW5jdGlvbihhLGIsYyxkLGUsZil7aWYoYz09PXRoaXMuSWEpe2I9bmcodGhpcy5lLHRoaXMuZyxkKTtpZigtMT09PWIpe2lmKHRoaXMuZS5sZW5ndGg+Mip0aGlzLmcpcmV0dXJuIGE9ZGcuUCh0aGlzLGEsMip0aGlzLmcsZCwyKnRoaXMuZysxLGUpLGYubz0hMCxhLmcrPTEsYTtjPXRoaXMuZS5sZW5ndGg7Yj1BcnJheShjKzIpO2hkKHRoaXMuZSwwLGIsMCxjKTtiW2NdPWQ7YltjKzFdPWU7Zi5vPSEwO2Y9dGhpcy5nKzE7YT09PXRoaXMudT8odGhpcy5lPWIsdGhpcy5nPWYsYT10aGlzKTphPW5ldyBvZyh0aGlzLnUsdGhpcy5JYSxmLGIpO3JldHVybiBhfXJldHVybiB0aGlzLmVbYisxXT09PWU/dGhpczpkZy5uKHRoaXMsYSxiKzEsZSl9cmV0dXJuKG5ldyBmZyhhLDE8PCh0aGlzLklhPj4+YiYzMSksW251bGwsdGhpcyxudWxsLG51bGxdKSkubGEoYSxiLGMsZCxlLGYpfTtcbmsua2E9ZnVuY3Rpb24oYSxiLGMsZCxlKXtyZXR1cm4gYj09PXRoaXMuSWE/KGE9bmcodGhpcy5lLHRoaXMuZyxjKSwtMT09PWE/KGE9Mip0aGlzLmcsYj1BcnJheShhKzIpLGhkKHRoaXMuZSwwLGIsMCxhKSxiW2FdPWMsYlthKzFdPWQsZS5vPSEwLG5ldyBvZyhudWxsLHRoaXMuSWEsdGhpcy5nKzEsYikpOnNjLmEodGhpcy5lW2FdLGQpP3RoaXM6bmV3IG9nKG51bGwsdGhpcy5JYSx0aGlzLmcsYmcuYyh0aGlzLmUsYSsxLGQpKSk6KG5ldyBmZyhudWxsLDE8PCh0aGlzLklhPj4+YSYzMSksW251bGwsdGhpc10pKS5rYShhLGIsYyxkLGUpfTtrLm1iPWZ1bmN0aW9uKGEsYixjKXthPW5nKHRoaXMuZSx0aGlzLmcsYyk7cmV0dXJuLTE9PT1hP3RoaXM6MT09PXRoaXMuZz9udWxsOm5ldyBvZyhudWxsLHRoaXMuSWEsdGhpcy5nLTEsY2codGhpcy5lLENkKGEsMikpKX07XG52YXIga2c9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjLGcsaCxsLG0pe3ZhciBwPW5jKGMpO2lmKHA9PT1oKXJldHVybiBuZXcgb2cobnVsbCxwLDIsW2MsZyxsLG1dKTt2YXIgcT1uZXcgJGY7cmV0dXJuIGlnLmxhKGEsYixwLGMsZyxxKS5sYShhLGIsaCxsLG0scSl9ZnVuY3Rpb24gYihhLGIsYyxnLGgsbCl7dmFyIG09bmMoYik7aWYobT09PWcpcmV0dXJuIG5ldyBvZyhudWxsLG0sMixbYixjLGgsbF0pO3ZhciBwPW5ldyAkZjtyZXR1cm4gaWcua2EoYSxtLGIsYyxwKS5rYShhLGcsaCxsLHApfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUsZixnLGgsbCxtKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSA2OnJldHVybiBiLmNhbGwodGhpcyxjLGUsZixnLGgsbCk7Y2FzZSA3OnJldHVybiBhLmNhbGwodGhpcyxjLGUsZixnLGgsbCxtKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5QPWI7Yy5pYT1hO3JldHVybiBjfSgpO1xuZnVuY3Rpb24gcGcoYSxiLGMsZCxlKXt0aGlzLms9YTt0aGlzLlBhPWI7dGhpcy5tPWM7dGhpcy5DPWQ7dGhpcy5wPWU7dGhpcy5xPTA7dGhpcy5qPTMyMzc0ODYwfWs9cGcucHJvdG90eXBlO2sudG9TdHJpbmc9ZnVuY3Rpb24oKXtyZXR1cm4gZWModGhpcyl9O2suSD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmt9O2suQj1mdW5jdGlvbigpe3ZhciBhPXRoaXMucDtyZXR1cm4gbnVsbCE9YT9hOnRoaXMucD1hPXdjKHRoaXMpfTtrLkE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gSWModGhpcyxiKX07ay5KPWZ1bmN0aW9uKCl7cmV0dXJuIE8oSix0aGlzLmspfTtrLlI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gUC5hKGIsdGhpcyl9O2suTz1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIFAuYyhiLGMsdGhpcyl9O2suTj1mdW5jdGlvbigpe3JldHVybiBudWxsPT10aGlzLkM/bmV3IFcobnVsbCwyLDUsdWYsW3RoaXMuUGFbdGhpcy5tXSx0aGlzLlBhW3RoaXMubSsxXV0sbnVsbCk6Ryh0aGlzLkMpfTtcbmsuUz1mdW5jdGlvbigpe2lmKG51bGw9PXRoaXMuQyl7dmFyIGE9dGhpcy5QYSxiPXRoaXMubSsyO3JldHVybiBoZy5jP2hnLmMoYSxiLG51bGwpOmhnLmNhbGwobnVsbCxhLGIsbnVsbCl9dmFyIGE9dGhpcy5QYSxiPXRoaXMubSxjPUsodGhpcy5DKTtyZXR1cm4gaGcuYz9oZy5jKGEsYixjKTpoZy5jYWxsKG51bGwsYSxiLGMpfTtrLkQ9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpc307ay5GPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyBwZyhiLHRoaXMuUGEsdGhpcy5tLHRoaXMuQyx0aGlzLnApfTtrLkc9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gTShiLHRoaXMpfTtwZy5wcm90b3R5cGVbRWFdPWZ1bmN0aW9uKCl7cmV0dXJuIHVjKHRoaXMpfTtcbnZhciBoZz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMpe2lmKG51bGw9PWMpZm9yKGM9YS5sZW5ndGg7OylpZihiPGMpe2lmKG51bGwhPWFbYl0pcmV0dXJuIG5ldyBwZyhudWxsLGEsYixudWxsLG51bGwpO3ZhciBnPWFbYisxXTtpZih0KGcpJiYoZz1nLmxiKCksdChnKSkpcmV0dXJuIG5ldyBwZyhudWxsLGEsYisyLGcsbnVsbCk7Yis9Mn1lbHNlIHJldHVybiBudWxsO2Vsc2UgcmV0dXJuIG5ldyBwZyhudWxsLGEsYixjLG51bGwpfWZ1bmN0aW9uIGIoYSl7cmV0dXJuIGMuYyhhLDAsbnVsbCl9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiLmNhbGwodGhpcyxjKTtjYXNlIDM6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSxmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5iPWI7Yy5jPWE7cmV0dXJuIGN9KCk7XG5mdW5jdGlvbiBxZyhhLGIsYyxkLGUpe3RoaXMuaz1hO3RoaXMuUGE9Yjt0aGlzLm09Yzt0aGlzLkM9ZDt0aGlzLnA9ZTt0aGlzLnE9MDt0aGlzLmo9MzIzNzQ4NjB9az1xZy5wcm90b3R5cGU7ay50b1N0cmluZz1mdW5jdGlvbigpe3JldHVybiBlYyh0aGlzKX07ay5IPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMua307ay5CPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5wO3JldHVybiBudWxsIT1hP2E6dGhpcy5wPWE9d2ModGhpcyl9O2suQT1mdW5jdGlvbihhLGIpe3JldHVybiBJYyh0aGlzLGIpfTtrLko9ZnVuY3Rpb24oKXtyZXR1cm4gTyhKLHRoaXMuayl9O2suUj1mdW5jdGlvbihhLGIpe3JldHVybiBQLmEoYix0aGlzKX07ay5PPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gUC5jKGIsYyx0aGlzKX07ay5OPWZ1bmN0aW9uKCl7cmV0dXJuIEcodGhpcy5DKX07XG5rLlM9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLlBhLGI9dGhpcy5tLGM9Syh0aGlzLkMpO3JldHVybiBtZy5uP21nLm4obnVsbCxhLGIsYyk6bWcuY2FsbChudWxsLG51bGwsYSxiLGMpfTtrLkQ9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpc307ay5GPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyBxZyhiLHRoaXMuUGEsdGhpcy5tLHRoaXMuQyx0aGlzLnApfTtrLkc9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gTShiLHRoaXMpfTtxZy5wcm90b3R5cGVbRWFdPWZ1bmN0aW9uKCl7cmV0dXJuIHVjKHRoaXMpfTtcbnZhciBtZz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMsZyl7aWYobnVsbD09Zylmb3IoZz1iLmxlbmd0aDs7KWlmKGM8Zyl7dmFyIGg9YltjXTtpZih0KGgpJiYoaD1oLmxiKCksdChoKSkpcmV0dXJuIG5ldyBxZyhhLGIsYysxLGgsbnVsbCk7Yys9MX1lbHNlIHJldHVybiBudWxsO2Vsc2UgcmV0dXJuIG5ldyBxZyhhLGIsYyxnLG51bGwpfWZ1bmN0aW9uIGIoYSl7cmV0dXJuIGMubihudWxsLGEsMCxudWxsKX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlLGYsZyl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYi5jYWxsKHRoaXMsYyk7Y2FzZSA0OnJldHVybiBhLmNhbGwodGhpcyxjLGUsZixnKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5iPWI7Yy5uPWE7cmV0dXJuIGN9KCk7XG5mdW5jdGlvbiByZyhhLGIsYyxkLGUsZil7dGhpcy5rPWE7dGhpcy5nPWI7dGhpcy5yb290PWM7dGhpcy5VPWQ7dGhpcy5kYT1lO3RoaXMucD1mO3RoaXMuaj0xNjEyMzY2Mzt0aGlzLnE9ODE5Nn1rPXJnLnByb3RvdHlwZTtrLnRvU3RyaW5nPWZ1bmN0aW9uKCl7cmV0dXJuIGVjKHRoaXMpfTtrLnQ9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gJGEuYyh0aGlzLGIsbnVsbCl9O2sucz1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIG51bGw9PWI/dGhpcy5VP3RoaXMuZGE6YzpudWxsPT10aGlzLnJvb3Q/Yzp0aGlzLnJvb3QuT2EoMCxuYyhiKSxiLGMpfTtrLmdiPWZ1bmN0aW9uKGEsYixjKXt0aGlzLlUmJihhPXRoaXMuZGEsYz1iLmM/Yi5jKGMsbnVsbCxhKTpiLmNhbGwobnVsbCxjLG51bGwsYSkpO3JldHVybiBBYyhjKT9MLmI/TC5iKGMpOkwuY2FsbChudWxsLGMpOm51bGwhPXRoaXMucm9vdD90aGlzLnJvb3QuWGEoYixjKTpjfTtrLkg9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5rfTtrLkw9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5nfTtcbmsuQj1mdW5jdGlvbigpe3ZhciBhPXRoaXMucDtyZXR1cm4gbnVsbCE9YT9hOnRoaXMucD1hPXhjKHRoaXMpfTtrLkE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gUGYodGhpcyxiKX07ay4kYT1mdW5jdGlvbigpe3JldHVybiBuZXcgc2coe30sdGhpcy5yb290LHRoaXMuZyx0aGlzLlUsdGhpcy5kYSl9O2suSj1mdW5jdGlvbigpe3JldHVybiB1YihRYyx0aGlzLmspfTtrLndiPWZ1bmN0aW9uKGEsYil7aWYobnVsbD09YilyZXR1cm4gdGhpcy5VP25ldyByZyh0aGlzLmssdGhpcy5nLTEsdGhpcy5yb290LCExLG51bGwsbnVsbCk6dGhpcztpZihudWxsPT10aGlzLnJvb3QpcmV0dXJuIHRoaXM7dmFyIGM9dGhpcy5yb290Lm1iKDAsbmMoYiksYik7cmV0dXJuIGM9PT10aGlzLnJvb3Q/dGhpczpuZXcgcmcodGhpcy5rLHRoaXMuZy0xLGMsdGhpcy5VLHRoaXMuZGEsbnVsbCl9O1xuay5LYT1mdW5jdGlvbihhLGIsYyl7aWYobnVsbD09YilyZXR1cm4gdGhpcy5VJiZjPT09dGhpcy5kYT90aGlzOm5ldyByZyh0aGlzLmssdGhpcy5VP3RoaXMuZzp0aGlzLmcrMSx0aGlzLnJvb3QsITAsYyxudWxsKTthPW5ldyAkZjtiPShudWxsPT10aGlzLnJvb3Q/aWc6dGhpcy5yb290KS5rYSgwLG5jKGIpLGIsYyxhKTtyZXR1cm4gYj09PXRoaXMucm9vdD90aGlzOm5ldyByZyh0aGlzLmssYS5vP3RoaXMuZysxOnRoaXMuZyxiLHRoaXMuVSx0aGlzLmRhLG51bGwpfTtrLnJiPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG51bGw9PWI/dGhpcy5VOm51bGw9PXRoaXMucm9vdD8hMTp0aGlzLnJvb3QuT2EoMCxuYyhiKSxiLGpkKSE9PWpkfTtrLkQ9ZnVuY3Rpb24oKXtpZigwPHRoaXMuZyl7dmFyIGE9bnVsbCE9dGhpcy5yb290P3RoaXMucm9vdC5sYigpOm51bGw7cmV0dXJuIHRoaXMuVT9NKG5ldyBXKG51bGwsMiw1LHVmLFtudWxsLHRoaXMuZGFdLG51bGwpLGEpOmF9cmV0dXJuIG51bGx9O1xuay5GPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyByZyhiLHRoaXMuZyx0aGlzLnJvb3QsdGhpcy5VLHRoaXMuZGEsdGhpcy5wKX07ay5HPWZ1bmN0aW9uKGEsYil7aWYoZWQoYikpcmV0dXJuIGNiKHRoaXMsQy5hKGIsMCksQy5hKGIsMSkpO2Zvcih2YXIgYz10aGlzLGQ9RChiKTs7KXtpZihudWxsPT1kKXJldHVybiBjO3ZhciBlPUcoZCk7aWYoZWQoZSkpYz1jYihjLEMuYShlLDApLEMuYShlLDEpKSxkPUsoZCk7ZWxzZSB0aHJvdyBFcnJvcihcImNvbmogb24gYSBtYXAgdGFrZXMgbWFwIGVudHJpZXMgb3Igc2VxYWJsZXMgb2YgbWFwIGVudHJpZXNcIik7fX07XG5rLmNhbGw9ZnVuY3Rpb24oKXt2YXIgYT1udWxsLGE9ZnVuY3Rpb24oYSxjLGQpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIHRoaXMudChudWxsLGMpO2Nhc2UgMzpyZXR1cm4gdGhpcy5zKG51bGwsYyxkKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307YS5hPWZ1bmN0aW9uKGEsYyl7cmV0dXJuIHRoaXMudChudWxsLGMpfTthLmM9ZnVuY3Rpb24oYSxjLGQpe3JldHVybiB0aGlzLnMobnVsbCxjLGQpfTtyZXR1cm4gYX0oKTtrLmFwcGx5PWZ1bmN0aW9uKGEsYil7cmV0dXJuIHRoaXMuY2FsbC5hcHBseSh0aGlzLFt0aGlzXS5jb25jYXQoRmEoYikpKX07ay5iPWZ1bmN0aW9uKGEpe3JldHVybiB0aGlzLnQobnVsbCxhKX07ay5hPWZ1bmN0aW9uKGEsYil7cmV0dXJuIHRoaXMucyhudWxsLGEsYil9O3ZhciBRYz1uZXcgcmcobnVsbCwwLG51bGwsITEsbnVsbCwwKTtyZy5wcm90b3R5cGVbRWFdPWZ1bmN0aW9uKCl7cmV0dXJuIHVjKHRoaXMpfTtcbmZ1bmN0aW9uIHNnKGEsYixjLGQsZSl7dGhpcy51PWE7dGhpcy5yb290PWI7dGhpcy5jb3VudD1jO3RoaXMuVT1kO3RoaXMuZGE9ZTt0aGlzLnE9NTY7dGhpcy5qPTI1OH1rPXNnLnByb3RvdHlwZTtrLkpiPWZ1bmN0aW9uKGEsYil7aWYodGhpcy51KWlmKG51bGw9PWIpdGhpcy5VJiYodGhpcy5VPSExLHRoaXMuZGE9bnVsbCx0aGlzLmNvdW50LT0xKTtlbHNle2lmKG51bGwhPXRoaXMucm9vdCl7dmFyIGM9bmV3ICRmLGQ9dGhpcy5yb290Lm5iKHRoaXMudSwwLG5jKGIpLGIsYyk7ZCE9PXRoaXMucm9vdCYmKHRoaXMucm9vdD1kKTt0KGNbMF0pJiYodGhpcy5jb3VudC09MSl9fWVsc2UgdGhyb3cgRXJyb3IoXCJkaXNzb2MhIGFmdGVyIHBlcnNpc3RlbnQhXCIpO3JldHVybiB0aGlzfTtrLmtiPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gdGcodGhpcyxiLGMpfTtrLlNhPWZ1bmN0aW9uKGEsYil7cmV0dXJuIHVnKHRoaXMsYil9O1xuay5UYT1mdW5jdGlvbigpe3ZhciBhO2lmKHRoaXMudSl0aGlzLnU9bnVsbCxhPW5ldyByZyhudWxsLHRoaXMuY291bnQsdGhpcy5yb290LHRoaXMuVSx0aGlzLmRhLG51bGwpO2Vsc2UgdGhyb3cgRXJyb3IoXCJwZXJzaXN0ZW50ISBjYWxsZWQgdHdpY2VcIik7cmV0dXJuIGF9O2sudD1mdW5jdGlvbihhLGIpe3JldHVybiBudWxsPT1iP3RoaXMuVT90aGlzLmRhOm51bGw6bnVsbD09dGhpcy5yb290P251bGw6dGhpcy5yb290Lk9hKDAsbmMoYiksYil9O2sucz1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIG51bGw9PWI/dGhpcy5VP3RoaXMuZGE6YzpudWxsPT10aGlzLnJvb3Q/Yzp0aGlzLnJvb3QuT2EoMCxuYyhiKSxiLGMpfTtrLkw9ZnVuY3Rpb24oKXtpZih0aGlzLnUpcmV0dXJuIHRoaXMuY291bnQ7dGhyb3cgRXJyb3IoXCJjb3VudCBhZnRlciBwZXJzaXN0ZW50IVwiKTt9O1xuZnVuY3Rpb24gdWcoYSxiKXtpZihhLnUpe2lmKGI/Yi5qJjIwNDh8fGIuamN8fChiLmo/MDp3KGZiLGIpKTp3KGZiLGIpKXJldHVybiB0ZyhhLFlmLmI/WWYuYihiKTpZZi5jYWxsKG51bGwsYiksWmYuYj9aZi5iKGIpOlpmLmNhbGwobnVsbCxiKSk7Zm9yKHZhciBjPUQoYiksZD1hOzspe3ZhciBlPUcoYyk7aWYodChlKSl2YXIgZj1lLGM9SyhjKSxkPXRnKGQsZnVuY3Rpb24oKXt2YXIgYT1mO3JldHVybiBZZi5iP1lmLmIoYSk6WWYuY2FsbChudWxsLGEpfSgpLGZ1bmN0aW9uKCl7dmFyIGE9ZjtyZXR1cm4gWmYuYj9aZi5iKGEpOlpmLmNhbGwobnVsbCxhKX0oKSk7ZWxzZSByZXR1cm4gZH19ZWxzZSB0aHJvdyBFcnJvcihcImNvbmohIGFmdGVyIHBlcnNpc3RlbnRcIik7fVxuZnVuY3Rpb24gdGcoYSxiLGMpe2lmKGEudSl7aWYobnVsbD09YilhLmRhIT09YyYmKGEuZGE9YyksYS5VfHwoYS5jb3VudCs9MSxhLlU9ITApO2Vsc2V7dmFyIGQ9bmV3ICRmO2I9KG51bGw9PWEucm9vdD9pZzphLnJvb3QpLmxhKGEudSwwLG5jKGIpLGIsYyxkKTtiIT09YS5yb290JiYoYS5yb290PWIpO2QubyYmKGEuY291bnQrPTEpfXJldHVybiBhfXRocm93IEVycm9yKFwiYXNzb2MhIGFmdGVyIHBlcnNpc3RlbnQhXCIpO31mdW5jdGlvbiB2ZyhhLGIsYyl7Zm9yKHZhciBkPWI7OylpZihudWxsIT1hKWI9Yz9hLmxlZnQ6YS5yaWdodCxkPU5jLmEoZCxhKSxhPWI7ZWxzZSByZXR1cm4gZH1mdW5jdGlvbiB3ZyhhLGIsYyxkLGUpe3RoaXMuaz1hO3RoaXMuc3RhY2s9Yjt0aGlzLnBiPWM7dGhpcy5nPWQ7dGhpcy5wPWU7dGhpcy5xPTA7dGhpcy5qPTMyMzc0ODYyfWs9d2cucHJvdG90eXBlO2sudG9TdHJpbmc9ZnVuY3Rpb24oKXtyZXR1cm4gZWModGhpcyl9O2suSD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmt9O1xuay5MPWZ1bmN0aW9uKCl7cmV0dXJuIDA+dGhpcy5nP1EoSyh0aGlzKSkrMTp0aGlzLmd9O2suQj1mdW5jdGlvbigpe3ZhciBhPXRoaXMucDtyZXR1cm4gbnVsbCE9YT9hOnRoaXMucD1hPXdjKHRoaXMpfTtrLkE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gSWModGhpcyxiKX07ay5KPWZ1bmN0aW9uKCl7cmV0dXJuIE8oSix0aGlzLmspfTtrLlI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gUC5hKGIsdGhpcyl9O2suTz1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIFAuYyhiLGMsdGhpcyl9O2suTj1mdW5jdGlvbigpe3JldHVybiBXYyh0aGlzLnN0YWNrKX07ay5TPWZ1bmN0aW9uKCl7dmFyIGE9Ryh0aGlzLnN0YWNrKSxhPXZnKHRoaXMucGI/YS5yaWdodDphLmxlZnQsSyh0aGlzLnN0YWNrKSx0aGlzLnBiKTtyZXR1cm4gbnVsbCE9YT9uZXcgd2cobnVsbCxhLHRoaXMucGIsdGhpcy5nLTEsbnVsbCk6Sn07ay5EPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXN9O1xuay5GPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyB3ZyhiLHRoaXMuc3RhY2ssdGhpcy5wYix0aGlzLmcsdGhpcy5wKX07ay5HPWZ1bmN0aW9uKGEsYil7cmV0dXJuIE0oYix0aGlzKX07d2cucHJvdG90eXBlW0VhXT1mdW5jdGlvbigpe3JldHVybiB1Yyh0aGlzKX07ZnVuY3Rpb24geGcoYSxiLGMpe3JldHVybiBuZXcgd2cobnVsbCx2ZyhhLG51bGwsYiksYixjLG51bGwpfVxuZnVuY3Rpb24geWcoYSxiLGMsZCl7cmV0dXJuIGMgaW5zdGFuY2VvZiBYP2MubGVmdCBpbnN0YW5jZW9mIFg/bmV3IFgoYy5rZXksYy5vLGMubGVmdC51YSgpLG5ldyBaKGEsYixjLnJpZ2h0LGQsbnVsbCksbnVsbCk6Yy5yaWdodCBpbnN0YW5jZW9mIFg/bmV3IFgoYy5yaWdodC5rZXksYy5yaWdodC5vLG5ldyBaKGMua2V5LGMubyxjLmxlZnQsYy5yaWdodC5sZWZ0LG51bGwpLG5ldyBaKGEsYixjLnJpZ2h0LnJpZ2h0LGQsbnVsbCksbnVsbCk6bmV3IFooYSxiLGMsZCxudWxsKTpuZXcgWihhLGIsYyxkLG51bGwpfVxuZnVuY3Rpb24gemcoYSxiLGMsZCl7cmV0dXJuIGQgaW5zdGFuY2VvZiBYP2QucmlnaHQgaW5zdGFuY2VvZiBYP25ldyBYKGQua2V5LGQubyxuZXcgWihhLGIsYyxkLmxlZnQsbnVsbCksZC5yaWdodC51YSgpLG51bGwpOmQubGVmdCBpbnN0YW5jZW9mIFg/bmV3IFgoZC5sZWZ0LmtleSxkLmxlZnQubyxuZXcgWihhLGIsYyxkLmxlZnQubGVmdCxudWxsKSxuZXcgWihkLmtleSxkLm8sZC5sZWZ0LnJpZ2h0LGQucmlnaHQsbnVsbCksbnVsbCk6bmV3IFooYSxiLGMsZCxudWxsKTpuZXcgWihhLGIsYyxkLG51bGwpfVxuZnVuY3Rpb24gQWcoYSxiLGMsZCl7aWYoYyBpbnN0YW5jZW9mIFgpcmV0dXJuIG5ldyBYKGEsYixjLnVhKCksZCxudWxsKTtpZihkIGluc3RhbmNlb2YgWilyZXR1cm4gemcoYSxiLGMsZC5vYigpKTtpZihkIGluc3RhbmNlb2YgWCYmZC5sZWZ0IGluc3RhbmNlb2YgWilyZXR1cm4gbmV3IFgoZC5sZWZ0LmtleSxkLmxlZnQubyxuZXcgWihhLGIsYyxkLmxlZnQubGVmdCxudWxsKSx6ZyhkLmtleSxkLm8sZC5sZWZ0LnJpZ2h0LGQucmlnaHQub2IoKSksbnVsbCk7dGhyb3cgRXJyb3IoXCJyZWQtYmxhY2sgdHJlZSBpbnZhcmlhbnQgdmlvbGF0aW9uXCIpO31cbnZhciBDZz1mdW5jdGlvbiBCZyhiLGMsZCl7ZD1udWxsIT1iLmxlZnQ/QmcoYi5sZWZ0LGMsZCk6ZDtpZihBYyhkKSlyZXR1cm4gTC5iP0wuYihkKTpMLmNhbGwobnVsbCxkKTt2YXIgZT1iLmtleSxmPWIubztkPWMuYz9jLmMoZCxlLGYpOmMuY2FsbChudWxsLGQsZSxmKTtpZihBYyhkKSlyZXR1cm4gTC5iP0wuYihkKTpMLmNhbGwobnVsbCxkKTtiPW51bGwhPWIucmlnaHQ/QmcoYi5yaWdodCxjLGQpOmQ7cmV0dXJuIEFjKGIpP0wuYj9MLmIoYik6TC5jYWxsKG51bGwsYik6Yn07ZnVuY3Rpb24gWihhLGIsYyxkLGUpe3RoaXMua2V5PWE7dGhpcy5vPWI7dGhpcy5sZWZ0PWM7dGhpcy5yaWdodD1kO3RoaXMucD1lO3RoaXMucT0wO3RoaXMuaj0zMjQwMjIwN31rPVoucHJvdG90eXBlO2suTWI9ZnVuY3Rpb24oYSl7cmV0dXJuIGEuT2IodGhpcyl9O2sub2I9ZnVuY3Rpb24oKXtyZXR1cm4gbmV3IFgodGhpcy5rZXksdGhpcy5vLHRoaXMubGVmdCx0aGlzLnJpZ2h0LG51bGwpfTtcbmsudWE9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpc307ay5MYj1mdW5jdGlvbihhKXtyZXR1cm4gYS5OYih0aGlzKX07ay5yZXBsYWNlPWZ1bmN0aW9uKGEsYixjLGQpe3JldHVybiBuZXcgWihhLGIsYyxkLG51bGwpfTtrLk5iPWZ1bmN0aW9uKGEpe3JldHVybiBuZXcgWihhLmtleSxhLm8sdGhpcyxhLnJpZ2h0LG51bGwpfTtrLk9iPWZ1bmN0aW9uKGEpe3JldHVybiBuZXcgWihhLmtleSxhLm8sYS5sZWZ0LHRoaXMsbnVsbCl9O2suWGE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gQ2codGhpcyxhLGIpfTtrLnQ9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gQy5jKHRoaXMsYixudWxsKX07ay5zPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gQy5jKHRoaXMsYixjKX07ay5RPWZ1bmN0aW9uKGEsYil7cmV0dXJuIDA9PT1iP3RoaXMua2V5OjE9PT1iP3RoaXMubzpudWxsfTtrLiQ9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiAwPT09Yj90aGlzLmtleToxPT09Yj90aGlzLm86Y307XG5rLlVhPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4obmV3IFcobnVsbCwyLDUsdWYsW3RoaXMua2V5LHRoaXMub10sbnVsbCkpLlVhKG51bGwsYixjKX07ay5IPWZ1bmN0aW9uKCl7cmV0dXJuIG51bGx9O2suTD1mdW5jdGlvbigpe3JldHVybiAyfTtrLmhiPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMua2V5fTtrLmliPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMub307ay5MYT1mdW5jdGlvbigpe3JldHVybiB0aGlzLm99O2suTWE9ZnVuY3Rpb24oKXtyZXR1cm4gbmV3IFcobnVsbCwxLDUsdWYsW3RoaXMua2V5XSxudWxsKX07ay5CPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5wO3JldHVybiBudWxsIT1hP2E6dGhpcy5wPWE9d2ModGhpcyl9O2suQT1mdW5jdGlvbihhLGIpe3JldHVybiBJYyh0aGlzLGIpfTtrLko9ZnVuY3Rpb24oKXtyZXR1cm4gTWN9O2suUj1mdW5jdGlvbihhLGIpe3JldHVybiBDYy5hKHRoaXMsYil9O2suTz1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIENjLmModGhpcyxiLGMpfTtcbmsuS2E9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBSYy5jKG5ldyBXKG51bGwsMiw1LHVmLFt0aGlzLmtleSx0aGlzLm9dLG51bGwpLGIsYyl9O2suRD1mdW5jdGlvbigpe3JldHVybiBSYShSYShKLHRoaXMubyksdGhpcy5rZXkpfTtrLkY9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gTyhuZXcgVyhudWxsLDIsNSx1ZixbdGhpcy5rZXksdGhpcy5vXSxudWxsKSxiKX07ay5HPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyBXKG51bGwsMyw1LHVmLFt0aGlzLmtleSx0aGlzLm8sYl0sbnVsbCl9O1xuay5jYWxsPWZ1bmN0aW9uKCl7dmFyIGE9bnVsbCxhPWZ1bmN0aW9uKGEsYyxkKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiB0aGlzLnQobnVsbCxjKTtjYXNlIDM6cmV0dXJuIHRoaXMucyhudWxsLGMsZCl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2EuYT1mdW5jdGlvbihhLGMpe3JldHVybiB0aGlzLnQobnVsbCxjKX07YS5jPWZ1bmN0aW9uKGEsYyxkKXtyZXR1cm4gdGhpcy5zKG51bGwsYyxkKX07cmV0dXJuIGF9KCk7ay5hcHBseT1mdW5jdGlvbihhLGIpe3JldHVybiB0aGlzLmNhbGwuYXBwbHkodGhpcyxbdGhpc10uY29uY2F0KEZhKGIpKSl9O2suYj1mdW5jdGlvbihhKXtyZXR1cm4gdGhpcy50KG51bGwsYSl9O2suYT1mdW5jdGlvbihhLGIpe3JldHVybiB0aGlzLnMobnVsbCxhLGIpfTtaLnByb3RvdHlwZVtFYV09ZnVuY3Rpb24oKXtyZXR1cm4gdWModGhpcyl9O1xuZnVuY3Rpb24gWChhLGIsYyxkLGUpe3RoaXMua2V5PWE7dGhpcy5vPWI7dGhpcy5sZWZ0PWM7dGhpcy5yaWdodD1kO3RoaXMucD1lO3RoaXMucT0wO3RoaXMuaj0zMjQwMjIwN31rPVgucHJvdG90eXBlO2suTWI9ZnVuY3Rpb24oYSl7cmV0dXJuIG5ldyBYKHRoaXMua2V5LHRoaXMubyx0aGlzLmxlZnQsYSxudWxsKX07ay5vYj1mdW5jdGlvbigpe3Rocm93IEVycm9yKFwicmVkLWJsYWNrIHRyZWUgaW52YXJpYW50IHZpb2xhdGlvblwiKTt9O2sudWE9ZnVuY3Rpb24oKXtyZXR1cm4gbmV3IFoodGhpcy5rZXksdGhpcy5vLHRoaXMubGVmdCx0aGlzLnJpZ2h0LG51bGwpfTtrLkxiPWZ1bmN0aW9uKGEpe3JldHVybiBuZXcgWCh0aGlzLmtleSx0aGlzLm8sYSx0aGlzLnJpZ2h0LG51bGwpfTtrLnJlcGxhY2U9ZnVuY3Rpb24oYSxiLGMsZCl7cmV0dXJuIG5ldyBYKGEsYixjLGQsbnVsbCl9O1xuay5OYj1mdW5jdGlvbihhKXtyZXR1cm4gdGhpcy5sZWZ0IGluc3RhbmNlb2YgWD9uZXcgWCh0aGlzLmtleSx0aGlzLm8sdGhpcy5sZWZ0LnVhKCksbmV3IFooYS5rZXksYS5vLHRoaXMucmlnaHQsYS5yaWdodCxudWxsKSxudWxsKTp0aGlzLnJpZ2h0IGluc3RhbmNlb2YgWD9uZXcgWCh0aGlzLnJpZ2h0LmtleSx0aGlzLnJpZ2h0Lm8sbmV3IFoodGhpcy5rZXksdGhpcy5vLHRoaXMubGVmdCx0aGlzLnJpZ2h0LmxlZnQsbnVsbCksbmV3IFooYS5rZXksYS5vLHRoaXMucmlnaHQucmlnaHQsYS5yaWdodCxudWxsKSxudWxsKTpuZXcgWihhLmtleSxhLm8sdGhpcyxhLnJpZ2h0LG51bGwpfTtcbmsuT2I9ZnVuY3Rpb24oYSl7cmV0dXJuIHRoaXMucmlnaHQgaW5zdGFuY2VvZiBYP25ldyBYKHRoaXMua2V5LHRoaXMubyxuZXcgWihhLmtleSxhLm8sYS5sZWZ0LHRoaXMubGVmdCxudWxsKSx0aGlzLnJpZ2h0LnVhKCksbnVsbCk6dGhpcy5sZWZ0IGluc3RhbmNlb2YgWD9uZXcgWCh0aGlzLmxlZnQua2V5LHRoaXMubGVmdC5vLG5ldyBaKGEua2V5LGEubyxhLmxlZnQsdGhpcy5sZWZ0LmxlZnQsbnVsbCksbmV3IFoodGhpcy5rZXksdGhpcy5vLHRoaXMubGVmdC5yaWdodCx0aGlzLnJpZ2h0LG51bGwpLG51bGwpOm5ldyBaKGEua2V5LGEubyxhLmxlZnQsdGhpcyxudWxsKX07ay5YYT1mdW5jdGlvbihhLGIpe3JldHVybiBDZyh0aGlzLGEsYil9O2sudD1mdW5jdGlvbihhLGIpe3JldHVybiBDLmModGhpcyxiLG51bGwpfTtrLnM9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBDLmModGhpcyxiLGMpfTtcbmsuUT1mdW5jdGlvbihhLGIpe3JldHVybiAwPT09Yj90aGlzLmtleToxPT09Yj90aGlzLm86bnVsbH07ay4kPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gMD09PWI/dGhpcy5rZXk6MT09PWI/dGhpcy5vOmN9O2suVWE9ZnVuY3Rpb24oYSxiLGMpe3JldHVybihuZXcgVyhudWxsLDIsNSx1ZixbdGhpcy5rZXksdGhpcy5vXSxudWxsKSkuVWEobnVsbCxiLGMpfTtrLkg9ZnVuY3Rpb24oKXtyZXR1cm4gbnVsbH07ay5MPWZ1bmN0aW9uKCl7cmV0dXJuIDJ9O2suaGI9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5rZXl9O2suaWI9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5vfTtrLkxhPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMub307ay5NYT1mdW5jdGlvbigpe3JldHVybiBuZXcgVyhudWxsLDEsNSx1ZixbdGhpcy5rZXldLG51bGwpfTtrLkI9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLnA7cmV0dXJuIG51bGwhPWE/YTp0aGlzLnA9YT13Yyh0aGlzKX07XG5rLkE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gSWModGhpcyxiKX07ay5KPWZ1bmN0aW9uKCl7cmV0dXJuIE1jfTtrLlI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gQ2MuYSh0aGlzLGIpfTtrLk89ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBDYy5jKHRoaXMsYixjKX07ay5LYT1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIFJjLmMobmV3IFcobnVsbCwyLDUsdWYsW3RoaXMua2V5LHRoaXMub10sbnVsbCksYixjKX07ay5EPWZ1bmN0aW9uKCl7cmV0dXJuIFJhKFJhKEosdGhpcy5vKSx0aGlzLmtleSl9O2suRj1mdW5jdGlvbihhLGIpe3JldHVybiBPKG5ldyBXKG51bGwsMiw1LHVmLFt0aGlzLmtleSx0aGlzLm9dLG51bGwpLGIpfTtrLkc9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IFcobnVsbCwzLDUsdWYsW3RoaXMua2V5LHRoaXMubyxiXSxudWxsKX07XG5rLmNhbGw9ZnVuY3Rpb24oKXt2YXIgYT1udWxsLGE9ZnVuY3Rpb24oYSxjLGQpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIHRoaXMudChudWxsLGMpO2Nhc2UgMzpyZXR1cm4gdGhpcy5zKG51bGwsYyxkKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307YS5hPWZ1bmN0aW9uKGEsYyl7cmV0dXJuIHRoaXMudChudWxsLGMpfTthLmM9ZnVuY3Rpb24oYSxjLGQpe3JldHVybiB0aGlzLnMobnVsbCxjLGQpfTtyZXR1cm4gYX0oKTtrLmFwcGx5PWZ1bmN0aW9uKGEsYil7cmV0dXJuIHRoaXMuY2FsbC5hcHBseSh0aGlzLFt0aGlzXS5jb25jYXQoRmEoYikpKX07ay5iPWZ1bmN0aW9uKGEpe3JldHVybiB0aGlzLnQobnVsbCxhKX07ay5hPWZ1bmN0aW9uKGEsYil7cmV0dXJuIHRoaXMucyhudWxsLGEsYil9O1gucHJvdG90eXBlW0VhXT1mdW5jdGlvbigpe3JldHVybiB1Yyh0aGlzKX07XG52YXIgRWc9ZnVuY3Rpb24gRGcoYixjLGQsZSxmKXtpZihudWxsPT1jKXJldHVybiBuZXcgWChkLGUsbnVsbCxudWxsLG51bGwpO3ZhciBnO2c9Yy5rZXk7Zz1iLmE/Yi5hKGQsZyk6Yi5jYWxsKG51bGwsZCxnKTtpZigwPT09ZylyZXR1cm4gZlswXT1jLG51bGw7aWYoMD5nKXJldHVybiBiPURnKGIsYy5sZWZ0LGQsZSxmKSxudWxsIT1iP2MuTGIoYik6bnVsbDtiPURnKGIsYy5yaWdodCxkLGUsZik7cmV0dXJuIG51bGwhPWI/Yy5NYihiKTpudWxsfSxHZz1mdW5jdGlvbiBGZyhiLGMpe2lmKG51bGw9PWIpcmV0dXJuIGM7aWYobnVsbD09YylyZXR1cm4gYjtpZihiIGluc3RhbmNlb2YgWCl7aWYoYyBpbnN0YW5jZW9mIFgpe3ZhciBkPUZnKGIucmlnaHQsYy5sZWZ0KTtyZXR1cm4gZCBpbnN0YW5jZW9mIFg/bmV3IFgoZC5rZXksZC5vLG5ldyBYKGIua2V5LGIubyxiLmxlZnQsZC5sZWZ0LG51bGwpLG5ldyBYKGMua2V5LGMubyxkLnJpZ2h0LGMucmlnaHQsbnVsbCksbnVsbCk6bmV3IFgoYi5rZXksXG5iLm8sYi5sZWZ0LG5ldyBYKGMua2V5LGMubyxkLGMucmlnaHQsbnVsbCksbnVsbCl9cmV0dXJuIG5ldyBYKGIua2V5LGIubyxiLmxlZnQsRmcoYi5yaWdodCxjKSxudWxsKX1pZihjIGluc3RhbmNlb2YgWClyZXR1cm4gbmV3IFgoYy5rZXksYy5vLEZnKGIsYy5sZWZ0KSxjLnJpZ2h0LG51bGwpO2Q9RmcoYi5yaWdodCxjLmxlZnQpO3JldHVybiBkIGluc3RhbmNlb2YgWD9uZXcgWChkLmtleSxkLm8sbmV3IFooYi5rZXksYi5vLGIubGVmdCxkLmxlZnQsbnVsbCksbmV3IFooYy5rZXksYy5vLGQucmlnaHQsYy5yaWdodCxudWxsKSxudWxsKTpBZyhiLmtleSxiLm8sYi5sZWZ0LG5ldyBaKGMua2V5LGMubyxkLGMucmlnaHQsbnVsbCkpfSxJZz1mdW5jdGlvbiBIZyhiLGMsZCxlKXtpZihudWxsIT1jKXt2YXIgZjtmPWMua2V5O2Y9Yi5hP2IuYShkLGYpOmIuY2FsbChudWxsLGQsZik7aWYoMD09PWYpcmV0dXJuIGVbMF09YyxHZyhjLmxlZnQsYy5yaWdodCk7aWYoMD5mKXJldHVybiBiPUhnKGIsXG5jLmxlZnQsZCxlKSxudWxsIT1ifHxudWxsIT1lWzBdP2MubGVmdCBpbnN0YW5jZW9mIFo/QWcoYy5rZXksYy5vLGIsYy5yaWdodCk6bmV3IFgoYy5rZXksYy5vLGIsYy5yaWdodCxudWxsKTpudWxsO2I9SGcoYixjLnJpZ2h0LGQsZSk7aWYobnVsbCE9Ynx8bnVsbCE9ZVswXSlpZihjLnJpZ2h0IGluc3RhbmNlb2YgWilpZihlPWMua2V5LGQ9Yy5vLGM9Yy5sZWZ0LGIgaW5zdGFuY2VvZiBYKWM9bmV3IFgoZSxkLGMsYi51YSgpLG51bGwpO2Vsc2UgaWYoYyBpbnN0YW5jZW9mIFopYz15ZyhlLGQsYy5vYigpLGIpO2Vsc2UgaWYoYyBpbnN0YW5jZW9mIFgmJmMucmlnaHQgaW5zdGFuY2VvZiBaKWM9bmV3IFgoYy5yaWdodC5rZXksYy5yaWdodC5vLHlnKGMua2V5LGMubyxjLmxlZnQub2IoKSxjLnJpZ2h0LmxlZnQpLG5ldyBaKGUsZCxjLnJpZ2h0LnJpZ2h0LGIsbnVsbCksbnVsbCk7ZWxzZSB0aHJvdyBFcnJvcihcInJlZC1ibGFjayB0cmVlIGludmFyaWFudCB2aW9sYXRpb25cIik7ZWxzZSBjPVxubmV3IFgoYy5rZXksYy5vLGMubGVmdCxiLG51bGwpO2Vsc2UgYz1udWxsO3JldHVybiBjfXJldHVybiBudWxsfSxLZz1mdW5jdGlvbiBKZyhiLGMsZCxlKXt2YXIgZj1jLmtleSxnPWIuYT9iLmEoZCxmKTpiLmNhbGwobnVsbCxkLGYpO3JldHVybiAwPT09Zz9jLnJlcGxhY2UoZixlLGMubGVmdCxjLnJpZ2h0KTowPmc/Yy5yZXBsYWNlKGYsYy5vLEpnKGIsYy5sZWZ0LGQsZSksYy5yaWdodCk6Yy5yZXBsYWNlKGYsYy5vLGMubGVmdCxKZyhiLGMucmlnaHQsZCxlKSl9O2Z1bmN0aW9uIExnKGEsYixjLGQsZSl7dGhpcy5hYT1hO3RoaXMubmE9Yjt0aGlzLmc9Yzt0aGlzLms9ZDt0aGlzLnA9ZTt0aGlzLmo9NDE4Nzc2ODQ3O3RoaXMucT04MTkyfWs9TGcucHJvdG90eXBlO2sudG9TdHJpbmc9ZnVuY3Rpb24oKXtyZXR1cm4gZWModGhpcyl9O1xuZnVuY3Rpb24gTWcoYSxiKXtmb3IodmFyIGM9YS5uYTs7KWlmKG51bGwhPWMpe3ZhciBkO2Q9Yy5rZXk7ZD1hLmFhLmE/YS5hYS5hKGIsZCk6YS5hYS5jYWxsKG51bGwsYixkKTtpZigwPT09ZClyZXR1cm4gYztjPTA+ZD9jLmxlZnQ6Yy5yaWdodH1lbHNlIHJldHVybiBudWxsfWsudD1mdW5jdGlvbihhLGIpe3JldHVybiAkYS5jKHRoaXMsYixudWxsKX07ay5zPWZ1bmN0aW9uKGEsYixjKXthPU1nKHRoaXMsYik7cmV0dXJuIG51bGwhPWE/YS5vOmN9O2suZ2I9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBudWxsIT10aGlzLm5hP0NnKHRoaXMubmEsYixjKTpjfTtrLkg9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5rfTtrLkw9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5nfTtrLmFiPWZ1bmN0aW9uKCl7cmV0dXJuIDA8dGhpcy5nP3hnKHRoaXMubmEsITEsdGhpcy5nKTpudWxsfTtrLkI9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLnA7cmV0dXJuIG51bGwhPWE/YTp0aGlzLnA9YT14Yyh0aGlzKX07XG5rLkE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gUGYodGhpcyxiKX07ay5KPWZ1bmN0aW9uKCl7cmV0dXJuIG5ldyBMZyh0aGlzLmFhLG51bGwsMCx0aGlzLmssMCl9O2sud2I9ZnVuY3Rpb24oYSxiKXt2YXIgYz1bbnVsbF0sZD1JZyh0aGlzLmFhLHRoaXMubmEsYixjKTtyZXR1cm4gbnVsbD09ZD9udWxsPT1SLmEoYywwKT90aGlzOm5ldyBMZyh0aGlzLmFhLG51bGwsMCx0aGlzLmssbnVsbCk6bmV3IExnKHRoaXMuYWEsZC51YSgpLHRoaXMuZy0xLHRoaXMuayxudWxsKX07ay5LYT1mdW5jdGlvbihhLGIsYyl7YT1bbnVsbF07dmFyIGQ9RWcodGhpcy5hYSx0aGlzLm5hLGIsYyxhKTtyZXR1cm4gbnVsbD09ZD8oYT1SLmEoYSwwKSxzYy5hKGMsYS5vKT90aGlzOm5ldyBMZyh0aGlzLmFhLEtnKHRoaXMuYWEsdGhpcy5uYSxiLGMpLHRoaXMuZyx0aGlzLmssbnVsbCkpOm5ldyBMZyh0aGlzLmFhLGQudWEoKSx0aGlzLmcrMSx0aGlzLmssbnVsbCl9O1xuay5yYj1mdW5jdGlvbihhLGIpe3JldHVybiBudWxsIT1NZyh0aGlzLGIpfTtrLkQ9ZnVuY3Rpb24oKXtyZXR1cm4gMDx0aGlzLmc/eGcodGhpcy5uYSwhMCx0aGlzLmcpOm51bGx9O2suRj1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgTGcodGhpcy5hYSx0aGlzLm5hLHRoaXMuZyxiLHRoaXMucCl9O2suRz1mdW5jdGlvbihhLGIpe2lmKGVkKGIpKXJldHVybiBjYih0aGlzLEMuYShiLDApLEMuYShiLDEpKTtmb3IodmFyIGM9dGhpcyxkPUQoYik7Oyl7aWYobnVsbD09ZClyZXR1cm4gYzt2YXIgZT1HKGQpO2lmKGVkKGUpKWM9Y2IoYyxDLmEoZSwwKSxDLmEoZSwxKSksZD1LKGQpO2Vsc2UgdGhyb3cgRXJyb3IoXCJjb25qIG9uIGEgbWFwIHRha2VzIG1hcCBlbnRyaWVzIG9yIHNlcWFibGVzIG9mIG1hcCBlbnRyaWVzXCIpO319O1xuay5jYWxsPWZ1bmN0aW9uKCl7dmFyIGE9bnVsbCxhPWZ1bmN0aW9uKGEsYyxkKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiB0aGlzLnQobnVsbCxjKTtjYXNlIDM6cmV0dXJuIHRoaXMucyhudWxsLGMsZCl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2EuYT1mdW5jdGlvbihhLGMpe3JldHVybiB0aGlzLnQobnVsbCxjKX07YS5jPWZ1bmN0aW9uKGEsYyxkKXtyZXR1cm4gdGhpcy5zKG51bGwsYyxkKX07cmV0dXJuIGF9KCk7ay5hcHBseT1mdW5jdGlvbihhLGIpe3JldHVybiB0aGlzLmNhbGwuYXBwbHkodGhpcyxbdGhpc10uY29uY2F0KEZhKGIpKSl9O2suYj1mdW5jdGlvbihhKXtyZXR1cm4gdGhpcy50KG51bGwsYSl9O2suYT1mdW5jdGlvbihhLGIpe3JldHVybiB0aGlzLnMobnVsbCxhLGIpfTtrLkhiPWZ1bmN0aW9uKGEsYil7cmV0dXJuIDA8dGhpcy5nP3hnKHRoaXMubmEsYix0aGlzLmcpOm51bGx9O1xuay5JYj1mdW5jdGlvbihhLGIsYyl7aWYoMDx0aGlzLmcpe2E9bnVsbDtmb3IodmFyIGQ9dGhpcy5uYTs7KWlmKG51bGwhPWQpe3ZhciBlO2U9ZC5rZXk7ZT10aGlzLmFhLmE/dGhpcy5hYS5hKGIsZSk6dGhpcy5hYS5jYWxsKG51bGwsYixlKTtpZigwPT09ZSlyZXR1cm4gbmV3IHdnKG51bGwsTmMuYShhLGQpLGMsLTEsbnVsbCk7dChjKT8wPmU/KGE9TmMuYShhLGQpLGQ9ZC5sZWZ0KTpkPWQucmlnaHQ6MDxlPyhhPU5jLmEoYSxkKSxkPWQucmlnaHQpOmQ9ZC5sZWZ0fWVsc2UgcmV0dXJuIG51bGw9PWE/bnVsbDpuZXcgd2cobnVsbCxhLGMsLTEsbnVsbCl9ZWxzZSByZXR1cm4gbnVsbH07ay5HYj1mdW5jdGlvbihhLGIpe3JldHVybiBZZi5iP1lmLmIoYik6WWYuY2FsbChudWxsLGIpfTtrLkZiPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuYWF9O3ZhciBOZz1uZXcgTGcob2QsbnVsbCwwLG51bGwsMCk7TGcucHJvdG90eXBlW0VhXT1mdW5jdGlvbigpe3JldHVybiB1Yyh0aGlzKX07XG52YXIgT2c9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEpe3ZhciBkPW51bGw7aWYoMDxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGQ9MCxlPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMCk7ZDxlLmxlbmd0aDspZVtkXT1hcmd1bWVudHNbZCswXSwrK2Q7ZD1uZXcgRihlLDApfXJldHVybiBiLmNhbGwodGhpcyxkKX1mdW5jdGlvbiBiKGEpe2E9RChhKTtmb3IodmFyIGI9T2IoUWMpOzspaWYoYSl7dmFyIGU9SyhLKGEpKSxiPWVlLmMoYixHKGEpLExjKGEpKTthPWV9ZWxzZSByZXR1cm4gUWIoYil9YS5pPTA7YS5mPWZ1bmN0aW9uKGEpe2E9RChhKTtyZXR1cm4gYihhKX07YS5kPWI7cmV0dXJuIGF9KCksUGc9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEpe3ZhciBkPW51bGw7aWYoMDxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGQ9MCxlPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMCk7ZDxlLmxlbmd0aDspZVtkXT1hcmd1bWVudHNbZCswXSwrK2Q7ZD1uZXcgRihlLDApfXJldHVybiBiLmNhbGwodGhpcyxcbmQpfWZ1bmN0aW9uIGIoYSl7YTp7YT1ULmEoSGEsYSk7Zm9yKHZhciBiPWEubGVuZ3RoLGU9MCxmPU9iKFVmKTs7KWlmKGU8Yil2YXIgZz1lKzIsZj1SYihmLGFbZV0sYVtlKzFdKSxlPWc7ZWxzZXthPVFiKGYpO2JyZWFrIGF9YT12b2lkIDB9cmV0dXJuIGF9YS5pPTA7YS5mPWZ1bmN0aW9uKGEpe2E9RChhKTtyZXR1cm4gYihhKX07YS5kPWI7cmV0dXJuIGF9KCksUWc9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEpe3ZhciBkPW51bGw7aWYoMDxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGQ9MCxlPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMCk7ZDxlLmxlbmd0aDspZVtkXT1hcmd1bWVudHNbZCswXSwrK2Q7ZD1uZXcgRihlLDApfXJldHVybiBiLmNhbGwodGhpcyxkKX1mdW5jdGlvbiBiKGEpe2E9RChhKTtmb3IodmFyIGI9Tmc7OylpZihhKXt2YXIgZT1LKEsoYSkpLGI9UmMuYyhiLEcoYSksTGMoYSkpO2E9ZX1lbHNlIHJldHVybiBifWEuaT0wO2EuZj1mdW5jdGlvbihhKXthPUQoYSk7XG5yZXR1cm4gYihhKX07YS5kPWI7cmV0dXJuIGF9KCksUmc9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsZCl7dmFyIGU9bnVsbDtpZigxPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZT0wLGY9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0xKTtlPGYubGVuZ3RoOylmW2VdPWFyZ3VtZW50c1tlKzFdLCsrZTtlPW5ldyBGKGYsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGEsZSl9ZnVuY3Rpb24gYihhLGIpe2Zvcih2YXIgZT1EKGIpLGY9bmV3IExnKHFkKGEpLG51bGwsMCxudWxsLDApOzspaWYoZSl2YXIgZz1LKEsoZSkpLGY9UmMuYyhmLEcoZSksTGMoZSkpLGU9ZztlbHNlIHJldHVybiBmfWEuaT0xO2EuZj1mdW5jdGlvbihhKXt2YXIgZD1HKGEpO2E9SChhKTtyZXR1cm4gYihkLGEpfTthLmQ9YjtyZXR1cm4gYX0oKTtmdW5jdGlvbiBTZyhhLGIpe3RoaXMuWT1hO3RoaXMuWj1iO3RoaXMucT0wO3RoaXMuaj0zMjM3NDk4OH1rPVNnLnByb3RvdHlwZTtrLnRvU3RyaW5nPWZ1bmN0aW9uKCl7cmV0dXJuIGVjKHRoaXMpfTtcbmsuSD1mdW5jdGlvbigpe3JldHVybiB0aGlzLlp9O2suVD1mdW5jdGlvbigpe3ZhciBhPXRoaXMuWSxhPShhP2EuaiYxMjh8fGEueGJ8fChhLmo/MDp3KFhhLGEpKTp3KFhhLGEpKT90aGlzLlkuVChudWxsKTpLKHRoaXMuWSk7cmV0dXJuIG51bGw9PWE/bnVsbDpuZXcgU2coYSx0aGlzLlopfTtrLkI9ZnVuY3Rpb24oKXtyZXR1cm4gd2ModGhpcyl9O2suQT1mdW5jdGlvbihhLGIpe3JldHVybiBJYyh0aGlzLGIpfTtrLko9ZnVuY3Rpb24oKXtyZXR1cm4gTyhKLHRoaXMuWil9O2suUj1mdW5jdGlvbihhLGIpe3JldHVybiBQLmEoYix0aGlzKX07ay5PPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gUC5jKGIsYyx0aGlzKX07ay5OPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuWS5OKG51bGwpLmhiKG51bGwpfTtcbmsuUz1mdW5jdGlvbigpe3ZhciBhPXRoaXMuWSxhPShhP2EuaiYxMjh8fGEueGJ8fChhLmo/MDp3KFhhLGEpKTp3KFhhLGEpKT90aGlzLlkuVChudWxsKTpLKHRoaXMuWSk7cmV0dXJuIG51bGwhPWE/bmV3IFNnKGEsdGhpcy5aKTpKfTtrLkQ9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpc307ay5GPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyBTZyh0aGlzLlksYil9O2suRz1mdW5jdGlvbihhLGIpe3JldHVybiBNKGIsdGhpcyl9O1NnLnByb3RvdHlwZVtFYV09ZnVuY3Rpb24oKXtyZXR1cm4gdWModGhpcyl9O2Z1bmN0aW9uIFRnKGEpe3JldHVybihhPUQoYSkpP25ldyBTZyhhLG51bGwpOm51bGx9ZnVuY3Rpb24gWWYoYSl7cmV0dXJuIGhiKGEpfWZ1bmN0aW9uIFVnKGEsYil7dGhpcy5ZPWE7dGhpcy5aPWI7dGhpcy5xPTA7dGhpcy5qPTMyMzc0OTg4fWs9VWcucHJvdG90eXBlO2sudG9TdHJpbmc9ZnVuY3Rpb24oKXtyZXR1cm4gZWModGhpcyl9O2suSD1mdW5jdGlvbigpe3JldHVybiB0aGlzLlp9O1xuay5UPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5ZLGE9KGE/YS5qJjEyOHx8YS54Ynx8KGEuaj8wOncoWGEsYSkpOncoWGEsYSkpP3RoaXMuWS5UKG51bGwpOksodGhpcy5ZKTtyZXR1cm4gbnVsbD09YT9udWxsOm5ldyBVZyhhLHRoaXMuWil9O2suQj1mdW5jdGlvbigpe3JldHVybiB3Yyh0aGlzKX07ay5BPWZ1bmN0aW9uKGEsYil7cmV0dXJuIEljKHRoaXMsYil9O2suSj1mdW5jdGlvbigpe3JldHVybiBPKEosdGhpcy5aKX07ay5SPWZ1bmN0aW9uKGEsYil7cmV0dXJuIFAuYShiLHRoaXMpfTtrLk89ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBQLmMoYixjLHRoaXMpfTtrLk49ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5ZLk4obnVsbCkuaWIobnVsbCl9O2suUz1mdW5jdGlvbigpe3ZhciBhPXRoaXMuWSxhPShhP2EuaiYxMjh8fGEueGJ8fChhLmo/MDp3KFhhLGEpKTp3KFhhLGEpKT90aGlzLlkuVChudWxsKTpLKHRoaXMuWSk7cmV0dXJuIG51bGwhPWE/bmV3IFVnKGEsdGhpcy5aKTpKfTtcbmsuRD1mdW5jdGlvbigpe3JldHVybiB0aGlzfTtrLkY9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IFVnKHRoaXMuWSxiKX07ay5HPWZ1bmN0aW9uKGEsYil7cmV0dXJuIE0oYix0aGlzKX07VWcucHJvdG90eXBlW0VhXT1mdW5jdGlvbigpe3JldHVybiB1Yyh0aGlzKX07ZnVuY3Rpb24gVmcoYSl7cmV0dXJuKGE9RChhKSk/bmV3IFVnKGEsbnVsbCk6bnVsbH1mdW5jdGlvbiBaZihhKXtyZXR1cm4gaWIoYSl9XG52YXIgV2c9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEpe3ZhciBkPW51bGw7aWYoMDxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGQ9MCxlPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMCk7ZDxlLmxlbmd0aDspZVtkXT1hcmd1bWVudHNbZCswXSwrK2Q7ZD1uZXcgRihlLDApfXJldHVybiBiLmNhbGwodGhpcyxkKX1mdW5jdGlvbiBiKGEpe3JldHVybiB0KEZlKHVkLGEpKT9BLmEoZnVuY3Rpb24oYSxiKXtyZXR1cm4gTmMuYSh0KGEpP2E6VWYsYil9LGEpOm51bGx9YS5pPTA7YS5mPWZ1bmN0aW9uKGEpe2E9RChhKTtyZXR1cm4gYihhKX07YS5kPWI7cmV0dXJuIGF9KCksWGc9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsZCl7dmFyIGU9bnVsbDtpZigxPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZT0wLGY9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0xKTtlPGYubGVuZ3RoOylmW2VdPWFyZ3VtZW50c1tlKzFdLCsrZTtlPW5ldyBGKGYsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGEsZSl9ZnVuY3Rpb24gYihhLFxuYil7cmV0dXJuIHQoRmUodWQsYikpP0EuYShmdW5jdGlvbihhKXtyZXR1cm4gZnVuY3Rpb24oYixjKXtyZXR1cm4gQS5jKGEsdChiKT9iOlVmLEQoYykpfX0oZnVuY3Rpb24oYixkKXt2YXIgZz1HKGQpLGg9TGMoZCk7cmV0dXJuIG5kKGIsZyk/UmMuYyhiLGcsZnVuY3Rpb24oKXt2YXIgZD1TLmEoYixnKTtyZXR1cm4gYS5hP2EuYShkLGgpOmEuY2FsbChudWxsLGQsaCl9KCkpOlJjLmMoYixnLGgpfSksYik6bnVsbH1hLmk9MTthLmY9ZnVuY3Rpb24oYSl7dmFyIGQ9RyhhKTthPUgoYSk7cmV0dXJuIGIoZCxhKX07YS5kPWI7cmV0dXJuIGF9KCk7ZnVuY3Rpb24gWWcoYSxiKXtmb3IodmFyIGM9VWYsZD1EKGIpOzspaWYoZCl2YXIgZT1HKGQpLGY9Uy5jKGEsZSxaZyksYz1qZS5hKGYsWmcpP1JjLmMoYyxlLGYpOmMsZD1LKGQpO2Vsc2UgcmV0dXJuIE8oYyxWYyhhKSl9XG5mdW5jdGlvbiAkZyhhLGIsYyl7dGhpcy5rPWE7dGhpcy5XYT1iO3RoaXMucD1jO3RoaXMuaj0xNTA3NzY0Nzt0aGlzLnE9ODE5Nn1rPSRnLnByb3RvdHlwZTtrLnRvU3RyaW5nPWZ1bmN0aW9uKCl7cmV0dXJuIGVjKHRoaXMpfTtrLnQ9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gJGEuYyh0aGlzLGIsbnVsbCl9O2sucz1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIGJiKHRoaXMuV2EsYik/YjpjfTtrLkg9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5rfTtrLkw9ZnVuY3Rpb24oKXtyZXR1cm4gTWEodGhpcy5XYSl9O2suQj1mdW5jdGlvbigpe3ZhciBhPXRoaXMucDtyZXR1cm4gbnVsbCE9YT9hOnRoaXMucD1hPXhjKHRoaXMpfTtrLkE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gYWQoYikmJlEodGhpcyk9PT1RKGIpJiZFZShmdW5jdGlvbihhKXtyZXR1cm4gZnVuY3Rpb24oYil7cmV0dXJuIG5kKGEsYil9fSh0aGlzKSxiKX07ay4kYT1mdW5jdGlvbigpe3JldHVybiBuZXcgYWgoT2IodGhpcy5XYSkpfTtcbmsuSj1mdW5jdGlvbigpe3JldHVybiBPKGJoLHRoaXMuayl9O2suRWI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3ICRnKHRoaXMuayxlYih0aGlzLldhLGIpLG51bGwpfTtrLkQ9ZnVuY3Rpb24oKXtyZXR1cm4gVGcodGhpcy5XYSl9O2suRj1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgJGcoYix0aGlzLldhLHRoaXMucCl9O2suRz1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgJGcodGhpcy5rLFJjLmModGhpcy5XYSxiLG51bGwpLG51bGwpfTtcbmsuY2FsbD1mdW5jdGlvbigpe3ZhciBhPW51bGwsYT1mdW5jdGlvbihhLGMsZCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gdGhpcy50KG51bGwsYyk7Y2FzZSAzOnJldHVybiB0aGlzLnMobnVsbCxjLGQpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTthLmE9ZnVuY3Rpb24oYSxjKXtyZXR1cm4gdGhpcy50KG51bGwsYyl9O2EuYz1mdW5jdGlvbihhLGMsZCl7cmV0dXJuIHRoaXMucyhudWxsLGMsZCl9O3JldHVybiBhfSgpO2suYXBwbHk9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gdGhpcy5jYWxsLmFwcGx5KHRoaXMsW3RoaXNdLmNvbmNhdChGYShiKSkpfTtrLmI9ZnVuY3Rpb24oYSl7cmV0dXJuIHRoaXMudChudWxsLGEpfTtrLmE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gdGhpcy5zKG51bGwsYSxiKX07dmFyIGJoPW5ldyAkZyhudWxsLFVmLDApOyRnLnByb3RvdHlwZVtFYV09ZnVuY3Rpb24oKXtyZXR1cm4gdWModGhpcyl9O1xuZnVuY3Rpb24gYWgoYSl7dGhpcy5tYT1hO3RoaXMuaj0yNTk7dGhpcy5xPTEzNn1rPWFoLnByb3RvdHlwZTtrLmNhbGw9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjKXtyZXR1cm4gJGEuYyh0aGlzLm1hLGIsamQpPT09amQ/YzpifWZ1bmN0aW9uIGIoYSxiKXtyZXR1cm4gJGEuYyh0aGlzLm1hLGIsamQpPT09amQ/bnVsbDpifXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gYi5jYWxsKHRoaXMsYyxlKTtjYXNlIDM6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSxmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5hPWI7Yy5jPWE7cmV0dXJuIGN9KCk7ay5hcHBseT1mdW5jdGlvbihhLGIpe3JldHVybiB0aGlzLmNhbGwuYXBwbHkodGhpcyxbdGhpc10uY29uY2F0KEZhKGIpKSl9O1xuay5iPWZ1bmN0aW9uKGEpe3JldHVybiAkYS5jKHRoaXMubWEsYSxqZCk9PT1qZD9udWxsOmF9O2suYT1mdW5jdGlvbihhLGIpe3JldHVybiAkYS5jKHRoaXMubWEsYSxqZCk9PT1qZD9iOmF9O2sudD1mdW5jdGlvbihhLGIpe3JldHVybiAkYS5jKHRoaXMsYixudWxsKX07ay5zPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gJGEuYyh0aGlzLm1hLGIsamQpPT09amQ/YzpifTtrLkw9ZnVuY3Rpb24oKXtyZXR1cm4gUSh0aGlzLm1hKX07ay5UYj1mdW5jdGlvbihhLGIpe3RoaXMubWE9ZmUuYSh0aGlzLm1hLGIpO3JldHVybiB0aGlzfTtrLlNhPWZ1bmN0aW9uKGEsYil7dGhpcy5tYT1lZS5jKHRoaXMubWEsYixudWxsKTtyZXR1cm4gdGhpc307ay5UYT1mdW5jdGlvbigpe3JldHVybiBuZXcgJGcobnVsbCxRYih0aGlzLm1hKSxudWxsKX07ZnVuY3Rpb24gY2goYSxiLGMpe3RoaXMuaz1hO3RoaXMuamE9Yjt0aGlzLnA9Yzt0aGlzLmo9NDE3NzMwODMxO3RoaXMucT04MTkyfWs9Y2gucHJvdG90eXBlO1xuay50b1N0cmluZz1mdW5jdGlvbigpe3JldHVybiBlYyh0aGlzKX07ay50PWZ1bmN0aW9uKGEsYil7cmV0dXJuICRhLmModGhpcyxiLG51bGwpfTtrLnM9ZnVuY3Rpb24oYSxiLGMpe2E9TWcodGhpcy5qYSxiKTtyZXR1cm4gbnVsbCE9YT9hLmtleTpjfTtrLkg9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5rfTtrLkw9ZnVuY3Rpb24oKXtyZXR1cm4gUSh0aGlzLmphKX07ay5hYj1mdW5jdGlvbigpe3JldHVybiAwPFEodGhpcy5qYSk/T2UuYShZZixHYih0aGlzLmphKSk6bnVsbH07ay5CPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5wO3JldHVybiBudWxsIT1hP2E6dGhpcy5wPWE9eGModGhpcyl9O2suQT1mdW5jdGlvbihhLGIpe3JldHVybiBhZChiKSYmUSh0aGlzKT09PVEoYikmJkVlKGZ1bmN0aW9uKGEpe3JldHVybiBmdW5jdGlvbihiKXtyZXR1cm4gbmQoYSxiKX19KHRoaXMpLGIpfTtrLko9ZnVuY3Rpb24oKXtyZXR1cm4gbmV3IGNoKHRoaXMuayxOYSh0aGlzLmphKSwwKX07XG5rLkViPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyBjaCh0aGlzLmssU2MuYSh0aGlzLmphLGIpLG51bGwpfTtrLkQ9ZnVuY3Rpb24oKXtyZXR1cm4gVGcodGhpcy5qYSl9O2suRj1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgY2goYix0aGlzLmphLHRoaXMucCl9O2suRz1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgY2godGhpcy5rLFJjLmModGhpcy5qYSxiLG51bGwpLG51bGwpfTtrLmNhbGw9ZnVuY3Rpb24oKXt2YXIgYT1udWxsLGE9ZnVuY3Rpb24oYSxjLGQpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIHRoaXMudChudWxsLGMpO2Nhc2UgMzpyZXR1cm4gdGhpcy5zKG51bGwsYyxkKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307YS5hPWZ1bmN0aW9uKGEsYyl7cmV0dXJuIHRoaXMudChudWxsLGMpfTthLmM9ZnVuY3Rpb24oYSxjLGQpe3JldHVybiB0aGlzLnMobnVsbCxjLGQpfTtyZXR1cm4gYX0oKTtcbmsuYXBwbHk9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gdGhpcy5jYWxsLmFwcGx5KHRoaXMsW3RoaXNdLmNvbmNhdChGYShiKSkpfTtrLmI9ZnVuY3Rpb24oYSl7cmV0dXJuIHRoaXMudChudWxsLGEpfTtrLmE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gdGhpcy5zKG51bGwsYSxiKX07ay5IYj1mdW5jdGlvbihhLGIpe3JldHVybiBPZS5hKFlmLEhiKHRoaXMuamEsYikpfTtrLkliPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gT2UuYShZZixJYih0aGlzLmphLGIsYykpfTtrLkdiPWZ1bmN0aW9uKGEsYil7cmV0dXJuIGJ9O2suRmI9ZnVuY3Rpb24oKXtyZXR1cm4gS2IodGhpcy5qYSl9O3ZhciBlaD1uZXcgY2gobnVsbCxOZywwKTtjaC5wcm90b3R5cGVbRWFdPWZ1bmN0aW9uKCl7cmV0dXJuIHVjKHRoaXMpfTtcbmZ1bmN0aW9uIGZoKGEpe2E9RChhKTtpZihudWxsPT1hKXJldHVybiBiaDtpZihhIGluc3RhbmNlb2YgRiYmMD09PWEubSl7YT1hLmU7YTp7Zm9yKHZhciBiPTAsYz1PYihiaCk7OylpZihiPGEubGVuZ3RoKXZhciBkPWIrMSxjPWMuU2EobnVsbCxhW2JdKSxiPWQ7ZWxzZXthPWM7YnJlYWsgYX1hPXZvaWQgMH1yZXR1cm4gYS5UYShudWxsKX1mb3IoZD1PYihiaCk7OylpZihudWxsIT1hKWI9YS5UKG51bGwpLGQ9ZC5TYShudWxsLGEuTihudWxsKSksYT1iO2Vsc2UgcmV0dXJuIGQuVGEobnVsbCl9XG52YXIgZ2g9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEpe3ZhciBkPW51bGw7aWYoMDxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGQ9MCxlPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMCk7ZDxlLmxlbmd0aDspZVtkXT1hcmd1bWVudHNbZCswXSwrK2Q7ZD1uZXcgRihlLDApfXJldHVybiBiLmNhbGwodGhpcyxkKX1mdW5jdGlvbiBiKGEpe3JldHVybiBBLmMoUmEsZWgsYSl9YS5pPTA7YS5mPWZ1bmN0aW9uKGEpe2E9RChhKTtyZXR1cm4gYihhKX07YS5kPWI7cmV0dXJuIGF9KCksaGg9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsZCl7dmFyIGU9bnVsbDtpZigxPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZT0wLGY9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0xKTtlPGYubGVuZ3RoOylmW2VdPWFyZ3VtZW50c1tlKzFdLCsrZTtlPW5ldyBGKGYsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGEsZSl9ZnVuY3Rpb24gYihhLGIpe3JldHVybiBBLmMoUmEsbmV3IGNoKG51bGwsUmcoYSksMCksYil9XG5hLmk9MTthLmY9ZnVuY3Rpb24oYSl7dmFyIGQ9RyhhKTthPUgoYSk7cmV0dXJuIGIoZCxhKX07YS5kPWI7cmV0dXJuIGF9KCk7ZnVuY3Rpb24gT2QoYSl7aWYoYSYmKGEucSY0MDk2fHxhLmxjKSlyZXR1cm4gYS5uYW1lO2lmKFwic3RyaW5nXCI9PT10eXBlb2YgYSlyZXR1cm4gYTt0aHJvdyBFcnJvcihbeihcIkRvZXNuJ3Qgc3VwcG9ydCBuYW1lOiBcIikseihhKV0uam9pbihcIlwiKSk7fVxudmFyIGloPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyl7cmV0dXJuKGEuYj9hLmIoYik6YS5jYWxsKG51bGwsYikpPihhLmI/YS5iKGMpOmEuY2FsbChudWxsLGMpKT9iOmN9dmFyIGI9bnVsbCxjPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShiLGQsaCxsKXt2YXIgbT1udWxsO2lmKDM8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBtPTAscD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTMpO208cC5sZW5ndGg7KXBbbV09YXJndW1lbnRzW20rM10sKyttO209bmV3IEYocCwwKX1yZXR1cm4gYy5jYWxsKHRoaXMsYixkLGgsbSl9ZnVuY3Rpb24gYyhhLGQsZSxsKXtyZXR1cm4gQS5jKGZ1bmN0aW9uKGMsZCl7cmV0dXJuIGIuYyhhLGMsZCl9LGIuYyhhLGQsZSksbCl9YS5pPTM7YS5mPWZ1bmN0aW9uKGEpe3ZhciBiPUcoYSk7YT1LKGEpO3ZhciBkPUcoYSk7YT1LKGEpO3ZhciBsPUcoYSk7YT1IKGEpO3JldHVybiBjKGIsZCxsLGEpfTthLmQ9YztyZXR1cm4gYX0oKSxiPWZ1bmN0aW9uKGIsXG5lLGYsZyl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gZTtjYXNlIDM6cmV0dXJuIGEuY2FsbCh0aGlzLGIsZSxmKTtkZWZhdWx0OnZhciBoPW51bGw7aWYoMzxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGg9MCxsPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMyk7aDxsLmxlbmd0aDspbFtoXT1hcmd1bWVudHNbaCszXSwrK2g7aD1uZXcgRihsLDApfXJldHVybiBjLmQoYixlLGYsaCl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2IuaT0zO2IuZj1jLmY7Yi5hPWZ1bmN0aW9uKGEsYil7cmV0dXJuIGJ9O2IuYz1hO2IuZD1jLmQ7cmV0dXJuIGJ9KCk7ZnVuY3Rpb24gamgoYSl7dGhpcy5lPWF9amgucHJvdG90eXBlLmFkZD1mdW5jdGlvbihhKXtyZXR1cm4gdGhpcy5lLnB1c2goYSl9O2poLnByb3RvdHlwZS5zaXplPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuZS5sZW5ndGh9O1xuamgucHJvdG90eXBlLmNsZWFyPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuZT1bXX07XG52YXIga2g9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjKXtyZXR1cm4gbmV3IFYobnVsbCxmdW5jdGlvbigpe3ZhciBoPUQoYyk7cmV0dXJuIGg/TShQZS5hKGEsaCksZC5jKGEsYixRZS5hKGIsaCkpKTpudWxsfSxudWxsLG51bGwpfWZ1bmN0aW9uIGIoYSxiKXtyZXR1cm4gZC5jKGEsYSxiKX1mdW5jdGlvbiBjKGEpe3JldHVybiBmdW5jdGlvbihiKXtyZXR1cm4gZnVuY3Rpb24oYyl7cmV0dXJuIGZ1bmN0aW9uKCl7ZnVuY3Rpb24gZChoLGwpe2MuYWRkKGwpO2lmKGE9PT1jLnNpemUoKSl7dmFyIG09emYoYy5lKTtjLmNsZWFyKCk7cmV0dXJuIGIuYT9iLmEoaCxtKTpiLmNhbGwobnVsbCxoLG0pfXJldHVybiBofWZ1bmN0aW9uIGwoYSl7aWYoIXQoMD09PWMuZS5sZW5ndGgpKXt2YXIgZD16ZihjLmUpO2MuY2xlYXIoKTthPUJjKGIuYT9iLmEoYSxkKTpiLmNhbGwobnVsbCxhLGQpKX1yZXR1cm4gYi5iP2IuYihhKTpiLmNhbGwobnVsbCxhKX1mdW5jdGlvbiBtKCl7cmV0dXJuIGIubD9cbmIubCgpOmIuY2FsbChudWxsKX12YXIgcD1udWxsLHA9ZnVuY3Rpb24oYSxiKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAwOnJldHVybiBtLmNhbGwodGhpcyk7Y2FzZSAxOnJldHVybiBsLmNhbGwodGhpcyxhKTtjYXNlIDI6cmV0dXJuIGQuY2FsbCh0aGlzLGEsYil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O3AubD1tO3AuYj1sO3AuYT1kO3JldHVybiBwfSgpfShuZXcgamgoW10pKX19dmFyIGQ9bnVsbCxkPWZ1bmN0aW9uKGQsZixnKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBjLmNhbGwodGhpcyxkKTtjYXNlIDI6cmV0dXJuIGIuY2FsbCh0aGlzLGQsZik7Y2FzZSAzOnJldHVybiBhLmNhbGwodGhpcyxkLGYsZyl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2QuYj1jO2QuYT1iO2QuYz1hO3JldHVybiBkfSgpLGxoPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLFxuYil7cmV0dXJuIG5ldyBWKG51bGwsZnVuY3Rpb24oKXt2YXIgZj1EKGIpO2lmKGYpe3ZhciBnO2c9RyhmKTtnPWEuYj9hLmIoZyk6YS5jYWxsKG51bGwsZyk7Zj10KGcpP00oRyhmKSxjLmEoYSxIKGYpKSk6bnVsbH1lbHNlIGY9bnVsbDtyZXR1cm4gZn0sbnVsbCxudWxsKX1mdW5jdGlvbiBiKGEpe3JldHVybiBmdW5jdGlvbihiKXtyZXR1cm4gZnVuY3Rpb24oKXtmdW5jdGlvbiBjKGYsZyl7cmV0dXJuIHQoYS5iP2EuYihnKTphLmNhbGwobnVsbCxnKSk/Yi5hP2IuYShmLGcpOmIuY2FsbChudWxsLGYsZyk6bmV3IHljKGYpfWZ1bmN0aW9uIGcoYSl7cmV0dXJuIGIuYj9iLmIoYSk6Yi5jYWxsKG51bGwsYSl9ZnVuY3Rpb24gaCgpe3JldHVybiBiLmw/Yi5sKCk6Yi5jYWxsKG51bGwpfXZhciBsPW51bGwsbD1mdW5jdGlvbihhLGIpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDA6cmV0dXJuIGguY2FsbCh0aGlzKTtjYXNlIDE6cmV0dXJuIGcuY2FsbCh0aGlzLGEpO2Nhc2UgMjpyZXR1cm4gYy5jYWxsKHRoaXMsXG5hLGIpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtsLmw9aDtsLmI9ZztsLmE9YztyZXR1cm4gbH0oKX19dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYi5jYWxsKHRoaXMsYyk7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxjLGUpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmI9YjtjLmE9YTtyZXR1cm4gY30oKTtmdW5jdGlvbiBtaChhLGIsYyl7cmV0dXJuIGZ1bmN0aW9uKGQpe3ZhciBlPUtiKGEpO2Q9SmIoYSxkKTtlPWUuYT9lLmEoZCxjKTplLmNhbGwobnVsbCxkLGMpO3JldHVybiBiLmE/Yi5hKGUsMCk6Yi5jYWxsKG51bGwsZSwwKX19XG52YXIgbmg9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjLGcsaCl7dmFyIGw9SWIoYSxjLCEwKTtpZih0KGwpKXt2YXIgbT1SLmMobCwwLG51bGwpO3JldHVybiBsaC5hKG1oKGEsZyxoKSx0KG1oKGEsYixjKS5jYWxsKG51bGwsbSkpP2w6SyhsKSl9cmV0dXJuIG51bGx9ZnVuY3Rpb24gYihhLGIsYyl7dmFyIGc9bWgoYSxiLGMpLGg7YTp7aD1bQWQsQmRdO3ZhciBsPWgubGVuZ3RoO2lmKGw8PVZmKWZvcih2YXIgbT0wLHA9T2IoVWYpOzspaWYobTxsKXZhciBxPW0rMSxwPVJiKHAsaFttXSxudWxsKSxtPXE7ZWxzZXtoPW5ldyAkZyhudWxsLFFiKHApLG51bGwpO2JyZWFrIGF9ZWxzZSBmb3IobT0wLHA9T2IoYmgpOzspaWYobTxsKXE9bSsxLHA9UGIocCxoW21dKSxtPXE7ZWxzZXtoPVFiKHApO2JyZWFrIGF9aD12b2lkIDB9cmV0dXJuIHQoaC5jYWxsKG51bGwsYikpPyhhPUliKGEsYywhMCksdChhKT8oYj1SLmMoYSwwLG51bGwpLHQoZy5iP2cuYihiKTpnLmNhbGwobnVsbCxiKSk/XG5hOksoYSkpOm51bGwpOmxoLmEoZyxIYihhLCEwKSl9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSxmLGcsaCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMzpyZXR1cm4gYi5jYWxsKHRoaXMsYyxlLGYpO2Nhc2UgNTpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlLGYsZyxoKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5jPWI7Yy5yPWE7cmV0dXJuIGN9KCk7ZnVuY3Rpb24gb2goYSxiLGMpe3RoaXMubT1hO3RoaXMuZW5kPWI7dGhpcy5zdGVwPWN9b2gucHJvdG90eXBlLmdhPWZ1bmN0aW9uKCl7cmV0dXJuIDA8dGhpcy5zdGVwP3RoaXMubTx0aGlzLmVuZDp0aGlzLm0+dGhpcy5lbmR9O29oLnByb3RvdHlwZS5uZXh0PWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5tO3RoaXMubSs9dGhpcy5zdGVwO3JldHVybiBhfTtcbmZ1bmN0aW9uIHBoKGEsYixjLGQsZSl7dGhpcy5rPWE7dGhpcy5zdGFydD1iO3RoaXMuZW5kPWM7dGhpcy5zdGVwPWQ7dGhpcy5wPWU7dGhpcy5qPTMyMzc1MDA2O3RoaXMucT04MTkyfWs9cGgucHJvdG90eXBlO2sudG9TdHJpbmc9ZnVuY3Rpb24oKXtyZXR1cm4gZWModGhpcyl9O2suUT1mdW5jdGlvbihhLGIpe2lmKGI8TWEodGhpcykpcmV0dXJuIHRoaXMuc3RhcnQrYip0aGlzLnN0ZXA7aWYodGhpcy5zdGFydD50aGlzLmVuZCYmMD09PXRoaXMuc3RlcClyZXR1cm4gdGhpcy5zdGFydDt0aHJvdyBFcnJvcihcIkluZGV4IG91dCBvZiBib3VuZHNcIik7fTtrLiQ9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBiPE1hKHRoaXMpP3RoaXMuc3RhcnQrYip0aGlzLnN0ZXA6dGhpcy5zdGFydD50aGlzLmVuZCYmMD09PXRoaXMuc3RlcD90aGlzLnN0YXJ0OmN9O2sudmI9ITA7ay5mYj1mdW5jdGlvbigpe3JldHVybiBuZXcgb2godGhpcy5zdGFydCx0aGlzLmVuZCx0aGlzLnN0ZXApfTtrLkg9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5rfTtcbmsuVD1mdW5jdGlvbigpe3JldHVybiAwPHRoaXMuc3RlcD90aGlzLnN0YXJ0K3RoaXMuc3RlcDx0aGlzLmVuZD9uZXcgcGgodGhpcy5rLHRoaXMuc3RhcnQrdGhpcy5zdGVwLHRoaXMuZW5kLHRoaXMuc3RlcCxudWxsKTpudWxsOnRoaXMuc3RhcnQrdGhpcy5zdGVwPnRoaXMuZW5kP25ldyBwaCh0aGlzLmssdGhpcy5zdGFydCt0aGlzLnN0ZXAsdGhpcy5lbmQsdGhpcy5zdGVwLG51bGwpOm51bGx9O2suTD1mdW5jdGlvbigpe2lmKEFhKENiKHRoaXMpKSlyZXR1cm4gMDt2YXIgYT0odGhpcy5lbmQtdGhpcy5zdGFydCkvdGhpcy5zdGVwO3JldHVybiBNYXRoLmNlaWwuYj9NYXRoLmNlaWwuYihhKTpNYXRoLmNlaWwuY2FsbChudWxsLGEpfTtrLkI9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLnA7cmV0dXJuIG51bGwhPWE/YTp0aGlzLnA9YT13Yyh0aGlzKX07ay5BPWZ1bmN0aW9uKGEsYil7cmV0dXJuIEljKHRoaXMsYil9O2suSj1mdW5jdGlvbigpe3JldHVybiBPKEosdGhpcy5rKX07XG5rLlI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gQ2MuYSh0aGlzLGIpfTtrLk89ZnVuY3Rpb24oYSxiLGMpe2ZvcihhPXRoaXMuc3RhcnQ7OylpZigwPHRoaXMuc3RlcD9hPHRoaXMuZW5kOmE+dGhpcy5lbmQpe3ZhciBkPWE7Yz1iLmE/Yi5hKGMsZCk6Yi5jYWxsKG51bGwsYyxkKTtpZihBYyhjKSlyZXR1cm4gYj1jLEwuYj9MLmIoYik6TC5jYWxsKG51bGwsYik7YSs9dGhpcy5zdGVwfWVsc2UgcmV0dXJuIGN9O2suTj1mdW5jdGlvbigpe3JldHVybiBudWxsPT1DYih0aGlzKT9udWxsOnRoaXMuc3RhcnR9O2suUz1mdW5jdGlvbigpe3JldHVybiBudWxsIT1DYih0aGlzKT9uZXcgcGgodGhpcy5rLHRoaXMuc3RhcnQrdGhpcy5zdGVwLHRoaXMuZW5kLHRoaXMuc3RlcCxudWxsKTpKfTtrLkQ9ZnVuY3Rpb24oKXtyZXR1cm4gMDx0aGlzLnN0ZXA/dGhpcy5zdGFydDx0aGlzLmVuZD90aGlzOm51bGw6dGhpcy5zdGFydD50aGlzLmVuZD90aGlzOm51bGx9O1xuay5GPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyBwaChiLHRoaXMuc3RhcnQsdGhpcy5lbmQsdGhpcy5zdGVwLHRoaXMucCl9O2suRz1mdW5jdGlvbihhLGIpe3JldHVybiBNKGIsdGhpcyl9O3BoLnByb3RvdHlwZVtFYV09ZnVuY3Rpb24oKXtyZXR1cm4gdWModGhpcyl9O1xudmFyIHFoPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyl7cmV0dXJuIG5ldyBwaChudWxsLGEsYixjLG51bGwpfWZ1bmN0aW9uIGIoYSxiKXtyZXR1cm4gZS5jKGEsYiwxKX1mdW5jdGlvbiBjKGEpe3JldHVybiBlLmMoMCxhLDEpfWZ1bmN0aW9uIGQoKXtyZXR1cm4gZS5jKDAsTnVtYmVyLk1BWF9WQUxVRSwxKX12YXIgZT1udWxsLGU9ZnVuY3Rpb24oZSxnLGgpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDA6cmV0dXJuIGQuY2FsbCh0aGlzKTtjYXNlIDE6cmV0dXJuIGMuY2FsbCh0aGlzLGUpO2Nhc2UgMjpyZXR1cm4gYi5jYWxsKHRoaXMsZSxnKTtjYXNlIDM6cmV0dXJuIGEuY2FsbCh0aGlzLGUsZyxoKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307ZS5sPWQ7ZS5iPWM7ZS5hPWI7ZS5jPWE7cmV0dXJuIGV9KCkscmg9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYil7cmV0dXJuIG5ldyBWKG51bGwsZnVuY3Rpb24oKXt2YXIgZj1cbkQoYik7cmV0dXJuIGY/TShHKGYpLGMuYShhLFFlLmEoYSxmKSkpOm51bGx9LG51bGwsbnVsbCl9ZnVuY3Rpb24gYihhKXtyZXR1cm4gZnVuY3Rpb24oYil7cmV0dXJuIGZ1bmN0aW9uKGMpe3JldHVybiBmdW5jdGlvbigpe2Z1bmN0aW9uIGcoZyxoKXt2YXIgbD1jLmJiKDAsYy5SYShudWxsKSsxKSxtPUNkKGwsYSk7cmV0dXJuIDA9PT1sLWEqbT9iLmE/Yi5hKGcsaCk6Yi5jYWxsKG51bGwsZyxoKTpnfWZ1bmN0aW9uIGgoYSl7cmV0dXJuIGIuYj9iLmIoYSk6Yi5jYWxsKG51bGwsYSl9ZnVuY3Rpb24gbCgpe3JldHVybiBiLmw/Yi5sKCk6Yi5jYWxsKG51bGwpfXZhciBtPW51bGwsbT1mdW5jdGlvbihhLGIpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDA6cmV0dXJuIGwuY2FsbCh0aGlzKTtjYXNlIDE6cmV0dXJuIGguY2FsbCh0aGlzLGEpO2Nhc2UgMjpyZXR1cm4gZy5jYWxsKHRoaXMsYSxiKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO1xufTttLmw9bDttLmI9aDttLmE9ZztyZXR1cm4gbX0oKX0obmV3IE1lKC0xKSl9fXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGIuY2FsbCh0aGlzLGMpO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5iPWI7Yy5hPWE7cmV0dXJuIGN9KCksdGg9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYil7cmV0dXJuIG5ldyBWKG51bGwsZnVuY3Rpb24oKXt2YXIgZj1EKGIpO2lmKGYpe3ZhciBnPUcoZiksaD1hLmI/YS5iKGcpOmEuY2FsbChudWxsLGcpLGc9TShnLGxoLmEoZnVuY3Rpb24oYixjKXtyZXR1cm4gZnVuY3Rpb24oYil7cmV0dXJuIHNjLmEoYyxhLmI/YS5iKGIpOmEuY2FsbChudWxsLGIpKX19KGcsaCxmLGYpLEsoZikpKTtyZXR1cm4gTShnLGMuYShhLEQoUWUuYShRKGcpLGYpKSkpfXJldHVybiBudWxsfSxudWxsLFxubnVsbCl9ZnVuY3Rpb24gYihhKXtyZXR1cm4gZnVuY3Rpb24oYil7cmV0dXJuIGZ1bmN0aW9uKGMsZyl7cmV0dXJuIGZ1bmN0aW9uKCl7ZnVuY3Rpb24gaChoLGwpe3ZhciBtPUwuYj9MLmIoZyk6TC5jYWxsKG51bGwsZykscD1hLmI/YS5iKGwpOmEuY2FsbChudWxsLGwpO2FjKGcscCk7aWYoTmQobSxzaCl8fHNjLmEocCxtKSlyZXR1cm4gYy5hZGQobCksaDttPXpmKGMuZSk7Yy5jbGVhcigpO209Yi5hP2IuYShoLG0pOmIuY2FsbChudWxsLGgsbSk7QWMobSl8fGMuYWRkKGwpO3JldHVybiBtfWZ1bmN0aW9uIGwoYSl7aWYoIXQoMD09PWMuZS5sZW5ndGgpKXt2YXIgZD16ZihjLmUpO2MuY2xlYXIoKTthPUJjKGIuYT9iLmEoYSxkKTpiLmNhbGwobnVsbCxhLGQpKX1yZXR1cm4gYi5iP2IuYihhKTpiLmNhbGwobnVsbCxhKX1mdW5jdGlvbiBtKCl7cmV0dXJuIGIubD9iLmwoKTpiLmNhbGwobnVsbCl9dmFyIHA9bnVsbCxwPWZ1bmN0aW9uKGEsYil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMDpyZXR1cm4gbS5jYWxsKHRoaXMpO1xuY2FzZSAxOnJldHVybiBsLmNhbGwodGhpcyxhKTtjYXNlIDI6cmV0dXJuIGguY2FsbCh0aGlzLGEsYil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O3AubD1tO3AuYj1sO3AuYT1oO3JldHVybiBwfSgpfShuZXcgamgoW10pLG5ldyBNZShzaCkpfX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiLmNhbGwodGhpcyxjKTtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYj1iO2MuYT1hO3JldHVybiBjfSgpLHVoPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIpe2Zvcig7OylpZihEKGIpJiYwPGEpe3ZhciBjPWEtMSxnPUsoYik7YT1jO2I9Z31lbHNlIHJldHVybiBudWxsfWZ1bmN0aW9uIGIoYSl7Zm9yKDs7KWlmKEQoYSkpYT1LKGEpO2Vsc2UgcmV0dXJuIG51bGx9dmFyIGM9XG5udWxsLGM9ZnVuY3Rpb24oYyxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiLmNhbGwodGhpcyxjKTtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYj1iO2MuYT1hO3JldHVybiBjfSgpLHZoPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIpe3VoLmEoYSxiKTtyZXR1cm4gYn1mdW5jdGlvbiBiKGEpe3VoLmIoYSk7cmV0dXJuIGF9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYi5jYWxsKHRoaXMsYyk7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxjLGUpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmI9YjtjLmE9YTtyZXR1cm4gY30oKTtcbmZ1bmN0aW9uIHdoKGEsYixjLGQsZSxmLGcpe3ZhciBoPW1hO3RyeXttYT1udWxsPT1tYT9udWxsOm1hLTE7aWYobnVsbCE9bWEmJjA+bWEpcmV0dXJuIExiKGEsXCIjXCIpO0xiKGEsYyk7aWYoRChnKSl7dmFyIGw9RyhnKTtiLmM/Yi5jKGwsYSxmKTpiLmNhbGwobnVsbCxsLGEsZil9Zm9yKHZhciBtPUsoZykscD16YS5iKGYpLTE7OylpZighbXx8bnVsbCE9cCYmMD09PXApe0QobSkmJjA9PT1wJiYoTGIoYSxkKSxMYihhLFwiLi4uXCIpKTticmVha31lbHNle0xiKGEsZCk7dmFyIHE9RyhtKTtjPWE7Zz1mO2IuYz9iLmMocSxjLGcpOmIuY2FsbChudWxsLHEsYyxnKTt2YXIgcz1LKG0pO2M9cC0xO209cztwPWN9cmV0dXJuIExiKGEsZSl9ZmluYWxseXttYT1ofX1cbnZhciB4aD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxkKXt2YXIgZT1udWxsO2lmKDE8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBlPTAsZj1BcnJheShhcmd1bWVudHMubGVuZ3RoLTEpO2U8Zi5sZW5ndGg7KWZbZV09YXJndW1lbnRzW2UrMV0sKytlO2U9bmV3IEYoZiwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsYSxlKX1mdW5jdGlvbiBiKGEsYil7Zm9yKHZhciBlPUQoYiksZj1udWxsLGc9MCxoPTA7OylpZihoPGcpe3ZhciBsPWYuUShudWxsLGgpO0xiKGEsbCk7aCs9MX1lbHNlIGlmKGU9RChlKSlmPWUsZmQoZik/KGU9WWIoZiksZz1aYihmKSxmPWUsbD1RKGUpLGU9ZyxnPWwpOihsPUcoZiksTGIoYSxsKSxlPUsoZiksZj1udWxsLGc9MCksaD0wO2Vsc2UgcmV0dXJuIG51bGx9YS5pPTE7YS5mPWZ1bmN0aW9uKGEpe3ZhciBkPUcoYSk7YT1IKGEpO3JldHVybiBiKGQsYSl9O2EuZD1iO3JldHVybiBhfSgpLHloPXsnXCInOidcXFxcXCInLFwiXFxcXFwiOlwiXFxcXFxcXFxcIixcIlxcYlwiOlwiXFxcXGJcIixcIlxcZlwiOlwiXFxcXGZcIixcblwiXFxuXCI6XCJcXFxcblwiLFwiXFxyXCI6XCJcXFxcclwiLFwiXFx0XCI6XCJcXFxcdFwifTtmdW5jdGlvbiB6aChhKXtyZXR1cm5beignXCInKSx6KGEucmVwbGFjZShSZWdFeHAoJ1tcXFxcXFxcXFwiXFxiXFxmXFxuXFxyXFx0XScsXCJnXCIpLGZ1bmN0aW9uKGEpe3JldHVybiB5aFthXX0pKSx6KCdcIicpXS5qb2luKFwiXCIpfVxudmFyICQ9ZnVuY3Rpb24gQWgoYixjLGQpe2lmKG51bGw9PWIpcmV0dXJuIExiKGMsXCJuaWxcIik7aWYodm9pZCAwPT09YilyZXR1cm4gTGIoYyxcIiNcXHgzY3VuZGVmaW5lZFxceDNlXCIpO3QoZnVuY3Rpb24oKXt2YXIgYz1TLmEoZCx3YSk7cmV0dXJuIHQoYyk/KGM9Yj9iLmomMTMxMDcyfHxiLmtjPyEwOmIuaj8hMTp3KHJiLGIpOncocmIsYikpP1ZjKGIpOmM6Y30oKSkmJihMYihjLFwiXlwiKSxBaChWYyhiKSxjLGQpLExiKGMsXCIgXCIpKTtpZihudWxsPT1iKXJldHVybiBMYihjLFwibmlsXCIpO2lmKGIuWWIpcmV0dXJuIGIubmMoYyk7aWYoYiYmKGIuaiYyMTQ3NDgzNjQ4fHxiLkkpKXJldHVybiBiLnYobnVsbCxjLGQpO2lmKEJhKGIpPT09Qm9vbGVhbnx8XCJudW1iZXJcIj09PXR5cGVvZiBiKXJldHVybiBMYihjLFwiXCIreihiKSk7aWYobnVsbCE9YiYmYi5jb25zdHJ1Y3Rvcj09PU9iamVjdCl7TGIoYyxcIiNqcyBcIik7dmFyIGU9T2UuYShmdW5jdGlvbihjKXtyZXR1cm4gbmV3IFcobnVsbCwyLDUsXG51ZixbUGQuYihjKSxiW2NdXSxudWxsKX0sZ2QoYikpO3JldHVybiBCaC5uP0JoLm4oZSxBaCxjLGQpOkJoLmNhbGwobnVsbCxlLEFoLGMsZCl9cmV0dXJuIGIgaW5zdGFuY2VvZiBBcnJheT93aChjLEFoLFwiI2pzIFtcIixcIiBcIixcIl1cIixkLGIpOnQoXCJzdHJpbmdcIj09dHlwZW9mIGIpP3QodWEuYihkKSk/TGIoYyx6aChiKSk6TGIoYyxiKTpUYyhiKT94aC5kKGMsS2MoW1wiI1xceDNjXCIsXCJcIit6KGIpLFwiXFx4M2VcIl0sMCkpOmIgaW5zdGFuY2VvZiBEYXRlPyhlPWZ1bmN0aW9uKGIsYyl7Zm9yKHZhciBkPVwiXCIreihiKTs7KWlmKFEoZCk8YylkPVt6KFwiMFwiKSx6KGQpXS5qb2luKFwiXCIpO2Vsc2UgcmV0dXJuIGR9LHhoLmQoYyxLYyhbJyNpbnN0IFwiJyxcIlwiK3ooYi5nZXRVVENGdWxsWWVhcigpKSxcIi1cIixlKGIuZ2V0VVRDTW9udGgoKSsxLDIpLFwiLVwiLGUoYi5nZXRVVENEYXRlKCksMiksXCJUXCIsZShiLmdldFVUQ0hvdXJzKCksMiksXCI6XCIsZShiLmdldFVUQ01pbnV0ZXMoKSwyKSxcIjpcIixlKGIuZ2V0VVRDU2Vjb25kcygpLFxuMiksXCIuXCIsZShiLmdldFVUQ01pbGxpc2Vjb25kcygpLDMpLFwiLVwiLCcwMDowMFwiJ10sMCkpKTpiIGluc3RhbmNlb2YgUmVnRXhwP3hoLmQoYyxLYyhbJyNcIicsYi5zb3VyY2UsJ1wiJ10sMCkpOihiP2IuaiYyMTQ3NDgzNjQ4fHxiLkl8fChiLmo/MDp3KE1iLGIpKTp3KE1iLGIpKT9OYihiLGMsZCk6eGguZChjLEtjKFtcIiNcXHgzY1wiLFwiXCIreihiKSxcIlxceDNlXCJdLDApKX0sQ2g9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEpe3ZhciBkPW51bGw7aWYoMDxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGQ9MCxlPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMCk7ZDxlLmxlbmd0aDspZVtkXT1hcmd1bWVudHNbZCswXSwrK2Q7ZD1uZXcgRihlLDApfXJldHVybiBiLmNhbGwodGhpcyxkKX1mdW5jdGlvbiBiKGEpe3ZhciBiPW9hKCk7aWYoWWMoYSkpYj1cIlwiO2Vsc2V7dmFyIGU9eixmPW5ldyBmYTthOnt2YXIgZz1uZXcgZGMoZik7JChHKGEpLGcsYik7YT1EKEsoYSkpO2Zvcih2YXIgaD1udWxsLGw9MCxcbm09MDs7KWlmKG08bCl7dmFyIHA9aC5RKG51bGwsbSk7TGIoZyxcIiBcIik7JChwLGcsYik7bSs9MX1lbHNlIGlmKGE9RChhKSloPWEsZmQoaCk/KGE9WWIoaCksbD1aYihoKSxoPWEscD1RKGEpLGE9bCxsPXApOihwPUcoaCksTGIoZyxcIiBcIiksJChwLGcsYiksYT1LKGgpLGg9bnVsbCxsPTApLG09MDtlbHNlIGJyZWFrIGF9Yj1cIlwiK2UoZil9cmV0dXJuIGJ9YS5pPTA7YS5mPWZ1bmN0aW9uKGEpe2E9RChhKTtyZXR1cm4gYihhKX07YS5kPWI7cmV0dXJuIGF9KCk7ZnVuY3Rpb24gQmgoYSxiLGMsZCl7cmV0dXJuIHdoKGMsZnVuY3Rpb24oYSxjLGQpe3ZhciBoPWhiKGEpO2IuYz9iLmMoaCxjLGQpOmIuY2FsbChudWxsLGgsYyxkKTtMYihjLFwiIFwiKTthPWliKGEpO3JldHVybiBiLmM/Yi5jKGEsYyxkKTpiLmNhbGwobnVsbCxhLGMsZCl9LFwie1wiLFwiLCBcIixcIn1cIixkLEQoYSkpfU1lLnByb3RvdHlwZS5JPSEwO1xuTWUucHJvdG90eXBlLnY9ZnVuY3Rpb24oYSxiLGMpe0xiKGIsXCIjXFx4M2NWb2xhdGlsZTogXCIpOyQodGhpcy5zdGF0ZSxiLGMpO3JldHVybiBMYihiLFwiXFx4M2VcIil9O0YucHJvdG90eXBlLkk9ITA7Ri5wcm90b3R5cGUudj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIHdoKGIsJCxcIihcIixcIiBcIixcIilcIixjLHRoaXMpfTtWLnByb3RvdHlwZS5JPSEwO1YucHJvdG90eXBlLnY9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiB3aChiLCQsXCIoXCIsXCIgXCIsXCIpXCIsYyx0aGlzKX07d2cucHJvdG90eXBlLkk9ITA7d2cucHJvdG90eXBlLnY9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiB3aChiLCQsXCIoXCIsXCIgXCIsXCIpXCIsYyx0aGlzKX07cGcucHJvdG90eXBlLkk9ITA7cGcucHJvdG90eXBlLnY9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiB3aChiLCQsXCIoXCIsXCIgXCIsXCIpXCIsYyx0aGlzKX07Wi5wcm90b3R5cGUuST0hMDtcbloucHJvdG90eXBlLnY9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiB3aChiLCQsXCJbXCIsXCIgXCIsXCJdXCIsYyx0aGlzKX07UmYucHJvdG90eXBlLkk9ITA7UmYucHJvdG90eXBlLnY9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiB3aChiLCQsXCIoXCIsXCIgXCIsXCIpXCIsYyx0aGlzKX07Y2gucHJvdG90eXBlLkk9ITA7Y2gucHJvdG90eXBlLnY9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiB3aChiLCQsXCIje1wiLFwiIFwiLFwifVwiLGMsdGhpcyl9O0JmLnByb3RvdHlwZS5JPSEwO0JmLnByb3RvdHlwZS52PWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gd2goYiwkLFwiKFwiLFwiIFwiLFwiKVwiLGMsdGhpcyl9O0xkLnByb3RvdHlwZS5JPSEwO0xkLnByb3RvdHlwZS52PWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gd2goYiwkLFwiKFwiLFwiIFwiLFwiKVwiLGMsdGhpcyl9O0hjLnByb3RvdHlwZS5JPSEwO0hjLnByb3RvdHlwZS52PWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gd2goYiwkLFwiKFwiLFwiIFwiLFwiKVwiLGMsdGhpcyl9O1xucmcucHJvdG90eXBlLkk9ITA7cmcucHJvdG90eXBlLnY9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBCaCh0aGlzLCQsYixjKX07cWcucHJvdG90eXBlLkk9ITA7cWcucHJvdG90eXBlLnY9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiB3aChiLCQsXCIoXCIsXCIgXCIsXCIpXCIsYyx0aGlzKX07RGYucHJvdG90eXBlLkk9ITA7RGYucHJvdG90eXBlLnY9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiB3aChiLCQsXCJbXCIsXCIgXCIsXCJdXCIsYyx0aGlzKX07TGcucHJvdG90eXBlLkk9ITA7TGcucHJvdG90eXBlLnY9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBCaCh0aGlzLCQsYixjKX07JGcucHJvdG90eXBlLkk9ITA7JGcucHJvdG90eXBlLnY9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiB3aChiLCQsXCIje1wiLFwiIFwiLFwifVwiLGMsdGhpcyl9O1ZkLnByb3RvdHlwZS5JPSEwO1ZkLnByb3RvdHlwZS52PWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gd2goYiwkLFwiKFwiLFwiIFwiLFwiKVwiLGMsdGhpcyl9O1VnLnByb3RvdHlwZS5JPSEwO1xuVWcucHJvdG90eXBlLnY9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiB3aChiLCQsXCIoXCIsXCIgXCIsXCIpXCIsYyx0aGlzKX07WC5wcm90b3R5cGUuST0hMDtYLnByb3RvdHlwZS52PWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gd2goYiwkLFwiW1wiLFwiIFwiLFwiXVwiLGMsdGhpcyl9O1cucHJvdG90eXBlLkk9ITA7Vy5wcm90b3R5cGUudj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIHdoKGIsJCxcIltcIixcIiBcIixcIl1cIixjLHRoaXMpfTtLZi5wcm90b3R5cGUuST0hMDtLZi5wcm90b3R5cGUudj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIHdoKGIsJCxcIihcIixcIiBcIixcIilcIixjLHRoaXMpfTtIZC5wcm90b3R5cGUuST0hMDtIZC5wcm90b3R5cGUudj1mdW5jdGlvbihhLGIpe3JldHVybiBMYihiLFwiKClcIil9O3plLnByb3RvdHlwZS5JPSEwO3plLnByb3RvdHlwZS52PWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gd2goYiwkLFwiKFwiLFwiIFwiLFwiKVwiLGMsdGhpcyl9O0xmLnByb3RvdHlwZS5JPSEwO1xuTGYucHJvdG90eXBlLnY9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiB3aChiLCQsXCIjcXVldWUgW1wiLFwiIFwiLFwiXVwiLGMsRCh0aGlzKSl9O3BhLnByb3RvdHlwZS5JPSEwO3BhLnByb3RvdHlwZS52PWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gQmgodGhpcywkLGIsYyl9O3BoLnByb3RvdHlwZS5JPSEwO3BoLnByb3RvdHlwZS52PWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gd2goYiwkLFwiKFwiLFwiIFwiLFwiKVwiLGMsdGhpcyl9O1NnLnByb3RvdHlwZS5JPSEwO1NnLnByb3RvdHlwZS52PWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gd2goYiwkLFwiKFwiLFwiIFwiLFwiKVwiLGMsdGhpcyl9O0ZkLnByb3RvdHlwZS5JPSEwO0ZkLnByb3RvdHlwZS52PWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gd2goYiwkLFwiKFwiLFwiIFwiLFwiKVwiLGMsdGhpcyl9O1cucHJvdG90eXBlLnNiPSEwO1cucHJvdG90eXBlLnRiPWZ1bmN0aW9uKGEsYil7cmV0dXJuIHBkLmEodGhpcyxiKX07RGYucHJvdG90eXBlLnNiPSEwO1xuRGYucHJvdG90eXBlLnRiPWZ1bmN0aW9uKGEsYil7cmV0dXJuIHBkLmEodGhpcyxiKX07VS5wcm90b3R5cGUuc2I9ITA7VS5wcm90b3R5cGUudGI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gTWQodGhpcyxiKX07cWMucHJvdG90eXBlLnNiPSEwO3FjLnByb3RvdHlwZS50Yj1mdW5jdGlvbihhLGIpe3JldHVybiBwYyh0aGlzLGIpfTt2YXIgRGg9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsZCxlKXt2YXIgZj1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBmPTAsZz1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2Y8Zy5sZW5ndGg7KWdbZl09YXJndW1lbnRzW2YrMl0sKytmO2Y9bmV3IEYoZywwKX1yZXR1cm4gYi5jYWxsKHRoaXMsYSxkLGYpfWZ1bmN0aW9uIGIoYSxiLGUpe3JldHVybiBhLms9VC5jKGIsYS5rLGUpfWEuaT0yO2EuZj1mdW5jdGlvbihhKXt2YXIgZD1HKGEpO2E9SyhhKTt2YXIgZT1HKGEpO2E9SChhKTtyZXR1cm4gYihkLGUsYSl9O2EuZD1iO3JldHVybiBhfSgpO1xuZnVuY3Rpb24gRWgoYSl7cmV0dXJuIGZ1bmN0aW9uKGIsYyl7dmFyIGQ9YS5hP2EuYShiLGMpOmEuY2FsbChudWxsLGIsYyk7cmV0dXJuIEFjKGQpP25ldyB5YyhkKTpkfX1cbmZ1bmN0aW9uIFZlKGEpe3JldHVybiBmdW5jdGlvbihiKXtyZXR1cm4gZnVuY3Rpb24oKXtmdW5jdGlvbiBjKGEsYyl7cmV0dXJuIEEuYyhiLGEsYyl9ZnVuY3Rpb24gZChiKXtyZXR1cm4gYS5iP2EuYihiKTphLmNhbGwobnVsbCxiKX1mdW5jdGlvbiBlKCl7cmV0dXJuIGEubD9hLmwoKTphLmNhbGwobnVsbCl9dmFyIGY9bnVsbCxmPWZ1bmN0aW9uKGEsYil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMDpyZXR1cm4gZS5jYWxsKHRoaXMpO2Nhc2UgMTpyZXR1cm4gZC5jYWxsKHRoaXMsYSk7Y2FzZSAyOnJldHVybiBjLmNhbGwodGhpcyxhLGIpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtmLmw9ZTtmLmI9ZDtmLmE9YztyZXR1cm4gZn0oKX0oRWgoYSkpfVxudmFyIEZoPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhKXtyZXR1cm4gQ2UuYShjLmwoKSxhKX1mdW5jdGlvbiBiKCl7cmV0dXJuIGZ1bmN0aW9uKGEpe3JldHVybiBmdW5jdGlvbihiKXtyZXR1cm4gZnVuY3Rpb24oKXtmdW5jdGlvbiBjKGYsZyl7dmFyIGg9TC5iP0wuYihiKTpMLmNhbGwobnVsbCxiKTthYyhiLGcpO3JldHVybiBzYy5hKGgsZyk/ZjphLmE/YS5hKGYsZyk6YS5jYWxsKG51bGwsZixnKX1mdW5jdGlvbiBnKGIpe3JldHVybiBhLmI/YS5iKGIpOmEuY2FsbChudWxsLGIpfWZ1bmN0aW9uIGgoKXtyZXR1cm4gYS5sP2EubCgpOmEuY2FsbChudWxsKX12YXIgbD1udWxsLGw9ZnVuY3Rpb24oYSxiKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAwOnJldHVybiBoLmNhbGwodGhpcyk7Y2FzZSAxOnJldHVybiBnLmNhbGwodGhpcyxhKTtjYXNlIDI6cmV0dXJuIGMuY2FsbCh0aGlzLGEsYil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTtcbn07bC5sPWg7bC5iPWc7bC5hPWM7cmV0dXJuIGx9KCl9KG5ldyBNZShzaCkpfX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMDpyZXR1cm4gYi5jYWxsKHRoaXMpO2Nhc2UgMTpyZXR1cm4gYS5jYWxsKHRoaXMsYyl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MubD1iO2MuYj1hO3JldHVybiBjfSgpO2Z1bmN0aW9uIEdoKGEsYil7dGhpcy5mYT1hO3RoaXMuWmI9Yjt0aGlzLnE9MDt0aGlzLmo9MjE3MzE3Mzc2MH1HaC5wcm90b3R5cGUudj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIHdoKGIsJCxcIihcIixcIiBcIixcIilcIixjLHRoaXMpfTtHaC5wcm90b3R5cGUuTz1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIHdkLm4odGhpcy5mYSxiLGMsdGhpcy5aYil9O0doLnByb3RvdHlwZS5EPWZ1bmN0aW9uKCl7cmV0dXJuIEQoQ2UuYSh0aGlzLmZhLHRoaXMuWmIpKX07R2gucHJvdG90eXBlW0VhXT1mdW5jdGlvbigpe3JldHVybiB1Yyh0aGlzKX07XG52YXIgSGg9e307ZnVuY3Rpb24gSWgoYSl7aWYoYT9hLmdjOmEpcmV0dXJuIGEuZ2MoYSk7dmFyIGI7Yj1JaFtuKG51bGw9PWE/bnVsbDphKV07aWYoIWImJihiPUloLl8sIWIpKXRocm93IHgoXCJJRW5jb2RlSlMuLWNsai1cXHgzZWpzXCIsYSk7cmV0dXJuIGIuY2FsbChudWxsLGEpfWZ1bmN0aW9uIEpoKGEpe3JldHVybihhP3QodChudWxsKT9udWxsOmEuZmMpfHwoYS55Yj8wOncoSGgsYSkpOncoSGgsYSkpP0loKGEpOlwic3RyaW5nXCI9PT10eXBlb2YgYXx8XCJudW1iZXJcIj09PXR5cGVvZiBhfHxhIGluc3RhbmNlb2YgVXx8YSBpbnN0YW5jZW9mIHFjP0toLmI/S2guYihhKTpLaC5jYWxsKG51bGwsYSk6Q2guZChLYyhbYV0sMCkpfVxudmFyIEtoPWZ1bmN0aW9uIExoKGIpe2lmKG51bGw9PWIpcmV0dXJuIG51bGw7aWYoYj90KHQobnVsbCk/bnVsbDpiLmZjKXx8KGIueWI/MDp3KEhoLGIpKTp3KEhoLGIpKXJldHVybiBJaChiKTtpZihiIGluc3RhbmNlb2YgVSlyZXR1cm4gT2QoYik7aWYoYiBpbnN0YW5jZW9mIHFjKXJldHVyblwiXCIreihiKTtpZihkZChiKSl7dmFyIGM9e307Yj1EKGIpO2Zvcih2YXIgZD1udWxsLGU9MCxmPTA7OylpZihmPGUpe3ZhciBnPWQuUShudWxsLGYpLGg9Ui5jKGcsMCxudWxsKSxnPVIuYyhnLDEsbnVsbCk7Y1tKaChoKV09TGgoZyk7Zis9MX1lbHNlIGlmKGI9RChiKSlmZChiKT8oZT1ZYihiKSxiPVpiKGIpLGQ9ZSxlPVEoZSkpOihlPUcoYiksZD1SLmMoZSwwLG51bGwpLGU9Ui5jKGUsMSxudWxsKSxjW0poKGQpXT1MaChlKSxiPUsoYiksZD1udWxsLGU9MCksZj0wO2Vsc2UgYnJlYWs7cmV0dXJuIGN9aWYoJGMoYikpe2M9W107Yj1EKE9lLmEoTGgsYikpO2Q9bnVsbDtmb3IoZj1lPTA7OylpZihmPFxuZSloPWQuUShudWxsLGYpLGMucHVzaChoKSxmKz0xO2Vsc2UgaWYoYj1EKGIpKWQ9YixmZChkKT8oYj1ZYihkKSxmPVpiKGQpLGQ9YixlPVEoYiksYj1mKTooYj1HKGQpLGMucHVzaChiKSxiPUsoZCksZD1udWxsLGU9MCksZj0wO2Vsc2UgYnJlYWs7cmV0dXJuIGN9cmV0dXJuIGJ9LE1oPXt9O2Z1bmN0aW9uIE5oKGEsYil7aWYoYT9hLmVjOmEpcmV0dXJuIGEuZWMoYSxiKTt2YXIgYztjPU5oW24obnVsbD09YT9udWxsOmEpXTtpZighYyYmKGM9TmguXywhYykpdGhyb3cgeChcIklFbmNvZGVDbG9qdXJlLi1qcy1cXHgzZWNsalwiLGEpO3JldHVybiBjLmNhbGwobnVsbCxhLGIpfVxudmFyIFBoPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhKXtyZXR1cm4gYi5kKGEsS2MoW25ldyBwYShudWxsLDEsW09oLCExXSxudWxsKV0sMCkpfXZhciBiPW51bGwsYz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYyxkKXt2YXIgaD1udWxsO2lmKDE8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBoPTAsbD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTEpO2g8bC5sZW5ndGg7KWxbaF09YXJndW1lbnRzW2grMV0sKytoO2g9bmV3IEYobCwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsYyxoKX1mdW5jdGlvbiBiKGEsYyl7dmFyIGQ9a2QoYyk/VC5hKE9nLGMpOmMsZT1TLmEoZCxPaCk7cmV0dXJuIGZ1bmN0aW9uKGEsYixkLGUpe3JldHVybiBmdW5jdGlvbiB2KGYpe3JldHVybihmP3QodChudWxsKT9udWxsOmYudWMpfHwoZi55Yj8wOncoTWgsZikpOncoTWgsZikpP05oKGYsVC5hKFBnLGMpKTprZChmKT92aC5iKE9lLmEodixmKSk6JGMoZik/YWYuYShPYyhmKSxPZS5hKHYsZikpOmYgaW5zdGFuY2VvZlxuQXJyYXk/emYoT2UuYSh2LGYpKTpCYShmKT09PU9iamVjdD9hZi5hKFVmLGZ1bmN0aW9uKCl7cmV0dXJuIGZ1bmN0aW9uKGEsYixjLGQpe3JldHVybiBmdW5jdGlvbiBQYShlKXtyZXR1cm4gbmV3IFYobnVsbCxmdW5jdGlvbihhLGIsYyxkKXtyZXR1cm4gZnVuY3Rpb24oKXtmb3IoOzspe3ZhciBhPUQoZSk7aWYoYSl7aWYoZmQoYSkpe3ZhciBiPVliKGEpLGM9UShiKSxnPVRkKGMpO3JldHVybiBmdW5jdGlvbigpe2Zvcih2YXIgYT0wOzspaWYoYTxjKXt2YXIgZT1DLmEoYixhKSxoPWcsbD11ZixtO209ZTttPWQuYj9kLmIobSk6ZC5jYWxsKG51bGwsbSk7ZT1uZXcgVyhudWxsLDIsNSxsLFttLHYoZltlXSldLG51bGwpO2guYWRkKGUpO2ErPTF9ZWxzZSByZXR1cm4hMH0oKT9XZChnLmNhKCksUGEoWmIoYSkpKTpXZChnLmNhKCksbnVsbCl9dmFyIGg9RyhhKTtyZXR1cm4gTShuZXcgVyhudWxsLDIsNSx1ZixbZnVuY3Rpb24oKXt2YXIgYT1oO3JldHVybiBkLmI/ZC5iKGEpOmQuY2FsbChudWxsLFxuYSl9KCksdihmW2hdKV0sbnVsbCksUGEoSChhKSkpfXJldHVybiBudWxsfX19KGEsYixjLGQpLG51bGwsbnVsbCl9fShhLGIsZCxlKShnZChmKSl9KCkpOmZ9fShjLGQsZSx0KGUpP1BkOnopKGEpfWEuaT0xO2EuZj1mdW5jdGlvbihhKXt2YXIgYz1HKGEpO2E9SChhKTtyZXR1cm4gYihjLGEpfTthLmQ9YjtyZXR1cm4gYX0oKSxiPWZ1bmN0aW9uKGIsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYS5jYWxsKHRoaXMsYik7ZGVmYXVsdDp2YXIgZj1udWxsO2lmKDE8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBmPTAsZz1BcnJheShhcmd1bWVudHMubGVuZ3RoLTEpO2Y8Zy5sZW5ndGg7KWdbZl09YXJndW1lbnRzW2YrMV0sKytmO2Y9bmV3IEYoZywwKX1yZXR1cm4gYy5kKGIsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2IuaT0xO2IuZj1jLmY7Yi5iPWE7Yi5kPWMuZDtyZXR1cm4gYn0oKTt2YXIgd2E9bmV3IFUobnVsbCxcIm1ldGFcIixcIm1ldGFcIiwxNDk5NTM2OTY0KSx5YT1uZXcgVShudWxsLFwiZHVwXCIsXCJkdXBcIiw1NTYyOTg1MzMpLHNoPW5ldyBVKFwiY2xqcy5jb3JlXCIsXCJub25lXCIsXCJjbGpzLmNvcmUvbm9uZVwiLDkyNjY0NjQzOSkscGU9bmV3IFUobnVsbCxcImZpbGVcIixcImZpbGVcIiwtMTI2OTY0NTg3OCksbGU9bmV3IFUobnVsbCxcImVuZC1jb2x1bW5cIixcImVuZC1jb2x1bW5cIiwxNDI1Mzg5NTE0KSxzYT1uZXcgVShudWxsLFwiZmx1c2gtb24tbmV3bGluZVwiLFwiZmx1c2gtb24tbmV3bGluZVwiLC0xNTE0NTc5MzkpLG5lPW5ldyBVKG51bGwsXCJjb2x1bW5cIixcImNvbHVtblwiLDIwNzgyMjIwOTUpLHVhPW5ldyBVKG51bGwsXCJyZWFkYWJseVwiLFwicmVhZGFibHlcIiwxMTI5NTk5NzYwKSxvZT1uZXcgVShudWxsLFwibGluZVwiLFwibGluZVwiLDIxMjM0NTIzNSksemE9bmV3IFUobnVsbCxcInByaW50LWxlbmd0aFwiLFwicHJpbnQtbGVuZ3RoXCIsMTkzMTg2NjM1NiksbWU9bmV3IFUobnVsbCxcImVuZC1saW5lXCIsXG5cImVuZC1saW5lXCIsMTgzNzMyNjQ1NSksT2g9bmV3IFUobnVsbCxcImtleXdvcmRpemUta2V5c1wiLFwia2V5d29yZGl6ZS1rZXlzXCIsMTMxMDc4NDI1MiksWmc9bmV3IFUoXCJjbGpzLmNvcmVcIixcIm5vdC1mb3VuZFwiLFwiY2xqcy5jb3JlL25vdC1mb3VuZFwiLC0xNTcyODg5MTg1KTtmdW5jdGlvbiBRaChhLGIpe3ZhciBjPVQuYyhpaCxhLGIpO3JldHVybiBNKGMsWWUuYShmdW5jdGlvbihhKXtyZXR1cm4gZnVuY3Rpb24oYil7cmV0dXJuIGE9PT1ifX0oYyksYikpfVxudmFyIFJoPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIpe3JldHVybiBRKGEpPFEoYik/QS5jKE5jLGIsYSk6QS5jKE5jLGEsYil9dmFyIGI9bnVsbCxjPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShjLGQsaCl7dmFyIGw9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgbD0wLG09QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtsPG0ubGVuZ3RoOyltW2xdPWFyZ3VtZW50c1tsKzJdLCsrbDtsPW5ldyBGKG0sMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGMsZCxsKX1mdW5jdGlvbiBiKGEsYyxkKXthPVFoKFEsTmMuZChkLGMsS2MoW2FdLDApKSk7cmV0dXJuIEEuYyhhZixHKGEpLEgoYSkpfWEuaT0yO2EuZj1mdW5jdGlvbihhKXt2YXIgYz1HKGEpO2E9SyhhKTt2YXIgZD1HKGEpO2E9SChhKTtyZXR1cm4gYihjLGQsYSl9O2EuZD1iO3JldHVybiBhfSgpLGI9ZnVuY3Rpb24oYixlLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDA6cmV0dXJuIGJoO2Nhc2UgMTpyZXR1cm4gYjtcbmNhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYixlKTtkZWZhdWx0OnZhciBnPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGc9MCxoPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7ZzxoLmxlbmd0aDspaFtnXT1hcmd1bWVudHNbZysyXSwrK2c7Zz1uZXcgRihoLDApfXJldHVybiBjLmQoYixlLGcpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtiLmk9MjtiLmY9Yy5mO2IubD1mdW5jdGlvbigpe3JldHVybiBiaH07Yi5iPWZ1bmN0aW9uKGEpe3JldHVybiBhfTtiLmE9YTtiLmQ9Yy5kO3JldHVybiBifSgpLFNoPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIpe2Zvcig7OylpZihRKGIpPFEoYSkpe3ZhciBjPWE7YT1iO2I9Y31lbHNlIHJldHVybiBBLmMoZnVuY3Rpb24oYSxiKXtyZXR1cm4gZnVuY3Rpb24oYSxjKXtyZXR1cm4gbmQoYixjKT9hOlhjLmEoYSxjKX19KGEsYiksYSxhKX12YXIgYj1udWxsLGM9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGIsXG5kLGgpe3ZhciBsPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGw9MCxtPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7bDxtLmxlbmd0aDspbVtsXT1hcmd1bWVudHNbbCsyXSwrK2w7bD1uZXcgRihtLDApfXJldHVybiBjLmNhbGwodGhpcyxiLGQsbCl9ZnVuY3Rpb24gYyhhLGQsZSl7YT1RaChmdW5jdGlvbihhKXtyZXR1cm4tUShhKX0sTmMuZChlLGQsS2MoW2FdLDApKSk7cmV0dXJuIEEuYyhiLEcoYSksSChhKSl9YS5pPTI7YS5mPWZ1bmN0aW9uKGEpe3ZhciBiPUcoYSk7YT1LKGEpO3ZhciBkPUcoYSk7YT1IKGEpO3JldHVybiBjKGIsZCxhKX07YS5kPWM7cmV0dXJuIGF9KCksYj1mdW5jdGlvbihiLGUsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYjtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGIsZSk7ZGVmYXVsdDp2YXIgZz1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBnPTAsaD1BcnJheShhcmd1bWVudHMubGVuZ3RoLVxuMik7ZzxoLmxlbmd0aDspaFtnXT1hcmd1bWVudHNbZysyXSwrK2c7Zz1uZXcgRihoLDApfXJldHVybiBjLmQoYixlLGcpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtiLmk9MjtiLmY9Yy5mO2IuYj1mdW5jdGlvbihhKXtyZXR1cm4gYX07Yi5hPWE7Yi5kPWMuZDtyZXR1cm4gYn0oKSxUaD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiKXtyZXR1cm4gUShhKTxRKGIpP0EuYyhmdW5jdGlvbihhLGMpe3JldHVybiBuZChiLGMpP1hjLmEoYSxjKTphfSxhLGEpOkEuYyhYYyxhLGIpfXZhciBiPW51bGwsYz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYixkLGgpe3ZhciBsPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGw9MCxtPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7bDxtLmxlbmd0aDspbVtsXT1hcmd1bWVudHNbbCsyXSwrK2w7bD1uZXcgRihtLDApfXJldHVybiBjLmNhbGwodGhpcyxiLGQsbCl9ZnVuY3Rpb24gYyhhLGQsXG5lKXtyZXR1cm4gQS5jKGIsYSxOYy5hKGUsZCkpfWEuaT0yO2EuZj1mdW5jdGlvbihhKXt2YXIgYj1HKGEpO2E9SyhhKTt2YXIgZD1HKGEpO2E9SChhKTtyZXR1cm4gYyhiLGQsYSl9O2EuZD1jO3JldHVybiBhfSgpLGI9ZnVuY3Rpb24oYixlLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGI7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxiLGUpO2RlZmF1bHQ6dmFyIGc9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZz0wLGg9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtnPGgubGVuZ3RoOyloW2ddPWFyZ3VtZW50c1tnKzJdLCsrZztnPW5ldyBGKGgsMCl9cmV0dXJuIGMuZChiLGUsZyl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2IuaT0yO2IuZj1jLmY7Yi5iPWZ1bmN0aW9uKGEpe3JldHVybiBhfTtiLmE9YTtiLmQ9Yy5kO3JldHVybiBifSgpO1xuZnVuY3Rpb24gVWgoYSxiKXtyZXR1cm4gQS5jKGZ1bmN0aW9uKGIsZCl7dmFyIGU9Ui5jKGQsMCxudWxsKSxmPVIuYyhkLDEsbnVsbCk7cmV0dXJuIG5kKGEsZSk/UmMuYyhiLGYsUy5hKGEsZSkpOmJ9LFQuYyhTYyxhLFRnKGIpKSxiKX1mdW5jdGlvbiBWaChhLGIpe3JldHVybiBBLmMoZnVuY3Rpb24oYSxkKXt2YXIgZT1ZZyhkLGIpO3JldHVybiBSYy5jKGEsZSxOYy5hKFMuYyhhLGUsYmgpLGQpKX0sVWYsYSl9ZnVuY3Rpb24gV2goYSl7cmV0dXJuIEEuYyhmdW5jdGlvbihhLGMpe3ZhciBkPVIuYyhjLDAsbnVsbCksZT1SLmMoYywxLG51bGwpO3JldHVybiBSYy5jKGEsZSxkKX0sVWYsYSl9XG52YXIgWGg9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjKXthPVEoYSk8PVEoYik/bmV3IFcobnVsbCwzLDUsdWYsW2EsYixXaChjKV0sbnVsbCk6bmV3IFcobnVsbCwzLDUsdWYsW2IsYSxjXSxudWxsKTtiPVIuYyhhLDAsbnVsbCk7Yz1SLmMoYSwxLG51bGwpO3ZhciBnPVIuYyhhLDIsbnVsbCksaD1WaChiLFZnKGcpKTtyZXR1cm4gQS5jKGZ1bmN0aW9uKGEsYixjLGQsZSl7cmV0dXJuIGZ1bmN0aW9uKGYsZyl7dmFyIGg9ZnVuY3Rpb24oKXt2YXIgYT1VaChZZyhnLFRnKGQpKSxkKTtyZXR1cm4gZS5iP2UuYihhKTplLmNhbGwobnVsbCxhKX0oKTtyZXR1cm4gdChoKT9BLmMoZnVuY3Rpb24oKXtyZXR1cm4gZnVuY3Rpb24oYSxiKXtyZXR1cm4gTmMuYShhLFdnLmQoS2MoW2IsZ10sMCkpKX19KGgsYSxiLGMsZCxlKSxmLGgpOmZ9fShhLGIsYyxnLGgpLGJoLGMpfWZ1bmN0aW9uIGIoYSxiKXtpZihEKGEpJiZEKGIpKXt2YXIgYz1TaC5hKGZoKFRnKEcoYSkpKSxmaChUZyhHKGIpKSkpLFxuZz1RKGEpPD1RKGIpP25ldyBXKG51bGwsMiw1LHVmLFthLGJdLG51bGwpOm5ldyBXKG51bGwsMiw1LHVmLFtiLGFdLG51bGwpLGg9Ui5jKGcsMCxudWxsKSxsPVIuYyhnLDEsbnVsbCksbT1WaChoLGMpO3JldHVybiBBLmMoZnVuY3Rpb24oYSxiLGMsZCxlKXtyZXR1cm4gZnVuY3Rpb24oZixnKXt2YXIgaD1mdW5jdGlvbigpe3ZhciBiPVlnKGcsYSk7cmV0dXJuIGUuYj9lLmIoYik6ZS5jYWxsKG51bGwsYil9KCk7cmV0dXJuIHQoaCk/QS5jKGZ1bmN0aW9uKCl7cmV0dXJuIGZ1bmN0aW9uKGEsYil7cmV0dXJuIE5jLmEoYSxXZy5kKEtjKFtiLGddLDApKSl9fShoLGEsYixjLGQsZSksZixoKTpmfX0oYyxnLGgsbCxtKSxiaCxsKX1yZXR1cm4gYmh9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiBiLmNhbGwodGhpcyxjLGUpO2Nhc2UgMzpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrXG5hcmd1bWVudHMubGVuZ3RoKTt9O2MuYT1iO2MuYz1hO3JldHVybiBjfSgpO3IoXCJtb3JpLmFwcGx5XCIsVCk7cihcIm1vcmkuYXBwbHkuZjJcIixULmEpO3IoXCJtb3JpLmFwcGx5LmYzXCIsVC5jKTtyKFwibW9yaS5hcHBseS5mNFwiLFQubik7cihcIm1vcmkuYXBwbHkuZjVcIixULnIpO3IoXCJtb3JpLmFwcGx5LmZuXCIsVC5LKTtyKFwibW9yaS5jb3VudFwiLFEpO3IoXCJtb3JpLmRpc3RpbmN0XCIsZnVuY3Rpb24oYSl7cmV0dXJuIGZ1bmN0aW9uIGMoYSxlKXtyZXR1cm4gbmV3IFYobnVsbCxmdW5jdGlvbigpe3JldHVybiBmdW5jdGlvbihhLGQpe2Zvcig7Oyl7dmFyIGU9YSxsPVIuYyhlLDAsbnVsbCk7aWYoZT1EKGUpKWlmKG5kKGQsbCkpbD1IKGUpLGU9ZCxhPWwsZD1lO2Vsc2UgcmV0dXJuIE0obCxjKEgoZSksTmMuYShkLGwpKSk7ZWxzZSByZXR1cm4gbnVsbH19LmNhbGwobnVsbCxhLGUpfSxudWxsLG51bGwpfShhLGJoKX0pO3IoXCJtb3JpLmVtcHR5XCIsT2MpO3IoXCJtb3JpLmZpcnN0XCIsRyk7cihcIm1vcmkuc2Vjb25kXCIsTGMpO3IoXCJtb3JpLm5leHRcIixLKTtcbnIoXCJtb3JpLnJlc3RcIixIKTtyKFwibW9yaS5zZXFcIixEKTtyKFwibW9yaS5jb25qXCIsTmMpO3IoXCJtb3JpLmNvbmouZjBcIixOYy5sKTtyKFwibW9yaS5jb25qLmYxXCIsTmMuYik7cihcIm1vcmkuY29uai5mMlwiLE5jLmEpO3IoXCJtb3JpLmNvbmouZm5cIixOYy5LKTtyKFwibW9yaS5jb25zXCIsTSk7cihcIm1vcmkuZmluZFwiLGZ1bmN0aW9uKGEsYil7cmV0dXJuIG51bGwhPWEmJmJkKGEpJiZuZChhLGIpP25ldyBXKG51bGwsMiw1LHVmLFtiLFMuYShhLGIpXSxudWxsKTpudWxsfSk7cihcIm1vcmkubnRoXCIsUik7cihcIm1vcmkubnRoLmYyXCIsUi5hKTtyKFwibW9yaS5udGguZjNcIixSLmMpO3IoXCJtb3JpLmxhc3RcIixmdW5jdGlvbihhKXtmb3IoOzspe3ZhciBiPUsoYSk7aWYobnVsbCE9YilhPWI7ZWxzZSByZXR1cm4gRyhhKX19KTtyKFwibW9yaS5hc3NvY1wiLFJjKTtyKFwibW9yaS5hc3NvYy5mM1wiLFJjLmMpO3IoXCJtb3JpLmFzc29jLmZuXCIsUmMuSyk7cihcIm1vcmkuZGlzc29jXCIsU2MpO1xucihcIm1vcmkuZGlzc29jLmYxXCIsU2MuYik7cihcIm1vcmkuZGlzc29jLmYyXCIsU2MuYSk7cihcIm1vcmkuZGlzc29jLmZuXCIsU2MuSyk7cihcIm1vcmkuZ2V0SW5cIixjZik7cihcIm1vcmkuZ2V0SW4uZjJcIixjZi5hKTtyKFwibW9yaS5nZXRJbi5mM1wiLGNmLmMpO3IoXCJtb3JpLnVwZGF0ZUluXCIsZGYpO3IoXCJtb3JpLnVwZGF0ZUluLmYzXCIsZGYuYyk7cihcIm1vcmkudXBkYXRlSW4uZjRcIixkZi5uKTtyKFwibW9yaS51cGRhdGVJbi5mNVwiLGRmLnIpO3IoXCJtb3JpLnVwZGF0ZUluLmY2XCIsZGYuUCk7cihcIm1vcmkudXBkYXRlSW4uZm5cIixkZi5LKTtyKFwibW9yaS5hc3NvY0luXCIsZnVuY3Rpb24gWWgoYixjLGQpe3ZhciBlPVIuYyhjLDAsbnVsbCk7cmV0dXJuKGM9RWQoYykpP1JjLmMoYixlLFloKFMuYShiLGUpLGMsZCkpOlJjLmMoYixlLGQpfSk7cihcIm1vcmkuZm5pbFwiLEtlKTtyKFwibW9yaS5mbmlsLmYyXCIsS2UuYSk7cihcIm1vcmkuZm5pbC5mM1wiLEtlLmMpO3IoXCJtb3JpLmZuaWwuZjRcIixLZS5uKTtcbnIoXCJtb3JpLmRpc2pcIixYYyk7cihcIm1vcmkuZGlzai5mMVwiLFhjLmIpO3IoXCJtb3JpLmRpc2ouZjJcIixYYy5hKTtyKFwibW9yaS5kaXNqLmZuXCIsWGMuSyk7cihcIm1vcmkucG9wXCIsZnVuY3Rpb24oYSl7cmV0dXJuIG51bGw9PWE/bnVsbDptYihhKX0pO3IoXCJtb3JpLnBlZWtcIixXYyk7cihcIm1vcmkuaGFzaFwiLG5jKTtyKFwibW9yaS5nZXRcIixTKTtyKFwibW9yaS5nZXQuZjJcIixTLmEpO3IoXCJtb3JpLmdldC5mM1wiLFMuYyk7cihcIm1vcmkuaGFzS2V5XCIsbmQpO3IoXCJtb3JpLmlzRW1wdHlcIixZYyk7cihcIm1vcmkucmV2ZXJzZVwiLEpkKTtyKFwibW9yaS50YWtlXCIsUGUpO3IoXCJtb3JpLnRha2UuZjFcIixQZS5iKTtyKFwibW9yaS50YWtlLmYyXCIsUGUuYSk7cihcIm1vcmkuZHJvcFwiLFFlKTtyKFwibW9yaS5kcm9wLmYxXCIsUWUuYik7cihcIm1vcmkuZHJvcC5mMlwiLFFlLmEpO3IoXCJtb3JpLnRha2VOdGhcIixyaCk7cihcIm1vcmkudGFrZU50aC5mMVwiLHJoLmIpO3IoXCJtb3JpLnRha2VOdGguZjJcIixyaC5hKTtcbnIoXCJtb3JpLnBhcnRpdGlvblwiLGJmKTtyKFwibW9yaS5wYXJ0aXRpb24uZjJcIixiZi5hKTtyKFwibW9yaS5wYXJ0aXRpb24uZjNcIixiZi5jKTtyKFwibW9yaS5wYXJ0aXRpb24uZjRcIixiZi5uKTtyKFwibW9yaS5wYXJ0aXRpb25BbGxcIixraCk7cihcIm1vcmkucGFydGl0aW9uQWxsLmYxXCIsa2guYik7cihcIm1vcmkucGFydGl0aW9uQWxsLmYyXCIsa2guYSk7cihcIm1vcmkucGFydGl0aW9uQWxsLmYzXCIsa2guYyk7cihcIm1vcmkucGFydGl0aW9uQnlcIix0aCk7cihcIm1vcmkucGFydGl0aW9uQnkuZjFcIix0aC5iKTtyKFwibW9yaS5wYXJ0aXRpb25CeS5mMlwiLHRoLmEpO3IoXCJtb3JpLml0ZXJhdGVcIixmdW5jdGlvbiBaaChiLGMpe3JldHVybiBNKGMsbmV3IFYobnVsbCxmdW5jdGlvbigpe3JldHVybiBaaChiLGIuYj9iLmIoYyk6Yi5jYWxsKG51bGwsYykpfSxudWxsLG51bGwpKX0pO3IoXCJtb3JpLmludG9cIixhZik7cihcIm1vcmkuaW50by5mMlwiLGFmLmEpO3IoXCJtb3JpLmludG8uZjNcIixhZi5jKTtcbnIoXCJtb3JpLm1lcmdlXCIsV2cpO3IoXCJtb3JpLm1lcmdlV2l0aFwiLFhnKTtyKFwibW9yaS5zdWJ2ZWNcIixDZik7cihcIm1vcmkuc3VidmVjLmYyXCIsQ2YuYSk7cihcIm1vcmkuc3VidmVjLmYzXCIsQ2YuYyk7cihcIm1vcmkudGFrZVdoaWxlXCIsbGgpO3IoXCJtb3JpLnRha2VXaGlsZS5mMVwiLGxoLmIpO3IoXCJtb3JpLnRha2VXaGlsZS5mMlwiLGxoLmEpO3IoXCJtb3JpLmRyb3BXaGlsZVwiLFJlKTtyKFwibW9yaS5kcm9wV2hpbGUuZjFcIixSZS5iKTtyKFwibW9yaS5kcm9wV2hpbGUuZjJcIixSZS5hKTtyKFwibW9yaS5ncm91cEJ5XCIsZnVuY3Rpb24oYSxiKXtyZXR1cm4gY2UoQS5jKGZ1bmN0aW9uKGIsZCl7dmFyIGU9YS5iP2EuYihkKTphLmNhbGwobnVsbCxkKTtyZXR1cm4gZWUuYyhiLGUsTmMuYShTLmMoYixlLE1jKSxkKSl9LE9iKFVmKSxiKSl9KTtyKFwibW9yaS5pbnRlcnBvc2VcIixmdW5jdGlvbihhLGIpe3JldHVybiBRZS5hKDEsVWUuYShTZS5iKGEpLGIpKX0pO3IoXCJtb3JpLmludGVybGVhdmVcIixVZSk7XG5yKFwibW9yaS5pbnRlcmxlYXZlLmYyXCIsVWUuYSk7cihcIm1vcmkuaW50ZXJsZWF2ZS5mblwiLFVlLkspO3IoXCJtb3JpLmNvbmNhdFwiLGFlKTtyKFwibW9yaS5jb25jYXQuZjBcIixhZS5sKTtyKFwibW9yaS5jb25jYXQuZjFcIixhZS5iKTtyKFwibW9yaS5jb25jYXQuZjJcIixhZS5hKTtyKFwibW9yaS5jb25jYXQuZm5cIixhZS5LKTtmdW5jdGlvbiAkZShhKXtyZXR1cm4gYSBpbnN0YW5jZW9mIEFycmF5fHxjZChhKX1yKFwibW9yaS5mbGF0dGVuXCIsZnVuY3Rpb24oYSl7cmV0dXJuIFhlLmEoZnVuY3Rpb24oYSl7cmV0dXJuISRlKGEpfSxIKFplKGEpKSl9KTtyKFwibW9yaS5sYXp5U2VxXCIsZnVuY3Rpb24oYSl7cmV0dXJuIG5ldyBWKG51bGwsYSxudWxsLG51bGwpfSk7cihcIm1vcmkua2V5c1wiLFRnKTtyKFwibW9yaS5zZWxlY3RLZXlzXCIsWWcpO3IoXCJtb3JpLnZhbHNcIixWZyk7cihcIm1vcmkucHJpbVNlcVwiLEpjKTtyKFwibW9yaS5wcmltU2VxLmYxXCIsSmMuYik7cihcIm1vcmkucHJpbVNlcS5mMlwiLEpjLmEpO1xucihcIm1vcmkubWFwXCIsT2UpO3IoXCJtb3JpLm1hcC5mMVwiLE9lLmIpO3IoXCJtb3JpLm1hcC5mMlwiLE9lLmEpO3IoXCJtb3JpLm1hcC5mM1wiLE9lLmMpO3IoXCJtb3JpLm1hcC5mNFwiLE9lLm4pO3IoXCJtb3JpLm1hcC5mblwiLE9lLkspO1xucihcIm1vcmkubWFwSW5kZXhlZFwiLGZ1bmN0aW9uKGEsYil7cmV0dXJuIGZ1bmN0aW9uIGQoYixmKXtyZXR1cm4gbmV3IFYobnVsbCxmdW5jdGlvbigpe3ZhciBnPUQoZik7aWYoZyl7aWYoZmQoZykpe2Zvcih2YXIgaD1ZYihnKSxsPVEoaCksbT1UZChsKSxwPTA7OylpZihwPGwpWGQobSxmdW5jdGlvbigpe3ZhciBkPWIrcCxmPUMuYShoLHApO3JldHVybiBhLmE/YS5hKGQsZik6YS5jYWxsKG51bGwsZCxmKX0oKSkscCs9MTtlbHNlIGJyZWFrO3JldHVybiBXZChtLmNhKCksZChiK2wsWmIoZykpKX1yZXR1cm4gTShmdW5jdGlvbigpe3ZhciBkPUcoZyk7cmV0dXJuIGEuYT9hLmEoYixkKTphLmNhbGwobnVsbCxiLGQpfSgpLGQoYisxLEgoZykpKX1yZXR1cm4gbnVsbH0sbnVsbCxudWxsKX0oMCxiKX0pO3IoXCJtb3JpLm1hcGNhdFwiLFdlKTtyKFwibW9yaS5tYXBjYXQuZjFcIixXZS5iKTtyKFwibW9yaS5tYXBjYXQuZm5cIixXZS5LKTtyKFwibW9yaS5yZWR1Y2VcIixBKTtcbnIoXCJtb3JpLnJlZHVjZS5mMlwiLEEuYSk7cihcIm1vcmkucmVkdWNlLmYzXCIsQS5jKTtyKFwibW9yaS5yZWR1Y2VLVlwiLGZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gbnVsbCE9Yz94YihjLGEsYik6Yn0pO3IoXCJtb3JpLmtlZXBcIixMZSk7cihcIm1vcmkua2VlcC5mMVwiLExlLmIpO3IoXCJtb3JpLmtlZXAuZjJcIixMZS5hKTtyKFwibW9yaS5rZWVwSW5kZXhlZFwiLE5lKTtyKFwibW9yaS5rZWVwSW5kZXhlZC5mMVwiLE5lLmIpO3IoXCJtb3JpLmtlZXBJbmRleGVkLmYyXCIsTmUuYSk7cihcIm1vcmkuZmlsdGVyXCIsWGUpO3IoXCJtb3JpLmZpbHRlci5mMVwiLFhlLmIpO3IoXCJtb3JpLmZpbHRlci5mMlwiLFhlLmEpO3IoXCJtb3JpLnJlbW92ZVwiLFllKTtyKFwibW9yaS5yZW1vdmUuZjFcIixZZS5iKTtyKFwibW9yaS5yZW1vdmUuZjJcIixZZS5hKTtyKFwibW9yaS5zb21lXCIsRmUpO3IoXCJtb3JpLmV2ZXJ5XCIsRWUpO3IoXCJtb3JpLmVxdWFsc1wiLHNjKTtyKFwibW9yaS5lcXVhbHMuZjFcIixzYy5iKTtcbnIoXCJtb3JpLmVxdWFscy5mMlwiLHNjLmEpO3IoXCJtb3JpLmVxdWFscy5mblwiLHNjLkspO3IoXCJtb3JpLnJhbmdlXCIscWgpO3IoXCJtb3JpLnJhbmdlLmYwXCIscWgubCk7cihcIm1vcmkucmFuZ2UuZjFcIixxaC5iKTtyKFwibW9yaS5yYW5nZS5mMlwiLHFoLmEpO3IoXCJtb3JpLnJhbmdlLmYzXCIscWguYyk7cihcIm1vcmkucmVwZWF0XCIsU2UpO3IoXCJtb3JpLnJlcGVhdC5mMVwiLFNlLmIpO3IoXCJtb3JpLnJlcGVhdC5mMlwiLFNlLmEpO3IoXCJtb3JpLnJlcGVhdGVkbHlcIixUZSk7cihcIm1vcmkucmVwZWF0ZWRseS5mMVwiLFRlLmIpO3IoXCJtb3JpLnJlcGVhdGVkbHkuZjJcIixUZS5hKTtyKFwibW9yaS5zb3J0XCIsc2QpO3IoXCJtb3JpLnNvcnQuZjFcIixzZC5iKTtyKFwibW9yaS5zb3J0LmYyXCIsc2QuYSk7cihcIm1vcmkuc29ydEJ5XCIsdGQpO3IoXCJtb3JpLnNvcnRCeS5mMlwiLHRkLmEpO3IoXCJtb3JpLnNvcnRCeS5mM1wiLHRkLmMpO3IoXCJtb3JpLmludG9BcnJheVwiLElhKTtyKFwibW9yaS5pbnRvQXJyYXkuZjFcIixJYS5iKTtcbnIoXCJtb3JpLmludG9BcnJheS5mMlwiLElhLmEpO3IoXCJtb3JpLnN1YnNlcVwiLG5oKTtyKFwibW9yaS5zdWJzZXEuZjNcIixuaC5jKTtyKFwibW9yaS5zdWJzZXEuZjVcIixuaC5yKTtyKFwibW9yaS5kZWR1cGVcIixGaCk7cihcIm1vcmkuZGVkdXBlLmYwXCIsRmgubCk7cihcIm1vcmkuZGVkdXBlLmYxXCIsRmguYik7cihcIm1vcmkudHJhbnNkdWNlXCIsd2QpO3IoXCJtb3JpLnRyYW5zZHVjZS5mM1wiLHdkLmMpO3IoXCJtb3JpLnRyYW5zZHVjZS5mNFwiLHdkLm4pO3IoXCJtb3JpLmVkdWN0aW9uXCIsZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IEdoKGEsYil9KTtyKFwibW9yaS5zZXF1ZW5jZVwiLENlKTtyKFwibW9yaS5zZXF1ZW5jZS5mMVwiLENlLmIpO3IoXCJtb3JpLnNlcXVlbmNlLmYyXCIsQ2UuYSk7cihcIm1vcmkuc2VxdWVuY2UuZm5cIixDZS5LKTtyKFwibW9yaS5jb21wbGV0aW5nXCIsdmQpO3IoXCJtb3JpLmNvbXBsZXRpbmcuZjFcIix2ZC5iKTtyKFwibW9yaS5jb21wbGV0aW5nLmYyXCIsdmQuYSk7cihcIm1vcmkubGlzdFwiLEtkKTtcbnIoXCJtb3JpLnZlY3RvclwiLEFmKTtyKFwibW9yaS5oYXNoTWFwXCIsUGcpO3IoXCJtb3JpLnNldFwiLGZoKTtyKFwibW9yaS5zb3J0ZWRTZXRcIixnaCk7cihcIm1vcmkuc29ydGVkU2V0QnlcIixoaCk7cihcIm1vcmkuc29ydGVkTWFwXCIsUWcpO3IoXCJtb3JpLnNvcnRlZE1hcEJ5XCIsUmcpO3IoXCJtb3JpLnF1ZXVlXCIsZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEpe3ZhciBkPW51bGw7aWYoMDxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGQ9MCxlPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMCk7ZDxlLmxlbmd0aDspZVtkXT1hcmd1bWVudHNbZCswXSwrK2Q7ZD1uZXcgRihlLDApfXJldHVybiBiLmNhbGwodGhpcyxkKX1mdW5jdGlvbiBiKGEpe3JldHVybiBhZi5hP2FmLmEoTWYsYSk6YWYuY2FsbChudWxsLE1mLGEpfWEuaT0wO2EuZj1mdW5jdGlvbihhKXthPUQoYSk7cmV0dXJuIGIoYSl9O2EuZD1iO3JldHVybiBhfSgpKTtyKFwibW9yaS5rZXl3b3JkXCIsUGQpO3IoXCJtb3JpLmtleXdvcmQuZjFcIixQZC5iKTtcbnIoXCJtb3JpLmtleXdvcmQuZjJcIixQZC5hKTtyKFwibW9yaS5zeW1ib2xcIixyYyk7cihcIm1vcmkuc3ltYm9sLmYxXCIscmMuYik7cihcIm1vcmkuc3ltYm9sLmYyXCIscmMuYSk7cihcIm1vcmkuemlwbWFwXCIsZnVuY3Rpb24oYSxiKXtmb3IodmFyIGM9T2IoVWYpLGQ9RChhKSxlPUQoYik7OylpZihkJiZlKWM9ZWUuYyhjLEcoZCksRyhlKSksZD1LKGQpLGU9SyhlKTtlbHNlIHJldHVybiBRYihjKX0pO3IoXCJtb3JpLmlzTGlzdFwiLGZ1bmN0aW9uKGEpe3JldHVybiBhP2EuaiYzMzU1NDQzMnx8YS53Yz8hMDphLmo/ITE6dyhFYixhKTp3KEViLGEpfSk7cihcIm1vcmkuaXNTZXFcIixrZCk7cihcIm1vcmkuaXNWZWN0b3JcIixlZCk7cihcIm1vcmkuaXNNYXBcIixkZCk7cihcIm1vcmkuaXNTZXRcIixhZCk7cihcIm1vcmkuaXNLZXl3b3JkXCIsZnVuY3Rpb24oYSl7cmV0dXJuIGEgaW5zdGFuY2VvZiBVfSk7cihcIm1vcmkuaXNTeW1ib2xcIixmdW5jdGlvbihhKXtyZXR1cm4gYSBpbnN0YW5jZW9mIHFjfSk7XG5yKFwibW9yaS5pc0NvbGxlY3Rpb25cIiwkYyk7cihcIm1vcmkuaXNTZXF1ZW50aWFsXCIsY2QpO3IoXCJtb3JpLmlzQXNzb2NpYXRpdmVcIixiZCk7cihcIm1vcmkuaXNDb3VudGVkXCIsRWMpO3IoXCJtb3JpLmlzSW5kZXhlZFwiLEZjKTtyKFwibW9yaS5pc1JlZHVjZWFibGVcIixmdW5jdGlvbihhKXtyZXR1cm4gYT9hLmomNTI0Mjg4fHxhLlNiPyEwOmEuaj8hMTp3KHZiLGEpOncodmIsYSl9KTtyKFwibW9yaS5pc1NlcWFibGVcIixsZCk7cihcIm1vcmkuaXNSZXZlcnNpYmxlXCIsSWQpO3IoXCJtb3JpLnVuaW9uXCIsUmgpO3IoXCJtb3JpLnVuaW9uLmYwXCIsUmgubCk7cihcIm1vcmkudW5pb24uZjFcIixSaC5iKTtyKFwibW9yaS51bmlvbi5mMlwiLFJoLmEpO3IoXCJtb3JpLnVuaW9uLmZuXCIsUmguSyk7cihcIm1vcmkuaW50ZXJzZWN0aW9uXCIsU2gpO3IoXCJtb3JpLmludGVyc2VjdGlvbi5mMVwiLFNoLmIpO3IoXCJtb3JpLmludGVyc2VjdGlvbi5mMlwiLFNoLmEpO3IoXCJtb3JpLmludGVyc2VjdGlvbi5mblwiLFNoLkspO1xucihcIm1vcmkuZGlmZmVyZW5jZVwiLFRoKTtyKFwibW9yaS5kaWZmZXJlbmNlLmYxXCIsVGguYik7cihcIm1vcmkuZGlmZmVyZW5jZS5mMlwiLFRoLmEpO3IoXCJtb3JpLmRpZmZlcmVuY2UuZm5cIixUaC5LKTtyKFwibW9yaS5qb2luXCIsWGgpO3IoXCJtb3JpLmpvaW4uZjJcIixYaC5hKTtyKFwibW9yaS5qb2luLmYzXCIsWGguYyk7cihcIm1vcmkuaW5kZXhcIixWaCk7cihcIm1vcmkucHJvamVjdFwiLGZ1bmN0aW9uKGEsYil7cmV0dXJuIGZoKE9lLmEoZnVuY3Rpb24oYSl7cmV0dXJuIFlnKGEsYil9LGEpKX0pO3IoXCJtb3JpLm1hcEludmVydFwiLFdoKTtyKFwibW9yaS5yZW5hbWVcIixmdW5jdGlvbihhLGIpe3JldHVybiBmaChPZS5hKGZ1bmN0aW9uKGEpe3JldHVybiBVaChhLGIpfSxhKSl9KTtyKFwibW9yaS5yZW5hbWVLZXlzXCIsVWgpO3IoXCJtb3JpLmlzU3Vic2V0XCIsZnVuY3Rpb24oYSxiKXtyZXR1cm4gUShhKTw9UShiKSYmRWUoZnVuY3Rpb24oYSl7cmV0dXJuIG5kKGIsYSl9LGEpfSk7XG5yKFwibW9yaS5pc1N1cGVyc2V0XCIsZnVuY3Rpb24oYSxiKXtyZXR1cm4gUShhKT49UShiKSYmRWUoZnVuY3Rpb24oYil7cmV0dXJuIG5kKGEsYil9LGIpfSk7cihcIm1vcmkubm90RXF1YWxzXCIsamUpO3IoXCJtb3JpLm5vdEVxdWFscy5mMVwiLGplLmIpO3IoXCJtb3JpLm5vdEVxdWFscy5mMlwiLGplLmEpO3IoXCJtb3JpLm5vdEVxdWFscy5mblwiLGplLkspO3IoXCJtb3JpLmd0XCIsQWQpO3IoXCJtb3JpLmd0LmYxXCIsQWQuYik7cihcIm1vcmkuZ3QuZjJcIixBZC5hKTtyKFwibW9yaS5ndC5mblwiLEFkLkspO3IoXCJtb3JpLmd0ZVwiLEJkKTtyKFwibW9yaS5ndGUuZjFcIixCZC5iKTtyKFwibW9yaS5ndGUuZjJcIixCZC5hKTtyKFwibW9yaS5ndGUuZm5cIixCZC5LKTtyKFwibW9yaS5sdFwiLHlkKTtyKFwibW9yaS5sdC5mMVwiLHlkLmIpO3IoXCJtb3JpLmx0LmYyXCIseWQuYSk7cihcIm1vcmkubHQuZm5cIix5ZC5LKTtyKFwibW9yaS5sdGVcIix6ZCk7cihcIm1vcmkubHRlLmYxXCIsemQuYik7cihcIm1vcmkubHRlLmYyXCIsemQuYSk7XG5yKFwibW9yaS5sdGUuZm5cIix6ZC5LKTtyKFwibW9yaS5jb21wYXJlXCIsb2QpO3IoXCJtb3JpLnBhcnRpYWxcIixKZSk7cihcIm1vcmkucGFydGlhbC5mMVwiLEplLmIpO3IoXCJtb3JpLnBhcnRpYWwuZjJcIixKZS5hKTtyKFwibW9yaS5wYXJ0aWFsLmYzXCIsSmUuYyk7cihcIm1vcmkucGFydGlhbC5mNFwiLEplLm4pO3IoXCJtb3JpLnBhcnRpYWwuZm5cIixKZS5LKTtyKFwibW9yaS5jb21wXCIsSWUpO3IoXCJtb3JpLmNvbXAuZjBcIixJZS5sKTtyKFwibW9yaS5jb21wLmYxXCIsSWUuYik7cihcIm1vcmkuY29tcC5mMlwiLEllLmEpO3IoXCJtb3JpLmNvbXAuZjNcIixJZS5jKTtyKFwibW9yaS5jb21wLmZuXCIsSWUuSyk7XG5yKFwibW9yaS5waXBlbGluZVwiLGZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhKXt2YXIgZD1udWxsO2lmKDA8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBkPTAsZT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTApO2Q8ZS5sZW5ndGg7KWVbZF09YXJndW1lbnRzW2QrMF0sKytkO2Q9bmV3IEYoZSwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsZCl9ZnVuY3Rpb24gYihhKXtmdW5jdGlvbiBiKGEsYyl7cmV0dXJuIGMuYj9jLmIoYSk6Yy5jYWxsKG51bGwsYSl9cmV0dXJuIEEuYT9BLmEoYixhKTpBLmNhbGwobnVsbCxiLGEpfWEuaT0wO2EuZj1mdW5jdGlvbihhKXthPUQoYSk7cmV0dXJuIGIoYSl9O2EuZD1iO3JldHVybiBhfSgpKTtcbnIoXCJtb3JpLmN1cnJ5XCIsZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsZCl7dmFyIGU9bnVsbDtpZigxPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZT0wLGY9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0xKTtlPGYubGVuZ3RoOylmW2VdPWFyZ3VtZW50c1tlKzFdLCsrZTtlPW5ldyBGKGYsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGEsZSl9ZnVuY3Rpb24gYihhLGIpe3JldHVybiBmdW5jdGlvbihlKXtyZXR1cm4gVC5hKGEsTS5hP00uYShlLGIpOk0uY2FsbChudWxsLGUsYikpfX1hLmk9MTthLmY9ZnVuY3Rpb24oYSl7dmFyIGQ9RyhhKTthPUgoYSk7cmV0dXJuIGIoZCxhKX07YS5kPWI7cmV0dXJuIGF9KCkpO1xucihcIm1vcmkuanV4dFwiLGZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhKXt2YXIgZD1udWxsO2lmKDA8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBkPTAsZT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTApO2Q8ZS5sZW5ndGg7KWVbZF09YXJndW1lbnRzW2QrMF0sKytkO2Q9bmV3IEYoZSwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsZCl9ZnVuY3Rpb24gYihhKXtyZXR1cm4gZnVuY3Rpb24oKXtmdW5jdGlvbiBiKGEpe3ZhciBjPW51bGw7aWYoMDxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGM9MCxkPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMCk7YzxkLmxlbmd0aDspZFtjXT1hcmd1bWVudHNbYyswXSwrK2M7Yz1uZXcgRihkLDApfXJldHVybiBlLmNhbGwodGhpcyxjKX1mdW5jdGlvbiBlKGIpe3ZhciBkPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gZChhKXtyZXR1cm4gVC5hKGEsYil9cmV0dXJuIE9lLmE/T2UuYShkLGEpOk9lLmNhbGwobnVsbCxkLGEpfSgpO3JldHVybiBJYS5iP0lhLmIoZCk6SWEuY2FsbChudWxsLFxuZCl9Yi5pPTA7Yi5mPWZ1bmN0aW9uKGEpe2E9RChhKTtyZXR1cm4gZShhKX07Yi5kPWU7cmV0dXJuIGJ9KCl9YS5pPTA7YS5mPWZ1bmN0aW9uKGEpe2E9RChhKTtyZXR1cm4gYihhKX07YS5kPWI7cmV0dXJuIGF9KCkpO1xucihcIm1vcmkua25pdFwiLGZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhKXt2YXIgZD1udWxsO2lmKDA8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBkPTAsZT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTApO2Q8ZS5sZW5ndGg7KWVbZF09YXJndW1lbnRzW2QrMF0sKytkO2Q9bmV3IEYoZSwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsZCl9ZnVuY3Rpb24gYihhKXtyZXR1cm4gZnVuY3Rpb24oYil7dmFyIGU9ZnVuY3Rpb24oKXtmdW5jdGlvbiBlKGEsYil7cmV0dXJuIGEuYj9hLmIoYik6YS5jYWxsKG51bGwsYil9cmV0dXJuIE9lLmM/T2UuYyhlLGEsYik6T2UuY2FsbChudWxsLGUsYSxiKX0oKTtyZXR1cm4gSWEuYj9JYS5iKGUpOklhLmNhbGwobnVsbCxlKX19YS5pPTA7YS5mPWZ1bmN0aW9uKGEpe2E9RChhKTtyZXR1cm4gYihhKX07YS5kPWI7cmV0dXJuIGF9KCkpO3IoXCJtb3JpLnN1bVwiLHhkKTtyKFwibW9yaS5zdW0uZjBcIix4ZC5sKTtyKFwibW9yaS5zdW0uZjFcIix4ZC5iKTtcbnIoXCJtb3JpLnN1bS5mMlwiLHhkLmEpO3IoXCJtb3JpLnN1bS5mblwiLHhkLkspO3IoXCJtb3JpLmluY1wiLGZ1bmN0aW9uKGEpe3JldHVybiBhKzF9KTtyKFwibW9yaS5kZWNcIixmdW5jdGlvbihhKXtyZXR1cm4gYS0xfSk7cihcIm1vcmkuaXNFdmVuXCIsR2UpO3IoXCJtb3JpLmlzT2RkXCIsZnVuY3Rpb24oYSl7cmV0dXJuIUdlKGEpfSk7cihcIm1vcmkuZWFjaFwiLGZ1bmN0aW9uKGEsYil7Zm9yKHZhciBjPUQoYSksZD1udWxsLGU9MCxmPTA7OylpZihmPGUpe3ZhciBnPWQuUShudWxsLGYpO2IuYj9iLmIoZyk6Yi5jYWxsKG51bGwsZyk7Zis9MX1lbHNlIGlmKGM9RChjKSlmZChjKT8oZT1ZYihjKSxjPVpiKGMpLGQ9ZSxlPVEoZSkpOihkPWc9RyhjKSxiLmI/Yi5iKGQpOmIuY2FsbChudWxsLGQpLGM9SyhjKSxkPW51bGwsZT0wKSxmPTA7ZWxzZSByZXR1cm4gbnVsbH0pO3IoXCJtb3JpLmlkZW50aXR5XCIsdWQpO1xucihcIm1vcmkuY29uc3RhbnRseVwiLGZ1bmN0aW9uKGEpe3JldHVybiBmdW5jdGlvbigpe2Z1bmN0aW9uIGIoYil7aWYoMDxhcmd1bWVudHMubGVuZ3RoKWZvcih2YXIgZD0wLGU9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0wKTtkPGUubGVuZ3RoOyllW2RdPWFyZ3VtZW50c1tkKzBdLCsrZDtyZXR1cm4gYX1iLmk9MDtiLmY9ZnVuY3Rpb24oYil7RChiKTtyZXR1cm4gYX07Yi5kPWZ1bmN0aW9uKCl7cmV0dXJuIGF9O3JldHVybiBifSgpfSk7cihcIm1vcmkudG9Kc1wiLEtoKTtcbnIoXCJtb3JpLnRvQ2xqXCIsZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYil7cmV0dXJuIFBoLmQoYSxLYyhbT2gsYl0sMCkpfWZ1bmN0aW9uIGIoYSl7cmV0dXJuIFBoLmIoYSl9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYi5jYWxsKHRoaXMsYyk7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxjLGUpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmI9YjtjLmE9YTtyZXR1cm4gY30oKSk7cihcIm1vcmkuY29uZmlndXJlXCIsZnVuY3Rpb24oYSxiKXtzd2l0Y2goYSl7Y2FzZSBcInByaW50LWxlbmd0aFwiOnJldHVybiBsYT1iO2Nhc2UgXCJwcmludC1sZXZlbFwiOnJldHVybiBtYT1iO2RlZmF1bHQ6dGhyb3cgRXJyb3IoW3ooXCJObyBtYXRjaGluZyBjbGF1c2U6IFwiKSx6KGEpXS5qb2luKFwiXCIpKTt9fSk7cihcIm1vcmkubWV0YVwiLFZjKTtyKFwibW9yaS53aXRoTWV0YVwiLE8pO1xucihcIm1vcmkudmFyeU1ldGFcIixpZSk7cihcIm1vcmkudmFyeU1ldGEuZjJcIixpZS5hKTtyKFwibW9yaS52YXJ5TWV0YS5mM1wiLGllLmMpO3IoXCJtb3JpLnZhcnlNZXRhLmY0XCIsaWUubik7cihcIm1vcmkudmFyeU1ldGEuZjVcIixpZS5yKTtyKFwibW9yaS52YXJ5TWV0YS5mNlwiLGllLlApO3IoXCJtb3JpLnZhcnlNZXRhLmZuXCIsaWUuSyk7cihcIm1vcmkuYWx0ZXJNZXRhXCIsRGgpO3IoXCJtb3JpLnJlc2V0TWV0YVwiLGZ1bmN0aW9uKGEsYil7cmV0dXJuIGEuaz1ifSk7Vi5wcm90b3R5cGUuaW5zcGVjdD1mdW5jdGlvbigpe3JldHVybiB0aGlzLnRvU3RyaW5nKCl9O0YucHJvdG90eXBlLmluc3BlY3Q9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy50b1N0cmluZygpfTtIYy5wcm90b3R5cGUuaW5zcGVjdD1mdW5jdGlvbigpe3JldHVybiB0aGlzLnRvU3RyaW5nKCl9O3dnLnByb3RvdHlwZS5pbnNwZWN0PWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudG9TdHJpbmcoKX07cGcucHJvdG90eXBlLmluc3BlY3Q9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy50b1N0cmluZygpfTtcbnFnLnByb3RvdHlwZS5pbnNwZWN0PWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudG9TdHJpbmcoKX07RmQucHJvdG90eXBlLmluc3BlY3Q9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy50b1N0cmluZygpfTtMZC5wcm90b3R5cGUuaW5zcGVjdD1mdW5jdGlvbigpe3JldHVybiB0aGlzLnRvU3RyaW5nKCl9O0hkLnByb3RvdHlwZS5pbnNwZWN0PWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudG9TdHJpbmcoKX07Vy5wcm90b3R5cGUuaW5zcGVjdD1mdW5jdGlvbigpe3JldHVybiB0aGlzLnRvU3RyaW5nKCl9O1ZkLnByb3RvdHlwZS5pbnNwZWN0PWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudG9TdHJpbmcoKX07QmYucHJvdG90eXBlLmluc3BlY3Q9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy50b1N0cmluZygpfTtEZi5wcm90b3R5cGUuaW5zcGVjdD1mdW5jdGlvbigpe3JldHVybiB0aGlzLnRvU3RyaW5nKCl9O1oucHJvdG90eXBlLmluc3BlY3Q9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy50b1N0cmluZygpfTtcblgucHJvdG90eXBlLmluc3BlY3Q9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy50b1N0cmluZygpfTtwYS5wcm90b3R5cGUuaW5zcGVjdD1mdW5jdGlvbigpe3JldHVybiB0aGlzLnRvU3RyaW5nKCl9O3JnLnByb3RvdHlwZS5pbnNwZWN0PWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudG9TdHJpbmcoKX07TGcucHJvdG90eXBlLmluc3BlY3Q9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy50b1N0cmluZygpfTskZy5wcm90b3R5cGUuaW5zcGVjdD1mdW5jdGlvbigpe3JldHVybiB0aGlzLnRvU3RyaW5nKCl9O2NoLnByb3RvdHlwZS5pbnNwZWN0PWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudG9TdHJpbmcoKX07cGgucHJvdG90eXBlLmluc3BlY3Q9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy50b1N0cmluZygpfTtVLnByb3RvdHlwZS5pbnNwZWN0PWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudG9TdHJpbmcoKX07cWMucHJvdG90eXBlLmluc3BlY3Q9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy50b1N0cmluZygpfTtcbkxmLnByb3RvdHlwZS5pbnNwZWN0PWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudG9TdHJpbmcoKX07S2YucHJvdG90eXBlLmluc3BlY3Q9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy50b1N0cmluZygpfTtyKFwibW9yaS5tdXRhYmxlLnRoYXdcIixmdW5jdGlvbihhKXtyZXR1cm4gT2IoYSl9KTtyKFwibW9yaS5tdXRhYmxlLmZyZWV6ZVwiLGNlKTtyKFwibW9yaS5tdXRhYmxlLmNvbmpcIixkZSk7cihcIm1vcmkubXV0YWJsZS5jb25qLmYwXCIsZGUubCk7cihcIm1vcmkubXV0YWJsZS5jb25qLmYxXCIsZGUuYik7cihcIm1vcmkubXV0YWJsZS5jb25qLmYyXCIsZGUuYSk7cihcIm1vcmkubXV0YWJsZS5jb25qLmZuXCIsZGUuSyk7cihcIm1vcmkubXV0YWJsZS5hc3NvY1wiLGVlKTtyKFwibW9yaS5tdXRhYmxlLmFzc29jLmYzXCIsZWUuYyk7cihcIm1vcmkubXV0YWJsZS5hc3NvYy5mblwiLGVlLkspO3IoXCJtb3JpLm11dGFibGUuZGlzc29jXCIsZmUpO3IoXCJtb3JpLm11dGFibGUuZGlzc29jLmYyXCIsZmUuYSk7cihcIm1vcmkubXV0YWJsZS5kaXNzb2MuZm5cIixmZS5LKTtyKFwibW9yaS5tdXRhYmxlLnBvcFwiLGZ1bmN0aW9uKGEpe3JldHVybiBVYihhKX0pO3IoXCJtb3JpLm11dGFibGUuZGlzalwiLGdlKTtcbnIoXCJtb3JpLm11dGFibGUuZGlzai5mMlwiLGdlLmEpO3IoXCJtb3JpLm11dGFibGUuZGlzai5mblwiLGdlLkspOztyZXR1cm4gdGhpcy5tb3JpO30uY2FsbCh7fSk7fSk7XG4iLCIndXNlIHN0cmljdCc7XG5cbm1vZHVsZS5leHBvcnRzID0gcmVxdWlyZSgnLi9saWInKVxuIiwiJ3VzZSBzdHJpY3QnO1xuXG52YXIgYXNhcCA9IHJlcXVpcmUoJ2FzYXAvcmF3Jyk7XG5cbmZ1bmN0aW9uIG5vb3AoKSB7fVxuXG4vLyBTdGF0ZXM6XG4vL1xuLy8gMCAtIHBlbmRpbmdcbi8vIDEgLSBmdWxmaWxsZWQgd2l0aCBfdmFsdWVcbi8vIDIgLSByZWplY3RlZCB3aXRoIF92YWx1ZVxuLy8gMyAtIGFkb3B0ZWQgdGhlIHN0YXRlIG9mIGFub3RoZXIgcHJvbWlzZSwgX3ZhbHVlXG4vL1xuLy8gb25jZSB0aGUgc3RhdGUgaXMgbm8gbG9uZ2VyIHBlbmRpbmcgKDApIGl0IGlzIGltbXV0YWJsZVxuXG4vLyBBbGwgYF9gIHByZWZpeGVkIHByb3BlcnRpZXMgd2lsbCBiZSByZWR1Y2VkIHRvIGBfe3JhbmRvbSBudW1iZXJ9YFxuLy8gYXQgYnVpbGQgdGltZSB0byBvYmZ1c2NhdGUgdGhlbSBhbmQgZGlzY291cmFnZSB0aGVpciB1c2UuXG4vLyBXZSBkb24ndCB1c2Ugc3ltYm9scyBvciBPYmplY3QuZGVmaW5lUHJvcGVydHkgdG8gZnVsbHkgaGlkZSB0aGVtXG4vLyBiZWNhdXNlIHRoZSBwZXJmb3JtYW5jZSBpc24ndCBnb29kIGVub3VnaC5cblxuXG4vLyB0byBhdm9pZCB1c2luZyB0cnkvY2F0Y2ggaW5zaWRlIGNyaXRpY2FsIGZ1bmN0aW9ucywgd2Vcbi8vIGV4dHJhY3QgdGhlbSB0byBoZXJlLlxudmFyIExBU1RfRVJST1IgPSBudWxsO1xudmFyIElTX0VSUk9SID0ge307XG5mdW5jdGlvbiBnZXRUaGVuKG9iaikge1xuICB0cnkge1xuICAgIHJldHVybiBvYmoudGhlbjtcbiAgfSBjYXRjaCAoZXgpIHtcbiAgICBMQVNUX0VSUk9SID0gZXg7XG4gICAgcmV0dXJuIElTX0VSUk9SO1xuICB9XG59XG5cbmZ1bmN0aW9uIHRyeUNhbGxPbmUoZm4sIGEpIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gZm4oYSk7XG4gIH0gY2F0Y2ggKGV4KSB7XG4gICAgTEFTVF9FUlJPUiA9IGV4O1xuICAgIHJldHVybiBJU19FUlJPUjtcbiAgfVxufVxuZnVuY3Rpb24gdHJ5Q2FsbFR3byhmbiwgYSwgYikge1xuICB0cnkge1xuICAgIGZuKGEsIGIpO1xuICB9IGNhdGNoIChleCkge1xuICAgIExBU1RfRVJST1IgPSBleDtcbiAgICByZXR1cm4gSVNfRVJST1I7XG4gIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBQcm9taXNlO1xuXG5mdW5jdGlvbiBQcm9taXNlKGZuKSB7XG4gIGlmICh0eXBlb2YgdGhpcyAhPT0gJ29iamVjdCcpIHtcbiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdQcm9taXNlcyBtdXN0IGJlIGNvbnN0cnVjdGVkIHZpYSBuZXcnKTtcbiAgfVxuICBpZiAodHlwZW9mIGZuICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgdGhyb3cgbmV3IFR5cGVFcnJvcignbm90IGEgZnVuY3Rpb24nKTtcbiAgfVxuICB0aGlzLl80NSA9IDA7XG4gIHRoaXMuXzgxID0gMDtcbiAgdGhpcy5fNjUgPSBudWxsO1xuICB0aGlzLl81NCA9IG51bGw7XG4gIGlmIChmbiA9PT0gbm9vcCkgcmV0dXJuO1xuICBkb1Jlc29sdmUoZm4sIHRoaXMpO1xufVxuUHJvbWlzZS5fMTAgPSBudWxsO1xuUHJvbWlzZS5fOTcgPSBudWxsO1xuUHJvbWlzZS5fNjEgPSBub29wO1xuXG5Qcm9taXNlLnByb3RvdHlwZS50aGVuID0gZnVuY3Rpb24ob25GdWxmaWxsZWQsIG9uUmVqZWN0ZWQpIHtcbiAgaWYgKHRoaXMuY29uc3RydWN0b3IgIT09IFByb21pc2UpIHtcbiAgICByZXR1cm4gc2FmZVRoZW4odGhpcywgb25GdWxmaWxsZWQsIG9uUmVqZWN0ZWQpO1xuICB9XG4gIHZhciByZXMgPSBuZXcgUHJvbWlzZShub29wKTtcbiAgaGFuZGxlKHRoaXMsIG5ldyBIYW5kbGVyKG9uRnVsZmlsbGVkLCBvblJlamVjdGVkLCByZXMpKTtcbiAgcmV0dXJuIHJlcztcbn07XG5cbmZ1bmN0aW9uIHNhZmVUaGVuKHNlbGYsIG9uRnVsZmlsbGVkLCBvblJlamVjdGVkKSB7XG4gIHJldHVybiBuZXcgc2VsZi5jb25zdHJ1Y3RvcihmdW5jdGlvbiAocmVzb2x2ZSwgcmVqZWN0KSB7XG4gICAgdmFyIHJlcyA9IG5ldyBQcm9taXNlKG5vb3ApO1xuICAgIHJlcy50aGVuKHJlc29sdmUsIHJlamVjdCk7XG4gICAgaGFuZGxlKHNlbGYsIG5ldyBIYW5kbGVyKG9uRnVsZmlsbGVkLCBvblJlamVjdGVkLCByZXMpKTtcbiAgfSk7XG59O1xuZnVuY3Rpb24gaGFuZGxlKHNlbGYsIGRlZmVycmVkKSB7XG4gIHdoaWxlIChzZWxmLl84MSA9PT0gMykge1xuICAgIHNlbGYgPSBzZWxmLl82NTtcbiAgfVxuICBpZiAoUHJvbWlzZS5fMTApIHtcbiAgICBQcm9taXNlLl8xMChzZWxmKTtcbiAgfVxuICBpZiAoc2VsZi5fODEgPT09IDApIHtcbiAgICBpZiAoc2VsZi5fNDUgPT09IDApIHtcbiAgICAgIHNlbGYuXzQ1ID0gMTtcbiAgICAgIHNlbGYuXzU0ID0gZGVmZXJyZWQ7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChzZWxmLl80NSA9PT0gMSkge1xuICAgICAgc2VsZi5fNDUgPSAyO1xuICAgICAgc2VsZi5fNTQgPSBbc2VsZi5fNTQsIGRlZmVycmVkXTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgc2VsZi5fNTQucHVzaChkZWZlcnJlZCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGhhbmRsZVJlc29sdmVkKHNlbGYsIGRlZmVycmVkKTtcbn1cblxuZnVuY3Rpb24gaGFuZGxlUmVzb2x2ZWQoc2VsZiwgZGVmZXJyZWQpIHtcbiAgYXNhcChmdW5jdGlvbigpIHtcbiAgICB2YXIgY2IgPSBzZWxmLl84MSA9PT0gMSA/IGRlZmVycmVkLm9uRnVsZmlsbGVkIDogZGVmZXJyZWQub25SZWplY3RlZDtcbiAgICBpZiAoY2IgPT09IG51bGwpIHtcbiAgICAgIGlmIChzZWxmLl84MSA9PT0gMSkge1xuICAgICAgICByZXNvbHZlKGRlZmVycmVkLnByb21pc2UsIHNlbGYuXzY1KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJlamVjdChkZWZlcnJlZC5wcm9taXNlLCBzZWxmLl82NSk7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHZhciByZXQgPSB0cnlDYWxsT25lKGNiLCBzZWxmLl82NSk7XG4gICAgaWYgKHJldCA9PT0gSVNfRVJST1IpIHtcbiAgICAgIHJlamVjdChkZWZlcnJlZC5wcm9taXNlLCBMQVNUX0VSUk9SKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmVzb2x2ZShkZWZlcnJlZC5wcm9taXNlLCByZXQpO1xuICAgIH1cbiAgfSk7XG59XG5mdW5jdGlvbiByZXNvbHZlKHNlbGYsIG5ld1ZhbHVlKSB7XG4gIC8vIFByb21pc2UgUmVzb2x1dGlvbiBQcm9jZWR1cmU6IGh0dHBzOi8vZ2l0aHViLmNvbS9wcm9taXNlcy1hcGx1cy9wcm9taXNlcy1zcGVjI3RoZS1wcm9taXNlLXJlc29sdXRpb24tcHJvY2VkdXJlXG4gIGlmIChuZXdWYWx1ZSA9PT0gc2VsZikge1xuICAgIHJldHVybiByZWplY3QoXG4gICAgICBzZWxmLFxuICAgICAgbmV3IFR5cGVFcnJvcignQSBwcm9taXNlIGNhbm5vdCBiZSByZXNvbHZlZCB3aXRoIGl0c2VsZi4nKVxuICAgICk7XG4gIH1cbiAgaWYgKFxuICAgIG5ld1ZhbHVlICYmXG4gICAgKHR5cGVvZiBuZXdWYWx1ZSA9PT0gJ29iamVjdCcgfHwgdHlwZW9mIG5ld1ZhbHVlID09PSAnZnVuY3Rpb24nKVxuICApIHtcbiAgICB2YXIgdGhlbiA9IGdldFRoZW4obmV3VmFsdWUpO1xuICAgIGlmICh0aGVuID09PSBJU19FUlJPUikge1xuICAgICAgcmV0dXJuIHJlamVjdChzZWxmLCBMQVNUX0VSUk9SKTtcbiAgICB9XG4gICAgaWYgKFxuICAgICAgdGhlbiA9PT0gc2VsZi50aGVuICYmXG4gICAgICBuZXdWYWx1ZSBpbnN0YW5jZW9mIFByb21pc2VcbiAgICApIHtcbiAgICAgIHNlbGYuXzgxID0gMztcbiAgICAgIHNlbGYuXzY1ID0gbmV3VmFsdWU7XG4gICAgICBmaW5hbGUoc2VsZik7XG4gICAgICByZXR1cm47XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgdGhlbiA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgZG9SZXNvbHZlKHRoZW4uYmluZChuZXdWYWx1ZSksIHNlbGYpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgfVxuICBzZWxmLl84MSA9IDE7XG4gIHNlbGYuXzY1ID0gbmV3VmFsdWU7XG4gIGZpbmFsZShzZWxmKTtcbn1cblxuZnVuY3Rpb24gcmVqZWN0KHNlbGYsIG5ld1ZhbHVlKSB7XG4gIHNlbGYuXzgxID0gMjtcbiAgc2VsZi5fNjUgPSBuZXdWYWx1ZTtcbiAgaWYgKFByb21pc2UuXzk3KSB7XG4gICAgUHJvbWlzZS5fOTcoc2VsZiwgbmV3VmFsdWUpO1xuICB9XG4gIGZpbmFsZShzZWxmKTtcbn1cbmZ1bmN0aW9uIGZpbmFsZShzZWxmKSB7XG4gIGlmIChzZWxmLl80NSA9PT0gMSkge1xuICAgIGhhbmRsZShzZWxmLCBzZWxmLl81NCk7XG4gICAgc2VsZi5fNTQgPSBudWxsO1xuICB9XG4gIGlmIChzZWxmLl80NSA9PT0gMikge1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgc2VsZi5fNTQubGVuZ3RoOyBpKyspIHtcbiAgICAgIGhhbmRsZShzZWxmLCBzZWxmLl81NFtpXSk7XG4gICAgfVxuICAgIHNlbGYuXzU0ID0gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBIYW5kbGVyKG9uRnVsZmlsbGVkLCBvblJlamVjdGVkLCBwcm9taXNlKXtcbiAgdGhpcy5vbkZ1bGZpbGxlZCA9IHR5cGVvZiBvbkZ1bGZpbGxlZCA9PT0gJ2Z1bmN0aW9uJyA/IG9uRnVsZmlsbGVkIDogbnVsbDtcbiAgdGhpcy5vblJlamVjdGVkID0gdHlwZW9mIG9uUmVqZWN0ZWQgPT09ICdmdW5jdGlvbicgPyBvblJlamVjdGVkIDogbnVsbDtcbiAgdGhpcy5wcm9taXNlID0gcHJvbWlzZTtcbn1cblxuLyoqXG4gKiBUYWtlIGEgcG90ZW50aWFsbHkgbWlzYmVoYXZpbmcgcmVzb2x2ZXIgZnVuY3Rpb24gYW5kIG1ha2Ugc3VyZVxuICogb25GdWxmaWxsZWQgYW5kIG9uUmVqZWN0ZWQgYXJlIG9ubHkgY2FsbGVkIG9uY2UuXG4gKlxuICogTWFrZXMgbm8gZ3VhcmFudGVlcyBhYm91dCBhc3luY2hyb255LlxuICovXG5mdW5jdGlvbiBkb1Jlc29sdmUoZm4sIHByb21pc2UpIHtcbiAgdmFyIGRvbmUgPSBmYWxzZTtcbiAgdmFyIHJlcyA9IHRyeUNhbGxUd28oZm4sIGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgIGlmIChkb25lKSByZXR1cm47XG4gICAgZG9uZSA9IHRydWU7XG4gICAgcmVzb2x2ZShwcm9taXNlLCB2YWx1ZSk7XG4gIH0sIGZ1bmN0aW9uIChyZWFzb24pIHtcbiAgICBpZiAoZG9uZSkgcmV0dXJuO1xuICAgIGRvbmUgPSB0cnVlO1xuICAgIHJlamVjdChwcm9taXNlLCByZWFzb24pO1xuICB9KVxuICBpZiAoIWRvbmUgJiYgcmVzID09PSBJU19FUlJPUikge1xuICAgIGRvbmUgPSB0cnVlO1xuICAgIHJlamVjdChwcm9taXNlLCBMQVNUX0VSUk9SKTtcbiAgfVxufVxuIiwiJ3VzZSBzdHJpY3QnO1xuXG52YXIgUHJvbWlzZSA9IHJlcXVpcmUoJy4vY29yZS5qcycpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IFByb21pc2U7XG5Qcm9taXNlLnByb3RvdHlwZS5kb25lID0gZnVuY3Rpb24gKG9uRnVsZmlsbGVkLCBvblJlamVjdGVkKSB7XG4gIHZhciBzZWxmID0gYXJndW1lbnRzLmxlbmd0aCA/IHRoaXMudGhlbi5hcHBseSh0aGlzLCBhcmd1bWVudHMpIDogdGhpcztcbiAgc2VsZi50aGVuKG51bGwsIGZ1bmN0aW9uIChlcnIpIHtcbiAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgIHRocm93IGVycjtcbiAgICB9LCAwKTtcbiAgfSk7XG59O1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG4vL1RoaXMgZmlsZSBjb250YWlucyB0aGUgRVM2IGV4dGVuc2lvbnMgdG8gdGhlIGNvcmUgUHJvbWlzZXMvQSsgQVBJXG5cbnZhciBQcm9taXNlID0gcmVxdWlyZSgnLi9jb3JlLmpzJyk7XG5cbm1vZHVsZS5leHBvcnRzID0gUHJvbWlzZTtcblxuLyogU3RhdGljIEZ1bmN0aW9ucyAqL1xuXG52YXIgVFJVRSA9IHZhbHVlUHJvbWlzZSh0cnVlKTtcbnZhciBGQUxTRSA9IHZhbHVlUHJvbWlzZShmYWxzZSk7XG52YXIgTlVMTCA9IHZhbHVlUHJvbWlzZShudWxsKTtcbnZhciBVTkRFRklORUQgPSB2YWx1ZVByb21pc2UodW5kZWZpbmVkKTtcbnZhciBaRVJPID0gdmFsdWVQcm9taXNlKDApO1xudmFyIEVNUFRZU1RSSU5HID0gdmFsdWVQcm9taXNlKCcnKTtcblxuZnVuY3Rpb24gdmFsdWVQcm9taXNlKHZhbHVlKSB7XG4gIHZhciBwID0gbmV3IFByb21pc2UoUHJvbWlzZS5fNjEpO1xuICBwLl84MSA9IDE7XG4gIHAuXzY1ID0gdmFsdWU7XG4gIHJldHVybiBwO1xufVxuUHJvbWlzZS5yZXNvbHZlID0gZnVuY3Rpb24gKHZhbHVlKSB7XG4gIGlmICh2YWx1ZSBpbnN0YW5jZW9mIFByb21pc2UpIHJldHVybiB2YWx1ZTtcblxuICBpZiAodmFsdWUgPT09IG51bGwpIHJldHVybiBOVUxMO1xuICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCkgcmV0dXJuIFVOREVGSU5FRDtcbiAgaWYgKHZhbHVlID09PSB0cnVlKSByZXR1cm4gVFJVRTtcbiAgaWYgKHZhbHVlID09PSBmYWxzZSkgcmV0dXJuIEZBTFNFO1xuICBpZiAodmFsdWUgPT09IDApIHJldHVybiBaRVJPO1xuICBpZiAodmFsdWUgPT09ICcnKSByZXR1cm4gRU1QVFlTVFJJTkc7XG5cbiAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcgfHwgdHlwZW9mIHZhbHVlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgdHJ5IHtcbiAgICAgIHZhciB0aGVuID0gdmFsdWUudGhlbjtcbiAgICAgIGlmICh0eXBlb2YgdGhlbiA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICByZXR1cm4gbmV3IFByb21pc2UodGhlbi5iaW5kKHZhbHVlKSk7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXgpIHtcbiAgICAgIHJldHVybiBuZXcgUHJvbWlzZShmdW5jdGlvbiAocmVzb2x2ZSwgcmVqZWN0KSB7XG4gICAgICAgIHJlamVjdChleCk7XG4gICAgICB9KTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHZhbHVlUHJvbWlzZSh2YWx1ZSk7XG59O1xuXG5Qcm9taXNlLmFsbCA9IGZ1bmN0aW9uIChhcnIpIHtcbiAgdmFyIGFyZ3MgPSBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChhcnIpO1xuXG4gIHJldHVybiBuZXcgUHJvbWlzZShmdW5jdGlvbiAocmVzb2x2ZSwgcmVqZWN0KSB7XG4gICAgaWYgKGFyZ3MubGVuZ3RoID09PSAwKSByZXR1cm4gcmVzb2x2ZShbXSk7XG4gICAgdmFyIHJlbWFpbmluZyA9IGFyZ3MubGVuZ3RoO1xuICAgIGZ1bmN0aW9uIHJlcyhpLCB2YWwpIHtcbiAgICAgIGlmICh2YWwgJiYgKHR5cGVvZiB2YWwgPT09ICdvYmplY3QnIHx8IHR5cGVvZiB2YWwgPT09ICdmdW5jdGlvbicpKSB7XG4gICAgICAgIGlmICh2YWwgaW5zdGFuY2VvZiBQcm9taXNlICYmIHZhbC50aGVuID09PSBQcm9taXNlLnByb3RvdHlwZS50aGVuKSB7XG4gICAgICAgICAgd2hpbGUgKHZhbC5fODEgPT09IDMpIHtcbiAgICAgICAgICAgIHZhbCA9IHZhbC5fNjU7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmICh2YWwuXzgxID09PSAxKSByZXR1cm4gcmVzKGksIHZhbC5fNjUpO1xuICAgICAgICAgIGlmICh2YWwuXzgxID09PSAyKSByZWplY3QodmFsLl82NSk7XG4gICAgICAgICAgdmFsLnRoZW4oZnVuY3Rpb24gKHZhbCkge1xuICAgICAgICAgICAgcmVzKGksIHZhbCk7XG4gICAgICAgICAgfSwgcmVqZWN0KTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdmFyIHRoZW4gPSB2YWwudGhlbjtcbiAgICAgICAgICBpZiAodHlwZW9mIHRoZW4gPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgIHZhciBwID0gbmV3IFByb21pc2UodGhlbi5iaW5kKHZhbCkpO1xuICAgICAgICAgICAgcC50aGVuKGZ1bmN0aW9uICh2YWwpIHtcbiAgICAgICAgICAgICAgcmVzKGksIHZhbCk7XG4gICAgICAgICAgICB9LCByZWplY3QpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgYXJnc1tpXSA9IHZhbDtcbiAgICAgIGlmICgtLXJlbWFpbmluZyA9PT0gMCkge1xuICAgICAgICByZXNvbHZlKGFyZ3MpO1xuICAgICAgfVxuICAgIH1cbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGFyZ3MubGVuZ3RoOyBpKyspIHtcbiAgICAgIHJlcyhpLCBhcmdzW2ldKTtcbiAgICB9XG4gIH0pO1xufTtcblxuUHJvbWlzZS5yZWplY3QgPSBmdW5jdGlvbiAodmFsdWUpIHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uIChyZXNvbHZlLCByZWplY3QpIHtcbiAgICByZWplY3QodmFsdWUpO1xuICB9KTtcbn07XG5cblByb21pc2UucmFjZSA9IGZ1bmN0aW9uICh2YWx1ZXMpIHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uIChyZXNvbHZlLCByZWplY3QpIHtcbiAgICB2YWx1ZXMuZm9yRWFjaChmdW5jdGlvbih2YWx1ZSl7XG4gICAgICBQcm9taXNlLnJlc29sdmUodmFsdWUpLnRoZW4ocmVzb2x2ZSwgcmVqZWN0KTtcbiAgICB9KTtcbiAgfSk7XG59O1xuXG4vKiBQcm90b3R5cGUgTWV0aG9kcyAqL1xuXG5Qcm9taXNlLnByb3RvdHlwZVsnY2F0Y2gnXSA9IGZ1bmN0aW9uIChvblJlamVjdGVkKSB7XG4gIHJldHVybiB0aGlzLnRoZW4obnVsbCwgb25SZWplY3RlZCk7XG59O1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG52YXIgUHJvbWlzZSA9IHJlcXVpcmUoJy4vY29yZS5qcycpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IFByb21pc2U7XG5Qcm9taXNlLnByb3RvdHlwZVsnZmluYWxseSddID0gZnVuY3Rpb24gKGYpIHtcbiAgcmV0dXJuIHRoaXMudGhlbihmdW5jdGlvbiAodmFsdWUpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKGYoKSkudGhlbihmdW5jdGlvbiAoKSB7XG4gICAgICByZXR1cm4gdmFsdWU7XG4gICAgfSk7XG4gIH0sIGZ1bmN0aW9uIChlcnIpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKGYoKSkudGhlbihmdW5jdGlvbiAoKSB7XG4gICAgICB0aHJvdyBlcnI7XG4gICAgfSk7XG4gIH0pO1xufTtcbiIsIid1c2Ugc3RyaWN0JztcblxubW9kdWxlLmV4cG9ydHMgPSByZXF1aXJlKCcuL2NvcmUuanMnKTtcbnJlcXVpcmUoJy4vZG9uZS5qcycpO1xucmVxdWlyZSgnLi9maW5hbGx5LmpzJyk7XG5yZXF1aXJlKCcuL2VzNi1leHRlbnNpb25zLmpzJyk7XG5yZXF1aXJlKCcuL25vZGUtZXh0ZW5zaW9ucy5qcycpO1xucmVxdWlyZSgnLi9zeW5jaHJvbm91cy5qcycpO1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG4vLyBUaGlzIGZpbGUgY29udGFpbnMgdGhlbi9wcm9taXNlIHNwZWNpZmljIGV4dGVuc2lvbnMgdGhhdCBhcmUgb25seSB1c2VmdWxcbi8vIGZvciBub2RlLmpzIGludGVyb3BcblxudmFyIFByb21pc2UgPSByZXF1aXJlKCcuL2NvcmUuanMnKTtcbnZhciBhc2FwID0gcmVxdWlyZSgnYXNhcCcpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IFByb21pc2U7XG5cbi8qIFN0YXRpYyBGdW5jdGlvbnMgKi9cblxuUHJvbWlzZS5kZW5vZGVpZnkgPSBmdW5jdGlvbiAoZm4sIGFyZ3VtZW50Q291bnQpIHtcbiAgaWYgKFxuICAgIHR5cGVvZiBhcmd1bWVudENvdW50ID09PSAnbnVtYmVyJyAmJiBhcmd1bWVudENvdW50ICE9PSBJbmZpbml0eVxuICApIHtcbiAgICByZXR1cm4gZGVub2RlaWZ5V2l0aENvdW50KGZuLCBhcmd1bWVudENvdW50KTtcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gZGVub2RlaWZ5V2l0aG91dENvdW50KGZuKTtcbiAgfVxufVxuXG52YXIgY2FsbGJhY2tGbiA9IChcbiAgJ2Z1bmN0aW9uIChlcnIsIHJlcykgeycgK1xuICAnaWYgKGVycikgeyByaihlcnIpOyB9IGVsc2UgeyBycyhyZXMpOyB9JyArXG4gICd9J1xuKTtcbmZ1bmN0aW9uIGRlbm9kZWlmeVdpdGhDb3VudChmbiwgYXJndW1lbnRDb3VudCkge1xuICB2YXIgYXJncyA9IFtdO1xuICBmb3IgKHZhciBpID0gMDsgaSA8IGFyZ3VtZW50Q291bnQ7IGkrKykge1xuICAgIGFyZ3MucHVzaCgnYScgKyBpKTtcbiAgfVxuICB2YXIgYm9keSA9IFtcbiAgICAncmV0dXJuIGZ1bmN0aW9uICgnICsgYXJncy5qb2luKCcsJykgKyAnKSB7JyxcbiAgICAndmFyIHNlbGYgPSB0aGlzOycsXG4gICAgJ3JldHVybiBuZXcgUHJvbWlzZShmdW5jdGlvbiAocnMsIHJqKSB7JyxcbiAgICAndmFyIHJlcyA9IGZuLmNhbGwoJyxcbiAgICBbJ3NlbGYnXS5jb25jYXQoYXJncykuY29uY2F0KFtjYWxsYmFja0ZuXSkuam9pbignLCcpLFxuICAgICcpOycsXG4gICAgJ2lmIChyZXMgJiYnLFxuICAgICcodHlwZW9mIHJlcyA9PT0gXCJvYmplY3RcIiB8fCB0eXBlb2YgcmVzID09PSBcImZ1bmN0aW9uXCIpICYmJyxcbiAgICAndHlwZW9mIHJlcy50aGVuID09PSBcImZ1bmN0aW9uXCInLFxuICAgICcpIHtycyhyZXMpO30nLFxuICAgICd9KTsnLFxuICAgICd9OydcbiAgXS5qb2luKCcnKTtcbiAgcmV0dXJuIEZ1bmN0aW9uKFsnUHJvbWlzZScsICdmbiddLCBib2R5KShQcm9taXNlLCBmbik7XG59XG5mdW5jdGlvbiBkZW5vZGVpZnlXaXRob3V0Q291bnQoZm4pIHtcbiAgdmFyIGZuTGVuZ3RoID0gTWF0aC5tYXgoZm4ubGVuZ3RoIC0gMSwgMyk7XG4gIHZhciBhcmdzID0gW107XG4gIGZvciAodmFyIGkgPSAwOyBpIDwgZm5MZW5ndGg7IGkrKykge1xuICAgIGFyZ3MucHVzaCgnYScgKyBpKTtcbiAgfVxuICB2YXIgYm9keSA9IFtcbiAgICAncmV0dXJuIGZ1bmN0aW9uICgnICsgYXJncy5qb2luKCcsJykgKyAnKSB7JyxcbiAgICAndmFyIHNlbGYgPSB0aGlzOycsXG4gICAgJ3ZhciBhcmdzOycsXG4gICAgJ3ZhciBhcmdMZW5ndGggPSBhcmd1bWVudHMubGVuZ3RoOycsXG4gICAgJ2lmIChhcmd1bWVudHMubGVuZ3RoID4gJyArIGZuTGVuZ3RoICsgJykgeycsXG4gICAgJ2FyZ3MgPSBuZXcgQXJyYXkoYXJndW1lbnRzLmxlbmd0aCArIDEpOycsXG4gICAgJ2ZvciAodmFyIGkgPSAwOyBpIDwgYXJndW1lbnRzLmxlbmd0aDsgaSsrKSB7JyxcbiAgICAnYXJnc1tpXSA9IGFyZ3VtZW50c1tpXTsnLFxuICAgICd9JyxcbiAgICAnfScsXG4gICAgJ3JldHVybiBuZXcgUHJvbWlzZShmdW5jdGlvbiAocnMsIHJqKSB7JyxcbiAgICAndmFyIGNiID0gJyArIGNhbGxiYWNrRm4gKyAnOycsXG4gICAgJ3ZhciByZXM7JyxcbiAgICAnc3dpdGNoIChhcmdMZW5ndGgpIHsnLFxuICAgIGFyZ3MuY29uY2F0KFsnZXh0cmEnXSkubWFwKGZ1bmN0aW9uIChfLCBpbmRleCkge1xuICAgICAgcmV0dXJuIChcbiAgICAgICAgJ2Nhc2UgJyArIChpbmRleCkgKyAnOicgK1xuICAgICAgICAncmVzID0gZm4uY2FsbCgnICsgWydzZWxmJ10uY29uY2F0KGFyZ3Muc2xpY2UoMCwgaW5kZXgpKS5jb25jYXQoJ2NiJykuam9pbignLCcpICsgJyk7JyArXG4gICAgICAgICdicmVhazsnXG4gICAgICApO1xuICAgIH0pLmpvaW4oJycpLFxuICAgICdkZWZhdWx0OicsXG4gICAgJ2FyZ3NbYXJnTGVuZ3RoXSA9IGNiOycsXG4gICAgJ3JlcyA9IGZuLmFwcGx5KHNlbGYsIGFyZ3MpOycsXG4gICAgJ30nLFxuICAgIFxuICAgICdpZiAocmVzICYmJyxcbiAgICAnKHR5cGVvZiByZXMgPT09IFwib2JqZWN0XCIgfHwgdHlwZW9mIHJlcyA9PT0gXCJmdW5jdGlvblwiKSAmJicsXG4gICAgJ3R5cGVvZiByZXMudGhlbiA9PT0gXCJmdW5jdGlvblwiJyxcbiAgICAnKSB7cnMocmVzKTt9JyxcbiAgICAnfSk7JyxcbiAgICAnfTsnXG4gIF0uam9pbignJyk7XG5cbiAgcmV0dXJuIEZ1bmN0aW9uKFxuICAgIFsnUHJvbWlzZScsICdmbiddLFxuICAgIGJvZHlcbiAgKShQcm9taXNlLCBmbik7XG59XG5cblByb21pc2Uubm9kZWlmeSA9IGZ1bmN0aW9uIChmbikge1xuICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgIHZhciBhcmdzID0gQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwoYXJndW1lbnRzKTtcbiAgICB2YXIgY2FsbGJhY2sgPVxuICAgICAgdHlwZW9mIGFyZ3NbYXJncy5sZW5ndGggLSAxXSA9PT0gJ2Z1bmN0aW9uJyA/IGFyZ3MucG9wKCkgOiBudWxsO1xuICAgIHZhciBjdHggPSB0aGlzO1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gZm4uYXBwbHkodGhpcywgYXJndW1lbnRzKS5ub2RlaWZ5KGNhbGxiYWNrLCBjdHgpO1xuICAgIH0gY2F0Y2ggKGV4KSB7XG4gICAgICBpZiAoY2FsbGJhY2sgPT09IG51bGwgfHwgdHlwZW9mIGNhbGxiYWNrID09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgIHJldHVybiBuZXcgUHJvbWlzZShmdW5jdGlvbiAocmVzb2x2ZSwgcmVqZWN0KSB7XG4gICAgICAgICAgcmVqZWN0KGV4KTtcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBhc2FwKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICBjYWxsYmFjay5jYWxsKGN0eCwgZXgpO1xuICAgICAgICB9KVxuICAgICAgfVxuICAgIH1cbiAgfVxufVxuXG5Qcm9taXNlLnByb3RvdHlwZS5ub2RlaWZ5ID0gZnVuY3Rpb24gKGNhbGxiYWNrLCBjdHgpIHtcbiAgaWYgKHR5cGVvZiBjYWxsYmFjayAhPSAnZnVuY3Rpb24nKSByZXR1cm4gdGhpcztcblxuICB0aGlzLnRoZW4oZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgYXNhcChmdW5jdGlvbiAoKSB7XG4gICAgICBjYWxsYmFjay5jYWxsKGN0eCwgbnVsbCwgdmFsdWUpO1xuICAgIH0pO1xuICB9LCBmdW5jdGlvbiAoZXJyKSB7XG4gICAgYXNhcChmdW5jdGlvbiAoKSB7XG4gICAgICBjYWxsYmFjay5jYWxsKGN0eCwgZXJyKTtcbiAgICB9KTtcbiAgfSk7XG59XG4iLCIndXNlIHN0cmljdCc7XG5cbnZhciBQcm9taXNlID0gcmVxdWlyZSgnLi9jb3JlLmpzJyk7XG5cbm1vZHVsZS5leHBvcnRzID0gUHJvbWlzZTtcblByb21pc2UuZW5hYmxlU3luY2hyb25vdXMgPSBmdW5jdGlvbiAoKSB7XG4gIFByb21pc2UucHJvdG90eXBlLmlzUGVuZGluZyA9IGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiB0aGlzLmdldFN0YXRlKCkgPT0gMDtcbiAgfTtcblxuICBQcm9taXNlLnByb3RvdHlwZS5pc0Z1bGZpbGxlZCA9IGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiB0aGlzLmdldFN0YXRlKCkgPT0gMTtcbiAgfTtcblxuICBQcm9taXNlLnByb3RvdHlwZS5pc1JlamVjdGVkID0gZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIHRoaXMuZ2V0U3RhdGUoKSA9PSAyO1xuICB9O1xuXG4gIFByb21pc2UucHJvdG90eXBlLmdldFZhbHVlID0gZnVuY3Rpb24gKCkge1xuICAgIGlmICh0aGlzLl84MSA9PT0gMykge1xuICAgICAgcmV0dXJuIHRoaXMuXzY1LmdldFZhbHVlKCk7XG4gICAgfVxuXG4gICAgaWYgKCF0aGlzLmlzRnVsZmlsbGVkKCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignQ2Fubm90IGdldCBhIHZhbHVlIG9mIGFuIHVuZnVsZmlsbGVkIHByb21pc2UuJyk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHRoaXMuXzY1O1xuICB9O1xuXG4gIFByb21pc2UucHJvdG90eXBlLmdldFJlYXNvbiA9IGZ1bmN0aW9uICgpIHtcbiAgICBpZiAodGhpcy5fODEgPT09IDMpIHtcbiAgICAgIHJldHVybiB0aGlzLl82NS5nZXRSZWFzb24oKTtcbiAgICB9XG5cbiAgICBpZiAoIXRoaXMuaXNSZWplY3RlZCgpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCBnZXQgYSByZWplY3Rpb24gcmVhc29uIG9mIGEgbm9uLXJlamVjdGVkIHByb21pc2UuJyk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHRoaXMuXzY1O1xuICB9O1xuXG4gIFByb21pc2UucHJvdG90eXBlLmdldFN0YXRlID0gZnVuY3Rpb24gKCkge1xuICAgIGlmICh0aGlzLl84MSA9PT0gMykge1xuICAgICAgcmV0dXJuIHRoaXMuXzY1LmdldFN0YXRlKCk7XG4gICAgfVxuICAgIGlmICh0aGlzLl84MSA9PT0gLTEgfHwgdGhpcy5fODEgPT09IC0yKSB7XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG5cbiAgICByZXR1cm4gdGhpcy5fODE7XG4gIH07XG59O1xuXG5Qcm9taXNlLmRpc2FibGVTeW5jaHJvbm91cyA9IGZ1bmN0aW9uKCkge1xuICBQcm9taXNlLnByb3RvdHlwZS5pc1BlbmRpbmcgPSB1bmRlZmluZWQ7XG4gIFByb21pc2UucHJvdG90eXBlLmlzRnVsZmlsbGVkID0gdW5kZWZpbmVkO1xuICBQcm9taXNlLnByb3RvdHlwZS5pc1JlamVjdGVkID0gdW5kZWZpbmVkO1xuICBQcm9taXNlLnByb3RvdHlwZS5nZXRWYWx1ZSA9IHVuZGVmaW5lZDtcbiAgUHJvbWlzZS5wcm90b3R5cGUuZ2V0UmVhc29uID0gdW5kZWZpbmVkO1xuICBQcm9taXNlLnByb3RvdHlwZS5nZXRTdGF0ZSA9IHVuZGVmaW5lZDtcbn07XG4iLCIndXNlIHN0cmljdCc7XG5cbnZhciBTdHJpbmdpZnkgPSByZXF1aXJlKCcuL3N0cmluZ2lmeScpO1xudmFyIFBhcnNlID0gcmVxdWlyZSgnLi9wYXJzZScpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IHtcbiAgICBzdHJpbmdpZnk6IFN0cmluZ2lmeSxcbiAgICBwYXJzZTogUGFyc2Vcbn07XG4iLCIndXNlIHN0cmljdCc7XG5cbnZhciBVdGlscyA9IHJlcXVpcmUoJy4vdXRpbHMnKTtcblxudmFyIGRlZmF1bHRzID0ge1xuICAgIGRlbGltaXRlcjogJyYnLFxuICAgIGRlcHRoOiA1LFxuICAgIGFycmF5TGltaXQ6IDIwLFxuICAgIHBhcmFtZXRlckxpbWl0OiAxMDAwLFxuICAgIHN0cmljdE51bGxIYW5kbGluZzogZmFsc2UsXG4gICAgcGxhaW5PYmplY3RzOiBmYWxzZSxcbiAgICBhbGxvd1Byb3RvdHlwZXM6IGZhbHNlLFxuICAgIGFsbG93RG90czogZmFsc2UsXG4gICAgZGVjb2RlcjogVXRpbHMuZGVjb2RlXG59O1xuXG52YXIgcGFyc2VWYWx1ZXMgPSBmdW5jdGlvbiBwYXJzZVZhbHVlcyhzdHIsIG9wdGlvbnMpIHtcbiAgICB2YXIgb2JqID0ge307XG4gICAgdmFyIHBhcnRzID0gc3RyLnNwbGl0KG9wdGlvbnMuZGVsaW1pdGVyLCBvcHRpb25zLnBhcmFtZXRlckxpbWl0ID09PSBJbmZpbml0eSA/IHVuZGVmaW5lZCA6IG9wdGlvbnMucGFyYW1ldGVyTGltaXQpO1xuXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBwYXJ0cy5sZW5ndGg7ICsraSkge1xuICAgICAgICB2YXIgcGFydCA9IHBhcnRzW2ldO1xuICAgICAgICB2YXIgcG9zID0gcGFydC5pbmRleE9mKCddPScpID09PSAtMSA/IHBhcnQuaW5kZXhPZignPScpIDogcGFydC5pbmRleE9mKCddPScpICsgMTtcblxuICAgICAgICBpZiAocG9zID09PSAtMSkge1xuICAgICAgICAgICAgb2JqW29wdGlvbnMuZGVjb2RlcihwYXJ0KV0gPSAnJztcblxuICAgICAgICAgICAgaWYgKG9wdGlvbnMuc3RyaWN0TnVsbEhhbmRsaW5nKSB7XG4gICAgICAgICAgICAgICAgb2JqW29wdGlvbnMuZGVjb2RlcihwYXJ0KV0gPSBudWxsO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdmFyIGtleSA9IG9wdGlvbnMuZGVjb2RlcihwYXJ0LnNsaWNlKDAsIHBvcykpO1xuICAgICAgICAgICAgdmFyIHZhbCA9IG9wdGlvbnMuZGVjb2RlcihwYXJ0LnNsaWNlKHBvcyArIDEpKTtcblxuICAgICAgICAgICAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChvYmosIGtleSkpIHtcbiAgICAgICAgICAgICAgICBvYmpba2V5XSA9IFtdLmNvbmNhdChvYmpba2V5XSkuY29uY2F0KHZhbCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIG9ialtrZXldID0gdmFsO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIG9iajtcbn07XG5cbnZhciBwYXJzZU9iamVjdCA9IGZ1bmN0aW9uIHBhcnNlT2JqZWN0KGNoYWluLCB2YWwsIG9wdGlvbnMpIHtcbiAgICBpZiAoIWNoYWluLmxlbmd0aCkge1xuICAgICAgICByZXR1cm4gdmFsO1xuICAgIH1cblxuICAgIHZhciByb290ID0gY2hhaW4uc2hpZnQoKTtcblxuICAgIHZhciBvYmo7XG4gICAgaWYgKHJvb3QgPT09ICdbXScpIHtcbiAgICAgICAgb2JqID0gW107XG4gICAgICAgIG9iaiA9IG9iai5jb25jYXQocGFyc2VPYmplY3QoY2hhaW4sIHZhbCwgb3B0aW9ucykpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIG9iaiA9IG9wdGlvbnMucGxhaW5PYmplY3RzID8gT2JqZWN0LmNyZWF0ZShudWxsKSA6IHt9O1xuICAgICAgICB2YXIgY2xlYW5Sb290ID0gcm9vdFswXSA9PT0gJ1snICYmIHJvb3Rbcm9vdC5sZW5ndGggLSAxXSA9PT0gJ10nID8gcm9vdC5zbGljZSgxLCByb290Lmxlbmd0aCAtIDEpIDogcm9vdDtcbiAgICAgICAgdmFyIGluZGV4ID0gcGFyc2VJbnQoY2xlYW5Sb290LCAxMCk7XG4gICAgICAgIGlmIChcbiAgICAgICAgICAgICFpc05hTihpbmRleCkgJiZcbiAgICAgICAgICAgIHJvb3QgIT09IGNsZWFuUm9vdCAmJlxuICAgICAgICAgICAgU3RyaW5nKGluZGV4KSA9PT0gY2xlYW5Sb290ICYmXG4gICAgICAgICAgICBpbmRleCA+PSAwICYmXG4gICAgICAgICAgICAob3B0aW9ucy5wYXJzZUFycmF5cyAmJiBpbmRleCA8PSBvcHRpb25zLmFycmF5TGltaXQpXG4gICAgICAgICkge1xuICAgICAgICAgICAgb2JqID0gW107XG4gICAgICAgICAgICBvYmpbaW5kZXhdID0gcGFyc2VPYmplY3QoY2hhaW4sIHZhbCwgb3B0aW9ucyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBvYmpbY2xlYW5Sb290XSA9IHBhcnNlT2JqZWN0KGNoYWluLCB2YWwsIG9wdGlvbnMpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIG9iajtcbn07XG5cbnZhciBwYXJzZUtleXMgPSBmdW5jdGlvbiBwYXJzZUtleXMoZ2l2ZW5LZXksIHZhbCwgb3B0aW9ucykge1xuICAgIGlmICghZ2l2ZW5LZXkpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIFRyYW5zZm9ybSBkb3Qgbm90YXRpb24gdG8gYnJhY2tldCBub3RhdGlvblxuICAgIHZhciBrZXkgPSBvcHRpb25zLmFsbG93RG90cyA/IGdpdmVuS2V5LnJlcGxhY2UoL1xcLihbXlxcLlxcW10rKS9nLCAnWyQxXScpIDogZ2l2ZW5LZXk7XG5cbiAgICAvLyBUaGUgcmVnZXggY2h1bmtzXG5cbiAgICB2YXIgcGFyZW50ID0gL14oW15cXFtcXF1dKikvO1xuICAgIHZhciBjaGlsZCA9IC8oXFxbW15cXFtcXF1dKlxcXSkvZztcblxuICAgIC8vIEdldCB0aGUgcGFyZW50XG5cbiAgICB2YXIgc2VnbWVudCA9IHBhcmVudC5leGVjKGtleSk7XG5cbiAgICAvLyBTdGFzaCB0aGUgcGFyZW50IGlmIGl0IGV4aXN0c1xuXG4gICAgdmFyIGtleXMgPSBbXTtcbiAgICBpZiAoc2VnbWVudFsxXSkge1xuICAgICAgICAvLyBJZiB3ZSBhcmVuJ3QgdXNpbmcgcGxhaW4gb2JqZWN0cywgb3B0aW9uYWxseSBwcmVmaXgga2V5c1xuICAgICAgICAvLyB0aGF0IHdvdWxkIG92ZXJ3cml0ZSBvYmplY3QgcHJvdG90eXBlIHByb3BlcnRpZXNcbiAgICAgICAgaWYgKCFvcHRpb25zLnBsYWluT2JqZWN0cyAmJiBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5KHNlZ21lbnRbMV0pKSB7XG4gICAgICAgICAgICBpZiAoIW9wdGlvbnMuYWxsb3dQcm90b3R5cGVzKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAga2V5cy5wdXNoKHNlZ21lbnRbMV0pO1xuICAgIH1cblxuICAgIC8vIExvb3AgdGhyb3VnaCBjaGlsZHJlbiBhcHBlbmRpbmcgdG8gdGhlIGFycmF5IHVudGlsIHdlIGhpdCBkZXB0aFxuXG4gICAgdmFyIGkgPSAwO1xuICAgIHdoaWxlICgoc2VnbWVudCA9IGNoaWxkLmV4ZWMoa2V5KSkgIT09IG51bGwgJiYgaSA8IG9wdGlvbnMuZGVwdGgpIHtcbiAgICAgICAgaSArPSAxO1xuICAgICAgICBpZiAoIW9wdGlvbnMucGxhaW5PYmplY3RzICYmIE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkoc2VnbWVudFsxXS5yZXBsYWNlKC9cXFt8XFxdL2csICcnKSkpIHtcbiAgICAgICAgICAgIGlmICghb3B0aW9ucy5hbGxvd1Byb3RvdHlwZXMpIHtcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBrZXlzLnB1c2goc2VnbWVudFsxXSk7XG4gICAgfVxuXG4gICAgLy8gSWYgdGhlcmUncyBhIHJlbWFpbmRlciwganVzdCBhZGQgd2hhdGV2ZXIgaXMgbGVmdFxuXG4gICAgaWYgKHNlZ21lbnQpIHtcbiAgICAgICAga2V5cy5wdXNoKCdbJyArIGtleS5zbGljZShzZWdtZW50LmluZGV4KSArICddJyk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHBhcnNlT2JqZWN0KGtleXMsIHZhbCwgb3B0aW9ucyk7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIChzdHIsIG9wdHMpIHtcbiAgICB2YXIgb3B0aW9ucyA9IG9wdHMgfHwge307XG5cbiAgICBpZiAob3B0aW9ucy5kZWNvZGVyICE9PSBudWxsICYmIG9wdGlvbnMuZGVjb2RlciAhPT0gdW5kZWZpbmVkICYmIHR5cGVvZiBvcHRpb25zLmRlY29kZXIgIT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignRGVjb2RlciBoYXMgdG8gYmUgYSBmdW5jdGlvbi4nKTtcbiAgICB9XG5cbiAgICBvcHRpb25zLmRlbGltaXRlciA9IHR5cGVvZiBvcHRpb25zLmRlbGltaXRlciA9PT0gJ3N0cmluZycgfHwgVXRpbHMuaXNSZWdFeHAob3B0aW9ucy5kZWxpbWl0ZXIpID8gb3B0aW9ucy5kZWxpbWl0ZXIgOiBkZWZhdWx0cy5kZWxpbWl0ZXI7XG4gICAgb3B0aW9ucy5kZXB0aCA9IHR5cGVvZiBvcHRpb25zLmRlcHRoID09PSAnbnVtYmVyJyA/IG9wdGlvbnMuZGVwdGggOiBkZWZhdWx0cy5kZXB0aDtcbiAgICBvcHRpb25zLmFycmF5TGltaXQgPSB0eXBlb2Ygb3B0aW9ucy5hcnJheUxpbWl0ID09PSAnbnVtYmVyJyA/IG9wdGlvbnMuYXJyYXlMaW1pdCA6IGRlZmF1bHRzLmFycmF5TGltaXQ7XG4gICAgb3B0aW9ucy5wYXJzZUFycmF5cyA9IG9wdGlvbnMucGFyc2VBcnJheXMgIT09IGZhbHNlO1xuICAgIG9wdGlvbnMuZGVjb2RlciA9IHR5cGVvZiBvcHRpb25zLmRlY29kZXIgPT09ICdmdW5jdGlvbicgPyBvcHRpb25zLmRlY29kZXIgOiBkZWZhdWx0cy5kZWNvZGVyO1xuICAgIG9wdGlvbnMuYWxsb3dEb3RzID0gdHlwZW9mIG9wdGlvbnMuYWxsb3dEb3RzID09PSAnYm9vbGVhbicgPyBvcHRpb25zLmFsbG93RG90cyA6IGRlZmF1bHRzLmFsbG93RG90cztcbiAgICBvcHRpb25zLnBsYWluT2JqZWN0cyA9IHR5cGVvZiBvcHRpb25zLnBsYWluT2JqZWN0cyA9PT0gJ2Jvb2xlYW4nID8gb3B0aW9ucy5wbGFpbk9iamVjdHMgOiBkZWZhdWx0cy5wbGFpbk9iamVjdHM7XG4gICAgb3B0aW9ucy5hbGxvd1Byb3RvdHlwZXMgPSB0eXBlb2Ygb3B0aW9ucy5hbGxvd1Byb3RvdHlwZXMgPT09ICdib29sZWFuJyA/IG9wdGlvbnMuYWxsb3dQcm90b3R5cGVzIDogZGVmYXVsdHMuYWxsb3dQcm90b3R5cGVzO1xuICAgIG9wdGlvbnMucGFyYW1ldGVyTGltaXQgPSB0eXBlb2Ygb3B0aW9ucy5wYXJhbWV0ZXJMaW1pdCA9PT0gJ251bWJlcicgPyBvcHRpb25zLnBhcmFtZXRlckxpbWl0IDogZGVmYXVsdHMucGFyYW1ldGVyTGltaXQ7XG4gICAgb3B0aW9ucy5zdHJpY3ROdWxsSGFuZGxpbmcgPSB0eXBlb2Ygb3B0aW9ucy5zdHJpY3ROdWxsSGFuZGxpbmcgPT09ICdib29sZWFuJyA/IG9wdGlvbnMuc3RyaWN0TnVsbEhhbmRsaW5nIDogZGVmYXVsdHMuc3RyaWN0TnVsbEhhbmRsaW5nO1xuXG4gICAgaWYgKHN0ciA9PT0gJycgfHwgc3RyID09PSBudWxsIHx8IHR5cGVvZiBzdHIgPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgIHJldHVybiBvcHRpb25zLnBsYWluT2JqZWN0cyA/IE9iamVjdC5jcmVhdGUobnVsbCkgOiB7fTtcbiAgICB9XG5cbiAgICB2YXIgdGVtcE9iaiA9IHR5cGVvZiBzdHIgPT09ICdzdHJpbmcnID8gcGFyc2VWYWx1ZXMoc3RyLCBvcHRpb25zKSA6IHN0cjtcbiAgICB2YXIgb2JqID0gb3B0aW9ucy5wbGFpbk9iamVjdHMgPyBPYmplY3QuY3JlYXRlKG51bGwpIDoge307XG5cbiAgICAvLyBJdGVyYXRlIG92ZXIgdGhlIGtleXMgYW5kIHNldHVwIHRoZSBuZXcgb2JqZWN0XG5cbiAgICB2YXIga2V5cyA9IE9iamVjdC5rZXlzKHRlbXBPYmopO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwga2V5cy5sZW5ndGg7ICsraSkge1xuICAgICAgICB2YXIga2V5ID0ga2V5c1tpXTtcbiAgICAgICAgdmFyIG5ld09iaiA9IHBhcnNlS2V5cyhrZXksIHRlbXBPYmpba2V5XSwgb3B0aW9ucyk7XG4gICAgICAgIG9iaiA9IFV0aWxzLm1lcmdlKG9iaiwgbmV3T2JqLCBvcHRpb25zKTtcbiAgICB9XG5cbiAgICByZXR1cm4gVXRpbHMuY29tcGFjdChvYmopO1xufTtcbiIsIid1c2Ugc3RyaWN0JztcblxudmFyIFV0aWxzID0gcmVxdWlyZSgnLi91dGlscycpO1xuXG52YXIgYXJyYXlQcmVmaXhHZW5lcmF0b3JzID0ge1xuICAgIGJyYWNrZXRzOiBmdW5jdGlvbiBicmFja2V0cyhwcmVmaXgpIHtcbiAgICAgICAgcmV0dXJuIHByZWZpeCArICdbXSc7XG4gICAgfSxcbiAgICBpbmRpY2VzOiBmdW5jdGlvbiBpbmRpY2VzKHByZWZpeCwga2V5KSB7XG4gICAgICAgIHJldHVybiBwcmVmaXggKyAnWycgKyBrZXkgKyAnXSc7XG4gICAgfSxcbiAgICByZXBlYXQ6IGZ1bmN0aW9uIHJlcGVhdChwcmVmaXgpIHtcbiAgICAgICAgcmV0dXJuIHByZWZpeDtcbiAgICB9XG59O1xuXG52YXIgZGVmYXVsdHMgPSB7XG4gICAgZGVsaW1pdGVyOiAnJicsXG4gICAgc3RyaWN0TnVsbEhhbmRsaW5nOiBmYWxzZSxcbiAgICBza2lwTnVsbHM6IGZhbHNlLFxuICAgIGVuY29kZTogdHJ1ZSxcbiAgICBlbmNvZGVyOiBVdGlscy5lbmNvZGVcbn07XG5cbnZhciBzdHJpbmdpZnkgPSBmdW5jdGlvbiBzdHJpbmdpZnkob2JqZWN0LCBwcmVmaXgsIGdlbmVyYXRlQXJyYXlQcmVmaXgsIHN0cmljdE51bGxIYW5kbGluZywgc2tpcE51bGxzLCBlbmNvZGVyLCBmaWx0ZXIsIHNvcnQsIGFsbG93RG90cykge1xuICAgIHZhciBvYmogPSBvYmplY3Q7XG4gICAgaWYgKHR5cGVvZiBmaWx0ZXIgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgb2JqID0gZmlsdGVyKHByZWZpeCwgb2JqKTtcbiAgICB9IGVsc2UgaWYgKG9iaiBpbnN0YW5jZW9mIERhdGUpIHtcbiAgICAgICAgb2JqID0gb2JqLnRvSVNPU3RyaW5nKCk7XG4gICAgfSBlbHNlIGlmIChvYmogPT09IG51bGwpIHtcbiAgICAgICAgaWYgKHN0cmljdE51bGxIYW5kbGluZykge1xuICAgICAgICAgICAgcmV0dXJuIGVuY29kZXIgPyBlbmNvZGVyKHByZWZpeCkgOiBwcmVmaXg7XG4gICAgICAgIH1cblxuICAgICAgICBvYmogPSAnJztcbiAgICB9XG5cbiAgICBpZiAodHlwZW9mIG9iaiA9PT0gJ3N0cmluZycgfHwgdHlwZW9mIG9iaiA9PT0gJ251bWJlcicgfHwgdHlwZW9mIG9iaiA9PT0gJ2Jvb2xlYW4nIHx8IFV0aWxzLmlzQnVmZmVyKG9iaikpIHtcbiAgICAgICAgaWYgKGVuY29kZXIpIHtcbiAgICAgICAgICAgIHJldHVybiBbZW5jb2RlcihwcmVmaXgpICsgJz0nICsgZW5jb2RlcihvYmopXTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gW3ByZWZpeCArICc9JyArIFN0cmluZyhvYmopXTtcbiAgICB9XG5cbiAgICB2YXIgdmFsdWVzID0gW107XG5cbiAgICBpZiAodHlwZW9mIG9iaiA9PT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgcmV0dXJuIHZhbHVlcztcbiAgICB9XG5cbiAgICB2YXIgb2JqS2V5cztcbiAgICBpZiAoQXJyYXkuaXNBcnJheShmaWx0ZXIpKSB7XG4gICAgICAgIG9iaktleXMgPSBmaWx0ZXI7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgdmFyIGtleXMgPSBPYmplY3Qua2V5cyhvYmopO1xuICAgICAgICBvYmpLZXlzID0gc29ydCA/IGtleXMuc29ydChzb3J0KSA6IGtleXM7XG4gICAgfVxuXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBvYmpLZXlzLmxlbmd0aDsgKytpKSB7XG4gICAgICAgIHZhciBrZXkgPSBvYmpLZXlzW2ldO1xuXG4gICAgICAgIGlmIChza2lwTnVsbHMgJiYgb2JqW2tleV0gPT09IG51bGwpIHtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkob2JqKSkge1xuICAgICAgICAgICAgdmFsdWVzID0gdmFsdWVzLmNvbmNhdChzdHJpbmdpZnkob2JqW2tleV0sIGdlbmVyYXRlQXJyYXlQcmVmaXgocHJlZml4LCBrZXkpLCBnZW5lcmF0ZUFycmF5UHJlZml4LCBzdHJpY3ROdWxsSGFuZGxpbmcsIHNraXBOdWxscywgZW5jb2RlciwgZmlsdGVyLCBzb3J0LCBhbGxvd0RvdHMpKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHZhbHVlcyA9IHZhbHVlcy5jb25jYXQoc3RyaW5naWZ5KG9ialtrZXldLCBwcmVmaXggKyAoYWxsb3dEb3RzID8gJy4nICsga2V5IDogJ1snICsga2V5ICsgJ10nKSwgZ2VuZXJhdGVBcnJheVByZWZpeCwgc3RyaWN0TnVsbEhhbmRsaW5nLCBza2lwTnVsbHMsIGVuY29kZXIsIGZpbHRlciwgc29ydCwgYWxsb3dEb3RzKSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gdmFsdWVzO1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAob2JqZWN0LCBvcHRzKSB7XG4gICAgdmFyIG9iaiA9IG9iamVjdDtcbiAgICB2YXIgb3B0aW9ucyA9IG9wdHMgfHwge307XG4gICAgdmFyIGRlbGltaXRlciA9IHR5cGVvZiBvcHRpb25zLmRlbGltaXRlciA9PT0gJ3VuZGVmaW5lZCcgPyBkZWZhdWx0cy5kZWxpbWl0ZXIgOiBvcHRpb25zLmRlbGltaXRlcjtcbiAgICB2YXIgc3RyaWN0TnVsbEhhbmRsaW5nID0gdHlwZW9mIG9wdGlvbnMuc3RyaWN0TnVsbEhhbmRsaW5nID09PSAnYm9vbGVhbicgPyBvcHRpb25zLnN0cmljdE51bGxIYW5kbGluZyA6IGRlZmF1bHRzLnN0cmljdE51bGxIYW5kbGluZztcbiAgICB2YXIgc2tpcE51bGxzID0gdHlwZW9mIG9wdGlvbnMuc2tpcE51bGxzID09PSAnYm9vbGVhbicgPyBvcHRpb25zLnNraXBOdWxscyA6IGRlZmF1bHRzLnNraXBOdWxscztcbiAgICB2YXIgZW5jb2RlID0gdHlwZW9mIG9wdGlvbnMuZW5jb2RlID09PSAnYm9vbGVhbicgPyBvcHRpb25zLmVuY29kZSA6IGRlZmF1bHRzLmVuY29kZTtcbiAgICB2YXIgZW5jb2RlciA9IGVuY29kZSA/ICh0eXBlb2Ygb3B0aW9ucy5lbmNvZGVyID09PSAnZnVuY3Rpb24nID8gb3B0aW9ucy5lbmNvZGVyIDogZGVmYXVsdHMuZW5jb2RlcikgOiBudWxsO1xuICAgIHZhciBzb3J0ID0gdHlwZW9mIG9wdGlvbnMuc29ydCA9PT0gJ2Z1bmN0aW9uJyA/IG9wdGlvbnMuc29ydCA6IG51bGw7XG4gICAgdmFyIGFsbG93RG90cyA9IHR5cGVvZiBvcHRpb25zLmFsbG93RG90cyA9PT0gJ3VuZGVmaW5lZCcgPyBmYWxzZSA6IG9wdGlvbnMuYWxsb3dEb3RzO1xuICAgIHZhciBvYmpLZXlzO1xuICAgIHZhciBmaWx0ZXI7XG5cbiAgICBpZiAob3B0aW9ucy5lbmNvZGVyICE9PSBudWxsICYmIG9wdGlvbnMuZW5jb2RlciAhPT0gdW5kZWZpbmVkICYmIHR5cGVvZiBvcHRpb25zLmVuY29kZXIgIT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignRW5jb2RlciBoYXMgdG8gYmUgYSBmdW5jdGlvbi4nKTtcbiAgICB9XG5cbiAgICBpZiAodHlwZW9mIG9wdGlvbnMuZmlsdGVyID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIGZpbHRlciA9IG9wdGlvbnMuZmlsdGVyO1xuICAgICAgICBvYmogPSBmaWx0ZXIoJycsIG9iaik7XG4gICAgfSBlbHNlIGlmIChBcnJheS5pc0FycmF5KG9wdGlvbnMuZmlsdGVyKSkge1xuICAgICAgICBvYmpLZXlzID0gZmlsdGVyID0gb3B0aW9ucy5maWx0ZXI7XG4gICAgfVxuXG4gICAgdmFyIGtleXMgPSBbXTtcblxuICAgIGlmICh0eXBlb2Ygb2JqICE9PSAnb2JqZWN0JyB8fCBvYmogPT09IG51bGwpIHtcbiAgICAgICAgcmV0dXJuICcnO1xuICAgIH1cblxuICAgIHZhciBhcnJheUZvcm1hdDtcbiAgICBpZiAob3B0aW9ucy5hcnJheUZvcm1hdCBpbiBhcnJheVByZWZpeEdlbmVyYXRvcnMpIHtcbiAgICAgICAgYXJyYXlGb3JtYXQgPSBvcHRpb25zLmFycmF5Rm9ybWF0O1xuICAgIH0gZWxzZSBpZiAoJ2luZGljZXMnIGluIG9wdGlvbnMpIHtcbiAgICAgICAgYXJyYXlGb3JtYXQgPSBvcHRpb25zLmluZGljZXMgPyAnaW5kaWNlcycgOiAncmVwZWF0JztcbiAgICB9IGVsc2Uge1xuICAgICAgICBhcnJheUZvcm1hdCA9ICdpbmRpY2VzJztcbiAgICB9XG5cbiAgICB2YXIgZ2VuZXJhdGVBcnJheVByZWZpeCA9IGFycmF5UHJlZml4R2VuZXJhdG9yc1thcnJheUZvcm1hdF07XG5cbiAgICBpZiAoIW9iaktleXMpIHtcbiAgICAgICAgb2JqS2V5cyA9IE9iamVjdC5rZXlzKG9iaik7XG4gICAgfVxuXG4gICAgaWYgKHNvcnQpIHtcbiAgICAgICAgb2JqS2V5cy5zb3J0KHNvcnQpO1xuICAgIH1cblxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgb2JqS2V5cy5sZW5ndGg7ICsraSkge1xuICAgICAgICB2YXIga2V5ID0gb2JqS2V5c1tpXTtcblxuICAgICAgICBpZiAoc2tpcE51bGxzICYmIG9ialtrZXldID09PSBudWxsKSB7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGtleXMgPSBrZXlzLmNvbmNhdChzdHJpbmdpZnkob2JqW2tleV0sIGtleSwgZ2VuZXJhdGVBcnJheVByZWZpeCwgc3RyaWN0TnVsbEhhbmRsaW5nLCBza2lwTnVsbHMsIGVuY29kZXIsIGZpbHRlciwgc29ydCwgYWxsb3dEb3RzKSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGtleXMuam9pbihkZWxpbWl0ZXIpO1xufTtcbiIsIid1c2Ugc3RyaWN0JztcblxudmFyIGhleFRhYmxlID0gKGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgYXJyYXkgPSBuZXcgQXJyYXkoMjU2KTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IDI1NjsgKytpKSB7XG4gICAgICAgIGFycmF5W2ldID0gJyUnICsgKChpIDwgMTYgPyAnMCcgOiAnJykgKyBpLnRvU3RyaW5nKDE2KSkudG9VcHBlckNhc2UoKTtcbiAgICB9XG5cbiAgICByZXR1cm4gYXJyYXk7XG59KCkpO1xuXG5leHBvcnRzLmFycmF5VG9PYmplY3QgPSBmdW5jdGlvbiAoc291cmNlLCBvcHRpb25zKSB7XG4gICAgdmFyIG9iaiA9IG9wdGlvbnMucGxhaW5PYmplY3RzID8gT2JqZWN0LmNyZWF0ZShudWxsKSA6IHt9O1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgc291cmNlLmxlbmd0aDsgKytpKSB7XG4gICAgICAgIGlmICh0eXBlb2Ygc291cmNlW2ldICE9PSAndW5kZWZpbmVkJykge1xuICAgICAgICAgICAgb2JqW2ldID0gc291cmNlW2ldO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIG9iajtcbn07XG5cbmV4cG9ydHMubWVyZ2UgPSBmdW5jdGlvbiAodGFyZ2V0LCBzb3VyY2UsIG9wdGlvbnMpIHtcbiAgICBpZiAoIXNvdXJjZSkge1xuICAgICAgICByZXR1cm4gdGFyZ2V0O1xuICAgIH1cblxuICAgIGlmICh0eXBlb2Ygc291cmNlICE9PSAnb2JqZWN0Jykge1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh0YXJnZXQpKSB7XG4gICAgICAgICAgICB0YXJnZXQucHVzaChzb3VyY2UpO1xuICAgICAgICB9IGVsc2UgaWYgKHR5cGVvZiB0YXJnZXQgPT09ICdvYmplY3QnKSB7XG4gICAgICAgICAgICB0YXJnZXRbc291cmNlXSA9IHRydWU7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICByZXR1cm4gW3RhcmdldCwgc291cmNlXTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0YXJnZXQ7XG4gICAgfVxuXG4gICAgaWYgKHR5cGVvZiB0YXJnZXQgIT09ICdvYmplY3QnKSB7XG4gICAgICAgIHJldHVybiBbdGFyZ2V0XS5jb25jYXQoc291cmNlKTtcbiAgICB9XG5cbiAgICB2YXIgbWVyZ2VUYXJnZXQgPSB0YXJnZXQ7XG4gICAgaWYgKEFycmF5LmlzQXJyYXkodGFyZ2V0KSAmJiAhQXJyYXkuaXNBcnJheShzb3VyY2UpKSB7XG4gICAgICAgIG1lcmdlVGFyZ2V0ID0gZXhwb3J0cy5hcnJheVRvT2JqZWN0KHRhcmdldCwgb3B0aW9ucyk7XG4gICAgfVxuXG4gICAgcmV0dXJuIE9iamVjdC5rZXlzKHNvdXJjZSkucmVkdWNlKGZ1bmN0aW9uIChhY2MsIGtleSkge1xuICAgICAgICB2YXIgdmFsdWUgPSBzb3VyY2Vba2V5XTtcblxuICAgICAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGFjYywga2V5KSkge1xuICAgICAgICAgICAgYWNjW2tleV0gPSBleHBvcnRzLm1lcmdlKGFjY1trZXldLCB2YWx1ZSwgb3B0aW9ucyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBhY2Nba2V5XSA9IHZhbHVlO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBhY2M7XG4gICAgfSwgbWVyZ2VUYXJnZXQpO1xufTtcblxuZXhwb3J0cy5kZWNvZGUgPSBmdW5jdGlvbiAoc3RyKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgcmV0dXJuIGRlY29kZVVSSUNvbXBvbmVudChzdHIucmVwbGFjZSgvXFwrL2csICcgJykpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgcmV0dXJuIHN0cjtcbiAgICB9XG59O1xuXG5leHBvcnRzLmVuY29kZSA9IGZ1bmN0aW9uIChzdHIpIHtcbiAgICAvLyBUaGlzIGNvZGUgd2FzIG9yaWdpbmFsbHkgd3JpdHRlbiBieSBCcmlhbiBXaGl0ZSAobXNjZGV4KSBmb3IgdGhlIGlvLmpzIGNvcmUgcXVlcnlzdHJpbmcgbGlicmFyeS5cbiAgICAvLyBJdCBoYXMgYmVlbiBhZGFwdGVkIGhlcmUgZm9yIHN0cmljdGVyIGFkaGVyZW5jZSB0byBSRkMgMzk4NlxuICAgIGlmIChzdHIubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHJldHVybiBzdHI7XG4gICAgfVxuXG4gICAgdmFyIHN0cmluZyA9IHR5cGVvZiBzdHIgPT09ICdzdHJpbmcnID8gc3RyIDogU3RyaW5nKHN0cik7XG5cbiAgICB2YXIgb3V0ID0gJyc7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBzdHJpbmcubGVuZ3RoOyArK2kpIHtcbiAgICAgICAgdmFyIGMgPSBzdHJpbmcuY2hhckNvZGVBdChpKTtcblxuICAgICAgICBpZiAoXG4gICAgICAgICAgICBjID09PSAweDJEIHx8IC8vIC1cbiAgICAgICAgICAgIGMgPT09IDB4MkUgfHwgLy8gLlxuICAgICAgICAgICAgYyA9PT0gMHg1RiB8fCAvLyBfXG4gICAgICAgICAgICBjID09PSAweDdFIHx8IC8vIH5cbiAgICAgICAgICAgIChjID49IDB4MzAgJiYgYyA8PSAweDM5KSB8fCAvLyAwLTlcbiAgICAgICAgICAgIChjID49IDB4NDEgJiYgYyA8PSAweDVBKSB8fCAvLyBhLXpcbiAgICAgICAgICAgIChjID49IDB4NjEgJiYgYyA8PSAweDdBKSAvLyBBLVpcbiAgICAgICAgKSB7XG4gICAgICAgICAgICBvdXQgKz0gc3RyaW5nLmNoYXJBdChpKTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGMgPCAweDgwKSB7XG4gICAgICAgICAgICBvdXQgPSBvdXQgKyBoZXhUYWJsZVtjXTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGMgPCAweDgwMCkge1xuICAgICAgICAgICAgb3V0ID0gb3V0ICsgKGhleFRhYmxlWzB4QzAgfCAoYyA+PiA2KV0gKyBoZXhUYWJsZVsweDgwIHwgKGMgJiAweDNGKV0pO1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoYyA8IDB4RDgwMCB8fCBjID49IDB4RTAwMCkge1xuICAgICAgICAgICAgb3V0ID0gb3V0ICsgKGhleFRhYmxlWzB4RTAgfCAoYyA+PiAxMildICsgaGV4VGFibGVbMHg4MCB8ICgoYyA+PiA2KSAmIDB4M0YpXSArIGhleFRhYmxlWzB4ODAgfCAoYyAmIDB4M0YpXSk7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGkgKz0gMTtcbiAgICAgICAgYyA9IDB4MTAwMDAgKyAoKChjICYgMHgzRkYpIDw8IDEwKSB8IChzdHJpbmcuY2hhckNvZGVBdChpKSAmIDB4M0ZGKSk7XG4gICAgICAgIG91dCArPSBoZXhUYWJsZVsweEYwIHwgKGMgPj4gMTgpXSArIGhleFRhYmxlWzB4ODAgfCAoKGMgPj4gMTIpICYgMHgzRildICsgaGV4VGFibGVbMHg4MCB8ICgoYyA+PiA2KSAmIDB4M0YpXSArIGhleFRhYmxlWzB4ODAgfCAoYyAmIDB4M0YpXTtcbiAgICB9XG5cbiAgICByZXR1cm4gb3V0O1xufTtcblxuZXhwb3J0cy5jb21wYWN0ID0gZnVuY3Rpb24gKG9iaiwgcmVmZXJlbmNlcykge1xuICAgIGlmICh0eXBlb2Ygb2JqICE9PSAnb2JqZWN0JyB8fCBvYmogPT09IG51bGwpIHtcbiAgICAgICAgcmV0dXJuIG9iajtcbiAgICB9XG5cbiAgICB2YXIgcmVmcyA9IHJlZmVyZW5jZXMgfHwgW107XG4gICAgdmFyIGxvb2t1cCA9IHJlZnMuaW5kZXhPZihvYmopO1xuICAgIGlmIChsb29rdXAgIT09IC0xKSB7XG4gICAgICAgIHJldHVybiByZWZzW2xvb2t1cF07XG4gICAgfVxuXG4gICAgcmVmcy5wdXNoKG9iaik7XG5cbiAgICBpZiAoQXJyYXkuaXNBcnJheShvYmopKSB7XG4gICAgICAgIHZhciBjb21wYWN0ZWQgPSBbXTtcblxuICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IG9iai5sZW5ndGg7ICsraSkge1xuICAgICAgICAgICAgaWYgKG9ialtpXSAmJiB0eXBlb2Ygb2JqW2ldID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgICAgIGNvbXBhY3RlZC5wdXNoKGV4cG9ydHMuY29tcGFjdChvYmpbaV0sIHJlZnMpKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAodHlwZW9mIG9ialtpXSAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgICAgICAgICBjb21wYWN0ZWQucHVzaChvYmpbaV0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGNvbXBhY3RlZDtcbiAgICB9XG5cbiAgICB2YXIga2V5cyA9IE9iamVjdC5rZXlzKG9iaik7XG4gICAgZm9yICh2YXIgaiA9IDA7IGogPCBrZXlzLmxlbmd0aDsgKytqKSB7XG4gICAgICAgIHZhciBrZXkgPSBrZXlzW2pdO1xuICAgICAgICBvYmpba2V5XSA9IGV4cG9ydHMuY29tcGFjdChvYmpba2V5XSwgcmVmcyk7XG4gICAgfVxuXG4gICAgcmV0dXJuIG9iajtcbn07XG5cbmV4cG9ydHMuaXNSZWdFeHAgPSBmdW5jdGlvbiAob2JqKSB7XG4gICAgcmV0dXJuIE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbChvYmopID09PSAnW29iamVjdCBSZWdFeHBdJztcbn07XG5cbmV4cG9ydHMuaXNCdWZmZXIgPSBmdW5jdGlvbiAob2JqKSB7XG4gICAgaWYgKG9iaiA9PT0gbnVsbCB8fCB0eXBlb2Ygb2JqID09PSAndW5kZWZpbmVkJykge1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgcmV0dXJuICEhKG9iai5jb25zdHJ1Y3RvciAmJiBvYmouY29uc3RydWN0b3IuaXNCdWZmZXIgJiYgb2JqLmNvbnN0cnVjdG9yLmlzQnVmZmVyKG9iaikpO1xufTtcbiIsInZhciBWTm9kZSA9IHJlcXVpcmUoJy4vdm5vZGUnKTtcbnZhciBpcyA9IHJlcXVpcmUoJy4vaXMnKTtcblxuZnVuY3Rpb24gYWRkTlMoZGF0YSwgY2hpbGRyZW4pIHtcbiAgZGF0YS5ucyA9ICdodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Zyc7XG4gIGlmIChjaGlsZHJlbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBjaGlsZHJlbi5sZW5ndGg7ICsraSkge1xuICAgICAgYWRkTlMoY2hpbGRyZW5baV0uZGF0YSwgY2hpbGRyZW5baV0uY2hpbGRyZW4pO1xuICAgIH1cbiAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIGgoc2VsLCBiLCBjKSB7XG4gIHZhciBkYXRhID0ge30sIGNoaWxkcmVuLCB0ZXh0LCBpO1xuICBpZiAoYyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgZGF0YSA9IGI7XG4gICAgaWYgKGlzLmFycmF5KGMpKSB7IGNoaWxkcmVuID0gYzsgfVxuICAgIGVsc2UgaWYgKGlzLnByaW1pdGl2ZShjKSkgeyB0ZXh0ID0gYzsgfVxuICB9IGVsc2UgaWYgKGIgIT09IHVuZGVmaW5lZCkge1xuICAgIGlmIChpcy5hcnJheShiKSkgeyBjaGlsZHJlbiA9IGI7IH1cbiAgICBlbHNlIGlmIChpcy5wcmltaXRpdmUoYikpIHsgdGV4dCA9IGI7IH1cbiAgICBlbHNlIHsgZGF0YSA9IGI7IH1cbiAgfVxuICBpZiAoaXMuYXJyYXkoY2hpbGRyZW4pKSB7XG4gICAgZm9yIChpID0gMDsgaSA8IGNoaWxkcmVuLmxlbmd0aDsgKytpKSB7XG4gICAgICBpZiAoaXMucHJpbWl0aXZlKGNoaWxkcmVuW2ldKSkgY2hpbGRyZW5baV0gPSBWTm9kZSh1bmRlZmluZWQsIHVuZGVmaW5lZCwgdW5kZWZpbmVkLCBjaGlsZHJlbltpXSk7XG4gICAgfVxuICB9XG4gIGlmIChzZWxbMF0gPT09ICdzJyAmJiBzZWxbMV0gPT09ICd2JyAmJiBzZWxbMl0gPT09ICdnJykge1xuICAgIGFkZE5TKGRhdGEsIGNoaWxkcmVuKTtcbiAgfVxuICByZXR1cm4gVk5vZGUoc2VsLCBkYXRhLCBjaGlsZHJlbiwgdGV4dCwgdW5kZWZpbmVkKTtcbn07XG4iLCJmdW5jdGlvbiBjcmVhdGVFbGVtZW50KHRhZ05hbWUpe1xuICByZXR1cm4gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCh0YWdOYW1lKTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlRWxlbWVudE5TKG5hbWVzcGFjZVVSSSwgcXVhbGlmaWVkTmFtZSl7XG4gIHJldHVybiBkb2N1bWVudC5jcmVhdGVFbGVtZW50TlMobmFtZXNwYWNlVVJJLCBxdWFsaWZpZWROYW1lKTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlVGV4dE5vZGUodGV4dCl7XG4gIHJldHVybiBkb2N1bWVudC5jcmVhdGVUZXh0Tm9kZSh0ZXh0KTtcbn1cblxuXG5mdW5jdGlvbiBpbnNlcnRCZWZvcmUocGFyZW50Tm9kZSwgbmV3Tm9kZSwgcmVmZXJlbmNlTm9kZSl7XG4gIHBhcmVudE5vZGUuaW5zZXJ0QmVmb3JlKG5ld05vZGUsIHJlZmVyZW5jZU5vZGUpO1xufVxuXG5cbmZ1bmN0aW9uIHJlbW92ZUNoaWxkKG5vZGUsIGNoaWxkKXtcbiAgbm9kZS5yZW1vdmVDaGlsZChjaGlsZCk7XG59XG5cbmZ1bmN0aW9uIGFwcGVuZENoaWxkKG5vZGUsIGNoaWxkKXtcbiAgbm9kZS5hcHBlbmRDaGlsZChjaGlsZCk7XG59XG5cbmZ1bmN0aW9uIHBhcmVudE5vZGUobm9kZSl7XG4gIHJldHVybiBub2RlLnBhcmVudEVsZW1lbnQ7XG59XG5cbmZ1bmN0aW9uIG5leHRTaWJsaW5nKG5vZGUpe1xuICByZXR1cm4gbm9kZS5uZXh0U2libGluZztcbn1cblxuZnVuY3Rpb24gdGFnTmFtZShub2RlKXtcbiAgcmV0dXJuIG5vZGUudGFnTmFtZTtcbn1cblxuZnVuY3Rpb24gc2V0VGV4dENvbnRlbnQobm9kZSwgdGV4dCl7XG4gIG5vZGUudGV4dENvbnRlbnQgPSB0ZXh0O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IHtcbiAgY3JlYXRlRWxlbWVudDogY3JlYXRlRWxlbWVudCxcbiAgY3JlYXRlRWxlbWVudE5TOiBjcmVhdGVFbGVtZW50TlMsXG4gIGNyZWF0ZVRleHROb2RlOiBjcmVhdGVUZXh0Tm9kZSxcbiAgYXBwZW5kQ2hpbGQ6IGFwcGVuZENoaWxkLFxuICByZW1vdmVDaGlsZDogcmVtb3ZlQ2hpbGQsXG4gIGluc2VydEJlZm9yZTogaW5zZXJ0QmVmb3JlLFxuICBwYXJlbnROb2RlOiBwYXJlbnROb2RlLFxuICBuZXh0U2libGluZzogbmV4dFNpYmxpbmcsXG4gIHRhZ05hbWU6IHRhZ05hbWUsXG4gIHNldFRleHRDb250ZW50OiBzZXRUZXh0Q29udGVudFxufTtcbiIsIm1vZHVsZS5leHBvcnRzID0ge1xuICBhcnJheTogQXJyYXkuaXNBcnJheSxcbiAgcHJpbWl0aXZlOiBmdW5jdGlvbihzKSB7IHJldHVybiB0eXBlb2YgcyA9PT0gJ3N0cmluZycgfHwgdHlwZW9mIHMgPT09ICdudW1iZXInOyB9LFxufTtcbiIsInZhciBib29sZWFuQXR0cnMgPSBbXCJhbGxvd2Z1bGxzY3JlZW5cIiwgXCJhc3luY1wiLCBcImF1dG9mb2N1c1wiLCBcImF1dG9wbGF5XCIsIFwiY2hlY2tlZFwiLCBcImNvbXBhY3RcIiwgXCJjb250cm9sc1wiLCBcImRlY2xhcmVcIiwgXG4gICAgICAgICAgICAgICAgXCJkZWZhdWx0XCIsIFwiZGVmYXVsdGNoZWNrZWRcIiwgXCJkZWZhdWx0bXV0ZWRcIiwgXCJkZWZhdWx0c2VsZWN0ZWRcIiwgXCJkZWZlclwiLCBcImRpc2FibGVkXCIsIFwiZHJhZ2dhYmxlXCIsIFxuICAgICAgICAgICAgICAgIFwiZW5hYmxlZFwiLCBcImZvcm1ub3ZhbGlkYXRlXCIsIFwiaGlkZGVuXCIsIFwiaW5kZXRlcm1pbmF0ZVwiLCBcImluZXJ0XCIsIFwiaXNtYXBcIiwgXCJpdGVtc2NvcGVcIiwgXCJsb29wXCIsIFwibXVsdGlwbGVcIiwgXG4gICAgICAgICAgICAgICAgXCJtdXRlZFwiLCBcIm5vaHJlZlwiLCBcIm5vcmVzaXplXCIsIFwibm9zaGFkZVwiLCBcIm5vdmFsaWRhdGVcIiwgXCJub3dyYXBcIiwgXCJvcGVuXCIsIFwicGF1c2VvbmV4aXRcIiwgXCJyZWFkb25seVwiLCBcbiAgICAgICAgICAgICAgICBcInJlcXVpcmVkXCIsIFwicmV2ZXJzZWRcIiwgXCJzY29wZWRcIiwgXCJzZWFtbGVzc1wiLCBcInNlbGVjdGVkXCIsIFwic29ydGFibGVcIiwgXCJzcGVsbGNoZWNrXCIsIFwidHJhbnNsYXRlXCIsIFxuICAgICAgICAgICAgICAgIFwidHJ1ZXNwZWVkXCIsIFwidHlwZW11c3RtYXRjaFwiLCBcInZpc2libGVcIl07XG4gICAgXG52YXIgYm9vbGVhbkF0dHJzRGljdCA9IHt9O1xuZm9yKHZhciBpPTAsIGxlbiA9IGJvb2xlYW5BdHRycy5sZW5ndGg7IGkgPCBsZW47IGkrKykge1xuICBib29sZWFuQXR0cnNEaWN0W2Jvb2xlYW5BdHRyc1tpXV0gPSB0cnVlO1xufVxuICAgIFxuZnVuY3Rpb24gdXBkYXRlQXR0cnMob2xkVm5vZGUsIHZub2RlKSB7XG4gIHZhciBrZXksIGN1ciwgb2xkLCBlbG0gPSB2bm9kZS5lbG0sXG4gICAgICBvbGRBdHRycyA9IG9sZFZub2RlLmRhdGEuYXR0cnMgfHwge30sIGF0dHJzID0gdm5vZGUuZGF0YS5hdHRycyB8fCB7fTtcbiAgXG4gIC8vIHVwZGF0ZSBtb2RpZmllZCBhdHRyaWJ1dGVzLCBhZGQgbmV3IGF0dHJpYnV0ZXNcbiAgZm9yIChrZXkgaW4gYXR0cnMpIHtcbiAgICBjdXIgPSBhdHRyc1trZXldO1xuICAgIG9sZCA9IG9sZEF0dHJzW2tleV07XG4gICAgaWYgKG9sZCAhPT0gY3VyKSB7XG4gICAgICAvLyBUT0RPOiBhZGQgc3VwcG9ydCB0byBuYW1lc3BhY2VkIGF0dHJpYnV0ZXMgKHNldEF0dHJpYnV0ZU5TKVxuICAgICAgaWYoIWN1ciAmJiBib29sZWFuQXR0cnNEaWN0W2tleV0pXG4gICAgICAgIGVsbS5yZW1vdmVBdHRyaWJ1dGUoa2V5KTtcbiAgICAgIGVsc2VcbiAgICAgICAgZWxtLnNldEF0dHJpYnV0ZShrZXksIGN1cik7XG4gICAgfVxuICB9XG4gIC8vcmVtb3ZlIHJlbW92ZWQgYXR0cmlidXRlc1xuICAvLyB1c2UgYGluYCBvcGVyYXRvciBzaW5jZSB0aGUgcHJldmlvdXMgYGZvcmAgaXRlcmF0aW9uIHVzZXMgaXQgKC5pLmUuIGFkZCBldmVuIGF0dHJpYnV0ZXMgd2l0aCB1bmRlZmluZWQgdmFsdWUpXG4gIC8vIHRoZSBvdGhlciBvcHRpb24gaXMgdG8gcmVtb3ZlIGFsbCBhdHRyaWJ1dGVzIHdpdGggdmFsdWUgPT0gdW5kZWZpbmVkXG4gIGZvciAoa2V5IGluIG9sZEF0dHJzKSB7XG4gICAgaWYgKCEoa2V5IGluIGF0dHJzKSkge1xuICAgICAgZWxtLnJlbW92ZUF0dHJpYnV0ZShrZXkpO1xuICAgIH1cbiAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IHtjcmVhdGU6IHVwZGF0ZUF0dHJzLCB1cGRhdGU6IHVwZGF0ZUF0dHJzfTtcbiIsImZ1bmN0aW9uIHVwZGF0ZUNsYXNzKG9sZFZub2RlLCB2bm9kZSkge1xuICB2YXIgY3VyLCBuYW1lLCBlbG0gPSB2bm9kZS5lbG0sXG4gICAgICBvbGRDbGFzcyA9IG9sZFZub2RlLmRhdGEuY2xhc3MgfHwge30sXG4gICAgICBrbGFzcyA9IHZub2RlLmRhdGEuY2xhc3MgfHwge307XG4gIGZvciAobmFtZSBpbiBvbGRDbGFzcykge1xuICAgIGlmICgha2xhc3NbbmFtZV0pIHtcbiAgICAgIGVsbS5jbGFzc0xpc3QucmVtb3ZlKG5hbWUpO1xuICAgIH1cbiAgfVxuICBmb3IgKG5hbWUgaW4ga2xhc3MpIHtcbiAgICBjdXIgPSBrbGFzc1tuYW1lXTtcbiAgICBpZiAoY3VyICE9PSBvbGRDbGFzc1tuYW1lXSkge1xuICAgICAgZWxtLmNsYXNzTGlzdFtjdXIgPyAnYWRkJyA6ICdyZW1vdmUnXShuYW1lKTtcbiAgICB9XG4gIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSB7Y3JlYXRlOiB1cGRhdGVDbGFzcywgdXBkYXRlOiB1cGRhdGVDbGFzc307XG4iLCJ2YXIgaXMgPSByZXF1aXJlKCcuLi9pcycpO1xuXG5mdW5jdGlvbiBhcnJJbnZva2VyKGFycikge1xuICByZXR1cm4gZnVuY3Rpb24oKSB7XG4gICAgaWYgKCFhcnIubGVuZ3RoKSByZXR1cm47XG4gICAgLy8gU3BlY2lhbCBjYXNlIHdoZW4gbGVuZ3RoIGlzIHR3bywgZm9yIHBlcmZvcm1hbmNlXG4gICAgYXJyLmxlbmd0aCA9PT0gMiA/IGFyclswXShhcnJbMV0pIDogYXJyWzBdLmFwcGx5KHVuZGVmaW5lZCwgYXJyLnNsaWNlKDEpKTtcbiAgfTtcbn1cblxuZnVuY3Rpb24gZm5JbnZva2VyKG8pIHtcbiAgcmV0dXJuIGZ1bmN0aW9uKGV2KSB7IFxuICAgIGlmIChvLmZuID09PSBudWxsKSByZXR1cm47XG4gICAgby5mbihldik7IFxuICB9O1xufVxuXG5mdW5jdGlvbiB1cGRhdGVFdmVudExpc3RlbmVycyhvbGRWbm9kZSwgdm5vZGUpIHtcbiAgdmFyIG5hbWUsIGN1ciwgb2xkLCBlbG0gPSB2bm9kZS5lbG0sXG4gICAgICBvbGRPbiA9IG9sZFZub2RlLmRhdGEub24gfHwge30sIG9uID0gdm5vZGUuZGF0YS5vbjtcbiAgaWYgKCFvbikgcmV0dXJuO1xuICBmb3IgKG5hbWUgaW4gb24pIHtcbiAgICBjdXIgPSBvbltuYW1lXTtcbiAgICBvbGQgPSBvbGRPbltuYW1lXTtcbiAgICBpZiAob2xkID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGlmIChpcy5hcnJheShjdXIpKSB7XG4gICAgICAgIGVsbS5hZGRFdmVudExpc3RlbmVyKG5hbWUsIGFyckludm9rZXIoY3VyKSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjdXIgPSB7Zm46IGN1cn07XG4gICAgICAgIG9uW25hbWVdID0gY3VyO1xuICAgICAgICBlbG0uYWRkRXZlbnRMaXN0ZW5lcihuYW1lLCBmbkludm9rZXIoY3VyKSk7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmIChpcy5hcnJheShvbGQpKSB7XG4gICAgICAvLyBEZWxpYmVyYXRlbHkgbW9kaWZ5IG9sZCBhcnJheSBzaW5jZSBpdCdzIGNhcHR1cmVkIGluIGNsb3N1cmUgY3JlYXRlZCB3aXRoIGBhcnJJbnZva2VyYFxuICAgICAgb2xkLmxlbmd0aCA9IGN1ci5sZW5ndGg7XG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IG9sZC5sZW5ndGg7ICsraSkgb2xkW2ldID0gY3VyW2ldO1xuICAgICAgb25bbmFtZV0gID0gb2xkO1xuICAgIH0gZWxzZSB7XG4gICAgICBvbGQuZm4gPSBjdXI7XG4gICAgICBvbltuYW1lXSA9IG9sZDtcbiAgICB9XG4gIH1cbiAgaWYgKG9sZE9uKSB7XG4gICAgZm9yIChuYW1lIGluIG9sZE9uKSB7XG4gICAgICBpZiAob25bbmFtZV0gPT09IHVuZGVmaW5lZCkge1xuICAgICAgICB2YXIgb2xkID0gb2xkT25bbmFtZV07XG4gICAgICAgIGlmIChpcy5hcnJheShvbGQpKSB7XG4gICAgICAgICAgb2xkLmxlbmd0aCA9IDA7XG4gICAgICAgIH1cbiAgICAgICAgZWxzZSB7XG4gICAgICAgICAgb2xkLmZuID0gbnVsbDtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IHtjcmVhdGU6IHVwZGF0ZUV2ZW50TGlzdGVuZXJzLCB1cGRhdGU6IHVwZGF0ZUV2ZW50TGlzdGVuZXJzfTtcbiIsImZ1bmN0aW9uIHVwZGF0ZVByb3BzKG9sZFZub2RlLCB2bm9kZSkge1xuICB2YXIga2V5LCBjdXIsIG9sZCwgZWxtID0gdm5vZGUuZWxtLFxuICAgICAgb2xkUHJvcHMgPSBvbGRWbm9kZS5kYXRhLnByb3BzIHx8IHt9LCBwcm9wcyA9IHZub2RlLmRhdGEucHJvcHMgfHwge307XG4gIGZvciAoa2V5IGluIG9sZFByb3BzKSB7XG4gICAgaWYgKCFwcm9wc1trZXldKSB7XG4gICAgICBkZWxldGUgZWxtW2tleV07XG4gICAgfVxuICB9XG4gIGZvciAoa2V5IGluIHByb3BzKSB7XG4gICAgY3VyID0gcHJvcHNba2V5XTtcbiAgICBvbGQgPSBvbGRQcm9wc1trZXldO1xuICAgIGlmIChvbGQgIT09IGN1ciAmJiAoa2V5ICE9PSAndmFsdWUnIHx8IGVsbVtrZXldICE9PSBjdXIpKSB7XG4gICAgICBlbG1ba2V5XSA9IGN1cjtcbiAgICB9XG4gIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSB7Y3JlYXRlOiB1cGRhdGVQcm9wcywgdXBkYXRlOiB1cGRhdGVQcm9wc307XG4iLCJ2YXIgcmFmID0gKHR5cGVvZiB3aW5kb3cgIT09ICd1bmRlZmluZWQnICYmIHdpbmRvdy5yZXF1ZXN0QW5pbWF0aW9uRnJhbWUpIHx8IHNldFRpbWVvdXQ7XG52YXIgbmV4dEZyYW1lID0gZnVuY3Rpb24oZm4pIHsgcmFmKGZ1bmN0aW9uKCkgeyByYWYoZm4pOyB9KTsgfTtcblxuZnVuY3Rpb24gc2V0TmV4dEZyYW1lKG9iaiwgcHJvcCwgdmFsKSB7XG4gIG5leHRGcmFtZShmdW5jdGlvbigpIHsgb2JqW3Byb3BdID0gdmFsOyB9KTtcbn1cblxuZnVuY3Rpb24gdXBkYXRlU3R5bGUob2xkVm5vZGUsIHZub2RlKSB7XG4gIHZhciBjdXIsIG5hbWUsIGVsbSA9IHZub2RlLmVsbSxcbiAgICAgIG9sZFN0eWxlID0gb2xkVm5vZGUuZGF0YS5zdHlsZSB8fCB7fSxcbiAgICAgIHN0eWxlID0gdm5vZGUuZGF0YS5zdHlsZSB8fCB7fSxcbiAgICAgIG9sZEhhc0RlbCA9ICdkZWxheWVkJyBpbiBvbGRTdHlsZTtcbiAgZm9yIChuYW1lIGluIG9sZFN0eWxlKSB7XG4gICAgaWYgKCFzdHlsZVtuYW1lXSkge1xuICAgICAgZWxtLnN0eWxlW25hbWVdID0gJyc7XG4gICAgfVxuICB9XG4gIGZvciAobmFtZSBpbiBzdHlsZSkge1xuICAgIGN1ciA9IHN0eWxlW25hbWVdO1xuICAgIGlmIChuYW1lID09PSAnZGVsYXllZCcpIHtcbiAgICAgIGZvciAobmFtZSBpbiBzdHlsZS5kZWxheWVkKSB7XG4gICAgICAgIGN1ciA9IHN0eWxlLmRlbGF5ZWRbbmFtZV07XG4gICAgICAgIGlmICghb2xkSGFzRGVsIHx8IGN1ciAhPT0gb2xkU3R5bGUuZGVsYXllZFtuYW1lXSkge1xuICAgICAgICAgIHNldE5leHRGcmFtZShlbG0uc3R5bGUsIG5hbWUsIGN1cik7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKG5hbWUgIT09ICdyZW1vdmUnICYmIGN1ciAhPT0gb2xkU3R5bGVbbmFtZV0pIHtcbiAgICAgIGVsbS5zdHlsZVtuYW1lXSA9IGN1cjtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gYXBwbHlEZXN0cm95U3R5bGUodm5vZGUpIHtcbiAgdmFyIHN0eWxlLCBuYW1lLCBlbG0gPSB2bm9kZS5lbG0sIHMgPSB2bm9kZS5kYXRhLnN0eWxlO1xuICBpZiAoIXMgfHwgIShzdHlsZSA9IHMuZGVzdHJveSkpIHJldHVybjtcbiAgZm9yIChuYW1lIGluIHN0eWxlKSB7XG4gICAgZWxtLnN0eWxlW25hbWVdID0gc3R5bGVbbmFtZV07XG4gIH1cbn1cblxuZnVuY3Rpb24gYXBwbHlSZW1vdmVTdHlsZSh2bm9kZSwgcm0pIHtcbiAgdmFyIHMgPSB2bm9kZS5kYXRhLnN0eWxlO1xuICBpZiAoIXMgfHwgIXMucmVtb3ZlKSB7XG4gICAgcm0oKTtcbiAgICByZXR1cm47XG4gIH1cbiAgdmFyIG5hbWUsIGVsbSA9IHZub2RlLmVsbSwgaWR4LCBpID0gMCwgbWF4RHVyID0gMCxcbiAgICAgIGNvbXBTdHlsZSwgc3R5bGUgPSBzLnJlbW92ZSwgYW1vdW50ID0gMCwgYXBwbGllZCA9IFtdO1xuICBmb3IgKG5hbWUgaW4gc3R5bGUpIHtcbiAgICBhcHBsaWVkLnB1c2gobmFtZSk7XG4gICAgZWxtLnN0eWxlW25hbWVdID0gc3R5bGVbbmFtZV07XG4gIH1cbiAgY29tcFN0eWxlID0gZ2V0Q29tcHV0ZWRTdHlsZShlbG0pO1xuICB2YXIgcHJvcHMgPSBjb21wU3R5bGVbJ3RyYW5zaXRpb24tcHJvcGVydHknXS5zcGxpdCgnLCAnKTtcbiAgZm9yICg7IGkgPCBwcm9wcy5sZW5ndGg7ICsraSkge1xuICAgIGlmKGFwcGxpZWQuaW5kZXhPZihwcm9wc1tpXSkgIT09IC0xKSBhbW91bnQrKztcbiAgfVxuICBlbG0uYWRkRXZlbnRMaXN0ZW5lcigndHJhbnNpdGlvbmVuZCcsIGZ1bmN0aW9uKGV2KSB7XG4gICAgaWYgKGV2LnRhcmdldCA9PT0gZWxtKSAtLWFtb3VudDtcbiAgICBpZiAoYW1vdW50ID09PSAwKSBybSgpO1xuICB9KTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSB7Y3JlYXRlOiB1cGRhdGVTdHlsZSwgdXBkYXRlOiB1cGRhdGVTdHlsZSwgZGVzdHJveTogYXBwbHlEZXN0cm95U3R5bGUsIHJlbW92ZTogYXBwbHlSZW1vdmVTdHlsZX07XG4iLCIvLyBqc2hpbnQgbmV3Y2FwOiBmYWxzZVxuLyogZ2xvYmFsIHJlcXVpcmUsIG1vZHVsZSwgZG9jdW1lbnQsIE5vZGUgKi9cbid1c2Ugc3RyaWN0JztcblxudmFyIFZOb2RlID0gcmVxdWlyZSgnLi92bm9kZScpO1xudmFyIGlzID0gcmVxdWlyZSgnLi9pcycpO1xudmFyIGRvbUFwaSA9IHJlcXVpcmUoJy4vaHRtbGRvbWFwaScpO1xuXG5mdW5jdGlvbiBpc1VuZGVmKHMpIHsgcmV0dXJuIHMgPT09IHVuZGVmaW5lZDsgfVxuZnVuY3Rpb24gaXNEZWYocykgeyByZXR1cm4gcyAhPT0gdW5kZWZpbmVkOyB9XG5cbnZhciBlbXB0eU5vZGUgPSBWTm9kZSgnJywge30sIFtdLCB1bmRlZmluZWQsIHVuZGVmaW5lZCk7XG5cbmZ1bmN0aW9uIHNhbWVWbm9kZSh2bm9kZTEsIHZub2RlMikge1xuICByZXR1cm4gdm5vZGUxLmtleSA9PT0gdm5vZGUyLmtleSAmJiB2bm9kZTEuc2VsID09PSB2bm9kZTIuc2VsO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVLZXlUb09sZElkeChjaGlsZHJlbiwgYmVnaW5JZHgsIGVuZElkeCkge1xuICB2YXIgaSwgbWFwID0ge30sIGtleTtcbiAgZm9yIChpID0gYmVnaW5JZHg7IGkgPD0gZW5kSWR4OyArK2kpIHtcbiAgICBrZXkgPSBjaGlsZHJlbltpXS5rZXk7XG4gICAgaWYgKGlzRGVmKGtleSkpIG1hcFtrZXldID0gaTtcbiAgfVxuICByZXR1cm4gbWFwO1xufVxuXG52YXIgaG9va3MgPSBbJ2NyZWF0ZScsICd1cGRhdGUnLCAncmVtb3ZlJywgJ2Rlc3Ryb3knLCAncHJlJywgJ3Bvc3QnXTtcblxuZnVuY3Rpb24gaW5pdChtb2R1bGVzLCBhcGkpIHtcbiAgdmFyIGksIGosIGNicyA9IHt9O1xuXG4gIGlmIChpc1VuZGVmKGFwaSkpIGFwaSA9IGRvbUFwaTtcblxuICBmb3IgKGkgPSAwOyBpIDwgaG9va3MubGVuZ3RoOyArK2kpIHtcbiAgICBjYnNbaG9va3NbaV1dID0gW107XG4gICAgZm9yIChqID0gMDsgaiA8IG1vZHVsZXMubGVuZ3RoOyArK2opIHtcbiAgICAgIGlmIChtb2R1bGVzW2pdW2hvb2tzW2ldXSAhPT0gdW5kZWZpbmVkKSBjYnNbaG9va3NbaV1dLnB1c2gobW9kdWxlc1tqXVtob29rc1tpXV0pO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIGVtcHR5Tm9kZUF0KGVsbSkge1xuICAgIHJldHVybiBWTm9kZShhcGkudGFnTmFtZShlbG0pLnRvTG93ZXJDYXNlKCksIHt9LCBbXSwgdW5kZWZpbmVkLCBlbG0pO1xuICB9XG5cbiAgZnVuY3Rpb24gY3JlYXRlUm1DYihjaGlsZEVsbSwgbGlzdGVuZXJzKSB7XG4gICAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgICAgaWYgKC0tbGlzdGVuZXJzID09PSAwKSB7XG4gICAgICAgIHZhciBwYXJlbnQgPSBhcGkucGFyZW50Tm9kZShjaGlsZEVsbSk7XG4gICAgICAgIGFwaS5yZW1vdmVDaGlsZChwYXJlbnQsIGNoaWxkRWxtKTtcbiAgICAgIH1cbiAgICB9O1xuICB9XG5cbiAgZnVuY3Rpb24gY3JlYXRlRWxtKHZub2RlLCBpbnNlcnRlZFZub2RlUXVldWUpIHtcbiAgICB2YXIgaSwgZGF0YSA9IHZub2RlLmRhdGE7XG4gICAgaWYgKGlzRGVmKGRhdGEpKSB7XG4gICAgICBpZiAoaXNEZWYoaSA9IGRhdGEuaG9vaykgJiYgaXNEZWYoaSA9IGkuaW5pdCkpIHtcbiAgICAgICAgaSh2bm9kZSk7XG4gICAgICAgIGRhdGEgPSB2bm9kZS5kYXRhO1xuICAgICAgfVxuICAgIH1cbiAgICB2YXIgZWxtLCBjaGlsZHJlbiA9IHZub2RlLmNoaWxkcmVuLCBzZWwgPSB2bm9kZS5zZWw7XG4gICAgaWYgKGlzRGVmKHNlbCkpIHtcbiAgICAgIC8vIFBhcnNlIHNlbGVjdG9yXG4gICAgICB2YXIgaGFzaElkeCA9IHNlbC5pbmRleE9mKCcjJyk7XG4gICAgICB2YXIgZG90SWR4ID0gc2VsLmluZGV4T2YoJy4nLCBoYXNoSWR4KTtcbiAgICAgIHZhciBoYXNoID0gaGFzaElkeCA+IDAgPyBoYXNoSWR4IDogc2VsLmxlbmd0aDtcbiAgICAgIHZhciBkb3QgPSBkb3RJZHggPiAwID8gZG90SWR4IDogc2VsLmxlbmd0aDtcbiAgICAgIHZhciB0YWcgPSBoYXNoSWR4ICE9PSAtMSB8fCBkb3RJZHggIT09IC0xID8gc2VsLnNsaWNlKDAsIE1hdGgubWluKGhhc2gsIGRvdCkpIDogc2VsO1xuICAgICAgZWxtID0gdm5vZGUuZWxtID0gaXNEZWYoZGF0YSkgJiYgaXNEZWYoaSA9IGRhdGEubnMpID8gYXBpLmNyZWF0ZUVsZW1lbnROUyhpLCB0YWcpXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgOiBhcGkuY3JlYXRlRWxlbWVudCh0YWcpO1xuICAgICAgaWYgKGhhc2ggPCBkb3QpIGVsbS5pZCA9IHNlbC5zbGljZShoYXNoICsgMSwgZG90KTtcbiAgICAgIGlmIChkb3RJZHggPiAwKSBlbG0uY2xhc3NOYW1lID0gc2VsLnNsaWNlKGRvdCsxKS5yZXBsYWNlKC9cXC4vZywgJyAnKTtcbiAgICAgIGlmIChpcy5hcnJheShjaGlsZHJlbikpIHtcbiAgICAgICAgZm9yIChpID0gMDsgaSA8IGNoaWxkcmVuLmxlbmd0aDsgKytpKSB7XG4gICAgICAgICAgYXBpLmFwcGVuZENoaWxkKGVsbSwgY3JlYXRlRWxtKGNoaWxkcmVuW2ldLCBpbnNlcnRlZFZub2RlUXVldWUpKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmIChpcy5wcmltaXRpdmUodm5vZGUudGV4dCkpIHtcbiAgICAgICAgYXBpLmFwcGVuZENoaWxkKGVsbSwgYXBpLmNyZWF0ZVRleHROb2RlKHZub2RlLnRleHQpKTtcbiAgICAgIH1cbiAgICAgIGZvciAoaSA9IDA7IGkgPCBjYnMuY3JlYXRlLmxlbmd0aDsgKytpKSBjYnMuY3JlYXRlW2ldKGVtcHR5Tm9kZSwgdm5vZGUpO1xuICAgICAgaSA9IHZub2RlLmRhdGEuaG9vazsgLy8gUmV1c2UgdmFyaWFibGVcbiAgICAgIGlmIChpc0RlZihpKSkge1xuICAgICAgICBpZiAoaS5jcmVhdGUpIGkuY3JlYXRlKGVtcHR5Tm9kZSwgdm5vZGUpO1xuICAgICAgICBpZiAoaS5pbnNlcnQpIGluc2VydGVkVm5vZGVRdWV1ZS5wdXNoKHZub2RlKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgZWxtID0gdm5vZGUuZWxtID0gYXBpLmNyZWF0ZVRleHROb2RlKHZub2RlLnRleHQpO1xuICAgIH1cbiAgICByZXR1cm4gdm5vZGUuZWxtO1xuICB9XG5cbiAgZnVuY3Rpb24gYWRkVm5vZGVzKHBhcmVudEVsbSwgYmVmb3JlLCB2bm9kZXMsIHN0YXJ0SWR4LCBlbmRJZHgsIGluc2VydGVkVm5vZGVRdWV1ZSkge1xuICAgIGZvciAoOyBzdGFydElkeCA8PSBlbmRJZHg7ICsrc3RhcnRJZHgpIHtcbiAgICAgIGFwaS5pbnNlcnRCZWZvcmUocGFyZW50RWxtLCBjcmVhdGVFbG0odm5vZGVzW3N0YXJ0SWR4XSwgaW5zZXJ0ZWRWbm9kZVF1ZXVlKSwgYmVmb3JlKTtcbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBpbnZva2VEZXN0cm95SG9vayh2bm9kZSkge1xuICAgIHZhciBpLCBqLCBkYXRhID0gdm5vZGUuZGF0YTtcbiAgICBpZiAoaXNEZWYoZGF0YSkpIHtcbiAgICAgIGlmIChpc0RlZihpID0gZGF0YS5ob29rKSAmJiBpc0RlZihpID0gaS5kZXN0cm95KSkgaSh2bm9kZSk7XG4gICAgICBmb3IgKGkgPSAwOyBpIDwgY2JzLmRlc3Ryb3kubGVuZ3RoOyArK2kpIGNicy5kZXN0cm95W2ldKHZub2RlKTtcbiAgICAgIGlmIChpc0RlZihpID0gdm5vZGUuY2hpbGRyZW4pKSB7XG4gICAgICAgIGZvciAoaiA9IDA7IGogPCB2bm9kZS5jaGlsZHJlbi5sZW5ndGg7ICsraikge1xuICAgICAgICAgIGludm9rZURlc3Ryb3lIb29rKHZub2RlLmNoaWxkcmVuW2pdKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIHJlbW92ZVZub2RlcyhwYXJlbnRFbG0sIHZub2Rlcywgc3RhcnRJZHgsIGVuZElkeCkge1xuICAgIGZvciAoOyBzdGFydElkeCA8PSBlbmRJZHg7ICsrc3RhcnRJZHgpIHtcbiAgICAgIHZhciBpLCBsaXN0ZW5lcnMsIHJtLCBjaCA9IHZub2Rlc1tzdGFydElkeF07XG4gICAgICBpZiAoaXNEZWYoY2gpKSB7XG4gICAgICAgIGlmIChpc0RlZihjaC5zZWwpKSB7XG4gICAgICAgICAgaW52b2tlRGVzdHJveUhvb2soY2gpO1xuICAgICAgICAgIGxpc3RlbmVycyA9IGNicy5yZW1vdmUubGVuZ3RoICsgMTtcbiAgICAgICAgICBybSA9IGNyZWF0ZVJtQ2IoY2guZWxtLCBsaXN0ZW5lcnMpO1xuICAgICAgICAgIGZvciAoaSA9IDA7IGkgPCBjYnMucmVtb3ZlLmxlbmd0aDsgKytpKSBjYnMucmVtb3ZlW2ldKGNoLCBybSk7XG4gICAgICAgICAgaWYgKGlzRGVmKGkgPSBjaC5kYXRhKSAmJiBpc0RlZihpID0gaS5ob29rKSAmJiBpc0RlZihpID0gaS5yZW1vdmUpKSB7XG4gICAgICAgICAgICBpKGNoLCBybSk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJtKCk7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgeyAvLyBUZXh0IG5vZGVcbiAgICAgICAgICBhcGkucmVtb3ZlQ2hpbGQocGFyZW50RWxtLCBjaC5lbG0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gdXBkYXRlQ2hpbGRyZW4ocGFyZW50RWxtLCBvbGRDaCwgbmV3Q2gsIGluc2VydGVkVm5vZGVRdWV1ZSkge1xuICAgIHZhciBvbGRTdGFydElkeCA9IDAsIG5ld1N0YXJ0SWR4ID0gMDtcbiAgICB2YXIgb2xkRW5kSWR4ID0gb2xkQ2gubGVuZ3RoIC0gMTtcbiAgICB2YXIgb2xkU3RhcnRWbm9kZSA9IG9sZENoWzBdO1xuICAgIHZhciBvbGRFbmRWbm9kZSA9IG9sZENoW29sZEVuZElkeF07XG4gICAgdmFyIG5ld0VuZElkeCA9IG5ld0NoLmxlbmd0aCAtIDE7XG4gICAgdmFyIG5ld1N0YXJ0Vm5vZGUgPSBuZXdDaFswXTtcbiAgICB2YXIgbmV3RW5kVm5vZGUgPSBuZXdDaFtuZXdFbmRJZHhdO1xuICAgIHZhciBvbGRLZXlUb0lkeCwgaWR4SW5PbGQsIGVsbVRvTW92ZSwgYmVmb3JlO1xuXG4gICAgd2hpbGUgKG9sZFN0YXJ0SWR4IDw9IG9sZEVuZElkeCAmJiBuZXdTdGFydElkeCA8PSBuZXdFbmRJZHgpIHtcbiAgICAgIGlmIChpc1VuZGVmKG9sZFN0YXJ0Vm5vZGUpKSB7XG4gICAgICAgIG9sZFN0YXJ0Vm5vZGUgPSBvbGRDaFsrK29sZFN0YXJ0SWR4XTsgLy8gVm5vZGUgaGFzIGJlZW4gbW92ZWQgbGVmdFxuICAgICAgfSBlbHNlIGlmIChpc1VuZGVmKG9sZEVuZFZub2RlKSkge1xuICAgICAgICBvbGRFbmRWbm9kZSA9IG9sZENoWy0tb2xkRW5kSWR4XTtcbiAgICAgIH0gZWxzZSBpZiAoc2FtZVZub2RlKG9sZFN0YXJ0Vm5vZGUsIG5ld1N0YXJ0Vm5vZGUpKSB7XG4gICAgICAgIHBhdGNoVm5vZGUob2xkU3RhcnRWbm9kZSwgbmV3U3RhcnRWbm9kZSwgaW5zZXJ0ZWRWbm9kZVF1ZXVlKTtcbiAgICAgICAgb2xkU3RhcnRWbm9kZSA9IG9sZENoWysrb2xkU3RhcnRJZHhdO1xuICAgICAgICBuZXdTdGFydFZub2RlID0gbmV3Q2hbKytuZXdTdGFydElkeF07XG4gICAgICB9IGVsc2UgaWYgKHNhbWVWbm9kZShvbGRFbmRWbm9kZSwgbmV3RW5kVm5vZGUpKSB7XG4gICAgICAgIHBhdGNoVm5vZGUob2xkRW5kVm5vZGUsIG5ld0VuZFZub2RlLCBpbnNlcnRlZFZub2RlUXVldWUpO1xuICAgICAgICBvbGRFbmRWbm9kZSA9IG9sZENoWy0tb2xkRW5kSWR4XTtcbiAgICAgICAgbmV3RW5kVm5vZGUgPSBuZXdDaFstLW5ld0VuZElkeF07XG4gICAgICB9IGVsc2UgaWYgKHNhbWVWbm9kZShvbGRTdGFydFZub2RlLCBuZXdFbmRWbm9kZSkpIHsgLy8gVm5vZGUgbW92ZWQgcmlnaHRcbiAgICAgICAgcGF0Y2hWbm9kZShvbGRTdGFydFZub2RlLCBuZXdFbmRWbm9kZSwgaW5zZXJ0ZWRWbm9kZVF1ZXVlKTtcbiAgICAgICAgYXBpLmluc2VydEJlZm9yZShwYXJlbnRFbG0sIG9sZFN0YXJ0Vm5vZGUuZWxtLCBhcGkubmV4dFNpYmxpbmcob2xkRW5kVm5vZGUuZWxtKSk7XG4gICAgICAgIG9sZFN0YXJ0Vm5vZGUgPSBvbGRDaFsrK29sZFN0YXJ0SWR4XTtcbiAgICAgICAgbmV3RW5kVm5vZGUgPSBuZXdDaFstLW5ld0VuZElkeF07XG4gICAgICB9IGVsc2UgaWYgKHNhbWVWbm9kZShvbGRFbmRWbm9kZSwgbmV3U3RhcnRWbm9kZSkpIHsgLy8gVm5vZGUgbW92ZWQgbGVmdFxuICAgICAgICBwYXRjaFZub2RlKG9sZEVuZFZub2RlLCBuZXdTdGFydFZub2RlLCBpbnNlcnRlZFZub2RlUXVldWUpO1xuICAgICAgICBhcGkuaW5zZXJ0QmVmb3JlKHBhcmVudEVsbSwgb2xkRW5kVm5vZGUuZWxtLCBvbGRTdGFydFZub2RlLmVsbSk7XG4gICAgICAgIG9sZEVuZFZub2RlID0gb2xkQ2hbLS1vbGRFbmRJZHhdO1xuICAgICAgICBuZXdTdGFydFZub2RlID0gbmV3Q2hbKytuZXdTdGFydElkeF07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBpZiAoaXNVbmRlZihvbGRLZXlUb0lkeCkpIG9sZEtleVRvSWR4ID0gY3JlYXRlS2V5VG9PbGRJZHgob2xkQ2gsIG9sZFN0YXJ0SWR4LCBvbGRFbmRJZHgpO1xuICAgICAgICBpZHhJbk9sZCA9IG9sZEtleVRvSWR4W25ld1N0YXJ0Vm5vZGUua2V5XTtcbiAgICAgICAgaWYgKGlzVW5kZWYoaWR4SW5PbGQpKSB7IC8vIE5ldyBlbGVtZW50XG4gICAgICAgICAgYXBpLmluc2VydEJlZm9yZShwYXJlbnRFbG0sIGNyZWF0ZUVsbShuZXdTdGFydFZub2RlLCBpbnNlcnRlZFZub2RlUXVldWUpLCBvbGRTdGFydFZub2RlLmVsbSk7XG4gICAgICAgICAgbmV3U3RhcnRWbm9kZSA9IG5ld0NoWysrbmV3U3RhcnRJZHhdO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGVsbVRvTW92ZSA9IG9sZENoW2lkeEluT2xkXTtcbiAgICAgICAgICBwYXRjaFZub2RlKGVsbVRvTW92ZSwgbmV3U3RhcnRWbm9kZSwgaW5zZXJ0ZWRWbm9kZVF1ZXVlKTtcbiAgICAgICAgICBvbGRDaFtpZHhJbk9sZF0gPSB1bmRlZmluZWQ7XG4gICAgICAgICAgYXBpLmluc2VydEJlZm9yZShwYXJlbnRFbG0sIGVsbVRvTW92ZS5lbG0sIG9sZFN0YXJ0Vm5vZGUuZWxtKTtcbiAgICAgICAgICBuZXdTdGFydFZub2RlID0gbmV3Q2hbKytuZXdTdGFydElkeF07XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKG9sZFN0YXJ0SWR4ID4gb2xkRW5kSWR4KSB7XG4gICAgICBiZWZvcmUgPSBpc1VuZGVmKG5ld0NoW25ld0VuZElkeCsxXSkgPyBudWxsIDogbmV3Q2hbbmV3RW5kSWR4KzFdLmVsbTtcbiAgICAgIGFkZFZub2RlcyhwYXJlbnRFbG0sIGJlZm9yZSwgbmV3Q2gsIG5ld1N0YXJ0SWR4LCBuZXdFbmRJZHgsIGluc2VydGVkVm5vZGVRdWV1ZSk7XG4gICAgfSBlbHNlIGlmIChuZXdTdGFydElkeCA+IG5ld0VuZElkeCkge1xuICAgICAgcmVtb3ZlVm5vZGVzKHBhcmVudEVsbSwgb2xkQ2gsIG9sZFN0YXJ0SWR4LCBvbGRFbmRJZHgpO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIHBhdGNoVm5vZGUob2xkVm5vZGUsIHZub2RlLCBpbnNlcnRlZFZub2RlUXVldWUpIHtcbiAgICB2YXIgaSwgaG9vaztcbiAgICBpZiAoaXNEZWYoaSA9IHZub2RlLmRhdGEpICYmIGlzRGVmKGhvb2sgPSBpLmhvb2spICYmIGlzRGVmKGkgPSBob29rLnByZXBhdGNoKSkge1xuICAgICAgaShvbGRWbm9kZSwgdm5vZGUpO1xuICAgIH1cbiAgICB2YXIgZWxtID0gdm5vZGUuZWxtID0gb2xkVm5vZGUuZWxtLCBvbGRDaCA9IG9sZFZub2RlLmNoaWxkcmVuLCBjaCA9IHZub2RlLmNoaWxkcmVuO1xuICAgIGlmIChvbGRWbm9kZSA9PT0gdm5vZGUpIHJldHVybjtcbiAgICBpZiAoIXNhbWVWbm9kZShvbGRWbm9kZSwgdm5vZGUpKSB7XG4gICAgICB2YXIgcGFyZW50RWxtID0gYXBpLnBhcmVudE5vZGUob2xkVm5vZGUuZWxtKTtcbiAgICAgIGVsbSA9IGNyZWF0ZUVsbSh2bm9kZSwgaW5zZXJ0ZWRWbm9kZVF1ZXVlKTtcbiAgICAgIGFwaS5pbnNlcnRCZWZvcmUocGFyZW50RWxtLCBlbG0sIG9sZFZub2RlLmVsbSk7XG4gICAgICByZW1vdmVWbm9kZXMocGFyZW50RWxtLCBbb2xkVm5vZGVdLCAwLCAwKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKGlzRGVmKHZub2RlLmRhdGEpKSB7XG4gICAgICBmb3IgKGkgPSAwOyBpIDwgY2JzLnVwZGF0ZS5sZW5ndGg7ICsraSkgY2JzLnVwZGF0ZVtpXShvbGRWbm9kZSwgdm5vZGUpO1xuICAgICAgaSA9IHZub2RlLmRhdGEuaG9vaztcbiAgICAgIGlmIChpc0RlZihpKSAmJiBpc0RlZihpID0gaS51cGRhdGUpKSBpKG9sZFZub2RlLCB2bm9kZSk7XG4gICAgfVxuICAgIGlmIChpc1VuZGVmKHZub2RlLnRleHQpKSB7XG4gICAgICBpZiAoaXNEZWYob2xkQ2gpICYmIGlzRGVmKGNoKSkge1xuICAgICAgICBpZiAob2xkQ2ggIT09IGNoKSB1cGRhdGVDaGlsZHJlbihlbG0sIG9sZENoLCBjaCwgaW5zZXJ0ZWRWbm9kZVF1ZXVlKTtcbiAgICAgIH0gZWxzZSBpZiAoaXNEZWYoY2gpKSB7XG4gICAgICAgIGlmIChpc0RlZihvbGRWbm9kZS50ZXh0KSkgYXBpLnNldFRleHRDb250ZW50KGVsbSwgJycpO1xuICAgICAgICBhZGRWbm9kZXMoZWxtLCBudWxsLCBjaCwgMCwgY2gubGVuZ3RoIC0gMSwgaW5zZXJ0ZWRWbm9kZVF1ZXVlKTtcbiAgICAgIH0gZWxzZSBpZiAoaXNEZWYob2xkQ2gpKSB7XG4gICAgICAgIHJlbW92ZVZub2RlcyhlbG0sIG9sZENoLCAwLCBvbGRDaC5sZW5ndGggLSAxKTtcbiAgICAgIH0gZWxzZSBpZiAoaXNEZWYob2xkVm5vZGUudGV4dCkpIHtcbiAgICAgICAgYXBpLnNldFRleHRDb250ZW50KGVsbSwgJycpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAob2xkVm5vZGUudGV4dCAhPT0gdm5vZGUudGV4dCkge1xuICAgICAgYXBpLnNldFRleHRDb250ZW50KGVsbSwgdm5vZGUudGV4dCk7XG4gICAgfVxuICAgIGlmIChpc0RlZihob29rKSAmJiBpc0RlZihpID0gaG9vay5wb3N0cGF0Y2gpKSB7XG4gICAgICBpKG9sZFZub2RlLCB2bm9kZSk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGZ1bmN0aW9uKG9sZFZub2RlLCB2bm9kZSkge1xuICAgIHZhciBpLCBlbG0sIHBhcmVudDtcbiAgICB2YXIgaW5zZXJ0ZWRWbm9kZVF1ZXVlID0gW107XG4gICAgZm9yIChpID0gMDsgaSA8IGNicy5wcmUubGVuZ3RoOyArK2kpIGNicy5wcmVbaV0oKTtcblxuICAgIGlmIChpc1VuZGVmKG9sZFZub2RlLnNlbCkpIHtcbiAgICAgIG9sZFZub2RlID0gZW1wdHlOb2RlQXQob2xkVm5vZGUpO1xuICAgIH1cblxuICAgIGlmIChzYW1lVm5vZGUob2xkVm5vZGUsIHZub2RlKSkge1xuICAgICAgcGF0Y2hWbm9kZShvbGRWbm9kZSwgdm5vZGUsIGluc2VydGVkVm5vZGVRdWV1ZSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGVsbSA9IG9sZFZub2RlLmVsbTtcbiAgICAgIHBhcmVudCA9IGFwaS5wYXJlbnROb2RlKGVsbSk7XG5cbiAgICAgIGNyZWF0ZUVsbSh2bm9kZSwgaW5zZXJ0ZWRWbm9kZVF1ZXVlKTtcblxuICAgICAgaWYgKHBhcmVudCAhPT0gbnVsbCkge1xuICAgICAgICBhcGkuaW5zZXJ0QmVmb3JlKHBhcmVudCwgdm5vZGUuZWxtLCBhcGkubmV4dFNpYmxpbmcoZWxtKSk7XG4gICAgICAgIHJlbW92ZVZub2RlcyhwYXJlbnQsIFtvbGRWbm9kZV0sIDAsIDApO1xuICAgICAgfVxuICAgIH1cblxuICAgIGZvciAoaSA9IDA7IGkgPCBpbnNlcnRlZFZub2RlUXVldWUubGVuZ3RoOyArK2kpIHtcbiAgICAgIGluc2VydGVkVm5vZGVRdWV1ZVtpXS5kYXRhLmhvb2suaW5zZXJ0KGluc2VydGVkVm5vZGVRdWV1ZVtpXSk7XG4gICAgfVxuICAgIGZvciAoaSA9IDA7IGkgPCBjYnMucG9zdC5sZW5ndGg7ICsraSkgY2JzLnBvc3RbaV0oKTtcbiAgICByZXR1cm4gdm5vZGU7XG4gIH07XG59XG5cbm1vZHVsZS5leHBvcnRzID0ge2luaXQ6IGluaXR9O1xuIiwibW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihzZWwsIGRhdGEsIGNoaWxkcmVuLCB0ZXh0LCBlbG0pIHtcbiAgdmFyIGtleSA9IGRhdGEgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IGRhdGEua2V5O1xuICByZXR1cm4ge3NlbDogc2VsLCBkYXRhOiBkYXRhLCBjaGlsZHJlbjogY2hpbGRyZW4sXG4gICAgICAgICAgdGV4dDogdGV4dCwgZWxtOiBlbG0sIGtleToga2V5fTtcbn07XG4iLCIndXNlIHN0cmljdCc7XG5cbnZhciBQcm9taXNlID0gcmVxdWlyZSgncHJvbWlzZScpO1xudmFyIFJlc3BvbnNlID0gcmVxdWlyZSgnaHR0cC1yZXNwb25zZS1vYmplY3QnKTtcbnZhciBoYW5kbGVRcyA9IHJlcXVpcmUoJy4vbGliL2hhbmRsZS1xcy5qcycpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IGRvUmVxdWVzdDtcbmZ1bmN0aW9uIGRvUmVxdWVzdChtZXRob2QsIHVybCwgb3B0aW9ucywgY2FsbGJhY2spIHtcbiAgdmFyIHJlc3VsdCA9IG5ldyBQcm9taXNlKGZ1bmN0aW9uIChyZXNvbHZlLCByZWplY3QpIHtcbiAgICB2YXIgeGhyID0gbmV3IHdpbmRvdy5YTUxIdHRwUmVxdWVzdCgpO1xuXG4gICAgLy8gY2hlY2sgdHlwZXMgb2YgYXJndW1lbnRzXG5cbiAgICBpZiAodHlwZW9mIG1ldGhvZCAhPT0gJ3N0cmluZycpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ1RoZSBtZXRob2QgbXVzdCBiZSBhIHN0cmluZy4nKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiB1cmwgIT09ICdzdHJpbmcnKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdUaGUgVVJML3BhdGggbXVzdCBiZSBhIHN0cmluZy4nKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBvcHRpb25zID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICBjYWxsYmFjayA9IG9wdGlvbnM7XG4gICAgICBvcHRpb25zID0ge307XG4gICAgfVxuICAgIGlmIChvcHRpb25zID09PSBudWxsIHx8IG9wdGlvbnMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgb3B0aW9ucyA9IHt9O1xuICAgIH1cbiAgICBpZiAodHlwZW9mIG9wdGlvbnMgIT09ICdvYmplY3QnKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdPcHRpb25zIG11c3QgYmUgYW4gb2JqZWN0IChvciBudWxsKS4nKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBjYWxsYmFjayAhPT0gJ2Z1bmN0aW9uJykge1xuICAgICAgY2FsbGJhY2sgPSB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgbWV0aG9kID0gbWV0aG9kLnRvVXBwZXJDYXNlKCk7XG4gICAgb3B0aW9ucy5oZWFkZXJzID0gb3B0aW9ucy5oZWFkZXJzIHx8IHt9O1xuXG5cbiAgICBmdW5jdGlvbiBhdHRlbXB0KG4pIHtcbiAgICAgIGRvUmVxdWVzdChtZXRob2QsIHVybCwge1xuICAgICAgICBxczogb3B0aW9ucy5xcyxcbiAgICAgICAgaGVhZGVyczogb3B0aW9ucy5oZWFkZXJzLFxuICAgICAgICB0aW1lb3V0OiBvcHRpb25zLnRpbWVvdXRcbiAgICAgIH0pLm5vZGVpZnkoZnVuY3Rpb24gKGVyciwgcmVzKSB7XG4gICAgICAgIHZhciByZXRyeSA9IGVyciB8fCByZXMuc3RhdHVzQ29kZSA+PSA0MDA7XG4gICAgICAgIGlmICh0eXBlb2Ygb3B0aW9ucy5yZXRyeSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgIHJldHJ5ID0gb3B0aW9ucy5yZXRyeShlcnIsIHJlcywgbiArIDEpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChuID49IChvcHRpb25zLm1heFJldHJpZXMgfCA1KSkge1xuICAgICAgICAgIHJldHJ5ID0gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJldHJ5KSB7XG4gICAgICAgICAgdmFyIGRlbGF5ID0gb3B0aW9ucy5yZXRyeURlbGF5O1xuICAgICAgICAgIGlmICh0eXBlb2Ygb3B0aW9ucy5yZXRyeURlbGF5ID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICBkZWxheSA9IG9wdGlvbnMucmV0cnlEZWxheShlcnIsIHJlcywgbiArIDEpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBkZWxheSA9IGRlbGF5IHx8IDIwMDtcbiAgICAgICAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIGF0dGVtcHQobiArIDEpO1xuICAgICAgICAgIH0sIGRlbGF5KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBpZiAoZXJyKSByZWplY3QoZXJyKTtcbiAgICAgICAgICBlbHNlIHJlc29sdmUocmVzKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfVxuICAgIGlmIChvcHRpb25zLnJldHJ5ICYmIG1ldGhvZCA9PT0gJ0dFVCcpIHtcbiAgICAgIHJldHVybiBhdHRlbXB0KDApO1xuICAgIH1cblxuICAgIC8vIGhhbmRsZSBjcm9zcyBkb21haW5cblxuICAgIHZhciBtYXRjaDtcbiAgICB2YXIgY3Jvc3NEb21haW4gPSAhISgobWF0Y2ggPSAvXihbXFx3LV0rOik/XFwvXFwvKFteXFwvXSspLy5leGVjKHVybCkpICYmIChtYXRjaFsyXSAhPSB3aW5kb3cubG9jYXRpb24uaG9zdCkpO1xuICAgIGlmICghY3Jvc3NEb21haW4pIG9wdGlvbnMuaGVhZGVyc1snWC1SZXF1ZXN0ZWQtV2l0aCddID0gJ1hNTEh0dHBSZXF1ZXN0JztcblxuICAgIC8vIGhhbmRsZSBxdWVyeSBzdHJpbmdcbiAgICBpZiAob3B0aW9ucy5xcykge1xuICAgICAgdXJsID0gaGFuZGxlUXModXJsLCBvcHRpb25zLnFzKTtcbiAgICB9XG5cbiAgICAvLyBoYW5kbGUganNvbiBib2R5XG4gICAgaWYgKG9wdGlvbnMuanNvbikge1xuICAgICAgb3B0aW9ucy5ib2R5ID0gSlNPTi5zdHJpbmdpZnkob3B0aW9ucy5qc29uKTtcbiAgICAgIG9wdGlvbnMuaGVhZGVyc1snQ29udGVudC1UeXBlJ10gPSAnYXBwbGljYXRpb24vanNvbic7XG4gICAgfVxuXG4gICAgaWYgKG9wdGlvbnMudGltZW91dCkge1xuICAgICAgeGhyLnRpbWVvdXQgPSBvcHRpb25zLnRpbWVvdXQ7XG4gICAgICB2YXIgc3RhcnQgPSBEYXRlLm5vdygpO1xuICAgICAgeGhyLm9udGltZW91dCA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgdmFyIGR1cmF0aW9uID0gRGF0ZS5ub3coKSAtIHN0YXJ0O1xuICAgICAgICB2YXIgZXJyID0gbmV3IEVycm9yKCdSZXF1ZXN0IHRpbWVkIG91dCBhZnRlciAnICsgZHVyYXRpb24gKyAnbXMnKTtcbiAgICAgICAgZXJyLnRpbWVvdXQgPSB0cnVlO1xuICAgICAgICBlcnIuZHVyYXRpb24gPSBkdXJhdGlvbjtcbiAgICAgICAgcmVqZWN0KGVycik7XG4gICAgICB9O1xuICAgIH1cbiAgICB4aHIub25yZWFkeXN0YXRlY2hhbmdlID0gZnVuY3Rpb24gKCkge1xuICAgICAgaWYgKHhoci5yZWFkeVN0YXRlID09PSA0KSB7XG4gICAgICAgIHZhciBoZWFkZXJzID0ge307XG4gICAgICAgIHhoci5nZXRBbGxSZXNwb25zZUhlYWRlcnMoKS5zcGxpdCgnXFxyXFxuJykuZm9yRWFjaChmdW5jdGlvbiAoaGVhZGVyKSB7XG4gICAgICAgICAgdmFyIGggPSBoZWFkZXIuc3BsaXQoJzonKTtcbiAgICAgICAgICBpZiAoaC5sZW5ndGggPiAxKSB7XG4gICAgICAgICAgICBoZWFkZXJzW2hbMF0udG9Mb3dlckNhc2UoKV0gPSBoLnNsaWNlKDEpLmpvaW4oJzonKS50cmltKCk7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgICAgdmFyIHJlcyA9IG5ldyBSZXNwb25zZSh4aHIuc3RhdHVzLCBoZWFkZXJzLCB4aHIucmVzcG9uc2VUZXh0KTtcbiAgICAgICAgcmVzLnVybCA9IHVybDtcbiAgICAgICAgcmVzb2x2ZShyZXMpO1xuICAgICAgfVxuICAgIH07XG5cbiAgICAvLyBtZXRob2QsIHVybCwgYXN5bmNcbiAgICB4aHIub3BlbihtZXRob2QsIHVybCwgdHJ1ZSk7XG5cbiAgICBmb3IgKHZhciBuYW1lIGluIG9wdGlvbnMuaGVhZGVycykge1xuICAgICAgeGhyLnNldFJlcXVlc3RIZWFkZXIobmFtZSwgb3B0aW9ucy5oZWFkZXJzW25hbWVdKTtcbiAgICB9XG5cbiAgICAvLyBhdm9pZCBzZW5kaW5nIGVtcHR5IHN0cmluZyAoIzMxOSlcbiAgICB4aHIuc2VuZChvcHRpb25zLmJvZHkgPyBvcHRpb25zLmJvZHkgOiBudWxsKTtcbiAgfSk7XG4gIHJlc3VsdC5nZXRCb2R5ID0gZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiByZXN1bHQudGhlbihmdW5jdGlvbiAocmVzKSB7IHJldHVybiByZXMuZ2V0Qm9keSgpOyB9KTtcbiAgfTtcbiAgcmV0dXJuIHJlc3VsdC5ub2RlaWZ5KGNhbGxiYWNrKTtcbn1cbiIsIid1c2Ugc3RyaWN0JztcblxudmFyIHBhcnNlID0gcmVxdWlyZSgncXMnKS5wYXJzZTtcbnZhciBzdHJpbmdpZnkgPSByZXF1aXJlKCdxcycpLnN0cmluZ2lmeTtcblxubW9kdWxlLmV4cG9ydHMgPSBoYW5kbGVRcztcbmZ1bmN0aW9uIGhhbmRsZVFzKHVybCwgcXVlcnkpIHtcbiAgdXJsID0gdXJsLnNwbGl0KCc/Jyk7XG4gIHZhciBzdGFydCA9IHVybFswXTtcbiAgdmFyIHFzID0gKHVybFsxXSB8fCAnJykuc3BsaXQoJyMnKVswXTtcbiAgdmFyIGVuZCA9IHVybFsxXSAmJiB1cmxbMV0uc3BsaXQoJyMnKS5sZW5ndGggPiAxID8gJyMnICsgdXJsWzFdLnNwbGl0KCcjJylbMV0gOiAnJztcblxuICB2YXIgYmFzZVFzID0gcGFyc2UocXMpO1xuICBmb3IgKHZhciBpIGluIHF1ZXJ5KSB7XG4gICAgYmFzZVFzW2ldID0gcXVlcnlbaV07XG4gIH1cbiAgcXMgPSBzdHJpbmdpZnkoYmFzZVFzKTtcbiAgaWYgKHFzICE9PSAnJykge1xuICAgIHFzID0gJz8nICsgcXM7XG4gIH1cbiAgcmV0dXJuIHN0YXJ0ICsgcXMgKyBlbmQ7XG59XG4iLCJ2YXIgY3VycnlOID0gcmVxdWlyZSgncmFtZGEvc3JjL2N1cnJ5TicpO1xuXG52YXIgaXNTdHJpbmcgPSBmdW5jdGlvbihzKSB7IHJldHVybiB0eXBlb2YgcyA9PT0gJ3N0cmluZyc7IH07XG52YXIgaXNOdW1iZXIgPSBmdW5jdGlvbihuKSB7IHJldHVybiB0eXBlb2YgbiA9PT0gJ251bWJlcic7IH07XG52YXIgaXNCb29sZWFuID0gZnVuY3Rpb24oYikgeyByZXR1cm4gdHlwZW9mIGIgPT09ICdib29sZWFuJzsgfTtcbnZhciBpc09iamVjdCA9IGZ1bmN0aW9uKHZhbHVlKSB7XG4gIHZhciB0eXBlID0gdHlwZW9mIHZhbHVlO1xuICByZXR1cm4gISF2YWx1ZSAmJiAodHlwZSA9PSAnb2JqZWN0JyB8fCB0eXBlID09ICdmdW5jdGlvbicpO1xufTtcbnZhciBpc0Z1bmN0aW9uID0gZnVuY3Rpb24oZikgeyByZXR1cm4gdHlwZW9mIGYgPT09ICdmdW5jdGlvbic7IH07XG52YXIgaXNBcnJheSA9IEFycmF5LmlzQXJyYXkgfHwgZnVuY3Rpb24oYSkgeyByZXR1cm4gJ2xlbmd0aCcgaW4gYTsgfTtcblxudmFyIG1hcENvbnN0clRvRm4gPSBmdW5jdGlvbihncm91cCwgY29uc3RyKSB7XG4gIHJldHVybiBjb25zdHIgPT09IFN0cmluZyAgICA/IGlzU3RyaW5nXG4gICAgICAgOiBjb25zdHIgPT09IE51bWJlciAgICA/IGlzTnVtYmVyXG4gICAgICAgOiBjb25zdHIgPT09IEJvb2xlYW4gICA/IGlzQm9vbGVhblxuICAgICAgIDogY29uc3RyID09PSBPYmplY3QgICAgPyBpc09iamVjdFxuICAgICAgIDogY29uc3RyID09PSBBcnJheSAgICAgPyBpc0FycmF5XG4gICAgICAgOiBjb25zdHIgPT09IEZ1bmN0aW9uICA/IGlzRnVuY3Rpb25cbiAgICAgICA6IGNvbnN0ciA9PT0gdW5kZWZpbmVkID8gZ3JvdXBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDogY29uc3RyO1xufTtcblxudmFyIG51bVRvU3RyID0gWydmaXJzdCcsICdzZWNvbmQnLCAndGhpcmQnLCAnZm91cnRoJywgJ2ZpZnRoJywgJ3NpeHRoJywgJ3NldmVudGgnLCAnZWlnaHRoJywgJ25pbnRoJywgJ3RlbnRoJ107XG5cbnZhciB2YWxpZGF0ZSA9IGZ1bmN0aW9uKGdyb3VwLCB2YWxpZGF0b3JzLCBuYW1lLCBhcmdzKSB7XG4gIHZhciB2YWxpZGF0b3IsIHYsIGk7XG4gIGZvciAoaSA9IDA7IGkgPCBhcmdzLmxlbmd0aDsgKytpKSB7XG4gICAgdiA9IGFyZ3NbaV07XG4gICAgdmFsaWRhdG9yID0gbWFwQ29uc3RyVG9Gbihncm91cCwgdmFsaWRhdG9yc1tpXSk7XG4gICAgaWYgKFR5cGUuY2hlY2sgPT09IHRydWUgJiZcbiAgICAgICAgKHZhbGlkYXRvci5wcm90b3R5cGUgPT09IHVuZGVmaW5lZCB8fCAhdmFsaWRhdG9yLnByb3RvdHlwZS5pc1Byb3RvdHlwZU9mKHYpKSAmJlxuICAgICAgICAodHlwZW9mIHZhbGlkYXRvciAhPT0gJ2Z1bmN0aW9uJyB8fCAhdmFsaWRhdG9yKHYpKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignd3JvbmcgdmFsdWUgJyArIHYgKyAnIHBhc3NlZCB0byBsb2NhdGlvbiAnICsgbnVtVG9TdHJbaV0gKyAnIGluICcgKyBuYW1lKTtcbiAgICB9XG4gIH1cbn07XG5cbmZ1bmN0aW9uIHZhbHVlVG9BcnJheSh2YWx1ZSkge1xuICB2YXIgaSwgYXJyID0gW107XG4gIGZvciAoaSA9IDA7IGkgPCB2YWx1ZS5fa2V5cy5sZW5ndGg7ICsraSkge1xuICAgIGFyci5wdXNoKHZhbHVlW3ZhbHVlLl9rZXlzW2ldXSk7XG4gIH1cbiAgcmV0dXJuIGFycjtcbn1cblxuZnVuY3Rpb24gZXh0cmFjdFZhbHVlcyhrZXlzLCBvYmopIHtcbiAgdmFyIGFyciA9IFtdLCBpO1xuICBmb3IgKGkgPSAwOyBpIDwga2V5cy5sZW5ndGg7ICsraSkgYXJyW2ldID0gb2JqW2tleXNbaV1dO1xuICByZXR1cm4gYXJyO1xufVxuXG5mdW5jdGlvbiBjb25zdHJ1Y3Rvcihncm91cCwgbmFtZSwgZmllbGRzKSB7XG4gIHZhciB2YWxpZGF0b3JzLCBrZXlzID0gT2JqZWN0LmtleXMoZmllbGRzKSwgaTtcbiAgaWYgKGlzQXJyYXkoZmllbGRzKSkge1xuICAgIHZhbGlkYXRvcnMgPSBmaWVsZHM7XG4gIH0gZWxzZSB7XG4gICAgdmFsaWRhdG9ycyA9IGV4dHJhY3RWYWx1ZXMoa2V5cywgZmllbGRzKTtcbiAgfVxuICBmdW5jdGlvbiBjb25zdHJ1Y3QoKSB7XG4gICAgdmFyIHZhbCA9IE9iamVjdC5jcmVhdGUoZ3JvdXAucHJvdG90eXBlKSwgaTtcbiAgICB2YWwuX2tleXMgPSBrZXlzO1xuICAgIHZhbC5fbmFtZSA9IG5hbWU7XG4gICAgaWYgKFR5cGUuY2hlY2sgPT09IHRydWUpIHtcbiAgICAgIHZhbGlkYXRlKGdyb3VwLCB2YWxpZGF0b3JzLCBuYW1lLCBhcmd1bWVudHMpO1xuICAgIH1cbiAgICBmb3IgKGkgPSAwOyBpIDwgYXJndW1lbnRzLmxlbmd0aDsgKytpKSB7XG4gICAgICB2YWxba2V5c1tpXV0gPSBhcmd1bWVudHNbaV07XG4gICAgfVxuICAgIHJldHVybiB2YWw7XG4gIH1cbiAgZ3JvdXBbbmFtZV0gPSBjdXJyeU4oa2V5cy5sZW5ndGgsIGNvbnN0cnVjdCk7XG4gIGlmIChrZXlzICE9PSB1bmRlZmluZWQpIHtcbiAgICBncm91cFtuYW1lKydPZiddID0gZnVuY3Rpb24ob2JqKSB7XG4gICAgICByZXR1cm4gY29uc3RydWN0LmFwcGx5KHVuZGVmaW5lZCwgZXh0cmFjdFZhbHVlcyhrZXlzLCBvYmopKTtcbiAgICB9O1xuICB9XG59XG5cbmZ1bmN0aW9uIHJhd0Nhc2UodHlwZSwgY2FzZXMsIHZhbHVlLCBhcmcpIHtcbiAgdmFyIHdpbGRjYXJkID0gZmFsc2U7XG4gIHZhciBoYW5kbGVyID0gY2FzZXNbdmFsdWUuX25hbWVdO1xuICBpZiAoaGFuZGxlciA9PT0gdW5kZWZpbmVkKSB7XG4gICAgaGFuZGxlciA9IGNhc2VzWydfJ107XG4gICAgd2lsZGNhcmQgPSB0cnVlO1xuICB9XG4gIGlmIChUeXBlLmNoZWNrID09PSB0cnVlKSB7XG4gICAgaWYgKCF0eXBlLnByb3RvdHlwZS5pc1Byb3RvdHlwZU9mKHZhbHVlKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignd3JvbmcgdHlwZSBwYXNzZWQgdG8gY2FzZScpO1xuICAgIH0gZWxzZSBpZiAoaGFuZGxlciA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ25vbi1leGhhdXN0aXZlIHBhdHRlcm5zIGluIGEgZnVuY3Rpb24nKTtcbiAgICB9XG4gIH1cbiAgdmFyIGFyZ3MgPSB3aWxkY2FyZCA9PT0gdHJ1ZSA/IFthcmddXG4gICAgICAgICAgIDogYXJnICE9PSB1bmRlZmluZWQgPyB2YWx1ZVRvQXJyYXkodmFsdWUpLmNvbmNhdChbYXJnXSlcbiAgICAgICAgICAgOiB2YWx1ZVRvQXJyYXkodmFsdWUpO1xuICByZXR1cm4gaGFuZGxlci5hcHBseSh1bmRlZmluZWQsIGFyZ3MpO1xufVxuXG52YXIgdHlwZUNhc2UgPSBjdXJyeU4oMywgcmF3Q2FzZSk7XG52YXIgY2FzZU9uID0gY3VycnlOKDQsIHJhd0Nhc2UpO1xuXG5mdW5jdGlvbiBjcmVhdGVJdGVyYXRvcigpIHtcbiAgcmV0dXJuIHtcbiAgICBpZHg6IDAsXG4gICAgdmFsOiB0aGlzLFxuICAgIG5leHQ6IGZ1bmN0aW9uKCkge1xuICAgICAgdmFyIGtleXMgPSB0aGlzLnZhbC5fa2V5cztcbiAgICAgIHJldHVybiB0aGlzLmlkeCA9PT0ga2V5cy5sZW5ndGhcbiAgICAgICAgPyB7ZG9uZTogdHJ1ZX1cbiAgICAgICAgOiB7dmFsdWU6IHRoaXMudmFsW2tleXNbdGhpcy5pZHgrK11dfTtcbiAgICB9XG4gIH07XG59XG5cbmZ1bmN0aW9uIFR5cGUoZGVzYykge1xuICB2YXIga2V5LCByZXMsIG9iaiA9IHt9O1xuICBvYmoucHJvdG90eXBlID0ge307XG4gIG9iai5wcm90b3R5cGVbU3ltYm9sID8gU3ltYm9sLml0ZXJhdG9yIDogJ0BAaXRlcmF0b3InXSA9IGNyZWF0ZUl0ZXJhdG9yO1xuICBvYmouY2FzZSA9IHR5cGVDYXNlKG9iaik7XG4gIG9iai5jYXNlT24gPSBjYXNlT24ob2JqKTtcbiAgZm9yIChrZXkgaW4gZGVzYykge1xuICAgIHJlcyA9IGNvbnN0cnVjdG9yKG9iaiwga2V5LCBkZXNjW2tleV0pO1xuICB9XG4gIHJldHVybiBvYmo7XG59XG5cblR5cGUuY2hlY2sgPSB0cnVlO1xuXG5tb2R1bGUuZXhwb3J0cyA9IFR5cGU7XG4iLCIndXNlIHN0cmljdCc7XG5cbmNvbnN0IGFwaVBvcnQgPSA5MDAwO1xuXG5jb25zdCBhcGlVcmwgPSBgaHR0cDovL2xvY2FsaG9zdDoke2FwaVBvcnR9L2FwaWA7XG5cbm1vZHVsZS5leHBvcnRzID0ge1xuICBhcGlQb3J0LFxuICBhcGlVcmxcbn07XG4iLCJjb25zdCBtb3JpID0gcmVxdWlyZSgnbW9yaScpO1xuY29uc3QgZmx5ZCA9IHJlcXVpcmUoJ2ZseWQnKTtcbmNvbnN0IHsgc3RyZWFtIH0gPSBmbHlkO1xuY29uc3Qgc25hYmJkb20gPSByZXF1aXJlKCdzbmFiYmRvbScpO1xuY29uc3QgcGF0Y2ggPSBzbmFiYmRvbS5pbml0KFtcbiAgcmVxdWlyZSgnc25hYmJkb20vbW9kdWxlcy9jbGFzcycpLFxuICByZXF1aXJlKCdzbmFiYmRvbS9tb2R1bGVzL3Byb3BzJyksXG4gIHJlcXVpcmUoJ3NuYWJiZG9tL21vZHVsZXMvc3R5bGUnKSxcbiAgcmVxdWlyZSgnc25hYmJkb20vbW9kdWxlcy9hdHRyaWJ1dGVzJyksXG4gIHJlcXVpcmUoJ3NuYWJiZG9tL21vZHVsZXMvZXZlbnRsaXN0ZW5lcnMnKVxuXSk7XG5cbi8vLyBSdW5zIGFuIEVsbSBhcmNoaXRlY3R1cmUgYmFzZWQgYXBwbGljYXRpb25cbi8vIGluIG9yZGVyIHRvIHNpbXBsaWZ5IGhvdCBjb2RlIHJlcGxhY2VtZW50LCB0aGVcbi8vIGNvbXBvbmVudCBwYXJhbWV0ZXIgaGVyZSBpcyBhIHJlZmVyZW5jZSB0byBhbiBvYmplY3Rcbi8vIHRoYXQgaGFzIHRoZSB0d28gZm9sbG93aW5nIHByb3BlcnRpZXM6IGB1cGRhdGVgIGFuZCBgdmlld2Bcbi8vIHRoaXMgYWxsb3dzIHRoZSBjb25zdW1lciBvZiB0aGlzIGZ1bmN0aW9uIHRvIHJlcGxhY2Vcbi8vIHRoZXNlIGZ1bmN0aW9uIGF0IHdpbGwsIGFuZCB0aGVuIGNhbGwgdGhlIGByZW5kZXJgIGZ1bmN0aW9uXG4vLyB3aGljaCBpcyBhIHByb3BlcnR5IG9uIHRoZSBvYmplY3QgdGhhdCBpcyByZXR1cm5lZCBieSBgc3RhcnRgXG5leHBvcnQgZnVuY3Rpb24gc3RhcnQocm9vdCwgbW9kZWwsIGNvbXBvbmVudCkge1xuICAvLyB0aGlzIGlzIHRoZSBzdHJlYW0gd2hpY2ggYWN0cyBhcyB0aGUgcnVuIGxvb3AsIHdoaWNoIGVuYWJsZXNcbiAgLy8gdXBkYXRlcyB0byBiZSB0cmlnZ2VyZWQgYXJiaXRyYXJpbHkuXG4gIC8vIGZseWQgaGFuZGxlcyBQcm9taXNlcyB0cmFuc3BhcmVudGx5LCBzbyBtb2RlbCBjb3VsZCBhcyB3ZWxsXG4gIC8vIGJlIGEgUHJvbWlzZSwgd2hpY2ggcmVzb2x2ZXMgdG8gYSBtb2RlbCB2YWx1ZS5cbiAgY29uc3Qgc3RhdGUkID0gc3RyZWFtKG1vZGVsKTtcblxuICAvLyB0aGlzIGlzIHRoZSBldmVudCBoYW5kbGVyIHdoaWNoIGFsbG93cyB0aGUgdmlldyB0byB0cmlnZ2VyXG4gIC8vIGFuIHVwZGF0ZS4gSXQgZXhwZWN0cyBhbiBvYmplY3Qgb2YgdHlwZSBBY3Rpb24sIGRlZmluZWQgYWJvdmVcbiAgLy8gdXNpbmcgdGhlIGB1bmlvbi10eXBlYCBsaWJyYXJ5LlxuICBjb25zdCBoYW5kbGVFdmVudCA9IGZ1bmN0aW9uIChhY3Rpb24pIHtcbiAgICBjb25zdCBjdXJyZW50U3RhdGUgPSBzdGF0ZSQoKTtcbiAgICBzdGF0ZSQoY29tcG9uZW50LnVwZGF0ZShjdXJyZW50U3RhdGUsIGFjdGlvbikpO1xuICB9O1xuXG4gIC8vIHRoZSBpbml0aWFsIHZub2RlLCB3aGljaCBpcyBub3QgYSB2aXJ0dWFsIG5vZGUsIGF0IGZpcnN0LCBidXQgd2lsbCBiZVxuICAvLyBhZnRlciB0aGUgZmlyc3QgcGFzcywgd2hlcmUgdGhpcyBiaW5kaW5nIHdpbGwgYmUgcmViaW5kZWQgdG8gYSB2aXJ0dWFsIG5vZGUuXG4gIC8vIEkuZS4gdGhlIHJlc3VsdCBvZiBjYWxsaW5nIHRoZSB2aWV3IGZ1bmN0aW9uIHdpdGggdGhlIGluaXRpYWwgc3RhdGUgYW5kXG4gIC8vIHRoZSBldmVudCBoYW5kbGVyLlxuICBsZXQgdm5vZGUgPSByb290O1xuXG4gIC8vIG1hcHMgb3ZlciB0aGUgc3RhdGUgc3RyZWFtLCBhbmQgcGF0Y2hlcyB0aGUgdmRvbVxuICAvLyB3aXRoIHRoZSByZXN1bHQgb2YgY2FsbGluZyB0aGUgdmlldyBmdW5jdGlvbiB3aXRoXG4gIC8vIHRoZSBjdXJyZW50IHN0YXRlIGFuZCB0aGUgZXZlbnQgaGFuZGxlci5cbiAgbGV0IGhpc3RvcnkgPSBtb3JpLnZlY3RvcigpO1xuXG4gIGNvbnN0IHJlbmRlciA9IChzdGF0ZSkgPT4ge1xuICAgIHZub2RlID0gcGF0Y2godm5vZGUsIGNvbXBvbmVudC52aWV3KHN0YXRlLCBoYW5kbGVFdmVudCkpO1xuICB9O1xuXG4gIC8vIHRoZSBhY3R1YWwgYXN5bmNocm9ub3VzIHJ1biBsb29wLCB3aGljaCBzaW1wbHkgaXMgYSBtYXBwaW5nIG92ZXIgdGhlXG4gIC8vIHN0YXRlIHN0cmVhbS5cbiAgZmx5ZC5tYXAoc3RhdGUgPT4ge1xuICAgIGhpc3RvcnkgPSBtb3JpLmNvbmooaGlzdG9yeSwgc3RhdGUpO1xuICAgIHJlbmRlcihzdGF0ZSk7XG4gICAgcmV0dXJuIHZub2RlO1xuICB9LCBzdGF0ZSQpO1xuXG4gIC8vIHJldHVybiB0aGUgc3RhdGUgc3RyZWFtLCBzbyB0aGF0IHRoZSBjb25zdW1lciBvZiB0aGlzIEFQSSBtYXlcbiAgLy8gZXhwb3NlIHRoZSBzdGF0ZSBzdHJlYW0gdG8gb3RoZXJzLCBpbiBvcmRlciBmb3IgdGhlbSB0byBpbnRlcmFjdFxuICAvLyB3aXRoIHRoZSBhY3RpdmUgY29tcG9uZW50LlxuICByZXR1cm4ge1xuICAgIHN0YXRlJCxcbiAgICByZW5kZXJcbiAgfTtcbn07XG5cblxuY29uc3QgZnVsZmlsbHNFZmZlY3RQcm90b2NvbCA9IHEgPT4gcSAmJiBxLmNvbnN0cnVjdG9yID09IEFycmF5ICYmIHEubGVuZ3RoID09PSAyO1xuY29uc3QgaXNFZmZlY3RPZiA9IChBLCBhKSA9PiBBLnByb3RvdHlwZS5pc1Byb3RvdHlwZU9mKGEpO1xuXG4vLyBydW5zIGFuIGVsbSBhcmNoIGJhc2VkIGFwcGxpY2F0aW9uLCBhbmQgYWxzbyBoYW5kbGVzXG4vLyBzaWRlL2VmZmVjdHMuIEl0IGRvZXMgc28gYnkgYWxsb3dpbmcgdGhlIHVwZGF0ZSBmdW5jdGlvbiB0b1xuLy8gcmV0dXJuIGFuIGFycmF5IHdoaWNoIGxvb2tzIGxpa2UgdGhpczpcbi8vIFsgZWZmZWN0LCBtb2RlbCBdXG4vLyB3aGVyZSB0aGUgZWZmZWN0IGlzIGFuIGluc3RhbmNlIG9mIGFuIGFjdGlvbiBmcm9tIHRoZSBjb21wb25lbnQuXG4vLyB3aGljaCB3aWxsIGFzeW5jaHJvbm91c2x5IHRyaWdnZXIgYSByZWN1cnNpdmUgY2FsbCB0byB0aGVcbi8vIGV2ZW50IGhhbmRsZXIuXG5leHBvcnQgZnVuY3Rpb24gYXBwbGljYXRpb24ocm9vdCwgaW5pdCwgY29tcG9uZW50KSB7XG4gIGNvbnN0IHN0YXRlJCA9IHN0cmVhbSgpO1xuXG4gIGNvbnN0IGhhbmRsZVJlc3VsdCA9IGZ1bmN0aW9uIChyZXN1bHQpIHtcbiAgICBpZiAoZnVsZmlsbHNFZmZlY3RQcm90b2NvbChyZXN1bHQpICYmIGlzRWZmZWN0T2YoY29tcG9uZW50LkFjdGlvbiwgcmVzdWx0WzBdKSkge1xuICAgICAgY29uc3QgW2VmZmVjdCwgbW9kZWxdID0gcmVzdWx0O1xuICAgICAgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IGhhbmRsZUV2ZW50KGVmZmVjdCkpO1xuICAgICAgc3RhdGUkKG1vZGVsKTtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gcmVzdWx0IGlzIHRoZSBtb2RlbFxuICAgICAgc3RhdGUkKHJlc3VsdCk7XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGhhbmRsZUV2ZW50ID0gZnVuY3Rpb24gKGFjdGlvbikge1xuICAgIGNvbnN0IGN1cnJlbnRTdGF0ZSA9IHN0YXRlJCgpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGNvbXBvbmVudC51cGRhdGUoY3VycmVudFN0YXRlLCBhY3Rpb24pO1xuICAgIGhhbmRsZVJlc3VsdChyZXN1bHQpO1xuICB9O1xuXG4gIGxldCB2bm9kZSA9IHJvb3Q7XG5cbiAgbGV0IGhpc3RvcnkgPSBtb3JpLnZlY3RvcigpO1xuXG4gIGNvbnN0IGhhbmRsZVN1YlJlc3VsdCA9IGZ1bmN0aW9uIChwYXRoLCByb290TW9kZWwsIHN1YkNvbXBvbmVudCwgcmVzdWx0KSB7XG4gICAgaWYgKGZ1bGZpbGxzRWZmZWN0UHJvdG9jb2wocmVzdWx0KSAmJiBpc0VmZmVjdE9mKHN1YkNvbXBvbmVudC5BY3Rpb24sIHJlc3VsdFswXSkpIHtcbiAgICAgIGNvbnN0IFtlZmZlY3QsIG1vZGVsXSA9IHJlc3VsdDtcbiAgICAgIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiBoYW5kbGVTdWJFdmVudChwYXRoLCBzdWJDb21wb25lbnQsIGVmZmVjdCkpO1xuICAgICAgc3RhdGUkKHJvb3RNb2RlbC5hc3NvY0luKHBhdGgsIG1vZGVsKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIHJlc3VsdCBpcyB0aGUgbW9kZWxcbiAgICAgIHN0YXRlJChyb290TW9kZWwuYXNzb2NJbihwYXRoLCByZXN1bHQpKTtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgaGFuZGxlU3ViRXZlbnQgPSBmdW5jdGlvbiAocGF0aCwgc3ViQ29tcG9uZW50LCBhY3Rpb24pIHtcbiAgICBjb25zdCBjdXJyZW50U3RhdGUgPSBzdGF0ZSQoKTtcbiAgICBjb25zdCByZXN1bHQgPSBzdWJDb21wb25lbnQudXBkYXRlKGN1cnJlbnRTdGF0ZS5nZXRJbihwYXRoKSwgYWN0aW9uKTtcbiAgICBoYW5kbGVTdWJSZXN1bHQocGF0aCwgY3VycmVudFN0YXRlLCBzdWJDb21wb25lbnQsIHJlc3VsdCk7XG4gIH07XG4gIGNvbnN0IHN1YkNvbXBvbmVudHMgPSBPYmplY3QuY3JlYXRlKG51bGwpO1xuICBjb25zdCBzdWJDb21wb25lbnRFdmVudEhhbmRsZXIgPSBmdW5jdGlvbiAocGF0aCwgc3ViQ29tcG9uZW50KSB7XG4gICAgcmV0dXJuIGhhbmRsZVN1YkV2ZW50LmJpbmQobnVsbCwgcGF0aCwgc3ViQ29tcG9uZW50KTtcbiAgfTtcblxuICBjb25zdCByZW5kZXIgPSAoc3RhdGUpID0+IHtcbiAgICB2bm9kZSA9IHBhdGNoKHZub2RlLCBjb21wb25lbnQudmlldyhzdGF0ZSwgaGFuZGxlRXZlbnQsIHN1YkNvbXBvbmVudEV2ZW50SGFuZGxlcikpO1xuICB9O1xuXG4gIGZseWQubWFwKHN0YXRlID0+IHtcbiAgICBoaXN0b3J5ID0gbW9yaS5jb25qKGhpc3RvcnksIHN0YXRlKTtcbiAgICByZW5kZXIoc3RhdGUpO1xuICAgIHJldHVybiB2bm9kZTtcbiAgfSwgc3RhdGUkKTtcblxuICBoYW5kbGVSZXN1bHQoaW5pdCgpKTtcblxuICBjb25zdCBoaXN0b3J5TmF2aWdhdGlvbiQgPSBzdHJlYW0oKTtcbiAgZmx5ZC5tYXAobmF2ID0+IHtcbiAgICAvLyAuLi5cbiAgICB2YXIgbGFzdFN0YXRlID0gaGlzdG9yeS5wZWVrKCk7XG4gICAgaGlzdG9yeSA9IGhpc3RvcnkucG9wKCk7XG4gICAgcmVuZGVyKGxhc3RTdGF0ZSk7XG4gIH0sIGhpc3RvcnlOYXZpZ2F0aW9uJCk7XG4gIHdpbmRvdy5IID0gaGlzdG9yeU5hdmlnYXRpb24kO1xuXG4gIHJldHVybiB7XG4gICAgc3RhdGUkLFxuICAgIHJlbmRlcixcblxuICAgIGhpc3RvcnlOYXZpZ2F0aW9uJFxuICB9O1xufTtcbiIsImNvbnN0IHJlcXVlc3QgPSByZXF1aXJlKCd0aGVuLXJlcXVlc3QnKTtcbmNvbnN0IGggPSByZXF1aXJlKCdzbmFiYmRvbS9oJyk7XG5jb25zdCBUeXBlID0gcmVxdWlyZSgndW5pb24tdHlwZScpO1xuY29uc3QgZmx5ZCA9IHJlcXVpcmUoJ2ZseWQnKTtcbmNvbnN0IHsgc3RyZWFtIH0gPSBmbHlkO1xuY29uc3QgbW9yaSA9IHJlcXVpcmUoJ21vcmktZmx1ZW50JykocmVxdWlyZSgnbW9yaScpKTtcbmNvbnN0IHtcbiAgdmVjdG9yLFxuICBoYXNoTWFwLFxufSA9IG1vcmk7XG5cbmNvbnN0IHN1YkNvbXBvbmVudCA9IChmdW5jdGlvbiAoKSB7XG4gIGNvbnN0IHN1Ym1vZGVsID0gMTtcbiAgY29uc3Qgc3ViaW5pdCA9IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gc3VibW9kZWw7XG4gIH07XG4gIGNvbnN0IFN1YmFjdGlvbiA9IFR5cGUoe1xuICAgIEluYzogW11cbiAgfSk7XG5cbiAgZnVuY3Rpb24gc3VidXBkYXRlKG1vZGVsLCBhY3Rpb24pIHtcbiAgICByZXR1cm4gU3ViYWN0aW9uLmNhc2Uoe1xuICAgICAgSW5jOiAoKSA9PiBtb2RlbCArIDFcbiAgICB9LCBhY3Rpb24pO1xuICB9O1xuICBjb25zdCBzdWJ2aWV3ID0gZnVuY3Rpb24gKG1vZGVsLCBldmVudCwgc3ViRXZlbnQpIHtcbiAgICByZXR1cm4gaCgnZGl2Jywge1xuICAgICAgb246IHtcbiAgICAgICAgY2xpY2s6IGUgPT4gZXZlbnQoU3ViYWN0aW9uLkluYygpKVxuICAgICAgfVxuICAgIH0sIG1vZGVsKTtcbiAgfTtcbiAgcmV0dXJuIHtcbiAgICBzdWJtb2RlbCxcbiAgICBpbml0OiBzdWJpbml0LFxuICAgIEFjdGlvbjogU3ViYWN0aW9uLFxuICAgIHVwZGF0ZTogc3VidXBkYXRlLFxuICAgIHZpZXc6IHN1YnZpZXdcbiAgfTtcbn0pKCk7XG5cbmNvbnN0IHtzaW1wbGUsIHJhd1NWR30gPSByZXF1aXJlKCcuL3Rocm9iYmVyJyk7XG5cbmNvbnN0IHsgYXBpVXJsIH0gPSByZXF1aXJlKCcuL2NvbmZpZycpO1xuXG5jb25zdCBwYXJzZSA9IGpzb24gPT4gSlNPTi5wYXJzZShqc29uKTtcblxuZXhwb3J0IGNvbnN0IG1vZGVsID0gaGFzaE1hcChcbiAgJ2xvYWRpbmcnLCBmYWxzZSxcbiAgJ2RhdGEnLCBbXSxcbiAgJ3BhZ2UnLCAxLFxuICAncGFnZVNpemUnLCAyMCxcbiAgJ3N1YkRhdGEnLCBzdWJDb21wb25lbnQuaW5pdCgpXG4pO1xuXG4vLyBpbml0IGZ1bmMgd2l0aCBzaWRlIGVmZmVjdC5cbmV4cG9ydCBjb25zdCBpbml0ID0gKC4uLnByb3BzKSA9PiBbXG4gIEFjdGlvbi5Jbml0R2V0KCksXG4gIG1vZGVsLmFzc29jKC4uLnByb3BzIHx8IFtdKVxuXTtcblxuZXhwb3J0IGNvbnN0IEFjdGlvbiA9IFR5cGUoe1xuICBJbml0R2V0OiBbXSxcbiAgR2V0OiBbXSxcbiAgTmV4dFBhZ2U6IFtdLFxuICBQcmV2UGFnZTogW11cbn0pO1xuXG5leHBvcnQgY29uc3QgdXBkYXRlID0gKG1vZGVsLCBhY3Rpb24pID0+IHtcbiAgcmV0dXJuIEFjdGlvbi5jYXNlKHtcbiAgICBJbml0R2V0OiAoKSA9PiB7XG4gICAgICByZXR1cm4gW1xuICAgICAgICBBY3Rpb24uR2V0KCksXG4gICAgICAgIG1vZGVsLmFzc29jKFxuICAgICAgICAgICdsb2FkaW5nJywgdHJ1ZVxuICAgICAgICApXG4gICAgICBdO1xuICAgIH0sXG4gICAgR2V0OiAoKSA9PiByZXF1ZXN0KCdHRVQnLCBgJHthcGlVcmx9L2RhdGFgKS5nZXRCb2R5KClcbiAgICAgIC50aGVuKGQgPT4ge1xuICAgICAgICBjb25zdCByZXMgPSBwYXJzZShkKTtcbiAgICAgICAgY29uc3Qgd29yZHMgPSByZXMuc3BsaXQoJ1xcbicpO1xuICAgICAgICByZXR1cm4gbW9kZWwuYXNzb2MoXG4gICAgICAgICAgJ2xvYWRpbmcnLCBmYWxzZSxcbiAgICAgICAgICAnZGF0YScsIHdvcmRzXG4gICAgICAgICk7XG4gICAgICB9KSxcbiAgICBOZXh0UGFnZTogKCkgPT4gbW9kZWwudXBkYXRlSW4oWydwYWdlJ10sIG1vcmkuaW5jKSxcbiAgICBQcmV2UGFnZTogKCkgPT4gbW9kZWwudXBkYXRlSW4oWydwYWdlJ10sIG1vcmkuZGVjKVxuICB9LCBhY3Rpb24pO1xufTtcblxuZXhwb3J0IGNvbnN0IHZpZXcgPSAobW9kZWwsIGV2ZW50LCBzdWJFdmVudCkgPT4ge1xuICBjb25zdCB7XG4gICAgbG9hZGluZyxcbiAgICBkYXRhLFxuICAgIHBhZ2UsXG4gICAgcGFnZVNpemVcbiAgfSA9IG1vZGVsLnRvSnMoKTtcblxuICBjb25zdCBwZyA9IGRhdGEuc2xpY2UoKHBhZ2UgLSAxKSAqIHBhZ2VTaXplLCBwYWdlICogcGFnZVNpemUpO1xuXG4gIHJldHVybiBoKCdkaXYnLCBbXG5cbiAgICBzdWJDb21wb25lbnQudmlldyhtb2RlbC5nZXRJbihbICdzdWJEYXRhJyBdKSwgc3ViRXZlbnQoWyAnc3ViRGF0YScgXSwgc3ViQ29tcG9uZW50KSksXG5cbiAgICBsb2FkaW5nID9cbiAgICAgIGgoJ2Rpdi50aHJvYmJlcicsIHtcbiAgICAgICAgc3R5bGU6IHtcbiAgICAgICAgICBiYWNrZ3JvdW5kOiAnI2RkZCcsXG4gICAgICAgICAgZGlzcGxheTogJ2ZsZXgnLFxuICAgICAgICAgIGhlaWdodDogJzEwMCUnLFxuICAgICAgICAgIGFsaWduSXRlbXM6ICdjZW50ZXInLFxuICAgICAgICAgIGp1c3RpZnlDb250ZW50OiAnY2VudGVyJ1xuICAgICAgICB9XG4gICAgICB9LCBbXG4gICAgICAgIGgoJ3NwYW4nLCB7XG4gICAgICAgICAgcHJvcHM6IHtcbiAgICAgICAgICAgIGlubmVySFRNTDogcmF3U1ZHKDEwMClcbiAgICAgICAgICB9XG4gICAgICAgIH0pXG4gICAgICBdKVxuICAgIDogaCgnZGl2Jywge3N0eWxlOiB7Y29sb3I6ICcjZWVlJywgYmFja2dyb3VuZDogJyM2NjYnfX0sIFtcbiAgICAgIGgoJ2J1dHRvbicsIHtcbiAgICAgICAgcHJvcHM6IHtcbiAgICAgICAgICBpbm5lckhUTUw6ICcmbGFxdW87JyxcbiAgICAgICAgICB0eXBlOiAnYnV0dG9uJyxcbiAgICAgICAgICBkaXNhYmxlZDogcGFnZSA9PT0gMVxuICAgICAgICB9LFxuICAgICAgICBvbjoge1xuICAgICAgICAgIGNsaWNrOiBlID0+IGV2ZW50KEFjdGlvbi5QcmV2UGFnZSgpKVxuICAgICAgICB9XG4gICAgICB9KSxcbiAgICAgIGgoJ3NwYW4nLCB7c3R5bGU6IHtmb250V2VpZ2h0OiAnYm9sZCcsIG1hcmdpbjogJzFyZW0gMnJlbSd9fSwgcGFnZSksXG4gICAgICBoKCdidXR0b24nLCB7XG4gICAgICAgIHByb3BzOiB7XG4gICAgICAgICAgaW5uZXJIVE1MOiAnJnJhcXVvOycsXG4gICAgICAgICAgdHlwZTogJ2J1dHRvbicsXG4gICAgICAgICAgZGlzYWJsZWQ6IHBhZ2UgKiBwYWdlU2l6ZSA+PSBkYXRhLmxlbmd0aFxuICAgICAgICB9LFxuICAgICAgICBvbjoge1xuICAgICAgICAgIGNsaWNrOiBlID0+IGV2ZW50KEFjdGlvbi5OZXh0UGFnZSgpKVxuICAgICAgICB9XG4gICAgICB9KSxcbiAgICBdKSxcbiAgICBoKCdkaXYnLCBwZy5tYXAodCA9PiBoKCdkaXYnLCB0KSkpXG4gIF0pO1xufTtcbiIsIid1c2Ugc3RyaWN0JztcblxuY29uc3QgbW9yaSA9IHJlcXVpcmUoJ21vcmktZmx1ZW50JykocmVxdWlyZSgnbW9yaScpLCByZXF1aXJlKCdtb3JpLWZsdWVudC9leHRyYScpKTtcbmNvbnN0IHsgc3RhcnQsIGFwcGxpY2F0aW9uIH0gPSByZXF1aXJlKCcuL2NvcmUnKTtcblxuLy8gdGhlIHdyYXBwZXIgcm9vdCBjb21wb25lbnQsIHdoaWNoIGlzIHVzZWQgdG8gZmFjaWxpdGF0ZVxuLy8ga2VlcGluZyB0aGlzIG1vZHVsZSBzb21ld2hhdCBhZ25vc3RpYyB0byBjaGFuZ2VzIGluIHRoZVxuLy8gdW5kZXJseWluZyBjb21wb25lbnRzLCB3aGljaCBoZWxwcyB0byBrZWVwIHRoZSBsb2dpY1xuLy8gcmVnYXJkaW5nIGhvdCBjb2RlIHNpbXBsZS5cbmNvbnN0IFJvb3RDb21wb25lbnQgPSByZXF1aXJlKCcuL3Jvb3RfY29tcG9uZW50Jyk7XG5cbmZ1bmN0aW9uIGluaXQoKSB7XG4gIC8vIHRoaXMgaXMgdGhlIGVsZW1lbnQgaW4gd2hpY2ggb3VyIGNvbXBvbmVudCBpcyByZW5kZXJlZFxuICBjb25zdCByb290ID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignI3Jvb3QnKTtcblxuICAvLyBzdGFydCByZXR1cm5zIGFuIG9iamVjdCB0aGF0IGNvbnRhaW5zIHRoZSBzdGF0ZSBzdHJlYW1cbiAgLy8gYW5kIGEgcmVuZGVyIGZ1bmN0aW9uLCB3aGljaCBpbiB0dXJuIGFjY2VwdHMgYSBtb2RlbFxuICBjb25zdCB7XG4gICAgc3RhdGUkLFxuICAgIHJlbmRlclxuICAvL30gPSBzdGFydChyb290LCBSb290Q29tcG9uZW50LmluaXQoKSwgUm9vdENvbXBvbmVudCk7XG4gIH0gPSBhcHBsaWNhdGlvbihyb290LCBSb290Q29tcG9uZW50LmluaXQsIFJvb3RDb21wb25lbnQpO1xuXG5cbiAgLy8gSWYgaG90IG1vZHVsZSByZXBsYWNlbWVudCBpcyBlbmFibGVkXG4gIGlmIChtb2R1bGUuaG90KSB7XG4gICAgLy8gV2UgYWNjZXB0IHVwZGF0ZXMgdG8gdGhlIHRvcCBjb21wb25lbnRcbiAgICBtb2R1bGUuaG90LmFjY2VwdCgnLi9yb290X2NvbXBvbmVudCcsIChjb21wKSA9PiB7XG4gICAgICAvLyBSZWxvYWQgdGhlIGNvbXBvbmVudFxuICAgICAgY29uc3QgY29tcG9uZW50ID0gcmVxdWlyZSgnLi9yb290X2NvbXBvbmVudCcpO1xuICAgICAgLy8gTXV0YXRlIHRoZSB2YXJpYWJsZSBob2xkaW5nIG91ciBjb21wb25lbnQgd2l0aCB0aGUgbmV3IGNvZGVcbiAgICAgIE9iamVjdC5hc3NpZ24oUm9vdENvbXBvbmVudCwgY29tcG9uZW50KTtcbiAgICAgIC8vIFJlbmRlciB2aWV3IGluIHRoZSBjYXNlIHRoYXQgYW55IHZpZXcgZnVuY3Rpb25zIGhhcyBjaGFuZ2VkXG4gICAgICByZW5kZXIoc3RhdGUkKCkpO1xuICAgIH0pO1xuICB9XG5cbiAgLy8gZXhwb3NlIHRoZSBzdGF0ZSBzdHJlYW0gdG8gd2luZG93LCB3aGljaCBhbGxvd3MgZm9yIGRlYnVnZ2luZyxcbiAgLy8gZS5nLiB3aW5kb3cuc3RhdGUkKDxtb2RlbD4pIHdvdWxkIHRyaWdnZXIgYSByZW5kZXIgd2l0aCB0aGUgbmV3IGRhdGEuXG4gIHdpbmRvdy5zdGF0ZSQgPSBzdGF0ZSQ7XG5cbiAgLy8gc2luY2UgdGhlIHN0YXRlIGlzIGEgbW9yaSBkYXRhIHN0cnVjdHVyZSwgYWxzbyBleHBvc2UgbW9yaVxuICB3aW5kb3cubW9yaSA9IG1vcmk7XG59XG5cbi8vLyBCT09UU1RSQVBQSU5HXG5jb25zdCByZWFkeVN0YXRlcyA9IHtpbnRlcmFjdGl2ZToxLCBjb21wbGV0ZToxfTtcbmlmIChkb2N1bWVudC5yZWFkeVN0YXRlIGluIHJlYWR5U3RhdGVzKSB7XG4gIGluaXQoKTtcbn0gZWxzZSB7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ0RPTUNvbnRlbnRMb2FkZWQnLCBpbml0KTtcbn1cbiIsImNvbnN0IGFwcCA9IHJlcXVpcmUoJy4vbGlzdDInKTtcbi8vY29uc3QgYXBwID0gcmVxdWlyZSgnLi9vdXRsaXN0Jyk7XG5cbi8vZXhwb3J0IGNvbnN0IGluaXQgPSBhcHAuaW5pdEFuZEZldGNoO1xuZXhwb3J0IGNvbnN0IGluaXQgPSBhcHAuaW5pdDtcbmV4cG9ydCBjb25zdCB1cGRhdGUgPSBhcHAudXBkYXRlO1xuZXhwb3J0IGNvbnN0IHZpZXcgPSBhcHAudmlldztcbmV4cG9ydCBjb25zdCBBY3Rpb24gPSBhcHAuQWN0aW9uO1xuXG4oKCkgPT4ge1xuICBjb25zdCBUeXBlID0gcmVxdWlyZSgndW5pb24tdHlwZScpO1xuICBjb25zdCBtb3JpID0gcmVxdWlyZSgnbW9yaS1mbHVlbnQnKShyZXF1aXJlKCdtb3JpJykpO1xuICBjb25zdCB7dmVjdG9yLCBoYXNoTWFwfSA9IG1vcmk7XG5cbiAgY29uc3QgaXNDb21wb25lbnQgPSB2YWwgPT4gdmFsICYmIHR5cGVvZiB2YWwuaW5pdCA9PT0gJ2Z1bmN0aW9uJztcblxuICBjb25zdCBtb2RlbCA9IGhhc2hNYXAoKTtcbiAgY29uc3QgaW5pdCA9ICgpID0+IG1vZGVsO1xuICBjb25zdCBBY3Rpb24gPSBUeXBlKHtcbiAgICBBZGRDb21wb25lbnQ6IFtpc0NvbXBvbmVudCwgU3RyaW5nXVxuICB9KTtcbiAgY29uc3QgdXBkYXRlID0gKG1vZGVsLCBhY3Rpb24pID0+IHtcbiAgICByZXR1cm4gQWN0aW9uLmNhc2Uoe1xuICAgICAgQWRkQ29tcG9uZW50OiAoY29tcG9uZW50LCBuYW1lKSA9PiB7XG4gICAgICAgIHJldHVybiBtb2RlbC5hc3NvYyhuYW1lLCBjb21wb25lbnQpO1xuICAgICAgfVxuICAgIH0sIGFjdGlvbik7XG4gIH07XG4gIGNvbnN0IHZpZXcgPSAobW9kZWwsIGV2ZW50KSA9PiB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH07XG59KTtcbiIsIlxuY29uc3QgaCA9IHJlcXVpcmUoJ3NuYWJiZG9tL2gnKTtcblxuY29uc3QgZGVmYXVsdFNpemUgPSAzMjtcbmV4cG9ydCBjb25zdCByYXdTVkcgPSAoc2l6ZSkgPT4gYFxuICAgIDxzdmcgd2lkdGg9XCIke3NpemUgfHwgZGVmYXVsdFNpemV9XCIgaGVpZ2h0PVwiJHtzaXplIHx8IGRlZmF1bHRTaXplfVwiIHZpZXdCb3g9XCIwIDAgMzAwIDMwMFwiXG4gICAgICAgICB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCIgdmVyc2lvbj1cIjEuMVwiPlxuICAgICAgPHBhdGggZD1cIk0gMTUwLDBcbiAgICAgICAgICAgICAgIGEgMTUwLDE1MCAwIDAsMSAxMDYuMDY2LDI1Ni4wNjZcbiAgICAgICAgICAgICAgIGwgLTM1LjM1NSwtMzUuMzU1XG4gICAgICAgICAgICAgICBhIC0xMDAsLTEwMCAwIDAsMCAtNzAuNzExLC0xNzAuNzExIHpcIlxuICAgICAgICAgICAgZmlsbD1cIiMxNEM5NjRcIj5cbiAgICAgIDwvcGF0aD5cbiAgICA8L3N2Zz5cbmA7XG5cbmV4cG9ydCBjb25zdCBzaW1wbGUgPSBoKCdzdmcnLCB7XG4gIHdpZHRoOiAxNiwgaGVpZ2h0OiAxNixcbiAgdmlld0JveDogJzAgMCAzMDAgMzAwJ1xufSwgW1xuICBoKCdwYXRoJywge1xuICAgIGF0dHJzOiB7XG4gICAgICBkOiBgTSAxNTAsMFxuICAgICAgYSAxNTAsMTUwIDAgMCwxIDEwNi4wNjYsMjU2LjA2NlxuICAgICAgbCAtMzUuMzU1LC0zNS4zNTVcbiAgICAgIGEgLTEwMCwtMTAwIDAgMCwwIC03MC43MTEsLTE3MC43MTEgemAsXG4gICAgICBmaWxsOiAnIzE0Qzk2NCdcbiAgICB9XG4gIH0sIFtcbiAgICBoKCdhbmltYXRlVHJhbnNmb3JtJywge1xuICAgICAgYXR0cnM6IHtcbiAgICAgICAgYXR0cmlidXRlTmFtZTondHJhbnNmb3JtJyxcbiAgICAgICAgYXR0cmlidXRlVHlwZTonWE1MJyxcbiAgICAgICAgdHlwZToncm90YXRlJyxcbiAgICAgICAgZnJvbTonMCAxNTAgMTUwJyxcbiAgICAgICAgdG86JzM2MCAxNTAgMTUwJyxcbiAgICAgICAgYmVnaW46JzBzJyxcbiAgICAgICAgZHVyOicxcycsXG4gICAgICAgIGZpbGw6J2ZyZWV6ZScsXG4gICAgICAgIHJlcGVhdENvdW50OidpbmRlZmluaXRlJ1xuICAgICAgfVxuICAgIH0pXG4gIF0pXG5dKTtcbiJdfQ==
