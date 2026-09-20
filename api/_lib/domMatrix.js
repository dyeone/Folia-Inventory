// Minimal 2D DOMMatrix for Node.
//
// pdf.js's Node build wants `DOMMatrix` at module load (a top-level
// `new DOMMatrix()`), and takes it from `@napi-rs/canvas` when that package
// is installed. In the Vercel function bundle it isn't (it's a transitive
// dev-time package, and a native binary we don't want to ship), so the
// import threw "DOMMatrix is not defined" and the invoice upload failed in
// production while working locally. We only extract TEXT — no rendering —
// so a plain 2D affine matrix with the few operations pdf.js calls
// (multiply / preMultiply / translate / scale / invert / transformPoint)
// is enough. Installed only when the global is missing.

class DOMMatrixPolyfill {
  constructor(init) {
    this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
    if (init == null) return;
    if (typeof init === 'string') {
      const m = init.match(/matrix\(([^)]*)\)/);
      if (m) init = m[1].split(',').map(Number);
      else return;
    }
    if (Array.isArray(init) || ArrayBuffer.isView(init)) {
      if (init.length === 6) {
        [this.a, this.b, this.c, this.d, this.e, this.f] = init;
      } else if (init.length === 16) {
        this.a = init[0]; this.b = init[1]; this.c = init[4]; this.d = init[5]; this.e = init[12]; this.f = init[13];
      }
      return;
    }
    if (typeof init === 'object') {
      this.a = init.a ?? init.m11 ?? 1; this.b = init.b ?? init.m12 ?? 0;
      this.c = init.c ?? init.m21 ?? 0; this.d = init.d ?? init.m22 ?? 1;
      this.e = init.e ?? init.m41 ?? 0; this.f = init.f ?? init.m42 ?? 0;
    }
  }

  static fromMatrix(other) { return new DOMMatrixPolyfill(other); }
  static fromFloat32Array(arr) { return new DOMMatrixPolyfill(Array.from(arr)); }
  static fromFloat64Array(arr) { return new DOMMatrixPolyfill(Array.from(arr)); }

  // 4×4 aliases (2D subset) — some callers read m11..m42.
  get m11() { return this.a; } set m11(v) { this.a = v; }
  get m12() { return this.b; } set m12(v) { this.b = v; }
  get m21() { return this.c; } set m21(v) { this.c = v; }
  get m22() { return this.d; } set m22(v) { this.d = v; }
  get m41() { return this.e; } set m41(v) { this.e = v; }
  get m42() { return this.f; } set m42(v) { this.f = v; }
  get m13() { return 0; } get m14() { return 0; } get m23() { return 0; } get m24() { return 0; }
  get m31() { return 0; } get m32() { return 0; } get m33() { return 1; } get m34() { return 0; }
  get m43() { return 0; } get m44() { return 1; }
  get is2D() { return true; }
  get isIdentity() {
    return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
  }

  // this × other (apply `other` first, then this) — DOM semantics.
  multiply(other) { return new DOMMatrixPolyfill(this).multiplySelf(other); }
  multiplySelf(other) {
    const o = other instanceof DOMMatrixPolyfill ? other : new DOMMatrixPolyfill(other);
    const { a, b, c, d, e, f } = this;
    this.a = a * o.a + c * o.b;
    this.b = b * o.a + d * o.b;
    this.c = a * o.c + c * o.d;
    this.d = b * o.c + d * o.d;
    this.e = a * o.e + c * o.f + e;
    this.f = b * o.e + d * o.f + f;
    return this;
  }
  preMultiplySelf(other) {
    const o = other instanceof DOMMatrixPolyfill ? other : new DOMMatrixPolyfill(other);
    const { a, b, c, d, e, f } = this;
    this.a = o.a * a + o.c * b;
    this.b = o.b * a + o.d * b;
    this.c = o.a * c + o.c * d;
    this.d = o.b * c + o.d * d;
    this.e = o.a * e + o.c * f + o.e;
    this.f = o.b * e + o.d * f + o.f;
    return this;
  }
  translate(tx = 0, ty = 0) { return new DOMMatrixPolyfill(this).translateSelf(tx, ty); }
  translateSelf(tx = 0, ty = 0) { return this.multiplySelf({ a: 1, b: 0, c: 0, d: 1, e: tx, f: ty }); }
  scale(sx = 1, sy = sx, _sz = 1, ox = 0, oy = 0) { return new DOMMatrixPolyfill(this).scaleSelf(sx, sy, _sz, ox, oy); }
  scaleSelf(sx = 1, sy = sx, _sz = 1, ox = 0, oy = 0) {
    this.translateSelf(ox, oy);
    this.multiplySelf({ a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 });
    return this.translateSelf(-ox, -oy);
  }
  inverse() { return new DOMMatrixPolyfill(this).invertSelf(); }
  invertSelf() {
    const { a, b, c, d, e, f } = this;
    const det = a * d - b * c;
    if (!det) { this.a = this.b = this.c = this.d = this.e = this.f = NaN; return this; }
    this.a = d / det; this.b = -b / det;
    this.c = -c / det; this.d = a / det;
    this.e = (c * f - d * e) / det;
    this.f = (b * e - a * f) / det;
    return this;
  }
  transformPoint(p = {}) {
    const x = p.x ?? 0, y = p.y ?? 0;
    return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f, z: p.z ?? 0, w: p.w ?? 1 };
  }
  toFloat32Array() { return new Float32Array([this.a, this.b, 0, 0, this.c, this.d, 0, 0, 0, 0, 1, 0, this.e, this.f, 0, 1]); }
  toFloat64Array() { return new Float64Array([this.a, this.b, 0, 0, this.c, this.d, 0, 0, 0, 0, 1, 0, this.e, this.f, 0, 1]); }
  toString() { return `matrix(${[this.a, this.b, this.c, this.d, this.e, this.f].join(', ')})`; }
}

export function installDomMatrixPolyfill() {
  if (typeof globalThis.DOMMatrix === 'undefined') globalThis.DOMMatrix = DOMMatrixPolyfill;
  return globalThis.DOMMatrix;
}
