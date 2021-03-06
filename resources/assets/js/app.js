'use strict';

import React from 'react';
import ReactDOM from 'react-dom';
import * as Features from './features';
import Transport from './transport';
import { App } from './components';

function setup() {
  var appVersion = document.body.getAttribute("data-version");
  var transport = new Transport('http://' + document.domain + ':' + location.port, appVersion);
  var rushPhase = false;

  var winSound = soundManager.createSound({url: "/static/snd/win.mp3"});
  var roundStartSound = soundManager.createSound({url: "/static/snd/round_start.mp3"});
  var drawStartSound = soundManager.createSound({url: "/static/snd/draw_start.mp3"});
  var correctGuessSound = soundManager.createSound({url: "/static/snd/correct_guess.mp3"});
  var rushPhaseSound = soundManager.createSound({url: "/static/snd/rush_phase.mp3"});
  var tickingSound = soundManager.createSound({url: "/static/snd/ticking.mp3"});
  var joinSound = soundManager.createSound({url: "/static/snd/join.mp3"});
  var partSound = soundManager.createSound({url: "/static/snd/part.mp3"});

  transport.on('welcome', function (data) {;
    transport.joinRoom('default');
  });

  transport.on('state', function (data) {
    rushPhase = false;
    tickingSound.stop();

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
      tickingSound.play({loops: 9999});
    }
  });

  transport.on('user_join', function (data) {;
    joinSound.play();
  });

  transport.on('user_part', function (data) {;
    partSound.play();
  });

  transport.on('guess_correct', function (data) {
    correctGuessSound.play();
  });

  //transport.connect();

  ReactDOM.render(
    <App transport={transport}/>,
    document.getElementById('container')
  );
}

if (Features.isCanvasSupported() &&
    Features.isAudioSupported() &&
    Features.isWebSocketSupported() &&
    Features.isDataViewSupported) {
  soundManager.setup({
    preferFlash: false,
    onready: function() {
      setup();
    }
  });
} else {
  document.getElementById('missing-features').style.display = 'block';
}
