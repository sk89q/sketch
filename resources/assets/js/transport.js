'use strict';

import _ from 'lodash';

export default function Transport(url) {
  this.url = url;
  this.eventHandlers = {};
  this.socket = null;
};

Transport.prototype.connect = function() {
  this.socket = io.connect(this.url, {
    tryTransportsOnConnectTimeout: true,
    rememberTransport: false,
    reconnection: true
  });

  this.socket.on('connect', () => {
    console.info("Connection established");
    this.fire('connect');
  });
  this.socket.on('disconnect', () => {
    console.warn("Disconnected");
    this.fire('disconnect');
  });
  this.socket.on('error', e => {
    console.error("Error", e);
    this.fire('error', e);
  });
  this.socket.on('alert', data => {
    console.error("Error", e);
    this.fire('alert', data);
  });

  this.socket.on('welcome', data => {
    console.info(`Logged in as ${data.username}`);
    this.fire('welcome', data);
  });
  this.socket.on('me', data => {
    console.info(`I am currently ${data.away ? 'away' : 'not away'}`);
    this.fire('me', data);
  });
  this.socket.on('room', data => {
    console.info(`Joined room '${data.name}'`, data);
    this.fire('room', data);
  });
  this.socket.on('user_join', data => {
    console.info(`User ${data.name} joined room`);
    this.fire('user_join', data);
  });
  this.socket.on('user_part', data => {
    console.info(`User ${data.name} parted room`);
    this.fire('user_part', data);
  });
  this.socket.on('user_status', data => {
    console.info(`Received user status for ${data.name}`, data);
    this.fire('user_status', data);
  });
  this.socket.on('chat', data => this.fire('chat', data));

  this.socket.on('state', data => {
    console.debug("<< state", data);
    this.fire('state', data);
  });
  this.socket.on('state_update', data => {
    console.debug("<< state_update", data);
    this.fire('state_update', data);
  });
  this.socket.on('scores', data => {
    console.debug("<< scores", data);
    this.fire('scores', data);
  });
  this.socket.on('scores_reset', data => {
    console.debug("<< scores_reset", data);
    this.fire('scores_reset', data);
  });

  this.socket.on('guess_correct', data => this.fire('guess_correct', data));

  this.socket.on('draw', data => this.fire('draw', data));
};

Transport.prototype.ensureConnected = function() {
};

Transport.prototype.login = function(username) {
  this.ensureConnected();
  console.debug(`Logging in as ${username}...`);
  this.socket.emit('login', {username: username});
};

Transport.prototype.joinRoom = function(name) {
  this.ensureConnected();
  console.debug(`Trying to join room '${name}'...`);
  this.socket.emit('join', {room: name})
};

Transport.prototype.say = function(message) {
  this.ensureConnected();
  this.socket.emit('say', {msg: message})
};

Transport.prototype.draw = function(data) {
  this.ensureConnected();
  this.socket.emit('draw', data)
};

Transport.prototype.setAway = function(away) {
  this.ensureConnected();
  console.debug(`Setting away=${away ? 'true' : 'false'}`);
  this.socket.emit('set_away', {away: away})
};

Transport.prototype.requestHint = function() {
  this.ensureConnected();
  console.debug("Requesting hint...");
  this.socket.emit('request_hint', {})
};

Transport.prototype.requestSkip = function() {
  this.ensureConnected();
  console.debug("Requesting skip...");
  this.socket.emit('request_skip', {})
};

Transport.prototype.on = function(event, callback) {
  if (!(event in this.eventHandlers)) {
    this.eventHandlers[event] = [];
  }
  this.eventHandlers[event].push(callback);
};

Transport.prototype.fire = function(event, args) {
  if (event in this.eventHandlers) {
    _.forEach(this.eventHandlers[event], function (value) {
      value(args);
    });
  }
};