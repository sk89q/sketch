'use strict';

import _ from 'lodash';

export const DISCONNECTED = 'disconnected';
export const CONNECTING = 'connecting';
export const CONNECTED = 'connected';
export const LOGGED_IN = 'logged_in';

function Room(name, users) {
  this.name = name;
  this.users = users;
}

function Transport(url) {
  this.url = url;
  this.loginUsername = "guest";
  this.eventHandlers = {};
  this.socket = null;
  this.status = DISCONNECTED;
  this.username = null;
  this.away = false;
  this.state = {};
  this.room = null;
  this.loginError = null;
}

Transport.prototype.connect = function() {
  this.socket = io.connect(this.url, {
    tryTransportsOnConnectTimeout: true,
    rememberTransport: false,
    reconnection: true,
    forceNew: true
  });

  this.state = CONNECTING;
  this.fire('status', this.status);

  this.socket.on('connect', () => {
    console.info("Connection established");
    this.status = CONNECTED;
    this.room = null;
    this.loginError = null;
    this.fire('connect');
    this.fire('status', this.status);
    this.login(this.loginUsername);
  });

  this.socket.on('disconnect', () => {
    console.warn("Disconnected");
    this.status = DISCONNECTED;
    this.room = null;
    this.fire('disconnect');
    this.fire('status', this.status);
  });

  this.socket.on('login_error', e => {
    console.error("Login error", e);
    this.loginError = e.message;
    this.fire('login_error', e);
    this.socket.disconnect();
  });

  this.socket.on('error', e => {
    console.error("Error", e);
    this.fire('error', e);
  });

  this.socket.on('alert', data => {
    console.error("Alert", data);
    this.fire('alert', data);
  });

  this.socket.on('welcome', data => {
    console.info(`Logged in as ${data.username}`);
    this.status = LOGGED_IN;
    this.username = data.username;
    this.fire('welcome', data);
    this.fire('status', this.status);
  });

  this.socket.on('me', data => {
    console.info(`I am currently ${data.away ? 'away' : 'not away'}`);
    this.away = data.away;
    this.fire('me', data);
  });

  this.socket.on('room', data => {
    console.info(`Joined room '${data.name}'`, data);
    this.room = new Room(data.name, data.users);
    this.fire('room', data);
    this.fire('users', this.room.users);
  });

  this.socket.on('user_join', data => {
    console.info(`User ${data.name} joined room`);
    this.room.users = this.room.users.concat([data]);
    this.fire('user_join', data);
    this.fire('users', this.room.users);
  });

  this.socket.on('user_part', data => {
    console.info(`User ${data.name} parted room`);
    this.room.users = this.room.users.filter((u) => u.name != data.name);
    this.fire('user_part', data);
    this.fire('users', this.room.users);
  });

  this.socket.on('user_status', data => {
    console.info(`Received user status for ${data.name}`, data);
    var user = _.find(this.room.users, (u) => u.name == data.name);
    _.assign(user, data);
    this.fire('user_status', data);
    this.fire('users', this.room.users);
  });

  this.socket.on('chat', data => this.fire('chat', data));

  this.socket.on('state', data => {
    console.debug("<< state", data);
    this.state = data;
    if (this.room !== null) {
      this.room.users.forEach((u) => {
        u.drawing = 'artists' in data && _.includes(data.artists, u.name);
        u.guessed = false;
      });
      this.fire('users', this.room.users);
    }
    this.fire('state', data);
  });

  this.socket.on('state_update', data => {
    console.debug("<< state_update", data);
    this.state = _.assign(this.state, data);
    this.fire('state_update', data);
  });

  this.socket.on('scores', data => {
    console.debug("<< scores", data);

    for (var i = 0; i < data.scores.length; i++) {
      var entry = data.scores[i];
      var user = _.find(this.room.users, (u) => u.name == entry.name);
      user.score = entry.score;
      if (entry.guessed) {
        user.guessed = true;
      }
    }

    this.fire('scores', data);
    this.fire('users', this.room.users);
  });

  this.socket.on('scores_reset', data => {
    console.debug("<< scores_reset", data);
    this.room.users.forEach(u => u.score = 0);
    this.fire('scores_reset', data);
  });

  this.socket.on('guess_correct', data => this.fire('guess_correct', data));

  this.socket.on('draw', data => {
    this.fire('draw', data);
  });
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

Transport.prototype.off = function(event, callback) {
  if (event in this.eventHandlers) {
    var index = this.eventHandlers[event].indexOf(callback);
    if (index >= 0) {
      this.eventHandlers[event].splice(index, 1);
    }
  }
};

Transport.prototype.fire = function(event, args) {
  if (event in this.eventHandlers) {
    _.forEach(this.eventHandlers[event], function (value) {
      value(args);
    });
  }
};

export var TransportMixin = {
  componentWillMount: function() {
    this.transportHandlers = [];
  },
  componentWillUnmount: function() {
    for (var i = 0; i < this.transportHandlers.length; i++) {
      var [event, callback] = this.transportHandlers[i];
      this.props.transport.off(event, callback);
    }
  },
  addTransportHandler: function(event, callback) {
    this.transportHandlers.push([event, callback]);
    this.props.transport.on(event, callback);
  }
};

export default Transport;