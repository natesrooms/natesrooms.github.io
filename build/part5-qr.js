/* =====================================================================
   Minimal QR code generator (byte mode, error-correction level L,
   version 4 = 33x33 modules, up to 78 bytes, mask 0). Enough for the
   phone-remote pairing link; no third-party service sees the link.
   Algorithm follows the QR spec (ISO/IEC 18004) as laid out in
   Project Nayuki's reference implementation.
   ===================================================================== */
var MiniQR = (function () {
  'use strict';
  var SIZE = 33, DATA_CW = 80, EC_CW = 20;

  function gfMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }
  function rsDivisor(degree) {
    var result = [];
    for (var i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    var root = 1;
    for (i = 0; i < degree; i++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return result;
  }
  function rsRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ result.shift();
      result.push(0);
      divisor.forEach(function (coef, i) { result[i] ^= gfMul(coef, factor); });
    });
    return result;
  }

  function encode(text) {
    var bytes = Array.from(new TextEncoder().encode(text));
    if (bytes.length > 78) throw new Error('QR text too long');
    // bit stream: mode 0100, 8-bit count, data, terminator, pad
    var bits = [];
    function put(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    put(4, 4); put(bytes.length, 8);
    bytes.forEach(function (b) { put(b, 8); });
    var cap = DATA_CW * 8;
    put(0, Math.min(4, cap - bits.length));
    while (bits.length % 8) bits.push(0);
    for (var pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) put(pad, 8);
    var data = [];
    for (var i = 0; i < bits.length; i += 8) {
      var v = 0;
      for (var k = 0; k < 8; k++) v = (v << 1) | bits[i + k];
      data.push(v);
    }
    var all = data.concat(rsRemainder(data, rsDivisor(EC_CW)));

    var mod = [], fn = [];
    for (var y = 0; y < SIZE; y++) { mod.push(new Array(SIZE).fill(false)); fn.push(new Array(SIZE).fill(false)); }
    function setF(x, y, dark) { mod[y][x] = dark; fn[y][x] = true; }
    // timing patterns
    for (i = 0; i < SIZE; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
    // finder patterns (with separators)
    [[3, 3], [SIZE - 4, 3], [3, SIZE - 4]].forEach(function (c) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var d = Math.max(Math.abs(dx), Math.abs(dy)), xx = c[0] + dx, yy = c[1] + dy;
        if (xx >= 0 && xx < SIZE && yy >= 0 && yy < SIZE) setF(xx, yy, d !== 2 && d !== 4);
      }
    });
    // alignment pattern (version 4: centre 26,26)
    for (var ay = -2; ay <= 2; ay++) for (var ax = -2; ax <= 2; ax++) setF(26 + ax, 26 + ay, Math.max(Math.abs(ax), Math.abs(ay)) !== 1);
    // format information: ECC level L (01), mask 0
    var fdata = (1 << 3) | 0, rem = fdata;
    for (i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var fbits = ((fdata << 10) | rem) ^ 0x5412;
    function fb(n) { return ((fbits >>> n) & 1) !== 0; }
    for (i = 0; i <= 5; i++) setF(8, i, fb(i));
    setF(8, 7, fb(6)); setF(8, 8, fb(7)); setF(7, 8, fb(8));
    for (i = 9; i < 15; i++) setF(14 - i, 8, fb(i));
    for (i = 0; i < 8; i++) setF(SIZE - 1 - i, 8, fb(i));
    for (i = 8; i < 15; i++) setF(8, SIZE - 15 + i, fb(i));
    setF(8, SIZE - 8, true); // dark module
    // data, zig-zag from the bottom-right, skipping the timing column
    var bi = 0, total = all.length * 8;
    for (var right = SIZE - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < SIZE; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j, upward = ((right + 1) & 2) === 0;
          var yy2 = upward ? SIZE - 1 - vert : vert;
          if (!fn[yy2][x] && bi < total) {
            mod[yy2][x] = ((all[bi >>> 3] >>> (7 - (bi & 7))) & 1) !== 0;
            bi++;
          }
        }
      }
    }
    // mask 0: invert where (x + y) is even
    for (y = 0; y < SIZE; y++) for (x = 0; x < SIZE; x++) if (!fn[y][x] && (x + y) % 2 === 0) mod[y][x] = !mod[y][x];
    return mod;
  }

  function toCanvas(text, px) {
    var m = encode(text), q = 4, n = SIZE + q * 2, scale = Math.max(2, Math.floor((px || 264) / n));
    var c = document.createElement('canvas');
    c.width = c.height = n * scale;
    var g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#000';
    for (var y = 0; y < SIZE; y++) for (var x = 0; x < SIZE; x++) if (m[y][x]) g.fillRect((x + q) * scale, (y + q) * scale, scale, scale);
    return c;
  }
  return { encode: encode, toCanvas: toCanvas };
})();
