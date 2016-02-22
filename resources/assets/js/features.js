'use strict';

export function isCanvasSupported() {
  var elem = document.createElement('canvas');
  return !!(elem.getContext && elem.getContext('2d'));
}

export function isAudioSupported() {
  var a = document.createElement('audio');
  return !!(a.canPlayType && a.canPlayType('audio/mpeg;').replace(/no/, ''));
}

export function isWebSocketSupported() {
  return 'WebSocket' in window;
}

export function isDataViewSupported() {
  return 'DataView' in window;
}