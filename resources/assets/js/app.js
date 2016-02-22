'use strict';

var React = require('react');
var ReactDOM = require('react-dom');
var Components = require('./components');

import Transport from './transport';
import { App } from './components';

var transport = new Transport('http://' + document.domain + ':' + location.port);
transport.on("connect", function() {
  transport.login("bobby" + Math.round(Math.random() * 10000));
});
transport.connect();

var rushPhase = false;

var winSound = new Audio("/static/snd/win.mp3");
var roundStartSound = new Audio("/static/snd/round_start.mp3");
var drawStartSound = new Audio("/static/snd/draw_start.mp3");
var correctGuessSound = new Audio("/static/snd/correct_guess.mp3");
var rushPhaseSound = new Audio("/static/snd/rush_phase.mp3");
var tickingSound = new Audio("/static/snd/ticking.mp3");

tickingSound.addEventListener('timeupdate', function () {
  if (rushPhase && this.currentTime > this.duration - 0.5) {
    this.currentTime = 0;
    this.play();
  }
}, false);

transport.on('error', function (e) {
  alert(e);
});

transport.on('alert', function (e) {
  console.error(e.message);
});

transport.on('welcome', function (data) {;
  transport.joinRoom('default');
});

transport.on('state', function (data) {
  rushPhase = false;
  tickingSound.pause();
  tickingSound.currentTime = 0;

  var state = data.state;
  switch (state) {
    case 'wait':
      break;
    case 'draw':
      drawStartSound.play();
      break;
    case 'guess':
      roundStartSound.play();
      break;
    case 'score':
      winSound.play();
      break;
  }
});

transport.on('state_update', function (data) {
  if (!rushPhase && data.rush_phase) {
    rushPhase = true;
    rushPhaseSound.play();
    tickingSound.play();
  }
});

transport.on('guess_correct', function (data) {
  correctGuessSound.play();
});

ReactDOM.render(
  <App transport={transport}/>,
  document.getElementById('container')
);