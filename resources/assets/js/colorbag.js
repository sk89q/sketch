import _ from 'lodash';

var COLORS = [
  '#1DBF9F',
  '#2BCB6E',
  '#379ADB',
  '#9B57B5',
  '#E91C60',
  '#EDC111',
  '#E77F23',
  '#E94C3B',
  '#98A8A9',
  '#617C89'
];

export default function ColorBag() {
  this.history = {};
}

ColorBag.prototype.getColor = function(s) {
  if (s in this.history) {
    return this.history[s];
  } else {
    var color = COLORS[_.random(0, COLORS.length - 1)];
    this.history[s] = color;
    return color;
  }
};