/**
 * 沙箱前奏：在 QuickJS 里求值一次，搭好模板能用的全局环境（M5（三）契约 §4.1）。
 *
 * - 宿主只暴露**一个**同步函数 `__hostCall(name, argsJson) → string`（`u` = undefined、
 *   `j<json>` = 值、`e<message>` = 抛错），前奏把它包成 getvar / setvar / getwi 等，然后从全局删掉。
 * - `getwi` / `evalTemplate` 是沙箱里的 async 函数：宿主只负责找条目、编译模板源码，
 *   递归渲染在沙箱内完成，`await` 靠宿主循环 `executePendingJobs` 推进。
 * - `_` 是 lodash 的小子集（纯 JS）；访问没实现的方法会抛错并指出名字。
 * - ST-Prompt-Template 里有、这里没实现的函数：调用即抛错，信息里带函数名。
 *
 * 这段是**沙箱内**执行的代码，用 String.raw 保住反斜杠；里面不能出现反引号与 `${`。
 */

export const MAX_TEMPLATE_DEPTH = 5;

/** ST-Prompt-Template 提供、新酒馆未实现的名字（函数调用即抛错） */
export const UNIMPLEMENTED_FUNCTIONS = [
  'getchar',
  'getchr',
  'getChara',
  'getprp',
  'getpreset',
  'getPresetPrompt',
  'getqr',
  'getQuickReply',
  'define',
  'execute',
  'activewi',
  'activateWorldInfo',
  'activateWorldInfoByKeywords',
  'activateRegex',
  'injectPrompt',
  'getPromptsInjected',
  'hasPromptsInjected',
  'getChatMessage',
  'getChatMessages',
  'matchChatMessages',
  'getCharaData',
  'getCharData',
  'getWorldInfoData',
  'getWorldInfoActivatedData',
  'getEnabledWorldInfoEntries',
  'getEnabledLoreBooks',
  'selectActivatedEntries',
  'getQuickReplyData',
  'findVariables',
  'insvar',
  'insertLocalVar',
  'insertGlobalVar',
  'insertMessageVar',
  'patchVariables',
  'jsonPatch',
  'applyVarYamlAnnotate',
  'setVariableSchema',
] as const;

/** 未实现的对象（访问即抛错） */
export const UNIMPLEMENTED_OBJECTS = [
  'faker',
  '$',
  'toastr',
  'SillyTavern',
  'z',
  'groups',
] as const;

