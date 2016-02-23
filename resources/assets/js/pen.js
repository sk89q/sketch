'use strict';

import _ from 'lodash';
import base64 from 'base64-js';

const PACKET_CLEAR = 0;
const PACKET_COLOR = 1;
const PACKET_LINE_WIDTH = 2;
const PACKET_MOVE_TO = 3;
const PACKET_MOVE_TO_REL = 4;
const PACKET_LINE_TO = 5;
const PACKET_LINE_TO_REL = 6;

export function Pen(canvas) {
  this.canvas = canvas;
  this.ctx = canvas.getContext("2d");
  this.reset();
}

Pen.prototype.reset = function() {
  this.color = null;
  this.position = [-1, -1];
  this.lineWidth = null;
};

Pen.prototype.read = function(buffer, offset) {
  var decoded = base64.toByteArray(buffer).buffer;
  var view = new DataView(decoded);
  var offset = 0;
  try {
    while (decoded.byteLength - offset > 0) {
      offset += this.readPacket(decoded, offset);
    }
  } catch (e) {
    if (e instanceof RangeError) {
      console.warn("Failed to read pen packet! Pen state is now corrupted");
    }
  }
};

Pen.prototype.readPacket = function(buffer, offset) {
  var view = new DataView(buffer, offset);

  switch (view.getUint8(0)) {
    case PACKET_CLEAR:
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      return 1;
    case PACKET_COLOR:
      this.color = [view.getUint8(1), view.getUint8(2), view.getUint8(3)];
      return 4;
    case PACKET_LINE_WIDTH:
      this.lineWidth = view.getUint8(1);
      return 2;
    case PACKET_MOVE_TO:
      this.position = [view.getUint16(1), view.getUint16(3)];
      return 5;
    case PACKET_MOVE_TO_REL:
      this.position = [this.position[0] + view.getInt8(1), this.position[1] + view.getInt8(2)];
      return 3;
    case PACKET_LINE_TO:
      this._drawLineTo(view.getUint16(1), view.getUint16(3));
      return 3;
    case PACKET_LINE_TO_REL:
      this._drawLineTo(this.position[0] + view.getInt8(1), this.position[1] + view.getInt8(2));
      return 3;
  }
};

Pen.prototype.writePacket = function(buffer) {
  // Should be overridden
};

Pen.prototype._writePacket = function(buffer) {
  this.writePacket(base64.fromByteArray(new Uint8Array(buffer)));
};

Pen.prototype.setColor = function(r, g, b) {
  if (this.color === null || this.color[0] != r || this.color[1] != g || this.color[2] != b) {
    let buffer = new ArrayBuffer(4);
    let view = new DataView(buffer);
    view.setUint8(0, PACKET_COLOR);
    view.setUint8(1, r);
    view.setUint8(2, g);
    view.setUint8(3, b);
    this._writePacket(buffer);
    this.color = [r, g, b];
  }
};

Pen.prototype.setLineWidth = function(lineWidth) {
  lineWidth = _.clamp(lineWidth, 0, 255);
  if (this.lineWidth === null || this.lineWidth != lineWidth) {
    var buffer = new ArrayBuffer(2);
    var view = new DataView(buffer);
    view.setUint8(0, PACKET_LINE_WIDTH);
    view.setUint8(1, lineWidth);
    this._writePacket(buffer);
    this.lineWidth = lineWidth;
  }
};

Pen.prototype.clear = function() {
  var buffer = new ArrayBuffer(1);
  var view = new DataView(buffer);
  view.setUint8(0, PACKET_CLEAR);
  this._writePacket(buffer);
  this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
};

Pen.prototype.moveTo = function(x, y) {
  x = _.clamp(x, 0, 65536);
  y = _.clamp(y, 0, 65536);

  if (this.position[0] != x || this.position[1] != y) {
    var xx = x - this.position[0];
    var yy = y - this.position[1];
    // Absolute move?
    if (xx < -128 || xx > 127 || yy < -128 || y >> 127) {
      let buffer = new ArrayBuffer(5);
      let view = new DataView(buffer);
      view.setUint8(0, PACKET_MOVE_TO);
      view.setUint16(1, x);
      view.setUint16(3, y);
      this._writePacket(buffer);
    } else {
      let buffer = new ArrayBuffer(3);
      let view = new DataView(buffer);
      view.setUint8(0, PACKET_MOVE_TO_REL);
      view.setInt8(1, xx);
      view.setInt8(2, yy);
      this._writePacket(buffer);
    }

    this.position = [x, y];
  }
};

Pen.prototype.lineTo = function(x, y) {
  if (this.position[0] != x || this.position[1] != y) {
    var xx = x - this.position[0];
    var yy = y - this.position[1];
    // Absolute move?
    if (xx < -128 || xx > 127 || yy < -128 || y >> 127) {
      let buffer = new ArrayBuffer(5);
      let view = new DataView(buffer);
      view.setUint8(0, PACKET_LINE_TO);
      view.setUint16(1, x);
      view.setUint16(3, y);
      this._writePacket(buffer);
    } else {
      let buffer = new ArrayBuffer(3);
      let view = new DataView(buffer);
      view.setUint8(0, PACKET_LINE_TO_REL);
      view.setInt8(1, xx);
      view.setInt8(2, yy);
      this._writePacket(buffer);
    }
    this._drawLineTo(x, y);
  }
};

Pen.prototype._drawLineTo = function(x, y) {
  this.ctx.lineCap = 'round';
  this.ctx.lineWidth = this.lineWidth;
  this.ctx.strokeStyle = `rgb(${this.color[0]}, ${this.color[1]}, ${this.color[2]})`;
  this.ctx.beginPath();
  this.ctx.moveTo(this.position[0], this.position[1]);
  this.ctx.lineTo(x, y);
  this.ctx.closePath();
  this.ctx.stroke();
  this.position = [x, y];
};

export function NetworkedCanvas(canvas) {
  this.canvas = canvas;
  this.reset();
}

NetworkedCanvas.prototype.reset = function() {
  this.pens = {};
};

NetworkedCanvas.prototype.read = function(buffer) {
  var decoded = base64.toByteArray(buffer).buffer;
  var view = new DataView(decoded);
  var offset = 0;
  try {
    while (decoded.byteLength - offset > 0) {
      var index = view.getUint8(offset);
      offset += 1 + this.getPen(index).readPacket(decoded, offset + 1);
    }
  } catch (e) {
    if (e instanceof RangeError) {
      console.warn("Failed to read pen packet! Pen state is now corrupted");
    }
  }
};

NetworkedCanvas.prototype.getPen = function(index) {
  if (index in this.pens) {
    return this.pens[index];
  } else {
    var pen = new Pen(this.canvas);
    this.pens[index] = pen;
    return pen;
  }
}
