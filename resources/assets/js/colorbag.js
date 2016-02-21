import _ from 'lodash';

var COLORS = [
  '#712121',
  '#236F2A',
  '#236F65',
  '#254E6D',
  '#23266F',
  '#6C6926'
];

export class ColorBag {
  constructor() {
    this.history = {};
  }

  getColor(s) {
    if (s in this.history) {
      return this.history[s];
    } else {
      var color = COLORS[_.random(0, COLORS.length - 1)];
      this.history[s] = color;
      return color;
    }
  }
}