export const PRELUDE = String.raw`
(function () {
  var hostCall = globalThis.__hostCall;
  delete globalThis.__hostCall;
  var MAX_DEPTH = __MAX_DEPTH__;
  var UNDEF = '\u0000undefined';

  function encode(args) {
    return JSON.stringify(args, function (key, value) {
      if (value === undefined) return UNDEF;
      if (value instanceof RegExp) return { regex: value.source, flags: value.flags };
      if (typeof value === 'function') return undefined;
      return value;
    });
  }
  function call(name, args) {
    var r = hostCall(name, encode(args));
    if (r === 'u') return undefined;
    var tag = r.charAt(0);
    var body = r.slice(1);
    if (tag === 'e') throw new Error(body);
    return JSON.parse(body);
  }

  // ───── lodash 子集 ─────
  function toPath(path) {
    if (Array.isArray(path)) return path.map(String);
    if (typeof path === 'number') return [String(path)];
    if (typeof path !== 'string' || path === '') return [];
    var out = [];
    var re = /[^.[\]]+|\[(?:(-?\d+(?:\.\d+)?)|(["'])((?:(?!\2)[^\\]|\\.)*?)\2)\]|(?=(?:\.|\[\])(?:\.|\[\]|$))/g;
    path.replace(re, function (match, number, quote, sub) {
      out.push(quote ? sub.replace(/\\(\\)?/g, '$1') : number !== undefined ? number : match);
      return match;
    });
    if (path.charAt(0) === '.') out.unshift('');
    return out;
  }
  function isObjectLike(v) { return typeof v === 'object' && v !== null; }
  function isPlainObject(v) {
    if (!isObjectLike(v) || Object.prototype.toString.call(v) !== '[object Object]') return false;
    var proto = Object.getPrototypeOf(v);
    return proto === null || proto === Object.prototype;
  }
  function get(obj, path, defaults) {
    var segs = toPath(path);
    var cur = obj;
    for (var i = 0; i < segs.length; i++) {
      if (cur === null || cur === undefined) return defaults;
      cur = cur[segs[i]];
    }
    return cur === undefined ? defaults : cur;
  }
  function has(obj, path) {
    var segs = toPath(path);
    var cur = obj;
    for (var i = 0; i < segs.length; i++) {
      if (!isObjectLike(cur) || !Object.prototype.hasOwnProperty.call(cur, segs[i])) return false;
      cur = cur[segs[i]];
    }
    return segs.length > 0;
  }
  function set(obj, path, value) {
    if (!isObjectLike(obj)) return obj;
    var segs = toPath(path);
    var cur = obj;
    for (var i = 0; i < segs.length - 1; i++) {
      var next = cur[segs[i]];
      if (!isObjectLike(next)) cur[segs[i]] = /^\d+$/.test(segs[i + 1]) ? [] : {};
      cur = cur[segs[i]];
    }
    if (segs.length) cur[segs[segs.length - 1]] = value;
    return obj;
  }
  function unset(obj, path) {
    var segs = toPath(path);
    var parent = segs.length > 1 ? get(obj, segs.slice(0, -1)) : obj;
    if (!isObjectLike(parent)) return true;
    return delete parent[segs[segs.length - 1]];
  }
  function cloneDeep(v) {
    if (!isObjectLike(v)) return v;
    if (v instanceof Date) return new Date(v.getTime());
    if (v instanceof RegExp) return new RegExp(v.source, v.flags);
    if (Array.isArray(v)) return v.map(cloneDeep);
    var out = {};
    for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = cloneDeep(v[k]);
    return out;
  }
  function clone(v) {
    if (!isObjectLike(v)) return v;
    return Array.isArray(v) ? v.slice() : Object.assign({}, v);
  }
  function mergeInto(target, source, customizer) {
    for (var k in source) {
      if (!Object.prototype.hasOwnProperty.call(source, k)) continue;
      var sv = source[k];
      var custom = customizer ? customizer(target[k], sv, k, target, source) : undefined;
      if (custom !== undefined) { target[k] = custom; continue; }
      if (isPlainObject(sv) || Array.isArray(sv)) {
        var tv = target[k];
        var base = Array.isArray(sv) ? (Array.isArray(tv) ? tv : []) : (isPlainObject(tv) ? tv : {});
        target[k] = mergeInto(base, sv, customizer);
      } else if (sv !== undefined || !(k in target)) {
        target[k] = sv;
      }
    }
    return target;
  }
  function merge(target) {
    for (var i = 1; i < arguments.length; i++) if (isObjectLike(arguments[i])) mergeInto(target, arguments[i]);
    return target;
  }
  function mergeWith(target) {
    var customizer = arguments[arguments.length - 1];
    for (var i = 1; i < arguments.length - 1; i++) if (isObjectLike(arguments[i])) mergeInto(target, arguments[i], customizer);
    return target;
  }
  function isEqual(a, b) {
    if (a === b) return true;
    if (a !== a && b !== b) return true;
    if (!isObjectLike(a) || !isObjectLike(b)) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var i = 0; i < ka.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(b, ka[i]) || !isEqual(a[ka[i]], b[ka[i]])) return false;
    }
    return true;
  }
  function isEmpty(v) {
    if (v === null || v === undefined) return true;
    if (typeof v === 'string' || Array.isArray(v)) return v.length === 0;
    if (v instanceof Map || v instanceof Set) return v.size === 0;
    if (typeof v === 'object') return Object.keys(v).length === 0;
    return true;
  }
  function toNumber(v) { return typeof v === 'number' ? v : Number(v); }
  function clamp(n, lo, hi) {
    if (hi === undefined) { hi = lo; lo = undefined; }
    n = toNumber(n);
    if (hi !== undefined) n = n <= hi ? n : hi;
    if (lo !== undefined) n = n >= lo ? n : lo;
    return n;
  }
  function range(start, end, step) {
    if (end === undefined) { end = start; start = 0; }
    step = step === undefined ? (start < end ? 1 : -1) : step;
    var out = [];
    if (step === 0) return out;
    for (var i = start; step > 0 ? i < end : i > end; i += step) out.push(i);
    return out;
  }
  function random(lo, hi, floating) {
    if (hi === undefined) { hi = lo === undefined ? 1 : lo; lo = 0; }
    if (floating || lo % 1 || hi % 1) return lo + Math.random() * (hi - lo);
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }
  function iteratee(fn) {
    if (typeof fn === 'function') return fn;
    if (typeof fn === 'string') return function (o) { return get(o, fn); };
    if (isPlainObject(fn)) return function (o) { for (var k in fn) if (!isEqual(get(o, k), fn[k])) return false; return true; };
    return function (o) { return o; };
  }
  function collection(c) {
    if (Array.isArray(c)) return c;
    if (typeof c === 'string') return c.split('');
    if (isObjectLike(c)) return Object.keys(c).map(function (k) { return c[k]; });
    return [];
  }
  function sortBy(c, fns) {
    var list = collection(c).slice();
    var fs = (Array.isArray(fns) ? fns : [fns === undefined ? function (x) { return x; } : fns]).map(iteratee);
    return list.map(function (v, i) { return { v: v, i: i }; }).sort(function (a, b) {
      for (var j = 0; j < fs.length; j++) {
        var x = fs[j](a.v), y = fs[j](b.v);
        if (x < y) return -1;
        if (x > y) return 1;
      }
      return a.i - b.i;
    }).map(function (e) { return e.v; });
  }
  var lodash = {
    get: get, set: set, has: has, unset: unset, toPath: toPath,
    clone: clone, cloneDeep: cloneDeep, merge: merge, mergeWith: mergeWith, isEqual: isEqual,
    isArray: Array.isArray, isPlainObject: isPlainObject, isObject: function (v) { return v !== null && (typeof v === 'object' || typeof v === 'function'); },
    isString: function (v) { return typeof v === 'string'; }, isNumber: function (v) { return typeof v === 'number'; },
    isBoolean: function (v) { return typeof v === 'boolean'; }, isFunction: function (v) { return typeof v === 'function'; },
    isNil: function (v) { return v === null || v === undefined; }, isNull: function (v) { return v === null; },
    isUndefined: function (v) { return v === undefined; }, isEmpty: isEmpty,
    isInteger: Number.isInteger, isFinite: Number.isFinite, isNaN: function (v) { return typeof v === 'number' && v !== v; },
    toNumber: toNumber, toString: function (v) { return v === null || v === undefined ? '' : String(v); },
    clamp: clamp, inRange: function (n, a, b) { if (b === undefined) { b = a; a = 0; } return n >= Math.min(a, b) && n < Math.max(a, b); },
    random: random, range: range,
    round: function (n, p) { var m = Math.pow(10, p || 0); return Math.round(n * m) / m; },
    floor: function (n, p) { var m = Math.pow(10, p || 0); return Math.floor(n * m) / m; },
    ceil: function (n, p) { var m = Math.pow(10, p || 0); return Math.ceil(n * m) / m; },
    sum: function (a) { return collection(a).reduce(function (s, x) { return s + (x === undefined ? 0 : x); }, 0); },
    sumBy: function (a, f) { var it = iteratee(f); return collection(a).reduce(function (s, x) { return s + (it(x) || 0); }, 0); },
    max: function (a) { var l = collection(a); return l.length ? l.reduce(function (m, x) { return x > m ? x : m; }) : undefined; },
    min: function (a) { var l = collection(a); return l.length ? l.reduce(function (m, x) { return x < m ? x : m; }) : undefined; },
    mean: function (a) { var l = collection(a); return l.length ? l.reduce(function (s, x) { return s + x; }, 0) / l.length : NaN; },
    keys: function (o) { return isObjectLike(o) ? Object.keys(o) : []; },
    values: function (o) { return collection(o); },
    entries: function (o) { return isObjectLike(o) ? Object.keys(o).map(function (k) { return [k, o[k]]; }) : []; },
    toPairs: function (o) { return isObjectLike(o) ? Object.keys(o).map(function (k) { return [k, o[k]]; }) : []; },
    fromPairs: function (p) { var o = {}; (p || []).forEach(function (e) { o[e[0]] = e[1]; }); return o; },
    pick: function (o, ks) { var out = {}; [].concat(ks).forEach(function (k) { if (has(o, k)) set(out, k, get(o, k)); }); return out; },
    omit: function (o, ks) { var out = Object.assign({}, o); [].concat(ks).forEach(function (k) { delete out[k]; }); return out; },
    defaults: function (o) { for (var i = 1; i < arguments.length; i++) { var s = arguments[i]; for (var k in s) if (o[k] === undefined) o[k] = s[k]; } return o; },
    assign: Object.assign,
    size: function (c) { return c === null || c === undefined ? 0 : (typeof c === 'string' || Array.isArray(c) ? c.length : Object.keys(c).length); },
    includes: function (c, v) { return typeof c === 'string' ? c.indexOf(v) !== -1 : collection(c).some(function (x) { return isEqual(x, v) || x === v; }); },
    map: function (c, f) { var it = iteratee(f); if (Array.isArray(c)) return c.map(it); return isObjectLike(c) ? Object.keys(c).map(function (k) { return it(c[k], k, c); }) : []; },
    filter: function (c, f) { var it = iteratee(f); return collection(c).filter(it); },
    reject: function (c, f) { var it = iteratee(f); return collection(c).filter(function (x) { return !it(x); }); },
    find: function (c, f) { var it = iteratee(f); return collection(c).find(it); },
    findIndex: function (a, f) { return (a || []).findIndex(iteratee(f)); },
    some: function (c, f) { return collection(c).some(iteratee(f)); },
    every: function (c, f) { return collection(c).every(iteratee(f)); },
    forEach: function (c, f) { if (Array.isArray(c)) c.forEach(f); else if (isObjectLike(c)) Object.keys(c).forEach(function (k) { f(c[k], k, c); }); return c; },
    each: function (c, f) { return lodash.forEach(c, f); },
    reduce: function (c, f, acc) { var hasAcc = arguments.length > 2; if (Array.isArray(c)) return hasAcc ? c.reduce(f, acc) : c.reduce(f); var r = acc; Object.keys(c || {}).forEach(function (k, i) { r = (i === 0 && !hasAcc) ? c[k] : f(r, c[k], k, c); }); return r; },
    groupBy: function (c, f) { var it = iteratee(f), out = {}; collection(c).forEach(function (x) { var k = it(x); (out[k] = out[k] || []).push(x); }); return out; },
    countBy: function (c, f) { var it = iteratee(f), out = {}; collection(c).forEach(function (x) { var k = it(x); out[k] = (out[k] || 0) + 1; }); return out; },
    keyBy: function (c, f) { var it = iteratee(f), out = {}; collection(c).forEach(function (x) { out[it(x)] = x; }); return out; },
    mapValues: function (o, f) { var it = iteratee(f), out = {}; Object.keys(o || {}).forEach(function (k) { out[k] = it(o[k], k, o); }); return out; },
    sortBy: sortBy,
    orderBy: function (c, fns, orders) { var list = sortBy(c, fns); return orders && [].concat(orders)[0] === 'desc' ? list.reverse() : list; },
    uniq: function (a) { var out = []; (a || []).forEach(function (x) { if (out.indexOf(x) === -1) out.push(x); }); return out; },
    uniqBy: function (a, f) { var it = iteratee(f), seen = [], out = []; (a || []).forEach(function (x) { var k = it(x); if (seen.indexOf(k) === -1) { seen.push(k); out.push(x); } }); return out; },
    compact: function (a) { return (a || []).filter(Boolean); },
    concat: function () { var out = []; for (var i = 0; i < arguments.length; i++) out = out.concat(arguments[i]); return out; },
    flatten: function (a) { return [].concat.apply([], a || []); },
    flattenDeep: function flat(a) { return (a || []).reduce(function (o, x) { return o.concat(Array.isArray(x) ? flat(x) : x); }, []); },
    difference: function (a, b) { return (a || []).filter(function (x) { return (b || []).indexOf(x) === -1; }); },
    intersection: function (a, b) { return (a || []).filter(function (x) { return (b || []).indexOf(x) !== -1; }); },
    union: function () { return lodash.uniq(lodash.concat.apply(null, arguments)); },
    without: function (a) { var ex = [].slice.call(arguments, 1); return (a || []).filter(function (x) { return ex.indexOf(x) === -1; }); },
    chunk: function (a, n) { n = n || 1; var out = []; for (var i = 0; i < (a || []).length; i += n) out.push(a.slice(i, i + n)); return out; },
    first: function (a) { return a ? a[0] : undefined; }, head: function (a) { return a ? a[0] : undefined; },
    last: function (a) { return a && a.length ? a[a.length - 1] : undefined; },
    nth: function (a, n) { n = n || 0; return a ? a[n < 0 ? a.length + n : n] : undefined; },
    take: function (a, n) { return (a || []).slice(0, n === undefined ? 1 : n); },
    takeRight: function (a, n) { n = n === undefined ? 1 : n; return n ? (a || []).slice(-n) : []; },
    drop: function (a, n) { return (a || []).slice(n === undefined ? 1 : n); },
    reverse: function (a) { return a ? a.reverse() : a; },
    sample: function (c) { var l = collection(c); return l[Math.floor(Math.random() * l.length)]; },
    shuffle: function (c) { var l = collection(c).slice(); for (var i = l.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = l[i]; l[i] = l[j]; l[j] = t; } return l; },
    times: function (n, f) { var out = []; for (var i = 0; i < n; i++) out.push(f ? f(i) : i); return out; },
    identity: function (v) { return v; }, noop: function () {},
    trim: function (s, c) { s = s === undefined || s === null ? '' : String(s); return c === undefined ? s.trim() : s; },
    startsWith: function (s, t) { return String(s).indexOf(t) === 0; }, endsWith: function (s, t) { s = String(s); return s.slice(-String(t).length) === String(t); },
    padStart: function (s, n, c) { return String(s).padStart(n, c); }, padEnd: function (s, n, c) { return String(s).padEnd(n, c); },
    repeat: function (s, n) { return String(s).repeat(n); }, split: function (s, sep, lim) { return String(s).split(sep, lim); },
    toUpper: function (s) { return String(s).toUpperCase(); }, toLower: function (s) { return String(s).toLowerCase(); },
    capitalize: function (s) { s = String(s).toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); },
    escape: function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); },
  };
  var _ = new Proxy(lodash, {
    get: function (target, name) {
      if (typeof name !== 'string' || Object.prototype.hasOwnProperty.call(target, name)) return target[name];
      throw new Error('_.' + name + ' 在新酒馆的 EJS 沙箱里未实现');
    },
  });

  // ───── 模板环境 ─────
  var varsCache = null;
  function touched(result) { varsCache = null; return result; }
  function scoped(fn, scope, key) {
    return function (k, a, b) {
      var opts = fn === 'getvar' || fn === 'delvar' ? a : b;
      var o = Object.assign({}, typeof opts === 'object' && opts !== null ? opts : {});
      o[key] = scope;
      if (fn === 'getvar') return call('getvar', [k === undefined ? null : k, o]);
      if (fn === 'delvar') return touched(call('delvar', [k, undefined, o]));
      return touched(call(fn, [k, a, o]));
    };
  }

  var depth = 0;
  var rootLocals = null;
  function escapeFn(v) { return v; }

  async function renderNested(content, extra) {
    if (typeof content !== 'string') return content;
    if (depth >= MAX_DEPTH) throw new Error('模板递归超过 ' + MAX_DEPTH + ' 层（getwi / evalTemplate）');
    var src = call('compile', [content]);
    if (src === null || src === undefined) return content;
    var fn = (0, eval)(src);
    var locals = Object.create(rootLocals);
    if (isObjectLike(extra)) Object.assign(locals, extra);
    depth++;
    try {
      return await fn(locals, escapeFn);
    } finally {
      depth--;
    }
  }

  async function getwi(a, b, c) {
    var book, title, data;
    if (b === undefined || isPlainObject(b)) { book = null; title = a; data = b; }
    else { book = a; title = b; data = c; }
    var hit = call('getwi', [book === undefined ? null : book, title]);
    if (hit === null || hit === undefined) return '';
    return await renderNested(hit.content, Object.assign({}, isObjectLike(data) ? data : {}, {
      world_info: { comment: hit.comment, uid: hit.uid, world: hit.world },
    }));
  }

  async function evalTemplate(content, data) {
    var out = await renderNested(content, data);
    return call('macros', [out]);
  }

  function unimplemented(name) {
    return function () { throw new Error('ST-Prompt-Template 的 ' + name + '() 在新酒馆里未实现'); };
  }

  globalThis.__init = function (env) {
    var L = {
      getvar: function (k, o) { return call('getvar', [k === undefined ? null : k, o]); },
      setvar: function (k, v, o) { return touched(call('setvar', [k === undefined ? null : k, v, o])); },
      incvar: function (k, v, o) { return touched(call('incvar', [k, v === undefined ? 1 : v, o])); },
      decvar: function (k, v, o) { return touched(call('incvar', [k, -(v === undefined ? 1 : v), o])); },
      delvar: function (k, i, o) { return touched(call('delvar', [k, i, o])); },
      getLocalVar: scoped('getvar', 'local', 'scope'),
      getGlobalVar: scoped('getvar', 'global', 'scope'),
      getMessageVar: scoped('getvar', 'message', 'scope'),
      setLocalVar: scoped('setvar', 'local', 'scope'),
      setGlobalVar: scoped('setvar', 'global', 'scope'),
      setMessageVar: scoped('setvar', 'message', 'scope'),
      incLocalVar: scoped('incvar', 'local', 'outscope'),
      incGlobalVar: scoped('incvar', 'global', 'outscope'),
      incMessageVar: scoped('incvar', 'message', 'outscope'),
      delLocalVar: scoped('delvar', 'local', 'scope'),
      delGlobalVar: scoped('delvar', 'global', 'scope'),
      delMessageVar: scoped('delvar', 'message', 'scope'),
      getwi: getwi,
      getWorldInfo: getwi,
      evalTemplate: evalTemplate,
      parseJSON: function (s) { try { return JSON.parse(s); } catch (e) { return null; } },
      _: _,
      console: {
        log: function () {}, info: function () {}, debug: function () {},
        warn: function () { call('warn', [[].slice.call(arguments).join(' ')]); },
        error: function () { call('warn', [[].slice.call(arguments).join(' ')]); },
      },
    };
    ['decLocalVar', 'decGlobalVar', 'decMessageVar'].forEach(function (name) {
      var scope = name.slice(3, -3).toLowerCase();
      L[name] = function (k, v, o) {
        var opts = Object.assign({}, typeof o === 'object' && o !== null ? o : {}, { outscope: scope });
        return touched(call('incvar', [k, -(v === undefined ? 1 : v), opts]));
      };
    });
    Object.defineProperty(L, 'variables', {
      enumerable: true,
      get: function () { if (varsCache === null) varsCache = call('variables', []); return varsCache; },
    });
    __UNIMPLEMENTED_FUNCTIONS__.forEach(function (name) { L[name] = unimplemented(name); });
    __UNIMPLEMENTED_OBJECTS__.forEach(function (name) {
      Object.defineProperty(L, name, {
        enumerable: true,
        get: function () { throw new Error('ST-Prompt-Template 的 ' + name + ' 在新酒馆里未实现'); },
      });
    });
    Object.keys(env || {}).forEach(function (k) { L[k] = env[k]; });
    rootLocals = L;
    delete globalThis.__init;
  };

  globalThis.__done = 0;
  var render = function (src) {
    // 同一沙箱会连续渲染多段：每段的变量工作副本不同，缓存与递归层数都要归零
    varsCache = null;
    depth = 0;
    globalThis.__done = 0;
    globalThis.__out = undefined;
    try {
      var fn = (0, eval)(src);
      fn(Object.create(rootLocals), escapeFn).then(
        function (v) { globalThis.__out = typeof v === 'string' ? v : String(v); globalThis.__done = 1; },
        function (e) { globalThis.__out = describe(e); globalThis.__done = 2; }
      );
    } catch (e) {
      globalThis.__out = describe(e);
      globalThis.__done = 2;
    }
  };

  // 模板改不掉驱动函数（同一次组装的后续段还要用它）
  Object.defineProperty(globalThis, '__render', { value: render, writable: false, configurable: false });

  function describe(e) {
    if (e && typeof e === 'object') {
      var line = e.__ejsLine ? '（第 ' + e.__ejsLine + ' 行）' : '';
      return (e.name ? e.name + ': ' : '') + (e.message || String(e)) + line;
    }
    return String(e);
  }
})();
`
  .replace('__MAX_DEPTH__', String(MAX_TEMPLATE_DEPTH))
  .replace('__UNIMPLEMENTED_FUNCTIONS__', JSON.stringify(UNIMPLEMENTED_FUNCTIONS))
  .replace('__UNIMPLEMENTED_OBJECTS__', JSON.stringify(UNIMPLEMENTED_OBJECTS));
