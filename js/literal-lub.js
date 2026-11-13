// Read literal Lua 5.1 table initializers. This is a bounded data decoder, not a Lua runtime.
// Functions, calls, branches, arithmetic and host access are never executed.
export function readLiteralLub(bytes, { globals = new Map(), target, missingKeys = false, maximum = 64 * 1024 * 1024 } = {}) {
  if (bytes.byteLength > maximum) throw new Error('Lua table exceeds the import limit.');
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let p = 0;
  const need = n => { if (!Number.isSafeInteger(n) || n < 0 || p + n > bytes.length) throw new Error('Truncated Lua table.'); };
  const u8 = () => { need(1); return data.getUint8(p++); };
  const u32 = () => { need(4); const n = data.getUint32(p, true); p += 4; return n; };
  const count = max => { const n = u32(); if (n > max) throw new Error('Lua table exceeds import limits.'); return n; };
  const string = () => { const n = count(maximum); if (!n) return ''; need(n); if (bytes[p+n-1] !== 0) throw new Error('Invalid Lua string.'); const s = new TextDecoder('windows-1252').decode(bytes.subarray(p,p+n-1)); p += n; return s; };
  for (const value of [27,76,117,97,81,0,1,4,4,4,8,0]) if (u8() !== value) throw new Error('Expected a Lua 5.1 table (32-bit little-endian).');
  string(); need(8); p += 8;
  if (u8() || u8()) throw new Error('Lua table initializer cannot have parameters or upvalues.');
  u8(); const registers = new Array(u8());
  const code = Array.from({length: count(2000000)}, u32);
  const constants = Array.from({length: count(1000000)}, () => {
    const type = u8();
    if (type === 0) return null;
    if (type === 1) return !!u8();
    if (type === 4) return string();
    if (type === 3) { need(8); const n = data.getFloat64(p,true); p += 8; if (!Number.isFinite(n)) throw new Error('Invalid Lua number.'); return n; }
    throw new Error('Unsupported Lua constant.');
  });
  const constant = n => { if (n >= constants.length) throw new Error('Invalid Lua constant.'); return constants[n]; };
  const register = n => { if (n >= registers.length) throw new Error('Invalid Lua register.'); return registers[n]; };
  const operand = n => n & 256 ? constant(n & 255) : register(n);
  let writes = 0;
  function set(table,key,value) { if (!(table instanceof Map) || !['string','number'].includes(typeof key) || ++writes > 3000000) throw new Error('Invalid Lua table entry.'); table.set(key,value); }
  for (let pc = 0; pc < code.length; pc++) {
    const instruction = code[pc], op = instruction & 63, a = (instruction >>> 6) & 255, b = instruction >>> 23, c = (instruction >>> 14) & 511, bx = instruction >>> 14;
    if (a >= registers.length) throw new Error('Invalid Lua destination.');
    if (op === 0) registers[a] = register(b);
    else if (op === 1) registers[a] = constant(bx);
    else if (op === 2 && c === 0) registers[a] = !!b;
    else if (op === 3) { for(let n=a;n<=b;n++) { register(n); registers[n]=null; } }
    else if (op === 5) { const name=constant(bx); if(!globals.has(name)) throw new Error(`Missing Lua table ${name}.`); registers[a]=globals.get(name); }
    else if (op === 6) { const table=register(b),key=operand(c); if(!(table instanceof Map)||(!table.has(key) && !missingKeys)) throw new Error(`Missing Lua key ${key}.`); registers[a]=table.has(key)?table.get(key):'unmapped:'+key; }
    else if (op === 7) { const name=constant(bx),value=register(a); if(typeof name!=='string'||!(value instanceof Map)) throw new Error('Expected literal Lua table assignment.'); globals.set(name,value); if(target===name) return value; }
    else if (op === 9) set(register(a),operand(b),operand(c));
    else if (op === 10) registers[a] = new Map();
    else if (op === 21) { let value=''; for(let n=b;n<=c;n++) { const v=register(n); if(!['string','number'].includes(typeof v)) throw new Error('Invalid Lua text.'); value+=v; } registers[a]=value; }
    else if (op === 34 && b > 0) { const block=c || code[++pc]; if(!block) throw new Error('Invalid Lua list block.'); for(let n=1;n<=b;n++) set(register(a),(block-1)*50+n,register(a+n)); }
    else if (op === 30) { if(b===2 && register(a) instanceof Map) return register(a); break; }
    else throw new Error(`Unsupported Lua initializer instruction ${op}. Only literal tables can be imported.`);
  }
  if(target) { if(globals.has(target)) return globals.get(target); throw new Error(`Missing Lua table ${target}.`); }
  return globals;
}

