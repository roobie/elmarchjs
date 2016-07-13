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

  var render = function render(state) {
    vnode = patch(vnode, component.view(state, handleEvent));
  };

  flyd.map(function (state) {
    history = mori.conj(history, state);
    render(state);
    return vnode;
  }, state$);

  handleResult(init());

  return {
    state$: state$,
    render: render
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
var map = mori.map;
var keys = mori.keys;
var vals = mori.vals;
var equals = mori.equals;
var getIn = mori.getIn;
var get = mori.get;
var assoc = mori.assoc;
var updateIn = mori.updateIn;
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

var model = exports.model = hashMap('loading', false, 'data', [], 'page', 1, 'pageSize', 20);

// init func with side effect.
var init = exports.init = function init() {
  for (var _len = arguments.length, props = Array(_len), _key = 0; _key < _len; _key++) {
    props[_key] = arguments[_key];
  }

  return [Action.InitGet(), model.assoc.apply(model, _toConsumableArray(props || []))];
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
      return updateIn(model, ['page'], mori.inc);
    },
    PrevPage: function PrevPage() {
      return updateIn(model, ['page'], mori.dec);
    }
  }, action);
};

var view = exports.view = function view(model, event) {
  var _model$toJs = model.toJs();

  var loading = _model$toJs.loading;
  var data = _model$toJs.data;
  var page = _model$toJs.page;
  var pageSize = _model$toJs.pageSize;


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
  })]) : h('div', { style: { color: '#eee', background: '#666' } }, [h('button', {
    props: { type: 'button', disabled: page === 1 },
    on: {
      click: function click(e) {
        return event(Action.PrevPage());
      }
    }
  }, 'Prev page'), h('span', { style: { fontWeight: 'bold', margin: '1rem 2rem' } }, page), h('button', {
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
var app = require('./list');
//const app = require('./outlist');

//export const init = app.initAndFetch;
var init = exports.init = app.init;
var update = exports.update = app.update;
var view = exports.view = app.view;
var Action = exports.Action = app.Action;

},{"./list":48}],51:[function(require,module,exports){
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL25vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCIuLi9ub2RlX21vZHVsZXMvYXNhcC9icm93c2VyLWFzYXAuanMiLCIuLi9ub2RlX21vZHVsZXMvYXNhcC9icm93c2VyLXJhdy5qcyIsIi4uL25vZGVfbW9kdWxlcy9mbHlkL2xpYi9pbmRleC5qcyIsIi4uL25vZGVfbW9kdWxlcy9mbHlkL25vZGVfbW9kdWxlcy9yYW1kYS9zcmMvY3VycnlOLmpzIiwiLi4vbm9kZV9tb2R1bGVzL2ZseWQvbm9kZV9tb2R1bGVzL3JhbWRhL3NyYy9pbnRlcm5hbC9fYXJpdHkuanMiLCIuLi9ub2RlX21vZHVsZXMvZmx5ZC9ub2RlX21vZHVsZXMvcmFtZGEvc3JjL2ludGVybmFsL19jdXJyeTEuanMiLCIuLi9ub2RlX21vZHVsZXMvZmx5ZC9ub2RlX21vZHVsZXMvcmFtZGEvc3JjL2ludGVybmFsL19jdXJyeTIuanMiLCIuLi9ub2RlX21vZHVsZXMvZmx5ZC9ub2RlX21vZHVsZXMvcmFtZGEvc3JjL2ludGVybmFsL19jdXJyeU4uanMiLCIuLi9ub2RlX21vZHVsZXMvZmx5ZC9ub2RlX21vZHVsZXMvcmFtZGEvc3JjL2ludGVybmFsL19pc1BsYWNlaG9sZGVyLmpzIiwiLi4vbm9kZV9tb2R1bGVzL2h0dHAtcmVzcG9uc2Utb2JqZWN0L2luZGV4LmpzIiwiLi4vbm9kZV9tb2R1bGVzL21vcmktZXh0L3BrZy9tb3JpLWV4dC5qcyIsIi4uL25vZGVfbW9kdWxlcy9tb3JpLWZsdWVudC9leHRyYS9pbmRleC5qcyIsIi4uL25vZGVfbW9kdWxlcy9tb3JpLWZsdWVudC9tb3JpLWZsdWVudC5qcyIsIi4uL25vZGVfbW9kdWxlcy9tb3JpL21vcmkuanMiLCIuLi9ub2RlX21vZHVsZXMvcHJvbWlzZS9pbmRleC5qcyIsIi4uL25vZGVfbW9kdWxlcy9wcm9taXNlL2xpYi9jb3JlLmpzIiwiLi4vbm9kZV9tb2R1bGVzL3Byb21pc2UvbGliL2RvbmUuanMiLCIuLi9ub2RlX21vZHVsZXMvcHJvbWlzZS9saWIvZXM2LWV4dGVuc2lvbnMuanMiLCIuLi9ub2RlX21vZHVsZXMvcHJvbWlzZS9saWIvZmluYWxseS5qcyIsIi4uL25vZGVfbW9kdWxlcy9wcm9taXNlL2xpYi9pbmRleC5qcyIsIi4uL25vZGVfbW9kdWxlcy9wcm9taXNlL2xpYi9ub2RlLWV4dGVuc2lvbnMuanMiLCIuLi9ub2RlX21vZHVsZXMvcHJvbWlzZS9saWIvc3luY2hyb25vdXMuanMiLCIuLi9ub2RlX21vZHVsZXMvcXMvbGliL2luZGV4LmpzIiwiLi4vbm9kZV9tb2R1bGVzL3FzL2xpYi9wYXJzZS5qcyIsIi4uL25vZGVfbW9kdWxlcy9xcy9saWIvc3RyaW5naWZ5LmpzIiwiLi4vbm9kZV9tb2R1bGVzL3FzL2xpYi91dGlscy5qcyIsIi4uL25vZGVfbW9kdWxlcy9zbmFiYmRvbS9oLmpzIiwiLi4vbm9kZV9tb2R1bGVzL3NuYWJiZG9tL2h0bWxkb21hcGkuanMiLCIuLi9ub2RlX21vZHVsZXMvc25hYmJkb20vaXMuanMiLCIuLi9ub2RlX21vZHVsZXMvc25hYmJkb20vbW9kdWxlcy9hdHRyaWJ1dGVzLmpzIiwiLi4vbm9kZV9tb2R1bGVzL3NuYWJiZG9tL21vZHVsZXMvY2xhc3MuanMiLCIuLi9ub2RlX21vZHVsZXMvc25hYmJkb20vbW9kdWxlcy9ldmVudGxpc3RlbmVycy5qcyIsIi4uL25vZGVfbW9kdWxlcy9zbmFiYmRvbS9tb2R1bGVzL3Byb3BzLmpzIiwiLi4vbm9kZV9tb2R1bGVzL3NuYWJiZG9tL21vZHVsZXMvc3R5bGUuanMiLCIuLi9ub2RlX21vZHVsZXMvc25hYmJkb20vc25hYmJkb20uanMiLCIuLi9ub2RlX21vZHVsZXMvc25hYmJkb20vdm5vZGUuanMiLCIuLi9ub2RlX21vZHVsZXMvdGhlbi1yZXF1ZXN0L2Jyb3dzZXIuanMiLCIuLi9ub2RlX21vZHVsZXMvdGhlbi1yZXF1ZXN0L2xpYi9oYW5kbGUtcXMuanMiLCIuLi9ub2RlX21vZHVsZXMvdW5pb24tdHlwZS91bmlvbi10eXBlLmpzIiwiLi4vc3JjL2NvbmZpZy5qcyIsIi4uL3NyYy9jb3JlLmpzIiwiLi4vc3JjL2xpc3QuanMiLCIuLi9zcmMvbWFpbi5qcyIsIi4uL3NyYy9yb290X2NvbXBvbmVudC5qcyIsIi4uL3NyYy90aHJvYmJlci5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTtBQ0FBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUNsRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7OztBQzVOQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbG5CQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0REE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2pCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDNUJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDeENBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNMQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzNDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzdNQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ0pBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM1RkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMzYUE7QUFDQTtBQUNBO0FBQ0E7O0FDSEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDck5BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDYkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzNHQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2hCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDUkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNsSUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzlEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNUQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdktBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN6SUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3BLQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNqQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdERBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDSkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdkNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2xCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzFEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNsQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNoRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbFFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNMQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQy9IQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7Ozs7Ozs7Ozs7OztBQ3RCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2xJQTs7QUFFQSxJQUFNLFVBQVUsSUFBaEI7O0FBRUEsSUFBTSwrQkFBNkIsT0FBN0IsU0FBTjs7QUFFQSxPQUFPLE9BQVAsR0FBaUI7QUFDZixrQkFEZTtBQUVmO0FBRmUsQ0FBakI7Ozs7Ozs7Ozs7O1FDYWdCLEssR0FBQSxLO1FBMERBLFcsR0FBQSxXO0FBN0VoQixJQUFNLE9BQU8sUUFBUSxNQUFSLENBQWI7QUFDQSxJQUFNLE9BQU8sUUFBUSxNQUFSLENBQWI7SUFDUSxNLEdBQVcsSSxDQUFYLE07O0FBQ1IsSUFBTSxXQUFXLFFBQVEsVUFBUixDQUFqQjtBQUNBLElBQU0sUUFBUSxTQUFTLElBQVQsQ0FBYyxDQUMxQixRQUFRLHdCQUFSLENBRDBCLEVBRTFCLFFBQVEsd0JBQVIsQ0FGMEIsRUFHMUIsUUFBUSx3QkFBUixDQUgwQixFQUkxQixRQUFRLDZCQUFSLENBSjBCLEVBSzFCLFFBQVEsaUNBQVIsQ0FMMEIsQ0FBZCxDQUFkOzs7Ozs7Ozs7QUFlTyxTQUFTLEtBQVQsQ0FBZSxJQUFmLEVBQXFCLEtBQXJCLEVBQTRCLFNBQTVCLEVBQXVDOzs7OztBQUs1QyxNQUFNLFNBQVMsT0FBTyxLQUFQLENBQWY7Ozs7O0FBS0EsTUFBTSxjQUFjLFNBQWQsV0FBYyxDQUFVLE1BQVYsRUFBa0I7QUFDcEMsUUFBTSxlQUFlLFFBQXJCO0FBQ0EsV0FBTyxVQUFVLE1BQVYsQ0FBaUIsWUFBakIsRUFBK0IsTUFBL0IsQ0FBUDtBQUNELEdBSEQ7Ozs7OztBQVNBLE1BQUksUUFBUSxJQUFaOzs7OztBQUtBLE1BQUksVUFBVSxLQUFLLE1BQUwsRUFBZDs7QUFFQSxNQUFNLFNBQVMsU0FBVCxNQUFTLENBQUMsS0FBRCxFQUFXO0FBQ3hCLFlBQVEsTUFBTSxLQUFOLEVBQWEsVUFBVSxJQUFWLENBQWUsS0FBZixFQUFzQixXQUF0QixDQUFiLENBQVI7QUFDRCxHQUZEOzs7O0FBTUEsT0FBSyxHQUFMLENBQVMsaUJBQVM7QUFDaEIsY0FBVSxLQUFLLElBQUwsQ0FBVSxPQUFWLEVBQW1CLEtBQW5CLENBQVY7QUFDQSxXQUFPLEtBQVA7QUFDQSxXQUFPLEtBQVA7QUFDRCxHQUpELEVBSUcsTUFKSDs7Ozs7QUFTQSxTQUFPO0FBQ0wsa0JBREs7QUFFTDtBQUZLLEdBQVA7QUFJRDs7QUFHRCxJQUFNLHlCQUF5QixTQUF6QixzQkFBeUI7QUFBQSxTQUFLLEtBQUssRUFBRSxXQUFGLElBQWlCLEtBQXRCLElBQStCLEVBQUUsTUFBRixLQUFhLENBQWpEO0FBQUEsQ0FBL0I7QUFDQSxJQUFNLGFBQWEsU0FBYixVQUFhLENBQUMsQ0FBRCxFQUFJLENBQUo7QUFBQSxTQUFVLEVBQUUsU0FBRixDQUFZLGFBQVosQ0FBMEIsQ0FBMUIsQ0FBVjtBQUFBLENBQW5COzs7Ozs7Ozs7QUFTTyxTQUFTLFdBQVQsQ0FBcUIsSUFBckIsRUFBMkIsSUFBM0IsRUFBaUMsU0FBakMsRUFBNEM7QUFDakQsTUFBTSxTQUFTLFFBQWY7O0FBRUEsTUFBTSxlQUFlLFNBQWYsWUFBZSxDQUFVLE1BQVYsRUFBa0I7QUFDckMsUUFBSSx1QkFBdUIsTUFBdkIsS0FBa0MsV0FBVyxVQUFVLE1BQXJCLEVBQTZCLE9BQU8sQ0FBUCxDQUE3QixDQUF0QyxFQUErRTtBQUFBO0FBQUEscUNBQ3JELE1BRHFEOztBQUFBLFlBQ3RFLE1BRHNFO0FBQUEsWUFDOUQsS0FEOEQ7O0FBRTdFLDhCQUFzQjtBQUFBLGlCQUFNLFlBQVksTUFBWixDQUFOO0FBQUEsU0FBdEI7QUFDQSxlQUFPLEtBQVA7QUFINkU7QUFJOUUsS0FKRCxNQUlPOztBQUVMLGFBQU8sTUFBUDtBQUNEO0FBQ0YsR0FURDs7QUFZQSxNQUFNLGNBQWMsU0FBZCxXQUFjLENBQVUsTUFBVixFQUFrQjtBQUNwQyxRQUFNLGVBQWUsUUFBckI7QUFDQSxRQUFNLFNBQVMsVUFBVSxNQUFWLENBQWlCLFlBQWpCLEVBQStCLE1BQS9CLENBQWY7QUFDQSxpQkFBYSxNQUFiO0FBQ0QsR0FKRDs7QUFNQSxNQUFJLFFBQVEsSUFBWjs7QUFFQSxNQUFJLFVBQVUsS0FBSyxNQUFMLEVBQWQ7O0FBRUEsTUFBTSxTQUFTLFNBQVQsTUFBUyxDQUFDLEtBQUQsRUFBVztBQUN4QixZQUFRLE1BQU0sS0FBTixFQUFhLFVBQVUsSUFBVixDQUFlLEtBQWYsRUFBc0IsV0FBdEIsQ0FBYixDQUFSO0FBQ0QsR0FGRDs7QUFJQSxPQUFLLEdBQUwsQ0FBUyxpQkFBUztBQUNoQixjQUFVLEtBQUssSUFBTCxDQUFVLE9BQVYsRUFBbUIsS0FBbkIsQ0FBVjtBQUNBLFdBQU8sS0FBUDtBQUNBLFdBQU8sS0FBUDtBQUNELEdBSkQsRUFJRyxNQUpIOztBQU1BLGVBQWEsTUFBYjs7QUFFQSxTQUFPO0FBQ0wsa0JBREs7QUFFTDtBQUZLLEdBQVA7QUFJRDs7Ozs7Ozs7Ozs7QUN0SEQsSUFBTSxVQUFVLFFBQVEsY0FBUixDQUFoQjtBQUNBLElBQU0sSUFBSSxRQUFRLFlBQVIsQ0FBVjtBQUNBLElBQU0sT0FBTyxRQUFRLFlBQVIsQ0FBYjtBQUNBLElBQU0sT0FBTyxRQUFRLE1BQVIsQ0FBYjtJQUNRLE0sR0FBVyxJLENBQVgsTTs7QUFDUixJQUFNLE9BQU8sUUFBUSxhQUFSLEVBQXVCLFFBQVEsTUFBUixDQUF2QixDQUFiO0lBRUUsTSxHQWFFLEksQ0FiRixNO0lBQ0EsTyxHQVlFLEksQ0FaRixPO0lBQ0EsRyxHQVdFLEksQ0FYRixHO0lBQ0EsSSxHQVVFLEksQ0FWRixJO0lBQ0EsSSxHQVNFLEksQ0FURixJO0lBQ0EsTSxHQVFFLEksQ0FSRixNO0lBQ0EsSyxHQU9FLEksQ0FQRixLO0lBQ0EsRyxHQU1FLEksQ0FORixHO0lBQ0EsSyxHQUtFLEksQ0FMRixLO0lBQ0EsUSxHQUlFLEksQ0FKRixRO0lBQ0EsRyxHQUdFLEksQ0FIRixHO0lBQ0EsSyxHQUVFLEksQ0FGRixLO0lBQ0EsSSxHQUNFLEksQ0FERixJOztlQUd1QixRQUFRLFlBQVIsQzs7SUFBbEIsTSxZQUFBLE07SUFBUSxNLFlBQUEsTTs7Z0JBRUksUUFBUSxVQUFSLEM7O0lBQVgsTSxhQUFBLE07OztBQUVSLElBQU0sUUFBUSxTQUFSLEtBQVE7QUFBQSxTQUFRLEtBQUssS0FBTCxDQUFXLElBQVgsQ0FBUjtBQUFBLENBQWQ7O0FBRU8sSUFBTSx3QkFBUSxRQUNuQixTQURtQixFQUNSLEtBRFEsRUFFbkIsTUFGbUIsRUFFWCxFQUZXLEVBR25CLE1BSG1CLEVBR1gsQ0FIVyxFQUluQixVQUptQixFQUlQLEVBSk8sQ0FBZDs7O0FBUUEsSUFBTSxzQkFBTyxTQUFQLElBQU87QUFBQSxvQ0FBSSxLQUFKO0FBQUksU0FBSjtBQUFBOztBQUFBLFNBQWMsQ0FDaEMsT0FBTyxPQUFQLEVBRGdDLEVBRWhDLE1BQU0sS0FBTixpQ0FBZSxTQUFTLEVBQXhCLEVBRmdDLENBQWQ7QUFBQSxDQUFiOztBQUtBLElBQU0sMEJBQVMsS0FBSztBQUN6QixXQUFTLEVBRGdCO0FBRXpCLE9BQUssRUFGb0I7QUFHekIsWUFBVSxFQUhlO0FBSXpCLFlBQVU7QUFKZSxDQUFMLENBQWY7O0FBT0EsSUFBTSwwQkFBUyxTQUFULE1BQVMsQ0FBQyxLQUFELEVBQVEsTUFBUixFQUFtQjtBQUN2QyxTQUFPLE9BQU8sSUFBUCxDQUFZO0FBQ2pCLGFBQVMsbUJBQU07QUFDYixhQUFPLENBQ0wsT0FBTyxHQUFQLEVBREssRUFFTCxNQUFNLEtBQU4sQ0FDRSxTQURGLEVBQ2EsSUFEYixDQUZLLENBQVA7QUFNRCxLQVJnQjtBQVNqQixTQUFLO0FBQUEsYUFBTSxRQUFRLEtBQVIsRUFBa0IsTUFBbEIsWUFBaUMsT0FBakMsR0FDUixJQURRLENBQ0gsYUFBSztBQUNULFlBQU0sTUFBTSxNQUFNLENBQU4sQ0FBWjtBQUNBLFlBQU0sUUFBUSxJQUFJLEtBQUosQ0FBVSxJQUFWLENBQWQ7QUFDQSxlQUFPLE1BQU0sS0FBTixDQUNMLFNBREssRUFDTSxLQUROLEVBRUwsTUFGSyxFQUVHLEtBRkgsQ0FBUDtBQUlELE9BUlEsQ0FBTjtBQUFBLEtBVFk7QUFrQmpCLGNBQVU7QUFBQSxhQUFNLFNBQVMsS0FBVCxFQUFnQixDQUFFLE1BQUYsQ0FBaEIsRUFBNEIsS0FBSyxHQUFqQyxDQUFOO0FBQUEsS0FsQk87QUFtQmpCLGNBQVU7QUFBQSxhQUFNLFNBQVMsS0FBVCxFQUFnQixDQUFFLE1BQUYsQ0FBaEIsRUFBNEIsS0FBSyxHQUFqQyxDQUFOO0FBQUE7QUFuQk8sR0FBWixFQW9CSixNQXBCSSxDQUFQO0FBcUJELENBdEJNOztBQXdCQSxJQUFNLHNCQUFPLFNBQVAsSUFBTyxDQUFDLEtBQUQsRUFBUSxLQUFSLEVBQWtCO0FBQUEsb0JBTWhDLE1BQU0sSUFBTixFQU5nQzs7QUFBQSxNQUVsQyxPQUZrQyxlQUVsQyxPQUZrQztBQUFBLE1BR2xDLElBSGtDLGVBR2xDLElBSGtDO0FBQUEsTUFJbEMsSUFKa0MsZUFJbEMsSUFKa0M7QUFBQSxNQUtsQyxRQUxrQyxlQUtsQyxRQUxrQzs7O0FBUXBDLE1BQU0sS0FBSyxLQUFLLEtBQUwsQ0FBVyxDQUFDLE9BQU8sQ0FBUixJQUFhLFFBQXhCLEVBQWtDLE9BQU8sUUFBekMsQ0FBWDs7QUFFQSxTQUFPLEVBQUUsS0FBRixFQUFTLENBQ2QsVUFDRSxFQUFFLGNBQUYsRUFBa0I7QUFDaEIsV0FBTztBQUNMLGtCQUFZLE1BRFA7QUFFTCxlQUFTLE1BRko7QUFHTCxjQUFRLE1BSEg7QUFJTCxrQkFBWSxRQUpQO0FBS0wsc0JBQWdCO0FBTFg7QUFEUyxHQUFsQixFQVFHLENBQ0QsRUFBRSxNQUFGLEVBQVU7QUFDUixXQUFPO0FBQ0wsaUJBQVcsT0FBTyxHQUFQO0FBRE47QUFEQyxHQUFWLENBREMsQ0FSSCxDQURGLEdBZ0JFLEVBQUUsS0FBRixFQUFTLEVBQUMsT0FBTyxFQUFDLE9BQU8sTUFBUixFQUFnQixZQUFZLE1BQTVCLEVBQVIsRUFBVCxFQUF1RCxDQUN2RCxFQUFFLFFBQUYsRUFBWTtBQUNWLFdBQU8sRUFBRSxNQUFNLFFBQVIsRUFBa0IsVUFBVSxTQUFTLENBQXJDLEVBREc7QUFFVixRQUFJO0FBQ0YsYUFBTztBQUFBLGVBQUssTUFBTSxPQUFPLFFBQVAsRUFBTixDQUFMO0FBQUE7QUFETDtBQUZNLEdBQVosRUFLRyxXQUxILENBRHVELEVBT3ZELEVBQUUsTUFBRixFQUFVLEVBQUMsT0FBTyxFQUFDLFlBQVksTUFBYixFQUFxQixRQUFRLFdBQTdCLEVBQVIsRUFBVixFQUE4RCxJQUE5RCxDQVB1RCxFQVF2RCxFQUFFLFFBQUYsRUFBWTtBQUNWLFdBQU8sRUFBRSxNQUFNLFFBQVIsRUFBa0IsVUFBVSxPQUFPLFFBQVAsSUFBbUIsS0FBSyxNQUFwRCxFQURHO0FBRVYsUUFBSTtBQUNGLGFBQU87QUFBQSxlQUFLLE1BQU0sT0FBTyxRQUFQLEVBQU4sQ0FBTDtBQUFBO0FBREw7QUFGTSxHQUFaLEVBS0csV0FMSCxDQVJ1RCxDQUF2RCxDQWpCWSxFQWdDZCxFQUFFLEtBQUYsRUFBUyxLQUFLLElBQUk7QUFBQSxXQUFLLEVBQUUsS0FBRixFQUFTLENBQVQsQ0FBTDtBQUFBLEdBQUosRUFBc0IsRUFBdEIsQ0FBTCxDQUFULENBaENjLENBQVQsQ0FBUDtBQWtDRCxDQTVDTTs7O0FDeEVQOztBQUVBLElBQU0sT0FBTyxRQUFRLGFBQVIsRUFBdUIsUUFBUSxNQUFSLENBQXZCLEVBQXdDLFFBQVEsbUJBQVIsQ0FBeEMsQ0FBYjs7ZUFDK0IsUUFBUSxRQUFSLEM7O0lBQXZCLEssWUFBQSxLO0lBQU8sVyxZQUFBLFc7Ozs7Ozs7QUFNZixJQUFNLGdCQUFnQixRQUFRLGtCQUFSLENBQXRCOztBQUVBLFNBQVMsSUFBVCxHQUFnQjs7QUFFZCxNQUFNLE9BQU8sU0FBUyxhQUFULENBQXVCLE9BQXZCLENBQWI7Ozs7O0FBRmMscUJBVVYsWUFBWSxJQUFaLEVBQWtCLGNBQWMsSUFBaEMsRUFBc0MsYUFBdEMsQ0FWVTs7QUFBQSxNQU9aLE1BUFksZ0JBT1osTUFQWTtBQUFBLE1BUVosTUFSWSxnQkFRWixNQVJZOzs7O0FBY2QsTUFBSSxPQUFPLEdBQVgsRUFBZ0I7O0FBRWQsV0FBTyxHQUFQLENBQVcsTUFBWCxDQUFrQixrQkFBbEIsRUFBc0MsVUFBQyxJQUFELEVBQVU7O0FBRTlDLFVBQU0sWUFBWSxRQUFRLGtCQUFSLENBQWxCOztBQUVBLGFBQU8sTUFBUCxDQUFjLGFBQWQsRUFBNkIsU0FBN0I7O0FBRUEsYUFBTyxRQUFQO0FBQ0QsS0FQRDtBQVFEOzs7O0FBSUQsU0FBTyxNQUFQLEdBQWdCLE1BQWhCOzs7QUFHQSxTQUFPLElBQVAsR0FBYyxJQUFkO0FBQ0Q7OztBQUdELElBQU0sY0FBYyxFQUFDLGFBQVksQ0FBYixFQUFnQixVQUFTLENBQXpCLEVBQXBCO0FBQ0EsSUFBSSxTQUFTLFVBQVQsSUFBdUIsV0FBM0IsRUFBd0M7QUFDdEM7QUFDRCxDQUZELE1BRU87QUFDTCxXQUFTLGdCQUFULENBQTBCLGtCQUExQixFQUE4QyxJQUE5QztBQUNEOzs7Ozs7OztBQ25ERCxJQUFNLE1BQU0sUUFBUSxRQUFSLENBQVo7Ozs7QUFJTyxJQUFNLHNCQUFPLElBQUksSUFBakI7QUFDQSxJQUFNLDBCQUFTLElBQUksTUFBbkI7QUFDQSxJQUFNLHNCQUFPLElBQUksSUFBakI7QUFDQSxJQUFNLDBCQUFTLElBQUksTUFBbkI7Ozs7Ozs7OztBQ05QLElBQU0sSUFBSSxRQUFRLFlBQVIsQ0FBVjs7QUFFQSxJQUFNLGNBQWMsRUFBcEI7QUFDTyxJQUFNLDBCQUFTLFNBQVQsTUFBUyxDQUFDLElBQUQ7QUFBQSxpQ0FDSixRQUFRLFdBREosb0JBQzRCLFFBQVEsV0FEcEM7QUFBQSxDQUFmOztBQVlBLElBQU0sMEJBQVMsRUFBRSxLQUFGLEVBQVM7QUFDN0IsU0FBTyxFQURzQixFQUNsQixRQUFRLEVBRFU7QUFFN0IsV0FBUztBQUZvQixDQUFULEVBR25CLENBQ0QsRUFBRSxNQUFGLEVBQVU7QUFDUixTQUFPO0FBQ0wsNEhBREs7QUFLTCxVQUFNO0FBTEQ7QUFEQyxDQUFWLEVBUUcsQ0FDRCxFQUFFLGtCQUFGLEVBQXNCO0FBQ3BCLFNBQU87QUFDTCxtQkFBYyxXQURUO0FBRUwsbUJBQWMsS0FGVDtBQUdMLFVBQUssUUFIQTtBQUlMLFVBQUssV0FKQTtBQUtMLFFBQUcsYUFMRTtBQU1MLFdBQU0sSUFORDtBQU9MLFNBQUksSUFQQztBQVFMLFVBQUssUUFSQTtBQVNMLGlCQUFZO0FBVFA7QUFEYSxDQUF0QixDQURDLENBUkgsQ0FEQyxDQUhtQixDQUFmIiwiZmlsZSI6ImdlbmVyYXRlZC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24gZSh0LG4scil7ZnVuY3Rpb24gcyhvLHUpe2lmKCFuW29dKXtpZighdFtvXSl7dmFyIGE9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtpZighdSYmYSlyZXR1cm4gYShvLCEwKTtpZihpKXJldHVybiBpKG8sITApO3ZhciBmPW5ldyBFcnJvcihcIkNhbm5vdCBmaW5kIG1vZHVsZSAnXCIrbytcIidcIik7dGhyb3cgZi5jb2RlPVwiTU9EVUxFX05PVF9GT1VORFwiLGZ9dmFyIGw9bltvXT17ZXhwb3J0czp7fX07dFtvXVswXS5jYWxsKGwuZXhwb3J0cyxmdW5jdGlvbihlKXt2YXIgbj10W29dWzFdW2VdO3JldHVybiBzKG4/bjplKX0sbCxsLmV4cG9ydHMsZSx0LG4scil9cmV0dXJuIG5bb10uZXhwb3J0c312YXIgaT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2Zvcih2YXIgbz0wO288ci5sZW5ndGg7bysrKXMocltvXSk7cmV0dXJuIHN9KSIsIlwidXNlIHN0cmljdFwiO1xuXG4vLyByYXdBc2FwIHByb3ZpZGVzIGV2ZXJ5dGhpbmcgd2UgbmVlZCBleGNlcHQgZXhjZXB0aW9uIG1hbmFnZW1lbnQuXG52YXIgcmF3QXNhcCA9IHJlcXVpcmUoXCIuL3Jhd1wiKTtcbi8vIFJhd1Rhc2tzIGFyZSByZWN5Y2xlZCB0byByZWR1Y2UgR0MgY2h1cm4uXG52YXIgZnJlZVRhc2tzID0gW107XG4vLyBXZSBxdWV1ZSBlcnJvcnMgdG8gZW5zdXJlIHRoZXkgYXJlIHRocm93biBpbiByaWdodCBvcmRlciAoRklGTykuXG4vLyBBcnJheS1hcy1xdWV1ZSBpcyBnb29kIGVub3VnaCBoZXJlLCBzaW5jZSB3ZSBhcmUganVzdCBkZWFsaW5nIHdpdGggZXhjZXB0aW9ucy5cbnZhciBwZW5kaW5nRXJyb3JzID0gW107XG52YXIgcmVxdWVzdEVycm9yVGhyb3cgPSByYXdBc2FwLm1ha2VSZXF1ZXN0Q2FsbEZyb21UaW1lcih0aHJvd0ZpcnN0RXJyb3IpO1xuXG5mdW5jdGlvbiB0aHJvd0ZpcnN0RXJyb3IoKSB7XG4gICAgaWYgKHBlbmRpbmdFcnJvcnMubGVuZ3RoKSB7XG4gICAgICAgIHRocm93IHBlbmRpbmdFcnJvcnMuc2hpZnQoKTtcbiAgICB9XG59XG5cbi8qKlxuICogQ2FsbHMgYSB0YXNrIGFzIHNvb24gYXMgcG9zc2libGUgYWZ0ZXIgcmV0dXJuaW5nLCBpbiBpdHMgb3duIGV2ZW50LCB3aXRoIHByaW9yaXR5XG4gKiBvdmVyIG90aGVyIGV2ZW50cyBsaWtlIGFuaW1hdGlvbiwgcmVmbG93LCBhbmQgcmVwYWludC4gQW4gZXJyb3IgdGhyb3duIGZyb20gYW5cbiAqIGV2ZW50IHdpbGwgbm90IGludGVycnVwdCwgbm9yIGV2ZW4gc3Vic3RhbnRpYWxseSBzbG93IGRvd24gdGhlIHByb2Nlc3Npbmcgb2ZcbiAqIG90aGVyIGV2ZW50cywgYnV0IHdpbGwgYmUgcmF0aGVyIHBvc3Rwb25lZCB0byBhIGxvd2VyIHByaW9yaXR5IGV2ZW50LlxuICogQHBhcmFtIHt7Y2FsbH19IHRhc2sgQSBjYWxsYWJsZSBvYmplY3QsIHR5cGljYWxseSBhIGZ1bmN0aW9uIHRoYXQgdGFrZXMgbm9cbiAqIGFyZ3VtZW50cy5cbiAqL1xubW9kdWxlLmV4cG9ydHMgPSBhc2FwO1xuZnVuY3Rpb24gYXNhcCh0YXNrKSB7XG4gICAgdmFyIHJhd1Rhc2s7XG4gICAgaWYgKGZyZWVUYXNrcy5sZW5ndGgpIHtcbiAgICAgICAgcmF3VGFzayA9IGZyZWVUYXNrcy5wb3AoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICByYXdUYXNrID0gbmV3IFJhd1Rhc2soKTtcbiAgICB9XG4gICAgcmF3VGFzay50YXNrID0gdGFzaztcbiAgICByYXdBc2FwKHJhd1Rhc2spO1xufVxuXG4vLyBXZSB3cmFwIHRhc2tzIHdpdGggcmVjeWNsYWJsZSB0YXNrIG9iamVjdHMuICBBIHRhc2sgb2JqZWN0IGltcGxlbWVudHNcbi8vIGBjYWxsYCwganVzdCBsaWtlIGEgZnVuY3Rpb24uXG5mdW5jdGlvbiBSYXdUYXNrKCkge1xuICAgIHRoaXMudGFzayA9IG51bGw7XG59XG5cbi8vIFRoZSBzb2xlIHB1cnBvc2Ugb2Ygd3JhcHBpbmcgdGhlIHRhc2sgaXMgdG8gY2F0Y2ggdGhlIGV4Y2VwdGlvbiBhbmQgcmVjeWNsZVxuLy8gdGhlIHRhc2sgb2JqZWN0IGFmdGVyIGl0cyBzaW5nbGUgdXNlLlxuUmF3VGFzay5wcm90b3R5cGUuY2FsbCA9IGZ1bmN0aW9uICgpIHtcbiAgICB0cnkge1xuICAgICAgICB0aGlzLnRhc2suY2FsbCgpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGlmIChhc2FwLm9uZXJyb3IpIHtcbiAgICAgICAgICAgIC8vIFRoaXMgaG9vayBleGlzdHMgcHVyZWx5IGZvciB0ZXN0aW5nIHB1cnBvc2VzLlxuICAgICAgICAgICAgLy8gSXRzIG5hbWUgd2lsbCBiZSBwZXJpb2RpY2FsbHkgcmFuZG9taXplZCB0byBicmVhayBhbnkgY29kZSB0aGF0XG4gICAgICAgICAgICAvLyBkZXBlbmRzIG9uIGl0cyBleGlzdGVuY2UuXG4gICAgICAgICAgICBhc2FwLm9uZXJyb3IoZXJyb3IpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gSW4gYSB3ZWIgYnJvd3NlciwgZXhjZXB0aW9ucyBhcmUgbm90IGZhdGFsLiBIb3dldmVyLCB0byBhdm9pZFxuICAgICAgICAgICAgLy8gc2xvd2luZyBkb3duIHRoZSBxdWV1ZSBvZiBwZW5kaW5nIHRhc2tzLCB3ZSByZXRocm93IHRoZSBlcnJvciBpbiBhXG4gICAgICAgICAgICAvLyBsb3dlciBwcmlvcml0eSB0dXJuLlxuICAgICAgICAgICAgcGVuZGluZ0Vycm9ycy5wdXNoKGVycm9yKTtcbiAgICAgICAgICAgIHJlcXVlc3RFcnJvclRocm93KCk7XG4gICAgICAgIH1cbiAgICB9IGZpbmFsbHkge1xuICAgICAgICB0aGlzLnRhc2sgPSBudWxsO1xuICAgICAgICBmcmVlVGFza3NbZnJlZVRhc2tzLmxlbmd0aF0gPSB0aGlzO1xuICAgIH1cbn07XG4iLCJcInVzZSBzdHJpY3RcIjtcblxuLy8gVXNlIHRoZSBmYXN0ZXN0IG1lYW5zIHBvc3NpYmxlIHRvIGV4ZWN1dGUgYSB0YXNrIGluIGl0cyBvd24gdHVybiwgd2l0aFxuLy8gcHJpb3JpdHkgb3ZlciBvdGhlciBldmVudHMgaW5jbHVkaW5nIElPLCBhbmltYXRpb24sIHJlZmxvdywgYW5kIHJlZHJhd1xuLy8gZXZlbnRzIGluIGJyb3dzZXJzLlxuLy9cbi8vIEFuIGV4Y2VwdGlvbiB0aHJvd24gYnkgYSB0YXNrIHdpbGwgcGVybWFuZW50bHkgaW50ZXJydXB0IHRoZSBwcm9jZXNzaW5nIG9mXG4vLyBzdWJzZXF1ZW50IHRhc2tzLiBUaGUgaGlnaGVyIGxldmVsIGBhc2FwYCBmdW5jdGlvbiBlbnN1cmVzIHRoYXQgaWYgYW5cbi8vIGV4Y2VwdGlvbiBpcyB0aHJvd24gYnkgYSB0YXNrLCB0aGF0IHRoZSB0YXNrIHF1ZXVlIHdpbGwgY29udGludWUgZmx1c2hpbmcgYXNcbi8vIHNvb24gYXMgcG9zc2libGUsIGJ1dCBpZiB5b3UgdXNlIGByYXdBc2FwYCBkaXJlY3RseSwgeW91IGFyZSByZXNwb25zaWJsZSB0b1xuLy8gZWl0aGVyIGVuc3VyZSB0aGF0IG5vIGV4Y2VwdGlvbnMgYXJlIHRocm93biBmcm9tIHlvdXIgdGFzaywgb3IgdG8gbWFudWFsbHlcbi8vIGNhbGwgYHJhd0FzYXAucmVxdWVzdEZsdXNoYCBpZiBhbiBleGNlcHRpb24gaXMgdGhyb3duLlxubW9kdWxlLmV4cG9ydHMgPSByYXdBc2FwO1xuZnVuY3Rpb24gcmF3QXNhcCh0YXNrKSB7XG4gICAgaWYgKCFxdWV1ZS5sZW5ndGgpIHtcbiAgICAgICAgcmVxdWVzdEZsdXNoKCk7XG4gICAgICAgIGZsdXNoaW5nID0gdHJ1ZTtcbiAgICB9XG4gICAgLy8gRXF1aXZhbGVudCB0byBwdXNoLCBidXQgYXZvaWRzIGEgZnVuY3Rpb24gY2FsbC5cbiAgICBxdWV1ZVtxdWV1ZS5sZW5ndGhdID0gdGFzaztcbn1cblxudmFyIHF1ZXVlID0gW107XG4vLyBPbmNlIGEgZmx1c2ggaGFzIGJlZW4gcmVxdWVzdGVkLCBubyBmdXJ0aGVyIGNhbGxzIHRvIGByZXF1ZXN0Rmx1c2hgIGFyZVxuLy8gbmVjZXNzYXJ5IHVudGlsIHRoZSBuZXh0IGBmbHVzaGAgY29tcGxldGVzLlxudmFyIGZsdXNoaW5nID0gZmFsc2U7XG4vLyBgcmVxdWVzdEZsdXNoYCBpcyBhbiBpbXBsZW1lbnRhdGlvbi1zcGVjaWZpYyBtZXRob2QgdGhhdCBhdHRlbXB0cyB0byBraWNrXG4vLyBvZmYgYSBgZmx1c2hgIGV2ZW50IGFzIHF1aWNrbHkgYXMgcG9zc2libGUuIGBmbHVzaGAgd2lsbCBhdHRlbXB0IHRvIGV4aGF1c3Rcbi8vIHRoZSBldmVudCBxdWV1ZSBiZWZvcmUgeWllbGRpbmcgdG8gdGhlIGJyb3dzZXIncyBvd24gZXZlbnQgbG9vcC5cbnZhciByZXF1ZXN0Rmx1c2g7XG4vLyBUaGUgcG9zaXRpb24gb2YgdGhlIG5leHQgdGFzayB0byBleGVjdXRlIGluIHRoZSB0YXNrIHF1ZXVlLiBUaGlzIGlzXG4vLyBwcmVzZXJ2ZWQgYmV0d2VlbiBjYWxscyB0byBgZmx1c2hgIHNvIHRoYXQgaXQgY2FuIGJlIHJlc3VtZWQgaWZcbi8vIGEgdGFzayB0aHJvd3MgYW4gZXhjZXB0aW9uLlxudmFyIGluZGV4ID0gMDtcbi8vIElmIGEgdGFzayBzY2hlZHVsZXMgYWRkaXRpb25hbCB0YXNrcyByZWN1cnNpdmVseSwgdGhlIHRhc2sgcXVldWUgY2FuIGdyb3dcbi8vIHVuYm91bmRlZC4gVG8gcHJldmVudCBtZW1vcnkgZXhoYXVzdGlvbiwgdGhlIHRhc2sgcXVldWUgd2lsbCBwZXJpb2RpY2FsbHlcbi8vIHRydW5jYXRlIGFscmVhZHktY29tcGxldGVkIHRhc2tzLlxudmFyIGNhcGFjaXR5ID0gMTAyNDtcblxuLy8gVGhlIGZsdXNoIGZ1bmN0aW9uIHByb2Nlc3NlcyBhbGwgdGFza3MgdGhhdCBoYXZlIGJlZW4gc2NoZWR1bGVkIHdpdGhcbi8vIGByYXdBc2FwYCB1bmxlc3MgYW5kIHVudGlsIG9uZSBvZiB0aG9zZSB0YXNrcyB0aHJvd3MgYW4gZXhjZXB0aW9uLlxuLy8gSWYgYSB0YXNrIHRocm93cyBhbiBleGNlcHRpb24sIGBmbHVzaGAgZW5zdXJlcyB0aGF0IGl0cyBzdGF0ZSB3aWxsIHJlbWFpblxuLy8gY29uc2lzdGVudCBhbmQgd2lsbCByZXN1bWUgd2hlcmUgaXQgbGVmdCBvZmYgd2hlbiBjYWxsZWQgYWdhaW4uXG4vLyBIb3dldmVyLCBgZmx1c2hgIGRvZXMgbm90IG1ha2UgYW55IGFycmFuZ2VtZW50cyB0byBiZSBjYWxsZWQgYWdhaW4gaWYgYW5cbi8vIGV4Y2VwdGlvbiBpcyB0aHJvd24uXG5mdW5jdGlvbiBmbHVzaCgpIHtcbiAgICB3aGlsZSAoaW5kZXggPCBxdWV1ZS5sZW5ndGgpIHtcbiAgICAgICAgdmFyIGN1cnJlbnRJbmRleCA9IGluZGV4O1xuICAgICAgICAvLyBBZHZhbmNlIHRoZSBpbmRleCBiZWZvcmUgY2FsbGluZyB0aGUgdGFzay4gVGhpcyBlbnN1cmVzIHRoYXQgd2Ugd2lsbFxuICAgICAgICAvLyBiZWdpbiBmbHVzaGluZyBvbiB0aGUgbmV4dCB0YXNrIHRoZSB0YXNrIHRocm93cyBhbiBlcnJvci5cbiAgICAgICAgaW5kZXggPSBpbmRleCArIDE7XG4gICAgICAgIHF1ZXVlW2N1cnJlbnRJbmRleF0uY2FsbCgpO1xuICAgICAgICAvLyBQcmV2ZW50IGxlYWtpbmcgbWVtb3J5IGZvciBsb25nIGNoYWlucyBvZiByZWN1cnNpdmUgY2FsbHMgdG8gYGFzYXBgLlxuICAgICAgICAvLyBJZiB3ZSBjYWxsIGBhc2FwYCB3aXRoaW4gdGFza3Mgc2NoZWR1bGVkIGJ5IGBhc2FwYCwgdGhlIHF1ZXVlIHdpbGxcbiAgICAgICAgLy8gZ3JvdywgYnV0IHRvIGF2b2lkIGFuIE8obikgd2FsayBmb3IgZXZlcnkgdGFzayB3ZSBleGVjdXRlLCB3ZSBkb24ndFxuICAgICAgICAvLyBzaGlmdCB0YXNrcyBvZmYgdGhlIHF1ZXVlIGFmdGVyIHRoZXkgaGF2ZSBiZWVuIGV4ZWN1dGVkLlxuICAgICAgICAvLyBJbnN0ZWFkLCB3ZSBwZXJpb2RpY2FsbHkgc2hpZnQgMTAyNCB0YXNrcyBvZmYgdGhlIHF1ZXVlLlxuICAgICAgICBpZiAoaW5kZXggPiBjYXBhY2l0eSkge1xuICAgICAgICAgICAgLy8gTWFudWFsbHkgc2hpZnQgYWxsIHZhbHVlcyBzdGFydGluZyBhdCB0aGUgaW5kZXggYmFjayB0byB0aGVcbiAgICAgICAgICAgIC8vIGJlZ2lubmluZyBvZiB0aGUgcXVldWUuXG4gICAgICAgICAgICBmb3IgKHZhciBzY2FuID0gMCwgbmV3TGVuZ3RoID0gcXVldWUubGVuZ3RoIC0gaW5kZXg7IHNjYW4gPCBuZXdMZW5ndGg7IHNjYW4rKykge1xuICAgICAgICAgICAgICAgIHF1ZXVlW3NjYW5dID0gcXVldWVbc2NhbiArIGluZGV4XTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHF1ZXVlLmxlbmd0aCAtPSBpbmRleDtcbiAgICAgICAgICAgIGluZGV4ID0gMDtcbiAgICAgICAgfVxuICAgIH1cbiAgICBxdWV1ZS5sZW5ndGggPSAwO1xuICAgIGluZGV4ID0gMDtcbiAgICBmbHVzaGluZyA9IGZhbHNlO1xufVxuXG4vLyBgcmVxdWVzdEZsdXNoYCBpcyBpbXBsZW1lbnRlZCB1c2luZyBhIHN0cmF0ZWd5IGJhc2VkIG9uIGRhdGEgY29sbGVjdGVkIGZyb21cbi8vIGV2ZXJ5IGF2YWlsYWJsZSBTYXVjZUxhYnMgU2VsZW5pdW0gd2ViIGRyaXZlciB3b3JrZXIgYXQgdGltZSBvZiB3cml0aW5nLlxuLy8gaHR0cHM6Ly9kb2NzLmdvb2dsZS5jb20vc3ByZWFkc2hlZXRzL2QvMW1HLTVVWUd1cDVxeEdkRU1Xa2hQNkJXQ3owNTNOVWIyRTFRb1VUVTE2dUEvZWRpdCNnaWQ9NzgzNzI0NTkzXG5cbi8vIFNhZmFyaSA2IGFuZCA2LjEgZm9yIGRlc2t0b3AsIGlQYWQsIGFuZCBpUGhvbmUgYXJlIHRoZSBvbmx5IGJyb3dzZXJzIHRoYXRcbi8vIGhhdmUgV2ViS2l0TXV0YXRpb25PYnNlcnZlciBidXQgbm90IHVuLXByZWZpeGVkIE11dGF0aW9uT2JzZXJ2ZXIuXG4vLyBNdXN0IHVzZSBgZ2xvYmFsYCBpbnN0ZWFkIG9mIGB3aW5kb3dgIHRvIHdvcmsgaW4gYm90aCBmcmFtZXMgYW5kIHdlYlxuLy8gd29ya2Vycy4gYGdsb2JhbGAgaXMgYSBwcm92aXNpb24gb2YgQnJvd3NlcmlmeSwgTXIsIE1ycywgb3IgTW9wLlxudmFyIEJyb3dzZXJNdXRhdGlvbk9ic2VydmVyID0gZ2xvYmFsLk11dGF0aW9uT2JzZXJ2ZXIgfHwgZ2xvYmFsLldlYktpdE11dGF0aW9uT2JzZXJ2ZXI7XG5cbi8vIE11dGF0aW9uT2JzZXJ2ZXJzIGFyZSBkZXNpcmFibGUgYmVjYXVzZSB0aGV5IGhhdmUgaGlnaCBwcmlvcml0eSBhbmQgd29ya1xuLy8gcmVsaWFibHkgZXZlcnl3aGVyZSB0aGV5IGFyZSBpbXBsZW1lbnRlZC5cbi8vIFRoZXkgYXJlIGltcGxlbWVudGVkIGluIGFsbCBtb2Rlcm4gYnJvd3NlcnMuXG4vL1xuLy8gLSBBbmRyb2lkIDQtNC4zXG4vLyAtIENocm9tZSAyNi0zNFxuLy8gLSBGaXJlZm94IDE0LTI5XG4vLyAtIEludGVybmV0IEV4cGxvcmVyIDExXG4vLyAtIGlQYWQgU2FmYXJpIDYtNy4xXG4vLyAtIGlQaG9uZSBTYWZhcmkgNy03LjFcbi8vIC0gU2FmYXJpIDYtN1xuaWYgKHR5cGVvZiBCcm93c2VyTXV0YXRpb25PYnNlcnZlciA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgcmVxdWVzdEZsdXNoID0gbWFrZVJlcXVlc3RDYWxsRnJvbU11dGF0aW9uT2JzZXJ2ZXIoZmx1c2gpO1xuXG4vLyBNZXNzYWdlQ2hhbm5lbHMgYXJlIGRlc2lyYWJsZSBiZWNhdXNlIHRoZXkgZ2l2ZSBkaXJlY3QgYWNjZXNzIHRvIHRoZSBIVE1MXG4vLyB0YXNrIHF1ZXVlLCBhcmUgaW1wbGVtZW50ZWQgaW4gSW50ZXJuZXQgRXhwbG9yZXIgMTAsIFNhZmFyaSA1LjAtMSwgYW5kIE9wZXJhXG4vLyAxMS0xMiwgYW5kIGluIHdlYiB3b3JrZXJzIGluIG1hbnkgZW5naW5lcy5cbi8vIEFsdGhvdWdoIG1lc3NhZ2UgY2hhbm5lbHMgeWllbGQgdG8gYW55IHF1ZXVlZCByZW5kZXJpbmcgYW5kIElPIHRhc2tzLCB0aGV5XG4vLyB3b3VsZCBiZSBiZXR0ZXIgdGhhbiBpbXBvc2luZyB0aGUgNG1zIGRlbGF5IG9mIHRpbWVycy5cbi8vIEhvd2V2ZXIsIHRoZXkgZG8gbm90IHdvcmsgcmVsaWFibHkgaW4gSW50ZXJuZXQgRXhwbG9yZXIgb3IgU2FmYXJpLlxuXG4vLyBJbnRlcm5ldCBFeHBsb3JlciAxMCBpcyB0aGUgb25seSBicm93c2VyIHRoYXQgaGFzIHNldEltbWVkaWF0ZSBidXQgZG9lc1xuLy8gbm90IGhhdmUgTXV0YXRpb25PYnNlcnZlcnMuXG4vLyBBbHRob3VnaCBzZXRJbW1lZGlhdGUgeWllbGRzIHRvIHRoZSBicm93c2VyJ3MgcmVuZGVyZXIsIGl0IHdvdWxkIGJlXG4vLyBwcmVmZXJyYWJsZSB0byBmYWxsaW5nIGJhY2sgdG8gc2V0VGltZW91dCBzaW5jZSBpdCBkb2VzIG5vdCBoYXZlXG4vLyB0aGUgbWluaW11bSA0bXMgcGVuYWx0eS5cbi8vIFVuZm9ydHVuYXRlbHkgdGhlcmUgYXBwZWFycyB0byBiZSBhIGJ1ZyBpbiBJbnRlcm5ldCBFeHBsb3JlciAxMCBNb2JpbGUgKGFuZFxuLy8gRGVza3RvcCB0byBhIGxlc3NlciBleHRlbnQpIHRoYXQgcmVuZGVycyBib3RoIHNldEltbWVkaWF0ZSBhbmRcbi8vIE1lc3NhZ2VDaGFubmVsIHVzZWxlc3MgZm9yIHRoZSBwdXJwb3NlcyBvZiBBU0FQLlxuLy8gaHR0cHM6Ly9naXRodWIuY29tL2tyaXNrb3dhbC9xL2lzc3Vlcy8zOTZcblxuLy8gVGltZXJzIGFyZSBpbXBsZW1lbnRlZCB1bml2ZXJzYWxseS5cbi8vIFdlIGZhbGwgYmFjayB0byB0aW1lcnMgaW4gd29ya2VycyBpbiBtb3N0IGVuZ2luZXMsIGFuZCBpbiBmb3JlZ3JvdW5kXG4vLyBjb250ZXh0cyBpbiB0aGUgZm9sbG93aW5nIGJyb3dzZXJzLlxuLy8gSG93ZXZlciwgbm90ZSB0aGF0IGV2ZW4gdGhpcyBzaW1wbGUgY2FzZSByZXF1aXJlcyBudWFuY2VzIHRvIG9wZXJhdGUgaW4gYVxuLy8gYnJvYWQgc3BlY3RydW0gb2YgYnJvd3NlcnMuXG4vL1xuLy8gLSBGaXJlZm94IDMtMTNcbi8vIC0gSW50ZXJuZXQgRXhwbG9yZXIgNi05XG4vLyAtIGlQYWQgU2FmYXJpIDQuM1xuLy8gLSBMeW54IDIuOC43XG59IGVsc2Uge1xuICAgIHJlcXVlc3RGbHVzaCA9IG1ha2VSZXF1ZXN0Q2FsbEZyb21UaW1lcihmbHVzaCk7XG59XG5cbi8vIGByZXF1ZXN0Rmx1c2hgIHJlcXVlc3RzIHRoYXQgdGhlIGhpZ2ggcHJpb3JpdHkgZXZlbnQgcXVldWUgYmUgZmx1c2hlZCBhc1xuLy8gc29vbiBhcyBwb3NzaWJsZS5cbi8vIFRoaXMgaXMgdXNlZnVsIHRvIHByZXZlbnQgYW4gZXJyb3IgdGhyb3duIGluIGEgdGFzayBmcm9tIHN0YWxsaW5nIHRoZSBldmVudFxuLy8gcXVldWUgaWYgdGhlIGV4Y2VwdGlvbiBoYW5kbGVkIGJ5IE5vZGUuanPigJlzXG4vLyBgcHJvY2Vzcy5vbihcInVuY2F1Z2h0RXhjZXB0aW9uXCIpYCBvciBieSBhIGRvbWFpbi5cbnJhd0FzYXAucmVxdWVzdEZsdXNoID0gcmVxdWVzdEZsdXNoO1xuXG4vLyBUbyByZXF1ZXN0IGEgaGlnaCBwcmlvcml0eSBldmVudCwgd2UgaW5kdWNlIGEgbXV0YXRpb24gb2JzZXJ2ZXIgYnkgdG9nZ2xpbmdcbi8vIHRoZSB0ZXh0IG9mIGEgdGV4dCBub2RlIGJldHdlZW4gXCIxXCIgYW5kIFwiLTFcIi5cbmZ1bmN0aW9uIG1ha2VSZXF1ZXN0Q2FsbEZyb21NdXRhdGlvbk9ic2VydmVyKGNhbGxiYWNrKSB7XG4gICAgdmFyIHRvZ2dsZSA9IDE7XG4gICAgdmFyIG9ic2VydmVyID0gbmV3IEJyb3dzZXJNdXRhdGlvbk9ic2VydmVyKGNhbGxiYWNrKTtcbiAgICB2YXIgbm9kZSA9IGRvY3VtZW50LmNyZWF0ZVRleHROb2RlKFwiXCIpO1xuICAgIG9ic2VydmVyLm9ic2VydmUobm9kZSwge2NoYXJhY3RlckRhdGE6IHRydWV9KTtcbiAgICByZXR1cm4gZnVuY3Rpb24gcmVxdWVzdENhbGwoKSB7XG4gICAgICAgIHRvZ2dsZSA9IC10b2dnbGU7XG4gICAgICAgIG5vZGUuZGF0YSA9IHRvZ2dsZTtcbiAgICB9O1xufVxuXG4vLyBUaGUgbWVzc2FnZSBjaGFubmVsIHRlY2huaXF1ZSB3YXMgZGlzY292ZXJlZCBieSBNYWx0ZSBVYmwgYW5kIHdhcyB0aGVcbi8vIG9yaWdpbmFsIGZvdW5kYXRpb24gZm9yIHRoaXMgbGlicmFyeS5cbi8vIGh0dHA6Ly93d3cubm9uYmxvY2tpbmcuaW8vMjAxMS8wNi93aW5kb3duZXh0dGljay5odG1sXG5cbi8vIFNhZmFyaSA2LjAuNSAoYXQgbGVhc3QpIGludGVybWl0dGVudGx5IGZhaWxzIHRvIGNyZWF0ZSBtZXNzYWdlIHBvcnRzIG9uIGFcbi8vIHBhZ2UncyBmaXJzdCBsb2FkLiBUaGFua2Z1bGx5LCB0aGlzIHZlcnNpb24gb2YgU2FmYXJpIHN1cHBvcnRzXG4vLyBNdXRhdGlvbk9ic2VydmVycywgc28gd2UgZG9uJ3QgbmVlZCB0byBmYWxsIGJhY2sgaW4gdGhhdCBjYXNlLlxuXG4vLyBmdW5jdGlvbiBtYWtlUmVxdWVzdENhbGxGcm9tTWVzc2FnZUNoYW5uZWwoY2FsbGJhY2spIHtcbi8vICAgICB2YXIgY2hhbm5lbCA9IG5ldyBNZXNzYWdlQ2hhbm5lbCgpO1xuLy8gICAgIGNoYW5uZWwucG9ydDEub25tZXNzYWdlID0gY2FsbGJhY2s7XG4vLyAgICAgcmV0dXJuIGZ1bmN0aW9uIHJlcXVlc3RDYWxsKCkge1xuLy8gICAgICAgICBjaGFubmVsLnBvcnQyLnBvc3RNZXNzYWdlKDApO1xuLy8gICAgIH07XG4vLyB9XG5cbi8vIEZvciByZWFzb25zIGV4cGxhaW5lZCBhYm92ZSwgd2UgYXJlIGFsc28gdW5hYmxlIHRvIHVzZSBgc2V0SW1tZWRpYXRlYFxuLy8gdW5kZXIgYW55IGNpcmN1bXN0YW5jZXMuXG4vLyBFdmVuIGlmIHdlIHdlcmUsIHRoZXJlIGlzIGFub3RoZXIgYnVnIGluIEludGVybmV0IEV4cGxvcmVyIDEwLlxuLy8gSXQgaXMgbm90IHN1ZmZpY2llbnQgdG8gYXNzaWduIGBzZXRJbW1lZGlhdGVgIHRvIGByZXF1ZXN0Rmx1c2hgIGJlY2F1c2Vcbi8vIGBzZXRJbW1lZGlhdGVgIG11c3QgYmUgY2FsbGVkICpieSBuYW1lKiBhbmQgdGhlcmVmb3JlIG11c3QgYmUgd3JhcHBlZCBpbiBhXG4vLyBjbG9zdXJlLlxuLy8gTmV2ZXIgZm9yZ2V0LlxuXG4vLyBmdW5jdGlvbiBtYWtlUmVxdWVzdENhbGxGcm9tU2V0SW1tZWRpYXRlKGNhbGxiYWNrKSB7XG4vLyAgICAgcmV0dXJuIGZ1bmN0aW9uIHJlcXVlc3RDYWxsKCkge1xuLy8gICAgICAgICBzZXRJbW1lZGlhdGUoY2FsbGJhY2spO1xuLy8gICAgIH07XG4vLyB9XG5cbi8vIFNhZmFyaSA2LjAgaGFzIGEgcHJvYmxlbSB3aGVyZSB0aW1lcnMgd2lsbCBnZXQgbG9zdCB3aGlsZSB0aGUgdXNlciBpc1xuLy8gc2Nyb2xsaW5nLiBUaGlzIHByb2JsZW0gZG9lcyBub3QgaW1wYWN0IEFTQVAgYmVjYXVzZSBTYWZhcmkgNi4wIHN1cHBvcnRzXG4vLyBtdXRhdGlvbiBvYnNlcnZlcnMsIHNvIHRoYXQgaW1wbGVtZW50YXRpb24gaXMgdXNlZCBpbnN0ZWFkLlxuLy8gSG93ZXZlciwgaWYgd2UgZXZlciBlbGVjdCB0byB1c2UgdGltZXJzIGluIFNhZmFyaSwgdGhlIHByZXZhbGVudCB3b3JrLWFyb3VuZFxuLy8gaXMgdG8gYWRkIGEgc2Nyb2xsIGV2ZW50IGxpc3RlbmVyIHRoYXQgY2FsbHMgZm9yIGEgZmx1c2guXG5cbi8vIGBzZXRUaW1lb3V0YCBkb2VzIG5vdCBjYWxsIHRoZSBwYXNzZWQgY2FsbGJhY2sgaWYgdGhlIGRlbGF5IGlzIGxlc3MgdGhhblxuLy8gYXBwcm94aW1hdGVseSA3IGluIHdlYiB3b3JrZXJzIGluIEZpcmVmb3ggOCB0aHJvdWdoIDE4LCBhbmQgc29tZXRpbWVzIG5vdFxuLy8gZXZlbiB0aGVuLlxuXG5mdW5jdGlvbiBtYWtlUmVxdWVzdENhbGxGcm9tVGltZXIoY2FsbGJhY2spIHtcbiAgICByZXR1cm4gZnVuY3Rpb24gcmVxdWVzdENhbGwoKSB7XG4gICAgICAgIC8vIFdlIGRpc3BhdGNoIGEgdGltZW91dCB3aXRoIGEgc3BlY2lmaWVkIGRlbGF5IG9mIDAgZm9yIGVuZ2luZXMgdGhhdFxuICAgICAgICAvLyBjYW4gcmVsaWFibHkgYWNjb21tb2RhdGUgdGhhdCByZXF1ZXN0LiBUaGlzIHdpbGwgdXN1YWxseSBiZSBzbmFwcGVkXG4gICAgICAgIC8vIHRvIGEgNCBtaWxpc2Vjb25kIGRlbGF5LCBidXQgb25jZSB3ZSdyZSBmbHVzaGluZywgdGhlcmUncyBubyBkZWxheVxuICAgICAgICAvLyBiZXR3ZWVuIGV2ZW50cy5cbiAgICAgICAgdmFyIHRpbWVvdXRIYW5kbGUgPSBzZXRUaW1lb3V0KGhhbmRsZVRpbWVyLCAwKTtcbiAgICAgICAgLy8gSG93ZXZlciwgc2luY2UgdGhpcyB0aW1lciBnZXRzIGZyZXF1ZW50bHkgZHJvcHBlZCBpbiBGaXJlZm94XG4gICAgICAgIC8vIHdvcmtlcnMsIHdlIGVubGlzdCBhbiBpbnRlcnZhbCBoYW5kbGUgdGhhdCB3aWxsIHRyeSB0byBmaXJlXG4gICAgICAgIC8vIGFuIGV2ZW50IDIwIHRpbWVzIHBlciBzZWNvbmQgdW50aWwgaXQgc3VjY2VlZHMuXG4gICAgICAgIHZhciBpbnRlcnZhbEhhbmRsZSA9IHNldEludGVydmFsKGhhbmRsZVRpbWVyLCA1MCk7XG5cbiAgICAgICAgZnVuY3Rpb24gaGFuZGxlVGltZXIoKSB7XG4gICAgICAgICAgICAvLyBXaGljaGV2ZXIgdGltZXIgc3VjY2VlZHMgd2lsbCBjYW5jZWwgYm90aCB0aW1lcnMgYW5kXG4gICAgICAgICAgICAvLyBleGVjdXRlIHRoZSBjYWxsYmFjay5cbiAgICAgICAgICAgIGNsZWFyVGltZW91dCh0aW1lb3V0SGFuZGxlKTtcbiAgICAgICAgICAgIGNsZWFySW50ZXJ2YWwoaW50ZXJ2YWxIYW5kbGUpO1xuICAgICAgICAgICAgY2FsbGJhY2soKTtcbiAgICAgICAgfVxuICAgIH07XG59XG5cbi8vIFRoaXMgaXMgZm9yIGBhc2FwLmpzYCBvbmx5LlxuLy8gSXRzIG5hbWUgd2lsbCBiZSBwZXJpb2RpY2FsbHkgcmFuZG9taXplZCB0byBicmVhayBhbnkgY29kZSB0aGF0IGRlcGVuZHMgb25cbi8vIGl0cyBleGlzdGVuY2UuXG5yYXdBc2FwLm1ha2VSZXF1ZXN0Q2FsbEZyb21UaW1lciA9IG1ha2VSZXF1ZXN0Q2FsbEZyb21UaW1lcjtcblxuLy8gQVNBUCB3YXMgb3JpZ2luYWxseSBhIG5leHRUaWNrIHNoaW0gaW5jbHVkZWQgaW4gUS4gVGhpcyB3YXMgZmFjdG9yZWQgb3V0XG4vLyBpbnRvIHRoaXMgQVNBUCBwYWNrYWdlLiBJdCB3YXMgbGF0ZXIgYWRhcHRlZCB0byBSU1ZQIHdoaWNoIG1hZGUgZnVydGhlclxuLy8gYW1lbmRtZW50cy4gVGhlc2UgZGVjaXNpb25zLCBwYXJ0aWN1bGFybHkgdG8gbWFyZ2luYWxpemUgTWVzc2FnZUNoYW5uZWwgYW5kXG4vLyB0byBjYXB0dXJlIHRoZSBNdXRhdGlvbk9ic2VydmVyIGltcGxlbWVudGF0aW9uIGluIGEgY2xvc3VyZSwgd2VyZSBpbnRlZ3JhdGVkXG4vLyBiYWNrIGludG8gQVNBUCBwcm9wZXIuXG4vLyBodHRwczovL2dpdGh1Yi5jb20vdGlsZGVpby9yc3ZwLmpzL2Jsb2IvY2RkZjcyMzI1NDZhOWNmODU4NTI0Yjc1Y2RlNmY5ZWRmNzI2MjBhNy9saWIvcnN2cC9hc2FwLmpzXG4iLCIndXNlIHN0cmljdCc7XG5cbnZhciBjdXJyeU4gPSByZXF1aXJlKCdyYW1kYS9zcmMvY3VycnlOJyk7XG5cbi8vIFV0aWxpdHlcbmZ1bmN0aW9uIGlzRnVuY3Rpb24ob2JqKSB7XG4gIHJldHVybiAhIShvYmogJiYgb2JqLmNvbnN0cnVjdG9yICYmIG9iai5jYWxsICYmIG9iai5hcHBseSk7XG59XG5mdW5jdGlvbiB0cnVlRm4oKSB7IHJldHVybiB0cnVlOyB9XG5cbi8vIEdsb2JhbHNcbnZhciB0b1VwZGF0ZSA9IFtdO1xudmFyIGluU3RyZWFtO1xudmFyIG9yZGVyID0gW107XG52YXIgb3JkZXJOZXh0SWR4ID0gLTE7XG52YXIgZmx1c2hpbmcgPSBmYWxzZTtcblxuLyoqIEBuYW1lc3BhY2UgKi9cbnZhciBmbHlkID0ge31cblxuLy8gLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vIEFQSSAvLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8gLy9cblxuLyoqXG4gKiBDcmVhdGVzIGEgbmV3IHN0cmVhbVxuICpcbiAqIF9fU2lnbmF0dXJlX186IGBhIC0+IFN0cmVhbSBhYFxuICpcbiAqIEBuYW1lIGZseWQuc3RyZWFtXG4gKiBAcGFyYW0geyp9IGluaXRpYWxWYWx1ZSAtIChPcHRpb25hbCkgdGhlIGluaXRpYWwgdmFsdWUgb2YgdGhlIHN0cmVhbVxuICogQHJldHVybiB7c3RyZWFtfSB0aGUgc3RyZWFtXG4gKlxuICogQGV4YW1wbGVcbiAqIHZhciBuID0gZmx5ZC5zdHJlYW0oMSk7IC8vIFN0cmVhbSB3aXRoIGluaXRpYWwgdmFsdWUgYDFgXG4gKiB2YXIgcyA9IGZseWQuc3RyZWFtKCk7IC8vIFN0cmVhbSB3aXRoIG5vIGluaXRpYWwgdmFsdWVcbiAqL1xuZmx5ZC5zdHJlYW0gPSBmdW5jdGlvbihpbml0aWFsVmFsdWUpIHtcbiAgdmFyIGVuZFN0cmVhbSA9IGNyZWF0ZURlcGVuZGVudFN0cmVhbShbXSwgdHJ1ZUZuKTtcbiAgdmFyIHMgPSBjcmVhdGVTdHJlYW0oKTtcbiAgcy5lbmQgPSBlbmRTdHJlYW07XG4gIHMuZm5BcmdzID0gW107XG4gIGVuZFN0cmVhbS5saXN0ZW5lcnMucHVzaChzKTtcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPiAwKSBzKGluaXRpYWxWYWx1ZSk7XG4gIHJldHVybiBzO1xufVxuXG4vKipcbiAqIENyZWF0ZSBhIG5ldyBkZXBlbmRlbnQgc3RyZWFtXG4gKlxuICogX19TaWduYXR1cmVfXzogYCguLi5TdHJlYW0gKiAtPiBTdHJlYW0gYiAtPiBiKSAtPiBbU3RyZWFtICpdIC0+IFN0cmVhbSBiYFxuICpcbiAqIEBuYW1lIGZseWQuY29tYmluZVxuICogQHBhcmFtIHtGdW5jdGlvbn0gZm4gLSB0aGUgZnVuY3Rpb24gdXNlZCB0byBjb21iaW5lIHRoZSBzdHJlYW1zXG4gKiBAcGFyYW0ge0FycmF5PHN0cmVhbT59IGRlcGVuZGVuY2llcyAtIHRoZSBzdHJlYW1zIHRoYXQgdGhpcyBvbmUgZGVwZW5kcyBvblxuICogQHJldHVybiB7c3RyZWFtfSB0aGUgZGVwZW5kZW50IHN0cmVhbVxuICpcbiAqIEBleGFtcGxlXG4gKiB2YXIgbjEgPSBmbHlkLnN0cmVhbSgwKTtcbiAqIHZhciBuMiA9IGZseWQuc3RyZWFtKDApO1xuICogdmFyIG1heCA9IGZseWQuY29tYmluZShmdW5jdGlvbihuMSwgbjIsIHNlbGYsIGNoYW5nZWQpIHtcbiAqICAgcmV0dXJuIG4xKCkgPiBuMigpID8gbjEoKSA6IG4yKCk7XG4gKiB9LCBbbjEsIG4yXSk7XG4gKi9cbmZseWQuY29tYmluZSA9IGN1cnJ5TigyLCBjb21iaW5lKTtcbmZ1bmN0aW9uIGNvbWJpbmUoZm4sIHN0cmVhbXMpIHtcbiAgdmFyIGksIHMsIGRlcHMsIGRlcEVuZFN0cmVhbXM7XG4gIHZhciBlbmRTdHJlYW0gPSBjcmVhdGVEZXBlbmRlbnRTdHJlYW0oW10sIHRydWVGbik7XG4gIGRlcHMgPSBbXTsgZGVwRW5kU3RyZWFtcyA9IFtdO1xuICBmb3IgKGkgPSAwOyBpIDwgc3RyZWFtcy5sZW5ndGg7ICsraSkge1xuICAgIGlmIChzdHJlYW1zW2ldICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGRlcHMucHVzaChzdHJlYW1zW2ldKTtcbiAgICAgIGlmIChzdHJlYW1zW2ldLmVuZCAhPT0gdW5kZWZpbmVkKSBkZXBFbmRTdHJlYW1zLnB1c2goc3RyZWFtc1tpXS5lbmQpO1xuICAgIH1cbiAgfVxuICBzID0gY3JlYXRlRGVwZW5kZW50U3RyZWFtKGRlcHMsIGZuKTtcbiAgcy5kZXBzQ2hhbmdlZCA9IFtdO1xuICBzLmZuQXJncyA9IHMuZGVwcy5jb25jYXQoW3MsIHMuZGVwc0NoYW5nZWRdKTtcbiAgcy5lbmQgPSBlbmRTdHJlYW07XG4gIGVuZFN0cmVhbS5saXN0ZW5lcnMucHVzaChzKTtcbiAgYWRkTGlzdGVuZXJzKGRlcEVuZFN0cmVhbXMsIGVuZFN0cmVhbSk7XG4gIGVuZFN0cmVhbS5kZXBzID0gZGVwRW5kU3RyZWFtcztcbiAgdXBkYXRlU3RyZWFtKHMpO1xuICByZXR1cm4gcztcbn1cblxuLyoqXG4gKiBSZXR1cm5zIGB0cnVlYCBpZiB0aGUgc3VwcGxpZWQgYXJndW1lbnQgaXMgYSBGbHlkIHN0cmVhbSBhbmQgYGZhbHNlYCBvdGhlcndpc2UuXG4gKlxuICogX19TaWduYXR1cmVfXzogYCogLT4gQm9vbGVhbmBcbiAqXG4gKiBAbmFtZSBmbHlkLmlzU3RyZWFtXG4gKiBAcGFyYW0geyp9IHZhbHVlIC0gdGhlIHZhbHVlIHRvIHRlc3RcbiAqIEByZXR1cm4ge0Jvb2xlYW59IGB0cnVlYCBpZiBpcyBhIEZseWQgc3RyZWFtbiwgYGZhbHNlYCBvdGhlcndpc2VcbiAqXG4gKiBAZXhhbXBsZVxuICogdmFyIHMgPSBmbHlkLnN0cmVhbSgxKTtcbiAqIHZhciBuID0gMTtcbiAqIGZseWQuaXNTdHJlYW0ocyk7IC8vPT4gdHJ1ZVxuICogZmx5ZC5pc1N0cmVhbShuKTsgLy89PiBmYWxzZVxuICovXG5mbHlkLmlzU3RyZWFtID0gZnVuY3Rpb24oc3RyZWFtKSB7XG4gIHJldHVybiBpc0Z1bmN0aW9uKHN0cmVhbSkgJiYgJ2hhc1ZhbCcgaW4gc3RyZWFtO1xufVxuXG4vKipcbiAqIEludm9rZXMgdGhlIGJvZHkgKHRoZSBmdW5jdGlvbiB0byBjYWxjdWxhdGUgdGhlIHZhbHVlKSBvZiBhIGRlcGVuZGVudCBzdHJlYW1cbiAqXG4gKiBCeSBkZWZhdWx0IHRoZSBib2R5IG9mIGEgZGVwZW5kZW50IHN0cmVhbSBpcyBvbmx5IGNhbGxlZCB3aGVuIGFsbCB0aGUgc3RyZWFtc1xuICogdXBvbiB3aGljaCBpdCBkZXBlbmRzIGhhcyBhIHZhbHVlLiBgaW1tZWRpYXRlYCBjYW4gY2lyY3VtdmVudCB0aGlzIGJlaGF2aW91ci5cbiAqIEl0IGltbWVkaWF0ZWx5IGludm9rZXMgdGhlIGJvZHkgb2YgYSBkZXBlbmRlbnQgc3RyZWFtLlxuICpcbiAqIF9fU2lnbmF0dXJlX186IGBTdHJlYW0gYSAtPiBTdHJlYW0gYWBcbiAqXG4gKiBAbmFtZSBmbHlkLmltbWVkaWF0ZVxuICogQHBhcmFtIHtzdHJlYW19IHN0cmVhbSAtIHRoZSBkZXBlbmRlbnQgc3RyZWFtXG4gKiBAcmV0dXJuIHtzdHJlYW19IHRoZSBzYW1lIHN0cmVhbVxuICpcbiAqIEBleGFtcGxlXG4gKiB2YXIgcyA9IGZseWQuc3RyZWFtKCk7XG4gKiB2YXIgaGFzSXRlbXMgPSBmbHlkLmltbWVkaWF0ZShmbHlkLmNvbWJpbmUoZnVuY3Rpb24ocykge1xuICogICByZXR1cm4gcygpICE9PSB1bmRlZmluZWQgJiYgcygpLmxlbmd0aCA+IDA7XG4gKiB9LCBbc10pO1xuICogY29uc29sZS5sb2coaGFzSXRlbXMoKSk7IC8vIGxvZ3MgYGZhbHNlYC4gSGFkIGBpbW1lZGlhdGVgIG5vdCBiZWVuXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gdXNlZCBgaGFzSXRlbXMoKWAgd291bGQndmUgcmV0dXJuZWQgYHVuZGVmaW5lZGBcbiAqIHMoWzFdKTtcbiAqIGNvbnNvbGUubG9nKGhhc0l0ZW1zKCkpOyAvLyBsb2dzIGB0cnVlYC5cbiAqIHMoW10pO1xuICogY29uc29sZS5sb2coaGFzSXRlbXMoKSk7IC8vIGxvZ3MgYGZhbHNlYC5cbiAqL1xuZmx5ZC5pbW1lZGlhdGUgPSBmdW5jdGlvbihzKSB7XG4gIGlmIChzLmRlcHNNZXQgPT09IGZhbHNlKSB7XG4gICAgcy5kZXBzTWV0ID0gdHJ1ZTtcbiAgICB1cGRhdGVTdHJlYW0ocyk7XG4gIH1cbiAgcmV0dXJuIHM7XG59XG5cbi8qKlxuICogQ2hhbmdlcyB3aGljaCBgZW5kc1N0cmVhbWAgc2hvdWxkIHRyaWdnZXIgdGhlIGVuZGluZyBvZiBgc2AuXG4gKlxuICogX19TaWduYXR1cmVfXzogYFN0cmVhbSBhIC0+IFN0cmVhbSBiIC0+IFN0cmVhbSBiYFxuICpcbiAqIEBuYW1lIGZseWQuZW5kc09uXG4gKiBAcGFyYW0ge3N0cmVhbX0gZW5kU3RyZWFtIC0gdGhlIHN0cmVhbSB0byB0cmlnZ2VyIHRoZSBlbmRpbmdcbiAqIEBwYXJhbSB7c3RyZWFtfSBzdHJlYW0gLSB0aGUgc3RyZWFtIHRvIGJlIGVuZGVkIGJ5IHRoZSBlbmRTdHJlYW1cbiAqIEBwYXJhbSB7c3RyZWFtfSB0aGUgc3RyZWFtIG1vZGlmaWVkIHRvIGJlIGVuZGVkIGJ5IGVuZFN0cmVhbVxuICpcbiAqIEBleGFtcGxlXG4gKiB2YXIgbiA9IGZseWQuc3RyZWFtKDEpO1xuICogdmFyIGtpbGxlciA9IGZseWQuc3RyZWFtKCk7XG4gKiAvLyBgZG91YmxlYCBlbmRzIHdoZW4gYG5gIGVuZHMgb3Igd2hlbiBga2lsbGVyYCBlbWl0cyBhbnkgdmFsdWVcbiAqIHZhciBkb3VibGUgPSBmbHlkLmVuZHNPbihmbHlkLm1lcmdlKG4uZW5kLCBraWxsZXIpLCBmbHlkLmNvbWJpbmUoZnVuY3Rpb24obikge1xuICogICByZXR1cm4gMiAqIG4oKTtcbiAqIH0sIFtuXSk7XG4qL1xuZmx5ZC5lbmRzT24gPSBmdW5jdGlvbihlbmRTLCBzKSB7XG4gIGRldGFjaERlcHMocy5lbmQpO1xuICBlbmRTLmxpc3RlbmVycy5wdXNoKHMuZW5kKTtcbiAgcy5lbmQuZGVwcy5wdXNoKGVuZFMpO1xuICByZXR1cm4gcztcbn1cblxuLyoqXG4gKiBNYXAgYSBzdHJlYW1cbiAqXG4gKiBSZXR1cm5zIGEgbmV3IHN0cmVhbSBjb25zaXN0aW5nIG9mIGV2ZXJ5IHZhbHVlIGZyb20gYHNgIHBhc3NlZCB0aHJvdWdoXG4gKiBgZm5gLiBJLmUuIGBtYXBgIGNyZWF0ZXMgYSBuZXcgc3RyZWFtIHRoYXQgbGlzdGVucyB0byBgc2AgYW5kXG4gKiBhcHBsaWVzIGBmbmAgdG8gZXZlcnkgbmV3IHZhbHVlLlxuICogX19TaWduYXR1cmVfXzogYChhIC0+IHJlc3VsdCkgLT4gU3RyZWFtIGEgLT4gU3RyZWFtIHJlc3VsdGBcbiAqXG4gKiBAbmFtZSBmbHlkLm1hcFxuICogQHBhcmFtIHtGdW5jdGlvbn0gZm4gLSB0aGUgZnVuY3Rpb24gdGhhdCBwcm9kdWNlcyB0aGUgZWxlbWVudHMgb2YgdGhlIG5ldyBzdHJlYW1cbiAqIEBwYXJhbSB7c3RyZWFtfSBzdHJlYW0gLSB0aGUgc3RyZWFtIHRvIG1hcFxuICogQHJldHVybiB7c3RyZWFtfSBhIG5ldyBzdHJlYW0gd2l0aCB0aGUgbWFwcGVkIHZhbHVlc1xuICpcbiAqIEBleGFtcGxlXG4gKiB2YXIgbnVtYmVycyA9IGZseWQuc3RyZWFtKDApO1xuICogdmFyIHNxdWFyZWROdW1iZXJzID0gZmx5ZC5tYXAoZnVuY3Rpb24obikgeyByZXR1cm4gbipuOyB9LCBudW1iZXJzKTtcbiAqL1xuLy8gTGlicmFyeSBmdW5jdGlvbnMgdXNlIHNlbGYgY2FsbGJhY2sgdG8gYWNjZXB0IChudWxsLCB1bmRlZmluZWQpIHVwZGF0ZSB0cmlnZ2Vycy5cbmZseWQubWFwID0gY3VycnlOKDIsIGZ1bmN0aW9uKGYsIHMpIHtcbiAgcmV0dXJuIGNvbWJpbmUoZnVuY3Rpb24ocywgc2VsZikgeyBzZWxmKGYocy52YWwpKTsgfSwgW3NdKTtcbn0pXG5cbi8qKlxuICogTGlzdGVuIHRvIHN0cmVhbSBldmVudHNcbiAqXG4gKiBTaW1pbGFyIHRvIGBtYXBgIGV4Y2VwdCB0aGF0IHRoZSByZXR1cm5lZCBzdHJlYW0gaXMgZW1wdHkuIFVzZSBgb25gIGZvciBkb2luZ1xuICogc2lkZSBlZmZlY3RzIGluIHJlYWN0aW9uIHRvIHN0cmVhbSBjaGFuZ2VzLiBVc2UgdGhlIHJldHVybmVkIHN0cmVhbSBvbmx5IGlmIHlvdVxuICogbmVlZCB0byBtYW51YWxseSBlbmQgaXQuXG4gKlxuICogX19TaWduYXR1cmVfXzogYChhIC0+IHJlc3VsdCkgLT4gU3RyZWFtIGEgLT4gU3RyZWFtIHVuZGVmaW5lZGBcbiAqXG4gKiBAbmFtZSBmbHlkLm9uXG4gKiBAcGFyYW0ge0Z1bmN0aW9ufSBjYiAtIHRoZSBjYWxsYmFja1xuICogQHBhcmFtIHtzdHJlYW19IHN0cmVhbSAtIHRoZSBzdHJlYW1cbiAqIEByZXR1cm4ge3N0cmVhbX0gYW4gZW1wdHkgc3RyZWFtIChjYW4gYmUgZW5kZWQpXG4gKi9cbmZseWQub24gPSBjdXJyeU4oMiwgZnVuY3Rpb24oZiwgcykge1xuICByZXR1cm4gY29tYmluZShmdW5jdGlvbihzKSB7IGYocy52YWwpOyB9LCBbc10pO1xufSlcblxuLyoqXG4gKiBDcmVhdGVzIGEgbmV3IHN0cmVhbSB3aXRoIHRoZSByZXN1bHRzIG9mIGNhbGxpbmcgdGhlIGZ1bmN0aW9uIG9uIGV2ZXJ5IGluY29taW5nXG4gKiBzdHJlYW0gd2l0aCBhbmQgYWNjdW11bGF0b3IgYW5kIHRoZSBpbmNvbWluZyB2YWx1ZS5cbiAqXG4gKiBfX1NpZ25hdHVyZV9fOiBgKGEgLT4gYiAtPiBhKSAtPiBhIC0+IFN0cmVhbSBiIC0+IFN0cmVhbSBhYFxuICpcbiAqIEBuYW1lIGZseWQuc2NhblxuICogQHBhcmFtIHtGdW5jdGlvbn0gZm4gLSB0aGUgZnVuY3Rpb24gdG8gY2FsbFxuICogQHBhcmFtIHsqfSB2YWwgLSB0aGUgaW5pdGlhbCB2YWx1ZSBvZiB0aGUgYWNjdW11bGF0b3JcbiAqIEBwYXJhbSB7c3RyZWFtfSBzdHJlYW0gLSB0aGUgc3RyZWFtIHNvdXJjZVxuICogQHJldHVybiB7c3RyZWFtfSB0aGUgbmV3IHN0cmVhbVxuICpcbiAqIEBleGFtcGxlXG4gKiB2YXIgbnVtYmVycyA9IGZseWQuc3RyZWFtKCk7XG4gKiB2YXIgc3VtID0gZmx5ZC5zY2FuKGZ1bmN0aW9uKHN1bSwgbikgeyByZXR1cm4gc3VtK247IH0sIDAsIG51bWJlcnMpO1xuICogbnVtYmVycygyKSgzKSg1KTtcbiAqIHN1bSgpOyAvLyAxMFxuICovXG5mbHlkLnNjYW4gPSBjdXJyeU4oMywgZnVuY3Rpb24oZiwgYWNjLCBzKSB7XG4gIHZhciBucyA9IGNvbWJpbmUoZnVuY3Rpb24ocywgc2VsZikge1xuICAgIHNlbGYoYWNjID0gZihhY2MsIHMudmFsKSk7XG4gIH0sIFtzXSk7XG4gIGlmICghbnMuaGFzVmFsKSBucyhhY2MpO1xuICByZXR1cm4gbnM7XG59KTtcblxuLyoqXG4gKiBDcmVhdGVzIGEgbmV3IHN0cmVhbSBkb3duIHdoaWNoIGFsbCB2YWx1ZXMgZnJvbSBib3RoIGBzdHJlYW0xYCBhbmQgYHN0cmVhbTJgXG4gKiB3aWxsIGJlIHNlbnQuXG4gKlxuICogX19TaWduYXR1cmVfXzogYFN0cmVhbSBhIC0+IFN0cmVhbSBhIC0+IFN0cmVhbSBhYFxuICpcbiAqIEBuYW1lIGZseWQubWVyZ2VcbiAqIEBwYXJhbSB7c3RyZWFtfSBzb3VyY2UxIC0gb25lIHN0cmVhbSB0byBiZSBtZXJnZWRcbiAqIEBwYXJhbSB7c3RyZWFtfSBzb3VyY2UyIC0gdGhlIG90aGVyIHN0cmVhbSB0byBiZSBtZXJnZWRcbiAqIEByZXR1cm4ge3N0cmVhbX0gYSBzdHJlYW0gd2l0aCB0aGUgdmFsdWVzIGZyb20gYm90aCBzb3VyY2VzXG4gKlxuICogQGV4YW1wbGVcbiAqIHZhciBidG4xQ2xpY2tzID0gZmx5ZC5zdHJlYW0oKTtcbiAqIGJ1dHRvbjFFbG0uYWRkRXZlbnRMaXN0ZW5lcihidG4xQ2xpY2tzKTtcbiAqIHZhciBidG4yQ2xpY2tzID0gZmx5ZC5zdHJlYW0oKTtcbiAqIGJ1dHRvbjJFbG0uYWRkRXZlbnRMaXN0ZW5lcihidG4yQ2xpY2tzKTtcbiAqIHZhciBhbGxDbGlja3MgPSBmbHlkLm1lcmdlKGJ0bjFDbGlja3MsIGJ0bjJDbGlja3MpO1xuICovXG5mbHlkLm1lcmdlID0gY3VycnlOKDIsIGZ1bmN0aW9uKHMxLCBzMikge1xuICB2YXIgcyA9IGZseWQuaW1tZWRpYXRlKGNvbWJpbmUoZnVuY3Rpb24oczEsIHMyLCBzZWxmLCBjaGFuZ2VkKSB7XG4gICAgaWYgKGNoYW5nZWRbMF0pIHtcbiAgICAgIHNlbGYoY2hhbmdlZFswXSgpKTtcbiAgICB9IGVsc2UgaWYgKHMxLmhhc1ZhbCkge1xuICAgICAgc2VsZihzMS52YWwpO1xuICAgIH0gZWxzZSBpZiAoczIuaGFzVmFsKSB7XG4gICAgICBzZWxmKHMyLnZhbCk7XG4gICAgfVxuICB9LCBbczEsIHMyXSkpO1xuICBmbHlkLmVuZHNPbihjb21iaW5lKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiB0cnVlO1xuICB9LCBbczEuZW5kLCBzMi5lbmRdKSwgcyk7XG4gIHJldHVybiBzO1xufSk7XG5cbi8qKlxuICogQ3JlYXRlcyBhIG5ldyBzdHJlYW0gcmVzdWx0aW5nIGZyb20gYXBwbHlpbmcgYHRyYW5zZHVjZXJgIHRvIGBzdHJlYW1gLlxuICpcbiAqIF9fU2lnbmF0dXJlX186IGBUcmFuc2R1Y2VyIC0+IFN0cmVhbSBhIC0+IFN0cmVhbSBiYFxuICpcbiAqIEBuYW1lIGZseWQudHJhbnNkdWNlXG4gKiBAcGFyYW0ge1RyYW5zZHVjZXJ9IHhmb3JtIC0gdGhlIHRyYW5zZHVjZXIgdHJhbnNmb3JtYXRpb25cbiAqIEBwYXJhbSB7c3RyZWFtfSBzb3VyY2UgLSB0aGUgc3RyZWFtIHNvdXJjZVxuICogQHJldHVybiB7c3RyZWFtfSB0aGUgbmV3IHN0cmVhbVxuICpcbiAqIEBleGFtcGxlXG4gKiB2YXIgdCA9IHJlcXVpcmUoJ3RyYW5zZHVjZXJzLmpzJyk7XG4gKlxuICogdmFyIHJlc3VsdHMgPSBbXTtcbiAqIHZhciBzMSA9IGZseWQuc3RyZWFtKCk7XG4gKiB2YXIgdHggPSB0LmNvbXBvc2UodC5tYXAoZnVuY3Rpb24oeCkgeyByZXR1cm4geCAqIDI7IH0pLCB0LmRlZHVwZSgpKTtcbiAqIHZhciBzMiA9IGZseWQudHJhbnNkdWNlKHR4LCBzMSk7XG4gKiBmbHlkLmNvbWJpbmUoZnVuY3Rpb24oczIpIHsgcmVzdWx0cy5wdXNoKHMyKCkpOyB9LCBbczJdKTtcbiAqIHMxKDEpKDEpKDIpKDMpKDMpKDMpKDQpO1xuICogcmVzdWx0czsgLy8gPT4gWzIsIDQsIDYsIDhdXG4gKi9cbmZseWQudHJhbnNkdWNlID0gY3VycnlOKDIsIGZ1bmN0aW9uKHhmb3JtLCBzb3VyY2UpIHtcbiAgeGZvcm0gPSB4Zm9ybShuZXcgU3RyZWFtVHJhbnNmb3JtZXIoKSk7XG4gIHJldHVybiBjb21iaW5lKGZ1bmN0aW9uKHNvdXJjZSwgc2VsZikge1xuICAgIHZhciByZXMgPSB4Zm9ybVsnQEB0cmFuc2R1Y2VyL3N0ZXAnXSh1bmRlZmluZWQsIHNvdXJjZS52YWwpO1xuICAgIGlmIChyZXMgJiYgcmVzWydAQHRyYW5zZHVjZXIvcmVkdWNlZCddID09PSB0cnVlKSB7XG4gICAgICBzZWxmLmVuZCh0cnVlKTtcbiAgICAgIHJldHVybiByZXNbJ0BAdHJhbnNkdWNlci92YWx1ZSddO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXR1cm4gcmVzO1xuICAgIH1cbiAgfSwgW3NvdXJjZV0pO1xufSk7XG5cbi8qKlxuICogUmV0dXJucyBgZm5gIGN1cnJpZWQgdG8gYG5gLiBVc2UgdGhpcyBmdW5jdGlvbiB0byBjdXJyeSBmdW5jdGlvbnMgZXhwb3NlZCBieVxuICogbW9kdWxlcyBmb3IgRmx5ZC5cbiAqXG4gKiBAbmFtZSBmbHlkLmN1cnJ5TlxuICogQGZ1bmN0aW9uXG4gKiBAcGFyYW0ge0ludGVnZXJ9IGFyaXR5IC0gdGhlIGZ1bmN0aW9uIGFyaXR5XG4gKiBAcGFyYW0ge0Z1bmN0aW9ufSBmbiAtIHRoZSBmdW5jdGlvbiB0byBjdXJyeVxuICogQHJldHVybiB7RnVuY3Rpb259IHRoZSBjdXJyaWVkIGZ1bmN0aW9uXG4gKlxuICogQGV4YW1wbGVcbiAqIGZ1bmN0aW9uIGFkZCh4LCB5KSB7IHJldHVybiB4ICsgeTsgfTtcbiAqIHZhciBhID0gZmx5ZC5jdXJyeU4oMiwgYWRkKTtcbiAqIGEoMikoNCkgLy8gPT4gNlxuICovXG5mbHlkLmN1cnJ5TiA9IGN1cnJ5TlxuXG4vKipcbiAqIFJldHVybnMgYSBuZXcgc3RyZWFtIGlkZW50aWNhbCB0byB0aGUgb3JpZ2luYWwgZXhjZXB0IGV2ZXJ5XG4gKiB2YWx1ZSB3aWxsIGJlIHBhc3NlZCB0aHJvdWdoIGBmYC5cbiAqXG4gKiBfTm90ZTpfIFRoaXMgZnVuY3Rpb24gaXMgaW5jbHVkZWQgaW4gb3JkZXIgdG8gc3VwcG9ydCB0aGUgZmFudGFzeSBsYW5kXG4gKiBzcGVjaWZpY2F0aW9uLlxuICpcbiAqIF9fU2lnbmF0dXJlX186IENhbGxlZCBib3VuZCB0byBgU3RyZWFtIGFgOiBgKGEgLT4gYikgLT4gU3RyZWFtIGJgXG4gKlxuICogQG5hbWUgc3RyZWFtLm1hcFxuICogQHBhcmFtIHtGdW5jdGlvbn0gZnVuY3Rpb24gLSB0aGUgZnVuY3Rpb24gdG8gYXBwbHlcbiAqIEByZXR1cm4ge3N0cmVhbX0gYSBuZXcgc3RyZWFtIHdpdGggdGhlIHZhbHVlcyBtYXBwZWRcbiAqXG4gKiBAZXhhbXBsZVxuICogdmFyIG51bWJlcnMgPSBmbHlkLnN0cmVhbSgwKTtcbiAqIHZhciBzcXVhcmVkTnVtYmVycyA9IG51bWJlcnMubWFwKGZ1bmN0aW9uKG4pIHsgcmV0dXJuIG4qbjsgfSk7XG4gKi9cbmZ1bmN0aW9uIGJvdW5kTWFwKGYpIHsgcmV0dXJuIGZseWQubWFwKGYsIHRoaXMpOyB9XG5cbi8qKlxuICogUmV0dXJucyBhIG5ldyBzdHJlYW0gd2hpY2ggaXMgdGhlIHJlc3VsdCBvZiBhcHBseWluZyB0aGVcbiAqIGZ1bmN0aW9ucyBmcm9tIGB0aGlzYCBzdHJlYW0gdG8gdGhlIHZhbHVlcyBpbiBgc3RyZWFtYCBwYXJhbWV0ZXIuXG4gKlxuICogYHRoaXNgIHN0cmVhbSBtdXN0IGJlIGEgc3RyZWFtIG9mIGZ1bmN0aW9ucy5cbiAqXG4gKiBfTm90ZTpfIFRoaXMgZnVuY3Rpb24gaXMgaW5jbHVkZWQgaW4gb3JkZXIgdG8gc3VwcG9ydCB0aGUgZmFudGFzeSBsYW5kXG4gKiBzcGVjaWZpY2F0aW9uLlxuICpcbiAqIF9fU2lnbmF0dXJlX186IENhbGxlZCBib3VuZCB0byBgU3RyZWFtIChhIC0+IGIpYDogYGEgLT4gU3RyZWFtIGJgXG4gKlxuICogQG5hbWUgc3RyZWFtLmFwXG4gKiBAcGFyYW0ge3N0cmVhbX0gc3RyZWFtIC0gdGhlIHZhbHVlcyBzdHJlYW1cbiAqIEByZXR1cm4ge3N0cmVhbX0gYSBuZXcgc3RyYW0gd2l0aCB0aGUgZnVuY3Rpb25zIGFwcGxpZWQgdG8gdmFsdWVzXG4gKlxuICogQGV4YW1wbGVcbiAqIHZhciBhZGQgPSBmbHlkLmN1cnJ5TigyLCBmdW5jdGlvbih4LCB5KSB7IHJldHVybiB4ICsgeTsgfSk7XG4gKiB2YXIgbnVtYmVyczEgPSBmbHlkLnN0cmVhbSgpO1xuICogdmFyIG51bWJlcnMyID0gZmx5ZC5zdHJlYW0oKTtcbiAqIHZhciBhZGRUb051bWJlcnMxID0gZmx5ZC5tYXAoYWRkLCBudW1iZXJzMSk7XG4gKiB2YXIgYWRkZWQgPSBhZGRUb051bWJlcnMxLmFwKG51bWJlcnMyKTtcbiAqL1xuZnVuY3Rpb24gYXAoczIpIHtcbiAgdmFyIHMxID0gdGhpcztcbiAgcmV0dXJuIGNvbWJpbmUoZnVuY3Rpb24oczEsIHMyLCBzZWxmKSB7IHNlbGYoczEudmFsKHMyLnZhbCkpOyB9LCBbczEsIHMyXSk7XG59XG5cbi8qKlxuICogR2V0IGEgaHVtYW4gcmVhZGFibGUgdmlldyBvZiBhIHN0cmVhbVxuICogQG5hbWUgc3RyZWFtLnRvU3RyaW5nXG4gKiBAcmV0dXJuIHtTdHJpbmd9IHRoZSBzdHJlYW0gc3RyaW5nIHJlcHJlc2VudGF0aW9uXG4gKi9cbmZ1bmN0aW9uIHN0cmVhbVRvU3RyaW5nKCkge1xuICByZXR1cm4gJ3N0cmVhbSgnICsgdGhpcy52YWwgKyAnKSc7XG59XG5cbi8qKlxuICogQG5hbWUgc3RyZWFtLmVuZFxuICogQG1lbWJlcm9mIHN0cmVhbVxuICogQSBzdHJlYW0gdGhhdCBlbWl0cyBgdHJ1ZWAgd2hlbiB0aGUgc3RyZWFtIGVuZHMuIElmIGB0cnVlYCBpcyBwdXNoZWQgZG93biB0aGVcbiAqIHN0cmVhbSB0aGUgcGFyZW50IHN0cmVhbSBlbmRzLlxuICovXG5cbi8qKlxuICogQG5hbWUgc3RyZWFtLm9mXG4gKiBAZnVuY3Rpb25cbiAqIEBtZW1iZXJvZiBzdHJlYW1cbiAqIFJldHVybnMgYSBuZXcgc3RyZWFtIHdpdGggYHZhbHVlYCBhcyBpdHMgaW5pdGlhbCB2YWx1ZS4gSXQgaXMgaWRlbnRpY2FsIHRvXG4gKiBjYWxsaW5nIGBmbHlkLnN0cmVhbWAgd2l0aCBvbmUgYXJndW1lbnQuXG4gKlxuICogX19TaWduYXR1cmVfXzogQ2FsbGVkIGJvdW5kIHRvIGBTdHJlYW0gKGEpYDogYGIgLT4gU3RyZWFtIGJgXG4gKlxuICogQHBhcmFtIHsqfSB2YWx1ZSAtIHRoZSBpbml0aWFsIHZhbHVlXG4gKiBAcmV0dXJuIHtzdHJlYW19IHRoZSBuZXcgc3RyZWFtXG4gKlxuICogQGV4YW1wbGVcbiAqIHZhciBuID0gZmx5ZC5zdHJlYW0oMSk7XG4gKiB2YXIgbSA9IG4ub2YoMSk7XG4gKi9cblxuLy8gLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vIFBSSVZBVEUgLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vIC8vXG4vKipcbiAqIEBwcml2YXRlXG4gKiBDcmVhdGUgYSBzdHJlYW0gd2l0aCBubyBkZXBlbmRlbmNpZXMgYW5kIG5vIHZhbHVlXG4gKiBAcmV0dXJuIHtGdW5jdGlvbn0gYSBmbHlkIHN0cmVhbVxuICovXG5mdW5jdGlvbiBjcmVhdGVTdHJlYW0oKSB7XG4gIGZ1bmN0aW9uIHMobikge1xuICAgIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAwKSByZXR1cm4gcy52YWxcbiAgICB1cGRhdGVTdHJlYW1WYWx1ZShzLCBuKVxuICAgIHJldHVybiBzXG4gIH1cbiAgcy5oYXNWYWwgPSBmYWxzZTtcbiAgcy52YWwgPSB1bmRlZmluZWQ7XG4gIHMudmFscyA9IFtdO1xuICBzLmxpc3RlbmVycyA9IFtdO1xuICBzLnF1ZXVlZCA9IGZhbHNlO1xuICBzLmVuZCA9IHVuZGVmaW5lZDtcbiAgcy5tYXAgPSBib3VuZE1hcDtcbiAgcy5hcCA9IGFwO1xuICBzLm9mID0gZmx5ZC5zdHJlYW07XG4gIHMudG9TdHJpbmcgPSBzdHJlYW1Ub1N0cmluZztcbiAgcmV0dXJuIHM7XG59XG5cbi8qKlxuICogQHByaXZhdGVcbiAqIENyZWF0ZSBhIGRlcGVuZGVudCBzdHJlYW1cbiAqIEBwYXJhbSB7QXJyYXk8c3RyZWFtPn0gZGVwZW5kZW5jaWVzIC0gYW4gYXJyYXkgb2YgdGhlIHN0cmVhbXNcbiAqIEBwYXJhbSB7RnVuY3Rpb259IGZuIC0gdGhlIGZ1bmN0aW9uIHVzZWQgdG8gY2FsY3VsYXRlIHRoZSBuZXcgc3RyZWFtIHZhbHVlXG4gKiBmcm9tIHRoZSBkZXBlbmRlbmNpZXNcbiAqIEByZXR1cm4ge3N0cmVhbX0gdGhlIGNyZWF0ZWQgc3RyZWFtXG4gKi9cbmZ1bmN0aW9uIGNyZWF0ZURlcGVuZGVudFN0cmVhbShkZXBzLCBmbikge1xuICB2YXIgcyA9IGNyZWF0ZVN0cmVhbSgpO1xuICBzLmZuID0gZm47XG4gIHMuZGVwcyA9IGRlcHM7XG4gIHMuZGVwc01ldCA9IGZhbHNlO1xuICBzLmRlcHNDaGFuZ2VkID0gZGVwcy5sZW5ndGggPiAwID8gW10gOiB1bmRlZmluZWQ7XG4gIHMuc2hvdWxkVXBkYXRlID0gZmFsc2U7XG4gIGFkZExpc3RlbmVycyhkZXBzLCBzKTtcbiAgcmV0dXJuIHM7XG59XG5cbi8qKlxuICogQHByaXZhdGVcbiAqIENoZWNrIGlmIGFsbCB0aGUgZGVwZW5kZW5jaWVzIGhhdmUgdmFsdWVzXG4gKiBAcGFyYW0ge3N0cmVhbX0gc3RyZWFtIC0gdGhlIHN0cmVhbSB0byBjaGVjayBkZXBlbmNlbmNpZXMgZnJvbVxuICogQHJldHVybiB7Qm9vbGVhbn0gYHRydWVgIGlmIGFsbCBkZXBlbmRlbmNpZXMgaGF2ZSB2YWxlcywgYGZhbHNlYCBvdGhlcndpc2VcbiAqL1xuZnVuY3Rpb24gaW5pdGlhbERlcHNOb3RNZXQoc3RyZWFtKSB7XG4gIHN0cmVhbS5kZXBzTWV0ID0gc3RyZWFtLmRlcHMuZXZlcnkoZnVuY3Rpb24ocykge1xuICAgIHJldHVybiBzLmhhc1ZhbDtcbiAgfSk7XG4gIHJldHVybiAhc3RyZWFtLmRlcHNNZXQ7XG59XG5cbi8qKlxuICogQHByaXZhdGVcbiAqIFVwZGF0ZSBhIGRlcGVuZGVudCBzdHJlYW0gdXNpbmcgaXRzIGRlcGVuZGVuY2llcyBpbiBhbiBhdG9taWMgd2F5XG4gKiBAcGFyYW0ge3N0cmVhbX0gc3RyZWFtIC0gdGhlIHN0cmVhbSB0byB1cGRhdGVcbiAqL1xuZnVuY3Rpb24gdXBkYXRlU3RyZWFtKHMpIHtcbiAgaWYgKChzLmRlcHNNZXQgIT09IHRydWUgJiYgaW5pdGlhbERlcHNOb3RNZXQocykpIHx8XG4gICAgICAocy5lbmQgIT09IHVuZGVmaW5lZCAmJiBzLmVuZC52YWwgPT09IHRydWUpKSByZXR1cm47XG4gIGlmIChpblN0cmVhbSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdG9VcGRhdGUucHVzaChzKTtcbiAgICByZXR1cm47XG4gIH1cbiAgaW5TdHJlYW0gPSBzO1xuICBpZiAocy5kZXBzQ2hhbmdlZCkgcy5mbkFyZ3Nbcy5mbkFyZ3MubGVuZ3RoIC0gMV0gPSBzLmRlcHNDaGFuZ2VkO1xuICB2YXIgcmV0dXJuVmFsID0gcy5mbi5hcHBseShzLmZuLCBzLmZuQXJncyk7XG4gIGlmIChyZXR1cm5WYWwgIT09IHVuZGVmaW5lZCkge1xuICAgIHMocmV0dXJuVmFsKTtcbiAgfVxuICBpblN0cmVhbSA9IHVuZGVmaW5lZDtcbiAgaWYgKHMuZGVwc0NoYW5nZWQgIT09IHVuZGVmaW5lZCkgcy5kZXBzQ2hhbmdlZCA9IFtdO1xuICBzLnNob3VsZFVwZGF0ZSA9IGZhbHNlO1xuICBpZiAoZmx1c2hpbmcgPT09IGZhbHNlKSBmbHVzaFVwZGF0ZSgpO1xufVxuXG4vKipcbiAqIEBwcml2YXRlXG4gKiBVcGRhdGUgdGhlIGRlcGVuZGVuY2llcyBvZiBhIHN0cmVhbVxuICogQHBhcmFtIHtzdHJlYW19IHN0cmVhbVxuICovXG5mdW5jdGlvbiB1cGRhdGVEZXBzKHMpIHtcbiAgdmFyIGksIG8sIGxpc3RcbiAgdmFyIGxpc3RlbmVycyA9IHMubGlzdGVuZXJzO1xuICBmb3IgKGkgPSAwOyBpIDwgbGlzdGVuZXJzLmxlbmd0aDsgKytpKSB7XG4gICAgbGlzdCA9IGxpc3RlbmVyc1tpXTtcbiAgICBpZiAobGlzdC5lbmQgPT09IHMpIHtcbiAgICAgIGVuZFN0cmVhbShsaXN0KTtcbiAgICB9IGVsc2Uge1xuICAgICAgaWYgKGxpc3QuZGVwc0NoYW5nZWQgIT09IHVuZGVmaW5lZCkgbGlzdC5kZXBzQ2hhbmdlZC5wdXNoKHMpO1xuICAgICAgbGlzdC5zaG91bGRVcGRhdGUgPSB0cnVlO1xuICAgICAgZmluZERlcHMobGlzdCk7XG4gICAgfVxuICB9XG4gIGZvciAoOyBvcmRlck5leHRJZHggPj0gMDsgLS1vcmRlck5leHRJZHgpIHtcbiAgICBvID0gb3JkZXJbb3JkZXJOZXh0SWR4XTtcbiAgICBpZiAoby5zaG91bGRVcGRhdGUgPT09IHRydWUpIHVwZGF0ZVN0cmVhbShvKTtcbiAgICBvLnF1ZXVlZCA9IGZhbHNlO1xuICB9XG59XG5cbi8qKlxuICogQHByaXZhdGVcbiAqIEFkZCBzdHJlYW0gZGVwZW5kZW5jaWVzIHRvIHRoZSBnbG9iYWwgYG9yZGVyYCBxdWV1ZS5cbiAqIEBwYXJhbSB7c3RyZWFtfSBzdHJlYW1cbiAqIEBzZWUgdXBkYXRlRGVwc1xuICovXG5mdW5jdGlvbiBmaW5kRGVwcyhzKSB7XG4gIHZhciBpXG4gIHZhciBsaXN0ZW5lcnMgPSBzLmxpc3RlbmVycztcbiAgaWYgKHMucXVldWVkID09PSBmYWxzZSkge1xuICAgIHMucXVldWVkID0gdHJ1ZTtcbiAgICBmb3IgKGkgPSAwOyBpIDwgbGlzdGVuZXJzLmxlbmd0aDsgKytpKSB7XG4gICAgICBmaW5kRGVwcyhsaXN0ZW5lcnNbaV0pO1xuICAgIH1cbiAgICBvcmRlclsrK29yZGVyTmV4dElkeF0gPSBzO1xuICB9XG59XG5cbi8qKlxuICogQHByaXZhdGVcbiAqL1xuZnVuY3Rpb24gZmx1c2hVcGRhdGUoKSB7XG4gIGZsdXNoaW5nID0gdHJ1ZTtcbiAgd2hpbGUgKHRvVXBkYXRlLmxlbmd0aCA+IDApIHtcbiAgICB2YXIgcyA9IHRvVXBkYXRlLnNoaWZ0KCk7XG4gICAgaWYgKHMudmFscy5sZW5ndGggPiAwKSBzLnZhbCA9IHMudmFscy5zaGlmdCgpO1xuICAgIHVwZGF0ZURlcHMocyk7XG4gIH1cbiAgZmx1c2hpbmcgPSBmYWxzZTtcbn1cblxuLyoqXG4gKiBAcHJpdmF0ZVxuICogUHVzaCBkb3duIGEgdmFsdWUgaW50byBhIHN0cmVhbVxuICogQHBhcmFtIHtzdHJlYW19IHN0cmVhbVxuICogQHBhcmFtIHsqfSB2YWx1ZVxuICovXG5mdW5jdGlvbiB1cGRhdGVTdHJlYW1WYWx1ZShzLCBuKSB7XG4gIGlmIChuICE9PSB1bmRlZmluZWQgJiYgbiAhPT0gbnVsbCAmJiBpc0Z1bmN0aW9uKG4udGhlbikpIHtcbiAgICBuLnRoZW4ocyk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHMudmFsID0gbjtcbiAgcy5oYXNWYWwgPSB0cnVlO1xuICBpZiAoaW5TdHJlYW0gPT09IHVuZGVmaW5lZCkge1xuICAgIGZsdXNoaW5nID0gdHJ1ZTtcbiAgICB1cGRhdGVEZXBzKHMpO1xuICAgIGlmICh0b1VwZGF0ZS5sZW5ndGggPiAwKSBmbHVzaFVwZGF0ZSgpOyBlbHNlIGZsdXNoaW5nID0gZmFsc2U7XG4gIH0gZWxzZSBpZiAoaW5TdHJlYW0gPT09IHMpIHtcbiAgICBtYXJrTGlzdGVuZXJzKHMsIHMubGlzdGVuZXJzKTtcbiAgfSBlbHNlIHtcbiAgICBzLnZhbHMucHVzaChuKTtcbiAgICB0b1VwZGF0ZS5wdXNoKHMpO1xuICB9XG59XG5cbi8qKlxuICogQHByaXZhdGVcbiAqL1xuZnVuY3Rpb24gbWFya0xpc3RlbmVycyhzLCBsaXN0cykge1xuICB2YXIgaSwgbGlzdDtcbiAgZm9yIChpID0gMDsgaSA8IGxpc3RzLmxlbmd0aDsgKytpKSB7XG4gICAgbGlzdCA9IGxpc3RzW2ldO1xuICAgIGlmIChsaXN0LmVuZCAhPT0gcykge1xuICAgICAgaWYgKGxpc3QuZGVwc0NoYW5nZWQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBsaXN0LmRlcHNDaGFuZ2VkLnB1c2gocyk7XG4gICAgICB9XG4gICAgICBsaXN0LnNob3VsZFVwZGF0ZSA9IHRydWU7XG4gICAgfSBlbHNlIHtcbiAgICAgIGVuZFN0cmVhbShsaXN0KTtcbiAgICB9XG4gIH1cbn1cblxuLyoqXG4gKiBAcHJpdmF0ZVxuICogQWRkIGRlcGVuZGVuY2llcyB0byBhIHN0cmVhbVxuICogQHBhcmFtIHtBcnJheTxzdHJlYW0+fSBkZXBlbmRlbmNpZXNcbiAqIEBwYXJhbSB7c3RyZWFtfSBzdHJlYW1cbiAqL1xuZnVuY3Rpb24gYWRkTGlzdGVuZXJzKGRlcHMsIHMpIHtcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBkZXBzLmxlbmd0aDsgKytpKSB7XG4gICAgZGVwc1tpXS5saXN0ZW5lcnMucHVzaChzKTtcbiAgfVxufVxuXG4vKipcbiAqIEBwcml2YXRlXG4gKiBSZW1vdmVzIGFuIHN0cmVhbSBmcm9tIGEgZGVwZW5kZW5jeSBhcnJheVxuICogQHBhcmFtIHtzdHJlYW19IHN0cmVhbVxuICogQHBhcmFtIHtBcnJheTxzdHJlYW0+fSBkZXBlbmRlbmNpZXNcbiAqL1xuZnVuY3Rpb24gcmVtb3ZlTGlzdGVuZXIocywgbGlzdGVuZXJzKSB7XG4gIHZhciBpZHggPSBsaXN0ZW5lcnMuaW5kZXhPZihzKTtcbiAgbGlzdGVuZXJzW2lkeF0gPSBsaXN0ZW5lcnNbbGlzdGVuZXJzLmxlbmd0aCAtIDFdO1xuICBsaXN0ZW5lcnMubGVuZ3RoLS07XG59XG5cbi8qKlxuICogQHByaXZhdGVcbiAqIERldGFjaCBhIHN0cmVhbSBmcm9tIGl0cyBkZXBlbmRlbmNpZXNcbiAqIEBwYXJhbSB7c3RyZWFtfSBzdHJlYW1cbiAqL1xuZnVuY3Rpb24gZGV0YWNoRGVwcyhzKSB7XG4gIGZvciAodmFyIGkgPSAwOyBpIDwgcy5kZXBzLmxlbmd0aDsgKytpKSB7XG4gICAgcmVtb3ZlTGlzdGVuZXIocywgcy5kZXBzW2ldLmxpc3RlbmVycyk7XG4gIH1cbiAgcy5kZXBzLmxlbmd0aCA9IDA7XG59XG5cbi8qKlxuICogQHByaXZhdGVcbiAqIEVuZHMgYSBzdHJlYW1cbiAqL1xuZnVuY3Rpb24gZW5kU3RyZWFtKHMpIHtcbiAgaWYgKHMuZGVwcyAhPT0gdW5kZWZpbmVkKSBkZXRhY2hEZXBzKHMpO1xuICBpZiAocy5lbmQgIT09IHVuZGVmaW5lZCkgZGV0YWNoRGVwcyhzLmVuZCk7XG59XG5cbi8qKlxuICogQHByaXZhdGVcbiAqIHRyYW5zZHVjZXIgc3RyZWFtIHRyYW5zZm9ybWVyXG4gKi9cbmZ1bmN0aW9uIFN0cmVhbVRyYW5zZm9ybWVyKCkgeyB9XG5TdHJlYW1UcmFuc2Zvcm1lci5wcm90b3R5cGVbJ0BAdHJhbnNkdWNlci9pbml0J10gPSBmdW5jdGlvbigpIHsgfTtcblN0cmVhbVRyYW5zZm9ybWVyLnByb3RvdHlwZVsnQEB0cmFuc2R1Y2VyL3Jlc3VsdCddID0gZnVuY3Rpb24oKSB7IH07XG5TdHJlYW1UcmFuc2Zvcm1lci5wcm90b3R5cGVbJ0BAdHJhbnNkdWNlci9zdGVwJ10gPSBmdW5jdGlvbihzLCB2KSB7IHJldHVybiB2OyB9O1xuXG5tb2R1bGUuZXhwb3J0cyA9IGZseWQ7XG4iLCJ2YXIgX2FyaXR5ID0gcmVxdWlyZSgnLi9pbnRlcm5hbC9fYXJpdHknKTtcbnZhciBfY3VycnkxID0gcmVxdWlyZSgnLi9pbnRlcm5hbC9fY3VycnkxJyk7XG52YXIgX2N1cnJ5MiA9IHJlcXVpcmUoJy4vaW50ZXJuYWwvX2N1cnJ5MicpO1xudmFyIF9jdXJyeU4gPSByZXF1aXJlKCcuL2ludGVybmFsL19jdXJyeU4nKTtcblxuXG4vKipcbiAqIFJldHVybnMgYSBjdXJyaWVkIGVxdWl2YWxlbnQgb2YgdGhlIHByb3ZpZGVkIGZ1bmN0aW9uLCB3aXRoIHRoZSBzcGVjaWZpZWRcbiAqIGFyaXR5LiBUaGUgY3VycmllZCBmdW5jdGlvbiBoYXMgdHdvIHVudXN1YWwgY2FwYWJpbGl0aWVzLiBGaXJzdCwgaXRzXG4gKiBhcmd1bWVudHMgbmVlZG4ndCBiZSBwcm92aWRlZCBvbmUgYXQgYSB0aW1lLiBJZiBgZ2AgaXMgYFIuY3VycnlOKDMsIGYpYCwgdGhlXG4gKiBmb2xsb3dpbmcgYXJlIGVxdWl2YWxlbnQ6XG4gKlxuICogICAtIGBnKDEpKDIpKDMpYFxuICogICAtIGBnKDEpKDIsIDMpYFxuICogICAtIGBnKDEsIDIpKDMpYFxuICogICAtIGBnKDEsIDIsIDMpYFxuICpcbiAqIFNlY29uZGx5LCB0aGUgc3BlY2lhbCBwbGFjZWhvbGRlciB2YWx1ZSBgUi5fX2AgbWF5IGJlIHVzZWQgdG8gc3BlY2lmeVxuICogXCJnYXBzXCIsIGFsbG93aW5nIHBhcnRpYWwgYXBwbGljYXRpb24gb2YgYW55IGNvbWJpbmF0aW9uIG9mIGFyZ3VtZW50cyxcbiAqIHJlZ2FyZGxlc3Mgb2YgdGhlaXIgcG9zaXRpb25zLiBJZiBgZ2AgaXMgYXMgYWJvdmUgYW5kIGBfYCBpcyBgUi5fX2AsIHRoZVxuICogZm9sbG93aW5nIGFyZSBlcXVpdmFsZW50OlxuICpcbiAqICAgLSBgZygxLCAyLCAzKWBcbiAqICAgLSBgZyhfLCAyLCAzKSgxKWBcbiAqICAgLSBgZyhfLCBfLCAzKSgxKSgyKWBcbiAqICAgLSBgZyhfLCBfLCAzKSgxLCAyKWBcbiAqICAgLSBgZyhfLCAyKSgxKSgzKWBcbiAqICAgLSBgZyhfLCAyKSgxLCAzKWBcbiAqICAgLSBgZyhfLCAyKShfLCAzKSgxKWBcbiAqXG4gKiBAZnVuY1xuICogQG1lbWJlck9mIFJcbiAqIEBzaW5jZSB2MC41LjBcbiAqIEBjYXRlZ29yeSBGdW5jdGlvblxuICogQHNpZyBOdW1iZXIgLT4gKCogLT4gYSkgLT4gKCogLT4gYSlcbiAqIEBwYXJhbSB7TnVtYmVyfSBsZW5ndGggVGhlIGFyaXR5IGZvciB0aGUgcmV0dXJuZWQgZnVuY3Rpb24uXG4gKiBAcGFyYW0ge0Z1bmN0aW9ufSBmbiBUaGUgZnVuY3Rpb24gdG8gY3VycnkuXG4gKiBAcmV0dXJuIHtGdW5jdGlvbn0gQSBuZXcsIGN1cnJpZWQgZnVuY3Rpb24uXG4gKiBAc2VlIFIuY3VycnlcbiAqIEBleGFtcGxlXG4gKlxuICogICAgICB2YXIgc3VtQXJncyA9ICguLi5hcmdzKSA9PiBSLnN1bShhcmdzKTtcbiAqXG4gKiAgICAgIHZhciBjdXJyaWVkQWRkRm91ck51bWJlcnMgPSBSLmN1cnJ5Tig0LCBzdW1BcmdzKTtcbiAqICAgICAgdmFyIGYgPSBjdXJyaWVkQWRkRm91ck51bWJlcnMoMSwgMik7XG4gKiAgICAgIHZhciBnID0gZigzKTtcbiAqICAgICAgZyg0KTsgLy89PiAxMFxuICovXG5tb2R1bGUuZXhwb3J0cyA9IF9jdXJyeTIoZnVuY3Rpb24gY3VycnlOKGxlbmd0aCwgZm4pIHtcbiAgaWYgKGxlbmd0aCA9PT0gMSkge1xuICAgIHJldHVybiBfY3VycnkxKGZuKTtcbiAgfVxuICByZXR1cm4gX2FyaXR5KGxlbmd0aCwgX2N1cnJ5TihsZW5ndGgsIFtdLCBmbikpO1xufSk7XG4iLCJtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIF9hcml0eShuLCBmbikge1xuICAvKiBlc2xpbnQtZGlzYWJsZSBuby11bnVzZWQtdmFycyAqL1xuICBzd2l0Y2ggKG4pIHtcbiAgICBjYXNlIDA6IHJldHVybiBmdW5jdGlvbigpIHsgcmV0dXJuIGZuLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7IH07XG4gICAgY2FzZSAxOiByZXR1cm4gZnVuY3Rpb24oYTApIHsgcmV0dXJuIGZuLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7IH07XG4gICAgY2FzZSAyOiByZXR1cm4gZnVuY3Rpb24oYTAsIGExKSB7IHJldHVybiBmbi5hcHBseSh0aGlzLCBhcmd1bWVudHMpOyB9O1xuICAgIGNhc2UgMzogcmV0dXJuIGZ1bmN0aW9uKGEwLCBhMSwgYTIpIHsgcmV0dXJuIGZuLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7IH07XG4gICAgY2FzZSA0OiByZXR1cm4gZnVuY3Rpb24oYTAsIGExLCBhMiwgYTMpIHsgcmV0dXJuIGZuLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7IH07XG4gICAgY2FzZSA1OiByZXR1cm4gZnVuY3Rpb24oYTAsIGExLCBhMiwgYTMsIGE0KSB7IHJldHVybiBmbi5hcHBseSh0aGlzLCBhcmd1bWVudHMpOyB9O1xuICAgIGNhc2UgNjogcmV0dXJuIGZ1bmN0aW9uKGEwLCBhMSwgYTIsIGEzLCBhNCwgYTUpIHsgcmV0dXJuIGZuLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7IH07XG4gICAgY2FzZSA3OiByZXR1cm4gZnVuY3Rpb24oYTAsIGExLCBhMiwgYTMsIGE0LCBhNSwgYTYpIHsgcmV0dXJuIGZuLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7IH07XG4gICAgY2FzZSA4OiByZXR1cm4gZnVuY3Rpb24oYTAsIGExLCBhMiwgYTMsIGE0LCBhNSwgYTYsIGE3KSB7IHJldHVybiBmbi5hcHBseSh0aGlzLCBhcmd1bWVudHMpOyB9O1xuICAgIGNhc2UgOTogcmV0dXJuIGZ1bmN0aW9uKGEwLCBhMSwgYTIsIGEzLCBhNCwgYTUsIGE2LCBhNywgYTgpIHsgcmV0dXJuIGZuLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7IH07XG4gICAgY2FzZSAxMDogcmV0dXJuIGZ1bmN0aW9uKGEwLCBhMSwgYTIsIGEzLCBhNCwgYTUsIGE2LCBhNywgYTgsIGE5KSB7IHJldHVybiBmbi5hcHBseSh0aGlzLCBhcmd1bWVudHMpOyB9O1xuICAgIGRlZmF1bHQ6IHRocm93IG5ldyBFcnJvcignRmlyc3QgYXJndW1lbnQgdG8gX2FyaXR5IG11c3QgYmUgYSBub24tbmVnYXRpdmUgaW50ZWdlciBubyBncmVhdGVyIHRoYW4gdGVuJyk7XG4gIH1cbn07XG4iLCJ2YXIgX2lzUGxhY2Vob2xkZXIgPSByZXF1aXJlKCcuL19pc1BsYWNlaG9sZGVyJyk7XG5cblxuLyoqXG4gKiBPcHRpbWl6ZWQgaW50ZXJuYWwgb25lLWFyaXR5IGN1cnJ5IGZ1bmN0aW9uLlxuICpcbiAqIEBwcml2YXRlXG4gKiBAY2F0ZWdvcnkgRnVuY3Rpb25cbiAqIEBwYXJhbSB7RnVuY3Rpb259IGZuIFRoZSBmdW5jdGlvbiB0byBjdXJyeS5cbiAqIEByZXR1cm4ge0Z1bmN0aW9ufSBUaGUgY3VycmllZCBmdW5jdGlvbi5cbiAqL1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiBfY3VycnkxKGZuKSB7XG4gIHJldHVybiBmdW5jdGlvbiBmMShhKSB7XG4gICAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDAgfHwgX2lzUGxhY2Vob2xkZXIoYSkpIHtcbiAgICAgIHJldHVybiBmMTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmV0dXJuIGZuLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gICAgfVxuICB9O1xufTtcbiIsInZhciBfY3VycnkxID0gcmVxdWlyZSgnLi9fY3VycnkxJyk7XG52YXIgX2lzUGxhY2Vob2xkZXIgPSByZXF1aXJlKCcuL19pc1BsYWNlaG9sZGVyJyk7XG5cblxuLyoqXG4gKiBPcHRpbWl6ZWQgaW50ZXJuYWwgdHdvLWFyaXR5IGN1cnJ5IGZ1bmN0aW9uLlxuICpcbiAqIEBwcml2YXRlXG4gKiBAY2F0ZWdvcnkgRnVuY3Rpb25cbiAqIEBwYXJhbSB7RnVuY3Rpb259IGZuIFRoZSBmdW5jdGlvbiB0byBjdXJyeS5cbiAqIEByZXR1cm4ge0Z1bmN0aW9ufSBUaGUgY3VycmllZCBmdW5jdGlvbi5cbiAqL1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiBfY3VycnkyKGZuKSB7XG4gIHJldHVybiBmdW5jdGlvbiBmMihhLCBiKSB7XG4gICAgc3dpdGNoIChhcmd1bWVudHMubGVuZ3RoKSB7XG4gICAgICBjYXNlIDA6XG4gICAgICAgIHJldHVybiBmMjtcbiAgICAgIGNhc2UgMTpcbiAgICAgICAgcmV0dXJuIF9pc1BsYWNlaG9sZGVyKGEpID8gZjJcbiAgICAgICAgICAgICA6IF9jdXJyeTEoZnVuY3Rpb24oX2IpIHsgcmV0dXJuIGZuKGEsIF9iKTsgfSk7XG4gICAgICBkZWZhdWx0OlxuICAgICAgICByZXR1cm4gX2lzUGxhY2Vob2xkZXIoYSkgJiYgX2lzUGxhY2Vob2xkZXIoYikgPyBmMlxuICAgICAgICAgICAgIDogX2lzUGxhY2Vob2xkZXIoYSkgPyBfY3VycnkxKGZ1bmN0aW9uKF9hKSB7IHJldHVybiBmbihfYSwgYik7IH0pXG4gICAgICAgICAgICAgOiBfaXNQbGFjZWhvbGRlcihiKSA/IF9jdXJyeTEoZnVuY3Rpb24oX2IpIHsgcmV0dXJuIGZuKGEsIF9iKTsgfSlcbiAgICAgICAgICAgICA6IGZuKGEsIGIpO1xuICAgIH1cbiAgfTtcbn07XG4iLCJ2YXIgX2FyaXR5ID0gcmVxdWlyZSgnLi9fYXJpdHknKTtcbnZhciBfaXNQbGFjZWhvbGRlciA9IHJlcXVpcmUoJy4vX2lzUGxhY2Vob2xkZXInKTtcblxuXG4vKipcbiAqIEludGVybmFsIGN1cnJ5TiBmdW5jdGlvbi5cbiAqXG4gKiBAcHJpdmF0ZVxuICogQGNhdGVnb3J5IEZ1bmN0aW9uXG4gKiBAcGFyYW0ge051bWJlcn0gbGVuZ3RoIFRoZSBhcml0eSBvZiB0aGUgY3VycmllZCBmdW5jdGlvbi5cbiAqIEBwYXJhbSB7QXJyYXl9IHJlY2VpdmVkIEFuIGFycmF5IG9mIGFyZ3VtZW50cyByZWNlaXZlZCB0aHVzIGZhci5cbiAqIEBwYXJhbSB7RnVuY3Rpb259IGZuIFRoZSBmdW5jdGlvbiB0byBjdXJyeS5cbiAqIEByZXR1cm4ge0Z1bmN0aW9ufSBUaGUgY3VycmllZCBmdW5jdGlvbi5cbiAqL1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiBfY3VycnlOKGxlbmd0aCwgcmVjZWl2ZWQsIGZuKSB7XG4gIHJldHVybiBmdW5jdGlvbigpIHtcbiAgICB2YXIgY29tYmluZWQgPSBbXTtcbiAgICB2YXIgYXJnc0lkeCA9IDA7XG4gICAgdmFyIGxlZnQgPSBsZW5ndGg7XG4gICAgdmFyIGNvbWJpbmVkSWR4ID0gMDtcbiAgICB3aGlsZSAoY29tYmluZWRJZHggPCByZWNlaXZlZC5sZW5ndGggfHwgYXJnc0lkeCA8IGFyZ3VtZW50cy5sZW5ndGgpIHtcbiAgICAgIHZhciByZXN1bHQ7XG4gICAgICBpZiAoY29tYmluZWRJZHggPCByZWNlaXZlZC5sZW5ndGggJiZcbiAgICAgICAgICAoIV9pc1BsYWNlaG9sZGVyKHJlY2VpdmVkW2NvbWJpbmVkSWR4XSkgfHxcbiAgICAgICAgICAgYXJnc0lkeCA+PSBhcmd1bWVudHMubGVuZ3RoKSkge1xuICAgICAgICByZXN1bHQgPSByZWNlaXZlZFtjb21iaW5lZElkeF07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZXN1bHQgPSBhcmd1bWVudHNbYXJnc0lkeF07XG4gICAgICAgIGFyZ3NJZHggKz0gMTtcbiAgICAgIH1cbiAgICAgIGNvbWJpbmVkW2NvbWJpbmVkSWR4XSA9IHJlc3VsdDtcbiAgICAgIGlmICghX2lzUGxhY2Vob2xkZXIocmVzdWx0KSkge1xuICAgICAgICBsZWZ0IC09IDE7XG4gICAgICB9XG4gICAgICBjb21iaW5lZElkeCArPSAxO1xuICAgIH1cbiAgICByZXR1cm4gbGVmdCA8PSAwID8gZm4uYXBwbHkodGhpcywgY29tYmluZWQpXG4gICAgICAgICAgICAgICAgICAgICA6IF9hcml0eShsZWZ0LCBfY3VycnlOKGxlbmd0aCwgY29tYmluZWQsIGZuKSk7XG4gIH07XG59O1xuIiwibW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiBfaXNQbGFjZWhvbGRlcihhKSB7XG4gIHJldHVybiBhICE9IG51bGwgJiZcbiAgICAgICAgIHR5cGVvZiBhID09PSAnb2JqZWN0JyAmJlxuICAgICAgICAgYVsnQEBmdW5jdGlvbmFsL3BsYWNlaG9sZGVyJ10gPT09IHRydWU7XG59O1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG5tb2R1bGUuZXhwb3J0cyA9IFJlc3BvbnNlO1xuXG4vKipcbiAqIEEgcmVzcG9uc2UgZnJvbSBhIHdlYiByZXF1ZXN0XG4gKlxuICogQHBhcmFtIHtOdW1iZXJ9IHN0YXR1c0NvZGVcbiAqIEBwYXJhbSB7T2JqZWN0fSBoZWFkZXJzXG4gKiBAcGFyYW0ge0J1ZmZlcn0gYm9keVxuICogQHBhcmFtIHtTdHJpbmd9IHVybFxuICovXG5mdW5jdGlvbiBSZXNwb25zZShzdGF0dXNDb2RlLCBoZWFkZXJzLCBib2R5LCB1cmwpIHtcbiAgaWYgKHR5cGVvZiBzdGF0dXNDb2RlICE9PSAnbnVtYmVyJykge1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ3N0YXR1c0NvZGUgbXVzdCBiZSBhIG51bWJlciBidXQgd2FzICcgKyAodHlwZW9mIHN0YXR1c0NvZGUpKTtcbiAgfVxuICBpZiAoaGVhZGVycyA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ2hlYWRlcnMgY2Fubm90IGJlIG51bGwnKTtcbiAgfVxuICBpZiAodHlwZW9mIGhlYWRlcnMgIT09ICdvYmplY3QnKSB7XG4gICAgdGhyb3cgbmV3IFR5cGVFcnJvcignaGVhZGVycyBtdXN0IGJlIGFuIG9iamVjdCBidXQgd2FzICcgKyAodHlwZW9mIGhlYWRlcnMpKTtcbiAgfVxuICB0aGlzLnN0YXR1c0NvZGUgPSBzdGF0dXNDb2RlO1xuICB0aGlzLmhlYWRlcnMgPSB7fTtcbiAgZm9yICh2YXIga2V5IGluIGhlYWRlcnMpIHtcbiAgICB0aGlzLmhlYWRlcnNba2V5LnRvTG93ZXJDYXNlKCldID0gaGVhZGVyc1trZXldO1xuICB9XG4gIHRoaXMuYm9keSA9IGJvZHk7XG4gIHRoaXMudXJsID0gdXJsO1xufVxuXG5SZXNwb25zZS5wcm90b3R5cGUuZ2V0Qm9keSA9IGZ1bmN0aW9uIChlbmNvZGluZykge1xuICBpZiAodGhpcy5zdGF0dXNDb2RlID49IDMwMCkge1xuICAgIHZhciBlcnIgPSBuZXcgRXJyb3IoJ1NlcnZlciByZXNwb25kZWQgd2l0aCBzdGF0dXMgY29kZSAnXG4gICAgICAgICAgICAgICAgICAgICsgdGhpcy5zdGF0dXNDb2RlICsgJzpcXG4nICsgdGhpcy5ib2R5LnRvU3RyaW5nKCkpO1xuICAgIGVyci5zdGF0dXNDb2RlID0gdGhpcy5zdGF0dXNDb2RlO1xuICAgIGVyci5oZWFkZXJzID0gdGhpcy5oZWFkZXJzO1xuICAgIGVyci5ib2R5ID0gdGhpcy5ib2R5O1xuICAgIGVyci51cmwgPSB0aGlzLnVybDtcbiAgICB0aHJvdyBlcnI7XG4gIH1cbiAgcmV0dXJuIGVuY29kaW5nID8gdGhpcy5ib2R5LnRvU3RyaW5nKGVuY29kaW5nKSA6IHRoaXMuYm9keTtcbn07XG4iLCIndXNlIHN0cmljdCc7XG5cbk9iamVjdC5kZWZpbmVQcm9wZXJ0eShleHBvcnRzLCBcIl9fZXNNb2R1bGVcIiwge1xuICB2YWx1ZTogdHJ1ZVxufSk7XG5leHBvcnRzLnRvSnMgPSBleHBvcnRzLnRvQ2xqID0gZXhwb3J0cy5mbmlsID0gZXhwb3J0cy5jdXJyeSA9IGV4cG9ydHMucGFydGlhbCA9IGV4cG9ydHMucGlwZWxpbmUgPSBleHBvcnRzLmtuaXQgPSBleHBvcnRzLmp1eHQgPSBleHBvcnRzLmNvbXAgPSBleHBvcnRzLmlzT2RkID0gZXhwb3J0cy5pc0V2ZW4gPSBleHBvcnRzLnN1bSA9IGV4cG9ydHMuZGVjID0gZXhwb3J0cy5pbmMgPSBleHBvcnRzLmNvbnN0YW50bHkgPSBleHBvcnRzLmlkZW50aXR5ID0gZXhwb3J0cy5wcmltU2VxID0gZXhwb3J0cy5ncm91cEJ5ID0gZXhwb3J0cy5wYXJ0aXRpb25CeSA9IGV4cG9ydHMucGFydGl0aW9uID0gZXhwb3J0cy5yZXBlYXRlZGx5ID0gZXhwb3J0cy5yZXBlYXQgPSBleHBvcnRzLml0ZXJhdGUgPSBleHBvcnRzLmludGVybGVhdmUgPSBleHBvcnRzLmludGVycG9zZSA9IGV4cG9ydHMuc29ydEJ5ID0gZXhwb3J0cy5zb3J0ID0gZXhwb3J0cy5ldmVyeSA9IGV4cG9ydHMuc29tZSA9IGV4cG9ydHMuZHJvcFdoaWxlID0gZXhwb3J0cy5kcm9wID0gZXhwb3J0cy50YWtlV2hpbGUgPSBleHBvcnRzLnRha2UgPSBleHBvcnRzLnJlZHVjZUtWID0gZXhwb3J0cy5yZWR1Y2UgPSBleHBvcnRzLnJlbW92ZSA9IGV4cG9ydHMuZmlsdGVyID0gZXhwb3J0cy5tYXBjYXQgPSBleHBvcnRzLm1hcCA9IGV4cG9ydHMuZWFjaCA9IGV4cG9ydHMuaW50b0FycmF5ID0gZXhwb3J0cy5mbGF0dGVuID0gZXhwb3J0cy5jb25jYXQgPSBleHBvcnRzLmNvbnMgPSBleHBvcnRzLnNlcSA9IGV4cG9ydHMucmVzdCA9IGV4cG9ydHMuZmlyc3QgPSBleHBvcnRzLmlzU3VwZXJzZXQgPSBleHBvcnRzLmlzU3Vic2V0ID0gZXhwb3J0cy5kaWZmZXJlbmNlID0gZXhwb3J0cy5pbnRlcnNlY3Rpb24gPSBleHBvcnRzLnVuaW9uID0gZXhwb3J0cy5kaXNqID0gZXhwb3J0cy5tZXJnZSA9IGV4cG9ydHMudmFscyA9IGV4cG9ydHMua2V5cyA9IGV4cG9ydHMuc3VidmVjID0gZXhwb3J0cy5yZXZlcnNlID0gZXhwb3J0cy56aXBtYXAgPSBleHBvcnRzLnBvcCA9IGV4cG9ydHMucGVlayA9IGV4cG9ydHMuaXNFbXB0eSA9IGV4cG9ydHMuY291bnQgPSBleHBvcnRzLnVwZGF0ZUluID0gZXhwb3J0cy5hc3NvY0luID0gZXhwb3J0cy5sYXN0ID0gZXhwb3J0cy5udGggPSBleHBvcnRzLmZpbmQgPSBleHBvcnRzLmhhc0tleSA9IGV4cG9ydHMuZ2V0SW4gPSBleHBvcnRzLmdldCA9IGV4cG9ydHMuZW1wdHkgPSBleHBvcnRzLmRpc3RpbmN0ID0gZXhwb3J0cy5kaXNzb2MgPSBleHBvcnRzLmFzc29jID0gZXhwb3J0cy5pbnRvID0gZXhwb3J0cy5jb25qID0gZXhwb3J0cy5pc1JldmVyc2libGUgPSBleHBvcnRzLmlzU2VxYWJsZSA9IGV4cG9ydHMuaXNSZWR1Y2VhYmxlID0gZXhwb3J0cy5pc0luZGV4ZWQgPSBleHBvcnRzLmlzQ291bnRlZCA9IGV4cG9ydHMuaXNBc3NvY2lhdGl2ZSA9IGV4cG9ydHMuaXNTZXF1ZW50aWFsID0gZXhwb3J0cy5pc0NvbGxlY3Rpb24gPSBleHBvcnRzLmlzU2V0ID0gZXhwb3J0cy5pc01hcCA9IGV4cG9ydHMuaXNWZWN0b3IgPSBleHBvcnRzLmlzU2VxID0gZXhwb3J0cy5pc0xpc3QgPSBleHBvcnRzLmhhc2ggPSBleHBvcnRzLmVxdWFscyA9IHVuZGVmaW5lZDtcblxudmFyIF9tb3JpID0gcmVxdWlyZSgnbW9yaScpO1xuXG52YXIgX21vcmkyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfbW9yaSk7XG5cbmZ1bmN0aW9uIF9pbnRlcm9wUmVxdWlyZURlZmF1bHQob2JqKSB7IHJldHVybiBvYmogJiYgb2JqLl9fZXNNb2R1bGUgPyBvYmogOiB7IGRlZmF1bHQ6IG9iaiB9OyB9XG5cbi8vIEludGVybmFsIEhlbHBlcnNcbnZhciB1bmFyeUZ1bmMgPSBmdW5jdGlvbiB1bmFyeUZ1bmMobmFtZSkge1xuICByZXR1cm4gZnVuY3Rpb24gX3VuYXJ5KCkge1xuICAgIHJldHVybiBfbW9yaTIuZGVmYXVsdFtuYW1lXSh0aGlzKTtcbiAgfTtcbn07XG52YXIgYmluYXJ5RnVuYyA9IGZ1bmN0aW9uIGJpbmFyeUZ1bmMobmFtZSwgcmV2KSB7XG4gIHJldHVybiByZXYgPyBmdW5jdGlvbiBfYmluYXJ5UmV2KHApIHtcbiAgICByZXR1cm4gX21vcmkyLmRlZmF1bHRbbmFtZV0ocCwgdGhpcyk7XG4gIH0gOiBmdW5jdGlvbiBfYmluYXJ5KHApIHtcbiAgICByZXR1cm4gX21vcmkyLmRlZmF1bHRbbmFtZV0odGhpcywgcCk7XG4gIH07XG59O1xudmFyIHRlcm5hcnlGdW5jID0gZnVuY3Rpb24gdGVybmFyeUZ1bmMobmFtZSwgcmV2KSB7XG4gIHJldHVybiByZXYgPyBmdW5jdGlvbiBfdGVybmFyeVJldihhLCBiKSB7XG4gICAgcmV0dXJuIF9tb3JpMi5kZWZhdWx0W25hbWVdKGEsIGIsIHRoaXMpO1xuICB9IDogZnVuY3Rpb24gX3Rlcm5hcnkoYSwgYikge1xuICAgIHJldHVybiBfbW9yaTIuZGVmYXVsdFtuYW1lXSh0aGlzLCBhLCBiKTtcbiAgfTtcbn07XG5cbnZhciB2YXJpYWRpY0Z1bmMgPSBmdW5jdGlvbiB2YXJpYWRpY0Z1bmMobmFtZSwgcmV2KSB7XG4gIHJldHVybiByZXYgPyBmdW5jdGlvbiBfdmFyaWFkaWNSZXYoKSB7XG4gICAgcmV0dXJuIF9tb3JpMi5kZWZhdWx0W25hbWVdLmFwcGx5KF9tb3JpMi5kZWZhdWx0LCBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChhcmd1bWVudHMpLmNvbmNhdChbdGhpc10pKTtcbiAgfSA6IGZ1bmN0aW9uIF92YXJpYWRpYygpIHtcbiAgICByZXR1cm4gX21vcmkyLmRlZmF1bHRbbmFtZV0uYXBwbHkoX21vcmkyLmRlZmF1bHQsIFt0aGlzXS5jb25jYXQoQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwoYXJndW1lbnRzKSkpO1xuICB9O1xufTtcblxuLy8gRnVuZGFtZW50YWxzXG52YXIgZXF1YWxzID0gZXhwb3J0cy5lcXVhbHMgPSBiaW5hcnlGdW5jKCdlcXVhbHMnKTtcbnZhciBoYXNoID0gZXhwb3J0cy5oYXNoID0gdW5hcnlGdW5jKCdoYXNoJyk7XG4vLyAtLVxuXG4vLyBUeXBlIFByZWRpY2F0ZXNcbnZhciBpc0xpc3QgPSBleHBvcnRzLmlzTGlzdCA9IHVuYXJ5RnVuYygnaXNMaXN0Jyk7XG52YXIgaXNTZXEgPSBleHBvcnRzLmlzU2VxID0gdW5hcnlGdW5jKCdpc1NlcScpO1xudmFyIGlzVmVjdG9yID0gZXhwb3J0cy5pc1ZlY3RvciA9IHVuYXJ5RnVuYygnaXNWZWN0b3InKTtcbnZhciBpc01hcCA9IGV4cG9ydHMuaXNNYXAgPSB1bmFyeUZ1bmMoJ2lzTWFwJyk7XG52YXIgaXNTZXQgPSBleHBvcnRzLmlzU2V0ID0gdW5hcnlGdW5jKCdpc1NldCcpO1xudmFyIGlzQ29sbGVjdGlvbiA9IGV4cG9ydHMuaXNDb2xsZWN0aW9uID0gdW5hcnlGdW5jKCdpc0NvbGxlY3Rpb24nKTtcbnZhciBpc1NlcXVlbnRpYWwgPSBleHBvcnRzLmlzU2VxdWVudGlhbCA9IHVuYXJ5RnVuYygnaXNTZXF1ZW50aWFsJyk7XG52YXIgaXNBc3NvY2lhdGl2ZSA9IGV4cG9ydHMuaXNBc3NvY2lhdGl2ZSA9IHVuYXJ5RnVuYygnaXNBc3NvY2lhdGl2ZScpO1xudmFyIGlzQ291bnRlZCA9IGV4cG9ydHMuaXNDb3VudGVkID0gdW5hcnlGdW5jKCdpc0NvdW50ZWQnKTtcbnZhciBpc0luZGV4ZWQgPSBleHBvcnRzLmlzSW5kZXhlZCA9IHVuYXJ5RnVuYygnaXNJbmRleGVkJyk7XG52YXIgaXNSZWR1Y2VhYmxlID0gZXhwb3J0cy5pc1JlZHVjZWFibGUgPSB1bmFyeUZ1bmMoJ2lzUmVkdWNlYWJsZScpO1xudmFyIGlzU2VxYWJsZSA9IGV4cG9ydHMuaXNTZXFhYmxlID0gdW5hcnlGdW5jKCdpc1NlcWFibGUnKTtcbnZhciBpc1JldmVyc2libGUgPSBleHBvcnRzLmlzUmV2ZXJzaWJsZSA9IHVuYXJ5RnVuYygnaXNSZXZlcnNpYmxlJyk7XG4vLyAtLVxuXG4vLyBDb2xsZWN0aW9uc1xuLy8gLS1cblxuLy8gQ29sbGVjdGlvbiBPcGVyYXRpb25zXG52YXIgY29uaiA9IGV4cG9ydHMuY29uaiA9IHZhcmlhZGljRnVuYygnY29uaicpO1xudmFyIGludG8gPSBleHBvcnRzLmludG8gPSBiaW5hcnlGdW5jKCdpbnRvJyk7XG52YXIgYXNzb2MgPSBleHBvcnRzLmFzc29jID0gdmFyaWFkaWNGdW5jKCdhc3NvYycpO1xudmFyIGRpc3NvYyA9IGV4cG9ydHMuZGlzc29jID0gdmFyaWFkaWNGdW5jKCdkaXNzb2MnKTtcbnZhciBkaXN0aW5jdCA9IGV4cG9ydHMuZGlzdGluY3QgPSB1bmFyeUZ1bmMoJ2Rpc3RpbmN0Jyk7XG52YXIgZW1wdHkgPSBleHBvcnRzLmVtcHR5ID0gdW5hcnlGdW5jKCdlbXB0eScpO1xudmFyIGdldCA9IGV4cG9ydHMuZ2V0ID0gdGVybmFyeUZ1bmMoJ2dldCcpO1xudmFyIGdldEluID0gZXhwb3J0cy5nZXRJbiA9IHRlcm5hcnlGdW5jKCdnZXRJbicpO1xudmFyIGhhc0tleSA9IGV4cG9ydHMuaGFzS2V5ID0gYmluYXJ5RnVuYygnaGFzS2V5Jyk7XG52YXIgZmluZCA9IGV4cG9ydHMuZmluZCA9IGJpbmFyeUZ1bmMoJ2ZpbmQnKTtcbnZhciBudGggPSBleHBvcnRzLm50aCA9IGJpbmFyeUZ1bmMoJ250aCcpO1xudmFyIGxhc3QgPSBleHBvcnRzLmxhc3QgPSB1bmFyeUZ1bmMoJ2xhc3QnKTtcbnZhciBhc3NvY0luID0gZXhwb3J0cy5hc3NvY0luID0gdGVybmFyeUZ1bmMoJ2Fzc29jSW4nKTtcbnZhciB1cGRhdGVJbiA9IGV4cG9ydHMudXBkYXRlSW4gPSB0ZXJuYXJ5RnVuYygndXBkYXRlSW4nKTtcbnZhciBjb3VudCA9IGV4cG9ydHMuY291bnQgPSB1bmFyeUZ1bmMoJ2NvdW50Jyk7XG52YXIgaXNFbXB0eSA9IGV4cG9ydHMuaXNFbXB0eSA9IHVuYXJ5RnVuYygnaXNFbXB0eScpO1xudmFyIHBlZWsgPSBleHBvcnRzLnBlZWsgPSB1bmFyeUZ1bmMoJ3BlZWsnKTtcbnZhciBwb3AgPSBleHBvcnRzLnBvcCA9IHVuYXJ5RnVuYygncG9wJyk7XG52YXIgemlwbWFwID0gZXhwb3J0cy56aXBtYXAgPSBiaW5hcnlGdW5jKCd6aXBtYXAnKTtcbnZhciByZXZlcnNlID0gZXhwb3J0cy5yZXZlcnNlID0gdW5hcnlGdW5jKCdyZXZlcnNlJyk7XG4vLyAtLVxuXG4vLyBWZWN0b3IgT3BlcmF0aW9uc1xudmFyIHN1YnZlYyA9IGV4cG9ydHMuc3VidmVjID0gdGVybmFyeUZ1bmMoJ3N1YnZlYycpO1xuLy8gLS1cblxuLy8gSGFzaCBNYXAgT3BlcmF0aW9uc1xudmFyIGtleXMgPSBleHBvcnRzLmtleXMgPSB1bmFyeUZ1bmMoJ2tleXMnKTtcbnZhciB2YWxzID0gZXhwb3J0cy52YWxzID0gdW5hcnlGdW5jKCd2YWxzJyk7XG52YXIgbWVyZ2UgPSBleHBvcnRzLm1lcmdlID0gdmFyaWFkaWNGdW5jKCdtZXJnZScpO1xuLy8gLS1cblxuLy8gU2V0IE9wZXJhdGlvbnNcbnZhciBkaXNqID0gZXhwb3J0cy5kaXNqID0gYmluYXJ5RnVuYygnZGlzaicpO1xudmFyIHVuaW9uID0gZXhwb3J0cy51bmlvbiA9IHZhcmlhZGljRnVuYygndW5pb24nKTtcbnZhciBpbnRlcnNlY3Rpb24gPSBleHBvcnRzLmludGVyc2VjdGlvbiA9IHZhcmlhZGljRnVuYygnaW50ZXJzZWN0aW9uJyk7XG52YXIgZGlmZmVyZW5jZSA9IGV4cG9ydHMuZGlmZmVyZW5jZSA9IHZhcmlhZGljRnVuYygnZGlmZmVyZW5jZScpO1xudmFyIGlzU3Vic2V0ID0gZXhwb3J0cy5pc1N1YnNldCA9IGJpbmFyeUZ1bmMoJ2lzU3Vic2V0Jyk7XG52YXIgaXNTdXBlcnNldCA9IGV4cG9ydHMuaXNTdXBlcnNldCA9IGJpbmFyeUZ1bmMoJ2lzU3VwZXJzZXQnKTtcbi8vIC0tXG5cbi8vIFNlcXVlbmNlc1xudmFyIGZpcnN0ID0gZXhwb3J0cy5maXJzdCA9IHVuYXJ5RnVuYygnZmlyc3QnKTtcbnZhciByZXN0ID0gZXhwb3J0cy5yZXN0ID0gdW5hcnlGdW5jKCdyZXN0Jyk7XG52YXIgc2VxID0gZXhwb3J0cy5zZXEgPSB1bmFyeUZ1bmMoJ3NlcScpO1xuXG4vLyB2YWwgZmlyc3Rcbi8vIDE6OmNvbnMobW9yaS52ZWN0b3IoMiwgMykpXG52YXIgY29ucyA9IGV4cG9ydHMuY29ucyA9IGJpbmFyeUZ1bmMoJ2NvbnMnKTtcblxuLy8gZnVuY3Rpb24gZmlyc3Rcbi8vIG1vcmkucmFuZ2UoMyk6OmNvbmNhdChbMywgNCwgNV0pXG52YXIgY29uY2F0ID0gZXhwb3J0cy5jb25jYXQgPSB2YXJpYWRpY0Z1bmMoJ2NvbmNhdCcpO1xuXG52YXIgZmxhdHRlbiA9IGV4cG9ydHMuZmxhdHRlbiA9IHVuYXJ5RnVuYygnZmxhdHRlbicpO1xudmFyIGludG9BcnJheSA9IGV4cG9ydHMuaW50b0FycmF5ID0gdW5hcnlGdW5jKCdpbnRvQXJyYXknKTtcbnZhciBlYWNoID0gZXhwb3J0cy5lYWNoID0gYmluYXJ5RnVuYygnZWFjaCcpO1xuXG4vLyBmdW5jdGlvbiBmaXJzdFxuLy8gbW9yaS5pbmM6Om1hcChbMCwgMSwgMl0pIC8vID0+ICgxLCAyLCAzKVxudmFyIG1hcCA9IGV4cG9ydHMubWFwID0gdmFyaWFkaWNGdW5jKCdtYXAnKTtcblxuLy8gZnVuY3Rpb24gZmlyc3Rcbi8vICgoeCwgeSkgPT4gbW9yaS5saXN0KHgsIHggKyB5KSk6Om1hcGNhdChtb3JpLnNlcSgnYWJjJyksIG1vcmkuc2VxKCcxMjMnKSk7XG52YXIgbWFwY2F0ID0gZXhwb3J0cy5tYXBjYXQgPSB2YXJpYWRpY0Z1bmMoJ21hcGNhdCcpO1xuXG52YXIgZmlsdGVyID0gZXhwb3J0cy5maWx0ZXIgPSBiaW5hcnlGdW5jKCdmaWx0ZXInLCB0cnVlKTtcbnZhciByZW1vdmUgPSBleHBvcnRzLnJlbW92ZSA9IGJpbmFyeUZ1bmMoJ3JlbW92ZScsIHRydWUpO1xuXG4vLyBmdW5jdGlvbiBmaXJzdCAtPiBzcGVjaWFsXG52YXIgcmVkdWNlID0gZXhwb3J0cy5yZWR1Y2UgPSBmdW5jdGlvbiByZWR1Y2UoZnVuYywgaW5pdGlhbCkge1xuICByZXR1cm4gX21vcmkyLmRlZmF1bHQucmVkdWNlKGZ1bmMsIGluaXRpYWwsIHRoaXMpO1xufTtcblxuLy8gZnVuY3Rpb24gZmlyc3RcbnZhciByZWR1Y2VLViA9IGV4cG9ydHMucmVkdWNlS1YgPSBmdW5jdGlvbiByZWR1Y2VLVihmdW5jLCBpbml0aWFsKSB7XG4gIHJldHVybiBfbW9yaTIuZGVmYXVsdC5yZWR1Y2VLVihmdW5jLCBpbml0aWFsLCB0aGlzKTtcbn07XG5cbnZhciB0YWtlID0gZXhwb3J0cy50YWtlID0gYmluYXJ5RnVuYygndGFrZScsIHRydWUpO1xudmFyIHRha2VXaGlsZSA9IGV4cG9ydHMudGFrZVdoaWxlID0gYmluYXJ5RnVuYygndGFrZVdoaWxlJywgdHJ1ZSk7XG52YXIgZHJvcCA9IGV4cG9ydHMuZHJvcCA9IGJpbmFyeUZ1bmMoJ2Ryb3AnLCB0cnVlKTtcbnZhciBkcm9wV2hpbGUgPSBleHBvcnRzLmRyb3BXaGlsZSA9IGJpbmFyeUZ1bmMoJ2Ryb3BXaGlsZScsIHRydWUpO1xudmFyIHNvbWUgPSBleHBvcnRzLnNvbWUgPSBiaW5hcnlGdW5jKCdzb21lJywgdHJ1ZSk7XG52YXIgZXZlcnkgPSBleHBvcnRzLmV2ZXJ5ID0gYmluYXJ5RnVuYygnZXZlcnknLCB0cnVlKTtcblxuLy8gb3B0aW9uYWwgZnVuY3Rpb24gZmlyc3RcbnZhciBzb3J0ID0gZXhwb3J0cy5zb3J0ID0gZnVuY3Rpb24gc29ydChjbXApIHtcbiAgcmV0dXJuIGNtcCA/IF9tb3JpMi5kZWZhdWx0LnNvcnQoY21wLCB0aGlzKSA6IF9tb3JpMi5kZWZhdWx0LnNvcnQodGhpcyk7XG59O1xuXG4vLyBmdW5jdGlvbiBmaXJzdCwgb3B0aW9uYWwgc2Vjb25kIHBhcmFtZXRlciwgY29sbFxudmFyIHNvcnRCeSA9IGV4cG9ydHMuc29ydEJ5ID0gZnVuY3Rpb24gc29ydEJ5KGtleUZuLCBjbXApIHtcbiAgcmV0dXJuIGNtcCA/IF9tb3JpMi5kZWZhdWx0LnNvcnRCeShrZXlGbiwgY21wLCB0aGlzKSA6IF9tb3JpMi5kZWZhdWx0LnNvcnRCeShrZXlGbiwgdGhpcyk7XG59O1xudmFyIGludGVycG9zZSA9IGV4cG9ydHMuaW50ZXJwb3NlID0gYmluYXJ5RnVuYygnaW50ZXJwb3NlJywgdHJ1ZSk7XG52YXIgaW50ZXJsZWF2ZSA9IGV4cG9ydHMuaW50ZXJsZWF2ZSA9IHZhcmlhZGljRnVuYygnaW50ZXJsZWF2ZScpO1xuXG4vLyBmdW5jdGlvbiBmaXJzdFxudmFyIGl0ZXJhdGUgPSBleHBvcnRzLml0ZXJhdGUgPSBiaW5hcnlGdW5jKCdpdGVyYXRlJyk7XG5cbi8vIHZhbCBmaXJzdCwgZmlyc3QgcGFyYW0gb3B0aW9uYWxcbi8vIHNpbmNlIGZpcnN0IHBhcmFtIGlzIG9wdGlvbmFsLCB3ZSBoYXZlIHRvIGRvIGl0IGRpZmZlcmVudGx5XG4vLyAnZm9vJzo6cmVwZWF0KCkgLy8gbW9yaS5yZXBlYXQoJ2ZvbycsIHZvaWQpXG4vLyAnZm9vJzo6cmVwZWF0KDUpIC8vIG1vcmkucmVwZWF0KDUsICdmb28nKVxudmFyIHJlcGVhdCA9IGV4cG9ydHMucmVwZWF0ID0gZnVuY3Rpb24gbXJlcGVhdChwKSB7XG4gIHJldHVybiBwID8gX21vcmkyLmRlZmF1bHQucmVwZWF0KHAsIHRoaXMpIDogX21vcmkyLmRlZmF1bHQucmVwZWF0KHRoaXMpO1xufTtcblxuLy8gZnVuY3Rpb24gZmlyc3QsIGZpcnN0IHBhcmFtIG9wdGlvbmFsXG4vLyBzaW5jZSBmaXJzdCBwYXJhbSBpcyBvcHRpb25hbCwgd2UgaGF2ZSB0byBkbyBpdCBkaWZmZXJlbnRseVxudmFyIHJlcGVhdGVkbHkgPSBleHBvcnRzLnJlcGVhdGVkbHkgPSBmdW5jdGlvbiBtcmVwZWF0ZWRseShwKSB7XG4gIHJldHVybiBwID8gX21vcmkyLmRlZmF1bHQucmVwZWF0ZWRseShwLCB0aGlzKSA6IF9tb3JpMi5kZWZhdWx0LnJlcGVhdGVkbHkodGhpcyk7XG59O1xuXG52YXIgcGFydGl0aW9uID0gZXhwb3J0cy5wYXJ0aXRpb24gPSB2YXJpYWRpY0Z1bmMoJ3BhcnRpdGlvbicsIHRydWUpO1xudmFyIHBhcnRpdGlvbkJ5ID0gZXhwb3J0cy5wYXJ0aXRpb25CeSA9IGJpbmFyeUZ1bmMoJ3BhcnRpdGlvbkJ5JywgdHJ1ZSk7XG52YXIgZ3JvdXBCeSA9IGV4cG9ydHMuZ3JvdXBCeSA9IGJpbmFyeUZ1bmMoJ2dyb3VwQnknLCB0cnVlKTtcbi8vIC0tXG5cbi8vIEhlbHBlcnNcbnZhciBwcmltU2VxID0gZXhwb3J0cy5wcmltU2VxID0gdmFyaWFkaWNGdW5jKCdwcmltU2VxJyk7XG52YXIgaWRlbnRpdHkgPSBleHBvcnRzLmlkZW50aXR5ID0gdW5hcnlGdW5jKCdpZGVudGl0eScpO1xudmFyIGNvbnN0YW50bHkgPSBleHBvcnRzLmNvbnN0YW50bHkgPSB1bmFyeUZ1bmMoJ2NvbnN0YW50bHknKTtcbnZhciBpbmMgPSBleHBvcnRzLmluYyA9IHVuYXJ5RnVuYygnaW5jJyk7XG52YXIgZGVjID0gZXhwb3J0cy5kZWMgPSB1bmFyeUZ1bmMoJ2RlYycpO1xudmFyIHN1bSA9IGV4cG9ydHMuc3VtID0gYmluYXJ5RnVuYygnc3VtJyk7XG52YXIgaXNFdmVuID0gZXhwb3J0cy5pc0V2ZW4gPSB1bmFyeUZ1bmMoJ2lzRXZlbicpO1xudmFyIGlzT2RkID0gZXhwb3J0cy5pc09kZCA9IHVuYXJ5RnVuYygnaXNPZGQnKTtcbnZhciBjb21wID0gZXhwb3J0cy5jb21wID0gYmluYXJ5RnVuYygnY29tcCcpO1xudmFyIGp1eHQgPSBleHBvcnRzLmp1eHQgPSB2YXJpYWRpY0Z1bmMoJ2p1eHQnKTtcbnZhciBrbml0ID0gZXhwb3J0cy5rbml0ID0gdmFyaWFkaWNGdW5jKCdrbml0Jyk7XG52YXIgcGlwZWxpbmUgPSBleHBvcnRzLnBpcGVsaW5lID0gdmFyaWFkaWNGdW5jKCdwaXBlbGluZScpO1xudmFyIHBhcnRpYWwgPSBleHBvcnRzLnBhcnRpYWwgPSB2YXJpYWRpY0Z1bmMoJ3BhcnRpYWwnKTtcbnZhciBjdXJyeSA9IGV4cG9ydHMuY3VycnkgPSB2YXJpYWRpY0Z1bmMoJ2N1cnJ5Jyk7XG52YXIgZm5pbCA9IGV4cG9ydHMuZm5pbCA9IHRlcm5hcnlGdW5jKCdmbmlsJyk7XG52YXIgdG9DbGogPSBleHBvcnRzLnRvQ2xqID0gdW5hcnlGdW5jKCd0b0NsaicpO1xudmFyIHRvSnMgPSBleHBvcnRzLnRvSnMgPSB1bmFyeUZ1bmMoJ3RvSnMnKTtcbi8vIC0tIiwiY29uc3QgZXh0cmEgPSB7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IGV4dHJhO1xuIiwiLyoqXG4gTWl4ZXMgaW4gbW9yaS1leHQgaW50byB0aGUgcHJvdG90eXBlcyBvZiBhbGwgb2YgdGhlIGNvbGxlY3Rpb25zXG4gdGhhdCBtb3JpIGV4cG9zZXMuXG5cbiBUaGlzIGlzIGtpbmQgb2YgYmFkLCBzaW5jZSBpdCBnb2VzIGFnYWluc3Qgb25lIG9mIHRoZSBmdW5kYW1lbnRhbFxuIGRvZ21hcyBpbiBtb3JpLCBidXQgaXQgbWFrZXMgZm9yIGEgZGlmZmVyZW50IGNvZGluZyBzdHlsZSwgd2hpY2hcbiBtYXkgYXBwZWFsIHRvIHNvbWUuXG4gKi9cbmNvbnN0IGV4dCA9IHJlcXVpcmUoJ21vcmktZXh0Jyk7XG5cbi8vIGNvbXBhdGliaWxpdHkgd2l0aCBtZXRob2QgdHlwZSBpbnZvY2F0aW9ucyxcbi8vIGUuZy4gYG1hcGAgd2hpY2ggaW4gbW9yaS1leHQgZXhwZWN0cyBgdGhpc2Bcbi8vIHRvIGJlIGEgYGZ1bmN0aW9uYCwgd2hlcmVhcyBpbiBtb3JpLWZsdWVudFxuLy8gYHRoaXNgIGluIGBtYXBgIHNob3VsZCBiZSBhIGNvbGxlY3Rpb25cbi8vIGBtYXBgLCBgY29uc2BcbmNvbnN0IGNvbXBhdCA9IGZ1bmN0aW9uIChtb3JpKSB7XG4gIHJldHVybiB7XG4gICAgLyoqXG4gICAgIEBleGFtcGxlXG4gICAgIGBtb3JpLnZlY3RvcigxLCAyLCAzKS5tYXAobW9yaS5pbmMpOyAvLyA9PiAoMiAzIDQpYFxuICAgICAqL1xuICAgIG1hcDogZnVuY3Rpb24gbW9yaUZsdWVudF9tYXAoZm4pIHtcbiAgICAgIHJldHVybiBtb3JpLm1hcChmbiwgdGhpcyk7XG4gICAgfSxcbiAgICAvKipcbiAgICAgQGV4YW1wbGVcbiAgICAgYG1vcmkudmVjdG9yKDEsIDIpLm1hcEtWKG1vcmkudmVjdG9yKTsgLy8gPT4gKFswIDFdIFsxIDJdKWBcbiAgICAgKi9cbiAgICBtYXBLVjogZnVuY3Rpb24gbW9yaUZsdWVudF9tYXBLVihmbikge1xuICAgICAgcmV0dXJuIHRoaXNcbiAgICAgICAgLnJlZHVjZUtWKChhY2MsIGssIHYpID0+IGFjYy5jb25qKGZuKGssIHYpKSxcbiAgICAgICAgICAgICAgICAgIG1vcmkudmVjdG9yKCkpXG4gICAgICAgIC50YWtlKHRoaXMuY291bnQoKSk7XG4gICAgfSxcbiAgICByZWR1Y2U6IGZ1bmN0aW9uIG1vcmlGbHVlbnRfcmVkdWNlKGZuLCBpbml0aWFsKSB7XG4gICAgICByZXR1cm4gaW5pdGlhbCA/XG4gICAgICAgIG1vcmkucmVkdWNlKGZuLCBpbml0aWFsLCB0aGlzKSA6XG4gICAgICAgIG1vcmkucmVkdWNlKGZuLCB0aGlzKTtcbiAgICB9LFxuICAgIHJlZHVjZUtWOiBmdW5jdGlvbiBtb3JpRmx1ZW50X3JlZHVjZUtWKGZuLCBpbml0aWFsKSB7XG4gICAgICByZXR1cm4gaW5pdGlhbCA/XG4gICAgICAgIG1vcmkucmVkdWNlS1YoZm4sIGluaXRpYWwsIHRoaXMpIDpcbiAgICAgICAgbW9yaS5yZWR1Y2VLVihmbiwgdGhpcyk7XG4gICAgfSxcbiAgICAvKipcbiAgICAgQGV4YW1wbGVcbiAgICAgYG1vcmkudmVjdG9yKDIsIDMpLmNvbnMoMSk7IC8vID0+IFsxIDIgM11gXG4gICAgICovXG4gICAgY29uczogZnVuY3Rpb24gbW9yaUZsdWVudF9jb25zKHZhbHVlKSB7XG4gICAgICBtb3JpLmNvbnModmFsdWUsIHRoaXMpO1xuICAgIH1cbiAgfTtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gKG1vcmksIC4uLmV4dHJhTWl4aW5zKSB7XG4gIGNvbnN0IHByb3RvcyA9IFtcbiAgICAvLyBiYXNpYyBjb2xsZWN0aW9uc1xuICAgIG1vcmkubGlzdCgpLFxuICAgIG1vcmkudmVjdG9yKCksXG4gICAgbW9yaS5oYXNoTWFwKCksXG4gICAgbW9yaS5zZXQoKSxcbiAgICBtb3JpLnNvcnRlZFNldCgpLFxuICAgIG1vcmkucmFuZ2UoKSxcbiAgICBtb3JpLnF1ZXVlKCksXG5cbiAgICAvLyBzcGVjaWFsIGNhc2VzXG4gICAgbW9yaS5zZXEoWzBdKSxcbiAgICBtb3JpLnByaW1TZXEoWzBdKSxcbiAgICBtb3JpLm1hcChtb3JpLmlkZW50aXR5LCBbMF0pLFxuICBdLm1hcChjb2xsID0+IGNvbGwuY29uc3RydWN0b3IucHJvdG90eXBlKTtcblxuICBwcm90b3MuZm9yRWFjaChwcm90byA9PiB7XG4gICAgT2JqZWN0LmtleXMoZXh0KS5mb3JFYWNoKGsgPT4ge1xuICAgICAgcHJvdG9ba10gPSBleHRba107XG4gICAgfSk7XG5cbiAgICAvLyB1cGRhdGUgdGhlIHByb3RvdHlwZXMgd2l0aCB0aGUgY29tcGF0IGxheWVyLlxuICAgIGNvbnN0IGNvbXBhdExheWVyID0gY29tcGF0KG1vcmkpO1xuICAgIE9iamVjdC5rZXlzKGNvbXBhdExheWVyKS5mb3JFYWNoKGsgPT4ge1xuICAgICAgcHJvdG9ba10gPSBjb21wYXRMYXllcltrXTtcbiAgICB9KTtcblxuICAgIC8vIHVwZGF0ZSB0aGUgcHJvdG90eXBlcyB3aXRoIGV4dHJhc1xuICAgIGV4dHJhTWl4aW5zLmZvckVhY2gobWl4aW4gPT4ge1xuICAgICAgT2JqZWN0LmtleXMobWl4aW4pLmZvckVhY2goayA9PiB7XG4gICAgICAgIHByb3RvW2tdID0gbWl4aW5ba107XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgcmV0dXJuIG1vcmk7XG59O1xuIiwiKGZ1bmN0aW9uKGRlZmluaXRpb24pe2lmKHR5cGVvZiBleHBvcnRzPT09XCJvYmplY3RcIil7bW9kdWxlLmV4cG9ydHM9ZGVmaW5pdGlvbigpO31lbHNlIGlmKHR5cGVvZiBkZWZpbmU9PT1cImZ1bmN0aW9uXCImJmRlZmluZS5hbWQpe2RlZmluZShkZWZpbml0aW9uKTt9ZWxzZXttb3JpPWRlZmluaXRpb24oKTt9fSkoZnVuY3Rpb24oKXtyZXR1cm4gZnVuY3Rpb24oKXtcbmlmKHR5cGVvZiBNYXRoLmltdWwgPT0gXCJ1bmRlZmluZWRcIiB8fCAoTWF0aC5pbXVsKDB4ZmZmZmZmZmYsNSkgPT0gMCkpIHtcbiAgICBNYXRoLmltdWwgPSBmdW5jdGlvbiAoYSwgYikge1xuICAgICAgICB2YXIgYWggID0gKGEgPj4+IDE2KSAmIDB4ZmZmZjtcbiAgICAgICAgdmFyIGFsID0gYSAmIDB4ZmZmZjtcbiAgICAgICAgdmFyIGJoICA9IChiID4+PiAxNikgJiAweGZmZmY7XG4gICAgICAgIHZhciBibCA9IGIgJiAweGZmZmY7XG4gICAgICAgIC8vIHRoZSBzaGlmdCBieSAwIGZpeGVzIHRoZSBzaWduIG9uIHRoZSBoaWdoIHBhcnRcbiAgICAgICAgLy8gdGhlIGZpbmFsIHwwIGNvbnZlcnRzIHRoZSB1bnNpZ25lZCB2YWx1ZSBpbnRvIGEgc2lnbmVkIHZhbHVlXG4gICAgICAgIHJldHVybiAoKGFsICogYmwpICsgKCgoYWggKiBibCArIGFsICogYmgpIDw8IDE2KSA+Pj4gMCl8MCk7XG4gICAgfVxufVxuXG52YXIgayxhYT10aGlzO1xuZnVuY3Rpb24gbihhKXt2YXIgYj10eXBlb2YgYTtpZihcIm9iamVjdFwiPT1iKWlmKGEpe2lmKGEgaW5zdGFuY2VvZiBBcnJheSlyZXR1cm5cImFycmF5XCI7aWYoYSBpbnN0YW5jZW9mIE9iamVjdClyZXR1cm4gYjt2YXIgYz1PYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwoYSk7aWYoXCJbb2JqZWN0IFdpbmRvd11cIj09YylyZXR1cm5cIm9iamVjdFwiO2lmKFwiW29iamVjdCBBcnJheV1cIj09Y3x8XCJudW1iZXJcIj09dHlwZW9mIGEubGVuZ3RoJiZcInVuZGVmaW5lZFwiIT10eXBlb2YgYS5zcGxpY2UmJlwidW5kZWZpbmVkXCIhPXR5cGVvZiBhLnByb3BlcnR5SXNFbnVtZXJhYmxlJiYhYS5wcm9wZXJ0eUlzRW51bWVyYWJsZShcInNwbGljZVwiKSlyZXR1cm5cImFycmF5XCI7aWYoXCJbb2JqZWN0IEZ1bmN0aW9uXVwiPT1jfHxcInVuZGVmaW5lZFwiIT10eXBlb2YgYS5jYWxsJiZcInVuZGVmaW5lZFwiIT10eXBlb2YgYS5wcm9wZXJ0eUlzRW51bWVyYWJsZSYmIWEucHJvcGVydHlJc0VudW1lcmFibGUoXCJjYWxsXCIpKXJldHVyblwiZnVuY3Rpb25cIn1lbHNlIHJldHVyblwibnVsbFwiO2Vsc2UgaWYoXCJmdW5jdGlvblwiPT1cbmImJlwidW5kZWZpbmVkXCI9PXR5cGVvZiBhLmNhbGwpcmV0dXJuXCJvYmplY3RcIjtyZXR1cm4gYn12YXIgYmE9XCJjbG9zdXJlX3VpZF9cIisoMUU5Kk1hdGgucmFuZG9tKCk+Pj4wKSxjYT0wO2Z1bmN0aW9uIHIoYSxiKXt2YXIgYz1hLnNwbGl0KFwiLlwiKSxkPWFhO2NbMF1pbiBkfHwhZC5leGVjU2NyaXB0fHxkLmV4ZWNTY3JpcHQoXCJ2YXIgXCIrY1swXSk7Zm9yKHZhciBlO2MubGVuZ3RoJiYoZT1jLnNoaWZ0KCkpOyljLmxlbmd0aHx8dm9pZCAwPT09Yj9kPWRbZV0/ZFtlXTpkW2VdPXt9OmRbZV09Yn07ZnVuY3Rpb24gZGEoYSl7cmV0dXJuIEFycmF5LnByb3RvdHlwZS5qb2luLmNhbGwoYXJndW1lbnRzLFwiXCIpfTtmdW5jdGlvbiBlYShhLGIpe2Zvcih2YXIgYyBpbiBhKWIuY2FsbCh2b2lkIDAsYVtjXSxjLGEpfTtmdW5jdGlvbiBmYShhLGIpe251bGwhPWEmJnRoaXMuYXBwZW5kLmFwcGx5KHRoaXMsYXJndW1lbnRzKX1mYS5wcm90b3R5cGUuWmE9XCJcIjtmYS5wcm90b3R5cGUuYXBwZW5kPWZ1bmN0aW9uKGEsYixjKXt0aGlzLlphKz1hO2lmKG51bGwhPWIpZm9yKHZhciBkPTE7ZDxhcmd1bWVudHMubGVuZ3RoO2QrKyl0aGlzLlphKz1hcmd1bWVudHNbZF07cmV0dXJuIHRoaXN9O2ZhLnByb3RvdHlwZS5jbGVhcj1mdW5jdGlvbigpe3RoaXMuWmE9XCJcIn07ZmEucHJvdG90eXBlLnRvU3RyaW5nPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuWmF9O2Z1bmN0aW9uIGdhKGEsYil7YS5zb3J0KGJ8fGhhKX1mdW5jdGlvbiBpYShhLGIpe2Zvcih2YXIgYz0wO2M8YS5sZW5ndGg7YysrKWFbY109e2luZGV4OmMsdmFsdWU6YVtjXX07dmFyIGQ9Ynx8aGE7Z2EoYSxmdW5jdGlvbihhLGIpe3JldHVybiBkKGEudmFsdWUsYi52YWx1ZSl8fGEuaW5kZXgtYi5pbmRleH0pO2ZvcihjPTA7YzxhLmxlbmd0aDtjKyspYVtjXT1hW2NdLnZhbHVlfWZ1bmN0aW9uIGhhKGEsYil7cmV0dXJuIGE+Yj8xOmE8Yj8tMTowfTt2YXIgamE7aWYoXCJ1bmRlZmluZWRcIj09PXR5cGVvZiBrYSl2YXIga2E9ZnVuY3Rpb24oKXt0aHJvdyBFcnJvcihcIk5vICpwcmludC1mbiogZm4gc2V0IGZvciBldmFsdWF0aW9uIGVudmlyb25tZW50XCIpO307dmFyIGxhPW51bGwsbWE9bnVsbDtpZihcInVuZGVmaW5lZFwiPT09dHlwZW9mIG5hKXZhciBuYT1udWxsO2Z1bmN0aW9uIG9hKCl7cmV0dXJuIG5ldyBwYShudWxsLDUsW3NhLCEwLHVhLCEwLHdhLCExLHlhLCExLHphLGxhXSxudWxsKX1mdW5jdGlvbiB0KGEpe3JldHVybiBudWxsIT1hJiYhMSE9PWF9ZnVuY3Rpb24gQWEoYSl7cmV0dXJuIHQoYSk/ITE6ITB9ZnVuY3Rpb24gdyhhLGIpe3JldHVybiBhW24obnVsbD09Yj9udWxsOmIpXT8hMDphLl8/ITA6ITF9ZnVuY3Rpb24gQmEoYSl7cmV0dXJuIG51bGw9PWE/bnVsbDphLmNvbnN0cnVjdG9yfVxuZnVuY3Rpb24geChhLGIpe3ZhciBjPUJhKGIpLGM9dCh0KGMpP2MuWWI6Yyk/Yy5YYjpuKGIpO3JldHVybiBFcnJvcihbXCJObyBwcm90b2NvbCBtZXRob2QgXCIsYSxcIiBkZWZpbmVkIGZvciB0eXBlIFwiLGMsXCI6IFwiLGJdLmpvaW4oXCJcIikpfWZ1bmN0aW9uIERhKGEpe3ZhciBiPWEuWGI7cmV0dXJuIHQoYik/YjpcIlwiK3ooYSl9dmFyIEVhPVwidW5kZWZpbmVkXCIhPT10eXBlb2YgU3ltYm9sJiZcImZ1bmN0aW9uXCI9PT1uKFN5bWJvbCk/U3ltYm9sLkNjOlwiQEBpdGVyYXRvclwiO2Z1bmN0aW9uIEZhKGEpe2Zvcih2YXIgYj1hLmxlbmd0aCxjPUFycmF5KGIpLGQ9MDs7KWlmKGQ8YiljW2RdPWFbZF0sZCs9MTtlbHNlIGJyZWFrO3JldHVybiBjfWZ1bmN0aW9uIEhhKGEpe2Zvcih2YXIgYj1BcnJheShhcmd1bWVudHMubGVuZ3RoKSxjPTA7OylpZihjPGIubGVuZ3RoKWJbY109YXJndW1lbnRzW2NdLGMrPTE7ZWxzZSByZXR1cm4gYn1cbnZhciBJYT1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiKXtmdW5jdGlvbiBjKGEsYil7YS5wdXNoKGIpO3JldHVybiBhfXZhciBnPVtdO3JldHVybiBBLmM/QS5jKGMsZyxiKTpBLmNhbGwobnVsbCxjLGcsYil9ZnVuY3Rpb24gYihhKXtyZXR1cm4gYy5hKG51bGwsYSl9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGQsYyl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYi5jYWxsKHRoaXMsZCk7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcywwLGMpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmI9YjtjLmE9YTtyZXR1cm4gY30oKSxKYT17fSxMYT17fTtmdW5jdGlvbiBNYShhKXtpZihhP2EuTDphKXJldHVybiBhLkwoYSk7dmFyIGI7Yj1NYVtuKG51bGw9PWE/bnVsbDphKV07aWYoIWImJihiPU1hLl8sIWIpKXRocm93IHgoXCJJQ291bnRlZC4tY291bnRcIixhKTtyZXR1cm4gYi5jYWxsKG51bGwsYSl9XG5mdW5jdGlvbiBOYShhKXtpZihhP2EuSjphKXJldHVybiBhLkooYSk7dmFyIGI7Yj1OYVtuKG51bGw9PWE/bnVsbDphKV07aWYoIWImJihiPU5hLl8sIWIpKXRocm93IHgoXCJJRW1wdHlhYmxlQ29sbGVjdGlvbi4tZW1wdHlcIixhKTtyZXR1cm4gYi5jYWxsKG51bGwsYSl9dmFyIFFhPXt9O2Z1bmN0aW9uIFJhKGEsYil7aWYoYT9hLkc6YSlyZXR1cm4gYS5HKGEsYik7dmFyIGM7Yz1SYVtuKG51bGw9PWE/bnVsbDphKV07aWYoIWMmJihjPVJhLl8sIWMpKXRocm93IHgoXCJJQ29sbGVjdGlvbi4tY29ualwiLGEpO3JldHVybiBjLmNhbGwobnVsbCxhLGIpfVxudmFyIFRhPXt9LEM9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjKXtpZihhP2EuJDphKXJldHVybiBhLiQoYSxiLGMpO3ZhciBnO2c9Q1tuKG51bGw9PWE/bnVsbDphKV07aWYoIWcmJihnPUMuXywhZykpdGhyb3cgeChcIklJbmRleGVkLi1udGhcIixhKTtyZXR1cm4gZy5jYWxsKG51bGwsYSxiLGMpfWZ1bmN0aW9uIGIoYSxiKXtpZihhP2EuUTphKXJldHVybiBhLlEoYSxiKTt2YXIgYztjPUNbbihudWxsPT1hP251bGw6YSldO2lmKCFjJiYoYz1DLl8sIWMpKXRocm93IHgoXCJJSW5kZXhlZC4tbnRoXCIsYSk7cmV0dXJuIGMuY2FsbChudWxsLGEsYil9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGQsYyxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiBiLmNhbGwodGhpcyxkLGMpO2Nhc2UgMzpyZXR1cm4gYS5jYWxsKHRoaXMsZCxjLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmE9YjtjLmM9YTtyZXR1cm4gY30oKSxcblVhPXt9O2Z1bmN0aW9uIFZhKGEpe2lmKGE/YS5OOmEpcmV0dXJuIGEuTihhKTt2YXIgYjtiPVZhW24obnVsbD09YT9udWxsOmEpXTtpZighYiYmKGI9VmEuXywhYikpdGhyb3cgeChcIklTZXEuLWZpcnN0XCIsYSk7cmV0dXJuIGIuY2FsbChudWxsLGEpfWZ1bmN0aW9uIFdhKGEpe2lmKGE/YS5TOmEpcmV0dXJuIGEuUyhhKTt2YXIgYjtiPVdhW24obnVsbD09YT9udWxsOmEpXTtpZighYiYmKGI9V2EuXywhYikpdGhyb3cgeChcIklTZXEuLXJlc3RcIixhKTtyZXR1cm4gYi5jYWxsKG51bGwsYSl9XG52YXIgWGE9e30sWmE9e30sJGE9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjKXtpZihhP2EuczphKXJldHVybiBhLnMoYSxiLGMpO3ZhciBnO2c9JGFbbihudWxsPT1hP251bGw6YSldO2lmKCFnJiYoZz0kYS5fLCFnKSl0aHJvdyB4KFwiSUxvb2t1cC4tbG9va3VwXCIsYSk7cmV0dXJuIGcuY2FsbChudWxsLGEsYixjKX1mdW5jdGlvbiBiKGEsYil7aWYoYT9hLnQ6YSlyZXR1cm4gYS50KGEsYik7dmFyIGM7Yz0kYVtuKG51bGw9PWE/bnVsbDphKV07aWYoIWMmJihjPSRhLl8sIWMpKXRocm93IHgoXCJJTG9va3VwLi1sb29rdXBcIixhKTtyZXR1cm4gYy5jYWxsKG51bGwsYSxiKX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIGIuY2FsbCh0aGlzLGMsZSk7Y2FzZSAzOnJldHVybiBhLmNhbGwodGhpcyxjLGUsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYT1iO2MuYz1cbmE7cmV0dXJuIGN9KCksYWI9e307ZnVuY3Rpb24gYmIoYSxiKXtpZihhP2EucmI6YSlyZXR1cm4gYS5yYihhLGIpO3ZhciBjO2M9YmJbbihudWxsPT1hP251bGw6YSldO2lmKCFjJiYoYz1iYi5fLCFjKSl0aHJvdyB4KFwiSUFzc29jaWF0aXZlLi1jb250YWlucy1rZXk/XCIsYSk7cmV0dXJuIGMuY2FsbChudWxsLGEsYil9ZnVuY3Rpb24gY2IoYSxiLGMpe2lmKGE/YS5LYTphKXJldHVybiBhLkthKGEsYixjKTt2YXIgZDtkPWNiW24obnVsbD09YT9udWxsOmEpXTtpZighZCYmKGQ9Y2IuXywhZCkpdGhyb3cgeChcIklBc3NvY2lhdGl2ZS4tYXNzb2NcIixhKTtyZXR1cm4gZC5jYWxsKG51bGwsYSxiLGMpfXZhciBkYj17fTtmdW5jdGlvbiBlYihhLGIpe2lmKGE/YS53YjphKXJldHVybiBhLndiKGEsYik7dmFyIGM7Yz1lYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWMmJihjPWViLl8sIWMpKXRocm93IHgoXCJJTWFwLi1kaXNzb2NcIixhKTtyZXR1cm4gYy5jYWxsKG51bGwsYSxiKX12YXIgZmI9e307XG5mdW5jdGlvbiBoYihhKXtpZihhP2EuaGI6YSlyZXR1cm4gYS5oYihhKTt2YXIgYjtiPWhiW24obnVsbD09YT9udWxsOmEpXTtpZighYiYmKGI9aGIuXywhYikpdGhyb3cgeChcIklNYXBFbnRyeS4ta2V5XCIsYSk7cmV0dXJuIGIuY2FsbChudWxsLGEpfWZ1bmN0aW9uIGliKGEpe2lmKGE/YS5pYjphKXJldHVybiBhLmliKGEpO3ZhciBiO2I9aWJbbihudWxsPT1hP251bGw6YSldO2lmKCFiJiYoYj1pYi5fLCFiKSl0aHJvdyB4KFwiSU1hcEVudHJ5Li12YWxcIixhKTtyZXR1cm4gYi5jYWxsKG51bGwsYSl9dmFyIGpiPXt9O2Z1bmN0aW9uIGtiKGEsYil7aWYoYT9hLkViOmEpcmV0dXJuIGEuRWIoYSxiKTt2YXIgYztjPWtiW24obnVsbD09YT9udWxsOmEpXTtpZighYyYmKGM9a2IuXywhYykpdGhyb3cgeChcIklTZXQuLWRpc2pvaW5cIixhKTtyZXR1cm4gYy5jYWxsKG51bGwsYSxiKX1cbmZ1bmN0aW9uIGxiKGEpe2lmKGE/YS5MYTphKXJldHVybiBhLkxhKGEpO3ZhciBiO2I9bGJbbihudWxsPT1hP251bGw6YSldO2lmKCFiJiYoYj1sYi5fLCFiKSl0aHJvdyB4KFwiSVN0YWNrLi1wZWVrXCIsYSk7cmV0dXJuIGIuY2FsbChudWxsLGEpfWZ1bmN0aW9uIG1iKGEpe2lmKGE/YS5NYTphKXJldHVybiBhLk1hKGEpO3ZhciBiO2I9bWJbbihudWxsPT1hP251bGw6YSldO2lmKCFiJiYoYj1tYi5fLCFiKSl0aHJvdyB4KFwiSVN0YWNrLi1wb3BcIixhKTtyZXR1cm4gYi5jYWxsKG51bGwsYSl9dmFyIG5iPXt9O2Z1bmN0aW9uIHBiKGEsYixjKXtpZihhP2EuVWE6YSlyZXR1cm4gYS5VYShhLGIsYyk7dmFyIGQ7ZD1wYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWQmJihkPXBiLl8sIWQpKXRocm93IHgoXCJJVmVjdG9yLi1hc3NvYy1uXCIsYSk7cmV0dXJuIGQuY2FsbChudWxsLGEsYixjKX1cbmZ1bmN0aW9uIHFiKGEpe2lmKGE/YS5SYTphKXJldHVybiBhLlJhKGEpO3ZhciBiO2I9cWJbbihudWxsPT1hP251bGw6YSldO2lmKCFiJiYoYj1xYi5fLCFiKSl0aHJvdyB4KFwiSURlcmVmLi1kZXJlZlwiLGEpO3JldHVybiBiLmNhbGwobnVsbCxhKX12YXIgcmI9e307ZnVuY3Rpb24gc2IoYSl7aWYoYT9hLkg6YSlyZXR1cm4gYS5IKGEpO3ZhciBiO2I9c2JbbihudWxsPT1hP251bGw6YSldO2lmKCFiJiYoYj1zYi5fLCFiKSl0aHJvdyB4KFwiSU1ldGEuLW1ldGFcIixhKTtyZXR1cm4gYi5jYWxsKG51bGwsYSl9dmFyIHRiPXt9O2Z1bmN0aW9uIHViKGEsYil7aWYoYT9hLkY6YSlyZXR1cm4gYS5GKGEsYik7dmFyIGM7Yz11YltuKG51bGw9PWE/bnVsbDphKV07aWYoIWMmJihjPXViLl8sIWMpKXRocm93IHgoXCJJV2l0aE1ldGEuLXdpdGgtbWV0YVwiLGEpO3JldHVybiBjLmNhbGwobnVsbCxhLGIpfVxudmFyIHZiPXt9LHdiPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyl7aWYoYT9hLk86YSlyZXR1cm4gYS5PKGEsYixjKTt2YXIgZztnPXdiW24obnVsbD09YT9udWxsOmEpXTtpZighZyYmKGc9d2IuXywhZykpdGhyb3cgeChcIklSZWR1Y2UuLXJlZHVjZVwiLGEpO3JldHVybiBnLmNhbGwobnVsbCxhLGIsYyl9ZnVuY3Rpb24gYihhLGIpe2lmKGE/YS5SOmEpcmV0dXJuIGEuUihhLGIpO3ZhciBjO2M9d2JbbihudWxsPT1hP251bGw6YSldO2lmKCFjJiYoYz13Yi5fLCFjKSl0aHJvdyB4KFwiSVJlZHVjZS4tcmVkdWNlXCIsYSk7cmV0dXJuIGMuY2FsbChudWxsLGEsYil9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiBiLmNhbGwodGhpcyxjLGUpO2Nhc2UgMzpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmE9YjtjLmM9YTtyZXR1cm4gY30oKTtcbmZ1bmN0aW9uIHhiKGEsYixjKXtpZihhP2EuZ2I6YSlyZXR1cm4gYS5nYihhLGIsYyk7dmFyIGQ7ZD14YltuKG51bGw9PWE/bnVsbDphKV07aWYoIWQmJihkPXhiLl8sIWQpKXRocm93IHgoXCJJS1ZSZWR1Y2UuLWt2LXJlZHVjZVwiLGEpO3JldHVybiBkLmNhbGwobnVsbCxhLGIsYyl9ZnVuY3Rpb24geWIoYSxiKXtpZihhP2EuQTphKXJldHVybiBhLkEoYSxiKTt2YXIgYztjPXliW24obnVsbD09YT9udWxsOmEpXTtpZighYyYmKGM9eWIuXywhYykpdGhyb3cgeChcIklFcXVpdi4tZXF1aXZcIixhKTtyZXR1cm4gYy5jYWxsKG51bGwsYSxiKX1mdW5jdGlvbiB6YihhKXtpZihhP2EuQjphKXJldHVybiBhLkIoYSk7dmFyIGI7Yj16YltuKG51bGw9PWE/bnVsbDphKV07aWYoIWImJihiPXpiLl8sIWIpKXRocm93IHgoXCJJSGFzaC4taGFzaFwiLGEpO3JldHVybiBiLmNhbGwobnVsbCxhKX12YXIgQmI9e307XG5mdW5jdGlvbiBDYihhKXtpZihhP2EuRDphKXJldHVybiBhLkQoYSk7dmFyIGI7Yj1DYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWImJihiPUNiLl8sIWIpKXRocm93IHgoXCJJU2VxYWJsZS4tc2VxXCIsYSk7cmV0dXJuIGIuY2FsbChudWxsLGEpfXZhciBEYj17fSxFYj17fSxGYj17fTtmdW5jdGlvbiBHYihhKXtpZihhP2EuYWI6YSlyZXR1cm4gYS5hYihhKTt2YXIgYjtiPUdiW24obnVsbD09YT9udWxsOmEpXTtpZighYiYmKGI9R2IuXywhYikpdGhyb3cgeChcIklSZXZlcnNpYmxlLi1yc2VxXCIsYSk7cmV0dXJuIGIuY2FsbChudWxsLGEpfWZ1bmN0aW9uIEhiKGEsYil7aWYoYT9hLkhiOmEpcmV0dXJuIGEuSGIoYSxiKTt2YXIgYztjPUhiW24obnVsbD09YT9udWxsOmEpXTtpZighYyYmKGM9SGIuXywhYykpdGhyb3cgeChcIklTb3J0ZWQuLXNvcnRlZC1zZXFcIixhKTtyZXR1cm4gYy5jYWxsKG51bGwsYSxiKX1cbmZ1bmN0aW9uIEliKGEsYixjKXtpZihhP2EuSWI6YSlyZXR1cm4gYS5JYihhLGIsYyk7dmFyIGQ7ZD1JYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWQmJihkPUliLl8sIWQpKXRocm93IHgoXCJJU29ydGVkLi1zb3J0ZWQtc2VxLWZyb21cIixhKTtyZXR1cm4gZC5jYWxsKG51bGwsYSxiLGMpfWZ1bmN0aW9uIEpiKGEsYil7aWYoYT9hLkdiOmEpcmV0dXJuIGEuR2IoYSxiKTt2YXIgYztjPUpiW24obnVsbD09YT9udWxsOmEpXTtpZighYyYmKGM9SmIuXywhYykpdGhyb3cgeChcIklTb3J0ZWQuLWVudHJ5LWtleVwiLGEpO3JldHVybiBjLmNhbGwobnVsbCxhLGIpfWZ1bmN0aW9uIEtiKGEpe2lmKGE/YS5GYjphKXJldHVybiBhLkZiKGEpO3ZhciBiO2I9S2JbbihudWxsPT1hP251bGw6YSldO2lmKCFiJiYoYj1LYi5fLCFiKSl0aHJvdyB4KFwiSVNvcnRlZC4tY29tcGFyYXRvclwiLGEpO3JldHVybiBiLmNhbGwobnVsbCxhKX1cbmZ1bmN0aW9uIExiKGEsYil7aWYoYT9hLldiOmEpcmV0dXJuIGEuV2IoMCxiKTt2YXIgYztjPUxiW24obnVsbD09YT9udWxsOmEpXTtpZighYyYmKGM9TGIuXywhYykpdGhyb3cgeChcIklXcml0ZXIuLXdyaXRlXCIsYSk7cmV0dXJuIGMuY2FsbChudWxsLGEsYil9dmFyIE1iPXt9O2Z1bmN0aW9uIE5iKGEsYixjKXtpZihhP2EudjphKXJldHVybiBhLnYoYSxiLGMpO3ZhciBkO2Q9TmJbbihudWxsPT1hP251bGw6YSldO2lmKCFkJiYoZD1OYi5fLCFkKSl0aHJvdyB4KFwiSVByaW50V2l0aFdyaXRlci4tcHItd3JpdGVyXCIsYSk7cmV0dXJuIGQuY2FsbChudWxsLGEsYixjKX1mdW5jdGlvbiBPYihhKXtpZihhP2EuJGE6YSlyZXR1cm4gYS4kYShhKTt2YXIgYjtiPU9iW24obnVsbD09YT9udWxsOmEpXTtpZighYiYmKGI9T2IuXywhYikpdGhyb3cgeChcIklFZGl0YWJsZUNvbGxlY3Rpb24uLWFzLXRyYW5zaWVudFwiLGEpO3JldHVybiBiLmNhbGwobnVsbCxhKX1cbmZ1bmN0aW9uIFBiKGEsYil7aWYoYT9hLlNhOmEpcmV0dXJuIGEuU2EoYSxiKTt2YXIgYztjPVBiW24obnVsbD09YT9udWxsOmEpXTtpZighYyYmKGM9UGIuXywhYykpdGhyb3cgeChcIklUcmFuc2llbnRDb2xsZWN0aW9uLi1jb25qIVwiLGEpO3JldHVybiBjLmNhbGwobnVsbCxhLGIpfWZ1bmN0aW9uIFFiKGEpe2lmKGE/YS5UYTphKXJldHVybiBhLlRhKGEpO3ZhciBiO2I9UWJbbihudWxsPT1hP251bGw6YSldO2lmKCFiJiYoYj1RYi5fLCFiKSl0aHJvdyB4KFwiSVRyYW5zaWVudENvbGxlY3Rpb24uLXBlcnNpc3RlbnQhXCIsYSk7cmV0dXJuIGIuY2FsbChudWxsLGEpfWZ1bmN0aW9uIFJiKGEsYixjKXtpZihhP2Eua2I6YSlyZXR1cm4gYS5rYihhLGIsYyk7dmFyIGQ7ZD1SYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWQmJihkPVJiLl8sIWQpKXRocm93IHgoXCJJVHJhbnNpZW50QXNzb2NpYXRpdmUuLWFzc29jIVwiLGEpO3JldHVybiBkLmNhbGwobnVsbCxhLGIsYyl9XG5mdW5jdGlvbiBTYihhLGIpe2lmKGE/YS5KYjphKXJldHVybiBhLkpiKGEsYik7dmFyIGM7Yz1TYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWMmJihjPVNiLl8sIWMpKXRocm93IHgoXCJJVHJhbnNpZW50TWFwLi1kaXNzb2MhXCIsYSk7cmV0dXJuIGMuY2FsbChudWxsLGEsYil9ZnVuY3Rpb24gVGIoYSxiLGMpe2lmKGE/YS5VYjphKXJldHVybiBhLlViKDAsYixjKTt2YXIgZDtkPVRiW24obnVsbD09YT9udWxsOmEpXTtpZighZCYmKGQ9VGIuXywhZCkpdGhyb3cgeChcIklUcmFuc2llbnRWZWN0b3IuLWFzc29jLW4hXCIsYSk7cmV0dXJuIGQuY2FsbChudWxsLGEsYixjKX1mdW5jdGlvbiBVYihhKXtpZihhP2EuVmI6YSlyZXR1cm4gYS5WYigpO3ZhciBiO2I9VWJbbihudWxsPT1hP251bGw6YSldO2lmKCFiJiYoYj1VYi5fLCFiKSl0aHJvdyB4KFwiSVRyYW5zaWVudFZlY3Rvci4tcG9wIVwiLGEpO3JldHVybiBiLmNhbGwobnVsbCxhKX1cbmZ1bmN0aW9uIFZiKGEsYil7aWYoYT9hLlRiOmEpcmV0dXJuIGEuVGIoMCxiKTt2YXIgYztjPVZiW24obnVsbD09YT9udWxsOmEpXTtpZighYyYmKGM9VmIuXywhYykpdGhyb3cgeChcIklUcmFuc2llbnRTZXQuLWRpc2pvaW4hXCIsYSk7cmV0dXJuIGMuY2FsbChudWxsLGEsYil9ZnVuY3Rpb24gWGIoYSl7aWYoYT9hLlBiOmEpcmV0dXJuIGEuUGIoKTt2YXIgYjtiPVhiW24obnVsbD09YT9udWxsOmEpXTtpZighYiYmKGI9WGIuXywhYikpdGhyb3cgeChcIklDaHVuay4tZHJvcC1maXJzdFwiLGEpO3JldHVybiBiLmNhbGwobnVsbCxhKX1mdW5jdGlvbiBZYihhKXtpZihhP2EuQ2I6YSlyZXR1cm4gYS5DYihhKTt2YXIgYjtiPVliW24obnVsbD09YT9udWxsOmEpXTtpZighYiYmKGI9WWIuXywhYikpdGhyb3cgeChcIklDaHVua2VkU2VxLi1jaHVua2VkLWZpcnN0XCIsYSk7cmV0dXJuIGIuY2FsbChudWxsLGEpfVxuZnVuY3Rpb24gWmIoYSl7aWYoYT9hLkRiOmEpcmV0dXJuIGEuRGIoYSk7dmFyIGI7Yj1aYltuKG51bGw9PWE/bnVsbDphKV07aWYoIWImJihiPVpiLl8sIWIpKXRocm93IHgoXCJJQ2h1bmtlZFNlcS4tY2h1bmtlZC1yZXN0XCIsYSk7cmV0dXJuIGIuY2FsbChudWxsLGEpfWZ1bmN0aW9uICRiKGEpe2lmKGE/YS5CYjphKXJldHVybiBhLkJiKGEpO3ZhciBiO2I9JGJbbihudWxsPT1hP251bGw6YSldO2lmKCFiJiYoYj0kYi5fLCFiKSl0aHJvdyB4KFwiSUNodW5rZWROZXh0Li1jaHVua2VkLW5leHRcIixhKTtyZXR1cm4gYi5jYWxsKG51bGwsYSl9ZnVuY3Rpb24gYWMoYSxiKXtpZihhP2EuYmI6YSlyZXR1cm4gYS5iYigwLGIpO3ZhciBjO2M9YWNbbihudWxsPT1hP251bGw6YSldO2lmKCFjJiYoYz1hYy5fLCFjKSl0aHJvdyB4KFwiSVZvbGF0aWxlLi12cmVzZXQhXCIsYSk7cmV0dXJuIGMuY2FsbChudWxsLGEsYil9dmFyIGJjPXt9O1xuZnVuY3Rpb24gY2MoYSl7aWYoYT9hLmZiOmEpcmV0dXJuIGEuZmIoYSk7dmFyIGI7Yj1jY1tuKG51bGw9PWE/bnVsbDphKV07aWYoIWImJihiPWNjLl8sIWIpKXRocm93IHgoXCJJSXRlcmFibGUuLWl0ZXJhdG9yXCIsYSk7cmV0dXJuIGIuY2FsbChudWxsLGEpfWZ1bmN0aW9uIGRjKGEpe3RoaXMucWM9YTt0aGlzLnE9MDt0aGlzLmo9MTA3Mzc0MTgyNH1kYy5wcm90b3R5cGUuV2I9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gdGhpcy5xYy5hcHBlbmQoYil9O2Z1bmN0aW9uIGVjKGEpe3ZhciBiPW5ldyBmYTthLnYobnVsbCxuZXcgZGMoYiksb2EoKSk7cmV0dXJuXCJcIit6KGIpfVxudmFyIGZjPVwidW5kZWZpbmVkXCIhPT10eXBlb2YgTWF0aC5pbXVsJiYwIT09KE1hdGguaW11bC5hP01hdGguaW11bC5hKDQyOTQ5NjcyOTUsNSk6TWF0aC5pbXVsLmNhbGwobnVsbCw0Mjk0OTY3Mjk1LDUpKT9mdW5jdGlvbihhLGIpe3JldHVybiBNYXRoLmltdWwuYT9NYXRoLmltdWwuYShhLGIpOk1hdGguaW11bC5jYWxsKG51bGwsYSxiKX06ZnVuY3Rpb24oYSxiKXt2YXIgYz1hJjY1NTM1LGQ9YiY2NTUzNTtyZXR1cm4gYypkKygoYT4+PjE2JjY1NTM1KSpkK2MqKGI+Pj4xNiY2NTUzNSk8PDE2Pj4+MCl8MH07ZnVuY3Rpb24gZ2MoYSl7YT1mYyhhLDM0MzI5MTgzNTMpO3JldHVybiBmYyhhPDwxNXxhPj4+LTE1LDQ2MTg0NTkwNyl9ZnVuY3Rpb24gaGMoYSxiKXt2YXIgYz1hXmI7cmV0dXJuIGZjKGM8PDEzfGM+Pj4tMTMsNSkrMzg2NDI5MjE5Nn1cbmZ1bmN0aW9uIGljKGEsYil7dmFyIGM9YV5iLGM9ZmMoY15jPj4+MTYsMjI0NjgyMjUwNyksYz1mYyhjXmM+Pj4xMywzMjY2NDg5OTA5KTtyZXR1cm4gY15jPj4+MTZ9dmFyIGtjPXt9LGxjPTA7ZnVuY3Rpb24gbWMoYSl7MjU1PGxjJiYoa2M9e30sbGM9MCk7dmFyIGI9a2NbYV07aWYoXCJudW1iZXJcIiE9PXR5cGVvZiBiKXthOmlmKG51bGwhPWEpaWYoYj1hLmxlbmd0aCwwPGIpe2Zvcih2YXIgYz0wLGQ9MDs7KWlmKGM8Yil2YXIgZT1jKzEsZD1mYygzMSxkKSthLmNoYXJDb2RlQXQoYyksYz1lO2Vsc2V7Yj1kO2JyZWFrIGF9Yj12b2lkIDB9ZWxzZSBiPTA7ZWxzZSBiPTA7a2NbYV09YjtsYys9MX1yZXR1cm4gYT1ifVxuZnVuY3Rpb24gbmMoYSl7YSYmKGEuaiY0MTk0MzA0fHxhLnZjKT9hPWEuQihudWxsKTpcIm51bWJlclwiPT09dHlwZW9mIGE/YT0oTWF0aC5mbG9vci5iP01hdGguZmxvb3IuYihhKTpNYXRoLmZsb29yLmNhbGwobnVsbCxhKSklMjE0NzQ4MzY0NzohMD09PWE/YT0xOiExPT09YT9hPTA6XCJzdHJpbmdcIj09PXR5cGVvZiBhPyhhPW1jKGEpLDAhPT1hJiYoYT1nYyhhKSxhPWhjKDAsYSksYT1pYyhhLDQpKSk6YT1hIGluc3RhbmNlb2YgRGF0ZT9hLnZhbHVlT2YoKTpudWxsPT1hPzA6emIoYSk7cmV0dXJuIGF9XG5mdW5jdGlvbiBvYyhhKXt2YXIgYjtiPWEubmFtZTt2YXIgYzthOntjPTE7Zm9yKHZhciBkPTA7OylpZihjPGIubGVuZ3RoKXt2YXIgZT1jKzIsZD1oYyhkLGdjKGIuY2hhckNvZGVBdChjLTEpfGIuY2hhckNvZGVBdChjKTw8MTYpKTtjPWV9ZWxzZXtjPWQ7YnJlYWsgYX1jPXZvaWQgMH1jPTE9PT0oYi5sZW5ndGgmMSk/Y15nYyhiLmNoYXJDb2RlQXQoYi5sZW5ndGgtMSkpOmM7Yj1pYyhjLGZjKDIsYi5sZW5ndGgpKTthPW1jKGEuYmEpO3JldHVybiBiXmErMjY1NDQzNTc2OSsoYjw8NikrKGI+PjIpfWZ1bmN0aW9uIHBjKGEsYil7aWYoYS50YT09PWIudGEpcmV0dXJuIDA7dmFyIGM9QWEoYS5iYSk7aWYodChjP2IuYmE6YykpcmV0dXJuLTE7aWYodChhLmJhKSl7aWYoQWEoYi5iYSkpcmV0dXJuIDE7Yz1oYShhLmJhLGIuYmEpO3JldHVybiAwPT09Yz9oYShhLm5hbWUsYi5uYW1lKTpjfXJldHVybiBoYShhLm5hbWUsYi5uYW1lKX1cbmZ1bmN0aW9uIHFjKGEsYixjLGQsZSl7dGhpcy5iYT1hO3RoaXMubmFtZT1iO3RoaXMudGE9Yzt0aGlzLllhPWQ7dGhpcy5aPWU7dGhpcy5qPTIxNTQxNjgzMjE7dGhpcy5xPTQwOTZ9az1xYy5wcm90b3R5cGU7ay52PWZ1bmN0aW9uKGEsYil7cmV0dXJuIExiKGIsdGhpcy50YSl9O2suQj1mdW5jdGlvbigpe3ZhciBhPXRoaXMuWWE7cmV0dXJuIG51bGwhPWE/YTp0aGlzLllhPWE9b2ModGhpcyl9O2suRj1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgcWModGhpcy5iYSx0aGlzLm5hbWUsdGhpcy50YSx0aGlzLllhLGIpfTtrLkg9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5afTtcbmsuY2FsbD1mdW5jdGlvbigpe3ZhciBhPW51bGwsYT1mdW5jdGlvbihhLGMsZCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gJGEuYyhjLHRoaXMsbnVsbCk7Y2FzZSAzOnJldHVybiAkYS5jKGMsdGhpcyxkKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307YS5hPWZ1bmN0aW9uKGEsYyl7cmV0dXJuICRhLmMoYyx0aGlzLG51bGwpfTthLmM9ZnVuY3Rpb24oYSxjLGQpe3JldHVybiAkYS5jKGMsdGhpcyxkKX07cmV0dXJuIGF9KCk7ay5hcHBseT1mdW5jdGlvbihhLGIpe3JldHVybiB0aGlzLmNhbGwuYXBwbHkodGhpcyxbdGhpc10uY29uY2F0KEZhKGIpKSl9O2suYj1mdW5jdGlvbihhKXtyZXR1cm4gJGEuYyhhLHRoaXMsbnVsbCl9O2suYT1mdW5jdGlvbihhLGIpe3JldHVybiAkYS5jKGEsdGhpcyxiKX07ay5BPWZ1bmN0aW9uKGEsYil7cmV0dXJuIGIgaW5zdGFuY2VvZiBxYz90aGlzLnRhPT09Yi50YTohMX07XG5rLnRvU3RyaW5nPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudGF9O3ZhciByYz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiKXt2YXIgYz1udWxsIT1hP1t6KGEpLHooXCIvXCIpLHooYildLmpvaW4oXCJcIik6YjtyZXR1cm4gbmV3IHFjKGEsYixjLG51bGwsbnVsbCl9ZnVuY3Rpb24gYihhKXtyZXR1cm4gYSBpbnN0YW5jZW9mIHFjP2E6Yy5hKG51bGwsYSl9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYi5jYWxsKHRoaXMsYyk7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxjLGUpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmI9YjtjLmE9YTtyZXR1cm4gY30oKTtcbmZ1bmN0aW9uIEQoYSl7aWYobnVsbD09YSlyZXR1cm4gbnVsbDtpZihhJiYoYS5qJjgzODg2MDh8fGEubWMpKXJldHVybiBhLkQobnVsbCk7aWYoYSBpbnN0YW5jZW9mIEFycmF5fHxcInN0cmluZ1wiPT09dHlwZW9mIGEpcmV0dXJuIDA9PT1hLmxlbmd0aD9udWxsOm5ldyBGKGEsMCk7aWYodyhCYixhKSlyZXR1cm4gQ2IoYSk7dGhyb3cgRXJyb3IoW3ooYSkseihcIiBpcyBub3QgSVNlcWFibGVcIildLmpvaW4oXCJcIikpO31mdW5jdGlvbiBHKGEpe2lmKG51bGw9PWEpcmV0dXJuIG51bGw7aWYoYSYmKGEuaiY2NHx8YS5qYikpcmV0dXJuIGEuTihudWxsKTthPUQoYSk7cmV0dXJuIG51bGw9PWE/bnVsbDpWYShhKX1mdW5jdGlvbiBIKGEpe3JldHVybiBudWxsIT1hP2EmJihhLmomNjR8fGEuamIpP2EuUyhudWxsKTooYT1EKGEpKT9XYShhKTpKOkp9ZnVuY3Rpb24gSyhhKXtyZXR1cm4gbnVsbD09YT9udWxsOmEmJihhLmomMTI4fHxhLnhiKT9hLlQobnVsbCk6RChIKGEpKX1cbnZhciBzYz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiKXtyZXR1cm4gbnVsbD09YT9udWxsPT1iOmE9PT1ifHx5YihhLGIpfXZhciBiPW51bGwsYz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYixkLGgpe3ZhciBsPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGw9MCxtPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7bDxtLmxlbmd0aDspbVtsXT1hcmd1bWVudHNbbCsyXSwrK2w7bD1uZXcgRihtLDApfXJldHVybiBjLmNhbGwodGhpcyxiLGQsbCl9ZnVuY3Rpb24gYyhhLGQsZSl7Zm9yKDs7KWlmKGIuYShhLGQpKWlmKEsoZSkpYT1kLGQ9RyhlKSxlPUsoZSk7ZWxzZSByZXR1cm4gYi5hKGQsRyhlKSk7ZWxzZSByZXR1cm4hMX1hLmk9MjthLmY9ZnVuY3Rpb24oYSl7dmFyIGI9RyhhKTthPUsoYSk7dmFyIGQ9RyhhKTthPUgoYSk7cmV0dXJuIGMoYixkLGEpfTthLmQ9YztyZXR1cm4gYX0oKSxiPWZ1bmN0aW9uKGIsZSxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiEwO1xuY2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxiLGUpO2RlZmF1bHQ6dmFyIGc9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZz0wLGg9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtnPGgubGVuZ3RoOyloW2ddPWFyZ3VtZW50c1tnKzJdLCsrZztnPW5ldyBGKGgsMCl9cmV0dXJuIGMuZChiLGUsZyl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2IuaT0yO2IuZj1jLmY7Yi5iPWZ1bmN0aW9uKCl7cmV0dXJuITB9O2IuYT1hO2IuZD1jLmQ7cmV0dXJuIGJ9KCk7ZnVuY3Rpb24gdGMoYSl7dGhpcy5DPWF9dGMucHJvdG90eXBlLm5leHQ9ZnVuY3Rpb24oKXtpZihudWxsIT10aGlzLkMpe3ZhciBhPUcodGhpcy5DKTt0aGlzLkM9Syh0aGlzLkMpO3JldHVybntkb25lOiExLHZhbHVlOmF9fXJldHVybntkb25lOiEwLHZhbHVlOm51bGx9fTtmdW5jdGlvbiB1YyhhKXtyZXR1cm4gbmV3IHRjKEQoYSkpfVxuZnVuY3Rpb24gdmMoYSxiKXt2YXIgYz1nYyhhKSxjPWhjKDAsYyk7cmV0dXJuIGljKGMsYil9ZnVuY3Rpb24gd2MoYSl7dmFyIGI9MCxjPTE7Zm9yKGE9RChhKTs7KWlmKG51bGwhPWEpYis9MSxjPWZjKDMxLGMpK25jKEcoYSkpfDAsYT1LKGEpO2Vsc2UgcmV0dXJuIHZjKGMsYil9ZnVuY3Rpb24geGMoYSl7dmFyIGI9MCxjPTA7Zm9yKGE9RChhKTs7KWlmKG51bGwhPWEpYis9MSxjPWMrbmMoRyhhKSl8MCxhPUsoYSk7ZWxzZSByZXR1cm4gdmMoYyxiKX1MYVtcIm51bGxcIl09ITA7TWFbXCJudWxsXCJdPWZ1bmN0aW9uKCl7cmV0dXJuIDB9O0RhdGUucHJvdG90eXBlLkE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gYiBpbnN0YW5jZW9mIERhdGUmJnRoaXMudG9TdHJpbmcoKT09PWIudG9TdHJpbmcoKX07eWIubnVtYmVyPWZ1bmN0aW9uKGEsYil7cmV0dXJuIGE9PT1ifTtyYltcImZ1bmN0aW9uXCJdPSEwO3NiW1wiZnVuY3Rpb25cIl09ZnVuY3Rpb24oKXtyZXR1cm4gbnVsbH07XG5KYVtcImZ1bmN0aW9uXCJdPSEwO3piLl89ZnVuY3Rpb24oYSl7cmV0dXJuIGFbYmFdfHwoYVtiYV09KytjYSl9O2Z1bmN0aW9uIHljKGEpe3RoaXMubz1hO3RoaXMucT0wO3RoaXMuaj0zMjc2OH15Yy5wcm90b3R5cGUuUmE9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5vfTtmdW5jdGlvbiBBYyhhKXtyZXR1cm4gYSBpbnN0YW5jZW9mIHljfWZ1bmN0aW9uIEJjKGEpe3JldHVybiBBYyhhKT9MLmI/TC5iKGEpOkwuY2FsbChudWxsLGEpOmF9ZnVuY3Rpb24gTChhKXtyZXR1cm4gcWIoYSl9XG52YXIgQ2M9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjLGQpe2Zvcih2YXIgbD1NYShhKTs7KWlmKGQ8bCl7dmFyIG09Qy5hKGEsZCk7Yz1iLmE/Yi5hKGMsbSk6Yi5jYWxsKG51bGwsYyxtKTtpZihBYyhjKSlyZXR1cm4gcWIoYyk7ZCs9MX1lbHNlIHJldHVybiBjfWZ1bmN0aW9uIGIoYSxiLGMpe3ZhciBkPU1hKGEpLGw9Yztmb3IoYz0wOzspaWYoYzxkKXt2YXIgbT1DLmEoYSxjKSxsPWIuYT9iLmEobCxtKTpiLmNhbGwobnVsbCxsLG0pO2lmKEFjKGwpKXJldHVybiBxYihsKTtjKz0xfWVsc2UgcmV0dXJuIGx9ZnVuY3Rpb24gYyhhLGIpe3ZhciBjPU1hKGEpO2lmKDA9PT1jKXJldHVybiBiLmw/Yi5sKCk6Yi5jYWxsKG51bGwpO2Zvcih2YXIgZD1DLmEoYSwwKSxsPTE7OylpZihsPGMpe3ZhciBtPUMuYShhLGwpLGQ9Yi5hP2IuYShkLG0pOmIuY2FsbChudWxsLGQsbSk7aWYoQWMoZCkpcmV0dXJuIHFiKGQpO2wrPTF9ZWxzZSByZXR1cm4gZH12YXIgZD1udWxsLGQ9ZnVuY3Rpb24oZCxcbmYsZyxoKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiBjLmNhbGwodGhpcyxkLGYpO2Nhc2UgMzpyZXR1cm4gYi5jYWxsKHRoaXMsZCxmLGcpO2Nhc2UgNDpyZXR1cm4gYS5jYWxsKHRoaXMsZCxmLGcsaCl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2QuYT1jO2QuYz1iO2Qubj1hO3JldHVybiBkfSgpLERjPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyxkKXtmb3IodmFyIGw9YS5sZW5ndGg7OylpZihkPGwpe3ZhciBtPWFbZF07Yz1iLmE/Yi5hKGMsbSk6Yi5jYWxsKG51bGwsYyxtKTtpZihBYyhjKSlyZXR1cm4gcWIoYyk7ZCs9MX1lbHNlIHJldHVybiBjfWZ1bmN0aW9uIGIoYSxiLGMpe3ZhciBkPWEubGVuZ3RoLGw9Yztmb3IoYz0wOzspaWYoYzxkKXt2YXIgbT1hW2NdLGw9Yi5hP2IuYShsLG0pOmIuY2FsbChudWxsLGwsbSk7aWYoQWMobCkpcmV0dXJuIHFiKGwpO2MrPTF9ZWxzZSByZXR1cm4gbH1mdW5jdGlvbiBjKGEsXG5iKXt2YXIgYz1hLmxlbmd0aDtpZigwPT09YS5sZW5ndGgpcmV0dXJuIGIubD9iLmwoKTpiLmNhbGwobnVsbCk7Zm9yKHZhciBkPWFbMF0sbD0xOzspaWYobDxjKXt2YXIgbT1hW2xdLGQ9Yi5hP2IuYShkLG0pOmIuY2FsbChudWxsLGQsbSk7aWYoQWMoZCkpcmV0dXJuIHFiKGQpO2wrPTF9ZWxzZSByZXR1cm4gZH12YXIgZD1udWxsLGQ9ZnVuY3Rpb24oZCxmLGcsaCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gYy5jYWxsKHRoaXMsZCxmKTtjYXNlIDM6cmV0dXJuIGIuY2FsbCh0aGlzLGQsZixnKTtjYXNlIDQ6cmV0dXJuIGEuY2FsbCh0aGlzLGQsZixnLGgpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtkLmE9YztkLmM9YjtkLm49YTtyZXR1cm4gZH0oKTtmdW5jdGlvbiBFYyhhKXtyZXR1cm4gYT9hLmomMnx8YS5jYz8hMDphLmo/ITE6dyhMYSxhKTp3KExhLGEpfVxuZnVuY3Rpb24gRmMoYSl7cmV0dXJuIGE/YS5qJjE2fHxhLlFiPyEwOmEuaj8hMTp3KFRhLGEpOncoVGEsYSl9ZnVuY3Rpb24gR2MoYSxiKXt0aGlzLmU9YTt0aGlzLm09Yn1HYy5wcm90b3R5cGUuZ2E9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5tPHRoaXMuZS5sZW5ndGh9O0djLnByb3RvdHlwZS5uZXh0PWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5lW3RoaXMubV07dGhpcy5tKz0xO3JldHVybiBhfTtmdW5jdGlvbiBGKGEsYil7dGhpcy5lPWE7dGhpcy5tPWI7dGhpcy5qPTE2NjE5OTU1MDt0aGlzLnE9ODE5Mn1rPUYucHJvdG90eXBlO2sudG9TdHJpbmc9ZnVuY3Rpb24oKXtyZXR1cm4gZWModGhpcyl9O2suUT1mdW5jdGlvbihhLGIpe3ZhciBjPWIrdGhpcy5tO3JldHVybiBjPHRoaXMuZS5sZW5ndGg/dGhpcy5lW2NdOm51bGx9O2suJD1mdW5jdGlvbihhLGIsYyl7YT1iK3RoaXMubTtyZXR1cm4gYTx0aGlzLmUubGVuZ3RoP3RoaXMuZVthXTpjfTtrLnZiPSEwO1xuay5mYj1mdW5jdGlvbigpe3JldHVybiBuZXcgR2ModGhpcy5lLHRoaXMubSl9O2suVD1mdW5jdGlvbigpe3JldHVybiB0aGlzLm0rMTx0aGlzLmUubGVuZ3RoP25ldyBGKHRoaXMuZSx0aGlzLm0rMSk6bnVsbH07ay5MPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuZS5sZW5ndGgtdGhpcy5tfTtrLmFiPWZ1bmN0aW9uKCl7dmFyIGE9TWEodGhpcyk7cmV0dXJuIDA8YT9uZXcgSGModGhpcyxhLTEsbnVsbCk6bnVsbH07ay5CPWZ1bmN0aW9uKCl7cmV0dXJuIHdjKHRoaXMpfTtrLkE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gSWMuYT9JYy5hKHRoaXMsYik6SWMuY2FsbChudWxsLHRoaXMsYil9O2suSj1mdW5jdGlvbigpe3JldHVybiBKfTtrLlI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gRGMubih0aGlzLmUsYix0aGlzLmVbdGhpcy5tXSx0aGlzLm0rMSl9O2suTz1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIERjLm4odGhpcy5lLGIsYyx0aGlzLm0pfTtrLk49ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5lW3RoaXMubV19O1xuay5TPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMubSsxPHRoaXMuZS5sZW5ndGg/bmV3IEYodGhpcy5lLHRoaXMubSsxKTpKfTtrLkQ9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpc307ay5HPWZ1bmN0aW9uKGEsYil7cmV0dXJuIE0uYT9NLmEoYix0aGlzKTpNLmNhbGwobnVsbCxiLHRoaXMpfTtGLnByb3RvdHlwZVtFYV09ZnVuY3Rpb24oKXtyZXR1cm4gdWModGhpcyl9O1xudmFyIEpjPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIpe3JldHVybiBiPGEubGVuZ3RoP25ldyBGKGEsYik6bnVsbH1mdW5jdGlvbiBiKGEpe3JldHVybiBjLmEoYSwwKX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiLmNhbGwodGhpcyxjKTtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYj1iO2MuYT1hO3JldHVybiBjfSgpLEtjPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIpe3JldHVybiBKYy5hKGEsYil9ZnVuY3Rpb24gYihhKXtyZXR1cm4gSmMuYShhLDApfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGIuY2FsbCh0aGlzLGMpO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK1xuYXJndW1lbnRzLmxlbmd0aCk7fTtjLmI9YjtjLmE9YTtyZXR1cm4gY30oKTtmdW5jdGlvbiBIYyhhLGIsYyl7dGhpcy5xYj1hO3RoaXMubT1iO3RoaXMuaz1jO3RoaXMuaj0zMjM3NDk5MDt0aGlzLnE9ODE5Mn1rPUhjLnByb3RvdHlwZTtrLnRvU3RyaW5nPWZ1bmN0aW9uKCl7cmV0dXJuIGVjKHRoaXMpfTtrLkg9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5rfTtrLlQ9ZnVuY3Rpb24oKXtyZXR1cm4gMDx0aGlzLm0/bmV3IEhjKHRoaXMucWIsdGhpcy5tLTEsbnVsbCk6bnVsbH07ay5MPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMubSsxfTtrLkI9ZnVuY3Rpb24oKXtyZXR1cm4gd2ModGhpcyl9O2suQT1mdW5jdGlvbihhLGIpe3JldHVybiBJYy5hP0ljLmEodGhpcyxiKTpJYy5jYWxsKG51bGwsdGhpcyxiKX07ay5KPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5rO3JldHVybiBPLmE/Ty5hKEosYSk6Ty5jYWxsKG51bGwsSixhKX07XG5rLlI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gUC5hP1AuYShiLHRoaXMpOlAuY2FsbChudWxsLGIsdGhpcyl9O2suTz1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIFAuYz9QLmMoYixjLHRoaXMpOlAuY2FsbChudWxsLGIsYyx0aGlzKX07ay5OPWZ1bmN0aW9uKCl7cmV0dXJuIEMuYSh0aGlzLnFiLHRoaXMubSl9O2suUz1mdW5jdGlvbigpe3JldHVybiAwPHRoaXMubT9uZXcgSGModGhpcy5xYix0aGlzLm0tMSxudWxsKTpKfTtrLkQ9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpc307ay5GPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyBIYyh0aGlzLnFiLHRoaXMubSxiKX07ay5HPWZ1bmN0aW9uKGEsYil7cmV0dXJuIE0uYT9NLmEoYix0aGlzKTpNLmNhbGwobnVsbCxiLHRoaXMpfTtIYy5wcm90b3R5cGVbRWFdPWZ1bmN0aW9uKCl7cmV0dXJuIHVjKHRoaXMpfTtmdW5jdGlvbiBMYyhhKXtyZXR1cm4gRyhLKGEpKX15Yi5fPWZ1bmN0aW9uKGEsYil7cmV0dXJuIGE9PT1ifTtcbnZhciBOYz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiKXtyZXR1cm4gbnVsbCE9YT9SYShhLGIpOlJhKEosYil9dmFyIGI9bnVsbCxjPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShiLGQsaCl7dmFyIGw9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgbD0wLG09QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtsPG0ubGVuZ3RoOyltW2xdPWFyZ3VtZW50c1tsKzJdLCsrbDtsPW5ldyBGKG0sMCl9cmV0dXJuIGMuY2FsbCh0aGlzLGIsZCxsKX1mdW5jdGlvbiBjKGEsZCxlKXtmb3IoOzspaWYodChlKSlhPWIuYShhLGQpLGQ9RyhlKSxlPUsoZSk7ZWxzZSByZXR1cm4gYi5hKGEsZCl9YS5pPTI7YS5mPWZ1bmN0aW9uKGEpe3ZhciBiPUcoYSk7YT1LKGEpO3ZhciBkPUcoYSk7YT1IKGEpO3JldHVybiBjKGIsZCxhKX07YS5kPWM7cmV0dXJuIGF9KCksYj1mdW5jdGlvbihiLGUsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMDpyZXR1cm4gTWM7Y2FzZSAxOnJldHVybiBiO1xuY2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxiLGUpO2RlZmF1bHQ6dmFyIGc9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZz0wLGg9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtnPGgubGVuZ3RoOyloW2ddPWFyZ3VtZW50c1tnKzJdLCsrZztnPW5ldyBGKGgsMCl9cmV0dXJuIGMuZChiLGUsZyl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2IuaT0yO2IuZj1jLmY7Yi5sPWZ1bmN0aW9uKCl7cmV0dXJuIE1jfTtiLmI9ZnVuY3Rpb24oYSl7cmV0dXJuIGF9O2IuYT1hO2IuZD1jLmQ7cmV0dXJuIGJ9KCk7ZnVuY3Rpb24gT2MoYSl7cmV0dXJuIG51bGw9PWE/bnVsbDpOYShhKX1cbmZ1bmN0aW9uIFEoYSl7aWYobnVsbCE9YSlpZihhJiYoYS5qJjJ8fGEuY2MpKWE9YS5MKG51bGwpO2Vsc2UgaWYoYSBpbnN0YW5jZW9mIEFycmF5KWE9YS5sZW5ndGg7ZWxzZSBpZihcInN0cmluZ1wiPT09dHlwZW9mIGEpYT1hLmxlbmd0aDtlbHNlIGlmKHcoTGEsYSkpYT1NYShhKTtlbHNlIGE6e2E9RChhKTtmb3IodmFyIGI9MDs7KXtpZihFYyhhKSl7YT1iK01hKGEpO2JyZWFrIGF9YT1LKGEpO2IrPTF9YT12b2lkIDB9ZWxzZSBhPTA7cmV0dXJuIGF9XG52YXIgUGM9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjKXtmb3IoOzspe2lmKG51bGw9PWEpcmV0dXJuIGM7aWYoMD09PWIpcmV0dXJuIEQoYSk/RyhhKTpjO2lmKEZjKGEpKXJldHVybiBDLmMoYSxiLGMpO2lmKEQoYSkpYT1LKGEpLGItPTE7ZWxzZSByZXR1cm4gY319ZnVuY3Rpb24gYihhLGIpe2Zvcig7Oyl7aWYobnVsbD09YSl0aHJvdyBFcnJvcihcIkluZGV4IG91dCBvZiBib3VuZHNcIik7aWYoMD09PWIpe2lmKEQoYSkpcmV0dXJuIEcoYSk7dGhyb3cgRXJyb3IoXCJJbmRleCBvdXQgb2YgYm91bmRzXCIpO31pZihGYyhhKSlyZXR1cm4gQy5hKGEsYik7aWYoRChhKSl7dmFyIGM9SyhhKSxnPWItMTthPWM7Yj1nfWVsc2UgdGhyb3cgRXJyb3IoXCJJbmRleCBvdXQgb2YgYm91bmRzXCIpO319dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiBiLmNhbGwodGhpcyxjLGUpO2Nhc2UgMzpyZXR1cm4gYS5jYWxsKHRoaXMsXG5jLGUsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYT1iO2MuYz1hO3JldHVybiBjfSgpLFI9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjKXtpZihcIm51bWJlclwiIT09dHlwZW9mIGIpdGhyb3cgRXJyb3IoXCJpbmRleCBhcmd1bWVudCB0byBudGggbXVzdCBiZSBhIG51bWJlci5cIik7aWYobnVsbD09YSlyZXR1cm4gYztpZihhJiYoYS5qJjE2fHxhLlFiKSlyZXR1cm4gYS4kKG51bGwsYixjKTtpZihhIGluc3RhbmNlb2YgQXJyYXl8fFwic3RyaW5nXCI9PT10eXBlb2YgYSlyZXR1cm4gYjxhLmxlbmd0aD9hW2JdOmM7aWYodyhUYSxhKSlyZXR1cm4gQy5hKGEsYik7aWYoYT9hLmomNjR8fGEuamJ8fChhLmo/MDp3KFVhLGEpKTp3KFVhLGEpKXJldHVybiBQYy5jKGEsYixjKTt0aHJvdyBFcnJvcihbeihcIm50aCBub3Qgc3VwcG9ydGVkIG9uIHRoaXMgdHlwZSBcIikseihEYShCYShhKSkpXS5qb2luKFwiXCIpKTt9ZnVuY3Rpb24gYihhLGIpe2lmKFwibnVtYmVyXCIhPT1cbnR5cGVvZiBiKXRocm93IEVycm9yKFwiaW5kZXggYXJndW1lbnQgdG8gbnRoIG11c3QgYmUgYSBudW1iZXJcIik7aWYobnVsbD09YSlyZXR1cm4gYTtpZihhJiYoYS5qJjE2fHxhLlFiKSlyZXR1cm4gYS5RKG51bGwsYik7aWYoYSBpbnN0YW5jZW9mIEFycmF5fHxcInN0cmluZ1wiPT09dHlwZW9mIGEpcmV0dXJuIGI8YS5sZW5ndGg/YVtiXTpudWxsO2lmKHcoVGEsYSkpcmV0dXJuIEMuYShhLGIpO2lmKGE/YS5qJjY0fHxhLmpifHwoYS5qPzA6dyhVYSxhKSk6dyhVYSxhKSlyZXR1cm4gUGMuYShhLGIpO3Rocm93IEVycm9yKFt6KFwibnRoIG5vdCBzdXBwb3J0ZWQgb24gdGhpcyB0eXBlIFwiKSx6KERhKEJhKGEpKSldLmpvaW4oXCJcIikpO312YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIGIuY2FsbCh0aGlzLGMsZSk7Y2FzZSAzOnJldHVybiBhLmNhbGwodGhpcyxjLGUsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIitcbmFyZ3VtZW50cy5sZW5ndGgpO307Yy5hPWI7Yy5jPWE7cmV0dXJuIGN9KCksUz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMpe3JldHVybiBudWxsIT1hP2EmJihhLmomMjU2fHxhLlJiKT9hLnMobnVsbCxiLGMpOmEgaW5zdGFuY2VvZiBBcnJheT9iPGEubGVuZ3RoP2FbYl06YzpcInN0cmluZ1wiPT09dHlwZW9mIGE/YjxhLmxlbmd0aD9hW2JdOmM6dyhaYSxhKT8kYS5jKGEsYixjKTpjOmN9ZnVuY3Rpb24gYihhLGIpe3JldHVybiBudWxsPT1hP251bGw6YSYmKGEuaiYyNTZ8fGEuUmIpP2EudChudWxsLGIpOmEgaW5zdGFuY2VvZiBBcnJheT9iPGEubGVuZ3RoP2FbYl06bnVsbDpcInN0cmluZ1wiPT09dHlwZW9mIGE/YjxhLmxlbmd0aD9hW2JdOm51bGw6dyhaYSxhKT8kYS5hKGEsYik6bnVsbH12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIGIuY2FsbCh0aGlzLGMsZSk7Y2FzZSAzOnJldHVybiBhLmNhbGwodGhpcyxcbmMsZSxmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5hPWI7Yy5jPWE7cmV0dXJuIGN9KCksUmM9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjKXtpZihudWxsIT1hKWE9Y2IoYSxiLGMpO2Vsc2UgYTp7YT1bYl07Yz1bY107Yj1hLmxlbmd0aDtmb3IodmFyIGc9MCxoPU9iKFFjKTs7KWlmKGc8Yil2YXIgbD1nKzEsaD1oLmtiKG51bGwsYVtnXSxjW2ddKSxnPWw7ZWxzZXthPVFiKGgpO2JyZWFrIGF9YT12b2lkIDB9cmV0dXJuIGF9dmFyIGI9bnVsbCxjPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShiLGQsaCxsKXt2YXIgbT1udWxsO2lmKDM8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBtPTAscD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTMpO208cC5sZW5ndGg7KXBbbV09YXJndW1lbnRzW20rM10sKyttO209bmV3IEYocCwwKX1yZXR1cm4gYy5jYWxsKHRoaXMsYixkLGgsbSl9ZnVuY3Rpb24gYyhhLGQsZSxsKXtmb3IoOzspaWYoYT1iLmMoYSxcbmQsZSksdChsKSlkPUcobCksZT1MYyhsKSxsPUsoSyhsKSk7ZWxzZSByZXR1cm4gYX1hLmk9MzthLmY9ZnVuY3Rpb24oYSl7dmFyIGI9RyhhKTthPUsoYSk7dmFyIGQ9RyhhKTthPUsoYSk7dmFyIGw9RyhhKTthPUgoYSk7cmV0dXJuIGMoYixkLGwsYSl9O2EuZD1jO3JldHVybiBhfSgpLGI9ZnVuY3Rpb24oYixlLGYsZyl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMzpyZXR1cm4gYS5jYWxsKHRoaXMsYixlLGYpO2RlZmF1bHQ6dmFyIGg9bnVsbDtpZigzPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgaD0wLGw9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0zKTtoPGwubGVuZ3RoOylsW2hdPWFyZ3VtZW50c1toKzNdLCsraDtoPW5ldyBGKGwsMCl9cmV0dXJuIGMuZChiLGUsZixoKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yi5pPTM7Yi5mPWMuZjtiLmM9YTtiLmQ9Yy5kO3JldHVybiBifSgpLFNjPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLFxuYil7cmV0dXJuIG51bGw9PWE/bnVsbDplYihhLGIpfXZhciBiPW51bGwsYz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYixkLGgpe3ZhciBsPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGw9MCxtPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7bDxtLmxlbmd0aDspbVtsXT1hcmd1bWVudHNbbCsyXSwrK2w7bD1uZXcgRihtLDApfXJldHVybiBjLmNhbGwodGhpcyxiLGQsbCl9ZnVuY3Rpb24gYyhhLGQsZSl7Zm9yKDs7KXtpZihudWxsPT1hKXJldHVybiBudWxsO2E9Yi5hKGEsZCk7aWYodChlKSlkPUcoZSksZT1LKGUpO2Vsc2UgcmV0dXJuIGF9fWEuaT0yO2EuZj1mdW5jdGlvbihhKXt2YXIgYj1HKGEpO2E9SyhhKTt2YXIgZD1HKGEpO2E9SChhKTtyZXR1cm4gYyhiLGQsYSl9O2EuZD1jO3JldHVybiBhfSgpLGI9ZnVuY3Rpb24oYixlLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGI7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxiLGUpO1xuZGVmYXVsdDp2YXIgZz1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBnPTAsaD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2c8aC5sZW5ndGg7KWhbZ109YXJndW1lbnRzW2crMl0sKytnO2c9bmV3IEYoaCwwKX1yZXR1cm4gYy5kKGIsZSxnKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yi5pPTI7Yi5mPWMuZjtiLmI9ZnVuY3Rpb24oYSl7cmV0dXJuIGF9O2IuYT1hO2IuZD1jLmQ7cmV0dXJuIGJ9KCk7ZnVuY3Rpb24gVGMoYSl7dmFyIGI9XCJmdW5jdGlvblwiPT1uKGEpO3JldHVybiB0KGIpP2I6YT90KHQobnVsbCk/bnVsbDphLmJjKT8hMDphLnliPyExOncoSmEsYSk6dyhKYSxhKX1mdW5jdGlvbiBVYyhhLGIpe3RoaXMuaD1hO3RoaXMuaz1iO3RoaXMucT0wO3RoaXMuaj0zOTMyMTd9az1VYy5wcm90b3R5cGU7XG5rLmNhbGw9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHUscyx2LHksQixFLE4sWSxyYSxJKXthPXRoaXMuaDtyZXR1cm4gVC51Yj9ULnViKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHUscyx2LHksQixFLE4sWSxyYSxJKTpULmNhbGwobnVsbCxhLGIsYyxkLGUsZixnLGgsbCxtLHAscSx1LHMsdix5LEIsRSxOLFkscmEsSSl9ZnVuY3Rpb24gYihhLGIsYyxkLGUsZixnLGgsbCxtLHAscSx1LHMsdix5LEIsRSxOLFkscmEpe2E9dGhpcztyZXR1cm4gYS5oLkZhP2EuaC5GYShiLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSxzLHYseSxCLEUsTixZLHJhKTphLmguY2FsbChudWxsLGIsYyxkLGUsZixnLGgsbCxtLHAscSx1LHMsdix5LEIsRSxOLFkscmEpfWZ1bmN0aW9uIGMoYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSxzLHYseSxCLEUsTixZKXthPXRoaXM7cmV0dXJuIGEuaC5FYT9hLmguRWEoYixjLGQsZSxmLGcsaCxsLG0scCxxLHUscyx2LHksQixFLE4sXG5ZKTphLmguY2FsbChudWxsLGIsYyxkLGUsZixnLGgsbCxtLHAscSx1LHMsdix5LEIsRSxOLFkpfWZ1bmN0aW9uIGQoYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSxzLHYseSxCLEUsTil7YT10aGlzO3JldHVybiBhLmguRGE/YS5oLkRhKGIsYyxkLGUsZixnLGgsbCxtLHAscSx1LHMsdix5LEIsRSxOKTphLmguY2FsbChudWxsLGIsYyxkLGUsZixnLGgsbCxtLHAscSx1LHMsdix5LEIsRSxOKX1mdW5jdGlvbiBlKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHUscyx2LHksQixFKXthPXRoaXM7cmV0dXJuIGEuaC5DYT9hLmguQ2EoYixjLGQsZSxmLGcsaCxsLG0scCxxLHUscyx2LHksQixFKTphLmguY2FsbChudWxsLGIsYyxkLGUsZixnLGgsbCxtLHAscSx1LHMsdix5LEIsRSl9ZnVuY3Rpb24gZihhLGIsYyxkLGUsZixnLGgsbCxtLHAscSx1LHMsdix5LEIpe2E9dGhpcztyZXR1cm4gYS5oLkJhP2EuaC5CYShiLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSxzLHYseSxCKTphLmguY2FsbChudWxsLFxuYixjLGQsZSxmLGcsaCxsLG0scCxxLHUscyx2LHksQil9ZnVuY3Rpb24gZyhhLGIsYyxkLGUsZixnLGgsbCxtLHAscSx1LHMsdix5KXthPXRoaXM7cmV0dXJuIGEuaC5BYT9hLmguQWEoYixjLGQsZSxmLGcsaCxsLG0scCxxLHUscyx2LHkpOmEuaC5jYWxsKG51bGwsYixjLGQsZSxmLGcsaCxsLG0scCxxLHUscyx2LHkpfWZ1bmN0aW9uIGgoYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSxzLHYpe2E9dGhpcztyZXR1cm4gYS5oLnphP2EuaC56YShiLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSxzLHYpOmEuaC5jYWxsKG51bGwsYixjLGQsZSxmLGcsaCxsLG0scCxxLHUscyx2KX1mdW5jdGlvbiBsKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHUscyl7YT10aGlzO3JldHVybiBhLmgueWE/YS5oLnlhKGIsYyxkLGUsZixnLGgsbCxtLHAscSx1LHMpOmEuaC5jYWxsKG51bGwsYixjLGQsZSxmLGcsaCxsLG0scCxxLHUscyl9ZnVuY3Rpb24gbShhLGIsYyxkLGUsZixnLGgsbCxtLHAscSx1KXthPXRoaXM7XG5yZXR1cm4gYS5oLnhhP2EuaC54YShiLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSk6YS5oLmNhbGwobnVsbCxiLGMsZCxlLGYsZyxoLGwsbSxwLHEsdSl9ZnVuY3Rpb24gcChhLGIsYyxkLGUsZixnLGgsbCxtLHAscSl7YT10aGlzO3JldHVybiBhLmgud2E/YS5oLndhKGIsYyxkLGUsZixnLGgsbCxtLHAscSk6YS5oLmNhbGwobnVsbCxiLGMsZCxlLGYsZyxoLGwsbSxwLHEpfWZ1bmN0aW9uIHEoYSxiLGMsZCxlLGYsZyxoLGwsbSxwKXthPXRoaXM7cmV0dXJuIGEuaC52YT9hLmgudmEoYixjLGQsZSxmLGcsaCxsLG0scCk6YS5oLmNhbGwobnVsbCxiLGMsZCxlLGYsZyxoLGwsbSxwKX1mdW5jdGlvbiBzKGEsYixjLGQsZSxmLGcsaCxsLG0pe2E9dGhpcztyZXR1cm4gYS5oLkhhP2EuaC5IYShiLGMsZCxlLGYsZyxoLGwsbSk6YS5oLmNhbGwobnVsbCxiLGMsZCxlLGYsZyxoLGwsbSl9ZnVuY3Rpb24gdShhLGIsYyxkLGUsZixnLGgsbCl7YT10aGlzO3JldHVybiBhLmguR2E/YS5oLkdhKGIsYyxcbmQsZSxmLGcsaCxsKTphLmguY2FsbChudWxsLGIsYyxkLGUsZixnLGgsbCl9ZnVuY3Rpb24gdihhLGIsYyxkLGUsZixnLGgpe2E9dGhpcztyZXR1cm4gYS5oLmlhP2EuaC5pYShiLGMsZCxlLGYsZyxoKTphLmguY2FsbChudWxsLGIsYyxkLGUsZixnLGgpfWZ1bmN0aW9uIHkoYSxiLGMsZCxlLGYsZyl7YT10aGlzO3JldHVybiBhLmguUD9hLmguUChiLGMsZCxlLGYsZyk6YS5oLmNhbGwobnVsbCxiLGMsZCxlLGYsZyl9ZnVuY3Rpb24gQihhLGIsYyxkLGUsZil7YT10aGlzO3JldHVybiBhLmgucj9hLmgucihiLGMsZCxlLGYpOmEuaC5jYWxsKG51bGwsYixjLGQsZSxmKX1mdW5jdGlvbiBFKGEsYixjLGQsZSl7YT10aGlzO3JldHVybiBhLmgubj9hLmgubihiLGMsZCxlKTphLmguY2FsbChudWxsLGIsYyxkLGUpfWZ1bmN0aW9uIE4oYSxiLGMsZCl7YT10aGlzO3JldHVybiBhLmguYz9hLmguYyhiLGMsZCk6YS5oLmNhbGwobnVsbCxiLGMsZCl9ZnVuY3Rpb24gWShhLGIsYyl7YT10aGlzO1xucmV0dXJuIGEuaC5hP2EuaC5hKGIsYyk6YS5oLmNhbGwobnVsbCxiLGMpfWZ1bmN0aW9uIHJhKGEsYil7YT10aGlzO3JldHVybiBhLmguYj9hLmguYihiKTphLmguY2FsbChudWxsLGIpfWZ1bmN0aW9uIFBhKGEpe2E9dGhpcztyZXR1cm4gYS5oLmw/YS5oLmwoKTphLmguY2FsbChudWxsKX12YXIgST1udWxsLEk9ZnVuY3Rpb24oSSxxYSx0YSx2YSx4YSxDYSxHYSxLYSxPYSxTYSxZYSxnYixvYixBYixXYixqYyx6YyxaYyxHZCxEZSxXZixkaCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gUGEuY2FsbCh0aGlzLEkpO2Nhc2UgMjpyZXR1cm4gcmEuY2FsbCh0aGlzLEkscWEpO2Nhc2UgMzpyZXR1cm4gWS5jYWxsKHRoaXMsSSxxYSx0YSk7Y2FzZSA0OnJldHVybiBOLmNhbGwodGhpcyxJLHFhLHRhLHZhKTtjYXNlIDU6cmV0dXJuIEUuY2FsbCh0aGlzLEkscWEsdGEsdmEseGEpO2Nhc2UgNjpyZXR1cm4gQi5jYWxsKHRoaXMsSSxxYSx0YSx2YSx4YSxDYSk7Y2FzZSA3OnJldHVybiB5LmNhbGwodGhpcyxcbkkscWEsdGEsdmEseGEsQ2EsR2EpO2Nhc2UgODpyZXR1cm4gdi5jYWxsKHRoaXMsSSxxYSx0YSx2YSx4YSxDYSxHYSxLYSk7Y2FzZSA5OnJldHVybiB1LmNhbGwodGhpcyxJLHFhLHRhLHZhLHhhLENhLEdhLEthLE9hKTtjYXNlIDEwOnJldHVybiBzLmNhbGwodGhpcyxJLHFhLHRhLHZhLHhhLENhLEdhLEthLE9hLFNhKTtjYXNlIDExOnJldHVybiBxLmNhbGwodGhpcyxJLHFhLHRhLHZhLHhhLENhLEdhLEthLE9hLFNhLFlhKTtjYXNlIDEyOnJldHVybiBwLmNhbGwodGhpcyxJLHFhLHRhLHZhLHhhLENhLEdhLEthLE9hLFNhLFlhLGdiKTtjYXNlIDEzOnJldHVybiBtLmNhbGwodGhpcyxJLHFhLHRhLHZhLHhhLENhLEdhLEthLE9hLFNhLFlhLGdiLG9iKTtjYXNlIDE0OnJldHVybiBsLmNhbGwodGhpcyxJLHFhLHRhLHZhLHhhLENhLEdhLEthLE9hLFNhLFlhLGdiLG9iLEFiKTtjYXNlIDE1OnJldHVybiBoLmNhbGwodGhpcyxJLHFhLHRhLHZhLHhhLENhLEdhLEthLE9hLFNhLFlhLGdiLFxub2IsQWIsV2IpO2Nhc2UgMTY6cmV0dXJuIGcuY2FsbCh0aGlzLEkscWEsdGEsdmEseGEsQ2EsR2EsS2EsT2EsU2EsWWEsZ2Isb2IsQWIsV2IsamMpO2Nhc2UgMTc6cmV0dXJuIGYuY2FsbCh0aGlzLEkscWEsdGEsdmEseGEsQ2EsR2EsS2EsT2EsU2EsWWEsZ2Isb2IsQWIsV2IsamMsemMpO2Nhc2UgMTg6cmV0dXJuIGUuY2FsbCh0aGlzLEkscWEsdGEsdmEseGEsQ2EsR2EsS2EsT2EsU2EsWWEsZ2Isb2IsQWIsV2IsamMsemMsWmMpO2Nhc2UgMTk6cmV0dXJuIGQuY2FsbCh0aGlzLEkscWEsdGEsdmEseGEsQ2EsR2EsS2EsT2EsU2EsWWEsZ2Isb2IsQWIsV2IsamMsemMsWmMsR2QpO2Nhc2UgMjA6cmV0dXJuIGMuY2FsbCh0aGlzLEkscWEsdGEsdmEseGEsQ2EsR2EsS2EsT2EsU2EsWWEsZ2Isb2IsQWIsV2IsamMsemMsWmMsR2QsRGUpO2Nhc2UgMjE6cmV0dXJuIGIuY2FsbCh0aGlzLEkscWEsdGEsdmEseGEsQ2EsR2EsS2EsT2EsU2EsWWEsZ2Isb2IsQWIsV2IsamMsemMsWmMsR2QsRGUsXG5XZik7Y2FzZSAyMjpyZXR1cm4gYS5jYWxsKHRoaXMsSSxxYSx0YSx2YSx4YSxDYSxHYSxLYSxPYSxTYSxZYSxnYixvYixBYixXYixqYyx6YyxaYyxHZCxEZSxXZixkaCl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O0kuYj1QYTtJLmE9cmE7SS5jPVk7SS5uPU47SS5yPUU7SS5QPUI7SS5pYT15O0kuR2E9djtJLkhhPXU7SS52YT1zO0kud2E9cTtJLnhhPXA7SS55YT1tO0kuemE9bDtJLkFhPWg7SS5CYT1nO0kuQ2E9ZjtJLkRhPWU7SS5FYT1kO0kuRmE9YztJLmhjPWI7SS51Yj1hO3JldHVybiBJfSgpO2suYXBwbHk9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gdGhpcy5jYWxsLmFwcGx5KHRoaXMsW3RoaXNdLmNvbmNhdChGYShiKSkpfTtrLmw9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5oLmw/dGhpcy5oLmwoKTp0aGlzLmguY2FsbChudWxsKX07XG5rLmI9ZnVuY3Rpb24oYSl7cmV0dXJuIHRoaXMuaC5iP3RoaXMuaC5iKGEpOnRoaXMuaC5jYWxsKG51bGwsYSl9O2suYT1mdW5jdGlvbihhLGIpe3JldHVybiB0aGlzLmguYT90aGlzLmguYShhLGIpOnRoaXMuaC5jYWxsKG51bGwsYSxiKX07ay5jPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gdGhpcy5oLmM/dGhpcy5oLmMoYSxiLGMpOnRoaXMuaC5jYWxsKG51bGwsYSxiLGMpfTtrLm49ZnVuY3Rpb24oYSxiLGMsZCl7cmV0dXJuIHRoaXMuaC5uP3RoaXMuaC5uKGEsYixjLGQpOnRoaXMuaC5jYWxsKG51bGwsYSxiLGMsZCl9O2sucj1mdW5jdGlvbihhLGIsYyxkLGUpe3JldHVybiB0aGlzLmgucj90aGlzLmgucihhLGIsYyxkLGUpOnRoaXMuaC5jYWxsKG51bGwsYSxiLGMsZCxlKX07ay5QPWZ1bmN0aW9uKGEsYixjLGQsZSxmKXtyZXR1cm4gdGhpcy5oLlA/dGhpcy5oLlAoYSxiLGMsZCxlLGYpOnRoaXMuaC5jYWxsKG51bGwsYSxiLGMsZCxlLGYpfTtcbmsuaWE9ZnVuY3Rpb24oYSxiLGMsZCxlLGYsZyl7cmV0dXJuIHRoaXMuaC5pYT90aGlzLmguaWEoYSxiLGMsZCxlLGYsZyk6dGhpcy5oLmNhbGwobnVsbCxhLGIsYyxkLGUsZixnKX07ay5HYT1mdW5jdGlvbihhLGIsYyxkLGUsZixnLGgpe3JldHVybiB0aGlzLmguR2E/dGhpcy5oLkdhKGEsYixjLGQsZSxmLGcsaCk6dGhpcy5oLmNhbGwobnVsbCxhLGIsYyxkLGUsZixnLGgpfTtrLkhhPWZ1bmN0aW9uKGEsYixjLGQsZSxmLGcsaCxsKXtyZXR1cm4gdGhpcy5oLkhhP3RoaXMuaC5IYShhLGIsYyxkLGUsZixnLGgsbCk6dGhpcy5oLmNhbGwobnVsbCxhLGIsYyxkLGUsZixnLGgsbCl9O2sudmE9ZnVuY3Rpb24oYSxiLGMsZCxlLGYsZyxoLGwsbSl7cmV0dXJuIHRoaXMuaC52YT90aGlzLmgudmEoYSxiLGMsZCxlLGYsZyxoLGwsbSk6dGhpcy5oLmNhbGwobnVsbCxhLGIsYyxkLGUsZixnLGgsbCxtKX07XG5rLndhPWZ1bmN0aW9uKGEsYixjLGQsZSxmLGcsaCxsLG0scCl7cmV0dXJuIHRoaXMuaC53YT90aGlzLmgud2EoYSxiLGMsZCxlLGYsZyxoLGwsbSxwKTp0aGlzLmguY2FsbChudWxsLGEsYixjLGQsZSxmLGcsaCxsLG0scCl9O2sueGE9ZnVuY3Rpb24oYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEpe3JldHVybiB0aGlzLmgueGE/dGhpcy5oLnhhKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxKTp0aGlzLmguY2FsbChudWxsLGEsYixjLGQsZSxmLGcsaCxsLG0scCxxKX07ay55YT1mdW5jdGlvbihhLGIsYyxkLGUsZixnLGgsbCxtLHAscSxzKXtyZXR1cm4gdGhpcy5oLnlhP3RoaXMuaC55YShhLGIsYyxkLGUsZixnLGgsbCxtLHAscSxzKTp0aGlzLmguY2FsbChudWxsLGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHMpfTtcbmsuemE9ZnVuY3Rpb24oYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1KXtyZXR1cm4gdGhpcy5oLnphP3RoaXMuaC56YShhLGIsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUpOnRoaXMuaC5jYWxsKG51bGwsYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1KX07ay5BYT1mdW5jdGlvbihhLGIsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdil7cmV0dXJuIHRoaXMuaC5BYT90aGlzLmguQWEoYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYpOnRoaXMuaC5jYWxsKG51bGwsYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYpfTtrLkJhPWZ1bmN0aW9uKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHkpe3JldHVybiB0aGlzLmguQmE/dGhpcy5oLkJhKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHkpOnRoaXMuaC5jYWxsKG51bGwsYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSl9O1xuay5DYT1mdW5jdGlvbihhLGIsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIpe3JldHVybiB0aGlzLmguQ2E/dGhpcy5oLkNhKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQik6dGhpcy5oLmNhbGwobnVsbCxhLGIsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIpfTtrLkRhPWZ1bmN0aW9uKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQixFKXtyZXR1cm4gdGhpcy5oLkRhP3RoaXMuaC5EYShhLGIsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIsRSk6dGhpcy5oLmNhbGwobnVsbCxhLGIsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIsRSl9O1xuay5FYT1mdW5jdGlvbihhLGIsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIsRSxOKXtyZXR1cm4gdGhpcy5oLkVhP3RoaXMuaC5FYShhLGIsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIsRSxOKTp0aGlzLmguY2FsbChudWxsLGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQixFLE4pfTtrLkZhPWZ1bmN0aW9uKGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQixFLE4sWSl7cmV0dXJuIHRoaXMuaC5GYT90aGlzLmguRmEoYSxiLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCLEUsTixZKTp0aGlzLmguY2FsbChudWxsLGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQixFLE4sWSl9O1xuay5oYz1mdW5jdGlvbihhLGIsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIsRSxOLFkscmEpe3ZhciBQYT10aGlzLmg7cmV0dXJuIFQudWI/VC51YihQYSxhLGIsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIsRSxOLFkscmEpOlQuY2FsbChudWxsLFBhLGEsYixjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQixFLE4sWSxyYSl9O2suYmM9ITA7ay5GPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyBVYyh0aGlzLmgsYil9O2suSD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmt9O2Z1bmN0aW9uIE8oYSxiKXtyZXR1cm4gVGMoYSkmJiEoYT9hLmomMjYyMTQ0fHxhLkJjfHwoYS5qPzA6dyh0YixhKSk6dyh0YixhKSk/bmV3IFVjKGEsYik6bnVsbD09YT9udWxsOnViKGEsYil9ZnVuY3Rpb24gVmMoYSl7dmFyIGI9bnVsbCE9YTtyZXR1cm4oYj9hP2EuaiYxMzEwNzJ8fGEua2N8fChhLmo/MDp3KHJiLGEpKTp3KHJiLGEpOmIpP3NiKGEpOm51bGx9XG5mdW5jdGlvbiBXYyhhKXtyZXR1cm4gbnVsbD09YT9udWxsOmxiKGEpfVxudmFyIFhjPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIpe3JldHVybiBudWxsPT1hP251bGw6a2IoYSxiKX12YXIgYj1udWxsLGM9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGIsZCxoKXt2YXIgbD1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBsPTAsbT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2w8bS5sZW5ndGg7KW1bbF09YXJndW1lbnRzW2wrMl0sKytsO2w9bmV3IEYobSwwKX1yZXR1cm4gYy5jYWxsKHRoaXMsYixkLGwpfWZ1bmN0aW9uIGMoYSxkLGUpe2Zvcig7Oyl7aWYobnVsbD09YSlyZXR1cm4gbnVsbDthPWIuYShhLGQpO2lmKHQoZSkpZD1HKGUpLGU9SyhlKTtlbHNlIHJldHVybiBhfX1hLmk9MjthLmY9ZnVuY3Rpb24oYSl7dmFyIGI9RyhhKTthPUsoYSk7dmFyIGQ9RyhhKTthPUgoYSk7cmV0dXJuIGMoYixkLGEpfTthLmQ9YztyZXR1cm4gYX0oKSxiPWZ1bmN0aW9uKGIsZSxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsXG5iLGUpO2RlZmF1bHQ6dmFyIGc9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZz0wLGg9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtnPGgubGVuZ3RoOyloW2ddPWFyZ3VtZW50c1tnKzJdLCsrZztnPW5ldyBGKGgsMCl9cmV0dXJuIGMuZChiLGUsZyl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2IuaT0yO2IuZj1jLmY7Yi5iPWZ1bmN0aW9uKGEpe3JldHVybiBhfTtiLmE9YTtiLmQ9Yy5kO3JldHVybiBifSgpO2Z1bmN0aW9uIFljKGEpe3JldHVybiBudWxsPT1hfHxBYShEKGEpKX1mdW5jdGlvbiAkYyhhKXtyZXR1cm4gbnVsbD09YT8hMTphP2EuaiY4fHxhLnRjPyEwOmEuaj8hMTp3KFFhLGEpOncoUWEsYSl9ZnVuY3Rpb24gYWQoYSl7cmV0dXJuIG51bGw9PWE/ITE6YT9hLmomNDA5Nnx8YS56Yz8hMDphLmo/ITE6dyhqYixhKTp3KGpiLGEpfVxuZnVuY3Rpb24gYmQoYSl7cmV0dXJuIGE/YS5qJjUxMnx8YS5yYz8hMDphLmo/ITE6dyhhYixhKTp3KGFiLGEpfWZ1bmN0aW9uIGNkKGEpe3JldHVybiBhP2EuaiYxNjc3NzIxNnx8YS55Yz8hMDphLmo/ITE6dyhEYixhKTp3KERiLGEpfWZ1bmN0aW9uIGRkKGEpe3JldHVybiBudWxsPT1hPyExOmE/YS5qJjEwMjR8fGEuaWM/ITA6YS5qPyExOncoZGIsYSk6dyhkYixhKX1mdW5jdGlvbiBlZChhKXtyZXR1cm4gYT9hLmomMTYzODR8fGEuQWM/ITA6YS5qPyExOncobmIsYSk6dyhuYixhKX1mdW5jdGlvbiBmZChhKXtyZXR1cm4gYT9hLnEmNTEyfHxhLnNjPyEwOiExOiExfWZ1bmN0aW9uIGdkKGEpe3ZhciBiPVtdO2VhKGEsZnVuY3Rpb24oYSxiKXtyZXR1cm4gZnVuY3Rpb24oYSxjKXtyZXR1cm4gYi5wdXNoKGMpfX0oYSxiKSk7cmV0dXJuIGJ9ZnVuY3Rpb24gaGQoYSxiLGMsZCxlKXtmb3IoOzAhPT1lOyljW2RdPWFbYl0sZCs9MSxlLT0xLGIrPTF9XG5mdW5jdGlvbiBpZChhLGIsYyxkLGUpe2IrPWUtMTtmb3IoZCs9ZS0xOzAhPT1lOyljW2RdPWFbYl0sZC09MSxlLT0xLGItPTF9dmFyIGpkPXt9O2Z1bmN0aW9uIGtkKGEpe3JldHVybiBudWxsPT1hPyExOmE/YS5qJjY0fHxhLmpiPyEwOmEuaj8hMTp3KFVhLGEpOncoVWEsYSl9ZnVuY3Rpb24gbGQoYSl7cmV0dXJuIGE/YS5qJjgzODg2MDh8fGEubWM/ITA6YS5qPyExOncoQmIsYSk6dyhCYixhKX1mdW5jdGlvbiBtZChhKXtyZXR1cm4gdChhKT8hMDohMX1mdW5jdGlvbiBuZChhLGIpe3JldHVybiBTLmMoYSxiLGpkKT09PWpkPyExOiEwfVxuZnVuY3Rpb24gb2QoYSxiKXtpZihhPT09YilyZXR1cm4gMDtpZihudWxsPT1hKXJldHVybi0xO2lmKG51bGw9PWIpcmV0dXJuIDE7aWYoQmEoYSk9PT1CYShiKSlyZXR1cm4gYSYmKGEucSYyMDQ4fHxhLnNiKT9hLnRiKG51bGwsYik6aGEoYSxiKTt0aHJvdyBFcnJvcihcImNvbXBhcmUgb24gbm9uLW5pbCBvYmplY3RzIG9mIGRpZmZlcmVudCB0eXBlc1wiKTt9XG52YXIgcGQ9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjLGcpe2Zvcig7Oyl7dmFyIGg9b2QoUi5hKGEsZyksUi5hKGIsZykpO2lmKDA9PT1oJiZnKzE8YylnKz0xO2Vsc2UgcmV0dXJuIGh9fWZ1bmN0aW9uIGIoYSxiKXt2YXIgZj1RKGEpLGc9UShiKTtyZXR1cm4gZjxnPy0xOmY+Zz8xOmMubihhLGIsZiwwKX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlLGYsZyl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gYi5jYWxsKHRoaXMsYyxlKTtjYXNlIDQ6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSxmLGcpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmE9YjtjLm49YTtyZXR1cm4gY30oKTtcbmZ1bmN0aW9uIHFkKGEpe3JldHVybiBzYy5hKGEsb2QpP29kOmZ1bmN0aW9uKGIsYyl7dmFyIGQ9YS5hP2EuYShiLGMpOmEuY2FsbChudWxsLGIsYyk7cmV0dXJuXCJudW1iZXJcIj09PXR5cGVvZiBkP2Q6dChkKT8tMTp0KGEuYT9hLmEoYyxiKTphLmNhbGwobnVsbCxjLGIpKT8xOjB9fVxudmFyIHNkPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIpe2lmKEQoYikpe3ZhciBjPXJkLmI/cmQuYihiKTpyZC5jYWxsKG51bGwsYiksZz1xZChhKTtpYShjLGcpO3JldHVybiBEKGMpfXJldHVybiBKfWZ1bmN0aW9uIGIoYSl7cmV0dXJuIGMuYShvZCxhKX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiLmNhbGwodGhpcyxjKTtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYj1iO2MuYT1hO3JldHVybiBjfSgpLHRkPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyl7cmV0dXJuIHNkLmEoZnVuY3Rpb24oYyxmKXtyZXR1cm4gcWQoYikuY2FsbChudWxsLGEuYj9hLmIoYyk6YS5jYWxsKG51bGwsYyksYS5iP2EuYihmKTphLmNhbGwobnVsbCxmKSl9LGMpfWZ1bmN0aW9uIGIoYSxiKXtyZXR1cm4gYy5jKGEsb2QsXG5iKX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIGIuY2FsbCh0aGlzLGMsZSk7Y2FzZSAzOnJldHVybiBhLmNhbGwodGhpcyxjLGUsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYT1iO2MuYz1hO3JldHVybiBjfSgpLFA9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjKXtmb3IoYz1EKGMpOzspaWYoYyl7dmFyIGc9RyhjKTtiPWEuYT9hLmEoYixnKTphLmNhbGwobnVsbCxiLGcpO2lmKEFjKGIpKXJldHVybiBxYihiKTtjPUsoYyl9ZWxzZSByZXR1cm4gYn1mdW5jdGlvbiBiKGEsYil7dmFyIGM9RChiKTtpZihjKXt2YXIgZz1HKGMpLGM9SyhjKTtyZXR1cm4gQS5jP0EuYyhhLGcsYyk6QS5jYWxsKG51bGwsYSxnLGMpfXJldHVybiBhLmw/YS5sKCk6YS5jYWxsKG51bGwpfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gYi5jYWxsKHRoaXMsXG5jLGUpO2Nhc2UgMzpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmE9YjtjLmM9YTtyZXR1cm4gY30oKSxBPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyl7cmV0dXJuIGMmJihjLmomNTI0Mjg4fHxjLlNiKT9jLk8obnVsbCxhLGIpOmMgaW5zdGFuY2VvZiBBcnJheT9EYy5jKGMsYSxiKTpcInN0cmluZ1wiPT09dHlwZW9mIGM/RGMuYyhjLGEsYik6dyh2YixjKT93Yi5jKGMsYSxiKTpQLmMoYSxiLGMpfWZ1bmN0aW9uIGIoYSxiKXtyZXR1cm4gYiYmKGIuaiY1MjQyODh8fGIuU2IpP2IuUihudWxsLGEpOmIgaW5zdGFuY2VvZiBBcnJheT9EYy5hKGIsYSk6XCJzdHJpbmdcIj09PXR5cGVvZiBiP0RjLmEoYixhKTp3KHZiLGIpP3diLmEoYixhKTpQLmEoYSxiKX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIGIuY2FsbCh0aGlzLFxuYyxlKTtjYXNlIDM6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSxmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5hPWI7Yy5jPWE7cmV0dXJuIGN9KCk7ZnVuY3Rpb24gdWQoYSl7cmV0dXJuIGF9XG52YXIgdmQ9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYil7cmV0dXJuIGZ1bmN0aW9uKCl7ZnVuY3Rpb24gYyhiLGUpe3JldHVybiBhLmE/YS5hKGIsZSk6YS5jYWxsKG51bGwsYixlKX1mdW5jdGlvbiBnKGEpe3JldHVybiBiLmI/Yi5iKGEpOmIuY2FsbChudWxsLGEpfWZ1bmN0aW9uIGgoKXtyZXR1cm4gYS5sP2EubCgpOmEuY2FsbChudWxsKX12YXIgbD1udWxsLGw9ZnVuY3Rpb24oYSxiKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAwOnJldHVybiBoLmNhbGwodGhpcyk7Y2FzZSAxOnJldHVybiBnLmNhbGwodGhpcyxhKTtjYXNlIDI6cmV0dXJuIGMuY2FsbCh0aGlzLGEsYil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2wubD1oO2wuYj1nO2wuYT1jO3JldHVybiBsfSgpfWZ1bmN0aW9uIGIoYSl7cmV0dXJuIGMuYShhLHVkKX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiLmNhbGwodGhpcyxcbmMpO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5iPWI7Yy5hPWE7cmV0dXJuIGN9KCksd2Q9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjLGcpe2E9YS5iP2EuYihiKTphLmNhbGwobnVsbCxiKTtjPUEuYyhhLGMsZyk7cmV0dXJuIGEuYj9hLmIoYyk6YS5jYWxsKG51bGwsYyl9ZnVuY3Rpb24gYihhLGIsZil7cmV0dXJuIGMubihhLGIsYi5sP2IubCgpOmIuY2FsbChudWxsKSxmKX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlLGYsZyl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMzpyZXR1cm4gYi5jYWxsKHRoaXMsYyxlLGYpO2Nhc2UgNDpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlLGYsZyl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYz1iO2Mubj1hO3JldHVybiBjfSgpLHhkPWZ1bmN0aW9uKCl7dmFyIGE9bnVsbCxiPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYihhLFxuYyxnKXt2YXIgaD1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBoPTAsbD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2g8bC5sZW5ndGg7KWxbaF09YXJndW1lbnRzW2grMl0sKytoO2g9bmV3IEYobCwwKX1yZXR1cm4gZC5jYWxsKHRoaXMsYSxjLGgpfWZ1bmN0aW9uIGQoYixjLGQpe3JldHVybiBBLmMoYSxiK2MsZCl9Yi5pPTI7Yi5mPWZ1bmN0aW9uKGEpe3ZhciBiPUcoYSk7YT1LKGEpO3ZhciBjPUcoYSk7YT1IKGEpO3JldHVybiBkKGIsYyxhKX07Yi5kPWQ7cmV0dXJuIGJ9KCksYT1mdW5jdGlvbihhLGQsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMDpyZXR1cm4gMDtjYXNlIDE6cmV0dXJuIGE7Y2FzZSAyOnJldHVybiBhK2Q7ZGVmYXVsdDp2YXIgZj1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBmPTAsZz1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2Y8Zy5sZW5ndGg7KWdbZl09YXJndW1lbnRzW2YrMl0sKytmO2Y9bmV3IEYoZyxcbjApfXJldHVybiBiLmQoYSxkLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTthLmk9MjthLmY9Yi5mO2EubD1mdW5jdGlvbigpe3JldHVybiAwfTthLmI9ZnVuY3Rpb24oYSl7cmV0dXJuIGF9O2EuYT1mdW5jdGlvbihhLGIpe3JldHVybiBhK2J9O2EuZD1iLmQ7cmV0dXJuIGF9KCkseWQ9ZnVuY3Rpb24oKXt2YXIgYT1udWxsLGI9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGMsZixnKXt2YXIgaD1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBoPTAsbD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2g8bC5sZW5ndGg7KWxbaF09YXJndW1lbnRzW2grMl0sKytoO2g9bmV3IEYobCwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsYyxmLGgpfWZ1bmN0aW9uIGIoYSxjLGQpe2Zvcig7OylpZihhPGMpaWYoSyhkKSlhPWMsYz1HKGQpLGQ9SyhkKTtlbHNlIHJldHVybiBjPEcoZCk7ZWxzZSByZXR1cm4hMX1hLmk9MjthLmY9ZnVuY3Rpb24oYSl7dmFyIGM9XG5HKGEpO2E9SyhhKTt2YXIgZz1HKGEpO2E9SChhKTtyZXR1cm4gYihjLGcsYSl9O2EuZD1iO3JldHVybiBhfSgpLGE9ZnVuY3Rpb24oYSxkLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuITA7Y2FzZSAyOnJldHVybiBhPGQ7ZGVmYXVsdDp2YXIgZj1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBmPTAsZz1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2Y8Zy5sZW5ndGg7KWdbZl09YXJndW1lbnRzW2YrMl0sKytmO2Y9bmV3IEYoZywwKX1yZXR1cm4gYi5kKGEsZCxmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307YS5pPTI7YS5mPWIuZjthLmI9ZnVuY3Rpb24oKXtyZXR1cm4hMH07YS5hPWZ1bmN0aW9uKGEsYil7cmV0dXJuIGE8Yn07YS5kPWIuZDtyZXR1cm4gYX0oKSx6ZD1mdW5jdGlvbigpe3ZhciBhPW51bGwsYj1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYyxmLGcpe3ZhciBoPW51bGw7aWYoMjxcbmFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgaD0wLGw9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtoPGwubGVuZ3RoOylsW2hdPWFyZ3VtZW50c1toKzJdLCsraDtoPW5ldyBGKGwsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGMsZixoKX1mdW5jdGlvbiBiKGEsYyxkKXtmb3IoOzspaWYoYTw9YylpZihLKGQpKWE9YyxjPUcoZCksZD1LKGQpO2Vsc2UgcmV0dXJuIGM8PUcoZCk7ZWxzZSByZXR1cm4hMX1hLmk9MjthLmY9ZnVuY3Rpb24oYSl7dmFyIGM9RyhhKTthPUsoYSk7dmFyIGc9RyhhKTthPUgoYSk7cmV0dXJuIGIoYyxnLGEpfTthLmQ9YjtyZXR1cm4gYX0oKSxhPWZ1bmN0aW9uKGEsZCxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiEwO2Nhc2UgMjpyZXR1cm4gYTw9ZDtkZWZhdWx0OnZhciBmPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGY9MCxnPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7ZjxnLmxlbmd0aDspZ1tmXT1hcmd1bWVudHNbZitcbjJdLCsrZjtmPW5ldyBGKGcsMCl9cmV0dXJuIGIuZChhLGQsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2EuaT0yO2EuZj1iLmY7YS5iPWZ1bmN0aW9uKCl7cmV0dXJuITB9O2EuYT1mdW5jdGlvbihhLGIpe3JldHVybiBhPD1ifTthLmQ9Yi5kO3JldHVybiBhfSgpLEFkPWZ1bmN0aW9uKCl7dmFyIGE9bnVsbCxiPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShjLGYsZyl7dmFyIGg9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgaD0wLGw9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtoPGwubGVuZ3RoOylsW2hdPWFyZ3VtZW50c1toKzJdLCsraDtoPW5ldyBGKGwsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGMsZixoKX1mdW5jdGlvbiBiKGEsYyxkKXtmb3IoOzspaWYoYT5jKWlmKEsoZCkpYT1jLGM9RyhkKSxkPUsoZCk7ZWxzZSByZXR1cm4gYz5HKGQpO2Vsc2UgcmV0dXJuITF9YS5pPTI7YS5mPWZ1bmN0aW9uKGEpe3ZhciBjPVxuRyhhKTthPUsoYSk7dmFyIGc9RyhhKTthPUgoYSk7cmV0dXJuIGIoYyxnLGEpfTthLmQ9YjtyZXR1cm4gYX0oKSxhPWZ1bmN0aW9uKGEsZCxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiEwO2Nhc2UgMjpyZXR1cm4gYT5kO2RlZmF1bHQ6dmFyIGY9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZj0wLGc9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtmPGcubGVuZ3RoOylnW2ZdPWFyZ3VtZW50c1tmKzJdLCsrZjtmPW5ldyBGKGcsMCl9cmV0dXJuIGIuZChhLGQsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2EuaT0yO2EuZj1iLmY7YS5iPWZ1bmN0aW9uKCl7cmV0dXJuITB9O2EuYT1mdW5jdGlvbihhLGIpe3JldHVybiBhPmJ9O2EuZD1iLmQ7cmV0dXJuIGF9KCksQmQ9ZnVuY3Rpb24oKXt2YXIgYT1udWxsLGI9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGMsZixnKXt2YXIgaD1udWxsO2lmKDI8XG5hcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGg9MCxsPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7aDxsLmxlbmd0aDspbFtoXT1hcmd1bWVudHNbaCsyXSwrK2g7aD1uZXcgRihsLDApfXJldHVybiBiLmNhbGwodGhpcyxjLGYsaCl9ZnVuY3Rpb24gYihhLGMsZCl7Zm9yKDs7KWlmKGE+PWMpaWYoSyhkKSlhPWMsYz1HKGQpLGQ9SyhkKTtlbHNlIHJldHVybiBjPj1HKGQpO2Vsc2UgcmV0dXJuITF9YS5pPTI7YS5mPWZ1bmN0aW9uKGEpe3ZhciBjPUcoYSk7YT1LKGEpO3ZhciBnPUcoYSk7YT1IKGEpO3JldHVybiBiKGMsZyxhKX07YS5kPWI7cmV0dXJuIGF9KCksYT1mdW5jdGlvbihhLGQsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4hMDtjYXNlIDI6cmV0dXJuIGE+PWQ7ZGVmYXVsdDp2YXIgZj1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBmPTAsZz1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2Y8Zy5sZW5ndGg7KWdbZl09YXJndW1lbnRzW2YrXG4yXSwrK2Y7Zj1uZXcgRihnLDApfXJldHVybiBiLmQoYSxkLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTthLmk9MjthLmY9Yi5mO2EuYj1mdW5jdGlvbigpe3JldHVybiEwfTthLmE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gYT49Yn07YS5kPWIuZDtyZXR1cm4gYX0oKTtmdW5jdGlvbiBDZChhLGIpe3ZhciBjPShhLWElYikvYjtyZXR1cm4gMDw9Yz9NYXRoLmZsb29yLmI/TWF0aC5mbG9vci5iKGMpOk1hdGguZmxvb3IuY2FsbChudWxsLGMpOk1hdGguY2VpbC5iP01hdGguY2VpbC5iKGMpOk1hdGguY2VpbC5jYWxsKG51bGwsYyl9ZnVuY3Rpb24gRGQoYSl7YS09YT4+MSYxNDMxNjU1NzY1O2E9KGEmODU4OTkzNDU5KSsoYT4+MiY4NTg5OTM0NTkpO3JldHVybiAxNjg0MzAwOSooYSsoYT4+NCkmMjUyNjQ1MTM1KT4+MjR9XG5mdW5jdGlvbiBFZChhKXt2YXIgYj0xO2ZvcihhPUQoYSk7OylpZihhJiYwPGIpYi09MSxhPUsoYSk7ZWxzZSByZXR1cm4gYX1cbnZhciB6PWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhKXtyZXR1cm4gbnVsbD09YT9cIlwiOmRhKGEpfXZhciBiPW51bGwsYz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYixkKXt2YXIgaD1udWxsO2lmKDE8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBoPTAsbD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTEpO2g8bC5sZW5ndGg7KWxbaF09YXJndW1lbnRzW2grMV0sKytoO2g9bmV3IEYobCwwKX1yZXR1cm4gYy5jYWxsKHRoaXMsYixoKX1mdW5jdGlvbiBjKGEsZCl7Zm9yKHZhciBlPW5ldyBmYShiLmIoYSkpLGw9ZDs7KWlmKHQobCkpZT1lLmFwcGVuZChiLmIoRyhsKSkpLGw9SyhsKTtlbHNlIHJldHVybiBlLnRvU3RyaW5nKCl9YS5pPTE7YS5mPWZ1bmN0aW9uKGEpe3ZhciBiPUcoYSk7YT1IKGEpO3JldHVybiBjKGIsYSl9O2EuZD1jO3JldHVybiBhfSgpLGI9ZnVuY3Rpb24oYixlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAwOnJldHVyblwiXCI7Y2FzZSAxOnJldHVybiBhLmNhbGwodGhpcyxcbmIpO2RlZmF1bHQ6dmFyIGY9bnVsbDtpZigxPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZj0wLGc9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0xKTtmPGcubGVuZ3RoOylnW2ZdPWFyZ3VtZW50c1tmKzFdLCsrZjtmPW5ldyBGKGcsMCl9cmV0dXJuIGMuZChiLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtiLmk9MTtiLmY9Yy5mO2IubD1mdW5jdGlvbigpe3JldHVyblwiXCJ9O2IuYj1hO2IuZD1jLmQ7cmV0dXJuIGJ9KCk7ZnVuY3Rpb24gSWMoYSxiKXt2YXIgYztpZihjZChiKSlpZihFYyhhKSYmRWMoYikmJlEoYSkhPT1RKGIpKWM9ITE7ZWxzZSBhOntjPUQoYSk7Zm9yKHZhciBkPUQoYik7Oyl7aWYobnVsbD09Yyl7Yz1udWxsPT1kO2JyZWFrIGF9aWYobnVsbCE9ZCYmc2MuYShHKGMpLEcoZCkpKWM9SyhjKSxkPUsoZCk7ZWxzZXtjPSExO2JyZWFrIGF9fWM9dm9pZCAwfWVsc2UgYz1udWxsO3JldHVybiBtZChjKX1cbmZ1bmN0aW9uIEZkKGEsYixjLGQsZSl7dGhpcy5rPWE7dGhpcy5maXJzdD1iO3RoaXMuTT1jO3RoaXMuY291bnQ9ZDt0aGlzLnA9ZTt0aGlzLmo9NjU5Mzc2NDY7dGhpcy5xPTgxOTJ9az1GZC5wcm90b3R5cGU7ay50b1N0cmluZz1mdW5jdGlvbigpe3JldHVybiBlYyh0aGlzKX07ay5IPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMua307ay5UPWZ1bmN0aW9uKCl7cmV0dXJuIDE9PT10aGlzLmNvdW50P251bGw6dGhpcy5NfTtrLkw9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5jb3VudH07ay5MYT1mdW5jdGlvbigpe3JldHVybiB0aGlzLmZpcnN0fTtrLk1hPWZ1bmN0aW9uKCl7cmV0dXJuIFdhKHRoaXMpfTtrLkI9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLnA7cmV0dXJuIG51bGwhPWE/YTp0aGlzLnA9YT13Yyh0aGlzKX07ay5BPWZ1bmN0aW9uKGEsYil7cmV0dXJuIEljKHRoaXMsYil9O2suSj1mdW5jdGlvbigpe3JldHVybiB1YihKLHRoaXMuayl9O1xuay5SPWZ1bmN0aW9uKGEsYil7cmV0dXJuIFAuYShiLHRoaXMpfTtrLk89ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBQLmMoYixjLHRoaXMpfTtrLk49ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5maXJzdH07ay5TPWZ1bmN0aW9uKCl7cmV0dXJuIDE9PT10aGlzLmNvdW50P0o6dGhpcy5NfTtrLkQ9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpc307ay5GPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyBGZChiLHRoaXMuZmlyc3QsdGhpcy5NLHRoaXMuY291bnQsdGhpcy5wKX07ay5HPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyBGZCh0aGlzLmssYix0aGlzLHRoaXMuY291bnQrMSxudWxsKX07RmQucHJvdG90eXBlW0VhXT1mdW5jdGlvbigpe3JldHVybiB1Yyh0aGlzKX07ZnVuY3Rpb24gSGQoYSl7dGhpcy5rPWE7dGhpcy5qPTY1OTM3NjE0O3RoaXMucT04MTkyfWs9SGQucHJvdG90eXBlO2sudG9TdHJpbmc9ZnVuY3Rpb24oKXtyZXR1cm4gZWModGhpcyl9O2suSD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmt9O1xuay5UPWZ1bmN0aW9uKCl7cmV0dXJuIG51bGx9O2suTD1mdW5jdGlvbigpe3JldHVybiAwfTtrLkxhPWZ1bmN0aW9uKCl7cmV0dXJuIG51bGx9O2suTWE9ZnVuY3Rpb24oKXt0aHJvdyBFcnJvcihcIkNhbid0IHBvcCBlbXB0eSBsaXN0XCIpO307ay5CPWZ1bmN0aW9uKCl7cmV0dXJuIDB9O2suQT1mdW5jdGlvbihhLGIpe3JldHVybiBJYyh0aGlzLGIpfTtrLko9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpc307ay5SPWZ1bmN0aW9uKGEsYil7cmV0dXJuIFAuYShiLHRoaXMpfTtrLk89ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBQLmMoYixjLHRoaXMpfTtrLk49ZnVuY3Rpb24oKXtyZXR1cm4gbnVsbH07ay5TPWZ1bmN0aW9uKCl7cmV0dXJuIEp9O2suRD1mdW5jdGlvbigpe3JldHVybiBudWxsfTtrLkY9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IEhkKGIpfTtrLkc9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IEZkKHRoaXMuayxiLG51bGwsMSxudWxsKX07dmFyIEo9bmV3IEhkKG51bGwpO1xuSGQucHJvdG90eXBlW0VhXT1mdW5jdGlvbigpe3JldHVybiB1Yyh0aGlzKX07ZnVuY3Rpb24gSWQoYSl7cmV0dXJuIGE/YS5qJjEzNDIxNzcyOHx8YS54Yz8hMDphLmo/ITE6dyhGYixhKTp3KEZiLGEpfWZ1bmN0aW9uIEpkKGEpe3JldHVybiBJZChhKT9HYihhKTpBLmMoTmMsSixhKX1cbnZhciBLZD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSl7dmFyIGQ9bnVsbDtpZigwPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZD0wLGU9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0wKTtkPGUubGVuZ3RoOyllW2RdPWFyZ3VtZW50c1tkKzBdLCsrZDtkPW5ldyBGKGUsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGQpfWZ1bmN0aW9uIGIoYSl7dmFyIGI7aWYoYSBpbnN0YW5jZW9mIEYmJjA9PT1hLm0pYj1hLmU7ZWxzZSBhOntmb3IoYj1bXTs7KWlmKG51bGwhPWEpYi5wdXNoKGEuTihudWxsKSksYT1hLlQobnVsbCk7ZWxzZSBicmVhayBhO2I9dm9pZCAwfWE9Yi5sZW5ndGg7Zm9yKHZhciBlPUo7OylpZigwPGEpe3ZhciBmPWEtMSxlPWUuRyhudWxsLGJbYS0xXSk7YT1mfWVsc2UgcmV0dXJuIGV9YS5pPTA7YS5mPWZ1bmN0aW9uKGEpe2E9RChhKTtyZXR1cm4gYihhKX07YS5kPWI7cmV0dXJuIGF9KCk7XG5mdW5jdGlvbiBMZChhLGIsYyxkKXt0aGlzLms9YTt0aGlzLmZpcnN0PWI7dGhpcy5NPWM7dGhpcy5wPWQ7dGhpcy5qPTY1OTI5NDUyO3RoaXMucT04MTkyfWs9TGQucHJvdG90eXBlO2sudG9TdHJpbmc9ZnVuY3Rpb24oKXtyZXR1cm4gZWModGhpcyl9O2suSD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmt9O2suVD1mdW5jdGlvbigpe3JldHVybiBudWxsPT10aGlzLk0/bnVsbDpEKHRoaXMuTSl9O2suQj1mdW5jdGlvbigpe3ZhciBhPXRoaXMucDtyZXR1cm4gbnVsbCE9YT9hOnRoaXMucD1hPXdjKHRoaXMpfTtrLkE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gSWModGhpcyxiKX07ay5KPWZ1bmN0aW9uKCl7cmV0dXJuIE8oSix0aGlzLmspfTtrLlI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gUC5hKGIsdGhpcyl9O2suTz1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIFAuYyhiLGMsdGhpcyl9O2suTj1mdW5jdGlvbigpe3JldHVybiB0aGlzLmZpcnN0fTtcbmsuUz1mdW5jdGlvbigpe3JldHVybiBudWxsPT10aGlzLk0/Sjp0aGlzLk19O2suRD1mdW5jdGlvbigpe3JldHVybiB0aGlzfTtrLkY9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IExkKGIsdGhpcy5maXJzdCx0aGlzLk0sdGhpcy5wKX07ay5HPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyBMZChudWxsLGIsdGhpcyx0aGlzLnApfTtMZC5wcm90b3R5cGVbRWFdPWZ1bmN0aW9uKCl7cmV0dXJuIHVjKHRoaXMpfTtmdW5jdGlvbiBNKGEsYil7dmFyIGM9bnVsbD09YjtyZXR1cm4oYz9jOmImJihiLmomNjR8fGIuamIpKT9uZXcgTGQobnVsbCxhLGIsbnVsbCk6bmV3IExkKG51bGwsYSxEKGIpLG51bGwpfVxuZnVuY3Rpb24gTWQoYSxiKXtpZihhLnBhPT09Yi5wYSlyZXR1cm4gMDt2YXIgYz1BYShhLmJhKTtpZih0KGM/Yi5iYTpjKSlyZXR1cm4tMTtpZih0KGEuYmEpKXtpZihBYShiLmJhKSlyZXR1cm4gMTtjPWhhKGEuYmEsYi5iYSk7cmV0dXJuIDA9PT1jP2hhKGEubmFtZSxiLm5hbWUpOmN9cmV0dXJuIGhhKGEubmFtZSxiLm5hbWUpfWZ1bmN0aW9uIFUoYSxiLGMsZCl7dGhpcy5iYT1hO3RoaXMubmFtZT1iO3RoaXMucGE9Yzt0aGlzLllhPWQ7dGhpcy5qPTIxNTM3NzUxMDU7dGhpcy5xPTQwOTZ9az1VLnByb3RvdHlwZTtrLnY9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gTGIoYixbeihcIjpcIikseih0aGlzLnBhKV0uam9pbihcIlwiKSl9O2suQj1mdW5jdGlvbigpe3ZhciBhPXRoaXMuWWE7cmV0dXJuIG51bGwhPWE/YTp0aGlzLllhPWE9b2ModGhpcykrMjY1NDQzNTc2OXwwfTtcbmsuY2FsbD1mdW5jdGlvbigpe3ZhciBhPW51bGwsYT1mdW5jdGlvbihhLGMsZCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gUy5hKGMsdGhpcyk7Y2FzZSAzOnJldHVybiBTLmMoYyx0aGlzLGQpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTthLmE9ZnVuY3Rpb24oYSxjKXtyZXR1cm4gUy5hKGMsdGhpcyl9O2EuYz1mdW5jdGlvbihhLGMsZCl7cmV0dXJuIFMuYyhjLHRoaXMsZCl9O3JldHVybiBhfSgpO2suYXBwbHk9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gdGhpcy5jYWxsLmFwcGx5KHRoaXMsW3RoaXNdLmNvbmNhdChGYShiKSkpfTtrLmI9ZnVuY3Rpb24oYSl7cmV0dXJuIFMuYShhLHRoaXMpfTtrLmE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gUy5jKGEsdGhpcyxiKX07ay5BPWZ1bmN0aW9uKGEsYil7cmV0dXJuIGIgaW5zdGFuY2VvZiBVP3RoaXMucGE9PT1iLnBhOiExfTtcbmsudG9TdHJpbmc9ZnVuY3Rpb24oKXtyZXR1cm5beihcIjpcIikseih0aGlzLnBhKV0uam9pbihcIlwiKX07ZnVuY3Rpb24gTmQoYSxiKXtyZXR1cm4gYT09PWI/ITA6YSBpbnN0YW5jZW9mIFUmJmIgaW5zdGFuY2VvZiBVP2EucGE9PT1iLnBhOiExfVxudmFyIFBkPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIpe3JldHVybiBuZXcgVShhLGIsW3oodChhKT9beihhKSx6KFwiL1wiKV0uam9pbihcIlwiKTpudWxsKSx6KGIpXS5qb2luKFwiXCIpLG51bGwpfWZ1bmN0aW9uIGIoYSl7aWYoYSBpbnN0YW5jZW9mIFUpcmV0dXJuIGE7aWYoYSBpbnN0YW5jZW9mIHFjKXt2YXIgYjtpZihhJiYoYS5xJjQwOTZ8fGEubGMpKWI9YS5iYTtlbHNlIHRocm93IEVycm9yKFt6KFwiRG9lc24ndCBzdXBwb3J0IG5hbWVzcGFjZTogXCIpLHooYSldLmpvaW4oXCJcIikpO3JldHVybiBuZXcgVShiLE9kLmI/T2QuYihhKTpPZC5jYWxsKG51bGwsYSksYS50YSxudWxsKX1yZXR1cm5cInN0cmluZ1wiPT09dHlwZW9mIGE/KGI9YS5zcGxpdChcIi9cIiksMj09PWIubGVuZ3RoP25ldyBVKGJbMF0sYlsxXSxhLG51bGwpOm5ldyBVKG51bGwsYlswXSxhLG51bGwpKTpudWxsfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGIuY2FsbCh0aGlzLFxuYyk7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxjLGUpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmI9YjtjLmE9YTtyZXR1cm4gY30oKTtmdW5jdGlvbiBWKGEsYixjLGQpe3RoaXMuaz1hO3RoaXMuY2I9Yjt0aGlzLkM9Yzt0aGlzLnA9ZDt0aGlzLnE9MDt0aGlzLmo9MzIzNzQ5ODh9az1WLnByb3RvdHlwZTtrLnRvU3RyaW5nPWZ1bmN0aW9uKCl7cmV0dXJuIGVjKHRoaXMpfTtmdW5jdGlvbiBRZChhKXtudWxsIT1hLmNiJiYoYS5DPWEuY2IubD9hLmNiLmwoKTphLmNiLmNhbGwobnVsbCksYS5jYj1udWxsKTtyZXR1cm4gYS5DfWsuSD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmt9O2suVD1mdW5jdGlvbigpe0NiKHRoaXMpO3JldHVybiBudWxsPT10aGlzLkM/bnVsbDpLKHRoaXMuQyl9O2suQj1mdW5jdGlvbigpe3ZhciBhPXRoaXMucDtyZXR1cm4gbnVsbCE9YT9hOnRoaXMucD1hPXdjKHRoaXMpfTtcbmsuQT1mdW5jdGlvbihhLGIpe3JldHVybiBJYyh0aGlzLGIpfTtrLko9ZnVuY3Rpb24oKXtyZXR1cm4gTyhKLHRoaXMuayl9O2suUj1mdW5jdGlvbihhLGIpe3JldHVybiBQLmEoYix0aGlzKX07ay5PPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gUC5jKGIsYyx0aGlzKX07ay5OPWZ1bmN0aW9uKCl7Q2IodGhpcyk7cmV0dXJuIG51bGw9PXRoaXMuQz9udWxsOkcodGhpcy5DKX07ay5TPWZ1bmN0aW9uKCl7Q2IodGhpcyk7cmV0dXJuIG51bGwhPXRoaXMuQz9IKHRoaXMuQyk6Sn07ay5EPWZ1bmN0aW9uKCl7UWQodGhpcyk7aWYobnVsbD09dGhpcy5DKXJldHVybiBudWxsO2Zvcih2YXIgYT10aGlzLkM7OylpZihhIGluc3RhbmNlb2YgVilhPVFkKGEpO2Vsc2UgcmV0dXJuIHRoaXMuQz1hLEQodGhpcy5DKX07ay5GPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyBWKGIsdGhpcy5jYix0aGlzLkMsdGhpcy5wKX07ay5HPWZ1bmN0aW9uKGEsYil7cmV0dXJuIE0oYix0aGlzKX07XG5WLnByb3RvdHlwZVtFYV09ZnVuY3Rpb24oKXtyZXR1cm4gdWModGhpcyl9O2Z1bmN0aW9uIFJkKGEsYil7dGhpcy5BYj1hO3RoaXMuZW5kPWI7dGhpcy5xPTA7dGhpcy5qPTJ9UmQucHJvdG90eXBlLkw9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5lbmR9O1JkLnByb3RvdHlwZS5hZGQ9ZnVuY3Rpb24oYSl7dGhpcy5BYlt0aGlzLmVuZF09YTtyZXR1cm4gdGhpcy5lbmQrPTF9O1JkLnByb3RvdHlwZS5jYT1mdW5jdGlvbigpe3ZhciBhPW5ldyBTZCh0aGlzLkFiLDAsdGhpcy5lbmQpO3RoaXMuQWI9bnVsbDtyZXR1cm4gYX07ZnVuY3Rpb24gVGQoYSl7cmV0dXJuIG5ldyBSZChBcnJheShhKSwwKX1mdW5jdGlvbiBTZChhLGIsYyl7dGhpcy5lPWE7dGhpcy5WPWI7dGhpcy5lbmQ9Yzt0aGlzLnE9MDt0aGlzLmo9NTI0MzA2fWs9U2QucHJvdG90eXBlO2suUj1mdW5jdGlvbihhLGIpe3JldHVybiBEYy5uKHRoaXMuZSxiLHRoaXMuZVt0aGlzLlZdLHRoaXMuVisxKX07XG5rLk89ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBEYy5uKHRoaXMuZSxiLGMsdGhpcy5WKX07ay5QYj1mdW5jdGlvbigpe2lmKHRoaXMuVj09PXRoaXMuZW5kKXRocm93IEVycm9yKFwiLWRyb3AtZmlyc3Qgb2YgZW1wdHkgY2h1bmtcIik7cmV0dXJuIG5ldyBTZCh0aGlzLmUsdGhpcy5WKzEsdGhpcy5lbmQpfTtrLlE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gdGhpcy5lW3RoaXMuVitiXX07ay4kPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gMDw9YiYmYjx0aGlzLmVuZC10aGlzLlY/dGhpcy5lW3RoaXMuVitiXTpjfTtrLkw9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5lbmQtdGhpcy5WfTtcbnZhciBVZD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMpe3JldHVybiBuZXcgU2QoYSxiLGMpfWZ1bmN0aW9uIGIoYSxiKXtyZXR1cm4gbmV3IFNkKGEsYixhLmxlbmd0aCl9ZnVuY3Rpb24gYyhhKXtyZXR1cm4gbmV3IFNkKGEsMCxhLmxlbmd0aCl9dmFyIGQ9bnVsbCxkPWZ1bmN0aW9uKGQsZixnKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBjLmNhbGwodGhpcyxkKTtjYXNlIDI6cmV0dXJuIGIuY2FsbCh0aGlzLGQsZik7Y2FzZSAzOnJldHVybiBhLmNhbGwodGhpcyxkLGYsZyl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2QuYj1jO2QuYT1iO2QuYz1hO3JldHVybiBkfSgpO2Z1bmN0aW9uIFZkKGEsYixjLGQpe3RoaXMuY2E9YTt0aGlzLnJhPWI7dGhpcy5rPWM7dGhpcy5wPWQ7dGhpcy5qPTMxODUwNzMyO3RoaXMucT0xNTM2fWs9VmQucHJvdG90eXBlO2sudG9TdHJpbmc9ZnVuY3Rpb24oKXtyZXR1cm4gZWModGhpcyl9O1xuay5IPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMua307ay5UPWZ1bmN0aW9uKCl7aWYoMTxNYSh0aGlzLmNhKSlyZXR1cm4gbmV3IFZkKFhiKHRoaXMuY2EpLHRoaXMucmEsdGhpcy5rLG51bGwpO3ZhciBhPUNiKHRoaXMucmEpO3JldHVybiBudWxsPT1hP251bGw6YX07ay5CPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5wO3JldHVybiBudWxsIT1hP2E6dGhpcy5wPWE9d2ModGhpcyl9O2suQT1mdW5jdGlvbihhLGIpe3JldHVybiBJYyh0aGlzLGIpfTtrLko9ZnVuY3Rpb24oKXtyZXR1cm4gTyhKLHRoaXMuayl9O2suTj1mdW5jdGlvbigpe3JldHVybiBDLmEodGhpcy5jYSwwKX07ay5TPWZ1bmN0aW9uKCl7cmV0dXJuIDE8TWEodGhpcy5jYSk/bmV3IFZkKFhiKHRoaXMuY2EpLHRoaXMucmEsdGhpcy5rLG51bGwpOm51bGw9PXRoaXMucmE/Sjp0aGlzLnJhfTtrLkQ9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpc307ay5DYj1mdW5jdGlvbigpe3JldHVybiB0aGlzLmNhfTtcbmsuRGI9ZnVuY3Rpb24oKXtyZXR1cm4gbnVsbD09dGhpcy5yYT9KOnRoaXMucmF9O2suRj1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgVmQodGhpcy5jYSx0aGlzLnJhLGIsdGhpcy5wKX07ay5HPWZ1bmN0aW9uKGEsYil7cmV0dXJuIE0oYix0aGlzKX07ay5CYj1mdW5jdGlvbigpe3JldHVybiBudWxsPT10aGlzLnJhP251bGw6dGhpcy5yYX07VmQucHJvdG90eXBlW0VhXT1mdW5jdGlvbigpe3JldHVybiB1Yyh0aGlzKX07ZnVuY3Rpb24gV2QoYSxiKXtyZXR1cm4gMD09PU1hKGEpP2I6bmV3IFZkKGEsYixudWxsLG51bGwpfWZ1bmN0aW9uIFhkKGEsYil7YS5hZGQoYil9ZnVuY3Rpb24gcmQoYSl7Zm9yKHZhciBiPVtdOzspaWYoRChhKSliLnB1c2goRyhhKSksYT1LKGEpO2Vsc2UgcmV0dXJuIGJ9ZnVuY3Rpb24gWWQoYSxiKXtpZihFYyhhKSlyZXR1cm4gUShhKTtmb3IodmFyIGM9YSxkPWIsZT0wOzspaWYoMDxkJiZEKGMpKWM9SyhjKSxkLT0xLGUrPTE7ZWxzZSByZXR1cm4gZX1cbnZhciAkZD1mdW5jdGlvbiBaZChiKXtyZXR1cm4gbnVsbD09Yj9udWxsOm51bGw9PUsoYik/RChHKGIpKTpNKEcoYiksWmQoSyhiKSkpfSxhZT1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiKXtyZXR1cm4gbmV3IFYobnVsbCxmdW5jdGlvbigpe3ZhciBjPUQoYSk7cmV0dXJuIGM/ZmQoYyk/V2QoWWIoYyksZC5hKFpiKGMpLGIpKTpNKEcoYyksZC5hKEgoYyksYikpOmJ9LG51bGwsbnVsbCl9ZnVuY3Rpb24gYihhKXtyZXR1cm4gbmV3IFYobnVsbCxmdW5jdGlvbigpe3JldHVybiBhfSxudWxsLG51bGwpfWZ1bmN0aW9uIGMoKXtyZXR1cm4gbmV3IFYobnVsbCxmdW5jdGlvbigpe3JldHVybiBudWxsfSxudWxsLG51bGwpfXZhciBkPW51bGwsZT1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYyxkLGUpe3ZhciBmPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGY9MCxxPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7ZjxxLmxlbmd0aDspcVtmXT1hcmd1bWVudHNbZisyXSwrK2Y7XG5mPW5ldyBGKHEsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGMsZCxmKX1mdW5jdGlvbiBiKGEsYyxlKXtyZXR1cm4gZnVuY3Rpb24gcShhLGIpe3JldHVybiBuZXcgVihudWxsLGZ1bmN0aW9uKCl7dmFyIGM9RChhKTtyZXR1cm4gYz9mZChjKT9XZChZYihjKSxxKFpiKGMpLGIpKTpNKEcoYykscShIKGMpLGIpKTp0KGIpP3EoRyhiKSxLKGIpKTpudWxsfSxudWxsLG51bGwpfShkLmEoYSxjKSxlKX1hLmk9MjthLmY9ZnVuY3Rpb24oYSl7dmFyIGM9RyhhKTthPUsoYSk7dmFyIGQ9RyhhKTthPUgoYSk7cmV0dXJuIGIoYyxkLGEpfTthLmQ9YjtyZXR1cm4gYX0oKSxkPWZ1bmN0aW9uKGQsZyxoKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAwOnJldHVybiBjLmNhbGwodGhpcyk7Y2FzZSAxOnJldHVybiBiLmNhbGwodGhpcyxkKTtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGQsZyk7ZGVmYXVsdDp2YXIgbD1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBsPTAsbT1cbkFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7bDxtLmxlbmd0aDspbVtsXT1hcmd1bWVudHNbbCsyXSwrK2w7bD1uZXcgRihtLDApfXJldHVybiBlLmQoZCxnLGwpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtkLmk9MjtkLmY9ZS5mO2QubD1jO2QuYj1iO2QuYT1hO2QuZD1lLmQ7cmV0dXJuIGR9KCksYmU9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjLGQpe3JldHVybiBNKGEsTShiLE0oYyxkKSkpfWZ1bmN0aW9uIGIoYSxiLGMpe3JldHVybiBNKGEsTShiLGMpKX12YXIgYz1udWxsLGQ9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGMsZCxlLG0scCl7dmFyIHE9bnVsbDtpZig0PGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgcT0wLHM9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC00KTtxPHMubGVuZ3RoOylzW3FdPWFyZ3VtZW50c1txKzRdLCsrcTtxPW5ldyBGKHMsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGMsZCxlLG0scSl9ZnVuY3Rpb24gYihhLFxuYyxkLGUsZil7cmV0dXJuIE0oYSxNKGMsTShkLE0oZSwkZChmKSkpKSl9YS5pPTQ7YS5mPWZ1bmN0aW9uKGEpe3ZhciBjPUcoYSk7YT1LKGEpO3ZhciBkPUcoYSk7YT1LKGEpO3ZhciBlPUcoYSk7YT1LKGEpO3ZhciBwPUcoYSk7YT1IKGEpO3JldHVybiBiKGMsZCxlLHAsYSl9O2EuZD1iO3JldHVybiBhfSgpLGM9ZnVuY3Rpb24oYyxmLGcsaCxsKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBEKGMpO2Nhc2UgMjpyZXR1cm4gTShjLGYpO2Nhc2UgMzpyZXR1cm4gYi5jYWxsKHRoaXMsYyxmLGcpO2Nhc2UgNDpyZXR1cm4gYS5jYWxsKHRoaXMsYyxmLGcsaCk7ZGVmYXVsdDp2YXIgbT1udWxsO2lmKDQ8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBtPTAscD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTQpO208cC5sZW5ndGg7KXBbbV09YXJndW1lbnRzW20rNF0sKyttO209bmV3IEYocCwwKX1yZXR1cm4gZC5kKGMsZixnLGgsbSl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIitcbmFyZ3VtZW50cy5sZW5ndGgpO307Yy5pPTQ7Yy5mPWQuZjtjLmI9ZnVuY3Rpb24oYSl7cmV0dXJuIEQoYSl9O2MuYT1mdW5jdGlvbihhLGIpe3JldHVybiBNKGEsYil9O2MuYz1iO2Mubj1hO2MuZD1kLmQ7cmV0dXJuIGN9KCk7ZnVuY3Rpb24gY2UoYSl7cmV0dXJuIFFiKGEpfVxudmFyIGRlPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYSgpe3JldHVybiBPYihNYyl9dmFyIGI9bnVsbCxjPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShjLGQsaCl7dmFyIGw9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgbD0wLG09QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtsPG0ubGVuZ3RoOyltW2xdPWFyZ3VtZW50c1tsKzJdLCsrbDtsPW5ldyBGKG0sMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGMsZCxsKX1mdW5jdGlvbiBiKGEsYyxkKXtmb3IoOzspaWYoYT1QYihhLGMpLHQoZCkpYz1HKGQpLGQ9SyhkKTtlbHNlIHJldHVybiBhfWEuaT0yO2EuZj1mdW5jdGlvbihhKXt2YXIgYz1HKGEpO2E9SyhhKTt2YXIgZD1HKGEpO2E9SChhKTtyZXR1cm4gYihjLGQsYSl9O2EuZD1iO3JldHVybiBhfSgpLGI9ZnVuY3Rpb24oYixlLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDA6cmV0dXJuIGEuY2FsbCh0aGlzKTtjYXNlIDE6cmV0dXJuIGI7Y2FzZSAyOnJldHVybiBQYihiLFxuZSk7ZGVmYXVsdDp2YXIgZz1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBnPTAsaD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2c8aC5sZW5ndGg7KWhbZ109YXJndW1lbnRzW2crMl0sKytnO2c9bmV3IEYoaCwwKX1yZXR1cm4gYy5kKGIsZSxnKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yi5pPTI7Yi5mPWMuZjtiLmw9YTtiLmI9ZnVuY3Rpb24oYSl7cmV0dXJuIGF9O2IuYT1mdW5jdGlvbihhLGIpe3JldHVybiBQYihhLGIpfTtiLmQ9Yy5kO3JldHVybiBifSgpLGVlPWZ1bmN0aW9uKCl7dmFyIGE9bnVsbCxiPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShjLGYsZyxoKXt2YXIgbD1udWxsO2lmKDM8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBsPTAsbT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTMpO2w8bS5sZW5ndGg7KW1bbF09YXJndW1lbnRzW2wrM10sKytsO2w9bmV3IEYobSwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsXG5jLGYsZyxsKX1mdW5jdGlvbiBiKGEsYyxkLGgpe2Zvcig7OylpZihhPVJiKGEsYyxkKSx0KGgpKWM9RyhoKSxkPUxjKGgpLGg9SyhLKGgpKTtlbHNlIHJldHVybiBhfWEuaT0zO2EuZj1mdW5jdGlvbihhKXt2YXIgYz1HKGEpO2E9SyhhKTt2YXIgZz1HKGEpO2E9SyhhKTt2YXIgaD1HKGEpO2E9SChhKTtyZXR1cm4gYihjLGcsaCxhKX07YS5kPWI7cmV0dXJuIGF9KCksYT1mdW5jdGlvbihhLGQsZSxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAzOnJldHVybiBSYihhLGQsZSk7ZGVmYXVsdDp2YXIgZz1udWxsO2lmKDM8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBnPTAsaD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTMpO2c8aC5sZW5ndGg7KWhbZ109YXJndW1lbnRzW2crM10sKytnO2c9bmV3IEYoaCwwKX1yZXR1cm4gYi5kKGEsZCxlLGcpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTthLmk9MzthLmY9Yi5mO2EuYz1mdW5jdGlvbihhLFxuYixlKXtyZXR1cm4gUmIoYSxiLGUpfTthLmQ9Yi5kO3JldHVybiBhfSgpLGZlPWZ1bmN0aW9uKCl7dmFyIGE9bnVsbCxiPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShjLGYsZyl7dmFyIGg9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgaD0wLGw9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtoPGwubGVuZ3RoOylsW2hdPWFyZ3VtZW50c1toKzJdLCsraDtoPW5ldyBGKGwsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGMsZixoKX1mdW5jdGlvbiBiKGEsYyxkKXtmb3IoOzspaWYoYT1TYihhLGMpLHQoZCkpYz1HKGQpLGQ9SyhkKTtlbHNlIHJldHVybiBhfWEuaT0yO2EuZj1mdW5jdGlvbihhKXt2YXIgYz1HKGEpO2E9SyhhKTt2YXIgZz1HKGEpO2E9SChhKTtyZXR1cm4gYihjLGcsYSl9O2EuZD1iO3JldHVybiBhfSgpLGE9ZnVuY3Rpb24oYSxkLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIFNiKGEsZCk7ZGVmYXVsdDp2YXIgZj1udWxsO2lmKDI8XG5hcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGY9MCxnPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7ZjxnLmxlbmd0aDspZ1tmXT1hcmd1bWVudHNbZisyXSwrK2Y7Zj1uZXcgRihnLDApfXJldHVybiBiLmQoYSxkLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTthLmk9MjthLmY9Yi5mO2EuYT1mdW5jdGlvbihhLGIpe3JldHVybiBTYihhLGIpfTthLmQ9Yi5kO3JldHVybiBhfSgpLGdlPWZ1bmN0aW9uKCl7dmFyIGE9bnVsbCxiPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShjLGYsZyl7dmFyIGg9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgaD0wLGw9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtoPGwubGVuZ3RoOylsW2hdPWFyZ3VtZW50c1toKzJdLCsraDtoPW5ldyBGKGwsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGMsZixoKX1mdW5jdGlvbiBiKGEsYyxkKXtmb3IoOzspaWYoYT1WYihhLGMpLHQoZCkpYz1HKGQpLGQ9SyhkKTtcbmVsc2UgcmV0dXJuIGF9YS5pPTI7YS5mPWZ1bmN0aW9uKGEpe3ZhciBjPUcoYSk7YT1LKGEpO3ZhciBnPUcoYSk7YT1IKGEpO3JldHVybiBiKGMsZyxhKX07YS5kPWI7cmV0dXJuIGF9KCksYT1mdW5jdGlvbihhLGQsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gVmIoYSxkKTtkZWZhdWx0OnZhciBmPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGY9MCxnPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7ZjxnLmxlbmd0aDspZ1tmXT1hcmd1bWVudHNbZisyXSwrK2Y7Zj1uZXcgRihnLDApfXJldHVybiBiLmQoYSxkLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTthLmk9MjthLmY9Yi5mO2EuYT1mdW5jdGlvbihhLGIpe3JldHVybiBWYihhLGIpfTthLmQ9Yi5kO3JldHVybiBhfSgpO1xuZnVuY3Rpb24gaGUoYSxiLGMpe3ZhciBkPUQoYyk7aWYoMD09PWIpcmV0dXJuIGEubD9hLmwoKTphLmNhbGwobnVsbCk7Yz1WYShkKTt2YXIgZT1XYShkKTtpZigxPT09YilyZXR1cm4gYS5iP2EuYihjKTphLmI/YS5iKGMpOmEuY2FsbChudWxsLGMpO3ZhciBkPVZhKGUpLGY9V2EoZSk7aWYoMj09PWIpcmV0dXJuIGEuYT9hLmEoYyxkKTphLmE/YS5hKGMsZCk6YS5jYWxsKG51bGwsYyxkKTt2YXIgZT1WYShmKSxnPVdhKGYpO2lmKDM9PT1iKXJldHVybiBhLmM/YS5jKGMsZCxlKTphLmM/YS5jKGMsZCxlKTphLmNhbGwobnVsbCxjLGQsZSk7dmFyIGY9VmEoZyksaD1XYShnKTtpZig0PT09YilyZXR1cm4gYS5uP2EubihjLGQsZSxmKTphLm4/YS5uKGMsZCxlLGYpOmEuY2FsbChudWxsLGMsZCxlLGYpO3ZhciBnPVZhKGgpLGw9V2EoaCk7aWYoNT09PWIpcmV0dXJuIGEucj9hLnIoYyxkLGUsZixnKTphLnI/YS5yKGMsZCxlLGYsZyk6YS5jYWxsKG51bGwsYyxkLGUsZixnKTt2YXIgaD1WYShsKSxcbm09V2EobCk7aWYoNj09PWIpcmV0dXJuIGEuUD9hLlAoYyxkLGUsZixnLGgpOmEuUD9hLlAoYyxkLGUsZixnLGgpOmEuY2FsbChudWxsLGMsZCxlLGYsZyxoKTt2YXIgbD1WYShtKSxwPVdhKG0pO2lmKDc9PT1iKXJldHVybiBhLmlhP2EuaWEoYyxkLGUsZixnLGgsbCk6YS5pYT9hLmlhKGMsZCxlLGYsZyxoLGwpOmEuY2FsbChudWxsLGMsZCxlLGYsZyxoLGwpO3ZhciBtPVZhKHApLHE9V2EocCk7aWYoOD09PWIpcmV0dXJuIGEuR2E/YS5HYShjLGQsZSxmLGcsaCxsLG0pOmEuR2E/YS5HYShjLGQsZSxmLGcsaCxsLG0pOmEuY2FsbChudWxsLGMsZCxlLGYsZyxoLGwsbSk7dmFyIHA9VmEocSkscz1XYShxKTtpZig5PT09YilyZXR1cm4gYS5IYT9hLkhhKGMsZCxlLGYsZyxoLGwsbSxwKTphLkhhP2EuSGEoYyxkLGUsZixnLGgsbCxtLHApOmEuY2FsbChudWxsLGMsZCxlLGYsZyxoLGwsbSxwKTt2YXIgcT1WYShzKSx1PVdhKHMpO2lmKDEwPT09YilyZXR1cm4gYS52YT9hLnZhKGMsZCxlLFxuZixnLGgsbCxtLHAscSk6YS52YT9hLnZhKGMsZCxlLGYsZyxoLGwsbSxwLHEpOmEuY2FsbChudWxsLGMsZCxlLGYsZyxoLGwsbSxwLHEpO3ZhciBzPVZhKHUpLHY9V2EodSk7aWYoMTE9PT1iKXJldHVybiBhLndhP2Eud2EoYyxkLGUsZixnLGgsbCxtLHAscSxzKTphLndhP2Eud2EoYyxkLGUsZixnLGgsbCxtLHAscSxzKTphLmNhbGwobnVsbCxjLGQsZSxmLGcsaCxsLG0scCxxLHMpO3ZhciB1PVZhKHYpLHk9V2Eodik7aWYoMTI9PT1iKXJldHVybiBhLnhhP2EueGEoYyxkLGUsZixnLGgsbCxtLHAscSxzLHUpOmEueGE/YS54YShjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSk6YS5jYWxsKG51bGwsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUpO3ZhciB2PVZhKHkpLEI9V2EoeSk7aWYoMTM9PT1iKXJldHVybiBhLnlhP2EueWEoYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdik6YS55YT9hLnlhKGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYpOmEuY2FsbChudWxsLGMsZCxlLGYsZyxoLGwsbSxwLFxucSxzLHUsdik7dmFyIHk9VmEoQiksRT1XYShCKTtpZigxND09PWIpcmV0dXJuIGEuemE/YS56YShjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHkpOmEuemE/YS56YShjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHkpOmEuY2FsbChudWxsLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSk7dmFyIEI9VmEoRSksTj1XYShFKTtpZigxNT09PWIpcmV0dXJuIGEuQWE/YS5BYShjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQik6YS5BYT9hLkFhKGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCKTphLmNhbGwobnVsbCxjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQik7dmFyIEU9VmEoTiksWT1XYShOKTtpZigxNj09PWIpcmV0dXJuIGEuQmE/YS5CYShjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQixFKTphLkJhP2EuQmEoYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIsRSk6YS5jYWxsKG51bGwsYyxkLGUsZixnLGgsbCxtLHAscSxzLHUsdix5LEIsRSk7dmFyIE49XG5WYShZKSxyYT1XYShZKTtpZigxNz09PWIpcmV0dXJuIGEuQ2E/YS5DYShjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQixFLE4pOmEuQ2E/YS5DYShjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQixFLE4pOmEuY2FsbChudWxsLGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCLEUsTik7dmFyIFk9VmEocmEpLFBhPVdhKHJhKTtpZigxOD09PWIpcmV0dXJuIGEuRGE/YS5EYShjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQixFLE4sWSk6YS5EYT9hLkRhKGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCLEUsTixZKTphLmNhbGwobnVsbCxjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQixFLE4sWSk7cmE9VmEoUGEpO1BhPVdhKFBhKTtpZigxOT09PWIpcmV0dXJuIGEuRWE/YS5FYShjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQixFLE4sWSxyYSk6YS5FYT9hLkVhKGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCLEUsTixZLHJhKTphLmNhbGwobnVsbCxcbmMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCLEUsTixZLHJhKTt2YXIgST1WYShQYSk7V2EoUGEpO2lmKDIwPT09YilyZXR1cm4gYS5GYT9hLkZhKGMsZCxlLGYsZyxoLGwsbSxwLHEscyx1LHYseSxCLEUsTixZLHJhLEkpOmEuRmE/YS5GYShjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQixFLE4sWSxyYSxJKTphLmNhbGwobnVsbCxjLGQsZSxmLGcsaCxsLG0scCxxLHMsdSx2LHksQixFLE4sWSxyYSxJKTt0aHJvdyBFcnJvcihcIk9ubHkgdXAgdG8gMjAgYXJndW1lbnRzIHN1cHBvcnRlZCBvbiBmdW5jdGlvbnNcIik7fVxudmFyIFQ9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjLGQsZSl7Yj1iZS5uKGIsYyxkLGUpO2M9YS5pO3JldHVybiBhLmY/KGQ9WWQoYixjKzEpLGQ8PWM/aGUoYSxkLGIpOmEuZihiKSk6YS5hcHBseShhLHJkKGIpKX1mdW5jdGlvbiBiKGEsYixjLGQpe2I9YmUuYyhiLGMsZCk7Yz1hLmk7cmV0dXJuIGEuZj8oZD1ZZChiLGMrMSksZDw9Yz9oZShhLGQsYik6YS5mKGIpKTphLmFwcGx5KGEscmQoYikpfWZ1bmN0aW9uIGMoYSxiLGMpe2I9YmUuYShiLGMpO2M9YS5pO2lmKGEuZil7dmFyIGQ9WWQoYixjKzEpO3JldHVybiBkPD1jP2hlKGEsZCxiKTphLmYoYil9cmV0dXJuIGEuYXBwbHkoYSxyZChiKSl9ZnVuY3Rpb24gZChhLGIpe3ZhciBjPWEuaTtpZihhLmYpe3ZhciBkPVlkKGIsYysxKTtyZXR1cm4gZDw9Yz9oZShhLGQsYik6YS5mKGIpfXJldHVybiBhLmFwcGx5KGEscmQoYikpfXZhciBlPW51bGwsZj1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYyxkLGUsZixnLHUpe3ZhciB2PW51bGw7XG5pZig1PGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgdj0wLHk9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC01KTt2PHkubGVuZ3RoOyl5W3ZdPWFyZ3VtZW50c1t2KzVdLCsrdjt2PW5ldyBGKHksMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGMsZCxlLGYsZyx2KX1mdW5jdGlvbiBiKGEsYyxkLGUsZixnKXtjPU0oYyxNKGQsTShlLE0oZiwkZChnKSkpKSk7ZD1hLmk7cmV0dXJuIGEuZj8oZT1ZZChjLGQrMSksZTw9ZD9oZShhLGUsYyk6YS5mKGMpKTphLmFwcGx5KGEscmQoYykpfWEuaT01O2EuZj1mdW5jdGlvbihhKXt2YXIgYz1HKGEpO2E9SyhhKTt2YXIgZD1HKGEpO2E9SyhhKTt2YXIgZT1HKGEpO2E9SyhhKTt2YXIgZj1HKGEpO2E9SyhhKTt2YXIgZz1HKGEpO2E9SChhKTtyZXR1cm4gYihjLGQsZSxmLGcsYSl9O2EuZD1iO3JldHVybiBhfSgpLGU9ZnVuY3Rpb24oZSxoLGwsbSxwLHEpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIGQuY2FsbCh0aGlzLGUsaCk7Y2FzZSAzOnJldHVybiBjLmNhbGwodGhpcyxcbmUsaCxsKTtjYXNlIDQ6cmV0dXJuIGIuY2FsbCh0aGlzLGUsaCxsLG0pO2Nhc2UgNTpyZXR1cm4gYS5jYWxsKHRoaXMsZSxoLGwsbSxwKTtkZWZhdWx0OnZhciBzPW51bGw7aWYoNTxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIHM9MCx1PUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtNSk7czx1Lmxlbmd0aDspdVtzXT1hcmd1bWVudHNbcys1XSwrK3M7cz1uZXcgRih1LDApfXJldHVybiBmLmQoZSxoLGwsbSxwLHMpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtlLmk9NTtlLmY9Zi5mO2UuYT1kO2UuYz1jO2Uubj1iO2Uucj1hO2UuZD1mLmQ7cmV0dXJuIGV9KCksaWU9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjLGQsZSxmKXt2YXIgZz1PLHY9VmMoYSk7Yj1iLnI/Yi5yKHYsYyxkLGUsZik6Yi5jYWxsKG51bGwsdixjLGQsZSxmKTtyZXR1cm4gZyhhLGIpfWZ1bmN0aW9uIGIoYSxiLGMsZCxlKXt2YXIgZj1PLGc9VmMoYSk7Yj1iLm4/Yi5uKGcsXG5jLGQsZSk6Yi5jYWxsKG51bGwsZyxjLGQsZSk7cmV0dXJuIGYoYSxiKX1mdW5jdGlvbiBjKGEsYixjLGQpe3ZhciBlPU8sZj1WYyhhKTtiPWIuYz9iLmMoZixjLGQpOmIuY2FsbChudWxsLGYsYyxkKTtyZXR1cm4gZShhLGIpfWZ1bmN0aW9uIGQoYSxiLGMpe3ZhciBkPU8sZT1WYyhhKTtiPWIuYT9iLmEoZSxjKTpiLmNhbGwobnVsbCxlLGMpO3JldHVybiBkKGEsYil9ZnVuY3Rpb24gZShhLGIpe3ZhciBjPU8sZDtkPVZjKGEpO2Q9Yi5iP2IuYihkKTpiLmNhbGwobnVsbCxkKTtyZXR1cm4gYyhhLGQpfXZhciBmPW51bGwsZz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYyxkLGUsZixnLGgseSl7dmFyIEI9bnVsbDtpZig2PGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgQj0wLEU9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC02KTtCPEUubGVuZ3RoOylFW0JdPWFyZ3VtZW50c1tCKzZdLCsrQjtCPW5ldyBGKEUsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGMsZCxlLGYsZyxoLEIpfWZ1bmN0aW9uIGIoYSxcbmMsZCxlLGYsZyxoKXtyZXR1cm4gTyhhLFQuZChjLFZjKGEpLGQsZSxmLEtjKFtnLGhdLDApKSl9YS5pPTY7YS5mPWZ1bmN0aW9uKGEpe3ZhciBjPUcoYSk7YT1LKGEpO3ZhciBkPUcoYSk7YT1LKGEpO3ZhciBlPUcoYSk7YT1LKGEpO3ZhciBmPUcoYSk7YT1LKGEpO3ZhciBnPUcoYSk7YT1LKGEpO3ZhciBoPUcoYSk7YT1IKGEpO3JldHVybiBiKGMsZCxlLGYsZyxoLGEpfTthLmQ9YjtyZXR1cm4gYX0oKSxmPWZ1bmN0aW9uKGYsbCxtLHAscSxzLHUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIGUuY2FsbCh0aGlzLGYsbCk7Y2FzZSAzOnJldHVybiBkLmNhbGwodGhpcyxmLGwsbSk7Y2FzZSA0OnJldHVybiBjLmNhbGwodGhpcyxmLGwsbSxwKTtjYXNlIDU6cmV0dXJuIGIuY2FsbCh0aGlzLGYsbCxtLHAscSk7Y2FzZSA2OnJldHVybiBhLmNhbGwodGhpcyxmLGwsbSxwLHEscyk7ZGVmYXVsdDp2YXIgdj1udWxsO2lmKDY8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciB2PVxuMCx5PUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtNik7djx5Lmxlbmd0aDspeVt2XT1hcmd1bWVudHNbdis2XSwrK3Y7dj1uZXcgRih5LDApfXJldHVybiBnLmQoZixsLG0scCxxLHMsdil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2YuaT02O2YuZj1nLmY7Zi5hPWU7Zi5jPWQ7Zi5uPWM7Zi5yPWI7Zi5QPWE7Zi5kPWcuZDtyZXR1cm4gZn0oKSxqZT1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiKXtyZXR1cm4hc2MuYShhLGIpfXZhciBiPW51bGwsYz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYyxkLGgpe3ZhciBsPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGw9MCxtPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7bDxtLmxlbmd0aDspbVtsXT1hcmd1bWVudHNbbCsyXSwrK2w7bD1uZXcgRihtLDApfXJldHVybiBiLmNhbGwodGhpcyxjLGQsbCl9ZnVuY3Rpb24gYihhLGMsZCl7cmV0dXJuIEFhKFQubihzYyxhLGMsZCkpfWEuaT1cbjI7YS5mPWZ1bmN0aW9uKGEpe3ZhciBjPUcoYSk7YT1LKGEpO3ZhciBkPUcoYSk7YT1IKGEpO3JldHVybiBiKGMsZCxhKX07YS5kPWI7cmV0dXJuIGF9KCksYj1mdW5jdGlvbihiLGUsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4hMTtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGIsZSk7ZGVmYXVsdDp2YXIgZz1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBnPTAsaD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2c8aC5sZW5ndGg7KWhbZ109YXJndW1lbnRzW2crMl0sKytnO2c9bmV3IEYoaCwwKX1yZXR1cm4gYy5kKGIsZSxnKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yi5pPTI7Yi5mPWMuZjtiLmI9ZnVuY3Rpb24oKXtyZXR1cm4hMX07Yi5hPWE7Yi5kPWMuZDtyZXR1cm4gYn0oKSxxZT1mdW5jdGlvbiBrZSgpe1widW5kZWZpbmVkXCI9PT10eXBlb2YgamEmJihqYT1mdW5jdGlvbihiLGMpe3RoaXMucGM9XG5iO3RoaXMub2M9Yzt0aGlzLnE9MDt0aGlzLmo9MzkzMjE2fSxqYS5wcm90b3R5cGUuZ2E9ZnVuY3Rpb24oKXtyZXR1cm4hMX0samEucHJvdG90eXBlLm5leHQ9ZnVuY3Rpb24oKXtyZXR1cm4gRXJyb3IoXCJObyBzdWNoIGVsZW1lbnRcIil9LGphLnByb3RvdHlwZS5IPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMub2N9LGphLnByb3RvdHlwZS5GPWZ1bmN0aW9uKGIsYyl7cmV0dXJuIG5ldyBqYSh0aGlzLnBjLGMpfSxqYS5ZYj0hMCxqYS5YYj1cImNsanMuY29yZS90MTI2NjBcIixqYS5uYz1mdW5jdGlvbihiKXtyZXR1cm4gTGIoYixcImNsanMuY29yZS90MTI2NjBcIil9KTtyZXR1cm4gbmV3IGphKGtlLG5ldyBwYShudWxsLDUsW2xlLDU0LG1lLDI5OTgsbmUsMyxvZSwyOTk0LHBlLFwiL1VzZXJzL2Rhdmlkbm9sZW4vZGV2ZWxvcG1lbnQvY2xvanVyZS9tb3JpL291dC1tb3JpLWFkdi9jbGpzL2NvcmUuY2xqc1wiXSxudWxsKSl9O2Z1bmN0aW9uIHJlKGEsYil7dGhpcy5DPWE7dGhpcy5tPWJ9XG5yZS5wcm90b3R5cGUuZ2E9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5tPHRoaXMuQy5sZW5ndGh9O3JlLnByb3RvdHlwZS5uZXh0PWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5DLmNoYXJBdCh0aGlzLm0pO3RoaXMubSs9MTtyZXR1cm4gYX07ZnVuY3Rpb24gc2UoYSxiKXt0aGlzLmU9YTt0aGlzLm09Yn1zZS5wcm90b3R5cGUuZ2E9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5tPHRoaXMuZS5sZW5ndGh9O3NlLnByb3RvdHlwZS5uZXh0PWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5lW3RoaXMubV07dGhpcy5tKz0xO3JldHVybiBhfTt2YXIgdGU9e30sdWU9e307ZnVuY3Rpb24gdmUoYSxiKXt0aGlzLmViPWE7dGhpcy5RYT1ifXZlLnByb3RvdHlwZS5nYT1mdW5jdGlvbigpe3RoaXMuZWI9PT10ZT8odGhpcy5lYj11ZSx0aGlzLlFhPUQodGhpcy5RYSkpOnRoaXMuZWI9PT10aGlzLlFhJiYodGhpcy5RYT1LKHRoaXMuZWIpKTtyZXR1cm4gbnVsbCE9dGhpcy5RYX07XG52ZS5wcm90b3R5cGUubmV4dD1mdW5jdGlvbigpe2lmKEFhKHRoaXMuZ2EoKSkpdGhyb3cgRXJyb3IoXCJObyBzdWNoIGVsZW1lbnRcIik7dGhpcy5lYj10aGlzLlFhO3JldHVybiBHKHRoaXMuUWEpfTtmdW5jdGlvbiB3ZShhKXtpZihudWxsPT1hKXJldHVybiBxZSgpO2lmKFwic3RyaW5nXCI9PT10eXBlb2YgYSlyZXR1cm4gbmV3IHJlKGEsMCk7aWYoYSBpbnN0YW5jZW9mIEFycmF5KXJldHVybiBuZXcgc2UoYSwwKTtpZihhP3QodChudWxsKT9udWxsOmEudmIpfHwoYS55Yj8wOncoYmMsYSkpOncoYmMsYSkpcmV0dXJuIGNjKGEpO2lmKGxkKGEpKXJldHVybiBuZXcgdmUodGUsYSk7dGhyb3cgRXJyb3IoW3ooXCJDYW5ub3QgY3JlYXRlIGl0ZXJhdG9yIGZyb20gXCIpLHooYSldLmpvaW4oXCJcIikpO31mdW5jdGlvbiB4ZShhLGIpe3RoaXMuZmE9YTt0aGlzLiRiPWJ9XG54ZS5wcm90b3R5cGUuc3RlcD1mdW5jdGlvbihhKXtmb3IodmFyIGI9dGhpczs7KXtpZih0KGZ1bmN0aW9uKCl7dmFyIGM9bnVsbCE9YS5YO3JldHVybiBjP2IuJGIuZ2EoKTpjfSgpKSlpZihBYyhmdW5jdGlvbigpe3ZhciBjPWIuJGIubmV4dCgpO3JldHVybiBiLmZhLmE/Yi5mYS5hKGEsYyk6Yi5mYS5jYWxsKG51bGwsYSxjKX0oKSkpbnVsbCE9YS5NJiYoYS5NLlg9bnVsbCk7ZWxzZSBjb250aW51ZTticmVha31yZXR1cm4gbnVsbD09YS5YP251bGw6Yi5mYS5iP2IuZmEuYihhKTpiLmZhLmNhbGwobnVsbCxhKX07XG5mdW5jdGlvbiB5ZShhLGIpe3ZhciBjPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShiLGMpe2IuZmlyc3Q9YztiLk09bmV3IHplKGIuWCxudWxsLG51bGwsbnVsbCk7Yi5YPW51bGw7cmV0dXJuIGIuTX1mdW5jdGlvbiBiKGEpeyhBYyhhKT9xYihhKTphKS5YPW51bGw7cmV0dXJuIGF9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYi5jYWxsKHRoaXMsYyk7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxjLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmI9YjtjLmE9YTtyZXR1cm4gY30oKTtyZXR1cm4gbmV3IHhlKGEuYj9hLmIoYyk6YS5jYWxsKG51bGwsYyksYil9ZnVuY3Rpb24gQWUoYSxiLGMpe3RoaXMuZmE9YTt0aGlzLktiPWI7dGhpcy5hYz1jfVxuQWUucHJvdG90eXBlLmdhPWZ1bmN0aW9uKCl7Zm9yKHZhciBhPUQodGhpcy5LYik7OylpZihudWxsIT1hKXt2YXIgYj1HKGEpO2lmKEFhKGIuZ2EoKSkpcmV0dXJuITE7YT1LKGEpfWVsc2UgcmV0dXJuITB9O0FlLnByb3RvdHlwZS5uZXh0PWZ1bmN0aW9uKCl7Zm9yKHZhciBhPXRoaXMuS2IubGVuZ3RoLGI9MDs7KWlmKGI8YSl0aGlzLmFjW2JdPXRoaXMuS2JbYl0ubmV4dCgpLGIrPTE7ZWxzZSBicmVhaztyZXR1cm4gSmMuYSh0aGlzLmFjLDApfTtBZS5wcm90b3R5cGUuc3RlcD1mdW5jdGlvbihhKXtmb3IoOzspe3ZhciBiO2I9KGI9bnVsbCE9YS5YKT90aGlzLmdhKCk6YjtpZih0KGIpKWlmKEFjKFQuYSh0aGlzLmZhLE0oYSx0aGlzLm5leHQoKSkpKSludWxsIT1hLk0mJihhLk0uWD1udWxsKTtlbHNlIGNvbnRpbnVlO2JyZWFrfXJldHVybiBudWxsPT1hLlg/bnVsbDp0aGlzLmZhLmI/dGhpcy5mYS5iKGEpOnRoaXMuZmEuY2FsbChudWxsLGEpfTtcbnZhciBCZT1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMpe3ZhciBnPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShiLGMpe2IuZmlyc3Q9YztiLk09bmV3IHplKGIuWCxudWxsLG51bGwsbnVsbCk7Yi5YPW51bGw7cmV0dXJuIGIuTX1mdW5jdGlvbiBiKGEpe2E9QWMoYSk/cWIoYSk6YTthLlg9bnVsbDtyZXR1cm4gYX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxkKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiLmNhbGwodGhpcyxjKTtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZCl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYj1iO2MuYT1hO3JldHVybiBjfSgpO3JldHVybiBuZXcgQWUoYS5iP2EuYihnKTphLmNhbGwobnVsbCxnKSxiLGMpfWZ1bmN0aW9uIGIoYSxiKXtyZXR1cm4gYy5jKGEsYixBcnJheShiLmxlbmd0aCkpfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gYi5jYWxsKHRoaXMsXG5jLGUpO2Nhc2UgMzpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmE9YjtjLmM9YTtyZXR1cm4gY30oKTtmdW5jdGlvbiB6ZShhLGIsYyxkKXt0aGlzLlg9YTt0aGlzLmZpcnN0PWI7dGhpcy5NPWM7dGhpcy5rPWQ7dGhpcy5xPTA7dGhpcy5qPTMxNzE5NjI4fWs9emUucHJvdG90eXBlO2suVD1mdW5jdGlvbigpe251bGwhPXRoaXMuWCYmQ2IodGhpcyk7cmV0dXJuIG51bGw9PXRoaXMuTT9udWxsOkNiKHRoaXMuTSl9O2suTj1mdW5jdGlvbigpe251bGwhPXRoaXMuWCYmQ2IodGhpcyk7cmV0dXJuIG51bGw9PXRoaXMuTT9udWxsOnRoaXMuZmlyc3R9O2suUz1mdW5jdGlvbigpe251bGwhPXRoaXMuWCYmQ2IodGhpcyk7cmV0dXJuIG51bGw9PXRoaXMuTT9KOnRoaXMuTX07XG5rLkQ9ZnVuY3Rpb24oKXtudWxsIT10aGlzLlgmJnRoaXMuWC5zdGVwKHRoaXMpO3JldHVybiBudWxsPT10aGlzLk0/bnVsbDp0aGlzfTtrLkI9ZnVuY3Rpb24oKXtyZXR1cm4gd2ModGhpcyl9O2suQT1mdW5jdGlvbihhLGIpe3JldHVybiBudWxsIT1DYih0aGlzKT9JYyh0aGlzLGIpOmNkKGIpJiZudWxsPT1EKGIpfTtrLko9ZnVuY3Rpb24oKXtyZXR1cm4gSn07ay5HPWZ1bmN0aW9uKGEsYil7cmV0dXJuIE0oYixDYih0aGlzKSl9O2suRj1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgemUodGhpcy5YLHRoaXMuZmlyc3QsdGhpcy5NLGIpfTt6ZS5wcm90b3R5cGVbRWFdPWZ1bmN0aW9uKCl7cmV0dXJuIHVjKHRoaXMpfTtcbnZhciBDZT1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSl7cmV0dXJuIGtkKGEpP2E6KGE9RChhKSk/YTpKfXZhciBiPW51bGwsYz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYyxkLGgpe3ZhciBsPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGw9MCxtPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7bDxtLmxlbmd0aDspbVtsXT1hcmd1bWVudHNbbCsyXSwrK2w7bD1uZXcgRihtLDApfXJldHVybiBiLmNhbGwodGhpcyxjLGQsbCl9ZnVuY3Rpb24gYihhLGMsZCl7ZD1yZChNKGMsZCkpO2M9W107ZD1EKGQpO2Zvcih2YXIgZT1udWxsLG09MCxwPTA7OylpZihwPG0pe3ZhciBxPWUuUShudWxsLHApO2MucHVzaCh3ZShxKSk7cCs9MX1lbHNlIGlmKGQ9RChkKSllPWQsZmQoZSk/KGQ9WWIoZSkscD1aYihlKSxlPWQsbT1RKGQpLGQ9cCk6KGQ9RyhlKSxjLnB1c2god2UoZCkpLGQ9SyhlKSxlPW51bGwsbT0wKSxwPTA7ZWxzZSBicmVhaztyZXR1cm4gbmV3IHplKEJlLmMoYSxjLFxuQXJyYXkoYy5sZW5ndGgpKSxudWxsLG51bGwsbnVsbCl9YS5pPTI7YS5mPWZ1bmN0aW9uKGEpe3ZhciBjPUcoYSk7YT1LKGEpO3ZhciBkPUcoYSk7YT1IKGEpO3JldHVybiBiKGMsZCxhKX07YS5kPWI7cmV0dXJuIGF9KCksYj1mdW5jdGlvbihiLGUsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYS5jYWxsKHRoaXMsYik7Y2FzZSAyOnJldHVybiBuZXcgemUoeWUoYix3ZShlKSksbnVsbCxudWxsLG51bGwpO2RlZmF1bHQ6dmFyIGc9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZz0wLGg9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtnPGgubGVuZ3RoOyloW2ddPWFyZ3VtZW50c1tnKzJdLCsrZztnPW5ldyBGKGgsMCl9cmV0dXJuIGMuZChiLGUsZyl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2IuaT0yO2IuZj1jLmY7Yi5iPWE7Yi5hPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyB6ZSh5ZShhLFxud2UoYikpLG51bGwsbnVsbCxudWxsKX07Yi5kPWMuZDtyZXR1cm4gYn0oKTtmdW5jdGlvbiBFZShhLGIpe2Zvcig7Oyl7aWYobnVsbD09RChiKSlyZXR1cm4hMDt2YXIgYztjPUcoYik7Yz1hLmI/YS5iKGMpOmEuY2FsbChudWxsLGMpO2lmKHQoYykpe2M9YTt2YXIgZD1LKGIpO2E9YztiPWR9ZWxzZSByZXR1cm4hMX19ZnVuY3Rpb24gRmUoYSxiKXtmb3IoOzspaWYoRChiKSl7dmFyIGM7Yz1HKGIpO2M9YS5iP2EuYihjKTphLmNhbGwobnVsbCxjKTtpZih0KGMpKXJldHVybiBjO2M9YTt2YXIgZD1LKGIpO2E9YztiPWR9ZWxzZSByZXR1cm4gbnVsbH1mdW5jdGlvbiBHZShhKXtpZihcIm51bWJlclwiPT09dHlwZW9mIGEmJkFhKGlzTmFOKGEpKSYmSW5maW5pdHkhPT1hJiZwYXJzZUZsb2F0KGEpPT09cGFyc2VJbnQoYSwxMCkpcmV0dXJuIDA9PT0oYSYxKTt0aHJvdyBFcnJvcihbeihcIkFyZ3VtZW50IG11c3QgYmUgYW4gaW50ZWdlcjogXCIpLHooYSldLmpvaW4oXCJcIikpO31cbmZ1bmN0aW9uIEhlKGEpe3JldHVybiBmdW5jdGlvbigpe2Z1bmN0aW9uIGIoYixjKXtyZXR1cm4gQWEoYS5hP2EuYShiLGMpOmEuY2FsbChudWxsLGIsYykpfWZ1bmN0aW9uIGMoYil7cmV0dXJuIEFhKGEuYj9hLmIoYik6YS5jYWxsKG51bGwsYikpfWZ1bmN0aW9uIGQoKXtyZXR1cm4gQWEoYS5sP2EubCgpOmEuY2FsbChudWxsKSl9dmFyIGU9bnVsbCxmPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYihhLGQsZSl7dmFyIGY9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZj0wLGc9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtmPGcubGVuZ3RoOylnW2ZdPWFyZ3VtZW50c1tmKzJdLCsrZjtmPW5ldyBGKGcsMCl9cmV0dXJuIGMuY2FsbCh0aGlzLGEsZCxmKX1mdW5jdGlvbiBjKGIsZCxlKXtyZXR1cm4gQWEoVC5uKGEsYixkLGUpKX1iLmk9MjtiLmY9ZnVuY3Rpb24oYSl7dmFyIGI9RyhhKTthPUsoYSk7dmFyIGQ9RyhhKTthPUgoYSk7cmV0dXJuIGMoYixkLGEpfTtiLmQ9YztcbnJldHVybiBifSgpLGU9ZnVuY3Rpb24oYSxlLGwpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDA6cmV0dXJuIGQuY2FsbCh0aGlzKTtjYXNlIDE6cmV0dXJuIGMuY2FsbCh0aGlzLGEpO2Nhc2UgMjpyZXR1cm4gYi5jYWxsKHRoaXMsYSxlKTtkZWZhdWx0OnZhciBtPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIG09MCxwPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7bTxwLmxlbmd0aDspcFttXT1hcmd1bWVudHNbbSsyXSwrK207bT1uZXcgRihwLDApfXJldHVybiBmLmQoYSxlLG0pfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtlLmk9MjtlLmY9Zi5mO2UubD1kO2UuYj1jO2UuYT1iO2UuZD1mLmQ7cmV0dXJuIGV9KCl9XG52YXIgSWU9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjKXtyZXR1cm4gZnVuY3Rpb24oKXtmdW5jdGlvbiBkKGgsbCxtKXtoPWMuYz9jLmMoaCxsLG0pOmMuY2FsbChudWxsLGgsbCxtKTtoPWIuYj9iLmIoaCk6Yi5jYWxsKG51bGwsaCk7cmV0dXJuIGEuYj9hLmIoaCk6YS5jYWxsKG51bGwsaCl9ZnVuY3Rpb24gbChkLGgpe3ZhciBsO2w9Yy5hP2MuYShkLGgpOmMuY2FsbChudWxsLGQsaCk7bD1iLmI/Yi5iKGwpOmIuY2FsbChudWxsLGwpO3JldHVybiBhLmI/YS5iKGwpOmEuY2FsbChudWxsLGwpfWZ1bmN0aW9uIG0oZCl7ZD1jLmI/Yy5iKGQpOmMuY2FsbChudWxsLGQpO2Q9Yi5iP2IuYihkKTpiLmNhbGwobnVsbCxkKTtyZXR1cm4gYS5iP2EuYihkKTphLmNhbGwobnVsbCxkKX1mdW5jdGlvbiBwKCl7dmFyIGQ7ZD1jLmw/Yy5sKCk6Yy5jYWxsKG51bGwpO2Q9Yi5iP2IuYihkKTpiLmNhbGwobnVsbCxkKTtyZXR1cm4gYS5iP2EuYihkKTphLmNhbGwobnVsbCxkKX12YXIgcT1udWxsLFxucz1mdW5jdGlvbigpe2Z1bmN0aW9uIGQoYSxiLGMsZSl7dmFyIGY9bnVsbDtpZigzPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZj0wLGc9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0zKTtmPGcubGVuZ3RoOylnW2ZdPWFyZ3VtZW50c1tmKzNdLCsrZjtmPW5ldyBGKGcsMCl9cmV0dXJuIGguY2FsbCh0aGlzLGEsYixjLGYpfWZ1bmN0aW9uIGgoZCxsLG0scCl7ZD1ULnIoYyxkLGwsbSxwKTtkPWIuYj9iLmIoZCk6Yi5jYWxsKG51bGwsZCk7cmV0dXJuIGEuYj9hLmIoZCk6YS5jYWxsKG51bGwsZCl9ZC5pPTM7ZC5mPWZ1bmN0aW9uKGEpe3ZhciBiPUcoYSk7YT1LKGEpO3ZhciBjPUcoYSk7YT1LKGEpO3ZhciBkPUcoYSk7YT1IKGEpO3JldHVybiBoKGIsYyxkLGEpfTtkLmQ9aDtyZXR1cm4gZH0oKSxxPWZ1bmN0aW9uKGEsYixjLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDA6cmV0dXJuIHAuY2FsbCh0aGlzKTtjYXNlIDE6cmV0dXJuIG0uY2FsbCh0aGlzLGEpO2Nhc2UgMjpyZXR1cm4gbC5jYWxsKHRoaXMsXG5hLGIpO2Nhc2UgMzpyZXR1cm4gZC5jYWxsKHRoaXMsYSxiLGMpO2RlZmF1bHQ6dmFyIGY9bnVsbDtpZigzPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZj0wLGc9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0zKTtmPGcubGVuZ3RoOylnW2ZdPWFyZ3VtZW50c1tmKzNdLCsrZjtmPW5ldyBGKGcsMCl9cmV0dXJuIHMuZChhLGIsYyxmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307cS5pPTM7cS5mPXMuZjtxLmw9cDtxLmI9bTtxLmE9bDtxLmM9ZDtxLmQ9cy5kO3JldHVybiBxfSgpfWZ1bmN0aW9uIGIoYSxiKXtyZXR1cm4gZnVuY3Rpb24oKXtmdW5jdGlvbiBjKGQsZyxoKXtkPWIuYz9iLmMoZCxnLGgpOmIuY2FsbChudWxsLGQsZyxoKTtyZXR1cm4gYS5iP2EuYihkKTphLmNhbGwobnVsbCxkKX1mdW5jdGlvbiBkKGMsZyl7dmFyIGg9Yi5hP2IuYShjLGcpOmIuY2FsbChudWxsLGMsZyk7cmV0dXJuIGEuYj9hLmIoaCk6YS5jYWxsKG51bGwsaCl9XG5mdW5jdGlvbiBsKGMpe2M9Yi5iP2IuYihjKTpiLmNhbGwobnVsbCxjKTtyZXR1cm4gYS5iP2EuYihjKTphLmNhbGwobnVsbCxjKX1mdW5jdGlvbiBtKCl7dmFyIGM9Yi5sP2IubCgpOmIuY2FsbChudWxsKTtyZXR1cm4gYS5iP2EuYihjKTphLmNhbGwobnVsbCxjKX12YXIgcD1udWxsLHE9ZnVuY3Rpb24oKXtmdW5jdGlvbiBjKGEsYixlLGYpe3ZhciBnPW51bGw7aWYoMzxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGc9MCxoPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMyk7ZzxoLmxlbmd0aDspaFtnXT1hcmd1bWVudHNbZyszXSwrK2c7Zz1uZXcgRihoLDApfXJldHVybiBkLmNhbGwodGhpcyxhLGIsZSxnKX1mdW5jdGlvbiBkKGMsZyxoLGwpe2M9VC5yKGIsYyxnLGgsbCk7cmV0dXJuIGEuYj9hLmIoYyk6YS5jYWxsKG51bGwsYyl9Yy5pPTM7Yy5mPWZ1bmN0aW9uKGEpe3ZhciBiPUcoYSk7YT1LKGEpO3ZhciBjPUcoYSk7YT1LKGEpO3ZhciBlPUcoYSk7YT1IKGEpO3JldHVybiBkKGIsXG5jLGUsYSl9O2MuZD1kO3JldHVybiBjfSgpLHA9ZnVuY3Rpb24oYSxiLGUsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMDpyZXR1cm4gbS5jYWxsKHRoaXMpO2Nhc2UgMTpyZXR1cm4gbC5jYWxsKHRoaXMsYSk7Y2FzZSAyOnJldHVybiBkLmNhbGwodGhpcyxhLGIpO2Nhc2UgMzpyZXR1cm4gYy5jYWxsKHRoaXMsYSxiLGUpO2RlZmF1bHQ6dmFyIHA9bnVsbDtpZigzPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgcD0wLEU9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0zKTtwPEUubGVuZ3RoOylFW3BdPWFyZ3VtZW50c1twKzNdLCsrcDtwPW5ldyBGKEUsMCl9cmV0dXJuIHEuZChhLGIsZSxwKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307cC5pPTM7cC5mPXEuZjtwLmw9bTtwLmI9bDtwLmE9ZDtwLmM9YztwLmQ9cS5kO3JldHVybiBwfSgpfXZhciBjPW51bGwsZD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYyxkLGUsbSl7dmFyIHA9bnVsbDtcbmlmKDM8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBwPTAscT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTMpO3A8cS5sZW5ndGg7KXFbcF09YXJndW1lbnRzW3ArM10sKytwO3A9bmV3IEYocSwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsYyxkLGUscCl9ZnVuY3Rpb24gYihhLGMsZCxlKXtyZXR1cm4gZnVuY3Rpb24oYSl7cmV0dXJuIGZ1bmN0aW9uKCl7ZnVuY3Rpb24gYihhKXt2YXIgZD1udWxsO2lmKDA8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBkPTAsZT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTApO2Q8ZS5sZW5ndGg7KWVbZF09YXJndW1lbnRzW2QrMF0sKytkO2Q9bmV3IEYoZSwwKX1yZXR1cm4gYy5jYWxsKHRoaXMsZCl9ZnVuY3Rpb24gYyhiKXtiPVQuYShHKGEpLGIpO2Zvcih2YXIgZD1LKGEpOzspaWYoZCliPUcoZCkuY2FsbChudWxsLGIpLGQ9SyhkKTtlbHNlIHJldHVybiBifWIuaT0wO2IuZj1mdW5jdGlvbihhKXthPUQoYSk7cmV0dXJuIGMoYSl9O2IuZD1jO3JldHVybiBifSgpfShKZChiZS5uKGEsXG5jLGQsZSkpKX1hLmk9MzthLmY9ZnVuY3Rpb24oYSl7dmFyIGM9RyhhKTthPUsoYSk7dmFyIGQ9RyhhKTthPUsoYSk7dmFyIGU9RyhhKTthPUgoYSk7cmV0dXJuIGIoYyxkLGUsYSl9O2EuZD1iO3JldHVybiBhfSgpLGM9ZnVuY3Rpb24oYyxmLGcsaCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMDpyZXR1cm4gdWQ7Y2FzZSAxOnJldHVybiBjO2Nhc2UgMjpyZXR1cm4gYi5jYWxsKHRoaXMsYyxmKTtjYXNlIDM6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZixnKTtkZWZhdWx0OnZhciBsPW51bGw7aWYoMzxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGw9MCxtPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMyk7bDxtLmxlbmd0aDspbVtsXT1hcmd1bWVudHNbbCszXSwrK2w7bD1uZXcgRihtLDApfXJldHVybiBkLmQoYyxmLGcsbCl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuaT0zO2MuZj1kLmY7Yy5sPWZ1bmN0aW9uKCl7cmV0dXJuIHVkfTtcbmMuYj1mdW5jdGlvbihhKXtyZXR1cm4gYX07Yy5hPWI7Yy5jPWE7Yy5kPWQuZDtyZXR1cm4gY30oKSxKZT1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMsZCl7cmV0dXJuIGZ1bmN0aW9uKCl7ZnVuY3Rpb24gZShtLHAscSl7cmV0dXJuIGEuUD9hLlAoYixjLGQsbSxwLHEpOmEuY2FsbChudWxsLGIsYyxkLG0scCxxKX1mdW5jdGlvbiBwKGUsbSl7cmV0dXJuIGEucj9hLnIoYixjLGQsZSxtKTphLmNhbGwobnVsbCxiLGMsZCxlLG0pfWZ1bmN0aW9uIHEoZSl7cmV0dXJuIGEubj9hLm4oYixjLGQsZSk6YS5jYWxsKG51bGwsYixjLGQsZSl9ZnVuY3Rpb24gcygpe3JldHVybiBhLmM/YS5jKGIsYyxkKTphLmNhbGwobnVsbCxiLGMsZCl9dmFyIHU9bnVsbCx2PWZ1bmN0aW9uKCl7ZnVuY3Rpb24gZShhLGIsYyxkKXt2YXIgZj1udWxsO2lmKDM8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBmPTAsZz1BcnJheShhcmd1bWVudHMubGVuZ3RoLTMpO2Y8Zy5sZW5ndGg7KWdbZl09YXJndW1lbnRzW2YrXG4zXSwrK2Y7Zj1uZXcgRihnLDApfXJldHVybiBtLmNhbGwodGhpcyxhLGIsYyxmKX1mdW5jdGlvbiBtKGUscCxxLHMpe3JldHVybiBULmQoYSxiLGMsZCxlLEtjKFtwLHEsc10sMCkpfWUuaT0zO2UuZj1mdW5jdGlvbihhKXt2YXIgYj1HKGEpO2E9SyhhKTt2YXIgYz1HKGEpO2E9SyhhKTt2YXIgZD1HKGEpO2E9SChhKTtyZXR1cm4gbShiLGMsZCxhKX07ZS5kPW07cmV0dXJuIGV9KCksdT1mdW5jdGlvbihhLGIsYyxkKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAwOnJldHVybiBzLmNhbGwodGhpcyk7Y2FzZSAxOnJldHVybiBxLmNhbGwodGhpcyxhKTtjYXNlIDI6cmV0dXJuIHAuY2FsbCh0aGlzLGEsYik7Y2FzZSAzOnJldHVybiBlLmNhbGwodGhpcyxhLGIsYyk7ZGVmYXVsdDp2YXIgZj1udWxsO2lmKDM8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBmPTAsZz1BcnJheShhcmd1bWVudHMubGVuZ3RoLTMpO2Y8Zy5sZW5ndGg7KWdbZl09YXJndW1lbnRzW2YrM10sKytmO2Y9XG5uZXcgRihnLDApfXJldHVybiB2LmQoYSxiLGMsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O3UuaT0zO3UuZj12LmY7dS5sPXM7dS5iPXE7dS5hPXA7dS5jPWU7dS5kPXYuZDtyZXR1cm4gdX0oKX1mdW5jdGlvbiBiKGEsYixjKXtyZXR1cm4gZnVuY3Rpb24oKXtmdW5jdGlvbiBkKGUsbCxtKXtyZXR1cm4gYS5yP2EucihiLGMsZSxsLG0pOmEuY2FsbChudWxsLGIsYyxlLGwsbSl9ZnVuY3Rpb24gZShkLGwpe3JldHVybiBhLm4/YS5uKGIsYyxkLGwpOmEuY2FsbChudWxsLGIsYyxkLGwpfWZ1bmN0aW9uIHAoZCl7cmV0dXJuIGEuYz9hLmMoYixjLGQpOmEuY2FsbChudWxsLGIsYyxkKX1mdW5jdGlvbiBxKCl7cmV0dXJuIGEuYT9hLmEoYixjKTphLmNhbGwobnVsbCxiLGMpfXZhciBzPW51bGwsdT1mdW5jdGlvbigpe2Z1bmN0aW9uIGQoYSxiLGMsZil7dmFyIGc9bnVsbDtpZigzPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZz0wLGg9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC1cbjMpO2c8aC5sZW5ndGg7KWhbZ109YXJndW1lbnRzW2crM10sKytnO2c9bmV3IEYoaCwwKX1yZXR1cm4gZS5jYWxsKHRoaXMsYSxiLGMsZyl9ZnVuY3Rpb24gZShkLGwsbSxwKXtyZXR1cm4gVC5kKGEsYixjLGQsbCxLYyhbbSxwXSwwKSl9ZC5pPTM7ZC5mPWZ1bmN0aW9uKGEpe3ZhciBiPUcoYSk7YT1LKGEpO3ZhciBjPUcoYSk7YT1LKGEpO3ZhciBkPUcoYSk7YT1IKGEpO3JldHVybiBlKGIsYyxkLGEpfTtkLmQ9ZTtyZXR1cm4gZH0oKSxzPWZ1bmN0aW9uKGEsYixjLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDA6cmV0dXJuIHEuY2FsbCh0aGlzKTtjYXNlIDE6cmV0dXJuIHAuY2FsbCh0aGlzLGEpO2Nhc2UgMjpyZXR1cm4gZS5jYWxsKHRoaXMsYSxiKTtjYXNlIDM6cmV0dXJuIGQuY2FsbCh0aGlzLGEsYixjKTtkZWZhdWx0OnZhciBnPW51bGw7aWYoMzxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGc9MCxoPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMyk7ZzxoLmxlbmd0aDspaFtnXT1cbmFyZ3VtZW50c1tnKzNdLCsrZztnPW5ldyBGKGgsMCl9cmV0dXJuIHUuZChhLGIsYyxnKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307cy5pPTM7cy5mPXUuZjtzLmw9cTtzLmI9cDtzLmE9ZTtzLmM9ZDtzLmQ9dS5kO3JldHVybiBzfSgpfWZ1bmN0aW9uIGMoYSxiKXtyZXR1cm4gZnVuY3Rpb24oKXtmdW5jdGlvbiBjKGQsZSxoKXtyZXR1cm4gYS5uP2EubihiLGQsZSxoKTphLmNhbGwobnVsbCxiLGQsZSxoKX1mdW5jdGlvbiBkKGMsZSl7cmV0dXJuIGEuYz9hLmMoYixjLGUpOmEuY2FsbChudWxsLGIsYyxlKX1mdW5jdGlvbiBlKGMpe3JldHVybiBhLmE/YS5hKGIsYyk6YS5jYWxsKG51bGwsYixjKX1mdW5jdGlvbiBwKCl7cmV0dXJuIGEuYj9hLmIoYik6YS5jYWxsKG51bGwsYil9dmFyIHE9bnVsbCxzPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYyhhLGIsZSxmKXt2YXIgZz1udWxsO2lmKDM8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBnPTAsXG5oPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMyk7ZzxoLmxlbmd0aDspaFtnXT1hcmd1bWVudHNbZyszXSwrK2c7Zz1uZXcgRihoLDApfXJldHVybiBkLmNhbGwodGhpcyxhLGIsZSxnKX1mdW5jdGlvbiBkKGMsZSxoLGwpe3JldHVybiBULmQoYSxiLGMsZSxoLEtjKFtsXSwwKSl9Yy5pPTM7Yy5mPWZ1bmN0aW9uKGEpe3ZhciBiPUcoYSk7YT1LKGEpO3ZhciBjPUcoYSk7YT1LKGEpO3ZhciBlPUcoYSk7YT1IKGEpO3JldHVybiBkKGIsYyxlLGEpfTtjLmQ9ZDtyZXR1cm4gY30oKSxxPWZ1bmN0aW9uKGEsYixmLGcpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDA6cmV0dXJuIHAuY2FsbCh0aGlzKTtjYXNlIDE6cmV0dXJuIGUuY2FsbCh0aGlzLGEpO2Nhc2UgMjpyZXR1cm4gZC5jYWxsKHRoaXMsYSxiKTtjYXNlIDM6cmV0dXJuIGMuY2FsbCh0aGlzLGEsYixmKTtkZWZhdWx0OnZhciBxPW51bGw7aWYoMzxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIHE9MCxOPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtXG4zKTtxPE4ubGVuZ3RoOylOW3FdPWFyZ3VtZW50c1txKzNdLCsrcTtxPW5ldyBGKE4sMCl9cmV0dXJuIHMuZChhLGIsZixxKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307cS5pPTM7cS5mPXMuZjtxLmw9cDtxLmI9ZTtxLmE9ZDtxLmM9YztxLmQ9cy5kO3JldHVybiBxfSgpfXZhciBkPW51bGwsZT1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYyxkLGUsZixxKXt2YXIgcz1udWxsO2lmKDQ8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBzPTAsdT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTQpO3M8dS5sZW5ndGg7KXVbc109YXJndW1lbnRzW3MrNF0sKytzO3M9bmV3IEYodSwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsYyxkLGUsZixzKX1mdW5jdGlvbiBiKGEsYyxkLGUsZil7cmV0dXJuIGZ1bmN0aW9uKCl7ZnVuY3Rpb24gYihhKXt2YXIgYz1udWxsO2lmKDA8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBjPTAsZD1BcnJheShhcmd1bWVudHMubGVuZ3RoLVxuMCk7YzxkLmxlbmd0aDspZFtjXT1hcmd1bWVudHNbYyswXSwrK2M7Yz1uZXcgRihkLDApfXJldHVybiBnLmNhbGwodGhpcyxjKX1mdW5jdGlvbiBnKGIpe3JldHVybiBULnIoYSxjLGQsZSxhZS5hKGYsYikpfWIuaT0wO2IuZj1mdW5jdGlvbihhKXthPUQoYSk7cmV0dXJuIGcoYSl9O2IuZD1nO3JldHVybiBifSgpfWEuaT00O2EuZj1mdW5jdGlvbihhKXt2YXIgYz1HKGEpO2E9SyhhKTt2YXIgZD1HKGEpO2E9SyhhKTt2YXIgZT1HKGEpO2E9SyhhKTt2YXIgZj1HKGEpO2E9SChhKTtyZXR1cm4gYihjLGQsZSxmLGEpfTthLmQ9YjtyZXR1cm4gYX0oKSxkPWZ1bmN0aW9uKGQsZyxoLGwsbSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gZDtjYXNlIDI6cmV0dXJuIGMuY2FsbCh0aGlzLGQsZyk7Y2FzZSAzOnJldHVybiBiLmNhbGwodGhpcyxkLGcsaCk7Y2FzZSA0OnJldHVybiBhLmNhbGwodGhpcyxkLGcsaCxsKTtkZWZhdWx0OnZhciBwPW51bGw7aWYoNDxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIHA9XG4wLHE9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC00KTtwPHEubGVuZ3RoOylxW3BdPWFyZ3VtZW50c1twKzRdLCsrcDtwPW5ldyBGKHEsMCl9cmV0dXJuIGUuZChkLGcsaCxsLHApfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtkLmk9NDtkLmY9ZS5mO2QuYj1mdW5jdGlvbihhKXtyZXR1cm4gYX07ZC5hPWM7ZC5jPWI7ZC5uPWE7ZC5kPWUuZDtyZXR1cm4gZH0oKSxLZT1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMsZCl7cmV0dXJuIGZ1bmN0aW9uKCl7ZnVuY3Rpb24gbChsLG0scCl7bD1udWxsPT1sP2I6bDttPW51bGw9PW0/YzptO3A9bnVsbD09cD9kOnA7cmV0dXJuIGEuYz9hLmMobCxtLHApOmEuY2FsbChudWxsLGwsbSxwKX1mdW5jdGlvbiBtKGQsaCl7dmFyIGw9bnVsbD09ZD9iOmQsbT1udWxsPT1oP2M6aDtyZXR1cm4gYS5hP2EuYShsLG0pOmEuY2FsbChudWxsLGwsbSl9dmFyIHA9bnVsbCxxPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gbChhLFxuYixjLGQpe3ZhciBlPW51bGw7aWYoMzxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGU9MCxmPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMyk7ZTxmLmxlbmd0aDspZltlXT1hcmd1bWVudHNbZSszXSwrK2U7ZT1uZXcgRihmLDApfXJldHVybiBtLmNhbGwodGhpcyxhLGIsYyxlKX1mdW5jdGlvbiBtKGwscCxxLHMpe3JldHVybiBULnIoYSxudWxsPT1sP2I6bCxudWxsPT1wP2M6cCxudWxsPT1xP2Q6cSxzKX1sLmk9MztsLmY9ZnVuY3Rpb24oYSl7dmFyIGI9RyhhKTthPUsoYSk7dmFyIGM9RyhhKTthPUsoYSk7dmFyIGQ9RyhhKTthPUgoYSk7cmV0dXJuIG0oYixjLGQsYSl9O2wuZD1tO3JldHVybiBsfSgpLHA9ZnVuY3Rpb24oYSxiLGMsZCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gbS5jYWxsKHRoaXMsYSxiKTtjYXNlIDM6cmV0dXJuIGwuY2FsbCh0aGlzLGEsYixjKTtkZWZhdWx0OnZhciBlPW51bGw7aWYoMzxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGU9XG4wLGY9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0zKTtlPGYubGVuZ3RoOylmW2VdPWFyZ3VtZW50c1tlKzNdLCsrZTtlPW5ldyBGKGYsMCl9cmV0dXJuIHEuZChhLGIsYyxlKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307cC5pPTM7cC5mPXEuZjtwLmE9bTtwLmM9bDtwLmQ9cS5kO3JldHVybiBwfSgpfWZ1bmN0aW9uIGIoYSxiLGMpe3JldHVybiBmdW5jdGlvbigpe2Z1bmN0aW9uIGQoaCxsLG0pe2g9bnVsbD09aD9iOmg7bD1udWxsPT1sP2M6bDtyZXR1cm4gYS5jP2EuYyhoLGwsbSk6YS5jYWxsKG51bGwsaCxsLG0pfWZ1bmN0aW9uIGwoZCxoKXt2YXIgbD1udWxsPT1kP2I6ZCxtPW51bGw9PWg/YzpoO3JldHVybiBhLmE/YS5hKGwsbSk6YS5jYWxsKG51bGwsbCxtKX12YXIgbT1udWxsLHA9ZnVuY3Rpb24oKXtmdW5jdGlvbiBkKGEsYixjLGUpe3ZhciBmPW51bGw7aWYoMzxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGY9MCxnPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtXG4zKTtmPGcubGVuZ3RoOylnW2ZdPWFyZ3VtZW50c1tmKzNdLCsrZjtmPW5ldyBGKGcsMCl9cmV0dXJuIGguY2FsbCh0aGlzLGEsYixjLGYpfWZ1bmN0aW9uIGgoZCxsLG0scCl7cmV0dXJuIFQucihhLG51bGw9PWQ/YjpkLG51bGw9PWw/YzpsLG0scCl9ZC5pPTM7ZC5mPWZ1bmN0aW9uKGEpe3ZhciBiPUcoYSk7YT1LKGEpO3ZhciBjPUcoYSk7YT1LKGEpO3ZhciBkPUcoYSk7YT1IKGEpO3JldHVybiBoKGIsYyxkLGEpfTtkLmQ9aDtyZXR1cm4gZH0oKSxtPWZ1bmN0aW9uKGEsYixjLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIGwuY2FsbCh0aGlzLGEsYik7Y2FzZSAzOnJldHVybiBkLmNhbGwodGhpcyxhLGIsYyk7ZGVmYXVsdDp2YXIgZj1udWxsO2lmKDM8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBmPTAsZz1BcnJheShhcmd1bWVudHMubGVuZ3RoLTMpO2Y8Zy5sZW5ndGg7KWdbZl09YXJndW1lbnRzW2YrM10sKytmO2Y9bmV3IEYoZywwKX1yZXR1cm4gcC5kKGEsXG5iLGMsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O20uaT0zO20uZj1wLmY7bS5hPWw7bS5jPWQ7bS5kPXAuZDtyZXR1cm4gbX0oKX1mdW5jdGlvbiBjKGEsYil7cmV0dXJuIGZ1bmN0aW9uKCl7ZnVuY3Rpb24gYyhkLGcsaCl7ZD1udWxsPT1kP2I6ZDtyZXR1cm4gYS5jP2EuYyhkLGcsaCk6YS5jYWxsKG51bGwsZCxnLGgpfWZ1bmN0aW9uIGQoYyxnKXt2YXIgaD1udWxsPT1jP2I6YztyZXR1cm4gYS5hP2EuYShoLGcpOmEuY2FsbChudWxsLGgsZyl9ZnVuY3Rpb24gbChjKXtjPW51bGw9PWM/YjpjO3JldHVybiBhLmI/YS5iKGMpOmEuY2FsbChudWxsLGMpfXZhciBtPW51bGwscD1mdW5jdGlvbigpe2Z1bmN0aW9uIGMoYSxiLGUsZil7dmFyIGc9bnVsbDtpZigzPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZz0wLGg9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0zKTtnPGgubGVuZ3RoOyloW2ddPWFyZ3VtZW50c1tnKzNdLCsrZztnPW5ldyBGKGgsXG4wKX1yZXR1cm4gZC5jYWxsKHRoaXMsYSxiLGUsZyl9ZnVuY3Rpb24gZChjLGcsaCxsKXtyZXR1cm4gVC5yKGEsbnVsbD09Yz9iOmMsZyxoLGwpfWMuaT0zO2MuZj1mdW5jdGlvbihhKXt2YXIgYj1HKGEpO2E9SyhhKTt2YXIgYz1HKGEpO2E9SyhhKTt2YXIgZT1HKGEpO2E9SChhKTtyZXR1cm4gZChiLGMsZSxhKX07Yy5kPWQ7cmV0dXJuIGN9KCksbT1mdW5jdGlvbihhLGIsZSxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBsLmNhbGwodGhpcyxhKTtjYXNlIDI6cmV0dXJuIGQuY2FsbCh0aGlzLGEsYik7Y2FzZSAzOnJldHVybiBjLmNhbGwodGhpcyxhLGIsZSk7ZGVmYXVsdDp2YXIgbT1udWxsO2lmKDM8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBtPTAsQj1BcnJheShhcmd1bWVudHMubGVuZ3RoLTMpO208Qi5sZW5ndGg7KUJbbV09YXJndW1lbnRzW20rM10sKyttO209bmV3IEYoQiwwKX1yZXR1cm4gcC5kKGEsYixlLG0pfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrXG5hcmd1bWVudHMubGVuZ3RoKTt9O20uaT0zO20uZj1wLmY7bS5iPWw7bS5hPWQ7bS5jPWM7bS5kPXAuZDtyZXR1cm4gbX0oKX12YXIgZD1udWxsLGQ9ZnVuY3Rpb24oZCxmLGcsaCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gYy5jYWxsKHRoaXMsZCxmKTtjYXNlIDM6cmV0dXJuIGIuY2FsbCh0aGlzLGQsZixnKTtjYXNlIDQ6cmV0dXJuIGEuY2FsbCh0aGlzLGQsZixnLGgpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtkLmE9YztkLmM9YjtkLm49YTtyZXR1cm4gZH0oKSxMZT1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiKXtyZXR1cm4gbmV3IFYobnVsbCxmdW5jdGlvbigpe3ZhciBmPUQoYik7aWYoZil7aWYoZmQoZikpe2Zvcih2YXIgZz1ZYihmKSxoPVEoZyksbD1UZChoKSxtPTA7OylpZihtPGgpe3ZhciBwPWZ1bmN0aW9uKCl7dmFyIGI9Qy5hKGcsbSk7cmV0dXJuIGEuYj9hLmIoYik6YS5jYWxsKG51bGwsYil9KCk7XG5udWxsIT1wJiZsLmFkZChwKTttKz0xfWVsc2UgYnJlYWs7cmV0dXJuIFdkKGwuY2EoKSxjLmEoYSxaYihmKSkpfWg9ZnVuY3Rpb24oKXt2YXIgYj1HKGYpO3JldHVybiBhLmI/YS5iKGIpOmEuY2FsbChudWxsLGIpfSgpO3JldHVybiBudWxsPT1oP2MuYShhLEgoZikpOk0oaCxjLmEoYSxIKGYpKSl9cmV0dXJuIG51bGx9LG51bGwsbnVsbCl9ZnVuY3Rpb24gYihhKXtyZXR1cm4gZnVuY3Rpb24oYil7cmV0dXJuIGZ1bmN0aW9uKCl7ZnVuY3Rpb24gYyhmLGcpe3ZhciBoPWEuYj9hLmIoZyk6YS5jYWxsKG51bGwsZyk7cmV0dXJuIG51bGw9PWg/ZjpiLmE/Yi5hKGYsaCk6Yi5jYWxsKG51bGwsZixoKX1mdW5jdGlvbiBnKGEpe3JldHVybiBiLmI/Yi5iKGEpOmIuY2FsbChudWxsLGEpfWZ1bmN0aW9uIGgoKXtyZXR1cm4gYi5sP2IubCgpOmIuY2FsbChudWxsKX12YXIgbD1udWxsLGw9ZnVuY3Rpb24oYSxiKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAwOnJldHVybiBoLmNhbGwodGhpcyk7XG5jYXNlIDE6cmV0dXJuIGcuY2FsbCh0aGlzLGEpO2Nhc2UgMjpyZXR1cm4gYy5jYWxsKHRoaXMsYSxiKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307bC5sPWg7bC5iPWc7bC5hPWM7cmV0dXJuIGx9KCl9fXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGIuY2FsbCh0aGlzLGMpO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5iPWI7Yy5hPWE7cmV0dXJuIGN9KCk7ZnVuY3Rpb24gTWUoYSl7dGhpcy5zdGF0ZT1hO3RoaXMucT0wO3RoaXMuaj0zMjc2OH1NZS5wcm90b3R5cGUuUmE9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5zdGF0ZX07TWUucHJvdG90eXBlLmJiPWZ1bmN0aW9uKGEsYil7cmV0dXJuIHRoaXMuc3RhdGU9Yn07XG52YXIgTmU9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYil7cmV0dXJuIGZ1bmN0aW9uIGcoYixjKXtyZXR1cm4gbmV3IFYobnVsbCxmdW5jdGlvbigpe3ZhciBlPUQoYyk7aWYoZSl7aWYoZmQoZSkpe2Zvcih2YXIgcD1ZYihlKSxxPVEocCkscz1UZChxKSx1PTA7OylpZih1PHEpe3ZhciB2PWZ1bmN0aW9uKCl7dmFyIGM9Yit1LGU9Qy5hKHAsdSk7cmV0dXJuIGEuYT9hLmEoYyxlKTphLmNhbGwobnVsbCxjLGUpfSgpO251bGwhPXYmJnMuYWRkKHYpO3UrPTF9ZWxzZSBicmVhaztyZXR1cm4gV2Qocy5jYSgpLGcoYitxLFpiKGUpKSl9cT1mdW5jdGlvbigpe3ZhciBjPUcoZSk7cmV0dXJuIGEuYT9hLmEoYixjKTphLmNhbGwobnVsbCxiLGMpfSgpO3JldHVybiBudWxsPT1xP2coYisxLEgoZSkpOk0ocSxnKGIrMSxIKGUpKSl9cmV0dXJuIG51bGx9LG51bGwsbnVsbCl9KDAsYil9ZnVuY3Rpb24gYihhKXtyZXR1cm4gZnVuY3Rpb24oYil7cmV0dXJuIGZ1bmN0aW9uKGMpe3JldHVybiBmdW5jdGlvbigpe2Z1bmN0aW9uIGcoZyxcbmgpe3ZhciBsPWMuYmIoMCxjLlJhKG51bGwpKzEpLGw9YS5hP2EuYShsLGgpOmEuY2FsbChudWxsLGwsaCk7cmV0dXJuIG51bGw9PWw/ZzpiLmE/Yi5hKGcsbCk6Yi5jYWxsKG51bGwsZyxsKX1mdW5jdGlvbiBoKGEpe3JldHVybiBiLmI/Yi5iKGEpOmIuY2FsbChudWxsLGEpfWZ1bmN0aW9uIGwoKXtyZXR1cm4gYi5sP2IubCgpOmIuY2FsbChudWxsKX12YXIgbT1udWxsLG09ZnVuY3Rpb24oYSxiKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAwOnJldHVybiBsLmNhbGwodGhpcyk7Y2FzZSAxOnJldHVybiBoLmNhbGwodGhpcyxhKTtjYXNlIDI6cmV0dXJuIGcuY2FsbCh0aGlzLGEsYil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O20ubD1sO20uYj1oO20uYT1nO3JldHVybiBtfSgpfShuZXcgTWUoLTEpKX19dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYi5jYWxsKHRoaXMsXG5jKTtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYj1iO2MuYT1hO3JldHVybiBjfSgpLE9lPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyxkKXtyZXR1cm4gbmV3IFYobnVsbCxmdW5jdGlvbigpe3ZhciBmPUQoYikscT1EKGMpLHM9RChkKTtpZihmJiZxJiZzKXt2YXIgdT1NLHY7dj1HKGYpO3ZhciB5PUcocSksQj1HKHMpO3Y9YS5jP2EuYyh2LHksQik6YS5jYWxsKG51bGwsdix5LEIpO2Y9dSh2LGUubihhLEgoZiksSChxKSxIKHMpKSl9ZWxzZSBmPW51bGw7cmV0dXJuIGZ9LG51bGwsbnVsbCl9ZnVuY3Rpb24gYihhLGIsYyl7cmV0dXJuIG5ldyBWKG51bGwsZnVuY3Rpb24oKXt2YXIgZD1EKGIpLGY9RChjKTtpZihkJiZmKXt2YXIgcT1NLHM7cz1HKGQpO3ZhciB1PUcoZik7cz1hLmE/YS5hKHMsdSk6YS5jYWxsKG51bGwscyx1KTtkPXEocyxlLmMoYSxIKGQpLEgoZikpKX1lbHNlIGQ9XG5udWxsO3JldHVybiBkfSxudWxsLG51bGwpfWZ1bmN0aW9uIGMoYSxiKXtyZXR1cm4gbmV3IFYobnVsbCxmdW5jdGlvbigpe3ZhciBjPUQoYik7aWYoYyl7aWYoZmQoYykpe2Zvcih2YXIgZD1ZYihjKSxmPVEoZCkscT1UZChmKSxzPTA7OylpZihzPGYpWGQocSxmdW5jdGlvbigpe3ZhciBiPUMuYShkLHMpO3JldHVybiBhLmI/YS5iKGIpOmEuY2FsbChudWxsLGIpfSgpKSxzKz0xO2Vsc2UgYnJlYWs7cmV0dXJuIFdkKHEuY2EoKSxlLmEoYSxaYihjKSkpfXJldHVybiBNKGZ1bmN0aW9uKCl7dmFyIGI9RyhjKTtyZXR1cm4gYS5iP2EuYihiKTphLmNhbGwobnVsbCxiKX0oKSxlLmEoYSxIKGMpKSl9cmV0dXJuIG51bGx9LG51bGwsbnVsbCl9ZnVuY3Rpb24gZChhKXtyZXR1cm4gZnVuY3Rpb24oYil7cmV0dXJuIGZ1bmN0aW9uKCl7ZnVuY3Rpb24gYyhkLGUpe3ZhciBmPWEuYj9hLmIoZSk6YS5jYWxsKG51bGwsZSk7cmV0dXJuIGIuYT9iLmEoZCxmKTpiLmNhbGwobnVsbCxkLGYpfWZ1bmN0aW9uIGQoYSl7cmV0dXJuIGIuYj9cbmIuYihhKTpiLmNhbGwobnVsbCxhKX1mdW5jdGlvbiBlKCl7cmV0dXJuIGIubD9iLmwoKTpiLmNhbGwobnVsbCl9dmFyIGY9bnVsbCxzPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYyhhLGIsZSl7dmFyIGY9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZj0wLGc9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtmPGcubGVuZ3RoOylnW2ZdPWFyZ3VtZW50c1tmKzJdLCsrZjtmPW5ldyBGKGcsMCl9cmV0dXJuIGQuY2FsbCh0aGlzLGEsYixmKX1mdW5jdGlvbiBkKGMsZSxmKXtlPVQuYyhhLGUsZik7cmV0dXJuIGIuYT9iLmEoYyxlKTpiLmNhbGwobnVsbCxjLGUpfWMuaT0yO2MuZj1mdW5jdGlvbihhKXt2YXIgYj1HKGEpO2E9SyhhKTt2YXIgYz1HKGEpO2E9SChhKTtyZXR1cm4gZChiLGMsYSl9O2MuZD1kO3JldHVybiBjfSgpLGY9ZnVuY3Rpb24oYSxiLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDA6cmV0dXJuIGUuY2FsbCh0aGlzKTtjYXNlIDE6cmV0dXJuIGQuY2FsbCh0aGlzLFxuYSk7Y2FzZSAyOnJldHVybiBjLmNhbGwodGhpcyxhLGIpO2RlZmF1bHQ6dmFyIGc9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZz0wLGg9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtnPGgubGVuZ3RoOyloW2ddPWFyZ3VtZW50c1tnKzJdLCsrZztnPW5ldyBGKGgsMCl9cmV0dXJuIHMuZChhLGIsZyl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2YuaT0yO2YuZj1zLmY7Zi5sPWU7Zi5iPWQ7Zi5hPWM7Zi5kPXMuZDtyZXR1cm4gZn0oKX19dmFyIGU9bnVsbCxmPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShjLGQsZSxmLGcpe3ZhciB1PW51bGw7aWYoNDxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIHU9MCx2PUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtNCk7dTx2Lmxlbmd0aDspdlt1XT1hcmd1bWVudHNbdSs0XSwrK3U7dT1uZXcgRih2LDApfXJldHVybiBiLmNhbGwodGhpcyxjLGQsZSxmLHUpfWZ1bmN0aW9uIGIoYSxjLGQsXG5mLGcpe3ZhciBoPWZ1bmN0aW9uIHkoYSl7cmV0dXJuIG5ldyBWKG51bGwsZnVuY3Rpb24oKXt2YXIgYj1lLmEoRCxhKTtyZXR1cm4gRWUodWQsYik/TShlLmEoRyxiKSx5KGUuYShILGIpKSk6bnVsbH0sbnVsbCxudWxsKX07cmV0dXJuIGUuYShmdW5jdGlvbigpe3JldHVybiBmdW5jdGlvbihiKXtyZXR1cm4gVC5hKGEsYil9fShoKSxoKE5jLmQoZyxmLEtjKFtkLGNdLDApKSkpfWEuaT00O2EuZj1mdW5jdGlvbihhKXt2YXIgYz1HKGEpO2E9SyhhKTt2YXIgZD1HKGEpO2E9SyhhKTt2YXIgZT1HKGEpO2E9SyhhKTt2YXIgZj1HKGEpO2E9SChhKTtyZXR1cm4gYihjLGQsZSxmLGEpfTthLmQ9YjtyZXR1cm4gYX0oKSxlPWZ1bmN0aW9uKGUsaCxsLG0scCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gZC5jYWxsKHRoaXMsZSk7Y2FzZSAyOnJldHVybiBjLmNhbGwodGhpcyxlLGgpO2Nhc2UgMzpyZXR1cm4gYi5jYWxsKHRoaXMsZSxoLGwpO2Nhc2UgNDpyZXR1cm4gYS5jYWxsKHRoaXMsXG5lLGgsbCxtKTtkZWZhdWx0OnZhciBxPW51bGw7aWYoNDxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIHE9MCxzPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtNCk7cTxzLmxlbmd0aDspc1txXT1hcmd1bWVudHNbcSs0XSwrK3E7cT1uZXcgRihzLDApfXJldHVybiBmLmQoZSxoLGwsbSxxKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307ZS5pPTQ7ZS5mPWYuZjtlLmI9ZDtlLmE9YztlLmM9YjtlLm49YTtlLmQ9Zi5kO3JldHVybiBlfSgpLFBlPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIpe3JldHVybiBuZXcgVihudWxsLGZ1bmN0aW9uKCl7aWYoMDxhKXt2YXIgZj1EKGIpO3JldHVybiBmP00oRyhmKSxjLmEoYS0xLEgoZikpKTpudWxsfXJldHVybiBudWxsfSxudWxsLG51bGwpfWZ1bmN0aW9uIGIoYSl7cmV0dXJuIGZ1bmN0aW9uKGIpe3JldHVybiBmdW5jdGlvbihhKXtyZXR1cm4gZnVuY3Rpb24oKXtmdW5jdGlvbiBjKGQsZyl7dmFyIGg9cWIoYSksXG5sPWEuYmIoMCxhLlJhKG51bGwpLTEpLGg9MDxoP2IuYT9iLmEoZCxnKTpiLmNhbGwobnVsbCxkLGcpOmQ7cmV0dXJuIDA8bD9oOkFjKGgpP2g6bmV3IHljKGgpfWZ1bmN0aW9uIGQoYSl7cmV0dXJuIGIuYj9iLmIoYSk6Yi5jYWxsKG51bGwsYSl9ZnVuY3Rpb24gbCgpe3JldHVybiBiLmw/Yi5sKCk6Yi5jYWxsKG51bGwpfXZhciBtPW51bGwsbT1mdW5jdGlvbihhLGIpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDA6cmV0dXJuIGwuY2FsbCh0aGlzKTtjYXNlIDE6cmV0dXJuIGQuY2FsbCh0aGlzLGEpO2Nhc2UgMjpyZXR1cm4gYy5jYWxsKHRoaXMsYSxiKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307bS5sPWw7bS5iPWQ7bS5hPWM7cmV0dXJuIG19KCl9KG5ldyBNZShhKSl9fXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGIuY2FsbCh0aGlzLGMpO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsXG5jLGUpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmI9YjtjLmE9YTtyZXR1cm4gY30oKSxRZT1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiKXtyZXR1cm4gbmV3IFYobnVsbCxmdW5jdGlvbihjKXtyZXR1cm4gZnVuY3Rpb24oKXtyZXR1cm4gYyhhLGIpfX0oZnVuY3Rpb24oYSxiKXtmb3IoOzspe3ZhciBjPUQoYik7aWYoMDxhJiZjKXt2YXIgZD1hLTEsYz1IKGMpO2E9ZDtiPWN9ZWxzZSByZXR1cm4gY319KSxudWxsLG51bGwpfWZ1bmN0aW9uIGIoYSl7cmV0dXJuIGZ1bmN0aW9uKGIpe3JldHVybiBmdW5jdGlvbihhKXtyZXR1cm4gZnVuY3Rpb24oKXtmdW5jdGlvbiBjKGQsZyl7dmFyIGg9cWIoYSk7YS5iYigwLGEuUmEobnVsbCktMSk7cmV0dXJuIDA8aD9kOmIuYT9iLmEoZCxnKTpiLmNhbGwobnVsbCxkLGcpfWZ1bmN0aW9uIGQoYSl7cmV0dXJuIGIuYj9iLmIoYSk6Yi5jYWxsKG51bGwsYSl9ZnVuY3Rpb24gbCgpe3JldHVybiBiLmw/XG5iLmwoKTpiLmNhbGwobnVsbCl9dmFyIG09bnVsbCxtPWZ1bmN0aW9uKGEsYil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMDpyZXR1cm4gbC5jYWxsKHRoaXMpO2Nhc2UgMTpyZXR1cm4gZC5jYWxsKHRoaXMsYSk7Y2FzZSAyOnJldHVybiBjLmNhbGwodGhpcyxhLGIpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTttLmw9bDttLmI9ZDttLmE9YztyZXR1cm4gbX0oKX0obmV3IE1lKGEpKX19dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYi5jYWxsKHRoaXMsYyk7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxjLGUpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmI9YjtjLmE9YTtyZXR1cm4gY30oKSxSZT1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiKXtyZXR1cm4gbmV3IFYobnVsbCxmdW5jdGlvbihjKXtyZXR1cm4gZnVuY3Rpb24oKXtyZXR1cm4gYyhhLFxuYil9fShmdW5jdGlvbihhLGIpe2Zvcig7Oyl7dmFyIGM9RChiKSxkO2lmKGQ9YylkPUcoYyksZD1hLmI/YS5iKGQpOmEuY2FsbChudWxsLGQpO2lmKHQoZCkpZD1hLGM9SChjKSxhPWQsYj1jO2Vsc2UgcmV0dXJuIGN9fSksbnVsbCxudWxsKX1mdW5jdGlvbiBiKGEpe3JldHVybiBmdW5jdGlvbihiKXtyZXR1cm4gZnVuY3Rpb24oYyl7cmV0dXJuIGZ1bmN0aW9uKCl7ZnVuY3Rpb24gZyhnLGgpe3ZhciBsPXFiKGMpO2lmKHQodChsKT9hLmI/YS5iKGgpOmEuY2FsbChudWxsLGgpOmwpKXJldHVybiBnO2FjKGMsbnVsbCk7cmV0dXJuIGIuYT9iLmEoZyxoKTpiLmNhbGwobnVsbCxnLGgpfWZ1bmN0aW9uIGgoYSl7cmV0dXJuIGIuYj9iLmIoYSk6Yi5jYWxsKG51bGwsYSl9ZnVuY3Rpb24gbCgpe3JldHVybiBiLmw/Yi5sKCk6Yi5jYWxsKG51bGwpfXZhciBtPW51bGwsbT1mdW5jdGlvbihhLGIpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDA6cmV0dXJuIGwuY2FsbCh0aGlzKTtjYXNlIDE6cmV0dXJuIGguY2FsbCh0aGlzLFxuYSk7Y2FzZSAyOnJldHVybiBnLmNhbGwodGhpcyxhLGIpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTttLmw9bDttLmI9aDttLmE9ZztyZXR1cm4gbX0oKX0obmV3IE1lKCEwKSl9fXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGIuY2FsbCh0aGlzLGMpO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5iPWI7Yy5hPWE7cmV0dXJuIGN9KCksU2U9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYil7cmV0dXJuIFBlLmEoYSxjLmIoYikpfWZ1bmN0aW9uIGIoYSl7cmV0dXJuIG5ldyBWKG51bGwsZnVuY3Rpb24oKXtyZXR1cm4gTShhLGMuYihhKSl9LG51bGwsbnVsbCl9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYi5jYWxsKHRoaXMsXG5jKTtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYj1iO2MuYT1hO3JldHVybiBjfSgpLFRlPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIpe3JldHVybiBQZS5hKGEsYy5iKGIpKX1mdW5jdGlvbiBiKGEpe3JldHVybiBuZXcgVihudWxsLGZ1bmN0aW9uKCl7cmV0dXJuIE0oYS5sP2EubCgpOmEuY2FsbChudWxsKSxjLmIoYSkpfSxudWxsLG51bGwpfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGIuY2FsbCh0aGlzLGMpO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5iPWI7Yy5hPWE7cmV0dXJuIGN9KCksVWU9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYyl7cmV0dXJuIG5ldyBWKG51bGwsZnVuY3Rpb24oKXt2YXIgZj1cbkQoYSksZz1EKGMpO3JldHVybiBmJiZnP00oRyhmKSxNKEcoZyksYi5hKEgoZiksSChnKSkpKTpudWxsfSxudWxsLG51bGwpfXZhciBiPW51bGwsYz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYixkLGgpe3ZhciBsPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGw9MCxtPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7bDxtLmxlbmd0aDspbVtsXT1hcmd1bWVudHNbbCsyXSwrK2w7bD1uZXcgRihtLDApfXJldHVybiBjLmNhbGwodGhpcyxiLGQsbCl9ZnVuY3Rpb24gYyhhLGQsZSl7cmV0dXJuIG5ldyBWKG51bGwsZnVuY3Rpb24oKXt2YXIgYz1PZS5hKEQsTmMuZChlLGQsS2MoW2FdLDApKSk7cmV0dXJuIEVlKHVkLGMpP2FlLmEoT2UuYShHLGMpLFQuYShiLE9lLmEoSCxjKSkpOm51bGx9LG51bGwsbnVsbCl9YS5pPTI7YS5mPWZ1bmN0aW9uKGEpe3ZhciBiPUcoYSk7YT1LKGEpO3ZhciBkPUcoYSk7YT1IKGEpO3JldHVybiBjKGIsZCxhKX07YS5kPWM7cmV0dXJuIGF9KCksXG5iPWZ1bmN0aW9uKGIsZSxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxiLGUpO2RlZmF1bHQ6dmFyIGc9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZz0wLGg9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtnPGgubGVuZ3RoOyloW2ddPWFyZ3VtZW50c1tnKzJdLCsrZztnPW5ldyBGKGgsMCl9cmV0dXJuIGMuZChiLGUsZyl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2IuaT0yO2IuZj1jLmY7Yi5hPWE7Yi5kPWMuZDtyZXR1cm4gYn0oKSxXZT1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSl7cmV0dXJuIEllLmEoT2UuYihhKSxWZSl9dmFyIGI9bnVsbCxjPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShjLGQpe3ZhciBoPW51bGw7aWYoMTxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGg9MCxsPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMSk7aDxsLmxlbmd0aDspbFtoXT1hcmd1bWVudHNbaCtcbjFdLCsraDtoPW5ldyBGKGwsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGMsaCl9ZnVuY3Rpb24gYihhLGMpe3JldHVybiBULmEoYWUsVC5jKE9lLGEsYykpfWEuaT0xO2EuZj1mdW5jdGlvbihhKXt2YXIgYz1HKGEpO2E9SChhKTtyZXR1cm4gYihjLGEpfTthLmQ9YjtyZXR1cm4gYX0oKSxiPWZ1bmN0aW9uKGIsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYS5jYWxsKHRoaXMsYik7ZGVmYXVsdDp2YXIgZj1udWxsO2lmKDE8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBmPTAsZz1BcnJheShhcmd1bWVudHMubGVuZ3RoLTEpO2Y8Zy5sZW5ndGg7KWdbZl09YXJndW1lbnRzW2YrMV0sKytmO2Y9bmV3IEYoZywwKX1yZXR1cm4gYy5kKGIsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2IuaT0xO2IuZj1jLmY7Yi5iPWE7Yi5kPWMuZDtyZXR1cm4gYn0oKSxYZT1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiKXtyZXR1cm4gbmV3IFYobnVsbCxcbmZ1bmN0aW9uKCl7dmFyIGY9RChiKTtpZihmKXtpZihmZChmKSl7Zm9yKHZhciBnPVliKGYpLGg9UShnKSxsPVRkKGgpLG09MDs7KWlmKG08aCl7dmFyIHA7cD1DLmEoZyxtKTtwPWEuYj9hLmIocCk6YS5jYWxsKG51bGwscCk7dChwKSYmKHA9Qy5hKGcsbSksbC5hZGQocCkpO20rPTF9ZWxzZSBicmVhaztyZXR1cm4gV2QobC5jYSgpLGMuYShhLFpiKGYpKSl9Zz1HKGYpO2Y9SChmKTtyZXR1cm4gdChhLmI/YS5iKGcpOmEuY2FsbChudWxsLGcpKT9NKGcsYy5hKGEsZikpOmMuYShhLGYpfXJldHVybiBudWxsfSxudWxsLG51bGwpfWZ1bmN0aW9uIGIoYSl7cmV0dXJuIGZ1bmN0aW9uKGIpe3JldHVybiBmdW5jdGlvbigpe2Z1bmN0aW9uIGMoZixnKXtyZXR1cm4gdChhLmI/YS5iKGcpOmEuY2FsbChudWxsLGcpKT9iLmE/Yi5hKGYsZyk6Yi5jYWxsKG51bGwsZixnKTpmfWZ1bmN0aW9uIGcoYSl7cmV0dXJuIGIuYj9iLmIoYSk6Yi5jYWxsKG51bGwsYSl9ZnVuY3Rpb24gaCgpe3JldHVybiBiLmw/XG5iLmwoKTpiLmNhbGwobnVsbCl9dmFyIGw9bnVsbCxsPWZ1bmN0aW9uKGEsYil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMDpyZXR1cm4gaC5jYWxsKHRoaXMpO2Nhc2UgMTpyZXR1cm4gZy5jYWxsKHRoaXMsYSk7Y2FzZSAyOnJldHVybiBjLmNhbGwodGhpcyxhLGIpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtsLmw9aDtsLmI9ZztsLmE9YztyZXR1cm4gbH0oKX19dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYi5jYWxsKHRoaXMsYyk7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxjLGUpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmI9YjtjLmE9YTtyZXR1cm4gY30oKSxZZT1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiKXtyZXR1cm4gWGUuYShIZShhKSxiKX1mdW5jdGlvbiBiKGEpe3JldHVybiBYZS5iKEhlKGEpKX1cbnZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGIuY2FsbCh0aGlzLGMpO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5iPWI7Yy5hPWE7cmV0dXJuIGN9KCk7ZnVuY3Rpb24gWmUoYSl7dmFyIGI9JGU7cmV0dXJuIGZ1bmN0aW9uIGQoYSl7cmV0dXJuIG5ldyBWKG51bGwsZnVuY3Rpb24oKXtyZXR1cm4gTShhLHQoYi5iP2IuYihhKTpiLmNhbGwobnVsbCxhKSk/V2UuZChkLEtjKFtELmI/RC5iKGEpOkQuY2FsbChudWxsLGEpXSwwKSk6bnVsbCl9LG51bGwsbnVsbCl9KGEpfVxudmFyIGFmPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyl7cmV0dXJuIGEmJihhLnEmNHx8YS5kYyk/TyhjZSh3ZC5uKGIsZGUsT2IoYSksYykpLFZjKGEpKTp3ZC5uKGIsTmMsYSxjKX1mdW5jdGlvbiBiKGEsYil7cmV0dXJuIG51bGwhPWE/YSYmKGEucSY0fHxhLmRjKT9PKGNlKEEuYyhQYixPYihhKSxiKSksVmMoYSkpOkEuYyhSYSxhLGIpOkEuYyhOYyxKLGIpfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gYi5jYWxsKHRoaXMsYyxlKTtjYXNlIDM6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSxmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5hPWI7Yy5jPWE7cmV0dXJuIGN9KCksYmY9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjLGgpe3JldHVybiBuZXcgVihudWxsLGZ1bmN0aW9uKCl7dmFyIGw9RChoKTtpZihsKXt2YXIgbT1QZS5hKGEsbCk7cmV0dXJuIGE9PT1cblEobSk/TShtLGQubihhLGIsYyxRZS5hKGIsbCkpKTpSYShKLFBlLmEoYSxhZS5hKG0sYykpKX1yZXR1cm4gbnVsbH0sbnVsbCxudWxsKX1mdW5jdGlvbiBiKGEsYixjKXtyZXR1cm4gbmV3IFYobnVsbCxmdW5jdGlvbigpe3ZhciBoPUQoYyk7aWYoaCl7dmFyIGw9UGUuYShhLGgpO3JldHVybiBhPT09UShsKT9NKGwsZC5jKGEsYixRZS5hKGIsaCkpKTpudWxsfXJldHVybiBudWxsfSxudWxsLG51bGwpfWZ1bmN0aW9uIGMoYSxiKXtyZXR1cm4gZC5jKGEsYSxiKX12YXIgZD1udWxsLGQ9ZnVuY3Rpb24oZCxmLGcsaCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gYy5jYWxsKHRoaXMsZCxmKTtjYXNlIDM6cmV0dXJuIGIuY2FsbCh0aGlzLGQsZixnKTtjYXNlIDQ6cmV0dXJuIGEuY2FsbCh0aGlzLGQsZixnLGgpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtkLmE9YztkLmM9YjtkLm49YTtyZXR1cm4gZH0oKSxjZj1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxcbmIsYyl7dmFyIGc9amQ7Zm9yKGI9RChiKTs7KWlmKGIpe3ZhciBoPWE7aWYoaD9oLmomMjU2fHxoLlJifHwoaC5qPzA6dyhaYSxoKSk6dyhaYSxoKSl7YT1TLmMoYSxHKGIpLGcpO2lmKGc9PT1hKXJldHVybiBjO2I9SyhiKX1lbHNlIHJldHVybiBjfWVsc2UgcmV0dXJuIGF9ZnVuY3Rpb24gYihhLGIpe3JldHVybiBjLmMoYSxiLG51bGwpfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gYi5jYWxsKHRoaXMsYyxlKTtjYXNlIDM6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSxmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5hPWI7Yy5jPWE7cmV0dXJuIGN9KCksZGY9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjLGQsZixxKXt2YXIgcz1SLmMoYiwwLG51bGwpO3JldHVybihiPUVkKGIpKT9SYy5jKGEscyxlLlAoUy5hKGEscyksYixjLGQsZixxKSk6UmMuYyhhLHMsXG5mdW5jdGlvbigpe3ZhciBiPVMuYShhLHMpO3JldHVybiBjLm4/Yy5uKGIsZCxmLHEpOmMuY2FsbChudWxsLGIsZCxmLHEpfSgpKX1mdW5jdGlvbiBiKGEsYixjLGQsZil7dmFyIHE9Ui5jKGIsMCxudWxsKTtyZXR1cm4oYj1FZChiKSk/UmMuYyhhLHEsZS5yKFMuYShhLHEpLGIsYyxkLGYpKTpSYy5jKGEscSxmdW5jdGlvbigpe3ZhciBiPVMuYShhLHEpO3JldHVybiBjLmM/Yy5jKGIsZCxmKTpjLmNhbGwobnVsbCxiLGQsZil9KCkpfWZ1bmN0aW9uIGMoYSxiLGMsZCl7dmFyIGY9Ui5jKGIsMCxudWxsKTtyZXR1cm4oYj1FZChiKSk/UmMuYyhhLGYsZS5uKFMuYShhLGYpLGIsYyxkKSk6UmMuYyhhLGYsZnVuY3Rpb24oKXt2YXIgYj1TLmEoYSxmKTtyZXR1cm4gYy5hP2MuYShiLGQpOmMuY2FsbChudWxsLGIsZCl9KCkpfWZ1bmN0aW9uIGQoYSxiLGMpe3ZhciBkPVIuYyhiLDAsbnVsbCk7cmV0dXJuKGI9RWQoYikpP1JjLmMoYSxkLGUuYyhTLmEoYSxkKSxiLGMpKTpSYy5jKGEsZCxmdW5jdGlvbigpe3ZhciBiPVxuUy5hKGEsZCk7cmV0dXJuIGMuYj9jLmIoYik6Yy5jYWxsKG51bGwsYil9KCkpfXZhciBlPW51bGwsZj1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYyxkLGUsZixnLHUsdil7dmFyIHk9bnVsbDtpZig2PGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgeT0wLEI9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC02KTt5PEIubGVuZ3RoOylCW3ldPWFyZ3VtZW50c1t5KzZdLCsreTt5PW5ldyBGKEIsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGMsZCxlLGYsZyx1LHkpfWZ1bmN0aW9uIGIoYSxjLGQsZixnLGgsdil7dmFyIHk9Ui5jKGMsMCxudWxsKTtyZXR1cm4oYz1FZChjKSk/UmMuYyhhLHksVC5kKGUsUy5hKGEseSksYyxkLGYsS2MoW2csaCx2XSwwKSkpOlJjLmMoYSx5LFQuZChkLFMuYShhLHkpLGYsZyxoLEtjKFt2XSwwKSkpfWEuaT02O2EuZj1mdW5jdGlvbihhKXt2YXIgYz1HKGEpO2E9SyhhKTt2YXIgZD1HKGEpO2E9SyhhKTt2YXIgZT1HKGEpO2E9SyhhKTt2YXIgZj1HKGEpO2E9SyhhKTt2YXIgZz1cbkcoYSk7YT1LKGEpO3ZhciB2PUcoYSk7YT1IKGEpO3JldHVybiBiKGMsZCxlLGYsZyx2LGEpfTthLmQ9YjtyZXR1cm4gYX0oKSxlPWZ1bmN0aW9uKGUsaCxsLG0scCxxLHMpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDM6cmV0dXJuIGQuY2FsbCh0aGlzLGUsaCxsKTtjYXNlIDQ6cmV0dXJuIGMuY2FsbCh0aGlzLGUsaCxsLG0pO2Nhc2UgNTpyZXR1cm4gYi5jYWxsKHRoaXMsZSxoLGwsbSxwKTtjYXNlIDY6cmV0dXJuIGEuY2FsbCh0aGlzLGUsaCxsLG0scCxxKTtkZWZhdWx0OnZhciB1PW51bGw7aWYoNjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIHU9MCx2PUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtNik7dTx2Lmxlbmd0aDspdlt1XT1hcmd1bWVudHNbdSs2XSwrK3U7dT1uZXcgRih2LDApfXJldHVybiBmLmQoZSxoLGwsbSxwLHEsdSl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2UuaT02O2UuZj1mLmY7ZS5jPWQ7ZS5uPWM7XG5lLnI9YjtlLlA9YTtlLmQ9Zi5kO3JldHVybiBlfSgpO2Z1bmN0aW9uIGVmKGEsYil7dGhpcy51PWE7dGhpcy5lPWJ9ZnVuY3Rpb24gZmYoYSl7cmV0dXJuIG5ldyBlZihhLFtudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGxdKX1mdW5jdGlvbiBnZihhKXtyZXR1cm4gbmV3IGVmKGEudSxGYShhLmUpKX1mdW5jdGlvbiBoZihhKXthPWEuZztyZXR1cm4gMzI+YT8wOmEtMT4+PjU8PDV9ZnVuY3Rpb24gamYoYSxiLGMpe2Zvcig7Oyl7aWYoMD09PWIpcmV0dXJuIGM7dmFyIGQ9ZmYoYSk7ZC5lWzBdPWM7Yz1kO2ItPTV9fVxudmFyIGxmPWZ1bmN0aW9uIGtmKGIsYyxkLGUpe3ZhciBmPWdmKGQpLGc9Yi5nLTE+Pj5jJjMxOzU9PT1jP2YuZVtnXT1lOihkPWQuZVtnXSxiPW51bGwhPWQ/a2YoYixjLTUsZCxlKTpqZihudWxsLGMtNSxlKSxmLmVbZ109Yik7cmV0dXJuIGZ9O2Z1bmN0aW9uIG1mKGEsYil7dGhyb3cgRXJyb3IoW3ooXCJObyBpdGVtIFwiKSx6KGEpLHooXCIgaW4gdmVjdG9yIG9mIGxlbmd0aCBcIikseihiKV0uam9pbihcIlwiKSk7fWZ1bmN0aW9uIG5mKGEsYil7aWYoYj49aGYoYSkpcmV0dXJuIGEuVztmb3IodmFyIGM9YS5yb290LGQ9YS5zaGlmdDs7KWlmKDA8ZCl2YXIgZT1kLTUsYz1jLmVbYj4+PmQmMzFdLGQ9ZTtlbHNlIHJldHVybiBjLmV9ZnVuY3Rpb24gb2YoYSxiKXtyZXR1cm4gMDw9YiYmYjxhLmc/bmYoYSxiKTptZihiLGEuZyl9XG52YXIgcWY9ZnVuY3Rpb24gcGYoYixjLGQsZSxmKXt2YXIgZz1nZihkKTtpZigwPT09YylnLmVbZSYzMV09ZjtlbHNle3ZhciBoPWU+Pj5jJjMxO2I9cGYoYixjLTUsZC5lW2hdLGUsZik7Zy5lW2hdPWJ9cmV0dXJuIGd9LHNmPWZ1bmN0aW9uIHJmKGIsYyxkKXt2YXIgZT1iLmctMj4+PmMmMzE7aWYoNTxjKXtiPXJmKGIsYy01LGQuZVtlXSk7aWYobnVsbD09YiYmMD09PWUpcmV0dXJuIG51bGw7ZD1nZihkKTtkLmVbZV09YjtyZXR1cm4gZH1pZigwPT09ZSlyZXR1cm4gbnVsbDtkPWdmKGQpO2QuZVtlXT1udWxsO3JldHVybiBkfTtmdW5jdGlvbiB0ZihhLGIsYyxkLGUsZil7dGhpcy5tPWE7dGhpcy56Yj1iO3RoaXMuZT1jO3RoaXMub2E9ZDt0aGlzLnN0YXJ0PWU7dGhpcy5lbmQ9Zn10Zi5wcm90b3R5cGUuZ2E9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5tPHRoaXMuZW5kfTtcbnRmLnByb3RvdHlwZS5uZXh0PWZ1bmN0aW9uKCl7MzI9PT10aGlzLm0tdGhpcy56YiYmKHRoaXMuZT1uZih0aGlzLm9hLHRoaXMubSksdGhpcy56Yis9MzIpO3ZhciBhPXRoaXMuZVt0aGlzLm0mMzFdO3RoaXMubSs9MTtyZXR1cm4gYX07ZnVuY3Rpb24gVyhhLGIsYyxkLGUsZil7dGhpcy5rPWE7dGhpcy5nPWI7dGhpcy5zaGlmdD1jO3RoaXMucm9vdD1kO3RoaXMuVz1lO3RoaXMucD1mO3RoaXMuaj0xNjc2Njg1MTE7dGhpcy5xPTgxOTZ9az1XLnByb3RvdHlwZTtrLnRvU3RyaW5nPWZ1bmN0aW9uKCl7cmV0dXJuIGVjKHRoaXMpfTtrLnQ9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gJGEuYyh0aGlzLGIsbnVsbCl9O2sucz1mdW5jdGlvbihhLGIsYyl7cmV0dXJuXCJudW1iZXJcIj09PXR5cGVvZiBiP0MuYyh0aGlzLGIsYyk6Y307XG5rLmdiPWZ1bmN0aW9uKGEsYixjKXthPTA7Zm9yKHZhciBkPWM7OylpZihhPHRoaXMuZyl7dmFyIGU9bmYodGhpcyxhKTtjPWUubGVuZ3RoO2E6e2Zvcih2YXIgZj0wOzspaWYoZjxjKXt2YXIgZz1mK2EsaD1lW2ZdLGQ9Yi5jP2IuYyhkLGcsaCk6Yi5jYWxsKG51bGwsZCxnLGgpO2lmKEFjKGQpKXtlPWQ7YnJlYWsgYX1mKz0xfWVsc2V7ZT1kO2JyZWFrIGF9ZT12b2lkIDB9aWYoQWMoZSkpcmV0dXJuIGI9ZSxMLmI/TC5iKGIpOkwuY2FsbChudWxsLGIpO2ErPWM7ZD1lfWVsc2UgcmV0dXJuIGR9O2suUT1mdW5jdGlvbihhLGIpe3JldHVybiBvZih0aGlzLGIpW2ImMzFdfTtrLiQ9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiAwPD1iJiZiPHRoaXMuZz9uZih0aGlzLGIpW2ImMzFdOmN9O1xuay5VYT1mdW5jdGlvbihhLGIsYyl7aWYoMDw9YiYmYjx0aGlzLmcpcmV0dXJuIGhmKHRoaXMpPD1iPyhhPUZhKHRoaXMuVyksYVtiJjMxXT1jLG5ldyBXKHRoaXMuayx0aGlzLmcsdGhpcy5zaGlmdCx0aGlzLnJvb3QsYSxudWxsKSk6bmV3IFcodGhpcy5rLHRoaXMuZyx0aGlzLnNoaWZ0LHFmKHRoaXMsdGhpcy5zaGlmdCx0aGlzLnJvb3QsYixjKSx0aGlzLlcsbnVsbCk7aWYoYj09PXRoaXMuZylyZXR1cm4gUmEodGhpcyxjKTt0aHJvdyBFcnJvcihbeihcIkluZGV4IFwiKSx6KGIpLHooXCIgb3V0IG9mIGJvdW5kcyAgWzAsXCIpLHoodGhpcy5nKSx6KFwiXVwiKV0uam9pbihcIlwiKSk7fTtrLnZiPSEwO2suZmI9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLmc7cmV0dXJuIG5ldyB0ZigwLDAsMDxRKHRoaXMpP25mKHRoaXMsMCk6bnVsbCx0aGlzLDAsYSl9O2suSD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmt9O2suTD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmd9O1xuay5oYj1mdW5jdGlvbigpe3JldHVybiBDLmEodGhpcywwKX07ay5pYj1mdW5jdGlvbigpe3JldHVybiBDLmEodGhpcywxKX07ay5MYT1mdW5jdGlvbigpe3JldHVybiAwPHRoaXMuZz9DLmEodGhpcyx0aGlzLmctMSk6bnVsbH07XG5rLk1hPWZ1bmN0aW9uKCl7aWYoMD09PXRoaXMuZyl0aHJvdyBFcnJvcihcIkNhbid0IHBvcCBlbXB0eSB2ZWN0b3JcIik7aWYoMT09PXRoaXMuZylyZXR1cm4gdWIoTWMsdGhpcy5rKTtpZigxPHRoaXMuZy1oZih0aGlzKSlyZXR1cm4gbmV3IFcodGhpcy5rLHRoaXMuZy0xLHRoaXMuc2hpZnQsdGhpcy5yb290LHRoaXMuVy5zbGljZSgwLC0xKSxudWxsKTt2YXIgYT1uZih0aGlzLHRoaXMuZy0yKSxiPXNmKHRoaXMsdGhpcy5zaGlmdCx0aGlzLnJvb3QpLGI9bnVsbD09Yj91ZjpiLGM9dGhpcy5nLTE7cmV0dXJuIDU8dGhpcy5zaGlmdCYmbnVsbD09Yi5lWzFdP25ldyBXKHRoaXMuayxjLHRoaXMuc2hpZnQtNSxiLmVbMF0sYSxudWxsKTpuZXcgVyh0aGlzLmssYyx0aGlzLnNoaWZ0LGIsYSxudWxsKX07ay5hYj1mdW5jdGlvbigpe3JldHVybiAwPHRoaXMuZz9uZXcgSGModGhpcyx0aGlzLmctMSxudWxsKTpudWxsfTtcbmsuQj1mdW5jdGlvbigpe3ZhciBhPXRoaXMucDtyZXR1cm4gbnVsbCE9YT9hOnRoaXMucD1hPXdjKHRoaXMpfTtrLkE9ZnVuY3Rpb24oYSxiKXtpZihiIGluc3RhbmNlb2YgVylpZih0aGlzLmc9PT1RKGIpKWZvcih2YXIgYz1jYyh0aGlzKSxkPWNjKGIpOzspaWYodChjLmdhKCkpKXt2YXIgZT1jLm5leHQoKSxmPWQubmV4dCgpO2lmKCFzYy5hKGUsZikpcmV0dXJuITF9ZWxzZSByZXR1cm4hMDtlbHNlIHJldHVybiExO2Vsc2UgcmV0dXJuIEljKHRoaXMsYil9O2suJGE9ZnVuY3Rpb24oKXt2YXIgYT10aGlzO3JldHVybiBuZXcgdmYoYS5nLGEuc2hpZnQsZnVuY3Rpb24oKXt2YXIgYj1hLnJvb3Q7cmV0dXJuIHdmLmI/d2YuYihiKTp3Zi5jYWxsKG51bGwsYil9KCksZnVuY3Rpb24oKXt2YXIgYj1hLlc7cmV0dXJuIHhmLmI/eGYuYihiKTp4Zi5jYWxsKG51bGwsYil9KCkpfTtrLko9ZnVuY3Rpb24oKXtyZXR1cm4gTyhNYyx0aGlzLmspfTtcbmsuUj1mdW5jdGlvbihhLGIpe3JldHVybiBDYy5hKHRoaXMsYil9O2suTz1mdW5jdGlvbihhLGIsYyl7YT0wO2Zvcih2YXIgZD1jOzspaWYoYTx0aGlzLmcpe3ZhciBlPW5mKHRoaXMsYSk7Yz1lLmxlbmd0aDthOntmb3IodmFyIGY9MDs7KWlmKGY8Yyl7dmFyIGc9ZVtmXSxkPWIuYT9iLmEoZCxnKTpiLmNhbGwobnVsbCxkLGcpO2lmKEFjKGQpKXtlPWQ7YnJlYWsgYX1mKz0xfWVsc2V7ZT1kO2JyZWFrIGF9ZT12b2lkIDB9aWYoQWMoZSkpcmV0dXJuIGI9ZSxMLmI/TC5iKGIpOkwuY2FsbChudWxsLGIpO2ErPWM7ZD1lfWVsc2UgcmV0dXJuIGR9O2suS2E9ZnVuY3Rpb24oYSxiLGMpe2lmKFwibnVtYmVyXCI9PT10eXBlb2YgYilyZXR1cm4gcGIodGhpcyxiLGMpO3Rocm93IEVycm9yKFwiVmVjdG9yJ3Mga2V5IGZvciBhc3NvYyBtdXN0IGJlIGEgbnVtYmVyLlwiKTt9O1xuay5EPWZ1bmN0aW9uKCl7aWYoMD09PXRoaXMuZylyZXR1cm4gbnVsbDtpZigzMj49dGhpcy5nKXJldHVybiBuZXcgRih0aGlzLlcsMCk7dmFyIGE7YTp7YT10aGlzLnJvb3Q7Zm9yKHZhciBiPXRoaXMuc2hpZnQ7OylpZigwPGIpYi09NSxhPWEuZVswXTtlbHNle2E9YS5lO2JyZWFrIGF9YT12b2lkIDB9cmV0dXJuIHlmLm4/eWYubih0aGlzLGEsMCwwKTp5Zi5jYWxsKG51bGwsdGhpcyxhLDAsMCl9O2suRj1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgVyhiLHRoaXMuZyx0aGlzLnNoaWZ0LHRoaXMucm9vdCx0aGlzLlcsdGhpcy5wKX07XG5rLkc9ZnVuY3Rpb24oYSxiKXtpZigzMj50aGlzLmctaGYodGhpcykpe2Zvcih2YXIgYz10aGlzLlcubGVuZ3RoLGQ9QXJyYXkoYysxKSxlPTA7OylpZihlPGMpZFtlXT10aGlzLldbZV0sZSs9MTtlbHNlIGJyZWFrO2RbY109YjtyZXR1cm4gbmV3IFcodGhpcy5rLHRoaXMuZysxLHRoaXMuc2hpZnQsdGhpcy5yb290LGQsbnVsbCl9Yz0oZD10aGlzLmc+Pj41PjE8PHRoaXMuc2hpZnQpP3RoaXMuc2hpZnQrNTp0aGlzLnNoaWZ0O2Q/KGQ9ZmYobnVsbCksZC5lWzBdPXRoaXMucm9vdCxlPWpmKG51bGwsdGhpcy5zaGlmdCxuZXcgZWYobnVsbCx0aGlzLlcpKSxkLmVbMV09ZSk6ZD1sZih0aGlzLHRoaXMuc2hpZnQsdGhpcy5yb290LG5ldyBlZihudWxsLHRoaXMuVykpO3JldHVybiBuZXcgVyh0aGlzLmssdGhpcy5nKzEsYyxkLFtiXSxudWxsKX07XG5rLmNhbGw9ZnVuY3Rpb24oKXt2YXIgYT1udWxsLGE9ZnVuY3Rpb24oYSxjLGQpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIHRoaXMuUShudWxsLGMpO2Nhc2UgMzpyZXR1cm4gdGhpcy4kKG51bGwsYyxkKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307YS5hPWZ1bmN0aW9uKGEsYyl7cmV0dXJuIHRoaXMuUShudWxsLGMpfTthLmM9ZnVuY3Rpb24oYSxjLGQpe3JldHVybiB0aGlzLiQobnVsbCxjLGQpfTtyZXR1cm4gYX0oKTtrLmFwcGx5PWZ1bmN0aW9uKGEsYil7cmV0dXJuIHRoaXMuY2FsbC5hcHBseSh0aGlzLFt0aGlzXS5jb25jYXQoRmEoYikpKX07ay5iPWZ1bmN0aW9uKGEpe3JldHVybiB0aGlzLlEobnVsbCxhKX07ay5hPWZ1bmN0aW9uKGEsYil7cmV0dXJuIHRoaXMuJChudWxsLGEsYil9O1xudmFyIHVmPW5ldyBlZihudWxsLFtudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGxdKSxNYz1uZXcgVyhudWxsLDAsNSx1ZixbXSwwKTtXLnByb3RvdHlwZVtFYV09ZnVuY3Rpb24oKXtyZXR1cm4gdWModGhpcyl9O2Z1bmN0aW9uIHpmKGEpe3JldHVybiBRYihBLmMoUGIsT2IoTWMpLGEpKX1cbnZhciBBZj1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSl7dmFyIGQ9bnVsbDtpZigwPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZD0wLGU9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0wKTtkPGUubGVuZ3RoOyllW2RdPWFyZ3VtZW50c1tkKzBdLCsrZDtkPW5ldyBGKGUsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGQpfWZ1bmN0aW9uIGIoYSl7aWYoYSBpbnN0YW5jZW9mIEYmJjA9PT1hLm0pYTp7YT1hLmU7dmFyIGI9YS5sZW5ndGg7aWYoMzI+YilhPW5ldyBXKG51bGwsYiw1LHVmLGEsbnVsbCk7ZWxzZXtmb3IodmFyIGU9MzIsZj0obmV3IFcobnVsbCwzMiw1LHVmLGEuc2xpY2UoMCwzMiksbnVsbCkpLiRhKG51bGwpOzspaWYoZTxiKXZhciBnPWUrMSxmPWRlLmEoZixhW2VdKSxlPWc7ZWxzZXthPVFiKGYpO2JyZWFrIGF9YT12b2lkIDB9fWVsc2UgYT16ZihhKTtyZXR1cm4gYX1hLmk9MDthLmY9ZnVuY3Rpb24oYSl7YT1EKGEpO3JldHVybiBiKGEpfTthLmQ9YjtyZXR1cm4gYX0oKTtcbmZ1bmN0aW9uIEJmKGEsYixjLGQsZSxmKXt0aGlzLmhhPWE7dGhpcy5KYT1iO3RoaXMubT1jO3RoaXMuVj1kO3RoaXMuaz1lO3RoaXMucD1mO3RoaXMuaj0zMjM3NTAyMDt0aGlzLnE9MTUzNn1rPUJmLnByb3RvdHlwZTtrLnRvU3RyaW5nPWZ1bmN0aW9uKCl7cmV0dXJuIGVjKHRoaXMpfTtrLkg9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5rfTtrLlQ9ZnVuY3Rpb24oKXtpZih0aGlzLlYrMTx0aGlzLkphLmxlbmd0aCl7dmFyIGE7YT10aGlzLmhhO3ZhciBiPXRoaXMuSmEsYz10aGlzLm0sZD10aGlzLlYrMTthPXlmLm4/eWYubihhLGIsYyxkKTp5Zi5jYWxsKG51bGwsYSxiLGMsZCk7cmV0dXJuIG51bGw9PWE/bnVsbDphfXJldHVybiAkYih0aGlzKX07ay5CPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5wO3JldHVybiBudWxsIT1hP2E6dGhpcy5wPWE9d2ModGhpcyl9O2suQT1mdW5jdGlvbihhLGIpe3JldHVybiBJYyh0aGlzLGIpfTtrLko9ZnVuY3Rpb24oKXtyZXR1cm4gTyhNYyx0aGlzLmspfTtcbmsuUj1mdW5jdGlvbihhLGIpe3ZhciBjPXRoaXM7cmV0dXJuIENjLmEoZnVuY3Rpb24oKXt2YXIgYT1jLmhhLGI9Yy5tK2MuVixmPVEoYy5oYSk7cmV0dXJuIENmLmM/Q2YuYyhhLGIsZik6Q2YuY2FsbChudWxsLGEsYixmKX0oKSxiKX07ay5PPWZ1bmN0aW9uKGEsYixjKXt2YXIgZD10aGlzO3JldHVybiBDYy5jKGZ1bmN0aW9uKCl7dmFyIGE9ZC5oYSxiPWQubStkLlYsYz1RKGQuaGEpO3JldHVybiBDZi5jP0NmLmMoYSxiLGMpOkNmLmNhbGwobnVsbCxhLGIsYyl9KCksYixjKX07ay5OPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuSmFbdGhpcy5WXX07ay5TPWZ1bmN0aW9uKCl7aWYodGhpcy5WKzE8dGhpcy5KYS5sZW5ndGgpe3ZhciBhO2E9dGhpcy5oYTt2YXIgYj10aGlzLkphLGM9dGhpcy5tLGQ9dGhpcy5WKzE7YT15Zi5uP3lmLm4oYSxiLGMsZCk6eWYuY2FsbChudWxsLGEsYixjLGQpO3JldHVybiBudWxsPT1hP0o6YX1yZXR1cm4gWmIodGhpcyl9O2suRD1mdW5jdGlvbigpe3JldHVybiB0aGlzfTtcbmsuQ2I9ZnVuY3Rpb24oKXtyZXR1cm4gVWQuYSh0aGlzLkphLHRoaXMuVil9O2suRGI9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLm0rdGhpcy5KYS5sZW5ndGg7aWYoYTxNYSh0aGlzLmhhKSl7dmFyIGI9dGhpcy5oYSxjPW5mKHRoaXMuaGEsYSk7cmV0dXJuIHlmLm4/eWYubihiLGMsYSwwKTp5Zi5jYWxsKG51bGwsYixjLGEsMCl9cmV0dXJuIEp9O2suRj1mdW5jdGlvbihhLGIpe3ZhciBjPXRoaXMuaGEsZD10aGlzLkphLGU9dGhpcy5tLGY9dGhpcy5WO3JldHVybiB5Zi5yP3lmLnIoYyxkLGUsZixiKTp5Zi5jYWxsKG51bGwsYyxkLGUsZixiKX07ay5HPWZ1bmN0aW9uKGEsYil7cmV0dXJuIE0oYix0aGlzKX07ay5CYj1mdW5jdGlvbigpe3ZhciBhPXRoaXMubSt0aGlzLkphLmxlbmd0aDtpZihhPE1hKHRoaXMuaGEpKXt2YXIgYj10aGlzLmhhLGM9bmYodGhpcy5oYSxhKTtyZXR1cm4geWYubj95Zi5uKGIsYyxhLDApOnlmLmNhbGwobnVsbCxiLGMsYSwwKX1yZXR1cm4gbnVsbH07XG5CZi5wcm90b3R5cGVbRWFdPWZ1bmN0aW9uKCl7cmV0dXJuIHVjKHRoaXMpfTt2YXIgeWY9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjLGQsbCl7cmV0dXJuIG5ldyBCZihhLGIsYyxkLGwsbnVsbCl9ZnVuY3Rpb24gYihhLGIsYyxkKXtyZXR1cm4gbmV3IEJmKGEsYixjLGQsbnVsbCxudWxsKX1mdW5jdGlvbiBjKGEsYixjKXtyZXR1cm4gbmV3IEJmKGEsb2YoYSxiKSxiLGMsbnVsbCxudWxsKX12YXIgZD1udWxsLGQ9ZnVuY3Rpb24oZCxmLGcsaCxsKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAzOnJldHVybiBjLmNhbGwodGhpcyxkLGYsZyk7Y2FzZSA0OnJldHVybiBiLmNhbGwodGhpcyxkLGYsZyxoKTtjYXNlIDU6cmV0dXJuIGEuY2FsbCh0aGlzLGQsZixnLGgsbCl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2QuYz1jO2Qubj1iO2Qucj1hO3JldHVybiBkfSgpO1xuZnVuY3Rpb24gRGYoYSxiLGMsZCxlKXt0aGlzLms9YTt0aGlzLm9hPWI7dGhpcy5zdGFydD1jO3RoaXMuZW5kPWQ7dGhpcy5wPWU7dGhpcy5qPTE2NjYxNzg4Nzt0aGlzLnE9ODE5Mn1rPURmLnByb3RvdHlwZTtrLnRvU3RyaW5nPWZ1bmN0aW9uKCl7cmV0dXJuIGVjKHRoaXMpfTtrLnQ9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gJGEuYyh0aGlzLGIsbnVsbCl9O2sucz1mdW5jdGlvbihhLGIsYyl7cmV0dXJuXCJudW1iZXJcIj09PXR5cGVvZiBiP0MuYyh0aGlzLGIsYyk6Y307ay5RPWZ1bmN0aW9uKGEsYil7cmV0dXJuIDA+Ynx8dGhpcy5lbmQ8PXRoaXMuc3RhcnQrYj9tZihiLHRoaXMuZW5kLXRoaXMuc3RhcnQpOkMuYSh0aGlzLm9hLHRoaXMuc3RhcnQrYil9O2suJD1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIDA+Ynx8dGhpcy5lbmQ8PXRoaXMuc3RhcnQrYj9jOkMuYyh0aGlzLm9hLHRoaXMuc3RhcnQrYixjKX07XG5rLlVhPWZ1bmN0aW9uKGEsYixjKXt2YXIgZD10aGlzLnN0YXJ0K2I7YT10aGlzLms7Yz1SYy5jKHRoaXMub2EsZCxjKTtiPXRoaXMuc3RhcnQ7dmFyIGU9dGhpcy5lbmQsZD1kKzEsZD1lPmQ/ZTpkO3JldHVybiBFZi5yP0VmLnIoYSxjLGIsZCxudWxsKTpFZi5jYWxsKG51bGwsYSxjLGIsZCxudWxsKX07ay5IPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMua307ay5MPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuZW5kLXRoaXMuc3RhcnR9O2suTGE9ZnVuY3Rpb24oKXtyZXR1cm4gQy5hKHRoaXMub2EsdGhpcy5lbmQtMSl9O2suTWE9ZnVuY3Rpb24oKXtpZih0aGlzLnN0YXJ0PT09dGhpcy5lbmQpdGhyb3cgRXJyb3IoXCJDYW4ndCBwb3AgZW1wdHkgdmVjdG9yXCIpO3ZhciBhPXRoaXMuayxiPXRoaXMub2EsYz10aGlzLnN0YXJ0LGQ9dGhpcy5lbmQtMTtyZXR1cm4gRWYucj9FZi5yKGEsYixjLGQsbnVsbCk6RWYuY2FsbChudWxsLGEsYixjLGQsbnVsbCl9O1xuay5hYj1mdW5jdGlvbigpe3JldHVybiB0aGlzLnN0YXJ0IT09dGhpcy5lbmQ/bmV3IEhjKHRoaXMsdGhpcy5lbmQtdGhpcy5zdGFydC0xLG51bGwpOm51bGx9O2suQj1mdW5jdGlvbigpe3ZhciBhPXRoaXMucDtyZXR1cm4gbnVsbCE9YT9hOnRoaXMucD1hPXdjKHRoaXMpfTtrLkE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gSWModGhpcyxiKX07ay5KPWZ1bmN0aW9uKCl7cmV0dXJuIE8oTWMsdGhpcy5rKX07ay5SPWZ1bmN0aW9uKGEsYil7cmV0dXJuIENjLmEodGhpcyxiKX07ay5PPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gQ2MuYyh0aGlzLGIsYyl9O2suS2E9ZnVuY3Rpb24oYSxiLGMpe2lmKFwibnVtYmVyXCI9PT10eXBlb2YgYilyZXR1cm4gcGIodGhpcyxiLGMpO3Rocm93IEVycm9yKFwiU3VidmVjJ3Mga2V5IGZvciBhc3NvYyBtdXN0IGJlIGEgbnVtYmVyLlwiKTt9O1xuay5EPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcztyZXR1cm4gZnVuY3Rpb24oYil7cmV0dXJuIGZ1bmN0aW9uIGQoZSl7cmV0dXJuIGU9PT1hLmVuZD9udWxsOk0oQy5hKGEub2EsZSksbmV3IFYobnVsbCxmdW5jdGlvbigpe3JldHVybiBmdW5jdGlvbigpe3JldHVybiBkKGUrMSl9fShiKSxudWxsLG51bGwpKX19KHRoaXMpKGEuc3RhcnQpfTtrLkY9ZnVuY3Rpb24oYSxiKXt2YXIgYz10aGlzLm9hLGQ9dGhpcy5zdGFydCxlPXRoaXMuZW5kLGY9dGhpcy5wO3JldHVybiBFZi5yP0VmLnIoYixjLGQsZSxmKTpFZi5jYWxsKG51bGwsYixjLGQsZSxmKX07ay5HPWZ1bmN0aW9uKGEsYil7dmFyIGM9dGhpcy5rLGQ9cGIodGhpcy5vYSx0aGlzLmVuZCxiKSxlPXRoaXMuc3RhcnQsZj10aGlzLmVuZCsxO3JldHVybiBFZi5yP0VmLnIoYyxkLGUsZixudWxsKTpFZi5jYWxsKG51bGwsYyxkLGUsZixudWxsKX07XG5rLmNhbGw9ZnVuY3Rpb24oKXt2YXIgYT1udWxsLGE9ZnVuY3Rpb24oYSxjLGQpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIHRoaXMuUShudWxsLGMpO2Nhc2UgMzpyZXR1cm4gdGhpcy4kKG51bGwsYyxkKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307YS5hPWZ1bmN0aW9uKGEsYyl7cmV0dXJuIHRoaXMuUShudWxsLGMpfTthLmM9ZnVuY3Rpb24oYSxjLGQpe3JldHVybiB0aGlzLiQobnVsbCxjLGQpfTtyZXR1cm4gYX0oKTtrLmFwcGx5PWZ1bmN0aW9uKGEsYil7cmV0dXJuIHRoaXMuY2FsbC5hcHBseSh0aGlzLFt0aGlzXS5jb25jYXQoRmEoYikpKX07ay5iPWZ1bmN0aW9uKGEpe3JldHVybiB0aGlzLlEobnVsbCxhKX07ay5hPWZ1bmN0aW9uKGEsYil7cmV0dXJuIHRoaXMuJChudWxsLGEsYil9O0RmLnByb3RvdHlwZVtFYV09ZnVuY3Rpb24oKXtyZXR1cm4gdWModGhpcyl9O1xuZnVuY3Rpb24gRWYoYSxiLGMsZCxlKXtmb3IoOzspaWYoYiBpbnN0YW5jZW9mIERmKWM9Yi5zdGFydCtjLGQ9Yi5zdGFydCtkLGI9Yi5vYTtlbHNle3ZhciBmPVEoYik7aWYoMD5jfHwwPmR8fGM+Znx8ZD5mKXRocm93IEVycm9yKFwiSW5kZXggb3V0IG9mIGJvdW5kc1wiKTtyZXR1cm4gbmV3IERmKGEsYixjLGQsZSl9fXZhciBDZj1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMpe3JldHVybiBFZihudWxsLGEsYixjLG51bGwpfWZ1bmN0aW9uIGIoYSxiKXtyZXR1cm4gYy5jKGEsYixRKGEpKX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIGIuY2FsbCh0aGlzLGMsZSk7Y2FzZSAzOnJldHVybiBhLmNhbGwodGhpcyxjLGUsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYT1iO2MuYz1hO3JldHVybiBjfSgpO1xuZnVuY3Rpb24gRmYoYSxiKXtyZXR1cm4gYT09PWIudT9iOm5ldyBlZihhLEZhKGIuZSkpfWZ1bmN0aW9uIHdmKGEpe3JldHVybiBuZXcgZWYoe30sRmEoYS5lKSl9ZnVuY3Rpb24geGYoYSl7dmFyIGI9W251bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbF07aGQoYSwwLGIsMCxhLmxlbmd0aCk7cmV0dXJuIGJ9XG52YXIgSGY9ZnVuY3Rpb24gR2YoYixjLGQsZSl7ZD1GZihiLnJvb3QudSxkKTt2YXIgZj1iLmctMT4+PmMmMzE7aWYoNT09PWMpYj1lO2Vsc2V7dmFyIGc9ZC5lW2ZdO2I9bnVsbCE9Zz9HZihiLGMtNSxnLGUpOmpmKGIucm9vdC51LGMtNSxlKX1kLmVbZl09YjtyZXR1cm4gZH0sSmY9ZnVuY3Rpb24gSWYoYixjLGQpe2Q9RmYoYi5yb290LnUsZCk7dmFyIGU9Yi5nLTI+Pj5jJjMxO2lmKDU8Yyl7Yj1JZihiLGMtNSxkLmVbZV0pO2lmKG51bGw9PWImJjA9PT1lKXJldHVybiBudWxsO2QuZVtlXT1iO3JldHVybiBkfWlmKDA9PT1lKXJldHVybiBudWxsO2QuZVtlXT1udWxsO3JldHVybiBkfTtmdW5jdGlvbiB2ZihhLGIsYyxkKXt0aGlzLmc9YTt0aGlzLnNoaWZ0PWI7dGhpcy5yb290PWM7dGhpcy5XPWQ7dGhpcy5qPTI3NTt0aGlzLnE9ODh9az12Zi5wcm90b3R5cGU7XG5rLmNhbGw9ZnVuY3Rpb24oKXt2YXIgYT1udWxsLGE9ZnVuY3Rpb24oYSxjLGQpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIHRoaXMudChudWxsLGMpO2Nhc2UgMzpyZXR1cm4gdGhpcy5zKG51bGwsYyxkKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307YS5hPWZ1bmN0aW9uKGEsYyl7cmV0dXJuIHRoaXMudChudWxsLGMpfTthLmM9ZnVuY3Rpb24oYSxjLGQpe3JldHVybiB0aGlzLnMobnVsbCxjLGQpfTtyZXR1cm4gYX0oKTtrLmFwcGx5PWZ1bmN0aW9uKGEsYil7cmV0dXJuIHRoaXMuY2FsbC5hcHBseSh0aGlzLFt0aGlzXS5jb25jYXQoRmEoYikpKX07ay5iPWZ1bmN0aW9uKGEpe3JldHVybiB0aGlzLnQobnVsbCxhKX07ay5hPWZ1bmN0aW9uKGEsYil7cmV0dXJuIHRoaXMucyhudWxsLGEsYil9O2sudD1mdW5jdGlvbihhLGIpe3JldHVybiAkYS5jKHRoaXMsYixudWxsKX07XG5rLnM9ZnVuY3Rpb24oYSxiLGMpe3JldHVyblwibnVtYmVyXCI9PT10eXBlb2YgYj9DLmModGhpcyxiLGMpOmN9O2suUT1mdW5jdGlvbihhLGIpe2lmKHRoaXMucm9vdC51KXJldHVybiBvZih0aGlzLGIpW2ImMzFdO3Rocm93IEVycm9yKFwibnRoIGFmdGVyIHBlcnNpc3RlbnQhXCIpO307ay4kPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gMDw9YiYmYjx0aGlzLmc/Qy5hKHRoaXMsYik6Y307ay5MPWZ1bmN0aW9uKCl7aWYodGhpcy5yb290LnUpcmV0dXJuIHRoaXMuZzt0aHJvdyBFcnJvcihcImNvdW50IGFmdGVyIHBlcnNpc3RlbnQhXCIpO307XG5rLlViPWZ1bmN0aW9uKGEsYixjKXt2YXIgZD10aGlzO2lmKGQucm9vdC51KXtpZigwPD1iJiZiPGQuZylyZXR1cm4gaGYodGhpcyk8PWI/ZC5XW2ImMzFdPWM6KGE9ZnVuY3Rpb24oKXtyZXR1cm4gZnVuY3Rpb24gZihhLGgpe3ZhciBsPUZmKGQucm9vdC51LGgpO2lmKDA9PT1hKWwuZVtiJjMxXT1jO2Vsc2V7dmFyIG09Yj4+PmEmMzEscD1mKGEtNSxsLmVbbV0pO2wuZVttXT1wfXJldHVybiBsfX0odGhpcykuY2FsbChudWxsLGQuc2hpZnQsZC5yb290KSxkLnJvb3Q9YSksdGhpcztpZihiPT09ZC5nKXJldHVybiBQYih0aGlzLGMpO3Rocm93IEVycm9yKFt6KFwiSW5kZXggXCIpLHooYikseihcIiBvdXQgb2YgYm91bmRzIGZvciBUcmFuc2llbnRWZWN0b3Igb2YgbGVuZ3RoXCIpLHooZC5nKV0uam9pbihcIlwiKSk7fXRocm93IEVycm9yKFwiYXNzb2MhIGFmdGVyIHBlcnNpc3RlbnQhXCIpO307XG5rLlZiPWZ1bmN0aW9uKCl7aWYodGhpcy5yb290LnUpe2lmKDA9PT10aGlzLmcpdGhyb3cgRXJyb3IoXCJDYW4ndCBwb3AgZW1wdHkgdmVjdG9yXCIpO2lmKDE9PT10aGlzLmcpdGhpcy5nPTA7ZWxzZSBpZigwPCh0aGlzLmctMSYzMSkpdGhpcy5nLT0xO2Vsc2V7dmFyIGE7YTppZihhPXRoaXMuZy0yLGE+PWhmKHRoaXMpKWE9dGhpcy5XO2Vsc2V7Zm9yKHZhciBiPXRoaXMucm9vdCxjPWIsZD10aGlzLnNoaWZ0OzspaWYoMDxkKWM9RmYoYi51LGMuZVthPj4+ZCYzMV0pLGQtPTU7ZWxzZXthPWMuZTticmVhayBhfWE9dm9pZCAwfWI9SmYodGhpcyx0aGlzLnNoaWZ0LHRoaXMucm9vdCk7Yj1udWxsIT1iP2I6bmV3IGVmKHRoaXMucm9vdC51LFtudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLFxubnVsbCxudWxsLG51bGwsbnVsbF0pOzU8dGhpcy5zaGlmdCYmbnVsbD09Yi5lWzFdPyh0aGlzLnJvb3Q9RmYodGhpcy5yb290LnUsYi5lWzBdKSx0aGlzLnNoaWZ0LT01KTp0aGlzLnJvb3Q9Yjt0aGlzLmctPTE7dGhpcy5XPWF9cmV0dXJuIHRoaXN9dGhyb3cgRXJyb3IoXCJwb3AhIGFmdGVyIHBlcnNpc3RlbnQhXCIpO307ay5rYj1mdW5jdGlvbihhLGIsYyl7aWYoXCJudW1iZXJcIj09PXR5cGVvZiBiKXJldHVybiBUYih0aGlzLGIsYyk7dGhyb3cgRXJyb3IoXCJUcmFuc2llbnRWZWN0b3IncyBrZXkgZm9yIGFzc29jISBtdXN0IGJlIGEgbnVtYmVyLlwiKTt9O1xuay5TYT1mdW5jdGlvbihhLGIpe2lmKHRoaXMucm9vdC51KXtpZigzMj50aGlzLmctaGYodGhpcykpdGhpcy5XW3RoaXMuZyYzMV09YjtlbHNle3ZhciBjPW5ldyBlZih0aGlzLnJvb3QudSx0aGlzLlcpLGQ9W251bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbF07ZFswXT1iO3RoaXMuVz1kO2lmKHRoaXMuZz4+PjU+MTw8dGhpcy5zaGlmdCl7dmFyIGQ9W251bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbF0sZT10aGlzLnNoaWZ0K1xuNTtkWzBdPXRoaXMucm9vdDtkWzFdPWpmKHRoaXMucm9vdC51LHRoaXMuc2hpZnQsYyk7dGhpcy5yb290PW5ldyBlZih0aGlzLnJvb3QudSxkKTt0aGlzLnNoaWZ0PWV9ZWxzZSB0aGlzLnJvb3Q9SGYodGhpcyx0aGlzLnNoaWZ0LHRoaXMucm9vdCxjKX10aGlzLmcrPTE7cmV0dXJuIHRoaXN9dGhyb3cgRXJyb3IoXCJjb25qISBhZnRlciBwZXJzaXN0ZW50IVwiKTt9O2suVGE9ZnVuY3Rpb24oKXtpZih0aGlzLnJvb3QudSl7dGhpcy5yb290LnU9bnVsbDt2YXIgYT10aGlzLmctaGYodGhpcyksYj1BcnJheShhKTtoZCh0aGlzLlcsMCxiLDAsYSk7cmV0dXJuIG5ldyBXKG51bGwsdGhpcy5nLHRoaXMuc2hpZnQsdGhpcy5yb290LGIsbnVsbCl9dGhyb3cgRXJyb3IoXCJwZXJzaXN0ZW50ISBjYWxsZWQgdHdpY2VcIik7fTtmdW5jdGlvbiBLZihhLGIsYyxkKXt0aGlzLms9YTt0aGlzLmVhPWI7dGhpcy5zYT1jO3RoaXMucD1kO3RoaXMucT0wO3RoaXMuaj0zMTg1MDU3Mn1rPUtmLnByb3RvdHlwZTtcbmsudG9TdHJpbmc9ZnVuY3Rpb24oKXtyZXR1cm4gZWModGhpcyl9O2suSD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmt9O2suQj1mdW5jdGlvbigpe3ZhciBhPXRoaXMucDtyZXR1cm4gbnVsbCE9YT9hOnRoaXMucD1hPXdjKHRoaXMpfTtrLkE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gSWModGhpcyxiKX07ay5KPWZ1bmN0aW9uKCl7cmV0dXJuIE8oSix0aGlzLmspfTtrLk49ZnVuY3Rpb24oKXtyZXR1cm4gRyh0aGlzLmVhKX07ay5TPWZ1bmN0aW9uKCl7dmFyIGE9Syh0aGlzLmVhKTtyZXR1cm4gYT9uZXcgS2YodGhpcy5rLGEsdGhpcy5zYSxudWxsKTpudWxsPT10aGlzLnNhP05hKHRoaXMpOm5ldyBLZih0aGlzLmssdGhpcy5zYSxudWxsLG51bGwpfTtrLkQ9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpc307ay5GPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyBLZihiLHRoaXMuZWEsdGhpcy5zYSx0aGlzLnApfTtrLkc9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gTShiLHRoaXMpfTtcbktmLnByb3RvdHlwZVtFYV09ZnVuY3Rpb24oKXtyZXR1cm4gdWModGhpcyl9O2Z1bmN0aW9uIExmKGEsYixjLGQsZSl7dGhpcy5rPWE7dGhpcy5jb3VudD1iO3RoaXMuZWE9Yzt0aGlzLnNhPWQ7dGhpcy5wPWU7dGhpcy5qPTMxODU4NzY2O3RoaXMucT04MTkyfWs9TGYucHJvdG90eXBlO2sudG9TdHJpbmc9ZnVuY3Rpb24oKXtyZXR1cm4gZWModGhpcyl9O2suSD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmt9O2suTD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmNvdW50fTtrLkxhPWZ1bmN0aW9uKCl7cmV0dXJuIEcodGhpcy5lYSl9O2suTWE9ZnVuY3Rpb24oKXtpZih0KHRoaXMuZWEpKXt2YXIgYT1LKHRoaXMuZWEpO3JldHVybiBhP25ldyBMZih0aGlzLmssdGhpcy5jb3VudC0xLGEsdGhpcy5zYSxudWxsKTpuZXcgTGYodGhpcy5rLHRoaXMuY291bnQtMSxEKHRoaXMuc2EpLE1jLG51bGwpfXJldHVybiB0aGlzfTtcbmsuQj1mdW5jdGlvbigpe3ZhciBhPXRoaXMucDtyZXR1cm4gbnVsbCE9YT9hOnRoaXMucD1hPXdjKHRoaXMpfTtrLkE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gSWModGhpcyxiKX07ay5KPWZ1bmN0aW9uKCl7cmV0dXJuIE8oTWYsdGhpcy5rKX07ay5OPWZ1bmN0aW9uKCl7cmV0dXJuIEcodGhpcy5lYSl9O2suUz1mdW5jdGlvbigpe3JldHVybiBIKEQodGhpcykpfTtrLkQ9ZnVuY3Rpb24oKXt2YXIgYT1EKHRoaXMuc2EpLGI9dGhpcy5lYTtyZXR1cm4gdCh0KGIpP2I6YSk/bmV3IEtmKG51bGwsdGhpcy5lYSxEKGEpLG51bGwpOm51bGx9O2suRj1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgTGYoYix0aGlzLmNvdW50LHRoaXMuZWEsdGhpcy5zYSx0aGlzLnApfTtcbmsuRz1mdW5jdGlvbihhLGIpe3ZhciBjO3QodGhpcy5lYSk/KGM9dGhpcy5zYSxjPW5ldyBMZih0aGlzLmssdGhpcy5jb3VudCsxLHRoaXMuZWEsTmMuYSh0KGMpP2M6TWMsYiksbnVsbCkpOmM9bmV3IExmKHRoaXMuayx0aGlzLmNvdW50KzEsTmMuYSh0aGlzLmVhLGIpLE1jLG51bGwpO3JldHVybiBjfTt2YXIgTWY9bmV3IExmKG51bGwsMCxudWxsLE1jLDApO0xmLnByb3RvdHlwZVtFYV09ZnVuY3Rpb24oKXtyZXR1cm4gdWModGhpcyl9O2Z1bmN0aW9uIE5mKCl7dGhpcy5xPTA7dGhpcy5qPTIwOTcxNTJ9TmYucHJvdG90eXBlLkE9ZnVuY3Rpb24oKXtyZXR1cm4hMX07dmFyIE9mPW5ldyBOZjtmdW5jdGlvbiBQZihhLGIpe3JldHVybiBtZChkZChiKT9RKGEpPT09UShiKT9FZSh1ZCxPZS5hKGZ1bmN0aW9uKGEpe3JldHVybiBzYy5hKFMuYyhiLEcoYSksT2YpLExjKGEpKX0sYSkpOm51bGw6bnVsbCl9XG5mdW5jdGlvbiBRZihhLGIpe3ZhciBjPWEuZTtpZihiIGluc3RhbmNlb2YgVSlhOntmb3IodmFyIGQ9Yy5sZW5ndGgsZT1iLnBhLGY9MDs7KXtpZihkPD1mKXtjPS0xO2JyZWFrIGF9dmFyIGc9Y1tmXTtpZihnIGluc3RhbmNlb2YgVSYmZT09PWcucGEpe2M9ZjticmVhayBhfWYrPTJ9Yz12b2lkIDB9ZWxzZSBpZihkPVwic3RyaW5nXCI9PXR5cGVvZiBiLHQodChkKT9kOlwibnVtYmVyXCI9PT10eXBlb2YgYikpYTp7ZD1jLmxlbmd0aDtmb3IoZT0wOzspe2lmKGQ8PWUpe2M9LTE7YnJlYWsgYX1pZihiPT09Y1tlXSl7Yz1lO2JyZWFrIGF9ZSs9Mn1jPXZvaWQgMH1lbHNlIGlmKGIgaW5zdGFuY2VvZiBxYylhOntkPWMubGVuZ3RoO2U9Yi50YTtmb3IoZj0wOzspe2lmKGQ8PWYpe2M9LTE7YnJlYWsgYX1nPWNbZl07aWYoZyBpbnN0YW5jZW9mIHFjJiZlPT09Zy50YSl7Yz1mO2JyZWFrIGF9Zis9Mn1jPXZvaWQgMH1lbHNlIGlmKG51bGw9PWIpYTp7ZD1jLmxlbmd0aDtmb3IoZT0wOzspe2lmKGQ8PVxuZSl7Yz0tMTticmVhayBhfWlmKG51bGw9PWNbZV0pe2M9ZTticmVhayBhfWUrPTJ9Yz12b2lkIDB9ZWxzZSBhOntkPWMubGVuZ3RoO2ZvcihlPTA7Oyl7aWYoZDw9ZSl7Yz0tMTticmVhayBhfWlmKHNjLmEoYixjW2VdKSl7Yz1lO2JyZWFrIGF9ZSs9Mn1jPXZvaWQgMH1yZXR1cm4gY31mdW5jdGlvbiBSZihhLGIsYyl7dGhpcy5lPWE7dGhpcy5tPWI7dGhpcy5aPWM7dGhpcy5xPTA7dGhpcy5qPTMyMzc0OTkwfWs9UmYucHJvdG90eXBlO2sudG9TdHJpbmc9ZnVuY3Rpb24oKXtyZXR1cm4gZWModGhpcyl9O2suSD1mdW5jdGlvbigpe3JldHVybiB0aGlzLlp9O2suVD1mdW5jdGlvbigpe3JldHVybiB0aGlzLm08dGhpcy5lLmxlbmd0aC0yP25ldyBSZih0aGlzLmUsdGhpcy5tKzIsdGhpcy5aKTpudWxsfTtrLkw9ZnVuY3Rpb24oKXtyZXR1cm4odGhpcy5lLmxlbmd0aC10aGlzLm0pLzJ9O2suQj1mdW5jdGlvbigpe3JldHVybiB3Yyh0aGlzKX07XG5rLkE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gSWModGhpcyxiKX07ay5KPWZ1bmN0aW9uKCl7cmV0dXJuIE8oSix0aGlzLlopfTtrLlI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gUC5hKGIsdGhpcyl9O2suTz1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIFAuYyhiLGMsdGhpcyl9O2suTj1mdW5jdGlvbigpe3JldHVybiBuZXcgVyhudWxsLDIsNSx1ZixbdGhpcy5lW3RoaXMubV0sdGhpcy5lW3RoaXMubSsxXV0sbnVsbCl9O2suUz1mdW5jdGlvbigpe3JldHVybiB0aGlzLm08dGhpcy5lLmxlbmd0aC0yP25ldyBSZih0aGlzLmUsdGhpcy5tKzIsdGhpcy5aKTpKfTtrLkQ9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpc307ay5GPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyBSZih0aGlzLmUsdGhpcy5tLGIpfTtrLkc9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gTShiLHRoaXMpfTtSZi5wcm90b3R5cGVbRWFdPWZ1bmN0aW9uKCl7cmV0dXJuIHVjKHRoaXMpfTtcbmZ1bmN0aW9uIFNmKGEsYixjKXt0aGlzLmU9YTt0aGlzLm09Yjt0aGlzLmc9Y31TZi5wcm90b3R5cGUuZ2E9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5tPHRoaXMuZ307U2YucHJvdG90eXBlLm5leHQ9ZnVuY3Rpb24oKXt2YXIgYT1uZXcgVyhudWxsLDIsNSx1ZixbdGhpcy5lW3RoaXMubV0sdGhpcy5lW3RoaXMubSsxXV0sbnVsbCk7dGhpcy5tKz0yO3JldHVybiBhfTtmdW5jdGlvbiBwYShhLGIsYyxkKXt0aGlzLms9YTt0aGlzLmc9Yjt0aGlzLmU9Yzt0aGlzLnA9ZDt0aGlzLmo9MTY2NDc5NTE7dGhpcy5xPTgxOTZ9az1wYS5wcm90b3R5cGU7ay50b1N0cmluZz1mdW5jdGlvbigpe3JldHVybiBlYyh0aGlzKX07ay50PWZ1bmN0aW9uKGEsYil7cmV0dXJuICRhLmModGhpcyxiLG51bGwpfTtrLnM9ZnVuY3Rpb24oYSxiLGMpe2E9UWYodGhpcyxiKTtyZXR1cm4tMT09PWE/Yzp0aGlzLmVbYSsxXX07XG5rLmdiPWZ1bmN0aW9uKGEsYixjKXthPXRoaXMuZS5sZW5ndGg7Zm9yKHZhciBkPTA7OylpZihkPGEpe3ZhciBlPXRoaXMuZVtkXSxmPXRoaXMuZVtkKzFdO2M9Yi5jP2IuYyhjLGUsZik6Yi5jYWxsKG51bGwsYyxlLGYpO2lmKEFjKGMpKXJldHVybiBiPWMsTC5iP0wuYihiKTpMLmNhbGwobnVsbCxiKTtkKz0yfWVsc2UgcmV0dXJuIGN9O2sudmI9ITA7ay5mYj1mdW5jdGlvbigpe3JldHVybiBuZXcgU2YodGhpcy5lLDAsMip0aGlzLmcpfTtrLkg9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5rfTtrLkw9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5nfTtrLkI9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLnA7cmV0dXJuIG51bGwhPWE/YTp0aGlzLnA9YT14Yyh0aGlzKX07XG5rLkE9ZnVuY3Rpb24oYSxiKXtpZihiJiYoYi5qJjEwMjR8fGIuaWMpKXt2YXIgYz10aGlzLmUubGVuZ3RoO2lmKHRoaXMuZz09PWIuTChudWxsKSlmb3IodmFyIGQ9MDs7KWlmKGQ8Yyl7dmFyIGU9Yi5zKG51bGwsdGhpcy5lW2RdLGpkKTtpZihlIT09amQpaWYoc2MuYSh0aGlzLmVbZCsxXSxlKSlkKz0yO2Vsc2UgcmV0dXJuITE7ZWxzZSByZXR1cm4hMX1lbHNlIHJldHVybiEwO2Vsc2UgcmV0dXJuITF9ZWxzZSByZXR1cm4gUGYodGhpcyxiKX07ay4kYT1mdW5jdGlvbigpe3JldHVybiBuZXcgVGYoe30sdGhpcy5lLmxlbmd0aCxGYSh0aGlzLmUpKX07ay5KPWZ1bmN0aW9uKCl7cmV0dXJuIHViKFVmLHRoaXMuayl9O2suUj1mdW5jdGlvbihhLGIpe3JldHVybiBQLmEoYix0aGlzKX07ay5PPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gUC5jKGIsYyx0aGlzKX07XG5rLndiPWZ1bmN0aW9uKGEsYil7aWYoMDw9UWYodGhpcyxiKSl7dmFyIGM9dGhpcy5lLmxlbmd0aCxkPWMtMjtpZigwPT09ZClyZXR1cm4gTmEodGhpcyk7Zm9yKHZhciBkPUFycmF5KGQpLGU9MCxmPTA7Oyl7aWYoZT49YylyZXR1cm4gbmV3IHBhKHRoaXMuayx0aGlzLmctMSxkLG51bGwpO3NjLmEoYix0aGlzLmVbZV0pfHwoZFtmXT10aGlzLmVbZV0sZFtmKzFdPXRoaXMuZVtlKzFdLGYrPTIpO2UrPTJ9fWVsc2UgcmV0dXJuIHRoaXN9O1xuay5LYT1mdW5jdGlvbihhLGIsYyl7YT1RZih0aGlzLGIpO2lmKC0xPT09YSl7aWYodGhpcy5nPFZmKXthPXRoaXMuZTtmb3IodmFyIGQ9YS5sZW5ndGgsZT1BcnJheShkKzIpLGY9MDs7KWlmKGY8ZCllW2ZdPWFbZl0sZis9MTtlbHNlIGJyZWFrO2VbZF09YjtlW2QrMV09YztyZXR1cm4gbmV3IHBhKHRoaXMuayx0aGlzLmcrMSxlLG51bGwpfXJldHVybiB1YihjYihhZi5hKFFjLHRoaXMpLGIsYyksdGhpcy5rKX1pZihjPT09dGhpcy5lW2ErMV0pcmV0dXJuIHRoaXM7Yj1GYSh0aGlzLmUpO2JbYSsxXT1jO3JldHVybiBuZXcgcGEodGhpcy5rLHRoaXMuZyxiLG51bGwpfTtrLnJiPWZ1bmN0aW9uKGEsYil7cmV0dXJuLTEhPT1RZih0aGlzLGIpfTtrLkQ9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLmU7cmV0dXJuIDA8PWEubGVuZ3RoLTI/bmV3IFJmKGEsMCxudWxsKTpudWxsfTtrLkY9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IHBhKGIsdGhpcy5nLHRoaXMuZSx0aGlzLnApfTtcbmsuRz1mdW5jdGlvbihhLGIpe2lmKGVkKGIpKXJldHVybiBjYih0aGlzLEMuYShiLDApLEMuYShiLDEpKTtmb3IodmFyIGM9dGhpcyxkPUQoYik7Oyl7aWYobnVsbD09ZClyZXR1cm4gYzt2YXIgZT1HKGQpO2lmKGVkKGUpKWM9Y2IoYyxDLmEoZSwwKSxDLmEoZSwxKSksZD1LKGQpO2Vsc2UgdGhyb3cgRXJyb3IoXCJjb25qIG9uIGEgbWFwIHRha2VzIG1hcCBlbnRyaWVzIG9yIHNlcWFibGVzIG9mIG1hcCBlbnRyaWVzXCIpO319O1xuay5jYWxsPWZ1bmN0aW9uKCl7dmFyIGE9bnVsbCxhPWZ1bmN0aW9uKGEsYyxkKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiB0aGlzLnQobnVsbCxjKTtjYXNlIDM6cmV0dXJuIHRoaXMucyhudWxsLGMsZCl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2EuYT1mdW5jdGlvbihhLGMpe3JldHVybiB0aGlzLnQobnVsbCxjKX07YS5jPWZ1bmN0aW9uKGEsYyxkKXtyZXR1cm4gdGhpcy5zKG51bGwsYyxkKX07cmV0dXJuIGF9KCk7ay5hcHBseT1mdW5jdGlvbihhLGIpe3JldHVybiB0aGlzLmNhbGwuYXBwbHkodGhpcyxbdGhpc10uY29uY2F0KEZhKGIpKSl9O2suYj1mdW5jdGlvbihhKXtyZXR1cm4gdGhpcy50KG51bGwsYSl9O2suYT1mdW5jdGlvbihhLGIpe3JldHVybiB0aGlzLnMobnVsbCxhLGIpfTt2YXIgVWY9bmV3IHBhKG51bGwsMCxbXSxudWxsKSxWZj04O3BhLnByb3RvdHlwZVtFYV09ZnVuY3Rpb24oKXtyZXR1cm4gdWModGhpcyl9O1xuZnVuY3Rpb24gVGYoYSxiLGMpe3RoaXMuVmE9YTt0aGlzLnFhPWI7dGhpcy5lPWM7dGhpcy5xPTU2O3RoaXMuaj0yNTh9az1UZi5wcm90b3R5cGU7ay5KYj1mdW5jdGlvbihhLGIpe2lmKHQodGhpcy5WYSkpe3ZhciBjPVFmKHRoaXMsYik7MDw9YyYmKHRoaXMuZVtjXT10aGlzLmVbdGhpcy5xYS0yXSx0aGlzLmVbYysxXT10aGlzLmVbdGhpcy5xYS0xXSxjPXRoaXMuZSxjLnBvcCgpLGMucG9wKCksdGhpcy5xYS09Mik7cmV0dXJuIHRoaXN9dGhyb3cgRXJyb3IoXCJkaXNzb2MhIGFmdGVyIHBlcnNpc3RlbnQhXCIpO307XG5rLmtiPWZ1bmN0aW9uKGEsYixjKXt2YXIgZD10aGlzO2lmKHQoZC5WYSkpe2E9UWYodGhpcyxiKTtpZigtMT09PWEpcmV0dXJuIGQucWErMjw9MipWZj8oZC5xYSs9MixkLmUucHVzaChiKSxkLmUucHVzaChjKSx0aGlzKTplZS5jKGZ1bmN0aW9uKCl7dmFyIGE9ZC5xYSxiPWQuZTtyZXR1cm4gWGYuYT9YZi5hKGEsYik6WGYuY2FsbChudWxsLGEsYil9KCksYixjKTtjIT09ZC5lW2ErMV0mJihkLmVbYSsxXT1jKTtyZXR1cm4gdGhpc310aHJvdyBFcnJvcihcImFzc29jISBhZnRlciBwZXJzaXN0ZW50IVwiKTt9O1xuay5TYT1mdW5jdGlvbihhLGIpe2lmKHQodGhpcy5WYSkpe2lmKGI/Yi5qJjIwNDh8fGIuamN8fChiLmo/MDp3KGZiLGIpKTp3KGZiLGIpKXJldHVybiBSYih0aGlzLFlmLmI/WWYuYihiKTpZZi5jYWxsKG51bGwsYiksWmYuYj9aZi5iKGIpOlpmLmNhbGwobnVsbCxiKSk7Zm9yKHZhciBjPUQoYiksZD10aGlzOzspe3ZhciBlPUcoYyk7aWYodChlKSl2YXIgZj1lLGM9SyhjKSxkPVJiKGQsZnVuY3Rpb24oKXt2YXIgYT1mO3JldHVybiBZZi5iP1lmLmIoYSk6WWYuY2FsbChudWxsLGEpfSgpLGZ1bmN0aW9uKCl7dmFyIGE9ZjtyZXR1cm4gWmYuYj9aZi5iKGEpOlpmLmNhbGwobnVsbCxhKX0oKSk7ZWxzZSByZXR1cm4gZH19ZWxzZSB0aHJvdyBFcnJvcihcImNvbmohIGFmdGVyIHBlcnNpc3RlbnQhXCIpO307XG5rLlRhPWZ1bmN0aW9uKCl7aWYodCh0aGlzLlZhKSlyZXR1cm4gdGhpcy5WYT0hMSxuZXcgcGEobnVsbCxDZCh0aGlzLnFhLDIpLHRoaXMuZSxudWxsKTt0aHJvdyBFcnJvcihcInBlcnNpc3RlbnQhIGNhbGxlZCB0d2ljZVwiKTt9O2sudD1mdW5jdGlvbihhLGIpe3JldHVybiAkYS5jKHRoaXMsYixudWxsKX07ay5zPWZ1bmN0aW9uKGEsYixjKXtpZih0KHRoaXMuVmEpKXJldHVybiBhPVFmKHRoaXMsYiksLTE9PT1hP2M6dGhpcy5lW2ErMV07dGhyb3cgRXJyb3IoXCJsb29rdXAgYWZ0ZXIgcGVyc2lzdGVudCFcIik7fTtrLkw9ZnVuY3Rpb24oKXtpZih0KHRoaXMuVmEpKXJldHVybiBDZCh0aGlzLnFhLDIpO3Rocm93IEVycm9yKFwiY291bnQgYWZ0ZXIgcGVyc2lzdGVudCFcIik7fTtmdW5jdGlvbiBYZihhLGIpe2Zvcih2YXIgYz1PYihRYyksZD0wOzspaWYoZDxhKWM9ZWUuYyhjLGJbZF0sYltkKzFdKSxkKz0yO2Vsc2UgcmV0dXJuIGN9ZnVuY3Rpb24gJGYoKXt0aGlzLm89ITF9XG5mdW5jdGlvbiBhZyhhLGIpe3JldHVybiBhPT09Yj8hMDpOZChhLGIpPyEwOnNjLmEoYSxiKX12YXIgYmc9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjLGcsaCl7YT1GYShhKTthW2JdPWM7YVtnXT1oO3JldHVybiBhfWZ1bmN0aW9uIGIoYSxiLGMpe2E9RmEoYSk7YVtiXT1jO3JldHVybiBhfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUsZixnLGgpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDM6cmV0dXJuIGIuY2FsbCh0aGlzLGMsZSxmKTtjYXNlIDU6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSxmLGcsaCl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYz1iO2Mucj1hO3JldHVybiBjfSgpO2Z1bmN0aW9uIGNnKGEsYil7dmFyIGM9QXJyYXkoYS5sZW5ndGgtMik7aGQoYSwwLGMsMCwyKmIpO2hkKGEsMiooYisxKSxjLDIqYixjLmxlbmd0aC0yKmIpO3JldHVybiBjfVxudmFyIGRnPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyxnLGgsbCl7YT1hLk5hKGIpO2EuZVtjXT1nO2EuZVtoXT1sO3JldHVybiBhfWZ1bmN0aW9uIGIoYSxiLGMsZyl7YT1hLk5hKGIpO2EuZVtjXT1nO3JldHVybiBhfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUsZixnLGgsbCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgNDpyZXR1cm4gYi5jYWxsKHRoaXMsYyxlLGYsZyk7Y2FzZSA2OnJldHVybiBhLmNhbGwodGhpcyxjLGUsZixnLGgsbCl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2Mubj1iO2MuUD1hO3JldHVybiBjfSgpO1xuZnVuY3Rpb24gZWcoYSxiLGMpe2Zvcih2YXIgZD1hLmxlbmd0aCxlPTAsZj1jOzspaWYoZTxkKXtjPWFbZV07aWYobnVsbCE9Yyl7dmFyIGc9YVtlKzFdO2M9Yi5jP2IuYyhmLGMsZyk6Yi5jYWxsKG51bGwsZixjLGcpfWVsc2UgYz1hW2UrMV0sYz1udWxsIT1jP2MuWGEoYixmKTpmO2lmKEFjKGMpKXJldHVybiBhPWMsTC5iP0wuYihhKTpMLmNhbGwobnVsbCxhKTtlKz0yO2Y9Y31lbHNlIHJldHVybiBmfWZ1bmN0aW9uIGZnKGEsYixjKXt0aGlzLnU9YTt0aGlzLnc9Yjt0aGlzLmU9Y31rPWZnLnByb3RvdHlwZTtrLk5hPWZ1bmN0aW9uKGEpe2lmKGE9PT10aGlzLnUpcmV0dXJuIHRoaXM7dmFyIGI9RGQodGhpcy53KSxjPUFycmF5KDA+Yj80OjIqKGIrMSkpO2hkKHRoaXMuZSwwLGMsMCwyKmIpO3JldHVybiBuZXcgZmcoYSx0aGlzLncsYyl9O1xuay5uYj1mdW5jdGlvbihhLGIsYyxkLGUpe3ZhciBmPTE8PChjPj4+YiYzMSk7aWYoMD09PSh0aGlzLncmZikpcmV0dXJuIHRoaXM7dmFyIGc9RGQodGhpcy53JmYtMSksaD10aGlzLmVbMipnXSxsPXRoaXMuZVsyKmcrMV07cmV0dXJuIG51bGw9PWg/KGI9bC5uYihhLGIrNSxjLGQsZSksYj09PWw/dGhpczpudWxsIT1iP2RnLm4odGhpcyxhLDIqZysxLGIpOnRoaXMudz09PWY/bnVsbDpnZyh0aGlzLGEsZixnKSk6YWcoZCxoKT8oZVswXT0hMCxnZyh0aGlzLGEsZixnKSk6dGhpc307ZnVuY3Rpb24gZ2coYSxiLGMsZCl7aWYoYS53PT09YylyZXR1cm4gbnVsbDthPWEuTmEoYik7Yj1hLmU7dmFyIGU9Yi5sZW5ndGg7YS53Xj1jO2hkKGIsMiooZCsxKSxiLDIqZCxlLTIqKGQrMSkpO2JbZS0yXT1udWxsO2JbZS0xXT1udWxsO3JldHVybiBhfWsubGI9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLmU7cmV0dXJuIGhnLmI/aGcuYihhKTpoZy5jYWxsKG51bGwsYSl9O1xuay5YYT1mdW5jdGlvbihhLGIpe3JldHVybiBlZyh0aGlzLmUsYSxiKX07ay5PYT1mdW5jdGlvbihhLGIsYyxkKXt2YXIgZT0xPDwoYj4+PmEmMzEpO2lmKDA9PT0odGhpcy53JmUpKXJldHVybiBkO3ZhciBmPURkKHRoaXMudyZlLTEpLGU9dGhpcy5lWzIqZl0sZj10aGlzLmVbMipmKzFdO3JldHVybiBudWxsPT1lP2YuT2EoYSs1LGIsYyxkKTphZyhjLGUpP2Y6ZH07XG5rLmxhPWZ1bmN0aW9uKGEsYixjLGQsZSxmKXt2YXIgZz0xPDwoYz4+PmImMzEpLGg9RGQodGhpcy53JmctMSk7aWYoMD09PSh0aGlzLncmZykpe3ZhciBsPURkKHRoaXMudyk7aWYoMipsPHRoaXMuZS5sZW5ndGgpe3ZhciBtPXRoaXMuTmEoYSkscD1tLmU7Zi5vPSEwO2lkKHAsMipoLHAsMiooaCsxKSwyKihsLWgpKTtwWzIqaF09ZDtwWzIqaCsxXT1lO20ud3w9ZztyZXR1cm4gbX1pZigxNjw9bCl7Zz1bbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsXTtnW2M+Pj5iJjMxXT1pZy5sYShhLGIrNSxjLGQsZSxmKTtmb3IobT1oPTA7OylpZigzMj5oKTAhPT0odGhpcy53Pj4+aCYxKSYmKGdbaF09bnVsbCE9dGhpcy5lW21dP2lnLmxhKGEsYis1LG5jKHRoaXMuZVttXSksXG50aGlzLmVbbV0sdGhpcy5lW20rMV0sZik6dGhpcy5lW20rMV0sbSs9MiksaCs9MTtlbHNlIGJyZWFrO3JldHVybiBuZXcgamcoYSxsKzEsZyl9cD1BcnJheSgyKihsKzQpKTtoZCh0aGlzLmUsMCxwLDAsMipoKTtwWzIqaF09ZDtwWzIqaCsxXT1lO2hkKHRoaXMuZSwyKmgscCwyKihoKzEpLDIqKGwtaCkpO2Yubz0hMDttPXRoaXMuTmEoYSk7bS5lPXA7bS53fD1nO3JldHVybiBtfXZhciBxPXRoaXMuZVsyKmhdLHM9dGhpcy5lWzIqaCsxXTtpZihudWxsPT1xKXJldHVybiBsPXMubGEoYSxiKzUsYyxkLGUsZiksbD09PXM/dGhpczpkZy5uKHRoaXMsYSwyKmgrMSxsKTtpZihhZyhkLHEpKXJldHVybiBlPT09cz90aGlzOmRnLm4odGhpcyxhLDIqaCsxLGUpO2Yubz0hMDtyZXR1cm4gZGcuUCh0aGlzLGEsMipoLG51bGwsMipoKzEsZnVuY3Rpb24oKXt2YXIgZj1iKzU7cmV0dXJuIGtnLmlhP2tnLmlhKGEsZixxLHMsYyxkLGUpOmtnLmNhbGwobnVsbCxhLGYscSxzLGMsZCxlKX0oKSl9O1xuay5rYT1mdW5jdGlvbihhLGIsYyxkLGUpe3ZhciBmPTE8PChiPj4+YSYzMSksZz1EZCh0aGlzLncmZi0xKTtpZigwPT09KHRoaXMudyZmKSl7dmFyIGg9RGQodGhpcy53KTtpZigxNjw9aCl7Zj1bbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsXTtmW2I+Pj5hJjMxXT1pZy5rYShhKzUsYixjLGQsZSk7Zm9yKHZhciBsPWc9MDs7KWlmKDMyPmcpMCE9PSh0aGlzLnc+Pj5nJjEpJiYoZltnXT1udWxsIT10aGlzLmVbbF0/aWcua2EoYSs1LG5jKHRoaXMuZVtsXSksdGhpcy5lW2xdLHRoaXMuZVtsKzFdLGUpOnRoaXMuZVtsKzFdLGwrPTIpLGcrPTE7ZWxzZSBicmVhaztyZXR1cm4gbmV3IGpnKG51bGwsaCsxLGYpfWw9QXJyYXkoMiooaCsxKSk7aGQodGhpcy5lLFxuMCxsLDAsMipnKTtsWzIqZ109YztsWzIqZysxXT1kO2hkKHRoaXMuZSwyKmcsbCwyKihnKzEpLDIqKGgtZykpO2Uubz0hMDtyZXR1cm4gbmV3IGZnKG51bGwsdGhpcy53fGYsbCl9dmFyIG09dGhpcy5lWzIqZ10scD10aGlzLmVbMipnKzFdO2lmKG51bGw9PW0pcmV0dXJuIGg9cC5rYShhKzUsYixjLGQsZSksaD09PXA/dGhpczpuZXcgZmcobnVsbCx0aGlzLncsYmcuYyh0aGlzLmUsMipnKzEsaCkpO2lmKGFnKGMsbSkpcmV0dXJuIGQ9PT1wP3RoaXM6bmV3IGZnKG51bGwsdGhpcy53LGJnLmModGhpcy5lLDIqZysxLGQpKTtlLm89ITA7cmV0dXJuIG5ldyBmZyhudWxsLHRoaXMudyxiZy5yKHRoaXMuZSwyKmcsbnVsbCwyKmcrMSxmdW5jdGlvbigpe3ZhciBlPWErNTtyZXR1cm4ga2cuUD9rZy5QKGUsbSxwLGIsYyxkKTprZy5jYWxsKG51bGwsZSxtLHAsYixjLGQpfSgpKSl9O1xuay5tYj1mdW5jdGlvbihhLGIsYyl7dmFyIGQ9MTw8KGI+Pj5hJjMxKTtpZigwPT09KHRoaXMudyZkKSlyZXR1cm4gdGhpczt2YXIgZT1EZCh0aGlzLncmZC0xKSxmPXRoaXMuZVsyKmVdLGc9dGhpcy5lWzIqZSsxXTtyZXR1cm4gbnVsbD09Zj8oYT1nLm1iKGErNSxiLGMpLGE9PT1nP3RoaXM6bnVsbCE9YT9uZXcgZmcobnVsbCx0aGlzLncsYmcuYyh0aGlzLmUsMiplKzEsYSkpOnRoaXMudz09PWQ/bnVsbDpuZXcgZmcobnVsbCx0aGlzLndeZCxjZyh0aGlzLmUsZSkpKTphZyhjLGYpP25ldyBmZyhudWxsLHRoaXMud15kLGNnKHRoaXMuZSxlKSk6dGhpc307dmFyIGlnPW5ldyBmZyhudWxsLDAsW10pO1xuZnVuY3Rpb24gbGcoYSxiLGMpe3ZhciBkPWEuZSxlPWQubGVuZ3RoO2E9QXJyYXkoMiooYS5nLTEpKTtmb3IodmFyIGY9MCxnPTEsaD0wOzspaWYoZjxlKWYhPT1jJiZudWxsIT1kW2ZdJiYoYVtnXT1kW2ZdLGcrPTIsaHw9MTw8ZiksZis9MTtlbHNlIHJldHVybiBuZXcgZmcoYixoLGEpfWZ1bmN0aW9uIGpnKGEsYixjKXt0aGlzLnU9YTt0aGlzLmc9Yjt0aGlzLmU9Y31rPWpnLnByb3RvdHlwZTtrLk5hPWZ1bmN0aW9uKGEpe3JldHVybiBhPT09dGhpcy51P3RoaXM6bmV3IGpnKGEsdGhpcy5nLEZhKHRoaXMuZSkpfTtcbmsubmI9ZnVuY3Rpb24oYSxiLGMsZCxlKXt2YXIgZj1jPj4+YiYzMSxnPXRoaXMuZVtmXTtpZihudWxsPT1nKXJldHVybiB0aGlzO2I9Zy5uYihhLGIrNSxjLGQsZSk7aWYoYj09PWcpcmV0dXJuIHRoaXM7aWYobnVsbD09Yil7aWYoOD49dGhpcy5nKXJldHVybiBsZyh0aGlzLGEsZik7YT1kZy5uKHRoaXMsYSxmLGIpO2EuZy09MTtyZXR1cm4gYX1yZXR1cm4gZGcubih0aGlzLGEsZixiKX07ay5sYj1mdW5jdGlvbigpe3ZhciBhPXRoaXMuZTtyZXR1cm4gbWcuYj9tZy5iKGEpOm1nLmNhbGwobnVsbCxhKX07ay5YYT1mdW5jdGlvbihhLGIpe2Zvcih2YXIgYz10aGlzLmUubGVuZ3RoLGQ9MCxlPWI7OylpZihkPGMpe3ZhciBmPXRoaXMuZVtkXTtpZihudWxsIT1mJiYoZT1mLlhhKGEsZSksQWMoZSkpKXJldHVybiBjPWUsTC5iP0wuYihjKTpMLmNhbGwobnVsbCxjKTtkKz0xfWVsc2UgcmV0dXJuIGV9O1xuay5PYT1mdW5jdGlvbihhLGIsYyxkKXt2YXIgZT10aGlzLmVbYj4+PmEmMzFdO3JldHVybiBudWxsIT1lP2UuT2EoYSs1LGIsYyxkKTpkfTtrLmxhPWZ1bmN0aW9uKGEsYixjLGQsZSxmKXt2YXIgZz1jPj4+YiYzMSxoPXRoaXMuZVtnXTtpZihudWxsPT1oKXJldHVybiBhPWRnLm4odGhpcyxhLGcsaWcubGEoYSxiKzUsYyxkLGUsZikpLGEuZys9MSxhO2I9aC5sYShhLGIrNSxjLGQsZSxmKTtyZXR1cm4gYj09PWg/dGhpczpkZy5uKHRoaXMsYSxnLGIpfTtrLmthPWZ1bmN0aW9uKGEsYixjLGQsZSl7dmFyIGY9Yj4+PmEmMzEsZz10aGlzLmVbZl07aWYobnVsbD09ZylyZXR1cm4gbmV3IGpnKG51bGwsdGhpcy5nKzEsYmcuYyh0aGlzLmUsZixpZy5rYShhKzUsYixjLGQsZSkpKTthPWcua2EoYSs1LGIsYyxkLGUpO3JldHVybiBhPT09Zz90aGlzOm5ldyBqZyhudWxsLHRoaXMuZyxiZy5jKHRoaXMuZSxmLGEpKX07XG5rLm1iPWZ1bmN0aW9uKGEsYixjKXt2YXIgZD1iPj4+YSYzMSxlPXRoaXMuZVtkXTtyZXR1cm4gbnVsbCE9ZT8oYT1lLm1iKGErNSxiLGMpLGE9PT1lP3RoaXM6bnVsbD09YT84Pj10aGlzLmc/bGcodGhpcyxudWxsLGQpOm5ldyBqZyhudWxsLHRoaXMuZy0xLGJnLmModGhpcy5lLGQsYSkpOm5ldyBqZyhudWxsLHRoaXMuZyxiZy5jKHRoaXMuZSxkLGEpKSk6dGhpc307ZnVuY3Rpb24gbmcoYSxiLGMpe2IqPTI7Zm9yKHZhciBkPTA7OylpZihkPGIpe2lmKGFnKGMsYVtkXSkpcmV0dXJuIGQ7ZCs9Mn1lbHNlIHJldHVybi0xfWZ1bmN0aW9uIG9nKGEsYixjLGQpe3RoaXMudT1hO3RoaXMuSWE9Yjt0aGlzLmc9Yzt0aGlzLmU9ZH1rPW9nLnByb3RvdHlwZTtrLk5hPWZ1bmN0aW9uKGEpe2lmKGE9PT10aGlzLnUpcmV0dXJuIHRoaXM7dmFyIGI9QXJyYXkoMioodGhpcy5nKzEpKTtoZCh0aGlzLmUsMCxiLDAsMip0aGlzLmcpO3JldHVybiBuZXcgb2coYSx0aGlzLklhLHRoaXMuZyxiKX07XG5rLm5iPWZ1bmN0aW9uKGEsYixjLGQsZSl7Yj1uZyh0aGlzLmUsdGhpcy5nLGQpO2lmKC0xPT09YilyZXR1cm4gdGhpcztlWzBdPSEwO2lmKDE9PT10aGlzLmcpcmV0dXJuIG51bGw7YT10aGlzLk5hKGEpO2U9YS5lO2VbYl09ZVsyKnRoaXMuZy0yXTtlW2IrMV09ZVsyKnRoaXMuZy0xXTtlWzIqdGhpcy5nLTFdPW51bGw7ZVsyKnRoaXMuZy0yXT1udWxsO2EuZy09MTtyZXR1cm4gYX07ay5sYj1mdW5jdGlvbigpe3ZhciBhPXRoaXMuZTtyZXR1cm4gaGcuYj9oZy5iKGEpOmhnLmNhbGwobnVsbCxhKX07ay5YYT1mdW5jdGlvbihhLGIpe3JldHVybiBlZyh0aGlzLmUsYSxiKX07ay5PYT1mdW5jdGlvbihhLGIsYyxkKXthPW5nKHRoaXMuZSx0aGlzLmcsYyk7cmV0dXJuIDA+YT9kOmFnKGMsdGhpcy5lW2FdKT90aGlzLmVbYSsxXTpkfTtcbmsubGE9ZnVuY3Rpb24oYSxiLGMsZCxlLGYpe2lmKGM9PT10aGlzLklhKXtiPW5nKHRoaXMuZSx0aGlzLmcsZCk7aWYoLTE9PT1iKXtpZih0aGlzLmUubGVuZ3RoPjIqdGhpcy5nKXJldHVybiBhPWRnLlAodGhpcyxhLDIqdGhpcy5nLGQsMip0aGlzLmcrMSxlKSxmLm89ITAsYS5nKz0xLGE7Yz10aGlzLmUubGVuZ3RoO2I9QXJyYXkoYysyKTtoZCh0aGlzLmUsMCxiLDAsYyk7YltjXT1kO2JbYysxXT1lO2Yubz0hMDtmPXRoaXMuZysxO2E9PT10aGlzLnU/KHRoaXMuZT1iLHRoaXMuZz1mLGE9dGhpcyk6YT1uZXcgb2codGhpcy51LHRoaXMuSWEsZixiKTtyZXR1cm4gYX1yZXR1cm4gdGhpcy5lW2IrMV09PT1lP3RoaXM6ZGcubih0aGlzLGEsYisxLGUpfXJldHVybihuZXcgZmcoYSwxPDwodGhpcy5JYT4+PmImMzEpLFtudWxsLHRoaXMsbnVsbCxudWxsXSkpLmxhKGEsYixjLGQsZSxmKX07XG5rLmthPWZ1bmN0aW9uKGEsYixjLGQsZSl7cmV0dXJuIGI9PT10aGlzLklhPyhhPW5nKHRoaXMuZSx0aGlzLmcsYyksLTE9PT1hPyhhPTIqdGhpcy5nLGI9QXJyYXkoYSsyKSxoZCh0aGlzLmUsMCxiLDAsYSksYlthXT1jLGJbYSsxXT1kLGUubz0hMCxuZXcgb2cobnVsbCx0aGlzLklhLHRoaXMuZysxLGIpKTpzYy5hKHRoaXMuZVthXSxkKT90aGlzOm5ldyBvZyhudWxsLHRoaXMuSWEsdGhpcy5nLGJnLmModGhpcy5lLGErMSxkKSkpOihuZXcgZmcobnVsbCwxPDwodGhpcy5JYT4+PmEmMzEpLFtudWxsLHRoaXNdKSkua2EoYSxiLGMsZCxlKX07ay5tYj1mdW5jdGlvbihhLGIsYyl7YT1uZyh0aGlzLmUsdGhpcy5nLGMpO3JldHVybi0xPT09YT90aGlzOjE9PT10aGlzLmc/bnVsbDpuZXcgb2cobnVsbCx0aGlzLklhLHRoaXMuZy0xLGNnKHRoaXMuZSxDZChhLDIpKSl9O1xudmFyIGtnPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyxnLGgsbCxtKXt2YXIgcD1uYyhjKTtpZihwPT09aClyZXR1cm4gbmV3IG9nKG51bGwscCwyLFtjLGcsbCxtXSk7dmFyIHE9bmV3ICRmO3JldHVybiBpZy5sYShhLGIscCxjLGcscSkubGEoYSxiLGgsbCxtLHEpfWZ1bmN0aW9uIGIoYSxiLGMsZyxoLGwpe3ZhciBtPW5jKGIpO2lmKG09PT1nKXJldHVybiBuZXcgb2cobnVsbCxtLDIsW2IsYyxoLGxdKTt2YXIgcD1uZXcgJGY7cmV0dXJuIGlnLmthKGEsbSxiLGMscCkua2EoYSxnLGgsbCxwKX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlLGYsZyxoLGwsbSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgNjpyZXR1cm4gYi5jYWxsKHRoaXMsYyxlLGYsZyxoLGwpO2Nhc2UgNzpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlLGYsZyxoLGwsbSl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuUD1iO2MuaWE9YTtyZXR1cm4gY30oKTtcbmZ1bmN0aW9uIHBnKGEsYixjLGQsZSl7dGhpcy5rPWE7dGhpcy5QYT1iO3RoaXMubT1jO3RoaXMuQz1kO3RoaXMucD1lO3RoaXMucT0wO3RoaXMuaj0zMjM3NDg2MH1rPXBnLnByb3RvdHlwZTtrLnRvU3RyaW5nPWZ1bmN0aW9uKCl7cmV0dXJuIGVjKHRoaXMpfTtrLkg9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5rfTtrLkI9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLnA7cmV0dXJuIG51bGwhPWE/YTp0aGlzLnA9YT13Yyh0aGlzKX07ay5BPWZ1bmN0aW9uKGEsYil7cmV0dXJuIEljKHRoaXMsYil9O2suSj1mdW5jdGlvbigpe3JldHVybiBPKEosdGhpcy5rKX07ay5SPWZ1bmN0aW9uKGEsYil7cmV0dXJuIFAuYShiLHRoaXMpfTtrLk89ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBQLmMoYixjLHRoaXMpfTtrLk49ZnVuY3Rpb24oKXtyZXR1cm4gbnVsbD09dGhpcy5DP25ldyBXKG51bGwsMiw1LHVmLFt0aGlzLlBhW3RoaXMubV0sdGhpcy5QYVt0aGlzLm0rMV1dLG51bGwpOkcodGhpcy5DKX07XG5rLlM9ZnVuY3Rpb24oKXtpZihudWxsPT10aGlzLkMpe3ZhciBhPXRoaXMuUGEsYj10aGlzLm0rMjtyZXR1cm4gaGcuYz9oZy5jKGEsYixudWxsKTpoZy5jYWxsKG51bGwsYSxiLG51bGwpfXZhciBhPXRoaXMuUGEsYj10aGlzLm0sYz1LKHRoaXMuQyk7cmV0dXJuIGhnLmM/aGcuYyhhLGIsYyk6aGcuY2FsbChudWxsLGEsYixjKX07ay5EPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXN9O2suRj1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgcGcoYix0aGlzLlBhLHRoaXMubSx0aGlzLkMsdGhpcy5wKX07ay5HPWZ1bmN0aW9uKGEsYil7cmV0dXJuIE0oYix0aGlzKX07cGcucHJvdG90eXBlW0VhXT1mdW5jdGlvbigpe3JldHVybiB1Yyh0aGlzKX07XG52YXIgaGc9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjKXtpZihudWxsPT1jKWZvcihjPWEubGVuZ3RoOzspaWYoYjxjKXtpZihudWxsIT1hW2JdKXJldHVybiBuZXcgcGcobnVsbCxhLGIsbnVsbCxudWxsKTt2YXIgZz1hW2IrMV07aWYodChnKSYmKGc9Zy5sYigpLHQoZykpKXJldHVybiBuZXcgcGcobnVsbCxhLGIrMixnLG51bGwpO2IrPTJ9ZWxzZSByZXR1cm4gbnVsbDtlbHNlIHJldHVybiBuZXcgcGcobnVsbCxhLGIsYyxudWxsKX1mdW5jdGlvbiBiKGEpe3JldHVybiBjLmMoYSwwLG51bGwpfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYi5jYWxsKHRoaXMsYyk7Y2FzZSAzOnJldHVybiBhLmNhbGwodGhpcyxjLGUsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYj1iO2MuYz1hO3JldHVybiBjfSgpO1xuZnVuY3Rpb24gcWcoYSxiLGMsZCxlKXt0aGlzLms9YTt0aGlzLlBhPWI7dGhpcy5tPWM7dGhpcy5DPWQ7dGhpcy5wPWU7dGhpcy5xPTA7dGhpcy5qPTMyMzc0ODYwfWs9cWcucHJvdG90eXBlO2sudG9TdHJpbmc9ZnVuY3Rpb24oKXtyZXR1cm4gZWModGhpcyl9O2suSD1mdW5jdGlvbigpe3JldHVybiB0aGlzLmt9O2suQj1mdW5jdGlvbigpe3ZhciBhPXRoaXMucDtyZXR1cm4gbnVsbCE9YT9hOnRoaXMucD1hPXdjKHRoaXMpfTtrLkE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gSWModGhpcyxiKX07ay5KPWZ1bmN0aW9uKCl7cmV0dXJuIE8oSix0aGlzLmspfTtrLlI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gUC5hKGIsdGhpcyl9O2suTz1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIFAuYyhiLGMsdGhpcyl9O2suTj1mdW5jdGlvbigpe3JldHVybiBHKHRoaXMuQyl9O1xuay5TPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5QYSxiPXRoaXMubSxjPUsodGhpcy5DKTtyZXR1cm4gbWcubj9tZy5uKG51bGwsYSxiLGMpOm1nLmNhbGwobnVsbCxudWxsLGEsYixjKX07ay5EPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXN9O2suRj1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgcWcoYix0aGlzLlBhLHRoaXMubSx0aGlzLkMsdGhpcy5wKX07ay5HPWZ1bmN0aW9uKGEsYil7cmV0dXJuIE0oYix0aGlzKX07cWcucHJvdG90eXBlW0VhXT1mdW5jdGlvbigpe3JldHVybiB1Yyh0aGlzKX07XG52YXIgbWc9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYixjLGcpe2lmKG51bGw9PWcpZm9yKGc9Yi5sZW5ndGg7OylpZihjPGcpe3ZhciBoPWJbY107aWYodChoKSYmKGg9aC5sYigpLHQoaCkpKXJldHVybiBuZXcgcWcoYSxiLGMrMSxoLG51bGwpO2MrPTF9ZWxzZSByZXR1cm4gbnVsbDtlbHNlIHJldHVybiBuZXcgcWcoYSxiLGMsZyxudWxsKX1mdW5jdGlvbiBiKGEpe3JldHVybiBjLm4obnVsbCxhLDAsbnVsbCl9dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSxmLGcpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGIuY2FsbCh0aGlzLGMpO2Nhc2UgNDpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlLGYsZyl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYj1iO2Mubj1hO3JldHVybiBjfSgpO1xuZnVuY3Rpb24gcmcoYSxiLGMsZCxlLGYpe3RoaXMuaz1hO3RoaXMuZz1iO3RoaXMucm9vdD1jO3RoaXMuVT1kO3RoaXMuZGE9ZTt0aGlzLnA9Zjt0aGlzLmo9MTYxMjM2NjM7dGhpcy5xPTgxOTZ9az1yZy5wcm90b3R5cGU7ay50b1N0cmluZz1mdW5jdGlvbigpe3JldHVybiBlYyh0aGlzKX07ay50PWZ1bmN0aW9uKGEsYil7cmV0dXJuICRhLmModGhpcyxiLG51bGwpfTtrLnM9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBudWxsPT1iP3RoaXMuVT90aGlzLmRhOmM6bnVsbD09dGhpcy5yb290P2M6dGhpcy5yb290Lk9hKDAsbmMoYiksYixjKX07ay5nYj1mdW5jdGlvbihhLGIsYyl7dGhpcy5VJiYoYT10aGlzLmRhLGM9Yi5jP2IuYyhjLG51bGwsYSk6Yi5jYWxsKG51bGwsYyxudWxsLGEpKTtyZXR1cm4gQWMoYyk/TC5iP0wuYihjKTpMLmNhbGwobnVsbCxjKTpudWxsIT10aGlzLnJvb3Q/dGhpcy5yb290LlhhKGIsYyk6Y307ay5IPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMua307ay5MPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuZ307XG5rLkI9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLnA7cmV0dXJuIG51bGwhPWE/YTp0aGlzLnA9YT14Yyh0aGlzKX07ay5BPWZ1bmN0aW9uKGEsYil7cmV0dXJuIFBmKHRoaXMsYil9O2suJGE9ZnVuY3Rpb24oKXtyZXR1cm4gbmV3IHNnKHt9LHRoaXMucm9vdCx0aGlzLmcsdGhpcy5VLHRoaXMuZGEpfTtrLko9ZnVuY3Rpb24oKXtyZXR1cm4gdWIoUWMsdGhpcy5rKX07ay53Yj1mdW5jdGlvbihhLGIpe2lmKG51bGw9PWIpcmV0dXJuIHRoaXMuVT9uZXcgcmcodGhpcy5rLHRoaXMuZy0xLHRoaXMucm9vdCwhMSxudWxsLG51bGwpOnRoaXM7aWYobnVsbD09dGhpcy5yb290KXJldHVybiB0aGlzO3ZhciBjPXRoaXMucm9vdC5tYigwLG5jKGIpLGIpO3JldHVybiBjPT09dGhpcy5yb290P3RoaXM6bmV3IHJnKHRoaXMuayx0aGlzLmctMSxjLHRoaXMuVSx0aGlzLmRhLG51bGwpfTtcbmsuS2E9ZnVuY3Rpb24oYSxiLGMpe2lmKG51bGw9PWIpcmV0dXJuIHRoaXMuVSYmYz09PXRoaXMuZGE/dGhpczpuZXcgcmcodGhpcy5rLHRoaXMuVT90aGlzLmc6dGhpcy5nKzEsdGhpcy5yb290LCEwLGMsbnVsbCk7YT1uZXcgJGY7Yj0obnVsbD09dGhpcy5yb290P2lnOnRoaXMucm9vdCkua2EoMCxuYyhiKSxiLGMsYSk7cmV0dXJuIGI9PT10aGlzLnJvb3Q/dGhpczpuZXcgcmcodGhpcy5rLGEubz90aGlzLmcrMTp0aGlzLmcsYix0aGlzLlUsdGhpcy5kYSxudWxsKX07ay5yYj1mdW5jdGlvbihhLGIpe3JldHVybiBudWxsPT1iP3RoaXMuVTpudWxsPT10aGlzLnJvb3Q/ITE6dGhpcy5yb290Lk9hKDAsbmMoYiksYixqZCkhPT1qZH07ay5EPWZ1bmN0aW9uKCl7aWYoMDx0aGlzLmcpe3ZhciBhPW51bGwhPXRoaXMucm9vdD90aGlzLnJvb3QubGIoKTpudWxsO3JldHVybiB0aGlzLlU/TShuZXcgVyhudWxsLDIsNSx1ZixbbnVsbCx0aGlzLmRhXSxudWxsKSxhKTphfXJldHVybiBudWxsfTtcbmsuRj1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgcmcoYix0aGlzLmcsdGhpcy5yb290LHRoaXMuVSx0aGlzLmRhLHRoaXMucCl9O2suRz1mdW5jdGlvbihhLGIpe2lmKGVkKGIpKXJldHVybiBjYih0aGlzLEMuYShiLDApLEMuYShiLDEpKTtmb3IodmFyIGM9dGhpcyxkPUQoYik7Oyl7aWYobnVsbD09ZClyZXR1cm4gYzt2YXIgZT1HKGQpO2lmKGVkKGUpKWM9Y2IoYyxDLmEoZSwwKSxDLmEoZSwxKSksZD1LKGQpO2Vsc2UgdGhyb3cgRXJyb3IoXCJjb25qIG9uIGEgbWFwIHRha2VzIG1hcCBlbnRyaWVzIG9yIHNlcWFibGVzIG9mIG1hcCBlbnRyaWVzXCIpO319O1xuay5jYWxsPWZ1bmN0aW9uKCl7dmFyIGE9bnVsbCxhPWZ1bmN0aW9uKGEsYyxkKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiB0aGlzLnQobnVsbCxjKTtjYXNlIDM6cmV0dXJuIHRoaXMucyhudWxsLGMsZCl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2EuYT1mdW5jdGlvbihhLGMpe3JldHVybiB0aGlzLnQobnVsbCxjKX07YS5jPWZ1bmN0aW9uKGEsYyxkKXtyZXR1cm4gdGhpcy5zKG51bGwsYyxkKX07cmV0dXJuIGF9KCk7ay5hcHBseT1mdW5jdGlvbihhLGIpe3JldHVybiB0aGlzLmNhbGwuYXBwbHkodGhpcyxbdGhpc10uY29uY2F0KEZhKGIpKSl9O2suYj1mdW5jdGlvbihhKXtyZXR1cm4gdGhpcy50KG51bGwsYSl9O2suYT1mdW5jdGlvbihhLGIpe3JldHVybiB0aGlzLnMobnVsbCxhLGIpfTt2YXIgUWM9bmV3IHJnKG51bGwsMCxudWxsLCExLG51bGwsMCk7cmcucHJvdG90eXBlW0VhXT1mdW5jdGlvbigpe3JldHVybiB1Yyh0aGlzKX07XG5mdW5jdGlvbiBzZyhhLGIsYyxkLGUpe3RoaXMudT1hO3RoaXMucm9vdD1iO3RoaXMuY291bnQ9Yzt0aGlzLlU9ZDt0aGlzLmRhPWU7dGhpcy5xPTU2O3RoaXMuaj0yNTh9az1zZy5wcm90b3R5cGU7ay5KYj1mdW5jdGlvbihhLGIpe2lmKHRoaXMudSlpZihudWxsPT1iKXRoaXMuVSYmKHRoaXMuVT0hMSx0aGlzLmRhPW51bGwsdGhpcy5jb3VudC09MSk7ZWxzZXtpZihudWxsIT10aGlzLnJvb3Qpe3ZhciBjPW5ldyAkZixkPXRoaXMucm9vdC5uYih0aGlzLnUsMCxuYyhiKSxiLGMpO2QhPT10aGlzLnJvb3QmJih0aGlzLnJvb3Q9ZCk7dChjWzBdKSYmKHRoaXMuY291bnQtPTEpfX1lbHNlIHRocm93IEVycm9yKFwiZGlzc29jISBhZnRlciBwZXJzaXN0ZW50IVwiKTtyZXR1cm4gdGhpc307ay5rYj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIHRnKHRoaXMsYixjKX07ay5TYT1mdW5jdGlvbihhLGIpe3JldHVybiB1Zyh0aGlzLGIpfTtcbmsuVGE9ZnVuY3Rpb24oKXt2YXIgYTtpZih0aGlzLnUpdGhpcy51PW51bGwsYT1uZXcgcmcobnVsbCx0aGlzLmNvdW50LHRoaXMucm9vdCx0aGlzLlUsdGhpcy5kYSxudWxsKTtlbHNlIHRocm93IEVycm9yKFwicGVyc2lzdGVudCEgY2FsbGVkIHR3aWNlXCIpO3JldHVybiBhfTtrLnQ9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbnVsbD09Yj90aGlzLlU/dGhpcy5kYTpudWxsOm51bGw9PXRoaXMucm9vdD9udWxsOnRoaXMucm9vdC5PYSgwLG5jKGIpLGIpfTtrLnM9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBudWxsPT1iP3RoaXMuVT90aGlzLmRhOmM6bnVsbD09dGhpcy5yb290P2M6dGhpcy5yb290Lk9hKDAsbmMoYiksYixjKX07ay5MPWZ1bmN0aW9uKCl7aWYodGhpcy51KXJldHVybiB0aGlzLmNvdW50O3Rocm93IEVycm9yKFwiY291bnQgYWZ0ZXIgcGVyc2lzdGVudCFcIik7fTtcbmZ1bmN0aW9uIHVnKGEsYil7aWYoYS51KXtpZihiP2IuaiYyMDQ4fHxiLmpjfHwoYi5qPzA6dyhmYixiKSk6dyhmYixiKSlyZXR1cm4gdGcoYSxZZi5iP1lmLmIoYik6WWYuY2FsbChudWxsLGIpLFpmLmI/WmYuYihiKTpaZi5jYWxsKG51bGwsYikpO2Zvcih2YXIgYz1EKGIpLGQ9YTs7KXt2YXIgZT1HKGMpO2lmKHQoZSkpdmFyIGY9ZSxjPUsoYyksZD10ZyhkLGZ1bmN0aW9uKCl7dmFyIGE9ZjtyZXR1cm4gWWYuYj9ZZi5iKGEpOllmLmNhbGwobnVsbCxhKX0oKSxmdW5jdGlvbigpe3ZhciBhPWY7cmV0dXJuIFpmLmI/WmYuYihhKTpaZi5jYWxsKG51bGwsYSl9KCkpO2Vsc2UgcmV0dXJuIGR9fWVsc2UgdGhyb3cgRXJyb3IoXCJjb25qISBhZnRlciBwZXJzaXN0ZW50XCIpO31cbmZ1bmN0aW9uIHRnKGEsYixjKXtpZihhLnUpe2lmKG51bGw9PWIpYS5kYSE9PWMmJihhLmRhPWMpLGEuVXx8KGEuY291bnQrPTEsYS5VPSEwKTtlbHNle3ZhciBkPW5ldyAkZjtiPShudWxsPT1hLnJvb3Q/aWc6YS5yb290KS5sYShhLnUsMCxuYyhiKSxiLGMsZCk7YiE9PWEucm9vdCYmKGEucm9vdD1iKTtkLm8mJihhLmNvdW50Kz0xKX1yZXR1cm4gYX10aHJvdyBFcnJvcihcImFzc29jISBhZnRlciBwZXJzaXN0ZW50IVwiKTt9ZnVuY3Rpb24gdmcoYSxiLGMpe2Zvcih2YXIgZD1iOzspaWYobnVsbCE9YSliPWM/YS5sZWZ0OmEucmlnaHQsZD1OYy5hKGQsYSksYT1iO2Vsc2UgcmV0dXJuIGR9ZnVuY3Rpb24gd2coYSxiLGMsZCxlKXt0aGlzLms9YTt0aGlzLnN0YWNrPWI7dGhpcy5wYj1jO3RoaXMuZz1kO3RoaXMucD1lO3RoaXMucT0wO3RoaXMuaj0zMjM3NDg2Mn1rPXdnLnByb3RvdHlwZTtrLnRvU3RyaW5nPWZ1bmN0aW9uKCl7cmV0dXJuIGVjKHRoaXMpfTtrLkg9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5rfTtcbmsuTD1mdW5jdGlvbigpe3JldHVybiAwPnRoaXMuZz9RKEsodGhpcykpKzE6dGhpcy5nfTtrLkI9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLnA7cmV0dXJuIG51bGwhPWE/YTp0aGlzLnA9YT13Yyh0aGlzKX07ay5BPWZ1bmN0aW9uKGEsYil7cmV0dXJuIEljKHRoaXMsYil9O2suSj1mdW5jdGlvbigpe3JldHVybiBPKEosdGhpcy5rKX07ay5SPWZ1bmN0aW9uKGEsYil7cmV0dXJuIFAuYShiLHRoaXMpfTtrLk89ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBQLmMoYixjLHRoaXMpfTtrLk49ZnVuY3Rpb24oKXtyZXR1cm4gV2ModGhpcy5zdGFjayl9O2suUz1mdW5jdGlvbigpe3ZhciBhPUcodGhpcy5zdGFjayksYT12Zyh0aGlzLnBiP2EucmlnaHQ6YS5sZWZ0LEsodGhpcy5zdGFjayksdGhpcy5wYik7cmV0dXJuIG51bGwhPWE/bmV3IHdnKG51bGwsYSx0aGlzLnBiLHRoaXMuZy0xLG51bGwpOkp9O2suRD1mdW5jdGlvbigpe3JldHVybiB0aGlzfTtcbmsuRj1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgd2coYix0aGlzLnN0YWNrLHRoaXMucGIsdGhpcy5nLHRoaXMucCl9O2suRz1mdW5jdGlvbihhLGIpe3JldHVybiBNKGIsdGhpcyl9O3dnLnByb3RvdHlwZVtFYV09ZnVuY3Rpb24oKXtyZXR1cm4gdWModGhpcyl9O2Z1bmN0aW9uIHhnKGEsYixjKXtyZXR1cm4gbmV3IHdnKG51bGwsdmcoYSxudWxsLGIpLGIsYyxudWxsKX1cbmZ1bmN0aW9uIHlnKGEsYixjLGQpe3JldHVybiBjIGluc3RhbmNlb2YgWD9jLmxlZnQgaW5zdGFuY2VvZiBYP25ldyBYKGMua2V5LGMubyxjLmxlZnQudWEoKSxuZXcgWihhLGIsYy5yaWdodCxkLG51bGwpLG51bGwpOmMucmlnaHQgaW5zdGFuY2VvZiBYP25ldyBYKGMucmlnaHQua2V5LGMucmlnaHQubyxuZXcgWihjLmtleSxjLm8sYy5sZWZ0LGMucmlnaHQubGVmdCxudWxsKSxuZXcgWihhLGIsYy5yaWdodC5yaWdodCxkLG51bGwpLG51bGwpOm5ldyBaKGEsYixjLGQsbnVsbCk6bmV3IFooYSxiLGMsZCxudWxsKX1cbmZ1bmN0aW9uIHpnKGEsYixjLGQpe3JldHVybiBkIGluc3RhbmNlb2YgWD9kLnJpZ2h0IGluc3RhbmNlb2YgWD9uZXcgWChkLmtleSxkLm8sbmV3IFooYSxiLGMsZC5sZWZ0LG51bGwpLGQucmlnaHQudWEoKSxudWxsKTpkLmxlZnQgaW5zdGFuY2VvZiBYP25ldyBYKGQubGVmdC5rZXksZC5sZWZ0Lm8sbmV3IFooYSxiLGMsZC5sZWZ0LmxlZnQsbnVsbCksbmV3IFooZC5rZXksZC5vLGQubGVmdC5yaWdodCxkLnJpZ2h0LG51bGwpLG51bGwpOm5ldyBaKGEsYixjLGQsbnVsbCk6bmV3IFooYSxiLGMsZCxudWxsKX1cbmZ1bmN0aW9uIEFnKGEsYixjLGQpe2lmKGMgaW5zdGFuY2VvZiBYKXJldHVybiBuZXcgWChhLGIsYy51YSgpLGQsbnVsbCk7aWYoZCBpbnN0YW5jZW9mIFopcmV0dXJuIHpnKGEsYixjLGQub2IoKSk7aWYoZCBpbnN0YW5jZW9mIFgmJmQubGVmdCBpbnN0YW5jZW9mIFopcmV0dXJuIG5ldyBYKGQubGVmdC5rZXksZC5sZWZ0Lm8sbmV3IFooYSxiLGMsZC5sZWZ0LmxlZnQsbnVsbCksemcoZC5rZXksZC5vLGQubGVmdC5yaWdodCxkLnJpZ2h0Lm9iKCkpLG51bGwpO3Rocm93IEVycm9yKFwicmVkLWJsYWNrIHRyZWUgaW52YXJpYW50IHZpb2xhdGlvblwiKTt9XG52YXIgQ2c9ZnVuY3Rpb24gQmcoYixjLGQpe2Q9bnVsbCE9Yi5sZWZ0P0JnKGIubGVmdCxjLGQpOmQ7aWYoQWMoZCkpcmV0dXJuIEwuYj9MLmIoZCk6TC5jYWxsKG51bGwsZCk7dmFyIGU9Yi5rZXksZj1iLm87ZD1jLmM/Yy5jKGQsZSxmKTpjLmNhbGwobnVsbCxkLGUsZik7aWYoQWMoZCkpcmV0dXJuIEwuYj9MLmIoZCk6TC5jYWxsKG51bGwsZCk7Yj1udWxsIT1iLnJpZ2h0P0JnKGIucmlnaHQsYyxkKTpkO3JldHVybiBBYyhiKT9MLmI/TC5iKGIpOkwuY2FsbChudWxsLGIpOmJ9O2Z1bmN0aW9uIFooYSxiLGMsZCxlKXt0aGlzLmtleT1hO3RoaXMubz1iO3RoaXMubGVmdD1jO3RoaXMucmlnaHQ9ZDt0aGlzLnA9ZTt0aGlzLnE9MDt0aGlzLmo9MzI0MDIyMDd9az1aLnByb3RvdHlwZTtrLk1iPWZ1bmN0aW9uKGEpe3JldHVybiBhLk9iKHRoaXMpfTtrLm9iPWZ1bmN0aW9uKCl7cmV0dXJuIG5ldyBYKHRoaXMua2V5LHRoaXMubyx0aGlzLmxlZnQsdGhpcy5yaWdodCxudWxsKX07XG5rLnVhPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXN9O2suTGI9ZnVuY3Rpb24oYSl7cmV0dXJuIGEuTmIodGhpcyl9O2sucmVwbGFjZT1mdW5jdGlvbihhLGIsYyxkKXtyZXR1cm4gbmV3IFooYSxiLGMsZCxudWxsKX07ay5OYj1mdW5jdGlvbihhKXtyZXR1cm4gbmV3IFooYS5rZXksYS5vLHRoaXMsYS5yaWdodCxudWxsKX07ay5PYj1mdW5jdGlvbihhKXtyZXR1cm4gbmV3IFooYS5rZXksYS5vLGEubGVmdCx0aGlzLG51bGwpfTtrLlhhPWZ1bmN0aW9uKGEsYil7cmV0dXJuIENnKHRoaXMsYSxiKX07ay50PWZ1bmN0aW9uKGEsYil7cmV0dXJuIEMuYyh0aGlzLGIsbnVsbCl9O2sucz1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIEMuYyh0aGlzLGIsYyl9O2suUT1mdW5jdGlvbihhLGIpe3JldHVybiAwPT09Yj90aGlzLmtleToxPT09Yj90aGlzLm86bnVsbH07ay4kPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gMD09PWI/dGhpcy5rZXk6MT09PWI/dGhpcy5vOmN9O1xuay5VYT1mdW5jdGlvbihhLGIsYyl7cmV0dXJuKG5ldyBXKG51bGwsMiw1LHVmLFt0aGlzLmtleSx0aGlzLm9dLG51bGwpKS5VYShudWxsLGIsYyl9O2suSD1mdW5jdGlvbigpe3JldHVybiBudWxsfTtrLkw9ZnVuY3Rpb24oKXtyZXR1cm4gMn07ay5oYj1mdW5jdGlvbigpe3JldHVybiB0aGlzLmtleX07ay5pYj1mdW5jdGlvbigpe3JldHVybiB0aGlzLm99O2suTGE9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5vfTtrLk1hPWZ1bmN0aW9uKCl7cmV0dXJuIG5ldyBXKG51bGwsMSw1LHVmLFt0aGlzLmtleV0sbnVsbCl9O2suQj1mdW5jdGlvbigpe3ZhciBhPXRoaXMucDtyZXR1cm4gbnVsbCE9YT9hOnRoaXMucD1hPXdjKHRoaXMpfTtrLkE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gSWModGhpcyxiKX07ay5KPWZ1bmN0aW9uKCl7cmV0dXJuIE1jfTtrLlI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gQ2MuYSh0aGlzLGIpfTtrLk89ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBDYy5jKHRoaXMsYixjKX07XG5rLkthPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gUmMuYyhuZXcgVyhudWxsLDIsNSx1ZixbdGhpcy5rZXksdGhpcy5vXSxudWxsKSxiLGMpfTtrLkQ9ZnVuY3Rpb24oKXtyZXR1cm4gUmEoUmEoSix0aGlzLm8pLHRoaXMua2V5KX07ay5GPWZ1bmN0aW9uKGEsYil7cmV0dXJuIE8obmV3IFcobnVsbCwyLDUsdWYsW3RoaXMua2V5LHRoaXMub10sbnVsbCksYil9O2suRz1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgVyhudWxsLDMsNSx1ZixbdGhpcy5rZXksdGhpcy5vLGJdLG51bGwpfTtcbmsuY2FsbD1mdW5jdGlvbigpe3ZhciBhPW51bGwsYT1mdW5jdGlvbihhLGMsZCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gdGhpcy50KG51bGwsYyk7Y2FzZSAzOnJldHVybiB0aGlzLnMobnVsbCxjLGQpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTthLmE9ZnVuY3Rpb24oYSxjKXtyZXR1cm4gdGhpcy50KG51bGwsYyl9O2EuYz1mdW5jdGlvbihhLGMsZCl7cmV0dXJuIHRoaXMucyhudWxsLGMsZCl9O3JldHVybiBhfSgpO2suYXBwbHk9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gdGhpcy5jYWxsLmFwcGx5KHRoaXMsW3RoaXNdLmNvbmNhdChGYShiKSkpfTtrLmI9ZnVuY3Rpb24oYSl7cmV0dXJuIHRoaXMudChudWxsLGEpfTtrLmE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gdGhpcy5zKG51bGwsYSxiKX07Wi5wcm90b3R5cGVbRWFdPWZ1bmN0aW9uKCl7cmV0dXJuIHVjKHRoaXMpfTtcbmZ1bmN0aW9uIFgoYSxiLGMsZCxlKXt0aGlzLmtleT1hO3RoaXMubz1iO3RoaXMubGVmdD1jO3RoaXMucmlnaHQ9ZDt0aGlzLnA9ZTt0aGlzLnE9MDt0aGlzLmo9MzI0MDIyMDd9az1YLnByb3RvdHlwZTtrLk1iPWZ1bmN0aW9uKGEpe3JldHVybiBuZXcgWCh0aGlzLmtleSx0aGlzLm8sdGhpcy5sZWZ0LGEsbnVsbCl9O2sub2I9ZnVuY3Rpb24oKXt0aHJvdyBFcnJvcihcInJlZC1ibGFjayB0cmVlIGludmFyaWFudCB2aW9sYXRpb25cIik7fTtrLnVhPWZ1bmN0aW9uKCl7cmV0dXJuIG5ldyBaKHRoaXMua2V5LHRoaXMubyx0aGlzLmxlZnQsdGhpcy5yaWdodCxudWxsKX07ay5MYj1mdW5jdGlvbihhKXtyZXR1cm4gbmV3IFgodGhpcy5rZXksdGhpcy5vLGEsdGhpcy5yaWdodCxudWxsKX07ay5yZXBsYWNlPWZ1bmN0aW9uKGEsYixjLGQpe3JldHVybiBuZXcgWChhLGIsYyxkLG51bGwpfTtcbmsuTmI9ZnVuY3Rpb24oYSl7cmV0dXJuIHRoaXMubGVmdCBpbnN0YW5jZW9mIFg/bmV3IFgodGhpcy5rZXksdGhpcy5vLHRoaXMubGVmdC51YSgpLG5ldyBaKGEua2V5LGEubyx0aGlzLnJpZ2h0LGEucmlnaHQsbnVsbCksbnVsbCk6dGhpcy5yaWdodCBpbnN0YW5jZW9mIFg/bmV3IFgodGhpcy5yaWdodC5rZXksdGhpcy5yaWdodC5vLG5ldyBaKHRoaXMua2V5LHRoaXMubyx0aGlzLmxlZnQsdGhpcy5yaWdodC5sZWZ0LG51bGwpLG5ldyBaKGEua2V5LGEubyx0aGlzLnJpZ2h0LnJpZ2h0LGEucmlnaHQsbnVsbCksbnVsbCk6bmV3IFooYS5rZXksYS5vLHRoaXMsYS5yaWdodCxudWxsKX07XG5rLk9iPWZ1bmN0aW9uKGEpe3JldHVybiB0aGlzLnJpZ2h0IGluc3RhbmNlb2YgWD9uZXcgWCh0aGlzLmtleSx0aGlzLm8sbmV3IFooYS5rZXksYS5vLGEubGVmdCx0aGlzLmxlZnQsbnVsbCksdGhpcy5yaWdodC51YSgpLG51bGwpOnRoaXMubGVmdCBpbnN0YW5jZW9mIFg/bmV3IFgodGhpcy5sZWZ0LmtleSx0aGlzLmxlZnQubyxuZXcgWihhLmtleSxhLm8sYS5sZWZ0LHRoaXMubGVmdC5sZWZ0LG51bGwpLG5ldyBaKHRoaXMua2V5LHRoaXMubyx0aGlzLmxlZnQucmlnaHQsdGhpcy5yaWdodCxudWxsKSxudWxsKTpuZXcgWihhLmtleSxhLm8sYS5sZWZ0LHRoaXMsbnVsbCl9O2suWGE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gQ2codGhpcyxhLGIpfTtrLnQ9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gQy5jKHRoaXMsYixudWxsKX07ay5zPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gQy5jKHRoaXMsYixjKX07XG5rLlE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gMD09PWI/dGhpcy5rZXk6MT09PWI/dGhpcy5vOm51bGx9O2suJD1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIDA9PT1iP3RoaXMua2V5OjE9PT1iP3RoaXMubzpjfTtrLlVhPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4obmV3IFcobnVsbCwyLDUsdWYsW3RoaXMua2V5LHRoaXMub10sbnVsbCkpLlVhKG51bGwsYixjKX07ay5IPWZ1bmN0aW9uKCl7cmV0dXJuIG51bGx9O2suTD1mdW5jdGlvbigpe3JldHVybiAyfTtrLmhiPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMua2V5fTtrLmliPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMub307ay5MYT1mdW5jdGlvbigpe3JldHVybiB0aGlzLm99O2suTWE9ZnVuY3Rpb24oKXtyZXR1cm4gbmV3IFcobnVsbCwxLDUsdWYsW3RoaXMua2V5XSxudWxsKX07ay5CPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5wO3JldHVybiBudWxsIT1hP2E6dGhpcy5wPWE9d2ModGhpcyl9O1xuay5BPWZ1bmN0aW9uKGEsYil7cmV0dXJuIEljKHRoaXMsYil9O2suSj1mdW5jdGlvbigpe3JldHVybiBNY307ay5SPWZ1bmN0aW9uKGEsYil7cmV0dXJuIENjLmEodGhpcyxiKX07ay5PPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gQ2MuYyh0aGlzLGIsYyl9O2suS2E9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBSYy5jKG5ldyBXKG51bGwsMiw1LHVmLFt0aGlzLmtleSx0aGlzLm9dLG51bGwpLGIsYyl9O2suRD1mdW5jdGlvbigpe3JldHVybiBSYShSYShKLHRoaXMubyksdGhpcy5rZXkpfTtrLkY9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gTyhuZXcgVyhudWxsLDIsNSx1ZixbdGhpcy5rZXksdGhpcy5vXSxudWxsKSxiKX07ay5HPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyBXKG51bGwsMyw1LHVmLFt0aGlzLmtleSx0aGlzLm8sYl0sbnVsbCl9O1xuay5jYWxsPWZ1bmN0aW9uKCl7dmFyIGE9bnVsbCxhPWZ1bmN0aW9uKGEsYyxkKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiB0aGlzLnQobnVsbCxjKTtjYXNlIDM6cmV0dXJuIHRoaXMucyhudWxsLGMsZCl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2EuYT1mdW5jdGlvbihhLGMpe3JldHVybiB0aGlzLnQobnVsbCxjKX07YS5jPWZ1bmN0aW9uKGEsYyxkKXtyZXR1cm4gdGhpcy5zKG51bGwsYyxkKX07cmV0dXJuIGF9KCk7ay5hcHBseT1mdW5jdGlvbihhLGIpe3JldHVybiB0aGlzLmNhbGwuYXBwbHkodGhpcyxbdGhpc10uY29uY2F0KEZhKGIpKSl9O2suYj1mdW5jdGlvbihhKXtyZXR1cm4gdGhpcy50KG51bGwsYSl9O2suYT1mdW5jdGlvbihhLGIpe3JldHVybiB0aGlzLnMobnVsbCxhLGIpfTtYLnByb3RvdHlwZVtFYV09ZnVuY3Rpb24oKXtyZXR1cm4gdWModGhpcyl9O1xudmFyIEVnPWZ1bmN0aW9uIERnKGIsYyxkLGUsZil7aWYobnVsbD09YylyZXR1cm4gbmV3IFgoZCxlLG51bGwsbnVsbCxudWxsKTt2YXIgZztnPWMua2V5O2c9Yi5hP2IuYShkLGcpOmIuY2FsbChudWxsLGQsZyk7aWYoMD09PWcpcmV0dXJuIGZbMF09YyxudWxsO2lmKDA+ZylyZXR1cm4gYj1EZyhiLGMubGVmdCxkLGUsZiksbnVsbCE9Yj9jLkxiKGIpOm51bGw7Yj1EZyhiLGMucmlnaHQsZCxlLGYpO3JldHVybiBudWxsIT1iP2MuTWIoYik6bnVsbH0sR2c9ZnVuY3Rpb24gRmcoYixjKXtpZihudWxsPT1iKXJldHVybiBjO2lmKG51bGw9PWMpcmV0dXJuIGI7aWYoYiBpbnN0YW5jZW9mIFgpe2lmKGMgaW5zdGFuY2VvZiBYKXt2YXIgZD1GZyhiLnJpZ2h0LGMubGVmdCk7cmV0dXJuIGQgaW5zdGFuY2VvZiBYP25ldyBYKGQua2V5LGQubyxuZXcgWChiLmtleSxiLm8sYi5sZWZ0LGQubGVmdCxudWxsKSxuZXcgWChjLmtleSxjLm8sZC5yaWdodCxjLnJpZ2h0LG51bGwpLG51bGwpOm5ldyBYKGIua2V5LFxuYi5vLGIubGVmdCxuZXcgWChjLmtleSxjLm8sZCxjLnJpZ2h0LG51bGwpLG51bGwpfXJldHVybiBuZXcgWChiLmtleSxiLm8sYi5sZWZ0LEZnKGIucmlnaHQsYyksbnVsbCl9aWYoYyBpbnN0YW5jZW9mIFgpcmV0dXJuIG5ldyBYKGMua2V5LGMubyxGZyhiLGMubGVmdCksYy5yaWdodCxudWxsKTtkPUZnKGIucmlnaHQsYy5sZWZ0KTtyZXR1cm4gZCBpbnN0YW5jZW9mIFg/bmV3IFgoZC5rZXksZC5vLG5ldyBaKGIua2V5LGIubyxiLmxlZnQsZC5sZWZ0LG51bGwpLG5ldyBaKGMua2V5LGMubyxkLnJpZ2h0LGMucmlnaHQsbnVsbCksbnVsbCk6QWcoYi5rZXksYi5vLGIubGVmdCxuZXcgWihjLmtleSxjLm8sZCxjLnJpZ2h0LG51bGwpKX0sSWc9ZnVuY3Rpb24gSGcoYixjLGQsZSl7aWYobnVsbCE9Yyl7dmFyIGY7Zj1jLmtleTtmPWIuYT9iLmEoZCxmKTpiLmNhbGwobnVsbCxkLGYpO2lmKDA9PT1mKXJldHVybiBlWzBdPWMsR2coYy5sZWZ0LGMucmlnaHQpO2lmKDA+ZilyZXR1cm4gYj1IZyhiLFxuYy5sZWZ0LGQsZSksbnVsbCE9Ynx8bnVsbCE9ZVswXT9jLmxlZnQgaW5zdGFuY2VvZiBaP0FnKGMua2V5LGMubyxiLGMucmlnaHQpOm5ldyBYKGMua2V5LGMubyxiLGMucmlnaHQsbnVsbCk6bnVsbDtiPUhnKGIsYy5yaWdodCxkLGUpO2lmKG51bGwhPWJ8fG51bGwhPWVbMF0paWYoYy5yaWdodCBpbnN0YW5jZW9mIFopaWYoZT1jLmtleSxkPWMubyxjPWMubGVmdCxiIGluc3RhbmNlb2YgWCljPW5ldyBYKGUsZCxjLGIudWEoKSxudWxsKTtlbHNlIGlmKGMgaW5zdGFuY2VvZiBaKWM9eWcoZSxkLGMub2IoKSxiKTtlbHNlIGlmKGMgaW5zdGFuY2VvZiBYJiZjLnJpZ2h0IGluc3RhbmNlb2YgWiljPW5ldyBYKGMucmlnaHQua2V5LGMucmlnaHQubyx5ZyhjLmtleSxjLm8sYy5sZWZ0Lm9iKCksYy5yaWdodC5sZWZ0KSxuZXcgWihlLGQsYy5yaWdodC5yaWdodCxiLG51bGwpLG51bGwpO2Vsc2UgdGhyb3cgRXJyb3IoXCJyZWQtYmxhY2sgdHJlZSBpbnZhcmlhbnQgdmlvbGF0aW9uXCIpO2Vsc2UgYz1cbm5ldyBYKGMua2V5LGMubyxjLmxlZnQsYixudWxsKTtlbHNlIGM9bnVsbDtyZXR1cm4gY31yZXR1cm4gbnVsbH0sS2c9ZnVuY3Rpb24gSmcoYixjLGQsZSl7dmFyIGY9Yy5rZXksZz1iLmE/Yi5hKGQsZik6Yi5jYWxsKG51bGwsZCxmKTtyZXR1cm4gMD09PWc/Yy5yZXBsYWNlKGYsZSxjLmxlZnQsYy5yaWdodCk6MD5nP2MucmVwbGFjZShmLGMubyxKZyhiLGMubGVmdCxkLGUpLGMucmlnaHQpOmMucmVwbGFjZShmLGMubyxjLmxlZnQsSmcoYixjLnJpZ2h0LGQsZSkpfTtmdW5jdGlvbiBMZyhhLGIsYyxkLGUpe3RoaXMuYWE9YTt0aGlzLm5hPWI7dGhpcy5nPWM7dGhpcy5rPWQ7dGhpcy5wPWU7dGhpcy5qPTQxODc3Njg0Nzt0aGlzLnE9ODE5Mn1rPUxnLnByb3RvdHlwZTtrLnRvU3RyaW5nPWZ1bmN0aW9uKCl7cmV0dXJuIGVjKHRoaXMpfTtcbmZ1bmN0aW9uIE1nKGEsYil7Zm9yKHZhciBjPWEubmE7OylpZihudWxsIT1jKXt2YXIgZDtkPWMua2V5O2Q9YS5hYS5hP2EuYWEuYShiLGQpOmEuYWEuY2FsbChudWxsLGIsZCk7aWYoMD09PWQpcmV0dXJuIGM7Yz0wPmQ/Yy5sZWZ0OmMucmlnaHR9ZWxzZSByZXR1cm4gbnVsbH1rLnQ9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gJGEuYyh0aGlzLGIsbnVsbCl9O2sucz1mdW5jdGlvbihhLGIsYyl7YT1NZyh0aGlzLGIpO3JldHVybiBudWxsIT1hP2EubzpjfTtrLmdiPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gbnVsbCE9dGhpcy5uYT9DZyh0aGlzLm5hLGIsYyk6Y307ay5IPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMua307ay5MPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuZ307ay5hYj1mdW5jdGlvbigpe3JldHVybiAwPHRoaXMuZz94Zyh0aGlzLm5hLCExLHRoaXMuZyk6bnVsbH07ay5CPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5wO3JldHVybiBudWxsIT1hP2E6dGhpcy5wPWE9eGModGhpcyl9O1xuay5BPWZ1bmN0aW9uKGEsYil7cmV0dXJuIFBmKHRoaXMsYil9O2suSj1mdW5jdGlvbigpe3JldHVybiBuZXcgTGcodGhpcy5hYSxudWxsLDAsdGhpcy5rLDApfTtrLndiPWZ1bmN0aW9uKGEsYil7dmFyIGM9W251bGxdLGQ9SWcodGhpcy5hYSx0aGlzLm5hLGIsYyk7cmV0dXJuIG51bGw9PWQ/bnVsbD09Ui5hKGMsMCk/dGhpczpuZXcgTGcodGhpcy5hYSxudWxsLDAsdGhpcy5rLG51bGwpOm5ldyBMZyh0aGlzLmFhLGQudWEoKSx0aGlzLmctMSx0aGlzLmssbnVsbCl9O2suS2E9ZnVuY3Rpb24oYSxiLGMpe2E9W251bGxdO3ZhciBkPUVnKHRoaXMuYWEsdGhpcy5uYSxiLGMsYSk7cmV0dXJuIG51bGw9PWQ/KGE9Ui5hKGEsMCksc2MuYShjLGEubyk/dGhpczpuZXcgTGcodGhpcy5hYSxLZyh0aGlzLmFhLHRoaXMubmEsYixjKSx0aGlzLmcsdGhpcy5rLG51bGwpKTpuZXcgTGcodGhpcy5hYSxkLnVhKCksdGhpcy5nKzEsdGhpcy5rLG51bGwpfTtcbmsucmI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbnVsbCE9TWcodGhpcyxiKX07ay5EPWZ1bmN0aW9uKCl7cmV0dXJuIDA8dGhpcy5nP3hnKHRoaXMubmEsITAsdGhpcy5nKTpudWxsfTtrLkY9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IExnKHRoaXMuYWEsdGhpcy5uYSx0aGlzLmcsYix0aGlzLnApfTtrLkc9ZnVuY3Rpb24oYSxiKXtpZihlZChiKSlyZXR1cm4gY2IodGhpcyxDLmEoYiwwKSxDLmEoYiwxKSk7Zm9yKHZhciBjPXRoaXMsZD1EKGIpOzspe2lmKG51bGw9PWQpcmV0dXJuIGM7dmFyIGU9RyhkKTtpZihlZChlKSljPWNiKGMsQy5hKGUsMCksQy5hKGUsMSkpLGQ9SyhkKTtlbHNlIHRocm93IEVycm9yKFwiY29uaiBvbiBhIG1hcCB0YWtlcyBtYXAgZW50cmllcyBvciBzZXFhYmxlcyBvZiBtYXAgZW50cmllc1wiKTt9fTtcbmsuY2FsbD1mdW5jdGlvbigpe3ZhciBhPW51bGwsYT1mdW5jdGlvbihhLGMsZCl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gdGhpcy50KG51bGwsYyk7Y2FzZSAzOnJldHVybiB0aGlzLnMobnVsbCxjLGQpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTthLmE9ZnVuY3Rpb24oYSxjKXtyZXR1cm4gdGhpcy50KG51bGwsYyl9O2EuYz1mdW5jdGlvbihhLGMsZCl7cmV0dXJuIHRoaXMucyhudWxsLGMsZCl9O3JldHVybiBhfSgpO2suYXBwbHk9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gdGhpcy5jYWxsLmFwcGx5KHRoaXMsW3RoaXNdLmNvbmNhdChGYShiKSkpfTtrLmI9ZnVuY3Rpb24oYSl7cmV0dXJuIHRoaXMudChudWxsLGEpfTtrLmE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gdGhpcy5zKG51bGwsYSxiKX07ay5IYj1mdW5jdGlvbihhLGIpe3JldHVybiAwPHRoaXMuZz94Zyh0aGlzLm5hLGIsdGhpcy5nKTpudWxsfTtcbmsuSWI9ZnVuY3Rpb24oYSxiLGMpe2lmKDA8dGhpcy5nKXthPW51bGw7Zm9yKHZhciBkPXRoaXMubmE7OylpZihudWxsIT1kKXt2YXIgZTtlPWQua2V5O2U9dGhpcy5hYS5hP3RoaXMuYWEuYShiLGUpOnRoaXMuYWEuY2FsbChudWxsLGIsZSk7aWYoMD09PWUpcmV0dXJuIG5ldyB3ZyhudWxsLE5jLmEoYSxkKSxjLC0xLG51bGwpO3QoYyk/MD5lPyhhPU5jLmEoYSxkKSxkPWQubGVmdCk6ZD1kLnJpZ2h0OjA8ZT8oYT1OYy5hKGEsZCksZD1kLnJpZ2h0KTpkPWQubGVmdH1lbHNlIHJldHVybiBudWxsPT1hP251bGw6bmV3IHdnKG51bGwsYSxjLC0xLG51bGwpfWVsc2UgcmV0dXJuIG51bGx9O2suR2I9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gWWYuYj9ZZi5iKGIpOllmLmNhbGwobnVsbCxiKX07ay5GYj1mdW5jdGlvbigpe3JldHVybiB0aGlzLmFhfTt2YXIgTmc9bmV3IExnKG9kLG51bGwsMCxudWxsLDApO0xnLnByb3RvdHlwZVtFYV09ZnVuY3Rpb24oKXtyZXR1cm4gdWModGhpcyl9O1xudmFyIE9nPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhKXt2YXIgZD1udWxsO2lmKDA8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBkPTAsZT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTApO2Q8ZS5sZW5ndGg7KWVbZF09YXJndW1lbnRzW2QrMF0sKytkO2Q9bmV3IEYoZSwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsZCl9ZnVuY3Rpb24gYihhKXthPUQoYSk7Zm9yKHZhciBiPU9iKFFjKTs7KWlmKGEpe3ZhciBlPUsoSyhhKSksYj1lZS5jKGIsRyhhKSxMYyhhKSk7YT1lfWVsc2UgcmV0dXJuIFFiKGIpfWEuaT0wO2EuZj1mdW5jdGlvbihhKXthPUQoYSk7cmV0dXJuIGIoYSl9O2EuZD1iO3JldHVybiBhfSgpLFBnPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhKXt2YXIgZD1udWxsO2lmKDA8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBkPTAsZT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTApO2Q8ZS5sZW5ndGg7KWVbZF09YXJndW1lbnRzW2QrMF0sKytkO2Q9bmV3IEYoZSwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsXG5kKX1mdW5jdGlvbiBiKGEpe2E6e2E9VC5hKEhhLGEpO2Zvcih2YXIgYj1hLmxlbmd0aCxlPTAsZj1PYihVZik7OylpZihlPGIpdmFyIGc9ZSsyLGY9UmIoZixhW2VdLGFbZSsxXSksZT1nO2Vsc2V7YT1RYihmKTticmVhayBhfWE9dm9pZCAwfXJldHVybiBhfWEuaT0wO2EuZj1mdW5jdGlvbihhKXthPUQoYSk7cmV0dXJuIGIoYSl9O2EuZD1iO3JldHVybiBhfSgpLFFnPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhKXt2YXIgZD1udWxsO2lmKDA8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBkPTAsZT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTApO2Q8ZS5sZW5ndGg7KWVbZF09YXJndW1lbnRzW2QrMF0sKytkO2Q9bmV3IEYoZSwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsZCl9ZnVuY3Rpb24gYihhKXthPUQoYSk7Zm9yKHZhciBiPU5nOzspaWYoYSl7dmFyIGU9SyhLKGEpKSxiPVJjLmMoYixHKGEpLExjKGEpKTthPWV9ZWxzZSByZXR1cm4gYn1hLmk9MDthLmY9ZnVuY3Rpb24oYSl7YT1EKGEpO1xucmV0dXJuIGIoYSl9O2EuZD1iO3JldHVybiBhfSgpLFJnPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGQpe3ZhciBlPW51bGw7aWYoMTxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGU9MCxmPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMSk7ZTxmLmxlbmd0aDspZltlXT1hcmd1bWVudHNbZSsxXSwrK2U7ZT1uZXcgRihmLDApfXJldHVybiBiLmNhbGwodGhpcyxhLGUpfWZ1bmN0aW9uIGIoYSxiKXtmb3IodmFyIGU9RChiKSxmPW5ldyBMZyhxZChhKSxudWxsLDAsbnVsbCwwKTs7KWlmKGUpdmFyIGc9SyhLKGUpKSxmPVJjLmMoZixHKGUpLExjKGUpKSxlPWc7ZWxzZSByZXR1cm4gZn1hLmk9MTthLmY9ZnVuY3Rpb24oYSl7dmFyIGQ9RyhhKTthPUgoYSk7cmV0dXJuIGIoZCxhKX07YS5kPWI7cmV0dXJuIGF9KCk7ZnVuY3Rpb24gU2coYSxiKXt0aGlzLlk9YTt0aGlzLlo9Yjt0aGlzLnE9MDt0aGlzLmo9MzIzNzQ5ODh9az1TZy5wcm90b3R5cGU7ay50b1N0cmluZz1mdW5jdGlvbigpe3JldHVybiBlYyh0aGlzKX07XG5rLkg9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5afTtrLlQ9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLlksYT0oYT9hLmomMTI4fHxhLnhifHwoYS5qPzA6dyhYYSxhKSk6dyhYYSxhKSk/dGhpcy5ZLlQobnVsbCk6Syh0aGlzLlkpO3JldHVybiBudWxsPT1hP251bGw6bmV3IFNnKGEsdGhpcy5aKX07ay5CPWZ1bmN0aW9uKCl7cmV0dXJuIHdjKHRoaXMpfTtrLkE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gSWModGhpcyxiKX07ay5KPWZ1bmN0aW9uKCl7cmV0dXJuIE8oSix0aGlzLlopfTtrLlI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gUC5hKGIsdGhpcyl9O2suTz1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIFAuYyhiLGMsdGhpcyl9O2suTj1mdW5jdGlvbigpe3JldHVybiB0aGlzLlkuTihudWxsKS5oYihudWxsKX07XG5rLlM9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLlksYT0oYT9hLmomMTI4fHxhLnhifHwoYS5qPzA6dyhYYSxhKSk6dyhYYSxhKSk/dGhpcy5ZLlQobnVsbCk6Syh0aGlzLlkpO3JldHVybiBudWxsIT1hP25ldyBTZyhhLHRoaXMuWik6Sn07ay5EPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXN9O2suRj1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgU2codGhpcy5ZLGIpfTtrLkc9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gTShiLHRoaXMpfTtTZy5wcm90b3R5cGVbRWFdPWZ1bmN0aW9uKCl7cmV0dXJuIHVjKHRoaXMpfTtmdW5jdGlvbiBUZyhhKXtyZXR1cm4oYT1EKGEpKT9uZXcgU2coYSxudWxsKTpudWxsfWZ1bmN0aW9uIFlmKGEpe3JldHVybiBoYihhKX1mdW5jdGlvbiBVZyhhLGIpe3RoaXMuWT1hO3RoaXMuWj1iO3RoaXMucT0wO3RoaXMuaj0zMjM3NDk4OH1rPVVnLnByb3RvdHlwZTtrLnRvU3RyaW5nPWZ1bmN0aW9uKCl7cmV0dXJuIGVjKHRoaXMpfTtrLkg9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5afTtcbmsuVD1mdW5jdGlvbigpe3ZhciBhPXRoaXMuWSxhPShhP2EuaiYxMjh8fGEueGJ8fChhLmo/MDp3KFhhLGEpKTp3KFhhLGEpKT90aGlzLlkuVChudWxsKTpLKHRoaXMuWSk7cmV0dXJuIG51bGw9PWE/bnVsbDpuZXcgVWcoYSx0aGlzLlopfTtrLkI9ZnVuY3Rpb24oKXtyZXR1cm4gd2ModGhpcyl9O2suQT1mdW5jdGlvbihhLGIpe3JldHVybiBJYyh0aGlzLGIpfTtrLko9ZnVuY3Rpb24oKXtyZXR1cm4gTyhKLHRoaXMuWil9O2suUj1mdW5jdGlvbihhLGIpe3JldHVybiBQLmEoYix0aGlzKX07ay5PPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gUC5jKGIsYyx0aGlzKX07ay5OPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuWS5OKG51bGwpLmliKG51bGwpfTtrLlM9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLlksYT0oYT9hLmomMTI4fHxhLnhifHwoYS5qPzA6dyhYYSxhKSk6dyhYYSxhKSk/dGhpcy5ZLlQobnVsbCk6Syh0aGlzLlkpO3JldHVybiBudWxsIT1hP25ldyBVZyhhLHRoaXMuWik6Sn07XG5rLkQ9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpc307ay5GPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyBVZyh0aGlzLlksYil9O2suRz1mdW5jdGlvbihhLGIpe3JldHVybiBNKGIsdGhpcyl9O1VnLnByb3RvdHlwZVtFYV09ZnVuY3Rpb24oKXtyZXR1cm4gdWModGhpcyl9O2Z1bmN0aW9uIFZnKGEpe3JldHVybihhPUQoYSkpP25ldyBVZyhhLG51bGwpOm51bGx9ZnVuY3Rpb24gWmYoYSl7cmV0dXJuIGliKGEpfVxudmFyIFdnPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhKXt2YXIgZD1udWxsO2lmKDA8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBkPTAsZT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTApO2Q8ZS5sZW5ndGg7KWVbZF09YXJndW1lbnRzW2QrMF0sKytkO2Q9bmV3IEYoZSwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsZCl9ZnVuY3Rpb24gYihhKXtyZXR1cm4gdChGZSh1ZCxhKSk/QS5hKGZ1bmN0aW9uKGEsYil7cmV0dXJuIE5jLmEodChhKT9hOlVmLGIpfSxhKTpudWxsfWEuaT0wO2EuZj1mdW5jdGlvbihhKXthPUQoYSk7cmV0dXJuIGIoYSl9O2EuZD1iO3JldHVybiBhfSgpLFhnPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGQpe3ZhciBlPW51bGw7aWYoMTxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGU9MCxmPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMSk7ZTxmLmxlbmd0aDspZltlXT1hcmd1bWVudHNbZSsxXSwrK2U7ZT1uZXcgRihmLDApfXJldHVybiBiLmNhbGwodGhpcyxhLGUpfWZ1bmN0aW9uIGIoYSxcbmIpe3JldHVybiB0KEZlKHVkLGIpKT9BLmEoZnVuY3Rpb24oYSl7cmV0dXJuIGZ1bmN0aW9uKGIsYyl7cmV0dXJuIEEuYyhhLHQoYik/YjpVZixEKGMpKX19KGZ1bmN0aW9uKGIsZCl7dmFyIGc9RyhkKSxoPUxjKGQpO3JldHVybiBuZChiLGcpP1JjLmMoYixnLGZ1bmN0aW9uKCl7dmFyIGQ9Uy5hKGIsZyk7cmV0dXJuIGEuYT9hLmEoZCxoKTphLmNhbGwobnVsbCxkLGgpfSgpKTpSYy5jKGIsZyxoKX0pLGIpOm51bGx9YS5pPTE7YS5mPWZ1bmN0aW9uKGEpe3ZhciBkPUcoYSk7YT1IKGEpO3JldHVybiBiKGQsYSl9O2EuZD1iO3JldHVybiBhfSgpO2Z1bmN0aW9uIFlnKGEsYil7Zm9yKHZhciBjPVVmLGQ9RChiKTs7KWlmKGQpdmFyIGU9RyhkKSxmPVMuYyhhLGUsWmcpLGM9amUuYShmLFpnKT9SYy5jKGMsZSxmKTpjLGQ9SyhkKTtlbHNlIHJldHVybiBPKGMsVmMoYSkpfVxuZnVuY3Rpb24gJGcoYSxiLGMpe3RoaXMuaz1hO3RoaXMuV2E9Yjt0aGlzLnA9Yzt0aGlzLmo9MTUwNzc2NDc7dGhpcy5xPTgxOTZ9az0kZy5wcm90b3R5cGU7ay50b1N0cmluZz1mdW5jdGlvbigpe3JldHVybiBlYyh0aGlzKX07ay50PWZ1bmN0aW9uKGEsYil7cmV0dXJuICRhLmModGhpcyxiLG51bGwpfTtrLnM9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiBiYih0aGlzLldhLGIpP2I6Y307ay5IPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMua307ay5MPWZ1bmN0aW9uKCl7cmV0dXJuIE1hKHRoaXMuV2EpfTtrLkI9ZnVuY3Rpb24oKXt2YXIgYT10aGlzLnA7cmV0dXJuIG51bGwhPWE/YTp0aGlzLnA9YT14Yyh0aGlzKX07ay5BPWZ1bmN0aW9uKGEsYil7cmV0dXJuIGFkKGIpJiZRKHRoaXMpPT09UShiKSYmRWUoZnVuY3Rpb24oYSl7cmV0dXJuIGZ1bmN0aW9uKGIpe3JldHVybiBuZChhLGIpfX0odGhpcyksYil9O2suJGE9ZnVuY3Rpb24oKXtyZXR1cm4gbmV3IGFoKE9iKHRoaXMuV2EpKX07XG5rLko9ZnVuY3Rpb24oKXtyZXR1cm4gTyhiaCx0aGlzLmspfTtrLkViPWZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyAkZyh0aGlzLmssZWIodGhpcy5XYSxiKSxudWxsKX07ay5EPWZ1bmN0aW9uKCl7cmV0dXJuIFRnKHRoaXMuV2EpfTtrLkY9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3ICRnKGIsdGhpcy5XYSx0aGlzLnApfTtrLkc9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3ICRnKHRoaXMuayxSYy5jKHRoaXMuV2EsYixudWxsKSxudWxsKX07XG5rLmNhbGw9ZnVuY3Rpb24oKXt2YXIgYT1udWxsLGE9ZnVuY3Rpb24oYSxjLGQpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIHRoaXMudChudWxsLGMpO2Nhc2UgMzpyZXR1cm4gdGhpcy5zKG51bGwsYyxkKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307YS5hPWZ1bmN0aW9uKGEsYyl7cmV0dXJuIHRoaXMudChudWxsLGMpfTthLmM9ZnVuY3Rpb24oYSxjLGQpe3JldHVybiB0aGlzLnMobnVsbCxjLGQpfTtyZXR1cm4gYX0oKTtrLmFwcGx5PWZ1bmN0aW9uKGEsYil7cmV0dXJuIHRoaXMuY2FsbC5hcHBseSh0aGlzLFt0aGlzXS5jb25jYXQoRmEoYikpKX07ay5iPWZ1bmN0aW9uKGEpe3JldHVybiB0aGlzLnQobnVsbCxhKX07ay5hPWZ1bmN0aW9uKGEsYil7cmV0dXJuIHRoaXMucyhudWxsLGEsYil9O3ZhciBiaD1uZXcgJGcobnVsbCxVZiwwKTskZy5wcm90b3R5cGVbRWFdPWZ1bmN0aW9uKCl7cmV0dXJuIHVjKHRoaXMpfTtcbmZ1bmN0aW9uIGFoKGEpe3RoaXMubWE9YTt0aGlzLmo9MjU5O3RoaXMucT0xMzZ9az1haC5wcm90b3R5cGU7ay5jYWxsPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyl7cmV0dXJuICRhLmModGhpcy5tYSxiLGpkKT09PWpkP2M6Yn1mdW5jdGlvbiBiKGEsYil7cmV0dXJuICRhLmModGhpcy5tYSxiLGpkKT09PWpkP251bGw6Yn12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIGIuY2FsbCh0aGlzLGMsZSk7Y2FzZSAzOnJldHVybiBhLmNhbGwodGhpcyxjLGUsZil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYT1iO2MuYz1hO3JldHVybiBjfSgpO2suYXBwbHk9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gdGhpcy5jYWxsLmFwcGx5KHRoaXMsW3RoaXNdLmNvbmNhdChGYShiKSkpfTtcbmsuYj1mdW5jdGlvbihhKXtyZXR1cm4gJGEuYyh0aGlzLm1hLGEsamQpPT09amQ/bnVsbDphfTtrLmE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gJGEuYyh0aGlzLm1hLGEsamQpPT09amQ/YjphfTtrLnQ9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gJGEuYyh0aGlzLGIsbnVsbCl9O2sucz1mdW5jdGlvbihhLGIsYyl7cmV0dXJuICRhLmModGhpcy5tYSxiLGpkKT09PWpkP2M6Yn07ay5MPWZ1bmN0aW9uKCl7cmV0dXJuIFEodGhpcy5tYSl9O2suVGI9ZnVuY3Rpb24oYSxiKXt0aGlzLm1hPWZlLmEodGhpcy5tYSxiKTtyZXR1cm4gdGhpc307ay5TYT1mdW5jdGlvbihhLGIpe3RoaXMubWE9ZWUuYyh0aGlzLm1hLGIsbnVsbCk7cmV0dXJuIHRoaXN9O2suVGE9ZnVuY3Rpb24oKXtyZXR1cm4gbmV3ICRnKG51bGwsUWIodGhpcy5tYSksbnVsbCl9O2Z1bmN0aW9uIGNoKGEsYixjKXt0aGlzLms9YTt0aGlzLmphPWI7dGhpcy5wPWM7dGhpcy5qPTQxNzczMDgzMTt0aGlzLnE9ODE5Mn1rPWNoLnByb3RvdHlwZTtcbmsudG9TdHJpbmc9ZnVuY3Rpb24oKXtyZXR1cm4gZWModGhpcyl9O2sudD1mdW5jdGlvbihhLGIpe3JldHVybiAkYS5jKHRoaXMsYixudWxsKX07ay5zPWZ1bmN0aW9uKGEsYixjKXthPU1nKHRoaXMuamEsYik7cmV0dXJuIG51bGwhPWE/YS5rZXk6Y307ay5IPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMua307ay5MPWZ1bmN0aW9uKCl7cmV0dXJuIFEodGhpcy5qYSl9O2suYWI9ZnVuY3Rpb24oKXtyZXR1cm4gMDxRKHRoaXMuamEpP09lLmEoWWYsR2IodGhpcy5qYSkpOm51bGx9O2suQj1mdW5jdGlvbigpe3ZhciBhPXRoaXMucDtyZXR1cm4gbnVsbCE9YT9hOnRoaXMucD1hPXhjKHRoaXMpfTtrLkE9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gYWQoYikmJlEodGhpcyk9PT1RKGIpJiZFZShmdW5jdGlvbihhKXtyZXR1cm4gZnVuY3Rpb24oYil7cmV0dXJuIG5kKGEsYil9fSh0aGlzKSxiKX07ay5KPWZ1bmN0aW9uKCl7cmV0dXJuIG5ldyBjaCh0aGlzLmssTmEodGhpcy5qYSksMCl9O1xuay5FYj1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgY2godGhpcy5rLFNjLmEodGhpcy5qYSxiKSxudWxsKX07ay5EPWZ1bmN0aW9uKCl7cmV0dXJuIFRnKHRoaXMuamEpfTtrLkY9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IGNoKGIsdGhpcy5qYSx0aGlzLnApfTtrLkc9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gbmV3IGNoKHRoaXMuayxSYy5jKHRoaXMuamEsYixudWxsKSxudWxsKX07ay5jYWxsPWZ1bmN0aW9uKCl7dmFyIGE9bnVsbCxhPWZ1bmN0aW9uKGEsYyxkKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAyOnJldHVybiB0aGlzLnQobnVsbCxjKTtjYXNlIDM6cmV0dXJuIHRoaXMucyhudWxsLGMsZCl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2EuYT1mdW5jdGlvbihhLGMpe3JldHVybiB0aGlzLnQobnVsbCxjKX07YS5jPWZ1bmN0aW9uKGEsYyxkKXtyZXR1cm4gdGhpcy5zKG51bGwsYyxkKX07cmV0dXJuIGF9KCk7XG5rLmFwcGx5PWZ1bmN0aW9uKGEsYil7cmV0dXJuIHRoaXMuY2FsbC5hcHBseSh0aGlzLFt0aGlzXS5jb25jYXQoRmEoYikpKX07ay5iPWZ1bmN0aW9uKGEpe3JldHVybiB0aGlzLnQobnVsbCxhKX07ay5hPWZ1bmN0aW9uKGEsYil7cmV0dXJuIHRoaXMucyhudWxsLGEsYil9O2suSGI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gT2UuYShZZixIYih0aGlzLmphLGIpKX07ay5JYj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIE9lLmEoWWYsSWIodGhpcy5qYSxiLGMpKX07ay5HYj1mdW5jdGlvbihhLGIpe3JldHVybiBifTtrLkZiPWZ1bmN0aW9uKCl7cmV0dXJuIEtiKHRoaXMuamEpfTt2YXIgZWg9bmV3IGNoKG51bGwsTmcsMCk7Y2gucHJvdG90eXBlW0VhXT1mdW5jdGlvbigpe3JldHVybiB1Yyh0aGlzKX07XG5mdW5jdGlvbiBmaChhKXthPUQoYSk7aWYobnVsbD09YSlyZXR1cm4gYmg7aWYoYSBpbnN0YW5jZW9mIEYmJjA9PT1hLm0pe2E9YS5lO2E6e2Zvcih2YXIgYj0wLGM9T2IoYmgpOzspaWYoYjxhLmxlbmd0aCl2YXIgZD1iKzEsYz1jLlNhKG51bGwsYVtiXSksYj1kO2Vsc2V7YT1jO2JyZWFrIGF9YT12b2lkIDB9cmV0dXJuIGEuVGEobnVsbCl9Zm9yKGQ9T2IoYmgpOzspaWYobnVsbCE9YSliPWEuVChudWxsKSxkPWQuU2EobnVsbCxhLk4obnVsbCkpLGE9YjtlbHNlIHJldHVybiBkLlRhKG51bGwpfVxudmFyIGdoPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhKXt2YXIgZD1udWxsO2lmKDA8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBkPTAsZT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTApO2Q8ZS5sZW5ndGg7KWVbZF09YXJndW1lbnRzW2QrMF0sKytkO2Q9bmV3IEYoZSwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsZCl9ZnVuY3Rpb24gYihhKXtyZXR1cm4gQS5jKFJhLGVoLGEpfWEuaT0wO2EuZj1mdW5jdGlvbihhKXthPUQoYSk7cmV0dXJuIGIoYSl9O2EuZD1iO3JldHVybiBhfSgpLGhoPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGQpe3ZhciBlPW51bGw7aWYoMTxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGU9MCxmPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMSk7ZTxmLmxlbmd0aDspZltlXT1hcmd1bWVudHNbZSsxXSwrK2U7ZT1uZXcgRihmLDApfXJldHVybiBiLmNhbGwodGhpcyxhLGUpfWZ1bmN0aW9uIGIoYSxiKXtyZXR1cm4gQS5jKFJhLG5ldyBjaChudWxsLFJnKGEpLDApLGIpfVxuYS5pPTE7YS5mPWZ1bmN0aW9uKGEpe3ZhciBkPUcoYSk7YT1IKGEpO3JldHVybiBiKGQsYSl9O2EuZD1iO3JldHVybiBhfSgpO2Z1bmN0aW9uIE9kKGEpe2lmKGEmJihhLnEmNDA5Nnx8YS5sYykpcmV0dXJuIGEubmFtZTtpZihcInN0cmluZ1wiPT09dHlwZW9mIGEpcmV0dXJuIGE7dGhyb3cgRXJyb3IoW3ooXCJEb2Vzbid0IHN1cHBvcnQgbmFtZTogXCIpLHooYSldLmpvaW4oXCJcIikpO31cbnZhciBpaD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMpe3JldHVybihhLmI/YS5iKGIpOmEuY2FsbChudWxsLGIpKT4oYS5iP2EuYihjKTphLmNhbGwobnVsbCxjKSk/YjpjfXZhciBiPW51bGwsYz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYixkLGgsbCl7dmFyIG09bnVsbDtpZigzPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgbT0wLHA9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0zKTttPHAubGVuZ3RoOylwW21dPWFyZ3VtZW50c1ttKzNdLCsrbTttPW5ldyBGKHAsMCl9cmV0dXJuIGMuY2FsbCh0aGlzLGIsZCxoLG0pfWZ1bmN0aW9uIGMoYSxkLGUsbCl7cmV0dXJuIEEuYyhmdW5jdGlvbihjLGQpe3JldHVybiBiLmMoYSxjLGQpfSxiLmMoYSxkLGUpLGwpfWEuaT0zO2EuZj1mdW5jdGlvbihhKXt2YXIgYj1HKGEpO2E9SyhhKTt2YXIgZD1HKGEpO2E9SyhhKTt2YXIgbD1HKGEpO2E9SChhKTtyZXR1cm4gYyhiLGQsbCxhKX07YS5kPWM7cmV0dXJuIGF9KCksYj1mdW5jdGlvbihiLFxuZSxmLGcpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDI6cmV0dXJuIGU7Y2FzZSAzOnJldHVybiBhLmNhbGwodGhpcyxiLGUsZik7ZGVmYXVsdDp2YXIgaD1udWxsO2lmKDM8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBoPTAsbD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTMpO2g8bC5sZW5ndGg7KWxbaF09YXJndW1lbnRzW2grM10sKytoO2g9bmV3IEYobCwwKX1yZXR1cm4gYy5kKGIsZSxmLGgpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtiLmk9MztiLmY9Yy5mO2IuYT1mdW5jdGlvbihhLGIpe3JldHVybiBifTtiLmM9YTtiLmQ9Yy5kO3JldHVybiBifSgpO2Z1bmN0aW9uIGpoKGEpe3RoaXMuZT1hfWpoLnByb3RvdHlwZS5hZGQ9ZnVuY3Rpb24oYSl7cmV0dXJuIHRoaXMuZS5wdXNoKGEpfTtqaC5wcm90b3R5cGUuc2l6ZT1mdW5jdGlvbigpe3JldHVybiB0aGlzLmUubGVuZ3RofTtcbmpoLnByb3RvdHlwZS5jbGVhcj1mdW5jdGlvbigpe3JldHVybiB0aGlzLmU9W119O1xudmFyIGtoPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyl7cmV0dXJuIG5ldyBWKG51bGwsZnVuY3Rpb24oKXt2YXIgaD1EKGMpO3JldHVybiBoP00oUGUuYShhLGgpLGQuYyhhLGIsUWUuYShiLGgpKSk6bnVsbH0sbnVsbCxudWxsKX1mdW5jdGlvbiBiKGEsYil7cmV0dXJuIGQuYyhhLGEsYil9ZnVuY3Rpb24gYyhhKXtyZXR1cm4gZnVuY3Rpb24oYil7cmV0dXJuIGZ1bmN0aW9uKGMpe3JldHVybiBmdW5jdGlvbigpe2Z1bmN0aW9uIGQoaCxsKXtjLmFkZChsKTtpZihhPT09Yy5zaXplKCkpe3ZhciBtPXpmKGMuZSk7Yy5jbGVhcigpO3JldHVybiBiLmE/Yi5hKGgsbSk6Yi5jYWxsKG51bGwsaCxtKX1yZXR1cm4gaH1mdW5jdGlvbiBsKGEpe2lmKCF0KDA9PT1jLmUubGVuZ3RoKSl7dmFyIGQ9emYoYy5lKTtjLmNsZWFyKCk7YT1CYyhiLmE/Yi5hKGEsZCk6Yi5jYWxsKG51bGwsYSxkKSl9cmV0dXJuIGIuYj9iLmIoYSk6Yi5jYWxsKG51bGwsYSl9ZnVuY3Rpb24gbSgpe3JldHVybiBiLmw/XG5iLmwoKTpiLmNhbGwobnVsbCl9dmFyIHA9bnVsbCxwPWZ1bmN0aW9uKGEsYil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMDpyZXR1cm4gbS5jYWxsKHRoaXMpO2Nhc2UgMTpyZXR1cm4gbC5jYWxsKHRoaXMsYSk7Y2FzZSAyOnJldHVybiBkLmNhbGwodGhpcyxhLGIpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtwLmw9bTtwLmI9bDtwLmE9ZDtyZXR1cm4gcH0oKX0obmV3IGpoKFtdKSl9fXZhciBkPW51bGwsZD1mdW5jdGlvbihkLGYsZyl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYy5jYWxsKHRoaXMsZCk7Y2FzZSAyOnJldHVybiBiLmNhbGwodGhpcyxkLGYpO2Nhc2UgMzpyZXR1cm4gYS5jYWxsKHRoaXMsZCxmLGcpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtkLmI9YztkLmE9YjtkLmM9YTtyZXR1cm4gZH0oKSxsaD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxcbmIpe3JldHVybiBuZXcgVihudWxsLGZ1bmN0aW9uKCl7dmFyIGY9RChiKTtpZihmKXt2YXIgZztnPUcoZik7Zz1hLmI/YS5iKGcpOmEuY2FsbChudWxsLGcpO2Y9dChnKT9NKEcoZiksYy5hKGEsSChmKSkpOm51bGx9ZWxzZSBmPW51bGw7cmV0dXJuIGZ9LG51bGwsbnVsbCl9ZnVuY3Rpb24gYihhKXtyZXR1cm4gZnVuY3Rpb24oYil7cmV0dXJuIGZ1bmN0aW9uKCl7ZnVuY3Rpb24gYyhmLGcpe3JldHVybiB0KGEuYj9hLmIoZyk6YS5jYWxsKG51bGwsZykpP2IuYT9iLmEoZixnKTpiLmNhbGwobnVsbCxmLGcpOm5ldyB5YyhmKX1mdW5jdGlvbiBnKGEpe3JldHVybiBiLmI/Yi5iKGEpOmIuY2FsbChudWxsLGEpfWZ1bmN0aW9uIGgoKXtyZXR1cm4gYi5sP2IubCgpOmIuY2FsbChudWxsKX12YXIgbD1udWxsLGw9ZnVuY3Rpb24oYSxiKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAwOnJldHVybiBoLmNhbGwodGhpcyk7Y2FzZSAxOnJldHVybiBnLmNhbGwodGhpcyxhKTtjYXNlIDI6cmV0dXJuIGMuY2FsbCh0aGlzLFxuYSxiKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307bC5sPWg7bC5iPWc7bC5hPWM7cmV0dXJuIGx9KCl9fXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGIuY2FsbCh0aGlzLGMpO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5iPWI7Yy5hPWE7cmV0dXJuIGN9KCk7ZnVuY3Rpb24gbWgoYSxiLGMpe3JldHVybiBmdW5jdGlvbihkKXt2YXIgZT1LYihhKTtkPUpiKGEsZCk7ZT1lLmE/ZS5hKGQsYyk6ZS5jYWxsKG51bGwsZCxjKTtyZXR1cm4gYi5hP2IuYShlLDApOmIuY2FsbChudWxsLGUsMCl9fVxudmFyIG5oPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyxnLGgpe3ZhciBsPUliKGEsYywhMCk7aWYodChsKSl7dmFyIG09Ui5jKGwsMCxudWxsKTtyZXR1cm4gbGguYShtaChhLGcsaCksdChtaChhLGIsYykuY2FsbChudWxsLG0pKT9sOksobCkpfXJldHVybiBudWxsfWZ1bmN0aW9uIGIoYSxiLGMpe3ZhciBnPW1oKGEsYixjKSxoO2E6e2g9W0FkLEJkXTt2YXIgbD1oLmxlbmd0aDtpZihsPD1WZilmb3IodmFyIG09MCxwPU9iKFVmKTs7KWlmKG08bCl2YXIgcT1tKzEscD1SYihwLGhbbV0sbnVsbCksbT1xO2Vsc2V7aD1uZXcgJGcobnVsbCxRYihwKSxudWxsKTticmVhayBhfWVsc2UgZm9yKG09MCxwPU9iKGJoKTs7KWlmKG08bClxPW0rMSxwPVBiKHAsaFttXSksbT1xO2Vsc2V7aD1RYihwKTticmVhayBhfWg9dm9pZCAwfXJldHVybiB0KGguY2FsbChudWxsLGIpKT8oYT1JYihhLGMsITApLHQoYSk/KGI9Ui5jKGEsMCxudWxsKSx0KGcuYj9nLmIoYik6Zy5jYWxsKG51bGwsYikpP1xuYTpLKGEpKTpudWxsKTpsaC5hKGcsSGIoYSwhMCkpfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUsZixnLGgpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDM6cmV0dXJuIGIuY2FsbCh0aGlzLGMsZSxmKTtjYXNlIDU6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSxmLGcsaCl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYz1iO2Mucj1hO3JldHVybiBjfSgpO2Z1bmN0aW9uIG9oKGEsYixjKXt0aGlzLm09YTt0aGlzLmVuZD1iO3RoaXMuc3RlcD1jfW9oLnByb3RvdHlwZS5nYT1mdW5jdGlvbigpe3JldHVybiAwPHRoaXMuc3RlcD90aGlzLm08dGhpcy5lbmQ6dGhpcy5tPnRoaXMuZW5kfTtvaC5wcm90b3R5cGUubmV4dD1mdW5jdGlvbigpe3ZhciBhPXRoaXMubTt0aGlzLm0rPXRoaXMuc3RlcDtyZXR1cm4gYX07XG5mdW5jdGlvbiBwaChhLGIsYyxkLGUpe3RoaXMuaz1hO3RoaXMuc3RhcnQ9Yjt0aGlzLmVuZD1jO3RoaXMuc3RlcD1kO3RoaXMucD1lO3RoaXMuaj0zMjM3NTAwNjt0aGlzLnE9ODE5Mn1rPXBoLnByb3RvdHlwZTtrLnRvU3RyaW5nPWZ1bmN0aW9uKCl7cmV0dXJuIGVjKHRoaXMpfTtrLlE9ZnVuY3Rpb24oYSxiKXtpZihiPE1hKHRoaXMpKXJldHVybiB0aGlzLnN0YXJ0K2IqdGhpcy5zdGVwO2lmKHRoaXMuc3RhcnQ+dGhpcy5lbmQmJjA9PT10aGlzLnN0ZXApcmV0dXJuIHRoaXMuc3RhcnQ7dGhyb3cgRXJyb3IoXCJJbmRleCBvdXQgb2YgYm91bmRzXCIpO307ay4kPWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gYjxNYSh0aGlzKT90aGlzLnN0YXJ0K2IqdGhpcy5zdGVwOnRoaXMuc3RhcnQ+dGhpcy5lbmQmJjA9PT10aGlzLnN0ZXA/dGhpcy5zdGFydDpjfTtrLnZiPSEwO2suZmI9ZnVuY3Rpb24oKXtyZXR1cm4gbmV3IG9oKHRoaXMuc3RhcnQsdGhpcy5lbmQsdGhpcy5zdGVwKX07ay5IPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMua307XG5rLlQ9ZnVuY3Rpb24oKXtyZXR1cm4gMDx0aGlzLnN0ZXA/dGhpcy5zdGFydCt0aGlzLnN0ZXA8dGhpcy5lbmQ/bmV3IHBoKHRoaXMuayx0aGlzLnN0YXJ0K3RoaXMuc3RlcCx0aGlzLmVuZCx0aGlzLnN0ZXAsbnVsbCk6bnVsbDp0aGlzLnN0YXJ0K3RoaXMuc3RlcD50aGlzLmVuZD9uZXcgcGgodGhpcy5rLHRoaXMuc3RhcnQrdGhpcy5zdGVwLHRoaXMuZW5kLHRoaXMuc3RlcCxudWxsKTpudWxsfTtrLkw9ZnVuY3Rpb24oKXtpZihBYShDYih0aGlzKSkpcmV0dXJuIDA7dmFyIGE9KHRoaXMuZW5kLXRoaXMuc3RhcnQpL3RoaXMuc3RlcDtyZXR1cm4gTWF0aC5jZWlsLmI/TWF0aC5jZWlsLmIoYSk6TWF0aC5jZWlsLmNhbGwobnVsbCxhKX07ay5CPWZ1bmN0aW9uKCl7dmFyIGE9dGhpcy5wO3JldHVybiBudWxsIT1hP2E6dGhpcy5wPWE9d2ModGhpcyl9O2suQT1mdW5jdGlvbihhLGIpe3JldHVybiBJYyh0aGlzLGIpfTtrLko9ZnVuY3Rpb24oKXtyZXR1cm4gTyhKLHRoaXMuayl9O1xuay5SPWZ1bmN0aW9uKGEsYil7cmV0dXJuIENjLmEodGhpcyxiKX07ay5PPWZ1bmN0aW9uKGEsYixjKXtmb3IoYT10aGlzLnN0YXJ0OzspaWYoMDx0aGlzLnN0ZXA/YTx0aGlzLmVuZDphPnRoaXMuZW5kKXt2YXIgZD1hO2M9Yi5hP2IuYShjLGQpOmIuY2FsbChudWxsLGMsZCk7aWYoQWMoYykpcmV0dXJuIGI9YyxMLmI/TC5iKGIpOkwuY2FsbChudWxsLGIpO2ErPXRoaXMuc3RlcH1lbHNlIHJldHVybiBjfTtrLk49ZnVuY3Rpb24oKXtyZXR1cm4gbnVsbD09Q2IodGhpcyk/bnVsbDp0aGlzLnN0YXJ0fTtrLlM9ZnVuY3Rpb24oKXtyZXR1cm4gbnVsbCE9Q2IodGhpcyk/bmV3IHBoKHRoaXMuayx0aGlzLnN0YXJ0K3RoaXMuc3RlcCx0aGlzLmVuZCx0aGlzLnN0ZXAsbnVsbCk6Sn07ay5EPWZ1bmN0aW9uKCl7cmV0dXJuIDA8dGhpcy5zdGVwP3RoaXMuc3RhcnQ8dGhpcy5lbmQ/dGhpczpudWxsOnRoaXMuc3RhcnQ+dGhpcy5lbmQ/dGhpczpudWxsfTtcbmsuRj1mdW5jdGlvbihhLGIpe3JldHVybiBuZXcgcGgoYix0aGlzLnN0YXJ0LHRoaXMuZW5kLHRoaXMuc3RlcCx0aGlzLnApfTtrLkc9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gTShiLHRoaXMpfTtwaC5wcm90b3R5cGVbRWFdPWZ1bmN0aW9uKCl7cmV0dXJuIHVjKHRoaXMpfTtcbnZhciBxaD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiLGMpe3JldHVybiBuZXcgcGgobnVsbCxhLGIsYyxudWxsKX1mdW5jdGlvbiBiKGEsYil7cmV0dXJuIGUuYyhhLGIsMSl9ZnVuY3Rpb24gYyhhKXtyZXR1cm4gZS5jKDAsYSwxKX1mdW5jdGlvbiBkKCl7cmV0dXJuIGUuYygwLE51bWJlci5NQVhfVkFMVUUsMSl9dmFyIGU9bnVsbCxlPWZ1bmN0aW9uKGUsZyxoKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAwOnJldHVybiBkLmNhbGwodGhpcyk7Y2FzZSAxOnJldHVybiBjLmNhbGwodGhpcyxlKTtjYXNlIDI6cmV0dXJuIGIuY2FsbCh0aGlzLGUsZyk7Y2FzZSAzOnJldHVybiBhLmNhbGwodGhpcyxlLGcsaCl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2UubD1kO2UuYj1jO2UuYT1iO2UuYz1hO3JldHVybiBlfSgpLHJoPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIpe3JldHVybiBuZXcgVihudWxsLGZ1bmN0aW9uKCl7dmFyIGY9XG5EKGIpO3JldHVybiBmP00oRyhmKSxjLmEoYSxRZS5hKGEsZikpKTpudWxsfSxudWxsLG51bGwpfWZ1bmN0aW9uIGIoYSl7cmV0dXJuIGZ1bmN0aW9uKGIpe3JldHVybiBmdW5jdGlvbihjKXtyZXR1cm4gZnVuY3Rpb24oKXtmdW5jdGlvbiBnKGcsaCl7dmFyIGw9Yy5iYigwLGMuUmEobnVsbCkrMSksbT1DZChsLGEpO3JldHVybiAwPT09bC1hKm0/Yi5hP2IuYShnLGgpOmIuY2FsbChudWxsLGcsaCk6Z31mdW5jdGlvbiBoKGEpe3JldHVybiBiLmI/Yi5iKGEpOmIuY2FsbChudWxsLGEpfWZ1bmN0aW9uIGwoKXtyZXR1cm4gYi5sP2IubCgpOmIuY2FsbChudWxsKX12YXIgbT1udWxsLG09ZnVuY3Rpb24oYSxiKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAwOnJldHVybiBsLmNhbGwodGhpcyk7Y2FzZSAxOnJldHVybiBoLmNhbGwodGhpcyxhKTtjYXNlIDI6cmV0dXJuIGcuY2FsbCh0aGlzLGEsYil9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTtcbn07bS5sPWw7bS5iPWg7bS5hPWc7cmV0dXJuIG19KCl9KG5ldyBNZSgtMSkpfX12YXIgYz1udWxsLGM9ZnVuY3Rpb24oYyxlKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiLmNhbGwodGhpcyxjKTtjYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSl9dGhyb3cgRXJyb3IoXCJJbnZhbGlkIGFyaXR5OiBcIithcmd1bWVudHMubGVuZ3RoKTt9O2MuYj1iO2MuYT1hO3JldHVybiBjfSgpLHRoPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIpe3JldHVybiBuZXcgVihudWxsLGZ1bmN0aW9uKCl7dmFyIGY9RChiKTtpZihmKXt2YXIgZz1HKGYpLGg9YS5iP2EuYihnKTphLmNhbGwobnVsbCxnKSxnPU0oZyxsaC5hKGZ1bmN0aW9uKGIsYyl7cmV0dXJuIGZ1bmN0aW9uKGIpe3JldHVybiBzYy5hKGMsYS5iP2EuYihiKTphLmNhbGwobnVsbCxiKSl9fShnLGgsZixmKSxLKGYpKSk7cmV0dXJuIE0oZyxjLmEoYSxEKFFlLmEoUShnKSxmKSkpKX1yZXR1cm4gbnVsbH0sbnVsbCxcbm51bGwpfWZ1bmN0aW9uIGIoYSl7cmV0dXJuIGZ1bmN0aW9uKGIpe3JldHVybiBmdW5jdGlvbihjLGcpe3JldHVybiBmdW5jdGlvbigpe2Z1bmN0aW9uIGgoaCxsKXt2YXIgbT1MLmI/TC5iKGcpOkwuY2FsbChudWxsLGcpLHA9YS5iP2EuYihsKTphLmNhbGwobnVsbCxsKTthYyhnLHApO2lmKE5kKG0sc2gpfHxzYy5hKHAsbSkpcmV0dXJuIGMuYWRkKGwpLGg7bT16ZihjLmUpO2MuY2xlYXIoKTttPWIuYT9iLmEoaCxtKTpiLmNhbGwobnVsbCxoLG0pO0FjKG0pfHxjLmFkZChsKTtyZXR1cm4gbX1mdW5jdGlvbiBsKGEpe2lmKCF0KDA9PT1jLmUubGVuZ3RoKSl7dmFyIGQ9emYoYy5lKTtjLmNsZWFyKCk7YT1CYyhiLmE/Yi5hKGEsZCk6Yi5jYWxsKG51bGwsYSxkKSl9cmV0dXJuIGIuYj9iLmIoYSk6Yi5jYWxsKG51bGwsYSl9ZnVuY3Rpb24gbSgpe3JldHVybiBiLmw/Yi5sKCk6Yi5jYWxsKG51bGwpfXZhciBwPW51bGwscD1mdW5jdGlvbihhLGIpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDA6cmV0dXJuIG0uY2FsbCh0aGlzKTtcbmNhc2UgMTpyZXR1cm4gbC5jYWxsKHRoaXMsYSk7Y2FzZSAyOnJldHVybiBoLmNhbGwodGhpcyxhLGIpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtwLmw9bTtwLmI9bDtwLmE9aDtyZXR1cm4gcH0oKX0obmV3IGpoKFtdKSxuZXcgTWUoc2gpKX19dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYi5jYWxsKHRoaXMsYyk7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxjLGUpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmI9YjtjLmE9YTtyZXR1cm4gY30oKSx1aD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiKXtmb3IoOzspaWYoRChiKSYmMDxhKXt2YXIgYz1hLTEsZz1LKGIpO2E9YztiPWd9ZWxzZSByZXR1cm4gbnVsbH1mdW5jdGlvbiBiKGEpe2Zvcig7OylpZihEKGEpKWE9SyhhKTtlbHNlIHJldHVybiBudWxsfXZhciBjPVxubnVsbCxjPWZ1bmN0aW9uKGMsZSl7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMTpyZXR1cm4gYi5jYWxsKHRoaXMsYyk7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxjLGUpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmI9YjtjLmE9YTtyZXR1cm4gY30oKSx2aD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiKXt1aC5hKGEsYik7cmV0dXJuIGJ9ZnVuY3Rpb24gYihhKXt1aC5iKGEpO3JldHVybiBhfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGIuY2FsbCh0aGlzLGMpO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5iPWI7Yy5hPWE7cmV0dXJuIGN9KCk7XG5mdW5jdGlvbiB3aChhLGIsYyxkLGUsZixnKXt2YXIgaD1tYTt0cnl7bWE9bnVsbD09bWE/bnVsbDptYS0xO2lmKG51bGwhPW1hJiYwPm1hKXJldHVybiBMYihhLFwiI1wiKTtMYihhLGMpO2lmKEQoZykpe3ZhciBsPUcoZyk7Yi5jP2IuYyhsLGEsZik6Yi5jYWxsKG51bGwsbCxhLGYpfWZvcih2YXIgbT1LKGcpLHA9emEuYihmKS0xOzspaWYoIW18fG51bGwhPXAmJjA9PT1wKXtEKG0pJiYwPT09cCYmKExiKGEsZCksTGIoYSxcIi4uLlwiKSk7YnJlYWt9ZWxzZXtMYihhLGQpO3ZhciBxPUcobSk7Yz1hO2c9ZjtiLmM/Yi5jKHEsYyxnKTpiLmNhbGwobnVsbCxxLGMsZyk7dmFyIHM9SyhtKTtjPXAtMTttPXM7cD1jfXJldHVybiBMYihhLGUpfWZpbmFsbHl7bWE9aH19XG52YXIgeGg9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsZCl7dmFyIGU9bnVsbDtpZigxPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZT0wLGY9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0xKTtlPGYubGVuZ3RoOylmW2VdPWFyZ3VtZW50c1tlKzFdLCsrZTtlPW5ldyBGKGYsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGEsZSl9ZnVuY3Rpb24gYihhLGIpe2Zvcih2YXIgZT1EKGIpLGY9bnVsbCxnPTAsaD0wOzspaWYoaDxnKXt2YXIgbD1mLlEobnVsbCxoKTtMYihhLGwpO2grPTF9ZWxzZSBpZihlPUQoZSkpZj1lLGZkKGYpPyhlPVliKGYpLGc9WmIoZiksZj1lLGw9UShlKSxlPWcsZz1sKToobD1HKGYpLExiKGEsbCksZT1LKGYpLGY9bnVsbCxnPTApLGg9MDtlbHNlIHJldHVybiBudWxsfWEuaT0xO2EuZj1mdW5jdGlvbihhKXt2YXIgZD1HKGEpO2E9SChhKTtyZXR1cm4gYihkLGEpfTthLmQ9YjtyZXR1cm4gYX0oKSx5aD17J1wiJzonXFxcXFwiJyxcIlxcXFxcIjpcIlxcXFxcXFxcXCIsXCJcXGJcIjpcIlxcXFxiXCIsXCJcXGZcIjpcIlxcXFxmXCIsXG5cIlxcblwiOlwiXFxcXG5cIixcIlxcclwiOlwiXFxcXHJcIixcIlxcdFwiOlwiXFxcXHRcIn07ZnVuY3Rpb24gemgoYSl7cmV0dXJuW3ooJ1wiJykseihhLnJlcGxhY2UoUmVnRXhwKCdbXFxcXFxcXFxcIlxcYlxcZlxcblxcclxcdF0nLFwiZ1wiKSxmdW5jdGlvbihhKXtyZXR1cm4geWhbYV19KSkseignXCInKV0uam9pbihcIlwiKX1cbnZhciAkPWZ1bmN0aW9uIEFoKGIsYyxkKXtpZihudWxsPT1iKXJldHVybiBMYihjLFwibmlsXCIpO2lmKHZvaWQgMD09PWIpcmV0dXJuIExiKGMsXCIjXFx4M2N1bmRlZmluZWRcXHgzZVwiKTt0KGZ1bmN0aW9uKCl7dmFyIGM9Uy5hKGQsd2EpO3JldHVybiB0KGMpPyhjPWI/Yi5qJjEzMTA3Mnx8Yi5rYz8hMDpiLmo/ITE6dyhyYixiKTp3KHJiLGIpKT9WYyhiKTpjOmN9KCkpJiYoTGIoYyxcIl5cIiksQWgoVmMoYiksYyxkKSxMYihjLFwiIFwiKSk7aWYobnVsbD09YilyZXR1cm4gTGIoYyxcIm5pbFwiKTtpZihiLlliKXJldHVybiBiLm5jKGMpO2lmKGImJihiLmomMjE0NzQ4MzY0OHx8Yi5JKSlyZXR1cm4gYi52KG51bGwsYyxkKTtpZihCYShiKT09PUJvb2xlYW58fFwibnVtYmVyXCI9PT10eXBlb2YgYilyZXR1cm4gTGIoYyxcIlwiK3ooYikpO2lmKG51bGwhPWImJmIuY29uc3RydWN0b3I9PT1PYmplY3Qpe0xiKGMsXCIjanMgXCIpO3ZhciBlPU9lLmEoZnVuY3Rpb24oYyl7cmV0dXJuIG5ldyBXKG51bGwsMiw1LFxudWYsW1BkLmIoYyksYltjXV0sbnVsbCl9LGdkKGIpKTtyZXR1cm4gQmgubj9CaC5uKGUsQWgsYyxkKTpCaC5jYWxsKG51bGwsZSxBaCxjLGQpfXJldHVybiBiIGluc3RhbmNlb2YgQXJyYXk/d2goYyxBaCxcIiNqcyBbXCIsXCIgXCIsXCJdXCIsZCxiKTp0KFwic3RyaW5nXCI9PXR5cGVvZiBiKT90KHVhLmIoZCkpP0xiKGMsemgoYikpOkxiKGMsYik6VGMoYik/eGguZChjLEtjKFtcIiNcXHgzY1wiLFwiXCIreihiKSxcIlxceDNlXCJdLDApKTpiIGluc3RhbmNlb2YgRGF0ZT8oZT1mdW5jdGlvbihiLGMpe2Zvcih2YXIgZD1cIlwiK3ooYik7OylpZihRKGQpPGMpZD1beihcIjBcIikseihkKV0uam9pbihcIlwiKTtlbHNlIHJldHVybiBkfSx4aC5kKGMsS2MoWycjaW5zdCBcIicsXCJcIit6KGIuZ2V0VVRDRnVsbFllYXIoKSksXCItXCIsZShiLmdldFVUQ01vbnRoKCkrMSwyKSxcIi1cIixlKGIuZ2V0VVRDRGF0ZSgpLDIpLFwiVFwiLGUoYi5nZXRVVENIb3VycygpLDIpLFwiOlwiLGUoYi5nZXRVVENNaW51dGVzKCksMiksXCI6XCIsZShiLmdldFVUQ1NlY29uZHMoKSxcbjIpLFwiLlwiLGUoYi5nZXRVVENNaWxsaXNlY29uZHMoKSwzKSxcIi1cIiwnMDA6MDBcIiddLDApKSk6YiBpbnN0YW5jZW9mIFJlZ0V4cD94aC5kKGMsS2MoWycjXCInLGIuc291cmNlLCdcIiddLDApKTooYj9iLmomMjE0NzQ4MzY0OHx8Yi5JfHwoYi5qPzA6dyhNYixiKSk6dyhNYixiKSk/TmIoYixjLGQpOnhoLmQoYyxLYyhbXCIjXFx4M2NcIixcIlwiK3ooYiksXCJcXHgzZVwiXSwwKSl9LENoPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhKXt2YXIgZD1udWxsO2lmKDA8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBkPTAsZT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTApO2Q8ZS5sZW5ndGg7KWVbZF09YXJndW1lbnRzW2QrMF0sKytkO2Q9bmV3IEYoZSwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsZCl9ZnVuY3Rpb24gYihhKXt2YXIgYj1vYSgpO2lmKFljKGEpKWI9XCJcIjtlbHNle3ZhciBlPXosZj1uZXcgZmE7YTp7dmFyIGc9bmV3IGRjKGYpOyQoRyhhKSxnLGIpO2E9RChLKGEpKTtmb3IodmFyIGg9bnVsbCxsPTAsXG5tPTA7OylpZihtPGwpe3ZhciBwPWguUShudWxsLG0pO0xiKGcsXCIgXCIpOyQocCxnLGIpO20rPTF9ZWxzZSBpZihhPUQoYSkpaD1hLGZkKGgpPyhhPVliKGgpLGw9WmIoaCksaD1hLHA9UShhKSxhPWwsbD1wKToocD1HKGgpLExiKGcsXCIgXCIpLCQocCxnLGIpLGE9SyhoKSxoPW51bGwsbD0wKSxtPTA7ZWxzZSBicmVhayBhfWI9XCJcIitlKGYpfXJldHVybiBifWEuaT0wO2EuZj1mdW5jdGlvbihhKXthPUQoYSk7cmV0dXJuIGIoYSl9O2EuZD1iO3JldHVybiBhfSgpO2Z1bmN0aW9uIEJoKGEsYixjLGQpe3JldHVybiB3aChjLGZ1bmN0aW9uKGEsYyxkKXt2YXIgaD1oYihhKTtiLmM/Yi5jKGgsYyxkKTpiLmNhbGwobnVsbCxoLGMsZCk7TGIoYyxcIiBcIik7YT1pYihhKTtyZXR1cm4gYi5jP2IuYyhhLGMsZCk6Yi5jYWxsKG51bGwsYSxjLGQpfSxcIntcIixcIiwgXCIsXCJ9XCIsZCxEKGEpKX1NZS5wcm90b3R5cGUuST0hMDtcbk1lLnByb3RvdHlwZS52PWZ1bmN0aW9uKGEsYixjKXtMYihiLFwiI1xceDNjVm9sYXRpbGU6IFwiKTskKHRoaXMuc3RhdGUsYixjKTtyZXR1cm4gTGIoYixcIlxceDNlXCIpfTtGLnByb3RvdHlwZS5JPSEwO0YucHJvdG90eXBlLnY9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiB3aChiLCQsXCIoXCIsXCIgXCIsXCIpXCIsYyx0aGlzKX07Vi5wcm90b3R5cGUuST0hMDtWLnByb3RvdHlwZS52PWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gd2goYiwkLFwiKFwiLFwiIFwiLFwiKVwiLGMsdGhpcyl9O3dnLnByb3RvdHlwZS5JPSEwO3dnLnByb3RvdHlwZS52PWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gd2goYiwkLFwiKFwiLFwiIFwiLFwiKVwiLGMsdGhpcyl9O3BnLnByb3RvdHlwZS5JPSEwO3BnLnByb3RvdHlwZS52PWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gd2goYiwkLFwiKFwiLFwiIFwiLFwiKVwiLGMsdGhpcyl9O1oucHJvdG90eXBlLkk9ITA7XG5aLnByb3RvdHlwZS52PWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gd2goYiwkLFwiW1wiLFwiIFwiLFwiXVwiLGMsdGhpcyl9O1JmLnByb3RvdHlwZS5JPSEwO1JmLnByb3RvdHlwZS52PWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gd2goYiwkLFwiKFwiLFwiIFwiLFwiKVwiLGMsdGhpcyl9O2NoLnByb3RvdHlwZS5JPSEwO2NoLnByb3RvdHlwZS52PWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gd2goYiwkLFwiI3tcIixcIiBcIixcIn1cIixjLHRoaXMpfTtCZi5wcm90b3R5cGUuST0hMDtCZi5wcm90b3R5cGUudj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIHdoKGIsJCxcIihcIixcIiBcIixcIilcIixjLHRoaXMpfTtMZC5wcm90b3R5cGUuST0hMDtMZC5wcm90b3R5cGUudj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIHdoKGIsJCxcIihcIixcIiBcIixcIilcIixjLHRoaXMpfTtIYy5wcm90b3R5cGUuST0hMDtIYy5wcm90b3R5cGUudj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIHdoKGIsJCxcIihcIixcIiBcIixcIilcIixjLHRoaXMpfTtcbnJnLnByb3RvdHlwZS5JPSEwO3JnLnByb3RvdHlwZS52PWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gQmgodGhpcywkLGIsYyl9O3FnLnByb3RvdHlwZS5JPSEwO3FnLnByb3RvdHlwZS52PWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gd2goYiwkLFwiKFwiLFwiIFwiLFwiKVwiLGMsdGhpcyl9O0RmLnByb3RvdHlwZS5JPSEwO0RmLnByb3RvdHlwZS52PWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gd2goYiwkLFwiW1wiLFwiIFwiLFwiXVwiLGMsdGhpcyl9O0xnLnByb3RvdHlwZS5JPSEwO0xnLnByb3RvdHlwZS52PWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gQmgodGhpcywkLGIsYyl9OyRnLnByb3RvdHlwZS5JPSEwOyRnLnByb3RvdHlwZS52PWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gd2goYiwkLFwiI3tcIixcIiBcIixcIn1cIixjLHRoaXMpfTtWZC5wcm90b3R5cGUuST0hMDtWZC5wcm90b3R5cGUudj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIHdoKGIsJCxcIihcIixcIiBcIixcIilcIixjLHRoaXMpfTtVZy5wcm90b3R5cGUuST0hMDtcblVnLnByb3RvdHlwZS52PWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gd2goYiwkLFwiKFwiLFwiIFwiLFwiKVwiLGMsdGhpcyl9O1gucHJvdG90eXBlLkk9ITA7WC5wcm90b3R5cGUudj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIHdoKGIsJCxcIltcIixcIiBcIixcIl1cIixjLHRoaXMpfTtXLnByb3RvdHlwZS5JPSEwO1cucHJvdG90eXBlLnY9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiB3aChiLCQsXCJbXCIsXCIgXCIsXCJdXCIsYyx0aGlzKX07S2YucHJvdG90eXBlLkk9ITA7S2YucHJvdG90eXBlLnY9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiB3aChiLCQsXCIoXCIsXCIgXCIsXCIpXCIsYyx0aGlzKX07SGQucHJvdG90eXBlLkk9ITA7SGQucHJvdG90eXBlLnY9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gTGIoYixcIigpXCIpfTt6ZS5wcm90b3R5cGUuST0hMDt6ZS5wcm90b3R5cGUudj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIHdoKGIsJCxcIihcIixcIiBcIixcIilcIixjLHRoaXMpfTtMZi5wcm90b3R5cGUuST0hMDtcbkxmLnByb3RvdHlwZS52PWZ1bmN0aW9uKGEsYixjKXtyZXR1cm4gd2goYiwkLFwiI3F1ZXVlIFtcIixcIiBcIixcIl1cIixjLEQodGhpcykpfTtwYS5wcm90b3R5cGUuST0hMDtwYS5wcm90b3R5cGUudj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIEJoKHRoaXMsJCxiLGMpfTtwaC5wcm90b3R5cGUuST0hMDtwaC5wcm90b3R5cGUudj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIHdoKGIsJCxcIihcIixcIiBcIixcIilcIixjLHRoaXMpfTtTZy5wcm90b3R5cGUuST0hMDtTZy5wcm90b3R5cGUudj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIHdoKGIsJCxcIihcIixcIiBcIixcIilcIixjLHRoaXMpfTtGZC5wcm90b3R5cGUuST0hMDtGZC5wcm90b3R5cGUudj1mdW5jdGlvbihhLGIsYyl7cmV0dXJuIHdoKGIsJCxcIihcIixcIiBcIixcIilcIixjLHRoaXMpfTtXLnByb3RvdHlwZS5zYj0hMDtXLnByb3RvdHlwZS50Yj1mdW5jdGlvbihhLGIpe3JldHVybiBwZC5hKHRoaXMsYil9O0RmLnByb3RvdHlwZS5zYj0hMDtcbkRmLnByb3RvdHlwZS50Yj1mdW5jdGlvbihhLGIpe3JldHVybiBwZC5hKHRoaXMsYil9O1UucHJvdG90eXBlLnNiPSEwO1UucHJvdG90eXBlLnRiPWZ1bmN0aW9uKGEsYil7cmV0dXJuIE1kKHRoaXMsYil9O3FjLnByb3RvdHlwZS5zYj0hMDtxYy5wcm90b3R5cGUudGI9ZnVuY3Rpb24oYSxiKXtyZXR1cm4gcGModGhpcyxiKX07dmFyIERoPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGQsZSl7dmFyIGY9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZj0wLGc9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0yKTtmPGcubGVuZ3RoOylnW2ZdPWFyZ3VtZW50c1tmKzJdLCsrZjtmPW5ldyBGKGcsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGEsZCxmKX1mdW5jdGlvbiBiKGEsYixlKXtyZXR1cm4gYS5rPVQuYyhiLGEuayxlKX1hLmk9MjthLmY9ZnVuY3Rpb24oYSl7dmFyIGQ9RyhhKTthPUsoYSk7dmFyIGU9RyhhKTthPUgoYSk7cmV0dXJuIGIoZCxlLGEpfTthLmQ9YjtyZXR1cm4gYX0oKTtcbmZ1bmN0aW9uIEVoKGEpe3JldHVybiBmdW5jdGlvbihiLGMpe3ZhciBkPWEuYT9hLmEoYixjKTphLmNhbGwobnVsbCxiLGMpO3JldHVybiBBYyhkKT9uZXcgeWMoZCk6ZH19XG5mdW5jdGlvbiBWZShhKXtyZXR1cm4gZnVuY3Rpb24oYil7cmV0dXJuIGZ1bmN0aW9uKCl7ZnVuY3Rpb24gYyhhLGMpe3JldHVybiBBLmMoYixhLGMpfWZ1bmN0aW9uIGQoYil7cmV0dXJuIGEuYj9hLmIoYik6YS5jYWxsKG51bGwsYil9ZnVuY3Rpb24gZSgpe3JldHVybiBhLmw/YS5sKCk6YS5jYWxsKG51bGwpfXZhciBmPW51bGwsZj1mdW5jdGlvbihhLGIpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDA6cmV0dXJuIGUuY2FsbCh0aGlzKTtjYXNlIDE6cmV0dXJuIGQuY2FsbCh0aGlzLGEpO2Nhc2UgMjpyZXR1cm4gYy5jYWxsKHRoaXMsYSxiKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Zi5sPWU7Zi5iPWQ7Zi5hPWM7cmV0dXJuIGZ9KCl9KEVoKGEpKX1cbnZhciBGaD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSl7cmV0dXJuIENlLmEoYy5sKCksYSl9ZnVuY3Rpb24gYigpe3JldHVybiBmdW5jdGlvbihhKXtyZXR1cm4gZnVuY3Rpb24oYil7cmV0dXJuIGZ1bmN0aW9uKCl7ZnVuY3Rpb24gYyhmLGcpe3ZhciBoPUwuYj9MLmIoYik6TC5jYWxsKG51bGwsYik7YWMoYixnKTtyZXR1cm4gc2MuYShoLGcpP2Y6YS5hP2EuYShmLGcpOmEuY2FsbChudWxsLGYsZyl9ZnVuY3Rpb24gZyhiKXtyZXR1cm4gYS5iP2EuYihiKTphLmNhbGwobnVsbCxiKX1mdW5jdGlvbiBoKCl7cmV0dXJuIGEubD9hLmwoKTphLmNhbGwobnVsbCl9dmFyIGw9bnVsbCxsPWZ1bmN0aW9uKGEsYil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMDpyZXR1cm4gaC5jYWxsKHRoaXMpO2Nhc2UgMTpyZXR1cm4gZy5jYWxsKHRoaXMsYSk7Y2FzZSAyOnJldHVybiBjLmNhbGwodGhpcyxhLGIpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7XG59O2wubD1oO2wuYj1nO2wuYT1jO3JldHVybiBsfSgpfShuZXcgTWUoc2gpKX19dmFyIGM9bnVsbCxjPWZ1bmN0aW9uKGMpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDA6cmV0dXJuIGIuY2FsbCh0aGlzKTtjYXNlIDE6cmV0dXJuIGEuY2FsbCh0aGlzLGMpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtjLmw9YjtjLmI9YTtyZXR1cm4gY30oKTtmdW5jdGlvbiBHaChhLGIpe3RoaXMuZmE9YTt0aGlzLlpiPWI7dGhpcy5xPTA7dGhpcy5qPTIxNzMxNzM3NjB9R2gucHJvdG90eXBlLnY9ZnVuY3Rpb24oYSxiLGMpe3JldHVybiB3aChiLCQsXCIoXCIsXCIgXCIsXCIpXCIsYyx0aGlzKX07R2gucHJvdG90eXBlLk89ZnVuY3Rpb24oYSxiLGMpe3JldHVybiB3ZC5uKHRoaXMuZmEsYixjLHRoaXMuWmIpfTtHaC5wcm90b3R5cGUuRD1mdW5jdGlvbigpe3JldHVybiBEKENlLmEodGhpcy5mYSx0aGlzLlpiKSl9O0doLnByb3RvdHlwZVtFYV09ZnVuY3Rpb24oKXtyZXR1cm4gdWModGhpcyl9O1xudmFyIEhoPXt9O2Z1bmN0aW9uIEloKGEpe2lmKGE/YS5nYzphKXJldHVybiBhLmdjKGEpO3ZhciBiO2I9SWhbbihudWxsPT1hP251bGw6YSldO2lmKCFiJiYoYj1JaC5fLCFiKSl0aHJvdyB4KFwiSUVuY29kZUpTLi1jbGotXFx4M2Vqc1wiLGEpO3JldHVybiBiLmNhbGwobnVsbCxhKX1mdW5jdGlvbiBKaChhKXtyZXR1cm4oYT90KHQobnVsbCk/bnVsbDphLmZjKXx8KGEueWI/MDp3KEhoLGEpKTp3KEhoLGEpKT9JaChhKTpcInN0cmluZ1wiPT09dHlwZW9mIGF8fFwibnVtYmVyXCI9PT10eXBlb2YgYXx8YSBpbnN0YW5jZW9mIFV8fGEgaW5zdGFuY2VvZiBxYz9LaC5iP0toLmIoYSk6S2guY2FsbChudWxsLGEpOkNoLmQoS2MoW2FdLDApKX1cbnZhciBLaD1mdW5jdGlvbiBMaChiKXtpZihudWxsPT1iKXJldHVybiBudWxsO2lmKGI/dCh0KG51bGwpP251bGw6Yi5mYyl8fChiLnliPzA6dyhIaCxiKSk6dyhIaCxiKSlyZXR1cm4gSWgoYik7aWYoYiBpbnN0YW5jZW9mIFUpcmV0dXJuIE9kKGIpO2lmKGIgaW5zdGFuY2VvZiBxYylyZXR1cm5cIlwiK3ooYik7aWYoZGQoYikpe3ZhciBjPXt9O2I9RChiKTtmb3IodmFyIGQ9bnVsbCxlPTAsZj0wOzspaWYoZjxlKXt2YXIgZz1kLlEobnVsbCxmKSxoPVIuYyhnLDAsbnVsbCksZz1SLmMoZywxLG51bGwpO2NbSmgoaCldPUxoKGcpO2YrPTF9ZWxzZSBpZihiPUQoYikpZmQoYik/KGU9WWIoYiksYj1aYihiKSxkPWUsZT1RKGUpKTooZT1HKGIpLGQ9Ui5jKGUsMCxudWxsKSxlPVIuYyhlLDEsbnVsbCksY1tKaChkKV09TGgoZSksYj1LKGIpLGQ9bnVsbCxlPTApLGY9MDtlbHNlIGJyZWFrO3JldHVybiBjfWlmKCRjKGIpKXtjPVtdO2I9RChPZS5hKExoLGIpKTtkPW51bGw7Zm9yKGY9ZT0wOzspaWYoZjxcbmUpaD1kLlEobnVsbCxmKSxjLnB1c2goaCksZis9MTtlbHNlIGlmKGI9RChiKSlkPWIsZmQoZCk/KGI9WWIoZCksZj1aYihkKSxkPWIsZT1RKGIpLGI9Zik6KGI9RyhkKSxjLnB1c2goYiksYj1LKGQpLGQ9bnVsbCxlPTApLGY9MDtlbHNlIGJyZWFrO3JldHVybiBjfXJldHVybiBifSxNaD17fTtmdW5jdGlvbiBOaChhLGIpe2lmKGE/YS5lYzphKXJldHVybiBhLmVjKGEsYik7dmFyIGM7Yz1OaFtuKG51bGw9PWE/bnVsbDphKV07aWYoIWMmJihjPU5oLl8sIWMpKXRocm93IHgoXCJJRW5jb2RlQ2xvanVyZS4tanMtXFx4M2VjbGpcIixhKTtyZXR1cm4gYy5jYWxsKG51bGwsYSxiKX1cbnZhciBQaD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSl7cmV0dXJuIGIuZChhLEtjKFtuZXcgcGEobnVsbCwxLFtPaCwhMV0sbnVsbCldLDApKX12YXIgYj1udWxsLGM9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGMsZCl7dmFyIGg9bnVsbDtpZigxPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgaD0wLGw9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0xKTtoPGwubGVuZ3RoOylsW2hdPWFyZ3VtZW50c1toKzFdLCsraDtoPW5ldyBGKGwsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGMsaCl9ZnVuY3Rpb24gYihhLGMpe3ZhciBkPWtkKGMpP1QuYShPZyxjKTpjLGU9Uy5hKGQsT2gpO3JldHVybiBmdW5jdGlvbihhLGIsZCxlKXtyZXR1cm4gZnVuY3Rpb24gdihmKXtyZXR1cm4oZj90KHQobnVsbCk/bnVsbDpmLnVjKXx8KGYueWI/MDp3KE1oLGYpKTp3KE1oLGYpKT9OaChmLFQuYShQZyxjKSk6a2QoZik/dmguYihPZS5hKHYsZikpOiRjKGYpP2FmLmEoT2MoZiksT2UuYSh2LGYpKTpmIGluc3RhbmNlb2ZcbkFycmF5P3pmKE9lLmEodixmKSk6QmEoZik9PT1PYmplY3Q/YWYuYShVZixmdW5jdGlvbigpe3JldHVybiBmdW5jdGlvbihhLGIsYyxkKXtyZXR1cm4gZnVuY3Rpb24gUGEoZSl7cmV0dXJuIG5ldyBWKG51bGwsZnVuY3Rpb24oYSxiLGMsZCl7cmV0dXJuIGZ1bmN0aW9uKCl7Zm9yKDs7KXt2YXIgYT1EKGUpO2lmKGEpe2lmKGZkKGEpKXt2YXIgYj1ZYihhKSxjPVEoYiksZz1UZChjKTtyZXR1cm4gZnVuY3Rpb24oKXtmb3IodmFyIGE9MDs7KWlmKGE8Yyl7dmFyIGU9Qy5hKGIsYSksaD1nLGw9dWYsbTttPWU7bT1kLmI/ZC5iKG0pOmQuY2FsbChudWxsLG0pO2U9bmV3IFcobnVsbCwyLDUsbCxbbSx2KGZbZV0pXSxudWxsKTtoLmFkZChlKTthKz0xfWVsc2UgcmV0dXJuITB9KCk/V2QoZy5jYSgpLFBhKFpiKGEpKSk6V2QoZy5jYSgpLG51bGwpfXZhciBoPUcoYSk7cmV0dXJuIE0obmV3IFcobnVsbCwyLDUsdWYsW2Z1bmN0aW9uKCl7dmFyIGE9aDtyZXR1cm4gZC5iP2QuYihhKTpkLmNhbGwobnVsbCxcbmEpfSgpLHYoZltoXSldLG51bGwpLFBhKEgoYSkpKX1yZXR1cm4gbnVsbH19fShhLGIsYyxkKSxudWxsLG51bGwpfX0oYSxiLGQsZSkoZ2QoZikpfSgpKTpmfX0oYyxkLGUsdChlKT9QZDp6KShhKX1hLmk9MTthLmY9ZnVuY3Rpb24oYSl7dmFyIGM9RyhhKTthPUgoYSk7cmV0dXJuIGIoYyxhKX07YS5kPWI7cmV0dXJuIGF9KCksYj1mdW5jdGlvbihiLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGEuY2FsbCh0aGlzLGIpO2RlZmF1bHQ6dmFyIGY9bnVsbDtpZigxPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZj0wLGc9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0xKTtmPGcubGVuZ3RoOylnW2ZdPWFyZ3VtZW50c1tmKzFdLCsrZjtmPW5ldyBGKGcsMCl9cmV0dXJuIGMuZChiLGYpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtiLmk9MTtiLmY9Yy5mO2IuYj1hO2IuZD1jLmQ7cmV0dXJuIGJ9KCk7dmFyIHdhPW5ldyBVKG51bGwsXCJtZXRhXCIsXCJtZXRhXCIsMTQ5OTUzNjk2NCkseWE9bmV3IFUobnVsbCxcImR1cFwiLFwiZHVwXCIsNTU2Mjk4NTMzKSxzaD1uZXcgVShcImNsanMuY29yZVwiLFwibm9uZVwiLFwiY2xqcy5jb3JlL25vbmVcIiw5MjY2NDY0MzkpLHBlPW5ldyBVKG51bGwsXCJmaWxlXCIsXCJmaWxlXCIsLTEyNjk2NDU4NzgpLGxlPW5ldyBVKG51bGwsXCJlbmQtY29sdW1uXCIsXCJlbmQtY29sdW1uXCIsMTQyNTM4OTUxNCksc2E9bmV3IFUobnVsbCxcImZsdXNoLW9uLW5ld2xpbmVcIixcImZsdXNoLW9uLW5ld2xpbmVcIiwtMTUxNDU3OTM5KSxuZT1uZXcgVShudWxsLFwiY29sdW1uXCIsXCJjb2x1bW5cIiwyMDc4MjIyMDk1KSx1YT1uZXcgVShudWxsLFwicmVhZGFibHlcIixcInJlYWRhYmx5XCIsMTEyOTU5OTc2MCksb2U9bmV3IFUobnVsbCxcImxpbmVcIixcImxpbmVcIiwyMTIzNDUyMzUpLHphPW5ldyBVKG51bGwsXCJwcmludC1sZW5ndGhcIixcInByaW50LWxlbmd0aFwiLDE5MzE4NjYzNTYpLG1lPW5ldyBVKG51bGwsXCJlbmQtbGluZVwiLFxuXCJlbmQtbGluZVwiLDE4MzczMjY0NTUpLE9oPW5ldyBVKG51bGwsXCJrZXl3b3JkaXplLWtleXNcIixcImtleXdvcmRpemUta2V5c1wiLDEzMTA3ODQyNTIpLFpnPW5ldyBVKFwiY2xqcy5jb3JlXCIsXCJub3QtZm91bmRcIixcImNsanMuY29yZS9ub3QtZm91bmRcIiwtMTU3Mjg4OTE4NSk7ZnVuY3Rpb24gUWgoYSxiKXt2YXIgYz1ULmMoaWgsYSxiKTtyZXR1cm4gTShjLFllLmEoZnVuY3Rpb24oYSl7cmV0dXJuIGZ1bmN0aW9uKGIpe3JldHVybiBhPT09Yn19KGMpLGIpKX1cbnZhciBSaD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiKXtyZXR1cm4gUShhKTxRKGIpP0EuYyhOYyxiLGEpOkEuYyhOYyxhLGIpfXZhciBiPW51bGwsYz1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYyxkLGgpe3ZhciBsPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGw9MCxtPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7bDxtLmxlbmd0aDspbVtsXT1hcmd1bWVudHNbbCsyXSwrK2w7bD1uZXcgRihtLDApfXJldHVybiBiLmNhbGwodGhpcyxjLGQsbCl9ZnVuY3Rpb24gYihhLGMsZCl7YT1RaChRLE5jLmQoZCxjLEtjKFthXSwwKSkpO3JldHVybiBBLmMoYWYsRyhhKSxIKGEpKX1hLmk9MjthLmY9ZnVuY3Rpb24oYSl7dmFyIGM9RyhhKTthPUsoYSk7dmFyIGQ9RyhhKTthPUgoYSk7cmV0dXJuIGIoYyxkLGEpfTthLmQ9YjtyZXR1cm4gYX0oKSxiPWZ1bmN0aW9uKGIsZSxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAwOnJldHVybiBiaDtjYXNlIDE6cmV0dXJuIGI7XG5jYXNlIDI6cmV0dXJuIGEuY2FsbCh0aGlzLGIsZSk7ZGVmYXVsdDp2YXIgZz1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBnPTAsaD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2c8aC5sZW5ndGg7KWhbZ109YXJndW1lbnRzW2crMl0sKytnO2c9bmV3IEYoaCwwKX1yZXR1cm4gYy5kKGIsZSxnKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yi5pPTI7Yi5mPWMuZjtiLmw9ZnVuY3Rpb24oKXtyZXR1cm4gYmh9O2IuYj1mdW5jdGlvbihhKXtyZXR1cm4gYX07Yi5hPWE7Yi5kPWMuZDtyZXR1cm4gYn0oKSxTaD1mdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSxiKXtmb3IoOzspaWYoUShiKTxRKGEpKXt2YXIgYz1hO2E9YjtiPWN9ZWxzZSByZXR1cm4gQS5jKGZ1bmN0aW9uKGEsYil7cmV0dXJuIGZ1bmN0aW9uKGEsYyl7cmV0dXJuIG5kKGIsYyk/YTpYYy5hKGEsYyl9fShhLGIpLGEsYSl9dmFyIGI9bnVsbCxjPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShiLFxuZCxoKXt2YXIgbD1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBsPTAsbT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2w8bS5sZW5ndGg7KW1bbF09YXJndW1lbnRzW2wrMl0sKytsO2w9bmV3IEYobSwwKX1yZXR1cm4gYy5jYWxsKHRoaXMsYixkLGwpfWZ1bmN0aW9uIGMoYSxkLGUpe2E9UWgoZnVuY3Rpb24oYSl7cmV0dXJuLVEoYSl9LE5jLmQoZSxkLEtjKFthXSwwKSkpO3JldHVybiBBLmMoYixHKGEpLEgoYSkpfWEuaT0yO2EuZj1mdW5jdGlvbihhKXt2YXIgYj1HKGEpO2E9SyhhKTt2YXIgZD1HKGEpO2E9SChhKTtyZXR1cm4gYyhiLGQsYSl9O2EuZD1jO3JldHVybiBhfSgpLGI9ZnVuY3Rpb24oYixlLGYpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGI7Y2FzZSAyOnJldHVybiBhLmNhbGwodGhpcyxiLGUpO2RlZmF1bHQ6dmFyIGc9bnVsbDtpZigyPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZz0wLGg9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC1cbjIpO2c8aC5sZW5ndGg7KWhbZ109YXJndW1lbnRzW2crMl0sKytnO2c9bmV3IEYoaCwwKX1yZXR1cm4gYy5kKGIsZSxnKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yi5pPTI7Yi5mPWMuZjtiLmI9ZnVuY3Rpb24oYSl7cmV0dXJuIGF9O2IuYT1hO2IuZD1jLmQ7cmV0dXJuIGJ9KCksVGg9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEsYil7cmV0dXJuIFEoYSk8UShiKT9BLmMoZnVuY3Rpb24oYSxjKXtyZXR1cm4gbmQoYixjKT9YYy5hKGEsYyk6YX0sYSxhKTpBLmMoWGMsYSxiKX12YXIgYj1udWxsLGM9ZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGIsZCxoKXt2YXIgbD1udWxsO2lmKDI8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBsPTAsbT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTIpO2w8bS5sZW5ndGg7KW1bbF09YXJndW1lbnRzW2wrMl0sKytsO2w9bmV3IEYobSwwKX1yZXR1cm4gYy5jYWxsKHRoaXMsYixkLGwpfWZ1bmN0aW9uIGMoYSxkLFxuZSl7cmV0dXJuIEEuYyhiLGEsTmMuYShlLGQpKX1hLmk9MjthLmY9ZnVuY3Rpb24oYSl7dmFyIGI9RyhhKTthPUsoYSk7dmFyIGQ9RyhhKTthPUgoYSk7cmV0dXJuIGMoYixkLGEpfTthLmQ9YztyZXR1cm4gYX0oKSxiPWZ1bmN0aW9uKGIsZSxmKXtzd2l0Y2goYXJndW1lbnRzLmxlbmd0aCl7Y2FzZSAxOnJldHVybiBiO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYixlKTtkZWZhdWx0OnZhciBnPW51bGw7aWYoMjxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGc9MCxoPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMik7ZzxoLmxlbmd0aDspaFtnXT1hcmd1bWVudHNbZysyXSwrK2c7Zz1uZXcgRihoLDApfXJldHVybiBjLmQoYixlLGcpfXRocm93IEVycm9yKFwiSW52YWxpZCBhcml0eTogXCIrYXJndW1lbnRzLmxlbmd0aCk7fTtiLmk9MjtiLmY9Yy5mO2IuYj1mdW5jdGlvbihhKXtyZXR1cm4gYX07Yi5hPWE7Yi5kPWMuZDtyZXR1cm4gYn0oKTtcbmZ1bmN0aW9uIFVoKGEsYil7cmV0dXJuIEEuYyhmdW5jdGlvbihiLGQpe3ZhciBlPVIuYyhkLDAsbnVsbCksZj1SLmMoZCwxLG51bGwpO3JldHVybiBuZChhLGUpP1JjLmMoYixmLFMuYShhLGUpKTpifSxULmMoU2MsYSxUZyhiKSksYil9ZnVuY3Rpb24gVmgoYSxiKXtyZXR1cm4gQS5jKGZ1bmN0aW9uKGEsZCl7dmFyIGU9WWcoZCxiKTtyZXR1cm4gUmMuYyhhLGUsTmMuYShTLmMoYSxlLGJoKSxkKSl9LFVmLGEpfWZ1bmN0aW9uIFdoKGEpe3JldHVybiBBLmMoZnVuY3Rpb24oYSxjKXt2YXIgZD1SLmMoYywwLG51bGwpLGU9Ui5jKGMsMSxudWxsKTtyZXR1cm4gUmMuYyhhLGUsZCl9LFVmLGEpfVxudmFyIFhoPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIsYyl7YT1RKGEpPD1RKGIpP25ldyBXKG51bGwsMyw1LHVmLFthLGIsV2goYyldLG51bGwpOm5ldyBXKG51bGwsMyw1LHVmLFtiLGEsY10sbnVsbCk7Yj1SLmMoYSwwLG51bGwpO2M9Ui5jKGEsMSxudWxsKTt2YXIgZz1SLmMoYSwyLG51bGwpLGg9VmgoYixWZyhnKSk7cmV0dXJuIEEuYyhmdW5jdGlvbihhLGIsYyxkLGUpe3JldHVybiBmdW5jdGlvbihmLGcpe3ZhciBoPWZ1bmN0aW9uKCl7dmFyIGE9VWgoWWcoZyxUZyhkKSksZCk7cmV0dXJuIGUuYj9lLmIoYSk6ZS5jYWxsKG51bGwsYSl9KCk7cmV0dXJuIHQoaCk/QS5jKGZ1bmN0aW9uKCl7cmV0dXJuIGZ1bmN0aW9uKGEsYil7cmV0dXJuIE5jLmEoYSxXZy5kKEtjKFtiLGddLDApKSl9fShoLGEsYixjLGQsZSksZixoKTpmfX0oYSxiLGMsZyxoKSxiaCxjKX1mdW5jdGlvbiBiKGEsYil7aWYoRChhKSYmRChiKSl7dmFyIGM9U2guYShmaChUZyhHKGEpKSksZmgoVGcoRyhiKSkpKSxcbmc9UShhKTw9UShiKT9uZXcgVyhudWxsLDIsNSx1ZixbYSxiXSxudWxsKTpuZXcgVyhudWxsLDIsNSx1ZixbYixhXSxudWxsKSxoPVIuYyhnLDAsbnVsbCksbD1SLmMoZywxLG51bGwpLG09VmgoaCxjKTtyZXR1cm4gQS5jKGZ1bmN0aW9uKGEsYixjLGQsZSl7cmV0dXJuIGZ1bmN0aW9uKGYsZyl7dmFyIGg9ZnVuY3Rpb24oKXt2YXIgYj1ZZyhnLGEpO3JldHVybiBlLmI/ZS5iKGIpOmUuY2FsbChudWxsLGIpfSgpO3JldHVybiB0KGgpP0EuYyhmdW5jdGlvbigpe3JldHVybiBmdW5jdGlvbihhLGIpe3JldHVybiBOYy5hKGEsV2cuZChLYyhbYixnXSwwKSkpfX0oaCxhLGIsYyxkLGUpLGYsaCk6Zn19KGMsZyxoLGwsbSksYmgsbCl9cmV0dXJuIGJofXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUsZil7c3dpdGNoKGFyZ3VtZW50cy5sZW5ndGgpe2Nhc2UgMjpyZXR1cm4gYi5jYWxsKHRoaXMsYyxlKTtjYXNlIDM6cmV0dXJuIGEuY2FsbCh0aGlzLGMsZSxmKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK1xuYXJndW1lbnRzLmxlbmd0aCk7fTtjLmE9YjtjLmM9YTtyZXR1cm4gY30oKTtyKFwibW9yaS5hcHBseVwiLFQpO3IoXCJtb3JpLmFwcGx5LmYyXCIsVC5hKTtyKFwibW9yaS5hcHBseS5mM1wiLFQuYyk7cihcIm1vcmkuYXBwbHkuZjRcIixULm4pO3IoXCJtb3JpLmFwcGx5LmY1XCIsVC5yKTtyKFwibW9yaS5hcHBseS5mblwiLFQuSyk7cihcIm1vcmkuY291bnRcIixRKTtyKFwibW9yaS5kaXN0aW5jdFwiLGZ1bmN0aW9uKGEpe3JldHVybiBmdW5jdGlvbiBjKGEsZSl7cmV0dXJuIG5ldyBWKG51bGwsZnVuY3Rpb24oKXtyZXR1cm4gZnVuY3Rpb24oYSxkKXtmb3IoOzspe3ZhciBlPWEsbD1SLmMoZSwwLG51bGwpO2lmKGU9RChlKSlpZihuZChkLGwpKWw9SChlKSxlPWQsYT1sLGQ9ZTtlbHNlIHJldHVybiBNKGwsYyhIKGUpLE5jLmEoZCxsKSkpO2Vsc2UgcmV0dXJuIG51bGx9fS5jYWxsKG51bGwsYSxlKX0sbnVsbCxudWxsKX0oYSxiaCl9KTtyKFwibW9yaS5lbXB0eVwiLE9jKTtyKFwibW9yaS5maXJzdFwiLEcpO3IoXCJtb3JpLnNlY29uZFwiLExjKTtyKFwibW9yaS5uZXh0XCIsSyk7XG5yKFwibW9yaS5yZXN0XCIsSCk7cihcIm1vcmkuc2VxXCIsRCk7cihcIm1vcmkuY29ualwiLE5jKTtyKFwibW9yaS5jb25qLmYwXCIsTmMubCk7cihcIm1vcmkuY29uai5mMVwiLE5jLmIpO3IoXCJtb3JpLmNvbmouZjJcIixOYy5hKTtyKFwibW9yaS5jb25qLmZuXCIsTmMuSyk7cihcIm1vcmkuY29uc1wiLE0pO3IoXCJtb3JpLmZpbmRcIixmdW5jdGlvbihhLGIpe3JldHVybiBudWxsIT1hJiZiZChhKSYmbmQoYSxiKT9uZXcgVyhudWxsLDIsNSx1ZixbYixTLmEoYSxiKV0sbnVsbCk6bnVsbH0pO3IoXCJtb3JpLm50aFwiLFIpO3IoXCJtb3JpLm50aC5mMlwiLFIuYSk7cihcIm1vcmkubnRoLmYzXCIsUi5jKTtyKFwibW9yaS5sYXN0XCIsZnVuY3Rpb24oYSl7Zm9yKDs7KXt2YXIgYj1LKGEpO2lmKG51bGwhPWIpYT1iO2Vsc2UgcmV0dXJuIEcoYSl9fSk7cihcIm1vcmkuYXNzb2NcIixSYyk7cihcIm1vcmkuYXNzb2MuZjNcIixSYy5jKTtyKFwibW9yaS5hc3NvYy5mblwiLFJjLkspO3IoXCJtb3JpLmRpc3NvY1wiLFNjKTtcbnIoXCJtb3JpLmRpc3NvYy5mMVwiLFNjLmIpO3IoXCJtb3JpLmRpc3NvYy5mMlwiLFNjLmEpO3IoXCJtb3JpLmRpc3NvYy5mblwiLFNjLkspO3IoXCJtb3JpLmdldEluXCIsY2YpO3IoXCJtb3JpLmdldEluLmYyXCIsY2YuYSk7cihcIm1vcmkuZ2V0SW4uZjNcIixjZi5jKTtyKFwibW9yaS51cGRhdGVJblwiLGRmKTtyKFwibW9yaS51cGRhdGVJbi5mM1wiLGRmLmMpO3IoXCJtb3JpLnVwZGF0ZUluLmY0XCIsZGYubik7cihcIm1vcmkudXBkYXRlSW4uZjVcIixkZi5yKTtyKFwibW9yaS51cGRhdGVJbi5mNlwiLGRmLlApO3IoXCJtb3JpLnVwZGF0ZUluLmZuXCIsZGYuSyk7cihcIm1vcmkuYXNzb2NJblwiLGZ1bmN0aW9uIFloKGIsYyxkKXt2YXIgZT1SLmMoYywwLG51bGwpO3JldHVybihjPUVkKGMpKT9SYy5jKGIsZSxZaChTLmEoYixlKSxjLGQpKTpSYy5jKGIsZSxkKX0pO3IoXCJtb3JpLmZuaWxcIixLZSk7cihcIm1vcmkuZm5pbC5mMlwiLEtlLmEpO3IoXCJtb3JpLmZuaWwuZjNcIixLZS5jKTtyKFwibW9yaS5mbmlsLmY0XCIsS2Uubik7XG5yKFwibW9yaS5kaXNqXCIsWGMpO3IoXCJtb3JpLmRpc2ouZjFcIixYYy5iKTtyKFwibW9yaS5kaXNqLmYyXCIsWGMuYSk7cihcIm1vcmkuZGlzai5mblwiLFhjLkspO3IoXCJtb3JpLnBvcFwiLGZ1bmN0aW9uKGEpe3JldHVybiBudWxsPT1hP251bGw6bWIoYSl9KTtyKFwibW9yaS5wZWVrXCIsV2MpO3IoXCJtb3JpLmhhc2hcIixuYyk7cihcIm1vcmkuZ2V0XCIsUyk7cihcIm1vcmkuZ2V0LmYyXCIsUy5hKTtyKFwibW9yaS5nZXQuZjNcIixTLmMpO3IoXCJtb3JpLmhhc0tleVwiLG5kKTtyKFwibW9yaS5pc0VtcHR5XCIsWWMpO3IoXCJtb3JpLnJldmVyc2VcIixKZCk7cihcIm1vcmkudGFrZVwiLFBlKTtyKFwibW9yaS50YWtlLmYxXCIsUGUuYik7cihcIm1vcmkudGFrZS5mMlwiLFBlLmEpO3IoXCJtb3JpLmRyb3BcIixRZSk7cihcIm1vcmkuZHJvcC5mMVwiLFFlLmIpO3IoXCJtb3JpLmRyb3AuZjJcIixRZS5hKTtyKFwibW9yaS50YWtlTnRoXCIscmgpO3IoXCJtb3JpLnRha2VOdGguZjFcIixyaC5iKTtyKFwibW9yaS50YWtlTnRoLmYyXCIscmguYSk7XG5yKFwibW9yaS5wYXJ0aXRpb25cIixiZik7cihcIm1vcmkucGFydGl0aW9uLmYyXCIsYmYuYSk7cihcIm1vcmkucGFydGl0aW9uLmYzXCIsYmYuYyk7cihcIm1vcmkucGFydGl0aW9uLmY0XCIsYmYubik7cihcIm1vcmkucGFydGl0aW9uQWxsXCIsa2gpO3IoXCJtb3JpLnBhcnRpdGlvbkFsbC5mMVwiLGtoLmIpO3IoXCJtb3JpLnBhcnRpdGlvbkFsbC5mMlwiLGtoLmEpO3IoXCJtb3JpLnBhcnRpdGlvbkFsbC5mM1wiLGtoLmMpO3IoXCJtb3JpLnBhcnRpdGlvbkJ5XCIsdGgpO3IoXCJtb3JpLnBhcnRpdGlvbkJ5LmYxXCIsdGguYik7cihcIm1vcmkucGFydGl0aW9uQnkuZjJcIix0aC5hKTtyKFwibW9yaS5pdGVyYXRlXCIsZnVuY3Rpb24gWmgoYixjKXtyZXR1cm4gTShjLG5ldyBWKG51bGwsZnVuY3Rpb24oKXtyZXR1cm4gWmgoYixiLmI/Yi5iKGMpOmIuY2FsbChudWxsLGMpKX0sbnVsbCxudWxsKSl9KTtyKFwibW9yaS5pbnRvXCIsYWYpO3IoXCJtb3JpLmludG8uZjJcIixhZi5hKTtyKFwibW9yaS5pbnRvLmYzXCIsYWYuYyk7XG5yKFwibW9yaS5tZXJnZVwiLFdnKTtyKFwibW9yaS5tZXJnZVdpdGhcIixYZyk7cihcIm1vcmkuc3VidmVjXCIsQ2YpO3IoXCJtb3JpLnN1YnZlYy5mMlwiLENmLmEpO3IoXCJtb3JpLnN1YnZlYy5mM1wiLENmLmMpO3IoXCJtb3JpLnRha2VXaGlsZVwiLGxoKTtyKFwibW9yaS50YWtlV2hpbGUuZjFcIixsaC5iKTtyKFwibW9yaS50YWtlV2hpbGUuZjJcIixsaC5hKTtyKFwibW9yaS5kcm9wV2hpbGVcIixSZSk7cihcIm1vcmkuZHJvcFdoaWxlLmYxXCIsUmUuYik7cihcIm1vcmkuZHJvcFdoaWxlLmYyXCIsUmUuYSk7cihcIm1vcmkuZ3JvdXBCeVwiLGZ1bmN0aW9uKGEsYil7cmV0dXJuIGNlKEEuYyhmdW5jdGlvbihiLGQpe3ZhciBlPWEuYj9hLmIoZCk6YS5jYWxsKG51bGwsZCk7cmV0dXJuIGVlLmMoYixlLE5jLmEoUy5jKGIsZSxNYyksZCkpfSxPYihVZiksYikpfSk7cihcIm1vcmkuaW50ZXJwb3NlXCIsZnVuY3Rpb24oYSxiKXtyZXR1cm4gUWUuYSgxLFVlLmEoU2UuYihhKSxiKSl9KTtyKFwibW9yaS5pbnRlcmxlYXZlXCIsVWUpO1xucihcIm1vcmkuaW50ZXJsZWF2ZS5mMlwiLFVlLmEpO3IoXCJtb3JpLmludGVybGVhdmUuZm5cIixVZS5LKTtyKFwibW9yaS5jb25jYXRcIixhZSk7cihcIm1vcmkuY29uY2F0LmYwXCIsYWUubCk7cihcIm1vcmkuY29uY2F0LmYxXCIsYWUuYik7cihcIm1vcmkuY29uY2F0LmYyXCIsYWUuYSk7cihcIm1vcmkuY29uY2F0LmZuXCIsYWUuSyk7ZnVuY3Rpb24gJGUoYSl7cmV0dXJuIGEgaW5zdGFuY2VvZiBBcnJheXx8Y2QoYSl9cihcIm1vcmkuZmxhdHRlblwiLGZ1bmN0aW9uKGEpe3JldHVybiBYZS5hKGZ1bmN0aW9uKGEpe3JldHVybiEkZShhKX0sSChaZShhKSkpfSk7cihcIm1vcmkubGF6eVNlcVwiLGZ1bmN0aW9uKGEpe3JldHVybiBuZXcgVihudWxsLGEsbnVsbCxudWxsKX0pO3IoXCJtb3JpLmtleXNcIixUZyk7cihcIm1vcmkuc2VsZWN0S2V5c1wiLFlnKTtyKFwibW9yaS52YWxzXCIsVmcpO3IoXCJtb3JpLnByaW1TZXFcIixKYyk7cihcIm1vcmkucHJpbVNlcS5mMVwiLEpjLmIpO3IoXCJtb3JpLnByaW1TZXEuZjJcIixKYy5hKTtcbnIoXCJtb3JpLm1hcFwiLE9lKTtyKFwibW9yaS5tYXAuZjFcIixPZS5iKTtyKFwibW9yaS5tYXAuZjJcIixPZS5hKTtyKFwibW9yaS5tYXAuZjNcIixPZS5jKTtyKFwibW9yaS5tYXAuZjRcIixPZS5uKTtyKFwibW9yaS5tYXAuZm5cIixPZS5LKTtcbnIoXCJtb3JpLm1hcEluZGV4ZWRcIixmdW5jdGlvbihhLGIpe3JldHVybiBmdW5jdGlvbiBkKGIsZil7cmV0dXJuIG5ldyBWKG51bGwsZnVuY3Rpb24oKXt2YXIgZz1EKGYpO2lmKGcpe2lmKGZkKGcpKXtmb3IodmFyIGg9WWIoZyksbD1RKGgpLG09VGQobCkscD0wOzspaWYocDxsKVhkKG0sZnVuY3Rpb24oKXt2YXIgZD1iK3AsZj1DLmEoaCxwKTtyZXR1cm4gYS5hP2EuYShkLGYpOmEuY2FsbChudWxsLGQsZil9KCkpLHArPTE7ZWxzZSBicmVhaztyZXR1cm4gV2QobS5jYSgpLGQoYitsLFpiKGcpKSl9cmV0dXJuIE0oZnVuY3Rpb24oKXt2YXIgZD1HKGcpO3JldHVybiBhLmE/YS5hKGIsZCk6YS5jYWxsKG51bGwsYixkKX0oKSxkKGIrMSxIKGcpKSl9cmV0dXJuIG51bGx9LG51bGwsbnVsbCl9KDAsYil9KTtyKFwibW9yaS5tYXBjYXRcIixXZSk7cihcIm1vcmkubWFwY2F0LmYxXCIsV2UuYik7cihcIm1vcmkubWFwY2F0LmZuXCIsV2UuSyk7cihcIm1vcmkucmVkdWNlXCIsQSk7XG5yKFwibW9yaS5yZWR1Y2UuZjJcIixBLmEpO3IoXCJtb3JpLnJlZHVjZS5mM1wiLEEuYyk7cihcIm1vcmkucmVkdWNlS1ZcIixmdW5jdGlvbihhLGIsYyl7cmV0dXJuIG51bGwhPWM/eGIoYyxhLGIpOmJ9KTtyKFwibW9yaS5rZWVwXCIsTGUpO3IoXCJtb3JpLmtlZXAuZjFcIixMZS5iKTtyKFwibW9yaS5rZWVwLmYyXCIsTGUuYSk7cihcIm1vcmkua2VlcEluZGV4ZWRcIixOZSk7cihcIm1vcmkua2VlcEluZGV4ZWQuZjFcIixOZS5iKTtyKFwibW9yaS5rZWVwSW5kZXhlZC5mMlwiLE5lLmEpO3IoXCJtb3JpLmZpbHRlclwiLFhlKTtyKFwibW9yaS5maWx0ZXIuZjFcIixYZS5iKTtyKFwibW9yaS5maWx0ZXIuZjJcIixYZS5hKTtyKFwibW9yaS5yZW1vdmVcIixZZSk7cihcIm1vcmkucmVtb3ZlLmYxXCIsWWUuYik7cihcIm1vcmkucmVtb3ZlLmYyXCIsWWUuYSk7cihcIm1vcmkuc29tZVwiLEZlKTtyKFwibW9yaS5ldmVyeVwiLEVlKTtyKFwibW9yaS5lcXVhbHNcIixzYyk7cihcIm1vcmkuZXF1YWxzLmYxXCIsc2MuYik7XG5yKFwibW9yaS5lcXVhbHMuZjJcIixzYy5hKTtyKFwibW9yaS5lcXVhbHMuZm5cIixzYy5LKTtyKFwibW9yaS5yYW5nZVwiLHFoKTtyKFwibW9yaS5yYW5nZS5mMFwiLHFoLmwpO3IoXCJtb3JpLnJhbmdlLmYxXCIscWguYik7cihcIm1vcmkucmFuZ2UuZjJcIixxaC5hKTtyKFwibW9yaS5yYW5nZS5mM1wiLHFoLmMpO3IoXCJtb3JpLnJlcGVhdFwiLFNlKTtyKFwibW9yaS5yZXBlYXQuZjFcIixTZS5iKTtyKFwibW9yaS5yZXBlYXQuZjJcIixTZS5hKTtyKFwibW9yaS5yZXBlYXRlZGx5XCIsVGUpO3IoXCJtb3JpLnJlcGVhdGVkbHkuZjFcIixUZS5iKTtyKFwibW9yaS5yZXBlYXRlZGx5LmYyXCIsVGUuYSk7cihcIm1vcmkuc29ydFwiLHNkKTtyKFwibW9yaS5zb3J0LmYxXCIsc2QuYik7cihcIm1vcmkuc29ydC5mMlwiLHNkLmEpO3IoXCJtb3JpLnNvcnRCeVwiLHRkKTtyKFwibW9yaS5zb3J0QnkuZjJcIix0ZC5hKTtyKFwibW9yaS5zb3J0QnkuZjNcIix0ZC5jKTtyKFwibW9yaS5pbnRvQXJyYXlcIixJYSk7cihcIm1vcmkuaW50b0FycmF5LmYxXCIsSWEuYik7XG5yKFwibW9yaS5pbnRvQXJyYXkuZjJcIixJYS5hKTtyKFwibW9yaS5zdWJzZXFcIixuaCk7cihcIm1vcmkuc3Vic2VxLmYzXCIsbmguYyk7cihcIm1vcmkuc3Vic2VxLmY1XCIsbmgucik7cihcIm1vcmkuZGVkdXBlXCIsRmgpO3IoXCJtb3JpLmRlZHVwZS5mMFwiLEZoLmwpO3IoXCJtb3JpLmRlZHVwZS5mMVwiLEZoLmIpO3IoXCJtb3JpLnRyYW5zZHVjZVwiLHdkKTtyKFwibW9yaS50cmFuc2R1Y2UuZjNcIix3ZC5jKTtyKFwibW9yaS50cmFuc2R1Y2UuZjRcIix3ZC5uKTtyKFwibW9yaS5lZHVjdGlvblwiLGZ1bmN0aW9uKGEsYil7cmV0dXJuIG5ldyBHaChhLGIpfSk7cihcIm1vcmkuc2VxdWVuY2VcIixDZSk7cihcIm1vcmkuc2VxdWVuY2UuZjFcIixDZS5iKTtyKFwibW9yaS5zZXF1ZW5jZS5mMlwiLENlLmEpO3IoXCJtb3JpLnNlcXVlbmNlLmZuXCIsQ2UuSyk7cihcIm1vcmkuY29tcGxldGluZ1wiLHZkKTtyKFwibW9yaS5jb21wbGV0aW5nLmYxXCIsdmQuYik7cihcIm1vcmkuY29tcGxldGluZy5mMlwiLHZkLmEpO3IoXCJtb3JpLmxpc3RcIixLZCk7XG5yKFwibW9yaS52ZWN0b3JcIixBZik7cihcIm1vcmkuaGFzaE1hcFwiLFBnKTtyKFwibW9yaS5zZXRcIixmaCk7cihcIm1vcmkuc29ydGVkU2V0XCIsZ2gpO3IoXCJtb3JpLnNvcnRlZFNldEJ5XCIsaGgpO3IoXCJtb3JpLnNvcnRlZE1hcFwiLFFnKTtyKFwibW9yaS5zb3J0ZWRNYXBCeVwiLFJnKTtyKFwibW9yaS5xdWV1ZVwiLGZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhKXt2YXIgZD1udWxsO2lmKDA8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBkPTAsZT1BcnJheShhcmd1bWVudHMubGVuZ3RoLTApO2Q8ZS5sZW5ndGg7KWVbZF09YXJndW1lbnRzW2QrMF0sKytkO2Q9bmV3IEYoZSwwKX1yZXR1cm4gYi5jYWxsKHRoaXMsZCl9ZnVuY3Rpb24gYihhKXtyZXR1cm4gYWYuYT9hZi5hKE1mLGEpOmFmLmNhbGwobnVsbCxNZixhKX1hLmk9MDthLmY9ZnVuY3Rpb24oYSl7YT1EKGEpO3JldHVybiBiKGEpfTthLmQ9YjtyZXR1cm4gYX0oKSk7cihcIm1vcmkua2V5d29yZFwiLFBkKTtyKFwibW9yaS5rZXl3b3JkLmYxXCIsUGQuYik7XG5yKFwibW9yaS5rZXl3b3JkLmYyXCIsUGQuYSk7cihcIm1vcmkuc3ltYm9sXCIscmMpO3IoXCJtb3JpLnN5bWJvbC5mMVwiLHJjLmIpO3IoXCJtb3JpLnN5bWJvbC5mMlwiLHJjLmEpO3IoXCJtb3JpLnppcG1hcFwiLGZ1bmN0aW9uKGEsYil7Zm9yKHZhciBjPU9iKFVmKSxkPUQoYSksZT1EKGIpOzspaWYoZCYmZSljPWVlLmMoYyxHKGQpLEcoZSkpLGQ9SyhkKSxlPUsoZSk7ZWxzZSByZXR1cm4gUWIoYyl9KTtyKFwibW9yaS5pc0xpc3RcIixmdW5jdGlvbihhKXtyZXR1cm4gYT9hLmomMzM1NTQ0MzJ8fGEud2M/ITA6YS5qPyExOncoRWIsYSk6dyhFYixhKX0pO3IoXCJtb3JpLmlzU2VxXCIsa2QpO3IoXCJtb3JpLmlzVmVjdG9yXCIsZWQpO3IoXCJtb3JpLmlzTWFwXCIsZGQpO3IoXCJtb3JpLmlzU2V0XCIsYWQpO3IoXCJtb3JpLmlzS2V5d29yZFwiLGZ1bmN0aW9uKGEpe3JldHVybiBhIGluc3RhbmNlb2YgVX0pO3IoXCJtb3JpLmlzU3ltYm9sXCIsZnVuY3Rpb24oYSl7cmV0dXJuIGEgaW5zdGFuY2VvZiBxY30pO1xucihcIm1vcmkuaXNDb2xsZWN0aW9uXCIsJGMpO3IoXCJtb3JpLmlzU2VxdWVudGlhbFwiLGNkKTtyKFwibW9yaS5pc0Fzc29jaWF0aXZlXCIsYmQpO3IoXCJtb3JpLmlzQ291bnRlZFwiLEVjKTtyKFwibW9yaS5pc0luZGV4ZWRcIixGYyk7cihcIm1vcmkuaXNSZWR1Y2VhYmxlXCIsZnVuY3Rpb24oYSl7cmV0dXJuIGE/YS5qJjUyNDI4OHx8YS5TYj8hMDphLmo/ITE6dyh2YixhKTp3KHZiLGEpfSk7cihcIm1vcmkuaXNTZXFhYmxlXCIsbGQpO3IoXCJtb3JpLmlzUmV2ZXJzaWJsZVwiLElkKTtyKFwibW9yaS51bmlvblwiLFJoKTtyKFwibW9yaS51bmlvbi5mMFwiLFJoLmwpO3IoXCJtb3JpLnVuaW9uLmYxXCIsUmguYik7cihcIm1vcmkudW5pb24uZjJcIixSaC5hKTtyKFwibW9yaS51bmlvbi5mblwiLFJoLkspO3IoXCJtb3JpLmludGVyc2VjdGlvblwiLFNoKTtyKFwibW9yaS5pbnRlcnNlY3Rpb24uZjFcIixTaC5iKTtyKFwibW9yaS5pbnRlcnNlY3Rpb24uZjJcIixTaC5hKTtyKFwibW9yaS5pbnRlcnNlY3Rpb24uZm5cIixTaC5LKTtcbnIoXCJtb3JpLmRpZmZlcmVuY2VcIixUaCk7cihcIm1vcmkuZGlmZmVyZW5jZS5mMVwiLFRoLmIpO3IoXCJtb3JpLmRpZmZlcmVuY2UuZjJcIixUaC5hKTtyKFwibW9yaS5kaWZmZXJlbmNlLmZuXCIsVGguSyk7cihcIm1vcmkuam9pblwiLFhoKTtyKFwibW9yaS5qb2luLmYyXCIsWGguYSk7cihcIm1vcmkuam9pbi5mM1wiLFhoLmMpO3IoXCJtb3JpLmluZGV4XCIsVmgpO3IoXCJtb3JpLnByb2plY3RcIixmdW5jdGlvbihhLGIpe3JldHVybiBmaChPZS5hKGZ1bmN0aW9uKGEpe3JldHVybiBZZyhhLGIpfSxhKSl9KTtyKFwibW9yaS5tYXBJbnZlcnRcIixXaCk7cihcIm1vcmkucmVuYW1lXCIsZnVuY3Rpb24oYSxiKXtyZXR1cm4gZmgoT2UuYShmdW5jdGlvbihhKXtyZXR1cm4gVWgoYSxiKX0sYSkpfSk7cihcIm1vcmkucmVuYW1lS2V5c1wiLFVoKTtyKFwibW9yaS5pc1N1YnNldFwiLGZ1bmN0aW9uKGEsYil7cmV0dXJuIFEoYSk8PVEoYikmJkVlKGZ1bmN0aW9uKGEpe3JldHVybiBuZChiLGEpfSxhKX0pO1xucihcIm1vcmkuaXNTdXBlcnNldFwiLGZ1bmN0aW9uKGEsYil7cmV0dXJuIFEoYSk+PVEoYikmJkVlKGZ1bmN0aW9uKGIpe3JldHVybiBuZChhLGIpfSxiKX0pO3IoXCJtb3JpLm5vdEVxdWFsc1wiLGplKTtyKFwibW9yaS5ub3RFcXVhbHMuZjFcIixqZS5iKTtyKFwibW9yaS5ub3RFcXVhbHMuZjJcIixqZS5hKTtyKFwibW9yaS5ub3RFcXVhbHMuZm5cIixqZS5LKTtyKFwibW9yaS5ndFwiLEFkKTtyKFwibW9yaS5ndC5mMVwiLEFkLmIpO3IoXCJtb3JpLmd0LmYyXCIsQWQuYSk7cihcIm1vcmkuZ3QuZm5cIixBZC5LKTtyKFwibW9yaS5ndGVcIixCZCk7cihcIm1vcmkuZ3RlLmYxXCIsQmQuYik7cihcIm1vcmkuZ3RlLmYyXCIsQmQuYSk7cihcIm1vcmkuZ3RlLmZuXCIsQmQuSyk7cihcIm1vcmkubHRcIix5ZCk7cihcIm1vcmkubHQuZjFcIix5ZC5iKTtyKFwibW9yaS5sdC5mMlwiLHlkLmEpO3IoXCJtb3JpLmx0LmZuXCIseWQuSyk7cihcIm1vcmkubHRlXCIsemQpO3IoXCJtb3JpLmx0ZS5mMVwiLHpkLmIpO3IoXCJtb3JpLmx0ZS5mMlwiLHpkLmEpO1xucihcIm1vcmkubHRlLmZuXCIsemQuSyk7cihcIm1vcmkuY29tcGFyZVwiLG9kKTtyKFwibW9yaS5wYXJ0aWFsXCIsSmUpO3IoXCJtb3JpLnBhcnRpYWwuZjFcIixKZS5iKTtyKFwibW9yaS5wYXJ0aWFsLmYyXCIsSmUuYSk7cihcIm1vcmkucGFydGlhbC5mM1wiLEplLmMpO3IoXCJtb3JpLnBhcnRpYWwuZjRcIixKZS5uKTtyKFwibW9yaS5wYXJ0aWFsLmZuXCIsSmUuSyk7cihcIm1vcmkuY29tcFwiLEllKTtyKFwibW9yaS5jb21wLmYwXCIsSWUubCk7cihcIm1vcmkuY29tcC5mMVwiLEllLmIpO3IoXCJtb3JpLmNvbXAuZjJcIixJZS5hKTtyKFwibW9yaS5jb21wLmYzXCIsSWUuYyk7cihcIm1vcmkuY29tcC5mblwiLEllLkspO1xucihcIm1vcmkucGlwZWxpbmVcIixmdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSl7dmFyIGQ9bnVsbDtpZigwPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZD0wLGU9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0wKTtkPGUubGVuZ3RoOyllW2RdPWFyZ3VtZW50c1tkKzBdLCsrZDtkPW5ldyBGKGUsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGQpfWZ1bmN0aW9uIGIoYSl7ZnVuY3Rpb24gYihhLGMpe3JldHVybiBjLmI/Yy5iKGEpOmMuY2FsbChudWxsLGEpfXJldHVybiBBLmE/QS5hKGIsYSk6QS5jYWxsKG51bGwsYixhKX1hLmk9MDthLmY9ZnVuY3Rpb24oYSl7YT1EKGEpO3JldHVybiBiKGEpfTthLmQ9YjtyZXR1cm4gYX0oKSk7XG5yKFwibW9yaS5jdXJyeVwiLGZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGQpe3ZhciBlPW51bGw7aWYoMTxhcmd1bWVudHMubGVuZ3RoKXtmb3IodmFyIGU9MCxmPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMSk7ZTxmLmxlbmd0aDspZltlXT1hcmd1bWVudHNbZSsxXSwrK2U7ZT1uZXcgRihmLDApfXJldHVybiBiLmNhbGwodGhpcyxhLGUpfWZ1bmN0aW9uIGIoYSxiKXtyZXR1cm4gZnVuY3Rpb24oZSl7cmV0dXJuIFQuYShhLE0uYT9NLmEoZSxiKTpNLmNhbGwobnVsbCxlLGIpKX19YS5pPTE7YS5mPWZ1bmN0aW9uKGEpe3ZhciBkPUcoYSk7YT1IKGEpO3JldHVybiBiKGQsYSl9O2EuZD1iO3JldHVybiBhfSgpKTtcbnIoXCJtb3JpLmp1eHRcIixmdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSl7dmFyIGQ9bnVsbDtpZigwPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZD0wLGU9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0wKTtkPGUubGVuZ3RoOyllW2RdPWFyZ3VtZW50c1tkKzBdLCsrZDtkPW5ldyBGKGUsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGQpfWZ1bmN0aW9uIGIoYSl7cmV0dXJuIGZ1bmN0aW9uKCl7ZnVuY3Rpb24gYihhKXt2YXIgYz1udWxsO2lmKDA8YXJndW1lbnRzLmxlbmd0aCl7Zm9yKHZhciBjPTAsZD1BcnJheShhcmd1bWVudHMubGVuZ3RoLTApO2M8ZC5sZW5ndGg7KWRbY109YXJndW1lbnRzW2MrMF0sKytjO2M9bmV3IEYoZCwwKX1yZXR1cm4gZS5jYWxsKHRoaXMsYyl9ZnVuY3Rpb24gZShiKXt2YXIgZD1mdW5jdGlvbigpe2Z1bmN0aW9uIGQoYSl7cmV0dXJuIFQuYShhLGIpfXJldHVybiBPZS5hP09lLmEoZCxhKTpPZS5jYWxsKG51bGwsZCxhKX0oKTtyZXR1cm4gSWEuYj9JYS5iKGQpOklhLmNhbGwobnVsbCxcbmQpfWIuaT0wO2IuZj1mdW5jdGlvbihhKXthPUQoYSk7cmV0dXJuIGUoYSl9O2IuZD1lO3JldHVybiBifSgpfWEuaT0wO2EuZj1mdW5jdGlvbihhKXthPUQoYSk7cmV0dXJuIGIoYSl9O2EuZD1iO3JldHVybiBhfSgpKTtcbnIoXCJtb3JpLmtuaXRcIixmdW5jdGlvbigpe2Z1bmN0aW9uIGEoYSl7dmFyIGQ9bnVsbDtpZigwPGFyZ3VtZW50cy5sZW5ndGgpe2Zvcih2YXIgZD0wLGU9QXJyYXkoYXJndW1lbnRzLmxlbmd0aC0wKTtkPGUubGVuZ3RoOyllW2RdPWFyZ3VtZW50c1tkKzBdLCsrZDtkPW5ldyBGKGUsMCl9cmV0dXJuIGIuY2FsbCh0aGlzLGQpfWZ1bmN0aW9uIGIoYSl7cmV0dXJuIGZ1bmN0aW9uKGIpe3ZhciBlPWZ1bmN0aW9uKCl7ZnVuY3Rpb24gZShhLGIpe3JldHVybiBhLmI/YS5iKGIpOmEuY2FsbChudWxsLGIpfXJldHVybiBPZS5jP09lLmMoZSxhLGIpOk9lLmNhbGwobnVsbCxlLGEsYil9KCk7cmV0dXJuIElhLmI/SWEuYihlKTpJYS5jYWxsKG51bGwsZSl9fWEuaT0wO2EuZj1mdW5jdGlvbihhKXthPUQoYSk7cmV0dXJuIGIoYSl9O2EuZD1iO3JldHVybiBhfSgpKTtyKFwibW9yaS5zdW1cIix4ZCk7cihcIm1vcmkuc3VtLmYwXCIseGQubCk7cihcIm1vcmkuc3VtLmYxXCIseGQuYik7XG5yKFwibW9yaS5zdW0uZjJcIix4ZC5hKTtyKFwibW9yaS5zdW0uZm5cIix4ZC5LKTtyKFwibW9yaS5pbmNcIixmdW5jdGlvbihhKXtyZXR1cm4gYSsxfSk7cihcIm1vcmkuZGVjXCIsZnVuY3Rpb24oYSl7cmV0dXJuIGEtMX0pO3IoXCJtb3JpLmlzRXZlblwiLEdlKTtyKFwibW9yaS5pc09kZFwiLGZ1bmN0aW9uKGEpe3JldHVybiFHZShhKX0pO3IoXCJtb3JpLmVhY2hcIixmdW5jdGlvbihhLGIpe2Zvcih2YXIgYz1EKGEpLGQ9bnVsbCxlPTAsZj0wOzspaWYoZjxlKXt2YXIgZz1kLlEobnVsbCxmKTtiLmI/Yi5iKGcpOmIuY2FsbChudWxsLGcpO2YrPTF9ZWxzZSBpZihjPUQoYykpZmQoYyk/KGU9WWIoYyksYz1aYihjKSxkPWUsZT1RKGUpKTooZD1nPUcoYyksYi5iP2IuYihkKTpiLmNhbGwobnVsbCxkKSxjPUsoYyksZD1udWxsLGU9MCksZj0wO2Vsc2UgcmV0dXJuIG51bGx9KTtyKFwibW9yaS5pZGVudGl0eVwiLHVkKTtcbnIoXCJtb3JpLmNvbnN0YW50bHlcIixmdW5jdGlvbihhKXtyZXR1cm4gZnVuY3Rpb24oKXtmdW5jdGlvbiBiKGIpe2lmKDA8YXJndW1lbnRzLmxlbmd0aClmb3IodmFyIGQ9MCxlPUFycmF5KGFyZ3VtZW50cy5sZW5ndGgtMCk7ZDxlLmxlbmd0aDspZVtkXT1hcmd1bWVudHNbZCswXSwrK2Q7cmV0dXJuIGF9Yi5pPTA7Yi5mPWZ1bmN0aW9uKGIpe0QoYik7cmV0dXJuIGF9O2IuZD1mdW5jdGlvbigpe3JldHVybiBhfTtyZXR1cm4gYn0oKX0pO3IoXCJtb3JpLnRvSnNcIixLaCk7XG5yKFwibW9yaS50b0NsalwiLGZ1bmN0aW9uKCl7ZnVuY3Rpb24gYShhLGIpe3JldHVybiBQaC5kKGEsS2MoW09oLGJdLDApKX1mdW5jdGlvbiBiKGEpe3JldHVybiBQaC5iKGEpfXZhciBjPW51bGwsYz1mdW5jdGlvbihjLGUpe3N3aXRjaChhcmd1bWVudHMubGVuZ3RoKXtjYXNlIDE6cmV0dXJuIGIuY2FsbCh0aGlzLGMpO2Nhc2UgMjpyZXR1cm4gYS5jYWxsKHRoaXMsYyxlKX10aHJvdyBFcnJvcihcIkludmFsaWQgYXJpdHk6IFwiK2FyZ3VtZW50cy5sZW5ndGgpO307Yy5iPWI7Yy5hPWE7cmV0dXJuIGN9KCkpO3IoXCJtb3JpLmNvbmZpZ3VyZVwiLGZ1bmN0aW9uKGEsYil7c3dpdGNoKGEpe2Nhc2UgXCJwcmludC1sZW5ndGhcIjpyZXR1cm4gbGE9YjtjYXNlIFwicHJpbnQtbGV2ZWxcIjpyZXR1cm4gbWE9YjtkZWZhdWx0OnRocm93IEVycm9yKFt6KFwiTm8gbWF0Y2hpbmcgY2xhdXNlOiBcIikseihhKV0uam9pbihcIlwiKSk7fX0pO3IoXCJtb3JpLm1ldGFcIixWYyk7cihcIm1vcmkud2l0aE1ldGFcIixPKTtcbnIoXCJtb3JpLnZhcnlNZXRhXCIsaWUpO3IoXCJtb3JpLnZhcnlNZXRhLmYyXCIsaWUuYSk7cihcIm1vcmkudmFyeU1ldGEuZjNcIixpZS5jKTtyKFwibW9yaS52YXJ5TWV0YS5mNFwiLGllLm4pO3IoXCJtb3JpLnZhcnlNZXRhLmY1XCIsaWUucik7cihcIm1vcmkudmFyeU1ldGEuZjZcIixpZS5QKTtyKFwibW9yaS52YXJ5TWV0YS5mblwiLGllLkspO3IoXCJtb3JpLmFsdGVyTWV0YVwiLERoKTtyKFwibW9yaS5yZXNldE1ldGFcIixmdW5jdGlvbihhLGIpe3JldHVybiBhLms9Yn0pO1YucHJvdG90eXBlLmluc3BlY3Q9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy50b1N0cmluZygpfTtGLnByb3RvdHlwZS5pbnNwZWN0PWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudG9TdHJpbmcoKX07SGMucHJvdG90eXBlLmluc3BlY3Q9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy50b1N0cmluZygpfTt3Zy5wcm90b3R5cGUuaW5zcGVjdD1mdW5jdGlvbigpe3JldHVybiB0aGlzLnRvU3RyaW5nKCl9O3BnLnByb3RvdHlwZS5pbnNwZWN0PWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudG9TdHJpbmcoKX07XG5xZy5wcm90b3R5cGUuaW5zcGVjdD1mdW5jdGlvbigpe3JldHVybiB0aGlzLnRvU3RyaW5nKCl9O0ZkLnByb3RvdHlwZS5pbnNwZWN0PWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudG9TdHJpbmcoKX07TGQucHJvdG90eXBlLmluc3BlY3Q9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy50b1N0cmluZygpfTtIZC5wcm90b3R5cGUuaW5zcGVjdD1mdW5jdGlvbigpe3JldHVybiB0aGlzLnRvU3RyaW5nKCl9O1cucHJvdG90eXBlLmluc3BlY3Q9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy50b1N0cmluZygpfTtWZC5wcm90b3R5cGUuaW5zcGVjdD1mdW5jdGlvbigpe3JldHVybiB0aGlzLnRvU3RyaW5nKCl9O0JmLnByb3RvdHlwZS5pbnNwZWN0PWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudG9TdHJpbmcoKX07RGYucHJvdG90eXBlLmluc3BlY3Q9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy50b1N0cmluZygpfTtaLnByb3RvdHlwZS5pbnNwZWN0PWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudG9TdHJpbmcoKX07XG5YLnByb3RvdHlwZS5pbnNwZWN0PWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudG9TdHJpbmcoKX07cGEucHJvdG90eXBlLmluc3BlY3Q9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy50b1N0cmluZygpfTtyZy5wcm90b3R5cGUuaW5zcGVjdD1mdW5jdGlvbigpe3JldHVybiB0aGlzLnRvU3RyaW5nKCl9O0xnLnByb3RvdHlwZS5pbnNwZWN0PWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudG9TdHJpbmcoKX07JGcucHJvdG90eXBlLmluc3BlY3Q9ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy50b1N0cmluZygpfTtjaC5wcm90b3R5cGUuaW5zcGVjdD1mdW5jdGlvbigpe3JldHVybiB0aGlzLnRvU3RyaW5nKCl9O3BoLnByb3RvdHlwZS5pbnNwZWN0PWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudG9TdHJpbmcoKX07VS5wcm90b3R5cGUuaW5zcGVjdD1mdW5jdGlvbigpe3JldHVybiB0aGlzLnRvU3RyaW5nKCl9O3FjLnByb3RvdHlwZS5pbnNwZWN0PWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudG9TdHJpbmcoKX07XG5MZi5wcm90b3R5cGUuaW5zcGVjdD1mdW5jdGlvbigpe3JldHVybiB0aGlzLnRvU3RyaW5nKCl9O0tmLnByb3RvdHlwZS5pbnNwZWN0PWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudG9TdHJpbmcoKX07cihcIm1vcmkubXV0YWJsZS50aGF3XCIsZnVuY3Rpb24oYSl7cmV0dXJuIE9iKGEpfSk7cihcIm1vcmkubXV0YWJsZS5mcmVlemVcIixjZSk7cihcIm1vcmkubXV0YWJsZS5jb25qXCIsZGUpO3IoXCJtb3JpLm11dGFibGUuY29uai5mMFwiLGRlLmwpO3IoXCJtb3JpLm11dGFibGUuY29uai5mMVwiLGRlLmIpO3IoXCJtb3JpLm11dGFibGUuY29uai5mMlwiLGRlLmEpO3IoXCJtb3JpLm11dGFibGUuY29uai5mblwiLGRlLkspO3IoXCJtb3JpLm11dGFibGUuYXNzb2NcIixlZSk7cihcIm1vcmkubXV0YWJsZS5hc3NvYy5mM1wiLGVlLmMpO3IoXCJtb3JpLm11dGFibGUuYXNzb2MuZm5cIixlZS5LKTtyKFwibW9yaS5tdXRhYmxlLmRpc3NvY1wiLGZlKTtyKFwibW9yaS5tdXRhYmxlLmRpc3NvYy5mMlwiLGZlLmEpO3IoXCJtb3JpLm11dGFibGUuZGlzc29jLmZuXCIsZmUuSyk7cihcIm1vcmkubXV0YWJsZS5wb3BcIixmdW5jdGlvbihhKXtyZXR1cm4gVWIoYSl9KTtyKFwibW9yaS5tdXRhYmxlLmRpc2pcIixnZSk7XG5yKFwibW9yaS5tdXRhYmxlLmRpc2ouZjJcIixnZS5hKTtyKFwibW9yaS5tdXRhYmxlLmRpc2ouZm5cIixnZS5LKTs7cmV0dXJuIHRoaXMubW9yaTt9LmNhbGwoe30pO30pO1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG5tb2R1bGUuZXhwb3J0cyA9IHJlcXVpcmUoJy4vbGliJylcbiIsIid1c2Ugc3RyaWN0JztcblxudmFyIGFzYXAgPSByZXF1aXJlKCdhc2FwL3JhdycpO1xuXG5mdW5jdGlvbiBub29wKCkge31cblxuLy8gU3RhdGVzOlxuLy9cbi8vIDAgLSBwZW5kaW5nXG4vLyAxIC0gZnVsZmlsbGVkIHdpdGggX3ZhbHVlXG4vLyAyIC0gcmVqZWN0ZWQgd2l0aCBfdmFsdWVcbi8vIDMgLSBhZG9wdGVkIHRoZSBzdGF0ZSBvZiBhbm90aGVyIHByb21pc2UsIF92YWx1ZVxuLy9cbi8vIG9uY2UgdGhlIHN0YXRlIGlzIG5vIGxvbmdlciBwZW5kaW5nICgwKSBpdCBpcyBpbW11dGFibGVcblxuLy8gQWxsIGBfYCBwcmVmaXhlZCBwcm9wZXJ0aWVzIHdpbGwgYmUgcmVkdWNlZCB0byBgX3tyYW5kb20gbnVtYmVyfWBcbi8vIGF0IGJ1aWxkIHRpbWUgdG8gb2JmdXNjYXRlIHRoZW0gYW5kIGRpc2NvdXJhZ2UgdGhlaXIgdXNlLlxuLy8gV2UgZG9uJ3QgdXNlIHN5bWJvbHMgb3IgT2JqZWN0LmRlZmluZVByb3BlcnR5IHRvIGZ1bGx5IGhpZGUgdGhlbVxuLy8gYmVjYXVzZSB0aGUgcGVyZm9ybWFuY2UgaXNuJ3QgZ29vZCBlbm91Z2guXG5cblxuLy8gdG8gYXZvaWQgdXNpbmcgdHJ5L2NhdGNoIGluc2lkZSBjcml0aWNhbCBmdW5jdGlvbnMsIHdlXG4vLyBleHRyYWN0IHRoZW0gdG8gaGVyZS5cbnZhciBMQVNUX0VSUk9SID0gbnVsbDtcbnZhciBJU19FUlJPUiA9IHt9O1xuZnVuY3Rpb24gZ2V0VGhlbihvYmopIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gb2JqLnRoZW47XG4gIH0gY2F0Y2ggKGV4KSB7XG4gICAgTEFTVF9FUlJPUiA9IGV4O1xuICAgIHJldHVybiBJU19FUlJPUjtcbiAgfVxufVxuXG5mdW5jdGlvbiB0cnlDYWxsT25lKGZuLCBhKSB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGZuKGEpO1xuICB9IGNhdGNoIChleCkge1xuICAgIExBU1RfRVJST1IgPSBleDtcbiAgICByZXR1cm4gSVNfRVJST1I7XG4gIH1cbn1cbmZ1bmN0aW9uIHRyeUNhbGxUd28oZm4sIGEsIGIpIHtcbiAgdHJ5IHtcbiAgICBmbihhLCBiKTtcbiAgfSBjYXRjaCAoZXgpIHtcbiAgICBMQVNUX0VSUk9SID0gZXg7XG4gICAgcmV0dXJuIElTX0VSUk9SO1xuICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gUHJvbWlzZTtcblxuZnVuY3Rpb24gUHJvbWlzZShmbikge1xuICBpZiAodHlwZW9mIHRoaXMgIT09ICdvYmplY3QnKSB7XG4gICAgdGhyb3cgbmV3IFR5cGVFcnJvcignUHJvbWlzZXMgbXVzdCBiZSBjb25zdHJ1Y3RlZCB2aWEgbmV3Jyk7XG4gIH1cbiAgaWYgKHR5cGVvZiBmbiAhPT0gJ2Z1bmN0aW9uJykge1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ25vdCBhIGZ1bmN0aW9uJyk7XG4gIH1cbiAgdGhpcy5fNDUgPSAwO1xuICB0aGlzLl84MSA9IDA7XG4gIHRoaXMuXzY1ID0gbnVsbDtcbiAgdGhpcy5fNTQgPSBudWxsO1xuICBpZiAoZm4gPT09IG5vb3ApIHJldHVybjtcbiAgZG9SZXNvbHZlKGZuLCB0aGlzKTtcbn1cblByb21pc2UuXzEwID0gbnVsbDtcblByb21pc2UuXzk3ID0gbnVsbDtcblByb21pc2UuXzYxID0gbm9vcDtcblxuUHJvbWlzZS5wcm90b3R5cGUudGhlbiA9IGZ1bmN0aW9uKG9uRnVsZmlsbGVkLCBvblJlamVjdGVkKSB7XG4gIGlmICh0aGlzLmNvbnN0cnVjdG9yICE9PSBQcm9taXNlKSB7XG4gICAgcmV0dXJuIHNhZmVUaGVuKHRoaXMsIG9uRnVsZmlsbGVkLCBvblJlamVjdGVkKTtcbiAgfVxuICB2YXIgcmVzID0gbmV3IFByb21pc2Uobm9vcCk7XG4gIGhhbmRsZSh0aGlzLCBuZXcgSGFuZGxlcihvbkZ1bGZpbGxlZCwgb25SZWplY3RlZCwgcmVzKSk7XG4gIHJldHVybiByZXM7XG59O1xuXG5mdW5jdGlvbiBzYWZlVGhlbihzZWxmLCBvbkZ1bGZpbGxlZCwgb25SZWplY3RlZCkge1xuICByZXR1cm4gbmV3IHNlbGYuY29uc3RydWN0b3IoZnVuY3Rpb24gKHJlc29sdmUsIHJlamVjdCkge1xuICAgIHZhciByZXMgPSBuZXcgUHJvbWlzZShub29wKTtcbiAgICByZXMudGhlbihyZXNvbHZlLCByZWplY3QpO1xuICAgIGhhbmRsZShzZWxmLCBuZXcgSGFuZGxlcihvbkZ1bGZpbGxlZCwgb25SZWplY3RlZCwgcmVzKSk7XG4gIH0pO1xufTtcbmZ1bmN0aW9uIGhhbmRsZShzZWxmLCBkZWZlcnJlZCkge1xuICB3aGlsZSAoc2VsZi5fODEgPT09IDMpIHtcbiAgICBzZWxmID0gc2VsZi5fNjU7XG4gIH1cbiAgaWYgKFByb21pc2UuXzEwKSB7XG4gICAgUHJvbWlzZS5fMTAoc2VsZik7XG4gIH1cbiAgaWYgKHNlbGYuXzgxID09PSAwKSB7XG4gICAgaWYgKHNlbGYuXzQ1ID09PSAwKSB7XG4gICAgICBzZWxmLl80NSA9IDE7XG4gICAgICBzZWxmLl81NCA9IGRlZmVycmVkO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAoc2VsZi5fNDUgPT09IDEpIHtcbiAgICAgIHNlbGYuXzQ1ID0gMjtcbiAgICAgIHNlbGYuXzU0ID0gW3NlbGYuXzU0LCBkZWZlcnJlZF07XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHNlbGYuXzU0LnB1c2goZGVmZXJyZWQpO1xuICAgIHJldHVybjtcbiAgfVxuICBoYW5kbGVSZXNvbHZlZChzZWxmLCBkZWZlcnJlZCk7XG59XG5cbmZ1bmN0aW9uIGhhbmRsZVJlc29sdmVkKHNlbGYsIGRlZmVycmVkKSB7XG4gIGFzYXAoZnVuY3Rpb24oKSB7XG4gICAgdmFyIGNiID0gc2VsZi5fODEgPT09IDEgPyBkZWZlcnJlZC5vbkZ1bGZpbGxlZCA6IGRlZmVycmVkLm9uUmVqZWN0ZWQ7XG4gICAgaWYgKGNiID09PSBudWxsKSB7XG4gICAgICBpZiAoc2VsZi5fODEgPT09IDEpIHtcbiAgICAgICAgcmVzb2x2ZShkZWZlcnJlZC5wcm9taXNlLCBzZWxmLl82NSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZWplY3QoZGVmZXJyZWQucHJvbWlzZSwgc2VsZi5fNjUpO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB2YXIgcmV0ID0gdHJ5Q2FsbE9uZShjYiwgc2VsZi5fNjUpO1xuICAgIGlmIChyZXQgPT09IElTX0VSUk9SKSB7XG4gICAgICByZWplY3QoZGVmZXJyZWQucHJvbWlzZSwgTEFTVF9FUlJPUik7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJlc29sdmUoZGVmZXJyZWQucHJvbWlzZSwgcmV0KTtcbiAgICB9XG4gIH0pO1xufVxuZnVuY3Rpb24gcmVzb2x2ZShzZWxmLCBuZXdWYWx1ZSkge1xuICAvLyBQcm9taXNlIFJlc29sdXRpb24gUHJvY2VkdXJlOiBodHRwczovL2dpdGh1Yi5jb20vcHJvbWlzZXMtYXBsdXMvcHJvbWlzZXMtc3BlYyN0aGUtcHJvbWlzZS1yZXNvbHV0aW9uLXByb2NlZHVyZVxuICBpZiAobmV3VmFsdWUgPT09IHNlbGYpIHtcbiAgICByZXR1cm4gcmVqZWN0KFxuICAgICAgc2VsZixcbiAgICAgIG5ldyBUeXBlRXJyb3IoJ0EgcHJvbWlzZSBjYW5ub3QgYmUgcmVzb2x2ZWQgd2l0aCBpdHNlbGYuJylcbiAgICApO1xuICB9XG4gIGlmIChcbiAgICBuZXdWYWx1ZSAmJlxuICAgICh0eXBlb2YgbmV3VmFsdWUgPT09ICdvYmplY3QnIHx8IHR5cGVvZiBuZXdWYWx1ZSA9PT0gJ2Z1bmN0aW9uJylcbiAgKSB7XG4gICAgdmFyIHRoZW4gPSBnZXRUaGVuKG5ld1ZhbHVlKTtcbiAgICBpZiAodGhlbiA9PT0gSVNfRVJST1IpIHtcbiAgICAgIHJldHVybiByZWplY3Qoc2VsZiwgTEFTVF9FUlJPUik7XG4gICAgfVxuICAgIGlmIChcbiAgICAgIHRoZW4gPT09IHNlbGYudGhlbiAmJlxuICAgICAgbmV3VmFsdWUgaW5zdGFuY2VvZiBQcm9taXNlXG4gICAgKSB7XG4gICAgICBzZWxmLl84MSA9IDM7XG4gICAgICBzZWxmLl82NSA9IG5ld1ZhbHVlO1xuICAgICAgZmluYWxlKHNlbGYpO1xuICAgICAgcmV0dXJuO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIHRoZW4gPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIGRvUmVzb2x2ZSh0aGVuLmJpbmQobmV3VmFsdWUpLCBzZWxmKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gIH1cbiAgc2VsZi5fODEgPSAxO1xuICBzZWxmLl82NSA9IG5ld1ZhbHVlO1xuICBmaW5hbGUoc2VsZik7XG59XG5cbmZ1bmN0aW9uIHJlamVjdChzZWxmLCBuZXdWYWx1ZSkge1xuICBzZWxmLl84MSA9IDI7XG4gIHNlbGYuXzY1ID0gbmV3VmFsdWU7XG4gIGlmIChQcm9taXNlLl85Nykge1xuICAgIFByb21pc2UuXzk3KHNlbGYsIG5ld1ZhbHVlKTtcbiAgfVxuICBmaW5hbGUoc2VsZik7XG59XG5mdW5jdGlvbiBmaW5hbGUoc2VsZikge1xuICBpZiAoc2VsZi5fNDUgPT09IDEpIHtcbiAgICBoYW5kbGUoc2VsZiwgc2VsZi5fNTQpO1xuICAgIHNlbGYuXzU0ID0gbnVsbDtcbiAgfVxuICBpZiAoc2VsZi5fNDUgPT09IDIpIHtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHNlbGYuXzU0Lmxlbmd0aDsgaSsrKSB7XG4gICAgICBoYW5kbGUoc2VsZiwgc2VsZi5fNTRbaV0pO1xuICAgIH1cbiAgICBzZWxmLl81NCA9IG51bGw7XG4gIH1cbn1cblxuZnVuY3Rpb24gSGFuZGxlcihvbkZ1bGZpbGxlZCwgb25SZWplY3RlZCwgcHJvbWlzZSl7XG4gIHRoaXMub25GdWxmaWxsZWQgPSB0eXBlb2Ygb25GdWxmaWxsZWQgPT09ICdmdW5jdGlvbicgPyBvbkZ1bGZpbGxlZCA6IG51bGw7XG4gIHRoaXMub25SZWplY3RlZCA9IHR5cGVvZiBvblJlamVjdGVkID09PSAnZnVuY3Rpb24nID8gb25SZWplY3RlZCA6IG51bGw7XG4gIHRoaXMucHJvbWlzZSA9IHByb21pc2U7XG59XG5cbi8qKlxuICogVGFrZSBhIHBvdGVudGlhbGx5IG1pc2JlaGF2aW5nIHJlc29sdmVyIGZ1bmN0aW9uIGFuZCBtYWtlIHN1cmVcbiAqIG9uRnVsZmlsbGVkIGFuZCBvblJlamVjdGVkIGFyZSBvbmx5IGNhbGxlZCBvbmNlLlxuICpcbiAqIE1ha2VzIG5vIGd1YXJhbnRlZXMgYWJvdXQgYXN5bmNocm9ueS5cbiAqL1xuZnVuY3Rpb24gZG9SZXNvbHZlKGZuLCBwcm9taXNlKSB7XG4gIHZhciBkb25lID0gZmFsc2U7XG4gIHZhciByZXMgPSB0cnlDYWxsVHdvKGZuLCBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICBpZiAoZG9uZSkgcmV0dXJuO1xuICAgIGRvbmUgPSB0cnVlO1xuICAgIHJlc29sdmUocHJvbWlzZSwgdmFsdWUpO1xuICB9LCBmdW5jdGlvbiAocmVhc29uKSB7XG4gICAgaWYgKGRvbmUpIHJldHVybjtcbiAgICBkb25lID0gdHJ1ZTtcbiAgICByZWplY3QocHJvbWlzZSwgcmVhc29uKTtcbiAgfSlcbiAgaWYgKCFkb25lICYmIHJlcyA9PT0gSVNfRVJST1IpIHtcbiAgICBkb25lID0gdHJ1ZTtcbiAgICByZWplY3QocHJvbWlzZSwgTEFTVF9FUlJPUik7XG4gIH1cbn1cbiIsIid1c2Ugc3RyaWN0JztcblxudmFyIFByb21pc2UgPSByZXF1aXJlKCcuL2NvcmUuanMnKTtcblxubW9kdWxlLmV4cG9ydHMgPSBQcm9taXNlO1xuUHJvbWlzZS5wcm90b3R5cGUuZG9uZSA9IGZ1bmN0aW9uIChvbkZ1bGZpbGxlZCwgb25SZWplY3RlZCkge1xuICB2YXIgc2VsZiA9IGFyZ3VtZW50cy5sZW5ndGggPyB0aGlzLnRoZW4uYXBwbHkodGhpcywgYXJndW1lbnRzKSA6IHRoaXM7XG4gIHNlbGYudGhlbihudWxsLCBmdW5jdGlvbiAoZXJyKSB7XG4gICAgc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICB0aHJvdyBlcnI7XG4gICAgfSwgMCk7XG4gIH0pO1xufTtcbiIsIid1c2Ugc3RyaWN0JztcblxuLy9UaGlzIGZpbGUgY29udGFpbnMgdGhlIEVTNiBleHRlbnNpb25zIHRvIHRoZSBjb3JlIFByb21pc2VzL0ErIEFQSVxuXG52YXIgUHJvbWlzZSA9IHJlcXVpcmUoJy4vY29yZS5qcycpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IFByb21pc2U7XG5cbi8qIFN0YXRpYyBGdW5jdGlvbnMgKi9cblxudmFyIFRSVUUgPSB2YWx1ZVByb21pc2UodHJ1ZSk7XG52YXIgRkFMU0UgPSB2YWx1ZVByb21pc2UoZmFsc2UpO1xudmFyIE5VTEwgPSB2YWx1ZVByb21pc2UobnVsbCk7XG52YXIgVU5ERUZJTkVEID0gdmFsdWVQcm9taXNlKHVuZGVmaW5lZCk7XG52YXIgWkVSTyA9IHZhbHVlUHJvbWlzZSgwKTtcbnZhciBFTVBUWVNUUklORyA9IHZhbHVlUHJvbWlzZSgnJyk7XG5cbmZ1bmN0aW9uIHZhbHVlUHJvbWlzZSh2YWx1ZSkge1xuICB2YXIgcCA9IG5ldyBQcm9taXNlKFByb21pc2UuXzYxKTtcbiAgcC5fODEgPSAxO1xuICBwLl82NSA9IHZhbHVlO1xuICByZXR1cm4gcDtcbn1cblByb21pc2UucmVzb2x2ZSA9IGZ1bmN0aW9uICh2YWx1ZSkge1xuICBpZiAodmFsdWUgaW5zdGFuY2VvZiBQcm9taXNlKSByZXR1cm4gdmFsdWU7XG5cbiAgaWYgKHZhbHVlID09PSBudWxsKSByZXR1cm4gTlVMTDtcbiAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQpIHJldHVybiBVTkRFRklORUQ7XG4gIGlmICh2YWx1ZSA9PT0gdHJ1ZSkgcmV0dXJuIFRSVUU7XG4gIGlmICh2YWx1ZSA9PT0gZmFsc2UpIHJldHVybiBGQUxTRTtcbiAgaWYgKHZhbHVlID09PSAwKSByZXR1cm4gWkVSTztcbiAgaWYgKHZhbHVlID09PSAnJykgcmV0dXJuIEVNUFRZU1RSSU5HO1xuXG4gIGlmICh0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnIHx8IHR5cGVvZiB2YWx1ZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIHRyeSB7XG4gICAgICB2YXIgdGhlbiA9IHZhbHVlLnRoZW47XG4gICAgICBpZiAodHlwZW9mIHRoZW4gPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgcmV0dXJuIG5ldyBQcm9taXNlKHRoZW4uYmluZCh2YWx1ZSkpO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGV4KSB7XG4gICAgICByZXR1cm4gbmV3IFByb21pc2UoZnVuY3Rpb24gKHJlc29sdmUsIHJlamVjdCkge1xuICAgICAgICByZWplY3QoZXgpO1xuICAgICAgfSk7XG4gICAgfVxuICB9XG4gIHJldHVybiB2YWx1ZVByb21pc2UodmFsdWUpO1xufTtcblxuUHJvbWlzZS5hbGwgPSBmdW5jdGlvbiAoYXJyKSB7XG4gIHZhciBhcmdzID0gQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwoYXJyKTtcblxuICByZXR1cm4gbmV3IFByb21pc2UoZnVuY3Rpb24gKHJlc29sdmUsIHJlamVjdCkge1xuICAgIGlmIChhcmdzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHJlc29sdmUoW10pO1xuICAgIHZhciByZW1haW5pbmcgPSBhcmdzLmxlbmd0aDtcbiAgICBmdW5jdGlvbiByZXMoaSwgdmFsKSB7XG4gICAgICBpZiAodmFsICYmICh0eXBlb2YgdmFsID09PSAnb2JqZWN0JyB8fCB0eXBlb2YgdmFsID09PSAnZnVuY3Rpb24nKSkge1xuICAgICAgICBpZiAodmFsIGluc3RhbmNlb2YgUHJvbWlzZSAmJiB2YWwudGhlbiA9PT0gUHJvbWlzZS5wcm90b3R5cGUudGhlbikge1xuICAgICAgICAgIHdoaWxlICh2YWwuXzgxID09PSAzKSB7XG4gICAgICAgICAgICB2YWwgPSB2YWwuXzY1O1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAodmFsLl84MSA9PT0gMSkgcmV0dXJuIHJlcyhpLCB2YWwuXzY1KTtcbiAgICAgICAgICBpZiAodmFsLl84MSA9PT0gMikgcmVqZWN0KHZhbC5fNjUpO1xuICAgICAgICAgIHZhbC50aGVuKGZ1bmN0aW9uICh2YWwpIHtcbiAgICAgICAgICAgIHJlcyhpLCB2YWwpO1xuICAgICAgICAgIH0sIHJlamVjdCk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHZhciB0aGVuID0gdmFsLnRoZW47XG4gICAgICAgICAgaWYgKHR5cGVvZiB0aGVuID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICB2YXIgcCA9IG5ldyBQcm9taXNlKHRoZW4uYmluZCh2YWwpKTtcbiAgICAgICAgICAgIHAudGhlbihmdW5jdGlvbiAodmFsKSB7XG4gICAgICAgICAgICAgIHJlcyhpLCB2YWwpO1xuICAgICAgICAgICAgfSwgcmVqZWN0KTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGFyZ3NbaV0gPSB2YWw7XG4gICAgICBpZiAoLS1yZW1haW5pbmcgPT09IDApIHtcbiAgICAgICAgcmVzb2x2ZShhcmdzKTtcbiAgICAgIH1cbiAgICB9XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBhcmdzLmxlbmd0aDsgaSsrKSB7XG4gICAgICByZXMoaSwgYXJnc1tpXSk7XG4gICAgfVxuICB9KTtcbn07XG5cblByb21pc2UucmVqZWN0ID0gZnVuY3Rpb24gKHZhbHVlKSB7XG4gIHJldHVybiBuZXcgUHJvbWlzZShmdW5jdGlvbiAocmVzb2x2ZSwgcmVqZWN0KSB7XG4gICAgcmVqZWN0KHZhbHVlKTtcbiAgfSk7XG59O1xuXG5Qcm9taXNlLnJhY2UgPSBmdW5jdGlvbiAodmFsdWVzKSB7XG4gIHJldHVybiBuZXcgUHJvbWlzZShmdW5jdGlvbiAocmVzb2x2ZSwgcmVqZWN0KSB7XG4gICAgdmFsdWVzLmZvckVhY2goZnVuY3Rpb24odmFsdWUpe1xuICAgICAgUHJvbWlzZS5yZXNvbHZlKHZhbHVlKS50aGVuKHJlc29sdmUsIHJlamVjdCk7XG4gICAgfSk7XG4gIH0pO1xufTtcblxuLyogUHJvdG90eXBlIE1ldGhvZHMgKi9cblxuUHJvbWlzZS5wcm90b3R5cGVbJ2NhdGNoJ10gPSBmdW5jdGlvbiAob25SZWplY3RlZCkge1xuICByZXR1cm4gdGhpcy50aGVuKG51bGwsIG9uUmVqZWN0ZWQpO1xufTtcbiIsIid1c2Ugc3RyaWN0JztcblxudmFyIFByb21pc2UgPSByZXF1aXJlKCcuL2NvcmUuanMnKTtcblxubW9kdWxlLmV4cG9ydHMgPSBQcm9taXNlO1xuUHJvbWlzZS5wcm90b3R5cGVbJ2ZpbmFsbHknXSA9IGZ1bmN0aW9uIChmKSB7XG4gIHJldHVybiB0aGlzLnRoZW4oZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShmKCkpLnRoZW4oZnVuY3Rpb24gKCkge1xuICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH0pO1xuICB9LCBmdW5jdGlvbiAoZXJyKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShmKCkpLnRoZW4oZnVuY3Rpb24gKCkge1xuICAgICAgdGhyb3cgZXJyO1xuICAgIH0pO1xuICB9KTtcbn07XG4iLCIndXNlIHN0cmljdCc7XG5cbm1vZHVsZS5leHBvcnRzID0gcmVxdWlyZSgnLi9jb3JlLmpzJyk7XG5yZXF1aXJlKCcuL2RvbmUuanMnKTtcbnJlcXVpcmUoJy4vZmluYWxseS5qcycpO1xucmVxdWlyZSgnLi9lczYtZXh0ZW5zaW9ucy5qcycpO1xucmVxdWlyZSgnLi9ub2RlLWV4dGVuc2lvbnMuanMnKTtcbnJlcXVpcmUoJy4vc3luY2hyb25vdXMuanMnKTtcbiIsIid1c2Ugc3RyaWN0JztcblxuLy8gVGhpcyBmaWxlIGNvbnRhaW5zIHRoZW4vcHJvbWlzZSBzcGVjaWZpYyBleHRlbnNpb25zIHRoYXQgYXJlIG9ubHkgdXNlZnVsXG4vLyBmb3Igbm9kZS5qcyBpbnRlcm9wXG5cbnZhciBQcm9taXNlID0gcmVxdWlyZSgnLi9jb3JlLmpzJyk7XG52YXIgYXNhcCA9IHJlcXVpcmUoJ2FzYXAnKTtcblxubW9kdWxlLmV4cG9ydHMgPSBQcm9taXNlO1xuXG4vKiBTdGF0aWMgRnVuY3Rpb25zICovXG5cblByb21pc2UuZGVub2RlaWZ5ID0gZnVuY3Rpb24gKGZuLCBhcmd1bWVudENvdW50KSB7XG4gIGlmIChcbiAgICB0eXBlb2YgYXJndW1lbnRDb3VudCA9PT0gJ251bWJlcicgJiYgYXJndW1lbnRDb3VudCAhPT0gSW5maW5pdHlcbiAgKSB7XG4gICAgcmV0dXJuIGRlbm9kZWlmeVdpdGhDb3VudChmbiwgYXJndW1lbnRDb3VudCk7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIGRlbm9kZWlmeVdpdGhvdXRDb3VudChmbik7XG4gIH1cbn1cblxudmFyIGNhbGxiYWNrRm4gPSAoXG4gICdmdW5jdGlvbiAoZXJyLCByZXMpIHsnICtcbiAgJ2lmIChlcnIpIHsgcmooZXJyKTsgfSBlbHNlIHsgcnMocmVzKTsgfScgK1xuICAnfSdcbik7XG5mdW5jdGlvbiBkZW5vZGVpZnlXaXRoQ291bnQoZm4sIGFyZ3VtZW50Q291bnQpIHtcbiAgdmFyIGFyZ3MgPSBbXTtcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBhcmd1bWVudENvdW50OyBpKyspIHtcbiAgICBhcmdzLnB1c2goJ2EnICsgaSk7XG4gIH1cbiAgdmFyIGJvZHkgPSBbXG4gICAgJ3JldHVybiBmdW5jdGlvbiAoJyArIGFyZ3Muam9pbignLCcpICsgJykgeycsXG4gICAgJ3ZhciBzZWxmID0gdGhpczsnLFxuICAgICdyZXR1cm4gbmV3IFByb21pc2UoZnVuY3Rpb24gKHJzLCByaikgeycsXG4gICAgJ3ZhciByZXMgPSBmbi5jYWxsKCcsXG4gICAgWydzZWxmJ10uY29uY2F0KGFyZ3MpLmNvbmNhdChbY2FsbGJhY2tGbl0pLmpvaW4oJywnKSxcbiAgICAnKTsnLFxuICAgICdpZiAocmVzICYmJyxcbiAgICAnKHR5cGVvZiByZXMgPT09IFwib2JqZWN0XCIgfHwgdHlwZW9mIHJlcyA9PT0gXCJmdW5jdGlvblwiKSAmJicsXG4gICAgJ3R5cGVvZiByZXMudGhlbiA9PT0gXCJmdW5jdGlvblwiJyxcbiAgICAnKSB7cnMocmVzKTt9JyxcbiAgICAnfSk7JyxcbiAgICAnfTsnXG4gIF0uam9pbignJyk7XG4gIHJldHVybiBGdW5jdGlvbihbJ1Byb21pc2UnLCAnZm4nXSwgYm9keSkoUHJvbWlzZSwgZm4pO1xufVxuZnVuY3Rpb24gZGVub2RlaWZ5V2l0aG91dENvdW50KGZuKSB7XG4gIHZhciBmbkxlbmd0aCA9IE1hdGgubWF4KGZuLmxlbmd0aCAtIDEsIDMpO1xuICB2YXIgYXJncyA9IFtdO1xuICBmb3IgKHZhciBpID0gMDsgaSA8IGZuTGVuZ3RoOyBpKyspIHtcbiAgICBhcmdzLnB1c2goJ2EnICsgaSk7XG4gIH1cbiAgdmFyIGJvZHkgPSBbXG4gICAgJ3JldHVybiBmdW5jdGlvbiAoJyArIGFyZ3Muam9pbignLCcpICsgJykgeycsXG4gICAgJ3ZhciBzZWxmID0gdGhpczsnLFxuICAgICd2YXIgYXJnczsnLFxuICAgICd2YXIgYXJnTGVuZ3RoID0gYXJndW1lbnRzLmxlbmd0aDsnLFxuICAgICdpZiAoYXJndW1lbnRzLmxlbmd0aCA+ICcgKyBmbkxlbmd0aCArICcpIHsnLFxuICAgICdhcmdzID0gbmV3IEFycmF5KGFyZ3VtZW50cy5sZW5ndGggKyAxKTsnLFxuICAgICdmb3IgKHZhciBpID0gMDsgaSA8IGFyZ3VtZW50cy5sZW5ndGg7IGkrKykgeycsXG4gICAgJ2FyZ3NbaV0gPSBhcmd1bWVudHNbaV07JyxcbiAgICAnfScsXG4gICAgJ30nLFxuICAgICdyZXR1cm4gbmV3IFByb21pc2UoZnVuY3Rpb24gKHJzLCByaikgeycsXG4gICAgJ3ZhciBjYiA9ICcgKyBjYWxsYmFja0ZuICsgJzsnLFxuICAgICd2YXIgcmVzOycsXG4gICAgJ3N3aXRjaCAoYXJnTGVuZ3RoKSB7JyxcbiAgICBhcmdzLmNvbmNhdChbJ2V4dHJhJ10pLm1hcChmdW5jdGlvbiAoXywgaW5kZXgpIHtcbiAgICAgIHJldHVybiAoXG4gICAgICAgICdjYXNlICcgKyAoaW5kZXgpICsgJzonICtcbiAgICAgICAgJ3JlcyA9IGZuLmNhbGwoJyArIFsnc2VsZiddLmNvbmNhdChhcmdzLnNsaWNlKDAsIGluZGV4KSkuY29uY2F0KCdjYicpLmpvaW4oJywnKSArICcpOycgK1xuICAgICAgICAnYnJlYWs7J1xuICAgICAgKTtcbiAgICB9KS5qb2luKCcnKSxcbiAgICAnZGVmYXVsdDonLFxuICAgICdhcmdzW2FyZ0xlbmd0aF0gPSBjYjsnLFxuICAgICdyZXMgPSBmbi5hcHBseShzZWxmLCBhcmdzKTsnLFxuICAgICd9JyxcbiAgICBcbiAgICAnaWYgKHJlcyAmJicsXG4gICAgJyh0eXBlb2YgcmVzID09PSBcIm9iamVjdFwiIHx8IHR5cGVvZiByZXMgPT09IFwiZnVuY3Rpb25cIikgJiYnLFxuICAgICd0eXBlb2YgcmVzLnRoZW4gPT09IFwiZnVuY3Rpb25cIicsXG4gICAgJykge3JzKHJlcyk7fScsXG4gICAgJ30pOycsXG4gICAgJ307J1xuICBdLmpvaW4oJycpO1xuXG4gIHJldHVybiBGdW5jdGlvbihcbiAgICBbJ1Byb21pc2UnLCAnZm4nXSxcbiAgICBib2R5XG4gICkoUHJvbWlzZSwgZm4pO1xufVxuXG5Qcm9taXNlLm5vZGVpZnkgPSBmdW5jdGlvbiAoZm4pIHtcbiAgcmV0dXJuIGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgYXJncyA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cyk7XG4gICAgdmFyIGNhbGxiYWNrID1cbiAgICAgIHR5cGVvZiBhcmdzW2FyZ3MubGVuZ3RoIC0gMV0gPT09ICdmdW5jdGlvbicgPyBhcmdzLnBvcCgpIDogbnVsbDtcbiAgICB2YXIgY3R4ID0gdGhpcztcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIGZuLmFwcGx5KHRoaXMsIGFyZ3VtZW50cykubm9kZWlmeShjYWxsYmFjaywgY3R4KTtcbiAgICB9IGNhdGNoIChleCkge1xuICAgICAgaWYgKGNhbGxiYWNrID09PSBudWxsIHx8IHR5cGVvZiBjYWxsYmFjayA9PSAndW5kZWZpbmVkJykge1xuICAgICAgICByZXR1cm4gbmV3IFByb21pc2UoZnVuY3Rpb24gKHJlc29sdmUsIHJlamVjdCkge1xuICAgICAgICAgIHJlamVjdChleCk7XG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgYXNhcChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgY2FsbGJhY2suY2FsbChjdHgsIGV4KTtcbiAgICAgICAgfSlcbiAgICAgIH1cbiAgICB9XG4gIH1cbn1cblxuUHJvbWlzZS5wcm90b3R5cGUubm9kZWlmeSA9IGZ1bmN0aW9uIChjYWxsYmFjaywgY3R4KSB7XG4gIGlmICh0eXBlb2YgY2FsbGJhY2sgIT0gJ2Z1bmN0aW9uJykgcmV0dXJuIHRoaXM7XG5cbiAgdGhpcy50aGVuKGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgIGFzYXAoZnVuY3Rpb24gKCkge1xuICAgICAgY2FsbGJhY2suY2FsbChjdHgsIG51bGwsIHZhbHVlKTtcbiAgICB9KTtcbiAgfSwgZnVuY3Rpb24gKGVycikge1xuICAgIGFzYXAoZnVuY3Rpb24gKCkge1xuICAgICAgY2FsbGJhY2suY2FsbChjdHgsIGVycik7XG4gICAgfSk7XG4gIH0pO1xufVxuIiwiJ3VzZSBzdHJpY3QnO1xuXG52YXIgUHJvbWlzZSA9IHJlcXVpcmUoJy4vY29yZS5qcycpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IFByb21pc2U7XG5Qcm9taXNlLmVuYWJsZVN5bmNocm9ub3VzID0gZnVuY3Rpb24gKCkge1xuICBQcm9taXNlLnByb3RvdHlwZS5pc1BlbmRpbmcgPSBmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gdGhpcy5nZXRTdGF0ZSgpID09IDA7XG4gIH07XG5cbiAgUHJvbWlzZS5wcm90b3R5cGUuaXNGdWxmaWxsZWQgPSBmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gdGhpcy5nZXRTdGF0ZSgpID09IDE7XG4gIH07XG5cbiAgUHJvbWlzZS5wcm90b3R5cGUuaXNSZWplY3RlZCA9IGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiB0aGlzLmdldFN0YXRlKCkgPT0gMjtcbiAgfTtcblxuICBQcm9taXNlLnByb3RvdHlwZS5nZXRWYWx1ZSA9IGZ1bmN0aW9uICgpIHtcbiAgICBpZiAodGhpcy5fODEgPT09IDMpIHtcbiAgICAgIHJldHVybiB0aGlzLl82NS5nZXRWYWx1ZSgpO1xuICAgIH1cblxuICAgIGlmICghdGhpcy5pc0Z1bGZpbGxlZCgpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCBnZXQgYSB2YWx1ZSBvZiBhbiB1bmZ1bGZpbGxlZCBwcm9taXNlLicpO1xuICAgIH1cblxuICAgIHJldHVybiB0aGlzLl82NTtcbiAgfTtcblxuICBQcm9taXNlLnByb3RvdHlwZS5nZXRSZWFzb24gPSBmdW5jdGlvbiAoKSB7XG4gICAgaWYgKHRoaXMuXzgxID09PSAzKSB7XG4gICAgICByZXR1cm4gdGhpcy5fNjUuZ2V0UmVhc29uKCk7XG4gICAgfVxuXG4gICAgaWYgKCF0aGlzLmlzUmVqZWN0ZWQoKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdDYW5ub3QgZ2V0IGEgcmVqZWN0aW9uIHJlYXNvbiBvZiBhIG5vbi1yZWplY3RlZCBwcm9taXNlLicpO1xuICAgIH1cblxuICAgIHJldHVybiB0aGlzLl82NTtcbiAgfTtcblxuICBQcm9taXNlLnByb3RvdHlwZS5nZXRTdGF0ZSA9IGZ1bmN0aW9uICgpIHtcbiAgICBpZiAodGhpcy5fODEgPT09IDMpIHtcbiAgICAgIHJldHVybiB0aGlzLl82NS5nZXRTdGF0ZSgpO1xuICAgIH1cbiAgICBpZiAodGhpcy5fODEgPT09IC0xIHx8IHRoaXMuXzgxID09PSAtMikge1xuICAgICAgcmV0dXJuIDA7XG4gICAgfVxuXG4gICAgcmV0dXJuIHRoaXMuXzgxO1xuICB9O1xufTtcblxuUHJvbWlzZS5kaXNhYmxlU3luY2hyb25vdXMgPSBmdW5jdGlvbigpIHtcbiAgUHJvbWlzZS5wcm90b3R5cGUuaXNQZW5kaW5nID0gdW5kZWZpbmVkO1xuICBQcm9taXNlLnByb3RvdHlwZS5pc0Z1bGZpbGxlZCA9IHVuZGVmaW5lZDtcbiAgUHJvbWlzZS5wcm90b3R5cGUuaXNSZWplY3RlZCA9IHVuZGVmaW5lZDtcbiAgUHJvbWlzZS5wcm90b3R5cGUuZ2V0VmFsdWUgPSB1bmRlZmluZWQ7XG4gIFByb21pc2UucHJvdG90eXBlLmdldFJlYXNvbiA9IHVuZGVmaW5lZDtcbiAgUHJvbWlzZS5wcm90b3R5cGUuZ2V0U3RhdGUgPSB1bmRlZmluZWQ7XG59O1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG52YXIgU3RyaW5naWZ5ID0gcmVxdWlyZSgnLi9zdHJpbmdpZnknKTtcbnZhciBQYXJzZSA9IHJlcXVpcmUoJy4vcGFyc2UnKTtcblxubW9kdWxlLmV4cG9ydHMgPSB7XG4gICAgc3RyaW5naWZ5OiBTdHJpbmdpZnksXG4gICAgcGFyc2U6IFBhcnNlXG59O1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG52YXIgVXRpbHMgPSByZXF1aXJlKCcuL3V0aWxzJyk7XG5cbnZhciBkZWZhdWx0cyA9IHtcbiAgICBkZWxpbWl0ZXI6ICcmJyxcbiAgICBkZXB0aDogNSxcbiAgICBhcnJheUxpbWl0OiAyMCxcbiAgICBwYXJhbWV0ZXJMaW1pdDogMTAwMCxcbiAgICBzdHJpY3ROdWxsSGFuZGxpbmc6IGZhbHNlLFxuICAgIHBsYWluT2JqZWN0czogZmFsc2UsXG4gICAgYWxsb3dQcm90b3R5cGVzOiBmYWxzZSxcbiAgICBhbGxvd0RvdHM6IGZhbHNlLFxuICAgIGRlY29kZXI6IFV0aWxzLmRlY29kZVxufTtcblxudmFyIHBhcnNlVmFsdWVzID0gZnVuY3Rpb24gcGFyc2VWYWx1ZXMoc3RyLCBvcHRpb25zKSB7XG4gICAgdmFyIG9iaiA9IHt9O1xuICAgIHZhciBwYXJ0cyA9IHN0ci5zcGxpdChvcHRpb25zLmRlbGltaXRlciwgb3B0aW9ucy5wYXJhbWV0ZXJMaW1pdCA9PT0gSW5maW5pdHkgPyB1bmRlZmluZWQgOiBvcHRpb25zLnBhcmFtZXRlckxpbWl0KTtcblxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgcGFydHMubGVuZ3RoOyArK2kpIHtcbiAgICAgICAgdmFyIHBhcnQgPSBwYXJ0c1tpXTtcbiAgICAgICAgdmFyIHBvcyA9IHBhcnQuaW5kZXhPZignXT0nKSA9PT0gLTEgPyBwYXJ0LmluZGV4T2YoJz0nKSA6IHBhcnQuaW5kZXhPZignXT0nKSArIDE7XG5cbiAgICAgICAgaWYgKHBvcyA9PT0gLTEpIHtcbiAgICAgICAgICAgIG9ialtvcHRpb25zLmRlY29kZXIocGFydCldID0gJyc7XG5cbiAgICAgICAgICAgIGlmIChvcHRpb25zLnN0cmljdE51bGxIYW5kbGluZykge1xuICAgICAgICAgICAgICAgIG9ialtvcHRpb25zLmRlY29kZXIocGFydCldID0gbnVsbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHZhciBrZXkgPSBvcHRpb25zLmRlY29kZXIocGFydC5zbGljZSgwLCBwb3MpKTtcbiAgICAgICAgICAgIHZhciB2YWwgPSBvcHRpb25zLmRlY29kZXIocGFydC5zbGljZShwb3MgKyAxKSk7XG5cbiAgICAgICAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwob2JqLCBrZXkpKSB7XG4gICAgICAgICAgICAgICAgb2JqW2tleV0gPSBbXS5jb25jYXQob2JqW2tleV0pLmNvbmNhdCh2YWwpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBvYmpba2V5XSA9IHZhbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBvYmo7XG59O1xuXG52YXIgcGFyc2VPYmplY3QgPSBmdW5jdGlvbiBwYXJzZU9iamVjdChjaGFpbiwgdmFsLCBvcHRpb25zKSB7XG4gICAgaWYgKCFjaGFpbi5sZW5ndGgpIHtcbiAgICAgICAgcmV0dXJuIHZhbDtcbiAgICB9XG5cbiAgICB2YXIgcm9vdCA9IGNoYWluLnNoaWZ0KCk7XG5cbiAgICB2YXIgb2JqO1xuICAgIGlmIChyb290ID09PSAnW10nKSB7XG4gICAgICAgIG9iaiA9IFtdO1xuICAgICAgICBvYmogPSBvYmouY29uY2F0KHBhcnNlT2JqZWN0KGNoYWluLCB2YWwsIG9wdGlvbnMpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBvYmogPSBvcHRpb25zLnBsYWluT2JqZWN0cyA/IE9iamVjdC5jcmVhdGUobnVsbCkgOiB7fTtcbiAgICAgICAgdmFyIGNsZWFuUm9vdCA9IHJvb3RbMF0gPT09ICdbJyAmJiByb290W3Jvb3QubGVuZ3RoIC0gMV0gPT09ICddJyA/IHJvb3Quc2xpY2UoMSwgcm9vdC5sZW5ndGggLSAxKSA6IHJvb3Q7XG4gICAgICAgIHZhciBpbmRleCA9IHBhcnNlSW50KGNsZWFuUm9vdCwgMTApO1xuICAgICAgICBpZiAoXG4gICAgICAgICAgICAhaXNOYU4oaW5kZXgpICYmXG4gICAgICAgICAgICByb290ICE9PSBjbGVhblJvb3QgJiZcbiAgICAgICAgICAgIFN0cmluZyhpbmRleCkgPT09IGNsZWFuUm9vdCAmJlxuICAgICAgICAgICAgaW5kZXggPj0gMCAmJlxuICAgICAgICAgICAgKG9wdGlvbnMucGFyc2VBcnJheXMgJiYgaW5kZXggPD0gb3B0aW9ucy5hcnJheUxpbWl0KVxuICAgICAgICApIHtcbiAgICAgICAgICAgIG9iaiA9IFtdO1xuICAgICAgICAgICAgb2JqW2luZGV4XSA9IHBhcnNlT2JqZWN0KGNoYWluLCB2YWwsIG9wdGlvbnMpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgb2JqW2NsZWFuUm9vdF0gPSBwYXJzZU9iamVjdChjaGFpbiwgdmFsLCBvcHRpb25zKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBvYmo7XG59O1xuXG52YXIgcGFyc2VLZXlzID0gZnVuY3Rpb24gcGFyc2VLZXlzKGdpdmVuS2V5LCB2YWwsIG9wdGlvbnMpIHtcbiAgICBpZiAoIWdpdmVuS2V5KSB7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBUcmFuc2Zvcm0gZG90IG5vdGF0aW9uIHRvIGJyYWNrZXQgbm90YXRpb25cbiAgICB2YXIga2V5ID0gb3B0aW9ucy5hbGxvd0RvdHMgPyBnaXZlbktleS5yZXBsYWNlKC9cXC4oW15cXC5cXFtdKykvZywgJ1skMV0nKSA6IGdpdmVuS2V5O1xuXG4gICAgLy8gVGhlIHJlZ2V4IGNodW5rc1xuXG4gICAgdmFyIHBhcmVudCA9IC9eKFteXFxbXFxdXSopLztcbiAgICB2YXIgY2hpbGQgPSAvKFxcW1teXFxbXFxdXSpcXF0pL2c7XG5cbiAgICAvLyBHZXQgdGhlIHBhcmVudFxuXG4gICAgdmFyIHNlZ21lbnQgPSBwYXJlbnQuZXhlYyhrZXkpO1xuXG4gICAgLy8gU3Rhc2ggdGhlIHBhcmVudCBpZiBpdCBleGlzdHNcblxuICAgIHZhciBrZXlzID0gW107XG4gICAgaWYgKHNlZ21lbnRbMV0pIHtcbiAgICAgICAgLy8gSWYgd2UgYXJlbid0IHVzaW5nIHBsYWluIG9iamVjdHMsIG9wdGlvbmFsbHkgcHJlZml4IGtleXNcbiAgICAgICAgLy8gdGhhdCB3b3VsZCBvdmVyd3JpdGUgb2JqZWN0IHByb3RvdHlwZSBwcm9wZXJ0aWVzXG4gICAgICAgIGlmICghb3B0aW9ucy5wbGFpbk9iamVjdHMgJiYgT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eShzZWdtZW50WzFdKSkge1xuICAgICAgICAgICAgaWYgKCFvcHRpb25zLmFsbG93UHJvdG90eXBlcykge1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGtleXMucHVzaChzZWdtZW50WzFdKTtcbiAgICB9XG5cbiAgICAvLyBMb29wIHRocm91Z2ggY2hpbGRyZW4gYXBwZW5kaW5nIHRvIHRoZSBhcnJheSB1bnRpbCB3ZSBoaXQgZGVwdGhcblxuICAgIHZhciBpID0gMDtcbiAgICB3aGlsZSAoKHNlZ21lbnQgPSBjaGlsZC5leGVjKGtleSkpICE9PSBudWxsICYmIGkgPCBvcHRpb25zLmRlcHRoKSB7XG4gICAgICAgIGkgKz0gMTtcbiAgICAgICAgaWYgKCFvcHRpb25zLnBsYWluT2JqZWN0cyAmJiBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5KHNlZ21lbnRbMV0ucmVwbGFjZSgvXFxbfFxcXS9nLCAnJykpKSB7XG4gICAgICAgICAgICBpZiAoIW9wdGlvbnMuYWxsb3dQcm90b3R5cGVzKSB7XG4gICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAga2V5cy5wdXNoKHNlZ21lbnRbMV0pO1xuICAgIH1cblxuICAgIC8vIElmIHRoZXJlJ3MgYSByZW1haW5kZXIsIGp1c3QgYWRkIHdoYXRldmVyIGlzIGxlZnRcblxuICAgIGlmIChzZWdtZW50KSB7XG4gICAgICAgIGtleXMucHVzaCgnWycgKyBrZXkuc2xpY2Uoc2VnbWVudC5pbmRleCkgKyAnXScpO1xuICAgIH1cblxuICAgIHJldHVybiBwYXJzZU9iamVjdChrZXlzLCB2YWwsIG9wdGlvbnMpO1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAoc3RyLCBvcHRzKSB7XG4gICAgdmFyIG9wdGlvbnMgPSBvcHRzIHx8IHt9O1xuXG4gICAgaWYgKG9wdGlvbnMuZGVjb2RlciAhPT0gbnVsbCAmJiBvcHRpb25zLmRlY29kZXIgIT09IHVuZGVmaW5lZCAmJiB0eXBlb2Ygb3B0aW9ucy5kZWNvZGVyICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ0RlY29kZXIgaGFzIHRvIGJlIGEgZnVuY3Rpb24uJyk7XG4gICAgfVxuXG4gICAgb3B0aW9ucy5kZWxpbWl0ZXIgPSB0eXBlb2Ygb3B0aW9ucy5kZWxpbWl0ZXIgPT09ICdzdHJpbmcnIHx8IFV0aWxzLmlzUmVnRXhwKG9wdGlvbnMuZGVsaW1pdGVyKSA/IG9wdGlvbnMuZGVsaW1pdGVyIDogZGVmYXVsdHMuZGVsaW1pdGVyO1xuICAgIG9wdGlvbnMuZGVwdGggPSB0eXBlb2Ygb3B0aW9ucy5kZXB0aCA9PT0gJ251bWJlcicgPyBvcHRpb25zLmRlcHRoIDogZGVmYXVsdHMuZGVwdGg7XG4gICAgb3B0aW9ucy5hcnJheUxpbWl0ID0gdHlwZW9mIG9wdGlvbnMuYXJyYXlMaW1pdCA9PT0gJ251bWJlcicgPyBvcHRpb25zLmFycmF5TGltaXQgOiBkZWZhdWx0cy5hcnJheUxpbWl0O1xuICAgIG9wdGlvbnMucGFyc2VBcnJheXMgPSBvcHRpb25zLnBhcnNlQXJyYXlzICE9PSBmYWxzZTtcbiAgICBvcHRpb25zLmRlY29kZXIgPSB0eXBlb2Ygb3B0aW9ucy5kZWNvZGVyID09PSAnZnVuY3Rpb24nID8gb3B0aW9ucy5kZWNvZGVyIDogZGVmYXVsdHMuZGVjb2RlcjtcbiAgICBvcHRpb25zLmFsbG93RG90cyA9IHR5cGVvZiBvcHRpb25zLmFsbG93RG90cyA9PT0gJ2Jvb2xlYW4nID8gb3B0aW9ucy5hbGxvd0RvdHMgOiBkZWZhdWx0cy5hbGxvd0RvdHM7XG4gICAgb3B0aW9ucy5wbGFpbk9iamVjdHMgPSB0eXBlb2Ygb3B0aW9ucy5wbGFpbk9iamVjdHMgPT09ICdib29sZWFuJyA/IG9wdGlvbnMucGxhaW5PYmplY3RzIDogZGVmYXVsdHMucGxhaW5PYmplY3RzO1xuICAgIG9wdGlvbnMuYWxsb3dQcm90b3R5cGVzID0gdHlwZW9mIG9wdGlvbnMuYWxsb3dQcm90b3R5cGVzID09PSAnYm9vbGVhbicgPyBvcHRpb25zLmFsbG93UHJvdG90eXBlcyA6IGRlZmF1bHRzLmFsbG93UHJvdG90eXBlcztcbiAgICBvcHRpb25zLnBhcmFtZXRlckxpbWl0ID0gdHlwZW9mIG9wdGlvbnMucGFyYW1ldGVyTGltaXQgPT09ICdudW1iZXInID8gb3B0aW9ucy5wYXJhbWV0ZXJMaW1pdCA6IGRlZmF1bHRzLnBhcmFtZXRlckxpbWl0O1xuICAgIG9wdGlvbnMuc3RyaWN0TnVsbEhhbmRsaW5nID0gdHlwZW9mIG9wdGlvbnMuc3RyaWN0TnVsbEhhbmRsaW5nID09PSAnYm9vbGVhbicgPyBvcHRpb25zLnN0cmljdE51bGxIYW5kbGluZyA6IGRlZmF1bHRzLnN0cmljdE51bGxIYW5kbGluZztcblxuICAgIGlmIChzdHIgPT09ICcnIHx8IHN0ciA9PT0gbnVsbCB8fCB0eXBlb2Ygc3RyID09PSAndW5kZWZpbmVkJykge1xuICAgICAgICByZXR1cm4gb3B0aW9ucy5wbGFpbk9iamVjdHMgPyBPYmplY3QuY3JlYXRlKG51bGwpIDoge307XG4gICAgfVxuXG4gICAgdmFyIHRlbXBPYmogPSB0eXBlb2Ygc3RyID09PSAnc3RyaW5nJyA/IHBhcnNlVmFsdWVzKHN0ciwgb3B0aW9ucykgOiBzdHI7XG4gICAgdmFyIG9iaiA9IG9wdGlvbnMucGxhaW5PYmplY3RzID8gT2JqZWN0LmNyZWF0ZShudWxsKSA6IHt9O1xuXG4gICAgLy8gSXRlcmF0ZSBvdmVyIHRoZSBrZXlzIGFuZCBzZXR1cCB0aGUgbmV3IG9iamVjdFxuXG4gICAgdmFyIGtleXMgPSBPYmplY3Qua2V5cyh0ZW1wT2JqKTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGtleXMubGVuZ3RoOyArK2kpIHtcbiAgICAgICAgdmFyIGtleSA9IGtleXNbaV07XG4gICAgICAgIHZhciBuZXdPYmogPSBwYXJzZUtleXMoa2V5LCB0ZW1wT2JqW2tleV0sIG9wdGlvbnMpO1xuICAgICAgICBvYmogPSBVdGlscy5tZXJnZShvYmosIG5ld09iaiwgb3B0aW9ucyk7XG4gICAgfVxuXG4gICAgcmV0dXJuIFV0aWxzLmNvbXBhY3Qob2JqKTtcbn07XG4iLCIndXNlIHN0cmljdCc7XG5cbnZhciBVdGlscyA9IHJlcXVpcmUoJy4vdXRpbHMnKTtcblxudmFyIGFycmF5UHJlZml4R2VuZXJhdG9ycyA9IHtcbiAgICBicmFja2V0czogZnVuY3Rpb24gYnJhY2tldHMocHJlZml4KSB7XG4gICAgICAgIHJldHVybiBwcmVmaXggKyAnW10nO1xuICAgIH0sXG4gICAgaW5kaWNlczogZnVuY3Rpb24gaW5kaWNlcyhwcmVmaXgsIGtleSkge1xuICAgICAgICByZXR1cm4gcHJlZml4ICsgJ1snICsga2V5ICsgJ10nO1xuICAgIH0sXG4gICAgcmVwZWF0OiBmdW5jdGlvbiByZXBlYXQocHJlZml4KSB7XG4gICAgICAgIHJldHVybiBwcmVmaXg7XG4gICAgfVxufTtcblxudmFyIGRlZmF1bHRzID0ge1xuICAgIGRlbGltaXRlcjogJyYnLFxuICAgIHN0cmljdE51bGxIYW5kbGluZzogZmFsc2UsXG4gICAgc2tpcE51bGxzOiBmYWxzZSxcbiAgICBlbmNvZGU6IHRydWUsXG4gICAgZW5jb2RlcjogVXRpbHMuZW5jb2RlXG59O1xuXG52YXIgc3RyaW5naWZ5ID0gZnVuY3Rpb24gc3RyaW5naWZ5KG9iamVjdCwgcHJlZml4LCBnZW5lcmF0ZUFycmF5UHJlZml4LCBzdHJpY3ROdWxsSGFuZGxpbmcsIHNraXBOdWxscywgZW5jb2RlciwgZmlsdGVyLCBzb3J0LCBhbGxvd0RvdHMpIHtcbiAgICB2YXIgb2JqID0gb2JqZWN0O1xuICAgIGlmICh0eXBlb2YgZmlsdGVyID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIG9iaiA9IGZpbHRlcihwcmVmaXgsIG9iaik7XG4gICAgfSBlbHNlIGlmIChvYmogaW5zdGFuY2VvZiBEYXRlKSB7XG4gICAgICAgIG9iaiA9IG9iai50b0lTT1N0cmluZygpO1xuICAgIH0gZWxzZSBpZiAob2JqID09PSBudWxsKSB7XG4gICAgICAgIGlmIChzdHJpY3ROdWxsSGFuZGxpbmcpIHtcbiAgICAgICAgICAgIHJldHVybiBlbmNvZGVyID8gZW5jb2RlcihwcmVmaXgpIDogcHJlZml4O1xuICAgICAgICB9XG5cbiAgICAgICAgb2JqID0gJyc7XG4gICAgfVxuXG4gICAgaWYgKHR5cGVvZiBvYmogPT09ICdzdHJpbmcnIHx8IHR5cGVvZiBvYmogPT09ICdudW1iZXInIHx8IHR5cGVvZiBvYmogPT09ICdib29sZWFuJyB8fCBVdGlscy5pc0J1ZmZlcihvYmopKSB7XG4gICAgICAgIGlmIChlbmNvZGVyKSB7XG4gICAgICAgICAgICByZXR1cm4gW2VuY29kZXIocHJlZml4KSArICc9JyArIGVuY29kZXIob2JqKV07XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIFtwcmVmaXggKyAnPScgKyBTdHJpbmcob2JqKV07XG4gICAgfVxuXG4gICAgdmFyIHZhbHVlcyA9IFtdO1xuXG4gICAgaWYgKHR5cGVvZiBvYmogPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgIHJldHVybiB2YWx1ZXM7XG4gICAgfVxuXG4gICAgdmFyIG9iaktleXM7XG4gICAgaWYgKEFycmF5LmlzQXJyYXkoZmlsdGVyKSkge1xuICAgICAgICBvYmpLZXlzID0gZmlsdGVyO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHZhciBrZXlzID0gT2JqZWN0LmtleXMob2JqKTtcbiAgICAgICAgb2JqS2V5cyA9IHNvcnQgPyBrZXlzLnNvcnQoc29ydCkgOiBrZXlzO1xuICAgIH1cblxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgb2JqS2V5cy5sZW5ndGg7ICsraSkge1xuICAgICAgICB2YXIga2V5ID0gb2JqS2V5c1tpXTtcblxuICAgICAgICBpZiAoc2tpcE51bGxzICYmIG9ialtrZXldID09PSBudWxsKSB7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KG9iaikpIHtcbiAgICAgICAgICAgIHZhbHVlcyA9IHZhbHVlcy5jb25jYXQoc3RyaW5naWZ5KG9ialtrZXldLCBnZW5lcmF0ZUFycmF5UHJlZml4KHByZWZpeCwga2V5KSwgZ2VuZXJhdGVBcnJheVByZWZpeCwgc3RyaWN0TnVsbEhhbmRsaW5nLCBza2lwTnVsbHMsIGVuY29kZXIsIGZpbHRlciwgc29ydCwgYWxsb3dEb3RzKSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB2YWx1ZXMgPSB2YWx1ZXMuY29uY2F0KHN0cmluZ2lmeShvYmpba2V5XSwgcHJlZml4ICsgKGFsbG93RG90cyA/ICcuJyArIGtleSA6ICdbJyArIGtleSArICddJyksIGdlbmVyYXRlQXJyYXlQcmVmaXgsIHN0cmljdE51bGxIYW5kbGluZywgc2tpcE51bGxzLCBlbmNvZGVyLCBmaWx0ZXIsIHNvcnQsIGFsbG93RG90cykpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIHZhbHVlcztcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gKG9iamVjdCwgb3B0cykge1xuICAgIHZhciBvYmogPSBvYmplY3Q7XG4gICAgdmFyIG9wdGlvbnMgPSBvcHRzIHx8IHt9O1xuICAgIHZhciBkZWxpbWl0ZXIgPSB0eXBlb2Ygb3B0aW9ucy5kZWxpbWl0ZXIgPT09ICd1bmRlZmluZWQnID8gZGVmYXVsdHMuZGVsaW1pdGVyIDogb3B0aW9ucy5kZWxpbWl0ZXI7XG4gICAgdmFyIHN0cmljdE51bGxIYW5kbGluZyA9IHR5cGVvZiBvcHRpb25zLnN0cmljdE51bGxIYW5kbGluZyA9PT0gJ2Jvb2xlYW4nID8gb3B0aW9ucy5zdHJpY3ROdWxsSGFuZGxpbmcgOiBkZWZhdWx0cy5zdHJpY3ROdWxsSGFuZGxpbmc7XG4gICAgdmFyIHNraXBOdWxscyA9IHR5cGVvZiBvcHRpb25zLnNraXBOdWxscyA9PT0gJ2Jvb2xlYW4nID8gb3B0aW9ucy5za2lwTnVsbHMgOiBkZWZhdWx0cy5za2lwTnVsbHM7XG4gICAgdmFyIGVuY29kZSA9IHR5cGVvZiBvcHRpb25zLmVuY29kZSA9PT0gJ2Jvb2xlYW4nID8gb3B0aW9ucy5lbmNvZGUgOiBkZWZhdWx0cy5lbmNvZGU7XG4gICAgdmFyIGVuY29kZXIgPSBlbmNvZGUgPyAodHlwZW9mIG9wdGlvbnMuZW5jb2RlciA9PT0gJ2Z1bmN0aW9uJyA/IG9wdGlvbnMuZW5jb2RlciA6IGRlZmF1bHRzLmVuY29kZXIpIDogbnVsbDtcbiAgICB2YXIgc29ydCA9IHR5cGVvZiBvcHRpb25zLnNvcnQgPT09ICdmdW5jdGlvbicgPyBvcHRpb25zLnNvcnQgOiBudWxsO1xuICAgIHZhciBhbGxvd0RvdHMgPSB0eXBlb2Ygb3B0aW9ucy5hbGxvd0RvdHMgPT09ICd1bmRlZmluZWQnID8gZmFsc2UgOiBvcHRpb25zLmFsbG93RG90cztcbiAgICB2YXIgb2JqS2V5cztcbiAgICB2YXIgZmlsdGVyO1xuXG4gICAgaWYgKG9wdGlvbnMuZW5jb2RlciAhPT0gbnVsbCAmJiBvcHRpb25zLmVuY29kZXIgIT09IHVuZGVmaW5lZCAmJiB0eXBlb2Ygb3B0aW9ucy5lbmNvZGVyICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ0VuY29kZXIgaGFzIHRvIGJlIGEgZnVuY3Rpb24uJyk7XG4gICAgfVxuXG4gICAgaWYgKHR5cGVvZiBvcHRpb25zLmZpbHRlciA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICBmaWx0ZXIgPSBvcHRpb25zLmZpbHRlcjtcbiAgICAgICAgb2JqID0gZmlsdGVyKCcnLCBvYmopO1xuICAgIH0gZWxzZSBpZiAoQXJyYXkuaXNBcnJheShvcHRpb25zLmZpbHRlcikpIHtcbiAgICAgICAgb2JqS2V5cyA9IGZpbHRlciA9IG9wdGlvbnMuZmlsdGVyO1xuICAgIH1cblxuICAgIHZhciBrZXlzID0gW107XG5cbiAgICBpZiAodHlwZW9mIG9iaiAhPT0gJ29iamVjdCcgfHwgb2JqID09PSBudWxsKSB7XG4gICAgICAgIHJldHVybiAnJztcbiAgICB9XG5cbiAgICB2YXIgYXJyYXlGb3JtYXQ7XG4gICAgaWYgKG9wdGlvbnMuYXJyYXlGb3JtYXQgaW4gYXJyYXlQcmVmaXhHZW5lcmF0b3JzKSB7XG4gICAgICAgIGFycmF5Rm9ybWF0ID0gb3B0aW9ucy5hcnJheUZvcm1hdDtcbiAgICB9IGVsc2UgaWYgKCdpbmRpY2VzJyBpbiBvcHRpb25zKSB7XG4gICAgICAgIGFycmF5Rm9ybWF0ID0gb3B0aW9ucy5pbmRpY2VzID8gJ2luZGljZXMnIDogJ3JlcGVhdCc7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgYXJyYXlGb3JtYXQgPSAnaW5kaWNlcyc7XG4gICAgfVxuXG4gICAgdmFyIGdlbmVyYXRlQXJyYXlQcmVmaXggPSBhcnJheVByZWZpeEdlbmVyYXRvcnNbYXJyYXlGb3JtYXRdO1xuXG4gICAgaWYgKCFvYmpLZXlzKSB7XG4gICAgICAgIG9iaktleXMgPSBPYmplY3Qua2V5cyhvYmopO1xuICAgIH1cblxuICAgIGlmIChzb3J0KSB7XG4gICAgICAgIG9iaktleXMuc29ydChzb3J0KTtcbiAgICB9XG5cbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IG9iaktleXMubGVuZ3RoOyArK2kpIHtcbiAgICAgICAgdmFyIGtleSA9IG9iaktleXNbaV07XG5cbiAgICAgICAgaWYgKHNraXBOdWxscyAmJiBvYmpba2V5XSA9PT0gbnVsbCkge1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICBrZXlzID0ga2V5cy5jb25jYXQoc3RyaW5naWZ5KG9ialtrZXldLCBrZXksIGdlbmVyYXRlQXJyYXlQcmVmaXgsIHN0cmljdE51bGxIYW5kbGluZywgc2tpcE51bGxzLCBlbmNvZGVyLCBmaWx0ZXIsIHNvcnQsIGFsbG93RG90cykpO1xuICAgIH1cblxuICAgIHJldHVybiBrZXlzLmpvaW4oZGVsaW1pdGVyKTtcbn07XG4iLCIndXNlIHN0cmljdCc7XG5cbnZhciBoZXhUYWJsZSA9IChmdW5jdGlvbiAoKSB7XG4gICAgdmFyIGFycmF5ID0gbmV3IEFycmF5KDI1Nik7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCAyNTY7ICsraSkge1xuICAgICAgICBhcnJheVtpXSA9ICclJyArICgoaSA8IDE2ID8gJzAnIDogJycpICsgaS50b1N0cmluZygxNikpLnRvVXBwZXJDYXNlKCk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGFycmF5O1xufSgpKTtcblxuZXhwb3J0cy5hcnJheVRvT2JqZWN0ID0gZnVuY3Rpb24gKHNvdXJjZSwgb3B0aW9ucykge1xuICAgIHZhciBvYmogPSBvcHRpb25zLnBsYWluT2JqZWN0cyA/IE9iamVjdC5jcmVhdGUobnVsbCkgOiB7fTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHNvdXJjZS5sZW5ndGg7ICsraSkge1xuICAgICAgICBpZiAodHlwZW9mIHNvdXJjZVtpXSAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgICAgIG9ialtpXSA9IHNvdXJjZVtpXTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBvYmo7XG59O1xuXG5leHBvcnRzLm1lcmdlID0gZnVuY3Rpb24gKHRhcmdldCwgc291cmNlLCBvcHRpb25zKSB7XG4gICAgaWYgKCFzb3VyY2UpIHtcbiAgICAgICAgcmV0dXJuIHRhcmdldDtcbiAgICB9XG5cbiAgICBpZiAodHlwZW9mIHNvdXJjZSAhPT0gJ29iamVjdCcpIHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodGFyZ2V0KSkge1xuICAgICAgICAgICAgdGFyZ2V0LnB1c2goc291cmNlKTtcbiAgICAgICAgfSBlbHNlIGlmICh0eXBlb2YgdGFyZ2V0ID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgdGFyZ2V0W3NvdXJjZV0gPSB0cnVlO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcmV0dXJuIFt0YXJnZXQsIHNvdXJjZV07XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGFyZ2V0O1xuICAgIH1cblxuICAgIGlmICh0eXBlb2YgdGFyZ2V0ICE9PSAnb2JqZWN0Jykge1xuICAgICAgICByZXR1cm4gW3RhcmdldF0uY29uY2F0KHNvdXJjZSk7XG4gICAgfVxuXG4gICAgdmFyIG1lcmdlVGFyZ2V0ID0gdGFyZ2V0O1xuICAgIGlmIChBcnJheS5pc0FycmF5KHRhcmdldCkgJiYgIUFycmF5LmlzQXJyYXkoc291cmNlKSkge1xuICAgICAgICBtZXJnZVRhcmdldCA9IGV4cG9ydHMuYXJyYXlUb09iamVjdCh0YXJnZXQsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIHJldHVybiBPYmplY3Qua2V5cyhzb3VyY2UpLnJlZHVjZShmdW5jdGlvbiAoYWNjLCBrZXkpIHtcbiAgICAgICAgdmFyIHZhbHVlID0gc291cmNlW2tleV07XG5cbiAgICAgICAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChhY2MsIGtleSkpIHtcbiAgICAgICAgICAgIGFjY1trZXldID0gZXhwb3J0cy5tZXJnZShhY2Nba2V5XSwgdmFsdWUsIG9wdGlvbnMpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgYWNjW2tleV0gPSB2YWx1ZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gYWNjO1xuICAgIH0sIG1lcmdlVGFyZ2V0KTtcbn07XG5cbmV4cG9ydHMuZGVjb2RlID0gZnVuY3Rpb24gKHN0cikge1xuICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBkZWNvZGVVUklDb21wb25lbnQoc3RyLnJlcGxhY2UoL1xcKy9nLCAnICcpKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIHJldHVybiBzdHI7XG4gICAgfVxufTtcblxuZXhwb3J0cy5lbmNvZGUgPSBmdW5jdGlvbiAoc3RyKSB7XG4gICAgLy8gVGhpcyBjb2RlIHdhcyBvcmlnaW5hbGx5IHdyaXR0ZW4gYnkgQnJpYW4gV2hpdGUgKG1zY2RleCkgZm9yIHRoZSBpby5qcyBjb3JlIHF1ZXJ5c3RyaW5nIGxpYnJhcnkuXG4gICAgLy8gSXQgaGFzIGJlZW4gYWRhcHRlZCBoZXJlIGZvciBzdHJpY3RlciBhZGhlcmVuY2UgdG8gUkZDIDM5ODZcbiAgICBpZiAoc3RyLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICByZXR1cm4gc3RyO1xuICAgIH1cblxuICAgIHZhciBzdHJpbmcgPSB0eXBlb2Ygc3RyID09PSAnc3RyaW5nJyA/IHN0ciA6IFN0cmluZyhzdHIpO1xuXG4gICAgdmFyIG91dCA9ICcnO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgc3RyaW5nLmxlbmd0aDsgKytpKSB7XG4gICAgICAgIHZhciBjID0gc3RyaW5nLmNoYXJDb2RlQXQoaSk7XG5cbiAgICAgICAgaWYgKFxuICAgICAgICAgICAgYyA9PT0gMHgyRCB8fCAvLyAtXG4gICAgICAgICAgICBjID09PSAweDJFIHx8IC8vIC5cbiAgICAgICAgICAgIGMgPT09IDB4NUYgfHwgLy8gX1xuICAgICAgICAgICAgYyA9PT0gMHg3RSB8fCAvLyB+XG4gICAgICAgICAgICAoYyA+PSAweDMwICYmIGMgPD0gMHgzOSkgfHwgLy8gMC05XG4gICAgICAgICAgICAoYyA+PSAweDQxICYmIGMgPD0gMHg1QSkgfHwgLy8gYS16XG4gICAgICAgICAgICAoYyA+PSAweDYxICYmIGMgPD0gMHg3QSkgLy8gQS1aXG4gICAgICAgICkge1xuICAgICAgICAgICAgb3V0ICs9IHN0cmluZy5jaGFyQXQoaSk7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChjIDwgMHg4MCkge1xuICAgICAgICAgICAgb3V0ID0gb3V0ICsgaGV4VGFibGVbY107XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChjIDwgMHg4MDApIHtcbiAgICAgICAgICAgIG91dCA9IG91dCArIChoZXhUYWJsZVsweEMwIHwgKGMgPj4gNildICsgaGV4VGFibGVbMHg4MCB8IChjICYgMHgzRildKTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGMgPCAweEQ4MDAgfHwgYyA+PSAweEUwMDApIHtcbiAgICAgICAgICAgIG91dCA9IG91dCArIChoZXhUYWJsZVsweEUwIHwgKGMgPj4gMTIpXSArIGhleFRhYmxlWzB4ODAgfCAoKGMgPj4gNikgJiAweDNGKV0gKyBoZXhUYWJsZVsweDgwIHwgKGMgJiAweDNGKV0pO1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICBpICs9IDE7XG4gICAgICAgIGMgPSAweDEwMDAwICsgKCgoYyAmIDB4M0ZGKSA8PCAxMCkgfCAoc3RyaW5nLmNoYXJDb2RlQXQoaSkgJiAweDNGRikpO1xuICAgICAgICBvdXQgKz0gaGV4VGFibGVbMHhGMCB8IChjID4+IDE4KV0gKyBoZXhUYWJsZVsweDgwIHwgKChjID4+IDEyKSAmIDB4M0YpXSArIGhleFRhYmxlWzB4ODAgfCAoKGMgPj4gNikgJiAweDNGKV0gKyBoZXhUYWJsZVsweDgwIHwgKGMgJiAweDNGKV07XG4gICAgfVxuXG4gICAgcmV0dXJuIG91dDtcbn07XG5cbmV4cG9ydHMuY29tcGFjdCA9IGZ1bmN0aW9uIChvYmosIHJlZmVyZW5jZXMpIHtcbiAgICBpZiAodHlwZW9mIG9iaiAhPT0gJ29iamVjdCcgfHwgb2JqID09PSBudWxsKSB7XG4gICAgICAgIHJldHVybiBvYmo7XG4gICAgfVxuXG4gICAgdmFyIHJlZnMgPSByZWZlcmVuY2VzIHx8IFtdO1xuICAgIHZhciBsb29rdXAgPSByZWZzLmluZGV4T2Yob2JqKTtcbiAgICBpZiAobG9va3VwICE9PSAtMSkge1xuICAgICAgICByZXR1cm4gcmVmc1tsb29rdXBdO1xuICAgIH1cblxuICAgIHJlZnMucHVzaChvYmopO1xuXG4gICAgaWYgKEFycmF5LmlzQXJyYXkob2JqKSkge1xuICAgICAgICB2YXIgY29tcGFjdGVkID0gW107XG5cbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBvYmoubGVuZ3RoOyArK2kpIHtcbiAgICAgICAgICAgIGlmIChvYmpbaV0gJiYgdHlwZW9mIG9ialtpXSA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgICAgICBjb21wYWN0ZWQucHVzaChleHBvcnRzLmNvbXBhY3Qob2JqW2ldLCByZWZzKSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHR5cGVvZiBvYmpbaV0gIT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgICAgICAgICAgY29tcGFjdGVkLnB1c2gob2JqW2ldKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb21wYWN0ZWQ7XG4gICAgfVxuXG4gICAgdmFyIGtleXMgPSBPYmplY3Qua2V5cyhvYmopO1xuICAgIGZvciAodmFyIGogPSAwOyBqIDwga2V5cy5sZW5ndGg7ICsraikge1xuICAgICAgICB2YXIga2V5ID0ga2V5c1tqXTtcbiAgICAgICAgb2JqW2tleV0gPSBleHBvcnRzLmNvbXBhY3Qob2JqW2tleV0sIHJlZnMpO1xuICAgIH1cblxuICAgIHJldHVybiBvYmo7XG59O1xuXG5leHBvcnRzLmlzUmVnRXhwID0gZnVuY3Rpb24gKG9iaikge1xuICAgIHJldHVybiBPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwob2JqKSA9PT0gJ1tvYmplY3QgUmVnRXhwXSc7XG59O1xuXG5leHBvcnRzLmlzQnVmZmVyID0gZnVuY3Rpb24gKG9iaikge1xuICAgIGlmIChvYmogPT09IG51bGwgfHwgdHlwZW9mIG9iaiA9PT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIHJldHVybiAhIShvYmouY29uc3RydWN0b3IgJiYgb2JqLmNvbnN0cnVjdG9yLmlzQnVmZmVyICYmIG9iai5jb25zdHJ1Y3Rvci5pc0J1ZmZlcihvYmopKTtcbn07XG4iLCJ2YXIgVk5vZGUgPSByZXF1aXJlKCcuL3Zub2RlJyk7XG52YXIgaXMgPSByZXF1aXJlKCcuL2lzJyk7XG5cbmZ1bmN0aW9uIGFkZE5TKGRhdGEsIGNoaWxkcmVuKSB7XG4gIGRhdGEubnMgPSAnaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnO1xuICBpZiAoY2hpbGRyZW4gIT09IHVuZGVmaW5lZCkge1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgY2hpbGRyZW4ubGVuZ3RoOyArK2kpIHtcbiAgICAgIGFkZE5TKGNoaWxkcmVuW2ldLmRhdGEsIGNoaWxkcmVuW2ldLmNoaWxkcmVuKTtcbiAgICB9XG4gIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiBoKHNlbCwgYiwgYykge1xuICB2YXIgZGF0YSA9IHt9LCBjaGlsZHJlbiwgdGV4dCwgaTtcbiAgaWYgKGMgIT09IHVuZGVmaW5lZCkge1xuICAgIGRhdGEgPSBiO1xuICAgIGlmIChpcy5hcnJheShjKSkgeyBjaGlsZHJlbiA9IGM7IH1cbiAgICBlbHNlIGlmIChpcy5wcmltaXRpdmUoYykpIHsgdGV4dCA9IGM7IH1cbiAgfSBlbHNlIGlmIChiICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAoaXMuYXJyYXkoYikpIHsgY2hpbGRyZW4gPSBiOyB9XG4gICAgZWxzZSBpZiAoaXMucHJpbWl0aXZlKGIpKSB7IHRleHQgPSBiOyB9XG4gICAgZWxzZSB7IGRhdGEgPSBiOyB9XG4gIH1cbiAgaWYgKGlzLmFycmF5KGNoaWxkcmVuKSkge1xuICAgIGZvciAoaSA9IDA7IGkgPCBjaGlsZHJlbi5sZW5ndGg7ICsraSkge1xuICAgICAgaWYgKGlzLnByaW1pdGl2ZShjaGlsZHJlbltpXSkpIGNoaWxkcmVuW2ldID0gVk5vZGUodW5kZWZpbmVkLCB1bmRlZmluZWQsIHVuZGVmaW5lZCwgY2hpbGRyZW5baV0pO1xuICAgIH1cbiAgfVxuICBpZiAoc2VsWzBdID09PSAncycgJiYgc2VsWzFdID09PSAndicgJiYgc2VsWzJdID09PSAnZycpIHtcbiAgICBhZGROUyhkYXRhLCBjaGlsZHJlbik7XG4gIH1cbiAgcmV0dXJuIFZOb2RlKHNlbCwgZGF0YSwgY2hpbGRyZW4sIHRleHQsIHVuZGVmaW5lZCk7XG59O1xuIiwiZnVuY3Rpb24gY3JlYXRlRWxlbWVudCh0YWdOYW1lKXtcbiAgcmV0dXJuIGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQodGFnTmFtZSk7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZUVsZW1lbnROUyhuYW1lc3BhY2VVUkksIHF1YWxpZmllZE5hbWUpe1xuICByZXR1cm4gZG9jdW1lbnQuY3JlYXRlRWxlbWVudE5TKG5hbWVzcGFjZVVSSSwgcXVhbGlmaWVkTmFtZSk7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVRleHROb2RlKHRleHQpe1xuICByZXR1cm4gZG9jdW1lbnQuY3JlYXRlVGV4dE5vZGUodGV4dCk7XG59XG5cblxuZnVuY3Rpb24gaW5zZXJ0QmVmb3JlKHBhcmVudE5vZGUsIG5ld05vZGUsIHJlZmVyZW5jZU5vZGUpe1xuICBwYXJlbnROb2RlLmluc2VydEJlZm9yZShuZXdOb2RlLCByZWZlcmVuY2VOb2RlKTtcbn1cblxuXG5mdW5jdGlvbiByZW1vdmVDaGlsZChub2RlLCBjaGlsZCl7XG4gIG5vZGUucmVtb3ZlQ2hpbGQoY2hpbGQpO1xufVxuXG5mdW5jdGlvbiBhcHBlbmRDaGlsZChub2RlLCBjaGlsZCl7XG4gIG5vZGUuYXBwZW5kQ2hpbGQoY2hpbGQpO1xufVxuXG5mdW5jdGlvbiBwYXJlbnROb2RlKG5vZGUpe1xuICByZXR1cm4gbm9kZS5wYXJlbnRFbGVtZW50O1xufVxuXG5mdW5jdGlvbiBuZXh0U2libGluZyhub2RlKXtcbiAgcmV0dXJuIG5vZGUubmV4dFNpYmxpbmc7XG59XG5cbmZ1bmN0aW9uIHRhZ05hbWUobm9kZSl7XG4gIHJldHVybiBub2RlLnRhZ05hbWU7XG59XG5cbmZ1bmN0aW9uIHNldFRleHRDb250ZW50KG5vZGUsIHRleHQpe1xuICBub2RlLnRleHRDb250ZW50ID0gdGV4dDtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSB7XG4gIGNyZWF0ZUVsZW1lbnQ6IGNyZWF0ZUVsZW1lbnQsXG4gIGNyZWF0ZUVsZW1lbnROUzogY3JlYXRlRWxlbWVudE5TLFxuICBjcmVhdGVUZXh0Tm9kZTogY3JlYXRlVGV4dE5vZGUsXG4gIGFwcGVuZENoaWxkOiBhcHBlbmRDaGlsZCxcbiAgcmVtb3ZlQ2hpbGQ6IHJlbW92ZUNoaWxkLFxuICBpbnNlcnRCZWZvcmU6IGluc2VydEJlZm9yZSxcbiAgcGFyZW50Tm9kZTogcGFyZW50Tm9kZSxcbiAgbmV4dFNpYmxpbmc6IG5leHRTaWJsaW5nLFxuICB0YWdOYW1lOiB0YWdOYW1lLFxuICBzZXRUZXh0Q29udGVudDogc2V0VGV4dENvbnRlbnRcbn07XG4iLCJtb2R1bGUuZXhwb3J0cyA9IHtcbiAgYXJyYXk6IEFycmF5LmlzQXJyYXksXG4gIHByaW1pdGl2ZTogZnVuY3Rpb24ocykgeyByZXR1cm4gdHlwZW9mIHMgPT09ICdzdHJpbmcnIHx8IHR5cGVvZiBzID09PSAnbnVtYmVyJzsgfSxcbn07XG4iLCJ2YXIgYm9vbGVhbkF0dHJzID0gW1wiYWxsb3dmdWxsc2NyZWVuXCIsIFwiYXN5bmNcIiwgXCJhdXRvZm9jdXNcIiwgXCJhdXRvcGxheVwiLCBcImNoZWNrZWRcIiwgXCJjb21wYWN0XCIsIFwiY29udHJvbHNcIiwgXCJkZWNsYXJlXCIsIFxuICAgICAgICAgICAgICAgIFwiZGVmYXVsdFwiLCBcImRlZmF1bHRjaGVja2VkXCIsIFwiZGVmYXVsdG11dGVkXCIsIFwiZGVmYXVsdHNlbGVjdGVkXCIsIFwiZGVmZXJcIiwgXCJkaXNhYmxlZFwiLCBcImRyYWdnYWJsZVwiLCBcbiAgICAgICAgICAgICAgICBcImVuYWJsZWRcIiwgXCJmb3Jtbm92YWxpZGF0ZVwiLCBcImhpZGRlblwiLCBcImluZGV0ZXJtaW5hdGVcIiwgXCJpbmVydFwiLCBcImlzbWFwXCIsIFwiaXRlbXNjb3BlXCIsIFwibG9vcFwiLCBcIm11bHRpcGxlXCIsIFxuICAgICAgICAgICAgICAgIFwibXV0ZWRcIiwgXCJub2hyZWZcIiwgXCJub3Jlc2l6ZVwiLCBcIm5vc2hhZGVcIiwgXCJub3ZhbGlkYXRlXCIsIFwibm93cmFwXCIsIFwib3BlblwiLCBcInBhdXNlb25leGl0XCIsIFwicmVhZG9ubHlcIiwgXG4gICAgICAgICAgICAgICAgXCJyZXF1aXJlZFwiLCBcInJldmVyc2VkXCIsIFwic2NvcGVkXCIsIFwic2VhbWxlc3NcIiwgXCJzZWxlY3RlZFwiLCBcInNvcnRhYmxlXCIsIFwic3BlbGxjaGVja1wiLCBcInRyYW5zbGF0ZVwiLCBcbiAgICAgICAgICAgICAgICBcInRydWVzcGVlZFwiLCBcInR5cGVtdXN0bWF0Y2hcIiwgXCJ2aXNpYmxlXCJdO1xuICAgIFxudmFyIGJvb2xlYW5BdHRyc0RpY3QgPSB7fTtcbmZvcih2YXIgaT0wLCBsZW4gPSBib29sZWFuQXR0cnMubGVuZ3RoOyBpIDwgbGVuOyBpKyspIHtcbiAgYm9vbGVhbkF0dHJzRGljdFtib29sZWFuQXR0cnNbaV1dID0gdHJ1ZTtcbn1cbiAgICBcbmZ1bmN0aW9uIHVwZGF0ZUF0dHJzKG9sZFZub2RlLCB2bm9kZSkge1xuICB2YXIga2V5LCBjdXIsIG9sZCwgZWxtID0gdm5vZGUuZWxtLFxuICAgICAgb2xkQXR0cnMgPSBvbGRWbm9kZS5kYXRhLmF0dHJzIHx8IHt9LCBhdHRycyA9IHZub2RlLmRhdGEuYXR0cnMgfHwge307XG4gIFxuICAvLyB1cGRhdGUgbW9kaWZpZWQgYXR0cmlidXRlcywgYWRkIG5ldyBhdHRyaWJ1dGVzXG4gIGZvciAoa2V5IGluIGF0dHJzKSB7XG4gICAgY3VyID0gYXR0cnNba2V5XTtcbiAgICBvbGQgPSBvbGRBdHRyc1trZXldO1xuICAgIGlmIChvbGQgIT09IGN1cikge1xuICAgICAgLy8gVE9ETzogYWRkIHN1cHBvcnQgdG8gbmFtZXNwYWNlZCBhdHRyaWJ1dGVzIChzZXRBdHRyaWJ1dGVOUylcbiAgICAgIGlmKCFjdXIgJiYgYm9vbGVhbkF0dHJzRGljdFtrZXldKVxuICAgICAgICBlbG0ucmVtb3ZlQXR0cmlidXRlKGtleSk7XG4gICAgICBlbHNlXG4gICAgICAgIGVsbS5zZXRBdHRyaWJ1dGUoa2V5LCBjdXIpO1xuICAgIH1cbiAgfVxuICAvL3JlbW92ZSByZW1vdmVkIGF0dHJpYnV0ZXNcbiAgLy8gdXNlIGBpbmAgb3BlcmF0b3Igc2luY2UgdGhlIHByZXZpb3VzIGBmb3JgIGl0ZXJhdGlvbiB1c2VzIGl0ICguaS5lLiBhZGQgZXZlbiBhdHRyaWJ1dGVzIHdpdGggdW5kZWZpbmVkIHZhbHVlKVxuICAvLyB0aGUgb3RoZXIgb3B0aW9uIGlzIHRvIHJlbW92ZSBhbGwgYXR0cmlidXRlcyB3aXRoIHZhbHVlID09IHVuZGVmaW5lZFxuICBmb3IgKGtleSBpbiBvbGRBdHRycykge1xuICAgIGlmICghKGtleSBpbiBhdHRycykpIHtcbiAgICAgIGVsbS5yZW1vdmVBdHRyaWJ1dGUoa2V5KTtcbiAgICB9XG4gIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSB7Y3JlYXRlOiB1cGRhdGVBdHRycywgdXBkYXRlOiB1cGRhdGVBdHRyc307XG4iLCJmdW5jdGlvbiB1cGRhdGVDbGFzcyhvbGRWbm9kZSwgdm5vZGUpIHtcbiAgdmFyIGN1ciwgbmFtZSwgZWxtID0gdm5vZGUuZWxtLFxuICAgICAgb2xkQ2xhc3MgPSBvbGRWbm9kZS5kYXRhLmNsYXNzIHx8IHt9LFxuICAgICAga2xhc3MgPSB2bm9kZS5kYXRhLmNsYXNzIHx8IHt9O1xuICBmb3IgKG5hbWUgaW4gb2xkQ2xhc3MpIHtcbiAgICBpZiAoIWtsYXNzW25hbWVdKSB7XG4gICAgICBlbG0uY2xhc3NMaXN0LnJlbW92ZShuYW1lKTtcbiAgICB9XG4gIH1cbiAgZm9yIChuYW1lIGluIGtsYXNzKSB7XG4gICAgY3VyID0ga2xhc3NbbmFtZV07XG4gICAgaWYgKGN1ciAhPT0gb2xkQ2xhc3NbbmFtZV0pIHtcbiAgICAgIGVsbS5jbGFzc0xpc3RbY3VyID8gJ2FkZCcgOiAncmVtb3ZlJ10obmFtZSk7XG4gICAgfVxuICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0ge2NyZWF0ZTogdXBkYXRlQ2xhc3MsIHVwZGF0ZTogdXBkYXRlQ2xhc3N9O1xuIiwidmFyIGlzID0gcmVxdWlyZSgnLi4vaXMnKTtcblxuZnVuY3Rpb24gYXJySW52b2tlcihhcnIpIHtcbiAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgIGlmICghYXJyLmxlbmd0aCkgcmV0dXJuO1xuICAgIC8vIFNwZWNpYWwgY2FzZSB3aGVuIGxlbmd0aCBpcyB0d28sIGZvciBwZXJmb3JtYW5jZVxuICAgIGFyci5sZW5ndGggPT09IDIgPyBhcnJbMF0oYXJyWzFdKSA6IGFyclswXS5hcHBseSh1bmRlZmluZWQsIGFyci5zbGljZSgxKSk7XG4gIH07XG59XG5cbmZ1bmN0aW9uIGZuSW52b2tlcihvKSB7XG4gIHJldHVybiBmdW5jdGlvbihldikgeyBcbiAgICBpZiAoby5mbiA9PT0gbnVsbCkgcmV0dXJuO1xuICAgIG8uZm4oZXYpOyBcbiAgfTtcbn1cblxuZnVuY3Rpb24gdXBkYXRlRXZlbnRMaXN0ZW5lcnMob2xkVm5vZGUsIHZub2RlKSB7XG4gIHZhciBuYW1lLCBjdXIsIG9sZCwgZWxtID0gdm5vZGUuZWxtLFxuICAgICAgb2xkT24gPSBvbGRWbm9kZS5kYXRhLm9uIHx8IHt9LCBvbiA9IHZub2RlLmRhdGEub247XG4gIGlmICghb24pIHJldHVybjtcbiAgZm9yIChuYW1lIGluIG9uKSB7XG4gICAgY3VyID0gb25bbmFtZV07XG4gICAgb2xkID0gb2xkT25bbmFtZV07XG4gICAgaWYgKG9sZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBpZiAoaXMuYXJyYXkoY3VyKSkge1xuICAgICAgICBlbG0uYWRkRXZlbnRMaXN0ZW5lcihuYW1lLCBhcnJJbnZva2VyKGN1cikpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY3VyID0ge2ZuOiBjdXJ9O1xuICAgICAgICBvbltuYW1lXSA9IGN1cjtcbiAgICAgICAgZWxtLmFkZEV2ZW50TGlzdGVuZXIobmFtZSwgZm5JbnZva2VyKGN1cikpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoaXMuYXJyYXkob2xkKSkge1xuICAgICAgLy8gRGVsaWJlcmF0ZWx5IG1vZGlmeSBvbGQgYXJyYXkgc2luY2UgaXQncyBjYXB0dXJlZCBpbiBjbG9zdXJlIGNyZWF0ZWQgd2l0aCBgYXJySW52b2tlcmBcbiAgICAgIG9sZC5sZW5ndGggPSBjdXIubGVuZ3RoO1xuICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBvbGQubGVuZ3RoOyArK2kpIG9sZFtpXSA9IGN1cltpXTtcbiAgICAgIG9uW25hbWVdICA9IG9sZDtcbiAgICB9IGVsc2Uge1xuICAgICAgb2xkLmZuID0gY3VyO1xuICAgICAgb25bbmFtZV0gPSBvbGQ7XG4gICAgfVxuICB9XG4gIGlmIChvbGRPbikge1xuICAgIGZvciAobmFtZSBpbiBvbGRPbikge1xuICAgICAgaWYgKG9uW25hbWVdID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgdmFyIG9sZCA9IG9sZE9uW25hbWVdO1xuICAgICAgICBpZiAoaXMuYXJyYXkob2xkKSkge1xuICAgICAgICAgIG9sZC5sZW5ndGggPSAwO1xuICAgICAgICB9XG4gICAgICAgIGVsc2Uge1xuICAgICAgICAgIG9sZC5mbiA9IG51bGw7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSB7Y3JlYXRlOiB1cGRhdGVFdmVudExpc3RlbmVycywgdXBkYXRlOiB1cGRhdGVFdmVudExpc3RlbmVyc307XG4iLCJmdW5jdGlvbiB1cGRhdGVQcm9wcyhvbGRWbm9kZSwgdm5vZGUpIHtcbiAgdmFyIGtleSwgY3VyLCBvbGQsIGVsbSA9IHZub2RlLmVsbSxcbiAgICAgIG9sZFByb3BzID0gb2xkVm5vZGUuZGF0YS5wcm9wcyB8fCB7fSwgcHJvcHMgPSB2bm9kZS5kYXRhLnByb3BzIHx8IHt9O1xuICBmb3IgKGtleSBpbiBvbGRQcm9wcykge1xuICAgIGlmICghcHJvcHNba2V5XSkge1xuICAgICAgZGVsZXRlIGVsbVtrZXldO1xuICAgIH1cbiAgfVxuICBmb3IgKGtleSBpbiBwcm9wcykge1xuICAgIGN1ciA9IHByb3BzW2tleV07XG4gICAgb2xkID0gb2xkUHJvcHNba2V5XTtcbiAgICBpZiAob2xkICE9PSBjdXIgJiYgKGtleSAhPT0gJ3ZhbHVlJyB8fCBlbG1ba2V5XSAhPT0gY3VyKSkge1xuICAgICAgZWxtW2tleV0gPSBjdXI7XG4gICAgfVxuICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0ge2NyZWF0ZTogdXBkYXRlUHJvcHMsIHVwZGF0ZTogdXBkYXRlUHJvcHN9O1xuIiwidmFyIHJhZiA9ICh0eXBlb2Ygd2luZG93ICE9PSAndW5kZWZpbmVkJyAmJiB3aW5kb3cucmVxdWVzdEFuaW1hdGlvbkZyYW1lKSB8fCBzZXRUaW1lb3V0O1xudmFyIG5leHRGcmFtZSA9IGZ1bmN0aW9uKGZuKSB7IHJhZihmdW5jdGlvbigpIHsgcmFmKGZuKTsgfSk7IH07XG5cbmZ1bmN0aW9uIHNldE5leHRGcmFtZShvYmosIHByb3AsIHZhbCkge1xuICBuZXh0RnJhbWUoZnVuY3Rpb24oKSB7IG9ialtwcm9wXSA9IHZhbDsgfSk7XG59XG5cbmZ1bmN0aW9uIHVwZGF0ZVN0eWxlKG9sZFZub2RlLCB2bm9kZSkge1xuICB2YXIgY3VyLCBuYW1lLCBlbG0gPSB2bm9kZS5lbG0sXG4gICAgICBvbGRTdHlsZSA9IG9sZFZub2RlLmRhdGEuc3R5bGUgfHwge30sXG4gICAgICBzdHlsZSA9IHZub2RlLmRhdGEuc3R5bGUgfHwge30sXG4gICAgICBvbGRIYXNEZWwgPSAnZGVsYXllZCcgaW4gb2xkU3R5bGU7XG4gIGZvciAobmFtZSBpbiBvbGRTdHlsZSkge1xuICAgIGlmICghc3R5bGVbbmFtZV0pIHtcbiAgICAgIGVsbS5zdHlsZVtuYW1lXSA9ICcnO1xuICAgIH1cbiAgfVxuICBmb3IgKG5hbWUgaW4gc3R5bGUpIHtcbiAgICBjdXIgPSBzdHlsZVtuYW1lXTtcbiAgICBpZiAobmFtZSA9PT0gJ2RlbGF5ZWQnKSB7XG4gICAgICBmb3IgKG5hbWUgaW4gc3R5bGUuZGVsYXllZCkge1xuICAgICAgICBjdXIgPSBzdHlsZS5kZWxheWVkW25hbWVdO1xuICAgICAgICBpZiAoIW9sZEhhc0RlbCB8fCBjdXIgIT09IG9sZFN0eWxlLmRlbGF5ZWRbbmFtZV0pIHtcbiAgICAgICAgICBzZXROZXh0RnJhbWUoZWxtLnN0eWxlLCBuYW1lLCBjdXIpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBlbHNlIGlmIChuYW1lICE9PSAncmVtb3ZlJyAmJiBjdXIgIT09IG9sZFN0eWxlW25hbWVdKSB7XG4gICAgICBlbG0uc3R5bGVbbmFtZV0gPSBjdXI7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIGFwcGx5RGVzdHJveVN0eWxlKHZub2RlKSB7XG4gIHZhciBzdHlsZSwgbmFtZSwgZWxtID0gdm5vZGUuZWxtLCBzID0gdm5vZGUuZGF0YS5zdHlsZTtcbiAgaWYgKCFzIHx8ICEoc3R5bGUgPSBzLmRlc3Ryb3kpKSByZXR1cm47XG4gIGZvciAobmFtZSBpbiBzdHlsZSkge1xuICAgIGVsbS5zdHlsZVtuYW1lXSA9IHN0eWxlW25hbWVdO1xuICB9XG59XG5cbmZ1bmN0aW9uIGFwcGx5UmVtb3ZlU3R5bGUodm5vZGUsIHJtKSB7XG4gIHZhciBzID0gdm5vZGUuZGF0YS5zdHlsZTtcbiAgaWYgKCFzIHx8ICFzLnJlbW92ZSkge1xuICAgIHJtKCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHZhciBuYW1lLCBlbG0gPSB2bm9kZS5lbG0sIGlkeCwgaSA9IDAsIG1heER1ciA9IDAsXG4gICAgICBjb21wU3R5bGUsIHN0eWxlID0gcy5yZW1vdmUsIGFtb3VudCA9IDAsIGFwcGxpZWQgPSBbXTtcbiAgZm9yIChuYW1lIGluIHN0eWxlKSB7XG4gICAgYXBwbGllZC5wdXNoKG5hbWUpO1xuICAgIGVsbS5zdHlsZVtuYW1lXSA9IHN0eWxlW25hbWVdO1xuICB9XG4gIGNvbXBTdHlsZSA9IGdldENvbXB1dGVkU3R5bGUoZWxtKTtcbiAgdmFyIHByb3BzID0gY29tcFN0eWxlWyd0cmFuc2l0aW9uLXByb3BlcnR5J10uc3BsaXQoJywgJyk7XG4gIGZvciAoOyBpIDwgcHJvcHMubGVuZ3RoOyArK2kpIHtcbiAgICBpZihhcHBsaWVkLmluZGV4T2YocHJvcHNbaV0pICE9PSAtMSkgYW1vdW50Kys7XG4gIH1cbiAgZWxtLmFkZEV2ZW50TGlzdGVuZXIoJ3RyYW5zaXRpb25lbmQnLCBmdW5jdGlvbihldikge1xuICAgIGlmIChldi50YXJnZXQgPT09IGVsbSkgLS1hbW91bnQ7XG4gICAgaWYgKGFtb3VudCA9PT0gMCkgcm0oKTtcbiAgfSk7XG59XG5cbm1vZHVsZS5leHBvcnRzID0ge2NyZWF0ZTogdXBkYXRlU3R5bGUsIHVwZGF0ZTogdXBkYXRlU3R5bGUsIGRlc3Ryb3k6IGFwcGx5RGVzdHJveVN0eWxlLCByZW1vdmU6IGFwcGx5UmVtb3ZlU3R5bGV9O1xuIiwiLy8ganNoaW50IG5ld2NhcDogZmFsc2Vcbi8qIGdsb2JhbCByZXF1aXJlLCBtb2R1bGUsIGRvY3VtZW50LCBOb2RlICovXG4ndXNlIHN0cmljdCc7XG5cbnZhciBWTm9kZSA9IHJlcXVpcmUoJy4vdm5vZGUnKTtcbnZhciBpcyA9IHJlcXVpcmUoJy4vaXMnKTtcbnZhciBkb21BcGkgPSByZXF1aXJlKCcuL2h0bWxkb21hcGknKTtcblxuZnVuY3Rpb24gaXNVbmRlZihzKSB7IHJldHVybiBzID09PSB1bmRlZmluZWQ7IH1cbmZ1bmN0aW9uIGlzRGVmKHMpIHsgcmV0dXJuIHMgIT09IHVuZGVmaW5lZDsgfVxuXG52YXIgZW1wdHlOb2RlID0gVk5vZGUoJycsIHt9LCBbXSwgdW5kZWZpbmVkLCB1bmRlZmluZWQpO1xuXG5mdW5jdGlvbiBzYW1lVm5vZGUodm5vZGUxLCB2bm9kZTIpIHtcbiAgcmV0dXJuIHZub2RlMS5rZXkgPT09IHZub2RlMi5rZXkgJiYgdm5vZGUxLnNlbCA9PT0gdm5vZGUyLnNlbDtcbn1cblxuZnVuY3Rpb24gY3JlYXRlS2V5VG9PbGRJZHgoY2hpbGRyZW4sIGJlZ2luSWR4LCBlbmRJZHgpIHtcbiAgdmFyIGksIG1hcCA9IHt9LCBrZXk7XG4gIGZvciAoaSA9IGJlZ2luSWR4OyBpIDw9IGVuZElkeDsgKytpKSB7XG4gICAga2V5ID0gY2hpbGRyZW5baV0ua2V5O1xuICAgIGlmIChpc0RlZihrZXkpKSBtYXBba2V5XSA9IGk7XG4gIH1cbiAgcmV0dXJuIG1hcDtcbn1cblxudmFyIGhvb2tzID0gWydjcmVhdGUnLCAndXBkYXRlJywgJ3JlbW92ZScsICdkZXN0cm95JywgJ3ByZScsICdwb3N0J107XG5cbmZ1bmN0aW9uIGluaXQobW9kdWxlcywgYXBpKSB7XG4gIHZhciBpLCBqLCBjYnMgPSB7fTtcblxuICBpZiAoaXNVbmRlZihhcGkpKSBhcGkgPSBkb21BcGk7XG5cbiAgZm9yIChpID0gMDsgaSA8IGhvb2tzLmxlbmd0aDsgKytpKSB7XG4gICAgY2JzW2hvb2tzW2ldXSA9IFtdO1xuICAgIGZvciAoaiA9IDA7IGogPCBtb2R1bGVzLmxlbmd0aDsgKytqKSB7XG4gICAgICBpZiAobW9kdWxlc1tqXVtob29rc1tpXV0gIT09IHVuZGVmaW5lZCkgY2JzW2hvb2tzW2ldXS5wdXNoKG1vZHVsZXNbal1baG9va3NbaV1dKTtcbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBlbXB0eU5vZGVBdChlbG0pIHtcbiAgICByZXR1cm4gVk5vZGUoYXBpLnRhZ05hbWUoZWxtKS50b0xvd2VyQ2FzZSgpLCB7fSwgW10sIHVuZGVmaW5lZCwgZWxtKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGNyZWF0ZVJtQ2IoY2hpbGRFbG0sIGxpc3RlbmVycykge1xuICAgIHJldHVybiBmdW5jdGlvbigpIHtcbiAgICAgIGlmICgtLWxpc3RlbmVycyA9PT0gMCkge1xuICAgICAgICB2YXIgcGFyZW50ID0gYXBpLnBhcmVudE5vZGUoY2hpbGRFbG0pO1xuICAgICAgICBhcGkucmVtb3ZlQ2hpbGQocGFyZW50LCBjaGlsZEVsbSk7XG4gICAgICB9XG4gICAgfTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGNyZWF0ZUVsbSh2bm9kZSwgaW5zZXJ0ZWRWbm9kZVF1ZXVlKSB7XG4gICAgdmFyIGksIGRhdGEgPSB2bm9kZS5kYXRhO1xuICAgIGlmIChpc0RlZihkYXRhKSkge1xuICAgICAgaWYgKGlzRGVmKGkgPSBkYXRhLmhvb2spICYmIGlzRGVmKGkgPSBpLmluaXQpKSB7XG4gICAgICAgIGkodm5vZGUpO1xuICAgICAgICBkYXRhID0gdm5vZGUuZGF0YTtcbiAgICAgIH1cbiAgICB9XG4gICAgdmFyIGVsbSwgY2hpbGRyZW4gPSB2bm9kZS5jaGlsZHJlbiwgc2VsID0gdm5vZGUuc2VsO1xuICAgIGlmIChpc0RlZihzZWwpKSB7XG4gICAgICAvLyBQYXJzZSBzZWxlY3RvclxuICAgICAgdmFyIGhhc2hJZHggPSBzZWwuaW5kZXhPZignIycpO1xuICAgICAgdmFyIGRvdElkeCA9IHNlbC5pbmRleE9mKCcuJywgaGFzaElkeCk7XG4gICAgICB2YXIgaGFzaCA9IGhhc2hJZHggPiAwID8gaGFzaElkeCA6IHNlbC5sZW5ndGg7XG4gICAgICB2YXIgZG90ID0gZG90SWR4ID4gMCA/IGRvdElkeCA6IHNlbC5sZW5ndGg7XG4gICAgICB2YXIgdGFnID0gaGFzaElkeCAhPT0gLTEgfHwgZG90SWR4ICE9PSAtMSA/IHNlbC5zbGljZSgwLCBNYXRoLm1pbihoYXNoLCBkb3QpKSA6IHNlbDtcbiAgICAgIGVsbSA9IHZub2RlLmVsbSA9IGlzRGVmKGRhdGEpICYmIGlzRGVmKGkgPSBkYXRhLm5zKSA/IGFwaS5jcmVhdGVFbGVtZW50TlMoaSwgdGFnKVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDogYXBpLmNyZWF0ZUVsZW1lbnQodGFnKTtcbiAgICAgIGlmIChoYXNoIDwgZG90KSBlbG0uaWQgPSBzZWwuc2xpY2UoaGFzaCArIDEsIGRvdCk7XG4gICAgICBpZiAoZG90SWR4ID4gMCkgZWxtLmNsYXNzTmFtZSA9IHNlbC5zbGljZShkb3QrMSkucmVwbGFjZSgvXFwuL2csICcgJyk7XG4gICAgICBpZiAoaXMuYXJyYXkoY2hpbGRyZW4pKSB7XG4gICAgICAgIGZvciAoaSA9IDA7IGkgPCBjaGlsZHJlbi5sZW5ndGg7ICsraSkge1xuICAgICAgICAgIGFwaS5hcHBlbmRDaGlsZChlbG0sIGNyZWF0ZUVsbShjaGlsZHJlbltpXSwgaW5zZXJ0ZWRWbm9kZVF1ZXVlKSk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSBpZiAoaXMucHJpbWl0aXZlKHZub2RlLnRleHQpKSB7XG4gICAgICAgIGFwaS5hcHBlbmRDaGlsZChlbG0sIGFwaS5jcmVhdGVUZXh0Tm9kZSh2bm9kZS50ZXh0KSk7XG4gICAgICB9XG4gICAgICBmb3IgKGkgPSAwOyBpIDwgY2JzLmNyZWF0ZS5sZW5ndGg7ICsraSkgY2JzLmNyZWF0ZVtpXShlbXB0eU5vZGUsIHZub2RlKTtcbiAgICAgIGkgPSB2bm9kZS5kYXRhLmhvb2s7IC8vIFJldXNlIHZhcmlhYmxlXG4gICAgICBpZiAoaXNEZWYoaSkpIHtcbiAgICAgICAgaWYgKGkuY3JlYXRlKSBpLmNyZWF0ZShlbXB0eU5vZGUsIHZub2RlKTtcbiAgICAgICAgaWYgKGkuaW5zZXJ0KSBpbnNlcnRlZFZub2RlUXVldWUucHVzaCh2bm9kZSk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIGVsbSA9IHZub2RlLmVsbSA9IGFwaS5jcmVhdGVUZXh0Tm9kZSh2bm9kZS50ZXh0KTtcbiAgICB9XG4gICAgcmV0dXJuIHZub2RlLmVsbTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGFkZFZub2RlcyhwYXJlbnRFbG0sIGJlZm9yZSwgdm5vZGVzLCBzdGFydElkeCwgZW5kSWR4LCBpbnNlcnRlZFZub2RlUXVldWUpIHtcbiAgICBmb3IgKDsgc3RhcnRJZHggPD0gZW5kSWR4OyArK3N0YXJ0SWR4KSB7XG4gICAgICBhcGkuaW5zZXJ0QmVmb3JlKHBhcmVudEVsbSwgY3JlYXRlRWxtKHZub2Rlc1tzdGFydElkeF0sIGluc2VydGVkVm5vZGVRdWV1ZSksIGJlZm9yZSk7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gaW52b2tlRGVzdHJveUhvb2sodm5vZGUpIHtcbiAgICB2YXIgaSwgaiwgZGF0YSA9IHZub2RlLmRhdGE7XG4gICAgaWYgKGlzRGVmKGRhdGEpKSB7XG4gICAgICBpZiAoaXNEZWYoaSA9IGRhdGEuaG9vaykgJiYgaXNEZWYoaSA9IGkuZGVzdHJveSkpIGkodm5vZGUpO1xuICAgICAgZm9yIChpID0gMDsgaSA8IGNicy5kZXN0cm95Lmxlbmd0aDsgKytpKSBjYnMuZGVzdHJveVtpXSh2bm9kZSk7XG4gICAgICBpZiAoaXNEZWYoaSA9IHZub2RlLmNoaWxkcmVuKSkge1xuICAgICAgICBmb3IgKGogPSAwOyBqIDwgdm5vZGUuY2hpbGRyZW4ubGVuZ3RoOyArK2opIHtcbiAgICAgICAgICBpbnZva2VEZXN0cm95SG9vayh2bm9kZS5jaGlsZHJlbltqXSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiByZW1vdmVWbm9kZXMocGFyZW50RWxtLCB2bm9kZXMsIHN0YXJ0SWR4LCBlbmRJZHgpIHtcbiAgICBmb3IgKDsgc3RhcnRJZHggPD0gZW5kSWR4OyArK3N0YXJ0SWR4KSB7XG4gICAgICB2YXIgaSwgbGlzdGVuZXJzLCBybSwgY2ggPSB2bm9kZXNbc3RhcnRJZHhdO1xuICAgICAgaWYgKGlzRGVmKGNoKSkge1xuICAgICAgICBpZiAoaXNEZWYoY2guc2VsKSkge1xuICAgICAgICAgIGludm9rZURlc3Ryb3lIb29rKGNoKTtcbiAgICAgICAgICBsaXN0ZW5lcnMgPSBjYnMucmVtb3ZlLmxlbmd0aCArIDE7XG4gICAgICAgICAgcm0gPSBjcmVhdGVSbUNiKGNoLmVsbSwgbGlzdGVuZXJzKTtcbiAgICAgICAgICBmb3IgKGkgPSAwOyBpIDwgY2JzLnJlbW92ZS5sZW5ndGg7ICsraSkgY2JzLnJlbW92ZVtpXShjaCwgcm0pO1xuICAgICAgICAgIGlmIChpc0RlZihpID0gY2guZGF0YSkgJiYgaXNEZWYoaSA9IGkuaG9vaykgJiYgaXNEZWYoaSA9IGkucmVtb3ZlKSkge1xuICAgICAgICAgICAgaShjaCwgcm0pO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBybSgpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHsgLy8gVGV4dCBub2RlXG4gICAgICAgICAgYXBpLnJlbW92ZUNoaWxkKHBhcmVudEVsbSwgY2guZWxtKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIHVwZGF0ZUNoaWxkcmVuKHBhcmVudEVsbSwgb2xkQ2gsIG5ld0NoLCBpbnNlcnRlZFZub2RlUXVldWUpIHtcbiAgICB2YXIgb2xkU3RhcnRJZHggPSAwLCBuZXdTdGFydElkeCA9IDA7XG4gICAgdmFyIG9sZEVuZElkeCA9IG9sZENoLmxlbmd0aCAtIDE7XG4gICAgdmFyIG9sZFN0YXJ0Vm5vZGUgPSBvbGRDaFswXTtcbiAgICB2YXIgb2xkRW5kVm5vZGUgPSBvbGRDaFtvbGRFbmRJZHhdO1xuICAgIHZhciBuZXdFbmRJZHggPSBuZXdDaC5sZW5ndGggLSAxO1xuICAgIHZhciBuZXdTdGFydFZub2RlID0gbmV3Q2hbMF07XG4gICAgdmFyIG5ld0VuZFZub2RlID0gbmV3Q2hbbmV3RW5kSWR4XTtcbiAgICB2YXIgb2xkS2V5VG9JZHgsIGlkeEluT2xkLCBlbG1Ub01vdmUsIGJlZm9yZTtcblxuICAgIHdoaWxlIChvbGRTdGFydElkeCA8PSBvbGRFbmRJZHggJiYgbmV3U3RhcnRJZHggPD0gbmV3RW5kSWR4KSB7XG4gICAgICBpZiAoaXNVbmRlZihvbGRTdGFydFZub2RlKSkge1xuICAgICAgICBvbGRTdGFydFZub2RlID0gb2xkQ2hbKytvbGRTdGFydElkeF07IC8vIFZub2RlIGhhcyBiZWVuIG1vdmVkIGxlZnRcbiAgICAgIH0gZWxzZSBpZiAoaXNVbmRlZihvbGRFbmRWbm9kZSkpIHtcbiAgICAgICAgb2xkRW5kVm5vZGUgPSBvbGRDaFstLW9sZEVuZElkeF07XG4gICAgICB9IGVsc2UgaWYgKHNhbWVWbm9kZShvbGRTdGFydFZub2RlLCBuZXdTdGFydFZub2RlKSkge1xuICAgICAgICBwYXRjaFZub2RlKG9sZFN0YXJ0Vm5vZGUsIG5ld1N0YXJ0Vm5vZGUsIGluc2VydGVkVm5vZGVRdWV1ZSk7XG4gICAgICAgIG9sZFN0YXJ0Vm5vZGUgPSBvbGRDaFsrK29sZFN0YXJ0SWR4XTtcbiAgICAgICAgbmV3U3RhcnRWbm9kZSA9IG5ld0NoWysrbmV3U3RhcnRJZHhdO1xuICAgICAgfSBlbHNlIGlmIChzYW1lVm5vZGUob2xkRW5kVm5vZGUsIG5ld0VuZFZub2RlKSkge1xuICAgICAgICBwYXRjaFZub2RlKG9sZEVuZFZub2RlLCBuZXdFbmRWbm9kZSwgaW5zZXJ0ZWRWbm9kZVF1ZXVlKTtcbiAgICAgICAgb2xkRW5kVm5vZGUgPSBvbGRDaFstLW9sZEVuZElkeF07XG4gICAgICAgIG5ld0VuZFZub2RlID0gbmV3Q2hbLS1uZXdFbmRJZHhdO1xuICAgICAgfSBlbHNlIGlmIChzYW1lVm5vZGUob2xkU3RhcnRWbm9kZSwgbmV3RW5kVm5vZGUpKSB7IC8vIFZub2RlIG1vdmVkIHJpZ2h0XG4gICAgICAgIHBhdGNoVm5vZGUob2xkU3RhcnRWbm9kZSwgbmV3RW5kVm5vZGUsIGluc2VydGVkVm5vZGVRdWV1ZSk7XG4gICAgICAgIGFwaS5pbnNlcnRCZWZvcmUocGFyZW50RWxtLCBvbGRTdGFydFZub2RlLmVsbSwgYXBpLm5leHRTaWJsaW5nKG9sZEVuZFZub2RlLmVsbSkpO1xuICAgICAgICBvbGRTdGFydFZub2RlID0gb2xkQ2hbKytvbGRTdGFydElkeF07XG4gICAgICAgIG5ld0VuZFZub2RlID0gbmV3Q2hbLS1uZXdFbmRJZHhdO1xuICAgICAgfSBlbHNlIGlmIChzYW1lVm5vZGUob2xkRW5kVm5vZGUsIG5ld1N0YXJ0Vm5vZGUpKSB7IC8vIFZub2RlIG1vdmVkIGxlZnRcbiAgICAgICAgcGF0Y2hWbm9kZShvbGRFbmRWbm9kZSwgbmV3U3RhcnRWbm9kZSwgaW5zZXJ0ZWRWbm9kZVF1ZXVlKTtcbiAgICAgICAgYXBpLmluc2VydEJlZm9yZShwYXJlbnRFbG0sIG9sZEVuZFZub2RlLmVsbSwgb2xkU3RhcnRWbm9kZS5lbG0pO1xuICAgICAgICBvbGRFbmRWbm9kZSA9IG9sZENoWy0tb2xkRW5kSWR4XTtcbiAgICAgICAgbmV3U3RhcnRWbm9kZSA9IG5ld0NoWysrbmV3U3RhcnRJZHhdO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgaWYgKGlzVW5kZWYob2xkS2V5VG9JZHgpKSBvbGRLZXlUb0lkeCA9IGNyZWF0ZUtleVRvT2xkSWR4KG9sZENoLCBvbGRTdGFydElkeCwgb2xkRW5kSWR4KTtcbiAgICAgICAgaWR4SW5PbGQgPSBvbGRLZXlUb0lkeFtuZXdTdGFydFZub2RlLmtleV07XG4gICAgICAgIGlmIChpc1VuZGVmKGlkeEluT2xkKSkgeyAvLyBOZXcgZWxlbWVudFxuICAgICAgICAgIGFwaS5pbnNlcnRCZWZvcmUocGFyZW50RWxtLCBjcmVhdGVFbG0obmV3U3RhcnRWbm9kZSwgaW5zZXJ0ZWRWbm9kZVF1ZXVlKSwgb2xkU3RhcnRWbm9kZS5lbG0pO1xuICAgICAgICAgIG5ld1N0YXJ0Vm5vZGUgPSBuZXdDaFsrK25ld1N0YXJ0SWR4XTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBlbG1Ub01vdmUgPSBvbGRDaFtpZHhJbk9sZF07XG4gICAgICAgICAgcGF0Y2hWbm9kZShlbG1Ub01vdmUsIG5ld1N0YXJ0Vm5vZGUsIGluc2VydGVkVm5vZGVRdWV1ZSk7XG4gICAgICAgICAgb2xkQ2hbaWR4SW5PbGRdID0gdW5kZWZpbmVkO1xuICAgICAgICAgIGFwaS5pbnNlcnRCZWZvcmUocGFyZW50RWxtLCBlbG1Ub01vdmUuZWxtLCBvbGRTdGFydFZub2RlLmVsbSk7XG4gICAgICAgICAgbmV3U3RhcnRWbm9kZSA9IG5ld0NoWysrbmV3U3RhcnRJZHhdO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChvbGRTdGFydElkeCA+IG9sZEVuZElkeCkge1xuICAgICAgYmVmb3JlID0gaXNVbmRlZihuZXdDaFtuZXdFbmRJZHgrMV0pID8gbnVsbCA6IG5ld0NoW25ld0VuZElkeCsxXS5lbG07XG4gICAgICBhZGRWbm9kZXMocGFyZW50RWxtLCBiZWZvcmUsIG5ld0NoLCBuZXdTdGFydElkeCwgbmV3RW5kSWR4LCBpbnNlcnRlZFZub2RlUXVldWUpO1xuICAgIH0gZWxzZSBpZiAobmV3U3RhcnRJZHggPiBuZXdFbmRJZHgpIHtcbiAgICAgIHJlbW92ZVZub2RlcyhwYXJlbnRFbG0sIG9sZENoLCBvbGRTdGFydElkeCwgb2xkRW5kSWR4KTtcbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBwYXRjaFZub2RlKG9sZFZub2RlLCB2bm9kZSwgaW5zZXJ0ZWRWbm9kZVF1ZXVlKSB7XG4gICAgdmFyIGksIGhvb2s7XG4gICAgaWYgKGlzRGVmKGkgPSB2bm9kZS5kYXRhKSAmJiBpc0RlZihob29rID0gaS5ob29rKSAmJiBpc0RlZihpID0gaG9vay5wcmVwYXRjaCkpIHtcbiAgICAgIGkob2xkVm5vZGUsIHZub2RlKTtcbiAgICB9XG4gICAgdmFyIGVsbSA9IHZub2RlLmVsbSA9IG9sZFZub2RlLmVsbSwgb2xkQ2ggPSBvbGRWbm9kZS5jaGlsZHJlbiwgY2ggPSB2bm9kZS5jaGlsZHJlbjtcbiAgICBpZiAob2xkVm5vZGUgPT09IHZub2RlKSByZXR1cm47XG4gICAgaWYgKCFzYW1lVm5vZGUob2xkVm5vZGUsIHZub2RlKSkge1xuICAgICAgdmFyIHBhcmVudEVsbSA9IGFwaS5wYXJlbnROb2RlKG9sZFZub2RlLmVsbSk7XG4gICAgICBlbG0gPSBjcmVhdGVFbG0odm5vZGUsIGluc2VydGVkVm5vZGVRdWV1ZSk7XG4gICAgICBhcGkuaW5zZXJ0QmVmb3JlKHBhcmVudEVsbSwgZWxtLCBvbGRWbm9kZS5lbG0pO1xuICAgICAgcmVtb3ZlVm5vZGVzKHBhcmVudEVsbSwgW29sZFZub2RlXSwgMCwgMCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChpc0RlZih2bm9kZS5kYXRhKSkge1xuICAgICAgZm9yIChpID0gMDsgaSA8IGNicy51cGRhdGUubGVuZ3RoOyArK2kpIGNicy51cGRhdGVbaV0ob2xkVm5vZGUsIHZub2RlKTtcbiAgICAgIGkgPSB2bm9kZS5kYXRhLmhvb2s7XG4gICAgICBpZiAoaXNEZWYoaSkgJiYgaXNEZWYoaSA9IGkudXBkYXRlKSkgaShvbGRWbm9kZSwgdm5vZGUpO1xuICAgIH1cbiAgICBpZiAoaXNVbmRlZih2bm9kZS50ZXh0KSkge1xuICAgICAgaWYgKGlzRGVmKG9sZENoKSAmJiBpc0RlZihjaCkpIHtcbiAgICAgICAgaWYgKG9sZENoICE9PSBjaCkgdXBkYXRlQ2hpbGRyZW4oZWxtLCBvbGRDaCwgY2gsIGluc2VydGVkVm5vZGVRdWV1ZSk7XG4gICAgICB9IGVsc2UgaWYgKGlzRGVmKGNoKSkge1xuICAgICAgICBpZiAoaXNEZWYob2xkVm5vZGUudGV4dCkpIGFwaS5zZXRUZXh0Q29udGVudChlbG0sICcnKTtcbiAgICAgICAgYWRkVm5vZGVzKGVsbSwgbnVsbCwgY2gsIDAsIGNoLmxlbmd0aCAtIDEsIGluc2VydGVkVm5vZGVRdWV1ZSk7XG4gICAgICB9IGVsc2UgaWYgKGlzRGVmKG9sZENoKSkge1xuICAgICAgICByZW1vdmVWbm9kZXMoZWxtLCBvbGRDaCwgMCwgb2xkQ2gubGVuZ3RoIC0gMSk7XG4gICAgICB9IGVsc2UgaWYgKGlzRGVmKG9sZFZub2RlLnRleHQpKSB7XG4gICAgICAgIGFwaS5zZXRUZXh0Q29udGVudChlbG0sICcnKTtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKG9sZFZub2RlLnRleHQgIT09IHZub2RlLnRleHQpIHtcbiAgICAgIGFwaS5zZXRUZXh0Q29udGVudChlbG0sIHZub2RlLnRleHQpO1xuICAgIH1cbiAgICBpZiAoaXNEZWYoaG9vaykgJiYgaXNEZWYoaSA9IGhvb2sucG9zdHBhdGNoKSkge1xuICAgICAgaShvbGRWbm9kZSwgdm5vZGUpO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBmdW5jdGlvbihvbGRWbm9kZSwgdm5vZGUpIHtcbiAgICB2YXIgaSwgZWxtLCBwYXJlbnQ7XG4gICAgdmFyIGluc2VydGVkVm5vZGVRdWV1ZSA9IFtdO1xuICAgIGZvciAoaSA9IDA7IGkgPCBjYnMucHJlLmxlbmd0aDsgKytpKSBjYnMucHJlW2ldKCk7XG5cbiAgICBpZiAoaXNVbmRlZihvbGRWbm9kZS5zZWwpKSB7XG4gICAgICBvbGRWbm9kZSA9IGVtcHR5Tm9kZUF0KG9sZFZub2RlKTtcbiAgICB9XG5cbiAgICBpZiAoc2FtZVZub2RlKG9sZFZub2RlLCB2bm9kZSkpIHtcbiAgICAgIHBhdGNoVm5vZGUob2xkVm5vZGUsIHZub2RlLCBpbnNlcnRlZFZub2RlUXVldWUpO1xuICAgIH0gZWxzZSB7XG4gICAgICBlbG0gPSBvbGRWbm9kZS5lbG07XG4gICAgICBwYXJlbnQgPSBhcGkucGFyZW50Tm9kZShlbG0pO1xuXG4gICAgICBjcmVhdGVFbG0odm5vZGUsIGluc2VydGVkVm5vZGVRdWV1ZSk7XG5cbiAgICAgIGlmIChwYXJlbnQgIT09IG51bGwpIHtcbiAgICAgICAgYXBpLmluc2VydEJlZm9yZShwYXJlbnQsIHZub2RlLmVsbSwgYXBpLm5leHRTaWJsaW5nKGVsbSkpO1xuICAgICAgICByZW1vdmVWbm9kZXMocGFyZW50LCBbb2xkVm5vZGVdLCAwLCAwKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBmb3IgKGkgPSAwOyBpIDwgaW5zZXJ0ZWRWbm9kZVF1ZXVlLmxlbmd0aDsgKytpKSB7XG4gICAgICBpbnNlcnRlZFZub2RlUXVldWVbaV0uZGF0YS5ob29rLmluc2VydChpbnNlcnRlZFZub2RlUXVldWVbaV0pO1xuICAgIH1cbiAgICBmb3IgKGkgPSAwOyBpIDwgY2JzLnBvc3QubGVuZ3RoOyArK2kpIGNicy5wb3N0W2ldKCk7XG4gICAgcmV0dXJuIHZub2RlO1xuICB9O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IHtpbml0OiBpbml0fTtcbiIsIm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oc2VsLCBkYXRhLCBjaGlsZHJlbiwgdGV4dCwgZWxtKSB7XG4gIHZhciBrZXkgPSBkYXRhID09PSB1bmRlZmluZWQgPyB1bmRlZmluZWQgOiBkYXRhLmtleTtcbiAgcmV0dXJuIHtzZWw6IHNlbCwgZGF0YTogZGF0YSwgY2hpbGRyZW46IGNoaWxkcmVuLFxuICAgICAgICAgIHRleHQ6IHRleHQsIGVsbTogZWxtLCBrZXk6IGtleX07XG59O1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG52YXIgUHJvbWlzZSA9IHJlcXVpcmUoJ3Byb21pc2UnKTtcbnZhciBSZXNwb25zZSA9IHJlcXVpcmUoJ2h0dHAtcmVzcG9uc2Utb2JqZWN0Jyk7XG52YXIgaGFuZGxlUXMgPSByZXF1aXJlKCcuL2xpYi9oYW5kbGUtcXMuanMnKTtcblxubW9kdWxlLmV4cG9ydHMgPSBkb1JlcXVlc3Q7XG5mdW5jdGlvbiBkb1JlcXVlc3QobWV0aG9kLCB1cmwsIG9wdGlvbnMsIGNhbGxiYWNrKSB7XG4gIHZhciByZXN1bHQgPSBuZXcgUHJvbWlzZShmdW5jdGlvbiAocmVzb2x2ZSwgcmVqZWN0KSB7XG4gICAgdmFyIHhociA9IG5ldyB3aW5kb3cuWE1MSHR0cFJlcXVlc3QoKTtcblxuICAgIC8vIGNoZWNrIHR5cGVzIG9mIGFyZ3VtZW50c1xuXG4gICAgaWYgKHR5cGVvZiBtZXRob2QgIT09ICdzdHJpbmcnKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdUaGUgbWV0aG9kIG11c3QgYmUgYSBzdHJpbmcuJyk7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgdXJsICE9PSAnc3RyaW5nJykge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignVGhlIFVSTC9wYXRoIG11c3QgYmUgYSBzdHJpbmcuJyk7XG4gICAgfVxuICAgIGlmICh0eXBlb2Ygb3B0aW9ucyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgY2FsbGJhY2sgPSBvcHRpb25zO1xuICAgICAgb3B0aW9ucyA9IHt9O1xuICAgIH1cbiAgICBpZiAob3B0aW9ucyA9PT0gbnVsbCB8fCBvcHRpb25zID09PSB1bmRlZmluZWQpIHtcbiAgICAgIG9wdGlvbnMgPSB7fTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBvcHRpb25zICE9PSAnb2JqZWN0Jykge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignT3B0aW9ucyBtdXN0IGJlIGFuIG9iamVjdCAob3IgbnVsbCkuJyk7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgY2FsbGJhY2sgIT09ICdmdW5jdGlvbicpIHtcbiAgICAgIGNhbGxiYWNrID0gdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIG1ldGhvZCA9IG1ldGhvZC50b1VwcGVyQ2FzZSgpO1xuICAgIG9wdGlvbnMuaGVhZGVycyA9IG9wdGlvbnMuaGVhZGVycyB8fCB7fTtcblxuXG4gICAgZnVuY3Rpb24gYXR0ZW1wdChuKSB7XG4gICAgICBkb1JlcXVlc3QobWV0aG9kLCB1cmwsIHtcbiAgICAgICAgcXM6IG9wdGlvbnMucXMsXG4gICAgICAgIGhlYWRlcnM6IG9wdGlvbnMuaGVhZGVycyxcbiAgICAgICAgdGltZW91dDogb3B0aW9ucy50aW1lb3V0XG4gICAgICB9KS5ub2RlaWZ5KGZ1bmN0aW9uIChlcnIsIHJlcykge1xuICAgICAgICB2YXIgcmV0cnkgPSBlcnIgfHwgcmVzLnN0YXR1c0NvZGUgPj0gNDAwO1xuICAgICAgICBpZiAodHlwZW9mIG9wdGlvbnMucmV0cnkgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICByZXRyeSA9IG9wdGlvbnMucmV0cnkoZXJyLCByZXMsIG4gKyAxKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAobiA+PSAob3B0aW9ucy5tYXhSZXRyaWVzIHwgNSkpIHtcbiAgICAgICAgICByZXRyeSA9IGZhbHNlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChyZXRyeSkge1xuICAgICAgICAgIHZhciBkZWxheSA9IG9wdGlvbnMucmV0cnlEZWxheTtcbiAgICAgICAgICBpZiAodHlwZW9mIG9wdGlvbnMucmV0cnlEZWxheSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgZGVsYXkgPSBvcHRpb25zLnJldHJ5RGVsYXkoZXJyLCByZXMsIG4gKyAxKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgZGVsYXkgPSBkZWxheSB8fCAyMDA7XG4gICAgICAgICAgc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBhdHRlbXB0KG4gKyAxKTtcbiAgICAgICAgICB9LCBkZWxheSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgaWYgKGVycikgcmVqZWN0KGVycik7XG4gICAgICAgICAgZWxzZSByZXNvbHZlKHJlcyk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH1cbiAgICBpZiAob3B0aW9ucy5yZXRyeSAmJiBtZXRob2QgPT09ICdHRVQnKSB7XG4gICAgICByZXR1cm4gYXR0ZW1wdCgwKTtcbiAgICB9XG5cbiAgICAvLyBoYW5kbGUgY3Jvc3MgZG9tYWluXG5cbiAgICB2YXIgbWF0Y2g7XG4gICAgdmFyIGNyb3NzRG9tYWluID0gISEoKG1hdGNoID0gL14oW1xcdy1dKzopP1xcL1xcLyhbXlxcL10rKS8uZXhlYyh1cmwpKSAmJiAobWF0Y2hbMl0gIT0gd2luZG93LmxvY2F0aW9uLmhvc3QpKTtcbiAgICBpZiAoIWNyb3NzRG9tYWluKSBvcHRpb25zLmhlYWRlcnNbJ1gtUmVxdWVzdGVkLVdpdGgnXSA9ICdYTUxIdHRwUmVxdWVzdCc7XG5cbiAgICAvLyBoYW5kbGUgcXVlcnkgc3RyaW5nXG4gICAgaWYgKG9wdGlvbnMucXMpIHtcbiAgICAgIHVybCA9IGhhbmRsZVFzKHVybCwgb3B0aW9ucy5xcyk7XG4gICAgfVxuXG4gICAgLy8gaGFuZGxlIGpzb24gYm9keVxuICAgIGlmIChvcHRpb25zLmpzb24pIHtcbiAgICAgIG9wdGlvbnMuYm9keSA9IEpTT04uc3RyaW5naWZ5KG9wdGlvbnMuanNvbik7XG4gICAgICBvcHRpb25zLmhlYWRlcnNbJ0NvbnRlbnQtVHlwZSddID0gJ2FwcGxpY2F0aW9uL2pzb24nO1xuICAgIH1cblxuICAgIGlmIChvcHRpb25zLnRpbWVvdXQpIHtcbiAgICAgIHhoci50aW1lb3V0ID0gb3B0aW9ucy50aW1lb3V0O1xuICAgICAgdmFyIHN0YXJ0ID0gRGF0ZS5ub3coKTtcbiAgICAgIHhoci5vbnRpbWVvdXQgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgIHZhciBkdXJhdGlvbiA9IERhdGUubm93KCkgLSBzdGFydDtcbiAgICAgICAgdmFyIGVyciA9IG5ldyBFcnJvcignUmVxdWVzdCB0aW1lZCBvdXQgYWZ0ZXIgJyArIGR1cmF0aW9uICsgJ21zJyk7XG4gICAgICAgIGVyci50aW1lb3V0ID0gdHJ1ZTtcbiAgICAgICAgZXJyLmR1cmF0aW9uID0gZHVyYXRpb247XG4gICAgICAgIHJlamVjdChlcnIpO1xuICAgICAgfTtcbiAgICB9XG4gICAgeGhyLm9ucmVhZHlzdGF0ZWNoYW5nZSA9IGZ1bmN0aW9uICgpIHtcbiAgICAgIGlmICh4aHIucmVhZHlTdGF0ZSA9PT0gNCkge1xuICAgICAgICB2YXIgaGVhZGVycyA9IHt9O1xuICAgICAgICB4aHIuZ2V0QWxsUmVzcG9uc2VIZWFkZXJzKCkuc3BsaXQoJ1xcclxcbicpLmZvckVhY2goZnVuY3Rpb24gKGhlYWRlcikge1xuICAgICAgICAgIHZhciBoID0gaGVhZGVyLnNwbGl0KCc6Jyk7XG4gICAgICAgICAgaWYgKGgubGVuZ3RoID4gMSkge1xuICAgICAgICAgICAgaGVhZGVyc1toWzBdLnRvTG93ZXJDYXNlKCldID0gaC5zbGljZSgxKS5qb2luKCc6JykudHJpbSgpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICAgIHZhciByZXMgPSBuZXcgUmVzcG9uc2UoeGhyLnN0YXR1cywgaGVhZGVycywgeGhyLnJlc3BvbnNlVGV4dCk7XG4gICAgICAgIHJlcy51cmwgPSB1cmw7XG4gICAgICAgIHJlc29sdmUocmVzKTtcbiAgICAgIH1cbiAgICB9O1xuXG4gICAgLy8gbWV0aG9kLCB1cmwsIGFzeW5jXG4gICAgeGhyLm9wZW4obWV0aG9kLCB1cmwsIHRydWUpO1xuXG4gICAgZm9yICh2YXIgbmFtZSBpbiBvcHRpb25zLmhlYWRlcnMpIHtcbiAgICAgIHhoci5zZXRSZXF1ZXN0SGVhZGVyKG5hbWUsIG9wdGlvbnMuaGVhZGVyc1tuYW1lXSk7XG4gICAgfVxuXG4gICAgLy8gYXZvaWQgc2VuZGluZyBlbXB0eSBzdHJpbmcgKCMzMTkpXG4gICAgeGhyLnNlbmQob3B0aW9ucy5ib2R5ID8gb3B0aW9ucy5ib2R5IDogbnVsbCk7XG4gIH0pO1xuICByZXN1bHQuZ2V0Qm9keSA9IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gcmVzdWx0LnRoZW4oZnVuY3Rpb24gKHJlcykgeyByZXR1cm4gcmVzLmdldEJvZHkoKTsgfSk7XG4gIH07XG4gIHJldHVybiByZXN1bHQubm9kZWlmeShjYWxsYmFjayk7XG59XG4iLCIndXNlIHN0cmljdCc7XG5cbnZhciBwYXJzZSA9IHJlcXVpcmUoJ3FzJykucGFyc2U7XG52YXIgc3RyaW5naWZ5ID0gcmVxdWlyZSgncXMnKS5zdHJpbmdpZnk7XG5cbm1vZHVsZS5leHBvcnRzID0gaGFuZGxlUXM7XG5mdW5jdGlvbiBoYW5kbGVRcyh1cmwsIHF1ZXJ5KSB7XG4gIHVybCA9IHVybC5zcGxpdCgnPycpO1xuICB2YXIgc3RhcnQgPSB1cmxbMF07XG4gIHZhciBxcyA9ICh1cmxbMV0gfHwgJycpLnNwbGl0KCcjJylbMF07XG4gIHZhciBlbmQgPSB1cmxbMV0gJiYgdXJsWzFdLnNwbGl0KCcjJykubGVuZ3RoID4gMSA/ICcjJyArIHVybFsxXS5zcGxpdCgnIycpWzFdIDogJyc7XG5cbiAgdmFyIGJhc2VRcyA9IHBhcnNlKHFzKTtcbiAgZm9yICh2YXIgaSBpbiBxdWVyeSkge1xuICAgIGJhc2VRc1tpXSA9IHF1ZXJ5W2ldO1xuICB9XG4gIHFzID0gc3RyaW5naWZ5KGJhc2VRcyk7XG4gIGlmIChxcyAhPT0gJycpIHtcbiAgICBxcyA9ICc/JyArIHFzO1xuICB9XG4gIHJldHVybiBzdGFydCArIHFzICsgZW5kO1xufVxuIiwidmFyIGN1cnJ5TiA9IHJlcXVpcmUoJ3JhbWRhL3NyYy9jdXJyeU4nKTtcblxudmFyIGlzU3RyaW5nID0gZnVuY3Rpb24ocykgeyByZXR1cm4gdHlwZW9mIHMgPT09ICdzdHJpbmcnOyB9O1xudmFyIGlzTnVtYmVyID0gZnVuY3Rpb24obikgeyByZXR1cm4gdHlwZW9mIG4gPT09ICdudW1iZXInOyB9O1xudmFyIGlzQm9vbGVhbiA9IGZ1bmN0aW9uKGIpIHsgcmV0dXJuIHR5cGVvZiBiID09PSAnYm9vbGVhbic7IH07XG52YXIgaXNPYmplY3QgPSBmdW5jdGlvbih2YWx1ZSkge1xuICB2YXIgdHlwZSA9IHR5cGVvZiB2YWx1ZTtcbiAgcmV0dXJuICEhdmFsdWUgJiYgKHR5cGUgPT0gJ29iamVjdCcgfHwgdHlwZSA9PSAnZnVuY3Rpb24nKTtcbn07XG52YXIgaXNGdW5jdGlvbiA9IGZ1bmN0aW9uKGYpIHsgcmV0dXJuIHR5cGVvZiBmID09PSAnZnVuY3Rpb24nOyB9O1xudmFyIGlzQXJyYXkgPSBBcnJheS5pc0FycmF5IHx8IGZ1bmN0aW9uKGEpIHsgcmV0dXJuICdsZW5ndGgnIGluIGE7IH07XG5cbnZhciBtYXBDb25zdHJUb0ZuID0gZnVuY3Rpb24oZ3JvdXAsIGNvbnN0cikge1xuICByZXR1cm4gY29uc3RyID09PSBTdHJpbmcgICAgPyBpc1N0cmluZ1xuICAgICAgIDogY29uc3RyID09PSBOdW1iZXIgICAgPyBpc051bWJlclxuICAgICAgIDogY29uc3RyID09PSBCb29sZWFuICAgPyBpc0Jvb2xlYW5cbiAgICAgICA6IGNvbnN0ciA9PT0gT2JqZWN0ICAgID8gaXNPYmplY3RcbiAgICAgICA6IGNvbnN0ciA9PT0gQXJyYXkgICAgID8gaXNBcnJheVxuICAgICAgIDogY29uc3RyID09PSBGdW5jdGlvbiAgPyBpc0Z1bmN0aW9uXG4gICAgICAgOiBjb25zdHIgPT09IHVuZGVmaW5lZCA/IGdyb3VwXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICA6IGNvbnN0cjtcbn07XG5cbnZhciBudW1Ub1N0ciA9IFsnZmlyc3QnLCAnc2Vjb25kJywgJ3RoaXJkJywgJ2ZvdXJ0aCcsICdmaWZ0aCcsICdzaXh0aCcsICdzZXZlbnRoJywgJ2VpZ2h0aCcsICduaW50aCcsICd0ZW50aCddO1xuXG52YXIgdmFsaWRhdGUgPSBmdW5jdGlvbihncm91cCwgdmFsaWRhdG9ycywgbmFtZSwgYXJncykge1xuICB2YXIgdmFsaWRhdG9yLCB2LCBpO1xuICBmb3IgKGkgPSAwOyBpIDwgYXJncy5sZW5ndGg7ICsraSkge1xuICAgIHYgPSBhcmdzW2ldO1xuICAgIHZhbGlkYXRvciA9IG1hcENvbnN0clRvRm4oZ3JvdXAsIHZhbGlkYXRvcnNbaV0pO1xuICAgIGlmIChUeXBlLmNoZWNrID09PSB0cnVlICYmXG4gICAgICAgICh2YWxpZGF0b3IucHJvdG90eXBlID09PSB1bmRlZmluZWQgfHwgIXZhbGlkYXRvci5wcm90b3R5cGUuaXNQcm90b3R5cGVPZih2KSkgJiZcbiAgICAgICAgKHR5cGVvZiB2YWxpZGF0b3IgIT09ICdmdW5jdGlvbicgfHwgIXZhbGlkYXRvcih2KSkpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ3dyb25nIHZhbHVlICcgKyB2ICsgJyBwYXNzZWQgdG8gbG9jYXRpb24gJyArIG51bVRvU3RyW2ldICsgJyBpbiAnICsgbmFtZSk7XG4gICAgfVxuICB9XG59O1xuXG5mdW5jdGlvbiB2YWx1ZVRvQXJyYXkodmFsdWUpIHtcbiAgdmFyIGksIGFyciA9IFtdO1xuICBmb3IgKGkgPSAwOyBpIDwgdmFsdWUuX2tleXMubGVuZ3RoOyArK2kpIHtcbiAgICBhcnIucHVzaCh2YWx1ZVt2YWx1ZS5fa2V5c1tpXV0pO1xuICB9XG4gIHJldHVybiBhcnI7XG59XG5cbmZ1bmN0aW9uIGV4dHJhY3RWYWx1ZXMoa2V5cywgb2JqKSB7XG4gIHZhciBhcnIgPSBbXSwgaTtcbiAgZm9yIChpID0gMDsgaSA8IGtleXMubGVuZ3RoOyArK2kpIGFycltpXSA9IG9ialtrZXlzW2ldXTtcbiAgcmV0dXJuIGFycjtcbn1cblxuZnVuY3Rpb24gY29uc3RydWN0b3IoZ3JvdXAsIG5hbWUsIGZpZWxkcykge1xuICB2YXIgdmFsaWRhdG9ycywga2V5cyA9IE9iamVjdC5rZXlzKGZpZWxkcyksIGk7XG4gIGlmIChpc0FycmF5KGZpZWxkcykpIHtcbiAgICB2YWxpZGF0b3JzID0gZmllbGRzO1xuICB9IGVsc2Uge1xuICAgIHZhbGlkYXRvcnMgPSBleHRyYWN0VmFsdWVzKGtleXMsIGZpZWxkcyk7XG4gIH1cbiAgZnVuY3Rpb24gY29uc3RydWN0KCkge1xuICAgIHZhciB2YWwgPSBPYmplY3QuY3JlYXRlKGdyb3VwLnByb3RvdHlwZSksIGk7XG4gICAgdmFsLl9rZXlzID0ga2V5cztcbiAgICB2YWwuX25hbWUgPSBuYW1lO1xuICAgIGlmIChUeXBlLmNoZWNrID09PSB0cnVlKSB7XG4gICAgICB2YWxpZGF0ZShncm91cCwgdmFsaWRhdG9ycywgbmFtZSwgYXJndW1lbnRzKTtcbiAgICB9XG4gICAgZm9yIChpID0gMDsgaSA8IGFyZ3VtZW50cy5sZW5ndGg7ICsraSkge1xuICAgICAgdmFsW2tleXNbaV1dID0gYXJndW1lbnRzW2ldO1xuICAgIH1cbiAgICByZXR1cm4gdmFsO1xuICB9XG4gIGdyb3VwW25hbWVdID0gY3VycnlOKGtleXMubGVuZ3RoLCBjb25zdHJ1Y3QpO1xuICBpZiAoa2V5cyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgZ3JvdXBbbmFtZSsnT2YnXSA9IGZ1bmN0aW9uKG9iaikge1xuICAgICAgcmV0dXJuIGNvbnN0cnVjdC5hcHBseSh1bmRlZmluZWQsIGV4dHJhY3RWYWx1ZXMoa2V5cywgb2JqKSk7XG4gICAgfTtcbiAgfVxufVxuXG5mdW5jdGlvbiByYXdDYXNlKHR5cGUsIGNhc2VzLCB2YWx1ZSwgYXJnKSB7XG4gIHZhciB3aWxkY2FyZCA9IGZhbHNlO1xuICB2YXIgaGFuZGxlciA9IGNhc2VzW3ZhbHVlLl9uYW1lXTtcbiAgaWYgKGhhbmRsZXIgPT09IHVuZGVmaW5lZCkge1xuICAgIGhhbmRsZXIgPSBjYXNlc1snXyddO1xuICAgIHdpbGRjYXJkID0gdHJ1ZTtcbiAgfVxuICBpZiAoVHlwZS5jaGVjayA9PT0gdHJ1ZSkge1xuICAgIGlmICghdHlwZS5wcm90b3R5cGUuaXNQcm90b3R5cGVPZih2YWx1ZSkpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ3dyb25nIHR5cGUgcGFzc2VkIHRvIGNhc2UnKTtcbiAgICB9IGVsc2UgaWYgKGhhbmRsZXIgPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdub24tZXhoYXVzdGl2ZSBwYXR0ZXJucyBpbiBhIGZ1bmN0aW9uJyk7XG4gICAgfVxuICB9XG4gIHZhciBhcmdzID0gd2lsZGNhcmQgPT09IHRydWUgPyBbYXJnXVxuICAgICAgICAgICA6IGFyZyAhPT0gdW5kZWZpbmVkID8gdmFsdWVUb0FycmF5KHZhbHVlKS5jb25jYXQoW2FyZ10pXG4gICAgICAgICAgIDogdmFsdWVUb0FycmF5KHZhbHVlKTtcbiAgcmV0dXJuIGhhbmRsZXIuYXBwbHkodW5kZWZpbmVkLCBhcmdzKTtcbn1cblxudmFyIHR5cGVDYXNlID0gY3VycnlOKDMsIHJhd0Nhc2UpO1xudmFyIGNhc2VPbiA9IGN1cnJ5Tig0LCByYXdDYXNlKTtcblxuZnVuY3Rpb24gY3JlYXRlSXRlcmF0b3IoKSB7XG4gIHJldHVybiB7XG4gICAgaWR4OiAwLFxuICAgIHZhbDogdGhpcyxcbiAgICBuZXh0OiBmdW5jdGlvbigpIHtcbiAgICAgIHZhciBrZXlzID0gdGhpcy52YWwuX2tleXM7XG4gICAgICByZXR1cm4gdGhpcy5pZHggPT09IGtleXMubGVuZ3RoXG4gICAgICAgID8ge2RvbmU6IHRydWV9XG4gICAgICAgIDoge3ZhbHVlOiB0aGlzLnZhbFtrZXlzW3RoaXMuaWR4KytdXX07XG4gICAgfVxuICB9O1xufVxuXG5mdW5jdGlvbiBUeXBlKGRlc2MpIHtcbiAgdmFyIGtleSwgcmVzLCBvYmogPSB7fTtcbiAgb2JqLnByb3RvdHlwZSA9IHt9O1xuICBvYmoucHJvdG90eXBlW1N5bWJvbCA/IFN5bWJvbC5pdGVyYXRvciA6ICdAQGl0ZXJhdG9yJ10gPSBjcmVhdGVJdGVyYXRvcjtcbiAgb2JqLmNhc2UgPSB0eXBlQ2FzZShvYmopO1xuICBvYmouY2FzZU9uID0gY2FzZU9uKG9iaik7XG4gIGZvciAoa2V5IGluIGRlc2MpIHtcbiAgICByZXMgPSBjb25zdHJ1Y3RvcihvYmosIGtleSwgZGVzY1trZXldKTtcbiAgfVxuICByZXR1cm4gb2JqO1xufVxuXG5UeXBlLmNoZWNrID0gdHJ1ZTtcblxubW9kdWxlLmV4cG9ydHMgPSBUeXBlO1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG5jb25zdCBhcGlQb3J0ID0gOTAwMDtcblxuY29uc3QgYXBpVXJsID0gYGh0dHA6Ly9sb2NhbGhvc3Q6JHthcGlQb3J0fS9hcGlgO1xuXG5tb2R1bGUuZXhwb3J0cyA9IHtcbiAgYXBpUG9ydCxcbiAgYXBpVXJsXG59O1xuIiwiY29uc3QgbW9yaSA9IHJlcXVpcmUoJ21vcmknKTtcbmNvbnN0IGZseWQgPSByZXF1aXJlKCdmbHlkJyk7XG5jb25zdCB7IHN0cmVhbSB9ID0gZmx5ZDtcbmNvbnN0IHNuYWJiZG9tID0gcmVxdWlyZSgnc25hYmJkb20nKTtcbmNvbnN0IHBhdGNoID0gc25hYmJkb20uaW5pdChbXG4gIHJlcXVpcmUoJ3NuYWJiZG9tL21vZHVsZXMvY2xhc3MnKSxcbiAgcmVxdWlyZSgnc25hYmJkb20vbW9kdWxlcy9wcm9wcycpLFxuICByZXF1aXJlKCdzbmFiYmRvbS9tb2R1bGVzL3N0eWxlJyksXG4gIHJlcXVpcmUoJ3NuYWJiZG9tL21vZHVsZXMvYXR0cmlidXRlcycpLFxuICByZXF1aXJlKCdzbmFiYmRvbS9tb2R1bGVzL2V2ZW50bGlzdGVuZXJzJylcbl0pO1xuXG4vLy8gUnVucyBhbiBFbG0gYXJjaGl0ZWN0dXJlIGJhc2VkIGFwcGxpY2F0aW9uXG4vLyBpbiBvcmRlciB0byBzaW1wbGlmeSBob3QgY29kZSByZXBsYWNlbWVudCwgdGhlXG4vLyBjb21wb25lbnQgcGFyYW1ldGVyIGhlcmUgaXMgYSByZWZlcmVuY2UgdG8gYW4gb2JqZWN0XG4vLyB0aGF0IGhhcyB0aGUgdHdvIGZvbGxvd2luZyBwcm9wZXJ0aWVzOiBgdXBkYXRlYCBhbmQgYHZpZXdgXG4vLyB0aGlzIGFsbG93cyB0aGUgY29uc3VtZXIgb2YgdGhpcyBmdW5jdGlvbiB0byByZXBsYWNlXG4vLyB0aGVzZSBmdW5jdGlvbiBhdCB3aWxsLCBhbmQgdGhlbiBjYWxsIHRoZSBgcmVuZGVyYCBmdW5jdGlvblxuLy8gd2hpY2ggaXMgYSBwcm9wZXJ0eSBvbiB0aGUgb2JqZWN0IHRoYXQgaXMgcmV0dXJuZWQgYnkgYHN0YXJ0YFxuZXhwb3J0IGZ1bmN0aW9uIHN0YXJ0KHJvb3QsIG1vZGVsLCBjb21wb25lbnQpIHtcbiAgLy8gdGhpcyBpcyB0aGUgc3RyZWFtIHdoaWNoIGFjdHMgYXMgdGhlIHJ1biBsb29wLCB3aGljaCBlbmFibGVzXG4gIC8vIHVwZGF0ZXMgdG8gYmUgdHJpZ2dlcmVkIGFyYml0cmFyaWx5LlxuICAvLyBmbHlkIGhhbmRsZXMgUHJvbWlzZXMgdHJhbnNwYXJlbnRseSwgc28gbW9kZWwgY291bGQgYXMgd2VsbFxuICAvLyBiZSBhIFByb21pc2UsIHdoaWNoIHJlc29sdmVzIHRvIGEgbW9kZWwgdmFsdWUuXG4gIGNvbnN0IHN0YXRlJCA9IHN0cmVhbShtb2RlbCk7XG5cbiAgLy8gdGhpcyBpcyB0aGUgZXZlbnQgaGFuZGxlciB3aGljaCBhbGxvd3MgdGhlIHZpZXcgdG8gdHJpZ2dlclxuICAvLyBhbiB1cGRhdGUuIEl0IGV4cGVjdHMgYW4gb2JqZWN0IG9mIHR5cGUgQWN0aW9uLCBkZWZpbmVkIGFib3ZlXG4gIC8vIHVzaW5nIHRoZSBgdW5pb24tdHlwZWAgbGlicmFyeS5cbiAgY29uc3QgaGFuZGxlRXZlbnQgPSBmdW5jdGlvbiAoYWN0aW9uKSB7XG4gICAgY29uc3QgY3VycmVudFN0YXRlID0gc3RhdGUkKCk7XG4gICAgc3RhdGUkKGNvbXBvbmVudC51cGRhdGUoY3VycmVudFN0YXRlLCBhY3Rpb24pKTtcbiAgfTtcblxuICAvLyB0aGUgaW5pdGlhbCB2bm9kZSwgd2hpY2ggaXMgbm90IGEgdmlydHVhbCBub2RlLCBhdCBmaXJzdCwgYnV0IHdpbGwgYmVcbiAgLy8gYWZ0ZXIgdGhlIGZpcnN0IHBhc3MsIHdoZXJlIHRoaXMgYmluZGluZyB3aWxsIGJlIHJlYmluZGVkIHRvIGEgdmlydHVhbCBub2RlLlxuICAvLyBJLmUuIHRoZSByZXN1bHQgb2YgY2FsbGluZyB0aGUgdmlldyBmdW5jdGlvbiB3aXRoIHRoZSBpbml0aWFsIHN0YXRlIGFuZFxuICAvLyB0aGUgZXZlbnQgaGFuZGxlci5cbiAgbGV0IHZub2RlID0gcm9vdDtcblxuICAvLyBtYXBzIG92ZXIgdGhlIHN0YXRlIHN0cmVhbSwgYW5kIHBhdGNoZXMgdGhlIHZkb21cbiAgLy8gd2l0aCB0aGUgcmVzdWx0IG9mIGNhbGxpbmcgdGhlIHZpZXcgZnVuY3Rpb24gd2l0aFxuICAvLyB0aGUgY3VycmVudCBzdGF0ZSBhbmQgdGhlIGV2ZW50IGhhbmRsZXIuXG4gIGxldCBoaXN0b3J5ID0gbW9yaS52ZWN0b3IoKTtcblxuICBjb25zdCByZW5kZXIgPSAoc3RhdGUpID0+IHtcbiAgICB2bm9kZSA9IHBhdGNoKHZub2RlLCBjb21wb25lbnQudmlldyhzdGF0ZSwgaGFuZGxlRXZlbnQpKTtcbiAgfTtcblxuICAvLyB0aGUgYWN0dWFsIGFzeW5jaHJvbm91cyBydW4gbG9vcCwgd2hpY2ggc2ltcGx5IGlzIGEgbWFwcGluZyBvdmVyIHRoZVxuICAvLyBzdGF0ZSBzdHJlYW0uXG4gIGZseWQubWFwKHN0YXRlID0+IHtcbiAgICBoaXN0b3J5ID0gbW9yaS5jb25qKGhpc3RvcnksIHN0YXRlKTtcbiAgICByZW5kZXIoc3RhdGUpO1xuICAgIHJldHVybiB2bm9kZTtcbiAgfSwgc3RhdGUkKTtcblxuICAvLyByZXR1cm4gdGhlIHN0YXRlIHN0cmVhbSwgc28gdGhhdCB0aGUgY29uc3VtZXIgb2YgdGhpcyBBUEkgbWF5XG4gIC8vIGV4cG9zZSB0aGUgc3RhdGUgc3RyZWFtIHRvIG90aGVycywgaW4gb3JkZXIgZm9yIHRoZW0gdG8gaW50ZXJhY3RcbiAgLy8gd2l0aCB0aGUgYWN0aXZlIGNvbXBvbmVudC5cbiAgcmV0dXJuIHtcbiAgICBzdGF0ZSQsXG4gICAgcmVuZGVyXG4gIH07XG59O1xuXG5cbmNvbnN0IGZ1bGZpbGxzRWZmZWN0UHJvdG9jb2wgPSBxID0+IHEgJiYgcS5jb25zdHJ1Y3RvciA9PSBBcnJheSAmJiBxLmxlbmd0aCA9PT0gMjtcbmNvbnN0IGlzRWZmZWN0T2YgPSAoQSwgYSkgPT4gQS5wcm90b3R5cGUuaXNQcm90b3R5cGVPZihhKTtcblxuLy8gcnVucyBhbiBlbG0gYXJjaCBiYXNlZCBhcHBsaWNhdGlvbiwgYW5kIGFsc28gaGFuZGxlc1xuLy8gc2lkZS9lZmZlY3RzLiBJdCBkb2VzIHNvIGJ5IGFsbG93aW5nIHRoZSB1cGRhdGUgZnVuY3Rpb24gdG9cbi8vIHJldHVybiBhbiBhcnJheSB3aGljaCBsb29rcyBsaWtlIHRoaXM6XG4vLyBbIGVmZmVjdCwgbW9kZWwgXVxuLy8gd2hlcmUgdGhlIGVmZmVjdCBpcyBhbiBpbnN0YW5jZSBvZiBhbiBhY3Rpb24gZnJvbSB0aGUgY29tcG9uZW50LlxuLy8gd2hpY2ggd2lsbCBhc3luY2hyb25vdXNseSB0cmlnZ2VyIGEgcmVjdXJzaXZlIGNhbGwgdG8gdGhlXG4vLyBldmVudCBoYW5kbGVyLlxuZXhwb3J0IGZ1bmN0aW9uIGFwcGxpY2F0aW9uKHJvb3QsIGluaXQsIGNvbXBvbmVudCkge1xuICBjb25zdCBzdGF0ZSQgPSBzdHJlYW0oKTtcblxuICBjb25zdCBoYW5kbGVSZXN1bHQgPSBmdW5jdGlvbiAocmVzdWx0KSB7XG4gICAgaWYgKGZ1bGZpbGxzRWZmZWN0UHJvdG9jb2wocmVzdWx0KSAmJiBpc0VmZmVjdE9mKGNvbXBvbmVudC5BY3Rpb24sIHJlc3VsdFswXSkpIHtcbiAgICAgIGNvbnN0IFtlZmZlY3QsIG1vZGVsXSA9IHJlc3VsdDtcbiAgICAgIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiBoYW5kbGVFdmVudChlZmZlY3QpKTtcbiAgICAgIHN0YXRlJChtb2RlbCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIHJlc3VsdCBpcyB0aGUgbW9kZWxcbiAgICAgIHN0YXRlJChyZXN1bHQpO1xuICAgIH1cbiAgfTtcblxuXG4gIGNvbnN0IGhhbmRsZUV2ZW50ID0gZnVuY3Rpb24gKGFjdGlvbikge1xuICAgIGNvbnN0IGN1cnJlbnRTdGF0ZSA9IHN0YXRlJCgpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGNvbXBvbmVudC51cGRhdGUoY3VycmVudFN0YXRlLCBhY3Rpb24pO1xuICAgIGhhbmRsZVJlc3VsdChyZXN1bHQpO1xuICB9O1xuXG4gIGxldCB2bm9kZSA9IHJvb3Q7XG5cbiAgbGV0IGhpc3RvcnkgPSBtb3JpLnZlY3RvcigpO1xuXG4gIGNvbnN0IHJlbmRlciA9IChzdGF0ZSkgPT4ge1xuICAgIHZub2RlID0gcGF0Y2godm5vZGUsIGNvbXBvbmVudC52aWV3KHN0YXRlLCBoYW5kbGVFdmVudCkpO1xuICB9O1xuXG4gIGZseWQubWFwKHN0YXRlID0+IHtcbiAgICBoaXN0b3J5ID0gbW9yaS5jb25qKGhpc3RvcnksIHN0YXRlKTtcbiAgICByZW5kZXIoc3RhdGUpO1xuICAgIHJldHVybiB2bm9kZTtcbiAgfSwgc3RhdGUkKTtcblxuICBoYW5kbGVSZXN1bHQoaW5pdCgpKTtcblxuICByZXR1cm4ge1xuICAgIHN0YXRlJCxcbiAgICByZW5kZXJcbiAgfTtcbn07XG4iLCJjb25zdCByZXF1ZXN0ID0gcmVxdWlyZSgndGhlbi1yZXF1ZXN0Jyk7XG5jb25zdCBoID0gcmVxdWlyZSgnc25hYmJkb20vaCcpO1xuY29uc3QgVHlwZSA9IHJlcXVpcmUoJ3VuaW9uLXR5cGUnKTtcbmNvbnN0IGZseWQgPSByZXF1aXJlKCdmbHlkJyk7XG5jb25zdCB7IHN0cmVhbSB9ID0gZmx5ZDtcbmNvbnN0IG1vcmkgPSByZXF1aXJlKCdtb3JpLWZsdWVudCcpKHJlcXVpcmUoJ21vcmknKSk7XG5jb25zdCB7XG4gIHZlY3RvcixcbiAgaGFzaE1hcCxcbiAgbWFwLFxuICBrZXlzLFxuICB2YWxzLFxuICBlcXVhbHMsXG4gIGdldEluLFxuICBnZXQsXG4gIGFzc29jLFxuICB1cGRhdGVJbixcbiAgbnRoLFxuICB0b0NsaixcbiAgdG9Kc1xufSA9IG1vcmk7XG5cbmNvbnN0IHtzaW1wbGUsIHJhd1NWR30gPSByZXF1aXJlKCcuL3Rocm9iYmVyJyk7XG5cbmNvbnN0IHsgYXBpVXJsIH0gPSByZXF1aXJlKCcuL2NvbmZpZycpO1xuXG5jb25zdCBwYXJzZSA9IGpzb24gPT4gSlNPTi5wYXJzZShqc29uKTtcblxuZXhwb3J0IGNvbnN0IG1vZGVsID0gaGFzaE1hcChcbiAgJ2xvYWRpbmcnLCBmYWxzZSxcbiAgJ2RhdGEnLCBbXSxcbiAgJ3BhZ2UnLCAxLFxuICAncGFnZVNpemUnLCAyMFxuKTtcblxuLy8gaW5pdCBmdW5jIHdpdGggc2lkZSBlZmZlY3QuXG5leHBvcnQgY29uc3QgaW5pdCA9ICguLi5wcm9wcykgPT4gW1xuICBBY3Rpb24uSW5pdEdldCgpLFxuICBtb2RlbC5hc3NvYyguLi5wcm9wcyB8fCBbXSlcbl07XG5cbmV4cG9ydCBjb25zdCBBY3Rpb24gPSBUeXBlKHtcbiAgSW5pdEdldDogW10sXG4gIEdldDogW10sXG4gIE5leHRQYWdlOiBbXSxcbiAgUHJldlBhZ2U6IFtdXG59KTtcblxuZXhwb3J0IGNvbnN0IHVwZGF0ZSA9IChtb2RlbCwgYWN0aW9uKSA9PiB7XG4gIHJldHVybiBBY3Rpb24uY2FzZSh7XG4gICAgSW5pdEdldDogKCkgPT4ge1xuICAgICAgcmV0dXJuIFtcbiAgICAgICAgQWN0aW9uLkdldCgpLFxuICAgICAgICBtb2RlbC5hc3NvYyhcbiAgICAgICAgICAnbG9hZGluZycsIHRydWVcbiAgICAgICAgKVxuICAgICAgXTtcbiAgICB9LFxuICAgIEdldDogKCkgPT4gcmVxdWVzdCgnR0VUJywgYCR7YXBpVXJsfS9kYXRhYCkuZ2V0Qm9keSgpXG4gICAgICAudGhlbihkID0+IHtcbiAgICAgICAgY29uc3QgcmVzID0gcGFyc2UoZCk7XG4gICAgICAgIGNvbnN0IHdvcmRzID0gcmVzLnNwbGl0KCdcXG4nKTtcbiAgICAgICAgcmV0dXJuIG1vZGVsLmFzc29jKFxuICAgICAgICAgICdsb2FkaW5nJywgZmFsc2UsXG4gICAgICAgICAgJ2RhdGEnLCB3b3Jkc1xuICAgICAgICApO1xuICAgICAgfSksXG4gICAgTmV4dFBhZ2U6ICgpID0+IHVwZGF0ZUluKG1vZGVsLCBbICdwYWdlJyBdLCBtb3JpLmluYyksXG4gICAgUHJldlBhZ2U6ICgpID0+IHVwZGF0ZUluKG1vZGVsLCBbICdwYWdlJyBdLCBtb3JpLmRlYylcbiAgfSwgYWN0aW9uKTtcbn07XG5cbmV4cG9ydCBjb25zdCB2aWV3ID0gKG1vZGVsLCBldmVudCkgPT4ge1xuICBjb25zdCB7XG4gICAgbG9hZGluZyxcbiAgICBkYXRhLFxuICAgIHBhZ2UsXG4gICAgcGFnZVNpemVcbiAgfSA9IG1vZGVsLnRvSnMoKTtcblxuICBjb25zdCBwZyA9IGRhdGEuc2xpY2UoKHBhZ2UgLSAxKSAqIHBhZ2VTaXplLCBwYWdlICogcGFnZVNpemUpO1xuXG4gIHJldHVybiBoKCdkaXYnLCBbXG4gICAgbG9hZGluZyA/XG4gICAgICBoKCdkaXYudGhyb2JiZXInLCB7XG4gICAgICAgIHN0eWxlOiB7XG4gICAgICAgICAgYmFja2dyb3VuZDogJyNkZGQnLFxuICAgICAgICAgIGRpc3BsYXk6ICdmbGV4JyxcbiAgICAgICAgICBoZWlnaHQ6ICcxMDAlJyxcbiAgICAgICAgICBhbGlnbkl0ZW1zOiAnY2VudGVyJyxcbiAgICAgICAgICBqdXN0aWZ5Q29udGVudDogJ2NlbnRlcidcbiAgICAgICAgfVxuICAgICAgfSwgW1xuICAgICAgICBoKCdzcGFuJywge1xuICAgICAgICAgIHByb3BzOiB7XG4gICAgICAgICAgICBpbm5lckhUTUw6IHJhd1NWRygxMDApXG4gICAgICAgICAgfVxuICAgICAgICB9KVxuICAgICAgXSlcbiAgICA6IGgoJ2RpdicsIHtzdHlsZToge2NvbG9yOiAnI2VlZScsIGJhY2tncm91bmQ6ICcjNjY2J319LCBbXG4gICAgICBoKCdidXR0b24nLCB7XG4gICAgICAgIHByb3BzOiB7IHR5cGU6ICdidXR0b24nLCBkaXNhYmxlZDogcGFnZSA9PT0gMSB9LFxuICAgICAgICBvbjoge1xuICAgICAgICAgIGNsaWNrOiBlID0+IGV2ZW50KEFjdGlvbi5QcmV2UGFnZSgpKVxuICAgICAgICB9XG4gICAgICB9LCAnUHJldiBwYWdlJyksXG4gICAgICBoKCdzcGFuJywge3N0eWxlOiB7Zm9udFdlaWdodDogJ2JvbGQnLCBtYXJnaW46ICcxcmVtIDJyZW0nfX0sIHBhZ2UpLFxuICAgICAgaCgnYnV0dG9uJywge1xuICAgICAgICBwcm9wczogeyB0eXBlOiAnYnV0dG9uJywgZGlzYWJsZWQ6IHBhZ2UgKiBwYWdlU2l6ZSA+PSBkYXRhLmxlbmd0aCB9LFxuICAgICAgICBvbjoge1xuICAgICAgICAgIGNsaWNrOiBlID0+IGV2ZW50KEFjdGlvbi5OZXh0UGFnZSgpKVxuICAgICAgICB9XG4gICAgICB9LCAnTmV4dCBwYWdlJyksXG4gICAgXSksXG4gICAgaCgnZGl2JywgdG9KcyhtYXAodCA9PiBoKCdkaXYnLCB0KSwgcGcpKSlcbiAgXSk7XG59O1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG5jb25zdCBtb3JpID0gcmVxdWlyZSgnbW9yaS1mbHVlbnQnKShyZXF1aXJlKCdtb3JpJyksIHJlcXVpcmUoJ21vcmktZmx1ZW50L2V4dHJhJykpO1xuY29uc3QgeyBzdGFydCwgYXBwbGljYXRpb24gfSA9IHJlcXVpcmUoJy4vY29yZScpO1xuXG4vLyB0aGUgd3JhcHBlciByb290IGNvbXBvbmVudCwgd2hpY2ggaXMgdXNlZCB0byBmYWNpbGl0YXRlXG4vLyBrZWVwaW5nIHRoaXMgbW9kdWxlIHNvbWV3aGF0IGFnbm9zdGljIHRvIGNoYW5nZXMgaW4gdGhlXG4vLyB1bmRlcmx5aW5nIGNvbXBvbmVudHMsIHdoaWNoIGhlbHBzIHRvIGtlZXAgdGhlIGxvZ2ljXG4vLyByZWdhcmRpbmcgaG90IGNvZGUgc2ltcGxlLlxuY29uc3QgUm9vdENvbXBvbmVudCA9IHJlcXVpcmUoJy4vcm9vdF9jb21wb25lbnQnKTtcblxuZnVuY3Rpb24gaW5pdCgpIHtcbiAgLy8gdGhpcyBpcyB0aGUgZWxlbWVudCBpbiB3aGljaCBvdXIgY29tcG9uZW50IGlzIHJlbmRlcmVkXG4gIGNvbnN0IHJvb3QgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcjcm9vdCcpO1xuXG4gIC8vIHN0YXJ0IHJldHVybnMgYW4gb2JqZWN0IHRoYXQgY29udGFpbnMgdGhlIHN0YXRlIHN0cmVhbVxuICAvLyBhbmQgYSByZW5kZXIgZnVuY3Rpb24sIHdoaWNoIGluIHR1cm4gYWNjZXB0cyBhIG1vZGVsXG4gIGNvbnN0IHtcbiAgICBzdGF0ZSQsXG4gICAgcmVuZGVyXG4gIC8vfSA9IHN0YXJ0KHJvb3QsIFJvb3RDb21wb25lbnQuaW5pdCgpLCBSb290Q29tcG9uZW50KTtcbiAgfSA9IGFwcGxpY2F0aW9uKHJvb3QsIFJvb3RDb21wb25lbnQuaW5pdCwgUm9vdENvbXBvbmVudCk7XG5cblxuICAvLyBJZiBob3QgbW9kdWxlIHJlcGxhY2VtZW50IGlzIGVuYWJsZWRcbiAgaWYgKG1vZHVsZS5ob3QpIHtcbiAgICAvLyBXZSBhY2NlcHQgdXBkYXRlcyB0byB0aGUgdG9wIGNvbXBvbmVudFxuICAgIG1vZHVsZS5ob3QuYWNjZXB0KCcuL3Jvb3RfY29tcG9uZW50JywgKGNvbXApID0+IHtcbiAgICAgIC8vIFJlbG9hZCB0aGUgY29tcG9uZW50XG4gICAgICBjb25zdCBjb21wb25lbnQgPSByZXF1aXJlKCcuL3Jvb3RfY29tcG9uZW50Jyk7XG4gICAgICAvLyBNdXRhdGUgdGhlIHZhcmlhYmxlIGhvbGRpbmcgb3VyIGNvbXBvbmVudCB3aXRoIHRoZSBuZXcgY29kZVxuICAgICAgT2JqZWN0LmFzc2lnbihSb290Q29tcG9uZW50LCBjb21wb25lbnQpO1xuICAgICAgLy8gUmVuZGVyIHZpZXcgaW4gdGhlIGNhc2UgdGhhdCBhbnkgdmlldyBmdW5jdGlvbnMgaGFzIGNoYW5nZWRcbiAgICAgIHJlbmRlcihzdGF0ZSQoKSk7XG4gICAgfSk7XG4gIH1cblxuICAvLyBleHBvc2UgdGhlIHN0YXRlIHN0cmVhbSB0byB3aW5kb3csIHdoaWNoIGFsbG93cyBmb3IgZGVidWdnaW5nLFxuICAvLyBlLmcuIHdpbmRvdy5zdGF0ZSQoPG1vZGVsPikgd291bGQgdHJpZ2dlciBhIHJlbmRlciB3aXRoIHRoZSBuZXcgZGF0YS5cbiAgd2luZG93LnN0YXRlJCA9IHN0YXRlJDtcblxuICAvLyBzaW5jZSB0aGUgc3RhdGUgaXMgYSBtb3JpIGRhdGEgc3RydWN0dXJlLCBhbHNvIGV4cG9zZSBtb3JpXG4gIHdpbmRvdy5tb3JpID0gbW9yaTtcbn1cblxuLy8vIEJPT1RTVFJBUFBJTkdcbmNvbnN0IHJlYWR5U3RhdGVzID0ge2ludGVyYWN0aXZlOjEsIGNvbXBsZXRlOjF9O1xuaWYgKGRvY3VtZW50LnJlYWR5U3RhdGUgaW4gcmVhZHlTdGF0ZXMpIHtcbiAgaW5pdCgpO1xufSBlbHNlIHtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignRE9NQ29udGVudExvYWRlZCcsIGluaXQpO1xufVxuIiwiY29uc3QgYXBwID0gcmVxdWlyZSgnLi9saXN0Jyk7XG4vL2NvbnN0IGFwcCA9IHJlcXVpcmUoJy4vb3V0bGlzdCcpO1xuXG4vL2V4cG9ydCBjb25zdCBpbml0ID0gYXBwLmluaXRBbmRGZXRjaDtcbmV4cG9ydCBjb25zdCBpbml0ID0gYXBwLmluaXQ7XG5leHBvcnQgY29uc3QgdXBkYXRlID0gYXBwLnVwZGF0ZTtcbmV4cG9ydCBjb25zdCB2aWV3ID0gYXBwLnZpZXc7XG5leHBvcnQgY29uc3QgQWN0aW9uID0gYXBwLkFjdGlvbjtcbiIsIlxuY29uc3QgaCA9IHJlcXVpcmUoJ3NuYWJiZG9tL2gnKTtcblxuY29uc3QgZGVmYXVsdFNpemUgPSAzMjtcbmV4cG9ydCBjb25zdCByYXdTVkcgPSAoc2l6ZSkgPT4gYFxuICAgIDxzdmcgd2lkdGg9XCIke3NpemUgfHwgZGVmYXVsdFNpemV9XCIgaGVpZ2h0PVwiJHtzaXplIHx8IGRlZmF1bHRTaXplfVwiIHZpZXdCb3g9XCIwIDAgMzAwIDMwMFwiXG4gICAgICAgICB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCIgdmVyc2lvbj1cIjEuMVwiPlxuICAgICAgPHBhdGggZD1cIk0gMTUwLDBcbiAgICAgICAgICAgICAgIGEgMTUwLDE1MCAwIDAsMSAxMDYuMDY2LDI1Ni4wNjZcbiAgICAgICAgICAgICAgIGwgLTM1LjM1NSwtMzUuMzU1XG4gICAgICAgICAgICAgICBhIC0xMDAsLTEwMCAwIDAsMCAtNzAuNzExLC0xNzAuNzExIHpcIlxuICAgICAgICAgICAgZmlsbD1cIiMxNEM5NjRcIj5cbiAgICAgIDwvcGF0aD5cbiAgICA8L3N2Zz5cbmA7XG5cbmV4cG9ydCBjb25zdCBzaW1wbGUgPSBoKCdzdmcnLCB7XG4gIHdpZHRoOiAxNiwgaGVpZ2h0OiAxNixcbiAgdmlld0JveDogJzAgMCAzMDAgMzAwJ1xufSwgW1xuICBoKCdwYXRoJywge1xuICAgIGF0dHJzOiB7XG4gICAgICBkOiBgTSAxNTAsMFxuICAgICAgYSAxNTAsMTUwIDAgMCwxIDEwNi4wNjYsMjU2LjA2NlxuICAgICAgbCAtMzUuMzU1LC0zNS4zNTVcbiAgICAgIGEgLTEwMCwtMTAwIDAgMCwwIC03MC43MTEsLTE3MC43MTEgemAsXG4gICAgICBmaWxsOiAnIzE0Qzk2NCdcbiAgICB9XG4gIH0sIFtcbiAgICBoKCdhbmltYXRlVHJhbnNmb3JtJywge1xuICAgICAgYXR0cnM6IHtcbiAgICAgICAgYXR0cmlidXRlTmFtZTondHJhbnNmb3JtJyxcbiAgICAgICAgYXR0cmlidXRlVHlwZTonWE1MJyxcbiAgICAgICAgdHlwZToncm90YXRlJyxcbiAgICAgICAgZnJvbTonMCAxNTAgMTUwJyxcbiAgICAgICAgdG86JzM2MCAxNTAgMTUwJyxcbiAgICAgICAgYmVnaW46JzBzJyxcbiAgICAgICAgZHVyOicxcycsXG4gICAgICAgIGZpbGw6J2ZyZWV6ZScsXG4gICAgICAgIHJlcGVhdENvdW50OidpbmRlZmluaXRlJ1xuICAgICAgfVxuICAgIH0pXG4gIF0pXG5dKTtcbiJdfQ==
