// Client-side port of the enumerator algorithm.
// Note: heavy runs can freeze the UI. Consider adding Web Worker if needed.

(() => {
  // Utilities
  function nowSec() { return performance.now() / 1000; }
  function isFiniteNumber(x){ return typeof x === 'number' && isFinite(x); }
  function key_repr(x){ // similar to Python repr for float
    if (!isFiniteNumber(x)) return 'nan';
    // 17 digits precision to preserve IEEE-754 double
    return Number(x).toPrecision(17);
  }

  // Safe pow: mimic Python version in behavior (restrict negative base to integer exponents)
  function safePow(a, b) {
    try {
      if (!isFiniteNumber(a) || !isFiniteNumber(b)) return NaN;
      if (a < 0) {
        const br = Math.round(b);
        if (Math.abs(b - br) > 1e-9) return NaN;
        const v = Math.pow(a, br);
        if (!isFiniteNumber(v) || Math.abs(v) > 1e300) return NaN;
        return v;
      } else {
        const v = Math.pow(a, b);
        if (!isFiniteNumber(v) || Math.abs(v) > 1e300) return NaN;
        return v;
      }
    } catch (e) { return NaN; }
  }

  function safeEvalFunc(f, x){
    try {
      const v = f(x);
      if (typeof v === 'object' && v !== null) return NaN;
      if (!isFiniteNumber(v)) return NaN;
      return v;
    } catch (e) { return NaN; }
  }
  function safeEvalBin(op, a, b){
    try {
      const v = op(a,b);
      if (!isFiniteNumber(v)) return NaN;
      return v;
    } catch(e){ return NaN; }
  }

  // simple binary heap (max-heap by comparator)
  class BinaryHeap {
    constructor(cmp) { this.cmp = cmp; this.data = []; }
    size(){ return this.data.length; }
    peek(){ return this.data[0]; }
    push(item){
      this.data.push(item);
      this._siftUp(this.data.length - 1);
    }
    pop(){
      if (this.data.length === 0) return undefined;
      const top = this.data[0];
      const last = this.data.pop();
      if (this.data.length) {
        this.data[0] = last;
        this._siftDown(0);
      }
      return top;
    }
    replace(item){
      const top = this.data[0];
      this.data[0] = item;
      this._siftDown(0);
      return top;
    }
    _siftUp(i){
      const a = this.data;
      while (i > 0) {
        const p = Math.floor((i-1)/2);
        if (this.cmp(a[i], a[p]) > 0) { // child > parent -> swap (max-heap)
          [a[i], a[p]] = [a[p], a[i]];
          i = p;
        } else break;
      }
    }
    _siftDown(i){
      const a = this.data;
      const n = a.length;
      while (true) {
        let l = 2*i + 1, r = 2*i + 2, largest = i;
        if (l < n && this.cmp(a[l], a[largest]) > 0) largest = l;
        if (r < n && this.cmp(a[r], a[largest]) > 0) largest = r;
        if (largest !== i) {
          [a[i], a[largest]] = [a[largest], a[i]];
          i = largest;
        } else break;
      }
    }
  }

  // is_direct_application similar to Python version
  function is_direct_application(expr, funcName){
    if (!expr) return false;
    let s = expr.trim();
    // strip outer () once
    if (s.startsWith('(') && s.endsWith(')')) {
      const inner = s.slice(1, -1).trim();
      if (inner) s = inner;
    }
    // strip unary - (one level)
    if (s.startsWith('-(') && s.endsWith(')')) {
      const inner = s.slice(2, -1).trim();
      if (inner) s = inner;
    }
    return s.startsWith(funcName + '(') && s.endsWith(')');
  }

  // Main enumerator (recursive). Returns an array of candidates {v, expr}.
  // It also updates bestHeap lazily via considerValue to keep top-K unique values.
  function generateEnumerations(cfg, onProgress) {
    const start = nowSec();
    const N = cfg.N;
    const numbers = Array.from({length: N}, (_,i)=>i+1);
    const constants = cfg.consts || {};
    const unaryFuncs = {};
    if (cfg.use_sin) unaryFuncs['sin'] = Math.sin;
    if (cfg.use_cos) unaryFuncs['cos'] = Math.cos;
    if (cfg.use_tan) unaryFuncs['tan'] = Math.tan;
    if (cfg.use_exp) unaryFuncs['exp'] = Math.exp;
    if (cfg.use_ln) unaryFuncs['ln'] = (x)=> x>0 ? Math.log(x) : NaN;
    if (cfg.use_sqrt) unaryFuncs['sqrt'] = (x)=> x>=0 ? Math.sqrt(x) : NaN;
    if (cfg.use_neg) unaryFuncs['-'] = (x)=> -x;

    const binaryOps = {
      '+': (a,b)=>a+b,
      '-': (a,b)=>a-b,
      '*': (a,b)=>a*b,
      '/': (a,b)=> b===0 ? NaN : a/b,
    };
    if (cfg.use_pow) binaryOps['^'] = safePow;

    const target = cfg.target;
    const keepTop = cfg.keep_top;
    const maxCost = cfg.max_cost;
    const maxSeconds = cfg.max_seconds;
    const epsilon = cfg.epsilon || 1e-12;
    const keepSide = cfg.keep_side || 'both';

    // bestHeap: max-heap by error (we want the worst error on top so we can replace)
    // store items: {err, v, expr}
    const bestHeap = new BinaryHeap((a,b)=> {
      if (a.err < b.err) return -1;
      if (a.err > b.err) return 1;
      return 0;
    });
    const savedValues = new Set();
    let exprCountTotal = 0;
    let stopped = false;

    function timeCheck(){
      if (nowSec() - start > maxSeconds) {
        stopped = true;
        throw new Error('Timeout');
      }
    }

    function considerValue(v, exprBuilder) {
      if (!isFiniteNumber(v)) return;
      if (keepSide === 'greater' && !(v > target + epsilon)) return;
      if (keepSide === 'less' && !(v < target - epsilon)) return;
      exprCountTotal++;
      const err = Math.abs(target - v);
      const k = key_repr(v);
      if (savedValues.has(k)) return;
      if (bestHeap.size() < keepTop) {
        // lazily build expr
        const expr = typeof exprBuilder === 'function' ? exprBuilder() : exprBuilder;
        bestHeap.push({err, v, expr});
        savedValues.add(k);
      } else {
        const worst = bestHeap.peek();
        if (err < worst.err) {
          const expr = typeof exprBuilder === 'function' ? exprBuilder() : exprBuilder;
          const popped = bestHeap.replace({err, v, expr});
          savedValues.delete(key_repr(popped.v));
          savedValues.add(k);
        }
      }
    }

    // memoization: map cost -> array of {v, expr}
    const memo = new Map();

    function enumerateCost(cost) {
      if (stopped) return [];
      if (memo.has(cost)) return memo.get(cost);
      timeCheck();
      const results = [];
      if (cost === 1) {
        for (const n of numbers) {
          timeCheck();
          const v = Number(n);
          const expr = String(n|0);
          considerValue(v, expr);
          results.push({v, expr});
        }
        for (const name of Object.keys(constants)) {
          timeCheck();
          const v = Number(constants[name]);
          const expr = name;
          considerValue(v, expr);
          results.push({v, expr});
        }
        memo.set(cost, results);
        return results;
      }

      // unary from cost-1
      const prev = enumerateCost(cost - 1);
      for (const item of prev) {
        timeCheck();
        if (!isFiniteNumber(item.v)) continue;
        for (const fname of Object.keys(unaryFuncs)) {
          // pruning identical patterns: ln(exp(...)) and exp(ln(...))
          if (fname === 'ln' && is_direct_application(item.expr, 'exp')) continue;
          if (fname === 'exp' && is_direct_application(item.expr, 'ln')) continue;
          const f = unaryFuncs[fname];
          const vv = safeEvalFunc(f, item.v);
          let exprStr;
          if (fname === '-') exprStr = `-(${item.expr})`;
          else exprStr = `${fname}(${item.expr})`;
          considerValue(vv, ()=> exprStr);
          results.push({v: vv, expr: exprStr});
        }
      }

      // binary splits: a_cost + b_cost + 1 == cost
      for (let a_cost = 1; a_cost <= cost - 2; a_cost++) {
        const b_cost = cost - 1 - a_cost;
        const leftArr = enumerateCost(a_cost);
        const rightArr = enumerateCost(b_cost);
        for (const L of leftArr) {
          timeCheck();
          for (const R of rightArr) {
            timeCheck();
            // skip non-finite
            if (!isFiniteNumber(L.v) || !isFiniteNumber(R.v)) continue;

            for (const opname of Object.keys(binaryOps)) {
              const op = binaryOps[opname];
              // identity elimination (using epsilon)
              if (opname === '+' && Math.abs(R.v) <= epsilon) continue;
              if (opname === '-' && Math.abs(R.v) <= epsilon) continue;
              if (opname === '*' && Math.abs(R.v - 1.0) <= epsilon) continue;
              if (opname === '/' && Math.abs(R.v - 1.0) <= epsilon) continue;

              const isCommutative = (opname === '+' || opname === '*');
              // canonicalization for commutative: only generate when (L.v, L.expr) <= (R.v, R.expr)
              let doFirst = true;
              if (isCommutative) {
                if ((L.v > R.v) || (L.v === R.v && L.expr > R.expr)) doFirst = false;
              }

              if (doFirst) {
                const v1 = safeEvalBin(op, L.v, R.v);
                const expr1 = `(${L.expr} ${opname} ${R.expr})`;
                considerValue(v1, ()=> expr1);
                results.push({v: v1, expr: expr1});
              }
              if (!isCommutative) {
                const v2 = safeEvalBin(op, R.v, L.v);
                const expr2 = `(${R.expr} ${opname} ${L.expr})`;
                considerValue(v2, ()=> expr2);
                results.push({v: v2, expr: expr2});
              }
            }
          }
        }
      }

      memo.set(cost, results);
      return results;
    }

    // run levels
    try {
      for (let cost = 1; cost <= maxCost; cost++) {
        timeCheck();
        enumerateCost(cost);
        if (onProgress && (cost % 1 === 0)) {
          onProgress({level: cost, elapsed: nowSec() - start, count: exprCountTotal});
        }
      }
    } catch (e) {
      if (e.message !== 'Timeout') {
        console.error('enumeration error', e);
      }
    }

    // return sorted results ascending by error
    const arr = bestHeap.data.slice().sort((a,b)=> a.err - b.err).map(item=> ({v:item.v, expr:item.expr, err:item.err}));
    return {results: arr, stats: {expr_count_total: exprCountTotal, max_level: Math.min(maxCost, memo.size)}};
  }

  // UI wiring
  const $ = (id) => document.getElementById(id);
  const logEl = $('log');
  const resultsBody = document.querySelector('#results-table tbody');
  const statusEl = $('status');
  let running = false;
  let abortFlag = {abort:false};

  function appendLog(s){
    logEl.textContent += s + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }

  function readConfig(){
    let consts = {};
    try {
      consts = JSON.parse($('cfg-consts').value || '{}');
    } catch (e) {
      alert('constants must be valid JSON');
      throw e;
    }
    return {
      N: parseInt($('cfg-n').value,10)||0,
      target: Number($('cfg-target').value)||0,
      consts,
      use_sin: $('use-sin').checked,
      use_cos: $('use-cos').checked,
      use_tan: $('use-tan').checked,
      use_exp: $('use-exp').checked,
      use_ln: $('use-ln').checked,
      use_sqrt: $('use-sqrt').checked,
      use_neg: $('use-neg').checked,
      use_pow: $('use-pow').checked,
      keep_side: $('cfg-keep-side').value,
      max_cost: parseInt($('cfg-max-cost').value,10)||7,
      keep_top: parseInt($('cfg-keep-top').value,10)||10,
      max_seconds: Number($('cfg-max-seconds').value)||10,
      epsilon: 1e-12,
    };
  }

  $('run-btn').addEventListener('click', ()=>{
    if (running) return;
    running = true;
    abortFlag.abort = false;
    $('stop-btn').disabled = false;
    $('run-btn').disabled = true;
    statusEl.textContent = 'running';
    logEl.textContent = '';
    resultsBody.innerHTML = '';
    const cfg = readConfig();
    appendLog(`Starting enumeration: numbers 1..${cfg.N}  target=${cfg.target}`);
    appendLog(`max_cost=${cfg.max_cost}  max_seconds=${cfg.max_seconds}  keep_top=${cfg.keep_top}  keep_side=${cfg.keep_side}`);
    setTimeout(()=> {
      try {
        const res = generateEnumerations(cfg, (p)=>{
          statusEl.textContent = `running (level ${p.level}, elapsed ${p.elapsed.toFixed(2)}s, exprs ${p.count})`;
        });
        appendLog(`Total expressions considered: ${res.stats.expr_count_total}`);
        appendLog(`Max level reached: ${res.stats.max_level}`);
        if (!res.results.length) {
          appendLog('No candidates found. Try increasing max_seconds or max_cost.');
        } else {
          appendLog(`Found ${res.results.length} candidates (top ${cfg.keep_top})`);
          // populate table
          res.results.forEach((it, idx)=>{
            const tr = document.createElement('tr');
            const tdIdx = document.createElement('td'); tdIdx.textContent = String(idx+1);
            const tdErr = document.createElement('td'); tdErr.textContent = it.err.toPrecision(12);
            const tdVal = document.createElement('td'); tdVal.textContent = it.v;
            const tdExpr = document.createElement('td'); tdExpr.textContent = it.expr;
            tr.appendChild(tdIdx); tr.appendChild(tdErr); tr.appendChild(tdVal); tr.appendChild(tdExpr);
            resultsBody.appendChild(tr);
          });
        }
      } catch (e) {
        appendLog('Error: ' + e.message);
      } finally {
        running = false;
        $('stop-btn').disabled = true;
        $('run-btn').disabled = false;
        statusEl.textContent = 'idle';
      }
    }, 50);
  });

  $('stop-btn').addEventListener('click', ()=>{
    // currently enumeration uses synchronous loops; we just set the abort flag and UI toggles.
    // In this simple version we cannot safely interrupt JS synchronous loops; use short max_seconds instead.
    appendLog('Stop requested — in this client-side version the stop may not immediately interrupt a heavy synchronous run.');
    $('stop-btn').disabled = true;
  });

})();
